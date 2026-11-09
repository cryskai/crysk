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
import { gotchasUnusableReason } from "#review/preflight";
import { NO_INSTRUCTIONS_NOTICE } from "#review/run";
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
  test("a fresh repo gets .crysk/config.json and a root REVIEW.md scaffold the gate refuses", async () => {
    const repo = await makeRepo();
    const home = path.join(scratch, "home");
    await mkdir(home);
    const r = runCli(["init", "--repo", repo], repo, home);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(repo, ".crysk", "config.json"))).toBe(true);
    expect(existsSync(path.join(repo, ".crysk", "gotchas.md"))).toBe(false);
    expect(existsSync(path.join(repo, ".prhero"))).toBe(false);
    // S3: the scaffold is refused until a human fills it in, exactly like the
    // gotchas scaffold always was.
    const reviewMd = await readFile(path.join(repo, "REVIEW.md"), "utf8");
    expect(gotchasUnusableReason(reviewMd)).toBe("placeholder");
    expect(r.output).toContain("Then edit REVIEW.md");
    expect(r.output).toContain("commit REVIEW.md");
  });

  test("a repo with real gotchas keeps them and gets no REVIEW.md to shadow them", async () => {
    const repo = await makeRepo();
    const home = path.join(scratch, "home");
    await mkdir(home);
    await mkdir(path.join(repo, ".crysk"));
    const real = "- billing: refunds are idempotent by request id\n";
    await writeFile(path.join(repo, ".crysk", "gotchas.md"), real);
    const r = runCli(["init", "--repo", repo], repo, home);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(repo, "REVIEW.md"))).toBe(false);
    expect(
      await readFile(path.join(repo, ".crysk", "gotchas.md"), "utf8"),
    ).toBe(real);
    expect(r.output).toContain(".crysk/gotchas.md already on disk passes");
  });

  test("a legacy-only repo keeps its config dir in place, no .crysk created", async () => {
    const repo = await makeRepo();
    const home = path.join(scratch, "home");
    await mkdir(home);
    await mkdir(path.join(repo, ".prhero"));
    await writeFile(path.join(repo, ".prhero", "config.json"), "{}\n");
    const r = runCli(["init", "--repo", repo], repo, home);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(repo, "REVIEW.md"))).toBe(true);
    // The existing config is kept, never overwritten.
    expect(
      await readFile(path.join(repo, ".prhero", "config.json"), "utf8"),
    ).toBe("{}\n");
    expect(existsSync(path.join(repo, ".crysk"))).toBe(false);
    expect(r.output).toContain(".prhero/");
  });
});

// S3 + PR #463 F002: a repo with neither REVIEW.md nor a gotchas file is
// reviewed, and the run says so — the absence must never look like a normal run.
describe("review with no instructions file", () => {
  test("passes the instructions gate and prints the no-instructions notice", async () => {
    const repo = await makeRepo();
    const home = path.join(scratch, "home");
    await mkdir(home);
    // A login in the scratch HOME, so the run's login probe stops there and never
    // asks the host's Keychain (defaultClaudeLoginPresent checks this file first).
    await mkdir(path.join(home, ".claude"));
    await writeFile(path.join(home, ".claude", ".credentials.json"), "{}");
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: repo });
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("checkout", "-q", "-b", "main");
    await writeFile(path.join(repo, "a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "feat");
    await writeFile(path.join(repo, "a.ts"), "export const a = 2;\n");
    git("commit", "-qam", "change");
    const r = runCli(
      [
        "review",
        "--base",
        "main",
        "--dry-run",
        "--out",
        path.join(scratch, "out"),
      ],
      repo,
      home,
    );
    // No exit-code assertion: a dry run still goes through runner admission,
    // which needs a `claude` binary on PATH, and CI runners have none (rc 1,
    // "claude binary not found on PATH"). What this test owns is the
    // instructions gate: before S3 the same repo was refused here, before
    // admission, and the run never said why it went ahead.
    expect(r.output).toContain(NO_INSTRUCTIONS_NOTICE);
    expect(r.output).not.toContain("missing or empty gotchas file");
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
  // The person file is written only in platform mode now: the routing input
  // that used to write it standalone is gone (S2).
  const MODELS = { default: ["opencode:deepseek/deepseek-chat"] };

  test("on a fresh HOME the CI step writes where the CLI then reads", async () => {
    const home = path.join(scratch, "runner-home");
    await mkdir(home);
    await materializeCiOpenCodeData({
      home,
      env: { HOME: home },
      routing: "",
      opencodeAuth: "",
      platformPerson: { models: MODELS },
    });
    expect(existsSync(path.join(home, ".crysk", "config.json"))).toBe(true);
    const { filePath, layer } = await loadGlobalConfigLayer(home);
    expect(filePath).toBe(path.join(home, ".crysk", "config.json"));
    expect(layer?.models).toEqual(MODELS);
  });

  test("a runner HOME that only has the legacy dir is written and read there", async () => {
    const home = path.join(scratch, "legacy-home");
    await mkdir(path.join(home, ".prhero"), { recursive: true });
    await materializeCiOpenCodeData({
      home,
      env: { HOME: home },
      routing: "",
      opencodeAuth: "",
      platformPerson: { models: MODELS },
    });
    const { filePath, layer } = await loadGlobalConfigLayer(home);
    expect(filePath).toBe(path.join(home, ".prhero", "config.json"));
    expect(layer?.models).toEqual(MODELS);
    expect(existsSync(path.join(home, ".crysk"))).toBe(false);
  });
});
