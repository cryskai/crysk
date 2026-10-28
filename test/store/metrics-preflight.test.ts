// Pure-decision tests for the observability store (W4 / GitHub #23): the v1
// DDL migration and the row projection from a completed run's already-on-
// disk facts (FindingsDocument, per-agent usage)
// into the flat rows store/metrics.ts's I/O shell writes. No fs, no sqlite, no
// clock — the shell (store/metrics.ts) supplies generatedAt and owns the file
// handle.

import { describe, expect, test } from "bun:test";
import type { Finding, FindingsDocument } from "#review/findings";
import type { PerAgentUsage } from "#review/pipeline";
import {
  CURRENT_SCHEMA_VERSION,
  migrationsFor,
  projectRunRow,
  type RunRow,
  renderUsage,
} from "#store/metrics-preflight";

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
    findings: [baseFinding(), baseFinding({ id: "F002", tier: "advisory" })],
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

describe("migrationsFor", () => {
  test("version 0 returns the v1 DDL for runs and its child tables", () => {
    const migration = migrationsFor(0);
    expect(migration.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migration.statements.length).toBeGreaterThan(0);
    const sql = migration.statements.join("\n");
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("runs");
    expect(sql).toContain("repo_id");
    expect(sql).toMatch(/run_dir\s+TEXT\s+NOT\s+NULL\s+UNIQUE/);
    expect(sql).toMatch(/pr\s+INTEGER/);
    expect(sql).toMatch(/checkout_path\s+TEXT/);
    // Child tables: per-agent usage, and comparison rows (historical, never written now).
    expect(sql).toContain("run_agents");
    expect(sql).toContain("comparison_rows");
  });

  test("an up-to-date version returns no statements", () => {
    const migration = migrationsFor(CURRENT_SCHEMA_VERSION);
    expect(migration.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migration.statements).toEqual([]);
  });
});

describe("projectRunRow", () => {
  test("a local run (pr === 0) projects to RunRow.pr = null", () => {
    const projected = projectRunRow({
      doc: baseDoc({ pr: 0 }),
      perAgent: PER_AGENT,
      repoId: "github.com/juanmaagd/musive",
      runDir: "/runs/local-1",
      checkoutPath: "/Users/x/Desktop/musive",
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    expect(projected.run.pr).toBeNull();
    expect(projected.run.repo_id).toBe("github.com/juanmaagd/musive");
    expect(projected.run.run_dir).toBe("/runs/local-1");
    expect(projected.run.checkout_path).toBe("/Users/x/Desktop/musive");
    expect(projected.run.head_sha).toBe("b".repeat(40));
    expect(projected.run.base_sha).toBe("a".repeat(40));
    expect(projected.run.run_status).toBe("complete");
    expect(projected.run.session_failed).toBe(0);
    expect(projected.run.model).toBe("sonnet");
    expect(projected.run.generated_at).toBe("2026-08-15T12:00:00.000Z");
    expect(projected.run.wall_ms).toBe(5000);
    expect(projected.run.tokens_total).toBe(150);
    expect(projected.run.cost_usd_est).toBe(0.42);
    // One blocking (F001) + one advisory (F002) finding, per baseDoc.
    expect(projected.run.blocking).toBe(1);
    expect(projected.run.advisory).toBe(1);
    expect(projected.agents).toEqual([
      {
        agent_key: "reliability",
        tokens_total: 100,
        duration_ms: 4000,
        tokens_in: 70,
        tokens_out: 30,
        cost_usd_est: 0.3,
        attempts: 1,
        status: "ok",
      },
    ]);
  });

  test("a PR run keeps the numeric pr and projects no comparison rows", () => {
    const projected = projectRunRow({
      doc: baseDoc({ pr: 42 }),
      perAgent: PER_AGENT,
      repoId: "github.com/juanmaagd/musive",
      runDir: "/runs/pr-42-1",
      checkoutPath: "/Users/x/Desktop/musive",
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    expect(projected.run.pr).toBe(42);
    expect("comparisonRows" in projected).toBe(false);
  });

  test("a session-failed run stores session_failed = 1", () => {
    const projected = projectRunRow({
      doc: baseDoc({ pr: 0, sessionFailed: true }),
      perAgent: {},
      repoId: "github.com/a/b",
      runDir: "/runs/local-2",
      checkoutPath: null,
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    expect(projected.run.session_failed).toBe(1);
    expect(projected.run.checkout_path).toBeNull();
  });

  test("threat matrix: repo_id is the passed repoId, never derived from checkoutPath", () => {
    const first = projectRunRow({
      doc: baseDoc({ pr: 0 }),
      perAgent: {},
      repoId: "github.com/juanmaagd/musive",
      runDir: "/runs/s1-1",
      checkoutPath: "/Users/x/Desktop/musive/musive-s1",
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    const second = projectRunRow({
      doc: baseDoc({ pr: 0 }),
      perAgent: {},
      repoId: "github.com/juanmaagd/musive",
      runDir: "/runs/s3-1",
      checkoutPath: "/Users/x/Desktop/musive/musive-s3",
      generatedAt: "2026-08-15T12:00:00.000Z",
    });
    expect(first.run.repo_id).toBe("github.com/juanmaagd/musive");
    expect(second.run.repo_id).toBe("github.com/juanmaagd/musive");
    expect(first.run.repo_id).toBe(second.run.repo_id);
    expect(first.run.run_dir).not.toBe(second.run.run_dir);
    expect(first.run.checkout_path).not.toBe(second.run.checkout_path);
  });
});

function baseRunRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    repo_id: "github.com/juanmaagd/musive",
    run_dir: "/runs/local-1",
    pr: null,
    checkout_path: "/Users/x/Desktop/musive",
    head_sha: "b".repeat(40),
    base_sha: "a".repeat(40),
    run_status: "complete",
    session_failed: 0,
    model: "sonnet",
    generated_at: "2026-08-15T12:00:00.000Z",
    wall_ms: 5000,
    index_ms: 0,
    tokens_in: 100,
    tokens_out: 50,
    tokens_total: 150,
    cost_usd_est: 0.42,
    blocking: 1,
    advisory: 0,
    ...overrides,
  };
}

describe("renderUsage", () => {
  test("renders a header, one line per row (local pr as 'local', PR kept numeric), and a totals footer", () => {
    const rows: RunRow[] = [
      baseRunRow({ pr: null, run_dir: "/runs/local-1" }),
      baseRunRow({
        pr: 42,
        run_dir: "/runs/pr-42-1",
        cost_usd_est: 0.08,
        tokens_total: 90,
        blocking: 0,
        advisory: 2,
      }),
    ];
    const lines = renderUsage(rows, { styles: false });
    expect(Array.isArray(lines)).toBe(true);
    const joined = lines.join("\n");
    expect(joined).toContain("local");
    expect(joined).toContain("42");
    expect(joined).toContain("/runs/local-1");
    expect(joined).toContain("/runs/pr-42-1");
    // Totals footer: a real sum over the two rows, not a hardcoded value —
    // proves the function actually reduced over its input.
    expect(joined).toContain("2 run(s)");
    expect(joined).toContain("$0.50");
    expect(joined).toContain("240");
  });

  test("triangulation: a different row set produces different totals", () => {
    const rows: RunRow[] = [
      baseRunRow({ cost_usd_est: 1.5, tokens_total: 500 }),
    ];
    const lines = renderUsage(rows, { styles: false });
    const joined = lines.join("\n");
    expect(joined).toContain("1 run(s)");
    expect(joined).toContain("$1.50");
    expect(joined).toContain("500");
  });

  test("zero rows still renders a header and a $0.00 totals footer, no crash", () => {
    const lines = renderUsage([], { styles: false });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("0 run(s)");
    expect(lines.join("\n")).toContain("$0.00");
  });

  test("styles disabled: no line contains an ANSI escape byte", () => {
    const rows: RunRow[] = [baseRunRow(), baseRunRow({ pr: 7 })];
    const lines = renderUsage(rows, { styles: false });
    for (const line of lines) {
      expect(line).not.toContain("\x1b");
    }
  });
});
