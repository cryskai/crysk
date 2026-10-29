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
  });
});
