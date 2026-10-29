// Where the product keeps its files during the pr-hero → Crysk rename. The new
// directory names win when they hold pr-hero state; the old ones are still
// found when they are all that exists, and nothing here ever moves a user's
// files (`doctor` prints the migration command instead). Filesystem lookups
// live here, not in brand.ts, because brand.ts must stay import-free.

import { existsSync } from "node:fs";
import path from "node:path";

export const HOME_DIR_NAME = ".crysk";
export const LEGACY_HOME_DIR_NAME = ".prhero";
export const REPO_DIR_NAME = ".crysk";
export const LEGACY_REPO_DIR_NAME = ".prhero";
export const IGNORE_FILE_NAME = ".cryskignore";
export const LEGACY_IGNORE_FILE_NAME = ".prheroignore";

type Exists = (p: string) => boolean;

// What pr-hero itself writes into a home dir. The directory merely existing
// is not enough: creating an empty ~/.crysk (by hand, or an installer that
// only made bin/) must not hide the populated ~/.prhero beside it.
const HOME_STATE_MARKERS = [
  "prhero.db",
  "metrics.db",
  "config.json",
  "setup.json",
  "watch.json",
  "repos",
];
// The same idea for a repo: only these two files make a repo dir count.
const REPO_STATE_MARKERS = ["config.json", "gotchas.md"];

export function homeHasState(
  homeDir: string,
  exists: Exists = existsSync,
): boolean {
  return HOME_STATE_MARKERS.some((m) => exists(path.join(homeDir, m)));
}

export function repoDirHasState(
  repoDir: string,
  exists: Exists = existsSync,
): boolean {
  return REPO_STATE_MARKERS.some((m) => exists(path.join(repoDir, m)));
}

// A new-named directory wins only while it holds state (or there is no legacy
// one to fall back to). Deliberate safety deviation from "new name wins as
// soon as it exists": that rule orphans every file under the old dir the
// moment someone creates the new one.
function resolveName(
  parent: string,
  name: string,
  legacy: string,
  exists: Exists,
  hasState: (dir: string, exists: Exists) => boolean,
): string {
  const fresh = path.join(parent, name);
  const old = path.join(parent, legacy);
  if (exists(fresh) && hasState(fresh, exists)) return name;
  if (exists(old)) return legacy;
  return name;
}

// ~/.crysk when it has state; else ~/.prhero when that exists; else ~/.crysk
// (a fresh install). `exists` is injectable so a caller that already has a
// fake filesystem (doctor) gets the same answer it uses for every other path.
export function resolveHomeDir(home: string, exists: Exists = existsSync) {
  return path.join(
    home,
    resolveName(
      home,
      HOME_DIR_NAME,
      LEGACY_HOME_DIR_NAME,
      exists,
      homeHasState,
    ),
  );
}

// <root>/.crysk when it holds config.json or gotchas.md; else <root>/.prhero
// when that exists; else <root>/.crysk. Writers use the same answer, so an
// existing .prhero/ repo is updated in place.
export function resolveRepoDir(root: string, exists: Exists = existsSync) {
  return path.join(
    root,
    resolveName(
      root,
      REPO_DIR_NAME,
      LEGACY_REPO_DIR_NAME,
      exists,
      repoDirHasState,
    ),
  );
}

// The ignore file a working tree already has: .cryskignore first, then
// .prheroignore, else the new name (for writes).
export function resolveIgnoreFileName(
  root: string,
  exists: Exists = existsSync,
) {
  const alwaysState = () => true;
  return resolveName(
    root,
    IGNORE_FILE_NAME,
    LEGACY_IGNORE_FILE_NAME,
    exists,
    alwaysState,
  );
}
