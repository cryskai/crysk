import {
  existsSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAgentEnvironments } from "./agent-env";
import { prheroLayout } from "./home-preflight";
import { detectInstallMethod, type InstallMethod } from "./updater";

export type UninstallStepType =
  | "unload_launchd"
  | "remove_file"
  | "remove_dir"
  | "clean_rc_file"
  | "unregister_mcp"
  | "remove_skills";

export interface UninstallStep {
  type: UninstallStepType;
  targetPath?: string;
  label?: string;
  desc: string;
}

export interface UninstallPlan {
  platform: string;
  purge: boolean;
  launchdServices: string[];
  rcFilesCleaned: string[];
  binariesRemoved: string[];
  agentEnvCleanups: string[];
  programSteps: UninstallStep[];
  dataSteps: UninstallStep[];
  inRepoPrheroDir?: string;
  warnings: string[];
}

export interface ActiveRunInfo {
  pid: number;
  repo: string;
  startTime: string;
  trigger: string;
}

export interface PlanUninstallationOptions {
  home?: string;
  platform?: string;
  purge?: boolean;
  repoRoot?: string;
  installMethod?: InstallMethod;
  detectActiveRuns?: () => Promise<ActiveRunInfo[]>;
  isWatchLockHeld?: () => Promise<boolean>;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string | undefined;
}

export async function planUninstallation(
  options: PlanUninstallationOptions = {},
): Promise<UninstallPlan> {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? os.platform();
  const purge = options.purge ?? false;
  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });

  const installMethod =
    options.installMethod ??
    detectInstallMethod({
      home,
      execPath: process.execPath,
      exists,
    });

  // Dual pre-purge gate
  if (purge) {
    const activeRuns = options.detectActiveRuns
      ? await options.detectActiveRuns()
      : [];
    if (activeRuns.length > 0) {
      throw new Error(
        `Cannot uninstall with purge: ${activeRuns.length} active reviews are currently running. Stop or cancel them before uninstalling.`,
      );
    }

    const lockHeld = options.isWatchLockHeld
      ? await options.isWatchLockHeld()
      : false;
    if (lockHeld) {
      throw new Error(
        "Cannot uninstall with purge: watch.lock is currently held by a running review.",
      );
    }
  }

  const programSteps: UninstallStep[] = [];
  const dataSteps: UninstallStep[] = [];
  const launchdServices: string[] = [];
  const rcFilesCleaned: string[] = [];
  const binariesRemoved: string[] = [];
  const agentEnvCleanups: string[] = [];
  const warnings: string[] = [];

  // 1. Launchd services (macOS only)
  if (platform === "darwin") {
    const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
    const services = [
      {
        label: "io.prhero.watch",
        plist: path.join(launchAgentsDir, "io.prhero.watch.plist"),
      },
      {
        label: "io.prhero.gc",
        plist: path.join(launchAgentsDir, "io.prhero.gc.plist"),
      },
    ];

    for (const svc of services) {
      launchdServices.push(svc.label);
      if (exists(svc.plist)) {
        programSteps.push({
          type: "unload_launchd",
          label: svc.label,
          targetPath: svc.plist,
          desc: `Unload and remove launchd agent ${svc.label}`,
        });
        programSteps.push({
          type: "remove_file",
          targetPath: svc.plist,
          desc: `Delete ${svc.plist}`,
        });
      }
    }
  }

  // 2. Agent environments (MCP unregistration + skills removal)
  const envs = await detectAgentEnvironments({ home, exists });
  for (const env of envs) {
    if (env.mcpConfigFile && exists(env.mcpConfigFile)) {
      agentEnvCleanups.push(`${env.displayName} MCP`);
      programSteps.push({
        type: "unregister_mcp",
        targetPath: env.mcpConfigFile,
        desc: `Unregister pr-hero MCP server from ${env.displayName} (${env.mcpConfigFile})`,
      });
    }
    if (env.skillsDir) {
      for (const skillName of [
        "pr-hero-triage",
        "pr-hero-ci-setup",
        "pr-hero",
      ]) {
        const skillPath = path.join(env.skillsDir, skillName);
        if (exists(skillPath)) {
          agentEnvCleanups.push(`${env.displayName} Skill: ${skillName}`);
          programSteps.push({
            type: "remove_skills",
            targetPath: skillPath,
            desc: `Remove digest-verified ${skillName} skill from ${env.displayName}`,
          });
        }
      }
    }
  }

  // 3. rc files PATH cleanup
  const rcCandidates = [
    path.join(home, ".zshrc"),
    path.join(home, ".bashrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".config", "fish", "config.fish"),
  ];

  for (const rcPath of rcCandidates) {
    if (exists(rcPath)) {
      const content = readFile(rcPath);
      if (content?.includes(".prhero/bin")) {
        rcFilesCleaned.push(rcPath);
        programSteps.push({
          type: "clean_rc_file",
          targetPath: rcPath,
          desc: `Remove .prhero/bin from PATH in ${rcPath}`,
        });
      }
    }
  }

  // 4. Standalone binary removal
  if (installMethod.kind === "standalone") {
    binariesRemoved.push(installMethod.binaryPath);
    programSteps.push({
      type: "remove_file",
      targetPath: installMethod.binaryPath,
      desc: `Remove binary ${installMethod.binaryPath}`,
    });
    const bakFile = `${installMethod.binaryPath}.bak`;
    if (exists(bakFile)) {
      programSteps.push({
        type: "remove_file",
        targetPath: bakFile,
        desc: `Remove backup binary ${bakFile}`,
      });
    }
  } else if (installMethod.kind === "package_manager") {
    warnings.push(
      `pr-hero was installed via ${installMethod.manager}. Run '${installMethod.manager} uninstall -g pr-hero' to remove the global package.`,
    );
  }

  // 5. Data steps (Purge)
  if (purge) {
    const layout = prheroLayout(home);
    const dataFiles = [
      layout.prheroDbPath,
      `${layout.prheroDbPath}-wal`,
      `${layout.prheroDbPath}-shm`,
      layout.metricsDbPath,
      layout.storeSocketPath,
      layout.watchConfigPath,
      layout.reviewConfigPath,
      path.join(layout.dir, "setup.json"),
      layout.upgradeCheckPath,
      layout.logPath,
      layout.lockPath,
      layout.launchdLogPath,
    ];

    for (const f of dataFiles) {
      if (exists(f)) {
        dataSteps.push({
          type: "remove_file",
          targetPath: f,
          desc: `Delete ${f}`,
        });
      }
    }

    const dataDirs = [
      path.join(layout.dir, "active_runs"),
      layout.reposDir,
      path.join(layout.dir, "bin"),
      layout.dir,
    ];

    for (const d of dataDirs) {
      if (exists(d)) {
        dataSteps.push({
          type: "remove_dir",
          targetPath: d,
          desc: `Remove directory ${d}`,
        });
      }
    }
  }

  let inRepoPrheroDir: string | undefined;
  if (options.repoRoot) {
    const repoPrhero = path.join(options.repoRoot, ".prhero");
    if (exists(repoPrhero)) {
      inRepoPrheroDir = repoPrhero;
    }
  }

  return {
    platform,
    purge,
    launchdServices,
    rcFilesCleaned,
    binariesRemoved,
    agentEnvCleanups,
    programSteps,
    dataSteps,
    inRepoPrheroDir,
    warnings,
  };
}

export interface ExecuteUninstallOptions {
  dryRun?: boolean;
  home?: string;
  unlink?: (p: string) => void;
  rmdir?: (p: string, opts?: { recursive?: boolean }) => void;
  writeFile?: (p: string, content: string) => Promise<void> | void;
  readFile?: (p: string) => string | undefined;
  exists?: (p: string) => boolean;
  exec?: (
    cmd: string[],
    options?: { cwd?: string },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface ExecuteUninstallResult {
  ok: boolean;
  dryRun: boolean;
  executedSteps: string[];
  errors: string[];
}

export async function executeUninstallPlan(
  plan: UninstallPlan,
  options: ExecuteUninstallOptions = {},
): Promise<ExecuteUninstallResult> {
  const dryRun = options.dryRun ?? false;
  const executedSteps: string[] = [];
  const errors: string[] = [];

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      executedSteps: [],
      errors: [],
    };
  }

  const unlink = options.unlink ?? unlinkSync;
  const writeFile =
    options.writeFile ??
    ((p: string, c: string) => {
      writeFileSync(p, c, "utf-8");
    });
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const exists = options.exists ?? existsSync;
  const exec =
    options.exec ??
    (async (cmd: string[]) => {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode, stdout, stderr };
    });

  const allSteps = [...plan.programSteps, ...plan.dataSteps];

  for (const step of allSteps) {
    try {
      switch (step.type) {
        case "unload_launchd":
          if (step.targetPath && exists(step.targetPath)) {
            await exec(["launchctl", "unload", "-w", step.targetPath]);
            executedSteps.push(step.desc);
          }
          break;

        case "remove_file":
          if (step.targetPath && exists(step.targetPath)) {
            unlink(step.targetPath);
            executedSteps.push(step.desc);
          }
          break;

        case "remove_dir":
          if (step.targetPath && exists(step.targetPath)) {
            try {
              if (options.rmdir) {
                options.rmdir(step.targetPath, { recursive: true });
              } else {
                rmSync(step.targetPath, { recursive: true, force: true });
              }
              executedSteps.push(step.desc);
            } catch {
              // Ignore if already deleted
            }
          }
          break;

        case "clean_rc_file":
          if (step.targetPath && exists(step.targetPath)) {
            const raw = readFile(step.targetPath);
            if (raw) {
              const lines = raw
                .split("\n")
                .filter((l) => !l.includes(".prhero/bin"));
              await writeFile(step.targetPath, lines.join("\n"));
              executedSteps.push(step.desc);
            }
          }
          break;

        case "unregister_mcp":
          if (step.targetPath && exists(step.targetPath)) {
            const raw = readFile(step.targetPath);
            if (raw) {
              try {
                const config = JSON.parse(raw);
                if (
                  config &&
                  typeof config === "object" &&
                  !Array.isArray(config) &&
                  config.mcpServers?.["pr-hero"]
                ) {
                  delete config.mcpServers["pr-hero"];
                  await writeFile(
                    step.targetPath,
                    `${JSON.stringify(config, null, 2)}\n`,
                  );
                }
              } catch (e) {
                if (!(e instanceof SyntaxError)) {
                  throw e;
                }
              }
            }
          }
          executedSteps.push(step.desc);
          break;

        case "remove_skills":
          if (step.targetPath && exists(step.targetPath)) {
            if (options.rmdir) {
              options.rmdir(step.targetPath, { recursive: true });
            } else {
              rmSync(step.targetPath, { recursive: true, force: true });
            }
          }
          executedSteps.push(step.desc);
          break;
      }
    } catch (err) {
      errors.push(
        `Error executing step (${step.desc}): ${(err as Error).message}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    dryRun: false,
    executedSteps,
    errors,
  };
}
