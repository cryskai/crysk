import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCachedSkillFile,
  readEngineVersion,
  recordEngineVersion,
  writeCachedSkillFile,
} from "../src/skills-cache";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "crysk-skills-cache-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const enginesFile = () => path.join(home, ".crysk", "skills", "engines.json");

describe("engine version per repository", () => {
  test("reads back what status recorded, per repository root", () => {
    recordEngineVersion(home, "/repos/a", "0.10.0");
    recordEngineVersion(home, "/repos/b", "0.8.1");
    expect(readEngineVersion(home, "/repos/a")).toBe("0.10.0");
    expect(readEngineVersion(home, "/repos/b")).toBe("0.8.1");
    expect(readEngineVersion(home, "/repos/c")).toBeUndefined();
  });

  test("a newer review replaces the version, even with a lower one", () => {
    recordEngineVersion(home, "/repos/a", "0.11.0", "2026-11-01T00:00:00Z");
    recordEngineVersion(home, "/repos/a", "0.10.0", "2026-11-02T00:00:00Z");
    expect(readEngineVersion(home, "/repos/a")).toBe("0.10.0");
  });

  // Status can be run on an old pull request: its review says nothing about
  // the engine the repository runs today.
  test("an older review does not replace the version", () => {
    recordEngineVersion(home, "/repos/a", "0.11.0", "2026-11-02T00:00:00Z");
    recordEngineVersion(home, "/repos/a", "0.10.0", "2026-11-01T00:00:00Z");
    expect(readEngineVersion(home, "/repos/a")).toBe("0.11.0");
  });

  test("a review of unknown age fills an empty entry and replaces nothing", () => {
    recordEngineVersion(home, "/repos/a", "0.10.0", null);
    expect(readEngineVersion(home, "/repos/a")).toBe("0.10.0");
    recordEngineVersion(home, "/repos/a", "0.9.0", null);
    expect(readEngineVersion(home, "/repos/a")).toBe("0.10.0");
  });

  test("ignores a version that is not a plain x.y.z, on write and on read", () => {
    recordEngineVersion(home, "/repos/a", "0.10.0; rm -rf /");
    expect(readEngineVersion(home, "/repos/a")).toBeUndefined();
    mkdirSync(path.dirname(enginesFile()), { recursive: true });
    writeFileSync(enginesFile(), JSON.stringify({ "/repos/a": "latest" }));
    expect(readEngineVersion(home, "/repos/a")).toBeUndefined();
  });

  test("a corrupt file reads as empty and the next record repairs it", () => {
    mkdirSync(path.dirname(enginesFile()), { recursive: true });
    writeFileSync(enginesFile(), "{not json");
    expect(readEngineVersion(home, "/repos/a")).toBeUndefined();
    recordEngineVersion(home, "/repos/a", "0.10.0", "2026-11-01T00:00:00Z");
    expect(JSON.parse(readFileSync(enginesFile(), "utf8"))).toEqual({
      "/repos/a": { version: "0.10.0", at: "2026-11-01T00:00:00Z" },
    });
  });

  test("an unwritable home never throws", () => {
    mkdirSync(path.join(home, ".crysk"), { recursive: true });
    chmodSync(path.join(home, ".crysk"), 0o500);
    try {
      expect(() =>
        recordEngineVersion(home, "/repos/a", "0.10.0"),
      ).not.toThrow();
    } finally {
      chmodSync(path.join(home, ".crysk"), 0o700);
    }
  });
});

describe("skill files per version", () => {
  test("reads back a file exactly as it was written", () => {
    writeCachedSkillFile(
      home,
      "0.10.0",
      "crysk-loop",
      "playbook.md",
      "# v10\n",
    );
    expect(
      readCachedSkillFile(home, "0.10.0", "crysk-loop", "playbook.md"),
    ).toBe("# v10\n");
    expect(
      readCachedSkillFile(home, "0.11.0", "crysk-loop", "playbook.md"),
    ).toBeUndefined();
  });

  test("keeps companion files under their nested path", () => {
    writeCachedSkillFile(
      home,
      "0.10.0",
      "crysk-ci-setup",
      "references/opencode-ci.md",
      "ref",
    );
    expect(
      readCachedSkillFile(
        home,
        "0.10.0",
        "crysk-ci-setup",
        "references/opencode-ci.md",
      ),
    ).toBe("ref");
  });

  test("never writes or reads under a version that is not a plain x.y.z", () => {
    writeCachedSkillFile(home, "../escape", "crysk", "playbook.md", "x");
    expect(
      readCachedSkillFile(home, "../escape", "crysk", "playbook.md"),
    ).toBeUndefined();
  });
});

describe("an empty playbook is never a cached one", () => {
  test.each([
    ["an empty", ""],
    ["a blank", " \n\t\n"],
  ])("%s cache file counts as a miss", (_kind, content) => {
    const file = path.join(
      home,
      ".crysk",
      "skills",
      "playbooks",
      "0.42.0",
      "crysk-loop",
      "playbook.md",
    );
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    expect(
      readCachedSkillFile(home, "0.42.0", "crysk-loop", "playbook.md"),
    ).toBeUndefined();
  });

  test("blank content is not written", () => {
    writeCachedSkillFile(home, "0.42.0", "crysk-loop", "playbook.md", "  \n");
    expect(
      existsSync(path.join(home, ".crysk", "skills", "playbooks", "0.42.0")),
    ).toBe(false);
  });
});
