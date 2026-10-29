// M6's harness (ROADMAP-DOORDASH M6, `docs/scout-design.md` §3.11): the floor
// test, both arms, over the 13 canonical cases plus the clean pair.
//
// Three modes, and the first two are deliberately separate commands:
//
//   bun run scripts/m6.ts plan   [--clean 1720,1721]   # $0 — the go/no-go
//   bun run scripts/m6.ts check                        # $0 — the argv, dry-run
//   bun run scripts/m6.ts run    [--clean ...] [--replicates 2] [--only 1717]
//   bun run scripts/m6.ts score  [--runs <root>]        # $0 — read artifacts
//
// RUN `check` BEFORE `run`, every time. It is the same loop with --dry-run
// appended, so it spends nothing, touches nothing, and prints the exact run
// dir each review would resolve. It exists because the first live pilot died
// five minutes in on a defect `check` would have shown for free: `--out` in PR
// mode is the EXACT run dir, not a runs root, so a harness passing one root
// for every review had all twelve runs overwriting each other in place.
//
// `plan` spends nothing and exists because "~$224" was folklore: it prices
// every PR from GitHub's own counters through the SAME `estimateCost` the CLI
// prints before a confirm, and it names the PRs the size gate would refuse
// before a session discovers them one at a time, four minutes apart.
//
// `run` is the only paid one. It spawns the REAL CLI per review — not
// runPipeline directly — because M6 must measure the pipeline an operator
// gets, including its preflight, its exclusions and its gate. Arms are
// INTERLEAVED per PR (control, scout, control, scout) rather than run as two
// blocks: models drift over a four-hour session, and two blocks would confound
// that drift with the arm.
//
// It always passes --no-post. These are merged PRs on a real repository, and
// "never passing --post" stopped being enough the day `post` became a config
// key: an operator whose ~/.prhero/config.json says `post: true` would have
// had every review here comment on a merged musive PR (`resolvePost` reads
// the flag first, then the config). Only an explicit --no-post outranks it.

import path from "node:path";
import {
  armOfRun,
  type CleanRun,
  type FloorCase,
  parseFloorCases,
  renderCleanTable,
  renderFloorTable,
  type ScoredRun,
  scoreRun,
  scoutFailed,
  tallyArm,
  tallyCleanPrs,
} from "#compare/floor-test";
import { resolvePrTarget } from "#pr/preflight";
import {
  EMPTY_LOCAL_CONFIG,
  localReviewSpec,
  parseLocalConfig,
  resolveSummary,
} from "#review/preflight";
import { estimateCost } from "#review/report";
import { evaluateSizeGateAggregate, sizeGateConfig } from "#review/size-gate";
import { resolveRepoDir } from "../src/brand-paths";

const CASES_PATH = path.join(
  import.meta.dir,
  "..",
  "docs",
  "benchmarks",
  "m6-floor-cases.json",
);
// The musive checkout the reviews run against, and the one the control set was
// produced from (`docs/scout-design.md` §1.2).
const DEFAULT_REPO = "/Users/juanma/Desktop/musive/musive-s3";
// ONE runs root for every M6 run, which is how §3.11's cross-root ledger
// problem stops applying to the new data: the three frozen roots stay the
// hand-cited variance third point and nothing new lands beside them.
const DEFAULT_RUNS_ROOT = path.join(
  process.env.HOME ?? "",
  "Desktop",
  "musive",
  "musive-m6-runs",
);

function fail(message: string): never {
  console.error(`m6: ${message}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const at = Bun.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : Bun.argv[at + 1];
}

const mode = Bun.argv[2];
if (mode !== "plan" && mode !== "check" && mode !== "run" && mode !== "score") {
  fail("usage: bun run scripts/m6.ts plan|check|run|score [flags]");
}

const repo = arg("repo") ?? DEFAULT_REPO;
const runsRoot = arg("runs") ?? DEFAULT_RUNS_ROOT;
const replicates = Number(arg("replicates") ?? 2);
if (!Number.isInteger(replicates) || replicates < 1) {
  fail("--replicates must be a positive integer");
}
// §3.11's clean pair, and it is NOT optional garnish: the floor test only
// looks at known-bad PRs, so without these nothing measures whether the scout
// makes the pipeline louder on code where the control is quiet — the one thing
// a "bias, never filter" design is most likely to get wrong.
const cleanPrs = (arg("clean") ?? "1720,1721")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const cases: FloorCase[] = parseFloorCases(await Bun.file(CASES_PATH).text());
const casePrs = [...new Set(cases.map((c) => c.pr))].sort((a, b) => a - b);
const onlyRaw = arg("only");
const only = onlyRaw
  ? onlyRaw.split(",").map((s) => Number(s.trim()))
  : undefined;
const prs = [...casePrs, ...cleanPrs].filter(
  (pr) => only === undefined || only.includes(pr),
);

// ---------------------------------------------------------------------------
// plan — $0
// ---------------------------------------------------------------------------

async function ghPrStat(
  pr: number,
): Promise<ReturnType<typeof resolvePrTarget>> {
  const proc = Bun.spawn(
    [
      "gh",
      "pr",
      "view",
      String(pr),
      "--json",
      "number,title,state,headRefOid,baseRefName,baseRefOid,mergeCommit," +
        "additions,deletions,changedFiles",
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) fail(`gh pr view ${pr} failed: ${stderr.trim()}`);
  return resolvePrTarget(stdout);
}

if (mode === "plan") {
  // READ the target repo's own config rather than assuming the engine's
  // defaults. musive disables the summarizer and configures no parity
  // triggers, so an assumed default-on summarizer would over-price all 56 runs
  // by a full agent seat — and a pricing pass whose whole job is to replace
  // folklore with a number must not import folklore of its own.
  // .crysk/ since the rename, .prhero/ in a repo set up before it (same rule as the engine).
  const configPath = path.join(resolveRepoDir(repo), "config.json");
  const config = (await Bun.file(configPath).exists())
    ? parseLocalConfig(await Bun.file(configPath).text())
    : EMPTY_LOCAL_CONFIG;
  const summary = resolveSummary({}, config);
  // The conditional parity hunter fires only when a changed path matches a
  // configured trigger; with none configured it never fires at all, and
  // pricing a step that cannot run is the same lie in the other direction.
  //
  // `?? []` is not defensive style, it is C5: parseLocalConfig returns a
  // ConfigLayer and no longer materialises the two array keys, so a target
  // repo whose config OMITS parity_trigger_paths hands back `undefined` here.
  // Unguarded this threw a TypeError — and `scripts/` is covered by neither
  // `bun run typecheck` nor `bun run check`, so no offline gate would have
  // caught it. The engine merges layers before its resolvers see a config;
  // this script deliberately does not (design §4), so the guard is its own.
  const HUNTERS = localReviewSpec().agents.filter(
    (a) =>
      a.role === "hunter" &&
      (a.trigger === undefined ||
        (config.parity_trigger_paths ?? []).length > 0),
  ).length;
  const gate = sizeGateConfig({});
  const rows: string[] = [
    "| PR | state | files | +/− | gate (estimated) | control | scout |",
    "|---|---|---|---|---|---|---|",
  ];
  let lowTotal = 0;
  let highTotal = 0;
  const refused: number[] = [];
  for (const pr of prs) {
    const target = await ghPrStat(pr);
    const stat = target.ghDiffStat;
    const control = estimateCost(stat, HUNTERS, summary.enabled, false);
    const scout = estimateCost(stat, HUNTERS, summary.enabled, true);
    const verdict = evaluateSizeGateAggregate(stat, gate);
    if (!verdict.ok) refused.push(pr);
    lowTotal += (control.low + scout.low) * replicates;
    highTotal += (control.high + scout.high) * replicates;
    rows.push(
      `| ${pr} | ${target.state} | ${stat.files} | ` +
        `+${stat.insertions} −${stat.deletions} | ` +
        `${verdict.ok ? "passes" : `REFUSED (${verdict.reason})`} | ` +
        `$${control.low.toFixed(2)}–${control.high.toFixed(2)} | ` +
        `$${scout.low.toFixed(2)}–${scout.high.toFixed(2)} |`,
    );
  }
  console.log(rows.join("\n"));
  console.log("");
  console.log(
    `${prs.length} PRs x 2 arms x R=${replicates} = ${prs.length * 2 * replicates} runs`,
  );
  console.log(
    `estimated total: $${lowTotal.toFixed(2)}–$${highTotal.toFixed(2)} ` +
      `(band, never a quote — the same tree has billed 34% apart across runs)`,
  );
  // Wall clock is §3.11's stated real constraint, not the dollars.
  const minutes = prs.length * 2 * replicates * 4;
  console.log(
    `serial wall clock at ~4 min/run: ~${Math.round(minutes / 60)}h ${minutes % 60}m`,
  );
  console.log("");
  console.log(
    "The gate column is ESTIMATED from GitHub's aggregate counters: no per-file " +
      "paths, so no exclusions, and GitHub's numbers carry no whitespace " +
      "information. It is wrong only in the conservative direction.",
  );
  if (refused.length > 0) {
    console.log(
      `SIZE GATE would refuse: ${refused.join(", ")} — each needs --force or ` +
        "an explicit exclusion, decided per case BEFORE the session, never " +
        "discovered one at a time four minutes apart.",
    );
  }
  console.log(
    `priced from ${configPath}: ${HUNTERS} hunter(s) + refuter` +
      `${summary.enabled ? " + summarizer" : ", summarizer disabled"}` +
      `${
        // Same C5 guard as the HUNTERS count above, and it has to be the same
        // answer: a line that priced two hunters while printing "parity never
        // fires" would be the pricing pass contradicting itself.
        (config.parity_trigger_paths ?? []).length === 0
          ? ", parity hunter never fires (no triggers configured)"
          : ""
      }.`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// run — the paid one
// ---------------------------------------------------------------------------

// `--out` in PR mode names the EXACT run dir (`predictPrRunDir`: an explicit
// --out short-circuits the smallest-unused-integer loop and is returned as-is).
// So every review needs its OWN, or each overwrites the last — and overwriting
// a run that cost money is precisely what that integer loop exists to prevent.
//
// The arm is in the NAME for a human reading the directory; it is never what
// `score` trusts, which reads `pipeline.json`'s `scout.enabled`. A name and an
// artifact that disagree is a bug worth being able to see.
function runDirFor(pr: number, scout: boolean, replicate: number): string {
  return path.join(
    runsRoot,
    `pr-${pr}-${scout ? "scout" : "control"}-r${replicate}`,
  );
}

async function review(
  pr: number,
  scout: boolean,
  replicate: number,
  dryRun = false,
): Promise<number> {
  const argv = [
    process.execPath,
    path.join(import.meta.dir, "..", "src", "cli.ts"),
    "review",
    "--pr",
    String(pr),
    "--yes",
    "--no-post",
    "--out",
    runDirFor(pr, scout, replicate),
    ...(dryRun ? ["--dry-run"] : []),
    // NO --force, and that is a measured choice rather than an omission: the
    // `plan` pass estimated the gate over all 14 PRs from GitHub's own
    // counters and none is refused. That estimate is wrong only in the
    // conservative direction — it can refuse where the real git-side gate
    // passes, never the reverse — so a passing estimate proves the real gate
    // passes too, and forcing would weaken a live gate for nothing.
    ...(scout ? ["--scout"] : []),
  ];
  const proc = Bun.spawn(argv, {
    cwd: repo,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

if (mode === "check") {
  // $0. The same argv the paid loop builds, with --dry-run appended: a PR-mode
  // dry run fetches nothing, creates nothing and spends nothing, but it does
  // resolve the PR, the base, the gate and the run dir — and prints them. Every
  // assumption the harness makes about the CLI is checked here or discovered
  // four minutes at a time with money on the meter.
  const seen = new Set<string>();
  let clashes = 0;
  for (let r = 1; r <= replicates; r++) {
    for (const pr of prs) {
      for (const scout of [false, true]) {
        const dir = runDirFor(pr, scout, r);
        if (seen.has(dir)) {
          console.error(`COLLISION: two reviews would write ${dir}`);
          clashes++;
        }
        seen.add(dir);
      }
    }
  }
  console.error(
    `${seen.size} distinct run dir(s) for ${prs.length * 2 * replicates} reviews`,
  );
  // Only the first replicate is dry-run for real: the CLI's answer does not
  // change per replicate, and a check that costs 56 gh round-trips is a check
  // nobody runs before the session.
  const failures: string[] = [];
  for (const pr of prs) {
    for (const scout of [false, true]) {
      const label = `pr ${pr} ${scout ? "scout" : "control"}`;
      console.error(`\n=== ${label} (dry run)`);
      const code = await review(pr, scout, 1, true);
      if (code !== 0) failures.push(`${label}: exit ${code}`);
    }
  }
  console.error("");
  if (clashes === 0 && failures.length === 0) {
    console.error(
      "m6 check: every review resolves, every run dir is distinct, $0 spent. " +
        "Read the RUN line of each plan above and confirm it names a dir " +
        "UNDER the runs root, not the root itself.",
    );
    process.exit(0);
  }
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

if (mode === "run") {
  console.error(
    `m6 run: ${prs.length} PRs x 2 arms x R=${replicates} = ` +
      `${prs.length * 2 * replicates} runs into ${runsRoot}`,
  );
  const failures: string[] = [];
  let skipped = 0;
  for (let r = 1; r <= replicates; r++) {
    for (const pr of prs) {
      // INTERLEAVED per PR: two blocks would confound a four-hour session's
      // model drift with the arm under test.
      for (const scout of [false, true]) {
        const label = `pr ${pr} ${scout ? "scout" : "control"} r${r}`;
        const dir = runDirFor(pr, scout, r);
        // Resumable, and loudly: a five-hour session that dies at run 40 must
        // not re-bill the 39 that landed. An existing dir is evidence, never
        // something to overwrite.
        if (await Bun.file(path.join(dir, "findings.json")).exists()) {
          console.error(`\n=== ${label} — SKIPPED, already on disk at ${dir}`);
          skipped++;
          continue;
        }
        console.error(`\n=== ${label} -> ${dir}`);
        const code = await review(pr, scout, r);
        if (code !== 0) {
          failures.push(`${label}: exit ${code}`);
          continue;
        }
        // EXIT 0 IS NOT PROOF A REVIEW RAN, and the pilot proved it: a stale
        // in-flight commit status left by an aborted run makes `--yes` print
        // "skip: a pr-hero review is already in-flight on this head" and
        // return 0. So does an empty effective diff, and so does a size-gate
        // skip. Every one of those is a HOLE in the arm — a case with one
        // fewer replicate than the table will claim — and every one of them
        // looks like success to an exit code. The artifact is the proof.
        if (!(await Bun.file(path.join(dir, "findings.json")).exists())) {
          failures.push(
            `${label}: exited 0 but wrote no findings.json — the review was ` +
              "SKIPPED (stale in-flight status, empty diff, or the size gate), " +
              "and this replicate is missing from the arm",
          );
        }
      }
    }
  }
  console.error("");
  if (skipped > 0) {
    console.error(`m6 run: ${skipped} review(s) skipped — already on disk`);
  }
  if (failures.length === 0) {
    console.error("m6 run: every review exited 0");
  } else {
    console.error(`m6 run: ${failures.length} non-zero exit(s):`);
    for (const f of failures) console.error(`  ${f}`);
  }
  console.error(
    "Now: bun run scripts/m6.ts score — and re-run any excluded scout-arm run " +
      "it names (§3.6) before reading the table.",
  );
  console.error(
    "NOTE: every review posts a `pr-hero` commit status (pending, then " +
      "success/error) on the PR head, as the operator's own GitHub account. " +
      "That is the engine's normal production behaviour, not something the " +
      "harness adds — but on merged PRs it is a visible mark on someone " +
      "else's closed work, and an ABORTED run leaves a `pending` that blocks " +
      "the next attempt on that head for 90 minutes.",
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// score — $0, and re-runnable from artifacts forever
// ---------------------------------------------------------------------------

// A missing runs root after a five-hour session must not surface as a raw
// ENOENT with a NUL in the path. It means one of two ordinary things — the
// session has not run, or --runs points somewhere else — and both are worth
// saying in words.
if (!(await Bun.file(path.join(runsRoot, ".")).exists())) {
  const probe = Bun.spawnSync(["test", "-d", runsRoot]);
  if (probe.exitCode !== 0) {
    fail(
      `no runs root at ${runsRoot} — run \`bun run scripts/m6.ts run\` first, ` +
        "or point --runs at the root that holds the M6 artifacts",
    );
  }
}

const dirs: string[] = [];
for await (const entry of new Bun.Glob("*/").scan({
  cwd: runsRoot,
  onlyFiles: false,
})) {
  dirs.push(entry.replace(/\/$/, ""));
}
dirs.sort();
const scored: ScoredRun[] = [];
const cleanRuns: CleanRun[] = [];
const excluded: string[] = [];
const unreadable: string[] = [];
for (const dir of dirs) {
  const full = path.join(runsRoot, dir);
  const planFile = Bun.file(path.join(full, "pipeline.json"));
  const docFile = Bun.file(path.join(full, "findings.json"));
  if (!(await planFile.exists()) || !(await docFile.exists())) {
    unreadable.push(`${dir}: missing pipeline.json or findings.json`);
    continue;
  }
  const plan: unknown = await planFile.json();
  const arm = armOfRun(plan);
  if (arm === null) {
    // Never guessed: a run whose artifact cannot name its arm is from another
    // engine build, and putting it in the arm it resembles is how a control
    // arm quietly acquires a stranger.
    unreadable.push(`${dir}: pipeline.json cannot name its arm`);
    continue;
  }
  if (scoutFailed(plan)) {
    excluded.push(dir);
    continue;
  }
  const doc = (await docFile.json()) as {
    pr: number;
    findings: Array<{ refuter_verdict?: string }>;
    debug?: { root_causes?: { distinct_root_causes?: number } };
  };
  if (doc.pr === undefined) {
    unreadable.push(`${dir}: findings.json carries no pr`);
    continue;
  }
  if (cleanPrs.includes(doc.pr)) {
    const causes = doc.debug?.root_causes?.distinct_root_causes;
    cleanRuns.push({
      arm,
      pr: doc.pr,
      findings: doc.findings.length,
      corroborated: doc.findings.filter(
        (f) => f.refuter_verdict === "corroborated",
      ).length,
      ...(typeof causes === "number" ? { rootCauses: causes } : {}),
    });
    continue;
  }
  scored.push({
    arm,
    scores: scoreRun(
      doc as unknown as { pr: number; findings: never[] },
      cases,
    ),
  });
}

console.log(
  renderFloorTable(
    cases,
    tallyArm("scout", scored, cases),
    tallyArm("control", scored, cases),
  ).join("\n"),
);
console.log("");
console.log(`${scored.length} run(s) scored from ${runsRoot}`);
if (excluded.length > 0) {
  console.log(
    `EXCLUDED, §3.6 — the scout failed, so these are control-arm runs wearing ` +
      `a scout-arm flag and must be RE-RUN before the table is read: ` +
      excluded.join(", "),
  );
}
for (const problem of unreadable) console.log(`skipped ${problem}`);
if (cleanRuns.length > 0) {
  console.log("");
  console.log("## The clean pair (§3.11)");
  console.log("");
  console.log(renderCleanTable(tallyCleanPrs(cleanRuns, cleanPrs)).join("\n"));
} else if (cleanPrs.length > 0) {
  console.log("");
  console.log(
    `no clean-pair runs found for ${cleanPrs.join(", ")} — the floor test ` +
      "alone leaves pipeline-level restraint unmeasured, which is the one " +
      "thing a bias-never-filter design is most likely to get wrong (§3.11).",
  );
}
