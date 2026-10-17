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

import type { TransportFailureCause } from "../execution/contracts";
import type { CredentialProjectionFailureClass } from "../security/credential-broker";

export type Owner = "config" | "provider" | "pr-hero" | "unclassified";
export type OutcomeContext = "action" | "local";
// An owner is fixed, or depends on the context (PRH-RUNTIME-UNAVAILABLE).
type OwnerRule = Owner | Readonly<Record<OutcomeContext, Owner>>;

type CapabilityIssue =
  | "binary_unresolved"
  | "sdk_unavailable"
  | "version_unsupported";
type RouteReason =
  | "unmapped"
  | "ambiguous"
  | "spend-disabled"
  | "multiple-opencode-providers";

export type ErrorClass =
  | {
      kind: "trigger";
      check: "no-credential" | "routing-missing" | "pr-unresolved";
    }
  | {
      kind: "config-parse";
      source: "routing" | "repo-config" | "person-config" | "extra-hunters";
    }
  | { kind: "prompt-set" }
  | { kind: "gotchas"; reason: "empty" | "placeholder" }
  | { kind: "route"; reason: RouteReason }
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
  "PRH-CRED-MISSING",
  "PRH-CRED-UNUSABLE",
  "PRH-CRED-REJECTED",
  "PRH-ROUTING-MISSING",
  "PRH-ROUTING-INVALID",
  "PRH-ROUTE-UNRESOLVABLE",
  "PRH-MODEL-UNAVAILABLE",
  "PRH-PROMPTSET-INVALID",
  "PRH-GOTCHAS-MISSING",
  "PRH-CONFIG-INVALID",
  "PRH-TOKEN-PERMISSION",
  "PRH-GITHUB-TOKEN-INVALID",
  "PRH-GITHUB-UNAVAILABLE",
  "PRH-PR-UNRESOLVED",
  "PRH-STATUS-WRITE-FAILED",
  "PRH-RUNTIME-UNAVAILABLE",
  "PRH-INSTALL-FAILED",
  "PRH-PROVIDER-LIMITED",
  "PRH-PROVIDER-UNAVAILABLE",
  "PRH-PROVIDER-REFUSED",
  "PRH-ENGINE-DEFECT",
  "PRH-HUNTERS-FAILED",
  "PRH-UNCLASSIFIED",
  "PRH-CANCELLED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface CatalogVariant {
  // Replaces the entry's `what` for this sub-class.
  readonly what?: string;
  // Replaces `what` when no model is given, so the sentence never names a placeholder
  // (PRH-MODEL-UNAVAILABLE's every_hunter variant). Filled like `what`.
  readonly whatWithoutModel?: string;
  // Replaces the entry's owner for this sub-class.
  readonly owner?: OwnerRule;
  readonly why: string;
  // A list of fix lines, or a function of the params when the steps depend on
  // them (the backend: missing_subscription_record, and PRH-CRED-MISSING's
  // routing variable).
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
  // (PRH-RUNTIME-UNAVAILABLE); other keys are the failure's sub-class
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
  // The model a provider does not serve, when the record names it (PRH-MODEL-UNAVAILABLE).
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
// routing or OpenCode auth input is malformed (odd/tasks/agent-first-ci.md, A1).
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

// The only classes the CLI writes (src/ci/classify-error.ts). A wider reader
// would hide a writer's bug, the same rule as parseRecordClass below. The config
// classes are the ones a throw site names (T2d-1). The person layer is not one of
// them: its catalog text names the repo file, so the record would send the reader
// to the wrong file.
export type CliErrorClass =
  | { kind: "unknown" }
  | { kind: "route"; reason: "unmapped" | "ambiguous" | "spend-disabled" }
  | { kind: "capability"; issue: "sdk_unavailable" | "version_unsupported" }
  | {
      kind: "config-parse";
      source: "routing" | "repo-config" | "extra-hunters";
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
  skip?: "size" | "budget" | "coverage" | "manual-required";
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

const TRIGGER_DECISIONS: readonly TriggerRecord["decision"][] = [
  "review",
  "ignore",
  "denied",
  "unverifiable",
  "no-credentials",
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
  if (value.kind === "config-parse" && value.source === "routing") {
    return { kind: "config-parse", source: "routing" };
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
];
const CLI_HEAD_PATTERN = /^[0-9a-f]{40}$/;

// The CLI's own classes, and only those. A record naming any other class is
// refused, because the writer can produce no other.
function parseCliClass(value: unknown): CliErrorClass | undefined {
  if (!isRecordObject(value)) return undefined;
  if (value.kind === "unknown") return { kind: "unknown" };
  if (value.kind === "route") {
    if (
      value.reason === "unmapped" ||
      value.reason === "ambiguous" ||
      value.reason === "spend-disabled"
    ) {
      return { kind: "route", reason: value.reason };
    }
    return undefined;
  }
  if (value.kind === "capability") {
    if (
      value.issue === "sdk_unavailable" ||
      value.issue === "version_unsupported"
    ) {
      return { kind: "capability", issue: value.issue };
    }
  }
  if (value.kind === "config-parse") {
    if (
      value.source === "routing" ||
      value.source === "repo-config" ||
      value.source === "extra-hunters"
    ) {
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

// The per-hunter entries of a hunters-failed record. Each entry carries only the three
// keys, and each value is checked: a cause against the transport vocabulary, a provider
// and a model against their safe-string patterns. An empty list is refused, since the
// writer never writes one.
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
          return "PRH-CRED-MISSING";
        case "routing-missing":
          return "PRH-ROUTING-MISSING";
        case "pr-unresolved":
          return "PRH-PR-UNRESOLVED";
        default:
          return unmapped(cls.check, "PRH-UNCLASSIFIED");
      }
    case "config-parse":
      switch (cls.source) {
        case "routing":
          return "PRH-ROUTING-INVALID";
        case "repo-config":
        case "person-config":
          return "PRH-CONFIG-INVALID";
        case "extra-hunters":
          return "PRH-PROMPTSET-INVALID";
        default:
          return unmapped(cls.source, "PRH-UNCLASSIFIED");
      }
    case "prompt-set":
      return "PRH-PROMPTSET-INVALID";
    // `reason` is captured in a local: it is a discriminant shared by the
    // gotchas and route members, so narrowing on `cls.reason` in the inner
    // default would collapse `cls` itself to never.
    case "gotchas": {
      const reason = cls.reason;
      switch (reason) {
        case "empty":
        case "placeholder":
          return "PRH-GOTCHAS-MISSING";
        default:
          return unmapped(reason, "PRH-UNCLASSIFIED");
      }
    }
    case "route": {
      const reason = cls.reason;
      switch (reason) {
        case "unmapped":
        case "ambiguous":
        case "spend-disabled":
        case "multiple-opencode-providers":
          return "PRH-ROUTE-UNRESOLVABLE";
        default:
          return unmapped(reason, "PRH-UNCLASSIFIED");
      }
    }
    case "credential":
      switch (cls.failureClass) {
        case "missing_provider_record":
        case "missing_subscription_record":
        case "malformed_payload":
        case "source_read_failed":
        case "env-absent":
          return "PRH-CRED-UNUSABLE";
        case "unsupported_kind":
        case "projection_layout_invalid":
          return "PRH-ENGINE-DEFECT";
        default:
          return unmapped(cls.failureClass, "PRH-UNCLASSIFIED");
      }
    case "capability":
      switch (cls.issue) {
        case "binary_unresolved":
        case "sdk_unavailable":
        case "version_unsupported":
          return "PRH-RUNTIME-UNAVAILABLE";
        default:
          return unmapped(cls.issue, "PRH-UNCLASSIFIED");
      }
    case "transport":
      return transportCode(cls.cause);
    case "github":
      return githubCode(cls);
    case "install":
      return "PRH-INSTALL-FAILED";
    case "invariant":
      return "PRH-ENGINE-DEFECT";
    case "unknown":
      return "PRH-UNCLASSIFIED";
    default:
      return unmapped(cls, "PRH-UNCLASSIFIED");
  }
}

// WHY a 403 splits on `rateLimited`: GitHub answers a refused permission and a
// spent rate limit with the same status, and only the caller reads the body. A
// 403 without the flag is a permission problem. A 429 is always a rate limit.
// A status outside the mapped families is unclassified, never an outage.
function githubCode(cls: GithubClass): ErrorCode {
  if (cls.status === 401) return "PRH-GITHUB-TOKEN-INVALID";
  if (cls.status === 403) {
    return cls.rateLimited === true
      ? "PRH-GITHUB-UNAVAILABLE"
      : "PRH-TOKEN-PERMISSION";
  }
  if (cls.status === 429 || cls.status >= 500) return "PRH-GITHUB-UNAVAILABLE";
  return "PRH-UNCLASSIFIED";
}

function transportCode(
  cause: TransportFailureCause | "legacy_terminal",
): ErrorCode {
  switch (cause) {
    case "auth_invalid":
      return "PRH-CRED-REJECTED";
    case "quota_exhausted":
    case "rate_limit":
      return "PRH-PROVIDER-LIMITED";
    case "network_transient":
    case "remote_abort_unconfirmed":
      return "PRH-PROVIDER-UNAVAILABLE";
    case "safety_refusal":
      return "PRH-PROVIDER-REFUSED";
    case "provider_configuration_invalid":
    case "model_unavailable":
      return "PRH-MODEL-UNAVAILABLE";
    case "missing_provider_record":
      return "PRH-CRED-UNUSABLE";
    case "protocol_truncation":
    case "protocol_mismatch":
    case "protocol_overflow":
    case "output_limit_exceeded":
    case "context_window_exceeded":
      return "PRH-ENGINE-DEFECT";
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
      return "PRH-UNCLASSIFIED";
    default:
      return unmapped(cause, "PRH-UNCLASSIFIED");
  }
}

export function ownerOf(cls: ErrorClass, ctx: OutcomeContext): Owner {
  switch (cls.kind) {
    case "trigger":
      switch (cls.check) {
        case "no-credential":
        case "routing-missing":
        case "pr-unresolved":
          return "config";
        default:
          return unmapped(cls.check, "unclassified");
      }
    case "config-parse":
      switch (cls.source) {
        case "routing":
        case "repo-config":
        case "person-config":
        case "extra-hunters":
          return "config";
        default:
          return unmapped(cls.source, "unclassified");
      }
    case "prompt-set":
    case "gotchas":
    case "route":
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
    case "PRH-TOKEN-PERMISSION":
    case "PRH-GITHUB-TOKEN-INVALID":
      return "config";
    case "PRH-GITHUB-UNAVAILABLE":
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
      return "pr-hero defect:";
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
    "this credential kind is not supported by this pr-hero version",
  projection_layout_invalid: "the credential layout pr-hero built is invalid",
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

const ROUTE_PHRASE: Record<RouteReason, string> = {
  unmapped: "no mapping covers this route",
  ambiguous: "more than one mapping matches this route",
  "spend-disabled": "spend is turned off for this route",
  "multiple-opencode-providers":
    "more than one OpenCode provider is configured",
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
  legacy_terminal: "the run ended in a state pr-hero no longer produces",
};

const DOCS_BASE =
  "https://github.com/juanmaagd/pr-hero/blob/v0/docs/github-actions.md#";

const ENGINE_DEFECT_ISSUE =
  'gh issue create -R juanmaagd/pr-hero --title "PRH-ENGINE-DEFECT {detail}" --body "{runUrl}"';
const RERUN_FAILED = "$ gh run rerun {runId} --failed";
const REVIEW_AGAIN = '$ gh pr comment {pr} --body "/pr-hero review"';
const OPENCODE_STORE =
  "$ gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json";
const CRED_STORE_WHY =
  "the credential store does not hold what this route needs";
// missing_subscription_record is raised for a Claude keychain record and for an
// OpenAI OAuth record alike, so each route's fix names the login it really uses.
const CLAUDE_SUBSCRIPTION_FIXES = [
  "Log in again with `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN`:",
  "$ claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN",
];
const OPENCODE_SUBSCRIPTION_FIXES = [
  "Provider `openai` expects a ChatGPT login: run `opencode auth login` and choose ChatGPT, then re-set the secret:",
  "$ opencode auth login",
  OPENCODE_STORE,
  "Or rename the provider in PRHERO_ROUTING.",
];
// Only the OpenCode route stores a ChatGPT login; any other backend, or none, is
// the Claude route.
function isOpencodeRoute(params: ErrorParams): boolean {
  return params.backend?.trim() === "opencode";
}
const MODEL_NOT_SERVED: CatalogVariant = {
  why: "the routing names a model this provider does not offer",
  fixes: [
    "Fix the `modelSnapshot` for this step in PRHERO_ROUTING.",
    "List the models this provider serves:",
    "$ opencode models {provider}",
  ],
  annotationFix:
    "fix the `modelSnapshot` for {step} in PRHERO_ROUTING to a model that {provider} serves",
};

const ROUTE_WHY = "every agent needs exactly one backend, provider and model";
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
// The `with:` line that hands the Claude secret to the action, spliced the same way.
const CLAUDE_TOKEN_INPUT =
  "claude-token: $" + "{{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}";
// The `with:` line that hands the OpenCode auth store to the action, spliced the same way.
const OPENCODE_AUTH_INPUT =
  "opencode-auth: $" + "{{ secrets.OPENCODE_AUTH_JSON }}";
// The `with:` line for the Claude API key, the alternative to the OAuth token.
const ANTHROPIC_API_KEY_INPUT =
  "anthropic-api-key: $" + "{{ secrets.ANTHROPIC_API_KEY }}";
// The fix for a missing credential, by route. A Claude route names only the Claude
// secrets. An OpenCode route leads with the OpenCode secret, and names the Claude
// token only as the route it does not use (odd/tasks/agent-first-ci.md, A5).
const CLAUDE_CREDENTIAL_FIXES = [
  "Set one credential for the route you use:",
  "$ claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN",
  "$ gh secret set ANTHROPIC_API_KEY",
  "$ opencode auth login && gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json",
  `If the secret is already set, check that the workflow passes it to the action under \`with:\`, for example \`${CLAUDE_TOKEN_INPUT}\` or \`${ANTHROPIC_API_KEY_INPUT}\`: a secret the workflow does not pass never reaches pr-hero.`,
  "Dependabot PRs read Dependabot secrets, so set this one too:",
  "$ gh secret set --app dependabot CLAUDE_CODE_OAUTH_TOKEN",
  "Then re-run the workflow:",
  "$ gh run rerun {runId}",
] as const;
const OPENCODE_CREDENTIAL_FIXES = [
  "Set the OpenCode credential for the route you use:",
  "$ opencode auth login && gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json",
  `If the secret is already set, check that the workflow passes it to the action under \`with:\`, for example \`${OPENCODE_AUTH_INPUT}\`: a secret the workflow does not pass never reaches pr-hero.`,
  "An OpenCode route also needs the routing variable:",
  "$ gh variable set PRHERO_ROUTING --body '<routing-object-json>'",
  "Dependabot PRs read Dependabot secrets, so set this one too:",
  "$ gh secret set --app dependabot OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json",
  "A Claude route uses `CLAUDE_CODE_OAUTH_TOKEN` instead, from `claude setup-token`.",
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

const CREDENTIAL_UNUSABLE_ENV: CatalogVariant = {
  why: CRED_STORE_WHY,
  fixes: ["Set the secret again:", "$ gh secret set {secret}"],
  annotationFix: "set the {secret} secret with `gh secret set {secret}`",
};

// Two UnmappedRouteError throw sites (src/model/routing.ts) share this variant: a
// model with no mapping at all, and a mapping that names no modelSnapshot. "Add or
// complete" covers both; "add a modelSnapshot" alone was false for the first.
const ROUTE_UNMAPPED: CatalogVariant = {
  why: ROUTE_WHY,
  fixes: [
    "Add or complete this model's route in PRHERO_ROUTING, with an explicit `modelSnapshot`.",
  ],
  annotationFix:
    "add or complete this model's route in PRHERO_ROUTING, with an explicit `modelSnapshot`",
};

const RUNTIME_LOCAL: CatalogVariant = {
  why: "a required tool is missing from your environment",
  fixes: ["Reconcile the pr-hero install:", "$ pr-hero upgrade --reconcile"],
  annotationFix:
    "reconcile the pr-hero install with `pr-hero upgrade --reconcile`",
};

const GITHUB_SERVER: CatalogVariant = {
  why: "the failure happened on GitHub's side, and a retry may succeed",
  fixes: ["Re-run the workflow:", "$ gh run rerun {runId}"],
  annotationFix: "re-run the workflow once GitHub is serving requests again",
};

// WHY no class maps to PRH-STATUS-WRITE-FAILED, PRH-HUNTERS-FAILED or
// PRH-CANCELLED: each is a condition the caller observes directly (a status
// write, the hunter set, a superseded run), so the caller requests the code
// through renderCode. The class-to-code table cannot see those conditions.
export const ERROR_CATALOG: Readonly<Record<ErrorCode, CatalogEntry>> = {
  "PRH-CRED-MISSING": {
    level: "error",
    owner: "config",
    what: "No credential for the {backend} route reached the action",
    variants: single(
      "pr-hero cannot authenticate, so it cannot review this PR",
      (params) =>
        isOpencodeRoute(params)
          ? OPENCODE_CREDENTIAL_FIXES
          : CLAUDE_CREDENTIAL_FIXES,
      (params) =>
        params.backend?.trim() === "opencode"
          ? "set the OPENCODE_AUTH_JSON secret: `gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json`"
          : "set a Claude credential: `claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN`",
    ),
  },
  "PRH-CRED-UNUSABLE": {
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
          "Add {provider} to the OpenCode store, then re-set the secret:",
          "$ opencode auth login",
          OPENCODE_STORE,
        ],
        annotationFix:
          "add {provider} to the OpenCode store with `opencode auth login`, then set OPENCODE_AUTH_JSON again",
      },
      missing_subscription_record: {
        why: CRED_STORE_WHY,
        fixes: (params) =>
          isOpencodeRoute(params)
            ? OPENCODE_SUBSCRIPTION_FIXES
            : CLAUDE_SUBSCRIPTION_FIXES,
        annotationFix: (params) =>
          isOpencodeRoute(params)
            ? "run `opencode auth login` and choose ChatGPT for provider `openai`, then re-set OPENCODE_AUTH_JSON, or rename the provider in PRHERO_ROUTING"
            : "log in again with `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` (`gh secret set CLAUDE_CODE_OAUTH_TOKEN`)",
      },
      malformed_payload: {
        // WHY no route in the sentence: this class is raised for the OpenCode auth
        // store and for a Claude keychain payload alike, and {detail} names which.
        what: "The credential store is not usable: {detail}",
        why: CRED_STORE_WHY,
        fixes: [
          "Check that the store is a JSON object:",
          "$ jq -e 'type==\"object\"' ~/.local/share/opencode/auth.json",
          "Then re-set the secret:",
          OPENCODE_STORE,
        ],
        annotationFix:
          "make the OpenCode auth store a JSON object, then set OPENCODE_AUTH_JSON again",
      },
      source_read_failed: CREDENTIAL_UNUSABLE_ENV,
      "env-absent": CREDENTIAL_UNUSABLE_ENV,
      default: CREDENTIAL_UNUSABLE_ENV,
    },
  },
  "PRH-CRED-REJECTED": {
    level: "error",
    owner: "config",
    what: "provider {provider} rejected the credential in {secret}",
    variants: single(
      "it is expired, revoked, or a short-lived /login session token",
      [
        "$ claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN",
        "Or, for OpenCode, re-export the auth store and re-set the secret:",
        OPENCODE_STORE,
        "Then ask for a new review:",
        REVIEW_AGAIN,
      ],
      "replace the credential in {secret} with a new one, then run `gh secret set {secret}`",
    ),
  },
  "PRH-ROUTING-MISSING": {
    level: "error",
    owner: "config",
    what: "OpenCode auth is set but PRHERO_ROUTING is empty, so the default Claude route is used",
    variants: single(
      "the run would fail later at the Claude credential check",
      [
        '$ gh variable set PRHERO_ROUTING --body "$(jq -c .routing ~/.prhero/config.json)"',
      ],
      `set PRHERO_ROUTING from your routing config: \`gh variable set PRHERO_ROUTING --body "$(jq -c .routing ~/.prhero/config.json)"\``,
    ),
  },
  "PRH-ROUTING-INVALID": {
    level: "error",
    owner: "config",
    what: "PRHERO_ROUTING is invalid: {detail}",
    variants: single(
      "pr-hero cannot tell which backend and model each agent should use",
      [
        "Edit the JSON, then set it again:",
        '$ gh variable set PRHERO_ROUTING --body "$(jq -c . routing.json)"',
      ],
      "fix the JSON in PRHERO_ROUTING ({detail}), then set it again with `gh variable set PRHERO_ROUTING`",
    ),
  },
  "PRH-ROUTE-UNRESOLVABLE": {
    level: "error",
    owner: "config",
    what: "Model routing for {step} has no usable route: {detail}",
    variants: {
      unmapped: ROUTE_UNMAPPED,
      ambiguous: {
        why: ROUTE_WHY,
        fixes: [
          "Remove the duplicate mapping for this route from PRHERO_ROUTING.",
        ],
        annotationFix:
          "remove the duplicate mapping for this route from PRHERO_ROUTING",
      },
      "spend-disabled": {
        why: ROUTE_WHY,
        fixes: ["Enable spend for this route in PRHERO_ROUTING."],
        annotationFix: "enable spend for this route in PRHERO_ROUTING",
      },
      "multiple-opencode-providers": {
        why: ROUTE_WHY,
        fixes: ["Keep one OpenCode provider per review in PRHERO_ROUTING."],
        annotationFix:
          "keep one OpenCode provider per review in PRHERO_ROUTING",
      },
      default: ROUTE_UNMAPPED,
    },
  },
  // WHY provider-owned: the provider refused the model, so the lead reads
  // "Provider <name>:". provider_configuration_invalid shares this code and keeps
  // its own owner (config) through its variant, so its rendering is unchanged.
  "PRH-MODEL-UNAVAILABLE": {
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
  "PRH-PROMPTSET-INVALID": {
    level: "error",
    owner: "config",
    what: "The prompt set is invalid: {detail}",
    variants: single(
      "an agent file or PRHERO_EXTRA_HUNTERS entry cannot be loaded",
      [
        "Fix the file or `agents_dir`, then check for free:",
        "$ pr-hero review --pr {pr} --dry-run",
      ],
      "fix the agent file or `agents_dir` ({detail}), then check it with `pr-hero review --pr {pr} --dry-run`",
    ),
  },
  "PRH-GOTCHAS-MISSING": {
    level: "error",
    owner: "config",
    what: ".prhero/gotchas.md is missing or still the scaffold",
    variants: single(
      "reviews need real repository facts to be accurate",
      [
        "Write real facts about this repository, delete the scaffold marker line, and commit the file to the base branch (comment-triggered runs read the base branch).",
      ],
      "write real facts into .prhero/gotchas.md, remove the scaffold marker line, and commit it to the base branch",
    ),
  },
  "PRH-CONFIG-INVALID": {
    level: "error",
    owner: "config",
    what: ".prhero/config.json is invalid: {detail}",
    variants: single(
      "pr-hero refuses to guess repository settings",
      ["Fix the file, then check it:", "$ pr-hero review --pr {pr} --dry-run"],
      "fix `.prhero/config.json` ({detail}), then check it with `pr-hero review --pr {pr} --dry-run`",
    ),
  },
  "PRH-TOKEN-PERMISSION": {
    level: "error",
    owner: "config",
    what: "The workflow token lacks `{scope}: write`",
    variants: {
      ...single(
        "pr-hero cannot post its result on the PR",
        [
          "Add `{scope}: write` to the job's `permissions:`, or re-scaffold the workflow:",
          "$ pr-hero ci init --force",
        ],
        "add `{scope}: write` under the job's `permissions:` in the workflow",
      ),
      // WHY a separate variant: a 403 whose scope is not known names no scope.
      // renderCode picks it for every caller when the scope is blank.
      "no-scope": {
        what: "GitHub refused the workflow token (HTTP 403) during {step}",
        why: "pr-hero cannot post its result on the PR",
        fixes: [
          `Check that the workflow passes \`${GITHUB_TOKEN_INPUT}\` on the action step, and keeps the \`permissions:\` block that \`pr-hero ci init\` scaffolds:`,
          "$ pr-hero ci init --force",
        ],
        annotationFix: `check that the workflow passes \`${GITHUB_TOKEN_INPUT}\` and keeps the \`permissions:\` block that \`pr-hero ci init\` scaffolds`,
      },
    },
  },
  "PRH-GITHUB-TOKEN-INVALID": {
    level: "error",
    owner: "config",
    what: "The github-token input is invalid",
    variants: single(
      "every GitHub API call is rejected",
      [`Set \`${GITHUB_TOKEN_INPUT}\` on the action step.`],
      `set \`${GITHUB_TOKEN_INPUT}\` on the action step`,
    ),
  },
  "PRH-GITHUB-UNAVAILABLE": {
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
  "PRH-PR-UNRESOLVED": {
    level: "error",
    owner: "config",
    what: "pr-hero could not determine the pull request number or head",
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
        what: "pr-hero could not determine the pull request number or head ({detail})",
        why: "nothing can be posted on a PR it cannot identify",
        fixes: ["Pass a positive integer as the `pr-number` input."],
        annotationFix: "pass a positive integer as the `pr-number` input",
      },
    },
  },
  "PRH-STATUS-WRITE-FAILED": {
    level: "error",
    owner: "unclassified",
    providerName: "GitHub",
    what: "pr-hero could not write its commit status ({detail})",
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
          "$ pr-hero ci init --force",
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
  "PRH-RUNTIME-UNAVAILABLE": {
    level: "error",
    owner: { action: "pr-hero", local: "config" },
    what: "a runtime pr-hero depends on is unusable: {detail}",
    variants: {
      action: {
        why: "the action installs this runtime itself, so this is a pr-hero defect",
        fixes: [
          "Report it with this run:",
          '$ gh issue create -R juanmaagd/pr-hero --title "PRH-RUNTIME-UNAVAILABLE" --body "{runUrl}"',
        ],
        annotationFix: "report it at juanmaagd/pr-hero with this run's URL",
      },
      local: RUNTIME_LOCAL,
      default: RUNTIME_LOCAL,
    },
  },
  "PRH-INSTALL-FAILED": {
    level: "error",
    owner: "unclassified",
    what: "The {step} step failed",
    whatWithoutStep: "An install step failed",
    variants: single(
      "a download or install step failed, and pr-hero cannot tell which external cause it was",
      [
        "Re-run only the failed jobs:",
        RERUN_FAILED,
        "If it repeats, report it.",
      ],
      "re-run only the failed jobs with `gh run rerun {runId} --failed`",
    ),
  },
  "PRH-PROVIDER-LIMITED": {
    level: "error",
    owner: "provider",
    what: "rate limit or quota reached",
    variants: single(
      "the provider has throttled this account or key, so an immediate retry would fail the same way",
      ["Wait, or raise the quota, then ask for a new review:", REVIEW_AGAIN],
      "wait for the limit to reset or raise the quota, then comment /pr-hero review on the PR",
    ),
  },
  "PRH-PROVIDER-UNAVAILABLE": {
    level: "error",
    owner: "provider",
    what: "unreachable",
    variants: single(
      "the request did not complete, and the provider's outcome cannot be confirmed from here",
      ["Re-run the workflow:", "$ gh run rerun {runId}"],
      "re-run the workflow with `gh run rerun {runId}`",
    ),
  },
  "PRH-PROVIDER-REFUSED": {
    level: "error",
    owner: "provider",
    what: "the request was refused",
    variants: single(
      PROVIDER_REFUSED_WHY,
      ["Ask for a new review once:", REVIEW_AGAIN, "If it repeats, report it."],
      "ask for a new review once, and report it if the provider refuses again",
    ),
  },
  "PRH-ENGINE-DEFECT": {
    level: "error",
    owner: "pr-hero",
    what: "pr-hero hit an internal error ({detail}) in {step}",
    variants: single(
      "this is a defect in pr-hero, not in your configuration",
      ["Report it, with this run:", `$ ${ENGINE_DEFECT_ISSUE}`],
      "report it at juanmaagd/pr-hero with this run's URL",
    ),
  },
  "PRH-HUNTERS-FAILED": {
    level: "error",
    owner: "unclassified",
    what: "Every review hunter failed in {step}: {detail}",
    variants: single(
      "no hunter returned a result, so there is no finding to report",
      ["Re-run the failed jobs:", RERUN_FAILED, "If it repeats, report it."],
      "re-run the failed jobs with `gh run rerun {runId} --failed`",
    ),
  },
  "PRH-UNCLASSIFIED": {
    level: "error",
    owner: "unclassified",
    what: "pr-hero stopped at {step} and could not tell why",
    variants: {
      default: {
        why: "rather than guess, it reports this honestly",
        fixes: UNCLASSIFIED_FIXES,
        annotationFix: UNCLASSIFIED_FIX,
      },
      github: {
        what: "GitHub returned {detail} at {step}, and pr-hero cannot tell whose fix it is",
        why: "pr-hero does not map this GitHub status to an owner, so it does not guess",
        fixes: UNCLASSIFIED_FIXES,
        annotationFix: UNCLASSIFIED_FIX,
      },
    },
  },
  "PRH-CANCELLED": {
    level: "notice",
    owner: "unclassified",
    lead: "Not reviewed:",
    headline: "PRH-CANCELLED: not reviewed",
    what: "The review was cancelled or superseded by a newer push",
    variants: single(
      "a newer run replaces this one, so this result would describe an outdated head",
      ["Ask for a review of the current head:", REVIEW_AGAIN],
      'ask for a review of the current head with `gh pr comment {pr} --body "/pr-hero review"`',
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
// caller's generic PRH-HUNTERS-FAILED.
export function renderHunterCause(
  cause: TransportFailureCause,
  params: ErrorParams,
  ctx: OutcomeContext,
): RenderedError | undefined {
  // The provider's 404 names the model, so the every_hunter wording keeps it. Its fixes name
  // the provider, so the provider must be known; the model is optional (whatWithoutModel).
  if (cause === "model_unavailable") {
    if (isBlank(params.provider)) return undefined;
    return renderCode("PRH-MODEL-UNAVAILABLE", params, ctx, "every_hunter");
  }
  // The credential sentence and its fixes name both the route's provider and model.
  if (cause === "missing_provider_record") {
    if (isBlank(params.provider) || isBlank(params.model)) return undefined;
    return renderError({ kind: "transport", cause }, params, ctx);
  }
  return undefined;
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
    annotation: `::${entry.level} title=pr-hero ${code}::${escapeCommandData(message)}`,
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
  if (text.startsWith("pr-hero")) return text;
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
  if (code === "PRH-TOKEN-PERMISSION" && isBlank(params.scope)) {
    return "no-scope";
  }
  // A caller that names a variant keeps it, so the default wording stays
  // reachable with a detail present.
  if (
    variant === undefined &&
    code === "PRH-PR-UNRESOLVED" &&
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
    case "route":
      return cls.reason;
    case "github":
      return githubVariant(cls);
    // The transport cause picks its own sub-class where the code shares one:
    // PRH-MODEL-UNAVAILABLE serves provider_configuration_invalid (config) and
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
  return githubCode(cls) === "PRH-UNCLASSIFIED" ? "github" : undefined;
}

function classDetail(cls: ErrorClass): string | undefined {
  switch (cls.kind) {
    case "capability":
      return CAPABILITY_PHRASE[cls.issue];
    case "credential":
      return CREDENTIAL_PHRASE[cls.failureClass];
    case "transport":
      return TRANSPORT_PHRASE[cls.cause];
    case "route":
      return ROUTE_PHRASE[cls.reason];
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
export const OUTCOME_MARKER_PREFIX = "<!-- pr-hero-outcome ";

// The PRH-* code an outcome comment names, or null. renderError's summary opens with
// `### <headline>`, and a headline is the bare code or the code then a colon and a sentence
// (`PRH-CANCELLED: not reviewed`), so the code is the token at the start of that heading. The
// token must be a catalogued code: a heading that merely looks like one reads as no code.
export function parseOutcomeCode(body: string): ErrorCode | null {
  if (!body.startsWith(OUTCOME_MARKER_PREFIX)) return null;
  const heading = /^### (PRH-[A-Z0-9-]+)(?=[:\s]|$)/m.exec(body);
  const code = heading?.[1];
  if (code === undefined) return null;
  return (ERROR_CODES as readonly string[]).includes(code)
    ? (code as ErrorCode)
    : null;
}
