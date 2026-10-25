import { expect, test } from "bun:test";
import path from "node:path";
import {
  lookupGolden,
  type MartianGoldenPr,
  prNumberFromUrl,
} from "#compare/martian-adapter";

// Drift guard for the five Martian corpora: scripts/martian-cal.ts keys run
// directories and golden lookups on the PR number alone, and reviews the SHAs
// in the case file. A case file that falls out of step with its vendored
// goldens would score a review against the wrong PR without any error.

const DOCS = path.join(import.meta.dir, "..", "docs", "benchmarks");
const CORPORA = ["cal", "sentry", "grafana", "keycloak", "discourse"];

interface CaseRow {
  pr: number;
  baseSha: string;
  headSha: string;
  remote?: string;
}

async function load(corpus: string) {
  const cases = (await Bun.file(
    path.join(DOCS, `martian-${corpus}-cases.json`),
  ).json()) as { pilot: number[]; prs: CaseRow[] };
  const goldens = (await Bun.file(
    path.join(DOCS, `martian-${corpus}-goldens.json`),
  ).json()) as MartianGoldenPr[];
  return { cases, goldens };
}

for (const corpus of CORPORA) {
  test(`${corpus}: every golden has exactly one case row and vice versa`, async () => {
    const { cases, goldens } = await load(corpus);
    const fromGoldens = goldens.map((g) => prNumberFromUrl(g.url)).sort();
    const fromCases = cases.prs.map((r) => r.pr).sort();
    expect(fromCases).toEqual(fromGoldens);
    expect(new Set(fromCases).size).toBe(fromCases.length);
    for (const pr of cases.pilot) expect(fromCases).toContain(pr);
  });

  test(`${corpus}: each row names two full SHAs and the repository its golden points at`, async () => {
    const { cases, goldens } = await load(corpus);
    for (const row of cases.prs) {
      expect(row.baseSha).toMatch(/^[0-9a-f]{40}$/);
      expect(row.headSha).toMatch(/^[0-9a-f]{40}$/);
      if (row.remote === undefined) continue;
      const golden = lookupGolden(goldens, row.pr);
      const slug = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(
        golden.url,
      )?.[1];
      expect(row.remote).toBe(`https://github.com/${slug}.git`);
    }
  });

  test(`${corpus}: has a gotchas file`, async () => {
    const gotchas = await Bun.file(
      path.join(DOCS, `martian-${corpus}-gotchas.md`),
    ).text();
    expect(gotchas).toContain("Do not open GitHub.");
  });
}

test("the five corpora hold Martian's 50 PRs and 173 goldens", async () => {
  let prs = 0;
  let comments = 0;
  for (const corpus of CORPORA) {
    const { goldens } = await load(corpus);
    prs += goldens.length;
    comments += goldens.reduce((n, g) => n + g.comments.length, 0);
  }
  expect(prs).toBe(50);
  expect(comments).toBe(173);
});
