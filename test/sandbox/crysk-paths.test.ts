// The sandbox follows the rename: its run lock lives in whichever home the CLI
// resolves, and the repo files it seeds use the new directory (the sandbox
// repo is ours, so there is no legacy layout to preserve).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultLockPath } from "../../scripts/sandbox/real";
import { GOTCHAS_PATH, REPO_CONFIG_PATH } from "../../scripts/sandbox/seed";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "crysk-sandbox-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("sandbox run lock", () => {
  test("a fresh home puts the lock in ~/.crysk", () => {
    expect(defaultLockPath(home)).toBe(
      path.join(home, ".crysk", "sandbox.lock"),
    );
  });

  test("a legacy-only home keeps the lock in ~/.prhero", () => {
    mkdirSync(path.join(home, ".prhero"));
    expect(defaultLockPath(home)).toBe(
      path.join(home, ".prhero", "sandbox.lock"),
    );
  });

  test("a stateful ~/.crysk wins; an empty one does not hide ~/.prhero", () => {
    mkdirSync(path.join(home, ".prhero"));
    mkdirSync(path.join(home, ".crysk"));
    expect(defaultLockPath(home)).toBe(
      path.join(home, ".prhero", "sandbox.lock"),
    );
    writeFileSync(path.join(home, ".crysk", "config.json"), "{}");
    expect(defaultLockPath(home)).toBe(
      path.join(home, ".crysk", "sandbox.lock"),
    );
  });
});

describe("sandbox seed paths", () => {
  test("the sandbox repo's config and gotchas live under .crysk/", () => {
    expect(REPO_CONFIG_PATH).toBe(".crysk/config.json");
    expect(GOTCHAS_PATH).toBe(".crysk/gotchas.md");
  });
});
