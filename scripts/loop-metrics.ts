// Loop metrics (Stage 2 yardstick: rounds to a green gate, time to green).
//
// Read from GitHub, not from the local store: CI reviews run on ephemeral
// runners and never reach ~/.crysk/prhero.db. The gate is a commit status
// (`crysk`, or the legacy `pr-hero` context before the rename), and the
// statuses API keeps every state it ever had per commit, with timestamps. So
// the whole loop of a PR — each review, each red, the first green and how it
// got there — is recoverable after the fact, at $0.
//
// `fetch` writes the raw statuses to <out>/raw.json and resumes from it, so a
// re-run only fetches PRs it does not have yet. `report` is pure over that
// file (src/compare/loop.ts) and re-runnable forever. Output stays outside
// this repo (default ~/Desktop/loop-metrics/<owner-repo>/): a private repo's
// PR titles must never land in a commit here.
//
//   bun run scripts/loop-metrics.ts fetch --repo cryskai/crysk [--since <YYYY-MM-DD>] [--out <dir>] [--concurrency <n>]
//   bun run scripts/loop-metrics.ts report <raw.json> [--since <ISO date>] [--base <branch>]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  blockingGateSince,
  loopReport,
  type RawPr,
  type RawStatus,
  renderLoopReport,
} from "#compare/loop";

function fail(message: string): never {
  console.error(`loop-metrics: ${message}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")}: ${err.trim()}`);
  return out;
}

// `gh api --paginate` concatenates one JSON array per page; `--jq .[]` turns
// them into one value per line, which parses page-agnostically. `tojson`
// because --jq prints a bare string unquoted, and that is not JSON.
async function ghList<T>(endpoint: string, jq: string): Promise<T[]> {
  const out = await gh([
    "api",
    endpoint,
    "--paginate",
    "--jq",
    `.[] | ${jq} | tojson`,
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

interface PrListing {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: string;
  isDraft: boolean;
  baseRefName: string;
}

async function fetchPr(repo: string, listing: PrListing): Promise<RawPr> {
  const shas = await ghList<string>(
    `repos/${repo}/pulls/${listing.number}/commits`,
    ".sha",
  );
  const commits = [];
  for (const sha of shas) {
    const statuses = await ghList<RawStatus>(
      `repos/${repo}/commits/${sha}/statuses`,
      "{createdAt: .created_at, context: .context, state: .state, description: .description}",
    );
    commits.push({
      sha,
      statuses: statuses.filter(
        (s) => s.context === "crysk" || s.context === "pr-hero",
      ),
    });
  }
  return { repo, ...listing, commits };
}

async function runFetch(args: string[]): Promise<void> {
  const repo = flag(args, "--repo") ?? fail("fetch needs --repo <owner/name>");
  const out =
    flag(args, "--out") ??
    path.join(homedir(), "Desktop", "loop-metrics", repo.replace("/", "-"));
  const concurrency = Number(flag(args, "--concurrency") ?? "6");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail("--concurrency must be a positive integer");
  }
  const since = flag(args, "--since");
  await mkdir(out, { recursive: true });
  const file = path.join(out, "raw.json");

  const cached: RawPr[] = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : [];
  // The cache is keyed by PR number, which another repo's file shares.
  const foreign = cached.find((p) => p.repo !== repo);
  if (foreign !== undefined) {
    fail(`${file} holds ${foreign.repo}, not ${repo}; pass another --out`);
  }

  // `gh pr list --search` goes through the search API, which stops at 1000
  // results; past either cap the listing is the newest PRs only.
  const limit = since === undefined ? 2000 : 1000;
  const listings = JSON.parse(
    await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      String(limit),
      // A large repo's history predates the gate by thousands of PRs, each
      // costing a call per commit against a 5000/h API budget.
      ...(since === undefined ? [] : ["--search", `created:>=${since}`]),
      "--json",
      "number,title,createdAt,mergedAt,closedAt,state,isDraft,baseRefName",
    ]),
  ) as PrListing[];
  if (listings.length >= limit) {
    fail(`the listing hit its ${limit}-PR cap; pass a later --since`);
  }

  // A cached PR is final only while GitHub still lists it closed the same
  // way: one reopened, pushed to and closed again has a new history. Every
  // reused entry takes its fields from the fresh listing, so a field added to
  // the listing later reaches old entries for free.
  const byNumber = new Map(cached.map((p) => [p.number, p]));
  const done = new Map<number, RawPr>();
  for (const listing of listings) {
    const old = byNumber.get(listing.number);
    if (
      old !== undefined &&
      listing.state !== "OPEN" &&
      old.state === listing.state &&
      old.closedAt === listing.closedAt
    ) {
      done.set(listing.number, { ...old, ...listing });
    }
  }
  const todo = listings.filter((l) => !done.has(l.number));
  console.log(
    `${listings.length} PRs, ${done.size} cached, ${todo.length} to fetch`,
  );

  const fetched: RawPr[] = [];
  const failed: number[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const listing = todo[next++] as PrListing;
      try {
        fetched.push(await fetchPr(repo, listing));
      } catch (error) {
        failed.push(listing.number);
        console.error(`#${listing.number}: ${(error as Error).message}`);
      }
      if ((fetched.length + 1) % 25 === 0)
        console.log(`  ${fetched.length}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // What was fetched is kept, so a re-run resumes; but a report over a set
  // with holes skews every percentile, so the run still fails.
  const all = [...done.values(), ...fetched].sort(
    (a, b) => a.number - b.number,
  );
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  console.log(`wrote ${all.length} PRs to ${file}`);
  if (failed.length > 0) {
    fail(`${failed.length} PRs failed to fetch; re-run fetch to resume`);
  }
}

function runReport(args: string[]): void {
  const file = args[0] ?? fail("report needs <raw.json>");
  const base = flag(args, "--base");
  const prs = JSON.parse(readFileSync(file, "utf8")) as RawPr[];
  const since =
    flag(args, "--since") ??
    blockingGateSince(prs) ??
    fail("no blocking verdict in this repo's gate history; pass --since");
  const scoped = prs.filter(
    (p) =>
      p.createdAt >= since && (base === undefined || p.baseRefName === base),
  );
  console.log(
    `scope: PRs opened since ${since}${base === undefined ? "" : `, base ${base}`}\n`,
  );
  console.log(renderLoopReport(loopReport(scoped)).join("\n"));
}

const [command, ...rest] = process.argv.slice(2);
if (command === "fetch") await runFetch(rest);
else if (command === "report") runReport(rest);
else
  fail(
    "usage: loop-metrics.ts fetch --repo <owner/name> [--since <date>] [--out <dir>] | report <raw.json> [--since <date>] [--base <branch>]",
  );
