// `crysk skills install` / `crysk skills load`: install writes the bundled
// loader stubs into every detected coding agent that has a skills directory;
// load checks npm at most once per hour (via ~/.crysk/upgrade-check.json),
// auto-delegates and updates local stubs when a newer release exists, and
// prints the requested skill's playbook or companion file to stdout.

import { readFileSync } from "node:fs";
import os from "node:os";
import { detectAgentEnvironments, syncSkills } from "../agent-env";
import { type EngineAssets, resolveEngineAssets } from "../assets";
import { SKILL_NAMES } from "../brand";
import { CliError, CliUsageError } from "../errors";
import { prheroLayout } from "../home-preflight";
import type { CliOptions } from "../review/preflight";
import {
  isCheckCacheFresh,
  readUpgradeCache,
  type UpgradeCheckCache,
  writeUpgradeCache,
} from "../updater";

export const SKILLS_LOAD_CHECK_TTL_MS = 60 * 60 * 1000;

export function isNewerSemver(candidate: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return false;
}

async function fetchLatestCryskVersion(): Promise<string | undefined> {
  try {
    const resp = await fetch("https://registry.npmjs.org/crysk/latest", {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : undefined;
  } catch {
    return undefined;
  }
}

async function delegateToCryskVersion(
  version: string,
  skillName: string,
  skillFile?: string,
): Promise<string | undefined> {
  const childEnv = { ...process.env, CRYSK_SKILLS_DELEGATED: "1" };
  try {
    const installProc = Bun.spawn(
      ["npx", "-y", `crysk@${version}`, "skills", "install", "--force"],
      {
        env: childEnv,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await installProc.exited;
  } catch {
    // Best-effort local stub update; proceed to load from the newer version.
  }

  try {
    const loadProc = Bun.spawn(
      [
        "npx",
        "-y",
        `crysk@${version}`,
        "skills",
        "load",
        skillName,
        ...(skillFile === undefined ? [] : [skillFile]),
      ],
      {
        env: childEnv,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(loadProc.stdout).text(),
      loadProc.exited,
    ]);
    if (exitCode === 0 && stdout.length > 0) {
      return stdout;
    }
  } catch {
    // Offline or npx failure: fall back to local bundled asset.
  }
  return undefined;
}

export interface SkillsInstallDeps {
  home?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, content: string) => Promise<void> | void;
  which?: (binary: string) => string | null | Promise<string | null>;
  log?: (line: string) => void;
}

export interface SkillsLoadDeps {
  home?: string;
  nowMs?: number;
  env?: Record<string, string | undefined>;
  assets?: EngineAssets;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, content: string) => void;
  fetchLatestVersion?: () => Promise<string | undefined>;
  delegateToVersion?: (
    version: string,
    skillName: string,
    skillFile?: string,
  ) => Promise<string | undefined>;
  writeStdout?: (text: string) => void;
}

export async function skillsCommand(options: CliOptions): Promise<number> {
  if (options.skills === "load") {
    return skillsLoadCommand(options);
  }
  return skillsInstallCommand(options);
}

export async function skillsLoadCommand(
  options: CliOptions,
  deps: SkillsLoadDeps = {},
): Promise<number> {
  const assets = deps.assets ?? resolveEngineAssets();
  const bySkill: Record<string, Record<string, string>> = {
    [SKILL_NAMES.general]: assets.generalSkillFiles,
    [SKILL_NAMES.triage]: assets.triageSkillFiles,
    [SKILL_NAMES.pr]: assets.prSkillFiles,
    [SKILL_NAMES.ciSetup]: assets.ciSetupSkillFiles,
  };
  const skillName = options.skillName;
  const files =
    skillName && Object.hasOwn(bySkill, skillName)
      ? bySkill[skillName]
      : undefined;
  if (!skillName || !files) {
    throw new CliUsageError(
      `unknown skill: ${skillName ?? ""} (expected one of: ${Object.keys(bySkill).join(", ")})`,
    );
  }

  const targetFile = options.skillFile ?? "playbook.md";
  const srcPath = Object.hasOwn(files, targetFile)
    ? files[targetFile]
    : undefined;
  if (!srcPath) {
    throw new CliUsageError(
      `unknown file "${targetFile}" for skill ${skillName} (available: ${Object.keys(files).sort().join(", ")})`,
    );
  }

  const readFile =
    deps.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const writeStdout =
    deps.writeStdout ?? ((text: string) => process.stdout.write(text));

  const env = deps.env ?? process.env;
  if (env.CRYSK_SKILLS_DELEGATED !== "1") {
    const home = deps.home ?? os.homedir();
    const nowMs = deps.nowMs ?? Date.now();
    const layout = prheroLayout(home, deps.exists);
    const cache = readUpgradeCache(layout.upgradeCheckPath, {
      readFile,
      exists: deps.exists,
    });
    const fetchLatest =
      deps.fetchLatestVersion ??
      (deps.home === undefined
        ? fetchLatestCryskVersion
        : async () => undefined);
    const delegate =
      deps.delegateToVersion ??
      (deps.home === undefined
        ? delegateToCryskVersion
        : async () => undefined);

    let latestVersion: string | undefined;
    let latestCache: UpgradeCheckCache | undefined = cache;

    if (isCheckCacheFresh(cache, nowMs, SKILLS_LOAD_CHECK_TTL_MS)) {
      latestVersion = cache?.latest_version;
    } else {
      const fetched = await fetchLatest();
      if (fetched !== undefined) {
        latestVersion = fetched;
        latestCache = {
          ...cache,
          checked_at: new Date(nowMs).toISOString(),
          current_version: assets.version,
          latest_version: fetched,
        };
        try {
          writeUpgradeCache(layout.upgradeCheckPath, latestCache, {
            writeFile: deps.writeFile,
          });
        } catch {
          // Best-effort cache write; read-only homes still serve skills.
        }
      } else {
        latestVersion = cache?.latest_version;
      }
    }

    if (latestVersion && isNewerSemver(latestVersion, assets.version)) {
      const delegated = await delegate(
        latestVersion,
        skillName,
        options.skillFile,
      );
      if (delegated !== undefined) {
        try {
          writeUpgradeCache(
            layout.upgradeCheckPath,
            {
              ...latestCache,
              checked_at:
                latestCache?.checked_at ?? new Date(nowMs).toISOString(),
              current_version: latestCache?.current_version ?? assets.version,
              latest_version: latestVersion,
              reconciled_version: latestVersion,
            },
            { writeFile: deps.writeFile },
          );
        } catch {
          // Best-effort cache write.
        }
        writeStdout(delegated.endsWith("\n") ? delegated : `${delegated}\n`);
        return 0;
      }
    }
  }

  const content = readFile(srcPath);
  if (content === undefined) {
    throw new CliError(`Failed to read bundled skill asset: ${targetFile}`);
  }

  writeStdout(content.endsWith("\n") ? content : `${content}\n`);
  return 0;
}

export async function skillsInstallCommand(
  options: CliOptions,
  deps: SkillsInstallDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const home = deps.home ?? os.homedir();
  const envs = await detectAgentEnvironments({
    home,
    exists: deps.exists,
    which: deps.which,
  });
  const assets = resolveEngineAssets();

  let withSkillsDir = 0;
  let failed = false;
  for (const env of envs) {
    if (!env.skillsDir) continue;
    withSkillsDir += 1;
    const res = await syncSkills(env, assets, {
      exists: deps.exists,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      force: options.force === true,
    });
    // An old-name copy the sync removed, or kept because of the user's edits.
    for (const old of res.legacy ?? []) {
      log(
        old.status === "removed"
          ? `removed the old ${old.skill} skill from ${env.displayName}`
          : `kept the old ${old.skill} skill in ${env.displayName} (${old.reason}); delete it by hand when you no longer need it`,
      );
    }
    if (res.driftDetected && !options.force) {
      failed = true;
      log(
        `local edits found in ${env.displayName}'s crysk skills; rerun with --force to overwrite them`,
      );
      continue;
    }
    if (res.errors.length > 0) {
      failed = true;
      for (const message of res.errors) {
        log(`error: ${env.displayName}: ${message}`);
      }
      continue;
    }
    if (res.upToDate) {
      log(`skills already up to date for ${env.displayName}`);
      continue;
    }
    log(
      `installed ${res.synced.length} skill file(s) for ${env.displayName} (${env.skillsDir})`,
    );
  }

  if (withSkillsDir === 0) {
    log(
      "no coding agent with a skills directory was found (Claude Code, Cursor, Windsurf, Codex, Antigravity, OpenCode)",
    );
    return 1;
  }
  return failed ? 1 : 0;
}
