import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildStepArgv,
  ClaudeCodeRunner,
  type RetryInfo,
  type StepSpec,
} from "#review/step-runner";
import {
  classifyFailure,
  isTerminalSessionFailure,
  isTransientSessionFailure,
} from "../../src/execution/failure-classification";
import { FORMAT_RETRY_REMINDER } from "../../src/execution/step-artifacts";

// ---------------------------------------------------------------------------
// FakeSpawn: scripted {stdout, stderr, exitCode} per call, records argv/cwd
// and the prompt the transport wrote to stdin (#314: the prompt travels on
// stdin, never argv).
// A `hang: true` script entry produces a process whose streams and exit only
// settle when kill() fires — how the watchdog path gets exercised without a
// real 30-minute wait.
// ---------------------------------------------------------------------------

interface ScriptedCall {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
}

interface RecordedCall {
  argv: string[];
  cwd: string | undefined;
  // Decoded stdin bytes, or undefined when the spawn passed no stdin buffer.
  stdin: string | undefined;
}

function makeFakeSpawn(script: ScriptedCall[]): {
  spawnFn: typeof Bun.spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const spawnFn = ((
    argv: string[],
    opts?: { cwd?: string; stdin?: unknown },
  ) => {
    // Repeat the last scripted entry when exhausted, so a runner that makes
    // more calls than expected fails an assertion instead of crashing.
    const scripted = script[Math.min(calls.length, script.length - 1)] ?? {};
    calls.push({
      argv,
      cwd: opts?.cwd,
      stdin:
        opts?.stdin instanceof Uint8Array
          ? decoder.decode(opts.stdin)
          : undefined,
    });
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const held: ReadableStreamDefaultController<Uint8Array>[] = [];
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (scripted.hang) {
            held.push(controller);
            return;
          }
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    const stdout = stream(scripted.stdout ?? "");
    const stderr = stream(scripted.stderr ?? "");
    if (!scripted.hang) resolveExit(scripted.exitCode ?? 0);
    return {
      stdout,
      stderr,
      exited,
      kill() {
        for (const controller of held) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
        resolveExit(143);
      },
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

// `--output-format json` stdout envelope, as the claude CLI emits it.
function envelope(
  result: string,
  tokens: { input: number; output: number } = { input: 100, output: 20 },
  cost = 0.01,
): string {
  return JSON.stringify({
    result,
    usage: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: cost,
  });
}

async function makeSpec(overrides: Partial<StepSpec> = {}): Promise<StepSpec> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-step-"));
  // §6.3: the harness hashes the prompt pre-loop and the transport re-verifies
  // it (0600, non-symlink, hash match) immediately before spawn, so offline
  // runner tests need a real 0600 file on disk.
  const systemPromptPath = path.join(dir, "hunter-reliability.system.md");
  await writeFile(systemPromptPath, "system prompt");
  await chmod(systemPromptPath, 0o600);
  return {
    name: "hunter-reliability",
    systemPromptPath,
    prompt: "Review this diff.",
    tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
    mcpConfigPath: "/runs/1/mcp.json",
    model: "claude-sonnet-4-5",
    effort: "high",
    cwd: "/worktrees/pr-1539",
    outPath: path.join(dir, "hunter-reliability.json"),
    timeoutMs: 5_000,
    maxAttempts: 2,
    parse: (finalText) => JSON.parse(finalText) as unknown,
    ...overrides,
  };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const GOOD_DRAFT = { findings: [] };

describe("buildStepArgv", () => {
  test("carries every isolation flag verbatim", async () => {
    const spec = await makeSpec();
    const argv = buildStepArgv(spec);
    // #314: `-p` with no positional prompt — the prompt goes on stdin, so
    // the next element is already a flag and the prompt is nowhere in argv.
    expect(argv.slice(0, 3)).toEqual([
      "claude",
      "-p",
      "--append-system-prompt-file",
    ]);
    expect(argv).not.toContain(spec.prompt);
    expect(flagValue(argv, "--append-system-prompt-file")).toBe(
      spec.systemPromptPath,
    );
    expect(flagValue(argv, "--output-format")).toBe("json");
    expect(flagValue(argv, "--mcp-config")).toBe(spec.mcpConfigPath);
    expect(argv).toContain("--strict-mcp-config");
    expect(flagValue(argv, "--setting-sources")).toBe("");
    expect(flagValue(argv, "--tools")).toBe(
      "Read,Grep,Glob,mcp__codegraph__codegraph_explore",
    );
    expect(flagValue(argv, "--permission-mode")).toBe("bypassPermissions");
    expect(flagValue(argv, "--model")).toBe(spec.model);
    expect(argv).toContain("--exclude-dynamic-system-prompt-sections");
  });

  // §3.12 obligation 1, and the single mechanism §3.5 rests on: the scout's
  // "it cannot open a file, grep, or walk a call graph" is enforced HERE, by
  // the allow-list, and by nothing else — `cwd` is still the worktree and
  // `--mcp-config` is still emitted, so there is no sandbox behind it. Until
  // M5 the only `tools: []` in the repo was the summarizer's StepMeta
  // placeholder, overwritten before any spawn, so this path had never run.
  test("an EMPTY tools list emits --tools with an empty value, not an absent flag", async () => {
    const spec = await makeSpec({ tools: [] });
    const argv = buildStepArgv(spec);
    expect(argv).toContain("--tools");
    expect(flagValue(argv, "--tools")).toBe("");
    // The flag and its empty value must be adjacent, or the next flag becomes
    // the tool list: `--tools --permission-mode` grants nothing but reads as
    // a parse accident waiting to be "fixed".
    const at = argv.indexOf("--tools");
    expect(argv[at + 1]).toBe("");
    expect(argv[at + 2]).toBe("--permission-mode");
    // Every isolation flag still rides along — an empty allow-list is not an
    // excuse to relax the ones that make it meaningful.
    expect(argv).toContain("--strict-mcp-config");
    expect(flagValue(argv, "--setting-sources")).toBe("");
  });

  test("drops v1's --agents and never grants Write/Task", async () => {
    const spec = await makeSpec();
    const argv = buildStepArgv(spec);
    expect(argv).not.toContain("--agents");
    const tools = flagValue(argv, "--tools") ?? "";
    expect(tools).not.toMatch(/\bWrite\b/);
    expect(tools).not.toMatch(/\bTask\b/);
  });
});

describe("ClaudeCodeRunner success path", () => {
  test("parses the FULL result while log tails stay sliced", async () => {
    // A >8192-char final message: the tail slices are for logs ONLY —
    // feeding a slice to parse() would misclassify a delivered draft.
    const big = { findings: [], pad: "x".repeat(9_000) };
    const result = JSON.stringify(big);
    expect(result.length).toBeGreaterThan(8_192);
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: envelope(result) }]);
    const spec = await makeSpec();
    let seen = "";
    spec.parse = (finalText) => {
      seen = finalText;
      return JSON.parse(finalText) as unknown;
    };
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(1);
    expect(seen).toBe(result);
    expect(stepResult.resultText.length).toBe(8_192);
    expect(calls[0]?.cwd).toBe(spec.cwd);
    expect(stepResult.output).toEqual(big);
  });

  test("writes the artifact atomically (no .tmp leftover)", async () => {
    const { spawnFn } = makeFakeSpawn([
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    await runner.run(spec);
    expect(await Bun.file(spec.outPath).json()).toEqual(GOOD_DRAFT);
    expect(await Bun.file(`${spec.outPath}.tmp`).exists()).toBe(false);
  });

  test("captures usage from the envelope", async () => {
    const { spawnFn } = makeFakeSpawn([
      {
        stdout: envelope(
          JSON.stringify(GOOD_DRAFT),
          { input: 300, output: 40 },
          0.05,
        ),
      },
    ]);
    // #177: `childEnv: {}` is load-bearing, not tidiness. The Claude CLI
    // transport now decides cash-vs-notional from the env the child is
    // spawned with, and without this the harness projects `process.env` — so
    // this assertion would pass or fail depending on whether the developer
    // running it happens to export ANTHROPIC_API_KEY. Verified by probe: with
    // the key set, this exact test went red before the injection landed.
    const runner = new ClaudeCodeRunner({ spawnFn, childEnv: {} });
    const stepResult = await runner.run(await makeSpec());
    expect(stepResult.usage.tokens_in).toBe(300);
    expect(stepResult.usage.tokens_out).toBe(40);
    expect(stepResult.usage.tokens_total).toBe(340);
    // #173: `cost_usd_est` is projected from `cashCostUsd`, and a claude-code
    // route is a subscription — nothing is charged, so the legacy figure is a
    // truthful 0. The CLI's list-basis number is not lost, it moved to
    // `notionalCostUsd`, and asserting BOTH here is what makes this a
    // relocation rather than a deletion.
    expect(stepResult.usage.cost_usd_est).toBe(0);
    expect(stepResult.usageV2?.cashCostUsd).toBe(0);
    expect(stepResult.usageV2?.notionalCostUsd).toBe(0.05);
  });
});

describe("ClaudeCodeRunner transient retry", () => {
  // The v1 arm-B signature: exit ZERO with the API error in the result text.
  const transientEnvelope = envelope(
    "API Error: Connection closed mid-response",
    { input: 100, output: 20 },
    0.01,
  );

  test("retries once, deletes stale debris, sums usage", async () => {
    const { spawnFn, calls } = makeFakeSpawn([
      { stdout: transientEnvelope },
      {
        stdout: envelope(
          JSON.stringify(GOOD_DRAFT),
          { input: 50, output: 5 },
          0.02,
        ),
      },
    ]);
    const spec = await makeSpec();
    // Truncated attempt-1 debris: must be gone before attempt 2 runs.
    await Bun.write(spec.outPath, '{"findings": [');
    // #177: see the note on "captures usage from the envelope" — the
    // subscription cost shape asserted below is only a fact about this fixture
    // when the projected child env carries no metered credential.
    const runner = new ClaudeCodeRunner({ spawnFn, childEnv: {} });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(2);
    expect(calls.length).toBe(2);
    // Usage summed across BOTH attempts — the failed one still consumed quota.
    expect(stepResult.usage.tokens_in).toBe(150);
    expect(stepResult.usage.tokens_out).toBe(25);
    // #173: the cash figure is 0 on a subscription and stays 0 however many
    // attempts run, while the notional figure ACCUMULATES across them
    // (0.01 + 0.02). That is `sumNormalizedUsage`'s "cash and notional
    // accumulate independently" rule reaching production for the first time.
    expect(stepResult.usage.cost_usd_est).toBe(0);
    expect(stepResult.usageV2?.cashCostUsd).toBe(0);
    expect(stepResult.usageV2?.notionalCostUsd).toBeCloseTo(0.03);
    expect(await Bun.file(spec.outPath).json()).toEqual(GOOD_DRAFT);
  });

  test("exhausted transient attempts fail without a format-retry", async () => {
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: transientEnvelope }]);
    const spec = await makeSpec();
    await Bun.write(spec.outPath, '{"findings": [');
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("failed");
    expect(stepResult.attempts).toBe(2);
    // Transient means infrastructure — a REMINDER cannot fix a dead socket.
    expect(calls.length).toBe(2);
    // Debris deleted so nothing downstream trusts a truncated artifact.
    expect(await Bun.file(spec.outPath).exists()).toBe(false);
  });
});

// OBSERVATION ONLY: these assert what the callback SAYS and that it cannot
// change what the runner does — no test here may pin a new retry count, an
// ordering, or a watchdog number.
describe("ClaudeCodeRunner onRetry", () => {
  const transientEnvelope = envelope(
    "API Error: Connection closed mid-response",
  );

  test("announces the transient retry that is about to be spawned", async () => {
    const { spawnFn } = makeFakeSpawn([
      { stdout: transientEnvelope },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const seen: RetryInfo[] = [];
    const spec = await makeSpec({ onRetry: (info) => seen.push(info) });
    await new ClaudeCodeRunner({ spawnFn }).run(spec);
    expect(seen).toEqual([
      {
        step: "hunter-reliability",
        attempt: 2,
        maxAttempts: 2,
        reason: "transient",
      },
    ]);
  });

  test("stays silent when the budget is spent — no retry, nothing to watch", async () => {
    const { spawnFn } = makeFakeSpawn([{ stdout: transientEnvelope }]);
    const seen: RetryInfo[] = [];
    const spec = await makeSpec({
      maxAttempts: 1,
      onRetry: (info) => seen.push(info),
    });
    const stepResult = await new ClaudeCodeRunner({ spawnFn }).run(spec);
    expect(stepResult.status).toBe("failed");
    expect(seen).toEqual([]);
  });

  test("the format retry reports its own reason, never an N-of-M", async () => {
    const { spawnFn } = makeFakeSpawn([
      { stdout: envelope("Sure! Here is some prose instead of JSON.") },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const seen: RetryInfo[] = [];
    const spec = await makeSpec({ onRetry: (info) => seen.push(info) });
    await new ClaudeCodeRunner({ spawnFn }).run(spec);
    expect(seen.map((i) => i.reason)).toEqual(["format"]);
    expect(seen[0]?.attempt).toBe(2);
  });

  test("a throwing observer cannot kill a paid step", async () => {
    const { spawnFn } = makeFakeSpawn([
      { stdout: transientEnvelope },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec({
      onRetry: () => {
        throw new Error("the panel exploded");
      },
    });
    const stepResult = await new ClaudeCodeRunner({ spawnFn }).run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(2);
  });
});

describe("ClaudeCodeRunner format-retry", () => {
  const proseEnvelope = envelope(
    "Sure! Here are my findings described in friendly prose.",
  );

  test("re-prompts once with the REMINDER suffix, then succeeds", async () => {
    const { spawnFn, calls } = makeFakeSpawn([
      { stdout: proseEnvelope },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(2);
    // The re-prompt travels the same channel as the first prompt (#314):
    // stdin, with nothing of it left in argv.
    expect(calls[0]?.stdin).toBe(spec.prompt);
    // The reminder now carries the parser's own message after the fixed
    // suffix, so the model is told what to correct.
    expect(calls[1]?.stdin).toStartWith(spec.prompt + FORMAT_RETRY_REMINDER);
    expect(calls[1]?.stdin).toContain("rejected by the output validator");
    expect(
      calls[1]?.argv.some((arg) => arg.includes(FORMAT_RETRY_REMINDER)),
    ).toBe(false);
    expect(calls[1]?.argv[2]).toBe("--append-system-prompt-file");
  });

  test("is capped at one: a second parse failure fails the step", async () => {
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: proseEnvelope }]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("failed");
    expect(stepResult.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });
});

describe("ClaudeCodeRunner terminal failure", () => {
  const authEnvelope = envelope("Not logged in · Please run /login");

  test("fails authentication once without notifying or spawning a retry", async () => {
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: authEnvelope }]);
    const seen: RetryInfo[] = [];
    const spec = await makeSpec({ onRetry: (info) => seen.push(info) });
    const stepResult = await new ClaudeCodeRunner({ spawnFn }).run(spec);

    expect(stepResult.status).toBe("failed");
    expect(stepResult.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(calls[0]?.stdin).toBe(spec.prompt);
  });
});

// #314: a spawn that throws (E2BIG on an oversized argv, a missing binary)
// used to reject out of the transport; the harness swallowed it and the step
// settled `cancelled` with an empty stderrTail, so the run log could only
// say "failed". It must reach the step result as a failure WITH its reason.
//
// PR #315 review F004: and it must fail ONCE. Unclassified, the reason fell
// through to the legacy "format" class, so the step respawned with a
// format reminder — the same argv execve had just refused — and the run log
// showed a "format retry" for a hunter whose model never produced a byte.
describe("ClaudeCodeRunner spawn failure", () => {
  test("a throwing spawn fails the step once, with its reason, and no retry", async () => {
    let spawns = 0;
    const spawnFn = (() => {
      spawns += 1;
      throw Object.assign(new Error("argument list too long"), {
        code: "E2BIG",
      });
    }) as unknown as typeof Bun.spawn;
    const seen: RetryInfo[] = [];
    const spec = await makeSpec({ onRetry: (info) => seen.push(info) });
    const stepResult = await new ClaudeCodeRunner({ spawnFn }).run(spec);
    expect(stepResult.status).toBe("failed");
    expect(stepResult.stderrTail).toContain("spawn failed");
    expect(stepResult.stderrTail).toContain("E2BIG");
    expect(stepResult.attempts).toBe(1);
    expect(spawns).toBe(1);
    expect(seen).toEqual([]);
  });
});

describe("ClaudeCodeRunner watchdog", () => {
  test("kills a hung attempt and recovers on the retry", async () => {
    const { spawnFn, calls } = makeFakeSpawn([
      { hang: true },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec({ timeoutMs: 50 });
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });

  test("two hangs exhaust the transient budget and fail", async () => {
    const { spawnFn, calls } = makeFakeSpawn([{ hang: true }]);
    const spec = await makeSpec({ timeoutMs: 50 });
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("failed");
    expect(stepResult.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });
});

describe("ClaudeCodeRunner malformed stdout", () => {
  test("fails without throwing, with zero token usage", async () => {
    const { spawnFn } = makeFakeSpawn([{ stdout: "this is not json" }]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("failed");
    expect(stepResult.usage.tokens_total).toBe(0);
    expect(stepResult.usage.cost_usd_est).toBe(0);
  });
});

describe("ClaudeCodeRunner attempt logs", () => {
  test("writes one numbered log per attempt with its classification", async () => {
    const { spawnFn } = makeFakeSpawn([
      {
        stdout: envelope("Sure! Here are my findings described in prose."),
      },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    await runner.run(spec);
    const logsDir = path.join(path.dirname(spec.outPath), "logs");
    const first = await Bun.file(
      path.join(logsDir, `${spec.name}.1.log`),
    ).text();
    const second = await Bun.file(
      path.join(logsDir, `${spec.name}.2.log`),
    ).text();
    expect(first).toContain("classification: format");
    expect(second).toContain("kind: format-retry");
    expect(second).toContain("classification: ok");
  });
});

describe("failure classification", () => {
  test("classifies the observed Claude login witness as terminal", () => {
    const outcome = {
      stderrTail: "",
      resultText: "Not logged in · Please run /login",
    };
    expect(isTerminalSessionFailure(outcome)).toBe(true);
    expect(classifyFailure({ ...outcome, timedOut: false })).toBe("terminal");
  });

  test("isTransientSessionFailure matches the v1 witness regexes", () => {
    const witnesses = [
      "API Error: Connection closed mid-response",
      "read ECONNRESET",
      "socket hang up",
      "request timed out",
      "upstream returned 529",
      "overloaded_error",
    ];
    for (const witness of witnesses) {
      expect(
        isTransientSessionFailure({ stderrTail: witness, resultText: "" }),
      ).toBe(true);
    }
    expect(
      isTransientSessionFailure({
        stderrTail: "",
        resultText: "clean prose with no infrastructure witness",
      }),
    ).toBe(false);
  });

  test("classifyFailure treats a watchdog kill as transient", () => {
    expect(
      classifyFailure({ stderrTail: "", resultText: "", timedOut: true }),
    ).toBe("transient");
    expect(
      classifyFailure({ stderrTail: "", resultText: "prose", timedOut: false }),
    ).toBe("format");
  });
});

// ---------------------------------------------------------------------------
// D1-10b — the cancellation signal reaches the harness
//
// `StepExecutionHarnessOptions.signal` is the entry point to the whole §5.3
// sequence (no new attempts, lease fence, abort, bounded grace), and until
// D1-10b `ClaudeCodeRunnerOptions` dropped it on the floor: the constructor
// forwarded seven options and never this one, so §5.3 was implemented and
// unreachable from every production caller. What happens AFTER a signal aborts
// is already proven in test/harness/settlement.test.ts; these two prove only
// that the runner hands the signal over, observed through the one thing the
// §5.3 step-1 gate makes visible without a transport seam — an aborted run
// spawns nothing at all.
// ---------------------------------------------------------------------------

describe("ClaudeCodeRunner cancellation signal (§5.3)", () => {
  test("an already-aborted signal reaches the harness: zero spawns, zero attempts", async () => {
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: envelope("{}") }]);
    const spec = await makeSpec();
    const controller = new AbortController();
    controller.abort();

    const runner = new ClaudeCodeRunner({ spawnFn, signal: controller.signal });
    const result = await runner.run(spec);

    expect(calls).toHaveLength(0);
    expect(result.attempts).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.stderrTail).toContain("step cancelled");
  });

  test("control — the same runner with no signal spawns and delivers", async () => {
    const { spawnFn, calls } = makeFakeSpawn([
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec();

    const result = await new ClaudeCodeRunner({ spawnFn }).run(spec);

    expect(calls).toHaveLength(1);
    expect(result.attempts).toBe(1);
    expect(result.status).toBe("ok");
  });
});

describe("ClaudeCodeRunner attempt admission", () => {
  test("forwards attemptAdmissionGate so a max_concurrent_steps cap holds on the legacy runner", async () => {
    const { spawnFn } = makeFakeSpawn([
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec();
    const acquired: number[] = [];
    let released = 0;
    const runner = new ClaudeCodeRunner({
      spawnFn,
      attemptAdmissionGate: {
        acquire: async (input) => {
          acquired.push(input.attempt);
          return {
            leaseId: `${input.sessionId}#${input.attempt}`,
            rateLimitBucketId: input.rateLimitBucketId,
            release: () => {
              released += 1;
            },
          };
        },
      },
    });
    const result = await runner.run(spec);
    expect(result.status).toBe("ok");
    expect(acquired).toEqual([1]);
    expect(released).toBe(1);
  });
});
