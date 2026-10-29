// PR mode's CI headless publishing (ROADMAP Pillar 3): the step summary +
// $GITHUB_OUTPUT, built from the SAME findings doc renderResult already
// printed, so nothing here can disagree with what the terminal (and the PR
// comments, via the posting stage's outcome) already reported. Relocated out
// of reviewPr() (src/pr/review-pr.ts): the `shouldPublishCiReview` branch
// became an early return and identifiers moved onto explicit parameters,
// control flow otherwise unchanged. The WHY comments below move with the
// code they explain.
//
// The gate is shouldPublishCiReview, never a bare `isCi`: design D6's "a
// failed session publishes nothing" binds this channel exactly as it binds
// postInlineIfEligible in posting.ts.

import {
  planCiReview,
  shouldPublishCiReview,
  shouldWriteCiOutputs,
  shouldWriteStepSummary,
} from "#ci/gates";
import {
  appendCiOutputs,
  appendStepSummary,
  formatWorkflowCommand,
} from "#ci/reporter";
import type { CiMode } from "#pr/preflight";
import type { Finding } from "#review/findings";
import type { PrCommentDelta } from "#review/report";
import { log } from "#ui/primitives";

export async function publishCiReviewIfEligible(input: {
  isCi: boolean;
  sessionFailed: boolean;
  prNumber: number;
  headSha: string;
  findings: readonly Finding[];
  costUsdEst: number;
  wallMs: number;
  model: string;
  webUrl: string | undefined;
  delta: PrCommentDelta | undefined;
  runDir: string;
  stepSummaryFlag: boolean | undefined;
  // S4: the mode this run resolved (resolveCiMode, reviewPr). It names the
  // step summary's footer, and nothing else in this function reads it.
  ciMode: CiMode;
}): Promise<void> {
  if (!shouldPublishCiReview(input.isCi, input.sessionFailed)) return;

  const ciPlan = planCiReview({
    prNumber: input.prNumber,
    headSha: input.headSha,
    findings: input.findings,
    costUsdEst: input.costUsdEst,
    wallMs: input.wallMs,
    model: input.model,
    ...(input.webUrl === undefined ? {} : { repoWebUrl: input.webUrl }),
    ...(input.delta === undefined ? {} : { delta: input.delta }),
    runDir: input.runDir,
    ciMode: input.ciMode,
  });
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (shouldWriteStepSummary(input.isCi, input.stepSummaryFlag, summaryPath)) {
    await appendStepSummary(summaryPath as string, ciPlan.summaryMarkdown);
  }
  const outputPath = process.env.GITHUB_OUTPUT;
  if (shouldWriteCiOutputs(input.isCi, outputPath)) {
    await appendCiOutputs(outputPath as string, ciPlan.outputs);
  }
  log(
    formatWorkflowCommand(
      "notice",
      `crysk review complete — ${ciPlan.outputs.findings_count} ` +
        `finding(s) (${ciPlan.outputs.blocking_count} blocking)`,
    ),
  );
}
