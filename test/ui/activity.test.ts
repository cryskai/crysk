import { describe, expect, test } from "bun:test";
import type { ActiveRunRecord, RunHistoryItem } from "#store/activity";
import {
  renderActiveRuns,
  renderActivityScreen,
  renderRunHistory,
  renderWatcherSpend,
} from "#ui/activity";

describe("ui-activity renderers", () => {
  const sampleRuns: ActiveRunRecord[] = [
    {
      pid: 84219,
      repo: "juanmaagd/pr-hero",
      pr: 56,
      runDir: "/tmp/prhero-run-84219",
      startedAt: "2026-08-24T12:00:00.000Z",
    },
    {
      pid: 84220,
      repo: "musive/backend",
      runDir: "/tmp/prhero-run-84220",
      startedAt: "2026-08-24T12:01:00.000Z",
    },
  ];

  const sampleSpend = {
    launchedToday: 2,
    dailyCap: 8,
  };

  const sampleHistory: RunHistoryItem[] = [
    {
      id: "run-001",
      run_status: "ok",
      blocking: 1,
      advisory: 2,
      wall_ms: 134000,
      generated_at: "2026-08-24T11:45:00.000Z",
      pr: 55,
      repo_id: "juanmaagd/pr-hero",
    },
    {
      id: "run-002",
      run_status: "ok",
      blocking: 0,
      advisory: 0,
      wall_ms: 100000,
      generated_at: "2026-08-24T11:30:00.000Z",
      pr: 54,
      repo_id: "juanmaagd/pr-hero",
    },
  ];

  const nowMs = Date.parse("2026-08-24T12:02:00.000Z");

  test("renderActiveRuns renders running items with selection marker", () => {
    const lines = renderActiveRuns(sampleRuns, 0, {
      styles: false,
      width: 80,
      nowMs,
    });

    const output = lines.join("\n");
    expect(output).toContain("84219");
    expect(output).toContain("juanmaagd/pr-hero");
    expect(output).toContain("PR #56");
    expect(output).toContain("02m 00s");
  });

  test("renderWatcherSpend renders launches over daily cap", () => {
    const lines = renderWatcherSpend(sampleSpend, {
      styles: false,
      width: 80,
    });

    const output = lines.join("\n");
    expect(output).toContain("Watcher today: 2/8 launches (daily cap)");
  });

  test("renderRunHistory renders past reviews with findings counts and duration", () => {
    const lines = renderRunHistory(sampleHistory, {
      styles: false,
      width: 80,
    });

    const output = lines.join("\n");
    expect(output).toContain("PR #55");
    expect(output).toContain("1 blocking");
    expect(output).toContain("02m 14s");
    expect(output).not.toContain("$");
    expect(output).not.toContain("Cost");
    expect(output).toContain("clean");
  });

  test("renderActivityScreen with styles: false contains zero ANSI escape sequences", () => {
    const lines = renderActivityScreen(
      {
        runs: sampleRuns,
        spend: sampleSpend,
        history: sampleHistory,
        selectedIndex: 0,
      },
      {
        styles: false,
        width: 80,
        nowMs,
      },
    );

    const output = lines.join("\n");
    expect(output).not.toContain("\x1b");
    expect(output).toContain("Active Reviews & Activity");
    expect(output).toContain("Watcher today: 2/8 launches");
    expect(output).toContain("Recent Completed Reviews");
  });

  test("renderActivityScreen renders explicit empty states when no runs or history exist", () => {
    const lines = renderActivityScreen(
      {
        runs: [],
        spend: { launchedToday: 0, dailyCap: 10 },
        history: [],
      },
      {
        styles: false,
        width: 80,
        nowMs,
      },
    );

    const output = lines.join("\n");
    expect(output).toContain("No active reviews currently running.");
    expect(output).toContain("No completed reviews found in store.");
  });
});
