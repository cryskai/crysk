import { describe, expect, test } from "bun:test";
import {
  EXIT_REVIEW_COMPLETE,
  EXIT_REVIEW_FAILED,
  EXIT_REVIEW_INCOMPLETE,
  reviewExitCode,
} from "#review/exit-code";

const complete = {
  sessionFailed: false,
  runStatus: "complete",
  droppedFindingIds: 0,
} as const;

describe("reviewExitCode — the table", () => {
  test("the codes are the documented numbers", () => {
    expect([
      EXIT_REVIEW_COMPLETE,
      EXIT_REVIEW_FAILED,
      EXIT_REVIEW_INCOMPLETE,
    ]).toEqual([0, 1, 3]);
  });

  test("a complete review exits 0", () => {
    expect(reviewExitCode(complete)).toBe(0);
  });

  test("an incomplete review exits 3", () => {
    expect(reviewExitCode({ ...complete, runStatus: "partial" })).toBe(3);
  });

  test("every hunter failed exits 1, even though the run is also partial", () => {
    expect(
      reviewExitCode({
        ...complete,
        sessionFailed: true,
        runStatus: "partial",
      }),
    ).toBe(1);
  });

  test("no reviewer ran exits 1, even though the run is also partial", () => {
    expect(
      reviewExitCode({
        ...complete,
        noReviewerRan: true,
        runStatus: "partial",
      }),
    ).toBe(1);
  });

  test("a re-review that skipped discovery on purpose exits 0", () => {
    expect(reviewExitCode({ ...complete, noReviewerRan: false })).toBe(0);
  });

  test("a dropped posting exits 1, and outranks an incomplete review", () => {
    expect(reviewExitCode({ ...complete, droppedFindingIds: 2 })).toBe(1);
    expect(
      reviewExitCode({
        ...complete,
        runStatus: "partial",
        droppedFindingIds: 2,
      }),
    ).toBe(1);
  });
});

// Spec 2.1, the assistant posture: findings, even blocking ones, never change
// the exit code. blockingCount is accepted only so these tests can pass a high
// count; a change that starts reading it fails here.
describe("reviewExitCode — findings never change the code", () => {
  test("blocking findings on a complete review exit 0", () => {
    expect(reviewExitCode({ ...complete, blockingCount: 7 })).toBe(0);
  });

  test("blocking findings on an incomplete review exit 3", () => {
    expect(
      reviewExitCode({ ...complete, runStatus: "partial", blockingCount: 7 }),
    ).toBe(3);
  });
});
