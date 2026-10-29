import type { ActiveRunRecord, RunHistoryItem } from "#store/activity";
import { bold, box, cyan, dim, green, red } from "./primitives";

export interface ActivityRenderOptions {
  styles: boolean;
  width: number;
  nowMs?: number;
}

export function formatElapsed(startedAt: string, nowMs = Date.now()): string {
  const parsed = Date.parse(startedAt);
  const diffMs = Number.isNaN(parsed) ? 0 : Math.max(0, nowMs - parsed);
  const mins = Math.floor(diffMs / 60000);
  const secs = Math.floor((diffMs % 60000) / 1000);
  return `${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
}

export function formatDuration(wallMs: number): string {
  const ms = Math.max(0, wallMs);
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
}

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}

export function formatFindingsSummary(
  blocking: number,
  advisory: number,
): string {
  if (blocking === 0 && advisory === 0) {
    return "0 findings (clean)";
  }
  const total = blocking + advisory;
  if (blocking > 0) {
    return `${total} findings (${blocking} blocking)`;
  }
  return `${total} advisory findings`;
}

export function renderActiveRuns(
  runs: ActiveRunRecord[],
  selectedIndex = 0,
  options: ActivityRenderOptions,
): string[] {
  const st = options.styles;
  const nowMs = options.nowMs ?? Date.now();
  const lines: string[] = [];

  if (runs.length === 0) {
    lines.push(dim("  No active reviews currently running.", st));
    return lines;
  }

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const isSelected = i === selectedIndex;
    const marker = isSelected ? bold(cyan("▸ ", st), st) : "  ";
    const elapsed = formatElapsed(run.startedAt, nowMs);

    const statusDot = cyan("● RUNNING", st);
    const header = `${marker}${statusDot} (PID ${run.pid}) · Elapsed: ${elapsed}`;
    lines.push(header);

    const indent = "    ";
    lines.push(`${indent}Repo:   ${bold(run.repo, st)}`);
    if (run.pr !== undefined) {
      lines.push(`${indent}Target: PR #${run.pr}`);
    }
    lines.push(`${indent}RunDir: ${dim(run.runDir, st)}`);

    if (i < runs.length - 1) {
      lines.push("");
    }
  }

  return lines;
}

export function renderWatcherSpend(
  spend: { launchedToday: number; dailyCap: number },
  options: { styles: boolean; width: number },
): string[] {
  const st = options.styles;
  return [
    `Watcher today: ${bold(String(spend.launchedToday), st)}/${spend.dailyCap} launches (daily cap)`,
  ];
}

export function renderRunHistory(
  history: RunHistoryItem[],
  options: { styles: boolean; width: number },
): string[] {
  const st = options.styles;
  const lines: string[] = [];

  if (history.length === 0) {
    lines.push(dim("  No completed reviews found in store.", st));
    return lines;
  }

  for (const item of history) {
    const isOk = item.run_status === "complete" || item.run_status === "ok";
    const statusIcon = isOk ? green("✓", st) : red("✗", st);
    const target =
      item.pr !== undefined && item.pr !== null
        ? `PR #${item.pr}`
        : "Branch review";
    const findings = formatFindingsSummary(item.blocking, item.advisory);
    const duration = formatDuration(item.wall_ms);
    const cost = formatCost(item.cost_usd_est);

    const line = `  ${statusIcon} ${bold(target, st)} · ${findings} · Duration: ${duration} · Cost: ${cost}`;
    lines.push(line);
  }

  return lines;
}

export interface ActivityScreenData {
  runs: ActiveRunRecord[];
  spend: { launchedToday: number; dailyCap: number };
  history: RunHistoryItem[];
  selectedIndex?: number;
  repoFilter?: string;
}

export function renderActivityScreen(
  data: ActivityScreenData,
  options: ActivityRenderOptions,
): string[] {
  const st = options.styles;
  const selectedIndex = data.selectedIndex ?? 0;

  const content: string[] = [];

  // 1. Active Runs
  content.push(bold("Active Reviews:", st));
  content.push(...renderActiveRuns(data.runs, selectedIndex, options));
  content.push("");

  // 2. Watcher Spend
  content.push(...renderWatcherSpend(data.spend, options));
  content.push(dim("─".repeat(Math.max(20, options.width - 6)), st));

  // 3. Recent Completed Reviews
  content.push(
    bold(
      "Recent Completed Reviews (last 10, from prhero.db in the Crysk home):",
      st,
    ),
  );
  content.push(...renderRunHistory(data.history, options));
  content.push("");

  // 4. Footer hints
  const selectedPid = data.runs[selectedIndex]?.pid;
  const killHint =
    selectedPid !== undefined
      ? ` • enter: kill selected (PID ${selectedPid})`
      : "";
  content.push(dim(`j/k: move${killHint} • r: refresh • q/esc: back`, st));
  if (selectedPid !== undefined) {
    content.push(dim(`$ crysk activity --kill ${selectedPid}`, st));
  }

  return box("Active Reviews & Activity", content, {
    styles: options.styles,
    width: options.width,
  });
}
