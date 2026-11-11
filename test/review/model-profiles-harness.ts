// The model-profiles baseline harness (odd/tasks/model-profiles.md S8).
//
// Runs the whole pipeline offline over the SHIPPED prompts (prompts/default
// plus the engine-owned root prompts) and records, per step that spawns, what
// it would run: backend, provider, model, effort, whether the backend is sent
// that effort, the rendered system prompt and user prompt (as sha256), and the
// Claude CLI argv. Machine-local paths are replaced by placeholders before
// anything is hashed or recorded, so the snapshot is the same on every
// machine. The fixtures under test/fixtures/model-profiles/baseline were
// captured with this harness on 4898e1b4, before any profile code existed.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelsConfig } from "#model/model-name";
import { claudeCliModel, type ResolvedRoutePlan } from "#model/routing";
import type { DraftFinding } from "#review/drafts";
import { type PipelineInput, runPipeline } from "#review/pipeline";
import { localReviewSpec } from "#review/preflight";
import {
  buildStepArgv,
  type StepResult,
  type StepRunner,
  type StepSpec,
} from "#review/step-runner";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  RunnerBackend,
} from "../../src/execution/contracts";
import { effortApplied } from "../../src/execution/contracts";
import {
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
} from "../../src/transport-registry";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
export const BUNDLED_AGENTS_DIR = path.join(REPO_ROOT, "prompts", "default");
const ROOT_PROMPT = (file: string) => path.join(REPO_ROOT, "prompts", file);
export const BASELINE_DIR = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "model-profiles",
  "baseline",
);

const NONCE = "0123456789abcdef0123456789abcdef";

export interface BaselineCase {
  readonly name: string;
  readonly model?: string;
  readonly models?: ModelsConfig;
  // A copy of the bundled set whose frontmatter is rewritten per file. The
  // bodies are untouched, so only routing can differ from the bundled run.
  readonly customFrontmatter?: Readonly<
    Record<string, { model?: string; effort?: string }>
  >;
  readonly opencode?: true;
}

// The six inputs S8 names. The custom set differs from the bundled values on
// purpose, and one of its files names a model but no effort, so "a user set's
// frontmatter still wins over the profile" is observable.
export const BASELINE_CASES: readonly BaselineCase[] = [
  { name: "zero-config" },
  { name: "models-default", models: { default: ["claude:opus-latest"] } },
  { name: "cli-model", model: "haiku" },
  {
    name: "custom-agents-dir",
    customFrontmatter: {
      "deep-review-logic.md": { model: "haiku", effort: "medium" },
      "deep-review-parity.md": { model: "opus", effort: "low" },
      "deep-review-reliability.md": { model: "haiku" },
      "deep-review-resilience.md": { model: "sonnet", effort: "max" },
      "review-refuter.md": { model: "sonnet", effort: "medium" },
    },
  },
  {
    name: "opencode",
    opencode: true,
    models: {
      default: [{ model: "opencode:openai/gpt-x", effort: "high" }],
      refuter: ["opencode:openai/gpt-x"],
    },
  },
  {
    name: "models-judge",
    models: { judge: ["claude:opus-latest"] },
  },
];

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

function finding(): DraftFinding {
  return {
    id: "REL-1",
    category: 1,
    path: "src/app.ts",
    line: 1,
    symbol: "run",
    severity: "BLOCKER",
    evidence_class: "deterministic",
    causal_disposition: "introduced",
    claim:
      "the cached width is scaled by the device pixel ratio twice, so the " +
      "rendered element ends up at double its intended size on retina screens",
    proof_refs: ["src/app.ts:1"],
    hunter: "reliability",
    hops_used: 0,
    hop_trail: [],
    dedupe_key: "src/app.ts:run:1",
  };
}

const USAGE = {
  wall_ms: 1,
  tokens_in: 1,
  tokens_out: 1,
  tokens_total: 2,
  cost_usd_est: 0,
};

function ok(spec: StepSpec, output: unknown): StepResult {
  return {
    name: spec.name,
    status: "ok",
    output,
    usage: USAGE,
    attempts: 1,
    stderrTail: "",
    resultText: "",
  };
}

function failed(spec: StepSpec): StepResult {
  return {
    name: spec.name,
    status: "failed",
    usage: USAGE,
    attempts: 1,
    stderrTail: "scripted failure",
    resultText: "",
  };
}

function parsedOrFailed(spec: StepSpec, text: string): StepResult {
  try {
    return ok(spec, spec.parse?.(text));
  } catch {
    return failed(spec);
  }
}

export interface RecordedStep {
  readonly name: string;
  readonly backend: string;
  readonly provider: string | null;
  readonly model: string;
  readonly modelSnapshot: string | null;
  readonly modelVariant: string | null;
  readonly effort: string;
  readonly fallbackEfforts: readonly string[] | null;
  readonly effortApplied: boolean;
  readonly tools: readonly string[];
  readonly systemPromptSha256: string;
  readonly promptSha256: string;
  // The Claude CLI's `--model` as the transport sends it
  // (claude-code-cli.ts reads claudeCliModel(route), not StepSpec.model).
  readonly cliModel: string | null;
  // buildStepArgv over the StepSpec: the legacy runner's argv. The transport
  // argv needs a verified binary and isolation, so it is pinned through its
  // two routed inputs instead: cliModel and effort.
  readonly argv: readonly string[] | null;
}

export interface Baseline {
  readonly case: string;
  readonly steps: readonly RecordedStep[];
  readonly plan: {
    readonly routeFingerprint: string | null;
    readonly steps: readonly {
      readonly stepKey: string;
      readonly role: string;
      readonly logicalIdentity: string;
      readonly routeFingerprint: string;
      readonly effort: string | null;
      readonly route: Record<string, unknown>;
      readonly fallbacks: readonly string[] | null;
    }[];
  } | null;
  readonly pipelineSteps: readonly Record<string, unknown>[];
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

class RecordingRunner implements StepRunner {
  readonly recorded: { spec: StepSpec; system: string }[] = [];

  async run(spec: StepSpec): Promise<StepResult> {
    this.recorded.push({
      spec,
      system: await readFile(spec.systemPromptPath, "utf8").catch(() => ""),
    });
    if (spec.name === "hunter-reliability") {
      return ok(spec, { findings: [finding()] });
    }
    if (spec.name.startsWith("hunter-")) return ok(spec, { findings: [] });
    if (spec.name.startsWith("refuter")) {
      return ok(spec, {
        results: [
          {
            finding_id: spec.name.replace(/^refuter-?/, "") || "REL-1",
            outcome: "corroborated",
            proof_refs: [],
          },
        ],
      });
    }
    if (spec.name === "summarizer") {
      return parsedOrFailed(spec, JSON.stringify({ summary: "a summary" }));
    }
    if (spec.name === "scout") {
      return parsedOrFailed(spec, JSON.stringify({ leads: [] }));
    }
    if (spec.name.startsWith("materiality")) {
      return parsedOrFailed(
        spec,
        JSON.stringify({ label: "material", reason: "a real defect" }),
      );
    }
    // consolidate and anything else: a deterministic failure, which every
    // optional stage tolerates. Only the step's shape is under test.
    return failed(spec);
  }
}

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
      throw new Error("the baseline runs no transport");
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

// Rewrites `model:`/`effort:` lines of a prompt's frontmatter, dropping a
// line when the override omits it. The body is copied byte for byte.
function rewriteFrontmatter(
  raw: string,
  override: { model?: string; effort?: string },
): string {
  const end = raw.indexOf("\n---", 4);
  const head = raw
    .slice(0, end)
    .split("\n")
    .filter((line) => !/^(model|effort):/.test(line));
  if (override.model !== undefined) head.push(`model: ${override.model}`);
  if (override.effort !== undefined) head.push(`effort: ${override.effort}`);
  return `${head.join("\n")}${raw.slice(end)}`;
}

// `extra` reaches PipelineInput as is: the profile tests set `bundledAgents`
// and `modelProfile` through it. The baseline fixtures never use it.
export async function captureBaseline(
  c: BaselineCase,
  extra: Pick<PipelineInput, "bundledAgents" | "modelProfile"> = {},
): Promise<Baseline> {
  const tmp = await mkdtemp(path.join(tmpdir(), "crysk-profiles-baseline-"));
  try {
    const runDir = path.join(tmp, "run");
    const worktree = path.join(tmp, "worktree");
    await mkdir(runDir, { recursive: true });
    await mkdir(path.join(worktree, "src"), { recursive: true });
    await writeFile(path.join(worktree, "src", "app.ts"), "new\n");
    let agentsDir = BUNDLED_AGENTS_DIR;
    if (c.customFrontmatter !== undefined) {
      agentsDir = path.join(tmp, "agents");
      await cp(BUNDLED_AGENTS_DIR, agentsDir, { recursive: true });
      for (const [file, override] of Object.entries(c.customFrontmatter)) {
        const target = path.join(agentsDir, file);
        await writeFile(
          target,
          rewriteFrontmatter(await readFile(target, "utf8"), override),
        );
      }
    }
    const diffPath = path.join(runDir, "diff.patch");
    await writeFile(diffPath, PATCH);
    const gotchasPath = path.join(runDir, "gotchas.md");
    await writeFile(gotchasPath, "G-01: fixture repository fact.\n");
    const input: PipelineInput = {
      pr: 7,
      baseSha: "1111111111111111111111111111111111111111",
      headSha: "2222222222222222222222222222222222222222",
      worktree,
      diffPath,
      gotchasPath,
      agentsDir,
      runDir,
      outPath: path.join(runDir, "findings.json"),
      mcpConfigPath: path.join(runDir, "mcp.json"),
      hopBudget: 4,
      // Parity is conditional: a trigger path makes it fire.
      parityTriggerPaths: ["src/app.ts"],
      suspicionPriors: [],
      boundaryNonce: NONCE,
      spec: localReviewSpec({}),
      summarizer: { promptPath: ROOT_PROMPT("summarizer.md") },
      scout: { promptPath: ROOT_PROMPT("scout.md") },
      consolidate: { promptPath: ROOT_PROMPT("consolidate.md") },
      materiality: { promptPath: ROOT_PROMPT("materiality.md") },
      ...(c.model === undefined ? {} : { model: c.model }),
      ...(c.models === undefined ? {} : { models: c.models }),
      ...extra,
    };
    const runner = new RecordingRunner();
    if (c.opencode) {
      const registry = new DefaultTransportRegistry();
      registry.register("opencode", capableOpenCode());
      await runPipeline(input, {
        runner,
        transportRegistry: registry,
        admissionEvidence: new Map<RunnerBackend, D1_11ReadinessEvidence>([
          ["opencode", READY],
        ]),
      });
    } else {
      await runPipeline(input, { runner });
    }
    const normalize = (text: string) =>
      text
        .split(runDir)
        .join("<RUN>")
        .split(worktree)
        .join("<WORKTREE>")
        .split(agentsDir)
        .join("<AGENTS>")
        .split(tmp)
        .join("<TMP>");
    const pipeline = JSON.parse(
      await readFile(path.join(runDir, "pipeline.json"), "utf8"),
    ) as {
      route_plan?: ResolvedRoutePlan;
      steps: Record<string, unknown>[];
    };
    const steps: RecordedStep[] = runner.recorded.map(({ spec, system }) => {
      const backend = spec.route?.backend ?? spec.backend ?? "claude-code";
      return {
        name: spec.name,
        backend,
        provider: spec.route?.provider ?? null,
        model: spec.model,
        modelSnapshot: spec.route?.modelSnapshot ?? null,
        modelVariant: spec.route?.modelVariant ?? null,
        effort: spec.effort,
        fallbackEfforts: spec.fallbackEfforts ?? null,
        effortApplied:
          spec.route === undefined ? true : effortApplied(spec.route),
        tools: spec.tools,
        systemPromptSha256: sha256(normalize(system)),
        promptSha256: sha256(normalize(spec.prompt)),
        cliModel:
          backend === "claude-code" && spec.route !== undefined
            ? claudeCliModel(spec.route)
            : null,
        argv:
          backend === "claude-code" ? buildStepArgv(spec).map(normalize) : null,
      };
    });
    // Hunters run in parallel, so spawn order is not part of the contract.
    steps.sort((a, b) => a.name.localeCompare(b.name));
    const plan = pipeline.route_plan;
    return {
      case: c.name,
      steps,
      plan:
        plan === undefined || plan === null
          ? null
          : {
              routeFingerprint: plan.routeFingerprint ?? null,
              steps: plan.steps.map((s) => ({
                stepKey: s.stepKey,
                role: s.role,
                logicalIdentity: s.logicalIdentity,
                routeFingerprint: s.routeFingerprint,
                effort: s.effort ?? null,
                route: { ...s.route },
                fallbacks: s.fallbacks?.map((f) => f.logicalIdentity) ?? null,
              })),
            },
      // Only the routing-relevant columns: timings and statuses are the fake
      // runner's, not the code under test.
      pipelineSteps: pipeline.steps
        .map((row) => {
          const keep: Record<string, unknown> = {};
          for (const key of [
            "name",
            "model",
            "effort",
            "effort_applied",
            "variant",
            "tools",
          ]) {
            if (key in row) keep[key] = row[key];
          }
          return keep;
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function baselinePath(name: string): string {
  return path.join(BASELINE_DIR, `${name}.json`);
}
