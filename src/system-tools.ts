import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  duplicateWorkflowProblem,
  LEGACY_WORKFLOW_RELATIVE_PATH,
  WORKFLOW_RELATIVE_PATH,
} from "./brand-paths";
import { resolveOpenCodeAuthPath } from "./security/credential-broker";

export type SystemTool = "git" | "claude" | "gh" | "codegraph";

export interface SystemToolStatus {
  installed: boolean;
  version?: string;
  authOk?: boolean; // gh, claude
  repoIndexed?: boolean; // codegraph
  hint?: string;
}

export interface CheckSystemToolsOptions {
  cwd?: string;
  which?: (binary: string) => string | null | Promise<string | null>;
  exec?: (
    cmd: string[],
    options?: { cwd?: string },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  home?: string;
}

export interface InstallSystemToolOptions {
  platform?: NodeJS.Platform;
  which?: (binary: string) => string | null | Promise<string | null>;
  exec?: (
    cmd: string[],
    options?: { cwd?: string },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface InstallResult {
  ok: boolean;
  manualCommand?: string;
  error?: string;
}

async function defaultExec(
  cmd: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const proc = Bun.spawn(cmd, {
      cwd: options?.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // ignore
          }
          reject(
            new Error(
              `Command timed out after ${timeoutMs}ms: ${cmd.join(" ")}`,
            ),
          );
        }, timeoutMs);
      });

      const executionPromise = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      const [stdout, stderr, exitCode] = await Promise.race([
        executionPromise,
        timeoutPromise,
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: (error as Error).message };
  }
}

export async function checkSystemTools(
  options: CheckSystemToolsOptions = {},
): Promise<Record<SystemTool, SystemToolStatus>> {
  const cwd = options.cwd ?? process.cwd();
  const which = options.which ?? ((bin: string) => Bun.which(bin));
  const exec = options.exec ?? defaultExec;
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();

  // 1. git
  const gitBin = await which("git");
  let gitStatus: SystemToolStatus;
  if (!gitBin) {
    gitStatus = {
      installed: false,
      hint: "Install git: brew install git (macOS) or apt install git (Linux)",
    };
  } else {
    const res = await exec([gitBin, "--version"]);
    const versionMatch = res.stdout.match(/git version\s+([0-9.]+)/i);
    gitStatus = {
      installed: true,
      version: versionMatch ? versionMatch[1] : undefined,
    };
  }

  // 2. claude
  const claudeBin = await which("claude");
  let claudeStatus: SystemToolStatus;
  if (!claudeBin) {
    claudeStatus = {
      installed: false,
      authOk: false,
      hint: "Install Claude Code CLI: npm i -g @anthropic-ai/claude-code",
    };
  } else {
    const res = await exec([claudeBin, "--version"]);
    const version = res.stdout.trim().replace(/^claude-code\//, "");

    // Check auth mechanisms
    const hasToken =
      Boolean(
        env.CLAUDE_CODE_OAUTH_TOKEN &&
          env.CLAUDE_CODE_OAUTH_TOKEN.trim().length > 0,
      ) ||
      Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0);

    const hasSessionFile =
      exists(path.join(home, ".claude.json")) ||
      exists(path.join(home, ".claude", "session.json"));

    const authOk = hasToken || hasSessionFile;
    claudeStatus = {
      installed: true,
      version: version.length > 0 ? version : undefined,
      authOk,
      hint: authOk
        ? undefined
        : "Run 'claude' in your terminal to complete login or set ANTHROPIC_API_KEY",
    };
  }

  // 3. gh
  const ghStatus = await checkGhStatus({ which, exec });

  // 4. codegraph
  const codegraphBin = await which("codegraph");
  const repoIndexed = exists(path.join(cwd, ".codegraph"));
  let codegraphStatus: SystemToolStatus;
  if (!codegraphBin) {
    codegraphStatus = {
      installed: false,
      repoIndexed,
      hint: "Install CodeGraph: brew install codegraph",
    };
  } else {
    const versionRes = await exec([codegraphBin, "--version"]);
    const versionMatch = versionRes.stdout.match(/codegraph\s+([0-9.]+)/i);
    codegraphStatus = {
      installed: true,
      version: versionMatch ? versionMatch[1] : undefined,
      repoIndexed,
      hint: repoIndexed
        ? undefined
        : "Run 'codegraph init' in this repository to index for code intelligence",
    };
  }

  return {
    git: gitStatus,
    claude: claudeStatus,
    gh: ghStatus,
    codegraph: codegraphStatus,
  };
}

// gh alone: whether it is on PATH and whether `gh auth status` passes. Shared by
// checkSystemTools (doctor, the wizard) and `setup --ci`, which needs only gh.
export async function checkGhStatus(
  options: Pick<CheckSystemToolsOptions, "which" | "exec"> = {},
): Promise<SystemToolStatus> {
  const which = options.which ?? ((bin: string) => Bun.which(bin));
  const exec = options.exec ?? defaultExec;
  const ghBin = await which("gh");
  if (!ghBin) {
    return {
      installed: false,
      authOk: false,
      hint: "Install GitHub CLI: brew install gh (macOS) or apt install gh (Linux)",
    };
  }
  const versionRes = await exec([ghBin, "--version"]);
  const versionMatch = versionRes.stdout.match(/gh version\s+([0-9.]+)/i);
  const authRes = await exec([ghBin, "auth", "status"]);
  const authOk = authRes.exitCode === 0;
  return {
    installed: true,
    version: versionMatch ? versionMatch[1] : undefined,
    authOk,
    hint: authOk
      ? undefined
      : "Run 'gh auth login' to authenticate with GitHub for PR reviews",
  };
}

export async function installSystemTool(
  tool: SystemTool,
  options: InstallSystemToolOptions = {},
): Promise<InstallResult> {
  const platform = options.platform ?? process.platform;
  const which = options.which ?? ((bin: string) => Bun.which(bin));
  const exec = options.exec ?? defaultExec;

  if (tool === "claude") {
    const npmBin = (await which("npm")) ?? "npm";
    const res = await exec(
      [npmBin, "install", "-g", "@anthropic-ai/claude-code"],
      { timeoutMs: 300_000 },
    );
    return {
      ok: res.exitCode === 0,
      manualCommand: "npm install -g @anthropic-ai/claude-code",
      error: res.exitCode === 0 ? undefined : res.stderr,
    };
  }

  const brewBin = await which("brew");
  if (platform === "darwin" && brewBin) {
    const formula = tool === "codegraph" ? "codegraph" : tool;
    const res = await exec([brewBin, "install", formula], {
      timeoutMs: 300_000,
    });
    return {
      ok: res.exitCode === 0,
      manualCommand: `brew install ${formula}`,
      error: res.exitCode === 0 ? undefined : res.stderr,
    };
  }

  // Linux or no brew
  const manualCommands: Record<SystemTool, string> = {
    git: "sudo apt-get install git",
    claude: "npm install -g @anthropic-ai/claude-code",
    gh: "sudo apt-get install gh",
    codegraph: "brew install codegraph # or see codegraph docs",
  };

  return {
    ok: false,
    manualCommand: manualCommands[tool],
  };
}

// ---------------------------------------------------------------------------
// Pillar 3 Phase 4: CI diagnostics. Useful in BOTH contexts a `doctor` run
// can happen in — see spec.md §4.1's two scenarios:
//   - Inside GitHub Actions: are the required secrets present? Presence
//     only, NEVER a value, a prefix, or a length — see CLAUDE.md's "Never
//     leak secrets into generated output" rule. Review auth is Anthropic
//     env OR the OpenCode auth file at resolveOpenCodeAuthPath().
//   - In a local repo: is a pr-hero workflow configured at all?
// Deliberately does NOT verify the workflow file is git-committed (spec's
// "present and committed" local scenario) — that needs a git call, and the
// existence check alone already answers the actionable question ("do I have
// one?") within Phase 4's line budget. Flagged as a scoped deviation, not a
// silent gap.
// ---------------------------------------------------------------------------

export interface CiConfigurationStatus {
  configured: boolean;
  message: string;
  hint?: string;
}

export interface CheckCiConfigurationOptions {
  cwd?: string;
  isCi: boolean;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
}

export function checkCiConfiguration(
  options: CheckCiConfigurationOptions,
): CiConfigurationStatus {
  const env = options.env ?? process.env;

  if (options.isCi) {
    const exists = options.exists ?? existsSync;
    const hasGithubToken = Boolean(env.GITHUB_TOKEN?.trim());
    const hasClaudeAuth =
      Boolean(env.ANTHROPIC_API_KEY?.trim()) ||
      Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
    const hasOpenCodeAuth = exists(resolveOpenCodeAuthPath(env));
    const hasReviewAuth = hasClaudeAuth || hasOpenCodeAuth;

    const missing: string[] = [];
    if (!hasGithubToken) missing.push("GITHUB_TOKEN");
    if (!hasReviewAuth) missing.push("ANTHROPIC_API_KEY");

    if (missing.length === 0) {
      return {
        configured: true,
        message:
          "Required CI secrets are present (GITHUB_TOKEN, Anthropic/Claude or OpenCode auth)",
      };
    }
    return {
      configured: false,
      message: `Missing required CI secret(s): ${missing.join(", ")}`,
      hint: "Configure the missing secret(s) as repository secrets and pass them in the workflow's `with:` block — never echo their values.",
    };
  }

  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  // Either file counts: a repo set up before the rename keeps pr-hero.yml. Both
  // at once is a defect, not a configuration: two workflows review every PR.
  const duplicate = duplicateWorkflowProblem(cwd, exists);
  if (duplicate !== undefined) {
    return { configured: false, message: duplicate };
  }
  for (const relative of [
    WORKFLOW_RELATIVE_PATH,
    LEGACY_WORKFLOW_RELATIVE_PATH,
  ]) {
    if (exists(path.join(cwd, relative))) {
      return {
        configured: true,
        message: `CI workflow configured (${relative})`,
      };
    }
  }
  return {
    configured: false,
    message: "No CI workflow configured",
    hint: `Run 'crysk setup --ci' (or 'crysk ci init') to scaffold ${WORKFLOW_RELATIVE_PATH}`,
  };
}
