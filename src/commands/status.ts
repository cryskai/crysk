// `pr-hero status --pr <n> [--json]` (ROADMAP S9): the read-only gate, findings and next
// action of one PR, for the triage skill to drive review -> reply -> fix -> wait. The
// decisions live in pr/pr-status.ts (pure); this file is the I/O shell: the PR's head, the
// gate, and both comment streams, all through gh. Nothing is written to GitHub, and no run
// dir or local store is read.
//
// Fail closed: every read here throws on failure (a gh error, a truncated comment list, a
// head that is not a commit id), so the command exits 1 with nothing on stdout. An empty
// answer from a failed read would read as "no review yet" and send a review out blind.

import { resolveRepoRoot } from "#git/git";
import {
  fetchCommitStatuses,
  fetchPrComments,
  fetchPrReviewComments,
  ghPrView,
  POSTING_GH_TIMEOUT_MS,
} from "#pr/pr";
import {
  buildPrStatus,
  type PrStatusJson,
  renderPrStatusLines,
  STATUS_WAIT_MAX_MS,
  STATUS_WAIT_POLL_INTERVAL_MS,
  shouldWaitPrStatus,
} from "#pr/pr-status";
import { resolvePrTarget } from "#pr/preflight";
import type { CliOptions } from "#review/preflight";
import { GH_PR_VIEW_TIMEOUT_MS } from "#store/gc-preflight";
import { log } from "#ui/primitives";
import { CliError, CliUsageError } from "../errors";

export async function statusCommand(options: CliOptions): Promise<number> {
  // parseArgs already requires a numeric --pr for this command; the check is the type
  // narrowing, and it runs before any repository lookup or read.
  if (typeof options.pr !== "number") {
    throw new CliUsageError("status requires --pr <n> (a PR number)");
  }
  const operatorRoot = await resolveRepoRoot(options.repo);
  return runStatusCommand({
    operatorRoot,
    pr: options.pr,
    json: options.json === true,
    wait: options.wait === true,
  });
}

// Exported with its gh seam (spawnFn), the clock (nowMs) and the stdout writer (out) injectable,
// so the tests observe exactly what the command reads and what it prints. Without --json the
// lines go to stderr through log(), and stdout stays empty; with --json stdout carries exactly
// one JSON object.
export async function runStatusCommand(input: {
  operatorRoot: string;
  pr: number;
  json: boolean;
  wait?: boolean;
  spawnFn?: typeof Bun.spawn;
  nowMs?: number;
  clock?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  startupGraceMs?: number;
  // Overrides every bound below. The tests use it to see a timeout without waiting the real one.
  ghTimeoutMs?: number;
  out?: (text: string) => void;
}): Promise<number> {
  const { operatorRoot, pr, spawnFn } = input;
  // Every gh call here is bounded, so a call that never answers is a timeout CliError and the
  // command exits 1 with nothing on stdout, instead of parking the skill's only gate read. The
  // PR view takes the bound the other PR-view reads take (GH_PR_VIEW_TIMEOUT_MS); the comment
  // reads take the one the posting path's comment lookups take (POSTING_GH_TIMEOUT_MS). The
  // commit statuses carry their own bound (COMMIT_STATUS_TIMEOUT_MS) inside fetchCommitStatuses.
  const viewTimeoutMs = input.ghTimeoutMs ?? GH_PR_VIEW_TIMEOUT_MS;
  const commentTimeoutMs = input.ghTimeoutMs ?? POSTING_GH_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? STATUS_WAIT_POLL_INTERVAL_MS;
  const maxWaitMs = input.maxWaitMs ?? STATUS_WAIT_MAX_MS;
  const sleep =
    input.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let elapsedMs = 0;
  const baseNowMs = input.nowMs;
  const readNow =
    input.clock ??
    (baseNowMs !== undefined ? () => baseNowMs + elapsedMs : () => Date.now());

  let status: PrStatusJson;
  while (true) {
    const nowMs = readNow();
    const target = resolvePrTarget(
      await ghPrView(operatorRoot, pr, { spawnFn, timeoutMs: viewTimeoutMs }),
    );
    const head = target.headSha;
    // Sequential on purpose: each read names its own failure, and a failed read stops the rest.
    const statuses = await fetchCommitStatuses(operatorRoot, head, {
      spawnFn,
      failClosed: true,
    });
    const issueComments = await fetchPrComments(operatorRoot, pr, {
      spawnFn,
      timeoutMs: commentTimeoutMs,
    });
    const reviewComments = await fetchPrReviewComments(operatorRoot, pr, {
      spawnFn,
      timeoutMs: commentTimeoutMs,
    });
    status = buildPrStatus({
      pr,
      head,
      nowMs,
      statuses,
      issueComments,
      reviewComments,
    });
    if (
      !input.wait ||
      !shouldWaitPrStatus({
        status,
        issueComments,
        nowMs,
        elapsedMs,
        startupGraceMs: input.startupGraceMs,
      })
    ) {
      break;
    }
    if (elapsedMs + pollIntervalMs > maxWaitMs) {
      throw new CliError(
        `Timed out after ${maxWaitMs} ms waiting for pr-hero status on PR #${pr} to settle.`,
      );
    }
    await sleep(pollIntervalMs);
    elapsedMs += pollIntervalMs;
  }
  if (input.json) {
    const write = input.out ?? ((text: string) => process.stdout.write(text));
    write(`${JSON.stringify(status)}\n`);
  } else {
    for (const line of renderPrStatusLines(status)) log(line);
  }
  return 0;
}
