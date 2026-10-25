// Build a Martian corpus case file from its vendored goldens ($0, read-only gh).
//
//   bun run scripts/martian-cases.ts sentry|grafana|keycloak|discourse
//
// Writes docs/benchmarks/martian-<corpus>-cases.json in the shape
// scripts/martian-cal.ts reads. SHAs and size counters come from the GitHub
// PR record named by each golden's URL. Fifteen of the fifty goldens point at
// synthetic forks (`ai-code-review-evaluation/*`), not upstream PRs, so each
// row records the clone URL its SHAs live in (`remote`). Never edit the output
// by hand: re-run this instead.
//
// `baseSha` is the merge base GitHub diffs the PR against (three-dot), not the
// PR record's `base.sha`, which is the base branch tip. The harness reviews
// `--two-dot` from `baseSha`, so the tip would drag every commit the base
// branch gained after the head branched into the diff: on Sentry
// `sentry-greptile#1` that was 6118 files where GitHub shows 3.

import path from "node:path";
import type { MartianGoldenPr } from "#compare/martian-adapter";
import { writeJsonAtomically } from "../src/execution/atomic-write";

const CORPORA: Record<string, string> = {
  sentry: "getsentry/sentry",
  grafana: "grafana/grafana",
  keycloak: "keycloak/keycloak",
  discourse: "discourse/discourse",
};

const corpus = Bun.argv[2] ?? "";
const upstream = CORPORA[corpus];
if (upstream === undefined) {
  console.error(
    `usage: bun run scripts/martian-cases.ts ${Object.keys(CORPORA).join("|")}`,
  );
  process.exit(1);
}

const docs = path.join(import.meta.dir, "..", "docs", "benchmarks");
const goldens = (await Bun.file(
  path.join(docs, `martian-${corpus}-goldens.json`),
).json()) as MartianGoldenPr[];

function gh<T>(endpoint: string): T {
  const proc = Bun.spawnSync(["gh", "api", endpoint], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`gh api ${endpoint}: ${proc.stderr.toString()}`);
  }
  return JSON.parse(proc.stdout.toString()) as T;
}

interface PullRecord {
  number: number;
  title: string;
  additions: number;
  deletions: number;
  changed_files: number;
  base: { sha: string };
  head: { sha: string };
}

const prs = [];
const seen = new Set<number>();
for (const golden of goldens) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(
    golden.url,
  );
  if (!match) throw new Error(`unexpected golden URL: ${golden.url}`);
  const [, slug, number] = match;
  const pull = gh<PullRecord>(`repos/${slug}/pulls/${number}`);
  const compare = gh<{ merge_base_commit: { sha: string } }>(
    `repos/${slug}/compare/${pull.base.sha}...${pull.head.sha}`,
  );
  // Run directories and golden lookups key on the PR number alone.
  if (seen.has(pull.number)) throw new Error(`duplicate PR ${pull.number}`);
  seen.add(pull.number);
  prs.push({
    pr: pull.number,
    title: pull.title,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    baseSha: compare.merge_base_commit.sha,
    headSha: pull.head.sha,
    remote: `https://github.com/${slug}.git`,
  });
  console.error(`${slug}#${number}  +${pull.additions}/-${pull.deletions}`);
}

const out = path.join(docs, `martian-${corpus}-cases.json`);
await writeJsonAtomically(out, {
  repo: upstream,
  pilot: prs.slice(0, 3).map((p) => p.pr),
  prs,
});
console.error(`wrote ${out} (${prs.length} PRs)`);
