import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePrDryRunSizeGate } from "#pr/preflight";
import {
  resolvePrDryRunNumstat,
  resolvePrPromptSetAndBudget,
} from "#pr/target";
import { parseArgs } from "#review/preflight";
import { loadRunConfig } from "#review/run";
import { DEFAULT_SIZE_GATE } from "#review/size-gate";

const MONSTER_FILE = {
  path: "a.ts",
  insertions: 5000,
  deletions: 0,
  binary: false,
};

describe("resolvePrDryRunNumstat — PR1b Addition 1 / #5557's degrade rule", () => {
  // The invariant test/cli.test.ts used to pin as literal source
  // ("perFile = null" inside a catch, never an empty array): a rejecting
  // fetch must degrade the dry-run size-gate estimate to the aggregate
  // GitHub counters, never manufacture a PASSING per-file verdict out of a
  // failed fetch. Proven through the real downstream consumer
  // (resolvePrDryRunSizeGate) rather than asserting the raw `null` alone, so
  // the test fails if the degrade path stops actually protecting the gate.
  test("a rejecting fetch degrades to the aggregate estimate rather than a passing empty list", async () => {
    const perFile = await resolvePrDryRunNumstat({
      fetchFiles: () => Promise.reject(new Error("gh timed out")),
      totalFiles: 1,
    });
    const { verdict } = resolvePrDryRunSizeGate({
      ghDiffStat: { files: 1, insertions: 5000, deletions: 0 },
      perFile,
      gateConfig: DEFAULT_SIZE_GATE,
    });
    expect(verdict.ok).toBe(false);
  });

  test("a truncated per-file list (fewer rows than GitHub's own file count) also degrades to the aggregate", async () => {
    const perFile = await resolvePrDryRunNumstat({
      fetchFiles: () => Promise.resolve([MONSTER_FILE]),
      totalFiles: 5,
    });
    expect(perFile).toBeNull();
  });

  test("a complete per-file list at or above the total is trusted and returned", async () => {
    const files = [MONSTER_FILE, { ...MONSTER_FILE, path: "b.ts" }];
    const perFile = await resolvePrDryRunNumstat({
      fetchFiles: () => Promise.resolve(files),
      totalFiles: 2,
    });
    expect(perFile).toEqual(files);
  });
});

// The wiring half of the CI size-limit policy: resolveCiSizeLimits is pinned
// in test/ci/gates.test.ts, and this pins that resolvePrPromptSetAndBudget
// hands it the repo config and the route, and leaves non-CI runs alone.
describe("resolvePrPromptSetAndBudget — CI size limits", () => {
  const ENV_KEYS = [
    "HOME",
    "XDG_DATA_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CI",
    "GITHUB_ACTIONS",
  ] as const;
  let saved: Record<string, string | undefined> = {};
  let dir = "";

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    dir = mkdtempSync(path.join(os.tmpdir(), "prhero-ci-size-"));
    const repo = path.join(dir, "repo");
    mkdirSync(path.join(repo, ".prhero"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repo]);
    // Only the files knob is configured, so the lines knob shows what the
    // route decides and the files knob shows the config reaching the gate.
    writeFileSync(
      path.join(repo, ".prhero", "config.json"),
      JSON.stringify({ max_changed_files: 20 }),
    );
    process.env.HOME = path.join(dir, "home");
    process.env.XDG_DATA_HOME = path.join(dir, "xdg");
    for (const k of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CI",
      "GITHUB_ACTIONS",
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // loadRunConfig with a scratch home, never resolvePrRunOptions: that one
  // reads the global layer from os.homedir(), which ignores HOME, so the
  // developer's own ~/.prhero/config.json would leak into the expectation.
  async function limitsFor(argv: string[], isCi = true) {
    const repo = path.join(dir, "repo");
    const { options } = parseArgs(["review", "--pr", "1", ...argv]);
    const { loaded, config } = await loadRunConfig({
      root: repo,
      home: path.join(dir, "home"),
      configFlag: undefined,
      options,
    });
    const step2 = await resolvePrPromptSetAndBudget({
      options,
      loaded,
      config,
      isCi,
      operatorRoot: repo,
    });
    return step2.ciSizeLimits;
  }

  test("a CI run on a subscription turns off only the knob nothing configured", async () => {
    expect(await limitsFor(["--ci"])).toEqual({
      maxChangedLines: 0,
      maxChangedFiles: undefined,
      defaultedOff: ["lines"],
    });
  });

  test("a CI run on a metered route keeps the engine's line default", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(await limitsFor(["--ci"])).toEqual({
      maxChangedLines: undefined,
      maxChangedFiles: undefined,
      defaultedOff: [],
    });
  });

  test("an explicit flag still wins in CI", async () => {
    expect(await limitsFor(["--ci", "--max-changed-lines", "2500"])).toEqual({
      maxChangedLines: 2500,
      maxChangedFiles: undefined,
      defaultedOff: [],
    });
  });

  test("a non-CI run resolves no CI limits at all", async () => {
    expect(await limitsFor([], false)).toBeUndefined();
  });
});
