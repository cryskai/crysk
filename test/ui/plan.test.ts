// reviewingLine: the "reviewing — N hunter(s) + refuter …" line both orchestrators print
// right before the pipeline starts. Moved here from test/review/run.test.ts together
// with the function, which moved from review/run.ts to ui/plan.ts.

import { describe, expect, test } from "bun:test";
import { planEstimateLine, reviewingLine } from "#ui/plan";

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
    const line = reviewingLine(1, summaryDisabled, { scout: false });
    expect(line).toBe(
      "reviewing — 1 hunter + refuter + summarizer disabled; comparable trees have taken 8–25 minutes",
    );
  });

  test("plural hunter count reads 'N hunters'", () => {
    const line = reviewingLine(3, summaryDisabled, { scout: false });
    expect(line).toBe(
      "reviewing — 3 hunters + refuter + summarizer disabled; comparable trees have taken 8–25 minutes",
    );
  });

  test("zero hunters still pluralizes (0 !== 1)", () => {
    const line = reviewingLine(0, summaryDisabled, { scout: false });
    expect(line).toBe(
      "reviewing — 0 hunters + refuter + summarizer disabled; comparable trees have taken 8–25 minutes",
    );
  });

  test("summarizer enabled and scout on: both labels appended in order", () => {
    const line = reviewingLine(2, summaryEnabled, { scout: true });
    expect(line).toBe(
      "reviewing — 2 hunters + refuter + summarizer + scout; comparable trees have taken 8–25 minutes",
    );
  });
});

// planEstimateLine: the estimate row of the plan card, shared by the local and
// PR renderers. The band is token-derived in every case; what changes is
// whether it is billed. A free route is not billed, so the band is labelled
// as token-derived rather than quoted as a cost.
describe("planEstimateLine", () => {
  const estimate = { low: 3.93, high: 8.47 };
  const base = {
    estimate,
    hunterCount: 4,
    summarizer: true,
  } as const;

  test("metered (no freeRoute): the band line is unchanged", () => {
    expect(planEstimateLine(base)).toBe(
      "estimate $3.93 – $8.47 (4 hunter(s) + refuter + summarizer)",
    );
  });

  test("metered with the summarizer off keeps today's wording", () => {
    expect(planEstimateLine({ ...base, summarizer: false })).toBe(
      "estimate $3.93 – $8.47 (4 hunter(s) + refuter + summarizer disabled)",
    );
  });

  test("subscription (zero free steps) is byte-identical to metered", () => {
    expect(
      planEstimateLine({ ...base, freeRoute: { free: 0, total: 5 } }),
    ).toBe(planEstimateLine(base));
  });

  test("all steps free: the free-route line, token-derived band, not billed", () => {
    expect(
      planEstimateLine({ ...base, freeRoute: { free: 5, total: 5 } }),
    ).toBe("estimate: free route (token-derived $3.93 – $8.47, not billed)");
  });

  test("mixed free and metered: the band stays and says free steps are not billed", () => {
    expect(
      planEstimateLine({ ...base, freeRoute: { free: 2, total: 5 } }),
    ).toBe(
      "estimate $3.93 – $8.47 (4 hunter(s) + refuter + summarizer) (free steps not billed)",
    );
  });

  test("the free-route band never collapses to $0 – $0", () => {
    const line = planEstimateLine({
      ...base,
      freeRoute: { free: 5, total: 5 },
    });
    expect(line).not.toContain("$0.00");
  });
});
