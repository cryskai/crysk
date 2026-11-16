// odd/tasks/antigravity-oauth.md T4b (S5, L15): the confinement half of
// Crysk's read-only search MCP. agy's `mcp(...)` grants do not bind, so this
// file is the only thing between an agy step and the host's files: every path
// a tool touches is resolved here, realpath'd, and kept inside the root.
//
// Rules, each one a test in test/search/mcp-search-tools.test.ts:
//  - the root is realpath'd once at startup; a requested path (relative or
//    absolute) is resolved against it, realpath'd, and must be the root or
//    under `root + sep`;
//  - `.git` is refused as any path segment, case-insensitively (macOS), and
//    never entered by a walk;
//  - a walk never follows a symlinked directory (no loops, no escapes) and
//    takes a symlinked file only when its target stays inside the root;
//  - only regular files are read, so a FIFO or a device never blocks a read;
//  - error text names repo-relative paths and fixed reasons, never an `fs`
//    message (which would carry a host path);
//  - a path outside the root and a path that does not exist get the same
//    text, so a refusal is no oracle for what exists outside (L17 A3);
//  - a walk re-checks each directory just before listing it and each file
//    just before and after opening it (L17 A1, below);
//  - walks skip what `.gitignore` files ignore (gitignore.ts), except the
//    path the model named itself, as ripgrep does.
//
// The swap race (L17 A1). Between the walk seeing `b/` as a real directory and
// listing it, a concurrent writer could replace `b` with a symlink to the
// outside. Node has no openat/fdopendir, so a directory cannot be listed by
// descriptor (readdir of /dev/fd/N fails on macOS). Each directory is
// therefore opened with O_NOFOLLOW|O_DIRECTORY and its realpath required to be
// itself before the listing, and its inode required unchanged after it. A file
// is opened with O_NOFOLLOW|O_NONBLOCK (a FIFO swapped in never blocks), the
// descriptor must be a regular file, and the path's realpath and dev/ino must
// still be the descriptor's after the open; only then are its bytes read from
// that descriptor. O_NOFOLLOW guards the last component only; the realpath
// check covers the rest. What is left needs several swaps timed between these
// syscalls, by a writer agy steps do not have (they cannot write).
import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  GITIGNORE_NAME,
  type GitignoreLayer,
  isGitignored,
  parseGitignore,
} from "./gitignore";

// A refusal the model may see: its message is fixed text plus repo-relative
// paths only.
export class SearchError extends Error {}

export interface ResolvedPath {
  // The real path on disk, inside the root.
  readonly abs: string;
  // Relative to the root with `/` separators; "" for the root itself.
  readonly rel: string;
  readonly isDirectory: boolean;
}

export function openRoot(dir: string): string {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new SearchError("--root does not exist");
  }
  if (!statSync(real).isDirectory()) {
    throw new SearchError("--root is not a directory");
  }
  return real;
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

export function isInside(root: string, real: string): boolean {
  return real === root || real.startsWith(root + path.sep);
}

export function isGitName(name: string): boolean {
  return name.toLowerCase() === ".git";
}

function hasGitSegment(rel: string): boolean {
  return rel.split("/").some(isGitName);
}

// One text for "outside" and "missing" (L17 A3): a symlink to /etc/hosts and
// one to /etc/no-such-file must not read differently.
function outsideOrMissing(shown: string): SearchError {
  return new SearchError(
    `path is outside the repository or does not exist: ${shown}`,
  );
}

// Resolves a tool's `path` argument. A missing argument is the root.
export function resolveInside(
  root: string,
  requested: string | undefined,
): ResolvedPath {
  if (requested === undefined || requested === "" || requested === ".") {
    return { abs: root, rel: "", isDirectory: true };
  }
  if (requested.includes("\0")) throw new SearchError("invalid path");
  // An absolute request is not echoed back: refusals carry repo-relative text.
  const shown = path.isAbsolute(requested) ? "(absolute path)" : requested;
  const candidate = path.resolve(root, requested);
  // Checked before realpath too, so `../x` is refused without touching it.
  if (!isInside(root, candidate)) throw outsideOrMissing(shown);
  // A literal .git segment is refused before touching the disk, so whether
  // something exists under .git is never told either.
  if (hasGitSegment(toRel(root, candidate))) {
    throw new SearchError(`.git is not searchable: ${shown}`);
  }
  let real: string;
  let stats: Stats;
  try {
    real = realpathSync(candidate);
    stats = statSync(real);
  } catch {
    throw outsideOrMissing(shown);
  }
  // A link into .git reads like one out of the root: it leaves the searchable
  // tree, and its target's existence is not told.
  const rel = toRel(root, real);
  if (!isInside(root, real) || hasGitSegment(rel))
    throw outsideOrMissing(shown);
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new SearchError(`not a regular file: ${shown}`);
  }
  return { abs: real, rel, isDirectory: stats.isDirectory() };
}

// True when `real` is still exactly itself on disk: no component became a
// symlink, it is inside the root and not under .git.
function stillInPlace(root: string, real: string): boolean {
  let now: string;
  try {
    now = realpathSync(real);
  } catch {
    return false;
  }
  return (
    now === real && isInside(root, now) && !hasGitSegment(toRel(root, now))
  );
}

function sameNode(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// A regular file's bytes, read from a descriptor checked against the path
// (header: the swap race). `abs` must be a realpath inside the root.
// undefined: refused or unreadable; "too-large": over maxBytes, not read.
export function readConfinedFile(
  root: string,
  abs: string,
  maxBytes: number,
): Buffer | "too-large" | undefined {
  let fd: number;
  try {
    fd = openSync(
      abs,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return undefined;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return undefined;
    if (!stillInPlace(root, abs)) return undefined;
    let current: Stats;
    try {
      current = lstatSync(abs);
    } catch {
      return undefined;
    }
    if (!sameNode(opened, current)) return undefined;
    if (opened.size > maxBytes) return "too-large";
    const buffer = Buffer.alloc(opened.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// The `.gitignore` of one directory, read confined like any other file (a
// symlinked one is not followed, as git >= 2.32 does not).
const MAX_GITIGNORE_BYTES = 1024 * 1024;

function gitignoreOf(
  root: string,
  dirAbs: string,
  dirRel: string,
): GitignoreLayer | undefined {
  const bytes = readConfinedFile(
    root,
    path.join(dirAbs, GITIGNORE_NAME),
    MAX_GITIGNORE_BYTES,
  );
  if (bytes === undefined || bytes === "too-large") return undefined;
  return parseGitignore(bytes.toString("utf8"), dirRel);
}

// The layers that apply to entries of `dirRel`: the root's .gitignore and
// every one down to and including dirRel's own.
export function gitignoreLayers(
  root: string,
  dirRel: string,
): GitignoreLayer[] {
  const segments = dirRel === "" ? [] : dirRel.split("/");
  const layers: GitignoreLayer[] = [];
  for (let depth = 0; depth <= segments.length; depth++) {
    const rel = segments.slice(0, depth).join("/");
    const layer = gitignoreOf(
      root,
      path.join(root, ...segments.slice(0, depth)),
      rel,
    );
    if (layer !== undefined) layers.push(layer);
  }
  return layers;
}

export interface WalkedFile {
  // Where to read the bytes (inside the root).
  readonly abs: string;
  // What to report: the path as it appears in the tree, repo-relative.
  readonly rel: string;
  readonly size: number;
}

// Bounds the work one call may do, whatever its result caps.
export class WalkBudget {
  private visited = 0;
  exhausted = false;
  constructor(
    private readonly maxEntries: number,
    private readonly deadline: number,
  ) {}

  spend(): boolean {
    this.visited++;
    if (this.visited > this.maxEntries || performance.now() > this.deadline) {
      this.exhausted = true;
    }
    return !this.exhausted;
  }

  timeLeft(): boolean {
    if (performance.now() > this.deadline) this.exhausted = true;
    return !this.exhausted;
  }
}

// A directory entry seen through its link: undefined when it escapes the
// root, is broken, points into .git, or is neither a file nor a directory.
function entryKind(
  root: string,
  abs: string,
  entry: Dirent,
): { readonly kind: "file" | "dir"; readonly real: string } | undefined {
  if (entry.isFile()) return { kind: "file", real: abs };
  if (entry.isDirectory()) return { kind: "dir", real: abs };
  if (!entry.isSymbolicLink()) return undefined;
  let real: string;
  let stats: Stats;
  try {
    real = realpathSync(abs);
    stats = statSync(real);
  } catch {
    return undefined;
  }
  if (!isInside(root, real) || hasGitSegment(toRel(root, real))) {
    return undefined;
  }
  if (stats.isFile()) return { kind: "file", real };
  if (stats.isDirectory()) return { kind: "dir", real };
  return undefined;
}

export interface ListedEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isLink: boolean;
}

// The entries of one directory, sorted, without .git, without anything
// entryKind drops, and without what `layers` ignore (pass [] for none). The
// directory is re-checked around the listing (header: the swap race).
export function listDirectory(
  root: string,
  dir: string,
  dirRel: string,
  layers: readonly GitignoreLayer[],
): ListedEntry[] {
  let entries: Dirent[];
  let fd: number;
  try {
    fd = openSync(
      dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    return [];
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || !stillInPlace(root, dir)) return [];
    entries = readdirSync(dir, { withFileTypes: true });
    if (!stillInPlace(root, dir) || !sameNode(opened, lstatSync(dir))) {
      return [];
    }
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
  const listed: ListedEntry[] = [];
  for (const entry of entries) {
    if (isGitName(entry.name)) continue;
    const kind = entryKind(root, path.join(dir, entry.name), entry);
    if (kind === undefined) continue;
    const isDirectory = kind.kind === "dir";
    const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
    if (isGitignored(layers, rel, isDirectory)) continue;
    listed.push({
      name: entry.name,
      isDirectory,
      isLink: entry.isSymbolicLink(),
    });
  }
  return listed.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

interface PendingDirectory {
  readonly abs: string;
  readonly rel: string;
  // The layers of its ancestors; its own .gitignore is read when it is listed.
  readonly inherited: readonly GitignoreLayer[];
}

// Every regular file under `start`, depth-first in sorted order. Symlinked
// directories are listed by `list` but never descended into here. A file named
// as `start` is yielded even when ignored, and a directory named as `start` is
// walked even when ignored (ripgrep's explicit-path rule); ignore rules apply
// to everything below it.
export function* walkFiles(
  root: string,
  start: ResolvedPath,
  budget: WalkBudget,
): Generator<WalkedFile> {
  if (!start.isDirectory) {
    const size = lstatSync(start.abs).size;
    yield { abs: start.abs, rel: start.rel, size };
    return;
  }
  const parentRel = start.rel.includes("/")
    ? start.rel.slice(0, start.rel.lastIndexOf("/"))
    : "";
  const stack: PendingDirectory[] = [
    {
      abs: start.abs,
      rel: start.rel,
      inherited: start.rel === "" ? [] : gitignoreLayers(root, parentRel),
    },
  ];
  while (stack.length > 0) {
    const dir = stack.pop() as PendingDirectory;
    const own = gitignoreOf(root, dir.abs, dir.rel);
    const layers = own === undefined ? dir.inherited : [...dir.inherited, own];
    const entries = listDirectory(root, dir.abs, dir.rel, layers);
    const subdirs: PendingDirectory[] = [];
    for (const entry of entries) {
      if (!budget.spend()) return;
      const abs = path.join(dir.abs, entry.name);
      const rel = dir.rel === "" ? entry.name : `${dir.rel}/${entry.name}`;
      if (entry.isDirectory) {
        if (!entry.isLink) subdirs.push({ abs, rel, inherited: layers });
        continue;
      }
      let real = abs;
      if (entry.isLink) {
        try {
          real = realpathSync(abs);
        } catch {
          continue;
        }
      }
      let size: number;
      try {
        const stats = lstatSync(real);
        if (!stats.isFile()) continue;
        size = stats.size;
      } catch {
        continue;
      }
      yield { abs: real, rel, size };
    }
    for (let i = subdirs.length - 1; i >= 0; i--) {
      stack.push(subdirs[i] as PendingDirectory);
    }
  }
}
