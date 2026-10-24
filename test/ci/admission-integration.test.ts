import { describe, expect, test } from "bun:test";
import {
  type AdmissionRecord,
  admissionRecordFingerprint,
  reserveAdmissionAttempt,
  settleAdmissionAttempt,
} from "#ci/admission-ledger";
import { planCiReviewManualRequired, planCiReviewSkip } from "#ci/gates";
import {
  type CiReviewAdmissionInput,
  canonicalAdmissionFindings,
  ciReviewPolicyHash,
  countableWorkflowHeads,
  evaluateCiReviewAdmission,
  formatCiAdmissionObserveNotice,
  parseCiAdmissionBlock,
  priorTierScore,
  renderCiAdmissionBlock,
  resolveCiAdmissionAttemptCount,
  resolveCiReviewPolicy,
  scanPostedFindingTiers,
} from "#ci/review-admission";
import { classifyChangedPaths } from "#ci/review-risk";
import { fetchPrComments } from "#pr/pr";
import { PR_FINDING_MARKER_PREFIX } from "#pr/preflight";
import type { Tier } from "#review/findings";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const HEAD_D = "d".repeat(40);
const PR = 42;
const POLICY = resolveCiReviewPolicy({ ci_max_attempts: 2 });
const POLICY_HASH = ciReviewPolicyHash(POLICY);

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

function admissionBody(
  head: string,
  counts: { blocking: number; advisory: number },
  reviews = 1,
): string {
  return (
    `<!-- pr-hero-report head=${head} -->\n` +
    renderCiAdmissionBlock(head, counts, reviews)
  );
}

function postedFindingComment(input: {
  head: string;
  tier: Tier;
  user?: string;
  c?: string;
}): string {
  const emoji = input.tier === "blocking" ? "🔴" : "🟡";
  const severity = input.tier === "blocking" ? "CRITICAL" : "WARNING";
  const c = input.c ?? "abcd1234abcd";
  return (
    `<!-- pr-hero-finding path=${encodeURIComponent("src/a.ts")} line=1 head=${input.head} c=${c} -->\n\n` +
    `${emoji} ${input.tier} · ${severity} · introduced · reliability\n\n` +
    "claim text"
  );
}

// #326: a head whose pr-hero run concluded success only because the budget
// gate skipped it used to count as a spent attempt. Two heads on the PR had a
// successful run: the first was budget-skipped and spent nothing, the second
// was reviewed. The head being admitted must still have its last attempt.
describe("issue #326 — a gate-skipped head does not spend the budget", () => {
  function freshRow(headSha: string) {
    return reserveAdmissionAttempt({
      existing: [],
      prNumber: PR,
      headSha,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: POLICY.reservationTtlSeconds,
      now: new Date("2026-10-16T12:00:00.000Z"),
    }).record;
  }

  test("the reviewed head is the only attempt, so the next run is admitted", () => {
    const gateSkipped = settleAdmissionAttempt(
      freshRow(HEAD_C),
      "gate-skipped",
      "estimated cost exceeds the configured CI budget ceiling",
    );
    const reviewed = settleAdmissionAttempt(
      freshRow(HEAD_B),
      "completed",
      "review complete",
    );

    const countable = countableWorkflowHeads(
      new Set([HEAD_C, HEAD_B]),
      new Map([
        [HEAD_C, [gateSkipped]],
        [HEAD_B, [reviewed]],
      ]),
    );
    const reviewCount = resolveCiAdmissionAttemptCount({
      stateCount: 0,
      workflowHeads: countable,
      ledgerRecords: [freshRow(HEAD_D)],
    });
    expect(reviewCount).toBe(1);

    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_D,
        summaryHead: HEAD_B,
        markerSeen: true,
        reviewCount,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_B, { blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: POLICY,
        deltaRisk: classifyChangedPaths(["src/pipeline.ts"]),
      }),
    );
    expect(verdict.action).toBe("run");
  });
});

function settlePush(
  records: AdmissionRecord[],
  headSha: string,
  status: "cancelled" | "failed" | "completed",
): AdmissionRecord[] {
  const { record } = reserveAdmissionAttempt({
    existing: records,
    prNumber: PR,
    headSha,
    policyHash: POLICY_HASH,
    reservationTtlSeconds: POLICY.reservationTtlSeconds,
    now: new Date("2026-08-28T12:00:00.000Z"),
  });
  const settled = settleAdmissionAttempt(record, status, `provider ${status}`);
  return [...records, settled];
}

describe("admission state machine — push A cancel → B fail → C cancel → D", () => {
  test("cancelled launches do not exhaust the budget, so push D may still run", () => {
    let records: AdmissionRecord[] = [];
    const launches: AdmissionRecord[] = [];

    for (const [head, outcome] of [
      [HEAD_A, "cancelled"],
      [HEAD_B, "failed"],
      [HEAD_C, "cancelled"],
    ] as const) {
      const before = records.length;
      records = settlePush(records, head, outcome);
      const latest = records[records.length - 1];
      if (latest !== undefined) launches.push(latest);
      expect(records.length).toBe(before + 1);
    }

    expect(launches).toHaveLength(3);

    const reviewCount = resolveCiAdmissionAttemptCount({
      stateCount: 0,
      workflowHeads: new Set<string>(),
      ledgerRecords: records,
    });
    // Two of the three launches were cancelled. #164: those do not spend the
    // budget. Only the failed run counts, and maxAttempts is 2, so D may run.
    expect(reviewCount).toBe(1);

    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_D,
        summaryHead: HEAD_C,
        markerSeen: true,
        reviewCount,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_C, { blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: POLICY,
        deltaRisk: classifyChangedPaths(["src/pipeline.ts"]),
      }),
    );
    expect(verdict.action).toBe("run");

    const { record: wouldReserve, created } = reserveAdmissionAttempt({
      existing: records,
      prNumber: PR,
      headSha: HEAD_D,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: POLICY.reservationTtlSeconds,
    });
    expect(created).toBe(true);
    expect(wouldReserve.attemptNumber).toBe(1);
    expect(wouldReserve.headSha).toBe(HEAD_D);
    expect(
      records.filter((r) =>
        ["provider-started", "completed", "failed", "cancelled"].includes(
          r.status,
        ),
      ).length,
    ).toBeGreaterThan(POLICY.maxAttempts);
  });
});

describe("evaluateCiReviewAdmission + ledger attempt count", () => {
  test("ledger terminal rows raise reviewCount above summary counter", () => {
    const records = [
      settleAdmissionAttempt(
        reserveAdmissionAttempt({
          existing: [],
          prNumber: PR,
          headSha: HEAD_A,
          policyHash: POLICY_HASH,
          reservationTtlSeconds: POLICY.reservationTtlSeconds,
        }).record,
        "failed",
        "provider failed",
      ),
      settleAdmissionAttempt(
        reserveAdmissionAttempt({
          existing: [],
          prNumber: PR,
          headSha: HEAD_B,
          policyHash: POLICY_HASH,
          reservationTtlSeconds: POLICY.reservationTtlSeconds,
        }).record,
        "cancelled",
        "workflow cancelled",
      ),
    ];
    const reviewCount = resolveCiAdmissionAttemptCount({
      stateCount: 1,
      workflowHeads: new Set([HEAD_A]),
      ledgerRecords: records,
    });
    // The cancelled row does not raise the count. stateCount and the one
    // workflow head still do, so the max stays 1 — under maxAttempts 2.
    // Whatever the next gate decides, it is not "budget exhausted".
    expect(reviewCount).toBe(1);

    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_C,
        summaryHead: HEAD_B,
        markerSeen: true,
        reviewCount,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_B, { blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: POLICY,
      }),
    );
    expect(
      verdict.action === "manual-required" &&
        verdict.reason === "max-attempts-exhausted",
    ).toBe(false);
  });
});

describe("forceOverride", () => {
  test("always returns run even when budget is exhausted", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_D,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 99,
          state: null,
          admission: parseCiAdmissionBlock(
            admissionBody(HEAD_A, { blocking: 0, advisory: 1 }),
          ),
          postedFindings: null,
          policy: POLICY,
          forceOverride: true,
        }),
      ),
    ).toEqual({ action: "run" });
  });
});

describe("admission checklist scenarios", () => {
  test("first review runs", () => {
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
          policy: POLICY,
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("same head skips", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_A,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_A, { blocking: 1, advisory: 0 }),
        ),
        postedFindings: null,
        policy: POLICY,
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") expect(verdict.reason).toBe("same-head");
  });

  test("documentation-only delta skips under risk_aware", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_A, { blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: POLICY,
        deltaRisk: classifyChangedPaths(["docs/guide.md"]),
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("low-risk-delta");
    }
  });

  test("production delta runs after low score", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: parseCiAdmissionBlock(
            admissionBody(HEAD_A, { blocking: 0, advisory: 1 }),
          ),
          postedFindings: null,
          policy: POLICY,
          deltaRisk: classifyChangedPaths(["src/pipeline.ts"]),
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("threshold score triggers re-review", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: parseCiAdmissionBlock(
            admissionBody(HEAD_A, { blocking: 2, advisory: 0 }),
          ),
          postedFindings: null,
          policy: POLICY,
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("outside-diff canonical counts once", () => {
    const findings = canonicalAdmissionFindings([
      { id: "R001", tier: "blocking" },
      { id: "R001", tier: "blocking" },
      { id: "R002", tier: "advisory" },
    ]);
    expect(priorTierScore(findings, POLICY).score).toBe(3);
  });

  test("untrusted marker is ignored", () => {
    const posted = scanPostedFindingTiers({
      summaryHead: HEAD_A,
      comments: [
        {
          body: postedFindingComment({
            head: HEAD_A,
            tier: "blocking",
            user: "evil-contributor",
          }),
          user: "evil-contributor",
        },
      ],
      trustedActors: new Set(["pr-hero[bot]"]),
    });
    expect(posted?.failOpen).toBe(true);
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: null,
          postedFindings: posted,
          policy: POLICY,
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("mismatched head authority failOpen runs", () => {
    expect(
      evaluateCiReviewAdmission(
        admissionInput({
          currentHead: HEAD_B,
          summaryHead: HEAD_A,
          markerSeen: true,
          reviewCount: 1,
          state: null,
          admission: parseCiAdmissionBlock(
            admissionBody(HEAD_A, { blocking: 0, advisory: 1 }),
          ),
          postedFindings: null,
          policy: POLICY,
          authorityFailOpen: true,
        }),
      ),
    ).toEqual({ action: "run" });
  });

  test("exhausted budget produces manual-required", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_D,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 2,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_A, { blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: POLICY,
      }),
    );
    expect(verdict.action).toBe("manual-required");
  });

  test("concurrent reservation is idempotent", () => {
    const first = reserveAdmissionAttempt({
      existing: [],
      prNumber: PR,
      headSha: HEAD_A,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: POLICY.reservationTtlSeconds,
    });
    const second = reserveAdmissionAttempt({
      existing: [first.record],
      prNumber: PR,
      headSha: HEAD_A,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: POLICY.reservationTtlSeconds,
    });
    expect(second.created).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(admissionRecordFingerprint(PR, HEAD_A, POLICY_HASH)).toBe(
      first.record.reservationId,
    );
  });
});

describe("GraphQL pagination finds markers on later pages", () => {
  test("fetchPrComments walks pageInfo until the marker on page two is found", async () => {
    const marker = `${PR_FINDING_MARKER_PREFIX}path=src%2Fa.ts line=1 head=${HEAD_A} c=page-two-marker`;
    const repoView = {
      match: ["repo", "view", "--json", "owner,name"],
      response: {
        stdout: JSON.stringify({
          name: "musive",
          owner: { login: "MusiveTech" },
        }),
      },
    };
    const { spawnFn } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
      {
        match: ["graphql", "databaseId", "cursor1"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        databaseId: 9,
                        body: marker,
                        author: { login: "pr-hero[bot]" },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
      {
        match: ["graphql", "databaseId"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                    nodes: [
                      {
                        databaseId: 8,
                        body: "noise",
                        author: { login: "human" },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const comments = await fetchPrComments("/repo", 42, { spawnFn });
    expect(comments.some((c) => c.body.includes("page-two-marker"))).toBe(true);
  });
});

describe("observability — admission metadata in step summaries", () => {
  test("planCiReviewSkip carries admission context into renderStepSummary", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_A, { blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: POLICY,
        deltaRisk: classifyChangedPaths(["docs/readme.md"]),
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action !== "skip") return;
    const rendered = planCiReviewSkip({
      prNumber: PR,
      ciMode: "advisory",
      verdict,
      admission: {
        currentHead: HEAD_B,
        reviewedHead: HEAD_A,
        policyMode: POLICY.mode,
        policyHash: POLICY_HASH,
        deltaRisk: classifyChangedPaths(["docs/readme.md"]),
      },
    }).summaryMarkdown;
    expect(rendered).toContain("Policy mode");
    expect(rendered).toContain("risk_aware");
    expect(rendered).toContain(HEAD_B.slice(0, 8));
    expect(rendered).toContain(HEAD_A.slice(0, 8));
    expect(rendered).toContain("low");
  });

  test("planCiReviewManualRequired renders policy hash and remaining budget", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_D,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 2,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_A, { blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: POLICY,
      }),
    );
    expect(verdict.action).toBe("manual-required");
    if (verdict.action !== "manual-required") return;
    const rendered = planCiReviewManualRequired({
      prNumber: PR,
      ciMode: "advisory",
      verdict,
      admission: {
        currentHead: HEAD_D,
        reviewedHead: HEAD_A,
        policyMode: POLICY.mode,
        policyHash: POLICY_HASH,
      },
    }).summaryMarkdown;
    expect(rendered).toContain("Remaining budget");
    expect(rendered).toContain(POLICY_HASH.slice(0, 8));
  });

  test("formatCiAdmissionObserveNotice describes a would-skip decision", () => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_A, { blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: POLICY,
        deltaRisk: classifyChangedPaths(["docs/readme.md"]),
      }),
    );
    expect(verdict.action).toBe("skip");
    if (verdict.action !== "skip") return;
    const notice = formatCiAdmissionObserveNotice({
      verdict,
      currentHead: HEAD_B,
      reviewedHead: HEAD_A,
      policyMode: POLICY.mode,
      policyHash: POLICY_HASH,
      deltaRisk: classifyChangedPaths(["docs/readme.md"]),
    });
    expect(notice).toContain("observe-only");
    expect(notice).toContain("would skip");
  });
});

// Minimal fake gh harness (same shape as test/pr.test.ts / test/cli.test.ts).
type ScriptedResponse = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};
type ScriptEntry = { match: string[]; response: ScriptedResponse };

function makeFakeGh(script: ScriptEntry[]): {
  spawnFn: typeof Bun.spawn;
} {
  const encoder = new TextEncoder();
  const spawnFn = ((argv: string[]) => {
    const joined = argv.join(" ");
    const entry = script.find((s) =>
      s.match.every((token) => joined.includes(token)),
    );
    const scripted = entry?.response ?? { stdout: "", exitCode: 0 };
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        if (scripted.stdout)
          controller.enqueue(encoder.encode(scripted.stdout));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        if (scripted.stderr)
          controller.enqueue(encoder.encode(scripted.stderr));
        controller.close();
      },
    });
    return {
      stdout,
      stderr,
      exited: Promise.resolve(scripted.exitCode ?? 0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn };
}

describe("planCiReviewSkip — stopped", () => {
  const verdictFor = (stopped: boolean) => {
    const verdict = evaluateCiReviewAdmission(
      admissionInput({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: parseCiAdmissionBlock(
          admissionBody(HEAD_A, { blocking: 0, advisory: 1 }),
        ),
        postedFindings: null,
        policy: POLICY,
        deltaRisk: classifyChangedPaths(["docs/readme.md"]),
        stopped,
      }),
    );
    if (verdict.action !== "skip") throw new Error("expected a skip");
    return verdict;
  };

  test("a stopped skip's comment names the stop, not the score", () => {
    const comment = planCiReviewSkip({
      prNumber: PR,
      ciMode: "advisory",
      verdict: verdictFor(true),
    }).comment;
    expect(comment).toContain(
      "A maintainer stopped automatic reviews on this pull request.",
    );
    expect(comment).not.toContain("did not justify");
    expect(comment).not.toContain("Prior score");
    expect(comment).toContain("Attempts on this PR: 1/");
  });

  test("any other skip keeps the score wording", () => {
    const comment = planCiReviewSkip({
      prNumber: PR,
      ciMode: "advisory",
      verdict: verdictFor(false),
    }).comment;
    expect(comment).toContain("This push did not justify another review run.");
    expect(comment).toContain("Prior score: 1");
  });
});
