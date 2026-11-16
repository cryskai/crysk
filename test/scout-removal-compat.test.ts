// S2 of odd/tasks/remove-scout-parity.md: the scout stage is gone, and nothing
// a user already has stops working. Each surface that used to name it (three
// flags, the config key in both layers, the `models.scout` role, the action
// input, `config set`) is still accepted, has no effect, and warns exactly once
// that the stage was removed. The wording is quoted by the changelog, so the
// tail of every message is asserted verbatim.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPlatformPerson } from "#ci/platform-config";
import { loadEffectiveConfig } from "#config/config";
import { isModelRole, parseModelsConfig } from "#model/model-name";
import {
  mergeConfig,
  parseArgs,
  parseGlobalConfig,
  parseLocalConfig,
} from "#review/preflight";
import { setConfigValue, unsetConfigValue } from "#ui/config-edit";
import { main } from "../src/cli";

const TAIL = "is ignored: the scout stage was removed";

describe("the flags", () => {
  let dir: string;
  let notARepo: string;
  let savedWrite: typeof process.stderr.write;
  let savedOutput: string | undefined;
  let written: string[];

  beforeEach(() => {
    // `main()` writes `status=error` to $GITHUB_OUTPUT on a fatal exit when it
    // is set (a CI job step); this file must leave a CI runner's file alone.
    savedOutput = process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_OUTPUT;
    dir = mkdtempSync(path.join(tmpdir(), "sr-flags-"));
    notARepo = path.join(dir, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    written = [];
    savedWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = savedWrite;
    if (savedOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = savedOutput;
    rmSync(dir, { recursive: true, force: true });
  });

  // `--repo` points at a directory git does not know, so the run stops at its
  // first statement with a CliError (exit 1) and spends nothing. A usage error
  // would be exit 2 and means the parser refused the flag.
  async function run(
    ...flags: string[]
  ): Promise<{ code: number; scout: string[] }> {
    const code = await main(["review", ...flags, "--repo", notARepo]);
    const scout = written
      .join("")
      .split("\n")
      .filter((line) => /scout/i.test(line));
    return { code, scout };
  }

  test("--scout is accepted and warns once", async () => {
    const { code, scout } = await run("--scout");
    expect(code).toBe(1);
    expect(scout).toEqual([`warning: --scout ${TAIL}`]);
  });

  test("--no-scout is accepted and warns once", async () => {
    const { code, scout } = await run("--no-scout");
    expect(code).toBe(1);
    expect(scout).toEqual([`warning: --no-scout ${TAIL}`]);
  });

  test("--scout-model <model> is accepted, even without --scout, and warns once", async () => {
    const { code, scout } = await run("--scout-model", "haiku");
    expect(code).toBe(1);
    expect(scout).toEqual([`warning: --scout-model ${TAIL}`]);
  });

  test("each ignored flag warns once however often it is repeated", async () => {
    const { code, scout } = await run(
      "--scout",
      "--scout-model",
      "haiku",
      "--no-scout",
      "--scout",
      "--scout-model",
      "opus",
    );
    expect(code).toBe(1);
    expect(scout).toEqual([
      `warning: --scout ${TAIL}`,
      `warning: --scout-model ${TAIL}`,
      `warning: --no-scout ${TAIL}`,
    ]);
  });

  test("a run without the flags prints no scout warning", async () => {
    const { code, scout } = await run();
    expect(code).toBe(1);
    expect(scout).toEqual([]);
  });

  test("the parsed options carry no scout setting", () => {
    const { options } = parseArgs(["review", "--scout", "--scout-model", "x"]);
    expect("scout" in options).toBe(false);
    expect("scoutModel" in options).toBe(false);
  });

  test("the help text no longer advertises the flags", async () => {
    const { HELP_TEXT } = await import("#review/preflight");
    expect(HELP_TEXT).not.toMatch(/scout/i);
  });
});

describe("the config key", () => {
  test("a repo file's scout is accepted, dropped, and warned about once, naming the file", () => {
    const warnings: string[] = [];
    const layer = parseLocalConfig(
      JSON.stringify({ scout: true, default_base: "main" }),
      ".crysk/config.json",
      warnings,
    );
    expect(layer).toEqual({ default_base: "main" });
    expect(warnings).toEqual([`.crysk/config.json: scout ${TAIL}`]);
  });

  test("a person file's scout (the shape the platform sends) is accepted, dropped and warned about once", () => {
    const warnings: string[] = [];
    const layer = parseGlobalConfig(
      JSON.stringify({ scout: false, max_changed_lines: 10 }),
      "~/.crysk/config.json",
      warnings,
    );
    expect("scout" in layer).toBe(false);
    expect(layer.max_changed_lines).toBe(10);
    expect(warnings).toEqual([`~/.crysk/config.json: scout ${TAIL}`]);
  });

  test("a value the old parser would have refused is ignored too", () => {
    const warnings: string[] = [];
    parseGlobalConfig(JSON.stringify({ scout: "yes" }), "f.json", warnings);
    expect(warnings).toEqual([`f.json: scout ${TAIL}`]);
  });

  test("the merged config has no scout and the loader warns once per file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sr-cfg-"));
    try {
      const home = path.join(root, "home");
      const repo = path.join(root, "repo");
      mkdirSync(path.join(home, ".crysk"), { recursive: true });
      mkdirSync(path.join(repo, ".crysk"), { recursive: true });
      writeFileSync(path.join(home, ".crysk", "config.json"), '{"scout":true}');
      writeFileSync(path.join(repo, ".crysk", "config.json"), '{"scout":true}');
      const loaded = await loadEffectiveConfig({ root: repo, home });
      expect("scout" in loaded.effective).toBe(false);
      expect("scout" in loaded.sources).toBe(false);
      expect(loaded.warnings).toEqual([
        `~/.crysk/config.json: scout ${TAIL}`,
        `.crysk/config.json: scout ${TAIL}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stored platform person with scout passes the platform's own check", () => {
    expect(() =>
      assertPlatformPerson({ scout: true, max_changed_lines: 4000 }, "f"),
    ).not.toThrow();
  });

  test("mergeConfig output has no scout", () => {
    const merged = mergeConfig(undefined, {});
    expect("scout" in merged.effective).toBe(false);
  });
});

describe("the models.scout role", () => {
  test("is accepted, dropped, and warned about once", () => {
    const warnings: string[] = [];
    const layer = parseGlobalConfig(
      JSON.stringify({
        models: {
          default: ["claude:sonnet-latest"],
          scout: ["claude:haiku-latest"],
        },
      }),
      "~/.crysk/config.json",
      warnings,
    );
    expect(layer.models).toEqual({ default: ["claude:sonnet-latest"] });
    expect(warnings).toEqual([`~/.crysk/config.json: models.scout ${TAIL}`]);
  });

  test("a models object that held only the scout leaves no routing choice behind", () => {
    const warnings: string[] = [];
    const layer = parseGlobalConfig(
      JSON.stringify({ models: { scout: ["claude:haiku-latest"] } }),
      "f.json",
      warnings,
    );
    expect(layer.models).toBeUndefined();
    expect(warnings).toEqual([`f.json: models.scout ${TAIL}`]);
  });

  test("is not a role any more, but its entry no longer breaks the other roles' parse", () => {
    expect(isModelRole("scout")).toBe(false);
    expect(
      parseModelsConfig({
        scout: ["claude:haiku-latest"],
        refuter: ["claude:opus-latest"],
      }),
    ).toEqual({ refuter: ["claude:opus-latest"] });
  });
});

describe("crysk config set scout", () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), "sr-set-"));
    home = path.join(root, "home");
    repo = path.join(root, "repo");
    mkdirSync(path.join(home, ".crysk"), { recursive: true });
    mkdirSync(path.join(repo, ".crysk"), { recursive: true });
  });
  afterEach(() => {
    rmSync(path.dirname(home), { recursive: true, force: true });
  });

  const MESSAGE = "scout was removed: the scout stage no longer exists";

  test("is refused on the person layer and writes nothing", async () => {
    const file = path.join(home, ".crysk", "config.json");
    await expect(
      setConfigValue({ layer: "person", key: "scout", value: "true", home }),
    ).rejects.toThrow(MESSAGE);
    expect(existsSync(file)).toBe(false);
  });

  test("is refused on the team layer and writes nothing", async () => {
    const file = path.join(repo, ".crysk", "config.json");
    await expect(
      setConfigValue({
        layer: "team",
        key: "scout",
        value: "true",
        home,
        repoRoot: repo,
      }),
    ).rejects.toThrow(MESSAGE);
    expect(existsSync(file)).toBe(false);
  });

  test("unsetting a stale scout key still works", async () => {
    const file = path.join(home, ".crysk", "config.json");
    writeFileSync(file, JSON.stringify({ scout: true, post: true }));
    await unsetConfigValue({ layer: "person", key: "scout", home });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ post: true });
  });
});

describe("action.yml", () => {
  const actionPath = path.join(import.meta.dir, "..", "action.yml");
  const source = readFileSync(actionPath, "utf8");
  const action = Bun.YAML.parse(source) as {
    inputs: Record<string, { description: string; default?: string }>;
    runs: { steps: Array<{ env?: Record<string, string>; run?: string }> };
  };

  test("keeps the scout input declared, described as removed and ignored", () => {
    const input = action.inputs.scout;
    expect(input).toBeDefined();
    expect(input?.description).toMatch(/removed/i);
    expect(input?.description).toMatch(/ignored/i);
  });

  test("never passes --scout to the CLI", () => {
    expect(source).not.toContain("--scout");
  });

  test("warns once when the input is set, and not otherwise", () => {
    const step = action.runs.steps.find(
      (s) => s.env?.SCOUT_INPUT !== undefined,
    );
    expect(step?.run).toBeDefined();
    const lines = (step?.run ?? "")
      .split("\n")
      .filter((line) => line.includes("SCOUT_INPUT"));
    expect(lines).toHaveLength(1);
    const snippet = lines[0] as string;
    const runWith = (value: string) =>
      spawnSync("bash", ["-c", snippet], {
        env: { PATH: process.env.PATH ?? "", SCOUT_INPUT: value },
        encoding: "utf8",
      });
    for (const value of ["true", "false"]) {
      const result = runWith(value);
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "::warning::the scout input is ignored: the scout stage was removed",
      ]);
    }
    expect(runWith("").stdout).toBe("");
  });
});
