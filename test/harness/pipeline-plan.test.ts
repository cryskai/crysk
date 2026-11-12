// The pipeline harness plan (odd/tasks/route-plan-harness.md S4, S6).
// Offline: the fixtures are local git repos and every step is answered by a
// fake runner. The invariant under test is S6's: the plan a harness now passes
// equals the plan runPipeline built for itself from the same input, so what
// each probe measured before is what it measures now.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedRoutePlan } from "#model/routing";
import type { DraftFinding } from "#review/drafts";
import { type PipelineInput, runPipeline } from "#review/pipeline";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import {
  buildRefuterProbeFixture,
  refuterProbePipelineInput,
  runRefuterProbePipeline,
} from "../../fixtures/refuter-probe";
import {
  buildPlantedFixture,
  fixtureEvalPipelineInput,
} from "../../fixtures/setup";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
} from "../../src/execution/contracts";
import {
  buildPipelineHarnessPlan,
  readPipelineRouteIdentity,
} from "../../src/harness/pipeline-plan";
import { HarnessRouteError } from "../../src/harness/route-runner";
import { DefaultTransportRegistry } from "../../src/transport-registry";
import { zeroUsage } from "../../src/usage";

const REFUTER_SOURCE = path.resolve(
  import.meta.dir,
  "../../prompts/default/review-refuter.md",
);

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// The planted defect as one hunter's draft, so the refuter leg runs too.
const VOLUME_DRAFT: DraftFinding = {
  id: "REL-1",
  path: "src/volume.ts",
  line: 3,
  symbol: "volumeToGain",
  dedupe_key: "src/volume.ts:volumeToGain:1",
  category: 1,
  severity: "CRITICAL",
  evidence_class: "inferential",
  causal_disposition: "introduced",
  hunter: "reliability",
  hops_used: 1,
  hop_trail: [],
  claim: "volumeToGain no longer divides by 100, so gain exceeds unity.",
  proof_refs: ["src/volume.ts:3"],
};

// Answers every step the two harnesses run, and records each spec it saw.
class FakeRunner implements StepRunner {
  readonly seen: StepSpec[] = [];
  constructor(private readonly drafts: Record<string, DraftFinding> = {}) {}
  async run(spec: StepSpec): Promise<StepResult> {
    this.seen.push(spec);
    const draft = this.drafts[spec.name];
    let output: unknown = { findings: draft === undefined ? [] : [draft] };
    if (spec.name.startsWith("refuter-")) {
      output = {
        results: [
          {
            finding_id: spec.name.slice("refuter-".length),
            outcome: "corroborated",
            proof_refs: [],
          },
        ],
      };
    } else if (spec.name === "summarizer") {
      output = { summary: "fixture summary" };
    } else if (spec.name === "scout") {
      output = [];
    }
    return {
      name: spec.name,
      status: "ok",
      output,
      usage: zeroUsage(),
      attempts: 1,
      stderrTail: "",
      resultText: JSON.stringify(output),
    };
  }
}

async function mcpConfig(runDir: string): Promise<string> {
  const file = path.join(runDir, "mcp.json");
  await writeFile(file, JSON.stringify({ mcpServers: {} }));
  return file;
}

// The fingerprint runPipeline records when it builds its own plan.
async function selfBuiltFingerprint(input: PipelineInput): Promise<string> {
  await runPipeline(input, { runner: new FakeRunner() });
  const recorded = (await Bun.file(
    path.join(input.runDir, "pipeline.json"),
  ).json()) as { route_fingerprint?: string };
  if (recorded.route_fingerprint === undefined) {
    throw new Error("the no-plan run recorded no route fingerprint");
  }
  return recorded.route_fingerprint;
}

async function refuterFixture() {
  const fixture = await buildRefuterProbeFixture(
    "true-claim",
    await Bun.file(REFUTER_SOURCE).text(),
  );
  scratch.push(path.dirname(fixture.repoDir));
  return fixture;
}

async function plantedFixture() {
  const fixture = await buildPlantedFixture();
  scratch.push(path.dirname(fixture.repoDir));
  return fixture;
}

// A registered, already-capable opencode transport, as pipeline-routing.test.ts
// builds it. Nothing executes through it: the fake runner answers every step.
function capableOpenCodeTransport(): ProviderTransport {
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
      throw new Error("unreachable: the fake runner answers every step");
    },
    classifyFailure: () => undefined,
  };
}

function stepModel(plan: ResolvedRoutePlan, stepKey: string) {
  return plan.steps.find((s) => s.stepKey === stepKey)?.route;
}

describe("refuter-probe on a route plan", () => {
  test("default: opus refuter, haiku hunter, the plan a no-plan run builds", async () => {
    const fixture = await refuterFixture();
    const input = refuterProbePipelineInput(fixture, {
      mcpConfigPath: await mcpConfig(fixture.runDir),
    });
    const plan = await buildPipelineHarnessPlan(input);
    expect(stepModel(plan, "refuter")?.modelSnapshot).toBe("opus");
    expect(stepModel(plan, "hunter-resilience")?.modelSnapshot).toBe("haiku");
    expect(plan.routeFingerprint).toBe(await selfBuiltFingerprint(input));
  });

  test("the default plan is the one the probe ran before it pinned the hunter", async () => {
    const fixture = await refuterFixture();
    const input = refuterProbePipelineInput(fixture, {
      mcpConfigPath: await mcpConfig(fixture.runDir),
    });
    // Before: the hunter had no spec model (its frontmatter said haiku) and
    // the refuter carried `model: "opus"`.
    const before: PipelineInput = {
      ...input,
      spec: {
        agents: (input.spec?.agents ?? []).map((agent) =>
          agent.role === "hunter"
            ? { key: agent.key, file: agent.file, role: agent.role }
            : agent,
        ),
      },
    };
    expect(before.spec?.agents.find((a) => a.role === "refuter")?.model).toBe(
      "opus",
    );
    const plan = await buildPipelineHarnessPlan(input);
    expect(plan.routeFingerprint).toBe(await selfBuiltFingerprint(before));
  });

  test("passes the plan and a transport registry; every step carries its route", async () => {
    const fixture = await refuterFixture();
    const input = refuterProbePipelineInput(fixture, {
      mcpConfigPath: await mcpConfig(fixture.runDir),
    });
    const plan = await buildPipelineHarnessPlan(input);
    const inner = new FakeRunner();
    const transportRegistry = new DefaultTransportRegistry();
    const run = await runRefuterProbePipeline(
      input,
      {
        plan,
        deps: {
          runner: inner,
          transportRegistry,
          ceilingController: new AbortController(),
        },
      },
      fixture.draft,
    );
    // Only the refuter reaches the live runner; the hunter is planted.
    expect(inner.seen.map((s) => s.name)).toEqual(["refuter-F001"]);
    expect(inner.seen[0]?.route).toEqual(stepModel(plan, "refuter"));
    expect(run.identity).toEqual(
      await readPipelineRouteIdentity(fixture.runDir, "refuter"),
    );
    expect(run.identity.routeFingerprint).toBe(plan.routeFingerprint as string);
    expect(run.identity.route.modelSnapshot).toBe("opus");
    expect(run.result.skillOutput.findings).toHaveLength(1);
  });

  test("runs no plan-less pipeline: a missing registry is refused", async () => {
    const fixture = await refuterFixture();
    const input = refuterProbePipelineInput(fixture, {
      mcpConfigPath: await mcpConfig(fixture.runDir),
    });
    const plan = await buildPipelineHarnessPlan(input);
    await expect(
      runRefuterProbePipeline(
        input,
        { plan, deps: { runner: new FakeRunner() } },
        fixture.draft,
      ),
    ).rejects.toThrow("transportRegistry");
  });

  test("an opencode: refuter choice runs the refuter step on opencode", async () => {
    const fixture = await refuterFixture();
    const input = refuterProbePipelineInput(fixture, {
      mcpConfigPath: await mcpConfig(fixture.runDir),
      refuterModel: "opencode:openai/gpt-x",
    });
    const plan = await buildPipelineHarnessPlan(input);
    expect(stepModel(plan, "refuter")?.backend).toBe("opencode");
    expect(stepModel(plan, "hunter-resilience")?.modelSnapshot).toBe("haiku");
    // Admitted as production admits it (pipeline-routing.test.ts): a capable
    // opencode transport and its D1-11 evidence.
    const transportRegistry = new DefaultTransportRegistry();
    transportRegistry.register("opencode", capableOpenCodeTransport());
    const inner = new FakeRunner();
    const run = await runRefuterProbePipeline(
      input,
      {
        plan,
        deps: {
          runner: inner,
          transportRegistry,
          admissionEvidence: new Map([
            [
              "opencode",
              {
                sdkAvailable: true,
                credentialAuthority: true,
                workspaceBroker: true,
                pricingReady: true,
              },
            ],
          ]),
        },
      },
      fixture.draft,
    );
    expect(inner.seen.map((s) => s.name)).toEqual(["refuter-F001"]);
    expect(inner.seen[0]?.route?.backend).toBe("opencode");
    expect(run.identity.route.backend).toBe("opencode");
    expect(run.identity.route.modelSnapshot).toBe("gpt-x");
  });
});

describe("fixture-eval on a route plan", () => {
  const cases: Array<[string, { scout?: boolean; model?: string }]> = [
    ["default", {}],
    ["--scout", { scout: true }],
    ["--model sonnet", { model: "sonnet" }],
  ];
  for (const [name, options] of cases) {
    test(`${name}: the plan a no-plan run builds`, async () => {
      const fixture = await plantedFixture();
      const input = fixtureEvalPipelineInput(fixture, {
        mcpConfigPath: await mcpConfig(fixture.runDir),
        ...options,
      });
      const plan = await buildPipelineHarnessPlan(input);
      expect(plan.routeFingerprint).toBe(await selfBuiltFingerprint(input));
    });
  }

  test("the scout stays on haiku and the fixture agents on their frontmatter", async () => {
    const fixture = await plantedFixture();
    const input = fixtureEvalPipelineInput(fixture, {
      mcpConfigPath: await mcpConfig(fixture.runDir),
      scout: true,
    });
    expect(input.bundledAgents).not.toBe(true);
    const plan = await buildPipelineHarnessPlan(input);
    expect(stepModel(plan, "scout")?.modelSnapshot).toBe("haiku");
    expect(stepModel(plan, "hunter-reliability")?.modelSnapshot).toBe("haiku");
  });

  test("every step the run executes carries a route from the plan", async () => {
    const fixture = await plantedFixture();
    const input = fixtureEvalPipelineInput(fixture, {
      mcpConfigPath: await mcpConfig(fixture.runDir),
      scout: true,
    });
    const plan = await buildPipelineHarnessPlan(input);
    const runner = new FakeRunner({ "hunter-reliability": VOLUME_DRAFT });
    await runPipeline(
      { ...input, routePlan: plan },
      { runner, transportRegistry: new DefaultTransportRegistry() },
    );
    const names = runner.seen.map((s) => s.name);
    expect(names).toContain("scout");
    expect(names).toContain("summarizer");
    expect(names.some((n) => n.startsWith("refuter-"))).toBe(true);
    for (const spec of runner.seen) expect(spec.route).toBeDefined();
  });
});

describe("buildPipelineHarnessPlan", () => {
  test("a diversity spec is refused, never built without its legs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-pipeline-plan-"));
    scratch.push(dir);
    await expect(
      buildPipelineHarnessPlan({
        agentsDir: dir,
        spec: {
          agents: [
            {
              key: "reliability",
              file: "h.md",
              role: "hunter",
              models: ["sonnet", "haiku"],
            },
            { key: "refuter", file: "r.md", role: "refuter" },
          ],
          multiModelDiversity: {
            enabled: true,
            armId: "arm",
            maxLegs: 2,
            cashCapUsd: 1,
          },
        },
      }),
    ).rejects.toThrow(HarnessRouteError);
  });

  test("a run dir with no recorded route for the step is refused", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-pipeline-plan-"));
    scratch.push(dir);
    await writeFile(path.join(dir, "pipeline.json"), JSON.stringify({}));
    await expect(readPipelineRouteIdentity(dir, "refuter")).rejects.toThrow(
      HarnessRouteError,
    );
  });
});
