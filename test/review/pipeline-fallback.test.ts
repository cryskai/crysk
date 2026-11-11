// odd/tasks/role-model-routing.md S4 (E-d): a step whose role lists several
// models carries them all to its runner, and pipeline.json, the failed-hunter
// record and the platform report name the model that actually ran.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeRunEnvelope } from "#review/findings";
import { type PipelineInput, runPipeline } from "#review/pipeline";
import { buildTelemetry } from "#review/run";
import type { ReviewSpec } from "#review/spec";
import type {
  ModelAttempt,
  StepResult,
  StepRunner,
  StepSpec,
} from "#review/step-runner";
import { buildRunReport } from "../../src/ci/platform-report";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  ResolvedModelRoute,
  RunnerBackend,
} from "../../src/execution/contracts";
import type { NormalizedUsage } from "../../src/execution/usage-normalized";
import {
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
} from "../../src/transport-registry";

const HEAD = "2222222222222222222222222222222222222222";

const USAGE: NormalizedUsage = {
  wallMs: 5,
  tokens: { inputKnown: 8, outputKnown: 2, totalKnown: 10 },
  completeness: "complete",
  billingMode: "subscription",
  costSource: "subscription",
};

const GPT: ResolvedModelRoute = {
  backend: "opencode",
  provider: "openai",
  modelFamily: "gpt-4o",
  modelSnapshot: "gpt-4o",
};

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

async function setup() {
  const tmp = await mkdtemp(path.join(tmpdir(), "pr-hero-pipe-fallback-"));
  const runDir = path.join(tmp, "run");
  const agentsDir = path.join(tmp, "agents");
  const worktree = path.join(tmp, "worktree");
  await mkdir(runDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(path.join(worktree, "src"), { recursive: true });
  await Bun.write(
    path.join(agentsDir, "reliability.md"),
    "---\nname: reliability\nmodel: sonnet\ntools: [Read, Grep]\n---\nYou are the reliability hunter.",
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
    headSha: HEAD,
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
    models: {
      "hunter.reliability": ["claude:sonnet-latest", "opencode:openai/gpt-4o"],
    },
  };
  return {
    runDir,
    input,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

// The hunter fell back from sonnet to the OpenCode model, as the runtime
// reports it; `status` is how that model ended.
function fellBack(
  step: StepSpec,
  status: "ok" | "failed",
): { result: StepResult; attempts: ModelAttempt[] } {
  const first = step.route;
  if (first === undefined) throw new Error("the hunter carries no route");
  const attempts: ModelAttempt[] = [
    {
      route: first,
      status: "failed",
      attempts: 1,
      cause: "rate_limit",
      usageV2: USAGE,
    },
    {
      route: GPT,
      status,
      attempts: 1,
      ...(status === "ok" ? {} : { cause: "model_unavailable" as const }),
      usageV2: USAGE,
    },
  ];
  return {
    attempts,
    result: {
      name: step.name,
      status,
      ...(status === "ok" ? { output: { findings: [] } } : {}),
      usage: {
        tokens_in: 16,
        tokens_out: 4,
        tokens_total: 20,
        wall_ms: 10,
        cost_usd_est: 0,
      },
      attempts: 2,
      ...(status === "ok"
        ? {}
        : {
            failureCause: "model_unavailable" as const,
            finalCause: "model_unavailable" as const,
          }),
      modelAttempts: attempts,
      stderrTail: "",
      resultText: status === "ok" ? '{"findings":[]}' : "",
    },
  };
}

function deps(runner: StepRunner) {
  const registry = new DefaultTransportRegistry();
  registry.register("opencode", capableOpenCode());
  return {
    runner,
    transportRegistry: registry,
    admissionEvidence: new Map<RunnerBackend, D1_11ReadinessEvidence>([
      ["opencode", READY],
    ]),
  };
}

describe("a hunter whose role lists two models", () => {
  test("its step carries the second model as its fallback", async () => {
    const env = await setup();
    try {
      const seen: StepSpec[] = [];
      const runner: StepRunner = {
        run: async (step) => {
          seen.push(step);
          return fellBack(step, "ok").result;
        },
      };
      await runPipeline(env.input, deps(runner));
      const hunter = seen.find((s) => s.name === "hunter-reliability");
      expect(hunter?.route?.modelSnapshot).toBe("sonnet");
      expect(hunter?.fallbackRoutes).toEqual([GPT]);
    } finally {
      await env.cleanup();
    }
  });

  test("pipeline.json and the platform report name the model that ran", async () => {
    const env = await setup();
    try {
      const runner: StepRunner = {
        run: async (step) => fellBack(step, "ok").result,
      };
      const result = await runPipeline(env.input, deps(runner));
      const pipeline = JSON.parse(
        await Bun.file(path.join(env.runDir, "pipeline.json")).text(),
      );
      const meta = pipeline.steps.find(
        (s: { name: string }) => s.name === "hunter-reliability",
      );
      expect(meta.model).toBe("gpt-4o");
      expect(meta.route).toEqual(GPT);
      // OpenCode has no `--effort`: the record must not claim it applied.
      expect(meta.effort_applied).toBe(false);
      expect(meta.attempts).toBe(2);
      expect(meta.model_attempts).toEqual([
        {
          model: "sonnet",
          route: {
            backend: "claude-code",
            provider: "anthropic",
            modelFamily: "sonnet",
            modelSnapshot: "sonnet",
          },
          status: "failed",
          attempts: 1,
          // S7: each row says the effort its model was asked for and whether
          // its backend was sent one. The fake runner reports no per-model
          // effort, so each row carries the step's (the hunter default).
          effort: "xhigh",
          effort_applied: true,
          cause: "rate_limit",
          usage_v2: USAGE,
        },
        {
          model: "gpt-4o",
          route: GPT,
          status: "ok",
          attempts: 1,
          effort: "xhigh",
          // No entry effort on OpenCode: no variant sent (D1).
          effort_applied: false,
          usage_v2: USAGE,
        },
      ]);

      // The findings.json the CLI writes beside that pipeline.json
      // (writeRunFindings): the skill output in the run envelope, with the
      // run's per-agent telemetry.
      const findings = JSON.parse(
        JSON.stringify(
          mergeRunEnvelope({
            skillOutput: result.skillOutput,
            pr: 42,
            base_sha: env.input.baseSha,
            head_sha: HEAD,
            model: "sonnet",
            iteration: 0,
            engine: { name: "crysk", version: "0.0.0" },
            sessionFailed: result.sessionFailed,
            telemetry: buildTelemetry(result, 10, 0),
          }),
        ),
      );
      const report = buildRunReport({
        outcome: "success",
        prNumber: 42,
        triggerHeadSha: HEAD,
        run: { findings, pipeline },
      });
      const agent = report?.agents.find((a) => a.agent_key === "reliability");
      expect(agent?.model).toBe("gpt-4o");
    } finally {
      await env.cleanup();
    }
  });

  test("a hunter that failed on its fallback is reported with the fallback's provider and model", async () => {
    const env = await setup();
    try {
      const runner: StepRunner = {
        run: async (step) => fellBack(step, "failed").result,
      };
      const result = await runPipeline(env.input, deps(runner));
      expect(result.hunterFailures).toEqual([
        {
          name: "hunter-reliability",
          cause: "model_unavailable",
          provider: "openai",
          model: "gpt-4o",
        },
      ]);
    } finally {
      await env.cleanup();
    }
  });
});
