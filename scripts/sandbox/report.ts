// The table a smoke run prints. Pure: it returns lines and never writes, so the
// runner decides where they go and the tests read them directly.

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
