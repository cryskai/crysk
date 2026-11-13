import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("bundled engine assets", () => {
  test("resolve outside the bundle directory without depending on consumer cwd", () => {
    const repo = path.resolve(import.meta.dir, "..");
    const temp = mkdtempSync(path.join(os.tmpdir(), "crysk-assets-cwd-"));
    const dist = path.join(temp, "dist");
    const consumer = path.join(temp, "consumer");
    mkdirSync(consumer);

    try {
      const probeSource = path.join(temp, "probe.ts");
      writeFileSync(
        probeSource,
        [
          `import { resolveEngineAssets } from ${JSON.stringify(path.join(repo, "src/assets.ts"))};`,
          'import { existsSync } from "node:fs";',
          'import path from "node:path";',
          "const assets = resolveEngineAssets();",
          "const files = [",
          "  assets.consolidatePromptPath,",
          "  assets.summarizerPromptPath,",
          "  assets.materialityPromptPath,",
          "  assets.scoutPromptPath,",
          "  ...Object.values(assets.bundledAgentFiles),",
          "];",
          "console.log(JSON.stringify(files.map(file => ({ absolute: path.isAbsolute(file), exists: existsSync(file) }))));",
        ].join("\n"),
      );

      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          probeSource,
          "--target=bun",
          "--outdir",
          dist,
        ],
        { cwd: repo, stdout: "pipe", stderr: "pipe" },
      );
      expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);

      const run = Bun.spawnSync(
        [process.execPath, path.join(dist, "probe.js")],
        {
          cwd: consumer,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
      const files: Array<{ absolute: boolean; exists: boolean }> = JSON.parse(
        new TextDecoder().decode(run.stdout).trim(),
      );
      expect(files.length).toBeGreaterThan(5);
      expect(files.every(({ absolute, exists }) => absolute && exists)).toBe(
        true,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
