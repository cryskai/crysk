// Integration tests for the observability store's bun:sqlite shell (W4 /
// GitHub #23): db creation + migration + WAL, ingest (parent upsert, child
// replace, no double-ingest duplication), origin-scoped vs --all reads, and
// the fail-soft wrapper cli.ts calls after every completed review. Every
// test opens a fresh tmp-dir db — no shared state, no ~/.prhero touched.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Finding, FindingsDocument } from "#review/findings";
import type { PerAgentUsage } from "#review/pipeline";
import { runGc } from "#store/gc";
import {
  failSoftIngest,
  ingestRun,
  openMetricsDb,
  queryUsage,
} from "#store/metrics";
import { prheroLayout, repoHomePaths } from "../../src/home-preflight";

async function tmpDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-metrics-"));
  return path.join(dir, "metrics.db");
}

function baseFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    category: 1,
    path: "src/thing.ts",
    line: 10,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "a real defect",
    proof_refs: ["diff-hunk#1"],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "src/thing.ts:1",
    ...overrides,
  };
}

function baseDoc(overrides: Partial<FindingsDocument> = {}): FindingsDocument {
  return {
    schema_version: "1.0.0",
    pr: 0,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    model: "sonnet",
    iteration: 0,
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: {
      index_ms: 0,
      index_mode: "sync",
      index_disk_mb: 0,
      wall_ms: 5000,
      tokens_in: 100,
      tokens_out: 50,
      tokens_total: 150,
      cost_usd_est: 0.42,
    },
    findings: [baseFinding()],
    debug: { refuted: [] },
    ...overrides,
  };
}

const PER_AGENT: Record<string, PerAgentUsage> = {
  reliability: {
    tokens_total: 100,
    duration_ms: 4000,
    tokens_in: 70,
    tokens_out: 30,
    cost_usd_est: 0.3,
    attempts: 1,
    status: "ok",
  },
};

const REPO_A = "github.com/juanmaagd/musive";
const REPO_B = "github.com/juanmaagd/other";

describe("openMetricsDb", () => {
  test("creates the file, migrates to the current version, and sets WAL + busy_timeout", async () => {
    const dbPath = await tmpDbPath();
    const db = openMetricsDb(dbPath);
    try {
      const journalMode = db.query("PRAGMA journal_mode;").get() as {
        journal_mode: string;
      };
      expect(journalMode.journal_mode.toLowerCase()).toBe("wal");
      const busyTimeout = db.query("PRAGMA busy_timeout;").get() as {
        timeout: number;
      };
      expect(busyTimeout.timeout).toBe(5000);
      const version = db.query("PRAGMA user_version;").get() as {
        user_version: number;
      };
      expect(version.user_version).toBe(1);
      // The table exists and is empty — proves the DDL actually ran.
      const rows = db.query("SELECT COUNT(*) as n FROM runs;").get() as {
        n: number;
      };
      expect(rows.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("re-opening an already-migrated db is a no-op, not a re-run", async () => {
    const dbPath = await tmpDbPath();
    const first = openMetricsDb(dbPath);
    first.close();
    const second = openMetricsDb(dbPath);
    try {
      const version = second.query("PRAGMA user_version;").get() as {
        user_version: number;
      };
      expect(version.user_version).toBe(1);
    } finally {
      second.close();
    }
  });
});

describe("ingestRun + queryUsage", () => {
  test("writes a run row and its per-agent child rows, readable back", async () => {
    const dbPath = await tmpDbPath();
    ingestRun({
      dbPath,
      repoId: REPO_A,
      runDir: "/runs/local-1",
      checkoutPath: "/Users/x/Desktop/musive",
      doc: baseDoc({ pr: 0 }),
      perAgent: PER_AGENT,
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    const rows = queryUsage(dbPath, { repoId: REPO_A });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo_id: REPO_A,
      run_dir: "/runs/local-1",
      pr: null,
      checkout_path: "/Users/x/Desktop/musive",
      blocking: 1,
      advisory: 0,
    });
  });

  test("a PR run keeps the numeric pr, and re-ingest keeps comparison rows stored before", async () => {
    const dbPath = await tmpDbPath();
    const ingestPr = () =>
      ingestRun({
        dbPath,
        repoId: REPO_A,
        runDir: "/runs/pr-42-1",
        checkoutPath: "/Users/x/Desktop/musive",
        doc: baseDoc({ pr: 42 }),
        perAgent: PER_AGENT,
        generatedAt: "2026-08-15T12:00:00.000Z",
      });
    ingestPr();
    // A verdict written before the retirement. No writer creates these any more.
    const seed = new Database(dbPath);
    try {
      seed
        .query(
          `INSERT INTO comparison_rows (run_id, row_index, bucket, greptile_json, prhero_json, verdict, reasoning, actor)
           VALUES ((SELECT id FROM runs WHERE run_dir = ?), 0, 'prhero_only', NULL, NULL, 'prhero-false-positive', 'kept', 'human')`,
        )
        .run("/runs/pr-42-1");
    } finally {
      seed.close();
    }
    ingestPr();
    const rows = queryUsage(dbPath, { repoId: REPO_A });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pr).toBe(42);
    const db = new Database(dbPath, { readonly: true });
    try {
      const compRows = db
        .query("SELECT verdict FROM comparison_rows;")
        .all() as { verdict: string }[];
      expect(compRows).toEqual([{ verdict: "prhero-false-positive" }]);
    } finally {
      db.close();
    }
  });

  test("double ingest of the same run_dir upserts the parent and replaces children, never duplicates", async () => {
    const dbPath = await tmpDbPath();
    const ingestOnce = (wallMs: number) =>
      ingestRun({
        dbPath,
        repoId: REPO_A,
        runDir: "/runs/local-1",
        checkoutPath: "/Users/x/Desktop/musive",
        doc: baseDoc({
          pr: 0,
          telemetry: { ...baseDoc().telemetry, wall_ms: wallMs },
        }),
        perAgent: PER_AGENT,
        generatedAt: "2026-08-15T12:00:00.000Z",
      });
    ingestOnce(5000);
    ingestOnce(9000);
    const rows = queryUsage(dbPath, { repoId: REPO_A });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.wall_ms).toBe(9000);
    const db = new Database(dbPath, { readonly: true });
    try {
      const agentRows = db
        .query("SELECT * FROM run_agents;")
        .all() as unknown[];
      // ONE agent (reliability), not two — a double ingest must not
      // duplicate child rows.
      expect(agentRows).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("threat matrix: two checkoutPaths under one repoId share repo_id but keep distinct run_dirs, and scoped queryUsage leaks nothing else", async () => {
    const dbPath = await tmpDbPath();
    ingestRun({
      dbPath,
      repoId: REPO_A,
      runDir: "/runs/s1-1",
      checkoutPath: "/Users/x/Desktop/musive/musive-s1",
      doc: baseDoc({ pr: 0 }),
      perAgent: {},
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    ingestRun({
      dbPath,
      repoId: REPO_A,
      runDir: "/runs/s3-1",
      checkoutPath: "/Users/x/Desktop/musive/musive-s3",
      doc: baseDoc({ pr: 0 }),
      perAgent: {},
      generatedAt: "2026-08-15T12:00:01.000Z",
    });
    ingestRun({
      dbPath,
      repoId: REPO_B,
      runDir: "/runs/other-1",
      checkoutPath: "/Users/x/Desktop/other",
      doc: baseDoc({ pr: 0 }),
      perAgent: {},
      generatedAt: "2026-08-15T12:00:02.000Z",
    });
    const scoped = queryUsage(dbPath, { repoId: REPO_A });
    expect(scoped).toHaveLength(2);
    expect(scoped.every((r) => r.repo_id === REPO_A)).toBe(true);
    expect(new Set(scoped.map((r) => r.run_dir)).size).toBe(2);
    expect(scoped.some((r) => r.repo_id === REPO_B)).toBe(false);
  });

  test("--all shows rows from every repo_id", async () => {
    const dbPath = await tmpDbPath();
    ingestRun({
      dbPath,
      repoId: REPO_A,
      runDir: "/runs/a-1",
      checkoutPath: null,
      doc: baseDoc({ pr: 0 }),
      perAgent: {},
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    ingestRun({
      dbPath,
      repoId: REPO_B,
      runDir: "/runs/b-1",
      checkoutPath: null,
      doc: baseDoc({ pr: 0 }),
      perAgent: {},
      generatedAt: "2026-08-15T12:00:01.000Z",
    });
    const all = queryUsage(dbPath, { all: true });
    expect(all).toHaveLength(2);
    const repoIds = new Set(all.map((r) => r.repo_id));
    expect(repoIds).toEqual(new Set([REPO_A, REPO_B]));
  });
});

describe("failSoftIngest", () => {
  test("an ingest failure warns with the exact copy and never throws", () => {
    const warnings: string[] = [];
    const boom = () => {
      throw new Error("disk full");
    };
    expect(() =>
      failSoftIngest({
        dbPath: "/tmp/does-not-matter.db",
        repoId: REPO_A,
        runDir: "/runs/local-1",
        checkoutPath: "/Users/x/Desktop/musive",
        doc: baseDoc(),
        perAgent: {},
        log: (line) => warnings.push(line),
        ingest: boom,
      }),
    ).not.toThrow();
    expect(warnings).toEqual([
      "warning: metrics ingest failed — the review itself is intact: disk full",
    ]);
  });

  test("a null repoId (no resolvable origin) skips ingest with the same warning prefix", () => {
    const warnings: string[] = [];
    const ingestSpy = () => {
      throw new Error("should never be called");
    };
    failSoftIngest({
      dbPath: "/tmp/does-not-matter.db",
      repoId: null,
      runDir: "/runs/local-1",
      checkoutPath: "/Users/x/Desktop/musive",
      doc: baseDoc(),
      perAgent: {},
      log: (line) => warnings.push(line),
      ingest: ingestSpy,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith(
      "warning: metrics ingest failed — the review itself is intact:",
    );
  });

  test("a real, successful ingest logs nothing", async () => {
    const dbPath = await tmpDbPath();
    const warnings: string[] = [];
    failSoftIngest({
      dbPath,
      repoId: REPO_A,
      runDir: "/runs/local-1",
      checkoutPath: "/Users/x/Desktop/musive",
      doc: baseDoc(),
      perAgent: {},
      log: (line) => warnings.push(line),
    });
    expect(warnings).toEqual([]);
    expect(queryUsage(dbPath, { repoId: REPO_A })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// W4 Phase 6 remediation (sdd-verify option D, scenarios "GC after ingest"
// and "Pre-ship run dirs ignored"). Both close a PARTIAL verdict from
// verify-report #3683 by driving the REAL consumer (runGc) or asserting the
// REAL absence of a scanner, rather than only a structural path invariant.

async function tmpHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pr-hero-metrics-home-"));
}

describe("GC immunity end-to-end (spec: GC after ingest)", () => {
  test("runGc sweeping a home with a populated metrics.db never touches it, and the ingested row survives", async () => {
    const home = await tmpHome();
    const dbPath = prheroLayout(home).metricsDbPath;
    ingestRun({
      dbPath,
      repoId: REPO_A,
      runDir: "/runs/local-1",
      checkoutPath: "/Users/x/Desktop/musive",
      doc: baseDoc({ pr: 0 }),
      perAgent: PER_AGENT,
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    // A registry.json + a worktree dir is exactly what discoverWorktrees
    // (store/gc.ts) scans for — git_dir_owner only needs to exist as a directory
    // (ghPrStateJson's cwd), it does not need to be a real git repo.
    const gitDirOwner = await mkdtemp(
      path.join(tmpdir(), "pr-hero-metrics-owner-"),
    );
    const repoRoot = repoHomePaths(home, REPO_A).root;
    await mkdir(repoRoot, { recursive: true });
    await Bun.write(
      path.join(repoRoot, "registry.json"),
      JSON.stringify({
        canonical_remote: REPO_A,
        origin_url: "https://github.com/juanmaagd/musive.git",
        git_dir_owner: gitDirOwner,
        operator_checkouts: [gitDirOwner],
        worktrees: {},
      }),
    );
    await mkdir(path.join(repoHomePaths(home, REPO_A).worktrees, "pr-1"), {
      recursive: true,
    });

    const result = await runGc({ home, dryRun: true, silent: true });

    expect(result.failed).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
    const rows = queryUsage(dbPath, { repoId: REPO_A });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.run_dir).toBe("/runs/local-1");
  });
});

describe("No backfill (spec: Pre-ship run dirs ignored)", () => {
  test("a fresh store ignores a legacy *-prhero-runs directory sitting on disk", async () => {
    const home = await tmpHome();
    const legacyRunsDir = path.join(home, "musive-prhero-runs");
    await mkdir(path.join(legacyRunsDir, "a".repeat(40)), {
      recursive: true,
    });
    await Bun.write(
      path.join(legacyRunsDir, "a".repeat(40), "findings.json"),
      JSON.stringify(baseDoc()),
    );

    const dbPath = prheroLayout(home).metricsDbPath;
    openMetricsDb(dbPath).close();

    expect(queryUsage(dbPath, { all: true })).toEqual([]);
  });

  test("companion: a run actually ingested through the normal path IS visible", async () => {
    const home = await tmpHome();
    const dbPath = prheroLayout(home).metricsDbPath;
    ingestRun({
      dbPath,
      repoId: REPO_A,
      runDir: "/runs/local-1",
      checkoutPath: null,
      doc: baseDoc({ pr: 0 }),
      perAgent: {},
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    expect(queryUsage(dbPath, { all: true })).toHaveLength(1);
  });
});
