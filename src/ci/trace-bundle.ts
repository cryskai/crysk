// Builds the review trace a platform run uploads (crysk.trace.v1): one
// OpenTelemetry trace of the whole run in OTLP/JSON, plus the raw per-attempt
// transcripts it was built from. Pure: the trace step (src/ci/platform-trace.ts)
// reads the run directory and hands the files in; nothing here touches disk or
// the network.
//
// SHAPE (OpenTelemetry GenAI semantic conventions, GENAI_SEMCONV_VERSION):
// - a root span `invoke_workflow crysk.review` for the run;
// - a child `invoke_agent <step>` per pipeline step;
// - under it a `chat <model>` per attempt, carrying the model, provider, token
//   usage (inclusive of cache and reasoning, as the conventions count it) and
//   cost, so a backend sees each model call once;
// - under that an `execute_tool <tool>` per tool call the model made.
// Engine facts ride as `crysk.*` attributes with snake_case keys. Every leaf of
// each pipeline.json step lands on its step span (crysk.step.*), every leaf of
// the run's records on the root (crysk.pipeline.*, crysk.findings.*,
// crysk.cli.*), so nothing the run recorded is lost to the conversion.
//
// CONTENT (`content` = /runs/token's `trace_content`): prompts, outputs, tool
// arguments and results, status messages, the transcripts, and every string
// that is not a single word (a failure detail, a finding's claim) are content.
// With `content` false none of them is emitted. The platform strips again on
// its side by an allowlist (apps/api/src/runs/trace.ts); this side is the
// first of the two.
//
// REDACTION: every string the OTLP document carries passes the session copy's
// redaction (redactSessionText / redactSessionDocument in
// src/execution/claude-session-trace.ts), a single word as much as a prompt: a
// bare key is one word. One choke point holds it: an attribute's string can
// only be a `Redacted`, which only redactText and redactJson make, and span
// names, status messages and the transcripts' step and model go through them
// too. The Claude session transcripts are that copy already (the CLI's
// redactSessionJsonl, src/execution/claude-session-trace.ts), so their text is
// not redacted a second time; an OpenCode capture is redacted here, by key.
//
// BUILTINS ONLY: see trace-transcripts.ts.

import { createHash } from "node:crypto";
import { crc32, deflateRawSync, constants as zlibConstants } from "node:zlib";
import {
  redactSessionDocument,
  redactSessionText,
} from "../execution/claude-session-trace";
import { metadataOnlyFinding } from "./platform-report";
import {
  type ChatMessage,
  type Conversation,
  openCodeConversation,
  parseClaudeSession,
  type ToolCall,
  type Turn,
  withoutContent,
} from "./trace-transcripts";

export const TRACE_SCHEMA = "crysk.trace.v1";
// The GenAI conventions are still in Development status. The message JSON
// (gen_ai.input.messages, gen_ai.output.messages, gen_ai.system_instructions)
// follows this version's schema:
// https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-input-messages.json
export const GENAI_SEMCONV_VERSION = "1.41.0";

// The platform's caps (apps/api/src/runs/trace-body.ts): 413 beyond either.
export const TRACE_COMPRESSED_MAX_BYTES = 25 * 1024 * 1024;
export const TRACE_DECOMPRESSED_MAX_BYTES = 200 * 1024 * 1024;

export type TraceOutcome =
  | "reviewed"
  | "hunters-failed"
  | "skipped"
  | "yielded"
  | "error";

export type TranscriptKind = "claude-session-jsonl" | "opencode-capture";

export interface TraceTranscript {
  step: string;
  attempt: number;
  model: string;
  kind: TranscriptKind;
  text: string;
}

declare const redactedBrand: unique symbol;
// A string that went through the secret redaction. Nothing else may become an
// attribute's string value.
type Redacted = string & { readonly [redactedBrand]: true };

function redactText(value: string): Redacted {
  return redactSessionText(value) as Redacted;
}

// A document's strings, redacted by key and by text, as JSON.
function redactJson(value: unknown): Redacted {
  return JSON.stringify(redactSessionDocument(value)) as Redacted;
}

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } };

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status: { code: number; message?: string };
}

export interface TraceBundle {
  schema: typeof TRACE_SCHEMA;
  outcome: TraceOutcome;
  code: string | null;
  content: boolean;
  truncated: boolean;
  otlp: {
    resourceSpans: Array<{
      resource: { attributes: KeyValue[] };
      scopeSpans: Array<{
        scope: { name: string; version?: string };
        spans: OtlpSpan[];
      }>;
    }>;
  };
  transcripts: TraceTranscript[];
}

export interface TraceAttemptInput {
  attempt: number;
  // steps/evidence.<step>.attempt<n>.json, parsed.
  evidence?: unknown;
  // steps/trace.<step>.attempt<n>.jsonl (Claude CLI), already redacted.
  sessionJsonl?: string;
  // steps/evidence.<step>.attempt<n>.capture.json (OpenCode).
  openCodeCapture?: string;
  // What a metadata trace reads of that transcript or capture instead of its
  // text (src/ci/platform-trace.ts readRunSteps): tool calls without arguments
  // or results, the finish reason, the response model and the times. Used
  // only when neither text is present.
  transcriptMetadata?: Conversation;
  // steps/evidence.<step>.attempt<n>.request.json, the plan frozen at spawn
  // (#511): its route and its file time. The only file an attempt still
  // running when the job was cancelled has written, so the only proof it ran.
  started?: AttemptStart;
}

export interface AttemptStart {
  atMs?: number;
  model?: string;
  provider?: string;
}

export interface TraceStepInput {
  name: string;
  // The step's system prompt file (steps/<name>.system.md or a shared one).
  systemPrompt?: string;
  // steps/<name>.body.md: a hunter's rendered body, used as the prompt when no
  // transcript names one.
  promptBody?: string;
  // The final attempt's output file (the step's outPath).
  output?: string;
  attempts: TraceAttemptInput[];
}

export interface TraceRunInput {
  outcome: TraceOutcome;
  code: string | null;
  // cli.json, pipeline.json and findings.json, parsed, when present.
  cli?: unknown;
  pipeline?: unknown;
  findings?: unknown;
  steps: TraceStepInput[];
  prNumber?: number;
  headSha?: string;
  engineVersion?: string;
  // When the run began and the trace was built, the bounds of the root span
  // when no attempt recorded a wider time.
  startedAtMs: number;
  endedAtMs: number;
}

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

// A single printable word, at most 200 characters: an id, a model name, a
// status, a path. Anything else (prose, an error sentence, code) is content.
const WORD = /^[\x21-\x7e]{1,200}$/;
// The platform keeps a `crysk.*` key only when it is this short and this
// lowercase (CRYSK_KEY in apps/api/src/runs/trace.ts).
const MAX_CRYSK_KEY = 106;
// Generic flattening stops here, so one record cannot flood a span.
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// camelCase, kebab-case and dotted names, as snake_case.
export function snakeKey(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
}

type NumberValue = { intValue: string } | { doubleValue: number };
type ScalarValue =
  | NumberValue
  | { boolValue: boolean }
  | { arrayValue: { values: NumberValue[] } };

// Thrown when the content strings alone pass the budget: the content cannot
// fit, so encodeTrace stops building it and sends the metadata.
class ContentOverBudget extends Error {}

// The content characters a build may hold; each is at least one byte of JSON.
interface ContentBudget {
  left: number;
  // Redacting this much content leaves garbage worth collecting (encodeTrace).
  settle?: { every: number; since: number; run: () => void };
}

class Attributes {
  readonly list: KeyValue[] = [];
  constructor(
    private readonly content: boolean,
    private readonly budget?: ContentBudget,
  ) {}

  private spend(value: Redacted): Redacted {
    const budget = this.budget;
    if (budget === undefined) return value;
    budget.left -= value.length;
    if (budget.left < 0) throw new ContentOverBudget();
    const settle = budget.settle;
    if (settle !== undefined) {
      settle.since += value.length;
      if (settle.since >= settle.every) {
        settle.since = 0;
        settle.run();
      }
    }
    return value;
  }

  private set(key: string, value: AnyValue): void {
    const at = this.list.findIndex((item) => item.key === key);
    if (at === -1) this.list.push({ key, value });
    else this.list[at] = { key, value };
  }

  // The only ways in: a string must be Redacted.
  private put(key: string, value: ScalarValue): void {
    this.set(key, value);
  }

  private putString(key: string, value: Redacted): void {
    this.set(key, { stringValue: value });
  }

  // What a metadata trace may keep of a string: one word before and after
  // redaction. With content, anything, redacted.
  private kept(value: string): Redacted | undefined {
    if (!this.content && !WORD.test(value)) return undefined;
    const safe = redactText(value);
    return this.content || WORD.test(safe) ? safe : undefined;
  }

  // A word always; anything longer or with spaces only as content. Redacted
  // either way.
  text(key: string, value: string | undefined): void {
    if (value === undefined || value === "") return;
    const safe = this.kept(value);
    if (safe !== undefined) this.putString(key, safe);
  }

  // Content only, whatever its shape, redacted as text.
  contentText(key: string, value: string | undefined): void {
    if (this.content && value !== undefined) {
      this.putString(key, this.spend(redactText(value)));
    }
  }

  // Content only: a structured value as JSON, redacted by key and by text.
  contentJson(key: string, value: unknown): void {
    if (this.content && value !== undefined) {
      this.putString(key, this.spend(redactJson(value)));
    }
  }

  number(key: string, value: unknown): void {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    this.put(
      key,
      Number.isSafeInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value },
    );
  }

  bool(key: string, value: unknown): void {
    if (typeof value === "boolean") this.put(key, { boolValue: value });
  }

  words(key: string, values: string[]): void {
    const kept = values
      .map((value) => this.kept(value))
      .filter((value): value is Redacted => value !== undefined);
    if (kept.length > 0) {
      this.set(key, {
        arrayValue: { values: kept.map((value) => ({ stringValue: value })) },
      });
    }
  }

  // Every leaf of a record under `prefix`, keys snake_cased. Scalar arrays
  // become array values; arrays of records are indexed.
  flatten(prefix: string, value: unknown, depth = 0): void {
    if (prefix.length > MAX_CRYSK_KEY) return;
    if (typeof value === "string") this.text(prefix, value);
    else if (typeof value === "number") this.number(prefix, value);
    else if (typeof value === "boolean") this.bool(prefix, value);
    else if (Array.isArray(value)) {
      if (value.every((item) => typeof item === "string")) {
        this.words(prefix, value as string[]);
      } else if (value.every((item) => typeof item === "number")) {
        const values = (value as number[]).filter(Number.isFinite);
        if (values.length > 0) {
          this.put(prefix, {
            arrayValue: {
              values: values.map((item) =>
                Number.isSafeInteger(item)
                  ? { intValue: String(item) }
                  : { doubleValue: item },
              ),
            },
          });
        }
      } else if (depth < MAX_DEPTH) {
        value.slice(0, MAX_ARRAY_ITEMS).forEach((item, index) => {
          this.flatten(`${prefix}.${index}`, item, depth + 1);
        });
      }
    } else if (isRecord(value) && depth < MAX_DEPTH) {
      for (const [key, item] of Object.entries(value)) {
        this.flatten(`${prefix}.${snakeKey(key)}`, item, depth + 1);
      }
    }
  }
}

function hex(seed: string, length: number): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

function nanos(ms: number): string {
  return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// A span name is `{operation} {target}`. The target, redacted, keeps the
// characters a backend reads as one token; anything else becomes `_`.
function spanName(operation: string, target: string | undefined): string {
  if (target === undefined || target === "") return operation;
  const safe = redactText(target);
  return `${operation} ${safe.replace(/[^\x21-\x7e]/g, "_").slice(0, 200)}`;
}

interface Window {
  start?: number;
  end?: number;
}

function widen(window: Window, start?: number, end?: number): void {
  for (const ms of [start, end]) {
    if (ms === undefined) continue;
    if (window.start === undefined || ms < window.start) window.start = ms;
    if (window.end === undefined || ms > window.end) window.end = ms;
  }
}

// What one attempt's evidence says, read defensively: older engines wrote less.
interface AttemptFacts {
  model?: string;
  provider?: string;
  completion?: string;
  usage?: Record<string, unknown>;
  start?: number;
  end?: number;
}

// An attempt with a frozen plan that nothing shows settled: the job ended
// while it ran. Missing evidence alone is not enough: the engine races its
// evidence write against a 100 ms timer and swallows a failure
// (src/execution/harness.ts runAdmittedAttempt), so a settled attempt can
// have none. `settled` is everything else that only settlement writes.
const UNSETTLED = "unsettled";

function attemptFacts(
  attempt: TraceAttemptInput,
  settled: boolean,
): AttemptFacts {
  const facts = settledFacts(attempt.evidence);
  const started = attempt.started;
  if (started === undefined) return facts;
  facts.model ??= started.model;
  facts.provider ??= started.provider;
  facts.start ??= started.atMs;
  if (attempt.evidence === undefined && !settled) {
    facts.completion = UNSETTLED;
  }
  return facts;
}

function settledFacts(evidence: unknown): AttemptFacts {
  if (!isRecord(evidence)) return {};
  const identity = isRecord(evidence.identity) ? evidence.identity : {};
  const route = isRecord(identity.route) ? identity.route : {};
  const outcome = isRecord(evidence.outcome) ? evidence.outcome : {};
  const settlement = isRecord(evidence.settlement) ? evidence.settlement : {};
  const times = isRecord(settlement.timestamps) ? settlement.timestamps : {};
  const facts: AttemptFacts = {};
  // The route's model is the one that ran: the Claude CLI's `--model` or the
  // OpenCode model id. `executionModel` is the step's logical model, which a
  // route plan may send elsewhere; it stays on the span as
  // `crysk.attempt.identity.execution_model` and names only evidence that
  // carries no route.
  const model = str(route.modelSnapshot) ?? str(identity.executionModel);
  if (model !== undefined) facts.model = model;
  const provider = str(route.provider);
  if (provider !== undefined) facts.provider = provider;
  const completion = str(outcome.completion) ?? str(settlement.outcome);
  if (completion !== undefined) facts.completion = completion;
  if (isRecord(outcome.usage)) facts.usage = outcome.usage;
  const start = timeOf(times.startedAt);
  const end =
    timeOf(times.settledAt) ??
    timeOf(times.terminationConfirmedAt) ??
    timeOf(times.leaseInvalidatedAt);
  if (start !== undefined) facts.start = start;
  if (end !== undefined) facts.end = end;
  return facts;
}

function sumKnown(...values: unknown[]): number | undefined {
  const known = values.map(num).filter((v): v is number => v !== undefined);
  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
}

// The engine's usage leaves are disjoint; the conventions count input with its
// cache and output with its reasoning. List cost follows the report step's
// rule: a subscription's notional cost, a metered run's cash cost.
function writeUsage(attrs: Attributes, usage: Record<string, unknown>): void {
  const tokens = isRecord(usage.tokens) ? usage.tokens : {};
  attrs.number(
    "gen_ai.usage.input_tokens",
    num(tokens.inputKnown) ??
      sumKnown(
        tokens.inputUncached,
        tokens.inputCacheRead,
        tokens.inputCacheWrite,
        tokens.inputOther,
      ),
  );
  attrs.number(
    "gen_ai.usage.output_tokens",
    num(tokens.outputKnown) ??
      sumKnown(
        tokens.outputVisible,
        tokens.outputReasoning,
        tokens.outputOther,
      ),
  );
  attrs.number("gen_ai.usage.cache_read.input_tokens", tokens.inputCacheRead);
  attrs.number(
    "gen_ai.usage.cache_creation.input_tokens",
    tokens.inputCacheWrite,
  );
  attrs.number("gen_ai.usage.reasoning.output_tokens", tokens.outputReasoning);
  const listCost =
    usage.billingMode === "subscription"
      ? num(usage.notionalCostUsd)
      : usage.billingMode === "metered"
        ? num(usage.cashCostUsd)
        : undefined;
  attrs.number("gen_ai.usage.cost", listCost);
  attrs.flatten("crysk.usage", usage);
}

function stepRole(pipeline: unknown, name: string): string {
  const plan =
    isRecord(pipeline) && isRecord(pipeline.route_plan)
      ? pipeline.route_plan
      : undefined;
  const planned = Array.isArray(plan?.steps)
    ? plan.steps.filter(isRecord).find((step) => step.stepKey === name)
    : undefined;
  const role = str(planned?.role);
  if (role !== undefined) return role;
  return name.split(/[-.]/)[0] ?? name;
}

function pipelineSteps(pipeline: unknown): Record<string, unknown>[] {
  return isRecord(pipeline) && Array.isArray(pipeline.steps)
    ? pipeline.steps.filter(isRecord)
    : [];
}

interface ParsedAttempt {
  conversation: Conversation;
  // The OpenCode capture, parsed once for the conversation and the transcript;
  // undefined when it does not parse (and is then never sent).
  capture?: unknown;
}

function parseAttempt(attempt: TraceAttemptInput): ParsedAttempt {
  if (attempt.sessionJsonl !== undefined) {
    return { conversation: parseClaudeSession(attempt.sessionJsonl) };
  }
  if (attempt.openCodeCapture !== undefined) {
    try {
      const capture: unknown = JSON.parse(attempt.openCodeCapture);
      return { conversation: openCodeConversation(capture), capture };
    } catch {
      return { conversation: { input: [], output: [], tools: [] } };
    }
  }
  if (attempt.transcriptMetadata !== undefined) {
    return { conversation: withoutContent(attempt.transcriptMetadata) };
  }
  return { conversation: { input: [], output: [], tools: [] } };
}

// What a metadata trace reads of a conversation: no message, no tool argument
// or result. encodeTrace keeps these from its content build, so its metadata
// fallback never parses the transcripts again.
type MetadataViews = Map<TraceAttemptInput, Conversation>;

const metadataView = withoutContent;

// Root-level `crysk.*` keys, beside the flattened records.
function rootAttributes(run: TraceRunInput, content: boolean): Attributes {
  const attrs = new Attributes(content);
  const findings = isRecord(run.findings) ? run.findings : {};
  const cli = isRecord(run.cli) ? run.cli : {};
  const cls = isRecord(cli.cls) ? cli.cls : {};
  attrs.text("gen_ai.operation.name", "invoke_workflow");
  attrs.text("gen_ai.agent.name", "crysk.review");
  attrs.text("crysk.engine.version", run.engineVersion);
  attrs.text("crysk.run.outcome", run.outcome);
  attrs.text("crysk.run.status", str(findings.run_status));
  attrs.text("crysk.run.code", run.code ?? undefined);
  attrs.text("crysk.cli.class", str(cls.kind));
  attrs.number("crysk.pr.number", run.prNumber);
  attrs.text("crysk.head.sha", run.headSha);
  attrs.text("crysk.model.setup", str(findings.model));
  attrs.bool("crysk.trace.content", content);
  attrs.text("crysk.genai.semconv", GENAI_SEMCONV_VERSION);
  if (isRecord(run.pipeline)) {
    // Steps get spans of their own; routePlan and routeFingerprint repeat
    // route_plan and route_fingerprint.
    const rest = { ...run.pipeline };
    for (const key of ["steps", "routePlan", "routeFingerprint"]) {
      delete rest[key];
    }
    attrs.flatten("crysk.pipeline", rest);
  }
  if (isRecord(run.findings)) {
    attrs.flatten(
      "crysk.findings",
      content ? run.findings : metadataFindings(run.findings),
    );
  }
  if (isRecord(run.cli)) attrs.flatten("crysk.cli", run.cli);
  return attrs;
}

// findings.json for a metadata trace. A single word can still quote the code (a
// symbol, a dedupe key, a hop), so each finding keeps only the fields the
// report step sends for a metadata_only repository, and the debug records
// (refuted and merged findings, root-cause clusters) become their counts.
function metadataFindings(
  findings: Record<string, unknown>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...findings };
  if (Array.isArray(doc.findings)) {
    doc.findings = doc.findings.map(metadataOnlyFinding);
  }
  if (doc.debug !== undefined) doc.debug = countsOf(doc.debug);
  return doc;
}

// Arrays become their length; numbers and booleans stay; text goes.
function countsOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const counted = countsOf(item);
    if (counted !== undefined) out[key] = counted;
  }
  return out;
}

export function buildTraceBundle(
  run: TraceRunInput,
  content: boolean,
): TraceBundle {
  return build(run, content, { views: new Map() });
}

interface BuildOptions {
  views: MetadataViews;
  budget?: ContentBudget;
  // Called after each attempt that had a transcript (see encodeTrace).
  settle?: () => void;
}

function build(
  run: TraceRunInput,
  content: boolean,
  { views, budget, settle }: BuildOptions,
): TraceBundle {
  const seed = `${run.headSha ?? ""}:${run.startedAtMs}`;
  const traceId = hex(`trace:${seed}`, 32);
  const id = (key: string) => hex(`span:${seed}:${key}`, 16);
  const rootId = id("root");
  const runWindow: Window = {};
  widen(runWindow, run.startedAtMs, run.endedAtMs);
  const children: OtlpSpan[] = [];
  const transcripts: TraceTranscript[] = [];
  const metas = pipelineSteps(run.pipeline);
  const metaOf = (name: string) => metas.find((meta) => meta.name === name);

  // Steps in pipeline order, then any step only its files name.
  const ordered = [
    ...metas.map(
      (meta) =>
        run.steps.find((step) => step.name === meta.name) ?? {
          name: String(meta.name),
          attempts: [],
        },
    ),
    ...run.steps.filter(
      (step) => !metas.some((meta) => meta.name === step.name),
    ),
  ];

  const pending: Array<{ span: OtlpSpan; window: Window }> = [];
  for (const step of ordered) {
    const meta = metaOf(step.name);
    const stepId = id(`step:${step.name}`);
    const stepWindow: Window = {};
    const stepSpans: OtlpSpan[] = [];
    const attempts = [...step.attempts].sort((a, b) => a.attempt - b.attempt);
    const finalAttempt = attempts.at(-1)?.attempt;
    for (const attempt of attempts) {
      // A step pipeline.json gave a status, a later attempt, or a transcript
      // or capture (copied only at settlement) each prove this one settled.
      const facts = attemptFacts(
        attempt,
        str(meta?.status) !== undefined ||
          attempt.attempt !== finalAttempt ||
          attempt.sessionJsonl !== undefined ||
          attempt.openCodeCapture !== undefined ||
          attempt.transcriptMetadata !== undefined,
      );
      const known = content ? undefined : views.get(attempt);
      const parsed: ParsedAttempt =
        known === undefined ? parseAttempt(attempt) : { conversation: known };
      const conversation = parsed.conversation;
      if (known === undefined) views.set(attempt, metadataView(conversation));
      const chatId = id(`chat:${step.name}:${attempt.attempt}`);
      const chatWindow: Window = {};
      widen(chatWindow, facts.start, facts.end);
      if (chatWindow.start === undefined) {
        widen(chatWindow, conversation.startMs, conversation.endMs);
      }
      // It ran until the job stopped, as far as anything recorded says.
      if (facts.completion === UNSETTLED) widen(chatWindow, run.endedAtMs);
      const model = facts.model ?? str(meta?.model);
      const cause = modelCause(meta, model);
      const failed =
        facts.completion !== undefined &&
        facts.completion !== "success" &&
        facts.completion !== "completed";
      const turns = conversation.turns ?? [];
      if (turns.length > 0) {
        // #511: one generation per model turn, under an attempt span that is
        // no generation itself, so a backend neither counts the attempt's
        // usage twice nor reads its whole length as one model call.
        const attrs = new Attributes(content, budget);
        attrs.text("crysk.step.name", step.name);
        attrs.number("crysk.attempt.number", attempt.attempt);
        attrs.text("crysk.attempt.status", facts.completion);
        attrs.text("crysk.attempt.cause", cause);
        if (facts.usage !== undefined)
          attrs.flatten("crysk.usage", facts.usage);
        if (attempt.evidence !== undefined) {
          attrs.flatten("crysk.attempt", attempt.evidence);
        }
        const turnIds = turns.map((_, index) =>
          id(`turn:${step.name}:${attempt.attempt}:${index}`),
        );
        const toolSpans = conversation.tools.map((call, index) => {
          const owner = call.turn === undefined ? undefined : turns[call.turn];
          return toolSpan(call, {
            traceId,
            spanId: id(`tool:${step.name}:${attempt.attempt}:${index}`),
            parentSpanId:
              call.turn === undefined ? chatId : (turnIds[call.turn] ?? chatId),
            content,
            ...(budget === undefined ? {} : { budget }),
            fallbackMs: owner?.startMs ?? chatWindow.start ?? run.startedAtMs,
          });
        });
        const container: OtlpSpan = {
          traceId,
          spanId: chatId,
          parentSpanId: stepId,
          name: spanName("attempt", `${step.name}#${attempt.attempt}`),
          kind: SPAN_KIND_INTERNAL,
          startTimeUnixNano: "",
          endTimeUnixNano: "",
          attributes: attrs.list,
          status: failed
            ? withMessage(
                STATUS_ERROR,
                content ? (cause ?? facts.completion) : undefined,
              )
            : {
                code: facts.completion === undefined ? STATUS_UNSET : STATUS_OK,
              },
        };
        stepSpans.push(container);
        const input = content ? chatInput(step, conversation) : [];
        turns.forEach((turn, index) => {
          const own = toolSpans.filter(
            (_, at) => conversation.tools[at]?.turn === index,
          );
          const window: Window = {};
          widen(window, turn.startMs, turn.endMs);
          // A turn still being written has no end of its own: its last tool
          // call is the last thing it did.
          if (turn.endMs === undefined) {
            for (const span of own) {
              widen(window, undefined, Number(span.endTimeUnixNano) / 1e6);
            }
          }
          widen(chatWindow, window.start, window.end);
          const turnAttrs = new Attributes(content, budget);
          turnAttrs.text("gen_ai.operation.name", "chat");
          turnAttrs.text("gen_ai.provider.name", facts.provider);
          turnAttrs.text("gen_ai.request.model", model);
          turnAttrs.text("gen_ai.response.model", turn.model ?? model);
          if (turn.finishReason !== undefined) {
            turnAttrs.words("gen_ai.response.finish_reasons", [
              turn.finishReason,
            ]);
          }
          writeTurnUsage(turnAttrs, turn);
          turnAttrs.text("crysk.step.name", step.name);
          turnAttrs.number("crysk.attempt.number", attempt.attempt);
          turnAttrs.number("crysk.turn.number", index + 1);
          if (content) {
            // The prompt once, on the turn that read it; each turn's answer on
            // its own span. Repeating the history on every turn would grow
            // with the square of the turns.
            if (index === 0) writeChatInput(turnAttrs, step, input);
            if (turn.message !== undefined) {
              turnAttrs.contentJson("gen_ai.output.messages", [turn.message]);
            }
          }
          const span: OtlpSpan = {
            traceId,
            spanId: turnIds[index] ?? chatId,
            parentSpanId: chatId,
            name: spanName("chat", model),
            kind: SPAN_KIND_CLIENT,
            startTimeUnixNano: "",
            endTimeUnixNano: "",
            attributes: turnAttrs.list,
            status: {
              code:
                turn.isError === true
                  ? STATUS_ERROR
                  : turn.finishReason !== undefined
                    ? STATUS_OK
                    : STATUS_UNSET,
            },
          };
          pending.push({ span, window });
          stepSpans.push(span, ...own);
        });
        stepSpans.push(
          ...toolSpans.filter((_, at) => {
            const owner = conversation.tools[at]?.turn;
            return owner === undefined || turnIds[owner] === undefined;
          }),
        );
        for (const span of toolSpans) {
          widen(
            chatWindow,
            Number(span.startTimeUnixNano) / 1e6,
            Number(span.endTimeUnixNano) / 1e6,
          );
        }
        pending.push({ span: container, window: chatWindow });
        widen(stepWindow, chatWindow.start, chatWindow.end);
        if (content) {
          transcripts.push(...transcriptsOf(step.name, attempt, parsed, model));
        }
        if (known === undefined && attempt.openCodeCapture !== undefined) {
          settle?.();
        }
        continue;
      }
      const attrs = new Attributes(content, budget);
      attrs.text("gen_ai.operation.name", "chat");
      attrs.text("gen_ai.provider.name", facts.provider);
      attrs.text("gen_ai.request.model", model);
      attrs.text("gen_ai.response.model", conversation.responseModel ?? model);
      if (conversation.finishReason !== undefined) {
        attrs.words("gen_ai.response.finish_reasons", [
          conversation.finishReason,
        ]);
      }
      if (facts.usage !== undefined) writeUsage(attrs, facts.usage);
      attrs.text("crysk.step.name", step.name);
      attrs.number("crysk.attempt.number", attempt.attempt);
      attrs.text("crysk.attempt.status", facts.completion);
      attrs.text("crysk.attempt.cause", cause);
      if (attempt.evidence !== undefined) {
        attrs.flatten("crysk.attempt", attempt.evidence);
      }
      if (content) {
        writeChatContent(attrs, step, attempt, conversation, {
          final: attempt.attempt === finalAttempt,
          completion: facts.completion,
        });
      }
      const toolSpans = conversation.tools.map((call, index) =>
        toolSpan(call, {
          traceId,
          spanId: id(`tool:${step.name}:${attempt.attempt}:${index}`),
          parentSpanId: chatId,
          content,
          ...(budget === undefined ? {} : { budget }),
          fallbackMs: chatWindow.start ?? run.startedAtMs,
        }),
      );
      for (const span of toolSpans) {
        widen(
          chatWindow,
          Number(span.startTimeUnixNano) / 1e6,
          Number(span.endTimeUnixNano) / 1e6,
        );
      }
      const chat: OtlpSpan = {
        traceId,
        spanId: chatId,
        parentSpanId: stepId,
        name: spanName("chat", model),
        kind: SPAN_KIND_CLIENT,
        startTimeUnixNano: "",
        endTimeUnixNano: "",
        attributes: attrs.list,
        status: failed
          ? withMessage(
              STATUS_ERROR,
              content ? (cause ?? facts.completion) : undefined,
            )
          : { code: facts.completion === undefined ? STATUS_UNSET : STATUS_OK },
      };
      pending.push({ span: chat, window: chatWindow });
      stepSpans.push(chat, ...toolSpans);
      widen(stepWindow, chatWindow.start, chatWindow.end);
      if (content) {
        transcripts.push(...transcriptsOf(step.name, attempt, parsed, model));
      }
      if (
        known === undefined &&
        (attempt.sessionJsonl !== undefined ||
          attempt.openCodeCapture !== undefined)
      ) {
        settle?.();
      }
    }

    const attrs = new Attributes(content);
    attrs.text("gen_ai.operation.name", "invoke_agent");
    attrs.text("gen_ai.agent.name", step.name);
    attrs.text("crysk.step.role", stepRole(run.pipeline, step.name));
    if (meta !== undefined) attrs.flatten("crysk.step", meta);
    attrs.text("crysk.step.name", step.name);
    attrs.text("crysk.model.effort", str(meta?.effort));
    const status = str(meta?.status);
    const span: OtlpSpan = {
      traceId,
      spanId: stepId,
      parentSpanId: rootId,
      name: spanName("invoke_agent", step.name),
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: "",
      endTimeUnixNano: "",
      attributes: attrs.list,
      status:
        status === "failed"
          ? withMessage(STATUS_ERROR, content ? str(meta?.failure) : undefined)
          : { code: status === "ok" ? STATUS_OK : STATUS_UNSET },
    };
    pending.push({ span, window: stepWindow });
    children.push(span, ...stepSpans);
    widen(runWindow, stepWindow.start, stepWindow.end);
  }

  // A span the run recorded no time for sits at the run's start, zero long.
  const runStart = runWindow.start ?? run.startedAtMs;
  const runEnd = runWindow.end ?? run.endedAtMs;
  for (const { span, window } of pending) {
    span.startTimeUnixNano = nanos(window.start ?? runStart);
    span.endTimeUnixNano = nanos(window.end ?? window.start ?? runStart);
  }

  const failedRun = run.outcome === "error" || run.outcome === "hunters-failed";
  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    name: spanName("invoke_workflow", "crysk.review"),
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(runStart),
    endTimeUnixNano: nanos(runEnd),
    attributes: rootAttributes(run, content).list,
    status: failedRun
      ? withMessage(
          STATUS_ERROR,
          content ? (run.code ?? run.outcome) : undefined,
        )
      : { code: STATUS_OK },
  };

  const resource = new Attributes(content);
  resource.text("service.name", "crysk");
  resource.text("service.version", run.engineVersion);
  const version =
    run.engineVersion === undefined ? undefined : redactText(run.engineVersion);
  return {
    schema: TRACE_SCHEMA,
    outcome: run.outcome,
    code: run.code === null ? null : redactText(run.code),
    content,
    truncated: false,
    otlp: {
      resourceSpans: [
        {
          resource: { attributes: resource.list },
          scopeSpans: [
            {
              scope: {
                name: "crysk",
                ...(version === undefined ? {} : { version }),
              },
              spans: [root, ...children],
            },
          ],
        },
      ],
    },
    transcripts,
  };
}

function withMessage(
  code: number,
  message: string | undefined,
): { code: number; message?: string } {
  return message === undefined
    ? { code }
    : { code, message: redactText(message) };
}

// The cause pipeline.json recorded for the model this attempt ran, when that
// model failed (`model_attempts`, written for a step that tried several).
function modelCause(
  meta: Record<string, unknown> | undefined,
  model: string | undefined,
): string | undefined {
  if (meta === undefined || !Array.isArray(meta.model_attempts)) {
    return undefined;
  }
  const entry = meta.model_attempts
    .filter(isRecord)
    .find((item) => item.model === model && item.status === "failed");
  return str(entry?.cause);
}

function writeChatContent(
  attrs: Attributes,
  step: TraceStepInput,
  attempt: TraceAttemptInput,
  conversation: Conversation,
  context: { final: boolean; completion?: string },
): void {
  writeChatInput(attrs, step, chatInput(step, conversation));
  // Without a transcript, the final attempt's output file is what it answered.
  const output: ChatMessage[] =
    conversation.output.length > 0
      ? conversation.output
      : context.final &&
          step.output !== undefined &&
          attempt.evidence !== undefined
        ? [
            {
              role: "assistant",
              parts: [{ type: "text", content: step.output }],
              finish_reason:
                context.completion === "success" ? "stop" : "error",
            },
          ]
        : [];
  if (output.length > 0) {
    attrs.contentJson("gen_ai.output.messages", output);
  }
}

// What the model was asked: the transcript's user messages, else the step's
// rendered body.
function chatInput(
  step: TraceStepInput,
  conversation: Conversation,
): ChatMessage[] {
  if (conversation.input.length > 0) return conversation.input;
  return step.promptBody === undefined
    ? []
    : [{ role: "user", parts: [{ type: "text", content: step.promptBody }] }];
}

function writeChatInput(
  attrs: Attributes,
  step: TraceStepInput,
  input: ChatMessage[],
): void {
  if (step.systemPrompt !== undefined) {
    attrs.contentJson("gen_ai.system_instructions", [
      { type: "text", content: step.systemPrompt },
    ]);
  }
  if (input.length > 0) {
    attrs.contentJson("gen_ai.input.messages", input);
  }
}

// A turn's usage in the conventions' totals: input with its cache, output
// with its reasoning (OpenCode's leaves are disjoint, as the engine's are).
function writeTurnUsage(attrs: Attributes, turn: Turn): void {
  attrs.number(
    "gen_ai.usage.input_tokens",
    sumKnown(turn.inputTokens, turn.cacheReadTokens, turn.cacheWriteTokens),
  );
  attrs.number(
    "gen_ai.usage.output_tokens",
    sumKnown(turn.outputTokens, turn.reasoningTokens),
  );
  attrs.number("gen_ai.usage.cache_read.input_tokens", turn.cacheReadTokens);
  attrs.number(
    "gen_ai.usage.cache_creation.input_tokens",
    turn.cacheWriteTokens,
  );
  attrs.number("gen_ai.usage.reasoning.output_tokens", turn.reasoningTokens);
  attrs.number("gen_ai.usage.cost", turn.costUsd);
}

function toolSpan(
  call: ToolCall,
  context: {
    traceId: string;
    spanId: string;
    parentSpanId: string;
    content: boolean;
    budget?: ContentBudget;
    // Where a call with no recorded time sits: its attempt's start.
    fallbackMs: number;
  },
): OtlpSpan {
  const attrs = new Attributes(context.content, context.budget);
  attrs.text("gen_ai.operation.name", "execute_tool");
  attrs.text("gen_ai.tool.name", call.name);
  attrs.text("gen_ai.tool.call.id", call.id);
  attrs.bool("crysk.tool.is_error", call.isError === true);
  if (typeof call.arguments === "string") {
    attrs.contentText("gen_ai.tool.call.arguments", call.arguments);
  } else {
    attrs.contentJson("gen_ai.tool.call.arguments", call.arguments);
  }
  attrs.contentText("gen_ai.tool.call.result", call.result);
  const start = call.startMs ?? call.endMs ?? context.fallbackMs;
  const end = call.endMs ?? start;
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    name: spanName("execute_tool", call.name),
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(Math.max(start, end)),
    attributes: attrs.list,
    status: { code: call.isError === true ? STATUS_ERROR : STATUS_UNSET },
  };
}

function transcriptsOf(
  step: string,
  attempt: TraceAttemptInput,
  parsed: ParsedAttempt,
  model: string | undefined,
): TraceTranscript[] {
  const base = {
    step: redactText(step),
    attempt: attempt.attempt,
    model: model === undefined ? "" : redactText(model),
  };
  if (attempt.sessionJsonl !== undefined) {
    // The CLI's redacted copy (see REDACTION in the header).
    return [
      { ...base, kind: "claude-session-jsonl", text: attempt.sessionJsonl },
    ];
  }
  // Never sent raw: a capture that does not parse is left out.
  if (parsed.capture !== undefined) {
    return [
      { ...base, kind: "opencode-capture", text: redactJson(parsed.capture) },
    ];
  }
  return [];
}

const SETTLE_EVERY_CHARS = 16 * 1024 * 1024;

export type EncodedTrace =
  | {
      ok: true;
      body: Uint8Array;
      bundle: TraceBundle;
      // Transcripts dropped to fit, and whether the content went too.
      droppedTranscripts: number;
      droppedContent: boolean;
    }
  | { ok: false; compressedBytes: number; jsonBytes: number };

export interface TraceLimits {
  compressed: number;
  decompressed: number;
}

// How the body is compressed, one piece at a time. The pieces are compressed
// independently and joined in order, so a piece's compressed size is final
// the moment it is compressed and a piece can be left out without touching
// the others. The default is gzip (gzipCodec); tests pass an identity codec.
export interface TraceCodec {
  // Bytes the join adds around the pieces.
  overhead: number;
  piece(bytes: Uint8Array): Uint8Array;
  // The body: the pieces in order, given the uncompressed whole's length and
  // CRC-32.
  join(pieces: Uint8Array[], raw: { length: number; crc: number }): Uint8Array;
}

// One gzip member (RFC 1952) whose deflate stream is the pieces in order. Each
// piece is raw deflate ending on a sync flush: byte-aligned, with no final
// block and no reference before its own start, so pieces join by
// concatenation; an empty final block closes the stream.
const gzipCodec: TraceCodec = {
  overhead: 10 + 2 + 8,
  piece: (bytes) =>
    deflateRawSync(bytes, { finishFlush: zlibConstants.Z_SYNC_FLUSH }),
  join(pieces, raw) {
    const header = Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
    const trailer = new Uint8Array(8);
    const view = new DataView(trailer.buffer);
    view.setUint32(0, raw.crc >>> 0, true);
    view.setUint32(4, raw.length >>> 0, true);
    return Buffer.concat([header, ...pieces, Uint8Array.from([3, 0]), trailer]);
  },
};

// Fits the bundle under both platform caps (contract: drop transcripts, the
// largest first, then the content, and set `truncated`; the OTLP metadata
// always survives). `ok: false` when even the metadata does not fit.
//
// WHY pieces: re-encoding the whole bundle after each dropped transcript grew
// with the square of the transcripts, and a runner ran out of memory on eight
// 30 MB sessions. Now the OTLP document and each transcript are serialized and
// compressed once, as pieces (TraceCodec); both sizes of any choice of
// transcripts are then exact sums, and the body joins the chosen pieces. The
// bound: every transcript is compressed at most once, the OTLP document at
// most twice (with its content, then without), and the body never again.
export function encodeTrace(
  run: TraceRunInput,
  content: boolean,
  limits: TraceLimits = {
    compressed: TRACE_COMPRESSED_MAX_BYTES,
    decompressed: TRACE_DECOMPRESSED_MAX_BYTES,
  },
  codec: TraceCodec = gzipCodec,
): EncodedTrace {
  const views: MetadataViews = new Map();
  // WHY a collection after each transcript: parsing and redacting a 30 MB
  // session leaves several times that in garbage, and the runtime let it pile
  // up across sessions (eight of them peaked at 2.4 GB; collected, 1.6 GB).
  // Content redacted in between counts too (SETTLE_EVERY_CHARS).
  const settle = () => Bun.gc(true);
  // Content strings past the uncompressed cap cannot fit with any transcript
  // dropped, so the build stops there and the metadata goes (below).
  let bundle: TraceBundle | undefined;
  try {
    bundle = build(run, content, {
      views,
      budget: {
        left: limits.decompressed,
        settle: { every: SETTLE_EVERY_CHARS, since: 0, run: settle },
      },
      settle,
    });
  } catch (error) {
    if (!(error instanceof ContentOverBudget)) throw error;
  }
  const total =
    bundle?.transcripts.length ??
    run.steps.reduce(
      (n, step) =>
        n +
        step.attempts.filter(
          (a) =>
            a.sessionJsonl !== undefined || a.openCodeCapture !== undefined,
        ).length,
      0,
    );
  let failure = { compressedBytes: 0, jsonBytes: 0 };

  if (bundle !== undefined) {
    const full = bundle;
    const otlp = pieceOf(codec, full.otlp, limits);
    if (otlp.ok) {
      const comma = pieceOf(codec, ",", limits, true);
      // Largest first, each serialized and compressed once, and only while
      // it could still fit on its own.
      const transcripts = full.transcripts
        .map((transcript, index) => ({
          transcript,
          index,
          piece: pieceOf(codec, transcript, limits),
        }))
        .sort((a, b) => b.transcript.text.length - a.transcript.text.length);
      let dropped = 0;
      for (; dropped <= transcripts.length; dropped++) {
        // The smallest survive, sent in the bundle's own order.
        const kept = transcripts
          .slice(dropped)
          .sort((a, b) => a.index - b.index);
        if (kept.some((item) => !item.piece.ok)) continue;
        const truncated = dropped > 0;
        const pieces = [
          headPiece(codec, full, truncated, limits),
          otlp,
          pieceOf(codec, ',"transcripts":[', limits, true),
          ...kept.flatMap((item, i) =>
            i === 0 ? [item.piece] : [comma, item.piece],
          ),
          pieceOf(codec, "]}", limits, true),
        ];
        const joined = join(codec, pieces, limits);
        if (!joined.ok) {
          failure = joined;
          continue;
        }
        return {
          ok: true,
          body: joined.body,
          bundle: {
            ...full,
            truncated,
            transcripts: kept.map((item) => item.transcript),
          },
          droppedTranscripts: dropped,
          droppedContent: false,
        };
      }
    } else {
      failure = otlp;
    }
  }

  // The content attributes go next, all together; `content` keeps saying what
  // the engine was told, and `truncated` says why the content is absent.
  const metadata: TraceBundle = {
    ...build(run, false, { views, settle }),
    content,
    truncated: true,
  };
  const otlp = pieceOf(codec, metadata.otlp, limits);
  const joined = otlp.ok
    ? join(
        codec,
        [
          headPiece(codec, metadata, true, limits),
          otlp,
          pieceOf(codec, ',"transcripts":[]}', limits, true),
        ],
        limits,
      )
    : otlp;
  if (!joined.ok) {
    return {
      ok: false,
      compressedBytes: joined.compressedBytes,
      jsonBytes: Math.max(joined.jsonBytes, failure.jsonBytes),
    };
  }
  return {
    ok: true,
    body: joined.body,
    bundle: metadata,
    droppedTranscripts: total,
    droppedContent: content,
  };
}

type Piece =
  | { ok: true; compressed: Uint8Array; length: number; crc: number }
  | { ok: false; compressedBytes: number; jsonBytes: number };

// A value as JSON (a string given `literal` is taken as written), compressed.
// Serializing or compressing that throws (JSON.stringify's RangeError past the
// runtime's string limit, a compression out of memory), or a piece past
// either cap alone, cannot be sent.
function pieceOf(
  codec: TraceCodec,
  value: unknown,
  limits: TraceLimits,
  literal = false,
): Piece {
  let length = 0;
  try {
    const text = literal ? String(value) : JSON.stringify(value);
    const bytes = new TextEncoder().encode(text);
    length = bytes.byteLength;
    if (length > limits.decompressed) {
      return {
        ok: false,
        compressedBytes: Number.POSITIVE_INFINITY,
        jsonBytes: length,
      };
    }
    const compressed = codec.piece(bytes);
    if (compressed.byteLength > limits.compressed) {
      return {
        ok: false,
        compressedBytes: compressed.byteLength,
        jsonBytes: length,
      };
    }
    return { ok: true, compressed, length, crc: crc32(bytes) };
  } catch {
    return {
      ok: false,
      compressedBytes: Number.POSITIVE_INFINITY,
      jsonBytes: length,
    };
  }
}

// The bundle's fields before `transcripts`, in the order
// JSON.stringify(bundle) writes them, up to the OTLP document.
function headPiece(
  codec: TraceCodec,
  bundle: TraceBundle,
  truncated: boolean,
  limits: TraceLimits,
): Piece {
  const head = JSON.stringify({
    schema: bundle.schema,
    outcome: bundle.outcome,
    code: bundle.code,
    content: bundle.content,
    truncated,
  });
  return pieceOf(codec, `${head.slice(0, -1)},"otlp":`, limits, true);
}

function join(
  codec: TraceCodec,
  pieces: Piece[],
  limits: TraceLimits,
):
  | { ok: true; body: Uint8Array }
  | { ok: false; compressedBytes: number; jsonBytes: number } {
  let length = 0;
  let compressedBytes = codec.overhead;
  let crc = 0;
  for (const piece of pieces) {
    if (!piece.ok) return piece;
    crc = crc32Combine(crc, piece.crc, piece.length);
    length += piece.length;
    compressedBytes += piece.compressed.byteLength;
  }
  if (length > limits.decompressed || compressedBytes > limits.compressed) {
    return { ok: false, compressedBytes, jsonBytes: length };
  }
  const body = codec.join(
    pieces.map((piece) => (piece as { compressed: Uint8Array }).compressed),
    { length, crc },
  );
  return { ok: true, body };
}

// zlib's crc32_combine: the CRC-32 of A followed by B, from both CRCs and B's
// length, by multiplying A's CRC through len(B) zero bytes in GF(2).
function gf2Times(matrix: Uint32Array, vector: number): number {
  let sum = 0;
  let row = 0;
  let rest = vector >>> 0;
  while (rest !== 0) {
    if (rest & 1) sum ^= matrix[row] ?? 0;
    rest >>>= 1;
    row += 1;
  }
  return sum >>> 0;
}

function gf2Square(out: Uint32Array, matrix: Uint32Array): void {
  for (let n = 0; n < 32; n++) out[n] = gf2Times(matrix, matrix[n] ?? 0);
}

function crc32Combine(crc1: number, crc2: number, len2: number): number {
  if (len2 <= 0) return crc1 >>> 0;
  const even = new Uint32Array(32);
  const odd = new Uint32Array(32);
  odd[0] = 0xedb88320;
  for (let n = 1, row = 1; n < 32; n++, row <<= 1) odd[n] = row;
  gf2Square(even, odd);
  gf2Square(odd, even);
  let crc = crc1 >>> 0;
  let rest = len2;
  for (;;) {
    gf2Square(even, odd);
    if (rest % 2 === 1) crc = gf2Times(even, crc);
    rest = Math.floor(rest / 2);
    if (rest === 0) break;
    gf2Square(odd, even);
    if (rest % 2 === 1) crc = gf2Times(odd, crc);
    rest = Math.floor(rest / 2);
    if (rest === 0) break;
  }
  return (crc ^ crc2) >>> 0;
}
