// Integration tests for Historical Backfill & metrics.db Migration (Slice 4).
// Tests discovering findings.json runs, idempotent ingest into prhero.db,
// metrics.db backup creation, and report formatting.
//
// 100% offline, fresh tmp directories.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Finding, FindingsDocument } from "#review/findings";
import { backfillHistoricalRuns, migrateMetricsDb } from "#store/backfill";
import {
  createEmptyBackfillStats,
  parseRepoIdFromRelPath,
  renderBackfillReport,
} from "#store/backfill-preflight";
import { openProductStore, queryRuns } from "#store/store";

function sampleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    category: 2,
    path: "src/engine.ts",
    line: 42,
    symbol: "startEngine",
    severity: "CRITICAL",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "Resource leak in timeout handler without cleanup",
    proof_refs: ["src/engine.ts:42-45"],
    hunter: "lifecycle",
    tier: "blocking",
    hops_used: 1,
    hop_trail: [
      {
        step: 1,
        kind: "symbol_search",
        query: "startEngine",
        reached: "src/engine.ts:40",
      },
    ],
    dedupe_key: "src/engine.ts:42:lifecycle",
    root_cause_id: "RC001",
    ...overrides,
  };
}

function sampleDoc(
  overrides: Partial<FindingsDocument> = {},
): FindingsDocument {
  return {
    schema_version: "1.0.0",
    pr: 42,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    model: "sonnet",
    iteration: 1,
    parity_hunter_fired: true,
    run_status: "complete",
    sessionFailed: false,
    summary: {
      prose: "Found 1 critical lifecycle defect.",
      score: 4,
      score_reason: "High quality findings.",
    },
    telemetry: {
      index_ms: 100,
      index_mode: "sync",
      index_disk_mb: 10,
      wall_ms: 3000,
      tokens_in: 5000,
      tokens_out: 500,
      tokens_total: 5500,
      per_agent: {},
    },
    findings: [sampleFinding()],
    debug: {
      refuted: [],
    },
    ...overrides,
  };
}

describe("Backfill pure helpers", () => {
  test("parseRepoIdFromRelPath extracts repo ID from runs path", () => {
    expect(
      parseRepoIdFromRelPath(
        "github.com/juanmaagd/pr-hero/runs/pr-42-1/findings.json",
      ),
    ).toBe("github.com/juanmaagd/pr-hero");
    expect(
      parseRepoIdFromRelPath("invalid/path/no-runs/findings.json"),
    ).toBeNull();
  });

  test("renderBackfillReport renders formatted summary", () => {
    const stats = createEmptyBackfillStats();
    stats.discovered = 10;
    stats.ingested = 9;
    stats.skipped = 1;
    stats.total_tokens = 50000;

    const report = renderBackfillReport(stats);
    expect(report).toContain("Discovered runs: 10");
    expect(report).toContain("Ingested runs:   9");
    expect(report).toContain("Total tokens:    50,000");
    expect(report).not.toContain("cost");
    expect(report).not.toContain("$");
  });
});

describe("backfillHistoricalRuns & migrateMetricsDb", () => {
  test("ingests historical run directory into prhero.db and is idempotent", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-backfill-home-"));
    const repoRunsDir = path.join(
      home,
      ".prhero",
      "repos",
      "github.com",
      "juanmaagd",
      "pr-hero",
      "runs",
      "pr-42-abc-1",
    );
    await mkdir(repoRunsDir, { recursive: true });

    const doc = sampleDoc({ pr: 42 });
    // An artifact written before the engine dropped dollars still holds a cost.
    const legacyDoc = {
      ...doc,
      telemetry: { ...doc.telemetry, cost_usd_est: 0.2 },
    };
    await writeFile(
      path.join(repoRunsDir, "findings.json"),
      JSON.stringify(legacyDoc, null, 2),
    );

    const stats1 = await backfillHistoricalRuns({ home });
    expect(stats1.discovered).toBe(1);
    expect(stats1.ingested).toBe(1);
    expect(stats1.errors).toBe(0);

    const dbPath = path.join(home, ".prhero", "prhero.db");
    const db = openProductStore(dbPath);
    try {
      const runs = queryRuns(db, { all: true });
      expect(runs.length).toBe(1);
      expect(runs[0]?.repo_id).toBe("github.com/juanmaagd/pr-hero");
      expect(runs[0]?.run_dir).toBe("pr-42-abc-1");
      // The artifact still carries its old `cost_usd_est`; the backfill stores none of it.
      const stored = db.query("SELECT cost_usd_est FROM runs").get() as {
        cost_usd_est: number;
      };
      expect(stored.cost_usd_est).toBe(0);
    } finally {
      db.close();
    }

    // Idempotency: second backfill updates rather than duplicating
    const stats2 = await backfillHistoricalRuns({ home });
    expect(stats2.discovered).toBe(1);
    expect(stats2.ingested).toBe(1);

    const db2 = openProductStore(dbPath);
    try {
      const runs2 = queryRuns(db2, { all: true });
      expect(runs2.length).toBe(1);
    } finally {
      db2.close();
    }
  });

  test("migrateMetricsDb backs up existing metrics.db file", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-migrate-home-"));
    const prheroDir = path.join(home, ".prhero");
    await mkdir(prheroDir, { recursive: true });

    const metricsDbPath = path.join(prheroDir, "metrics.db");
    await writeFile(metricsDbPath, "sqlite-dummy-data");

    const result = migrateMetricsDb(home);
    expect(result.migrated).toBe(true);
    const backupPath = result.backupPath ?? "";
    expect(backupPath).toBe(path.join(prheroDir, "metrics.db.bak"));

    const bakContent = await Bun.file(backupPath).text();
    expect(bakContent).toBe("sqlite-dummy-data");
  });
});
