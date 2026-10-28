// Integration & round-trip tests for the Canonical Product Store (prhero.db, Fundamentals #6).
// Asserts schema creation, migrations, transactional save, idempotency, cascade deletes,
// and exact deterministic round-trip reconstruction of FindingsDocument.
//
// 100% offline, fresh tmp database per test run.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Finding, FindingsDocument } from "#review/findings";
import type { PerAgentUsage } from "#review/pipeline";
import {
  CURRENT_PRODUCT_SCHEMA_VERSION,
  projectCompleteRun,
} from "#store/preflight";
import {
  exportFindingsDocument,
  getFindingTriageByRunId,
  getRunById,
  openProductStore,
  queryRuns,
  recordFindingTriage,
  saveRunTransaction,
} from "#store/store";

async function tmpDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-store-"));
  return path.join(dir, "prhero.db");
}

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
    proof_refs: [
      "src/engine.ts:42-45 (timer created here)",
      "src/engine.ts:80-82 (early return without clearing timer)",
    ],
    hunter: "lifecycle",
    tier: "blocking",
    hops_used: 2,
    hop_trail: [
      {
        step: 1,
        kind: "symbol_search",
        query: "startEngine",
        reached: "src/engine.ts:40",
      },
      {
        step: 2,
        kind: "callees",
        query: "clearTimeout",
        reached: "none",
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
    iteration: 3,
    prompt_set: {
      name: "arm-lifecycle-v7",
      sha256: "c".repeat(64),
    },
    driver_sha: "d".repeat(40),
    engine: {
      name: "pr-hero",
      version: "0.2.0",
    },
    parity_hunter_fired: true,
    run_status: "complete",
    sessionFailed: false,
    summary: {
      prose: "Found 1 critical lifecycle defect in timeout management.",
      score: 4,
      score_reason: "High quality findings with deterministic evidence.",
    },
    telemetry: {
      index_ms: 120,
      index_mode: "sync",
      sync_ms: 45,
      index_disk_mb: 12.5,
      wall_ms: 4500,
      tokens_in: 12000,
      tokens_out: 850,
      tokens_total: 12850,
      cost_usd_est: 0.38,
      per_agent: {
        lifecycle: { tokens_total: 8000, duration_ms: 3200 },
        reliability: { tokens_total: 4850, duration_ms: 1300 },
      },
    },
    findings: [
      sampleFinding(),
      sampleFinding({
        id: "F002",
        category: 1,
        path: "src/client.ts",
        line: 15,
        severity: "WARNING",
        evidence_class: "inferential",
        refuter_verdict: "inconclusive",
        causal_disposition: "pre-existing",
        claim: "Unchecked error return value",
        proof_refs: ["src/client.ts:15"],
        hunter: "reliability",
        tier: "advisory",
        hops_used: 1,
        hop_trail: [
          { step: 1, kind: "read", query: "client.ts", reached: "line 15" },
        ],
        dedupe_key: "src/client.ts:15:reliability",
        root_cause_id: "RC002",
      }),
    ],
    debug: {
      refuted: [
        {
          id: "F003",
          category: 3,
          path: "src/guard.ts",
          line: 88,
          symbol: "validate",
          severity: "BLOCKER",
          evidence_class: "inferential",
          refuter_verdict: "refuted",
          causal_disposition: "introduced",
          claim: "Claim refuted by existing fallback check",
          proof_refs: ["src/guard.ts:88"],
          hunter: "resilience",
          hops_used: 1,
          hop_trail: [],
          dedupe_key: "src/guard.ts:88",
        },
      ],
      deduped: [
        {
          id: "F004",
          category: 2,
          path: "src/engine.ts",
          line: 43,
          symbol: "startEngine",
          severity: "CRITICAL",
          evidence_class: "deterministic",
          refuter_verdict: "corroborated",
          causal_disposition: "introduced",
          claim: "Duplicate timer leak claim",
          proof_refs: ["src/engine.ts:43"],
          hunter: "reliability",
          hops_used: 1,
          hop_trail: [],
          dedupe_key: "src/engine.ts:43:duplicate",
          merged_into: "F001",
        },
      ],
      root_causes: {
        clusters: [
          { id: "RC001", anchor: "src/engine.ts:42-45", finding_ids: ["F001"] },
          { id: "RC002", anchor: "src/client.ts:15", finding_ids: ["F002"] },
        ],
        distinct_root_causes: 2,
      },
    },
    ...overrides,
  };
}

const SAMPLE_PER_AGENT: Record<string, PerAgentUsage> = {
  lifecycle: {
    tokens_total: 8000,
    duration_ms: 3200,
    tokens_in: 7200,
    tokens_out: 800,
    cost_usd_est: 0.25,
    attempts: 1,
    status: "ok",
  },
  reliability: {
    tokens_total: 4850,
    duration_ms: 1300,
    tokens_in: 4800,
    tokens_out: 50,
    cost_usd_est: 0.13,
    attempts: 1,
    status: "ok",
  },
};

const REPO_ID = "github.com/juanmaagd/pr-hero";
const RUN_DIR = "2026-08-23T18-00-00-000Z-pr-42";

// Historical triage verdicts live in comparison_rows. No writer creates them any
// more; a fixture inserts them directly, the way a run stored before the retirement
// left them.
function insertComparisonRow(
  db: Database,
  runId: number,
  rowIndex: number,
  verdict: string,
): void {
  db.query(
    `INSERT INTO comparison_rows
       (run_id, row_index, bucket, greptile_json, prhero_json, verdict, reasoning, actor)
     VALUES (?, ?, 'prhero_only', NULL, NULL, ?, 'fixture reasoning', 'human')`,
  ).run(runId, rowIndex, verdict);
}

describe("openProductStore", () => {
  test("creates the file, migrates to CURRENT_PRODUCT_SCHEMA_VERSION, and enables WAL + foreign keys", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const journalMode = (
        db.query("PRAGMA journal_mode;").get() as { journal_mode: string }
      ).journal_mode;
      expect(journalMode.toLowerCase()).toBe("wal");

      const version = (
        db.query("PRAGMA user_version;").get() as { user_version: number }
      ).user_version;
      expect(version).toBe(CURRENT_PRODUCT_SCHEMA_VERSION);

      const foreignKeys = (
        db.query("PRAGMA foreign_keys;").get() as { foreign_keys: number }
      ).foreign_keys;
      expect(foreignKeys).toBe(1);

      // Verify all tables exist
      const tables = (
        db
          .query("SELECT name FROM sqlite_master WHERE type='table';")
          .all() as {
          name: string;
        }[]
      ).map((t) => t.name);

      expect(tables).toContain("runs");
      expect(tables).toContain("findings");
      expect(tables).toContain("finding_proof_refs");
      expect(tables).toContain("finding_hop_trail");
      expect(tables).toContain("debug_findings");
      expect(tables).toContain("run_agents");
      expect(tables).toContain("comparison_rows");
    } finally {
      db.close();
    }
  });
});

describe("saveRunTransaction and round-trip fidelity", () => {
  test("persists full run and exports byte-compatible FindingsDocument", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const originalDoc = sampleDoc();
      const projected = projectCompleteRun({
        doc: originalDoc,
        perAgent: SAMPLE_PER_AGENT,
        repoId: REPO_ID,
        runDir: RUN_DIR,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const runId = saveRunTransaction(db, projected);
      expect(runId).toBeGreaterThan(0);

      const runRow = getRunById(db, runId);
      expect(runRow).not.toBeNull();
      expect(runRow?.repo_id).toBe(REPO_ID);
      expect(runRow?.run_dir).toBe(RUN_DIR);
      expect(runRow?.pr).toBe(42);
      expect(runRow?.blocking).toBe(1);
      expect(runRow?.advisory).toBe(1);
      // No writer sets greptile_found any more; a new run leaves it NULL.
      expect(runRow?.greptile_found).toBeNull();

      // Round-trip export
      const exportedDoc = exportFindingsDocument(db, runId);
      expect(exportedDoc).not.toBeNull();
      expect(exportedDoc).toEqual(originalDoc);
    } finally {
      db.close();
    }
  });

  test("projectCompleteRun sets run.diff_from_sha from the diffFromSha input", async () => {
    const projected = projectCompleteRun({
      doc: sampleDoc(),
      perAgent: SAMPLE_PER_AGENT,
      repoId: REPO_ID,
      runDir: RUN_DIR,
      checkoutPath: "/Users/juanma/Desktop/pr-hero",
      diffFromSha: "c".repeat(40),
      generatedAt: "2026-08-23T18:00:00.000Z",
    });
    expect(projected.run.diff_from_sha).toBe("c".repeat(40));
    expect(projected.run.greptile_found).toBeNull();
    expect("comparisonRows" in projected).toBe(false);
  });

  test("re-saving a run keeps comparison_rows that were already stored", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const first = saveRunTransaction(
        db,
        projectCompleteRun({
          doc: sampleDoc(),
          perAgent: SAMPLE_PER_AGENT,
          repoId: REPO_ID,
          runDir: RUN_DIR,
          checkoutPath: "/Users/juanma/Desktop/pr-hero",
          generatedAt: "2026-08-23T18:00:00.000Z",
        }),
      );
      insertComparisonRow(db, first, 0, "both-found-real-bug");
      insertComparisonRow(db, first, 1, "prhero-false-positive");

      const again = saveRunTransaction(
        db,
        projectCompleteRun({
          doc: sampleDoc(),
          perAgent: SAMPLE_PER_AGENT,
          repoId: REPO_ID,
          runDir: RUN_DIR,
          checkoutPath: "/Users/juanma/Desktop/pr-hero",
          generatedAt: "2026-08-23T18:05:00.000Z",
        }),
      );
      expect(again).toBe(first);

      const rows = db
        .query(
          "SELECT row_index, verdict FROM comparison_rows WHERE run_id = ? ORDER BY row_index",
        )
        .all(first) as { row_index: number; verdict: string }[];
      expect(rows).toEqual([
        { row_index: 0, verdict: "both-found-real-bug" },
        { row_index: 1, verdict: "prhero-false-positive" },
      ]);
    } finally {
      db.close();
    }
  });

  // A live re-run into the same run dir (an explicit --out) is a new run: its
  // timestamp must move with its cost and head, or `usage` pairs them wrong.
  test("a live re-save refreshes generated_at", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const save = (generatedAt: string) =>
        saveRunTransaction(
          db,
          projectCompleteRun({
            doc: sampleDoc(),
            perAgent: SAMPLE_PER_AGENT,
            repoId: REPO_ID,
            runDir: RUN_DIR,
            checkoutPath: "/Users/juanma/Desktop/pr-hero",
            generatedAt,
          }),
        );
      const id = save("2026-08-23T18:00:00.000Z");
      save("2026-08-23T18:05:00.000Z");
      expect(getRunById(db, id)?.generated_at).toBe("2026-08-23T18:05:00.000Z");
    } finally {
      db.close();
    }
  });

  // Same head, but the artifact was stamped AFTER the stored row: a later
  // re-run of that head into the same run dir whose live persist was missed.
  // The live persist always stamps after the pipeline (store/preflight.ts), so
  // for the run the row describes the artifact time is never later.
  test("a backfill re-save with the same head and a later artifact time takes it", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const save = (generatedAt: string) =>
        saveRunTransaction(
          db,
          projectCompleteRun({
            doc: sampleDoc(),
            perAgent: SAMPLE_PER_AGENT,
            repoId: REPO_ID,
            runDir: RUN_DIR,
            checkoutPath: "/Users/juanma/Desktop/pr-hero",
            generatedAt,
          }),
          { keepGeneratedAt: true },
        );
      const id = save("2026-08-23T18:00:00.000Z");
      save("2026-08-24T09:00:00.000Z");
      expect(getRunById(db, id)?.generated_at).toBe("2026-08-24T09:00:00.000Z");
    } finally {
      db.close();
    }
  });

  // A backfill keeps the stored time only for the SAME run. A different head
  // in the same run dir is a later run whose live persist was missed, so its
  // own time comes with its own cost and head.
  test("a backfill re-save with a different head takes the artifact's generated_at", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const id = saveRunTransaction(
        db,
        projectCompleteRun({
          doc: sampleDoc(),
          perAgent: SAMPLE_PER_AGENT,
          repoId: REPO_ID,
          runDir: RUN_DIR,
          checkoutPath: "/Users/juanma/Desktop/pr-hero",
          generatedAt: "2026-08-23T18:00:00.000Z",
        }),
      );
      saveRunTransaction(
        db,
        projectCompleteRun({
          doc: { ...sampleDoc(), head_sha: "d".repeat(40) },
          perAgent: SAMPLE_PER_AGENT,
          repoId: REPO_ID,
          runDir: RUN_DIR,
          checkoutPath: "/Users/juanma/Desktop/pr-hero",
          generatedAt: "2026-08-24T09:00:00.000Z",
        }),
        { keepGeneratedAt: true },
      );
      const row = getRunById(db, id);
      expect(row?.head_sha).toBe("d".repeat(40));
      expect(row?.generated_at).toBe("2026-08-24T09:00:00.000Z");
    } finally {
      db.close();
    }
  });

  test("a backfill re-save (keepGeneratedAt) keeps diff_from_sha, greptile_found and generated_at", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const id = saveRunTransaction(
        db,
        projectCompleteRun({
          doc: sampleDoc(),
          perAgent: SAMPLE_PER_AGENT,
          diffFromSha: "c".repeat(40),
          repoId: REPO_ID,
          runDir: RUN_DIR,
          checkoutPath: "/Users/juanma/Desktop/pr-hero",
          generatedAt: "2026-08-23T18:00:00.000Z",
        }),
      );
      // A historical value written before the retirement.
      db.query("UPDATE runs SET greptile_found = 1 WHERE id = ?").run(id);

      saveRunTransaction(
        db,
        projectCompleteRun({
          doc: sampleDoc(),
          perAgent: SAMPLE_PER_AGENT,
          repoId: REPO_ID,
          runDir: RUN_DIR,
          checkoutPath: "/Users/juanma/Desktop/pr-hero",
          // The artifact of the run the row describes: stamped before the row.
          generatedAt: "2026-08-23T17:55:00.000Z",
        }),
        { keepGeneratedAt: true },
      );

      const row = getRunById(db, id);
      expect(row?.diff_from_sha).toBe("c".repeat(40));
      expect(row?.greptile_found).toBe(1);
      expect(row?.generated_at).toBe("2026-08-23T18:00:00.000Z");
    } finally {
      db.close();
    }
  });

  test("handles local runs (pr === 0) mapped to null SQL and back to 0 on export", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const localDoc = sampleDoc({ pr: 0 });
      const localRunDir = "2026-08-23T18-00-00-000Z-local";
      const projected = projectCompleteRun({
        doc: localDoc,
        repoId: REPO_ID,
        runDir: localRunDir,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const runId = saveRunTransaction(db, projected);
      const runRow = getRunById(db, runId);
      expect(runRow?.pr).toBeNull();

      const exportedDoc = exportFindingsDocument(db, runId);
      expect(exportedDoc?.pr).toBe(0);
      expect(exportedDoc).toEqual(localDoc);
    } finally {
      db.close();
    }
  });

  test("persists diversity debug artifacts through store v5 tables", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const base = sampleDoc();
      const diversityDebug = {
        planFingerprint: "abc123",
        attempts: [
          {
            attemptId: "leg-1-a1",
            legId: "leg-1",
            armId: "m6-diversity",
            specialty: "reliability",
            replicate: 1,
            attempt: 1,
            status: "completed",
            cashCostUsd: 0.1,
            notionalCostUsd: 0.05,
          },
        ],
        observations: [
          {
            observationId: "leg-1-a1-o1",
            attemptId: "leg-1-a1",
            legId: "leg-1",
            armId: "m6-diversity",
            specialty: "reliability",
            path: "src/app.ts",
          },
        ],
      };
      const originalDoc = sampleDoc({
        debug: {
          ...base.debug,
          diversity: diversityDebug,
        },
      });
      const projected = projectCompleteRun({
        doc: originalDoc,
        repoId: REPO_ID,
        runDir: "2026-08-29-diversity-run",
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-29T10:00:00.000Z",
      });

      const runId = saveRunTransaction(db, projected);
      const runRow = getRunById(db, runId);
      expect(runRow?.diversity_plan_json).toBe(JSON.stringify(diversityDebug));

      const attempts = db
        .query("SELECT * FROM diversity_attempts WHERE run_id = ?")
        .all(runId) as { attempt_id: string; specialty: string }[];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.attempt_id).toBe("leg-1-a1");

      const observations = db
        .query("SELECT * FROM diversity_observations WHERE run_id = ?")
        .all(runId) as { observation_id: string }[];
      expect(observations).toHaveLength(1);
      expect(observations[0]?.observation_id).toBe("leg-1-a1-o1");

      const exportedDoc = exportFindingsDocument(db, runId);
      expect(exportedDoc?.debug.diversity).toEqual(diversityDebug);
    } finally {
      db.close();
    }
  });

  test("idempotency: re-saving same run_dir updates parent and replaces children cleanly", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const docV1 = sampleDoc();
      const projectedV1 = projectCompleteRun({
        doc: docV1,
        perAgent: SAMPLE_PER_AGENT,
        repoId: REPO_ID,
        runDir: RUN_DIR,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const id1 = saveRunTransaction(db, projectedV1);

      // Check count of findings
      const count1 = (
        db
          .query("SELECT COUNT(*) as c FROM findings WHERE run_id = ?")
          .get(id1) as {
          c: number;
        }
      ).c;
      expect(count1).toBe(2);

      // Re-save with updated doc (only 1 finding)
      const docV2 = sampleDoc({
        findings: [sampleFinding()],
      });
      const projectedV2 = projectCompleteRun({
        doc: docV2,
        perAgent: SAMPLE_PER_AGENT,
        repoId: REPO_ID,
        runDir: RUN_DIR,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:05:00.000Z",
      });

      const id2 = saveRunTransaction(db, projectedV2);
      expect(id2).toBe(id1);

      const totalRuns = (
        db.query("SELECT COUNT(*) as c FROM runs").get() as { c: number }
      ).c;
      expect(totalRuns).toBe(1);

      const count2 = (
        db
          .query("SELECT COUNT(*) as c FROM findings WHERE run_id = ?")
          .get(id2) as {
          c: number;
        }
      ).c;
      expect(count2).toBe(1);

      const exportedDocV2 = exportFindingsDocument(db, id2);
      expect(exportedDocV2?.findings.length).toBe(1);
    } finally {
      db.close();
    }
  });

  test("cascade deletes remove all associated child rows", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const doc = sampleDoc();
      const projected = projectCompleteRun({
        doc,
        perAgent: SAMPLE_PER_AGENT,
        repoId: REPO_ID,
        runDir: RUN_DIR,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const runId = saveRunTransaction(db, projected);
      expect(runId).toBeGreaterThan(0);
      insertComparisonRow(db, runId, 0, "both-found-real-bug");

      // Delete the run
      db.query("DELETE FROM runs WHERE id = ?").run(runId);

      const findingsCount = (
        db
          .query("SELECT COUNT(*) as c FROM findings WHERE run_id = ?")
          .get(runId) as {
          c: number;
        }
      ).c;
      expect(findingsCount).toBe(0);

      const proofRefsCount = (
        db.query("SELECT COUNT(*) as c FROM finding_proof_refs").get() as {
          c: number;
        }
      ).c;
      expect(proofRefsCount).toBe(0);

      const hopTrailsCount = (
        db.query("SELECT COUNT(*) as c FROM finding_hop_trail").get() as {
          c: number;
        }
      ).c;
      expect(hopTrailsCount).toBe(0);

      const debugCount = (
        db
          .query("SELECT COUNT(*) as c FROM debug_findings WHERE run_id = ?")
          .get(runId) as {
          c: number;
        }
      ).c;
      expect(debugCount).toBe(0);

      const agentsCount = (
        db
          .query("SELECT COUNT(*) as c FROM run_agents WHERE run_id = ?")
          .get(runId) as {
          c: number;
        }
      ).c;
      expect(agentsCount).toBe(0);

      const compCount = (
        db
          .query("SELECT COUNT(*) as c FROM comparison_rows WHERE run_id = ?")
          .get(runId) as {
          c: number;
        }
      ).c;
      expect(compCount).toBe(0);
    } finally {
      db.close();
    }
  });

  test("queryRuns scopes by repo_id or returns all", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const docA = sampleDoc({ pr: 1 });
      const docB = sampleDoc({ pr: 2 });

      saveRunTransaction(
        db,
        projectCompleteRun({
          doc: docA,
          repoId: "github.com/org/repo-a",
          runDir: "run-a",
          checkoutPath: null,
          generatedAt: "2026-08-23T18:00:00.000Z",
        }),
      );

      saveRunTransaction(
        db,
        projectCompleteRun({
          doc: docB,
          repoId: "github.com/org/repo-b",
          runDir: "run-b",
          checkoutPath: null,
          generatedAt: "2026-08-23T18:01:00.000Z",
        }),
      );

      const all = queryRuns(db, { all: true });
      expect(all.length).toBe(2);

      const repoAOnly = queryRuns(db, { repoId: "github.com/org/repo-a" });
      expect(repoAOnly.length).toBe(1);
      expect(repoAOnly[0]?.repo_id).toBe("github.com/org/repo-a");
    } finally {
      db.close();
    }
  });

  test("runs table allows identical run_dir across different repos without cross-repo overwrite", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const docA = sampleDoc({ pr: 1 });
      const docB = sampleDoc({ pr: 1 });

      const idA = saveRunTransaction(
        db,
        projectCompleteRun({
          doc: docA,
          repoId: "github.com/org/repo-alpha",
          runDir: "pr-1-head1234-1",
          checkoutPath: null,
        }),
      );

      const idB = saveRunTransaction(
        db,
        projectCompleteRun({
          doc: docB,
          repoId: "github.com/org/repo-beta",
          runDir: "pr-1-head1234-1",
          checkoutPath: null,
        }),
      );

      expect(idA).not.toBe(idB);

      const all = queryRuns(db, { all: true });
      expect(all.length).toBe(2);
      expect(all.map((r) => r.repo_id).sort()).toEqual([
        "github.com/org/repo-alpha",
        "github.com/org/repo-beta",
      ]);
    } finally {
      db.close();
    }
  });

  test("preserves structured HopTrailStep objects with kind trace and empty reached on export", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const docWithStructuredHop = sampleDoc();
      const f0 = docWithStructuredHop.findings[0];
      if (f0) {
        f0.hop_trail = [
          { step: 1, kind: "trace", query: "read index.ts", reached: "" },
        ];
      }

      const runId = saveRunTransaction(
        db,
        projectCompleteRun({
          doc: docWithStructuredHop,
          repoId: "github.com/org/sample",
          runDir: "run-hop-structured",
          checkoutPath: null,
        }),
      );

      const exported = exportFindingsDocument(db, runId);
      expect(exported).not.toBeNull();
      expect(exported?.findings[0]?.hop_trail).toEqual([
        { step: 1, kind: "trace", query: "read index.ts", reached: "" },
      ]);
    } finally {
      db.close();
    }
  });

  test("migrates a legacy user_version=1 database to version 2 seamlessly", async () => {
    const dbPath = await tmpDbPath();
    // Bootstrap a legacy v1 database
    const legacyDb = new Database(dbPath, { create: true });
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        run_dir TEXT NOT NULL UNIQUE,
        pr INTEGER NULL,
        checkout_path TEXT NULL,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        diff_from_sha TEXT NULL,
        run_status TEXT NOT NULL,
        session_failed INTEGER NULL,
        model TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        parity_hunter_fired INTEGER NOT NULL,
        prompt_set_name TEXT NULL,
        prompt_set_sha256 TEXT NULL,
        driver_sha TEXT NULL,
        engine_name TEXT NULL,
        engine_version TEXT NULL,
        summary_prose TEXT NULL,
        summary_score INTEGER NULL,
        summary_score_reason TEXT NULL,
        generated_at TEXT NOT NULL,
        wall_ms INTEGER NOT NULL,
        index_ms INTEGER NOT NULL,
        index_mode TEXT NULL,
        index_disk_mb REAL NULL,
        sync_ms INTEGER NULL,
        tokens_in INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL,
        tokens_total INTEGER NOT NULL,
        cost_usd_est REAL NOT NULL,
        blocking INTEGER NOT NULL,
        advisory INTEGER NOT NULL,
        root_causes_json TEXT NULL,
        greptile_found INTEGER NULL
      );
      CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        finding_id TEXT NOT NULL,
        category INTEGER NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        symbol TEXT NULL,
        severity TEXT NOT NULL,
        evidence_class TEXT NOT NULL,
        refuter_verdict TEXT NOT NULL,
        causal_disposition TEXT NOT NULL,
        claim TEXT NOT NULL,
        hunter TEXT NOT NULL,
        tier TEXT NOT NULL,
        hops_used INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL,
        root_cause_id TEXT NULL,
        finding_order INTEGER NOT NULL,
        UNIQUE (run_id, finding_id)
      );
      CREATE TABLE IF NOT EXISTS finding_proof_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id INTEGER NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
        ref_order INTEGER NOT NULL,
        proof_ref TEXT NOT NULL,
        UNIQUE (finding_id, ref_order)
      );
      CREATE TABLE IF NOT EXISTS finding_hop_trail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id INTEGER NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        step_num INTEGER NOT NULL,
        kind TEXT NOT NULL,
        query TEXT NOT NULL,
        reached TEXT NULL,
        UNIQUE (finding_id, step_order)
      );
      CREATE TABLE IF NOT EXISTS debug_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        finding_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        merged_into TEXT NULL,
        category INTEGER NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        symbol TEXT NULL,
        severity TEXT NOT NULL,
        evidence_class TEXT NOT NULL,
        refuter_verdict TEXT NOT NULL,
        causal_disposition TEXT NOT NULL,
        claim TEXT NOT NULL,
        proof_refs_json TEXT NOT NULL,
        hunter TEXT NOT NULL,
        hops_used INTEGER NOT NULL,
        hop_trail_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        root_cause_id TEXT NULL,
        debug_order INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_agents (
        run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        agent_key TEXT NOT NULL,
        tokens_total INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        tokens_in INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL,
        cost_usd_est REAL NOT NULL,
        attempts INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (run_id, agent_key)
      );
      CREATE TABLE IF NOT EXISTS comparison_rows (
        run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        row_index INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        greptile_json TEXT NULL,
        prhero_json TEXT NULL,
        verdict TEXT NULL,
        reasoning TEXT NULL,
        actor TEXT NULL,
        PRIMARY KEY (run_id, row_index)
      );
      INSERT INTO runs (id, repo_id, run_dir, head_sha, base_sha, run_status, model, iteration, parity_hunter_fired, generated_at, wall_ms, index_ms, tokens_in, tokens_out, tokens_total, cost_usd_est, blocking, advisory)
      VALUES (1, 'github.com/org/legacy', 'legacy-run-1', 'headsha', 'basesha', 'complete', 'sonnet', 0, 0, '2026-08-20T00:00:00.000Z', 1000, 100, 1000, 100, 1100, 0.05, 1, 0);
      INSERT INTO findings (id, run_id, finding_id, category, path, line, severity, evidence_class, refuter_verdict, causal_disposition, claim, hunter, tier, hops_used, dedupe_key, finding_order)
      VALUES (100, 1, 'F001', 1, 'src/legacy.ts', 10, 'BLOCKER', 'deterministic', 'corroborated', 'introduced', 'Legacy bug', 'reliability', 'blocking', 1, 'src/legacy.ts:10:1', 0);
      PRAGMA user_version = 1;
    `);
    legacyDb.close();

    // Open via openProductStore, which must migrate it to current version without cascade deletes
    const migratedDb = openProductStore(dbPath);
    try {
      const version = (
        migratedDb.query("PRAGMA user_version;").get() as {
          user_version: number;
        }
      ).user_version;
      expect(version).toBe(CURRENT_PRODUCT_SCHEMA_VERSION);

      // Verify that the legacy run and finding were NOT cascade deleted during DROP TABLE runs
      const legacyRun = getRunById(migratedDb, 1);
      expect(legacyRun).not.toBeNull();
      expect(legacyRun?.run_dir).toBe("legacy-run-1");

      const legacyFindings = migratedDb
        .query("SELECT * FROM findings WHERE run_id = 1")
        .all();
      expect(legacyFindings.length).toBe(1);

      // Verify saveRunTransaction works cleanly with ON CONFLICT(repo_id, run_dir)
      const runId = saveRunTransaction(
        migratedDb,
        projectCompleteRun({
          doc: sampleDoc(),
          repoId: "github.com/org/migrated",
          runDir: "run-v2",
          checkoutPath: null,
        }),
      );
      expect(runId).toBeGreaterThan(0);

      const exported = exportFindingsDocument(migratedDb, runId);
      expect(exported).not.toBeNull();
    } finally {
      migratedDb.close();
    }
  });

  test("records and retrieves finding triage events with cascade deletion on run delete", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const runId = saveRunTransaction(
        db,
        projectCompleteRun({
          doc: sampleDoc(),
          repoId: "github.com/org/triage-repo",
          runDir: "run-triage-1",
          checkoutPath: null,
        }),
      );

      const triageId = recordFindingTriage(db, {
        run_id: runId,
        finding_id: "F001",
        comment_id: 12345,
        tag: "applied",
        verdict: null,
        actor: "agent",
        reasoning: "Fixed in commit abc1234",
        issue_number: null,
        created_at: "2026-08-23T18:00:00.000Z",
      });

      expect(triageId).toBeGreaterThan(0);

      const events = getFindingTriageByRunId(db, runId);
      expect(events.length).toBe(1);
      expect(events[0]?.finding_id).toBe("F001");
      expect(events[0]?.tag).toBe("applied");
      expect(events[0]?.actor).toBe("agent");
      expect(events[0]?.reasoning).toBe("Fixed in commit abc1234");
      expect(events[0]?.comment_id).toBe(12345);

      // Deleting the run must cascade-delete the triage event
      db.query("DELETE FROM runs WHERE id = ?").run(runId);
      const afterDelete = getFindingTriageByRunId(db, runId);
      expect(afterDelete.length).toBe(0);
    } finally {
      db.close();
    }
  });

  test("migrates a user_version=2 database to current schema seamlessly", async () => {
    const dbPath = await tmpDbPath();
    const dbV2 = new Database(dbPath, { create: true });
    dbV2.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        run_dir TEXT NOT NULL,
        pr INTEGER NULL,
        checkout_path TEXT NULL,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        diff_from_sha TEXT NULL,
        run_status TEXT NOT NULL,
        session_failed INTEGER NULL,
        model TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        parity_hunter_fired INTEGER NOT NULL,
        prompt_set_name TEXT NULL,
        prompt_set_sha256 TEXT NULL,
        driver_sha TEXT NULL,
        engine_name TEXT NULL,
        engine_version TEXT NULL,
        summary_prose TEXT NULL,
        summary_score INTEGER NULL,
        summary_score_reason TEXT NULL,
        generated_at TEXT NOT NULL,
        wall_ms INTEGER NOT NULL,
        index_ms INTEGER NOT NULL,
        index_mode TEXT NULL,
        index_disk_mb REAL NULL,
        sync_ms INTEGER NULL,
        tokens_in INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL,
        tokens_total INTEGER NOT NULL,
        cost_usd_est REAL NOT NULL,
        blocking INTEGER NOT NULL,
        advisory INTEGER NOT NULL,
        root_causes_json TEXT NULL,
        greptile_found INTEGER NULL,
        UNIQUE (repo_id, run_dir)
      );
      PRAGMA user_version = 2;
    `);
    dbV2.close();

    const dbV3 = openProductStore(dbPath);
    try {
      const version = (
        dbV3.query("PRAGMA user_version;").get() as { user_version: number }
      ).user_version;
      expect(version).toBe(CURRENT_PRODUCT_SCHEMA_VERSION);

      const tableExists = dbV3
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='finding_triage'",
        )
        .get();
      expect(tableExists).not.toBeNull();

      const diversityTable = dbV3
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='diversity_attempts'",
        )
        .get();
      expect(diversityTable).not.toBeNull();
    } finally {
      dbV3.close();
    }
  });

  test("migrates a user_version=3 database to current schema with v4 columns", async () => {
    const dbPath = await tmpDbPath();
    const dbV3 = new Database(dbPath, { create: true });
    dbV3.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        run_dir TEXT NOT NULL,
        pr INTEGER NULL,
        checkout_path TEXT NULL,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        diff_from_sha TEXT NULL,
        run_status TEXT NOT NULL,
        session_failed INTEGER NULL,
        model TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        parity_hunter_fired INTEGER NOT NULL,
        prompt_set_name TEXT NULL,
        prompt_set_sha256 TEXT NULL,
        driver_sha TEXT NULL,
        engine_name TEXT NULL,
        engine_version TEXT NULL,
        summary_prose TEXT NULL,
        summary_score INTEGER NULL,
        summary_score_reason TEXT NULL,
        generated_at TEXT NOT NULL,
        wall_ms INTEGER NOT NULL,
        index_ms INTEGER NOT NULL,
        index_mode TEXT NULL,
        index_disk_mb REAL NULL,
        sync_ms INTEGER NULL,
        tokens_in INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL,
        tokens_total INTEGER NOT NULL,
        cost_usd_est REAL NOT NULL,
        blocking INTEGER NOT NULL,
        advisory INTEGER NOT NULL,
        root_causes_json TEXT NULL,
        greptile_found INTEGER NULL,
        UNIQUE (repo_id, run_dir)
      );
      PRAGMA user_version = 3;
    `);
    dbV3.close();

    const dbV4 = openProductStore(dbPath);
    try {
      const version = (
        dbV4.query("PRAGMA user_version;").get() as { user_version: number }
      ).user_version;
      expect(version).toBe(CURRENT_PRODUCT_SCHEMA_VERSION);

      const columns = (
        dbV4.query("PRAGMA table_info(runs);").all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toContain("findings_schema_version");
      expect(columns).toContain("engine_revision");
      expect(columns).toContain("diversity_plan_json");
    } finally {
      dbV4.close();
    }
  });

  test("v1.1 round-trip preserves schema_version and engine revision", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const originalDoc = sampleDoc({
        schema_version: "1.1.0",
        engine: { name: "pr-hero", version: "0.3.0", revision: "abc123def" },
      });
      const projected = projectCompleteRun({
        doc: originalDoc,
        repoId: REPO_ID,
        runDir: "run-v11",
        checkoutPath: null,
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const runId = saveRunTransaction(db, projected);
      const exported = exportFindingsDocument(db, runId);
      expect(exported).toEqual(originalDoc);
    } finally {
      db.close();
    }
  });

  test("legacy v1.0 rows backfill findings_schema_version on export", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const originalDoc = sampleDoc({ schema_version: "1.0.0" });
      const projected = projectCompleteRun({
        doc: originalDoc,
        repoId: REPO_ID,
        runDir: "run-v10",
        checkoutPath: null,
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const runId = saveRunTransaction(db, projected);
      db.query(
        "UPDATE runs SET findings_schema_version = '1.0.0' WHERE id = ?",
      ).run(runId);

      const exported = exportFindingsDocument(db, runId);
      expect(exported?.schema_version).toBe("1.0.0");
      expect(exported).toEqual(originalDoc);
    } finally {
      db.close();
    }
  });
});
