// The hunter exam's pure half: the case bank's validator, the per-run grader,
// the N-of-M aggregation and the table. An exam case is a small repository
// with a diff whose answer is known before any model runs: `must_find` lists
// the planted defects, `must_not` lists code that looks wrong and is correct.
// A script decides from a hunter's own draft; no model judges another model.
//
// What a result means:
//   must_find fail → the hunter does not see a defect it is there to see.
//   must_not fail  → the hunter reports correct code; this is the noise side,
//                    and a prompt that only ever finds more cannot pass it.
//   undecided      → not enough graded runs; never read as a pass or a fail.
//
// Pure: no I/O, no clock.

import { normalizePath } from "#compare/compare";

export type ExamSplit = "dev" | "holdout";

// Where a case comes from:
//   synthetic   written for the exam.
//   real-fix    a real fix commit of an open-source project, reverted, alone
//               or inside a larger real commit.
//   real-intro  the real commit that introduced a defect a later commit
//               fixed, reviewed as it was: the defect belongs to the change's
//               own logic, which a reverted fix never does.
export const EXAM_ORIGINS = ["synthetic", "real-fix", "real-intro"] as const;
export type ExamOrigin = (typeof EXAM_ORIGINS)[number];

// What kind of defect it is, in a closed vocabulary, so a run can be narrowed
// to the kind a hunter is meant to see. `class` stays free text beside it.
export const EXAM_AREAS = [
  "logic",
  "state",
  "contract",
  "failure",
  "security",
  "concurrency",
  "data",
] as const;
export type ExamArea = (typeof EXAM_AREAS)[number];

// What a defect's consequence calls for, as the case author reads it:
//   blocking  on an ordinary use of the feature, data is lost or corrupted, a
//             security boundary is crossed, the operation crashes, or a wrong
//             result comes back silently.
//   advisory  only an unusual input reaches it, or it fails loudly in the
//             wrong way.
// A hunter that finds a blocking defect and reports it as a warning has not
// done the job: a warning is never checked by the refuter and never blocks.
export type ExamSeverity = "blocking" | "advisory";

// The severities of a finding that count as blocking.
const BLOCKING_SEVERITIES = ["BLOCKER", "CRITICAL"];

export interface ExamSite {
  path: string;
  start_line: number;
  end_line: number;
}

// A planted defect. `sites` is any-of: a defect that lives between two files
// can be reported at the changed line or at the line it breaks, and both are
// the same find. `depth` is how many hops outside the changed hunks a reader
// needs before the defect is visible; 0 means it shows in the hunk itself.
export interface ExamDefect {
  id: string;
  area: ExamArea;
  severity: ExamSeverity;
  class: string;
  depth: number;
  what: string;
  sites: ExamSite[];
}

// Code that invites a report and is correct. `why` records the reason, so a
// case author cannot plant a decoy they cannot defend.
export interface ExamDecoy {
  id: string;
  why: string;
  sites: ExamSite[];
}

export interface ExamCase {
  id: string;
  language: string;
  project: string;
  origin: ExamOrigin;
  split: ExamSplit;
  // Part of the small set meant for a fast check: a few cases chosen to span
  // projects, areas and depths. Everything else needs asking for.
  quick: boolean;
  must_find: ExamDefect[];
  must_not: ExamDecoy[];
}

// An entry counts as having happened when it happens in at least `n` of `m`
// graded runs. Fixed in the bank file, before the first live run.
export interface ExamThreshold {
  n: number;
  m: number;
}

export interface ExamBank {
  threshold: ExamThreshold;
  cases: ExamCase[];
}

export class ExamCaseError extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new ExamCaseError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  must(
    typeof value === "string" && value.trim().length > 0,
    `${label} required`,
  );
  return value as string;
}

function parseSites(value: unknown, label: string): ExamSite[] {
  must(
    Array.isArray(value) && value.length > 0,
    `${label}.sites must be a non-empty array`,
  );
  return (value as unknown[]).map((entry, i) => {
    must(isRecord(entry), `${label}.sites[${i}] must be an object`);
    const site = entry as Record<string, unknown>;
    const int = (key: string): number => {
      const n = site[key];
      must(
        typeof n === "number" && Number.isInteger(n) && n > 0,
        `${label}.sites[${i}].${key} must be a positive integer`,
      );
      return n as number;
    };
    const start = int("start_line");
    const end = int("end_line");
    must(
      end >= start,
      `${label}.sites[${i}].end_line (${end}) is before start_line (${start})`,
    );
    return {
      path: text(site.path, `${label}.sites[${i}].path`),
      start_line: start,
      end_line: end,
    };
  });
}

function sitesOverlap(a: ExamSite, b: ExamSite): boolean {
  return (
    normalizePath(a.path) === normalizePath(b.path) &&
    a.start_line <= b.end_line &&
    b.start_line <= a.end_line
  );
}

function parseCase(entry: unknown, index: number): ExamCase {
  const label = `cases[${index}]`;
  must(isRecord(entry), `${label} must be an object`);
  const c = entry as Record<string, unknown>;
  const id = text(c.id, `${label}.id`);
  must(
    c.split === "dev" || c.split === "holdout",
    `${label}.split must be "dev" or "holdout"`,
  );
  must(Array.isArray(c.must_find), `${label}.must_find must be an array`);
  must(Array.isArray(c.must_not), `${label}.must_not must be an array`);

  const mustFind = (c.must_find as unknown[]).map((raw, i) => {
    const at = `${label}.must_find[${i}]`;
    must(isRecord(raw), `${at} must be an object`);
    const d = raw as Record<string, unknown>;
    must(
      typeof d.depth === "number" && Number.isInteger(d.depth) && d.depth >= 0,
      `${at}.depth must be a non-negative integer`,
    );
    must(
      EXAM_AREAS.includes(d.area as ExamArea),
      `${at}.area must be one of ${EXAM_AREAS.join(", ")}`,
    );
    must(
      d.severity === "blocking" || d.severity === "advisory",
      `${at}.severity must be "blocking" or "advisory"`,
    );
    return {
      id: text(d.id, `${at}.id`),
      area: d.area as ExamArea,
      severity: d.severity as ExamSeverity,
      class: text(d.class, `${at}.class`),
      depth: d.depth as number,
      what: text(d.what, `${at}.what`),
      sites: parseSites(d.sites, at),
    };
  });
  const mustNot = (c.must_not as unknown[]).map((raw, i) => {
    const at = `${label}.must_not[${i}]`;
    must(isRecord(raw), `${at} must be an object`);
    const d = raw as Record<string, unknown>;
    return {
      id: text(d.id, `${at}.id`),
      why: text(d.why, `${at}.why`),
      sites: parseSites(d.sites, at),
    };
  });

  must(
    mustFind.length + mustNot.length > 0,
    `${label} needs at least one must_find or must_not entry`,
  );
  const entryIds = [...mustFind, ...mustNot].map((e) => e.id);
  must(
    new Set(entryIds).size === entryIds.length,
    `${label} entry ids must be unique`,
  );
  // A line that is both required and forbidden cannot be scored: one finding
  // would pass and fail the same case.
  for (const defect of mustFind) {
    for (const decoy of mustNot) {
      for (const a of defect.sites) {
        for (const b of decoy.sites) {
          must(
            !sitesOverlap(a, b),
            `${label}: ${defect.id} and ${decoy.id} overlap at ${normalizePath(a.path)}`,
          );
        }
      }
    }
  }

  must(
    EXAM_ORIGINS.includes(c.origin as ExamOrigin),
    `${label}.origin must be one of ${EXAM_ORIGINS.join(", ")}`,
  );
  must(
    c.quick === undefined || typeof c.quick === "boolean",
    `${label}.quick must be a boolean when present`,
  );
  return {
    id,
    language: text(c.language, `${label}.language`),
    project: text(c.project, `${label}.project`),
    origin: c.origin as ExamOrigin,
    split: c.split as ExamSplit,
    quick: c.quick === true,
    must_find: mustFind,
    must_not: mustNot,
  };
}

// Loud, not tolerant: a malformed bank is an exam about to spend money
// grading the wrong lines. The safe direction is refusing to start.
export function parseExamBank(raw: string): ExamBank {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExamCaseError(
      `exam bank is not valid JSON: ${(error as Error).message}`,
    );
  }
  must(isRecord(parsed), "exam bank must be a JSON object");
  const doc = parsed as Record<string, unknown>;

  must(isRecord(doc.threshold), "exam bank must carry a `threshold` object");
  const threshold = doc.threshold as Record<string, unknown>;
  const m = threshold.m;
  const n = threshold.n;
  must(
    typeof m === "number" && Number.isInteger(m) && m >= 1,
    "threshold.m must be a positive integer",
  );
  must(
    typeof n === "number" &&
      Number.isInteger(n) &&
      n >= 1 &&
      n <= (m as number),
    "threshold.n must be between 1 and threshold.m",
  );

  must(Array.isArray(doc.cases), "exam bank must carry a `cases` array");
  const cases = (doc.cases as unknown[]).map(parseCase);
  must(cases.length > 0, "exam bank carries no cases");
  must(
    new Set(cases.map((c) => c.id)).size === cases.length,
    "exam bank case ids must be unique",
  );
  return { threshold: { n: n as number, m: m as number }, cases };
}

export interface CaseSelection {
  ids?: readonly string[];
  languages?: readonly string[];
  projects?: readonly string[];
  origin?: ExamOrigin;
  // A case is kept when at least one of its defects is in one of these areas.
  areas?: readonly ExamArea[];
  // A case is kept when at least one of its defects is this deep or deeper.
  minDepth?: number;
  // Only the cases marked for a fast check.
  quick?: boolean;
  // Defaults to "dev": the holdout is only ever run by asking for it, so an
  // iteration loop cannot tune a prompt on the cases kept to confirm it.
  split?: ExamSplit;
}

export function selectCases(
  cases: readonly ExamCase[],
  selection: CaseSelection,
): ExamCase[] {
  for (const id of selection.ids ?? []) {
    must(
      cases.some((c) => c.id === id),
      `unknown case id: ${id}`,
    );
  }
  const split = selection.split ?? "dev";
  const { areas, minDepth } = selection;
  return cases.filter(
    (c) =>
      c.split === split &&
      (selection.ids === undefined || selection.ids.includes(c.id)) &&
      (selection.languages === undefined ||
        selection.languages.includes(c.language)) &&
      (selection.projects === undefined ||
        selection.projects.includes(c.project)) &&
      (selection.origin === undefined || c.origin === selection.origin) &&
      (selection.quick !== true || c.quick) &&
      (areas === undefined ||
        c.must_find.some((d) => areas.includes(d.area))) &&
      (minDepth === undefined || c.must_find.some((d) => d.depth >= minDepth)),
  );
}

// ---------------------------------------------------------------------------
// One run: one hunter's draft against one case.
// ---------------------------------------------------------------------------

// The part of a draft finding the grader reads. Structural on purpose: the
// claim's wording never decides, only where the finding points.
export interface ExamFinding {
  path: string;
  line: number;
  severity?: string;
}

export interface RunGrade {
  status: "graded";
  findings: number;
  found: string[];
  missed: string[];
  // Blocking defects that were found, but by no finding of blocking severity.
  underrated: string[];
  flagged: string[];
  // Findings on no listed site. Counted and shown, never gated: the case
  // author cannot enumerate every true thing about a repository.
  extras: number;
}

// A run that delivered no usable draft (timeout, quota, malformed output). It
// says nothing about the hunter, so it is not a miss and not a clean run.
export interface RunInfraError {
  status: "infra_error";
  reason: string;
}

export type ExamReplicate = RunGrade | RunInfraError;

function onSite(finding: ExamFinding, sites: readonly ExamSite[]): boolean {
  const path = normalizePath(finding.path);
  return sites.some(
    (site) =>
      normalizePath(site.path) === path &&
      finding.line >= site.start_line &&
      finding.line <= site.end_line,
  );
}

export function gradeRun(
  examCase: ExamCase,
  findings: readonly ExamFinding[],
): RunGrade {
  const found = examCase.must_find
    .filter((d) => findings.some((f) => onSite(f, d.sites)))
    .map((d) => d.id);
  const flagged = examCase.must_not
    .filter((d) => findings.some((f) => onSite(f, d.sites)))
    .map((d) => d.id);
  const listed = [...examCase.must_find, ...examCase.must_not].flatMap(
    (e) => e.sites,
  );
  return {
    status: "graded",
    findings: findings.length,
    found,
    missed: examCase.must_find
      .filter((d) => !found.includes(d.id))
      .map((d) => d.id),
    underrated: examCase.must_find
      .filter(
        (d) =>
          d.severity === "blocking" &&
          found.includes(d.id) &&
          !findings.some(
            (f) =>
              onSite(f, d.sites) &&
              BLOCKING_SEVERITIES.includes(f.severity ?? ""),
          ),
      )
      .map((d) => d.id),
    flagged,
    extras: findings.filter((f) => !onSite(f, listed)).length,
  };
}

// ---------------------------------------------------------------------------
// Replicates of one case, N of M.
// ---------------------------------------------------------------------------

export type ExamVerdict = "pass" | "fail" | "undecided";

export interface EntryResult {
  id: string;
  hits: number;
  // Graded runs only; an infrastructure error is not a run.
  runs: number;
  verdict: ExamVerdict;
}

export interface CaseResult {
  id: string;
  verdict: ExamVerdict;
  // True once more replicates cannot change the verdict, so a runner can stop
  // buying them. A failed case is decided even if other entries are open.
  decided: boolean;
  must_find: EntryResult[];
  must_not: EntryResult[];
  // Blocking defects only: runs in which the defect was found AND rated
  // blocking. Reported beside the verdict, not part of it: the severity
  // ladder the hunters work from is itself under redesign.
  rated: EntryResult[];
  // One entry per graded run, never averaged: run-to-run variance is the
  // thing a reader needs to see.
  extras: number[];
  infra_errors: number;
}

// "Happened" means at least n of m graded runs. It is settled early when the
// hits already reach n, or when the runs still owed cannot reach it.
function happened(
  hits: number,
  graded: number,
  threshold: ExamThreshold,
): boolean | undefined {
  if (hits >= threshold.n) return true;
  const remaining = Math.max(0, threshold.m - graded);
  if (hits + remaining < threshold.n) return false;
  return undefined;
}

export function aggregateCase(
  examCase: ExamCase,
  replicates: readonly ExamReplicate[],
  threshold: ExamThreshold,
): CaseResult {
  const graded = replicates.filter((r): r is RunGrade => r.status === "graded");
  const entry = (id: string, hits: number, wanted: boolean): EntryResult => {
    const outcome = happened(hits, graded.length, threshold);
    return {
      id,
      hits,
      runs: graded.length,
      verdict:
        outcome === undefined
          ? "undecided"
          : outcome === wanted
            ? "pass"
            : "fail",
    };
  };
  const mustFind = examCase.must_find.map((d) =>
    entry(d.id, graded.filter((r) => r.found.includes(d.id)).length, true),
  );
  const mustNot = examCase.must_not.map((d) =>
    entry(d.id, graded.filter((r) => r.flagged.includes(d.id)).length, false),
  );
  const entries = [...mustFind, ...mustNot];
  const verdict: ExamVerdict = entries.some((e) => e.verdict === "fail")
    ? "fail"
    : entries.every((e) => e.verdict === "pass")
      ? "pass"
      : "undecided";
  return {
    id: examCase.id,
    verdict,
    decided: verdict !== "undecided",
    must_find: mustFind,
    must_not: mustNot,
    rated: examCase.must_find
      .filter((d) => d.severity === "blocking")
      .map((d) =>
        entry(
          d.id,
          graded.filter(
            (r) => r.found.includes(d.id) && !r.underrated.includes(d.id),
          ).length,
          true,
        ),
      ),
    extras: graded.map((r) => r.extras),
    infra_errors: replicates.length - graded.length,
  };
}

// ---------------------------------------------------------------------------
// One hunter over the selected cases.
// ---------------------------------------------------------------------------

export interface FoundCount {
  found: number;
  total: number;
}

export interface ExamTally {
  cases: { pass: number; fail: number; undecided: number };
  defects: FoundCount;
  // Blocking defects found and rated blocking.
  rated: FoundCount;
  decoys: { flagged: number; total: number };
  // Where a hunter stops seeing: the same counts split by how far outside
  // the hunk the defect sits, and by defect class.
  by_depth: Record<string, FoundCount>;
  by_area: Record<string, FoundCount>;
  by_class: Record<string, FoundCount>;
}

function bump(
  table: Record<string, FoundCount>,
  key: string,
  found: boolean,
): void {
  const row = table[key] ?? { found: 0, total: 0 };
  row.total += 1;
  if (found) row.found += 1;
  table[key] = row;
}

export function tallyExam(
  cases: readonly ExamCase[],
  results: readonly CaseResult[],
): ExamTally {
  const tally: ExamTally = {
    cases: { pass: 0, fail: 0, undecided: 0 },
    defects: { found: 0, total: 0 },
    rated: { found: 0, total: 0 },
    decoys: { flagged: 0, total: 0 },
    by_depth: {},
    by_area: {},
    by_class: {},
  };
  for (const result of results) {
    const examCase = cases.find((c) => c.id === result.id);
    must(examCase !== undefined, `result for an unknown case: ${result.id}`);
    tally.cases[result.verdict] += 1;
    for (const entry of result.must_find) {
      const defect = examCase?.must_find.find((d) => d.id === entry.id);
      must(defect !== undefined, `result for an unknown defect: ${entry.id}`);
      const found = entry.verdict === "pass";
      tally.defects.total += 1;
      if (found) tally.defects.found += 1;
      bump(tally.by_depth, String(defect?.depth), found);
      bump(tally.by_area, defect?.area ?? "", found);
      bump(tally.by_class, defect?.class ?? "", found);
    }
    for (const entry of result.rated) {
      tally.rated.total += 1;
      if (entry.verdict === "pass") tally.rated.found += 1;
    }
    for (const entry of result.must_not) {
      tally.decoys.total += 1;
      if (entry.verdict === "fail") tally.decoys.flagged += 1;
    }
  }
  return tally;
}

function counts(table: Record<string, FoundCount>): string {
  return Object.keys(table)
    .sort()
    .map((key) => `${key}: ${table[key]?.found}/${table[key]?.total}`)
    .join(", ");
}

function entryCells(entries: readonly EntryResult[]): string {
  if (entries.length === 0) return "none";
  return entries.map((e) => `${e.id} ${e.hits}/${e.runs}`).join(", ");
}

// Counts, never percentages: with a few dozen cases a percentage hides more
// than it shows.
export function renderExamTable(
  hunter: string,
  tally: ExamTally,
  results: readonly CaseResult[],
): string[] {
  return [
    `hunter ${hunter}: defects found ${tally.defects.found}/${tally.defects.total}, ` +
      `blocking ones rated blocking ${tally.rated.found}/${tally.rated.total}, ` +
      `decoys flagged ${tally.decoys.flagged}/${tally.decoys.total}, ` +
      `cases ${tally.cases.pass} pass, ${tally.cases.fail} fail, ` +
      `${tally.cases.undecided} undecided`,
    `by depth: ${counts(tally.by_depth) || "none"}`,
    `by area: ${counts(tally.by_area) || "none"}`,
    "",
    "| case | verdict | found (hits/runs) | rated blocking (hits/runs) | flagged (hits/runs) | extras per run | infra errors |",
    "|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.verdict} | ${entryCells(r.must_find)} | ` +
        `${entryCells(r.rated)} | ` +
        `${entryCells(r.must_not)} | ${r.extras.join(" · ") || "none"} | ` +
        `${r.infra_errors} |`,
    ),
  ];
}
