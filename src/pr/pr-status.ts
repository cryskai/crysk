// The pure builder behind `pr-hero status` (ROADMAP S9): what a skill needs to drive
// review -> reply -> fix -> wait, read from the PR's own GitHub facts. Raw inputs in, the
// status object out, no I/O: src/commands/status.ts reads GitHub and hands the results here.
//
// Every reader is one the engine already uses: the gate (preflight.ts latestStatusInContext,
// isInFlightCommitStatus), the summary and its state block (findMarkedCommentId,
// parsePrCommentMarker, parseStateBlock), each finding (parseFindingMarker, and the header
// badge of report.ts), the triage a finding was answered with (parseTriageMarker, bound by
// the review thread, or by the link an outside-channel reply carries), and the newest outcome
// (parseOutcomeCode). Nothing here re-parses a
// format another module owns, so a drift in one of them moves this command with it.

import { OUTCOME_MARKER_PREFIX, parseOutcomeCode } from "#ci/outcome";
import { isOverrideStatus, overrideActorOf } from "#ci/override";
import {
  OVERRIDE_COMMAND,
  RECHECK_COMMAND,
  REVIEW_COMMAND,
  REVIEW_FULL_COMMAND,
} from "#ci/trigger";
import {
  COMMIT_STATUS_CONTEXT,
  type CommitStatusFact,
  findMarkedCommentId,
  IN_FLIGHT_TTL_MS,
  isInFlightCommitStatus,
  isManualReviewHold,
  latestStatusInContext,
  type ParsedFindingMarker,
  parseFindingMarker,
} from "#pr/preflight";
import {
  type RecoveredTier,
  SEVERITY_UNRECOVERABLE,
  TIER_UNRECOVERABLE,
} from "#rereview/classify";
import { parseProofRefLocs } from "#rereview/identity";
import { bindPriorsToPosted } from "#rereview/prepare";
import { parseStateBlock, type StateFinding } from "#rereview/state";
import { parseFindingCommentBadge } from "#review/report";
import {
  type AdjudicatorTrust,
  CI_ADJUDICATOR_TRUST,
  parseAdjudicationMarker,
  trustedAdjudicator,
} from "#triage/adjudication";
import { withPlainAppliedReplies } from "#triage/plain-reply";
import {
  countedTriageReplies,
  findingAnswered,
  replyAnswersReview,
  replyHeadAnswers,
} from "#triage/reply";
import {
  type ParsedTriageMarker,
  parseTriageMarker,
  type TriageActor,
  type TriageTag,
  type TriageVerdict,
} from "#triage/triage";
import { parsePrCommentMarker } from "#watch/preflight";
import {
  canonicalStatusText,
  commandHint,
  isCommand,
  matchMarkerPrefix,
} from "../brand";

export const PR_STATUS_SCHEMA = "pr-hero.status/v1" as const;

export type PrGateState = "success" | "failure" | "error" | "pending" | "none";
export type PrNextAction =
  | "wait"
  | "review"
  | "triage"
  | "fix"
  | "override-or-fix"
  | "recheck"
  | "done";

export interface PrStatusGate {
  state: PrGateState;
  description: string | null;
  target_url: string | null;
  created_at: string | null;
  pending_in_flight: boolean;
  override: { active: boolean; by: string | null };
}

export interface PrStatusReport {
  head: string | null;
  complete: boolean | null;
  reviews: number | null;
  outcome_code: string | null;
}

export interface PrStatusTriage {
  tag: TriageTag;
  verdict: TriageVerdict | null;
  actor: TriageActor;
  head: string;
}

export interface PrStatusFinding {
  id: string | null;
  path: string;
  line: number;
  // The head the finding was posted on. Null for a state row no comment carries: the row has no
  // head of its own, and nothing was posted here.
  head: string | null;
  // Null for a finding with no comment thread (a state row no comment bound: summary-only, or
  // never posted inline). It is answered with a top-level reply whose marker names the row (triage/triage.ts `row`).
  comment_id: number | null;
  channel: "inline" | "outside";
  severity: string | null;
  // The tier the badge or the state row reports: "blocking" or "advisory". "unrecoverable" (the
  // engine's sentinel, rereview/classify.ts) when neither can give one. Never null.
  // `blocking` is the field every blocking decision reads.
  tier: RecoveredTier;
  // True for every tier but advisory. An unrecoverable tier counts as blocking because the gate
  // counts it that way (rereview/state.ts unresolvedBlockingCount): fail closed, so a finding
  // that cannot be read as advisory is never waved through.
  blocking: boolean;
  live_on_head: boolean;
  // The newest triage reply the gate counts: from a login with write access, and not older than the review's verdict.
  triage: PrStatusTriage | null;
  // The CI adjudicator's ruling on the newest triage reply, counted only when github-actions[bot] posted it on the head being read (src/triage/adjudication.ts). Null when there is none.
  ci_verdict: "upheld" | "rejected" | "inconclusive" | null;
}

export interface PrStatusJson {
  schema: typeof PR_STATUS_SCHEMA;
  pr: number;
  head: string;
  gate: PrStatusGate;
  report: PrStatusReport;
  findings: PrStatusFinding[];
  unresolved_blocking: number;
  next_action: PrNextAction;
  reason: string;
}

// A GitHub comment as the shell reads it. Review comments also carry the thread link a
// triage reply is bound by (in_reply_to_id); issue comments have none.
export interface PrStatusComment {
  id: number;
  body: string;
  created_at?: string;
  // The GitHub login that posted it. A CI ruling on a reply to a finding with no comment is trusted by its author.
  user?: string;
}

export const STATUS_WAIT_POLL_INTERVAL_MS = 15_000;
export const STATUS_WAIT_STARTUP_GRACE_MS = 180_000;
export const STATUS_WAIT_MAX_MS = IN_FLIGHT_TTL_MS;

const TRIGGER_COMMANDS = [REVIEW_COMMAND, REVIEW_FULL_COMMAND, RECHECK_COMMAND];

// A review comment's live projection (pr/pr.ts PrReviewComment) carries the path and line
// GitHub shows now, which follow a rename or a re-anchor. Optional, as the engine's own posted
// shape has them (rereview/prepare.ts PostedForPrior): without them the marker's anchor stands.
export interface PrStatusReviewComment extends PrStatusComment {
  in_reply_to_id: number | null;
  path?: string;
  line?: number | null;
}

export interface PrStatusRead {
  pr: number;
  head: string;
  nowMs: number;
  statuses: CommitStatusFact[];
  // When the review whose verdict stands on this head wrote it (admission.ts ownReviewVerdictTime,
  // carriedReviewVerdictTime): the cutoff for a reply stamped with the head its finding was posted
  // on. Absent or null: unknown, and such a reply on a carried finding does not count, as at the gate.
  verdictAt?: string | null;
  issueComments: PrStatusComment[];
  reviewComments: PrStatusReviewComment[];
  // Whose CI ruling counts. Absent is a run's standalone read: only github-actions[bot].
  adjudicatorTrust?: AdjudicatorTrust;
}

export interface PrStatusInput extends PrStatusRead {
  // Whether each author of a triage reply has write access (triage/reply.ts countedTriageReplies):
  // status counts a reply exactly as the gate does. Every such author must be in the map.
  writers: ReadonlyMap<string, boolean>;
}

// The window a pending status is trusted for, named from the constant that defines it, so
// the reason a stale pending reads as "review" never drifts from the watcher's own rule.
const IN_FLIGHT_WINDOW_MINUTES = Math.round(IN_FLIGHT_TTL_MS / 60_000);

// A finding as the decision needs it: the output row, plus whether a triage reply answers the
// review the summary was written for (triage/reply.ts replyAnswersReview).
interface AnalyzedFinding {
  finding: PrStatusFinding;
  answersReview: boolean;
  // Under a green gate every finding posted on the head is owed a reply, and any author's satisfies it: the gate reads no reply there, so this is not the gate's rule.
  replied: boolean;
}

export function buildPrStatus(raw: PrStatusInput): PrStatusJson {
  const input = withPlainReplies(raw);
  const gate = readGate(input);
  const summary = readSummary(input.issueComments);
  const counted = countedReplies(input, summary.head);
  const analyzed = readFindings(
    counted.input,
    summary.rows,
    summary.head,
    verdictMs(input),
    summary.author,
    input,
  );
  const liveBlocking = analyzed.filter(
    (a) => a.finding.blocking && a.finding.live_on_head,
  );
  const decision = decideNext(
    gate,
    analyzed,
    input.head,
    summary,
    counted.uncounted,
  );
  return {
    schema: PR_STATUS_SCHEMA,
    pr: input.pr,
    head: input.head,
    gate,
    report: {
      head: summary.head,
      complete: summary.complete,
      reviews: summary.reviews,
      outcome_code: outcomeCodeOf(input.issueComments),
    },
    findings: analyzed.map((a) => a.finding),
    // A dismissal the CI adjudicator upheld on this head leaves the gate's count (review #348
    // F001), so the fallback count leaves it out too.
    unresolved_blocking: unresolvedBlocking(
      gate,
      liveBlocking.filter((a) => !upheldDismissal(a)).length,
    ),
    next_action: decision.next_action,
    reason: decision.reason,
  };
}

// The comments as the gate reads them (triage/reply.ts countedTriageReplies). The command that
// builds the input looks every reply author's permission up first, so an unread one is a defect.
function countedReplies(
  input: PrStatusInput,
  reviewedHead: string | null,
): { input: PrStatusInput; uncounted: string[] } {
  const verdictAt = verdictMs(input);
  const issue = countedTriageReplies({
    comments: input.issueComments,
    writers: input.writers,
    reviewedHead,
    verdictAt,
  });
  const review = countedTriageReplies({
    comments: input.reviewComments,
    writers: input.writers,
    reviewedHead,
    verdictAt,
  });
  if (issue === null || review === null) {
    throw new Error(
      "crysk status: a triage reply author's permission was not looked up",
    );
  }
  return {
    input: {
      ...input,
      issueComments: issue.kept,
      reviewComments: review.kept,
    },
    uncounted: [...new Set([...issue.uncounted, ...review.uncounted])],
  };
}

// The gate is crysk's own commit status on the head, read by its context alone (the legacy
// pr-hero name counts as the same context), so a local run's crysk/local status never
// answers for the gate.
// A verdict time in ms, or null when it is unknown or does not parse.
export function verdictAtMs(
  verdictAt: string | null | undefined,
): number | null {
  if (verdictAt === undefined || verdictAt === null) return null;
  const at = Date.parse(verdictAt);
  return Number.isNaN(at) ? null : at;
}

// The head the review summary was written for: what a reply must name to answer the review.
export function reviewedHeadOf(
  issueComments: PrStatusComment[],
): string | null {
  return readSummary(issueComments).head;
}

// The caller's verdict time in ms, or null when it is unknown or does not parse.
function verdictMs(input: PrStatusRead): number | null {
  return verdictAtMs(input.verdictAt);
}

function readGate(input: PrStatusRead): PrStatusGate {
  const latest = latestStatusInContext(input.statuses, COMMIT_STATUS_CONTEXT);
  if (latest === null) {
    return {
      state: "none",
      description: null,
      target_url: null,
      created_at: null,
      pending_in_flight: false,
      override: { active: false, by: null },
    };
  }
  const active = isOverrideStatus(latest);
  const description = latest.description ?? null;
  return {
    state: gateStateOf(latest.state),
    description,
    target_url: latest.target_url ?? null,
    created_at: latest.created_at,
    pending_in_flight: isInFlightCommitStatus(input.statuses, input.nowMs),
    override: {
      active,
      by: active && description !== null ? overrideActorOf(description) : null,
    },
  };
}

// A state the reader does not know is read as error, which sends a review out. It never
// reads as success, so an unrecognised gate cannot pass a PR.
function gateStateOf(state: string): PrGateState {
  if (
    state === "success" ||
    state === "failure" ||
    state === "error" ||
    state === "pending"
  ) {
    return state;
  }
  return "error";
}

// triage-without-skill S1: a plain `applied` reply to a finding reads as the marker it implies, so the status
// a person or an agent reads agrees with the gate (triage/plain-reply.ts).
function withPlainReplies<T extends PrStatusRead>(input: T): T {
  return {
    ...input,
    reviewComments: withPlainAppliedReplies(input.reviewComments),
  };
}

// The live blocking findings at input.head, each with its newest triage reply and CI ruling, read exactly as
// buildPrStatus reads them. The admission gate reads them for the reviewed head (pr/answered-findings.ts).
export function liveBlockingFindings(raw: PrStatusRead): PrStatusFinding[] {
  const input = withPlainReplies(raw);
  const summary = readSummary(input.issueComments);
  return readFindings(
    input,
    summary.rows,
    summary.head,
    null,
    summary.author,
    input,
  )
    .filter((a) => a.finding.blocking && a.finding.live_on_head)
    .map((a) => a.finding);
}

// The summary is the newest comment carrying the report marker (findMarkedCommentId picks
// the newest). Its head and completeness come from the marker; its reviews count and its
// live rows come from the state block that the summary carries.
function readSummary(comments: PrStatusComment[]): {
  head: string | null;
  complete: boolean | null;
  reviews: number | null;
  rows: StateFinding[];
  author: string | undefined;
} {
  const id = findMarkedCommentId(comments);
  const summaryComment = comments.find((c) => c.id === id);
  const body = summaryComment?.body ?? null;
  if (id === null || body === null) {
    return {
      head: null,
      complete: null,
      reviews: null,
      rows: [],
      author: undefined,
    };
  }
  const marker = parsePrCommentMarker(body);
  const state = parseStateBlock(body);
  return {
    head: marker?.head ?? null,
    complete: marker?.complete ?? null,
    reviews: state?.reviews ?? null,
    rows: state?.findings ?? [],
    author: summaryComment?.user,
  };
}

// The newest outcome comment's code. Only the newest is read: an older run's code says
// nothing about the run the gate now reflects. Null when the newest has no catalogued code.
function outcomeCodeOf(comments: PrStatusComment[]): string | null {
  let newest: PrStatusComment | null = null;
  for (const comment of comments) {
    if (matchMarkerPrefix(comment.body, OUTCOME_MARKER_PREFIX) === undefined) {
      continue;
    }
    if (newest === null || comment.id > newest.id) newest = comment;
  }
  return newest === null ? null : parseOutcomeCode(newest.body);
}

// Every posted finding, from both streams, in comment order. Only a comment that parses
// as a finding marker is a finding, so the summary and a human's reply drop out here.
function readFindings(
  input: PrStatusRead,
  rows: StateFinding[],
  reviewedHead: string | null,
  verdictAt: number | null,
  summaryAuthor: string | undefined,
  raw: PrStatusRead,
): AnalyzedFinding[] {
  const sources: {
    id: number;
    body: string;
    channel: "inline" | "outside";
    // A review comment's live path and line, as pr/discovery.ts reads them. An outside comment
    // has no live projection, so its marker's anchor is the only one.
    livePath?: string;
    liveLine?: number;
  }[] = [
    ...input.reviewComments.map((c) => ({
      id: c.id,
      body: c.body,
      channel: "inline" as const,
      livePath: c.path,
      liveLine: c.line ?? undefined,
    })),
    ...input.issueComments.map((c) => ({
      id: c.id,
      body: c.body,
      channel: "outside" as const,
    })),
  ].sort((a, b) => a.id - b.id);
  const posted: {
    source: (typeof sources)[number];
    marker: ParsedFindingMarker;
  }[] = [];
  for (const source of sources) {
    const marker = parseFindingMarker(source.body);
    if (marker !== null) posted.push({ source, marker });
  }
  // The join is the engine's own prior-to-comment binding (bindPriorsToPosted, rereview/
  // prepare.ts): a row binds a posted finding only when the comment's anchor lands within one
  // of the row's locs on the same path, and the claim fingerprint `c` breaks a tie and nothing
  // else. Keying on `c` alone let two findings with the same claim on different paths share one
  // row. The binding is one-to-one, so it runs once over every posted finding.
  const bound = bindPriorsToPosted(
    rows,
    posted.map(({ source, marker }) => ({
      id: source.id,
      marker,
      livePath: source.livePath,
      liveLine: source.liveLine,
    })),
  );
  const rowByComment = new Map<number, StateFinding>();
  for (const row of rows) {
    const comment = bound.get(row.id);
    if (comment !== undefined) rowByComment.set(comment.id, row);
  }
  const out: AnalyzedFinding[] = [];
  for (const { source, marker } of posted) {
    const row = rowByComment.get(source.id);
    const badge = parseFindingCommentBadge(source.body);
    const replies = repliesTo(source, input);
    const newest = newestReply(replies);
    const triage = newest?.marker ?? null;
    // The badge's tier, else the row's, else the engine's unrecoverable sentinel: the same fallback
    // priorsFromPostedMarkers (rereview/prepare.ts) applies to a comment it cannot read.
    const tier: RecoveredTier = badge?.tier ?? row?.tier ?? TIER_UNRECOVERABLE;
    out.push({
      finding: {
        id: row?.id ?? null,
        path: marker.path,
        line: marker.line,
        head: marker.headSha,
        comment_id: source.id,
        channel: source.channel,
        severity:
          badge?.sev ??
          (row !== undefined && row.sev !== SEVERITY_UNRECOVERABLE
            ? row.sev
            : null),
        tier,
        // Fail closed: only an advisory tier clears a finding, so an unrecoverable one blocks.
        blocking: tier !== "advisory",
        // A finding is live when the summary's state block still carries its row, or when
        // it was posted on the head being read. A row is the gate's own memory of a live
        // finding, so a carried finding from an older head stays live.
        live_on_head: row !== undefined || marker.headSha === input.head,
        triage:
          triage === null
            ? null
            : {
                tag: triage.tag,
                verdict: triage.verdict ?? null,
                actor: triage.actor,
                head: triage.headSha,
              },
        ci_verdict:
          source.channel === "inline"
            ? ciVerdictOf(source.id, newest?.id ?? null, input)
            : null,
      },
      // The newest reply the gate counts decides, as at the gate (triage/reply.ts).
      answersReview:
        triage !== null &&
        replyHeadAnswers({
          findingHead: marker.headSha,
          replyHead: triage.headSha,
          reviewedHead,
        }),
      replied: repliesTo(source, raw).some((r) =>
        replyAnswersReview({
          replyHead: r.marker.headSha,
          replyCreatedAt: r.createdAt,
          findingHead: marker.headSha,
          reviewedHead,
          verdictAt,
        }),
      ),
    });
  }
  // A live row no comment bound to (summary-only, or never posted inline) is still a finding the
  // gate counts. Without this row the status could not see a blocking finding the gate names.
  for (const row of rows) {
    if (bound.has(row.id)) continue;
    const replies = rowReplies(row.id, input);
    const newest = newestReply(replies);
    out.push({
      finding: unthreadedFinding(
        row,
        newest?.marker ?? null,
        rowCiVerdictOf(newest?.id ?? null, summaryAuthor, input),
      ),
      // A row has no posted head, so only the newest counted reply, stamped with the reviewed head, answers it.
      answersReview:
        newest !== null &&
        reviewedHead !== null &&
        newest.marker.headSha === reviewedHead,
      replied:
        reviewedHead !== null &&
        rowReplies(row.id, raw).some((r) => r.marker.headSha === reviewedHead),
    });
  }
  return out;
}

// A state row with no comment: its anchor is the first of its locs (path:line or path:a-b, the
// start line), read with the same parser the binder uses. A row with no parseable loc keeps its raw
// text and line 0, so it still blocks and still reports. Its newest reply is the newest top-level
// comment that names the row.
function unthreadedFinding(
  row: StateFinding,
  triage: ParsedTriageMarker | null,
  ciVerdict: "upheld" | "rejected" | "inconclusive" | null,
): PrStatusFinding {
  const first = row.locs[0];
  const span = first === undefined ? undefined : parseProofRefLocs(first)[0];
  // Fail closed: only an advisory tier clears a row, as for a comment.
  const tier: RecoveredTier = row.tier;
  return {
    id: row.id,
    path: span?.path ?? first ?? "",
    line: span?.span.start ?? 0,
    head: null,
    comment_id: null,
    channel: row.channel,
    severity: row.sev !== SEVERITY_UNRECOVERABLE ? row.sev : null,
    tier,
    blocking: tier !== "advisory",
    live_on_head: true,
    triage:
      triage === null
        ? null
        : {
            tag: triage.tag,
            verdict: triage.verdict ?? null,
            actor: triage.actor,
            head: triage.headSha,
          },
    // Its CI ruling is the top-level comment that names that reply.
    ci_verdict: ciVerdict,
  };
}

// The CI adjudicator's ruling on the newest reply to a finding with no comment. The ruling is a
// top-level comment whose marker names that reply. Same rule as ciVerdictOf: a trusted author, the
// head under review, the highest comment id wins. The summary's author stands where the finding's
// own author stands for a thread: only the bot that posted the review rules on it.
function rowCiVerdictOf(
  newestReplyId: number | null,
  summaryAuthor: string | undefined,
  input: PrStatusRead,
): "upheld" | "rejected" | "inconclusive" | null {
  if (newestReplyId === null) return null;
  let best: {
    id: number;
    verdict: "upheld" | "rejected" | "inconclusive";
  } | null = null;
  for (const comment of input.issueComments) {
    if (
      !trustedAdjudicator(
        comment.user,
        summaryAuthor,
        input.adjudicatorTrust ?? CI_ADJUDICATOR_TRUST,
      )
    ) {
      continue;
    }
    const marker = parseAdjudicationMarker(comment.body);
    if (marker === null) continue;
    if (marker.reply !== newestReplyId || marker.head !== input.head) continue;
    if (best === null || comment.id > best.id) {
      best = { id: comment.id, verdict: marker.verdict };
    }
  }
  return best?.verdict ?? null;
}

// The CI adjudicator's ruling on the newest triage reply of one inline finding. Only a reply
// github-actions[bot] posted, on the head under review, that names this newest reply counts; the
// highest comment id wins. Null when there is no such ruling.
function ciVerdictOf(
  threadId: number,
  newestTriageId: number | null,
  input: PrStatusRead,
): "upheld" | "rejected" | "inconclusive" | null {
  if (newestTriageId === null) return null;
  let best: {
    id: number;
    verdict: "upheld" | "rejected" | "inconclusive";
  } | null = null;
  const findingAuthor = input.reviewComments.find(
    (c) => c.id === threadId,
  )?.user;
  for (const comment of input.reviewComments) {
    if (comment.in_reply_to_id !== threadId) continue;
    if (
      !trustedAdjudicator(
        comment.user,
        findingAuthor,
        input.adjudicatorTrust ?? CI_ADJUDICATOR_TRUST,
      )
    ) {
      continue;
    }
    const marker = parseAdjudicationMarker(comment.body);
    if (marker === null) continue;
    if (marker.reply !== newestTriageId || marker.head !== input.head) continue;
    if (best === null || comment.id > best.id) {
      best = { id: comment.id, verdict: marker.verdict };
    }
  }
  return best?.verdict ?? null;
}

interface TriageReplyRow {
  id: number;
  marker: ParsedTriageMarker;
  createdAt?: string;
}

// Every triage reply that answers one posted finding. An inline finding's replies sit in its
// review thread (in_reply_to_id). An outside-channel finding has no thread: its replies are
// top-level issue comments, and the link triage/reply writes binds one to its finding
// (`In reply to: <url>#issuecomment-<id>`). A comment that does not parse as a triage marker
// is not a reply, whatever it links.
function repliesTo(
  source: { id: number; channel: "inline" | "outside" },
  input: PrStatusRead,
): TriageReplyRow[] {
  const out: TriageReplyRow[] = [];
  if (source.channel === "inline") {
    for (const reply of input.reviewComments) {
      if (reply.in_reply_to_id !== source.id) continue;
      const marker = parseTriageMarker(reply.body);
      // A reply that names a row answers a finding with no comment, never the thread it was typed in
      // (as rereview/prepare.ts reads it).
      if (marker !== null && marker.row === undefined)
        out.push({ id: reply.id, marker, createdAt: reply.created_at });
    }
    return out;
  }
  const link = new RegExp(`#issuecomment-${source.id}(?!\\d)`);
  for (const comment of input.issueComments) {
    const marker = parseTriageMarker(comment.body);
    // A reply that names a row never answers a legacy top-level finding comment, even when its body links one.
    if (marker === null || marker.row !== undefined || !link.test(comment.body))
      continue;
    out.push({ id: comment.id, marker, createdAt: comment.created_at });
  }
  return out;
}

// Every triage reply that answers one summary row: a top-level comment whose marker names the row
// (triage/triage.ts `row`). A row has no comment of its own, so the token is the only binding.
function rowReplies(rowId: string, input: PrStatusRead): TriageReplyRow[] {
  const out: TriageReplyRow[] = [];
  for (const comment of input.issueComments) {
    const marker = parseTriageMarker(comment.body);
    if (marker === null || marker.row !== rowId) continue;
    out.push({ id: comment.id, marker, createdAt: comment.created_at });
  }
  return out;
}

// The newest reply by comment id (the API's own order is not relied on).
function newestReply(
  replies: readonly TriageReplyRow[],
): TriageReplyRow | null {
  let newest: TriageReplyRow | null = null;
  for (const reply of replies) {
    if (newest === null || reply.id > newest.id) newest = reply;
  }
  return newest;
}

// The red partial-review verdict (preflight.ts partialReviewDescription) and its carried form
// (admission.ts carriedPartialDescription). The prefix is what this reader needs: the full text is
// written by those builders, and the gate's own state already says the review is red.
const PARTIAL_REVIEW_GATE =
  /^crysk: review partial \(\d+ of \d+ hunters failed(?:, set [0-9a-f]{6})?\)/;

// W3-PARTIAL F004: the repeat form, the same N of M failure set as the head's previous partial verdict.
// A retry already failed that way, so the unlock is a route fix or an override, never review again.
const PARTIAL_REVIEW_AGAIN_GATE =
  /^crysk: review partial again \(\d+ of \d+ hunters failed(?:, set [0-9a-f]{6})?\)/;

// unresolved_blocking has two sources, and the description wins when it has one. A red
// gate's description names the count its own rule counted (rereview/state.ts
// unresolvedBlockingCount), which can include a carried row that no comment in this read
// shows. Every other state has no such count, so it is the live blocking findings this read
// can see. Nothing else is counted.
function unresolvedBlocking(
  gate: PrStatusGate,
  liveBlockingCount: number,
): number {
  return gateBlockingCount(gate) ?? liveBlockingCount;
}

// The count a red gate's own description names, or null when it names none.
function gateBlockingCount(gate: PrStatusGate): number | null {
  if (gate.state !== "failure" || gate.description === null) return null;
  const counted = /^crysk: (\d+) blocking finding\(s\)/.exec(
    canonicalStatusText(gate.description),
  );
  return counted?.[1] === undefined ? null : Number(counted[1]);
}

// The gate descriptions that name no review of this head: the automatic budget is used up, or the
// policy is manual. A gate stopped writing them on 2026-10-30 (budget-exhausted-carry S2: both carry the
// last verdict now), so only a head statused before that still carries one. Their text is the gate's own,
// so no count is read.
const REVIEW_TRIGGER_GATE =
  /^crysk: review (budget for this PR is used up|needs a manual trigger)/;

// A blocking red a skip carried from an earlier commit (admission.ts carriedBlockingDescription).
const CARRIED_BLOCKING_GATE = /^crysk: \d+ blocking finding\(s\) carried from /;

// The green a skip writes over answered findings no review verified (admission.ts unverifiedFixesDescription).
const UNVERIFIED_FIXES_GATE =
  /^crysk: \d+ answered finding\(s\), fixes unverified \(/;

// The green a skip writes when every changed file is excluded (admission.ts NOTHING_TO_REVIEW_DESCRIPTION, #317).
const NOTHING_TO_REVIEW_GATE =
  /^crysk: nothing to review — every changed file is excluded$/;

// A blocking finding whose newest reply is a dismissal the CI adjudicator upheld on this head.
function upheldDismissal(a: AnalyzedFinding): boolean {
  return (
    a.finding.triage?.tag === "dismissed" && a.finding.ci_verdict === "upheld"
  );
}

// The next action, first match wins. The branches are in the order the skill must act on
// them, and each carries its own reason sentence so the human reads the same decision the
// skill made.
function decideNext(
  gate: PrStatusGate,
  analyzed: AnalyzedFinding[],
  head: string,
  summary: { head: string | null; complete: boolean | null },
  uncounted: readonly string[],
): { next_action: PrNextAction; reason: string } {
  const liveBlocking = analyzed.filter(
    (a) => a.finding.blocking && a.finding.live_on_head,
  );
  if (gate.state === "pending") {
    // Stage 2 #12: a capped rule (the budget used up, or manual_only) held the head instead of carrying a
    // green no review saw. No run will review it on its own, so waiting is wrong, and so is a routine
    // forced review: a human decides between verifying the head and merging it unverified.
    if (
      isManualReviewHold({ state: gate.state, description: gate.description })
    ) {
      return {
        next_action: "override-or-fix",
        reason: `The gate holds this head for a manual review: the automatic review budget is used up, or the review policy is manual (ci_review_policy is manual_only), so no review read it and none will on its own. Comment ${commandHint(REVIEW_COMMAND, "")} to verify it, or ${commandHint(OVERRIDE_COMMAND, "")} to merge it unverified.`,
      };
    }
    if (gate.pending_in_flight) {
      return {
        next_action: "wait",
        reason: `A crysk review is in flight on this head (pending since ${gate.created_at}); wait for it to finish.`,
      };
    }
    // A pending past the in-flight window is not held by any run. The watcher's own rule
    // lets the next tick start a review then, so the skill starts one too.
    return {
      next_action: "review",
      reason: `The pending crysk status on this head is older than the ${IN_FLIGHT_WINDOW_MINUTES}-minute in-flight window and no run holds it; start a review.`,
    };
  }
  if (gate.state === "none") {
    return {
      next_action: "review",
      reason:
        "No crysk gate status is on this head, so no review has run here yet; start one.",
    };
  }
  if (gate.state === "error") {
    return {
      next_action: "review",
      reason: `The last crysk review on this head did not finish (${gate.description ?? "no description"}); start a review.`,
    };
  }
  if (gate.state === "success") {
    // PR #472/#475: a finding that lives only in the summary (outside the diff) has no thread and is never
    // owed a reply (it can still be answered by its row id), but a done that does not name it let the loop merge without reading it. Every
    // done below carries this note.
    const summaryOnly = analyzed.filter(
      (a) => a.finding.comment_id === null,
    ).length;
    const summaryNote =
      summaryOnly === 0
        ? ""
        : ` ${summaryOnly} finding(s) live only in the summary comment (outside the diff, no thread to reply in); read them there before merging.`;
    // An override is a human's unlock of the head, so it stays done whatever the findings say.
    if (gate.override.active) {
      return {
        next_action: "done",
        reason: `The gate is green through an override by @${gate.override.by ?? "an unknown login"}; nothing is owed on this head.${summaryNote}`,
      };
    }
    // A partial review of this head (some reviewers failed) is not a finished review, and the
    // engine's own admission runs the same head again (partialSameHead, ci/review-admission.ts).
    // A green gate over it is therefore review. The same marker on an older head is history.
    if (summary.head === head && summary.complete === false) {
      return {
        next_action: "review",
        reason: `The last review of this head was partial (some reviewers failed); run ${commandHint(REVIEW_COMMAND, "")}.`,
      };
    }
    // The triage skill answers every finding, advisory included, so a green gate is not the
    // end while a finding posted on this head has no reply at that head. A finding posted on an
    // older head is not this head's to answer.
    const owed = analyzed.filter((a) => a.finding.head === head && !a.replied);
    if (owed.length > 0) {
      return {
        next_action: "triage",
        reason: `The gate is green, but ${owed.length} finding(s) on this head have no reply yet; triage them.`,
      };
    }
    // budget-exhausted-carry S6: a green no review verified. Nothing is owed, and the reason says why
    // it is green, so the skill reports the fixes as unverified rather than reviewed.
    if (
      UNVERIFIED_FIXES_GATE.test(canonicalStatusText(gate.description ?? ""))
    ) {
      return {
        next_action: "done",
        reason: `The gate is green on answered findings no review verified (${gate.description}); the PR is ready to merge, or comment ${commandHint(REVIEW_COMMAND, "")} for another review.${summaryNote}`,
      };
    }
    // #317: no review ran, so the reason must not read as a review that passed.
    if (
      NOTHING_TO_REVIEW_GATE.test(canonicalStatusText(gate.description ?? ""))
    ) {
      return {
        next_action: "done",
        reason: `Every changed file on this head is excluded from review, so there was nothing to review; nothing is owed.${summaryNote}`,
      };
    }
    return {
      next_action: "done",
      reason: `The review on this head passed the gate, and every finding on this head has a reply.${summaryNote}`,
    };
  }
  // failure: the blocking findings on this head decide between triage, fix, and override.
  // G12, first: the gate is red because no review may run on this head (the automatic budget is
  // used up, or the policy is manual_only). No push gets an automatic review there, so a fix cannot
  // clear anything; the review the human asks for is the only unlock, whatever the summary's rows
  // (from an older head) say (review #348 R006).
  if (REVIEW_TRIGGER_GATE.test(canonicalStatusText(gate.description ?? ""))) {
    return {
      next_action: "review",
      reason: `The automatic review budget for this PR is used up, or the review policy is manual (ci_review_policy is manual_only); comment ${commandHint(REVIEW_COMMAND, "")} to review this head.`,
    };
  }
  // WHY a row with no comment counts only under a gate that states a blocking count: only that
  // gate is the verdict of a review the summary's rows belong to. A skipped or partial gate
  // reviewed nothing, and its rows may be an older head's, so such a row falls through to the
  // branches below.
  const rowsAreThisReviews = gateBlockingCount(gate) !== null;
  const untriaged = liveBlocking.filter(
    (a) =>
      !a.answersReview && (a.finding.comment_id !== null || rowsAreThisReviews),
  );
  if (untriaged.length > 0) {
    const uncountedNote =
      uncounted.length === 0
        ? ""
        : ` Replies from ${uncounted.join(", ")} do not count: the gate counts a triage reply only from a login with write access.`;
    return {
      next_action: "triage",
      reason: `${untriaged.length} live blocking finding(s) on this head have no triage reply that answers this review; triage them first.${uncountedNote}`,
    };
  }
  const applied = liveBlocking.filter(
    (a) => a.finding.triage?.tag === "applied",
  );
  if (applied.length > 0) {
    // budget-exhausted-carry S3: a carried blocking red means a review rule skipped this head. The next push
    // may be skipped too, and then the gate reads the replies instead of a review, but only every blocking
    // finding answered unlocks it (answered-findings.ts), so the reason promises that only when it holds.
    // A carried partial red is never unlocked by replies, so it keeps the plain reason.
    if (
      CARRIED_BLOCKING_GATE.test(canonicalStatusText(gate.description ?? ""))
    ) {
      // The gate's own rules (admission.ts admissionSkipDecision, answered-findings.ts): a finding is
      // answered only by its newest reply at the head it was posted on or at the reviewed head, and the gate must see at least as
      // many blocking findings as the red counts. This is the gate's own rule (triage/reply.ts findingAnswered), over the replies the gate counts.
      const open = liveBlocking.filter(
        (a) => !findingAnswered(a.finding, summary.head),
      ).length;
      const counted = gateBlockingCount(gate);
      const unseen =
        counted === null ? 0 : Math.max(0, counted - liveBlocking.length);
      return {
        next_action: "fix",
        reason:
          open === 0 && unseen === 0
            ? "Every live blocking finding is answered and a review rule skipped this head; push the fix. If a rule skips that push too, the gate reads the replies on it and can turn green, marked unverified, or, under a used-up budget or manual_only, hold the head for a manual review; otherwise the review verifies it."
            : `A live blocking finding is tagged applied, but ${open + unseen} blocking finding(s) are still open (deferred, misclassified, a dismissal not upheld, a reply at another head, or one this read cannot see), so replies alone will not unlock the carried red; push the fix, and answer or fix the rest.`,
      };
    }
    return {
      next_action: "fix",
      reason:
        "A live blocking finding is tagged applied; push the fix, and the next review verifies it.",
    };
  }
  // A dismissal leaves the count only on a CI ruling of "upheld" (src/triage/adjudication.ts). A
  // dismissal with no ruling on this head, or an inconclusive one, is pending: recheck rules on it.
  const dismissed = liveBlocking.filter(
    (a) => a.finding.triage?.tag === "dismissed",
  );
  // A finding with a review thread gets its ruling there, and a finding with no comment gets it as a
  // top-level comment that names its reply. Only a legacy top-level finding comment has neither, so
  // recheck would never settle it. A row is pending only under a gate that states a blocking count, as for `untriaged` above.
  const pendingRulings = dismissed.filter(
    (a) =>
      (a.finding.comment_id === null
        ? rowsAreThisReviews
        : a.finding.channel === "inline") &&
      (a.finding.ci_verdict === null ||
        a.finding.ci_verdict === "inconclusive"),
  );
  if (pendingRulings.length > 0) {
    return {
      next_action: "recheck",
      reason: `${pendingRulings.length} live blocking finding(s) are answered dismissed with no CI ruling on this head (or an inconclusive one); comment ${commandHint(RECHECK_COMMAND, "")} so the CI adjudicator rules on them.`,
    };
  }
  // WHY the gate's own count is checked too (review #348 F002): the gate can count a blocking
  // finding this read cannot see (one rendered only in the summary). A review that already
  // consumed the rulings leaves that one counted, and answering review again would loop.
  const gateCount = gateBlockingCount(gate);
  if (
    dismissed.length > 0 &&
    dismissed.length === liveBlocking.length &&
    dismissed.every(upheldDismissal) &&
    (gateCount === null || gateCount <= dismissed.length)
  ) {
    return {
      next_action: "review",
      reason: `The CI adjudicator upheld every dismissal on this head; run ${commandHint(REVIEW_COMMAND, "")}, and that review no longer counts them.`,
    };
  }
  if (
    canonicalStatusText(gate.description ?? "").startsWith(
      "crysk skipped the review",
    )
  ) {
    return {
      next_action: "override-or-fix",
      reason: `The review on this head was skipped (${gate.description}); run ${commandHint(REVIEW_COMMAND, "")} to review it anyway, or override the gate.`,
    };
  }
  // S6: a red gate that is a partial review (its own text, or the carried form) is not a finding to fix.
  // Nothing blocking was found, so the retry is the unlock. Its text is the gate's own, so no count is read.
  if (
    PARTIAL_REVIEW_AGAIN_GATE.test(canonicalStatusText(gate.description ?? ""))
  ) {
    return {
      next_action: "override-or-fix",
      reason: `The review is partial again with the same hunters failing: a retry already failed the same way; fix the failing hunter's route (model or provider) or run ${commandHint(OVERRIDE_COMMAND, "")}.`,
    };
  }
  if (PARTIAL_REVIEW_GATE.test(canonicalStatusText(gate.description ?? ""))) {
    return {
      next_action: "review",
      reason: `The last review of this head was partial (some reviewers failed); run ${commandHint(REVIEW_COMMAND, "")}, which retries it. If the same reviewers fail every time (an unavailable model, a broken route), fix that route or override the gate.`,
    };
  }
  if (liveBlocking.length > 0) {
    return {
      next_action: "override-or-fix",
      reason: `The gate is red with ${liveBlocking.length} live blocking finding(s), all triaged and none applied or pending a CI ruling (a rejected dismissal, or a deferred or misclassified tag, never leaves the count): fix and push, or override the gate.`,
    };
  }
  return {
    next_action: "override-or-fix",
    reason: `The gate is red and names no live blocking finding on this head (${gate.description ?? "no description"}); read the gate description.`,
  };
}

// Pure predicate for `pr-hero status --pr <n> --wait`: whether the caller should keep polling
// for a review to start or finish before emitting the settled status.
export function shouldWaitPrStatus(input: {
  status: PrStatusJson;
  issueComments: PrStatusComment[];
  nowMs: number;
  elapsedMs: number;
  startupGraceMs?: number;
}): boolean {
  const { status, issueComments, nowMs, elapsedMs } = input;
  const startupGraceMs = input.startupGraceMs ?? STATUS_WAIT_STARTUP_GRACE_MS;

  if (status.next_action === "wait") return true;

  // Fresh push: no status on this head yet, within the initial startup grace window.
  if (status.gate.state === "none" && elapsedMs < startupGraceMs) {
    return true;
  }

  // Fresh `/crysk review` or `/crysk recheck` comment: posted within the startup grace
  // window, and no pr-hero commit status has been posted since that comment.
  const gateMs =
    status.gate.created_at !== null
      ? Date.parse(status.gate.created_at)
      : Number.NEGATIVE_INFINITY;

  for (const comment of issueComments) {
    if (!TRIGGER_COMMANDS.some((command) => isCommand(comment.body, command))) {
      continue;
    }
    if (comment.created_at === undefined) continue;
    const commentMs = Date.parse(comment.created_at);
    if (!Number.isFinite(commentMs)) continue;
    const ageMs = nowMs - commentMs;
    if (ageMs >= 0 && ageMs < startupGraceMs && commentMs > gateMs) {
      return true;
    }
  }

  return false;
}

// The human lines `pr-hero status` prints on stderr without --json. A renderer: it returns
// lines, never writes them, and carries no escape bytes (the caller styles nothing here).
export function renderPrStatusLines(status: PrStatusJson): string[] {
  const gate =
    status.gate.description === null
      ? status.gate.state
      : `${status.gate.state} (${status.gate.description})`;
  return [
    `crysk status: PR #${status.pr} at ${status.head.slice(0, 7)}`,
    `gate: ${gate}`,
    `findings: ${status.findings.length} posted, ${status.unresolved_blocking} unresolved blocking`,
    `next: ${status.next_action} — ${status.reason}`,
  ];
}
