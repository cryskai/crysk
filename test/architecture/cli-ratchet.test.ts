// CLI Decomposition S6 (odd/tasks/cli-decomposition.md): the cli.ts regression guard.
//
// The decomposition took `src/cli.ts` from 7820 lines (122 functions) down to
// main() and runCli() (~325 lines). Two invariants keep it there:
// 1. Function census: cli.ts must ONLY declare the 2 canonical functions (main, runCli).
//    All new functions must live in their domain modules.
// 2. Per-function size limit on cli.ts and the extracted domain modules: no
//    function exceeds 300 lines.
//
// A whole-file line ceiling used to sit beside these. It ratcheted the refactor
// down while it was in progress, but pinned at the exact post-refactor count it
// failed on legitimate wiring (one import plus a call in each signal handler,
// 19b71c4). The census alone does not replace it: it checks names, not size, so
// main() and runCli() could regrow inline. That is why cli.ts is also swept by
// the per-function guard below — together they bound cli.ts to two functions
// of at most 300 lines each.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.join(import.meta.dir, "../..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");

const CANONICAL_CLI_FUNCTIONS = ["main", "runCli"].sort();

const MAX_FUNCTION_LINES = 300;

function topLevelFunctionsInFile(
  filePath: string,
): { name: string; lines: number; start: number; end: number }[] {
  const content = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const functions: {
    name: string;
    lines: number;
    start: number;
    end: number;
  }[] = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const start = sf.getLineAndCharacterOfPosition(stmt.getStart()).line + 1;
      const end = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1;
      functions.push({
        name: stmt.name.text,
        lines: end - start + 1,
        start,
        end,
      });
    }
  }

  return functions;
}

describe("cli.ts function census", () => {
  test("src/cli.ts declares ONLY the 2 canonical functions", () => {
    const fns = topLevelFunctionsInFile(CLI_PATH);
    const fnNames = fns.map((f) => f.name).sort();

    expect(
      fnNames,
      "src/cli.ts top-level functions must only be main and runCli. New code belongs in domain modules.",
    ).toEqual(CANONICAL_CLI_FUNCTIONS);
  });
});

describe("per-function size guard on extracted modules", () => {
  // Extracted modules from Phase 1 slices (S1-S5). cli-decomp-08 deliberately
  // does NOT add src/review/review.ts or src/pr/review-pr.ts here: review()
  // and reviewPr() moved out of cli.ts byte-for-byte (a pure relocation, not
  // a rewrite), and both are already far larger than 300 lines. Monitoring
  // them now would need a per-function exemption mechanism this guard does
  // not have; splitting them down to size is an explicit Phase 2 target, not
  // this slice's job. src/commands/menu.ts (menuCommand's new home) IS swept
  // in automatically below via the commands/ directory scan, and passes at
  // ~110 lines with no exemption needed.
  const EXTRACTED_MODULES = [
    // Not extracted, but the census leaves main()/runCli() free to regrow
    // inline; this bounds them now that the whole-file ceiling is gone.
    "src/cli.ts",
    "src/git/git.ts",
    "src/git/identity.ts",
    "src/ui/plan.ts",
    "src/ui/progress.ts",
    "src/pr/status.ts",
    "src/pr/pr-status.ts",
    "src/pr/admission.ts",
    "src/review/route-preflight.ts",
  ];

  // Commands extracted in S3
  const commandsDir = path.join(REPO_ROOT, "src/commands");
  const commandFiles = readdirSync(commandsDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/commands/${f}`);

  const allMonitoredModules = [...EXTRACTED_MODULES, ...commandFiles];

  test("no function in extracted modules exceeds 300 lines", () => {
    const oversized: { file: string; name: string; lines: number }[] = [];

    for (const relPath of allMonitoredModules) {
      const fullPath = path.join(REPO_ROOT, relPath);
      const fns = topLevelFunctionsInFile(fullPath);
      for (const fn of fns) {
        if (fn.lines > MAX_FUNCTION_LINES) {
          oversized.push({ file: relPath, name: fn.name, lines: fn.lines });
        }
      }
    }

    expect(
      oversized,
      `Extracted functions must not exceed ${MAX_FUNCTION_LINES} lines: ${JSON.stringify(oversized)}`,
    ).toEqual([]);
  });
});
