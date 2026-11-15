// Hunter exam: planted-defect cases with known answers, graded by a script
// from each hunter's own draft. Local only; built to be run in a loop by an
// agent that edits one hunter's prompt and needs a verdict it can read.
//
//   bun run benchmarks/hunter-exam/exam.ts plan  --hunter logic
//   bun run benchmarks/hunter-exam/exam.ts run   --hunter logic [--case <id,..>]
//   bun run benchmarks/hunter-exam/exam.ts score --hunter logic
//
//   plan   $0. Which runs are already stored and which would be bought.
//   run    LIVE for whatever is not stored: one model call per run, on the
//          hunter's production model and effort. Lands in the lab ledger the
//          day it runs.
//   score  $0. Grades stored runs only; use it after editing an answer key.
//
// Options
//   --hunter <key[,key]|all>  required. A hunter of the local spec, or
//                             key:file.md for a candidate under --agents.
//   --agents <dir>            prompt set to examine (default: the bundled set).
//   Narrowing the cases (all optional, all combine):
//   --quick                   the small set meant for a fast check.
//   --area <a,..>             logic, state, contract, failure, security,
//                             concurrency, data: cases with a defect there.
//   --min-depth <n>           cases with a defect at least this far outside
//                             the changed lines.
//   --project <p,..> --lang <l,..> --case <id,..>
//   --origin synthetic|real-fix|real-intro
//   --split dev|holdout       the holdout runs only when asked for.
//   --failed-from <report>    only the cases that did not pass in that report.
//   --fresh                   ignore stored runs and buy new ones.
//   --no-early-stop           run all m replicates even once a case is settled.
//   --runs <n>                at most n runs per case in this invocation, fewer
//                             than the threshold's m. One run per case is
//                             enough to calibrate the bank itself (are the
//                             keys placed right, which cases are too easy);
//                             such cases stay undecided, by design.
//   --concurrency <n>         cases in flight (default 2).
//   --max-usd <x>             stop buying runs once this much was spent.
//   --bank <dir>              a directory of cases to use besides the sample
//                             in this repository. The bank is kept outside
//                             the repository: link it once as
//                             <the exam's folder>/bank and it is found
//                             without this option.
//   --home <dir>              the one folder everything goes to (default
//                             ~/.crysk/casebank, or CRYSK_CASEBANK_HOME).
//   --out <dir>               this invocation's report folder, when it has to
//                             live elsewhere (a ledger entry, for example).
//
//   exam.ts list [narrowing]  $0. The catalogue: each case with its project,
//                             language, origin, areas, depth and quick mark.
//   exam.ts check [narrowing] $0. Builds each case and checks its key, its
//                             message and its proof record.
//   exam.ts build --case <id> --to <dir>
//                             $0. Builds one case's repository (base and
//                             head commits) into <dir>, to prove a case by
//                             running code against the tree a hunter reads.
//   exam.ts where             $0. Prints that folder and what each part holds.
//   exam.ts clean [--all]     Deletes what can be downloaded again (repos,
//                             deps, work). --all also deletes the stored runs
//                             and reports, which were paid for.
//
// What keeps it cheap: a run is stored under the identity of its request, so
// an unchanged prompt on an unchanged case is never paid for twice; a case
// stops as soon as more replicates cannot change its verdict; and one diff
// carries several defects and decoys.
//
// Exit code: 0 every selected case passed, 1 a case failed, 2 no failure but
// a case is undecided (missing runs or infrastructure errors).

import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  aggregateCase,
  type CaseResult,
  type CaseSelection,
  EXAM_AREAS,
  EXAM_ORIGINS,
  type ExamArea,
  type ExamCase,
  type ExamOrigin,
  type ExamReplicate,
  type ExamSplit,
  renderExamTable,
  selectCases,
  tallyExam,
} from "#compare/hunter-exam";
import type { AgentSpec } from "#review/spec";
import {
  BUNDLED_AGENTS_DIR,
  caseDir,
  caseRoots,
  checkCase,
  examDirs,
  examHome,
  gradeRecord,
  loadBank,
  materializeCase,
  type RunRecord,
  removeTree,
  renderRequest,
  resolveHunter,
  runHunterOnCase,
  sweepWork,
} from "./run-case";

const ALWAYS_ON = ["reliability", "resilience", "logic"];
// A run that delivered nothing is retried in place, this many times per case.
const INFRA_RETRIES = 2;

const argv = Bun.argv.slice(2);
const command = argv[0];
function value(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}
function list(name: string): string[] | undefined {
  return value(name)
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}
function usage(message: string): never {
  console.error(
    `${message}\nusage: exam.ts plan|run|score --hunter <key[,key]|all> [options] | list | check | where | clean [--all]`,
  );
  process.exit(64);
}

// Before anything resolves a case: both are read through the environment.
if (value("--home") !== undefined) {
  process.env.CRYSK_CASEBANK_HOME = path.resolve(value("--home") as string);
}
if (value("--bank") !== undefined) {
  process.env.CRYSK_CASEBANK_CASES = [
    process.env.CRYSK_CASEBANK_CASES,
    path.resolve(value("--bank") as string),
  ]
    .filter((root) => root !== undefined && root !== "")
    .join(":");
}
const home = examHome();
const dirs = examDirs(home);
await sweepWork(dirs.work);

if (command === "where" || command === "clean") {
  const size = async (dir: string): Promise<string> => {
    const proc = Bun.spawn(["du", "-sh", dir], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? (out.split("\t")[0] ?? "").trim() : "-";
  };
  if (command === "clean") {
    const doomed = argv.includes("--all")
      ? Object.values(dirs)
      : [dirs.repos, dirs.deps, dirs.work];
    for (const dir of doomed) {
      await rm(dir, { recursive: true, force: true });
      console.log(`removed ${dir}`);
    }
  }
  console.log(home);
  console.log(`cases are read from: ${caseRoots().join(", ")}`);
  const holds: Record<keyof typeof dirs, string> = {
    runs: "stored runs, paid for",
    reports: "report.json and run artifacts, one folder per invocation",
    repos: "mirrors of the repositories cases are built on",
    deps: "dependencies installed to run a case's proof",
    work: "checkouts in use; empty when nothing is running",
  };
  for (const key of Object.keys(dirs) as Array<keyof typeof dirs>) {
    console.log(
      `  ${key.padEnd(8)} ${(await size(dirs[key])).padEnd(6)} ${holds[key]}`,
    );
  }
  process.exit(0);
}

const split = value("--split");
if (split !== undefined && split !== "dev" && split !== "holdout") {
  usage(`--split must be dev or holdout, got ${split}`);
}
const origin = value("--origin");
if (origin !== undefined && !EXAM_ORIGINS.includes(origin as ExamOrigin)) {
  usage(`--origin must be one of ${EXAM_ORIGINS.join(", ")}, got ${origin}`);
}
const areas = list("--area");
for (const area of areas ?? []) {
  if (!EXAM_AREAS.includes(area as ExamArea)) {
    usage(`--area must be one of ${EXAM_AREAS.join(", ")}, got ${area}`);
  }
}
const bank = await loadBank();
const narrowing: CaseSelection = {
  ...(list("--lang") !== undefined ? { languages: list("--lang") } : {}),
  ...(list("--project") !== undefined ? { projects: list("--project") } : {}),
  ...(origin !== undefined ? { origin: origin as ExamOrigin } : {}),
  ...(areas !== undefined ? { areas: areas as ExamArea[] } : {}),
  ...(argv.includes("--min-depth")
    ? { minDepth: numberOption("--min-depth", 0, { min: 0, integer: true }) }
    : {}),
  ...(argv.includes("--quick") ? { quick: true } : {}),
  ...(split !== undefined ? { split: split as ExamSplit } : {}),
};

if (command === "build") {
  const id = value("--case");
  const to = value("--to");
  if (id === undefined || to === undefined)
    usage("build needs --case and --to");
  const built = await materializeCase(caseDir(id));
  try {
    await rename(built.repoDir, path.resolve(to));
  } finally {
    await removeTree(built.tmp);
  }
  console.log(
    JSON.stringify({
      dir: path.resolve(to),
      base: built.baseSha,
      head: built.headSha,
    }),
  );
  process.exit(0);
}

if (command === "list" || command === "check") {
  const listed = selectCases(bank.cases, {
    ...narrowing,
    ...(list("--case") !== undefined ? { ids: list("--case") } : {}),
  });
  if (command === "list") {
    console.log(
      "| case | project | lang | origin | areas | depth | look-alikes | quick |",
    );
    console.log("|---|---|---|---|---|---|---|---|");
    for (const c of listed) {
      console.log(
        `| ${c.id} | ${c.project} | ${c.language} | ${c.origin} | ` +
          `${[...new Set(c.must_find.map((d) => d.area))].join(", ") || "none"} | ` +
          `${c.must_find.map((d) => d.depth).join(", ") || "-"} | ` +
          `${c.must_not.length} | ${c.quick ? "yes" : ""} |`,
      );
    }
    console.log(`\n${listed.length} case(s)`);
    process.exit(0);
  }
  if (listed.length === 0) usage("no case matches this selection");
  let problems = 0;
  for (const c of listed) {
    const found = await checkCase(c);
    for (const problem of found) console.log(`${c.id}: ${problem}`);
    problems += found.length;
  }
  console.log(`${listed.length} case(s) checked, ${problems} problem(s)`);
  process.exit(problems === 0 ? 0 : 1);
}

if (command !== "plan" && command !== "run" && command !== "score") {
  usage(`unknown command: ${command ?? "(none)"}`);
}
const hunterArgs = list("--hunter");
if (hunterArgs === undefined || hunterArgs.length === 0) {
  usage("--hunter is required: the exam never runs every hunter by default");
}
const hunters: AgentSpec[] = (
  hunterArgs.includes("all") ? ALWAYS_ON : hunterArgs
).map(resolveHunter);
const agentsDir = path.resolve(value("--agents") ?? BUNDLED_AGENTS_DIR);
const cacheDir = dirs.runs;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(value("--out") ?? path.join(dirs.reports, stamp));
const fresh = argv.includes("--fresh");
const earlyStop = !argv.includes("--no-early-stop");
const runsArg = Number(value("--runs") ?? Number.NaN);
if (argv.includes("--runs") && !(Number.isInteger(runsArg) && runsArg >= 1)) {
  usage("--runs must be a positive integer");
}
// A numeric option that is present must parse. `--max-usd --fresh` used to
// read "--fresh" as the amount: NaN, and `spent >= NaN` is never true, so the
// cap silently never tripped on a command that buys live model calls.
function numberOption(
  name: string,
  fallback: number,
  rule: { min: number; integer: boolean },
): number {
  if (!argv.includes(name)) return fallback;
  const parsed = Number(value(name) ?? Number.NaN);
  if (
    !Number.isFinite(parsed) ||
    parsed < rule.min ||
    (rule.integer && !Number.isInteger(parsed))
  ) {
    usage(
      `${name} must be ${rule.integer ? "a whole number" : "a number"}, ${rule.min} or more`,
    );
  }
  return parsed;
}
const concurrency = numberOption("--concurrency", 2, { min: 1, integer: true });
const maxUsd = numberOption("--max-usd", Number.POSITIVE_INFINITY, {
  min: 0,
  integer: false,
});

let ids = list("--case");
const failedFrom = value("--failed-from");
if (failedFrom !== undefined) {
  const previous = JSON.parse(await readFile(failedFrom, "utf8")) as {
    hunters: Array<{ cases: Array<{ id: string; verdict: string }> }>;
  };
  const failed = new Set(
    previous.hunters.flatMap((h) =>
      h.cases.filter((c) => c.verdict !== "pass").map((c) => c.id),
    ),
  );
  ids = (ids ?? [...failed]).filter((id) => failed.has(id));
}
const cases = selectCases(bank.cases, {
  ...narrowing,
  ...(ids !== undefined ? { ids } : {}),
});
// Nothing selected is not "everything passed": an agent that reads exit code
// 0 would accept a prompt that was never examined.
if (cases.length === 0) usage("no case matches this selection");

interface StoredRun extends RunRecord {
  hunter: string;
  case: string;
  replicate: number;
  model: string;
  effort: string;
  changed_lines?: number;
}

async function readSlot(
  key: string,
  replicate: number,
): Promise<StoredRun | undefined> {
  return readFile(path.join(cacheDir, key, `r${replicate}.json`), "utf8")
    .then((raw) => JSON.parse(raw) as StoredRun)
    .catch(() => undefined);
}

// Small, medium and large changes. The first estimate this exam gave priced
// 6 runs on changes of 73 to 406 lines from runs on changes of 1 to 30 lines:
// it said $0.80 and the runs cost $3.37.
function sizeBucket(changedLines: number): number {
  return changedLines <= 30 ? 0 : changedLines <= 150 ? 1 : 2;
}

// What a stored run of this hunter has cost so far, for `plan`: from runs on
// changes of a similar size when there are any (`rough` false), else from all
// of them (`rough` true). Undefined when nothing is stored: the plan then
// says so instead of guessing.
async function meanCost(
  hunter: string,
  changedLines: number,
): Promise<{ usd: number; rough: boolean } | undefined> {
  const keys = await readdir(cacheDir).catch(() => [] as string[]);
  const costs: number[] = [];
  const similar: number[] = [];
  for (const key of keys) {
    for (const file of await readdir(path.join(cacheDir, key)).catch(
      () => [] as string[],
    )) {
      // Only finished records: a file being written by a run in flight, or
      // anything else that does not parse, is not a price.
      if (!/^r\d+\.json$/.test(file)) continue;
      const run = await readFile(path.join(cacheDir, key, file), "utf8")
        .then((raw) => JSON.parse(raw) as StoredRun)
        .catch(() => undefined);
      if (run === undefined || run.hunter !== hunter) continue;
      costs.push(run.cost_usd);
      if (
        run.changed_lines !== undefined &&
        sizeBucket(run.changed_lines) === sizeBucket(changedLines)
      ) {
        similar.push(run.cost_usd);
      }
    }
  }
  const mean = (list: number[]) =>
    list.reduce((a, b) => a + b, 0) / list.length;
  if (similar.length > 0) return { usd: mean(similar), rough: false };
  if (costs.length > 0) return { usd: mean(costs), rough: true };
  return undefined;
}

let spentUsd = 0;
let bought = 0;
let reused = 0;

interface RunRow {
  replicate: number;
  status: RunRecord["status"];
  stored: boolean;
  cost_usd: number;
  wall_ms: number;
  run_dir: string;
  reason?: string;
}

interface CaseOutcome extends CaseResult {
  request_key: string;
  runs: RunRow[];
  // `plan` only: replicates not stored yet.
  to_buy: number;
  changed_lines: number;
}

async function examine(
  hunter: AgentSpec,
  examCase: ExamCase,
): Promise<CaseOutcome> {
  const dir = caseDir(examCase.id);
  const request = await renderRequest(dir, hunter, agentsDir);
  const replicates: ExamReplicate[] = [];
  const runs: RunRow[] = [];
  let infraLeft = INFRA_RETRIES;
  let toBuy = 0;
  const maxRuns = Number.isNaN(runsArg)
    ? bank.threshold.m
    : Math.min(runsArg, bank.threshold.m);
  for (let replicate = 0; replicate < maxRuns; ) {
    let record: RunRecord | undefined = fresh
      ? undefined
      : await readSlot(request.key, replicate);
    const stored = record !== undefined;
    if (record === undefined) {
      if (command !== "run") {
        toBuy = maxRuns - replicate;
        break;
      }
      if (spentUsd >= maxUsd) break;
      record = await runHunterOnCase(dir, hunter, {
        agentsDir,
        runDir: path.join(
          outDir,
          "runs",
          hunter.key,
          examCase.id,
          `r${replicate}-${runs.length}`,
        ),
      });
      spentUsd += record.cost_usd;
      bought += 1;
      if (record.status === "graded") {
        const slot: StoredRun = {
          ...record,
          hunter: hunter.key,
          case: examCase.id,
          replicate,
          model: request.model,
          effort: request.effort,
          changed_lines: request.changed_lines,
        };
        // Whole or not at all: a run killed mid-write must not leave half a
        // record where a paid-for run should be.
        await mkdir(path.join(cacheDir, request.key), { recursive: true });
        const slotPath = path.join(cacheDir, request.key, `r${replicate}.json`);
        const partial = `${slotPath}.${process.pid}.tmp`;
        await writeFile(partial, `${JSON.stringify(slot, null, 2)}\n`);
        await rename(partial, slotPath);
      }
    } else {
      reused += 1;
    }
    runs.push({
      replicate,
      status: record.status,
      stored,
      cost_usd: record.cost_usd,
      wall_ms: record.wall_ms,
      run_dir: record.run_dir,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
    });
    replicates.push(gradeRecord(examCase, record));
    if (record.status === "infra_error") {
      infraLeft -= 1;
      if (infraLeft < 0) break;
      continue;
    }
    replicate += 1;
    if (
      earlyStop &&
      aggregateCase(examCase, replicates, bank.threshold).decided
    ) {
      break;
    }
  }
  return {
    ...aggregateCase(examCase, replicates, bank.threshold),
    request_key: request.key,
    runs,
    to_buy: toBuy,
    changed_lines: request.changed_lines,
  };
}

async function pool<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index] as T);
      }
    }),
  );
  return results;
}

const report = [];
for (const hunter of hunters) {
  const outcomes = await pool(cases, concurrency, (examCase) =>
    examine(hunter, examCase),
  );
  const tally = tallyExam(cases, outcomes);
  // One row per entry that did not pass, with what the entry is and where the
  // runs are: enough for an agent to open the draft and the trace and see why.
  const failures = outcomes.flatMap((outcome) => {
    const examCase = cases.find((c) => c.id === outcome.id) as ExamCase;
    return [
      ...outcome.must_find
        .filter((e) => e.verdict !== "pass")
        .map((e) => ({ kind: "missed", entry: e })),
      ...outcome.must_not
        .filter((e) => e.verdict !== "pass")
        .map((e) => ({ kind: "flagged", entry: e })),
    ].map(({ kind, entry }) => {
      const defect = examCase.must_find.find((d) => d.id === entry.id);
      const decoy = examCase.must_not.find((d) => d.id === entry.id);
      return {
        case: outcome.id,
        entry: entry.id,
        kind,
        verdict: entry.verdict,
        hits: entry.hits,
        runs: entry.runs,
        detail: defect?.what ?? decoy?.why,
        sites: (defect ?? decoy)?.sites,
        run_dirs: outcome.runs.map((r) => r.run_dir),
      };
    });
  });
  const toBuy = outcomes.reduce((sum, o) => sum + o.to_buy, 0);
  let estimate: number | undefined = 0;
  let rough = 0;
  for (const outcome of outcomes) {
    if (outcome.to_buy === 0) continue;
    const price = await meanCost(hunter.key, outcome.changed_lines);
    if (price === undefined) {
      estimate = undefined;
      break;
    }
    estimate += outcome.to_buy * price.usd;
    if (price.rough) rough += 1;
  }
  console.log(renderExamTable(hunter.key, tally, outcomes).join("\n"));
  if (command === "plan") {
    console.log(
      `plan: ${toBuy} run(s) not stored, at most; ` +
        (estimate === undefined
          ? "no stored run of this hunter to price them from"
          : `about $${estimate.toFixed(2)}, priced from stored runs on changes of a similar size` +
            (rough > 0
              ? `; ${rough} case(s) have no such run and are priced from runs of another size, so treat this as a floor`
              : "")),
    );
  }
  console.log("");
  report.push({
    hunter: hunter.key,
    file: hunter.file,
    tally,
    cases: outcomes,
    failures,
    ...(command === "plan"
      ? { to_buy: toBuy, estimate_usd: estimate ?? null }
      : {}),
  });
}

const verdicts = report.flatMap((h) => h.cases.map((c) => c.verdict));
const exitCode = verdicts.includes("fail")
  ? 1
  : verdicts.includes("undecided")
    ? 2
    : 0;
await mkdir(outDir, { recursive: true });
const reportPath = path.join(outDir, "report.json");
await writeFile(
  reportPath,
  `${JSON.stringify(
    {
      command,
      generated_at: new Date().toISOString(),
      agents_dir: agentsDir,
      threshold: bank.threshold,
      cases: cases.map((c) => c.id),
      spent_usd: spentUsd,
      runs_bought: bought,
      runs_reused: reused,
      hunters: report,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({
    pass: exitCode === 0,
    exit_code: exitCode,
    spent_usd: Number(spentUsd.toFixed(4)),
    runs_bought: bought,
    runs_reused: reused,
    report: reportPath,
  }),
);
process.exit(exitCode);
