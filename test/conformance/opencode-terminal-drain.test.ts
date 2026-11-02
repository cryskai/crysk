import { describe, expect, test } from "bun:test";
import type {
  AsyncEventSink,
  ProviderEvent,
  ProviderTerminalProof,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import type {
  OpenCodeClientEvent,
  OpenCodeClientLike,
  OpenCodePollResult,
  OpenCodeTransportClock,
} from "../../src/transports/opencode-sdk";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";
import { flush } from "../support/flush";

// Issue #132: the poll observer can win §197's terminal slot while the stream
// is still delivering the turn's answer text, and the attempt then reports
// success over a TRUNCATED finalText — a well-formed terminal proof, a
// `completion: "ok"`, and a short answer the harness goes on to judge as a
// format violation or parse as a genuinely empty finding set. Worse than a
// hang, which is loud and ends at the watchdog.
//
// What was already true, and what the issue does not say: the slot win does
// NOT settle at once. It arms a post-win window (`cleanupMs`) whose original
// purpose is §197's — a later conflicting terminal must still be able to flip
// the outcome malformed — and the stream keeps draining inside it. The defect
// is that the window is a FIXED TIMER, not a drain check: it never asks
// whether the stream is still delivering, so it is a bet rather than a
// guarantee, and when it loses nothing says so.
//
// The fix keeps the two observers independent where §197 requires it. Asking
// "is the stream still delivering?" is a DELIVERY question, not an EVIDENCE
// one — what may never be armed from the stream is the poll's boundary
// detection (`observedActive`, opencode-client.ts), and that is untouched.
// The window now re-arms while deltas keep arriving, and when the drain budget
// runs out with content STILL arriving the attempt says so: integrity
// `truncated`, a declared marker, and `protocol_truncation` — an OBSERVED
// signal, never the parse-failure heuristic #124 exists to end.
//
// Scope is `provider_terminal` only, by decision: it is the one settle reason
// that reports success, so the one where a truncated answer is silent. The
// abort and failure reasons already return `failed`/`cancelled` carrying their
// own diagnosis, and `abort_confirmed` cannot afford a drain window at all
// (§5.2 line 272 — it would overrun the 6,500 ms harness deadline).

class ManualClock implements OpenCodeTransportClock {
  private pending: Array<{ fn: () => void }> = [];

  schedule(_ms: number, fn: () => void): () => void {
    const entry = { fn };
    this.pending.push(entry);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== entry);
    };
  }

  // Splices BEFORE running, so a callback that re-arms a timer lands in the
  // next pass rather than this one. One `fireAll` is therefore exactly one
  // drain cycle, which is what makes the re-arming window testable at all.
  fireAll(): void {
    const fns = this.pending.splice(0).map((entry) => entry.fn);
    for (const fn of fns) fn();
  }
}

class RecordingSink implements AsyncEventSink {
  readonly events: ProviderEvent[] = [];
  closed = false;

  async push(event: ProviderEvent): Promise<"accepted" | "closed"> {
    this.events.push(event);
    return this.closed ? "closed" : "accepted";
  }

  close(): void {
    this.closed = true;
  }
}

function makeRequest(): TransportRequest {
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
  };
}

const completedProof = (
  eventId: string,
  status = "completed",
): ProviderTerminalProof => ({
  eventId,
  providerStatus: status,
  providerObservedAt: "2026-08-26T00:00:00.000Z",
});

// A stream the test drives event by event, shaped like the real client's
// queue+wake pump (opencode-client.ts): everything pushed before the consumer
// asks is already waiting, and everything after arrives through the same door.
// A plain array generator cannot express this test — it drains inside one
// microtask flush, so the stream is never mid-delivery when a clock fires.
function gatedStream() {
  const queue: OpenCodeClientEvent[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const iterable = (async function* () {
    for (;;) {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) yield next;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  return {
    iterable,
    emit(event: OpenCodeClientEvent): void {
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    end(): void {
      ended = true;
      wake?.();
      wake = undefined;
    },
  };
}

function makeClient(options: {
  stream?: AsyncIterable<OpenCodeClientEvent>;
  polls?: Array<OpenCodePollResult>;
}): OpenCodeClientLike {
  let round = 0;
  return {
    createSession: async () => ({ id: "oc-sess-1" }),
    async *streamEvents() {
      if (options.stream !== undefined) {
        yield* options.stream;
        return;
      }
      await new Promise<never>(() => {});
    },
    pollStatus: async () => {
      const index = round;
      round += 1;
      return options.polls?.[index] ?? ({ kind: "pending" } as const);
    },
    abort: async () => {},
  };
}

function makeRig(
  client: OpenCodeClientLike,
  overrides: { maxDrainCycles?: number } = {},
) {
  const clock = new ManualClock();
  const sink = new RecordingSink();
  const controller = new AbortController();
  const transport = new OpenCodeSdkTransport({
    client,
    clock,
    stallDeadlineMs: 50,
    abortConfirmMs: 500,
    cleanupMs: 100,
    maxDeltaBytes: 64 * 1024,
    maxFinalTextBytes: 1024 * 1024,
    pollIntervalMs: 10,
    pollRoundMs: 20,
    ...overrides,
  });
  const pending = transport.execute(makeRequest(), {
    signal: controller.signal,
    events: sink,
  });
  return { clock, sink, controller, transport, pending };
}

describe("#132 a poll-won terminal waits for the stream to go quiet", () => {
  test("text still arriving after the slot is won reaches finalText", async () => {
    const stream = gatedStream();
    const rig = makeRig(
      makeClient({
        stream: stream.iterable,
        // #130: round 0 is observed immediately, before the first interval —
        // so the poll can win the slot before the turn's text has landed.
        polls: [{ kind: "terminal", proof: completedProof("evt-poll-win") }],
      }),
    );

    // The slot is won with nothing delivered yet: the window is armed, and
    // under a FIXED window the very next timer firing ends the attempt.
    await flush();

    stream.emit({ kind: "delta", text: "plan-narration " });
    await flush();
    // A delta landed inside this window, so the stream is still delivering.
    rig.clock.fireAll();
    await flush();

    stream.emit({ kind: "delta", text: "tool-narration " });
    await flush();
    rig.clock.fireAll();
    await flush();

    // The answer itself — the part the issue reports losing.
    stream.emit({ kind: "delta", text: '{"findings":[]}' });
    await flush();
    rig.clock.fireAll();
    await flush();

    // Quiet: nothing arrived in this window, so the attempt settles.
    rig.clock.fireAll();
    const outcome = await rig.pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.terminalProof?.eventId).toBe("evt-poll-win");
    expect(outcome.finalText).toBe(
      'plan-narration tool-narration {"findings":[]}',
    );
  });

  test("a quiet stream settles in one window, with no extra cycle", async () => {
    const stream = gatedStream();
    const rig = makeRig(
      makeClient({
        stream: stream.iterable,
        // Pending first, so the delta is delivered BEFORE the slot is won and
        // the window opens onto a stream that has already said everything.
        polls: [
          { kind: "pending" },
          { kind: "terminal", proof: completedProof("evt-quiet") },
        ],
      }),
    );

    stream.emit({ kind: "delta", text: "answer" });
    await flush();

    // Fires the poll interval: round 1 wins the slot and arms the window.
    rig.clock.fireAll();
    await flush();

    // ONE window, and the attempt is over. This is the overwhelmingly common
    // shape — the answer is delivered long before the provider's terminal is
    // observed — and re-arming must not cost it a single extra cleanup budget.
    rig.clock.fireAll();
    const outcome = await rig.pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.finalText).toBe("answer");
  });

  test("a stream still delivering past the drain budget reports truncation", async () => {
    const stream = gatedStream();
    const rig = makeRig(
      makeClient({
        stream: stream.iterable,
        polls: [{ kind: "terminal", proof: completedProof("evt-budget") }],
      }),
      { maxDrainCycles: 2 },
    );
    await flush();

    // A delta in every window: the stream never goes quiet, so the budget is
    // what ends the attempt rather than the drain completing.
    for (let cycle = 0; cycle < 4; cycle += 1) {
      stream.emit({ kind: "delta", text: "chunk " });
      await flush();
      rig.clock.fireAll();
      await flush();
    }
    const outcome = await rig.pending;

    // NOT success. §4.2 line 191: content is never silently truncated — and a
    // terminal proof over an unfinished delivery is exactly that.
    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("truncated");
    // The proof stays attached as evidence, never as success — the same rule
    // the §197 conflict arm follows.
    expect(outcome.terminalProof?.eventId).toBe("evt-budget");
    expect(outcome.stderrTail).toContain("still delivering");
    // #126: the marker is a DELIBERATE classification signal, so it belongs on
    // the witness — and it carries no digit that could collide with a pattern.
    expect(outcome.stderrTail).not.toMatch(/\d/);
    expect(rig.transport.classifyFailure(outcome)).toBe("protocol_truncation");
  });

  test("a cancelled provider terminal keeps its verdict when the budget runs out", async () => {
    const stream = gatedStream();
    const rig = makeRig(
      makeClient({
        stream: stream.iterable,
        polls: [
          {
            kind: "terminal",
            proof: completedProof("evt-cancel", "cancelled"),
          },
        ],
      }),
      { maxDrainCycles: 1 },
    );
    await flush();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      stream.emit({ kind: "delta", text: "chunk " });
      await flush();
      rig.clock.fireAll();
      await flush();
    }
    const outcome = await rig.pending;

    // Truncation-as-failure exists because SUCCESS is the one verdict that
    // hides a short answer. A cancelled turn was never going to report success
    // and its answer is incomplete by definition, so the drain budget has
    // nothing to add — and flipping it to `failed` would hand
    // `protocol_truncation` a fresh transient attempt to re-run a turn
    // somebody cancelled provider-side.
    expect(outcome.completion).toBe("cancelled");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.stderrTail).not.toContain("still delivering");
    expect(rig.transport.classifyFailure(outcome)).toBeUndefined();
  });

  test("the window keeps its §197 purpose while it is re-armed", async () => {
    const stream = gatedStream();
    const rig = makeRig(
      makeClient({
        stream: stream.iterable,
        polls: [
          { kind: "terminal", proof: completedProof("evt-a", "completed") },
          { kind: "terminal", proof: completedProof("evt-b", "failed") },
        ],
      }),
    );
    await flush();

    // A delta extends the window; the conflicting terminal lands inside the
    // EXTENSION. Draining must not cost §197 the observation window it was
    // built for in the first place.
    stream.emit({ kind: "delta", text: "partial " });
    await flush();
    rig.clock.fireAll();
    await flush();
    rig.clock.fireAll();
    const outcome = await rig.pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("malformed");
    expect(outcome.stderrTail).toContain("conflicting provider terminal");
  });
});

describe("#132 the drain window is scoped to provider_terminal", () => {
  test("a poll-observed session failure still settles at once", async () => {
    const stream = gatedStream();
    const rig = makeRig(
      makeClient({
        stream: stream.iterable,
        polls: [{ kind: "failed", detail: "session exploded" }],
      }),
    );

    // No slot win, so no window to re-arm: `session_failed` settles on its own
    // and the attempt already carries its diagnosis. Emitting after the fact
    // must not resurrect a drain.
    const outcome: TransportOutcome = await rig.pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain("session exploded");
  });
});
