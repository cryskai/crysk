// Every expectation the scenarios declare is evaluated here against recorded
// observation fixtures, for a pass and for a fail, phase by phase. The fixtures
// are shaped the way collect() reads them from gh, so a scenario that asserts a
// fact the runner cannot observe fails here rather than in a live run.

import { describe, expect, test } from "bun:test";
import { evaluateCheck, evaluateChecks } from "../../scripts/sandbox/expect";
import { RUN_STEP_NAME } from "../../scripts/sandbox/markers";
import {
  classifyComment,
  type Observation,
} from "../../scripts/sandbox/observe";
import { SCENARIOS } from "../../scripts/sandbox/scenarios";

const OLD = "a".repeat(40);
const NEW = "c".repeat(40);

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    prNumber: 7,
    prUrl: "https://github.com/juanmaagd/pr-hero-sandbox/pull/7",
    headSha: NEW,
    run: {
      id: 42,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
    },
    status: { state: "success", description: "review posted" },
    comments: [{ source: "issue", kind: "report", head: NEW }],
    artifacts: [`pr-hero-run-7-${NEW}`],
    ...overrides,
  };
}

const outcome = (code: string) => ({
  source: "issue" as const,
  kind: "outcome" as const,
  code,
});
const errorStatus = (code: string) => ({
  state: "error",
  description: `${code}: pr-hero stopped`,
});

describe("evaluateCheck: each kind passes and fails on its own fact", () => {
  test("path: an exact path, or any documented skip", () => {
    expect(
      evaluateCheck({ kind: "path", accept: ["reviewed"] }, obs()).pass,
    ).toBe(true);
    const skipped = obs({
      comments: [{ source: "issue", kind: "skip", skip: "budget" }],
      status: undefined,
    });
    expect(
      evaluateCheck({ kind: "path", accept: ["reviewed", "skipped"] }, skipped)
        .pass,
    ).toBe(true);
    const failed = evaluateCheck(
      { kind: "path", accept: ["reviewed"] },
      obs({ comments: [], status: undefined, artifacts: [] }),
    );
    expect(failed.pass).toBe(false);
    expect(failed.detail).toBe("got no-outcome");
  });

  // T2d-1 (S2): an outcome check may name the owner lead the reader sees, so a
  // scenario can pin whose fix a code says it is.
  test("outcome with a lead passes only when that code's comment carries the lead", () => {
    const owned = obs({
      comments: [
        { ...outcome("PRH-GOTCHAS-MISSING"), lead: "Your configuration:" },
      ],
    });
    expect(
      evaluateCheck(
        {
          kind: "outcome",
          code: "PRH-GOTCHAS-MISSING",
          lead: "Your configuration:",
        },
        owned,
      ).pass,
    ).toBe(true);
    const wrongOwner = evaluateCheck(
      {
        kind: "outcome",
        code: "PRH-GOTCHAS-MISSING",
        lead: "pr-hero defect:",
      },
      owned,
    );
    expect(wrongOwner.pass).toBe(false);
    expect(wrongOwner.label).toBe(
      "outcome comment with code PRH-GOTCHAS-MISSING, owner lead pr-hero defect:",
    );
    expect(wrongOwner.detail).toBe("got Your configuration:");
  });

  test("outcome with a lead fails on a code-less or lead-less comment", () => {
    const bare = obs({ comments: [outcome("PRH-GOTCHAS-MISSING")] });
    const result = evaluateCheck(
      {
        kind: "outcome",
        code: "PRH-GOTCHAS-MISSING",
        lead: "Your configuration:",
      },
      bare,
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toBe("got no lead");
  });

  test("outcome and no-outcome read the outcome comments", () => {
    const withCode = obs({ comments: [outcome("PRH-CRED-MISSING")] });
    expect(
      evaluateCheck({ kind: "outcome", code: "PRH-CRED-MISSING" }, withCode)
        .pass,
    ).toBe(true);
    expect(
      evaluateCheck({ kind: "outcome", code: "PRH-ROUTING-INVALID" }, withCode)
        .pass,
    ).toBe(false);
    expect(evaluateCheck({ kind: "no-outcome" }, withCode).pass).toBe(false);
    expect(evaluateCheck({ kind: "no-outcome" }, obs()).pass).toBe(true);
  });

  test("status matches the state and, when given, the description prefix", () => {
    const err = obs({ status: errorStatus("PRH-CRED-MISSING") });
    const check = {
      kind: "status" as const,
      state: "error",
      descriptionStartsWith: "PRH-CRED-MISSING",
    };
    expect(evaluateCheck(check, err).pass).toBe(true);
    expect(
      evaluateCheck(check, obs({ status: errorStatus("PRH-ROUTING-INVALID") }))
        .pass,
    ).toBe(false);
    expect(evaluateCheck(check, obs({ status: undefined })).detail).toBe(
      "no status on the head",
    );
  });

  test("report-min counts reports on the observed head only", () => {
    const old = obs({
      comments: [{ source: "issue", kind: "report", head: OLD }],
    });
    expect(evaluateCheck({ kind: "report-min", min: 1 }, old).pass).toBe(false);
    expect(evaluateCheck({ kind: "report-min", min: 1 }, obs()).pass).toBe(
      true,
    );
    expect(evaluateCheck({ kind: "no-report" }, old).pass).toBe(true);
  });

  test("run-completed needs the run, its event, and a completed status", () => {
    const check = { kind: "run-completed" as const, event: "issue_comment" };
    expect(evaluateCheck(check, obs()).pass).toBe(false);
    expect(evaluateCheck(check, obs({ run: undefined })).detail).toBe(
      "no run was found",
    );
    const running = obs({
      run: {
        id: 9,
        event: "issue_comment",
        status: "in_progress",
        conclusion: null,
        steps: [],
      },
    });
    expect(evaluateCheck(check, running).pass).toBe(false);
    const done = obs({
      run: {
        id: 9,
        event: "issue_comment",
        status: "completed",
        conclusion: "success",
        steps: [],
      },
    });
    expect(evaluateCheck(check, done).pass).toBe(true);
  });

  test("step-succeeded reads the review step of the observed run, not a report left on the head", () => {
    const check = { kind: "step-succeeded" as const };
    const succeeded = obs({
      run: {
        id: 9,
        event: "issue_comment",
        status: "completed",
        conclusion: "success",
        steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
      },
    });
    expect(evaluateCheck(check, succeeded).pass).toBe(true);
    // The report and status on this head are from an earlier run; the run's own step failed.
    const failed = obs({
      run: {
        id: 9,
        event: "issue_comment",
        status: "completed",
        conclusion: "failure",
        steps: [{ name: RUN_STEP_NAME, conclusion: "failure" }],
      },
    });
    const result = evaluateCheck(check, failed);
    expect(result.pass).toBe(false);
    expect(result.detail).toBe(`got failure for ${RUN_STEP_NAME}`);
    expect(evaluateCheck(check, obs({ run: undefined })).pass).toBe(false);
  });
});

describe("evaluateChecks: labels say what was asserted", () => {
  test("every result carries a label, so the report can print each expectation", () => {
    const results = evaluateChecks(
      [
        { kind: "path", accept: ["reviewed", "skipped"] },
        { kind: "no-outcome" },
      ],
      obs(),
    );
    expect(results.map((r) => r.label)).toEqual([
      "path is reviewed or skipped",
      "no outcome comment",
    ]);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});

// The scenario data itself: each phase's declared checks against a recorded
// pass and a recorded fail. A phase with no fail fixture here is a bug in this
// table, so the table is asserted to cover every phase of every scenario.
const RECORDED: Record<string, { pass: Observation; fail: Observation }> = {
  "no-credential/0": {
    pass: obs({
      run: {
        id: 1,
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
      },
      status: errorStatus("PRH-CRED-MISSING"),
      comments: [outcome("PRH-CRED-MISSING")],
    }),
    // A review ran with a success status and a report: the credential gate did not fire.
    fail: obs(),
  },
  "bad-routing/0": {
    pass: obs({
      status: errorStatus("PRH-ROUTING-INVALID"),
      comments: [outcome("PRH-ROUTING-INVALID")],
    }),
    fail: obs({
      status: errorStatus("PRH-CRED-MISSING"),
      comments: [outcome("PRH-CRED-MISSING")],
    }),
  },
  // T2d-1 (S2): the owner lead is the one the reader sees. A pr-hero lead on the same
  // code is the wrong owner, and must fail the check.
  "bad-gotchas/0": {
    pass: obs({
      status: errorStatus("PRH-GOTCHAS-MISSING"),
      comments: [
        { ...outcome("PRH-GOTCHAS-MISSING"), lead: "Your configuration:" },
      ],
    }),
    fail: obs({
      status: errorStatus("PRH-GOTCHAS-MISSING"),
      comments: [
        { ...outcome("PRH-GOTCHAS-MISSING"), lead: "pr-hero defect:" },
      ],
    }),
  },
  "review-free/0": {
    pass: obs(),
    fail: obs({
      status: {
        state: "error",
        description: "PRH-HUNTERS-FAILED: every hunter failed",
      },
      comments: [outcome("PRH-HUNTERS-FAILED")],
    }),
  },
  "review-advisory/0": {
    pass: obs(),
    // Advisory is success whatever the review finds: a failure status is the
    // gate's verdict leaking into advisory mode.
    fail: obs({
      status: {
        state: "failure",
        description:
          "pr-hero: 1 blocking finding(s) — fix and push, or /pr-hero override",
      },
    }),
  },
  "size-skip/0": {
    pass: obs({
      status: {
        state: "failure",
        description:
          "pr-hero skipped the review: diff over the size gate. /pr-hero review reviews it anyway",
      },
      comments: [{ source: "issue", kind: "skip", skip: "size" }],
      artifacts: [],
    }),
    // A reviewed head: the review ran, so the size gate did not skip it.
    fail: obs(),
  },
  "size-skip/1": {
    pass: obs({
      triggeredAt: Date.parse("2026-10-16T12:10:00Z"),
      run: {
        id: 9,
        event: "issue_comment",
        status: "completed",
        conclusion: "success",
        steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
      },
      // The size notice of the earlier run stays on the PR, as the product
      // leaves it, and it predates this run's trigger: the forced review of the
      // same head is still a review.
      comments: [
        {
          source: "issue",
          kind: "skip",
          skip: "size",
          createdAt: "2026-10-16T12:00:00Z",
        },
        { source: "issue", kind: "report", head: NEW },
      ],
    }),
    // This run's own skip notice, posted after its trigger: the run skipped, so
    // it is not a review. The path check and the run check both catch it.
    fail: obs({
      triggeredAt: Date.parse("2026-10-16T12:10:00Z"),
      run: {
        id: 8,
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
      },
      comments: [
        {
          source: "issue",
          kind: "skip",
          skip: "size",
          createdAt: "2026-10-16T12:10:30Z",
        },
      ],
      artifacts: [],
    }),
  },
  "cleanup/0": {
    pass: obs({
      status: errorStatus("PRH-CRED-MISSING"),
      comments: [outcome("PRH-CRED-MISSING")],
    }),
    fail: obs({ status: errorStatus("PRH-CRED-MISSING"), comments: [] }),
  },
  "cleanup/1": {
    pass: obs(),
    // The earlier outcome comment survived the second run: cleanup did not run,
    // and the status is success while an outcome comment still exists (S7).
    fail: obs({
      comments: [
        outcome("PRH-CRED-MISSING"),
        { source: "issue", kind: "report", head: NEW },
      ],
    }),
  },
  "comment-trigger/0": {
    pass: obs(),
    fail: obs({
      status: {
        state: "error",
        description: "PRH-CRED-MISSING: no credential",
      },
      comments: [outcome("PRH-CRED-MISSING")],
    }),
  },
  "comment-trigger/1": {
    pass: obs({
      run: {
        id: 9,
        event: "issue_comment",
        status: "completed",
        conclusion: "success",
        steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
      },
    }),
    // The pull_request run was read again instead of the comment run: the check must catch it.
    fail: obs({
      run: {
        id: 8,
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
      },
    }),
  },
  // S8: a red gate on a reviewed head, then the override that turns it green.
  "override/0": {
    pass: obs({
      status: {
        state: "failure",
        description:
          "pr-hero: 1 blocking finding(s) — fix and push, or /pr-hero override",
      },
      comments: [
        { source: "issue", kind: "report", head: NEW },
        { source: "inline", kind: "finding", blocking: true, head: NEW },
      ],
    }),
    // The gate ignored its own blocking finding: the consistency check catches it.
    fail: obs({
      status: { state: "success", description: "review posted" },
      comments: [
        { source: "issue", kind: "report", head: NEW },
        { source: "inline", kind: "finding", blocking: true, head: NEW },
      ],
    }),
  },
  "override/1": {
    pass: obs({
      triggeredAt: Date.parse("2026-10-17T12:10:00Z"),
      run: {
        id: 9,
        event: "issue_comment",
        status: "completed",
        conclusion: "success",
        steps: [],
      },
      status: {
        state: "success",
        description:
          "pr-hero: overridden by @juanmaagd — no review on this head",
      },
      comments: [
        { source: "issue", kind: "report", head: NEW },
        {
          source: "issue",
          kind: "override",
          head: NEW,
          createdAt: "2026-10-17T12:10:04Z",
        },
      ],
    }),
    // The override never posted: the gate is still the review's failure.
    fail: obs({
      triggeredAt: Date.parse("2026-10-17T12:10:00Z"),
      run: {
        id: 9,
        event: "issue_comment",
        status: "completed",
        conclusion: "success",
        steps: [],
      },
      status: {
        state: "failure",
        description:
          "pr-hero: 1 blocking finding(s) — fix and push, or /pr-hero override",
      },
      comments: [{ source: "issue", kind: "report", head: NEW }],
    }),
  },
  "same-head-rereview/0": {
    pass: obs(),
    fail: obs({
      status: {
        state: "error",
        description: "PRH-HUNTERS-FAILED: every hunter failed",
      },
      comments: [outcome("PRH-HUNTERS-FAILED")],
    }),
  },
  "same-head-rereview/1": {
    pass: obs({
      run: {
        id: 9,
        event: "issue_comment",
        status: "completed",
        conclusion: "success",
        steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
      },
    }),
    // The pull_request run was read instead of the comment run: the trigger never ran.
    fail: obs({
      run: {
        id: 8,
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
      },
    }),
  },
};

describe("override-comment: only this run's override, on this head", () => {
  const triggeredAt = Date.parse("2026-10-17T12:10:00Z");
  const overrideRun = obs({
    triggeredAt,
    run: {
      id: 9,
      event: "issue_comment",
      status: "completed",
      conclusion: "success",
      steps: [],
    },
  });
  const check = { kind: "override-comment" } as const;

  test("the override marker classifies as its own kind, with the head it names, and never as an outcome", () => {
    expect(
      classifyComment(
        `<!-- pr-hero-override head=${NEW} run=9 attempt=1 -->\n\n@juanmaagd`,
        "issue",
      ),
    ).toEqual({ source: "issue", kind: "override", head: NEW });
  });

  test("an override posted by this run, on this head, passes", () => {
    const posted = obs({
      ...overrideRun,
      comments: [
        {
          source: "issue",
          kind: "override",
          head: NEW,
          createdAt: "2026-10-17T12:10:04Z",
        },
      ],
    });
    expect(evaluateCheck(check, posted).pass).toBe(true);
  });

  test("an override on an earlier head does not count for this head", () => {
    const earlierHead = obs({
      ...overrideRun,
      comments: [
        {
          source: "issue",
          kind: "override",
          head: OLD,
          createdAt: "2026-10-17T12:10:04Z",
        },
      ],
    });
    expect(evaluateCheck(check, earlierHead).pass).toBe(false);
  });

  test("an override posted before this run's trigger does not count", () => {
    const earlier = obs({
      ...overrideRun,
      comments: [
        {
          source: "issue",
          kind: "override",
          head: NEW,
          createdAt: "2026-10-17T11:00:00Z",
        },
      ],
    });
    expect(evaluateCheck(check, earlier).pass).toBe(false);
  });
});

describe("scenario data: every declared expectation, pass and fail", () => {
  for (const scenario of SCENARIOS) {
    scenario.phases.forEach((phase, index) => {
      const key = `${scenario.name}/${index}`;
      test(`${key} passes on its recorded pass fixture and fails on its recorded fail fixture`, () => {
        const fixtures = RECORDED[key];
        if (fixtures === undefined)
          throw new Error(`no recorded fixtures for ${key}`);
        expect(
          evaluateChecks(phase.checks, fixtures.pass).every((r) => r.pass),
        ).toBe(true);
        expect(
          evaluateChecks(phase.checks, fixtures.fail).some((r) => !r.pass),
        ).toBe(true);
      });
    });
  }

  test("no phase is left without recorded fixtures", () => {
    const keys = SCENARIOS.flatMap((s) =>
      s.phases.map((_, i) => `${s.name}/${i}`),
    );
    expect(keys.sort()).toEqual(Object.keys(RECORDED).sort());
  });
});

// comment-trigger's first phase is a precondition: its free route may have
// hunters-failed, which is a flake of the model, not the subject of the scenario.
// Its second phase checks the cleanup of that outcome comment, and only then.
describe("comment-trigger: phase 1 accepts a flake, and the cleanup check is conditional", () => {
  const trigger = SCENARIOS.find((s) => s.name === "comment-trigger");
  const first = trigger?.phases[0];
  const second = trigger?.phases[1];

  test("phase 1 passes on reviewed and on hunters-failed, and fails on a credential outcome", () => {
    if (first === undefined) throw new Error("comment-trigger has no phase 1");
    const huntersFailed = obs({
      status: {
        state: "error",
        description: "PRH-HUNTERS-FAILED: every hunter failed",
      },
      comments: [outcome("PRH-HUNTERS-FAILED")],
    });
    expect(evaluateChecks(first.checks, obs()).every((r) => r.pass)).toBe(true);
    expect(
      evaluateChecks(first.checks, huntersFailed).every((r) => r.pass),
    ).toBe(true);
    expect(
      evaluateChecks(
        first.checks,
        obs({
          status: errorStatus("PRH-CRED-MISSING"),
          comments: [outcome("PRH-CRED-MISSING")],
        }),
      ).some((r) => !r.pass),
    ).toBe(true);
  });

  test("phase 2 declares its cleanup check apart from its own checks, and reads a surviving outcome comment as a failure", () => {
    if (second === undefined) throw new Error("comment-trigger has no phase 2");
    const cleanup = second.afterPriorOutcome ?? [];
    expect(cleanup.length).toBe(1);
    expect(evaluateChecks(cleanup, obs()).every((r) => r.pass)).toBe(true);
    expect(
      evaluateChecks(
        cleanup,
        obs({ comments: [outcome("PRH-HUNTERS-FAILED")] }),
      ).some((r) => !r.pass),
    ).toBe(true);
  });
});

// The run's own evidence: a reviewed head needs this run's artifact, and a skip
// needs a skip marker this run posted after its trigger. A head-level report and
// status from an earlier run satisfy neither.
describe("own-evidence: only this run's artifact or skip marker counts", () => {
  const TRIGGERED = Date.parse("2026-10-16T14:31:00Z");
  const commentRun = (overrides: Partial<Observation> = {}) =>
    obs({
      run: {
        id: 43,
        event: "issue_comment",
        status: "completed",
        conclusion: "success",
        steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
      },
      triggeredAt: TRIGGERED,
      ...overrides,
    });

  test("reviewed passes with this run's artifact, and fails without it even when the report and status are present", () => {
    const check = { kind: "own-evidence" } as const;
    expect(evaluateCheck(check, commentRun()).pass).toBe(true);
    const missing = evaluateCheck(check, commentRun({ artifacts: [] }));
    expect(missing.pass).toBe(false);
    expect(missing.detail).toContain(`pr-hero-run-7-${NEW}`);
  });

  test("a skip passes with a skip marker created after the trigger, and fails with one from before it", () => {
    const check = { kind: "own-evidence" } as const;
    const skip = (createdAt: string) =>
      commentRun({
        status: undefined,
        artifacts: [],
        comments: [{ source: "issue", kind: "skip", skip: "size", createdAt }],
      });
    expect(evaluateCheck(check, skip("2026-10-16T14:31:02Z")).pass).toBe(true);
    expect(evaluateCheck(check, skip("2026-10-16T14:30:00Z")).pass).toBe(false);
  });

  test("no-outcome and error paths leave no evidence this run could own", () => {
    const check = { kind: "own-evidence" } as const;
    expect(
      evaluateCheck(
        check,
        commentRun({
          comments: [],
          status: { state: "error", description: "review did not finish" },
        }),
      ).pass,
    ).toBe(false);
  });
});

// S4: review-free cannot pin a status, because the free model finds different
// things run to run. It checks instead that the status agrees with the blocking
// findings the PR shows: failure with any, success without. The comment bodies
// are the product's own finding headers, read back through classifyComment.
// Fix A: a blocking finding counts as visible on the observed head only, either as an
// inline comment whose marker names that head, or as an entry in the outside-diff
// section of that head's report. A failure whose description counts at least the
// visible ones passes; with none visible, a failure whose description counts a
// carried prior passes too.
describe("status-matches-findings: the status agrees with the blocking findings (S4)", () => {
  const BLOCKING = `<!-- pr-hero-finding id=F001 head=${NEW} -->\n\n🔴 blocking · BLOCKER · introduced · reliability`;
  const BLOCKING_2 = `<!-- pr-hero-finding id=F004 head=${NEW} -->\n\n🔴 blocking · BLOCKER · introduced · reliability`;
  const ADVISORY = `<!-- pr-hero-finding id=F002 head=${NEW} -->\n\n🟡 advisory · WARNING · introduced · reliability`;
  const STALE_BLOCKING = `<!-- pr-hero-finding id=F003 head=${OLD} -->\n\n🔴 blocking · BLOCKER · introduced · reliability`;
  const OUTSIDE_BLOCKING =
    "🔴 blocking · BLOCKER · introduced · reliability\n`src/app.ts:10` — run()\n\nThe claim.";
  const COUNTS_ONE =
    "pr-hero: 1 blocking finding(s) — fix and push, or /pr-hero override";

  function reportWithOutside(entry: string): string {
    return `<!-- pr-hero-report head=${NEW} -->\n\n# pr-hero review\n\n### Comments Outside Diff (1)\n\n${entry}\n\n---\n\n<sub>footer</sub>`;
  }

  function withFindings(
    bodies: readonly string[],
    state: string,
    description = "pr-hero: the description",
  ): Observation {
    return obs({
      comments: [
        { source: "issue", kind: "report", head: NEW },
        ...bodies.map((body) => classifyComment(body, "inline")),
      ],
      status: { state, description },
    });
  }

  const check = { kind: "status-matches-findings" } as const;

  test("no blocking finding and a success status pass", () => {
    expect(evaluateCheck(check, withFindings([], "success")).pass).toBe(true);
  });

  test("no blocking finding and a failure status fail: nothing blocks", () => {
    const result = evaluateCheck(check, withFindings([], "failure"));
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("no visible blocking finding");
  });

  test("a visible blocking finding and a failure that counts it pass", () => {
    expect(
      evaluateCheck(check, withFindings([BLOCKING], "failure", COUNTS_ONE))
        .pass,
    ).toBe(true);
  });

  test("a visible blocking finding and a success status fail: the gate missed it", () => {
    const result = evaluateCheck(check, withFindings([BLOCKING], "success"));
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("1 visible blocking finding(s)");
  });

  test("an advisory-only finding and a success status pass", () => {
    expect(evaluateCheck(check, withFindings([ADVISORY], "success")).pass).toBe(
      true,
    );
  });

  test("a blocking entry only in the outside-diff section is visible: success fails, a failure that counts it passes", () => {
    const comments = [
      classifyComment(reportWithOutside(OUTSIDE_BLOCKING), "issue"),
    ];
    const onSuccess = evaluateCheck(
      check,
      obs({
        comments,
        status: { state: "success", description: "review posted" },
      }),
    );
    expect(onSuccess.pass).toBe(false);
    expect(onSuccess.detail).toContain("1 visible blocking finding(s)");
    const onFailure = evaluateCheck(
      check,
      obs({ comments, status: { state: "failure", description: COUNTS_ONE } }),
    );
    expect(onFailure.pass).toBe(true);
  });

  test("a blocking finding on an earlier head is not visible: success passes beside it", () => {
    expect(
      evaluateCheck(check, withFindings([STALE_BLOCKING], "success")).pass,
    ).toBe(true);
  });

  test("no visible blocking finding and a failure that counts one (a carried prior) pass, and the detail says so", () => {
    const result = evaluateCheck(
      check,
      withFindings([], "failure", COUNTS_ONE),
    );
    expect(result.pass).toBe(true);
    expect(result.detail).toContain("carried");
  });

  test("two visible blocking findings and a failure that counts one fail: the description undercounts", () => {
    const result = evaluateCheck(
      check,
      withFindings([BLOCKING, BLOCKING_2], "failure", COUNTS_ONE),
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("2 visible blocking finding(s)");
  });

  test("its label names the rule", () => {
    expect(evaluateCheck(check, withFindings([], "success")).label).toBe(
      "status matches the blocking findings: failure when any is visible, success or a counted failure otherwise",
    );
  });
});
