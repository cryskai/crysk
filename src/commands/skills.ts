// `crysk skills install` / `crysk skills load`.
//
// install writes the bundled loader stubs into every detected coding agent
// that has a skills directory. A stub never changes: it runs
// `npx -y crysk@<v> skills load <skill>` and follows what that prints.
//
// load prints a skill's playbook (or a companion file) from the crysk the
// repository's CI runs, so the agent's instructions match the engine that
// reviews its pull requests. Which crysk, in order:
//   1. the engine version `crysk status` recorded for this repository, read
//      from the review the engine posted (skills-cache.ts);
//   2. the workflow's `uses: cryskai/crysk@v…`, as the same npm spec
//      (`@v0.8.1` → `0.8.1`, `@v0` → `0`): a pin gets its exact version and a
//      moving tag stays in step with the CI;
//   3. otherwise the latest published crysk.
// A range or tag is resolved to an exact version with `npm view`. WHY not hand
// it to npx: npx keeps running the copy it cached for a range, so `crysk@0`
// would stay on the first 0.x this machine downloaded.
// When the exact version is this package's own the bundled file is printed.
// Otherwise the file comes from the per-version cache, or from
// `npx -y crysk@<version> skills load …`; if that fails the bundled file is
// printed with a warning on stderr.

import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPlainEngineVersion } from "#ci/review-admission";
import { resolveRepoRoot } from "#git/git";
import { detectAgentEnvironments, syncSkills } from "../agent-env";
import { type EngineAssets, resolveEngineAssets } from "../assets";
import { SKILL_NAMES } from "../brand";
import { CliError, CliUsageError } from "../errors";
import type { CliOptions } from "../review/preflight";
import {
  readCachedSkillFile,
  readEngineVersion,
  writeCachedSkillFile,
} from "../skills-cache";

// A cold `npx` of a crysk version not yet on the machine took about 8 s when
// measured (2026-11-19), so the bound leaves room for a slow network: the
// agent waits once, and only when a new version first shows up.
export const SKILLS_DELEGATE_TIMEOUT_MS = 60_000;
// `npm view` answered in under half a second when measured (2026-11-19).
export const SKILLS_VERSION_LOOKUP_TIMEOUT_MS = 15_000;

// Set on the delegated child so it prints its own bundled file instead of
// resolving a version again.
const DELEGATED_ENV = "CRYSK_SKILLS_DELEGATED";

const WORKFLOW_USES =
  /^\s*-?\s*uses:\s*["']?(?:cryskai\/crysk|juanmaagd\/pr-hero)@v(\d+(?:\.\d+){0,2})(?=["'\s#]|$)/m;

// The npm spec a workflow's `uses:` line runs, or undefined when no file names
// the crysk action by a version tag (a SHA pin names no version).
export function workflowCryskSpec(
  workflows: readonly string[],
): string | undefined {
  for (const text of workflows) {
    const match = WORKFLOW_USES.exec(text);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

export function resolveSkillsSpec(input: {
  recorded: string | undefined;
  workflows: readonly string[];
}): string {
  if (input.recorded !== undefined && isPlainEngineVersion(input.recorded)) {
    return input.recorded;
  }
  return workflowCryskSpec(input.workflows) ?? "latest";
}

function readWorkflows(repoRoot: string): string[] {
  const dir = path.join(repoRoot, ".github", "workflows");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort()
      .flatMap((name) => {
        try {
          return [readFileSync(path.join(dir, name), "utf-8")];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function runBounded(
  argv: string[],
  options: {
    env: Record<string, string | undefined>;
    timeoutMs: number;
    spawnFn: typeof Bun.spawn;
  },
): Promise<string | undefined> {
  try {
    const proc = options.spawnFn(argv, {
      env: options.env,
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdoutStream =
      proc.stdout !== undefined && typeof proc.stdout !== "number"
        ? proc.stdout
        : undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      watchdog = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already exited.
        }
        if (stdoutStream) void stdoutStream.cancel().catch(() => {});
        resolve(undefined);
      }, options.timeoutMs);
    });
    const work = (async (): Promise<string | undefined> => {
      const [stdout, exitCode] = await Promise.all([
        stdoutStream ? new Response(stdoutStream).text() : Promise.resolve(""),
        proc.exited,
      ]);
      return exitCode === 0 && stdout.length > 0 ? stdout : undefined;
    })();
    // The child can reject after the timeout already won.
    void work.catch(() => {});
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
  } catch {
    return undefined;
  }
}

// The newest plain x.y.z in what `npm view <spec> version --json` prints: one
// string when a single version matches, an array otherwise.
export function newestPlainVersion(json: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parts = (version: string) => version.split(".").map(Number);
  let newest: string | undefined;
  for (const version of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!isPlainEngineVersion(version)) continue;
    if (newest === undefined) {
      newest = version;
      continue;
    }
    const a = parts(version);
    const b = parts(newest);
    const index = a.findIndex((part, i) => part !== b[i]);
    if (index !== -1 && (a[index] ?? 0) > (b[index] ?? 0)) newest = version;
  }
  return newest;
}

// The exact version a range or tag names today, or undefined when npm cannot
// say (offline, no such version, a timeout).
export async function resolveCryskVersion(
  spec: string,
  deps: { spawnFn?: typeof Bun.spawn; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const stdout = await runBounded(
    ["npm", "view", `crysk@${spec}`, "version", "--json", "--prefer-online"],
    {
      env: process.env,
      timeoutMs: deps.timeoutMs ?? SKILLS_VERSION_LOOKUP_TIMEOUT_MS,
      spawnFn: deps.spawnFn ?? Bun.spawn,
    },
  );
  return stdout === undefined ? undefined : newestPlainVersion(stdout);
}

// What the crysk at this exact version prints for this skill file, or undefined
// when it could not be run (offline, a version without `skills load`, a timeout).
export async function delegateSkillsLoad(
  version: string,
  skillName: string,
  skillFile: string | undefined,
  deps: { spawnFn?: typeof Bun.spawn; timeoutMs?: number } = {},
): Promise<string | undefined> {
  return runBounded(
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
      env: { ...process.env, [DELEGATED_ENV]: "1" },
      timeoutMs: deps.timeoutMs ?? SKILLS_DELEGATE_TIMEOUT_MS,
      spawnFn: deps.spawnFn ?? Bun.spawn,
    },
  );
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
  assets?: EngineAssets;
  home?: string;
  env?: Record<string, string | undefined>;
  // The repository the agent works in; undefined outside one.
  repoRoot?: () => Promise<string | undefined>;
  // The exact version a range or tag names today.
  resolveVersion?: (spec: string) => Promise<string | undefined>;
  delegate?: (
    version: string,
    skillName: string,
    skillFile: string | undefined,
  ) => Promise<string | undefined>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
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

  const writeStdout =
    deps.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr =
    deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const print = (text: string): number => {
    writeStdout(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  };
  const printBundled = (): number => {
    let content: string;
    try {
      content = readFileSync(srcPath, "utf-8");
    } catch {
      throw new CliError(`Failed to read bundled skill asset: ${targetFile}`);
    }
    return print(content);
  };

  const env = deps.env ?? process.env;
  if (env[DELEGATED_ENV] === "1") return printBundled();

  const home = deps.home ?? os.homedir();
  const repoRoot = await (
    deps.repoRoot ??
    (() => resolveRepoRoot(options.repo).catch(() => undefined))
  )();
  const spec = resolveSkillsSpec({
    recorded:
      repoRoot === undefined ? undefined : readEngineVersion(home, repoRoot),
    workflows: repoRoot === undefined ? [] : readWorkflows(repoRoot),
  });
  const version = isPlainEngineVersion(spec)
    ? spec
    : await (deps.resolveVersion ?? resolveCryskVersion)(spec);
  if (version === assets.version) return printBundled();

  if (version !== undefined) {
    const cached = readCachedSkillFile(home, version, skillName, targetFile);
    if (cached !== undefined) return print(cached);
    const delegate = deps.delegate ?? delegateSkillsLoad;
    const delegated = await delegate(version, skillName, options.skillFile);
    if (delegated !== undefined) {
      writeCachedSkillFile(home, version, skillName, targetFile, delegated);
      return print(delegated);
    }
  }
  writeStderr(
    `crysk skills load: could not load ${skillName} from crysk@${version ?? spec}; printing the copy bundled with crysk ${assets.version}, which may not match the crysk your CI runs.\n`,
  );
  return printBundled();
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
