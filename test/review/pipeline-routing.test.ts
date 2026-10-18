import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { armOfRun, scoutFailed } from "#compare/floor-test";
import { aliasCanonical } from "#model/catalog";
import {
  createResolvedRoutePlan,
  type RoutingConfig,
  resolveStepRoute,
} from "#model/routing";
import { type PipelineInput, runPipeline } from "#review/pipeline";
import { rereviewDeltaFromProvenance } from "#review/report";
import { type ReviewSpec, validateReviewSpec } from "#review/spec";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import { countAttempts, parsePipelineMeta } from "#watch/preflight";
import { emptyDiversityLedger } from "../../src/diversity/accounting";
import { buildDiversityPlan } from "../../src/diversity/identity";
import {
  diversityDebugFromLedger,
  recordDiversityHunterResult,
} from "../../src/diversity/pipeline-integration";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  RunnerBackend,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
  OpenCodeProductionGatedError,
  RouteAdmissionError,
} from "../../src/transport-registry";

class RecordingStepRunner implements StepRunner {
  readonly executedSteps: StepSpec[] = [];

  constructor(
    private readonly handler?: (
      step: StepSpec,
    ) => Promise<StepResult> | StepResult,
  ) {}

  async run(step: StepSpec): Promise<StepResult> {
    this.executedSteps.push(step);
    if (this.handler) {
      return this.handler(step);
    }
    // Default ok response with empty findings
    const isRefuter = step.name.startsWith("refuter");
    const isSummarizer = step.name === "summarizer";
    const isScout = step.name === "scout";

    let resultText = "{}";
    let output: unknown = { findings: [] };

    if (isRefuter) {
      resultText = JSON.stringify({
        results: [
          {
            finding_id: step.name.replace(/^refuter-/, ""),
            verdict: "supported",
            rationale: "valid finding",
          },
        ],
      });
      output = {
        results: [
          {
            finding_id: step.name.replace(/^refuter-/, ""),
            verdict: "supported",
            rationale: "valid finding",
          },
        ],
      };
    } else if (isSummarizer) {
      resultText = JSON.stringify({ summary: "test summary" });
      output = { summary: "test summary" };
    } else if (isScout) {
      resultText = JSON.stringify({ leads: [] });
      output = { leads: [] };
    } else {
      // Hunter
      resultText = JSON.stringify({
        findings: [
          {
            id: "F001",
            path: "src/index.ts",
            line: 1,
            severity: "CRITICAL",
            claim: "Null pointer issue",
            proof_refs: ["src/index.ts:1"],
          },
        ],
      });
      output = {
        findings: [
          {
            id: "F001",
            path: "src/index.ts",
            line: 1,
            severity: "CRITICAL",
            claim: "Null pointer issue",
            proof_refs: ["src/index.ts:1"],
          },
        ],
      };
    }

    return {
      name: step.name,
      status: "ok",
      attempts: 1,
      usage: {
        tokens_total: 100,
        tokens_in: 80,
        tokens_out: 20,
        cost_usd_est: 0.001,
        wall_ms: 50,
      },
      stderrTail: "",
      resultText,
      output,
    };
  }
}

const READY_OPENCODE_EVIDENCE: D1_11ReadinessEvidence = {
  sdkAvailable: true,
  credentialAuthority: true,
  workspaceBroker: true,
  pricingReady: true,
};

// A registered, already-capable opencode transport. Overriding the backend
// takes the registry's OWN D1-11 factory gate out of the picture (and with it
// any `@opencode-ai/sdk` resolution), so these tests isolate exactly one
// question: does runPipeline thread admission evidence into admitRoutePlan?
function createCapableOpenCodeTransport(): ProviderTransport {
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
    execute: async (_request: TransportRequest): Promise<TransportOutcome> => ({
      completion: "success",
      protocolIntegrity: "verified",
      finalText: '{"findings":[]}',
      usage: {
        wallMs: 1,
        tokens: { totalKnown: 1 },
        completeness: "complete",
        billingMode: "subscription",
        costSource: "provider",
        cashCostUsd: 0,
      },
      stderrTail: "",
    }),
    classifyFailure: () => undefined,
  };
}

// The live-failure topology: an explicit caller-supplied plan whose steps are
// routed at opencode, exactly as the CLI hands one to runPipeline.
function openCodeRoutePlan() {
  const routingConfig: RoutingConfig = {
    mappings: {
      "openai/gpt-4o": {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
      },
    },
  };
  return createResolvedRoutePlan([
    resolveStepRoute({
      stepKey: "hunter-reliability",
      role: "hunter",
      cliModel: "openai/gpt-4o",
      routingConfig,
    }),
    resolveStepRoute({
      stepKey: "refuter",
      role: "refuter",
      cliModel: "openai/gpt-4o",
      routingConfig,
    }),
  ]);
}

async function setupTestEnvironment() {
  const tmp = await mkdtemp(path.join(tmpdir(), "pr-hero-pipe-routing-"));
  const runDir = path.join(tmp, "run");
  const agentsDir = path.join(tmp, "agents");
  const worktree = path.join(tmp, "worktree");

  await mkdir(runDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(worktree, { recursive: true });

  await Bun.write(
    path.join(agentsDir, "reliability.md"),
    "---\nname: reliability\nmodel: sonnet\ntools: [Read, Grep]\n---\nYou are the reliability hunter.",
  );
  await Bun.write(
    path.join(agentsDir, "refuter.md"),
    "---\nname: refuter\nmodel: opus\ntools: [Read]\n---\nYou are the refuter.",
  );

  await mkdir(path.join(worktree, "src"), { recursive: true });
  await Bun.write(path.join(worktree, "src", "index.ts"), "const x = 2;\n");

  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(
    diffPath,
    "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  );

  const gotchasPath = path.join(runDir, "gotchas.json");
  await Bun.write(gotchasPath, "[]");

  const mcpConfigPath = path.join(runDir, "mcp.json");
  await Bun.write(mcpConfigPath, "{}");

  const spec: ReviewSpec = {
    agents: [
      {
        key: "reliability",
        file: "reliability.md",
        role: "hunter",
        model: "sonnet",
      },
      { key: "refuter", file: "refuter.md", role: "refuter", model: "opus" },
    ],
  };

  const input: PipelineInput = {
    pr: 42,
    baseSha: "1111111111111111111111111111111111111111",
    headSha: "2222222222222222222222222222222222222222",
    worktree,
    diffPath,
    gotchasPath,
    agentsDir,
    runDir,
    outPath: path.join(runDir, "findings.json"),
    mcpConfigPath,
    hopBudget: 2,
    parityTriggerPaths: [],
    suspicionPriors: [],
    spec,
  };

  const cleanup = async () => {
    await rm(tmp, { recursive: true, force: true });
  };

  return { tmp, runDir, agentsDir, worktree, spec, input, cleanup };
}

describe("Pipeline Model Routing & Provenance (D2 PR3)", () => {
  test("runPipeline resolves routePlan and threads ResolvedModelRoute into StepSpec", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      const result = await runPipeline(env.input, { runner });

      expect(result.sessionFailed).toBe(false);
      expect(runner.executedSteps.length).toBeGreaterThanOrEqual(1);

      // Verify each executed step received a ResolvedModelRoute
      for (const step of runner.executedSteps) {
        expect(step.route).toBeDefined();
        expect(step.route?.backend).toBe("claude-code");
        expect(step.route?.provider).toBe("anthropic");
      }

      const hunterStep = runner.executedSteps.find(
        (s) => s.name === "hunter-reliability",
      );
      expect(hunterStep?.model).toBe("sonnet");
      expect(hunterStep).toBeDefined();
      expect(hunterStep?.route?.modelFamily).toBe("sonnet");

      // Check refuter step route
      const refuterStep = runner.executedSteps.find((s) =>
        s.name.startsWith("refuter-"),
      );
      expect(refuterStep).toBeDefined();
      expect(refuterStep?.route?.modelFamily).toBe("opus");
    } finally {
      await env.cleanup();
    }
  });

  test("refuter steps inherit resolved refuter route from the plan", async () => {
    const env = await setupTestEnvironment();
    try {
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: "opus",
            backend: "claude-code",
            provider: "anthropic",
            gateway: "direct",
            modelFamily: "opus",
            modelSnapshot: "claude-opus-5-20240229",
          },
        ],
      };

      const runner = new RecordingStepRunner();
      await runPipeline({ ...env.input, routingConfig }, { runner });

      const refuterSteps = runner.executedSteps.filter((s) =>
        s.name.startsWith("refuter-"),
      );
      expect(refuterSteps.length).toBeGreaterThanOrEqual(1);

      for (const refuterStep of refuterSteps) {
        expect(refuterStep.route).toBeDefined();
        expect(refuterStep.route?.modelFamily).toBe("opus");
        expect(refuterStep.route?.modelSnapshot).toBe("claude-opus-5-20240229");
      }
    } finally {
      await env.cleanup();
    }
  });

  test("pipeline.json records deterministic routeFingerprint and routePlan matching result", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      const result = await runPipeline(env.input, { runner });

      const pipelineJsonPath = path.join(env.runDir, "pipeline.json");
      const pipelineJsonRaw = await Bun.file(pipelineJsonPath).text();
      const pipelineJson = JSON.parse(pipelineJsonRaw);

      // Provenance contains routePlan and routeFingerprint
      expect(pipelineJson.routePlan || pipelineJson.route_plan).toBeDefined();
      expect(
        pipelineJson.routeFingerprint || pipelineJson.route_fingerprint,
      ).toBeDefined();

      const planFromArtifact =
        pipelineJson.routePlan ?? pipelineJson.route_plan;
      const fpFromArtifact =
        pipelineJson.routeFingerprint ?? pipelineJson.route_fingerprint;

      expect(typeof fpFromArtifact).toBe("string");
      expect(fpFromArtifact.length).toBe(64); // SHA-256 hex length
      expect(result.routeFingerprint).toBe(fpFromArtifact);
      expect(Array.isArray(planFromArtifact.steps)).toBe(true);

      // Ensure steps in pipeline.json also carry route dimensions
      const hunterMeta = pipelineJson.steps.find(
        (s: { name: string }) => s.name === "hunter-reliability",
      );
      expect(hunterMeta).toBeDefined();
      expect(hunterMeta.route).toBeDefined();
      expect(hunterMeta.route.backend).toBe("claude-code");
      expect(hunterMeta.route.provider).toBe("anthropic");
      expect(hunterMeta.route.modelFamily).toBe("sonnet");
      // #299: the requested effort rides beside the route, and on the Claude
      // backend the CLI flag exists, so it is applied.
      expect(hunterMeta.effort).toBe("xhigh");
      expect(hunterMeta.effort_applied).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  test("pipeline.json records routed execution model in step.model instead of frontmatter model (#186)", async () => {
    const env = await setupTestEnvironment();
    try {
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: "sonnet",
            backend: "claude-code",
            provider: "anthropic",
            gateway: "configured",
            modelFamily: "claude-3-5-sonnet",
            modelSnapshot: "claude-3-5-sonnet-20241022",
          },
        ],
      };

      const runner = new RecordingStepRunner();
      await runPipeline({ ...env.input, routingConfig }, { runner });

      const pipelineJson = JSON.parse(
        await Bun.file(path.join(env.runDir, "pipeline.json")).text(),
      );

      // hunter-reliability prompt frontmatter has model "sonnet"
      const reliabilityMeta = pipelineJson.steps.find(
        (s: { name: string }) => s.name === "hunter-reliability",
      );
      expect(reliabilityMeta).toBeDefined();
      expect(reliabilityMeta.route).toBeDefined();
      // On non-direct gateway, StepMeta.model MUST record the routed modelSnapshot
      expect(reliabilityMeta.model).toBe("claude-3-5-sonnet-20241022");
    } finally {
      await env.cleanup();
    }
  });

  test("route admission gate rejects unregistered backend before step execution", async () => {
    const env = await setupTestEnvironment();
    try {
      // The explicit `modelSnapshot` is load-bearing for the ADMISSION gate
      // being tested here, not decoration: #175's follow-up refuses an alias
      // route whose consumer cannot resolve the alias (anything but the Claude
      // CLI over a `direct` gateway) and that supplies no snapshot, and it
      // refuses during route resolution — before admission runs. Without it
      // this fixture never reaches the gate it exists to exercise.
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: aliasCanonical("sonnet"),
            backend: "unregistered" as RunnerBackend,
            provider: "unknown",
            modelSnapshot: "unknown-model",
          },
        ],
      };

      const runner = new RecordingStepRunner();
      const registry = new DefaultTransportRegistry();

      await expect(
        runPipeline(
          { ...env.input, routingConfig },
          { runner, transportRegistry: registry },
        ),
      ).rejects.toThrow(RouteAdmissionError);

      // No steps should have been executed
      expect(runner.executedSteps.length).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  test("route admission gate blocks opencode in production mode when missing D1-11 evidence", async () => {
    const env = await setupTestEnvironment();
    try {
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            // Explicit snapshot for the same reason as the fixture above:
            // route resolution refuses a snapshot-less alias route whose
            // consumer resolves no aliases, before the D1-11 gate can speak.
            logical: aliasCanonical("sonnet"),
            backend: "opencode",
            provider: "openai",
            modelSnapshot: "gpt-4o",
          },
        ],
      };

      const runner = new RecordingStepRunner();
      const registry = new DefaultTransportRegistry();

      await expect(
        runPipeline(
          { ...env.input, routingConfig },
          { runner, transportRegistry: registry },
        ),
      ).rejects.toThrow(OpenCodeProductionGatedError);

      expect(runner.executedSteps.length).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  // The defect this covers killed a live OpenCode review in 1.1s:
  // admitRoutePlan reads D1-11 evidence ONLY from its own options parameter,
  // never from the registry it is handed, so runPipeline's evidence-less
  // admission call gated an evidence-seeded production run against an empty
  // map. The CLI already resolved the evidence; nothing carried it in.
  test("caller-supplied opencode route plan is admitted when D1-11 evidence reaches the pipeline", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      const registry = new DefaultTransportRegistry();
      registry.register("opencode", createCapableOpenCodeTransport());

      const result = await runPipeline(
        { ...env.input, routePlan: openCodeRoutePlan() },
        {
          runner,
          transportRegistry: registry,
          admissionEvidence: new Map<RunnerBackend, D1_11ReadinessEvidence>([
            ["opencode", READY_OPENCODE_EVIDENCE],
          ]),
        },
      );

      expect(result.sessionFailed).toBe(false);
      const hunterStep = runner.executedSteps.find(
        (s) => s.name === "hunter-reliability",
      );
      expect(hunterStep?.route?.backend).toBe("opencode");

      const pipelineJson = JSON.parse(
        await Bun.file(path.join(env.runDir, "pipeline.json")).text(),
      );
      const hunterMeta = pipelineJson.steps.find(
        (s: { name: string }) => s.name === "hunter-reliability",
      );
      expect(hunterMeta).toBeDefined();
      expect(hunterMeta.model).toBe("gpt-4o");
      // OpenCode has no `--effort`: the level is recorded as REQUESTED and the
      // artifact says outright that this backend did not apply it.
      expect(hunterMeta.effort).toBe("xhigh");
      expect(hunterMeta.effort_applied).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  // Fail-closed guard for the change above: threading evidence must not turn
  // into "admission finds evidence somewhere". A registry that could serve the
  // backend is NOT evidence — an admission call without evidence still gates.
  test("opencode route stays rejected when the registry is capable but no evidence is threaded", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      const registry = new DefaultTransportRegistry();
      registry.register("opencode", createCapableOpenCodeTransport());

      await expect(
        runPipeline(
          { ...env.input, routePlan: openCodeRoutePlan() },
          { runner, transportRegistry: registry },
        ),
      ).rejects.toThrow(OpenCodeProductionGatedError);

      expect(runner.executedSteps.length).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  test("schema-1.1 tolerant old readers parse pipeline.json without error", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      await runPipeline(env.input, { runner });

      const pipelineJsonPath = path.join(env.runDir, "pipeline.json");
      const raw = await Bun.file(pipelineJsonPath).text();
      const parsed = JSON.parse(raw);

      // parsePipelineMeta
      const meta = parsePipelineMeta(raw);
      expect(meta).not.toBeNull();
      expect(meta?.pr).toBe(42);
      expect(meta?.head_sha).toBe("2222222222222222222222222222222222222222");

      // countAttempts
      const attemptCount = countAttempts(
        [
          {
            name: "pr-42-22222222-1",
            pipelineMeta: meta,
          },
        ],
        42,
        "2222222222222222222222222222222222222222",
      );
      expect(attemptCount).toBe(1);

      // floor-test armOfRun and scoutFailed
      expect(armOfRun(parsed)).toBe("control");
      expect(scoutFailed(parsed)).toBe(false);

      // rereviewDeltaFromProvenance with mock rereview block
      const delta = rereviewDeltaFromProvenance(
        { live: [{ status: "carried" }] },
        1,
      );
      expect(delta.carried).toBe(1);
      expect(delta.new).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  test("legacy Claude-only model strings run without D2 routes or provenance", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      const result = await runPipeline(
        { ...env.input, model: "claude-opus-4-5" },
        { runner },
      );

      expect(result.routePlan).toBeUndefined();
      expect(result.routeFingerprint).toBeUndefined();
      for (const step of runner.executedSteps) {
        expect(step.model).toBe("claude-opus-4-5");
        expect(step.route).toBeUndefined();
      }

      const pipelineJson = JSON.parse(
        await Bun.file(path.join(env.runDir, "pipeline.json")).text(),
      );
      expect(pipelineJson.routePlan).toBeUndefined();
      expect(pipelineJson.route_plan).toBeUndefined();
      expect(parsePipelineMeta(JSON.stringify(pipelineJson))).not.toBeNull();
      // #299: the legacy shape still carries the requested effort, but with no
      // route the backend is not recorded, so `effort_applied` is ABSENT rather
      // than guessed.
      const hunterMeta = pipelineJson.steps.find(
        (s: { name: string }) => s.name === "hunter-reliability",
      );
      expect(hunterMeta.effort).toBe("xhigh");
      expect(hunterMeta).not.toHaveProperty("effort_applied");
    } finally {
      await env.cleanup();
    }
  });

  // Forward-compatibility guard over a MIXED claude-code + opencode plan.
  // The engine can now emit an opencode-backed artifact (see the
  // evidence-threading test above), but no offline test produces a plan with
  // both backends at once, so this literal remains the only place where the
  // legacy readers meet that shape. Spec scenario 2 asks for exactly this
  // ("a PR plan containing Claude and OpenCode steps ... artifacts remain
  // readable by old consumers"). Deleting it in favour of the real-artifact
  // test below silently drops backend: "opencode" from parser coverage.
  test("legacy parsers tolerate a mixed claude-code + opencode route shape", () => {
    const head = "2222222222222222222222222222222222222222";
    const mixed = {
      pr: 42,
      head_sha: head,
      scout: { enabled: false },
      routePlan: {
        steps: [
          { route: { backend: "claude-code", provider: "anthropic" } },
          {
            route: {
              backend: "opencode",
              provider: "openai",
              modelVariant: "high",
            },
          },
        ],
      },
    };
    const meta = parsePipelineMeta(JSON.stringify(mixed));
    expect(meta).toEqual({ pr: 42, head_sha: head });
    expect(
      countAttempts(
        [{ name: "pr-42-22222222-1", pipelineMeta: meta }],
        42,
        head,
      ),
    ).toBe(1);
    expect(armOfRun(mixed)).toBe("control");
  });

  // SUGGESTION-4: this used to build its "mixed-route artifact" as a
  // hand-written object literal, which proved only that the legacy parsers
  // tolerate a shape a human typed. It now runs the real pipeline and reads
  // the pipeline.json runPipeline actually wrote.
  //
  // The routes are two DISTINCT claude-code routes rather than
  // claude-code + opencode, because this test supplies no D1-11 evidence:
  // runPipeline threads `{ mode: "production", evidence }` into
  // admitRoutePlan, and with no evidence the D1-11 gate throws
  // OpenCodeProductionGatedError before any artifact is written (proven by
  // the fail-closed test above). Producing an opencode artifact needs the
  // evidence-threading setup, which the sibling test covers.
  test("legacy parsers consume a real mixed-route pipeline.json without requiring new fields", async () => {
    const env = await setupTestEnvironment();
    try {
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: aliasCanonical("opus"),
            backend: "claude-code",
            provider: "openrouter",
            gateway: "openrouter",
            modelFamily: "opus",
            modelSnapshot: "opus",
            modelVariant: "high",
          },
        ],
      };

      const runner = new RecordingStepRunner();
      await runPipeline({ ...env.input, routingConfig }, { runner });

      const raw = await Bun.file(path.join(env.runDir, "pipeline.json")).text();
      const produced = JSON.parse(raw);

      // The artifact really does carry more than one distinct route.
      const routes = produced.routePlan.steps.map(
        (s: { route: { gateway?: string; modelVariant?: string } }) => s.route,
      );
      expect(routes.length).toBeGreaterThanOrEqual(2);
      expect(
        new Set(routes.map((r: { gateway?: string }) => r.gateway)).size,
      ).toBeGreaterThan(1);
      expect(
        routes.some(
          (r: { modelVariant?: string }) => r.modelVariant === "high",
        ),
      ).toBe(true);

      // Legacy parsers read it without knowing any of those fields exist.
      const head = "2222222222222222222222222222222222222222";
      const meta = parsePipelineMeta(raw);
      expect(meta).toEqual({ pr: 42, head_sha: head });
      expect(
        countAttempts(
          [{ name: "pr-42-22222222-1", pipelineMeta: meta }],
          42,
          head,
        ),
      ).toBe(1);
      expect(armOfRun(produced)).toBe("control");
    } finally {
      await env.cleanup();
    }
  });

  test("OpenCode D3 debug observations record frozen route provenance", () => {
    const spec = validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "arm",
        maxLegs: 3,
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
    const [leg] = plan.legs;
    const [agent] = spec.agents;
    if (!leg || !agent) throw new Error("missing diversity fixtures");
    const ledger = recordDiversityHunterResult(
      emptyDiversityLedger(),
      plan,
      agent,
      {
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
        usage: {
          tokens_total: 10,
          tokens_in: 8,
          tokens_out: 2,
          cost_usd_est: 0.001,
          wall_ms: 1,
        },
        attempts: 1,
        stderrTail: "",
        resultText: "",
      },
      leg,
      {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o-2024",
        modelVariant: "high",
      },
    );
    const [observation] = (diversityDebugFromLedger({
      enabled: true,
      plan,
      ledger,
      routeAgents: spec.agents,
    })?.observations ?? []) as {
      backend: string;
      provider: string;
      modelFamily: string;
      modelSnapshot: string;
      modelVariant?: string;
    }[];
    expect(observation).toMatchObject({
      backend: "opencode",
      provider: "openai",
      modelFamily: "gpt-4o",
      modelSnapshot: "gpt-4o-2024",
      modelVariant: "high",
    });
  });

  // SUGGESTION-3 (opencode-production-runtime PR3 verify #4997): the
  // FindingObservation record already carries `gateway` when the frozen
  // route names one (pipeline-integration.ts:298-312), but
  // diversityDebugFromLedger's observation projection dropped it — the D3
  // debug artifact could not distinguish a "configured"/"openrouter" gateway
  // leg from a direct one.
  test("D3 debug observations project gateway when the frozen route names one", () => {
    const spec = validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "arm",
        maxLegs: 3,
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
    const [leg] = plan.legs;
    const [agent] = spec.agents;
    if (!leg || !agent) throw new Error("missing diversity fixtures");
    const ledger = recordDiversityHunterResult(
      emptyDiversityLedger(),
      plan,
      agent,
      {
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
        usage: {
          tokens_total: 10,
          tokens_in: 8,
          tokens_out: 2,
          cost_usd_est: 0.001,
          wall_ms: 1,
        },
        attempts: 1,
        stderrTail: "",
        resultText: "",
      },
      leg,
      {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o-2024",
        gateway: "openrouter",
      },
    );
    const [observation] = (diversityDebugFromLedger({
      enabled: true,
      plan,
      ledger,
      routeAgents: spec.agents,
    })?.observations ?? []) as { gateway?: string }[];
    expect(observation?.gateway).toBe("openrouter");
  });
});

describe("a pipeline whose hunters all fail with model_unavailable", () => {
  // The hunters fail at the transport with the cause the CLI record needs; the
  // route plan names the provider and the model the publisher will name.
  test("reports each failed hunter's cause, provider and model", async () => {
    const env = await setupTestEnvironment();
    try {
      const failingHunter = async (spec: StepSpec): Promise<StepResult> => {
        if (!spec.name.startsWith("hunter-")) {
          throw new Error(`unscripted step ${spec.name}`);
        }
        return {
          name: spec.name,
          status: "failed",
          usage: {
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            wall_ms: 1,
            cost_usd_est: 0,
          },
          attempts: 1,
          stderrTail: "",
          resultText: "",
          failureCause: "model_unavailable",
        };
      };
      const runner: StepRunner = { run: failingHunter };
      const registry = new DefaultTransportRegistry();
      registry.register("opencode", createCapableOpenCodeTransport());

      const result = await runPipeline(
        { ...env.input, routePlan: openCodeRoutePlan() },
        {
          runner,
          transportRegistry: registry,
          admissionEvidence: new Map<RunnerBackend, D1_11ReadinessEvidence>([
            ["opencode", READY_OPENCODE_EVIDENCE],
          ]),
        },
      );

      expect(result.sessionFailed).toBe(true);
      expect(result.hunterFailures?.length).toBeGreaterThan(0);
      for (const failure of result.hunterFailures ?? []) {
        expect(failure).toEqual({
          name: expect.stringMatching(/^hunter-/),
          cause: "model_unavailable",
          provider: "openai",
          model: "gpt-4o",
        });
      }
    } finally {
      await env.cleanup();
    }
  });
});

describe("a pipeline whose hunters all fail with a missing provider record", () => {
  // The projection error reaches the step as the typed cause; the route plan names the
  // provider and the model the publisher will name.
  test("reports each failed hunter's cause, provider and model", async () => {
    const env = await setupTestEnvironment();
    try {
      const failingHunter = async (spec: StepSpec): Promise<StepResult> => {
        if (!spec.name.startsWith("hunter-")) {
          throw new Error(`unscripted step ${spec.name}`);
        }
        return {
          name: spec.name,
          status: "failed",
          usage: {
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            wall_ms: 1,
            cost_usd_est: 0,
          },
          attempts: 1,
          stderrTail: "",
          resultText: "",
          failureCause: "missing_provider_record",
        };
      };
      const runner: StepRunner = { run: failingHunter };
      const registry = new DefaultTransportRegistry();
      registry.register("opencode", createCapableOpenCodeTransport());

      const result = await runPipeline(
        { ...env.input, routePlan: openCodeRoutePlan() },
        {
          runner,
          transportRegistry: registry,
          admissionEvidence: new Map<RunnerBackend, D1_11ReadinessEvidence>([
            ["opencode", READY_OPENCODE_EVIDENCE],
          ]),
        },
      );

      expect(result.sessionFailed).toBe(true);
      expect(result.hunterFailures?.length).toBeGreaterThan(0);
      for (const failure of result.hunterFailures ?? []) {
        expect(failure).toEqual({
          name: expect.stringMatching(/^hunter-/),
          cause: "missing_provider_record",
          provider: "openai",
          model: "gpt-4o",
        });
      }
    } finally {
      await env.cleanup();
    }
  });
});
