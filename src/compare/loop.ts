// Loop metrics' pure half (Stage 2 yardstick: rounds to a green gate, time to
// green). The impure half (gh fetch, raw.json cache) is scripts/loop-metrics.ts.
//
// The input is every state the gate commit status ever had on every commit of
// a PR. The gate is read off its description, the only place that says WHY a
// state was set: "review posted" and "N blocking finding(s)" are reviews,
// "carried from <sha>" is a prior verdict copied to a new head (not a review),
// "overridden" and "stopped by a maintainer" are a human ending the loop.

export interface RawStatus {
  createdAt: string;
  context: string;
  state: string;
  description: string | null;
}

export interface RawPr {
  repo: string;
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: string;
  isDraft: boolean;
  baseRefName?: string;
  commits: { sha: string; statuses: RawStatus[] }[];
}

type GateEvent =
  | "review-clean"
  | "review-blocking"
  | "carried-blocking"
  | "budget-exhausted"
  | "size-skipped"
  | "override"
  | "stopped"
  | "low-risk"
  | "excluded"
  | "error"
  | "pending"
  | "other-success"
  | "other-failure";

export function classifyStatus(status: RawStatus): GateEvent {
  const d = status.description ?? "";
  switch (status.state) {
    case "pending":
      return "pending";
    case "error":
      return "error";
    case "success":
      if (d === "review posted" || d === "review complete")
        return "review-clean";
      if (d.includes("overridden")) return "override";
      if (d.includes("stopped by a maintainer")) return "stopped";
      if (d.includes("low-risk paths")) return "low-risk";
      if (d.includes("every changed file is excluded")) return "excluded";
      return "other-success";
    case "failure":
      if (d.includes("blocking finding")) {
        return d.includes("carried from")
          ? "carried-blocking"
          : "review-blocking";
      }
      if (d.includes("budget for this PR is used up"))
        return "budget-exhausted";
      if (d.includes("size gate")) return "size-skipped";
      return "other-failure";
    default:
      return "other-failure";
  }
}

// After the rename the gate is posted under both contexts with the same
// verdict; counting both would double every review. A PR that has any
// `crysk` status is read from that context alone, an older one from `pr-hero`.
//
// A status belongs to the commit, not the PR. A release PR (dev → main) lists
// every commit of the feature PRs it ships, each still carrying the reviews
// of the PR it came from (one release PR read 103 reviews). So only statuses
// set while this PR was open count.
function gateTimeline(pr: RawPr): { createdAt: string; event: GateEvent }[] {
  const closed = pr.closedAt ?? "9999";
  const all = pr.commits
    .flatMap((c) => c.statuses)
    .filter((s) => s.createdAt >= pr.createdAt && s.createdAt <= closed);
  const context = all.some((s) => s.context === "crysk") ? "crysk" : "pr-hero";
  return all
    .filter((s) => s.context === context)
    .map((s) => ({ createdAt: s.createdAt, event: classifyStatus(s) }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

type GreenBy =
  | "review-clean"
  | "override"
  | "stopped"
  | "low-risk"
  | "excluded"
  | "other-success";

export interface PrLoop {
  number: number;
  merged: boolean;
  firstReview: "clean" | "blocking" | null;
  reviews: number;
  failedRuns: number;
  budgetExhausted: boolean;
  // Reviews that completed up to the final green, the gate state the PR ended in.
  roundsToGreen: number | null;
  greenBy: GreenBy | null;
  hoursToGreen: number | null;
}

const NOT_GREEN = new Set<GateEvent>([
  "review-blocking",
  "carried-blocking",
  "budget-exhausted",
  "size-skipped",
  "error",
  "other-failure",
]);

function hoursBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 3_600_000;
}

// The final green is the first success after the last red or error: an early
// green the next push turned red is not where the loop ended. A PR whose last
// verdict is red or error never got there.
export function prLoop(pr: RawPr): PrLoop | null {
  const timeline = gateTimeline(pr).filter((e) => e.event !== "pending");
  if (timeline.length === 0) return null;
  const isReview = (e: GateEvent) =>
    e === "review-clean" || e === "review-blocking";
  const first = timeline.find((e) => isReview(e.event));

  let lastRed = -1;
  timeline.forEach((e, i) => {
    if (NOT_GREEN.has(e.event)) lastRed = i;
  });
  const green = timeline.slice(lastRed + 1)[0];
  const greenIndex = green === undefined ? -1 : lastRed + 1;

  return {
    number: pr.number,
    merged: pr.mergedAt !== null,
    firstReview:
      first === undefined
        ? null
        : first.event === "review-clean"
          ? "clean"
          : "blocking",
    reviews: timeline.filter((e) => isReview(e.event)).length,
    failedRuns: timeline.filter((e) => e.event === "error").length,
    budgetExhausted: timeline.some((e) => e.event === "budget-exhausted"),
    roundsToGreen:
      green === undefined
        ? null
        : timeline.slice(0, greenIndex + 1).filter((e) => isReview(e.event))
            .length,
    greenBy: green === undefined ? null : (green.event as GreenBy),
    hoursToGreen:
      green === undefined ? null : hoursBetween(pr.createdAt, green.createdAt),
  };
}

// The gate only turns red on blocking findings from some release on; before
// that every posted review set it green, so "rounds to green" is 1 by
// construction. The first blocking verdict in the data marks where the metric
// starts meaning something, per repo, without a hardcoded date.
export function blockingGateSince(prs: RawPr[]): string | null {
  let first: string | null = null;
  for (const pr of prs) {
    for (const commit of pr.commits) {
      for (const status of commit.statuses) {
        if (classifyStatus(status) !== "review-blocking") continue;
        if (first === null || status.createdAt < first)
          first = status.createdAt;
      }
    }
  }
  return first;
}

// Nearest-rank percentile over a sorted copy; null on an empty list.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export interface LoopReport {
  prs: number;
  merged: number;
  firstReview: { clean: number; blocking: number; none: number };
  roundsToGreen: Record<string, number>;
  greenBy: Record<string, number>;
  neverGreen: number;
  budgetExhausted: number;
  failedRuns: number;
  reviews: number;
  hoursToGreen: { p50: number | null; p75: number | null; p90: number | null };
  hoursToGreenByReview: {
    p50: number | null;
    p75: number | null;
    p90: number | null;
  };
}

function bucket(rounds: number): string {
  return rounds >= 4 ? "4+" : String(rounds);
}

function spread(values: number[]) {
  return {
    p50: percentile(values, 50),
    p75: percentile(values, 75),
    p90: percentile(values, 90),
  };
}

export function loopReport(prs: RawPr[]): LoopReport {
  const loops = prs.map(prLoop).filter((l): l is PrLoop => l !== null);
  const roundsToGreen: Record<string, number> = {
    "0": 0,
    "1": 0,
    "2": 0,
    "3": 0,
    "4+": 0,
  };
  const greenBy: Record<string, number> = {};
  for (const loop of loops) {
    if (loop.roundsToGreen !== null) {
      const key = bucket(loop.roundsToGreen);
      roundsToGreen[key] = (roundsToGreen[key] ?? 0) + 1;
    }
    if (loop.greenBy !== null)
      greenBy[loop.greenBy] = (greenBy[loop.greenBy] ?? 0) + 1;
  }
  const hours = (keep: (l: PrLoop) => boolean) =>
    loops
      .filter(keep)
      .flatMap((l) => (l.hoursToGreen === null ? [] : [l.hoursToGreen]));
  return {
    prs: loops.length,
    merged: loops.filter((l) => l.merged).length,
    firstReview: {
      clean: loops.filter((l) => l.firstReview === "clean").length,
      blocking: loops.filter((l) => l.firstReview === "blocking").length,
      none: loops.filter((l) => l.firstReview === null).length,
    },
    roundsToGreen,
    greenBy,
    neverGreen: loops.filter((l) => l.greenBy === null).length,
    budgetExhausted: loops.filter((l) => l.budgetExhausted).length,
    failedRuns: loops.reduce((sum, l) => sum + l.failedRuns, 0),
    reviews: loops.reduce((sum, l) => sum + l.reviews, 0),
    hoursToGreen: spread(hours(() => true)),
    hoursToGreenByReview: spread(hours((l) => l.greenBy === "review-clean")),
  };
}

function share(n: number, of: number): string {
  return of === 0 ? "n/a" : `${n} (${((n / of) * 100).toFixed(0)}%)`;
}

function h(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}h`;
}

export function renderLoopReport(report: LoopReport): string[] {
  const n = report.prs;
  const green = n - report.neverGreen;
  const times = (t: LoopReport["hoursToGreen"]) =>
    `p50 ${h(t.p50)}  p75 ${h(t.p75)}  p90 ${h(t.p90)}`;
  return [
    `PRs with a gate verdict: ${n} (${report.merged} merged), ${report.reviews} completed reviews, ${report.failedRuns} failed runs`,
    "",
    "first review:",
    `  clean     ${share(report.firstReview.clean, n)}`,
    `  blocking  ${share(report.firstReview.blocking, n)}`,
    `  none      ${share(report.firstReview.none, n)}`,
    "",
    "rounds to the final green (completed reviews up to it):",
    ...Object.entries(report.roundsToGreen).map(
      ([k, v]) => `  ${k.padEnd(9)} ${share(v, green)}`,
    ),
    "",
    "how the final green was reached:",
    ...Object.entries(report.greenBy)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  ${k.padEnd(14)} ${share(v, n)}`),
    `  ${"ended red".padEnd(14)} ${share(report.neverGreen, n)}  (merged or closed with a red gate)`,
    "",
    `review budget exhausted: ${share(report.budgetExhausted, n)}`,
    "",
    "time from PR open to the final green:",
    `  all greens        ${times(report.hoursToGreen)}`,
    `  by a clean review ${times(report.hoursToGreenByReview)}`,
  ];
}
