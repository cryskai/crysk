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
      expect(plan.launchdServices).toContain("io.prhero.watch");
      expect(plan.launchdServices).toContain("io.prhero.gc");
      expect(plan.rcFilesCleaned).toContain(path.join(home, ".zshrc"));
      expect(plan.binariesRemoved).toContain(standaloneBin);
      // Every bundled skill is removed, the general pr-hero one included.
      for (const skillName of [
        "pr-hero-triage",
        "pr-hero-ci-setup",
        "pr-hero",
      ]) {
        expect(plan.agentEnvCleanups).toContain(
          `Claude Code Skill: ${skillName}`,
        );
      }
    });

    test("generates full data purge plan when purge is true and no runs active", async () => {
      const plan = await planUninstallation({
        home,
        platform: "darwin",
        purge: true,
        installMethod: { kind: "standalone", binaryPath: standaloneBin },
        detectActiveRuns: async () => [],
        isWatchLockHeld: async () => false,
        exists: () => true,
      });

      expect(plan.dataSteps.length).toBeGreaterThan(0);
      const dataPaths = plan.dataSteps.map((s) => s.targetPath);
      expect(dataPaths).toContain(path.join(home, ".prhero", "prhero.db"));
      expect(dataPaths).toContain(path.join(home, ".prhero", "watch.json"));
      expect(dataPaths).toContain(path.join(home, ".prhero", "config.json"));
      expect(dataPaths).toContain(path.join(home, ".prhero", "setup.json"));
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
  });
});
