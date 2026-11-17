import { describe, expect, test } from "bun:test";
import { validateReviewSpec } from "#review/spec";
import {
  appendAttempt,
  emptyDiversityLedger,
} from "../../src/diversity/accounting";
import { buildDiversityPlan } from "../../src/diversity/identity";
import { normalizeInclusiveUsage } from "../../src/execution/usage-normalized";

describe("pipeline and store diversity integration", () => {
  test("assembles partial failure evidence without treating absence as agreement", () => {
    const spec = validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "arm",
        maxLegs: 2,
      },
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          models: ["sonnet", "opus"],
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    const plan = buildDiversityPlan({
      spec,
      c2SchemaVersion: "1.1.0",
    });
    let ledger = emptyDiversityLedger();
    for (const leg of plan.legs) {
      ledger = appendAttempt(ledger, {
        attemptId: `${leg.legId}-1`,
        legId: leg.legId,
        armId: plan.armId,
        specialty: leg.specialty,
        replicate: 1,
        attempt: 1,
        status: leg.legId === plan.legs[0]?.legId ? "failed" : "completed",
        usage: normalizeInclusiveUsage({
          wallMs: 1,
          inputTotal: 1,
          outputTotal: 1,
          billingMode: "metered",
        }),
      });
    }
    expect(ledger.failures).toHaveLength(1);
    expect(ledger.attempts).toHaveLength(2);
    expect(ledger.observations).toHaveLength(0);
  });
});
