// Canonical product store (Fundamentals #6 / observability-canonical-store.md),
// impure half: bun:sqlite file handle, transactional persistence, schema migrations,
// and exact round-trip deserialization.
//
// Invariant: The SQLite database is the canonical source of truth. JSON artifacts
// and reports are derived exports.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  type DebugDedupedFinding,
  type DebugRefutedFinding,
  type Finding,
  type FindingsDocument,
  type HopTrail,
  type HopTrailStep,
  type IndexMode,
  type RunSummary,
  SCHEMA_VERSION,
  type Telemetry,
  validateFindingsDocument,
} from "#review/findings";
import {
  type CanonicalFindingRow,
  type CanonicalRunRow,
  type DebugFindingRow,
  type FindingTriageRow,
  migrationsForProductStore,
  type ProjectedCompleteRun,
} from "./preflight";

const BUSY_TIMEOUT_MS = 5000;

export function openProductStore(dbPath: string): Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);

  const current = (
    db.query("PRAGMA user_version;").get() as { user_version: number }
  ).user_version;
  const migration = migrationsForProductStore(current);

  if (migration.statements.length > 0) {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
    })();
    db.exec(`PRAGMA user_version = ${migration.toVersion};`);
  }

  db.exec("PRAGMA foreign_keys = ON;");

  return db;
}

// `generated_at` on conflict: a live re-run into the same run dir (an explicit
// --out) is a new run, so its timestamp moves with its cost and head. The
// historical backfill keeps the stored one only for the SAME run (same head):
// it re-derives the time from artifacts and must not rewrite when that run
// happened. A different head is a later run whose live persist was missed, so
// it takes the artifact's own time along with its cost and head.
function runUpsertSql(keepGeneratedAt: boolean): string {
  return RUN_UPSERT_SQL.replace(
    "generated_at = runs.generated_at",
    keepGeneratedAt
      ? "generated_at = CASE WHEN excluded.head_sha = runs.head_sha " +
          "THEN runs.generated_at ELSE excluded.generated_at END"
      : "generated_at = excluded.generated_at",
  );
}

const RUN_UPSERT_SQL = `
  INSERT INTO runs (
    repo_id, run_dir, pr, checkout_path, head_sha, base_sha, diff_from_sha,
    run_status, session_failed, model, iteration, parity_hunter_fired,
    prompt_set_name, prompt_set_sha256, driver_sha, engine_name, engine_version,
    engine_revision, findings_schema_version, summary_prose, summary_score,
    summary_score_reason, generated_at, wall_ms, index_ms, index_mode,
    index_disk_mb, sync_ms, tokens_in, tokens_out, tokens_total, cost_usd_est,
    blocking, advisory, root_causes_json, greptile_found, diversity_plan_json
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
  ON CONFLICT(repo_id, run_dir) DO UPDATE SET
    repo_id = excluded.repo_id,
    pr = excluded.pr,
    checkout_path = excluded.checkout_path,
    head_sha = excluded.head_sha,
    base_sha = excluded.base_sha,
    diff_from_sha = COALESCE(excluded.diff_from_sha, runs.diff_from_sha),
    run_status = excluded.run_status,
    session_failed = excluded.session_failed,
    model = excluded.model,
    iteration = excluded.iteration,
    parity_hunter_fired = excluded.parity_hunter_fired,
    prompt_set_name = excluded.prompt_set_name,
    prompt_set_sha256 = excluded.prompt_set_sha256,
    driver_sha = excluded.driver_sha,
    engine_name = excluded.engine_name,
    engine_version = excluded.engine_version,
    engine_revision = excluded.engine_revision,
    findings_schema_version = excluded.findings_schema_version,
    summary_prose = excluded.summary_prose,
    summary_score = excluded.summary_score,
    summary_score_reason = excluded.summary_score_reason,
    generated_at = runs.generated_at,
    wall_ms = excluded.wall_ms,
    index_ms = excluded.index_ms,
    index_mode = excluded.index_mode,
    index_disk_mb = excluded.index_disk_mb,
    sync_ms = excluded.sync_ms,
    tokens_in = excluded.tokens_in,
    tokens_out = excluded.tokens_out,
    tokens_total = excluded.tokens_total,
    cost_usd_est = excluded.cost_usd_est,
    blocking = excluded.blocking,
    advisory = excluded.advisory,
    root_causes_json = excluded.root_causes_json,
    greptile_found = COALESCE(excluded.greptile_found, runs.greptile_found),
    diversity_plan_json = excluded.diversity_plan_json
`;

function runParams(row: CanonicalRunRow): SQLQueryBindings[] {
  return [
    row.repo_id,
    row.run_dir,
    row.pr,
    row.checkout_path,
    row.head_sha,
    row.base_sha,
    row.diff_from_sha,
    row.run_status,
    row.session_failed,
    row.model,
    row.iteration,
    row.parity_hunter_fired,
    row.prompt_set_name,
    row.prompt_set_sha256,
    row.driver_sha,
    row.engine_name,
    row.engine_version,
    row.engine_revision,
    row.findings_schema_version,
    row.summary_prose,
    row.summary_score,
    row.summary_score_reason,
    row.generated_at,
    row.wall_ms,
    row.index_ms,
    row.index_mode,
    row.index_disk_mb,
    row.sync_ms,
    row.tokens_in,
    row.tokens_out,
    row.tokens_total,
    row.cost_usd_est,
    row.blocking,
    row.advisory,
    row.root_causes_json,
    row.greptile_found,
    row.diversity_plan_json,
  ];
}

export function saveRunTransaction(
  db: Database,
  projected: ProjectedCompleteRun,
  options: { keepGeneratedAt?: boolean } = {},
): number {
  let runId = 0;
  db.transaction(() => {
    db.query(runUpsertSql(options.keepGeneratedAt === true)).run(
      ...runParams(projected.run),
    );
    const runRow = db
      .query("SELECT id FROM runs WHERE repo_id = ? AND run_dir = ?")
      .get(projected.run.repo_id, projected.run.run_dir) as { id: number };
    runId = runRow.id;

    // Delete existing child records for clean idempotent replacement
    db.query("DELETE FROM findings WHERE run_id = ?").run(runId);
    db.query("DELETE FROM debug_findings WHERE run_id = ?").run(runId);
    db.query("DELETE FROM run_agents WHERE run_id = ?").run(runId);
    db.query("DELETE FROM diversity_observations WHERE run_id = ?").run(runId);
    db.query("DELETE FROM diversity_attempts WHERE run_id = ?").run(runId);

    // Insert findings + proof refs + hop trails
    const insertFinding = db.query(`
      INSERT INTO findings (
        run_id, finding_id, category, path, line, symbol, severity,
        evidence_class, refuter_verdict, causal_disposition, claim, hunter,
        tier, hops_used, dedupe_key, root_cause_id, finding_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertProofRef = db.query(`
      INSERT INTO finding_proof_refs (
        finding_id, ref_order, proof_ref
      ) VALUES (?, ?, ?)
    `);

    const insertHopTrail = db.query(`
      INSERT INTO finding_hop_trail (
        finding_id, step_order, step_num, kind, query, reached, is_raw_string
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of projected.findings) {
      insertFinding.run(
        runId,
        item.finding.finding_id,
        item.finding.category,
        item.finding.path,
        item.finding.line,
        item.finding.symbol,
        item.finding.severity,
        item.finding.evidence_class,
        item.finding.refuter_verdict,
        item.finding.causal_disposition,
        item.finding.claim,
        item.finding.hunter,
        item.finding.tier,
        item.finding.hops_used,
        item.finding.dedupe_key,
        item.finding.root_cause_id,
        item.finding.finding_order,
      );

      const fRow = db
        .query("SELECT id FROM findings WHERE run_id = ? AND finding_id = ?")
        .get(runId, item.finding.finding_id) as { id: number };
      const findingDbId = fRow.id;

      item.proofRefs.forEach((ref, refIndex) => {
        insertProofRef.run(findingDbId, refIndex, ref);
      });

      item.hopTrail.forEach((hop, hopIndex) => {
        if (typeof hop === "string") {
          insertHopTrail.run(
            findingDbId,
            hopIndex,
            hopIndex + 1,
            "trace",
            hop,
            null,
            1,
          );
        } else {
          insertHopTrail.run(
            findingDbId,
            hopIndex,
            hop.step ?? hopIndex + 1,
            hop.kind ?? "trace",
            hop.query ?? "",
            hop.reached ?? null,
            0,
          );
        }
      });
    }

    // Insert debug findings
    if (projected.debugFindings.length > 0) {
      const insertDebug = db.query(`
        INSERT INTO debug_findings (
          run_id, finding_id, kind, merged_into, category, path, line, symbol,
          severity, evidence_class, refuter_verdict, causal_disposition, claim,
          proof_refs_json, hunter, hops_used, hop_trail_json, dedupe_key,
          root_cause_id, debug_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const d of projected.debugFindings) {
        insertDebug.run(
          runId,
          d.finding_id,
          d.kind,
          d.merged_into,
          d.category,
          d.path,
          d.line,
          d.symbol,
          d.severity,
          d.evidence_class,
          d.refuter_verdict,
          d.causal_disposition,
          d.claim,
          d.proof_refs_json,
          d.hunter,
          d.hops_used,
          d.hop_trail_json,
          d.dedupe_key,
          d.root_cause_id,
          d.debug_order,
        );
      }
    }

    // Insert run agents
    if (projected.agents.length > 0) {
      const insertAgent = db.query(`
        INSERT INTO run_agents (
          run_id, agent_key, tokens_total, duration_ms, tokens_in, tokens_out,
          cost_usd_est, attempts, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of projected.agents) {
        insertAgent.run(
          runId,
          a.agent_key,
          a.tokens_total,
          a.duration_ms,
          a.tokens_in,
          a.tokens_out,
          a.cost_usd_est,
          a.attempts,
          a.status,
        );
      }
    }

    if (projected.diversityAttempts.length > 0) {
      const insertAttempt = db.query(`
        INSERT INTO diversity_attempts (
          run_id, attempt_id, leg_id, arm_id, specialty, replicate, attempt,
          status, cash_cost_usd, notional_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const attempt of projected.diversityAttempts) {
        insertAttempt.run(
          runId,
          attempt.attempt_id,
          attempt.leg_id,
          attempt.arm_id,
          attempt.specialty,
          attempt.replicate,
          attempt.attempt,
          attempt.status,
          attempt.cash_cost_usd,
          attempt.notional_cost_usd,
        );
      }
    }

    if (projected.diversityObservations.length > 0) {
      const insertObservation = db.query(`
        INSERT INTO diversity_observations (
          run_id, observation_id, attempt_id, leg_id, arm_id, specialty,
          observation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const observation of projected.diversityObservations) {
        insertObservation.run(
          runId,
          observation.observation_id,
          observation.attempt_id,
          observation.leg_id,
          observation.arm_id,
          observation.specialty,
          observation.observation_json,
        );
      }
    }
  })();

  return runId;
}

export function getRunById(
  db: Database,
  runId: number,
): CanonicalRunRow | null {
  const row = db.query("SELECT * FROM runs WHERE id = ?").get(runId);
  return (row as CanonicalRunRow) ?? null;
}

export function getRunByDir(
  db: Database,
  repoId: string,
  runDir: string,
): CanonicalRunRow | null {
  const row = db
    .query("SELECT * FROM runs WHERE repo_id = ? AND run_dir = ?")
    .get(repoId, runDir);
  return (row as CanonicalRunRow) ?? null;
}

export function exportFindingsDocument(
  db: Database,
  runId: number,
): FindingsDocument | null {
  const run = getRunById(db, runId);
  if (!run) return null;

  // Retrieve findings
  const findingRows = db
    .query("SELECT * FROM findings WHERE run_id = ? ORDER BY finding_order ASC")
    .all(runId) as (CanonicalFindingRow & { id: number })[];

  const findings: Finding[] = [];
  for (const f of findingRows) {
    const proofRefRows = db
      .query(
        "SELECT proof_ref FROM finding_proof_refs WHERE finding_id = ? ORDER BY ref_order ASC",
      )
      .all(f.id) as { proof_ref: string }[];

    const hopTrailRows = db
      .query(
        "SELECT step_num, kind, query, reached, is_raw_string FROM finding_hop_trail WHERE finding_id = ? ORDER BY step_order ASC",
      )
      .all(f.id) as {
      step_num: number;
      kind: string;
      query: string;
      reached: string | null;
      is_raw_string: number;
    }[];

    const isRaw =
      hopTrailRows.length > 0 && hopTrailRows[0]?.is_raw_string === 1;
    const hop_trail: HopTrail = isRaw
      ? hopTrailRows.map((h) => h.query)
      : hopTrailRows.map((h) => ({
          step: h.step_num,
          kind: h.kind,
          query: h.query,
          reached: h.reached ?? "",
        }));

    findings.push({
      id: f.finding_id,
      category: f.category,
      path: f.path,
      line: f.line,
      ...(f.symbol ? { symbol: f.symbol } : {}),
      severity: f.severity,
      evidence_class: f.evidence_class,
      refuter_verdict: f.refuter_verdict,
      causal_disposition: f.causal_disposition,
      claim: f.claim,
      proof_refs: proofRefRows.map((p) => p.proof_ref),
      hunter: f.hunter,
      tier: f.tier,
      hops_used: f.hops_used,
      hop_trail,
      dedupe_key: f.dedupe_key,
      ...(f.root_cause_id ? { root_cause_id: f.root_cause_id } : {}),
    });
  }

  // Retrieve debug findings
  const debugRows = db
    .query(
      "SELECT * FROM debug_findings WHERE run_id = ? ORDER BY debug_order ASC",
    )
    .all(runId) as DebugFindingRow[];

  const refuted: DebugRefutedFinding[] = [];
  const deduped: DebugDedupedFinding[] = [];

  for (const d of debugRows) {
    const proof_refs = JSON.parse(d.proof_refs_json) as string[];
    const hop_trail = JSON.parse(d.hop_trail_json) as HopTrailStep[];

    if (d.kind === "refuted") {
      refuted.push({
        id: d.finding_id,
        category: d.category,
        path: d.path,
        line: d.line,
        ...(d.symbol ? { symbol: d.symbol } : {}),
        severity: d.severity,
        evidence_class: d.evidence_class,
        refuter_verdict: "refuted",
        causal_disposition: d.causal_disposition,
        claim: d.claim,
        proof_refs,
        hunter: d.hunter,
        hops_used: d.hops_used,
        hop_trail,
        dedupe_key: d.dedupe_key,
        ...(d.root_cause_id ? { root_cause_id: d.root_cause_id } : {}),
      });
    } else {
      deduped.push({
        id: d.finding_id,
        category: d.category,
        path: d.path,
        line: d.line,
        ...(d.symbol ? { symbol: d.symbol } : {}),
        severity: d.severity,
        evidence_class: d.evidence_class,
        refuter_verdict: d.refuter_verdict,
        causal_disposition: d.causal_disposition,
        claim: d.claim,
        proof_refs,
        hunter: d.hunter,
        hops_used: d.hops_used,
        hop_trail,
        dedupe_key: d.dedupe_key,
        ...(d.root_cause_id ? { root_cause_id: d.root_cause_id } : {}),
        merged_into: d.merged_into ?? "",
      });
    }
  }

  // Per agent usage for telemetry
  const agentRows = db
    .query(
      "SELECT agent_key, tokens_total, duration_ms FROM run_agents WHERE run_id = ?",
    )
    .all(runId) as {
    agent_key: string;
    tokens_total: number;
    duration_ms: number;
  }[];

  const per_agent: Record<
    string,
    { tokens_total: number; duration_ms: number }
  > = {};
  for (const a of agentRows) {
    per_agent[a.agent_key] = {
      tokens_total: a.tokens_total,
      duration_ms: a.duration_ms,
    };
  }

  const telemetry: Telemetry = {
    index_ms: run.index_ms,
    index_mode: (run.index_mode ?? "sync") as IndexMode,
    ...(run.sync_ms !== null ? { sync_ms: run.sync_ms } : {}),
    index_disk_mb: run.index_disk_mb ?? 0,
    wall_ms: run.wall_ms,
    tokens_in: run.tokens_in,
    tokens_out: run.tokens_out,
    tokens_total: run.tokens_total,
    cost_usd_est: run.cost_usd_est,
    ...(agentRows.length > 0 ? { per_agent } : {}),
  };

  let summary: RunSummary | undefined;
  if (
    run.summary_prose &&
    run.summary_score !== null &&
    run.summary_score_reason
  ) {
    summary = {
      prose: run.summary_prose,
      score: run.summary_score,
      score_reason: run.summary_score_reason,
    };
  }

  const doc: FindingsDocument = {
    schema_version: run.findings_schema_version ?? SCHEMA_VERSION,
    pr: run.pr === null ? 0 : run.pr,
    base_sha: run.base_sha,
    head_sha: run.head_sha,
    model: run.model,
    iteration: run.iteration,
    ...(run.prompt_set_name && run.prompt_set_sha256
      ? {
          prompt_set: {
            name: run.prompt_set_name,
            sha256: run.prompt_set_sha256,
          },
        }
      : {}),
    ...(run.driver_sha ? { driver_sha: run.driver_sha } : {}),
    ...(run.engine_name && run.engine_version
      ? {
          engine: {
            name: run.engine_name,
            version: run.engine_version,
            ...(run.engine_revision ? { revision: run.engine_revision } : {}),
          },
        }
      : {}),
    parity_hunter_fired: Boolean(run.parity_hunter_fired),
    run_status: run.run_status,
    ...(run.session_failed !== null
      ? { sessionFailed: run.session_failed === 1 }
      : {}),
    ...(summary ? { summary } : {}),
    telemetry,
    findings,
    debug: {
      refuted,
      ...(deduped.length > 0 ? { deduped } : {}),
      ...(run.root_causes_json
        ? { root_causes: JSON.parse(run.root_causes_json) }
        : {}),
      ...(run.diversity_plan_json
        ? { diversity: JSON.parse(run.diversity_plan_json) }
        : {}),
    },
  };

  return validateFindingsDocument(doc);
}

export type StoreQueryScope = { repoId: string } | { all: true };

export function queryRuns(
  db: Database,
  scope: StoreQueryScope,
): CanonicalRunRow[] {
  if ("all" in scope) {
    return db
      .query("SELECT * FROM runs ORDER BY generated_at DESC;")
      .all() as CanonicalRunRow[];
  }
  return db
    .query("SELECT * FROM runs WHERE repo_id = ? ORDER BY generated_at DESC;")
    .all(scope.repoId) as CanonicalRunRow[];
}

export function recordFindingTriage(
  db: Database,
  triage: FindingTriageRow,
): number {
  const runTx = db.transaction(() => {
    const existing = db
      .query(
        "SELECT id FROM finding_triage WHERE run_id = ? AND finding_id = ? AND ifnull(comment_id, 0) = ifnull(?, 0) LIMIT 1",
      )
      .get(triage.run_id, triage.finding_id, triage.comment_id ?? null) as {
      id: number;
    } | null;
    if (existing) {
      db.query(`
        UPDATE finding_triage
        SET tag = ?, verdict = ?, actor = ?, reasoning = ?, issue_number = ?, created_at = ?
        WHERE id = ?
      `).run(
        triage.tag,
        triage.verdict ?? null,
        triage.actor,
        triage.reasoning,
        triage.issue_number ?? null,
        triage.created_at,
        existing.id,
      );
      return existing.id;
    }

    const insert = db.query(`
      INSERT INTO finding_triage (
        run_id, finding_id, comment_id, tag, verdict, actor, reasoning, issue_number, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      triage.run_id,
      triage.finding_id,
      triage.comment_id ?? null,
      triage.tag,
      triage.verdict ?? null,
      triage.actor,
      triage.reasoning,
      triage.issue_number ?? null,
      triage.created_at,
    );

    const lastId = (
      db.query("SELECT last_insert_rowid() as id").get() as { id: number }
    ).id;
    return lastId;
  });

  return runTx();
}

export function getFindingTriageByRunId(
  db: Database,
  runId: number,
): FindingTriageRow[] {
  return db
    .query("SELECT * FROM finding_triage WHERE run_id = ? ORDER BY id ASC")
    .all(runId) as FindingTriageRow[];
}
