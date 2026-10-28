import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { loadEffectiveConfig } from "#config/config";
import { runDoctor } from "../src/doctor";
import { runWizard } from "../src/wizard";

describe("repo-optional commands", () => {
  const tmpDir = path.join(os.tmpdir(), `pr-hero-repo-opt-test-${Date.now()}`);

  describe("4.2 repo-optional doctor", () => {
    test("runs system checks and succeeds when cwd is not a git repo", async () => {
      const report = await runDoctor({
        cwd: undefined,
        checkToolsOptions: {
          which: (bin) =>
            ["git", "claude"].includes(bin) ? `/usr/bin/${bin}` : null,
          exec: async () => ({
            exitCode: 0,
            stdout: "1.0.0",
            stderr: "",
          }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
          exists: () => false,
        },
      });

      expect(report.checks.some((c) => c.name === "git")).toBe(true);
      expect(report.checks.some((c) => c.name === "claude")).toBe(true);
      expect(report.exitCode).toBe(0);
    });
  });

  describe("4.3 repo-optional config", () => {
    test("loads global config layers cleanly when root is undefined", async () => {
      const loaded = await loadEffectiveConfig({
        root: undefined as unknown as string,
        home: tmpDir,
      });

      expect(loaded.effective).toBeDefined();
      expect(loaded.sources).toBeDefined();
      expect(loaded.globalPresent).toBe(false);
    });
  });

  describe("4.4 repo-optional setup", () => {
    test("completes machine-level setup when cwd is not a git repo", async () => {
      const written: Record<string, string> = {};
      const exitCode = await runWizard({
        cwd: tmpDir,
        home: tmpDir,
        exec: async (_cmd) => ({
          exitCode: 1, // git rev-parse returns not inside work tree
          stdout: "",
          stderr: "fatal: not a git repository",
        }),
        writeFile: async (p, content) => {
          written[p] = content;
        },
        exists: () => false,
      });

      expect(exitCode).toBe(0);
      const setupPath = path.join(tmpDir, ".crysk", "setup.json");
      expect(written[setupPath]).toBeDefined();
      const dotPrheroConfig = path.join(tmpDir, ".crysk", "config.json");
      expect(written[dotPrheroConfig]).toBeUndefined();
    });
  });
});
