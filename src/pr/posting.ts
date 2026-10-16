// PR mode's inline-posting stage: publish the review as PR comments, only
// when asked. Relocated out of reviewPr() (src/pr/review-pr.ts): the
// `postEnabled` branch became an early return and identifiers moved onto
// explicit parameters, control flow otherwise unchanged. The WHY comments
// below move with the code they explain.
//
// Runs AFTER the Greptile comparison on purpose: a posting failure must
// never cost the comparison artifact. And unlike the comparison, posting
// does NOT degrade to a warning — it was explicitly requested. Goes through
// the inline surface — anchorability, cross-run matching, the one review
// submission (with its 422 recovery into the summary Outside Diff bucket).
// `postInlineIfEligible` carries the `sessionFailed` guard (design D6,
// spec "sessionFailed suppresses all posting"): a clean-bill comment set
// from a review that never ran would be a public lie, same reasoning as the
// comparison guard in comparison.ts.

import type { InlinePostOutcome } from "#pr/inline";
import { ghRepoWebUrl, postInlineIfEligible, writePostReceipt } from "#pr/pr";
import type { RereviewProvenance } from "#rereview/prepare";
import type { FindingsDocument } from "#review/findings";
import { log } from "#ui/primitives";

export interface PostingStageResult {
  posted: InlinePostOutcome | null;
  postedWebUrl: string | undefined;
}

export async function postFindingsIfEnabled(input: {
  postEnabled: boolean;
  sessionFailed: boolean;
  operatorRoot: string;
  pr: number;
  headSha: string;
  doc: FindingsDocument;
  diffPatch: string;
  runDir: string;
  rereview?: RereviewProvenance;
  rereviewPriors?: readonly {
    id: string;
    claim: string;
    locs: readonly string[];
  }[];
  // Test-only seam (default: the real Bun.spawn). ghRepoWebUrl and
  // postInlineIfEligible already accept an invisible-to-production spawnFn
  // of their own (pr.ts's established seam); this stage just never exposed
  // the option, so offline tests could not reach either without hitting gh.
  spawnFn?: typeof Bun.spawn;
  // The delivery point (F002 on #330): fired once the findings POST resolves with
  // an outcome, before the local receipt is written. The caller records the review
  // as delivered here, so a receipt write that fails afterwards is a failure after
  // delivery, never a failed delivery. Never fired when posting is off, or when the
  // session failed and nothing was posted.
  onDelivered?: () => void;
}): Promise<PostingStageResult> {
  if (!input.postEnabled) {
    return { posted: null, postedWebUrl: undefined };
  }

  const postedWebUrl = await ghRepoWebUrl(input.operatorRoot, {
    spawnFn: input.spawnFn,
  });
  if (postedWebUrl === undefined) {
    log("repo web url unavailable: posting plain locations");
  }
  const posted = await postInlineIfEligible({
    sessionFailed: input.sessionFailed,
    skippedReason:
      "post skipped: every hunter failed, so there is no review to publish",
    operatorRoot: input.operatorRoot,
    pr: input.pr,
    headSha: input.headSha,
    doc: input.doc,
    diffPatch: input.diffPatch,
    webUrl: postedWebUrl,
    spawnFn: input.spawnFn,
    rereview: input.rereview,
    rereviewPriors: input.rereviewPriors,
  });
  if (posted) {
    input.onDelivered?.();
    await writePostReceipt(input.runDir, input.pr, input.headSha, posted);
    log(
      `posted: review ${posted.reviewOutcome} (${posted.reviewFindingCount} ` +
        `finding(s)), ${posted.outsideDiffCount} outside diff, ` +
        `summary ${posted.summary.action} comment ${posted.summary.commentId}`,
    );
    // GitHub #39: said at the MOMENT it happened, not only in the result
    // block minutes of scrollback later — the same reason the 422 demotion
    // below gets its own line here. The two can co-occur: a force-push both
    // moves the head and 422s the pinned submission.
    if (posted.movedHeadSha) {
      log(
        `warning: the PR head moved while the review ran — reviewed ` +
          `${input.headSha}, head is now ${posted.movedHeadSha}; the ` +
          "comments are pinned to the reviewed commit",
      );
    }
    if (posted.reviewOutcome === "demoted") {
      log(
        "warning: the review submission was rejected (422) and recovered " +
          "into the summary Outside Diff bucket — see the run's post.json " +
          "for detail",
      );
    }
  }
  return { posted, postedWebUrl };
}
