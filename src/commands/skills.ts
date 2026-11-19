// `crysk skills install` / `crysk skills load`.
//
// install writes the bundled loader stub (SKILL.md, nothing else) into every
// detected coding agent that has a skills directory. A stub runs
// `npx -y crysk@<v> skills load <skill>` and follows what that prints.
//
// load prints a skill's playbook (or a companion file) from the crysk the
// repository's CI runs, so the agent's instructions match the engine that
// reviews its pull requests. Which crysk, in order:
//   1. the engine version `crysk status` recorded for this repository, read
//      from the review the engine posted (skills-cache.ts);
//   2. the `uses: cryskai/crysk@v…` of a workflow on the repository's default
//      branch, as the same npm spec (`@v0.8.1` → `0.8.1`, `@v0` → `0`): a pin
//      gets its exact version and a moving tag stays in step with the CI;
//   3. otherwise the latest GitHub release.
// WHY the default branch, read from git objects: a pull request's author controls
// the checked-out branch and the worktree, and what is picked here gets executed.
// A moving tag or "latest" is resolved to an exact version from GitHub, and an
// exact version from 1 or 2 must exist as the tag `v<x.y.z>` there. WHY GitHub and
// not npm: the tag is what the CI runs, so a version published only to npm (a
// stolen publish token) is not run here. This checks that the tag exists, not
// that the npm package was built from it. WHY not hand a range to npx: npx keeps
// running the copy it cached for a range.
// When the exact version is this package's own the bundled file is printed.
// Otherwise the file comes from the per-version cache, or from
// `npx -y crysk@<version> skills load …`; if the tag check or that run fails the
// bundled file is printed with a warning on stderr.
// WHY that npx starts in an empty directory, with no node_modules/.bin on PATH:
// run from the checkout it prefers a `node_modules/.bin/crysk` the branch committed,
// an outer `npx` puts that directory on PATH, where a committed `npx` would be the
// one started, and the output is cached for the version. This covers only the run
// started here: an `npx` the agent runs
// inside a checkout still resolves that checkout's `node_modules`.

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPlainEngineVersion } from "#ci/review-admission";
import { remoteHeadRef, resolveRepoRoot } from "#git/git";
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
import { PRHERO_GITHUB_REPO } from "../updater";

// A cold `npx` of a crysk version not yet on the machine took about 8 s when
// measured (2026-11-19), so the bound leaves room for a slow network: the
// agent waits once, and only when a new version first shows up.
export const SKILLS_DELEGATE_TIMEOUT_MS = 60_000;
// `git ls-remote` on the crysk repository took about 1.9 s and the latest-release
// redirect about 0.3 s when measured (2026-11-19). An exact version needs the
// lookup only on a cache miss, so a repository pays it once per version.
export const SKILLS_VERSION_LOOKUP_TIMEOUT_MS = 15_000;

// Set on the delegated child so it prints its own bundled file instead of
// resolving a version again.
const DELEGATED_ENV = "CRYSK_SKILLS_DELEGATED";

// WHY only spaces and tabs: `\s` also matches newlines, and two adjacent `\s*`
// took seconds on a few thousand blank lines in a workflow file.
const WORKFLOW_USES =
  /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?(?:cryskai\/crysk|juanmaagd\/pr-hero)@v(\d+(?:\.\d+){0,2})(?=["'\s#]|$)/m;

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

async function runBounded(
  argv: string[],
  options: {
    env: Record<string, string | undefined>;
    timeoutMs: number;
    spawnFn: typeof Bun.spawn;
    cwd?: string;
  },
): Promise<string | undefined> {
  try {
    const proc = options.spawnFn(argv, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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

// Far above any real workflow; a larger blob is not read at all.
const MAX_WORKFLOW_BYTES = 256 * 1024;

// `git ls-tree -l -z`: mode, type, id, padded size, then a tab and the path. Only
// regular files match: a symlink (120000) has its own mode, a dir has no size.
const WORKFLOW_TREE_ENTRY =
  /^100(?:644|755) blob ([0-9a-f]+) +(\d+)\t(.+\.ya?ml)$/s;

// The workflows on the default branch, from git objects only. No default branch
// known to this clone means none, never a fallback to the worktree.
//
// WHY the full ref: `origin/main` alone would resolve to a local branch or tag of
// that name first, and a fetched pull request can bring one.
export async function readDefaultBranchWorkflows(
  repoRoot: string,
  deps: { spawnFn?: typeof Bun.spawn; timeoutMs?: number } = {},
): Promise<string[]> {
  const branch = await remoteHeadRef(repoRoot).catch(() => undefined);
  if (branch === undefined) return [];
  const runGit = (args: string[]) =>
    runBounded(["git", "-C", repoRoot, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: deps.timeoutMs ?? SKILLS_VERSION_LOOKUP_TIMEOUT_MS,
      spawnFn: deps.spawnFn ?? Bun.spawn,
    });
  const listing = await runGit([
    "ls-tree",
    "-l",
    "-z",
    `refs/remotes/origin/${branch}`,
    "--",
    ".github/workflows/",
  ]);
  const workflows: string[] = [];
  for (const entry of listing?.split("\0") ?? []) {
    const match = WORKFLOW_TREE_ENTRY.exec(entry);
    if (match?.[1] === undefined || Number(match[2]) > MAX_WORKFLOW_BYTES) {
      continue;
    }
    const text = await runGit(["cat-file", "blob", match[1]]);
    if (text !== undefined) workflows.push(text);
  }
  return workflows;
}

function newerVersion(a: string, b: string): string {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const index = left.findIndex((part, i) => part !== right[i]);
  return index !== -1 && (left[index] ?? 0) > (right[index] ?? 0) ? a : b;
}

// The newest release tag on the commit a moving tag points to, read from
// `git ls-remote --tags`. An annotated tag lists its commit on the `^{}` line.
function releaseOnMovingTag(
  lsRemote: string,
  spec: string,
): string | undefined {
  const commits = new Map<string, string>();
  const peeled = new Set<string>();
  for (const line of lsRemote.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha === undefined || !ref?.startsWith("refs/tags/v")) continue;
    const isPeeled = ref.endsWith("^{}");
    const tag = ref.slice("refs/tags/v".length, isPeeled ? -3 : undefined);
    if (isPeeled) peeled.add(tag);
    if (isPeeled || !peeled.has(tag)) commits.set(tag, sha);
  }
  const commit = commits.get(spec);
  let newest: string | undefined;
  for (const [tag, sha] of commits) {
    if (sha !== commit || !isPlainEngineVersion(tag)) continue;
    newest = newest === undefined ? tag : newerVersion(tag, newest);
  }
  return newest;
}

async function latestGithubRelease(
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(
      `https://github.com/${PRHERO_GITHUB_REPO}/releases/latest`,
      {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const version = /\/releases\/tag\/v([^/?#]+)$/.exec(
      response.headers.get("location") ?? "",
    )?.[1];
    return isPlainEngineVersion(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

// The exact version a moving tag points to, or the release GitHub marks as
// latest. Undefined when GitHub cannot say (offline, no such tag, a timeout).
// Given an exact version it returns that version only if its tag exists.
export async function resolveCryskVersion(
  spec: string,
  deps: {
    spawnFn?: typeof Bun.spawn;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<string | undefined> {
  const timeoutMs = deps.timeoutMs ?? SKILLS_VERSION_LOOKUP_TIMEOUT_MS;
  if (spec === "latest") {
    return latestGithubRelease(deps.fetchFn ?? fetch, timeoutMs);
  }
  const stdout = await runBounded(
    [
      "git",
      "ls-remote",
      "--tags",
      `https://github.com/${PRHERO_GITHUB_REPO}`,
      `refs/tags/v${spec}`,
      `refs/tags/v${spec}^{}`,
      `refs/tags/v${spec}.*`,
    ],
    {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs,
      spawnFn: deps.spawnFn ?? Bun.spawn,
    },
  );
  return stdout === undefined ? undefined : releaseOnMovingTag(stdout, spec);
}

// The environment without PATH entries that are a node_modules/.bin directory.
function withoutLocalBins(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (key.toUpperCase() !== "PATH") continue;
    cleaned[key] = cleaned[key]
      ?.split(path.delimiter)
      .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(entry))
      .join(path.delimiter);
  }
  return cleaned;
}

// What the crysk at this exact version prints for this skill file, or undefined
// when it could not be run (offline, a version without `skills load`, a timeout).
export async function delegateSkillsLoad(
  version: string,
  skillName: string,
  skillFile: string | undefined,
  deps: { spawnFn?: typeof Bun.spawn; timeoutMs?: number } = {},
): Promise<string | undefined> {
  let cwd: string;
  try {
    cwd = mkdtempSync(
      path.join(realpathSync(os.tmpdir()), "crysk-skills-load-"),
    );
  } catch {
    // Never the checkout instead: no directory means no delegated run.
    return undefined;
  }
  try {
    return await runBounded(
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
        cwd,
        env: { ...withoutLocalBins(process.env), [DELEGATED_ENV]: "1" },
        timeoutMs: deps.timeoutMs ?? SKILLS_DELEGATE_TIMEOUT_MS,
        spawnFn: deps.spawnFn ?? Bun.spawn,
      },
    );
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // Best-effort: a leftover empty directory under the system's temp.
    }
  }
}

export interface SkillsInstallDeps {
  home?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, content: string) => Promise<void> | void;
  unlink?: (path: string) => void;
  rmdir?: (path: string) => void;
  which?: (binary: string) => string | null | Promise<string | null>;
  log?: (line: string) => void;
}

export interface SkillsLoadDeps {
  assets?: EngineAssets;
  home?: string;
  env?: Record<string, string | undefined>;
  // The repository the agent works in; undefined outside one.
  repoRoot?: () => Promise<string | undefined>;
  // The exact version a moving tag points to, the latest release, or an exact
  // version back when its GitHub tag exists.
  resolveVersion?: (spec: string) => Promise<string | undefined>;
  delegate?: (
    version: string,
    skillName: string,
    skillFile: string | undefined,
  ) => Promise<string | undefined>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

function skillFilesByName(
  assets: EngineAssets,
): Record<string, Record<string, string>> {
  return {
    [SKILL_NAMES.general]: assets.generalSkillFiles,
    [SKILL_NAMES.triage]: assets.triageSkillFiles,
    [SKILL_NAMES.pr]: assets.prSkillFiles,
    [SKILL_NAMES.ciSetup]: assets.ciSetupSkillFiles,
  };
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
  const bySkill = skillFilesByName(assets);
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
  const recorded =
    repoRoot === undefined ? undefined : readEngineVersion(home, repoRoot);
  const spec = resolveSkillsSpec({
    recorded,
    // A recorded version decides alone, so no workflow is read for it.
    workflows:
      repoRoot === undefined || isPlainEngineVersion(recorded)
        ? []
        : await readDefaultBranchWorkflows(repoRoot),
  });
  const resolveVersion = deps.resolveVersion ?? resolveCryskVersion;
  const isExactSpec = isPlainEngineVersion(spec);
  const version = isExactSpec ? spec : await resolveVersion(spec);
  if (version === assets.version) return printBundled();

  if (version !== undefined) {
    const cached = readCachedSkillFile(home, version, skillName, targetFile);
    if (cached !== undefined) return print(cached);
    // A version resolved above already came from GitHub.
    const isOnGithub =
      !isExactSpec || (await resolveVersion(version)) === version;
    if (isOnGithub) {
      const delegate = deps.delegate ?? delegateSkillsLoad;
      const delegated = await delegate(version, skillName, options.skillFile);
      if (delegated !== undefined && delegated.trim() !== "") {
        writeCachedSkillFile(home, version, skillName, targetFile, delegated);
        return print(delegated);
      }
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
  const shippedFiles = skillFilesByName(assets);

  let withSkillsDir = 0;
  let failed = false;
  for (const env of envs) {
    if (!env.skillsDir) continue;
    withSkillsDir += 1;
    const res = await syncSkills(env, assets, {
      exists: deps.exists,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      unlink: deps.unlink,
      rmdir: deps.rmdir,
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
    // A copy of a companion file from an install that wrote all of them.
    for (const companion of res.companions ?? []) {
      const name = `${companion.skill}/${companion.file}`;
      const stillShipped = Object.hasOwn(
        shippedFiles[companion.skill] ?? {},
        companion.file,
      );
      log(
        companion.status === "removed"
          ? `removed the installed copy of ${name} from ${env.displayName}; ${
              stillShipped
                ? "crysk skills load serves it now"
                : "Crysk no longer uses it"
            }`
          : `kept ${name} in ${env.displayName} (${companion.reason}); nothing reads it now, delete it by hand when you no longer need it`,
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
