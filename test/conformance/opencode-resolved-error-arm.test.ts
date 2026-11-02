import { describe, expect, test } from "bun:test";
import type {
  AsyncEventSink,
  ProviderEvent,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  createOpenCodeClient,
  type OpenCodeSdkLike,
} from "../../src/transports/opencode-client";
import type { OpenCodeTransportClock } from "../../src/transports/opencode-sdk";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";
import { flush } from "../support/flush";

// The defect class PR #123 named and then only half-closed. Under the SDK's
// default `ThrowOnError = false` an API-level failure RESOLVES with
// `{ data: undefined, error }` — it never rejects. So `.catch()` never fires
// and `await` never throws, and every call whose result is discarded records
// a provider refusal as a success.
//
// Two calls were left that way after the surface fix: the fired-not-awaited
// `session.prompt` (the attempt sat armed waiting for a terminal a turn that
// never started could not produce, until the harness watchdog killed it) and
// `session.abort` (a refused abort was recorded as a confirmed one, so paid
// remote work could keep running with no diagnostic trail).

const SESSION_ID = "ses_error_arm";

// Every deadline the transport owns is fired by hand; nothing here sleeps a
// real one (PR #118: host-dependent waits are how this suite flaked before).
class ManualClock implements OpenCodeTransportClock {
  private pending: Array<() => void> = [];

  schedule(_ms: number, fn: () => void): () => void {
    this.pending.push(fn);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== fn);
    };
  }

  fireAll(): void {
    for (const fn of this.pending.splice(0)) fn();
  }
}

class RecordingSink implements AsyncEventSink {
  readonly events: ProviderEvent[] = [];

  async push(event: ProviderEvent): Promise<"accepted" | "closed"> {
    this.events.push(event);
    return "accepted";
  }

  close(): void {}
}

// Pre-fix both scenarios hang rather than fail, so every assertion here is
// raced against a bounded timer: a hang must read as a verdict, not as bun's
// generic 5 s timeout.
function withinWindow<T>(work: Promise<T>, hung: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(hung), 250);
    }),
  ]);
}

interface FakeSdk {
  sdk: OpenCodeSdkLike;
  abortCalls: () => number;
}

function fakeSdk(
  options: {
    promptError?: unknown;
    abortError?: unknown;
    // The subscription ends at once instead of staying open. Used where the
    // stream must not be the thing under test.
    emptyStream?: boolean;
    // The subscription dies instead of ending cleanly. The pump swallows the
    // error and ends the handoff exactly the same way, so this is the second
    // half of the race: both pump exits reach `finally`.
    streamError?: unknown;
    // Holds the prompt's resolved error arm open. Releasing it AFTER the pump
    // has already ended is what orders the race: the refusal lands on a
    // handoff whose only reader has already returned.
    promptGate?: Promise<void>;
    // Fails the one post-create step that can still throw, which is the only
    // way into createSession's unwind handler. The prompt is fired, never
    // awaited, so it can never reach that catch.
    subscribeError?: unknown;
  } = {},
): FakeSdk {
  let aborts = 0;
  const sdk: OpenCodeSdkLike = {
    createOpencodeClient: () => ({
      // #141: `GET /mcp`, the readback the client performs before prompting.
      // These rigs declare no registry, so the verified answer is "nothing
      // connected" — which is a declaration too, not an absence of one.
      mcp: { status: async () => ({ data: {} }) },
      permission: { reply: async () => ({ data: true }) },
      session: {
        create: async (opts) => ({
          data: {
            id: SESSION_ID,
            directory: (opts as { directory: string }).directory,
          },
        }),
        prompt: async () => {
          if (options.promptGate !== undefined) await options.promptGate;
          return options.promptError !== undefined
            ? { data: undefined, error: options.promptError }
            : { data: {} };
        },
        messages: async () => ({ data: [] }),
        // #127: a refused prompt never makes the session work, so it is never
        // listed by GET /session/status. The empty map is the honest shape,
        // and it is also what keeps this test on the failure path: absence
        // never having seen the session busy is not a boundary, so the poll
        // falls through to state.failure — the fact this file is about.
        status: async () => ({ data: {} }),
        abort: async () => {
          aborts += 1;
          return options.abortError !== undefined
            ? { data: undefined, error: options.abortError }
            : { data: true };
        },
      },
      // The tool surface is enumerated before the prompt is fired (#122), so
      // even a fake that is only here to refuse a prompt has to report one.
      // The ids are the real ones `client.tool.ids()` returns on opencode
      // 1.18.23 — a fake written in a namespace the provider does not use is
      // how the allow-map defect stayed green over 2818 tests.
      tool: {
        ids: async () => ({
          data: [
            "invalid",
            "question",
            "bash",
            "read",
            "glob",
            "grep",
            "edit",
            "write",
            "task",
            "webfetch",
            "todowrite",
            "websearch",
            "skill",
            "apply_patch",
          ],
        }),
      },
      event: {
        subscribe: async () => {
          if (options.subscribeError !== undefined)
            throw options.subscribeError;
          return {
            stream: {
              async *[Symbol.asyncIterator]() {
                // A refused prompt produces no events at all: no message is
                // created, so neither observer has anything to observe.
                if (options.streamError !== undefined) {
                  throw options.streamError;
                }
                if (options.emptyStream === true) return;
                await new Promise<never>(() => {});
              },
            },
          };
        },
      },
    }),
  };
  return { sdk, abortCalls: () => aborts };
}

function rigClient(fake: FakeSdk) {
  return createOpenCodeClient({
    loadSdk: async () => fake.sdk,
    launchServer: async () => ({
      url: "http://127.0.0.1:1",
      pid: 1,
      close: async () => {},
    }),
    model: { providerID: "openai", modelID: "test-model" },
    readSystemPrompt: async () => "SYSTEM",
  });
}

const INPUT = {
  cwd: "/tmp/work",
  userPrompt: "review this",
  systemPromptPath: "/tmp/system.md",
  tools: ["read"],
};

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

describe("a prompt the provider refuses", () => {
  // The prompt is FIRED, never awaited, and that shape is load-bearing:
  // session.prompt blocks until the turn finishes (the probe measured 4.5 s)
  // and the ROADMAP forbids completing an attempt from one blocking HTTP
  // call. What must change is that the RESOLVED error arm is observed — not
  // that the call becomes synchronous.
  test("reaches the stream consumer instead of vanishing", async () => {
    const fake = fakeSdk({ promptError: { message: "model not found" } });
    const client = rigClient(fake);
    const session = await client.createSession(INPUT);

    const drained = (async () => {
      for await (const _event of client.streamEvents(session)) {
        // A refused prompt yields nothing; only the failure may arrive.
      }
      return "the stream ended without surfacing the refusal";
    })().catch((error: unknown) => (error as Error).message);

    expect(
      await withinWindow(
        drained,
        "the stream hung: the refusal was never observed",
      ),
    ).toMatch(/session\.prompt failed.*model not found/s);
  });

  test("fails the attempt promptly, with the provider's own words", async () => {
    const fake = fakeSdk({ promptError: { message: "model not found" } });
    const clock = new ManualClock();
    const sink = new RecordingSink();
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fake),
      clock,
      cleanupMs: 20,
      pollIntervalMs: 10,
      pollRoundMs: 20,
    });

    const outcome = await withinWindow(
      transport.execute(makeRequest(), {
        signal: new AbortController().signal,
        events: sink,
      }),
      undefined,
    );

    // No watchdog, no stall deadline: the failure is decided by the refusal
    // itself, which an API-level rejection delivers at CALL time.
    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.completion).toBe("failed");
    // A transport-side observation is never a provider terminal proof.
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.terminalProof).toBeUndefined();
    expect(outcome.stderrTail).toContain("session.prompt failed");
    expect(outcome.stderrTail).toContain("model not found");
    // Best-effort release of a remote session that may exist even though the
    // turn never started.
    expect(fake.abortCalls()).toBeGreaterThan(0);
  });

  // §7 makes runtime_unavailable TERMINAL. A turn that never started is the
  // same class as a session that never opened: there is no model output to
  // reformat, so spending the format-reminder budget on it repeats issue
  // #121's mistake in a new place.
  test("classifies as runtime_unavailable, not a format violation", () => {
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fakeSdk()),
    });
    expect(
      transport.classifyFailure({
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: {
          wallMs: 1,
          tokens: {},
          completeness: "unavailable",
          billingMode: "subscription",
          costSource: "unknown",
        },
        stderrTail:
          "[pr-hero] opencode sdk: stream errored: opencode session.prompt failed: model not found",
      }),
    ).toBe("runtime_unavailable");
  });

  // ORDERING, not decoration — the same rule the session-creation witness
  // lives under. A refused prompt carries the provider's own text, and a 429
  // or a 401 in it is a retryable fact the last-resort witness must never
  // shadow.
  test("still yields to the network witness inside its own message", () => {
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fakeSdk()),
    });
    const base = {
      completion: "failed" as const,
      protocolIntegrity: "unverified" as const,
      finalText: "",
      usage: {
        wallMs: 1,
        tokens: {},
        completeness: "unavailable" as const,
        billingMode: "subscription" as const,
        costSource: "unknown" as const,
      },
    };
    expect(
      transport.classifyFailure({
        ...base,
        stderrTail:
          "[pr-hero] opencode sdk: stream errored: opencode session.prompt failed: 429 rate limit",
      }),
    ).toBe("rate_limit");
    expect(
      transport.classifyFailure({
        ...base,
        stderrTail:
          "[pr-hero] opencode sdk: stream errored: opencode session.prompt failed: 401 unauthorized",
      }),
    ).toBe("auth_invalid");
  });
});

// The race PR #123 left open. `state.failure` had exactly ONE reader —
// streamEvents — and the subscription pump ends the handoff on its own
// schedule, asynchronously from the fired-not-awaited prompt. When the pump
// wins that race, streamEvents drains, finds no failure, and returns
// permanently at `if (state.ended) return`; runStream reads that clean return
// as an ordinary EOF and settles nothing. Whatever the prompt's catch writes
// afterwards lands in a SessionState nobody will read again, and pollStatus —
// which asks session.messages(), and a refused prompt creates no message —
// answers "pending" forever. Both observers blind, and the attempt runs to the
// harness watchdog.
//
// §197 wants two INDEPENDENT observers of ONE fact. A failure only one of them
// can see is not two observers.
describe("a refused prompt whose stream ended first", () => {
  async function settleUnderRace(streamShape: {
    emptyStream?: boolean;
    streamError?: unknown;
  }): Promise<{
    outcome: Awaited<ReturnType<OpenCodeSdkTransport["execute"]>> | undefined;
    fake: FakeSdk;
  }> {
    let release!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeSdk({
      ...streamShape,
      promptGate,
      promptError: { message: "model not found" },
    });
    const clock = new ManualClock();
    const sink = new RecordingSink();
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fake),
      clock,
      cleanupMs: 20,
      pollIntervalMs: 10,
      pollRoundMs: 20,
    });

    const pending = transport.execute(makeRequest(), {
      signal: new AbortController().signal,
      events: sink,
    });
    // The pump reaches its end — and clears the handoff — before the refusal.
    await flush();
    release();
    await flush();
    // The poll observer's ordinary cadence, fired by hand. Neither a watchdog
    // nor the stall deadline is armed here; nothing else is pending.
    clock.fireAll();

    return { outcome: await withinWindow(pending, undefined), fake };
  }

  test("settles when the subscription EOFs before the refusal lands", async () => {
    const { outcome, fake } = await settleUnderRace({ emptyStream: true });

    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.completion).toBe("failed");
    // A transport-side observation is never a provider terminal proof.
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.terminalProof).toBeUndefined();
    expect(outcome.stderrTail).toContain("session.prompt failed");
    expect(outcome.stderrTail).toContain("model not found");
    // Same best-effort release the stream path already performs.
    expect(fake.abortCalls()).toBeGreaterThan(0);
  });

  test("settles when the subscription dies before the refusal lands", async () => {
    const { outcome, fake } = await settleUnderRace({
      streamError: new Error("subscription died"),
    });

    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.terminalProof).toBeUndefined();
    expect(outcome.stderrTail).toContain("session.prompt failed");
    expect(outcome.stderrTail).toContain("model not found");
    expect(fake.abortCalls()).toBeGreaterThan(0);
  });

  test("is visible to the poll observer once the stream has gone", async () => {
    let release!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeSdk({
      emptyStream: true,
      promptGate,
      promptError: { message: "model not found" },
    });
    const client = rigClient(fake);
    const session = await client.createSession(INPUT);

    // The handoff's only reader returns on the EOF the pump already delivered.
    for await (const _event of client.streamEvents(session)) {
      throw new Error("a refused prompt yields no events");
    }
    release();
    await flush();

    expect(await client.pollStatus(session)).toEqual({
      kind: "failed",
      detail: "opencode session.prompt failed: model not found",
    });
  });

  // The note is substring-matched by classifyFailure, so the poll path's own
  // wording has to keep carrying the provider's text through to the witness.
  test("classifies as runtime_unavailable through the poll note too", () => {
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fakeSdk()),
    });
    expect(
      transport.classifyFailure({
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: {
          wallMs: 1,
          tokens: {},
          completeness: "unavailable",
          billingMode: "subscription",
          costSource: "unknown",
        },
        stderrTail:
          "[pr-hero] opencode sdk: poll observed a session failure: opencode session.prompt failed: model not found",
      }),
    ).toBe("runtime_unavailable");
  });
});

describe("an abort the provider refuses", () => {
  // §5.2/§290: abort is best-effort and runs while the attempt is unwinding,
  // so it must stay non-fatal. Best-effort means OBSERVED, not silent: a
  // refused abort leaves remote work running — and billing — and the note is
  // the only trail that says so.
  test("is recorded as a failure instead of a confirmed abort", async () => {
    const fake = fakeSdk({
      abortError: { message: "session already gone" },
      emptyStream: true,
    });
    const clock = new ManualClock();
    const sink = new RecordingSink();
    const controller = new AbortController();
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fake),
      clock,
      abortConfirmMs: 500,
      cleanupMs: 20,
      pollIntervalMs: 10,
      pollRoundMs: 20,
    });

    const pending = transport.execute(makeRequest(), {
      signal: controller.signal,
      events: sink,
    });
    await flush();
    controller.abort();
    // The note rides `void callAbortOnce()`; firing the confirmation deadline
    // before it lands would assemble the notes without it.
    await flush();
    clock.fireAll();

    const outcome = await withinWindow(pending, undefined);
    if (outcome === undefined) throw new Error("the attempt never settled");
    // Still non-fatal: the teardown path completed and returned an outcome.
    expect(outcome.completion).toBe("cancelled");
    expect(fake.abortCalls()).toBe(1);
    expect(outcome.stderrTail).toContain("abort call failed");
    expect(outcome.stderrTail).toContain("session already gone");
  });

  // The third site of the same class, left un-fixed by PR #123:
  // createSession's unwind still discards the abort with `.catch(() => {})`,
  // which an API-level refusal never reaches because it RESOLVES. The unwind
  // has no notes channel — the propagated error IS the channel, because the
  // transport stamps it into stderrTail as "session creation failed: …".
  test("leaves a trail when it is refused during createSession's unwind", async () => {
    const fake = fakeSdk({
      subscribeError: new Error("event.subscribe exploded"),
      abortError: { message: "session already gone" },
    });
    const client = rigClient(fake);

    const failure = await client.createSession(INPUT).then(
      () => new Error("createSession resolved instead of unwinding"),
      (error: unknown) => error as Error,
    );

    // The failure that CAUSED the unwind still propagates; the refused abort
    // is recorded beside it, never over it.
    expect(failure.message).toContain("event.subscribe exploded");
    expect(failure.message).toContain("session.abort failed");
    expect(failure.message).toContain("session already gone");
    // The remote session that was created is still released best-effort, once.
    expect(fake.abortCalls()).toBe(1);
  });
});
