import { describe, expect, test } from "bun:test";
import type {
  AsyncEventSink,
  ProviderEvent,
  ProviderTerminalProof,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import { classifyFailure as classifyLegacyFailure } from "../../src/execution/failure-classification";
import type { NormalizedUsage } from "../../src/execution/usage-normalized";
import type {
  OpenCodeClientEvent,
  OpenCodeClientLike,
  OpenCodePollResult,
  OpenCodeTransportClock,
} from "../../src/transports/opencode-sdk";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";
import { flush } from "../support/flush";

// Issue #126: `stderrTail` is the classification WITNESS — its declared
// meaning is "what the provider said". The transport already excludes
// finalText from it because model prose names the very failure modes the
// patterns match. Our own diagnostic COUNTS are the same hazard from the
// other direction, and it was measured, not guessed, against both readers:
//
//   note                     count   transport classifyFailure   legacy classifyFailure
//   sink closed early          429   rate_limit                  format
//   sink closed early          502   network_transient           transient
//   poll round(s) timed out    ANY   -                           transient  <- prose, not the count
//   poll confirmed ...         429   rate_limit                  format
//   invalid terminal proof(s)  529   -                           transient
//   invalid terminal proof(s) 1502   -                           transient  <- legacy has no \b
//
// Two readers, not one: `resolveFailureCause` (failure-policy.ts) falls back
// to the legacy `classifyFailure` over the SAME stderrTail when the transport
// returns undefined, and the legacy patterns are unanchored. The prose row is
// the worst of them: "poll round(s) timed out" contains "timed out", so it is
// deterministic at every count rather than a rare numeric collision.
//
// The rule these tests pin is class-level, not instance-level, and the line it
// draws is NOT "ours vs the provider's":
//
//   STAYS in stderrTail — the deliberate classification markers
//   (MARKER_STALL, MARKER_REASONING_ONLY, the abort notes, the reasoning
//   note). They are our words too, and classifyFailure substring-matches them
//   ON PURPOSE; moving them off the witness would silently delete the
//   transport's whole marker-based mapping. Provider-verbatim text
//   (session_failed detail, stream errors) stays for the same reason.
//
//   MOVES to diagnosticsTail — free-form observation records: counts,
//   tallies, and any interpolated text that is neither a declared marker nor
//   the provider's own words.
//
// The hazard is text nobody meant as a classification signal being read as
// one. A marker is meant as one.

class ManualClock implements OpenCodeTransportClock {
  private pending: Array<{ fn: () => void }> = [];

  schedule(_ms: number, fn: () => void): () => void {
    const entry = { fn };
    this.pending.push(entry);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== entry);
    };
  }

  fireAll(): void {
    const fns = this.pending.splice(0).map((entry) => entry.fn);
    for (const fn of fns) fn();
  }
}

async function advance(clock: ManualClock, passes: number): Promise<void> {
  for (let i = 0; i < passes; i += 1) {
    clock.fireAll();
    await flush();
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

function makeClient(options: {
  stream?: AsyncIterable<OpenCodeClientEvent>;
  polls?: Array<OpenCodePollResult>;
  hangRounds?: number[];
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
    pollStatus: async (_session, signal) => {
      const index = round;
      round += 1;
      if (options.hangRounds?.includes(index)) {
        // A timed-out cooperative request releases its slot on abort. A
        // permanently uncooperative request must NOT admit another poll (U3).
        return new Promise<OpenCodePollResult>((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("poll aborted")),
            { once: true },
          );
        });
      }
      return options.polls?.[index] ?? ({ kind: "pending" } as const);
    },
    abort: async () => {},
  };
}

function streamOf(
  events: OpenCodeClientEvent[],
): AsyncIterable<OpenCodeClientEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function makeRig(client: OpenCodeClientLike) {
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
  });
  return { clock, sink, controller, transport };
}

async function runRig(
  rig: ReturnType<typeof makeRig>,
  passes = 6,
): Promise<TransportOutcome> {
  const pending = rig.transport.execute(makeRequest(), {
    signal: rig.controller.signal,
    events: rig.sink,
  });
  await advance(rig.clock, passes);
  return pending;
}

// A witness carrying no digits at all cannot collide with `\b429\b`,
// `\b(?:502|503|504)\b`, or the legacy unanchored `502|503|529` — whatever
// counts the run happened to produce. Every scenario below is scripted with a
// provider that says nothing textual, so any digit in the witness is ours.
function expectDigitFreeWitness(outcome: TransportOutcome): void {
  expect(outcome.stderrTail).not.toMatch(/\d/);
}

describe("#126 transport diagnostics never reach the classification witness", () => {
  test("a timed-out poll round is counted on diagnosticsTail, not the witness", async () => {
    const rig = makeRig(
      makeClient({
        polls: [
          { kind: "pending" },
          { kind: "terminal", proof: completedProof("evt-after-timeout") },
        ],
        hangRounds: [0],
      }),
    );
    const outcome = await runRig(rig);

    expect(outcome.completion).toBe("success");
    expect(outcome.diagnosticsTail).toContain("poll round(s) timed out");
    expect(outcome.stderrTail).not.toContain("poll round(s) timed out");
    expectDigitFreeWitness(outcome);
  });

  test("the poll-timeout note no longer puts 'timed out' in the legacy witness", async () => {
    const rig = makeRig(
      makeClient({
        polls: [
          { kind: "pending" },
          { kind: "terminal", proof: completedProof("evt-after-timeout") },
        ],
        hangRounds: [0],
      }),
    );
    const outcome = await runRig(rig);

    // The prose leak, not the numeric one: `timed out` is a legacy transient
    // pattern, so this note used to classify EVERY attempt carrying it as
    // transient regardless of the count.
    expect(outcome.stderrTail).not.toMatch(/timed out/i);
    expect(
      classifyLegacyFailure({
        stderrTail: outcome.stderrTail,
        resultText: "",
        timedOut: false,
      }),
    ).not.toBe("transient");
  });

  test("a poll confirmation is counted on diagnosticsTail, not the witness", async () => {
    const proof = completedProof("evt-confirmed");
    const rig = makeRig(
      makeClient({
        stream: streamOf([{ kind: "terminal", proof }]),
        polls: [{ kind: "terminal", proof }],
      }),
    );
    const outcome = await runRig(rig);

    expect(outcome.completion).toBe("success");
    expect(outcome.diagnosticsTail).toContain("poll confirmed the winning");
    expect(outcome.stderrTail).not.toContain("poll confirmed the winning");
    expectDigitFreeWitness(outcome);
  });

  test("an ignored invalid proof is counted on diagnosticsTail, not the witness", async () => {
    const invalid: ProviderTerminalProof = {
      eventId: "",
      providerStatus: "completed",
      providerObservedAt: "2026-08-26T00:00:00.000Z",
    };
    const rig = makeRig(
      makeClient({
        polls: [
          { kind: "terminal", proof: invalid },
          { kind: "terminal", proof: completedProof("evt-valid") },
        ],
      }),
    );
    const outcome = await runRig(rig);

    expect(outcome.completion).toBe("success");
    expect(outcome.diagnosticsTail).toContain("invalid terminal proof");
    expect(outcome.stderrTail).not.toContain("invalid terminal proof");
    expectDigitFreeWitness(outcome);
  });

  test("undelivered data-plane events are counted on diagnosticsTail, not the witness", async () => {
    const proof = completedProof("evt-after-close");
    const rig = makeRig(
      makeClient({
        stream: streamOf([
          { kind: "delta", text: "answer" },
          { kind: "terminal", proof },
        ]),
      }),
    );
    rig.sink.closed = true;
    const outcome = await runRig(rig);

    expect(outcome.diagnosticsTail).toContain("sink closed early");
    expect(outcome.stderrTail).not.toContain("sink closed early");
    expectDigitFreeWitness(outcome);
  });
});

const USAGE: NormalizedUsage = {
  wallMs: 1,
  tokens: {},
  completeness: "unavailable",
  billingMode: "subscription",
  costSource: "unknown",
};

describe("#126 classifyFailure reads the witness alone", () => {
  const baseOutcome = (
    overrides: Partial<TransportOutcome>,
  ): TransportOutcome => ({
    completion: "failed",
    protocolIntegrity: "unverified",
    finalText: "",
    usage: USAGE,
    stderrTail: "",
    diagnosticsTail: "",
    ...overrides,
  });

  test("a hostile diagnosticsTail cannot decide the cause", () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}),
    });

    // Every pattern the two classifiers look for, on the channel that is not
    // the witness. If diagnosticsTail were ever read, this would classify.
    const hostile =
      "[pr-hero] opencode sdk: 429 poll round(s) timed out; 503 invalid terminal proof(s) ignored; unauthorized; ECONNRESET";

    expect(
      transport.classifyFailure(baseOutcome({ diagnosticsTail: hostile })),
    ).toBeUndefined();
  });

  test("the provider's own words still decide the cause", () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}),
    });

    expect(
      transport.classifyFailure(
        baseOutcome({
          stderrTail:
            "[pr-hero] opencode sdk: session creation failed: 429 rate limit",
          diagnosticsTail: "[pr-hero] opencode sdk: 4 poll round(s) timed out",
        }),
      ),
    ).toBe("rate_limit");
  });
});
