// The pr-hero → Crysk rename never moves a user's files. While an old path is
// still the one being read, `doctor` says so and prints the complete procedure
// for THIS machine: a bare `mv` is not enough, because the PATH line, the
// launchd plists and the MCP registrations all hold the old absolute path.

import { spawnSync } from "node:child_process";
import path from "node:path";
import type { AgentEnvDetection } from "./agent-env";
import { BIN_NAME } from "./brand";
import {
  HOME_DIR_NAME,
  homeHasState,
  IGNORE_FILE_NAME,
  LEGACY_HOME_DIR_NAME,
  LEGACY_IGNORE_FILE_NAME,
  LEGACY_REPO_DIR_NAME,
  REPO_DIR_NAME,
  repoDirHasState,
} from "./brand-paths";
import type { DoctorCheckItem } from "./doctor";
import { GC_LAUNCHD_LABEL } from "./store/gc-preflight";
import { WATCH_LAUNCHD_LABEL } from "./watch/preflight";

export type IsTracked = (repoDir: string, relPath: string) => boolean;

// `git ls-files` lists the path only when git tracks it. Any failure (not a
// repo, no git) reads as "not tracked", which gives the plain `mv` advice.
export const gitIsTracked: IsTracked = (repoDir, relPath) => {
  const r = spawnSync("git", ["-C", repoDir, "ls-files", "--", relPath], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim().length > 0;
};

export interface MigrationInput {
  home: string;
  repoDir: string | undefined;
  exists: (p: string) => boolean;
  readFile: (p: string) => string | undefined;
  envs: readonly AgentEnvDetection[];
  platform: string;
  isTracked: IsTracked;
}

const RC_FILES = [
  [".zshrc"],
  [".bashrc"],
  [".bash_profile"],
  [".config", "fish", "config.fish"],
];

// The steps `mv ~/.prhero ~/.crysk` leaves undone, limited to those that apply
// to this machine.
function homeMigrationSteps(input: MigrationInput): string[] {
  const { home, exists, readFile } = input;
  const oldDir = path.join(home, LEGACY_HOME_DIR_NAME);
  const steps = [`mv ~/${LEGACY_HOME_DIR_NAME} ~/${HOME_DIR_NAME}`];

  // A review worktree under repos/ is registered by absolute path in the
  // repository it came from; after the move git still points at the old path.
  if (exists(path.join(oldDir, "repos"))) {
    steps.push(
      `in each repository whose \`git worktree list\` shows a path under ~/${LEGACY_HOME_DIR_NAME}/repos, run \`git worktree repair\` with that worktree's new path under ~/${HOME_DIR_NAME}/repos (or \`git worktree prune\` to drop it)`,
    );
  }

  const rcWithOldPath = RC_FILES.map((parts) => path.join(home, ...parts))
    .filter((p) => exists(p))
    .filter((p) => (readFile(p) ?? "").includes(`${LEGACY_HOME_DIR_NAME}/bin`));
  const standalone = exists(path.join(oldDir, "bin", "pr-hero"));
  if (rcWithOldPath.length > 0) {
    const files = rcWithOldPath.map((p) => `~/${path.relative(home, p)}`);
    steps.push(
      `in ${files.join(", ")} change ${LEGACY_HOME_DIR_NAME}/bin to ${HOME_DIR_NAME}/bin (e.g. sed -i.bak 's#\\${LEGACY_HOME_DIR_NAME}/bin#${HOME_DIR_NAME}/bin#' ${files.join(" ")}) and open a new shell`,
    );
  } else if (standalone) {
    steps.push(
      `the standalone binary now lives in ~/${HOME_DIR_NAME}/bin: put that directory on PATH`,
    );
  }

  // After the move the binary is at its new path; use it by that path so the
  // agents and registrations below record the new location.
  const run = standalone ? `~/${HOME_DIR_NAME}/bin/pr-hero` : BIN_NAME;
  if (input.platform === "darwin") {
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    const installed = (current: string, legacy: string) =>
      exists(path.join(agentsDir, `${current}.plist`)) ||
      exists(path.join(agentsDir, `${legacy}.plist`));
    if (installed(WATCH_LAUNCHD_LABEL, "io.prhero.watch")) {
      steps.push(
        `${run} watch install (re-creates the launchd agent at the new path; pass --interval if you changed it)`,
      );
    }
    if (installed(GC_LAUNCHD_LABEL, "io.prhero.gc")) {
      steps.push(`${run} gc install (same, for the gc agent)`);
    }
  }
  const mcpRegistered = input.envs.some(
    (env) =>
      env.mcpConfigFile !== undefined &&
      (readFile(env.mcpConfigFile) ?? "").includes("pr-hero"),
  );
  if (mcpRegistered) {
    steps.push(`${run} setup (re-registers the MCP server at the new path)`);
  }
  return steps;
}

const numbered = (steps: string[]) =>
  steps.map((s, i) => `${i + 1}) ${s}`).join("; ");

export function migrationChecks(input: MigrationInput): DoctorCheckItem[] {
  const { home, repoDir, exists } = input;
  const out: DoctorCheckItem[] = [];

  // --- home -----------------------------------------------------------
  const newHome = path.join(home, HOME_DIR_NAME);
  const oldHome = path.join(home, LEGACY_HOME_DIR_NAME);
  if (exists(oldHome)) {
    if (exists(newHome) && homeHasState(newHome, exists)) {
      out.push({
        name: "migrate:home",
        severity: "degraded",
        message: `~/${LEGACY_HOME_DIR_NAME} is ignored because ~/${HOME_DIR_NAME} holds Crysk state`,
        hint: `Merge anything you still need into ~/${HOME_DIR_NAME}, then delete ~/${LEGACY_HOME_DIR_NAME}.`,
      });
    } else if (exists(newHome)) {
      out.push({
        name: "migrate:home",
        severity: "degraded",
        message: `~/${HOME_DIR_NAME} exists but holds no Crysk state, so ~/${LEGACY_HOME_DIR_NAME} is still the one in use`,
        hint: `Check ~/${HOME_DIR_NAME} and remove it, then: ${numbered(homeMigrationSteps(input))}. Until then, do not put files in ~/${HOME_DIR_NAME}.`,
      });
    } else {
      out.push({
        name: "migrate:home",
        severity: "degraded",
        message: `~/${LEGACY_HOME_DIR_NAME} is the legacy name; still read for now, but ~/${HOME_DIR_NAME} is the current one`,
        hint: numbered(homeMigrationSteps(input)),
      });
    }
  }

  if (repoDir === undefined) return out;

  // --- repo dir and ignore file ---------------------------------------
  const move = (rel: string, to: string, extra: string): string => {
    const tracked = input.isTracked(repoDir, rel);
    return tracked
      ? `git mv ${rel} ${to}, then commit it`
      : `mv ${rel} ${to}${extra}`;
  };

  const newRepo = path.join(repoDir, REPO_DIR_NAME);
  const oldRepo = path.join(repoDir, LEGACY_REPO_DIR_NAME);
  if (exists(oldRepo)) {
    if (exists(newRepo) && repoDirHasState(newRepo, exists)) {
      out.push({
        name: "migrate:repo",
        severity: "degraded",
        message: `${LEGACY_REPO_DIR_NAME}/ is ignored because ${REPO_DIR_NAME}/ exists`,
        hint: `Merge anything you still need into ${REPO_DIR_NAME}/, then delete ${LEGACY_REPO_DIR_NAME}/.`,
      });
    } else {
      const how = move(
        LEGACY_REPO_DIR_NAME,
        REPO_DIR_NAME,
        `, then add ${REPO_DIR_NAME}/ to .gitignore in place of ${LEGACY_REPO_DIR_NAME}/ (an untracked ${REPO_DIR_NAME}/ makes the working tree dirty)`,
      );
      if (exists(newRepo)) {
        out.push({
          name: "migrate:repo",
          severity: "degraded",
          message: `${REPO_DIR_NAME}/ holds no config.json or gotchas.md, so ${LEGACY_REPO_DIR_NAME}/ is still the one in use`,
          hint: `Remove the empty ${REPO_DIR_NAME}/ first, then: ${how}`,
        });
      } else {
        out.push({
          name: "migrate:repo",
          severity: "degraded",
          message: `${LEGACY_REPO_DIR_NAME}/ is the legacy name; still read for now, but ${REPO_DIR_NAME}/ is the current one`,
          hint: how,
        });
      }
    }
  }

  const newIgnore = path.join(repoDir, IGNORE_FILE_NAME);
  const oldIgnore = path.join(repoDir, LEGACY_IGNORE_FILE_NAME);
  if (exists(oldIgnore)) {
    out.push(
      exists(newIgnore)
        ? {
            name: "migrate:ignore",
            severity: "degraded",
            message: `${LEGACY_IGNORE_FILE_NAME} is ignored because ${IGNORE_FILE_NAME} exists`,
            hint: `Merge anything you still need into ${IGNORE_FILE_NAME}, then delete ${LEGACY_IGNORE_FILE_NAME}.`,
          }
        : {
            name: "migrate:ignore",
            severity: "degraded",
            message: `${LEGACY_IGNORE_FILE_NAME} is the legacy name; still read for now, but ${IGNORE_FILE_NAME} is the current one`,
            hint: move(LEGACY_IGNORE_FILE_NAME, IGNORE_FILE_NAME, ""),
          },
    );
  }
  return out;
}
