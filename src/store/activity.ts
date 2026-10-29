import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { countLaunchedToday, localIsoTimestamp } from "#watch/preflight";
import { resolveHomeDir } from "../brand-paths";
import { prheroLayout } from "../home-preflight";

export interface ActiveRunRecord {
  pid: number;
  repo: string;
  pr?: number;
  runDir: string;
  startedAt: string;
}

export function activeRunsDir(home: string): string {
  return path.join(resolveHomeDir(home), "active_runs");
}

export function activeRunFilePath(home: string, pid: number): string {
  return path.join(activeRunsDir(home), `${pid}.json`);
}

export function isPidAlive(
  pid: number,
  killFn: (pid: number, signal: number) => void = (p, s) => process.kill(p, s),
): boolean {
  try {
    killFn(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string })?.code === "EPERM";
  }
}

export interface RegisterActiveRunOptions {
  home?: string;
  writeFile?: (path: string, content: string) => void;
  mkdir?: (path: string, opts?: { recursive?: boolean }) => void;
}

export async function registerActiveRun(
  record: ActiveRunRecord,
  options: RegisterActiveRunOptions = {},
): Promise<void> {
  const home = options.home ?? os.homedir();
  const dir = activeRunsDir(home);
  const targetPath = activeRunFilePath(home, record.pid);

  const mkdir =
    options.mkdir ??
    ((p, o) => {
      if (!options.writeFile) mkdirSync(p, o);
    });
  const writeFile =
    options.writeFile ?? ((p, c) => writeFileSync(p, c, "utf-8"));

  mkdir(dir, { recursive: true });
  writeFile(targetPath, `${JSON.stringify(record, null, 2)}\n`);
}

export interface UnregisterActiveRunOptions {
  home?: string;
  unlink?: (path: string) => void;
  exists?: (path: string) => boolean;
}

export async function unregisterActiveRun(
  pid: number,
  options: UnregisterActiveRunOptions = {},
): Promise<void> {
  const home = options.home ?? os.homedir();
  const targetPath = activeRunFilePath(home, pid);
  const exists = options.exists ?? existsSync;
  const unlink = options.unlink ?? unlinkSync;

  if (exists(targetPath)) {
    try {
      unlink(targetPath);
    } catch {
      // Ignore
    }
  }
}

export interface ListActiveRunsOptions {
  home?: string;
  readdir?: (dir: string) => string[];
  readFile?: (path: string) => string | undefined;
  exists?: (path: string) => boolean;
  isAlive?: (pid: number) => boolean;
  unlink?: (path: string) => void;
}

export async function listActiveRuns(
  options: ListActiveRunsOptions = {},
): Promise<ActiveRunRecord[]> {
  const home = options.home ?? os.homedir();
  const dir = activeRunsDir(home);
  const exists = options.exists ?? existsSync;
  const readdir = options.readdir ?? readdirSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const isAlive = options.isAlive ?? isPidAlive;
  const unlink = options.unlink ?? unlinkSync;

  if (!exists(dir)) return [];

  let entries: string[] = [];
  try {
    entries = readdir(dir);
  } catch {
    return [];
  }

  const activeRuns: ActiveRunRecord[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = path.join(dir, entry);
    const raw = readFile(fullPath);
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as ActiveRunRecord;
      if (!parsed.pid) continue;

      if (!isAlive(parsed.pid)) {
        // Stale entry: dead PID -> prune
        try {
          unlink(fullPath);
        } catch {
          // Ignore
        }
        continue;
      }

      activeRuns.push(parsed);
    } catch {
      // Malformed JSON -> prune
      try {
        unlink(fullPath);
      } catch {
        // Ignore
      }
    }
  }

  activeRuns.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return activeRuns;
}

export async function checkProcessIdentity(
  pid: number,
  execFn?: (cmd: string[]) => Promise<string>,
): Promise<boolean> {
  const exec =
    execFn ??
    (async (cmd: string[]) => {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return await new Response(proc.stdout).text();
    });

  try {
    const cmdline = await exec(["ps", "-o", "command=", "-p", `${pid}`]);
    const trimmed = cmdline.trim();
    if (!trimmed) return false;
    return (
      trimmed.includes("pr-hero") ||
      trimmed.includes("src/cli.ts") ||
      (trimmed.includes("bun") && trimmed.includes("review")) ||
      (trimmed.includes("node") && trimmed.includes("review"))
    );
  } catch {
    return false;
  }
}

export type KillResult =
  | { status: "not_found"; message: string }
  | { status: "identity_mismatch"; message: string }
  | {
      status: "terminated";
      pid: number;
      signal: "SIGTERM" | "SIGKILL";
      escalated: boolean;
      warning?: string;
    };

export interface KillActiveRunOptions {
  home?: string;
  isAlive?: (pid: number) => boolean;
  checkIdentity?: (pid: number) => Promise<boolean>;
  sendSignal?: (pid: number, signal: string | number) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  unregister?: (pid: number) => Promise<void>;
}

export async function killActiveRun(
  pid: number,
  options: KillActiveRunOptions = {},
): Promise<KillResult> {
  const home = options.home ?? os.homedir();
  const isAlive = options.isAlive ?? isPidAlive;
  const checkIdentity = options.checkIdentity ?? checkProcessIdentity;
  const sendSignal =
    options.sendSignal ??
    ((p: number, s: string | number) => {
      process.kill(p, s);
    });
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 10000;
  const unregister =
    options.unregister ?? ((p: number) => unregisterActiveRun(p, { home }));

  // 1. Check if process is alive
  if (!isAlive(pid)) {
    await unregister(pid);
    return {
      status: "not_found",
      message: `No active run with PID ${pid} (process is not running).`,
    };
  }

  // 2. Check identity
  const isTargetIdentity = await checkIdentity(pid);
  if (!isTargetIdentity) {
    await unregister(pid);
    return {
      status: "identity_mismatch",
      message: `PID ${pid} is running another command (PID reuse). Pruned stale entry without signalling.`,
    };
  }

  // 3. Send SIGTERM
  try {
    sendSignal(pid, "SIGTERM");
  } catch {
    await unregister(pid);
    return {
      status: "not_found",
      message: `Process ${pid} exited before signal could be delivered.`,
    };
  }

  // 4. Bounded wait up to timeoutMs
  const startMs = Date.now();
  while (Date.now() - startMs < timeoutMs) {
    if (!isAlive(pid)) {
      await unregister(pid);
      return {
        status: "terminated",
        pid,
        signal: "SIGTERM",
        escalated: false,
      };
    }
    await sleep(100);
  }

  // 5. Escalate to SIGKILL if still alive
  try {
    sendSignal(pid, "SIGKILL");
  } catch {
    // Process exited during escalation
  }
  await sleep(100);
  await unregister(pid);

  return {
    status: "terminated",
    pid,
    signal: "SIGKILL",
    escalated: true,
    warning:
      "Process did not exit after SIGTERM. Escalated to SIGKILL. Agent subprocesses may have survived; check with 'ps aux | grep claude'.",
  };
}

export interface GetWatcherSpendOptions {
  home?: string;
  countLaunchedToday?: () => Promise<number>;
  readConfig?: () => Promise<{ daily_cap?: number; dailyCap?: number }>;
}

export async function getWatcherSpend(
  options: GetWatcherSpendOptions = {},
): Promise<{ launchedToday: number; dailyCap: number }> {
  const home = options.home ?? os.homedir();
  const layout = prheroLayout(home);

  let launchedToday = 0;
  if (options.countLaunchedToday) {
    launchedToday = await options.countLaunchedToday();
  } else if (existsSync(layout.logPath)) {
    try {
      const raw = readFileSync(layout.logPath, "utf-8");
      const todayIso = localIsoTimestamp(new Date()).slice(0, 10);
      launchedToday = countLaunchedToday(raw, todayIso);
    } catch {
      launchedToday = 0;
    }
  }

  let dailyCap = 8;
  if (options.readConfig) {
    const cfg = await options.readConfig();
    if (cfg?.daily_cap !== undefined) dailyCap = cfg.daily_cap;
    else if (cfg?.dailyCap !== undefined) dailyCap = cfg.dailyCap;
  } else if (existsSync(layout.watchConfigPath)) {
    try {
      const raw = readFileSync(layout.watchConfigPath, "utf-8");
      const cfg = JSON.parse(raw);
      if (cfg?.daily_cap !== undefined) dailyCap = cfg.daily_cap;
      else if (cfg?.dailyCap !== undefined) dailyCap = cfg.dailyCap;
    } catch {
      dailyCap = 8;
    }
  }

  return { launchedToday, dailyCap };
}

export interface RunHistoryItem {
  id: string;
  run_status: string;
  blocking: number;
  advisory: number;
  wall_ms: number;
  cost_usd_est: number;
  generated_at: string;
  pr?: number;
  repo_id?: string;
}

export interface QueryRecentRunsOptions {
  home?: string;
  dbPath?: string;
  limit?: number;
  dbQuery?: (limit: number) => Promise<RunHistoryItem[]>;
}

export async function queryRecentRuns(
  options: QueryRecentRunsOptions = {},
): Promise<RunHistoryItem[]> {
  const limit = options.limit ?? 10;

  if (options.dbQuery) {
    return await options.dbQuery(limit);
  }

  const home = options.home ?? os.homedir();
  const layout = prheroLayout(home);
  const dbPath = options.dbPath ?? layout.prheroDbPath;

  if (!existsSync(dbPath)) {
    return [];
  }

  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    // Check if runs table exists
    const tableExists = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
      )
      .get() as { name?: string } | null;
    if (!tableExists) {
      db.close();
      return [];
    }

    const rows = db
      .query(
        `SELECT id, run_status, blocking, advisory, wall_ms, cost_usd_est, generated_at, pr, repo_id 
         FROM runs 
         ORDER BY generated_at DESC 
         LIMIT ?`,
      )
      .all(limit) as RunHistoryItem[];

    db.close();
    return rows;
  } catch {
    try {
      db?.close();
    } catch {
      // Ignore
    }
    return [];
  }
}
