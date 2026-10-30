import { liveBlockingFindings } from "#pr/pr-status";
import { parseFindingMarker } from "#pr/preflight";
import { TIER_UNRECOVERABLE } from "#rereview/classify";
import { CI_ADJUDICATOR_LOGIN } from "#triage/adjudication";
import { parseTriageMarker } from "#triage/triage";
import { parsePrCommentMarker } from "#watch/preflight";

// budget-exhausted-carry S3-S5: whether every blocking finding of the reviewed head is answered, read when a
// skip carries a blocking red and no review is left to verify the fixes. Pure: the impure half (who may write
// to the repository) is the gate's, which passes its lookups in as `writers`.

// The blocking findings the read could see, and how many of them are still open. A finding is answered when
// its newest triage reply sits at the head it was posted on (the rule crysk status uses) and is `applied`, or
// is a `dismissed` the CI adjudicator upheld. `deferred` and `misclassified` stay open: they name a real
// finding, and only a fix or a human override may close one.
export interface AnsweredFindings {
  blocking: number;
  open: number;
}

export interface AnswerIssueComment {
  id: number;
  user: string;
  body: string;
  created_at?: string;
}

export interface AnswerReviewComment extends AnswerIssueComment {
  in_reply_to_id: number | null;
  path?: string;
  line?: number | null;
}

function isTriageReply(body: string): boolean {
  return parseTriageMarker(body) !== null;
}

// The logins whose permission the gate must look up: every author of a triage reply.
export function triageReplyAuthors(
  comments: readonly AnswerIssueComment[],
): string[] {
  const authors = new Set<string>();
  for (const comment of comments) {
    if (isTriageReply(comment.body)) authors.add(comment.user);
  }
  return [...authors];
}

// WHY the CI bot is trusted for a finding or a summary: Crysk posts both as github-actions[bot], which only a
// workflow of this repository can write as. `trustedActors` (resolveCiTrustedActors) adds the configured
// writers; when it is undefined no author is known, and every author passes, as scanPostedFindingTiers does.
function trustedPoster(
  user: string,
  trustedActors: ReadonlySet<string> | undefined,
): boolean {
  if (trustedActors === undefined) return true;
  return user === CI_ADJUDICATOR_LOGIN || trustedActors.has(user);
}

function isGateInput(body: string): boolean {
  return (
    parseFindingMarker(body) !== null || parsePrCommentMarker(body) !== null
  );
}

// WHY a reply to a finding from an older head must be newer than the carried verdict: such a finding is live
// on the reviewed head through the summary's rows, so the review that wrote the verdict saw its reply and kept
// it. A reply from before that verdict is the claim the review already contradicted. A reply carries the
// head its finding was posted on (triage/reply.ts), so its time is the only thing that says it came after.
// A reply at the reviewed head itself always answers the review of that head.
function isStaleReply(
  comment: AnswerIssueComment,
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

// The comments the read may trust, or null when one cannot be judged (S5: fail closed).
// WHY a triage reply needs write access (S4): it is the only thing that turns a red green here, and anyone
// can comment on a pull request. A reply from a login with no write access is dropped; a login whose
// permission did not read (null, or never looked up) fails the whole read closed.
function trustedComments<T extends AnswerIssueComment>(
  comments: readonly T[],
  writers: ReadonlyMap<string, boolean | null>,
  trustedActors: ReadonlySet<string> | undefined,
  reviewedHead: string,
  verdictAt: number | null,
): T[] | null {
  const kept: T[] = [];
  for (const comment of comments) {
    if (isTriageReply(comment.body)) {
      if (isStaleReply(comment, reviewedHead, verdictAt)) continue;
      const writer = writers.get(comment.user);
      if (writer === undefined || writer === null) return null;
      if (writer) kept.push(comment);
      continue;
    }
    if (
      isGateInput(comment.body) &&
      !trustedPoster(comment.user, trustedActors)
    )
      continue;
    kept.push(comment);
  }
  return kept;
}

export function answeredBlockingFindings(input: {
  pr: number;
  reviewedHead: string;
  issueComments: readonly AnswerIssueComment[];
  reviewComments: readonly AnswerReviewComment[];
  trustedActors: ReadonlySet<string> | undefined;
  writers: ReadonlyMap<string, boolean | null>;
  // When the carried verdict was written (its commit status's created_at), or null when unknown.
  verdictAt: string | null;
}): AnsweredFindings | null {
  const parsedAt =
    input.verdictAt === null ? Number.NaN : Date.parse(input.verdictAt);
  const verdictAt = Number.isNaN(parsedAt) ? null : parsedAt;
  const issueComments = trustedComments(
    input.issueComments,
    input.writers,
    input.trustedActors,
    input.reviewedHead,
    verdictAt,
  );
  const reviewComments = trustedComments(
    input.reviewComments,
    input.writers,
    input.trustedActors,
    input.reviewedHead,
    verdictAt,
  );
  if (issueComments === null || reviewComments === null) return null;
  const findings = liveBlockingFindings({
    pr: input.pr,
    head: input.reviewedHead,
    nowMs: 0,
    statuses: [],
    issueComments,
    reviewComments,
  });
  // S5: a finding whose tier could not be read is blocking only by fail-closed default; it cannot be
  // the evidence that unlocks the gate.
  if (findings.some((finding) => finding.tier === TIER_UNRECOVERABLE))
    return null;
  let open = 0;
  for (const finding of findings) {
    const triage = finding.triage;
    const answered =
      triage !== null &&
      finding.head !== null &&
      triage.head === finding.head &&
      (triage.tag === "applied" ||
        (triage.tag === "dismissed" && finding.ci_verdict === "upheld"));
    if (!answered) open++;
  }
  return { blocking: findings.length, open };
}
