// CI admission ledger state and skip publishing helpers.
// Extracted from cli.ts (cli-decomp S5).

import {
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  reserveAdmissionAttempt,
  settleAdmissionAttempt,
} from "#ci/admission-ledger";
import { classifyCliError } from "#ci/classify-error";
import { writeCliRecord } from "#ci/cli-record";
import {
  type CiGateSkipPlan,
  shouldWriteCiOutputs,
  shouldWriteStepSummary,
} from "#ci/gates";
import type { CliRecord } from "#ci/outcome";
import {
  appendCiOutputs,
  appendStepSummary,
  formatWorkflowCommand,
} from "#ci/reporter";
import type { CiReviewPolicy } from "#ci/review-admission";
import { repostMarkedPrComment, upsertAdmissionCheckRun } from "#pr/pr";
import { type CiMode, skipCommitStatusRequest } from "#pr/preflight";
import { publishFinalCommitStatus } from "#pr/status";
import { log } from "#ui/primitives";

// ROADMAP Pillar 3 (GitHub Actions CI). The mechanical glue behind a gate
// skip in CI mode: every DECISION (what to say, which marker, what the
// outputs are) already happened in `plan` (planCiSizeSkip/planCiBudgetSkip,
// ci/gates.ts) — this function has nothing left to decide, only three
// straight-line I/O calls gated by shouldWriteStepSummary/shouldWriteCiOutputs.
// `repostMarkedPrComment` keeps one notice per marker without hiding it: a
// repeat CI run on the same still-failing PR posts the fresh notice at the
// bottom and deletes its own older ones, instead of silently editing the old
// one in place (an edit neither notifies nor moves down the timeline).
export type CiAdmissionLedgerState = {
  record: AdmissionRecord;
  checkRunId: number;
  headSha: string;
  operatorRoot: string;
};

export async function persistCiAdmissionLedger(
  state: CiAdmissionLedgerState,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<void> {
  state.checkRunId = await upsertAdmissionCheckRun(
    state.operatorRoot,
    {
      headSha: state.headSha,
      record: state.record,
      checkRunId: state.checkRunId,
    },
    options,
  );
}

export async function tryPersistCiAdmissionLedger(
  state: CiAdmissionLedgerState | null,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<void> {
  if (state === null) return;
  try {
    await persistCiAdmissionLedger(state, options);
  } catch {
    // Best-effort: settlement must not mask the underlying review failure.
  }
}

// `"yielded"` is terminal too: without it here, teardown's safety net (or
// any later exit) could overwrite a yield with `"failed"`, which is the red
// check this status exists to prevent. `"gate-skipped"` (#326) is the same:
// a later settle must not rewrite a gate skip as `"failed"`.
const TERMINAL_ADMISSION_STATUSES: ReadonlySet<AdmissionAttemptStatus> =
  new Set([
    "completed",
    "failed",
    "cancelled",
    "skipped",
    "yielded",
    "gate-skipped",
  ]);

// A record that already reached a terminal status is never re-settled: the
// review shells call this from several exits (and teardown's finally), and
// a later call must not overwrite an earlier `completed` with `failed`.
// `spawnFn` is the gh boundary for offline tests; production omits it.
// Same shape as the commit-status lock in status.ts, and for the same reason:
// the SIGTERM/SIGINT handlers live in runCli and end in process.exit(), which
// skips reviewPr's finally. A cancel-in-progress run otherwise leaves its
// ledger row at "provider-started" forever, and that status both counts as a
// spent attempt and blocks the next reservation (#164).
let heldAdmission: CiAdmissionLedgerState | null = null;

export function holdCiAdmissionLedger(
  state: CiAdmissionLedgerState | null,
): void {
  heldAdmission = state;
}

export function releaseCiAdmissionLedger(): void {
  heldAdmission = null;
}

// Take-and-clear BEFORE the await. Actions sends SIGINT and then SIGTERM
// inside the grace window, so both handlers can be in flight; the second
// must see nothing left to settle. A row that already reached a terminal
// status (completed, failed, skipped, cancelled, yielded) is left alone —
// settleCiAdmissionLedger's own guard. Every error is swallowed: failing to
// settle is the old bug, and a throw here would cost the exit code.
export async function settleHeldAdmissionLedgerOnSignal(
  settle: typeof settleCiAdmissionLedger = settleCiAdmissionLedger,
): Promise<void> {
  const state = heldAdmission;
  heldAdmission = null;
  if (state === null) return;
  if (
    state.record.status !== "reserved" &&
    state.record.status !== "provider-started"
  ) {
    return;
  }
  try {
    await settle(
      state,
      "cancelled",
      "workflow cancelled before the review produced anything",
    );
  } catch {
    // Ignore
  }
}

export async function settleCiAdmissionLedger(
  state: CiAdmissionLedgerState | null,
  status: AdmissionAttemptStatus,
  reason: string,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<void> {
  if (state === null) return;
  if (TERMINAL_ADMISSION_STATUSES.has(state.record.status)) return;
  state.record = settleAdmissionAttempt(state.record, status, reason);
  await tryPersistCiAdmissionLedger(state, options);
}

// #326: the SIZE gate and the BUDGET gate settle through here, not with
// `"skipped"`. An admission skip (recordCiAdmissionGateSkip below) keeps
// `"skipped"` and keeps counting; a gate skip spent nothing, so its row must
// not count against the PR's attempts (see TERMINAL_BUDGET_STATUSES).
export async function settleCiGateSkip(
  state: CiAdmissionLedgerState | null,
  reason: string,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<void> {
  await settleCiAdmissionLedger(state, "gate-skipped", reason, options);
}

export async function reserveCiAdmissionLedger(input: {
  operatorRoot: string;
  prNumber: number;
  headSha: string;
  policy: CiReviewPolicy;
  policyHash: string;
  existing: readonly AdmissionRecord[];
  decisionReason: string;
  priorScore?: number | null;
  blockingCount?: number | null;
  advisoryCount?: number | null;
}): Promise<CiAdmissionLedgerState> {
  const { record } = reserveAdmissionAttempt({
    existing: input.existing,
    prNumber: input.prNumber,
    headSha: input.headSha,
    policyHash: input.policyHash,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    decisionReason: input.decisionReason,
    priorScore: input.priorScore ?? null,
    blockingCount: input.blockingCount ?? null,
    advisoryCount: input.advisoryCount ?? null,
    reservationTtlSeconds: input.policy.reservationTtlSeconds,
  });
  const checkRunId = await upsertAdmissionCheckRun(input.operatorRoot, {
    headSha: input.headSha,
    record,
  });
  return {
    record,
    checkRunId,
    headSha: input.headSha,
    operatorRoot: input.operatorRoot,
  };
}

export async function recordCiAdmissionGateSkip(input: {
  operatorRoot: string;
  prNumber: number;
  headSha: string;
  policy: CiReviewPolicy;
  policyHash: string;
  existing: readonly AdmissionRecord[];
  reason: string;
  priorScore: number | null;
  blockingCount: number | null;
  advisoryCount: number | null;
}): Promise<void> {
  try {
    const state = await reserveCiAdmissionLedger({
      operatorRoot: input.operatorRoot,
      prNumber: input.prNumber,
      headSha: input.headSha,
      policy: input.policy,
      policyHash: input.policyHash,
      existing: input.existing,
      decisionReason: input.reason,
      priorScore: input.priorScore,
      blockingCount: input.blockingCount,
      advisoryCount: input.advisoryCount,
    });
    await settleCiAdmissionLedger(state, "skipped", input.reason);
  } catch {
    // The skip notice is the operator-facing outcome; a check-run write must
    // not block publishing it.
  }
}

// The skip kind a plan stands for, read from the status its outputs carry. The
// status is a plain string in CiOutputs, so an unknown one yields no kind and no
// record: a skip the publisher cannot name is not a skip it may report.
function cliSkipKindOf(plan: CiGateSkipPlan): CliRecord["skip"] {
  switch (plan.outputs.status) {
    case "skipped-size":
      return "size";
    case "skipped-budget":
      return "budget";
    case "skipped-coverage":
      return "coverage";
    case "manual-required":
      return "manual-required";
    default:
      return undefined;
  }
}

export async function publishCiSkip(input: {
  operatorRoot: string;
  prNumber: number;
  post: boolean;
  isCi: boolean;
  stepSummaryFlag: boolean | undefined;
  plan: CiGateSkipPlan;
  noticeMessage: string;
  // S4. In gate mode with a known head, a size or budget skip posts a failure
  // status. Absent means no status, which is every caller but the two gates.
  ciMode?: CiMode;
  headSha?: string;
  // Test-only seams (defaults: the real repostMarkedPrComment and
  // publishFinalCommitStatus).
  repost?: typeof repostMarkedPrComment;
  postStatus?: typeof publishFinalCommitStatus;
}): Promise<number> {
  log(formatWorkflowCommand("notice", input.noticeMessage));
  // The record names the skip kind only. The plan carries no head, so none is
  // written: the publisher takes the head from the trigger's record.
  const skip = cliSkipKindOf(input.plan);
  if (input.post) {
    // Repost, never edit in place: an edited notice is invisible on GitHub,
    // so a later push that was skipped again looked like nothing happened.
    // See repostMarkedPrComment's WHY. A repost that throws is the notice's own
    // failure, so its record names the step, and the error is rethrown unchanged.
    try {
      await (input.repost ?? repostMarkedPrComment)({
        operatorRoot: input.operatorRoot,
        pr: input.prNumber,
        body: input.plan.comment,
        markerPrefix: input.plan.markerPrefix,
      });
    } catch (error) {
      writeCliRecord({
        v: 1,
        outcome: "error",
        cls: classifyCliError(error),
        params: { step: "posting the skip notice" },
      });
      throw error;
    }
  }
  // S4: the head's status is part of "this skip reached the PR", so it is
  // written before the record. A failed write rethrows, leaving no skipped
  // record behind. Admission skips (coverage, same-head, low-risk,
  // below-threshold) and manual-required post no status in either mode: an
  // open decision, not a verdict on the diff.
  if (
    input.ciMode === "gate" &&
    input.headSha !== undefined &&
    (skip === "size" || skip === "budget")
  ) {
    await (input.postStatus ?? publishFinalCommitStatus)(
      input.operatorRoot,
      input.headSha,
      skipCommitStatusRequest({ kind: skip, targetUrl: undefined }),
    );
  }
  // Written only once the notice is on the PR, or once the log line is out when
  // posting is off: the record is what the publisher reads as "this skip was
  // reported", so it must not come before the repost it claims.
  if (skip !== undefined) {
    writeCliRecord({ v: 1, outcome: "skipped", skip });
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (shouldWriteStepSummary(input.isCi, input.stepSummaryFlag, summaryPath)) {
    await appendStepSummary(summaryPath as string, input.plan.summaryMarkdown);
  }
  const outputPath = process.env.GITHUB_OUTPUT;
  if (shouldWriteCiOutputs(input.isCi, outputPath)) {
    await appendCiOutputs(outputPath as string, input.plan.outputs);
  }
  return 0;
}
