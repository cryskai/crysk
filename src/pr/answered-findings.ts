import { liveBlockingFindings } from "#pr/pr-status";
import { parseFindingMarker } from "#pr/preflight";
import { TIER_UNRECOVERABLE } from "#rereview/classify";

import { withPlainAppliedReplies } from "#triage/plain-reply";
import {
  countedTriageReplies,
  findingAnswered,
  isStaleTriageReply,
} from "#triage/reply";
import { parseTriageMarker } from "#triage/triage";
import { parsePrCommentMarker } from "#watch/preflight";
import { isTrustedMarkerAuthor, markerTrust } from "../trust/marker-trust";

// budget-exhausted-carry S3-S5: whether every blocking finding of the reviewed head is answered, read when a
// skip carries a blocking red and no review is left to verify the fixes. Pure: the impure half (who may write
// to the repository) is the gate's, which passes its lookups in as `writers`.

// The blocking findings the read could see, and how many of them are still open. A finding is answered when
// its newest triage reply answers the reviewed head's review (triage/reply.ts replyAnswersReview, the rule
// crysk status uses) and is `applied`, or is a `dismissed` the CI adjudicator upheld. `deferred` and
// `misclassified` stay open: they name a real finding, and only a fix or a human override may close one.
// A finding with no comment of its own, a row of the summary, is answered by a top-level reply that names the row.
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

// The logins whose permission the gate must look up: every author of a triage reply, a plain `applied`
// reply to a finding included (triage/plain-reply.ts).
export function triageReplyAuthors(
  comments: readonly {
    id?: number;
    user: string;
    body: string;
    in_reply_to_id?: number | null;
    created_at?: string;
  }[],
  // When given, a reply the read will drop as stale is left out: nobody has to ask for the
  // permission of an author whose reply cannot count.
  cutoff?: { reviewedHead: string | null; verdictAt: number | null },
): string[] {
  const authors = new Set<string>();
  for (const comment of withPlainAppliedReplies(comments)) {
    if (!isTriageReply(comment.body)) continue;
    if (
      cutoff !== undefined &&
      cutoff.reviewedHead !== null &&
      isStaleTriageReply(comment, cutoff.reviewedHead, cutoff.verdictAt)
    ) {
      continue;
    }
    authors.add(comment.user);
  }
  return [...authors];
}

// WHY a bot is trusted for a finding or a summary: Crysk posts both as github-actions[bot] or as the
// platform App's bot, and a person cannot post as either (src/trust/marker-trust.ts). `trustedActors`
// (the gate's resolveMarkerTrust logins) adds the platform login and the default branch's ci_trusted_actors; when it
// is undefined the caller judges no author, as scanPostedFindingTiers does. The gate always passes a set.
function trustedPoster(
  user: string,
  trustedActors: ReadonlySet<string> | undefined,
): boolean {
  if (trustedActors === undefined) return true;
  return isTrustedMarkerAuthor(user, markerTrust(trustedActors));
}

function isGateInput(body: string): boolean {
  return (
    parseFindingMarker(body) !== null || parsePrCommentMarker(body) !== null
  );
}

// The comments the read may trust, or null when one cannot be judged (S5: fail closed).
// The reply rule itself is triage/reply.ts countedTriageReplies, shared with crysk status.
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
  const counted = countedTriageReplies({
    comments,
    writers,
    reviewedHead,
    verdictAt,
  });
  if (counted === null) return null;
  return counted.kept.filter(
    (comment) =>
      isTriageReply(comment.body) ||
      !isGateInput(comment.body) ||
      trustedPoster(comment.user, trustedActors),
  );
}

export function answeredBlockingFindings(input: {
  pr: number;
  reviewedHead: string;
  issueComments: readonly AnswerIssueComment[];
  reviewComments: readonly AnswerReviewComment[];
  trustedActors: ReadonlySet<string> | undefined;
  writers: ReadonlyMap<string, boolean | null>;
  // In platform mode, the login the platform's token exchange returned (CRYSK_PLATFORM_ACTOR).
  platformActor?: string;
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
    withPlainAppliedReplies(input.reviewComments),
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
    adjudicatorTrust: { kind: "ci", platformActor: input.platformActor },
  });
  // S5: a finding whose tier could not be read is blocking only by fail-closed default; it cannot be
  // the evidence that unlocks the gate.
  if (findings.some((finding) => finding.tier === TIER_UNRECOVERABLE))
    return null;
  let open = 0;
  for (const finding of findings) {
    // One rule with crysk status (triage/reply.ts findingAnswered).
    const answered = findingAnswered(finding, input.reviewedHead);
    if (!answered) open++;
  }
  return { blocking: findings.length, open };
}
