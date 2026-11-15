// The hunter exam's grader, tested before it grades a live run. Pure in, pure
// out: no spawns, no network. The fixture table follows the rule that a grader
// is examined first: a known-good draft passes, a different but valid site
// passes, a plausible wrong site fails, a flag-everything draft fails, and a
// run that delivered nothing is an infrastructure error, never a verdict.

import { describe, expect, test } from "bun:test";
import {
  aggregateCase,
  type ExamCase,
  ExamCaseError,
  type ExamDefect,
  type ExamReplicate,
  gradeRun,
  parseExamBank,
  renderExamTable,
  selectCases,
  tallyExam,
} from "#compare/hunter-exam";

const CASE: ExamCase = {
  id: "ts-stale-total",
  language: "typescript",
  project: "cart",
  origin: "synthetic",
  split: "dev",
  quick: true,
  must_find: [
    {
      id: "d1",
      area: "state",
      severity: "blocking",
      class: "stale-derived-state",
      depth: 2,
      what: "total is cached before the discount is applied",
      sites: [
        { path: "src/cart.ts", start_line: 40, end_line: 52 },
        { path: "src/checkout.ts", start_line: 18, end_line: 21 },
      ],
    },
  ],
  must_not: [
    {
      id: "n1",
      why: "the caller already guards the empty list",
      sites: [{ path: "src/cart.ts", start_line: 70, end_line: 78 }],
    },
  ],
};

const THRESHOLD = { n: 2, m: 3 };

function bank(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ threshold: THRESHOLD, cases: [CASE], ...overrides });
}

describe("parseExamBank", () => {
  test("reads a valid bank", () => {
    const parsed = parseExamBank(bank());
    expect(parsed.threshold).toEqual(THRESHOLD);
    expect(parsed.cases).toEqual([CASE]);
  });

  test("accepts a clean case that carries only decoys", () => {
    const clean = { ...CASE, id: "clean", must_find: [] };
    expect(parseExamBank(bank({ cases: [clean] })).cases[0]?.id).toBe("clean");
  });

  test.each([
    ["not json", "{", /not valid JSON/],
    ["no cases", bank({ cases: [] }), /carries no cases/],
    [
      "duplicate case id",
      bank({ cases: [CASE, CASE] }),
      /case ids must be unique/,
    ],
    [
      "n above m",
      bank({ threshold: { n: 3, m: 2 } }),
      /threshold.n must be between 1 and threshold.m/,
    ],
    [
      "unknown split",
      bank({ cases: [{ ...CASE, split: "test" }] }),
      /split must be "dev" or "holdout"/,
    ],
    [
      "an area outside the vocabulary",
      bank({
        cases: [
          { ...CASE, must_find: [{ ...CASE.must_find[0], area: "style" }] },
        ],
      }),
      /area must be one of logic, state/,
    ],
    [
      "a severity outside the two",
      bank({
        cases: [
          { ...CASE, must_find: [{ ...CASE.must_find[0], severity: "high" }] },
        ],
      }),
      /severity must be "blocking" or "advisory"/,
    ],
    [
      "an unknown origin",
      bank({ cases: [{ ...CASE, origin: "mined" }] }),
      /origin must be one of synthetic, real-fix, real-intro/,
    ],
    [
      "a case with nothing to grade",
      bank({ cases: [{ ...CASE, must_find: [], must_not: [] }] }),
      /needs at least one must_find or must_not entry/,
    ],
    [
      "an entry with no site",
      bank({
        cases: [{ ...CASE, must_not: [{ id: "n1", why: "x", sites: [] }] }],
      }),
      /must_not\[0\].sites must be a non-empty array/,
    ],
    [
      "a reversed range",
      bank({
        cases: [
          {
            ...CASE,
            must_not: [
              {
                id: "n1",
                why: "x",
                sites: [{ path: "a.ts", start_line: 9, end_line: 3 }],
              },
            ],
          },
        ],
      }),
      /end_line \(3\) is before start_line \(9\)/,
    ],
    [
      "duplicate entry id across the two lists",
      bank({
        cases: [
          {
            ...CASE,
            must_not: [{ ...CASE.must_not[0], id: "d1" }],
          },
        ],
      }),
      /entry ids must be unique/,
    ],
  ])("refuses %s", (_label, raw, message) => {
    expect(() => parseExamBank(raw)).toThrow(ExamCaseError);
    expect(() => parseExamBank(raw)).toThrow(message);
  });

  // A line that is both a required find and a forbidden one cannot be scored:
  // the same finding would pass and fail the case.
  test("refuses a must_find site that overlaps a must_not site", () => {
    const overlapping = {
      ...CASE,
      must_not: [
        {
          id: "n1",
          why: "x",
          sites: [{ path: "./src/cart.ts", start_line: 52, end_line: 60 }],
        },
      ],
    };
    expect(() => parseExamBank(bank({ cases: [overlapping] }))).toThrow(
      /d1 and n1 overlap at src\/cart.ts/,
    );
  });
});

describe("gradeRun", () => {
  test("a finding on the planted site is a find", () => {
    const grade = gradeRun(CASE, [
      { path: "src/cart.ts", line: 44, severity: "CRITICAL" },
    ]);
    expect(grade).toEqual({
      status: "graded",
      findings: 1,
      found: ["d1"],
      missed: [],
      underrated: [],
      flagged: [],
      extras: 0,
    });
  });

  test("a finding on the alternative site is the same find", () => {
    const grade = gradeRun(CASE, [{ path: "./src/checkout.ts", line: 18 }]);
    expect(grade.found).toEqual(["d1"]);
  });

  test("two findings on one defect count once", () => {
    const grade = gradeRun(CASE, [
      { path: "src/cart.ts", line: 40 },
      { path: "src/checkout.ts", line: 21 },
    ]);
    expect(grade.found).toEqual(["d1"]);
    expect(grade.extras).toBe(0);
  });

  test("a plausible wrong site misses and is counted as an extra", () => {
    const grade = gradeRun(CASE, [{ path: "src/cart.ts", line: 53 }]);
    expect(grade.found).toEqual([]);
    expect(grade.missed).toEqual(["d1"]);
    expect(grade.extras).toBe(1);
  });

  test("the right line in another file does not match", () => {
    const grade = gradeRun(CASE, [{ path: "lib/src/cart.ts", line: 44 }]);
    expect(grade.missed).toEqual(["d1"]);
  });

  test("a finding on a decoy is flagged", () => {
    const grade = gradeRun(CASE, [{ path: "src/cart.ts", line: 70 }]);
    expect(grade.flagged).toEqual(["n1"]);
    expect(grade.extras).toBe(0);
  });

  // Found is not enough for a blocking defect: a warning is never checked
  // downstream and never blocks.
  test("a blocking defect reported as a warning is found but underrated", () => {
    const grade = gradeRun(CASE, [
      { path: "src/cart.ts", line: 44, severity: "WARNING" },
    ]);
    expect(grade.found).toEqual(["d1"]);
    expect(grade.underrated).toEqual(["d1"]);
  });

  test("one blocking finding on the site is enough to rate it", () => {
    const grade = gradeRun(CASE, [
      { path: "src/cart.ts", line: 44, severity: "WARNING" },
      { path: "src/checkout.ts", line: 19, severity: "BLOCKER" },
    ]);
    expect(grade.underrated).toEqual([]);
  });

  test("an advisory defect is never underrated, and a miss is not either", () => {
    const advisory: ExamCase = {
      ...CASE,
      must_find: [
        { ...(CASE.must_find[0] as ExamDefect), severity: "advisory" },
      ],
    };
    expect(
      gradeRun(advisory, [
        { path: "src/cart.ts", line: 44, severity: "WARNING" },
      ]).underrated,
    ).toEqual([]);
    expect(gradeRun(CASE, []).underrated).toEqual([]);
  });

  test("an empty draft finds nothing and flags nothing", () => {
    const grade = gradeRun(CASE, []);
    expect(grade.missed).toEqual(["d1"]);
    expect(grade.flagged).toEqual([]);
  });

  // The shortcut: report every line. It finds the defect and must still lose.
  test("a flag-everything draft finds the defect and trips the decoy", () => {
    const everything = Array.from({ length: 100 }, (_, i) => ({
      path: "src/cart.ts",
      line: i + 1,
    }));
    const grade = gradeRun(CASE, everything);
    expect(grade.found).toEqual(["d1"]);
    expect(grade.flagged).toEqual(["n1"]);
    expect(grade.extras).toBe(100 - 13 - 9);
  });
});

function graded(lines: Array<[string, number]>): ExamReplicate {
  return gradeRun(
    CASE,
    lines.map(([path, line]) => ({ path, line })),
  );
}

const HIT: [string, number] = ["src/cart.ts", 44];
const DECOY: [string, number] = ["src/cart.ts", 72];
const INFRA: ExamReplicate = { status: "infra_error", reason: "no draft" };

describe("aggregateCase", () => {
  test("two finds of three pass", () => {
    const result = aggregateCase(
      CASE,
      [graded([HIT]), graded([]), graded([HIT])],
      THRESHOLD,
    );
    expect(result.verdict).toBe("pass");
    expect(result.must_find).toEqual([
      { id: "d1", hits: 2, runs: 3, verdict: "pass" },
    ]);
    expect(result.must_not).toEqual([
      { id: "n1", hits: 0, runs: 3, verdict: "pass" },
    ]);
  });

  test("rating is counted beside the verdict, not inside it", () => {
    const warned = gradeRun(CASE, [
      { path: "src/cart.ts", line: 44, severity: "WARNING" },
    ]);
    const result = aggregateCase(CASE, [warned, warned], THRESHOLD);
    expect(result.verdict).toBe("pass");
    expect(result.rated).toEqual([
      { id: "d1", hits: 0, runs: 2, verdict: "fail" },
    ]);
  });

  test("one find of three fails", () => {
    const result = aggregateCase(
      CASE,
      [graded([HIT]), graded([]), graded([])],
      THRESHOLD,
    );
    expect(result.verdict).toBe("fail");
  });

  test("a decoy flagged in two runs fails a case that found its defect", () => {
    const result = aggregateCase(
      CASE,
      [graded([HIT, DECOY]), graded([HIT, DECOY]), graded([HIT])],
      THRESHOLD,
    );
    expect(result.must_find[0]?.verdict).toBe("pass");
    expect(result.must_not[0]?.verdict).toBe("fail");
    expect(result.verdict).toBe("fail");
  });

  // Early stop: once every entry is decided, the remaining replicates cannot
  // change the verdict, so the runner does not have to buy them.
  test("two clean finds decide the case without a third run", () => {
    const result = aggregateCase(
      CASE,
      [graded([HIT]), graded([HIT])],
      THRESHOLD,
    );
    expect(result.verdict).toBe("pass");
    expect(result.decided).toBe(true);
  });

  test("two misses decide a failure without a third run", () => {
    const result = aggregateCase(CASE, [graded([]), graded([])], THRESHOLD);
    expect(result.verdict).toBe("fail");
    expect(result.decided).toBe(true);
  });

  test("one find and one miss are undecided", () => {
    const result = aggregateCase(CASE, [graded([HIT]), graded([])], THRESHOLD);
    expect(result.verdict).toBe("undecided");
    expect(result.decided).toBe(false);
  });

  test("no replicates is undecided, never a pass", () => {
    const result = aggregateCase(CASE, [], THRESHOLD);
    expect(result.verdict).toBe("undecided");
  });

  // A run that delivered no draft says nothing about the hunter. It is not a
  // miss and it does not count toward m.
  test("an infrastructure error is not a miss", () => {
    const result = aggregateCase(
      CASE,
      [graded([HIT]), INFRA, graded([HIT])],
      THRESHOLD,
    );
    expect(result.verdict).toBe("pass");
    expect(result.infra_errors).toBe(1);
    expect(result.must_find[0]).toEqual({
      id: "d1",
      hits: 2,
      runs: 2,
      verdict: "pass",
    });
  });

  test("only infrastructure errors leave the case undecided", () => {
    const result = aggregateCase(CASE, [INFRA, INFRA, INFRA], THRESHOLD);
    expect(result.verdict).toBe("undecided");
    expect(result.infra_errors).toBe(3);
  });

  test("extras are listed per replicate, never averaged", () => {
    const result = aggregateCase(
      CASE,
      [graded([HIT, ["src/other.ts", 3]]), graded([HIT])],
      THRESHOLD,
    );
    expect(result.extras).toEqual([1, 0]);
  });
});

describe("selectCases", () => {
  const holdout: ExamCase = {
    ...CASE,
    id: "go-lock",
    language: "go",
    split: "holdout",
  };
  const cases = [CASE, holdout];

  test("leaves the holdout out unless it is asked for", () => {
    expect(selectCases(cases, {}).map((c) => c.id)).toEqual(["ts-stale-total"]);
    expect(selectCases(cases, { split: "holdout" }).map((c) => c.id)).toEqual([
      "go-lock",
    ]);
  });

  test("filters by language and by id", () => {
    expect(selectCases(cases, { languages: ["go"] })).toEqual([]);
    expect(
      selectCases(cases, { split: "holdout", ids: ["go-lock"] }).length,
    ).toBe(1);
  });

  test("narrows by area, depth, project, origin and the quick set", () => {
    const deep: ExamCase = {
      ...CASE,
      id: "py-deep",
      project: "sched",
      origin: "real-fix",
      quick: false,
      must_find: [
        { ...(CASE.must_find[0] as ExamDefect), area: "security", depth: 3 },
      ],
    };
    const both = [CASE, deep];
    const idsOf = (selection: Parameters<typeof selectCases>[1]) =>
      selectCases(both, selection).map((c) => c.id);
    expect(idsOf({ areas: ["security"] })).toEqual(["py-deep"]);
    expect(idsOf({ areas: ["state", "data"] })).toEqual(["ts-stale-total"]);
    expect(idsOf({ minDepth: 3 })).toEqual(["py-deep"]);
    expect(idsOf({ projects: ["cart"] })).toEqual(["ts-stale-total"]);
    expect(idsOf({ origin: "real-fix" })).toEqual(["py-deep"]);
    expect(idsOf({ quick: true })).toEqual(["ts-stale-total"]);
    expect(idsOf({})).toEqual(["ts-stale-total", "py-deep"]);
  });

  test("refuses an id the bank does not carry", () => {
    expect(() => selectCases(cases, { ids: ["nope"] })).toThrow(
      /unknown case id: nope/,
    );
  });
});

describe("tallyExam and renderExamTable", () => {
  const passed = aggregateCase(CASE, [graded([HIT]), graded([HIT])], THRESHOLD);
  const failed = aggregateCase(
    { ...CASE, id: "ts-second" },
    [graded([DECOY]), graded([DECOY])],
    THRESHOLD,
  );
  const tally = tallyExam(
    [CASE, { ...CASE, id: "ts-second" }],
    [passed, failed],
  );

  test("counts cases, defects and decoys", () => {
    expect(tally.cases).toEqual({ pass: 1, fail: 1, undecided: 0 });
    expect(tally.defects).toEqual({ found: 1, total: 2 });
    expect(tally.rated).toEqual({ found: 0, total: 2 });
    expect(tally.decoys).toEqual({ flagged: 1, total: 2 });
    expect(tally.by_depth).toEqual({ "2": { found: 1, total: 2 } });
    expect(tally.by_area).toEqual({ state: { found: 1, total: 2 } });
    expect(tally.by_class).toEqual({
      "stale-derived-state": { found: 1, total: 2 },
    });
  });

  test("renders counts, not percentages, and no escape bytes", () => {
    const lines = renderExamTable("logic", tally, [passed, failed]);
    const text = lines.join("\n");
    expect(text).toContain("defects found 1/2");
    expect(text).toContain("decoys flagged 1/2");
    expect(text).toContain("| ts-second | fail |");
    expect(text).not.toContain("%");
    expect(text).not.toContain("\x1b");
  });
});
