// Platform mode: the review configuration the Crysk platform returns with the
// run token (`config.person`, `config.repo`) reaches the engine's own two-layer
// read. `person` becomes the runner's personal config file; `repo` becomes the
// repo layer only when the checkout has no repo config of its own, through the
// engine's `--config` override. Every test is offline: real temp directories,
// the engine's real config loader, no network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deliverPlatformRepoLayer,
  PlatformConfigError,
  readPlatformConfig,
} from "#ci/platform-config";
import { materializeCiOpenCodeData } from "#ci/setup";
import { loadEffectiveConfig } from "#config/config";
import { parseGlobalConfig, parseLocalConfig } from "#review/preflight";
import { prheroLayout } from "../../src/home-preflight";

const SETUP_SCRIPT = path.resolve(
  __dirname,
  "..",
  "..",
  "src",
  "ci",
  "setup.ts",
);

const PLATFORM_ROUTING = {
  default: { backend: "opencode", provider: "deepseek" },
};
const INPUT_ROUTING = JSON.stringify({
  default: { backend: "opencode", provider: "openai" },
});

interface Fixture {
  root: string;
  home: string;
  // The checked-out repository: the engine's operator root.
  workspace: string;
  // The runner's temp directory, outside the workspace.
  runnerTemp: string;
  platformDir: string;
}

let fixture: Fixture;

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crysk-platform-config-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(runnerTemp, { recursive: true });
  fixture = {
    root,
    home,
    workspace,
    runnerTemp,
    platformDir: path.join(runnerTemp, "crysk-platform"),
  };
});

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

async function writeRepoFile(dirName: string, body: unknown): Promise<string> {
  const file = path.join(fixture.workspace, dirName, "config.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(body)}\n`);
  return file;
}

describe("deliverPlatformRepoLayer", () => {
  test("a checkout with no repo config gets the platform's repo layer as a temp file outside the workspace", async () => {
    const result = await deliverPlatformRepoLayer({
      repo: { default_base: "release", max_changed_lines: 1000 },
      root: fixture.workspace,
      dir: fixture.platformDir,
    });
    expect(result.status).toBe("written");
    if (result.status !== "written") return;
    expect(path.relative(fixture.workspace, result.file).startsWith("..")).toBe(
      true,
    );
    expect(path.dirname(result.file)).toBe(fixture.platformDir);
    // The engine's own repo-layer parser accepts what was written.
    expect(parseLocalConfig(await readFile(result.file, "utf8"))).toEqual({
      default_base: "release",
      max_changed_lines: 1000,
    });
    // Nothing lands in the checkout.
    expect(await readdir(fixture.workspace)).toEqual([]);
  });

  test("the repository's own .crysk/config.json wins whole and the platform layer is ignored", async () => {
    const own = await writeRepoFile(".crysk", { max_changed_lines: 50 });
    const result = await deliverPlatformRepoLayer({
      repo: { default_base: "release" },
      root: fixture.workspace,
      dir: fixture.platformDir,
    });
    expect(result).toEqual({ status: "repo-file-wins", file: own });
    expect(existsSync(fixture.platformDir)).toBe(false);
  });

  test("the legacy .prhero/config.json counts as the repository's own file too", async () => {
    const legacy = await writeRepoFile(".prhero", { max_changed_lines: 50 });
    const result = await deliverPlatformRepoLayer({
      repo: { default_base: "release" },
      root: fixture.workspace,
      dir: fixture.platformDir,
    });
    expect(result).toEqual({ status: "repo-file-wins", file: legacy });
    expect(existsSync(fixture.platformDir)).toBe(false);
  });

  // resolveRepoDir picks .crysk as soon as it holds state (gotchas.md counts),
  // so the engine then looks for .crysk/config.json only. The decision must
  // follow the engine's own reader, not a second hand-written list of paths.
  test("follows the engine's reader: .crysk holding only gotchas.md hides a .prhero/config.json the engine would never read", async () => {
    await mkdir(path.join(fixture.workspace, ".crysk"), { recursive: true });
    await writeFile(path.join(fixture.workspace, ".crysk", "gotchas.md"), "x");
    await writeRepoFile(".prhero", { max_changed_lines: 50 });
    const result = await deliverPlatformRepoLayer({
      repo: { default_base: "release" },
      root: fixture.workspace,
      dir: fixture.platformDir,
    });
    expect(result.status).toBe("written");
  });

  test("an empty repo object writes nothing and changes nothing", async () => {
    const result = await deliverPlatformRepoLayer({
      repo: {},
      root: fixture.workspace,
      dir: fixture.platformDir,
    });
    expect(result).toEqual({ status: "empty" });
    expect(existsSync(fixture.platformDir)).toBe(false);
    expect(await readdir(fixture.workspace)).toEqual([]);
  });

  test("a value the engine's parser refuses fails loudly, naming the key and never the value", async () => {
    const promise = deliverPlatformRepoLayer({
      repo: { max_changed_lines: "SENTINEL-VALUE-9c1d" },
      root: fixture.workspace,
      dir: fixture.platformDir,
    });
    await expect(promise).rejects.toBeInstanceOf(PlatformConfigError);
    await promise.catch((error: Error) => {
      expect(error.message).toContain("max_changed_lines");
      expect(error.message).toContain("config.repo");
      expect(error.message).not.toContain("SENTINEL");
    });
    expect(existsSync(fixture.platformDir)).toBe(false);
  });

  test("a per-person key in the repo layer is refused by the engine's repo parser", async () => {
    await expect(
      deliverPlatformRepoLayer({
        repo: { routing: PLATFORM_ROUTING },
        root: fixture.workspace,
        dir: fixture.platformDir,
      }),
    ).rejects.toThrow(/config\.repo.*routing/s);
  });
});

describe("readPlatformConfig", () => {
  test("reads the file the connect step wrote", async () => {
    await mkdir(fixture.platformDir, { recursive: true });
    const file = path.join(fixture.platformDir, "platform-config.json");
    await writeFile(
      file,
      JSON.stringify({ person: { scout: true }, repo: { default_base: "x" } }),
    );
    expect(readPlatformConfig(file)).toEqual({
      person: { scout: true },
      repo: { default_base: "x" },
    });
  });

  test("a missing or malformed file fails loudly, naming the file", async () => {
    const missing = path.join(fixture.platformDir, "platform-config.json");
    expect(() => readPlatformConfig(missing)).toThrow(missing);
    await mkdir(fixture.platformDir, { recursive: true });
    await writeFile(missing, "{not json SENTINEL-FILE-5e2a");
    expect(() => readPlatformConfig(missing)).toThrow(missing);
    try {
      readPlatformConfig(missing);
    } catch (error) {
      expect((error as Error).message).not.toContain("SENTINEL");
    }
  });

  test("a body whose person or repo is not an object fails loudly", async () => {
    await mkdir(fixture.platformDir, { recursive: true });
    const file = path.join(fixture.platformDir, "platform-config.json");
    await writeFile(file, JSON.stringify({ person: [], repo: {} }));
    expect(() => readPlatformConfig(file)).toThrow(/config\.person/);
  });
});

describe("materializeCiOpenCodeData with a platform person layer", () => {
  const personPath = () => prheroLayout(fixture.home).reviewConfigPath;
  const run = (options: {
    routing?: string;
    platformPerson?: Record<string, unknown>;
  }) =>
    materializeCiOpenCodeData({
      home: fixture.home,
      env: { HOME: fixture.home },
      opencodeAuth: "",
      routing: options.routing ?? "",
      ...(options.platformPerson === undefined
        ? {}
        : { platformPerson: options.platformPerson }),
    });

  test("person keys land in the personal config file the engine reads", async () => {
    await run({
      platformPerson: { post_min_severity: "warning", max_changed_lines: 4000 },
    });
    expect(personPath()).toBe(path.join(fixture.home, ".crysk", "config.json"));
    expect(parseGlobalConfig(await readFile(personPath(), "utf8"))).toEqual({
      post_min_severity: "warning",
      max_changed_lines: 4000,
    });
  });

  test("platform routing wins over the routing input", async () => {
    await run({
      routing: INPUT_ROUTING,
      platformPerson: { routing: PLATFORM_ROUTING, scout: true },
    });
    const layer = parseGlobalConfig(await readFile(personPath(), "utf8"));
    expect(layer.routing?.default?.provider).toBe("deepseek");
    expect(layer.scout).toBe(true);
  });

  test("without platform routing the routing input is kept, beside the platform keys", async () => {
    await run({
      routing: INPUT_ROUTING,
      platformPerson: { post_min_severity: "blocking" },
    });
    const layer = parseGlobalConfig(await readFile(personPath(), "utf8"));
    expect(layer.routing?.default?.provider).toBe("openai");
    expect(layer.post_min_severity).toBe("blocking");
  });

  test("an empty person object changes nothing: the routing input alone is written as it always was", async () => {
    await run({ routing: INPUT_ROUTING, platformPerson: {} });
    const written = await readFile(personPath(), "utf8");
    expect(JSON.parse(written)).toEqual({
      routing: JSON.parse(INPUT_ROUTING),
    });
    await rm(path.dirname(personPath()), { recursive: true });
    await run({ platformPerson: {} });
    expect(existsSync(personPath())).toBe(false);
  });

  test("a key the person parser refuses fails loudly before anything is written, naming the key and not the value", async () => {
    const promise = run({
      platformPerson: { post_min_severity: "SENTINEL-LEVEL-77" },
    });
    await expect(promise).rejects.toBeInstanceOf(PlatformConfigError);
    await promise.catch((error: Error) => {
      expect(error.message).toContain("post_min_severity");
      expect(error.message).toContain("config.person");
      expect(error.message).not.toContain("SENTINEL");
    });
    expect(existsSync(personPath())).toBe(false);
  });

  test("a repo-direction key in the person layer is refused", async () => {
    await expect(
      run({ platformPerson: { default_base: "main" } }),
    ).rejects.toThrow(/default_base/);
    expect(existsSync(personPath())).toBe(false);
  });
});

// The proof the contract promises: the engine's REAL two-layer loader, given the
// personal file this change writes and the repo layer it delivers, resolves each
// key by that key's own rule.
describe("the engine's loader over what platform mode delivers", () => {
  const PERSON = {
    // direction "person": a floor the person layer sets.
    post_min_severity: "warning",
    // direction "capped": the person layer's ceiling; the repo may only lower it.
    max_changed_lines: 4000,
  };
  const REPO = {
    // "capped": the repo lowers the person's ceiling.
    max_changed_lines: 1000,
    // "repo": only this layer can speak.
    default_base: "release",
  };

  test("person, capped and repo keys each resolve by their own direction", async () => {
    await materializeCiOpenCodeData({
      home: fixture.home,
      env: { HOME: fixture.home },
      opencodeAuth: "",
      routing: "",
      platformPerson: PERSON,
    });
    const delivered = await deliverPlatformRepoLayer({
      repo: REPO,
      root: fixture.workspace,
      dir: fixture.platformDir,
    });
    expect(delivered.status).toBe("written");
    if (delivered.status !== "written") return;

    const loaded = await loadEffectiveConfig({
      root: fixture.workspace,
      home: fixture.home,
      configFlag: delivered.file,
    });
    expect(loaded.effective.post_min_severity).toBe("warning");
    expect(loaded.sources.post_min_severity).toBe("global");
    expect(loaded.effective.max_changed_lines).toBe(1000);
    expect(loaded.effective.default_base).toBe("release");
    expect(loaded.sources.default_base).toBe("repo");
    expect(loaded.globalPresent).toBe(true);
  });

  test("when the repository has its own file, the engine reads it whole and the platform layer never reaches the run", async () => {
    await materializeCiOpenCodeData({
      home: fixture.home,
      env: { HOME: fixture.home },
      opencodeAuth: "",
      routing: "",
      platformPerson: PERSON,
    });
    await writeRepoFile(".crysk", { max_changed_lines: 2500 });
    const delivered = await deliverPlatformRepoLayer({
      repo: REPO,
      root: fixture.workspace,
      dir: fixture.platformDir,
    });
    expect(delivered.status).toBe("repo-file-wins");

    // No --config is passed in this case: the engine's default repo read.
    const loaded = await loadEffectiveConfig({
      root: fixture.workspace,
      home: fixture.home,
    });
    expect(loaded.effective.max_changed_lines).toBe(2500);
    expect(loaded.effective.default_base).toBeUndefined();
    expect(loaded.effective.post_min_severity).toBe("warning");
  });
});

describe("setup.ts in platform mode (real entry point)", () => {
  async function runSetup(
    platform: unknown | undefined,
    options: { prepare?: () => Promise<void>; platformFile?: string } = {},
  ) {
    Bun.spawnSync(["git", "init", "-q"], { cwd: fixture.workspace });
    await options.prepare?.();
    let platformFile = options.platformFile ?? "";
    if (platform !== undefined) {
      await mkdir(fixture.platformDir, { recursive: true });
      platformFile = path.join(fixture.platformDir, "platform-config.json");
      await writeFile(platformFile, JSON.stringify(platform));
    }
    const githubOutput = path.join(fixture.runnerTemp, "github-output");
    await writeFile(githubOutput, "");
    const proc = Bun.spawn(["bun", SETUP_SCRIPT], {
      cwd: fixture.workspace,
      env: {
        ...process.env,
        HOME: fixture.home,
        ROUTING_INPUT: "",
        OPENCODE_AUTH_INPUT: "",
        CRYSK_OUTCOME_DIR: path.join(fixture.runnerTemp, "outcome"),
        GITHUB_OUTPUT: githubOutput,
        CRYSK_PLATFORM_CONFIG_FILE: platformFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      exitCode,
      stderr,
      output: await readFile(githubOutput, "utf8"),
    };
  }

  test("writes the person file and hands the repo layer to the run step as an output", async () => {
    const result = await runSetup({
      person: { post_min_severity: "warning" },
      repo: { default_base: "release" },
    });
    expect(result.exitCode).toBe(0);
    expect(
      parseGlobalConfig(
        await readFile(prheroLayout(fixture.home).reviewConfigPath, "utf8"),
      ),
    ).toEqual({ post_min_severity: "warning" });
    const repoConfig = /^repo-config=(.+)$/m.exec(result.output)?.[1];
    expect(repoConfig).toBe(
      path.join(fixture.platformDir, "platform-repo-config.json"),
    );
    expect(JSON.parse(await readFile(repoConfig as string, "utf8"))).toEqual({
      default_base: "release",
    });
  });

  test("a repository with its own file gets a ::notice:: and no repo-config output", async () => {
    const result = await runSetup(
      { person: {}, repo: { default_base: "release" } },
      {
        prepare: async () => {
          await writeRepoFile(".crysk", { max_changed_lines: 50 });
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("::notice::");
    expect(result.stderr).toContain(".crysk/config.json");
    expect(result.output).not.toContain("repo-config=");
    expect(existsSync(prheroLayout(fixture.home).reviewConfigPath)).toBe(false);
  });

  test("empty objects write nothing and output nothing", async () => {
    const result = await runSetup({ person: {}, repo: {} });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
    expect(result.stderr).not.toContain("::notice::");
    expect(existsSync(prheroLayout(fixture.home).reviewConfigPath)).toBe(false);
  });

  test("an invalid repo layer fails the step with an ::error:: naming the key, never the value", async () => {
    const result = await runSetup({
      person: {},
      repo: { max_changed_files: "SENTINEL-VALUE-aa11" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("::error::");
    expect(result.stderr).toContain("max_changed_files");
    expect(result.stderr).not.toContain("SENTINEL");
    expect(result.output).not.toContain("repo-config=");
  });

  test("an invalid person layer fails the step with an ::error:: and writes no personal file", async () => {
    const result = await runSetup({
      person: { post_min_severity: "SENTINEL-LEVEL-77" },
      repo: {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("::error::");
    expect(result.stderr).toContain("post_min_severity");
    expect(result.stderr).not.toContain("SENTINEL");
    expect(existsSync(prheroLayout(fixture.home).reviewConfigPath)).toBe(false);
  });

  test("a platform config file that cannot be read fails the step naming the file", async () => {
    const missing = path.join(fixture.platformDir, "gone.json");
    const result = await runSetup(undefined, { platformFile: missing });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("::error::");
    expect(result.stderr).toContain(missing);
  });

  test("standalone: no platform config file, no output, the same exit as before", async () => {
    const result = await runSetup(undefined);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
    expect(result.stderr).toBe("");
  });
});
