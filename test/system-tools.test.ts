import { describe, expect, test } from "bun:test";
import { checkSystemTools, installSystemTool } from "../src/system-tools";

describe("checkSystemTools (offline with injected fakes)", () => {
  test("all tools installed and healthy", async () => {
    const status = await checkSystemTools({
      cwd: "/repo",
      which: (bin) => `/usr/local/bin/${bin}`,
      exec: async (cmd) => {
        if (cmd[0].endsWith("git") && cmd[1] === "--version") {
          return { exitCode: 0, stdout: "git version 2.40.0\n", stderr: "" };
        }
        if (cmd[0].endsWith("claude") && cmd[1] === "--version") {
          return { exitCode: 0, stdout: "claude-code/1.0.0\n", stderr: "" };
        }
        if (cmd[0].endsWith("gh") && cmd[1] === "auth" && cmd[2] === "status") {
          return {
            exitCode: 0,
            stdout: "Logged in to github.com\n",
            stderr: "",
          };
        }
        if (cmd[0].endsWith("codegraph") && cmd[1] === "--version") {
          return { exitCode: 0, stdout: "codegraph 0.5.0\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      exists: (p) => p === "/repo/.codegraph",
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      home: "/home/user",
    });

    expect(status.git.installed).toBe(true);
    expect(status.git.version).toBe("2.40.0");

    expect(status.claude.installed).toBe(true);
    expect(status.claude.authOk).toBe(true);

    expect(status.gh.installed).toBe(true);
    expect(status.gh.authOk).toBe(true);

    expect(status.codegraph.installed).toBe(true);
    expect(status.codegraph.repoIndexed).toBe(true);
  });

  test("git missing is fatal / reported not installed", async () => {
    const status = await checkSystemTools({
      cwd: "/repo",
      which: (bin) => (bin === "git" ? null : `/bin/${bin}`),
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      exists: () => false,
      env: {},
    });

    expect(status.git.installed).toBe(false);
    expect(status.git.hint).toBeDefined();
  });

  describe("claude binary + auth matrix", () => {
    test("claude missing reports installed: false and authOk: false", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: (bin) => (bin === "claude" ? null : `/bin/${bin}`),
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        exists: () => false,
        env: {},
      });

      expect(status.claude.installed).toBe(false);
      expect(status.claude.authOk).toBe(false);
      expect(status.claude.hint).toContain(
        "npm i -g @anthropic-ai/claude-code",
      );
    });

    test("claude installed with ANTHROPIC_API_KEY reports authOk: true", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: () => "/bin/claude",
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        exists: () => false,
        env: { ANTHROPIC_API_KEY: "sk-test" },
      });

      expect(status.claude.installed).toBe(true);
      expect(status.claude.authOk).toBe(true);
    });

    test("claude installed with CLAUDE_CODE_OAUTH_TOKEN reports authOk: true", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: () => "/bin/claude",
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        exists: () => false,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" },
      });

      expect(status.claude.installed).toBe(true);
      expect(status.claude.authOk).toBe(true);
    });

    // The doctor reads the same credentials a run does (U2,
    // security/claude-credential.ts): `~/.claude.json` is no credential, every
    // Claude user has it, API-key users included.
    const claudeAuth = async (
      options: Pick<
        Parameters<typeof checkSystemTools>[0] & object,
        "exists" | "env" | "platform" | "keychainProbe"
      >,
    ) =>
      (
        await checkSystemTools({
          cwd: "/repo",
          which: () => "/bin/claude",
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          home: "/home/user",
          platform: "linux",
          ...options,
        })
      ).claude;

    test("~/.claude.json alone is no credential: authOk false with a hint naming the CRYSK_CLAUDE_* secrets", async () => {
      const status = await claudeAuth({
        exists: (p) => p === "/home/user/.claude.json",
        env: {},
      });

      expect(status.installed).toBe(true);
      expect(status.authOk).toBe(false);
      expect(status.hint).toContain("CRYSK_CLAUDE_OAUTH_TOKEN");
      expect(status.hint).toContain("CRYSK_CLAUDE_API_KEY");
    });

    test("~/.claude/session.json alone is no credential either", async () => {
      const status = await claudeAuth({
        exists: (p) => p === "/home/user/.claude/session.json",
        env: {},
      });

      expect(status.authOk).toBe(false);
    });

    test("CRYSK_CLAUDE_OAUTH_TOKEN reports authOk: true", async () => {
      const status = await claudeAuth({
        exists: () => false,
        env: { CRYSK_CLAUDE_OAUTH_TOKEN: "oauth-tok" },
      });

      expect(status.authOk).toBe(true);
      expect(status.hint).toBeUndefined();
    });

    test("CRYSK_CLAUDE_API_KEY reports authOk: true", async () => {
      const status = await claudeAuth({
        exists: () => false,
        env: { CRYSK_CLAUDE_API_KEY: "sk-test" },
      });

      expect(status.authOk).toBe(true);
    });

    test("a whitespace-only CRYSK_CLAUDE_OAUTH_TOKEN is no credential", async () => {
      const status = await claudeAuth({
        exists: () => false,
        env: { CRYSK_CLAUDE_OAUTH_TOKEN: "  " },
      });

      expect(status.authOk).toBe(false);
    });

    test("ANTHROPIC_AUTH_TOKEN alone is no credential (a run strips it)", async () => {
      const status = await claudeAuth({
        exists: () => false,
        env: { ANTHROPIC_AUTH_TOKEN: "bearer" },
      });

      expect(status.authOk).toBe(false);
    });

    test("the CLI's OAuth store ~/.claude/.credentials.json reports authOk: true", async () => {
      const status = await claudeAuth({
        exists: (p) => p === "/home/user/.claude/.credentials.json",
        env: {},
      });

      expect(status.authOk).toBe(true);
    });

    test("macOS with the Keychain item reports authOk: true", async () => {
      const status = await claudeAuth({
        exists: (p) => p === "/usr/bin/security",
        env: {},
        platform: "darwin",
        keychainProbe: () => true,
      });

      expect(status.authOk).toBe(true);
    });

    // R001 (#494): `security` is on every Mac; the run counts the item, so the doctor does.
    test("macOS with the broker but no Keychain item is no login", async () => {
      const status = await claudeAuth({
        exists: (p) => p === "/usr/bin/security",
        env: {},
        platform: "darwin",
        keychainProbe: () => false,
      });

      expect(status.authOk).toBe(false);
    });

    test("/usr/bin/security off macOS is no Keychain login", async () => {
      const status = await claudeAuth({
        exists: (p) => p === "/usr/bin/security",
        env: {},
        platform: "linux",
      });

      expect(status.authOk).toBe(false);
    });

    test("claude installed but unauthenticated reports authOk: false with actionable hint", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: () => "/bin/claude",
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        exists: () => false,
        env: {},
        home: "/home/user",
      });

      expect(status.claude.installed).toBe(true);
      expect(status.claude.authOk).toBe(false);
      expect(status.claude.hint).toContain("claude");
    });
  });

  describe("gh optional tool with auth status", () => {
    test("gh missing reports installed: false", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: (bin) => (bin === "gh" ? null : `/bin/${bin}`),
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        exists: () => false,
        env: {},
      });

      expect(status.gh.installed).toBe(false);
      expect(status.gh.authOk).toBe(false);
      expect(status.gh.hint).toBeDefined();
    });

    test("gh installed but gh auth status non-zero reports authOk: false", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: () => "/bin/tool",
        exec: async (cmd) => {
          if (cmd.includes("auth")) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "You are not logged into any GitHub hosts",
            };
          }
          return { exitCode: 0, stdout: "gh version 2.30.0\n", stderr: "" };
        },
        exists: () => false,
        env: {},
      });

      expect(status.gh.installed).toBe(true);
      expect(status.gh.authOk).toBe(false);
      expect(status.gh.hint).toContain("gh auth login");
    });
  });

  describe("codegraph two facts matrix (installed, repoIndexed)", () => {
    test("installed: true, repoIndexed: true", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: (bin) => (bin === "codegraph" ? "/bin/codegraph" : null),
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        exists: (p) => p === "/repo/.codegraph",
      });

      expect(status.codegraph.installed).toBe(true);
      expect(status.codegraph.repoIndexed).toBe(true);
      expect(status.codegraph.hint).toBeUndefined();
    });

    test("installed: true, repoIndexed: false", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: (bin) => (bin === "codegraph" ? "/bin/codegraph" : null),
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        exists: () => false,
      });

      expect(status.codegraph.installed).toBe(true);
      expect(status.codegraph.repoIndexed).toBe(false);
      // The exact upstream command, opening quote included: a hint that names
      // a wrapper CLI instead ("Run 'some-tool codegraph init'") must fail.
      expect(status.codegraph.hint).toContain("Run 'codegraph init'");
    });

    test("installed: false, repoIndexed: true", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: () => null,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        exists: (p) => p === "/repo/.codegraph",
      });

      expect(status.codegraph.installed).toBe(false);
      expect(status.codegraph.repoIndexed).toBe(true);
      expect(status.codegraph.hint).toBeDefined();
    });

    test("installed: false, repoIndexed: false", async () => {
      const status = await checkSystemTools({
        cwd: "/repo",
        which: () => null,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        exists: () => false,
      });

      expect(status.codegraph.installed).toBe(false);
      expect(status.codegraph.repoIndexed).toBe(false);
      expect(status.codegraph.hint).toBeDefined();
    });
  });

  describe("interactive installSystemTool hooks", () => {
    test("install action invokes homebrew or appropriate command", async () => {
      const executed: string[][] = [];
      const result = await installSystemTool("gh", {
        platform: "darwin",
        which: (bin) => (bin === "brew" ? "/bin/brew" : null),
        exec: async (cmd) => {
          executed.push(cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      expect(result.ok).toBe(true);
      expect(executed).toEqual([["/bin/brew", "install", "gh"]]);
    });

    test("Linux without brew returns instructions without error", async () => {
      const result = await installSystemTool("gh", {
        platform: "linux",
        which: () => null,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });

      expect(result.ok).toBe(false);
      expect(result.manualCommand).toBeDefined();
    });
  });
});
