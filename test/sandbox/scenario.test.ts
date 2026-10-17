// The runner, end to end under the phase-aware fake (world.ts). These pin the
// sequencing that the live scenarios depend on: the second push of `cleanup`
// waits for the first run, the comment run is found by its own run and never by
// the pull_request run, S6 and --keep agree, and a failed check exits 1 with the
// observed value in the table.

import { describe, expect, test } from "bun:test";
import { GOTCHAS_TEMPLATE, gotchasUnusableReason } from "#review/preflight";
import {
  assertGhArgs,
  RailViolation,
  SANDBOX_REPO,
} from "../../scripts/sandbox/rails";
import {
  renderScenarioTable,
  type ScenarioResult,
} from "../../scripts/sandbox/report";
import { DEFAULT_TIMEOUT_MS } from "../../scripts/sandbox/runs";
import { runScenarios } from "../../scripts/sandbox/scenario";
import { findScenario } from "../../scripts/sandbox/scenarios";
import {
  GOTCHAS_PATH,
  sandboxFiles,
  WORKFLOW_PATH,
} from "../../scripts/sandbox/seed";
import { fail, START_ISO } from "./fakes";
import { FakeGithub } from "./world";

const REF = "v0.2.0";
const OPTIONS = {
  ref: REF,
  keep: false,
  pollIntervalMs: 15_000,
  timeoutMs: 60_000,
};

describe("run: the scenarios against the fake repository", () => {
  test("review-free exits 0, closes its PR and branch, and the table names each expectation", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    const code = await runScenarios(h.deps, ["review-free"], OPTIONS);
    expect(code).toBe(0);
    expect(
      h.logs.some((l) => /PASS {2}review-free: path is reviewed/.test(l)),
    ).toBe(true);
    expect(
      h.logs.some((l) => /^scenario\s+path\s+S7\s+exit\s+PR$/.test(l)),
    ).toBe(true);
    const number = [...world.prs.keys()][0];
    expect(h.ghCalls).toContainEqual([
      "pr",
      "close",
      String(number),
      "-R",
      SANDBOX_REPO,
      "--delete-branch",
    ]);
    const branch =
      h.gitCalls.find((c) => c.args[0] === "checkout")?.args[2] ?? "";
    expect(branch).toMatch(/^sandbox\/review-free-\d{8}T\d{6}Z$/);
  });

  test("no-credential exits 0: the PRH-CRED-MISSING outcome, the error status, and no report", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["no-credential"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        /PASS {2}no-credential: outcome comment with code PRH-CRED-MISSING/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      h.logs.some((l) =>
        /PASS {2}no-credential: no report on the head/.test(l),
      ),
    ).toBe(true);
  });

  test("bad-routing exits 0: a malformed routing input is PRH-ROUTING-INVALID", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["bad-routing"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        /PASS {2}bad-routing: outcome comment with code PRH-ROUTING-INVALID/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  // T2d-1 (S2): the scenario branch commits the scaffold gotchas file, the fake
  // reads it the way the CLI's gate does, and the outcome names the config owner.
  test("bad-gotchas exits 0: a scaffold gotchas file is PRH-GOTCHAS-MISSING, owned by your configuration", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["bad-gotchas"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        /PASS {2}bad-gotchas: outcome comment with code PRH-GOTCHAS-MISSING, owner lead Your configuration:/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      h.logs.some((l) => /PASS {2}bad-gotchas: no report on the head/.test(l)),
    ).toBe(true);
  });

  test("bad-gotchas: the override is the scaffold the product's gate refuses, at the path the gate reads", () => {
    const scenario = findScenario("bad-gotchas");
    const open = scenario?.phases[0]?.action;
    expect(open?.kind).toBe("open");
    if (open?.kind !== "open") return;
    expect(open.overrides).toEqual([
      { path: GOTCHAS_PATH, contents: GOTCHAS_TEMPLATE },
    ]);
    expect(gotchasUnusableReason(GOTCHAS_TEMPLATE)).toBe("placeholder");
  });

  test("cleanup: the second push waits for the first run, and the final observation is on the new head", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["cleanup"], OPTIONS)).toBe(0);

    const [first, second] = world.events
      .filter((e) => e.startsWith("push "))
      .map((e) => e.slice("push ".length));
    const firstRunDone = world.events.findIndex((e) =>
      e.endsWith("pull_request completed"),
    );
    const firstObserved = world.events.indexOf(`observe status ${first}`);
    const secondPush = world.events.indexOf(`push ${second}`);
    expect(first).not.toBe(second);
    expect(firstRunDone).toBeGreaterThanOrEqual(0);
    expect(firstRunDone).toBeLessThan(secondPush);
    expect(firstObserved).toBeLessThan(secondPush);
    expect(world.events.indexOf(`observe status ${second}`)).toBeGreaterThan(
      secondPush,
    );

    // The second push is a plain fast-forward on the same branch.
    const pushes = h.gitCalls.filter((c) => c.args[0] === "push");
    const branches = pushes.map((c) => c.args[3]);
    expect(branches.length).toBe(2);
    expect(new Set(branches).size).toBe(1);
    expect(pushes.some((c) => c.args.includes("--force"))).toBe(false);
    // The earlier outcome comment is gone, as the publisher's cleanup leaves it.
    const pr = [...world.prs.values()][0];
    const left = world.comments.get(pr?.number ?? -1) ?? [];
    expect(left.some((c) => c.body.startsWith("<!-- pr-hero-outcome"))).toBe(
      false,
    );
  });

  test("comment-trigger finds the issue_comment run, and never reads the pull_request run as its own", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);

    const prRun = world.runs.find((r) => r.event === "pull_request");
    const commentRun = world.runs.find((r) => r.event === "issue_comment");
    expect(commentRun).toBeDefined();
    expect(h.ghCalls).toContainEqual([
      "pr",
      "comment",
      String(prRun?.prNumber),
      "-R",
      SANDBOX_REPO,
      "--body",
      "/pr-hero review",
    ]);
    // The comment's run is a list of issue_comment runs with no branch filter.
    const commentLists = h.ghCalls.filter(
      (c) => c[0] === "run" && c[1] === "list" && c.includes("issue_comment"),
    );
    expect(commentLists.length).toBeGreaterThan(0);
    expect(commentLists.every((c) => !c.includes("--branch"))).toBe(true);
    // Each run is read once, in order: the pull_request run in its phase, then the comment run.
    const views = h.ghCalls
      .filter((c) => c[0] === "run" && c[1] === "view")
      .map((c) => c[2]);
    expect(views).toEqual([
      String(prRun?.databaseId),
      String(commentRun?.databaseId),
    ]);
    expect(
      h.logs.some((l) =>
        /PASS {2}comment-trigger: \[2\] issue_comment run completed/.test(l),
      ),
    ).toBe(true);
  });

  test("comment-trigger refuses to start when main is not pinned to the ref, and pushes nothing", async () => {
    const world = new FakeGithub({
      ref: REF,
      mainWorkflow: sandboxFiles("v0.1.0").get(WORKFLOW_PATH),
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(
      false,
    );
    expect(h.logs.some((l) => l.includes(`init --ref ${REF}`))).toBe(true);
  });

  test("comment-trigger accepts a phase 1 that hunters-failed, and its cleanup holds once the comment run reviews", async () => {
    const world = new FakeGithub({
      ref: REF,
      runOutcomes: ["hunters-failed", "review"],
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);
    expect(
      h.logs.includes(
        "  PASS  comment-trigger: [1] path is reviewed or hunters-failed",
      ),
    ).toBe(true);
    expect(
      h.logs.includes("  PASS  comment-trigger: [2] no outcome comment"),
    ).toBe(true);
    // The publisher's cleanup removed the PRH-HUNTERS-FAILED comment of phase 1.
    const pr = [...world.prs.values()][0];
    const left = world.comments.get(pr?.number ?? -1) ?? [];
    expect(left.some((c) => c.body.startsWith("<!-- pr-hero-outcome"))).toBe(
      false,
    );
  });

  test("comment-trigger asserts nothing about cleanup when phase 1 posted no outcome comment", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);
    // Not a PASS or a FAIL row: the check is named on a line of its own, below.
    expect(
      h.logs.some((l) =>
        /^ {2}(PASS|FAIL)\b.*\[2\] no outcome comment/.test(l),
      ),
    ).toBe(false);
    expect(
      h.logs.some((l) =>
        l.startsWith("  not asserted: comment-trigger [2] no outcome comment"),
      ),
    ).toBe(true);
  });

  test("comment-trigger fails its cleanup check when the phase 1 outcome comment survives the comment run", async () => {
    const world = new FakeGithub({
      ref: REF,
      runOutcomes: ["hunters-failed", "review"],
      keepOutcomeComments: true,
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(
      h.logs.includes(
        "  FAIL  comment-trigger: [2] no outcome comment (got PRH-HUNTERS-FAILED)",
      ),
    ).toBe(true);
  });

  test("a failed expectation of a run that hunters-failed is labelled as the free model's flake, and still exits 1 with --no-retry", async () => {
    const world = new FakeGithub({ ref: REF, runOutcomes: ["hunters-failed"] });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["review-free"], {
        ...OPTIONS,
        noRetry: true,
      }),
    ).toBe(1);
    expect(
      h.logs.includes(
        "  FAIL (free-model hunters failed: re-run)  review-free: path is reviewed (got hunters-failed)",
      ),
    ).toBe(true);
    expect(
      h.logs.includes(
        "  FAIL  review-free: path is reviewed (got hunters-failed)",
      ),
    ).toBe(false);
  });

  test("a phase-2 check that fails is not the flake when phase 1 hunters-failed: no re-run, exit 1", async () => {
    // Phase 1 hunters-failed, and its outcome stays on the PR. Phase 2 is a near miss
    // that reviews nothing, so it reads phase 1's outcome as its path. Its checks fail
    // for reasons that are not the free model's flake, so the scenario must not re-run.
    const world = new FakeGithub({
      ref: REF,
      runOutcomes: ["hunters-failed", "near-miss"],
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(h.logs.some((l) => l.includes("re-running it once"))).toBe(false);
    expect(
      h.logs.includes(
        "  FAIL  comment-trigger: [2] path is reviewed (got hunters-failed)",
      ),
    ).toBe(true);
  });

  // The fake posts an outcome comment and an error status together. These tests take
  // the comment away, so the head's status alone carries PRH-HUNTERS-FAILED (the
  // publisher's status write lands before its comment POST, so a failed POST leaves
  // exactly this), and stamp the status with the created_at the test picks: a time
  // after any trigger the fake hands out for this run's post, or one long before it.
  function statusOnlyHarness(world: FakeGithub, createdAt: string) {
    const h = world.harness();
    const inner = h.deps.gh;
    h.deps = {
      ...h.deps,
      gh: async (args) => {
        const result = await inner(args);
        if (result.exitCode !== 0) return result;
        if (args.some((a) => /\/commits\/[0-9a-f]{40}\/status$/.test(a))) {
          const body = JSON.parse(result.stdout) as {
            statuses: { created_at?: string }[];
          };
          body.statuses = body.statuses.map((s) => ({
            ...s,
            created_at: createdAt,
          }));
          return { ...result, stdout: JSON.stringify(body) };
        }
        if (args.some((a) => /\/issues\/\d+\/comments/.test(a))) {
          const list = JSON.parse(result.stdout) as { body: string }[];
          return {
            ...result,
            stdout: JSON.stringify(
              list.filter((c) => !c.body.startsWith("<!-- pr-hero-outcome")),
            ),
          };
        }
        return result;
      },
    };
    return h;
  }

  test("an own-run status-only hunters-failed (no outcome comment) is the flake and is re-run", async () => {
    // Far future: this run posted the status after its comment trigger.
    const world = new FakeGithub({
      ref: REF,
      runOutcomes: ["hunters-failed", "hunters-failed"],
    });
    const h = statusOnlyHarness(world, "2999-01-01T00:00:00.000Z");
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);
    expect(h.logs.some((l) => l.includes("re-running it once"))).toBe(true);
  });

  // A run whose hunters all failed on one shared cause is rendered with that cause's
  // code (publish.ts huntersFailedRendering), and is the same flake. The long route
  // pushes the credential sentence past the status's 140-character clip.
  const LONG_ROUTE = `opencode/${"m".repeat(96)}`;
  const SHARED_CAUSES = [
    {
      code: "PRH-MODEL-UNAVAILABLE",
      sentence: "Provider opencode: the model is not available.",
    },
    {
      code: "PRH-CRED-UNUSABLE",
      sentence: `The route ${LONG_ROUTE} has no usable credential record`,
    },
  ];
  for (const as of SHARED_CAUSES) {
    test(`an own-run ${as.code} hunters-failed outcome is the flake and is re-run`, async () => {
      const world = new FakeGithub({
        ref: REF,
        runOutcomes: ["hunters-failed", "hunters-failed"],
        huntersFailedAs: as,
      });
      const h = world.harness();
      expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);
      expect(h.logs.some((l) => l.includes("re-running it once"))).toBe(true);
    });

    test(`an own-run status-only ${as.code} hunters-failed is the flake and is re-run`, async () => {
      const world = new FakeGithub({
        ref: REF,
        runOutcomes: ["hunters-failed", "hunters-failed"],
        huntersFailedAs: as,
      });
      const h = statusOnlyHarness(world, "2999-01-01T00:00:00.000Z");
      expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);
      expect(h.logs.some((l) => l.includes("re-running it once"))).toBe(true);
    });
  }

  test("the credential preflight's PRH-CRED-UNUSABLE is no hunters-failed flake: no re-run, exit 1", async () => {
    const world = new FakeGithub({
      ref: REF,
      runOutcomes: ["hunters-failed", "hunters-failed"],
      huntersFailedAs: {
        code: "PRH-CRED-UNUSABLE",
        sentence:
          "The claude/opencode route for this step has no usable credential.",
      },
    });
    const h = statusOnlyHarness(world, "2999-01-01T00:00:00.000Z");
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(h.logs.some((l) => l.includes("re-running it once"))).toBe(false);
  });

  test("a phase-1 status-only hunters-failed from an earlier run is not this phase's flake: phase 2 fails for another reason, no re-run, exit 1", async () => {
    // Long before the trigger: the status was posted by an earlier run, not this one.
    const world = new FakeGithub({
      ref: REF,
      runOutcomes: ["hunters-failed", "near-miss"],
    });
    const h = statusOnlyHarness(world, "2000-01-01T00:00:00.000Z");
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(h.logs.some((l) => l.includes("re-running it once"))).toBe(false);
    expect(
      h.logs.includes(
        "  FAIL  comment-trigger: [2] path is reviewed (got hunters-failed)",
      ),
    ).toBe(true);
  });

  test("a later phase whose review step fails with no outcome of its own is not the flake: no re-run, exit 1", async () => {
    // Phase 1 hunters-failed, and its outcome stays on the PR. Phase 2's review step
    // fails for another reason (stepFailsOnReview) and posts no outcome of its own, so
    // its path reads phase 1's outcome. Its head is failure (blockingFindings), so the
    // only thing that could make it the flake is the step failure this test denies.
    const world = new FakeGithub({
      ref: REF,
      runOutcomes: ["hunters-failed", "review"],
      keepOutcomeComments: true,
      stepFailsOnReview: true,
      blockingFindings: true,
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(h.logs.some((l) => l.includes("re-running it once"))).toBe(false);
    expect(
      h.logs.includes(
        "  FAIL  comment-trigger: [2] path is reviewed (got hunters-failed)",
      ),
    ).toBe(true);
  });

  test("a phase-2 run that hunters-failed itself is the flake and is re-run once", async () => {
    const world = new FakeGithub({
      ref: REF,
      runOutcomes: ["hunters-failed", "hunters-failed"],
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);
    expect(h.logs.some((l) => l.includes("re-running it once"))).toBe(true);
  });

  test("cleanup: a second run that hunters-failed is labelled as the flake, and its checks still fail the run", async () => {
    const world = new FakeGithub({
      ref: REF,
      runOutcomes: ["credential", "hunters-failed"],
    });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["cleanup"], { ...OPTIONS, noRetry: true }),
    ).toBe(1);
    expect(
      h.logs.includes(
        "  FAIL (free-model hunters failed: re-run)  cleanup: [2] path is reviewed (got hunters-failed)",
      ),
    ).toBe(true);
  });

  // A free-model flake is re-run once, on a fresh PR, through the same gate as any
  // scenario: the table keeps both attempts, and the exit code is the re-run's.
  describe("a hunters-failed flake is re-run once", () => {
    const RERUN_NAME = "review-free (re-run after a hunters-failed flake)";

    test("the flake attempt is re-run on a fresh PR, which passes, so the invocation exits 0 and both attempts are reported", async () => {
      const world = new FakeGithub({
        ref: REF,
        runOutcomes: ["hunters-failed"],
      });
      const h = world.harness();
      expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(0);
      expect(world.prs.size).toBe(2);
      expect(
        h.logs.some((l) =>
          /^review-free\s+hunters-failed\s+ok\s+1\s+\S+$/.test(l),
        ),
      ).toBe(true);
      expect(
        h.logs.some(
          (l) => l.includes(RERUN_NAME) && /\sreviewed\s+ok\s+0\s/.test(l),
        ),
      ).toBe(true);
      expect(
        h.logs.some((l) =>
          l.startsWith(`  PASS  ${RERUN_NAME}: path is reviewed`),
        ),
      ).toBe(true);
    });

    test("a failure of another kind is not re-run", async () => {
      const world = new FakeGithub({ ref: REF, forceCredentialOutcome: true });
      const h = world.harness();
      expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(1);
      expect(world.prs.size).toBe(1);
      expect(h.logs.some((l) => l.includes("(re-run after"))).toBe(false);
    });

    test("--no-retry does not re-run the flake", async () => {
      const world = new FakeGithub({
        ref: REF,
        runOutcomes: ["hunters-failed"],
      });
      const h = world.harness();
      expect(
        await runScenarios(h.deps, ["review-free"], {
          ...OPTIONS,
          noRetry: true,
        }),
      ).toBe(1);
      expect(world.prs.size).toBe(1);
    });

    test("the re-run is only once: a flake that repeats is reported, not re-run a second time", async () => {
      const world = new FakeGithub({
        ref: REF,
        runOutcomes: ["hunters-failed", "hunters-failed"],
      });
      const h = world.harness();
      expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(1);
      expect(world.prs.size).toBe(2);
      expect(
        h.logs.some(
          (l) =>
            l.includes(RERUN_NAME) && /\shunters-failed\s+ok\s+1\s/.test(l),
        ),
      ).toBe(true);
    });

    test("a timed-out phase is not a flake and is not re-run", async () => {
      const world = new FakeGithub({ ref: REF, stuckCommentRuns: true });
      const h = world.harness();
      expect(
        await runScenarios(h.deps, ["comment-trigger"], {
          ...OPTIONS,
          timeoutMs: 60_000,
        }),
      ).toBe(1);
      expect(world.prs.size).toBe(1);
    });
  });

  // The poll's ceiling is named in runs.ts, with the free-model review that once took
  // 24m36s: a phase that never completes waits the whole of it on the fake clock.
  test("a phase whose run never completes waits the 2700 s default, not a shorter one", async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(2_700_000);
    const world = new FakeGithub({ ref: REF, stuckCommentRuns: true });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["comment-trigger"], {
        ref: REF,
        keep: false,
      }),
    ).toBe(1);
    expect(h.logs).toContain(
      "timed out after 2700s waiting for the run; collecting what is visible",
    );
  });

  test("a failed expectation exits 1, and the table names the check with what was seen", async () => {
    const world = new FakeGithub({ ref: REF, forceCredentialOutcome: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(1);
    expect(
      h.logs.some((l) =>
        l.includes(
          "FAIL  review-free: path is reviewed (got error:PRH-CRED-MISSING)",
        ),
      ),
    ).toBe(true);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(true);
  });

  test("a scenario that errors mid-run is recorded, cleaned up, and the next scenario still runs", async () => {
    const world = new FakeGithub({ ref: REF, failComment: true });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["comment-trigger", "review-free"], OPTIONS),
    ).toBe(1);
    expect(
      h.logs.some((l) => l.includes("scenario comment-trigger stopped early")),
    ).toBe(true);
    expect(
      h.logs.some((l) => /PASS {2}review-free: path is reviewed/.test(l)),
    ).toBe(true);
    // Both PRs were closed: the failed one by cleanup, the next one by its own run.
    expect([...world.prs.values()].every((p) => p.closed)).toBe(true);
  });
});

describe("run: --keep and the serialization check", () => {
  test("--keep leaves each PR open, and the next scenario of the same run passes the check past the PR it opened", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["no-credential", "review-free"], {
        ...OPTIONS,
        keep: true,
      }),
    ).toBe(0);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(
      false,
    );
    expect([...world.prs.values()].every((p) => !p.closed)).toBe(true);
    expect(h.logs.filter((l) => l.startsWith("kept:")).length).toBe(2);
  });

  test("without --keep each PR is closed before the next scenario opens its own", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["no-credential", "review-free"], OPTIONS),
    ).toBe(0);
    const closeAt = world.events.findIndex((e) => e.startsWith("pr close"));
    const createAt = world.events
      .map((e, i) => (e.startsWith("pr create") ? i : -1))
      .filter((i) => i >= 0);
    expect(createAt.length).toBe(2);
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeLessThan(createAt[1] ?? -1);
  });

  test("a foreign open sandbox PR refuses the run even with --keep, and starts nothing", async () => {
    const world = new FakeGithub({ ref: REF });
    world.openForeignPr(3, "sandbox/smoke-20261015T100000Z");
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["review-free", "no-credential"], {
        ...OPTIONS,
        keep: true,
      }),
    ).toBe(1);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(
      false,
    );
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
    expect(
      h.logs.some((l) =>
        l.includes("refusing to start: 1 scenario PR(s) still open"),
      ),
    ).toBe(true);
    expect(h.logs.some((l) => l === "not run: no-credential")).toBe(true);
  });

  test("a PR the run failed to close still refuses the next scenario when --keep is not given", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    const inner = h.deps.gh;
    const deps = {
      ...h.deps,
      gh: async (args: readonly string[]) =>
        args[1] === "close" ? fail("HTTP 500") : inner(args),
    };
    expect(
      await runScenarios(deps, ["no-credential", "review-free"], OPTIONS),
    ).toBe(1);
    expect(h.logs.some((l) => l.startsWith("cleanup failed:"))).toBe(true);
    expect(
      h.logs.some((l) =>
        l.includes("refusing to start: 1 scenario PR(s) still open"),
      ),
    ).toBe(true);
    // review-free is the refused scenario itself, so it has the REFUSED row and nothing is left unrun.
    expect(h.logs.some((l) => l.startsWith("  REFUSED  review-free:"))).toBe(
      true,
    );
    expect(h.logs.some((l) => l.startsWith("not run:"))).toBe(false);
  });
});

describe("the final table", () => {
  test("a flake is printed as the free model's, so a failed run reads as a re-run, not a regression", () => {
    const lines = renderScenarioTable([
      {
        name: "review-free",
        path: "hunters-failed",
        checks: [
          {
            label: "path is reviewed",
            pass: false,
            detail: "got hunters-failed",
            cause: "free-model-hunters-failed",
          },
          { label: "no outcome comment", pass: true },
        ],
        s7: [],
        exitCode: 1,
      },
    ]);
    expect(lines).toContain(
      "  FAIL (free-model hunters failed: re-run)  review-free: path is reviewed (got hunters-failed)",
    );
    expect(lines).toContain("  PASS  review-free: no outcome comment");
  });

  test("names each scenario's path, S7 and exit, and each expectation as PASS or FAIL", () => {
    const results: ScenarioResult[] = [
      {
        name: "review-free",
        path: "reviewed",
        prUrl: "https://x/pull/1",
        checks: [
          { label: "path is reviewed", pass: true },
          { label: "status is success", pass: false, detail: "got error: x" },
        ],
        s7: [],
        exitCode: 1,
      },
      {
        name: "cleanup",
        path: "reviewed",
        checks: [],
        s7: ["S7 violation: outcome comment on a head whose status is success"],
        exitCode: 1,
      },
      {
        name: "comment-trigger",
        path: "not run",
        checks: [],
        s7: [],
        error: "1 scenario PR(s) still open",
        refused: true,
        exitCode: 1,
      },
    ];
    const lines = renderScenarioTable(results);
    expect(lines[0]).toMatch(/^scenario\s+path\s+S7\s+exit\s+PR$/);
    expect(lines[1]).toMatch(
      /^review-free\s+reviewed\s+ok\s+1\s+https:\/\/x\/pull\/1$/,
    );
    expect(lines).toContain("  PASS  review-free: path is reviewed");
    expect(lines).toContain(
      "  FAIL  review-free: status is success (got error: x)",
    );
    expect(
      lines.some((l) => l.startsWith("  FAIL  cleanup: S7 violation")),
    ).toBe(true);
    expect(lines).toContain(
      "  REFUSED  comment-trigger: 1 scenario PR(s) still open",
    );
  });
});

// The comment run is matched by this scenario's PR title and by the comment's time.
// The title carries the branch stamp, which is the harness clock's start, so the
// tests can name it before the run starts.
const STAMP = START_ISO.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const COMMENT_TITLE = `pr-hero sandbox comment-trigger sandbox/comment-trigger-${STAMP}`;

describe("run: the comment run is its own run, with its own evidence", () => {
  // Adapted: phase 2 no longer asserts the head's status or report, so only the step
  // and the run's own artifact are named here.
  test("a comment run that uploads no artifact fails phase 2, though its review step passes", async () => {
    const world = new FakeGithub({
      ref: REF,
      commentRunsLeaveNoArtifact: true,
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(
      h.logs.includes(
        "  PASS  comment-trigger: [2] the run's review step succeeded",
      ),
    ).toBe(true);
    expect(
      h.logs.some((l) =>
        l.startsWith(
          "  FAIL  comment-trigger: [2] the run left its own evidence",
        ),
      ),
    ).toBe(true);
  });

  test("a stray run from earlier with this PR's title is ignored: the comment run is the one created after the comment", async () => {
    const world = new FakeGithub({ ref: REF });
    const stray = world.addRun({
      event: "issue_comment",
      displayTitle: COMMENT_TITLE,
      createdAt: "2000-01-01T00:00:00Z",
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);
    expect(
      h.ghCalls.some(
        (c) => c[0] === "run" && c[1] === "view" && c[2] === String(stray),
      ),
    ).toBe(false);
  });

  test("a run that shows another PR's title is ignored, even when it was created after the comment", async () => {
    const world = new FakeGithub({ ref: REF });
    const other = world.addRun({
      event: "issue_comment",
      displayTitle: "pr-hero sandbox cleanup sandbox/cleanup-20261016T000000Z",
      createdAt: "2099-01-01T00:00:00Z",
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);
    expect(
      h.ghCalls.some(
        (c) => c[0] === "run" && c[1] === "view" && c[2] === String(other),
      ),
    ).toBe(false);
  });

  test("two runs carrying this PR's title after the comment are ambiguous: the scenario errors and cleans up", async () => {
    const world = new FakeGithub({ ref: REF });
    for (let i = 0; i < 2; i += 1) {
      world.addRun({
        event: "issue_comment",
        displayTitle: COMMENT_TITLE,
        createdAt: "2099-01-01T00:00:00Z",
      });
    }
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(h.logs.some((l) => l.includes("the comment run is ambiguous"))).toBe(
      true,
    );
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(true);
  });
});

describe("run: a phase that outlives its poll", () => {
  test("a comment run still in progress at the deadline is cancelled before its PR closes, and the scenario exits 1", async () => {
    const world = new FakeGithub({ ref: REF, stuckCommentRuns: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(h.logs.some((l) => l.startsWith("timed out after"))).toBe(true);
    const cancelAt = world.events.findIndex((e) => e.startsWith("run cancel"));
    const closeAt = world.events.findIndex((e) => e.startsWith("pr close"));
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(cancelAt);
  });
});

// Cleanup stops every run of the PR that is still going, including one the poll never
// sighted. The comment run of a phase is the one a signal can outrun: the comment is
// posted, its run starts, and the signal lands before the poll reads that run.
describe("cleanup: a comment run the poll never sighted is still cancelled", () => {
  test("a lookup that fails after an ambiguity still cancels both recorded candidates, and the PR stays open", async () => {
    const world = new FakeGithub({ ref: REF });
    const candidates = [0, 1].map(() =>
      world.addRun({
        event: "issue_comment",
        displayTitle: COMMENT_TITLE,
        createdAt: "2099-01-01T00:00:00Z",
        status: "in_progress",
      }),
    );
    const h = world.harness();
    // The poll's read is the only comment listing that succeeds: cleanup's own lookup fails.
    let commentListings = 0;
    const post = h.deps.gh;
    h.deps.gh = async (args) => {
      if (
        args[0] === "run" &&
        args[1] === "list" &&
        args.includes("issue_comment")
      ) {
        commentListings += 1;
        if (commentListings > 1) return fail("HTTP 502: Bad Gateway");
      }
      return post(args);
    };
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    for (const id of candidates) {
      expect(world.events.indexOf(`run cancel ${id}`)).toBeGreaterThanOrEqual(
        0,
      );
    }
    expect(world.events.some((e) => e.startsWith("pr close"))).toBe(false);
  });

  test("a signal that lands as the comment is posted cancels the comment run before the PR closes", async () => {
    const world = new FakeGithub({ ref: REF, stuckCommentRuns: true });
    const h = world.harness();
    const post = h.deps.gh;
    h.deps.gh = async (args) => {
      const result = await post(args);
      if (args[0] === "pr" && args[1] === "comment") h.signals.fire("SIGINT");
      return result;
    };
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(130);
    const cancelAt = world.events.findIndex((e) => e.startsWith("run cancel"));
    const closeAt = world.events.findIndex((e) => e.startsWith("pr close"));
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(cancelAt);
  });

  test("two ambiguous comment runs are both recorded and both cancelled before the PR closes", async () => {
    const world = new FakeGithub({ ref: REF });
    const candidates = [0, 1].map(() =>
      world.addRun({
        event: "issue_comment",
        displayTitle: COMMENT_TITLE,
        createdAt: "2099-01-01T00:00:00Z",
        status: "in_progress",
      }),
    );
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(h.logs.some((l) => l.includes("the comment run is ambiguous"))).toBe(
      true,
    );
    const closeAt = world.events.findIndex((e) => e.startsWith("pr close"));
    expect(closeAt).toBeGreaterThanOrEqual(0);
    for (const id of candidates) {
      const cancelAt = world.events.indexOf(`run cancel ${id}`);
      expect(cancelAt).toBeGreaterThanOrEqual(0);
      expect(closeAt).toBeGreaterThan(cancelAt);
    }
  });
});

// S4: the gate's verdicts, end to end under the fake. The fake encodes the
// product's gate matrix (the minimum the scenarios rely on), so these prove the
// runner's expectations and sequencing; the live scenarios prove the product.
describe("run: the S4 gate verdicts against the fake repository", () => {
  test("size-skip exits 0: an over-size PR is skipped with a failure status, and /pr-hero review reviews it", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["size-skip"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        /PASS {2}size-skip: \[1\] path is skipped:size/.test(l),
      ),
    ).toBe(true);
    expect(
      h.logs.some((l) =>
        /PASS {2}size-skip: \[1\] status is failure, description starts with pr-hero skipped the review/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      h.logs.some((l) => /PASS {2}size-skip: \[2\] path is reviewed/.test(l)),
    ).toBe(true);
  });

  test("override exits 0: a red gate turns green with the actor's status and an audit comment, and no review is posted for it", async () => {
    const world = new FakeGithub({ ref: REF, blockingFindings: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["override"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        /PASS {2}override: \[1\] status matches the blocking findings/.test(l),
      ),
    ).toBe(true);
    expect(
      h.logs.some((l) =>
        /PASS {2}override: \[2\] status is success, description starts with pr-hero: overridden by @/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      h.logs.some((l) =>
        /PASS {2}override: \[2\] an override comment this run posted on this head/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  test("review-advisory exits 0 with success even when the review finds a blocking issue", async () => {
    const world = new FakeGithub({ ref: REF, blockingFindings: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["review-advisory"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) => /PASS {2}review-advisory: status is success/.test(l)),
    ).toBe(true);
  });

  test("review-free exits 0 when the gate reads a blocking finding as failure", async () => {
    const world = new FakeGithub({ ref: REF, blockingFindings: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        /PASS {2}review-free: status matches the blocking findings/.test(l),
      ),
    ).toBe(true);
  });

  test("review-free exits 1 when the status ignores a blocking finding: the consistency check catches it", async () => {
    const world = new FakeGithub({
      ref: REF,
      blockingFindings: true,
      statusIgnoresFindings: true,
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(1);
    expect(
      h.logs.some((l) =>
        /FAIL {2}review-free: status matches the blocking findings/.test(l),
      ),
    ).toBe(true);
  });
});

// same-head-rereview: the gate must stay red when the author re-runs a head
// whose blocking finding is still open. Phase 2's status check is conditional
// on phase 1 having posted a blocking finding to carry, so the scenario skips
// that assertion, and says so, when the free model finds nothing blocking.
describe("same-head-rereview: the status check after a re-run depends on phase 1", () => {
  test("a blocking finding on phase 1 is still failure after /pr-hero review on the same head", async () => {
    const world = new FakeGithub({ ref: REF, blockingFindings: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["same-head-rereview"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        /PASS {2}same-head-rereview: \[2\] status is failure/.test(l),
      ),
    ).toBe(true);
  });

  test("a clean phase 1 names phase 2's status as not asserted, and asserts nothing else about it", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["same-head-rereview"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        /not asserted: same-head-rereview \[2\] status is failure \(phase 1 posted no blocking finding to carry\)/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      h.logs.some(
        (l) =>
          /same-head-rereview: \[2\] status is failure/.test(l) &&
          /^PASS/.test(l.trim()),
      ),
    ).toBe(false);
  });

  test("a status that drops the blocking finding on the re-run fails the scenario", async () => {
    const world = new FakeGithub({
      ref: REF,
      blockingFindings: true,
      statusIgnoresFindings: true,
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["same-head-rereview"], OPTIONS)).toBe(1);
    expect(
      h.logs.some((l) =>
        /FAIL {2}same-head-rereview: \[2\] status is failure/.test(l),
      ),
    ).toBe(true);
  });
});

// T2e: the reaction on a command, read live through the rails, and the near miss that
// runs nothing. The fake trigger answers each comment as src/ci/trigger.ts does.
describe("T2e: the reactions and the near miss, end to end", () => {
  test("near-miss exits 0: its comment run is confused, its step concludes success with no review evidence, and the PR gets no outcome", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["near-miss"], OPTIONS)).toBe(0);
    for (const label of [
      "[2] issue_comment run completed",
      "[2] the triggering comment has the confused reaction",
      "[2] the run left no review evidence of its own",
      "[2] this run posted no outcome comment",
    ]) {
      expect(h.logs.some((l) => l.includes(`PASS  near-miss: ${label}`))).toBe(
        true,
      );
    }
    // One comment run, and it reviewed nothing: its composite step still concludes
    // success, as GitHub reports it, and it uploaded no review artifact and no outcome.
    const commentRuns = world.runs.filter((r) => r.event === "issue_comment");
    expect(commentRuns).toHaveLength(1);
    expect(commentRuns[0]?.stepConclusion).toBe("success");
    const prComments = [...world.comments.values()].flat().map((c) => c.body);
    expect(
      prComments.filter((b) => b.startsWith("<!-- pr-hero-outcome")),
    ).toEqual([]);
  });

  test("near-miss accepts a phase 1 that hunters-failed: the outcome it left is not this near miss's", async () => {
    // Phase 1 is the only run the queue feeds: a near miss's outcome is forced to
    // near-miss, so this run posts no outcome and the one phase 1 left stays on the PR.
    const world = new FakeGithub({ ref: REF, runOutcomes: ["hunters-failed"] });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["near-miss"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        l.includes("PASS  near-miss: [2] this run posted no outcome comment"),
      ),
    ).toBe(true);
    const pr = [...world.prs.values()][0];
    const left = (world.comments.get(pr?.number ?? -1) ?? []).filter((c) =>
      c.body.startsWith("<!-- pr-hero-outcome"),
    );
    expect(left).toHaveLength(1);
  });

  test("the comment's reactions are read once, as a GET through the rails, and only on the comment phase", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(0);
    const reads = h.ghCalls.filter(
      (c) =>
        c[0] === "api" && /\/issues\/comments\/\d+\/reactions/.test(c[1] ?? ""),
    );
    // comment-trigger has one comment phase, so one read, with no method flag.
    expect(reads).toHaveLength(1);
    expect(reads[0]).toHaveLength(2);
    expect(reads[0]?.[1]).toMatch(
      new RegExp(
        `^repos/${SANDBOX_REPO}/issues/comments/\\d+/reactions\\?per_page=100$`,
      ),
    );
    expect(
      h.logs.some((l) =>
        /PASS {2}comment-trigger: \[2\] the triggering comment has the eyes reaction/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  test("a reactions read that fails fails its check on what it could not read, and never passes it", async () => {
    const world = new FakeGithub({ ref: REF, reactionsUnreadable: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(
      h.logs.some((l) =>
        l.includes("could not read the reactions on the triggering comment"),
      ),
    ).toBe(true);
    expect(
      h.logs.some((l) =>
        /FAIL {2}comment-trigger: \[2\] the triggering comment has the eyes reaction/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      h.logs.some((l) =>
        /PASS {2}comment-trigger: \[2\] the triggering comment has the eyes reaction/.test(
          l,
        ),
      ),
    ).toBe(false);
  });

  test("the reaction read is a GET the rails allow, and a POST to the same path is refused", () => {
    const path = `repos/${SANDBOX_REPO}/issues/comments/9001/reactions`;
    expect(() => assertGhArgs(["api", `${path}?per_page=100`])).not.toThrow();
    // The endpoint is the second argument, as the rails read it, so the refusal is the
    // method rule's own, not a missing endpoint.
    expect(() => assertGhArgs(["api", path, "-X", "POST"])).toThrow(
      RailViolation,
    );
    expect(() => assertGhArgs(["api", path, "-X", "POST"])).toThrow(
      "is not a sandbox operation",
    );
  });
});

// D3: a blocking finding first found by a re-review keeps its state row, so the next
// re-review still counts it. The second push adds a file, and the forced review on
// that head must write the state row at that file.
describe("rereview-fresh-finding: the state row of a finding first found by a re-review", () => {
  test("rereview-fresh-finding exits 0: the report carries a state row at src/mute.ts", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["rereview-fresh-finding"], OPTIONS),
    ).toBe(0);
    expect(
      h.logs.some((l) =>
        /PASS {2}rereview-fresh-finding: \[3\] state row at src\/mute\.ts/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  test("rereview-fresh-finding exits 1 when the report carries no state row at src/mute.ts", async () => {
    const world = new FakeGithub({ ref: REF, omitStateRows: true });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["rereview-fresh-finding"], OPTIONS),
    ).toBe(1);
    expect(
      h.logs.some((l) =>
        /FAIL {2}rereview-fresh-finding: \[3\] state row at src\/mute\.ts/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  test("a push that adds files on an unchanged variant is not empty, and does not throw", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["rereview-fresh-finding"], OPTIONS),
    ).toBe(0);
    expect(h.logs.some((l) => l.includes("the push would be empty"))).toBe(
      false,
    );
    expect(world.events.some((e) => e.startsWith("push "))).toBe(true);
  });
});

describe("recheck-dismissal: a false dismissal does not turn the gate green (T5b)", () => {
  test("refuses to start when main is not pinned to the ref, and pushes nothing", async () => {
    const world = new FakeGithub({
      ref: REF,
      blockingFindings: true,
      mainWorkflow: sandboxFiles("v0.1.0").get(WORKFLOW_PATH),
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["recheck-dismissal"], OPTIONS)).toBe(1);
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
    expect(h.logs.some((l) => l.includes(`init --ref ${REF}`))).toBe(true);
  });

  test("exits 0: the dismissal is posted, the recheck keeps the gate red, and the adjudicator rejects the dismissal", async () => {
    const world = new FakeGithub({ ref: REF, blockingFindings: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["recheck-dismissal"], OPTIONS)).toBe(0);
    expect(
      h.logs.some((l) =>
        /PASS {2}recheck-dismissal: \[2\] CI adjudication reply is one of rejected\/inconclusive/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  test("exits 1 when the adjudicator upholds the dismissal: the adjudication check catches it", async () => {
    const world = new FakeGithub({
      ref: REF,
      blockingFindings: true,
      adjudicationVerdict: "upheld",
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["recheck-dismissal"], OPTIONS)).toBe(1);
    expect(
      h.logs.some((l) =>
        /FAIL {2}recheck-dismissal: \[2\] CI adjudication reply is one of rejected\/inconclusive/.test(
          l,
        ),
      ),
    ).toBe(true);
  });
});

describe("cancel: a review run cancelled mid-review leaves its status settled (SB3)", () => {
  test("the cancel is sent while the gate is pending, the run is cancelled, and the scenario exits 0", async () => {
    const world = new FakeGithub({ ref: REF, pendingThenCancellable: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["cancel"], OPTIONS)).toBe(0);
    expect(h.logs.some((l) => l.includes("cancel sent to run"))).toBe(true);
    expect(world.events.some((e) => e.startsWith("run cancel"))).toBe(true);
  });

  test("a cancel that leaves the status pending fails the scenario with exit 1", async () => {
    const world = new FakeGithub({
      ref: REF,
      pendingThenCancellable: true,
      cancelLeavesPending: true,
    });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["cancel"], OPTIONS)).toBe(1);
    expect(h.logs.some((l) => l.includes("cancel sent to run"))).toBe(true);
  });
});
