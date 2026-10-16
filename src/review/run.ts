// CLI decomposition P2.1 (odd/tasks/cli-decomposition.md): the pure stages
// shared by `review()` and `reviewPr()` in cli.ts. A block detector found 28
// verbatim-duplicated blocks (205 lines) between the two orchestrators; they
// walk the same sequence of stages, and `reviewPr` interleaves PR-only ones
// around them. This module extracts the PURE stages only — no `await`, no
// I/O — so each one gets a test and replaces its copy in BOTH orchestrators.
//
// Design rule (accepted 2026-09-16, see the task doc's "Design decision"):
// compose, never unify with a mode flag. Where the two orchestrators diverge
// (the working root, index_ms, ...), the difference is an explicit parameter
// here, never a branch on an `isPr`-shaped flag.
//
// P2.2 (odd/tasks/shared-run-stages.md) adds the run-lifecycle stages below.
// registerActiveRun and the try/finally around runPipeline stay call-site
// owned: their POSITION differs between the orchestrators, not their data.

import path from "node:path";
import {
  type EffectiveConfig,
  loadEffectiveConfig,
  notionalCostInput,
} from "#config/config";
import type { ResolvedRoutePlan, RoutingConfig } from "#model/routing";
import {
  type FindingsDocument,
  mergeRunEnvelope,
  type Telemetry,
  writeFindings,
} from "#review/findings";
import {
  changedPathsFromDiff,
  type PipelineDeps,
  type PipelineResult,
  parityTriggered,
} from "#review/pipeline";
import {
  type AgentsDirResolution,
  agentFilePath,
  assertBasenameOnly,
  type CliOptions,
  gotchasErrorMessage,
  gotchasUnusableReason,
  type LocalConfig,
  localReviewSpec,
  parseNumstatFiles,
  preflightAgentsDir,
  resolveAgentsDir,
  resolvePost,
  resolveScout,
  resolveSummary,
  type SummarySettings,
} from "#review/preflight";
import {
  type ParsedAgent,
  type PromptSetIdentity,
  parseAgentFile,
  promptSetIdentity,
} from "#review/prompt-set";
import { type DiffStat, envelopeModel, renderReport } from "#review/report";
import {
  buildCliRoutePlan,
  enforceProviderCapabilityGate,
  type ProductionRoutePlanResult,
  resolveProductionRoutePlanAtConfirm,
} from "#review/route-preflight";
import {
  effectiveDiffStat,
  evaluateSizeGate,
  type SizeGateConfig,
  type SizeGateVerdict,
} from "#review/size-gate";
import {
  type AgentSpec,
  type ReviewSpec,
  validateReviewSpec,
} from "#review/spec";
import { ClaudeCodeRunner } from "#review/step-runner";
import { CliError, withRecordClass } from "../errors";
import {
  createProductionRuntime,
  type ProductionAdmissionContext,
  type ProductionRuntime,
} from "../production-runtime";
import type { RunnerAuthorityResolution } from "../runner-authority";

// The codegraph server, and ONLY the codegraph server. Written per run and
// handed to every step together with the runner's --strict-mcp-config: an
// agent's tool surface is a threat model, not a preference, and a registry
// the driver did not write is a channel it does not control. Shared by both
// orchestrators (review() and reviewPr()), which is why it lives here rather
// than in either one's own module.
export const CODEGRAPH_ONLY_MCP_CONFIG = {
  mcpServers: {
    codegraph: {
      type: "stdio" as const,
      command: "codegraph",
      args: ["serve", "--mcp"],
    },
  },
};

export const EMPTY_MCP_CONFIG = { mcpServers: {} };

export interface LoadedRunConfig {
  loaded: EffectiveConfig;
  config: LocalConfig;
  summary: SummarySettings;
  scout: boolean;
  post: boolean;
}

// Config load + the three per-run resolvers read right after it: identical
// in both orchestrators except the root/home they read from (repoRoot +
// os.homedir() in review(), operatorRoot + the hoisted `home` in reviewPr()).
// Callers still own their own `options = { ...options, scout, post, ... }`
// reassignment — reviewPr() folds an extra `yes` field into the same spread,
// and forcing that in here would make this a mode flag instead of an
// explicit parameter.
export async function loadRunConfig(params: {
  root: string;
  home: string;
  configFlag: string | undefined;
  options: Pick<CliOptions, "summary" | "model" | "scout" | "post">;
}): Promise<LoadedRunConfig> {
  const loaded = await loadEffectiveConfig({
    root: params.root,
    home: params.home,
    configFlag: params.configFlag,
  });
  const config = loaded.effective;
  const summary = resolveSummary(params.options, config);
  const scout = resolveScout(params.options, config);
  const post = resolvePost(params.options, config);
  return { loaded, config, summary, scout, post };
}

// Shared range guard. Both orchestrators check the same thing right after
// resolving base/head — the copies are byte-identical apart from
// indentation — and both throw before spending anything on a range that
// reviews nothing.
export function assertDistinctRange(baseSha: string, headSha: string): void {
  if (baseSha === headSha) {
    throw new CliError(
      `base and head resolve to the same commit (${headSha}); there is ` +
        "nothing to review",
    );
  }
}

// The gotchas file path: an explicit `--gotchas` flag always wins (resolved
// against cwd, exactly like path.resolve did inline); otherwise it is
// `<root>/.prhero/gotchas.md`. `root` is the caller's own root — repoRoot in
// review(), operatorRoot in reviewPr(), repoDir in doctor.ts's default-branch
// check — never resolved here, so this stays agnostic of which mode called
// it.
export function resolveGotchasPath(
  flag: string | undefined,
  root: string,
): string {
  return flag !== undefined
    ? path.resolve(flag)
    : path.join(root, ".prhero", "gotchas.md");
}

// Byte-identical gotchas read + validation in both orchestrators. Neither
// caller reads the text afterward (only `gotchasPath` goes on to the
// pipeline), so this validates and returns nothing.
export async function validateGotchas(gotchasPath: string): Promise<void> {
  const file = Bun.file(gotchasPath);
  const gotchas = (await file.exists()) ? await file.text() : "";
  const unusable = gotchasUnusableReason(gotchas);
  if (unusable !== undefined) {
    // The class carries the gate's reason into cli.json (T2d-1). Both reasons render
    // the one gotchas code today; the reason stays on the record for that reason only.
    throw new CliError(gotchasErrorMessage(gotchasPath, unusable), {
      cls: { kind: "gotchas", reason: unusable },
    });
  }
}

// Which hunters actually run: every unconditional hunter, plus every
// conditional (triggered) hunter when the parity trigger fired. Refuters are
// never included — they are a different role. Identical in both
// orchestrators; `reviewPr()`'s own `skipDiscovery` short-circuit to `[]`
// stays a call-site concern (a re-review with no delta to discover), not a
// parameter here.
export function selectActiveHunters(
  agents: readonly AgentSpec[],
  parityFires: boolean,
): AgentSpec[] {
  return agents.filter(
    (a) => a.role === "hunter" && (a.trigger === undefined || parityFires),
  );
}

// Whether the parity hunter fires for this diff: identical in both
// orchestrators. `changedPathsFromDiff`'s own list is never read afterward
// by either caller, only this boolean.
export function resolveParityFires(
  patch: string,
  parityTriggerPaths: string[],
): boolean {
  return parityTriggered(changedPathsFromDiff(patch), parityTriggerPaths);
}

// The diff stat, TWICE and on purpose (moved here from review()'s own WHY
// comment when reviewPr()'s copy — which never carried it — started sharing
// this stage):
//
// The GATE counts from `-w --ignore-blank-lines`: a pure formatter sweep
// must not consume the budget, and a file whose every change is whitespace
// drops out of that numstat entirely (verified: git emits no row for it).
//
// The COST BAND counts from the plain numstat, exclusions applied. The
// hunters are handed diff.patch verbatim, whitespace hunks included, so
// those bytes are genuinely billed — pricing them at zero would be the same
// class of lie the exclusion bug was.
//
// `runGit` arrives as a callback, not an import of `git()` from `#git/git`:
// this module's import surface is deliberately narrowed to review-domain
// modules (see header), and the two orchestrators already run it against
// different roots (repoRoot vs gitDirOwner) — an explicit parameter here,
// never a branch on which mode called it.
export async function computeDiffStatAndSizeGate(params: {
  runGit: (
    args: string[],
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  range: string;
  pathArgs: string[];
  gateConfig: SizeGateConfig;
}): Promise<{ diffStat: DiffStat; sizeGate: SizeGateVerdict }> {
  const numstat = await params.runGit([
    "diff",
    "--numstat",
    params.range,
    ...params.pathArgs,
  ]);
  if (!numstat.ok) {
    throw new CliError(`git diff --numstat failed: ${numstat.stderr}`);
  }
  const gateNumstat = await params.runGit([
    "diff",
    "-w",
    "--ignore-blank-lines",
    "--numstat",
    params.range,
    ...params.pathArgs,
  ]);
  if (!gateNumstat.ok) {
    throw new CliError(`git diff -w --numstat failed: ${gateNumstat.stderr}`);
  }
  return {
    diffStat: effectiveDiffStat(
      parseNumstatFiles(numstat.stdout),
      params.gateConfig.excludeRules,
    ),
    sizeGate: evaluateSizeGate(
      parseNumstatFiles(gateNumstat.stdout),
      params.gateConfig,
    ),
  };
}

// The Telemetry artifact built right after runPipeline returns. Identical in
// both orchestrators except `index_ms`: local mode hardcodes 0 (it neither
// builds nor syncs a codegraph index), PR mode passes the measured build
// time.
export function buildTelemetry(
  result: PipelineResult,
  wallMs: number,
  indexMs: number,
): Telemetry {
  return {
    index_ms: indexMs,
    index_mode: "sync",
    index_disk_mb: 0,
    // Driver-MEASURED elapsed time, never the sum of the steps: hunters run
    // in parallel, so summing their wall clocks reports a number the run
    // never took — and this engine exists to be compared on time and cost.
    wall_ms: wallMs,
    tokens_in: result.usage.tokens_in,
    tokens_out: result.usage.tokens_out,
    tokens_total: result.usage.tokens_total,
    cost_usd_est: result.usage.cost_usd_est,
    ...(result.unresolved.length > 0 ? { cost_usd_est_is_floor: true } : {}),
    per_agent: result.perAgent,
  };
}

export interface RunFindingsResult {
  doc: FindingsDocument;
  findingsPath: string;
}

// The findings artifact: merge the run envelope, then write it. Identical in
// both orchestrators except `pr` (the schema-legal 0 for "not a PR" in
// review(), the real PR number in reviewPr()). `engine`'s type is read off
// `mergeRunEnvelope`'s own parameter rather than imported from
// `#git/identity` — this module's import surface stays review-domain-only
// (see header); the caller already has an `EngineIdentity` from calling
// `engineIdentity()` itself.
export async function writeRunFindings(params: {
  runDir: string;
  result: PipelineResult;
  pr: number;
  baseSha: string;
  headSha: string;
  options: Pick<CliOptions, "model">;
  agentFiles: Map<string, ParsedAgent>;
  promptSet: PromptSetIdentity;
  engine: Parameters<typeof mergeRunEnvelope>[0]["engine"];
  telemetry: Telemetry;
}): Promise<RunFindingsResult> {
  const doc = mergeRunEnvelope({
    skillOutput: params.result.skillOutput,
    pr: params.pr,
    base_sha: params.baseSha,
    head_sha: params.headSha,
    model: envelopeModel(params.options, params.agentFiles),
    iteration: 0,
    prompt_set: params.promptSet,
    engine: params.engine,
    sessionFailed: params.result.sessionFailed,
    telemetry: params.telemetry,
  });
  const findingsPath = path.join(params.runDir, "findings.json");
  await writeFindings(findingsPath, doc);
  return { doc, findingsPath };
}

// The report artifact: renderReport + write. Identical in both orchestrators
// except the repo/base/head labels (operator-root basename + `PR #<n>` in
// reviewPr(), repo-root basename + `--head` in review()).
export async function writeRunReport(params: {
  runDir: string;
  doc: FindingsDocument;
  repo: string;
  base: string;
  head: string;
  diffStat: DiffStat;
  droppedPaths: string[];
  result: PipelineResult;
  wallMs: number;
}): Promise<string> {
  const reportPath = path.join(params.runDir, "report.md");
  await Bun.write(
    reportPath,
    renderReport(params.doc, {
      repo: params.repo,
      base: params.base,
      head: params.head,
      diffStat: params.diffStat,
      excludedPaths: params.droppedPaths,
      costUsd: params.result.usage.cost_usd_est,
      ...notionalCostInput(params.result),
      wallMs: params.wallMs,
    }),
  );
  return reportPath;
}

export interface ResolvedPromptSet {
  agents: AgentsDirResolution;
  spec: ReviewSpec;
  agentFiles: Map<string, ParsedAgent>;
  promptSet: PromptSetIdentity;
}

// Prompt-set resolution: resolve the agents dir, validate + preflight the
// spec against it, parse every agent file, and compute the prompt set's
// identity (§3.9). Byte-identical in both orchestrators — the block
// detector's largest non-import match (17 lines).
export async function resolvePromptSet(
  options: Pick<CliOptions, "agents">,
  loaded: EffectiveConfig,
): Promise<ResolvedPromptSet> {
  const agents = resolveAgentsDir(options, loaded);
  const spec = validateReviewSpec(localReviewSpec());
  spec.agents.forEach((agent, i) => {
    assertBasenameOnly(agent.file, i);
  });
  await preflightAgentsDir(
    agents,
    spec.agents.map((a) => a.file),
  );
  const agentFiles = new Map<string, ParsedAgent>();
  for (const agent of spec.agents) {
    // Parsing every agent file now is a preflight too: a malformed
    // frontmatter block must fail here, not three spawned steps later.
    // A failure is the error parseAgentFile threw, with its prompt-set class
    // recorded beside it (T2d-1). It stays a plain Error, not a CliError: main()
    // prints a CliError as one line, and a local run has always let this failure
    // take the uncaught path with its excerpt and stack. Wrapping it in a helper
    // would add a stack frame, so the try stays here.
    let parsed: ParsedAgent;
    try {
      parsed = await parseAgentFile(agentFilePath(agents, agent.file));
    } catch (error) {
      throw withRecordClass(error, { kind: "prompt-set" });
    }
    agentFiles.set(agent.key, parsed);
  }
  // The prompt set's identity (§3.9), computed from the spec's DECLARATION
  // order — the same order the lab's promptSetFingerprint hashes in, so the
  // two sides produce the same string for the same bytes. Reading the list
  // off the bundled map's keys instead would move every fingerprint ever
  // recorded, silently — the digest still looks valid.
  const promptSet = await promptSetIdentity(
    agents.dir,
    spec.agents.map((a) => agentFilePath(agents, a.file)),
    // A bundled set has no directory basename to be named after. "default"
    // is what dev and npm derive from prompts/default, so the same prompt
    // set names itself identically in all three runtimes.
    agents.kind === "bundled" ? "default" : undefined,
  );
  return { agents, spec, agentFiles, promptSet };
}

// Byte-identical MCP registry write in both orchestrators; only the
// `codegraphAvailable` check (which config to write) differs upstream.
export async function writeMcpConfig(
  mcpConfigPath: string,
  codegraphAvailable: boolean,
): Promise<void> {
  await Bun.write(
    mcpConfigPath,
    `${JSON.stringify(
      codegraphAvailable ? CODEGRAPH_ONLY_MCP_CONFIG : EMPTY_MCP_CONFIG,
      null,
      2,
    )}\n`,
  );
}

// Production route resolution: identical in both orchestrators except the
// workspace root and (reviewPr()'s skipped-discovery re-review only) the
// summarizer/scout enable overrides. Named distinctly from
// resolveProductionRoutePlanAtConfirm (#review/route-preflight), which this
// wraps — `resolveProductionRoute` reads as a near-duplicate of that name at
// a glance, which is exactly the confusion a shared wrapper should not add.
export async function resolvePipelineRoute(params: {
  routingConfigured: boolean;
  workspaceRoot: string;
  spec: ReviewSpec;
  options: CliOptions;
  agentFiles: Map<string, ParsedAgent>;
  routingConfig: RoutingConfig | undefined;
  summary: SummarySettings;
  summarizerEnabled?: boolean;
  scoutEnabled?: boolean;
}): Promise<ProductionRoutePlanResult | undefined> {
  return resolveProductionRoutePlanAtConfirm({
    routingConfigured: params.routingConfigured,
    workspaceRoot: params.workspaceRoot,
    buildRoutePlan: () =>
      buildCliRoutePlan({
        spec: params.spec,
        options: params.options,
        agentFiles: params.agentFiles,
        routingConfig: params.routingConfig,
        summary: params.summary,
        summarizerEnabled: params.summarizerEnabled,
        scoutEnabled: params.scoutEnabled,
      }),
  });
}

// The capability gate: identical in both orchestrators except the workspace
// root. Wraps enforceProviderCapabilityGate (#review/route-preflight),
// unpacking the same three productionAdmission-derived fields both callers
// pass it.
export async function enforceCapabilityGate(params: {
  routePlan: ResolvedRoutePlan | undefined;
  workspaceRoot: string;
  runnerAuthority: RunnerAuthorityResolution;
  productionAdmission: ProductionAdmissionContext | undefined;
}): Promise<void> {
  await enforceProviderCapabilityGate({
    routePlan: params.routePlan,
    workspaceRoot: params.workspaceRoot,
    runnerAuthority: params.runnerAuthority,
    authorityOptions: params.productionAdmission?.authorityOptions,
    admissionRegistry: params.productionAdmission?.registry,
    productionEvidence: params.productionAdmission?.evidence,
  });
}

export interface PreparedPipelineRunner {
  productionRuntime: ProductionRuntime | undefined;
  deps: PipelineDeps;
}

// The run-lifecycle core (Target 1 + Target 3): create the production
// runtime when a route plan + admission are present (else `undefined`, the
// legacy path), then build the runPipeline's second argument around it — the
// production runtime's runner, or a fresh ClaudeCodeRunner sharing the
// ceiling's signal. Byte-identical logic in both orchestrators; only the
// workspace root differs. `productionRuntime` rides back out alongside
// `deps` because each caller's own `finally` disposes it — that ordering
// stays call-site-owned (see this module's header).
export async function prepareRunnerForRoute(params: {
  routePlan: ResolvedRoutePlan | undefined;
  productionAdmission: ProductionAdmissionContext | undefined;
  workspaceRoot: string;
  runnerAuthority: RunnerAuthorityResolution;
  ceilingController: AbortController;
  onProgress: PipelineDeps["onProgress"];
}): Promise<PreparedPipelineRunner> {
  const productionRuntime =
    params.routePlan === undefined || params.productionAdmission === undefined
      ? undefined
      : await createProductionRuntime({
          ...params.productionAdmission.authorityOptions,
          plan: params.routePlan,
          workspaceRoot: params.workspaceRoot,
          registry: params.productionAdmission.registry,
          evidence: params.productionAdmission.evidence,
          // #182 follow-up: without this the admission may decide
          // free-server while the bindings stay metered, and the runtime's
          // own guard refuses the divergence — both or neither.
          ...(params.productionAdmission.freeModelProbe === undefined
            ? {}
            : { freeModelProbe: params.productionAdmission.freeModelProbe }),
          mode: "production",
          signal: params.ceilingController.signal,
        });
  return {
    productionRuntime,
    deps: {
      runner:
        productionRuntime !== undefined
          ? productionRuntime.runner
          : new ClaudeCodeRunner({
              ...params.runnerAuthority.runnerOptions,
              signal: params.ceilingController.signal,
            }),
      ...(productionRuntime !== undefined
        ? {
            transportRegistry: productionRuntime.registry,
            ...(productionRuntime.evidence === undefined
              ? {}
              : { admissionEvidence: productionRuntime.evidence }),
          }
        : {}),
      ceilingController: params.ceilingController,
      onProgress: params.onProgress,
    },
  };
}
