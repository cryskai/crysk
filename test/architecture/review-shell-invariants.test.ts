// review-pr-behavior-seams (Goal B): invariant 10 from the review-shell
// wiring family, promoted out of test/cli.test.ts into a structural scan of
// its own. It is a genuine cross-module invariant with no single seam to
// extract it into — "every gotchas gate asks the shared predicate"
// span src/review/ AND src/pr/ by nature — so it stays a source scan, but a
// DIRECTORY scan rather than a hardcoded file list: adding a THIRD review
// shell, or moving one of the two existing ones to a new file inside either
// domain, is meant to trip this automatically rather than going dark the
// moment the file that used to be pinned moves (exactly the trap
// test/cli.test.ts's own header comment names for the block this replaces).
//
// Call-SHAPE tokens, not whitespace-sensitive multi-line literals: a
// reformat (biome, or a wrapped argument list) must never flip this guard.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.join(import.meta.dir, "../../src");

function getAllTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function readAll(paths: string[]): string {
  return paths.map((p) => fs.readFileSync(p, "utf8")).join("\n");
}

// Counts CALL sites of `${name}(` in `source`, excluding `name`'s OWN
// declaration line and full-line comments — this codebase's WHY comments
// routinely quote a call verbatim to explain it (e.g. target.ts's own header
// names `validateGotchas(gotchasPath)`), and a directory-wide scan must not
// mistake that prose for a second call site, nor mistake a function's own
// `export (async )?function <name>(` signature for a call to itself.
function countCallSites(source: string, name: string): number {
  const declLine = new RegExp(
    `^\\s*export\\s+(async\\s+)?function\\s+${name}\\s*\\(`,
  );
  const kept = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !declLine.test(line))
    .join("\n");
  return kept.split(`${name}(`).length - 1;
}

const REVIEW_DOMAIN_FILES = [
  ...getAllTsFiles(path.join(SRC_DIR, "review")),
  ...getAllTsFiles(path.join(SRC_DIR, "pr")),
];

describe("every gotchas gate asks the shared predicate", () => {
  // doctor.ts sits at src/ root, outside both scanned domains — kept as an
  // explicit extra path so it does not go dark the moment this scan stopped
  // being a hardcoded file list for everything else.
  const EXTRA_GOTCHAS_GATE_FILES = [path.join(SRC_DIR, "doctor.ts")];

  test("no gate re-implements the old empty-only check", () => {
    const source = readAll([
      ...REVIEW_DOMAIN_FILES,
      ...EXTRA_GOTCHAS_GATE_FILES,
    ]);
    for (const needle of [
      "if (gotchas.trim().length === 0)",
      "gotchasContent.trim().length === 0)",
    ]) {
      expect(source.includes(needle)).toBe(false);
    }
  });

  // A "shell" is any scanned file that CALLS runPipeline (never its own
  // declaration in pipeline.ts) — today review.ts and reviewPr(), by
  // definition rather than by name, so a third one added anywhere under
  // src/review/ or src/pr/ is counted automatically.
  test("every runPipeline-calling shell asks validateGotchas exactly once", () => {
    const shellCount = REVIEW_DOMAIN_FILES.filter(
      (file) =>
        countCallSites(fs.readFileSync(file, "utf8"), "runPipeline") > 0,
    ).length;
    expect(shellCount).toBeGreaterThan(0);
    const source = readAll(REVIEW_DOMAIN_FILES);
    expect(countCallSites(source, "validateGotchas")).toBe(shellCount);
  });
});
