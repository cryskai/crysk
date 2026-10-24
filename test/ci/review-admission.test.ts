import { describe, expect, test } from "bun:test";
import type { AdmissionRecord } from "#ci/admission-ledger";
import {
  activeStopAuthors,
  CI_REVIEW_POLICY_SCHEMA_VERSION,
  type CiReviewAdmissionInput,
  type CiReviewPolicy,
  canonicalAdmissionFindings,
  ciReviewPolicyHash,
  ciReviewSkipDetail,
  countableWorkflowHeads,
  DEFAULT_CI_ADVISORY_WEIGHT,
  DEFAULT_CI_BLOCKING_WEIGHT,
  DEFAULT_CI_MAX_ATTEMPTS,
  DEFAULT_CI_REREVIEW_MIN_SCORE,
  DEFAULT_CI_RESERVATION_TTL_SECONDS,
  DEFAULT_CI_REVIEW_POLICY_MODE,
  deltaTouchesPriorFindings,
  evaluateCiReviewAdmission,
  nextStateReviewCount,
  parseCiAdmissionBlock,
  parseFindingCommentTier,
  pathsFromPostedFindingMarkers,
  postedFindingFingerprint,
  priorScoreForAdmission,
  priorTierScore,
  renderCiAdmissionBlock,
  resolveCiAdmissionAttemptCount,
  resolveCiReviewPolicy,
  resolveCiTrustedActors,
  resolveReviewAttemptCount,
  scanPostedFindingTiers,
  stateReviewCount,
  validateAdmissionAuthority,
} from "#ci/review-admission";
import { CI_RISK_POLICY_VERSION, classifyChangedPaths } from "#ci/review-risk";
import { stateFinding } from "#rereview/state";
import type { Tier } from "#review/findings";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const DEFAULT_POLICY = resolveCiReviewPolicy({});

function policy(overrides: Partial<CiReviewPolicy> = {}): CiReviewPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

function admissionInput(
  input: Omit<
    CiReviewAdmissionInput,
    "deltaTouchesPriorFindings" | "deltaRisk"
  > &
    Partial<
      Pick<CiReviewAdmissionInput, "deltaTouchesPriorFindings" | "deltaRisk">
    >,
): CiReviewAdmissionInput {
  return { deltaTouchesPriorFindings: false, deltaRisk: null, ...input };
}

function finding(tier: Tier) {
  return stateFinding({
    id: "R001",
    sev: tier === "blocking" ? "CRITICAL" : "WARNING",
    tier,
    channel: "inline",
    locs: ["src/a.ts:1"],
    claim: "x",
  });
}

function admissionBody(
  counts: { blocking: number; advisory: number },
  reviews = 1,
): string {
  return (
    `<!-- pr-hero-report head=${HEAD_A} -->\n` +
    renderCiAdmissionBlock(HEAD_A, counts, reviews)
  );
}

function postedFindingComment(input: {
  head: string;
  tier: Tier;
  path?: string;
  line?: number;
  c?: string;
}): string {
  const emoji = input.tier === "blocking" ? "🔴" : "🟡";
  const severity = input.tier === "blocking" ? "CRITICAL" : "WARNING";
  const path = encodeURIComponent(input.path ?? "src/ci/review-admission.ts");
  const line = input.line ?? 121;
  const c = input.c ?? "abcd1234abcd";
  return (
    `<!-- pr-hero-finding path=${path} line=${line} head=${input.head} c=${c} -->\n\n` +
    `${emoji} ${input.tier} · ${severity} · introduced · reliability\n\n` +
    "claim text"
  );
}

describe("priorTierScore", () => {
  test("2 advisory → score 2", () => {
    expect(
      priorTierScore([finding("advisory"), finding("advisory")], DEFAULT_POLICY)
        .score,
    ).toBe(2);
  });

  test("1 advisory + 1 blocking → score 3", () => {
    expect(
      priorTierScore([finding("advisory"), finding("blocking")], DEFAULT_POLICY)
        .score,
    ).toBe(3);
  });

  test("2 advisory + 1 blocking → score 4", () => {
    expect(
      priorTierScore(
        [finding("advisory"), finding("advisory"), finding("blocking")],
        DEFAULT_POLICY,
      ).score,
    ).toBe(4);
  });
});

describe("parseFindingCommentTier", () => {
  test("reads blocking tier from the posted header line", () => {
    expect(
      parseFindingCommentTier(
        postedFindingComment({ head: HEAD_A, tier: "blocking" }),
      ),
    ).toBe("blocking");
  });

  test("reads advisory tier from the posted header line", () => {
    expect(
      parseFindingCommentTier(
        postedFindingComment({ head: HEAD_A, tier: "advisory" }),
      ),
    ).toBe("advisory");
  });

  test("returns null when the header line is missing", () => {
    expect(
      parseFindingCommentTier(
        `<!-- pr-hero-finding path=src%2Fa.ts line=1 head=${HEAD_A} c=abcd1234abcd -->\n\njust a claim`,
      ),
    ).toBeNull();
  });
});

describe("scanPostedFindingTiers", () => {
  test("counts only markers for the prior summary head", () => {
    expect(
      scanPostedFindingTiers({
        summaryHead: HEAD_A,
        comments: [
          {
            body: postedFindingComment({
              head: HEAD_A,
              tier: "blocking",
              c: "111111111111",
            }),
          },
          {
            body: postedFindingComment({
              head: HEAD_A,
              tier: "blocking",
              c: "222222222222",
            }),
          },
          {
            body: postedFindingComment({
              head: HEAD_B,
              tier: "blocking",
              c: "333333333333",
            }),
          },
        ],
      }),
    ).toEqual({
      blocking: 2,
      advisory: 0,
      matchedMarkers: 2,
      parsedTiers: 2,
    });
  });

  test("dedupes duplicate markers with the same full fingerprint", () => {
    const body = postedFindingComment({
      head: HEAD_A,
      tier: "blocking",
      c: "same-fingerprint",
    });
    expect(
      scanPostedFindingTiers({
        summaryHead: HEAD_A,
        comments: [{ body }, { body }],
      }),
    ).toEqual({
      blocking: 1,
      advisory: 0,
      matchedMarkers: 1,
      parsedTiers: 1,
    });
  });

  test("counts same claim fingerprint at different lines separately", () => {
    expect(
      scanPostedFindingTiers({
        summaryHead: HEAD_A,
        comments: [
          {
            body: postedFindingComment({
              head: HEAD_A,
              tier: "blocking",
              c: "same-c",
              line: 10,
            }),
          },
          {
            body: postedFindingComment({
              head: HEAD_A,
              tier: "blocking",
              c: "same-c",
              line: 20,
            }),
          },
        ],
      }),
    ).toEqual({
      blocking: 2,
      advisory: 0,
      matchedMarkers: 2,
      parsedTiers: 2,
    });
  });

  test("uses tier from the header line, not severity", () => {
    const demotedCritical =
      `<!-- pr-hero-finding path=src%2Fa.ts line=1 head=${HEAD_A} c=abcd1234abcd -->\n\n` +
      "🟡 advisory · CRITICAL · introduced · reliability\n\nclaim";
    expect(
      priorScoreForAdmission({
        state: null,
        admission: null,
        postedFindings: scanPostedFindingTiers({
          summaryHead: HEAD_A,
          comments: [{ body: demotedCritical }],
        }),
        policy: DEFAULT_POLICY,
      }),
    ).toMatchObject({
      source: "posted-findings",
      blocking: 0,
      advisory: 1,
      score: 1,
    });
  });
});

describe("parseCiAdmissionBlock", () => {
  test("reads tier counts from the admission marker", () => {
    expect(
      parseCiAdmissionBlock(admissionBody({ blocking: 1, advisory: 2 })),
    ).toEqual({
      headSha: HEAD_A,
      blocking: 1,
      advisory: 2,
      reviews: 1,
    });
  });

  test("ignores severity headline counts", () => {
    expect(
      parseCiAdmissionBlock(
        `<!-- pr-hero-report head=${HEAD_A} -->\n🔴 9 critical · 🟡 0 warning`,
      ),
    ).toBeNull();
  });
});

describe("priorScoreForAdmission precedence", () => {
  test("state findings beat admission and posted comments", () => {
    expect(
      priorScoreForAdmission({
        state: { headSha: HEAD_A, hw: 0, findings: [finding("advisory")] },
        admission: { headSha: HEAD_A, blocking: 9, advisory: 0, reviews: 1 },
        postedFindings: {
          blocking: 9,
          advisory: 0,
          matchedMarkers: 1,
          parsedTiers: 1,
        },
        policy: DEFAULT_POLICY,
      }).source,
    ).toBe("state");
  });

  test("admission block beats posted comments", () => {
    expect(
      priorScoreForAdmission({
        state: null,
        admission: { headSha: HEAD_A, blocking: 1, advisory: 0, reviews: 1 },
        postedFindings: {
          blocking: 9,
          advisory: 0,
          matchedMarkers: 1,
          parsedTiers: 1,
        },
        policy: DEFAULT_POLICY,
      }),
    ).toMatchObject({ source: "admission", score: 2 });
  });

  test("posted comments bootstrap when no machine-readable summary block exists", () => {
    expect(
      priorScoreForAdmission({
        state: null,
        admission: null,
        postedFindings: {
          blocking: 3,
          advisory: 0,
          matchedMarkers: 3,
          parsedTiers: 3,
        },
        policy: DEFAULT_POLICY,
      }),
    ).toMatchObject({ source: "posted-findings", score: 6 });
  });

  test("markers without tier lines fail open instead of scoring zero", () => {
    expect(
      priorScoreForAdmission({
        state: null,
        admission: null,
        postedFindings: {
          blocking: 0,
          advisory: 0,
          matchedMarkers: 2,
          parsedTiers: 0,
        },
        policy: DEFAULT_POLICY,
      }),
    ).toMatchObject({ score: 0, failOpen: true });
  });
});

describe("evaluateCiReviewAdmission", () => {
  test("first review always runs", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_A,
          summaryHead: null,
          markerSeen: false,
          reviewCount: 0,
          state: null,
          admission: null,
          postedFindings: null,
          policy: DEFAULT_POLICY,
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("same head skips", () => {
    const admission = parseCiAdmissionBlock(
      admissionBody({ blocking: 2, advisory: 0 }),
    );
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_A,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission,
        postedFindings: null,
        policy: DEFAULT_POLICY,
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("same-head");
    }
  });

  // A partial prior review on this head is a floor, not a verdict: "same
  // head" cannot skip it, and neither can its own below-threshold score.
  // The attempt cap and the explicit manual_only/once_per_pr policies still
  // apply, so a head whose agents keep timing out cannot loop unbounded.
  test("same head whose last review was partial runs instead of skipping", () => {
    const admission = parseCiAdmissionBlock(
      admissionBody({ blocking: 0, advisory: 0 }),
    );
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_A,
        summaryHead: HEAD_A,
        summaryComplete: false,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission,
        postedFindings: null,
        policy: policy({ mode: "thresholded" }),
      }),
    );
    expect(verdict).toEqual({ action: "run" });
  });

  test("same head whose last review was partial still respects the attempt cap", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_A,
        summaryHead: HEAD_A,
        summaryComplete: false,
        markerSeen: true,
        reviewCount: DEFAULT_CI_MAX_ATTEMPTS,
        state: null,
        admission: null,
        postedFindings: null,
        policy: DEFAULT_POLICY,
      }),
    );
    expect(verdict.action).toBe("manual-required");
    if (verdict.action === "manual-required") {
      expect(verdict.reason).toBe("max-attempts-exhausted");
    }
  });

  test("same head whose last review was partial still respects once_per_pr", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_A,
        summaryHead: HEAD_A,
        summaryComplete: false,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: null,
        postedFindings: null,
        policy: policy({ mode: "once_per_pr" }),
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("once-per-pr");
    }
  });

  test("same head with an explicitly complete last review still skips", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_A,
        summaryHead: HEAD_A,
        summaryComplete: true,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: null,
        postedFindings: null,
        policy: DEFAULT_POLICY,
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("same-head");
    }
  });

  test("2 advisory-tier findings on prior review skips re-review", () => {
    const admission = parseCiAdmissionBlock(
      admissionBody({ blocking: 0, advisory: 2 }),
    );
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission,
        postedFindings: null,
        policy: DEFAULT_POLICY,
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("below-threshold");
      expect(verdict.prior.score).toBe(2);
    }
  });

  test("severity headline alone does not inflate the score", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: null,
        postedFindings: null,
        policy: DEFAULT_POLICY,
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("below-threshold");
      expect(verdict.prior.score).toBe(0);
    }
  });

  test("bootstrap: three posted blocking findings trigger re-review without admission block", () => {
    const postedFindings = scanPostedFindingTiers({
      summaryHead: HEAD_A,
      comments: [
        {
          body: postedFindingComment({
            head: HEAD_A,
            tier: "blocking",
            c: "111111111111",
          }),
        },
        {
          body: postedFindingComment({
            head: HEAD_A,
            tier: "blocking",
            c: "222222222222",
            line: 143,
          }),
        },
        {
          body: postedFindingComment({
            head: HEAD_A,
            tier: "blocking",
            c: "333333333333",
            line: 121,
          }),
        },
      ],
    });
    expect(postedFindings).toMatchObject({
      blocking: 3,
      parsedTiers: 3,
    });
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: null,
          postedFindings,
          policy: DEFAULT_POLICY,
        }),
      ),
    ).toEqual({ action: "run" });
    expect(
      priorScoreForAdmission({
        state: null,
        admission: null,
        postedFindings,
        policy: DEFAULT_POLICY,
      }).score,
    ).toBe(6);
  });

  test("unreadable posted markers fail open", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: null,
          postedFindings: {
            blocking: 0,
            advisory: 0,
            matchedMarkers: 1,
            parsedTiers: 0,
          },
          policy: DEFAULT_POLICY,
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("2 advisory + 1 blocking triggers re-review", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: {
            headSha: HEAD_A,
            hw: 0,
            findings: [
              finding("advisory"),
              finding("advisory"),
              finding("blocking"),
            ],
          },
          admission: null,
          postedFindings: null,
          policy: DEFAULT_POLICY,
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("max attempts produces manual-required, not skip", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 2,
        state: {
          headSha: HEAD_A,
          hw: 0,
          findings: [finding("blocking"), finding("blocking")],
          reviews: 2,
        },
        admission: null,
        postedFindings: null,
        policy: DEFAULT_POLICY,
      }),
    );
    expect(verdict.action).toBe("manual-required");
    if (verdict.action === "manual-required") {
      expect(verdict.reason).toBe("max-attempts-exhausted");
      expect(verdict.maxAttempts).toBe(2);
    }
  });
});

describe("stateReviewCount", () => {
  test("reads reviews from state when present", () => {
    expect(
      stateReviewCount(
        { headSha: HEAD_A, hw: 0, findings: [], reviews: 2 },
        true,
      ),
    ).toBe(2);
  });

  test("reads reviews from admission block when state has no counter", () => {
    const admission = parseCiAdmissionBlock(
      admissionBody({ blocking: 0, advisory: 1 }, 2),
    );
    expect(stateReviewCount(null, true, admission)).toBe(2);
  });

  test("falls back to 1 when a marker exists but state has no counter", () => {
    expect(stateReviewCount(null, true)).toBe(1);
  });
});

describe("resolveCiReviewPolicy defaults", () => {
  test("matches the agreed floor", () => {
    expect(resolveCiReviewPolicy({})).toEqual({
      schemaVersion: CI_REVIEW_POLICY_SCHEMA_VERSION,
      mode: DEFAULT_CI_REVIEW_POLICY_MODE,
      maxAttempts: DEFAULT_CI_MAX_ATTEMPTS,
      rereviewMinScore: DEFAULT_CI_REREVIEW_MIN_SCORE,
      blockingWeight: DEFAULT_CI_BLOCKING_WEIGHT,
      advisoryWeight: DEFAULT_CI_ADVISORY_WEIGHT,
      reservationTtlSeconds: DEFAULT_CI_RESERVATION_TTL_SECONDS,
    });
  });

  test("prefers ci_max_attempts over ci_max_reviews", () => {
    expect(
      resolveCiReviewPolicy({ ci_max_attempts: 3, ci_max_reviews: 5 }),
    ).toMatchObject({ maxAttempts: 3 });
  });

  test("falls back to ci_max_reviews when ci_max_attempts is absent", () => {
    expect(resolveCiReviewPolicy({ ci_max_reviews: 5 })).toMatchObject({
      maxAttempts: 5,
    });
  });
});

describe("ciReviewPolicyHash", () => {
  test("changes when mode changes", () => {
    const base = resolveCiReviewPolicy({});
    const thresholded = policy({ mode: "thresholded" });
    expect(ciReviewPolicyHash(base)).not.toBe(ciReviewPolicyHash(thresholded));
  });

  test("is stable for the same policy", () => {
    const policyValue = resolveCiReviewPolicy({
      ci_review_policy: "every_push",
    });
    expect(ciReviewPolicyHash(policyValue)).toBe(
      ciReviewPolicyHash(policyValue),
    );
    expect(ciReviewPolicyHash(policyValue)).toHaveLength(16);
  });
});

describe("evaluateCiReviewAdmission — policy modes", () => {
  const lowScoreAdmission = parseCiAdmissionBlock(
    admissionBody({ blocking: 0, advisory: 1 }),
  );

  test("once_per_pr skips after the first review", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: lowScoreAdmission,
        postedFindings: null,
        policy: policy({ mode: "once_per_pr" }),
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("once-per-pr");
    }
  });

  test("manual_only requires manual override after the first review", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: lowScoreAdmission,
        postedFindings: null,
        policy: policy({ mode: "manual_only" }),
      }),
    );
    expect(verdict.action).toBe("manual-required");
    if (verdict.action === "manual-required") {
      expect(verdict.reason).toBe("manual-only-policy");
    }
  });

  test("every_push runs on low score", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: lowScoreAdmission,
          postedFindings: null,
          policy: policy({ mode: "every_push" }),
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("thresholded ignores delta bypass", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: lowScoreAdmission,
        postedFindings: null,
        policy: policy({ mode: "thresholded" }),
        deltaTouchesPriorFindings: true,
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("below-threshold");
    }
  });

  test("risk_aware honors delta bypass", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: lowScoreAdmission,
          postedFindings: null,
          policy: policy({ mode: "risk_aware" }),
          deltaTouchesPriorFindings: true,
        }),
      ),
    ).toEqual({ action: "run" });
  });
});

describe("resolveCiTrustedActors", () => {
  test("includes GITHUB_ACTOR and repo-config extras", () => {
    const actors = resolveCiTrustedActors({
      githubActor: "pr-hero[bot]",
      extra: ["custom-bot"],
    });
    expect(actors).toEqual(new Set(["pr-hero[bot]", "custom-bot"]));
  });

  test("returns undefined when no actors are configured", () => {
    expect(resolveCiTrustedActors({})).toBeUndefined();
  });
});

describe("resolveReviewAttemptCount", () => {
  test("takes the max of state counter and completed workflow heads", () => {
    expect(
      resolveReviewAttemptCount({
        stateCount: 1,
        workflowHeads: new Set([HEAD_A, HEAD_B]),
      }),
    ).toBe(2);
  });
});

function ledgerRow(
  headSha: string,
  status: AdmissionRecord["status"],
): AdmissionRecord {
  return {
    schemaVersion: 1,
    prNumber: 326,
    headSha,
    policyHash: "abc123def4567890",
    reservationId: "0123456789abcdef",
    attemptNumber: 1,
    status,
    decisionReason: "",
    priorScore: null,
    blockingCount: null,
    advisoryCount: null,
    workflowRunId: null,
    createdAt: "2026-10-16T12:00:00.000Z",
    settledAt: null,
  };
}

// #326: a head whose pr-hero run concluded success only because the gate
// skipped it spent nothing, so it must not count as a review attempt. A
// head with no ledger row at all (a run older than the ledger) still counts.
describe("countableWorkflowHeads", () => {
  test("drops a head whose only ledger row is a gate skip (#326)", () => {
    const countable = countableWorkflowHeads(
      new Set([HEAD_A]),
      new Map([[HEAD_A, [ledgerRow(HEAD_A, "gate-skipped")]]]),
    );
    expect(countable.has(HEAD_A)).toBe(false);
  });

  // `reserved` is deliberately absent: a reserved row does not prove the run
  // spent nothing, so it is kept below (the provider-started settle is
  // best-effort and the run may have reached the provider anyway).
  test.each(["yielded"] as const)(
    "drops a head whose only ledger row is %s (spent nothing, like the gate skip)",
    (status) => {
      const countable = countableWorkflowHeads(
        new Set([HEAD_A]),
        new Map([[HEAD_A, [ledgerRow(HEAD_A, status)]]]),
      );
      expect(countable.has(HEAD_A)).toBe(false);
    },
  );

  // F001: `cancelled` is written over a `provider-started` row by the SIGTERM
  // and SIGINT handlers (admission.ts settleHeldAdmissionLedgerOnSignal), after
  // hunters may already have run. A `timeout-minutes` kill concludes the run
  // `failure`, so this head is in the workflow-run list and must stay counted.
  test("keeps a head whose only ledger row is cancelled (a signal can land after provider spend)", () => {
    const countable = countableWorkflowHeads(
      new Set([HEAD_A]),
      new Map([[HEAD_A, [ledgerRow(HEAD_A, "cancelled")]]]),
    );
    expect(countable.has(HEAD_A)).toBe(true);
  });

  test("keeps a head whose only ledger row is reserved (provider-started write may have failed)", () => {
    const countable = countableWorkflowHeads(
      new Set([HEAD_A]),
      new Map([[HEAD_A, [ledgerRow(HEAD_A, "reserved")]]]),
    );
    expect(countable.has(HEAD_A)).toBe(true);
  });

  test("keeps a head with a reserved row next to a gate skip", () => {
    const countable = countableWorkflowHeads(
      new Set([HEAD_A]),
      new Map([
        [
          HEAD_A,
          [ledgerRow(HEAD_A, "gate-skipped"), ledgerRow(HEAD_A, "reserved")],
        ],
      ]),
    );
    expect(countable.has(HEAD_A)).toBe(true);
  });

  test("keeps a head whose only ledger row has a status this engine does not know", () => {
    // Simulates a row written by a newer engine: the parser casts the status
    // string through unchecked, so the allowlist must fail closed on it.
    const unknownStatus = "some-future-status" as AdmissionRecord["status"];
    const countable = countableWorkflowHeads(
      new Set([HEAD_A]),
      new Map([[HEAD_A, [ledgerRow(HEAD_A, unknownStatus)]]]),
    );
    expect(countable.has(HEAD_A)).toBe(true);
  });

  test("keeps a head that has no ledger row at all", () => {
    const countable = countableWorkflowHeads(new Set([HEAD_B]), new Map());
    expect(countable.has(HEAD_B)).toBe(true);
  });

  test.each(["completed", "failed", "provider-started", "skipped"] as const)(
    "keeps a head with a %s row",
    (status) => {
      const countable = countableWorkflowHeads(
        new Set([HEAD_B]),
        new Map([[HEAD_B, [ledgerRow(HEAD_B, status)]]]),
      );
      expect(countable.has(HEAD_B)).toBe(true);
    },
  );

  test("keeps a gate-skipped head that also has a completed row", () => {
    const countable = countableWorkflowHeads(
      new Set([HEAD_A]),
      new Map([
        [
          HEAD_A,
          [ledgerRow(HEAD_A, "gate-skipped"), ledgerRow(HEAD_A, "completed")],
        ],
      ]),
    );
    expect(countable.has(HEAD_A)).toBe(true);
  });
});

describe("postedFindingFingerprint", () => {
  test("joins head, path, line, and claim fingerprint", () => {
    expect(
      postedFindingFingerprint({
        headSha: HEAD_A,
        path: "src/a.ts",
        line: 10,
        c: "abcd1234abcd",
      }),
    ).toBe(`${HEAD_A}:src/a.ts:10:abcd1234abcd`);
  });
});

describe("validateAdmissionAuthority", () => {
  test("accepts matching report, state, and admission heads", () => {
    expect(
      validateAdmissionAuthority({
        summaryHead: HEAD_A,
        reportMarkerHead: HEAD_A,
        state: { headSha: HEAD_A, hw: 0, findings: [] },
        admission: { headSha: HEAD_A, blocking: 0, advisory: 1, reviews: 1 },
      }),
    ).toEqual({ ok: true, authoritativeHead: HEAD_A });
  });

  test("fail-opens when admission head mismatches report marker", () => {
    expect(
      validateAdmissionAuthority({
        summaryHead: HEAD_A,
        reportMarkerHead: HEAD_A,
        state: null,
        admission: { headSha: HEAD_B, blocking: 0, advisory: 0, reviews: 1 },
      }),
    ).toMatchObject({
      ok: false,
      failOpen: true,
      reason: "report marker head does not match admission block head",
    });
  });

  test("fail-opens when state head mismatches summary", () => {
    expect(
      validateAdmissionAuthority({
        summaryHead: HEAD_A,
        reportMarkerHead: HEAD_A,
        state: { headSha: HEAD_B, hw: 0, findings: [] },
        admission: null,
      }),
    ).toMatchObject({
      ok: false,
      failOpen: true,
      reason: "state block head does not match summary head",
    });
  });

  test("fail-opens when admission head mismatches summary", () => {
    expect(
      validateAdmissionAuthority({
        summaryHead: HEAD_A,
        reportMarkerHead: HEAD_B,
        state: null,
        admission: { headSha: HEAD_B, blocking: 0, advisory: 0, reviews: 1 },
      }),
    ).toMatchObject({
      ok: false,
      failOpen: true,
      reason: "admission block head does not match summary head",
    });
  });
});

describe("evaluateCiReviewAdmission — authorityFailOpen", () => {
  test("runs instead of below-threshold skip when authority is untrusted", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: parseCiAdmissionBlock(
            admissionBody({ blocking: 0, advisory: 1 }),
          ),
          postedFindings: null,
          policy: DEFAULT_POLICY,
          authorityFailOpen: true,
        }),
      ),
    ).toEqual({ action: "run" });
  });
});

describe("canonicalAdmissionFindings", () => {
  test("dedupes inline and outside buckets by finding id", () => {
    const findings = canonicalAdmissionFindings([
      { id: "R001", tier: "blocking" },
      { id: "R001", tier: "blocking" },
      { id: "R002", tier: "advisory" },
    ]);
    expect(findings).toEqual([
      { id: "R001", tier: "blocking" },
      { id: "R002", tier: "advisory" },
    ]);
  });

  test("dedupes outside-diff duplicates that share an id with inline findings", () => {
    const findings = canonicalAdmissionFindings([
      { id: "R001", tier: "blocking" },
      { id: "R001", tier: "blocking" },
      { id: "R003", tier: "advisory" },
      { id: "R003", tier: "advisory" },
    ]);
    expect(findings).toHaveLength(2);
    expect(priorTierScore(findings, DEFAULT_POLICY).score).toBe(3);
  });
});

describe("deltaTouchesPriorFindings", () => {
  test("is true when a changed path overlaps a prior finding path", () => {
    expect(
      deltaTouchesPriorFindings(["src/a.ts", "src/b.ts"], ["src/b.ts"]),
    ).toBe(true);
  });

  test("is false when no prior paths overlap", () => {
    expect(deltaTouchesPriorFindings(["src/a.ts"], ["src/z.ts"])).toBe(false);
  });
});

describe("pathsFromPostedFindingMarkers", () => {
  test("ignores markers from untrusted actors", () => {
    const trusted = new Set(["pr-hero[bot]"]);
    expect(
      pathsFromPostedFindingMarkers(
        [
          {
            user: "evil-user",
            body: postedFindingComment({
              head: HEAD_A,
              tier: "blocking",
              path: "src/evil.ts",
            }),
          },
          {
            user: "pr-hero[bot]",
            body: postedFindingComment({
              head: HEAD_A,
              tier: "blocking",
              path: "src/real.ts",
            }),
          },
        ],
        HEAD_A,
        trusted,
      ),
    ).toEqual(["src/real.ts"]);
  });
});

describe("scanPostedFindingTiers — trusted actors", () => {
  test("ignores untrusted markers and dedupes by fingerprint", () => {
    const trusted = new Set(["pr-hero[bot]"]);
    const body = postedFindingComment({
      head: HEAD_A,
      tier: "blocking",
      c: "same-fingerprint",
    });
    expect(
      scanPostedFindingTiers({
        summaryHead: HEAD_A,
        comments: [
          { user: "pr-hero[bot]", body },
          { user: "pr-hero[bot]", body },
          {
            user: "evil-user",
            body: postedFindingComment({
              head: HEAD_A,
              tier: "blocking",
              c: "forged",
            }),
          },
        ],
        trustedActors: trusted,
      }),
    ).toEqual({
      blocking: 1,
      advisory: 0,
      matchedMarkers: 1,
      parsedTiers: 1,
    });
  });

  test("fail-opens when only untrusted markers exist", () => {
    const trusted = new Set(["pr-hero[bot]"]);
    expect(
      scanPostedFindingTiers({
        summaryHead: HEAD_A,
        comments: [
          {
            user: "evil-user",
            body: postedFindingComment({ head: HEAD_A, tier: "blocking" }),
          },
        ],
        trustedActors: trusted,
      }),
    ).toEqual({
      blocking: 0,
      advisory: 0,
      matchedMarkers: 0,
      parsedTiers: 0,
      failOpen: true,
    });
  });
});

describe("evaluateCiReviewAdmission — delta risk bypass", () => {
  test("runs when new commits touch a prior finding path despite low score", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody({ blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: DEFAULT_POLICY,
        deltaTouchesPriorFindings: true,
      }),
    );
    expect(verdict).toEqual({ action: "run" });
  });

  test("skips docs-only delta under risk_aware with low-risk-delta", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody({ blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: policy({ mode: "risk_aware" }),
        deltaRisk: classifyChangedPaths(["docs/guide.md", "README.md"]),
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("low-risk-delta");
      expect(verdict.prior.score).toBe(1);
      expect(ciReviewSkipDetail(verdict)).toContain("low-risk paths");
    }
  });

  test("runs on production delta after a low-score review", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: parseCiAdmissionBlock(
            admissionBody({ blocking: 0, advisory: 1 }),
          ),
          postedFindings: null,
          policy: policy({ mode: "risk_aware" }),
          deltaRisk: classifyChangedPaths(["src/pipeline.ts"]),
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("runs when delta risk is unknown instead of skipping", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: parseCiAdmissionBlock(
            admissionBody({ blocking: 0, advisory: 1 }),
          ),
          postedFindings: null,
          policy: policy({ mode: "risk_aware" }),
          deltaRisk: {
            version: CI_RISK_POLICY_VERSION,
            class: "unknown",
            reason: "no changed paths in delta metadata",
            changedPaths: [],
            highRiskPaths: [],
            lowRiskPaths: [],
          },
        }),
      ),
    ).toEqual({ action: "run" });
  });
});

// A forced comment run is a deliberate spend outside the AUTOMATIC budget
// (see countableWorkflowHeads and countTerminalAttempts), so the head it ran on
// and the summary counter it would bump must both stay as they were.
describe("a forced run does not spend an automatic attempt", () => {
  const forcedRow = (
    headSha: string,
    status: AdmissionRecord["status"],
    attemptNumber: number,
  ): AdmissionRecord => ({
    ...ledgerRow(headSha, status),
    attemptNumber,
    forced: true,
  });

  test("countableWorkflowHeads drops a head whose only rows are forced", () => {
    const countable = countableWorkflowHeads(
      new Set([HEAD_A]),
      new Map([[HEAD_A, [forcedRow(HEAD_A, "completed", 1)]]]),
    );
    expect(countable.has(HEAD_A)).toBe(false);
  });

  test("keeps a head that has an automatic completed row next to a forced one", () => {
    const countable = countableWorkflowHeads(
      new Set([HEAD_A]),
      new Map([
        [
          HEAD_A,
          [ledgerRow(HEAD_A, "completed"), forcedRow(HEAD_A, "completed", 2)],
        ],
      ]),
    );
    expect(countable.has(HEAD_A)).toBe(true);
  });

  test("nextStateReviewCount keeps the previous count for a forced run", () => {
    const state = { headSha: HEAD_A, findings: [], reviews: 2, hw: 0 };
    expect(
      nextStateReviewCount({ existingSummaryId: 7, state, force: true }),
    ).toBe(2);
  });

  test("nextStateReviewCount still adds one for an automatic run", () => {
    const state = { headSha: HEAD_A, findings: [], reviews: 2, hw: 0 };
    expect(nextStateReviewCount({ existingSummaryId: 7, state })).toBe(3);
  });

  test("the attempt count is the highest of the three legs, with forced rows left out", () => {
    const ledgerRecords = [
      ledgerRow(HEAD_A, "completed"),
      ledgerRow(HEAD_B, "failed"),
      forcedRow(HEAD_A, "completed", 2),
    ];
    // Terminal rows (completed + failed) are the highest leg: 2.
    expect(
      resolveCiAdmissionAttemptCount({
        stateCount: 1,
        workflowHeads: new Set([HEAD_A]),
        ledgerRecords,
      }),
    ).toBe(2);
    // The summary counter wins when it is higher.
    expect(
      resolveCiAdmissionAttemptCount({
        stateCount: 5,
        workflowHeads: new Set([HEAD_A]),
        ledgerRecords,
      }),
    ).toBe(5);
    // Distinct workflow heads win when they are higher.
    expect(
      resolveCiAdmissionAttemptCount({
        stateCount: 1,
        workflowHeads: new Set([HEAD_A, HEAD_B, "c".repeat(40)]),
        ledgerRecords,
      }),
    ).toBe(3);
  });
});

// A forced FIRST review posts the first summary of the PR. That summary must
// read as zero automatic reviews. If it read as one (for example because a
// floor of 1 was written, or because the zero block failed to parse so the
// marker fallback counted the summary), the next automatic push would be
// charged the forced run's attempt.
describe("a forced first review's summary reads as zero automatic reviews", () => {
  test("the count is 0, the admission block carries 0, and the attempt count stays 0", () => {
    const count = nextStateReviewCount({
      existingSummaryId: null,
      state: null,
      force: true,
    });
    expect(count).toBe(0);

    const summaryBody = renderCiAdmissionBlock(
      HEAD_A,
      { blocking: 0, advisory: 0 },
      count,
    );
    const parsed = parseCiAdmissionBlock(summaryBody);
    expect(parsed?.reviews).toBe(0);
    expect(stateReviewCount(null, true, parsed)).toBe(0);
    const forcedRow: AdmissionRecord = {
      ...ledgerRow(HEAD_A, "completed"),
      forced: true,
    };
    // The gate passes only countable heads, so the forced-only head is dropped first.
    expect(
      resolveCiAdmissionAttemptCount({
        stateCount: stateReviewCount(null, true, parsed),
        workflowHeads: countableWorkflowHeads(
          new Set([HEAD_A]),
          new Map([[HEAD_A, [forcedRow]]]),
        ),
        ledgerRecords: [forcedRow],
      }),
    ).toBe(0);
  });

  test("an automatic first review still writes 1", () => {
    expect(nextStateReviewCount({ existingSummaryId: null, state: null })).toBe(
      1,
    );
  });
});

describe("evaluateCiReviewAdmission — stopped", () => {
  const firstReview = {
    currentHead: HEAD_A,
    summaryHead: null,
    markerSeen: false,
    reviewCount: 0,
    state: null,
    admission: null,
    postedFindings: null,
    policy: DEFAULT_POLICY,
  };

  test("a stop skips even a PR's first review", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({ ...firstReview, stopped: true }),
    );
    expect(verdict.action === "skip" && verdict.reason).toBe("stopped");
  });

  test("an already reviewed head keeps its same-head reason under a stop", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        ...firstReview,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        admission: parseCiAdmissionBlock(
          admissionBody({ blocking: 2, advisory: 0 }),
        ),
        stopped: true,
      }),
    );
    expect(verdict.action === "skip" && verdict.reason).toBe("same-head");
  });

  test("an explicit forced run beats a stop", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({ ...firstReview, stopped: true, forceOverride: true }),
      ),
    ).toEqual({ action: "run" });
  });
});

describe("activeStopAuthors", () => {
  const c = (user: string, body: string) => ({ user, body });

  test("collects stop authors after the last review command, newest first, once each", () => {
    expect(
      activeStopAuthors([
        c("old", "/pr-hero stop"),
        c("maint", "/pr-hero review --full"),
        c("a", "/pr-hero stop"),
        c("b", "  /pr-hero stop\n"),
        c("a", "/pr-hero stop"),
        c("x", "looks good"),
      ]),
    ).toEqual(["a", "b"]);
  });

  test("ignores near misses and returns nothing without a stop", () => {
    expect(
      activeStopAuthors([
        c("a", "/pr-hero stop please"),
        c("b", "/pr-hero  stop"),
      ]),
    ).toEqual([]);
  });
});
