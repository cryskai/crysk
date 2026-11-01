// The noise baseline's pure half: per-PR dedupe and the immaterial share.

import { describe, expect, test } from "bun:test";
import type { MaterialityLabel } from "#compare/materiality";
import {
  dedupePostedFindings,
  itemKey,
  type NoiseItem,
  noiseReport,
  type PostedFindingRow,
  renderNoiseReport,
} from "#compare/noise";

function row(over: Partial<PostedFindingRow>): PostedFindingRow {
  return {
    repo: "o/r",
    pr: 1,
    runId: 1,
    findingId: "F001",
    dedupeKey: "k1",
    claim: "claim",
    severity: "CRITICAL",
    tier: "blocking",
    hunter: "logic",
    triageTag: null,
    ...over,
  };
}

describe("dedupePostedFindings", () => {
  test("keeps one item per repo, PR and dedupe key, from the earliest run", () => {
    const items = dedupePostedFindings([
      row({ runId: 2, claim: "second head" }),
      row({ runId: 1, claim: "first head" }),
      row({ pr: 2, runId: 3 }),
      row({ repo: "o/other", runId: 4 }),
    ]);
    expect(items.map((i) => [i.key, i.claim])).toEqual([
      [itemKey("o/r", 1, "k1"), "first head"],
      [itemKey("o/r", 2, "k1"), "claim"],
      [itemKey("o/other", 1, "k1"), "claim"],
    ]);
  });

  test("keeps the newest triage tag from any copy", () => {
    const [item] = dedupePostedFindings([
      row({ runId: 1 }),
      row({ runId: 2, triageTag: "deferred" }),
      row({ runId: 3, triageTag: "applied" }),
      row({ runId: 4 }),
    ]);
    expect(item?.triageTag).toBe("applied");
  });
});

function item(key: string, over: Partial<NoiseItem> = {}): NoiseItem {
  return {
    key,
    repo: "o/r",
    pr: 1,
    claim: "c",
    severity: "CRITICAL",
    tier: "blocking",
    hunter: "logic",
    triageTag: null,
    ...over,
  };
}

describe("noiseReport", () => {
  const items = [
    item("a"),
    item("b"),
    item("c", { severity: "WARNING", tier: "advisory", triageTag: "applied" }),
    item("d", { severity: "WARNING", tier: "advisory" }),
    item("e"),
  ];
  const labels = new Map<string, MaterialityLabel | null>([
    ["a", "material"],
    ["b", "immaterial"],
    ["c", "immaterial"],
    ["d", null],
  ]);

  test("noise is immaterial over labelled; failed spawns and unjudged items stay out", () => {
    const report = noiseReport(items, labels);
    expect(report.overall).toEqual({
      group: "all",
      judged: 4,
      immaterial: 2,
      failed: 1,
      noise: 2 / 3,
    });
    expect(report.by.severity).toEqual([
      { group: "CRITICAL", judged: 2, immaterial: 1, failed: 0, noise: 0.5 },
      { group: "WARNING", judged: 2, immaterial: 1, failed: 1, noise: 1 },
    ]);
    expect(report.by.triage.map((r) => [r.group, r.judged])).toEqual([
      ["(no reply)", 3],
      ["applied", 1],
    ]);
  });

  test("a group with only failed spawns has no rate", () => {
    const report = noiseReport(
      [item("x")],
      new Map<string, MaterialityLabel | null>([["x", null]]),
    );
    expect(report.overall.noise).toBeNull();
  });

  test("renders every dimension with its rate and counts", () => {
    const lines = renderNoiseReport(noiseReport(items, labels));
    expect(lines[0]).toBe("noise = share judged immaterial");
    expect(lines[1]).toContain("66.7%");
    expect(lines[1]).toContain("(2/3, 1 failed)");
    for (const dimension of ["severity", "tier", "hunter", "repo", "triage"]) {
      expect(lines).toContain(`by ${dimension}:`);
    }
  });
});
