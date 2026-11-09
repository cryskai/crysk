// The pure error contract for the agent-first CI (odd/tasks/agent-first-ci.md,
// T2a / S2). Every failure pr-hero reports in action mode is classified into
// one ErrorClass, named by one stable ErrorCode, given an owner that says whose
// fix it is (your configuration, a provider, pr-hero itself, or unclassified:
// never a guess), and rendered as one workflow-command annotation plus a
// Markdown summary block.
//
// Consumers: test/ci/outcome.test.ts (now); the publisher and status mapping
// (T2b) and classify-error / CliError.cls (T2c) later. Every export is one of
// those. ERROR_CODES and ERROR_CATALOG are exported so the tests can walk every
// code and check the docs section against the catalog text.
//
// WHY ONLY BUILTINS: the action step that prints these errors runs BEFORE
// `bun install` (the same rule as src/ci/trigger.ts), so this module may import
// nothing but `node:` / `bun` builtins at runtime. Repository modules are
// imported with `import type` only: those are erased at transpile time and need
// no node_modules. test/ci/outcome.test.ts fails if a runtime import of a repo
// module appears here.
//
// The escape rule in escapeCommandData is a COPY of the one in
// src/ci/trigger.ts. That copy is private there, so it cannot be imported
// without widening trigger.ts; the drift test compares the two source texts.

import { commandHint, MARKER_OPEN, matchMarkerPrefix } from "../brand";
import type {
  FailureCredential,
  TransportFailureCause,
} from "../execution/contracts";
import type { CredentialProjectionFailureClass } from "../security/credential-broker";

export type Owner = "config" | "provider" | "pr-hero" | "unclassified";
export type OutcomeContext = "action" | "local";
// An owner is fixed, or depends on the context (CRYSK-RUNTIME-UNAVAILABLE).
type OwnerRule = Owner | Readonly<Record<OutcomeContext, Owner>>;

type CapabilityIssue =
  | "binary_unresolved"
  | "sdk_unavailable"
  | "version_unsupported";

export type ErrorClass =
  | {
      kind: "trigger";
      check: "no-credential" | "removed-input" | "pr-unresolved";
    }
  | {
      kind: "config-parse";
      // `models-input` and `credentials-input`: the setup step's reading of the
      // `models` and `credentials` inputs (D1), never the CLI's.
      source:
        | "models-input"
        | "credentials-input"
        | "repo-config"
        | "person-config"
        | "extra-hunters";
    }
  | { kind: "prompt-set" }
  | { kind: "gotchas"; reason: "empty" | "placeholder" }
  | {
      kind: "credential";
      failureClass: CredentialProjectionFailureClass | "env-absent";
    }
  | { kind: "capability"; issue: CapabilityIssue }
  | { kind: "transport"; cause: TransportFailureCause | "legacy_terminal" }
  // `rateLimited` is the caller's reading of the response body: GitHub answers
  // a spent rate limit with 403 or 429, and a refused permission with 403.
  | { kind: "github"; status: number; rateLimited?: boolean }
  | { kind: "install"; step: string }
  | { kind: "invariant" }
  | { kind: "unknown" };

type GithubClass = Extract<ErrorClass, { kind: "github" }>;

export const ERROR_CODES = [
  "CRYSK-CRED-MISSING",
  "CRYSK-INPUT-REMOVED",
  "CRYSK-CRED-UNUSABLE",
  "CRYSK-CRED-REJECTED",
  "CRYSK-MODEL-UNAVAILABLE",
  "CRYSK-PROMPTSET-INVALID",
  "CRYSK-GOTCHAS-MISSING",
  "CRYSK-CONFIG-INVALID",
  "CRYSK-TOKEN-PERMISSION",
  "CRYSK-GITHUB-TOKEN-INVALID",
  "CRYSK-GITHUB-UNAVAILABLE",
  "CRYSK-PR-UNRESOLVED",
  "CRYSK-STATUS-WRITE-FAILED",
  "CRYSK-RUNTIME-UNAVAILABLE",
  "CRYSK-INSTALL-FAILED",
  "CRYSK-PROVIDER-LIMITED",
  "CRYSK-PROVIDER-UNAVAILABLE",
  "CRYSK-PROVIDER-REFUSED",
  "CRYSK-ENGINE-DEFECT",
  "CRYSK-HUNTERS-FAILED",
  "CRYSK-UNCLASSIFIED",
  "CRYSK-CANCELLED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface CatalogVariant {
  // Replaces the entry's `what` for this sub-class.
  readonly what?: string;
  // Replaces `what` when no model is given, so the sentence never names a placeholder
  // (CRYSK-MODEL-UNAVAILABLE's every_hunter variant). Filled like `what`.
  readonly whatWithoutModel?: string;
  // Replaces the entry's owner for this sub-class.
  readonly owner?: OwnerRule;
  readonly why: string;
  // A list of fix lines, or a function of the params when the steps depend on
  // them (the backend: missing_subscription_record, and CRYSK-CRED-MISSING's
  // route).
  readonly fixes:
    | readonly string[]
    | ((params: ErrorParams) => readonly string[]);
  // The annotation's Fix: ONE short imperative sentence that names the real
  // fixing step, with no trailing period. A string is filled like the other
  // text; a function reads the params when one value picks the step.
  readonly annotationFix: string | ((params: ErrorParams) => string);
}

// A fix line starting with "$ " is a command; any other line is prose. Each
// placeholder {name} is one ErrorParams key (see NEUTRAL below for the words
// used when a value is missing).
export interface CatalogEntry {
  readonly level: "error" | "notice";
  readonly owner: OwnerRule;
  readonly headline?: string;
  readonly lead?: string;
  readonly providerName?: string;
  readonly what: string;
  // Replaces `what` when no step is given, so the sentence never names the
  // placeholder ("The this step step failed"). Filled like `what`.
  readonly whatWithoutStep?: string;
  // "default" is always present. Keys "action" / "local" select by context
  // (CRYSK-RUNTIME-UNAVAILABLE); other keys are the failure's sub-class
  // (credential failureClass, route reason, GitHub status family), chosen by
  // renderError or by the caller through renderCode.
  readonly variants: Readonly<Record<string, CatalogVariant>>;
}

export interface ErrorParams {
  backend?: string;
  provider?: string;
  step?: string;
  secret?: string;
  scope?: string;
  pr?: number;
  runId?: string;
  runUrl?: string;
  detail?: string;
  // The model a provider does not serve, when the record names it (CRYSK-MODEL-UNAVAILABLE).
  model?: string;
}

export interface RenderedError {
  code: ErrorCode;
  owner: Owner;
  // The one sentence the owner lead introduces, filled and without the lead.
  // The publisher uses it for the commit status description.
  what: string;
  annotation: string;
  summary: string[];
}

// The record the trigger step writes to `trigger.json` in the outcome
// directory, and the publisher reads back (odd/tasks/agent-first-ci.md, T2b).
// It carries the decision, never a secret, a comment body or gh's own text.
export interface TriggerRecord {
  v: 1;
  decision:
    | "review"
    | "ignore"
    | "denied"
    | "unverifiable"
    | "no-credentials"
    | "removed-inputs"
    | "override";
  cls?: ErrorClass;
  params: ErrorParams;
  pr?: number;
  head_sha?: string;
  // Only for an override: the login that unlocked the gate (odd/tasks/agent-first-ci.md,
  // S8). The override must name who acted, so an override without one is refused.
  actor?: string;
  repository: string;
  run_id: string;
  // The attempt of this run. gh run rerun keeps run_id for every attempt, so
  // the attempt is what tells a re-run from the run it repeats. A record with
  // no attempt was written before attempts were recorded: parseTriggerRecord
  // reads it as attempt 1.
  run_attempt: number;
  run_url: string;
}

// The record the setup step writes to `setup.json` in the outcome directory when a
// models or OpenCode auth input is malformed (odd/tasks/agent-first-ci.md, A1).
// The publisher reads it back, so the failure is named instead of reported as a
// generic install failure. `detail` is a fixed phrase per failure site that names
// the input which is wrong; it never carries that input's content.
export interface SetupRecord {
  v: 1;
  cls: ErrorClass;
  detail: string;
}

// The record the CLI writes to `cli.json` in the outcome directory for its own
// terminal outcome (odd/tasks/agent-first-ci.md, T2c). The publisher reads it
// back, and no record at all means the CLI stopped before reporting. It never
// carries a secret, raw error text, a comment body or gh's output: `cls` names a
// class, never a message.
export const CLI_RECORD_FILE = "cli.json";
// SB3: the created_at GitHub returned for the CLI's own pending status, written once the
// pending landed. The cancel settle overwrites only the pending with exactly this time.
export const PENDING_AT_FILE = "pending-at";

// The URL of this run's attempt, or undefined outside GitHub Actions. The CLI's pending names
// it as its target_url, and the cancel settle compares a pending with it (SB3 follow-up), so
// the CLI and the publisher share this one builder: they cannot disagree on the URL. An attempt
// that is not a positive integer reads as the first attempt, as the trigger record writes it.
export function actionsRunUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (env.GITHUB_ACTIONS !== "true") return undefined;
  const server = env.GITHUB_SERVER_URL ?? "";
  const repository = env.GITHUB_REPOSITORY ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  if (server === "" || repository === "" || runId === "") return undefined;
  const attempt = /^[0-9]+$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
    ? Number(env.GITHUB_RUN_ATTEMPT)
    : 0;
  const first = attempt > 0 ? attempt : 1;
  return `${server}/${repository}/actions/runs/${runId}/attempts/${first}`;
}

// The only classes the CLI writes (src/ci/classify-error.ts). A wider reader
// would hide a writer's bug, the same rule as parseRecordClass below. The config
// classes are the ones a throw site names (T2d-1). The person layer is not one of
// them: its catalog text names the repo file, so the record would send the reader
// to the wrong file.
export type CliErrorClass =
  | { kind: "unknown" }
  | { kind: "capability"; issue: "sdk_unavailable" | "version_unsupported" }
  | {
      kind: "config-parse";
      source: "repo-config" | "extra-hunters";
    }
  | { kind: "prompt-set" }
  | { kind: "gotchas"; reason: "empty" | "placeholder" }
  | { kind: "invariant" };

// The final commit status a gate run could not write after its review was delivered.
// The publisher posts it once more on the record's head (see CliRecord.unsettled_status).
export interface UnsettledStatus {
  state: "success" | "failure";
  description: string;
}

// GitHub's limit on a commit status description. The publisher clips to it, and the
// record refuses a longer description, so the two cannot drift apart.
export const STATUS_DESCRIPTION_MAX = 140;

export interface CliRecord {
  v: 1;
  // "reviewing" is progress, not an outcome: the CLI took the pending lock on
  // head_sha and has not reported one yet. Every outcome overwrites it, and the
  // publisher reads it as the one case where the lock is this run's own.
  outcome:
    | "reviewing"
    | "reviewed"
    | "hunters-failed"
    | "skipped"
    | "yielded"
    | "error";
  // Only for outcome "skipped".
  skip?: "size" | "budget" | "coverage" | "manual-required" | "excluded";
  // The head the CLI reviewed or resolved, when it knows one. 40 lowercase hex.
  // Required for "reviewing": the head the CLI is about to post its pending
  // status on (the head it holds the review lock for).
  head_sha?: string;
  // Only for outcome "error".
  cls?: CliErrorClass;
  // Only for outcome "error", and the writer does not set it today.
  params?: ErrorParams;
  // Only for outcome "reviewed". The review was delivered, but the CLI's final status
  // write on head_sha failed, so the head's required check is still pending. The
  // publisher posts this status once more (src/ci/publish.ts), exactly as the CLI tried
  // to write it.
  unsettled_status?: UnsettledStatus;
  // Only for outcome "reviewed", beside unsettled_status: the override cutoff, in ms, that the
  // CLI computed for this run (overrideCutoffMs, src/ci/override.ts): the instant at or after
  // which an override counts as posted during the run. The publisher compares with it as it is,
  // and never re-derives it. Absent on a record without one, and then the publisher reposts as
  // before.
  override_cutoff_ms?: number;
  // Only for outcome "hunters-failed": one entry per failed hunter step, in the order
  // they settled, and never an empty list. Each entry names what its transport
  // reported and the route it ran on, when it knows them. An entry with no cause is a
  // failure the CLI did not classify, so the publisher keeps the generic code for it.
  hunter_failures?: HunterFailureRecord[];
}

export interface HunterFailureRecord {
  cause?: TransportFailureCause;
  // The route's provider and model, as short safe strings (see safeProviderName).
  provider?: string;
  model?: string;
  // One short line saying why the hunter failed, in the provider's words (see
  // safeFailureDetail). Present only when the transport knew it.
  detail?: string;
  // The secret the hunter ran on (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN), so a
  // credential or quota failure can name which one to replace or top up.
  credential?: FailureCredential;
}

// Every TransportFailureCause, as a runtime lookup the record reader can check a
// cause against. The `satisfies` clause fails tsc when the union gains or loses a
// cause this list does not match (the record reads the same vocabulary the transport
// writes). This file cannot import the runtime list from execution/contracts.
const TRANSPORT_CAUSE_LOOKUP = {
  auth_invalid: true,
  quota_exhausted: true,
  rate_limit: true,
  network_transient: true,
  protocol_truncation: true,
  protocol_mismatch: true,
  protocol_overflow: true,
  output_limit_exceeded: true,
  context_window_exceeded: true,
  safety_refusal: true,
  provider_configuration_invalid: true,
  model_unavailable: true,
  missing_provider_record: true,
  runtime_unavailable: true,
  remote_abort_unconfirmed: true,
} satisfies Record<TransportFailureCause, true>;

// The cause when it is a transport cause, otherwise undefined.
export function knownTransportCause(
  value: unknown,
): TransportFailureCause | undefined {
  return typeof value === "string" &&
    Object.hasOwn(TRANSPORT_CAUSE_LOOKUP, value)
    ? (value as TransportFailureCause)
    : undefined;
}

// A provider name or a model name, as the record may carry it. Both are configuration
// the operator wrote, never provider text, but the record is a file the publisher
// reads back, so a value that could carry a control character or a path is refused.
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,95}$/;

export function safeProviderName(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_NAME_PATTERN.test(value)
    ? value
    : undefined;
}

export function safeModelName(value: unknown): string | undefined {
  return typeof value === "string" && MODEL_NAME_PATTERN.test(value)
    ? value
    : undefined;
}

// Every FailureCredential, as a runtime lookup (tied to the union by `satisfies`, like the
// cause list above: this file cannot import the runtime list from execution/contracts).
const FAILURE_CREDENTIAL_LOOKUP = {
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_AUTH_TOKEN: true,
  CLAUDE_CODE_OAUTH_TOKEN: true,
} satisfies Record<FailureCredential, true>;

export function knownFailureCredential(
  value: unknown,
): FailureCredential | undefined {
  return typeof value === "string" &&
    Object.hasOwn(FAILURE_CREDENTIAL_LOOKUP, value)
    ? (value as FailureCredential)
    : undefined;
}

// A failure detail, as the record may carry it. Unlike a provider or model name it is the
// provider's own text, so the record accepts only one short line with no control
// characters: it is later placed in a commit status, an annotation and a comment. The
// writer (hunterFailureRecords) and the reader share this one check, and the cap matches
// the engine's failure reason (stepFailureReason).
const FAILURE_DETAIL_MAX = 160;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse control characters
const FAILURE_DETAIL_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

export function safeFailureDetail(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.trim() === value &&
    value.length <= FAILURE_DETAIL_MAX &&
    FAILURE_DETAIL_PATTERN.test(value)
    ? value
    : undefined;
}

const TRIGGER_DECISIONS: readonly TriggerRecord["decision"][] = [
  "review",
  "ignore",
  "denied",
  "unverifiable",
  "no-credentials",
  "removed-inputs",
  "override",
];
// A GitHub login, with the bound and characters of the trigger's check (GITHUB_LOGIN in
// src/ci/trigger.ts), including the 91-character limit that keeps the override's status
// description within GitHub's 140. A copy, not an import: this file and trigger.ts may
// import builtins only at runtime (see the header of src/ci/trigger.ts), and
// test/ci/outcome.test.ts fails if the two texts differ.
const LOGIN_PATTERN = /^(?=.{1,91}$)[A-Za-z0-9][A-Za-z0-9_-]{0,90}(\[bot\])?$/;
const RECORD_PARAM_KEYS: readonly string[] = [
  "backend",
  "provider",
  "step",
  "secret",
  "scope",
  "runId",
  "runUrl",
  "detail",
];
const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseRecordParams(value: unknown): ErrorParams | undefined {
  if (!isRecordObject(value)) return undefined;
  const params: Record<string, string | number> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "pr") {
      if (!isPositiveInteger(field)) return undefined;
      params.pr = field;
    } else if (RECORD_PARAM_KEYS.includes(key) && typeof field === "string") {
      params[key] = field;
    } else {
      return undefined;
    }
  }
  return params as ErrorParams;
}

// The two classes the setup step writes, and no others: a wider reader would hide
// a writer's bug, the same rule as parseRecordClass below.
function parseSetupClass(value: unknown): ErrorClass | undefined {
  if (!isRecordObject(value)) return undefined;
  if (
    value.kind === "config-parse" &&
    (value.source === "models-input" || value.source === "credentials-input")
  ) {
    return { kind: "config-parse", source: value.source };
  }
  if (
    value.kind === "credential" &&
    value.failureClass === "malformed_payload"
  ) {
    return { kind: "credential", failureClass: "malformed_payload" };
  }
  return undefined;
}

// Returns undefined for anything the publisher must not act on. The publisher
// then reports the generic install failure, with a warning that says why.
export function parseSetupRecord(text: string): SetupRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecordObject(value) || value.v !== 1) return undefined;
  const cls = parseSetupClass(value.cls);
  if (cls === undefined) return undefined;
  if (typeof value.detail !== "string" || value.detail.trim() === "") {
    return undefined;
  }
  return { v: 1, cls, detail: value.detail };
}

// The classes the trigger writes. Any other kind is refused: the record is a
// contract between two modules, and a wider reader would hide a writer's bug.
// The trigger's writer type (RecordClass in src/ci/trigger.ts) allows exactly
// one trigger check, pr-unresolved. The other trigger checks are classes the
// publisher builds itself, so a record that names one is refused too.
function parseRecordClass(value: unknown): ErrorClass | undefined {
  if (!isRecordObject(value)) return undefined;
  if (value.kind === "unknown") return { kind: "unknown" };
  if (value.kind === "trigger") {
    return value.check === "pr-unresolved"
      ? { kind: "trigger", check: "pr-unresolved" }
      : undefined;
  }
  if (value.kind === "github") {
    if (!Number.isInteger(value.status)) return undefined;
    const status = value.status as number;
    if (value.rateLimited === undefined) return { kind: "github", status };
    return value.rateLimited === true
      ? { kind: "github", status, rateLimited: true }
      : undefined;
  }
  return undefined;
}

// Returns undefined for anything the publisher must not act on. A file that
// exists but fails here is an error for the publisher to report, never a
// silent skip: see runPublish in src/ci/publish.ts.
export function parseTriggerRecord(text: string): TriggerRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecordObject(value) || value.v !== 1) return undefined;
  const decision = TRIGGER_DECISIONS.find(
    (candidate) => candidate === value.decision,
  );
  const params = parseRecordParams(value.params);
  if (decision === undefined || params === undefined) return undefined;
  if (
    typeof value.repository !== "string" ||
    !/^[^\s/]+\/[^\s/]+$/.test(value.repository) ||
    typeof value.run_id !== "string" ||
    !/^[0-9]+$/.test(value.run_id) ||
    typeof value.run_url !== "string" ||
    !/^\S+$/.test(value.run_url)
  ) {
    return undefined;
  }
  let runAttempt = 1;
  if (value.run_attempt !== undefined) {
    if (!isPositiveInteger(value.run_attempt)) return undefined;
    runAttempt = value.run_attempt;
  }
  const record: TriggerRecord = {
    v: 1,
    decision,
    params,
    repository: value.repository,
    run_id: value.run_id,
    run_attempt: runAttempt,
    run_url: value.run_url,
  };
  if (value.pr !== undefined) {
    if (!isPositiveInteger(value.pr)) return undefined;
    record.pr = value.pr;
  }
  if (value.head_sha !== undefined) {
    if (
      typeof value.head_sha !== "string" ||
      !SHA_PATTERN.test(value.head_sha)
    ) {
      return undefined;
    }
    record.head_sha = value.head_sha;
  }
  if (value.cls !== undefined) {
    const cls = parseRecordClass(value.cls);
    if (cls === undefined) return undefined;
    record.cls = cls;
  }
  // WHY fail closed here: an override names who unlocked the gate, and the
  // publisher posts both the status and that name from this record. A record
  // without a valid actor or without its PR is refused, and an actor on any
  // other decision is refused, because the writer produces neither.
  if (decision === "override") {
    if (
      typeof value.actor !== "string" ||
      !LOGIN_PATTERN.test(value.actor) ||
      record.pr === undefined
    ) {
      return undefined;
    }
    record.actor = value.actor;
  } else if (value.actor !== undefined) {
    return undefined;
  }
  return record;
}

const CLI_OUTCOMES: readonly CliRecord["outcome"][] = [
  "reviewing",
  "reviewed",
  "hunters-failed",
  "skipped",
  "yielded",
  "error",
];
const CLI_SKIPS: readonly NonNullable<CliRecord["skip"]>[] = [
  "size",
  "budget",
  "coverage",
  "manual-required",
  "excluded",
];
const CLI_HEAD_PATTERN = /^[0-9a-f]{40}$/;

// The CLI's own classes, and only those. A record naming any other class is
// refused, because the writer can produce no other.
function parseCliClass(value: unknown): CliErrorClass | undefined {
  if (!isRecordObject(value)) return undefined;
  if (value.kind === "unknown") return { kind: "unknown" };
  if (value.kind === "capability") {
    if (
      value.issue === "sdk_unavailable" ||
      value.issue === "version_unsupported"
    ) {
      return { kind: "capability", issue: value.issue };
    }
  }
  if (value.kind === "config-parse") {
    if (value.source === "repo-config" || value.source === "extra-hunters") {
      return { kind: "config-parse", source: value.source };
    }
    return undefined;
  }
  if (value.kind === "prompt-set") return { kind: "prompt-set" };
  if (value.kind === "gotchas") {
    if (value.reason === "empty" || value.reason === "placeholder") {
      return { kind: "gotchas", reason: value.reason };
    }
    return undefined;
  }
  if (value.kind === "invariant") return { kind: "invariant" };
  return undefined;
}

// The final status a delivered review could not write. A delivered review's status is
// success or failure, so the state is one of those two. The description is the text the
// publisher posts, so it must say something and fit GitHub's limit.
function parseUnsettledStatus(value: unknown): UnsettledStatus | undefined {
  if (!isRecordObject(value)) return undefined;
  const state = (["success", "failure"] as const).find(
    (candidate) => candidate === value.state,
  );
  if (state === undefined) return undefined;
  const description = value.description;
  if (
    typeof description !== "string" ||
    description.trim() === "" ||
    description.length > STATUS_DESCRIPTION_MAX
  ) {
    return undefined;
  }
  return { state, description };
}

// The per-hunter entries of a hunters-failed record. Each entry carries only the five
// keys, and each value is checked: a cause against the transport vocabulary, a provider
// and a model against their safe-string patterns, a detail as one short plain line, a
// credential against the two secret names. An empty list is refused, since the writer
// never writes one.
function parseHunterFailures(
  value: unknown,
): HunterFailureRecord[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const failures: HunterFailureRecord[] = [];
  for (const entry of value) {
    if (!isRecordObject(entry)) return undefined;
    const failure: HunterFailureRecord = {};
    for (const [key, field] of Object.entries(entry)) {
      if (key === "cause") {
        const cause = knownTransportCause(field);
        if (cause === undefined) return undefined;
        failure.cause = cause;
      } else if (key === "provider") {
        const provider = safeProviderName(field);
        if (provider === undefined) return undefined;
        failure.provider = provider;
      } else if (key === "model") {
        const model = safeModelName(field);
        if (model === undefined) return undefined;
        failure.model = model;
      } else if (key === "detail") {
        const detail = safeFailureDetail(field);
        if (detail === undefined) return undefined;
        failure.detail = detail;
      } else if (key === "credential") {
        const credential = knownFailureCredential(field);
        if (credential === undefined) return undefined;
        failure.credential = credential;
      } else {
        return undefined;
      }
    }
    failures.push(failure);
  }
  return failures;
}

// Returns undefined for anything the publisher must not act on. The rules mirror
// the writer's: `skip` is present exactly for a skipped outcome, `cls` exactly
// for an error, `params` only for an error, carrying only the keys a record
// may name, `unsettled_status` only for a reviewed outcome, and `head_sha` is
// required for a reviewing record, which names the lock's head and nothing else.
// The publisher reads this shape, so a looser reader would accept a record the
// writer never produces.
export function parseCliRecord(text: string): CliRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecordObject(value) || value.v !== 1) return undefined;
  const outcome = CLI_OUTCOMES.find((candidate) => candidate === value.outcome);
  if (outcome === undefined) return undefined;
  const record: CliRecord = { v: 1, outcome };
  if (outcome === "skipped") {
    const skip = CLI_SKIPS.find((candidate) => candidate === value.skip);
    if (skip === undefined) return undefined;
    record.skip = skip;
  } else if (value.skip !== undefined) {
    return undefined;
  }
  if (value.head_sha !== undefined) {
    if (
      typeof value.head_sha !== "string" ||
      !CLI_HEAD_PATTERN.test(value.head_sha)
    ) {
      return undefined;
    }
    record.head_sha = value.head_sha;
  }
  if (outcome === "reviewing" && record.head_sha === undefined) {
    return undefined;
  }
  if (outcome === "error") {
    const cls = parseCliClass(value.cls);
    if (cls === undefined) return undefined;
    record.cls = cls;
  } else if (value.cls !== undefined) {
    return undefined;
  }
  if (value.params !== undefined) {
    if (outcome !== "error") return undefined;
    const params = parseRecordParams(value.params);
    if (params === undefined) return undefined;
    record.params = params;
  }
  if (value.unsettled_status !== undefined) {
    if (outcome !== "reviewed") return undefined;
    const unsettled = parseUnsettledStatus(value.unsettled_status);
    if (unsettled === undefined) return undefined;
    record.unsettled_status = unsettled;
  }
  if (value.hunter_failures !== undefined) {
    if (outcome !== "hunters-failed") return undefined;
    const failures = parseHunterFailures(value.hunter_failures);
    if (failures === undefined) return undefined;
    record.hunter_failures = failures;
  }
  if (value.override_cutoff_ms !== undefined) {
    if (outcome !== "reviewed") return undefined;
    const cutoff = value.override_cutoff_ms;
    if (typeof cutoff !== "number" || !Number.isSafeInteger(cutoff)) {
      return undefined;
    }
    if (cutoff <= 0) return undefined;
    record.override_cutoff_ms = cutoff;
  }
  return record;
}

// A switch over a closed union ends in `unmapped(value, fallback)`. A new
// member fails to compile at that call (the `never` argument), and a value
// outside the union at runtime still gets the honest fallback, never a
// guessed owner.
function unmapped<T>(_value: never, fallback: T): T {
  return fallback;
}

export function codeOf(cls: ErrorClass): ErrorCode {
  switch (cls.kind) {
    case "trigger":
      switch (cls.check) {
        case "no-credential":
          return "CRYSK-CRED-MISSING";
        case "removed-input":
          return "CRYSK-INPUT-REMOVED";
        case "pr-unresolved":
          return "CRYSK-PR-UNRESOLVED";
        default:
          return unmapped(cls.check, "CRYSK-UNCLASSIFIED");
      }
    case "config-parse":
      switch (cls.source) {
        case "models-input":
        case "credentials-input":
        case "repo-config":
        case "person-config":
          return "CRYSK-CONFIG-INVALID";
        case "extra-hunters":
          return "CRYSK-PROMPTSET-INVALID";
        default:
          return unmapped(cls.source, "CRYSK-UNCLASSIFIED");
      }
    case "prompt-set":
      return "CRYSK-PROMPTSET-INVALID";
    // `reason` is captured in a local, so narrowing on `cls.reason` in the inner
    // default does not collapse `cls` itself to never.
    case "gotchas": {
      const reason = cls.reason;
      switch (reason) {
        case "empty":
        case "placeholder":
          return "CRYSK-GOTCHAS-MISSING";
        default:
          return unmapped(reason, "CRYSK-UNCLASSIFIED");
      }
    }
    case "credential":
      switch (cls.failureClass) {
        case "missing_provider_record":
        case "missing_subscription_record":
        case "malformed_payload":
        case "source_read_failed":
        case "env-absent":
          return "CRYSK-CRED-UNUSABLE";
        case "unsupported_kind":
        case "projection_layout_invalid":
          return "CRYSK-ENGINE-DEFECT";
        default:
          return unmapped(cls.failureClass, "CRYSK-UNCLASSIFIED");
      }
    case "capability":
      switch (cls.issue) {
        case "binary_unresolved":
        case "sdk_unavailable":
        case "version_unsupported":
          return "CRYSK-RUNTIME-UNAVAILABLE";
        default:
          return unmapped(cls.issue, "CRYSK-UNCLASSIFIED");
      }
    case "transport":
      return transportCode(cls.cause);
    case "github":
      return githubCode(cls);
    case "install":
      return "CRYSK-INSTALL-FAILED";
    case "invariant":
      return "CRYSK-ENGINE-DEFECT";
    case "unknown":
      return "CRYSK-UNCLASSIFIED";
    default:
      return unmapped(cls, "CRYSK-UNCLASSIFIED");
  }
}

// WHY a 403 splits on `rateLimited`: GitHub answers a refused permission and a
// spent rate limit with the same status, and only the caller reads the body. A
// 403 without the flag is a permission problem. A 429 is always a rate limit.
// A status outside the mapped families is unclassified, never an outage.
function githubCode(cls: GithubClass): ErrorCode {
  if (cls.status === 401) return "CRYSK-GITHUB-TOKEN-INVALID";
  if (cls.status === 403) {
    return cls.rateLimited === true
      ? "CRYSK-GITHUB-UNAVAILABLE"
      : "CRYSK-TOKEN-PERMISSION";
  }
  if (cls.status === 429 || cls.status >= 500)
    return "CRYSK-GITHUB-UNAVAILABLE";
  return "CRYSK-UNCLASSIFIED";
}

function transportCode(
  cause: TransportFailureCause | "legacy_terminal",
): ErrorCode {
  switch (cause) {
    case "auth_invalid":
      return "CRYSK-CRED-REJECTED";
    case "quota_exhausted":
    case "rate_limit":
      return "CRYSK-PROVIDER-LIMITED";
    case "network_transient":
    case "remote_abort_unconfirmed":
      return "CRYSK-PROVIDER-UNAVAILABLE";
    case "safety_refusal":
      return "CRYSK-PROVIDER-REFUSED";
    case "provider_configuration_invalid":
    case "model_unavailable":
      return "CRYSK-MODEL-UNAVAILABLE";
    case "missing_provider_record":
      return "CRYSK-CRED-UNUSABLE";
    case "protocol_truncation":
    case "protocol_mismatch":
    case "protocol_overflow":
    case "output_limit_exceeded":
    case "context_window_exceeded":
      return "CRYSK-ENGINE-DEFECT";
    // WHY runtime_unavailable is unclassified, not an engine defect: one cause
    // covers failures with different owners. OpenCodeSdkTransport raises it
    // from classifyFailure for a provider refusal the provider marked not
    // retryable (the MARKER_PROVIDER_REFUSAL branch in
    // src/transports/opencode-sdk.ts). The same cause also covers pr-hero's own
    // permission control failing (MARKER_PERMISSION_REJECT_FAILED) and a
    // session or prompt that failed (MARKER_SESSION_CREATE, MARKER_PROMPT_REFUSED).
    // ClaudeCodeCliTransport raises it when the child process cannot spawn
    // (src/transports/claude-code-cli.ts). Naming one owner would be the guess
    // this contract exists to prevent.
    case "runtime_unavailable":
    case "legacy_terminal":
      return "CRYSK-UNCLASSIFIED";
    default:
      return unmapped(cause, "CRYSK-UNCLASSIFIED");
  }
}

export function ownerOf(cls: ErrorClass, ctx: OutcomeContext): Owner {
  switch (cls.kind) {
    case "trigger":
      switch (cls.check) {
        case "no-credential":
        case "removed-input":
        case "pr-unresolved":
          return "config";
        default:
          return unmapped(cls.check, "unclassified");
      }
    case "config-parse":
      switch (cls.source) {
        case "models-input":
        case "credentials-input":
        case "repo-config":
        case "person-config":
        case "extra-hunters":
          return "config";
        default:
          return unmapped(cls.source, "unclassified");
      }
    case "prompt-set":
    case "gotchas":
      return "config";
    case "credential":
      switch (cls.failureClass) {
        case "missing_provider_record":
        case "missing_subscription_record":
        case "malformed_payload":
        case "source_read_failed":
        case "env-absent":
          return "config";
        case "unsupported_kind":
        case "projection_layout_invalid":
          return "pr-hero";
        default:
          return unmapped(cls.failureClass, "unclassified");
      }
    case "capability":
      switch (cls.issue) {
        case "binary_unresolved":
        case "sdk_unavailable":
        case "version_unsupported":
          // pr-hero installs these runtimes in the action; locally a tool is
          // missing from the user's own environment.
          return ctx === "action" ? "pr-hero" : "config";
        default:
          return unmapped(cls.issue, "unclassified");
      }
    case "transport":
      return transportOwner(cls.cause);
    case "github":
      return githubOwner(cls);
    case "install":
      return "unclassified";
    case "invariant":
      return "pr-hero";
    case "unknown":
      return "unclassified";
    default:
      return unmapped(cls, "unclassified");
  }
}

function githubOwner(cls: GithubClass): Owner {
  switch (githubCode(cls)) {
    case "CRYSK-TOKEN-PERMISSION":
    case "CRYSK-GITHUB-TOKEN-INVALID":
      return "config";
    case "CRYSK-GITHUB-UNAVAILABLE":
      return "provider";
    default:
      return "unclassified";
  }
}

function transportOwner(
  cause: TransportFailureCause | "legacy_terminal",
): Owner {
  switch (cause) {
    // WHY a rejected credential is the user's to fix: the provider refused the
    // secret the user configured, and only the user can replace it (S2, L12).
    case "auth_invalid":
    case "provider_configuration_invalid":
    // The auth store has no record for the route's provider: the user's secret is the
    // thing to fix, the same owner as the credential class with this failure.
    case "missing_provider_record":
      return "config";
    case "quota_exhausted":
    case "rate_limit":
    case "network_transient":
    case "remote_abort_unconfirmed":
    case "safety_refusal":
    case "model_unavailable":
      return "provider";
    case "protocol_truncation":
    case "protocol_mismatch":
    case "protocol_overflow":
    case "output_limit_exceeded":
    case "context_window_exceeded":
      return "pr-hero";
    // See transportCode: runtime_unavailable has no single owner.
    case "runtime_unavailable":
    case "legacy_terminal":
      return "unclassified";
    default:
      return unmapped(cause, "unclassified");
  }
}

export function ownerLead(owner: Owner, provider?: string): string {
  switch (owner) {
    case "config":
      return "Your configuration:";
    case "provider": {
      const name = provider?.trim();
      return name ? `Provider ${name}:` : "Provider:";
    }
    case "pr-hero":
      return "Crysk defect:";
    case "unclassified":
      return "Unclassified:";
    default:
      return unmapped(owner, "Unclassified:");
  }
}

// The words a missing value renders as. Identifiers use angle placeholders so a
// command that cannot be filled is visibly unfinished; prose uses plain words.
const NEUTRAL: Record<keyof ErrorParams, string> = {
  backend: "<backend>",
  provider: "<provider>",
  step: "this step",
  secret: "<secret-name>",
  scope: "<scope>",
  pr: "<pr>",
  runId: "<run-id>",
  runUrl: "<run-url>",
  detail: "no further detail",
  model: "<model>",
};

// The human phrase a failure's detail renders as. A raw identifier never reaches
// an annotation or summary. Each table is typed over its whole union, so a new
// member fails `tsc` here instead of leaking its name into user-facing text.
const CREDENTIAL_PHRASE: Record<
  CredentialProjectionFailureClass | "env-absent",
  string
> = {
  unsupported_kind:
    "this credential kind is not supported by this Crysk version",
  projection_layout_invalid: "the credential layout Crysk built is invalid",
  source_read_failed: "the credential store could not be read",
  malformed_payload: "the auth store is not a JSON object",
  // Raised for a Claude keychain record and for an OpenAI OAuth record alike.
  missing_subscription_record:
    "the expected subscription login is missing or of the wrong kind",
  missing_provider_record:
    "the OpenCode auth store has no entry for this provider",
  "env-absent": "the secret is not set",
};

const CAPABILITY_PHRASE: Record<CapabilityIssue, string> = {
  binary_unresolved: "a required program is not installed",
  sdk_unavailable: "the OpenCode SDK is not installed",
  version_unsupported: "an unsupported OpenCode version is installed",
};

const TRANSPORT_PHRASE: Record<
  TransportFailureCause | "legacy_terminal",
  string
> = {
  auth_invalid: "the provider rejected the credential",
  quota_exhausted: "the provider's quota is used up",
  rate_limit: "the provider rate-limited the request",
  network_transient: "the network failed before the provider answered",
  remote_abort_unconfirmed: "the remote abort could not be confirmed",
  safety_refusal: "the provider's safety system declined the input",
  provider_configuration_invalid: "the provider configuration is invalid",
  model_unavailable: "the provider does not serve the configured model",
  missing_provider_record:
    "the OpenCode auth store has no entry for this provider",
  protocol_truncation: "the reply was cut short",
  protocol_mismatch: "the reply did not match the expected protocol",
  protocol_overflow: "the reply overflowed the protocol limit",
  output_limit_exceeded: "the output exceeded its limit",
  context_window_exceeded: "the input exceeded the model's context window",
  runtime_unavailable: "the agent runtime was unavailable",
  legacy_terminal: "the run ended in a state Crysk no longer produces",
};

const DOCS_BASE =
  "https://github.com/cryskai/crysk/blob/v0/docs/github-actions.md#";

const ENGINE_DEFECT_ISSUE =
  'gh issue create -R cryskai/crysk --title "CRYSK-ENGINE-DEFECT {detail}" --body "{runUrl}"';
const RERUN_FAILED = "$ gh run rerun {runId} --failed";
const REVIEW_AGAIN = '$ gh pr comment {pr} --body "/crysk review"';
// A workflow set up before the rename filters only `/pr-hero`, and the
// floating action tag still delivers this text to it.
const LEGACY_REVIEW_NOTE =
  "On a workflow set up before the rename, comment `/pr-hero review` instead.";
// The OpenCode secrets (S8): one per provider, <PROVIDER> being the provider id
// uppercased with `-` and `.` as `_` (opencodeSecretToken in crysk-secrets.ts,
// which this module cannot import: see the builtins-only guard).
const OPENCODE_API_KEY_SECRET =
  "$ gh secret set CRYSK_OPENCODE_<PROVIDER>_API_KEY";
const OPENCODE_PROVIDER_TOKEN_NOTE =
  "<PROVIDER> is the provider id uppercased with `-` and `.` as `_` (`deepseek` is DEEPSEEK).";
const OPENAI_OAUTH_SECRET =
  "$ jq -c .openai ~/.local/share/opencode/auth.json | base64 -w0 | gh secret set CRYSK_OPENCODE_OPENAI_OAUTH";
const CRED_STORE_WHY =
  "the credential store does not hold what this route needs";
// missing_subscription_record is raised for a Claude keychain record and for an
// OpenAI OAuth record alike, so each route's fix names the login it really uses.
const CLAUDE_SUBSCRIPTION_FIXES = [
  "Log in again with `claude setup-token`, then set `CRYSK_CLAUDE_OAUTH_TOKEN`:",
  "$ claude setup-token && gh secret set CRYSK_CLAUDE_OAUTH_TOKEN",
];
const OPENCODE_SUBSCRIPTION_FIXES = [
  "Provider `openai` expects a ChatGPT login: run `opencode auth login` and choose ChatGPT, then set its record, base64 on one line (on macOS, drop -w0):",
  "$ opencode auth login",
  OPENAI_OAUTH_SECRET,
  "Or bill per token with an OpenAI API key instead:",
  "$ gh secret set CRYSK_OPENCODE_OPENAI_API_KEY",
];
// Only the OpenCode route stores a ChatGPT login; any other backend, or none, is
// the Claude route.
function isOpencodeRoute(params: ErrorParams): boolean {
  return params.backend?.trim() === "opencode";
}
// A refused `crysk-secrets` input (src/ci/crysk-secrets.ts, U1) records
// malformed_payload with a detail that names a CRYSK_* secret or a line of the
// input, never a value. Its fix is that secret, not the OpenCode auth store.
function isCryskSecretsDetail(params: ErrorParams): boolean {
  const detail = params.detail?.trim() ?? "";
  return (
    detail.startsWith("CRYSK_") ||
    /^line \d+ of the crysk-secrets input /.test(detail)
  );
}
const CRYSK_SECRETS_FIXES = [
  "Re-set the CRYSK_* secret the message names. An _OAUTH secret is the provider's record from your OpenCode auth file, base64 on one line (on macOS, drop -w0):",
  OPENAI_OAUTH_SECRET,
  "Each line of the crysk-secrets input is NAME=value, one CRYSK_* secret per line.",
];
// U5: the platform's stub forwards OpenCode API keys through provider slots,
// `CRYSK_OPENCODE_<TOKEN>_API_KEY`, the token coming from the dispatch. A slot
// that arrived with a key and no token (src/ci/crysk-secrets.ts refuses it) is the
// platform's slot list, not the secret: re-setting the secret would fail again.
// The text is parseCryskSecrets's, matched here for the same reason as below.
const EMPTY_SLOT_DETAIL =
  "CRYSK_OPENCODE__API_KEY has a value but no provider: an unused OpenCode slot must be empty";
function isEmptySlotDetail(detail: string): boolean {
  return detail.trim() === EMPTY_SLOT_DETAIL;
}
const EMPTY_SLOT_FIXES = [
  "The Crysk platform passed an OpenCode key through a provider slot with no provider name, so Crysk cannot tell whose key it is. The platform's provider slots for this run are empty while a key was forwarded:",
  "Open the repository's model settings on the Crysk platform, save the OpenCode provider whose key this is again so its slot names the provider, then re-run the workflow:",
  "$ gh run rerun {runId}",
  "In a workflow you wrote yourself, name the provider in the line: CRYSK_OPENCODE_<PROVIDER>_API_KEY, and leave an unused slot as CRYSK_OPENCODE__API_KEY= with nothing after it.",
];
// U3: an _OAUTH secret for a provider other than openai is refused, since
// only openai's subscription record can be projected. Re-setting it would fail
// again, so the fix is that provider's _API_KEY, which the detail names.
// The text is chooseOpenCodeSecret's (crysk-secrets.ts), matched here rather
// than imported because this module imports no repo module but ../brand (the
// builtins-only guard in test/ci/outcome.test.ts). test/ci/publish.test.ts
// renders that function's own text, so a change on either side fails it.
const UNSUPPORTED_OAUTH_DETAIL_RE =
  /^CRYSK_OPENCODE_[A-Z0-9_]+_OAUTH is an OpenCode subscription record, which Crysk reads only for openai for now; set (CRYSK_OPENCODE_[A-Z0-9_]+_API_KEY) instead$/;
function unsupportedOAuthApiKeyName(detail: string): string | undefined {
  return UNSUPPORTED_OAUTH_DETAIL_RE.exec(detail.trim())?.[1];
}
function cryskSecretsFixes(params: ErrorParams): string[] {
  if (isEmptySlotDetail(params.detail ?? "")) return [...EMPTY_SLOT_FIXES];
  const apiKey = unsupportedOAuthApiKeyName(params.detail ?? "");
  if (apiKey === undefined) return CRYSK_SECRETS_FIXES;
  return [
    "Only openai reads an _OAUTH secret for now. Remove that _OAUTH secret from the crysk-secrets input and set this provider's API key instead:",
    `$ gh secret set ${apiKey}`,
    "Each line of the crysk-secrets input is NAME=value, one CRYSK_* secret per line.",
  ];
}
function cryskSecretsAnnotationFix(params: ErrorParams): string {
  if (isEmptySlotDetail(params.detail ?? "")) {
    return "the Crysk platform forwarded an OpenCode key in a slot with no provider: save that OpenCode provider again in the platform's model settings, then re-run";
  }
  return unsupportedOAuthApiKeyName(params.detail ?? "") === undefined
    ? "re-set the CRYSK_* secret it names (an _OAUTH secret is base64 -w0 of the provider's OpenCode record)"
    : "remove that _OAUTH secret from the crysk-secrets input and set the provider's _API_KEY secret instead (only openai reads an _OAUTH secret for now)";
}
const MODEL_NOT_SERVED: CatalogVariant = {
  why: "the configured models name a model this provider does not offer",
  fixes: [
    "Set a model this provider serves for this step's role in `models` (on the Crysk platform, the model settings).",
    "List the models this provider serves:",
    "$ opencode models {provider}",
  ],
  annotationFix:
    "set a model that {provider} serves for {step}'s role in `models` (the Crysk platform's model settings)",
};

const PROVIDER_REFUSED_WHY = "the provider's safety system declined this input";
const UNCLASSIFIED_FIXES = [
  "Re-run the failed jobs:",
  RERUN_FAILED,
  "If it repeats, read the log and report it:",
  "$ gh run view {runId} --log-failed",
] as const;
const UNCLASSIFIED_FIX =
  "re-run the failed jobs with `gh run rerun {runId} --failed`";
// The GitHub Actions expression is spliced in from two literals so the source
// never holds a `${` pair that reads as a template placeholder here.
const GITHUB_TOKEN_INPUT = "github-token: $" + "{{ secrets.GITHUB_TOKEN }}";
// The fix for a missing credential, by route (S8, U5): the CRYSK_* secrets, passed
// in the crysk-secrets input. A Claude route names only the Claude secrets. An
// OpenCode route leads with the OpenCode secrets, and names the Claude token only
// as the route it does not use (odd/tasks/agent-first-ci.md, A5).
const CLAUDE_CREDENTIAL_FIXES = [
  "Set one credential for the route you use:",
  "$ claude setup-token && gh secret set CRYSK_CLAUDE_OAUTH_TOKEN",
  "$ gh secret set CRYSK_CLAUDE_API_KEY",
  `If the secret is already set, check that the workflow passes it to the action in the \`crysk-secrets\` input, one NAME=value line per secret, for example \`${cryskSecretsLine("CRYSK_CLAUDE_OAUTH_TOKEN")}\`: a secret the workflow does not pass never reaches Crysk.`,
  "Dependabot PRs read Dependabot secrets, so set this one too:",
  "$ gh secret set --app dependabot CRYSK_CLAUDE_OAUTH_TOKEN",
  "Then re-run the workflow:",
  "$ gh run rerun {runId}",
] as const;
const OPENCODE_CREDENTIAL_FIXES = [
  "Set the OpenCode credential of each provider your models use:",
  OPENCODE_API_KEY_SECRET,
  OPENCODE_PROVIDER_TOKEN_NOTE,
  "For an OpenAI subscription, set its record from your OpenCode auth file, base64 on one line (on macOS, drop -w0):",
  OPENAI_OAUTH_SECRET,
  `If the secret is already set, check that the workflow passes it to the action in the \`crysk-secrets\` input, one NAME=value line per secret, for example \`${cryskSecretsLine("CRYSK_OPENCODE_DEEPSEEK_API_KEY")}\`: a secret the workflow does not pass never reaches Crysk.`,
  "Dependabot PRs read Dependabot secrets, so set this one too:",
  "$ gh secret set --app dependabot CRYSK_OPENCODE_<PROVIDER>_API_KEY",
  "A Claude route uses `CRYSK_CLAUDE_OAUTH_TOKEN` instead, from `claude setup-token`.",
  "Then re-run the workflow:",
  "$ gh run rerun {runId}",
] as const;

// The `models` and `credentials` inputs as a workflow writes them (D1), spliced like
// the inputs above. The scaffolded workflow (src/ci/setup.ts) writes these lines, so
// a fix that quotes them cannot disagree with the file the person has.
export const MODELS_INPUT_LINE = "models: $" + "{{ vars.CRYSK_MODELS }}";
export const CREDENTIALS_INPUT_LINE =
  "credentials: $" + "{{ vars.CRYSK_CREDENTIALS }}";
// One line of the crysk-secrets input as a workflow writes it, spliced like the
// inputs above. `{name}` is not a catalog placeholder here: the caller passes a name.
function cryskSecretsLine(name: string): string {
  return `${name}=$` + `{{ secrets.${name} }}`;
}
// The old inputs and the CRYSK_* secret or setting that replaces each (U5, S2, S8).
// The trigger names only the inputs the workflow passed (the record's detail); the
// fix lists every replacement, so it reads the same whichever ones they are.
const REMOVED_INPUT_FIXES = [
  "Set the CRYSK_* secret that replaces each old credential input:",
  "$ claude setup-token && gh secret set CRYSK_CLAUDE_OAUTH_TOKEN",
  "$ gh secret set CRYSK_CLAUDE_API_KEY",
  "$ gh secret set CRYSK_OPENCODE_<PROVIDER>_API_KEY",
  "claude-token becomes CRYSK_CLAUDE_OAUTH_TOKEN and anthropic-api-key becomes CRYSK_CLAUDE_API_KEY. opencode-auth becomes one CRYSK_OPENCODE_<PROVIDER>_API_KEY per provider your models use, <PROVIDER> being the provider id uppercased with `-` and `.` as `_`. An OpenAI subscription is the provider's record from your OpenCode auth file, base64 on one line (on macOS, drop -w0):",
  "$ jq -c .openai ~/.local/share/opencode/auth.json | base64 -w0 | gh secret set CRYSK_OPENCODE_OPENAI_OAUTH",
  `In the workflow, delete the old lines under \`with:\` and pass the secrets in one \`crysk-secrets: |\` block, one NAME=value line per secret, for example \`${cryskSecretsLine("CRYSK_CLAUDE_OAUTH_TOKEN")}\`.`,
  `The routing input becomes the \`models\` input: set your models per role in the CRYSK_MODELS variable, and pass it as \`${MODELS_INPUT_LINE}\` (a repository connected to the Crysk platform takes them from its model settings instead).`,
  '$ gh variable set CRYSK_MODELS --body \'{"default": ["claude:sonnet-latest"]}\'',
  "Then re-run the workflow:",
  "$ gh run rerun {runId}",
] as const;

function single(
  why: string,
  fixes: CatalogVariant["fixes"],
  annotationFix: CatalogVariant["annotationFix"],
): Readonly<Record<string, CatalogVariant>> {
  return { default: { why, fixes, annotationFix } };
}

const PROVIDER_LIMITED: CatalogVariant = {
  why: "the provider has throttled this account or key, so an immediate retry would fail the same way",
  fixes: [
    "Wait, or raise the quota, then ask for a new review:",
    REVIEW_AGAIN,
    LEGACY_REVIEW_NOTE,
  ],
  annotationFix: `wait for the limit to reset or raise the quota, then comment ${commandHint("/crysk review", "")} on the PR`,
};

const CREDENTIAL_UNUSABLE_ENV: CatalogVariant = {
  why: CRED_STORE_WHY,
  fixes: ["Set the secret again:", "$ gh secret set {secret}"],
  annotationFix: "set the {secret} secret with `gh secret set {secret}`",
};

const RUNTIME_LOCAL: CatalogVariant = {
  why: "a required tool is missing from your environment",
  fixes: ["Reconcile the crysk install:", "$ crysk upgrade --reconcile"],
  annotationFix: "reconcile the crysk install with `crysk upgrade --reconcile`",
};

const GITHUB_SERVER: CatalogVariant = {
  why: "the failure happened on GitHub's side, and a retry may succeed",
  fixes: ["Re-run the workflow:", "$ gh run rerun {runId}"],
  annotationFix: "re-run the workflow once GitHub is serving requests again",
};

// WHY no class maps to CRYSK-STATUS-WRITE-FAILED, CRYSK-HUNTERS-FAILED or
// CRYSK-CANCELLED: each is a condition the caller observes directly (a status
// write, the hunter set, a superseded run), so the caller requests the code
// through renderCode. The class-to-code table cannot see those conditions.
export const ERROR_CATALOG: Readonly<Record<ErrorCode, CatalogEntry>> = {
  "CRYSK-CRED-MISSING": {
    level: "error",
    owner: "config",
    what: "No credential for the {backend} route reached the action",
    variants: single(
      "Crysk cannot authenticate, so it cannot review this PR",
      (params) =>
        isOpencodeRoute(params)
          ? OPENCODE_CREDENTIAL_FIXES
          : CLAUDE_CREDENTIAL_FIXES,
      (params) =>
        params.backend?.trim() === "opencode"
          ? "set the provider's CRYSK_OPENCODE_<PROVIDER>_API_KEY secret (`gh secret set CRYSK_OPENCODE_<PROVIDER>_API_KEY`) and pass it in the crysk-secrets input"
          : "set a Claude credential (`claude setup-token && gh secret set CRYSK_CLAUDE_OAUTH_TOKEN`) and pass it in the crysk-secrets input",
    ),
  },
  "CRYSK-INPUT-REMOVED": {
    level: "error",
    owner: "config",
    what: "The workflow passes inputs Crysk no longer reads: {detail}",
    variants: single(
      "Crysk now takes its credentials only from the CRYSK_* secrets in the crysk-secrets input, and its models only from `models`, so a review would run without the credential or models the workflow names",
      REMOVED_INPUT_FIXES,
      "delete the {detail} input lines from the workflow and pass the CRYSK_* secrets in the crysk-secrets input instead (a routing input becomes the models input, from `vars.CRYSK_MODELS`)",
    ),
  },
  "CRYSK-CRED-UNUSABLE": {
    level: "error",
    owner: "config",
    what: "The {backend}/{provider} route for {step} has no usable credential ({detail})",
    variants: {
      // WHY the model is named when the run knows it: the hunter record carries the route's
      // provider and model, and "route opencode/<model> has no usable credential record" is
      // the sentence an operator can act on. The credential path has no model and keeps the
      // generic sentence (whatWithoutModel), so its rendering is unchanged.
      missing_provider_record: {
        what: "The route {provider}/{model} has no usable credential record",
        whatWithoutModel:
          "The {backend}/{provider} route for {step} has no usable credential ({detail})",
        why: CRED_STORE_WHY,
        fixes: [
          "Set {provider}'s secret and pass it in the crysk-secrets input:",
          OPENCODE_API_KEY_SECRET,
          OPENCODE_PROVIDER_TOKEN_NOTE,
        ],
        annotationFix:
          "set {provider}'s CRYSK_OPENCODE_<PROVIDER>_API_KEY secret and pass it in the crysk-secrets input",
      },
      missing_subscription_record: {
        why: CRED_STORE_WHY,
        fixes: (params) =>
          isOpencodeRoute(params)
            ? OPENCODE_SUBSCRIPTION_FIXES
            : CLAUDE_SUBSCRIPTION_FIXES,
        annotationFix: (params) =>
          isOpencodeRoute(params)
            ? "run `opencode auth login` and choose ChatGPT for provider `openai`, then set CRYSK_OPENCODE_OPENAI_OAUTH from its record, or set CRYSK_OPENCODE_OPENAI_API_KEY to bill per token"
            : "log in again with `claude setup-token` and set `CRYSK_CLAUDE_OAUTH_TOKEN` (`gh secret set CRYSK_CLAUDE_OAUTH_TOKEN`)",
      },
      malformed_payload: {
        // WHY no route in the sentence: this class is raised for the OpenCode auth
        // store and for a Claude keychain payload alike, and {detail} names which.
        what: "The credential store is not usable: {detail}",
        why: CRED_STORE_WHY,
        fixes: (params) =>
          isCryskSecretsDetail(params)
            ? cryskSecretsFixes(params)
            : [
                "Check that the store is a JSON object:",
                "$ jq -e 'type==\"object\"' ~/.local/share/opencode/auth.json",
                "In CI the action builds this file from the CRYSK_OPENCODE_* secrets: re-set the one for this provider.",
                OPENCODE_API_KEY_SECRET,
              ],
        annotationFix: (params) =>
          isCryskSecretsDetail(params)
            ? cryskSecretsAnnotationFix(params)
            : "make the OpenCode auth store a JSON object (in CI, re-set the provider's CRYSK_OPENCODE_* secret)",
      },
      source_read_failed: CREDENTIAL_UNUSABLE_ENV,
      "env-absent": CREDENTIAL_UNUSABLE_ENV,
      default: CREDENTIAL_UNUSABLE_ENV,
    },
  },
  "CRYSK-CRED-REJECTED": {
    level: "error",
    owner: "config",
    what: "provider {provider} rejected the credential in {secret}",
    variants: {
      // The rejected secret is a per-token credential. Since S5 the run used it because it
      // was the first present credential in `credentials.claude`, so the way to the
      // subscription is that order (with the OAuth secret set), never deleting the key.
      // The alternative names the secret both ways: the old name the workflow passes
      // today, and its CRYSK_* name (S8).
      api_key: {
        why: "the key is invalid, expired or revoked, and it is the Claude credential this run chose from credentials.claude",
        fixes: [
          "Create a new key in the Claude Console and set it:",
          "$ gh secret set {secret}",
          "Or run on the subscription: set CRYSK_CLAUDE_OAUTH_TOKEN and put subscription first in `credentials.claude` (the default order).",
          "Then ask for a new review:",
          REVIEW_AGAIN,
          LEGACY_REVIEW_NOTE,
        ],
        annotationFix:
          "create a new key and run `gh secret set {secret}`, or set CRYSK_CLAUDE_OAUTH_TOKEN and put subscription first in `credentials.claude` (the default order)",
      },
      oauth: {
        why: "it is expired, revoked, or a short-lived /login session token",
        fixes: [
          "$ claude setup-token && gh secret set {secret}",
          "Then ask for a new review:",
          REVIEW_AGAIN,
          LEGACY_REVIEW_NOTE,
        ],
        annotationFix:
          "log in again with `claude setup-token` and set `{secret}` (`gh secret set {secret}`)",
      },
      default: {
        why: "it is expired, revoked, or a short-lived /login session token",
        fixes: [
          "$ claude setup-token && gh secret set CRYSK_CLAUDE_OAUTH_TOKEN",
          "Or, for an API key, create a new key in the Claude Console and set it:",
          "$ gh secret set CRYSK_CLAUDE_API_KEY",
          "Or, for OpenCode, set the provider's key again:",
          OPENCODE_API_KEY_SECRET,
          "Then ask for a new review:",
          REVIEW_AGAIN,
          LEGACY_REVIEW_NOTE,
        ],
        annotationFix:
          "replace the credential in {secret} with a new one, then run `gh secret set {secret}`",
      },
    },
  },
  // WHY provider-owned: the provider refused the model, so the lead reads
  // "Provider <name>:". provider_configuration_invalid shares this code and keeps
  // its own owner (config) through its variant, so its rendering is unchanged.
  "CRYSK-MODEL-UNAVAILABLE": {
    level: "error",
    owner: "provider",
    what: "Provider {provider} does not serve the model configured for {step}",
    variants: {
      default: MODEL_NOT_SERVED,
      // Every failed hunter was refused for one model (the CLI record names it): the lead
      // already names the provider, so the sentence names the model, and only when known.
      // A transport model_unavailable keeps the default wording (renderError picks by cause).
      every_hunter: {
        ...MODEL_NOT_SERVED,
        what: "the configured model {model} is not served by this provider",
        whatWithoutModel: "the configured model is not served by this provider",
      },
      provider_configuration_invalid: { ...MODEL_NOT_SERVED, owner: "config" },
    },
  },
  "CRYSK-PROMPTSET-INVALID": {
    level: "error",
    owner: "config",
    what: "The prompt set is invalid: {detail}",
    variants: single(
      "an agent file or PRHERO_EXTRA_HUNTERS entry cannot be loaded",
      [
        "Fix the file or `agents_dir`, then check for free:",
        "$ crysk review --pr {pr} --dry-run",
      ],
      "fix the agent file or `agents_dir` ({detail}), then check it with `crysk review --pr {pr} --dry-run`",
    ),
  },
  "CRYSK-GOTCHAS-MISSING": {
    level: "error",
    owner: "config",
    what: "the review instructions file (REVIEW.md or .crysk/gotchas.md) is empty or still the scaffold",
    variants: single(
      "a file that exists must hold real repository rules; with no file at all the review runs on the default guidance",
      [
        "Write real rules and facts about this repository into the file (REVIEW.md at the repository root, or .crysk/gotchas.md), delete the scaffold marker line if it is there, and commit it to the base branch (comment-triggered runs read the base branch). Or delete the file to review with the default guidance only.",
      ],
      "write real rules into REVIEW.md or .crysk/gotchas.md (remove the scaffold marker line if present) and commit it to the base branch, or delete the file",
    ),
  },
  "CRYSK-CONFIG-INVALID": {
    level: "error",
    owner: "config",
    what: ".crysk/config.json is invalid: {detail}",
    variants: {
      ...single(
        "Crysk refuses to guess repository settings",
        ["Fix the file, then check it:", "$ crysk review --pr {pr} --dry-run"],
        "fix `.crysk/config.json` ({detail}), then check it with `crysk review --pr {pr} --dry-run`",
      ),
      // The setup step's reading of the `models` input, which the workflow fills from
      // vars.CRYSK_MODELS (D1). The detail names the input, never its content.
      "models-input": {
        what: "The models input is invalid: {detail}",
        why: "Crysk refuses to guess which model each role should use",
        fixes: [
          "Fix the models per role, a JSON object from role to model list, and set the variable again:",
          '$ gh variable set CRYSK_MODELS --body "$(jq -c . models.json)"',
          `The workflow passes it as \`${MODELS_INPUT_LINE}\`.`,
          "Then re-run the workflow:",
          "$ gh run rerun {runId}",
        ],
        annotationFix:
          "fix the models JSON ({detail}) and set it again with `gh variable set CRYSK_MODELS`, the variable the workflow passes as `vars.CRYSK_MODELS`",
      },
      // The `credentials` input, beside it, from vars.CRYSK_CREDENTIALS (D1).
      "credentials-input": {
        what: "The credentials input is invalid: {detail}",
        why: "Crysk refuses to guess which Claude credential to use",
        fixes: [
          'Fix the Claude credential order, a JSON object such as {"claude": ["subscription", "api_key"]}, and set the variable again:',
          '$ gh variable set CRYSK_CREDENTIALS --body "$(jq -c . credentials.json)"',
          `The workflow passes it as \`${CREDENTIALS_INPUT_LINE}\`.`,
          "Then re-run the workflow:",
          "$ gh run rerun {runId}",
        ],
        annotationFix:
          "fix the credentials JSON ({detail}) and set it again with `gh variable set CRYSK_CREDENTIALS`, the variable the workflow passes as `vars.CRYSK_CREDENTIALS`",
      },
    },
  },
  "CRYSK-TOKEN-PERMISSION": {
    level: "error",
    owner: "config",
    what: "The workflow token lacks `{scope}: write`",
    variants: {
      ...single(
        "Crysk cannot post its result on the PR",
        [
          "Add `{scope}: write` to the job's `permissions:`, or re-scaffold the workflow:",
          "$ crysk ci init --force",
        ],
        "add `{scope}: write` under the job's `permissions:` in the workflow",
      ),
      // WHY a separate variant: a 403 whose scope is not known names no scope.
      // renderCode picks it for every caller when the scope is blank.
      "no-scope": {
        what: "GitHub refused the workflow token (HTTP 403) during {step}",
        why: "Crysk cannot post its result on the PR",
        fixes: [
          `Check that the workflow passes \`${GITHUB_TOKEN_INPUT}\` on the action step, and keeps the \`permissions:\` block that \`crysk ci init\` scaffolds:`,
          "$ crysk ci init --force",
        ],
        annotationFix: `check that the workflow passes \`${GITHUB_TOKEN_INPUT}\` and keeps the \`permissions:\` block that \`crysk ci init\` scaffolds`,
      },
    },
  },
  "CRYSK-GITHUB-TOKEN-INVALID": {
    level: "error",
    owner: "config",
    what: "The github-token input is invalid",
    variants: single(
      "every GitHub API call is rejected",
      [`Set \`${GITHUB_TOKEN_INPUT}\` on the action step.`],
      `set \`${GITHUB_TOKEN_INPUT}\` on the action step`,
    ),
  },
  "CRYSK-GITHUB-UNAVAILABLE": {
    level: "error",
    owner: "provider",
    providerName: "GitHub",
    what: "the GitHub API failed (HTTP {detail})",
    variants: {
      rate_limit: {
        what: "the GitHub API rate limit was reached",
        why: "GitHub has throttled this token, so an immediate retry would fail the same way",
        fixes: [
          "Wait for the limit to reset, then re-run the workflow:",
          "$ gh run rerun {runId}",
        ],
        annotationFix:
          "wait for the GitHub rate limit to reset, then re-run the workflow",
      },
      server: GITHUB_SERVER,
      default: GITHUB_SERVER,
    },
  },
  "CRYSK-PR-UNRESOLVED": {
    level: "error",
    owner: "config",
    what: "Crysk could not determine the pull request number or head",
    variants: {
      ...single(
        "nothing can be posted on a PR it cannot identify",
        [
          "Run from a pull_request or issue_comment event, or pass the `pr-number` input.",
        ],
        "run from a pull_request or issue_comment event, or pass the `pr-number` input",
      ),
      // The pr-number input was given but is not a positive integer. The record's
      // detail names the input, so the fix tells the reader to correct it.
      "malformed-input": {
        what: "Crysk could not determine the pull request number or head ({detail})",
        why: "nothing can be posted on a PR it cannot identify",
        fixes: ["Pass a positive integer as the `pr-number` input."],
        annotationFix: "pass a positive integer as the `pr-number` input",
      },
    },
  },
  "CRYSK-STATUS-WRITE-FAILED": {
    level: "error",
    owner: "unclassified",
    providerName: "GitHub",
    what: "Crysk could not write its commit status ({detail})",
    variants: {
      default: {
        why: "the required check has no result for this head without it",
        fixes: [
          "Re-run the failed jobs:",
          RERUN_FAILED,
          "If it repeats, report it.",
        ],
        annotationFix: UNCLASSIFIED_FIX,
      },
      permission: {
        owner: "config",
        why: "the required check has no result for this head without it",
        fixes: [
          "Add `statuses: write` to the job's `permissions:`, or re-scaffold the workflow:",
          "$ crysk ci init --force",
        ],
        annotationFix:
          "add `statuses: write` under the job's `permissions:` in the workflow",
      },
      server: {
        owner: "provider",
        why: "the required check has no result for this head without it",
        fixes: ["Re-run the workflow:", "$ gh run rerun {runId}"],
        annotationFix:
          "re-run the workflow once GitHub accepts commit statuses again",
      },
    },
  },
  "CRYSK-RUNTIME-UNAVAILABLE": {
    level: "error",
    owner: { action: "pr-hero", local: "config" },
    what: "a runtime Crysk depends on is unusable: {detail}",
    variants: {
      action: {
        why: "the action installs this runtime itself, so this is a Crysk defect",
        fixes: [
          "Report it with this run:",
          '$ gh issue create -R cryskai/crysk --title "CRYSK-RUNTIME-UNAVAILABLE" --body "{runUrl}"',
        ],
        annotationFix: "report it at cryskai/crysk with this run's URL",
      },
      local: RUNTIME_LOCAL,
      default: RUNTIME_LOCAL,
    },
  },
  "CRYSK-INSTALL-FAILED": {
    level: "error",
    owner: "unclassified",
    what: "The {step} step failed",
    whatWithoutStep: "An install step failed",
    variants: single(
      "a download or install step failed, and Crysk cannot tell which external cause it was",
      [
        "Re-run only the failed jobs:",
        RERUN_FAILED,
        "If it repeats, report it.",
      ],
      "re-run only the failed jobs with `gh run rerun {runId} --failed`",
    ),
  },
  "CRYSK-PROVIDER-LIMITED": {
    level: "error",
    owner: "provider",
    what: "rate limit or quota reached",
    variants: {
      default: PROVIDER_LIMITED,
      // Every failed hunter hit the same limit and the provider said which one (an empty
      // credit balance, say): the sentence quotes it, and the fix is the default's. The
      // quote comes FIRST in this and the next two variants: the commit status clips the
      // code plus the sentence at 140 characters, and the provider's words (with a reset
      // time) must survive that. The explanation after them is for the comment.
      every_hunter: {
        ...PROVIDER_LIMITED,
        what: "{detail} (rate limit or quota reached)",
      },
      // The credit balance or spend limit of the account behind ANTHROPIC_API_KEY (the
      // credential this run chose from credentials.claude, S5). Waiting does not help:
      // the fix is to top up, or to move the run to the subscription through that order.
      api_key: {
        what: "{detail}: the Anthropic account behind the API key has no credit left or reached its spend limit",
        why: "the provider refuses every request until the account has credit again, so a retry would fail the same way",
        fixes: [
          "Add credit to the Anthropic account behind the API key (Claude Console → Plans & Billing), or run on the subscription: set CRYSK_CLAUDE_OAUTH_TOKEN and put subscription first in `credentials.claude` (the default order).",
          "Then ask for a new review:",
          REVIEW_AGAIN,
          LEGACY_REVIEW_NOTE,
        ],
        annotationFix:
          "add credit to the Anthropic account behind the API key (Claude Console → Plans & Billing), or set CRYSK_CLAUDE_OAUTH_TOKEN and put subscription first in `credentials.claude` (the default order)",
      },
      // The Claude subscription behind CLAUDE_CODE_OAUTH_TOKEN reached a usage window. The
      // provider's own sentence carries the reset time, so the what quotes it.
      subscription: {
        what: "{detail}: the Claude subscription reached its usage limit",
        why: "the subscription refuses requests until its usage window resets, so an immediate retry would fail the same way",
        fixes: [
          "Re-run after the limit resets (the reset time is in the sentence above):",
          REVIEW_AGAIN,
          LEGACY_REVIEW_NOTE,
          "Or bill per token: set CRYSK_CLAUDE_API_KEY and put api_key first in `credentials.claude` (the default order uses the subscription while it is set):",
          "$ gh secret set CRYSK_CLAUDE_API_KEY",
        ],
        annotationFix:
          "re-run after the limit resets, or set CRYSK_CLAUDE_API_KEY and put api_key first in `credentials.claude` to bill per token",
      },
    },
  },
  "CRYSK-PROVIDER-UNAVAILABLE": {
    level: "error",
    owner: "provider",
    what: "unreachable",
    variants: single(
      "the request did not complete, and the provider's outcome cannot be confirmed from here",
      ["Re-run the workflow:", "$ gh run rerun {runId}"],
      "re-run the workflow with `gh run rerun {runId}`",
    ),
  },
  "CRYSK-PROVIDER-REFUSED": {
    level: "error",
    owner: "provider",
    what: "the request was refused",
    variants: single(
      PROVIDER_REFUSED_WHY,
      [
        "Ask for a new review once:",
        REVIEW_AGAIN,
        LEGACY_REVIEW_NOTE,
        "If it repeats, report it.",
      ],
      "ask for a new review once, and report it if the provider refuses again",
    ),
  },
  "CRYSK-ENGINE-DEFECT": {
    level: "error",
    owner: "pr-hero",
    what: "Crysk hit an internal error ({detail}) in {step}",
    variants: single(
      "this is a defect in Crysk, not in your configuration",
      ["Report it, with this run:", `$ ${ENGINE_DEFECT_ISSUE}`],
      "report it at cryskai/crysk with this run's URL",
    ),
  },
  "CRYSK-HUNTERS-FAILED": {
    level: "error",
    owner: "unclassified",
    // WHY a lead of its own: the caller requests this code for a condition it
    // sees directly (the hunter set), so "Unclassified:" would blame an unknown
    // cause that does not exist. The owner stays unclassified for the table.
    lead: "Not reviewed:",
    what: "Every hunter failed in {step}: {detail}",
    variants: {
      default: {
        why: "no hunter returned a result, so there is no finding to report",
        fixes: [
          "Re-run the failed jobs:",
          RERUN_FAILED,
          "If it repeats, report it.",
        ],
        annotationFix:
          "re-run the failed jobs with `gh run rerun {runId} --failed`",
      },
      // Every hunter was refused for the size of the request: a re-run sends the same one.
      context_window_exceeded: {
        why: "the review input is too large for the model, so every hunter was refused and a re-run would send the same request",
        fixes: [
          "Lower `max-changed-lines` in the workflow's `with:` block (or `max_changed_lines` in the repo config), or exclude paths in `.cryskignore` (`.prheroignore` in a repo set up before the rename), then ask for a new review:",
          REVIEW_AGAIN,
          LEGACY_REVIEW_NOTE,
        ],
        annotationFix:
          "lower `max-changed-lines` (or `max_changed_lines` in the repo config) or exclude paths in `.cryskignore` (`.prheroignore` before the rename)",
      },
    },
  },
  "CRYSK-UNCLASSIFIED": {
    level: "error",
    owner: "unclassified",
    what: "Crysk stopped at {step} and could not tell why",
    variants: {
      default: {
        why: "rather than guess, it reports this honestly",
        fixes: UNCLASSIFIED_FIXES,
        annotationFix: UNCLASSIFIED_FIX,
      },
      github: {
        what: "GitHub returned {detail} at {step}, and Crysk cannot tell whose fix it is",
        why: "Crysk does not map this GitHub status to an owner, so it does not guess",
        fixes: UNCLASSIFIED_FIXES,
        annotationFix: UNCLASSIFIED_FIX,
      },
    },
  },
  "CRYSK-CANCELLED": {
    level: "notice",
    owner: "unclassified",
    lead: "Not reviewed:",
    headline: "CRYSK-CANCELLED: not reviewed",
    what: "The review was cancelled or superseded by a newer push",
    variants: single(
      "a newer run replaces this one, so this result would describe an outdated head",
      [
        "Ask for a review of the current head:",
        REVIEW_AGAIN,
        LEGACY_REVIEW_NOTE,
      ],
      'ask for a review of the current head with `gh pr comment {pr} --body "/crysk review"` (or "/pr-hero review" on a workflow set up before the rename)',
    ),
  },
};

export function renderError(
  cls: ErrorClass,
  params: ErrorParams,
  ctx: OutcomeContext,
): RenderedError {
  const detail = isBlank(params.detail) ? classDetail(cls) : params.detail;
  // An install class carries the step it failed on; an explicit non-blank step wins.
  const step =
    cls.kind === "install" && isBlank(params.step) ? cls.step : params.step;
  const merged: ErrorParams = { ...params, detail, step };
  return renderCode(codeOf(cls), merged, ctx, variantOf(cls));
}

// The rendering of a run whose every failed hunter shares one transport cause, or undefined
// when the cause is not on the allowlist below. WHY an allowlist, not "every cause with a
// code": a shared cause's sentence and fixes name params that this path does not always
// have (the secret, the backend, the step) and would ship a placeholder to the PR. A cause
// is rendered only when its message is complete with the params the path has: provider,
// model, pr, runId, runUrl, step and detail. Every other cause, or a missing param, keeps the
// caller's generic CRYSK-HUNTERS-FAILED.
export function renderHunterCause(
  cause: TransportFailureCause,
  params: ErrorParams,
  ctx: OutcomeContext,
  // What every failed hunter reported identically, when they agree: the provider's words
  // and the secret they ran on. Only the causes whose sentence has room for them use them.
  shared: {
    readonly detail?: string;
    readonly credential?: FailureCredential;
  } = {},
): RenderedError | undefined {
  // A rejected credential is rendered from its own code only when the secret and the
  // provider are known, so the sentence names both and never a placeholder.
  if (cause === "auth_invalid") {
    if (shared.credential === undefined || isBlank(params.provider)) {
      return undefined;
    }
    return renderCode(
      "CRYSK-CRED-REJECTED",
      { ...params, secret: secretNameOf(shared.credential, ctx) },
      ctx,
    );
  }
  // An empty balance or a spent quota. The provider's words say which limit it was, and the
  // credential says whose: a credit balance on an API key is fixed by topping up, a
  // subscription window by waiting for its reset. Without the words the default wording
  // stands.
  if (cause === "quota_exhausted") {
    if (shared.detail === undefined) {
      return renderCode("CRYSK-PROVIDER-LIMITED", params, ctx);
    }
    const quoted = { ...params, detail: shared.detail };
    const variant =
      shared.credential === "ANTHROPIC_API_KEY"
        ? "api_key"
        : shared.credential === "CLAUDE_CODE_OAUTH_TOKEN"
          ? "subscription"
          : "every_hunter";
    return renderCode("CRYSK-PROVIDER-LIMITED", quoted, ctx, variant);
  }
  // The provider's 404 names the model, so the every_hunter wording keeps it. Its fixes name
  // the provider, so the provider must be known; the model is optional (whatWithoutModel).
  if (cause === "model_unavailable") {
    if (isBlank(params.provider)) return undefined;
    return renderCode("CRYSK-MODEL-UNAVAILABLE", params, ctx, "every_hunter");
  }
  // The credential sentence and its fixes name both the route's provider and model.
  if (cause === "missing_provider_record") {
    if (isBlank(params.provider) || isBlank(params.model)) return undefined;
    return renderError({ kind: "transport", cause }, params, ctx);
  }
  return undefined;
}

// The secret a rejected credential came from, as the reader sets it. A hunter
// records the Claude CLI's own variable (FailureCredential); in the action that
// variable was filled from the CRYSK_* secret the workflow passes in the
// crysk-secrets input (S8, U5), so `gh secret set` must name that secret. A local
// run exports the CLI's variable itself, so it keeps that name.
const CRYSK_SECRET_OF_CREDENTIAL: Readonly<
  Partial<Record<FailureCredential, string>>
> = {
  ANTHROPIC_API_KEY: "CRYSK_CLAUDE_API_KEY",
  CLAUDE_CODE_OAUTH_TOKEN: "CRYSK_CLAUDE_OAUTH_TOKEN",
};
function secretNameOf(
  credential: FailureCredential,
  ctx: OutcomeContext,
): string {
  if (ctx !== "action") return credential;
  return CRYSK_SECRET_OF_CREDENTIAL[credential] ?? credential;
}

// For a code the caller requests directly. `variant` picks the sub-class, which
// fixes the owner, the wording and the fix; renderError supplies it for classes.
export function renderCode(
  code: ErrorCode,
  params: ErrorParams,
  ctx: OutcomeContext,
  variant?: string,
): RenderedError {
  const entry = ERROR_CATALOG[code];
  const picked = pickVariant(entry, ctx, paramVariant(code, params, variant));
  const owner = ownerFor(picked.owner ?? entry.owner, ctx);
  const providerName = entry.providerName ?? cleanName(params.provider);
  const lead = entry.lead ?? ownerLead(owner, providerName);
  const link = `${DOCS_BASE}${code.toLowerCase()}`;
  const what =
    picked.what === undefined
      ? whatOf(entry, params)
      : isBlank(params.model) && picked.whatWithoutModel !== undefined
        ? picked.whatWithoutModel
        : picked.what;
  const sentence = capitalized(fill(what, params, "annotation"));
  const message =
    `${lead} ${sentence}. ` +
    `Why: ${fill(picked.why, params, "annotation")}. ` +
    `Fix: ${annotationFixOf(picked, params)}. ` +
    `Docs: ${link}`;
  return {
    code,
    owner,
    what: sentence,
    annotation: `::${entry.level} title=crysk ${code}::${escapeCommandData(message)}`,
    summary: summaryLines(code, entry, lead, what, picked, params, link),
  };
}

// The entry's sentence, or its step-free form when no step is given.
function whatOf(entry: CatalogEntry, params: ErrorParams): string {
  return entry.whatWithoutStep !== undefined && isBlank(params.step)
    ? entry.whatWithoutStep
    : entry.what;
}

// Upper-cases the first character only. The owner lead ends in a colon, so the
// sentence after it must start with a capital; backticked code and the rest of
// the text are left as they are.
function capitalized(text: string): string {
  // WHY: the product name is always lowercase `pr-hero`; upper-casing it reads as "Pr-hero".
  if (text.startsWith("crysk")) return text;
  const first = text.slice(0, 1);
  return first.toUpperCase() + text.slice(first.length);
}

// WHY the catalog picks the variant from the params, not the caller: a permission
// 403 with no scope names no scope, so every caller (a class or a direct
// renderCode) gets the same text and no placeholder reaches the PR. The same
// holds for an unresolved PR: a detail means the pr-number input was given and
// is malformed, so the fix must name that input, not ask for one that was passed.
function paramVariant(
  code: ErrorCode,
  params: ErrorParams,
  variant: string | undefined,
): string | undefined {
  if (code === "CRYSK-TOKEN-PERMISSION" && isBlank(params.scope)) {
    return "no-scope";
  }
  // The credential in the secret picks the fix: a rejected API key and a rejected OAuth
  // token are replaced differently.
  if (code === "CRYSK-CRED-REJECTED" && variant === undefined) {
    if (
      params.secret === "ANTHROPIC_API_KEY" ||
      params.secret === "ANTHROPIC_AUTH_TOKEN" ||
      params.secret === "CRYSK_CLAUDE_API_KEY"
    ) {
      return "api_key";
    }
    if (
      params.secret === "CLAUDE_CODE_OAUTH_TOKEN" ||
      params.secret === "CRYSK_CLAUDE_OAUTH_TOKEN"
    ) {
      return "oauth";
    }
  }
  // A caller that names a variant keeps it, so the default wording stays
  // reachable with a detail present.
  if (
    variant === undefined &&
    code === "CRYSK-PR-UNRESOLVED" &&
    !isBlank(params.detail)
  ) {
    return "malformed-input";
  }
  return variant;
}

function pickVariant(
  entry: CatalogEntry,
  ctx: OutcomeContext,
  variant: string | undefined,
): CatalogVariant {
  const table: Partial<Record<string, CatalogVariant>> = entry.variants;
  return (
    table[ctx] ??
    (variant === undefined ? undefined : table[variant]) ??
    entry.variants.default
  );
}

function ownerFor(rule: OwnerRule, ctx: OutcomeContext): Owner {
  return typeof rule === "string" ? rule : rule[ctx];
}

function variantOf(cls: ErrorClass): string | undefined {
  switch (cls.kind) {
    case "credential":
      return cls.failureClass;
    // Only the models and credentials inputs have a variant of their own
    // (CRYSK-CONFIG-INVALID); the other sources find none and render their code's default.
    case "config-parse":
      return cls.source;
    case "github":
      return githubVariant(cls);
    // The transport cause picks its own sub-class where the code shares one:
    // CRYSK-MODEL-UNAVAILABLE serves provider_configuration_invalid (config) and
    // model_unavailable (provider). Other codes have no such variant and fall
    // back to their default.
    case "transport":
      return cls.cause;
    default:
      return undefined;
  }
}

// The GitHub sub-class names the family whose wording and fix apply. A status
// with no family of its own returns undefined and renders the code's default.
function githubVariant(cls: GithubClass): string | undefined {
  if (cls.status === 429 || (cls.status === 403 && cls.rateLimited === true)) {
    return "rate_limit";
  }
  if (cls.status >= 500) return "server";
  return githubCode(cls) === "CRYSK-UNCLASSIFIED" ? "github" : undefined;
}

function classDetail(cls: ErrorClass): string | undefined {
  switch (cls.kind) {
    case "capability":
      return CAPABILITY_PHRASE[cls.issue];
    case "credential":
      return CREDENTIAL_PHRASE[cls.failureClass];
    case "transport":
      return TRANSPORT_PHRASE[cls.cause];
    case "github":
      return String(cls.status);
    default:
      return undefined;
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function cleanName(value: string | undefined): string | undefined {
  return isBlank(value) ? undefined : value?.trim();
}

function paramText(params: ErrorParams, key: keyof ErrorParams): string {
  const raw = params[key];
  const text = raw === undefined || raw === null ? "" : String(raw);
  return text.trim() === "" ? NEUTRAL[key] : text;
}

// "annotation" keeps raw values (escaped later); "summary" flattens line breaks
// so a value cannot break its block; "command" also keeps only shell-safe
// characters in `detail`, because a failure's free text must not reach a command
// the reader may paste.
type FillMode = "annotation" | "summary" | "command";

// Fills {name} placeholders.
function fill(template: string, params: ErrorParams, mode: FillMode): string {
  return template.replace(/\{(\w+)\}/g, (placeholder: string, name: string) => {
    const key = name as keyof ErrorParams;
    if (!(key in NEUTRAL)) return placeholder;
    const text = paramText(params, key);
    if (mode === "annotation") return text;
    const safe =
      mode === "command" && key === "detail" ? shellSafe(text) : text;
    return safe.replace(/\r\n|\r|\n/g, " ");
  });
}

// WHY an allowlist: detail is free text from a failure, and a command the reader
// pastes must not carry a quote, a substitution or a separator.
function shellSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9 _.:-]/g, "");
}

function annotationFixOf(picked: CatalogVariant, params: ErrorParams): string {
  const raw =
    typeof picked.annotationFix === "function"
      ? picked.annotationFix(params)
      : picked.annotationFix;
  return fill(raw, params, "annotation").replace(/[:.]+$/, "");
}

// The variant's fix lines; a function fix picks its list from the params.
function fixesOf(
  picked: CatalogVariant,
  params: ErrorParams,
): readonly string[] {
  return typeof picked.fixes === "function"
    ? picked.fixes(params)
    : picked.fixes;
}

function summaryLines(
  code: ErrorCode,
  entry: CatalogEntry,
  lead: string,
  what: string,
  picked: CatalogVariant,
  params: ErrorParams,
  link: string,
): string[] {
  const prose = (text: string): string => fill(text, params, "summary");
  const command = (text: string): string => fill(text, params, "command");
  return [
    `### ${entry.headline ?? code}`,
    "",
    `${lead} ${capitalized(prose(what))}`,
    "",
    `Why: ${prose(picked.why)}`,
    "",
    "Fix:",
    "",
    ...fixBlocks(fixesOf(picked, params), prose, command),
    `Docs: ${link}`,
  ];
}

// Consecutive "$ " lines share one bash fence; prose lines stand alone.
function fixBlocks(
  fixes: readonly string[],
  prose: (text: string) => string,
  command: (text: string) => string,
): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of fixes) {
    const isCommand = line.startsWith("$ ");
    if (isCommand && !inBlock) {
      out.push("```bash");
      inBlock = true;
    }
    if (!isCommand && inBlock) {
      out.push("```", "");
      inBlock = false;
    }
    out.push(isCommand ? command(line.slice(2)) : prose(line));
    if (!isCommand) out.push("");
  }
  if (inBlock) out.push("```", "");
  return out;
}

// Workflow-command message escaping, copied from src/ci/trigger.ts
// (escapeCommandData). The drift test in test/ci/outcome.test.ts compares the
// two source texts; keep them identical.
function escapeCommandData(text: string): string {
  return text
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

// The first line of every outcome comment the publisher posts (src/ci/publish.ts writes it).
// Exported so the status reader and the publisher share one spelling; the trailing space
// keeps a lookalike marker from matching.
export const OUTCOME_MARKER_PREFIX = `${MARKER_OPEN}outcome `;

// The CRYSK-* code an outcome comment names, or null. renderError's summary opens with
// `### <headline>`, and a headline is the bare code or the code then a colon and a sentence
// (`CRYSK-CANCELLED: not reviewed`), so the code is the token at the start of that heading. The
// token must be a catalogued code: a heading that merely looks like one reads as no code.
// WHY PRH-* too: the codes were PRH-* before the rename, and comments already posted keep
// them. An old code reads as the CRYSK-* code it became; a code removed since reads as none.
export function parseOutcomeCode(body: string): ErrorCode | null {
  if (matchMarkerPrefix(body, OUTCOME_MARKER_PREFIX) === undefined) return null;
  const heading = /^### (?:CRYSK|PRH)-([A-Z0-9-]+)(?=[:\s]|$)/m.exec(body);
  if (heading === null) return null;
  const code = `CRYSK-${heading[1]}`;
  return (ERROR_CODES as readonly string[]).includes(code)
    ? (code as ErrorCode)
    : null;
}
