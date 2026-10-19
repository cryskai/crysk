import { describe, expect, test } from "bun:test";
import {
  type AdmissionRecord,
  admissionRecordFingerprint,
  countTerminalAttempts,
  isReservationStale,
  parseAdmissionRecord,
  reserveAdmissionAttempt,
  selectActiveReservation,
  serializeAdmissionRecord,
  settleAdmissionAttempt,
} from "#ci/admission-ledger";

const HEAD = "a".repeat(40);
const POLICY_HASH = "abc123def4567890";
const PR = 42;

function baseRecord(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
  const reservationId = admissionRecordFingerprint(PR, HEAD, POLICY_HASH);
  return {
    schemaVersion: 1,
    prNumber: PR,
    headSha: HEAD,
    policyHash: POLICY_HASH,
    reservationId,
    attemptNumber: 1,
    status: "reserved",
    decisionReason: "",
    priorScore: null,
    blockingCount: null,
    advisoryCount: null,
    workflowRunId: null,
    createdAt: "2026-08-28T12:00:00.000Z",
    settledAt: null,
    ...overrides,
  };
}

describe("admissionRecordFingerprint", () => {
  test("is stable for the same pr/head/policy tuple", () => {
    const a = admissionRecordFingerprint(PR, HEAD, POLICY_HASH);
    const b = admissionRecordFingerprint(PR, HEAD, POLICY_HASH);
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  test("changes when policy hash changes", () => {
    expect(admissionRecordFingerprint(PR, HEAD, POLICY_HASH)).not.toBe(
      admissionRecordFingerprint(PR, HEAD, "other-policy-hash"),
    );
  });
});

describe("parseAdmissionRecord / serializeAdmissionRecord", () => {
  test("round-trips compact JSON", () => {
    const record = baseRecord({
      status: "completed",
      decisionReason: "review complete",
      priorScore: 4,
      blockingCount: 1,
      advisoryCount: 2,
      settledAt: "2026-08-28T12:05:00.000Z",
    });
    const text = serializeAdmissionRecord(record);
    expect(text).not.toContain("\n");
    expect(parseAdmissionRecord(text)).toEqual(record);
  });

  test("rejects malformed payloads", () => {
    expect(parseAdmissionRecord("not json")).toBeNull();
    expect(parseAdmissionRecord("{}")).toBeNull();
  });

  test("a record written before postNonce existed still parses, without a nonce", () => {
    const record = baseRecord({ status: "completed" });
    const parsed = parseAdmissionRecord(serializeAdmissionRecord(record));
    expect(parsed).toEqual(record);
    expect(parsed).not.toHaveProperty("postNonce");
  });

  test("carries the POST nonce through a round-trip", () => {
    const record = { ...baseRecord({ status: "reserved" }), postNonce: "n-1" };
    expect(parseAdmissionRecord(serializeAdmissionRecord(record))).toEqual(
      record,
    );
  });
});

describe("countTerminalAttempts", () => {
  test("counts completed, failed, provider-started, and skipped — not a cancellation or a yield", () => {
    const records = [
      baseRecord({ status: "reserved", attemptNumber: 1 }),
      baseRecord({ status: "provider-started", attemptNumber: 2 }),
      baseRecord({ status: "completed", attemptNumber: 3 }),
      baseRecord({ status: "skipped", attemptNumber: 4 }),
      baseRecord({ status: "failed", attemptNumber: 5 }),
      baseRecord({ status: "cancelled", attemptNumber: 6 }),
      baseRecord({ status: "unknown", attemptNumber: 7 }),
      baseRecord({ status: "yielded", attemptNumber: 8 }),
    ];
    // #164: cancelled produced nothing, so it is not a spent attempt.
    // provider-started still counts until the signal handler settles it.
    // yielded stood down for a review already in flight on this head: it
    // reviewed nothing, so it is not a spent attempt either (musive #1935).
    expect(countTerminalAttempts(records)).toBe(4);
  });

  // #326: a size or budget gate skip spent nothing and reviewed nothing, so
  // its own row is not a spent attempt, the same as a cancellation.
  test("does not count a gate skip (size or budget), the same as a cancellation", () => {
    expect(
      countTerminalAttempts([baseRecord({ status: "gate-skipped" })]),
    ).toBe(0);
  });
});

describe("gate-skipped rows read like the other non-spending statuses", () => {
  test("a gate-skipped row round-trips through the check-run text", () => {
    const record = baseRecord({
      status: "gate-skipped",
      decisionReason: "diff exceeds the configured size gate",
    });
    expect(parseAdmissionRecord(serializeAdmissionRecord(record))).toEqual(
      record,
    );
  });

  test("a gate-skipped row does not block the next reservation", () => {
    const { record, created } = reserveAdmissionAttempt({
      existing: [baseRecord({ status: "gate-skipped", attemptNumber: 1 })],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 900,
      now: new Date("2026-08-28T12:00:00.000Z"),
    });
    expect(created).toBe(true);
    expect(record.attemptNumber).toBe(2);
  });
});

describe("isReservationStale", () => {
  test("reserved records expire after TTL", () => {
    const record = baseRecord({
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    const now = new Date("2026-08-28T13:30:00.000Z");
    expect(isReservationStale(record, 3600, now)).toBe(true);
    expect(isReservationStale(record, 7200, now)).toBe(false);
  });

  test("non-reserved records are never stale", () => {
    const record = baseRecord({ status: "provider-started" });
    expect(isReservationStale(record, 1, new Date())).toBe(false);
  });
});

describe("selectActiveReservation", () => {
  test("returns the newest non-stale in-flight reservation", () => {
    const stale = baseRecord({
      attemptNumber: 1,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    const active = baseRecord({
      attemptNumber: 2,
      status: "provider-started",
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    expect(
      selectActiveReservation(
        [stale, active],
        HEAD,
        POLICY_HASH,
        3600,
        new Date("2026-08-28T12:30:00.000Z"),
      ),
    ).toEqual(active);
  });
});

describe("reserveAdmissionAttempt", () => {
  test("creates a new reserved record with incremented attempt number", () => {
    const existing = [
      baseRecord({ status: "completed", attemptNumber: 1 }),
      baseRecord({ status: "skipped", attemptNumber: 2 }),
    ];
    const { record, created } = reserveAdmissionAttempt({
      existing,
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      now: new Date("2026-08-28T13:00:00.000Z"),
    });
    expect(created).toBe(true);
    expect(record.attemptNumber).toBe(3);
    expect(record.status).toBe("reserved");
    expect(record.reservationId).toBe(
      admissionRecordFingerprint(PR, HEAD, POLICY_HASH),
    );
  });

  test("a cancelled row does not block the next reservation", () => {
    const cancelled = baseRecord({
      status: "cancelled",
      attemptNumber: 1,
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    const { record, created } = reserveAdmissionAttempt({
      existing: [cancelled],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      now: new Date("2026-08-28T12:30:00.000Z"),
    });
    expect(created).toBe(true);
    expect(record.attemptNumber).toBe(2);
    expect(record.status).toBe("reserved");
  });

  test("a yielded row does not block the next reservation", () => {
    const yielded = baseRecord({
      status: "yielded",
      attemptNumber: 1,
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    const { record, created } = reserveAdmissionAttempt({
      existing: [yielded],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      now: new Date("2026-08-28T12:30:00.000Z"),
    });
    expect(created).toBe(true);
    expect(record.attemptNumber).toBe(2);
    expect(record.status).toBe("reserved");
  });

  test("is idempotent for an active reservation within TTL", () => {
    const active = baseRecord({
      status: "reserved",
      attemptNumber: 2,
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    const { record, created } = reserveAdmissionAttempt({
      existing: [active],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      now: new Date("2026-08-28T12:30:00.000Z"),
    });
    expect(created).toBe(false);
    expect(record).toEqual(active);
  });

  test("creates a fresh reservation when the prior reserved row is stale", () => {
    const stale = baseRecord({
      status: "reserved",
      attemptNumber: 1,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    const { record, created } = reserveAdmissionAttempt({
      existing: [stale],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      now: new Date("2026-08-28T12:00:00.000Z"),
    });
    expect(created).toBe(true);
    expect(record.attemptNumber).toBe(2);
  });
});

describe("settleAdmissionAttempt", () => {
  test("writes terminal status, reason, and settledAt", () => {
    const settledAt = new Date("2026-08-28T12:10:00.000Z");
    const settled = settleAdmissionAttempt(
      baseRecord(),
      "completed",
      "review complete",
      settledAt,
    );
    expect(settled.status).toBe("completed");
    expect(settled.decisionReason).toBe("review complete");
    expect(settled.settledAt).toBe(settledAt.toISOString());
  });
});

// A forced comment run (`/pr-hero review`, `/pr-hero recheck`) is a deliberate
// spend outside the automatic budget, so its own rows never count. Its status
// is no proof either way (the run may have reached the provider), which is why
// the flag, not the status, decides.
describe("a forced run's row is not an automatic attempt", () => {
  test("countTerminalAttempts does not count a forced row, whatever its status", () => {
    const records = [
      baseRecord({ status: "completed", forced: true }),
      baseRecord({
        status: "provider-started",
        forced: true,
        attemptNumber: 2,
      }),
    ];
    expect(countTerminalAttempts(records)).toBe(0);
  });

  test("an automatic completed row next to a forced one still counts once", () => {
    const records = [
      baseRecord({ status: "completed" }),
      baseRecord({ status: "completed", forced: true, attemptNumber: 2 }),
    ];
    expect(countTerminalAttempts(records)).toBe(1);
  });

  test("reserveAdmissionAttempt marks a forced reservation, and the mark survives the check-run text", () => {
    const { record } = reserveAdmissionAttempt({
      existing: [],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      forced: true,
      reservationTtlSeconds: 600,
    });
    expect(record.forced).toBe(true);
    expect(parseAdmissionRecord(serializeAdmissionRecord(record))?.forced).toBe(
      true,
    );
  });

  test("a row written before the flag existed parses as automatic", () => {
    const legacy = serializeAdmissionRecord(
      baseRecord({ status: "completed" }),
    );
    expect(parseAdmissionRecord(legacy)?.forced).toBeUndefined();
    const parsed = parseAdmissionRecord(legacy);
    expect(parsed).not.toBeNull();
    expect(countTerminalAttempts(parsed === null ? [] : [parsed])).toBe(1);
  });
});

// Race: a forced run reserves and goes in flight; an automatic run on the same
// head reads the ledger and must not reuse the forced run's active row. If it
// did, the automatic run's own completed row would carry `forced: true` and be
// excluded from the attempt count, so one real automatic review would be free.
describe("an automatic run never reuses a forced run's active reservation", () => {
  test("forced reserve active, automatic reserves and completes: the automatic spend counts", () => {
    const now = new Date();
    const forcedReserved = reserveAdmissionAttempt({
      existing: [],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      forced: true,
      now,
    }).record;
    const forcedInFlight = settleAdmissionAttempt(
      forcedReserved,
      "provider-started",
      "forced run in flight",
      now,
    );

    const automatic = reserveAdmissionAttempt({
      existing: [forcedInFlight],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      now,
    }).record;
    expect(automatic.forced).toBeUndefined();
    expect(automatic.attemptNumber).toBe(2);

    const automaticDone = settleAdmissionAttempt(
      automatic,
      "completed",
      "admission: run",
      now,
    );
    expect(automaticDone.forced).toBeUndefined();
    expect(countTerminalAttempts([forcedInFlight, automaticDone])).toBe(1);
  });
});
