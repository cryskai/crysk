// Canonical product store (Fundamentals #6 / observability-canonical-store.md),
// pure half: Schema DDL, table types, and projection from a completed run's facts
// (FindingsDocument, per-agent usage, the PR's diff base) into the complete
// relational model.
//
// Pure and testable offline: never opens a connection, never touches the clock or fs.

import path from "node:path";
import type {
  CausalDisposition,
  EvidenceClass,
  FindingsDocument,
  HopTrail,
  IndexMode,
  RefuterVerdict,
  RunStatus,
  Severity,
  Tier,
} from "#review/findings";
import type { PerAgentUsage } from "#review/pipeline";

export const CURRENT_PRODUCT_SCHEMA_VERSION = 5;

export const PRODUCT_V4_TO_V5_STATEMENTS: string[] = [
  "ALTER TABLE runs ADD COLUMN diversity_plan_json TEXT NULL;",
  `CREATE TABLE IF NOT EXISTS diversity_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    leg_id TEXT NOT NULL,
    arm_id TEXT NOT NULL,
    specialty TEXT NOT NULL,
    replicate INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    cash_cost_usd REAL NULL,
    notional_cost_usd REAL NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_diversity_attempts_run_id ON diversity_attempts (run_id);`,
  `CREATE TABLE IF NOT EXISTS diversity_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    observation_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    leg_id TEXT NOT NULL,
    arm_id TEXT NOT NULL,
    specialty TEXT NOT NULL,
    observation_json TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_diversity_observations_run_id ON diversity_observations (run_id);`,
];

export const PRODUCT_V3_TO_V4_STATEMENTS: string[] = [
  "ALTER TABLE runs ADD COLUMN findings_schema_version TEXT NOT NULL DEFAULT '1.0.0';",
  "ALTER TABLE runs ADD COLUMN engine_revision TEXT NULL;",
];

export interface ProductSchemaMigration {
  toVersion: number;
  statements: string[];
}

export const PRODUCT_V2_TO_V3_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS finding_triage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    finding_id TEXT NOT NULL,
    comment_id INTEGER NULL,
    tag TEXT NOT NULL,
    verdict TEXT NULL,
    actor TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    issue_number INTEGER NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_finding_triage_run_id ON finding_triage (run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_finding_triage_finding_id ON finding_triage (finding_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_triage_unique ON finding_triage (run_id, finding_id, ifnull(comment_id, 0));`,
];

export const PRODUCT_V1_TO_V2_STATEMENTS: string[] = [
  "ALTER TABLE finding_hop_trail ADD COLUMN is_raw_string INTEGER NOT NULL DEFAULT 0;",
  `CREATE TABLE IF NOT EXISTS runs_new (
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
  );`,
  `INSERT OR IGNORE INTO runs_new SELECT id, repo_id, run_dir, pr, checkout_path, head_sha, base_sha, diff_from_sha, run_status, session_failed, model, iteration, parity_hunter_fired, prompt_set_name, prompt_set_sha256, driver_sha, engine_name, engine_version, summary_prose, summary_score, summary_score_reason, generated_at, wall_ms, index_ms, index_mode, index_disk_mb, sync_ms, tokens_in, tokens_out, tokens_total, cost_usd_est, blocking, advisory, root_causes_json, greptile_found FROM runs;`,
  `DROP TABLE runs;`,
  `ALTER TABLE runs_new RENAME TO runs;`,
  `CREATE INDEX IF NOT EXISTS idx_runs_repo_id ON runs (repo_id);`,
  `CREATE INDEX IF NOT EXISTS idx_runs_generated_at ON runs (generated_at);`,
];

export const PRODUCT_V1_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
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
    engine_revision TEXT NULL,
    findings_schema_version TEXT NOT NULL DEFAULT '1.0.0',
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
    diversity_plan_json TEXT NULL,
    UNIQUE (repo_id, run_dir)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_repo_id ON runs (repo_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_generated_at ON runs (generated_at)`,

  `CREATE TABLE IF NOT EXISTS findings (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_findings_run_id ON findings (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_path ON findings (path)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_tier ON findings (tier)`,

  `CREATE TABLE IF NOT EXISTS finding_proof_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id INTEGER NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
    ref_order INTEGER NOT NULL,
    proof_ref TEXT NOT NULL,
    UNIQUE (finding_id, ref_order)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_finding_proof_refs_fid ON finding_proof_refs (finding_id)`,

  `CREATE TABLE IF NOT EXISTS finding_hop_trail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id INTEGER NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL,
    step_num INTEGER NOT NULL,
    kind TEXT NOT NULL,
    query TEXT NOT NULL,
    reached TEXT NULL,
    is_raw_string INTEGER NOT NULL DEFAULT 0,
    UNIQUE (finding_id, step_order)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_finding_hop_trail_fid ON finding_hop_trail (finding_id)`,

  `CREATE TABLE IF NOT EXISTS debug_findings (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_debug_findings_run_id ON debug_findings (run_id)`,

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

  `CREATE TABLE IF NOT EXISTS finding_triage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    finding_id TEXT NOT NULL,
    comment_id INTEGER NULL,
    tag TEXT NOT NULL,
    verdict TEXT NULL,
    actor TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    issue_number INTEGER NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_finding_triage_run_id ON finding_triage (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_finding_triage_finding_id ON finding_triage (finding_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_triage_unique ON finding_triage (run_id, finding_id, ifnull(comment_id, 0))`,

  `CREATE TABLE IF NOT EXISTS diversity_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    leg_id TEXT NOT NULL,
    arm_id TEXT NOT NULL,
    specialty TEXT NOT NULL,
    replicate INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    cash_cost_usd REAL NULL,
    notional_cost_usd REAL NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_diversity_attempts_run_id ON diversity_attempts (run_id)`,
  `CREATE TABLE IF NOT EXISTS diversity_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    observation_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    leg_id TEXT NOT NULL,
    arm_id TEXT NOT NULL,
    specialty TEXT NOT NULL,
    observation_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_diversity_observations_run_id ON diversity_observations (run_id)`,
];

export function migrationsForProductStore(
  currentVersion: number,
): ProductSchemaMigration {
  if (currentVersion >= CURRENT_PRODUCT_SCHEMA_VERSION) {
    return { toVersion: currentVersion, statements: [] };
  }
  if (currentVersion === 0) {
    return {
      toVersion: CURRENT_PRODUCT_SCHEMA_VERSION,
      statements: [...PRODUCT_V1_STATEMENTS],
    };
  }
  if (currentVersion === 1) {
    return {
      toVersion: CURRENT_PRODUCT_SCHEMA_VERSION,
      statements: [
        ...PRODUCT_V1_TO_V2_STATEMENTS,
        ...PRODUCT_V2_TO_V3_STATEMENTS,
        ...PRODUCT_V3_TO_V4_STATEMENTS,
        ...PRODUCT_V4_TO_V5_STATEMENTS,
      ],
    };
  }
  if (currentVersion === 2) {
    return {
      toVersion: CURRENT_PRODUCT_SCHEMA_VERSION,
      statements: [
        ...PRODUCT_V2_TO_V3_STATEMENTS,
        ...PRODUCT_V3_TO_V4_STATEMENTS,
        ...PRODUCT_V4_TO_V5_STATEMENTS,
      ],
    };
  }
  if (currentVersion === 3) {
    return {
      toVersion: CURRENT_PRODUCT_SCHEMA_VERSION,
      statements: [
        ...PRODUCT_V3_TO_V4_STATEMENTS,
        ...PRODUCT_V4_TO_V5_STATEMENTS,
      ],
    };
  }
  if (currentVersion === 4) {
    return {
      toVersion: CURRENT_PRODUCT_SCHEMA_VERSION,
      statements: [...PRODUCT_V4_TO_V5_STATEMENTS],
    };
  }
  return {
    toVersion: CURRENT_PRODUCT_SCHEMA_VERSION,
    statements: [],
  };
}

export interface CanonicalRunRow {
  id?: number;
  repo_id: string;
  run_dir: string;
  pr: number | null;
  checkout_path: string | null;
  head_sha: string;
  base_sha: string;
  diff_from_sha: string | null;
  run_status: RunStatus;
  session_failed: 0 | 1 | null;
  model: string;
  iteration: number;
  parity_hunter_fired: 0 | 1;
  prompt_set_name: string | null;
  prompt_set_sha256: string | null;
  driver_sha: string | null;
  engine_name: string | null;
  engine_version: string | null;
  engine_revision: string | null;
  findings_schema_version: string;
  summary_prose: string | null;
  summary_score: number | null;
  summary_score_reason: string | null;
  generated_at: string;
  wall_ms: number;
  index_ms: number;
  index_mode: IndexMode | null;
  index_disk_mb: number | null;
  sync_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  cost_usd_est: number;
  blocking: number;
  advisory: number;
  root_causes_json: string | null;
  greptile_found: 0 | 1 | null;
  diversity_plan_json: string | null;
}

export interface CanonicalFindingRow {
  id?: number;
  run_id?: number;
  finding_id: string;
  category: number;
  path: string;
  line: number;
  symbol: string | null;
  severity: Severity;
  evidence_class: EvidenceClass;
  refuter_verdict: RefuterVerdict;
  causal_disposition: CausalDisposition;
  claim: string;
  hunter: string;
  tier: Tier;
  hops_used: number;
  dedupe_key: string;
  root_cause_id: string | null;
  finding_order: number;
}

export interface FindingProofRefRow {
  id?: number;
  finding_id?: number;
  ref_order: number;
  proof_ref: string;
}

export interface FindingHopTrailRow {
  id?: number;
  finding_id?: number;
  step_order: number;
  step_num: number;
  kind: string;
  query: string;
  reached: string;
  is_raw_string?: number;
}

export interface DebugFindingRow {
  id?: number;
  run_id?: number;
  finding_id: string;
  kind: "refuted" | "deduped";
  merged_into: string | null;
  category: number;
  path: string;
  line: number;
  symbol: string | null;
  severity: Severity;
  evidence_class: EvidenceClass;
  refuter_verdict: RefuterVerdict;
  causal_disposition: CausalDisposition;
  claim: string;
  proof_refs_json: string;
  hunter: string;
  hops_used: number;
  hop_trail_json: string;
  dedupe_key: string;
  root_cause_id: string | null;
  debug_order: number;
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

export interface FindingTriageRow {
  id?: number;
  run_id: number;
  finding_id: string;
  comment_id?: number | null;
  tag: string;
  verdict?: string | null;
  actor: string;
  reasoning: string;
  issue_number?: number | null;
  created_at: string;
}

export interface ProjectedFinding {
  finding: CanonicalFindingRow;
  proofRefs: string[];
  hopTrail: HopTrail;
}

export interface DiversityAttemptRow {
  attempt_id: string;
  leg_id: string;
  arm_id: string;
  specialty: string;
  replicate: number;
  attempt: number;
  status: string;
  cash_cost_usd: number | null;
  notional_cost_usd: number | null;
}

export interface DiversityObservationRow {
  observation_id: string;
  attempt_id: string;
  leg_id: string;
  arm_id: string;
  specialty: string;
  observation_json: string;
}

export interface ProjectedCompleteRun {
  run: CanonicalRunRow;
  findings: ProjectedFinding[];
  debugFindings: DebugFindingRow[];
  agents: RunAgentRow[];
  diversityAttempts: DiversityAttemptRow[];
  diversityObservations: DiversityObservationRow[];
}

export function projectCompleteRun(input: {
  doc: FindingsDocument;
  perAgent?: Record<string, PerAgentUsage>;
  diffFromSha?: string | null;
  repoId: string;
  runDir: string;
  checkoutPath: string | null;
  generatedAt?: string;
}): ProjectedCompleteRun {
  let blocking = 0;
  let advisory = 0;
  for (const finding of input.doc.findings) {
    if (finding.tier === "blocking") blocking++;
    else advisory++;
  }

  let session_failed: 0 | 1 | null = null;
  if (input.doc.sessionFailed !== undefined) {
    session_failed = input.doc.sessionFailed ? 1 : 0;
  }

  const run: CanonicalRunRow = {
    repo_id: input.repoId,
    run_dir: path.basename(input.runDir),
    pr: input.doc.pr === 0 ? null : input.doc.pr,
    checkout_path: input.checkoutPath,
    head_sha: input.doc.head_sha,
    base_sha: input.doc.base_sha,
    diff_from_sha: input.diffFromSha ?? null,
    run_status: input.doc.run_status,
    session_failed,
    model: input.doc.model,
    iteration: input.doc.iteration,
    parity_hunter_fired: input.doc.parity_hunter_fired ? 1 : 0,
    prompt_set_name: input.doc.prompt_set?.name ?? null,
    prompt_set_sha256: input.doc.prompt_set?.sha256 ?? null,
    driver_sha: input.doc.driver_sha ?? null,
    engine_name: input.doc.engine?.name ?? null,
    engine_version: input.doc.engine?.version ?? null,
    engine_revision: input.doc.engine?.revision ?? null,
    findings_schema_version: input.doc.schema_version,
    summary_prose: input.doc.summary?.prose ?? null,
    summary_score: input.doc.summary?.score ?? null,
    summary_score_reason: input.doc.summary?.score_reason ?? null,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    wall_ms: input.doc.telemetry.wall_ms,
    index_ms: input.doc.telemetry.index_ms,
    index_mode: input.doc.telemetry.index_mode,
    index_disk_mb: input.doc.telemetry.index_disk_mb,
    sync_ms: input.doc.telemetry.sync_ms ?? null,
    tokens_in: input.doc.telemetry.tokens_in,
    tokens_out: input.doc.telemetry.tokens_out,
    tokens_total: input.doc.telemetry.tokens_total,
    cost_usd_est: input.doc.telemetry.cost_usd_est,
    blocking,
    advisory,
    root_causes_json: input.doc.debug.root_causes
      ? JSON.stringify(input.doc.debug.root_causes)
      : null,
    greptile_found: null,
    diversity_plan_json: input.doc.debug.diversity
      ? JSON.stringify(input.doc.debug.diversity)
      : null,
  };

  const findings: ProjectedFinding[] = input.doc.findings.map((f, index) => ({
    finding: {
      finding_id: f.id,
      category: f.category,
      path: f.path,
      line: f.line,
      symbol: f.symbol ?? null,
      severity: f.severity,
      evidence_class: f.evidence_class,
      refuter_verdict: f.refuter_verdict,
      causal_disposition: f.causal_disposition,
      claim: f.claim,
      hunter: f.hunter,
      tier: f.tier,
      hops_used: f.hops_used,
      dedupe_key: f.dedupe_key,
      root_cause_id: f.root_cause_id ?? null,
      finding_order: index,
    },
    proofRefs: f.proof_refs,
    hopTrail: f.hop_trail,
  }));

  const debugFindings: DebugFindingRow[] = [];
  let debugOrder = 0;

  for (const f of input.doc.debug.refuted) {
    debugFindings.push({
      finding_id: f.id,
      kind: "refuted",
      merged_into: null,
      category: f.category,
      path: f.path,
      line: f.line,
      symbol: f.symbol ?? null,
      severity: f.severity,
      evidence_class: f.evidence_class,
      refuter_verdict: "refuted",
      causal_disposition: f.causal_disposition,
      claim: f.claim,
      proof_refs_json: JSON.stringify(f.proof_refs),
      hunter: f.hunter,
      hops_used: f.hops_used,
      hop_trail_json: JSON.stringify(f.hop_trail),
      dedupe_key: f.dedupe_key,
      root_cause_id: f.root_cause_id ?? null,
      debug_order: debugOrder++,
    });
  }

  if (input.doc.debug.deduped) {
    for (const f of input.doc.debug.deduped) {
      debugFindings.push({
        finding_id: f.id,
        kind: "deduped",
        merged_into: f.merged_into,
        category: f.category,
        path: f.path,
        line: f.line,
        symbol: f.symbol ?? null,
        severity: f.severity,
        evidence_class: f.evidence_class,
        refuter_verdict: f.refuter_verdict,
        causal_disposition: f.causal_disposition,
        claim: f.claim,
        proof_refs_json: JSON.stringify(f.proof_refs),
        hunter: f.hunter,
        hops_used: f.hops_used,
        hop_trail_json: JSON.stringify(f.hop_trail),
        dedupe_key: f.dedupe_key,
        root_cause_id: f.root_cause_id ?? null,
        debug_order: debugOrder++,
      });
    }
  }

  const agents: RunAgentRow[] = input.perAgent
    ? Object.entries(input.perAgent).map(([agentKey, usage]) => ({
        agent_key: agentKey,
        tokens_total: usage.tokens_total,
        duration_ms: usage.duration_ms,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        cost_usd_est: usage.cost_usd_est,
        attempts: usage.attempts,
        status: usage.status,
      }))
    : Object.entries(input.doc.telemetry.per_agent ?? {}).map(
        ([agentKey, usage]) => ({
          agent_key: agentKey,
          tokens_total: usage.tokens_total,
          duration_ms: usage.duration_ms,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd_est: 0,
          attempts: 1,
          status: "ok",
        }),
      );

  const diversityAttempts: DiversityAttemptRow[] = [];
  const diversityObservations: DiversityObservationRow[] = [];
  const diversityDebug = input.doc.debug.diversity;
  if (diversityDebug && typeof diversityDebug === "object") {
    const attempts = (diversityDebug as Record<string, unknown>).attempts;
    if (Array.isArray(attempts)) {
      for (const entry of attempts) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        diversityAttempts.push({
          attempt_id: String(row.attemptId ?? ""),
          leg_id: String(row.legId ?? ""),
          arm_id: String(row.armId ?? "diversity"),
          specialty: String(row.specialty ?? "unknown"),
          replicate: Number(row.replicate ?? 1),
          attempt: Number(row.attempt ?? 1),
          status: String(row.status ?? "completed"),
          cash_cost_usd:
            typeof row.cashCostUsd === "number" ? row.cashCostUsd : null,
          notional_cost_usd:
            typeof row.notionalCostUsd === "number"
              ? row.notionalCostUsd
              : null,
        });
      }
    }
    const observations = (diversityDebug as Record<string, unknown>)
      .observations;
    if (Array.isArray(observations)) {
      for (const entry of observations) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        diversityObservations.push({
          observation_id: String(row.observationId ?? ""),
          attempt_id: String(row.attemptId ?? ""),
          leg_id: String(row.legId ?? ""),
          arm_id: String(row.armId ?? "diversity"),
          specialty: String(row.specialty ?? "unknown"),
          observation_json: JSON.stringify(row),
        });
      }
    }
  }

  return {
    run,
    findings,
    debugFindings,
    agents,
    diversityAttempts,
    diversityObservations,
  };
}
