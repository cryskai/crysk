// D1-08 PR4 (§9.1): the transactional spend reservation ledger. In-memory
// per run, behind an interface whose only stateful operations are CAS
// transitions (design decision D7) — so a durable adapter (D1-08f) can
// implement `SpendLedger` with zero caller changes.
//
// Wiring, corrected 2026-09-02. This header used to say "Not wired into the
// harness yet; that's PR5b, per the design's own tripwire table", and it had
// gone stale on both axes. PR5b landed:
// `StepExecutionHarness.runAttempt` calls `reserve()` before the transport
// and `finalizeReservation` applies the CAS transition `settlementFromUsage`
// names (harness.ts), `runPipeline`'s `collectUnresolvedSpend` gathers the
// terminal `unresolved_remote` reservations into `PipelineResult.unresolved`
// (pipeline.ts), and `renderResult` prints them and marks the run's cost
// figure a floor (ui/result.ts).
//
// The second axis, which "wired into the harness" alone would still hide, and
// which held on `dev` until 2026-09-02: no production composition constructed
// a `SpendLedger` at all, so `this.spendLedger` was undefined on every real
// run and none of the above executed. It is composed now —
// `MultiProviderRunner` (production-runtime.ts) holds ONE instance for the
// run, which is what makes `fencedBuckets` below a run-scoped fence rather
// than a per-step no-op.
//
// It is composed for METERED bindings only, and that is deliberate rather
// than partial: the guarantee this ledger enforces is about dollars, and
// `MultiProviderRunner.run` carries the full argument. A claude-only run
// therefore records zero reservations, and the absent `reservations` key on
// those steps is the truthful signal, not a gap. `ClaudeCodeRunner`
// (step-runner.ts) stays ledger-free for the same reason.
//
// #182 follow-up: the one exception is a FREE OpenCode binding
// (`provider_free`), which reserves too even though its capability report says
// subscription. Without a reservation the free-nonzero rule above would be
// dead in production — `finalizeReservation` never runs, so a flipped model
// would keep spending attempts instead of fencing and failing closed. A free
// step that stays free settles 0 and never fences.
//
// Two couplings the spec calls out as the easiest to lose across chained
// PRs are made TYPE-unreachable here rather than asserted at runtime:
//   1. `settle()`'s second argument is narrowed to the "settle" arm of
//      SettlementDecision — a raw usage number can never be handed to
//      `settle()`; only `settlementFromUsage` produces that arm, and tsc
//      refuses any other call before code runs (spec: "Non-Complete Usage
//      Never Settles As A Number"). Its one non-complete exception, a
//      proven rate-limited partial, is documented on that function.
//   2. `reserve()`'s second argument is a branded ReserveToken that only
//      `beginStep()` (attempt 1) or `nextCycle()` on a NON-terminal
//      RetryDisposition can produce. `nextCycle()` returns `undefined` for
//      a terminal disposition, so a terminal attempt structurally cannot
//      construct a token to open a new reserve+admit cycle (spec: "Only
//      Non-Terminal Disposition Starts A New Reserve+Admit Cycle").

import { randomUUID } from "node:crypto";
import type { FailureCause, RetryDisposition } from "./failure-policy";
import { type NormalizedUsage, outputTokensKnown } from "./usage-normalized";

// ---- Coupling 1: settlement decision ----

export type SettlementDecision =
  | { readonly kind: "settle"; readonly actualUsd: number }
  | {
      readonly kind: "unresolved";
      readonly knownUsd?: number;
      // #182 follow-up: present ONLY on the free-nonzero arm below. The
      // harness fail-fasts on it (terminal step failure, no retry); every
      // other unresolved arm stays fence-only. Optional and additive so all
      // existing producers/consumers keep compiling — tsc is the net.
      readonly reason?: "free_nonzero_cost";
    };

// spec: "Non-Complete Usage Never Settles As A Number" — completeness other
// than "complete" is the unresolved arm, carrying whatever cash cost is
// already known (possibly none) rather than inventing a settled number.
// This is the ONLY producer of SettlementDecision.
//
// ONE exception, and it is narrow on every axis: a METERED attempt that
// failed with cause `rate_limit` and whose `partial` usage carries a cost the
// PROVIDER stated. A 429 is the provider refusing a turn: that refused request
// is unbilled, and every message it did serve carries its own provider price,
// so the stated figure is the spend, not a guess. Leaving it unresolved fenced
// the whole bucket for the run: one 429 on ai& (100 RPM) cost the step its
// retry and every later refuter its spawn (lab ledger, cost levers v2,
// 2026-10-21). Everything else still fails closed: any other cause, an
// `unavailable` record, a cost not from the provider, an absent figure, and
// free/subscription routes (a free route's flip guard below must keep seeing
// priced partial work as unresolved). The transport must also PROVE the
// figure covers the attempt (`partialCause: "terminal_failure"`: no message
// missing its usage, no conflict), and the output leaves must be known so the
// metered-zero rule below can still see a zero that is not a real price. A
// rate-limited figure then passes the same rules a complete one does.
export function settlementFromUsage(
  usage: NormalizedUsage,
  context: { readonly failureCause?: FailureCause } = {},
): SettlementDecision {
  const rateLimitedProviderPriced =
    context.failureCause === "rate_limit" &&
    usage.completeness === "partial" &&
    usage.partialCause === "terminal_failure" &&
    outputTokensKnown(usage.tokens) !== undefined &&
    usage.billingMode === "metered" &&
    usage.costSource === "provider" &&
    typeof usage.cashCostUsd === "number" &&
    Number.isFinite(usage.cashCostUsd) &&
    usage.cashCostUsd >= 0;
  if (usage.completeness !== "complete" && !rateLimitedProviderPriced) {
    return { kind: "unresolved", knownUsd: usage.cashCostUsd };
  }
  if (usage.cashCostUsd === undefined) {
    return { kind: "unresolved", knownUsd: undefined };
  }
  // 2026-09-02, the metered-zero rule: #133's under-reporting failure
  // arriving through the other door. #133 caught a metered route REPORTED as
  // a subscription and therefore priced at nothing; this catches a metered
  // route that reports a NUMBER, and the number is zero.
  //
  // How a zero gets here: the OpenCode client reads the provider's own cost
  // (`asNumber(info.cost)`, opencode-client.ts), and `asNumber` returns 0 for
  // 0 rather than undefined — so a provider OpenCode holds no price for, or a
  // custom endpoint, produces a COMPLETE usage with `cashCostUsd: 0` and
  // `costSource: "provider"`. Every guard above passes it, and it settles as
  // a truthful-looking zero wearing the provider's badge.
  //
  // The credential's billing mode discriminates, never the number: zero cash
  // cost IS truthful for a subscription credential (the design's own
  // subscription rule), and is not truthful for a metered credential that
  // produced output tokens. Both halves are load-bearing — dropping the mode
  // test would misfile every free subscription attempt as unresolved and
  // fence its bucket; dropping the token test would misfile a metered attempt
  // that never reached the provider (`noSessionUsage`, opencode-sdk.ts).
  //
  // `billingMode: "unknown"` is deliberately NOT covered: it is already a
  // blocking preflight result (design doc line 461, enforced by
  // `cashCostAccountingValid` in production-runtime.ts), so no such route
  // reaches an attempt, and a second weaker enforcement point for a fact the
  // gate refuses outright is how the two start disagreeing.
  //
  // No `knownUsd`: the whole point is that this 0 is not a known cost.
  // Carrying it would relocate the same lie into the unresolved arm, where
  // `renderResult` would print "$0 known" beside the fenced bucket.
  if (
    usage.billingMode === "metered" &&
    usage.cashCostUsd === 0 &&
    (outputTokensKnown(usage.tokens) ?? 0) > 0
  ) {
    return { kind: "unresolved", knownUsd: undefined };
  }
  // #182 follow-up, the free-nonzero rule: a model free at probe time can flip
  // to metered before/during the attempt, and the attempt then runs
  // credentialless under an empty projection. The flip is observable at
  // settlement — the transport accumulates provider-reported cost per message
  // (opencode-sdk.ts `cashCostUsd`, `costSource: "provider"`), so priced work
  // on a free-declared route arrives here as complete usage with cash > 0.
  //
  // NO output-token gate, unlike metered-zero: any priced work on a
  // free-declared route is unaccountable by definition, and cash > 0 already
  // implies the provider did priced work. `noSessionUsage` (route-mode stamp +
  // cash 0 + empty tokens) still settles 0 below — a free attempt that never
  // reached the provider is a truthful zero, not a flip.
  //
  // `knownUsd` IS carried here — the documented asymmetry with metered-zero,
  // which drops it. A metered 0 is an untrusted number wearing the provider's
  // badge; a free-route cash figure is the provider's STATED price for work it
  // claims to have billed, and the fence (`markUnresolvedRemote`) plus the
  // harness fail-fast message both need the figure to name what happened.
  if (
    usage.billingMode === "free" &&
    usage.completeness === "complete" &&
    (usage.cashCostUsd ?? 0) > 0
  ) {
    return {
      kind: "unresolved",
      knownUsd: usage.cashCostUsd,
      reason: "free_nonzero_cost",
    };
  }
  return { kind: "settle", actualUsd: usage.cashCostUsd };
}

// ---- Coupling 2: reserve token ----

declare const RESERVE: unique symbol;
export type ReserveToken = { readonly [RESERVE]: true };

// Not a secret or a capability — just a value only this module's two
// functions can produce, so tsc (not a runtime check) is what stops a
// terminal disposition from calling `reserve()`.
const RESERVE_TOKEN: ReserveToken = Object.freeze({}) as ReserveToken;

// Attempt 1 of any step always has a token to open its first reserve+admit
// cycle — there is no disposition yet to consult.
export function beginStep(): ReserveToken {
  return RESERVE_TOKEN;
}

// spec: "Only Non-Terminal Disposition Starts A New Reserve+Admit Cycle" — a
// terminal disposition (including remote_abort_unconfirmed, which
// `decideRetryDisposition` folds into "terminal") returns undefined: there
// is no token, so `reserve()` cannot be called for a new cycle.
export function nextCycle(
  disposition: RetryDisposition,
): ReserveToken | undefined {
  return disposition.action === "terminal" ? undefined : RESERVE_TOKEN;
}

// ---- Ledger ----

// spec: "every attempt MUST carry a reservationId and terminal state" — the
// four states a reservation can occupy. "reserved" is the only
// non-terminal one; every CAS transition below moves OUT of it exactly
// once.
export type SpendReservationState =
  | "reserved"
  | "settled"
  | "released_unstarted"
  | "unresolved_remote";

export interface ReserveSpendInput {
  readonly bucketId: string;
  readonly reservedUsd: number;
  readonly sessionId: string;
  readonly attempt: number;
}

export interface SpendReservation {
  readonly reservationId: string;
  readonly bucketId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly reservedUsd: number;
  readonly state: SpendReservationState;
  readonly settledUsd?: number;
  readonly knownUsd?: number;
}

// spec: "Unresolved bucket blocks the next paid attempt" — thrown by
// `reserve()` before a reservation is even created, so no transport spawn
// can follow it.
export class SpendReservationFencedError extends Error {
  readonly bucketId: string;

  constructor(bucketId: string) {
    super(
      `bucket "${bucketId}" is fenced by an unresolved_remote reservation; no new reservations admitted this run`,
    );
    this.name = "SpendReservationFencedError";
    this.bucketId = bucketId;
  }
}

export class SpendReservationNotFoundError extends Error {
  readonly reservationId: string;

  constructor(reservationId: string) {
    super(`no reservation "${reservationId}"`);
    this.name = "SpendReservationNotFoundError";
    this.reservationId = reservationId;
  }
}

// Thrown when a terminal transition is requested with an idempotency key
// that differs from the one that already made the reservation terminal —
// the CAS conflict case, distinct from the same-key no-op.
export class SpendReservationConflictError extends Error {
  readonly reservationId: string;
  readonly currentState: SpendReservationState;

  constructor(reservationId: string, currentState: SpendReservationState) {
    super(
      `reservation "${reservationId}" is already terminal ("${currentState}") under a different idempotency key`,
    );
    this.name = "SpendReservationConflictError";
    this.reservationId = reservationId;
    this.currentState = currentState;
  }
}

// D1-08f seam: exactly four async CAS methods keyed by reservationId +
// idempotencyKey. A durable adapter implements this same interface with
// zero caller changes (design decision D7).
export interface SpendLedger {
  reserve(
    input: ReserveSpendInput,
    token: ReserveToken,
  ): Promise<SpendReservation>;
  settle(
    reservationId: string,
    decision: Extract<SettlementDecision, { kind: "settle" }>,
    idempotencyKey: string,
  ): Promise<void>;
  releaseUnstarted(
    reservationId: string,
    idempotencyKey: string,
  ): Promise<void>;
  markUnresolvedRemote(
    reservationId: string,
    knownUsd: number | undefined,
    idempotencyKey: string,
  ): Promise<void>;
}

// D1-08 PR5b (D8): one step's fenced reservation, surfaced at the pipeline
// and terminal-result boundaries so the cross-run fencing gap (breaker state
// does not survive a process restart, design decision D7) stays VISIBLE
// rather than silent. `step` is attached by the caller (pipeline.ts knows
// step names; this module never does) — everything else is copied verbatim
// off the terminal `SpendReservation`.
export interface UnresolvedSpend {
  readonly step: string;
  readonly bucketId: string;
  readonly reservationId: string;
  readonly knownUsd?: number;
}

type TerminalOperationKind =
  | "settled"
  | "released_unstarted"
  | "unresolved_remote";

interface LedgerEntry {
  reservation: SpendReservation;
  // Idempotency key of the transition that made this reservation terminal
  // — undefined while still "reserved". A repeat call carrying THIS exact
  // key AND the same operation kind is a no-op; the same key with a
  // different operation kind is a conflict, never a silent overwrite.
  terminalIdempotencyKey?: string;
  terminalOperationKind?: TerminalOperationKind;
}

export class InMemorySpendLedger implements SpendLedger {
  private readonly reservations = new Map<string, LedgerEntry>();
  // spec: "Unresolved bucket blocks the next paid attempt" — once a bucket
  // produces an unresolved_remote reservation, it stays fenced for the rest
  // of this ledger's lifetime (i.e. the run; cross-run persistence is out
  // of scope per "In-Memory Ledger With Surfaced Cross-Run Gap").
  private readonly fencedBuckets = new Set<string>();

  async reserve(
    input: ReserveSpendInput,
    _token: ReserveToken,
  ): Promise<SpendReservation> {
    if (this.fencedBuckets.has(input.bucketId)) {
      throw new SpendReservationFencedError(input.bucketId);
    }
    const reservation: SpendReservation = {
      reservationId: `resv-${randomUUID()}`,
      bucketId: input.bucketId,
      sessionId: input.sessionId,
      attempt: input.attempt,
      reservedUsd: input.reservedUsd,
      state: "reserved",
    };
    this.reservations.set(reservation.reservationId, { reservation });
    return reservation;
  }

  async settle(
    reservationId: string,
    decision: Extract<SettlementDecision, { kind: "settle" }>,
    idempotencyKey: string,
  ): Promise<void> {
    this.transition(
      reservationId,
      idempotencyKey,
      "settled",
      (reservation) => ({
        ...reservation,
        state: "settled",
        settledUsd: decision.actualUsd,
      }),
    );
  }

  async releaseUnstarted(
    reservationId: string,
    idempotencyKey: string,
  ): Promise<void> {
    this.transition(
      reservationId,
      idempotencyKey,
      "released_unstarted",
      (reservation) => ({
        ...reservation,
        state: "released_unstarted",
      }),
    );
  }

  async markUnresolvedRemote(
    reservationId: string,
    knownUsd: number | undefined,
    idempotencyKey: string,
  ): Promise<void> {
    const applied = this.transition(
      reservationId,
      idempotencyKey,
      "unresolved_remote",
      (reservation) => ({
        ...reservation,
        state: "unresolved_remote",
        knownUsd,
      }),
    );
    if (applied) {
      const entry = this.reservations.get(reservationId);
      if (entry !== undefined) {
        this.fencedBuckets.add(entry.reservation.bucketId);
      }
    }
  }

  // Test/introspection helper — deliberately NOT part of the SpendLedger
  // interface (D7: "the only stateful operations are CAS transitions"), so
  // a durable adapter is free to back this differently or omit it.
  async getReservation(
    reservationId: string,
  ): Promise<SpendReservation | undefined> {
    return this.reservations.get(reservationId)?.reservation;
  }

  // The one CAS primitive every terminal transition shares: a repeat call
  // carrying the SAME idempotency key that already produced this exact
  // terminal state is a no-op (spec: "double-settle/double-release on one
  // reservationId+idempotencyKey is a no-op"); a DIFFERENT key on an
  // already-terminal reservation is a conflict, not a silent overwrite.
  private transition(
    reservationId: string,
    idempotencyKey: string,
    operationKind: TerminalOperationKind,
    apply: (reservation: SpendReservation) => SpendReservation,
  ): boolean {
    const entry = this.reservations.get(reservationId);
    if (entry === undefined) {
      throw new SpendReservationNotFoundError(reservationId);
    }
    if (entry.terminalIdempotencyKey !== undefined) {
      if (
        entry.terminalIdempotencyKey === idempotencyKey &&
        entry.terminalOperationKind === operationKind
      ) {
        return false;
      }
      throw new SpendReservationConflictError(
        reservationId,
        entry.reservation.state,
      );
    }
    entry.reservation = apply(entry.reservation);
    entry.terminalIdempotencyKey = idempotencyKey;
    entry.terminalOperationKind = operationKind;
    return true;
  }
}
