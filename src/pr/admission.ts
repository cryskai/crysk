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
import type { AnsweredFindings } from "#pr/answered-findings";
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
  partialReviewAgainDescription,
  partialReviewDescription,
  prHtmlUrl,
  skipCommitStatusRequest,
} from "#pr/preflight";
import { publishFinalCommitStatus } from "#pr/status";
import { log } from "#ui/primitives";
import { canonicalStatusText, STATUS_CONTEXT } from "../brand";

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
  // A comment-triggered run (`/pr-hero review`, `/pr-hero recheck`): its row is
  // marked so the attempt count leaves it out (see countTerminalAttempts).
  forced?: boolean;
  // Test-only seam (default: the real Bun.spawn), threaded to the check-run write.
  spawnFn?: typeof Bun.spawn;
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
    forced: input.forced,
  });
  const checkRunId = await upsertAdmissionCheckRun(
    input.operatorRoot,
    {
      headSha: input.headSha,
      record,
    },
    { spawnFn: input.spawnFn },
  );
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
  // A skip that spent nothing and must not count against ci_max_attempts
  // (a /pr-hero stop): settled as "gate-skipped", like a size or budget skip.
  unspent?: boolean;
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
    await settleCiAdmissionLedger(
      state,
      input.unspent === true ? "gate-skipped" : "skipped",
      input.reason,
    );
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
// WHY an exhausted budget and a manual-only policy carry too (budget-exhausted-carry S2, the owner's
// decision of 2026-10-30, replacing the fixed failure S4 first wrote): every review rule is respected the
// same way. The once-per-pr, threshold and stop skips already carried a green over an unreviewed push, so a
// fixed failure here only turned the agent's last fix-up push red and made a human override routine.
// Same-head writes nothing, because that head's own status already exists.
// WHY answered findings may turn a carried blocking red green (S3): with no review left, the fixes cannot
// be verified. A write-access `applied` reply, or a dismissal the CI adjudicator upheld, on every blocking
// finding of the reviewed head is the most the gate can know, and the green it writes says so
// (unverifiedFixesDescription), so it never reads as a green a review earned.
export type AdmissionStatusReason =
  | "same-head"
  | "once-per-pr"
  | "below-threshold"
  | "low-risk-delta"
  | "stopped"
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
  // Reads the reviewed head's answered blocking findings (pr/answered-findings.ts). Called only when the
  // carried verdict is a blocking red, so every other skip makes no extra API call. Absent means never read.
  // `verdictAt` is when the carried verdict was written (its status's created_at), or null when unknown.
  readAnswered?: (verdictAt: string | null) => Promise<AnsweredFindings | null>;
}

export interface AdmissionStatusDecision {
  state: "success" | "failure";
  description: string;
}

// The verdict a carried skip inherits: the commit it was found on, and that commit's status list.
export interface CarriedVerdict {
  sha: string;
  statuses: readonly CommitStatusFact[];
  // The PR's commits older than `sha`, newest first, within the walk's cap: where a chained carry's review
  // verdict is looked up (reviewVerdictTime). Absent means none to look at.
  older?: readonly string[];
}

type CarriedReason = Exclude<AdmissionStatusReason, "same-head">;

// Every rule that skips a review carries the last verdict the same way (budget-exhausted-carry S2): the
// rule is respected, so no review runs, and the head reads what the last review decided. Same-head is the
// one exception: that head's own status already exists.
function isCarriedReason(
  reason: AdmissionStatusReason,
): reason is CarriedReason {
  return reason !== "same-head";
}

// The readers below rewrite a legacy `pr-hero` lead into `crysk` first (canonicalStatusText), so the
// patterns and the builders speak one spelling.
const BLOCKING_COUNT = /^crysk: (\d+) blocking finding\(s\)/;

function blockingCountIn(
  description: string | null | undefined,
): number | null {
  const match = BLOCKING_COUNT.exec(canonicalStatusText(description ?? ""));
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
    `${STATUS_CONTEXT}: no review needed (${label}); ${CARRIED_FROM}${sha.slice(0, 7)}`,
  );
}

// The text a skip writes when it inherits a finished review's blocking failure, with that review's count.
export function carriedBlockingDescription(count: number, sha: string): string {
  return clipStatusDescription(
    `${STATUS_CONTEXT}: ${count} blocking finding(s) ${CARRIED_FROM}${sha.slice(0, 7)} — fix and push, or /pr-hero override`,
  );
}

// The text a skip writes when a carried blocking red has every blocking finding answered and no review is
// left to verify the fixes (S3, S6). It names the rule that skipped, so a reader sees why nothing verified it.
// WHY "answered finding(s)" and not "blocking finding(s)": BLOCKING_COUNT reads that prefix as a red count.
export function unverifiedFixesDescription(
  count: number,
  label: string,
  sha: string,
): string {
  return clipStatusDescription(
    `${STATUS_CONTEXT}: ${count} answered finding(s), fixes unverified (${label}); ${CARRIED_FROM}${sha.slice(0, 7)}`,
  );
}

const ANSWERED_COUNT = /^crysk: (\d+) answered finding\(s\), fixes unverified/;

function answeredCountIn(description: string): number | null {
  const match = ANSWERED_COUNT.exec(canonicalStatusText(description));
  if (match === null) return null;
  const count = Number(match[1]);
  return count > 0 ? count : null;
}

// The text a skip writes when it inherits a finished review's partial verdict (some hunters failed).
export function carriedPartialDescription(
  failed: number,
  total: number,
  sha: string,
  set?: string,
): string {
  const suffix = set === undefined ? "" : `, set ${set}`;
  return clipStatusDescription(
    `${STATUS_CONTEXT}: review partial (${failed} of ${total} hunters failed${suffix}) ${CARRIED_FROM}${sha.slice(0, 7)} — /pr-hero review retries it`,
  );
}

const CARRY_REASONS: readonly CarriedReason[] = [
  "once-per-pr",
  "below-threshold",
  "low-risk-delta",
  "stopped",
  "max-attempts-exhausted",
  "manual-only-policy",
];

function finishedSuccessMatches(rawDescription: string): boolean {
  const description = canonicalStatusText(rawDescription);
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

function finishedBlockingMatches(rawDescription: string): boolean {
  const description = canonicalStatusText(rawDescription);
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

function carriedSuccessMatches(rawDescription: string): boolean {
  const description = canonicalStatusText(rawDescription);
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

function unverifiedFixesMatches(rawDescription: string): boolean {
  const description = canonicalStatusText(rawDescription);
  const sha = carriedSha(description);
  const count = answeredCountIn(description);
  return (
    sha !== null &&
    count !== null &&
    CARRY_REASONS.some(
      (reason) =>
        unverifiedFixesDescription(count, ciReviewSkipLabel(reason), sha) ===
        description,
    )
  );
}

function carriedBlockingMatches(rawDescription: string): boolean {
  const description = canonicalStatusText(rawDescription);
  const sha = carriedSha(description);
  const count = blockingCountIn(description);
  return (
    sha !== null &&
    count !== null &&
    carriedBlockingDescription(count, sha) === description
  );
}

// S5: a partial review is a red verdict with its own text (N of M hunters failed). Its counts are read
// first, then the builder must reproduce the whole text, the same rule as the blocking verdict.
// W3-PARTIAL S2: the repeat form ('again') reads the same counts; the flag only picks the builder that must rebuild the text.
// W4-R363 S1: the failed-set key (", set abc123") is read when present; a text from before the key has none.
const PARTIAL_COUNTS =
  /^crysk: review partial( again)? \((\d+) of (\d+) hunters failed(?:, set ([0-9a-f]{6}))?\)/;

export function partialCountsIn(
  description: string | null | undefined,
): { failed: number; total: number; again: boolean; set?: string } | null {
  const match = PARTIAL_COUNTS.exec(canonicalStatusText(description ?? ""));
  if (match === null) return null;
  return {
    failed: Number(match[2]),
    total: Number(match[3]),
    again: match[1] !== undefined,
    ...(match[4] === undefined ? {} : { set: match[4] }),
  };
}

// Exported for the teardown's repeat check (teardown.ts previousPartialIsSame): the one rule for a finished
// partial verdict, so a carried row never counts as a review's own verdict.
export function finishedPartialMatches(rawDescription: string): boolean {
  const description = canonicalStatusText(rawDescription);
  const counts = partialCountsIn(description);
  if (counts === null) return false;
  const rebuilt = counts.again
    ? partialReviewAgainDescription(counts.failed, counts.total, counts.set)
    : partialReviewDescription(counts.failed, counts.total, counts.set);
  return rebuilt === description;
}

function carriedPartialMatches(rawDescription: string): boolean {
  const description = canonicalStatusText(rawDescription);
  const sha = carriedSha(description);
  const counts = partialCountsIn(description);
  return (
    sha !== null &&
    counts !== null &&
    carriedPartialDescription(counts.failed, counts.total, sha, counts.set) ===
      description
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
      finishedSuccessMatches(description) ||
      carriedSuccessMatches(description) ||
      unverifiedFixesMatches(description)
    );
  }
  if (status.state === "failure") {
    return (
      finishedBlockingMatches(description) ||
      carriedBlockingMatches(description) ||
      finishedPartialMatches(description) ||
      carriedPartialMatches(description)
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
      `${STATUS_CONTEXT} skipped the review (${label}) and found no earlier verdict — /pr-hero review reviews it`,
    ),
  };
}

// What the gate's skip writes on the new head, or null for no write. `carried` is the verdict the skip
// inherits (findCarriedVerdict), or null when none was read or found. A reason that never carries reads none.
export function admissionSkipDecision(
  input: AdmissionStatusInput & {
    carried: CarriedVerdict | null;
    // The blocking findings of the reviewed head and how many are still open (answeredBlockingFindings),
    // read only when the carried verdict is a blocking red. Null when unread or failed closed.
    answered?: AnsweredFindings | null;
  },
): AdmissionStatusDecision | null {
  if (input.reason === "same-head") return null;
  const label = ciReviewSkipLabel(input.reason);
  if (input.carried === null) return failClosed(label);
  const verdict = newestCarriedVerdict(input.carried.statuses);
  if (verdict === undefined) return failClosed(label);
  if (verdict.state === "success") {
    // A carried unverified green stays unverified: chaining it never turns it into a green a review earned.
    const answeredCount = answeredCountIn(verdict.description ?? "");
    return {
      state: "success",
      description:
        answeredCount === null
          ? carriedSuccessDescription(label, input.carried.sha)
          : unverifiedFixesDescription(answeredCount, label, input.carried.sha),
    };
  }
  // S5: a partial verdict is red, and it is never read as a blocking count (it has none). Taking the
  // admission's own priorBlocking here would turn a partial review into a count it never had.
  const partial = partialCountsIn(verdict.description);
  if (partial !== null) {
    return {
      state: "failure",
      description: carriedPartialDescription(
        partial.failed,
        partial.total,
        input.carried.sha,
        partial.set,
      ),
    };
  }
  const blocking =
    blockingCountIn(verdict.description) ??
    (input.priorBlocking > 0 ? input.priorBlocking : null);
  if (blocking === null) return failClosed(label);
  // S3, S5: every blocking finding answered unlocks the red, and the read must see at least as many
  // blocking findings as the red counts; fewer means some live where this read cannot see them.
  const answered = input.answered ?? null;
  if (
    answered !== null &&
    answered.open === 0 &&
    answered.blocking > 0 &&
    answered.blocking >= blocking
  ) {
    return {
      state: "success",
      description: unverifiedFixesDescription(
        answered.blocking,
        label,
        input.carried.sha,
      ),
    };
  }
  return {
    state: "failure",
    description: carriedBlockingDescription(blocking, input.carried.sha),
  };
}

// The carried verdict's blocking count when it is a blocking red (not a partial), else null. The gate reads
// the answered findings only then, so a carried green or a partial red makes no extra API call.
export function carriedBlockingCount(
  carried: CarriedVerdict | null,
): number | null {
  if (carried === null) return null;
  const verdict = newestCarriedVerdict(carried.statuses);
  if (verdict === undefined || verdict.state !== "failure") return null;
  if (partialCountsIn(verdict.description) !== null) return null;
  return blockingCountIn(verdict.description);
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
    if (newestCarriedVerdict(statuses) !== undefined) {
      return { sha, statuses, older: earlier.slice(earlier.indexOf(sha) + 1) };
    }
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
        `crysk: could not read the statuses of ${input.headSha.slice(0, 7)}, so an override on it cannot be checked; the skip's status is written as planned`,
      ),
    );
    return false;
  }
  const newest = newestStatusInContext(statuses, COMMIT_STATUS_CONTEXT);
  return newest !== undefined && isOverrideStatus(newest);
}

// When the review behind the carried verdict wrote its own verdict, or null when none reads: the stale-reply
// cutoff (answered-findings.ts isStaleReply). WHY the review's own verdict, not the carried one: a chained
// skip carries a status a skip wrote later, and a reply made between the review and that skip answers the
// review; cutting at the skip's time would drop it. The walk goes on down the PR's own commits from the
// carried one, the carry's source (never the summary's head, which a comment can name), and stops at the
// first commit with a review's own verdict. A failed read, or none within the cap, is null: fail closed.
async function reviewVerdictTime(input: {
  operatorRoot: string;
  carried: CarriedVerdict | null;
  spawnFn?: typeof Bun.spawn;
  readStatuses: typeof fetchCommitStatusList;
}): Promise<string | null> {
  if (input.carried === null) return null;
  const ownIn = (statuses: readonly CommitStatusFact[]) =>
    newestStatusInContext(
      statuses.filter((status) => finishedVerdict(status)),
      COMMIT_STATUS_CONTEXT,
    );
  const first = ownIn(input.carried.statuses);
  if (first !== undefined) return first.created_at ?? null;
  for (const sha of input.carried.older ?? []) {
    const statuses = await input.readStatuses(input.operatorRoot, sha, {
      spawnFn: input.spawnFn,
    });
    if (statuses === null) return null;
    const own = ownIn(statuses);
    if (own !== undefined) return own.created_at ?? null;
  }
  return null;
}

// A verdict a review wrote itself: never a carried, skipped, or override text.
function finishedVerdict(
  status: Pick<CommitStatusFact, "state" | "description">,
): boolean {
  const description = status.description;
  if (typeof description !== "string") return false;
  if (status.state === "success") return finishedSuccessMatches(description);
  if (status.state === "failure") {
    return (
      finishedBlockingMatches(description) ||
      finishedPartialMatches(description)
    );
  }
  return false;
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
  // S3: a carried blocking red asks whether every blocking finding was answered. A read that throws fails
  // closed: the red stays.
  let answered: AnsweredFindings | null = null;
  if (
    carriedBlockingCount(carried) !== null &&
    input.admission.readAnswered !== undefined
  ) {
    try {
      answered = await input.admission.readAnswered(
        await reviewVerdictTime({
          operatorRoot: input.operatorRoot,
          carried,
          spawnFn: input.spawnFn,
          readStatuses: input.readStatuses ?? fetchCommitStatusList,
        }),
      );
    } catch {
      answered = null;
    }
  }
  return admissionSkipDecision({ ...input.admission, carried, answered });
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
      `crysk: the override on ${input.headSha.slice(0, 7)} stands; no status is written over it`,
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
