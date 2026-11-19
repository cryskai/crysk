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
  readdirSync,
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
    // The reason names the real cause, not a missing digest (#423 round 2).
    const kept = result.legacy?.find((l) => l.skill === "pr-hero-pr");
    expect(kept?.reason).toContain("could not be read or removed");
    expect(kept?.reason).not.toContain("no recorded digest");
  });

  test("an unreadable legacy file is reported as unreadable, not edited", async () => {
    const dir = installLegacy("pr-hero-pr", ["SKILL.md"]);
    const skill = path.join(dir, "SKILL.md");
    const result = await syncSkills(env, resolveEngineAssets(), {
      readFile: (p: string) =>
        p === skill
          ? undefined
          : existsSync(p)
            ? readFileSync(p, "utf-8")
            : undefined,
    });
    const kept = result.legacy?.find((l) => l.skill === "pr-hero-pr");
    expect(kept?.status).toBe("kept");
    expect(kept?.reason).toContain("could not be read or removed");
    expect(kept?.reason).not.toContain("edited");
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

  // Every existing install reaches the stub-only layout through this path.
  test("a full install from an earlier version keeps only the stub and edited files", async () => {
    const dir = installLegacy("crysk-loop", [
      "SKILL.md",
      "playbook.md",
      "adjudicator.md",
    ]);
    writeFileSync(path.join(dir, "adjudicator.md"), "my notes\n");

    const result = await reconcile();

    expect(result.errors).toEqual([]);
    expect(existsSync(path.join(dir, "playbook.md"))).toBe(false);
    expect(readFileSync(path.join(dir, "adjudicator.md"), "utf-8")).toBe(
      "my notes\n",
    );
    expect(readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe(
      readFileSync(
        resolveEngineAssets().triageSkillFiles["SKILL.md"] ?? "",
        "utf-8",
      ),
    );
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

// `crysk skills load` serves every other file from the package, so a copy beside
// the stub would only freeze. An earlier version installed them all, and each
// such copy leaves the same way as an old-name dir: by its recorded digest.
describe("sync installs SKILL.md alone", () => {
  const assets = resolveEngineAssets();
  const stub = (name: string) => {
    const files: Record<string, Record<string, string>> = {
      "crysk-loop": assets.triageSkillFiles,
      "crysk-ci-setup": assets.ciSetupSkillFiles,
      "crysk-pr": assets.prSkillFiles,
      crysk: assets.generalSkillFiles,
    };
    return readFileSync(files[name]?.["SKILL.md"] ?? "", "utf-8");
  };
  const digestOf = (name: string): { files: Record<string, string> } =>
    JSON.parse(
      readFileSync(path.join(skillsDir, name, "digest.json"), "utf-8"),
    );
  const onDisk = (name: string, file: string) =>
    existsSync(path.join(skillsDir, name, file));

  // The previous install, with its stub already equal to the bundled one: the
  // usual upgrade, where sync has no skill file to write.
  function installWithCurrentStub(name: string, companions: string[]) {
    const dir = installLegacy(name, ["SKILL.md", ...companions]);
    writeFileSync(path.join(dir, "SKILL.md"), stub(name));
    const digest = digestOf(name);
    digest.files["SKILL.md"] = sha(stub(name));
    writeFileSync(path.join(dir, "digest.json"), JSON.stringify(digest));
    return dir;
  }

  test("a fresh install writes the stub and its digest, nothing else", async () => {
    const result = await syncSkills(env, assets);

    expect(result.errors).toEqual([]);
    expect(result.synced).toEqual(NEW_NAMES.map(() => "SKILL.md"));
    expect(result.companions).toBeUndefined();
    for (const name of NEW_NAMES) {
      expect(readdirSync(path.join(skillsDir, name)).sort()).toEqual([
        "SKILL.md",
        "digest.json",
      ]);
      expect(Object.keys(digestOf(name).files)).toEqual(["SKILL.md"]);
    }
    const status = inspectSkillsSync(env, assets);
    expect(status).toEqual({
      synced: true,
      drift: false,
      legacy: [],
      companions: [],
    });
    // What load serves is untouched by what install writes.
    expect(Object.keys(assets.triageSkillFiles)).toContain("playbook.md");
    expect(Object.keys(assets.ciSetupSkillFiles)).toContain(
      "references/ci-admission.md",
    );
  });

  test("unedited companions go when the stub is updated, emptied dirs too", async () => {
    const dir = installLegacy("crysk-ci-setup", [
      "SKILL.md",
      "playbook.md",
      "assets/workflow.yml",
      "references/ci-admission.md",
    ]);

    const result = await syncSkills(env, assets);

    expect(result.errors).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["SKILL.md", "digest.json"]);
    expect(readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe(
      stub("crysk-ci-setup"),
    );
    expect(Object.keys(digestOf("crysk-ci-setup").files)).toEqual(["SKILL.md"]);
    expect(result.companions).toEqual([
      { skill: "crysk-ci-setup", file: "playbook.md", status: "removed" },
      {
        skill: "crysk-ci-setup",
        file: "assets/workflow.yml",
        status: "removed",
      },
      {
        skill: "crysk-ci-setup",
        file: "references/ci-admission.md",
        status: "removed",
      },
    ]);
  });

  test("unedited companions go when the stub is already current", async () => {
    installWithCurrentStub("crysk-loop", ["playbook.md", "adjudicator.md"]);

    const result = await syncSkills(env, assets);

    expect(onDisk("crysk-loop", "playbook.md")).toBe(false);
    expect(onDisk("crysk-loop", "adjudicator.md")).toBe(false);
    expect(Object.keys(digestOf("crysk-loop").files)).toEqual(["SKILL.md"]);
    expect(result.skills.find((s) => s.skill === "crysk-loop")?.status).toBe(
      "current",
    );

    const again = await syncSkills(env, assets);
    expect(again.upToDate).toBe(true);
    expect(again.companions).toBeUndefined();
    expect(inspectSkillsSync(env, assets).companions).toEqual([]);
  });

  // force is what every upgrade passes: it replaces stubs, never the user's notes.
  for (const force of [false, true]) {
    test(`an edited companion is kept and reported (force: ${force})`, async () => {
      const dir = installLegacy("crysk-loop", ["SKILL.md", "playbook.md"]);
      const recorded = digestOf("crysk-loop").files["playbook.md"];
      writeFileSync(path.join(dir, "playbook.md"), "my notes\n");

      const result = await syncSkills(env, assets, { force });

      expect(readFileSync(path.join(dir, "playbook.md"), "utf-8")).toBe(
        "my notes\n",
      );
      // The stub does not read the file, so it never holds the stub back.
      expect(readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe(
        stub("crysk-loop"),
      );
      expect(result.driftDetected).toBeUndefined();
      expect(result.errors).toEqual([]);
      expect(result.companions).toEqual([
        {
          skill: "crysk-loop",
          file: "playbook.md",
          status: "kept",
          reason: "edited since it was installed",
        },
      ]);
      // Never recorded over the user's bytes, so restoring the file lets it go.
      expect(digestOf("crysk-loop").files["playbook.md"]).toBe(recorded);
      const status = inspectSkillsSync(env, assets);
      expect(status.synced).toBe(true);
      expect(status.companions).toEqual(["crysk-loop/playbook.md"]);

      const again = await syncSkills(env, assets, { force });
      expect(again.companions?.map((c) => c.status)).toEqual(["kept"]);
      expect(again.synced).toEqual([]);
    });
  }

  test("a kept stub keeps its companions: it may still point at them", async () => {
    const dir = installLegacy("crysk-loop", ["SKILL.md", "playbook.md"]);
    writeFileSync(path.join(dir, "SKILL.md"), "my stub\n");
    const before = readFileSync(path.join(dir, "digest.json"), "utf-8");

    const result = await syncSkills(env, assets);

    expect(result.driftDetected).toBe(true);
    expect(onDisk("crysk-loop", "playbook.md")).toBe(true);
    expect(readFileSync(path.join(dir, "digest.json"), "utf-8")).toBe(before);
    expect(result.companions).toBeUndefined();
  });

  test("a file the digest never recorded is left alone and unreported", async () => {
    await syncSkills(env, assets);
    writeFileSync(path.join(skillsDir, "crysk-loop", "notes.md"), "mine\n");

    const result = await syncSkills(env, assets);

    expect(onDisk("crysk-loop", "notes.md")).toBe(true);
    expect(result.companions).toBeUndefined();
    expect(result.upToDate).toBe(true);
    expect(inspectSkillsSync(env, assets).companions).toEqual([]);
  });

  test("a digest entry outside the skill dir is never followed", async () => {
    const outside = path.join(skillsDir, "outside.md");
    writeFileSync(outside, "outside\n");
    const dir = installWithCurrentStub("crysk-loop", []);
    const digest = digestOf("crysk-loop");
    digest.files["../outside.md"] = sha("outside\n");
    writeFileSync(path.join(dir, "digest.json"), JSON.stringify(digest));

    const result = await syncSkills(env, assets);

    expect(existsSync(outside)).toBe(true);
    expect(result.companions).toBeUndefined();
    expect(inspectSkillsSync(env, assets).companions).toEqual([]);
  });

  test("a companion that could not be removed keeps its digest for a retry", async () => {
    installWithCurrentStub("crysk-loop", ["playbook.md"]);

    const failed = await syncSkills(env, assets, {
      unlink: () => {
        throw new Error("EPERM");
      },
    });

    expect(onDisk("crysk-loop", "playbook.md")).toBe(true);
    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]).toContain("EPERM");
    expect(failed.companions).toEqual([
      {
        skill: "crysk-loop",
        file: "playbook.md",
        status: "kept",
        reason: "could not be read or removed (digest kept for a retry)",
      },
    ]);
    expect(Object.keys(digestOf("crysk-loop").files)).toContain("playbook.md");

    const retried = await syncSkills(env, assets);
    expect(retried.errors).toEqual([]);
    expect(onDisk("crysk-loop", "playbook.md")).toBe(false);
  });

  test("removeSkills still reports a companion sync kept", async () => {
    const dir = installLegacy("crysk-loop", ["SKILL.md", "playbook.md"]);
    writeFileSync(path.join(dir, "playbook.md"), "my notes\n");
    await syncSkills(env, assets);

    const removed = await removeSkills(env);

    expect(removed.skippedModified).toEqual(["playbook.md"]);
    expect(onDisk("crysk-loop", "SKILL.md")).toBe(false);
    expect(onDisk("crysk-loop", "playbook.md")).toBe(true);
  });
});
