import { describe, expect, test } from "bun:test";
import {
  type AgentEnvDetection,
  detectAgentEnvironments,
  inspectMcpRegistration,
  inspectSkillsSync,
  registerMcpServer,
  syncSkills,
} from "../src/agent-env";
import {
  NPX_REGISTRATION_REFUSED,
  resolveEngineAssets,
  selfInvocation,
} from "../src/assets";

describe("Agent environment detector and sync", () => {
  const fakeAssets = {
    ...resolveEngineAssets(),
    triageSkillFiles: {
      "SKILL.md": "/abs/skills/pr-hero-triage/SKILL.md",
      "adjudicator.md": "/abs/skills/pr-hero-triage/adjudicator.md",
    },
    ciSetupSkillFiles: {},
    generalSkillFiles: {},
  };

  describe("detectAgentEnvironments", () => {
    test("detects multiple environments concurrently without collision", async () => {
      const detected = await detectAgentEnvironments({
        home: "/home/user",
        exists: (p) => {
          if (p.includes(".claude")) return true;
          if (p.includes(".cursor")) return true;
          if (p.includes(".gemini")) return true;
          return false;
        },
        which: (bin) => {
          if (bin === "claude") return "/usr/local/bin/claude";
          if (bin === "cursor") return "/usr/local/bin/cursor";
          return null;
        },
      });

      const claude = detected.find((d) => d.id === "claude");
      expect(claude).toBeDefined();
      expect(claude?.binaryFound || claude?.status === "active").toBe(true);
      expect(claude?.skillsDir).toBeDefined();

      const cursor = detected.find((d) => d.id === "cursor");
      expect(cursor).toBeDefined();
      expect(cursor?.binaryFound || cursor?.status === "active").toBe(true);

      const antigravity = detected.find((d) => d.id === "antigravity");
      expect(antigravity).toBeDefined();
      expect(antigravity?.status).toBe("active");
    });
  });

  describe("skills digest & sync", () => {
    test("syncSkills writes files and digest.json on first sync", async () => {
      const written: Record<string, string> = {};
      const env: AgentEnvDetection = {
        id: "claude",
        displayName: "Claude Code",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        skillsDir: "/home/user/.claude/skills",
      };

      const result = await syncSkills(env, fakeAssets, {
        readFile: (p) => {
          if (p.endsWith("SKILL.md")) return "content of SKILL.md";
          if (p.endsWith("adjudicator.md")) return "content of adjudicator.md";
          return written[p];
        },
        writeFile: async (p, content) => {
          written[p] = content;
        },
        exists: (p) => Boolean(written[p]),
      });

      expect(result.synced).toEqual(["SKILL.md", "adjudicator.md"]);
      expect(written["/home/user/.claude/skills/pr-hero-triage/SKILL.md"]).toBe(
        "content of SKILL.md",
      );
      expect(
        written["/home/user/.claude/skills/pr-hero-triage/adjudicator.md"],
      ).toBe("content of adjudicator.md");
      expect(
        written["/home/user/.claude/skills/pr-hero-triage/digest.json"],
      ).toBeDefined();

      // Second sync is a no-op when digest matches
      const secondResult = await syncSkills(env, fakeAssets, {
        readFile: (p) => {
          if (p.endsWith("SKILL.md")) return "content of SKILL.md";
          if (p.endsWith("adjudicator.md")) return "content of adjudicator.md";
          return written[p];
        },
        writeFile: async (p, content) => {
          written[p] = content;
        },
        exists: (p) => Boolean(written[p]),
      });

      expect(secondResult.synced).toEqual([]);
      expect(secondResult.upToDate).toBe(true);
    });

    test("manual user edit triggers drift protection unless force: true", async () => {
      const written: Record<string, string> = {
        "/home/user/.claude/skills/pr-hero-triage/SKILL.md":
          "user modified content",
        "/home/user/.claude/skills/pr-hero-triage/adjudicator.md":
          "content of adjudicator.md",
        "/home/user/.claude/skills/pr-hero-triage/digest.json": JSON.stringify({
          files: {
            "SKILL.md": "original_hash",
            "adjudicator.md": "content_hash",
          },
          engine_version: "1.0.0",
        }),
      };

      const env: AgentEnvDetection = {
        id: "claude",
        displayName: "Claude Code",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        skillsDir: "/home/user/.claude/skills",
      };

      // Without force: drift detected, skipped
      const resultNoForce = await syncSkills(env, fakeAssets, {
        readFile: (p) => {
          if (p === fakeAssets.triageSkillFiles["SKILL.md"])
            return "new upstream content";
          if (p === fakeAssets.triageSkillFiles["adjudicator.md"])
            return "content of adjudicator.md";
          return written[p];
        },
        writeFile: async (p, content) => {
          written[p] = content;
        },
        exists: (p) => Boolean(written[p]),
      });

      expect(resultNoForce.driftDetected).toBe(true);
      expect(resultNoForce.synced).toEqual([]);

      // With force: overwrites
      const resultForce = await syncSkills(env, fakeAssets, {
        force: true,
        readFile: (p) => {
          if (p === fakeAssets.triageSkillFiles["SKILL.md"])
            return "new upstream content";
          if (p === fakeAssets.triageSkillFiles["adjudicator.md"])
            return "content of adjudicator.md";
          return written[p];
        },
        writeFile: async (p, content) => {
          written[p] = content;
        },
        exists: (p) => Boolean(written[p]),
      });

      expect(resultForce.synced).toEqual(["SKILL.md", "adjudicator.md"]);
      expect(written["/home/user/.claude/skills/pr-hero-triage/SKILL.md"]).toBe(
        "new upstream content",
      );
    });

    test("syncSkills syncs multiple skills (triage and ci-setup)", async () => {
      const written: Record<string, string> = {};
      const env: AgentEnvDetection = {
        id: "claude",
        displayName: "Claude Code",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        skillsDir: "/home/user/.claude/skills",
      };

      const multiSkillAssets = {
        ...fakeAssets,
        ciSetupSkillFiles: {
          "SKILL.md": "/abs/skills/pr-hero-ci-setup/SKILL.md",
          "assets/workflow.yml":
            "/abs/skills/pr-hero-ci-setup/assets/workflow.yml",
        },
      };

      const result = await syncSkills(env, multiSkillAssets, {
        readFile: (p) => {
          if (p === "/abs/skills/pr-hero-triage/SKILL.md")
            return "triage skill content";
          if (p === "/abs/skills/pr-hero-triage/adjudicator.md")
            return "triage adjudicator content";
          if (p === "/abs/skills/pr-hero-ci-setup/SKILL.md")
            return "ci-setup skill content";
          if (p === "/abs/skills/pr-hero-ci-setup/assets/workflow.yml")
            return "ci-setup workflow template content";
          return written[p];
        },
        writeFile: async (p, content) => {
          written[p] = content;
        },
        exists: (p) => Boolean(written[p]),
      });

      expect(result.synced).toEqual([
        "SKILL.md",
        "adjudicator.md",
        "SKILL.md",
        "assets/workflow.yml",
      ]);
      expect(written["/home/user/.claude/skills/pr-hero-triage/SKILL.md"]).toBe(
        "triage skill content",
      );
      expect(
        written["/home/user/.claude/skills/pr-hero-ci-setup/SKILL.md"],
      ).toBe("ci-setup skill content");
      expect(
        written[
          "/home/user/.claude/skills/pr-hero-ci-setup/assets/workflow.yml"
        ],
      ).toBe("ci-setup workflow template content");
    });
  });

  describe("MCP registration", () => {
    test("registerMcpServer adds pr-hero entry without altering existing servers", async () => {
      const initialConfig = JSON.stringify({
        mcpServers: {
          existingServer: {
            command: "npx",
            args: ["-y", "existing"],
          },
        },
      });

      const written: Record<string, string> = {
        "/home/user/.cursor/mcp.json": initialConfig,
      };

      const env: AgentEnvDetection = {
        id: "cursor",
        displayName: "Cursor",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        mcpConfigFile: "/home/user/.cursor/mcp.json",
      };

      const self = selfInvocation();
      const reg = {
        command: self.command,
        args: [...self.args, "mcp"],
      };

      const result = await registerMcpServer(env, reg, {
        readFile: (p) => written[p],
        writeFile: async (p, content) => {
          written[p] = content;
        },
        exists: (p) => Boolean(written[p]),
      });

      expect(result.registered).toBe(true);
      const parsed = JSON.parse(written["/home/user/.cursor/mcp.json"]);
      expect(parsed.mcpServers.existingServer).toBeDefined();
      expect(parsed.mcpServers["pr-hero"]).toEqual({
        command: reg.command,
        args: reg.args,
      });

      // Second registration is idempotent
      const secondResult = await registerMcpServer(env, reg, {
        readFile: (p) => written[p],
        writeFile: async (p, content) => {
          written[p] = content;
        },
        exists: (p) => Boolean(written[p]),
      });

      expect(secondResult.alreadyRegistered).toBe(true);
    });

    test("inspectMcpRegistration returns true when configured, false otherwise", () => {
      const self = selfInvocation();
      const reg = {
        command: self.command,
        args: [...self.args, "mcp"],
      };

      const env: AgentEnvDetection = {
        id: "claude",
        displayName: "Claude Code",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        mcpConfigFile: "/home/user/.claude/mcp.json",
      };

      const notRegistered = inspectMcpRegistration(env, reg, {
        exists: () => false,
      });
      expect(notRegistered).toBe(false);

      const registered = inspectMcpRegistration(env, reg, {
        exists: () => true,
        readFile: () =>
          JSON.stringify({
            mcpServers: {
              "pr-hero": { command: reg.command, args: reg.args },
            },
          }),
      });
      expect(registered).toBe(true);
    });

    test("registerMcpServer refuses an npx-cache registration before any read or write", async () => {
      const env: AgentEnvDetection = {
        id: "cursor",
        displayName: "Cursor",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        mcpConfigFile: "/home/user/.cursor/mcp.json",
      };
      const reg = {
        command: "/home/x/.npm/_npx/ab12/node_modules/bun/bin/bun",
        args: ["/home/x/.npm/_npx/ab12/node_modules/pr-hero/src/cli.ts", "mcp"],
      };
      let touched = false;
      const result = await registerMcpServer(env, reg, {
        readFile: () => {
          touched = true;
          return undefined;
        },
        writeFile: async () => {
          touched = true;
        },
      });
      expect(result).toEqual({
        registered: false,
        configFile: "/home/user/.cursor/mcp.json",
        error: NPX_REGISTRATION_REFUSED,
      });
      expect(touched).toBe(false);
    });
  });

  describe("skills sync decision table (digest-less and digest-recorded copies)", () => {
    const skillDir = "/home/user/.claude/skills/pr-hero-triage";
    const bundled: Record<string, string> = {
      "/abs/skills/pr-hero-triage/SKILL.md": "bundled SKILL.md",
      "/abs/skills/pr-hero-triage/adjudicator.md": "bundled adjudicator.md",
      "/abs/skills/pr-hero-ci-setup/SKILL.md": "bundled ci SKILL.md",
      "/abs/skills/pr-hero/SKILL.md": "bundled general SKILL.md",
    };
    const assets = {
      ...fakeAssets,
      triageSkillFiles: {
        "SKILL.md": "/abs/skills/pr-hero-triage/SKILL.md",
        "adjudicator.md": "/abs/skills/pr-hero-triage/adjudicator.md",
      },
      ciSetupSkillFiles: {},
      generalSkillFiles: {},
    };
    const env: AgentEnvDetection = {
      id: "claude",
      displayName: "Claude Code",
      status: "active",
      binaryFound: true,
      auth: { authenticated: true, message: "ok" },
      skillsDir: "/home/user/.claude/skills",
    };

    // A disk the sync reads and writes; `writes` records every path it wrote.
    function fakeDisk(initial: Record<string, string>) {
      const files: Record<string, string> = { ...initial };
      const writes: string[] = [];
      return {
        files,
        writes,
        options: {
          readFile: (p: string) => (p in bundled ? bundled[p] : files[p]),
          writeFile: async (p: string, content: string) => {
            files[p] = content;
            writes.push(p);
          },
          exists: (p: string) => p in files || p in bundled,
        },
      };
    }

    const noDigestReason =
      "local copy differs and has no recorded digest; not overwritten — run `pr-hero upgrade` to replace it with the bundled copy";

    test("no digest + identical bytes: records the digest, writes no skill file, reports current", async () => {
      const disk = fakeDisk({
        [`${skillDir}/SKILL.md`]: "bundled SKILL.md",
        [`${skillDir}/adjudicator.md`]: "bundled adjudicator.md",
      });

      const result = await syncSkills(env, assets, disk.options);

      expect(disk.writes).toEqual([`${skillDir}/digest.json`]);
      expect(disk.files[`${skillDir}/digest.json`]).toBeDefined();
      expect(result.synced).toEqual([]);
      expect(result.driftDetected).toBeFalsy();
      expect(result.skills).toEqual([
        { skill: "pr-hero-triage", status: "current" },
      ]);
    });

    test("no digest + different bytes: not overwritten, not digested, reported as drift-kept with the reason", async () => {
      const disk = fakeDisk({
        [`${skillDir}/SKILL.md`]: "my local edit",
        [`${skillDir}/adjudicator.md`]: "bundled adjudicator.md",
      });

      const result = await syncSkills(env, assets, disk.options);

      expect(disk.writes).toEqual([]);
      expect(disk.files[`${skillDir}/SKILL.md`]).toBe("my local edit");
      expect(result.driftDetected).toBe(true);
      expect(result.synced).toEqual([]);
      expect(result.skills).toEqual([
        {
          skill: "pr-hero-triage",
          status: "drift-kept",
          reason: noDigestReason,
        },
      ]);
    });

    test("no digest + different bytes + force: overwritten and reported as updated", async () => {
      const disk = fakeDisk({
        [`${skillDir}/SKILL.md`]: "my local edit",
        [`${skillDir}/adjudicator.md`]: "bundled adjudicator.md",
      });

      const result = await syncSkills(env, assets, {
        ...disk.options,
        force: true,
      });

      expect(disk.files[`${skillDir}/SKILL.md`]).toBe("bundled SKILL.md");
      expect(result.synced).toEqual(["SKILL.md", "adjudicator.md"]);
      expect(result.driftDetected).toBeFalsy();
      expect(result.skills).toEqual([
        { skill: "pr-hero-triage", status: "updated" },
      ]);
    });

    test("no digest + nothing installed: installs and reports installed", async () => {
      const disk = fakeDisk({});

      const result = await syncSkills(env, assets, disk.options);

      expect(disk.files[`${skillDir}/SKILL.md`]).toBe("bundled SKILL.md");
      expect(result.skills).toEqual([
        { skill: "pr-hero-triage", status: "installed" },
      ]);
    });

    test("recorded digest: an untouched copy is updated, a locally edited one is drift-kept with its digest unchanged", async () => {
      const crypto = await import("node:crypto");
      const sha = (s: string) =>
        crypto.createHash("sha256").update(s).digest("hex");
      const recorded = JSON.stringify({
        files: {
          "SKILL.md": sha("old bundled SKILL.md"),
          "adjudicator.md": sha("bundled adjudicator.md"),
        },
        engine_version: "1.0.0",
      });

      const untouched = fakeDisk({
        [`${skillDir}/SKILL.md`]: "old bundled SKILL.md",
        [`${skillDir}/adjudicator.md`]: "bundled adjudicator.md",
        [`${skillDir}/digest.json`]: recorded,
      });
      const updated = await syncSkills(env, assets, untouched.options);
      expect(untouched.files[`${skillDir}/SKILL.md`]).toBe("bundled SKILL.md");
      expect(updated.skills).toEqual([
        { skill: "pr-hero-triage", status: "updated" },
      ]);

      const edited = fakeDisk({
        [`${skillDir}/SKILL.md`]: "user edit after sync",
        [`${skillDir}/adjudicator.md`]: "bundled adjudicator.md",
        [`${skillDir}/digest.json`]: recorded,
      });
      const kept = await syncSkills(env, assets, edited.options);
      expect(edited.files[`${skillDir}/SKILL.md`]).toBe("user edit after sync");
      expect(edited.writes).toEqual([]);
      expect(kept.driftDetected).toBe(true);
      expect(kept.skills).toEqual([
        {
          skill: "pr-hero-triage",
          status: "drift-kept",
          reason:
            "Local edits detected in " +
            `${skillDir}/SKILL.md. Pass force to overwrite.`,
        },
      ]);
    });

    test("a drift-kept skill does not stop the next skill from installing", async () => {
      const disk = fakeDisk({
        [`${skillDir}/SKILL.md`]: "my local edit",
        [`${skillDir}/adjudicator.md`]: "bundled adjudicator.md",
      });
      const bothSkills = {
        ...assets,
        ciSetupSkillFiles: {
          "SKILL.md": "/abs/skills/pr-hero-ci-setup/SKILL.md",
        },
      };

      const result = await syncSkills(env, bothSkills, disk.options);

      expect(
        disk.files["/home/user/.claude/skills/pr-hero-ci-setup/SKILL.md"],
      ).toBe("bundled ci SKILL.md");
      expect(result.skills).toEqual([
        {
          skill: "pr-hero-triage",
          status: "drift-kept",
          reason: noDigestReason,
        },
        { skill: "pr-hero-ci-setup", status: "installed" },
      ]);
    });

    test("installs the general pr-hero skill beside the triage skill", async () => {
      const disk = fakeDisk({});
      const withGeneral = {
        ...assets,
        generalSkillFiles: {
          "SKILL.md": "/abs/skills/pr-hero/SKILL.md",
        },
      };

      const result = await syncSkills(env, withGeneral, disk.options);

      expect(disk.files["/home/user/.claude/skills/pr-hero/SKILL.md"]).toBe(
        "bundled general SKILL.md",
      );
      expect(
        disk.files["/home/user/.claude/skills/pr-hero/digest.json"],
      ).toBeDefined();
      expect(result.skills).toEqual([
        { skill: "pr-hero-triage", status: "installed" },
        { skill: "pr-hero", status: "installed" },
      ]);
    });
  });

  describe("inspectSkillsSync", () => {
    test("inspectSkillsSync reports drift when a copy differs and has no digest", () => {
      const env: AgentEnvDetection = {
        id: "claude",
        displayName: "Claude Code",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        skillsDir: "/home/user/.claude/skills",
      };
      const disk: Record<string, string> = {
        "/home/user/.claude/skills/pr-hero-triage/SKILL.md": "my local edit",
        "/home/user/.claude/skills/pr-hero-triage/adjudicator.md": "x",
      };

      const status = inspectSkillsSync(env, fakeAssets, {
        exists: (p) => p in disk || p.startsWith("/abs/"),
        readFile: (p) =>
          p.startsWith("/abs/")
            ? p.endsWith("SKILL.md")
              ? "bundled SKILL.md"
              : "x"
            : disk[p],
      });
      expect(status.synced).toBe(false);
      expect(status.drift).toBe(true);
    });

    test("inspectSkillsSync returns false when digest missing", () => {
      const env: AgentEnvDetection = {
        id: "claude",
        displayName: "Claude Code",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        skillsDir: "/home/user/.claude/skills",
      };

      const status = inspectSkillsSync(env, fakeAssets, {
        exists: () => false,
      });
      expect(status.synced).toBe(false);
      expect(status.drift).toBe(false);
    });
  });

  describe("1.6 Inverse lifecycle functions: unregisterMcpServer & removeSkills", () => {
    test("unregisterMcpServer removes pr-hero entry from mcpConfigFile", async () => {
      const written: Record<string, string> = {};
      const env: AgentEnvDetection = {
        id: "claude",
        displayName: "Claude Code",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        mcpConfigFile: "/home/user/.claude/mcp.json",
      };

      const initialConfig = JSON.stringify({
        mcpServers: {
          "pr-hero": { command: "pr-hero", args: ["mcp"] },
          "other-server": { command: "other", args: [] },
        },
      });

      const res = await (await import("../src/agent-env")).unregisterMcpServer(
        env,
        "pr-hero",
        {
          exists: () => true,
          readFile: () => initialConfig,
          writeFile: (p, c) => {
            written[p] = c;
          },
        },
      );

      expect(res.unregistered).toBe(true);
      const content = written["/home/user/.claude/mcp.json"] || "{}";
      const parsed = JSON.parse(content);
      expect(parsed.mcpServers["pr-hero"]).toBeUndefined();
      expect(parsed.mcpServers["other-server"]).toBeDefined();
    });

    test("removeSkills removes only unmodified files matching digest.json", async () => {
      const deleted: string[] = [];
      const env: AgentEnvDetection = {
        id: "claude",
        displayName: "Claude Code",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        skillsDir: "/home/user/.claude/skills",
      };

      const skillDir = "/home/user/.claude/skills/pr-hero-triage";
      const crypto = await import("node:crypto");
      const hashUnmodified = crypto
        .createHash("sha256")
        .update("unmodified content")
        .digest("hex");

      const digest = {
        files: {
          "SKILL.md": hashUnmodified,
          "custom.md": "hash_different_from_actual_content",
        },
      };

      const filesOnDisk: Record<string, string> = {
        [`${skillDir}/digest.json`]: JSON.stringify(digest),
        [`${skillDir}/SKILL.md`]: "unmodified content",
        [`${skillDir}/custom.md`]: "locally edited content",
      };

      const res = await (await import("../src/agent-env")).removeSkills(env, {
        exists: (p) => p === skillDir || p in filesOnDisk,
        readFile: (p) => filesOnDisk[p],
        unlink: (p) => {
          deleted.push(p);
          delete filesOnDisk[p];
        },
      });

      expect(res.removed).toContain("SKILL.md");
      expect(res.skippedModified).toContain("custom.md");
      expect(deleted).toContain(`${skillDir}/SKILL.md`);
      expect(deleted).not.toContain(`${skillDir}/custom.md`);
    });

    test("removeSkills also removes the general pr-hero skill", async () => {
      const deleted: string[] = [];
      const env: AgentEnvDetection = {
        id: "claude",
        displayName: "Claude Code",
        status: "active",
        binaryFound: true,
        auth: { authenticated: true, message: "ok" },
        skillsDir: "/home/user/.claude/skills",
      };

      const skillDir = "/home/user/.claude/skills/pr-hero";
      const crypto = await import("node:crypto");
      const hash = crypto
        .createHash("sha256")
        .update("general content")
        .digest("hex");

      const filesOnDisk: Record<string, string> = {
        [`${skillDir}/digest.json`]: JSON.stringify({
          files: { "SKILL.md": hash },
        }),
        [`${skillDir}/SKILL.md`]: "general content",
      };

      const res = await (await import("../src/agent-env")).removeSkills(env, {
        exists: (p) => p === skillDir || p in filesOnDisk,
        readFile: (p) => filesOnDisk[p],
        unlink: (p) => {
          deleted.push(p);
          delete filesOnDisk[p];
        },
      });

      expect(res.removed).toContain("SKILL.md");
      expect(deleted).toContain(`${skillDir}/SKILL.md`);
    });
  });
});
