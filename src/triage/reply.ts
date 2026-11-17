// Pure decisions for `pr-hero triage reply` (W1 / issues #21 #20 #22).
// The coding agent chooses the tag and writes reasoning; this module
// chooses WHICH posted comment is the parent and whether the driver should
// resolve the GitHub review thread. NO I/O — cli.ts/pr/pr.ts execute the plan.
//
// WHY a dedicated matcher, not matchPostedFindings (pr/inline.ts): that matcher
// uses FINDING_LINE_WINDOW and livePath/liveLine so a re-review can find a
// prior comment after a small drift. Using it here would pick a parent by
// "nearest line on the live diff" — the exact 1724 failure (Greptile sat
// on the same path:line; the agent replied there). Triage identity is the
// finding marker: path + post line + head + claim fingerprint — the post
// line comes from resolvePostLine (same as --post), not raw findings.json.

import {
  type PostedFindingComment,
  parseHunkAnchors,
  resolvePostLine,
} from "#pr/inline";
import { claimFingerprint } from "#pr/preflight";
import { parseTriageMarker, type TriageVerdict } from "./triage";

export interface FindingIdentity {
  path: string;
  line: number;
  claim: string;
}

// The marker pr-hero POSTED carries the in-diff post line (resolvePostLine
// in pr/pr.ts's resolveInlinePostPlan), not necessarily findings.json's hunter
// cite. Triage reply must remap the same way or F001 at :19 never binds to a
// comment posted at :27 after proof_ref re-anchoring (Musive re-review).
export function findingIdentityForMarkerMatch(input: {
  path: string;
  line: number;
  claim: string;
  proof_refs?: readonly string[];
  diffPatch: string;
}): { identity: FindingIdentity; findingsLine: number } {
  const anchors = parseHunkAnchors(input.diffPatch);
  const postLine =
    resolvePostLine(
      {
        id: "",
        path: input.path,
        line: input.line,
        claim: input.claim,
        tier: "blocking",
        proof_refs: input.proof_refs,
      },
      anchors,
    ) ?? input.line;
  return {
    identity: { path: input.path, line: postLine, claim: input.claim },
    findingsLine: input.line,
  };
}

export type FindingCommentMatch =
  | { kind: "none" }
  | { kind: "matched"; posted: PostedFindingComment }
  | { kind: "ambiguous"; ids: number[] };

// Exact marker identity. `livePath`/`liveLine` are ignored on purpose:
// GitHub's live projection is what made 1724 look like "the comment at
// this line", and Greptile had already taken that line. Two posted
// comments that share the fingerprint is a driver bug (duplicate post),
// not a tie to break by proximity — fail closed.
export function matchPostedFindingExact(input: {
  finding: FindingIdentity;
  headSha: string;
  posted: PostedFindingComment[];
}): FindingCommentMatch {
  const fingerprint = claimFingerprint(input.finding.claim);
  const hits = input.posted.filter(
    (comment) =>
      comment.marker.path === input.finding.path &&
      comment.marker.line === input.finding.line &&
      comment.marker.headSha === input.headSha &&
      comment.marker.c === fingerprint,
  );
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) {
    const posted = hits[0];
    if (posted === undefined) return { kind: "none" };
    return { kind: "matched", posted };
  }
  return { kind: "ambiguous", ids: hits.map((comment) => comment.id) };
}

export type ThreadResolveDecision =
  | "resolve"
  | "skip-issue-channel"
  | "skip-inconclusive";

// Inline review threads close when the finding is handled. Issue-comment
// findings have no review thread (#17). `inconclusive` stays open so the
// human objector can still see an unresolved conversation.
export function decideThreadResolve(input: {
  channel: "review" | "issue";
  verdict?: TriageVerdict;
}): ThreadResolveDecision {
  if (input.channel === "issue") return "skip-issue-channel";
  if (input.verdict === "inconclusive") return "skip-inconclusive";
  return "resolve";
}

export interface ReviewReplyRef {
  in_reply_to_id: number | null;
  body: string;
  // The GitHub login that wrote the reply.
  user?: string;
}

// Whether a triage reply answers the review of `reviewedHead`. A reply names the review it
// answers, so one stamped with the reviewed head does. A reply stamped with the head its finding
// was posted on comes from an older driver or a plain `applied` comment (triage/plain-reply.ts):
// with no summary there is no later review it could have missed, and otherwise its time is the
// only evidence, so it answers only when it is newer than the verdict. Unknown times fail closed.
export function replyAnswersReview(input: {
  replyHead: string;
  replyCreatedAt: string | undefined;
  // The head the finding's comment was posted on.
  findingHead: string;
  // The head the summary was written for, or null when the pull request has no summary.
  reviewedHead: string | null;
  // When the review's verdict was written, in ms, or null when unknown.
  verdictAt: number | null;
}): boolean {
  if (input.reviewedHead !== null && input.replyHead === input.reviewedHead) {
    return true;
  }
  if (input.replyHead !== input.findingHead) return false;
  if (input.reviewedHead === null) return true;
  const createdAt =
    input.replyCreatedAt === undefined
      ? Number.NaN
      : Date.parse(input.replyCreatedAt);
  return (
    input.verdictAt !== null &&
    !Number.isNaN(createdAt) &&
    createdAt > input.verdictAt
  );
}

// WHY a reply to a finding from an older head must be newer than the verdict: such a finding is
// live on the reviewed head through the summary's rows, so the review that wrote the verdict saw
// its reply and kept it. A reply from before that verdict is the claim the review already
// contradicted. A reply stamped with the reviewed head always answers that head's review.
function isStaleReply(
  comment: { body: string; created_at?: string },
  reviewedHead: string,
  verdictAt: number | null,
): boolean {
  const marker = parseTriageMarker(comment.body);
  if (marker === null || marker.headSha === reviewedHead) return false;
  const createdAt =
    comment.created_at === undefined
      ? Number.NaN
      : Date.parse(comment.created_at);
  return (
    verdictAt === null || Number.isNaN(createdAt) || createdAt <= verdictAt
  );
}

// The comments a read may count, for the gate and for crysk status alike: every comment that is
// not a triage reply, and the triage replies that are neither stale nor from a login without write
// access. WHY write access: a reply is the only thing that turns a red gate green without a review,
// and anyone can comment on a pull request. null when an author's permission did not read (null in
// the map, or missing from it): no reader may guess it. `uncounted` names the logins whose replies
// were dropped for having no write access.
export function countedTriageReplies<
  T extends { user?: string; body: string; created_at?: string },
>(input: {
  comments: readonly T[];
  writers: ReadonlyMap<string, boolean | null>;
  // The head the summary was written for. null: no summary, so no reply can be stale.
  reviewedHead: string | null;
  verdictAt: number | null;
}): { kept: T[]; uncounted: string[] } | null {
  const kept: T[] = [];
  const uncounted = new Set<string>();
  for (const comment of input.comments) {
    if (parseTriageMarker(comment.body) === null) {
      kept.push(comment);
      continue;
    }
    if (
      input.reviewedHead !== null &&
      isStaleReply(comment, input.reviewedHead, input.verdictAt)
    ) {
      continue;
    }
    const writer =
      comment.user === undefined ? undefined : input.writers.get(comment.user);
    if (writer === undefined || writer === null) return null;
    if (writer) kept.push(comment);
    else if (comment.user !== undefined) uncounted.add(comment.user);
  }
  return { kept, uncounted: [...uncounted] };
}

// Whether a reply stamped with `replyHead` answers the review of `reviewedHead`. A reply names the
// review it answers, which is the reviewed head; a finding with a comment also takes the head it
// was posted on, which an older driver's reply and a plain `applied` one still carry. A finding
// with no comment (a summary row) has no posted head, so only the reviewed head answers it.
export function replyHeadAnswers(input: {
  findingHead: string | null;
  replyHead: string;
  reviewedHead: string | null;
}): boolean {
  if (input.replyHead === input.reviewedHead) return true;
  return input.findingHead !== null && input.replyHead === input.findingHead;
}

// Whether the gate counts a finding answered: its newest counted reply answers this review and
// is `applied`, or `dismissed` with a CI ruling of `upheld`.
export function findingAnswered(
  finding: {
    head: string | null;
    triage: { tag: string; head: string } | null;
    ci_verdict: string | null;
  },
  reviewedHead: string | null,
): boolean {
  const triage = finding.triage;
  return (
    triage !== null &&
    replyHeadAnswers({
      findingHead: finding.head,
      replyHead: triage.head,
      reviewedHead,
    }) &&
    (triage.tag === "applied" ||
      (triage.tag === "dismissed" && finding.ci_verdict === "upheld"))
  );
}

// The head of the newest reply in this thread that the gate would count (from a login with write
// access), or null. The driver skips a second reply only when that newest counted reply already
// answers this review: an older one at this head is not the reply the gate reads.
export function newestCountedThreadReplyHead(input: {
  parentId: number;
  replies: readonly (ReviewReplyRef & { id: number })[];
  writers: ReadonlyMap<string, boolean>;
}): string | null {
  let newest: { id: number; head: string } | null = null;
  for (const reply of input.replies) {
    if (reply.in_reply_to_id !== input.parentId) continue;
    const marker = parseTriageMarker(reply.body);
    if (marker === null || marker.row !== undefined) continue;
    if (reply.user === undefined || input.writers.get(reply.user) !== true) {
      continue;
    }
    if (newest === null || reply.id > newest.id) {
      newest = { id: reply.id, head: marker.headSha };
    }
  }
  return newest?.head ?? null;
}

// The same for a finding with no comment: its replies are top-level comments that name its row.
export function newestCountedRowReplyHead(input: {
  rowId: string;
  comments: readonly { id: number; body: string; user?: string }[];
  writers: ReadonlyMap<string, boolean>;
}): string | null {
  let newest: { id: number; head: string } | null = null;
  for (const comment of input.comments) {
    const marker = parseTriageMarker(comment.body);
    if (marker === null || marker.row !== input.rowId) continue;
    if (
      comment.user === undefined ||
      input.writers.get(comment.user) !== true
    ) {
      continue;
    }
    if (newest === null || comment.id > newest.id) {
      newest = { id: comment.id, head: marker.headSha };
    }
  }
  return newest?.head ?? null;
}
