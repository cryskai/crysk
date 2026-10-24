// Pure decisions for `pr-hero cancel`. The shell in commands/cancel.ts reads
// GitHub and posts; nothing here does I/O.
import { type PrStatusJson, renderPrStatusLines } from "#pr/pr-status";

export const PR_CANCEL_SCHEMA = "pr-hero.cancel/v1" as const;

export interface CancelledRunFact {
  run_id: number;
  previous_status:
    | "queued"
    | "in_progress"
    | "waiting"
    | "requested"
    | "pending";
  settled: boolean;
  html_url: string;
}

export interface PrCancelJson {
  schema: typeof PR_CANCEL_SCHEMA;
  pr: number;
  head: string;
  cancelled_runs: CancelledRunFact[];
  override_requested: boolean;
  status: PrStatusJson;
}

export interface WorkflowRunFact {
  id: number;
  status: string;
  event: string;
  head_sha: string;
  path: string;
  html_url: string;
  pull_requests: readonly { number: number }[];
}

const CANCELABLE_STATUSES = new Set<CancelledRunFact["previous_status"]>([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]);

const RUN_ID_IN_ACTIONS_URL = /\/actions\/runs\/(\d+)(?:\/|$|\?|#)/;

export function extractRunIdFromTargetUrl(
  targetUrl: string | null,
): number | null {
  if (targetUrl === null) return null;
  const matched = RUN_ID_IN_ACTIONS_URL.exec(targetUrl);
  if (matched === null) return null;
  const id = Number(matched[1]);
  if (!Number.isInteger(id) || id < 1) return null;
  return id;
}

function isCancelableStatus(
  status: string,
): status is CancelledRunFact["previous_status"] {
  return CANCELABLE_STATUSES.has(status as CancelledRunFact["previous_status"]);
}

export function selectCancelableRuns(input: {
  pr: number;
  head: string;
  gateTargetUrl: string | null;
  gatePendingInFlight: boolean;
  workflowRuns: readonly WorkflowRunFact[];
}): CancelledRunFact[] {
  const gateRunId = input.gatePendingInFlight
    ? extractRunIdFromTargetUrl(input.gateTargetUrl)
    : null;
  const byId = new Map<number, CancelledRunFact>();
  for (const run of input.workflowRuns) {
    if (!isCancelableStatus(run.status)) continue;
    const heroWorkflow = run.path.endsWith("pr-hero.yml");
    const gateRun = gateRunId !== null && run.id === gateRunId;
    if (!heroWorkflow && !gateRun) continue;
    const onPullRequest =
      run.event === "pull_request" &&
      (run.head_sha === input.head ||
        run.pull_requests.some((pull) => pull.number === input.pr));
    const onIssueComment =
      run.event === "issue_comment" && (run.head_sha === input.head || gateRun);
    if (!onPullRequest && !onIssueComment) continue;
    if (byId.has(run.id)) continue;
    byId.set(run.id, {
      run_id: run.id,
      previous_status: run.status,
      settled: false,
      html_url: run.html_url,
    });
  }
  return [...byId.values()].sort((a, b) => a.run_id - b.run_id);
}

export function renderPrCancelLines(result: PrCancelJson): string[] {
  const ids = result.cancelled_runs.map((run) => String(run.run_id));
  const cancelled =
    ids.length === 0 ? "cancelled: none" : `cancelled: ${ids.join(", ")}`;
  const override = result.override_requested
    ? "override: /pr-hero override posted"
    : "override: not posted";
  return [
    `pr-hero cancel: PR #${result.pr}`,
    cancelled,
    override,
    ...renderPrStatusLines(result.status),
  ];
}
