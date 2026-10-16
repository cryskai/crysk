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
      /holdCommitStatusLock\(\s*\{[\s\S]*?\},\s*runStartedMs,?\s*\);/,
    );
  });
});
