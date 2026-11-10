import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineInput } from "#review/pipeline";
import { runPipeline } from "#review/pipeline";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import { redactSessionJsonl } from "../../src/execution/claude-session-trace";
import { StepExecutionHarness } from "../../src/execution/harness";
import type {
  CredentialBroker,
  CredentialProjection,
} from "../../src/security/credential-broker";
import { ClaudeCodeCliTransport } from "../../src/transports/claude-code-cli";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = "sk-a1B2c3D4e5F6g7H8";
const TRANSCRIPT = `{"role":"assistant","text":"leak ${SECRET}"}\n`;
const REDACTED = `{"role":"assistant","text":"leak [REDACTED]"}\n`;
const STEP = "hunter-reliability";
const MISSING_FILE =
  "[pr-hero] claude session trace was not copied (session file missing)";
const NOT_COPIED = "claude session trace was not copied";

// Every directory a test here creates, removed after it.
const scratch: string[] = [];

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

class FakeBroker implements CredentialBroker {
  destroyCalls = 0;
  lastHome?: string;

  async project(): Promise<CredentialProjection> {
    const home = await scratchDir("pr-hero-trace-proj-");
    this.lastHome = home;
    return {
      projectionId: "cred-trace",
      kind: "claude_subscription_oauth",
      syntheticHome: home,
      syntheticConfigHome: path.join(home, ".claude"),
      syntheticTmp: path.join(home, "tmp"),
      env: { HOME: home, TMPDIR: path.join(home, "tmp") },
      files: [],
      destroy: async () => {
        this.destroyCalls++;
        await rm(home, { recursive: true, force: true });
      },
    };
  }
}

// The real transport, with a cancellation deadline short enough that the
// harness gives up on a child that ignores every signal within the test.
class ShortDeadlineTransport extends ClaudeCodeCliTransport {
  override async capabilities() {
    const report = await super.capabilities();
    return {
      ...report,
      cancellation: { ...report.cancellation, deadlineMs: 50 },
    };
  }
}

function cliResult(sessionId: string): string {
  return JSON.stringify({
    result: "{}",
    num_turns: 2,
    session_id: sessionId,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
}

// How the fake CLI ends: it prints its result and exits; it never finishes
// and dies on the first signal with nothing on stdout; or it never finishes
// and ignores signals until the test releases it.
type CliEnd = "finishes" | "dies-on-signal" | "ignores-signals";

function fakeProc(end: CliEnd, stdoutBody: string) {
  let release!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    release = resolve;
    if (end === "finishes") resolve(0);
  });
  const body = end === "finishes" ? stdoutBody : "";
  const encoder = new TextEncoder();
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await exited;
        if (text.length > 0) controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  return {
    proc: {
      stdout: stream(body),
      stderr: stream(""),
      exited,
      kill() {
        if (end === "dies-on-signal") release(143);
      },
    },
    release: () => release(137),
  };
}

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

async function reviewWithSession(options: {
  sessionFile: "written" | "missing";
  credential: "projected" | "operator";
  transcript?: string;
  staleTrace?: boolean;
  cli?: CliEnd;
  resultSessionId?: string;
  timeoutMs?: number;
  cancelAfterSpawn?: boolean;
}): Promise<{
  result: StepResult;
  tracePath: string;
  broker: FakeBroker | undefined;
  operatorConfig: string | undefined;
  spawnedArgs: string[][];
}> {
  const root = await scratchDir("pr-hero-trace-run-");
  const steps = path.join(root, "steps");
  mkdirSync(steps);
  const systemPromptPath = path.join(steps, `${STEP}.system.md`);
  await Bun.write(systemPromptPath, "system prompt");
  await chmod(systemPromptPath, 0o600);
  const operatorHome = await scratchDir("pr-hero-trace-op-");
  const operatorConfig = path.join(operatorHome, "claude-config");
  mkdirSync(operatorConfig);
  const broker =
    options.credential === "projected" ? new FakeBroker() : undefined;
  const cancel = new AbortController();
  const spawnedArgs: string[][] = [];
  const releases: Array<() => void> = [];
  const end = options.cli ?? "finishes";
  const transport = new ShortDeadlineTransport({
    spawnFn: ((args: string[], opts: { env?: Record<string, string> }) => {
      spawnedArgs.push(args);
      // Like the real CLI: the session is the one --session-id names, and
      // its file is written as the conversation goes, before any result.
      const sessionId = flagValue(args, "--session-id") ?? SESSION_ID;
      const env = opts.env ?? {};
      if (options.sessionFile === "written") {
        const config =
          env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? "", ".claude");
        const file = path.join(
          config,
          "projects",
          "work-repo",
          `${sessionId}.jsonl`,
        );
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, options.transcript ?? TRANSCRIPT);
      }
      const fake = fakeProc(
        end,
        cliResult(options.resultSessionId ?? sessionId),
      );
      releases.push(fake.release);
      if (options.cancelAfterSpawn) cancel.abort();
      return fake.proc;
    }) as unknown as typeof Bun.spawn,
    getPgid: (pid) => pid,
    killFn: () => {},
    termGraceMs: end === "ignores-signals" ? 60_000 : 20,
    killReapMs: 20,
  });
  const harness = new StepExecutionHarness({
    transport,
    spawnFn: (() => {
      throw new Error("harness spawnFn must not run");
    }) as unknown as typeof Bun.spawn,
    credentialBroker: broker,
    signal: cancel.signal,
    graceMarginMs: 0,
    childEnv: {
      HOME: operatorHome,
      USER: "reviewer",
      PATH: "/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: operatorConfig,
    },
  });
  const tracePath = path.join(steps, `trace.${STEP}.attempt1.jsonl`);
  if (options.staleTrace) writeFileSync(tracePath, "stale previous run\n");
  const result = await harness.run({
    name: STEP,
    systemPromptPath,
    prompt: "review this",
    tools: [],
    model: "sonnet",
    effort: "high",
    cwd: root,
    outPath: path.join(steps, `${STEP}.draft.json`),
    mcpConfigPath: path.join(root, "mcp.json"),
    timeoutMs: options.timeoutMs ?? 1000,
    maxAttempts: 1,
    parse: (text) => JSON.parse(text),
  });
  for (const release of releases) release();
  return {
    result,
    tracePath,
    broker,
    operatorConfig:
      options.credential === "operator" ? operatorConfig : undefined,
    spawnedArgs,
  };
}

describe("Claude session trace", () => {
  test("a provider key five levels down is redacted", () => {
    const key = "AIza12345678901234567890123456789012345";
    const line = {
      message: { content: [{ input: { command: `echo ${key}` } }] },
    };
    const out = redactSessionJsonl(`${JSON.stringify(line)}\n`);
    expect(out).not.toContain(key);
    const parsed = JSON.parse(out.trim()) as {
      message: { content: Array<{ input: { command: string } }> };
    };
    expect(parsed.message.content[0]?.input.command).toBe("echo [REDACTED]");
  });

  test("embedded JSON is redacted before the text patterns run", () => {
    const inner = JSON.stringify({
      Authorization: "Bearer abc",
      Cookie: "sid=123",
    });
    const out = redactSessionJsonl(`${JSON.stringify({ content: inner })}\n`);
    expect(out).not.toContain("abc");
    expect(out).not.toContain("sid=123");
    const parsed = JSON.parse(out.trim()) as { content: string };
    expect(JSON.parse(parsed.content)).toEqual({
      Authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
    });
  });

  test("a line past the redaction limit is omitted instead of copied raw", () => {
    let value: unknown = "password hunter2";
    for (let i = 0; i < 14; i++) value = { nest: value };
    const out = redactSessionJsonl(`${JSON.stringify(value)}\n`);
    expect(out).not.toContain("hunter2");
    expect(JSON.parse(out.trim())).toEqual({
      crysk: "session line omitted",
    });
  });

  test("a Claude attempt copies its session transcript into the run dir", async () => {
    const { result, tracePath } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
    });
    expect(result.status).toBe("ok");
    expect(await Bun.file(tracePath).text()).toBe(REDACTED);
  });

  test("a secret in the transcript is redacted in the copy", async () => {
    const { tracePath } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
    });
    const copy = await Bun.file(tracePath).text();
    expect(copy).toBe(REDACTED);
    expect(copy).not.toContain(SECRET);
  });

  test("the credential projection is still destroyed after the copy", async () => {
    const { tracePath, broker } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
    });
    expect(await Bun.file(tracePath).text()).toBe(REDACTED);
    expect(broker?.destroyCalls).toBe(1);
    expect(broker?.lastHome).toBeString();
    expect(existsSync(broker?.lastHome ?? "")).toBe(false);
  });

  test("a quoted password inside a tool result is redacted and the line still parses", async () => {
    const transcript = `${JSON.stringify({
      type: "tool_result",
      content: JSON.stringify({ password: "hunter2" }),
    })}\n`;
    const { tracePath } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
      transcript,
    });
    const copy = await Bun.file(tracePath).text();
    expect(copy).not.toContain("hunter2");
    const line = JSON.parse(copy.trim()) as { content: string };
    expect(JSON.parse(line.content)).toEqual({ password: "[REDACTED]" });
  });

  test("a Google API key in the transcript is redacted", async () => {
    const key = "AIza12345678901234567890123456789012345";
    const transcript = `${JSON.stringify({ role: "assistant", text: `key ${key}` })}\n`;
    const { tracePath } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
      transcript,
    });
    const copy = await Bun.file(tracePath).text();
    expect(copy).not.toContain(key);
    expect(JSON.parse(copy.trim())).toEqual({
      role: "assistant",
      text: "key [REDACTED]",
    });
  });

  test("a missing session file still finishes the attempt and warns", async () => {
    const { result, tracePath } = await reviewWithSession({
      sessionFile: "missing",
      credential: "projected",
    });
    expect(result.status).toBe("ok");
    expect(result.stderrTail).toContain(MISSING_FILE);
    expect(existsSync(tracePath)).toBe(false);
  });

  test("a missing session file does not keep a transcript from an earlier run", async () => {
    const { result, tracePath } = await reviewWithSession({
      sessionFile: "missing",
      credential: "projected",
      staleTrace: true,
    });
    expect(result.status).toBe("ok");
    expect(result.stderrTail).toContain(MISSING_FILE);
    expect(existsSync(tracePath)).toBe(false);
  });

  test("an attempt without a projection copies from the operator config home", async () => {
    const { result, tracePath, operatorConfig, spawnedArgs } =
      await reviewWithSession({
        sessionFile: "written",
        credential: "operator",
      });
    const sessionId = flagValue(spawnedArgs[0] ?? [], "--session-id");
    expect(result.status).toBe("ok");
    expect(await Bun.file(tracePath).text()).toBe(REDACTED);
    expect(
      await Bun.file(
        path.join(
          operatorConfig ?? "",
          "projects",
          "work-repo",
          `${sessionId}.jsonl`,
        ),
      ).text(),
    ).toBe(TRANSCRIPT);
  });

  test("the CLI is given its own session id, a fresh UUID", async () => {
    const { spawnedArgs } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
    });
    expect(spawnedArgs).toHaveLength(1);
    const sessionId = flagValue(spawnedArgs[0] ?? [], "--session-id");
    expect(sessionId).toMatch(UUID);
    expect(sessionId).not.toBe(SESSION_ID);
  });

  test("the session id the engine passed wins over the one the result reports", async () => {
    const { result, tracePath } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
      resultSessionId: OTHER_SESSION_ID,
    });
    expect(result.status).toBe("ok");
    expect(result.stderrTail).not.toContain(NOT_COPIED);
    expect(await Bun.file(tracePath).text()).toBe(REDACTED);
  });

  test("a timed-out attempt whose CLI never finishes keeps its transcript", async () => {
    const { result, tracePath, broker } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
      cli: "dies-on-signal",
      timeoutMs: 200,
    });
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(result.stderrTail).toContain("Step timed out after 200ms");
    expect(result.stderrTail).not.toContain(NOT_COPIED);
    expect(await Bun.file(tracePath).text()).toBe(REDACTED);
    expect(broker?.destroyCalls).toBe(1);
  });

  test("a timed-out attempt keeps its transcript while the CLI ignores every signal", async () => {
    const { result, tracePath, broker } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
      cli: "ignores-signals",
      timeoutMs: 200,
    });
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(result.stderrTail).toContain("Step timed out after 200ms");
    expect(result.stderrTail).not.toContain(NOT_COPIED);
    expect(await Bun.file(tracePath).text()).toBe(REDACTED);
    expect(broker?.destroyCalls).toBe(1);
  });

  test("a timed-out attempt with no session file warns and keeps no earlier transcript", async () => {
    const { result, tracePath } = await reviewWithSession({
      sessionFile: "missing",
      credential: "projected",
      cli: "dies-on-signal",
      timeoutMs: 200,
      staleTrace: true,
    });
    expect(result.status).toBe("failed");
    expect(result.stderrTail).toContain("Step timed out after 200ms");
    expect(result.stderrTail).toContain(MISSING_FILE);
    expect(existsSync(tracePath)).toBe(false);
  });

  test("an attempt cancelled mid-run keeps its transcript", async () => {
    const { result, tracePath, broker } = await reviewWithSession({
      sessionFile: "written",
      credential: "projected",
      cli: "dies-on-signal",
      cancelAfterSpawn: true,
    });
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(await Bun.file(tracePath).text()).toBe(REDACTED);
    expect(broker?.destroyCalls).toBe(1);
  });

  test("an attempt cancelled before its session file exists keeps no earlier transcript", async () => {
    const { result, tracePath } = await reviewWithSession({
      sessionFile: "missing",
      credential: "projected",
      cli: "dies-on-signal",
      cancelAfterSpawn: true,
      staleTrace: true,
    });
    expect(result.status).toBe("failed");
    expect(existsSync(tracePath)).toBe(false);
  });
});

const HUNTER_TOOLS = "Read, Grep, Glob, mcp__codegraph__codegraph_explore";

class TraceRunner implements StepRunner {
  async run(spec: StepSpec): Promise<StepResult> {
    if (spec.name === "hunter-reliability") {
      for (const attempt of [1, 2]) {
        await Bun.write(
          path.join(
            path.dirname(spec.outPath),
            `trace.${spec.name}.attempt${attempt}.jsonl`,
          ),
          `${spec.name} attempt ${attempt}\n`,
        );
      }
    }
    return {
      name: spec.name,
      status: "ok",
      output: { findings: [] },
      usage: {
        wall_ms: 1,
        tokens_in: 1,
        tokens_out: 1,
        tokens_total: 2,
        cost_usd_est: 0,
      },
      attempts: spec.name === "hunter-reliability" ? 2 : 1,
      stderrTail: "",
      resultText: "",
    };
  }
}

async function pipelineInput(): Promise<PipelineInput> {
  const agentsDir = await scratchDir("pr-hero-trace-agents-");
  for (const name of [
    "deep-review-reliability",
    "deep-review-resilience",
    "deep-review-parity",
  ]) {
    await Bun.write(
      path.join(agentsDir, `${name}.md`),
      [
        "---",
        `name: ${name}`,
        `description: ${name} hunter`,
        "model: sonnet",
        `tools: ${HUNTER_TOOLS}`,
        "---",
        "",
        "Hunt bugs.",
        "",
        "{{PRIORS}}",
        "",
        "{{GOTCHAS}}",
        "",
      ].join("\n"),
    );
  }
  await Bun.write(
    path.join(agentsDir, "review-refuter.md"),
    [
      "---",
      "name: review-refuter",
      "description: refuter",
      "model: sonnet",
      "tools: Read, Grep, Glob",
      "---",
      "",
      "Refute.",
      "",
    ].join("\n"),
  );
  const runDir = await scratchDir("pr-hero-trace-pipe-");
  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(
    diffPath,
    [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
  );
  await Bun.write(path.join(runDir, "gotchas.md"), "G-01: units.");
  return {
    pr: 1539,
    baseSha: "06e857b3a91c4d20fe7b8635a1c02d94ff31ab77",
    headSha: "4609456d0f2a1b8c7e3d59a4f60b21c8d7e94a05",
    worktree: "/worktrees/dr-1539",
    diffPath,
    gotchasPath: path.join(runDir, "gotchas.md"),
    agentsDir,
    runDir,
    outPath: path.join(runDir, "findings.json"),
    mcpConfigPath: "/runs/mcp.json",
    hopBudget: 12,
    parityTriggerPaths: [],
    suspicionPriors: [],
  };
}

describe("pipeline.json session traces", () => {
  test("records each copied attempt and omits the field when no copy exists", async () => {
    const input = await pipelineInput();
    await runPipeline(input, { runner: new TraceRunner() });
    const plan = (await Bun.file(
      path.join(input.runDir, "pipeline.json"),
    ).json()) as {
      steps: Array<{ name: string; tracePaths?: string[] }>;
    };
    const reliability = plan.steps.find(
      (step) => step.name === "hunter-reliability",
    );
    const resilience = plan.steps.find(
      (step) => step.name === "hunter-resilience",
    );
    expect(reliability?.tracePaths).toEqual([
      "steps/trace.hunter-reliability.attempt1.jsonl",
      "steps/trace.hunter-reliability.attempt2.jsonl",
    ]);
    expect(resilience?.tracePaths).toBeUndefined();
  });
});
