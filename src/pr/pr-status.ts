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
  parseFindingMarker,
} from "#pr/preflight";
import { SEVERITY_UNRECOVERABLE, TIER_UNRECOVERABLE } from "#rereview/classify";
import { parseStateBlock, type StateFinding } from "#rereview/state";
import { parseFindingCommentBadge } from "#review/report";
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
  head: string;
  comment_id: number;
  channel: "inline" | "outside";
  severity: string | null;
  tier: "blocking" | "advisory" | null;
  live_on_head: boolean;
  triage: PrStatusTriage | null;
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
}

export interface PrStatusReviewComment extends PrStatusComment {
  in_reply_to_id: number | null;
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
    (a) => a.finding.tier === "blocking" && a.finding.live_on_head,
  );
  const decision = decideNext(gate, analyzed, input.head);
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
    unresolved_blocking: unresolvedBlocking(gate, liveBlocking.length),
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
  }[] = [
    ...input.reviewComments.map((c) => ({ ...c, channel: "inline" as const })),
    ...input.issueComments.map((c) => ({ ...c, channel: "outside" as const })),
  ].sort((a, b) => a.id - b.id);
  const out: AnalyzedFinding[] = [];
  for (const source of sources) {
    const marker = parseFindingMarker(source.body);
    if (marker === null) continue;
    // The join is by claim fingerprint. A claim-less row fingerprints its own id, so it
    // never matches a posted finding, which carries a real claim.
    const row = rows.find((r) => r.c === marker.c);
    const badge = parseFindingCommentBadge(source.body);
    const replies = repliesTo(source, input);
    const triage = newestReply(replies)?.marker ?? null;
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
        tier:
          badge?.tier ??
          (row !== undefined && row.tier !== TIER_UNRECOVERABLE
            ? row.tier
            : null),
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
      },
      // A reply at another head does not answer the finding, so only a reply carrying the
      // posted head counts.
      triagedAtPostedHead: replies.some(
        (r) => r.marker.headSha === marker.headSha,
      ),
    });
  }
  return out;
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

// unresolved_blocking has two sources, and the description wins when it has one. A red
// gate's description names the count its own rule counted (rereview/state.ts
// unresolvedBlockingCount), which can include a carried row that no comment in this read
// shows. Every other state has no such count, so it is the live blocking findings this read
// can see. Nothing else is counted.
function unresolvedBlocking(
  gate: PrStatusGate,
  liveBlockingCount: number,
): number {
  if (gate.state === "failure" && gate.description !== null) {
    const counted = /^pr-hero: (\d+) blocking finding\(s\)/.exec(
      gate.description,
    );
    if (counted?.[1] !== undefined) return Number(counted[1]);
  }
  return liveBlockingCount;
}

// The next action, first match wins. The branches are in the order the skill must act on
// them, and each carries its own reason sentence so the human reads the same decision the
// skill made.
function decideNext(
  gate: PrStatusGate,
  analyzed: AnalyzedFinding[],
  head: string,
): { next_action: PrNextAction; reason: string } {
  const liveBlocking = analyzed.filter(
    (a) => a.finding.tier === "blocking" && a.finding.live_on_head,
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
  const untriaged = liveBlocking.filter((a) => !a.triagedAtPostedHead);
  if (untriaged.length > 0) {
    return {
      next_action: "triage",
      reason: `${untriaged.length} live blocking finding(s) on this head have no triage reply at the head they were posted on; triage them first.`,
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
  if (gate.description?.startsWith("pr-hero skipped the review") === true) {
    return {
      next_action: "override-or-fix",
      reason: `The review on this head was skipped (${gate.description}); run /pr-hero review to review it anyway, or override the gate.`,
    };
  }
  if (liveBlocking.length > 0) {
    return {
      next_action: "override-or-fix",
      reason: `The gate is red with ${liveBlocking.length} live blocking finding(s), all triaged and none applied: fix and push, or override the gate.`,
    };
  }
  return {
    next_action: "override-or-fix",
    reason: `The gate is red and names no live blocking finding on this head (${gate.description ?? "no description"}); read the gate description.`,
  };
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
