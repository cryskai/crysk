// Inject one pr-hero arm into a COPY of Martian's benchmark_data.json, so
// their unmodified steps 2, 2.5 and 3 score us exactly like every vendor.
//
//   bun run scripts/martian-inject.ts --arm dev-default \
//     --data <martian checkout>/offline/results/benchmark_data.json
//
// Each review comment body is what pr-hero posts on a real PR
// (renderInlineComment), not a bare claim: vendors were judged on the
// comments they posted, so we are too. Only qualified runs are exported
// (scripts/martian-evidence.ts); `--allow-unqualified` exports the rest and
// lists them, for runs whose evidence predates a producer fix. Never point
// --data at the upstream file you intend to keep pristine.

import path from "node:path";
import { lookupGolden, type MartianGoldenPr } from "#compare/martian-adapter";
import type { FindingsDocument } from "#review/findings";
import { renderInlineComment } from "#review/report";
import { writeJsonAtomically } from "../src/execution/atomic-write";
import {
  BENCH_HOME,
  type CasesFile,
  CORPORA,
  corpusDocsFile,
} from "./martian-corpora";
import { loadQualifiedReview } from "./martian-evidence";

function argValue(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  return i < 0 ? undefined : Bun.argv[i + 1];
}

const arm = argValue("--arm");
const dataPath = argValue("--data");
const allowUnqualified = Bun.argv.includes("--allow-unqualified");
if (!arm || !dataPath) {
  console.error(
    "usage: bun run scripts/martian-inject.ts --arm <id> --data <benchmark_data.json copy> [--allow-unqualified]",
  );
  process.exit(1);
}

interface MartianEntry {
  reviews: Array<{ tool: string }>;
}
const data = (await Bun.file(dataPath).json()) as Record<string, MartianEntry>;

const missing: string[] = [];
const unqualified: string[] = [];
let injected = 0;
for (const [name, corpus] of Object.entries(CORPORA)) {
  const cases = (await Bun.file(
    corpusDocsFile(name, "cases.json"),
  ).json()) as CasesFile;
  const goldens = (await Bun.file(
    corpusDocsFile(name, "goldens.json"),
  ).json()) as MartianGoldenPr[];
  for (const row of cases.prs) {
    const label = `${name}-${row.pr}`;
    const dir = path.join(BENCH_HOME, corpus.runs, `${label}-${arm}`);
    const golden = lookupGolden(goldens, row.pr);
    const entry = data[golden.url];
    if (entry === undefined) throw new Error(`${golden.url} not in --data`);
    const checked = await loadQualifiedReview(dir);
    let doc = checked.doc;
    if (!checked.qualified) {
      const file = Bun.file(path.join(dir, "findings.json"));
      if (!allowUnqualified || !(await file.exists())) {
        missing.push(`${label}: ${checked.reason ?? "no run"}`);
        continue;
      }
      unqualified.push(`${label}: ${checked.reason}`);
      doc = (await file.json()) as FindingsDocument;
    }
    if (doc === undefined) {
      missing.push(`${label}: no findings document`);
      continue;
    }
    const findings = doc.findings;
    entry.reviews = entry.reviews.filter((r) => r.tool !== "pr-hero");
    entry.reviews.push({
      tool: "pr-hero",
      pr_url: golden.url,
      repo_name: `pr-hero__${name}__PR${row.pr}__${arm}`,
      review_comments: findings.map((f) => ({
        path: f.path,
        line: f.line,
        body: renderInlineComment(f, row.headSha),
      })),
    } as MartianEntry["reviews"][number]);
    injected++;
  }
}

await writeJsonAtomically(dataPath, data);
console.error(`injected ${injected} pr-hero review(s) into ${dataPath}`);
for (const line of unqualified)
  console.error(`  UNQUALIFIED (allowed) ${line}`);
for (const line of missing) console.error(`  MISSING ${line}`);
process.exit(missing.length === 0 ? 0 : 1);
