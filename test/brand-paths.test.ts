import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveHomeDir,
  resolveIgnoreFileName,
  resolveRepoDir,
} from "../src/brand-paths";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "crysk-paths-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cases: Array<[string, string[], string]> = [
  ["only the legacy dir exists", [".prhero"], ".prhero"],
  ["only the new dir exists", [".crysk"], ".crysk"],
  ["both exist: the new one wins", [".crysk", ".prhero"], ".crysk"],
  ["neither exists: a fresh install uses the new name", [], ".crysk"],
];

describe("resolveHomeDir", () => {
  for (const [label, present, expected] of cases) {
    test(label, () => {
      for (const name of present) mkdirSync(path.join(dir, name));
      expect(resolveHomeDir(dir)).toBe(path.join(dir, expected));
    });
  }
});

describe("resolveRepoDir", () => {
  for (const [label, present, expected] of cases) {
    test(label, () => {
      for (const name of present) mkdirSync(path.join(dir, name));
      expect(resolveRepoDir(dir)).toBe(path.join(dir, expected));
    });
  }
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
