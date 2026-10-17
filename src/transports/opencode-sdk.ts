import type { BucketScope } from "../execution/bucket-id";
import { deriveBucketId } from "../execution/bucket-id";
import type {
  AsyncEventSink,
  ProviderCapabilityReport,
  ProviderEvent,
  ProviderEventBase,
  ProviderTerminalProof,
  ProviderTransport,
  ResolvedModelRoute,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../execution/contracts";
import type {
  NormalizedTokens,
  NormalizedUsage,
  UsageBillingMode,
  UsageModeState,
} from "../execution/usage-normalized";
import {
  applyUsageUpdate,
  normalizeUnavailableUsage,
  UsageModeMismatchError,
} from "../execution/usage-normalized";
import { CredentialProjectionError } from "../security/credential-broker";
import { redactDiagnostic } from "../security/redact";

// WHY there is no @opencode-ai dependency here: production enablement over the
// real SDK is deliberately deferred to D1-11 (§12 D1-06 vs D1-11). This slice
// ships the full §3.2/§4/§5.2 transport mechanics against a narrow injectable
// client (OpenCodeClientLike) so every deadline, bound, and arbitration rule is
// offline-conformance-testable; the D1-11 adapter wraps the actual SDK in
// exactly this interface.

// §4.2 line 191 hard content bounds: one delta ≤ 64 KiB, aggregate finalText
// ≤ 1 MiB, stderr tail ≤ 64 KiB. Exceeding a bound TERMINATES the attempt —
// content is never silently truncated and parsed.
const MAX_DELTA_BYTES = 64 * 1024;
const MAX_FINAL_TEXT_BYTES = 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;

// §4.2 line 189: backpressure beyond "the transport's declared stall deadline"
// aborts the attempt as protocol_overflow. The spec fixes no number; 10 s is
// the declared production default (injectable for offline tests).
const DEFAULT_STALL_DEADLINE_MS = 10_000;

// §5.2 line 272 (SDK row): session.abort() → provider-specific terminal
// confirmation up to 5,000 ms → local cleanup up to 1,000 ms; the harness
// deadline is 6,500 ms including margin and is declared via capabilities().
const SDK_ABORT_CONFIRM_MS = 5000;
const SDK_CLEANUP_MS = 1000;

// §9.2 non-secret provider label: this credential kind is opencode_chatgpt_
// oauth (ChatGPT), so "openai" is the correct HMAC input regardless of
// which model family a given step later routes to over the SDK — bucket
// identity is about the CREDENTIAL's rate-limit pool, not the model.
const BUCKET_IDENTITY_PROVIDER = "openai";

// D1-08 PR3 (§9.2): same optional-input shape as ClaudeCliCapabilitiesInput
// — omitted by every existing call site, so capabilities() stays
// byte-identical to pre-PR3 behavior until PR5a's harness wiring supplies a
// real credential's resolved scope.
export interface OpenCodeCapabilitiesInput {
  readonly credentialFingerprint: string;
  readonly bucketScope?: BucketScope;
  readonly localKey: Uint8Array;
}
// The margin the §5.2 row folds in on top of confirm+cleanup. Declared as a
// term rather than a literal total because harness.ts:425 TRUSTS the number
// capabilities() reports as the real bound: a constant would let an instance
// configured with larger budgets promise less time than it needs, and the
// harness would call a still-in-budget cancellation unconfirmed.
const SDK_DEADLINE_MARGIN_MS = 500;

// §197 names stream/poll arbitration without fixing numbers: the poll cadence
// and the per-round timeout are transport-declared defaults. A poll round that
// times out is an observation failure and can never win the terminal slot.
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_ROUND_MS = 2000;

// #132: how many consecutive post-win windows may be extended by a stream that
// keeps delivering. Each cycle is one `cleanupMs`, so this bounds the hold at
// maxDrainCycles x cleanupMs of SUSTAINED delivery — a whole answer draining in
// microseconds costs one cycle and never approaches the budget. It exists so a
// provider that will not stop cannot hold the attempt open until the step
// watchdog fires: exhausting it is an explicit `truncated` outcome, which is a
// louder and more actionable end than a watchdog timeout over a won terminal.
const DEFAULT_MAX_DRAIN_CYCLES = 4;

// Useful progress is a monotonic deadline, independent of poll latency. The
// optional round cap remains a deterministic test/backward-compatibility seam;
// production does not use rounds as a substitute for elapsed time.
const DEFAULT_USEFUL_PROGRESS_MS = 150_000;

export interface OpenCodeClientSession {
  readonly id: string;
  // The tool allow map the client actually sent, resolved against the
  // provider's enumerated surface. Optional because `OpenCodeClientLike` is an
  // injectable contract and a client that cannot express a tool gate has
  // nothing to report — a client that CAN must report it, so the enforcement
  // is provable from the attempt's artifacts instead of assumed from source.
  readonly toolMap?: Readonly<Record<string, boolean>>;
}

export interface OpenCodeCreateSessionInput {
  readonly correlation?: { sessionId: string; attempt: number };
  readonly signal?: AbortSignal;
  readonly cwd: string;
  readonly userPrompt: string;
  readonly systemPromptPath: string;
  readonly tools: readonly string[];
  readonly mcpConfigPath?: string;
}

export type OpenCodeClientEvent =
  | { readonly kind: "delta"; readonly text: string }
  | {
      readonly kind: "usage";
      readonly id?: string;
      readonly mode: "snapshot" | "delta";
      readonly final?: boolean;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly costUsd?: number;
      readonly incomplete?: boolean;
    }
  | {
      readonly kind: "diagnostic";
      readonly level: "info" | "warn" | "error";
      readonly message: string;
    }
  | { readonly kind: "heartbeat" }
  // #124: a reasoning delta the mapper DISCARDED. Deliberately carries no
  // payload — not the text, not even its length. The text is not the answer
  // and must not spend the answer's content budget; and nothing derived from
  // it may reach `notes`, which is classifyFailure's witness (see the note
  // this event ends up producing for what a bare number does there). What
  // survives the boundary is the bare fact that the model thought, which is
  // all the transport needs to tell a turn that reasoned and never answered
  // apart from one that produced nothing at all.
  | { readonly kind: "reasoning"; readonly progress?: boolean }
  // A tool part's status actually CHANGED (a novel pending/running/
  // completed/error transition the client observed at most once — see
  // opencode-client.ts's `handlePartUpdated`). Deliberately carries no
  // payload, same reasoning as the bare "reasoning" marker above: the tool's
  // input/output is not the answer and must not spend any content budget.
  // Distinct from "reasoning" on purpose — the SDK uses reasoning events for
  // its own "reasoning parts were received and discarded" diagnostics, and
  // conflating tool execution into that would corrupt them.
  | { readonly kind: "activity" }
  // #214 (merged with #228's toolActivityRank): a COMPLETED tool-call part,
  // emitted alongside "activity" at most once per callID — see
  // opencode-client.ts's `handlePartUpdated`, which gates this on the SAME
  // stream-owned `toolActivityRank` forward-rank check "activity" uses, never
  // on `toolStates` (which the poll readback also writes and can race ahead
  // of the stream). Pending/running/error restatements are dropped —
  // announcing Read is not looking, and an errored call is excluded on
  // purpose: it produced no signal to reason from, and no test has asked for
  // it to count. `tool` is the provider id (`read`, `grep`, …), never
  // arguments or output: those are model-adjacent and must not reach `notes`.
  // `callId` (pr-hero review F001/F002 on #214): the SAME identity
  // `handlePartUpdated` tracks in `toolStates`/`toolActivityRank` — required
  // so the transport can union this observation with the poll's by identity
  // rather than combine two disjoint counts. Optional only because hand-
  // written test doubles construct this event without a real client behind
  // it; the transport falls back to a synthetic per-event id in that case so
  // those fixtures keep counting one event as one invocation.
  | { readonly kind: "tool"; readonly tool?: string; readonly callId?: string }
  // #157: our own session's status named an account/usage limit (a `retry`
  // status whose `action.reason` is one opencode-client.ts's
  // providerLimitFromStatus recognises). Carries the provider's reason and
  // message VERBATIM — nothing is summarized or reworded — because the
  // classification witness has to be the provider's own fact, not this
  // transport's paraphrase of it.
  | {
      readonly kind: "provider_limit";
      readonly reason: string;
      readonly message: string;
    }
  // #213: the bus event `session.error` (SDK EventSessionError). The model
  // never ran — a 403 DataPolicyError arrives here with isRetryable false —
  // and dropping it left an empty turn that the harness filed as
  // format_violation. Carries the provider's name, status, retry flag, and
  // message. responseBody stays off this event: it is not the witness, and
  // it is where a provider pastes request echoes.
  | {
      readonly kind: "provider_refusal";
      readonly name: string;
      readonly statusCode?: number;
      readonly retryable?: boolean;
      readonly message: string;
    }
  | { readonly kind: "terminal"; readonly proof: ProviderTerminalProof };

export type OpenCodePollResult =
  | { readonly kind: "pending" }
  | {
      readonly kind: "terminal";
      readonly proof: ProviderTerminalProof;
      readonly finalText?: string;
      readonly usage?: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly costUsd?: number;
      };
      readonly usageIncomplete?: boolean;
      // #214, reshaped by pr-hero review F001: the callIDs this observer has
      // EVER seen reach "completed", read off opencode-client.ts's
      // `OpenCodeTurnState.completedToolCallIds` — a set that only grows, so
      // a LATER readback reporting the same callID as "error" (or anything
      // else) can never make it vanish from this list. The previous shape
      // (`toolInvocations: number`, recomputed fresh from `toolStates` on
      // every poll) went DOWN exactly that way: `toolStates` stores the
      // provider's raw last-known status and a later "error" for an
      // earlier-"completed" call shrank the recount. Absent whenever this
      // poll produced no terminal at all; present on EVERY terminal this
      // poll reports, whether or not it goes on to win §197's slot — the
      // transport, not this observer, decides that. A poll-won turn is a
      // supported delivery path (`terminalFinalText` already mirrors it for
      // the answer text): the stream's own "tool" events only fire for a
      // completion the STREAM itself watched happen, so a hunter whose only
      // observer of a completed tool call was this poll readback would
      // otherwise be undercounted as zero and read as a hunt that never
      // looked. Real callIDs, not a count, so the transport can union this
      // with the stream's own observations by identity (F002) instead of
      // combining two disjoint counts.
      readonly completedToolCallIds?: readonly string[];
    }
  // The session itself failed, so no turn will ever produce a terminal. It is
  // NOT a terminal — the transport issues no proof of its own — and it is not
  // a failed observation either: it is a successful observation of a fact that
  // ends the attempt. The distinction is load-bearing. A poll that THROWS is
  // counted (`pollTimeouts += 1; continue`) and the loop runs on forever, so
  // reporting this by throwing would have swapped one silent hang for another.
  | { readonly kind: "failed"; readonly detail: string };

// Narrow injectable client shaped ONLY from what §197 (stream + poll
// arbitration) and §290 (abort without provider confirmation) require. No
// assumption about the real SDK's API is encoded here.
export interface OpenCodeClientLike {
  takeEvidence?(
    sessionId: string,
    attempt: number,
  ): import("../execution/contracts").DiagnosticEvidence | undefined;
  createSession(
    input: OpenCodeCreateSessionInput,
  ): Promise<OpenCodeClientSession>;
  streamEvents(
    session: OpenCodeClientSession,
  ): AsyncIterable<OpenCodeClientEvent>;
  pollStatus(
    session: OpenCodeClientSession,
    signal?: AbortSignal,
  ): Promise<OpenCodePollResult>;
  abort(session: OpenCodeClientSession): Promise<void>;
  close?(): Promise<void>;
}

// Injectable clock so conformance tests fire every deadline by hand and never
// sleep a real one (§13 line 746).
export interface OpenCodeTransportClock {
  nowMs?(): number;
  schedule(ms: number, fn: () => void): () => void;
}

const systemClock: OpenCodeTransportClock = {
  nowMs: () => performance.now(),
  schedule(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface OpenCodeSdkTransportOptions {
  readonly client: OpenCodeClientLike;
  readonly stallDeadlineMs?: number;
  readonly abortConfirmMs?: number;
  readonly cleanupMs?: number;
  readonly maxDeltaBytes?: number;
  readonly maxFinalTextBytes?: number;
  readonly pollIntervalMs?: number;
  readonly pollRoundMs?: number;
  readonly maxDrainCycles?: number;
  // Optional legacy test tripwire; production uses usefulProgressMs.
  readonly maxQuietRounds?: number;
  readonly usefulProgressMs?: number;
  readonly setupDeadlineMs?: number;
  readonly clock?: OpenCodeTransportClock;
  readonly nowIso?: () => string;
  // 2026-09-02: how the ROUTE this transport serves bills, stamped onto every
  // usage record it emits. Derived by the registry factory from the
  // credential kind the authority resolved (`credentialKindBillsMetered`,
  // runner-authority.ts) — the transport cannot derive it, holding no
  // credential and, since #137's note, no route.
  //
  // Defaults to "subscription" rather than "unknown" so an unconfigured
  // construction is byte-identical to what this file hardcoded before, and
  // because the factory branch that omits the kind is the SAME branch that
  // defaults the route to `openai/gpt-4o` — an OAuth, subscription-billed
  // route. A default of "unknown" would make the two disagree.
  //
  // That "SAME branch" is a guarantee only since 2026-09-02, and it was
  // written here before it was true: `FrozenRuntimeBinding.acquire()` used to
  // forward the route without the kind, so a registry built without a
  // construction-time `credentialKind` served a real metered route while this
  // default stamped it "subscription". `acquire()` now forwards the pair, so
  // through it — the only production caller that names a route — omitting the
  // kind really does mean omitting the route, and this default only ever
  // describes a caller holding no binding at all. `StepExecutionHarness`'s own
  // registry branch still passes a route without a kind, but no composition in
  // src/ reaches it: both harness constructions supply an explicit transport.
  readonly billingMode?: UsageBillingMode;
  readonly admissionIdentity?: {
    readonly executable: string;
    readonly provider: string;
  };
  readonly defaultRoute?: ResolvedModelRoute;
}

const MARKER_ABORT_UNCONFIRMED =
  "[pr-hero] opencode sdk: abort requested but the provider supplied no terminal proof within the confirmation window; remote state unknown_may_continue";
const MARKER_STALL =
  "[pr-hero] opencode sdk: event sink push stalled past the declared stall deadline";
const MARKER_BOUND_DELTA =
  "[pr-hero] opencode sdk: delta exceeded the hard per-delta content bound";
const MARKER_BOUND_AGGREGATE =
  "[pr-hero] opencode sdk: aggregate finalText exceeded the hard aggregate content bound";
const MARKER_USAGE_FLIP =
  "[pr-hero] opencode sdk: usage aggregation mode changed after the first usage event fixed it";

const MARKER_CONFLICT =
  "[pr-hero] opencode sdk: conflicting provider terminal observed after the compare-and-set slot was won";
// Already the literal prefix of the stderrTail this transport writes when
// createSession throws; naming it here makes it a classification witness too.
const MARKER_SESSION_CREATE = "[pr-hero] opencode sdk: session creation failed";
// Already the literal text the client puts on the error it hands the stream
// when session.prompt is refused (opencode-client.ts, via unwrap); naming it
// here makes it a classification witness too. The coupling is pinned by an
// end-to-end test rather than by this constant —
// test/conformance/opencode-resolved-error-arm.test.ts drives a refusal
// through the real client and asserts what comes out here.
const MARKER_PROMPT_REFUSED = "opencode session.prompt failed";
// #132, and #124's sibling in CAUSE rather than in fact: that one says the
// turn reasoned and never opened a text part, this one says it opened one and
// was cut off mid-delivery. Both map to `protocol_truncation` because a FRESH
// attempt is the only remedy that can work on either.
//
// Deliberately digit-free and worded clear of every classifier pattern: it
// shares the witness with the provider's own text, so a marker that reads like
// a rate limit or a socket error would decide the cause instead of reporting
// the fact (#126).
const MARKER_UNDELIVERED_CONTENT =
  "[pr-hero] opencode sdk: the drain budget expired while the stream was still delivering; the answer is incomplete";
// #124. Distinct from an empty answer in general: this says the turn REASONED
// and never opened a text part, so there is no malformed output to reformat
// and the format-reminder budget would be spent on nothing — the same argument
// that made a turn which never started `runtime_unavailable` (#121, #123).
// The cause it maps to differs, though, and deliberately: the runtime WAS
// available and the model DID run, so the honest fact is that the answer
// channel delivered no content. See classifyFailure.
const MARKER_REASONING_ONLY =
  "[pr-hero] opencode sdk: the turn completed with reasoning parts only and no answer text part";
// Martian `opencode` arm, 2026-09-10: the provider-silence tripwire below.
// Maps to `protocol_truncation` beside the undelivered-content marker: the
// channel went quiet mid-delivery (or before any delivery), and a FRESH
// attempt on the transient budget is the only remedy that can work.
//
// Deliberately digit-free per #126 (shares the witness with provider text).
const MARKER_SILENCE =
  "[pr-hero] opencode sdk: the provider stream delivered no content event for the whole quiet-round budget; the answer is incomplete";
// #157: pr-157-8df2fca3-4's complete capture — OpenCode reported an
// account_rate_limit retry status (`5 hour usage limit reached...`) for our
// own session ~3.8s into the attempt, kept retrying internally, and never
// delivered another reasoning/text/usage event. The attempt sat quiet for
// the whole usefulProgressMs budget before the silence tripwire settled it
// $0/transient — the user saw "silence", never the account limit the
// provider had already named. A spent quota cannot be outrun by a fresh
// attempt, unlike silence or a transient stall, so this is fail-fast.
//
// Digit-free per #126 (the marker shares its witness with the provider's own
// text, appended verbatim by formatProviderLimitDetail below): a prefix that
// read like a rate limit or a socket error would let classifyFailure's
// generic patterns decide the cause instead of this fact.
const MARKER_PROVIDER_LIMIT =
  "[pr-hero] opencode sdk: provider usage limit reached";

// Shared by both observers of this fact — opencode-client.ts's stream
// mapping (a `provider_limit` OpenCodeClientEvent) and its status poll (a
// `{kind:"failed"}` OpenCodePollResult) — so the exact classification witness
// is defined once rather than duplicated as a literal in two files.
export function formatProviderLimitDetail(
  reason: string,
  message: string,
): string {
  return `${MARKER_PROVIDER_LIMIT} (${reason}): ${message}`;
}

// #213. Digit-free prefix, same rule as MARKER_PROVIDER_LIMIT: the provider's
// own message is appended after it, and a prefix that read like a rate limit
// or a socket error would let the generic patterns decide the cause.
const MARKER_PROVIDER_REFUSAL =
  "[pr-hero] opencode sdk: provider refused the turn";

// The message is the operator's only copy of the opt-in sentence. URLs stay
// (that sentence IS a URL). Credentials do not: redactDiagnostic runs before
// the line is a witness. Capped so a provider that pastes a body into
// `data.message` cannot fill the stderr tail by itself.
const PROVIDER_REFUSAL_MESSAGE_MAX = 500;

export function formatProviderRefusalDetail(input: {
  readonly name: string;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly message: string;
}): string {
  const status =
    input.statusCode === undefined ? "unknown" : String(input.statusCode);
  // The flag is the first token after the marker, before any provider-owned
  // field. classifyFailure reads only that token. `name` and `message` are
  // the provider's, and a message that happens to say "isRetryable: true"
  // must not flip a terminal refusal into a retry.
  const retryable = input.retryable === true ? "yes" : "no";
  const message = redactDiagnostic(input.message).slice(
    0,
    PROVIDER_REFUSAL_MESSAGE_MAX,
  );
  return `${MARKER_PROVIDER_REFUSAL} retryable=${retryable} (${input.name} status=${status}): ${message}`;
}

// The flag occupies a fixed slot immediately after the marker. Reading
// anywhere else in the witness would let the provider's own message decide
// the disposition (#213 review).
function providerRefusalRetries(witness: string): boolean | undefined {
  const at = witness.indexOf(MARKER_PROVIDER_REFUSAL);
  if (at < 0) return undefined;
  const rest = witness.slice(at + MARKER_PROVIDER_REFUSAL.length);
  if (rest.startsWith(" retryable=yes")) return true;
  if (rest.startsWith(" retryable=no")) return false;
  return undefined;
}

// The provider's HTTP status, read from the fixed `status=` slot inside the
// `(<name> status=<code>)` group that follows the retryable flag. The name is
// the provider's own text, so the match is anchored right after the flag and
// stops at the group's close paren: a message that says "status=404" cannot
// reach this slot. "unknown" (no status was reported) returns undefined.
function providerRefusalStatus(witness: string): string | undefined {
  const at = witness.indexOf(MARKER_PROVIDER_REFUSAL);
  if (at < 0) return undefined;
  const rest = witness.slice(at + MARKER_PROVIDER_REFUSAL.length);
  const slot = rest.match(
    /^ retryable=(?:yes|no) \([^()]* status=(\d+|unknown)\): /,
  );
  return slot?.[1] === "unknown" ? undefined : slot?.[1];
}

// #157 (pr-157-8df2fca3-6): a hunter's tool call for a path OUTSIDE the
// reviewed worktree tripped `permission.asked` for `external_directory`
// twice in one run, and pr-hero never answered OpenCode's permission prompt
// — the tool call sat blocked until the silence tripwire killed the attempt
// 150s later at $0. opencode-client.ts rejects any own-session permission
// prompt as defense in depth beside the server-side `deny` config
// (opencode-server.ts); THIS marker fires only when that reject itself could
// not be delivered — the one case the config cannot cover, since it needs a
// working SDK call to answer the prompt at all. No retry can fix a control
// that failed to execute, so this is terminal, not `protocol_truncation`.
const MARKER_PERMISSION_REJECT_FAILED =
  "[pr-hero] opencode sdk: failed to reject an OpenCode permission request";

export function formatPermissionRejectFailureDetail(
  permission: string,
  patterns: readonly string[],
  errorMessage: string,
): string {
  return `${MARKER_PERMISSION_REJECT_FAILED} (${permission} ${JSON.stringify(patterns)}): ${errorMessage}`;
}

type SettleReason =
  // #132: `drained` records whether the stream had gone QUIET when the
  // post-win window closed. False means the drain budget ran out with content
  // still arriving — a provider terminal over an unfinished delivery, which is
  // the one shape of this reason that must never report success.
  | { readonly kind: "provider_terminal"; readonly drained: boolean }
  | { readonly kind: "conflict"; readonly detail: string }
  | { readonly kind: "usage_flip"; readonly detail: string }
  | { readonly kind: "bound"; readonly target: "delta" | "aggregate" }
  | { readonly kind: "stall" }
  | { readonly kind: "silence" }
  | { readonly kind: "stream_error"; readonly detail: string }
  | { readonly kind: "session_failed"; readonly detail: string }
  | { readonly kind: "abort_confirmed" }
  | { readonly kind: "abort_unconfirmed" };

type PushResult = "accepted" | "closed" | "stalled";

// Sentinel for the stream watcher's race against settlement.
const STREAM_SETTLED = "stream_settled" as const;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// The tail bound is declared in BYTES, so it is enforced in bytes. String
// .slice counts UTF-16 code units, which lets multi-byte provider text run
// past the bound the transport claims.
//
// Keeping the last maxBytes bytes can tear a multi-byte sequence at the head,
// and decoding that orphan does not merely lose a character — it GROWS the
// result: every stray continuation byte becomes a U+FFFD, which is three
// bytes in UTF-8, so a byte-exact cut can come back over the bound. The head
// is therefore advanced past any continuation bytes (0b10xxxxxx) to land on a
// real character boundary, which can only shorten the tail.
function boundTailBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return new TextDecoder().decode(bytes.slice(start));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Session creation failing means no attempt ever reached the provider —
// genuine zero cost, not "unavailable" (which would misfile a $0 refusal as
// an unresolved spend now that PR5b's spend ledger does read completeness).
//
// 2026-09-02: it carries the ROUTE's billing mode like every other usage
// record here, metered included. That is safe precisely because `tokens` is
// empty — `settlementFromUsage`'s metered-zero rule gates on output tokens,
// so this stays settleable at 0 while a metered attempt that actually
// produced output does not.
function noSessionUsage(
  wallMs: number,
  billingMode: UsageBillingMode,
): NormalizedUsage {
  return {
    wallMs,
    tokens: {},
    completeness: "complete",
    billingMode,
    costSource: "provider",
    cashCostUsd: 0,
  };
}

// A prompt refusal that arrived before any provider event: the failure
// detail IS the refusal (session.prompt rejected at call time —
// opencode-client.ts: a refused prompt creates no message and therefore no
// events), and not a single delta, reasoning part, tool invocation, or usage
// event was ever observed. The model provably never started, so the
// noSessionUsage assertion holds exactly as it does for session-creation
// failure. Anything else — a refusal after partial delivery, a non-refusal
// stream death, a poll-observed failure with no refusal text — keeps the
// fail-closed "unavailable".
function promptRefusedBeforeStart(
  reason: SettleReason,
  finalPartsLength: number,
  sawReasoning: boolean,
  sawContentEvent: boolean,
): boolean {
  if (reason.kind !== "stream_error" && reason.kind !== "session_failed") {
    return false;
  }
  if (!reason.detail.includes(MARKER_PROMPT_REFUSED)) {
    return false;
  }
  if (finalPartsLength !== 0 || sawReasoning || sawContentEvent) {
    return false;
  }
  // A dispatched request may fail after provider work began. Text (including
  // incidental HTTP-looking numbers) is not authoritative nonexecution proof.
  return false;
}

// Matching means the poll observes the SAME terminal identity the slot already
// holds: identical eventId AND providerStatus. Anything else is a conflicting
// terminal, which §197 says makes the outcome malformed rather than being
// selected by arrival order.
function sameTerminal(
  a: ProviderTerminalProof,
  b: ProviderTerminalProof,
): boolean {
  return a.eventId === b.eventId && a.providerStatus === b.providerStatus;
}

// §197: only a VALID provider terminal proof may win the slot.
function isValidProof(proof: ProviderTerminalProof): boolean {
  return (
    proof.eventId.length > 0 &&
    proof.providerStatus.length > 0 &&
    proof.providerObservedAt.length > 0
  );
}

export class OpenCodeSdkTransport implements ProviderTransport {
  readonly backend = "opencode" as const;
  readonly admissionIdentity: {
    readonly executable: string;
    readonly provider: string;
  };
  readonly cancellationSemantics = "provider-proof" as const;
  // #150: this transport never reads `TransportRequest.isolation` — its
  // server owns ONE credential projection for the server's whole lifetime
  // (#149, brokered by `OpenCodeAuthBroker`/`OpenCodeFreeBroker` before the
  // server ever launches), not a fresh one per step. Declaring
  // "server-lifetime" tells `StepExecutionHarness.run` to skip the per-step
  // broker call for every attempt this transport executes — no auth file
  // materialized and destroyed for nothing, no false
  // `missing_subscription_record` degrade for a projection that was never
  // attempted.
  readonly credentialProjection = "server-lifetime" as const;
  readonly defaultRoute?: ResolvedModelRoute;
  private readonly client: OpenCodeClientLike;
  private readonly stallDeadlineMs: number;
  private readonly abortConfirmMs: number;
  private readonly cleanupMs: number;
  private readonly maxDeltaBytes: number;
  private readonly maxFinalTextBytes: number;
  private readonly pollIntervalMs: number;
  private readonly pollRoundMs: number;
  private readonly maxDrainCycles: number;
  private readonly maxQuietRounds: number;
  private readonly usefulProgressMs: number;
  private readonly setupDeadlineMs: number;
  private readonly clock: OpenCodeTransportClock;
  private readonly nowIso: () => string;
  // Public and readonly on purpose. #149's forwarding "guarantee" shipped
  // dead twice because nothing outside the registry could observe it, and a
  // billing mode derived from a credential kind inside a factory has exactly
  // that shape. Reading it is how `test/route-admission.test.ts` proves the
  // factory wired the kind through, without driving a whole attempt.
  readonly usageBillingMode: UsageBillingMode;
  get billingMode(): UsageBillingMode {
    return this.usageBillingMode;
  }

  constructor(options: OpenCodeSdkTransportOptions) {
    this.admissionIdentity = options.admissionIdentity ?? {
      executable: "opencode",
      provider: "opencode",
    };
    this.cancellationSemantics = "provider-proof";
    this.defaultRoute = options.defaultRoute;
    this.client = options.client;
    this.stallDeadlineMs = options.stallDeadlineMs ?? DEFAULT_STALL_DEADLINE_MS;
    this.abortConfirmMs = options.abortConfirmMs ?? SDK_ABORT_CONFIRM_MS;
    this.cleanupMs = options.cleanupMs ?? SDK_CLEANUP_MS;
    this.maxDeltaBytes = options.maxDeltaBytes ?? MAX_DELTA_BYTES;
    this.maxFinalTextBytes = options.maxFinalTextBytes ?? MAX_FINAL_TEXT_BYTES;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollRoundMs = options.pollRoundMs ?? DEFAULT_POLL_ROUND_MS;
    this.maxDrainCycles = options.maxDrainCycles ?? DEFAULT_MAX_DRAIN_CYCLES;
    this.maxQuietRounds = options.maxQuietRounds ?? Number.POSITIVE_INFINITY;
    this.clock = options.clock ?? systemClock;
    this.usefulProgressMs =
      options.usefulProgressMs ?? DEFAULT_USEFUL_PROGRESS_MS;
    this.setupDeadlineMs = options.setupDeadlineMs ?? 10_000;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.usageBillingMode = options.billingMode ?? "subscription";
  }

  // §11/D1-09 honesty: every unimplemented feature is claimed false with a
  // non-blocking issue, never assumed green — hence status "degraded", not
  // "ready". The real adapter, credential route, and pricing table are D1-11.
  async capabilities(
    input?: OpenCodeCapabilitiesInput,
  ): Promise<ProviderCapabilityReport> {
    return {
      backend: "opencode",
      status: "degraded",
      auth: {
        kind: "opencode_chatgpt_oauth",
        projectionReady: true,
        probe: "passed",
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: true,
        codegraphPolicy: false,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: true,
        usageMode: "none",
      },
      cancellation: {
        deadlineMs:
          this.abortConfirmMs + this.cleanupMs + SDK_DEADLINE_MARGIN_MS,
        conformance: "passed",
      },
      billing: {
        mode: "subscription",
        // 2026-09-02: `true`, because this transport reports PROVIDER COST.
        //
        // The design's metered rule (§8, docs/multi-runtime-model-diversity-
        // design.md line 461) is a disjunction and its order is the point:
        // "Metered routes require provider cost or a versioned rate-table
        // calculation." Provider cost is named FIRST — it is the primary
        // path; the rate table is the fallback for a transport that reports
        // nothing. `tokenPricingAvailable` in production-runtime.ts has read
        // both disjuncts since #137.
        //
        // This transport satisfies the first one. The OpenCode SDK's
        // `AssistantMessage` carries a NON-OPTIONAL `cost: number` (and so
        // does `StepFinishPart`); `opencode-client.ts` reads it off every
        // assistant message, this file accumulates it across the turn, and
        // the outcome's usage carries it as `cashCostUsd` with
        // `costSource: "provider"`. That is a provider-reported cost for
        // whatever model the route named, with no table involved — which is
        // why it holds for all of models.dev, not the two providers we bundle
        // a table for, and why it does not expire.
        //
        // What this REPLACES, because the old reasoning was not wrong so much
        // as aimed at the wrong disjunct: it argued that no model id is in
        // scope here, that the factory hands this transport only `{ client }`,
        // and that an Anthropic catalogue would not cover `openai/gpt-4o`
        // anyway. Every clause of that is true OF THE RATE TABLE, which this
        // transport genuinely cannot consult — and none of it bears on
        // provider cost, which needs no model id because the provider prices
        // its own call. Applying a table's limitation to the cost path left
        // the design's primary source unconnected, so a metered route on any
        // model outside the two bundled catalogues was refused as unpriceable
        // while the provider was reporting its price on every message.
        //
        // #197: the claim is no longer scoped to this transport. The
        // claude-code CLI reports `total_cost_usd`, so its transport and its
        // backend-wide producer now answer `true` for the same reason this
        // one does. The remaining `false` is transport-registry.ts's
        // synthetic report for a backend whose transport could not be
        // CONSTRUCTED — no transport, so no claim.
        pricingReady: true,
      },
      ...(input !== undefined
        ? {
            rateLimitBucketId: deriveBucketId(
              {
                provider: BUCKET_IDENTITY_PROVIDER,
                credentialFingerprint: input.credentialFingerprint,
                scope: input.bucketScope,
              },
              input.localKey,
            ),
          }
        : {}),
      issues: [
        {
          code: "codegraph_policy_unenforced",
          message:
            "no dedicated codegraph sensitive-file policy is enforced for this backend yet",
          blocking: false,
        },
        {
          code: "usage_mode_client_reported",
          message:
            "usage aggregation mode (§4.2 line 195) is fixed at runtime by the first client usage event, so no static snapshot/delta claim can be defended; usageMode is 'none'",
          blocking: false,
        },
        {
          // NOTIONAL cost, a different fact from the cash cost above: what a
          // subscription attempt WOULD have cost metered. No route is in
          // scope here to name a model, and since #197 there is no bundled
          // table to look one up in either — a subscription attempt's
          // notional figure now comes from whatever the transport reports for
          // the attempt, not from this report.
          //
          // #197 removed this list's OTHER `pricing_table_missing` entry,
          // which said no bundled table could be consulted from here: both
          // halves of it died with the tables, and a "missing table" issue
          // beside `pricingReady: true` read as a contradiction.
          code: "pricing_table_missing",
          message:
            "no route is in scope here, so notional cost cannot be derived for this backend's models; subscription cash cost stays 0",
          blocking: false,
        },
      ],
    };
  }

  async execute(
    request: TransportRequest,
    context: { readonly signal: AbortSignal; readonly events: AsyncEventSink },
  ): Promise<TransportOutcome> {
    const outcome = await this.executeAttempt(request, context);
    try {
      const diagnosticEvidence = this.client.takeEvidence?.(
        request.sessionId,
        request.attempt,
      );
      return diagnosticEvidence ? { ...outcome, diagnosticEvidence } : outcome;
    } catch {
      return outcome;
    }
  }

  private async executeAttempt(
    request: TransportRequest,
    context: { readonly signal: AbortSignal; readonly events: AsyncEventSink },
  ): Promise<TransportOutcome> {
    // `notes` becomes stderrTail, which is the classification WITNESS: the
    // markers this transport stamps, plus the provider's own words verbatim.
    // Nothing else belongs in it.
    const notes: string[] = [];
    // #126: our own observation tallies. Same attempt log, different channel,
    // and NO classifier reads this one — see TransportOutcome.diagnosticsTail
    // for the measured collisions that made the separation necessary.
    const diagnostics: string[] = [];
    const startedWall = Date.now();
    let seq = 0;
    const nextSeq = () => {
      const value = seq;
      seq += 1;
      return value;
    };
    const base = (): ProviderEventBase => ({
      sessionId: request.sessionId,
      attempt: request.attempt,
      seq: nextSeq(),
      observedAt: this.nowIso(),
    });

    let settled = false;
    let resolveDone!: (reason: SettleReason) => void;
    const done = new Promise<SettleReason>((resolve) => {
      resolveDone = resolve;
    });
    const settle = (reason: SettleReason): void => {
      if (settled) return;
      settled = true;
      resolveDone(reason);
    };

    const cancellers = new Set<() => void>();
    const scheduleTracked = (ms: number, fn: () => void): void => {
      const cancel = this.clock.schedule(ms, () => {
        cancellers.delete(cancel);
        fn();
      });
      cancellers.add(cancel);
    };
    const delay = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        scheduleTracked(ms, resolve);
      });

    // §4.2 line 188: producers await every push — no fire-and-forget. Each
    // push races the declared stall deadline; losing the race is the
    // §4.2 line 189 protocol_overflow abort.
    const pushGuarded = async (event: ProviderEvent): Promise<PushResult> => {
      let cancelStall: (() => void) | undefined;
      try {
        const stalled = new Promise<"stalled">((resolve) => {
          cancelStall = this.clock.schedule(this.stallDeadlineMs, () =>
            resolve("stalled"),
          );
        });
        // A sink that throws (or rejects after the race decided) is treated as
        // closed: stop feeding it rather than crash a paid attempt.
        const pushed = context.events
          .push(event)
          .catch(() => "closed" as const);
        return await Promise.race([pushed, stalled]);
      } finally {
        cancelStall?.();
      }
    };

    // ---- #132 post-win drain window ---------------------------------------
    // `deltaSinceArm` is the whole delivery signal: set when a delta is picked
    // up by the stream watcher and cleared every time the window re-arms, so a
    // window that closes with it false saw a stream that said nothing for a
    // full cleanup budget. In real time that is decisive — the client hands
    // events over through an in-process queue, so a buffered delta reaches the
    // watcher within a microtask, never a timer.
    let deltaSinceArm = false;
    let drainCyclesLeft = 0;
    const armDrainWindow = (): void => {
      deltaSinceArm = false;
      scheduleTracked(this.cleanupMs, () => {
        if (settled) return;
        if (!deltaSinceArm) {
          settle({ kind: "provider_terminal", drained: true });
          return;
        }
        if (drainCyclesLeft <= 0) {
          settle({ kind: "provider_terminal", drained: false });
          return;
        }
        drainCyclesLeft -= 1;
        armDrainWindow();
      });
    };

    // ---- provider-silence tripwire (Martian `opencode` arm, 2026-09-10) ----
    // Counts consecutive poll rounds with no content event; heartbeats do not
    // reset — a keepalive-only session is the hung shape. Tripping settles
    // `silence` (fresh transient attempt), capping a hung provider well under
    // the 30-min harness watchdog. A timed-out round counts: an unobservable
    // server beside a silent stream is the same hung shape, and the remedy
    // (bounded retry) is the same.
    let quietRounds = 0;
    let contentSinceRound = false;
    const nowMs = () => this.clock.nowMs?.() ?? performance.now();
    let lastUsefulProgressWall = nowMs();
    const noteContentEvent = (): void => {
      contentSinceRound = true;
      lastUsefulProgressWall = nowMs();
    };

    // ---- §197 terminal compare-and-set slot -------------------------------
    let slotProof: ProviderTerminalProof | undefined;
    let pollConfirmations = 0;
    let invalidProofs = 0;
    let terminalFinalText: string | undefined;
    let terminalUsage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          costUsd?: number;
        }
      | undefined;
    let terminalUsageIncomplete = false;

    const onProviderTerminalCandidate = (
      proof: ProviderTerminalProof,
      source: "stream" | "poll",
      finalText?: string,
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        costUsd?: number;
      },
      incompleteUsage?: boolean,
      polledCompletedCallIds?: readonly string[],
    ): void => {
      if (settled) return;
      if (!isValidProof(proof)) {
        invalidProofs += 1;
        diagnostics.push(
          `[pr-hero] opencode sdk: ignored invalid ${source} terminal proof (missing identity fields); it could not win the slot`,
        );
        return;
      }
      if (finalText !== undefined) {
        terminalFinalText = finalText;
      }
      if (usage !== undefined) {
        terminalUsage = usage;
      }
      if (incompleteUsage === true) {
        terminalUsageIncomplete = true;
      }
      // pr-hero review F001: UNION, never overwrite. `completedCallIds` (the
      // one canonical per-attempt tally, declared below with the stream's own
      // writer) only ever grows — a CONFIRMING poll of an already-won
      // terminal (reachable right here, on the `sameTerminal` branch further
      // down, not just on the first win) used to overwrite the running total
      // with whatever this specific readback's fresh recount said, and a
      // recount can be smaller than an earlier one for the same set of real
      // completions. Adding to the set instead means a later, poorer
      // observation can only ever be a no-op, never a regression.
      if (polledCompletedCallIds !== undefined) {
        for (const id of polledCompletedCallIds) completedCallIds.add(id);
      }
      if (slotProof === undefined) {
        slotProof = proof;
        if (abortSequenceStarted) {
          // §5.2 line 272: the provider confirmed the abort inside the
          // confirmation window. Settle at once — adding the normal drain
          // window here would overrun the 6,500 ms harness deadline.
          settle({ kind: "abort_confirmed" });
          return;
        }
        // Post-win window, with TWO purposes now.
        //
        // §197's, which came first: a later conflicting terminal must be able
        // to flip the outcome malformed, so settlement is held open for one
        // cleanup budget before the win is recorded.
        //
        // #132's: the other observer may still be delivering this turn's
        // answer. The poll reaches the boundary from `/session/status` while
        // the stream is mid-delivery, and a window that simply expired
        // reported success over a truncated finalText — silently, since the
        // proof is valid and the completion is real. So the window now asks
        // whether the stream went quiet, and re-arms while it has not.
        //
        // This does NOT couple the observers. What §197 keeps independent is
        // the EVIDENCE — `observedActive` is owned by the poll and is never
        // armed from the stream (opencode-client.ts), because two observers of
        // one derived fact are not two observers. "Have you finished
        // delivering?" is a question about DELIVERY, and the answer changes no
        // observer's verdict about when the turn ended.
        drainCyclesLeft = this.maxDrainCycles;
        armDrainWindow();
        return;
      }
      if (sameTerminal(slotProof, proof)) {
        // §197: polling may confirm a matching terminal but never creates a
        // second one.
        pollConfirmations += 1;
        return;
      }
      settle({
        kind: "conflict",
        detail: `${source} terminal ${proof.eventId}/${proof.providerStatus} conflicts with ${slotProof.eventId}/${slotProof.providerStatus}`,
      });
    };

    // ---- session -----------------------------------------------------------
    if (context.signal.aborted) {
      return {
        completion: "cancelled",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: noSessionUsage(Date.now() - startedWall, this.usageBillingMode),
        stderrTail: "[pr-hero] opencode sdk: cancelled before session creation",
      };
    }

    let session: OpenCodeClientSession;
    let removeAbort: (() => void) | undefined;
    let cancelSetup: (() => void) | undefined;
    let setupTimedOut = false;
    const operation = new AbortController();
    const cancelOperation = () => operation.abort();
    context.signal.addEventListener("abort", cancelOperation, { once: true });
    let createPromise: Promise<OpenCodeClientSession> | undefined;
    try {
      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => {
          context.signal.removeEventListener("abort", onAbort);
        };
      });

      const setupTimeoutPromise = new Promise<never>((_, reject) => {
        cancelSetup = this.clock.schedule(this.setupDeadlineMs, () => {
          setupTimedOut = true;
          operation.abort();
          reject(new Error("opencode sdk: session creation deadline exceeded"));
        });
      });

      // `request.effort` is deliberately NOT forwarded. Effort is a Claude Code
      // CLI control (`claude --effort`, #299); OpenCode's closest equivalent is
      // per-model reasoning variants, whose levels differ by provider and are
      // not the same scale, so mapping one onto the other here would invent a
      // meaning. That is a separate decision. What this backend does instead is
      // honest about it: the request plan still records the level the engine
      // asked for, with `effortApplied: false` (attempt-evidence.ts), and
      // pipeline.json says `effort_applied: false`.
      createPromise = this.client.createSession({
        correlation: { sessionId: request.sessionId, attempt: request.attempt },
        signal: operation.signal,
        cwd: request.cwd,
        userPrompt: request.userPrompt,
        systemPromptPath: request.systemPromptPath,
        tools: request.tools,
        ...(request.mcpConfigPath !== undefined
          ? { mcpConfigPath: request.mcpConfigPath }
          : {}),
      });

      session = await Promise.race([
        createPromise,
        abortPromise,
        setupTimeoutPromise,
      ]);
    } catch (error) {
      operation.abort();
      context.signal.removeEventListener("abort", cancelOperation);
      if (createPromise !== undefined) {
        void createPromise
          .then((s) => void this.client.abort(s))
          .catch(() => {});
      }
      if (
        context.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return {
          completion: "cancelled",
          protocolIntegrity: "unverified",
          finalText: "",
          usage: normalizeUnavailableUsage({
            wallMs: Date.now() - startedWall,
            billingMode: this.usageBillingMode,
          }),
          stderrTail:
            "[pr-hero] opencode sdk: cancelled during session creation",
        };
      }
      // Redaction of any provider text happens harness-side before persistence;
      // here the message is only classification witness (§6.3).
      return {
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: setupTimedOut
          ? normalizeUnavailableUsage({
              wallMs: Date.now() - startedWall,
              billingMode: this.usageBillingMode,
            })
          : noSessionUsage(Date.now() - startedWall, this.usageBillingMode),
        stderrTail: `[pr-hero] opencode sdk: session creation failed: ${errorMessage(error)}`,
        // WHY the typed error, not the message: the server launch projects the route's
        // credential, and a provider with no record in the auth store is a typed broker
        // refusal. Its witness text would classify as runtime_unavailable, the generic
        // cause, so the instance carries the one class this transport can name.
        ...(error instanceof CredentialProjectionError &&
        error.failureClass === "missing_provider_record"
          ? { failureCause: "missing_provider_record" as const }
          : {}),
      };
    } finally {
      removeAbort?.();
      cancelSetup?.();
    }

    // ONE line per attempt (#122), so the tools/MCP axis is provable by
    // reading the artifact rather than trusting `allowMapEnforced: true`.
    // Keys are sorted so the line is byte-stable across runs.
    //
    // On the diagnostics channel, not the witness (#126). This line records
    // what WE resolved, and it interpolates a provider-supplied id vocabulary
    // we do not control — the two properties that make a witness lie. It used
    // to sit in `notes` under a caveat asking every future author to check
    // that no new id trips a classifyFailure pattern ("invalid" alone does not
    // match `invalid api key`, nothing here looks like a rate limit or a
    // socket error). That caveat is now unnecessary rather than merely
    // satisfied: no classifier reads this channel, so no id CAN misclassify an
    // attempt, and the line is free to widen.
    if (session.toolMap !== undefined) {
      const rendered = Object.keys(session.toolMap)
        .sort()
        .map((id) => `${id}=${session.toolMap?.[id] === true}`)
        .join(",");
      diagnostics.push(
        `[pr-hero] opencode sdk: resolved tool map: ${rendered}`,
      );
    }

    // ---- mutable attempt state --------------------------------------------
    const finalParts: string[] = [];
    let aggregateBytes = 0;
    // #124: the bare fact, not a volume. Nothing about reasoning is added to
    // `aggregateBytes` either — reasoning is not the answer, so it must not
    // consume the answer's §4.2 content budget.
    let sawReasoning = false;
    // #214: always stamped, including 0 — see the "tool" case below and the
    // outcome construction further down.
    //
    // pr-hero review F001/F002: ONE canonical per-attempt set, keyed by the
    // provider's callID, that BOTH the stream ("tool" events below) and the
    // poll (`onProviderTerminalCandidate`'s `polledCompletedCallIds` above)
    // add to. It only ever grows: no overwrite (F001 — a later, poorer
    // observation cannot erase an earlier real completion) and no separate
    // counts combined by `Math.max` (F002 — two different calls, one per
    // observer, must both count, which a size comparison cannot tell apart
    // from the same call counted twice). `toolInvocations` is this set's
    // size, read once at settlement. Bounded transitively: every id here (a)
    // stream events carry the id `handlePartUpdated` computed off `part
    // .callID`/`partId`, already capped by opencode-client.ts's
    // MAX_TRACKED_PARTS via `toolStates`, and (b) poll reports are `Array
    // .from` of that same client-side capped set — this map never receives
    // an id from an unbounded source, so it needs no cap of its own.
    const completedCallIds = new Set<string>();
    // Hand-written test doubles script a bare `{kind:"tool"}` with no
    // `callId` (there is no real client behind them to compute one) — a
    // per-event counter keeps each such event counting as one distinct
    // invocation, exactly as it did before identity tracking existed.
    let syntheticToolEventId = 0;
    const completedToolIds: string[] = [];
    let sawContentEvent = false;
    const seenUsageIds = new Set<string>();
    let usageIncomplete = false;
    // §4.1/§8: the first usage event fixes the attempt's aggregation mode;
    // `applyUsageUpdate` is the pure snapshot-replaces/delta-accumulates state
    // machine, shared with every other transport that folds a usage stream.
    let usageState: UsageModeState | undefined;
    let cashCostUsd: number | undefined;
    let sinkClosed = false;
    let closedDataPlaneEvents = 0;
    let pollTimeouts = 0;
    let abortSequenceStarted = false;

    // Single-delivery guarantee for abort(): gated by abortSequenceStarted,
    // which both the signal path and the local-termination path consult.
    const callAbortOnce = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.cleanupMs);
        });
        await Promise.race([this.client.abort(session), timeoutPromise]);
      } catch (error) {
        notes.push(
          `[pr-hero] opencode sdk: abort call failed: ${errorMessage(error)}`,
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    // §5.2 line 272 abort sequence: abort() once, then wait up to
    // abortConfirmMs for a PROVIDER terminal proof. The abort request itself
    // can never win the §197 slot; only the provider's own proof can.
    const runAbortSequence = (): void => {
      if (abortSequenceStarted || settled) return;
      abortSequenceStarted = true;
      notes.push("[pr-hero] opencode sdk: abort requested");
      void callAbortOnce();
      if (slotProof !== undefined) {
        settle({ kind: "abort_confirmed" });
        return;
      }
      scheduleTracked(this.abortConfirmMs, () =>
        settle({ kind: "abort_unconfirmed" }),
      );
    };
    const onAbortSignal = (): void => {
      runAbortSequence();
    };
    if (context.signal.aborted) {
      runAbortSequence();
    } else {
      context.signal.addEventListener("abort", onAbortSignal, { once: true });
    }

    // Per-attempt step timeout is harness-owned (StepSpec.timeoutMs → watchdog
    // → AbortSignal). This transport reacts to the supplied signal only; it
    // does not arm its own attempt deadline from the request.

    // ---- stream watcher ----------------------------------------------------
    let streamIterator: AsyncIterator<OpenCodeClientEvent> | undefined;
    const runStream = async (): Promise<void> => {
      // NOT `for await`. execute() awaits `done`, never the watchers, so when
      // settlement is decided by the poll watcher or the attempt watchdog this
      // loop is parked inside next() — and its `if (settled)` guard only runs
      // once an event arrives. A provider that then goes quiet leaves the
      // subscription open forever. The poll watcher escapes because it wakes
      // on its own delay(); the stream watcher has no timer of its own, so it
      // is given one thing to race: settlement itself.
      //
      // Calling .return() from the outside would not have fixed it either —
      // on an async generator it queues BEHIND the pending next(), so a parked
      // watcher stays parked. Racing next() is what actually releases it.
      const iterator = this.client
        .streamEvents(session)
        [Symbol.asyncIterator]();
      streamIterator = iterator;
      // Attached ONCE: a per-iteration `done.then(...)` would pile a handler
      // onto `done` for every event a long stream delivers.
      const settledSignal = done.then(() => STREAM_SETTLED);
      let lastKnownTokens = 0;
      let lastKnownCost = 0;
      try {
        for (;;) {
          const step = await Promise.race([iterator.next(), settledSignal]);
          if (step === STREAM_SETTLED) return;
          if (step.done === true) break;
          const event = step.value;
          if (settled) return;
          // Provider-silence tripwire accounting: advance progress only on novel
          // delta text or strictly advanced usage tokens/cost. Heartbeats and
          // duplicate identical usage are keepalives, not signs of real delivery.
          let advancedProgress = false;
          if (event.kind === "delta") {
            if (event.text.length > 0) {
              advancedProgress = true;
            }
          } else if (event.kind === "reasoning" && event.progress === true) {
            advancedProgress = true;
          } else if (event.kind === "activity") {
            advancedProgress = true;
          } else if (event.kind === "usage") {
            const totalTokens =
              (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
            const cost = event.costUsd ?? 0;
            if (totalTokens > lastKnownTokens || cost > lastKnownCost) {
              advancedProgress = true;
              if (totalTokens > lastKnownTokens) lastKnownTokens = totalTokens;
              if (cost > lastKnownCost) lastKnownCost = cost;
            }
          }
          if (advancedProgress) {
            noteContentEvent();
            sawContentEvent = true;
          }
          switch (event.kind) {
            case "delta": {
              // #132: set BEFORE the push, not after it. The window must count
              // a delta the watcher is still handing to the sink, or a slow
              // consumer turns the one delta in flight into the one delta
              // lost — the same gap that let `finalParts.push` below run after
              // settlement had already frozen the answer.
              deltaSinceArm = true;
              const bytes = utf8Bytes(event.text);
              if (bytes > this.maxDeltaBytes) {
                // §4.2 line 191: the offending delta is dropped WHOLE — it is
                // never truncated into something parseable.
                settle({ kind: "bound", target: "delta" });
                return;
              }
              if (aggregateBytes + bytes > this.maxFinalTextBytes) {
                settle({ kind: "bound", target: "aggregate" });
                return;
              }
              const pushed = await pushGuarded({
                ...base(),
                type: "delta",
                text: event.text,
              });
              if (pushed === "stalled") {
                settle({ kind: "stall" });
                return;
              }
              if (pushed === "closed") {
                sinkClosed = true;
                closedDataPlaneEvents += 1;
              }
              if (settled) return;
              finalParts.push(event.text);
              aggregateBytes += bytes;
              break;
            }
            case "usage": {
              if (event.incomplete) {
                usageIncomplete = true;
              }
              if (event.id !== undefined) {
                if (seenUsageIds.has(event.id)) {
                  if (event.mode === "delta") {
                    break;
                  }
                }
                seenUsageIds.add(event.id);
              }
              // §4.2 line 195: the first usage event fixes the attempt's
              // aggregation mode; a later flip throws rather than silently
              // mixing snapshot and delta semantics.
              try {
                usageState = applyUsageUpdate(usageState, event.mode, {
                  ...(event.inputTokens !== undefined
                    ? { inputUncached: event.inputTokens }
                    : {}),
                  ...(event.outputTokens !== undefined
                    ? { outputVisible: event.outputTokens }
                    : {}),
                });
              } catch (error) {
                if (error instanceof UsageModeMismatchError) {
                  settle({ kind: "usage_flip", detail: error.message });
                  return;
                }
                throw error;
              }
              if (event.costUsd !== undefined) {
                cashCostUsd =
                  event.mode === "snapshot"
                    ? event.costUsd
                    : (cashCostUsd ?? 0) + event.costUsd;
              }
              const usage: Partial<NormalizedTokens> & {
                cashCostUsd?: number;
              } = {
                ...(event.inputTokens !== undefined
                  ? { inputUncached: event.inputTokens }
                  : {}),
                ...(event.outputTokens !== undefined
                  ? { outputVisible: event.outputTokens }
                  : {}),
                ...(event.costUsd !== undefined
                  ? { cashCostUsd: event.costUsd }
                  : {}),
              };
              const pushed = await pushGuarded({
                ...base(),
                type: "usage",
                mode: event.mode,
                final: event.final ?? false,
                usage,
              });
              if (pushed === "stalled") {
                settle({ kind: "stall" });
                return;
              }
              if (pushed === "closed") {
                sinkClosed = true;
                closedDataPlaneEvents += 1;
              }
              if (settled) return;
              break;
            }
            case "diagnostic": {
              const pushed = await pushGuarded({
                ...base(),
                type: "diagnostic",
                level: event.level,
                message: event.message,
              });
              if (pushed === "stalled") {
                settle({ kind: "stall" });
                return;
              }
              if (pushed === "closed") {
                sinkClosed = true;
                closedDataPlaneEvents += 1;
              }
              if (settled) return;
              break;
            }
            case "reasoning": {
              // Recorded, never forwarded. There is no sink push and no bound
              // check: nothing is being delivered and nothing is being spent —
              // the content was dropped at the client boundary and only this
              // one bit survives it.
              sawReasoning = true;
              break;
            }
            case "tool": {
              // Completed invocations only — the mapper dropped pending/error
              // and already dedupes by callID. Never a witness: tool ids ride
              // diagnosticsTail with the count, never `notes`.
              completedCallIds.add(
                event.callId ?? `synthetic-${syntheticToolEventId++}`,
              );
              if (event.tool !== undefined && event.tool.length > 0) {
                completedToolIds.push(event.tool);
              }
              break;
            }
            case "activity": {
              // Same shape as "reasoning" above: nothing to forward, nothing
              // to bound. The useful-progress credit was already taken above,
              // before this switch — there is nothing left to do here.
              break;
            }
            case "heartbeat": {
              const pushed = await pushGuarded({
                ...base(),
                type: "heartbeat",
              });
              if (pushed === "stalled") {
                settle({ kind: "stall" });
                return;
              }
              if (pushed === "closed") {
                sinkClosed = true;
                closedDataPlaneEvents += 1;
              }
              if (settled) return;
              break;
            }
            case "terminal": {
              onProviderTerminalCandidate(event.proof, "stream");
              if (settled) return;
              break;
            }
            case "provider_limit": {
              // #157: fail fast — no fresh attempt can outrun a spent quota,
              // unlike an ordinary stall or silence. Reuses `stream_error`
              // rather than a new SettleReason: the abort-trigger set and the
              // completion/protocolIntegrity mapping already give this exact
              // shape (failed, unverified, best-effort abort), and the
              // classification-critical text just needs to survive inside
              // `detail` for classifyFailure's substring match below.
              settle({
                kind: "stream_error",
                detail: formatProviderLimitDetail(event.reason, event.message),
              });
              return;
            }
            case "provider_refusal": {
              // #213: same settlement as the limit above, and for the same
              // reason. A provider that already refused the turn (403,
              // isRetryable false) must not sit until the silence tripwire
              // and must not be parsed as an empty draft. The drain window
              // is still open when this arrives after session.idle, and
              // settle() is first-write-wins — so this still beats an empty
              // terminal that has not closed yet.
              settle({
                kind: "stream_error",
                detail: formatProviderRefusalDetail(event),
              });
              return;
            }
          }
          if (settled) return;
        }
        // §197: a stream EOF is not a terminal proof and cannot win the slot.
        // Polling keeps running so the provider can still terminate the
        // attempt through the slot.
        notes.push(
          "[pr-hero] opencode sdk: stream EOF observed; EOF is not a terminal proof and cannot win the slot",
        );
      } catch (error) {
        settle({ kind: "stream_error", detail: errorMessage(error) });
      }
    };

    // ---- poll watcher ------------------------------------------------------
    let inFlightPoll: Promise<OpenCodePollResult | "round_timeout"> | undefined;
    const pollScriptRound = async (): Promise<
      OpenCodePollResult | "round_timeout"
    > => {
      let cancelRound: (() => void) | undefined;
      const roundController = new AbortController();
      const abortRound = () => roundController.abort();
      context.signal.addEventListener("abort", abortRound, { once: true });
      // After cancellation, fresh bounded polls may still confirm cessation.
      // Only the request in flight when cancellation arrives is interrupted.
      try {
        const timedOut = new Promise<"round_timeout">((resolve) => {
          cancelRound = this.clock.schedule(this.pollRoundMs, () =>
            resolve("round_timeout"),
          );
        });
        // A poll that throws is a failed observation, not a terminal.
        // A client ignoring AbortSignal must not accumulate requests. Keep its
        // promise occupying the slot until it actually settles.
        if (inFlightPoll === undefined) {
          inFlightPoll = this.client
            .pollStatus(session, roundController.signal)
            .catch(() => "round_timeout" as const)
            .finally(() => {
              inFlightPoll = undefined;
            });
        }
        return await Promise.race([
          inFlightPoll,
          timedOut,
          done.then(() => "round_timeout" as const),
        ]);
      } finally {
        cancelRound?.();
        roundController.abort();
        context.signal.removeEventListener("abort", abortRound);
      }
    };
    // Observe FIRST, delay BETWEEN rounds — never before the first one. The
    // poll observer can only read absence as a boundary once it has seen the
    // provider name this session through its own endpoint, and a full
    // pollIntervalMs of blindness at the start meant a turn finishing inside
    // that first interval was never observed working at all. Absence was then
    // all it ever saw, absence alone proves nothing (it is also what a wrong
    // status scope looks like), and the fallback that exists precisely for a
    // stream EOF without `session.idle` had no path to a terminal — the
    // attempt ran to the harness watchdog over a turn already sitting
    // completed in session.messages().
    //
    // This NARROWS that window to the provider's own busy-registration
    // latency, it does not close it: the prompt is fired-not-awaited, so a
    // first poll can still land before the server marks the session busy. No
    // sampling observer can do better without arming from the STREAM, and
    // that is forbidden by design (see SessionState.observedActive) — a status
    // scope that cannot see the session would then read step 1's completion as
    // the turn's terminal and reopen #127, trading a loud hang for a silent
    // truncation.
    //
    // The delay MOVED rather than being dropped, so every `continue` above it
    // had to go: a `continue` that now skips the delay is a busy loop.
    const runPoll = async (): Promise<void> => {
      for (;;) {
        if (settled) return;
        const result = await pollScriptRound();
        if (settled) return;
        if (result === "round_timeout") {
          // §197: a poll timeout cannot win the slot; it is only counted.
          pollTimeouts += 1;
        } else if (result.kind === "failed") {
          // §197's second observer, seeing the SAME fact the stream carries
          // when it is still alive to carry it. Settled, not counted: the
          // session cannot produce a terminal any more, so continuing to poll
          // for one would only wait out the harness watchdog.
          settle({ kind: "session_failed", detail: result.detail });
          return;
        } else if (result.kind === "terminal") {
          onProviderTerminalCandidate(
            result.proof,
            "poll",
            result.finalText,
            result.usage,
            result.usageIncomplete,
            result.completedToolCallIds,
          );
          if (settled) return;
        }
        if (settled) return;
        // Provider-silence tripwire accounting, closed here: one completed
        // round with no content event since the last one. A timed-out round
        // counts — §197 already says it proves nothing either way, and beside
        // a silent stream it is the same hung shape.
        if (contentSinceRound) {
          quietRounds = 0;
          contentSinceRound = false;
        } else {
          quietRounds += 1;
          const elapsedQuietMs = nowMs() - lastUsefulProgressWall;
          if (
            quietRounds >= this.maxQuietRounds ||
            elapsedQuietMs >= this.usefulProgressMs
          ) {
            settle({ kind: "silence" });
            return;
          }
        }
        if (settled) return;
        await delay(this.pollIntervalMs);
      }
    };

    // Re-arm against an absolute monotonic deadline, not a count of polls.
    const checkUsefulDeadline = (): void => {
      if (settled || slotProof !== undefined || abortSequenceStarted) return;
      const remaining =
        this.usefulProgressMs - (nowMs() - lastUsefulProgressWall);
      if (remaining <= 0) settle({ kind: "silence" });
      else scheduleTracked(remaining, checkUsefulDeadline);
    };
    lastUsefulProgressWall = nowMs();
    // Legacy timeless conformance clocks cannot drive elapsed-time alarms;
    // production and advancing-clock tests always supply monotonic nowMs.
    if (this.clock.nowMs !== undefined) {
      scheduleTracked(this.usefulProgressMs, checkUsefulDeadline);
    }
    const streamWatcher = runStream();
    const pollWatcher = runPoll();

    let outcome: TransportOutcome;
    try {
      const reason = await done;
      operation.abort();
      context.signal.removeEventListener("abort", cancelOperation);
      for (const cancel of [...cancellers]) cancel();
      cancellers.clear();
      context.signal.removeEventListener("abort", onAbortSignal);

      // Local terminations where the remote may still be producing: best-effort
      // abort so paid remote work is not abandoned silently. Confirmation is NOT
      // claimed unless a provider proof actually arrived.
      if (
        (reason.kind === "bound" ||
          reason.kind === "stall" ||
          reason.kind === "silence" ||
          reason.kind === "stream_error" ||
          reason.kind === "session_failed" ||
          reason.kind === "usage_flip") &&
        !abortSequenceStarted
      ) {
        abortSequenceStarted = true;
        await callAbortOnce();
      }

      if (reason.kind === "conflict")
        notes.push(`${MARKER_CONFLICT}: ${reason.detail}`);
      if (reason.kind === "usage_flip")
        notes.push(`${MARKER_USAGE_FLIP}: ${reason.detail}`);
      if (reason.kind === "bound") {
        notes.push(
          reason.target === "delta"
            ? `${MARKER_BOUND_DELTA}; attempt terminated, offending delta dropped whole`
            : `${MARKER_BOUND_AGGREGATE}; attempt terminated, offending delta dropped whole`,
        );
      }
      if (reason.kind === "stall") notes.push(MARKER_STALL);
      if (reason.kind === "stream_error") {
        notes.push(`[pr-hero] opencode sdk: stream errored: ${reason.detail}`);
      }
      if (reason.kind === "session_failed") {
        // Carries the provider's own words verbatim, which is what makes the
        // poll path classify exactly like the stream path — classifyFailure
        // substring-matches MARKER_PROMPT_REFUSED inside this detail rather
        // than pattern-matching this note's own wording.
        notes.push(
          `[pr-hero] opencode sdk: poll observed a session failure: ${reason.detail}`,
        );
      }
      if (reason.kind === "silence") notes.push(MARKER_SILENCE);
      if (reason.kind === "abort_unconfirmed")
        notes.push(MARKER_ABORT_UNCONFIRMED);
      if (
        reason.kind === "abort_confirmed" ||
        (abortSequenceStarted &&
          slotProof !== undefined &&
          !notes.includes(
            "[pr-hero] opencode sdk: provider terminal proof confirmed the abort inside the confirmation window",
          ))
      ) {
        notes.push(
          "[pr-hero] opencode sdk: provider terminal proof confirmed the abort inside the confirmation window",
        );
      }
      // #132: gated on `completed`, and the gate is the whole rationale.
      // Truncation-as-failure exists because SUCCESS is the one verdict that
      // hides a short answer. A terminal whose status is `cancelled` or
      // `failed` was never going to report success, and its answer is
      // incomplete by definition — so the drain budget has nothing to add
      // there, while stamping the marker would hand `protocol_truncation` a
      // fresh transient attempt to re-run a turn the provider already ended.
      const drainTruncated =
        reason.kind === "provider_terminal" &&
        !reason.drained &&
        (slotProof?.providerStatus ?? "").toLowerCase() === "completed";
      if (drainTruncated) {
        notes.push(MARKER_UNDELIVERED_CONTENT);
      }
      if (sawReasoning) {
        // A FIXED string: no model prose, and no free-form numbers either.
        //
        // `notes` becomes stderrTail, which is classifyFailure's whole
        // witness. Prose is the obvious hazard — reasoning is model-generated
        // text about the very failure modes those patterns name, which is
        // exactly why finalText is excluded from the witness and reasoning is
        // finalText's sibling. The counts are the SUBTLE one, and they were
        // measured, not guessed: the witness patterns include `\b429\b` and
        // `\b(?:502|503|504)\b`, so a reasoning stream of exactly 429 bytes
        // would have classified its own attempt `rate_limit`, and one of 503
        // bytes `network_transient`. A byte count lands in that range often.
        // The volume is not worth a note that can lie about why an attempt
        // failed, and the fact that matters — reasoning and no answer — is
        // stated below without a single digit.
        notes.push(
          "[pr-hero] opencode sdk: reasoning parts were received and discarded; reasoning is not the answer",
        );
      }
      // Only on a turn the provider actually finished. An aborted or errored
      // turn legitimately has no answer text, and saying otherwise would put a
      // second, competing diagnosis on an attempt that already has one.
      if (
        reason.kind === "provider_terminal" &&
        sawReasoning &&
        finalParts.length === 0
      ) {
        notes.push(MARKER_REASONING_ONLY);
      }
      // #126: the four tallies below go to `diagnostics`, never `notes`. They
      // interpolate raw counts, and a count is a number we chose — landing it
      // in the witness lets our own bookkeeping answer a question only the
      // provider may answer. `429` poll timeouts filed as `rate_limit`, `503`
      // as `network_transient`, and — the leak that needs no rare number at
      // all — "poll round(s) timed out" carries the literal words `timed out`,
      // which the legacy classifier reads as transient at EVERY count.
      if (sinkClosed) {
        diagnostics.push(
          `[pr-hero] opencode sdk: sink closed early; ${closedDataPlaneEvents} data-plane event(s) not delivered`,
        );
      }
      if (pollTimeouts > 0) {
        diagnostics.push(
          `[pr-hero] opencode sdk: ${pollTimeouts} poll round(s) timed out; timeouts cannot win the terminal slot`,
        );
      }
      if (pollConfirmations > 0) {
        diagnostics.push(
          `[pr-hero] opencode sdk: poll confirmed the winning terminal ${pollConfirmations} time(s) without creating a second terminal`,
        );
      }
      if (invalidProofs > 0) {
        diagnostics.push(
          `[pr-hero] opencode sdk: ${invalidProofs} invalid terminal proof(s) ignored`,
        );
      }
      // #214: always, including 0. 0 is the claim "this session issued no
      // tool-call parts", and the live hunt that posted a clean bill could
      // not even prove that fact. Session-creation failure never reaches
      // here, so it correctly omits the count.
      //
      // pr-hero review F001/F002: the size of `completedCallIds` — see its
      // declaration above. Neither `Math.max` nor an overwrite is needed
      // anymore: the set itself is the union, built once, correctly, as each
      // observation arrives.
      const effectiveToolInvocations = completedCallIds.size;
      const toolIds =
        completedToolIds.length === 0
          ? ""
          : ` (${completedToolIds.join(", ")})`;
      diagnostics.push(
        `[pr-hero] opencode sdk: observed ${effectiveToolInvocations} completed tool invocation(s)${toolIds}`,
      );

      let completion: TransportOutcome["completion"];
      let protocolIntegrity: TransportOutcome["protocolIntegrity"];
      switch (reason.kind) {
        case "provider_terminal":
        case "abort_confirmed": {
          // #132: a won terminal over a delivery that never finished. The
          // proof is real and stays attached as EVIDENCE — the same rule the
          // conflict arm follows — but §4.2 line 191 forbids reporting a
          // truncated answer as anything but truncated, and success is the one
          // verdict that would hide it. Only the completed status can reach
          // here; see `drainTruncated` above for why the others must not.
          if (drainTruncated) {
            completion = "failed";
            protocolIntegrity = "truncated";
            break;
          }
          protocolIntegrity = "verified";
          const status = (slotProof?.providerStatus ?? "").toLowerCase();
          if (abortSequenceStarted || context.signal.aborted) {
            // BE1a: Cancellation/deadline admitted before settlement fences
            // success deterministically. The verified terminal proof stays
            // attached as evidence of remote completion.
            completion = status === "failed" ? "failed" : "cancelled";
          } else if (status === "completed") {
            // §3.2 requires a VERIFIED proof and a BOUNDED finalText for
            // success — bounded, not non-empty: whether empty text is usable
            // output is the harness's format decision (§7), never ours.
            completion = "success";
          } else if (status === "cancelled") {
            completion = "cancelled";
          } else {
            completion = "failed";
          }
          break;
        }
        case "silence":
          // The answer channel went quiet with the delivery unfinished (or
          // never started) — failed/truncated, never success. The marker
          // above carries the cause to `protocol_truncation`.
          completion = "failed";
          protocolIntegrity = "truncated";
          break;
        case "conflict":
        case "usage_flip":
          // §197 / §4.2 line 195: a contradiction makes the outcome malformed;
          // the first valid proof stays attached as evidence, never as success.
          completion = "failed";
          protocolIntegrity = "malformed";
          break;
        case "bound":
        case "stall":
          completion = "failed";
          protocolIntegrity = "overflow";
          break;
        case "stream_error":
        case "session_failed":
          // Unverified, never malformed: nothing contradicted anything. The
          // provider simply never opened a turn, and the transport refuses to
          // manufacture a proof for the one it did not run.
          completion = "failed";
          protocolIntegrity = "unverified";
          break;
        case "abort_unconfirmed":
          // §5.3 line 290: the transport surfaces an unconfirmed abort honestly
          // — cancelled locally, integrity unverified, NO terminalProof, and
          // never a claim that remote execution or cost ended.
          completion = "cancelled";
          protocolIntegrity = "unverified";
          break;
      }

      const effectiveFinalText =
        terminalFinalText !== undefined
          ? terminalFinalText
          : finalParts.join("");

      const effectiveIncomplete = usageIncomplete || terminalUsageIncomplete;

      const effectiveCostUsd =
        terminalUsage?.costUsd !== undefined
          ? Math.max(cashCostUsd ?? 0, terminalUsage.costUsd)
          : cashCostUsd;

      const hasObservedUsage =
        usageState !== undefined ||
        (terminalUsage !== undefined &&
          (terminalUsage.costUsd !== undefined ||
            terminalUsage.inputTokens !== undefined ||
            terminalUsage.outputTokens !== undefined));

      outcome = {
        completion,
        protocolIntegrity,
        ...(slotProof !== undefined &&
        reason.kind !== "abort_unconfirmed" &&
        (reason.kind === "provider_terminal" ||
          reason.kind === "abort_confirmed" ||
          reason.kind === "conflict" ||
          reason.kind === "usage_flip")
          ? { terminalProof: slotProof }
          : {}),
        finalText: effectiveFinalText,
        // §8: no usage event ever arriving is not a proven zero —
        // "unavailable" says honestly that the cost is unknown rather than
        // fabricating a $0 for a session that DID run. `usageState` defined
        // means at least one usage event landed and fixed a mode, so the
        // leaves it accumulated are trustworthy.
        //
        // 2026-09-02: the parenthetical here used to read "capabilities().
        // protocol.usageMode is 'none' until D1-11's real SDK adapter", which
        // misattributed that field. `usageMode: "none"` is not a gap waiting
        // on an adapter — it is the honest static answer to a RUNTIME
        // question, because the aggregation mode is fixed by the first usage
        // event (§4.2 line 195) and no static snapshot/delta claim can be
        // defended before one arrives. The transport's own
        // `usage_mode_client_reported` issue says exactly that. Reading the
        // old wording as "usage does not arrive yet" is what made
        // `pricingReady: false` look consistent with a client that has been
        // reading the provider's cost off every assistant message.
        usage: !hasObservedUsage
          ? promptRefusedBeforeStart(
              reason,
              finalParts.length,
              sawReasoning,
              sawContentEvent,
            )
            ? noSessionUsage(Date.now() - startedWall, this.usageBillingMode)
            : normalizeUnavailableUsage({
                wallMs: Date.now() - startedWall,
                billingMode: this.usageBillingMode,
              })
          : {
              wallMs: Date.now() - startedWall,
              tokens: {
                ...(usageState?.tokens ?? {}),
                inputKnown:
                  usageState?.tokens.inputUncached ??
                  terminalUsage?.inputTokens,
                outputKnown:
                  usageState?.tokens.outputVisible ??
                  terminalUsage?.outputTokens,
                totalKnown:
                  (usageState?.tokens.inputUncached ??
                    terminalUsage?.inputTokens) !== undefined ||
                  (usageState?.tokens.outputVisible ??
                    terminalUsage?.outputTokens) !== undefined
                    ? (usageState?.tokens.inputUncached ??
                        terminalUsage?.inputTokens ??
                        0) +
                      (usageState?.tokens.outputVisible ??
                        terminalUsage?.outputTokens ??
                        0)
                    : undefined,
              },
              completeness:
                effectiveIncomplete ||
                reason.kind === "abort_unconfirmed" ||
                reason.kind === "usage_flip" ||
                reason.kind === "conflict" ||
                reason.kind === "silence" ||
                reason.kind === "stream_error" ||
                reason.kind === "session_failed" ||
                reason.kind === "stall" ||
                reason.kind === "bound"
                  ? "partial"
                  : "complete",
              // 2026-09-02: the ROUTE's mode, not a hardcoded
              // "subscription". #133 established that an OpenCode route on
              // any provider but `openai` runs on a `provider_api_token`
              // and therefore bills METERED, and the exact-binding
              // capability report has said so since. This record used to
              // contradict it — and the contradiction is exploitable, not
              // cosmetic: `settlementFromUsage`'s metered-zero rule reads
              // THIS field, so a metered attempt wearing a subscription
              // badge settles a provider-reported $0 as truthful.
              billingMode: this.usageBillingMode,
              costSource:
                effectiveCostUsd !== undefined ? "provider" : "unknown",
              ...(effectiveCostUsd !== undefined
                ? { cashCostUsd: effectiveCostUsd }
                : {}),
            },
        // D1-07 bridge recovers watchdog_timeout from harness-set timedOut on
        // the outcome, not from transport notes.
        stderrTail: boundTailBytes(notes.join("\n"), MAX_STDERR_TAIL_BYTES),
        // Bounded like the witness (§4.2 line 191) because it lands on disk
        // through the same attempt log and the same redaction.
        diagnosticsTail: boundTailBytes(
          diagnostics.join("\n"),
          MAX_STDERR_TAIL_BYTES,
        ),
        // #214: stamped after a session ran, including 0. Absence is reserved
        // for transports that cannot observe tools (and for this transport's
        // own session-creation failure, which never opened a turn).
        toolInvocations: effectiveToolInvocations,
      };

      // §4.1: the transport normally supplies the attempt's ONE terminal event.
      // The push is awaited but raced against the cleanup budget so a wedged
      // sink cannot hang the return; the harness owns the slot and the sink.
      let cancelTerminalPush: (() => void) | undefined;
      try {
        const status =
          completion === "success"
            ? "completed"
            : completion === "failed"
              ? "failed"
              : "cancelled";
        const origin =
          outcome.terminalProof !== undefined ? "provider" : "transport";
        const terminalEvent: ProviderEvent = {
          ...base(),
          type: "terminal",
          origin,
          status,
          ...(outcome.terminalProof !== undefined
            ? { proof: outcome.terminalProof }
            : {}),
          integrity: protocolIntegrity,
        };
        const pushPromise = context.events
          .push(terminalEvent)
          .catch(() => "closed" as const);
        const pushWindow = new Promise<"window_expired">((resolve) => {
          cancelTerminalPush = this.clock.schedule(this.cleanupMs, () =>
            resolve("window_expired"),
          );
        });
        await Promise.race([pushPromise, pushWindow]);
      } finally {
        cancelTerminalPush?.();
      }

      // Watchers observe `settled` and stop on their own; keep references so a
      // rejection inside a watcher after settlement is never unhandled.
      void streamWatcher.catch(() => {});
      void pollWatcher.catch(() => {});

      return outcome;
    } finally {
      if (streamIterator !== undefined) {
        let returnTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const returnTimeout = new Promise<void>((resolve) => {
            returnTimer = setTimeout(resolve, this.cleanupMs);
          });
          await Promise.race([
            streamIterator.return?.() ??
              Promise.resolve({ done: true as const, value: undefined }),
            returnTimeout,
          ]).catch(() => {});
        } finally {
          if (returnTimer !== undefined) clearTimeout(returnTimer);
        }
      }
    }
  }

  // Lease teardown only: execute() must not close the shared client because
  // the cached transport instance is reused across retries and concurrent steps
  // on the same routeFingerprint until registry.release() evicts it.
  async dispose(): Promise<void> {
    await this.client.close?.().catch(() => {});
  }

  // Marker-based mapping: the transport stamps the §4.2/§197/§290 violations
  // into its own stderr notes, and this function turns exactly those stamped
  // facts into TransportFailureCause values — plus provider auth/network text.
  // It can never return a harness cause (format_violation is harness-only, §7).
  classifyFailure(
    outcome: TransportOutcome,
  ): TransportFailureCause | undefined {
    // finalText is deliberately NOT part of the witness. It is model-generated
    // review prose, and pr-hero reviews code for exactly the failure modes
    // these patterns name — "no rate limit on this endpoint", "unauthorized
    // access is possible" — so including it makes the tool's own subject
    // matter look like provider diagnostics. Every violation this transport
    // detects is stamped into `notes`, and the provider's own stream error is
    // recorded there too, so stderrTail is the complete diagnostics channel.
    const witness = outcome.stderrTail;
    if (witness.includes(MARKER_ABORT_UNCONFIRMED)) {
      return "remote_abort_unconfirmed";
    }
    // #157: FIRST among the provider-text patterns, deliberately. The
    // provider's own message is appended verbatim after this marker (see
    // formatProviderLimitDetail), and a message that happens to say "rate
    // limit" or "quota exceeded" must not let the generic patterns below
    // decide the cause instead of the fact pr-hero actually observed.
    // `quota_exhausted` is the one §7 cause whose retry disposition is
    // already terminal (decideRetryDisposition's default arm) — exactly
    // right, since a fresh attempt cannot outrun quota that is already spent.
    if (witness.includes(MARKER_PROVIDER_LIMIT)) {
      return "quota_exhausted";
    }
    // #157: same ordering rule as the marker above — checked before any
    // generic provider-text pattern so the underlying reply-failure message
    // (network error, 4xx body, whatever the SDK call actually failed with)
    // cannot steer this into rate_limit/network_transient/auth_invalid
    // instead of the fact that pr-hero's own permission control failed to
    // run.
    if (witness.includes(MARKER_PERMISSION_REJECT_FAILED)) {
      return "runtime_unavailable";
    }
    if (
      witness.includes(MARKER_CONFLICT) ||
      witness.includes(MARKER_USAGE_FLIP)
    ) {
      return "protocol_mismatch";
    }
    if (witness.includes(MARKER_STALL)) {
      return "protocol_overflow";
    }
    if (
      witness.includes(MARKER_BOUND_DELTA) ||
      witness.includes(MARKER_BOUND_AGGREGATE)
    ) {
      return "output_limit_exceeded";
    }
    if (
      /unauthorized|invalid[ _-]?api[ _-]?key|not authenticated|authentication (required|failed)|please (log ?in|sign ?in|authenticate)|chatgpt (login|auth)|opencode.*(log ?in|auth)/i.test(
        witness,
      )
    ) {
      return "auth_invalid";
    }
    if (/\b429\b|rate limit|quota exceeded/i.test(witness)) {
      return "rate_limit";
    }
    if (
      /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|network (error|failure)|\b(?:502|503|504)\b|overloaded/i.test(
        witness,
      )
    ) {
      return "network_transient";
    }
    // The gateway's 500 surfacing as a refused prompt (Martian `opencode`
    // arm, 2026-09-10: `opencode session.prompt failed:
    // {"name":"UnknownError","data":{"message":"Unexpected server error…"}}`
    // killed 7/10 PRs with no retry, while the same route self-healed within
    // seconds hours later). A refused prompt whose text IS the provider's own
    // 500 is a transient gateway failure, not the runtime being unavailable —
    // the terminal marker below must not swallow it. Placed beside the
    // network patterns under the same ordering rule: auth/rate-limit above
    // still win, and a local TypeError with no provider-500 text still falls
    // through to the terminal marker.
    if (
      /unexpected server error|internal server error|\b500\b/i.test(witness)
    ) {
      return "network_transient";
    }
    // LAST, and the position is the point. A session that never opened — or a
    // TURN that never started, which is the same fact one call later: the
    // provider refused the prompt, so no message exists and the model never
    // saw the request — is the runtime being unavailable. §7 makes that
    // terminal, so it stops instead
    // of spending the format-reminder budget on an attempt the model never
    // saw. That is what went wrong in issue #121: `sdk.createClient is not a
    // function` reached the harness with no mapped witness, fell through to
    // the legacy classifier, and was filed as `format_violation` — a
    // TypeError in our own transport recorded in the bucket reserved for
    // model misbehaviour, burning a retry on the way.
    //
    // Checked after the auth/rate-limit/network patterns because both
    // messages CARRY the provider's own text: "session creation failed:
    // fetch failed" is a transient network failure that keeps its retry, and
    // a refused prompt is if anything more likely to be a 429 or a 401. A
    // marker check above them would silently delete those paths.
    // #213: after the auth/rate/network/500 patterns, same ordering rule as
    // MARKER_PROMPT_REFUSED. A refusal whose own text is a 401 or a 500 keeps
    // that cause. What remains is a turn the provider refused and the model
    // never saw — runtime_unavailable, which is terminal, so the harness does
    // not spend the format-reminder budget on an empty draft. isRetryable
    // true is the provider asking for another attempt; that is the transient
    // budget, never the format one.
    // A refusal whose slot reports HTTP 404 names a model the provider does not
    // serve: no retry can make it exist, and PRH-MODEL-UNAVAILABLE says so with
    // the provider's name. Only the status slot decides, never the message.
    if (
      witness.includes(MARKER_PROVIDER_REFUSAL) &&
      providerRefusalStatus(witness) === "404"
    ) {
      return "model_unavailable";
    }
    if (witness.includes(MARKER_PROVIDER_REFUSAL)) {
      return providerRefusalRetries(witness) === true
        ? "network_transient"
        : "runtime_unavailable";
    }
    if (
      witness.includes(MARKER_SESSION_CREATE) ||
      witness.includes(MARKER_PROMPT_REFUSED)
    ) {
      return "runtime_unavailable";
    }
    // LAST, under the same ordering rule as the two markers above and for the
    // same reason: this note sits beside the provider's own text in the same
    // witness, so a 429 or a 401 recorded on the same attempt must still win.
    //
    // `protocol_truncation`, not `runtime_unavailable` and not
    // `format_violation`. §7 freezes the cause vocabulary, so the choice is
    // between existing members: the runtime WAS available and the model DID
    // run, which rules out the first; nothing malformed was written, which
    // rules out the second — a format reminder would spend that budget telling
    // the model to reformat an answer it never produced. What actually
    // happened is that the answer channel delivered no content, and
    // truncation's disposition is the remedy that can work: a FRESH attempt on
    // the transient budget, bounded at 3, never the format budget.
    // #132, and LAST for the same reason as the markers above: this note sits
    // beside the provider's own text in one witness, so a 429 or a 401
    // recorded on the same attempt must still win. `protocol_truncation` is
    // the literal fact — the answer channel was cut short — and its
    // disposition is the remedy that can work: a FRESH attempt on the
    // transient budget, never the format budget, which would spend a reminder
    // telling the model to reformat text it did finish writing.
    if (witness.includes(MARKER_UNDELIVERED_CONTENT)) {
      return "protocol_truncation";
    }
    if (witness.includes(MARKER_SILENCE)) return "protocol_truncation";
    if (witness.includes(MARKER_REASONING_ONLY)) return "protocol_truncation";
    return undefined;
  }
}
