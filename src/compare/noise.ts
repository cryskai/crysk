// The noise baseline's pure half (Stage 2 noise yardstick, step 2).
//
// The materiality judge (src/compare/materiality.ts), once it has passed its
// exam, labels every finding the engine posted on a real PR. The baseline is
// the share labelled `immaterial`, overall and broken down by severity, tier,
// hunter, repo and triage tag. The impure half (store read, PR titles, judge
// spawns) is scripts/noise-baseline.ts.

import type { MaterialityLabel } from "#compare/materiality";

// One finding as the store holds it, one row per run it appeared in.
export interface PostedFindingRow {
  repo: string;
  pr: number;
  runId: number;
  findingId: string;
  dedupeKey: string;
  claim: string;
  severity: string;
  tier: string;
  hunter: string;
  triageTag: string | null;
}

// One finding per PR. A re-review re-posts the same defect at a new head;
// counting it per head would weigh long PRs more than short ones.
export interface NoiseItem {
  key: string;
  repo: string;
  pr: number;
  claim: string;
  severity: string;
  tier: string;
  hunter: string;
  triageTag: string | null;
}

export function itemKey(repo: string, pr: number, dedupeKey: string): string {
  return `${repo}#${pr}#${dedupeKey}`;
}

// Keeps the first run's copy of each (repo, pr, dedupe key): what the PR
// author saw first. A triage tag from any copy is kept, the newest winning,
// because a finding is usually answered on a later head than it was posted.
export function dedupePostedFindings(rows: PostedFindingRow[]): NoiseItem[] {
  const ordered = [...rows].sort((a, b) => a.runId - b.runId);
  const items = new Map<string, NoiseItem>();
  for (const row of ordered) {
    const key = itemKey(row.repo, row.pr, row.dedupeKey);
    const existing = items.get(key);
    if (existing === undefined) {
      items.set(key, {
        key,
        repo: row.repo,
        pr: row.pr,
        claim: row.claim,
        severity: row.severity,
        tier: row.tier,
        hunter: row.hunter,
        triageTag: row.triageTag,
      });
    } else if (row.triageTag !== null) {
      existing.triageTag = row.triageTag;
    }
  }
  return [...items.values()];
}

export interface NoiseRow {
  group: string;
  judged: number;
  immaterial: number;
  failed: number;
  // immaterial / (judged - failed); null when nothing was labelled.
  noise: number | null;
}

export type NoiseDimension = "severity" | "tier" | "hunter" | "repo" | "triage";

export interface NoiseReport {
  overall: NoiseRow;
  by: Record<NoiseDimension, NoiseRow[]>;
}

function groupOf(item: NoiseItem, dimension: NoiseDimension): string {
  switch (dimension) {
    case "severity":
      return item.severity;
    case "tier":
      return item.tier;
    case "hunter":
      return item.hunter;
    case "repo":
      return item.repo;
    case "triage":
      return item.triageTag ?? "(no reply)";
  }
}

function tally(
  group: string,
  items: NoiseItem[],
  labels: Map<string, MaterialityLabel | null>,
): NoiseRow {
  let judged = 0;
  let immaterial = 0;
  let failed = 0;
  for (const item of items) {
    if (!labels.has(item.key)) continue;
    judged += 1;
    const label = labels.get(item.key);
    if (label === null) failed += 1;
    else if (label === "immaterial") immaterial += 1;
  }
  const labelled = judged - failed;
  return {
    group,
    judged,
    immaterial,
    failed,
    noise: labelled === 0 ? null : immaterial / labelled,
  };
}

// Failed spawns are left out of the rate, not counted as material or noise:
// they say nothing about the finding. Their count is reported beside it.
export function noiseReport(
  items: NoiseItem[],
  labels: Map<string, MaterialityLabel | null>,
): NoiseReport {
  const dimensions: NoiseDimension[] = [
    "severity",
    "tier",
    "hunter",
    "repo",
    "triage",
  ];
  const by = {} as Record<NoiseDimension, NoiseRow[]>;
  for (const dimension of dimensions) {
    const groups = new Map<string, NoiseItem[]>();
    for (const item of items) {
      const group = groupOf(item, dimension);
      const list = groups.get(group) ?? [];
      list.push(item);
      groups.set(group, list);
    }
    by[dimension] = [...groups.entries()]
      .map(([group, list]) => tally(group, list, labels))
      .sort((a, b) => b.judged - a.judged || a.group.localeCompare(b.group));
  }
  return { overall: tally("all", items, labels), by };
}

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

export function renderNoiseReport(report: NoiseReport): string[] {
  const line = (row: NoiseRow) =>
    `  ${row.group.padEnd(34)} ${pct(row.noise).padStart(6)}  (${row.immaterial}/${row.judged - row.failed}${row.failed > 0 ? `, ${row.failed} failed` : ""})`;
  const out = ["noise = share judged immaterial", line(report.overall)];
  for (const [dimension, rows] of Object.entries(report.by)) {
    out.push("", `by ${dimension}:`, ...rows.map(line));
  }
  return out;
}
