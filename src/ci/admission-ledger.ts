// Durable CI admission attempt ledger (WU-02): pure reserve/settle/idempotency.
// Persistence is GitHub Check Runs (pr/pr.ts); PR comments stay presentation-only.

import { createHash } from "node:crypto";

export const ADMISSION_LEDGER_SCHEMA_VERSION = 1;
export const ADMISSION_CHECK_RUN_NAME = "pr-hero/ci-admission";

// `"yielded"`: this run stood down because another pr-hero review already
// held a pending commit status on the same head (musive #1935: a local hook
// review was running when CI started). It is terminal, never re-settled, and
// spends no attempt. Older engines read it through parseAdmissionRecord's
// open string status as neither budget-counting nor active, which is the
// same answer, so no schema bump is needed.
export type AdmissionAttemptStatus =
  | "reserved"
  | "provider-started"
  | "completed"
  | "skipped"
  | "failed"
  | "cancelled"
  | "yielded"
  // #326: a size or budget gate skip. Terminal, and it spends nothing (see
  // TERMINAL_BUDGET_STATUSES). An older engine reads it as an unknown string
  // status, which is neither budget-counting nor active: the same answer as
  // `"yielded"` above, so no schema bump either.
  | "gate-skipped"
  | "unknown";

export interface AdmissionRecord {
  schemaVersion: 1;
  prNumber: number;
  headSha: string;
  policyHash: string;
  reservationId: string;
  attemptNumber: number;
  status: AdmissionAttemptStatus;
  decisionReason: string;
  priorScore: number | null;
  blockingCount: number | null;
  advisoryCount: number | null;
  workflowRunId: string | null;
  createdAt: string;
  settledAt: string | null;
  // WHY a flag and not decisionReason: settleAdmissionAttempt overwrites
  // decisionReason at every settle, so a forced run's reason is gone by the
  // time a count reads the row. Absent on an automatic row, so every row
  // written before this field existed reads as automatic.
  forced?: true;
  // WHY a per-POST nonce: a reserve POST whose gh call timed out may have
  // created a run GitHub accepted. The nonce is minted once per upsert call and
  // written into that run's record, so a lookup can name exactly the run this
  // call created. Absent on every row written before this field existed, and
  // such a row never matches a lookup.
  postNonce?: string;
}

// #164, Juanma 2026-09-01: a cancelled run posted nothing, so it must not
// spend one of the PR's review attempts. `"cancelled"` stays a real status
// (the signal handler settles to it) and stays OUT of this set. Putting it
// back would make the settlement a no-op on the budget half of the issue.
// `"provider-started"` stays in: a record still armed that way is a run that
// never settled, and counting it is what makes an abandoned reservation
// visible until the handler writes `"cancelled"`.
// `"yielded"` stays out for the same reason as `"cancelled"`: the run spent
// nothing and reviewed nothing. The review that DID run on this head is
// counted where it records itself (its own ledger row in CI, or the summary
// comment's state block for a local review). Counting the yield as well
// would charge the PR twice for one review and exhaust the budget early.
// #326: a SIZE or BUDGET gate skip stands down the same way, so it settles as
// `"gate-skipped"`, and that stays out too. It used to settle as `"skipped"`,
// which is in this set (admission skips keep it on purpose), so every gate
// skip spent an attempt. The workflow-heads leg then counted that head a second
// time, and a PR with one review run reported "2/2 attempts" (#326).
// A forced row (`forced: true`, a `/pr-hero review` or `/pr-hero recheck`
// comment) is excluded whatever its status: the budget bounds AUTOMATIC reviews,
// and a writer's explicit comment is a deliberate spend outside it. The filter
// is in countTerminalAttempts, not in this set, because a forced `completed`
// row is still a real completed review.
const TERMINAL_BUDGET_STATUSES: ReadonlySet<AdmissionAttemptStatus> = new Set([
  "completed",
  "failed",
  "provider-started",
  "skipped",
]);

// #326, workflow-run leg: a head leaves the attempt count only when EVERY
// ledger row on it is in this allowlist, because each listed status is written
// BEFORE any provider spend, so it proves the run spent nothing:
// - `"gate-skipped"`: settleCiGateSkip (pr/admission.ts:152) runs from the size
//   gate (pr/review-pr.ts:312) and the budget gate (pr/plan.ts:153, reached from
//   pr/review-pr.ts:401). Both come before the `"provider-started"` settle at
//   pr/review-pr.ts:516.
// - `"gate-skipped"` also comes from recordCiConfigErrorSkip (pr/ci-admission-gate.ts),
//   called from the pre-reservation catch in pr/review-pr.ts when gotchas or the
//   prompt set is misconfigured. It runs before any reservation or provider call.
// - `"yielded"`: written only by yieldToInFlightReview (pr/ci-admission-gate.ts:380),
//   whose sole caller is pr/review-pr.ts:359, again before the `"provider-started"`
//   settle at pr/review-pr.ts:516.
// `"cancelled"` is excluded on purpose, because it can be written AFTER spend:
// settleHeldAdmissionLedgerOnSignal (pr/admission.ts:123) writes it over a
// `"provider-started"` row when cli.ts:287 or cli.ts:299 handles a SIGTERM or
// SIGINT, and by then hunters may already have run. A job killed by
// `timeout-minutes` concludes `failure`, so its head stays counted. The
// ledger-row count still ignores `"cancelled"` (see TERMINAL_BUDGET_STATUSES,
// #164). That decision stands. This list does not widen it.
// `"reserved"` is deliberately absent. The `"provider-started"` settle runs
// before runPipeline and is best-effort (tryPersistCiAdmissionLedger swallows a
// write error), so a run killed after that write failed still sits at
// `"reserved"` although it may have spent provider tokens. The run list counted
// that head before #326 and must keep counting it. Any unknown status also stays
// out, so the rule fails closed.
export const PROVABLY_UNSPENT_STATUSES: ReadonlySet<AdmissionAttemptStatus> =
  new Set(["gate-skipped", "yielded"]);

const ACTIVE_RESERVATION_STATUSES: ReadonlySet<AdmissionAttemptStatus> =
  new Set(["reserved", "provider-started"]);

export function admissionRecordFingerprint(
  prNumber: number,
  headSha: string,
  policyHash: string,
): string {
  const canonical = `${prNumber}:${headSha}:${policyHash}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function parseAdmissionRecord(text: string): AdmissionRecord | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AdmissionRecord>;
    if (
      parsed.schemaVersion !== ADMISSION_LEDGER_SCHEMA_VERSION ||
      typeof parsed.prNumber !== "number" ||
      typeof parsed.headSha !== "string" ||
      typeof parsed.policyHash !== "string" ||
      typeof parsed.reservationId !== "string" ||
      typeof parsed.attemptNumber !== "number" ||
      typeof parsed.status !== "string" ||
      typeof parsed.decisionReason !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      prNumber: parsed.prNumber,
      headSha: parsed.headSha,
      policyHash: parsed.policyHash,
      reservationId: parsed.reservationId,
      attemptNumber: parsed.attemptNumber,
      status: parsed.status as AdmissionAttemptStatus,
      decisionReason: parsed.decisionReason,
      priorScore:
        parsed.priorScore === null || typeof parsed.priorScore === "number"
          ? (parsed.priorScore ?? null)
          : null,
      blockingCount:
        parsed.blockingCount === null ||
        typeof parsed.blockingCount === "number"
          ? (parsed.blockingCount ?? null)
          : null,
      advisoryCount:
        parsed.advisoryCount === null ||
        typeof parsed.advisoryCount === "number"
          ? (parsed.advisoryCount ?? null)
          : null,
      workflowRunId:
        parsed.workflowRunId === null ||
        typeof parsed.workflowRunId === "string"
          ? (parsed.workflowRunId ?? null)
          : null,
      createdAt: parsed.createdAt,
      settledAt:
        parsed.settledAt === null || typeof parsed.settledAt === "string"
          ? (parsed.settledAt ?? null)
          : null,
      ...(parsed.forced === true ? { forced: true as const } : {}),
      ...(typeof parsed.postNonce === "string"
        ? { postNonce: parsed.postNonce }
        : {}),
    };
  } catch {
    return null;
  }
}

export function serializeAdmissionRecord(record: AdmissionRecord): string {
  return JSON.stringify(record);
}

export function countTerminalAttempts(
  records: readonly AdmissionRecord[],
): number {
  return records.filter(
    (record) =>
      record.forced !== true && TERMINAL_BUDGET_STATUSES.has(record.status),
  ).length;
}

function recordsForFingerprint(
  records: readonly AdmissionRecord[],
  prNumber: number,
  headSha: string,
  policyHash: string,
): AdmissionRecord[] {
  const reservationId = admissionRecordFingerprint(
    prNumber,
    headSha,
    policyHash,
  );
  return records.filter(
    (record) =>
      record.prNumber === prNumber &&
      record.headSha === headSha &&
      record.policyHash === policyHash &&
      record.reservationId === reservationId,
  );
}

function nextAttemptNumber(records: readonly AdmissionRecord[]): number {
  let max = 0;
  for (const record of records) {
    if (record.attemptNumber > max) max = record.attemptNumber;
  }
  return max + 1;
}

export function isReservationStale(
  record: AdmissionRecord,
  ttlSeconds: number,
  now: Date = new Date(),
): boolean {
  if (record.status !== "reserved") return false;
  const createdMs = Date.parse(record.createdAt);
  if (Number.isNaN(createdMs)) return true;
  const ageSeconds = (now.getTime() - createdMs) / 1000;
  return ageSeconds > ttlSeconds;
}

export function selectActiveReservation(
  records: readonly AdmissionRecord[],
  headSha: string,
  policyHash: string,
  ttlSeconds: number,
  now?: Date,
): AdmissionRecord | null {
  const matches = records
    .filter(
      (record) =>
        record.headSha === headSha &&
        record.policyHash === policyHash &&
        ACTIVE_RESERVATION_STATUSES.has(record.status),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const record of matches) {
    if (
      record.status === "reserved" &&
      isReservationStale(record, ttlSeconds, now)
    ) {
      continue;
    }
    return record;
  }
  return null;
}

export function reserveAdmissionAttempt(input: {
  existing: readonly AdmissionRecord[];
  prNumber: number;
  headSha: string;
  policyHash: string;
  workflowRunId?: string | null;
  now?: Date;
  decisionReason?: string;
  priorScore?: number | null;
  blockingCount?: number | null;
  advisoryCount?: number | null;
  reservationTtlSeconds: number;
  forced?: boolean;
}): { record: AdmissionRecord; created: boolean } {
  const now = input.now ?? new Date();
  const active = selectActiveReservation(
    input.existing,
    input.headSha,
    input.policyHash,
    input.reservationTtlSeconds,
    now,
  );
  // WHY an active row is reused only when its kind matches the caller's: a
  // forced caller may take over an active AUTOMATIC row, and the run settles it
  // as automatic (a forced run that races an in-flight automatic run is counted
  // as that automatic run; accepted, the active row belongs to a run already
  // in progress). An AUTOMATIC caller never takes over a FORCED row: that row
  // would carry `forced: true` through every settle, and countTerminalAttempts
  // would then drop the automatic run's own spend. So the automatic caller
  // creates its own row beside it instead.
  if (active !== null && !(input.forced !== true && active.forced === true)) {
    return { record: active, created: false };
  }

  const scoped = recordsForFingerprint(
    input.existing,
    input.prNumber,
    input.headSha,
    input.policyHash,
  );
  const reservationId = admissionRecordFingerprint(
    input.prNumber,
    input.headSha,
    input.policyHash,
  );
  const record: AdmissionRecord = {
    schemaVersion: 1,
    prNumber: input.prNumber,
    headSha: input.headSha,
    policyHash: input.policyHash,
    reservationId,
    attemptNumber: nextAttemptNumber(scoped),
    status: "reserved",
    decisionReason: input.decisionReason ?? "",
    priorScore: input.priorScore ?? null,
    blockingCount: input.blockingCount ?? null,
    advisoryCount: input.advisoryCount ?? null,
    workflowRunId: input.workflowRunId ?? null,
    createdAt: now.toISOString(),
    settledAt: null,
    ...(input.forced === true ? { forced: true as const } : {}),
  };
  return { record, created: true };
}

export function settleAdmissionAttempt(
  record: AdmissionRecord,
  status: AdmissionAttemptStatus,
  decisionReason: string,
  settledAt?: Date,
): AdmissionRecord {
  const at = settledAt ?? new Date();
  return {
    ...record,
    status,
    decisionReason,
    settledAt: at.toISOString(),
  };
}
