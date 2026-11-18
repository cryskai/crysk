// `pr-hero skills install` / `crysk skills load`: driven through injected
// deps (an in-memory filesystem over a fake HOME), so nothing touches ~/.
// The skill sources are the real bundled assets, read through the readFile fallback.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
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
import {
  delegateSkillsLoad,
  newestPlainVersion,
  resolveCryskVersion,
  resolveSkillsSpec,
  skillsInstallCommand,
  skillsLoadCommand,
  workflowCryskSpec,
} from "#commands/skills";
import { parseArgs } from "#review/preflight";
import { resolveEngineAssets } from "../../src/assets";
import { CliUsageError } from "../../src/errors";
import {
  readCachedSkillFile,
  recordEngineVersion,
} from "../../src/skills-cache";

const HOME = "/fake/home";
const SKILL_DIR = `${HOME}/.claude/skills/crysk-loop`;
const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;

function makeDeps(seed: Record<string, string> = {}, dirs: string[] = []) {
  const files = new Map<string, string>(Object.entries(seed));
  const dirSet = new Set<string>(dirs);
  const lines: string[] = [];
  return {
    files,
    lines,
    deps: {
      home: HOME,
      which: () => null,
      exists: (p: string) => files.has(p) || dirSet.has(p),
      readFile: (p: string) => {
        if (files.has(p)) return files.get(p);
        if (p.startsWith(HOME)) return undefined;
        return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
      },
      writeFile: (p: string, c: string) => {
        files.set(p, c);
      },
      log: (line: string) => {
        lines.push(line);
      },
    },
  };
}

const install = (force = false) =>
  parseArgs(force ? ["skills", "install", "--force"] : ["skills", "install"])
    .options;

describe("skillsInstallCommand", () => {
  test("installs the triage skill into the detected Claude Code skills dir", async () => {
    const { files, lines, deps } = makeDeps({}, [`${HOME}/.claude`]);
    const code = await skillsInstallCommand(install(), deps);

    const upstream = readFileSync(
      resolveEngineAssets().triageSkillFiles["SKILL.md"] ?? "",
      "utf-8",
    );
    expect(code).toBe(0);
    expect(files.get(SKILL_FILE)).toBe(upstream);
    expect(lines.some((l) => l.startsWith("installed "))).toBe(true);
    expect(lines.some((l) => l.includes("Claude Code"))).toBe(true);
  });

  test("a second run reports the skills as up to date", async () => {
    const { lines, deps } = makeDeps({}, [`${HOME}/.claude`]);
    await skillsInstallCommand(install(), deps);
    lines.length = 0;

    const code = await skillsInstallCommand(install(), deps);
    expect(code).toBe(0);
    expect(lines).toEqual(["skills already up to date for Claude Code"]);
  });

  test("a locally edited skill is kept without --force and reported as drift", async () => {
    const { files, lines, deps } = makeDeps({}, [`${HOME}/.claude`]);
    await skillsInstallCommand(install(), deps);
    files.set(SKILL_FILE, "my local edits\n");
    lines.length = 0;

    const code = await skillsInstallCommand(install(), deps);
    expect(code).toBe(1);
    expect(files.get(SKILL_FILE)).toBe("my local edits\n");
    expect(lines).toContain(
      "local edits found in Claude Code's crysk skills; rerun with --force to overwrite them",
    );
  });

  test("with --force a locally edited skill is overwritten", async () => {
    const { files, deps } = makeDeps({}, [`${HOME}/.claude`]);
    await skillsInstallCommand(install(), deps);
    files.set(SKILL_FILE, "my local edits\n");

    const code = await skillsInstallCommand(install(true), deps);
    const upstream = readFileSync(
      resolveEngineAssets().triageSkillFiles["SKILL.md"] ?? "",
      "utf-8",
    );
    expect(code).toBe(0);
    expect(files.get(SKILL_FILE)).toBe(upstream);
  });

  test("no coding agent detected prints the no-agent line and returns 1", async () => {
    const { lines, deps } = makeDeps({}, []);
    const code = await skillsInstallCommand(install(), deps);
    expect(code).toBe(1);
    expect(lines).toEqual([
      "no coding agent with a skills directory was found (Claude Code, Cursor, Windsurf, Codex, Antigravity, OpenCode)",
    ]);
  });

  // The old-name cleanup is real file removal, so these use a real temporary HOME.
  describe("pre-rename skill dirs", () => {
    const sha = (text: string) =>
      crypto.createHash("sha256").update(text).digest("hex");
    let realHome: string;
    beforeEach(() => {
      realHome = mkdtempSync(path.join(tmpdir(), "crysk-skills-cmd-"));
    });
    afterEach(() => {
      rmSync(realHome, { recursive: true, force: true });
    });

    function legacyDir(name: string, content: string, recorded = content) {
      const dir = path.join(realHome, ".claude", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), content);
      writeFileSync(
        path.join(dir, "digest.json"),
        JSON.stringify({ files: { "SKILL.md": sha(recorded) } }),
      );
      return dir;
    }

    test("reports an unedited old copy as removed", async () => {
      const dir = legacyDir("pr-hero-triage", "old\n");
      const lines: string[] = [];
      const code = await skillsInstallCommand(install(), {
        home: realHome,
        which: () => null,
        log: (l) => lines.push(l),
      });

      expect(code).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(lines).toContain(
        "removed the old pr-hero-triage skill from Claude Code",
      );
    });

    test("keeps and reports an edited old copy", async () => {
      const dir = legacyDir("pr-hero-triage", "mine\n", "old\n");
      const lines: string[] = [];
      const code = await skillsInstallCommand(install(), {
        home: realHome,
        which: () => null,
        log: (l) => lines.push(l),
      });

      expect(code).toBe(0);
      expect(readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe("mine\n");
      expect(
        lines.find((l) => l.startsWith("kept the old pr-hero-triage skill")),
      ).toContain("edited SKILL.md kept");
    });
  });
});

describe("skillsLoadCommand", () => {
  test("prints playbook.md for every shipped skill to stdout without network or disk writes", async () => {
    const assets = resolveEngineAssets();
    const cases: Array<[string, string]> = [
      ["crysk", assets.generalSkillFiles["playbook.md"] ?? ""],
      ["crysk-loop", assets.triageSkillFiles["playbook.md"] ?? ""],
      ["crysk-pr", assets.prSkillFiles["playbook.md"] ?? ""],
      ["crysk-ci-setup", assets.ciSetupSkillFiles["playbook.md"] ?? ""],
    ];
    for (const [skillName, expectedPath] of cases) {
      const out: string[] = [];
      const code = await skillsLoadCommand(
        parseArgs(["skills", "load", skillName]).options,
        {
          assets,
          env: { CRYSK_SKILLS_DELEGATED: "1" },
          writeStdout: (text) => out.push(text),
        },
      );
      const raw = readFileSync(expectedPath, "utf-8");
      const expected = raw.endsWith("\n") ? raw : `${raw}\n`;
      expect(code).toBe(0);
      expect(out.join("")).toBe(expected);
    }
  });

  test("prints companion files (adjudicator.md, references/*, assets/*) on demand", async () => {
    const assets = resolveEngineAssets();
    const cases: Array<[string, string, string]> = [
      [
        "crysk-loop",
        "adjudicator.md",
        assets.triageSkillFiles["adjudicator.md"] ?? "",
      ],
      [
        "crysk-ci-setup",
        "assets/workflow.yml",
        assets.ciSetupSkillFiles["assets/workflow.yml"] ?? "",
      ],
      [
        "crysk-ci-setup",
        "assets/admission-config.example.json",
        assets.ciSetupSkillFiles["assets/admission-config.example.json"] ?? "",
      ],
      [
        "crysk-ci-setup",
        "references/opencode-ci.md",
        assets.ciSetupSkillFiles["references/opencode-ci.md"] ?? "",
      ],
      [
        "crysk-ci-setup",
        "references/ci-admission.md",
        assets.ciSetupSkillFiles["references/ci-admission.md"] ?? "",
      ],
    ];
    for (const [skillName, fileName, expectedPath] of cases) {
      const out: string[] = [];
      const code = await skillsLoadCommand(
        parseArgs(["skills", "load", skillName, fileName]).options,
        {
          assets,
          env: { CRYSK_SKILLS_DELEGATED: "1" },
          writeStdout: (text) => out.push(text),
        },
      );
      const raw = readFileSync(expectedPath, "utf-8");
      const expected = raw.endsWith("\n") ? raw : `${raw}\n`;
      expect(code).toBe(0);
      expect(out.join("")).toBe(expected);
    }
  });

  test("rejects unknown skill names, unknown companion files, and prototype keys", async () => {
    const env = { CRYSK_SKILLS_DELEGATED: "1" };
    await expect(
      skillsLoadCommand(parseArgs(["skills", "load", "nonexistent"]).options, {
        env,
      }),
    ).rejects.toThrow(CliUsageError);
    await expect(
      skillsLoadCommand(
        parseArgs(["skills", "load", "crysk-loop", "missing.md"]).options,
        { env },
      ),
    ).rejects.toThrow(CliUsageError);
    await expect(
      skillsLoadCommand(
        parseArgs(["skills", "load", "crysk-loop", "toString"]).options,
        { env },
      ),
    ).rejects.toThrow(CliUsageError);
  });
});

// Which crysk the playbook comes from: the engine version status recorded for
// the repository, then the workflow's `uses:` line, then the latest.
describe("resolveSkillsSpec", () => {
  const workflow = (ref: string) =>
    `jobs:\n  review:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: cryskai/crysk@${ref}\n`;

  test("the recorded engine version wins over the workflow", () => {
    expect(
      resolveSkillsSpec({ recorded: "0.10.0", workflows: [workflow("v0")] }),
    ).toBe("0.10.0");
  });

  test("an exact workflow pin gives its exact version", () => {
    expect(
      resolveSkillsSpec({
        recorded: undefined,
        workflows: [workflow("v0.8.1")],
      }),
    ).toBe("0.8.1");
  });

  test("a moving tag gives the same major, whichever major it is", () => {
    expect(
      resolveSkillsSpec({ recorded: undefined, workflows: [workflow("v0")] }),
    ).toBe("0");
    expect(
      resolveSkillsSpec({ recorded: undefined, workflows: [workflow("v1")] }),
    ).toBe("1");
  });

  test("the legacy action name counts too", () => {
    expect(
      workflowCryskSpec(["    - uses: juanmaagd/pr-hero@v0.7.0 # pinned\n"]),
    ).toBe("0.7.0");
  });

  test("no workflow, a SHA pin or another action gives the latest", () => {
    expect(resolveSkillsSpec({ recorded: undefined, workflows: [] })).toBe(
      "latest",
    );
    expect(
      resolveSkillsSpec({
        recorded: undefined,
        workflows: [workflow("0123456789abcdef0123456789abcdef01234567")],
      }),
    ).toBe("latest");
    expect(
      resolveSkillsSpec({
        recorded: undefined,
        workflows: ["      - uses: someone/crysk-fork@v9\n"],
      }),
    ).toBe("latest");
  });
});

describe("skillsLoadCommand — which crysk prints the playbook", () => {
  const assets = resolveEngineAssets();
  const bundledPlaybook = () =>
    readFileSync(assets.triageSkillFiles["playbook.md"] ?? "", "utf-8");
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "crysk-skills-load-home-"));
    repo = mkdtempSync(path.join(tmpdir(), "crysk-skills-load-repo-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  function writeWorkflow(ref: string) {
    const dir = path.join(repo, ".github", "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "crysk.yml"),
      `jobs:\n  r:\n    steps:\n      - uses: cryskai/crysk@${ref}\n`,
    );
  }

  async function load(
    options: {
      file?: string;
      delegated?: string;
      repoRoot?: string | undefined;
      resolved?: string;
    } = {},
  ) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: Array<[string, string, string | undefined]> = [];
    const lookups: string[] = [];
    const args = ["skills", "load", "crysk-loop"];
    if (options.file !== undefined) args.push(options.file);
    const code = await skillsLoadCommand(parseArgs(args).options, {
      assets,
      home,
      env: {},
      repoRoot: async () => ("repoRoot" in options ? options.repoRoot : repo),
      resolveVersion: async (spec) => {
        lookups.push(spec);
        return options.resolved;
      },
      delegate: async (spec, skill, file) => {
        calls.push([spec, skill, file]);
        return options.delegated;
      },
      writeStdout: (text) => out.push(text),
      writeStderr: (text) => err.push(text),
    });
    return { code, out: out.join(""), err: err.join(""), calls, lookups };
  }

  test("delegates to the version status recorded and caches what it printed", async () => {
    recordEngineVersion(home, repo, "0.42.0");
    const first = await load({ delegated: "# playbook 0.42.0\n" });
    expect(first.code).toBe(0);
    expect(first.calls).toEqual([["0.42.0", "crysk-loop", undefined]]);
    expect(first.out).toBe("# playbook 0.42.0\n");
    expect(
      readCachedSkillFile(home, "0.42.0", "crysk-loop", "playbook.md"),
    ).toBe("# playbook 0.42.0\n");

    // The second load is served from the per-version cache, with no npx.
    const second = await load({ delegated: "never used" });
    expect(second.calls).toEqual([]);
    expect(second.out).toBe("# playbook 0.42.0\n");
  });

  test("delegates a companion file by its name and caches it under that name", async () => {
    recordEngineVersion(home, repo, "0.42.0");
    const result = await load({ file: "adjudicator.md", delegated: "adj" });
    expect(result.calls).toEqual([["0.42.0", "crysk-loop", "adjudicator.md"]]);
    expect(result.out).toBe("adj\n");
    expect(
      readCachedSkillFile(home, "0.42.0", "crysk-loop", "adjudicator.md"),
    ).toBe("adj");
  });

  test("prints the bundled playbook with no npx when the version is its own", async () => {
    recordEngineVersion(home, repo, assets.version);
    const result = await load({ delegated: "never used" });
    expect(result.calls).toEqual([]);
    expect(result.out).toBe(bundledPlaybook());
  });

  // npx keeps running the copy it cached for a range, so a moving tag has to be
  // resolved to an exact version here or the agent stays on its first download.
  test("resolves the workflow's moving tag to an exact version on every load", async () => {
    writeWorkflow("v0");
    const first = await load({ resolved: "0.42.0", delegated: "# 0.42.0\n" });
    expect(first.lookups).toEqual(["0"]);
    expect(first.calls).toEqual([["0.42.0", "crysk-loop", undefined]]);
    expect(first.out).toBe("# 0.42.0\n");

    const same = await load({ resolved: "0.42.0", delegated: "never used" });
    expect(same.calls).toEqual([]);
    expect(same.out).toBe("# 0.42.0\n");

    const newer = await load({ resolved: "0.43.0", delegated: "# 0.43.0\n" });
    expect(newer.calls).toEqual([["0.43.0", "crysk-loop", undefined]]);
    expect(newer.out).toBe("# 0.43.0\n");
  });

  test("follows an exact workflow pin with no version lookup", async () => {
    writeWorkflow("v0.8.1");
    const result = await load({ delegated: "# 0.8.1\n" });
    expect(result.lookups).toEqual([]);
    expect(result.calls).toEqual([["0.8.1", "crysk-loop", undefined]]);
  });

  test("a recorded engine version needs no lookup", async () => {
    recordEngineVersion(home, repo, "0.42.0");
    writeWorkflow("v0");
    const result = await load({ delegated: "# 0.42.0\n" });
    expect(result.lookups).toEqual([]);
  });

  test("loads the exact latest version outside a repository", async () => {
    const result = await load({
      repoRoot: undefined,
      resolved: "0.50.0",
      delegated: "# latest\n",
    });
    expect(result.lookups).toEqual(["latest"]);
    expect(result.calls).toEqual([["0.50.0", "crysk-loop", undefined]]);
    expect(result.out).toBe("# latest\n");
  });

  test("prints the bundled playbook with no npx when the tag resolves to its own version", async () => {
    writeWorkflow("v0");
    const result = await load({ resolved: assets.version, delegated: "no" });
    expect(result.calls).toEqual([]);
    expect(result.out).toBe(bundledPlaybook());
    expect(result.err).toBe("");
  });

  test("prints the bundled playbook and warns when the version cannot be resolved", async () => {
    writeWorkflow("v0");
    const result = await load({ delegated: "never used" });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.out).toBe(bundledPlaybook());
    expect(result.err).toContain("could not load crysk-loop from crysk@0;");
  });

  test("prints the bundled playbook and warns when the delegation fails", async () => {
    recordEngineVersion(home, repo, "0.42.0");
    const result = await load({ delegated: undefined });
    expect(result.code).toBe(0);
    expect(result.out).toBe(bundledPlaybook());
    expect(result.err).toContain("could not load crysk-loop from crysk@0.42.0");
    expect(
      readCachedSkillFile(home, "0.42.0", "crysk-loop", "playbook.md"),
    ).toBeUndefined();
  });

  test("a delegated child prints its own bundle and resolves nothing", async () => {
    recordEngineVersion(home, repo, "0.42.0");
    const out: string[] = [];
    let delegated = false;
    await skillsLoadCommand(
      parseArgs(["skills", "load", "crysk-loop"]).options,
      {
        assets,
        home,
        env: { CRYSK_SKILLS_DELEGATED: "1" },
        repoRoot: async () => repo,
        delegate: async () => {
          delegated = true;
          return "x";
        },
        writeStdout: (text) => out.push(text),
      },
    );
    expect(delegated).toBe(false);
    expect(out.join("")).toBe(bundledPlaybook());
  });
});

// The real npx seam: argv, the child's env, and the bound.
describe("newestPlainVersion", () => {
  test("compares numerically and ignores anything but x.y.z", () => {
    expect(
      newestPlainVersion('["0.9.0","0.10.0","0.11.0-rc.1","latest"]'),
    ).toBe("0.10.0");
    expect(newestPlainVersion('"0.9.0"')).toBe("0.9.0");
  });

  test("gives nothing for an empty or unreadable answer", () => {
    expect(newestPlainVersion("")).toBeUndefined();
    expect(newestPlainVersion("not json")).toBeUndefined();
    expect(newestPlainVersion("[]")).toBeUndefined();
    expect(newestPlainVersion('{"error":{"code":"E404"}}')).toBeUndefined();
  });
});

describe("delegateSkillsLoad", () => {
  function fakeSpawn(stdout: string, exitCode: number, hang = false) {
    const seen: { argv: string[]; env: Record<string, string | undefined> }[] =
      [];
    const spawnFn = ((
      argv: string[],
      opts: { env: Record<string, string | undefined> },
    ) => {
      seen.push({ argv, env: opts.env });
      let close: () => void = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (hang) {
            close = () => controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
        cancel() {
          close();
        },
      });
      return {
        stdout: stream,
        exited: hang
          ? new Promise<number>(() => {})
          : Promise.resolve(exitCode),
        kill: () => close(),
      };
    }) as unknown as typeof Bun.spawn;
    return { spawnFn, seen };
  }

  test("runs the exact spec with the delegated flag and returns its stdout", async () => {
    const { spawnFn, seen } = fakeSpawn("# pb\n", 0);
    const out = await delegateSkillsLoad(
      "0.42.0",
      "crysk-loop",
      "adjudicator.md",
      {
        spawnFn,
      },
    );
    expect(out).toBe("# pb\n");
    expect(seen[0]?.argv).toEqual([
      "npx",
      "-y",
      "crysk@0.42.0",
      "skills",
      "load",
      "crysk-loop",
      "adjudicator.md",
    ]);
    expect(seen[0]?.env.CRYSK_SKILLS_DELEGATED).toBe("1");
  });

  test("asks npm for the versions the spec matches and takes the newest", async () => {
    const { spawnFn, seen } = fakeSpawn('["0.9.0","0.10.0"]', 0);
    expect(await resolveCryskVersion("0", { spawnFn })).toBe("0.10.0");
    expect(seen[0]?.argv).toEqual([
      "npm",
      "view",
      "crysk@0",
      "version",
      "--json",
      "--prefer-online",
    ]);
  });

  test("a failed or stalled version lookup gives nothing", async () => {
    expect(
      await resolveCryskVersion("99", {
        spawnFn: fakeSpawn('{"error":{"code":"E404"}}', 1).spawnFn,
      }),
    ).toBeUndefined();
    expect(
      await resolveCryskVersion("0", {
        spawnFn: fakeSpawn("", 0, true).spawnFn,
        timeoutMs: 20,
      }),
    ).toBeUndefined();
  });

  test("a failing child, an empty stdout or a timeout gives nothing", async () => {
    expect(
      await delegateSkillsLoad("0.9.0", "crysk-loop", undefined, {
        spawnFn: fakeSpawn("usage", 2).spawnFn,
      }),
    ).toBeUndefined();
    expect(
      await delegateSkillsLoad("0.42.0", "crysk-loop", undefined, {
        spawnFn: fakeSpawn("", 0).spawnFn,
      }),
    ).toBeUndefined();
    expect(
      await delegateSkillsLoad("0.42.0", "crysk-loop", undefined, {
        spawnFn: fakeSpawn("", 0, true).spawnFn,
        timeoutMs: 20,
      }),
    ).toBeUndefined();
  });
});
