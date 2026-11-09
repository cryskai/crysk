// The action's report step: tell the Crysk platform how a run ended, so every
// run is recorded (#157) with its cost attributed (#139), then hand it the
// run's findings so the dashboard can show them.
//
// It runs only in platform mode (action.yml gates the step on
// `workflow_dispatch`, a non-empty `dispatch-id` and a run token being present),
// after the publish step. Standalone use never reaches it.
//
// WHY THE REPORT IS METADATA ONLY: the body carries counts, token totals,
// costs, model names and shas. It never carries a finding, a claim, a summary,
// a hop trail or any other text that can quote the customer's code. The
// builder below COPIES the numeric fields it names out of the run directory
// instead of forwarding a document, so a field added to findings.json tomorrow
// cannot leak by default.
//
// WHY THE FINDINGS GO SEPARATELY: they are the part that can quote customer
// code, so they travel in their own request to /runs/findings. The platform
// encrypts them and honors each repository's metadata-only mode on its side,
// but a metadata_only repository's code must never leave the runner at all:
// the action reads `data_mode` from the same token exchange as the run token
// (CRYSK_DATA_MODE) and, unless it is exactly `full`, this script reduces each
// finding to non-text fields (METADATA_ONLY_FINDING_FIELDS below). The body is
// exactly `{ schema_version, findings }`: the `findings` array as the engine
// wrote it (in `full` mode), never the document's `debug` arrays or its
// summary prose. It is sent only after the
// report succeeded (the report creates the run the findings attach to), and
// never for a run with no findings.json or zero findings.
//
// WHY it never fails the job: the review already succeeded or failed on its own
// merits and its outcome is posted. A platform that is down, a revoked token or
// a rejected field is reported as a `::warning::` with the HTTP status and the
// API's message, never a token, and the step exits 0. A findings upload that
// fails is a warning too, never a red job.
//
// WHY the base URL is the constant from ./platform and never an input: the run
// token goes to that URL (see platform.ts).
//
// WHY the run directory is read here: the report must also say what a review
// that wrote nothing did (skipped, size-gated, failed before writing), so a
// missing or unreadable directory is the zero report, not an error. The
// `run_dir` output is empty for a run where every hunter died, a fatal error
// and a cancelled job (action.yml "KNOWN GAP"), so those report zero counts
// even when a findings.json was written.
//
// RUNS BEFORE NO INSTALL, like publish: every import is a builtin or a module
// whose own import closure is package-free. test/ci/platform-report.test.ts
// walks that closure, so a package import added anywhere in it fails a test
// instead of failing the job at module load.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FINDING_STATE_FILE,
  type FindingStateRecord,
} from "../pr/finding-state-record";
import { GATE_RECORD_FILE } from "../pr/gate-record";
import type { FindingsDocument } from "../review/findings";
import { validateFindingsDocument } from "../review/findings";
import { PLATFORM_API_URL, type PlatformDataMode } from "./platform";

// The platform caps `agents` at 64 entries.
const MAX_AGENTS = 64;

// The platform accepts at most 500 findings per run. The first 500 in the
// engine's order go out and the rest are named in a warning.
const MAX_FINDINGS = 500;

// Long enough for a slow API, short enough that a hung endpoint cannot hold the
// job's tail.
const REQUEST_TIMEOUT_MS = 30_000;

const SHA = /^[0-9a-f]{40}$/;

// The token split of pipeline.json's `usage_v2`, under the platform's names. Each key is sent only when the
// engine reported it as a non-negative number, so a provider that reports no cache sends no cache keys
// rather than a zero it never measured.
interface ReportTokens {
  input_uncached?: number;
  input_cache_read?: number;
  input_cache_write?: number;
  output?: number;
}

// Added beside the legacy fields, never replacing them: `cost_usd` stays the cash cost (0 on a
// subscription), and `list_cost_usd` is what the same tokens cost at list price whatever paid for them.
interface ReportUsageSplit {
  tokens?: ReportTokens;
  list_cost_usd?: number;
}

export interface RunReportAgent extends ReportUsageSplit {
  agent_key: string;
  model?: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms?: number;
  attempts?: number;
  status?: string;
}

export interface RunReportBody {
  outcome: string;
  pr_number: number;
  head_sha: string;
  base_sha?: string | null;
  run_status?: string;
  schema_version?: string;
  engine_version?: string;
  model?: string;
  // `blocking` and `advisory` are this run's findings. `unresolved_blocking` is what the gate decides on,
  // earlier findings still open included; absent when the run recorded none.
  // `refuted_by_hunter` counts what the refuter removed, which never reaches `findings[]`.
  counts: {
    blocking: number;
    advisory: number;
    unresolved_blocking?: number;
    refuted_by_hunter?: Record<string, number>;
  };
  usage: ReportUsageSplit & {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    cost_is_floor?: boolean;
    wall_ms?: number;
    index_ms?: number;
    sync_ms?: number;
    billing?: "subscription" | "metered";
  };
  agents: RunReportAgent[];
  // Which findings stay open, under ids that last across runs. Absent when the run recorded none.
  finding_states?: FindingStateRecord;
}

// What the builder knows about the run directory. Either part is absent when
// the file is missing or unreadable.
export interface RunDirFacts {
  findings?: unknown;
  pipeline?: unknown;
  gate?: unknown;
  findingStates?: unknown;
}

export interface BuildRunReportInput {
  // The action's `status` output for this run. Empty when the CLI never wrote
  // one (a failure before it started); reported as `error`.
  outcome: string;
  prNumber: number;
  // The trigger's resolved head, the fallback when no findings were written.
  triggerHeadSha: string;
  run: RunDirFacts;
}

// null when the run has no usable head: the platform requires a 40-hex sha, so
// a report without one cannot be sent.
export function buildRunReport(
  input: BuildRunReportInput,
): RunReportBody | null {
  let doc: FindingsDocument | undefined;
  if (input.run.findings !== undefined) {
    try {
      doc = validateFindingsDocument(input.run.findings);
    } catch {
      // An unreadable document is a run that wrote nothing usable.
      doc = undefined;
    }
  }

  const headSha = [doc?.head_sha, input.triggerHeadSha].find(
    (sha): sha is string => typeof sha === "string" && SHA.test(sha),
  );
  if (headSha === undefined) return null;

  if (doc === undefined) {
    return {
      outcome: input.outcome === "" ? "error" : input.outcome,
      pr_number: input.prNumber,
      head_sha: headSha,
      counts: { blocking: 0, advisory: 0 },
      usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
      agents: [],
    };
  }

  const telemetry = doc.telemetry;
  let blocking = 0;
  let advisory = 0;
  for (const finding of doc.findings) {
    if (finding.tier === "blocking") blocking += 1;
    else if (finding.tier === "advisory") advisory += 1;
  }

  return {
    outcome: input.outcome === "" ? "error" : input.outcome,
    pr_number: input.prNumber,
    head_sha: headSha,
    ...(typeof doc.base_sha === "string" && SHA.test(doc.base_sha)
      ? { base_sha: doc.base_sha }
      : {}),
    run_status: doc.run_status,
    schema_version: doc.schema_version,
    ...(doc.engine === undefined ? {} : { engine_version: doc.engine.version }),
    ...(typeof doc.model === "string" && doc.model !== ""
      ? { model: doc.model }
      : {}),
    counts: {
      blocking,
      advisory,
      ...gateCount(input.run.gate),
      refuted_by_hunter: refutedByHunter(doc),
    },
    usage: {
      tokens_in: count(telemetry.tokens_in),
      tokens_out: count(telemetry.tokens_out),
      cost_usd: cost(telemetry.cost_usd_est),
      ...(telemetry.cost_usd_est_is_floor === true
        ? { cost_is_floor: true }
        : {}),
      wall_ms: count(telemetry.wall_ms),
      // Zero means no index was built, so there is no time to report.
      ...(count(telemetry.index_ms) > 0
        ? { index_ms: count(telemetry.index_ms) }
        : {}),
      ...(telemetry.sync_ms === undefined
        ? {}
        : { sync_ms: count(telemetry.sync_ms) }),
      ...runUsageSplit(input.run.pipeline),
    },
    agents: buildAgents(doc, input.run.pipeline),
    ...findingStates(input.run.findingStates),
  };
}

// The file is the run's own, but this goes off the runner, in metadata-only mode too: only the known
// fields of the known shapes pass, so a future field that quotes code cannot ride along. Rows past the
// cap count as dropped, so the platform says it does not know instead of reading them as resolved.
const STABLE_ID = /^R\d{3,}$/;
const FINDING_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const OPEN_STATUSES = new Set([
  "carried",
  "unconfirmed",
  "suppressed",
  "deferred",
]);
const TIERS = new Set(["blocking", "advisory", "unrecoverable"]);
const MAX_FINDING_STATES = 500;

function findingStates(record: unknown): {
  finding_states?: FindingStateRecord;
} {
  if (typeof record !== "object" || record === null) return {};
  const { open, fresh, resolved, superseded, dropped } = record as Record<
    string,
    unknown
  >;
  if (
    !Array.isArray(open) ||
    typeof fresh !== "object" ||
    fresh === null ||
    Array.isArray(fresh) ||
    !Array.isArray(resolved) ||
    typeof dropped !== "number" ||
    !Number.isInteger(dropped) ||
    dropped < 0
  ) {
    return {};
  }
  const rows = open.flatMap((row): FindingStateRecord["open"] => {
    const { id, status, tier } = (row ?? {}) as Record<string, unknown>;
    return typeof id === "string" &&
      STABLE_ID.test(id) &&
      typeof status === "string" &&
      OPEN_STATUSES.has(status) &&
      typeof tier === "string" &&
      TIERS.has(tier)
      ? [{ id, status, tier }]
      : [];
  });
  return {
    finding_states: {
      open: rows.slice(0, MAX_FINDING_STATES),
      fresh: Object.fromEntries(
        Object.entries(fresh as Record<string, unknown>)
          .filter(
            (entry): entry is [string, string] =>
              FINDING_ID.test(entry[0]) &&
              typeof entry[1] === "string" &&
              STABLE_ID.test(entry[1]),
          )
          .slice(0, MAX_FINDING_STATES),
      ),
      resolved: resolved
        .filter(
          (id): id is string => typeof id === "string" && STABLE_ID.test(id),
        )
        .slice(0, MAX_FINDING_STATES),
      superseded: (Array.isArray(superseded) ? superseded : [])
        .filter(
          (id): id is string => typeof id === "string" && STABLE_ID.test(id),
        )
        .slice(0, MAX_FINDING_STATES),
      dropped: dropped + Math.max(0, rows.length - MAX_FINDING_STATES),
    },
  };
}

// Counts only, and only a plain name: this goes off the runner in metadata-only mode too, and a refuted
// finding's claim can quote the customer's code.
function refutedByHunter(doc: FindingsDocument): Record<string, number> {
  // A Map, so a hunter named like an object's own property counts like any other.
  const counts = new Map<string, number>();
  for (const finding of doc.debug.refuted as unknown[]) {
    const name = (finding as { hunter?: unknown } | null | undefined)?.hunter;
    const hunter =
      typeof name === "string" && FINDING_ID.test(name) ? name : "unknown";
    counts.set(hunter, (counts.get(hunter) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

function gateCount(gate: unknown): { unresolved_blocking?: number } {
  const value = (gate as { unresolved_blocking?: unknown } | null | undefined)
    ?.unresolved_blocking;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? { unresolved_blocking: value }
    : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function cost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

// `telemetry.per_agent` is declared with the lab-shared minimum (tokens_total +
// duration_ms) but this engine writes the richer PerAgentUsage, so each field
// is read through a runtime check, as review/report.ts does. `detail` is never
// copied: it is the provider's own words and can echo prompt text.
function buildAgents(
  doc: FindingsDocument,
  pipeline: unknown,
): RunReportAgent[] {
  const steps = pipelineSteps(pipeline);
  const perAgent = doc.telemetry.per_agent ?? {};
  // validateFindingsDocument only checks that `telemetry` is an object, so a
  // row that is not one is skipped instead of read.
  const rows = Object.entries(perAgent as Record<string, unknown>).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      typeof entry[1] === "object" &&
      entry[1] !== null &&
      !Array.isArray(entry[1]),
  );
  // Owners are decided over every row, the capped ones too, so a step of a row
  // past the cap is dropped with it instead of landing on another row.
  const owned = stepsByOwner(
    steps,
    rows.map(([key]) => key),
  );
  return rows.slice(0, MAX_AGENTS).map(([key, row]) => {
    const model = modelOf(steps, key);
    return {
      agent_key: key,
      ...(model === undefined ? {} : { model }),
      tokens_in: count(row.tokens_in),
      tokens_out: count(row.tokens_out),
      cost_usd: cost(row.cost_usd_est),
      duration_ms: count(row.duration_ms),
      ...(typeof row.attempts === "number" && row.attempts > 0
        ? { attempts: count(row.attempts) }
        : {}),
      ...(typeof row.status === "string" ? { status: row.status } : {}),
      ...agentUsageSplit(owned.get(key) ?? []),
    };
  });
}

// pipeline.json's `steps[]` rows are `{ name, model, usage_v2, model_attempts, ... }`.
// Only what this file reads is kept, and `usage_v2` stays unread until the
// split below checks each of its fields.
interface PipelineStep {
  name: string;
  model?: string;
  usage?: unknown;
  modelUsages?: unknown[];
}

function pipelineSteps(pipeline: unknown): PipelineStep[] {
  if (typeof pipeline !== "object" || pipeline === null) return [];
  const steps = (pipeline as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const rows: PipelineStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const { name, model, usage_v2, model_attempts } = step as Record<
      string,
      unknown
    >;
    if (typeof name !== "string") continue;
    rows.push({
      name,
      ...(typeof model === "string" && model !== "" ? { model } : {}),
      usage: usage_v2,
      ...(Array.isArray(model_attempts)
        ? {
            modelUsages: model_attempts.map(
              (entry) => (entry as { usage_v2?: unknown } | null)?.usage_v2,
            ),
          }
        : {}),
    });
  }
  return rows;
}

// A hunter's step is `hunter-<key>`; a refuter, verifier or adjudicator fans
// out one step per finding (`refuter-F001`) under one `per_agent` row. Three
// rows are keyed by something other than their steps' name: the summary row's
// step is `summarizer`, the verifier's are `verify-<id>` and the adjudicator's
// are `adjudicate-<id>` (pipeline.ts, rereview/verify.ts). Without the alias
// those rows would go out with no model.
const STEP_NAME_ALIASES: Readonly<Record<string, string>> = {
  summary: "summarizer",
  verifier: "verify",
  adjudicator: "adjudicate",
};

// The one rule that says a step belongs to a `per_agent` row: the model a row
// reports and the usage it sums both follow it, so they cannot disagree about
// which steps are the row's. `exact` is a step named for the row itself; the
// rest is a fan-out step named after it.
function stepMatch(
  stepName: string,
  key: string,
): "exact" | "fan-out" | undefined {
  const stem = STEP_NAME_ALIASES[key] ?? key;
  if (stepName === key || stepName === stem || stepName === `hunter-${key}`) {
    return "exact";
  }
  return stepName.startsWith(`${stem}-`) ? "fan-out" : undefined;
}

function modelOf(
  steps: ReadonlyArray<PipelineStep>,
  key: string,
): string | undefined {
  return steps.find(
    (step) => step.model !== undefined && stepMatch(step.name, key),
  )?.model;
}

// Each step goes to one row at most, so no step is counted twice: a row named
// for the step wins over a row it fans out from, and otherwise the first row
// in `per_agent` order. A step no row claims (the warmups) is left out here and
// still counts in the run's own `usage_v2`.
function stepsByOwner(
  steps: ReadonlyArray<PipelineStep>,
  keys: ReadonlyArray<string>,
): Map<string, PipelineStep[]> {
  const owned = new Map<string, PipelineStep[]>();
  for (const step of steps) {
    const owner =
      keys.find((key) => stepMatch(step.name, key) === "exact") ??
      keys.find((key) => stepMatch(step.name, key) === "fan-out");
    if (owner === undefined) continue;
    owned.set(owner, [...(owned.get(owner) ?? []), step]);
  }
  return owned;
}

// The engine's normalized usage (execution/usage-normalized.ts), read field by
// field because this file only trusts what it checks: the run's own `usage_v2`
// and each step's, which already sums all of that step's attempts and models.
// Numbers and one enum only, so nothing the customer wrote can ride along. A
// field that is missing or malformed is left out on its own; the rest of the
// report never depends on it.
type UsageRecord = Record<string, unknown>;

function usageRecord(value: unknown): UsageRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UsageRecord)
    : undefined;
}

function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

// Absent when no source is: the same rule as `sumNormalizedUsage`, whose
// totals the run's `usage_v2` already carries.
function sumDefined(
  values: ReadonlyArray<number | undefined>,
): number | undefined {
  return values.every((value) => value === undefined)
    ? undefined
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function leaves(tokens: UsageRecord, names: readonly string[]) {
  return sumDefined(names.map((name) => amount(tokens[name])));
}

// The leaves are disjoint by the §8 contract, so adding them never counts a
// token twice. Uncached input is `inputUncached`, plus `inputOther` where an
// inclusive provider total was split into leaves. Output is everything billed
// as output, reasoning included, as `outputTokensKnown` counts it.
function tokenSplit(usage: UsageRecord | undefined): ReportTokens {
  const tokens = usageRecord(usage?.tokens);
  if (tokens === undefined) return {};
  const split: ReportTokens = {
    input_uncached: leaves(tokens, ["inputUncached", "inputOther"]),
    input_cache_read: leaves(tokens, ["inputCacheRead"]),
    input_cache_write: leaves(tokens, ["inputCacheWrite"]),
    output: leaves(tokens, ["outputVisible", "outputReasoning", "outputOther"]),
  };
  return Object.fromEntries(
    Object.entries(split)
      .filter((entry): entry is [string, number] => entry[1] !== undefined)
      .map(([key, value]) => [key, Math.round(value)]),
  );
}

// The list price of what one usage record consumed. The Claude CLI files the
// CLI's list total in exactly one field (transports/claude-code-cli.ts,
// `costFor`): `notionalCostUsd` on a subscription, which charges nothing, and
// `cashCostUsd` on a per-token key, where list price is the charge. Any other
// billing (free, or unknown because attempts disagreed) names no field that
// holds a list price, so it has none rather than a guessed one.
function listCost(usage: UsageRecord | undefined): number | undefined {
  switch (usage?.billingMode) {
    case "subscription":
      return amount(usage.notionalCostUsd);
    case "metered":
      return amount(usage.cashCostUsd);
    default:
      return undefined;
  }
}

// A step whose models billed differently reads `unknown` once summed, so its
// list cost is each model's own (`model_attempts[].usage_v2`, kept for exactly
// this). Unknown when any model that reported usage cannot be priced.
function stepListCost(step: PipelineStep): number | undefined {
  const usage = usageRecord(step.usage);
  const own = listCost(usage);
  if (own !== undefined || step.modelUsages === undefined) return own;
  return sumAll(
    step.modelUsages.map(usageRecord).filter((entry) => entry !== undefined),
    listCost,
  );
}

// A sum only when every record that reported usage has a value: one unpriced
// part would make the total look smaller than what was spent.
function sumAll<T>(
  items: readonly T[],
  value: (item: T) => number | undefined,
): number | undefined {
  if (items.length === 0) return undefined;
  let total = 0;
  for (const item of items) {
    const part = value(item);
    if (part === undefined) return undefined;
    total += part;
  }
  return total;
}

function splitFields(
  tokens: ReportTokens,
  listUsd: number | undefined,
): ReportUsageSplit {
  return {
    ...(Object.keys(tokens).length === 0 ? {} : { tokens }),
    ...(listUsd === undefined ? {} : { list_cost_usd: listUsd }),
  };
}

// The run's split comes from its own `usage_v2`. Its list cost too, unless the
// steps billed differently (`unknown`), and then it is the sum of every step's.
function runUsageSplit(
  pipeline: unknown,
): ReportUsageSplit & { billing?: "subscription" | "metered" } {
  const usage = usageRecord(usageRecord(pipeline)?.usage_v2);
  if (usage === undefined) return {};
  const billing = usage.billingMode;
  const priced = pipelineSteps(pipeline).filter(
    (step) => usageRecord(step.usage) !== undefined,
  );
  return {
    ...splitFields(
      tokenSplit(usage),
      listCost(usage) ??
        (billing === "unknown" ? sumAll(priced, stepListCost) : undefined),
    ),
    ...(billing === "subscription" || billing === "metered" ? { billing } : {}),
  };
}

// A row's split is the sum of the steps it owns, refuter fan-out included.
function agentUsageSplit(steps: ReadonlyArray<PipelineStep>): ReportUsageSplit {
  const usages = steps.filter((step) => usageRecord(step.usage) !== undefined);
  if (usages.length === 0) return {};
  const splits = usages.map((step) => tokenSplit(usageRecord(step.usage)));
  const tokens = Object.fromEntries(
    (
      [
        "input_uncached",
        "input_cache_read",
        "input_cache_write",
        "output",
      ] as const
    ).flatMap((key) => {
      const total = sumDefined(splits.map((split) => split[key]));
      return total === undefined ? [] : [[key, total]];
    }),
  );
  return splitFields(tokens, sumAll(usages, stepListCost));
}

// Reads findings.json and pipeline.json from a run directory. A missing or
// unparseable file is simply absent.
export function readRunDir(
  runDir: string,
  readText: (file: string) => string = (file) => readFileSync(file, "utf8"),
): RunDirFacts {
  const facts: RunDirFacts = {};
  if (runDir === "") return facts;
  for (const [key, file] of [
    ["findings", "findings.json"],
    ["pipeline", "pipeline.json"],
    ["gate", GATE_RECORD_FILE],
    ["findingStates", FINDING_STATE_FILE],
  ] as const) {
    try {
      facts[key] = JSON.parse(readText(path.join(runDir, file)));
    } catch {
      // absent or malformed: see above
    }
  }
  return facts;
}

export type SendReportResult =
  | { ok: true; recorded: boolean; runId?: string }
  // `message` names the HTTP status and the API's own `message`. It never
  // carries the token.
  | { ok: false; message: string };

export interface SendReportDeps {
  fetch: typeof fetch;
  baseUrl: string;
  runToken: string;
}

type PostResult =
  | { ok: true; reply: Record<string, unknown> }
  | { ok: false; message: string };

// One authenticated JSON POST to the platform. Every failure, whether an HTTP
// status or a transport error, comes back as a message that never carries the
// token.
async function postJson(
  deps: SendReportDeps,
  endpoint: string,
  body: unknown,
): Promise<PostResult> {
  try {
    const response = await deps.fetch(`${deps.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.runToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const message = await apiMessage(response);
      return {
        ok: false,
        message: `HTTP ${response.status}${message === undefined ? "" : ` — ${message}`}`,
      };
    }
    const parsed: unknown = await response.json().catch(() => ({}));
    return {
      ok: true,
      reply: typeof parsed === "object" && parsed !== null ? { ...parsed } : {},
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `the request could not complete: ${detail.split(deps.runToken).join("***")}`,
    };
  }
}

export async function sendRunReport(
  deps: SendReportDeps,
  body: RunReportBody,
): Promise<SendReportResult> {
  const result = await postJson(deps, "/runs/report", body);
  if (!result.ok) return result;
  // recorded=false is a repeat of the same run attempt: a success.
  const { reply } = result;
  return {
    ok: true,
    recorded: reply.recorded !== false,
    ...(typeof reply.run_id === "string" ? { runId: reply.run_id } : {}),
  };
}

export interface FindingsUploadBody {
  schema_version: string;
  // Each object exactly as the engine wrote it into findings.json.
  findings: unknown[];
}

export interface FindingsUpload {
  body: FindingsUploadBody;
  // Findings beyond MAX_FINDINGS that were left out of the body.
  dropped: number;
}

// The only fields of a finding a metadata_only repository's upload carries: ids,
// locations, enum-like labels and counters. NEVER the claim, proof_refs,
// hop_trail, symbol, dedupe_key or materiality (all can quote the code), and
// NEVER a key this list does not name, so a field added to the engine
// tomorrow stays on the runner by default.
const METADATA_ONLY_FINDING_FIELDS = [
  "id",
  "category",
  "path",
  "line",
  "severity",
  "tier",
  "hunter",
  "evidence_class",
  "refuter_verdict",
  "causal_disposition",
  "root_cause_id",
  "hops_used",
] as const;

function metadataOnlyFinding(finding: unknown): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  if (typeof finding !== "object" || finding === null) return kept;
  for (const field of METADATA_ONLY_FINDING_FIELDS) {
    const value: unknown = Reflect.get(finding, field);
    // Scalars only: a structure under an allowlisted name is not the field the
    // platform expects and could hold text.
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      kept[field] = value;
    }
  }
  return kept;
}

// null when there is nothing to upload: no findings.json, one this engine
// cannot read, or zero findings. The document is validated only to know it is
// one; in `full` mode the objects sent are the raw parsed ones, so a field the
// validator does not model still reaches the platform untouched. In
// `metadata_only` mode each is reduced to METADATA_ONLY_FINDING_FIELDS.
export function buildFindingsUpload(
  document: unknown,
  dataMode: PlatformDataMode,
): FindingsUpload | null {
  let doc: FindingsDocument;
  try {
    doc = validateFindingsDocument(document);
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null) return null;
  const raw = "findings" in document ? document.findings : undefined;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const sent: unknown[] = raw.slice(0, MAX_FINDINGS);
  return {
    body: {
      schema_version: doc.schema_version,
      findings: dataMode === "full" ? sent : sent.map(metadataOnlyFinding),
    },
    dropped: Math.max(0, raw.length - MAX_FINDINGS),
  };
}

export type SendFindingsResult =
  | {
      ok: true;
      stored: number;
      recorded: boolean;
      mode: "full" | "metadata_only" | undefined;
    }
  // Same message contract as SendReportResult.
  | { ok: false; message: string };

export async function sendRunFindings(
  deps: SendReportDeps,
  body: FindingsUploadBody,
): Promise<SendFindingsResult> {
  const result = await postJson(deps, "/runs/findings", body);
  if (!result.ok) return result;
  const { reply } = result;
  return {
    ok: true,
    stored: typeof reply.stored === "number" ? reply.stored : 0,
    // recorded=false is a repeat of the same upload: a success.
    recorded: reply.recorded !== false,
    mode:
      reply.mode === "full" || reply.mode === "metadata_only"
        ? reply.mode
        : undefined,
  };
}

async function apiMessage(response: Response): Promise<string | undefined> {
  try {
    const parsed = (await response.json()) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message !== ""
      ? parsed.message
      : undefined;
  } catch {
    return undefined;
  }
}

function escapeCommandData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export interface RunReportStepDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  baseUrl: string;
  readText?: (file: string) => string;
  stdout: (text: string) => void;
}

// The step's shell. ALWAYS 0: see the header.
export async function runReportStep(deps: RunReportStepDeps): Promise<number> {
  const runToken = deps.env.CRYSK_RUN_TOKEN ?? "";
  const warn = (message: string): void =>
    deps.stdout(
      `::warning title=crysk::${escapeCommandData(`Crysk run report not recorded: ${message}`)}\n`,
    );
  const warnFindings = (message: string): void =>
    deps.stdout(
      `::warning title=crysk::${escapeCommandData(`Crysk findings not uploaded: ${message}`)}\n`,
    );
  // The whole step, not only the request: a run directory this engine wrote is
  // read and shaped here too, and a throw from either must still be a warning.
  try {
    if (runToken === "") {
      warn("no run token reached this step.");
      return 0;
    }
    const prNumber = Number(deps.env.TRIGGER_PR ?? "");
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      warn("the run resolved no pull request number.");
      return 0;
    }
    const run = readRunDir(deps.env.CRYSK_RUN_DIR ?? "", deps.readText);
    const body = buildRunReport({
      outcome: deps.env.CRYSK_OUTCOME ?? "",
      prNumber,
      triggerHeadSha: deps.env.TRIGGER_HEAD_SHA ?? "",
      run,
    });
    if (body === null) {
      warn("the run resolved no head sha.");
      return 0;
    }
    const platform = { fetch: deps.fetch, baseUrl: deps.baseUrl, runToken };
    const result = await sendRunReport(platform, body);
    if (!result.ok) {
      warn(result.message);
      return 0;
    }
    // Only a recorded run has somewhere for findings to attach (409 otherwise).
    try {
      const upload = buildFindingsUpload(
        run.findings,
        deps.env.CRYSK_DATA_MODE === "full" ? "full" : "metadata_only",
      );
      if (upload === null) return 0;
      if (upload.dropped > 0) {
        warnFindings(
          `only the first ${MAX_FINDINGS} findings are uploaded; ${upload.dropped} more were dropped.`,
        );
      }
      const sent = await sendRunFindings(platform, upload.body);
      if (!sent.ok) warnFindings(sent.message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnFindings(
        `the findings could not be sent: ${detail.split(runToken).join("***")}`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(
      `the report could not be built: ${detail.split(runToken).join("***")}`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(
    await runReportStep({
      fetch,
      env: process.env,
      baseUrl: PLATFORM_API_URL,
      stdout: (text) => process.stdout.write(text),
    }),
  );
}
