import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineInput } from "#review/pipeline";
import { runPipeline } from "#review/pipeline";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import { StepExecutionHarness } from "../../src/execution/harness";
import type {
  CredentialBroker,
  CredentialProjection,
} from "../../src/security/credential-broker";
import { ClaudeCodeCliTransport } from "../../src/transports/claude-code-cli";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "sk-a1B2c3D4e5F6g7H8";
const TRANSCRIPT = `{"role":"assistant","text":"leak ${SECRET}"}\n`;
const REDACTED = `{"role":"assistant","text":"leak [REDACTED]"}\n`;
const STEP = "hunter-reliability";
const MISSING_FILE =
  "[pr-hero] claude session trace was not copied (session file missing)";

class FakeBroker implements CredentialBroker {
  destroyCalls = 0;
  lastHome?: string;

  async project(): Promise<CredentialProjection> {
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-trace-proj-"));
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
        const { rm } = await import("node:fs/promises");
        await rm(home, { recursive: true, force: true });
      },
    };
  }
}

function cliResult(): string {
  return JSON.stringify({
    result: "{}",
    num_turns: 2,
    session_id: SESSION_ID,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
}

function fakeProc(stdoutBody: string) {
  const exited = Promise.resolve(0);
  const encoder = new TextEncoder();
  const stream = (body: string) =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await exited;
        if (body.length > 0) controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  return {
    stdout: stream(stdoutBody),
    stderr: stream(""),
    exited,
    kill() {},
  };
}

async function reviewWithSession(options: {
  sessionFile: "written" | "missing";
  credential: "projected" | "operator";
}): Promise<{
  result: StepResult;
  tracePath: string;
  broker: FakeBroker | undefined;
  operatorConfig: string | undefined;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "pr-hero-trace-run-"));
  const steps = path.join(root, "steps");
  mkdirSync(steps);
  const systemPromptPath = path.join(steps, `${STEP}.system.md`);
  await Bun.write(systemPromptPath, "system prompt");
  await chmod(systemPromptPath, 0o600);
  const operatorHome = await mkdtemp(path.join(tmpdir(), "pr-hero-trace-op-"));
  const operatorConfig = path.join(operatorHome, "claude-config");
  mkdirSync(operatorConfig);
  const broker =
    options.credential === "projected" ? new FakeBroker() : undefined;
  const transport = new ClaudeCodeCliTransport({
    spawnFn: ((_args: string[], opts: { env?: Record<string, string> }) => {
      const env = opts.env ?? {};
      if (options.sessionFile === "written") {
        const config =
          env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? "", ".claude");
        const file = path.join(
          config,
          "projects",
          "work-repo",
          `${SESSION_ID}.jsonl`,
        );
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, TRANSCRIPT);
      }
      return fakeProc(cliResult());
    }) as unknown as typeof Bun.spawn,
    getPgid: (pid) => pid,
    killFn: () => {},
  });
  const harness = new StepExecutionHarness({
    transport,
    spawnFn: (() => {
      throw new Error("harness spawnFn must not run");
    }) as unknown as typeof Bun.spawn,
    credentialBroker: broker,
    childEnv: {
      HOME: operatorHome,
      USER: "reviewer",
      PATH: "/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: operatorConfig,
    },
  });
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
    timeoutMs: 1000,
    maxAttempts: 1,
    parse: (text) => JSON.parse(text),
  });
  return {
    result,
    tracePath: path.join(steps, `trace.${STEP}.attempt1.jsonl`),
    broker,
    operatorConfig:
      options.credential === "operator" ? operatorConfig : undefined,
  };
}

describe("Claude session trace", () => {
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

  test("a missing session file still finishes the attempt and warns", async () => {
    const { result, tracePath } = await reviewWithSession({
      sessionFile: "missing",
      credential: "projected",
    });
    expect(result.status).toBe("ok");
    expect(result.stderrTail).toContain(MISSING_FILE);
    expect(existsSync(tracePath)).toBe(false);
  });

  test("an attempt without a projection copies from the operator config home", async () => {
    const { result, tracePath, operatorConfig } = await reviewWithSession({
      sessionFile: "written",
      credential: "operator",
    });
    expect(result.status).toBe("ok");
    expect(await Bun.file(tracePath).text()).toBe(REDACTED);
    expect(
      await Bun.file(
        path.join(
          operatorConfig ?? "",
          "projects",
          "work-repo",
          `${SESSION_ID}.jsonl`,
        ),
      ).text(),
    ).toBe(TRANSCRIPT);
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
  const agentsDir = await mkdtemp(path.join(tmpdir(), "pr-hero-trace-agents-"));
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
  const runDir = await mkdtemp(path.join(tmpdir(), "pr-hero-trace-pipe-"));
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
