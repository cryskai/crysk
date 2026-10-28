// The observability store (W4 / GitHub #23), pure half: the v1 schema DDL
// and the projection from a completed run's already-on-disk facts
// (FindingsDocument, per-agent usage) into the
// flat rows store/metrics.ts's bun:sqlite shell writes. Artifacts on disk stay the
// source of truth — this module only reshapes what already exists into rows,
// it never reads a file or opens a connection.
//
// No backfill (proposal, decided): the dataset starts empty and grows one
// ingest at a time, from the very next completed review after ship.

import type { FindingsDocument, RunStatus } from "#review/findings";
import type { PerAgentUsage } from "#review/pipeline";

export const CURRENT_SCHEMA_VERSION = 1;

export interface SchemaMigration {
  toVersion: number;
  statements: string[];
}

// `runs.run_dir` is the unique run key (design decision table): a run that
// cost money never collides, and re-ingesting the same run_dir upserts the
// parent row instead of duplicating it. `repo_id` is a column, never part of
// a path — two checkouts of the same origin SHARE it, the same way they
// share worktrees (W3). `pr` is nullable SQL, not a sentinel 0: the document
// already stamps local runs `pr: 0` (schema 1.0.0, unchanged), and the
// ingest layer maps that to NULL — the real "not a PR" value.
const V1_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    run_dir TEXT NOT NULL UNIQUE,
    pr INTEGER NULL,
    checkout_path TEXT NULL,
    head_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    run_status TEXT NOT NULL,
    session_failed INTEGER NOT NULL,
    model TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    wall_ms INTEGER NOT NULL,
    index_ms INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    tokens_total INTEGER NOT NULL,
    cost_usd_est REAL NOT NULL,
    blocking INTEGER NOT NULL,
    advisory INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_repo_id ON runs (repo_id)`,
  // Child tables key off the PARENT ROWID, not run_dir directly: a re-ingest
  // deletes and reinserts these by run_id so a double ingest of the same
  // run_dir never duplicates child rows (spec "Idempotent Run Identity").
  `CREATE TABLE IF NOT EXISTS run_agents (
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
  )`,
  `CREATE TABLE IF NOT EXISTS comparison_rows (
    run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    bucket TEXT NOT NULL,
    greptile_json TEXT NULL,
    prhero_json TEXT NULL,
    verdict TEXT NULL,
    reasoning TEXT NULL,
    actor TEXT NULL,
    PRIMARY KEY (run_id, row_index)
  )`,
];

// PRAGMA user_version-based versioning (design decision table, over a
// version table): the shell reads the current value, asks this pure
// function what to run, executes the statements, then stamps the pragma.
// Additive only for now — v1 is the whole schema this PR ships.
export function migrationsFor(currentVersion: number): SchemaMigration {
  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return { toVersion: currentVersion, statements: [] };
  }
  return { toVersion: CURRENT_SCHEMA_VERSION, statements: [...V1_STATEMENTS] };
}

export interface RunRow {
  repo_id: string;
  run_dir: string;
  pr: number | null;
  checkout_path: string | null;
  head_sha: string;
  base_sha: string;
  run_status: RunStatus;
  session_failed: 0 | 1;
  model: string;
  generated_at: string;
  wall_ms: number;
  index_ms: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  cost_usd_est: number;
  blocking: number;
  advisory: number;
}

export interface RunAgentRow {
  agent_key: string;
  tokens_total: number;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd_est: number;
  attempts: number;
  status: string;
}

export interface ProjectedRun {
  run: RunRow;
  agents: RunAgentRow[];
}

// The ONLY place a completed run's on-disk facts become sqlite rows. Pure:
// the caller (store/metrics.ts's ingestRun) supplies repoId (from the SAME
// resolveRepoHome call the run dir already paid for — never re-derived from
// checkoutPath, which is diagnostic metadata only) and generatedAt (the
// shell's clock). `doc.pr === 0` is schema 1.0.0's "not a PR" sentinel
// (review/findings.ts, unchanged) — this is the one place it becomes real SQL NULL.
export function projectRunRow(input: {
  doc: FindingsDocument;
  perAgent: Record<string, PerAgentUsage>;
  repoId: string;
  runDir: string;
  checkoutPath: string | null;
  generatedAt: string;
}): ProjectedRun {
  let blocking = 0;
  let advisory = 0;
  for (const finding of input.doc.findings) {
    if (finding.tier === "blocking") blocking++;
    else advisory++;
  }
  const run: RunRow = {
    repo_id: input.repoId,
    run_dir: input.runDir,
    pr: input.doc.pr === 0 ? null : input.doc.pr,
    checkout_path: input.checkoutPath,
    head_sha: input.doc.head_sha,
    base_sha: input.doc.base_sha,
    run_status: input.doc.run_status,
    session_failed: input.doc.sessionFailed ? 1 : 0,
    model: input.doc.model,
    generated_at: input.generatedAt,
    wall_ms: input.doc.telemetry.wall_ms,
    index_ms: input.doc.telemetry.index_ms,
    tokens_in: input.doc.telemetry.tokens_in,
    tokens_out: input.doc.telemetry.tokens_out,
    tokens_total: input.doc.telemetry.tokens_total,
    cost_usd_est: input.doc.telemetry.cost_usd_est,
    blocking,
    advisory,
  };
  const agents: RunAgentRow[] = Object.entries(input.perAgent).map(
    ([agentKey, usage]) => ({
      agent_key: agentKey,
      tokens_total: usage.tokens_total,
      duration_ms: usage.duration_ms,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      cost_usd_est: usage.cost_usd_est,
      attempts: usage.attempts,
      status: usage.status,
    }),
  );
  return { run, agents };
}

export interface RenderUsageOptions {
  // Accepted for the same reason every other renderer in this codebase
  // (ui/result.ts, ui/tree.ts) takes a styles flag — a uniform signature
  // across renderers, so a caller never special-cases one of them. Usage
  // is a PIPEABLE REPORT (design decision table: "not ui-*.ts painted"):
  // this module never imports ui.ts's ANSI helpers, so there is nothing to
  // turn off — the output is unconditionally free of escape bytes.
  styles: boolean;
}

// `pr-hero usage`'s render, pure (spec "Plain-Text Rendering"): a markdown
// table (one line per run, `pr` mapped back to "local" for the NULL rows
// projectRunRow produced) plus a totals footer that is a real reduction
// over the input, never a placeholder — cli.ts prints these lines straight
// to stdout (human notes on stderr via log(), the report itself on stdout).
export function renderUsage(
  rows: RunRow[],
  _options: RenderUsageOptions,
): string[] {
  const out: string[] = [];
  out.push(
    "| generated_at | repo_id | pr | status | blocking | advisory | " +
      "tokens | cost | run_dir |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const status =
      row.run_status + (row.session_failed ? " (session failed)" : "");
    out.push(
      `| ${row.generated_at} | ${row.repo_id} | ${row.pr ?? "local"} | ` +
        `${status} | ${row.blocking} | ${row.advisory} | ` +
        `${row.tokens_total} | $${row.cost_usd_est.toFixed(2)} | ` +
        `${row.run_dir} |`,
    );
  }
  let totalCost = 0;
  let totalTokens = 0;
  for (const row of rows) {
    totalCost += row.cost_usd_est;
    totalTokens += row.tokens_total;
  }
  out.push("");
  out.push(
    `${rows.length} run(s) — $${totalCost.toFixed(2)} total, ` +
      `${totalTokens} tokens.`,
  );
  return out;
}
