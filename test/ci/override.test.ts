// The override rule's own module (src/ci/override.ts). Its decision is tested where it is
// used: the CLI's final write in test/pr/teardown.test.ts, and the publisher's repost in
// test/ci/publish.test.ts. This file pins what only the module itself can break: that it
// stays builtins-only (the publisher imports it before `bun install`), that its context is
// the one the required check reads, and the exact edge of the clock-skew allowance.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { overrideStandsOverRun } from "#ci/override";

const MODULE_PATH = path.resolve(import.meta.dir, "../../src/ci/override.ts");

describe("override rule: builtins-only module", () => {
  test("it imports nothing outside the language", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    expect(runtimeImportViolations(source)).toEqual([]);
  });

  test("the guard itself fails on a repo import and on a package import, and passes a type-only one", () => {
    expect(runtimeImportViolations('import { a } from "../x";')).toHaveLength(
      1,
    );
    expect(runtimeImportViolations('import { a } from "zod";')).toHaveLength(1);
    expect(runtimeImportViolations('import type { A } from "../x";')).toEqual(
      [],
    );
  });
});

describe("override rule: the context is the one the required check reads", () => {
  test("OVERRIDE_STATUS_CONTEXT equals COMMIT_STATUS_CONTEXT in src/pr/preflight.ts", () => {
    // WHY a drift test: override.ts is builtins-only, so it cannot import the constant.
    const preflight = readFileSync(
      path.resolve(import.meta.dir, "../../src/pr/preflight.ts"),
      "utf8",
    );
    const override = readFileSync(MODULE_PATH, "utf8");
    const expected = /export const COMMIT_STATUS_CONTEXT = "([^"]+)"/.exec(
      preflight,
    )?.[1];
    const actual = /export const OVERRIDE_STATUS_CONTEXT = "([^"]+)"/.exec(
      override,
    )?.[1];
    expect(expected).toBeDefined();
    expect(actual).toBe(expected as string);
  });
});

describe("override rule: the clock-skew allowance edge", () => {
  const OVERRIDE =
    "pr-hero: overridden by @maintainer — no review on this head";
  const RUN_START = Date.parse("2026-10-17T12:00:00Z");
  const override = (createdMs: number) => ({
    state: "success",
    context: "pr-hero",
    created_at: new Date(createdMs).toISOString(),
    description: OVERRIDE,
  });

  test("an override created exactly the allowance before the run started (5 s) stands", () => {
    expect(
      overrideStandsOverRun([override(RUN_START - 5_000)], RUN_START),
    ).toBe(true);
  });

  test("an override created 10 s before the run started does not stand", () => {
    expect(
      overrideStandsOverRun([override(RUN_START - 10_000)], RUN_START),
    ).toBe(false);
  });
});

// The same rule as publish.test.ts's runtimeImportViolations (kept as a copy: that helper
// is private to its file). Comments are stripped first; a type-only import is allowed.
function runtimeImportViolations(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const ok = (specifier: string): boolean =>
    specifier.startsWith("node:") ||
    specifier === "bun" ||
    specifier.startsWith("bun:");
  const violations: string[] = [];
  for (const match of code.matchAll(
    /\b(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g,
  )) {
    const clause = match[2] ?? "";
    const specifier = match[3] ?? "";
    if (/^\s*type\b/.test(clause)) continue;
    if (!ok(specifier)) violations.push(`${match[1]} from "${specifier}"`);
  }
  for (const match of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    const specifier = match[1] ?? "";
    if (!ok(specifier)) violations.push(`import "${specifier}"`);
  }
  for (const match of code.matchAll(
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const specifier = match[1] ?? "";
    if (!ok(specifier)) violations.push(`dynamic "${specifier}"`);
  }
  return violations;
}
