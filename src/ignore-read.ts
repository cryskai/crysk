// The ignore file I/O shell (`.cryskignore`, else the legacy `.prheroignore`). `ignore-file.ts` beside it is the PURE
// half — dialect, translation, matching — and this module is the part that
// touches a filesystem.
//
// It exists as its OWN module rather than living in cli.ts because
// `pr-hero watch` needs the same read, and importing it from cli.ts made
// cli.ts and watch/watch.ts import EACH OTHER (cli.ts already imports
// `watchCommand` from watch/watch.ts for dispatch). That cycle happened to work,
// but only because the binding was an `export async function` DECLARATION:
// function declarations are hoisted and bound at link time, so watch/watch.ts
// could reference it at its own top level before cli.ts's body ran. Convert
// it to `export const … = async () => …` and the same code crashes at
// import time with a ReferenceError, in production only — watch/watch.ts is the
// module required first in the real dispatch path, and test import order
// need not reproduce that.
//
// A load-bearing invariant that no test enforces and only a comment
// protects is the kind that gets refactored away by someone doing something
// else entirely. Breaking the cycle costs one small module and removes the
// invariant instead of documenting it.
//
// The CI counterpart (`readBaseRefIgnoreRules`) lives in `#git/git.ts`: it
// needs that module's own `GitRunner` plumbing, and the git domain owns the
// CI flow's base-ref read. Both readers share the dialect and the error
// re-contextualizing below, which is the part that must not drift.

import { stat } from "node:fs/promises";
import path from "node:path";
import {
  IGNORE_FILE_NAME,
  LEGACY_IGNORE_FILE_NAME,
  resolveIgnoreFileName,
} from "./brand-paths";
import { CliError } from "./errors";
import {
  IgnoreFileError,
  type IgnoreRule,
  parseIgnoreFile,
} from "./ignore-file";

export interface IgnoreFileReadResult {
  rules: IgnoreRule[];
  found: boolean;
}

// `IgnoreFileError` carries a default file name (see ignore-file.ts) because
// that pure parser never sees which PHYSICAL path it was asked to read — a working-tree file and a base-ref blob share
// the same dialect and the same parser. Every caller here re-contextualizes
// the message with whichever path it actually resolved, so the abort names
// something a human can go look at (local: a real filesystem path; CI: a
// `<sha>:<ignore file>` locator, since there is no working-tree path to
// name).
export function reContextualizeIgnoreError(
  error: IgnoreFileError,
  resolvedLocation: string,
): string {
  return error.message.replace(
    new RegExp(`^(?:${IGNORE_FILE_NAME}|${LEGACY_IGNORE_FILE_NAME}):`),
    `${resolvedLocation}:`,
  );
}

// Local working-tree read — local review, and PR review without --ci (O-8:
// always `operatorRoot`, never `worktreePath`; see design D3/O-8 and
// isCiEnvironment's own WHY at cli.ts's isCi read sites).
//
// Absent is NOT an error (`.exists()`-style check would suffice for that
// alone), but `Bun.file(...).exists()` ALSO reports false for a directory —
// verified directly — so an absent-vs-directory distinction needs `stat`,
// not `.exists()`. A directory named like the ignore file, or one this process
// cannot read, must abort loudly and must NEVER be treated as "absent,
// defaults apply": that silent equivalence is exactly the kind of quiet
// partial review this whole design exists to prevent.
export async function readLocalIgnoreRules(
  root: string,
): Promise<IgnoreFileReadResult> {
  // .cryskignore first, then the legacy .prheroignore. A .cryskignore that
  // exists but is unusable aborts; it never falls through to the old file.
  const ignoreName = resolveIgnoreFileName(root);
  const ignorePath = path.join(root, ignoreName);
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(ignorePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { rules: [], found: false };
    }
    throw new CliError(
      `${ignoreName} at ${ignorePath} could not be accessed: ` +
        `${(error as Error).message}`,
    );
  }
  if (!fileStat.isFile()) {
    throw new CliError(
      `${ignoreName} at ${ignorePath} is not a regular file (found a ` +
        "directory or special file); refusing to read it as ignore rules",
    );
  }
  let text: string;
  try {
    text = await Bun.file(ignorePath).text();
  } catch (error) {
    // The `stat` above already proved it is a regular file, so a read
    // failure here is something else — most likely permission denied.
    throw new CliError(
      `${ignoreName} at ${ignorePath} could not be read: ` +
        `${(error as Error).message}`,
    );
  }
  try {
    return { rules: parseIgnoreFile(text, "user", ignoreName), found: true };
  } catch (error) {
    if (error instanceof IgnoreFileError) {
      throw new CliError(reContextualizeIgnoreError(error, ignorePath));
    }
    throw error;
  }
}
