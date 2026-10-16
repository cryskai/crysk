// Findings JSON schema v1.0.0 (design D2, reconciliation R1/R2).
// Ported verbatim from deep-review/runner/findings.ts — the lab and the engine
// must agree on these bytes' semantics or benchmark artifacts stop validating.
// Owned by the driver: hunter steps emit unvalidated drafts; this module
// validates the assembled output and merges in the driver-owned run envelope
// (schema_version, telemetry) before anything is written to a run dir.

import type { RootCauseSummary } from "./root-cause";

export const SCHEMA_VERSION = "1.0.0";
export const SCHEMA_VERSION_V1_1 = "1.1.0";

export interface EngineIdentity {
  name: string;
  version: string;
  revision?: string;
}

export type EvidenceClass = "deterministic" | "inferential" | "insufficient";
export type CausalDisposition =
  | "introduced"
  | "behavior-activated"
  | "worsened"
  | "pre-existing"
  | "base-only"
  | "unknown";
export type Severity = "BLOCKER" | "CRITICAL" | "WARNING" | "SUGGESTION";
// Canonical "not sent to refuter" value per reconciliation R1 (spec's `n/a` maps to this).
// `downgraded-latent` (ROADMAP A2) is the "real, but unreachable today"
// verdict: the claim survives scrutiny as a genuine defect, yet nothing can
// execute it at this commit — a bug in newly-added code no caller wires up
// yet. It is deliberately NOT `refuted`, because refuting deletes the finding
// from findings[] and the G6 lesson was that a real defect must never be
// deleted for being latent. It lands advisory instead: recorded, visible, and
// unable to reach blocking tier. Additive widening; validators only reject
// out-of-set values, so historical artifacts keep validating.
export type RefuterVerdict =
  | "corroborated"
  | "refuted"
  | "inconclusive"
  | "downgraded-latent"
  | "not_submitted";
export type Tier = "blocking" | "advisory";
export type Hunter = "reliability" | "resilience" | "parity" | "lifecycle";
export type RunStatus = "complete" | "partial";
export type IndexMode = "fresh" | "sync";

export interface HopTrailStep {
  step: number;
  kind: string;
  query: string;
  reached: string;
}

export type HopTrail = HopTrailStep[] | string[];

export interface Finding {
  id: string;
  // hunting-map.md taxonomy: 1-14 on any document, plus 15 = "local logic
  // error" (wrong operator/condition/comparison/unit/normalization/variable
  // within the changed lines) on v1.1 documents only (odd/tasks/logic-hunter.md
  // T1). The v1.0 legacy validator (validateFinding) stays closed at 1-14;
  // the v1.1 validator (validateFindingV11) accepts the full 1-15 range.
  category: number;
  path: string;
  line: number;
  symbol?: string;
  severity: Severity;
  evidence_class: EvidenceClass;
  refuter_verdict: RefuterVerdict;
  causal_disposition: CausalDisposition;
  claim: string;
  proof_refs: string[];
  hunter: string;
  tier: Tier;
  hops_used: number;
  hop_trail: HopTrail;
  dedupe_key: string;
  // Which derived root-cause cluster this finding belongs to (RC001, …).
  // ADDITIVE and OPTIONAL: both validators are pure allowlists that reject
  // only bad values of known keys, never unknown keys, so a document carrying
  // this field still validates against the unchanged 1.0.0 schema on the lab
  // side and a document without it still validates here. No version bump.
  root_cause_id?: string;
}

// Refuted findings are excluded from `findings[]` (scorer contract unchanged)
// but stay visible here in benchmark mode only, per reconciliation R2.
export type DebugRefutedFinding = Omit<Finding, "tier"> & {
  refuter_verdict: "refuted";
};

// Step 5 merge losers. Without these, a benchmark miss cannot be attributed:
// "no hunter saw it" and "a hunter saw it and dedupe collapsed it into a
// weaker sibling claim" look identical in `findings[]`.
export type DebugDedupedFinding = Omit<Finding, "tier"> & {
  merged_into: string;
};

export interface Telemetry {
  index_ms: number;
  index_mode: IndexMode;
  sync_ms?: number;
  index_disk_mb: number;
  wall_ms: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  cost_usd_est: number;
  // True when at least one spend reservation ended unresolved_remote — the
  // reported cost is a floor of known spend, not a closed total.
  cost_usd_est_is_floor?: boolean;
  // Engine v2 populates this per step (it runs one session per agent). The
  // original best-effort caveat (reconciliation R3) still applies to v1
  // documents: absence must never fail validation.
  per_agent?: Record<string, { tokens_total: number; duration_ms: number }>;
}

// Which prompt bytes produced this score. Optional because runs 1-3 predate
// repo-side prompt sets; every run from honest iteration 2 on must carry it,
// otherwise an A/B delta cannot be attributed to a prompt at all.
export interface PromptSet {
  name: string; // directory basename, e.g. "arm-a"
  sha256: string; // fingerprint over the concatenated agent files
}

export interface RunSummary {
  prose: string;
  score: number;
  score_reason: string;
}

export interface FindingsDocument {
  schema_version: string;
  pr: number;
  base_sha: string;
  head_sha: string;
  model: string;
  iteration: number;
  prompt_set?: PromptSet;
  // Fingerprint of the driver sources that produced this run. Iteration 2 was
  // smeared by a mid-flight driver edit that left no trace in the artifacts.
  driver_sha?: string;
  // Which engine produced this run. Absent on v1 (monolithic orchestrator)
  // documents; v2 (pr-hero) documents always carry it — without this field,
  // v1 and v2 rows in the metrics ledger are indistinguishable (same
  // prompt_set sha on both sides of the engine swap). Required on v1.1.0.
  engine?: EngineIdentity;
  parity_hunter_fired: boolean;
  run_status: RunStatus;
  // Juanma's decision (verify-report-pr3, #3305), over the verifier's cheaper
  // "make `post` as permissive as `--pr --post`" suggestion: `run_status:
  // "partial"` with zero findings covers at least THREE distinct situations
  // — every hunter failed (the true sessionFailed case, review/pipeline.ts:771),
  // no hunter ran at all because gotchas were unusable — missing, empty, or
  // still the untouched scaffold (pipeline's step-2 fail-loud,
  // sessionFailed: false), or one hunter died while the others found
  // nothing. `run_status` alone cannot tell these apart, so a permissive
  // `post` verb would publish a clean bill for a review that never ran.
  // ADDITIVE and OPTIONAL, same precedent as `root_cause_id` above: both
  // validators are allowlists that never reject unknown keys, so schema
  // stays 1.0.0 (project rule 5 — lab compatibility is sacred) and an
  // existing artifact without this field still validates. Absent MUST mean
  // "unknown", never "false" — see `runPostCommand`'s guard in
  // src/commands/post.ts for the back-compat fallback this enables.
  sessionFailed?: boolean;
  summary?: RunSummary;
  telemetry: Telemetry;
  findings: Finding[];
  debug: {
    refuted: DebugRefutedFinding[];
    deduped?: DebugDedupedFinding[];
    // The whole derived partition, kept next to the findings it describes.
    // Also additive/optional: a run that never computed it validates the same.
    root_causes?: RootCauseSummary;
    diversity?: DiversityDebugArtifacts;
  };
}

export interface DiversityDebugArtifacts {
  readonly planFingerprint?: string;
  readonly attempts?: readonly Record<string, unknown>[];
  readonly observations?: readonly Record<string, unknown>[];
}

// Draft the engine assembles before the driver merges in the run envelope.
export interface SkillOutput {
  findings: Finding[];
  debug: {
    refuted: DebugRefutedFinding[];
    deduped?: DebugDedupedFinding[];
    root_causes?: RootCauseSummary;
    diversity?: DiversityDebugArtifacts | Record<string, unknown>;
  };
  parity_hunter_fired: boolean;
  run_status: RunStatus;
  summary?: RunSummary;
}

const SEVERITIES: Severity[] = ["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"];
const EVIDENCE_CLASSES: EvidenceClass[] = [
  "deterministic",
  "inferential",
  "insufficient",
];
const REFUTER_VERDICTS: RefuterVerdict[] = [
  "corroborated",
  "refuted",
  "inconclusive",
  "downgraded-latent",
  "not_submitted",
];
const CAUSAL_DISPOSITIONS: CausalDisposition[] = [
  "introduced",
  "behavior-activated",
  "worsened",
  "pre-existing",
  "base-only",
  "unknown",
];
const TIERS: Tier[] = ["blocking", "advisory"];
const HUNTERS: Hunter[] = ["reliability", "resilience", "parity", "lifecycle"];
const SPECIALTY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUPPORTED_SCHEMA_VERSIONS = [
  SCHEMA_VERSION,
  SCHEMA_VERSION_V1_1,
] as const;

export class FindingsValidationError extends Error {}

function isControlFree(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function isValidSpecialtySlug(value: string): boolean {
  return (
    value.length >= 1 && value.length <= 64 && SPECIALTY_SLUG_RE.test(value)
  );
}

function validateEngineString(value: unknown, label: string): string {
  must(typeof value === "string", `${label} required`);
  const raw = value as string;
  const trimmed = raw.trim();
  must(trimmed === raw, `${label} must be trimmed`);
  must(
    trimmed.length >= 1 && trimmed.length <= 128,
    `${label} must be 1-128 characters`,
  );
  must(isControlFree(trimmed), `${label} must not contain control characters`);
  return trimmed;
}

function validateEngineIdentity(
  candidate: unknown,
  options: { required: boolean },
): EngineIdentity | undefined {
  if (candidate === undefined) {
    must(!options.required, "engine required");
    return undefined;
  }
  must(
    typeof candidate === "object" && candidate !== null,
    "engine must be an object",
  );
  const engine = candidate as Record<string, unknown>;
  const name = validateEngineString(engine.name, "engine.name");
  const version = validateEngineString(engine.version, "engine.version");
  const revision =
    engine.revision === undefined
      ? undefined
      : validateEngineString(engine.revision, "engine.revision");
  return {
    name,
    version,
    ...(revision === undefined ? {} : { revision }),
  };
}

function must(condition: boolean, message: string): void {
  if (!condition) throw new FindingsValidationError(message);
}

// The artifact-side twin of review/drafts.ts's normalizeOptionalString — same rule,
// stated in full there. `null` on an optional string is REPAIRED to absent,
// a present-but-wrong-typed value is rejected.
//
// Repaired rather than rejected because this validator does double duty. It is
// the write gate (writeFindings, below), but it is ALSO the read-back gate for
// an artifact already on disk: `pr-hero post --from <run-dir>` and
// `pr-hero triage reply --from <run-dir>` (src/commands/post.ts and
// src/commands/triage.ts) both re-validate a findings.json written by an
// earlier engine. Rejecting here would permanently
// strand every artifact the PR #50 defect already wrote — including the $3.77
// run whose post it ate — and turn "the post crashed" into "the post can never
// happen". Repair keeps that recovery path open and still guarantees the
// invariant on write, since writeFindings stringifies what this returns.
//
// Mutates in place: validateFindingsDocument discards this function's return
// value, exactly as validateHunterDraft does with the draft twin.
function normalizeOptionalString(
  f: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (f[key] === null) {
    delete f[key];
    return;
  }
  must(
    f[key] === undefined || typeof f[key] === "string",
    `${label} must be a string when present`,
  );
}

export function validateFinding(candidate: unknown, index: number): Finding {
  must(
    typeof candidate === "object" && candidate !== null,
    `findings[${index}] must be an object`,
  );
  const f = candidate as Record<string, unknown>;
  must(
    typeof f.id === "string" && f.id.length > 0,
    `findings[${index}].id required`,
  );
  must(
    typeof f.category === "number" && f.category >= 1 && f.category <= 14,
    `findings[${index}].category must be 1-14`,
  );
  must(
    typeof f.path === "string" && f.path.length > 0,
    `findings[${index}].path required`,
  );
  must(typeof f.line === "number", `findings[${index}].line must be a number`);
  must(
    SEVERITIES.includes(f.severity as Severity),
    `findings[${index}].severity invalid`,
  );
  must(
    EVIDENCE_CLASSES.includes(f.evidence_class as EvidenceClass),
    `findings[${index}].evidence_class invalid`,
  );
  must(
    REFUTER_VERDICTS.includes(f.refuter_verdict as RefuterVerdict),
    `findings[${index}].refuter_verdict invalid`,
  );
  must(
    CAUSAL_DISPOSITIONS.includes(f.causal_disposition as CausalDisposition),
    `findings[${index}].causal_disposition invalid`,
  );
  must(
    typeof f.claim === "string" && f.claim.length > 0,
    `findings[${index}].claim required`,
  );
  must(
    Array.isArray(f.proof_refs),
    `findings[${index}].proof_refs must be an array`,
  );
  must(
    HUNTERS.includes(f.hunter as Hunter),
    `findings[${index}].hunter invalid`,
  );
  must(TIERS.includes(f.tier as Tier), `findings[${index}].tier invalid`);
  must(
    typeof f.hops_used === "number",
    `findings[${index}].hops_used must be a number`,
  );
  must(
    Array.isArray(f.hop_trail),
    `findings[${index}].hop_trail must be an array`,
  );
  must(
    typeof f.dedupe_key === "string" && f.dedupe_key.length > 0,
    `findings[${index}].dedupe_key required`,
  );
  must(
    (f.proof_refs as unknown[]).every((ref) => typeof ref === "string"),
    `findings[${index}].proof_refs must contain only strings`,
  );
  normalizeOptionalString(f, "symbol", `findings[${index}].symbol`);
  normalizeOptionalString(
    f,
    "root_cause_id",
    `findings[${index}].root_cause_id`,
  );
  return f as unknown as Finding;
}

function validateFindingV11(candidate: unknown, index: number): Finding {
  must(
    typeof candidate === "object" && candidate !== null,
    `findings[${index}] must be an object`,
  );
  const f = candidate as Record<string, unknown>;
  must(
    typeof f.id === "string" && f.id.length > 0,
    `findings[${index}].id required`,
  );
  must(
    typeof f.category === "number" && f.category >= 1 && f.category <= 15,
    `findings[${index}].category must be 1-15`,
  );
  must(
    typeof f.path === "string" && f.path.length > 0,
    `findings[${index}].path required`,
  );
  must(typeof f.line === "number", `findings[${index}].line must be a number`);
  must(
    SEVERITIES.includes(f.severity as Severity),
    `findings[${index}].severity invalid`,
  );
  must(
    EVIDENCE_CLASSES.includes(f.evidence_class as EvidenceClass),
    `findings[${index}].evidence_class invalid`,
  );
  must(
    REFUTER_VERDICTS.includes(f.refuter_verdict as RefuterVerdict),
    `findings[${index}].refuter_verdict invalid`,
  );
  must(
    CAUSAL_DISPOSITIONS.includes(f.causal_disposition as CausalDisposition),
    `findings[${index}].causal_disposition invalid`,
  );
  must(
    typeof f.claim === "string" && f.claim.length > 0,
    `findings[${index}].claim required`,
  );
  must(
    Array.isArray(f.proof_refs),
    `findings[${index}].proof_refs must be an array`,
  );
  must(
    typeof f.hunter === "string" && isValidSpecialtySlug(f.hunter),
    `findings[${index}].hunter invalid`,
  );
  must(TIERS.includes(f.tier as Tier), `findings[${index}].tier invalid`);
  must(
    typeof f.hops_used === "number",
    `findings[${index}].hops_used must be a number`,
  );
  must(
    Array.isArray(f.hop_trail),
    `findings[${index}].hop_trail must be an array`,
  );
  must(
    typeof f.dedupe_key === "string" && f.dedupe_key.length > 0,
    `findings[${index}].dedupe_key required`,
  );
  must(
    (f.proof_refs as unknown[]).every((ref) => typeof ref === "string"),
    `findings[${index}].proof_refs must contain only strings`,
  );
  normalizeOptionalString(f, "symbol", `findings[${index}].symbol`);
  normalizeOptionalString(
    f,
    "root_cause_id",
    `findings[${index}].root_cause_id`,
  );
  return f as unknown as Finding;
}

function validateDocumentSummary(d: Record<string, unknown>): void {
  if (d.summary === undefined) return;
  must(
    typeof d.summary === "object" && d.summary !== null,
    "summary must be an object when present",
  );
  const summary = d.summary as Record<string, unknown>;
  must(
    typeof summary.prose === "string" && summary.prose.length > 0,
    "summary.prose required",
  );
  must(
    typeof summary.prose === "string" && summary.prose.length <= 1200,
    "summary.prose must be at most 1200 characters",
  );
  must(
    typeof summary.score === "number" &&
      Number.isInteger(summary.score) &&
      summary.score >= 1 &&
      summary.score <= 5,
    "summary.score must be an integer 1-5",
  );
  must(
    typeof summary.score_reason === "string" && summary.score_reason.length > 0,
    "summary.score_reason required",
  );
  must(
    typeof summary.score_reason === "string" &&
      summary.score_reason.length <= 400,
    "summary.score_reason must be at most 400 characters",
  );
  const prose = summary.prose as string;
  const scoreReason = summary.score_reason as string;
  must(
    !prose.includes("<!--") &&
      !prose.includes("-->") &&
      !scoreReason.includes("<!--") &&
      !scoreReason.includes("-->"),
    "summary strings must not contain HTML comment markers",
  );
}

function validateDocumentEnvelope(d: Record<string, unknown>): void {
  must(typeof d.pr === "number", "pr must be a number");
  must(
    typeof d.base_sha === "string" && d.base_sha.length > 0,
    "base_sha required",
  );
  must(
    typeof d.head_sha === "string" && d.head_sha.length > 0,
    "head_sha required",
  );
  must(typeof d.model === "string" && d.model.length > 0, "model required");
  must(typeof d.iteration === "number", "iteration must be a number");
  must(
    typeof d.parity_hunter_fired === "boolean",
    "parity_hunter_fired must be a boolean",
  );
  must(
    d.run_status === "complete" || d.run_status === "partial",
    "run_status must be complete|partial",
  );
  must(
    d.sessionFailed === undefined || typeof d.sessionFailed === "boolean",
    "sessionFailed must be a boolean when present",
  );
  validateDocumentSummary(d);
  must(
    typeof d.telemetry === "object" && d.telemetry !== null,
    "telemetry required",
  );
  must(Array.isArray(d.findings), "findings must be an array");
  const debug = d.debug as Record<string, unknown> | undefined;
  must(
    !!debug && Array.isArray(debug.refuted),
    "debug.refuted must be an array",
  );
}

function validateFindingsDocumentV10(
  d: Record<string, unknown>,
): FindingsDocument {
  (d.findings as unknown[]).forEach((f, i) => {
    validateFinding(f, i);
  });
  return d as unknown as FindingsDocument;
}

function validateFindingsDocumentV11(
  d: Record<string, unknown>,
): FindingsDocument {
  validateEngineIdentity(d.engine, { required: true });
  (d.findings as unknown[]).forEach((f, i) => {
    validateFindingV11(f, i);
  });
  return d as unknown as FindingsDocument;
}

export function validateFindingsDocument(candidate: unknown): FindingsDocument {
  must(
    typeof candidate === "object" && candidate !== null,
    "findings document must be an object",
  );
  const d = candidate as Record<string, unknown>;
  const version = d.schema_version;
  must(
    SUPPORTED_SCHEMA_VERSIONS.includes(
      version as (typeof SUPPORTED_SCHEMA_VERSIONS)[number],
    ),
    `schema_version must be ${SCHEMA_VERSION} or ${SCHEMA_VERSION_V1_1}`,
  );
  validateDocumentEnvelope(d);
  if (version === SCHEMA_VERSION) {
    return validateFindingsDocumentV10(d);
  }
  return validateFindingsDocumentV11(d);
}

// Full tier-assignment rule (spec BR "Full Tier-Assignment Rule"): only
// corroborated-or-deterministic BLOCKER/CRITICAL findings may block; a
// deterministic one is demoted to advisory when the refuter returns the
// positive `downgraded-latent` verdict, and also when an EXPECTED refuter
// check was cut short before the finding was ever submitted (see the
// `refuterCutShort` option below).
export function deriveTier(
  finding: Pick<Finding, "severity" | "evidence_class" | "refuter_verdict">,
  options: {
    // Whether a refuter check this finding was ENTITLED TO never got to
    // submit its verdict. NOT a synonym for "the run was truncated": the
    // caller must have already established BOTH halves of that entitlement —
    // a refuter was configured for this run AND the run ended early (pipeline
    // ceiling / `run_status: "partial"`) rather than completing its legs.
    // Those two are orthogonal, and the name says the conjunction so no future
    // caller can satisfy it with truncation alone (src/review/pipeline.ts `finish()`
    // is where the conjunction is computed, and says why).
    // Defaults to FALSE on purpose: a caller that knows nothing about the
    // refuter's fate must never be able to demote by accident, so the fallback
    // is exactly today's behaviour.
    refuterCutShort?: boolean;
  } = {},
): Tier {
  const isBlockerClass =
    finding.severity === "BLOCKER" || finding.severity === "CRITICAL";
  if (!isBlockerClass) return "advisory";
  if (finding.evidence_class === "insufficient") return "advisory";
  // Ordered BEFORE the deterministic short-circuit on purpose. A verdict that
  // could not outrank `deterministic` would be inert exactly where it is
  // needed: the 2026-07-29 AudioTrimmer runs put 26 of 26 blocking findings in
  // that class, so the gate had nothing to act on. Only a POSITIVE downgrade
  // gets this power — `inconclusive` still blocks, mirroring the rule that
  // `refuted` requires positive disproof. Silence is not a demotion.
  if (finding.refuter_verdict === "downgraded-latent") return "advisory";
  // The blocking tier does not change the job's exit code: ciExitCode stays 0
  // on findings, and "blocking findings exit 0 in CI — reviewer, not a merge
  // gate" (test/ci/review.test.ts) pins that. What it does change is the pr-hero commit status, and only in
  // gate mode (the CI default, S4): there that status, which is the required
  // check, goes red on blocking findings. In advisory mode the tier buys only
  // the report's loudest register: the red badge, the "Blocking" section, and
  // the headline count a human reads first. Either way the tier claims that an
  // adversary looked and failed to knock the claim down, so the obligation is
  // honesty about what was checked, and a gate may act on it.
  //
  // The demotion below
  // fires on a THREE-part condition, and every part is load-bearing:
  //   1. a refuter was CONFIGURED for this run, so an adversarial check was
  //      genuinely owed to this finding;
  //   2. the run was truncated, so that leg was refused admission
  //      (src/review/pipeline.ts §5.3) and never spawned; and
  //   3. the verdict is `not_submitted`, the fallback `finish()` stamps on a
  //      survivor no verdict ever arrived for.
  // Parts 1 and 2 arrive pre-conjoined as `refuterCutShort` — deriveTier never
  // sees truncation on its own, deliberately, because the two are ORTHOGONAL
  // and collapsing them is the whole bug this gate was rewritten to close.
  // Demote for that triple and NOTHING else, because each neighbouring case
  // means something different:
  //   - `corroborated` on a cut-short run WAS adversarially checked before
  //     time ran out. Truncation is no reason to discard work that happened.
  //   - `inconclusive` means the refuter RAN and returned no positive
  //     downgrade — the standing rule above, paid for by AudioTrimmer.
  //   - `not_submitted` with NO refuter configured is the supported
  //     zero-refuter setup (src/review/spec.ts allows at most one refuter, so zero is
  //     configured absence, not failure). There `not_submitted` is the designed
  //     steady state, blocking is intended, and it stays intended no matter how
  //     the run ended — a hunter-bound or verify-bound ceiling on such a spec
  //     cut nothing short, because nothing was ever going to submit. Demoting
  //     it would empty blocking tier for every such user and undo the
  //     AudioTrimmer fix, which is exactly why part 1 exists.
  //   - `not_submitted` on a COMPLETE run with a refuter configured cannot
  //     occur — the leg either ran or was refused admission by truncation.
  // An `inferential` finding needs no branch here: unrefuted, it is already
  // advisory two lines down.
  // Recording WHY the check is missing IN the artifact needs a new
  // `refuter_verdict` value, and that is a coordinated schema v1.1 bump with
  // the sibling lab (ROADMAP C2) — deliberately not this fix.
  if (
    options.refuterCutShort === true &&
    finding.refuter_verdict === "not_submitted"
  )
    return "advisory";
  if (finding.evidence_class === "deterministic") return "blocking";
  return finding.refuter_verdict === "corroborated" ? "blocking" : "advisory";
}

export function mergeRunEnvelope(params: {
  skillOutput: SkillOutput;
  pr: number;
  base_sha: string;
  head_sha: string;
  model: string;
  iteration: number;
  prompt_set?: PromptSet;
  driver_sha?: string;
  engine: EngineIdentity;
  sessionFailed: boolean;
  telemetry: Telemetry;
}): FindingsDocument {
  const run_status: RunStatus =
    params.sessionFailed || params.skillOutput.run_status === "partial"
      ? "partial"
      : "complete";
  return {
    schema_version: SCHEMA_VERSION_V1_1,
    pr: params.pr,
    base_sha: params.base_sha,
    head_sha: params.head_sha,
    model: params.model,
    iteration: params.iteration,
    ...(params.prompt_set ? { prompt_set: params.prompt_set } : {}),
    ...(params.driver_sha ? { driver_sha: params.driver_sha } : {}),
    engine: params.engine,
    parity_hunter_fired: params.skillOutput.parity_hunter_fired,
    run_status,
    sessionFailed: params.sessionFailed,
    ...(params.skillOutput.summary === undefined
      ? {}
      : { summary: params.skillOutput.summary }),
    telemetry: params.telemetry,
    findings: params.skillOutput.findings,
    debug: params.skillOutput.debug,
  };
}

export async function writeFindings(
  outPath: string,
  doc: FindingsDocument,
): Promise<void> {
  const validated = validateFindingsDocument(doc);
  await Bun.write(outPath, `${JSON.stringify(validated, null, 2)}\n`);
}
