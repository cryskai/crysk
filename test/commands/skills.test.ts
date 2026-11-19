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

  test("writes only SKILL.md and digest.json for each skill", async () => {
    const { files, deps } = makeDeps({}, [`${HOME}/.claude`]);

    expect(await skillsInstallCommand(install(), deps)).toBe(0);

    const written = [...files.keys()]
      .map((p) => p.slice(`${HOME}/.claude/skills/`.length))
      .sort();
    expect(written).toEqual([
      "crysk-ci-setup/SKILL.md",
      "crysk-ci-setup/digest.json",
      "crysk-loop/SKILL.md",
      "crysk-loop/digest.json",
      "crysk-pr/SKILL.md",
      "crysk-pr/digest.json",
      "crysk/SKILL.md",
      "crysk/digest.json",
    ]);
  });

  test("reports each companion copy it removed or kept, and still succeeds", async () => {
    const sha = (text: string) =>
      crypto.createHash("sha256").update(text).digest("hex");
    const { files, lines, deps } = makeDeps({}, [`${HOME}/.claude`]);
    await skillsInstallCommand(install(), deps);
    const digestFile = `${SKILL_DIR}/digest.json`;
    const digest = JSON.parse(files.get(digestFile) ?? "{}");
    digest.files["playbook.md"] = sha("old playbook\n");
    digest.files["adjudicator.md"] = sha("old adjudicator\n");
    files.set(digestFile, JSON.stringify(digest));
    files.set(`${SKILL_DIR}/playbook.md`, "old playbook\n");
    files.set(`${SKILL_DIR}/adjudicator.md`, "my notes\n");
    lines.length = 0;

    const code = await skillsInstallCommand(install(), {
      ...deps,
      unlink: (p: string) => {
        files.delete(p);
      },
      rmdir: () => {},
    });

    expect(code).toBe(0);
    expect(files.has(`${SKILL_DIR}/playbook.md`)).toBe(false);
    expect(files.get(`${SKILL_DIR}/adjudicator.md`)).toBe("my notes\n");
    expect(lines).toEqual([
      "removed the installed copy of crysk-loop/playbook.md from Claude Code; crysk skills load serves it now",
      "kept crysk-loop/adjudicator.md in Claude Code (edited since it was installed); nothing reads it now, delete it by hand when you no longer need it",
      "skills already up to date for Claude Code",
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
        "references/ci-operations.md",
        assets.ciSetupSkillFiles["references/ci-operations.md"] ?? "",
      ],
      [
        "crysk-loop",
        "dismissal.md",
        assets.triageSkillFiles["dismissal.md"] ?? "",
      ],
      [
        "crysk-loop",
        "fix-the-class.md",
        assets.triageSkillFiles["fix-the-class.md"] ?? "",
      ],
      [
        "crysk-loop",
        "gate-rules.md",
        assets.triageSkillFiles["gate-rules.md"] ?? "",
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

  test("a long run of blank lines is read in linear time", () => {
    const started = Date.now();
    expect(workflowCryskSpec([`${"\n".repeat(200_000)}x`])).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
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
    git("init", "-q", "-b", "main");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    const result = Bun.spawnSync([
      "git",
      "-C",
      repo,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
  }

  const usesLine = (ref: string) =>
    `jobs:\n  r:\n    steps:\n      - uses: cryskai/crysk@${ref}\n`;

  function writeWorktreeFile(name: string, content: string) {
    const dir = path.join(repo, ".github", "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }

  function commitAll() {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "change");
  }

  // Commits the tree and makes that commit what origin/HEAD names.
  function publishDefaultBranch() {
    commitAll();
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  }

  function writeWorkflow(ref: string) {
    writeWorktreeFile("crysk.yml", usesLine(ref));
    publishDefaultBranch();
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
    const first = await load({
      resolved: "0.42.0",
      delegated: "# playbook 0.42.0\n",
    });
    expect(first.code).toBe(0);
    expect(first.lookups).toEqual(["0.42.0"]);
    expect(first.calls).toEqual([["0.42.0", "crysk-loop", undefined]]);
    expect(first.out).toBe("# playbook 0.42.0\n");
    expect(
      readCachedSkillFile(home, "0.42.0", "crysk-loop", "playbook.md"),
    ).toBe("# playbook 0.42.0\n");

    // The second load is served from the per-version cache, with no npx.
    const second = await load({ delegated: "never used" });
    expect(second.calls).toEqual([]);
    expect(second.lookups).toEqual([]);
    expect(second.out).toBe("# playbook 0.42.0\n");
  });

  test("delegates a companion file by its name and caches it under that name", async () => {
    recordEngineVersion(home, repo, "0.42.0");
    const result = await load({
      file: "adjudicator.md",
      resolved: "0.42.0",
      delegated: "adj",
    });
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
    expect(result.lookups).toEqual([]);
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

  // A pull request's author controls the checked-out branch and every file in
  // the worktree, and what this picks is run and handed to the agent.
  describe("the workflow comes from the default branch", () => {
    test("an uncommitted edit in the worktree is not read", async () => {
      writeWorkflow("v0.8.1");
      writeWorktreeFile("crysk.yml", usesLine("v0.9.9"));

      const result = await load({ resolved: "0.8.1", delegated: "# 0.8.1\n" });

      expect(result.lookups).toEqual(["0.8.1"]);
      expect(result.calls).toEqual([["0.8.1", "crysk-loop", undefined]]);
      expect(result.out).toBe("# 0.8.1\n");
    });

    test("a checked-out branch cannot change it, even one named like the remote ref", async () => {
      writeWorkflow("v0.8.1");
      git("checkout", "-q", "-b", "attacker");
      writeWorktreeFile("crysk.yml", usesLine("v0.9.9"));
      commitAll();
      git("branch", "origin/main", "attacker");
      git("tag", "origin/main", "attacker");

      const result = await load({ resolved: "0.8.1", delegated: "# 0.8.1\n" });

      expect(result.lookups).toEqual(["0.8.1"]);
      expect(result.calls).toEqual([["0.8.1", "crysk-loop", undefined]]);
    });

    test("no resolvable default branch means no workflow", async () => {
      writeWorktreeFile("crysk.yml", usesLine("v0.8.1"));
      commitAll();

      const result = await load({
        resolved: "0.50.0",
        delegated: "# latest\n",
      });

      expect(result.lookups).toEqual(["latest"]);
      expect(result.calls).toEqual([["0.50.0", "crysk-loop", undefined]]);
    });

    test("a symlink entry is skipped even when its blob reads as a pin", async () => {
      const blob = path.join(home, "blob");
      writeFileSync(blob, usesLine("v0.8.1"));
      const sha = git("hash-object", "-w", blob);
      git(
        "update-index",
        "--add",
        "--cacheinfo",
        `120000,${sha},.github/workflows/link.yml`,
      );
      git("commit", "-q", "-m", "link");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git(
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      );

      const result = await load({
        resolved: "0.50.0",
        delegated: "# latest\n",
      });

      expect(result.lookups).toEqual(["latest"]);
    });

    test("a blob over 256 KiB or another file type is skipped", async () => {
      writeWorktreeFile(
        "big.yml",
        `${usesLine("v0.7.0")}${"#".repeat(256 * 1024)}\n`,
      );
      writeWorktreeFile("notes.txt", usesLine("v0.6.0"));
      publishDefaultBranch();

      const result = await load({
        resolved: "0.50.0",
        delegated: "# latest\n",
      });

      expect(result.lookups).toEqual(["latest"]);
    });

    test("a blob of exactly 256 KiB still counts, as does an executable one", async () => {
      const line = usesLine("v0.8.1");
      writeWorktreeFile(
        "exact.yaml",
        `${line}${"#".repeat(256 * 1024 - line.length)}`,
      );
      publishDefaultBranch();
      expect((await load({ resolved: "0.8.1" })).lookups).toEqual(["0.8.1"]);

      rmSync(path.join(repo, ".github", "workflows", "exact.yaml"));
      writeWorktreeFile("run.yml", usesLine("v0.8.2"));
      git("add", "-A");
      git("update-index", "--chmod=+x", ".github/workflows/run.yml");
      git("commit", "-q", "-m", "exec");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      expect((await load({ resolved: "0.8.2" })).lookups).toEqual(["0.8.2"]);
    });
  });

  // npm alone must not be able to put a version in front of the agent: an exact
  // version from a workflow or a review comment has to be a release tag first.
  describe("an exact version must exist as a GitHub tag", () => {
    test("a pinned version with its tag is delegated", async () => {
      writeWorkflow("v0.8.1");
      const result = await load({ resolved: "0.8.1", delegated: "# 0.8.1\n" });
      expect(result.lookups).toEqual(["0.8.1"]);
      expect(result.calls).toEqual([["0.8.1", "crysk-loop", undefined]]);
      expect(result.out).toBe("# 0.8.1\n");
      expect(result.err).toBe("");
    });

    test("a recorded version outranks the workflow and is checked too", async () => {
      recordEngineVersion(home, repo, "0.42.0");
      writeWorkflow("v0");
      const result = await load({
        resolved: "0.42.0",
        delegated: "# 0.42.0\n",
      });
      expect(result.lookups).toEqual(["0.42.0"]);
      expect(result.calls).toEqual([["0.42.0", "crysk-loop", undefined]]);
    });

    for (const [label, resolved] of [
      ["has no tag or cannot be checked", undefined],
      ["resolves to another version", "0.8.2"],
    ] as const) {
      test(`a pinned version that ${label} is never run`, async () => {
        writeWorkflow("v0.8.1");
        const result = await load({ resolved, delegated: "# planted\n" });

        expect(result.code).toBe(0);
        expect(result.calls).toEqual([]);
        expect(result.out).toBe(bundledPlaybook());
        expect(result.err).toContain(
          "could not load crysk-loop from crysk@0.8.1;",
        );
        expect(
          readCachedSkillFile(home, "0.8.1", "crysk-loop", "playbook.md"),
        ).toBeUndefined();
      });
    }

    test("a recorded version with no tag is never run", async () => {
      recordEngineVersion(home, repo, "0.42.0");
      const result = await load({ delegated: "# planted\n" });

      expect(result.calls).toEqual([]);
      expect(result.out).toBe(bundledPlaybook());
      expect(result.err).toContain(
        "could not load crysk-loop from crysk@0.42.0",
      );
    });

    test("a version a moving tag resolved to is looked up once", async () => {
      writeWorkflow("v0");
      const result = await load({
        resolved: "0.42.0",
        delegated: "# 0.42.0\n",
      });
      expect(result.lookups).toEqual(["0"]);
      expect(result.calls).toEqual([["0.42.0", "crysk-loop", undefined]]);
    });
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
    const result = await load({ resolved: "0.42.0", delegated: undefined });
    expect(result.calls).toEqual([["0.42.0", "crysk-loop", undefined]]);
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

  const COMMIT = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const tagLines = (rows: Array<[string, string]>) =>
    rows.map(([sha, ref]) => `${sha}\t${ref}`).join("\n");

  // The version a moving tag points to is what the CI runs. npm cannot say
  // that, and asking it would let a release published only to npm reach agents.
  test("resolves a moving tag to the release on the same commit", async () => {
    const { spawnFn, seen } = fakeSpawn(
      tagLines([
        ["1".repeat(40), "refs/tags/v0"],
        [COMMIT, "refs/tags/v0^{}"],
        ["2".repeat(40), "refs/tags/v0.9.0"],
        [COMMIT, "refs/tags/v0.9.0^{}"],
        ["3".repeat(40), "refs/tags/v0.10.0"],
        [OTHER, "refs/tags/v0.10.0^{}"],
      ]),
      0,
    );
    expect(await resolveCryskVersion("0", { spawnFn })).toBe("0.9.0");
    expect(seen[0]?.argv).toEqual([
      "git",
      "ls-remote",
      "--tags",
      "https://github.com/cryskai/crysk",
      "refs/tags/v0",
      "refs/tags/v0^{}",
      "refs/tags/v0.*",
    ]);
    expect(seen[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  // The check `skills load` makes before running a recorded or pinned version.
  test("an exact version comes back only when its own tag exists", async () => {
    const present = fakeSpawn(
      tagLines([
        ["1".repeat(40), "refs/tags/v0.8.1"],
        [COMMIT, "refs/tags/v0.8.1^{}"],
      ]),
      0,
    );
    expect(
      await resolveCryskVersion("0.8.1", { spawnFn: present.spawnFn }),
    ).toBe("0.8.1");
    expect(present.seen[0]?.argv.slice(4, 6)).toEqual([
      "refs/tags/v0.8.1",
      "refs/tags/v0.8.1^{}",
    ]);

    const absent = fakeSpawn("", 0);
    expect(
      await resolveCryskVersion("0.8.1", { spawnFn: absent.spawnFn }),
    ).toBeUndefined();
  });

  test("reads lightweight tags and takes the newest release on the commit", async () => {
    const { spawnFn } = fakeSpawn(
      tagLines([
        [COMMIT, "refs/tags/v1"],
        [COMMIT, "refs/tags/v1.9.0"],
        [COMMIT, "refs/tags/v1.10.0"],
        [COMMIT, "refs/tags/v1.11.0-rc.1"],
      ]),
      0,
    );
    expect(await resolveCryskVersion("1", { spawnFn })).toBe("1.10.0");
  });

  test("a tag with no release on its commit, a failure or a stall gives nothing", async () => {
    const noRelease = tagLines([
      [COMMIT, "refs/tags/v0"],
      [OTHER, "refs/tags/v0.9.0"],
    ]);
    const noTag = tagLines([[COMMIT, "refs/tags/v0.9.0"]]);
    for (const stdout of [noRelease, noTag]) {
      expect(
        await resolveCryskVersion("0", {
          spawnFn: fakeSpawn(stdout, 0).spawnFn,
        }),
      ).toBeUndefined();
    }
    expect(
      await resolveCryskVersion("0", {
        spawnFn: fakeSpawn(noRelease, 128).spawnFn,
      }),
    ).toBeUndefined();
    expect(
      await resolveCryskVersion("0", {
        spawnFn: fakeSpawn("", 0, true).spawnFn,
        timeoutMs: 20,
      }),
    ).toBeUndefined();
  });

  test("the latest is the release GitHub marks as latest", async () => {
    const urls: string[] = [];
    const redirects: unknown[] = [];
    const { spawnFn, seen } = fakeSpawn("", 0);
    const version = await resolveCryskVersion("latest", {
      spawnFn,
      fetchFn: (async (url: string, init?: RequestInit) => {
        urls.push(url);
        redirects.push(init?.redirect);
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://github.com/cryskai/crysk/releases/tag/v0.9.0",
          },
        });
      }) as unknown as typeof fetch,
    });
    expect(version).toBe("0.9.0");
    expect(urls).toEqual(["https://github.com/cryskai/crysk/releases/latest"]);
    expect(redirects).toEqual(["manual"]);
    expect(seen).toEqual([]);
  });

  test("no usable latest release gives nothing", async () => {
    const answer = (response: Response) =>
      (async () => response) as unknown as typeof fetch;
    for (const fetchFn of [
      answer(new Response(null, { status: 404 })),
      answer(
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://github.com/cryskai/crysk/releases/tag/v1.0.0-rc.1",
          },
        }),
      ),
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    ]) {
      expect(await resolveCryskVersion("latest", { fetchFn })).toBeUndefined();
    }
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
