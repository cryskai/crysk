// T3 S7 pins: the structural guards that keep the gate's context (`pr-hero`)
// reachable only from an explicit `--ci` run. Behavioural cases live beside the
// code they drive (teardown.test.ts, preflight.test.ts, watch/status-context);
// these read the source, the same precedent as plan.test.ts, because the call
// sites they guard sit inside reviewPr, which no offline test can run whole.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveCiPosture } from "#pr/preflight";
import { isCiEnvironment } from "#review/preflight";

const SRC = path.join(import.meta.dir, "../../src");

// Drops full-line comments, so a WHY comment that quotes a call cannot satisfy
// the guard.
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("S7: reviewPr resolves its posture from the explicit --ci flag only", () => {
  const reviewPr = codeOnly(
    fs.readFileSync(path.join(SRC, "pr/review-pr.ts"), "utf8"),
  );

  test("the run's posture is resolved from the options, never from isCi", () => {
    expect(reviewPr).toMatch(/resolveCiPosture\(options\)/);
    expect(reviewPr).not.toMatch(/resolveCiPosture\(\{[^}]*isCi/);
    expect(reviewPr).not.toMatch(/resolveCiMode\(\s*options\.ciMode,\s*isCi/);
  });

  test("CI=1 in the environment without --ci: isCi is true, the posture is advisory on pr-hero/local", () => {
    // isCi folds the environment in (it drives --yes, the budget and admission),
    // but the posture takes only the flag, so the environment cannot grade.
    expect(isCiEnvironment({}, { CI: "1" })).toBe(true);
    expect(resolveCiPosture({ ci: undefined, ciMode: undefined })).toEqual({
      ciMode: "advisory",
      statusContext: "pr-hero/local",
    });
  });
});

describe("S7: only the files that own a CI-scoped write or grade name the gate context", () => {
  // Each entry is a reviewed reason to name COMMIT_STATUS_CONTEXT as a value:
  //   preflight.ts  the definition, the gate builders, the posture resolver and
  //                 the CI admission gate's default read.
  //   admission.ts  the size and budget skip status, which is gate-only.
  //   teardown.ts   the final settle, which grades only the gate's own context.
  // A new file that names the gate must be added here on purpose.
  const ALLOWED = [
    "pr/admission.ts",
    "pr/preflight.ts",
    "pr/teardown.ts",
  ].sort();

  test("no other source file names the gate context", () => {
    const named = sourceFiles(SRC)
      .filter((file) =>
        /\bCOMMIT_STATUS_CONTEXT\b/.test(
          codeOnly(fs.readFileSync(file, "utf8")),
        ),
      )
      .map((file) => path.relative(SRC, file))
      .sort();
    expect(named).toEqual(ALLOWED);
  });
});
