// How a person or a local agent asks GitHub to run a skipped review anyway.
// The answer is a pull request comment, `/crysk review`: the scaffolded
// workflow listens for it, the action checks the commenter's write access,
// and the review runs on the Actions runner with --force. Running
// `pr-hero review --force` locally is a different path and is not this one.
//
// Workflows scaffolded before the comment trigger existed have no
// issue_comment listener, so a comment there does nothing. They have the
// dispatch-only `.github/workflows/pr-hero-force.yml` instead, and the action
// still declares the inputs it sets, so the hint keeps naming it as the
// fallback rather than leaving those repos with an instruction that silently
// fails.

import { commandHint } from "../brand";
import { REVIEW_COMMAND, REVIEW_FULL_COMMAND } from "./trigger";

// The trigger's own commands, so a hint can never name a spelling the action
// would not accept.
export const CI_REVIEW_COMMENT = REVIEW_COMMAND;
export const CI_REVIEW_FULL_COMMENT = REVIEW_FULL_COMMAND;

export const CI_FORCE_WORKFLOW_FILE = "pr-hero-force.yml";

export function ciForceReviewDispatch(prNumber: number): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`pr number must be a positive integer, got ${prNumber}`);
  }
  return `gh workflow run ${CI_FORCE_WORKFLOW_FILE} -f pr=${prNumber}`;
}

export function ciForceReviewHintLine(prNumber: number): string {
  return (
    `Comment ${commandHint(CI_REVIEW_COMMENT)} on this pull request to run it ` +
    `on GitHub Actions anyway (\`${CI_REVIEW_FULL_COMMENT}\` re-discovers the ` +
    "whole range). On a workflow scaffolded before comment triggers, run " +
    `\`${ciForceReviewDispatch(prNumber)}\` instead, or re-scaffold with ` +
    "`pr-hero ci init --force`."
  );
}
