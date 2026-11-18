// `pr-hero status --pr <n> [--json]` (ROADMAP S9): the read-only gate, findings and next
// action of one PR, for the triage skill to drive review -> reply -> fix -> wait. The
// decisions live in pr/pr-status.ts (pure); this file is the I/O shell: the PR's head, the
// gate, and both comment streams, all through gh. Nothing is written to GitHub, and no run
// dir or local store is read.
//
// Fail closed: every read here throws on failure (a gh error, a truncated comment list, a
// head that is not a commit id), so the command exits 1 with nothing on stdout. An empty
// answer from a failed read would read as "no review yet" and send a review out blind.

import os from "node:os";
import { resolveRepoRoot } from "#git/git";
import {
  carriedReviewVerdictTime,
  headStatusRed,
  ownReviewVerdictTime,
} from "#pr/admission";
import { requireReplyWriters } from "#pr/ci-admission-gate";
import {
  CommentsTruncatedError,
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
  reviewedHeadOf,
  STATUS_WAIT_MAX_MS,
  STATUS_WAIT_POLL_INTERVAL_MS,
  shouldWaitPrStatus,
  verdictAtMs,
} from "#pr/pr-status";
import { resolvePrTarget } from "#pr/preflight";
import type { CliOptions } from "#review/preflight";
import { GH_PR_VIEW_TIMEOUT_MS } from "#store/gc-preflight";
import { log } from "#ui/primitives";
import { resolveEngineAssets } from "../assets";
import { CliError, CliUsageError } from "../errors";
import { recordEngineVersion } from "../skills-cache";

export async function statusCommand(options: CliOptions): Promise<number> {
  // parseArgs already requires a numeric --pr for this command; the check is the type
  // narrowing, and it runs before any repository lookup or read.
  if (typeof options.pr !== "number") {
    throw new CliUsageError("status requires --pr <n> (a PR number)");
  }
  const operatorRoot = await resolveRepoRoot(options.repo);
  const home = os.homedir();
  return runStatusCommand({
    operatorRoot,
    pr: options.pr,
    json: options.json === true,
    wait: options.wait === true,
    cliVersion: resolveEngineAssets().version,
    recordEngine: (version) => recordEngineVersion(home, operatorRoot, version),
  });
}

// What a --wait run, or one command, remembers between reads: each reply author's permission, and
// the walk to a carried review's verdict.
export interface PrStatusReadMemo {
  writers: Map<string, boolean>;
  walked?: { head: string; at: string | null };
}

// One read of a pull request as `crysk status` reports it: the head, its statuses, the time of the
// review's verdict, the comments and each reply author's permission. `crysk triage reply` reads the
// pull request through this too, so the reply it decides to post or skip is judged on the replies
// status and the gate count.
export async function readPrStatus(input: {
  operatorRoot: string;
  pr: number;
  nowMs: number;
  spawnFn: typeof Bun.spawn | undefined;
  sleepFn: (ms: number) => Promise<void>;
  viewTimeoutMs?: number;
  commentTimeoutMs?: number;
  memo: PrStatusReadMemo;
  // Called with the head as soon as the pull request is read, before the reads that can still
  // fail: a --wait run dates its grace window from the moment it first saw a head.
  onHead?: (head: string) => void;
  // The running CLI's version, for the skills reload hint (pr-status.ts skills_reload).
  cliVersion?: string;
}): Promise<{
  status: PrStatusJson;
  head: string;
  issueComments: Awaited<ReturnType<typeof fetchPrComments>>;
  reviewComments: Awaited<ReturnType<typeof fetchPrReviewComments>>;
}> {
  const { operatorRoot, pr, nowMs, spawnFn, sleepFn, memo } = input;
  const viewTimeoutMs = input.viewTimeoutMs ?? GH_PR_VIEW_TIMEOUT_MS;
  const commentTimeoutMs = input.commentTimeoutMs ?? POSTING_GH_TIMEOUT_MS;
  const target = resolvePrTarget(
    await ghPrView(operatorRoot, pr, { spawnFn, timeoutMs: viewTimeoutMs }),
  );
  const head = target.headSha;
  input.onHead?.(head);
  // Sequential on purpose: each read names its own failure, and a failed read stops the rest.
  const statuses = await fetchCommitStatuses(operatorRoot, head, {
    spawnFn,
    failClosed: true,
  });
  // When the review whose verdict stands on this head wrote it: the head's own verdict, or the
  // one a skip carried onto a red head (admission.ts headStatusRed says why only a red). A walk
  // that read nothing is not kept: the next poll reads again rather than hold a failed read.
  let verdictAt = ownReviewVerdictTime(statuses);
  if (verdictAt === null && headStatusRed(statuses)) {
    let walked = memo.walked;
    if (walked?.head !== head || walked.at === null) {
      walked = {
        head,
        at: await carriedReviewVerdictTime({
          operatorRoot,
          prNumber: pr,
          headSha: head,
          spawnFn,
        }),
      };
      memo.walked = walked;
    }
    verdictAt = walked.at;
  }
  const issueComments = await fetchPrComments(operatorRoot, pr, {
    spawnFn,
    timeoutMs: commentTimeoutMs,
  });
  const reviewComments = await fetchPrReviewComments(operatorRoot, pr, {
    spawnFn,
    timeoutMs: commentTimeoutMs,
  });
  // Only authors whose replies can count are asked: a stale reply is dropped before its author matters.
  const writers = await requireReplyWriters({
    operatorRoot,
    comments: [...reviewComments, ...issueComments],
    known: memo.writers,
    cutoff: {
      reviewedHead: reviewedHeadOf(issueComments),
      verdictAt: verdictAtMs(verdictAt),
    },
    spawnFn,
    sleepFn,
  });
  const status = buildPrStatus({
    pr,
    head,
    nowMs,
    statuses,
    verdictAt,
    issueComments,
    reviewComments,
    writers,
    // A developer's machine never learns the platform's login (src/triage/adjudication.ts).
    adjudicatorTrust: { kind: "local" },
    ...(input.cliVersion === undefined ? {} : { cliVersion: input.cliVersion }),
  });
  return { status, head, issueComments, reviewComments };
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
  // The running CLI's version, for the skills reload hint. Absent: none is named.
  cliVersion?: string;
  // Records the engine version the summary names, so `skills load` serves that
  // version's playbook with no network call (skills-cache.ts). Absent: nothing
  // is recorded.
  recordEngine?: (version: string) => void;
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
  let sleptMs = 0;
  const baseNowMs = input.nowMs;
  const readNow =
    input.clock ??
    (baseNowMs !== undefined ? () => baseNowMs + sleptMs : () => Date.now());
  const startMs = readNow();
  let lastHead: string | undefined;
  let headStartMs = startMs;
  let polls = 0;
  let consecutivePollErrors = 0;
  // A --wait run asks each reply author's permission once, not on every poll.
  const memo: PrStatusReadMemo = { writers: new Map() };

  let status: PrStatusJson;
  while (true) {
    const nowMs = readNow();
    const elapsedMs = nowMs - startMs;
    polls += 1;
    let issueComments: Awaited<ReturnType<typeof fetchPrComments>>;
    try {
      const read = await readPrStatus({
        operatorRoot,
        pr,
        nowMs,
        spawnFn,
        sleepFn: sleep,
        viewTimeoutMs,
        commentTimeoutMs,
        memo,
        ...(input.cliVersion === undefined
          ? {}
          : { cliVersion: input.cliVersion }),
        onHead: (head) => {
          if (head !== lastHead) {
            lastHead = head;
            headStartMs = nowMs;
          }
        },
      });
      status = read.status;
      issueComments = read.issueComments;
      consecutivePollErrors = 0;
    } catch (err) {
      const retryable =
        input.wait === true &&
        polls > 1 &&
        err instanceof CliError &&
        !(err instanceof CliUsageError) &&
        !(err instanceof CommentsTruncatedError) &&
        consecutivePollErrors < 2 &&
        elapsedMs + pollIntervalMs <= maxWaitMs;
      if (!retryable) throw err;
      consecutivePollErrors += 1;
      await sleep(pollIntervalMs);
      sleptMs += pollIntervalMs;
      continue;
    }
    const headElapsedMs = nowMs - headStartMs;
    if (
      !input.wait ||
      !shouldWaitPrStatus({
        status,
        issueComments,
        nowMs,
        elapsedMs: headElapsedMs,
        startupGraceMs: input.startupGraceMs,
      })
    ) {
      break;
    }
    if (elapsedMs + pollIntervalMs > maxWaitMs) {
      throw new CliError(
        `Timed out after ${maxWaitMs} ms waiting for crysk status on PR #${pr} to settle.`,
      );
    }
    await sleep(pollIntervalMs);
    sleptMs += pollIntervalMs;
  }
  if (status.report.engine_version !== null) {
    input.recordEngine?.(status.report.engine_version);
  }
  if (input.json) {
    const write = input.out ?? ((text: string) => process.stdout.write(text));
    write(`${JSON.stringify(status)}\n`);
  } else {
    for (const line of renderPrStatusLines(status)) log(line);
  }
  return 0;
}
