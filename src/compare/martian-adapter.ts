// Project a pr-hero findings.json onto Martian's offline candidate shape.
// Pure: no I/O, no judge, no precision/recall. The judge is theirs; this
// only makes our artifacts injectable. See benchmarks/martian/README.md.

import type { Finding } from "#review/findings";

export interface MartianGoldenComment {
  comment: string;
  severity: string;
  category: string;
}

export interface MartianGoldenPr {
  pr_title: string;
  url: string;
  comments: MartianGoldenComment[];
}

export interface MartianCandidate {
  path: string;
  line: number;
  body: string;
}

export interface MartianReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface MartianReview {
  tool: "pr-hero";
  pr_url: string;
  review_comments: MartianReviewComment[];
  candidates: string[];
}

export function prNumberFromUrl(url: string): number {
  const match = url.match(/\/pull\/(\d+)\/?$/);
  if (match === null) {
    throw new Error(`not a GitHub pull URL: ${url}`);
  }
  return Number(match[1]);
}

export function findingsToCandidates(findings: Finding[]): MartianCandidate[] {
  return findings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    body: finding.claim,
  }));
}

export function findingsToMartianReview(input: {
  prUrl: string;
  findings: Finding[];
}): MartianReview {
  const mapped = findingsToCandidates(input.findings);
  return {
    tool: "pr-hero",
    pr_url: input.prUrl,
    review_comments: mapped.map((c) => ({
      path: c.path,
      line: c.line,
      body: c.body,
    })),
    candidates: mapped.map((c) => c.body),
  };
}

export function lookupGolden(
  goldens: MartianGoldenPr[],
  pr: number,
): MartianGoldenPr {
  const found = goldens.find((g) => prNumberFromUrl(g.url) === pr);
  if (found === undefined) {
    throw new Error(`no Martian golden for PR ${pr}`);
  }
  return found;
}
