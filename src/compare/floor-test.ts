// The floor test (`docs/research/scout-design.md` §3.11): deterministic,
// per-case, no statistics.
//
// The question is binary per case: *did a run produce a refuter-corroborated
// finding at the site?* Nothing here scores quality, ranks runs, or computes a
// p-value — 13 cases cannot rank two configurations that both score well.
// Built to compare two arms of the scout stage, which was removed on
// 2026-11-16; the case list, the scorer and the tallies do not depend on it.
//
// PURE on purpose, the ../report.ts rule: no I/O, no clock, no git. The harness
// reads the run dirs and hands parsed objects in, so a scoring pass can be
// re-run from artifacts on disk months later and come out byte-identical.

import type { Finding, FindingsDocument } from "#review/findings";
import { DEFAULT_LINE_WINDOW, normalizePath } from "./compare";

// §3.11's two case types, which must not be blurred: a `miss` case reviews the
// PR where our engine missed a defect a production reviewer caught; a `corpus` case reviews
// the INTRODUCER, and `fix_pr` is provenance only.
export type FloorCaseType = "miss" | "corpus";

export interface FloorCase {
  id: number;
  pr: number;
  path: string;
  start_line: number;
  end_line: number;
  type: FloorCaseType;
  fix_pr?: number;
  what: string;
}

export class FloorCaseError extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new FloorCaseError(message);
}

// Loud, not tolerant, and deliberately unlike `parsePipelineMeta`: a malformed
// case list is not a degraded read to fall back from — it is an experiment
// about to spend ~$224 scoring the wrong sites. The fail-safe direction here is
// refusing to start.
export function parseFloorCases(raw: string): FloorCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new FloorCaseError(
      `floor cases file is not valid JSON: ${(error as Error).message}`,
    );
  }
  must(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "floor cases file must be a JSON object",
  );
  const doc = parsed as Record<string, unknown>;
  must(Array.isArray(doc.cases), "floor cases file must carry a `cases` array");
  const cases = (doc.cases as unknown[]).map((entry, i) => {
    must(
      typeof entry === "object" && entry !== null,
      `cases[${i}] must be an object`,
    );
    const c = entry as Record<string, unknown>;
    const int = (key: string): number => {
      const value = c[key];
      must(
        typeof value === "number" && Number.isInteger(value) && value > 0,
        `cases[${i}].${key} must be a positive integer`,
      );
      return value as number;
    };
    const id = int("id");
    const pr = int("pr");
    const start = int("start_line");
    const end = int("end_line");
    must(
      end >= start,
      `cases[${i}].end_line (${end}) is before start_line (${start})`,
    );
    must(
      typeof c.path === "string" && c.path.trim().length > 0,
      `cases[${i}].path required`,
    );
    // A bare filename is the failure §2.4septies's 2026-08-18 note records:
    // `normalizePath` refuses basename matching, so a short path scores as a
    // miss in every run. Cheap to check,
    // and the check is the only thing standing between a display path and a
    // silently unscorable case.
    must(
      (c.path as string).includes("/"),
      `cases[${i}].path must be repo-relative, got a bare filename: ${c.path}`,
    );
    must(
      c.type === "miss" || c.type === "corpus",
      `cases[${i}].type must be "miss" or "corpus"`,
    );
    must(
      typeof c.what === "string" && c.what.trim().length > 0,
      `cases[${i}].what required`,
    );
    must(
      c.type === "corpus"
        ? typeof c.fix_pr === "number"
        : c.fix_pr === undefined,
      `cases[${i}]: a corpus case needs fix_pr, a miss case must not carry one`,
    );
    return {
      id,
      pr,
      path: c.path as string,
      start_line: start,
      end_line: end,
      type: c.type as FloorCaseType,
      ...(c.fix_pr === undefined ? {} : { fix_pr: c.fix_pr as number }),
      what: c.what as string,
    };
  });
  const ids = new Set(cases.map((c) => c.id));
  must(ids.size === cases.length, "floor case ids must be unique");
  must(cases.length > 0, "floor cases file carries no cases");
  return cases;
}

// `compare/compare.ts`'s window, reused rather than re-chosen: the PR comparison and
// this scorer must agree on what "the same place" means, or a finding can match in one
// and count as a miss in the other at the same line.
export { DEFAULT_LINE_WINDOW };

export interface FloorHit {
  finding_id: string;
  path: string;
  line: number;
  severity: string;
  tier?: string;
  refuter_verdict: string;
}

export interface CaseScore {
  case_id: number;
  pr: number;
  type: FloorCaseType;
  // THE GATE (§3.11): a refuter-CORROBORATED finding at the site.
  hit: boolean;
  // The diagnostic beside it: any finding at the site, whatever the refuter
  // said. Reported separately and never folded into `hit`, because the gap
  // between the two is a statement about the REFUTER, and an arm that finds
  // the defect and then refutes it away has failed differently from an arm
  // that never looked. A result it cannot see cannot be attributed.
  found: boolean;
  hits: FloorHit[];
}

function atSite(
  finding: { path: string; line: number },
  floorCase: FloorCase,
  window: number,
): boolean {
  if (normalizePath(finding.path) !== normalizePath(floorCase.path))
    return false;
  return (
    finding.line >= floorCase.start_line - window &&
    finding.line <= floorCase.end_line + window
  );
}

// Scores ONE run against the cases belonging to its PR.
//
// `debug.refuted` is deliberately NOT searched. A refuter positively disproved
// a refuted finding, and §3.11's gate says corroborated — counting a refuted
// finding as a floor hit would score the run on what it SAID rather
// than on what survived scrutiny, which is the volume metric M0 already killed
// (§3.1). `debug.deduped` is likewise out: a merge loser's survivor is in
// `findings` and would double-count the same site.
export function scoreRun(
  doc: Pick<FindingsDocument, "pr" | "findings">,
  cases: FloorCase[],
  opts: { lineWindow?: number } = {},
): CaseScore[] {
  const window = opts.lineWindow ?? DEFAULT_LINE_WINDOW;
  const findings: Finding[] = Array.isArray(doc.findings) ? doc.findings : [];
  return cases
    .filter((c) => c.pr === doc.pr)
    .map((floorCase) => {
      const hits = findings
        .filter((f) => atSite(f, floorCase, window))
        .map((f) => ({
          finding_id: f.id,
          path: f.path,
          line: f.line,
          severity: f.severity,
          ...(f.tier === undefined ? {} : { tier: f.tier }),
          refuter_verdict: f.refuter_verdict,
        }));
      return {
        case_id: floorCase.id,
        pr: floorCase.pr,
        type: floorCase.type,
        hit: hits.some((h) => h.refuter_verdict === "corroborated"),
        found: hits.length > 0,
        hits,
      };
    });
}

export interface CaseTally {
  case_id: number;
  pr: number;
  type: FloorCaseType;
  // Replicates in which the gate fired, over replicates SCORED.
  hit: number;
  found: number;
  replicates: number;
}

export interface FloorTally {
  cases: CaseTally[];
  // Cases hit in AT LEAST ONE replicate. §3.11's read is per case and binary;
  // "at least one" is the recall-shaped reading, and `casesHitEvery` is stated
  // beside it because §1.3 measured six of eight replicate pairs MOVING — a
  // 1-of-2 and a 2-of-2 are different claims and the write-up must show both.
  casesHitAny: number;
  casesHitEvery: number;
  casesFoundAny: number;
  total: number;
}

export interface ScoredRun {
  scores: CaseScore[];
}

// Aggregates scored runs into one row per case.
//
// A case with ZERO scored replicates is kept with `replicates: 0` rather than
// dropped: a case nobody ran is not a case every run missed, and silently
// omitting it would turn an incomplete session into a clean-looking result. It
// counts toward `total` and toward neither hit column.
export function tallyRuns(runs: ScoredRun[], cases: FloorCase[]): FloorTally {
  const tallies: CaseTally[] = cases.map((floorCase) => {
    const scored = runs
      .flatMap((r) => r.scores)
      .filter((s) => s.case_id === floorCase.id);
    return {
      case_id: floorCase.id,
      pr: floorCase.pr,
      type: floorCase.type,
      hit: scored.filter((s) => s.hit).length,
      found: scored.filter((s) => s.found).length,
      replicates: scored.length,
    };
  });
  return {
    cases: tallies,
    casesHitAny: tallies.filter((t) => t.hit > 0).length,
    casesHitEvery: tallies.filter(
      (t) => t.replicates > 0 && t.hit === t.replicates,
    ).length,
    casesFoundAny: tallies.filter((t) => t.found > 0).length,
    total: tallies.length,
  };
}

// The floor test's whole output, as lines. A renderer, so it obeys the
// project's renderer rule: returns string[], never logs, and takes no styles
// because this table is written to a file and read in a diff, not painted.
export function renderFloorTable(
  cases: FloorCase[],
  tally: FloorTally,
): string[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const cell = (t: CaseTally | undefined): string =>
    t === undefined || t.replicates === 0
      ? "not run"
      : `${t.hit}/${t.replicates}${t.found > t.hit ? ` (found ${t.found})` : ""}`;
  const tallyById = new Map(tally.cases.map((t) => [t.case_id, t]));
  const lines = ["| # | PR | type | hit | site |", "|---|---|---|---|---|"];
  for (const c of cases) {
    const site = `${c.path}:${c.start_line}${
      c.end_line === c.start_line ? "" : `-${c.end_line}`
    }`;
    lines.push(
      `| ${c.id} | ${c.pr} | ${c.type} | ${cell(tallyById.get(c.id))} | \`${site}\` |`,
    );
  }
  lines.push("");
  lines.push(
    `${tally.casesHitAny}/${tally.total} cases hit in at least one ` +
      `replicate, ${tally.casesHitEvery} in every replicate, ` +
      `${tally.casesFoundAny} found at the site before refutation`,
  );
  // C10's blind spot, printed WITH the numbers rather than left to the prose:
  // a table this compact is exactly the kind that gets screenshotted away from
  // its caveat.
  lines.push("");
  lines.push(
    "This number cannot see a defect every run missed, and this table " +
      "cannot rank two configurations that both score well (§3.11).",
  );
  if (byId.size !== cases.length) lines.push("WARNING: duplicate case ids");
  return lines;
}
