import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ciSetupCommand,
  type GhPreflightDeps,
  ghPreflight,
} from "#commands/ci-setup";
import { type CliOptions, parseArgs } from "#review/preflight";
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
        { gh: deps, interactive: false },
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

// The parsed config, or its raw text when it is not JSON (a test wrote it so).
async function readConfig(file: string): Promise<unknown> {
  if (!(await Bun.file(file).exists())) return undefined;
  const raw = await Bun.file(file).text();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// End to end through the CLI, with no TTY: the agent's path.
describe("setup --ci review choices (CLI)", () => {
  async function runSetup(
    args: string[],
    prepare?: (dir: string) => Promise<void>,
  ): Promise<{
    code: number;
    output: string;
    workflow: string;
    config: unknown;
    dir: string;
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), "prhero-ci-levels-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    await prepare?.(dir);
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.join(import.meta.dir, "../../src/cli.ts"),
        "setup",
        "--ci",
        ...args,
      ],
      { cwd: dir, env: { ...process.env, NO_COLOR: "1" } },
    );
    const wf = path.join(dir, ".github", "workflows", "pr-hero.yml");
    const cfg = path.join(dir, ".prhero", "config.json");
    return {
      code: result.exitCode,
      output: `${result.stdout}${result.stderr}`,
      workflow: (await Bun.file(wf).exists()) ? await Bun.file(wf).text() : "",
      config: await readConfig(cfg),
      dir,
    };
  }

  test("no flags: balanced and gate are written, no budget line, and the summary says nobody chose", async () => {
    const r = await runSetup([]);
    try {
      expect(r.code).toBe(0);
      expect(r.workflow).toContain("mode: gate");
      expect(r.workflow).not.toContain("budget-usd:");
      expect(r.config).toEqual({
        ci_review_policy: "risk_aware",
        ci_max_attempts: 2,
        ci_rereview_min_score: 4,
        max_verification_steps: 8,
        max_changed_lines: 4000,
      });
      expect(r.output).toContain("defaults: nobody chose them");
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });

  test("flags: the level, mode and subscription reach the workflow and the config", async () => {
    const r = await runSetup([
      "--level",
      "thorough",
      "--ci-mode",
      "advisory",
      "--billing",
      "subscription",
      "--max-changed-lines",
      "2500",
    ]);
    try {
      expect(r.code).toBe(0);
      expect(r.workflow).toContain("mode: advisory");
      expect(r.workflow).toContain("budget-usd: 0\n");
      expect(r.config).toEqual({
        ci_review_policy: "every_push",
        ci_max_attempts: 4,
        max_verification_steps: 8,
        max_changed_lines: 2500,
      });
      expect(r.output).not.toContain("nobody chose");
      expect(r.output).toContain(
        "CLAUDE_CODE_OAUTH_TOKEN (create it with `claude setup-token`)",
      );
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });

  test("an API key with a ceiling writes it", async () => {
    const r = await runSetup(["--billing", "api", "--budget-usd", "7.5"]);
    try {
      expect(r.workflow).toContain("budget-usd: 7.5\n");
      expect(r.output).toContain("$7.5 per review");
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });

  test("an existing config keeps its other keys", async () => {
    const r = await runSetup(["--level", "minimal"], async (dir) => {
      await Bun.write(
        path.join(dir, ".prhero", "config.json"),
        JSON.stringify({ post: true }),
      );
    });
    try {
      expect(r.config).toEqual({
        post: true,
        ci_review_policy: "once_per_pr",
        ci_max_attempts: 1,
        max_verification_steps: 8,
        max_changed_lines: 4000,
      });
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });

  test("an invalid existing config is refused before the workflow is written", async () => {
    const r = await runSetup([], async (dir) => {
      await Bun.write(path.join(dir, ".prhero", "config.json"), "{ nope");
    });
    try {
      expect(r.code).not.toBe(0);
      expect(r.output).toContain("not valid JSON");
      expect(r.workflow).toBe("");
      expect(r.config).toBe("{ nope");
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });

  test("an existing workflow without --force writes nothing at all", async () => {
    const r = await runSetup(["--level", "minimal"], async (dir) => {
      await Bun.write(
        path.join(dir, ".github", "workflows", "pr-hero.yml"),
        "keep\n",
      );
    });
    try {
      expect(r.code).toBe(1);
      expect(r.workflow).toBe("keep\n");
      expect(r.config).toBeUndefined();
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });
});

describe("parseArgs: --level and --billing", () => {
  test("accepted on setup --ci and ci init", () => {
    expect(
      parseArgs(["setup", "--ci", "--level", "manual"]).options.reviewLevel,
    ).toBe("manual");
    expect(parseArgs(["ci", "init", "--billing", "api"]).options.billing).toBe(
      "api",
    );
  });
  test("an unknown value fails loud", () => {
    expect(() => parseArgs(["setup", "--ci", "--level", "max"])).toThrow(
      /--level must be/,
    );
    expect(() => parseArgs(["setup", "--ci", "--billing", "free"])).toThrow(
      /--billing must be/,
    );
  });
  test("rejected outside the scaffold commands", () => {
    expect(() => parseArgs(["review", "--level", "manual"])).toThrow(
      /only apply with setup --ci or ci init/,
    );
  });
  test("a subscription with a ceiling is a contradiction, rejected", () => {
    expect(() =>
      parseArgs([
        "setup",
        "--ci",
        "--billing",
        "subscription",
        "--budget-usd",
        "5",
      ]),
    ).toThrow(/does not apply with --billing subscription/);
  });
});

describe("ciSetupCommand at a terminal", () => {
  test("asks the questions and writes the answers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prhero-ci-tty-"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      const answers = ["manual", "advisory", "api", "3", "1200", "n"];
      const asked: string[] = [];
      const take = (q: string) => {
        asked.push(q);
        return answers.shift() ?? "";
      };
      const { deps } = fakeDeps([READY]);
      const code = await ciSetupCommand(
        { repo: dir, repoExplicit: true } as CliOptions,
        {
          gh: deps,
          interactive: true,
          prompter: {
            choose: async (q, options) => {
              const a = take(q);
              return options.find((o) => o.value === a)?.value as never;
            },
            confirm: async (q) => take(q) === "y",
            text: async (q) => take(q),
          },
        },
      );
      expect(code).toBe(0);
      expect(asked).toHaveLength(6);
      const workflow = await Bun.file(
        path.join(dir, ".github", "workflows", "pr-hero.yml"),
      ).text();
      expect(workflow).toContain("mode: advisory");
      expect(workflow).toContain("budget-usd: 3\n");
      expect(
        JSON.parse(
          await Bun.file(path.join(dir, ".prhero", "config.json")).text(),
        ),
      ).toMatchObject({
        ci_review_policy: "manual_only",
        max_changed_lines: 1200,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
