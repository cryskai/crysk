import { describe, expect, test } from "bun:test";
import {
  CI_FORCE_WORKFLOW_FILE,
  CI_REVIEW_COMMENT,
  CI_REVIEW_FULL_COMMENT,
  ciForceReviewDispatch,
  ciForceReviewHintLine,
} from "#ci/force-comment";
import {
  planCiLimitsSkip,
  planCiReviewManualRequired,
  planCiReviewSkip,
  planCiSizeSkip,
} from "#ci/gates";
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
  // a `/crysk review` comment does nothing at all.
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
    expect(comment).toContain("`crysk ci init --force`");
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

// A limits skip only happens on a platform repository (the limits come from the
// platform), whose workflow is the platform's stub: only `/crysk review` runs a
// review there, and the limits are dashboard settings.
describe("a limits skip on a platform repository", () => {
  const plan = planCiLimitsSkip({
    isCi: true,
    billingMode: "metered",
    limits: { reviewUsd: 10, estimateUsd: 11.06 },
    prNumber: 11,
    force: false,
    ciMode: "advisory",
  });

  test("names only `/crysk review` and the dashboard, nothing a platform repo lacks", () => {
    for (const text of [plan?.comment ?? "", plan?.summaryMarkdown ?? ""]) {
      expect(text).not.toContain("/pr-hero");
      expect(text).not.toContain(CI_FORCE_WORKFLOW_FILE);
      expect(text).not.toContain("crysk ci init --force");
      expect(text).not.toContain("--budget-usd");
      expect(text).toContain("Crysk dashboard (Review > Limits)");
    }
    expect(plan?.comment).toContain(
      "Comment `/crysk review` on this pull request to run it anyway",
    );
  });
});

describe("every other skip on a platform repository", () => {
  const prior = { blocking: 0, advisory: 0, score: 0, source: "none" as const };
  const comments = [
    planCiSizeSkip({
      isCi: true,
      verdict: {
        ok: false,
        reason: "lines",
        effectiveLines: 5000,
        effectiveFiles: 3,
        excludedFiles: 0,
        excludedLines: 0,
        limit: 4000,
        message: "5000 changed lines exceed the limit of 4000",
      },
      prNumber: 11,
      maxChangedLines: 4000,
      maxChangedFiles: 50,
      ciMode: "advisory",
      platformConnected: true,
    })?.comment ?? "",
    planCiReviewSkip({
      prNumber: 11,
      ciMode: "advisory",
      verdict: {
        action: "skip",
        reason: "once-per-pr",
        prior,
        reviewCount: 1,
        maxAttempts: 2,
        minScore: 4,
      },
      platformConnected: true,
    }).comment,
    planCiReviewManualRequired({
      prNumber: 11,
      ciMode: "advisory",
      verdict: {
        action: "manual-required",
        reason: "max-attempts-exhausted",
        prior,
        reviewCount: 2,
        maxAttempts: 2,
        minScore: 4,
      },
      platformConnected: true,
    }).comment,
  ];

  test("names `/crysk review`, never the legacy spelling, force workflow or re-scaffold", () => {
    for (const comment of comments) {
      expect(comment).toContain(ciForceReviewHintLine(11, true));
      expect(comment).not.toContain(CI_FORCE_WORKFLOW_FILE);
      expect(comment).not.toContain("crysk ci init --force");
      expect(comment).not.toContain("/pr-hero");
    }
  });

  test("the size skip points at the dashboard's limits, not the workflow inputs", () => {
    expect(comments[0]).toContain(
      "raise the size limits in the Crysk dashboard",
    );
    expect(comments[0]).not.toContain("`max-changed-lines`");
  });
});

// Notice titles and tips: each skip, stop and override notice opens with a one-line
// title, and the command that asks for a review sits in a GitHub `> [!TIP]` alert.
describe("notice titles and tips on a skip, a stop and a manual-required notice", () => {
  const prior = { blocking: 0, advisory: 0, score: 0, source: "none" as const };
  const tipOf = (hint: string) => `> [!TIP]\n> ${hint}`;

  test("the size skip has its title, no warning glyph, and the hint in a TIP", () => {
    const comment =
      planCiSizeSkip({
        isCi: true,
        verdict: {
          ok: false,
          reason: "lines",
          effectiveLines: 5000,
          effectiveFiles: 3,
          excludedFiles: 0,
          excludedLines: 0,
          limit: 4000,
          message: "5000 changed lines exceed the limit of 4000",
        },
        prNumber: 11,
        maxChangedLines: 4000,
        maxChangedFiles: 50,
        ciMode: "advisory",
      })?.comment ?? "";
    expect(comment).toContain(
      "## ⏸ Review skipped: this pull request is too large",
    );
    expect(comment).not.toContain("## Crysk review skipped");
    expect(comment).not.toContain("⚠️");
    expect(comment).toContain(tipOf(ciForceReviewHintLine(11)));
  });

  test("the spend-limit skip has its title, no warning glyph, and the hint in a TIP", () => {
    const comment =
      planCiLimitsSkip({
        isCi: true,
        billingMode: "metered",
        limits: { reviewUsd: 10, estimateUsd: 11.06 },
        prNumber: 11,
        force: false,
        ciMode: "advisory",
      })?.comment ?? "";
    expect(comment).toContain("## ⏸ Review skipped: spend limit reached");
    expect(comment).not.toContain("## Crysk review skipped");
    expect(comment).not.toContain("⚠️");
    expect(comment).toContain(tipOf(ciForceReviewHintLine(11, true)));
  });

  test("a maintainer stop is titled as stopped automatic reviews, with the hint in a TIP", () => {
    const comment = planCiReviewSkip({
      prNumber: 7,
      ciMode: "advisory",
      verdict: {
        action: "skip",
        reason: "stopped",
        prior,
        reviewCount: 1,
        maxAttempts: 2,
        minScore: 4,
      },
    }).comment;
    expect(comment).toContain("## ⏸ Automatic reviews stopped");
    expect(comment).toContain(
      "⏸️ A maintainer stopped automatic reviews on this pull request.",
    );
    expect(comment).toContain(tipOf(ciForceReviewHintLine(7)));
  });

  test("a push that did not justify a run is titled for this push, with the hint in a TIP", () => {
    const comment = planCiReviewSkip({
      prNumber: 7,
      ciMode: "advisory",
      verdict: {
        action: "skip",
        reason: "below-threshold",
        prior,
        reviewCount: 1,
        maxAttempts: 2,
        minScore: 4,
      },
    }).comment;
    expect(comment).toContain("## ⏸ Review skipped for this push");
    expect(comment).toContain(
      "⚠️ This push did not justify another review run.",
    );
    expect(comment).toContain(tipOf(ciForceReviewHintLine(7)));
  });

  test("the automatic-reviews-done notice has its title, the sentence, and rules folded in a details block", () => {
    const comment = planCiReviewManualRequired({
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
    }).comment;
    const at = (text: string) => comment.indexOf(text);
    expect(comment).toContain(
      "## ⏹ Automatic reviews are done for this pull request",
    );
    expect(comment).not.toContain("## Crysk: automatic reviews are done");
    expect(comment).toContain(
      "⏹️ No more automatic reviews will run on this pull request.",
    );
    expect(at("## ⏹ Automatic")).toBeLessThan(at("No more automatic"));
    expect(at("No more automatic")).toBeLessThan(at("[!TIP]"));
    expect(at("[!TIP]")).toBeLessThan(
      at(
        "<details><summary>Why, and what the gate does with later pushes</summary>",
      ),
    );
    expect(comment).toContain(
      "<details><summary>Why, and what the gate does with later pushes</summary>",
    );
    expect(comment).toContain("How it got here, by this repository's rules:");
    expect(comment).toContain("</details>");
  });

  test("the override hint sits inside the TIP of the manual-required notice", () => {
    const comment = planCiReviewManualRequired({
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
    }).comment;
    expect(comment).toContain(
      `> [!TIP]\n> Want more review rounds? ${ciForceReviewHintLine(9)}\n>\n> To merge a head no review verified, comment `,
    );
    expect(comment).toMatch(
      /^> To merge a head no review verified, comment .+\.$/m,
    );
  });
});
