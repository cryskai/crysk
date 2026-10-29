import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  executeUninstallPlan,
  planUninstallation,
  type UninstallPlan,
} from "../src/uninstaller";

describe("uninstaller (lifecycle foundations)", () => {
  const home = "/home/user";
  const standaloneBin = path.join(home, ".prhero", "bin", "pr-hero");

  describe("1.7 Pure uninstallation plan generator", () => {
    test("generates program removal plan on macOS without purge", async () => {
      const plan = await planUninstallation({
        home,
        platform: "darwin",
        purge: false,
        installMethod: { kind: "standalone", binaryPath: standaloneBin },
        detectActiveRuns: async () => [],
        isWatchLockHeld: async () => false,
        exists: (p) => {
          if (p.includes("launchd")) return true;
          if (p.includes(".zshrc")) return true;
          if (p.includes(".claude")) return true;
          return false;
        },
        readFile: (p) => {
          if (p.includes(".zshrc")) {
            return "export PATH=$HOME/.prhero/bin:$PATH\n";
          }
          return undefined;
        },
      });

      expect(plan.platform).toBe("darwin");
      expect(plan.programSteps).toBeDefined();
      expect(plan.dataSteps).toHaveLength(0); // No purge requested
      // Both generations of agent are removed.
      for (const label of [
        "io.crysk.watch",
        "io.crysk.gc",
        "io.prhero.watch",
        "io.prhero.gc",
      ]) {
        expect(plan.launchdServices).toContain(label);
      }
      expect(plan.rcFilesCleaned).toContain(path.join(home, ".zshrc"));
      expect(plan.binariesRemoved).toContain(standaloneBin);
      // Every bundled skill is removed under both its names, the general one included.
      for (const skillName of [
        "crysk-loop",
        "crysk-ci-setup",
        "crysk-pr",
        "crysk",
        "pr-hero-triage",
        "pr-hero-ci-setup",
        "pr-hero-pr",
        "pr-hero",
      ]) {
        expect(plan.agentEnvCleanups).toContain(
          `Claude Code Skill: ${skillName}`,
        );
      }
    });

    test("cleans both .crysk/bin and .prhero/bin PATH lines from an rc file", async () => {
      for (const line of [
        "export PATH=$HOME/.crysk/bin:$PATH\n",
        "export PATH=$HOME/.prhero/bin:$PATH\n",
      ]) {
        const plan = await planUninstallation({
          home,
          platform: "linux",
          installMethod: { kind: "source" },
          exists: (p) => p.includes(".zshrc"),
          readFile: () => line,
        });
        expect(plan.rcFilesCleaned).toEqual([path.join(home, ".zshrc")]);
      }
    });

    // (g) The installer leaves crysk plus a pr-hero link; removing only the
    // name that happens to be running would strand the other one on PATH.
    test("removes both crysk and pr-hero, plus their backups, whichever one is running", async () => {
      const dir = path.join(home, ".crysk", "bin");
      const present = new Set([
        path.join(dir, "crysk"),
        path.join(dir, "pr-hero"),
        path.join(dir, "crysk.bak"),
      ]);
      for (const running of ["crysk", "pr-hero"]) {
        const plan = await planUninstallation({
          home,
          platform: "linux",
          installMethod: {
            kind: "standalone",
            binaryPath: path.join(dir, running),
          },
          exists: (p) => present.has(p),
        });
        expect([...plan.binariesRemoved].sort()).toEqual([
          path.join(dir, "crysk"),
          path.join(dir, "pr-hero"),
        ]);
        const removed = plan.programSteps
          .filter((s) => s.type === "remove_file")
          .map((s) => s.targetPath);
        expect(removed).toContain(path.join(dir, "crysk.bak"));
        // The link goes before the file it points at: the executor skips a
        // dangling link because existsSync follows it.
        expect(removed.indexOf(path.join(dir, "pr-hero"))).toBeLessThan(
          removed.indexOf(path.join(dir, "crysk")),
        );
      }
    });

    test("a sibling name that is not on disk is not planned", async () => {
      const dir = path.join(home, ".prhero", "bin");
      const plan = await planUninstallation({
        home,
        platform: "linux",
        installMethod: {
          kind: "standalone",
          binaryPath: path.join(dir, "pr-hero"),
        },
        exists: () => false,
      });
      expect(plan.binariesRemoved).toEqual([path.join(dir, "pr-hero")]);
    });

    test("generates full data purge plan when purge is true and no runs active", async () => {
      const plan = await planUninstallation({
        home,
        platform: "darwin",
        purge: true,
        installMethod: { kind: "standalone", binaryPath: standaloneBin },
        detectActiveRuns: async () => [],
        isWatchLockHeld: async () => false,
        // Both homes present: the new one is resolved and the old one is
        // removed too.
        exists: () => true,
      });

      expect(plan.dataSteps.length).toBeGreaterThan(0);
      const dataPaths = plan.dataSteps.map((s) => s.targetPath);
      expect(dataPaths).toContain(path.join(home, ".crysk", "prhero.db"));
      expect(dataPaths).toContain(path.join(home, ".crysk", "watch.json"));
      expect(dataPaths).toContain(path.join(home, ".crysk", "config.json"));
      expect(dataPaths).toContain(path.join(home, ".crysk", "setup.json"));
      expect(dataPaths).toContain(path.join(home, ".prhero"));
    });

    test("a legacy-only home is purged exactly as before", async () => {
      const present = new Set([
        path.join(home, ".prhero"),
        path.join(home, ".prhero", "prhero.db"),
        path.join(home, ".prhero", "config.json"),
      ]);
      const plan = await planUninstallation({
        home,
        platform: "linux",
        purge: true,
        installMethod: { kind: "source" },
        detectActiveRuns: async () => [],
        isWatchLockHeld: async () => false,
        exists: (p) => present.has(p),
      });
      expect(plan.dataSteps.map((s) => s.targetPath)).toEqual([
        path.join(home, ".prhero", "prhero.db"),
        path.join(home, ".prhero", "config.json"),
        path.join(home, ".prhero"),
      ]);
    });

    test("refuses purge when active runs or watch.lock are detected", async () => {
      expect(
        planUninstallation({
          home,
          platform: "darwin",
          purge: true,
          detectActiveRuns: async () => [
            {
              pid: 1234,
              repo: "/repo",
              startTime: new Date().toISOString(),
              trigger: "manual",
            },
          ],
          isWatchLockHeld: async () => false,
        }),
      ).rejects.toThrow("active reviews are currently running");
    });
  });

  describe("1.7 Plan execution & dry-run", () => {
    test("dryRun executes zero filesystem or process mutations", async () => {
      let mutations = 0;
      const plan: UninstallPlan = {
        platform: "darwin",
        purge: false,
        launchdServices: ["io.prhero.watch"],
        rcFilesCleaned: [path.join(home, ".zshrc")],
        binariesRemoved: [standaloneBin],
        agentEnvCleanups: [],
        programSteps: [
          {
            type: "remove_file",
            targetPath: standaloneBin,
            desc: "Remove binary",
          },
        ],
        dataSteps: [],
        warnings: [],
      };

      const result = await executeUninstallPlan(plan, {
        dryRun: true,
        unlink: () => {
          mutations++;
        },
        exec: async () => {
          mutations++;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      expect(result.dryRun).toBe(true);
      expect(mutations).toBe(0);
    });

    test("unregister_mcp removes the crysk and the legacy entry and leaves other servers", async () => {
      const mcpPath = path.join(home, ".claude", "mcp.json");
      const written: Record<string, string> = {};
      const plan: UninstallPlan = {
        platform: "linux",
        purge: false,
        launchdServices: [],
        rcFilesCleaned: [],
        binariesRemoved: [],
        agentEnvCleanups: [],
        programSteps: [
          {
            type: "unregister_mcp",
            targetPath: mcpPath,
            desc: "Unregister MCP",
          },
        ],
        dataSteps: [],
        warnings: [],
      };

      const result = await executeUninstallPlan(plan, {
        exists: () => true,
        readFile: () =>
          JSON.stringify({
            mcpServers: {
              crysk: { command: "crysk", args: ["mcp"] },
              "pr-hero": { command: "pr-hero", args: ["mcp"] },
              keep: { command: "keep", args: [] },
            },
          }),
        writeFile: (p, c) => {
          written[p] = c;
        },
      });

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(written[mcpPath]);
      expect(Object.keys(parsed.mcpServers)).toEqual(["keep"]);
    });
  });
});
