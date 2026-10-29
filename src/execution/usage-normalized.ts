// §8 (docs/multi-runtime-model-diversity-design.md lines 426-463): usage
// normalization and inclusion semantics. Pure by design — no transport, no
// harness, no I/O; zero consumers yet (PR1a). Transports (PR2) will call the
// builders below to turn a provider's raw usage shape into the disjoint §8
// leaves; the harness will accumulate across attempts with
// `sumNormalizedUsage` and project the legacy flat shape at the
// `runPipeline` return boundary with `projectLegacyUsage`.

import type { SessionUsage } from "../usage";

export type UsageCompleteness = "complete" | "partial" | "unavailable";
// #182 follow-up: "free" is a USAGE-layer precision, not a capability mode.
// A free-declared route bills nothing, but a model free at probe time can flip
// to metered before/during the attempt — and the transport observes
// provider-reported cost per message (opencode-sdk.ts cashCostUsd,
// costSource "provider"). Stamping "subscription" would let
// `settlementFromUsage`'s free-nonzero rule (spend-limiter.ts) never fire and
// settle a flipped attempt's priced cost as a truthful zero. Capability
// `BillingMode` ("subscription"|"metered") stays binary on purpose: the exact
// binding still reports a free route as subscription/not_applicable, and the
// spend ledger is composed for it by credential kind (production-runtime.ts).
export type UsageBillingMode = "subscription" | "metered" | "free" | "unknown";
export type UsageCostSource =
  | "provider"
  | "versioned_rate_table"
  | "subscription"
  | "unknown";

// 2026-09-02, #177. THE one place that says "this environment carries a
// per-token credential". Two callers need it and they must not each carry
// their own copy: `deriveCiBillingMode` (ci/gates.ts) turns it into a CI spend
// ceiling, and the Claude CLI transport turns it into the `billingMode`
// STAMPED ON EVERY USAGE RECORD it emits. This is the same anti-drift shape
// `credentialKindBillsMetered` (runner-authority.ts) already applies to the
// credential KIND, and for the same measured reason: #177 IS the drift. The CI
// gate already called an API-key route metered while the transport filed that
// user's real spend as `notionalCostUsd`, which renders as "at list price, not
// charged" — and since budget enforcement is cash-only (§8), that user's spend
// ceiling read $0 and stopped existing.
//
// A boolean, not a mode, matching its sibling: the two callers narrow it into
// two DIFFERENT enums (`CiBillingMode`, `UsageBillingMode`), and returning a
// mode here would invite one of them to overwrite the other's semantics
// instead of asking the question this answers.
//
// WHICH variables, and why these two: `ENV_PASSTHROUGH` (harness.ts) projects
// ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN into the child side by side as
// one credential class — a per-token key and a per-token bearer token.
// CLAUDE_CODE_OAUTH_TOKEN is deliberately absent: that IS the subscription.
// 2026-09-02: "projects into the child" holds only where no credential
// projection is active. When one IS, `buildChildEnv` strips both keys
// (PROJECTION_OWNED_KEYS, harness.ts) because the projection owns the
// credential, so this predicate reads subscription on that path — which is
// the truth there, and was not before the strip.
// When an OAuth token and a key are both present this repo does not know which
// one the Claude CLI bills (ci/gates.ts states that gap at length), and does
// not need to — presence of a key answers metered, because guessing
// subscription wrongly reports real money as not charged.
//
// Trimming is load-bearing, and it is worth being exact about WHAT it buys,
// because the sentence it replaces overstated it and #177 is a finding about
// comments claiming more than their code. action.yml:111 binds
// ANTHROPIC_API_KEY UNCONDITIONALLY and GitHub renders an unset input as the
// empty string, so every subscription-route CI run carries
// `ANTHROPIC_API_KEY=""` — but `""` is already falsy, so that case is safe
// with or without the trim. What the trim actually catches is a
// WHITESPACE-ONLY value (a secret whose content is a space, a YAML block
// scalar that kept its newline), which is truthy and would otherwise read as
// a live key and impose a ceiling — or, here, book a subscription run's quota
// spend as cash. Mutation-checked: dropping the trim flips exactly the
// whitespace arms, never the empty-string ones.
//
// ---------------------------------------------------------------------------
// ADMISSION WIRING, #161. This predicate now has a SECOND caller:
// `credentialKindForRoute` (runner-authority.ts) — the single place that
// decides which credential a claude-code route runs on, and therefore its
// projection, its broker, and its rate-limit bucket. Until #161 this block
// banned exactly that wiring outright; read both halves below before adding
// a THIRD caller, because the ban is lifted for exactly one function, not
// for the question in general.
//
// Until #197 the reason was safety: deriving either side from env turned a
// metered claude-code route into `pricingApplicability: "required"` with no
// pricing source to answer, so the route was refused admission outright
// (`pricing_table_missing`, blocking) and API-key users stopped being able to
// run at all. #197 flipped the claude-code transport's `pricingReady` to
// `true`, so that refusal can no longer happen and the fail-closed argument
// is spent.
//
// What remained was ownership, and #161 settles it by NAMING the owner
// instead of banning the wiring outright: `credentialKindForRoute` is the
// one admission-side reader of this predicate, and `envBillsMetered` is the
// one shared implementation both it and the Claude CLI transport's
// `claudeCliCostBasis` call — never two copies of the same trim rule
// answering "does this environment carry a per-token credential?"
// differently for the same attempt.
//
// The two calls read DIFFERENT env values on purpose, and on a SUCCESSFUL
// projection that is not a fork: `claudeCliCostBasis` reads the child's
// ACTUAL, POST-projection-strip env (`request.isolation.env`) — a successful
// projection strips the key-bearing vars (`PROJECTION_OWNED_KEYS`,
// harness.ts), so this is a truthful read of what the process the money was
// spent by actually saw. `credentialKindForRoute` runs BEFORE any child
// exists, so it cannot read that env — it reads the raw, pre-strip one plus
// whether a broker WILL ATTEMPT to strip it (`hasBroker`), and
// `!hasBroker && envBillsMetered(rawEnv)` equals `envBillsMetered(postStripEnv)`
// on that path: a successful strip removes the key whenever a broker is
// attached, and the post-strip env equals the raw env exactly when none is.
// Same predicate, same answer, two different envs because one runs before
// the strip and one runs after it.
//
// KNOWN EXCEPTION — #279 (fixed 2026-09-24, option 2). A broker's projection
// can DEGRADE (`missing_subscription_record`, credential-broker.ts +
// harness.ts ~756-778) instead of stripping anything: the child then runs
// UNSTRIPPED, so `hasBroker: true` no longer implies "the child's env has no
// key" — admission still says subscription (this function's answer is
// deliberately left unchanged; it cannot see a runtime degrade), and
// `claudeCliCostBasis` (reading the real, unstripped child env) correctly
// files it metered. That disagreement between admission and filing is
// permanent by design — but the spend it describes is no longer
// unaccounted for: `StepExecutionHarness.run` (harness.ts) recognizes its
// own degraded projection and applies THIS SAME `envBillsMetered` predicate
// to the SAME child env to open a spend-ledger reservation for that one
// attempt, settling or fencing it exactly like a metered route. Pre-existing:
// this exact admission/filing mismatch already existed for every degraded
// projection before #161, which named the ownership rule but did not add or
// remove this exception; #279's fix lives in the harness, not here.
//
// Everything downstream of the KIND (the projection, the bucket, and
// `FrozenRuntimeBinding.capabilities()`'s `effectiveBillingMode` via
// `credentialKindBillsMetered`) inherits the answer from that one call and
// never re-reads env itself — so admission and usage filing agree by
// construction on a successful projection, #279 aside.
//
// The ban stands for everyone ELSE. `CLAUDE_CAPABILITY_STATICS.billingMode`
// (model/provider-capabilities.ts) stays a static "subscription" on purpose —
// it is the BACKEND-WIDE report, produced before any route (and therefore any
// credential) resolves, so it has no per-route env to read honestly; the
// per-route truth lives on the exact binding instead. A THIRD caller
// deriving straight from env, instead of going through
// `credentialKindForRoute`, is exactly the fork this predicate exists to
// prevent — route it through the kind instead.
// ---------------------------------------------------------------------------
export function envBillsMetered(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return METERED_CREDENTIAL_ENV.some((name) => Boolean(env[name]?.trim()));
}

// The per-token credential variables, in the order the CLI prefers them. The one list
// envBillsMetered reads and the failure-credential naming of the Claude transport reads,
// so a variable that bills as metered is also a variable a failure can name.
export const METERED_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

// §8 lines 429-450, verbatim field names (camelCase — the legacy flat shape
// keeps its own snake_case names; `projectLegacyUsage` below is the ONLY
// bridge between the two, per the "coexistence, not rename" design decision).
export interface NormalizedTokens {
  readonly inputUncached?: number;
  readonly inputCacheRead?: number;
  readonly inputCacheWrite?: number;
  readonly inputOther?: number;
  readonly outputVisible?: number;
  readonly outputReasoning?: number;
  readonly outputOther?: number;
  readonly inputKnown?: number;
  readonly outputKnown?: number;
  readonly totalKnown?: number;
  readonly providerReportedTotal?: number;
}

export interface NormalizedUsage {
  readonly wallMs: number;
  readonly tokens: NormalizedTokens;
  readonly completeness: UsageCompleteness;
  readonly billingMode: UsageBillingMode;
  readonly cashCostUsd?: number;
  readonly notionalCostUsd?: number;
  readonly costSource: UsageCostSource;
  readonly redactedRaw?: unknown;
}

interface UsageCostInput {
  readonly billingMode: UsageBillingMode;
  readonly costSource: UsageCostSource;
  readonly cashCostUsd?: number;
  readonly notionalCostUsd?: number;
}

function sumOrZero(...values: ReadonlyArray<number | undefined>): number {
  return values.reduce<number>((total, v) => total + (v ?? 0), 0);
}

function sumIfAnyDefined(
  ...values: ReadonlyArray<number | undefined>
): number | undefined {
  return values.every((v) => v === undefined)
    ? undefined
    : sumOrZero(...values);
}

function attemptTotalKnown(tokens: NormalizedTokens): number | undefined {
  return tokens.totalKnown ?? tokens.providerReportedTotal;
}

// 2026-09-02: "did this attempt produce output tokens?", answered from the
// LEAVES and not from `outputKnown` alone. `outputKnown` is a rollup some
// builders populate (`normalizeInclusiveUsage`, the OpenCode transport) and
// others do not, so a reader that consulted it alone would let a transport
// filling only `outputVisible` slip past — deciding an accounting question by
// which fields a transport happens to set rather than by whether tokens were
// produced. The §8 output leaves are disjoint by contract, so summing them is
// not double counting. One consumer today: `settlementFromUsage`'s
// metered-zero rule (spend-limiter.ts).
export function outputTokensKnown(
  tokens: NormalizedTokens,
): number | undefined {
  return (
    tokens.outputKnown ??
    sumIfAnyDefined(
      tokens.outputVisible,
      tokens.outputReasoning,
      tokens.outputOther,
    )
  );
}

// §8 line 455: "If a provider total includes detailed cache/reasoning
// values, split the total into leaves and store only the non-negative
// residual in inputOther/outputOther; never add the detail to the inclusive
// total." OpenAI's `prompt_tokens`/`completion_tokens` are this shape — the
// detail fields are a SUBSET of the total, never additional to it.
export interface InclusiveUsageInput extends UsageCostInput {
  readonly wallMs: number;
  readonly inputTotal: number;
  readonly inputCacheRead?: number;
  readonly inputCacheWrite?: number;
  readonly outputTotal: number;
  readonly outputReasoning?: number;
}

export function normalizeInclusiveUsage(
  input: InclusiveUsageInput,
): NormalizedUsage {
  const inputOther = Math.max(
    0,
    input.inputTotal - sumOrZero(input.inputCacheRead, input.inputCacheWrite),
  );
  const outputOther = Math.max(
    0,
    input.outputTotal - sumOrZero(input.outputReasoning),
  );
  return {
    wallMs: input.wallMs,
    tokens: {
      inputCacheRead: input.inputCacheRead,
      inputCacheWrite: input.inputCacheWrite,
      inputOther,
      outputReasoning: input.outputReasoning,
      outputOther,
      inputKnown: input.inputTotal,
      outputKnown: input.outputTotal,
      totalKnown: input.inputTotal + input.outputTotal,
      providerReportedTotal: input.inputTotal + input.outputTotal,
    },
    completeness: "complete",
    billingMode: input.billingMode,
    costSource: input.costSource,
    cashCostUsd: input.cashCostUsd,
    notionalCostUsd: input.notionalCostUsd,
  };
}

// §8 line 457: "If inclusion cannot be proven, keep providerReportedTotal,
// mark partial, and do not invent a split." No leaf field is populated here
// — inventing one would resurrect the exact "$0 on parse failure" collapse
// this slice exists to kill, just with a fabricated split instead of a
// fabricated zero.
export interface PartialUsageInput extends UsageCostInput {
  readonly wallMs: number;
  readonly providerReportedTotal: number;
}

export function normalizePartialUsage(
  input: PartialUsageInput,
): NormalizedUsage {
  return {
    wallMs: input.wallMs,
    tokens: { providerReportedTotal: input.providerReportedTotal },
    completeness: "partial",
    billingMode: input.billingMode,
    costSource: input.costSource,
    cashCostUsd: input.cashCostUsd,
    notionalCostUsd: input.notionalCostUsd,
  };
}

// spec: "Parse Failure Yields Unavailable Completeness, Never Zero Cost" —
// used when nothing about an attempt's usage can be trusted (corrupted
// stdout, a dropped final usage chunk, a safety-blocked response with no
// usage block at all). No leaf, cost, or total field is ever populated as a
// fabricated zero; billingMode/costSource fall back to "unknown" rather
// than guessing which one applied.
export interface UnavailableUsageInput {
  readonly wallMs: number;
  readonly billingMode?: UsageBillingMode;
}

export function normalizeUnavailableUsage(
  input: UnavailableUsageInput,
): NormalizedUsage {
  return {
    wallMs: input.wallMs,
    tokens: {},
    completeness: "unavailable",
    billingMode: input.billingMode ?? "unknown",
    costSource: "unknown",
  };
}

const COMPLETENESS_RANK: Record<UsageCompleteness, number> = {
  complete: 0,
  partial: 1,
  unavailable: 2,
};

function worseCompleteness(
  a: UsageCompleteness,
  b: UsageCompleteness,
): UsageCompleteness {
  return COMPLETENESS_RANK[a] >= COMPLETENESS_RANK[b] ? a : b;
}

// Accumulates two attempts' usage within one step. A failed attempt's tokens
// still cost money (ported rationale from `sumUsage` in `src/usage.ts`), so
// this sums, never replaces. Cash and notional accumulate independently
// (spec: "Cash And Notional Cost Stay Separate") — neither is ever read to
// derive the other. billingMode/costSource fall back to "unknown" on
// disagreement between attempts rather than guessing which one is right.
export function sumNormalizedUsage(
  a: NormalizedUsage,
  b: NormalizedUsage,
): NormalizedUsage {
  return {
    wallMs: a.wallMs + b.wallMs,
    tokens: {
      inputUncached: sumIfAnyDefined(
        a.tokens.inputUncached,
        b.tokens.inputUncached,
      ),
      inputCacheRead: sumIfAnyDefined(
        a.tokens.inputCacheRead,
        b.tokens.inputCacheRead,
      ),
      inputCacheWrite: sumIfAnyDefined(
        a.tokens.inputCacheWrite,
        b.tokens.inputCacheWrite,
      ),
      inputOther: sumIfAnyDefined(a.tokens.inputOther, b.tokens.inputOther),
      outputVisible: sumIfAnyDefined(
        a.tokens.outputVisible,
        b.tokens.outputVisible,
      ),
      outputReasoning: sumIfAnyDefined(
        a.tokens.outputReasoning,
        b.tokens.outputReasoning,
      ),
      outputOther: sumIfAnyDefined(a.tokens.outputOther, b.tokens.outputOther),
      inputKnown: sumIfAnyDefined(a.tokens.inputKnown, b.tokens.inputKnown),
      outputKnown: sumIfAnyDefined(a.tokens.outputKnown, b.tokens.outputKnown),
      totalKnown: sumIfAnyDefined(
        attemptTotalKnown(a.tokens),
        attemptTotalKnown(b.tokens),
      ),
      providerReportedTotal: sumIfAnyDefined(
        a.tokens.providerReportedTotal,
        b.tokens.providerReportedTotal,
      ),
    },
    completeness: worseCompleteness(a.completeness, b.completeness),
    billingMode: a.billingMode === b.billingMode ? a.billingMode : "unknown",
    costSource: a.costSource === b.costSource ? a.costSource : "unknown",
    cashCostUsd: sumIfAnyDefined(a.cashCostUsd, b.cashCostUsd),
    notionalCostUsd: sumIfAnyDefined(a.notionalCostUsd, b.notionalCostUsd),
  };
}

// §4.1 line 195: "The first usage event fixes the attempt's aggregation
// mode. snapshot replaces the current provider snapshot; delta adds disjoint
// increments. A later mode change is protocol_mismatch." This reducer is the
// pure state machine PR2's transports will fold provider usage events
// through — a mode change throws rather than silently mixing.
export type UsageUpdateMode = "snapshot" | "delta";

export class UsageModeMismatchError extends Error {
  readonly attemptMode: UsageUpdateMode;
  readonly incomingMode: UsageUpdateMode;

  constructor(attemptMode: UsageUpdateMode, incomingMode: UsageUpdateMode) {
    super(
      `usage event mode mismatch: attempt started as "${attemptMode}", received "${incomingMode}"`,
    );
    this.name = "UsageModeMismatchError";
    this.attemptMode = attemptMode;
    this.incomingMode = incomingMode;
  }
}

export interface UsageModeState {
  readonly mode: UsageUpdateMode;
  readonly tokens: Partial<NormalizedTokens>;
}

export function applyUsageUpdate(
  state: UsageModeState | undefined,
  mode: UsageUpdateMode,
  update: Partial<NormalizedTokens>,
): UsageModeState {
  if (state !== undefined && state.mode !== mode) {
    throw new UsageModeMismatchError(state.mode, mode);
  }
  if (mode === "snapshot") {
    return { mode, tokens: { ...update } };
  }
  const merged: Record<string, number> = { ...(state?.tokens ?? {}) };
  for (const [key, value] of Object.entries(update)) {
    if (typeof value === "number") {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return { mode, tokens: merged as Partial<NormalizedTokens> };
}

// spec: "Legacy Usage Projection At The Published Boundary" — the ONLY place
// NormalizedUsage becomes the legacy flat shape. Field names are copied
// verbatim from `SessionUsage` (src/usage.ts) because
// `../deep-review/runner/telemetry.ts` reads them by name off `runPipeline`'s
// returned `usage` object; a rename there would zero the bench ledger
// silently. When the input/output split is unknown (partial usage), the
// total is preserved but the split is honestly reported as 0 rather than
// invented.
export function projectLegacyUsage(usage: NormalizedUsage): SessionUsage {
  const t = usage.tokens;
  const tokens_in =
    t.inputKnown ??
    sumIfAnyDefined(
      t.inputUncached,
      t.inputCacheRead,
      t.inputCacheWrite,
      t.inputOther,
    ) ??
    0;
  const tokens_out =
    t.outputKnown ??
    sumIfAnyDefined(t.outputVisible, t.outputReasoning, t.outputOther) ??
    0;
  const tokens_total =
    t.totalKnown ?? t.providerReportedTotal ?? tokens_in + tokens_out;
  return {
    wall_ms: usage.wallMs,
    tokens_in,
    tokens_out,
    tokens_total,
    cost_usd_est: usage.cashCostUsd ?? 0,
  };
}
