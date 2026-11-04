// Loop metrics' pure half: the gate timeline of a PR, rounds and time to the
// final green, and the report over many PRs.

import { describe, expect, test } from "bun:test";
import {
  blockingGateSince,
  classifyStatus,
  loopReport,
  percentile,
  prLoop,
  type RawPr,
  type RawStatus,
  renderLoopReport,
} from "#compare/loop";

const CLEAN = "review posted";
const BLOCKING =
  "crysk: 2 blocking finding(s) — fix and push, or /pr-hero override";

function status(
  createdAt: string,
  state: string,
  description: string,
  context = "crysk",
): RawStatus {
  return { createdAt, context, state, description };
}

function pr(statuses: RawStatus[], extra: Partial<RawPr> = {}): RawPr {
  return {
    repo: "o/r",
    number: 1,
    title: "t",
    createdAt: "2026-10-20T10:00:00Z",
    mergedAt: "2026-10-20T12:00:00Z",
    closedAt: "2026-10-20T12:00:00Z",
    state: "MERGED",
    isDraft: false,
    commits: [{ sha: "a", statuses }],
    ...extra,
  };
}

describe("classifyStatus", () => {
  test("a carried blocking verdict is not a review", () => {
    expect(
      classifyStatus(
        status(
          "t",
          "failure",
          "crysk: 1 blocking finding(s) carried from abc1234 — fix",
        ),
      ),
    ).toBe("carried-blocking");
    expect(classifyStatus(status("t", "failure", BLOCKING))).toBe(
      "review-blocking",
    );
  });

  test("a maintainer ending the loop is told apart from a clean review", () => {
    expect(classifyStatus(status("t", "success", CLEAN))).toBe("review-clean");
    expect(
      classifyStatus(
        status("t", "success", "crysk: overridden by @x — no review"),
      ),
    ).toBe("override");
    expect(
      classifyStatus(
        status(
          "t",
          "success",
          "crysk: no review needed (automatic reviews stopped by a maintainer)",
        ),
      ),
    ).toBe("stopped");
  });

  test("a carried green is filed by what carried it, not by the label it embeds", () => {
    // The producer's own strings (src/pr/admission.ts carriedSuccessDescription,
    // unverifiedFixesDescription): both embed a skip rule's label.
    expect(
      classifyStatus(
        status(
          "t",
          "success",
          "crysk: 2 answered finding(s), fixes unverified (automatic reviews stopped by a maintainer); carried from abc1234",
        ),
      ),
    ).toBe("unverified-fixes");
    expect(
      classifyStatus(
        status(
          "t",
          "success",
          "crysk: no review needed (review budget for this PR is used up); carried from abc1234",
        ),
      ),
    ).toBe("budget-carried");
  });
});

describe("prLoop", () => {
  test("an exhausted budget counts whether it wrote a red or carried a green", () => {
    const red = prLoop(
      pr([
        status(
          "2026-10-20T10:05:00Z",
          "failure",
          "crysk: review budget for this PR is used up — /pr-hero review reviews this head",
        ),
      ]),
    );
    const carried = prLoop(
      pr([
        status("2026-10-20T10:05:00Z", "success", CLEAN),
        status(
          "2026-10-20T10:30:00Z",
          "success",
          "crysk: no review needed (review budget for this PR is used up); carried from abc1234",
        ),
      ]),
    );
    expect(red?.budgetExhausted).toBe(true);
    expect(carried?.budgetExhausted).toBe(true);
    expect(carried?.greenBy).toBe("review-clean");
  });

  // Stage 2 #12: a capped rule's hold is pending, but no run: the head is not green, and the budget counts.
  test("a manual-review hold is a head that is not green, and counts the budget", () => {
    const loop = prLoop(
      pr([
        status("2026-10-20T10:05:00Z", "success", CLEAN),
        status(
          "2026-10-20T10:30:00Z",
          "pending",
          "crysk: waiting for a manual review (review budget for this PR is used up) — /pr-hero review verifies this head, or /pr-hero override",
        ),
      ]),
    );
    expect(loop?.greenBy).toBeNull();
    expect(loop?.budgetExhausted).toBe(true);
  });

  test("a review posted under both contexts counts once", () => {
    const loop = prLoop(
      pr([
        status("2026-10-20T10:05:00Z", "success", CLEAN, "crysk"),
        status("2026-10-20T10:05:00Z", "success", CLEAN, "pr-hero"),
      ]),
    );
    expect(loop?.reviews).toBe(1);
  });

  test("a PR with only legacy pr-hero statuses is read from them", () => {
    const loop = prLoop(
      pr([status("2026-10-20T10:05:00Z", "success", CLEAN, "pr-hero")]),
    );
    expect(loop?.reviews).toBe(1);
    expect(loop?.greenBy).toBe("review-clean");
  });

  test("statuses set before the PR opened or after it closed are ignored", () => {
    // A release PR lists commits whose statuses came from the feature PRs.
    const loop = prLoop(
      pr([
        status("2026-10-19T10:00:00Z", "failure", BLOCKING),
        status("2026-10-20T10:05:00Z", "success", CLEAN),
        status("2026-10-21T10:00:00Z", "failure", BLOCKING),
      ]),
    );
    expect(loop?.reviews).toBe(1);
    expect(loop?.greenBy).toBe("review-clean");
    expect(loop?.hoursToGreen).toBeCloseTo(5 / 60);
  });

  test("pending statuses and carried verdicts are not reviews", () => {
    const loop = prLoop(
      pr([
        status("2026-10-20T10:01:00Z", "pending", "crysk reviewing"),
        status("2026-10-20T10:05:00Z", "failure", BLOCKING),
        status(
          "2026-10-20T10:20:00Z",
          "failure",
          "crysk: 2 blocking finding(s) carried from abc — fix",
        ),
        status(
          "2026-10-20T10:30:00Z",
          "success",
          "crysk: no review needed (delta touches only low-risk paths); carried from abc",
        ),
      ]),
    );
    expect(loop?.reviews).toBe(1);
    expect(loop?.greenBy).toBe("low-risk");
    expect(loop?.roundsToGreen).toBe(1);
  });

  test("the final green is the first success after the last red", () => {
    const loop = prLoop(
      pr([
        status("2026-10-20T10:05:00Z", "success", CLEAN),
        status("2026-10-20T10:30:00Z", "failure", BLOCKING),
        status("2026-10-20T11:00:00Z", "success", CLEAN),
        status("2026-10-20T11:30:00Z", "success", CLEAN),
      ]),
    );
    expect(loop?.firstReview).toBe("clean");
    expect(loop?.roundsToGreen).toBe(3);
    expect(loop?.hoursToGreen).toBe(1);
    expect(loop?.reviews).toBe(4);
  });

  test("a PR whose last verdict is red never reached green", () => {
    const loop = prLoop(
      pr([
        status("2026-10-20T10:05:00Z", "success", CLEAN),
        status(
          "2026-10-20T10:30:00Z",
          "failure",
          "crysk: review budget for this PR is used up — /pr-hero review reviews this head",
        ),
      ]),
    );
    expect(loop?.greenBy).toBeNull();
    expect(loop?.roundsToGreen).toBeNull();
    expect(loop?.hoursToGreen).toBeNull();
    expect(loop?.budgetExhausted).toBe(true);
  });

  test("only reviews run while the gate was red on blocking findings are fix rounds", () => {
    const loop = prLoop(
      pr([
        status("2026-10-20T10:05:00Z", "success", CLEAN),
        // The author keeps pushing after a green: not the gate's loop.
        status("2026-10-20T10:20:00Z", "success", CLEAN),
        status("2026-10-20T10:30:00Z", "failure", BLOCKING),
        // A failed run does not clear the red.
        status("2026-10-20T10:40:00Z", "error", "review did not finish"),
        status("2026-10-20T10:50:00Z", "failure", BLOCKING),
        status("2026-10-20T11:00:00Z", "success", CLEAN),
        status("2026-10-20T11:30:00Z", "success", CLEAN),
      ]),
    );
    expect(loop?.reviews).toBe(6);
    expect(loop?.fixRounds).toBe(2);
  });

  test("an override ends the loop with the reviews before it", () => {
    const loop = prLoop(
      pr([
        status("2026-10-20T10:05:00Z", "failure", BLOCKING),
        status(
          "2026-10-20T10:40:00Z",
          "success",
          "crysk: overridden by @x — no review on this head",
        ),
      ]),
    );
    expect(loop?.greenBy).toBe("override");
    expect(loop?.roundsToGreen).toBe(1);
  });

  test("a PR with no gate status has no loop", () => {
    expect(prLoop(pr([]))).toBeNull();
    expect(
      prLoop(
        pr([status("2026-10-20T10:01:00Z", "pending", "crysk reviewing")]),
      ),
    ).toBeNull();
  });
});

describe("blockingGateSince", () => {
  test("is the first blocking review in the data", () => {
    const prs = [
      pr([status("2026-10-20T10:05:00Z", "failure", BLOCKING)]),
      pr([
        status("2026-10-18T10:00:00Z", "success", CLEAN),
        status("2026-10-19T10:00:00Z", "failure", BLOCKING),
      ]),
    ];
    expect(blockingGateSince(prs)).toBe("2026-10-19T10:00:00Z");
  });

  test("is null when the gate never blocked", () => {
    expect(
      blockingGateSince([
        pr([status("2026-10-20T10:05:00Z", "success", CLEAN)]),
      ]),
    ).toBeNull();
  });
});

describe("percentile", () => {
  test("uses nearest rank and is null on an empty list", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile([4, 1, 3, 2], 75)).toBe(3);
    expect(percentile([4, 1, 3, 2], 90)).toBe(4);
  });
});

describe("loopReport", () => {
  const prs = [
    pr([status("2026-10-20T10:06:00Z", "success", CLEAN)], { number: 1 }),
    pr(
      [
        status("2026-10-20T10:05:00Z", "failure", BLOCKING),
        status("2026-10-20T11:00:00Z", "success", CLEAN),
      ],
      { number: 2 },
    ),
    pr([status("2026-10-20T10:05:00Z", "failure", BLOCKING)], {
      number: 3,
      mergedAt: null,
    }),
    pr([], { number: 4 }),
  ];

  test("counts PRs with a gate verdict, rounds and how green was reached", () => {
    const report = loopReport(prs);
    expect(report.prs).toBe(3);
    expect(report.merged).toBe(2);
    expect(report.firstReview).toEqual({ clean: 1, blocking: 2, none: 0 });
    expect(report.roundsToGreen).toEqual({
      "0": 0,
      "1": 1,
      "2": 1,
      "3": 0,
      "4+": 0,
    });
    expect(report.fixRounds).toEqual({
      "0": 2,
      "1": 1,
      "2": 0,
      "3": 0,
      "4+": 0,
    });
    expect(report.greenBy).toEqual({ "review-clean": 2 });
    expect(report.neverGreen).toBe(1);
    expect(report.hoursToGreen.p50).toBeCloseTo(0.1);
    expect(report.hoursToGreen.p90).toBe(1);
  });

  test("renders plain lines", () => {
    const lines = renderLoopReport(loopReport(prs));
    expect(lines[0]).toBe(
      "PRs with a gate verdict: 3 (2 merged), 4 completed reviews, 0 failed runs",
    );
    expect(
      lines.some((l) => l.includes("ended red") && l.includes("1 (33%)")),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain("\x1b");
  });
});
