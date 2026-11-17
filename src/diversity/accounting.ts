import type { NormalizedUsage } from "../execution/usage-normalized";
import type { FindingObservation } from "./clustering";

export type DiversityAttemptStatus =
  | "completed"
  | "failed"
  | "retry"
  | "duplicate"
  | "refuted";

export interface DiversityAttemptRecord {
  readonly attemptId: string;
  readonly legId: string;
  readonly armId: string;
  readonly specialty: string;
  readonly replicate: number;
  readonly attempt: number;
  readonly status: DiversityAttemptStatus;
  readonly usage: NormalizedUsage;
}

export interface DiversityObservationRecord {
  readonly observation: FindingObservation;
  readonly attemptId: string;
  readonly legId: string;
  readonly armId: string;
}

export interface DiversityLedger {
  readonly attempts: readonly DiversityAttemptRecord[];
  readonly observations: readonly DiversityObservationRecord[];
  readonly failures: readonly DiversityAttemptRecord[];
}

export function appendAttempt(
  ledger: DiversityLedger,
  attempt: DiversityAttemptRecord,
): DiversityLedger {
  const attempts = [...ledger.attempts, attempt];
  const failures =
    attempt.status === "failed"
      ? [...ledger.failures, attempt]
      : ledger.failures;
  return { ...ledger, attempts, failures };
}

export function appendObservation(
  ledger: DiversityLedger,
  record: DiversityObservationRecord,
): DiversityLedger {
  return {
    ...ledger,
    observations: [...ledger.observations, record],
  };
}

export function emptyDiversityLedger(): DiversityLedger {
  return { attempts: [], observations: [], failures: [] };
}

export function retainPartialFailureEvidence(ledger: DiversityLedger): boolean {
  if (ledger.failures.length === 0) return true;
  return ledger.observations.length > 0 || ledger.failures.length > 0;
}
