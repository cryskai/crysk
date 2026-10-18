// F002 on #330: the CLI's progress record names the head its pending status was
// posted on, so the publisher reads and writes the lock on the head the CLI
// actually took. resolvePrPlanAndConfirm reaches gh directly and has no seam for
// its status post, so this guard reads the source and pins the call order, the
// same way test/architecture/gate-skip-settlement.test.ts pins the gate skips.
// The env gate of recordReviewing (no file without PRHERO_OUTCOME_DIR) is tested
// behaviorally in test/ci/cli-record.test.ts.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pendingStatusTargetUrl } from "../../src/pr/plan";

const PLAN_SOURCE = path.join(import.meta.dir, "../../src/pr/plan.ts");

// Drops full-line comments, so a WHY comment that quotes a call cannot satisfy
// the guard.
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const code = codeOnly(fs.readFileSync(PLAN_SOURCE, "utf8"));
const start = code.indexOf("export async function resolvePrPlanAndConfirm(");
const body =
  start === -1 ? "" : code.slice(start, code.indexOf("\n}\n", start));

describe("resolvePrPlanAndConfirm records its progress on the head it posted", () => {
  test("the function is in src/pr/plan.ts", () => {
    expect(start).toBeGreaterThan(-1);
  });

  test("recordReviewing is imported from the CLI record module", () => {
    expect(code).toMatch(
      /import \{[^}]*\brecordReviewing\b[^}]*\} from "#ci\/cli-record";/,
    );
  });

  test("the pending status and the progress record name the same head, params.headSha", () => {
    expect(body).toMatch(
      /await tryPublishCommitStatus\(\s*params\.operatorRoot,\s*params\.headSha,/,
    );
    expect(body).toMatch(/recordReviewing\(\s*params\.headSha\s*\)/);
  });

  test("the progress record precedes the pending post, the hold, and the success return", () => {
    const record = body.search(/recordReviewing\(/);
    const post = body.search(/await tryPublishCommitStatus\(/);
    const hold = body.search(/holdCommitStatusLock\(\s*\{/);
    const successReturn = body.lastIndexOf("return {");
    expect(record).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(record);
    expect(hold).toBeGreaterThan(post);
    expect(successReturn).toBeGreaterThan(hold);
  });

  // Fix 1 on the override rule: the run's start is taken before the pending POST, which
  // can take two 15 s attempts. The hold is stamped with that start, not with the time
  // the POST returned, so an override posted while the POST was slow counts as posted
  // during the run.
  test("the run's start is captured before the pending post, and the hold is stamped with it", () => {
    const start = body.search(/const runStartedMs = Date\.now\(\)/);
    const post = body.search(/await tryPublishCommitStatus\(/);
    expect(start).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(start);
    expect(body).toMatch(
      /holdCommitStatusLock\(\s*\{[\s\S]*?\},\s*runStartedMs(?:,\s*pendingLanded)?,?\s*\);/,
    );
  });

  // Fix 3 on the override rule: the hold records whether this run's own pending status
  // landed, taken from the post's own result. teardown.ts drops the clock-skew allowance
  // when it did not, because a pending that never landed cannot vouch for the run's start.
  test("the hold carries whether the pending post landed, taken from that post's result", () => {
    const landed = body.search(
      /const pendingLanded = await tryPublishCommitStatus\(/,
    );
    const hold = body.search(/holdCommitStatusLock\(\s*\{/);
    expect(landed).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(landed);
    expect(body).toMatch(
      /holdCommitStatusLock\(\s*\{[\s\S]*?\},\s*runStartedMs,\s*pendingLanded,?\s*\);/,
    );
  });
});

// The free-route count is read off the admitted route plan, so it must be
// taken after resolvePipelineRoute (the admission that decides the verdicts)
// and before the plan card renders. Rendering first would print the band
// for a route the run already knows is free.
describe("resolvePrPlanAndConfirm prices the plan line by the admitted route", () => {
  test("the free-route count is taken after the admission and before the card renders", () => {
    const admission = body.search(/await resolvePipelineRoute\(/);
    const count = body.search(/await countFreeRouteSteps\(/);
    // The context spread is what hands the count to the renderer; the card
    // renders from that context, so both must follow the count.
    const handoff = body.indexOf("...(freeRoute === undefined");
    const render = body.indexOf("renderPrPlan(planContext");
    expect(admission).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(admission);
    expect(handoff).toBeGreaterThan(count);
    expect(render).toBeGreaterThan(handoff);
  });

  test("countFreeRouteSteps is imported from the free-discovery module", () => {
    expect(code).toMatch(
      /import \{[^}]*\bcountFreeRouteSteps\b[^}]*\} from "#model\/free-discovery";/,
    );
  });
});

// SB3 follow-up: the pending the CLI posts names its run in Actions, and the lock hold keeps the PR page.
describe("pendingStatusTargetUrl — the pending names its run", () => {
  const PR_URL = "https://github.com/acme/widgets/pull/7";
  const IN_ACTIONS = {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_RUN_ID: "4242",
    GITHUB_RUN_ATTEMPT: "2",
  };

  test("in Actions the pending's target is this run's attempt", () => {
    expect(pendingStatusTargetUrl(PR_URL, IN_ACTIONS)).toBe(
      "https://github.com/acme/widgets/actions/runs/4242/attempts/2",
    );
  });

  test("outside Actions the pending keeps the PR page", () => {
    expect(pendingStatusTargetUrl(PR_URL, {})).toBe(PR_URL);
  });

  test("the pending post in plan.ts uses it, and the hold still takes the PR page", () => {
    expect(body).toMatch(
      /phase: "pending",\s*posted: false,\s*targetUrl: pendingStatusTargetUrl\(statusTargetUrl\),/,
    );
    expect(body).toMatch(
      /holdCommitStatusLock\(\s*\{\s*operatorRoot: params\.operatorRoot,\s*sha: params\.headSha,\s*targetUrl: statusTargetUrl,/,
    );
  });
});
