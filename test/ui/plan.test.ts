// reviewingLine: the "reviewing — N hunter(s) + refuter …" line both orchestrators print
// right before the pipeline starts. Moved here from test/review/run.test.ts together
// with the function, which moved from review/run.ts to ui/plan.ts.

import { describe, expect, test } from "bun:test";
import { reviewingLine } from "#ui/plan";

describe("reviewingLine", () => {
  const summaryDisabled = {
    enabled: false,
    model: undefined,
  } as unknown as Parameters<typeof reviewingLine>[1];
  const summaryEnabled = {
    enabled: true,
    model: undefined,
  } as unknown as Parameters<typeof reviewingLine>[1];

  test("singular hunter count reads '1 hunter', no trailing s", () => {
    const line = reviewingLine(1, summaryDisabled);
    expect(line).toBe(
      "reviewing — 1 hunter + refuter + summarizer disabled; comparable trees have taken 8–25 minutes",
    );
  });

  test("plural hunter count reads 'N hunters'", () => {
    const line = reviewingLine(3, summaryDisabled);
    expect(line).toBe(
      "reviewing — 3 hunters + refuter + summarizer disabled; comparable trees have taken 8–25 minutes",
    );
  });

  test("zero hunters still pluralizes (0 !== 1)", () => {
    const line = reviewingLine(0, summaryDisabled);
    expect(line).toBe(
      "reviewing — 0 hunters + refuter + summarizer disabled; comparable trees have taken 8–25 minutes",
    );
  });

  test("summarizer enabled: the label is appended", () => {
    const line = reviewingLine(2, summaryEnabled);
    expect(line).toBe(
      "reviewing — 2 hunters + refuter + summarizer; comparable trees have taken 8–25 minutes",
    );
  });
});
