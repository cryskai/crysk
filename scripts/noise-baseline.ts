// Noise baseline (Stage 2 noise yardstick, step 2 — NOT a benchmark arm).
//
// Every finding the engine posted on a real PR, read from the local store
// (~/.crysk/prhero.db), labelled by the materiality judge that passed its exam
// (scripts/materiality-probe.ts). The result is the share of posted findings
// that are true but not worth posting, broken down by severity, tier, hunter,
// repo and triage tag. It is the line Stage 2's prompt changes are measured
// against.
//
// "Posted" means: a complete, non-failed PR-mode run (`runs.pr` set) in one of
// REPOS — the only runs `post` publishes (src/commands/post.ts). Refuted
// findings never reach the findings table. One item per (repo, PR, dedupe
// key), so a defect re-posted at every head counts once.
//
// Output holds private repos' finding text, so it goes outside this repo
// (default ~/Desktop/noise-baseline/<stamp>/) and into the private lab ledger,
// never into a commit here.
//
// LIVE (`run`): one judge spawn per item. `plan` and `report` are $0.
//
//   bun run scripts/noise-baseline.ts plan
//   bun run scripts/noise-baseline.ts run [--out <dir>] [--concurrency <n>]
//   bun run scripts/noise-baseline.ts report <results.json>

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { judgeSystemSha256, type MaterialityLabel } from "#compare/materiality";
import {
  dedupePostedFindings,
  type NoiseItem,
  noiseReport,
  type PostedFindingRow,
  renderNoiseReport,
} from "#compare/noise";
import { JUDGE_MODEL, judgeClaim } from "./materiality-spawn";

const STORE = path.join(homedir(), ".crysk", "prhero.db");
const REPOS = [
  "github.com/musivetech/musive",
  "github.com/juanmaagd/pr-hero",
  "github.com/juanmaagd/supermarket-pro",
];

// Where a store repo's pull requests live now. pr-hero's PRs moved with the
// repo to cryskai/crysk (same numbers); juanmaagd/pr-hero is a tags-and-
// releases mirror whose API answers 404 for them.
const PR_HOME: Record<string, string> = {
  "github.com/juanmaagd/pr-hero": "cryskai/crysk",
};

interface Judgment {
  key: string;
  label: MaterialityLabel | null;
  reason?: string;
  error?: string;
}

interface ResultsFile {
  judge_model: string;
  judge_system_sha256: string;
  started_at: string;
  finished_at: string | null;
  cost_usd_est: number;
  items: (NoiseItem & { prTitle: string })[];
  judgments: Judgment[];
}

function fail(message: string): never {
  console.error(`noise-baseline: ${message}`);
  process.exit(1);
}

function loadItems(): NoiseItem[] {
  // Not `readonly`: the store runs in WAL mode, where a read-only open cannot
  // attach the shared-memory file. Only SELECTs run here.
  const db = new Database(STORE, { readwrite: true, create: false });
  try {
    const placeholders = REPOS.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT r.repo_id AS repo, r.pr AS pr, r.id AS runId,
                f.finding_id AS findingId, f.dedupe_key AS dedupeKey,
                f.claim AS claim, f.severity AS severity, f.tier AS tier,
                f.hunter AS hunter,
                (SELECT t.tag FROM finding_triage t
                  WHERE t.run_id = f.run_id AND t.finding_id = f.finding_id
                  ORDER BY t.created_at DESC LIMIT 1) AS triageTag
           FROM findings f JOIN runs r ON r.id = f.run_id
          WHERE r.pr IS NOT NULL AND r.repo_id IN (${placeholders})
            AND r.run_status = 'complete' AND ifnull(r.session_failed, 0) = 0`,
      )
      .all(...REPOS) as PostedFindingRow[];
    return dedupePostedFindings(rows);
  } finally {
    db.close();
  }
}

async function prTitle(
  repo: string,
  pr: number,
  cache: Map<string, string>,
): Promise<string> {
  const key = `${repo}#${pr}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const slug = PR_HOME[repo] ?? repo.replace(/^github\.com\//, "");
  const proc = Bun.spawn(
    ["gh", "api", `repos/${slug}/pulls/${pr}`, "--jq", ".title"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  // A title the judge cannot have is not fatal: the claim still carries the
  // finding. Recorded as such so the report can say how many lacked one.
  const title =
    code === 0 && out.trim() !== "" ? out.trim() : "(title unavailable)";
  cache.set(key, title);
  return title;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function describe(items: NoiseItem[]): string[] {
  const count = (pick: (i: NoiseItem) => boolean) => items.filter(pick).length;
  const prs = new Set(items.map((i) => `${i.repo}#${i.pr}`)).size;
  return [
    `store:            ${STORE}`,
    `items:            ${items.length} (one per repo, PR and dedupe key) over ${prs} PRs`,
    ...REPOS.map((r) => `  ${r.padEnd(38)} ${count((i) => i.repo === r)}`),
    `judge spawns:     ${items.length}`,
    `judge model:      ${JUDGE_MODEL}  (tools [], empty MCP)`,
    `judge sha256:     ${judgeSystemSha256()}`,
  ];
}

function labelsOf(results: ResultsFile): Map<string, MaterialityLabel | null> {
  return new Map(results.judgments.map((j) => [j.key, j.label]));
}

async function run(args: string[]): Promise<void> {
  const items = loadItems();
  const concurrency = Number(flag(args, "--concurrency") ?? "4");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail("--concurrency must be a positive integer");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir =
    flag(args, "--out") ??
    path.join(homedir(), "Desktop", "noise-baseline", stamp);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "results.json");
  for (const line of describe(items)) console.log(line);
  console.log(`writing ${outPath}`);

  const titles = new Map<string, string>();
  const withTitles: ResultsFile["items"] = [];
  for (const item of items) {
    withTitles.push({
      ...item,
      prTitle: await prTitle(item.repo, item.pr, titles),
    });
  }
  const untitled = withTitles.filter(
    (i) => i.prTitle === "(title unavailable)",
  ).length;
  console.log(
    `PR titles: ${titles.size} fetched, ${untitled} items without one`,
  );

  const results: ResultsFile = {
    judge_model: JUDGE_MODEL,
    judge_system_sha256: judgeSystemSha256(),
    started_at: new Date().toISOString(),
    finished_at: null,
    cost_usd_est: 0,
    items: withTitles,
    judgments: [],
  };
  // Written after every judgment, so an interrupted run keeps what it paid
  // for and `report` can read it. Sync: concurrent workers never interleave.
  const save = () =>
    writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
  save();

  let next = 0;
  const worker = async () => {
    while (next < withTitles.length) {
      const item = withTitles[next];
      next += 1;
      if (item === undefined) break;
      const out = await judgeClaim({
        name: `noise-${results.judgments.length}`,
        prTitle: item.prTitle,
        claim: item.claim,
      });
      const judgment: Judgment = { key: item.key, label: out.label };
      if (out.reason !== undefined) judgment.reason = out.reason;
      if (out.error !== undefined) judgment.error = out.error;
      results.judgments.push(judgment);
      results.cost_usd_est += out.cost;
      save();
      console.log(
        `[${results.judgments.length}/${withTitles.length}] ${out.label ?? "ERR"} ${item.severity} ${item.hunter}`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  results.finished_at = new Date().toISOString();
  save();
  for (const line of renderNoiseReport(noiseReport(items, labelsOf(results)))) {
    console.log(line);
  }
  console.log(`cost (est): $${results.cost_usd_est.toFixed(2)}`);
}

async function report(args: string[]): Promise<void> {
  const file = args[0];
  if (file === undefined) fail("report needs a results.json path");
  const results = (await Bun.file(file).json()) as ResultsFile;
  if (results.finished_at === null) {
    console.log(
      `INCOMPLETE: ${results.judgments.length}/${results.items.length} items judged`,
    );
  }
  if (results.judge_system_sha256 !== judgeSystemSha256()) {
    console.log("note: the judge prompt changed since this run");
  }
  for (const line of renderNoiseReport(
    noiseReport(results.items, labelsOf(results)),
  )) {
    console.log(line);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "plan") {
  for (const line of describe(loadItems())) console.log(line);
} else if (command === "run") {
  await run(rest);
} else if (command === "report") {
  await report(rest);
} else {
  fail(
    "usage: noise-baseline.ts plan | run [--out <dir>] [--concurrency <n>] | report <results.json>",
  );
}
