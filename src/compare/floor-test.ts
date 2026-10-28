// M6's PRIMARY instrument (ROADMAP-DOORDASH M6, `docs/scout-design.md` §3.11):
// the floor test. Deterministic, per-case, no statistics.
//
// The question is binary per case: *did this arm produce a refuter-corroborated
// finding at the site?* Nothing here scores quality, ranks arms, or computes a
// p-value — §3.11 states up front that 13 cases cannot rank two arms that both
// score well, and an instrument that pretended otherwise would be the third
// thing this milestone had to throw away (§3.10bis killed the second).
//
// PURE on purpose, the ../report.ts rule: no I/O, no clock, no git. The harness
// reads the run dirs and hands parsed objects in, so a scoring pass can be
// re-run from artifacts on disk months later and come out byte-identical.

import type { Finding, FindingsDocument } from "#review/findings";
import { DEFAULT_LINE_WINDOW, normalizePath } from "./compare";

// §3.11's two case types, and M6 must not blur them: a `miss` case reviews the
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
    // miss by BOTH arms and reads as evidence about the scout. Cheap to check,
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

export type FloorArm = "scout" | "control";

// Which arm a run belongs to, read from the ARTIFACT and never from a
// directory name or a harness variable — pipeline.json's `scout.enabled` is
// the field M5 built for exactly this, written on every run including the ones
// with no scout at all.
//
// `null` means the artifact cannot say, which is not the same as "control": a
// run from before M5, or a corrupt plan, must be excluded from the read rather
// than silently counted as the arm it happens to resemble.
export function armOfRun(plan: unknown): FloorArm | null {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return null;
  }
  const scout = (plan as Record<string, unknown>).scout;
  if (typeof scout !== "object" || scout === null) return null;
  const enabled = (scout as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") return null;
  return enabled ? "scout" : "control";
}

export function diversityArmOfRun(
  plan: unknown,
): "diversity" | "control" | null {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return null;
  }
  const diversity = (plan as Record<string, unknown>).multiModelDiversity;
  if (typeof diversity !== "object" || diversity === null) return null;
  const enabled = (diversity as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") return null;
  return enabled ? "diversity" : "control";
}

// §3.6's exclusion rule, as a predicate: a scout-arm run whose scout FAILED is
// a control-arm run wearing a scout-arm flag. Counting it would dilute the arm
// with its own control, which is the exact way an A/B lies quietly. The harness
// re-runs these; the scorer refuses to score them.
export function scoutFailed(plan: unknown): boolean {
  if (typeof plan !== "object" || plan === null) return false;
  const scout = (plan as Record<string, unknown>).scout;
  if (typeof scout !== "object" || scout === null) return false;
  const record = scout as Record<string, unknown>;
  return record.enabled === true && record.status !== "ok";
}

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
  // that never looked. M6 cannot attribute a result it cannot see.
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
// `debug.refuted` is deliberately NOT searched. A refuted finding is one the
// refuter positively disproved, and §3.11's gate says corroborated — counting
// a refuted finding as a floor hit would score the arm on what it SAID rather
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

export interface ArmTally {
  arm: FloorArm;
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
  arm: FloorArm;
  scores: CaseScore[];
}

// Aggregates scored runs into one row per case per arm.
//
// A case with ZERO scored replicates in an arm is kept with `replicates: 0`
// rather than dropped: a case nobody ran is not a case both arms missed, and
// silently omitting it would turn an incomplete session into a clean-looking
// result. It counts toward `total` and toward neither hit column.
export function tallyArm(
  arm: FloorArm,
  runs: ScoredRun[],
  cases: FloorCase[],
): ArmTally {
  const mine = runs.filter((r) => r.arm === arm);
  const tallies: CaseTally[] = cases.map((floorCase) => {
    const scored = mine
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
    arm,
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
  scout: ArmTally,
  control: ArmTally,
): string[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const cell = (t: CaseTally | undefined): string =>
    t === undefined || t.replicates === 0
      ? "not run"
      : `${t.hit}/${t.replicates}${t.found > t.hit ? ` (found ${t.found})` : ""}`;
  const scoutById = new Map(scout.cases.map((t) => [t.case_id, t]));
  const controlById = new Map(control.cases.map((t) => [t.case_id, t]));
  const lines = [
    "| # | PR | type | control | scout | site |",
    "|---|---|---|---|---|---|",
  ];
  for (const c of cases) {
    const site = `${c.path}:${c.start_line}${
      c.end_line === c.start_line ? "" : `-${c.end_line}`
    }`;
    lines.push(
      `| ${c.id} | ${c.pr} | ${c.type} | ${cell(controlById.get(c.id))} | ` +
        `${cell(scoutById.get(c.id))} | \`${site}\` |`,
    );
  }
  lines.push("");
  lines.push(
    `control: ${control.casesHitAny}/${control.total} cases hit in at least one ` +
      `replicate, ${control.casesHitEvery} in every replicate, ` +
      `${control.casesFoundAny} found at the site before refutation`,
  );
  lines.push(
    `scout:   ${scout.casesHitAny}/${scout.total} cases hit in at least one ` +
      `replicate, ${scout.casesHitEvery} in every replicate, ` +
      `${scout.casesFoundAny} found at the site before refutation`,
  );
  // C10's blind spot, printed WITH the numbers rather than left to the prose:
  // a table this compact is exactly the kind that gets screenshotted away from
  // its caveat.
  lines.push("");
  lines.push(
    "Neither arm's number can see a defect BOTH arms missed, and this table " +
      "cannot rank two arms that both score well (§3.11). It can say `drop` " +
      "loudly; it cannot distinguish `adopt` from `opt-in`.",
  );
  if (byId.size !== cases.length) lines.push("WARNING: duplicate case ids");
  return lines;
}

// ---------------------------------------------------------------------------
// The clean pair (§3.11), which is NOT optional garnish.
//
// The floor test only looks at known-bad PRs, so nothing in it can see the
// failure a "bias, never filter" design is most likely to produce: hunters
// chasing spurious leads into junk findings on code where the control is
// quiet. M4's restraint gate measured the SCOUT's lead volume, not that
// downstream effect, and Tier 2's precision guard runs only on known-bad PRs,
// so neither instrument covers it either.
//
// §3.11's read is one number — *does the scout arm produce MORE findings than
// the control on a PR where the control produces few?* — and it is the one
// place this project sanctions a raw count, because the comparison is between
// arms on the same PR rather than an absolute claim about quality. C1's rule
// still applies to how it is READ, so the distinct-root-cause count is
// reported beside the raw one: one systemic defect reported at N call sites is
// one finding fanned out, and reading it as N is exactly how a correct review
// scores as a precision collapse.
// ---------------------------------------------------------------------------

export interface CleanRun {
  arm: FloorArm;
  pr: number;
  findings: number;
  // Findings the refuter corroborated — the ones that would actually reach a
  // human as blocking.
  corroborated: number;
  // `debug.root_causes.distinct_root_causes` when the artifact carries it.
  // Absent on runs that predate the clusterer, and absent is not zero.
  rootCauses?: number;
}

export interface CleanArmStat {
  runs: number;
  findings: number[];
  corroborated: number[];
  rootCauses: Array<number | undefined>;
}

export interface CleanTally {
  pr: number;
  control: CleanArmStat;
  scout: CleanArmStat;
}

function cleanArmStat(runs: CleanRun[]): CleanArmStat {
  return {
    runs: runs.length,
    findings: runs.map((r) => r.findings),
    corroborated: runs.map((r) => r.corroborated),
    rootCauses: runs.map((r) => r.rootCauses),
  };
}

export function tallyCleanPrs(runs: CleanRun[], prs: number[]): CleanTally[] {
  return prs.map((pr) => {
    const mine = runs.filter((r) => r.pr === pr);
    return {
      pr,
      control: cleanArmStat(mine.filter((r) => r.arm === "control")),
      scout: cleanArmStat(mine.filter((r) => r.arm === "scout")),
    };
  });
}

// Every replicate is listed, never averaged into one number. §1.3 measured six
// of eight same-head replicate pairs MOVING, with deltas as large as the whole
// effect the scout is expected to produce — so a mean over two runs would hide
// exactly the variance that decides whether any of this is readable.
function cleanCell(stat: CleanArmStat): string {
  if (stat.runs === 0) return "not run";
  return stat.findings
    .map((n, i) => {
      const corroborated = stat.corroborated[i] ?? 0;
      const causes = stat.rootCauses[i];
      return `${n} (${corroborated} corr${
        causes === undefined
          ? ""
          : `, ${causes} cause${causes === 1 ? "" : "s"}`
      })`;
    })
    .join(" · ");
}

export function renderCleanTable(tallies: CleanTally[]): string[] {
  const lines = [
    "| PR | control | scout |",
    "|---|---|---|",
    ...tallies.map(
      (t) => `| ${t.pr} | ${cleanCell(t.control)} | ${cleanCell(t.scout)} |`,
    ),
    "",
    "Findings per run, one entry per replicate, never averaged (§1.3: six of " +
      "eight same-head replicate pairs MOVED, by as much as the whole effect " +
      "the scout is expected to produce). `corr` is refuter-corroborated; " +
      "`causes` is distinct root causes, because one systemic defect at N call " +
      "sites is one finding fanned out (C1).",
    "The question here is RELATIVE and between arms on the same PR: does the " +
      "scout arm produce MORE than the control where the control is quiet? It " +
      "is not a claim that these PRs are defect-free — their `prhero_only` " +
      "rows were never triaged (§2.4).",
  ];
  return lines;
}
