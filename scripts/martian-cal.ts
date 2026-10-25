// Martian offline harness, one corpus at a time (`docs/martian-bench.md`).
// `--corpus cal` (default) is the Cal.com slice; sentry, grafana, keycloak and
// discourse are the other forty PRs (case files from scripts/martian-cases.ts).
//
//   bun run scripts/martian-cal.ts plan    # $0 — size gate + cost band
//   bun run scripts/martian-cal.ts check   # $0 — fetch SHAs, dry-run the CLI
//   bun run scripts/martian-cal.ts run     # LIVE — default: the 3-PR pilot
//   bun run scripts/martian-cal.ts score   # $0 — findings vs goldens, no judge
//
// Local mode, never `--pr`: PR mode posts a commit status on the head, and
// these are other people's merged PRs. `--two-dot` because the PRs are merged
// (`main...head` is empty) and because a shallow fetch of two SHAs may not
// contain the merge-base. Isolation is the engine's; this harness never
// passes GitHub comments to hunters.
//
// Default is the 3-PR pilot (14943, 8330, 8087). `--all` is the ten.
// One pipeline: hunters, scout off, summarizer off, parity never fires.

import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  findingsToMartianReview,
  lookupGolden,
  type MartianGoldenPr,
  prNumberFromUrl,
} from "#compare/martian-adapter";
import type { FindingsDocument } from "#review/findings";
import { localReviewSpec } from "#review/preflight";
import { estimateCost } from "#review/report";
import {
  DEFAULT_SIZE_GATE,
  evaluateSizeGateAggregate,
} from "#review/size-gate";
import { writeJsonAtomically } from "../src/execution/atomic-write";
import {
  BENCH_HOME,
  type CaseRow,
  type CasesFile,
  CORPORA,
  corpusDocsFile,
} from "./martian-corpora";
import {
  type BenchmarkSchedule,
  freezeBenchmarkIdentity,
  loadBenchmarkSchedule,
  loadQualifiedReview,
} from "./martian-evidence";

const DEFAULT_LAB_AGENTS_DIR =
  "/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v6-clean";

const ROOT = path.join(import.meta.dir, "..");
// Display/cost only (never affects which agents actually run — that is
// localReviewSpec() itself, resolved fresh per CLI subprocess in review()
// below). Derived rather than a hand-maintained literal so an unconditional
// hunter added to the wiring — including PRHERO_EXTRA_HUNTERS
// (odd/tasks/logic-hunter.md T3) — is reflected in the estimate without a
// second place to remember to update. Excludes the parity hunter: its
// trigger never matches for Cal.com PRs (comment below), matching
// martian-evidence.ts's freezeBenchmarkIdentity requiredSteps derivation.
const HUNTERS = localReviewSpec().agents.filter(
  (a) => a.role === "hunter" && a.trigger === undefined,
).length;

function fail(message: string): never {
  console.error(`martian-cal: ${message}`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = Bun.argv[i + 1];
  if (value === undefined || value.startsWith("-")) {
    fail(`${flag} needs a value`);
  }
  return value;
}

const mode = Bun.argv[2];
if (mode !== "plan" && mode !== "check" && mode !== "run" && mode !== "score") {
  fail(
    "usage: bun run scripts/martian-cal.ts plan|check|run|score [--corpus cal|sentry|grafana|keycloak|discourse] [--all] [--only 14943,8330] [--arm <id>] [--model <logical>] [--hunter-model <l>] [--refuter-model <l>] [--repo …] [--runs …]",
  );
}

const corpusName = argValue("--corpus") ?? "cal";
const corpus = CORPORA[corpusName];
if (corpus === undefined) {
  fail(`--corpus must be one of ${Object.keys(CORPORA).join(", ")}`);
}
const CASES_PATH = corpusDocsFile(corpusName, "cases.json");
const GOLDENS_PATH = corpusDocsFile(corpusName, "goldens.json");
const GOTCHAS_PATH = corpusDocsFile(corpusName, "gotchas.md");
const DEFAULT_REPO = path.join(BENCH_HOME, corpus.clone);
const DEFAULT_RUNS = path.join(BENCH_HOME, corpus.runs);
const cases = (await Bun.file(CASES_PATH).json()) as CasesFile;
const goldens = (await Bun.file(GOLDENS_PATH).json()) as MartianGoldenPr[];
const repo = argValue("--repo") ?? DEFAULT_REPO;
const runsRoot = argValue("--runs") ?? DEFAULT_RUNS;
const onlyRaw = argValue("--only");
const all = Bun.argv.includes("--all");
// New methodology arm (one variable vs the `hunters` baseline): the arm id is
// the run-dir suffix (`<corpus>-<pr>-<arm>`). Default keeps the frozen baseline
// dirs byte-for-byte addressable. `run` skips dirs that already hold
// findings.json, so a new arm never overwrites the baseline.
const arm = argValue("--arm") ?? "hunters";
// A new prompt set is a new arm: `--agents` points at a copy of the scored set
// plus the variable under test. The default stays the frozen baseline set.
const LAB_AGENTS_DIR = argValue("--agents") ?? DEFAULT_LAB_AGENTS_DIR;
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(arm)) {
  fail(`--arm must match [a-zA-Z0-9_-]+, got: ${arm}`);
}
// Logical-model override for the arm (CLI --model precedence: flag > spec >
// frontmatter). Lets an arm name a working route without touching the
// operator's global routing config — e.g. --model opus resolves through the
// global opus mapping (opencode/glm-5.3-flash#high) while frontmatter says
// sonnet. Empty = frontmatter (the `hunters` baseline shape).
const model = argValue("--model");
// Per-role models (--hunter-model / --refuter-model set AgentSpec.model per
// role). Lets one arm split hunters and refuter across two routes with the
// prompt set byte-identical.
const hunterModel = argValue("--hunter-model");
const refuterModel = argValue("--refuter-model");

function parseOnly(raw: string): number[] {
  return raw.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n <= 0) fail(`bad --only value: ${s}`);
    return n;
  });
}

const selected = all
  ? cases.prs.map((p) => p.pr)
  : onlyRaw
    ? parseOnly(onlyRaw)
    : cases.pilot;

const rows: CaseRow[] = selected.map((pr) => {
  const row = cases.prs.find((p) => p.pr === pr);
  if (row === undefined) fail(`PR ${pr} is not in ${CASES_PATH}`);
  lookupGolden(goldens, pr);
  return row;
});

function runDirFor(pr: number): string {
  return path.join(runsRoot, `${corpusName}-${pr}-${arm}`);
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

async function ensureShas(row: CaseRow): Promise<void> {
  if (!existsSync(path.join(repo, ".git"))) {
    if (!corpus.shallow) {
      fail(
        `no clone at ${repo} — clone ${corpus.upstream} (blobless is fine) into that path`,
      );
    }
    await mkdir(repo, { recursive: true });
    const init = git(["init", "--quiet"]);
    if (!init.ok) fail(`git init ${repo} failed: ${init.stderr.trim()}`);
  }
  const have = git(["cat-file", "-t", row.headSha]);
  const haveBase = git(["cat-file", "-t", row.baseSha]);
  if (have.ok && haveBase.ok) return;
  // --two-dot only needs both commits, so a shallow corpus never pulls the
  // history of Sentry, Grafana or Keycloak.
  const fetched = git([
    "fetch",
    "--filter=blob:none",
    ...(corpus.shallow ? ["--depth=1"] : []),
    row.remote ?? (corpus.shallow ? corpus.upstream : "origin"),
    row.baseSha,
    row.headSha,
  ]);
  if (!fetched.ok) {
    fail(`git fetch ${row.pr} failed: ${fetched.stderr.trim()}`);
  }
}

async function checkoutHead(row: CaseRow): Promise<void> {
  await ensureShas(row);
  const co = git(["checkout", "--detach", "--force", row.headSha]);
  if (!co.ok) fail(`git checkout ${row.headSha} failed: ${co.stderr.trim()}`);
  const head = git(["rev-parse", "HEAD"]);
  if (head.stdout.trim() !== row.headSha) {
    fail(`HEAD ${head.stdout.trim()} != ${row.headSha}`);
  }
}

async function review(
  row: CaseRow,
  dryRun: boolean,
  outputDir = runDirFor(row.pr),
): Promise<number> {
  await checkoutHead(row);
  const argv = [
    process.execPath,
    path.join(ROOT, "src", "cli.ts"),
    "review",
    "--repo",
    repo,
    "--base",
    row.baseSha,
    "--head",
    row.headSha,
    "--two-dot",
    "--yes",
    "--no-summary",
    "--agents",
    LAB_AGENTS_DIR,
    ...(model === undefined ? [] : ["--model", model]),
    ...(hunterModel === undefined ? [] : ["--hunter-model", hunterModel]),
    ...(refuterModel === undefined ? [] : ["--refuter-model", refuterModel]),
    // The shipped size gate, not the operator config: a benchmark scores what
    // dev ships, and a laptop that lowered max_changed_lines would silently
    // drop PRs every vendor reviewed (Sentry #5, 3195 effective lines).
    "--max-changed-lines",
    String(DEFAULT_SIZE_GATE.maxChangedLines),
    "--max-changed-files",
    String(DEFAULT_SIZE_GATE.maxChangedFiles),
    "--gotchas",
    GOTCHAS_PATH,
    "--out",
    outputDir,
    ...(dryRun ? ["--dry-run"] : []),
  ];
  const proc = Bun.spawn(argv, {
    cwd: ROOT,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

if (mode === "plan") {
  const gate = DEFAULT_SIZE_GATE;
  console.log(
    "pr   files   +/−      lines  gate   gold  band (3 hunters, no summary, no scout)",
  );
  console.log(
    "---- ----- --------  ------  -----  ----  ---------------------------------------",
  );
  let low = 0;
  let high = 0;
  const refused: number[] = [];
  for (const row of rows) {
    const lines = row.additions + row.deletions;
    const verdict = evaluateSizeGateAggregate(
      {
        files: row.changedFiles,
        insertions: row.additions,
        deletions: row.deletions,
      },
      gate,
    );
    const estimate = estimateCost(
      {
        files: row.changedFiles,
        insertions: row.additions,
        deletions: row.deletions,
      },
      HUNTERS,
      false,
      false,
    );
    const golden = lookupGolden(goldens, row.pr);
    low += estimate.low;
    high += estimate.high;
    if (!verdict.ok) refused.push(row.pr);
    console.log(
      `${String(row.pr).padStart(5)} ${String(row.changedFiles).padStart(5)} ` +
        `${String(row.additions).padStart(4)}/${String(row.deletions).padStart(4)} ` +
        `${String(lines).padStart(6)}  ${verdict.ok ? "ok   " : "SKIP "} ` +
        `${String(golden.comments.length).padStart(4)}  ` +
        `$${estimate.low.toFixed(2)}–$${estimate.high.toFixed(2)}  ${row.title}`,
    );
  }
  console.log("");
  console.log(
    `${rows.length} PR(s). Estimated ${HUNTERS} hunters + refuter, summarizer off, scout off, parity never fires.`,
  );
  console.log(`arm: ${arm}  (run dirs: cal-<pr>-${arm})`);
  console.log(
    `model: ${model ?? "(frontmatter)"}  (CLI --model precedence over frontmatter)`,
  );
  console.log(
    `role models: hunters ${hunterModel ?? "(frontmatter)"} / refuter ${refuterModel ?? "(frontmatter)"}`,
  );
  console.log(`band sum: $${low.toFixed(2)}–$${high.toFixed(2)}`);
  console.log(
    "Gate column is GitHub aggregate counters (no exclusions, no whitespace). Conservative.",
  );
  console.log(`clone: ${repo}`);
  console.log(`runs:  ${runsRoot}`);
  console.log(
    "NEVER --pr: that path posts a commit status on the head. These are other people's PRs.",
  );
  if (refused.length > 0) {
    console.log(`SIZE GATE would refuse: ${refused.join(", ")}`);
  }
  process.exit(0);
}

if (mode === "check") {
  const seen = new Set<string>();
  for (const row of rows) {
    const dir = runDirFor(row.pr);
    if (seen.has(dir)) fail(`COLLISION: ${dir}`);
    seen.add(dir);
    if (!dir.startsWith(runsRoot)) fail(`run dir not under runs root: ${dir}`);
  }
  const failures: string[] = [];
  for (const row of rows) {
    console.error(`\n=== ${corpusName} ${row.pr} (dry run)`);
    const code = await review(row, true);
    if (code !== 0) failures.push(`pr ${row.pr}: exit ${code}`);
  }
  if (failures.length === 0) {
    console.error(
      `\nmartian-cal check: ${rows.length} dry-run(s) ok, $0 spent. ` +
        "Read RUN in each plan and confirm it is under the runs root, not the root itself.",
    );
    process.exit(0);
  }
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

if (mode === "run") {
  console.error(
    `martian-cal run: ${rows.length} PR(s), pipeline hunters, arm ${arm}, model ${model ?? "(frontmatter)"}, hunters ${hunterModel ?? "(frontmatter)"}, refuter ${refuterModel ?? "(frontmatter)"}, into ${runsRoot}`,
  );
  const reps = Number(argValue("--reps") ?? "1");
  if (!Number.isInteger(reps) || reps < 1 || reps > 100)
    fail("--reps must be 1..100");
  await mkdir(runsRoot, { recursive: true });
  const expectedAttempts = rows.flatMap((row) =>
    Array.from({ length: reps }, (_, i) => ({
      id: `${arm}:${row.pr}:${i + 1}`,
      pr: row.pr,
      replicate: i + 1,
      directory: `${corpusName}-${row.pr}-${arm}${reps === 1 ? "" : `-r${i + 1}`}`,
      headSha: row.headSha,
      baseSha: row.baseSha,
    })),
  );
  let schedule: BenchmarkSchedule = {
    schemaVersion: 1,
    arm,
    attempts: expectedAttempts,
  };
  if (existsSync(path.join(runsRoot, `schedule-${arm}.json`))) {
    schedule = await loadBenchmarkSchedule(runsRoot, arm);
    if (
      JSON.stringify(
        schedule.attempts.map(({ identity: _, ...attempt }) => attempt),
      ) !== JSON.stringify(expectedAttempts)
    )
      fail("selected attempts differ from frozen schedule; use a new arm");
  } else
    await writeJsonAtomically(
      path.join(runsRoot, `schedule-${arm}.json`),
      schedule,
    );
  const failures: string[] = [];
  let skipped = 0;
  for (const attempt of schedule.attempts) {
    const row = rows.find((r) => r.pr === attempt.pr);
    if (!row) continue;
    const dir = path.join(runsRoot, attempt.directory);
    const label = `${corpusName} ${row.pr} replicate ${attempt.replicate}`;
    await checkoutHead(row);
    const identity = await freezeBenchmarkIdentity({
      engineRoot: ROOT,
      repo,
      agentsDir: LAB_AGENTS_DIR,
      gotchasPath: GOTCHAS_PATH,
      pr: row.pr,
      headSha: row.headSha,
      baseSha: row.baseSha,
      model,
      hunterModel,
      refuterModel,
    });
    const previous = await loadQualifiedReview(dir, identity);
    if (previous.qualified) {
      attempt.identity = identity;
      await writeJsonAtomically(
        path.join(runsRoot, `schedule-${arm}.json`),
        schedule,
      );
      console.error(
        `\n=== ${label} — SKIPPED, verified matching attempt at ${dir}`,
      );
      skipped++;
      continue;
    }
    if (existsSync(dir)) {
      const quarantine = path.join(runsRoot, "incomplete-attempts");
      await mkdir(quarantine, { recursive: true });
      await rename(
        dir,
        path.join(
          quarantine,
          `${attempt.directory}-${Date.now()}-${crypto.randomUUID()}`,
        ),
      );
    }
    attempt.identity = identity;
    await writeJsonAtomically(
      path.join(runsRoot, `schedule-${arm}.json`),
      schedule,
    );
    await mkdir(dir, { recursive: true });
    await writeJsonAtomically(path.join(dir, "run-identity.json"), identity);
    console.error(`\n=== ${label} -> ${dir}`);
    const code = await review(row, false, dir);
    if (code !== 0) {
      failures.push(`${label}: exit ${code}`);
      continue;
    }
    const qualified = await loadQualifiedReview(dir, identity);
    if (!qualified.qualified || !qualified.doc) {
      failures.push(
        `${label}: exited 0 but is unqualified: ${qualified.reason}`,
      );
      continue;
    }
    const golden = lookupGolden(goldens, row.pr);
    const overlay = findingsToMartianReview({
      prUrl: golden.url,
      findings: qualified.doc.findings,
    });
    await writeJsonAtomically(path.join(dir, "martian-review.json"), overlay);
  }
  if (skipped > 0) {
    console.error(`martian-cal run: ${skipped} skipped — already on disk`);
  }
  if (failures.length === 0) {
    console.error(
      "martian-cal run: every scheduled review has verified matching completion",
    );
  } else {
    console.error(`martian-cal run: ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ${f}`);
  }
  console.error("Now: bun run scripts/martian-cal.ts score");
  process.exit(failures.length === 0 ? 0 : 1);
}

if (!existsSync(runsRoot)) {
  fail(
    `no runs root at ${runsRoot} — run \`bun run scripts/martian-cal.ts run\` first`,
  );
}

console.log(
  "Surface A without their LLM judge: juxtaposition only. Do not quote precision/recall from this output.",
);
console.log("");
for (const row of rows) {
  const dir = runDirFor(row.pr);
  const findingsPath = path.join(dir, "findings.json");
  const golden = lookupGolden(goldens, row.pr);
  console.log(`## PR ${row.pr} — ${row.title}`);
  console.log(golden.url);
  if (!(await Bun.file(findingsPath).exists())) {
    console.log("  (no findings.json — this PR has not been run)");
    console.log("");
    continue;
  }
  const doc = (await Bun.file(findingsPath).json()) as FindingsDocument;
  console.log(
    `  cost $${doc.telemetry.cost_usd_est.toFixed(2)}  findings ${doc.findings.length}  status ${doc.run_status}`,
  );
  console.log("  goldens:");
  for (const g of golden.comments) {
    console.log(`    [${g.severity}/${g.category}] ${g.comment.slice(0, 140)}`);
  }
  console.log("  pr-hero:");
  if (doc.findings.length === 0) {
    console.log("    (none)");
  }
  for (const f of doc.findings) {
    console.log(
      `    ${f.id} ${f.tier} ${f.path}:${f.line}  ${f.claim.slice(0, 140)}`,
    );
  }
  console.log("");
}

const knownUrls = new Set(goldens.map((g) => g.url));
for (const g of goldens) {
  prNumberFromUrl(g.url);
}
if (knownUrls.size !== goldens.length) fail("duplicate golden URLs");
process.exit(0);
