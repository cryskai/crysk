// The exit code of a review, in every mode: local, `--pr`, and headless CI.
//
// The exit code says whether the TOOL did its job, never what it found.
// Spec 2.1, the assistant posture: "The CLI MUST NOT exit with a non-zero code
// merely because findings (even `blocking` ones) were discovered". The
// verdict belongs to the `crysk` commit status and the posted comments.
//
//   0  the review is complete, with or without findings
//   1  no usable review: every hunter failed, no reviewer ran, or findings that
//      should have been posted were dropped
//   2  usage error (src/cli.ts, before any review starts)
//   3  the review is incomplete: it ran, but a step failed (a hunter, the
//      refuter, verify, adjudicate, or the pipeline ceiling). Run it again.
//
// WHY 3 exists, instead of folding an incomplete review into 0 or 1: until
// this module, an incomplete review exited 0. In GitHub the job check then
// stayed green while the gate's own `crysk` status read "review partial", and
// a pipeline outside GitHub (a script running `crysk review && merge`) had no
// machine-readable way to learn that a reviewer never looked. Exit 1 would
// have fixed the signal but merged two different next steps: 1 means
// something is broken, 3 means retry, the same unlock the partial status
// names ("/pr-hero review retries it").

import type { RunStatus } from "#review/findings";

export const EXIT_REVIEW_COMPLETE = 0;
export const EXIT_REVIEW_FAILED = 1;
export const EXIT_REVIEW_INCOMPLETE = 3;

export type ReviewExitCode =
  | typeof EXIT_REVIEW_COMPLETE
  | typeof EXIT_REVIEW_FAILED
  | typeof EXIT_REVIEW_INCOMPLETE;

export function reviewExitCode(input: {
  // Every hunter failed (PipelineResult.sessionFailed).
  readonly sessionFailed: boolean;
  // The pipeline's own statement that no hunter ran on a run meant to review
  // (PipelineResult.noReviewerRan). A re-review that skipped discovery on
  // purpose leaves it false. Absent reads as false.
  readonly noReviewerRan?: boolean;
  // findings.json's `run_status`: "partial" whenever any step failed.
  readonly runStatus: RunStatus;
  // Findings the posting stage could not deliver. 0 when nothing was posted.
  readonly droppedFindingIds: number;
  // Accepted and deliberately NEVER read (spec 2.1): it exists so a test can
  // pass a high blocking count and assert the code does not change, which
  // fails loudly if a future change wires findings into the exit code.
  readonly blockingCount?: number;
}): ReviewExitCode {
  if (input.sessionFailed || input.noReviewerRan === true) {
    return EXIT_REVIEW_FAILED;
  }
  // WHY a dropped posting outranks an incomplete review: a retry repairs the
  // missing step, but findings that never reached the PR are a delivery
  // failure the author cannot see at all.
  if (input.droppedFindingIds > 0) return EXIT_REVIEW_FAILED;
  if (input.runStatus === "partial") return EXIT_REVIEW_INCOMPLETE;
  return EXIT_REVIEW_COMPLETE;
}
