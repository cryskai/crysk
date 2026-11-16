// Every engine step in action.yml runs `bun <action_path>/src/...` with the
// job's working directory, the checked-out repository. Bun reads that
// directory's bunfig.toml (whose `preload` runs code) and .env even when the
// script is an absolute path, so each such call turns both off.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ACTION = path.join(import.meta.dir, "..", "..", "action.yml");
const FLAGS = "--no-env-file --config=/dev/null";

describe("action.yml bun calls ignore the workspace's bunfig.toml and .env", () => {
  test("every bun call on an engine script passes both flags", async () => {
    const text = await Bun.file(ACTION).text();
    const calls = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .filter((line) =>
        /\bbun\s+(?:--\S+\s+)*"\$\{\{ github\.action_path \}\}\//.test(line),
      );
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) {
      expect(line).toContain(`bun ${FLAGS} "\${{ github.action_path }}/`);
    }
  });

  test("with the flags, a hostile working directory's preload and .env do nothing", () => {
    // The script lives beside the hostile directory, never inside it.
    const root = mkdtempSync(path.join(tmpdir(), "crysk-autoload-"));
    const dir = path.join(root, "workspace");
    mkdirSync(dir);
    try {
      const marker = path.join(dir, "preload-ran");
      writeFileSync(
        path.join(dir, "preload.ts"),
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
      );
      writeFileSync(
        path.join(dir, "bunfig.toml"),
        'preload = ["./preload.ts"]\n',
      );
      writeFileSync(
        path.join(dir, ".env"),
        "CRYSK_AUTOLOAD_PROBE=from_dotenv\n",
      );
      const script = path.join(root, "probe.ts");
      writeFileSync(
        script,
        "console.log(process.env.CRYSK_AUTOLOAD_PROBE ?? 'unset');\n",
      );
      const { CRYSK_AUTOLOAD_PROBE: _, ...env } = process.env;
      const run = Bun.spawnSync({
        cmd: [process.execPath, ...FLAGS.split(" "), script],
        cwd: dir,
        env,
      });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString().trim()).toBe("unset");
      expect(existsSync(marker)).toBe(false);
      // Control: without the flags the same directory runs the preload and
      // loads the .env, so the assertions above can fail.
      const bare = Bun.spawnSync({
        cmd: [process.execPath, script],
        cwd: dir,
        env,
      });
      expect(bare.stdout.toString().trim()).toBe("from_dotenv");
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
