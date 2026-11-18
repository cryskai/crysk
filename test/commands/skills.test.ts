// `pr-hero skills install` / `crysk skills load`: driven through injected
// deps (an in-memory filesystem over a fake HOME), so nothing touches ~/.
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
import {
  isNewerSemver,
  SKILLS_LOAD_CHECK_TTL_MS,
  skillsInstallCommand,
  skillsLoadCommand,
} from "#commands/skills";
import { parseArgs } from "#review/preflight";
import { resolveEngineAssets } from "../../src/assets";
import { CliUsageError } from "../../src/errors";
import type { UpgradeCheckCache } from "../../src/updater";

const HOME = "/fake/home";
const SKILL_DIR = `${HOME}/.claude/skills/crysk-loop`;
const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;
const CACHE_FILE = `${HOME}/.crysk/upgrade-check.json`;

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
      resolveEngineAssets().triageSkillFiles["SKILL.md"] ?? "",
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
      "local edits found in Claude Code's crysk skills; rerun with --force to overwrite them",
    );
  });

  test("with --force a locally edited skill is overwritten", async () => {
    const { files, deps } = makeDeps({}, [`${HOME}/.claude`]);
    await skillsInstallCommand(install(), deps);
    files.set(SKILL_FILE, "my local edits\n");

    const code = await skillsInstallCommand(install(true), deps);
    const upstream = readFileSync(
      resolveEngineAssets().triageSkillFiles["SKILL.md"] ?? "",
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

describe("skillsLoadCommand", () => {
  test("prints playbook.md for every shipped skill to stdout without network or disk writes", async () => {
    const assets = resolveEngineAssets();
    const cases: Array<[string, string]> = [
      ["crysk", assets.generalSkillFiles["playbook.md"] ?? ""],
      ["crysk-loop", assets.triageSkillFiles["playbook.md"] ?? ""],
      ["crysk-pr", assets.prSkillFiles["playbook.md"] ?? ""],
      ["crysk-ci-setup", assets.ciSetupSkillFiles["playbook.md"] ?? ""],
    ];
    for (const [skillName, expectedPath] of cases) {
      const out: string[] = [];
      const code = await skillsLoadCommand(
        parseArgs(["skills", "load", skillName]).options,
        {
          assets,
          env: { CRYSK_SKILLS_DELEGATED: "1" },
          writeStdout: (text) => out.push(text),
        },
      );
      const raw = readFileSync(expectedPath, "utf-8");
      const expected = raw.endsWith("\n") ? raw : `${raw}\n`;
      expect(code).toBe(0);
      expect(out.join("")).toBe(expected);
    }
  });

  test("prints companion files (adjudicator.md, references/*, assets/*) on demand", async () => {
    const assets = resolveEngineAssets();
    const cases: Array<[string, string, string]> = [
      [
        "crysk-loop",
        "adjudicator.md",
        assets.triageSkillFiles["adjudicator.md"] ?? "",
      ],
      [
        "crysk-ci-setup",
        "assets/workflow.yml",
        assets.ciSetupSkillFiles["assets/workflow.yml"] ?? "",
      ],
      [
        "crysk-ci-setup",
        "assets/admission-config.example.json",
        assets.ciSetupSkillFiles["assets/admission-config.example.json"] ?? "",
      ],
      [
        "crysk-ci-setup",
        "references/opencode-ci.md",
        assets.ciSetupSkillFiles["references/opencode-ci.md"] ?? "",
      ],
      [
        "crysk-ci-setup",
        "references/ci-admission.md",
        assets.ciSetupSkillFiles["references/ci-admission.md"] ?? "",
      ],
    ];
    for (const [skillName, fileName, expectedPath] of cases) {
      const out: string[] = [];
      const code = await skillsLoadCommand(
        parseArgs(["skills", "load", skillName, fileName]).options,
        {
          assets,
          env: { CRYSK_SKILLS_DELEGATED: "1" },
          writeStdout: (text) => out.push(text),
        },
      );
      const raw = readFileSync(expectedPath, "utf-8");
      const expected = raw.endsWith("\n") ? raw : `${raw}\n`;
      expect(code).toBe(0);
      expect(out.join("")).toBe(expected);
    }
  });

  test("rejects unknown skill names, unknown companion files, and prototype keys", async () => {
    const env = { CRYSK_SKILLS_DELEGATED: "1" };
    await expect(
      skillsLoadCommand(parseArgs(["skills", "load", "nonexistent"]).options, {
        env,
      }),
    ).rejects.toThrow(CliUsageError);
    await expect(
      skillsLoadCommand(
        parseArgs(["skills", "load", "crysk-loop", "missing.md"]).options,
        { env },
      ),
    ).rejects.toThrow(CliUsageError);
    await expect(
      skillsLoadCommand(
        parseArgs(["skills", "load", "crysk-loop", "toString"]).options,
        { env },
      ),
    ).rejects.toThrow(CliUsageError);
  });

  describe("1h upgrade-check TTL cache and auto-delegation", () => {
    const nowMs = Date.parse("2026-11-18T12:00:00.000Z");

    test("isNewerSemver compares major.minor.patch strictly", () => {
      expect(isNewerSemver("0.10.0", "0.9.0")).toBe(true);
      expect(isNewerSemver("1.0.0", "0.9.9")).toBe(true);
      expect(isNewerSemver("0.9.1", "0.9.0")).toBe(true);
      expect(isNewerSemver("0.9.0", "0.9.0")).toBe(false);
      expect(isNewerSemver("0.8.9", "0.9.0")).toBe(false);
      expect(isNewerSemver("0.10.0-rc.1", "0.9.0")).toBe(false);
    });

    test("fresh cache hit within 1h TTL skips network fetch and serves local playbook", async () => {
      const assets = resolveEngineAssets();
      const freshCache: UpgradeCheckCache = {
        checked_at: new Date(nowMs - 10 * 60 * 1000).toISOString(),
        current_version: assets.version,
        latest_version: assets.version,
      };
      const { deps } = makeDeps({
        [CACHE_FILE]: JSON.stringify(freshCache),
      });
      let fetchCalls = 0;
      const out: string[] = [];

      const code = await skillsLoadCommand(
        parseArgs(["skills", "load", "crysk-loop"]).options,
        {
          ...deps,
          assets,
          nowMs,
          env: {},
          fetchLatestVersion: async () => {
            fetchCalls += 1;
            return "9.9.9";
          },
          writeStdout: (t) => out.push(t),
        },
      );

      expect(code).toBe(0);
      expect(fetchCalls).toBe(0);
      const expected = readFileSync(
        assets.triageSkillFiles["playbook.md"] ?? "",
        "utf-8",
      );
      expect(out.join("")).toBe(expected);
    });

    test("expired cache (>1h) fetches latest, updates cache timestamp, and serves local when unchanged", async () => {
      const assets = resolveEngineAssets();
      const staleCache: UpgradeCheckCache = {
        checked_at: new Date(
          nowMs - SKILLS_LOAD_CHECK_TTL_MS - 1000,
        ).toISOString(),
        current_version: assets.version,
        latest_version: assets.version,
      };
      const { files, deps } = makeDeps({
        [CACHE_FILE]: JSON.stringify(staleCache),
      });
      let fetchCalls = 0;
      let delegateCalls = 0;
      const out: string[] = [];

      const code = await skillsLoadCommand(
        parseArgs(["skills", "load", "crysk-pr"]).options,
        {
          ...deps,
          assets,
          nowMs,
          env: {},
          fetchLatestVersion: async () => {
            fetchCalls += 1;
            return assets.version;
          },
          delegateToVersion: async () => {
            delegateCalls += 1;
            return "delegated";
          },
          writeStdout: (t) => out.push(t),
        },
      );

      expect(code).toBe(0);
      expect(fetchCalls).toBe(1);
      expect(delegateCalls).toBe(0);
      const updated = JSON.parse(
        files.get(CACHE_FILE) ?? "{}",
      ) as UpgradeCheckCache;
      expect(updated.checked_at).toBe(new Date(nowMs).toISOString());
      expect(updated.latest_version).toBe(assets.version);
      const expected = readFileSync(
        assets.prSkillFiles["playbook.md"] ?? "",
        "utf-8",
      );
      expect(out.join("")).toBe(expected);
    });

    test("newer version delegates, prints delegated stdout, and records reconciled_version", async () => {
      const assets = resolveEngineAssets();
      const { files, deps } = makeDeps();
      const delegatedArgs: Array<[string, string, string | undefined]> = [];
      const out: string[] = [];

      const code = await skillsLoadCommand(
        parseArgs(["skills", "load", "crysk-ci-setup", "assets/workflow.yml"])
          .options,
        {
          ...deps,
          assets,
          nowMs,
          env: {},
          fetchLatestVersion: async () => "0.99.0",
          delegateToVersion: async (version, skill, file) => {
            delegatedArgs.push([version, skill, file]);
            return "# new workflow from 0.99.0";
          },
          writeStdout: (t) => out.push(t),
        },
      );

      expect(code).toBe(0);
      expect(delegatedArgs).toEqual([
        ["0.99.0", "crysk-ci-setup", "assets/workflow.yml"],
      ]);
      expect(out.join("")).toBe("# new workflow from 0.99.0\n");
      const saved = JSON.parse(
        files.get(CACHE_FILE) ?? "{}",
      ) as UpgradeCheckCache;
      expect(saved.latest_version).toBe("0.99.0");
      expect(saved.reconciled_version).toBe("0.99.0");
    });

    test("falls back cleanly to local bundled asset when delegation fails", async () => {
      const assets = resolveEngineAssets();
      const { files, deps } = makeDeps();
      const out: string[] = [];

      const code = await skillsLoadCommand(
        parseArgs(["skills", "load", "crysk"]).options,
        {
          ...deps,
          assets,
          nowMs,
          env: {},
          fetchLatestVersion: async () => "0.99.0",
          delegateToVersion: async () => undefined,
          writeStdout: (t) => out.push(t),
        },
      );

      expect(code).toBe(0);
      const expected = readFileSync(
        assets.generalSkillFiles["playbook.md"] ?? "",
        "utf-8",
      );
      expect(out.join("")).toBe(expected);
      const saved = JSON.parse(
        files.get(CACHE_FILE) ?? "{}",
      ) as UpgradeCheckCache;
      expect(saved.reconciled_version).toBeUndefined();
    });

    test("CRYSK_SKILLS_DELEGATED=1 bypasses cache check and delegation", async () => {
      const assets = resolveEngineAssets();
      const { deps } = makeDeps();
      let fetchCalls = 0;
      let delegateCalls = 0;
      const out: string[] = [];

      const code = await skillsLoadCommand(
        parseArgs(["skills", "load", "crysk-loop"]).options,
        {
          ...deps,
          assets,
          nowMs,
          env: { CRYSK_SKILLS_DELEGATED: "1" },
          fetchLatestVersion: async () => {
            fetchCalls += 1;
            return "0.99.0";
          },
          delegateToVersion: async () => {
            delegateCalls += 1;
            return "should not run";
          },
          writeStdout: (t) => out.push(t),
        },
      );

      expect(code).toBe(0);
      expect(fetchCalls).toBe(0);
      expect(delegateCalls).toBe(0);
      const expected = readFileSync(
        assets.triageSkillFiles["playbook.md"] ?? "",
        "utf-8",
      );
      expect(out.join("")).toBe(expected);
    });
  });
});
