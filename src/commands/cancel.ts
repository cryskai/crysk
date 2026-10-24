// `pr-hero cancel --pr <n> [--override] [--wait] [--json]`. Decisions live in
// pr/pr-cancel.ts; this file is the gh shell. Human lines go to stderr through
// log(); stdout stays empty unless --json, which writes one object.
import { resolveRepoRoot } from "#git/git";
import {
  fetchCommitStatuses,
  fetchPrComments,
  fetchPrReviewComments,
  ghPrView,
  ghRepoNameWithOwner,
  POSTING_GH_TIMEOUT_MS,
} from "#pr/pr";
import {
  CANCELABLE_RUN_STATUSES,
  type CancelledRunFact,
  PR_CANCEL_SCHEMA,
  type PrCancelJson,
  renderPrCancelLines,
  selectCancelableRuns,
  type WorkflowRunFact,
} from "#pr/pr-cancel";
import {
  buildPrStatus,
  overrideDeniedByLaterOutcome,
  type PrStatusComment,
  type PrStatusJson,
  STATUS_WAIT_MAX_MS,
  STATUS_WAIT_POLL_INTERVAL_MS,
} from "#pr/pr-status";
import { resolvePrTarget } from "#pr/preflight";
import type { CliOptions } from "#review/preflight";
import { GH_PR_VIEW_TIMEOUT_MS } from "#store/gc-preflight";
import { log } from "#ui/primitives";
import { CliError, CliUsageError } from "../errors";

const CANCEL_POLL_INTERVAL_MS = 3_000;
const CANCEL_STARTUP_GRACE_MS = 15_000;
const CANCEL_SETTLE_TIMEOUT_MS = 90_000;
const ALREADY_SETTLED = "Cannot cancel a workflow run that is completed";
const OVERRIDE_BODY = "/pr-hero override";

export async function cancelCommand(options: CliOptions): Promise<number> {
  if (typeof options.pr !== "number") {
    throw new CliUsageError("cancel requires --pr <n> (a PR number)");
  }
  const operatorRoot = await resolveRepoRoot(options.repo);
  return runCancelCommand({
    operatorRoot,
    pr: options.pr,
    json: options.json === true,
    wait: options.wait === true,
    override: options.override === true,
  });
}

export async function runCancelCommand(input: {
  operatorRoot: string;
  pr: number;
  json: boolean;
  wait?: boolean;
  override?: boolean;
  spawnFn?: typeof Bun.spawn;
  nowMs?: number;
  clock?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  settleTimeoutMs?: number;
  startupGraceMs?: number;
  statusPollIntervalMs?: number;
  statusMaxWaitMs?: number;
  ghTimeoutMs?: number;
  out?: (text: string) => void;
}): Promise<number> {
  const { operatorRoot, pr, spawnFn } = input;
  const wait = input.wait === true || input.override === true;
  const pollIntervalMs = input.pollIntervalMs ?? CANCEL_POLL_INTERVAL_MS;
  const settleTimeoutMs = input.settleTimeoutMs ?? CANCEL_SETTLE_TIMEOUT_MS;
  const startupGraceMs = input.startupGraceMs ?? CANCEL_STARTUP_GRACE_MS;
  const statusPollIntervalMs =
    input.statusPollIntervalMs ?? STATUS_WAIT_POLL_INTERVAL_MS;
  const statusMaxWaitMs = input.statusMaxWaitMs ?? STATUS_WAIT_MAX_MS;
  const ghTimeoutMs = input.ghTimeoutMs ?? POSTING_GH_TIMEOUT_MS;
  const viewTimeoutMs = input.ghTimeoutMs ?? GH_PR_VIEW_TIMEOUT_MS;
  const sleep =
    input.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let sleptMs = 0;
  const baseNowMs = input.nowMs;
  const readNow =
    input.clock ??
    (baseNowMs !== undefined ? () => baseNowMs + sleptMs : () => Date.now());

  const target = resolvePrTarget(
    await ghPrView(operatorRoot, pr, { spawnFn, timeoutMs: viewTimeoutMs }),
  );
  const headSha = target.headSha;
  const prTitle = target.title;
  const slug = await ghRepoNameWithOwner(operatorRoot, {
    spawnFn,
    timeoutMs: ghTimeoutMs,
  });
  if (slug === undefined) {
    throw new CliError("gh repo view failed: could not resolve owner/repo");
  }

  const ghCall = (args: string[]) =>
    gh(operatorRoot, args, spawnFn, ghTimeoutMs);

  const loadStatuses = () =>
    fetchCommitStatuses(operatorRoot, headSha, {
      spawnFn,
      failClosed: true,
    });

  const selectFrom = async () => {
    const statuses = await loadStatuses();
    const runs = await listWorkflowRuns(ghCall, slug);
    const gate = buildPrStatus({
      pr,
      head: headSha,
      nowMs: readNow(),
      statuses,
      issueComments: [],
      reviewComments: [],
    }).gate;
    return selectCancelableRuns({
      pr,
      head: headSha,
      prTitle,
      gateTargetUrl: gate.target_url,
      gatePendingInFlight: gate.pending_in_flight,
      workflowRuns: runs,
    });
  };

  if (input.override === true) {
    await assertOverrideCanLand(ghCall, slug, pr);
  }

  let selected = await selectFrom();
  if (selected.length === 0 && wait) {
    const graceStart = readNow();
    while (selected.length === 0) {
      if (readNow() - graceStart + pollIntervalMs > startupGraceMs) break;
      await sleep(pollIntervalMs);
      sleptMs += pollIntervalMs;
      selected = await selectFrom();
    }
  }

  const cancelled: CancelledRunFact[] = [];
  for (const run of selected) {
    await cancelAndSettle({
      ghCall,
      slug,
      run,
      readNow,
      sleep,
      addSlept: (ms) => {
        sleptMs += ms;
      },
      pollIntervalMs,
      settleTimeoutMs,
    });
    cancelled.push({ ...run, settled: true });
  }

  let overrideRequested = false;
  let status: PrStatusJson;
  if (input.override === true) {
    const again = resolvePrTarget(
      await ghPrView(operatorRoot, pr, { spawnFn, timeoutMs: viewTimeoutMs }),
    );
    if (again.headSha !== headSha) {
      throw new CliError(
        `pr-hero cancel: PR #${pr} head moved before /pr-hero override was posted`,
      );
    }
    const before = await fetchPrComments(operatorRoot, pr, {
      spawnFn,
      timeoutMs: ghTimeoutMs,
    });
    let floor = 0;
    for (const comment of before) floor = Math.max(floor, comment.id);
    const posted = await ghCall([
      "pr",
      "comment",
      String(pr),
      "--body",
      OVERRIDE_BODY,
    ]);
    if (!posted.ok) {
      throw new CliError(`gh pr comment ${pr} failed: ${posted.stderr.trim()}`);
    }
    overrideRequested = true;
    const overrideStart = readNow();
    while (true) {
      const nowMs = readNow();
      const snap = await readStatus({
        operatorRoot,
        pr,
        headSha,
        spawnFn,
        nowMs,
        timeoutMs: ghTimeoutMs,
      });
      status = snap.status;
      if (status.gate.override.active && status.head === headSha) break;
      const postedId = newestOverrideIdAfter(snap.issueComments, floor);
      if (
        postedId !== null &&
        overrideDeniedByLaterOutcome(snap.issueComments, postedId)
      ) {
        throw new CliError(
          `pr-hero cancel: /pr-hero override on PR #${pr} was denied by a later outcome`,
        );
      }
      if (nowMs - overrideStart + statusPollIntervalMs > statusMaxWaitMs) {
        throw new CliError(
          `Timed out after ${statusMaxWaitMs} ms waiting for /pr-hero override on PR #${pr}.`,
        );
      }
      await sleep(statusPollIntervalMs);
      sleptMs += statusPollIntervalMs;
    }
  } else {
    status = (
      await readStatus({
        operatorRoot,
        pr,
        headSha,
        spawnFn,
        nowMs: readNow(),
        timeoutMs: ghTimeoutMs,
      })
    ).status;
  }

  const result: PrCancelJson = {
    schema: PR_CANCEL_SCHEMA,
    pr,
    head: headSha,
    cancelled_runs: cancelled,
    override_requested: overrideRequested,
    status,
  };
  if (input.json) {
    const write = input.out ?? ((text: string) => process.stdout.write(text));
    write(`${JSON.stringify(result)}\n`);
  } else {
    for (const line of renderPrCancelLines(result)) log(line);
  }
  return 0;
}

// Bun.spawn's timeout does not bound a fake spawnFn, so the kill is the deadline.
async function gh(
  operatorRoot: string,
  args: string[],
  spawnFn: typeof Bun.spawn | undefined,
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const spawn = spawnFn ?? Bun.spawn;
  if (spawnFn === undefined && Bun.which("gh") === null) {
    throw new CliError(
      "gh not found on PATH — PR mode resolves the PR through the GitHub " +
        "CLI. Install it and authenticate (gh auth login) first.",
    );
  }
  const proc = spawn(["gh", ...args], {
    cwd: operatorRoot,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(watchdog);
  }
  if (timedOut) {
    return {
      ok: false,
      stdout,
      stderr: `gh timed out after ${timeoutMs} ms${
        stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`
      }`,
    };
  }
  return { ok: exitCode === 0, stdout, stderr };
}

type GhCall = (
  args: string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

async function listWorkflowRuns(
  ghCall: GhCall,
  slug: string,
): Promise<WorkflowRunFact[]> {
  const byId = new Map<number, WorkflowRunFact>();
  for (const status of CANCELABLE_RUN_STATUSES) {
    const result = await ghCall([
      "api",
      `repos/${slug}/actions/workflows/pr-hero.yml/runs?per_page=100&status=${status}`,
    ]);
    if (!result.ok) {
      throw new CliError(
        `gh api actions/runs failed: ${result.stderr.trim() || "gh failed"}`,
      );
    }
    for (const run of readWorkflowRuns(result.stdout)) byId.set(run.id, run);
  }
  return [...byId.values()];
}

function readWorkflowRuns(stdout: string): WorkflowRunFact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new CliError(
      `gh api actions/runs returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("workflow_runs" in parsed)
  ) {
    throw new CliError("gh api actions/runs must return a workflow_runs array");
  }
  const runs = (parsed as { workflow_runs: unknown }).workflow_runs;
  if (!Array.isArray(runs)) {
    throw new CliError("gh api actions/runs must return a workflow_runs array");
  }
  return runs.map((run) => readWorkflowRun(run));
}

function readWorkflowRun(run: unknown): WorkflowRunFact {
  if (typeof run !== "object" || run === null) {
    throw new CliError("unreadable workflow run from gh api");
  }
  const record = run as Record<string, unknown>;
  const id = record.id;
  const status = record.status;
  const event = record.event;
  const headSha = record.head_sha;
  const path = record.path;
  const htmlUrl = record.html_url;
  const displayTitle = record.display_title;
  if (
    typeof id !== "number" ||
    !Number.isInteger(id) ||
    id < 1 ||
    typeof status !== "string" ||
    typeof event !== "string" ||
    typeof headSha !== "string" ||
    typeof path !== "string" ||
    typeof htmlUrl !== "string" ||
    typeof displayTitle !== "string"
  ) {
    throw new CliError("unreadable workflow run from gh api");
  }
  const pulls = record.pull_requests;
  const pullRequests: { number: number }[] = [];
  if (pulls !== undefined && pulls !== null) {
    if (!Array.isArray(pulls)) {
      throw new CliError("unreadable workflow run from gh api");
    }
    for (const pull of pulls) {
      if (typeof pull !== "object" || pull === null) {
        throw new CliError("unreadable workflow run from gh api");
      }
      const number = (pull as { number?: unknown }).number;
      if (typeof number !== "number" || !Number.isInteger(number)) {
        throw new CliError("unreadable workflow run from gh api");
      }
      pullRequests.push({ number });
    }
  }
  return {
    id,
    status,
    event,
    head_sha: headSha,
    path,
    html_url: htmlUrl,
    display_title: displayTitle,
    pull_requests: pullRequests,
  };
}

function newestOverrideIdAfter(
  issueComments: readonly PrStatusComment[],
  floor: number,
): number | null {
  let postedId: number | null = null;
  for (const comment of issueComments) {
    if (comment.id <= floor) continue;
    if (comment.body.trim() !== OVERRIDE_BODY) continue;
    if (postedId === null || comment.id > postedId) postedId = comment.id;
  }
  return postedId;
}

async function assertOverrideCanLand(
  ghCall: GhCall,
  slug: string,
  pr: number,
): Promise<void> {
  const fork = await ghCall([
    "api",
    `repos/${slug}/pulls/${pr}`,
    "--jq",
    ".head.repo.fork",
  ]);
  const forkText = fork.ok ? fork.stdout.trim() : "";
  if (forkText === "true") {
    throw new CliError(
      `pr-hero cancel: PR #${pr} is from a fork; /pr-hero override cannot land, so the review was not cancelled`,
    );
  }
  if (forkText !== "false") {
    throw new CliError(
      `pr-hero cancel: could not read whether PR #${pr} is a fork`,
    );
  }
  const permission = await ghCall([
    "api",
    `repos/${slug}`,
    "--jq",
    ".permissions.push",
  ]);
  if (!permission.ok || permission.stdout.trim() !== "true") {
    throw new CliError(
      `pr-hero cancel: /pr-hero override needs write access on ${slug}; the review was not cancelled`,
    );
  }
  const workflow = await ghCall([
    "api",
    `repos/${slug}/contents/.github/workflows/pr-hero.yml`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (!workflow.ok || !workflow.stdout.includes("issue_comment:")) {
    throw new CliError(
      `pr-hero cancel: ${slug} has no issue_comment pr-hero workflow, so /pr-hero override would not run; the review was not cancelled`,
    );
  }
}

async function cancelAndSettle(input: {
  ghCall: GhCall;
  slug: string;
  run: CancelledRunFact;
  readNow: () => number;
  sleep: (ms: number) => Promise<void>;
  addSlept: (ms: number) => void;
  pollIntervalMs: number;
  settleTimeoutMs: number;
}): Promise<void> {
  const { ghCall, slug, run } = input;
  const cancelled = await ghCall([
    "run",
    "cancel",
    String(run.run_id),
    "-R",
    slug,
  ]);
  if (!cancelled.ok) {
    const stderr = cancelled.stderr;
    // A bare "409" also matches run ids such as 12409 in the error URL.
    if (stderr.includes(ALREADY_SETTLED)) return;
    throw new CliError(
      `gh run cancel ${run.run_id} failed: ${stderr.trim() || "gh failed"}`,
    );
  }
  const started = input.readNow();
  // runCancelSettle writes PRH-CANCELLED only once this run reaches completed.
  while (true) {
    const current = await readRunStatus(ghCall, slug, run.run_id);
    if (current === "completed") return;
    if (
      input.readNow() - started + input.pollIntervalMs >
      input.settleTimeoutMs
    ) {
      throw new CliError(
        `Timed out after ${input.settleTimeoutMs} ms waiting for workflow run ${run.run_id} to complete.`,
      );
    }
    await input.sleep(input.pollIntervalMs);
    input.addSlept(input.pollIntervalMs);
  }
}

async function readRunStatus(
  ghCall: GhCall,
  slug: string,
  runId: number,
): Promise<string> {
  const result = await ghCall(["api", `repos/${slug}/actions/runs/${runId}`]);
  if (!result.ok) {
    throw new CliError(
      `gh api actions/runs/${runId} failed: ${result.stderr.trim() || "gh failed"}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new CliError(
      `gh api actions/runs/${runId} returned invalid JSON: ${(error as Error).message}`,
    );
  }
  const status =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { status?: unknown }).status
      : undefined;
  if (typeof status !== "string") {
    throw new CliError(`gh api actions/runs/${runId} returned no status`);
  }
  return status;
}

async function readStatus(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  spawnFn?: typeof Bun.spawn;
  nowMs: number;
  timeoutMs: number;
}): Promise<{ status: PrStatusJson; issueComments: PrStatusComment[] }> {
  const statuses = await fetchCommitStatuses(
    input.operatorRoot,
    input.headSha,
    {
      spawnFn: input.spawnFn,
      failClosed: true,
    },
  );
  const issueComments = await fetchPrComments(input.operatorRoot, input.pr, {
    spawnFn: input.spawnFn,
    timeoutMs: input.timeoutMs,
  });
  const reviewComments = await fetchPrReviewComments(
    input.operatorRoot,
    input.pr,
    { spawnFn: input.spawnFn, timeoutMs: input.timeoutMs },
  );
  return {
    issueComments,
    status: buildPrStatus({
      pr: input.pr,
      head: input.headSha,
      nowMs: input.nowMs,
      statuses,
      issueComments,
      reviewComments,
    }),
  };
}
