import { describe, expect, test } from "bun:test";
import {
  appendAttempt,
  appendObservation,
  emptyDiversityLedger,
  retainPartialFailureEvidence,
} from "../../src/diversity/accounting";
import type { FindingObservation } from "../../src/diversity/clustering";
import { normalizeInclusiveUsage } from "../../src/execution/usage-normalized";

const usage = normalizeInclusiveUsage({
  wallMs: 10,
  inputTotal: 100,
  outputTotal: 50,
  billingMode: "metered",
});

const observation = (): FindingObservation => ({
  observationId: "o1",
  specialty: "reliability",
  legId: "leg-1",
  backend: "claude-code",
  provider: "anthropic",
  modelFamily: "claude",
  modelSnapshot: "sonnet",
  replicate: 1,
  attempt: 1,
  promptFingerprint: "prompt",
  routeFingerprint: "route",
  path: "src/a.ts",
  line: 1,
  category: 1,
  severity: "CRITICAL",
  claim: "claim",
  evidence: "evidence",
  proofRefs: [],
  causalHypothesis: "hypothesis",
  artifactSha256: "sha",
});

describe("diversity accounting", () => {
  test("counts retries, failures, and successes per attempt", () => {
    let ledger = emptyDiversityLedger();
    ledger = appendAttempt(ledger, {
      attemptId: "a1",
      legId: "leg-1",
      armId: "arm",
      specialty: "reliability",
      replicate: 1,
      attempt: 1,
      status: "failed",
      usage,
    });
    ledger = appendAttempt(ledger, {
      attemptId: "a2",
      legId: "leg-1",
      armId: "arm",
      specialty: "reliability",
      replicate: 1,
      attempt: 2,
      status: "completed",
      usage,
    });
    ledger = appendObservation(ledger, {
      observation: observation(),
      attemptId: "a2",
      legId: "leg-1",
      armId: "arm",
    });
    expect(ledger.attempts).toHaveLength(2);
    expect(ledger.failures).toHaveLength(1);
    expect(ledger.observations).toHaveLength(1);
    // The retry's usage is kept per attempt, tokens only.
    expect(ledger.attempts[1]?.usage.tokens.totalKnown).toBe(150);
    expect(retainPartialFailureEvidence(ledger)).toBe(true);
  });
});
