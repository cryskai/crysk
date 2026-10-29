// Everything the global ~/.crysk/ product home (W3 / GitHub #24) must
// decide, expressed as pure functions so it is all testable offline. The
// I/O shell in home.ts (and the CLI/watch shells that call it) reads origin,
// the registry file, and the owner-present check. The one filesystem touch is
// resolveHomeDir (~/.crysk, else a legacy ~/.prhero); no git, no clock.
//
// WHY a module the watcher does not own: ~/.prhero/ used to be watch-only
// (watch.json, log, lock, plist). Worktrees and run artifacts lived as
// siblings of each operator checkout, so two clones of the same GitHub repo
// produced two trees for one PR. The product home now owns ephemeral machine
// state; the watcher is one tenant. Per-repo trust (config, gotchas) stays
// in <checkout>/.crysk/ (or a legacy .prhero/).

import path from "node:path";
import { resolveHomeDir } from "./brand-paths";
import { CliUsageError } from "./errors";

export const GC_TTL_HOURS = 72;

export interface PrheroLayout {
  dir: string;
  // Compiled binaries resolve optional packages from this directory, not
  // from the embedded filesystem. `upgrade --reconcile` installs the
  // OpenCode SDK here when routing needs it.
  nodeModulesDir: string;
  reposDir: string;
  // C5: two config files live in this dir and NEITHER of them is called
  // configPath. The watcher's opt-in registry (watch.json) and the global
  // review config (config.json) are both `string`, so re-pointing a single
  // `configPath` identifier from one file to the other would have kept
  // compiling at all 19 `paths.configPath` sites in watch/watch.ts while silently
  // reading the wrong file. The name was RETIRED rather than reused: an
  // identifier that no longer exists is the one thing tsc can flag, and no
  // test can enumerate call sites the way the type checker does.
  watchConfigPath: string;
  // Nothing reads this yet — a later C5 unit wires the global review config.
  // It ships now on purpose: arriving beside a retired name is what makes
  // the change above a rename instead of a silent re-point.
  reviewConfigPath: string;
  logPath: string;
  lockPath: string;
  launchdLogPath: string;
  // W4 (#23): ONE global sqlite db, siblings with reposDir rather than
  // nested under it, so GC's `glob.scan({ cwd: reposDir })` (store/gc.ts)
  // structurally cannot enumerate or delete it.
  metricsDbPath: string;
  // Canonical product database (Fundamentals #6 / observability-canonical-store.md)
  prheroDbPath: string;
  // Local store server Unix domain socket
  storeSocketPath: string;
  // Upgrade check TTL cache
  upgradeCheckPath: string;
  // D1-08 PR3 (§9.2/Q5): the persisted, non-secret HMAC key that derives
  // rate-limit bucket IDs. Sibling of the other home files for the same
  // reason as metricsDbPath: one place, no drift between the layout and the
  // consumer that reads it. Rotation is delete-the-file.
  bucketKeyPath: string;
}

export function prheroLayout(
  home: string,
  exists?: (p: string) => boolean,
): PrheroLayout {
  const dir = resolveHomeDir(home, exists);
  return {
    dir,
    nodeModulesDir: path.join(dir, "node_modules"),
    reposDir: path.join(dir, "repos"),
    watchConfigPath: path.join(dir, "watch.json"),
    reviewConfigPath: path.join(dir, "config.json"),
    logPath: path.join(dir, "watch.log"),
    lockPath: path.join(dir, "watch.lock"),
    launchdLogPath: path.join(dir, "launchd.log"),
    metricsDbPath: path.join(dir, "metrics.db"),
    prheroDbPath: path.join(dir, "prhero.db"),
    storeSocketPath: path.join(dir, "store.sock"),
    upgradeCheckPath: path.join(dir, "upgrade-check.json"),
    bucketKeyPath: path.join(dir, "bucket-key"),
  };
}

export interface RepoHomePaths {
  repoId: string;
  root: string;
  registry: string;
  worktrees: string;
  runs: string;
}

export function repoHomePaths(home: string, repoId: string): RepoHomePaths {
  const root = path.join(prheroLayout(home).reposDir, repoId);
  return {
    repoId,
    root,
    registry: path.join(root, "registry.json"),
    worktrees: path.join(root, "worktrees"),
    runs: path.join(root, "runs"),
  };
}

// Review trees live under the product home, keyed by canonical remote, not
// by the operator checkout basename. Two clones of the same GitHub repo
// therefore share one worktree for PR N.
export function prWorktreePath(
  home: string,
  repoId: string,
  pr: number,
): string {
  return path.join(repoHomePaths(home, repoId).worktrees, `pr-${pr}`);
}

// Run artifacts NEVER live inside the reviewed tree. The default root is
// now the same home as the worktrees, so ledger/watch/GC scan one place.
export function defaultRunRoot(home: string, repoId: string): string {
  return repoHomePaths(home, repoId).runs;
}

// The pre-W3 sibling formulas, kept only so a leftover tree can be named
// in a migration hint. New reviews never create these paths.
export function legacyWorktreePath(operatorRoot: string, pr: number): string {
  const parent = path.dirname(operatorRoot);
  return path.join(
    parent,
    `${path.basename(operatorRoot)}-worktrees`,
    `pr-${pr}`,
  );
}

export function legacyRunRoot(operatorRoot: string): string {
  const parent = path.dirname(operatorRoot);
  return path.join(parent, `${path.basename(operatorRoot)}-prhero-runs`);
}

export function worktreeLockPath(
  home: string,
  repoId: string,
  pr: number,
): string {
  return `${prWorktreePath(home, repoId, pr)}.lock`;
}

export function registryLockPath(registryPath: string): string {
  return `${registryPath}.lock`;
}

// Exclusive pid-file lock (O_EXCL create, steal a dead holder, fail loud
// on a live one). The I/O shell in home.ts enacts this; GC asks
// worktreeInFlight, which is the same "live pid" predicate.
export type PidLockDecision =
  | { action: "create" }
  | { action: "steal"; deadPid: number | null }
  | { action: "held"; pid: number };

export function decidePidLock(input: {
  fileExists: boolean;
  existingPid: number | null;
  holderAlive: boolean;
}): PidLockDecision {
  if (!input.fileExists) return { action: "create" };
  if (input.existingPid === null || !input.holderAlive) {
    return { action: "steal", deadPid: input.existingPid };
  }
  return { action: "held", pid: input.existingPid };
}

// ---------------------------------------------------------------------------
// Repo identity: origin URL → a filesystem-safe id.
//
// origin only (extra remotes ignored). SSH and HTTPS of the same GitHub
// repo must collide. The id is nested (`github.com/org/repo`) so a human
// can find it; `..` and empty segments are rejected so a weird remote
// cannot escape ~/.prhero/repos/. GitHub's namespace is case-insensitive,
// so the path is folded there; other hosts may treat Org/Repo and org/repo
// as distinct, and folding them would share one git-dir owner across two
// remotes.

export function canonicalRemoteId(originUrl: string): string {
  const trimmed = originUrl.trim();
  if (trimmed.length === 0) {
    throw new CliUsageError("origin URL is empty");
  }
  // Reject before URL.parse: the parser collapses `/../`, which would let a
  // remote escape ~/.prhero/repos/ as a lookalike of a real host/path.
  if (
    trimmed
      .split(/[/\\:]/)
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw new CliUsageError(
      `origin URL contains an empty or parent path segment: ` +
        JSON.stringify(originUrl),
    );
  }
  let host: string;
  let repoPath: string;
  const scp = /^([^@\s/]+)@([^:]+):(.+)$/.exec(trimmed);
  if (scp !== null && !trimmed.includes("://")) {
    host = scp[2] ?? "";
    repoPath = scp[3] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new CliUsageError(
        `origin URL is not a valid remote: ${JSON.stringify(originUrl)}`,
      );
    }
    host = parsed.hostname;
    repoPath = parsed.pathname;
  }
  host = host.toLowerCase();
  repoPath = repoPath.replaceAll("\\", "/").replace(/^\/+/, "");
  repoPath = repoPath.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (host === "github.com" || host.endsWith(".github.com")) {
    repoPath = repoPath.toLowerCase();
  }
  if (host.length === 0 || repoPath.length === 0) {
    throw new CliUsageError(
      `origin URL is missing a host or path: ${JSON.stringify(originUrl)}`,
    );
  }
  const segments = [host, ...repoPath.split("/")];
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new CliUsageError(
        `origin URL contains an empty or parent path segment: ` +
          JSON.stringify(originUrl),
      );
    }
  }
  return segments.join("/");
}

// ---------------------------------------------------------------------------
// registry.json — which checkout owns `git worktree add` for this remote.
//
// git worktree add is bound to one git dir. Two independent clones cannot
// share a worktree without picking a single owner. First registration wins;
// a second clone of the same origin is appended and does not steal ownership.
// If the owner path is gone, fail loud — do not silently promote the cwd.

export interface WorktreeStamp {
  last_review_at: string;
}

export interface RepoRegistry {
  canonical_remote: string;
  origin_url: string;
  git_dir_owner: string;
  operator_checkouts: string[];
  worktrees: Record<string, WorktreeStamp>;
}

export type RegistryUpsert =
  | { action: "create"; registry: RepoRegistry }
  | { action: "append-checkout"; registry: RepoRegistry }
  | { action: "unchanged"; registry: RepoRegistry }
  | { action: "owner-gone"; registry: RepoRegistry; message: string };

export function decideRegistryUpsert(input: {
  existing: RepoRegistry | null;
  canonicalRemote: string;
  originUrl: string;
  checkoutPath: string;
  ownerPresent: boolean;
}): RegistryUpsert {
  const checkout = path.resolve(input.checkoutPath);
  if (input.existing === null) {
    return {
      action: "create",
      registry: {
        canonical_remote: input.canonicalRemote,
        origin_url: input.originUrl,
        git_dir_owner: checkout,
        operator_checkouts: [checkout],
        worktrees: {},
      },
    };
  }
  const registry = input.existing;
  if (!input.ownerPresent) {
    return {
      action: "owner-gone",
      registry,
      message:
        `git-dir owner ${registry.git_dir_owner} is gone or is no longer a ` +
        `git directory. Delete ${input.canonicalRemote}'s registry.json and ` +
        `re-run from a live clone so that checkout becomes the new owner.`,
    };
  }
  const known = registry.operator_checkouts.some(
    (stored) => path.resolve(stored) === checkout,
  );
  if (known) {
    return { action: "unchanged", registry };
  }
  return {
    action: "append-checkout",
    registry: {
      ...registry,
      operator_checkouts: [...registry.operator_checkouts, checkout],
    },
  };
}

export function touchWorktreeStamp(
  registry: RepoRegistry,
  pr: number,
  isoTimestamp: string,
): RepoRegistry {
  return {
    ...registry,
    worktrees: {
      ...registry.worktrees,
      [String(pr)]: { last_review_at: isoTimestamp },
    },
  };
}

export function parseRepoRegistry(raw: string): RepoRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `registry.json is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError("registry.json must be a single JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const canonical = requiredString(record, "canonical_remote");
  const originUrl = requiredString(record, "origin_url");
  const owner = requiredString(record, "git_dir_owner");
  const checkouts = record.operator_checkouts;
  if (!Array.isArray(checkouts) || checkouts.length === 0) {
    throw new CliUsageError(
      `registry.json "operator_checkouts" must be a non-empty array, got: ` +
        JSON.stringify(checkouts),
    );
  }
  const operator_checkouts: string[] = [];
  for (let i = 0; i < checkouts.length; i++) {
    const entry = checkouts[i];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new CliUsageError(
        `registry.json operator_checkouts[${i}] must be a non-empty string, ` +
          `got: ${JSON.stringify(entry)}`,
      );
    }
    operator_checkouts.push(entry);
  }
  return {
    canonical_remote: canonical,
    origin_url: originUrl,
    git_dir_owner: owner,
    operator_checkouts,
    worktrees: parseWorktreeStamps(record.worktrees),
  };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliUsageError(
      `registry.json "${key}" must be a non-empty string, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

function parseWorktreeStamps(raw: unknown): Record<string, WorktreeStamp> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CliUsageError(
      `registry.json "worktrees" must be an object, got: ${JSON.stringify(raw)}`,
    );
  }
  const stamps: Record<string, WorktreeStamp> = {};
  for (const [pr, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(pr) || Number(pr) < 1) {
      throw new CliUsageError(
        `registry.json worktrees key must be a positive PR number, got: ` +
          JSON.stringify(pr),
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CliUsageError(
        `registry.json worktrees[${pr}] must be an object`,
      );
    }
    const stamp = value as Record<string, unknown>;
    if (
      typeof stamp.last_review_at !== "string" ||
      stamp.last_review_at.trim().length === 0
    ) {
      throw new CliUsageError(
        `registry.json worktrees[${pr}].last_review_at must be a non-empty ` +
          `string, got: ${JSON.stringify(stamp.last_review_at)}`,
      );
    }
    stamps[pr] = { last_review_at: stamp.last_review_at };
  }
  return stamps;
}

export function serializeRepoRegistry(registry: RepoRegistry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export function ownerGoneMessage(
  registryPath: string,
  message: string,
): string {
  return `${message} (registry: ${registryPath})`;
}

// Loud, copy-pasteable, and never a move. The leftover tree's .git file
// still points at the old clone; auto-moving it is how you detach a live
// codegraph daemon. The next review recreates under the home.
export function legacyMigrationHint(input: {
  operatorRoot: string;
  legacyWorktree: string;
  newWorktree: string;
}): string[] {
  return [
    `legacy worktree still at ${input.legacyWorktree}`,
    `Crysk now keeps review trees under ${input.newWorktree}`,
    "remove the leftover with:",
    `  git -C ${input.operatorRoot} worktree remove --force ${input.legacyWorktree}`,
  ];
}

export function missingOriginMessage(repoRoot: string): string {
  return (
    `no git remote named origin in ${repoRoot} — Crysk keys worktrees ` +
    "and run artifacts by the origin URL, so a checkout without origin " +
    "cannot use the global home. Add origin, or pass --out for this run."
  );
}
