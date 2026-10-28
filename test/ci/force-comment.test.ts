import { describe, expect, test } from "bun:test";
import {
  CI_FORCE_WORKFLOW_FILE,
  CI_REVIEW_COMMENT,
  CI_REVIEW_FULL_COMMENT,
  ciForceReviewDispatch,
  ciForceReviewHintLine,
} from "#ci/force-comment";
import { planCiReviewManualRequired, planCiReviewSkip } from "#ci/gates";
import { generateCiWorkflowTemplate } from "#ci/setup";

describe("the review comment", () => {
  test("is the exact command the scaffolded workflow starts on", () => {
    expect(CI_REVIEW_COMMENT).toBe("/crysk review");
    expect(CI_REVIEW_FULL_COMMENT).toBe(`${CI_REVIEW_COMMENT} --full`);
    // The hint and the trigger must name the same command, or the hint
    // sends people to a comment the workflow never starts on.
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { if: string } };
    };
    expect(parsed.jobs.review.if).toContain(
      `startsWith(github.event.comment.body, '${CI_REVIEW_COMMENT}')`,
    );
  });
});

// The legacy fallback: workflows scaffolded before the comment trigger have
// only the dispatch-only pr-hero-force.yml.
describe("ciForceReviewDispatch", () => {
  test("dispatches the legacy force workflow on GitHub and names the PR", () => {
    expect(ciForceReviewDispatch(55)).toBe(
      "gh workflow run pr-hero-force.yml -f pr=55",
    );
    expect(CI_FORCE_WORKFLOW_FILE).toBe("pr-hero-force.yml");
  });

  test("refuses a PR number that is not a positive integer", () => {
    expect(() => ciForceReviewDispatch(0)).toThrow();
    expect(() => ciForceReviewDispatch(1.5)).toThrow();
    expect(() => ciForceReviewHintLine(-3)).toThrow();
  });
});

describe("skip comments name the review comment, then the legacy dispatch", () => {
  const prior = {
    blocking: 0,
    advisory: 0,
    score: 0,
    source: "none" as const,
  };

  test("an admission skip tells the reader to ask GitHub, not to review locally", () => {
    const plan = planCiReviewSkip({
      prNumber: 7,
      ciMode: "advisory",
      verdict: {
        action: "skip",
        reason: "once-per-pr",
        prior,
        reviewCount: 1,
        maxAttempts: 2,
        minScore: 4,
      },
    });
    expect(plan.comment).toContain(ciForceReviewDispatch(7));
    expect(plan.comment).not.toContain("locally");
  });

  // The comment is the override now; the dispatch line stays for repos
  // whose workflow was scaffolded before the comment trigger existed, where
  // a `/pr-hero review` comment does nothing at all.
  test("a skip names the comment first, then the legacy dispatch and the re-scaffold", () => {
    const plan = planCiReviewSkip({
      prNumber: 7,
      ciMode: "advisory",
      verdict: {
        action: "skip",
        reason: "once-per-pr",
        prior,
        reviewCount: 1,
        maxAttempts: 2,
        minScore: 4,
      },
    });
    const comment = plan.comment;
    expect(comment).toContain("Comment `/crysk review` on this pull request");
    expect(comment).toContain("`/crysk review --full`");
    expect(comment).toContain("`pr-hero ci init --force`");
    expect(comment.indexOf("`/crysk review`")).toBeLessThan(
      comment.indexOf(ciForceReviewDispatch(7)),
    );
  });

  test("manual-required names the same comment and dispatch", () => {
    const plan = planCiReviewManualRequired({
      prNumber: 9,
      ciMode: "advisory",
      verdict: {
        action: "manual-required",
        reason: "max-attempts-exhausted",
        prior,
        reviewCount: 2,
        maxAttempts: 2,
        minScore: 4,
      },
    });
    expect(plan.comment).toContain(ciForceReviewHintLine(9));
    expect(plan.comment).toContain(ciForceReviewDispatch(9));
    expect(plan.comment).not.toContain("pr-hero review --pr");
  });
});
