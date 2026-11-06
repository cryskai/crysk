import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createResolvedRoutePlan, resolveStepRoute } from "#model/routing";
import type { DraftFinding, HunterDraft, RefuterResult } from "#review/drafts";
import { type PipelineInput, runPipeline } from "#review/pipeline";
import { defaultReviewSpec, validateReviewSpec } from "#review/spec";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import {
  appendAttempt,
  type DiversityAttemptRecord,
  emptyDiversityLedger,
} from "../../src/diversity/accounting";
import {
  DiversityAdmissionError,
  DiversityCapabilityError,
  DiversityTargetError,
} from "../../src/diversity/errors";
import { buildDiversityPlan } from "../../src/diversity/identity";
import {
  assertDiversityLegRoutes,
  assertDiversitySpendUnderCap,
  prepareDiversityExecution,
  recordDiversityHunterResult,
} from "../../src/diversity/pipeline-integration";
import { normalizeInclusiveUsage } from "../../src/execution/usage-normalized";
import type { SessionUsage } from "../../src/usage";

function usage(): SessionUsage {
  return {
    wall_ms: 1_000,
    tokens_in: 100,
    tokens_out: 10,
    tokens_total: 110,
    cost_usd_est: 0.01,
  };
}

function ok(spec: StepSpec, output: unknown): StepResult {
  return {
    name: spec.name,
    status: "ok",
    output,
    usage: usage(),
    attempts: 1,
    stderrTail: "",
    resultText: "",
  };
}

const HUNTER_TOOLS = "Read, Grep, Glob, mcp__codegraph__codegraph_explore";

async function makeDefaultAgentsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-diversity-agents-"));
  const hunterBody = (name: string) =>
    [
      "---",
      `name: ${name}`,
      `description: ${name} hunter`,
      "model: sonnet",
      `tools: ${HUNTER_TOOLS}`,
      "---",
      "",
      "{{PRIORS}}",
      "{{GOTCHAS}}",
      "",
    ].join("\n");
  for (const name of [
    "deep-review-reliability",
    "deep-review-resilience",
    "deep-review-parity",
  ]) {
    await Bun.write(path.join(dir, `${name}.md`), hunterBody(name));
  }
  await Bun.write(
    path.join(dir, "review-refuter.md"),
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
  return dir;
}

async function makeAgentsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-diversity-agents-"));
  const hunterBody = [
    "---",
    "name: deep-review-reliability",
    "description: reliability hunter",
    "model: sonnet",
    `tools: ${HUNTER_TOOLS}`,
    "---",
    "",
    "{{PRIORS}}",
    "{{GOTCHAS}}",
    "",
  ].join("\n");
  await Bun.write(path.join(dir, "deep-review-reliability.md"), hunterBody);
  await Bun.write(
    path.join(dir, "review-refuter.md"),
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
  return dir;
}

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

async function makeInput(): Promise<PipelineInput> {
  const runDir = await mkdtemp(path.join(tmpdir(), "pr-hero-diversity-run-"));
  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(diffPath, PATCH);
  const gotchasPath = path.join(runDir, "gotchas.md");
  await Bun.write(gotchasPath, "G-01: gotcha.");
  return {
    pr: 1539,
    baseSha: "06e857b3",
    headSha: "4609456d",
    worktree: "/worktrees/dr-1539",
    diffPath,
    gotchasPath,
    agentsDir: await makeAgentsDir(),
    runDir,
    outPath: path.join(runDir, "findings.json"),
    mcpConfigPath: "/runs/mcp.json",
    hopBudget: 12,
    parityTriggerPaths: [],
    suspicionPriors: [],
    spec: validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "m6-diversity",
        maxLegs: 3,
        cashCapUsd: 25,
      },
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          models: ["sonnet", "opus"],
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    }),
  };
}

class DiversityFakeRunner implements StepRunner {
  readonly specs: StepSpec[] = [];

  async run(spec: StepSpec): Promise<StepResult> {
    this.specs.push(spec);
    if (spec.name.startsWith("hunter-reliability")) {
      return ok(spec, { findings: [] } satisfies HunterDraft);
    }
    throw new Error(`unscripted step ${spec.name}`);
  }
}

describe("pipeline diversity integration", () => {
  test("fans out admitted hunter legs and records diversity debug artifacts", async () => {
    const input = await makeInput();
    const runner = new DiversityFakeRunner();
    const result = await runPipeline(input, { runner });

    const hunterSteps = runner.specs.filter((spec) =>
      spec.name.startsWith("hunter-reliability"),
    );
    expect(hunterSteps).toHaveLength(2);
    expect(new Set(hunterSteps.map((spec) => spec.name)).size).toBe(2);

    const diversity = result.skillOutput.debug.diversity;
    expect(diversity).toBeDefined();
    expect(Array.isArray(diversity?.attempts)).toBe(true);
    expect(diversity?.attempts).toHaveLength(2);
    expect(result.skillOutput.run_status).toBe("complete");

    const pipelineJson = JSON.parse(
      await Bun.file(path.join(input.runDir, "pipeline.json")).text(),
    );
    expect(pipelineJson.multiModelDiversity?.enabled).toBe(true);
    expect(pipelineJson.multiModelDiversity?.legCount).toBe(2);
  });

  test("records partial failure when one diversity leg rejects before settlement", async () => {
    const input = await makeInput();
    let reliabilityCalls = 0;
    const runner: StepRunner = {
      async run(spec) {
        if (spec.name.startsWith("hunter-reliability")) {
          reliabilityCalls++;
          if (reliabilityCalls === 1) {
            throw new Error("spawn rejected");
          }
          return ok(spec, { findings: [] } satisfies HunterDraft);
        }
        throw new Error(`unscripted step ${spec.name}`);
      },
    };
    const result = await runPipeline(input, { runner });
    expect(result.skillOutput.run_status).toBe("partial");
    const diversity = result.skillOutput.debug.diversity as {
      attempts?: Array<{ status?: string }>;
    };
    expect(diversity?.attempts?.length).toBeGreaterThan(0);
    const failed = diversity?.attempts?.find(
      (attempt) => attempt.status === "failed",
    );
    expect(failed).toBeDefined();
  });

  test("legacy default run keeps singular hunters without diversity artifacts", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "pr-hero-legacy-run-"));
    const diffPath = path.join(runDir, "diff.patch");
    await Bun.write(diffPath, PATCH);
    const gotchasPath = path.join(runDir, "gotchas.md");
    await Bun.write(gotchasPath, "G-01: gotcha.");
    const input: PipelineInput = {
      pr: 1539,
      baseSha: "06e857b3",
      headSha: "4609456d",
      worktree: "/worktrees/dr-1539",
      diffPath,
      gotchasPath,
      agentsDir: await makeDefaultAgentsDir(),
      runDir,
      outPath: path.join(runDir, "findings.json"),
      mcpConfigPath: "/runs/mcp.json",
      hopBudget: 12,
      parityTriggerPaths: [],
      suspicionPriors: [],
      spec: defaultReviewSpec(),
    };
    const specs: StepSpec[] = [];
    const runner: StepRunner = {
      async run(spec) {
        specs.push(spec);
        if (spec.name.startsWith("hunter-")) {
          return ok(spec, { findings: [] } satisfies HunterDraft);
        }
        throw new Error(`unscripted step ${spec.name}`);
      },
    };
    const result = await runPipeline(input, { runner });
    const hunterSteps = specs.filter((spec) => spec.name.startsWith("hunter-"));
    expect(hunterSteps).toHaveLength(2);
    expect(hunterSteps.map((spec) => spec.name).sort()).toEqual([
      "hunter-reliability",
      "hunter-resilience",
    ]);
    expect(result.skillOutput.debug.diversity).toBeUndefined();
    const pipelineJson = JSON.parse(
      await Bun.file(path.join(runDir, "pipeline.json")).text(),
    );
    expect(pipelineJson.multiModelDiversity).toEqual({
      enabled: false,
      status: "skipped",
    });
  });

  test("assertDiversityLegRoutes rejects route drift before hunter spawn", () => {
    const spec = validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "arm",
        maxLegs: 2,
        cashCapUsd: 10,
      },
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          models: ["sonnet", "opus"],
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    const plan = buildDiversityPlan({ spec, c2SchemaVersion: "1.1.0" });
    const leg = plan.legs[0];
    if (!leg) throw new Error("missing leg");
    const resolved = resolveStepRoute({
      stepKey: leg.stepKey,
      role: "hunter",
      specModel: leg.logicalModel,
    });
    const drifted = createResolvedRoutePlan([
      { ...resolved, routeFingerprint: "drifted-fingerprint" },
    ]);
    expect(() => assertDiversityLegRoutes(plan, drifted)).toThrow(
      DiversityAdmissionError,
    );
    expect(() => assertDiversityLegRoutes(plan, drifted)).toThrow(
      /route drift/,
    );
  });

  test("prepareDiversityExecution rejects frozen target drift before spawn", () => {
    const frozen = {
      repoId: "owner/repo",
      pr: 1539,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    };
    expect(() =>
      prepareDiversityExecution({
        reviewSpec: validateReviewSpec({
          multiModelDiversity: {
            enabled: true,
            armId: "arm",
            maxLegs: 2,
            cashCapUsd: 10,
          },
          agents: [
            {
              key: "reliability",
              file: "deep-review-reliability.md",
              role: "hunter",
              models: ["sonnet", "opus"],
            },
            { key: "refuter", file: "review-refuter.md", role: "refuter" },
          ],
        }),
        target: frozen,
        runtimeTarget: { ...frozen, headSha: "c".repeat(40) },
      }),
    ).toThrow(DiversityTargetError);
  });

  test("assertDiversitySpendUnderCap rejects projected spend above cash cap", () => {
    const spec = validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "arm",
        maxLegs: 2,
        cashCapUsd: 1,
      },
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          models: ["sonnet"],
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    const plan = buildDiversityPlan({ spec, c2SchemaVersion: "1.1.0" });
    const leg = plan.legs[0];
    if (!leg) throw new Error("missing leg");
    const attempt: DiversityAttemptRecord = {
      attemptId: `${leg.legId}-a1`,
      legId: leg.legId,
      armId: plan.armId,
      specialty: "reliability",
      replicate: 1,
      attempt: 1,
      status: "completed",
      usage: normalizeInclusiveUsage({
        wallMs: 1,
        inputTotal: 1,
        outputTotal: 1,
        billingMode: "unknown",
        costSource: "unknown",
        cashCostUsd: 2,
        notionalCostUsd: 2,
      }),
    };
    const ledger = appendAttempt(emptyDiversityLedger(), attempt);
    expect(() => assertDiversitySpendUnderCap(plan, ledger)).toThrow(
      DiversityAdmissionError,
    );
  });

  test("recordDiversityHunterResult stamps executed route provenance on observations", () => {
    const spec = validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "arm",
        maxLegs: 1,
        cashCapUsd: 10,
      },
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          models: ["sonnet"],
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    const plan = buildDiversityPlan({ spec, c2SchemaVersion: "1.1.0" });
    const leg = plan.legs[0];
    if (!leg) throw new Error("missing leg");
    const agent = spec.agents[0];
    if (!agent) throw new Error("missing agent");
    const executedRoute = {
      backend: "opencode" as const,
      provider: "openai",
      modelFamily: "gpt-4o",
      modelSnapshot: "gpt-4o-2024",
      modelVariant: "high",
    };
    const stepResult: StepResult = {
      name: "hunter-reliability",
      status: "ok",
      output: {
        findings: [
          {
            id: "REL-1",
            category: 1,
            path: "src/app.ts",
            line: 1,
            severity: "BLOCKER",
            evidence_class: "deterministic",
            causal_disposition: "introduced",
            claim: "bad",
            proof_refs: ["src/app.ts:1"],
            hunter: "reliability",
            hops_used: 0,
            hop_trail: [],
            dedupe_key: "k1",
          },
        ],
      },
      usage: usage(),
      attempts: 1,
      stderrTail: "",
      resultText: "",
    };
    const ledger = recordDiversityHunterResult(
      emptyDiversityLedger(),
      plan,
      agent,
      stepResult,
      leg,
      executedRoute,
    );
    const observation = ledger.observations[0]?.observation;
    expect(observation?.backend).toBe("opencode");
    expect(observation?.provider).toBe("openai");
    expect(observation).not.toHaveProperty("gateway");
    expect(observation?.modelFamily).toBe("gpt-4o");
    expect(observation?.modelSnapshot).toBe("gpt-4o-2024");
    expect(observation?.modelVariant).toBe("high");
  });

  test("projects adjudicated drafts instead of raw hunter duplicates", async () => {
    const input = await makeInput();
    const sharedFinding: DraftFinding = {
      id: "REL-1",
      category: 1,
      path: "src/app.ts",
      line: 10,
      symbol: "run",
      severity: "BLOCKER",
      evidence_class: "deterministic",
      causal_disposition: "introduced",
      claim: "value scaled twice along one path",
      proof_refs: ["src/app.ts:10"],
      hunter: "reliability",
      hops_used: 0,
      hop_trail: [],
      dedupe_key: "src/app.ts:run:1",
    };
    const runner: StepRunner = {
      async run(spec) {
        if (spec.name.startsWith("hunter-reliability")) {
          return ok(spec, {
            findings: [sharedFinding],
          } satisfies HunterDraft);
        }
        if (spec.name.startsWith("refuter")) {
          const findingId = spec.name.replace(/^refuter-/, "");
          return ok(spec, {
            results: [
              {
                finding_id: findingId,
                outcome: "corroborated",
                proof_refs: [],
              },
            ],
          } satisfies RefuterResult);
        }
        throw new Error(`unscripted step ${spec.name}`);
      },
    };
    const result = await runPipeline(input, { runner });
    expect(result.skillOutput.findings.length).toBeGreaterThan(0);
    const diversity = result.skillOutput.debug.diversity as {
      observations?: unknown[];
    };
    expect(diversity?.observations?.length).toBeGreaterThan(0);
  });

  test("prepareDiversityExecution blocks before spawn when capability is corrupt", () => {
    expect(() =>
      prepareDiversityExecution({
        reviewSpec: validateReviewSpec({
          multiModelDiversity: {
            enabled: true,
            armId: "arm",
            maxLegs: 2,
            cashCapUsd: 10,
          },
          agents: [
            {
              key: "reliability",
              file: "deep-review-reliability.md",
              role: "hunter",
              models: ["sonnet", "opus"],
            },
            { key: "refuter", file: "review-refuter.md", role: "refuter" },
          ],
        }),
        capabilityCheck: () => ({
          ok: false,
          c2SchemaVersion: "1.1.0",
          reason: "corrupt",
        }),
      }),
    ).toThrow(DiversityCapabilityError);
  });
});
