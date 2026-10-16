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
} from "#pr/pr";
import { buildPrStatus, renderPrStatusLines } from "#pr/pr-status";
import { resolvePrTarget } from "#pr/preflight";
import type { CliOptions } from "#review/preflight";
import { log } from "#ui/primitives";
import { CliUsageError } from "../errors";

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
  spawnFn?: typeof Bun.spawn;
  nowMs?: number;
  out?: (text: string) => void;
}): Promise<number> {
  const { operatorRoot, pr, spawnFn } = input;
  const target = resolvePrTarget(await ghPrView(operatorRoot, pr, { spawnFn }));
  const head = target.headSha;
  // Sequential on purpose: each read names its own failure, and a failed read stops the rest.
  const statuses = await fetchCommitStatuses(operatorRoot, head, {
    spawnFn,
    failClosed: true,
  });
  const issueComments = await fetchPrComments(operatorRoot, pr, { spawnFn });
  const reviewComments = await fetchPrReviewComments(operatorRoot, pr, {
    spawnFn,
  });
  const status = buildPrStatus({
    pr,
    head,
    nowMs: input.nowMs ?? Date.now(),
    statuses,
    issueComments,
    reviewComments,
  });
  if (input.json) {
    const write = input.out ?? ((text: string) => process.stdout.write(text));
    write(`${JSON.stringify(status)}\n`);
  } else {
    for (const line of renderPrStatusLines(status)) log(line);
  }
  return 0;
}
