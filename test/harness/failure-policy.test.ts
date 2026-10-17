import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FailureClass } from "../../src/execution/failure-classification";
import {
  causeFromLegacyFailureClass,
  decideRetryDisposition,
  type FailureCause,
  legacyClassificationFromCause,
  type RetryDisposition,
  resolveFailureCause,
} from "../../src/execution/failure-policy";

function outcome(
  overrides: Partial<{
    timedOut: boolean;
    stderrTail: string;
    finalText: string;
  }> = {},
) {
  return {
    completion: "failed" as const,
    protocolIntegrity: "unverified" as const,
    finalText: "not json",
    usage: {
      wallMs: 1,
      tokens: {},
      completeness: "complete" as const,
      billingMode: "subscription" as const,
      costSource: "provider" as const,
      cashCostUsd: 0,
    },
    stderrTail: "",
    ...overrides,
  };
}

const FRESH = { transientAttemptsUsed: 0, formatRetriesUsed: 0 } as const;

// Derived from the §7 disposition table (design doc lines 421-428), NOT from
// the implementation: a table that mirrors the code pins nothing.
const TABLE: ReadonlyArray<readonly [FailureCause, RetryDisposition]> = [
  // "bounded transient retry"
  ["network_transient", { action: "retry_now", budget: "transient" }],
  ["protocol_truncation", { action: "retry_now", budget: "transient" }],
  ["watchdog_timeout", { action: "retry_now", budget: "transient" }],
  // "bounded retry using validated Retry-After or capped exponential backoff"
  [
    "rate_limit",
    { action: "retry_after", budget: "transient", delayMs: 1_000 },
  ],
  // "one independent format reminder retry"
  ["format_violation", { action: "retry_format_reminder", budget: "format" }],
  // "terminal"
  ["auth_invalid", { action: "terminal" }],
  ["quota_exhausted", { action: "terminal" }],
  ["context_window_exceeded", { action: "terminal" }],
  ["output_limit_exceeded", { action: "terminal" }],
  ["safety_refusal", { action: "terminal" }],
  ["provider_configuration_invalid", { action: "terminal" }],
  ["model_unavailable", { action: "terminal" }],
  // WHY terminal: the route's provider has no entry in the OpenCode auth store, and no retry
  // can create one; the fix is a credential change, so the same request fails again.
  ["missing_provider_record", { action: "terminal" }],
  ["runtime_unavailable", { action: "terminal" }],
  // "terminal and transport conformance failure unless explicitly allowlisted"
  ["protocol_mismatch", { action: "terminal" }],
  ["protocol_overflow", { action: "terminal" }],
  // "cancellation or any unconfirmed settlement/remote abort | terminal"
  ["pipeline_cancelled", { action: "terminal" }],
  ["user_cancelled", { action: "terminal" }],
  ["settlement_unconfirmed", { action: "terminal" }],
  ["remote_abort_unconfirmed", { action: "terminal" }],
];

describe("§7 cause vocabulary", () => {
  // The union is frozen verbatim against the design doc (project rule: the
  // schema is sacred until a coordinated bump). Re-deriving the members from
  // the markdown catches a silent widening of the vocabulary that a
  // hand-written list would happily ignore.
  test("the table covers every cause the design doc declares", () => {
    const doc = readFileSync(
      path.join(
        import.meta.dir,
        "../../docs/multi-runtime-model-diversity-design.md",
      ),
      "utf8",
    );
    const block = doc.match(
      /export type TransportFailureCause =([\s\S]*?);[\s\S]*?export type HarnessFailureCause =([\s\S]*?);/,
    );
    expect(block).not.toBeNull();
    const declared = [
      ...(block as RegExpMatchArray)[1].matchAll(/"([a-z_]+)"/g),
      ...(block as RegExpMatchArray)[2].matchAll(/"([a-z_]+)"/g),
    ]
      .map((m) => m[1])
      .sort();
    expect(declared.length).toBe(20);
    const covered: string[] = TABLE.map(([cause]) => cause);
    expect(covered.sort()).toEqual(declared);
  });
});

describe("decideRetryDisposition", () => {
  for (const [cause, expected] of TABLE) {
    test(`${cause} on a fresh state → ${expected.action}`, () => {
      expect(decideRetryDisposition(cause, FRESH)).toEqual(expected);
    });
  }

  test("transient causes go terminal once the transient budget is spent", () => {
    const spent = { transientAttemptsUsed: 3, formatRetriesUsed: 0 };
    for (const cause of [
      "network_transient",
      "protocol_truncation",
      "watchdog_timeout",
      "rate_limit",
    ] as const) {
      expect(decideRetryDisposition(cause, spent)).toEqual({
        action: "terminal",
      });
    }
  });

  test("format_violation goes terminal once the format budget is spent", () => {
    expect(
      decideRetryDisposition("format_violation", {
        transientAttemptsUsed: 0,
        formatRetriesUsed: 1,
      }),
    ).toEqual({ action: "terminal" });
  });

  // §13: "transient and format budgets cannot consume each other" — asserted
  // in BOTH directions, because a single shared counter passes either half.
  test("an exhausted transient budget does not consume the format budget", () => {
    expect(
      decideRetryDisposition("format_violation", {
        transientAttemptsUsed: 99,
        formatRetriesUsed: 0,
      }),
    ).toEqual({ action: "retry_format_reminder", budget: "format" });
  });

  test("an exhausted format budget does not consume the transient budget", () => {
    expect(
      decideRetryDisposition("network_transient", {
        transientAttemptsUsed: 0,
        formatRetriesUsed: 99,
      }),
    ).toEqual({ action: "retry_now", budget: "transient" });
  });

  test("option overrides move each budget independently", () => {
    const state = { transientAttemptsUsed: 1, formatRetriesUsed: 1 };
    expect(
      decideRetryDisposition("network_transient", state, {
        maxTransientAttempts: 1,
      }),
    ).toEqual({ action: "terminal" });
    expect(
      decideRetryDisposition("network_transient", state, {
        maxTransientAttempts: 5,
      }),
    ).toEqual({ action: "retry_now", budget: "transient" });
    expect(
      decideRetryDisposition("format_violation", state, {
        maxFormatRetries: 2,
      }),
    ).toEqual({ action: "retry_format_reminder", budget: "format" });
  });
});

describe("rate_limit backoff", () => {
  function delayOf(
    transientAttemptsUsed: number,
    options?: Parameters<typeof decideRetryDisposition>[2],
  ): number {
    const disposition = decideRetryDisposition(
      "rate_limit",
      { transientAttemptsUsed, formatRetriesUsed: 0 },
      options,
    );
    if (disposition.action !== "retry_after") {
      throw new Error(`expected retry_after, got ${disposition.action}`);
    }
    return disposition.delayMs;
  }

  test("the fallback doubles per transient attempt already used", () => {
    expect(delayOf(0)).toBe(1_000);
    expect(delayOf(1)).toBe(2_000);
    expect(delayOf(2)).toBe(4_000);
  });

  test("the fallback is capped, never unbounded", () => {
    expect(delayOf(0, { maxTransientAttempts: 40 })).toBe(1_000);
    expect(delayOf(30, { maxTransientAttempts: 40 })).toBe(60_000);
  });

  test("a validated Retry-After hint is honored verbatim", () => {
    expect(delayOf(0, { retryAfterMs: 7_500 })).toBe(7_500);
    // Exactly at the cap is still valid — the bound is inclusive.
    expect(delayOf(0, { retryAfterMs: 60_000 })).toBe(60_000);
  });

  test("an out-of-bound or malformed hint falls back to the exponential", () => {
    // One past the cap, at attempt 0 where the exponential is 1s: the
    // fallback is observable, so a silently-clamped hint would be caught.
    expect(delayOf(0, { retryAfterMs: 60_001 })).toBe(1_000);
    expect(delayOf(0, { retryAfterMs: 0 })).toBe(1_000);
    expect(delayOf(0, { retryAfterMs: -5_000 })).toBe(1_000);
    expect(delayOf(0, { retryAfterMs: Number.NaN })).toBe(1_000);
    expect(delayOf(0, { retryAfterMs: Number.POSITIVE_INFINITY })).toBe(1_000);
  });

  test("a lowered cap moves what counts as a validated hint", () => {
    // Over the lowered cap the hint is not validated, so it is DISCARDED for
    // the exponential rather than clamped down to the cap — clamping would
    // silently invent a delay the provider never asked for.
    expect(
      delayOf(0, { retryAfterMs: 5_000, maxRetryAfterDelayMs: 2_000 }),
    ).toBe(1_000);
    expect(
      delayOf(0, { retryAfterMs: 1_500, maxRetryAfterDelayMs: 2_000 }),
    ).toBe(1_500);
    // ...and the exponential itself still respects the lowered cap.
    expect(
      delayOf(4, { maxRetryAfterDelayMs: 2_000, maxTransientAttempts: 9 }),
    ).toBe(2_000);
  });

  test("a hint never resurrects an exhausted transient budget", () => {
    expect(
      decideRetryDisposition(
        "rate_limit",
        { transientAttemptsUsed: 3, formatRetriesUsed: 0 },
        { retryAfterMs: 1_000 },
      ),
    ).toEqual({ action: "terminal" });
  });
});

describe("causeFromLegacyFailureClass", () => {
  // pr-hero F002 on PR #76: the bridge could not produce "watchdog_timeout"
  // at all, because step-runner's classifyFailure collapses `timedOut` into
  // the generic "transient" class BEFORE the bridge sees it
  // (src/review/step-runner.ts:111), and the bridge only accepted the collapsed
  // class. Every watchdog timeout would have been attributed to a network
  // error in the persisted attempt log the harness writes for incident
  // triage. The two causes share a disposition today, so nothing would have
  // failed loudly — it would just have lied in the audit trail.
  test("a timed-out attempt is attributed to the watchdog, not the network", () => {
    expect(
      causeFromLegacyFailureClass("transient", { timedOut: true }),
    ).toEqual({ kind: "cause", cause: "watchdog_timeout" });
  });

  test("the watchdog fact is only consulted for the transient class", () => {
    // A terminal or format ruling is not a timeout even if the outcome also
    // timed out: the stop authority and the format budget are decided by the
    // class, and letting `timedOut` override either would hand a format
    // failure the transient budget.
    expect(causeFromLegacyFailureClass("terminal", { timedOut: true })).toEqual(
      { kind: "legacy_terminal" },
    );
    expect(causeFromLegacyFailureClass("format", { timedOut: true })).toEqual({
      kind: "cause",
      cause: "format_violation",
    });
  });

  test("transient and format map onto §7 causes", () => {
    expect(causeFromLegacyFailureClass("transient")).toEqual({
      kind: "cause",
      cause: "network_transient",
    });
    expect(causeFromLegacyFailureClass("format")).toEqual({
      kind: "cause",
      cause: "format_violation",
    });
  });

  // The legacy "terminal" ruling carries stop authority with no causal
  // content; inventing a cause for it would widen the frozen §7 union.
  test("legacy terminal resolves without inventing a cause", () => {
    const resolved = causeFromLegacyFailureClass("terminal");
    expect(resolved).toEqual({ kind: "legacy_terminal" });
    expect("cause" in resolved).toBe(false);
  });

  test("every legacy class is mapped", () => {
    const classes: FailureClass[] = ["transient", "terminal", "format"];
    for (const legacy of classes) {
      expect(causeFromLegacyFailureClass(legacy)).toBeDefined();
    }
  });
});

// D1-08 PR0: the harness's single cause-resolution entry point. These are
// UNIT tests over the pure function; test/execution/harness-retry.test.ts
// proves the same ordering is actually WIRED into the live attempt loop.
describe("resolveFailureCause", () => {
  test("a timed-out outcome is watchdog_timeout even when the transport classifies it as something else", () => {
    expect(
      resolveFailureCause({
        outcome: outcome({ timedOut: true }),
        classifyFailure: () => "network_transient",
        parseThrew: true,
      }),
    ).toEqual({ kind: "cause", cause: "watchdog_timeout" });
  });

  test("the transport's own classification wins over a bare parse failure", () => {
    expect(
      resolveFailureCause({
        outcome: outcome(),
        classifyFailure: () => "rate_limit",
        parseThrew: true,
      }),
    ).toEqual({ kind: "cause", cause: "rate_limit" });
  });

  test("an unrecognized transport outcome with a thrown parse is format_violation", () => {
    expect(
      resolveFailureCause({
        outcome: outcome(),
        classifyFailure: () => undefined,
        parseThrew: true,
      }),
    ).toEqual({ kind: "cause", cause: "format_violation" });
  });

  // The fallback arm (D2): reached only when the transport recognizes
  // nothing AND the failure was not a parse failure — the legacy witness
  // regexes are consulted as the last resort.
  test("falls back to the legacy classifier when neither the transport nor a parse failure explain it", () => {
    expect(
      resolveFailureCause({
        outcome: outcome({ stderrTail: "read ECONNRESET" }),
        classifyFailure: () => undefined,
        parseThrew: false,
      }),
    ).toEqual({ kind: "cause", cause: "network_transient" });

    expect(
      resolveFailureCause({
        outcome: outcome({
          finalText: "Not logged in · Please run /login",
        }),
        classifyFailure: () => undefined,
        parseThrew: false,
      }),
    ).toEqual({ kind: "legacy_terminal" });
  });
});

describe("legacyClassificationFromCause", () => {
  test("legacy_terminal projects to terminal", () => {
    expect(legacyClassificationFromCause({ kind: "legacy_terminal" })).toBe(
      "terminal",
    );
  });

  test("format_violation projects to format", () => {
    expect(
      legacyClassificationFromCause({
        kind: "cause",
        cause: "format_violation",
      }),
    ).toBe("format");
  });

  test("every transient-family §7 cause projects to transient", () => {
    const transientFamily: FailureCause[] = [
      "network_transient",
      "protocol_truncation",
      "rate_limit",
      "watchdog_timeout",
    ];
    for (const cause of transientFamily) {
      expect(legacyClassificationFromCause({ kind: "cause", cause })).toBe(
        "transient",
      );
    }
  });

  test("every other §7 cause projects to terminal", () => {
    const terminalFamily: FailureCause[] = [
      "auth_invalid",
      "quota_exhausted",
      "context_window_exceeded",
      "output_limit_exceeded",
      "safety_refusal",
      "provider_configuration_invalid",
      "model_unavailable",
      "missing_provider_record",
      "runtime_unavailable",
      "protocol_mismatch",
      "protocol_overflow",
      "pipeline_cancelled",
      "user_cancelled",
      "settlement_unconfirmed",
      "remote_abort_unconfirmed",
    ];
    for (const cause of terminalFamily) {
      expect(legacyClassificationFromCause({ kind: "cause", cause })).toBe(
        "terminal",
      );
    }
  });
});
