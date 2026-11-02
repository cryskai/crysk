import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The Bun version has one pin: package.json's `packageManager`. setup-bun reads
// it through `bun-version-file`, so no workflow repeats the number. The only
// copy npm forces on us is `optionalDependencies.bun` (the Bun an npm install
// brings), which must stay a literal; this file keeps it equal to the pin.
// Before this guard the number lived in six places and sat on 1.3.14 for five
// releases after 1.4.0 without anyone noticing.

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const setupBunFiles = [
  "action.yml",
  ...readdirSync(join(ROOT, ".github/workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => `.github/workflows/${name}`),
].filter((file) =>
  readFileSync(join(ROOT, file), "utf8").includes("oven-sh/setup-bun"),
);

describe("Bun toolchain pin", () => {
  test("packageManager pins an exact Bun version", () => {
    expect(pkg.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
  });

  test("the Bun an npm install brings is the pinned version", () => {
    expect(pkg.optionalDependencies.bun).toBe(
      pkg.packageManager.slice("bun@".length),
    );
  });

  test("setup-bun steps exist where this guard expects them", () => {
    expect(setupBunFiles).toContain("action.yml");
    expect(setupBunFiles).toContain(".github/workflows/ci.yml");
  });

  test.each(setupBunFiles)(
    "%s reads the pin instead of repeating it",
    (file) => {
      const text = readFileSync(join(ROOT, file), "utf8");
      const steps = text.match(/uses: oven-sh\/setup-bun@/g) ?? [];
      const fromFile = text.match(/^\s*bun-version-file: /gm) ?? [];
      expect(text).not.toMatch(/^\s*bun-version: /m);
      expect(fromFile.length).toBe(steps.length);
    },
  );

  test("the Action reads its own package.json, not the caller's", () => {
    const text = readFileSync(join(ROOT, "action.yml"), "utf8");
    expect(text).toContain(
      "bun-version-file: ${{ github.action_path }}/package.json",
    );
  });
});
