import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ciSetupCommand,
  type GhPreflightDeps,
  ghPreflight,
} from "#commands/ci-setup";
import type { CliOptions } from "#review/preflight";
import type { SystemToolStatus } from "../../src/system-tools";

const MISSING: SystemToolStatus = { installed: false, authOk: false };
const LOGGED_OUT: SystemToolStatus = { installed: true, authOk: false };
const READY: SystemToolStatus = { installed: true, authOk: true };

// A fake whose `check` returns each status in turn, so a test can say what gh
// looks like before and after an install or a login.
function fakeDeps(
  statuses: SystemToolStatus[],
  overrides: Partial<GhPreflightDeps> = {},
): {
  deps: GhPreflightDeps;
  lines: string[];
  asked: string[];
  calls: string[];
} {
  const lines: string[] = [];
  const asked: string[] = [];
  const calls: string[] = [];
  let i = 0;
  const deps: GhPreflightDeps = {
    check: async () => {
      const status = statuses[
        Math.min(i, statuses.length - 1)
      ] as SystemToolStatus;
      i++;
      return status;
    },
    interactive: false,
    ask: async (question) => {
      asked.push(question);
      return true;
    },
    install: async () => {
      calls.push("install");
      return { ok: true, manualCommand: "brew install gh" };
    },
    login: async () => {
      calls.push("login");
      return 0;
    },
    installCommand: "brew install gh",
    canAutoInstall: true,
    log: (line = "") => lines.push(line),
    ...overrides,
  };
  return { deps, lines, asked, calls };
}

describe("ghPreflight", () => {
  test("installed and logged in: prints nothing and asks nothing", async () => {
    const { deps, lines, asked, calls } = fakeDeps([READY], {
      interactive: true,
    });
    await ghPreflight(deps);
    expect(lines).toEqual([]);
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("missing, no terminal: says why gh is needed and how to install and log in, without prompting", async () => {
    const { deps, lines, asked, calls } = fakeDeps([MISSING]);
    await ghPreflight(deps);
    const output = lines.join("\n");
    expect(output).toContain("GitHub CLI (gh) is not installed");
    expect(output).toContain("gh secret set");
    expect(output).toContain("pr-hero status");
    expect(output).toContain("brew install gh");
    expect(output).toContain("gh auth login");
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("logged out, no terminal: tells the user to run gh auth login, without prompting", async () => {
    const { deps, lines, asked, calls } = fakeDeps([LOGGED_OUT]);
    await ghPreflight(deps);
    const output = lines.join("\n");
    expect(output).toContain("GitHub CLI (gh) is not logged in");
    expect(output).toContain("gh auth login");
    expect(output).not.toContain("brew install gh");
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("missing, terminal, user accepts both: installs, logs in, and confirms gh is ready", async () => {
    const { deps, lines, asked, calls } = fakeDeps(
      [MISSING, LOGGED_OUT, READY],
      { interactive: true },
    );
    await ghPreflight(deps);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain("brew install gh");
    expect(asked[1]).toContain("gh auth login");
    expect(calls).toEqual(["install", "login"]);
    expect(lines.join("\n")).toContain("gh is installed and logged in");
  });

  test("terminal, user declines: prints the commands and runs nothing", async () => {
    const { deps, lines, calls } = fakeDeps([MISSING], {
      interactive: true,
      ask: async () => false,
    });
    await ghPreflight(deps);
    expect(calls).toEqual([]);
    const output = lines.join("\n");
    expect(output).toContain("brew install gh");
    expect(output).toContain("gh auth login");
  });

  test("terminal, the install fails: prints its error and the manual command, and does not offer the login", async () => {
    const { deps, lines, asked, calls } = fakeDeps([MISSING, MISSING], {
      interactive: true,
      install: async () => {
        calls.push("install");
        return {
          ok: false,
          manualCommand: "sudo apt-get install gh",
          error: "boom",
        };
      },
    });
    await ghPreflight(deps);
    expect(asked).toHaveLength(1);
    expect(calls).toEqual(["install"]);
    const output = lines.join("\n");
    expect(output).toContain("boom");
    expect(output).toContain("sudo apt-get install gh");
    expect(output).toContain("gh auth login");
  });

  test("terminal, the login does not take: tells the user to run gh auth login", async () => {
    const { deps, lines, calls } = fakeDeps([LOGGED_OUT, LOGGED_OUT], {
      interactive: true,
    });
    await ghPreflight(deps);
    expect(calls).toEqual(["login"]);
    expect(lines.join("\n")).toContain("gh auth login");
    expect(lines.join("\n")).not.toContain("gh is installed and logged in");
  });
});

describe("ciSetupCommand with gh missing", () => {
  test("still writes the workflow, exits 0, and ends with the gh notice", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prhero-ci-gh-"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      const { deps, lines } = fakeDeps([MISSING]);
      const code = await ciSetupCommand(
        { repo: dir, repoExplicit: true } as CliOptions,
        deps,
      );
      expect(code).toBe(0);
      expect(
        await Bun.file(
          path.join(dir, ".github", "workflows", "pr-hero.yml"),
        ).exists(),
      ).toBe(true);
      expect(lines.join("\n")).toContain("GitHub CLI (gh) is not installed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
