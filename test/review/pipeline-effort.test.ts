// odd/tasks/role-model-routing.md S7 (E-g, E2): a `models` entry's `effort`
// reaches the backend. Claude gets it as `--effort`, observed here on the argv
// a fake spawn records; precedence is the entry's effort, then the prompt's
// `effort:` frontmatter, then the role's default. `--model` reads no `models`
// entry. Each fallback runs at its own effort. OpenCode gets an effort only as
// the model variant an entry sets (D1), and pipeline.json says which.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelsConfig } from "#model/model-name";
import { type PipelineInput, runPipeline } from "#review/pipeline";
import type { ReviewSpec } from "#review/spec";
import {
  ClaudeCodeRunner,
  type StepResult,
  type StepRunner,
  type StepSpec,
} from "#review/step-runner";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  RunnerBackend,
} from "../../src/execution/contracts";
import {
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
} from "../../src/transport-registry";
import { CLAUDE_ERROR_ROWS, claudeErrorEnvelope } from "./claude-error-rows";

const MODEL_GONE = CLAUDE_ERROR_ROWS.find(
  (row) => row.cause === "model_unavailable",
);

function envelope(result: string): string {
  return JSON.stringify({
    result,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: 0.001,
  });
}

const NO_FINDINGS = envelope(JSON.stringify({ findings: [] }));

// Records each spawn's argv and answers from a script, the last entry
// repeating. Every stream closes at once: no step here hangs.
function fakeSpawn(script: string[]): {
  spawnFn: typeof Bun.spawn;
  argvs: string[][];
} {
  const argvs: string[][] = [];
  const encoder = new TextEncoder();
  const spawnFn = ((argv: string[]) => {
    const stdout =
      script[Math.min(argvs.length, script.length - 1)] ?? NO_FINDINGS;
    argvs.push(argv);
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    return {
      stdout: stream(stdout),
      stderr: stream(""),
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, argvs };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function setup(options: {
  frontmatterEffort?: string;
  models?: ModelsConfig;
  model?: string;
}) {
  const tmp = await mkdtemp(path.join(tmpdir(), "pr-hero-pipe-effort-"));
  const runDir = path.join(tmp, "run");
  const agentsDir = path.join(tmp, "agents");
  const worktree = path.join(tmp, "worktree");
  await mkdir(runDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(path.join(worktree, "src"), { recursive: true });
  const effortLine =
    options.frontmatterEffort === undefined
      ? ""
      : `effort: ${options.frontmatterEffort}\n`;
  await Bun.write(
    path.join(agentsDir, "reliability.md"),
    `---\nname: reliability\nmodel: sonnet\n${effortLine}tools: [Read, Grep]\n---\nYou are the reliability hunter.`,
  );
  await Bun.write(path.join(worktree, "src", "index.ts"), "const x = 2;\n");
  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(
    diffPath,
    "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  );
  await Bun.write(path.join(runDir, "gotchas.json"), "[]");
  await Bun.write(path.join(runDir, "mcp.json"), "{}");
  const spec: ReviewSpec = {
    agents: [{ key: "reliability", file: "reliability.md", role: "hunter" }],
  };
  const input: PipelineInput = {
    pr: 42,
    baseSha: "1111111111111111111111111111111111111111",
    headSha: "2222222222222222222222222222222222222222",
    worktree,
    diffPath,
    gotchasPath: path.join(runDir, "gotchas.json"),
    agentsDir,
    runDir,
    outPath: path.join(runDir, "findings.json"),
    mcpConfigPath: path.join(runDir, "mcp.json"),
    hopBudget: 2,
    parityTriggerPaths: [],
    suspicionPriors: [],
    spec,
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };
  return {
    runDir,
    input,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

// The `--effort` of each Claude spawn the hunter made.
async function spawnedEfforts(
  options: Parameters<typeof setup>[0],
  script: string[] = [NO_FINDINGS],
): Promise<{ efforts: (string | undefined)[]; pipeline: PipelineJson }> {
  const env = await setup(options);
  try {
    const { spawnFn, argvs } = fakeSpawn(script);
    await runPipeline(env.input, {
      runner: new ClaudeCodeRunner({ spawnFn, childEnv: {} }),
    });
    const pipeline = JSON.parse(
      await Bun.file(path.join(env.runDir, "pipeline.json")).text(),
    ) as PipelineJson;
    return {
      efforts: argvs.map((argv) => flagValue(argv, "--effort")),
      pipeline,
    };
  } finally {
    await env.cleanup();
  }
}

interface StepRow {
  name: string;
  effort: string;
  effort_applied?: boolean;
  variant?: string;
  model_attempts?: Array<Record<string, unknown>>;
}
interface PipelineJson {
  steps: StepRow[];
}

function hunterRow(pipeline: PipelineJson): StepRow {
  const row = pipeline.steps.find((s) => s.name === "hunter-reliability");
  if (row === undefined) throw new Error("no hunter row");
  return row;
}

describe("a Claude step's --effort (S7 precedence)", () => {
  test("the entry's effort beats the prompt's frontmatter", async () => {
    const { efforts, pipeline } = await spawnedEfforts({
      frontmatterEffort: "medium",
      models: {
        "hunter.reliability": [
          { model: "claude:sonnet-latest", effort: "low" },
        ],
      },
    });
    expect(efforts).toEqual(["low"]);
    expect(hunterRow(pipeline).effort).toBe("low");
    expect(hunterRow(pipeline).effort_applied).toBe(true);
  });

  test("with no entry effort, the frontmatter beats the role default", async () => {
    const { efforts } = await spawnedEfforts({
      frontmatterEffort: "medium",
      models: { "hunter.reliability": ["claude:sonnet-latest"] },
    });
    expect(efforts).toEqual(["medium"]);
  });

  test("with neither, the role default (a hunter runs at xhigh)", async () => {
    const { efforts, pipeline } = await spawnedEfforts({
      models: { "hunter.reliability": ["claude:sonnet-latest"] },
    });
    expect(efforts).toEqual(["xhigh"]);
    // One model: no model_attempts, exactly as before E2.
    expect(hunterRow(pipeline)).not.toHaveProperty("model_attempts");
    expect(hunterRow(pipeline)).not.toHaveProperty("variant");
  });

  test("models.default's entry effort applies to a role it fills", async () => {
    const { efforts } = await spawnedEfforts({
      frontmatterEffort: "medium",
      models: { default: [{ model: "claude:opus-latest", effort: "max" }] },
    });
    expect(efforts).toEqual(["max"]);
  });

  test("zero config: the role default, as before", async () => {
    const { efforts, pipeline } = await spawnedEfforts({});
    expect(efforts).toEqual(["xhigh"]);
    expect(hunterRow(pipeline).effort_applied).toBe(true);
  });
});

describe("--model reads no models entry (D4)", () => {
  test("its step runs at the frontmatter's effort, not the entry's", async () => {
    const { efforts } = await spawnedEfforts({
      frontmatterEffort: "medium",
      model: "sonnet",
      models: {
        "hunter.reliability": [{ model: "claude:opus-latest", effort: "low" }],
      },
    });
    expect(efforts).toEqual(["medium"]);
  });

  test("and at the role default without one", async () => {
    const { efforts } = await spawnedEfforts({
      model: "sonnet",
      models: { default: [{ model: "claude:opus-latest", effort: "low" }] },
    });
    expect(efforts).toEqual(["xhigh"]);
  });
});

describe("each fallback runs at its own effort (S4 with S7)", () => {
  test("a fallback without an entry effort runs at the frontmatter's, not the first model's", async () => {
    if (MODEL_GONE === undefined) throw new Error("no model_unavailable row");
    const { efforts, pipeline } = await spawnedEfforts(
      {
        frontmatterEffort: "medium",
        models: {
          "hunter.reliability": [
            { model: "claude:sonnet-latest", effort: "max" },
            "claude:opus-latest",
          ],
        },
      },
      [claudeErrorEnvelope(MODEL_GONE), NO_FINDINGS],
    );
    // The first model may retry inside its own budget; every spawn of it
    // runs at max, and the fallback at medium.
    expect(efforts.at(-1)).toBe("medium");
    expect(new Set(efforts.slice(0, -1))).toEqual(new Set(["max"]));
    const row = hunterRow(pipeline);
    // The step records the effort of the model that ran.
    expect(row.effort).toBe("medium");
    expect(
      row.model_attempts?.map((a) => [a.model, a.effort, a.effort_applied]),
    ).toEqual([
      ["sonnet", "max", true],
      ["opus", "medium", true],
    ]);
  });

  test("a fallback with its own entry effort runs at it", async () => {
    if (MODEL_GONE === undefined) throw new Error("no model_unavailable row");
    const { efforts } = await spawnedEfforts(
      {
        models: {
          "hunter.reliability": [
            "claude:sonnet-latest",
            { model: "claude:opus-latest", effort: "low" },
          ],
        },
      },
      [claudeErrorEnvelope(MODEL_GONE), NO_FINDINGS],
    );
    expect(efforts.at(-1)).toBe("low");
    expect(new Set(efforts.slice(0, -1))).toEqual(new Set(["xhigh"]));
  });
});

// OpenCode: the transport is never reached here, so a recording runner stands
// in for it; what matters is what the step carries and what pipeline.json says.
function capableOpenCode(): ProviderTransport {
  return {
    backend: "opencode",
    capabilities: async (): Promise<ProviderCapabilityReport> => ({
      backend: "opencode",
      status: "ready",
      auth: {
        kind: "opencode_chatgpt_oauth",
        projectionReady: true,
        probe: "passed",
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: true,
        codegraphPolicy: true,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: true,
        usageMode: "snapshot",
      },
      cancellation: { deadlineMs: 5000, conformance: "passed" },
      billing: { mode: "subscription", pricingReady: true },
      issues: [],
    }),
    execute: async () => {
      throw new Error("the pipeline test runs no transport");
    },
    classifyFailure: () => undefined,
  };
}

const READY: D1_11ReadinessEvidence = {
  sdkAvailable: true,
  credentialAuthority: true,
  workspaceBroker: true,
  pricingReady: true,
};

async function openCodeRun(
  options: Parameters<typeof setup>[0],
): Promise<{ steps: StepSpec[]; pipeline: PipelineJson }> {
  const env = await setup(options);
  try {
    const steps: StepSpec[] = [];
    const runner: StepRunner = {
      run: async (step): Promise<StepResult> => {
        steps.push(step);
        return {
          name: step.name,
          status: "ok",
          output: { findings: [] },
          usage: {
            tokens_in: 1,
            tokens_out: 1,
            tokens_total: 2,
            wall_ms: 1,
            cost_usd_est: 0,
          },
          attempts: 1,
          stderrTail: "",
          resultText: '{"findings":[]}',
        };
      },
    };
    const registry = new DefaultTransportRegistry();
    registry.register("opencode", capableOpenCode());
    await runPipeline(env.input, {
      runner,
      transportRegistry: registry,
      admissionEvidence: new Map<RunnerBackend, D1_11ReadinessEvidence>([
        ["opencode", READY],
      ]),
    });
    const pipeline = JSON.parse(
      await Bun.file(path.join(env.runDir, "pipeline.json")).text(),
    ) as PipelineJson;
    return { steps, pipeline };
  } finally {
    await env.cleanup();
  }
}

describe("an OpenCode step's variant comes only from its entry (D1)", () => {
  test("a frontmatter effort sends no variant, and the record says it was not applied", async () => {
    const { steps, pipeline } = await openCodeRun({
      frontmatterEffort: "high",
      models: { "hunter.reliability": ["opencode:openai/gpt-5"] },
    });
    const hunter = steps.find((s) => s.name === "hunter-reliability");
    expect(hunter?.route).not.toHaveProperty("modelVariant");
    const row = hunterRow(pipeline);
    expect(row.effort).toBe("high");
    expect(row.effort_applied).toBe(false);
    expect(row).not.toHaveProperty("variant");
  });

  test("an entry effort is the variant sent, and the record names it", async () => {
    const { steps, pipeline } = await openCodeRun({
      frontmatterEffort: "high",
      models: {
        "hunter.reliability": [
          { model: "opencode:openai/gpt-5", effort: "minimal" },
        ],
      },
    });
    const hunter = steps.find((s) => s.name === "hunter-reliability");
    expect(hunter?.route?.modelVariant).toBe("minimal");
    // The Claude-scale `effort` stays the prompt's: an OpenCode variant is
    // not a Claude level and never lands in that field.
    expect(hunter?.effort).toBe("high");
    const row = hunterRow(pipeline);
    expect(row.effort).toBe("high");
    expect(row.effort_applied).toBe(true);
    expect(row.variant).toBe("minimal");
  });
});
