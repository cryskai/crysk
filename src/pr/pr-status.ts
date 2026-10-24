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
  COMMIT_STATUS_CONTEXT,
  type CommitStatusFact,
  findMarkedCommentId,
  IN_FLIGHT_TTL_MS,
  isInFlightCommitStatus,
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
  CI_ADJUDICATOR_LOGIN,
  parseAdjudicationMarker,
} from "#triage/adjudication";
import {
  type ParsedTriageMarker,
  parseTriageMarker,
  type TriageActor,
  type TriageTag,
  type TriageVerdict,
} from "#triage/triage";
import { parsePrCommentMarker } from "#watch/preflight";

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
  // never posted inline). Such a finding cannot be answered with a triage reply.
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
}

export const STATUS_WAIT_POLL_INTERVAL_MS = 15_000;
export const STATUS_WAIT_STARTUP_GRACE_MS = 180_000;
export const STATUS_WAIT_MAX_MS = IN_FLIGHT_TTL_MS;

const TRIGGER_COMMENT_BODIES = new Set([
  "/pr-hero review",
  "/pr-hero review --full",
  "/pr-hero recheck",
]);

// A review comment's live projection (pr/pr.ts PrReviewComment) carries the path and line
// GitHub shows now, which follow a rename or a re-anchor. Optional, as the engine's own posted
// shape has them (rereview/prepare.ts PostedForPrior): without them the marker's anchor stands.
export interface PrStatusReviewComment extends PrStatusComment {
  in_reply_to_id: number | null;
  // The GitHub login that posted it. The CI adjudicator's ruling is trusted only from CI_ADJUDICATOR_LOGIN.
  user?: string;
  path?: string;
  line?: number | null;
}

export interface PrStatusInput {
  pr: number;
  head: string;
  nowMs: number;
  statuses: CommitStatusFact[];
  issueComments: PrStatusComment[];
  reviewComments: PrStatusReviewComment[];
}

// The window a pending status is trusted for, named from the constant that defines it, so
// the reason a stale pending reads as "review" never drifts from the watcher's own rule.
const IN_FLIGHT_WINDOW_MINUTES = Math.round(IN_FLIGHT_TTL_MS / 60_000);

// A finding as the decision needs it: the output row, plus whether a triage reply sits at
// the head the finding was posted on (a reply at another head does not answer it).
interface AnalyzedFinding {
  finding: PrStatusFinding;
  triagedAtPostedHead: boolean;
}

export function buildPrStatus(input: PrStatusInput): PrStatusJson {
  const gate = readGate(input);
  const summary = readSummary(input.issueComments);
  const analyzed = readFindings(input, summary.rows);
  const liveBlocking = analyzed.filter(
    (a) => a.finding.blocking && a.finding.live_on_head,
  );
  const decision = decideNext(gate, analyzed, input.head, summary);
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

// The gate is pr-hero's own commit status on the head, read by its context alone, so a
// local run's pr-hero/local status never answers for the gate.
function readGate(input: PrStatusInput): PrStatusGate {
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

// The summary is the newest comment carrying the report marker (findMarkedCommentId picks
// the newest). Its head and completeness come from the marker; its reviews count and its
// live rows come from the state block that the summary carries.
function readSummary(comments: PrStatusComment[]): {
  head: string | null;
  complete: boolean | null;
  reviews: number | null;
  rows: StateFinding[];
} {
  const id = findMarkedCommentId(comments);
  const body = comments.find((c) => c.id === id)?.body ?? null;
  if (id === null || body === null) {
    return { head: null, complete: null, reviews: null, rows: [] };
  }
  const marker = parsePrCommentMarker(body);
  const state = parseStateBlock(body);
  return {
    head: marker?.head ?? null,
    complete: marker?.complete ?? null,
    reviews: state?.reviews ?? null,
    rows: state?.findings ?? [],
  };
}

// The newest outcome comment's code. Only the newest is read: an older run's code says
// nothing about the run the gate now reflects. Null when the newest has no catalogued code.
function outcomeCodeOf(comments: PrStatusComment[]): string | null {
  let newest: PrStatusComment | null = null;
  for (const comment of comments) {
    if (!comment.body.startsWith(OUTCOME_MARKER_PREFIX)) continue;
    if (newest === null || comment.id > newest.id) newest = comment;
  }
  return newest === null ? null : parseOutcomeCode(newest.body);
}

// Every posted finding, from both streams, in comment order. Only a comment that parses
// as a finding marker is a finding, so the summary and a human's reply drop out here.
function readFindings(
  input: PrStatusInput,
  rows: StateFinding[],
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
      // A reply at another head does not answer the finding, so only a reply carrying the
      // posted head counts.
      triagedAtPostedHead: replies.some(
        (r) => r.marker.headSha === marker.headSha,
      ),
    });
  }
  // A live row no comment bound to (summary-only, or never posted inline) is still a finding the
  // gate counts. Without this row the status could not see a blocking finding the gate names.
  for (const row of rows) {
    if (bound.has(row.id)) continue;
    out.push({ finding: unthreadedFinding(row), triagedAtPostedHead: false });
  }
  return out;
}

// A state row with no comment: its anchor is the first of its locs (path:line or path:a-b, the
// start line), read with the same parser the binder uses. A row with no parseable loc keeps its raw
// text and line 0, so it still blocks and still reports.
function unthreadedFinding(row: StateFinding): PrStatusFinding {
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
    triage: null,
    ci_verdict: null,
  };
}

// The CI adjudicator's ruling on the newest triage reply of one inline finding. Only a reply
// github-actions[bot] posted, on the head under review, that names this newest reply counts; the
// highest comment id wins. Null when there is no such ruling.
function ciVerdictOf(
  threadId: number,
  newestTriageId: number | null,
  input: PrStatusInput,
): "upheld" | "rejected" | "inconclusive" | null {
  if (newestTriageId === null) return null;
  let best: {
    id: number;
    verdict: "upheld" | "rejected" | "inconclusive";
  } | null = null;
  for (const comment of input.reviewComments) {
    if (comment.in_reply_to_id !== threadId) continue;
    if (comment.user !== CI_ADJUDICATOR_LOGIN) continue;
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
}

// Every triage reply that answers one posted finding. An inline finding's replies sit in its
// review thread (in_reply_to_id). An outside-channel finding has no thread: its replies are
// top-level issue comments, and the link triage/reply writes binds one to its finding
// (`In reply to: <url>#issuecomment-<id>`). A comment that does not parse as a triage marker
// is not a reply, whatever it links.
function repliesTo(
  source: { id: number; channel: "inline" | "outside" },
  input: PrStatusInput,
): TriageReplyRow[] {
  const out: TriageReplyRow[] = [];
  if (source.channel === "inline") {
    for (const reply of input.reviewComments) {
      if (reply.in_reply_to_id !== source.id) continue;
      const marker = parseTriageMarker(reply.body);
      if (marker !== null) out.push({ id: reply.id, marker });
    }
    return out;
  }
  const link = new RegExp(`#issuecomment-${source.id}(?!\\d)`);
  for (const comment of input.issueComments) {
    const marker = parseTriageMarker(comment.body);
    if (marker === null || !link.test(comment.body)) continue;
    out.push({ id: comment.id, marker });
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
  /^pr-hero: review partial \(\d+ of \d+ hunters failed(?:, set [0-9a-f]{6})?\)/;

// W3-PARTIAL F004: the repeat form, the same N of M failure set as the head's previous partial verdict.
// A retry already failed that way, so the unlock is a route fix or an override, never review again.
const PARTIAL_REVIEW_AGAIN_GATE =
  /^pr-hero: review partial again \(\d+ of \d+ hunters failed(?:, set [0-9a-f]{6})?\)/;

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
  const counted = /^pr-hero: (\d+) blocking finding\(s\)/.exec(
    gate.description,
  );
  return counted?.[1] === undefined ? null : Number(counted[1]);
}

// The gate descriptions that name no review of this head: the automatic budget is used up, or the
// policy is manual (src/pr/admission.ts). Their text is the gate's own, so no count is read.
const REVIEW_TRIGGER_GATE =
  /^pr-hero: review (budget for this PR is used up|needs a manual trigger)/;

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
): { next_action: PrNextAction; reason: string } {
  const liveBlocking = analyzed.filter(
    (a) => a.finding.blocking && a.finding.live_on_head,
  );
  if (gate.state === "pending") {
    if (gate.pending_in_flight) {
      return {
        next_action: "wait",
        reason: `A pr-hero review is in flight on this head (pending since ${gate.created_at}); wait for it to finish.`,
      };
    }
    // A pending past the in-flight window is not held by any run. The watcher's own rule
    // lets the next tick start a review then, so the skill starts one too.
    return {
      next_action: "review",
      reason: `The pending pr-hero status on this head is older than the ${IN_FLIGHT_WINDOW_MINUTES}-minute in-flight window and no run holds it; start a review.`,
    };
  }
  if (gate.state === "none") {
    return {
      next_action: "review",
      reason:
        "No pr-hero gate status is on this head, so no review has run here yet; start one.",
    };
  }
  if (gate.state === "error") {
    return {
      next_action: "review",
      reason: `The last pr-hero review on this head did not finish (${gate.description ?? "no description"}); start a review.`,
    };
  }
  if (gate.state === "success") {
    // An override is a human's unlock of the head, so it stays done whatever the findings say.
    if (gate.override.active) {
      return {
        next_action: "done",
        reason: `The gate is green through an override by @${gate.override.by ?? "an unknown login"}; nothing is owed on this head.`,
      };
    }
    // A partial review of this head (some reviewers failed) is not a finished review, and the
    // engine's own admission runs the same head again (partialSameHead, ci/review-admission.ts).
    // A green gate over it is therefore review. The same marker on an older head is history.
    if (summary.head === head && summary.complete === false) {
      return {
        next_action: "review",
        reason:
          "The last review of this head was partial (some reviewers failed); run /pr-hero review.",
      };
    }
    // The triage skill answers every finding, advisory included, so a green gate is not the
    // end while a finding posted on this head has no reply at that head. A finding posted on an
    // older head is not this head's to answer.
    const owed = analyzed.filter(
      (a) => a.finding.head === head && !a.triagedAtPostedHead,
    );
    if (owed.length > 0) {
      return {
        next_action: "triage",
        reason: `The gate is green, but ${owed.length} finding(s) on this head have no reply yet; triage them.`,
      };
    }
    return {
      next_action: "done",
      reason:
        "The review on this head passed the gate, and every finding on this head has a reply.",
    };
  }
  // failure: the blocking findings on this head decide between triage, fix, and override.
  // G12, first: the gate is red because no review may run on this head (the automatic budget is
  // used up, or the policy is manual_only). No push gets an automatic review there, so a fix cannot
  // clear anything; the review the human asks for is the only unlock, whatever the summary's rows
  // (from an older head) say (review #348 R006).
  if (REVIEW_TRIGGER_GATE.test(gate.description ?? "")) {
    return {
      next_action: "review",
      reason:
        "The automatic review budget for this PR is used up, or the review policy is manual (ci_review_policy is manual_only); comment /pr-hero review to review this head.",
    };
  }
  // A row with no comment has no thread a triage reply could land in, so it is never "untriaged".
  const untriaged = liveBlocking.filter(
    (a) => a.finding.comment_id !== null && !a.triagedAtPostedHead,
  );
  if (untriaged.length > 0) {
    return {
      next_action: "triage",
      reason: `${untriaged.length} live blocking finding(s) on this head have no triage reply at the head they were posted on; triage them first.`,
    };
  }
  // WHY this precedes the upheld-dismissal review branch: a blocking row with no thread cannot be
  // answered, and only a fix clears it. Answering review here would re-run a gate that still counts
  // it, and the review never stops counting it (review #348 R001/R003).
  // Only a gate that states a blocking count is the verdict of a review the summary's rows belong
  // to. A skipped or partial gate reviewed nothing, and its rows may be an older head's, so it falls
  // through to its own branches below (review #348 R006).
  const unthreaded = liveBlocking.filter((a) => a.finding.comment_id === null);
  if (unthreaded.length > 0 && gateBlockingCount(gate) !== null) {
    const ids = unthreaded.map((a) => a.finding.id ?? "unnamed").join(", ");
    return {
      next_action: "fix",
      reason: `${unthreaded.length} live blocking finding(s) (${ids}) have no comment thread to answer (summary-only or never posted inline); fix them and push, or /pr-hero override.`,
    };
  }
  const applied = liveBlocking.filter(
    (a) => a.finding.triage?.tag === "applied",
  );
  if (applied.length > 0) {
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
  // Only an inline finding can get a CI ruling: the adjudicator answers on the finding's own review
  // thread, and an outside-diff finding has none, so recheck would never settle it.
  const pendingRulings = dismissed.filter(
    (a) =>
      a.finding.channel === "inline" &&
      (a.finding.ci_verdict === null ||
        a.finding.ci_verdict === "inconclusive"),
  );
  if (pendingRulings.length > 0) {
    return {
      next_action: "recheck",
      reason: `${pendingRulings.length} live blocking finding(s) are answered dismissed with no CI ruling on this head (or an inconclusive one); comment /pr-hero recheck so the CI adjudicator rules on them.`,
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
      reason:
        "The CI adjudicator upheld every dismissal on this head; run /pr-hero review, and that review no longer counts them.",
    };
  }
  if (gate.description?.startsWith("pr-hero skipped the review") === true) {
    return {
      next_action: "override-or-fix",
      reason: `The review on this head was skipped (${gate.description}); run /pr-hero review to review it anyway, or override the gate.`,
    };
  }
  // S6: a red gate that is a partial review (its own text, or the carried form) is not a finding to fix.
  // Nothing blocking was found, so the retry is the unlock. Its text is the gate's own, so no count is read.
  if (PARTIAL_REVIEW_AGAIN_GATE.test(gate.description ?? "")) {
    return {
      next_action: "override-or-fix",
      reason:
        "The review is partial again with the same hunters failing: a retry already failed the same way; fix the failing hunter's route (model or provider) or run /pr-hero override.",
    };
  }
  if (PARTIAL_REVIEW_GATE.test(gate.description ?? "")) {
    return {
      next_action: "review",
      reason:
        "The last review of this head was partial (some reviewers failed); run /pr-hero review, which retries it. If the same reviewers fail every time (an unavailable model, a broken route), fix that route or override the gate.",
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
  const override = freshOverrideComment(issueComments, nowMs, startupGraceMs);
  // A later PRH-* outcome denies the override even while next_action is "wait".
  if (override !== null && laterOutcomeDenies(override.id, issueComments)) {
    return false;
  }

  if (status.next_action === "wait") return true;

  // Fresh push: no status on this head yet, within the initial startup grace window.
  if (status.gate.state === "none" && elapsedMs < startupGraceMs) {
    return true;
  }

  // Fresh `/pr-hero review` or `/pr-hero recheck` comment: posted within the startup grace
  // window, and no pr-hero commit status has been posted since that comment.
  const gateMs =
    status.gate.created_at !== null
      ? Date.parse(status.gate.created_at)
      : Number.NEGATIVE_INFINITY;

  for (const comment of issueComments) {
    if (!TRIGGER_COMMENT_BODIES.has(comment.body.trim())) continue;
    if (comment.created_at === undefined) continue;
    const commentMs = Date.parse(comment.created_at);
    if (!Number.isFinite(commentMs)) continue;
    const ageMs = nowMs - commentMs;
    if (ageMs >= 0 && ageMs < startupGraceMs && commentMs > gateMs) {
      return true;
    }
  }

  // Settle's error status lands after the comment, so commentMs > gateMs must not end this.
  if (override !== null && !status.gate.override.active) return true;

  return false;
}

const OVERRIDE_COMMENT_BODY = "/pr-hero override";

function freshOverrideComment(
  issueComments: readonly PrStatusComment[],
  nowMs: number,
  startupGraceMs: number,
): PrStatusComment | null {
  let newest: PrStatusComment | null = null;
  for (const comment of issueComments) {
    if (comment.body.trim() !== OVERRIDE_COMMENT_BODY) continue;
    if (comment.created_at === undefined) continue;
    const commentMs = Date.parse(comment.created_at);
    if (!Number.isFinite(commentMs)) continue;
    const ageMs = nowMs - commentMs;
    if (ageMs < 0 || ageMs >= startupGraceMs) continue;
    if (newest === null || comment.id > newest.id) newest = comment;
  }
  return newest;
}

function laterOutcomeDenies(
  overrideId: number,
  issueComments: readonly PrStatusComment[],
): boolean {
  for (const comment of issueComments) {
    if (comment.id <= overrideId) continue;
    const code = parseOutcomeCode(comment.body);
    if (code?.startsWith("PRH-")) return true;
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
    `pr-hero status: PR #${status.pr} at ${status.head.slice(0, 7)}`,
    `gate: ${gate}`,
    `findings: ${status.findings.length} posted, ${status.unresolved_blocking} unresolved blocking`,
    `next: ${status.next_action} — ${status.reason}`,
  ];
}
