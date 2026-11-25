// The floor test, tested before it scores anything (`docs/research/scout-design.md`
// §3.11). Pure in → pure out; no spawns, no network.
//
// The drift guard at the bottom is the load-bearing one: §2.4septies exists
// because reading the WRONG coordinates would have scored three of its eight
// corpus cases as misses in every run. A canonical markdown table plus a hand-transcribed JSON is exactly the
// shape that drifts, so the transcription is re-derived here instead of
// trusted.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  type FloorCase,
  FloorCaseError,
  parseFloorCases,
  renderFloorTable,
  scoreRun,
  tallyRuns,
} from "#compare/floor-test";
import type { Finding, FindingsDocument } from "#review/findings";

const CASES_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "benchmarks",
  "m6-floor-cases.json",
);
const DESIGN_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "research",
  "scout-design.md",
);

function floorCase(over: Partial<FloorCase> = {}): FloorCase {
  return {
    id: 1,
    pr: 1717,
    path: "packages/app/components/PaywallUpgrade/index.tsx",
    start_line: 119,
    end_line: 119,
    type: "miss",
    what: "ordering bug",
    ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    category: 1,
    path: "packages/app/components/PaywallUpgrade/index.tsx",
    line: 119,
    severity: "CRITICAL",
    evidence_class: "inferential",
    causal_disposition: "introduced",
    claim: "the destination index is written before the scroll",
    proof_refs: ["packages/app/components/PaywallUpgrade/index.tsx:119"],
    hunter: "reliability",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "a:b:1",
    refuter_verdict: "corroborated",
    tier: "blocking",
    ...over,
  } as Finding;
}

function doc(
  pr: number,
  findings: Finding[],
): Pick<FindingsDocument, "pr" | "findings"> {
  return { pr, findings };
}

describe("parseFloorCases", () => {
  test("the shipped case list parses, and is 13 cases over 12 PRs", async () => {
    const cases = parseFloorCases(await Bun.file(CASES_PATH).text());
    expect(cases).toHaveLength(13);
    expect(new Set(cases.map((c) => c.pr)).size).toBe(12);
    // Case 4 and 5 share PR 1724, as cases 1-5 always did.
    expect(cases.filter((c) => c.pr === 1724)).toHaveLength(2);
    expect(cases.filter((c) => c.type === "miss")).toHaveLength(5);
    expect(cases.filter((c) => c.type === "corpus")).toHaveLength(8);
  });

  // The failure §2.4septies's 2026-08-18 note records: a display path matches
  // nothing, because normalizePath refuses basename matching on purpose.
  test("a bare filename is refused, because it would score as a miss in every run", () => {
    expect(() =>
      parseFloorCases(
        JSON.stringify({ cases: [{ ...floorCase(), path: "m4aRemux.ts" }] }),
      ),
    ).toThrow(/repo-relative/);
  });

  test("a corpus case needs its fix_pr and a miss case must not carry one", () => {
    expect(() =>
      parseFloorCases(
        JSON.stringify({ cases: [{ ...floorCase(), type: "corpus" }] }),
      ),
    ).toThrow(/fix_pr/);
    expect(() =>
      parseFloorCases(
        JSON.stringify({ cases: [{ ...floorCase(), fix_pr: 1557 }] }),
      ),
    ).toThrow(/fix_pr/);
  });

  test("malformed input throws rather than degrading", () => {
    // Loud, unlike parsePipelineMeta's tolerance: a bad case list is not a
    // degraded read, it is an experiment about to score the wrong sites.
    expect(() => parseFloorCases("not json")).toThrow(FloorCaseError);
    expect(() => parseFloorCases("[]")).toThrow(/must be a JSON object/);
    expect(() => parseFloorCases("{}")).toThrow(/cases/);
    expect(() => parseFloorCases('{"cases":[]}')).toThrow(/no cases/);
    expect(() =>
      parseFloorCases(
        JSON.stringify({ cases: [floorCase(), { ...floorCase(), pr: 999 }] }),
      ),
    ).toThrow(/unique/);
    expect(() =>
      parseFloorCases(
        JSON.stringify({
          cases: [{ ...floorCase(), start_line: 200, end_line: 100 }],
        }),
      ),
    ).toThrow(/before start_line/);
  });
});

describe("scoreRun — the gate", () => {
  test("a corroborated finding at the site is a hit", () => {
    const [score] = scoreRun(doc(1717, [finding()]), [floorCase()]);
    expect(score?.hit).toBe(true);
    expect(score?.found).toBe(true);
    expect(score?.hits[0]?.finding_id).toBe("F001");
  });

  test("an UNCORROBORATED finding at the site is found, never hit", () => {
    // The gap between the two columns is a statement about the REFUTER: an arm
    // that found the defect and then refuted it away failed differently from
    // one that never looked, and M6 cannot attribute a result it cannot see.
    for (const verdict of [
      "downgraded-latent",
      "inconclusive",
      "not_submitted",
    ] as const) {
      const [score] = scoreRun(
        doc(1717, [finding({ refuter_verdict: verdict })]),
        [floorCase()],
      );
      expect(score?.hit).toBe(false);
      expect(score?.found).toBe(true);
    }
  });

  // Lever D (2026-11-25): a deterministic severe finding never reaches the
  // refuter, so it lands `not_submitted` and blocking on its own evidence. Not
  // counting it would score a real catch as a refuter gap.
  test("a deterministic not_submitted finding that lands blocking is a hit", () => {
    const [score] = scoreRun(
      doc(1717, [
        finding({
          evidence_class: "deterministic",
          refuter_verdict: "not_submitted",
          tier: "blocking",
        }),
      ]),
      [floorCase()],
    );
    expect(score?.hit).toBe(true);
    expect(score?.found).toBe(true);
  });

  // The same pair landing advisory was demoted (a truncated run cut short a
  // check its folded group was owed, or the PR did not cause it): nothing
  // vouched for it, so it is found, never hit.
  test("a deterministic not_submitted finding that lands advisory is found, never hit", () => {
    const [score] = scoreRun(
      doc(1717, [
        finding({
          evidence_class: "deterministic",
          refuter_verdict: "not_submitted",
          tier: "advisory",
        }),
      ]),
      [floorCase()],
    );
    expect(score?.hit).toBe(false);
    expect(score?.found).toBe(true);
  });

  test("the ±25 window is compare.ts's, inclusive on both sides", () => {
    const c = floorCase({ start_line: 140, end_line: 142 });
    const at = (line: number) =>
      scoreRun(doc(1717, [finding({ line })]), [c])[0]?.hit;
    expect(at(115)).toBe(true); // 140 - 25
    expect(at(114)).toBe(false);
    expect(at(167)).toBe(true); // 142 + 25
    expect(at(168)).toBe(false);
  });

  test("a different path at the same line is not the same place", () => {
    // The monorepo has duplicate filenames across packages/; this is why
    // normalizePath refuses basename matching and why the case paths are
    // repo-relative.
    const [score] = scoreRun(
      doc(1717, [
        finding({ path: "packages/web/components/PaywallUpgrade/index.tsx" }),
      ]),
      [floorCase()],
    );
    expect(score?.hit).toBe(false);
    expect(score?.found).toBe(false);
  });

  test("only the cases belonging to this run's PR are scored", () => {
    const cases = [floorCase(), floorCase({ id: 2, pr: 1719 })];
    expect(scoreRun(doc(1717, [finding()]), cases)).toHaveLength(1);
    expect(scoreRun(doc(1719, []), cases)[0]?.case_id).toBe(2);
  });

  test("a zero-finding run scores every one of its cases as a clean miss", () => {
    const [score] = scoreRun(doc(1717, []), [floorCase()]);
    expect(score).toMatchObject({ hit: false, found: false, hits: [] });
  });
});

describe("tallyRuns", () => {
  const cases = [floorCase(), floorCase({ id: 2, pr: 1719 })];
  const scored = (hit: boolean, caseId: number) => ({
    case_id: caseId,
    pr: caseId === 1 ? 1717 : 1719,
    type: "miss" as const,
    hit,
    found: true,
    hits: [],
  });

  test("counts hits per case over replicates, and both readings of 'hit'", () => {
    const tally = tallyRuns(
      [
        { scores: [scored(true, 1), scored(false, 2)] },
        { scores: [scored(true, 1), scored(true, 2)] },
      ],
      cases,
    );
    expect(tally.cases).toEqual([
      { case_id: 1, pr: 1717, type: "miss", hit: 2, found: 2, replicates: 2 },
      { case_id: 2, pr: 1719, type: "miss", hit: 1, found: 2, replicates: 2 },
    ]);
    // §1.3 measured six of eight replicate pairs MOVING, so a 1-of-2 and a
    // 2-of-2 are different claims and the write-up must show both.
    expect(tally.casesHitAny).toBe(2);
    expect(tally.casesHitEvery).toBe(1);
  });

  test("a case nobody ran stays visible with zero replicates", () => {
    // Dropping it would turn an incomplete session into a clean-looking
    // result — the one failure mode a floor test must not have.
    const tally = tallyRuns([{ scores: [scored(true, 1)] }], cases);
    expect(tally.total).toBe(2);
    expect(tally.cases[1]).toMatchObject({ case_id: 2, replicates: 0, hit: 0 });
    expect(tally.casesHitEvery).toBe(1);
  });
});

describe("renderFloorTable", () => {
  const cases = [
    floorCase(),
    floorCase({ id: 2, pr: 1719, start_line: 296, end_line: 296 }),
  ];

  test("marks an unrun case and carries C10's caveat", () => {
    const tally = tallyRuns(
      [
        {
          scores: [
            {
              case_id: 1,
              pr: 1717,
              type: "miss",
              hit: true,
              found: true,
              hits: [],
            },
          ],
        },
      ],
      cases,
    );
    const lines = renderFloorTable(cases, tally);
    const text = lines.join("\n");

    expect(text).toContain("| 1 | 1717 | miss | 1/1 |");
    expect(text).toContain(
      "`packages/app/components/PaywallUpgrade/index.tsx:119`",
    );
    expect(text).toContain("| 2 | 1719 | miss | not run |");
    expect(text).toContain("1/2 cases hit");
    // The blind spot travels WITH the numbers: a table this compact is exactly
    // the kind that gets screenshotted away from its caveat.
    expect(text).toContain("cannot see a defect every run missed");
  });

  test("a found-but-refuted case shows the gap rather than hiding it", () => {
    const tally = tallyRuns(
      [
        {
          scores: [
            {
              case_id: 1,
              pr: 1717,
              type: "miss",
              hit: false,
              found: true,
              hits: [],
            },
          ],
        },
      ],
      cases,
    );
    expect(renderFloorTable(cases, tally)[2]).toContain("0/1 (found 1)");
  });

  test("a multi-line site keeps its range", () => {
    const ranged = [floorCase({ start_line: 140, end_line: 142 })];
    expect(
      renderFloorTable(ranged, tallyRuns([], ranged)).join("\n"),
    ).toContain(":140-142`");
  });

  test("no ANSI bytes — this table is written to a file and read in a diff", () => {
    expect(
      renderFloorTable(cases, tallyRuns([], cases)).join("\n"),
    ).not.toContain("\x1b");
  });
});

// ---------------------------------------------------------------------------
// The drift guard. §2.4septies is the canonical statement and this JSON is a
// hand transcription of it; the pair is exactly the shape that drifts, and the
// cost of drift here is scoring the wrong sites with ~$224 already spent.
// ---------------------------------------------------------------------------

describe("docs/benchmarks/m6-floor-cases.json matches §2.4septies", () => {
  test("every row of the canonical table is re-derived and compared", async () => {
    const design = await Bun.file(DESIGN_PATH).text();
    const cases = parseFloorCases(await Bun.file(CASES_PATH).text());

    const start = design.indexOf("| # | PR to review | site | type |");
    expect(start).toBeGreaterThan(0);
    // Stop at the table's own end — the doc carries several tables below this
    // one, and a filter over the whole tail would silently scoop them in.
    const table: string[] = [];
    for (const line of design.slice(start).split("\n")) {
      if (!line.startsWith("|")) break;
      table.push(line);
    }
    const rows = table.filter((l) => /^\| \d+ \|/.test(l));
    expect(rows).toHaveLength(cases.length);

    const derived = rows.map((row) => {
      const cells = row.split("|").map((c) => c.trim());
      // | # | PR | site | type | what |  →  cells[1..5]
      const site = (cells[3] ?? "").replace(/`/g, "");
      const at = site.lastIndexOf(":");
      const [startLine, endLine] = site.slice(at + 1).split("-") as string[];
      return {
        id: Number(cells[1]),
        pr: Number((cells[2] ?? "").replace(/\*/g, "")),
        path: site.slice(0, at),
        start_line: Number(startLine),
        end_line: Number(endLine ?? startLine),
        type: (cells[4] ?? "").startsWith("corpus") ? "corpus" : "miss",
      };
    });

    expect(derived).toEqual(
      cases.map((c) => ({
        id: c.id,
        pr: c.pr,
        path: c.path,
        start_line: c.start_line,
        end_line: c.end_line,
        type: c.type,
      })),
    );
  });

  test("the corpus cases' fix PRs are the ones the table names", async () => {
    const design = await Bun.file(DESIGN_PATH).text();
    const cases = parseFloorCases(await Bun.file(CASES_PATH).text());
    for (const c of cases) {
      if (c.type !== "corpus") continue;
      expect(design).toContain(`corpus (fix ${c.fix_pr})`);
    }
  });
});

describe("d3 benchmark scorer hooks", () => {
  test("offline scorer excludes invalid runs from the promotion metrics", async () => {
    const { scoreBenchmarkRuns, validateBenchmarkPlan } = await import(
      "../../src/diversity/benchmark"
    );
    const planPath = path.join(
      import.meta.dir,
      "..",
      "..",
      "docs",
      "benchmarks",
      "d3-musive-plan.json",
    );
    const plan = validateBenchmarkPlan(
      JSON.parse(await Bun.file(planPath).text()),
    );
    expect(plan.treatmentArm.replicates).toBeGreaterThanOrEqual(3);
    const report = scoreBenchmarkRuns(
      [
        {
          runId: "invalid",
          armId: plan.treatmentArm.armId,
          replicate: 1,
          observedBuildFingerprint: "drift",
          observedPromptFingerprint: plan.promptFingerprint,
          controlCompleted: true,
          treatmentCompleted: true,
          blindingIntact: true,
          interleavingIntact: true,
          uniqueTruePositives: 3,
          recall: 1,
          cleanPrRestraint: 0,
          blindSpots: 0,
        },
        {
          runId: "valid",
          armId: plan.treatmentArm.armId,
          replicate: 2,
          observedBuildFingerprint: plan.buildFingerprint,
          observedPromptFingerprint: plan.promptFingerprint,
          controlCompleted: true,
          treatmentCompleted: true,
          blindingIntact: true,
          interleavingIntact: true,
          uniqueTruePositives: 2,
          recall: 0.5,
          cleanPrRestraint: 1,
          blindSpots: 1,
        },
      ],
      plan,
    );
    expect(report.invalidRuns).toBe(1);
    expect(report.validRuns).toBe(1);
    expect(report.recall).toBe(0.5);
    expect(report.blindSpots).toBe(1);
  });
});
