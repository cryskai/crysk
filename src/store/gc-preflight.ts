// Worktree GC decisions (W3 / GitHub #18), pure so the keep/collect table
// is testable offline. store/gc.ts is the I/O shell: it scans ~/.prhero/repos,
// asks gh for PR state, and runs `git worktree remove --force`.
//
// Unbounded accumulation is not allowed. Collect when the PR is merged or
// closed, OR when the tree has sat idle longer than 72h, whichever first.
// Skip an in-flight tree (a live pid on the sibling lock). Never rm -rf.

import path from "node:path";
import type { SelfInvocation } from "../assets";
import { GC_TTL_HOURS, prheroLayout } from "../home-preflight";

export type PrLifecycle = "open" | "merged" | "closed" | "unknown";
export type GcAction = "keep" | "collect";

export interface GcInput {
  prState: PrLifecycle;
  // Last successful review, from registry.json. Null means no stamp.
  lastReviewAtMs: number | null;
  // Directory mtime of the worktree itself, used only when the stamp is
  // missing. Null means we could not stat it either — treat as expired.
  dirMtimeMs: number | null;
  nowMs: number;
  ttlHours?: number;
  inFlight: boolean;
}

export interface GcDecision {
  action: GcAction;
  reason: string;
}

const HOUR_MS = 60 * 60 * 1000;

// Bound every `gh pr view` so a stalled GitHub cannot pin a review lock
// or watch.lock forever. Timed-out views become `unknown` and still
// apply TTL (same as a failed gh).
export const GH_PR_VIEW_TIMEOUT_MS = 15_000;

export function decideGc(input: GcInput): GcDecision {
  if (input.inFlight) {
    return { action: "keep", reason: "in-flight (live lock)" };
  }
  if (input.prState === "merged" || input.prState === "closed") {
    return {
      action: "collect",
      reason: `PR is ${input.prState}`,
    };
  }
  const ttlHours = input.ttlHours ?? GC_TTL_HOURS;
  const idleFrom = input.lastReviewAtMs ?? input.dirMtimeMs;
  if (idleFrom === null) {
    return {
      action: "collect",
      reason: `idle longer than ${ttlHours}h (no stamp, no mtime)`,
    };
  }
  const idleHours = (input.nowMs - idleFrom) / HOUR_MS;
  if (idleHours > ttlHours) {
    return {
      action: "collect",
      reason: `idle longer than ${ttlHours}h`,
    };
  }
  return { action: "keep", reason: "open and within TTL" };
}

// `pr-1724` → 1724. Anything else (including the sibling `.lock` file) is
// not a worktree we own.
export function parseWorktreePr(dirName: string): number | null {
  const match = /^pr-(\d+)$/.exec(dirName);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function parseGhPrState(raw: string): PrLifecycle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "unknown";
  }
  const state = (parsed as Record<string, unknown>).state;
  if (typeof state !== "string") return "unknown";
  const upper = state.toUpperCase();
  if (upper === "OPEN") return "open";
  if (upper === "MERGED") return "merged";
  if (upper === "CLOSED") return "closed";
  return "unknown";
}

// The only argv `git -C <owner>` may receive for teardown. Tests pin
// `--force` and the absence of `rm`. The path is an argument, never
// interpolated into a shell string.
export function worktreeRemoveArgs(worktreePath: string): string[] {
  return ["worktree", "remove", "--force", worktreePath];
}

// ---------------------------------------------------------------------------
// launchd agent (macOS). Rendering is pure string-out so a test can pin
// the exact plist; loading it is store/gc.ts's job. Separate label and log from
// the watcher: this agent runs `pr-hero gc` (no reviews, no watch.json).

export const GC_LAUNCHD_LABEL = "io.crysk.gc";

export function gcPlistPath(home: string): string {
  return path.join(
    home,
    "Library",
    "LaunchAgents",
    `${GC_LAUNCHD_LABEL}.plist`,
  );
}

export function gcLaunchdLogPath(home: string): string {
  return path.join(prheroLayout(home).dir, "gc-launchd.log");
}

export interface GcPlistInput {
  // The engine's OWN invocation (assets.ts's selfInvocation()), not a fixed
  // runtime + entry-script pair. A compiled binary IS the entry and
  // contributes no script path at all, which the pair had no way to say: it
  // rendered `<binary> /$bunfs/root/cli.ts gc`, a path that exists on no
  // machine, and launchd re-ran that unknown-command failure every interval
  // forever while `gc install` reported success.
  //
  // Absolute by construction (selfInvocation resolves both halves), which is
  // what launchd needs: it starts agents with a bare-bones PATH
  // (/usr/bin:/bin) that has never heard of bun or pr-hero, so a bare name
  // that resolves in every terminal resolves in nothing launchd starts.
  invocation: SelfInvocation;
  intervalSeconds: number;
  logPath: string;
  pathEnv: string;
}

export function renderGcPlist(input: GcPlistInput): string {
  const programArguments = [input.invocation.command, ...input.invocation.args];
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${GC_LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...[...programArguments, "gc"].map(
      (arg) => `    <string>${xmlEscape(arg)}</string>`,
    ),
    `  </array>`,
    `  <key>StartInterval</key>`,
    `  <integer>${input.intervalSeconds}</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(input.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(input.logPath)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${xmlEscape(input.pathEnv)}</string>`,
    `  </dict>`,
    `</dict>`,
    `</plist>`,
  ];
  return `${lines.join("\n")}\n`;
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export interface GcStatusFacts {
  plistPath: string;
  logPath: string;
  installed: boolean;
  intervalSeconds: number | null;
}

export function renderGcStatus(facts: GcStatusFacts): string[] {
  const row = (label: string, value: string): string =>
    `  ${label.padEnd(13)}${value}`;
  const launchd = facts.installed
    ? facts.intervalSeconds === null
      ? `installed (${facts.plistPath}, interval unreadable)`
      : `installed — one tick every ${formatGcInterval(facts.intervalSeconds)}`
    : 'not installed — run "pr-hero gc install" to start sweeping';
  return [
    "pr-hero gc — status",
    "",
    row("launchd", launchd),
    row("plist", facts.plistPath),
    row("tick output", facts.logPath),
  ];
}

function formatGcInterval(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}
