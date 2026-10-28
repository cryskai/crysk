// Where the product keeps its files during the pr-hero → Crysk rename. The new
// directory names win; the old ones are still found when they are all that
// exists, and nothing here ever moves a user's files (`doctor` prints the
// migration command instead). Filesystem lookups live here, not in brand.ts,
// because brand.ts must stay import-free.

import { existsSync } from "node:fs";
import path from "node:path";

export const HOME_DIR_NAME = ".crysk";
export const LEGACY_HOME_DIR_NAME = ".prhero";
export const REPO_DIR_NAME = ".crysk";
export const LEGACY_REPO_DIR_NAME = ".prhero";
export const IGNORE_FILE_NAME = ".cryskignore";
export const LEGACY_IGNORE_FILE_NAME = ".prheroignore";

type Exists = (p: string) => boolean;

function resolveName(
  parent: string,
  name: string,
  legacy: string,
  exists: Exists,
): string {
  if (exists(path.join(parent, name))) return name;
  if (exists(path.join(parent, legacy))) return legacy;
  return name;
}

// ~/.crysk, or ~/.prhero when only the old one exists. A fresh install gets the
// new name. Both existing means the new one wins; the old one is not read.
// `exists` is injectable so a caller that already has a fake filesystem (doctor)
// gets the same answer it uses for every other path.
export function resolveHomeDir(home: string, exists: Exists = existsSync) {
  return path.join(
    home,
    resolveName(home, HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, exists),
  );
}

// <root>/.crysk, or <root>/.prhero when only the old one exists. Writers use
// the same answer, so an existing .prhero/ repo is updated in place.
export function resolveRepoDir(root: string, exists: Exists = existsSync) {
  return path.join(
    root,
    resolveName(root, REPO_DIR_NAME, LEGACY_REPO_DIR_NAME, exists),
  );
}

// The ignore file a working tree already has: .cryskignore first, then
// .prheroignore, else the new name (for writes).
export function resolveIgnoreFileName(
  root: string,
  exists: Exists = existsSync,
) {
  return resolveName(root, IGNORE_FILE_NAME, LEGACY_IGNORE_FILE_NAME, exists);
}
