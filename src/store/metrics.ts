// The observability store (W4 / GitHub #23), impure half: the bun:sqlite
// file handle, the migration runner, the one-transaction ingest, the
// origin-scoped/--all read, and the fail-soft wrapper cli.ts calls after
// every completed review (local and PR). Everything decidable without a
// file handle lives in store/metrics-preflight.ts; this module only opens the db,
// runs statements, and closes it.
//
// Fail-soft is the load-bearing contract here (proposal risk table): a
// sqlite write must NEVER fail a paid review. `ingestRun` is allowed to
// throw — `failSoftIngest` is the ONLY caller cli.ts uses, and it is the
// one place that turns a throw into a warning.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { FindingsDocument } from "#review/findings";
import type { PerAgentUsage } from "#review/pipeline";
import {
  migrationsFor,
  projectRunRow,
  type RunAgentRow,
  type RunRow,
} from "./metrics-preflight";

// WAL + a 5s busy_timeout (design decision table, #35 concurrency out of
// scope): two reviews of two different repos never collide on one process,
// and a reader (`pr-hero usage`) never blocks a writer past a few ms.
const BUSY_TIMEOUT_MS = 5000;

export function openMetricsDb(dbPath: string): Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  const current = (
    db.query("PRAGMA user_version;").get() as { user_version: number }
  ).user_version;
  const migration = migrationsFor(current);
  if (migration.statements.length > 0) {
    db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
    })();
    // PRAGMA cannot bind a parameter — the value comes from our own
    // pure migrationsFor, never from caller input, so interpolation here
    // is not an injection surface.
    db.exec(`PRAGMA user_version = ${migration.toVersion};`);
  }
  return db;
}

export interface IngestRunInput {
  dbPath: string;
  repoId: string;
  runDir: string;
  checkoutPath: string | null;
  doc: FindingsDocument;
  perAgent: Record<string, PerAgentUsage>;
  generatedAt?: string;
}

const RUN_UPSERT_SQL = `
  INSERT INTO runs (
    repo_id, run_dir, pr, checkout_path, head_sha, base_sha, run_status,
    session_failed, model, generated_at, wall_ms, index_ms, tokens_in,
    tokens_out, tokens_total, cost_usd_est, blocking, advisory
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_dir) DO UPDATE SET
    repo_id = excluded.repo_id,
    pr = excluded.pr,
    checkout_path = excluded.checkout_path,
    head_sha = excluded.head_sha,
    base_sha = excluded.base_sha,
    run_status = excluded.run_status,
    session_failed = excluded.session_failed,
    model = excluded.model,
    generated_at = runs.generated_at,
    wall_ms = excluded.wall_ms,
    index_ms = excluded.index_ms,
    tokens_in = excluded.tokens_in,
    tokens_out = excluded.tokens_out,
    tokens_total = excluded.tokens_total,
    cost_usd_est = excluded.cost_usd_est,
    blocking = excluded.blocking,
    advisory = excluded.advisory
`;

function runParams(row: RunRow): SQLQueryBindings[] {
  return [
    row.repo_id,
    row.run_dir,
    row.pr,
    row.checkout_path,
    row.head_sha,
    row.base_sha,
    row.run_status,
    row.session_failed,
    row.model,
    row.generated_at,
    row.wall_ms,
    row.index_ms,
    row.tokens_in,
    row.tokens_out,
    row.tokens_total,
    row.cost_usd_est,
    row.blocking,
    row.advisory,
  ];
}

// ONE transaction: upsert the parent by run_dir (the unique run key), then
// DELETE + re-INSERT every child table scoped to that run's id. Delete-then-
// insert, never a diff, because the child sets are always small (one row
// per agent) and a diff buys nothing a
// full replace does not already give for free — spec "Idempotent Run
// Identity": a double ingest of the same run_dir must not duplicate rows.
export function ingestRun(input: IngestRunInput): void {
  const db = openMetricsDb(input.dbPath);
  try {
    const projected = projectRunRow({
      doc: input.doc,
      perAgent: input.perAgent,
      repoId: input.repoId,
      runDir: input.runDir,
      checkoutPath: input.checkoutPath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
    });
    db.transaction(() => {
      db.query(RUN_UPSERT_SQL).run(...runParams(projected.run));
      const runRow = db
        .query("SELECT id FROM runs WHERE run_dir = ?")
        .get(projected.run.run_dir) as { id: number };
      const runId = runRow.id;
      db.query("DELETE FROM run_agents WHERE run_id = ?").run(runId);
      insertAgents(db, runId, projected.agents);
    })();
  } finally {
    db.close();
  }
}

function insertAgents(
  db: Database,
  runId: number,
  agents: RunAgentRow[],
): void {
  if (agents.length === 0) return;
  const insert = db.query(`
    INSERT INTO run_agents (
      run_id, agent_key, tokens_total, duration_ms, tokens_in, tokens_out,
      cost_usd_est, attempts, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const agent of agents) {
    insert.run(
      runId,
      agent.agent_key,
      agent.tokens_total,
      agent.duration_ms,
      agent.tokens_in,
      agent.tokens_out,
      agent.cost_usd_est,
      agent.attempts,
      agent.status,
    );
  }
}

export interface UsageRow extends RunRow {}

export type UsageScope = { repoId: string } | { all: true };

// Origin-scoped by default (spec "Origin-Scoped Usage By Default"); `--all`
// is the operator-wide escape hatch. Reads only the parent `runs` table —
// PR2's renderUsage decides what, if anything, joins the child tables.
export function queryUsage(dbPath: string, scope: UsageScope): UsageRow[] {
  const db = openMetricsDb(dbPath);
  try {
    if ("all" in scope) {
      return db
        .query("SELECT * FROM runs ORDER BY generated_at DESC;")
        .all() as UsageRow[];
    }
    return db
      .query("SELECT * FROM runs WHERE repo_id = ? ORDER BY generated_at DESC;")
      .all(scope.repoId) as UsageRow[];
  } finally {
    db.close();
  }
}

export interface FailSoftIngestInput {
  dbPath: string;
  // null means no resolvable git origin for this run's checkout (W4 Phase 6
  // remediation, GitHub #23 option D): --out no longer bypasses the origin
  // lookup — createRunDir tries it via tryOriginRepoId, and this stays null
  // only when that lookup itself fails (no `origin` remote, or an empty
  // one) — the same "no resolvable origin" case every other global-state
  // path already refuses.
  repoId: string | null;
  runDir: string;
  checkoutPath: string | null;
  doc: FindingsDocument;
  perAgent: Record<string, PerAgentUsage>;
  log: (line: string) => void;
  // Test seam only — production always uses ingestRun.
  ingest?: (input: IngestRunInput) => void;
}

const WARNING_PREFIX =
  "warning: metrics ingest failed — the review itself is intact: ";

// The ONLY function cli.ts calls after writeFindings. Never
// throws — a sqlite failure (or a missing repo_id) degrades to a printed
// warning, and the review's own exit code is untouched (spec "Fail-Soft
// Ingest").
export function failSoftIngest(input: FailSoftIngestInput): void {
  if (input.repoId === null) {
    input.log(`${WARNING_PREFIX}no repo_id resolved for this run`);
    return;
  }
  const ingest = input.ingest ?? ingestRun;
  try {
    ingest({
      dbPath: input.dbPath,
      repoId: input.repoId,
      runDir: input.runDir,
      checkoutPath: input.checkoutPath,
      doc: input.doc,
      perAgent: input.perAgent,
    });
  } catch (error) {
    input.log(`${WARNING_PREFIX}${(error as Error).message}`);
  }
}
