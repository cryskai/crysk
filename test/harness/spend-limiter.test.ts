// D1-08 PR4 (§9.1): the credential fence. These tests exercise
// `InMemorySpendLedger`, `settlementFromUsage`, `beginStep`/`nextCycle`
// directly, at the module level.
//
// platform-owned-cost T7: the ledger holds no amount. Usage completeness alone
// decides whether an attempt settles or fences its bucket; `test/harness/
// spend-wiring.test.ts` owns the harness-observable half, and every pure rule
// asserted here has a wiring arm there.

import { describe, expect, test } from "bun:test";
import type { RetryDisposition } from "../../src/execution/failure-policy";
import {
  beginStep,
  InMemorySpendLedger,
  nextCycle,
  type ReserveSpendInput,
  type SettlementDecision,
  SpendReservationConflictError,
  SpendReservationFencedError,
  settlementFromUsage,
} from "../../src/execution/spend-limiter";
import {
  normalizeInclusiveUsage,
  normalizePartialUsage,
  normalizeUnavailableUsage,
  type UsageBillingMode,
} from "../../src/execution/usage-normalized";

function reserveInput(
  overrides: Partial<ReserveSpendInput> = {},
): ReserveSpendInput {
  return {
    bucketId: "bucket-default",
    sessionId: "session-1",
    attempt: 1,
    ...overrides,
  };
}

const MODES: readonly UsageBillingMode[] = [
  "subscription",
  "metered",
  "free",
  "unknown",
];

describe("settlementFromUsage (coupling 1 producer)", () => {
  // Completeness !== "complete" -> ALWAYS the unresolved arm; no amount, no
  // reason, on any credential class.
  test("complete usage settles, whatever the credential class", () => {
    for (const billingMode of MODES) {
      const usage = normalizeInclusiveUsage({
        wallMs: 1200,
        inputTotal: 100,
        outputTotal: 50,
        billingMode,
      });
      expect(settlementFromUsage(usage)).toEqual({ kind: "settle" });
    }
  });

  test("a metered attempt that produced output tokens settles: no figure decides it", () => {
    // Before T7 a metered attempt reporting a zero cost with output tokens was
    // unresolved. Tokens are not a price, so completeness is all that is read.
    expect(
      settlementFromUsage({
        wallMs: 1200,
        tokens: { outputVisible: 50 },
        completeness: "complete",
        billingMode: "metered",
      }),
    ).toEqual({ kind: "settle" });
  });

  test("a free attempt settles; a free route's usage is never judged by a price", () => {
    expect(
      settlementFromUsage({
        wallMs: 1200,
        tokens: { outputVisible: 50, outputKnown: 50 },
        completeness: "complete",
        billingMode: "free",
      }),
    ).toEqual({ kind: "settle" });
  });

  test("an attempt that never reached the provider (empty tokens) settles", () => {
    expect(
      settlementFromUsage({
        wallMs: 40,
        tokens: {},
        completeness: "complete",
        billingMode: "metered",
      }),
    ).toEqual({ kind: "settle" });
  });

  test("partial usage always resolves to unresolved, on every credential class", () => {
    for (const billingMode of MODES) {
      const usage = normalizePartialUsage({
        wallMs: 800,
        providerReportedTotal: 500,
        billingMode,
      });
      expect(settlementFromUsage(usage)).toEqual({ kind: "unresolved" });
    }
  });

  test("unavailable usage resolves to unresolved", () => {
    const usage = normalizeUnavailableUsage({ wallMs: 300 });

    expect(settlementFromUsage(usage)).toEqual({ kind: "unresolved" });
  });
});

describe("settle() type gate (coupling 1 consumer)", () => {
  // settle()'s second argument is Extract<SettlementDecision, {kind:"settle"}>
  // — an "unresolved" decision must fail tsc, not be caught by a runtime
  // guard. `bun run typecheck` fails if the `@ts-expect-error` below stops
  // being necessary.
  test("an unresolved decision is not accepted by settle()", async () => {
    const ledger = new InMemorySpendLedger();
    const unresolved: SettlementDecision = { kind: "unresolved" };
    // @ts-expect-error — only the "settle" arm is accepted; this must stay a
    // type error, proving coupling 1 is type-unreachable rather than
    // test-asserted. (The id is unknown, so the call rejects at runtime.)
    await expect(ledger.settle("none", unresolved, "k")).rejects.toThrow();
  });

  test("the settle arm settles the reservation", async () => {
    const ledger = new InMemorySpendLedger();
    const reservation = await ledger.reserve(reserveInput(), beginStep());

    await ledger.settle(
      reservation.reservationId,
      { kind: "settle" },
      "idem-settle-1",
    );

    const settled = await ledger.getReservation(reservation.reservationId);
    expect(settled?.state).toBe("settled");
  });
});

describe("ReserveToken coupling (coupling 2)", () => {
  // reserve() requires a ReserveToken; nextCycle() on a terminal disposition
  // returns undefined, so a terminal attempt cannot construct one to open a
  // new cycle.
  test("beginStep() yields a token that opens the first reservation of a step", async () => {
    const ledger = new InMemorySpendLedger();
    const token = beginStep();

    const reservation = await ledger.reserve(reserveInput(), token);

    expect(reservation.state).toBe("reserved");
  });

  test("nextCycle() on a terminal disposition returns undefined", () => {
    const terminal: RetryDisposition = { action: "terminal" };

    expect(nextCycle(terminal)).toBeUndefined();
  });

  test("nextCycle() on a non-terminal disposition returns a token that opens a new reservation", async () => {
    const retryNow: RetryDisposition = {
      action: "retry_now",
      budget: "transient",
    };
    const token = nextCycle(retryNow);
    expect(token).toBeDefined();

    const ledger = new InMemorySpendLedger();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const reservation = await ledger.reserve(reserveInput(), token!);

    expect(reservation.state).toBe("reserved");
  });

  test("reserve()'s token parameter is mandatory at compile time — undefined does not widen into it", () => {
    type ReserveTokenArg = Parameters<InMemorySpendLedger["reserve"]>[1];
    // @ts-expect-error — a terminal disposition's `undefined` (from
    // nextCycle) cannot be assigned where a ReserveToken is required; this
    // must stay a type error so a terminal disposition structurally cannot
    // open a new reserve+admit cycle.
    const invalid: ReserveTokenArg = undefined;
    expect(invalid).toBeUndefined();
  });
});

describe("CAS idempotency", () => {
  // Double-settle/double-release on one reservationId+idempotencyKey is a
  // no-op.
  test("calling settle twice with the same idempotency key does not re-apply", async () => {
    const ledger = new InMemorySpendLedger();
    const reservation = await ledger.reserve(reserveInput(), beginStep());

    await ledger.settle(
      reservation.reservationId,
      { kind: "settle" },
      "idem-repeat",
    );
    await ledger.settle(
      reservation.reservationId,
      { kind: "settle" },
      "idem-repeat",
    );

    const settled = await ledger.getReservation(reservation.reservationId);
    expect(settled?.state).toBe("settled");
  });

  test("calling releaseUnstarted twice with the same idempotency key does not throw", async () => {
    const ledger = new InMemorySpendLedger();
    const reservation = await ledger.reserve(reserveInput(), beginStep());

    await ledger.releaseUnstarted(reservation.reservationId, "idem-release");
    await ledger.releaseUnstarted(reservation.reservationId, "idem-release");

    const released = await ledger.getReservation(reservation.reservationId);
    expect(released?.state).toBe("released_unstarted");
  });

  test("a second settle under a DIFFERENT idempotency key on an already-terminal reservation is a conflict, not a silent overwrite", async () => {
    const ledger = new InMemorySpendLedger();
    const reservation = await ledger.reserve(reserveInput(), beginStep());

    await ledger.settle(
      reservation.reservationId,
      { kind: "settle" },
      "idem-first",
    );

    await expect(
      ledger.settle(
        reservation.reservationId,
        { kind: "settle" },
        "idem-second",
      ),
    ).rejects.toBeInstanceOf(SpendReservationConflictError);
  });

  test("the same idempotency key with a different terminal operation is a conflict, not a silent overwrite", async () => {
    const ledger = new InMemorySpendLedger();
    const reservation = await ledger.reserve(reserveInput(), beginStep());

    await ledger.settle(
      reservation.reservationId,
      { kind: "settle" },
      "idem-shared",
    );

    await expect(
      ledger.releaseUnstarted(reservation.reservationId, "idem-shared"),
    ).rejects.toBeInstanceOf(SpendReservationConflictError);

    const settled = await ledger.getReservation(reservation.reservationId);
    expect(settled?.state).toBe("settled");
  });
});

describe("unresolved_remote fences the bucket", () => {
  // An unresolved_remote reservation in a bucket blocks any new reservation in
  // that bucket for the rest of the run.
  test("once a bucket has an unresolved_remote reservation, a new reservation in that bucket is refused before it runs", async () => {
    const ledger = new InMemorySpendLedger();
    const first = await ledger.reserve(
      reserveInput({ bucketId: "bucket-fenced" }),
      beginStep(),
    );
    await ledger.markUnresolvedRemote(first.reservationId, "idem-unresolved");

    await expect(
      ledger.reserve(
        reserveInput({ bucketId: "bucket-fenced", sessionId: "session-2" }),
        beginStep(),
      ),
    ).rejects.toBeInstanceOf(SpendReservationFencedError);
  });

  test("a different bucket is unaffected by another bucket's unresolved_remote fence", async () => {
    const ledger = new InMemorySpendLedger();
    const first = await ledger.reserve(
      reserveInput({ bucketId: "bucket-fenced-2" }),
      beginStep(),
    );
    await ledger.markUnresolvedRemote(first.reservationId, "idem-2");

    const other = await ledger.reserve(
      reserveInput({ bucketId: "bucket-healthy" }),
      beginStep(),
    );

    expect(other.state).toBe("reserved");
  });
});

// The surviving rule end to end at the module level: usage completeness picks
// the CAS transition, and only the fencing one blocks the credential. The
// metered credential is the case that matters — incomplete usage there is a
// hole in what the platform will price.
describe("completeness drives the fence on a metered credential", () => {
  async function finalize(usage: Parameters<typeof settlementFromUsage>[0]) {
    const ledger = new InMemorySpendLedger();
    const reservation = await ledger.reserve(
      reserveInput({ bucketId: "bucket-metered" }),
      beginStep(),
    );
    const decision = settlementFromUsage(usage);
    if (decision.kind === "settle") {
      await ledger.settle(reservation.reservationId, decision, "idem-final");
    } else {
      await ledger.markUnresolvedRemote(
        reservation.reservationId,
        "idem-final",
      );
    }
    return ledger;
  }

  test("incomplete usage fences the bucket: the next reserve is refused", async () => {
    const ledger = await finalize(
      normalizePartialUsage({
        wallMs: 10,
        providerReportedTotal: 120,
        billingMode: "metered",
      }),
    );

    await expect(
      ledger.reserve(
        reserveInput({ bucketId: "bucket-metered", attempt: 2 }),
        beginStep(),
      ),
    ).rejects.toBeInstanceOf(SpendReservationFencedError);
  });

  test("unavailable usage fences the bucket too", async () => {
    const ledger = await finalize(
      normalizeUnavailableUsage({ wallMs: 10, billingMode: "metered" }),
    );

    await expect(
      ledger.reserve(
        reserveInput({ bucketId: "bucket-metered", attempt: 2 }),
        beginStep(),
      ),
    ).rejects.toBeInstanceOf(SpendReservationFencedError);
  });

  test("complete usage settles without fencing: the next reserve is admitted", async () => {
    const ledger = await finalize(
      normalizeInclusiveUsage({
        wallMs: 10,
        inputTotal: 100,
        outputTotal: 50,
        billingMode: "metered",
      }),
    );

    const next = await ledger.reserve(
      reserveInput({ bucketId: "bucket-metered", attempt: 2 }),
      beginStep(),
    );
    expect(next.state).toBe("reserved");
  });
});
