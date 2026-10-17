// PR mode's plan-and-confirm stage (ROADMAP B1): the real (non-dry-run) plan
// card, its two possible early exits (the CI budget gate, a declined
// interactive confirm), and the "committed to spending" commit-status hold
// that follows a successful confirm. Relocated out of reviewPr()
// (src/pr/review-pr.ts): identifiers moved onto explicit parameters, control
// flow and WHY comments unchanged.
//
// `parityFires` / `activeHunters` / `hunterCount` stay computed in
// reviewPr() itself: `activeHunters` is derived via `discoveryHunters`
// (src/pr/discovery.ts, invariant 1 — behavior-tested in
// test/pr/discovery.test.ts, not pinned as literal source) and is read only
// by reviewPr()'s own progress renderer, never by this stage. Only
// `hunterCount` (and `parityFires`, for the plan card's `resolved` field)
// actually cross into this function.
//
// A discriminated union, not a flat result-plus-sentinel: the two early-exit
// branches (`exitCode: number`) genuinely have no route plan, runner
// authority, or status url to report — the caller returns immediately and
// never reads them — so giving that branch real fields to fill would mean
// fabricating values nothing produced. Same intent as
// CiAdmissionGateResult's `exitCode: number | undefined` sentinel
// (src/pr/ci-admission-gate.ts), expressed so the type checker enforces it.
import {
  recordPendingCreatedAt,
  recordPendingPosting,
  recordReviewing,
} from "#ci/cli-record";
import { planCiBudgetSkip } from "#ci/gates";
import type { ResolvedRoutePlan } from "#model/routing";
import {
  type CiAdmissionLedgerState,
  publishCiSkip,
  settleCiGateSkip,
} from "#pr/admission";
import { ghRepoWebUrl } from "#pr/pr";
import {
  type CiMode,
  type CommitStatusContext,
  commitStatusRequest,
  type PrTarget,
  prHtmlUrl,
} from "#pr/preflight";
import { holdCommitStatusLock, tryPublishCommitStatus } from "#pr/status";
import type { buildPhaseBQueue, PreparedDiscovery } from "#rereview/prepare";
import {
  type AgentsDirSource,
  type CliOptions,
  resolveMaxVerificationSteps,
} from "#review/preflight";
import type { ParsedAgent } from "#review/prompt-set";
import { type DiffStat, estimateCost } from "#review/report";
import {
  enforceCapabilityGate,
  type LoadedRunConfig,
  resolvePipelineRoute,
} from "#review/run";
import type { SizeGateVerdict } from "#review/size-gate";
import type { ReviewSpec } from "#review/spec";
import {
  configProvenanceOf,
  type PrPlanContext,
  prPlanDetails,
  renderPrPlan,
} from "#ui/plan";
import { log, styleEnabled } from "#ui/primitives";
import { confirm } from "#ui/progress";
import type { ProductionAdmissionContext } from "../production-runtime";
import {
  type RunnerAuthorityResolution,
  resolveRunnerAuthority,
} from "../runner-authority";

export type PrPlanAndConfirmResult =
  | { exitCode: number }
  | {
      exitCode: undefined;
      postEnabled: boolean;
      routePlan: ResolvedRoutePlan | undefined;
      productionAdmission: ProductionAdmissionContext | undefined;
      runnerAuthority: RunnerAuthorityResolution;
      maxVerificationSteps: number;
      estimate: ReturnType<typeof estimateCost>;
      statusTargetUrl: string | undefined;
    };

export async function resolvePrPlanAndConfirm(params: {
  options: CliOptions;
  operatorRoot: string;
  prNumber: number;
  target: PrTarget;
  worktreePath: string;
  runDir: string;
  headSha: string;
  baseSha: string;
  diffFromSha: string;
  diffPath: string;
  diffStat: DiffStat;
  droppedPaths: string[];
  sizeGate: SizeGateVerdict;
  sizeGateConfirmed: boolean;
  agentsDir: string;
  agentsDirSource: AgentsDirSource;
  agentFiles: Map<string, ParsedAgent>;
  spec: ReviewSpec;
  config: LoadedRunConfig["config"];
  summary: LoadedRunConfig["summary"];
  loaded: LoadedRunConfig["loaded"];
  isCi: boolean;
  // The one resolution of the run's CI mode (resolveCiPosture, reviewPr). Passed
  // down, never re-resolved here.
  ciMode: CiMode;
  // The context this run's statuses post on: pr-hero only for an explicit --ci
  // run, pr-hero/local otherwise (resolveCiPosture). Passed down, never re-derived.
  statusContext: CommitStatusContext;
  ciBudgetCeiling: { budgetUsd: number | undefined };
  ciAdmissionLedger: CiAdmissionLedgerState | null;
  skipDiscovery: boolean;
  hunterCount: number;
  parityFires: boolean;
  verifyQueue: ReturnType<typeof buildPhaseBQueue>["queued"];
  prepared: PreparedDiscovery;
}): Promise<PrPlanAndConfirmResult> {
  const maxVerificationSteps = resolveMaxVerificationSteps(params.config);
  const queuedVerification = Math.min(
    params.verifyQueue.length,
    maxVerificationSteps,
  );
  const estimate = estimateCost(
    params.diffStat,
    params.hunterCount,
    params.summary.enabled && !params.skipDiscovery,
    params.options.scout && !params.skipDiscovery,
    queuedVerification,
  );
  // 7b(CI) — the budget gate, immediately after the estimate it reads and
  // BEFORE the plan card/confirm/"committed to spending" commit-status
  // block below: spec 3.1 ("Review MUST halt before agent spawning") is
  // satisfied at any point before runPipeline, and this is the earliest
  // point the REAL (parity-narrowed) estimate exists — the same one the
  // plan card is about to show, so the skip comment's number and the
  // (unrendered) plan's number can never have disagreed. `estimate.high`,
  // not `.low`: report.ts's own doctrine (~97-98) is that every recorded
  // overrun was an UNDER-estimate, so the generous side is the cheap one
  // to be wrong on. `force` is passed through: a `/pr-hero review` comment
  // sets `--force`, and that one run clears this ceiling the same way it
  // clears the size gate and admission. The interactive cost-band prompt
  // is a different question and still requires `--yes` on its own.
  // Unlike the size gate, this runs AFTER
  // createPrRunDir (step 6), so a budget skip can leave a near-empty run
  // dir behind — the tidiness rationale that placement protects against
  // (the watcher's attempt counter) does not apply to an ephemeral CI
  // runner, and restructuring the cost estimate earlier is out of Phase
  // 3's scope.
  // `ciBudgetCeiling.budgetUsd`, not `options.budgetUsd`: since issue #156
  // an unset `--budget-usd` is a POLICY, not an absent number. It resolves
  // to no ceiling on a subscription route (where `estimate.high` is a token
  // figure and the cash cost is $0.00, so gating on it refused work over an
  // overrun that cannot happen) and to the default ceiling on a metered one.
  // `undefined` here still means the gate does not run — the announcement
  // for that already fired at the resolution site above.
  if (params.isCi && params.ciBudgetCeiling.budgetUsd !== undefined) {
    const budgetPlan = planCiBudgetSkip({
      isCi: params.isCi,
      estimatedCostUsd: estimate.high,
      budgetUsd: params.ciBudgetCeiling.budgetUsd,
      prNumber: params.prNumber,
      force: params.options.force,
      ciMode: params.ciMode,
    });
    if (budgetPlan !== null) {
      await settleCiGateSkip(
        params.ciAdmissionLedger,
        "estimated cost exceeds the configured CI budget ceiling",
      );
      const exitCode = await publishCiSkip({
        operatorRoot: params.operatorRoot,
        prNumber: params.prNumber,
        post: params.options.post === true,
        isCi: params.isCi,
        stepSummaryFlag: params.options.stepSummary,
        plan: budgetPlan,
        noticeMessage:
          "pr-hero review skipped — estimated cost exceeds the configured CI budget ceiling",
        ciMode: params.ciMode,
        headSha: params.headSha,
      });
      return { exitCode };
    }
  }
  const productionRoute = await resolvePipelineRoute({
    routingConfigured: params.config.routing !== undefined,
    workspaceRoot: params.worktreePath,
    spec: params.spec,
    options: params.options,
    agentFiles: params.agentFiles,
    routingConfig: params.config.routing,
    summary: params.summary,
    summarizerEnabled: params.summary.enabled && !params.skipDiscovery,
    scoutEnabled: params.options.scout && !params.skipDiscovery,
  });
  const routePlan = productionRoute?.routePlan;
  const productionAdmission = productionRoute?.productionAdmission;
  const runnerAuthority = await resolveRunnerAuthority({
    workspaceRoot: params.worktreePath,
  });
  await enforceCapabilityGate({
    routePlan,
    workspaceRoot: params.worktreePath,
    runnerAuthority,
    productionAdmission,
  });
  // Same reason as local mode's planContext: the card and the confirm menu's
  // details view must describe one and the same planned run.
  const planContext: PrPlanContext = {
    options: params.options,
    operatorRoot: params.operatorRoot,
    target: params.target,
    worktreePath: params.worktreePath,
    runDir: params.runDir,
    diffStat: params.diffStat,
    agentsDir: params.agentsDir,
    agentFiles: params.agentFiles,
    spec: params.spec,
    config: params.config,
    summary: params.summary,
    estimate,
    hunterCount: params.hunterCount,
    sizeGate: params.sizeGate,
    droppedPaths: params.droppedPaths,
    configProvenance: configProvenanceOf(params.loaded, params.agentsDirSource),
    resolved: {
      baseSha: params.baseSha,
      diffFromSha: params.diffFromSha,
      diffPath: params.diffPath,
      parityFires: params.parityFires,
    },
    ...(params.sizeGateConfirmed ? { sizeGateConfirmed: true } : {}),
    ...(queuedVerification > 0
      ? { verificationSteps: queuedVerification }
      : {}),
    ...(params.prepared.case === "A"
      ? {}
      : {
          rereview: {
            case: params.prepared.case,
            lastHead: params.prepared.last.L,
            discoveryRestricted: params.prepared.plan.discoveryRestricted,
            skipDiscovery: params.skipDiscovery,
          },
        }),
    ...(routePlan === undefined ? {} : { routePlan }),
  };
  for (const line of renderPrPlan(planContext, styleEnabled())) log(line);
  // What this run will actually publish. `options` is never mutated: the plan
  // card and the details view print what was ASKED FOR, and only the run
  // itself follows the answer given here.
  let postEnabled = params.options.post ?? false;
  if (!params.options.yes) {
    const choice = await confirm(
      estimate.low,
      estimate.high,
      params.options.post ?? false,
      () => prPlanDetails(planContext, styleEnabled()),
    );
    if (choice.kind === "cancel") {
      log("aborted; nothing was spent.");
      return { exitCode: 1 };
    }
    postEnabled = choice.post;
    if (params.options.post && !postEnabled) {
      log("posting disabled for this run; the review still runs.");
    }
  }

  // Committed to spending: a pending commit status is the GitHub-visible
  // in-flight signal. Check Runs need a GitHub App; this CLI posts as the
  // operator via `gh`, so the write path is the Statuses API. Size-gate
  // abort and a declined confirm never reach here.
  const statusTargetUrl = prHtmlUrl(
    await ghRepoWebUrl(params.operatorRoot),
    params.prNumber,
  );
  // WHY the progress record comes BEFORE the pending post (F001 and F002 on #330): the
  // publisher gives a run with no record no status on any head, so the record is what
  // says the lock is this run's and on which head. The CLI records that it is about to
  // hold the lock before it posts the lock, so no kill can leave a landed pending with
  // no record; such a pending would stay until the admission gate's 90-minute TTL
  // expires. If the post never lands and the CLI then dies, the publisher reads no
  // pending status on that head and posts the error status (unless the head's newest
  // pr-hero status already settled), which is right, because the run died. If the CLI
  // completes, its terminal record overwrites `reviewing`.
  // WHY the start is read here, before the record and the POST: the POST can take two
  // attempts of 15 s, and an override posted while it is in flight was posted during this
  // run. Stamping after the POST would class that override as before the run and overwrite
  // it (the override rule, src/ci/override.ts).
  const runStartedMs = Date.now();
  recordReviewing(params.headSha);
  recordPendingPosting();
  const pendingLanded = await tryPublishCommitStatus(
    params.operatorRoot,
    params.headSha,
    commitStatusRequest({
      phase: "pending",
      posted: false,
      targetUrl: statusTargetUrl,
      context: params.statusContext,
    }),
    undefined,
    (createdAt) => recordPendingCreatedAt(createdAt),
  );
  // From here the lock is HELD, and the only two ways out both clear it:
  // the finally below on the normal path, and the signal handlers in runCli
  // on the cancelled one. Held even if the publish above failed — a settle
  // for a status that was never posted is a harmless no-op write, whereas
  // skipping the hold on a publish that actually landed is the #162 bug. Whether the
  // pending landed is passed too: only a landed pending vouches for runStartedMs in the
  // override check (teardown.ts).
  holdCommitStatusLock(
    {
      operatorRoot: params.operatorRoot,
      sha: params.headSha,
      targetUrl: statusTargetUrl,
      context: params.statusContext,
    },
    runStartedMs,
    pendingLanded,
  );

  return {
    exitCode: undefined,
    postEnabled,
    routePlan,
    productionAdmission,
    runnerAuthority,
    maxVerificationSteps,
    estimate,
    statusTargetUrl,
  };
}
