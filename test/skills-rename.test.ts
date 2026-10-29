// The skills renamed with the product (pr-hero → crysk, pr-hero-triage →
// crysk-loop, ...). An install made under the old names must upgrade cleanly:
// the new dirs are written, the old ones removed by their recorded digest, and
// a file the user edited is never deleted. Every test runs on a real temporary
// HOME, through the public sync / reconcile / uninstall / inspect entry points.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentEnvDetection,
  inspectSkillsSync,
  removeSkills,
  syncSkills,
} from "../src/agent-env";
import { resolveEngineAssets } from "../src/assets";
import { executeUninstallPlan, planUninstallation } from "../src/uninstaller";
import { reconcileUpgrade } from "../src/updater";

const NEW_NAMES = ["crysk-loop", "crysk-ci-setup", "crysk-pr", "crysk"];
const LEGACY_NAMES = [
  "pr-hero-triage",
  "pr-hero-ci-setup",
  "pr-hero-pr",
  "pr-hero",
];

let home: string;
let skillsDir: string;
let env: AgentEnvDetection;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "crysk-skills-rename-"));
  skillsDir = path.join(home, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  env = {
    id: "claude",
    displayName: "Claude Code",
    status: "active",
    binaryFound: false,
    auth: { authenticated: true, message: "ok" },
    skillsDir,
    mcpConfigFile: path.join(home, ".claude", "mcp.json"),
  };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const sha = (text: string) =>
  crypto.createHash("sha256").update(text).digest("hex");

// An install the way the previous version left it: the files plus the
// digest.json that sync recorded, so each file reads as untouched.
function installLegacy(name: string, files = ["SKILL.md"]): string {
  const dir = path.join(skillsDir, name);
  const digest: Record<string, string> = {};
  for (const file of files) {
    const content = `old ${name}/${file}\n`;
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
    digest[file] = sha(content);
  }
  writeFileSync(
    path.join(dir, "digest.json"),
    JSON.stringify({ files: digest }),
  );
  return dir;
}

const installAllLegacy = () => {
  for (const name of LEGACY_NAMES) installLegacy(name);
};

const present = (name: string) => existsSync(path.join(skillsDir, name));

describe("sync installs the renamed skills", () => {
  test("a fresh home gets the four new names and no old one", async () => {
    const result = await syncSkills(env, resolveEngineAssets());

    expect(result.errors).toEqual([]);
    expect(result.skills.map((s) => s.skill)).toEqual(NEW_NAMES);
    for (const name of NEW_NAMES) {
      expect(present(name)).toBe(true);
      expect(existsSync(path.join(skillsDir, name, "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(skillsDir, name, "digest.json"))).toBe(true);
    }
    for (const name of LEGACY_NAMES) expect(present(name)).toBe(false);
    expect(result.legacy).toBeUndefined();
  });

  test("each installed skill declares the name of its directory", async () => {
    await syncSkills(env, resolveEngineAssets());

    for (const name of NEW_NAMES) {
      const body = readFileSync(
        path.join(skillsDir, name, "SKILL.md"),
        "utf-8",
      );
      expect(body).toMatch(new RegExp(`^name: ${name}$`, "m"));
    }
  });

  test("crysk-loop still triggers on a request to triage findings", () => {
    const body = readFileSync(
      path.join(import.meta.dir, "..", "skills", "crysk-loop", "SKILL.md"),
      "utf-8",
    );
    const description = body.match(/^description: (.*)$/m)?.[1] ?? "";
    expect(description).toContain("triage");
    expect(description).toContain("crysk-loop");
  });
});

describe("sync removes the old-name dirs", () => {
  test("a legacy-only install upgrades cleanly to the new names", async () => {
    installAllLegacy();

    const result = await syncSkills(env, resolveEngineAssets());

    expect(result.errors).toEqual([]);
    for (const name of NEW_NAMES) expect(present(name)).toBe(true);
    for (const name of LEGACY_NAMES) expect(present(name)).toBe(false);
    expect(result.legacy?.map((l) => [l.skill, l.status])).toEqual(
      LEGACY_NAMES.map((name) => [name, "removed"]),
    );
  });

  // All or nothing: deleting the untouched files of an edited legacy skill leaves a
  // SKILL.md that points at files that are gone, beside the new copy (#423 F002).
  test("an edited legacy dir is left whole and reported", async () => {
    const dir = installLegacy("pr-hero-ci-setup", [
      "SKILL.md",
      "assets/workflow.yml",
    ]);
    writeFileSync(path.join(dir, "SKILL.md"), "my own notes\n");

    const result = await syncSkills(env, resolveEngineAssets());

    expect(readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe(
      "my own notes\n",
    );
    expect(existsSync(path.join(dir, "assets", "workflow.yml"))).toBe(true);
    expect(existsSync(path.join(dir, "digest.json"))).toBe(true);
    const kept = result.legacy?.find((l) => l.skill === "pr-hero-ci-setup");
    expect(kept?.status).toBe("kept");
    expect(kept?.reason).toContain("SKILL.md");
    expect(present("crysk-ci-setup")).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // The digest is the only record that makes a leftover provably removable, so it
  // stays while any recorded file is still on disk (#423 F001).
  test("a recorded file that could not be removed keeps the digest", async () => {
    const dir = installLegacy("pr-hero-pr", ["SKILL.md"]);
    const result = await syncSkills(env, resolveEngineAssets(), {
      unlink: (p: string) => {
        if (p.endsWith("SKILL.md")) throw new Error("EACCES");
        unlinkSync(p);
      },
    });
    expect(existsSync(path.join(dir, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(dir, "digest.json"))).toBe(true);
    expect(result.errors.join("\n")).toContain("EACCES");
  });

  test("a legacy dir with no recorded digest is left alone and reported", async () => {
    const dir = path.join(skillsDir, "pr-hero-pr");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "never synced\n");

    const result = await syncSkills(env, resolveEngineAssets());

    expect(readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe(
      "never synced\n",
    );
    expect(result.legacy?.[0]).toMatchObject({
      skill: "pr-hero-pr",
      status: "kept",
    });
  });

  test("a legacy dir stays while its replacement was not installed", async () => {
    installLegacy("pr-hero-triage");
    // The user edited crysk-loop before: sync keeps it, so it is not a working
    // replacement yet and the old copy must keep serving.
    const edited = installLegacy("crysk-loop");
    writeFileSync(path.join(edited, "SKILL.md"), "edited by the user\n");

    const result = await syncSkills(env, resolveEngineAssets());

    expect(result.skills.find((s) => s.skill === "crysk-loop")?.status).toBe(
      "drift-kept",
    );
    expect(present("pr-hero-triage")).toBe(true);
    expect(result.legacy).toBeUndefined();
  });

  test("a second sync is a no-op once the old dirs are gone", async () => {
    installAllLegacy();
    await syncSkills(env, resolveEngineAssets());

    const again = await syncSkills(env, resolveEngineAssets());

    expect(again.upToDate).toBe(true);
    expect(again.legacy).toBeUndefined();
  });
});

describe("reconcile (upgrade) removes the old-name dirs", () => {
  async function reconcile() {
    return reconcileUpgrade({
      home,
      verifyMcp: async () => ({ ok: true }),
      migrateStore: async () => ({ ok: true }),
      reloadDaemons: async () => ({ reloaded: [] }),
      runDoctorCheck: async () => ({ overall: "healthy" }),
      which: () => null,
      spawnInstaller: async () => {
        throw new Error("spawn should not run");
      },
    });
  }

  test("unedited legacy dirs are removed and the new ones installed", async () => {
    installAllLegacy();

    const result = await reconcile();

    expect(result.errors).toEqual([]);
    for (const name of NEW_NAMES) expect(present(name)).toBe(true);
    for (const name of LEGACY_NAMES) expect(present(name)).toBe(false);
  });

  test("an edited legacy file survives the reconcile", async () => {
    const dir = installLegacy("pr-hero-triage");
    writeFileSync(path.join(dir, "SKILL.md"), "my own notes\n");

    await reconcile();

    expect(readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe(
      "my own notes\n",
    );
    expect(present("crysk-loop")).toBe(true);
  });
});

describe("removeSkills", () => {
  test("covers the new and the legacy names", async () => {
    await syncSkills(env, resolveEngineAssets());
    installAllLegacy();

    const result = await removeSkills(env);

    expect(result.errors).toEqual([]);
    expect(result.skippedModified).toEqual([]);
    for (const name of [...NEW_NAMES, ...LEGACY_NAMES]) {
      expect(present(name)).toBe(false);
    }
  });
});

describe("uninstall removes both name sets, never an edited file", () => {
  async function uninstall() {
    const exists = (p: string) => existsSync(p);
    const plan = await planUninstallation({
      home,
      platform: "linux",
      installMethod: { kind: "source" },
      exists,
    });
    const result = await executeUninstallPlan(plan, { home });
    return { plan, result };
  }

  test("plans a step for every present dir of either name", async () => {
    await syncSkills(env, resolveEngineAssets());
    installAllLegacy();

    const { plan } = await uninstall();

    for (const name of [...NEW_NAMES, ...LEGACY_NAMES]) {
      expect(plan.agentEnvCleanups).toContain(`Claude Code Skill: ${name}`);
    }
  });

  test("removes untouched dirs of both generations", async () => {
    await syncSkills(env, resolveEngineAssets());
    installAllLegacy();

    const { result } = await uninstall();

    expect(result.errors).toEqual([]);
    for (const name of [...NEW_NAMES, ...LEGACY_NAMES]) {
      expect(present(name)).toBe(false);
    }
  });

  // An uninstall the user asked for removes both generations whole, as it always has.
  test("removes current and legacy skill dirs whole, edited files included", async () => {
    await syncSkills(env, resolveEngineAssets());
    installAllLegacy();
    writeFileSync(
      path.join(skillsDir, "crysk-pr", "SKILL.md"),
      "edited current\n",
    );
    writeFileSync(
      path.join(skillsDir, "pr-hero-pr", "SKILL.md"),
      "edited legacy\n",
    );

    const { result } = await uninstall();

    expect(present("crysk-pr")).toBe(false);
    expect(present("pr-hero-pr")).toBe(false);
    expect(present("crysk-loop")).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe("inspectSkillsSync reports a leftover legacy dir", () => {
  test("names each old-name dir still on disk", async () => {
    await syncSkills(env, resolveEngineAssets());
    expect(inspectSkillsSync(env, resolveEngineAssets()).legacy).toEqual([]);

    installLegacy("pr-hero-triage");
    installLegacy("pr-hero");

    const status = inspectSkillsSync(env, resolveEngineAssets());
    expect(status.legacy).toEqual(["pr-hero-triage", "pr-hero"]);
    // A leftover does not make the new copies read as unsynced.
    expect(status.synced).toBe(true);
  });

  test("an edited legacy dir that sync kept is still reported", async () => {
    const dir = installLegacy("pr-hero-pr");
    writeFileSync(path.join(dir, "SKILL.md"), "mine\n");
    await syncSkills(env, resolveEngineAssets());

    expect(inspectSkillsSync(env, resolveEngineAssets()).legacy).toEqual([
      "pr-hero-pr",
    ]);
  });
});
