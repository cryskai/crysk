// PR mode's CI admission gate (ROADMAP Pillar 3): decides, before any git
// fetch or worktree is touched, whether a CI-triggered review of an
// already-reviewed head should run, skip, or fall back to a human decision.
// Relocated out of reviewPr() (src/pr/review-pr.ts): identifiers renamed to
// explicit parameters (`target.headSha` -> `headSha`, etc.), control flow
// unchanged. The WHY comments below explain decisions made while this code
// still lived inline, and they move with it.
//
// A no-op on --dry-run (a dry run creates nothing, including ledger writes)
// and on --force (an explicit override answers the same question this gate
// asks). Both guards are read straight off the caller's own CliOptions.
//
// yieldToInFlightReview (below) is the later, second stand-down point: a
// review already in flight on the same head. It lives here rather than
// inline in reviewPr() so its ledger settlement is reachable from a test.

import {
  type AdmissionRecord,
  selectActiveReservation,
} from "#ci/admission-ledger";
import { writeCliRecord } from "#ci/cli-record";
import {
  type AdmissionContext,
  planCiReviewManualRequired,
  planCiReviewSkip,
} from "#ci/gates";
import { formatWorkflowCommand } from "#ci/reporter";
import {
  type CiReviewPolicy,
  ciReviewManualRequiredDetail,
  ciReviewPolicyHash,
  ciReviewSkipDetail,
  countableWorkflowHeads,
  deltaTouchesPriorFindings,
  evaluateCiReviewAdmission,
  formatCiAdmissionObserveNotice,
  parseCiAdmissionBlock,
  pathsFromPostedFindingMarkers,
  resolveCiAdmissionAttemptCount,
  resolveCiReviewPolicy,
  resolveCiTrustedActors,
  scanPostedFindingTiers,
  stateReviewCount,
  validateAdmissionAuthority,
} from "#ci/review-admission";
import {
  classifyChangedPaths,
  type DeltaRiskAssessment,
} from "#ci/review-risk";
import {
  type CiAdmissionLedgerState,
  publishCiSkip,
  recordCiAdmissionGateSkip,
  reserveCiAdmissionLedger,
  settleCiAdmissionLedger,
  settleCiGateSkip,
} from "#pr/admission";
import {
  CommentsTruncatedError,
  fetchCommitStatuses,
  fetchPrComments,
  fetchPrReviewComments,
  ghCompareChangedFilesWithStatus,
  ghPrHeroWorkflowRunHeads,
  listAdmissionCheckRuns,
} from "#pr/pr";
import {
  type CiMode,
  type CommitStatusContext,
  findMarkedCommentId,
  IN_FLIGHT_TTL_MS,
  inFlightContextsFor,
  isInFlightCommitStatus,
} from "#pr/preflight";
import { parseStateBlock } from "#rereview/state";
import type { CliOptions, LocalConfig } from "#review/preflight";
import { log } from "#ui/primitives";
import {
  markerCommentSeen,
  parsePrCommentMarker,
  summaryMarkerFields,
} from "#watch/preflight";
import { CliError } from "../errors";

export interface CiAdmissionGateResult {
  ciPolicy: CiReviewPolicy;
  ciPolicyHash: string;
  ledgerRecords: AdmissionRecord[];
  // Defined only when the gate decided the run must stop here — the caller
  // returns this value immediately, exactly as reviewPr() used to `return`
  // inline from inside this block.
  exitCode: number | undefined;
}

export async function evaluateCiAdmissionGate(input: {
  operatorRoot: string;
  prNumber: number;
  headSha: string;
  config: LocalConfig;
  isCi: boolean;
  // The run's one resolved CI mode (resolveCiMode, reviewPr): the footer of the
  // admission skip's summary follows it.
  ciMode: CiMode;
  options: CliOptions;
  // Test-only seams (defaults: the real Bun.spawn / recordCiAdmissionGateSkip).
  // Every gh() caller below already threads an invisible-to-production
  // `spawnFn` (see pr/pr.ts's own WHY); this gate had no way to reach any of
  // them because it never exposed the option itself. `recordSkip` covers
  // recordCiAdmissionGateSkip specifically because it (via
  // reserveCiAdmissionLedger -> upsertAdmissionCheckRun) has no spawnFn
  // threading of its own and admission.ts is out of scope for this slice.
  // publishCiSkip is deliberately NOT seamed here: with `options.post`
  // unset it never calls gh at all, only the two env-path file writers.
  spawnFn?: typeof Bun.spawn;
  recordSkip?: typeof recordCiAdmissionGateSkip;
}): Promise<CiAdmissionGateResult> {
  const { operatorRoot, prNumber, headSha, config, isCi, options } = input;
  const spawnFn = input.spawnFn;
  const recordSkip = input.recordSkip ?? recordCiAdmissionGateSkip;
  const ciPolicy = resolveCiReviewPolicy(config);
  const ciPolicyHash = ciReviewPolicyHash(ciPolicy);
  let ledgerRecords: AdmissionRecord[] = [];

  if (!options.dryRun && isCi) {
    ledgerRecords = await listAdmissionCheckRuns(operatorRoot, headSha, {
      spawnFn,
    });
  }

  if (!options.dryRun && !options.force && isCi) {
    let issueComments: Awaited<ReturnType<typeof fetchPrComments>>;
    let reviewComments: Awaited<ReturnType<typeof fetchPrReviewComments>>;
    let authorityFailOpen = false;
    try {
      [issueComments, reviewComments] = await Promise.all([
        fetchPrComments(operatorRoot, prNumber, { spawnFn }),
        fetchPrReviewComments(operatorRoot, prNumber, { spawnFn }),
      ]);
    } catch (error) {
      if (error instanceof CommentsTruncatedError) {
        authorityFailOpen = true;
        issueComments = [];
        reviewComments = [];
      } else {
        throw error;
      }
    }
    const existingSummaryId = findMarkedCommentId(issueComments);
    const summaryBody =
      existingSummaryId === null
        ? null
        : (issueComments.find((c) => c.id === existingSummaryId)?.body ?? null);
    const summaryMarker =
      summaryBody === null ? null : parsePrCommentMarker(summaryBody);
    const { summaryHead, summaryComplete } = summaryMarkerFields(summaryMarker);
    const state = summaryBody === null ? null : parseStateBlock(summaryBody);
    const parsedAdmission =
      summaryBody === null ? null : parseCiAdmissionBlock(summaryBody);
    const authority = validateAdmissionAuthority({
      summaryHead,
      reportMarkerHead: summaryHead,
      state,
      admission: parsedAdmission,
    });
    if (!authority.ok) {
      authorityFailOpen = true;
    }
    const trustedActors = resolveCiTrustedActors({
      githubActor: process.env.GITHUB_ACTOR,
      extra: config.ci_trusted_actors,
    });
    const allComments = [...reviewComments, ...issueComments];
    const postedFindings =
      summaryHead === null
        ? null
        : scanPostedFindingTiers({
            summaryHead,
            comments: allComments,
            trustedActors,
          });
    const markerSeen = markerCommentSeen(issueComments);
    const stateCount = stateReviewCount(state, markerSeen, parsedAdmission);
    const headBranch = process.env.GITHUB_HEAD_REF;
    const workflowHeads =
      headBranch === undefined || headBranch.length === 0
        ? new Set<string>()
        : await ghPrHeroWorkflowRunHeads(operatorRoot, headBranch, {
            spawnFn,
          });
    // #326: a run concluded `success` even when the gate skipped it (a skip
    // exits 0), so the run list alone over-counts. Each workflow head's ledger
    // rows say whether it spent. One read per distinct head: `gh run list`
    // returns at most 20 runs by default, so that is at most 20 reads per gate
    // evaluation. Each read fails open to [], which keeps that head counted (the
    // pre-fix behavior), so a failed read can only over-count, never under-count.
    // Each read asks for the head's full attempt history (`includeHistory`): the
    // default returns only the newest row, which would hide a spent attempt
    // behind a later skip.
    //
    // WHY every head reads history, the current head included: the current head
    // can be a workflow head too (a prior concluded run on this same head), and
    // its newest row alone can be a gate-skip that hides an earlier spent
    // attempt. Reusing ledgerRecords (latest-only) here would drop that head and
    // admit an extra paid review past ci_max_attempts. ledgerRecords itself stays
    // latest-only because its other readers (the active-reservation check and
    // countTerminalAttempts) want current state; changing them is a separate
    // decision.
    const ledgerByHead = new Map<string, readonly AdmissionRecord[]>();
    await Promise.all(
      [...workflowHeads].map(async (head) => {
        ledgerByHead.set(
          head,
          await listAdmissionCheckRuns(operatorRoot, head, {
            spawnFn,
            includeHistory: true,
          }),
        );
      }),
    );
    const countedHeads = countableWorkflowHeads(workflowHeads, ledgerByHead);
    const reviewCount = resolveCiAdmissionAttemptCount({
      stateCount,
      workflowHeads: countedHeads,
      ledgerRecords,
    });
    let deltaTouchesPriorFindingsFlag = false;
    let deltaRisk: DeltaRiskAssessment | null = null;
    if (summaryHead !== null && summaryHead !== headSha) {
      const compareFiles = await ghCompareChangedFilesWithStatus(
        operatorRoot,
        summaryHead,
        headSha,
        { spawnFn },
      );
      const changedPaths = compareFiles.map((entry) => entry.path);
      deltaRisk = classifyChangedPaths(
        changedPaths,
        compareFiles.map((entry) => ({
          path: entry.path,
          status: entry.status,
        })),
      );
      const priorPaths = pathsFromPostedFindingMarkers(
        allComments,
        summaryHead,
        trustedActors,
      );
      if (priorPaths.length > 0) {
        deltaTouchesPriorFindingsFlag = deltaTouchesPriorFindings(
          changedPaths,
          priorPaths,
        );
      }
    }
    const admissionVerdict = evaluateCiReviewAdmission({
      currentHead: headSha,
      summaryHead,
      summaryComplete,
      markerSeen,
      reviewCount,
      state,
      admission: parsedAdmission,
      postedFindings,
      policy: ciPolicy,
      deltaTouchesPriorFindings: deltaTouchesPriorFindingsFlag,
      deltaRisk,
      authorityFailOpen,
    });
    const admissionContext: AdmissionContext = {
      currentHead: headSha,
      reviewedHead: summaryHead,
      policyMode: ciPolicy.mode,
      policyHash: ciPolicyHash,
      deltaRisk,
    };
    const observeOnly = config.ci_admission_observe_only === true;
    if (
      observeOnly &&
      (admissionVerdict.action === "skip" ||
        admissionVerdict.action === "manual-required")
    ) {
      log(
        formatWorkflowCommand(
          "notice",
          formatCiAdmissionObserveNotice({
            verdict: admissionVerdict,
            currentHead: headSha,
            reviewedHead: summaryHead,
            policyMode: ciPolicy.mode,
            policyHash: ciPolicyHash,
            deltaRisk,
          }),
        ),
      );
    }
    if (!observeOnly && admissionVerdict.action === "skip") {
      const skipReason = ciReviewSkipDetail(admissionVerdict);
      await recordSkip({
        operatorRoot,
        prNumber,
        headSha,
        policy: ciPolicy,
        policyHash: ciPolicyHash,
        existing: ledgerRecords,
        reason: skipReason,
        priorScore: admissionVerdict.prior.score,
        blockingCount: admissionVerdict.prior.blocking,
        advisoryCount: admissionVerdict.prior.advisory,
      });
      // S4: in gate mode the head inherits the verdict of the PR's own last reviewed commit, read from
      // that commit's statuses (publishCiSkip, admissionSkipDecision): a skipped head never reads as one
      // nobody decided about.
      const plan = planCiReviewSkip({
        prNumber,
        verdict: admissionVerdict,
        admission: admissionContext,
        ciMode: input.ciMode,
      });
      const exitCode = await publishCiSkip({
        operatorRoot,
        prNumber,
        post: options.post === true,
        isCi,
        stepSummaryFlag: options.stepSummary,
        plan,
        noticeMessage: `pr-hero review skipped — ${skipReason}`,
        ciMode: input.ciMode,
        headSha,
        spawnFn,
        admission: {
          reason: admissionVerdict.reason,
          reviewedHead: summaryHead,
          priorBlocking: admissionVerdict.prior.blocking,
        },
      });
      return { ciPolicy, ciPolicyHash, ledgerRecords, exitCode };
    }
    if (!observeOnly && admissionVerdict.action === "manual-required") {
      const manualReason = ciReviewManualRequiredDetail(admissionVerdict);
      await recordSkip({
        operatorRoot,
        prNumber,
        headSha,
        policy: ciPolicy,
        policyHash: ciPolicyHash,
        existing: ledgerRecords,
        reason: manualReason,
        priorScore: admissionVerdict.prior.score,
        blockingCount: admissionVerdict.prior.blocking,
        advisoryCount: admissionVerdict.prior.advisory,
      });
      // S4: manual-required is a failure in gate mode: its code was never reviewed.
      const plan = planCiReviewManualRequired({
        prNumber,
        verdict: admissionVerdict,
        admission: admissionContext,
        ciMode: input.ciMode,
      });
      const exitCode = await publishCiSkip({
        operatorRoot,
        prNumber,
        post: options.post === true,
        isCi,
        stepSummaryFlag: options.stepSummary,
        plan,
        noticeMessage: `pr-hero review requires manual override — ${manualReason}`,
        ciMode: input.ciMode,
        headSha,
        spawnFn,
        admission: {
          reason: admissionVerdict.reason,
          reviewedHead: summaryHead,
          priorBlocking: admissionVerdict.prior.blocking,
        },
      });
      return { ciPolicy, ciPolicyHash, ledgerRecords, exitCode };
    }
  }
  return { ciPolicy, ciPolicyHash, ledgerRecords, exitCode: undefined };
}

// Cross-machine TOCTOU: the watcher already skipped fresh pendings at
// gather, but a CLI and a watcher can still overlap between that fetch
// and this process posting its own pending. --yes (the watcher child)
// aborts before createPrRunDir so it consumes no poison-PR attempt.
// Interactive continues: a stuck pending must not trap the operator
// behind the 90-minute TTL.
//
// Relocated out of reviewPr() (src/pr/review-pr.ts) with its log lines
// byte-identical. One addition: a CI run reaches this check AFTER reviewPr
// reserved its admission ledger row, so a stand-down must settle that row
// as `"yielded"` before returning. Left `"reserved"`, it reached teardown's
// safety net, which settles it `"failed"` (musive #1935, run 37018094654: a
// red pr-hero/ci-admission check and a spent attempt for a run that reviewed
// nothing, while the local review it yielded to posted fine). Outside CI the
// ledger is null and the settle is a no-op, so the watcher child behaves as
// before. The check stays where it is, after the reservation, on purpose:
// moving it earlier would change the CI path's ordering for every other exit.
//
// Which pendings stand the run down depends on its posture. A watcher child or a
// local run (no --ci) reads every run context, because local runs and the watcher
// post their pending on pr-hero/local and would otherwise double-spend on the
// same head. A --ci run reads only the gate: it settles pr-hero alone, and a stand-
// down on a local pending would leave pr-hero unwritten, since no local run writes
// that context. action.yml runs CI as `review --ci --yes`, so the yield is live
// there, and this is why the --ci narrowing matters.
//
// Returns the exit code when the run must stop here, `undefined` to proceed.
// `spawnFn` and `nowMs` are test-only seams (defaults: the real Bun.spawn and
// Date.now()). The one spawnFn reaches both gh calls made here: the
// commit-status read and the check-run upsert inside settleCiAdmissionLedger.
export async function yieldToInFlightReview(input: {
  operatorRoot: string;
  headSha: string;
  options: Pick<CliOptions, "yes" | "force">;
  // The run's posture (resolveCiPosture): decides which pending contexts stand it down.
  statusContext: CommitStatusContext;
  ciAdmissionLedger: CiAdmissionLedgerState | null;
  spawnFn?: typeof Bun.spawn;
  nowMs?: number;
}): Promise<number | undefined> {
  const { operatorRoot, headSha, options, ciAdmissionLedger, spawnFn } = input;
  const statuses = await fetchCommitStatuses(operatorRoot, headSha, {
    spawnFn,
  });
  if (
    !isInFlightCommitStatus(
      statuses,
      input.nowMs ?? Date.now(),
      IN_FLIGHT_TTL_MS,
      inFlightContextsFor(input.statusContext),
    )
  ) {
    return undefined;
  }
  // `--yes` without `--force` is the watcher child: a second launch
  // would double-spend. `--force` is the CI comment override, and the
  // workflow's concurrency group cancels the run already holding this
  // pending status. Treating that leftover pending as a skip would
  // cancel the review the comment just asked for and then refuse to
  // start the replacement.
  if (options.yes && !options.force) {
    log("skip: a pr-hero review is already in-flight on this head");
    await settleCiAdmissionLedger(
      ciAdmissionLedger,
      "yielded",
      "another pr-hero review is already in flight on this head",
      { spawnFn },
    );
    writeCliRecord({ v: 1, outcome: "yielded" });
    return 0;
  }
  log(
    "warning: a pr-hero review is already in-flight on this head; " +
      "continuing",
  );
  return undefined;
}

// A configuration error that stops a CI run before it reviews anything: the
// gotchas file (review/run.ts validateGotchas) or the prompt set (review/
// preflight.ts). Both throw a CliError with a classified `cls`, and only those.
// WHY the class and not the message: a wording change must not move an error
// in or out of the budget rule.
export function isCiConfigError(error: unknown): boolean {
  if (!(error instanceof CliError) || error.cls === undefined) return false;
  return error.cls.kind === "gotchas" || error.cls.kind === "prompt-set";
}

// WHY this writes a row: the attempt count reads each head's ledger rows, and a
// head with no row counts as a spent attempt (its run is in the workflow-run
// list). A run that stops on a configuration error before it reviews spent
// nothing, so it writes the same `gate-skipped` row the size and budget gates
// write (#326). The caller rethrows the ORIGINAL error after this returns, so
// the error, the exit code and the outcome code are unchanged.
// WHY every step is swallowed: the row is bookkeeping for a run that is already
// failing. A gh or check-run failure here must not replace the configuration
// error the operator needs to see. A head that cannot be recorded simply keeps
// counting, which is the behavior before this function existed.
// WHY an active reservation is left alone: settling it would finish another
// run's reservation on the same head as if it were ours.
export const CONFIG_SKIP_RECORD_TIMEOUT_MS = 15_000;

export async function recordCiConfigErrorSkip(input: {
  operatorRoot: string;
  prNumber: number;
  config: LocalConfig;
  resolveHeadSha: () => Promise<string>;
  reason: string;
  spawnFn?: typeof Bun.spawn;
  // Test-only seam: the bound on the whole write (default: the check-run bound).
  timeoutMs?: number;
}): Promise<void> {
  // WHY a bound: the caller rethrows the configuration error right after this
  // returns, and a gh call that never answers would park the run before that
  // error is raised. The whole write is bounded, not each gh call, so every
  // step (head lookup, list, reserve, settle) shares one deadline. On timeout the
  // row is skipped and the caller's error is raised as usual. The write that is
  // still pending is abandoned, not cancelled: the run is exiting anyway.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => resolve("timeout"),
      input.timeoutMs ?? CONFIG_SKIP_RECORD_TIMEOUT_MS,
    );
  });
  try {
    const outcome = await Promise.race([
      writeConfigErrorSkipRow(input).then(() => "done" as const),
      deadline,
    ]);
    if (outcome === "timeout") {
      log(
        "config-error ledger row not recorded: GitHub did not answer in time",
      );
    }
  } catch {
    // Swallowed on purpose: see the WHY above.
  } finally {
    clearTimeout(timer);
  }
}

async function writeConfigErrorSkipRow(input: {
  operatorRoot: string;
  prNumber: number;
  config: LocalConfig;
  resolveHeadSha: () => Promise<string>;
  reason: string;
  spawnFn?: typeof Bun.spawn;
}): Promise<void> {
  const headSha = await input.resolveHeadSha();
  const ciPolicy = resolveCiReviewPolicy(input.config);
  const ciPolicyHash = ciReviewPolicyHash(ciPolicy);
  const existing = await listAdmissionCheckRuns(input.operatorRoot, headSha, {
    spawnFn: input.spawnFn,
  });
  const active = selectActiveReservation(
    existing,
    headSha,
    ciPolicyHash,
    ciPolicy.reservationTtlSeconds,
    new Date(),
  );
  if (active !== null) return;
  const state = await reserveCiAdmissionLedger({
    operatorRoot: input.operatorRoot,
    prNumber: input.prNumber,
    headSha,
    policy: ciPolicy,
    policyHash: ciPolicyHash,
    existing,
    decisionReason: input.reason,
    spawnFn: input.spawnFn,
  });
  await settleCiGateSkip(state, input.reason, { spawnFn: input.spawnFn });
}
