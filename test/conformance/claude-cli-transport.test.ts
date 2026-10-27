import { describe, expect, test } from "bun:test";
import type { TransportRequest } from "../../src/execution/contracts";
import {
  decideRetryDisposition,
  resolveFailureCause,
} from "../../src/execution/failure-policy";
import { ACTIVE_CHILD_PROCS } from "../../src/execution/spawned-process";
import { settlementFromUsage } from "../../src/execution/spend-limiter";
import {
  outputTokensKnown,
  sumNormalizedUsage,
} from "../../src/execution/usage-normalized";
import type { ClaudeCodeCliTransportOptions } from "../../src/transports/claude-code-cli";
import { ClaudeCodeCliTransport } from "../../src/transports/claude-code-cli";

const PID = 424242;

// §6.3 pre-spawn verification stubs: an existing 0600 regular file whose
// hash matches makeRequest's systemPromptSha256.
const okPromptFns: Pick<
  ClaudeCodeCliTransportOptions,
  "promptLstatFn" | "promptHashFn"
> = {
  promptLstatFn: () => ({ mode: 0o100600, isSymbolicLink: false }),
  promptHashFn: () => "deadbeef",
};

interface RecordedSignal {
  pid: number;
  signal?: string | number;
  at: number;
}

function makeRequest(
  overrides: Partial<TransportRequest> = {},
): TransportRequest {
  return {
    sessionId: "sess-1",
    attempt: 1,
    route: {
      backend: "claude-code",
      provider: "anthropic",
      modelFamily: "claude",
      modelSnapshot: "claude-test-model",
    },
    executionModel: "claude-test-model",
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

interface FakeHandle {
  proc: Record<string, unknown> & {
    pid: number;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(): void;
  };
  finish: (exitCode: number) => void;
  procKillCount: () => number;
}

function makeFakeProc(options: {
  pid?: number;
  stdoutBody?: string;
  exitCode?: number;
}): FakeHandle {
  const pid = options.pid ?? PID;
  let releaseExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    releaseExit = resolve;
    if (options.exitCode !== undefined) resolve(options.exitCode);
  });
  let killCount = 0;
  const encoder = new TextEncoder();
  const body = options.stdoutBody ?? "";
  const streamFor = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await exited;
        if (body.length > 0) controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });

  return {
    proc: {
      pid,
      stdout: streamFor(),
      stderr: streamFor(),
      exited,
      kill() {
        killCount += 1;
      },
    },
    finish: releaseExit,
    procKillCount: () => killCount,
  };
}

describe("ClaudeCodeCliTransport §5.2 cancellation and terminal proof", () => {
  test("PGID proof failure fails execution before launch with no signal sent", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({});
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      // pgid differs from pid: the child is NOT a group leader
      getPgid: (pid) => pid - 1,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
      },
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain("PGID proof failed");
    expect(signals).toHaveLength(0);
    expect(fake.procKillCount()).toBe(0);
    expect(ACTIVE_CHILD_PROCS.has(fake.proc as never)).toBe(false);

    expect(outcome.terminalProof).toBeUndefined();
  });

  test("spawn requests a detached child (own process group)", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "ok" }),
      exitCode: 0,
    });
    let spawnOptions: Record<string, unknown> | undefined;
    const spawnFn = ((_args: string[], opts: Record<string, unknown>) => {
      spawnOptions = opts;
      return fake.proc;
    }) as unknown as typeof Bun.spawn;
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn,
      getPgid: (pid) => pid,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
      },
    });

    await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(spawnOptions?.detached).toBe(true);
    expect(signals).toHaveLength(0);
  });

  test("direct routes pass executionModel (alias) to --model, not route snapshot", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "ok" }),
      exitCode: 0,
    });
    let spawnArgs: string[] | undefined;
    const spawnFn = ((args: string[]) => {
      spawnArgs = args;
      return fake.proc;
    }) as unknown as typeof Bun.spawn;
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn,
      getPgid: (pid) => pid,
    });

    await transport.execute(
      makeRequest({
        executionModel: "sonnet",
        route: {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "sonnet",
          modelSnapshot: "sonnet",
        },
      }),
      { signal: new AbortController().signal },
    );

    const modelIndex = spawnArgs?.indexOf("--model") ?? -1;
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(spawnArgs?.[modelIndex + 1]).toBe("sonnet");
  });

  // The engine owns the effort and ALWAYS passes it (#299). The CLI's implicit
  // default is `high` except on the 5.5 family, where it is `medium`, so an
  // omitted flag silently changed what a step ran at when the `sonnet` alias
  // moved. Every level is asserted, because the flag's value is the whole
  // contract and a hard-coded one would pass a single-level test.
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    test(`passes --effort ${effort} straight from the request`, async () => {
      const fake = makeFakeProc({
        stdoutBody: JSON.stringify({ result: "ok" }),
        exitCode: 0,
      });
      let spawnArgs: string[] | undefined;
      const transport = new ClaudeCodeCliTransport({
        ...okPromptFns,
        spawnFn: ((args: string[]) => {
          spawnArgs = args;
          return fake.proc;
        }) as unknown as typeof Bun.spawn,
        getPgid: (pid) => pid,
      });

      await transport.execute(makeRequest({ effort }), {
        signal: new AbortController().signal,
      });

      const at = spawnArgs?.indexOf("--effort") ?? -1;
      expect(at).toBeGreaterThanOrEqual(0);
      expect(spawnArgs?.[at + 1]).toBe(effort);
      // Exactly once: a second occurrence would let the CLI pick whichever
      // wins its own precedence, which is the ambiguity this flag removes.
      expect(spawnArgs?.filter((a) => a === "--effort")).toHaveLength(1);
    });
  }

  // A missing effort is a programming error, never a fallback: a transport that
  // quietly omitted the flag would reinstate the CLI's implicit default, which
  // is the defect. It must also fail BEFORE a paid spawn.
  for (const [label, effort] of [
    ["a missing", undefined],
    ["an unrecognized", "turbo"],
  ] as const) {
    test(`${label} effort throws before any spawn`, async () => {
      let spawned = 0;
      const transport = new ClaudeCodeCliTransport({
        ...okPromptFns,
        spawnFn: (() => {
          spawned += 1;
          return makeFakeProc({ exitCode: 0 }).proc;
        }) as unknown as typeof Bun.spawn,
        getPgid: (pid) => pid,
      });

      await expect(
        transport.execute(
          makeRequest({ effort } as unknown as Partial<TransportRequest>),
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(/effort/);
      expect(spawned).toBe(0);
    });
  }

  test("abort sends SIGTERM to negative pgid first; group exiting during grace receives no SIGKILL", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({});
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      termGraceMs: 50,
      killReapMs: 500,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
        if (signal === "SIGTERM") {
          exitTimer = setTimeout(() => fake.finish(143), 5);
        }
      },
    });

    const controller = new AbortController();
    const pending = transport.execute(makeRequest(), {
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await pending;
    if (exitTimer) clearTimeout(exitTimer);

    expect(outcome.completion).toBe("cancelled");
    expect(signals.map((s) => [s.pid, s.signal])).toEqual([[-PID, "SIGTERM"]]);
    expect(fake.procKillCount()).toBe(1);
    expect(outcome.terminalProof).toBeDefined();
    expect(outcome.exitCode).toBe(143);
  });

  test("group ignoring SIGTERM is escalated to SIGKILL after the injected grace", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({});
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      termGraceMs: 60,
      killReapMs: 500,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
        if (signal === "SIGKILL") fake.finish(137);
      },
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const startedAt = Date.now();
    const outcome = await transport.execute(makeRequest(), {
      signal: controller.signal,
    });
    const elapsed = Date.now() - startedAt;

    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.completion).toBe("cancelled");
    expect(signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(signals.every((s) => s.pid === -PID)).toBe(true);
    const graceObserved = signals[1].at - signals[0].at;
    expect(graceObserved).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(2000);
    expect(outcome.terminalProof?.signal).toBe("SIGKILL");
    expect(outcome.terminalProof?.providerStatus).toBe("failed");
    expect(outcome.exitCode).toBe(137);
  });

  test("group surviving SIGKILL yields a bounded reap wait with a recorded warning", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({});
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      termGraceMs: 20,
      killReapMs: 40,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
      },
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const startedAt = Date.now();
    const outcome = await transport.execute(makeRequest(), {
      signal: controller.signal,
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1000);
    expect(signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(signals.every((s) => s.pid === -PID)).toBe(true);
    expect(outcome.completion).toBe("cancelled");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain("not reaped");
    expect(outcome.terminalProof).toBeUndefined();
    expect(ACTIVE_CHILD_PROCS.has(fake.proc as never)).toBe(false);
  });

  test("success carries terminal proof; failure exit maps to failed provider status", async () => {
    const successFake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "all good" }),
      exitCode: 0,
    });
    const successSignals: RecordedSignal[] = [];
    const successTransport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => successFake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: (pid, signal) => {
        successSignals.push({ pid, signal, at: Date.now() });
      },
    });

    const success = await successTransport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(success.completion).toBe("success");
    expect(success.protocolIntegrity).toBe("verified");
    const proof = success.terminalProof;
    if (!proof) throw new Error("success without terminal proof");
    expect(proof.eventId).toBe("sess-1-1-terminal");
    expect(proof.providerStatus).toBe("completed");
    expect(proof.exitCode).toBe(0);
    expect(proof.providerObservedAt).toEqual(
      new Date(proof.providerObservedAt).toISOString(),
    );

    const failureFake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "" }),
      exitCode: 1,
    });
    const failureTransport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => failureFake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const failure = await failureTransport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(failure.completion).toBe("failed");
    expect(failure.terminalProof?.providerStatus).toBe("failed");
    expect(failure.terminalProof?.exitCode).toBe(1);
    expect(successSignals).toHaveLength(0);
  });
});

// D1-08 PR2 (§8): TransportOutcome.usage is NormalizedUsage now. Corrupted
// stdout must never fabricate a zero-cost leaf — the exact "$0 on parse
// failure" collapse this slice exists to kill, just moved one layer down.
// Cache-read and cache-write are Anthropic's own disjoint additive fields
// (input_tokens/cache_read_input_tokens/cache_creation_input_tokens sum to
// total input; they are not a total-minus-subset split), so the transport
// must carry them straight into their own NormalizedTokens leaves.
describe("ClaudeCodeCliTransport usage normalization (D1-08 PR2)", () => {
  test('corrupted stdout yields completeness "unavailable", never a zero-cost leaf', async () => {
    const fake = makeFakeProc({
      stdoutBody: "this is not json at all {{{",
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.usage.completeness).toBe("unavailable");
    expect(outcome.usage.tokens).toEqual({});
    expect(outcome.usage.cashCostUsd).toBeUndefined();
  });

  test("valid JSON with no usage block at all is also unavailable, not a fabricated zero", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "reviewed" }),
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.usage.completeness).toBe("unavailable");
    expect(outcome.usage.tokens.inputUncached).toBeUndefined();
  });

  // #175 half 2, 2026-09-02. The CLI already reports WHICH models ran, in a
  // `modelUsage` block keyed on the exact snapshot; the engine used to
  // discard it and assert a snapshot of its own instead. Verified live
  // against the real CLI on 2026-09-02, including the two-model shape below.
  test("modelUsage is recorded as the models actually observed, in report order", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({
        result: "reviewed",
        modelUsage: {
          // TWO models for ONE `--model sonnet` invocation: the CLI runs
          // haiku for its own internal work. This is why the field is a
          // LIST -- a scalar "the model that ran" is not a fact about this
          // provider, and the requested model is not guaranteed to be in it.
          "claude-haiku-4-5-20251001": {
            inputTokens: 899,
            outputTokens: 9,
            costUSD: 0.000944,
            canonicalModel: "claude-haiku-4-5",
            provider: "firstParty",
            costBasis: "list",
          },
          "claude-sonnet-5-20260115": {
            inputTokens: 4210,
            outputTokens: 812,
            costUSD: 0.0142,
            canonicalModel: "claude-sonnet-5",
            provider: "firstParty",
            costBasis: "list",
          },
        },
      }),
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.observedModels).toEqual([
      {
        model: "claude-haiku-4-5-20251001",
        canonicalModel: "claude-haiku-4-5",
      },
      { model: "claude-sonnet-5-20260115", canonicalModel: "claude-sonnet-5" },
    ]);
  });

  test("a modelUsage entry with no canonicalModel records the snapshot alone", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({
        result: "reviewed",
        modelUsage: { "some-future-model": { inputTokens: 1 } },
      }),
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.observedModels).toEqual([{ model: "some-future-model" }]);
  });

  test("a non-string canonicalModel is dropped, never coerced into a name", async () => {
    // `String({})` is "[object Object]", which would land in a provenance
    // record reading exactly like a model name. The snapshot key survives
    // because it IS a string by construction; only the reported family is
    // discarded.
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({
        result: "reviewed",
        modelUsage: {
          "claude-sonnet-5-20260115": { canonicalModel: { oops: true } },
          "claude-haiku-4-5-20251001": { canonicalModel: "" },
        },
      }),
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.observedModels).toEqual([
      { model: "claude-sonnet-5-20260115" },
      { model: "claude-haiku-4-5-20251001" },
    ]);
  });

  test("no modelUsage block is absence, not an empty observation", async () => {
    // Absence over fabrication, the same rule `normalizeUnavailableUsage`
    // follows one field over: `[]` would read as "we looked and nothing ran",
    // which is a claim. `undefined` says we were told nothing.
    for (const body of [
      JSON.stringify({ result: "reviewed" }),
      JSON.stringify({ result: "reviewed", modelUsage: {} }),
      "this is not json at all {{{",
    ]) {
      const fake = makeFakeProc({ stdoutBody: body, exitCode: 0 });
      const transport = new ClaudeCodeCliTransport({
        ...okPromptFns,
        spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
        getPgid: (pid) => pid,
        killFn: () => {},
      });

      const outcome = await transport.execute(makeRequest(), {
        signal: new AbortController().signal,
      });

      expect(outcome.observedModels).toBeUndefined();
    }
  });

  test("cache-read and cache-write land in distinct disjoint leaves, apart from uncached input", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({
        result: "reviewed",
        total_cost_usd: 0.042,
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 300,
          output_tokens: 45,
        },
      }),
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.usage.completeness).toBe("complete");
    expect(outcome.usage.tokens.inputUncached).toBe(120);
    expect(outcome.usage.tokens.inputCacheRead).toBe(900);
    expect(outcome.usage.tokens.inputCacheWrite).toBe(300);
    expect(outcome.usage.tokens.inputCacheRead).not.toBe(
      outcome.usage.tokens.inputUncached,
    );
    expect(outcome.usage.tokens.outputVisible).toBe(45);
    // #173: `total_cost_usd` is LIST basis, so it is notional, never cash.
    // The cost half of this record is owned by the #173 describe below.
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outcome.usage.notionalCostUsd).toBe(0.042);
  });

  test("a usage block missing any token leaf is partial, never complete with fabricated zeros", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({
        result: "reviewed",
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 900,
          output_tokens: 45,
        },
      }),
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.usage.completeness).toBe("partial");
    expect(outcome.usage.tokens.providerReportedTotal).toBe(1065);
    expect(outcome.usage.tokens.inputUncached).toBeUndefined();
    expect(outcome.usage.tokens.inputKnown).toBeUndefined();
  });
});

// #173, 2026-09-02. The CLI's `total_cost_usd` is the sum of its per-model
// `costUSD` values, and the live probe on 2026-09-02 showed every one of them
// carries `"costBasis": "list"` — what the tokens WOULD have cost through the
// API. This transport's route is a Claude subscription by construction
// (`credentialKindForRoute` returns `claude_subscription_oauth` for the
// claude-code backend unconditionally), so nothing is charged and the design's
// §8 rule applies: "Subscription OAuth may truthfully report `cashCostUsd: 0`;
// optional catalog cost is `notionalCostUsd` and never mixed with cash."
//
// Both halves are asserted on every arm, because either one alone passes
// against a broken implementation: cash-only would pass a transport that
// dropped the figure entirely, and notional-only would pass one that filed it
// in BOTH fields.
describe("ClaudeCodeCliTransport cash vs notional cost (#173)", () => {
  async function runWith(stdoutBody: string) {
    const fake = makeFakeProc({ stdoutBody, exitCode: 0 });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });
    return transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });
  }

  test("a complete attempt files the list figure as notional and reports zero cash", async () => {
    const outcome = await runWith(
      JSON.stringify({
        result: "reviewed",
        total_cost_usd: 0.0455,
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 18534,
          cache_creation_input_tokens: 10213,
          output_tokens: 4,
        },
      }),
    );

    expect(outcome.usage.completeness).toBe("complete");
    expect(outcome.usage.billingMode).toBe("subscription");
    expect(outcome.usage.costSource).toBe("subscription");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outcome.usage.notionalCostUsd).toBe(0.0455);
  });

  test("a partial attempt files the list figure as notional and reports zero cash", async () => {
    const outcome = await runWith(
      JSON.stringify({
        result: "reviewed",
        total_cost_usd: 0.0455,
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 900,
          output_tokens: 45,
        },
      }),
    );

    expect(outcome.usage.completeness).toBe("partial");
    expect(outcome.usage.billingMode).toBe("subscription");
    expect(outcome.usage.costSource).toBe("subscription");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outcome.usage.notionalCostUsd).toBe(0.0455);
  });

  // Absence over fabrication, on the notional side only: a CLI that reported
  // no `total_cost_usd` gives us no list figure to record, and inventing 0 for
  // it would claim the run consumed nothing. Cash is a different fact — it is
  // 0 because the subscription charges nothing, whatever the CLI said.
  test("an absent total_cost_usd leaves notional undefined while cash stays a truthful zero", async () => {
    const outcome = await runWith(
      JSON.stringify({
        result: "reviewed",
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 300,
          output_tokens: 45,
        },
      }),
    );

    expect(outcome.usage.completeness).toBe("complete");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outcome.usage.notionalCostUsd).toBeUndefined();
  });

  // A pre-spawn denial contacted no provider, so `costSource: "provider"` was
  // never true there. It has to agree with the parse arms for a second reason:
  // an unclassified failure legacy-classifies as "format", which HAS a retry,
  // so a denied attempt 1 can be summed with a spawned attempt 2 — and
  // `sumNormalizedUsage` collapses costSource to "unknown" when the two
  // attempts disagree.
  test("a pre-spawn denial reports the same subscription cost basis as a spawned attempt", async () => {
    const fake = makeFakeProc({ stdoutBody: "", exitCode: 0 });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      promptLstatFn: () => ({ mode: 0o100600, isSymbolicLink: true }),
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.stderrTail).toContain("prompt integrity denied");
    expect(outcome.usage.billingMode).toBe("subscription");
    expect(outcome.usage.costSource).toBe("subscription");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outcome.usage.notionalCostUsd).toBeUndefined();
  });

  // The ripple this change could have caused, proven against the transport's
  // OWN output rather than a hand-built record. #172 added a metered-zero rule
  // to `settlementFromUsage`: a metered attempt reporting $0 having produced
  // output tokens is unresolved, not settled. Every claude-code attempt now
  // reports exactly $0 cash WITH output tokens, so if that rule keyed on the
  // number instead of the billing mode, every subscription review would fence
  // its own bucket and refuse the next step. It keys on the mode.
  //
  // `test/harness/spend-limiter.test.ts` already asserts the pure rule on a
  // hand-built subscription record; this arm proves the WIRING — that what the
  // transport actually emits lands on the settling side of it.
  test("a subscription attempt reporting zero cash still settles, and does not trip the metered-zero rule", async () => {
    const outcome = await runWith(
      JSON.stringify({
        result: "reviewed",
        total_cost_usd: 0.0455,
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 18534,
          cache_creation_input_tokens: 10213,
          output_tokens: 4,
        },
      }),
    );

    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outputTokensKnown(outcome.usage.tokens)).toBeGreaterThan(0);
    expect(settlementFromUsage(outcome.usage)).toEqual({
      kind: "settle",
      actualUsd: 0,
    });
  });

  // The negative that makes the assertion above discriminate: the same $0 with
  // the same output tokens under a METERED mode is unresolved. Without this,
  // a rule that simply settled every zero would pass the arm above.
  test("the same zero under a metered billing mode is unresolved, not settled", async () => {
    const outcome = await runWith(
      JSON.stringify({
        result: "reviewed",
        total_cost_usd: 0.0455,
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 18534,
          cache_creation_input_tokens: 10213,
          output_tokens: 4,
        },
      }),
    );

    expect(
      settlementFromUsage({ ...outcome.usage, billingMode: "metered" }),
    ).toEqual({ kind: "unresolved", knownUsd: undefined });
  });
});

// #177, 2026-09-02. #173's rule is right for the credential it assumed and
// wrong for the one it did not check. A user running with ANTHROPIC_API_KEY
// (or ANTHROPIC_AUTH_TOKEN) pays real per-token money, and filing that spend
// as `notionalCostUsd` renders it "at list price, not charged" while
// budget enforcement — cash-only by design §8 — sees a $0 ceiling. That is the
// under-reporting direction this codebase repeatedly names as the worst to be
// wrong in, so the CLI's figure goes back to `cashCostUsd` whenever the env
// this transport SPAWNS THE CHILD WITH carries a metered credential.
//
// The signal is `request.isolation.env` and not `process.env`: that record is
// what `projectChildEnv` (harness.ts) built for this exact child, so it is the
// env the CLI actually bills under, and it keeps the transport free of any
// ambient environment read. Every arm below supplies it explicitly — a test
// whose verdict depended on the developer's own shell is the #174 defect.
describe("ClaudeCodeCliTransport metered-credential cost filing (#177)", () => {
  const COMPLETE_STDOUT = JSON.stringify({
    result: "reviewed",
    total_cost_usd: 0.0455,
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: 18534,
      cache_creation_input_tokens: 10213,
      output_tokens: 4,
    },
  });

  function transportFor(stdoutBody: string) {
    const fake = makeFakeProc({ stdoutBody, exitCode: 0 });
    return new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });
  }

  async function runUnder(env: Record<string, string>, stdoutBody: string) {
    return transportFor(stdoutBody).execute(
      makeRequest({
        isolation: {
          credentialProjectionId: "proj-1",
          env,
          syntheticHome: "/tmp/pr-hero-test/home",
          syntheticConfigHome: "/tmp/pr-hero-test/config",
          syntheticTmp: "/tmp/pr-hero-test/tmp",
          verifiedBinaryPath: "/usr/bin/true",
        },
      }),
      { signal: new AbortController().signal },
    );
  }

  // Both halves on every arm, for #173's own reason: cash-only would pass a
  // transport that filed the figure in BOTH fields, and notional-only would
  // pass one that dropped it.
  test("an API-key run books the CLI figure as CASH, with no notional companion", async () => {
    const outcome = await runUnder(
      { ANTHROPIC_API_KEY: "sk-test" },
      COMPLETE_STDOUT,
    );

    expect(outcome.usage.completeness).toBe("complete");
    expect(outcome.usage.billingMode).toBe("metered");
    expect(outcome.usage.costSource).toBe("provider");
    expect(outcome.usage.cashCostUsd).toBe(0.0455);
    expect(outcome.usage.notionalCostUsd).toBeUndefined();
  });

  test("an ANTHROPIC_AUTH_TOKEN run books cash too — same credential class", async () => {
    const outcome = await runUnder(
      { ANTHROPIC_AUTH_TOKEN: "bearer-test" },
      COMPLETE_STDOUT,
    );

    expect(outcome.usage.billingMode).toBe("metered");
    expect(outcome.usage.costSource).toBe("provider");
    expect(outcome.usage.cashCostUsd).toBe(0.0455);
    expect(outcome.usage.notionalCostUsd).toBeUndefined();
  });

  // The discriminators. Without these an implementation that simply reverted
  // #173 for every route would pass every arm above.
  test("an OAuth-token run keeps #173's notional filing", async () => {
    const outcome = await runUnder(
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
      COMPLETE_STDOUT,
    );

    expect(outcome.usage.billingMode).toBe("subscription");
    expect(outcome.usage.costSource).toBe("subscription");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outcome.usage.notionalCostUsd).toBe(0.0455);
  });

  // action.yml:111 binds ANTHROPIC_API_KEY unconditionally and GitHub renders
  // an unset input as "", so every subscription-route CI run carries the empty
  // string — the single most common env this transport will ever see, and it
  // must stay on the subscription arm. (`""` is falsy on its own; the
  // whitespace-only case the trim exists for is asserted on the predicate
  // itself in test/usage/normalization.test.ts.)
  test("an empty ANTHROPIC_API_KEY is not a metered signal", async () => {
    const outcome = await runUnder({ ANTHROPIC_API_KEY: "" }, COMPLETE_STDOUT);

    expect(outcome.usage.billingMode).toBe("subscription");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outcome.usage.notionalCostUsd).toBe(0.0455);
  });

  test("a partial attempt under an API key files cash on the partial builder too", async () => {
    const outcome = await runUnder(
      { ANTHROPIC_API_KEY: "sk-test" },
      JSON.stringify({
        result: "reviewed",
        total_cost_usd: 0.0455,
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 900,
          output_tokens: 45,
        },
      }),
    );

    expect(outcome.usage.completeness).toBe("partial");
    expect(outcome.usage.billingMode).toBe("metered");
    expect(outcome.usage.costSource).toBe("provider");
    expect(outcome.usage.cashCostUsd).toBe(0.0455);
    expect(outcome.usage.notionalCostUsd).toBeUndefined();
  });

  // Absence over fabrication, moved to the side the credential pays on. #173's
  // subscription arm keeps a truthful `cashCostUsd: 0` when the CLI reports no
  // total, because a subscription really does charge nothing. A METERED
  // attempt with no reported total is a different fact — real money was spent
  // and we do not know how much — so the cash stays undefined and
  // `settlementFromUsage` reports it unresolved rather than settling a
  // fabricated zero, which is the "$0 on parse failure" collapse §8 exists to
  // kill.
  test("a metered run whose CLI reported no total leaves cash undefined, and settles as unresolved", async () => {
    const outcome = await runUnder(
      { ANTHROPIC_API_KEY: "sk-test" },
      JSON.stringify({
        result: "reviewed",
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 300,
          output_tokens: 45,
        },
      }),
    );

    expect(outcome.usage.completeness).toBe("complete");
    expect(outcome.usage.billingMode).toBe("metered");
    expect(outcome.usage.cashCostUsd).toBeUndefined();
    expect(outcome.usage.notionalCostUsd).toBeUndefined();
    expect(settlementFromUsage(outcome.usage)).toEqual({
      kind: "unresolved",
      knownUsd: undefined,
    });
  });

  // #173's mechanical constraint, now owed on BOTH arms: an unclassified
  // failure legacy-classifies as "format", which retries, so a pre-spawn
  // denial can be summed with a spawned attempt — and `sumNormalizedUsage`
  // collapses billingMode AND costSource to "unknown" the moment the two
  // disagree. A denial that stayed on the subscription basis would erase the
  // metered run's cost basis on exactly the retry path this transport has.
  test("a pre-spawn denial under an API key reports the metered basis, and survives the retry sum", async () => {
    const fake = makeFakeProc({ stdoutBody: "", exitCode: 0 });
    const denyingTransport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      promptLstatFn: () => ({ mode: 0o100600, isSymbolicLink: true }),
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });
    const denial = await denyingTransport.execute(
      makeRequest({
        isolation: {
          credentialProjectionId: "proj-1",
          env: { ANTHROPIC_API_KEY: "sk-test" },
          syntheticHome: "/tmp/pr-hero-test/home",
          syntheticConfigHome: "/tmp/pr-hero-test/config",
          syntheticTmp: "/tmp/pr-hero-test/tmp",
          verifiedBinaryPath: "/usr/bin/true",
        },
      }),
      { signal: new AbortController().signal },
    );

    expect(denial.stderrTail).toContain("prompt integrity denied");
    expect(denial.usage.billingMode).toBe("metered");
    expect(denial.usage.costSource).toBe("provider");
    expect(denial.usage.cashCostUsd).toBe(0);

    const spawned = await runUnder(
      { ANTHROPIC_API_KEY: "sk-test" },
      COMPLETE_STDOUT,
    );
    const summed = sumNormalizedUsage(denial.usage, spawned.usage);
    expect(summed.billingMode).toBe("metered");
    expect(summed.costSource).toBe("provider");
    expect(summed.cashCostUsd).toBe(0.0455);
  });

  // The safety property this whole change exists for, proven at the settlement
  // boundary rather than at the record: budget enforcement is cash-only (§8),
  // so a metered run's money has to arrive as `actualUsd` or the ceiling is
  // enforcing against $0.
  test("a metered run's real spend reaches the spend limiter as settled cash", async () => {
    const outcome = await runUnder(
      { ANTHROPIC_API_KEY: "sk-test" },
      COMPLETE_STDOUT,
    );

    expect(settlementFromUsage(outcome.usage)).toEqual({
      kind: "settle",
      actualUsd: 0.0455,
    });
  });

  // The metered-zero rule (#172) applied to a record this transport can now
  // actually produce, pinned so the semantics are a decision rather than a
  // surprise. Scope stated exactly, because inferring it would overstate it:
  // in production this rule is NOT reachable on a claude-code route today.
  // `settlementFromUsage` runs only from `finalizeReservation`, which needs a
  // reservation, and `reservesSpend` (production-runtime.ts) opens one only
  // when `capabilityReport.billing.mode === "metered"` — still statically
  // "subscription" for this backend, which is the admission path #177
  // deliberately does not touch. So no API-key run can be fenced or refused by
  // this change, and none appears in `result.unresolved`
  // (`collectUnresolvedSpend` reads reservations, of which a claude-only run
  // has none). What this arm pins is the RECORD's meaning, so that if a
  // metered claude-code route is ever admitted (#161), it arrives already
  // honest instead of settling a zero that is almost certainly wrong.
  test("a metered run reporting zero cash with output tokens is unresolved, not settled", async () => {
    const outcome = await runUnder(
      { ANTHROPIC_API_KEY: "sk-test" },
      JSON.stringify({
        result: "reviewed",
        total_cost_usd: 0,
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 18534,
          cache_creation_input_tokens: 10213,
          output_tokens: 4,
        },
      }),
    );

    expect(outcome.usage.billingMode).toBe("metered");
    expect(outcome.usage.cashCostUsd).toBe(0);
    expect(outputTokensKnown(outcome.usage.tokens)).toBeGreaterThan(0);
    expect(settlementFromUsage(outcome.usage)).toEqual({
      kind: "unresolved",
      knownUsd: undefined,
    });
  });

  // #197, the arm this change MAKES REACHABLE. Flipping this transport's
  // `pricingReady` to true is what lets a metered claude-code route past the
  // pricing gate at all, so the settlement question it hands downstream stops
  // being hypothetical: the CLI's `total_cost_usd` is OPTIONAL
  // (`RawClaudeCliResult`), so a metered attempt can complete with every token
  // leaf present and no cost figure whatsoever.
  //
  // The answer is absence, never zero. `costFor` leaves `cashCostUsd`
  // undefined on the metered arm and `settlementFromUsage`'s
  // `cashCostUsd === undefined` guard turns that into `unresolved` with no
  // `knownUsd` — the spend ledger fences the bucket instead of booking a
  // fabricated $0 against the ceiling. Both halves are asserted because
  // `kind` alone would pass an implementation that carried a bogus figure,
  // and `knownUsd` alone would pass the guard's own deletion: without it the
  // record falls through the metered-zero rule (cash is undefined, not 0) and
  // the free-nonzero rule (mode is metered) to `{ kind: "settle", actualUsd:
  // undefined }` — which also has no `knownUsd`. Mutation-checked, 2026-09-07.
  //
  // SCOPE, stated exactly rather than inferred: no claude-code route resolves
  // metered TODAY. `credentialKindForRoute` (runner-authority.ts) returns
  // `claude_subscription_oauth` for this backend unconditionally, so
  // `effectiveBillingMode` never upgrades and `reservesSpend` opens no
  // reservation. What this pins is the RECORD's meaning, so the arm #161
  // opens arrives already honest.
  test("a metered run reporting no cash figure at all is unresolved with nothing known", async () => {
    const outcome = await runUnder(
      { ANTHROPIC_API_KEY: "sk-test" },
      JSON.stringify({
        result: "reviewed",
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 18534,
          cache_creation_input_tokens: 10213,
          output_tokens: 4,
        },
      }),
    );

    expect(outcome.usage.completeness).toBe("complete");
    expect(outcome.usage.billingMode).toBe("metered");
    expect(outcome.usage.cashCostUsd).toBeUndefined();
    expect(outputTokensKnown(outcome.usage.tokens)).toBeGreaterThan(0);
    expect(settlementFromUsage(outcome.usage)).toEqual({
      kind: "unresolved",
      knownUsd: undefined,
    });
  });
});

// D1-08 PR3 task 3.11 (§9.2): capabilities() gains an OPTIONAL bucket-scope
// input so a caller that HAS resolved a credential's scope (PR5a's harness
// wiring, not yet built) can ask the transport to report the resulting
// rateLimitBucketId on ProviderCapabilityReport. Calling with no argument —
// every existing call site — must keep reporting rateLimitBucketId as
// undefined, byte-identical to pre-PR3 behavior.
// #197. `pricingReady` is a STATIC capability claim, read at admission
// before any spawn: no cost figure exists at the moment it is asked, for any
// transport. So it cannot be answering "is this attempt's cost a provider
// invoice?" — it answers "will this transport tell you what the attempt
// cost?", and this one will: the CLI reports `total_cost_usd`.
//
// Asserted HERE, on the transport's own report, because
// `DefaultTransportRegistry.getCapabilityReport` returns exactly this object
// to `FrozenRuntimeBinding.capabilities()` — this value IS the admission
// input, not a report about one.
describe("ClaudeCodeCliTransport.capabilities pricing readiness (#197)", () => {
  test("the transport claims it will report what the attempt cost", async () => {
    const report = await new ClaudeCodeCliTransport().capabilities();
    expect(report.billing.pricingReady).toBe(true);
  });

  // The issue that used to sit beside `pricingReady: false` said "a versioned
  // Anthropic pricing table is bundled, but capabilities() carries no route".
  // Both halves died with #197: no table is bundled any more, and nothing is
  // missing on this backend — cash comes from `total_cost_usd` on a metered
  // credential and notional from it on a subscription. A non-blocking issue
  // named `pricing_table_missing` beside a `true` flag is a contradiction
  // doctor would render as a degraded row.
  test("no pricing_table_missing issue is reported beside the claim", async () => {
    const report = await new ClaudeCodeCliTransport().capabilities();
    expect(report.issues.map((i) => i.code).sort()).toEqual([
      "bounded_events_sink_missing",
      "codegraph_policy_unenforced",
    ]);
    expect(report.issues.every((i) => !i.blocking)).toBe(true);
  });
});

describe("ClaudeCodeCliTransport.capabilities bucket identity (D1-08 PR3)", () => {
  test("no bucket-scope argument leaves rateLimitBucketId undefined (regression pin)", async () => {
    const transport = new ClaudeCodeCliTransport(okPromptFns);
    const report = await transport.capabilities();
    expect(report.rateLimitBucketId).toBeUndefined();
  });

  test("a supplied bucket-scope input yields the same bucketId deriveBucketId would compute", async () => {
    const { deriveBucketId } = await import("../../src/execution/bucket-id");
    const transport = new ClaudeCodeCliTransport(okPromptFns);
    const localKey = Buffer.from("e".repeat(64), "hex");
    const report = await transport.capabilities({
      credentialFingerprint: "fp-claude-1",
      bucketScope: { account: "acct-1" },
      localKey,
    });
    const expected = deriveBucketId(
      {
        provider: "anthropic",
        credentialFingerprint: "fp-claude-1",
        scope: { account: "acct-1" },
      },
      localKey,
    );
    expect(report.rateLimitBucketId).toBe(expected);
  });

  test("an unknown (empty) bucket-scope still yields a deterministic bucketId, not undefined", async () => {
    const transport = new ClaudeCodeCliTransport(okPromptFns);
    const localKey = Buffer.from("f".repeat(64), "hex");
    const report = await transport.capabilities({
      credentialFingerprint: "fp-claude-2",
      localKey,
    });
    expect(report.rateLimitBucketId).toBeDefined();
    expect(typeof report.rateLimitBucketId).toBe("string");
  });
});

describe("ClaudeCodeCliTransport.classifyFailure", () => {
  const transport = new ClaudeCodeCliTransport(okPromptFns);

  function classify(witness: string, where: "stderr" | "final" = "stderr") {
    return transport.classifyFailure({
      completion: "failed",
      protocolIntegrity: "verified",
      finalText: where === "final" ? witness : "",
      usage: {
        wallMs: 1,
        tokens: { inputUncached: 1 },
        completeness: "complete" as const,
        billingMode: "subscription" as const,
        costSource: "provider" as const,
        cashCostUsd: 0,
      },
      stderrTail: where === "stderr" ? witness : "",
    });
  }

  // §7 gives rate_limit its own disposition — bounded retry with backoff —
  // precisely because retrying INSTANTLY against a server that just said it
  // is saturated makes the saturation worse and burns the whole transient
  // budget in milliseconds. That separation only exists if something actually
  // classifies backpressure as backpressure.
  test("server backpressure is rate_limit, not a network blip", () => {
    for (const witness of [
      "upstream returned 529",
      "overloaded_error",
      "API Error: 529 overloaded_error",
      "HTTP 429 Too Many Requests",
      "rate limit exceeded",
      "rate_limit_error",
      "503 Service Unavailable",
    ]) {
      expect(classify(witness)).toBe("rate_limit");
    }
  });

  // The connection-level witnesses stay immediate: nothing upstream asked us
  // to slow down, and waiting out a reset socket buys nothing.
  test("connection-level failures stay network_transient", () => {
    for (const witness of [
      "API Error: Connection closed mid-response",
      "read ECONNRESET",
      "socket hang up",
      "request timed out",
      "502 Bad Gateway",
    ]) {
      expect(classify(witness)).toBe("network_transient");
    }
  });

  // Ordering trap: the real CLI witness for an overload is "API Error: 529
  // overloaded_error", which matches the network regex too. Whichever test
  // runs first wins, so backpressure has to be decided BEFORE the generic
  // network match or the fix silently does nothing for the exact string it
  // exists to catch.
  test("a witness carrying BOTH signals is treated as backpressure", () => {
    expect(classify("API Error: Connection closed · 529 overloaded")).toBe(
      "rate_limit",
    );
  });

  test("a status code embedded in a larger number is not a status code", () => {
    expect(classify("processed 15291 tokens, then finished")).toBeUndefined();
    expect(classify("job 1429 completed")).toBeUndefined();
  });

  test("the login witness still outranks everything else", () => {
    expect(classify("Not logged in · Please run /login")).toBe("auth_invalid");
    // Auth is terminal; a 529 in the same witness must not downgrade it into
    // a retryable cause.
    expect(classify("529 overloaded\nNot logged in · Please run /login")).toBe(
      "auth_invalid",
    );
  });

  // The witness includes finalText, which is `JSON.parse(stdout).result` — a
  // MIXED channel carrying both the CLI's own error text and the model's
  // final message. pr-hero's model output is code-review prose about exactly
  // these failure modes, so English phrases like "rate limit" match the tool's
  // own subject-matter vocabulary. Reported as F003 on PR #74 against the
  // sibling SDK transport; the same defect reached this file through #78.
  test("review prose about rate limiting is not a rate limit", () => {
    for (const prose of [
      "The endpoint has no rate limit, so a burst of requests goes straight through.",
      "Consider returning 429 Too Many Requests once the quota is spent.",
      "This path renders Service Unavailable instead of retrying.",
      "The worker pool is overloaded under this traffic shape.",
    ]) {
      expect(classify(prose, "final")).toBeUndefined();
    }
  });

  // Narrowing prose must not cost a single audited witness. These are the v1
  // observed strings (test/step-runner.test.ts:465-474) — machine tokens and
  // status codes the provider actually emits, not sentences about them.
  test("the audited provider witnesses still classify from stderr", () => {
    expect(classify("upstream returned 529")).toBe("rate_limit");
    expect(classify("overloaded_error")).toBe("rate_limit");
    expect(classify("API Error: 529 overloaded_error")).toBe("rate_limit");
    expect(classify("rate_limit_error")).toBe("rate_limit");
    expect(classify("HTTP 429")).toBe("rate_limit");
  });

  test("clean prose is not a transport failure at all", () => {
    expect(classify("here are my findings", "final")).toBeUndefined();
  });

  test("the witness spans stderr AND the final message", () => {
    expect(classify("overloaded_error", "final")).toBe("rate_limit");
  });
});

// #299 (2026-10-01): the CLI result's `num_turns` is the only tool signal the
// Claude Code route exposes, and the vacuous-hunt gate (#214) was blind on this
// route without it. Observed live: 1 turn with no tools, 2 turns for one Read,
// 17 turns for a deep hunt.
describe("ClaudeCodeCliTransport toolInvocations from num_turns (#299)", () => {
  async function toolInvocationsFor(stdoutBody: string): Promise<unknown> {
    const fake = makeFakeProc({ stdoutBody, exitCode: 0 });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });
    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });
    return outcome.toolInvocations;
  }

  const withTurns = (numTurns: unknown): string =>
    JSON.stringify({ result: "reviewed", num_turns: numTurns });

  test("a single turn is an observed zero: the model never called a tool", async () => {
    expect(await toolInvocationsFor(withTurns(1))).toBe(0);
  });

  test("every turn after the first followed tool results", async () => {
    expect(await toolInvocationsFor(withTurns(2))).toBe(1);
    expect(await toolInvocationsFor(withTurns(17))).toBe(16);
  });

  test("a missing num_turns is unknown, never a fabricated zero", async () => {
    expect(
      await toolInvocationsFor(JSON.stringify({ result: "reviewed" })),
    ).toBeUndefined();
  });

  test("a malformed num_turns is unknown, never coerced", async () => {
    for (const bad of [0, -3, 1.5, "3", null, Number.NaN, {}, [2]]) {
      expect(await toolInvocationsFor(withTurns(bad))).toBeUndefined();
    }
  });

  test("non-JSON stdout is unknown", async () => {
    expect(await toolInvocationsFor("not json at all")).toBeUndefined();
  });
});

// #314: the whole user prompt embeds the full patch, and Linux caps ONE argv
// string at MAX_ARG_STRLEN (131072 bytes incl. the NUL), so a positional prompt
// made every hunter die with E2BIG on a 175 KB patch. The prompt now travels on
// stdin; these pin that it never comes back to argv, and that the isolation
// flags around it are byte-identical on the REAL transport argv (only
// buildStepArgv's mirror was asserted before).
describe("ClaudeCodeCliTransport prompt delivery and isolation argv (#314)", () => {
  // Linux MAX_ARG_STRLEN minus the terminating NUL: the longest single argv
  // string execve accepts (131072 was verified to fail with E2BIG).
  const MAX_ARG_BYTES = 131_071;

  async function captureSpawn(request: TransportRequest): Promise<{
    args: string[];
    opts: Record<string, unknown>;
  }> {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "ok" }),
      exitCode: 0,
    });
    let captured: { args: string[]; opts: Record<string, unknown> } | undefined;
    const spawnFn = ((args: string[], opts: Record<string, unknown>) => {
      captured = { args, opts };
      return fake.proc;
    }) as unknown as typeof Bun.spawn;
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn,
      getPgid: (pid) => pid,
    });
    await transport.execute(request, {
      signal: new AbortController().signal,
    });
    if (captured === undefined) throw new Error("spawnFn was never called");
    return captured;
  }

  function decodedStdin(opts: Record<string, unknown>): string | undefined {
    const stdin = opts.stdin;
    return stdin instanceof Uint8Array
      ? new TextDecoder().decode(stdin)
      : undefined;
  }

  test("argv carries no prompt and stdin carries exactly the prompt", async () => {
    const prompt = "review this diff, please";
    const { args, opts } = await captureSpawn(
      makeRequest({ userPrompt: prompt }),
    );
    // Adjacency, not just absence: `-p` is followed straight by a flag, so no
    // positional prompt can be hiding between them.
    expect(args[1]).toBe("-p");
    expect(args[2]).toBe("--append-system-prompt-file");
    expect(args).not.toContain(prompt);
    expect(decodedStdin(opts)).toBe(prompt);
  });

  test("a prompt past MAX_ARG_STRLEN never reaches an argv element", async () => {
    // ~200 KB with multi-byte characters, so bytes and UTF-16 length differ
    // and the bound is checked in the unit the kernel counts.
    const prompt = `diff --git a/x b/x\n${"é patch line\n".repeat(15_000)}`;
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(MAX_ARG_BYTES + 1);
    const { args, opts } = await captureSpawn(
      makeRequest({ userPrompt: prompt }),
    );
    for (const arg of args) {
      expect(Buffer.byteLength(arg)).toBeLessThanOrEqual(MAX_ARG_BYTES);
    }
    const stdin = decodedStdin(opts);
    // Length first and a boolean compare after: a toBe on 200 KB strings
    // renders an unreadable failure diff.
    expect(stdin?.length).toBe(prompt.length);
    expect(stdin === prompt).toBe(true);
  });

  test("isolation flags are emitted verbatim with an MCP config", async () => {
    const { args } = await captureSpawn(
      makeRequest({
        mcpConfigPath: "/tmp/pr-hero-test/mcp.json",
        tools: ["Read", "Grep"],
      }),
    );
    const flagValue = (flag: string): string | undefined => {
      const at = args.indexOf(flag);
      return at === -1 ? undefined : args[at + 1];
    };
    expect(flagValue("--mcp-config")).toBe("/tmp/pr-hero-test/mcp.json");
    expect(args[args.indexOf("--mcp-config") + 2]).toBe("--strict-mcp-config");
    // The empty value must sit right after its flag, or the next flag would be
    // read as the setting sources.
    expect(flagValue("--setting-sources")).toBe("");
    expect(flagValue("--tools")).toBe("Read,Grep");
    expect(flagValue("--permission-mode")).toBe("bypassPermissions");
    expect(flagValue("--output-format")).toBe("json");
    expect(flagValue("--append-system-prompt-file")).toBe(
      "/tmp/pr-hero-test/system.md",
    );
    // Per-machine sections (cwd, git status) leave the system prompt, so the
    // engine-invariant prefix is cached across worktrees and repositories.
    expect(
      args.filter((a) => a === "--exclude-dynamic-system-prompt-sections"),
    ).toHaveLength(1);
  });

  test("without an MCP config no MCP flag is emitted, and the rest still are", async () => {
    const { args } = await captureSpawn(makeRequest());
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(
      "bypassPermissions",
    );
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
  });
});

// #314: Bun.spawn throws synchronously when execve refuses (E2BIG, ENOENT,
// EACCES). That throw used to escape execute() before its try, the harness
// swallowed the rejection and settled the step `cancelled`, and the log said
// only "failed" with no reason anywhere. It is now an ordinary failed outcome
// that names the error, at genuine zero cost.
describe("ClaudeCodeCliTransport spawn failure (#314)", () => {
  function throwingSpawn(error: unknown): typeof Bun.spawn {
    return (() => {
      throw error;
    }) as unknown as typeof Bun.spawn;
  }

  async function executeWith(error: unknown) {
    const before = ACTIVE_CHILD_PROCS.size;
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: throwingSpawn(error),
      getPgid: (pid) => pid,
    });
    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });
    return { outcome, registeredDelta: ACTIVE_CHILD_PROCS.size - before };
  }

  test("a throwing spawn resolves failed with the error code and message", async () => {
    const error = Object.assign(new Error("argument list too long"), {
      code: "E2BIG",
    });
    const { outcome, registeredDelta } = await executeWith(error);
    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.finalText).toBe("");
    expect(outcome.stderrTail).toBe(
      "[pr-hero] spawn failed: E2BIG: argument list too long; no child started",
    );
    expect(outcome.terminalProof).toBeUndefined();
    // Nothing was spawned, so nothing may stay registered for the
    // shutdown sweep to signal.
    expect(registeredDelta).toBe(0);
    // No attempt reached the provider: a genuine zero, same as a denial.
    expect(outcome.usage.cashCostUsd).toBe(0);
  });

  test("a message that already names the code does not repeat it", async () => {
    const error = Object.assign(
      new Error("E2BIG: argument list too long, posix_spawn"),
      { code: "E2BIG" },
    );
    const { outcome } = await executeWith(error);
    expect(outcome.stderrTail).toBe(
      "[pr-hero] spawn failed: E2BIG: argument list too long, posix_spawn; no child started",
    );
  });

  test("a non-Error throw is still reported, never a crash", async () => {
    const { outcome } = await executeWith("boom");
    expect(outcome.completion).toBe("failed");
    expect(outcome.stderrTail).toBe(
      "[pr-hero] spawn failed: boom; no child started",
    );
  });

  // PR #315 review F004: a spawn that started no child is terminal. Driven
  // through execute() so the classifier is checked against what the transport
  // REALLY produces — a reworded tail that stops matching fails here.
  // runtime_unavailable is the frozen cause OpenCode already uses for a turn
  // that never started, and §7 rules it terminal: retrying cannot help an
  // argv execve refused, and a format reminder only makes the prompt longer.
  test("classifies as runtime_unavailable, terminal, never a format retry", async () => {
    const error = Object.assign(new Error("argument list too long"), {
      code: "E2BIG",
    });
    const { outcome } = await executeWith(error);
    const transport = new ClaudeCodeCliTransport(okPromptFns);
    expect(transport.classifyFailure(outcome)).toBe("runtime_unavailable");
    expect(
      resolveFailureCause({
        outcome,
        classifyFailure: transport.classifyFailure,
        parseThrew: false,
      }),
    ).toEqual({ kind: "cause", cause: "runtime_unavailable" });
    expect(
      decideRetryDisposition("runtime_unavailable", {
        transientAttemptsUsed: 0,
        formatRetriesUsed: 0,
      }),
    ).toEqual({ action: "terminal" });
  });

  test("a multi-line spawn error is still recognized", async () => {
    const { outcome } = await executeWith(new Error("first line\nsecond line"));
    const transport = new ClaudeCodeCliTransport(okPromptFns);
    expect(transport.classifyFailure(outcome)).toBe("runtime_unavailable");
  });

  // Only the transport's own whole tail is the witness. A child's stderr that
  // merely quotes the phrase is a real child's output, not a spawn failure.
  test("child stderr quoting the phrase is not a spawn failure", () => {
    const transport = new ClaudeCodeCliTransport(okPromptFns);
    const outcome = {
      completion: "failed" as const,
      protocolIntegrity: "unverified" as const,
      finalText: "",
      usage: {
        wallMs: 0,
        tokens: {},
        completeness: "complete" as const,
        billingMode: "subscription" as const,
        costSource: "subscription" as const,
        cashCostUsd: 0,
      },
      stderrTail:
        "child log: [pr-hero] spawn failed: E2BIG: argument list too long; no child started",
    };
    expect(transport.classifyFailure(outcome)).toBeUndefined();
  });
});
