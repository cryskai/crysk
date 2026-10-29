import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  type ActiveRunRecord,
  checkProcessIdentity,
  getWatcherSpend,
  isPidAlive,
  type KillResult,
  killActiveRun,
  listActiveRuns,
  queryRecentRuns,
  type RunHistoryItem,
  registerActiveRun,
  unregisterActiveRun,
} from "#store/activity";

describe("activity (active runs tracker & store activity monitor)", () => {
  const home = "/Users/testuser";
  const activeRunsDir = path.join(home, ".crysk", "active_runs");

  describe("2.1 Active runs registry lifecycle & stale dead-PID pruning", () => {
    test("registers and unregisters active run file", async () => {
      const written: Record<string, string> = {};
      const deleted: string[] = [];

      const record: ActiveRunRecord = {
        pid: 12345,
        repo: "juanmaagd/pr-hero",
        pr: 56,
        runDir: "/tmp/run-12345",
        startedAt: "2026-08-24T12:00:00.000Z",
      };

      await registerActiveRun(record, {
        home,
        writeFile: (p, content) => {
          written[p] = content;
        },
      });

      const expectedPath = path.join(activeRunsDir, "12345.json");
      expect(written[expectedPath]).toBeDefined();
      const parsed = JSON.parse(written[expectedPath] || "{}");
      expect(parsed.pid).toBe(12345);
      expect(parsed.repo).toBe("juanmaagd/pr-hero");
      expect(parsed.pr).toBe(56);

      await unregisterActiveRun(12345, {
        home,
        unlink: (p) => {
          deleted.push(p);
          delete written[p];
        },
        exists: (p) => p in written,
      });

      expect(deleted).toContain(expectedPath);
    });

    test("isPidAlive checks liveness using kill(pid, 0) and EPERM as alive", () => {
      const alivePid = 1001;
      const epermPid = 1002;
      const deadPid = 1003;

      const mockKill = (pid: number, _signal: number) => {
        if (pid === deadPid) {
          const err = Object.assign(new Error("No such process"), {
            code: "ESRCH",
          });
          throw err;
        }
        if (pid === epermPid) {
          const err = Object.assign(new Error("Operation not permitted"), {
            code: "EPERM",
          });
          throw err;
        }
        // alive returns void
      };

      expect(isPidAlive(alivePid, mockKill)).toBe(true);
      expect(isPidAlive(epermPid, mockKill)).toBe(true);
      expect(isPidAlive(deadPid, mockKill)).toBe(false);
    });

    test("listActiveRuns prunes stale dead-PID entries on read", async () => {
      const deleted: string[] = [];
      const files: Record<string, string> = {
        [path.join(activeRunsDir, "1001.json")]: JSON.stringify({
          pid: 1001,
          repo: "repo-alive",
          startedAt: "2026-08-24T12:00:00.000Z",
        }),
        [path.join(activeRunsDir, "1002.json")]: JSON.stringify({
          pid: 1002,
          repo: "repo-dead",
          startedAt: "2026-08-24T11:00:00.000Z",
        }),
      };

      const livePids = new Set([1001]);

      const runs = await listActiveRuns({
        home,
        readdir: () => Object.keys(files).map((p) => path.basename(p)),
        readFile: (p) => files[p],
        exists: (p) => p in files || p === activeRunsDir,
        isAlive: (pid) => livePids.has(pid),
        unlink: (p) => {
          deleted.push(p);
          delete files[p];
        },
      });

      expect(runs.length).toBe(1);
      expect(runs[0].pid).toBe(1001);
      expect(runs[0].repo).toBe("repo-alive");
      expect(deleted).toContain(path.join(activeRunsDir, "1002.json"));
    });
  });

  describe("2.1 Kill action with identity check & bounded escalation", () => {
    test("checkProcessIdentity validates pr-hero review command line", async () => {
      const isMatch = await checkProcessIdentity(1001, async (_cmd) => {
        return "bun /usr/local/bin/pr-hero review --pr 56";
      });
      expect(isMatch).toBe(true);

      const isMismatch = await checkProcessIdentity(1002, async (_cmd) => {
        return "/usr/libexec/postfix/master -w";
      });
      expect(isMismatch).toBe(false);
    });

    test("killActiveRun on identity mismatch prunes entry and refuses without signalling", async () => {
      const deleted: string[] = [];
      const signals: { pid: number; signal: string | number }[] = [];
      const _files: Record<string, string> = {
        [path.join(activeRunsDir, "2001.json")]: JSON.stringify({
          pid: 2001,
          repo: "repo-mismatch",
          startedAt: "2026-08-24T12:00:00.000Z",
        }),
      };

      const res: KillResult = await killActiveRun(2001, {
        home,
        checkIdentity: async () => false, // PID reused by other process
        isAlive: () => true,
        sendSignal: (pid, signal) => {
          signals.push({ pid, signal });
        },
        unregister: async (pid) => {
          deleted.push(path.join(activeRunsDir, `${pid}.json`));
        },
      });

      expect(res.status).toBe("identity_mismatch");
      expect(signals.length).toBe(0); // Zero signals sent!
      expect(deleted).toContain(path.join(activeRunsDir, "2001.json"));
    });

    test("killActiveRun sends SIGTERM and unregisters when process terminates normally", async () => {
      const signals: { pid: number; signal: string | number }[] = [];
      let isAliveState = true;

      const res: KillResult = await killActiveRun(3001, {
        home,
        checkIdentity: async () => true,
        isAlive: () => isAliveState,
        sendSignal: (pid, signal) => {
          signals.push({ pid, signal });
          // Process exits after receiving SIGTERM
          if (signal === "SIGTERM" || signal === 15) {
            isAliveState = false;
          }
        },
        sleep: async () => {},
        timeoutMs: 10000,
      });

      expect(res.status).toBe("terminated");
      if (res.status === "terminated") {
        expect(res.signal).toBe("SIGTERM");
        expect(res.escalated).toBe(false);
      }
      expect(signals.length).toBe(1);
      expect(signals[0].signal).toBe("SIGTERM");
    });

    test("killActiveRun escalates to SIGKILL after 10s bounded timeout with honest survivor warning", async () => {
      const signals: { pid: number; signal: string | number }[] = [];
      let isAliveState = true;

      const res: KillResult = await killActiveRun(4001, {
        home,
        checkIdentity: async () => true,
        isAlive: () => isAliveState,
        sendSignal: (pid, signal) => {
          signals.push({ pid, signal });
          if (signal === "SIGKILL" || signal === 9) {
            isAliveState = false;
          }
        },
        sleep: async () => {},
        timeoutMs: 10, // Short timeout for test
      });

      expect(res.status).toBe("terminated");
      if (res.status === "terminated") {
        expect(res.signal).toBe("SIGKILL");
        expect(res.escalated).toBe(true);
        expect(res.warning).toContain("Escalated to SIGKILL");
      }
      expect(signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    });
  });

  describe("2.1 Watcher spend and store recent history query", () => {
    test("getWatcherSpend reads countLaunchedToday and dailyCap", async () => {
      const spend = await getWatcherSpend({
        countLaunchedToday: async () => 3,
        readConfig: async () => ({ dailyCap: 10 }),
      });

      expect(spend.launchedToday).toBe(3);
      expect(spend.dailyCap).toBe(10);
    });

    test("queryRecentRuns returns capped 10 rows from database and handles empty state", async () => {
      const emptyHistory = await queryRecentRuns({
        dbQuery: async () => [],
      });
      expect(emptyHistory).toEqual([]);

      const mockItems: RunHistoryItem[] = Array.from(
        { length: 15 },
        (_, i) => ({
          id: `run-${i}`,
          run_status: i % 2 === 0 ? "ok" : "failed",
          blocking: i % 3,
          advisory: i % 2,
          wall_ms: 60000 + i * 1000,
          cost_usd_est: 0.5 + i * 0.1,
          generated_at: new Date(Date.now() - i * 60000).toISOString(),
          pr: 100 + i,
          repo_id: "juanmaagd/pr-hero",
        }),
      );

      const history = await queryRecentRuns({
        limit: 10,
        dbQuery: async (limit) => mockItems.slice(0, limit),
      });

      expect(history.length).toBe(10);
      expect(history[0].id).toBe("run-0");
    });
  });
});
