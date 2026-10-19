// The runner's verdicts on runs that did not finish their own work: a kept PR whose
// run could not be cancelled, a comment run that only skipped, and a review step that
// failed behind a head that still reads as reviewed. Each runs end to end under the
// fake GitHub (world.ts), so the verdict is the runner's, not one unit's.

import { describe, expect, test } from "bun:test";
import { runScenarios } from "../../scripts/sandbox/scenario";
import { FakeGithub } from "./world";

const REF = "v0.2.0";
const OPTIONS = {
  ref: REF,
  keep: false,
  pollIntervalMs: 15_000,
  timeoutMs: 60_000,
  cancelWaitMs: 60_000,
};
const KEEP = { ...OPTIONS, keep: true };

describe("run: --keep does not keep a PR over a run still going", () => {
  test("a timed-out comment run that cannot be cancelled keeps its PR open, and the next scenario is refused", async () => {
    const world = new FakeGithub({
      ref: REF,
      stuckCommentRuns: true,
      ignoreCancel: true,
    });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["comment-trigger", "review-free"], KEEP),
    ).toBe(1);
    expect(world.events.some((e) => e.startsWith("run cancel"))).toBe(true);
    expect(h.logs.some((l) => l.startsWith("left open: run"))).toBe(true);
    // review-free never started: the S6 check saw the kept PR, still in flight.
    expect(
      h.logs.some((l) =>
        l.startsWith("refusing to start: 1 scenario PR(s) still open"),
      ),
    ).toBe(true);
    expect(world.events.filter((e) => e.startsWith("pr create")).length).toBe(
      1,
    );
  });

  test("a timed-out comment run that is cancelled is kept, the log says so, and the next scenario starts", async () => {
    const world = new FakeGithub({ ref: REF, stuckCommentRuns: true });
    const h = world.harness();
    expect(
      await runScenarios(h.deps, ["comment-trigger", "review-free"], KEEP),
    ).toBe(1);
    expect(
      h.logs.some(
        (l) => l.startsWith("kept:") && l.includes("its run cancelled first"),
      ),
    ).toBe(true);
    expect(h.logs.some((l) => l.startsWith("refusing to start"))).toBe(false);
    // The kept PR was settled, so it does not block the next scenario's PR.
    expect(world.events.filter((e) => e.startsWith("pr create")).length).toBe(
      2,
    );
  });
});

describe("run: a comment run's own review is the only pass", () => {
  test("a comment run that posts only a skip-size marker fails phase 2, though the head reads as reviewed", async () => {
    const world = new FakeGithub({ ref: REF, commentRunsSkipSize: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["comment-trigger"], OPTIONS)).toBe(1);
    expect(
      h.logs.some((l) =>
        l.startsWith("  FAIL  comment-trigger: [2] path is reviewed"),
      ),
    ).toBe(true);
    // The skip marker is the run's own evidence, so only the path decides this case.
    expect(
      h.logs.some((l) =>
        l.startsWith(
          "  PASS  comment-trigger: [2] the run left its own evidence",
        ),
      ),
    ).toBe(true);
  });
});

describe("run: the run's own review step must succeed", () => {
  test("review-free fails when its review step fails, though the head reads as reviewed", async () => {
    const world = new FakeGithub({ ref: REF, stepFailsOnReview: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["review-free"], OPTIONS)).toBe(1);
    expect(
      h.logs.some((l) =>
        l.startsWith("  FAIL  review-free: the run's review step succeeded"),
      ),
    ).toBe(true);
  });

  test("cleanup's second run fails its review step behind a reviewed head: the scenario exits 1", async () => {
    const world = new FakeGithub({ ref: REF, stepFailsOnReview: true });
    const h = world.harness();
    expect(await runScenarios(h.deps, ["cleanup"], OPTIONS)).toBe(1);
    expect(
      h.logs.some((l) =>
        l.startsWith("  FAIL  cleanup: [2] the run's review step succeeded"),
      ),
    ).toBe(true);
  });
});

describe("run: a signal that stops the invocation is not a clean exit", () => {
  test("a signal during the cleanup of a passing scenario starts no later scenario, and the exit is the signal's", async () => {
    const world = new FakeGithub({ ref: REF });
    const h = world.harness();
    // The signal lands in the first scenario's cleanup, at its PR close. The scenario
    // itself has already passed; the second one must not start.
    const original = h.deps.gh;
    h.deps.gh = async (args) => {
      if (args[0] === "pr" && args[1] === "close") h.signals.fire("SIGINT");
      return original(args);
    };
    expect(
      await runScenarios(h.deps, ["review-free", "no-credential"], OPTIONS),
    ).toBe(130);
    expect(h.logs.some((l) => l.startsWith("not run: no-credential"))).toBe(
      true,
    );
    expect(world.events.filter((e) => e.startsWith("pr create")).length).toBe(
      1,
    );
  });
});
