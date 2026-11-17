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

// Same-review re-post guard: the head a reply carries names the review it
// answers, and that is the budget unit (SKILL.md "One adjudication per
// finding per HEAD"). A second `triage reply` to that review must not create
// another comment.
export function existingTriageAtHead(input: {
  parentId: number;
  headSha: string;
  replies: ReviewReplyRef[];
}): boolean {
  return input.replies.some((reply) => {
    if (reply.in_reply_to_id !== input.parentId) return false;
    const marker = parseTriageMarker(reply.body);
    return marker !== null && marker.headSha === input.headSha;
  });
}
