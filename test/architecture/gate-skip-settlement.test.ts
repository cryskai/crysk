// #326: the size gate and the budget gate must settle their ledger row as
// `"gate-skipped"` through settleCiGateSkip, never as `"skipped"`. The helper's
// own behavior is tested in test/pr/ci-admission-gate.test.ts. What can regress
// silently is the call site: reverting it to settleCiAdmissionLedger(..., "skipped", ...)
// keeps the whole suite green, because the two entry points that make the call
// have no test seam. reviewPr() in src/pr/review-pr.ts and
// resolvePrPlanAndConfirm() in src/pr/plan.ts both reach gh directly, and
// test/cli.test.ts documents that reviewPr() has no seam for those fetches. So
// this guard reads the two source files and pins the call shape.
//
// Anchors are helper names and the branch planner calls, never line numbers.
// The settle regex is multi-line aware, because the real calls put one argument
// per line.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.join(import.meta.dir, "../../src");

function readSource(relative: string): string {
  return fs.readFileSync(path.join(SRC_DIR, relative), "utf8");
}

// Drops full-line comments: WHY prose in this codebase quotes calls verbatim,
// and a quoted `"skipped"` in a comment must not count as a settle.
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

// The text of one gate's skip branch: from its planner call to the publish
// that follows the settle. Scoping to the branch makes the check say "this
// branch settles through settleCiGateSkip", not merely "the file calls it".
function gateSkipBranch(source: string, planner: string): string {
  const start = source.indexOf(`${planner}({`);
  if (start === -1) return "";
  const end = source.indexOf("publishCiSkip({", start);
  return end === -1 ? "" : source.slice(start, end);
}

// An admission-ledger settle whose status argument is the literal "skipped".
// The first argument is always an identifier (ciAdmissionLedger or
// params.ciAdmissionLedger), so the pattern stays exact about the status.
const SKIPPED_SETTLE = /settleCiAdmissionLedger\(\s*[\w.]+\s*,\s*"skipped"/;

const GATE_SKIP_SITES = [
  {
    file: "pr/review-pr.ts",
    planner: "planCiSizeSkip",
    gate: "size gate",
  },
  {
    file: "pr/plan.ts",
    planner: "planCiBudgetSkip",
    gate: "budget gate",
  },
] as const;

describe("gate skips settle through settleCiGateSkip (#326)", () => {
  for (const site of GATE_SKIP_SITES) {
    test(`the ${site.gate} skip branch in src/${site.file} calls settleCiGateSkip`, () => {
      const branch = gateSkipBranch(
        codeOnly(readSource(site.file)),
        site.planner,
      );
      expect(
        branch.length,
        `src/${site.file} has no ${site.planner}({ ... publishCiSkip({ branch`,
      ).toBeGreaterThan(0);
      expect(branch).toContain("settleCiGateSkip(");
    });

    test(`src/${site.file} never settles the admission ledger with "skipped"`, () => {
      expect(SKIPPED_SETTLE.test(codeOnly(readSource(site.file)))).toBe(false);
    });
  }
});
