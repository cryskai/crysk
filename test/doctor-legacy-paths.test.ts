// The pr-hero → Crysk rename keeps reading the old paths for one version and
// tells the user how to move. These drive runDoctor through its injected
// filesystem, so no real HOME, repo, LaunchAgents dir or git is touched.

import { describe, expect, test } from "bun:test";
import { type DoctorCheckItem, runDoctor } from "../src/doctor";

const GOTCHAS = "## Gotchas\nDo not mutate state.";

interface Machine {
  files?: Record<string, string>;
  // Which binaries `which` finds. Default: a bare machine with git and gh.
  bins?: string[];
  tracked?: string[];
  platform?: string;
}

async function doctorWith(m: Machine): Promise<DoctorCheckItem[]> {
  const files = m.files ?? {};
  const bins = new Set(m.bins ?? ["git", "gh"]);
  const report = await runDoctor({
    cwd: "/repo",
    home: "/home/user",
    platform: m.platform ?? "darwin",
    isTracked: (_dir, rel) => (m.tracked ?? []).includes(rel),
    exists: (p) => p in files,
    readFile: (p) => (p.endsWith("gotchas.md") ? GOTCHAS : files[p]),
    checkToolsOptions: {
      which: (bin) => (bins.has(bin) ? `/bin/${bin}` : null),
      exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
      env: { ANTHROPIC_API_KEY: "sk-test" },
    },
  });
  return report.checks;
}

const byName = (checks: DoctorCheckItem[], name: string) =>
  checks.find((c) => c.name === name);

// A legacy home with state in it, so the resolver keeps using it.
const LEGACY_HOME = {
  "/home/user/.prhero": "",
  "/home/user/.prhero/prhero.db": "",
};

describe("migrate:home", () => {
  test("a bare machine (no binary, agents or MCP): the move is the only step", async () => {
    const checks = await doctorWith({ files: LEGACY_HOME });
    const c = byName(checks, "migrate:home");
    expect(c?.severity).toBe("degraded");
    expect(c?.hint).toBe("1) mv ~/.prhero ~/.crysk");
  });

  test("a home that holds review worktrees gets the worktree repair step right after the move", async () => {
    const checks = await doctorWith({
      files: { ...LEGACY_HOME, "/home/user/.prhero/repos": "" },
    });
    const hint = byName(checks, "migrate:home")?.hint ?? "";
    expect(hint).toContain("1) mv ~/.prhero ~/.crysk");
    expect(hint).toContain(
      "2) in each repository whose `git worktree list` shows a path under ~/.prhero/repos, run `git worktree repair` with that worktree's new path under ~/.crysk/repos (or `git worktree prune` to drop it)",
    );
  });

  test("a machine with the standalone binary, rc PATH line, both launchd agents and MCP gets every re-arm step", async () => {
    const checks = await doctorWith({
      bins: ["git", "gh", "claude"],
      files: {
        ...LEGACY_HOME,
        "/home/user/.prhero/bin/pr-hero": "",
        "/home/user/.zshrc": 'export PATH="$HOME/.prhero/bin:$PATH"\n',
        "/home/user/Library/LaunchAgents/io.prhero.watch.plist": "",
        "/home/user/Library/LaunchAgents/io.crysk.gc.plist": "",
        "/home/user/.claude/mcp.json": '{"mcpServers":{"pr-hero":{}}}',
      },
    });
    const hint = byName(checks, "migrate:home")?.hint ?? "";
    expect(hint).toContain("1) mv ~/.prhero ~/.crysk");
    expect(hint).toContain("~/.zshrc");
    expect(hint).toContain(".prhero/bin to .crysk/bin");
    expect(hint).toContain("~/.crysk/bin/pr-hero watch install");
    expect(hint).toContain("~/.crysk/bin/pr-hero gc install");
    expect(hint).toContain("~/.crysk/bin/pr-hero setup");
  });

  test("only the steps that apply are listed: a launchd agent but no binary, rc line or MCP", async () => {
    const hint =
      byName(
        await doctorWith({
          files: {
            ...LEGACY_HOME,
            "/home/user/Library/LaunchAgents/io.prhero.watch.plist": "",
          },
        }),
        "migrate:home",
      )?.hint ?? "";
    expect(hint).toContain("crysk watch install");
    expect(hint).not.toContain("gc install");
    expect(hint).not.toContain("setup");
    expect(hint).not.toContain("PATH");
    expect(hint).not.toContain("~/.crysk/bin/pr-hero");
  });

  test("launchd steps are skipped off macOS", async () => {
    const hint =
      byName(
        await doctorWith({
          platform: "linux",
          files: {
            ...LEGACY_HOME,
            "/home/user/Library/LaunchAgents/io.prhero.watch.plist": "",
          },
        }),
        "migrate:home",
      )?.hint ?? "";
    expect(hint).toBe("1) mv ~/.prhero ~/.crysk");
  });

  test("an empty ~/.crysk shadowing nothing: reported, ~/.prhero is the one in use", async () => {
    const checks = await doctorWith({
      files: { ...LEGACY_HOME, "/home/user/.crysk": "" },
    });
    const c = byName(checks, "migrate:home");
    expect(c?.message).toContain("holds no Crysk state");
    expect(c?.message).toContain("~/.prhero is still the one in use");
    expect(c?.hint).toContain("remove it");
    expect(c?.hint).toContain("mv ~/.prhero ~/.crysk");
  });

  test("both stateful: ~/.crysk wins, the old one is reported as ignored, no mv suggested", async () => {
    const checks = await doctorWith({
      files: {
        ...LEGACY_HOME,
        "/home/user/.crysk": "",
        "/home/user/.crysk/config.json": "",
      },
    });
    const c = byName(checks, "migrate:home");
    expect(c?.message).toContain("ignored");
    expect(c?.hint ?? "").not.toContain("mv ~/.prhero");
  });

  test("a fully migrated machine reports nothing", async () => {
    const checks = await doctorWith({
      files: {
        "/home/user/.crysk": "",
        "/home/user/.crysk/config.json": "",
        "/repo/.crysk": "",
        "/repo/.crysk/gotchas.md": "",
        "/repo/.cryskignore": "",
      },
    });
    expect(checks.filter((c) => c.name.startsWith("migrate:"))).toEqual([]);
  });
});

describe("migrate:repo", () => {
  const repo = {
    "/repo/.prhero": "",
    "/repo/.prhero/gotchas.md": "",
  };

  test("a tracked .prhero/ gets git mv", async () => {
    const c = byName(
      await doctorWith({ files: repo, tracked: [".prhero"] }),
      "migrate:repo",
    );
    expect(c?.hint).toBe("git mv .prhero .crysk, then commit it");
    // The legacy gotchas file is still the one read.
    expect(c?.severity).toBe("degraded");
  });

  test("an untracked (gitignored) .prhero/ gets plain mv and a .gitignore step", async () => {
    const checks = await doctorWith({ files: repo, tracked: [] });
    const hint = byName(checks, "migrate:repo")?.hint ?? "";
    expect(hint).toContain("mv .prhero .crysk");
    expect(hint).not.toContain("git mv");
    expect(hint).toContain(".gitignore");
    expect(byName(checks, "gotchas")?.severity).toBe("healthy");
  });

  test("an empty .crysk/ beside a stateful .prhero/ is reported and .prhero/ stays in use", async () => {
    const checks = await doctorWith({
      files: { ...repo, "/repo/.crysk": "" },
      tracked: [".prhero"],
    });
    const c = byName(checks, "migrate:repo");
    expect(c?.message).toContain(".prhero/ is still the one in use");
    expect(byName(checks, "gotchas")?.severity).toBe("healthy");
  });

  test(".crysk/ with state wins: .prhero/ is reported as ignored", async () => {
    const c = byName(
      await doctorWith({
        files: { ...repo, "/repo/.crysk": "", "/repo/.crysk/config.json": "" },
      }),
      "migrate:repo",
    );
    expect(c?.message).toContain("ignored");
  });

  test(".prheroignore: git mv when tracked, mv when not", async () => {
    const files = { "/repo/.prheroignore": "" };
    expect(
      byName(
        await doctorWith({ files, tracked: [".prheroignore"] }),
        "migrate:ignore",
      )?.hint,
    ).toBe("git mv .prheroignore .cryskignore, then commit it");
    expect(byName(await doctorWith({ files }), "migrate:ignore")?.hint).toBe(
      "mv .prheroignore .cryskignore",
    );
  });
});
