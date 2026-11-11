// Slice-4 fixture eval (plan §Evals, slice 4b): the ENTIRE live pipeline —
// real Claude sessions, real git repo, real diff — against the planted
// fixture, asserted against its answer key. Costs cents (haiku frontmatter).
// Proves plumbing + contract end-to-end, NOT recall quality (the lab's job).
// Run: bun run fixture-eval
// Every step runs on its route through the production route path
// (src/harness/route-runner.ts): the route plan is built from the same
// pipeline input the run gets, so the fixture's haiku agents, the summarizer's
// frontmatter and `--model` route exactly as they did with no plan.
import path from "node:path";
import { validateFinding } from "#review/findings";
import { runPipeline } from "#review/pipeline";
import {
  buildPlantedFixture,
  FIXTURE_EVAL_SCOUT_MODEL,
  fixtureEvalPipelineInput,
} from "../fixtures/setup";
import {
  buildPipelineHarnessPlan,
  readPipelineRouteIdentity,
} from "../src/harness/pipeline-plan";
import { prepareHarnessRunner } from "../src/harness/route-runner";
import { resolveRunClaudeCredential } from "../src/security/claude-credential";

// `bun run fixture-eval --scout` (ROADMAP-DOORDASH M5's exit: the planted bug
// is still found with the flag ON and with it OFF). The scout runs on
// FIXTURE_EVAL_SCOUT_MODEL (haiku), as the rest of the run does.
const scoutEnabled = Bun.argv.includes("--scout");
const agentsArgIndex = Bun.argv.indexOf("--agents");
const customAgentsDir =
  agentsArgIndex !== -1 && Bun.argv[agentsArgIndex + 1]
    ? path.resolve(Bun.argv[agentsArgIndex + 1])
    : undefined;

const modelArgIndex = Bun.argv.indexOf("--model");
const customModel =
  modelArgIndex !== -1 ? Bun.argv[modelArgIndex + 1] : undefined;

const fixture = await buildPlantedFixture();

// Empty MCP registry + the runner's --strict-mcp-config: the fixture repo has
// no codegraph index, so the steps run on Read/Grep/Glob alone and no other
// MCP source can leak in.
const mcpConfigPath = path.join(fixture.runDir, "mcp.json");
await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

const input = fixtureEvalPipelineInput(fixture, {
  mcpConfigPath,
  scout: scoutEnabled,
  ...(customModel ? { model: customModel } : {}),
  ...(customAgentsDir ? { agentsDir: customAgentsDir } : {}),
});

// Prepared only after the disposable repo exists: its root is where every
// step below executes, so that is the root admission must name. The deps
// carry §5.3 D1-10b's ONE ceiling controller, shared by the pipeline and the
// runtime, so in-flight steps stop when the ceiling fires instead of billing
// on — and this eval spends real money.
const harness = await prepareHarnessRunner({
  workspaceRoot: fixture.repoDir,
  buildRoutePlan: () => buildPipelineHarnessPlan(input),
  claudeRun: resolveRunClaudeCredential({}),
});

const started = performance.now();
let result: Awaited<ReturnType<typeof runPipeline>>;
try {
  result = await runPipeline(
    { ...input, routePlan: harness.plan },
    harness.deps,
  );
} finally {
  await harness.dispose();
}
const wallMs = Math.round(performance.now() - started);

const failures: string[] = [];
const { skillOutput } = result;

// (1) Structural: the SkillOutput draft must already be schema-shaped —
// findings is an array of validator-clean findings and the run completed.
if (Array.isArray(skillOutput.findings)) {
  for (const [i, finding] of skillOutput.findings.entries()) {
    try {
      validateFinding(finding, i);
    } catch (error) {
      failures.push(`findings[${i}] invalid: ${(error as Error).message}`);
    }
  }
} else {
  failures.push("skillOutput.findings is not an array");
}
if (skillOutput.run_status !== "complete") {
  failures.push(
    `run_status is "${skillOutput.run_status}", expected "complete"`,
  );
}

// (2) The planted-defect hit. Searched across findings[] AND the debug
// arrays: a haiku refuter may kill the planted finding, and dedupe may fold
// it into a sibling — the eval proves PLUMBING, so an emission that reached
// the pipeline counts even when refutation or a merge buried it. Overlap
// semantics only (path match + line inside the range), never exact-claim
// matching — see PlantedFixture.expected.
const candidates = [
  ...skillOutput.findings,
  ...skillOutput.debug.refuted,
  ...(skillOutput.debug.deduped ?? []),
];
const { expected } = fixture;
const hit = candidates.find(
  (f) =>
    f.path === expected.path &&
    f.line >= expected.lineMin &&
    f.line <= expected.lineMax,
);
if (!hit) {
  failures.push(
    `no finding overlaps the planted defect at ${expected.path}:` +
      `${expected.lineMin}-${expected.lineMax} ` +
      `(${candidates.length} candidate(s) emitted)`,
  );
}

// (3) Run-dir artifacts: every hunter that ran must have left its templated
// system prompt and its delivered draft next to each other in steps/.
const hunters = [
  "reliability",
  "resilience",
  ...(skillOutput.parity_hunter_fired ? ["parity"] : []),
];
for (const hunter of hunters) {
  for (const suffix of ["system.md", "draft.json"]) {
    const artifact = path.join(
      fixture.runDir,
      "steps",
      `hunter-${hunter}.${suffix}`,
    );
    if (!(await Bun.file(artifact).exists())) {
      failures.push(`missing step artifact: ${artifact}`);
    }
  }
}

// (4) Frozen-plan provenance, and the scout row inside it. Read rather than
// merely existence-checked now: the arm a run belongs to must be legible from
// the artifact alone (§3.9), and this is the cheapest place that claim gets
// exercised against a REAL run instead of a fake runner.
const planPath = path.join(fixture.runDir, "pipeline.json");
if (!(await Bun.file(planPath).exists())) {
  failures.push("missing pipeline.json in run dir");
} else {
  const plan = (await Bun.file(planPath).json()) as {
    scout?: { enabled?: boolean; status?: string; leads_count?: number };
    generated_at?: string;
  };
  if (typeof plan.generated_at !== "string") {
    failures.push("pipeline.json carries no generated_at");
  }
  if (plan.scout?.enabled !== scoutEnabled) {
    failures.push(
      `pipeline.json scout.enabled is ${plan.scout?.enabled}, expected ${scoutEnabled}`,
    );
  }
  // A FAILED scout is a legal outcome the run survives (§3.6) — it is not a
  // legal outcome for the eval, which exists to prove the wiring works.
  if (scoutEnabled && plan.scout?.status !== "ok") {
    failures.push(`scout status is "${plan.scout?.status}", expected "ok"`);
  }
  if (!scoutEnabled) {
    const leadsArtifact = path.join(
      fixture.runDir,
      "steps",
      "scout.leads.json",
    );
    if (await Bun.file(leadsArtifact).exists()) {
      failures.push("the control arm wrote a scout artifact");
    }
  }
}

// (4b) With the flag on: the step's own artifact, and its bill.
if (scoutEnabled) {
  const leadsArtifact = path.join(fixture.runDir, "steps", "scout.leads.json");
  if (!(await Bun.file(leadsArtifact).exists())) {
    failures.push(`missing step artifact: ${leadsArtifact}`);
  }
  const entry = result.perAgent.scout;
  if (!entry) {
    failures.push("perAgent has no entry for scout");
  } else if (entry.tokens_total <= 0) {
    failures.push(`perAgent.scout.tokens_total is ${entry.tokens_total}`);
  }
}

// (5) Per-agent telemetry: each hunter ran as its own session, so each must
// have a real (non-zero) token bill.
for (const hunter of hunters) {
  const entry = result.perAgent[hunter];
  if (!entry) {
    failures.push(`perAgent has no entry for ${hunter}`);
  } else if (entry.tokens_total <= 0) {
    failures.push(`perAgent.${hunter}.tokens_total is ${entry.tokens_total}`);
  }
}

let routeFingerprint: string | null = null;
try {
  routeFingerprint = (
    await readPipelineRouteIdentity(fixture.runDir, "hunter-reliability")
  ).routeFingerprint;
} catch (error) {
  failures.push(`no route identity: ${(error as Error).message}`);
}

const pass = failures.length === 0;
console.log(
  JSON.stringify(
    {
      pass,
      cost_usd: result.usage.cost_usd_est,
      wall_ms: wallMs,
      scout: scoutEnabled,
      ...(scoutEnabled ? { scout_model: FIXTURE_EVAL_SCOUT_MODEL } : {}),
      // The identity of what ran, from the run's own pipeline.json.
      route_fingerprint: routeFingerprint,
      findings_count: skillOutput.findings.length,
      hit: hit ? { path: hit.path, line: hit.line } : null,
      run_dir: fixture.runDir,
      ...(pass ? {} : { failures }),
    },
    null,
    2,
  ),
);
if (!pass) process.exit(1);
