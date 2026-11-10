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
// REDACTION: every content string passes the session copy's redaction
// (redactSessionText / redactSessionDocument in
// src/execution/claude-session-trace.ts) before it is placed here. The Claude
// session transcripts are already that copy.
//
// BUILTINS ONLY: see trace-transcripts.ts.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  redactSessionDocument,
  redactSessionText,
} from "../execution/claude-session-trace";
import {
  type ChatMessage,
  type Conversation,
  parseClaudeSession,
  parseOpenCodeCapture,
  type ToolCall,
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

class Attributes {
  readonly list: KeyValue[] = [];
  constructor(private readonly content: boolean) {}

  private put(key: string, value: AnyValue): void {
    const at = this.list.findIndex((item) => item.key === key);
    if (at === -1) this.list.push({ key, value });
    else this.list[at] = { key, value };
  }

  // A word always; anything longer or with spaces only as content, redacted.
  text(key: string, value: string | undefined): void {
    if (value === undefined || value === "") return;
    if (WORD.test(value)) this.put(key, { stringValue: value });
    else if (this.content) {
      this.put(key, { stringValue: redactSessionText(value) });
    }
  }

  // Content only, whatever its shape.
  contentText(key: string, value: string | undefined): void {
    if (this.content && value !== undefined) {
      this.put(key, { stringValue: value });
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
      .filter((value) => WORD.test(value) || this.content)
      .map((value) => (WORD.test(value) ? value : redactSessionText(value)));
    if (kept.length > 0) {
      this.put(key, {
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

// A span name is `{operation} {target}`. The target keeps the characters a
// backend reads as one token; anything else becomes `_`.
function spanName(operation: string, target: string | undefined): string {
  if (target === undefined || target === "") return operation;
  return `${operation} ${target.replace(/[^\x21-\x7e]/g, "_").slice(0, 200)}`;
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

function attemptFacts(evidence: unknown): AttemptFacts {
  if (!isRecord(evidence)) return {};
  const identity = isRecord(evidence.identity) ? evidence.identity : {};
  const route = isRecord(identity.route) ? identity.route : {};
  const outcome = isRecord(evidence.outcome) ? evidence.outcome : {};
  const settlement = isRecord(evidence.settlement) ? evidence.settlement : {};
  const times = isRecord(settlement.timestamps) ? settlement.timestamps : {};
  const facts: AttemptFacts = {};
  const model = str(identity.executionModel) ?? str(route.modelSnapshot);
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

// The parts the conventions name, every string redacted.
function redactedJson(value: unknown): string {
  return JSON.stringify(redactSessionDocument(value));
}

function conversationOf(attempt: TraceAttemptInput): Conversation {
  if (attempt.sessionJsonl !== undefined) {
    return parseClaudeSession(attempt.sessionJsonl);
  }
  if (attempt.openCodeCapture !== undefined) {
    return parseOpenCodeCapture(attempt.openCodeCapture);
  }
  return { input: [], output: [], tools: [] };
}

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
  if (isRecord(run.findings)) attrs.flatten("crysk.findings", run.findings);
  if (isRecord(run.cli)) attrs.flatten("crysk.cli", run.cli);
  return attrs;
}

export function buildTraceBundle(
  run: TraceRunInput,
  content: boolean,
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
      const facts = attemptFacts(attempt.evidence);
      const conversation = conversationOf(attempt);
      const chatId = id(`chat:${step.name}:${attempt.attempt}`);
      const chatWindow: Window = {};
      widen(chatWindow, facts.start, facts.end);
      if (chatWindow.start === undefined) {
        widen(chatWindow, conversation.startMs, conversation.endMs);
      }
      const attrs = new Attributes(content);
      const model = facts.model ?? str(meta?.model);
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
      const cause = modelCause(meta, model);
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
      const failed =
        facts.completion !== undefined &&
        facts.completion !== "success" &&
        facts.completion !== "completed";
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
      if (content)
        transcripts.push(...transcriptsOf(step.name, attempt, model));
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
  return {
    schema: TRACE_SCHEMA,
    outcome: run.outcome,
    code: run.code,
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
                ...(run.engineVersion === undefined
                  ? {}
                  : { version: run.engineVersion }),
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
    : { code, message: redactSessionText(message) };
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
  if (step.systemPrompt !== undefined) {
    attrs.contentText(
      "gen_ai.system_instructions",
      redactedJson([{ type: "text", content: step.systemPrompt }]),
    );
  }
  const input: ChatMessage[] =
    conversation.input.length > 0
      ? conversation.input
      : step.promptBody !== undefined
        ? [
            {
              role: "user",
              parts: [{ type: "text", content: step.promptBody }],
            },
          ]
        : [];
  if (input.length > 0) {
    attrs.contentText("gen_ai.input.messages", redactedJson(input));
  }
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
    attrs.contentText("gen_ai.output.messages", redactedJson(output));
  }
}

function toolSpan(
  call: ToolCall,
  context: {
    traceId: string;
    spanId: string;
    parentSpanId: string;
    content: boolean;
    // Where a call with no recorded time sits: its attempt's start.
    fallbackMs: number;
  },
): OtlpSpan {
  const attrs = new Attributes(context.content);
  attrs.text("gen_ai.operation.name", "execute_tool");
  attrs.text("gen_ai.tool.name", call.name);
  attrs.text("gen_ai.tool.call.id", call.id);
  attrs.bool("crysk.tool.is_error", call.isError === true);
  if (context.content) {
    if (call.arguments !== undefined) {
      attrs.contentText(
        "gen_ai.tool.call.arguments",
        typeof call.arguments === "string"
          ? redactSessionText(call.arguments)
          : redactedJson(call.arguments),
      );
    }
    if (call.result !== undefined) {
      attrs.contentText(
        "gen_ai.tool.call.result",
        redactSessionText(call.result),
      );
    }
  }
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
  model: string | undefined,
): TraceTranscript[] {
  const out: TraceTranscript[] = [];
  const base = { step, attempt: attempt.attempt, model: model ?? "" };
  if (attempt.sessionJsonl !== undefined) {
    out.push({
      ...base,
      kind: "claude-session-jsonl",
      text: attempt.sessionJsonl,
    });
  }
  if (attempt.openCodeCapture !== undefined) {
    // Never sent raw: a capture that does not parse is left out.
    try {
      const capture: unknown = JSON.parse(attempt.openCodeCapture);
      out.push({
        ...base,
        kind: "opencode-capture",
        text: JSON.stringify(redactSessionDocument(capture)),
      });
    } catch {
      // see above
    }
  }
  return out;
}

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

// Fits the bundle under both platform caps (contract: drop transcripts, the
// largest first, then the content, and set `truncated`; the OTLP metadata
// always survives). `ok: false` when even the metadata does not fit.
export function encodeTrace(
  run: TraceRunInput,
  content: boolean,
  limits: TraceLimits = {
    compressed: TRACE_COMPRESSED_MAX_BYTES,
    decompressed: TRACE_DECOMPRESSED_MAX_BYTES,
  },
  gzip: (bytes: Uint8Array) => Uint8Array = (bytes) => gzipSync(bytes),
): EncodedTrace {
  const bundle = buildTraceBundle(run, content);
  const largestFirst = [...bundle.transcripts].sort(
    (a, b) => b.text.length - a.text.length,
  );
  let jsonBytes = 0;
  let compressedBytes = 0;
  const fits = (candidate: TraceBundle): Uint8Array | undefined => {
    const json = new TextEncoder().encode(JSON.stringify(candidate));
    jsonBytes = json.byteLength;
    if (jsonBytes > limits.decompressed) {
      compressedBytes = Number.POSITIVE_INFINITY;
      return undefined;
    }
    const body = gzip(json);
    compressedBytes = body.byteLength;
    return compressedBytes <= limits.compressed ? body : undefined;
  };

  let dropped = 0;
  let current = bundle;
  for (;;) {
    const body = fits(current);
    if (body !== undefined) {
      return {
        ok: true,
        body,
        bundle: current,
        droppedTranscripts: dropped,
        droppedContent: false,
      };
    }
    if (dropped >= largestFirst.length) break;
    const drop = largestFirst[dropped];
    dropped += 1;
    current = {
      ...current,
      truncated: true,
      transcripts: current.transcripts.filter((item) => item !== drop),
    };
  }

  // The content attributes go next, all together; `content` keeps saying what
  // the engine was told, and `truncated` says why the content is absent.
  const metadata: TraceBundle = {
    ...buildTraceBundle(run, false),
    content,
    truncated: true,
  };
  const body = fits(metadata);
  if (body === undefined) return { ok: false, compressedBytes, jsonBytes };
  return {
    ok: true,
    body,
    bundle: metadata,
    droppedTranscripts: dropped,
    droppedContent: content,
  };
}
