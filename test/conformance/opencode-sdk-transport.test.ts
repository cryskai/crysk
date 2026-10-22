import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type BenchmarkRunRecord,
  computeQualifiedBenchmarkMetrics,
  discriminateReviewCompletion,
  evaluateResumeOutcome,
} from "../../scripts/martian-judge";
import {
  classifyWitnessEvidence,
  type SessionWitness,
  sanitizeWitness,
  type WitnessClassification,
} from "../../scripts/opencode-prompt-probe";
import type {
  AsyncEventSink,
  ProviderEvent,
  ProviderTerminalProof,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  decideRetryDisposition,
  legacyClassificationFromCause,
  resolveFailureCause,
} from "../../src/execution/failure-policy";
import type {
  OpenCodeClientEvent,
  OpenCodeClientLike,
  OpenCodePollResult,
  OpenCodeTransportClock,
} from "../../src/transports/opencode-sdk";
import {
  formatPermissionRejectFailureDetail,
  OpenCodeSdkTransport,
} from "../../src/transports/opencode-sdk";

// §13 line 740: SDK conformance must distinguish a confirmed abort from
// unknown_may_continue without claiming remote cost ended, and §13 line 746
// requires backpressure, snapshot/delta usage, stream/poll races and content
// bounds to be tested. Every deadline below is fired by hand through
// ManualClock — no test sleeps a real deadline.

class ManualClock implements OpenCodeTransportClock {
  private pending: Array<{ fn: () => void }> = [];

  schedule(_ms: number, fn: () => void): () => void {
    const entry = { fn };
    this.pending.push(entry);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== entry);
    };
  }

  get size(): number {
    return this.pending.length;
  }

  fireNext(): void {
    const entry = this.pending.shift();
    entry?.fn();
  }

  fireAll(): void {
    const fns = this.pending.splice(0).map((entry) => entry.fn);
    for (const fn of fns) fn();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

async function advance(clock: ManualClock, passes: number): Promise<void> {
  await flush();
  for (let i = 0; i < passes; i += 1) {
    clock.fireAll();
    await flush();
  }
}

function makeRequest(
  overrides: Partial<TransportRequest> = {},
): TransportRequest {
  return {
    sessionId: "oc-sess-1",
    attempt: 1,
    route: {
      backend: "opencode",
      provider: "openai",
      modelFamily: "gpt",
      modelSnapshot: "gpt-test-snapshot",
    },
    executionModel: "gpt-test-snapshot",
    effort: "high",
    systemPromptPath: "/tmp/pr-hero-test/system.md",
    systemPromptSha256: "deadbeef",
    userPrompt: "review this",
    cwd: "/tmp/pr-hero-test",
    tools: ["Read"],
    isolation: {
      credentialProjectionId: "proj-1",
      env: {},
      syntheticHome: "/tmp/pr-hero-test/home",
      syntheticConfigHome: "/tmp/pr-hero-test/config",
      syntheticTmp: "/tmp/pr-hero-test/tmp",
      verifiedBinaryPath: "/usr/bin/true",
    },
    ...overrides,
  };
}

class RecordingSink implements AsyncEventSink {
  readonly events: ProviderEvent[] = [];
  blockDeltas = false;
  closed = false;

  async push(event: ProviderEvent): Promise<"accepted" | "closed"> {
    this.events.push(event);
    if (this.blockDeltas && event.type === "delta") {
      // Never settles — the shape of a sink whose consumer stopped draining.
      return new Promise<"accepted" | "closed">(() => {});
    }
    return this.closed ? "closed" : "accepted";
  }

  close(): void {
    this.closed = true;
  }

  terminals(): ProviderEvent[] {
    return this.events.filter((event) => event.type === "terminal");
  }
}

interface ClientHandle {
  client: OpenCodeClientLike;
  abortCount: () => number;
}

function makeClient(options: {
  stream?: AsyncIterable<OpenCodeClientEvent> | Error;
  polls?: Array<OpenCodePollResult>;
  hangRounds?: number[];
  createError?: Error;
  toolMap?: Readonly<Record<string, boolean>>;
}): ClientHandle {
  let aborts = 0;
  let round = 0;
  const client: OpenCodeClientLike = {
    createSession: async () => {
      if (options.createError) throw options.createError;
      return {
        id: "oc-sess-1",
        ...(options.toolMap !== undefined ? { toolMap: options.toolMap } : {}),
      };
    },
    async *streamEvents() {
      if (options.stream instanceof Error) throw options.stream;
      if (options.stream !== undefined) {
        yield* options.stream;
        return;
      }
      // No scripted stream: stay open forever, like a session mid-generation.
      await new Promise<never>(() => {});
    },
    pollStatus: async (_session, signal) => {
      const index = round;
      round += 1;
      if (options.hangRounds?.includes(index)) {
        return new Promise<OpenCodePollResult>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("poll aborted")),
            { once: true },
          );
        });
      }
      return options.polls?.[index] ?? ({ kind: "pending" } as const);
    },
    abort: async () => {
      aborts += 1;
    },
  };
  return { client, abortCount: () => aborts };
}

function streamOf(
  events: OpenCodeClientEvent[],
): AsyncIterable<OpenCodeClientEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

// A stream that keeps producing content for `count` microtask ticks (no
// clock timer involved) and then goes quiet forever — so #132's post-win
// drain window keeps re-arming (`deltaSinceArm` stays true) for long enough
// to give a scripted `polls` sequence room to deliver a SECOND terminal
// report (a "confirming" poll of an already-won proof) before settlement,
// and then closes cleanly (a real quiet stream, not a truncated one) once the
// deltas stop.
function delaysThenGoesQuiet(
  count: number,
): AsyncIterable<OpenCodeClientEvent> {
  return (async function* () {
    for (let i = 0; i < count; i += 1) {
      yield { kind: "delta", text: "" };
      await Promise.resolve();
    }
    await new Promise<never>(() => {});
  })();
}

const completedProof = (
  eventId: string,
  status = "completed",
): ProviderTerminalProof => ({
  eventId,
  providerStatus: status,
  providerObservedAt: "2026-08-26T00:00:00.000Z",
});

interface RigOptions {
  transport?: Partial<ConstructorParameters<typeof OpenCodeSdkTransport>[0]>;
  client: ReturnType<typeof makeClient>["client"];
}

function makeRig(options: RigOptions) {
  const clock = new ManualClock();
  const sink = new RecordingSink();
  const controller = new AbortController();
  const transport = new OpenCodeSdkTransport({
    client: options.client,
    clock,
    stallDeadlineMs: 50,
    abortConfirmMs: 500,
    cleanupMs: 100,
    maxDeltaBytes: 64 * 1024,
    maxFinalTextBytes: 1024 * 1024,
    pollIntervalMs: 10,
    pollRoundMs: 20,
    ...(options.transport ?? {}),
  });
  return { clock, sink, controller, transport };
}

describe("OpenCodeSdkTransport §197 terminal arbitration", () => {
  test("stream terminal wins the slot; matching poll confirms without a second terminal", async () => {
    const proof = completedProof("evt-stream-1");
    const handle = makeClient({
      stream: streamOf([
        { kind: "delta", text: "hello " },
        { kind: "terminal", proof },
      ]),
      polls: [{ kind: "terminal", proof }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    rig.clock.fireNext();
    await flush();
    rig.clock.fireAll();
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.terminalProof?.eventId).toBe("evt-stream-1");
    expect(outcome.finalText).toBe("hello ");
    expect(rig.sink.terminals()).toHaveLength(1);
    const terminal = rig.sink.terminals()[0];
    if (terminal.type !== "terminal") throw new Error("unreachable");
    expect(terminal.origin).toBe("provider");
    expect(terminal.integrity).toBe("verified");
    // #126: the confirmation TALLY is ours, so it rides diagnosticsTail; the
    // absence of a conflict marker is a witness fact and stays here.
    expect(outcome.diagnosticsTail).toContain("confirmed the winning terminal");
    expect(outcome.stderrTail).not.toContain("conflicting");
  });

  test("a late conflicting poll terminal flips the outcome malformed", async () => {
    const winner = completedProof("evt-a", "completed");
    const conflict = completedProof("evt-b", "failed");
    const handle = makeClient({
      stream: streamOf([
        { kind: "delta", text: "hi" },
        { kind: "terminal", proof: winner },
      ]),
      // Round 0 is taken immediately, before the first interval elapses, so
      // the LATE conflict this test is named for is round 1. Scripting the
      // conflict at round 0 would make it the winner and test the mirror case.
      polls: [{ kind: "pending" }, { kind: "terminal", proof: conflict }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    // The first queued timer is the poll tick — it lands BEFORE the drain
    // window expires, so the conflict is observed pre-settlement.
    rig.clock.fireNext();
    const outcome = await pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("malformed");
    // The FIRST valid proof stays attached as evidence; arrival order never
    // replaces it.
    expect(outcome.terminalProof?.eventId).toBe("evt-a");
    expect(outcome.stderrTail).toContain("conflicting provider terminal");
    expect(rig.transport.classifyFailure(outcome)).toBe("protocol_mismatch");
    expect(rig.sink.terminals()).toHaveLength(1);
    const terminal = rig.sink.terminals()[0];
    if (terminal.type !== "terminal") throw new Error("unreachable");
    expect(terminal.integrity).toBe("malformed");
  });

  test("EOF alone cannot win the slot; a later valid poll terminal does", async () => {
    const proof = completedProof("evt-poll-late");
    const handle = makeClient({
      stream: streamOf([{ kind: "delta", text: "abc" }]),
      polls: [
        { kind: "pending" },
        { kind: "pending" },
        { kind: "terminal", proof },
      ],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.terminalProof?.eventId).toBe("evt-poll-late");
    expect(outcome.stderrTail).toContain(
      "EOF is not a terminal proof and cannot win the slot",
    );
    expect(rig.sink.terminals()).toHaveLength(1);
  });

  test("a timed-out poll round cannot win the slot and is only counted", async () => {
    const proof = completedProof("evt-after-timeout");
    // Round 0 hangs past pollRoundMs; the terminal arrives on round 1. The
    // hung round still consumed its script slot, hence the placeholder.
    const handle = makeClient({
      polls: [{ kind: "pending" }, { kind: "terminal", proof }],
      hangRounds: [0],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.terminalProof?.eventId).toBe("evt-after-timeout");
    // #126: the tally lives on the diagnostics channel, never on the
    // classification witness — its own prose ("timed out") and its count both
    // match classifier patterns. Pinned in full by
    // test/conformance/opencode-diagnostic-witness.test.ts.
    expect(outcome.diagnosticsTail).toContain("poll round(s) timed out");
    expect(outcome.stderrTail).not.toContain("poll round(s) timed out");
  });

  test("an invalid terminal proof cannot win the slot; a valid one can", async () => {
    const invalid: ProviderTerminalProof = {
      eventId: "",
      providerStatus: "completed",
      providerObservedAt: "2026-08-26T00:00:00.000Z",
    };
    const proof = completedProof("evt-valid");
    const handle = makeClient({
      stream: streamOf([
        { kind: "delta", text: "x" },
        { kind: "terminal", proof: invalid },
      ]),
      polls: [{ kind: "terminal", proof }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.terminalProof?.eventId).toBe("evt-valid");
    // #126: both the per-occurrence note and the tally are our own words
    // about our own observation, so they ride diagnosticsTail.
    expect(outcome.diagnosticsTail).toContain("invalid terminal proof");
    expect(outcome.stderrTail).not.toContain("invalid terminal proof");
  });
});

describe("OpenCodeSdkTransport §5.2 line 272 / §5.3 line 290 abort semantics", () => {
  test("confirmed abort carries the provider proof and never claims unknown_may_continue", async () => {
    const proof = completedProof("evt-cancelled", "cancelled");
    const handle = makeClient({
      // Round 0 is taken immediately, before the abort is even requested; the
      // terminal has to arrive AFTER it for this to be a confirmed abort
      // rather than a turn that simply finished first.
      polls: [{ kind: "pending" }, { kind: "terminal", proof }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    rig.controller.abort();
    // Stepwise: fire only the pending poll tick so the provider terminal
    // lands INSIDE the confirmation window, ahead of the confirm deadline.
    rig.clock.fireNext();
    await flush();
    const outcome = await pending;

    expect(handle.abortCount()).toBe(1);
    expect(outcome.completion).toBe("cancelled");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.terminalProof?.eventId).toBe("evt-cancelled");
    expect(outcome.stderrTail).toContain("confirmed the abort");
    expect(outcome.stderrTail).not.toContain("unknown_may_continue");
    expect(rig.transport.classifyFailure(outcome)).toBeUndefined();
  });

  test("unconfirmed abort yields unverified integrity, no proof, remote_abort_unconfirmed", async () => {
    const handle = makeClient({});
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    rig.controller.abort();
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(handle.abortCount()).toBe(1);
    expect(outcome.completion).toBe("cancelled");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect("terminalProof" in outcome).toBe(false);
    expect(outcome.stderrTail).toContain("unknown_may_continue");
    expect(rig.transport.classifyFailure(outcome)).toBe(
      "remote_abort_unconfirmed",
    );
    // Exactly one transport-origin terminal, with no proof attached.
    expect(rig.sink.terminals()).toHaveLength(1);
    const terminal = rig.sink.terminals()[0];
    if (terminal.type !== "terminal") throw new Error("unreachable");
    expect(terminal.origin).toBe("transport");
    expect(terminal.proof).toBeUndefined();
    expect(terminal.status).toBe("cancelled");
    expect(terminal.integrity).toBe("unverified");
  });
});

describe("OpenCodeSdkTransport §4.2 line 195 usage aggregation mode", () => {
  test("first usage event fixes snapshot mode and later snapshots replace", async () => {
    const handle = makeClient({
      stream: streamOf([
        {
          kind: "usage",
          mode: "snapshot",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.1,
        },
        {
          kind: "usage",
          mode: "snapshot",
          inputTokens: 20,
          outputTokens: 8,
          costUsd: 0.2,
        },
        { kind: "delta", text: "text" },
        { kind: "terminal", proof: completedProof("evt-usage-snap") },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    // Stepwise advancement drives the whole lifecycle: poll ticks while the
    // slot is open, then the post-win drain window.
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.usage.tokens.inputUncached).toBe(20);
    expect(outcome.usage.tokens.outputVisible).toBe(8);
    expect(outcome.usage.tokens.totalKnown).toBe(28);
    expect(outcome.usage.cashCostUsd).toBeCloseTo(0.2);
    const usageEvents = rig.sink.events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(2);
  });

  test("cache and reasoning leaves join the snapshot totals and reach the sink usage event", async () => {
    const handle = makeClient({
      stream: streamOf([
        {
          kind: "usage",
          mode: "snapshot",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 900,
          cacheWriteTokens: 40,
          reasoningTokens: 7,
          costUsd: 0.1,
        },
        { kind: "delta", text: "text" },
        { kind: "terminal", proof: completedProof("evt-usage-cache") },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.usage.tokens.inputUncached).toBe(10);
    expect(outcome.usage.tokens.inputCacheRead).toBe(900);
    expect(outcome.usage.tokens.inputCacheWrite).toBe(40);
    expect(outcome.usage.tokens.outputVisible).toBe(5);
    expect(outcome.usage.tokens.outputReasoning).toBe(7);
    // OpenCode's token leaves are disjoint-additive (token-usage.ts), so the
    // totals are sums of the defined leaves, not the uncached counts alone.
    expect(outcome.usage.tokens.inputKnown).toBe(950);
    expect(outcome.usage.tokens.outputKnown).toBe(12);
    expect(outcome.usage.tokens.totalKnown).toBe(962);
    const usageEvent = rig.sink.events.find((e) => e.type === "usage");
    expect(usageEvent).toMatchObject({
      usage: { inputCacheRead: 900 },
    });
  });

  test("a poll-only terminal carries the cache and reasoning leaves too", async () => {
    // No usage event on the stream: the poll's reconciled message usage is
    // the only source, and it must not fall back to the uncached count.
    const proof = completedProof("evt-poll-cache");
    const handle = makeClient({
      stream: streamOf([{ kind: "delta", text: "text" }]),
      polls: [
        {
          kind: "terminal",
          proof,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 900,
            cacheWriteTokens: 40,
            reasoningTokens: 7,
            costUsd: 0.1,
          },
        },
      ],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.usage.tokens.inputCacheRead).toBe(900);
    expect(outcome.usage.tokens.inputCacheWrite).toBe(40);
    expect(outcome.usage.tokens.outputReasoning).toBe(7);
    expect(outcome.usage.tokens.inputKnown).toBe(950);
    expect(outcome.usage.tokens.outputKnown).toBe(12);
    expect(outcome.usage.tokens.totalKnown).toBe(962);
  });

  test("delta mode accumulates disjoint increments", async () => {
    const handle = makeClient({
      stream: streamOf([
        { kind: "usage", mode: "delta", inputTokens: 10, outputTokens: 2 },
        { kind: "usage", mode: "delta", inputTokens: 15, outputTokens: 3 },
        { kind: "delta", text: "t" },
        { kind: "terminal", proof: completedProof("evt-usage-delta") },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.usage.tokens.inputUncached).toBe(25);
    expect(outcome.usage.tokens.outputVisible).toBe(5);
    expect(outcome.usage.tokens.totalKnown).toBe(30);
  });

  test("a snapshot→delta flip after the mode was fixed makes the outcome malformed", async () => {
    const handle = makeClient({
      stream: streamOf([
        { kind: "usage", mode: "snapshot", inputTokens: 5, outputTokens: 1 },
        { kind: "usage", mode: "delta", inputTokens: 1 },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("malformed");
    expect(outcome.stderrTail).toContain("aggregation mode changed");
    expect(rig.transport.classifyFailure(outcome)).toBe("protocol_mismatch");
    expect(handle.abortCount()).toBe(1);
  });
});

describe("OpenCodeSdkTransport §4.2 line 191 hard content bounds", () => {
  test("an oversized delta terminates the attempt and is dropped whole", async () => {
    const handle = makeClient({
      stream: streamOf([{ kind: "delta", text: "x".repeat(17) }]),
    });
    const rig = makeRig({
      client: handle.client,
      transport: { maxDeltaBytes: 16 },
    });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("overflow");
    // The offending delta never entered finalText — nothing truncated was
    // parsed or delivered.
    expect(outcome.finalText).toBe("");
    expect(rig.transport.classifyFailure(outcome)).toBe(
      "output_limit_exceeded",
    );
    expect(handle.abortCount()).toBe(1);
    // The oversized delta was never pushed into the sink either.
    expect(rig.sink.events.filter((e) => e.type === "delta")).toHaveLength(0);
  });

  test("breaching the aggregate bound keeps the complete accepted prefix", async () => {
    const first = "aaaa";
    const second = "b".repeat(30);
    const handle = makeClient({
      stream: streamOf([
        { kind: "delta", text: first },
        { kind: "delta", text: second },
      ]),
    });
    const rig = makeRig({
      client: handle.client,
      transport: { maxFinalTextBytes: 32 },
    });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("overflow");
    expect(outcome.finalText).toBe(first);
    expect(rig.transport.classifyFailure(outcome)).toBe(
      "output_limit_exceeded",
    );
    const deltas = rig.sink.events.filter((e) => e.type === "delta");
    expect(deltas).toHaveLength(1);
  });
});

describe("OpenCodeSdkTransport §4.2 lines 188-189 backpressure", () => {
  test("a push stalled past the declared deadline aborts as protocol_overflow", async () => {
    const handle = makeClient({
      stream: streamOf([{ kind: "delta", text: "slow" }]),
    });
    const rig = makeRig({ client: handle.client });
    rig.sink.blockDeltas = true;
    // The push never settles, so only the injected stall deadline can end the
    // attempt — fire it by hand.
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    await advance(rig.clock, 3);
    const outcome = await pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("overflow");
    expect(outcome.stderrTail).toContain(
      "stalled past the declared stall deadline",
    );
    expect(rig.transport.classifyFailure(outcome)).toBe("protocol_overflow");
    // The producer awaited the stuck push instead of firing-and-forgetting:
    // exactly one delta ever reached the sink.
    expect(rig.sink.events.filter((e) => e.type === "delta")).toHaveLength(1);
    expect(handle.abortCount()).toBe(1);
  });
});

describe("OpenCodeSdkTransport capabilities honesty (§11/D1-09)", () => {
  test("degraded report claims only what this slice implements", async () => {
    const handle = makeClient({});
    const transport = new OpenCodeSdkTransport({ client: handle.client });
    const report = await transport.capabilities();

    expect(report.backend).toBe("opencode");
    expect(report.status).toBe("degraded");
    expect(report.auth.kind).toBe("opencode_chatgpt_oauth");
    expect(report.auth.projectionReady).toBe(true);
    expect(report.auth.probe).toBe("passed");
    expect(report.isolation.syntheticHome).toBe(true);
    expect(report.isolation.workspaceReadBroker).toBe(true);
    expect(report.protocol.terminalProof).toBe(true);
    expect(report.protocol.boundedEvents).toBe(true);
    expect(report.protocol.usageMode).toBe("none");
    expect(report.cancellation.deadlineMs).toBe(6500);
    expect(report.cancellation.conformance).toBe("passed");
    expect(report.billing.mode).toBe("subscription");
    // 2026-09-02: `true`, and this is not a weakened assertion — it asserted
    // the wrong disjunct. The design's metered rule is "provider cost OR a
    // versioned rate table", and this transport reports the FIRST: the SDK's
    // `AssistantMessage.cost` is non-optional and the client reads it on
    // every assistant message. The old `false` was reasoning about the rate
    // table (which this transport genuinely cannot consult, having no model
    // id in scope) and applying that conclusion to provider cost.
    expect(report.billing.pricingReady).toBe(true);
    expect(report.issues.length).toBeGreaterThan(0);
    // #197. `length > 0` could not see this list change, which is how the
    // deleted bundled-table entry slipped through: it said "no bundled
    // pricing table can be consulted here; ... the runtime binding prices per
    // route when a table is needed", and no table exists to consult or to
    // price from any more. A "missing table" issue standing beside
    // `pricingReady: true` also reads as a contradiction wherever doctor
    // renders it as a degraded row.
    //
    // Exactly ONE survives — the NOTIONAL one, a different fact from the cash
    // cost above — and the assertion names the count because two entries
    // sharing a code is precisely the shape that hid the stale one.
    const pricingIssues = report.issues.filter(
      (issue) => issue.code === "pricing_table_missing",
    );
    expect(pricingIssues).toHaveLength(1);
    expect(pricingIssues[0]?.message).toContain("notional cost");
    expect(pricingIssues[0]?.message).not.toContain("table");
    for (const issue of report.issues) expect(issue.blocking).toBe(false);
    expect(
      report.issues.some(
        (issue) => issue.code === "codegraph_policy_unenforced",
      ),
    ).toBe(true);
  });
});

// 2026-09-02. The usage records this transport emits used to hardcode
// `billingMode: "subscription"`, which #133 made false: an OpenCode route on
// any provider but `openai` runs on a `provider_api_token`, and that IS a
// metered credential. A usage record disagreeing with the capability report
// about how its own attempt bills is what lets the metered-zero rule in
// `settlementFromUsage` be dodged — the rule reads `usage.billingMode`, so a
// metered attempt wearing a subscription badge settles its $0 as truthful.
describe("OpenCodeSdkTransport usage records carry the route's billing mode", () => {
  test("a metered transport stamps its usage records metered", async () => {
    const handle = makeClient({
      stream: streamOf([
        {
          kind: "usage",
          mode: "snapshot",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
        },
        { kind: "terminal", proof: completedProof("evt-billing-metered") },
      ]),
    });
    const rig = makeRig({
      client: handle.client,
      transport: { billingMode: "metered" },
    });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.usage.billingMode).toBe("metered");
    expect(outcome.usage.cashCostUsd).toBe(0);
  });

  test("the default stays subscription, matching the factory's default route", async () => {
    const handle = makeClient({
      stream: streamOf([
        { kind: "usage", mode: "snapshot", inputTokens: 10, outputTokens: 5 },
        { kind: "terminal", proof: completedProof("evt-billing-default") },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.usage.billingMode).toBe("subscription");
  });

  test("a session that never reached the provider carries the same mode", async () => {
    // `noSessionUsage`: a truthful $0 with no tokens at all. It must carry
    // the route's real mode too — but it stays SETTLEABLE because the
    // metered-zero rule gates on output tokens, not on the mode alone.
    const handle = makeClient({
      createError: new Error("connect ECONNREFUSED"),
    });
    const rig = makeRig({
      client: handle.client,
      transport: { billingMode: "metered" },
    });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.usage.billingMode).toBe("metered");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outcome.usage.completeness).toBe("complete");
    expect(outcome.usage.tokens).toEqual({});
  });

  test("a free transport stamps its usage records free, incl. noSessionUsage", async () => {
    // #182 follow-up: the mode passes through generically — the factory
    // stamps "free" for the provider_free kind, and both the priced path and
    // the never-reached-provider path below carry it. `noSessionUsage` (cash
    // 0 + empty tokens) stays settleable under the free-nonzero rule, which
    // fires on cash > 0 alone.
    const handle = makeClient({
      stream: streamOf([
        {
          kind: "usage",
          mode: "snapshot",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
        },
        { kind: "terminal", proof: completedProof("evt-billing-free") },
      ]),
    });
    const rig = makeRig({
      client: handle.client,
      transport: { billingMode: "free" },
    });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.usage.billingMode).toBe("free");
    expect(outcome.usage.cashCostUsd).toBe(0);

    const refused = makeClient({
      createError: new Error("connect ECONNREFUSED"),
    });
    const refusedRig = makeRig({
      client: refused.client,
      transport: { billingMode: "free" },
    });
    const refusedOutcome = await refusedRig.transport.execute(makeRequest(), {
      signal: refusedRig.controller.signal,
      events: refusedRig.sink,
    });

    expect(refusedOutcome.usage.billingMode).toBe("free");
    expect(refusedOutcome.usage.cashCostUsd).toBe(0);
    expect(refusedOutcome.usage.completeness).toBe("complete");
    expect(refusedOutcome.usage.tokens).toEqual({});
  });
});

// D1-08 PR3 task 3.11 (§9.2): same optional bucket-scope input as the Claude
// CLI transport — omitted by every existing call site, so behavior stays
// byte-identical until PR5a's harness wiring supplies real credential scope.
describe("OpenCodeSdkTransport.capabilities bucket identity (D1-08 PR3)", () => {
  test("no bucket-scope argument leaves rateLimitBucketId undefined (regression pin)", async () => {
    const handle = makeClient({});
    const transport = new OpenCodeSdkTransport({ client: handle.client });
    const report = await transport.capabilities();
    expect(report.rateLimitBucketId).toBeUndefined();
  });

  test("a supplied bucket-scope input yields the same bucketId deriveBucketId would compute", async () => {
    const { deriveBucketId } = await import("../../src/execution/bucket-id");
    const handle = makeClient({});
    const transport = new OpenCodeSdkTransport({ client: handle.client });
    const localKey = Buffer.from("1".repeat(64), "hex");
    const report = await transport.capabilities({
      credentialFingerprint: "fp-opencode-1",
      bucketScope: { project: "proj-9" },
      localKey,
    });
    const expected = deriveBucketId(
      {
        provider: "openai",
        credentialFingerprint: "fp-opencode-1",
        scope: { project: "proj-9" },
      },
      localKey,
    );
    expect(report.rateLimitBucketId).toBe(expected);
  });
});

describe("OpenCodeSdkTransport failure surface", () => {
  test("session creation failure is failed/unverified and classifies auth text", async () => {
    const handle = makeClient({
      createError: new Error("OpenCode unauthorized: ChatGPT login required"),
    });
    const rig = makeRig({ client: handle.client });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(rig.transport.classifyFailure(outcome)).toBe("auth_invalid");
  });

  test("stream errors terminate unverified and classify transient network text", async () => {
    const handle = makeClient({
      stream: new Error("fetch failed: ECONNRESET"),
    });
    const rig = makeRig({ client: handle.client });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(rig.transport.classifyFailure(outcome)).toBe("network_transient");
  });

  test("classifyFailure returns undefined for an unmapped witness", () => {
    const handle = makeClient({});
    const transport = new OpenCodeSdkTransport({ client: handle.client });
    expect(
      transport.classifyFailure({
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: {
          wallMs: 0,
          tokens: {},
          completeness: "unavailable",
          billingMode: "unknown",
          costSource: "unknown",
        },
        stderrTail: "something entirely opaque happened",
      }),
    ).toBeUndefined();
  });
});

// #157: pr-157-8df2fca3-4's complete capture — OpenCode named this exact
// account limit ~3.8s into the attempt, retried internally, and delivered no
// reasoning/text/usage for the rest of it. The old code read `session.status`
// retry only for its `next` backoff hint and mapped it to nothing else, so
// the attempt sat quiet for the whole usefulProgressMs budget before the
// silence tripwire settled it $0/transient at 150s — the user saw "silence",
// never the account limit the provider had already named.
describe("OpenCodeSdkTransport provider account/usage limit (#157)", () => {
  const LIMIT_MESSAGE =
    "5 hour usage limit reached. It will reset in 22 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_01M17B67W4Q9BE4T0910EQ0NRY/go";

  test("a stream-observed account limit fails fast, well before usefulProgressMs", async () => {
    const handle = makeClient({
      stream: streamOf([
        {
          kind: "provider_limit",
          reason: "account_rate_limit",
          message: LIMIT_MESSAGE,
        },
      ]),
    });
    // Real production budget from the run this pins; never advanced below —
    // the whole point is that settlement does not wait on it at all.
    const rig = makeRig({
      client: handle.client,
      transport: { usefulProgressMs: 150_000 },
    });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain(
      "provider usage limit reached (account_rate_limit)",
    );
    expect(outcome.stderrTail).toContain(LIMIT_MESSAGE);
    // The workspace URL is not a secret and must survive whatever redaction
    // this witness line goes through downstream.
    expect(outcome.stderrTail).toContain("https://opencode.ai/workspace/");
    expect(rig.transport.classifyFailure(outcome)).toBe("quota_exhausted");
    expect(rig.transport.classifyFailure(outcome)).not.toBe(
      "protocol_truncation",
    );
    // The provider is told to stop its own internal retry loop — the same
    // best-effort abort every other stream_error/session_failed reason gets.
    expect(handle.abortCount()).toBe(1);
  });

  test("a poll-observed account limit (via a failed poll result) classifies the same", async () => {
    const handle = makeClient({
      polls: [
        {
          kind: "failed",
          detail: `[pr-hero] opencode sdk: provider usage limit reached (account_rate_limit): ${LIMIT_MESSAGE}`,
        },
      ],
    });
    const rig = makeRig({
      client: handle.client,
      transport: { usefulProgressMs: 150_000 },
    });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    const outcome = await pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.stderrTail).toContain(LIMIT_MESSAGE);
    expect(rig.transport.classifyFailure(outcome)).toBe("quota_exhausted");
    expect(handle.abortCount()).toBe(1);
  });
});

// #213: the provider refused the turn (APIError 403, isRetryable false) on
// the event stream. The old mapper dropped that event, the turn completed
// with empty finalText, and resolveFailureCause filed format_violation
// because parse threw — burning the format-reminder retry on a model that
// never ran.
describe("OpenCodeSdkTransport provider refusal (#213)", () => {
  const DATA_POLICY =
    "This model collects data used to improve its quality and requires explicit opt in: https://opencode.ai/workspace/wrk_example sk-secretkeyvalue";

  test("a non-retryable 403 fails unverified as runtime_unavailable, not a format retry", async () => {
    const handle = makeClient({
      stream: streamOf([
        {
          kind: "provider_refusal",
          name: "APIError",
          statusCode: 403,
          retryable: false,
          message: DATA_POLICY,
        },
      ]),
    });
    const rig = makeRig({
      client: handle.client,
      transport: { usefulProgressMs: 150_000 },
    });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain("APIError");
    expect(outcome.stderrTail).toContain("status=403");
    expect(outcome.stderrTail).toContain("retryable=no");
    expect(outcome.stderrTail).toContain("https://opencode.ai/workspace/");
    expect(outcome.stderrTail).toContain("[REDACTED]");
    expect(outcome.stderrTail).not.toContain("sk-secretkeyvalue");
    expect(rig.transport.classifyFailure(outcome)).toBe("runtime_unavailable");
    expect(
      resolveFailureCause({
        outcome,
        classifyFailure: (candidate) =>
          rig.transport.classifyFailure(candidate),
        parseThrew: true,
      }),
    ).toEqual({ kind: "cause", cause: "runtime_unavailable" });
    expect(
      decideRetryDisposition("runtime_unavailable", {
        transientAttemptsUsed: 0,
        formatRetriesUsed: 0,
      }),
    ).toEqual({ action: "terminal" });
    expect(
      legacyClassificationFromCause({
        kind: "cause",
        cause: "runtime_unavailable",
      }),
    ).toBe("terminal");
    expect(handle.abortCount()).toBe(1);
  });

  test("a message that says isRetryable: true does not override retryable=no", async () => {
    const handle = makeClient({
      stream: streamOf([
        {
          kind: "provider_refusal",
          name: "APIError",
          statusCode: 403,
          retryable: false,
          message:
            "the prose isRetryable: true must not steer a terminal refusal",
        },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.stderrTail).toContain("retryable=no");
    expect(outcome.stderrTail).toContain("isRetryable: true");
    expect(rig.transport.classifyFailure(outcome)).toBe("runtime_unavailable");
  });

  test("isRetryable true is a transient retry, not a format reminder", async () => {
    const handle = makeClient({
      stream: streamOf([
        {
          kind: "provider_refusal",
          name: "APIError",
          statusCode: 408,
          retryable: true,
          message: "provider asked for another attempt",
        },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(rig.transport.classifyFailure(outcome)).toBe("network_transient");
    expect(
      decideRetryDisposition("network_transient", {
        transientAttemptsUsed: 0,
        formatRetriesUsed: 0,
      }),
    ).toEqual({ action: "retry_now", budget: "transient" });
  });
});

// #157: opencode-client.ts settles a failed permission-reject the same way
// as a failed session poll — a `{kind:"failed"}` OpenCodePollResult, so this
// pins the classification the client-level tests in opencode-client.test.ts
// cannot reach (they only observe `state.failure`'s message, never what
// classifyFailure does with it).
describe("OpenCodeSdkTransport permission-reject failure classification (#157)", () => {
  test("a failed permission reject classifies runtime_unavailable, never protocol_truncation", async () => {
    const detail = formatPermissionRejectFailureDetail(
      "external_directory",
      ["/blocked"],
      "permission service down",
    );
    const handle = makeClient({
      polls: [{ kind: "failed", detail }],
    });
    const rig = makeRig({
      client: handle.client,
      transport: { usefulProgressMs: 150_000 },
    });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    const outcome = await pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.stderrTail).toContain("permission service down");
    expect(rig.transport.classifyFailure(outcome)).toBe("runtime_unavailable");
    expect(rig.transport.classifyFailure(outcome)).not.toBe(
      "protocol_truncation",
    );
    expect(handle.abortCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pr-hero findings on PR #74 (head 76cd96c2). All five were confirmed against
// the repository before any code moved; these tests pin the fixes.
// ---------------------------------------------------------------------------

describe("OpenCodeSdkTransport per-attempt deadline ownership (F006)", () => {
  // Per-attempt watchdog is harness-owned (StepSpec.timeoutMs → harness
  // watchdog). TransportRequest carries no timeoutMs — see
  // test/production-transport-lifecycle.test.ts and
  // docs/multi-runtime-model-diversity-design.md §3.

  test("a hung provider settles when the harness abort signal fires", async () => {
    const handle = makeClient({});
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    rig.controller.abort();
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("cancelled");
    expect(outcome.timedOut).toBeUndefined();
  });

  test("abort without provider proof is classified remote_abort_unconfirmed", async () => {
    const handle = makeClient({});
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    rig.controller.abort();
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("cancelled");
    expect(rig.transport.classifyFailure(outcome)).toBe(
      "remote_abort_unconfirmed",
    );
    expect(handle.abortCount()).toBe(1);
  });

  test("no transport-internal attempt deadline is armed", async () => {
    const handle = makeClient({
      stream: streamOf([{ kind: "terminal", proof: completedProof("e1") }]),
      polls: [{ kind: "terminal", proof: completedProof("e1") }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;
    expect(outcome.completion).toBe("success");
    expect(outcome.timedOut).toBeUndefined();
  });
});

describe("OpenCodeSdkTransport stream teardown (F005)", () => {
  // execute() awaits `done`, not the watchers (opencode-sdk.ts:631-633). The
  // poll watcher self-terminates because it wakes on its own delay() and
  // re-checks `settled`; the stream watcher has no timer of its own — it is
  // parked on next(), and its `if (settled) return` only runs when an event
  // arrives. When settlement comes from the poll watcher or the timeout, a
  // provider that then goes quiet leaves that subscription open forever.
  test("the stream iterator is closed when settlement comes from elsewhere", async () => {
    let returned = false;
    let opened = false;
    const client: OpenCodeClientLike = {
      createSession: async () => ({ id: "oc-sess-1" }),
      streamEvents: () =>
        ({
          [Symbol.asyncIterator]() {
            opened = true;
            return {
              // Parked forever: the provider went quiet after settlement.
              next: () => new Promise<never>(() => {}),
              return: async () => {
                returned = true;
                return { done: true as const, value: undefined };
              },
            };
          },
        }) as AsyncIterable<OpenCodeClientEvent>,
      pollStatus: async () => ({
        kind: "terminal" as const,
        proof: completedProof("e-poll"),
      }),
      abort: async () => {},
    };
    const rig = makeRig({ client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(opened).toBe(true);
    expect(outcome.completion).toBe("success");
    await flush();
    expect(returned).toBe(true);
  });
});

describe("OpenCodeSdkTransport declared capabilities (F001)", () => {
  // harness.ts:425 reads report.cancellation.deadlineMs and TRUSTS it as the
  // real bound before treating a cancellation as unconfirmed. Declaring a
  // fixed module constant while abortConfirmMs/cleanupMs are constructor
  // options means an instance can be configured to need longer than it
  // promises, and the harness would give up early on a transport that was
  // still within its own budget.
  test("the declared deadline follows the instance's actual budgets", async () => {
    const handle = makeClient({});
    const rig = makeRig({
      client: handle.client,
      transport: { abortConfirmMs: 500, cleanupMs: 100 },
    });
    const report = await rig.transport.capabilities();
    expect(report.cancellation.deadlineMs).toBe(1100);

    const slow = makeRig({
      client: handle.client,
      transport: { abortConfirmMs: 20_000, cleanupMs: 3_000 },
    });
    expect((await slow.transport.capabilities()).cancellation.deadlineMs).toBe(
      23_500,
    );
  });

  test("the production defaults still declare the §5.2 SDK row's 6,500 ms", async () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}).client,
    });
    expect((await transport.capabilities()).cancellation.deadlineMs).toBe(6500);
  });
});

describe("OpenCodeSdkTransport stderrTail byte bound (F002)", () => {
  // MAX_STDERR_TAIL_BYTES is declared and documented as a BYTE bound, and the
  // file's own utf8Bytes() helper is used correctly for the delta and
  // aggregate bounds. String.slice counts UTF-16 code units, so multi-byte
  // provider text sails past the bound the transport claims to enforce.
  test("a multi-byte tail is bounded in bytes, not code units", async () => {
    // Each stream error detail is multi-byte; enough of them to blow a
    // code-unit-based trim well past 64 KiB of actual bytes.
    const detail = "→".repeat(40_000);
    const handle = makeClient({ stream: new Error(detail) });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(
      new TextEncoder().encode(outcome.stderrTail).length,
    ).toBeLessThanOrEqual(64 * 1024);
    // Still a usable tail, not an empty string.
    expect(outcome.stderrTail.length).toBeGreaterThan(0);
  });
});

describe("OpenCodeSdkTransport classification witness (F003)", () => {
  // finalText is model-generated REVIEW PROSE, and pr-hero reviews code for
  // exactly these failure modes — "no rate limit on this endpoint",
  // "unauthorized access is possible". Matching generic patterns against it
  // makes the tool's own subject-matter vocabulary look like provider
  // diagnostics. Every violation this transport detects is stamped into
  // `notes` → stderrTail (opencode-sdk.ts:664-672), so stderrTail is the
  // complete diagnostics channel and finalText has no business in the
  // witness at all.
  test("review prose about auth and rate limits is not a transport failure", () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}).client,
    });
    const prose = [
      "The handler allows unauthorized access when the token is absent.",
      "There is no rate limit on this endpoint, so quota exceeded errors are likely.",
      "Please log in is rendered even after a successful network error retry.",
    ].join("\n");
    expect(
      transport.classifyFailure({
        completion: "failed",
        protocolIntegrity: "verified",
        finalText: prose,
        usage: {
          wallMs: 1,
          tokens: { inputUncached: 1 },
          completeness: "complete" as const,
          billingMode: "subscription" as const,
          costSource: "provider" as const,
          cashCostUsd: 0,
        },
        stderrTail: "",
      }),
    ).toBeUndefined();
  });

  test("the same words in the provider's own stderr still classify", () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}).client,
    });
    const base = {
      completion: "failed" as const,
      protocolIntegrity: "verified" as const,
      finalText: "",
      usage: {
        wallMs: 1,
        tokens: { inputUncached: 1 },
        completeness: "complete" as const,
        billingMode: "subscription" as const,
        costSource: "provider" as const,
        cashCostUsd: 0,
      },
    };
    expect(
      transport.classifyFailure({ ...base, stderrTail: "401 unauthorized" }),
    ).toBe("auth_invalid");
    expect(
      transport.classifyFailure({ ...base, stderrTail: "rate limit exceeded" }),
    ).toBe("rate_limit");
    expect(
      transport.classifyFailure({ ...base, stderrTail: "socket hang up" }),
    ).toBe("network_transient");
  });

  // Issue #121, part D. When `sdk.createClient is not a function` killed every
  // live step, the outcome carried no mapped witness, so the harness fell
  // through to the legacy classifier and called a TypeError inside our own
  // transport a FORMAT violation — spending the format-reminder budget on an
  // attempt the model never saw, and filing an infrastructure failure in the
  // bucket reserved for model misbehaviour. A session that could not be
  // created is the runtime being unavailable, which §7 makes terminal.
  describe("a session that could not be created", () => {
    const base = {
      completion: "failed" as const,
      protocolIntegrity: "unverified" as const,
      finalText: "",
      usage: {
        wallMs: 1,
        tokens: { inputUncached: 1 },
        completeness: "complete" as const,
        billingMode: "subscription" as const,
        costSource: "provider" as const,
        cashCostUsd: 0,
      },
    };

    test("classifies as runtime_unavailable, not a format violation", () => {
      const transport = new OpenCodeSdkTransport({
        client: makeClient({}).client,
      });
      const outcome = {
        ...base,
        stderrTail:
          "[pr-hero] opencode sdk: session creation failed: sdk.createClient is not a function.",
      };

      expect(transport.classifyFailure(outcome)).toBe("runtime_unavailable");

      // What the harness actually does with it: a terminal ruling, and no
      // format retry spent.
      const resolution = resolveFailureCause({
        outcome,
        classifyFailure: (o) => transport.classifyFailure(o),
        parseThrew: true,
      });
      expect(resolution).toEqual({
        kind: "cause",
        cause: "runtime_unavailable",
      });
      expect(legacyClassificationFromCause(resolution)).toBe("terminal");
      expect(
        decideRetryDisposition("runtime_unavailable", {
          transientAttemptsUsed: 0,
          formatRetriesUsed: 0,
        }),
      ).toEqual({ action: "terminal" });
    });

    // ORDERING, not decoration. A creation failure whose text is a refused
    // connection is a transient network failure and keeps its retry; the
    // creation witness is the LAST resort, so it can never shadow the
    // auth/rate-limit/network patterns above it and silently delete a retry
    // path.
    test("still yields to the network witness inside its own message", () => {
      const transport = new OpenCodeSdkTransport({
        client: makeClient({}).client,
      });
      expect(
        transport.classifyFailure({
          ...base,
          stderrTail:
            "[pr-hero] opencode sdk: session creation failed: fetch failed",
        }),
      ).toBe("network_transient");
      expect(
        transport.classifyFailure({
          ...base,
          stderrTail:
            "[pr-hero] opencode sdk: session creation failed: 401 unauthorized",
        }),
      ).toBe("auth_invalid");
    });
  });
});

// Issue #122. Nothing in the artifacts recorded the tool allow map that was
// actually sent, so the only evidence the map was inert came from reading a
// hunter narrate tool use it never performed. #116's ledger requires the
// tools/MCP axis be provable by READING artifacts, and `allowMapEnforced:
// true` in the capability report is a hardcoded constant, not an observation.
describe("OpenCodeSdkTransport resolved tool map diagnostics (#122)", () => {
  const TOOL_MAP = {
    read: true,
    grep: true,
    glob: true,
    bash: false,
    write: false,
    edit: false,
  };

  test("stamps the resolved map into diagnosticsTail, once, with sorted keys", async () => {
    const handle = makeClient({
      toolMap: TOOL_MAP,
      stream: streamOf([{ kind: "terminal", proof: completedProof("evt-1") }]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    const line =
      "[pr-hero] opencode sdk: resolved tool map: " +
      "bash=false,edit=false,glob=true,grep=true,read=true,write=false";
    // #126: the line moved off the classification witness. It says what WE
    // resolved, in a provider-supplied id vocabulary we do not control.
    expect(outcome.diagnosticsTail).toContain(line);
    expect((outcome.diagnosticsTail ?? "").split(line)).toHaveLength(2);
    expect(outcome.stderrTail).not.toContain("resolved tool map");
  });

  // #122 asked whether OpenCode's ids could read as provider diagnostics —
  // "invalid" against `invalid api key`, an id that looks like a rate limit or
  // a socket error. #126 answers it structurally instead of by vocabulary
  // audit: the line rides diagnosticsTail, which classifyFailure never reads,
  // so no id can classify an attempt no matter how the surface grows. The
  // hostile map below would have matched on the old channel.
  test("the map line never becomes a failure classification by itself", () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}).client,
    });

    expect(
      transport.classifyFailure({
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: {
          wallMs: 1,
          tokens: { inputUncached: 1 },
          completeness: "complete",
          billingMode: "subscription",
          costSource: "provider",
          cashCostUsd: 0,
        },
        stderrTail: "",
        diagnosticsTail:
          "[pr-hero] opencode sdk: resolved tool map: " +
          "apply_patch=false,bash=false,edit=false,glob=true,grep=true," +
          "invalid=false,question=false,read=true,skill=false,task=false," +
          "todowrite=false,webfetch=false,websearch=false,write=false," +
          "unauthorized=false,rate_limit_429=false,econnreset=false",
      }),
    ).toBeUndefined();
  });

  test("a client that reports no map adds no line", async () => {
    const handle = makeClient({
      stream: streamOf([{ kind: "terminal", proof: completedProof("evt-1") }]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.diagnosticsTail).not.toContain("resolved tool map");
    expect(outcome.stderrTail).not.toContain("resolved tool map");
  });
});

// ---------------------------------------------------------------------------
// Unit 1: OA1a actual /v2 wire format & OA1b bounded version admission policy
// ---------------------------------------------------------------------------

function makeV2MockFetch() {
  let requestedUrl = "";
  let requestMethod = "";
  let requestBody: Record<string, unknown> = {};
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : input.url;
    const parsedPath = new URL(urlStr, "http://127.0.0.1:4096").pathname;
    const method =
      (typeof init?.method === "string" ? init.method : undefined) ??
      (typeof input === "object" && input !== null && "method" in input
        ? (input as Request).method
        : "GET");
    if (parsedPath === "/session" && method.toUpperCase() === "POST") {
      const text = typeof init?.body === "string" ? init.body : "{}";
      let dir = "/workspace/adapter-cwd";
      try {
        const body = JSON.parse(text);
        if (body.directory) dir = body.directory;
      } catch {}
      return new Response(
        JSON.stringify({ id: "ses-adapter-1", directory: dir }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (urlStr.includes("/mcp") || urlStr.includes("/tool/ids")) {
      const data = urlStr.includes("/tool/ids") ? ["read", "bash"] : {};
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    requestedUrl = urlStr;
    requestMethod =
      init?.method ??
      (typeof input === "object" && input !== null && "method" in input
        ? (input as Request).method
        : "GET");
    const text =
      typeof init?.body === "string"
        ? init.body
        : typeof input === "object" &&
            input !== null &&
            "text" in input &&
            typeof (input as Request).text === "function"
          ? await (input as Request).text()
          : "{}";
    requestBody = JSON.parse(text) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "msg-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    getUrl: () => requestedUrl,
    getMethod: () => requestMethod,
    getBody: () => requestBody,
  };
}

describe("OpenCode SDK /v2 session wire conformance (OA1a)", () => {
  test("submitting session, directory, model and variant through @opencode-ai/sdk/v2 results in /session/:sessionID/message?directory=... with top-level variant and model", async () => {
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    const mock = makeV2MockFetch();
    const actualClient = createOpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetch: mock.fetch,
    });

    await actualClient.session.prompt({
      sessionID: "ses-u1-42",
      directory: "/workspace/project-root",
      model: { providerID: "openai", modelID: "gpt-4o" },
      variant: "high",
      system: "system prompt here",
      tools: { read: true, bash: false },
      parts: [{ type: "text", text: "hello review" }],
    });

    const parsed = new URL(mock.getUrl());
    expect(parsed.pathname).toBe("/session/ses-u1-42/message");
    expect(parsed.pathname).not.toContain("/api");
    expect(parsed.searchParams.get("directory")).toBe(
      "/workspace/project-root",
    );
    expect(mock.getMethod()).toBe("POST");
    expect(mock.getBody().model).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
    });
    expect(mock.getBody().variant).toBe("high");
    expect(
      (mock.getBody().model as Record<string, unknown> | undefined)?.variant,
    ).toBeUndefined();
    expect(mock.getBody().system).toBe("system prompt here");
  });

  test("createOpenCodeClient submits sessionID, directory, model and variant with flattened parameters and top-level variant", async () => {
    const { createOpenCodeClient } = await import(
      "../../src/transports/opencode-client"
    );
    const sdkModule = await import("@opencode-ai/sdk/v2");
    const mock = makeV2MockFetch();

    const client = createOpenCodeClient({
      model: { providerID: "openai", modelID: "gpt-4o", variant: "high" },
      variant: "high",
      loadSdk: async () => ({
        createOpencodeClient: (cfg) =>
          sdkModule.createOpencodeClient({
            ...cfg,
            fetch: mock.fetch,
          }) as never,
      }),
      launchServer: async () => ({
        url: "http://127.0.0.1:4096",
        pid: 12345,
        close: async () => {},
      }),
      readSystemPrompt: async () => "SYSTEM PROMPT",
    });

    const session = await client.createSession({
      cwd: "/workspace/adapter-cwd",
      systemPromptPath: "/tmp/sys.md",
      tools: ["Read"],
      userPrompt: "run review",
    });

    expect(session.id).toBe("ses-adapter-1");
    for (let i = 0; i < 20 && !mock.getUrl(); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const parsed = new URL(mock.getUrl());
    expect(parsed.pathname).toBe("/session/ses-adapter-1/message");
    expect(parsed.pathname).not.toContain("/api");
    expect(parsed.searchParams.get("directory")).toBe("/workspace/adapter-cwd");
    expect(mock.getBody().model).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
    });
    expect(mock.getBody().variant).toBe("high");
    expect(
      (mock.getBody().model as Record<string, unknown> | undefined)?.variant,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bun HTTP idle-timeout override on the blocking prompt POST
// ---------------------------------------------------------------------------
//
// The recording fetch below is passed as the transport's OWN `options.fetch`
// (not as a `cfg.fetch` override inside `loadSdk`, the pattern every other
// test in this file uses). That distinction matters: `loadSdk`'s
// `createOpencodeClient` here returns the REAL, unmodified
// `sdkModule.createOpencodeClient(cfg)`, so `evidence.wrapFetch(...)` and the
// inner `(options.fetch ?? globalThis.fetch)(request)` callback under test
// actually run. A `loadSdk` that substitutes its own `fetch` into `cfg`
// bypasses that inner callback entirely and would prove nothing about it.
describe("OpenCode prompt POST Bun idle-timeout override", () => {
  test("the blocking prompt POST disables Bun's idle timeout while every other request keeps the default call shape", async () => {
    const { createOpenCodeClient } = await import(
      "../../src/transports/opencode-client"
    );
    const sdkModule = await import("@opencode-ai/sdk/v2");

    const calls: Array<{
      method: string;
      pathname: string;
      init: RequestInit | undefined;
    }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // The inner callback under test always hands this fetch a `Request`
      // instance (the SDK builds one and calls `_fetch(request)` single-arg),
      // so `input` is never a bare string/URL here.
      const request =
        input instanceof Request ? input : new Request(input, init);
      const pathname = new URL(request.url).pathname;
      calls.push({ method: request.method, pathname, init });
      if (pathname === "/event") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"server.connected","properties":{}}\n\n',
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (pathname === "/session" && request.method === "POST") {
        return new Response(
          JSON.stringify({ id: "ses-idle-1", directory: "/workspace/idle" }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (pathname === "/experimental/tool/ids") {
        return new Response(JSON.stringify(["read"]), {
          headers: { "content-type": "application/json" },
        });
      }
      // /mcp status and the prompt POST both fall through to this shared
      // empty-object reply; the prompt POST is distinguished below by path.
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = createOpenCodeClient({
      model: { providerID: "openai", modelID: "gpt-4o" },
      loadSdk: async () => ({
        createOpencodeClient: (config) =>
          sdkModule.createOpencodeClient(config),
      }),
      fetch: fetchImpl,
      readSystemPrompt: async () => "SYSTEM PROMPT",
      launchServer: async () => ({
        url: "http://127.0.0.1:4096",
        pid: 1,
        close: async () => {},
      }),
    });

    await client.createSession({
      cwd: "/workspace/idle",
      systemPromptPath: "/tmp/sys.md",
      tools: ["Read"],
      userPrompt: "run review",
    });

    const findPromptCall = () =>
      calls.find(
        (call) =>
          call.method === "POST" &&
          call.pathname === "/session/ses-idle-1/message",
      );
    for (let i = 0; i < 50 && findPromptCall() === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const promptCall = findPromptCall();
    expect(promptCall).toBeDefined();
    // A: the blocking prompt POST must carry the Bun idle-timeout override.
    expect(
      (promptCall?.init as { timeout?: unknown } | undefined)?.timeout,
    ).toBe(false);

    // B: every OTHER recorded request keeps today's exact call shape — no
    // second argument at all. Pinned to at least the two calls the parent
    // named explicitly, so a future fixture change that stops driving either
    // cannot silently turn this loop into a no-op over zero calls.
    const otherCalls = calls.filter((call) => call !== promptCall);
    expect(
      otherCalls.some(
        (call) => call.method === "GET" && call.pathname === "/event",
      ),
    ).toBe(true);
    expect(
      otherCalls.some(
        (call) => call.method === "POST" && call.pathname === "/session",
      ),
    ).toBe(true);
    for (const call of otherCalls) {
      expect(call.init).toBeUndefined();
    }
  });
});

describe("isBlockingPromptRequest (pure predicate)", () => {
  test.each([
    [
      "POST /session/ses_1/message matches the blocking prompt POST",
      "POST",
      "http://127.0.0.1:4096/session/ses_1/message",
      true,
    ],
    [
      "GET /session/ses_1/message is the poll readback, not the prompt POST",
      "GET",
      "http://127.0.0.1:4096/session/ses_1/message",
      false,
    ],
    [
      "POST /session/ses_1/message/msg_1 is the single-message endpoint (an extra path segment), not the prompt POST",
      "POST",
      "http://127.0.0.1:4096/session/ses_1/message/msg_1",
      false,
    ],
    [
      "POST /session/ses_1/prompt_async is the async variant, not this one",
      "POST",
      "http://127.0.0.1:4096/session/ses_1/prompt_async",
      false,
    ],
    [
      "POST /session is session.create, not the message endpoint",
      "POST",
      "http://127.0.0.1:4096/session",
      false,
    ],
    [
      "POST /session/ses_1/message?directory=/x still matches: only pathname is checked",
      "POST",
      "http://127.0.0.1:4096/session/ses_1/message?directory=/x",
      true,
    ],
  ])("%s", async (_label, method, url, expected) => {
    const { isBlockingPromptRequest } = await import(
      "../../src/transports/opencode-client"
    );
    expect(isBlockingPromptRequest(new Request(url, { method }))).toBe(
      expected,
    );
  });
});

describe("OpenCode bounded version admission policy (OA1b)", () => {
  test("admits exact SDK 1.18.25 and server 1.18.30 pair", async () => {
    const {
      admitOpenCodeVersionPair,
      SUPPORTED_OPENCODE_SDK_VERSION,
      SUPPORTED_OPENCODE_SERVER_VERSION,
    } = await import("../../src/transport-registry");
    const admitted = admitOpenCodeVersionPair({
      sdkVersion: "1.18.25",
      serverVersion: "1.18.30",
    });
    expect(admitted).toEqual({
      sdkVersion: "1.18.25",
      serverVersion: "1.18.30",
    });
    expect(SUPPORTED_OPENCODE_SDK_VERSION).toBe("1.18.25");
    expect(SUPPORTED_OPENCODE_SERVER_VERSION).toBe("1.18.30");
  });

  test("rejects unsupported, malformed, or missing versions explicitly without auto-upgrade", async () => {
    const { admitOpenCodeVersionPair, OpenCodeVersionAdmissionError } =
      await import("../../src/transport-registry");
    const unsupp = /Unsupported OpenCode version pair/;
    const miss = /malformed or missing/;
    const rejectedCases: ReadonlyArray<
      [
        string | undefined,
        string | undefined,
        RegExp | typeof OpenCodeVersionAdmissionError,
      ]
    > = [
      ["1.18.23", "1.18.30", OpenCodeVersionAdmissionError],
      ["1.18.26", "1.18.30", unsupp],
      ["1.18.25", "1.18.23", OpenCodeVersionAdmissionError],
      ["1.18.25", "1.18.31", unsupp],
      ["1.18", "1.18.30", unsupp],
      ["^1.18.25", "1.18.30", unsupp],
      ["1.18.25", "latest", unsupp],
      ["", "1.18.30", miss],
      [undefined, "1.18.30", miss],
      ["1.18.25", undefined, miss],
    ];
    for (const [sdk, server, err] of rejectedCases) {
      expect(() =>
        admitOpenCodeVersionPair({ sdkVersion: sdk, serverVersion: server }),
      ).toThrow(err as unknown as RegExp);
    }
  });

  test("missing version pair is DENIED (not admitted) when registering opencode transport", async () => {
    const { DefaultTransportRegistry, OpenCodeVersionAdmissionError } =
      await import("../../src/transport-registry");
    const registry = new DefaultTransportRegistry({
      mode: "conformance",
      sdkVersion: "" as never,
      serverVersion: "" as never,
    });
    expect(() =>
      registry.get("opencode", {
        openCodeClient: {} as never,
      }),
    ).toThrow(OpenCodeVersionAdmissionError);

    expect(() =>
      registry.get("opencode", {
        openCodeClient: {} as never,
        sdkVersion: "1.18.25",
        serverVersion: "" as never,
      }),
    ).toThrow(OpenCodeVersionAdmissionError);

    expect(() =>
      registry.get("opencode", {
        openCodeClient: {} as never,
        sdkVersion: "" as never,
        serverVersion: "1.18.30",
      }),
    ).toThrow(OpenCodeVersionAdmissionError);
  });

  test("loadOpenCodeSdk rejects a missing SDK as unavailable and a real mismatch as a version error", async () => {
    const {
      loadOpenCodeSdk,
      OpenCodeVersionAdmissionError,
      SUPPORTED_OPENCODE_SDK_VERSION,
    } = await import("../../src/transport-registry");
    const { OpenCodeSdkUnavailableError, openCodeSdkUnavailableMessage } =
      await import("../../src/transports/opencode-admission");
    const unavailable = openCodeSdkUnavailableMessage();
    expect(unavailable).toContain(
      `@opencode-ai/sdk@${SUPPORTED_OPENCODE_SDK_VERSION}`,
    );
    expect(unavailable).toContain("pr-hero upgrade --reconcile");
    expect(unavailable).toContain("~/.prhero/node_modules");
    expect(unavailable).not.toContain("/$bunfs");
    expect(unavailable).not.toContain("undefined");

    await expect(
      loadOpenCodeSdk({
        importPackage: async () => ({ version: undefined }),
      }),
    ).rejects.toThrow(OpenCodeSdkUnavailableError);

    await expect(
      loadOpenCodeSdk({
        importPackage: async () => ({ version: "   " }),
      }),
    ).rejects.toThrow(OpenCodeSdkUnavailableError);

    await expect(
      loadOpenCodeSdk({
        importPackage: async () => {
          throw new Error("package.json not found");
        },
      }),
    ).rejects.toThrow(OpenCodeSdkUnavailableError);

    const missing = await loadOpenCodeSdk({
      importPackage: async () => {
        throw new Error("package.json not found");
      },
    }).then(
      () => {
        throw new Error("expected the missing package to throw");
      },
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(OpenCodeSdkUnavailableError);
    expect((missing as Error).message).toBe(unavailable);

    const mismatched = await loadOpenCodeSdk({
      importPackage: async () => ({ version: "1.18.26" }),
    }).then(
      () => {
        throw new Error("expected the mismatched version to throw");
      },
      (error: unknown) => error,
    );
    expect(mismatched).toBeInstanceOf(OpenCodeVersionAdmissionError);
    expect((mismatched as Error).message).toContain("1.18.26");
    expect((mismatched as Error).message).not.toContain("undefined");
  });

  // The version check above already
  // proved the package IS installed, so a failure importing the v2 entry
  // itself must never collapse back into "not installed" — that swallowed
  // the real cause (a compiled binary's `Cannot find package 'which'` from
  // cross-spawn) and sent operators chasing a reinstall that could not help.
  test("loadOpenCodeSdk on an import failure of a version-matched package names the real cause, never 'not installed'", async () => {
    const { loadOpenCodeSdk, SUPPORTED_OPENCODE_SDK_VERSION } = await import(
      "../../src/transport-registry"
    );
    const { OpenCodeSdkUnavailableError } = await import(
      "../../src/transports/opencode-admission"
    );
    const error = await loadOpenCodeSdk({
      mode: "compiled",
      // Never created on disk: importPackage below supplies the package.json
      // content directly, so the only filesystem interaction left is the
      // REAL dynamic import of the resolved (nonexistent) v2/client entry —
      // a genuine load failure, not a fabricated one.
      nodeModulesDir: "/nonexistent/prhero-fixture/node_modules",
      importPackage: async () => ({
        version: SUPPORTED_OPENCODE_SDK_VERSION,
        exports: { "./v2/client": { import: "./dist/v2/client.js" } },
      }),
    }).then(
      () => {
        throw new Error("expected the import to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenCodeSdkUnavailableError);
    const message = (error as Error).message;
    // Locked to the constant, like openCodeSdkUnavailableMessage's test above:
    // the message carries a version literal, so a SUPPORTED_OPENCODE_SDK_VERSION
    // bump must fail here rather than leave the diagnostic naming a stale pin.
    expect(message).toContain(
      `@opencode-ai/sdk@${SUPPORTED_OPENCODE_SDK_VERSION} is installed`,
    );
    expect(message).not.toContain("is not installed");
    expect(message).toContain("failed to load");
    expect(message).toContain("v2/client.js");
  });
});

describe("OpenCode SDK import plan", () => {
  test("compiled plan reads the product-home package.json and its v2 export; dev and npm stay bare", async () => {
    const { planOpenCodeSdkImport, resolveOpenCodeSdkV2Entry } = await import(
      "../../src/transport-registry"
    );
    const nodeModulesDir = "/Users/x/.prhero/node_modules";
    const compiled = planOpenCodeSdkImport({
      mode: "compiled",
      nodeModulesDir,
    });
    const packageJsonPath = path.join(
      nodeModulesDir,
      "@opencode-ai",
      "sdk",
      "package.json",
    );
    expect(compiled.packageJsonPath).toBe(packageJsonPath);
    expect(compiled.packageSpecifier).toBe(pathToFileURL(packageJsonPath).href);
    expect(compiled.v2Specifier).toBeUndefined();

    const packageDir = path.dirname(packageJsonPath);
    // The CLIENT sub-path, not "./v2": the full index re-exports the SDK's
    // server, which pulls in cross-spawn and does not resolve inside a
    // compiled binary.
    const v2 = resolveOpenCodeSdkV2Entry(
      { exports: { "./v2/client": { import: "./dist/v2/client.js" } } },
      packageDir,
    );
    expect(fileURLToPath(v2)).toBe(
      path.join(packageDir, "dist", "v2", "client.js"),
    );
    const v2String = resolveOpenCodeSdkV2Entry(
      { exports: { "./v2/client": "./dist/v2/client.js" } },
      packageDir,
    );
    expect(fileURLToPath(v2String)).toBe(
      path.join(packageDir, "dist", "v2", "client.js"),
    );

    for (const mode of ["dev", "npm"] as const) {
      const plan = planOpenCodeSdkImport({ mode, nodeModulesDir });
      expect(plan.packageSpecifier).toBe("@opencode-ai/sdk/package.json");
      expect(plan.v2Specifier).toBe("@opencode-ai/sdk/v2/client");
      expect(plan.packageJsonPath).toBeUndefined();
    }
  });

  test("compiled mode loads the v2 entry named by the installed package.json", async () => {
    const { loadOpenCodeSdk, readInstalledOpenCodeSdkVersion } = await import(
      "../../src/transport-registry"
    );
    const root = await mkdtemp(path.join(tmpdir(), "prhero-sdk-plan-"));
    const nodeModulesDir = path.join(root, "node_modules");
    const packageDir = path.join(nodeModulesDir, "@opencode-ai", "sdk");
    const v2Dir = path.join(packageDir, "dist", "v2");
    try {
      await mkdir(v2Dir, { recursive: true });
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          version: "1.18.25",
          exports: { "./v2/client": { import: "./dist/v2/client.js" } },
        }),
      );
      await writeFile(
        path.join(v2Dir, "client.js"),
        "export function createOpencodeClient() { return { ok: true }; }\n",
      );

      expect(
        await readInstalledOpenCodeSdkVersion({
          mode: "compiled",
          nodeModulesDir,
        }),
      ).toBe("1.18.25");
      const sdk = await loadOpenCodeSdk({ mode: "compiled", nodeModulesDir });
      expect(typeof sdk.createOpencodeClient).toBe("function");
      expect(
        await readInstalledOpenCodeSdkVersion({
          mode: "compiled",
          nodeModulesDir: path.join(root, "missing"),
        }),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("dev mode uses the product home when the bare specifier is missing", async () => {
    const { loadOpenCodeSdk, readInstalledOpenCodeSdkVersion } = await import(
      "../../src/transport-registry"
    );
    const root = await mkdtemp(path.join(tmpdir(), "prhero-sdk-fallback-"));
    const nodeModulesDir = path.join(root, "node_modules");
    const packageDir = path.join(nodeModulesDir, "@opencode-ai", "sdk");
    const packageJsonPath = path.join(packageDir, "package.json");
    const v2File = path.join(packageDir, "dist", "v2", "client.js");
    try {
      await mkdir(path.dirname(v2File), { recursive: true });
      await writeFile(
        packageJsonPath,
        JSON.stringify({
          version: "1.18.25",
          exports: { "./v2/client": { import: "./dist/v2/client.js" } },
        }),
      );
      await writeFile(
        v2File,
        "export function createOpencodeClient() { return { ok: true }; }\n",
      );
      const importSpecifier = async (specifier: string): Promise<unknown> => {
        if (specifier.startsWith("@opencode-ai/")) {
          throw new Error(`Cannot find module '${specifier}'`);
        }
        return import(specifier);
      };
      expect(
        await readInstalledOpenCodeSdkVersion({
          mode: "dev",
          nodeModulesDir,
          importSpecifier,
        }),
      ).toBe("1.18.25");
      const sdk = await loadOpenCodeSdk({
        mode: "npm",
        nodeModulesDir,
        importSpecifier,
      });
      expect(typeof sdk.createOpencodeClient).toBe("function");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Drift guard: resolves the CLIENT entry
  // against the REAL installed package's own exports map (not a hand-written
  // fixture), so a future "simplify resolveOpenCodeSdkV2Entry back to /v2"
  // is caught even if every fixture-based test above were reverted too. The
  // resolved path must both name "client.js" and actually exist on disk —
  // the installed SDK is the ground truth for whether that entry is real.
  test("resolves the client entry against the real installed @opencode-ai/sdk package.json", async () => {
    const { resolveOpenCodeSdkV2Entry } = await import(
      "../../src/transport-registry"
    );
    const packageDir = path.dirname(
      require.resolve("@opencode-ai/sdk/package.json"),
    );
    const packageJson = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as { exports?: unknown };

    const resolved = resolveOpenCodeSdkV2Entry(packageJson, packageDir);
    const resolvedPath = fileURLToPath(resolved);

    expect(resolvedPath.endsWith(path.join("v2", "client.js"))).toBe(true);
    expect(existsSync(resolvedPath)).toBe(true);
  });

  test("a second read sees a package.json the installer overwrote", async () => {
    const { readInstalledOpenCodeSdkVersion } = await import(
      "../../src/transport-registry"
    );
    const root = await mkdtemp(path.join(tmpdir(), "prhero-sdk-overwrite-"));
    const nodeModulesDir = path.join(root, "node_modules");
    const packageJsonPath = path.join(
      nodeModulesDir,
      "@opencode-ai",
      "sdk",
      "package.json",
    );
    try {
      await mkdir(path.dirname(packageJsonPath), { recursive: true });
      await writeFile(packageJsonPath, JSON.stringify({ version: "1.0.0" }));
      expect(
        await readInstalledOpenCodeSdkVersion({
          mode: "compiled",
          nodeModulesDir,
        }),
      ).toBe("1.0.0");
      await writeFile(packageJsonPath, JSON.stringify({ version: "1.18.25" }));
      expect(
        await readInstalledOpenCodeSdkVersion({
          mode: "compiled",
          nodeModulesDir,
        }),
      ).toBe("1.18.25");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit 2: OA2a canonical final snapshots & OA2b identity reconciliation
// ---------------------------------------------------------------------------

interface ControlledSdkHandle {
  sdk: import("../../src/transports/opencode-client").OpenCodeSdkLike;
  emit: (event: Record<string, unknown>) => void;
  endStream: () => void;
  setStatus: (status: Record<string, unknown> | undefined) => void;
  setMessages: (
    messages: unknown[] | { data: unknown[]; cursor?: { next?: string } },
  ) => void;
  setPromptResponse: (res: unknown) => void;
}

function makeControlledSdk(options: {
  sessionId?: string;
  toolIds?: string[];
  initialMessages?: unknown[];
  initialStatus?: Record<string, unknown>;
  promptResponse?: unknown;
}): ControlledSdkHandle {
  const sessionId = options.sessionId ?? "ses-controlled-1";
  const queue: unknown[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  let statuses: Record<string, unknown> =
    options.initialStatus !== undefined
      ? { [sessionId]: options.initialStatus }
      : {};
  let messages: unknown = options.initialMessages ?? [];
  let promptRes: unknown = options.promptResponse ?? {};

  const sdk: import("../../src/transports/opencode-client").OpenCodeSdkLike = {
    createOpencodeClient: () => ({
      mcp: { status: async () => ({ data: {} }) },
      permission: { reply: async () => ({ data: true }) },
      tool: {
        ids: async () => ({
          data: options.toolIds ?? ["read", "grep", "glob"],
        }),
      },
      session: {
        create: async (opts?: unknown) => ({
          data: {
            id: sessionId,
            directory:
              (opts as { directory?: string } | undefined)?.directory ??
              "/workspace",
          },
        }),
        prompt: async () => ({ data: promptRes }),
        messages: async () => ({ data: messages }),
        status: async () => ({ data: statuses }),
        abort: async () => ({ data: {} }),
      },
      event: {
        subscribe: async () => ({
          stream: {
            async *[Symbol.asyncIterator]() {
              for (;;) {
                while (queue.length > 0) yield queue.shift();
                if (ended) return;
                await new Promise<void>((resolve) => {
                  notify = resolve;
                });
              }
            },
          },
        }),
      },
    }),
  };

  return {
    sdk,
    emit: (event) => {
      queue.push(event);
      notify?.();
      notify = undefined;
    },
    endStream: () => {
      ended = true;
      notify?.();
      notify = undefined;
    },
    setStatus: (status) => {
      statuses = status === undefined ? {} : { [sessionId]: status };
    },
    setMessages: (msgs) => {
      messages = msgs;
    },
    setPromptResponse: (res) => {
      promptRes = res;
    },
  };
}

function makeControlledRig(
  controlled: ControlledSdkHandle,
  _sessionId = "ses-controlled-1",
) {
  const {
    createOpenCodeClient,
  } = require("../../src/transports/opencode-client");
  const clock = new ManualClock();
  const sink = new RecordingSink();
  const controller = new AbortController();
  const client = createOpenCodeClient({
    createMessageId: () => "msg-user-1",
    loadSdk: async () => controlled.sdk,
    launchServer: async () => ({
      url: "http://127.0.0.1:4096",
      pid: 1000,
      close: async () => {},
    }),
    model: { providerID: "openai", modelID: "gpt-4o" },
    readSystemPrompt: async () => "SYSTEM PROMPT",
  });
  const transport = new OpenCodeSdkTransport({
    client,
    clock,
    stallDeadlineMs: 100,
    abortConfirmMs: 500,
    cleanupMs: 50,
    pollIntervalMs: 10,
    pollRoundMs: 20,
  });
  return { clock, sink, controller, transport, client };
}

describe("OpenCode canonical final snapshots & missing observations (OA2a)", () => {
  const SESS = "ses-oa2a";

  test("dropped deltas: recovers persisted final answer once from canonical snapshot readback", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    // User prompt message
    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });

    // Assistant part announced, but deltas are completely dropped in stream!
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "",
        },
      },
    });

    // Completed assistant message
    const completedAssistant = {
      id: "msg-asst-1",
      sessionID: SESS,
      role: "assistant",
      path: { cwd: "/tmp/pr-hero-test", root: "/" },
      parentID: "msg-user-1",
      finish: "stop",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 100, output: 20 },
      cost: 0.01,
    };

    // The persisted final answer is present in readback messages with its snapshot part
    controlled.setMessages([
      {
        info: completedAssistant,
        parts: [
          {
            id: "prt-ans-1",
            messageID: "msg-asst-1",
            sessionID: SESS,
            type: "text",
            text: "persisted final answer",
          },
        ],
      },
    ]);

    controlled.emit({
      type: "message.updated",
      properties: { sessionID: SESS, info: completedAssistant },
    });
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "persisted final answer",
        },
      },
    });
    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.finalText).toBe("persisted final answer");
    expect(outcome.terminalProof?.eventId).toBe("msg-asst-1");
  });

  test("duplicate deltas: deduplicates identical observations and delivers answer once", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });

    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "",
        },
      },
    });

    // Delivers delta "hello "
    controlled.emit({
      id: "evt-hello-1",
      type: "message.part.delta",
      properties: {
        sessionID: SESS,
        messageID: "msg-asst-1",
        partID: "prt-ans-1",
        field: "text",
        delta: "hello ",
      },
    });

    // Duplicate delivery of the SAME event id: this is the real
    // duplicate-delta contract (an SSE `Last-Event-ID` reconnect redelivering
    // the same event), unlike two independent deltas that merely happen to
    // carry the same text — those are both applied (see D-13 below).
    controlled.emit({
      id: "evt-hello-1",
      type: "message.part.delta",
      properties: {
        sessionID: SESS,
        messageID: "msg-asst-1",
        partID: "prt-ans-1",
        field: "text",
        delta: "hello ",
      },
    });

    const completedAssistant = {
      id: "msg-asst-1",
      sessionID: SESS,
      role: "assistant",
      path: { cwd: "/tmp/pr-hero-test", root: "/" },
      parentID: "msg-user-1",
      finish: "stop",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 10, output: 5 },
      cost: 0,
    };

    controlled.setMessages([
      {
        info: completedAssistant,
        parts: [
          {
            id: "prt-ans-1",
            messageID: "msg-asst-1",
            sessionID: SESS,
            type: "text",
            text: "hello ",
          },
        ],
      },
    ]);

    // Snapshot event restating "hello "
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "hello ",
        },
      },
    });

    // Duplicate completed assistant message events
    controlled.emit({
      type: "message.updated",
      properties: { sessionID: SESS, info: completedAssistant },
    });
    controlled.emit({
      type: "message.updated",
      properties: { sessionID: SESS, info: completedAssistant },
    });

    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.finalText).toBe("hello ");
  });

  // D-13: distinct event ids for repeated-token deltas ("b" twice, building
  // "abbc") must all be applied — the old text-suffix dedup would have
  // silently dropped the second "b". Re-emitting the LAST delta's exact
  // event id afterward proves `controlled.emit`'s top-level `id` reaches
  // `mapOpenCodeEvents` untouched: only an id that actually arrives at the
  // dedup check could suppress that redelivery.
  test("D-13: repeated-token deltas with distinct ids are all applied and a redelivered id is dropped", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });

    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "",
        },
      },
    });

    const chunks: Array<{ id: string; delta: string }> = [
      { id: "evt-a", delta: "a" },
      { id: "evt-b1", delta: "b" },
      { id: "evt-b2", delta: "b" },
      { id: "evt-c", delta: "c" },
    ];
    // Each real delta is a sequential await inside the transport's
    // stream-watcher loop (one `pushGuarded` per delta); flushing between
    // emissions lets each one settle for real before the manual clock's
    // `fireAll()` runs, so a still-in-flight push is never mistaken for one
    // that missed its stall deadline.
    for (const { id, delta } of chunks) {
      controlled.emit({
        id,
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg-asst-1",
          partID: "prt-ans-1",
          field: "text",
          delta,
        },
      });
      await flush();
    }

    // Redelivery of the LAST chunk's exact event id — must be dropped, not
    // appended again.
    controlled.emit({
      id: "evt-c",
      type: "message.part.delta",
      properties: {
        sessionID: SESS,
        messageID: "msg-asst-1",
        partID: "prt-ans-1",
        field: "text",
        delta: "c",
      },
    });
    await flush();

    const completedAssistant = {
      id: "msg-asst-1",
      sessionID: SESS,
      role: "assistant",
      path: { cwd: "/tmp/pr-hero-test", root: "/" },
      parentID: "msg-user-1",
      finish: "stop",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 10, output: 5 },
      cost: 0,
    };

    controlled.setMessages([
      {
        info: completedAssistant,
        parts: [
          {
            id: "prt-ans-1",
            messageID: "msg-asst-1",
            sessionID: SESS,
            type: "text",
            text: "abbc",
          },
        ],
      },
    ]);

    // Snapshot event restating "abbc" — must not throw "conflicting
    // snapshot observed".
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "abbc",
        },
      },
    });

    controlled.emit({
      type: "message.updated",
      properties: { sessionID: SESS, info: completedAssistant },
    });

    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.finalText).toBe("abbc");
  });

  test("user prompt text, reasoning, and intermediate tool-step text are excluded from final answer", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    // 1. User prompt message with its text part
    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-user-1",
          messageID: "msg-user-1",
          sessionID: SESS,
          type: "text",
          text: "Please review this pull request in detail",
        },
      },
    });

    // 2. Intermediate step 1: tool call step with plan narration text and tool part
    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: {
          id: "msg-step-1",
          role: "assistant",
          path: { cwd: "/tmp/pr-hero-test", root: "/" },
          parentID: "msg-user-1",
          sessionID: SESS,
          finish: "tool-calls",
          time: { created: 100, completed: 500 },
        },
      },
    });
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-plan-1",
          messageID: "msg-step-1",
          sessionID: SESS,
          type: "text",
          text: "I will first read the files to check for defects",
        },
      },
    });
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-tool-1",
          messageID: "msg-step-1",
          sessionID: SESS,
          type: "tool",
          callID: "call-1",
          tool: "read",
          state: {
            status: "completed",
            output: "file contents",
            title: "read",
          },
        },
      },
    });

    // 3. Final step: reasoning part and final answer text
    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: {
          id: "msg-final",
          role: "assistant",
          path: { cwd: "/tmp/pr-hero-test", root: "/" },
          parentID: "msg-step-1",
          sessionID: SESS,
          finish: "stop",
          time: { created: 600, completed: 1200 },
        },
      },
    });
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-reason-1",
          messageID: "msg-final",
          sessionID: SESS,
          type: "reasoning",
          text: "Thinking about edge cases in the codebase...",
        },
      },
    });
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-final",
          messageID: "msg-final",
          sessionID: SESS,
          type: "text",
          text: "Found no vulnerabilities. Verification passed.",
        },
      },
    });

    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.finalText).toBe(
      "Found no vulnerabilities. Verification passed.",
    );
    expect(outcome.finalText).not.toContain("Please review");
    expect(outcome.finalText).not.toContain("I will first read");
    expect(outcome.finalText).not.toContain("Thinking about edge cases");
  });

  test("synthetic and ignored text parts are excluded from final answer", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: {
          id: "msg-final",
          role: "assistant",
          path: { cwd: "/tmp/pr-hero-test", root: "/" },
          parentID: "msg-user-1",
          sessionID: SESS,
          finish: "stop",
          time: { created: 100, completed: 200 },
        },
      },
    });

    // Synthetic part
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-synth-1",
          messageID: "msg-final",
          sessionID: SESS,
          type: "text",
          text: "[SYSTEM REMINDER]",
          synthetic: true,
        },
      },
    });

    // Ignored part
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ignore-1",
          messageID: "msg-final",
          sessionID: SESS,
          type: "text",
          text: "[IGNORED CONTEXT]",
          ignored: true,
        },
      },
    });

    // Real answer part
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-real-1",
          messageID: "msg-final",
          sessionID: SESS,
          type: "text",
          text: "Real answer text.",
        },
      },
    });

    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.finalText).toBe("Real answer text.");
  });
});

// #223: session.prompt() is a BLOCKING call that resolves with the finished
// message (see the "FIRED, never awaited" comment on the client), so its
// result always carries the completed assistant info AND that step's final
// text part. Its RESULT is reconciled purely to ingest identity/usage/error
// state — the transport never treats it as the delivery channel, because the
// event stream is the one place a consumer-visible delta is supposed to come
// from. Two of twelve live opencode 1.18.30 attempts observed that HTTP
// result land BEFORE the stream had replayed the SAME text part's own
// announce -> delta x4 -> snapshot lifecycle, and a discard-only reconcile
// that still advanced its internal "already delivered" bookkeeping made the
// later, perfectly ordinary snapshot look like a conflicting one.
describe("OpenCode prompt-result races ahead of the part's own stream lifecycle (#223)", () => {
  const SESS = "ses-promptrace";

  test("a full-text prompt_result followed by the part's announce/delta/snapshot lifecycle still delivers the answer exactly once", async () => {
    const FULL_TEXT = "the answer is 42";
    const DELTA_CHUNKS = ["the ", "answer ", "is ", "42"];
    expect(DELTA_CHUNKS.join("")).toBe(FULL_TEXT);

    const completedAssistant = {
      id: "msg-asst-1",
      sessionID: SESS,
      role: "assistant",
      path: { cwd: "/tmp/pr-hero-test", root: "/" },
      parentID: "msg-user-1",
      finish: "stop",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 10, output: 5 },
      cost: 0,
    };

    // session.prompt() resolves with the full completed message AND its
    // final text part already attached, exactly like the live server.
    const controlled = makeControlledSdk({
      sessionId: SESS,
      promptResponse: {
        info: completedAssistant,
        parts: [
          {
            id: "prt-ans-1",
            messageID: "msg-asst-1",
            sessionID: SESS,
            type: "text",
            text: FULL_TEXT,
          },
        ],
      },
    });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    // Lets the fired-not-awaited session.prompt() call resolve, and its
    // discard-only reconcile run, BEFORE any stream event for this part
    // exists — reproducing "prompt_result arrives before the whole stream
    // lifecycle" from the live evidence.
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });

    // The SAME part's own lifecycle, replayed over the stream afterward:
    // announced empty, rebuilt through deltas, then restated as a snapshot.
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "",
        },
      },
    });

    for (const chunk of DELTA_CHUNKS) {
      controlled.emit({
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg-asst-1",
          partID: "prt-ans-1",
          field: "text",
          delta: chunk,
        },
      });
    }

    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: FULL_TEXT,
        },
      },
    });

    controlled.emit({
      type: "message.updated",
      properties: { sessionID: SESS, info: completedAssistant },
    });

    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.finalText).toBe(FULL_TEXT);

    // The consumer-visible deltas must concatenate to the answer exactly
    // once — no loss from the discard, no duplication from a ghost-advanced
    // "already emitted" bookkeeping.
    const deltaText = rig.sink.events
      .filter((event) => event.type === "delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(deltaText).toBe(FULL_TEXT);
  });
});

// D-11: the poll observer's own readback (opencode-client.ts pollStatus,
// `reconcileMessages(list, state.turn)`, GET /session/messages) reconciles
// with the DEFAULT `emit` (true) — the poll site discards `reconciled.events`
// exactly the way the #223 prompt_result call site above used to, reading
// only `failure`/`terminalProof`/`finalText`/`usage`/`usageIncomplete`. Same
// discard, same hazard: `state.turn` is the SAME shared turn state the stream
// mutates through `mapOpenCodeEvents` (opencode-client.ts SessionState.turn),
// so when the poll's HTTP readback observes a text part's FULL persisted text
// while the stream has only delivered a PREFIX of it, the poll's discard-only
// reconcile still advances `emittedText` to the full text — for a consumer
// that was only ever handed the prefix. The stream's own still-in-flight
// remaining deltas for that part then find `emittedText` already past what
// was really delivered, and the part's own restating snapshot (every real
// fixture sends one before the turn ends) finds `snapshotText` shorter than
// the now-advanced `emittedText` and throws "conflicting snapshot observed" —
// which `runStream`'s catch turns into `settle({ kind: "stream_error" })`,
// flipping a run that actually finished cleanly into `completion: "failed"`.
//
// This is the real end-to-end wiring: the real `createOpenCodeClient` and the
// real `OpenCodeSdkTransport`, so it is what actually discriminates whether
// the poll call site itself carries `{ emit: false }` — unlike the client
// tests in opencode-client.test.ts, which drive `reconcileMessages` directly
// and would look the same regardless of what the poll call site passes.
describe("OpenCode poll readback races ahead of a partially-streamed part (D-11)", () => {
  const SESS = "ses-pollrace";

  test("a poll readback that observes the full text before the stream finishes delivering it must not corrupt the outcome", async () => {
    const FULL_TEXT = "the answer is 42";
    const DELTA_CHUNKS = ["the ", "answer ", "is ", "42"];
    expect(DELTA_CHUNKS.join("")).toBe(FULL_TEXT);

    const inProgressAssistant = {
      id: "msg-asst-1",
      sessionID: SESS,
      role: "assistant",
      path: { cwd: "/tmp/pr-hero-test", root: "/" },
      parentID: "msg-user-1",
      time: { created: 1000 },
    };
    const completedAssistant = {
      ...inProgressAssistant,
      finish: "stop",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 10, output: 5 },
      cost: 0,
    };

    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });
    // Registers ownership (assistantMessages/parentLinks) for the still
    // in-progress step, exactly as the real stream would before the model
    // has finished responding — required before `handlePartUpdated`/
    // `handlePartDelta` will act on this message's parts immediately instead
    // of buffering them in `unknownOwnerBuffer` until a later owning event.
    controlled.emit({
      type: "message.updated",
      properties: { sessionID: SESS, info: inProgressAssistant },
    });

    // The part's own lifecycle begins on the stream: announced empty, then
    // its FIRST chunk only — caught mid-flight, exactly the ordinary
    // announce -> delta lifecycle partway through.
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "",
        },
      },
    });
    controlled.emit({
      type: "message.part.delta",
      properties: {
        sessionID: SESS,
        messageID: "msg-asst-1",
        partID: "prt-ans-1",
        field: "text",
        delta: DELTA_CHUNKS[0],
      },
    });
    await flush();
    expect(
      rig.sink.events
        .filter((event) => event.type === "delta")
        .map((event) => (event as { text: string }).text)
        .join(""),
    ).toBe(DELTA_CHUNKS[0]);

    // The poll observer now races ahead: the session is first reported busy
    // (arming the poll's own boundary detection), then its readback shows
    // the message already fully persisted with its COMPLETE text — before
    // the stream has delivered the rest of it.
    controlled.setStatus({ type: "busy" });
    await advance(rig.clock, 1);

    controlled.setMessages([
      {
        info: completedAssistant,
        parts: [
          {
            id: "prt-ans-1",
            messageID: "msg-asst-1",
            sessionID: SESS,
            type: "text",
            text: FULL_TEXT,
          },
        ],
      },
    ]);
    controlled.setStatus(undefined);
    await advance(rig.clock, 1);

    // The stream's own remaining deltas — already in flight when the poll
    // won the race — arrive now, followed by the part's own restating
    // snapshot, exactly like the #223 test above and every real fixture.
    for (const chunk of DELTA_CHUNKS.slice(1)) {
      controlled.emit({
        type: "message.part.delta",
        properties: {
          sessionID: SESS,
          messageID: "msg-asst-1",
          partID: "prt-ans-1",
          field: "text",
          delta: chunk,
        },
      });
    }
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-ans-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: FULL_TEXT,
        },
      },
    });
    controlled.emit({
      type: "message.updated",
      properties: { sessionID: SESS, info: completedAssistant },
    });
    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    // DISCRIMINATING: on the unfixed poll call site this settles
    // `stream_error`/`failed` (protocolIntegrity `unverified`, terminalProof
    // dropped) even though the turn actually finished and the answer was
    // fully known — the poll's own valid terminal proof and finalText are
    // real, but the stream's own ordinary remaining lifecycle looks like a
    // conflict and throws. Once the poll site stops advancing `emittedText`
    // for text it never handed to a consumer, the same race settles clean.
    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.finalText).toBe(FULL_TEXT);
    expect(outcome.terminalProof?.eventId).toBe("msg-asst-1");

    // The consumer-visible deltas must concatenate to the answer exactly
    // once — no loss, and no duplication from a poll-advanced "already
    // emitted" bookkeeping the stream never actually delivered.
    const deltaText = rig.sink.events
      .filter((event) => event.type === "delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(deltaText).toBe(FULL_TEXT);
  });
});

describe("OpenCode false completion & ownership reconciliation (OA2b)", () => {
  const SESS = "ses-oa2b";

  test("acknowledgement or absent/idle status alone never establishes success", async () => {
    // Prompt acknowledges (returns data: {}), but no assistant message is completed
    const controlled = makeControlledSdk({
      sessionId: SESS,
      initialStatus: { type: "idle" },
      initialMessages: [
        { info: { id: "msg-user-1", role: "user", sessionID: SESS } },
      ],
      promptResponse: { id: "ack-1" },
    });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 4);

    // Session is idle, prompt acked, but no completed assistant exists
    // The attempt must NOT complete successfully
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await flush();

    expect(settled).toBe(false);
    rig.controller.abort();
    await advance(rig.clock, 6);
  });

  test("completed tool-calls finish or unknown finish never establishes success", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });

    // Assistant with finish: "tool-calls"
    const toolStepAssistant = {
      id: "msg-step-1",
      role: "assistant",
      path: { cwd: "/tmp/pr-hero-test", root: "/" },
      parentID: "msg-user-1",
      sessionID: SESS,
      finish: "tool-calls",
      time: { created: 100, completed: 500 },
    };

    controlled.setMessages([{ info: toolStepAssistant, parts: [] }]);
    controlled.setStatus({ type: "idle" });

    controlled.emit({
      type: "message.updated",
      properties: { sessionID: SESS, info: toolStepAssistant },
    });

    await advance(rig.clock, 4);

    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    rig.controller.abort();
    await advance(rig.clock, 6);
  });

  test("outstanding tools prevent acceptance of completion", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });

    // Assistant message finished, BUT tool call is still running
    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: {
          id: "msg-asst-1",
          role: "assistant",
          path: { cwd: "/tmp/pr-hero-test", root: "/" },
          parentID: "msg-user-1",
          sessionID: SESS,
          finish: "stop",
          time: { created: 100, completed: 200 },
        },
      },
    });

    // Tool call still running
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-tool-running",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "tool",
          callID: "call-outstanding",
          tool: "read",
          state: { status: "running", input: { path: "a.ts" } },
        },
      },
    });

    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 4);

    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    rig.controller.abort();
    await advance(rig.clock, 6);
  });

  test("missing ownership: unowned assistant message does not establish success", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-real", role: "user", sessionID: SESS },
      },
    });

    // Completed assistant message links to an UNRELATED user message
    const unownedAssistant = {
      id: "msg-asst-unowned",
      role: "assistant",
      path: { cwd: "/tmp/pr-hero-test", root: "/" },
      parentID: "msg-user-unrelated",
      sessionID: SESS,
      finish: "stop",
      time: { created: 100, completed: 200 },
    };

    controlled.setMessages([{ info: unownedAssistant }]);
    controlled.emit({
      type: "message.updated",
      properties: { sessionID: SESS, info: unownedAssistant },
    });
    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 4);

    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    rig.controller.abort();
    await advance(rig.clock, 6);
  });
});

describe("OpenCode reconciliation fail-closed integrity", () => {
  const SESS = "ses-fail-closed";

  test("conflicting completed snapshots fail closed with malformed integrity", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: {
          id: "msg-asst-1",
          role: "assistant",
          path: { cwd: "/tmp/pr-hero-test", root: "/" },
          parentID: "msg-user-1",
          sessionID: SESS,
          finish: "stop",
          time: { created: 100, completed: 200 },
        },
      },
    });

    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-conflict-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "",
        },
      },
    });

    // Stream delivers delta "Hello World"
    controlled.emit({
      type: "message.part.delta",
      properties: {
        sessionID: SESS,
        messageID: "msg-asst-1",
        partID: "prt-conflict-1",
        field: "text",
        delta: "Hello World",
      },
    });

    // But completed snapshot claims completely conflicting text "Goodbye Moon"
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-conflict-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "Goodbye Moon",
        },
      },
    });

    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).not.toBe("verified");
  });

  test("removal of required content fails closed", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: { id: "msg-user-1", role: "user", sessionID: SESS },
      },
    });

    controlled.emit({
      type: "message.updated",
      properties: {
        sessionID: SESS,
        info: {
          id: "msg-asst-1",
          role: "assistant",
          path: { cwd: "/tmp/pr-hero-test", root: "/" },
          parentID: "msg-user-1",
          sessionID: SESS,
          finish: "stop",
          time: { created: 100, completed: 200 },
        },
      },
    });

    // Assistant part with answer
    controlled.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESS,
        part: {
          id: "prt-req-1",
          messageID: "msg-asst-1",
          sessionID: SESS,
          type: "text",
          text: "Required answer",
        },
      },
    });

    // Now the required part is removed / tombstoned!
    controlled.emit({
      type: "message.part.removed",
      properties: {
        sessionID: SESS,
        messageID: "msg-asst-1",
        partID: "prt-req-1",
      },
    });

    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).not.toBe("verified");
  });

  test("capacity bound exhaustion fails closed rather than guessing", async () => {
    const controlled = makeControlledSdk({ sessionId: SESS });
    const rig = makeControlledRig(controlled, SESS);

    const pending = rig.transport.execute(makeRequest({ sessionId: SESS }), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();

    // Flood with unknown-owner observations past MAX_UNKNOWN_OWNER_BUFFER (256)
    for (let i = 0; i < 300; i += 1) {
      controlled.emit({
        type: "message.part.updated",
        properties: {
          sessionID: SESS,
          part: {
            id: `prt-unknown-${i}`,
            messageID: `msg-unknown-${i}`,
            sessionID: SESS,
            type: "text",
            text: `noise ${i}`,
          },
        },
      });
    }

    controlled.emit({
      type: "session.idle",
      properties: { sessionID: SESS },
    });

    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).not.toBe("verified");
  });
});

describe("Legacy U6 witnesses are unqualified without actual observations", () => {
  function makeBaseWitness(
    overrides: Partial<SessionWitness> = {},
  ): SessionWitness {
    return {
      identities: {
        runId: "run-probe-1",
        attemptId: "att-1",
        sessionId: "sess-1",
        userMessageId: "msg-user-1",
        gitCommitSha: "deadbeefcafebabe",
        sdkVersion: "1.18.25",
        serverVersion: "1.18.30",
        route: {
          provider: "openai",
          modelSnapshot: "gpt-5.6-luna",
          modelVariant: "high",
        },
        cwd: "/workspace/pr-hero",
        credentialCategory: "operator_oauth",
        sanitizedEndpoint: "http://127.0.0.1:4096/v1",
      },
      requestWire: {
        sanitizedPath: "/session/sess-1/message",
        sanitizedQuery: {},
        sanitizedBody: { prompt: "review PR" },
        timestamps: { sentAt: 1000, receivedAt: 2000 },
        status: 200,
      },
      events: [
        {
          timestamp: 1050,
          seq: 1,
          eventType: "message.part.updated",
          partId: "prt-1",
          textDelta: "LGTM",
        },
      ],
      readback: {
        directory: "/workspace/pr-hero",
        messages: [
          {
            id: "msg-asst-1",
            role: "assistant",
            parentId: "msg-user-1",
            finishStatus: "stop",
            parts: [{ id: "prt-1", type: "text", text: "LGTM" }],
            finalText: "LGTM",
          },
        ],
      },
      settlement: {
        status: "completed",
        readbackAttempts: 1,
        arbiterTerminalReason: "completed",
        abortRequested: false,
        abortAcknowledged: false,
        abortConfirmed: false,
        usageCompleteness: "complete",
      },
      ...overrides,
    };
  }

  test("redaction: keys, authorization headers, and secret tokens in URL and body are completely redacted", () => {
    const dirty = makeBaseWitness({
      identities: {
        ...makeBaseWitness().identities,
        credentialCategory: "operator_oauth",
      },
      requestWire: {
        sanitizedPath:
          "/session/sess-1/message?token=ghp_ABC12345678901234567890&apiKey=secret-key-1234&access_token=secret_access_token",
        sanitizedQuery: {
          key: "sk-openai-secret-token-abcdef123456",
          safe: "public-value",
          access_token: "query_access_token",
          cookie: "sid=secret_cookie_val",
        },
        sanitizedBody: {
          headers: {
            authorization: "Bearer my-secret-jwt-token-12345",
            "x-api-key": "secret-api-key-9999",
            cookie: "session_id=super_secret_cookie",
          },
          password: "supersecretpassword",
          secret: "confidential",
          endpoint: "https://admin:super_secret_pass@example.invalid/v1",
          access_token: "body_access_token",
          userPrompt:
            "Please use token ghp_99999999999999999999 to authenticate with sk-key12345678",
        },
        timestamps: { sentAt: 1000, receivedAt: 2000 },
        status: 200,
      },
    });

    const sanitized = sanitizeWitness(dirty);

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("ghp_ABC12345678901234567890");
    expect(serialized).not.toContain("secret-key-1234");
    expect(serialized).not.toContain("sk-openai-secret-token-abcdef123456");
    expect(serialized).not.toContain("my-secret-jwt-token-12345");
    expect(serialized).not.toContain("secret-api-key-9999");
    expect(serialized).not.toContain("supersecretpassword");
    expect(serialized).not.toContain("confidential");
    expect(serialized).not.toContain("ghp_99999999999999999999");
    expect(serialized).not.toContain("sk-key12345678");
    expect(serialized).not.toContain("super_secret_pass");
    expect(serialized).not.toContain("secret_access_token");
    expect(serialized).not.toContain("query_access_token");
    expect(serialized).not.toContain("body_access_token");
    expect(serialized).not.toContain("secret_cookie_val");
    expect(serialized).not.toContain("super_secret_cookie");

    expect(sanitized.identities.credentialCategory).toBe("operator_oauth");
    expect(
      (sanitized.requestWire.sanitizedQuery as Record<string, string>).safe,
    ).toBe("public-value");
    expect(sanitized.identities.runId).toBe("run-probe-1");
  });

  test("demonstrated reconstruction defect: classifies as demonstrated_reconstruction_defect when readback persists text but local text is empty", () => {
    const witness = makeBaseWitness({
      readback: {
        messages: [
          {
            id: "msg-asst-1",
            role: "assistant",
            parentId: "msg-user-1",
            finishStatus: "stop",
            parts: [
              { id: "prt-1", type: "text", text: "Approved with no defects." },
            ],
            finalText: "Approved with no defects.",
          },
        ],
      },
    });

    const classification: WitnessClassification = classifyWitnessEvidence(
      witness,
      "",
    );
    expect(classification).toBe("inconclusive");
  });

  test("persisted final empty: classifies as persisted_final_empty when server completes with empty assistant text", () => {
    const witness = makeBaseWitness({
      readback: {
        messages: [
          {
            id: "msg-asst-1",
            role: "assistant",
            parentId: "msg-user-1",
            finishStatus: "stop",
            parts: [],
            finalText: "",
          },
        ],
      },
    });

    const classification = classifyWitnessEvidence(witness, "");
    expect(classification).toBe("inconclusive");
  });

  test("external rejection: classifies admission error, HTTP 4xx/5xx, or provider refusal as external_rejection", () => {
    const httpErrorWitness = makeBaseWitness({
      requestWire: {
        sanitizedPath: "/session/sess-1/message",
        sanitizedQuery: {},
        sanitizedBody: {},
        timestamps: { sentAt: 1000 },
        status: 500,
        error: "Internal Server Error",
      },
    });
    expect(classifyWitnessEvidence(httpErrorWitness, "")).toBe("inconclusive");

    const providerRefusalWitness = makeBaseWitness({
      settlement: {
        status: "failed",
        readbackAttempts: 1,
        arbiterTerminalReason: "prompt_refused",
        abortRequested: false,
        usageCompleteness: "incomplete",
      },
    });
    expect(classifyWitnessEvidence(providerRefusalWitness, "")).toBe(
      "inconclusive",
    );

    const admissionErrorWitness = makeBaseWitness({
      settlement: {
        status: "admission-error",
        readbackAttempts: 0,
        arbiterTerminalReason: "admission_refused",
        abortRequested: false,
        usageCompleteness: "incomplete",
      },
    });
    expect(classifyWitnessEvidence(admissionErrorWitness, "")).toBe(
      "inconclusive",
    );
  });

  test("inconclusive: classifies dropped or missing readback or partial evidence as inconclusive", () => {
    const noReadbackWitness = makeBaseWitness({
      readback: null,
    });
    expect(classifyWitnessEvidence(noReadbackWitness, "")).toBe("inconclusive");

    const emptyMessagesWitness = makeBaseWitness({
      readback: {
        messages: [],
      },
    });
    expect(classifyWitnessEvidence(emptyMessagesWitness, "")).toBe(
      "inconclusive",
    );

    const unfinishedWitness = makeBaseWitness({
      readback: {
        messages: [
          {
            id: "msg-asst-1",
            role: "assistant",
            parentId: "msg-user-1",
            finishStatus: undefined,
            parts: [{ id: "prt-1", type: "text", text: "partial" }],
          },
        ],
      },
    });
    expect(classifyWitnessEvidence(unfinishedWitness, "")).toBe("inconclusive");

    const wrongOwnerWitness = makeBaseWitness({
      identities: {
        ...makeBaseWitness().identities,
        userMessageId: "msg-user-correct",
      },
      readback: {
        messages: [
          {
            id: "msg-asst-1",
            role: "assistant",
            parentId: "msg-user-wrong",
            finishStatus: "stop",
            parts: [{ id: "prt-1", type: "text", text: "text" }],
          },
        ],
      },
    });
    expect(classifyWitnessEvidence(wrongOwnerWitness, "")).toBe("inconclusive");

    const runningToolWitness = makeBaseWitness({
      readback: {
        messages: [
          {
            id: "msg-asst-1",
            role: "assistant",
            parentId: "msg-user-1",
            finishStatus: "stop",
            parts: [{ id: "prt-1", type: "text", text: "text" }],
            toolCalls: [{ status: "running" }],
          },
        ],
      },
    });
    expect(classifyWitnessEvidence(runningToolWitness, "")).toBe(
      "inconclusive",
    );
  });
});

describe("Task 7.1 RED U7 EQ1b/EQ2a/b: outcome resume, qualification metrics, and complete-empty discrimination", () => {
  test("EQ1b: existing files with missing or incomplete witness/proof retain incomplete/inconclusive classification and do not falsely resume as success", () => {
    // Bare terminal proof without findings document returns incomplete
    const bareTerminal = evaluateResumeOutcome({
      terminalProof: completedProof("evt-bare"),
      runStatus: "complete",
      protocolIntegrity: "verified",
      finishStatus: "stop",
    });
    expect(bareTerminal).toBe("incomplete");

    // Missing terminal proof
    const missingProof = evaluateResumeOutcome({
      hasFindingsDocument: true,
      findings: [],
      runStatus: "complete",
      protocolIntegrity: "verified",
      terminalProof: undefined,
      finishStatus: "stop",
    });
    expect(missingProof).toBe("incomplete");

    // Unverified protocol integrity
    const unverifiedIntegrity = evaluateResumeOutcome({
      hasFindingsDocument: true,
      findings: [],
      runStatus: "complete",
      protocolIntegrity: "unverified",
      terminalProof: completedProof("evt-1"),
      finishStatus: "stop",
    });
    expect(unverifiedIntegrity).toBe("incomplete");

    // Truncated / missing finish status
    const truncatedFinish = evaluateResumeOutcome({
      hasFindingsDocument: true,
      findings: [],
      runStatus: "complete",
      protocolIntegrity: "verified",
      terminalProof: completedProof("evt-2"),
      finishStatus: undefined,
      truncated: true,
    });
    expect(truncatedFinish).toBe("incomplete");

    // Unconfirmed cessation (abort requested without confirmation)
    const unconfirmedCessation = evaluateResumeOutcome({
      hasFindingsDocument: true,
      findings: [],
      runStatus: "complete",
      protocolIntegrity: "verified",
      terminalProof: completedProof("evt-3"),
      finishStatus: "stop",
      abortRequested: true,
      abortConfirmed: false,
    });
    expect(unconfirmedCessation).toBe("incomplete");

    // Partial run status on disk
    const partialRun = evaluateResumeOutcome({
      hasFindingsDocument: true,
      findings: [],
      runStatus: "partial",
      protocolIntegrity: "verified",
      terminalProof: completedProof("evt-4"),
      finishStatus: "stop",
      sessionFailed: true,
    });
    expect(partialRun).toBe("incomplete");

    // Verified complete artifact DOES resume as complete
    const validComplete = evaluateResumeOutcome({
      hasFindingsDocument: true,
      findings: [],
      runStatus: "complete",
      protocolIntegrity: "verified",
      terminalProof: completedProof("evt-5"),
      finishStatus: "stop",
      abortRequested: false,
      abortConfirmed: false,
      sessionFailed: false,
    });
    expect(validComplete).toBe("complete");
  });

  test("EQ2a: benchmark metrics calculate separate completion and coverage denominators, cost-per-complete, and do not fold partial runs into completed totals", () => {
    const runs: BenchmarkRunRecord[] = [
      {
        pr: 101,
        status: "complete",
        wallMs: 40000,
        costUsd: 0.1,
        tp: 2,
        fp: 1,
        fn: 1,
      },
      {
        pr: 102,
        status: "complete",
        wallMs: 60000,
        costUsd: 0.2,
        tp: 1,
        fp: 0,
        fn: 2,
      },
      {
        pr: 103,
        status: "complete",
        wallMs: 50000,
        costUsd: 0.15,
        tp: 3,
        fp: 2,
        fn: 0,
      },
      {
        pr: 104,
        status: "partial",
        wallMs: 120000,
        costUsd: 0.05,
        quarantineReason: "gateway_500_hang",
      },
    ];

    const metrics = computeQualifiedBenchmarkMetrics(runs);

    // Denominators are separated: 3 complete vs 4 attempted
    expect(metrics.attempted).toBe(4);
    expect(metrics.completed).toBe(3);
    expect(metrics.partial).toBe(1);
    expect(metrics.completionRate).toBe(0.75);
    expect(metrics.coverage).toBe(0.75);

    // Spend is accounted honestly
    expect(metrics.completedSpendUsd).toBeCloseTo(0.45, 5);
    expect(metrics.partialSpendUsd).toBeCloseTo(0.05, 5);
    expect(metrics.totalSpendUsd).toBeCloseTo(0.5, 5);

    // Cost-per-complete is strictly completedSpend / completed (0.45 / 3 = 0.15),
    // NOT total / attempted or folding partial into completed
    expect(metrics.costPerComplete).toBeCloseTo(0.15, 5);

    // Wall-clock per complete
    expect(metrics.completedWallMs).toBe(150000);
    expect(metrics.wallMsPerComplete).toBe(50000);

    // Quality metrics computed on completed runs
    expect(metrics.quality.tp).toBe(6);
    expect(metrics.quality.fp).toBe(3);
    expect(metrics.quality.fn).toBe(3);
    expect(metrics.quality.precision).toBeCloseTo(6 / 9, 4);
    expect(metrics.quality.recall).toBeCloseTo(6 / 9, 4);

    // Quarantined runs labeled
    expect(metrics.quarantinedRuns).toHaveLength(1);
    expect(metrics.quarantinedRuns[0]?.pr).toBe(104);
    expect(metrics.quarantinedRuns[0]?.reason).toBe("gateway_500_hang");
  });

  test("EQ2b: complete-empty MUSE finding set is explicitly distinguished from transport blanks / infrastructure drops", () => {
    // Complete-empty MUSE review (0 issues found, verified completion)
    const completeEmpty = discriminateReviewCompletion({
      hasFindingsDocument: true,
      runStatus: "complete",
      protocolIntegrity: "verified",
      terminalProof: completedProof("evt-empty-1"),
      finishStatus: "stop",
      findings: [],
      stdout: "{}",
    });
    expect(completeEmpty.classification).toBe("complete_empty");
    expect(completeEmpty.isCompletedReview).toBe(true);
    expect(completeEmpty.isCompleteEmpty).toBe(true);
    expect(completeEmpty.isTransportBlank).toBe(false);

    // Transport blank failure (dropped output, unverified finish, empty stdout)
    const transportBlank = discriminateReviewCompletion({
      hasFindingsDocument: false,
      runStatus: "partial",
      protocolIntegrity: "unverified",
      terminalProof: undefined,
      finishStatus: undefined,
      findings: [],
      stdout: "",
    });
    expect(transportBlank.classification).toBe("transport_blank");
    expect(transportBlank.isCompletedReview).toBe(false);
    expect(transportBlank.isCompleteEmpty).toBe(false);
    expect(transportBlank.isTransportBlank).toBe(true);

    // Regular complete review with findings
    const completeWithFindings = discriminateReviewCompletion({
      hasFindingsDocument: true,
      runStatus: "complete",
      protocolIntegrity: "verified",
      terminalProof: completedProof("evt-find-1"),
      finishStatus: "stop",
      findings: [{ id: "find-1" }],
      stdout: '{"findings":[{"id":"find-1"}]}',
    });
    expect(completeWithFindings.classification).toBe("complete_with_findings");
    expect(completeWithFindings.isCompletedReview).toBe(true);
    expect(completeWithFindings.isCompleteEmpty).toBe(false);
    expect(completeWithFindings.isTransportBlank).toBe(false);
  });
});

describe("OpenCode workspace and CWD lineage (U5-C1)", () => {
  test("absent sessionRecord.directory on session.create is rejected", async () => {
    const { createOpenCodeClient } = await import(
      "../../src/transports/opencode-client"
    );
    const client = createOpenCodeClient({
      model: { providerID: "openai", modelID: "gpt-4o" },
      launchServer: async () => ({
        url: "http://127.0.0.1:4096",
        pid: 12345,
        close: async () => {},
      }),
      loadSdk: async () =>
        ({
          createOpencodeClient: () => ({
            mcp: { status: async () => ({ data: {} }) },
            session: {
              create: async () => ({ data: { id: "ses-no-dir" } }),
              abort: async () => ({ data: true }),
            },
            event: {
              subscribe: async () => ({
                [Symbol.asyncIterator]: async function* () {},
              }),
            },
            tool: {
              ids: async () => ({ data: ["read"] }),
            },
          }),
        }) as never,
      readSystemPrompt: async () => "PROMPT",
    });

    await expect(
      client.createSession({
        cwd: "/workspace/expected-dir",
        systemPromptPath: "/tmp/sys.md",
        tools: ["Read"],
        userPrompt: "test",
      }),
    ).rejects.toThrow("mismatched directory");
  });

  test("mismatched sessionRecord.directory on session.create is rejected and aborts session", async () => {
    const { createOpenCodeClient } = await import(
      "../../src/transports/opencode-client"
    );
    let aborted = false;
    const client = createOpenCodeClient({
      model: { providerID: "openai", modelID: "gpt-4o" },
      launchServer: async () => ({
        url: "http://127.0.0.1:4096",
        pid: 12345,
        close: async () => {},
      }),
      loadSdk: async () =>
        ({
          createOpencodeClient: () => ({
            mcp: { status: async () => ({ data: {} }) },
            session: {
              create: async () => ({
                data: { id: "ses-diff-dir", directory: "/workspace/other-dir" },
              }),
              abort: async () => {
                aborted = true;
                return { data: true };
              },
            },
          }),
        }) as never,
      readSystemPrompt: async () => "PROMPT",
    });

    await expect(
      client.createSession({
        cwd: "/workspace/expected-dir",
        systemPromptPath: "/tmp/sys.md",
        tools: ["Read"],
        userPrompt: "test",
      }),
    ).rejects.toThrow(
      /opencode session created with mismatched directory: expected \/workspace\/expected-dir, got \/workspace\/other-dir/,
    );
    expect(aborted).toBe(true);
  });

  test("mismatched message.path.cwd in mapOpenCodeEvents throws and sets integrity failure", async () => {
    const { createTurnState, mapOpenCodeEvents } = await import(
      "../../src/transports/opencode-client"
    );
    const state = createTurnState(
      "ses-1",
      undefined,
      "/workspace/expected-dir",
    );
    const event = {
      type: "message.updated",
      properties: {
        sessionID: "ses-1",
        info: {
          id: "msg-1",
          sessionID: "ses-1",
          role: "assistant",
          path: { cwd: "/workspace/rogue-dir" },
        },
      },
    };

    expect(() => mapOpenCodeEvents(event, "ses-1", state)).toThrow(
      /message cwd mismatch/,
    );
    expect(state.integrityFailure).toContain("message cwd mismatch");
  });

  test("mismatched message.path.cwd in reconcileMessages sets integrity failure and rejects", async () => {
    const { createTurnState, reconcileMessages } = await import(
      "../../src/transports/opencode-client"
    );
    const state = createTurnState(
      "ses-1",
      undefined,
      "/workspace/expected-dir",
    );
    const messages = [
      {
        parts: [],
        info: {
          id: "msg-1",
          sessionID: "ses-1",
          role: "assistant",
          path: { cwd: "/workspace/rogue-dir" },
        },
      },
    ];

    const result = reconcileMessages(messages, state);
    expect(result.failure).toContain("message cwd mismatch");
    expect(state.integrityFailure).toContain("message cwd mismatch");
  });

  test("matching message.path.cwd in mapOpenCodeEvents and reconcileMessages is accepted", async () => {
    const { createTurnState, mapOpenCodeEvents, reconcileMessages } =
      await import("../../src/transports/opencode-client");
    const state = createTurnState(
      "ses-1",
      undefined,
      "/workspace/expected-dir",
    );
    const event = {
      type: "message.updated",
      properties: {
        sessionID: "ses-1",
        info: {
          id: "msg-1",
          sessionID: "ses-1",
          role: "assistant",
          path: { cwd: "/workspace/expected-dir" },
        },
      },
    };

    expect(() => mapOpenCodeEvents(event, "ses-1", state)).not.toThrow();
    expect(state.integrityFailure).toBeUndefined();

    const messages = [
      {
        parts: [],
        info: {
          id: "msg-1",
          sessionID: "ses-1",
          role: "assistant",
          path: { cwd: "/workspace/expected-dir" },
        },
      },
    ];
    const result = reconcileMessages(messages, state);
    expect(result.failure).toBeUndefined();
    expect(state.integrityFailure).toBeUndefined();
  });
});

describe("OpenCodeSdkTransport toolInvocations (#214)", () => {
  test("a completed turn with no tool events stamps 0, on diagnostics not the witness", async () => {
    const proof = completedProof("evt-empty-hunt");
    const handle = makeClient({
      stream: streamOf([
        { kind: "delta", text: '{"findings":[]}' },
        { kind: "terminal", proof },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.toolInvocations).toBe(0);
    expect(outcome.diagnosticsTail).toContain(
      "observed 0 completed tool invocation(s)",
    );
    expect(outcome.stderrTail).not.toContain("tool invocation");
  });

  test("each tool event increments the stamped count", async () => {
    const proof = completedProof("evt-looked");
    const handle = makeClient({
      stream: streamOf([
        { kind: "tool" },
        { kind: "tool" },
        { kind: "delta", text: '{"findings":[]}' },
        { kind: "terminal", proof },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.toolInvocations).toBe(2);
    expect(outcome.finalText).toBe('{"findings":[]}');
    expect(outcome.diagnosticsTail).toContain(
      "observed 2 completed tool invocation(s)",
    );
  });

  test("session creation failure omits the count — it never opened a turn", async () => {
    const handle = makeClient({
      createError: new Error("refused"),
    });
    const rig = makeRig({ client: handle.client });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.toolInvocations).toBeUndefined();
    expect(outcome.diagnosticsTail ?? "").not.toContain("tool invocation");
  });

  // A poll-won turn is a supported delivery path (dev's `terminalFinalText`
  // already mirrors it for the answer text), so a hunter this observer never
  // saw a stream "tool" event for — the stream delivered only a delta, the
  // POLL readback is what discovered the completed tool part and the
  // terminal — must still be able to prove it looked. Without this, a
  // poll-won turn with a genuinely completed tool call reads as vacuous and
  // the harness gate (#214, `isVacuousHunt`) refuses it.
  test("a poll-won terminal carries its own tool tally when the stream never saw one", async () => {
    const proof = completedProof("evt-poll-tool");
    const handle = makeClient({
      stream: streamOf([{ kind: "delta", text: '{"findings":[]}' }]),
      polls: [
        {
          kind: "terminal",
          proof,
          finalText: '{"findings":[]}',
          completedToolCallIds: ["call_1", "call_2"],
        },
      ],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.toolInvocations).toBe(2);
    expect(outcome.diagnosticsTail).toContain(
      "observed 2 completed tool invocation(s)",
    );
  });

  test("the stream's own distinct calls are kept when a confirming poll only names one of them (union, not overwrite)", async () => {
    const proof = completedProof("evt-stream-ahead");
    const handle = makeClient({
      stream: streamOf([
        { kind: "tool", callId: "call_1" },
        { kind: "tool", callId: "call_2" },
        { kind: "tool", callId: "call_3" },
        { kind: "delta", text: '{"findings":[]}' },
        { kind: "terminal", proof },
      ]),
      // The poll's confirming readback names only one of the three calls the
      // stream already proved complete (e.g. it read back before the other
      // two parts landed). The union must keep all three: neither the poll's
      // smaller set nor a plain overwrite may erase what the stream already
      // proved.
      polls: [{ kind: "terminal", proof, completedToolCallIds: ["call_1"] }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.toolInvocations).toBe(3);
  });

  // F001 (corroborated, opencode-sdk.ts:863): the poll-side tally used to be
  // read fresh off `toolStates` at every terminal report and then OVERWRITE
  // the running total. A later readback that shows an earlier-completed call
  // as "error" (or anything else) lowered the recount, and this unconditional
  // `terminalToolInvocations = polledToolInvocations` assignment (reachable
  // on a CONFIRMING poll of an already-won terminal, not just the winning
  // one — see `onProviderTerminalCandidate`) let that smaller number replace
  // a correct larger one.
  test("a later confirming poll reporting fewer completed ids does not shrink the count (F001)", async () => {
    const proof = completedProof("evt-f001");
    const handle = makeClient({
      // Never-ending, so #132's drain window keeps re-arming instead of
      // settling on its first check — giving the SECOND scripted poll (the
      // confirming one) room to actually fire before settlement finalizes.
      stream: delaysThenGoesQuiet(6),
      polls: [
        { kind: "terminal", proof, completedToolCallIds: ["call_a"] },
        // The confirming round: same proof, but its own fresh snapshot no
        // longer names call_a (it may have since shown "error"). The
        // monotonic union must not un-count it.
        { kind: "terminal", proof, completedToolCallIds: [] },
      ],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 12);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.toolInvocations).toBe(1);
  });

  // F002 (opencode-sdk.ts:1633): Math.max of two independently-tallied COUNTS
  // cannot distinguish "two different calls, one per observer" from "one call,
  // seen twice" -- both looked like "1 and 1" and Math.max(1, 1) undercounted
  // the former to 1 instead of 2. Identity fixes it: two DIFFERENT callIDs
  // union to a set of size 2.
  test("poll-only and stream-only completions of different calls both count (F002)", async () => {
    const proof = completedProof("evt-f002");
    const handle = makeClient({
      stream: streamOf([
        { kind: "tool", tool: "read", callId: "call_b" },
        { kind: "delta", text: '{"findings":[]}' },
        { kind: "terminal", proof },
      ]),
      polls: [{ kind: "terminal", proof, completedToolCallIds: ["call_a"] }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.toolInvocations).toBe(2);
  });

  // The mirror of F002: the SAME call observed by both the stream and a
  // confirming poll counts once, not twice -- proving the union is keyed by
  // identity, not merely accumulating every report it is handed.
  test("the same call seen by both the stream and the poll counts once", async () => {
    const proof = completedProof("evt-both-observers");
    const handle = makeClient({
      stream: streamOf([
        { kind: "tool", tool: "read", callId: "call_a" },
        { kind: "delta", text: '{"findings":[]}' },
        { kind: "terminal", proof },
      ]),
      polls: [{ kind: "terminal", proof, completedToolCallIds: ["call_a"] }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.toolInvocations).toBe(1);
  });
});

// #150: the OpenCode SDK transport must declare it does not consume the
// harness's per-step credential projection — its server owns ONE
// projection for the server's whole lifetime (#149), brokered before the
// server ever launches, not a fresh one per step/attempt.
describe("OpenCodeSdkTransport credentialProjection declaration (#150)", () => {
  test("declares server-lifetime regardless of construction options", async () => {
    const handle = makeClient({});
    const transport = new OpenCodeSdkTransport({ client: handle.client });
    expect(transport.credentialProjection).toBe("server-lifetime");
  });
});
