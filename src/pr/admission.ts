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
import { isOverrideStatus, newestStatusInContext } from "#ci/override";
import {
  appendCiOutputs,
  appendStepSummary,
  formatWorkflowCommand,
} from "#ci/reporter";
import { type CiReviewPolicy, ciReviewSkipLabel } from "#ci/review-admission";
import {
  fetchCommitStatuses,
  fetchCommitStatusList,
  fetchPrCommitShas,
  ghRepoWebUrl,
  repostMarkedPrComment,
  upsertAdmissionCheckRun,
} from "#pr/pr";
import {
  blockingCommitStatusRequest,
  type CiMode,
  COMMIT_STATUS_CONTEXT,
  type CommitStatusFact,
  clipStatusDescription,
  commitStatusRequest,
  prHtmlUrl,
  skipCommitStatusRequest,
} from "#pr/preflight";
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

// S4 carry-forward (the owner's decision). A head an admission gate skips inherits the verdict of the
// last reviewed commit of this PR, so the required check reads what that review decided, never a green
// the review did not earn. The source is the PR's own commit statuses, never comment content: the walk
// (findCarriedVerdict) reads this PR's commits newest-first from the head, and takes the first commit
// whose status list carries a review's verdict (isReviewVerdictStatus). A skip, a fail-closed, a budget
// or a manual-only failure is not a verdict, so the walk passes over it.
//
// WHY the commit statuses and not the summary marker: a marker is a comment, and any commenter can post
// one naming a green head. Only a write-access actor can write a commit status, so a verdict read from
// the statuses is one a review wrote. The summary's head is never read for the carry.
// WHY the walk: a multi-commit push statuses only its tip, so the commits before it may carry no status.
// The walk skips those and stops at the first commit with a verdict, within CARRY_WALK_CAP commits.
// WHY a carried verdict may be carried again: a carried status on an earlier skipped head is a verdict a
// gate wrote from a real review, so chaining it keeps the verdict honest.
//
// WHY an override is not carried: an override is a human's decision for the code at that head only.
// The skipped head was never reviewed, so an override carried onto it would turn green with no review.
// WHY fail closed: no verdict within the cap, a failed read, a head missing from the PR's commits (a
// force-push, or a list cut short by GitHub's cap), or no reviewed head writes failure, so a trivial push
// cannot pass the gate without a verdict behind it.
// WHY manual-required is always failure: its code was never reviewed, so carrying a green verdict over it
// would be a bypass. Same-head writes nothing, because that head's own status already exists.
export type AdmissionStatusReason =
  | "same-head"
  | "once-per-pr"
  | "below-threshold"
  | "low-risk-delta"
  | "max-attempts-exhausted"
  | "manual-only-policy";

export interface AdmissionStatusInput {
  reason: AdmissionStatusReason;
  // The head the summary names as reviewed; null when no summary names one, and a null here fails the
  // carry closed with no read. The carry never reads this head's verdict: it comes from the PR's own
  // commit statuses (findCarriedVerdict).
  reviewedHead: string | null;
  // The admission's own blocking-tier count for the reviewed head. It stands in only when the carried
  // failure's description does not name a count. Every text isReviewVerdictStatus admits names one, so this
  // is unreachable through the walk today; it stays because ci-admission-gate.ts still supplies it.
  priorBlocking: number;
}

export interface AdmissionStatusDecision {
  state: "success" | "failure";
  description: string;
}

// The verdict a carried skip inherits: the commit it was found on, and that commit's status list.
export interface CarriedVerdict {
  sha: string;
  statuses: readonly CommitStatusFact[];
}

type CarriedReason = "once-per-pr" | "below-threshold" | "low-risk-delta";

function isCarriedReason(
  reason: AdmissionStatusReason,
): reason is CarriedReason {
  return (
    reason === "once-per-pr" ||
    reason === "below-threshold" ||
    reason === "low-risk-delta"
  );
}

const BLOCKING_COUNT = /^pr-hero: (\d+) blocking finding\(s\)/;

function blockingCountIn(
  description: string | null | undefined,
): number | null {
  const match = BLOCKING_COUNT.exec(description ?? "");
  if (match === null) return null;
  const count = Number(match[1]);
  return count > 0 ? count : null;
}

const CARRIED_FROM = "carried from ";
// Reads the carried sha out of a carried text. It only proposes the sha: the builders below must then
// reproduce the whole text, so a prefix or a suffix alone never qualifies.
const CARRIED_SHA = new RegExp(`${CARRIED_FROM}([0-9a-f]{7})`);

// The text a skip writes when it inherits a finished review's success, for the review's label and the
// carried-from sha. The carry writes it, and isReviewVerdictStatus rebuilds it, so the two cannot drift.
export function carriedSuccessDescription(label: string, sha: string): string {
  return clipStatusDescription(
    `pr-hero: no review needed (${label}); ${CARRIED_FROM}${sha.slice(0, 7)}`,
  );
}

// The text a skip writes when it inherits a finished review's blocking failure, with that review's count.
export function carriedBlockingDescription(count: number, sha: string): string {
  return clipStatusDescription(
    `pr-hero: ${count} blocking finding(s) ${CARRIED_FROM}${sha.slice(0, 7)} — fix and push, or /pr-hero override`,
  );
}

const CARRY_REASONS: readonly CarriedReason[] = [
  "once-per-pr",
  "below-threshold",
  "low-risk-delta",
];

function finishedSuccessMatches(description: string): boolean {
  return [true, false].some(
    (posted) =>
      commitStatusRequest({
        phase: "success",
        posted,
        targetUrl: undefined,
        context: COMMIT_STATUS_CONTEXT,
      }).description === description,
  );
}

function finishedBlockingMatches(description: string): boolean {
  const count = blockingCountIn(description);
  return (
    count !== null &&
    blockingCommitStatusRequest({
      blockingCount: count,
      targetUrl: undefined,
      context: COMMIT_STATUS_CONTEXT,
    }).description === description
  );
}

function carriedSha(description: string): string | null {
  return CARRIED_SHA.exec(description)?.[1] ?? null;
}

function carriedSuccessMatches(description: string): boolean {
  const sha = carriedSha(description);
  return (
    sha !== null &&
    CARRY_REASONS.some(
      (reason) =>
        carriedSuccessDescription(ciReviewSkipLabel(reason), sha) ===
        description,
    )
  );
}

function carriedBlockingMatches(description: string): boolean {
  const sha = carriedSha(description);
  const count = blockingCountIn(description);
  return (
    sha !== null &&
    count !== null &&
    carriedBlockingDescription(count, sha) === description
  );
}

// WHY the walk takes only these: a skip, a fail-closed, a budget or a manual-only failure is written with
// no review behind it. Counting it as a verdict would stop the walk on it, so a green review on an older
// commit would be lost, and one skip would turn the gate red until a human acts. Overrides need no check of
// their own: an override's text is none of the texts below.
// WHY each text is rebuilt rather than matched by a pattern: the writer of a verdict is the only authority
// on its exact text. The variable parts (a count, a carried sha) are read first, then the same builder must
// reproduce the whole description.
// WHY no context check here: the walk reads only the gate's own context (newestCarriedVerdict).
export function isReviewVerdictStatus(
  status: Pick<CommitStatusFact, "state" | "description">,
): boolean {
  const description = status.description;
  if (typeof description !== "string") return false;
  if (status.state === "success") {
    return (
      finishedSuccessMatches(description) || carriedSuccessMatches(description)
    );
  }
  if (status.state === "failure") {
    return (
      finishedBlockingMatches(description) ||
      carriedBlockingMatches(description)
    );
  }
  return false;
}

// The newest verdict on the head: a review's verdict of the gate's own context (isReviewVerdictStatus),
// newest by created_at, the rule every other reader of this context uses (newestStatusInContext).
function newestCarriedVerdict(statuses: readonly CommitStatusFact[]) {
  return newestStatusInContext(
    statuses.filter((status) => isReviewVerdictStatus(status)),
    COMMIT_STATUS_CONTEXT,
  );
}

function failClosed(label: string): AdmissionStatusDecision {
  return {
    state: "failure",
    description: clipStatusDescription(
      `pr-hero skipped the review (${label}) and found no earlier verdict — /pr-hero review reviews it`,
    ),
  };
}

// What the gate's skip writes on the new head, or null for no write. `carried` is the verdict the skip
// inherits (findCarriedVerdict), or null when none was read or found. A reason that never carries reads none.
export function admissionSkipDecision(
  input: AdmissionStatusInput & { carried: CarriedVerdict | null },
): AdmissionStatusDecision | null {
  switch (input.reason) {
    case "same-head":
      return null;
    case "max-attempts-exhausted":
      return {
        state: "failure",
        description: clipStatusDescription(
          "pr-hero: review budget for this PR is used up — /pr-hero review reviews this head",
        ),
      };
    case "manual-only-policy":
      return {
        state: "failure",
        description: clipStatusDescription(
          "pr-hero: review needs a manual trigger (ci_review_policy is manual_only) — /pr-hero review reviews this head",
        ),
      };
    case "once-per-pr":
    case "below-threshold":
    case "low-risk-delta":
      break;
  }
  const label = ciReviewSkipLabel(input.reason);
  if (input.carried === null) return failClosed(label);
  const verdict = newestCarriedVerdict(input.carried.statuses);
  if (verdict === undefined) return failClosed(label);
  if (verdict.state === "success") {
    return {
      state: "success",
      description: carriedSuccessDescription(label, input.carried.sha),
    };
  }
  const blocking =
    blockingCountIn(verdict.description) ??
    (input.priorBlocking > 0 ? input.priorBlocking : null);
  if (blocking === null) return failClosed(label);
  return {
    state: "failure",
    description: carriedBlockingDescription(blocking, input.carried.sha),
  };
}

// The most earlier commits the carry reads for a verdict. A push on top of a longer run of commits with
// no verdict fails closed rather than walking the whole PR.
const CARRY_WALK_CAP = 20;

// The carry's verdict source: the newest earlier commit of this PR whose status list carries a verdict,
// or null. GitHub lists the commits oldest first; the walk takes the commits before the head, newest first.
// WHY the head's index, not the list's last element: the walk starts from the head this gate evaluates, so
// a head that moved on, or one missing from the list, cannot send the walk to the wrong commits. A head
// missing from the list fails closed.
// WHY a failed read ends the walk: a commit whose statuses did not read is not a commit with no verdict,
// so skipping it would carry an older verdict across a read that never happened.
async function findCarriedVerdict(input: {
  operatorRoot: string;
  prNumber: number;
  headSha: string;
  spawnFn?: typeof Bun.spawn;
  listCommits: typeof fetchPrCommitShas;
  readStatuses: typeof fetchCommitStatusList;
}): Promise<CarriedVerdict | null> {
  const shas = await input.listCommits(input.operatorRoot, input.prNumber, {
    spawnFn: input.spawnFn,
  });
  if (shas === null) return null;
  const headIndex = shas.indexOf(input.headSha);
  if (headIndex < 0) return null;
  const earlier = shas.slice(0, headIndex).reverse().slice(0, CARRY_WALK_CAP);
  for (const sha of earlier) {
    const statuses = await input.readStatuses(input.operatorRoot, sha, {
      spawnFn: input.spawnFn,
    });
    if (statuses === null) return null;
    if (newestCarriedVerdict(statuses) !== undefined) return { sha, statuses };
  }
  return null;
}

// WHY the head's override holds: a human's `/pr-hero override` on this head is the decision for it. A
// re-run or reopen of the gate on that unchanged head would otherwise write the skip's verdict over it.
// So where the newest pr-hero status on the head is an override, the skip writes nothing. This holds when
// the head's statuses can be read.
// WHY the read is strict: the reader is asked with failClosed, so a failed read throws instead of looking
// like a head with no rows (fetchCommitStatuses, src/pr/pr.ts).
// WHY a failed read still writes the status: on a failed read we cannot tell whether an override stands, so
// the skip's status is written as planned. That is a tradeoff, not a guarantee: this write can replace an
// override on the head that we could not read. Leaving a fresh head with no status is the original bug, a
// head that reads as nothing decided, so we take the rarer overwrite and log a warning that says so.
async function overrideStandsOnHead(input: {
  operatorRoot: string;
  headSha: string;
  spawnFn?: typeof Bun.spawn;
  readHeadStatus: typeof fetchCommitStatuses;
}): Promise<boolean> {
  let statuses: readonly CommitStatusFact[];
  try {
    statuses = await input.readHeadStatus(input.operatorRoot, input.headSha, {
      spawnFn: input.spawnFn,
      failClosed: true,
    });
  } catch {
    log(
      formatWorkflowCommand(
        "warning",
        `pr-hero: could not read the statuses of ${input.headSha.slice(0, 7)}, so an override on it cannot be checked; the skip's status is written as planned`,
      ),
    );
    return false;
  }
  const newest = newestStatusInContext(statuses, COMMIT_STATUS_CONTEXT);
  return newest !== undefined && isOverrideStatus(newest);
}

// The status a gate-mode skip writes, or null for none. A size or budget skip is a fixed failure.
// An admission skip or manual-required is decided by admissionSkipDecision; the carry's walk runs only
// when the verdict carries forward, so same-head and manual-required make no read.
async function gateSkipDecision(
  input: {
    operatorRoot: string;
    prNumber: number;
    headSha: string;
    spawnFn?: typeof Bun.spawn;
    admission?: AdmissionStatusInput;
    readStatuses?: typeof fetchCommitStatusList;
    listCommits?: typeof fetchPrCommitShas;
  },
  skip: CliRecord["skip"],
): Promise<AdmissionStatusDecision | null> {
  if (skip === "size" || skip === "budget") {
    const request = skipCommitStatusRequest({
      kind: skip,
      targetUrl: undefined,
      context: COMMIT_STATUS_CONTEXT,
    });
    // skipCommitStatusRequest only ever builds a failure; the literal narrows its type.
    return { state: "failure", description: request.description };
  }
  if (input.admission === undefined) return null;
  const { reason, reviewedHead } = input.admission;
  // WHY the summary's presence still gates the walk: a skip whose summary names no reviewed head fails
  // closed with no read, as it always has. The carried head is never taken from the summary.
  const carried =
    isCarriedReason(reason) && reviewedHead !== null
      ? await findCarriedVerdict({
          operatorRoot: input.operatorRoot,
          prNumber: input.prNumber,
          headSha: input.headSha,
          spawnFn: input.spawnFn,
          listCommits: input.listCommits ?? fetchPrCommitShas,
          readStatuses: input.readStatuses ?? fetchCommitStatusList,
        })
      : null;
  return admissionSkipDecision({ ...input.admission, carried });
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
  // The gate's admission skip or manual-required verdict (S4 carry-forward, gate mode only).
  // Absent means no status: advisory, a non-CI run, and every caller but the gate's two admission skips.
  admission?: AdmissionStatusInput;
  // The run's spawnFn, threaded to the status read, the status write and the repo lookup.
  spawnFn?: typeof Bun.spawn;
  // Test-only seams (defaults: the real repostMarkedPrComment, publishFinalCommitStatus,
  // fetchCommitStatusList for each commit's statuses, fetchPrCommitShas for the PR's commits, and
  // fetchCommitStatuses for the head's override check).
  repost?: typeof repostMarkedPrComment;
  postStatus?: typeof publishFinalCommitStatus;
  repoWebUrl?: typeof ghRepoWebUrl;
  readStatuses?: typeof fetchCommitStatusList;
  listCommits?: typeof fetchPrCommitShas;
  readHeadStatus?: typeof fetchCommitStatuses;
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
  // record behind. Gate mode only: a size or budget skip is a fixed failure, and
  // an admission skip or manual-required writes the verdict admissionSkipDecision
  // reaches (the carry-forward above).
  const decision =
    input.ciMode === "gate" && input.headSha !== undefined
      ? await gateSkipDecision({ ...input, headSha: input.headSha }, skip)
      : null;
  // WHY the override is read before the write: a re-run or reopen of the gate on an overridden head would
  // otherwise write this skip's verdict over the human's decision. The notice, record and outputs still
  // write; only the status is held back, and one line says why.
  const headOverridden =
    decision !== null && input.headSha !== undefined
      ? await overrideStandsOnHead({
          operatorRoot: input.operatorRoot,
          headSha: input.headSha,
          spawnFn: input.spawnFn,
          readHeadStatus: input.readHeadStatus ?? fetchCommitStatuses,
        })
      : false;
  if (headOverridden && input.headSha !== undefined) {
    log(
      `pr-hero: the override on ${input.headSha.slice(0, 7)} stands; no status is written over it`,
    );
  }
  if (decision !== null && input.headSha !== undefined && !headOverridden) {
    // The run's pull URL, like every other status the CLI writes (T3 advisory
    // 3): a skip is a red check, and the link is how a reader reaches the PR.
    // Best effort: ghRepoWebUrl answers undefined when it cannot, and the status
    // still lands, without a link.
    const targetUrl = prHtmlUrl(
      await (
        input.repoWebUrl ??
        ((root: string) => ghRepoWebUrl(root, { spawnFn: input.spawnFn }))
      )(input.operatorRoot),
      input.prNumber,
    );
    // Gate-only, and gate implies `--ci` (resolveCiPosture), so this is the gate's
    // own context: the one skip write that names pr-hero.
    await (input.postStatus ?? publishFinalCommitStatus)(
      input.operatorRoot,
      input.headSha,
      {
        state: decision.state,
        description: decision.description,
        context: COMMIT_STATUS_CONTEXT,
        targetUrl,
      },
      input.spawnFn,
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
