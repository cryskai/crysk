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

// Refuter v3.2 (2026-10-26) submits every severity, so the refuter-started
// event counts every submitted finding (its field keeps the published name
// `severeFindings`). The line must not call a WARNING "severe".
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

  test("counts submitted findings without calling them severe", () => {
    expect(linesFor(1)).toEqual(["refuter: 1 finding to judge"]);
    expect(linesFor(3)).toEqual(["refuter: 3 findings to judge"]);
  });
});
