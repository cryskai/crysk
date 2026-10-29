import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  decideGc,
  GC_LAUNCHD_LABEL,
  GH_PR_VIEW_TIMEOUT_MS,
  gcLaunchdLogPath,
  gcPlistPath,
  parseGhPrState,
  parseWorktreePr,
  renderGcPlist,
  renderGcStatus,
  worktreeRemoveArgs,
} from "#store/gc-preflight";
import { parsePlistInterval } from "#watch/preflight";
import { GC_TTL_HOURS, prheroLayout } from "../../src/home-preflight";

const NOW = Date.parse("2026-08-15T12:00:00Z");
const HOUR = 60 * 60 * 1000;

describe("decideGc", () => {
  test("open and fresh is kept", () => {
    expect(
      decideGc({
        prState: "open",
        lastReviewAtMs: NOW - 1 * HOUR,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }),
    ).toEqual({ action: "keep", reason: "open and within TTL" });
  });

  test("open and idle 73h is collected", () => {
    const decision = decideGc({
      prState: "open",
      lastReviewAtMs: NOW - (GC_TTL_HOURS + 1) * HOUR,
      dirMtimeMs: NOW - (GC_TTL_HOURS + 1) * HOUR,
      nowMs: NOW,
      inFlight: false,
    });
    expect(decision.action).toBe("collect");
    expect(decision.reason).toContain("72h");
  });

  test("merged an hour ago is collected even though TTL would keep it", () => {
    expect(
      decideGc({
        prState: "merged",
        lastReviewAtMs: NOW - 1 * HOUR,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }),
    ).toEqual({ action: "collect", reason: "PR is merged" });
  });

  test("closed is collected the same way as merged", () => {
    expect(
      decideGc({
        prState: "closed",
        lastReviewAtMs: NOW - 1 * HOUR,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("collect");
  });

  test("in-flight is kept even when merged", () => {
    expect(
      decideGc({
        prState: "merged",
        lastReviewAtMs: NOW - 100 * HOUR,
        dirMtimeMs: NOW - 100 * HOUR,
        nowMs: NOW,
        inFlight: true,
      }),
    ).toEqual({ action: "keep", reason: "in-flight (live lock)" });
  });

  test("unknown state (gh failed) still applies TTL", () => {
    expect(
      decideGc({
        prState: "unknown",
        lastReviewAtMs: NOW - 1 * HOUR,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("keep");
    expect(
      decideGc({
        prState: "unknown",
        lastReviewAtMs: NOW - 80 * HOUR,
        dirMtimeMs: NOW - 80 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("collect");
  });

  test("missing stamp falls back to mtime, then expires", () => {
    expect(
      decideGc({
        prState: "open",
        lastReviewAtMs: null,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("keep");
    expect(
      decideGc({
        prState: "open",
        lastReviewAtMs: null,
        dirMtimeMs: NOW - 80 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("collect");
    expect(
      decideGc({
        prState: "open",
        lastReviewAtMs: null,
        dirMtimeMs: null,
        nowMs: NOW,
        inFlight: false,
      }).reason,
    ).toContain("no stamp, no mtime");
  });
});

describe("parseWorktreePr", () => {
  test("reads pr-N and rejects everything else", () => {
    expect(parseWorktreePr("pr-1724")).toBe(1724);
    expect(parseWorktreePr("pr-1")).toBe(1);
    expect(parseWorktreePr("pr-1724.lock")).toBeNull();
    expect(parseWorktreePr("pr-")).toBeNull();
    expect(parseWorktreePr("1724")).toBeNull();
    expect(parseWorktreePr(".stamps")).toBeNull();
  });
});

describe("worktreeRemoveArgs", () => {
  test("hands over worktree remove --force, never rm -rf", () => {
    const args = worktreeRemoveArgs(
      "/Users/x/.crysk/repos/github.com/a/b/worktrees/pr-1",
    );
    expect(args).toEqual([
      "worktree",
      "remove",
      "--force",
      "/Users/x/.crysk/repos/github.com/a/b/worktrees/pr-1",
    ]);
    expect(args.join(" ")).not.toContain("rm");
  });
});

describe("parseGhPrState", () => {
  test("maps gh's state field, and garbage is unknown not a throw", () => {
    expect(parseGhPrState(`{"state":"OPEN"}`)).toBe("open");
    expect(parseGhPrState(`{"state":"MERGED"}`)).toBe("merged");
    expect(parseGhPrState(`{"state":"CLOSED"}`)).toBe("closed");
    expect(parseGhPrState("not json")).toBe("unknown");
    expect(parseGhPrState(`{"state":"DRAFT"}`)).toBe("unknown");
  });
});

describe("GH_PR_VIEW_TIMEOUT_MS", () => {
  test("is a positive bound so a stalled gh cannot pin a lock forever", () => {
    expect(GH_PR_VIEW_TIMEOUT_MS).toBeGreaterThan(0);
    expect(GH_PR_VIEW_TIMEOUT_MS).toBe(15_000);
  });
});

describe("gc launchd paths", () => {
  test("the plist sits in LaunchAgents, the log under ~/.crysk", () => {
    expect(gcPlistPath("/Users/x")).toBe(
      `/Users/x/Library/LaunchAgents/${GC_LAUNCHD_LABEL}.plist`,
    );
    expect(gcLaunchdLogPath("/Users/x")).toBe("/Users/x/.crysk/gc-launchd.log");
  });
});

describe("renderGcPlist", () => {
  const input = {
    invocation: {
      command: "/Users/x/.bun/bin/bun",
      args: ["/Users/x/Desktop/pr-hero/src/cli.ts"],
    },
    intervalSeconds: 21600,
    logPath: "/Users/x/.crysk/gc-launchd.log",
    pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
  };

  test("program arguments are absolute runtime + entry + gc, not watch --once", () => {
    const plist = renderGcPlist(input);
    expect(plist).toContain(`<string>${GC_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain(
      "    <string>/Users/x/.bun/bin/bun</string>\n" +
        "    <string>/Users/x/Desktop/pr-hero/src/cli.ts</string>\n" +
        "    <string>gc</string>",
    );
    expect(plist).not.toContain("watch");
    expect(plist).not.toContain("--once");
    expect(plist).toContain("<integer>21600</integer>");
    expect(parsePlistInterval(plist)).toBe(21600);
    expect(plist.endsWith("\n")).toBe(true);
  });

  test("XML-hostile characters in PATH are escaped", () => {
    const plist = renderGcPlist({
      ...input,
      pathEnv: "/a&b:/c<d>:/usr/bin",
    });
    expect(plist).toContain("<string>/a&amp;b:/c&lt;d&gt;:/usr/bin</string>");
  });

  // A compiled binary contributes NO entry path — it IS the entry. The old
  // fixed runtime+entry pair had no way to say that, so `gc install` rendered
  // `<binary> /$bunfs/root/cli.ts gc`, which launchd ran every interval
  // forever and the CLI rejected every time as an unknown command.
  test("a compiled invocation puts the subcommand straight after the binary", () => {
    const plist = renderGcPlist({
      ...input,
      invocation: { command: "/usr/local/bin/pr-hero", args: [] },
    });
    expect(plist).toContain(
      "  <array>\n" +
        "    <string>/usr/local/bin/pr-hero</string>\n" +
        "    <string>gc</string>\n" +
        "  </array>",
    );
    expect(plist).not.toContain("cli.ts");
    expect(plist).not.toContain("$bunfs");
  });
});

// W4 (#23): GC (store/gc.ts) walks ONLY `glob.scan({ cwd: reposDir })` — it never
// lists ~/.crysk itself. metrics.db (W4) must stay a SIBLING of reposDir,
// never a descendant, or a future "collect everything idle under the home"
// sweep could delete run history GC has no business touching. No prod
// change: prheroLayout already places metricsDbPath outside reposDir
// (Phase 1); this test locks that invariant down so a future edit to
// prheroLayout cannot regress it silently.
describe("metrics db is outside the GC scan root", () => {
  test("metricsDbPath sits beside reposDir, not inside it", () => {
    const layout = prheroLayout("/Users/x");
    expect(layout.metricsDbPath.startsWith(`${layout.reposDir}/`)).toBe(false);
    expect(layout.metricsDbPath).not.toBe(layout.reposDir);
  });

  test("metricsDbPath is a direct child of the same dir reposDir hangs off, one level above the GC scan root", () => {
    const layout = prheroLayout("/Users/x");
    expect(path.dirname(layout.metricsDbPath)).toBe(layout.dir);
    expect(path.dirname(layout.reposDir)).toBe(layout.dir);
  });
});

describe("renderGcStatus", () => {
  const plistPath = `/Users/x/Library/LaunchAgents/${GC_LAUNCHD_LABEL}.plist`;
  const logPath = "/Users/x/.crysk/gc-launchd.log";

  test("names the install command when nothing is loaded", () => {
    const text = renderGcStatus({
      plistPath,
      logPath,
      installed: false,
      intervalSeconds: null,
    }).join("\n");
    expect(text).toContain('not installed — run "pr-hero gc install"');
    expect(text).not.toContain("watch install");
  });

  test("reports the interval when installed", () => {
    const text = renderGcStatus({
      plistPath,
      logPath,
      installed: true,
      intervalSeconds: 21600,
    }).join("\n");
    expect(text).toContain("installed — one tick every 360 min");
    expect(text).toContain(plistPath);
    expect(text).toContain(logPath);
  });
});
