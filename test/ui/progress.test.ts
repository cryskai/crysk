// confirm()'s spec builder: the cost gate's ConfirmSpec is built from the same
// free-route count the plan card was printed with, so the hint and the prompt
// cannot disagree with the card above them. The builder is pure, so this runs
// offline; confirm() itself only adds the styles read and the menu call.

import { afterEach, describe, expect, test } from "bun:test";
import { confirmSpecFor, startLineRenderer } from "#ui/progress";

const details = () => ["details"];

describe("confirmSpecFor", () => {
  test("no free-route count: the spec carries no billing mode (metered, unchanged)", () => {
    const spec = confirmSpecFor(2.85, 6.14, true, details, undefined);
    expect(spec.billing).toBeUndefined();
    expect(spec.low).toBe(2.85);
    expect(spec.high).toBe(6.14);
    expect(spec.canSkipPost).toBe(true);
  });

  test("every step free: the spec is billed as free", () => {
    expect(
      confirmSpecFor(2.85, 6.14, false, details, { free: 3, total: 3 }).billing,
    ).toBe("free");
  });

  test("some steps free: the spec is billed as mixed", () => {
    expect(
      confirmSpecFor(2.85, 6.14, false, details, { free: 1, total: 3 }).billing,
    ).toBe("mixed");
  });

  test("zero free steps: the spec is unbilled, so subscription and metered keep today's wording", () => {
    expect(
      confirmSpecFor(2.85, 6.14, false, details, { free: 0, total: 3 }).billing,
    ).toBeUndefined();
  });
});

// Only BLOCKER/CRITICAL findings are submitted to the refuter, so the
// refuter-started count is a count of severe findings and the line says so.
describe("startLineRenderer refuter-started line", () => {
  const realWrite = process.stderr.write.bind(process.stderr);
  afterEach(() => {
    process.stderr.write = realWrite;
  });

  function linesFor(count: number): string[] {
    const written: string[] = [];
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    startLineRenderer(performance.now()).onProgress({
      kind: "refuter-started",
      severeFindings: count,
    });
    process.stderr.write = realWrite;
    return written.map((chunk) =>
      chunk.replace(/^ {2}\[[^\]]*\] /, "").trimEnd(),
    );
  }

  test("counts the severe findings submitted", () => {
    expect(linesFor(1)).toEqual(["refuter: 1 severe finding to judge"]);
    expect(linesFor(3)).toEqual(["refuter: 3 severe findings to judge"]);
  });
});
