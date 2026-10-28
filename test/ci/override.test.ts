// The override rule's own module (src/ci/override.ts). Its decision is tested where it is
// used: the CLI's final write in test/pr/teardown.test.ts, and the publisher's repost in
// test/ci/publish.test.ts. This file pins what only the module itself can break: that it
// stays builtins-only (the publisher imports it before `bun install`), that its context is
// the one the required check reads, and the exact edge of the cutoff the CLI computes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isOverrideStatus,
  newestStatusInContext,
  OVERRIDE_DESCRIPTION_PREFIX,
  OVERRIDE_STATUS_CONTEXT,
  overrideActorOf,
  overrideCutoffMs,
  overrideStandsOverRun,
} from "#ci/override";
import { COMMIT_STATUS_CONTEXT } from "#pr/preflight";
import { STATUS_CONTEXT } from "../../src/brand";

const MODULE_PATH = path.resolve(import.meta.dir, "../../src/ci/override.ts");
const BRAND_PATH = path.resolve(import.meta.dir, "../../src/brand.ts");

describe("override rule: builtins-only module", () => {
  test("it imports nothing outside the language but the brand module, which imports nothing itself", () => {
    expect(runtimeImportViolations(readFileSync(MODULE_PATH, "utf8"))).toEqual(
      [],
    );
    expect(
      runtimeImportViolations(readFileSync(BRAND_PATH, "utf8"), false),
    ).toEqual([]);
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
  test("OVERRIDE_STATUS_CONTEXT is brand's STATUS_CONTEXT, which is the gate's COMMIT_STATUS_CONTEXT", () => {
    // WHY brand's constant: override.ts is loaded before dependencies are installed, so it
    // takes the one literal from the module that imports nothing (src/brand.ts).
    expect(OVERRIDE_STATUS_CONTEXT).toBe(STATUS_CONTEXT);
    expect(OVERRIDE_STATUS_CONTEXT).toBe(COMMIT_STATUS_CONTEXT);
  });
});

describe("override rule: the cutoff", () => {
  const OVERRIDE =
    "pr-hero: overridden by @maintainer — no review on this head";
  const RUN_START = Date.parse("2026-10-17T12:00:00Z");
  const override = (createdMs: number) => ({
    state: "success",
    context: "pr-hero",
    created_at: new Date(createdMs).toISOString(),
    description: OVERRIDE,
  });

  // The CLI computes the cutoff once: the start less the 5 s clock-skew allowance when its
  // own pending landed (it witnesses the start), and the start itself when it did not.
  test("with the pending landed, the cutoff is the run's start less 5 s", () => {
    expect(overrideCutoffMs(RUN_START, true)).toBe(RUN_START - 5_000);
  });

  test("with the pending not landed, the cutoff is the run's start", () => {
    expect(overrideCutoffMs(RUN_START, false)).toBe(RUN_START);
  });

  // The rule compares with the cutoff it is given and adds no allowance of its own.
  test("an override created exactly at the cutoff (start less 5 s) stands", () => {
    expect(
      overrideStandsOverRun([override(RUN_START - 5_000)], RUN_START - 5_000),
    ).toBe(true);
  });

  test("an override created 1 ms before the cutoff (start less 5 s) does not stand", () => {
    expect(
      overrideStandsOverRun([override(RUN_START - 5_001)], RUN_START - 5_000),
    ).toBe(false);
  });

  test("an override created 3 s before the start stands against a cutoff of start less 5 s", () => {
    expect(
      overrideStandsOverRun([override(RUN_START - 3_000)], RUN_START - 5_000),
    ).toBe(true);
  });

  test("an override created 3 s before the start does not stand against a cutoff of the start", () => {
    expect(
      overrideStandsOverRun([override(RUN_START - 3_000)], RUN_START),
    ).toBe(false);
  });

  test("an override created exactly at the start stands against a cutoff of the start", () => {
    expect(overrideStandsOverRun([override(RUN_START)], RUN_START)).toBe(true);
  });

  test("an override created 1 ms before the start does not stand against a cutoff of the start", () => {
    expect(overrideStandsOverRun([override(RUN_START - 1)], RUN_START)).toBe(
      false,
    );
  });

  test("an override created 10 s before the run started does not stand against the cutoff", () => {
    expect(
      overrideStandsOverRun([override(RUN_START - 10_000)], RUN_START - 5_000),
    ).toBe(false);
  });
});

// GitHub's status LIST is newest-first. Two rows in the same second must resolve to the first
// (newest) one, because the carry-forward and the publisher both read the list.
describe("newestStatusInContext: a same-second tie goes to the newest row", () => {
  const SAME_SECOND = "2026-10-16T10:00:00Z";
  const row = (state: string, description: string) => ({
    state,
    context: "pr-hero",
    created_at: SAME_SECOND,
    description,
  });

  test("[success@t, failure@t], newest first, selects success", () => {
    const rows = [
      row("success", "pr-hero: review posted"),
      row("failure", "pr-hero: 2 blocking finding(s)"),
    ];
    expect(newestStatusInContext(rows, "crysk")?.state).toBe("success");
  });

  test("a tie does not reorder the rows: the first array element wins, not the last", () => {
    const rows = [
      row("failure", "pr-hero: 2 blocking finding(s)"),
      row("success", "pr-hero: review posted"),
    ];
    expect(newestStatusInContext(rows, "crysk")?.state).toBe("failure");
  });

  test("an older row never displaces a newer one, whatever the array order", () => {
    const rows = [
      {
        state: "failure",
        context: "pr-hero",
        created_at: "2026-10-16T09:00:00Z",
      },
      { state: "success", context: "pr-hero", created_at: SAME_SECOND },
    ];
    expect(newestStatusInContext(rows, "crysk")?.state).toBe("success");
  });
});

// The rename publishes the gate on `crysk` and, for one version, on the legacy `pr-hero`.
// Every reader treats the two as one gate: the newest row across both decides.
describe("override rule: two contexts, one gate", () => {
  const RUN_START = Date.parse("2026-10-29T12:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const row = (
    context: string,
    state: string,
    createdMs: number,
    description?: string,
  ) => ({
    state,
    context,
    created_at: iso(createdMs),
    ...(description === undefined ? {} : { description }),
  });

  test("the newest row across crysk and pr-hero wins, whichever name it sits on", () => {
    const rows = [
      row("crysk", "failure", RUN_START),
      row("pr-hero", "success", RUN_START + 60_000),
    ];
    expect(newestStatusInContext(rows, "crysk")?.context).toBe("pr-hero");
    expect(newestStatusInContext([...rows].reverse(), "crysk")?.context).toBe(
      "pr-hero",
    );
  });

  test("a tie across the two names goes to the crysk row, in either array order", () => {
    const pair = [
      row("pr-hero", "success", RUN_START),
      row("crysk", "success", RUN_START),
    ];
    expect(newestStatusInContext(pair, "crysk")?.context).toBe("crysk");
    expect(newestStatusInContext([...pair].reverse(), "crysk")?.context).toBe(
      "crysk",
    );
  });

  test("the local pair is a different gate: crysk/local and pr-hero/local never answer for the gate", () => {
    const rows = [
      row("crysk/local", "success", RUN_START),
      row("pr-hero/local", "success", RUN_START),
    ];
    expect(newestStatusInContext(rows, "crysk")).toBeUndefined();
    expect(newestStatusInContext(rows, "crysk/local")?.context).toBe(
      "crysk/local",
    );
  });

  test("an override an older action posted only on pr-hero stands over an older crysk verdict", () => {
    const statuses = [
      row("crysk", "failure", RUN_START, "crysk: 2 blocking finding(s)"),
      row(
        "pr-hero",
        "success",
        RUN_START + 30_000,
        "pr-hero: overridden by @maintainer — no review on this head",
      ),
    ];
    expect(overrideStandsOverRun(statuses, RUN_START)).toBe(true);
  });

  test("an override on crysk stands, and a newer crysk verdict ends it", () => {
    const override = row(
      "crysk",
      "success",
      RUN_START + 1_000,
      "crysk: overridden by @maintainer — no review on this head",
    );
    expect(overrideStandsOverRun([override], RUN_START)).toBe(true);
    expect(
      overrideStandsOverRun(
        [override, row("crysk", "failure", RUN_START + 9_000, "crysk: x")],
        RUN_START,
      ),
    ).toBe(false);
  });

  test("a newer verdict that only the legacy name carries also ends the override", () => {
    const statuses = [
      row(
        "crysk",
        "success",
        RUN_START + 1_000,
        "crysk: overridden by @maintainer — no review on this head",
      ),
      row("pr-hero", "failure", RUN_START + 9_000, "pr-hero: x"),
    ];
    expect(overrideStandsOverRun(statuses, RUN_START)).toBe(false);
  });

  test("an override description is written crysk: and read in both spellings", () => {
    expect(OVERRIDE_DESCRIPTION_PREFIX).toBe("crysk: overridden by @");
    for (const description of [
      "crysk: overridden by @maintainer — no review on this head",
      "pr-hero: overridden by @maintainer — no review on this head",
    ]) {
      expect(
        isOverrideStatus({
          state: "success",
          context: "crysk",
          created_at: iso(RUN_START),
          description,
        }),
        description,
      ).toBe(true);
      expect(overrideActorOf(description), description).toBe("maintainer");
    }
  });
});

// The same rule as publish.test.ts's runtimeImportViolations (kept as a copy: that helper
// is private to its file). Comments are stripped first; a type-only import is allowed.
// `allowBrand`: override.ts may load ../brand (which imports nothing, checked on its own with
// false); brand.ts itself may load nothing at all.
function runtimeImportViolations(source: string, allowBrand = true): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const ok = (specifier: string): boolean =>
    (allowBrand && specifier === "../brand") ||
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

// The status command reads the gate's override the same way the CLI and the publisher do:
// one predicate (isOverrideStatus), and the login the publisher wrote into the description.
describe("isOverrideStatus and overrideActorOf", () => {
  const description =
    "pr-hero: overridden by @maintainer — no review on this head";

  test("a success carrying the override prefix is an override", () => {
    expect(
      isOverrideStatus({
        state: "success",
        context: "pr-hero",
        created_at: "2026-10-17T10:00:00Z",
        description,
      }),
    ).toBe(true);
  });

  test("a failure or pending carrying the prefix is not an override", () => {
    for (const state of ["failure", "pending", "error"]) {
      expect(
        isOverrideStatus({
          state,
          context: "pr-hero",
          created_at: "2026-10-17T10:00:00Z",
          description,
        }),
        state,
      ).toBe(false);
    }
  });

  test("a success without the prefix, or with no description, is not an override", () => {
    expect(
      isOverrideStatus({
        state: "success",
        context: "pr-hero",
        created_at: "2026-10-17T10:00:00Z",
        description: "pr-hero: review posted",
      }),
    ).toBe(false);
    expect(
      isOverrideStatus({
        state: "success",
        context: "pr-hero",
        created_at: "2026-10-17T10:00:00Z",
      }),
    ).toBe(false);
  });

  test("overrideActorOf reads the login the publisher wrote, and null for a non-override", () => {
    expect(overrideActorOf(description)).toBe("maintainer");
    expect(overrideActorOf("pr-hero: review posted")).toBeNull();
    expect(overrideActorOf(`${OVERRIDE_DESCRIPTION_PREFIX}`)).toBeNull();
  });
});
