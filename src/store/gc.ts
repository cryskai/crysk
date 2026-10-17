// Worktree GC I/O (W3 / GitHub #18). Scans ~/.prhero/repos/*/worktrees,
// asks gh for PR state, and tears trees down with `git worktree remove
// --force` only. Decisions live in store/gc-preflight.ts. Also sweeps the
// verified execution snapshots crashed runs left in $TMPDIR (#303).
//
// Same git-runner rule as the other shells: args as an ARRAY, never an
// interpolated shell string. Never rm -rf — a live codegraph daemon holds
// .codegraph/daemon.sock.

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "#git/git";
import {
  type SnapshotSweepReport,
  sweepStaleExecutionSnapshots,
} from "#model/exec-snapshots";
import { type CliOptions, DEFAULT_GC_INTERVAL_MIN } from "#review/preflight";
import { log } from "#ui/primitives";
import { parsePlistInterval } from "#watch/preflight";
import {
  isNpxCacheInvocation,
  NPX_REGISTRATION_REFUSED,
  selfInvocation,
} from "../assets";
import { CliError } from "../errors";
import {
  acquirePidLock,
  releasePidLock,
  resolveRepoHome,
  worktreeInFlight,
} from "../home";
import {
  parseRepoRegistry,
  prheroLayout,
  type RepoRegistry,
  repoHomePaths,
  worktreeLockPath,
} from "../home-preflight";
import {
  decideGc,
  GC_LAUNCHD_LABEL,
  GH_PR_VIEW_TIMEOUT_MS,
  gcLaunchdLogPath,
  gcPlistPath,
  type PrLifecycle,
  parseGhPrState,
  parseWorktreePr,
  renderGcPlist,
  renderGcStatus,
  worktreeRemoveArgs,
} from "./gc-preflight";

async function ghPrStateJson(cwd: string, pr: number): Promise<string | null> {
  const proc = Bun.spawn(["gh", "pr", "view", String(pr), "--json", "state"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: GH_PR_VIEW_TIMEOUT_MS,
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return null;
  return stdout;
}

interface DiscoveredWorktree {
  repoId: string;
  pr: number;
  worktreePath: string;
  lockPath: string;
  registry: RepoRegistry;
  dirMtimeMs: number | null;
}

async function discoverWorktrees(
  home: string,
  onlyRepoId: string | undefined,
): Promise<DiscoveredWorktree[]> {
  const reposDir = prheroLayout(home).reposDir;
  if (!existsSync(reposDir)) return [];
  const found: DiscoveredWorktree[] = [];
  const glob = new Bun.Glob("**/registry.json");
  for await (const rel of glob.scan({ cwd: reposDir })) {
    const registryPath = path.join(reposDir, rel);
    let registry: RepoRegistry;
    try {
      registry = parseRepoRegistry(await Bun.file(registryPath).text());
    } catch {
      continue;
    }
    if (onlyRepoId !== undefined && registry.canonical_remote !== onlyRepoId) {
      continue;
    }
    const paths = repoHomePaths(home, registry.canonical_remote);
    if (!existsSync(paths.worktrees)) continue;
    for (const entry of await readdir(paths.worktrees, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const pr = parseWorktreePr(entry.name);
      if (pr === null) continue;
      const worktreePath = path.join(paths.worktrees, entry.name);
      let dirMtimeMs: number | null = null;
      try {
        dirMtimeMs = (await stat(worktreePath)).mtimeMs;
      } catch {
        dirMtimeMs = null;
      }
      found.push({
        repoId: registry.canonical_remote,
        pr,
        worktreePath,
        lockPath: worktreeLockPath(home, registry.canonical_remote, pr),
        registry,
        dirMtimeMs,
      });
    }
  }
  found.sort((a, b) =>
    a.repoId === b.repoId ? a.pr - b.pr : a.repoId.localeCompare(b.repoId),
  );
  return found;
}

function stampMs(registry: RepoRegistry, pr: number): number | null {
  const stamp = registry.worktrees[String(pr)]?.last_review_at;
  if (stamp === undefined) return null;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function runGc(input: {
  home: string;
  repoId?: string;
  dryRun: boolean;
  nowMs?: number;
  silent?: boolean;
}): Promise<{ collected: number; kept: number; failed: number }> {
  const nowMs = input.nowMs ?? Date.now();
  const trees = await discoverWorktrees(input.home, input.repoId);
  let collected = 0;
  let kept = 0;
  let failed = 0;
  for (const tree of trees) {
    let prState: PrLifecycle = "unknown";
    const raw = await ghPrStateJson(tree.registry.git_dir_owner, tree.pr);
    if (raw !== null) {
      prState = parseGhPrState(raw);
    } else if (!input.silent) {
      log(
        `gc: gh pr view ${tree.pr} failed for ${tree.repoId}; applying TTL only`,
      );
    }
    const decision = decideGc({
      prState,
      lastReviewAtMs: stampMs(tree.registry, tree.pr),
      dirMtimeMs: tree.dirMtimeMs,
      nowMs,
      inFlight: worktreeInFlight(tree.lockPath),
    });
    if (!input.silent) {
      log(
        `${decision.action.padEnd(8)} pr-${tree.pr}  ${tree.repoId}  ${decision.reason}`,
      );
    }
    if (decision.action === "keep") {
      kept++;
      continue;
    }
    if (input.dryRun) {
      collected++;
      continue;
    }
    // Collect is check-then-act unless we hold this PR's lock across the
    // remove: a review can acquirePidLock in the gap and then have its
    // tree yanked. A live holder fails loud — treat that as in-flight.
    try {
      await acquirePidLock(tree.lockPath);
    } catch (error) {
      if (
        error instanceof CliError &&
        error.message.startsWith("lock held by pid")
      ) {
        kept++;
        if (!input.silent) {
          log(`keep     pr-${tree.pr}  ${tree.repoId}  in-flight (live lock)`);
        }
        continue;
      }
      throw error;
    }
    try {
      const removed = await git(
        tree.registry.git_dir_owner,
        worktreeRemoveArgs(tree.worktreePath),
      );
      if (!removed.ok) {
        failed++;
        if (!input.silent) {
          log(
            `gc: git worktree remove --force ${tree.worktreePath} failed: ` +
              removed.stderr.trim(),
          );
        }
        continue;
      }
      collected++;
    } finally {
      await releasePidLock(tree.lockPath);
    }
  }
  return { collected, kept, failed };
}

function formatBytes(bytes: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  // Compare the value as it will be DISPLAYED: 1048575 bytes is 1023.999 KB,
  // which toFixed(1) rounds to "1024.0 KB" — it must print as "1.0 MB".
  while (Number(value.toFixed(1)) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function renderSnapshotGcLine(
  report: SnapshotSweepReport,
  dryRun: boolean,
): string {
  const verb = dryRun
    ? "dry run: exec snapshots would remove"
    : "gc: exec snapshots removed";
  return (
    `${verb} ${report.removed} (${formatBytes(report.removedBytes)}), keep ${report.kept}` +
    (report.failed > 0 ? `, ${report.failed} failed` : "")
  );
}

// #303: the crash backstop for snapshots no process released — SIGKILL,
// a crash, default-signal death. Same rules as the opportunistic sweep (dead
// owner pid or older than 6 h; never another user's entry), but unthrottled
// and reported. Best-effort: a snapshot that cannot be removed is counted
// in the line, never a reason to fail the worktree gc around it. Never
// throws: gcCommand runs it from a `finally`, where a throw would replace
// the worktree gc's own error.
export async function gcExecutionSnapshots(input: {
  readonly dryRun: boolean;
  readonly snapshotBase?: string;
}): Promise<string> {
  try {
    const report = await sweepStaleExecutionSnapshots({
      snapshotBase: input.snapshotBase,
      dryRun: input.dryRun,
    });
    return renderSnapshotGcLine(report, input.dryRun);
  } catch (error) {
    return `gc: exec snapshot sweep failed: ${(error as Error).message}`;
  }
}

export async function gcCommand(options: CliOptions): Promise<number> {
  if (options.gc === "install") {
    return gcInstall(options.interval ?? DEFAULT_GC_INTERVAL_MIN);
  }
  if (options.gc === "uninstall") return gcUninstall();
  if (options.gc === "status") return gcStatus();

  const home = os.homedir();
  let result: Awaited<ReturnType<typeof runGc>>;
  try {
    // parseArgs defaults --repo to ".". For gc that means "the whole home",
    // not "the current checkout" — scoping takes an explicit path.
    let repoId: string | undefined;
    if (options.repo !== ".") {
      const resolved = await resolveRepoHome({
        home,
        operatorRoot: path.resolve(options.repo),
        persist: false,
      });
      repoId = resolved.repoId;
    }
    result = await runGc({
      home,
      repoId,
      dryRun: options.dryRun,
    });
    const verb = options.dryRun ? "dry run: would collect" : "gc: collected";
    log(
      `${verb} ${result.collected}, keep ${result.kept}` +
        (result.failed > 0 ? `, ${result.failed} failed` : ""),
    );
  } finally {
    // #303: the snapshot sweep is the launchd backstop for SIGKILL/crash
    // leftovers, so it runs even when the worktree half throws (a scoped
    // --repo without origin, an fs or lock error) — and before the worktree
    // failure throw below. It never throws, so it cannot mask that error.
    log(await gcExecutionSnapshots({ dryRun: options.dryRun }));
  }
  if (!options.dryRun && result.failed > 0) {
    throw new CliError(
      `gc failed to remove ${result.failed} worktree(s); see stderr`,
    );
  }
  return 0;
}

async function run(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

async function gcInstall(intervalMin: number): Promise<number> {
  if (process.platform !== "darwin") {
    throw new CliError(
      "gc install renders a macOS launchd agent. On other systems run " +
        "`pr-hero gc` from cron.",
    );
  }
  // selfInvocation(), not a hand-built runtime + src/cli.ts pair: the pair
  // is only correct for a source checkout, and the compiled binary it was
  // wrong for is the one users install. Checked before any write, so a refused
  // install leaves nothing on disk.
  const invocation = selfInvocation();
  if (isNpxCacheInvocation(invocation)) {
    throw new CliError(NPX_REGISTRATION_REFUSED);
  }
  const home = os.homedir();
  const plistPath = gcPlistPath(home);
  const logPath = gcLaunchdLogPath(home);
  await mkdir(prheroLayout(home).dir, { recursive: true });
  await mkdir(path.dirname(plistPath), { recursive: true });
  const plist = renderGcPlist({
    invocation,
    intervalSeconds: intervalMin * 60,
    logPath,
    pathEnv: process.env.PATH ?? "",
  });
  if (existsSync(plistPath)) {
    const unloaded = await run(["launchctl", "unload", "-w", plistPath]);
    log(
      unloaded.ok
        ? `unloaded previous ${GC_LAUNCHD_LABEL}`
        : "previous plist present but not loaded (fine, replacing it)",
    );
  }
  await Bun.write(plistPath, plist);
  const loaded = await run(["launchctl", "load", "-w", plistPath]);
  if (!loaded.ok) {
    throw new CliError(
      `launchctl load -w ${plistPath} failed: ${loaded.stderr.trim()}`,
    );
  }
  log(`wrote  ${plistPath}`);
  log(`loaded ${GC_LAUNCHD_LABEL} — one tick every ${intervalMin} min`);
  log(`tick output: ${logPath}`);
  return 0;
}

async function gcUninstall(): Promise<number> {
  if (process.platform !== "darwin") {
    throw new CliError(
      "gc uninstall manages a macOS launchd agent; there is nothing to " +
        "uninstall on this system.",
    );
  }
  const plistPath = gcPlistPath(os.homedir());
  if (!existsSync(plistPath)) {
    log(`nothing installed (no ${plistPath})`);
    return 0;
  }
  const unloaded = await run(["launchctl", "unload", "-w", plistPath]);
  log(
    unloaded.ok
      ? `unloaded ${GC_LAUNCHD_LABEL}`
      : `plist present but not loaded: ${unloaded.stderr.trim() || "(no detail)"}`,
  );
  await rm(plistPath, { force: true });
  log(`removed ${plistPath}`);
  return 0;
}

async function gcStatus(): Promise<number> {
  const home = os.homedir();
  const plistPath = gcPlistPath(home);
  const installed = existsSync(plistPath);
  const lines = renderGcStatus({
    plistPath,
    logPath: gcLaunchdLogPath(home),
    installed,
    intervalSeconds: installed
      ? parsePlistInterval(await Bun.file(plistPath).text())
      : null,
  });
  for (const line of lines) log(line);
  return 0;
}
