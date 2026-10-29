// Location rules shared by pr-hero's path matching.

import { describe, expect, test } from "bun:test";
import { DEFAULT_LINE_WINDOW, normalizePath } from "#compare/compare";

describe("normalizePath", () => {
  test("trims and strips one leading ./", () => {
    expect(normalizePath("  ./src/a.ts  ")).toBe("src/a.ts");
    expect(normalizePath("src/a.ts")).toBe("src/a.ts");
  });

  test("does not fold case or reduce to a basename", () => {
    // Two packages in this monorepo genuinely own files with the same
    // basename; matching on it would fabricate agreements across packages.
    expect(normalizePath("packages/web/src/a.ts")).not.toBe(
      normalizePath("packages/app/src/a.ts"),
    );
    expect(normalizePath("Src/A.ts")).not.toBe(normalizePath("src/a.ts"));
  });
});

describe("DEFAULT_LINE_WINDOW", () => {
  test("is 25 lines", () => {
    expect(DEFAULT_LINE_WINDOW).toBe(25);
  });
});
