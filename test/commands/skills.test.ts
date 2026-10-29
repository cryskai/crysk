// `pr-hero skills install`: the non-interactive twin of the wizard's skills step. Driven through
// injected deps (an in-memory filesystem over a fake HOME), so nothing touches the real ~/.
// The skill sources are the real bundled assets, read through the readFile fallback.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skillsInstallCommand } from "#commands/skills";
import { parseArgs } from "#review/preflight";
import { resolveEngineAssets } from "../../src/assets";

const HOME = "/fake/home";
const SKILL_DIR = `${HOME}/.claude/skills/crysk-loop`;
const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;

function makeDeps(seed: Record<string, string> = {}, dirs: string[] = []) {
  const files = new Map<string, string>(Object.entries(seed));
  const dirSet = new Set<string>(dirs);
  const lines: string[] = [];
  return {
    files,
    lines,
    deps: {
      home: HOME,
      which: () => null,
      exists: (p: string) => files.has(p) || dirSet.has(p),
      readFile: (p: string) => {
        if (files.has(p)) return files.get(p);
        if (p.startsWith(HOME)) return undefined;
        return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
      },
      writeFile: (p: string, c: string) => {
        files.set(p, c);
      },
      log: (line: string) => {
        lines.push(line);
      },
    },
  };
}

const install = (force = false) =>
  parseArgs(force ? ["skills", "install", "--force"] : ["skills", "install"])
    .options;

describe("skillsInstallCommand", () => {
  test("installs the triage skill into the detected Claude Code skills dir", async () => {
    const { files, lines, deps } = makeDeps({}, [`${HOME}/.claude`]);
    const code = await skillsInstallCommand(install(), deps);

    const upstream = readFileSync(
      resolveEngineAssets().triageSkillFiles["SKILL.md"],
      "utf-8",
    );
    expect(code).toBe(0);
    expect(files.get(SKILL_FILE)).toBe(upstream);
    expect(lines.some((l) => l.startsWith("installed "))).toBe(true);
    expect(lines.some((l) => l.includes("Claude Code"))).toBe(true);
  });

  test("a second run reports the skills as up to date", async () => {
    const { lines, deps } = makeDeps({}, [`${HOME}/.claude`]);
    await skillsInstallCommand(install(), deps);
    lines.length = 0;

    const code = await skillsInstallCommand(install(), deps);
    expect(code).toBe(0);
    expect(lines).toEqual(["skills already up to date for Claude Code"]);
  });

  test("a locally edited skill is kept without --force and reported as drift", async () => {
    const { files, lines, deps } = makeDeps({}, [`${HOME}/.claude`]);
    await skillsInstallCommand(install(), deps);
    files.set(SKILL_FILE, "my local edits\n");
    lines.length = 0;

    const code = await skillsInstallCommand(install(), deps);
    expect(code).toBe(1);
    expect(files.get(SKILL_FILE)).toBe("my local edits\n");
    expect(lines).toContain(
      "local edits found in Claude Code's pr-hero skills; rerun with --force to overwrite them",
    );
  });

  test("with --force a locally edited skill is overwritten", async () => {
    const { files, deps } = makeDeps({}, [`${HOME}/.claude`]);
    await skillsInstallCommand(install(), deps);
    files.set(SKILL_FILE, "my local edits\n");

    const code = await skillsInstallCommand(install(true), deps);
    const upstream = readFileSync(
      resolveEngineAssets().triageSkillFiles["SKILL.md"],
      "utf-8",
    );
    expect(code).toBe(0);
    expect(files.get(SKILL_FILE)).toBe(upstream);
  });

  test("no coding agent detected prints the no-agent line and returns 1", async () => {
    const { lines, deps } = makeDeps({}, []);
    const code = await skillsInstallCommand(install(), deps);
    expect(code).toBe(1);
    expect(lines).toEqual([
      "no coding agent with a skills directory was found (Claude Code, Cursor, Windsurf, Codex, Antigravity, OpenCode)",
    ]);
  });

  // The old-name cleanup is real file removal, so these use a real temporary HOME.
  describe("pre-rename skill dirs", () => {
    const sha = (text: string) =>
      crypto.createHash("sha256").update(text).digest("hex");
    let realHome: string;
    beforeEach(() => {
      realHome = mkdtempSync(path.join(tmpdir(), "crysk-skills-cmd-"));
    });
    afterEach(() => {
      rmSync(realHome, { recursive: true, force: true });
    });

    function legacyDir(name: string, content: string, recorded = content) {
      const dir = path.join(realHome, ".claude", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), content);
      writeFileSync(
        path.join(dir, "digest.json"),
        JSON.stringify({ files: { "SKILL.md": sha(recorded) } }),
      );
      return dir;
    }

    test("reports an unedited old copy as removed", async () => {
      const dir = legacyDir("pr-hero-triage", "old\n");
      const lines: string[] = [];
      const code = await skillsInstallCommand(install(), {
        home: realHome,
        which: () => null,
        log: (l) => lines.push(l),
      });

      expect(code).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(lines).toContain(
        "removed the old pr-hero-triage skill from Claude Code",
      );
    });

    test("keeps and reports an edited old copy", async () => {
      const dir = legacyDir("pr-hero-triage", "mine\n", "old\n");
      const lines: string[] = [];
      const code = await skillsInstallCommand(install(), {
        home: realHome,
        which: () => null,
        log: (l) => lines.push(l),
      });

      expect(code).toBe(0);
      expect(readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe("mine\n");
      expect(
        lines.find((l) => l.startsWith("kept the old pr-hero-triage skill")),
      ).toContain("edited SKILL.md kept");
    });
  });
});
