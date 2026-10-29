// PR mode's target resolution (ROADMAP B1): the front half of reviewPr()
// that turns `--pr <n>` into an operator root, a resolved config, a prompt
// set, and a PR record — everything before the CI admission gate, the dry
// run, and the fetch/discovery machinery. Relocated out of reviewPr()
// (src/pr/review-pr.ts): identifiers moved onto explicit parameters, control
// flow and WHY comments unchanged.
//
// Split into three functions rather than one, deliberately: two calls sit
// between them in reviewPr() itself — `resolveEagerLocalIgnore(...)`
// (src/pr/range.ts, invariant 7/O-8) and `validateGotchas(gotchasPath)`
// (guarded by test/architecture/review-shell-invariants.test.ts's directory
// scan, not a per-file pin) — and both need to run in this exact relative
// position: the ignore read right after step 1's config load, gotchas
// validation right after step 2's prompt-set resolution, before step 2's own
// target record is resolved. Folding either call into this module would
// change that relative order, so reviewPr() keeps calling them inline, in
// between these three calls, in the exact original order.

import { existsSync } from "node:fs";
import os from "node:os";
import {
  budgetDisabledWarningMessage,
  budgetUnlimitedNoticeMessage,
  type CiSizeLimits,
  deriveCiBillingMode,
  resolveCiBudgetCeiling,
  resolveCiSizeLimits,
  sizeGateUnlimitedNoticeMessage,
} from "#ci/gates";
import { formatWorkflowCommand } from "#ci/reporter";
import { resolveRepoRoot } from "#git/git";
import { ghCurrentBranchPr, ghPrView } from "#pr/pr";
import {
  type PrTarget,
  predictPrRunDir,
  resolveCurrentPrNumber,
  resolvePrDryRunSizeGate,
  resolvePrTarget,
} from "#pr/preflight";
import {
  type AgentsDirResolution,
  type AgentsDirSource,
  type CliOptions,
  isCiEnvironment,
  type NumstatFile,
} from "#review/preflight";
import type { ParsedAgent, PromptSetIdentity } from "#review/prompt-set";
import type { estimateCost } from "#review/report";
import {
  type LoadedRunConfig,
  loadRunConfig,
  resolveGotchasPath,
  resolvePromptSet,
} from "#review/run";
import type { SizeGateConfig } from "#review/size-gate";
import type { ReviewSpec } from "#review/spec";
import { configProvenanceOf, type PrPlanContext, renderPrPlan } from "#ui/plan";
import { log, styleEnabled } from "#ui/primitives";
import { type ResolvedRepoHome, resolveRepoHome } from "../home";
import {
  legacyMigrationHint,
  legacyWorktreePath,
  prWorktreePath,
} from "../home-preflight";
import { resolveOpenCodeAuthPath } from "../security/credential-broker";

export interface ResolvedPrRunOptions {
  operatorRoot: string;
  prNumber: number;
  home: string;
  isCi: boolean;
  options: CliOptions;
  loaded: LoadedRunConfig["loaded"];
  config: LoadedRunConfig["config"];
  summary: LoadedRunConfig["summary"];
}

// Step 1's first half: the operator root, the PR number, `home`, and the
// config load — identical to loadRunConfig's own callers, plus reviewPr()'s
// own isCi/options-yes fold-in (ROADMAP Pillar 3). Returns BEFORE the
// `.cryskignore` read: `readLocalIgnoreRules(operatorRoot)` needs
// `operatorRoot` and `isCi` from here, but stays an inline statement in
// reviewPr() itself (see this module's header).
export async function resolvePrRunOptions(
  options: CliOptions,
  prArg: number | "current",
): Promise<ResolvedPrRunOptions> {
  // 1 — the operator root, and everything .prhero/ decides — loaded exactly
  // as local mode loads it, all against the operator root.
  const operatorRoot = await resolveRepoRoot(options.repo);
  // Bare --pr: the PR is whichever one the operator checkout's current
  // branch belongs to. Resolved first and said out loud, so the user sees
  // WHICH PR is about to be reviewed before any plan prints.
  const prNumber =
    prArg === "current"
      ? resolveCurrentPrNumber(await ghCurrentBranchPr(operatorRoot))
      : prArg;
  if (prArg === "current") {
    log(`pr resolved from current branch: #${prNumber}`);
  }
  // The product home, hoisted above the config read: C5's global layer lives
  // under it, and the PR-record resolution below needs the same value for
  // the repo registry.
  const home = os.homedir();
  // `operatorRoot`, NEVER worktreePath — the worktree does not even exist
  // yet at this point, and a `.crysk/config.json` committed by the PR author
  // must stay unread (O-8). Same loader as local mode, so the two modes
  // cannot drift on precedence.
  const { loaded, config, summary, scout, post } = await loadRunConfig({
    root: operatorRoot,
    home,
    configFlag: options.config,
    options,
  });
  // ROADMAP Pillar 3 (GitHub Actions CI). isCi folds in HERE, alongside
  // scout/post, so `options.yes` carries the headless bypass (spec 2.1:
  // "MUST run headlessly ... equivalent to --yes") through every downstream
  // read of `options.yes` in one move — the confirm gate, the in-flight
  // TOCTOU check (`if (options.yes) return 0` is the correct CI answer to a
  // stuck pending), and applySizeGate's own `opts.yes` read. A parallel
  // `effectiveYes` local would miss whichever of those reads came later.
  const isCi = isCiEnvironment(options, {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    CI: process.env.CI,
  });
  return {
    operatorRoot,
    prNumber,
    home,
    isCi,
    options: { ...options, scout, post, yes: options.yes || isCi },
    loaded,
    config,
    summary,
  };
}

export interface ResolvedPrPromptSet {
  ciBudgetCeiling: ReturnType<typeof resolveCiBudgetCeiling>;
  ciSizeLimits: CiSizeLimits | undefined;
  agents: AgentsDirResolution;
  spec: ReviewSpec;
  agentFiles: Map<string, ParsedAgent>;
  promptSet: PromptSetIdentity;
  gotchasPath: string;
}

// Step 1's second half: the CI budget ceiling (+ its notices), then the
// prompt set resolution and the gotchas PATH (never the validation itself —
// see this module's header). Runs after the caller's own
// `readLocalIgnoreRules(operatorRoot)` read, before its own
// `validateGotchas(gotchasPath)` call — same relative order reviewPr() has
// always executed them in.
export async function resolvePrPromptSetAndBudget(params: {
  options: CliOptions;
  loaded: LoadedRunConfig["loaded"];
  config: LoadedRunConfig["config"];
  isCi: boolean;
  operatorRoot: string;
}): Promise<ResolvedPrPromptSet> {
  // File presence, not envBillsMetered: that predicate stamps Claude
  // usage and must stay Anthropic-env-only.
  const billingMode = deriveCiBillingMode(process.env, {
    openCodeAuthPresent: existsSync(resolveOpenCodeAuthPath()),
  });
  // Issue #156: resolve the ceiling ONCE, here, and use this same value at
  // the budget gate far below (src/pr/review-pr.ts's plan/confirm stage).
  // Resolving twice invites the announcement and the gate drifting apart.
  // Deliberately NOT folded back into `options.budgetUsd` — the metered
  // default is a CI-gate policy, and leaking a 10 that the operator never
  // typed into every other read of `options.budgetUsd` would make it look
  // configured.
  const ciBudgetCeiling = resolveCiBudgetCeiling({
    configured: params.options.budgetUsd,
    billingMode,
  });
  // The size gate's half of the same route policy (ci/gates.ts,
  // resolveCiSizeLimits). CI only: a local or watcher run keeps reading the
  // flags and the repo config exactly as before.
  const ciSizeLimits = params.isCi
    ? resolveCiSizeLimits({
        flags: params.options,
        config: params.config,
        billingMode,
      })
    : undefined;
  // Spec 3.1: a silent disable is indistinguishable from a passing gate, so
  // an EXPLICIT `--budget-usd <= 0` warns even though it never skips a run.
  // Emitted here (once, as soon as isCi/budgetUsd are both known) rather
  // than beside the budget-gate check far below, which only runs at all when
  // there IS an estimate to compare against. The subscription notice rides
  // the same reasoning and the same placement, one register quieter: a
  // resolved no-ceiling is not an operator mistake, but it is still a gate
  // that did not run, and this repo does not ship those silently.
  if (params.isCi) {
    const disabledWarning = budgetDisabledWarningMessage(
      ciBudgetCeiling.budgetUsd,
    );
    if (disabledWarning !== null) {
      log(formatWorkflowCommand("warning", disabledWarning));
    }
    const unlimitedNotice = budgetUnlimitedNoticeMessage(ciBudgetCeiling);
    if (unlimitedNotice !== null) {
      log(formatWorkflowCommand("notice", unlimitedNotice));
    }
    if (ciSizeLimits !== undefined) {
      const sizeNotice = sizeGateUnlimitedNoticeMessage(ciSizeLimits);
      if (sizeNotice !== null) {
        log(formatWorkflowCommand("notice", sizeNotice));
      }
    }
  }
  // The WHOLE resolution, not just its dir: under the compiled binary the
  // prompt set is a map of embedded paths and `dir` is only a display label.
  const { agents, spec, agentFiles, promptSet } = await resolvePromptSet(
    params.options,
    params.loaded,
  );
  const gotchasPath = resolveGotchasPath(
    params.options.gotchas,
    params.operatorRoot,
  );
  return {
    ciBudgetCeiling,
    ciSizeLimits,
    agents,
    spec,
    agentFiles,
    promptSet,
    gotchasPath,
  };
}

// PR1b Addition 1 / #5557's degrade rule, extracted so it can be proven
// offline: a dry run creates nothing and is a PLAN, so a stalled or failing
// `gh pr view --json files` must degrade to the aggregate estimate rather
// than abort (GH_PR_VIEW_TIMEOUT_MS bounds `ghPrFiles`, turning a hang into a
// throw this function is what catches). `null` is returned DIRECTLY on
// failure or on a truncated fetch, never an empty array routed through the
// length check: `[].length >= 0` is true, so an empty list would sail
// through as "trustworthy" and hand the per-file gate zero lines to measure —
// a PASSING verdict manufactured out of a failed fetch, which is the one
// outcome a size gate must never invent. `totalFiles` is GitHub's own
// `changedFiles` counter (`target.ghDiffStat.files`); a per-file list shorter
// than it is the same truncation hazard watch/watch.ts's tier 2 guards
// against, and under-counting here would falsely rescue exactly the PR this
// gate exists to catch.
export async function resolvePrDryRunNumstat(params: {
  fetchFiles: () => Promise<NumstatFile[]>;
  totalFiles: number;
}): Promise<NumstatFile[] | null> {
  try {
    const rawFiles = await params.fetchFiles();
    return rawFiles.length >= params.totalFiles ? rawFiles : null;
  } catch {
    return null;
  }
}

export interface ResolvedPrTargetRecord {
  repoHome: ResolvedRepoHome;
  gitDirOwner: string;
  target: PrTarget;
  worktreePath: string;
}

// Step 2: the global home (origin -> repo-id -> worktree/runs paths), then
// the PR record itself. `home` and `operatorRoot` are the caller's own
// step-1 results; C5's global config layer already needed the same `home`
// value. `persist` is false on --dry-run so the free exit creates nothing,
// including registry.json. Local mode's dirty-tree and HEAD-match gates are
// both skipped for PR review ON PURPOSE: the hunters read the worktree and
// never this checkout, and the worktree satisfies the HEAD gate by
// construction (created detached at the PR's own head).
export async function resolvePrTargetRecord(params: {
  home: string;
  operatorRoot: string;
  prNumber: number;
  dryRun: boolean;
}): Promise<ResolvedPrTargetRecord> {
  const repoHome = await resolveRepoHome({
    home: params.home,
    operatorRoot: params.operatorRoot,
    persist: !params.dryRun,
  });
  const gitDirOwner = repoHome.gitDirOwner;
  const target = resolvePrTarget(
    await ghPrView(params.operatorRoot, params.prNumber),
  );
  const worktreePath = prWorktreePath(
    params.home,
    repoHome.repoId,
    params.prNumber,
  );
  const leftover = legacyWorktreePath(params.operatorRoot, params.prNumber);
  if (existsSync(leftover)) {
    for (const line of legacyMigrationHint({
      operatorRoot: params.operatorRoot,
      legacyWorktree: leftover,
      newWorktree: worktreePath,
    })) {
      log(line);
    }
  }
  return { repoHome, gitDirOwner, target, worktreePath };
}

// Step 3's second half: the free dry-run exit's size-gate verdict, plan
// card, and closing lines. Relocated out of reviewPr()'s `if (options.dryRun)`
// block; the FIRST half of that block (hunterCount/estimate/dryRunGateConfig,
// then the `resolvePrDryRunNumstat` call just above) stays inline in
// reviewPr(), unchanged. This half picks up right after `perFile` is known
// and returns the dry run's exit code (always 0).
export function renderPrDryRunPlan(params: {
  options: CliOptions;
  operatorRoot: string;
  prNumber: number;
  target: PrTarget;
  worktreePath: string;
  repoHome: ResolvedRepoHome;
  agentsDir: string;
  agentsDirSource: AgentsDirSource;
  agentFiles: Map<string, ParsedAgent>;
  spec: ReviewSpec;
  config: LoadedRunConfig["config"];
  summary: LoadedRunConfig["summary"];
  loaded: LoadedRunConfig["loaded"];
  isCi: boolean;
  hunterCount: number;
  estimate: ReturnType<typeof estimateCost>;
  dryRunGateConfig: SizeGateConfig;
  perFile: NumstatFile[] | null;
}): number {
  const { verdict: estimated, note: baseSizeGateNote } =
    resolvePrDryRunSizeGate({
      ghDiffStat: params.target.ghDiffStat,
      perFile: params.perFile,
      gateConfig: params.dryRunGateConfig,
    });
  // Under CI, `localIgnore` is intentionally undefined (see reviewPr()'s own
  // comment on that read) — the base-ref read needs a fetch a dry run does
  // not perform — so this estimate applies only the 9 BUILT-IN default
  // exclusions, never a repo's user-defined `.cryskignore` rules. Said out
  // loud rather than discovered: a CI dry run that quietly ignored
  // `.cryskignore` would look like the SAME bug Addition 1 exists to fix.
  const sizeGateNote = params.isCi
    ? `${baseSizeGateNote} User-defined \`.cryskignore\` rules are not ` +
      "applied to this estimate under --ci; only the built-in defaults " +
      "are (the base ref is not fetched until a real run)."
    : baseSizeGateNote;
  const dryRunPlan: PrPlanContext = {
    options: params.options,
    operatorRoot: params.operatorRoot,
    target: params.target,
    worktreePath: params.worktreePath,
    runDir: predictPrRunDir(
      params.options,
      params.operatorRoot,
      params.worktreePath,
      params.repoHome.paths.runs,
      params.prNumber,
      params.target.headSha,
    ),
    diffStat: params.target.ghDiffStat,
    agentsDir: params.agentsDir,
    agentFiles: params.agentFiles,
    spec: params.spec,
    config: params.config,
    summary: params.summary,
    estimate: params.estimate,
    hunterCount: params.hunterCount,
    sizeGate: estimated,
    sizeGateNote,
    droppedPaths: [],
    // On the dry run too, and it is the case that matters most: this is the
    // free card an operator reads BEFORE deciding to spend, so a value
    // arriving from the global layer must be visible here or it is
    // discovered only in the bill.
    configProvenance: configProvenanceOf(params.loaded, params.agentsDirSource),
  };
  for (const line of renderPrPlan(dryRunPlan, styleEnabled())) log(line);
  log();
  if (!estimated.ok && !params.options.force) {
    log("dry run: this PR would likely be SKIPPED by the size gate.");
  }
  log("dry run: nothing was fetched, created, or spent.");
  return 0;
}
