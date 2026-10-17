// The classifier and the S7 invariants are pure, so they are pinned with
// fixtures for every path. The outcome bodies come from decidePublication, the
// product's own publisher, so a drift in the comment format fails here first.

import { describe, expect, test } from "bun:test";
import { evaluateCheck } from "../../scripts/sandbox/expect";
import { RUN_STEP_NAME } from "../../scripts/sandbox/markers";
import {
  classifyComment,
  classifyPath,
  invariantViolations,
  type Observation,
  outcomeCodeOf,
} from "../../scripts/sandbox/observe";
import { SANDBOX_REPO } from "../../scripts/sandbox/rails";
import { renderReport } from "../../scripts/sandbox/report";
import { decidePublication } from "../../src/ci/publish";

const SHA = "a".repeat(40);

function realOutcomeBody(): string {
  const publication = decidePublication({
    record: {
      v: 1,
      decision: "no-credentials",
      params: { pr: 7 },
      pr: 7,
      head_sha: SHA,
      repository: SANDBOX_REPO,
      run_id: "1",
      run_attempt: 1,
      run_url: "https://example.invalid/run/1",
    },
    cliStarted: false,
  });
  if (publication.kind !== "remote")
    throw new Error("expected a remote publication");
  return publication.commentBody;
}

const REPORT = `<!-- pr-hero-report head=${SHA} -->\n\n# pr-hero review`;
const FINDING = `<!-- pr-hero-finding id=F001 -->\n\nsomething`;
const SKIP_SIZE = "<!-- pr-hero-skip-size -->\n\nthe diff is too large";
const MANUAL = "<!-- pr-hero-manual-required -->\n\nreview this by hand";

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    prNumber: 7,
    prUrl: "https://github.com/juanmaagd/pr-hero-sandbox/pull/7",
    headSha: SHA,
    run: {
      id: 42,
      status: "completed",
      conclusion: "success",
      steps: [{ name: RUN_STEP_NAME, conclusion: "success" }],
    },
    status: { state: "success", description: "review posted" },
    comments: [{ source: "issue", kind: "report", head: SHA }],
    artifacts: [`pr-hero-run-7-${SHA}`],
    ...overrides,
  };
}

describe("classifyComment", () => {
  test("reads each kind from its first-line marker", () => {
    expect(classifyComment(REPORT, "issue")).toEqual({
      source: "issue",
      kind: "report",
      head: SHA,
    });
    expect(classifyComment(FINDING, "inline")).toEqual({
      source: "inline",
      kind: "finding",
    });
    expect(classifyComment(SKIP_SIZE, "issue")).toEqual({
      source: "issue",
      kind: "skip",
      skip: "size",
    });
    expect(classifyComment(MANUAL, "issue")).toEqual({
      source: "issue",
      kind: "skip",
      skip: "manual-required",
    });
    expect(classifyComment("looks fine to me", "issue")).toEqual({
      source: "issue",
      kind: "other",
    });
  });

  test("reads the PRH code of a real outcome comment", () => {
    const body = realOutcomeBody();
    expect(classifyComment(body, "issue")).toEqual({
      source: "issue",
      kind: "outcome",
      code: "PRH-CRED-MISSING",
      head: SHA,
      // T2d-1 (S2): the owner lead the reader sees, read off the same body.
      lead: "Your configuration:",
    });
    expect(outcomeCodeOf(body)).toBe("PRH-CRED-MISSING");
  });

  test("reads the owner lead of a pr-hero defect outcome, and no lead from a report", () => {
    const defect = `<!-- pr-hero-outcome v=1 head=${SHA} run=1 attempt=1 -->\n\n### PRH-ENGINE-DEFECT\n\npr-hero defect: pr-hero hit an internal error\n`;
    expect(classifyComment(defect, "issue")).toEqual({
      source: "issue",
      kind: "outcome",
      code: "PRH-ENGINE-DEFECT",
      head: SHA,
      lead: "pr-hero defect:",
    });
    expect(classifyComment(REPORT, "issue")).not.toHaveProperty("lead");
  });

  test("a report marker quoted in prose is not a report", () => {
    expect(
      classifyComment("I saw a <!-- pr-hero-report --> once", "issue").kind,
    ).toBe("other");
  });
});

describe("classifyComment: the blocking tier of a finding (S4)", () => {
  test("a finding whose header reads 🔴 blocking is blocking", () => {
    expect(
      classifyComment(
        `${FINDING}\n\n🔴 blocking · BLOCKER · introduced · reliability`,
        "inline",
      ),
    ).toEqual({ source: "inline", kind: "finding", blocking: true });
  });

  test("an advisory finding is not blocking", () => {
    expect(
      classifyComment(
        `${FINDING}\n\n🟡 advisory · WARNING · introduced · reliability`,
        "inline",
      ),
    ).toEqual({ source: "inline", kind: "finding" });
  });
});

// Fix A: the status check counts blocking findings the PR shows on the observed
// head, so a finding comment names its head and a report counts its blocking
// entries in the outside-diff section (the findings that have no inline anchor).
describe("classifyComment: where a blocking finding is shown (Fix A)", () => {
  const OUTSIDE_BLOCKING =
    "🔴 blocking · BLOCKER · introduced · reliability\n`src/app.ts:10` — run()\n\nThe claim.";
  const OUTSIDE_ADVISORY =
    "🟡 advisory · WARNING · introduced · reliability\n`src/app.ts:20` — run()\n\nA note.";

  function reportWith(entries: readonly string[], after: string): string {
    return `<!-- pr-hero-report head=${SHA} -->\n\n# pr-hero review\n\n### Comments Outside Diff (${entries.length})\n\n${entries.join("\n\n")}${after}`;
  }
  const FOOTER = "\n\n---\n\n<sub>run completed</sub>";

  test("an inline blocking finding names the head its marker carries", () => {
    expect(
      classifyComment(
        `<!-- pr-hero-finding path=src/a.ts line=3 head=${SHA} c=x -->\n\n🔴 blocking · BLOCKER · introduced · reliability`,
        "inline",
      ),
    ).toEqual({
      source: "inline",
      kind: "finding",
      blocking: true,
      head: SHA,
    });
  });

  test("a report counts its blocking entries in the outside-diff section and carries no count for advisory ones", () => {
    expect(
      classifyComment(
        reportWith(
          [OUTSIDE_BLOCKING, OUTSIDE_ADVISORY, OUTSIDE_BLOCKING],
          FOOTER,
        ),
        "issue",
      ),
    ).toEqual({
      source: "issue",
      kind: "report",
      head: SHA,
      outsideDiffBlocking: 2,
    });
    expect(
      classifyComment(reportWith([OUTSIDE_ADVISORY], FOOTER), "issue"),
    ).toEqual({ source: "issue", kind: "report", head: SHA });
  });

  test("a blocking-looking line after the section ends, at a rule or a heading, is not an entry", () => {
    expect(
      classifyComment(
        reportWith(
          [OUTSIDE_ADVISORY],
          "\n\n---\n\n🔴 blocking · quoted in the footer",
        ),
        "issue",
      ),
    ).toEqual({ source: "issue", kind: "report", head: SHA });
    expect(
      classifyComment(
        reportWith(
          [OUTSIDE_ADVISORY],
          "\n\n### Next\n\n🔴 blocking · quoted under a heading",
        ),
        "issue",
      ),
    ).toEqual({ source: "issue", kind: "report", head: SHA });
  });
});

describe("classifyPath", () => {
  test("reviewed: a summary posted and the status success", () => {
    expect(classifyPath(observation())).toBe("reviewed");
  });

  // S4: a gate verdict is a finished review too. A failure next to the summary
  // of its own head is that review's verdict, not an absent one.
  test("reviewed: a summary posted and the gate's failure status, which names the blocking findings", () => {
    const obs = observation({
      status: {
        state: "failure",
        description:
          "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
      },
    });
    expect(classifyPath(obs)).toBe("reviewed");
  });

  // The skip notice has no head and survives a later forced review of the same
  // head, so on a comment-triggered phase only a notice this run posted counts.
  test("reviewed: a size notice an earlier run left behind does not decide this forced review", () => {
    const triggeredAt = Date.parse("2026-10-16T12:10:00Z");
    const obs = observation({
      triggeredAt,
      comments: [
        {
          source: "issue",
          kind: "skip",
          skip: "size",
          createdAt: "2026-10-16T12:00:00Z",
        },
        { source: "issue", kind: "report", head: SHA },
      ],
    });
    expect(classifyPath(obs)).toBe("reviewed");
  });

  test("skipped:size: a notice this run posted after its trigger beats an earlier report on the head", () => {
    const triggeredAt = Date.parse("2026-10-16T12:10:00Z");
    const obs = observation({
      triggeredAt,
      artifacts: [],
      comments: [
        { source: "issue", kind: "report", head: SHA },
        {
          source: "issue",
          kind: "skip",
          skip: "size",
          createdAt: "2026-10-16T12:10:30Z",
        },
      ],
    });
    expect(classifyPath(obs)).toBe("skipped:size");
  });

  test("skipped:size: a size skip's failure status is a skip, never a review", () => {
    const obs = observation({
      comments: [{ source: "issue", kind: "skip", skip: "size" }],
      artifacts: [],
      status: {
        state: "failure",
        description:
          "pr-hero skipped the review: diff over the size gate. /pr-hero review reviews it anyway",
      },
    });
    expect(classifyPath(obs)).toBe("skipped:size");
  });

  test("a summary for an earlier head is not this head's review", () => {
    const obs = observation({
      comments: [{ source: "issue", kind: "report", head: "c".repeat(40) }],
    });
    expect(classifyPath(obs)).toBe("no-outcome");
  });

  test("error: an outcome comment names its PRH code", () => {
    const obs = observation({
      comments: [
        { source: "issue", kind: "outcome", code: "PRH-CRED-MISSING" },
      ],
      status: {
        state: "error",
        description: "PRH-CRED-MISSING: no credential",
      },
    });
    expect(classifyPath(obs)).toBe("error:PRH-CRED-MISSING");
  });

  test("error: an error status with a PRH code and no outcome comment still names the code", () => {
    const obs = observation({
      comments: [],
      status: {
        state: "error",
        description: "PRH-ROUTE-UNRESOLVABLE: no route",
      },
    });
    expect(classifyPath(obs)).toBe("error:PRH-ROUTE-UNRESOLVABLE");
  });

  test("hunters-failed: an outcome comment that names it", () => {
    const obs = observation({
      comments: [
        { source: "issue", kind: "outcome", code: "PRH-HUNTERS-FAILED" },
      ],
      status: {
        state: "error",
        description: "PRH-HUNTERS-FAILED: every hunter failed",
      },
    });
    expect(classifyPath(obs)).toBe("hunters-failed");
  });

  test("hunters-failed from a status description that starts with the code, with no comment", () => {
    const obs = observation({
      comments: [],
      status: {
        state: "error",
        description: "PRH-HUNTERS-FAILED: every hunter failed",
      },
    });
    expect(classifyPath(obs)).toBe("hunters-failed");
  });

  test("a failed step and an uploaded run directory are not positive evidence of hunters-failed", () => {
    // The run directory is uploaded only when a hunter ran, and a finished
    // pipeline whose post threw looks the same from here. Without a PRH code
    // on the PR the path is no-outcome.
    const obs = observation({
      run: {
        id: 42,
        status: "completed",
        conclusion: "failure",
        steps: [{ name: RUN_STEP_NAME, conclusion: "failure" }],
      },
      comments: [],
      status: { state: "error", description: "review did not finish" },
    });
    expect(classifyPath(obs)).toBe("no-outcome");
  });

  test("a failed step with a success status, no report and an artifact never exits 0", () => {
    // The false pass: the pipeline finished, its post threw, the status says
    // success, and the run directory was uploaded. None of that is a
    // hunters-failed outcome, so the run must exit 1.
    const obs = observation({
      run: {
        id: 42,
        status: "completed",
        conclusion: "failure",
        steps: [{ name: RUN_STEP_NAME, conclusion: "failure" }],
      },
      comments: [],
      status: { state: "success", description: "review posted" },
      artifacts: [`pr-hero-run-7-${SHA}`],
    });
    const path = classifyPath(obs);
    expect(path).toBe("no-outcome");
    // ADAPTED (was exitCodeFor, removed with the smoke-only exit rule): the runner
    // decides the exit, and review-free requires the reviewed path, so this fails.
    expect(
      evaluateCheck({ kind: "path", accept: ["reviewed"] }, obs).pass,
    ).toBe(false);
  });

  test("hunters-failed from the status alone: the error status names the code and no comment is visible yet", () => {
    // The status and the outcome comment are separate writes, so a read can
    // see the status first. It names the same failure as the comment does, so
    // it must not fall through to `error:PRH-HUNTERS-FAILED`.
    const obs = observation({
      comments: [],
      status: {
        state: "error",
        description: "PRH-HUNTERS-FAILED: every hunter failed in review",
      },
    });
    expect(classifyPath(obs)).toBe("hunters-failed");
  });

  test("skipped: a skip marker names its reason", () => {
    expect(
      classifyPath(
        observation({
          comments: [{ source: "issue", kind: "skip", skip: "size" }],
        }),
      ),
    ).toBe("skipped:size");
  });

  test("no-outcome: a completed run that posted nothing and left a pending status", () => {
    const obs = observation({
      run: { id: 42, status: "completed", conclusion: "success", steps: [] },
      comments: [],
      status: { state: "pending", description: "pr-hero reviewing" },
      artifacts: [],
    });
    expect(classifyPath(obs)).toBe("no-outcome");
  });

  test("no-outcome: a report with a pending status is not reviewed", () => {
    expect(
      classifyPath(
        observation({ status: { state: "pending", description: "x" } }),
      ),
    ).toBe("no-outcome");
  });
});

describe("S7 invariants", () => {
  test("a clean reviewed run has none", () => {
    expect(invariantViolations(observation())).toEqual([]);
  });

  test("an error status must carry a PRH- code", () => {
    const v = invariantViolations(
      observation({
        status: { state: "error", description: "review did not finish" },
      }),
    );
    expect(
      v.some((line) => line.includes("error status without a PRH- code")),
    ).toBe(true);
  });

  test("an outcome comment on a head whose status is success is a violation", () => {
    const obs = observation({
      comments: [
        { source: "issue", kind: "report", head: SHA },
        { source: "issue", kind: "outcome", code: "PRH-CRED-MISSING" },
      ],
    });
    expect(
      invariantViolations(obs).some((line) => line.includes("outcome comment")),
    ).toBe(true);
  });

  test("a pending status after the run completed is a violation, and before it is not", () => {
    const pending = { state: "pending", description: "pr-hero reviewing" };
    const done = invariantViolations(
      observation({ status: pending, comments: [] }),
    );
    expect(done.some((line) => line.includes("still pending"))).toBe(true);
    const running = invariantViolations(
      observation({
        status: pending,
        comments: [],
        run: { id: 42, status: "in_progress", conclusion: null, steps: [] },
      }),
    );
    expect(running).toEqual([]);
  });

  test("an error status without a PRH code trips S7 and, with no other evidence, exits 1", () => {
    const obs = observation({
      run: {
        id: 42,
        status: "completed",
        conclusion: "failure",
        steps: [{ name: RUN_STEP_NAME, conclusion: "failure" }],
      },
      comments: [],
      status: { state: "error", description: "review did not finish" },
    });
    expect(classifyPath(obs)).toBe("no-outcome");
    expect(invariantViolations(obs).length).toBe(1);
  });
});

// The publisher writes head=<sha> into every outcome marker. An outcome left by an
// earlier head on the PR is that head's failure, so it must not decide this one.
describe("the head an outcome belongs to", () => {
  const OLD = "e".repeat(40);

  test("an outcome comment names the head it was written for", () => {
    const body = `<!-- pr-hero-outcome v=1 head=${OLD} run=1 attempt=1 -->\n\n## PRH-CRED-MISSING`;
    expect(classifyComment(body, "issue")).toEqual({
      source: "issue",
      kind: "outcome",
      code: "PRH-CRED-MISSING",
      head: OLD,
    });
  });

  test("an outcome of an earlier head does not decide this head's path", () => {
    const obs = observation({
      comments: [
        {
          source: "issue",
          kind: "outcome",
          code: "PRH-CRED-MISSING",
          head: OLD,
        },
      ],
      status: {
        state: "error",
        description: "PRH-HUNTERS-FAILED: every hunter failed",
      },
    });
    expect(classifyPath(obs)).toBe("hunters-failed");
  });
});

describe("report", () => {
  test("names the path, the S7 result, and the exit code", () => {
    const lines = renderReport(observation(), "reviewed", [], 0);
    expect(lines.some((l) => /path\s+reviewed/.test(l))).toBe(true);
    expect(lines.some((l) => /S7\s+ok/.test(l))).toBe(true);
    expect(lines.some((l) => /exit\s+0/.test(l))).toBe(true);
  });
});

// ADAPTED from the "exit code" table, which pinned the removed exitCodeFor. The
// review-free check and the S7 invariants now decide the exit, the same way for
// every path. hunters-failed no longer exits 0 here: review-free requires a
// reviewed head, and a hunters-failed run is a labelled flake (scenario.test.ts).
describe("exit code (adapted from exitCodeFor)", () => {
  const REVIEWED = { kind: "path", accept: ["reviewed"] } as const;
  const exitOf = (obs: Observation): 0 | 1 =>
    evaluateCheck(REVIEWED, obs).pass && invariantViolations(obs).length === 0
      ? 0
      : 1;

  test("0 only for a reviewed head without a violation; 1 for every other path and for an S7 violation", () => {
    expect(exitOf(observation())).toBe(0);
    // hunters-failed: positive evidence on the status, no report.
    expect(
      exitOf(
        observation({
          comments: [],
          status: {
            state: "error",
            description: "PRH-HUNTERS-FAILED: every hunter failed",
          },
        }),
      ),
    ).toBe(1);
    // error:<code>: the outcome of this head names a credential failure.
    expect(
      exitOf(
        observation({
          comments: [
            {
              source: "issue",
              kind: "outcome",
              code: "PRH-CRED-MISSING",
              head: SHA,
            },
          ],
          status: { state: "error", description: "PRH-CRED-MISSING: no key" },
        }),
      ),
    ).toBe(1);
    // skipped:size: a skip marker, no status.
    expect(
      exitOf(
        observation({
          comments: [{ source: "issue", kind: "skip", skip: "size" }],
          status: undefined,
        }),
      ),
    ).toBe(1);
    // no-outcome: the failed step, no code anywhere.
    expect(
      exitOf(
        observation({
          comments: [],
          status: { state: "error", description: "review did not finish" },
        }),
      ),
    ).toBe(1);
    // reviewed, but an outcome of an earlier head sits on a success status: S7.
    expect(
      exitOf(
        observation({
          comments: [
            { source: "issue", kind: "report", head: SHA },
            {
              source: "issue",
              kind: "outcome",
              code: "PRH-CRED-MISSING",
              head: "e".repeat(40),
            },
          ],
        }),
      ),
    ).toBe(1);
  });
});

// WHY these tests name the codes: the hunters-failed path renders PRH-MODEL-UNAVAILABLE and
// the hunter-route PRH-CRED-UNUSABLE (src/ci/outcome.ts renderHunterCause), so a run that
// the flake tolerance accepts shows those codes, not PRH-HUNTERS-FAILED. Read as `error:`,
// the sandbox would take an all-hunters-dead run for a different path.
function hunterRouteOutcomeBody(): string {
  const publication = decidePublication({
    record: {
      v: 1,
      decision: "review",
      params: { pr: 7 },
      pr: 7,
      head_sha: SHA,
      repository: SANDBOX_REPO,
      run_id: "1",
      run_attempt: 1,
      run_url: "https://example.invalid/run/1",
    },
    cliStarted: true,
    cliRecord: {
      v: 1,
      outcome: "hunters-failed",
      head_sha: SHA,
      hunter_failures: [
        {
          cause: "missing_provider_record",
          provider: "opencode",
          model: "gpt-4o",
        },
        {
          cause: "missing_provider_record",
          provider: "opencode",
          model: "gpt-4o",
        },
      ],
    },
  });
  if (publication.kind !== "remote")
    throw new Error("expected a remote publication");
  return publication.commentBody;
}

describe("the hunters-failed family", () => {
  test("PRH-MODEL-UNAVAILABLE on an outcome comment is hunters-failed", () => {
    const obs = observation({
      comments: [
        { source: "issue", kind: "outcome", code: "PRH-MODEL-UNAVAILABLE" },
      ],
      status: {
        state: "error",
        description:
          "PRH-MODEL-UNAVAILABLE: the configured model is not served",
      },
    });
    expect(classifyPath(obs)).toBe("hunters-failed");
  });

  test("PRH-MODEL-UNAVAILABLE on the status alone is hunters-failed", () => {
    const obs = observation({
      comments: [],
      status: {
        state: "error",
        description:
          "PRH-MODEL-UNAVAILABLE: Provider opencode: the configured model",
      },
    });
    expect(classifyPath(obs)).toBe("hunters-failed");
  });

  test("a PRH-CRED-UNUSABLE that names a hunter route is hunters-failed, from the real publisher's comment", () => {
    const obs = observation({
      comments: [classifyComment(hunterRouteOutcomeBody(), "issue")],
      status: {
        state: "error",
        description:
          "PRH-CRED-UNUSABLE: The route opencode/gpt-4o has no usable credential record",
      },
    });
    expect(classifyPath(obs)).toBe("hunters-failed");
  });

  test("a PRH-CRED-UNUSABLE outcome without a hunter route stays error:PRH-CRED-UNUSABLE", () => {
    const obs = observation({
      comments: [
        { source: "issue", kind: "outcome", code: "PRH-CRED-UNUSABLE" },
      ],
      status: {
        state: "error",
        description:
          "PRH-CRED-UNUSABLE: The credential store is not usable: the auth store is not a JSON object",
      },
    });
    expect(classifyPath(obs)).toBe("error:PRH-CRED-UNUSABLE");
  });

  test("a PRH-CRED-REJECTED is not in the family", () => {
    const obs = observation({
      comments: [],
      status: {
        state: "error",
        description: "PRH-CRED-REJECTED: the provider rejected the credential",
      },
    });
    expect(classifyPath(obs)).toBe("error:PRH-CRED-REJECTED");
  });
});
