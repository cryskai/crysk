// The action's report step: tell the Crysk platform how a run ended, so every
// run is recorded (#157) with its cost attributed (#139).
//
// It runs only in platform mode (action.yml gates the step on
// `workflow_dispatch`, a non-empty `dispatch-id` and a run token being present),
// after the publish step. Standalone use never reaches it.
//
// WHY METADATA ONLY: the body carries counts, token totals, costs, model names
// and shas. It never carries a finding, a claim, a summary, a hop trail or any
// other text that can quote the customer's code. The builder below COPIES the
// numeric fields it names out of the run directory instead of forwarding a
// document, so a field added to findings.json tomorrow cannot leak by default.
//
// WHY it never fails the job: the review already succeeded or failed on its own
// merits and its outcome is posted. A platform that is down, a revoked token or
// a rejected field is reported as a `::warning::` with the HTTP status and the
// API's message, never a token, and the step exits 0.
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
import type { FindingsDocument } from "../review/findings";
import { validateFindingsDocument } from "../review/findings";
import { PLATFORM_API_URL } from "./platform";

// The platform caps `agents` at 64 entries.
const MAX_AGENTS = 64;

// Long enough for a slow API, short enough that a hung endpoint cannot hold the
// job's tail.
const REQUEST_TIMEOUT_MS = 30_000;

const SHA = /^[0-9a-f]{40}$/;

export interface RunReportAgent {
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
  counts: { blocking: number; advisory: number };
  usage: {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    cost_is_floor?: boolean;
    wall_ms?: number;
  };
  agents: RunReportAgent[];
}

// What the builder knows about the run directory. Either part is absent when
// the file is missing or unreadable.
export interface RunDirFacts {
  findings?: unknown;
  pipeline?: unknown;
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
    counts: { blocking, advisory },
    usage: {
      tokens_in: count(telemetry.tokens_in),
      tokens_out: count(telemetry.tokens_out),
      cost_usd: cost(telemetry.cost_usd_est),
      ...(telemetry.cost_usd_est_is_floor === true
        ? { cost_is_floor: true }
        : {}),
      wall_ms: count(telemetry.wall_ms),
    },
    agents: buildAgents(doc, input.run.pipeline),
  };
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
  const models = stepModels(pipeline);
  const perAgent = doc.telemetry.per_agent ?? {};
  // validateFindingsDocument only checks that `telemetry` is an object, so a
  // row that is not one is skipped instead of read.
  return Object.entries(perAgent as Record<string, unknown>)
    .filter(
      (entry): entry is [string, Record<string, unknown>] =>
        typeof entry[1] === "object" &&
        entry[1] !== null &&
        !Array.isArray(entry[1]),
    )
    .slice(0, MAX_AGENTS)
    .map(([key, row]) => {
      const model = modelOf(models, key);
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
      };
    });
}

// pipeline.json's `steps[]` rows are `{ name, model, ... }`.
function stepModels(pipeline: unknown): Array<{ name: string; model: string }> {
  if (typeof pipeline !== "object" || pipeline === null) return [];
  const steps = (pipeline as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const rows: Array<{ name: string; model: string }> = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const { name, model } = step as { name?: unknown; model?: unknown };
    if (typeof name === "string" && typeof model === "string" && model !== "") {
      rows.push({ name, model });
    }
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

function modelOf(
  steps: ReadonlyArray<{ name: string; model: string }>,
  key: string,
): string | undefined {
  const stem = STEP_NAME_ALIASES[key] ?? key;
  return steps.find(
    (step) =>
      step.name === key ||
      step.name === stem ||
      step.name === `hunter-${key}` ||
      step.name.startsWith(`${stem}-`),
  )?.model;
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

export async function sendRunReport(
  deps: SendReportDeps,
  body: RunReportBody,
): Promise<SendReportResult> {
  try {
    const response = await deps.fetch(`${deps.baseUrl}/runs/report`, {
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
    // recorded=false is a repeat of the same run attempt: a success.
    const parsed: unknown = await response.json().catch(() => ({}));
    const reply: Record<string, unknown> =
      typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
    return {
      ok: true,
      recorded: reply.recorded !== false,
      ...(typeof reply.run_id === "string" ? { runId: reply.run_id } : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `the request could not complete: ${detail.split(deps.runToken).join("***")}`,
    };
  }
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
    const body = buildRunReport({
      outcome: deps.env.CRYSK_OUTCOME ?? "",
      prNumber,
      triggerHeadSha: deps.env.TRIGGER_HEAD_SHA ?? "",
      run: readRunDir(deps.env.CRYSK_RUN_DIR ?? "", deps.readText),
    });
    if (body === null) {
      warn("the run resolved no head sha.");
      return 0;
    }
    const result = await sendRunReport(
      { fetch: deps.fetch, baseUrl: deps.baseUrl, runToken },
      body,
    );
    if (!result.ok) warn(result.message);
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
