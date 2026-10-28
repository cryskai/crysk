// The pr-hero → Crysk rename, end to end on real temp directories: what the
// commands WRITE goes to the resolved name, what they READ falls back to the
// legacy name, and the CI writer and reader of the runner's config agree.
// Nothing here touches the real HOME or a real repository.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendIgnorePatterns, materializeCiOpenCodeData } from "#ci/setup";
import { loadGlobalConfigLayer } from "#config/config";
import { readLocalIgnoreRules } from "../src/ignore-read";

const CLI = path.join(import.meta.dir, "../src/cli.ts");

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "crysk-io-"));
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

async function makeRepo(): Promise<string> {
  const dir = path.join(scratch, "repo");
  await mkdir(dir);
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

function runCli(args: string[], cwd: string, home: string) {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
  });
  return { code: r.exitCode, output: `${r.stdout}${r.stderr}` };
}

describe("init writes into the resolved repo dir", () => {
  test("a fresh repo gets .crysk/", async () => {
    const repo = await makeRepo();
    const home = path.join(scratch, "home");
    await mkdir(home);
    const r = runCli(["init", "--repo", repo], repo, home);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(repo, ".crysk", "config.json"))).toBe(true);
    expect(existsSync(path.join(repo, ".crysk", "gotchas.md"))).toBe(true);
    expect(existsSync(path.join(repo, ".prhero"))).toBe(false);
    expect(r.output).toContain(".crysk/gotchas.md");
  });

  test("a legacy-only repo keeps being updated in place, no .crysk created", async () => {
    const repo = await makeRepo();
    const home = path.join(scratch, "home");
    await mkdir(home);
    await mkdir(path.join(repo, ".prhero"));
    await writeFile(path.join(repo, ".prhero", "config.json"), "{}\n");
    const r = runCli(["init", "--repo", repo], repo, home);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(repo, ".prhero", "gotchas.md"))).toBe(true);
    // The existing config is kept, never overwritten.
    expect(
      await readFile(path.join(repo, ".prhero", "config.json"), "utf8"),
    ).toBe("{}\n");
    expect(existsSync(path.join(repo, ".crysk"))).toBe(false);
    expect(r.output).toContain(".prhero/gotchas.md");
  });
});

describe("setup --ci writes into the resolved repo dir", () => {
  test("a legacy-only repo has its .prhero/config.json updated in place", async () => {
    const repo = await makeRepo();
    const home = path.join(scratch, "home");
    await mkdir(home);
    await mkdir(path.join(repo, ".prhero"));
    await writeFile(
      path.join(repo, ".prhero", "config.json"),
      JSON.stringify({ post: true }),
    );
    const r = runCli(["setup", "--ci", "--level", "minimal"], repo, home);
    expect(r.code).toBe(0);
    const cfg = JSON.parse(
      await readFile(path.join(repo, ".prhero", "config.json"), "utf8"),
    );
    expect(cfg.post).toBe(true);
    expect(cfg.ci_max_attempts).toBe(1);
    expect(existsSync(path.join(repo, ".crysk"))).toBe(false);
  });
});

describe("the ignore file", () => {
  test("readLocalIgnoreRules reads .cryskignore", async () => {
    await writeFile(path.join(scratch, ".cryskignore"), "new/**\n");
    const result = await readLocalIgnoreRules(scratch);
    expect(result.rules.map((r) => r.pattern)).toEqual(["new/**"]);
  });

  test("with both files, .cryskignore wins and the legacy one is not read", async () => {
    await writeFile(path.join(scratch, ".cryskignore"), "new/**\n");
    await writeFile(path.join(scratch, ".prheroignore"), "old/**\n");
    const result = await readLocalIgnoreRules(scratch);
    expect(result.rules.map((r) => r.pattern)).toEqual(["new/**"]);
  });

  test("a malformed .prheroignore (the only file) is reported under its own name", async () => {
    await writeFile(path.join(scratch, ".prheroignore"), "ok/**\n!\n");
    await expect(readLocalIgnoreRules(scratch)).rejects.toThrow(
      /\.prheroignore:2:/,
    );
  });

  test("a malformed .cryskignore is reported under its own name", async () => {
    await writeFile(path.join(scratch, ".cryskignore"), "ok/**\n!\n");
    await expect(readLocalIgnoreRules(scratch)).rejects.toThrow(
      /\.cryskignore:2:/,
    );
  });

  test("an unreadable .cryskignore (a directory) aborts, naming it; it never falls back", async () => {
    await mkdir(path.join(scratch, ".cryskignore"));
    await writeFile(path.join(scratch, ".prheroignore"), "old/**\n");
    await expect(readLocalIgnoreRules(scratch)).rejects.toThrow(
      /\.cryskignore at .* is not a regular file/,
    );
  });

  test("ci-setup creates .cryskignore on a fresh repo", async () => {
    const file = await appendIgnorePatterns(scratch, ["dist/**"]);
    expect(path.basename(file)).toBe(".cryskignore");
    expect(existsSync(path.join(scratch, ".prheroignore"))).toBe(false);
  });
});

describe("the runner's person-layer config: writer and reader agree", () => {
  const ROUTING = JSON.stringify({
    default: { backend: "opencode", provider: "deepseek" },
  });

  test("on a fresh HOME the CI step writes where the CLI then reads", async () => {
    const home = path.join(scratch, "runner-home");
    await mkdir(home);
    await materializeCiOpenCodeData({
      home,
      env: { HOME: home },
      routing: ROUTING,
      opencodeAuth: "",
    });
    expect(existsSync(path.join(home, ".crysk", "config.json"))).toBe(true);
    const { filePath, layer } = await loadGlobalConfigLayer(home);
    expect(filePath).toBe(path.join(home, ".crysk", "config.json"));
    expect(layer?.routing?.default?.provider).toBe("deepseek");
  });

  test("a runner HOME that only has the legacy dir is written and read there", async () => {
    const home = path.join(scratch, "legacy-home");
    await mkdir(path.join(home, ".prhero"), { recursive: true });
    await materializeCiOpenCodeData({
      home,
      env: { HOME: home },
      routing: ROUTING,
      opencodeAuth: "",
    });
    const { filePath, layer } = await loadGlobalConfigLayer(home);
    expect(filePath).toBe(path.join(home, ".prhero", "config.json"));
    expect(layer?.routing?.default?.provider).toBe("deepseek");
    expect(existsSync(path.join(home, ".crysk"))).toBe(false);
  });
});
