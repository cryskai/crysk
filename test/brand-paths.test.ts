import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  homeHasState,
  repoDirHasState,
  resolveHomeDir,
  resolveIgnoreFileName,
  resolveRepoDir,
} from "../src/brand-paths";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "crysk-paths-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mk = (...parts: string[]) =>
  mkdirSync(path.join(dir, ...parts), { recursive: true });
const touch = (...parts: string[]) => {
  mkdirSync(path.dirname(path.join(dir, ...parts)), { recursive: true });
  writeFileSync(path.join(dir, ...parts), "x");
};

// A directory "has state" when pr-hero itself put something in it. An empty
// ~/.crysk (created by hand, or by an installer that only made bin/) must not
// hide a populated ~/.prhero.
describe("resolveHomeDir", () => {
  test("only the legacy dir exists: legacy", () => {
    mk(".prhero");
    expect(resolveHomeDir(dir)).toBe(path.join(dir, ".prhero"));
  });
  test("only the new dir exists: new, with or without state", () => {
    mk(".crysk");
    expect(resolveHomeDir(dir)).toBe(path.join(dir, ".crysk"));
    touch(".crysk", "config.json");
    expect(resolveHomeDir(dir)).toBe(path.join(dir, ".crysk"));
  });
  test("neither exists: new (a fresh install)", () => {
    expect(resolveHomeDir(dir)).toBe(path.join(dir, ".crysk"));
  });
  test("empty .crysk beside a stateful .prhero: legacy keeps being used", () => {
    mk(".crysk");
    touch(".prhero", "prhero.db");
    expect(resolveHomeDir(dir)).toBe(path.join(dir, ".prhero"));
  });
  test(".crysk holding only bin/ does not shadow .prhero either", () => {
    mk(".crysk", "bin");
    touch(".prhero", "config.json");
    expect(resolveHomeDir(dir)).toBe(path.join(dir, ".prhero"));
  });
  test("stateful .crysk always wins, even beside a stateful .prhero", () => {
    touch(".crysk", "watch.json");
    touch(".prhero", "prhero.db");
    expect(resolveHomeDir(dir)).toBe(path.join(dir, ".crysk"));
  });
  test("both exist and neither has state: the legacy one (nothing is orphaned)", () => {
    mk(".crysk");
    mk(".prhero");
    expect(resolveHomeDir(dir)).toBe(path.join(dir, ".prhero"));
  });
  test("each state marker counts", () => {
    for (const marker of [
      "prhero.db",
      "metrics.db",
      "config.json",
      "setup.json",
      "watch.json",
      "repos",
    ]) {
      const home = mkdtempSync(path.join(tmpdir(), "crysk-state-"));
      try {
        mkdirSync(path.join(home, ".crysk"));
        mkdirSync(path.join(home, ".prhero"));
        expect(homeHasState(path.join(home, ".crysk"))).toBe(false);
        if (marker === "repos") {
          mkdirSync(path.join(home, ".crysk", marker));
        } else {
          writeFileSync(path.join(home, ".crysk", marker), "x");
        }
        expect(homeHasState(path.join(home, ".crysk"))).toBe(true);
        expect(resolveHomeDir(home)).toBe(path.join(home, ".crysk"));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});

describe("resolveRepoDir", () => {
  test("only the legacy dir exists: legacy", () => {
    mk(".prhero");
    expect(resolveRepoDir(dir)).toBe(path.join(dir, ".prhero"));
  });
  test("only the new dir exists: new", () => {
    mk(".crysk");
    expect(resolveRepoDir(dir)).toBe(path.join(dir, ".crysk"));
  });
  test("neither exists: new", () => {
    expect(resolveRepoDir(dir)).toBe(path.join(dir, ".crysk"));
  });
  test("a .crysk with neither config.json nor gotchas.md does not hide .prhero", () => {
    mk(".crysk");
    touch(".prhero", "config.json");
    expect(resolveRepoDir(dir)).toBe(path.join(dir, ".prhero"));
  });
  test(".crysk with config.json or gotchas.md wins over .prhero", () => {
    touch(".prhero", "config.json");
    touch(".crysk", "gotchas.md");
    expect(resolveRepoDir(dir)).toBe(path.join(dir, ".crysk"));
    expect(repoDirHasState(path.join(dir, ".crysk"))).toBe(true);
  });
});

describe("resolveIgnoreFileName", () => {
  test("only .prheroignore exists", () => {
    writeFileSync(path.join(dir, ".prheroignore"), "x\n");
    expect(resolveIgnoreFileName(dir)).toBe(".prheroignore");
  });
  test("both exist: .cryskignore wins", () => {
    writeFileSync(path.join(dir, ".prheroignore"), "x\n");
    writeFileSync(path.join(dir, ".cryskignore"), "x\n");
    expect(resolveIgnoreFileName(dir)).toBe(".cryskignore");
  });
  test("neither exists: the new name", () => {
    expect(resolveIgnoreFileName(dir)).toBe(".cryskignore");
  });
});
