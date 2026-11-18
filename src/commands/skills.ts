// `crysk skills install` / `crysk skills load`: install writes the bundled
// loader stubs into every detected coding agent that has a skills directory;
// load checks dual-verified release metadata (npm + GitHub release with
// SHA256SUMS) at most once per hour via ~/.crysk/upgrade-check.json,
// auto-delegates same-major updates within a bounded timeout (refreshing only
// unmodified local stubs), and prints the requested playbook or companion file.

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
  PRHERO_GITHUB_REPO,
  readUpgradeCache,
  type UpgradeCheckCache,
  writeUpgradeCache,
} from "../updater";

export const SKILLS_LOAD_CHECK_TTL_MS = 60 * 60 * 1000;
export const SKILLS_DELEGATE_TIMEOUT_MS = 10_000;

export function isNewerSemver(candidate: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  // Same-major allowlist: auto-delegation only crosses 0.x -> 0.y (matching @v0),
  // never jumping across a major version automatically.
  if (a[0] !== b[0]) return false;
  for (let i = 1; i < 3; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return false;
}

// Validate npm `latest` manifest fields (`name`, canonical semver `version`,
// 40-hex `gitHead`, `sha512-` `dist.integrity`) and require GitHub `/releases/latest`
// to be a published non-draft, non-prerelease release with matching
// `tag_name: "v<version>"` and a `SHA256SUMS` asset (structural/tag agreement
// only — does not cross-verify commit SHAs or tarball hashes).
export function verifyReleaseMetadata(
  npmData: unknown,
  ghData: unknown,
): string | undefined {
  if (
    typeof npmData !== "object" ||
    npmData === null ||
    typeof ghData !== "object" ||
    ghData === null
  ) {
    return undefined;
  }
  const npm = npmData as {
    name?: unknown;
    version?: unknown;
    gitHead?: unknown;
    dist?: { integrity?: unknown };
  };
  if (npm.name !== "crysk") return undefined;
  if (typeof npm.version !== "string" || !/^\d+\.\d+\.\d+$/.test(npm.version)) {
    return undefined;
  }
  if (typeof npm.gitHead !== "string" || !/^[0-9a-f]{40}$/.test(npm.gitHead)) {
    return undefined;
  }
  if (
    typeof npm.dist?.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/=]+$/.test(npm.dist.integrity)
  ) {
    return undefined;
  }

  const gh = ghData as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
  };
  if (gh.tag_name !== `v${npm.version}`) return undefined;
  if (gh.draft === true || gh.prerelease === true) return undefined;
  if (!Array.isArray(gh.assets)) return undefined;
  const hasChecksums = gh.assets.some(
    (asset) =>
      typeof asset === "object" &&
      asset !== null &&
      (asset as { name?: unknown }).name === "SHA256SUMS",
  );
  if (!hasChecksums) return undefined;
  return npm.version;
}

async function fetchLatestCryskVersion(): Promise<string | undefined> {
  try {
    const [npmResp, ghResp] = await Promise.all([
      fetch("https://registry.npmjs.org/crysk/latest", {
        signal: AbortSignal.timeout(1500),
      }),
      fetch(
        `https://api.github.com/repos/${PRHERO_GITHUB_REPO}/releases/latest`,
        {
          headers: { "User-Agent": "crysk-cli" },
          signal: AbortSignal.timeout(1500),
        },
      ),
    ]);
    if (!npmResp.ok || !ghResp.ok) return undefined;
    const [npmData, ghData] = await Promise.all([
      npmResp.json(),
      ghResp.json(),
    ]);
    return verifyReleaseMetadata(npmData, ghData);
  } catch {
    return undefined;
  }
}

async function runBoundedNpx(
  args: string[],
  options: {
    env: Record<string, string | undefined>;
    captureStdout: boolean;
    timeoutMs: number;
    spawnFn: typeof Bun.spawn;
  },
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = options.spawnFn(["npx", "-y", ...args], {
      env: options.env,
      stdout: options.captureStdout ? "pipe" : "ignore",
      stderr: "ignore",
      timeout: options.timeoutMs,
    });
    const stdoutStream =
      options.captureStdout &&
      proc.stdout !== undefined &&
      typeof proc.stdout !== "number"
        ? proc.stdout
        : undefined;
    let timedOut = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      watchdog = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          // Process may have already exited.
        }
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may have already exited.
        }
        if (stdoutStream) {
          try {
            void stdoutStream.cancel().catch(() => {});
          } catch {
            // Ignore locked or already-closed stdout streams.
          }
        }
        resolve({ kind: "timeout" });
      }, options.timeoutMs);
    });
    const workPromise = (async (): Promise<{
      kind: "done";
      stdout: string;
      exitCode: number;
    }> => {
      if (stdoutStream) {
        const [stdout, exitCode] = await Promise.all([
          new Response(stdoutStream).text(),
          proc.exited,
        ]);
        return { kind: "done", stdout, exitCode };
      }
      const exitCode = await proc.exited;
      return { kind: "done", stdout: "", exitCode };
    })();
    // Prevent unhandled rejections if child pipe/process rejects after timeout wins.
    void workPromise.catch(() => {});
    try {
      const outcome = await Promise.race([workPromise, timeoutPromise]);
      if (timedOut || outcome.kind === "timeout" || outcome.exitCode !== 0) {
        return { ok: false, stdout: "" };
      }
      return { ok: true, stdout: outcome.stdout };
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
  } catch {
    return { ok: false, stdout: "" };
  }
}

export async function delegateToCryskVersion(
  version: string,
  skillName: string,
  skillFile?: string,
  deps: { spawnFn?: typeof Bun.spawn; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const childEnv = { ...process.env, CRYSK_SKILLS_DELEGATED: "1" };
  const spawnFn = deps.spawnFn ?? Bun.spawn;
  const timeoutMs = deps.timeoutMs ?? SKILLS_DELEGATE_TIMEOUT_MS;

  const loadResult = await runBoundedNpx(
    [
      `crysk@${version}`,
      "skills",
      "load",
      skillName,
      ...(skillFile === undefined ? [] : [skillFile]),
    ],
    { env: childEnv, captureStdout: true, timeoutMs, spawnFn },
  );
  if (!loadResult.ok || loadResult.stdout.length === 0) {
    return undefined;
  }

  // Refresh unmodified local stubs only after `load` succeeded, and never with
  // `--force`, so user-edited skill files stay drift-kept.
  await runBoundedNpx([`crysk@${version}`, "skills", "install"], {
    env: childEnv,
    captureStdout: false,
    timeoutMs,
    spawnFn,
  });
  return loadResult.stdout;
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
  const autoUpdateDisabled =
    env.CRYSK_SKILLS_DELEGATED === "1" ||
    env.CRYSK_NO_AUTO_UPDATE === "1" ||
    env.CRYSK_NO_AUTO_UPDATE === "true";

  if (!autoUpdateDisabled) {
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

    const writeCacheBestEffort = (next: UpgradeCheckCache): void => {
      try {
        writeUpgradeCache(layout.upgradeCheckPath, next, {
          writeFile: deps.writeFile,
        });
      } catch {
        // Best-effort cache write; read-only homes still serve skills.
      }
    };

    let latestVersion: string | undefined;
    if (isCheckCacheFresh(cache, nowMs, SKILLS_LOAD_CHECK_TTL_MS)) {
      latestVersion = cache?.verified_version;
    } else {
      const fetched = await fetchLatest();
      if (fetched !== undefined) {
        latestVersion = fetched;
        if (!isNewerSemver(fetched, assets.version)) {
          writeCacheBestEffort({
            ...cache,
            checked_at: new Date(nowMs).toISOString(),
            current_version: assets.version,
            latest_version: fetched,
            verified_version: fetched,
          });
        }
      } else {
        latestVersion = cache?.verified_version;
      }
    }

    if (latestVersion && isNewerSemver(latestVersion, assets.version)) {
      const delegated = await delegate(
        latestVersion,
        skillName,
        options.skillFile,
      );
      if (delegated !== undefined) {
        writeCacheBestEffort({
          ...cache,
          checked_at: new Date(nowMs).toISOString(),
          current_version: assets.version,
          latest_version: latestVersion,
          verified_version: latestVersion,
          reconciled_version: latestVersion,
        });
        writeStdout(delegated.endsWith("\n") ? delegated : `${delegated}\n`);
        return 0;
      }
      // Back off for the TTL window so a failing/stalled npx download does not
      // re-spawn on every subsequent `skills load` for the next hour, while
      // preserving `latest_version` so `crysk upgrade --check` still surfaces
      // the newer upstream release.
      writeCacheBestEffort({
        ...cache,
        checked_at: new Date(nowMs).toISOString(),
        current_version: assets.version,
        latest_version: latestVersion,
        verified_version: assets.version,
      });
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
