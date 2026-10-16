// The table a smoke run prints. Pure: it returns lines and never writes, so the
// runner decides where they go and the tests read them directly.

import type { CheckResult } from "./expect";
import type { Observation, SmokePath } from "./observe";

const HUNTERS_FAILED_NOTE =
  "the route ran, but every hunter failed, so no review was posted";

export function renderReport(
  obs: Observation,
  path: SmokePath,
  violations: readonly string[],
  exitCode: 0 | 1,
): string[] {
  const commentCounts = (kind: string) =>
    obs.comments.filter((c) => c.kind === kind).length;
  const outcomes = obs.comments
    .filter((c) => c.kind === "outcome")
    .map((c) => c.code ?? "no-code");
  const skips = obs.comments
    .filter((c) => c.kind === "skip")
    .map((c) => c.skip ?? "?");
  const rows: [string, string][] = [
    ["PR", `#${obs.prNumber} ${obs.prUrl}`],
    ["head", obs.headSha],
    [
      "run",
      obs.run
        ? `${obs.run.id} ${obs.run.status}/${obs.run.conclusion ?? "-"}`
        : "none",
    ],
    [
      "steps",
      obs.run?.steps
        .map((s) => `${s.name}=${s.conclusion ?? "-"}`)
        .join(", ") || "none",
    ],
    [
      "status",
      obs.status ? `${obs.status.state}: ${obs.status.description}` : "none",
    ],
    [
      "comments",
      `report=${commentCounts("report")} findings=${commentCounts("finding")} ` +
        `outcome=[${outcomes.join(", ")}] skip=[${skips.join(", ")}]`,
    ],
    ["artifacts", obs.artifacts.join(", ") || "none"],
    ["path", path],
    ["S7", violations.length === 0 ? "ok" : violations.join("; ")],
    ["exit", String(exitCode)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(
    ([label, value]) => `  ${label.padEnd(width)}  ${value}`,
  );
  if (path === "hunters-failed")
    lines.push(
      `  note${" ".repeat(Math.max(0, width - 4))}  ${HUNTERS_FAILED_NOTE}`,
    );
  return lines;
}

// One scenario's outcome, as the final table shows it.
export interface ScenarioResult {
  name: string;
  prUrl?: string;
  path: string;
  checks: readonly CheckResult[];
  s7: readonly string[];
  error?: string;
  refused?: boolean;
  exitCode: 0 | 1;
}

// The run's one report: a row per scenario (path, S7, exit, PR), with each of its
// expectations under it as PASS or FAIL, so a failed check is named where it
// happened. Pure: the caller decides where the lines go.
export function renderScenarioTable(
  results: readonly ScenarioResult[],
): string[] {
  const header = ["scenario", "path", "S7", "exit", "PR"];
  const rows = results.map((r) => [
    r.name,
    r.path,
    r.s7.length === 0 ? "ok" : `${r.s7.length} violation(s)`,
    String(r.exitCode),
    r.prUrl ?? "-",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const lines = [line(header), ...rows.map(line)];
  for (const r of results) {
    for (const check of r.checks) {
      const detail =
        check.pass || check.detail === undefined ? "" : ` (${check.detail})`;
      lines.push(
        `  ${check.pass ? "PASS" : "FAIL"}  ${r.name}: ${check.label}${detail}`,
      );
    }
    for (const violation of r.s7) lines.push(`  FAIL  ${r.name}: ${violation}`);
    if (r.error !== undefined) {
      lines.push(
        `  ${r.refused === true ? "REFUSED" : "ERROR"}  ${r.name}: ${r.error}`,
      );
    }
  }
  return lines;
}
