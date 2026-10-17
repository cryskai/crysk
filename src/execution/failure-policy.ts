// §7 (docs/multi-runtime-model-diversity-design.md lines 370-422): cause
// answers WHAT happened; disposition answers WHAT the harness may do. They
// are separate types and this pure module is the only place that maps one
// onto the other — LLMs judge, code governs.

import type { TransportFailureCause, TransportOutcome } from "./contracts";
import {
  classifyFailure as classifyLegacyFailure,
  type FailureClass,
} from "./failure-classification";

export type { TransportFailureCause };

// §7 lines 390-395, verbatim.
export type HarnessFailureCause =
  | "format_violation"
  | "watchdog_timeout"
  | "pipeline_cancelled"
  | "user_cancelled"
  | "settlement_unconfirmed";

// §7 line 397, verbatim.
export type FailureCause = TransportFailureCause | HarnessFailureCause;

// §7 lines 399-402, verbatim.
export interface RetryState {
  readonly transientAttemptsUsed: number;
  readonly formatRetriesUsed: number;
}

// §7 lines 404-408, verbatim.
export type RetryDisposition =
  | { action: "retry_now"; budget: "transient" }
  | { action: "retry_after"; budget: "transient"; delayMs: number }
  | { action: "retry_format_reminder"; budget: "format" }
  | { action: "terminal" };

// One failed outcome reduced to policy input. The `legacy_terminal` arm
// carries a stop ruling that has no §7 cause behind it — see the bridge
// comment below for WHY it must stay cause-less.
export type CauseResolution =
  | { readonly kind: "cause"; readonly cause: FailureCause }
  | { readonly kind: "legacy_terminal" };

const DEFAULT_MAX_TRANSIENT_ATTEMPTS = 3;
const DEFAULT_MAX_RETRY_AFTER_DELAY_MS = 60_000;
const DEFAULT_MAX_FORMAT_RETRIES = 1;
// Base of the §7 line 416 capped exponential backoff: doubles per
// transientAttemptsUsed, hard-capped at maxRetryAfterDelayMs.
const RATE_LIMIT_BACKOFF_BASE_MS = 1_000;

export function decideRetryDisposition(
  cause: FailureCause,
  state: RetryState,
  options: {
    readonly maxTransientAttempts?: number;
    readonly maxRetryAfterDelayMs?: number;
    readonly maxFormatRetries?: number;
    // §7 line 416: a VALIDATED Retry-After hint (positive, finite, ≤
    // maxRetryAfterDelayMs) is honored verbatim; an absent or invalid one
    // falls back to the capped exponential. Optional because
    // TransportOutcome carries no Retry-After fact yet — the harness wires
    // the hint through here when a transport ships one.
    readonly retryAfterMs?: number;
  } = {},
): RetryDisposition {
  const maxTransientAttempts =
    options.maxTransientAttempts ?? DEFAULT_MAX_TRANSIENT_ATTEMPTS;
  const maxRetryAfterDelayMs =
    options.maxRetryAfterDelayMs ?? DEFAULT_MAX_RETRY_AFTER_DELAY_MS;
  const maxFormatRetries =
    options.maxFormatRetries ?? DEFAULT_MAX_FORMAT_RETRIES;

  // §7 line 417: the format reminder answers to its OWN budget alone, so it
  // is decided before any transient arithmetic can touch it (§13 line 759).
  if (cause === "format_violation") {
    return state.formatRetriesUsed < maxFormatRetries
      ? { action: "retry_format_reminder", budget: "format" }
      : { action: "terminal" };
  }

  const transientBudgetLeft =
    state.transientAttemptsUsed < maxTransientAttempts;

  switch (cause) {
    case "network_transient":
    case "protocol_truncation":
    case "watchdog_timeout":
      return transientBudgetLeft
        ? { action: "retry_now", budget: "transient" }
        : { action: "terminal" };
    case "rate_limit": {
      if (!transientBudgetLeft) return { action: "terminal" };
      const hint = options.retryAfterMs;
      const delayMs =
        hint !== undefined &&
        Number.isFinite(hint) &&
        hint > 0 &&
        hint <= maxRetryAfterDelayMs
          ? hint
          : Math.min(
              RATE_LIMIT_BACKOFF_BASE_MS * 2 ** state.transientAttemptsUsed,
              maxRetryAfterDelayMs,
            );
      return { action: "retry_after", budget: "transient", delayMs };
    }
    default:
      // §7 lines 418-420: every remaining cause — auth/quota/context/output/
      // safety/config/runtime, protocol conformance failures, cancellations
      // and unconfirmed settlements/aborts — is terminal.
      return { action: "terminal" };
  }
}

// WHY legacy "terminal" becomes a disposition, not a cause: §7 lines 375-397
// freeze the cause vocabulary verbatim, and "the transport said stop" carries
// stop authority without causal content — inventing a union member would
// drift the frozen schema, so the bridge hands the harness a direct terminal
// ruling instead. The transient/format budget separation (§13 line 759) is
// untouched either way.
//
// WHY the raw `timedOut` fact is a parameter and not read off the class:
// step-runner's classifyFailure collapses a watchdog kill into the generic
// "transient" class before anything downstream sees it
// (`src/review/step-runner.ts:111`), so the class ALONE can never distinguish a
// timeout from a network error. §7 declares `watchdog_timeout` a first-class
// cause; a bridge that only accepted the collapsed class would attribute
// every timeout to the network in the per-attempt log the harness persists
// for incident triage. Both causes share a disposition today, so that lie
// would never have failed loudly — it would just have been wrong.
export function causeFromLegacyFailureClass(
  legacy: FailureClass,
  outcome: { readonly timedOut?: boolean } = {},
): CauseResolution {
  switch (legacy) {
    case "transient":
      return {
        kind: "cause",
        // Consulted for this class only: a terminal ruling keeps its stop
        // authority and a format violation keeps its own budget even when the
        // same outcome also timed out.
        cause:
          outcome.timedOut === true ? "watchdog_timeout" : "network_transient",
      };
    case "format":
      return { kind: "cause", cause: "format_violation" };
    case "terminal":
      return { kind: "legacy_terminal" };
  }
}

// D1-08 PR0 (D1-07 wiring): the harness's ONE place to decide "what failed
// and why" — a pure function so the harness itself never touches the legacy
// step-runner classifier or re-implements a transport's own witness
// matching. Ordered per design decision D1:
//   1. timedOut          -> watchdog_timeout (distinct from a plain network
//                            failure — step-runner's classifyFailure collapses
//                            both into "transient" before anything downstream
//                            sees it, which is the pr-hero F002 defect).
//   2. transport-native    -> the SECOND unwired mechanism this slice closes:
//      classifyFailure()     every transport implements classifyFailure with
//                            its own paid-for witness ordering (e.g. checking
//                            rate-limit backpressure before a generic network
//                            witness), and nothing in the live path called it.
//   3. parseThrew         -> format_violation: the model's own JSON was bad,
//                            not a provider/infra problem.
//   4. legacy fallback    -> causeFromLegacyFailureClass(classifyFailure(...))
//                            (D2): retains stop authority for the legacy
//                            terminal ruling and the legacy transient/format
//                            split for any outcome the transport's own
//                            classifier and the parse check both miss.
export interface ResolveFailureCauseInput {
  readonly outcome: TransportOutcome;
  // Not the whole `ProviderTransport` — just the one method, passed as a
  // plain function reference (never bound or wrapped in a lambda): the D1-08
  // spec tripwire greps harness.ts for exactly `this.transport.classifyFailure`
  // and nothing else naming "classifyFailure".
  readonly classifyFailure: (
    outcome: TransportOutcome,
  ) => TransportFailureCause | undefined;
  readonly parseThrew: boolean;
}

export function resolveFailureCause(
  input: ResolveFailureCauseInput,
): CauseResolution {
  const { outcome, classifyFailure, parseThrew } = input;

  if (outcome.timedOut === true) {
    return { kind: "cause", cause: "watchdog_timeout" };
  }

  // A cause the transport holds as a typed fact beats its witness patterns: the
  // witness can only spell it, and a generic witness would lose it.
  if (outcome.failureCause !== undefined) {
    return { kind: "cause", cause: outcome.failureCause };
  }

  const transportCause = classifyFailure(outcome);
  if (transportCause !== undefined) {
    return { kind: "cause", cause: transportCause };
  }

  if (parseThrew) {
    return { kind: "cause", cause: "format_violation" };
  }

  return causeFromLegacyFailureClass(
    classifyLegacyFailure({
      stderrTail: outcome.stderrTail,
      resultText: outcome.finalText,
      timedOut: Boolean(outcome.timedOut),
    }),
    { timedOut: outcome.timedOut },
  );
}

// Legacy attempt logs record `classification: ok|transient|terminal|format`
// (test/step-runner.test.ts pins this literal vocabulary — it must not
// change). The §7 cause is richer than that three-way split — e.g.
// watchdog_timeout and network_transient both legacy-classify as
// "transient" — so this is a lossy PROJECTION back onto the old field for
// backward compatibility; the caller additionally logs the real
// `CauseResolution` in a new, additive line (D1-08 design row 13).
const TRANSIENT_FAMILY_CAUSES: ReadonlySet<FailureCause> = new Set([
  "network_transient",
  "protocol_truncation",
  "rate_limit",
  "watchdog_timeout",
]);

export function legacyClassificationFromCause(
  resolution: CauseResolution,
): FailureClass {
  if (resolution.kind === "legacy_terminal") return "terminal";
  if (resolution.cause === "format_violation") return "format";
  return TRANSIENT_FAMILY_CAUSES.has(resolution.cause)
    ? "transient"
    : "terminal";
}
