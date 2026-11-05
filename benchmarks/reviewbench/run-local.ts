// Runs the adapter on ReviewBench's corpus natively, on this machine's Claude
// subscription, the way scripts/try-agent.sh runs the image. For private scoring
// only: a leaderboard row needs the image and a final through their portal.
//
//   bun benchmarks/reviewbench/run-local.ts --reviewbench <clone> --out <dir> --pr 0
//   bun benchmarks/reviewbench/run-local.ts --reviewbench <clone> --out <dir> --all
//
// Findings land in <out>/findings, the shape `npm run judge --candidate` reads,
// and run directories in <out>/runs. A pull request with findings is skipped, so
// an interrupted run resumes.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface CorpusEntry {
  nwo: string;
  pr_number: number | string;
  base: string;
  head: string;
  repo?: string;
  title?: string;
  body?: string;
}

export function prKey(entry: CorpusEntry): string {
  return `${entry.nwo.replace("/", "_")}_${entry.pr_number}-${entry.head.slice(0, 8)}`;
}

const CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

export function subscriptionEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const key of CREDENTIAL_KEYS) delete out[key];
  return out;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
  });
  return { ok: run.exitCode === 0, stdout: run.stdout.toString() };
}

function checkout(repo: string, entry: CorpusEntry): void {
  mkdirSync(repo, { recursive: true });
  if (!existsSync(path.join(repo, ".git"))) git(repo, ["init", "-q"]);
  const has = () =>
    git(repo, ["cat-file", "-e", `${entry.base}^{commit}`]).ok &&
    git(repo, ["cat-file", "-e", `${entry.head}^{commit}`]).ok;
  if (!has()) {
    const mirror = `https://github.com/review-bench/${entry.nwo.replace("/", "_")}.git`;
    git(repo, [
      "fetch",
      "-q",
      "--filter=blob:none",
      mirror,
      entry.base,
      entry.head,
    ]);
  }
  if (!has()) throw new Error("could not fetch base and head from the mirror");
  if (!git(repo, ["checkout", "-q", "--force", "--detach", entry.head]).ok) {
    throw new Error(`could not check out ${entry.head}`);
  }
  git(repo, ["clean", "-qfdx"]);
}

async function reviewOne(entry: CorpusEntry, out: string): Promise<number> {
  const key = prKey(entry);
  const result = path.join(out, "findings", `${key}.json`);
  if (existsSync(result)) {
    console.error(`${key}: findings exist, skipped`);
    return 0;
  }
  const repo = path.join(out, "repos", entry.nwo.replace("/", "_"));
  checkout(repo, entry);
  const prDir = path.join(out, "pr", key);
  mkdirSync(prDir, { recursive: true });
  mkdirSync(path.dirname(result), { recursive: true });
  const diff = path.join(prDir, "diff.patch");
  await Bun.write(
    diff,
    git(repo, ["diff", `${entry.base}...${entry.head}`]).stdout,
  );
  const prJson = path.join(prDir, "pr.json");
  await Bun.write(prJson, JSON.stringify(entry));
  const adapter = Bun.spawn(
    ["bun", "run", path.join(import.meta.dir, "adapter.ts")],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...subscriptionEnv(process.env),
        RB_NWO: entry.nwo,
        RB_PR_NUMBER: String(entry.pr_number),
        RB_BASE: entry.base,
        RB_HEAD: entry.head,
        RB_AGENT: "crysk",
        RB_REPO: repo,
        RB_DIFF: diff,
        RB_PR_JSON: prJson,
        RB_OUT: result,
        RB_RUN_DIR: path.join(out, "runs", key),
      },
    },
  );
  return await adapter.exited;
}

function flag(name: string): string | undefined {
  const at = Bun.argv.indexOf(name);
  return at === -1 ? undefined : Bun.argv[at + 1];
}

async function main(): Promise<number> {
  const reviewbench = flag("--reviewbench");
  const out = flag("--out");
  const only = flag("--pr");
  const all = Bun.argv.includes("--all");
  if (!reviewbench || !out || (only === undefined) === !all) {
    console.error(
      "usage: run-local.ts --reviewbench <clone> --out <dir> (--pr <index> | --all)",
    );
    return 2;
  }
  const resolved = path.resolve(out);
  const engine = path.resolve(import.meta.dir, "../..");
  if (resolved === engine || resolved.startsWith(`${engine}/`)) {
    console.error(
      "--out must be outside this repository: results never land here",
    );
    return 2;
  }
  const manifest = path.join(reviewbench, "corpus/test/test.json");
  const corpus = (await Bun.file(manifest).json()) as CorpusEntry[];
  const entries = all ? corpus : [corpus[Number(only)]];
  let failed = 0;
  for (const entry of entries) {
    if (entry === undefined)
      throw new Error(`no pull request at index ${only}`);
    const key = prKey(entry);
    console.error(`== ${key}`);
    try {
      const code = await reviewOne(entry, resolved);
      if (code !== 0) {
        console.error(`${key}: failed, exit ${code}`);
        failed++;
      }
    } catch (error) {
      console.error(`${key}: failed, ${String(error)}`);
      failed++;
    }
  }
  console.error(`done: ${entries.length - failed} ok, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
