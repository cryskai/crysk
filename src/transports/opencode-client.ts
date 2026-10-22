import { OpenCodeEvidenceCollector } from "./opencode-evidence";
// D1-06: the mapping between what @opencode-ai/sdk actually emits and the
// narrow `OpenCodeClientLike` contract the transport was built against.
//
// Everything here is derived from a recorded live probe
// (scripts/opencode-probe.ts), not from the SDK's type declarations: the
// declared Event union has 32 members and answers none of the questions that
// decide this mapping. The full findings, including the three traps encoded
// below, are in docs/research/opencode-adapter-mapping.md.
//
// This module is PURE. The impure half — spawning a server with the projected
// credential environment and a verified absolute binary — is a separate slice,
// because the SDK's own `createOpencodeServer` cannot be used for it: it
// inherits process.env wholesale and resolves the binary off PATH, so it would
// defeat both the credential projection (§6.1) and the verified-binary rule
// (§13).

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CredentialKind,
  ProviderTerminalProof,
} from "../execution/contracts";
import {
  ALL_MCP_TOOL_IDS,
  assertMcpConnected,
  mcpToolIdsFor,
  type OpenCodeMcpConfig,
  translateMcpConfig,
} from "./opencode-mcp";
import type {
  OpenCodeClientEvent,
  OpenCodeClientLike,
  OpenCodeClientSession,
  OpenCodeCreateSessionInput,
  OpenCodePollResult,
} from "./opencode-sdk";
import {
  formatPermissionRejectFailureDetail,
  formatProviderLimitDetail,
} from "./opencode-sdk";
import type { OpenCodeServerHandle } from "./opencode-server";

// Structural, not imported from the SDK: pr-hero ships with ZERO runtime
// dependencies, and a Claude-only install must not pull an OpenCode SDK it
// will never call. The adapter slice declares the SDK an OPTIONAL peer and
// reaches it through a dynamic import.
interface RawEvent {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly properties?: unknown;
}

function props(raw: unknown): Record<string, unknown> | undefined {
  const candidate = (raw as RawEvent)?.properties;
  return typeof candidate === "object" && candidate !== null
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

// #228: the raw provider event carries its session id in one of three
// places depending on its shape — a plain event's own `properties.sessionID`,
// a `message.part.*` event's `properties.part.sessionID`, or a
// `message.updated`-shaped event's `properties.info.sessionID`. Returns
// `undefined` when none of the three is present, which the caller treats as
// "cannot be attributed to any session" and therefore not filterable.
function eventSessionId(raw: unknown): string | undefined {
  const p = props(raw);
  if (p === undefined) return undefined;
  if (typeof p.sessionID === "string") return p.sessionID;
  const part = asRecord(p.part);
  if (part !== undefined && typeof part.sessionID === "string")
    return part.sessionID;
  const info = asRecord(p.info);
  if (info !== undefined && typeof info.sessionID === "string")
    return info.sessionID;
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// §5.2/§3.2: the proof must be PROVIDER-issued. `session.idle` cannot supply
// one — its entire payload is {sessionID} — so the proof CONTENT is taken from
// the assistant message, which carries a real completion record. Both §197
// observers reach it independently: the stream through `message.updated`, the
// poll through session.messages.
//
// A proof is not a BOUNDARY, and issue #127 is the whole cost of confusing the
// two. This function answers "did this STEP end", never "did the turn end":
// OpenCode creates one assistant message per agentic step, each with its own
// `time.completed`. The turn's boundary is `session.idle` on the stream and
// the session leaving `GET /session/status` on the poll; see mapOpenCodeEvents
// and pollStatus below.
export function terminalProofFromAssistant(
  info: unknown,
  state?: OpenCodeTurnState,
): ProviderTerminalProof | undefined {
  const message = asRecord(info);
  if (message === undefined) return undefined;
  if (message.role !== "assistant") return undefined;

  const id = message.id;
  if (typeof id !== "string" || id.length === 0) return undefined;

  const completed = asNumber(asRecord(message.time)?.completed);
  // Not finished is not a completion record. An assistant message exists from
  // the moment its step starts; only `time.completed` says the step ended and
  // therefore that there is anything here to quote as proof.
  if (completed === undefined) return undefined;

  if (state !== undefined) {
    if (
      state.sessionId !== undefined &&
      message.sessionID !== undefined &&
      message.sessionID !== state.sessionId
    ) {
      return undefined;
    }
    if (state.tombstones.has(id)) return undefined;
    if (!isMessageOwned(id, state)) return undefined;
    if (message.error === undefined) {
      // Completed tool-calls or unknown finish never establishes success
      if (message.finish !== "stop") return undefined;
      if (hasOutstandingTools(state)) return undefined;
      if (!isMessageOwned(id, state)) {
        return undefined;
      }
    }
  }

  // providerStatus is a NORMALISED field, not a passthrough. The transport
  // maps "completed" to success, "cancelled" to cancelled and EVERYTHING ELSE
  // to failed (opencode-sdk.ts:781-789), so handing it OpenCode's raw finish
  // reason reported every successful completion as a failure — pr-hero found
  // exactly that, filed BLOCKER, on PR #82. The provider's vocabulary is
  // translated here rather than leaked into a field whose meaning is fixed
  // somewhere else.
  //
  // §3.2 sets the direction of every uncertain case: an unrecognised outcome
  // must never become success. `finish` is declared `finish?: string` with no
  // enumerated value space, so anything outside the known set stays outside
  // "completed" and the transport's else-branch turns it into a failure.
  const error = asRecord(message.error);
  const finish = message.finish;
  const providerStatus =
    error !== undefined
      ? // An abort is a cancellation, not a failure — the harness accounts
        // for those differently (§5.3), and calling one the other loses the
        // distinction that says whether remote work may still be running.
        error.name === "MessageAbortedError"
        ? "cancelled"
        : "failed"
      : finish === "stop"
        ? "completed"
        : typeof finish === "string" && finish.length > 0
          ? finish
          : "unknown";

  return {
    eventId: id,
    providerStatus,
    providerObservedAt: new Date(completed).toISOString(),
  };
}

// SessionStatus's `retry` arm carries `next`, a timestamp. This is the
// provider-issued backoff hint decideRetryDisposition (§7) has accepted as an
// optional retryAfterMs since D1-07 and that no transport has ever been able
// to supply — the CLI transport reads the child's stdout and never sees an
// HTTP header. Returned as a DURATION because that is what the policy takes,
// and only when it is still in the future: a hint that already elapsed is not
// a hint, and passing a negative delay would be worse than passing none.
export function retryHintFromStatus(
  status: unknown,
  nowMs: number,
): number | undefined {
  const record = asRecord(status);
  if (record?.type !== "retry") return undefined;
  const next = asNumber(record.next);
  if (next === undefined) return undefined;
  const delta = next - nowMs;
  return delta > 0 ? delta : undefined;
}

// #157: SessionStatus's `retry` arm can also carry an `action` naming an
// account/usage limit rather than an ordinary transient backoff. Only
// "account_rate_limit" has ever been observed (pr-157-8df2fca3-4, all three
// hunter captures, 3487 occurrences each) — this set is deliberately literal
// rather than "any retry", so an unrecognised future reason keeps today's
// alive-and-retrying behavior instead of guessing at a fact the provider
// never actually stated. `message` is read from the top-level retry status,
// not `action.message` — measured identical on the real capture, and the
// top-level field is what retryHintFromStatus above already reads its
// sibling `next` from.
const ACCOUNT_LIMIT_REASONS: ReadonlySet<string> = new Set([
  "account_rate_limit",
]);

export function providerLimitFromStatus(
  status: unknown,
): { reason: string; message: string } | undefined {
  const record = asRecord(status);
  if (record?.type !== "retry") return undefined;
  const action = asRecord(record.action);
  const reason = action?.reason;
  if (typeof reason !== "string" || !ACCOUNT_LIMIT_REASONS.has(reason)) {
    return undefined;
  }
  const message = typeof record.message === "string" ? record.message : "";
  return { reason, message };
}

// #213: EventSessionError's `properties.error`. `responseBody` is not read —
// the witness is the name, the status, the retry flag, and `data.message`.
export function providerRefusalFromProperties(properties: unknown):
  | {
      name: string;
      statusCode?: number;
      retryable?: boolean;
      message: string;
    }
  | undefined {
  const error = asRecord(asRecord(properties)?.error);
  if (error === undefined) return undefined;
  const name =
    typeof error.name === "string" && error.name.length > 0
      ? error.name
      : "unknown";
  const data = asRecord(error.data);
  const message = typeof data?.message === "string" ? data.message : "";
  const statusCode = asNumber(data?.statusCode);
  const retryable =
    typeof data?.isRetryable === "boolean" ? data.isRetryable : undefined;
  return {
    name,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    message,
  };
}

// TRAP 4 (issue #124): `message.part.delta` carries NO part type. Its whole
// payload is {sessionID, messageID, partID, field, delta}, so the only way to
// know what a delta belongs to is to correlate its `partID` against the part
// announced earlier by `message.part.updated`.
//
// Filtering on `field === "text"` — the FIELD NAME — is not that correlation
// and never was: the SDK declares `ReasoningPart` with a member literally
// called `text`, exactly as `TextPart` has, so with a reasoning model the
// model's private thinking was concatenated into finalText as if it were the
// answer. The #116 smoke pass 3 artifact shows it verbatim, two reasoning
// deltas glued together with no separator where the JSON answer belonged, and
// every hunter in that run failed format_violation over it.
//
// This is the state that correlation needs. It travels with the SessionState
// so it dies with the session rather than with the process, and BOTH maps are
// bounded: an SSE subscription is long-lived and a map keyed by a
// provider-generated id would otherwise grow for as long as the session does.
// Eviction is oldest-first (a Map iterates in insertion order), which is the
// safe direction — parts are announced and streamed in order, so the oldest
// entry is the one no delta can still name.
export interface TrackedPartDetail {
  readonly id: string;
  messageId?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  emittedText: string;
  toolStatus?: "pending" | "running" | "completed" | "error";
  toolCallId?: string;
}

export interface TrackedMessageDetail {
  readonly id: string;
  readonly role: "user" | "assistant" | string;
  sessionID?: string;
  parentID?: string;
  time?: { created?: number; completed?: number };
  finish?: string;
  error?: unknown;
  hasToolCalls?: boolean;
  partIds: string[];
}

export interface UnknownOwnerObservation {
  readonly type: "part.updated" | "part.delta";
  readonly partId: string;
  readonly messageId?: string;
  readonly raw: Record<string, unknown>;
  // Set only for a buffered "part.delta": the provider event id, threaded
  // through so replay (reconcileUnknownOwnerBuffer) can dedupe by identity
  // the same way a live delta does. "part.updated" snapshots are cumulative
  // and self-idempotent, so they carry no id.
  readonly eventId?: string;
}

export interface OpenCodeTurnState {
  readonly sessionId?: string;
  currentUserId?: string;
  expectedCwd?: string;
  readonly assistantMessages: Set<string>;
  readonly parts: Map<string, "answer" | "reasoning">;
  readonly partDetails: Map<string, TrackedPartDetail>;
  readonly messageDetails: Map<string, TrackedMessageDetail>;
  readonly parentLinks: Map<string, string>;
  readonly toolStates: Map<
    string,
    "pending" | "running" | "completed" | "error"
  >;
  // Owned ONLY by the stream path (`handlePartUpdated`). `reconcileMessages`
  // (the poll readback) writes `toolStates` unconditionally and can observe
  // a LATER status before the stream delivers that tool's own earlier ones
  // — crediting activity off `toolStates` would let a poll-advanced rank
  // suppress every real transition the stream later reports. See the WHY
  // comment at its use site in `handlePartUpdated`.
  readonly toolActivityRank: Map<string, number>;
  // pr-hero review F001 (#214): every callID EVER observed "completed", by
  // either the stream (`handlePartUpdated`) or the poll (`reconcileMessages`)
  // — never removed, regardless of what a LATER observation reports for that
  // same callID. `toolStates` above stores the provider's raw LAST-KNOWN
  // status and is written unconditionally by both observers; a poll that
  // recomputed "how many are completed" by re-filtering `toolStates` at each
  // terminal (the pre-fix design) went DOWN the moment any earlier-completed
  // call's status changed to "error" on a later readback. This set is the
  // fix: `pollStatus` reports its members, never a fresh `toolStates`
  // filter. Bounded by construction, not a separate cap — an id is added
  // here only once it is already present in `toolStates`, which enforces
  // MAX_TRACKED_PARTS before either write.
  readonly completedToolCallIds: Set<string>;
  // pr-hero review F001 (round 3): STREAM-OWNED — written and read ONLY by
  // `handlePartUpdated`, to decide whether THIS observer has already emitted
  // its own `{kind:"tool"}` for a callID. Deliberately a SEPARATE set from
  // `completedToolCallIds` above, which `reconcileMessages` (prompt_result's
  // own readback at session-create, and every poll round, winning or not)
  // also writes unconditionally. Gating the stream's emission on the SHARED
  // set (the round-2 shape) let a non-stream reconcile that observed
  // "completed" for a callID BEFORE the stream's own SSE event for that
  // exact completion arrive suppress the stream's emission entirely — and
  // when the STREAM, not the poll, goes on to win the turn's terminal (no
  // poll terminal ever reports that callID), the transport's union receives
  // it from NEITHER channel and undercounts a hunter that plainly looked.
  // Emission dedupe must be decided from what THIS observer has already
  // emitted, never from what some other observer already recorded. Bounded
  // by construction like `completedToolCallIds` (no separate cap, no
  // eviction): every id here is added only after `toolStates`'s own
  // MAX_TRACKED_PARTS check above already passed for that identity.
  readonly streamCompletedToolCallIds: Set<string>;
  readonly tombstones: Set<string>;
  readonly unknownOwnerBuffer: Array<UnknownOwnerObservation>;
  // Provider event ids for text deltas actually applied to `emittedText`
  // (never ids merely seen while buffered — see `handlePartDelta`).
  readonly deltaEventIds: Set<string>;
  // Sibling to `deltaEventIds` above, kept separate rather than shared: that
  // set's own comment fixes its meaning as "applied to emittedText", which a
  // reasoning delta never is (see `handlePartDelta`'s reasoning branch). A
  // provider event id is unique across the whole stream regardless of part
  // kind, so there is no collision risk in sharing it — this is a semantics
  // choice, not a safety one. Records every NOVEL reasoning-delta id seen,
  // so a replayed id (an SSE Last-Event-ID reconnect) is recognized and does
  // not earn useful-progress credit twice.
  readonly reasoningDeltaEventIds: Set<string>;
  readonly usage: Map<string, StepUsage>;
  readonly completedUsage: Set<string>;
  readonly payloadBytes: Map<string, number>;
  readonly trackedPartOwners: Map<string, string>;
  readonly evictedUsageIds: Set<string>;
  usageCapped: boolean;
  usageConflict?: boolean;
  usageIncomplete?: boolean;
  carriedUsage: StepUsage;
  lastProof?: ProviderTerminalProof;
  boundaryReported: boolean;
  integrityFailure?: string;
}

interface StepUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  // OpenCode's `info.tokens` leaves are disjoint-additive
  // (packages/schema/src/token-usage.ts): total = input + output + reasoning
  // + cache.read + cache.write. Carried so cache use is measurable on this
  // route; absent stays absent, never a fabricated 0.
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

const MAX_TRACKED_PARTS = 4096;
const MAX_TRACKED_MESSAGES = 512;
const MAX_UNKNOWN_OWNER_BUFFER = 256;
const MAX_TOMBSTONES = 1024;
const MAX_READBACK_BYTES = 4 * 1024 * 1024;
// Same order of magnitude as MAX_TRACKED_PARTS: sized to cover an SSE
// reconnect's Last-Event-ID replay window for one turn's answer deltas.
const MAX_TRACKED_DELTA_EVENTS = 4096;
// Own cap, same rationale as MAX_TRACKED_DELTA_EVENTS, for reasoningDeltaEventIds.
const MAX_TRACKED_REASONING_DELTA_EVENTS = 4096;
// PR #228 review, F002: same redelivery hazard as MAX_TRACKED_DELTA_EVENTS
// (an SSE Last-Event-ID reconnect can replay an event this session already
// saw), applied to `permission.asked` requestIDs — see SessionState's
// `respondedPermissions`. Permission prompts are far rarer than deltas
// within one attempt, so a smaller cap than MAX_TRACKED_DELTA_EVENTS is
// still generous; sized to MAX_TRACKED_MESSAGES for the same "one order of
// magnitude above anything a real attempt produces" reasoning. Unlike every
// OTHER bounded set here, reaching this cap does NOT evict the oldest id via
// `rememberId` — round 2 of the same review: an evicted requestID is
// indistinguishable from an unseen one, so its later redelivery would slip
// past the dedupe guard and fire a second reply. The attempt fails closed
// instead once this many distinct prompts have been answered in one turn.
const MAX_TRACKED_PERMISSION_REQUESTS = MAX_TRACKED_MESSAGES;
// An SSE `Last-Event-ID` reconnect can re-deliver an OLDER status after a
// newer one already landed (e.g. "running" replayed after "completed" was
// already observed) — `previousStatus !== status` alone would credit that
// replay as a transition, since it genuinely differs from what is stored.
// Rank makes only FORWARD movement count: `completed` and `error` share a
// rank because both are terminal outcomes and neither outranks the other, so
// one following the other (in either direction) is not progress either.
const TOOL_STATUS_RANK: Record<
  "pending" | "running" | "completed" | "error",
  number
> = {
  pending: 0,
  running: 1,
  completed: 2,
  error: 2,
};

export function createTurnState(
  sessionId?: string,
  currentUserId?: string,
  expectedCwd?: string,
): OpenCodeTurnState {
  return {
    sessionId,
    currentUserId,
    expectedCwd,
    assistantMessages: new Set(),
    parts: new Map(),
    partDetails: new Map(),
    messageDetails: new Map(),
    parentLinks: new Map(),
    toolStates: new Map(),
    toolActivityRank: new Map(),
    completedToolCallIds: new Set(),
    streamCompletedToolCallIds: new Set(),
    tombstones: new Set(),
    unknownOwnerBuffer: [],
    deltaEventIds: new Set(),
    reasoningDeltaEventIds: new Set(),
    usage: new Map(),
    completedUsage: new Set(),
    payloadBytes: new Map(),
    trackedPartOwners: new Map(),
    evictedUsageIds: new Set(),
    usageCapped: false,
    usageConflict: false,
    usageIncomplete: false,
    carriedUsage: {},
    boundaryReported: false,
  };
}

function failIntegrity(state: OpenCodeTurnState, detail: string): never {
  state.integrityFailure = `[pr-hero] opencode client: ${detail}`;
  throw new Error(state.integrityFailure);
}

function canonicalDirectory(path: string): string {
  // Canonicalize existing symlinks, while keeping pure fixtures and a removed
  // checkout deterministic. Neither spelling can authorize another directory.
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function trackPayload(
  state: OpenCodeTurnState,
  key: string,
  value: unknown,
): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  let total = bytes;
  for (const [id, size] of state.payloadBytes) if (id !== key) total += size;
  if (total > MAX_READBACK_BYTES)
    failIntegrity(state, "observation byte budget exceeded");
  state.payloadBytes.set(key, bytes);
}

function trackPart(
  state: OpenCodeTurnState,
  part: Record<string, unknown>,
  messageId: string,
): void {
  const id = part.id;
  if (
    typeof id !== "string" ||
    part.messageID !== messageId ||
    (state.sessionId !== undefined && part.sessionID !== state.sessionId)
  ) {
    failIntegrity(state, "part ownership mismatch or missing identity");
  }
  if (state.tombstones.has(id))
    failIntegrity(state, "required part reappeared after removal");
  const owner = state.trackedPartOwners.get(id);
  if (owner !== undefined && owner !== messageId)
    failIntegrity(state, "part identity changed ownership");
  if (
    owner === undefined &&
    state.trackedPartOwners.size >= MAX_TRACKED_PARTS
  ) {
    failIntegrity(state, "maximum tracked parts exceeded");
  }
  trackPayload(state, `part:${id}`, part);
  state.trackedPartOwners.set(id, messageId);
}

function trackMessage(
  state: OpenCodeTurnState,
  info: Record<string, unknown>,
): void {
  const id = info.id;
  if (
    typeof id !== "string" ||
    (state.sessionId !== undefined && info.sessionID !== state.sessionId)
  ) {
    failIntegrity(state, "message ownership mismatch or missing identity");
  }
  const previous = state.messageDetails.get(id);
  if (
    previous !== undefined &&
    (previous.role !== info.role ||
      (previous.parentID !== undefined && previous.parentID !== info.parentID))
  ) {
    failIntegrity(state, "message identity changed role or parent");
  }
  if (
    !state.payloadBytes.has(`message:${id}`) &&
    [...state.payloadBytes.keys()].filter((key) => key.startsWith("message:"))
      .length >= MAX_TRACKED_MESSAGES
  ) {
    failIntegrity(state, "message cap exceeded (cap exhaustion)");
  }
  const path = asRecord(info.path);
  if (
    info.role === "assistant" &&
    state.expectedCwd !== undefined &&
    (typeof path?.cwd !== "string" ||
      canonicalDirectory(path.cwd) !== canonicalDirectory(state.expectedCwd))
  ) {
    failIntegrity(state, "message cwd mismatch or unavailable");
  }
  trackPayload(state, `message:${id}`, info);
}

export function isMessageOwned(
  messageId: string,
  state: OpenCodeTurnState,
): boolean {
  if (state.currentUserId === undefined) return false;
  if (messageId === state.currentUserId) return true;
  let current: string | undefined = state.parentLinks.get(messageId);
  const visited = new Set<string>();
  while (current !== undefined) {
    if (visited.has(current)) return false;
    visited.add(current);
    if (current === state.currentUserId) return true;
    current = state.parentLinks.get(current);
  }
  return false;
}

export function hasOutstandingTools(state: OpenCodeTurnState): boolean {
  for (const status of state.toolStates.values()) {
    if (status === "pending" || status === "running") {
      return true;
    }
  }
  return false;
}

function evaluateFinalAssistant(
  info: unknown,
  state: OpenCodeTurnState,
): { valid: boolean; reason?: string } {
  const message = asRecord(info);
  if (message?.role !== "assistant") {
    return { valid: false, reason: "not an assistant message" };
  }
  const id = typeof message.id === "string" ? message.id : undefined;
  if (!id) return { valid: false, reason: "missing id" };

  if (
    state.sessionId !== undefined &&
    message.sessionID !== undefined &&
    message.sessionID !== state.sessionId
  ) {
    return { valid: false, reason: "cross-session message mismatch" };
  }

  if (state.tombstones.has(id)) {
    return { valid: false, reason: "message tombstoned" };
  }

  const completed = asNumber(asRecord(message.time)?.completed);
  if (completed === undefined) {
    return { valid: false, reason: "not completed" };
  }

  if (message.error !== undefined) {
    return { valid: true };
  }

  if (message.finish !== "stop") {
    return {
      valid: false,
      reason: `unsupported finish: ${String(message.finish)}`,
    };
  }

  if (hasOutstandingTools(state)) {
    return { valid: false, reason: "outstanding tools in progress" };
  }

  if (!isMessageOwned(id, state)) {
    return { valid: false, reason: "missing or invalid ownership" };
  }

  return { valid: true };
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

function addField(
  base: number | undefined,
  step: number | undefined,
): number | undefined {
  if (step === undefined) return base;
  return (base ?? 0) + step;
}

function addUsage(base: StepUsage, step: StepUsage): StepUsage {
  const inputTokens = addField(base.inputTokens, step.inputTokens);
  const outputTokens = addField(base.outputTokens, step.outputTokens);
  const costUsd = addField(base.costUsd, step.costUsd);
  const cacheReadTokens = addField(base.cacheReadTokens, step.cacheReadTokens);
  const cacheWriteTokens = addField(
    base.cacheWriteTokens,
    step.cacheWriteTokens,
  );
  const reasoningTokens = addField(base.reasoningTokens, step.reasoningTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function mergeLeaf(
  existing: number | undefined,
  next: number | undefined,
): number | undefined {
  return existing !== undefined || next !== undefined
    ? Math.max(existing ?? 0, next ?? 0)
    : undefined;
}

function rememberUsage(
  state: OpenCodeTurnState,
  messageId: string,
  usage: StepUsage,
  completed = false,
): void {
  if (state.evictedUsageIds.has(messageId)) {
    state.usageCapped = true;
    state.usageIncomplete = true;
    return;
  }
  const existing = state.usage.get(messageId);
  const wasCompleted = state.completedUsage.has(messageId);
  if (completed) state.completedUsage.add(messageId);
  if (existing !== undefined) {
    const costConflict =
      existing.costUsd !== undefined &&
      usage.costUsd !== undefined &&
      (usage.costUsd < existing.costUsd ||
        (wasCompleted && usage.costUsd !== existing.costUsd));
    const tokenConflict =
      (existing.inputTokens !== undefined &&
        usage.inputTokens !== undefined &&
        (usage.inputTokens < existing.inputTokens ||
          (wasCompleted && usage.inputTokens !== existing.inputTokens))) ||
      (existing.outputTokens !== undefined &&
        usage.outputTokens !== undefined &&
        (usage.outputTokens < existing.outputTokens ||
          (wasCompleted && usage.outputTokens !== existing.outputTokens)));
    if (costConflict || tokenConflict) {
      state.usageConflict = true;
      state.usageIncomplete = true;
    }
    const mergedInput =
      existing.inputTokens !== undefined || usage.inputTokens !== undefined
        ? Math.max(existing.inputTokens ?? 0, usage.inputTokens ?? 0)
        : undefined;
    const mergedOutput =
      existing.outputTokens !== undefined || usage.outputTokens !== undefined
        ? Math.max(existing.outputTokens ?? 0, usage.outputTokens ?? 0)
        : undefined;
    const mergedCost =
      existing.costUsd !== undefined || usage.costUsd !== undefined
        ? Math.max(existing.costUsd ?? 0, usage.costUsd ?? 0)
        : undefined;
    // Cache and reasoning leaves merge like input/output (Math.max) but are
    // deliberately left out of the conflict check above: a snapshot that
    // momentarily reports fewer cache tokens must not flag the whole turn as
    // conflicting usage.
    const mergedCacheRead = mergeLeaf(
      existing.cacheReadTokens,
      usage.cacheReadTokens,
    );
    const mergedCacheWrite = mergeLeaf(
      existing.cacheWriteTokens,
      usage.cacheWriteTokens,
    );
    const mergedReasoning = mergeLeaf(
      existing.reasoningTokens,
      usage.reasoningTokens,
    );
    state.usage.set(messageId, {
      ...(mergedInput !== undefined ? { inputTokens: mergedInput } : {}),
      ...(mergedOutput !== undefined ? { outputTokens: mergedOutput } : {}),
      ...(mergedCost !== undefined ? { costUsd: mergedCost } : {}),
      ...(mergedCacheRead !== undefined
        ? { cacheReadTokens: mergedCacheRead }
        : {}),
      ...(mergedCacheWrite !== undefined
        ? { cacheWriteTokens: mergedCacheWrite }
        : {}),
      ...(mergedReasoning !== undefined
        ? { reasoningTokens: mergedReasoning }
        : {}),
    });
    return;
  }
  state.usage.set(messageId, usage);
  while (state.usage.size > MAX_TRACKED_MESSAGES) {
    const oldest = state.usage.keys().next();
    if (oldest.done === true) return;
    const evicted = state.usage.get(oldest.value);
    state.usage.delete(oldest.value);
    if (evicted !== undefined) {
      state.carriedUsage = addUsage(state.carriedUsage, evicted);
      rememberId(state.evictedUsageIds, oldest.value, MAX_TRACKED_MESSAGES);
      state.usageCapped = true;
      state.usageIncomplete = true;
    }
  }
}

function turnUsage(state: OpenCodeTurnState): StepUsage {
  let total = state.carriedUsage;
  for (const step of state.usage.values()) total = addUsage(total, step);
  return total;
}

function rememberId(set: Set<string>, id: string, cap: number): void {
  set.add(id);
  while (set.size > cap) {
    const oldest = set.values().next();
    if (oldest.done === true) return;
    set.delete(oldest.value);
  }
}

function handlePartUpdated(
  p: Record<string, unknown>,
  state: OpenCodeTurnState,
): OpenCodeClientEvent[] {
  const part = asRecord(p.part);
  if (!part) return [];
  const partId = typeof part.id === "string" ? part.id : undefined;
  const messageId =
    typeof part.messageID === "string" ? part.messageID : undefined;
  if (!partId || !messageId) return [];
  trackPart(state, part, messageId);

  if (state.tombstones.has(partId) || state.tombstones.has(messageId)) {
    return [];
  }

  // If message owner is unknown, buffer observation
  if (
    !state.messageDetails.has(messageId) &&
    !state.assistantMessages.has(messageId)
  ) {
    if (state.unknownOwnerBuffer.length >= MAX_UNKNOWN_OWNER_BUFFER) {
      state.integrityFailure =
        "[pr-hero] opencode client: unknown-owner buffer cap exceeded (cap exhaustion)";
      throw new Error(state.integrityFailure);
    }
    state.unknownOwnerBuffer.push({
      type: "part.updated",
      partId,
      messageId,
      raw: p,
    });
    return [];
  }

  if (!isMessageOwned(messageId, state)) return [];
  const msgDetail = state.messageDetails.get(messageId);
  if (msgDetail && !msgDetail.partIds.includes(partId)) {
    msgDetail.partIds.push(partId);
  }

  const partType = part.type;
  if (partType === "tool") {
    const toolState = asRecord(part.state);
    const status = toolState?.status as
      | "pending"
      | "running"
      | "completed"
      | "error"
      | undefined;
    const callId = typeof part.callID === "string" ? part.callID : partId;
    let transitioned = false;
    if (status) {
      if (
        !state.toolStates.has(callId) &&
        state.toolStates.size >= MAX_TRACKED_PARTS
      )
        failIntegrity(state, "tool identity cap exceeded");
      // `state.toolStates` still stores the raw reported status regardless
      // of rank — other logic (e.g. `hasOutstandingTools`) reads it and
      // must keep seeing the provider's literal last-known status, not a
      // rank-filtered one. Only whether `activity` is EMITTED changes below.
      state.toolStates.set(callId, status);
      // #228's review: credit is computed against `toolActivityRank`, a map
      // owned ONLY by this stream path — NEVER against `toolStates`, which
      // `reconcileMessages` (the poll readback) also writes unconditionally.
      // Three concurrent hunters sharing one server can have a poll round
      // observe a tool's "completed" before the stream ever delivers that
      // same tool's "pending"/"running". Comparing against `toolStates`
      // would then compare the stream's real "pending" against the rank the
      // POLL already advanced to "completed", crediting nothing for work
      // the stream is only now reporting.
      const previousRank = state.toolActivityRank.get(callId) ?? -1;
      const newRank = TOOL_STATUS_RANK[status];
      transitioned = newRank > previousRank;
      if (transitioned)
        remember(state.toolActivityRank, callId, newRank, MAX_TRACKED_PARTS);
    }
    if (msgDetail) msgDetail.hasToolCalls = true;
    // Ownership was already established above (the `isMessageOwned` check
    // before this switch), so a NOVEL status transition here is real
    // provider work — the tool actually moved pending -> running ->
    // completed/error. Re-observing the SAME status (a re-delivered or
    // redundant update) is not new work and earns nothing. Before this, tool
    // execution time counted as silence: this branch emitted no client
    // event at all, transition or not.
    const events: OpenCodeClientEvent[] = [];
    if (transitioned) {
      events.push({ kind: "activity" });
      // #214: count a LOOK, not an announcement. Gated on `transitioned` —
      // computed above off `toolActivityRank`, the STREAM-owned forward rank
      // — and deliberately NOT off `toolStates` (which `reconcileMessages`,
      // the poll readback, also writes unconditionally). Three concurrent
      // hunters sharing one server can have a poll round observe a tool's
      // "completed" before the stream ever delivers that same tool's
      // "pending"/"running"; reading `toolStates` here would let the poll's
      // race silently swallow the stream's own real "completed" transition
      // and undercount a hunter that plainly looked. "error" is excluded on
      // purpose: it produced no findable signal to reason from, and no test
      // has asked for an errored call to count as "looked".
    }
    // pr-hero review F001 (round 2): the completion TALLY is keyed by SET
    // MEMBERSHIP, never by `transitioned`/rank — deliberately a SEPARATE gate
    // from "activity" above. "error" and "completed" share TOOL_STATUS_RANK
    // (both terminal, neither outranks the other), so an error->completed
    // transition for the same callID leaves `transitioned` false; nesting
    // this tally inside `if (transitioned)` (the pre-fix shape) meant that
    // sequence was NEVER added to `completedToolCallIds` and never emitted
    // its `{kind:"tool"}` event at all — contradicting the set's own
    // contract ("every callID EVER observed completed") and silently
    // undercounting whenever the poll did not independently catch the same
    // call.
    if (status === "completed") {
      // Always recorded in the SHARED set, unconditionally — this is what
      // `pollStatus` reports if the POLL ends up winning the turn's terminal
      // instead of the stream, and it must reflect every completion
      // regardless of which observer saw it first.
      state.completedToolCallIds.add(callId);
      // pr-hero review F001 (round 3): emission is deduped against the
      // STREAM-OWNED set, never the shared one above — see that field's own
      // WHY comment on `OpenCodeTurnState`. Deduping against the shared set
      // let a non-stream reconcile that saw this exact callID complete FIRST
      // (prompt_result's own readback, a non-winning poll round) suppress
      // the stream's own emission, silently losing the count whenever the
      // stream — not the poll — went on to win the terminal. A REPEAT
      // "completed" this observer has already emitted for is still a
      // no-op, and the ownership guard above already confines this to the
      // turn's own tool calls.
      if (!state.streamCompletedToolCallIds.has(callId)) {
        const tool =
          typeof part.tool === "string" && part.tool.length > 0
            ? part.tool
            : "unknown";
        state.streamCompletedToolCallIds.add(callId);
        events.push({ kind: "tool", tool, callId });
      }
    }
    return events;
  }

  if (partType === "reasoning") {
    if (!isMessageOwned(messageId, state)) return [];
    const previous = state.partDetails.get(partId)?.text ?? "";
    const text = typeof part.text === "string" ? part.text : "";
    remember(state.parts, partId, "reasoning", MAX_TRACKED_PARTS);
    state.partDetails.set(partId, {
      id: partId,
      messageId,
      type: "reasoning",
      text: text.startsWith(previous) ? text : previous,
      emittedText: "",
    });
    // An owned cumulative snapshot proving advancement is useful, and so —
    // see `handlePartDelta`'s reasoning branch below — is a DELTA carrying a
    // provider event id not seen before: PR #227 threaded that id through,
    // which is exactly the replay identity this comment used to say a bare
    // delta marker lacked. An id-less delta still has none and stays a bare
    // marker there.
    return [
      {
        kind: "reasoning",
        progress: text.length > previous.length && text.startsWith(previous),
      },
    ];
  }

  if (msgDetail?.role === "user" || !state.assistantMessages.has(messageId)) {
    return [];
  }

  if (partType === "text") {
    const isSynthetic = part.synthetic === true;
    const isIgnored = part.ignored === true;
    const isIntermediateToolStep = msgDetail?.hasToolCalls === true;

    if (isSynthetic || isIgnored || isIntermediateToolStep) {
      return [];
    }

    remember(state.parts, partId, "answer", MAX_TRACKED_PARTS);

    let detail = state.partDetails.get(partId);
    if (!detail) {
      detail = {
        id: partId,
        messageId,
        type: "text",
        synthetic: isSynthetic,
        ignored: isIgnored,
        emittedText: "",
      };
      state.partDetails.set(partId, detail);
    }

    const snapshotText = typeof part.text === "string" ? part.text : undefined;
    if (snapshotText !== undefined && snapshotText.length > 0) {
      detail.text = snapshotText;
      const alreadyEmitted = detail.emittedText;
      if (alreadyEmitted === snapshotText) {
        return [];
      }
      if (alreadyEmitted.length === 0) {
        detail.emittedText = snapshotText;
        return [{ kind: "delta", text: snapshotText }];
      }
      if (snapshotText.startsWith(alreadyEmitted)) {
        const suffix = snapshotText.slice(alreadyEmitted.length);
        detail.emittedText = snapshotText;
        return [{ kind: "delta", text: suffix }];
      }
      state.integrityFailure = `[pr-hero] opencode client: conflicting snapshot observed for part ${partId}`;
      throw new Error(state.integrityFailure);
    }
  }

  return [];
}

function handlePartDelta(
  p: Record<string, unknown>,
  state: OpenCodeTurnState,
  eventId?: string,
): OpenCodeClientEvent[] {
  if (p.field !== "text") return [];
  const delta = p.delta;
  if (typeof delta !== "string" || delta.length === 0) return [];
  const partId = p.partID;
  if (typeof partId !== "string") return [];
  const messageId = typeof p.messageID === "string" ? p.messageID : undefined;
  if (messageId === undefined)
    failIntegrity(state, "delta missing message identity");
  trackPart(state, { ...p, id: partId }, messageId);

  if (
    state.tombstones.has(partId) ||
    (messageId && state.tombstones.has(messageId))
  ) {
    return [];
  }

  const kind = state.parts.get(partId);
  if (kind === "reasoning") {
    if (!messageId || !isMessageOwned(messageId, state)) return [];
    // #227 threaded the provider event id through this handler (the
    // `eventId` parameter), which is exactly the replay identity f842a8b
    // said a bare reasoning delta marker lacked ("bare delta markers have no
    // replay identity and cannot extend the deadline" — the old comment
    // here, and still true for an id-less delta). A delta whose id has not
    // been seen before is real, novel work the model did; the SAME id
    // redelivered (an SSE Last-Event-ID reconnect) is not. Unlike the answer
    // branch below, nothing is accumulated into any tracked text either way
    // — a redelivered id just falls back to the bare marker, never a
    // corrupted `emittedText` or a "conflicting snapshot" throw.
    if (eventId !== undefined && !state.reasoningDeltaEventIds.has(eventId)) {
      rememberId(
        state.reasoningDeltaEventIds,
        eventId,
        MAX_TRACKED_REASONING_DELTA_EVENTS,
      );
      return [{ kind: "reasoning", progress: true }];
    }
    return [{ kind: "reasoning" }];
  }
  if (kind === "answer") {
    if (!isMessageOwned(messageId, state)) return [];
    // Identity for dedup is the provider event id, not the delta's text.
    // The SDK's SSE client reconnects with `Last-Event-ID`
    // (serverSentEvents.gen.js) and can redeliver the same event verbatim,
    // but text is the wrong signal to detect that with: a prior version of
    // this check dropped any delta that merely repeated the tail already
    // emitted, which also matches a legitimately repeated token (e.g. "b"
    // after "b" in "a","b","b","c", or a second "}" closing nested JSON).
    // That either corrupted the delivered text (when no snapshot ever
    // arrived to reveal the gap) or threw "conflicting snapshot observed"
    // once one did. An event with no id — or a non-string one — carries no
    // identity to compare, so it is always treated as novel rather than
    // assumed a duplicate.
    if (eventId !== undefined && state.deltaEventIds.has(eventId)) {
      return [];
    }
    let detail = state.partDetails.get(partId);
    if (!detail) {
      detail = {
        id: partId,
        messageId,
        type: "text",
        emittedText: "",
      };
      state.partDetails.set(partId, detail);
    }
    if (
      Buffer.byteLength(delta, "utf8") > 64 * 1024 ||
      Buffer.byteLength(detail.emittedText + delta, "utf8") > 1024 * 1024
    )
      failIntegrity(state, "delta or answer byte limit exceeded");
    trackPayload(state, `retained:${partId}`, {
      text: detail.emittedText + delta,
    });
    detail.emittedText += delta;
    // Recorded only now that the delta is actually applied — never when
    // first buffered for an unknown owner — so a buffered delta that later
    // reconciles is not mistaken for its own duplicate.
    if (eventId !== undefined) {
      rememberId(state.deltaEventIds, eventId, MAX_TRACKED_DELTA_EVENTS);
    }
    return [{ kind: "delta", text: delta }];
  }

  if (
    messageId &&
    !state.messageDetails.has(messageId) &&
    !state.assistantMessages.has(messageId)
  ) {
    if (state.unknownOwnerBuffer.length >= MAX_UNKNOWN_OWNER_BUFFER) {
      state.integrityFailure =
        "[pr-hero] opencode client: unknown-owner buffer cap exceeded (cap exhaustion)";
      throw new Error(state.integrityFailure);
    }
    state.unknownOwnerBuffer.push({
      type: "part.delta",
      partId,
      messageId,
      raw: p,
      eventId,
    });
  }

  return [];
}

function reconcileUnknownOwnerBuffer(
  messageId: string,
  state: OpenCodeTurnState,
): OpenCodeClientEvent[] {
  const events: OpenCodeClientEvent[] = [];
  const remaining: UnknownOwnerObservation[] = [];
  for (const obs of state.unknownOwnerBuffer) {
    if (obs.messageId === messageId) {
      if (obs.type === "part.updated") {
        events.push(...handlePartUpdated(obs.raw, state));
      } else if (obs.type === "part.delta") {
        events.push(...handlePartDelta(obs.raw, state, obs.eventId));
      }
    } else {
      remaining.push(obs);
    }
  }
  state.unknownOwnerBuffer.length = 0;
  state.unknownOwnerBuffer.push(...remaining);
  return events;
}

export function reconcileMessages(
  list: unknown[],
  state: OpenCodeTurnState,
  // #223: `emit` gates ONLY the per-part "already delivered" bookkeeping
  // below (the loop that pushes `delta` events and advances
  // `detail.emittedText`). Every other effect of a call — trackMessage/
  // trackPart identity checks, usage, errors, `detail.text` snapshot storage
  // — always runs, because a caller that discards the returned `events` still
  // needs those ingested. Defaults to true so every existing caller (the poll
  // readback at pollStatus, and every direct test) keeps today's behaviour.
  options?: { readonly emit?: boolean },
): {
  events: OpenCodeClientEvent[];
  terminalProof?: ProviderTerminalProof;
  finalText?: string;
  usage?: StepUsage;
  usageIncomplete?: boolean;
  failure?: string;
} {
  const emit = options?.emit ?? true;
  if (
    list.length > MAX_TRACKED_MESSAGES ||
    state.messageDetails.size > MAX_TRACKED_MESSAGES
  ) {
    state.integrityFailure =
      "[pr-hero] opencode client: message cap exceeded (cap exhaustion)";
    return { events: [], failure: state.integrityFailure };
  }

  if (
    state.parts.size > MAX_TRACKED_PARTS ||
    state.partDetails.size > MAX_TRACKED_PARTS
  ) {
    state.integrityFailure =
      "[pr-hero] opencode client: maximum tracked parts exceeded";
    return { events: [], failure: state.integrityFailure };
  }

  try {
    if (Buffer.byteLength(JSON.stringify(list), "utf8") > MAX_READBACK_BYTES) {
      failIntegrity(state, "total readback byte budget exceeded");
    }
    const seenMessages = new Set<string>();
    const seenParts = new Set<string>();
    for (const item of list) {
      const rec = asRecord(item);
      const info = asRecord(rec?.info ?? item);
      if (!info) failIntegrity(state, "invalid readback message");
      trackMessage(state, info);
      if (seenMessages.has(String(info.id)))
        failIntegrity(state, "duplicate message in readback");
      seenMessages.add(String(info.id));
      if (info.role === "assistant" && !Array.isArray(rec?.parts)) {
        failIntegrity(state, "unknown readback parts coverage");
      }
      for (const value of Array.isArray(rec?.parts) ? rec.parts : []) {
        const part = asRecord(value);
        if (!part) failIntegrity(state, "invalid readback part");
        trackPart(state, part, String(info.id));
        if (seenParts.has(String(part.id)))
          failIntegrity(state, "duplicate part in readback");
        seenParts.add(String(part.id));
      }
    }
  } catch {
    return { events: [], failure: state.integrityFailure };
  }

  for (const item of list) {
    const itemRec = asRecord(item);
    const info = asRecord(itemRec?.info ?? item);
    if (!info) continue;
    const id = typeof info.id === "string" ? info.id : undefined;
    const role = info.role;
    if (!id) continue;

    if (role === "user") {
      if (!state.messageDetails.has(id)) {
        state.messageDetails.set(id, { id, role: "user", partIds: [] });
      }
    } else if (role === "assistant") {
      rememberId(state.assistantMessages, id, MAX_TRACKED_MESSAGES);
      const parentID =
        typeof info.parentID === "string" ? info.parentID : undefined;
      if (parentID) state.parentLinks.set(id, parentID);

      const finish = typeof info.finish === "string" ? info.finish : undefined;
      const isToolCalls = finish === "tool-calls" || finish === "tool_calls";
      const sessionID =
        typeof info.sessionID === "string"
          ? info.sessionID
          : typeof itemRec?.sessionID === "string"
            ? (itemRec.sessionID as string)
            : undefined;
      let msgDetail = state.messageDetails.get(id);
      if (!msgDetail) {
        msgDetail = {
          id,
          role: "assistant",
          sessionID,
          parentID,
          time: asRecord(info.time) as
            | { created?: number; completed?: number }
            | undefined,
          finish,
          error: info.error,
          hasToolCalls: isToolCalls,
          partIds: [],
        };
        state.messageDetails.set(id, msgDetail);
      } else {
        msgDetail.sessionID = sessionID ?? msgDetail.sessionID;
        msgDetail.parentID = parentID ?? msgDetail.parentID;
        msgDetail.finish = finish ?? msgDetail.finish;
        msgDetail.error = info.error ?? msgDetail.error;
        msgDetail.time =
          (asRecord(info.time) as
            | { created?: number; completed?: number }
            | undefined) ?? msgDetail.time;
        if (isToolCalls) msgDetail.hasToolCalls = true;
      }

      if (!isMessageOwned(id, state)) continue;
      const tokens = asRecord(info.tokens);
      const inputTokens = asNumber(tokens?.input);
      const outputTokens = asNumber(tokens?.output);
      const costUsd = asNumber(info.cost);
      const cacheReadTokens = asNumber(asRecord(tokens?.cache)?.read);
      const cacheWriteTokens = asNumber(asRecord(tokens?.cache)?.write);
      const reasoningTokens = asNumber(tokens?.reasoning);
      if (
        inputTokens !== undefined ||
        outputTokens !== undefined ||
        costUsd !== undefined ||
        cacheReadTokens !== undefined ||
        cacheWriteTokens !== undefined ||
        reasoningTokens !== undefined
      ) {
        rememberUsage(
          state,
          id,
          {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
            ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
          },
          asNumber(asRecord(info.time)?.completed) !== undefined,
        );
      }

      const parts = Array.isArray(itemRec?.parts)
        ? (itemRec?.parts as unknown[])
        : Array.isArray(info.content)
          ? (info.content as unknown[])
          : [];
      const readbackPartIds: string[] = [];
      for (const p of parts) {
        const part = asRecord(p);
        if (!part) continue;
        const partId = typeof part.id === "string" ? part.id : undefined;
        if (!partId) continue;
        if (!readbackPartIds.includes(partId)) readbackPartIds.push(partId);

        const partType = part.type;
        if (partType === "tool") {
          const toolState = asRecord(part.state);
          const status = toolState?.status as
            | "pending"
            | "running"
            | "completed"
            | "error"
            | undefined;
          const callId = typeof part.callID === "string" ? part.callID : partId;
          if (status) {
            if (
              !state.toolStates.has(callId) &&
              state.toolStates.size >= MAX_TRACKED_PARTS
            )
              failIntegrity(state, "tool identity cap exceeded");
            state.toolStates.set(callId, status);
            // pr-hero review F001: recorded in the monotonic set the moment
            // THIS readback sees "completed" — never removed by a later
            // readback that reports a different status for the same callID.
            // See the field's own WHY comment on `OpenCodeTurnState`.
            if (status === "completed") {
              state.completedToolCallIds.add(callId);
            }
          }
          msgDetail.hasToolCalls = true;
          // #214: this write feeds `hasOutstandingTools` (so a message the
          // poll alone has seen is not declared final while a tool is still
          // pending/running) AND, on a poll-won terminal, `pollStatus` reports
          // `completedToolCallIds`'s members as `OpenCodePollResult
          // .completedToolCallIds` — see the WHY comment there. This call
          // site stays `emit: false` (no `{kind:"tool"}` event rides through
          // here; the stream is still the only event-emitting observer), but
          // a completion this observer is the FIRST to see is no longer
          // silently uncounted: opencode-sdk.ts unions this poll-reported set
          // with its own stream-observed callIDs by identity at settlement.
        } else if (partType === "reasoning") {
          if (
            !state.parts.has(partId) &&
            state.parts.size >= MAX_TRACKED_PARTS
          ) {
            state.integrityFailure =
              "[pr-hero] opencode client: maximum tracked parts exceeded";
            return { events: [], failure: state.integrityFailure };
          }
          state.parts.set(partId, "reasoning");
        } else if (partType === "text") {
          const isSynthetic = part.synthetic === true;
          const isIgnored = part.ignored === true;
          if (!isSynthetic && !isIgnored && !msgDetail.hasToolCalls) {
            if (
              !state.parts.has(partId) &&
              state.parts.size >= MAX_TRACKED_PARTS
            ) {
              state.integrityFailure =
                "[pr-hero] opencode client: maximum tracked parts exceeded";
              return { events: [], failure: state.integrityFailure };
            }
            state.parts.set(partId, "answer");
            let detail = state.partDetails.get(partId);
            if (!detail) {
              if (state.partDetails.size >= MAX_TRACKED_PARTS) {
                state.integrityFailure =
                  "[pr-hero] opencode client: maximum tracked parts exceeded";
                return { events: [], failure: state.integrityFailure };
              }
              detail = {
                id: partId,
                messageId: id,
                type: "text",
                emittedText: "",
              };
              state.partDetails.set(partId, detail);
            }
            if (typeof part.text === "string") {
              detail.text = part.text;
            }
          }
        }
      }
      if (Array.isArray(itemRec?.parts) || Array.isArray(info.content)) {
        msgDetail.partIds = readbackPartIds;
      }
    }
  }

  if (
    state.parts.size > MAX_TRACKED_PARTS ||
    state.partDetails.size > MAX_TRACKED_PARTS
  ) {
    state.integrityFailure =
      "[pr-hero] opencode client: maximum tracked parts exceeded";
    return { events: [], failure: state.integrityFailure };
  }

  // Check missing usage across all completed assistant steps
  for (const msg of state.messageDetails.values()) {
    if (msg.role === "assistant" && isMessageOwned(msg.id, state)) {
      const stepUsage = state.usage.get(msg.id);
      if (
        msg.time?.completed === undefined ||
        stepUsage === undefined ||
        stepUsage.costUsd === undefined ||
        stepUsage.inputTokens === undefined ||
        stepUsage.outputTokens === undefined
      ) {
        state.usageIncomplete = true;
      }
    }
  }

  const candidateIds: string[] = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const itemRec = asRecord(list[i]);
    const info = asRecord(itemRec?.info ?? list[i]);
    if (info?.role === "assistant" && typeof info.id === "string") {
      candidateIds.push(info.id);
    }
  }
  if (candidateIds.length === 0) {
    const allIds = Array.from(state.assistantMessages);
    for (let i = allIds.length - 1; i >= 0; i -= 1) {
      candidateIds.push(allIds[i]);
    }
  }

  for (const id of candidateIds) {
    const msgDetail = state.messageDetails.get(id);
    if (!msgDetail) continue;

    if (msgDetail.error !== undefined) {
      const proof = terminalProofFromAssistant(msgDetail, state);
      if (proof) return { events: [], terminalProof: proof, finalText: "" };
    }

    const evalRes = evaluateFinalAssistant(msgDetail, state);
    if (!evalRes.valid) continue;

    const proof = terminalProofFromAssistant(msgDetail, state);
    if (proof === undefined) continue;

    const events: OpenCodeClientEvent[] = [];
    let canonicalFinalText = "";
    for (const partId of msgDetail.partIds) {
      const detail = state.partDetails.get(partId);
      if (
        detail &&
        detail.type === "text" &&
        !detail.synthetic &&
        !detail.ignored
      ) {
        canonicalFinalText += detail.text ?? detail.emittedText ?? "";
      }
    }

    // #223: this is the ONLY place in this function that advances
    // `detail.emittedText` or produces a `delta` event, so it is exactly what
    // `emit: false` must skip. Skipping it here rather than filtering the
    // caller's returned `events` afterward keeps the invariant literal:
    // `emittedText` cannot advance except in the same branch that hands a
    // delta to the consumer, so a discard-only caller can never leave the
    // "already delivered" bookkeeping ahead of what was actually delivered.
    for (const partId of emit ? msgDetail.partIds : []) {
      const detail = state.partDetails.get(partId);
      if (
        detail &&
        detail.type === "text" &&
        !detail.synthetic &&
        !detail.ignored
      ) {
        const snapshotText = detail.text ?? "";
        const alreadyEmitted = detail.emittedText;
        if (alreadyEmitted === snapshotText) {
          continue;
        }
        if (alreadyEmitted.length === 0) {
          detail.emittedText = snapshotText;
          events.push({ kind: "delta", text: snapshotText });
        } else if (snapshotText.startsWith(alreadyEmitted)) {
          const suffix = snapshotText.slice(alreadyEmitted.length);
          detail.emittedText = snapshotText;
          events.push({ kind: "delta", text: suffix });
        } else {
          state.integrityFailure = `[pr-hero] opencode client: conflicting snapshot in readback for part ${partId}`;
          return {
            events: [],
            failure: state.integrityFailure,
          };
        }
      }
    }

    const totalUsage = turnUsage(state);
    const isIncomplete =
      state.usageIncomplete === true ||
      state.usageConflict === true ||
      state.usageCapped === true;

    return {
      events,
      terminalProof: proof,
      finalText: canonicalFinalText,
      usage: totalUsage,
      usageIncomplete: isIncomplete,
    };
  }

  return { events: [] };
}

export const reconcilePartsAndDelivery = reconcileMessages;

export function mapOpenCodeEvents(
  raw: unknown,
  sessionId: string,
  state: OpenCodeTurnState,
): OpenCodeClientEvent[] {
  if (state.integrityFailure !== undefined) {
    throw new Error(state.integrityFailure);
  }

  const type = (raw as RawEvent)?.type;
  if (typeof type !== "string") return [];
  const p = props(raw);
  if (p === undefined) return [];

  if (p.sessionID !== sessionId) return [];

  switch (type) {
    case "message.removed": {
      const messageId = p.messageID;
      if (typeof messageId === "string") {
        if (
          !state.tombstones.has(messageId) &&
          state.tombstones.size >= MAX_TOMBSTONES
        )
          failIntegrity(state, "tombstone cap exceeded");
        rememberId(state.tombstones, messageId, MAX_TOMBSTONES);
        if (
          messageId === state.currentUserId ||
          (state.lastProof && state.lastProof.eventId === messageId)
        ) {
          state.integrityFailure = `[pr-hero] opencode client: required message removed: ${messageId}`;
          throw new Error(state.integrityFailure);
        }
      }
      return [];
    }

    case "message.part.removed": {
      const partId = p.partID;
      if (typeof partId === "string") {
        if (
          !state.tombstones.has(partId) &&
          state.tombstones.size >= MAX_TOMBSTONES
        )
          failIntegrity(state, "tombstone cap exceeded");
        rememberId(state.tombstones, partId, MAX_TOMBSTONES);
        const detail = state.partDetails.get(partId);
        if (
          detail &&
          detail.type === "text" &&
          (detail.emittedText.length > 0 ||
            (detail.text && detail.text.length > 0))
        ) {
          state.integrityFailure = `[pr-hero] opencode client: required part removed: ${partId}`;
          throw new Error(state.integrityFailure);
        }
      }
      return [];
    }

    case "message.part.delta": {
      const rawId = (raw as RawEvent)?.id;
      const eventId = typeof rawId === "string" ? rawId : undefined;
      return handlePartDelta(p, state, eventId);
    }

    case "message.part.updated": {
      return handlePartUpdated(p, state);
    }

    case "message.updated": {
      const info = asRecord(p.info);
      if (info === undefined) return [];
      const id = typeof info.id === "string" ? info.id : undefined;
      if (!id) return [];
      trackMessage(state, info);

      const role = info.role;

      if (role === "user") {
        state.messageDetails.set(id, { id, role: "user", partIds: [] });
        return [];
      }

      if (role !== "assistant") return [];

      rememberId(state.assistantMessages, id, MAX_TRACKED_MESSAGES);
      const parentID =
        typeof info.parentID === "string" ? info.parentID : undefined;
      if (parentID) state.parentLinks.set(id, parentID);

      const finish = typeof info.finish === "string" ? info.finish : undefined;
      const isToolCalls = finish === "tool-calls" || finish === "tool_calls";
      const sessionID =
        typeof info.sessionID === "string"
          ? info.sessionID
          : typeof p.sessionID === "string"
            ? (p.sessionID as string)
            : undefined;
      let msgDetail = state.messageDetails.get(id);
      if (!msgDetail) {
        msgDetail = {
          id,
          role: "assistant",
          sessionID,
          parentID,
          time: asRecord(info.time) as
            | { created?: number; completed?: number }
            | undefined,
          finish,
          error: info.error,
          hasToolCalls: isToolCalls,
          partIds: [],
        };
        state.messageDetails.set(id, msgDetail);
      } else {
        msgDetail.sessionID = sessionID ?? msgDetail.sessionID;
        msgDetail.parentID = parentID ?? msgDetail.parentID;
        msgDetail.finish = finish ?? msgDetail.finish;
        msgDetail.error = info.error ?? msgDetail.error;
        msgDetail.time =
          (asRecord(info.time) as
            | { created?: number; completed?: number }
            | undefined) ?? msgDetail.time;
        if (isToolCalls) msgDetail.hasToolCalls = true;
      }

      if (!isMessageOwned(id, state)) return [];
      const out: OpenCodeClientEvent[] = [];
      out.push(...reconcileUnknownOwnerBuffer(id, state));

      const tokens = asRecord(info.tokens);
      const inputTokens = asNumber(tokens?.input);
      const outputTokens = asNumber(tokens?.output);
      const costUsd = asNumber(info.cost);
      const cacheReadTokens = asNumber(asRecord(tokens?.cache)?.read);
      const cacheWriteTokens = asNumber(asRecord(tokens?.cache)?.write);
      const reasoningTokens = asNumber(tokens?.reasoning);
      if (
        inputTokens !== undefined ||
        outputTokens !== undefined ||
        costUsd !== undefined ||
        cacheReadTokens !== undefined ||
        cacheWriteTokens !== undefined ||
        reasoningTokens !== undefined
      ) {
        rememberUsage(
          state,
          id,
          {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
            ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
          },
          asNumber(asRecord(info.time)?.completed) !== undefined,
        );
        out.push({
          kind: "usage",
          id,
          mode: "snapshot",
          ...(state.usageCapped || state.usageConflict || state.usageIncomplete
            ? { incomplete: true }
            : {}),
          ...turnUsage(state),
        });
      }

      const proof = terminalProofFromAssistant(info, state);
      if (proof !== undefined) state.lastProof = proof;
      return out;
    }

    case "session.idle": {
      if (state.boundaryReported) return [];
      if (state.integrityFailure !== undefined) {
        throw new Error(state.integrityFailure);
      }
      if (hasOutstandingTools(state)) return [];

      const proof = state.lastProof;
      if (proof === undefined) return [];
      if (state.tombstones.has(proof.eventId)) {
        state.integrityFailure = `[pr-hero] opencode client: terminal message was tombstoned: ${proof.eventId}`;
        throw new Error(state.integrityFailure);
      }
      state.boundaryReported = true;

      const out: OpenCodeClientEvent[] = [];
      const msgDetail = state.messageDetails.get(proof.eventId);
      if (msgDetail) {
        for (const partId of msgDetail.partIds) {
          if (state.tombstones.has(partId)) {
            state.integrityFailure = `[pr-hero] opencode client: required part was tombstoned: ${partId}`;
            throw new Error(state.integrityFailure);
          }
          const detail = state.partDetails.get(partId);
          if (
            detail &&
            detail.type === "text" &&
            !detail.synthetic &&
            !detail.ignored
          ) {
            const snapshotText = detail.text ?? "";
            if (snapshotText.length > 0) {
              if (detail.emittedText.length === 0) {
                detail.emittedText = snapshotText;
                out.push({ kind: "delta", text: snapshotText });
              } else if (snapshotText.startsWith(detail.emittedText)) {
                const diff = snapshotText.slice(detail.emittedText.length);
                if (diff.length > 0) {
                  detail.emittedText = snapshotText;
                  out.push({ kind: "delta", text: diff });
                }
              } else {
                state.integrityFailure = `[pr-hero] opencode client: conflicting snapshot observed for part ${partId}`;
                throw new Error(state.integrityFailure);
              }
            }
          }
        }
      }

      out.push({ kind: "terminal", proof });
      return out;
    }

    case "session.status": {
      const status = asRecord(p.status);
      // #157: checked BEFORE the busy/heartbeat arm below — a retry status
      // naming an account/usage limit is not "still working", it is a fact
      // that ends the attempt. Reached only for THIS session: the shared
      // `p.sessionID !== sessionId` guard above already returned [] for
      // every other one.
      const limit = providerLimitFromStatus(status);
      if (limit !== undefined) {
        return [
          {
            kind: "provider_limit",
            reason: limit.reason,
            message: limit.message,
          },
        ];
      }
      return status?.type === "busy" ? [{ kind: "heartbeat" }] : [];
    }

    // #213. The subscribed bus names this `session.error` (SDK
    // EventSessionError, properties.error = APIError). `opencode run
    // --format json` prints the same refusal as `type: "error"`. Neither
    // had an arm, so the event became [] , the turn completed empty, and
    // the harness filed format_violation. The sessionID guard above already
    // dropped every other session's refusal.
    case "session.error":
    case "error": {
      const refusal = providerRefusalFromProperties(p);
      if (refusal === undefined) return [];
      return [{ kind: "provider_refusal", ...refusal }];
    }

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// The impure half: an OpenCodeClientLike over the real SDK.
//
// Everything the SDK touches is behind `OpenCodeSdkLike` and reached through
// an injectable loader. pr-hero ships with ZERO runtime dependencies, so the
// SDK is an OPTIONAL PEER: a Claude-only install must never pull it, and an
// install that does route here must be told what to add rather than handed a
// module-resolution stack trace.
// ---------------------------------------------------------------------------

// BOTH arms of the SDK's `RequestResult`. With its default
// `ThrowOnError = false` every session call resolves to either
// `{ data, error: undefined }` or `{ data: undefined, error }` — an API error
// is a RESOLVED promise, not a rejected one. The first version of this
// interface declared only the success arm, so a rejected model or a bad body
// reached `.data.id` with `data` undefined and became a TypeError carrying
// none of the provider's diagnosis (issue #121).
//
// Modelled as a union rather than collapsed with `throwOnError: true`
// deliberately: the collapse is a per-call TYPE inference on the SDK's own
// generic signatures, and it cannot travel through a narrow non-generic
// interface like this one — the declared return type governs at every call
// site here. The union is the shape the transport must actually survive.
export type OpenCodeSdkResult<T> =
  | { readonly data: T; readonly error?: undefined }
  | { readonly data?: undefined; readonly error: unknown };

// Deliberately narrow: the transport needs five methods, not the SDK's
// twenty namespaces. test/conformance/opencode-sdk-surface.test.ts asserts at
// COMPILE TIME that the real `OpencodeClient` is assignable to this, so the
// narrowing can never drift back into a guess. Members are method shorthand,
// not properties, on purpose — property-style function types are checked
// contravariantly under `strict` and would reject the real client's generic
// signatures for a reason that has nothing to do with conformance.
export interface OpenCodeSdkPromptParameters {
  readonly sessionID: string;
  readonly directory?: string;
  readonly workspace?: string;
  readonly messageID?: string;
  readonly model?: {
    readonly providerID: string;
    readonly modelID: string;
  };
  readonly agent?: string;
  readonly noReply?: boolean;
  readonly tools?: Readonly<Record<string, boolean>>;
  readonly format?: unknown;
  readonly system?: string;
  readonly variant?: string;
  readonly parts?: readonly unknown[];
  readonly [key: string]: unknown;
}

// Deliberately narrow: the transport needs five methods, not the SDK's
// twenty namespaces. test/conformance/opencode-sdk-surface.test.ts asserts at
// COMPILE TIME that the real `OpencodeClient` from /v2 is assignable to this,
// so the narrowing can never drift back into a guess. Members are method shorthand,
// not properties, on purpose — property-style function types are checked
// contravariantly under `strict` and would reject the real client's generic
// signatures for a reason that has nothing to do with conformance.
export interface OpenCodeSdkClientApi {
  readonly session: {
    create(
      options?: unknown,
      request?: { signal?: AbortSignal },
    ): Promise<OpenCodeSdkResult<{ id: string; directory?: string }>>;
    prompt(
      parameters: OpenCodeSdkPromptParameters,
      request?: { signal?: AbortSignal },
    ): Promise<OpenCodeSdkResult<unknown>>;
    messages(
      options: unknown,
      request?: { signal?: AbortSignal },
    ): Promise<OpenCodeSdkResult<unknown>>;
    // `GET /session/status` — the POLL observer's turn boundary (#127), and a
    // different endpoint from session.messages(), which is the point: §197
    // wants two INDEPENDENT observers, not two pipes onto one fact. REQUIRED,
    // never optional, for the same reason `tool.ids` is: an optional member
    // lets a fake skip the surface silently, which is the shape of issue #121.
    status(
      options?: unknown,
      request?: { signal?: AbortSignal },
    ): Promise<OpenCodeSdkResult<unknown>>;
    abort(
      options?: unknown,
      request?: { signal?: AbortSignal },
    ): Promise<OpenCodeSdkResult<unknown>>;
  };
  readonly event: {
    // `parameters`, not `options`: the SDK's first argument is the parameters
    // slot (`{directory?, workspace?}`); request options are its SECOND. The
    // old name invited `subscribe({ signal })`, and the call site did exactly
    // that — buildClientParams drops unknown keys, so the signal vanished and
    // no directory was ever sent. Only the first argument is declared because
    // it is the only one the call site passes.
    subscribe(
      parameters?: unknown,
    ): Promise<{ stream: AsyncIterable<unknown> }>;
  };
  // `GET /experimental/tool/ids` — "List all tool IDs (including built-in and
  // dynamically registered)". REQUIRED, never optional: an optional member
  // lets a fake skip the surface silently, which is the shape of issue #121.
  // The endpoint is experimental-prefixed, so pinning it here (and in the
  // surface conformance test) is what keeps a rename from going unnoticed.
  readonly tool: {
    ids(
      options?: unknown,
      request?: { signal?: AbortSignal },
    ): Promise<OpenCodeSdkResult<readonly string[]>>;
  };
  // `GET /mcp` — the §E readback's endpoint, and the only place a connected
  // MCP server is visible at all: it contributes nothing to `tool.ids` or
  // `tool.list` (measured, #141 fact 3). REQUIRED, never optional, for the
  // same reason as the two above — an optional member lets a fake skip the
  // surface silently, which is the shape of issue #121, and a skipped readback
  // is an unverified tool channel rather than a missing convenience.
  readonly mcp: {
    status(
      options?: unknown,
      request?: { signal?: AbortSignal },
    ): Promise<OpenCodeSdkResult<unknown>>;
  };
  // `POST /permission/{requestID}/reply` — the ONLY way to unblock a pending
  // OpenCode permission prompt (#157: `permission.asked` for
  // `external_directory` blocked a tool call for the whole usefulProgressMs
  // budget, since pr-hero has no UI to answer one and the server-side `deny`
  // config cannot cover every future permission kind). REQUIRED, never
  // optional, for the same reason as tool.ids/mcp.status above: an optional
  // member lets a fake skip the surface silently, which is the shape of
  // issue #121, and a skipped reply here is a hung tool call with no
  // evidence anything was ever attempted.
  readonly permission: {
    reply(
      parameters: {
        requestID: string;
        directory?: string;
        workspace?: string;
        reply?: "once" | "always" | "reject";
        message?: string;
      },
      request?: { signal?: AbortSignal },
    ): Promise<OpenCodeSdkResult<unknown>>;
  };
}

export interface OpenCodeSdkLike {
  // `createOpencodeClient`, and the name is the whole of issue #121: this
  // interface used to declare `createClient`, which the SDK has never
  // exported. Nothing compared the two, so every live OpenCode step died on
  // `sdk.createClient is not a function` while the offline suite stayed green
  // — every mock was shaped to the same guess.
  createOpencodeClient(config: {
    baseUrl: string;
    directory?: string;
    experimental_workspaceID?: string;
    [key: string]: unknown;
  }): OpenCodeSdkClientApi;
}

// The runtime half of the conformance check. `import type` is erased, so it
// cannot guard the DYNAMIC import the transport registry performs; the loaded
// module is therefore validated instead of asserted. This replaces two
// `as unknown as OpenCodeSdkLike` casts — the strongest assertion TypeScript
// has, pointed at a hand-written guess, which is precisely why the guess was
// never caught.
export function assertOpenCodeSdk(module: unknown): OpenCodeSdkLike {
  const candidate = module as Partial<OpenCodeSdkLike> | null | undefined;
  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate.createOpencodeClient !== "function"
  ) {
    throw new Error(
      "@opencode-ai/sdk/v2/client resolved but does not export createOpencodeClient(), " +
        "which pr-hero needs to open a session. The installed package is not " +
        `the SDK this transport was built against (got ${describeModule(module)}).`,
    );
  }
  return candidate as OpenCodeSdkLike;
}

function describeModule(module: unknown): string {
  if (typeof module !== "object" || module === null) return typeof module;
  const keys = Object.keys(module).sort();
  return keys.length === 0 ? "an object with no exports" : keys.join(", ");
}

// Every `.data` read in this file goes through here. The alternative — reading
// `.data` and trusting it — is the defect.
function unwrap<T>(result: OpenCodeSdkResult<T>, call: string): T {
  const data = result.data;
  if (result.error !== undefined || data === undefined) {
    throw new Error(
      `opencode ${call} failed: ${describeSdkError(result.error)}`,
    );
  }
  return data;
}

function describeSdkError(error: unknown): string {
  if (error === undefined) return "the provider returned no data and no error";
  if (typeof error === "string") return error;
  const message = asRecord(error)?.message;
  if (typeof message === "string" && message.length > 0) return message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export interface CreateOpenCodeClientOptions {
  readonly loadSdk: () => Promise<OpenCodeSdkLike>;
  /** Injected only for deterministic protocol fixtures; production IDs match ^msg. */
  readonly createMessageId?: () => string;
  readonly observedIdentity?: {
    sdkVersion: string;
    serverVersion: string;
    executableSha256: string;
  };
  readonly fetch?: typeof fetch;
  /** Production factory requires actual serving identity and pinned /doc proof. */
  readonly qualifyServer?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  // #141: the run's MCP registry travels INTO the launch. OpenCode reads it
  // from the environment at startup, so a server already running cannot be
  // given one without leaving a window between "server up" and "MCP
  // connected" for a prompt to fall into (the #128 race class).
  //
  // The free-tier gateway fix (see FREE_TIER_GATEWAY_TOOLS below) travels the
  // same way, for the same reason: OpenCode reads its permission config from
  // the same startup env, so it has to reach the launch, not a later call.
  readonly launchServer: (
    mcp?: OpenCodeMcpConfig,
    freeTierGatewayAsk?: readonly string[],
  ) => Promise<OpenCodeServerHandle>;
  // The credential kind this client's route was bound to. Optional so every
  // existing caller (every test, and any non-opencode-free route) keeps
  // today's behavior unchanged; only `createSession` reads it, and only to
  // gate FREE_TIER_GATEWAY_TOOLS below.
  readonly credentialKind?: CredentialKind;
  readonly model: {
    readonly providerID: string;
    readonly modelID: string;
    readonly variant?: string;
  };
  readonly variant?: string;
  readonly readSystemPrompt: (promptPath: string) => Promise<string>;
  // #141: reads the Claude-shaped mcp.json named by the request. Optional only
  // because a request may carry no registry at all; a request that DOES carry
  // one and finds no reader here aborts rather than running without MCP, which
  // is the silent degradation this issue is about.
  readonly readMcpConfig?: (configPath: string) => Promise<string>;
  // Absolute, resolved by the caller (transport-registry.ts). The client never
  // looks a binary up: resolution is a PATH question, and this module has no
  // business answering one — the same rule opencode-server.ts states for the
  // opencode binary itself.
  readonly codegraphBinaryPath?: string;
  // §6 deny floor: tools that stay false unless the spec names them. Absent is
  // NOT the same as false — an absent key asks for the provider's default, and
  // the provider's default is not ours to inherit.
  readonly denyFloor?: readonly string[];
}

const DEFAULT_DENY_FLOOR = ["bash"] as const;

// Free-tier gateway fix (2026-09-26). OpenCode's free catalogue (provider
// `opencode`, e.g. `opencode/muse-spark-1.3-contributor-free`) started
// refusing every turn with `APIError status=403: ... "OpenCode's free tier
// can only be used from within OpenCode"` whenever the tools map it receives
// denies `bash` or `read` outright. Measured live against opencode 1.18.30
// (`opencode serve --pure` + the real SDK, $0):
//   tools: {}                          -> OK
//   tools: {"bash": false}             -> 403
//   tools: {"read": false}             -> 403
//   any OTHER single tool set false    -> OK
//   permission.bash: "deny", no tools  -> 403 (OpenCode drops a denied tool
//                                        from the reported surface — same
//                                        effect on the model as sending it
//                                        false)
//   permission.bash: "ask"             -> OK
//   permission.bash/read both "ask"    -> OK
// This worked on 2026-09-07 with the same pr-hero code, so the change is
// provider-side policy, not a regression here.
//
// These are the ONLY two ids this applies to — they are exactly the ids the
// gateway's heuristic keys on, not "every tool" and not a general relaxation.
// A `provider_free` route (see `credentialKind` above) omits a denied id here
// from the tools map instead of writing it `false` (see the loop right after
// `resolveToolMap`'s own map below), and gets OpenCode permission `"ask"` for
// it in the server's config instead (opencode-server.ts's `launchOpenCodeServer`
// — see the WHY there for how isolation is preserved without the tools-map
// denial). Every other route is unaffected: this constant is read nowhere
// unless `credentialKind === "provider_free"`.
export const FREE_TIER_GATEWAY_TOOLS = ["bash", "read"] as const;

// The engine's canonical tool names are Claude Code's namespace
// (`BINDING_ALLOWED_TOOLS`, and the `tools:` line of every bundled prompt).
// They stay that way: the gate is backend-neutral and the prompt set is shared
// across backends, so the translation into a provider's vocabulary belongs
// HERE and nowhere else.
//
// Issue #122: this table did not exist, and the canonical names were written
// into the prompt's `tools` map verbatim. That map is an OPEN
// `{[key: string]: boolean}`, so OpenCode accepted "Read"/"Grep"/"Glob"/
// "mcp__codegraph__codegraph_explore" and silently ignored all four — no
// error, no warning, nothing in the response. The allowlist allowed nothing
// and the denylist denied only "bash", which landed by pure naming
// coincidence.
//
// #141: `mcp__codegraph__codegraph_explore` used to be absent from this table,
// on the grounds that it mapped onto no OpenCode built-in and that dropping it
// was parity with a codegraph-less repo. That was true of the TABLE and false
// of the ROUTE: `mcpConfigPath` was threaded all the way into createSession
// and then applied to nothing, so every OpenCode hunter ran without codegraph
// even on an indexed repo — a silent capability gap between the two backends,
// invisible in any artifact because the map recorded only ids the provider
// reported.
//
// The id is OpenCode's `<server>_<tool>` normalisation of the codegraph
// server's single tool, and it is MEASURED rather than derived (#141 fact 4):
// with this key written false the model answered REFUSED and no tool call
// appeared in the stream. Parity for the codegraph-less case is unchanged and
// now explicit — an empty registry leaves the key written FALSE rather than
// absent.
const CANONICAL_TO_OPENCODE_TOOL: Readonly<Record<string, string>> = {
  Read: "read",
  Grep: "grep",
  Glob: "glob",
  mcp__codegraph__codegraph_explore: "codegraph_codegraph_explore",
};

const MCP_TOOL_ID_SET: ReadonlySet<string> = new Set(ALL_MCP_TOOL_IDS);

// Which of `freeTierGatewayTools` (empty unless credentialKind is
// "provider_free" — see FREE_TIER_GATEWAY_TOOLS above) this session's own
// canonical grant list does NOT cover. Deliberately independent of the
// provider's reported tool surface: `createSession` needs this answer BEFORE
// the server even exists, to launch it with the right permission config
// (§128's surface enumeration only happens after create+subscribe, which
// needs a server), so it reads grants the same way resolveToolMap's own allow
// loop does below — via CANONICAL_TO_OPENCODE_TOOL — rather than waiting on
// `tool.ids()`. "bash" has no entry in that table at all (no AgentSpec has
// ever granted it), so it is unconditionally denied whenever this is called
// with a non-empty gate; "read" is denied exactly when this call's canonical
// tools omit "Read" (a tool-less step: summarizer, scout).
function deniedFreeTierGatewayTools(
  canonicalTools: readonly string[],
  freeTierGatewayTools: readonly string[],
): readonly string[] {
  const grantedIds = new Set(
    canonicalTools
      .map((tool) => CANONICAL_TO_OPENCODE_TOOL[tool])
      .filter((id): id is string => id !== undefined),
  );
  return freeTierGatewayTools.filter((tool) => !grantedIds.has(tool));
}

// Fail-closed launch-seam guard. The tools-map deletion loop further down
// (search FREE_TIER_GATEWAY_TOOLS) is safe ONLY on the assumption that the
// server behind `handle` was launched with `deniedGatewayTools` set to
// OpenCode permission "ask" — that is the ONLY thing standing between a
// deleted `bash: false` and bash running under OpenCode's default
// permission. `launchServer` is caller-injectable
// (`CreateOpenCodeClientOptions.launchServer` / `TransportFactoryOptions.
// launchServer`), so that assumption is a claim about an ARGUMENT, not a
// fact about this module — a launcher that silently ignores its second
// parameter (or was never updated to honour it) would make it false with no
// visible symptom until a live gateway 403, or worse, a bash call that
// should have been denied actually running.
//
// Verified, not trusted: `handle.gatewayAsk` is the launcher's OWN
// attestation of what it wrote, and this compares it against exactly what
// this call asked to have gated — sorted, so key order never causes a
// false mismatch. Gated on a non-empty ask: a route that asks for nothing
// (every non-`provider_free` route) needs no attestation, and passes
// regardless of what a handle does or does not attest.
function gatewayAskAttestationError(
  deniedGatewayTools: readonly string[],
  attestedGatewayAsk: readonly string[] | undefined,
): string | undefined {
  if (deniedGatewayTools.length === 0) return undefined;
  const expected = [...deniedGatewayTools].sort();
  const attested = [...(attestedGatewayAsk ?? [])].sort();
  const matches =
    expected.length === attested.length &&
    expected.every((tool, index) => tool === attested[index]);
  if (matches) return undefined;
  return (
    "the opencode server did not attest the free-tier gateway ask posture " +
    `this session requires (expected [${expected.join(", ")}], attested ` +
    `[${attested.join(", ")}]); refusing to lift bash/read off the ` +
    "tools-map deny list before a session is created. The deletion is only " +
    "safe because the server gates those tools itself on its own " +
    "permission surface — an unattested server would leave bash at " +
    "OpenCode's default permission instead."
  );
}

// ENUMERATE, never trust a default. Every id the provider reports is written
// into the map explicitly — the allows true, everything else false — so no key
// is ever absent. An absent key asks for the provider's default, and
// opencode.ai/docs/tools says "By default, all tools are enabled": leaving
// `write`, `edit`, `apply_patch` or `task` absent hands the model exactly the
// tools §6 exists to withhold. Enumerating makes the question moot rather than
// answering it, which is the only durable form of the fix.
function resolveToolMap(
  surface: readonly string[],
  canonicalTools: readonly string[],
  denyFloor: readonly string[],
  // #141: the MCP tool ids this session's registry actually delivers. Empty
  // when no registry was delivered — which is the common case and the parity
  // case, not an error.
  deliveredMcpToolIds: ReadonlySet<string>,
): Record<string, boolean> {
  const tools: Record<string, boolean> = {};
  for (const id of surface) tools[id] = false;
  // #141: MCP ids are legitimately ABSENT from the reported surface. Measured
  // on both endpoints, both providers, before and after connect: a connected
  // MCP server contributes nothing to `tool.ids()` or `tool.list()`, and the
  // SDK docstring promising "including built-in and dynamically registered" is
  // simply wrong about MCP. So they are seeded from pr-hero's own table — the
  // enumeration rule is unchanged, only its source differs for these ids.
  for (const id of ALL_MCP_TOOL_IDS) tools[id] = false;
  // Defense in depth. Ordering is unchanged from before the fix — the floor is
  // written first and a named allow may still flip it (`denyFloor`'s contract
  // says so) — but no canonical name in the table above maps onto a floor id,
  // so the floor cannot be lifted by a prompt's `tools:` line.
  for (const tool of denyFloor) tools[tool] = false;
  for (const canonical of canonicalTools) {
    const id = CANONICAL_TO_OPENCODE_TOOL[canonical];
    // Two separate drops, both intentional. An unmapped canonical name (the
    // codegraph MCP tool) has no built-in to name; an id the provider did not
    // report is not on this build's surface. Writing either one in would be
    // the absent-key hazard in reverse — a key we invented, meaning whatever
    // the provider decides it means.
    if (id === undefined) continue;
    // An MCP id can only be allowed by a registry that actually delivered it.
    // The `id in tools` guard below cannot make this call — the id is seeded
    // above, so it is always present — and it must not be allowed to: writing
    // true for a server that was never launched would grant the model a tool
    // that does not exist and hide the gap #141 exists to close.
    if (MCP_TOOL_ID_SET.has(id)) {
      if (deliveredMcpToolIds.has(id)) tools[id] = true;
      continue;
    }
    if (!(id in tools)) continue;
    tools[id] = true;
  }
  return tools;
}

interface SessionState {
  evidence: OpenCodeEvidenceCollector;
  readonly api: OpenCodeSdkClientApi;
  // ONE consumer of the subscription, ever. The pump owns the iterator and
  // hands events over through this queue; streamEvents never touches the
  // stream itself. Two for-awaits on one async iterator is a race with two
  // losing sides: the second consumer can miss an event the first already
  // took, and either one exiting fires an implicit .return() that ends the
  // SHARED generator under the other. pr-hero found exactly that here
  // (F002/F003 on PR #84) — in a repo that had already written the hazard
  // down, in opencode-sdk.ts, and walked into it anyway.
  readonly queue: unknown[];
  queueBytes: number;
  // #124: partID → part kind, correlated from `message.part.updated`. #127
  // added the turn's proof and usage accumulators alongside them. Lives on the
  // session because that is the scope both are valid in, and because they must
  // be released with the session rather than with the client.
  readonly turn: OpenCodeTurnState;
  // #127, and OWNED BY THE POLL OBSERVER ALONE — never written from the
  // stream. `GET /session/status` reports a working session as busy and simply
  // OMITS one that is not working (measured against opencode 1.18.23; see
  // pollStatus), so absence is this observer's boundary. Absence is also
  // exactly what a wrong directory scope looks like, and the two are
  // indistinguishable in the response — so absence only counts once this
  // observer has proved, through its own endpoint, that it can see this
  // session at all.
  observedActive: boolean;
  ended: boolean;
  wake?: () => void;
  // The handoff can end two ways. The pump ending is an EOF and says nothing
  // about the turn; this says the turn never started, and carries the
  // provider's diagnosis to the consumer instead of leaving it to infer a
  // silence. Set only for a failure the stream itself could never report,
  // because a refused prompt creates no message and therefore no events.
  //
  // Read by BOTH observers, and that is not redundancy. streamEvents can only
  // see this while it is still being read, and the pump ends the handoff
  // asynchronously from the prompt it knows nothing about — so when the pump
  // wins that race the stream reader is already gone and pollStatus is the
  // only door left. §197 asks for two independent observers of one fact; one
  // observer plus a blind spot is not that.
  failure?: string;
  // PR #228 review, F002: `permission.asked` requestIDs already replied to
  // or currently in flight. An SSE Last-Event-ID reconnect can redeliver an
  // event this session already saw (the same hazard #227 dedupes for stream
  // deltas via OpenCodeTurnState.deltaEventIds) — a replayed permission.asked
  // must not send a second reply for a request the server already closed.
  // Added to BEFORE the reply is awaited, not after it resolves, so a
  // duplicate arriving while the first reply is still in flight also skips.
  readonly respondedPermissions: Set<string>;
}

// #141. Returns an EMPTY registry for a request that names none, which is the
// parity case rather than an error: a repo with no `.codegraph` index gets
// {"mcpServers":{}} from the driver (src/cli.ts:1263-1272) and its hunters run
// on read/grep/glob, exactly as they do on claude-code.
async function resolveMcpConfig(
  options: CreateOpenCodeClientOptions,
  input: OpenCodeCreateSessionInput,
): Promise<OpenCodeMcpConfig> {
  const configPath = input.mcpConfigPath;
  if (configPath === undefined) return {};
  const read = options.readMcpConfig;
  // Aborts rather than proceeding without MCP. Silently skipping is the whole
  // of #141: the path was threaded through three layers and applied to
  // nothing, so an indexed repo's hunters ran blind and no artifact said so.
  if (read === undefined) {
    throw new Error(
      `the request names an mcp registry (${configPath}) but this opencode ` +
        "client has no reader for it, so MCP cannot be delivered; refusing to " +
        "run a step without the tools it was configured with",
    );
  }
  return translateMcpConfig({
    json: await read(configPath),
    configPath,
    cwd: input.cwd,
    ...(options.codegraphBinaryPath === undefined
      ? {}
      : { codegraphBinaryPath: options.codegraphBinaryPath }),
  });
}

// bun-types 1.3.14 does not declare Bun's `timeout` fetch option on
// RequestInit (or on BunFetchRequestInit, which only extends it) even though
// Bun's runtime honours it — see the WHY comment at the call site below for
// what this buys. A narrow local type spells the one field needed instead of
// widening RequestInit itself.
type FetchInitWithIdleTimeoutDisabled = RequestInit & {
  readonly timeout: false;
};

// Distinguishes the ONE request this client fires that legitimately blocks
// past Bun's default HTTP idle timeout: POST /session/{sessionID}/message
// (session.prompt) only returns response headers once the whole model turn
// finishes. Anchored so it never matches:
//   - GET  /session/{sessionID}/message         (session.messages: the poll
//     readback, answers immediately, must keep the default timeout)
//   - GET/DELETE /session/{sessionID}/message/{id}  (getMessage/deleteMessage
//     — the single-message endpoint; the SDK never POSTs here, but the extra
//     path segment must be rejected regardless of method)
//   - POST /session/{sessionID}/prompt_async
//   - POST /session                             (session.create)
// A query string (e.g. `?directory=...`, which every one of these calls
// carries) never defeats the match: only pathname is checked.
export function isBlockingPromptRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  const { pathname } = new URL(request.url);
  return /^\/session\/[^/]+\/message$/.test(pathname);
}

export function createOpenCodeClient(
  options: CreateOpenCodeClientOptions,
): OpenCodeClientLike & { close(): Promise<void> } {
  const states = new Map<string, SessionState>();
  const captures = new Map<string, OpenCodeEvidenceCollector>();
  const denyFloor = options.denyFloor ?? DEFAULT_DENY_FLOOR;
  // ONE server for the whole client, launched lazily. A server per SESSION
  // left a spawned process behind for every attempt, released only by a
  // whole-client close() that is not even part of OpenCodeClientLike
  // (pr-hero F004 on PR #84). One server hosts many sessions; that is what
  // the session API is for.
  let serverPromise: Promise<OpenCodeServerHandle> | undefined;
  let server: OpenCodeServerHandle | undefined;
  // #141: the registry the shared server was actually launched with, as its
  // own JSON. The readback (§E) compares NAMES, and names are not the whole
  // config: two sessions on different trees would agree on "codegraph" while
  // disagreeing on the `-p <cwd>` baked into the command at spawn — which is
  // precisely the wrong-tree failure `-p` exists to prevent, and it would be
  // invisible to every other check here. Production does not hit this today
  // (one cwd per pipeline); the guard is for the day that changes.
  let launchedMcp: string | undefined;
  // Same guard, same reason, for the free-tier gateway ask set (see
  // FREE_TIER_GATEWAY_TOOLS). The registry caches ONE opencode client per
  // route (transport-registry.ts), so every step routed to the same
  // provider_free model shares this server — a hunter-shaped step (grants
  // read) and a tool-less step (summarizer/scout) on that SAME route would
  // otherwise silently ride whichever one's ask set the server happened to be
  // launched with. This is fixed at spawn exactly like the MCP registry
  // above, and the pipeline's own phase boundaries (hunters all finish before
  // dedupe releases the idle server, refuter/scout run in a later phase)
  // mean a real run only ever asks this server to relaunch, never to change
  // shape mid-flight — a genuine concurrent mismatch fails loud instead of
  // silently weakening.
  let launchedGatewayAsk: string | undefined;
  // Calls that have committed to the shared server but have not registered a
  // session yet. `states` alone cannot answer "is anyone using this?": its
  // entry appears only after session.create AND event.subscribe both
  // succeed, so a sibling mid-establishment is invisible to it — and a
  // failing call would then SIGTERM the server that healthy sibling is using.
  // Sharing one server is what created this hazard; per-session servers could
  // not have had it.
  let establishing = 0;

  function stateFor(session: OpenCodeClientSession): SessionState {
    const state = states.get(session.id);
    if (state === undefined) {
      throw new Error(`unknown opencode session: ${session.id}`);
    }
    return state;
  }

  // Shared by createSession's unwind and abort(). `states` alone cannot
  // answer "is anyone using this?" while a sibling is still establishing,
  // so both counters have to be zero.
  async function releaseIdleServer(): Promise<void> {
    if (establishing !== 0 || states.size !== 0) return;
    const dying = server;
    serverPromise = undefined;
    server = undefined;
    launchedMcp = undefined;
    // Reset with its sibling: the next launch records a fresh posture, and
    // this releases the only thing that makes a different posture legal.
    launchedGatewayAsk = undefined;
    if (dying !== undefined) await dying.close().catch(() => {});
  }

  return {
    takeEvidence(sessionId, attempt) {
      const key = `${sessionId}:${attempt}`;
      const collector = captures.get(key);
      captures.delete(key);
      return collector?.snapshot();
    },
    async createSession(
      input: OpenCodeCreateSessionInput,
    ): Promise<OpenCodeClientSession> {
      const evidence = new OpenCodeEvidenceCollector(
        input.correlation ?? { sessionId: "unavailable", attempt: 0 },
      );
      if (input.correlation)
        captures.set(
          `${input.correlation.sessionId}:${input.correlation.attempt}`,
          evidence,
        );
      evidence.record("runtime_identity", options.observedIdentity ?? null);
      const checkCancelled = () => input.signal?.throwIfAborted();
      checkCancelled();
      // Free-tier gateway fix: computed once, up front, from this call's OWN
      // canonical tools — needed below at the server-launch decision (before
      // any server exists) AND again once the tools map is resolved (so the
      // same ids never get written `false` there either). Empty for every
      // route but `provider_free`, so both uses are no-ops elsewhere.
      const freeTierGatewayTools: readonly string[] =
        options.credentialKind === "provider_free"
          ? FREE_TIER_GATEWAY_TOOLS
          : [];
      const deniedGatewayTools = deniedFreeTierGatewayTools(
        input.tools,
        freeTierGatewayTools,
      );
      const requestOptions = { signal: input.signal };
      let cleanupDeadline: number | undefined;
      const cleanup = async (
        work: (signal: AbortSignal) => Promise<unknown>,
      ) => {
        const controller = new AbortController();
        cleanupDeadline ??= performance.now() + 1_000;
        const remaining = Math.max(0, cleanupDeadline - performance.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            work(controller.signal),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                controller.abort();
                resolve();
              }, remaining);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          controller.abort();
        }
      };
      let sdk: OpenCodeSdkLike;
      try {
        sdk = await options.loadSdk();
        checkCancelled();
      } catch (error) {
        throw new Error(
          "the opencode backend needs @opencode-ai/sdk, which is an optional " +
            "peer dependency of pr-hero. Install it alongside pr-hero to use " +
            `this backend. (${(error as Error).message})`,
        );
      }

      // Read BEFORE anything is spawned. It is the one step that fails on the
      // operator's filesystem, and doing it first means an unreadable prompt
      // costs nothing to unwind. pr-hero F005 found it running AFTER the
      // server, the remote session and the registered state — leaking all
      // three, with the caller never given the id needed to abort any of them.
      const systemPrompt = await options.readSystemPrompt(
        input.systemPromptPath,
      );

      // #141: read and translated BEFORE anything is spawned, for the same
      // F005 reason as the system prompt — a registry that cannot be honoured
      // must cost nothing to unwind — and because §D needs the config in hand
      // at launch, not after it.
      const mcpConfig = await resolveMcpConfig(options, input);
      checkCancelled();
      const mcpFingerprint = JSON.stringify(mcpConfig);
      // Order-independent: two calls that deny the same set in different
      // orders must fingerprint identically.
      const gatewayAskFingerprint = JSON.stringify(
        [...deniedGatewayTools].sort(),
      );

      if (serverPromise === undefined) {
        serverPromise = options.launchServer(mcpConfig, deniedGatewayTools);
        // Recorded synchronously, before the first await: a sibling call that
        // arrives mid-launch must compare against this launch, not against
        // whatever it would have asked for.
        launchedMcp = mcpFingerprint;
        launchedGatewayAsk = gatewayAskFingerprint;
        try {
          server = await serverPromise;
        } catch (error) {
          // A failed launch must not poison the client forever.
          serverPromise = undefined;
          launchedMcp = undefined;
          launchedGatewayAsk = undefined;
          throw error;
        }
      } else if (
        launchedMcp !== mcpFingerprint ||
        launchedGatewayAsk !== gatewayAskFingerprint
      ) {
        throw new Error(
          "the opencode server for this client was launched with a different " +
            "MCP registry or free-tier gateway permission set; its servers " +
            "are fixed at spawn, so this session would silently ride the " +
            "first one's project scope or isolation posture",
        );
      }
      const handle = server ?? (await serverPromise);
      checkCancelled();
      // Free-tier gateway fix: verify the launch seam's assumption BEFORE
      // the tools-map deletion loop, tool enumeration, session.create, or
      // any prompt — see gatewayAskAttestationError's WHY above.
      const gatewayAttestationError = gatewayAskAttestationError(
        deniedGatewayTools,
        handle.gatewayAsk,
      );
      if (gatewayAttestationError !== undefined) {
        // No session of this call exists yet, so an otherwise idle server is
        // released here rather than left running until the run tears down;
        // one shared with live sessions stays up for them.
        await releaseIdleServer();
        throw new Error(gatewayAttestationError);
      }
      const api = sdk.createOpencodeClient({
        baseUrl: handle.url,
        fetch: evidence.wrapFetch((request) => {
          const fetchImpl = options.fetch ?? globalThis.fetch;
          // Bun's fetch has a default 300s HTTP idle timeout
          // (BUN_CONFIG_HTTP_IDLE_TIMEOUT) that is armed while waiting for
          // response headers and is NOT re-armed by "the request is still
          // legitimately in flight" — only by socket activity. The blocking
          // prompt POST's headers only arrive once the whole model turn
          // completes (measured: real turns exceed 300s), and a REJECTION
          // here — a bare TimeoutError included — ends the entire turn: the
          // catch a short way below sets `state.failure` and `state.ended`,
          // even though the event stream (the actual delivery channel, see
          // the "FIRED, never awaited" comment on the call site) may still be
          // progressing normally. Live evidence: two hunters on a real PR
          // died at ~300s this way.
          //
          // The override is scoped to exactly that one request via
          // isBlockingPromptRequest — every other call in this file (session
          // create, /event's SSE subscription, mcp.status, tool.ids,
          // /session/status, abort, message readback) returns promptly and
          // keeps today's exact single-argument call shape unchanged.
          //
          // Cancellation is unaffected: the Request built by the SDK still
          // carries `requestOptions.signal` regardless of this second
          // argument, so an abort during a `timeout: false` call still
          // rejects the way it always has.
          if (isBlockingPromptRequest(request)) {
            const init: FetchInitWithIdleTimeoutDisabled = { timeout: false };
            return fetchImpl(request, init);
          }
          return fetchImpl(request);
        }),
      });

      let sessionId: string | undefined;
      let subscription: { stream: AsyncIterable<unknown> } | undefined;
      establishing += 1;
      try {
        const qualification = await options.qualifyServer?.(
          handle.url,
          input.signal,
        );
        evidence.record("server_qualification", qualification ?? null);
        checkCancelled();
        // §E, and FIRST: the OpenCode analogue of claude-code's
        // `--strict-mcp-config`, except claude-code DECLARES its isolation
        // with a flag and this reads the connected set back from the provider.
        // Verified beats declared, and the concrete threat is measured (#141
        // fact 7): `--pure` suppresses neither config-delivered nor
        // config-FILE MCP servers, so a server that ever saw the operator's
        // real HOME connects whatever ~/.config/opencode/opencode.jsonc names.
        // Production is shielded only INCIDENTALLY, by the synthetic
        // XDG_CONFIG_HOME the credential projection happens to set — and
        // nothing else here could notice the difference, since a connected MCP
        // server contributes nothing to the tool surface enumerated below.
        //
        // The `directory` scope mirrors what the request asked for, and the
        // #127 analogue was checked rather than assumed. session.status
        // reported {} for a BUSY session given a directory other than the
        // one its session was created under (#223) — so pollStatus below
        // passes the SAME directory session.create used, never omits it —
        // and the obvious worry was that mcp.status scopes the same way and
        // would then abort every PR-mode step, since the server inherits
        // pr-hero's cwd and never the worktree.
        //
        // It does not. MEASURED against a real PR worktree, with the server's
        // cwd deliberately elsewhere: `directory` set to the worktree, to the
        // server's own cwd, to /tmp, and omitted altogether all returned the
        // same `{"codegraph":{"status":"connected"}}`. A config-delivered MCP
        // server belongs to the server process, not to a directory. The
        // mismatch arm in scripts/opencode-mcp-probe.ts runs by default and
        // re-derives this, so a provider that starts scoping it is a probe
        // failure rather than a silent PR-mode outage.
        assertMcpConnected(
          unwrap(
            await api.mcp.status({ directory: input.cwd }, requestOptions),
            "mcp.status",
          ),
          Object.keys(mcpConfig),
        );

        checkCancelled();
        const created = await api.session.create(
          {
            directory: input.cwd,
            title: "pr-hero review step",
          },
          requestOptions,
        );
        const sessionRecord = unwrap(created, "session.create");
        sessionId = sessionRecord.id;
        checkCancelled();
        if (
          typeof sessionRecord.directory !== "string" ||
          canonicalDirectory(sessionRecord.directory) !==
            canonicalDirectory(input.cwd)
        ) {
          throw new Error(
            `opencode session created with mismatched directory: expected ${input.cwd}, got ${sessionRecord.directory}`,
          );
        }

        // Subscribed BEFORE the prompt, and the ordering is not stylistic.
        // event.subscribe() is live and unbuffered, so a subscription opened
        // afterwards silently loses the early events — the ones carrying the
        // first deltas. The contract splits createSession and streamEvents
        // into separate calls, so unless the buffering happens here that
        // window cannot be closed at all.
        //
        // #223: `directory` here MUST be the same one session.create used
        // above (input.cwd) — GET /event is scoped by directory instance,
        // exactly like GET /session/status (see pollStatus). Measured
        // against opencode 1.18.30: a subscription opened under a different
        // directory than the session's own sees only
        // server.connected/heartbeat and never this session's events at all.
        //
        // `requestOptions` (`{signal}`) is deliberately NOT passed here. It
        // used to be passed as the FIRST argument — the SDK's parameters
        // slot, not its request-options slot — where buildClientParams drops
        // unknown keys, so the SSE request has never carried an abort signal;
        // stream close has always been owned by cleanup's `return()`. Moving
        // it to the second argument would change live cancellation semantics
        // (an AbortError inside the pump) that no fake here exercises, since
        // the fakes ignore call options. That is a separate change.
        subscription = await api.event.subscribe({ directory: input.cwd });
        evidence.record("subscription_ready", { sessionId });
        checkCancelled();

        // #128: enumerate AFTER create+subscribe, immediately before the
        // prompt. The map is a snapshot of tool.ids(); an id registered in
        // the window is an absent key, and OpenCode's default is "all tools
        // enabled". There is no atomic tools surface (open map, no wildcard),
        // so this is the remaining narrowing: [ids → prompt] instead of
        // [ids → create → subscribe → prompt]. Still inside the try after
        // `establishing += 1` so a failure unwinds through `finally`.
        //
        // WHY before the pump, not after. Starting the pump and THEN awaiting
        // tool.ids lets a finite stream drain into the queue during that
        // HTTP round-trip. The live provider has no turn events yet (the
        // prompt has not fired), so nothing is lost by enumerating first;
        // a test fixture that yields its whole stream synchronously would
        // otherwise dump every delta into one stall window.
        let reported: readonly string[];
        try {
          reported = unwrap(
            await api.tool.ids({ directory: input.cwd }, requestOptions),
            "tool.ids",
          );
        } catch (error) {
          // Rethrown with context, never swallowed. The provider's own text is
          // APPENDED rather than replaced: classifyFailure checks its
          // auth/rate-limit/network patterns before the session-creation
          // marker, so "fetch failed" here still keeps its transient retry
          // instead of being flattened into a terminal ruling.
          throw new Error(
            "opencode could not report its tool surface, so the allow map " +
              `cannot be enumerated: ${(error as Error).message}`,
          );
        }
        const surface = (Array.isArray(reported) ? reported : []).filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        if (surface.length === 0) {
          throw new Error(
            "opencode reported an empty tool surface, so the allow map cannot " +
              "be enumerated and no tool can be proven denied; refusing to " +
              "open a session whose isolation is unverifiable",
          );
        }
        const tools = resolveToolMap(
          surface,
          input.tools,
          denyFloor,
          mcpToolIdsFor(mcpConfig),
        );
        // Free-tier gateway fix (FREE_TIER_GATEWAY_TOOLS above): `deniedGatewayTools`
        // was computed up front, before this map even existed, and already
        // decided the server's permission config (the launchServer call
        // above). Re-applied here for the SAME two ids so the map this
        // client actually sends never carries the `false` that trips
        // OpenCode's gateway. Only a key the loops above left `false` is
        // deleted — a tool this call DID grant (`read` for a hunter-shaped
        // spec) is untouched, so it stays `true` exactly as it would on any
        // other route.
        for (const tool of deniedGatewayTools) {
          if (tools[tool] === false) delete tools[tool];
        }

        const userMessageId =
          options.createMessageId?.() ??
          `msg_${Date.now().toString(16)}${crypto.randomUUID().replaceAll("-", "")}`;
        if (!/^msg/.test(userMessageId))
          throw new Error("invalid OpenCode submitted message identity");
        evidence.record("session_identity", {
          sessionId,
          userMessageId,
          cwd: input.cwd,
        });
        const state: SessionState = {
          evidence,
          api,
          queue: [],
          queueBytes: 0,
          turn: createTurnState(sessionId, userMessageId, input.cwd),
          observedActive: false,
          ended: false,
          respondedPermissions: new Set(),
        };
        states.set(sessionId, state);

        // The ONLY consumer of the subscription. Subscribing without pulling
        // buys nothing — an SSE iterator nobody reads is not a recording, the
        // events simply have not been requested yet.
        void (async () => {
          try {
            for await (const raw of subscription.stream) {
              // #228: this is ONE directory-scoped stream shared by every
              // concurrent hunter's session on the same server. Recording
              // every event unfiltered meant roughly 55% of a real
              // multi-hunter capture was OTHER sessions' events, filling the
              // record/byte cap long before this session's own silence
              // window was covered. An event with no attributable session id
              // is still recorded — there is nothing to filter it against.
              const rawSessionId = eventSessionId(raw);
              if (rawSessionId === undefined || rawSessionId === sessionId) {
                evidence.record("event", raw);
              }
              // #157 (pr-157-8df2fca3-6): a hunter's tool call for a path
              // OUTSIDE the reviewed worktree tripped `permission.asked`,
              // and pr-hero never answered it — the tool call sat blocked
              // until the silence tripwire killed the attempt 150s later at
              // $0. The server-side `deny` config (opencode-server.ts) is
              // the primary control; this is defense in depth for whatever
              // it does not cover — ANY permission, not only
              // `external_directory`, since pr-hero has no UI to answer a
              // prompt and must never leave one pending. Own session only:
              // `rawSessionId` is the SAME id `eventSessionId` already
              // computed above.
              if (
                rawSessionId === sessionId &&
                (raw as RawEvent)?.type === "permission.asked"
              ) {
                const properties = props(raw);
                const requestID = properties?.id;
                const permissionName =
                  typeof properties?.permission === "string"
                    ? properties.permission
                    : "unknown";
                const patterns = Array.isArray(properties?.patterns)
                  ? (properties.patterns as unknown[]).filter(
                      (p): p is string => typeof p === "string",
                    )
                  : [];
                if (
                  typeof requestID === "string" &&
                  !state.respondedPermissions.has(requestID)
                ) {
                  // PR #228 review (round 2), F002: `rememberId` (used for
                  // every OTHER bounded id set in this file) evicts the
                  // OLDEST entry once full — fine for high-volume, low-
                  // stakes dedup like stream deltas, but wrong here: an
                  // evicted requestID is indistinguishable from one this
                  // session never saw, so ITS later SSE redelivery would
                  // pass the `!has(requestID)` guard above and fire a
                  // SECOND `permission.reply` for a request the server
                  // already closed — exactly the failure this set exists to
                  // prevent. A failed second reply already fails the
                  // attempt below, so evicting just makes that failure
                  // depend on redelivery timing this session cannot
                  // control. 512 distinct permission prompts inside one
                  // step is already anomalous — `external_directory` is
                  // denied at the server config (opencode-server.ts) — so
                  // failing closed here, the same way `failIntegrity` fails
                  // closed on other exhausted identity caps (e.g. "tool
                  // identity cap exceeded"), is strictly safer than ever
                  // forgetting a requestID this session has committed to
                  // answering.
                  if (
                    state.respondedPermissions.size >=
                    MAX_TRACKED_PERMISSION_REQUESTS
                  ) {
                    state.turn.integrityFailure =
                      "[pr-hero] opencode client: permission request cap exceeded (512)";
                    state.wake?.();
                    state.wake = undefined;
                    break;
                  }
                  // PR #228 review, F002: added BEFORE the reply is even
                  // sent, not after it resolves — an SSE Last-Event-ID
                  // reconnect can redeliver this same event, and a duplicate
                  // arriving while this reply is still in flight must also
                  // see it here rather than racing the await below.
                  state.respondedPermissions.add(requestID);
                  void (async () => {
                    try {
                      unwrap(
                        await api.permission.reply(
                          {
                            requestID,
                            directory: input.cwd,
                            reply: "reject",
                          },
                          requestOptions,
                        ),
                        "permission.reply",
                      );
                      // Visible in the attempt's evidence capture even
                      // though nothing settles on the success path — this is
                      // the only record that pr-hero ever saw, and answered,
                      // this prompt.
                      evidence.record("permission_rejected", {
                        requestID,
                        permission: permissionName,
                        patterns,
                      });
                    } catch (error) {
                      // The one case the server-side config cannot cover:
                      // the reject control itself did not run. Settled
                      // promptly rather than left to the silence tripwire —
                      // see the second door below, exactly like the prompt
                      // failure above.
                      state.failure = formatPermissionRejectFailureDetail(
                        permissionName,
                        patterns,
                        (error as Error).message,
                      );
                      state.ended = true;
                      state.wake?.();
                      state.wake = undefined;
                    }
                  })();
                }
              }
              const rawSize = Buffer.byteLength(JSON.stringify(raw), "utf8");
              state.queueBytes += rawSize;
              if (state.queueBytes > 4 * 1024 * 1024) {
                state.turn.integrityFailure =
                  "[pr-hero] opencode client: raw subscription queue cap exceeded (cap exhaustion)";
                state.wake?.();
                state.wake = undefined;
                break;
              }
              state.queue.push(raw);
              state.wake?.();
              state.wake = undefined;
            }
          } catch {
            // A dead stream ends the handoff; the poll still observes the
            // attempt — including any failure recorded after this point, which
            // is why pollStatus reads `state.failure` too. Before it did, this
            // line was a claim the poll could not honour: it queries
            // session.messages(), and a turn that never started has none.
          } finally {
            state.ended = true;
            state.wake?.();
            state.wake = undefined;
          }
        })();

        // FIRED, never awaited. session.prompt blocks until the turn finishes
        // — the probe measured 4.5s — and returns the completed message. The
        // ROADMAP forbids completing an attempt from one blocking HTTP call,
        // so this is the trigger and the event stream is the truth.
        //
        // Its RESULT is still observed, and the earlier `.catch()` was not
        // enough to do that: under the SDK's default `ThrowOnError = false` an
        // API-level refusal RESOLVES with `{ data: undefined, error }`, so the
        // handler never ran and the refusal was dropped. The comment that
        // stood here claimed both §197 observers would see it anyway, which is
        // false in exactly the case that matters — a prompt the provider
        // refused creates no message, so no event fires and the poll has
        // nothing to find. The attempt then sat armed waiting for a terminal
        // that a turn which never started could never produce, until the
        // harness watchdog charged it as a timeout.
        //
        // A refusal answers at CALL time, not at turn end, so observing it
        // costs the trigger shape nothing: this stays fired-not-awaited, and
        // only the failure travels — through the same `ended`/`wake` handoff
        // the pump uses. That handoff alone was NOT enough, though: the pump
        // ends it on its own schedule, so when the pump wins the race the
        // stream reader has already returned and the wake below is a no-op
        // into a state nobody reads again. Hence the second door, pollStatus,
        // which reads the same `state.failure`.
        void (async () => {
          try {
            const variant = options.variant ?? options.model.variant;
            const promptParams: OpenCodeSdkPromptParameters = {
              sessionID: sessionId,
              messageID: userMessageId,
              directory: input.cwd,
              model: {
                providerID: options.model.providerID,
                modelID: options.model.modelID,
              },
              ...(variant !== undefined ? { variant } : {}),
              system: systemPrompt,
              tools,
              parts: [{ type: "text", text: input.userPrompt }],
            };
            Object.defineProperty(promptParams, "body", {
              value: {
                model: promptParams.model,
                system: promptParams.system,
                tools: promptParams.tools,
                parts: promptParams.parts,
              },
              enumerable: false,
            });
            checkCancelled();
            const promptResult = unwrap(
              await api.session.prompt(promptParams, requestOptions),
              "session.prompt",
            );
            evidence.record("prompt_result", promptResult);
            if (asRecord(asRecord(promptResult)?.info) !== undefined) {
              // #223: this reconcile is INGEST ONLY — its `events` are
              // discarded because the event stream, never this blocking HTTP
              // response, is the delivery channel (see the "FIRED, never
              // awaited" comment above). `emit: false` keeps that discard
              // honest: two of twelve live opencode 1.18.30 attempts had this
              // call race ahead of the SAME text part's own announce -> delta
              // -> snapshot lifecycle on the stream, and letting it advance
              // `emittedText` here — for text nobody was actually handed —
              // made the stream's own, perfectly ordinary snapshot look like
              // a conflicting one and threw away a correct answer.
              reconcileMessages([promptResult], state.turn, { emit: false });
            }
          } catch (error) {
            state.failure = (error as Error).message;
            state.ended = true;
            state.wake?.();
            state.wake = undefined;
          }
        })();

        // The map travels with the session so the attempt can stamp what was
        // ACTUALLY sent into its stderr notes. #116's ledger requires the
        // tools/MCP axis be provable by reading artifacts; before this,
        // nothing recorded the map at all and the only evidence of the defect
        // was a hunter narrating tool use it never performed.
        return { id: sessionId, toolMap: Object.freeze(tools) };
      } catch (error) {
        // #128 opened subscribe() before tool.ids. If enumeration fails, the
        // pump never starts, so this is the only chance to close the global
        // SSE. `return()` on a never-started iterator is how AsyncIterable
        // cancellation is expressed; ignoring it leaks one unread stream
        // against the shared server for as long as a sibling keeps it alive.
        if (subscription !== undefined) {
          const iterator = subscription.stream[Symbol.asyncIterator]();
          await cleanup(async () => iterator.return?.());
        }
        // Unwind whatever this call managed to create. Without this the
        // caller gets an exception and no id, so nothing can be released by
        // hand afterwards.
        if (sessionId !== undefined) {
          states.delete(sessionId);
          // A remote session that WAS created is real work on the provider's
          // side; dropping the local map entry does not release it.
          //
          // The result is OBSERVED, like every other call in this file: the
          // `.catch(() => {})` that stood here could not see a refusal at all,
          // because under `ThrowOnError = false` an API-level failure RESOLVES
          // with `{ data: undefined, error }`. A refused abort leaves remote
          // work running — and billing — with no trail at all.
          //
          // The trail is APPENDED to the error that caused the unwind, never
          // thrown over it. This handler has no notes channel; the propagated
          // error is the channel, since the transport stamps it into
          // stderrTail as "session creation failed: …". And the failure that
          // caused the unwind is the one the caller must still see — masking
          // it with a teardown detail would trade a diagnosis for a symptom.
          try {
            await cleanup(async (signal) =>
              unwrap(
                await api.session.abort({ sessionID: sessionId }, { signal }),
                "session.abort",
              ),
            );
          } catch (abortError) {
            const detail = (abortError as Error).message;
            if (error instanceof Error) {
              error.message = `${error.message} (${detail})`;
            } else {
              throw new Error(`${String(error)} (${detail})`);
            }
          }
        }
        throw error;
      } finally {
        establishing -= 1;
        // Do not await on the success path: an extra tick lets a finite
        // fixture stream drain into one stall window before execute() starts.
        if (establishing === 0 && states.size === 0) {
          await releaseIdleServer();
        }
      }
    },

    async *streamEvents(session: OpenCodeClientSession) {
      const state = stateFor(session);
      // Reads the QUEUE, never the stream. Everything buffered before this
      // call is already here in arrival order, and everything after arrives
      // through the same door — so there is no handoff to race.
      for (;;) {
        while (state.queue.length > 0) {
          const raw = state.queue.shift();
          state.queueBytes = Math.max(
            0,
            state.queueBytes - Buffer.byteLength(JSON.stringify(raw), "utf8"),
          );
          yield* mapOpenCodeEvents(raw, session.id, state.turn);
        }
        if (state.turn.integrityFailure !== undefined) {
          throw new Error(state.turn.integrityFailure);
        }
        // Checked AFTER the drain and BEFORE `ended`: anything the provider
        // already said is delivered first — a terminal buffered before the
        // failure still wins its slot — and a failure is a louder end than an
        // EOF, so it must not be swallowed by the plain return below.
        if (state.failure !== undefined) throw new Error(state.failure);
        if (state.ended) return;
        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
      }
    },

    async pollStatus(
      session: OpenCodeClientSession,
      signal?: AbortSignal,
    ): Promise<OpenCodePollResult> {
      const state = states.get(session.id);
      // #131: abort() owns the Map release. Absence must not throw (a throw
      // is a failed observation the harness counts and retries forever). It
      // also must not be `{kind:"failed"}`: runPoll treats that as
      // session_failed and first-write-wins against the abortConfirmMs
      // window (opencode-sdk.ts runAbortSequence). Pending lets the stream
      // still deliver a provider terminal, or the timer settle
      // abort_unconfirmed.
      if (state === undefined) {
        return { kind: "pending" };
      }
      if (state.turn.integrityFailure !== undefined) {
        return { kind: "failed", detail: state.turn.integrityFailure };
      }

      // #127: the BOUNDARY first, and from a different endpoint. This observer
      // has no event stream, so it cannot see `session.idle`; scanning
      // session.messages() for the last completed assistant message is not a
      // substitute, because at any poll instant "last completed" is step 1
      // until step 2 exists. Two observers of one wrong fact are not two
      // observers, which is precisely why the §197 cross-check could not catch
      // the defect.
      //
      // Measured against opencode 1.18.23 at $0 — a local `opencode serve`
      // plus a model-free `POST /session/{id}/shell` running `sleep 6`:
      //
      //   while the session is working        {"ses_…":{"type":"busy"}}
      //   after it stops, and when freshly created   {}
      //
      // An idle session is simply ABSENT from the map; it is never reported as
      // {"type":"idle"}. Requiring the explicit value — the reading the SDK's
      // `SessionStatus` union invites — would have left this observer
      // permanently blind and §197 down to one observer again. The explicit
      // arm is still honoured for the build that does send it.
      //
      // #223: `directory` IS required, and it must be the SAME one
      // session.create used for this session — `state.turn.expectedCwd`,
      // set from `input.cwd` by `createTurnState` (and the exact value
      // `session.messages` below queries with too). Measured against
      // opencode 1.18.30: `GET /session/status` is scoped by directory
      // instance exactly like `GET /event` above, so omitting it — or
      // naming a different one — watches an instance that has never heard
      // of this session and reports it `{}` even while it is BUSY. That is
      // indistinguishable from "finished" in the response shape, which is
      // #127 reopened: a wrong scope silently discards the model's answer
      // once the useful-progress deadline elapses, because this observer
      // never sees anything to report.
      //
      // The still-true half of the old rationale survives below: absence is
      // ambiguous on its own even with the RIGHT directory, because it is
      // also what a session this call has simply never seen looks like.
      const statuses = asRecord(
        unwrap(
          await state.api.session.status(
            { directory: state.turn.expectedCwd },
            { signal },
          ),
          "session.status",
        ),
      );
      signal?.throwIfAborted();
      state.evidence.record("status", { sessionId: session.id, statuses });
      const statusRecord = asRecord(statuses?.[session.id]);
      // #157: checked BEFORE "retry means still working" below, and it is
      // its own second observer of the same fact the stream carries when it
      // is still alive to carry it — see mapOpenCodeEvents's "session.status"
      // case. `statuses?.[session.id]` is already scoped to THIS session, so
      // no separate session-match check is needed here.
      const limit = providerLimitFromStatus(statusRecord);
      if (limit !== undefined) {
        return {
          kind: "failed",
          detail: formatProviderLimitDetail(limit.reason, limit.message),
        };
      }
      const statusType = statusRecord?.type;
      // Both are the provider still working. `retry` especially: a session in
      // backoff is neither done nor idle, and it will produce more steps — its
      // `next` timestamp is what retryHintFromStatus reads for the policy.
      if (statusType === "busy" || statusType === "retry") {
        state.observedActive = true;
      } else if (statusType === "idle" || statusType === undefined) {
        // Absence is the boundary, but it is ALSO what a session this call
        // cannot see looks like (wrong scope, unknown id, a pruned entry), and
        // the response cannot tell the two apart. So it only counts once this
        // observer has seen the provider name this session through this same
        // endpoint. An explicit idle names it, so it arms and settles at once.
        if (statusType === "idle") state.observedActive = true;
        if (state.observedActive) {
          signal?.throwIfAborted();
          const response = await state.api.session.messages(
            {
              sessionID: session.id,
              directory: state.turn.expectedCwd,
            },
            { signal },
          );
          signal?.throwIfAborted();
          // Throws on the error arm rather than reporting "pending": the
          // caller treats a poll that throws as a FAILED OBSERVATION and
          // counts it (opencode-sdk.ts:707), whereas a silent "pending" would
          // let the attempt run to its stall deadline on an API error the
          // provider already explained.
          const messages = unwrap(response, "session.messages");
          state.evidence.record("readback", {
            sessionId: session.id,
            cwd: state.turn.expectedCwd,
            coverage: Array.isArray(messages) ? "complete" : "unknown",
            messages,
          });
          // The qualified ordinary endpoint returns the complete array when
          // no limit is supplied. An object/cursor is unknown coverage, not []
          // and never an excuse to reuse a prior terminal snapshot.
          if (!Array.isArray(messages)) {
            state.turn.integrityFailure =
              "[pr-hero] opencode client: unknown message readback coverage";
            return { kind: "failed", detail: state.turn.integrityFailure };
          }
          const list = messages;

          // #223 follow-up: this reconcile is INGEST ONLY, exactly like the
          // prompt_result call site above — its `events` are discarded below
          // (only `failure`/`terminalProof`/`finalText`/`usage`/
          // `usageIncomplete` are read), because the event stream, never this
          // polled HTTP readback, is the delivery channel. `emit: false`
          // keeps that discard honest: without it, a poll that races ahead of
          // the stream — observing a text part's FULL persisted snapshot
          // while the stream has only delivered a PREFIX of it — still
          // advanced `emittedText` to the full text here, for a consumer
          // that was never handed the rest. The stream's own still-in-flight
          // remaining deltas then found `emittedText` already past what was
          // really delivered, and its own later restating snapshot (every
          // real fixture sends one before the turn ends) found a
          // `snapshotText` shorter than the now-advanced `emittedText` and
          // threw "conflicting snapshot observed" — turning a turn that
          // actually finished cleanly into a `stream_error`/`failed` outcome.
          // `finalText` is unaffected either way: `canonicalFinalText`
          // (opencode-client.ts reconcileMessages) is computed from
          // `detail.text`, not `detail.emittedText`, before this gate runs.
          const reconciled = reconcileMessages(list, state.turn, {
            emit: false,
          });
          if (
            reconciled.failure !== undefined ||
            state.turn.integrityFailure !== undefined
          ) {
            return {
              kind: "failed",
              detail:
                reconciled.failure ??
                state.turn.integrityFailure ??
                "opencode client integrity failure",
            };
          }
          if (hasOutstandingTools(state.turn)) {
            return { kind: "pending" };
          }

          if (reconciled.terminalProof !== undefined) {
            // pr-hero review F001 (#214): reported HERE as the CURRENT
            // members of `completedToolCallIds` (whose own WHY comment on
            // `OpenCodeTurnState` carries the full reasoning), not inside
            // `reconcileMessages` (whose return type stays untouched) and not
            // re-derived from `toolStates`/`list` fresh at this moment — a
            // fresh re-filter is exactly the bug: an id that reached
            // "completed" on an earlier readback and "error" on this one
            // would silently drop out of a live recount. Ownership is already
            // enforced above, in the parts loop that only runs past
            // `isMessageOwned`, so every id in this set is this turn's own.
            return {
              kind: "terminal",
              proof: reconciled.terminalProof,
              finalText: reconciled.finalText,
              usage: reconciled.usage,
              usageIncomplete: reconciled.usageIncomplete,
              completedToolCallIds: Array.from(state.turn.completedToolCallIds),
            };
          }
        }
      }
      // The SECOND observer of the failure, and the reason it exists: the
      // stream can only carry a failure while it is still being read, and the
      // subscription pump ends the handoff on its own schedule — completely
      // asynchronously from the fired-not-awaited prompt. Lose that race and
      // streamEvents has already returned at `if (state.ended) return`, so
      // whatever the prompt's catch writes afterwards would reach nobody, and
      // this poll would answer "pending" forever over a session that can never
      // produce a message. §197 wants two INDEPENDENT observers of ONE fact; a
      // failure only one of them can see is not two observers.
      //
      // Checked AFTER the message scan, for the same reason streamEvents
      // checks it after draining the queue: a terminal the provider ALREADY
      // sent still wins its slot.
      if (state.failure !== undefined) {
        return { kind: "failed", detail: state.failure };
      }
      return { kind: "pending" };
    },

    async abort(session: OpenCodeClientSession): Promise<void> {
      const state = states.get(session.id);
      if (state === undefined) return;
      // The result is CHECKED, not discarded. Awaiting the error arm proves
      // nothing on its own — it resolves — so a provider-side refusal used to
      // return here as an ordinary success and the caller recorded a confirmed
      // abort over a remote session that may still be running, and billing.
      // Throwing is what makes it visible: the single caller
      // (opencode-sdk.ts's callAbortOnce) catches and stamps a note into
      // stderrTail, which keeps abort best-effort — observed, never fatal to
      // the teardown it runs inside.
      state.evidence.record("abort_requested", { sessionId: session.id });
      unwrap(
        await state.api.session.abort({ sessionID: session.id }),
        "session.abort",
      );
      state.evidence.record("abort_acknowledged", { sessionId: session.id });
      // #131: abort is the attempt's teardown, so it owns the Map release.
      // streamEvents already holds this object by reference, so in-flight
      // readers survive the delete; later pollStatus/abort see the gap.
      state.ended = true;
      state.wake?.();
      state.wake = undefined;
      states.delete(session.id);
      await releaseIdleServer();
    },

    async close(): Promise<void> {
      states.clear();
      const handle = server;
      server = undefined;
      serverPromise = undefined;
      launchedMcp = undefined;
      if (handle !== undefined) await handle.close();
    },
  };
}
