// Local mode (ROADMAP B0): point the engine at a real repo + branch and get a
// human-readable review back. Moved out of src/cli.ts (cli-decomp Phase 2,
// odd/tasks/cli-decomposition.md) as a byte-for-byte relocation — no
// behaviour change. See src/cli.ts's own header for the two hard rules that
// run through the sequence below (every failure loud and before any spend;
// human-readable output to stderr).

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ingestReviewMetrics,
  notionalCostInput,
  persistCanonicalReview,
  pipelineConfigInput,
} from "#config/config";
import {
  git,
  localResultLinks,
  resolveBase,
  resolveCommit,
  resolveDiffFrom,
  resolveRepoRoot,
} from "#git/git";
import { engineIdentity } from "#git/identity";
import { countFreeRouteSteps } from "#model/free-discovery";
import { reviewPr } from "#pr/review-pr";
import type { Telemetry } from "#review/findings";
import { type PipelineResult, runPipeline } from "#review/pipeline";
import {
  allExcludedMessage,
  type CliOptions,
  createRunDir,
  emptyDiffMessage,
  resolveMaxConcurrentSteps,
  resolveSharedPrefix,
} from "#review/preflight";
import { estimateCost } from "#review/report";
import {
  pipelineConsolidateInput,
  pipelineScoutInput,
  pipelineSummarizerInput,
} from "#review/route-preflight";
import {
  assertDistinctRange,
  buildTelemetry,
  computeDiffStatAndSizeGate,
  enforceCapabilityGate,
  loadRunConfig,
  prepareRunnerForRoute,
  resolveGotchasPath,
  resolveParityFires,
  resolvePipelineRoute,
  resolvePromptSet,
  selectActiveHunters,
  validateGotchas,
  writeMcpConfig,
  writeRunFindings,
  writeRunReport,
} from "#review/run";
import { filterDiffByIgnoreRules, sizeGateConfigFor } from "#review/size-gate";
import { registerActiveRun, unregisterActiveRun } from "#store/activity";
import {
  configProvenanceOf,
  type PlanContext,
  planDetails,
  renderPlan,
  reviewingLine,
} from "#ui/plan";
import { log, styleEnabled } from "#ui/primitives";
import { applySizeGate, confirm, startProgressRenderer } from "#ui/progress";
import { renderResult } from "#ui/result";
import { freeBillingMode } from "#ui/select";
import { CliError } from "../errors";
import { prheroLayout } from "../home-preflight";
import { readLocalIgnoreRules } from "../ignore-read";
import type { ProductionRuntime } from "../production-runtime";
import { resolveRunnerAuthority } from "../runner-authority";

export async function review(options: CliOptions): Promise<number> {
  // PR mode is a different front half (gh-resolved range, detached worktree)
  // around the same pipeline; it branches here so the local flow below stays
  // byte-for-byte what B0 shipped.
  if (options.pr !== undefined) return reviewPr(options, options.pr);

  // 1 — the repo.
  const repoRoot = await resolveRepoRoot(options.repo);

  // 2 — the config, read BEFORE anything that consumes it. It now carries
  // agents_dir and default_base, so both the prompt set and the base ref
  // depend on it; loading it later would mean resolving them against a config
  // that had not been read yet.
  //
  // Two layers since C5, folded by loadEffectiveConfig into the one
  // LocalConfig everything below already expected. The --config missing-file
  // error and the boundary rules live there.
  const { loaded, config, summary, scout, post } = await loadRunConfig({
    root: repoRoot,
    home: os.homedir(),
    configFlag: options.config,
    options,
  });
  options = { ...options, scout, post };

  // 3 — the base ref, then the canonical refs and the range.
  const baseRef = await resolveBase(repoRoot, options, config);
  const baseSha = await resolveCommit(repoRoot, baseRef.ref);
  const headSha = await resolveCommit(repoRoot, options.head);
  assertDistinctRange(baseSha, headSha);
  const diffFromSha = await resolveDiffFrom(
    repoRoot,
    options.twoDot,
    baseRef.ref,
    options.head,
    baseSha,
    headSha,
  );

  // 4 — the tree the hunters will actually read.
  // Every spawned step runs with repoRoot as its cwd, so the bytes under
  // review are the WORKING TREE, not the commit. A dirty tree, or a checkout
  // sitting on a different commit than --head, means the report describes one
  // thing and the hunters read another — and nothing downstream can detect it.
  const status = await git(repoRoot, ["status", "--porcelain"]);
  if (!status.ok) throw new CliError(`git status failed: ${status.stderr}`);
  if (status.stdout.trim().length > 0) {
    throw new CliError(
      "the working tree is dirty. Every review step reads this checkout " +
        "directly, so uncommitted changes would be reviewed but never " +
        "reported. Commit or stash them first:\n" +
        `${status.stdout.trimEnd()}`,
    );
  }
  const checkedOut = await resolveCommit(repoRoot, "HEAD");
  if (checkedOut !== headSha) {
    throw new CliError(
      `HEAD is ${checkedOut} but --head resolves to ${headSha}. The steps ` +
        "read the checkout, so review the commit that is checked out (or " +
        "check out the one you want reviewed).",
    );
  }

  // 5 + 6 — the prompt set and the wiring that consumes it.
  // The WHOLE resolution, not just its dir: under the compiled binary the
  // prompt set is a map of embedded paths and `dir` is only a display label.
  const { agents, spec, agentFiles, promptSet } = await resolvePromptSet(
    options,
    loaded,
  );
  const { dir: agentsDir, source: agentsDirSource } = agents;

  // 7 — gotchas. Checked HERE rather than left to the pipeline's fail-loud
  // abort: the pipeline is right to refuse, but all it can return is a
  // zero-cost partial run, which reads like a clean review to a human.
  //
  // `--gotchas` exists because requiring the file INSIDE the reviewed tree
  // makes two legitimate cases impossible: reviewing a historical commit (the
  // file would be an untracked addition, and the clean-tree gate rightly
  // refuses), and reviewing a repo you do not control. The gotchas describe
  // the repo, not the commit, so they do not belong to the checkout.
  const gotchasPath = resolveGotchasPath(options.gotchas, repoRoot);
  await validateGotchas(gotchasPath);

  // 7.5 — `.prheroignore`, read from the WORKING TREE. Local review has no
  // PR-author trust boundary to defend (there is no "someone else's commit"
  // here — repoRoot is the operator's own checkout), so it is read from
  // exactly the tree the diff below comes from, the same way gotchas.md just
  // was.
  const userIgnore = await readLocalIgnoreRules(repoRoot);

  // 8 — run dir + diff.
  const { runDir, repoId } = await createRunDir(options, repoRoot, headSha);
  const diffPath = path.join(runDir, "diff.patch");
  // diffFromSha, never baseSha: see resolveDiffFrom. The numstat below uses
  // the same endpoint on purpose — a cost estimate computed over a wider range
  // than the one being reviewed is a bill that arrives from nowhere.
  const diff = await git(repoRoot, ["diff", `${diffFromSha}..${headSha}`]);
  if (!diff.ok) throw new CliError(`git diff failed: ${diff.stderr}`);
  if (diff.stdout.trim().length === 0) {
    throw new CliError(
      emptyDiffMessage(baseRef.ref, options.head, options.twoDot),
    );
  }
  // The EFFECTIVE diff is what lands in diff.patch, because diff.patch is
  // what the pipeline hands to every hunter: excluded files must fall out of
  // the reviewed diff itself, or the gate discounts a lockfile the bill still
  // pays for in full (see filterDiffByIgnoreRules). diff.raw.patch keeps the
  // unfiltered bytes for audit, and only when there is a difference to audit.
  const gateConfig = sizeGateConfigFor(options, loaded.effective, userIgnore);
  const effectiveDiff = filterDiffByIgnoreRules(
    diff.stdout,
    gateConfig.excludeRules,
  );
  if (effectiveDiff.patch.trim().length === 0) {
    throw new CliError(allExcludedMessage(effectiveDiff.droppedPaths));
  }
  await Bun.write(diffPath, effectiveDiff.patch);
  if (effectiveDiff.droppedPaths.length > 0) {
    await Bun.write(path.join(runDir, "diff.raw.patch"), diff.stdout);
  }

  // 9 — diff stat, TWICE and on purpose. See computeDiffStatAndSizeGate
  // (src/review/run.ts) for the full rationale.
  const { diffStat, sizeGate } = await computeDiffStatAndSizeGate({
    runGit: (args) => git(repoRoot, args),
    range: `${diffFromSha}..${headSha}`,
    pathArgs: [],
    gateConfig,
  });

  // 10 — MCP registry.
  const mcpConfigPath = path.join(runDir, "mcp.json");
  const codegraphAvailable = existsSync(path.join(repoRoot, ".codegraph"));
  await writeMcpConfig(mcpConfigPath, codegraphAvailable);

  // 11 — the plan. Triggers read the EFFECTIVE diff, the same bytes the
  // pipeline will read back from diff.patch: a conditional hunter must never
  // fire on a path no hunter was given.
  const parityFires = resolveParityFires(
    effectiveDiff.patch,
    config.parity_trigger_paths,
  );
  const activeHunters = selectActiveHunters(spec.agents, parityFires);
  const hunterCount = activeHunters.length;
  const estimate = estimateCost(
    diffStat,
    hunterCount,
    summary.enabled,
    options.scout,
    0,
    true,
  );
  const productionRoute = await resolvePipelineRoute({
    routingConfigured: config.routing !== undefined,
    workspaceRoot: repoRoot,
    spec,
    options,
    agentFiles,
    routingConfig: config.routing,
    summary,
  });
  const routePlan = productionRoute?.routePlan;
  const productionAdmission = productionRoute?.productionAdmission;
  // Read off the admission above, which already decided every free verdict:
  // this adds no probe. Absent without routing, so the band stays.
  const freeRoute =
    routePlan === undefined || productionAdmission === undefined
      ? undefined
      : await countFreeRouteSteps({
          steps: routePlan.steps,
          probe: productionAdmission.freeModelProbe,
        });
  // Named rather than inlined into renderPlan: the same context is what the
  // confirm menu's "Show details" renders, and building it twice would risk
  // the card and the details view disagreeing about the run they describe.
  const planContext: PlanContext = {
    options,
    repoRoot,
    baseRef,
    baseSha,
    diffFromSha,
    headSha,
    diffStat,
    diffPath,
    agentsDir,
    agentFiles,
    spec,
    runDir,
    config,
    summary,
    parityFires,
    codegraphAvailable,
    estimate,
    hunterCount,
    // Evaluated above (step 9) and ENFORCED below at step 13, unchanged;
    // the plan only prints the verdict, last, where the decision is made.
    sizeGate,
    droppedPaths: effectiveDiff.droppedPaths,
    configProvenance: configProvenanceOf(loaded, agentsDirSource),
    ...(routePlan === undefined ? {} : { routePlan }),
    ...(freeRoute === undefined ? {} : { freeRoute }),
  };
  for (const line of renderPlan(planContext, styleEnabled())) log(line);

  // 12 — the free exit. Dry run reports the gate verdict (including that it
  // WOULD skip) and still exits 0: its contract is "everything except
  // spawn", and a $0 report is never a failure.
  if (options.dryRun) {
    log();
    if (!sizeGate.ok && !options.force) {
      log("dry run: this diff would be SKIPPED by the size gate (exit 1).");
    }
    log("dry run: nothing was spawned and nothing was spent.");
    return 0;
  }

  // 12.5 — the capability gate (§11/D1-09): routed runs gate exact-binding
  // readiness for the bindings that would execute; legacy runs keep the
  // claude-code ProviderCapabilityReport path byte-compatible.
  const runnerAuthority = await resolveRunnerAuthority({
    workspaceRoot: repoRoot,
  });
  await enforceCapabilityGate({
    routePlan,
    workspaceRoot: repoRoot,
    runnerAuthority,
    productionAdmission,
  });

  // 13 — the size gate, BEFORE the cost band's confirm() for the unattended
  // path. The watcher spawns with --yes, so a gate that lived only inside
  // that confirmation would never fire in the one place — unattended spend
  // — it exists to protect. An interactive TTY is offered Continue/Cancel
  // instead of dying: --force stays the unattended hatch, not the only one.
  const sizeGateChoice = await applySizeGate(sizeGate, options);
  if (sizeGateChoice === "abort") return 1;

  // 14 — the paid one. Local mode can never post (parseArgs rejects --post
  // without --pr), so the "don't post" option is not offered and the choice's
  // `post` field carries nothing local mode could act on.
  if (!options.yes) {
    const choice = await confirm(
      estimate.low,
      estimate.high,
      false,
      () => planDetails(planContext, styleEnabled()),
      freeRoute,
    );
    if (choice.kind === "cancel") {
      log("aborted; nothing was spent.");
      return 1;
    }
  }

  // 15 — run, with live progress: the expectation line up front, then one
  // stderr line per pipeline event (plus a TTY heartbeat between them).
  log(reviewingLine(hunterCount, summary, options));
  const started = performance.now();
  const progress = startProgressRenderer(
    started,
    `${baseRef.ref}..${options.head}`,
    activeHunters.map((a) => a.key),
    spec.agents.some((a) => a.role === "refuter"),
    summary.enabled,
  );
  let result: PipelineResult;
  await registerActiveRun({
    pid: process.pid,
    repo: repoId ?? path.basename(repoRoot),
    runDir,
    startedAt: new Date().toISOString(),
  });
  // §5.3 D1-10b: ONE controller shared by the pipeline and the runner. The
  // pipeline aborts it when the ceiling fires; the runner's harness reads the
  // same signal and refuses to start another attempt. Two controllers would
  // leave the ceiling unable to stop the steps it is waiting on.
  const ceilingController = new AbortController();
  let productionRuntime: ProductionRuntime | undefined;
  try {
    const prepared = await prepareRunnerForRoute({
      routePlan,
      productionAdmission,
      workspaceRoot: repoRoot,
      runnerAuthority,
      ceilingController,
      onProgress: progress.onProgress,
      maxConcurrentSteps: resolveMaxConcurrentSteps(config),
    });
    productionRuntime = prepared.productionRuntime;
    result = await runPipeline(
      {
        // Local mode has no PR number. 0 is the schema-legal "not a PR" value
        // the fixture eval already uses.
        pr: 0,
        // The commit the diff was actually computed against, not the tip of the
        // base branch: the recorded base_sha must name the range that was
        // reviewed, or nothing downstream can reproduce it.
        baseSha: diffFromSha,
        headSha,
        worktree: repoRoot,
        diffPath,
        excludedPaths: effectiveDiff.droppedPaths,
        exclusions: effectiveDiff.exclusions,
        ignoreFile: { readFrom: "working-tree", found: userIgnore.found },
        gotchasPath,
        agentsDir,
        ...(agents.files ? { agentFiles: agents.files } : {}),
        runDir,
        outPath: path.join(runDir, "findings.json"),
        mcpConfigPath,
        hopBudget: options.hopBudget,
        ...(options.model ? { model: options.model } : {}),
        parityTriggerPaths: config.parity_trigger_paths,
        suspicionPriors: config.suspicion_priors,
        ...pipelineSummarizerInput(summary),
        ...pipelineScoutInput(options),
        ...pipelineConsolidateInput(),
        ...(resolveSharedPrefix(options) ? { sharedPrefix: true } : {}),
        ...pipelineConfigInput(loaded),
        ...(routePlan === undefined ? {} : { routePlan }),
        engine: await engineIdentity(),
        promptSet,
        spec,
      },
      prepared.deps,
    );
  } finally {
    // try/finally, never success-only: a leaked interval keeps the event
    // loop alive and hangs process exit on the error path.
    progress.stop();
    await unregisterActiveRun(process.pid);
    if (productionRuntime !== undefined) {
      await productionRuntime.dispose();
    }
  }
  const wallMs = Math.round(performance.now() - started);

  // 16 — the artifact. Local mode neither builds nor syncs a codegraph
  // index (it consumes whatever the repo already has), so indexMs is 0.
  const telemetry: Telemetry = buildTelemetry(result, wallMs, 0);
  const { doc, findingsPath } = await writeRunFindings({
    runDir,
    result,
    pr: 0,
    baseSha: diffFromSha,
    headSha,
    options,
    agentFiles,
    promptSet,
    engine: await engineIdentity(),
    telemetry,
  });

  // 16b — canonical product store & observability metrics.
  persistCanonicalReview({
    repoId,
    runDir,
    checkoutPath: repoRoot,
    doc,
    perAgent: result.perAgent,
    log,
  });
  ingestReviewMetrics({
    dbPath: prheroLayout(os.homedir()).metricsDbPath,
    repoId,
    runDir,
    checkoutPath: repoRoot,
    doc,
    perAgent: result.perAgent,
    log,
  });

  // 17 — the report.
  const reportPath = await writeRunReport({
    runDir,
    doc,
    repo: path.basename(repoRoot),
    base: baseRef.ref,
    head: options.head,
    diffStat,
    droppedPaths: effectiveDiff.droppedPaths,
    result,
    wallMs,
  });

  // 18 — the summary. Counts, the FINDINGS THEMSELVES, where the artifacts
  // landed, and a clickable url per finding: the renderer derives every number
  // from `doc`, so the terminal cannot disagree with the findings.json written
  // two steps up. Links are best-effort and silent when unavailable (no github
  // remote, or a head this repo has not pushed) — see localResultLinks.
  const links = await localResultLinks(repoRoot, headSha);
  for (const line of renderResult({
    doc,
    costUsd: result.usage.cost_usd_est,
    ...notionalCostInput(result),
    ...(freeRoute === undefined ? {} : { billing: freeBillingMode(freeRoute) }),
    wallMs,
    estimate: { low: estimate.low, high: estimate.high },
    runDir,
    artifacts: [path.basename(reportPath), path.basename(findingsPath)],
    ...(links === undefined ? {} : { links }),
    sessionFailed: result.sessionFailed,
    ...(result.unresolved.length > 0 ? { unresolved: result.unresolved } : {}),
    styles: styleEnabled(),
  })) {
    log(line);
  }
  if (result.sessionFailed) return 1;
  return 0;
}
