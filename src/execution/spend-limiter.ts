// D1-08 PR4 (§9.1): the credential fence. An in-memory per-run ledger of
// reservations, behind an interface whose only stateful operations are CAS
// transitions (design decision D7) — so a durable adapter (D1-08f) can
// implement `SpendLedger` with zero caller changes.
//
// platform-owned-cost T7 (S12, L7): the ledger no longer holds an amount. It
// used to reserve dollars, settle them from the provider's reported cost and
// fence a bucket when a spend could not be resolved (#279). The dollars are
// gone — the platform prices a run from the facts the engine reports — but the
// fence never needed an amount: what it protects is "an attempt on a metered
// credential whose usage the engine could not confirm is a hole in what the
// platform will price, so no new attempt runs on that credential for the rest
// of the run". That is kept, driven by usage completeness alone. Two rules
// that read a dollar figure went with the amount: the metered-zero rule (a
// metered attempt that produced output tokens and reported $0) and the
// free-nonzero rule (a free-declared route that reported a priced cost). A
// token count is not a price, so neither can be decided here any more.
//
// Wiring. `StepExecutionHarness.runAttempt` calls `reserve()` before the
// transport and `finalizeReservation` applies the CAS transition
// `settlementFromUsage` names (harness.ts), `runPipeline`'s
// `collectUnresolvedSpend` gathers the terminal `unresolved_remote`
// reservations into `PipelineResult.unresolved` (pipeline.ts), and
// `renderResult` prints them (ui/result.ts). `MultiProviderRunner`
// (production-runtime.ts) holds ONE instance for the run, which is what makes
// `fencedBuckets` below a run-scoped fence rather than a per-step no-op.
//
// It is composed for METERED bindings only, plus a FREE OpenCode binding
// (`provider_free`), which reserves too even though its capability report says
// subscription. A claude-only subscription run therefore records zero
// reservations, and the absent `reservations` key on those steps is the
// truthful signal, not a gap. `ClaudeCodeRunner` (step-runner.ts) stays
// ledger-free for the same reason.
//
// Two couplings the spec calls out as the easiest to lose across chained
// PRs are made TYPE-unreachable here rather than asserted at runtime:
//   1. `settle()`'s second argument is narrowed to the "settle" arm of
//      SettlementDecision — an attempt whose usage completeness isn't
//      "complete" can never be handed to `settle()`; tsc refuses the call
//      before any code runs (spec: "Non-Complete Usage Never Settles").
//   2. `reserve()`'s second argument is a branded ReserveToken that only
//      `beginStep()` (attempt 1) or `nextCycle()` on a NON-terminal
//      RetryDisposition can produce. `nextCycle()` returns `undefined` for
//      a terminal disposition, so a terminal attempt structurally cannot
//      construct a token to open a new reserve+admit cycle (spec: "Only
//      Non-Terminal Disposition Starts A New Reserve+Admit Cycle").

import { randomUUID } from "node:crypto";
import type { RetryDisposition } from "./failure-policy";
import type { NormalizedUsage } from "./usage-normalized";

// ---- Coupling 1: settlement decision ----

export type SettlementDecision =
  | { readonly kind: "settle" }
  | { readonly kind: "unresolved" };

// spec: "Non-Complete Usage Never Settles" — completeness other than
// "complete" is ALWAYS the unresolved arm. This is the ONLY producer of
// SettlementDecision.
export function settlementFromUsage(
  usage: NormalizedUsage,
): SettlementDecision {
  return usage.completeness === "complete"
    ? { kind: "settle" }
    : { kind: "unresolved" };
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
  readonly sessionId: string;
  readonly attempt: number;
}

export interface SpendReservation {
  readonly reservationId: string;
  readonly bucketId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly state: SpendReservationState;
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
      state: "reserved",
    };
    this.reservations.set(reservation.reservationId, { reservation });
    return reservation;
  }

  async settle(
    reservationId: string,
    _decision: Extract<SettlementDecision, { kind: "settle" }>,
    idempotencyKey: string,
  ): Promise<void> {
    this.transition(
      reservationId,
      idempotencyKey,
      "settled",
      (reservation) => ({
        ...reservation,
        state: "settled",
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
    idempotencyKey: string,
  ): Promise<void> {
    const applied = this.transition(
      reservationId,
      idempotencyKey,
      "unresolved_remote",
      (reservation) => ({
        ...reservation,
        state: "unresolved_remote",
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
