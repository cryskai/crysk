// PR mode's I/O (ROADMAP B1): gh, the fetch, the detached worktree, the
// worktree's codegraph index, and the Greptile comparison files — every side
// effect `pr-hero review --pr <n>` needs beyond what cli.ts already owns.
// Same contract as cli.ts: this is an I/O shell, and every decision it acts
// on is a pure function in pr/preflight.ts / pr/inline.ts (or review/preflight.ts),
// where most of the tests live.
//
// ROADMAP B6 exception, spelled out because it changes the file's own
// header claim: the review-submission functions below (`postPrReview`,
// `postIssueComment`, `fetchPrReviewComments`, `fetchPostedFindingComments`,
// `postCommitStatus`, `fetchCommitStatuses`)
// ARE offline-tested, in test/pr/pr.test.ts, via an injectable `spawnFn` on the
// internal `gh()` helper — the 422 recovery path is exactly the kind of
// branch that must never rest on "we'll catch it live".
//
// Every git and gh call here runs with the OPERATOR root as cwd — gh talks
// to GitHub, and the operator checkout is the trust anchor — EXCEPT the
// object-db git that owns the review worktree (fetchPrRefs, ensureWorktree)
// and the two read-only inspections of the worktree itself. W3: `git
// worktree add` is bound to one git dir, the registered owner for that
// origin, which may not be the operator cwd.

import { existsSync } from "node:fs";
import path from "node:path";
import {
  ADMISSION_CHECK_RUN_NAME,
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  parseAdmissionRecord,
  serializeAdmissionRecord,
} from "#ci/admission-ledger";
import {
  canonicalAdmissionFindings,
  nextStateReviewCount,
  renderCiAdmissionBlock,
  tierCountsFromFindings,
} from "#ci/review-admission";
import {
  type ComparisonResult,
  compareFindings,
  type PrHeroFindingRef,
} from "#compare/compare";
import { parseGreptileComment, pickGreptileComment } from "#compare/greptile";
import { renderComparison } from "#compare/report";
import { THREAD_PAGE_SIZE } from "#corpus/preflight";
import { git } from "#git/git";
import { isFullCommitId } from "#git/refs";
import type { FindingChannel } from "#rereview/classify";
import { collapseTargets, type RereviewProvenance } from "#rereview/prepare";
import {
  droppedStateNote,
  type FreshStateFinding,
  mergeStateFindings,
  parseStateBlock,
  renderStateBlock,
  stateBlockBudget,
} from "#rereview/state";
import type { Finding, FindingsDocument, RunStatus } from "#review/findings";
import {
  type PrCommentDelta,
  renderInlineComment,
  renderIssueFindingComment,
  renderPrComment,
  renderRereviewClosedComment,
  rereviewDeltaFromProvenance,
} from "#review/report";
import { GH_PR_VIEW_TIMEOUT_MS } from "#store/gc-preflight";
import { log } from "#ui/primitives";
import { parseMarkerHead } from "#watch/preflight";
import { CliError } from "../errors";
import {
  buildPostPlan,
  computeDroppedFindingIds,
  type InlinePostOutcome,
  matchPostedFindings,
  type PostedFindingComment,
  type PostPlan,
  parseHunkAnchors,
  resolvePostLine,
} from "./inline";
import {
  buildComparisonJson,
  type CiMode,
  COMMIT_STATUS_TIMEOUT_MS,
  type CommitStatusFact,
  type CommitStatusRequest,
  claimFingerprint,
  decideWorktree,
  findMarkedCommentId,
  parseFindingMarker,
  type WorktreeDecision,
  worktreeDirty,
} from "./preflight";

export const GRAPHQL_COMMENT_MAX_PAGES = 50;

export class CommentsTruncatedError extends CliError {}

// `spawnFn` is the ONLY seam this module adds for testability, and it is
// deliberately invisible to production callers: every existing call site
// omits it and gets `Bun.spawn` exactly as before. Only test/pr/pr.test.ts
// passes one, to script gh's response (including a 422) without a live PR.
// The `Bun.which("gh")` guard is skipped under a fake spawn on purpose — a
// real environment missing `gh` must still fail loud, but an offline test
// must never depend on whether the machine RUNNING it happens to have `gh`
// installed, or the suite becomes non-hermetic for a reason that has
// nothing to do with the behavior under test.
async function gh(
  operatorRoot: string,
  args: string[],
  stdin?: string,
  spawnFn?: typeof Bun.spawn,
  timeoutMs?: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const spawn = spawnFn ?? Bun.spawn;
  // A missing gh must name itself: Bun.spawn's error for a binary that is
  // not there reads like a crash, not like "install the GitHub CLI".
  if (spawnFn === undefined && Bun.which("gh") === null) {
    throw new CliError(
      "gh not found on PATH — PR mode resolves the PR through the GitHub " +
        "CLI. Install it and authenticate (gh auth login) first.",
    );
  }
  // cwd = operator root: gh resolves owner/repo from the checkout's remote,
  // so the PR consulted always belongs to the repo passed as --repo — same
  // reasoning as scripts/compare-pr.ts.
  //
  // stdin carries a field value when the caller passes `-F key=@-` (gh reads
  // `@-` from stdin; verified against `gh api --help`, 2026-08-10): a report
  // body on stdin dodges ARG_MAX and needs no shell-quoting, because there
  // is no shell anywhere in this call.
  const proc = spawn(["gh", ...args], {
    cwd: operatorRoot,
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
    stdout: "pipe",
    stderr: "pipe",
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  // Watchdog, same shape as ClaudeCodeRunner.runAttempt's
  // (`src/review/step-runner.ts:361-378`): kill on the deadline, clear in a
  // `finally`, and report the kill as a failure rather than as an empty
  // success. Bun.spawn's own `timeout` above would also reap a real process,
  // but only a real one — every `gh` seam in this codebase is a `spawnFn`,
  // and an explicit kill is the only bound that holds for both. Without it
  // an accepted-but-unanswered `gh` call parks on `proc.exited` forever and
  // takes the whole command with it, including an unattended `--yes` run.
  let timedOut = false;
  const watchdog =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
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
    if (watchdog !== undefined) clearTimeout(watchdog);
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

// The contract between this call and the pure resolvePrTarget, which parses
// exactly these fields; change them together.
export const PR_VIEW_JSON_FIELDS =
  "number,title,state,headRefOid,baseRefName,baseRefOid,mergeCommit," +
  "additions,deletions,changedFiles";

export async function ghPrView(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn; timeoutMs?: number },
): Promise<string> {
  // Unbounded unless the caller names a bound, as before: a caller that must not hang passes
  // one (pr-hero status does, with GH_PR_VIEW_TIMEOUT_MS).
  const result = await gh(
    operatorRoot,
    ["pr", "view", String(pr), "--json", PR_VIEW_JSON_FIELDS],
    undefined,
    options?.spawnFn,
    options?.timeoutMs,
  );
  if (!result.ok) {
    throw new CliError(`gh pr view ${pr} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// The NO-ARGUMENT `gh pr view`: gh resolves the PR belonging to the
// checkout's current branch, which is the whole feature behind bare `--pr`
// — "review the PR I am standing on". Returns raw stdout for the pure
// resolveCurrentPrNumber; a branch with no PR fails loud, with gh's own
// message appended because it names the branch.
export async function ghCurrentBranchPr(
  operatorRoot: string,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<string> {
  const result = await gh(
    operatorRoot,
    ["pr", "view", "--json", "number"],
    undefined,
    options?.spawnFn,
  );
  if (!result.ok) {
    throw new CliError(
      `no PR found for the current branch of ${operatorRoot} — open one ` +
        "first or pass --pr <n> explicitly" +
        (result.stderr.trim() ? `: ${result.stderr.trim()}` : ""),
    );
  }
  return result.stdout;
}

// The open-PR listing the watch tick (B3) candidates from. Raw stdout for
// the pure parsePrList — same contract as ghPrView/resolvePrTarget. An
// explicit --limit, because gh's default caps the list at 30 NEWEST PRs:
// the watcher picks the LOWEST eligible number (FIFO), and a busy repo's
// oldest open PRs falling off the list would be exactly the silent
// truncation the comments fetch already learned to avoid with --paginate.
// additions/deletions/changedFiles ride along FREE: gh returns them in the
// same list response, and they are the watcher's zero-extra-call first tier
// for the size gate (see gatherRepoFacts). Verified against `gh pr list
// --json` on 2026-08-11 — all three are real list fields, alongside the
// per-file `files`, which is deliberately NOT requested here: it would make
// every tick carry the full file list of every open PR.
export const PR_LIST_JSON_FIELDS =
  "number,headRefOid,isDraft,additions,deletions,changedFiles";
export const PR_LIST_LIMIT = 200;

export async function ghPrList(operatorRoot: string): Promise<string> {
  const result = await gh(operatorRoot, [
    "pr",
    "list",
    "--limit",
    String(PR_LIST_LIMIT),
    "--json",
    PR_LIST_JSON_FIELDS,
  ]);
  if (!result.ok) {
    throw new CliError(`gh pr list failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// The repository's web URL (https://github.com/org/repo), used only to turn
// the PR comment's locations into links. Cosmetic by contract: ANY failure
// returns undefined and the comment renders plain — a review must never die,
// or even warn loudly, because a nicety could not be resolved.
// The size gate's SECOND tier, and only for a PR whose aggregate already
// exceeds a limit: the per-file list, so an exclusion (a regenerated
// lockfile, a minified bundle) can still rescue it. One gh call per such PR
// — the same "pay per candidate, only when the free check did not settle
// it" shape the comments fetch already uses.
//
// Field names verified live against `gh pr view <n> -R cli/cli --json files`
// on 2026-08-11: `{"files":[{"path":…,"additions":…,"deletions":…,
// "changeType":…}]}`.
//
// BOUNDED, and the bound is load-bearing since PR #205 put this call on the
// WATCH TICK path (the pre-launch exclusion veto in watch/watch.ts calls it every
// tick, for the chosen launch). `gh()`'s watchdog only arms when a timeoutMs
// is passed, so without this an accepted-but-unanswered `gh pr view` parks on
// `proc.exited` forever, and the tick that is holding watch.lock never
// returns — silencing every later tick, exactly what GH_PR_VIEW_TIMEOUT_MS's
// own WHY (store/gc-preflight.ts) exists to prevent, and what fetchCommitStatuses
// on the same path already spells out. Same constant as the GC's `gh pr
// view` because this IS a `gh pr view`. A timeout surfaces as a thrown
// CliError, which the veto's fail-open turns into "launch anyway" — the
// correct direction: an unreadable file list is no evidence against a PR.
export async function ghPrFiles(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<string> {
  const result = await gh(
    operatorRoot,
    ["pr", "view", String(pr), "--json", "files"],
    undefined,
    options?.spawnFn,
    GH_PR_VIEW_TIMEOUT_MS,
  );
  if (!result.ok) {
    throw new CliError(
      `gh pr view ${pr} --json files failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

// The PR's head AS GITHUB SEES IT RIGHT NOW — the re-read behind the
// moved-head disclosure (GitHub #39, ROADMAP-DOORDASH M1). Deliberately a
// separate, narrow call rather than reusing ghPrView: this runs in the
// posting sequence, milliseconds before a mutating POST, and the one field
// it needs is the one field it asks for.
//
// NON-THROWING, same cosmetic-degradation contract as ghRepoWebUrl above,
// and the WHY is the load-bearing part: `commit_id` on the review submission
// is the CORRECTNESS mechanism — with it, GitHub anchors every comment to
// the reviewed commit whatever the branch has done since. This re-read is
// only the DISCLOSURE on top of it. A disclosure that cannot be made must
// never cost the post that the pin already protects, so a gh failure (rate
// limit, transient 5xx, a repo the token lost access to) degrades to "we do
// not know", never to a thrown run. Empty stdout is treated as failure for
// the same reason `-q` on a deleted PR prints nothing: an empty string is
// not a sha, and comparing it against the reviewed head would manufacture a
// mismatch out of a missing answer.
export async function ghPrHeadSha(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn; timeoutMs?: number },
): Promise<string | undefined> {
  try {
    // Bounded by default (F004): its only caller is the findings POST's
    // pre-review re-read, and an unanswered read there would park the POST.
    const result = await gh(
      operatorRoot,
      ["pr", "view", String(pr), "--json", "headRefOid", "-q", ".headRefOid"],
      undefined,
      options?.spawnFn,
      options?.timeoutMs ?? POSTING_GH_TIMEOUT_MS,
    );
    if (!result.ok) return undefined;
    const sha = result.stdout.trim();
    return sha === "" ? undefined : sha;
  } catch {
    return undefined;
  }
}

export async function ghRepoWebUrl(
  operatorRoot: string,
  options?: { spawnFn?: typeof Bun.spawn; timeoutMs?: number },
): Promise<string | undefined> {
  try {
    // Bounded by default (F004): posting.ts calls this with no options, and an
    // unanswered `gh repo view` there would park the findings POST before its
    // first write. Every caller already treats undefined as "unknown", so a
    // timeout here degrades exactly like a failed call.
    const result = await gh(
      operatorRoot,
      ["repo", "view", "--json", "url", "-q", ".url"],
      undefined,
      options?.spawnFn,
      options?.timeoutMs ?? POSTING_GH_TIMEOUT_MS,
    );
    if (!result.ok) return undefined;
    const url = result.stdout.trim();
    return url === "" ? undefined : url;
  } catch {
    return undefined;
  }
}

// The PR's own web URL, the fallback an outside-channel triage reply links its finding through
// when the repo's web URL cannot be read. Bounded like ghRepoWebUrl, and undefined on any
// failure, so the caller can fall through to the next source.
export async function ghPrWebUrl(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn; timeoutMs?: number },
): Promise<string | undefined> {
  try {
    const result = await gh(
      operatorRoot,
      ["pr", "view", String(pr), "--json", "url", "-q", ".url"],
      undefined,
      options?.spawnFn,
      options?.timeoutMs ?? POSTING_GH_TIMEOUT_MS,
    );
    if (!result.ok) return undefined;
    const url = result.stdout.trim();
    return url === "" ? undefined : url;
  } catch {
    return undefined;
  }
}

// The repo's owner/name (`owner/repo`), the last source an outside-channel triage reply's link
// is built from. Bounded like ghRepoWebUrl; undefined on any failure.
export async function ghRepoNameWithOwner(
  operatorRoot: string,
  options?: { spawnFn?: typeof Bun.spawn; timeoutMs?: number },
): Promise<string | undefined> {
  try {
    const result = await gh(
      operatorRoot,
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      undefined,
      options?.spawnFn,
      options?.timeoutMs ?? POSTING_GH_TIMEOUT_MS,
    );
    if (!result.ok) return undefined;
    const name = result.stdout.trim();
    return name === "" ? undefined : name;
  } catch {
    return undefined;
  }
}

// In-flight / completed signal on the head SHA. Fail-loud here: the CLI
// catches and warns, because a missing `repo:status` scope must not abort a
// review that already cost hunter money. The context is the request's own
// (T3 S7): the gate's `pr-hero` only from a `--ci` run's request, and
// `pr-hero/local` from every other run, so the POST can never pick a context
// the caller did not choose.
export async function postCommitStatus(
  operatorRoot: string,
  sha: string,
  status: CommitStatusRequest,
  spawnFn?: typeof Bun.spawn,
  // Only the cancellation settle narrows these. It runs inside a signal
  // handler racing the runner's SIGKILL, where the retry below costs more
  // time than it buys. Every other caller keeps the two-attempt default.
  options?: { attempts?: number; timeoutMs?: number },
): Promise<string | undefined> {
  if (!isFullCommitId(sha)) {
    throw new CliError(
      `commit status: head sha is not a full 40-char id: ${sha.slice(0, 16)}`,
    );
  }
  const args = [
    "api",
    "--method",
    "POST",
    `repos/{owner}/{repo}/statuses/${sha}`,
    "-f",
    `state=${status.state}`,
    "-f",
    `context=${status.context}`,
    "-f",
    `description=${status.description}`,
  ];
  if (status.targetUrl !== undefined) {
    args.push("-f", `target_url=${status.targetUrl}`);
  }
  // Two attempts: a single blip on the completing POST is exactly how a
  // yellow pending gets stuck on a finished review.
  const attempts = options?.attempts ?? 2;
  const timeoutMs = options?.timeoutMs ?? COMMIT_STATUS_TIMEOUT_MS;
  let lastStderr = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await gh(operatorRoot, args, undefined, spawnFn, timeoutMs);
    if (result.ok) return createdAtOf(result.stdout);
    lastStderr = result.stderr.trim();
  }
  throw new CliError(
    `gh api (commit status ${status.state}) failed: ${lastStderr}`,
  );
}

// The created_at of the status a POST created, or undefined when the answer has none (a
// fake, or an answer gh did not print). Never throws: the write already landed.
function createdAtOf(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { created_at?: unknown };
    return typeof parsed.created_at === "string"
      ? parsed.created_at
      : undefined;
  } catch {
    return undefined;
  }
}

// Combined status (singular `/status`), not the paginated list (`/statuses`).
// The list interleaves every CI context newest-first, so a busy SHA can bury
// `pr-hero` past page 1 and the watcher would miss an in-flight pending.
// Combined returns the latest row per context in one shot.
//
// WHY per_page=100: the combined endpoint pages its contexts at 30 by default, so a
// busy head's `pr-hero` row can sit past the first page. The publisher's reader asks for
// 100 (src/ci/publish.ts, readHeadStatuses), and this one must see the same rows, or the
// CLI writes its verdict over an override the publisher sees. The in-flight readers
// (watch, the admission yield guard) take the newest row per context, so the extra rows
// only add contexts they would otherwise miss.
//
// The description rides along for the override check (src/pr/teardown.ts), which tells
// an override from a review's own status by it. The in-flight readers ignore it. The
// target_url rides along for `pr-hero status`, which names the run that wrote the gate.
//
// The head's full status history, every row, newest first, for the CI admission carry-forward
// (src/pr/admission.ts) and the skip's override check. It reads the paginated list (`/statuses`),
// not the combined endpoint: the combined one keeps only the newest row per context, so an override
// would show in place of the review's own verdict under it. Null on any failure, a malformed row
// included, so the caller can fail closed; an empty array means the head has no rows at all.
//
// WHY --paginate: a head with more than 100 rows keeps its older rows on page 2, and the carry reads
// the newest verdict. Page 1 alone would miss it and carry a false red. The call stays bounded by
// its timeout, and --paginate runs the --jq projection on every page, so the output is still one
// row per line.
export async function fetchCommitStatusList(
  operatorRoot: string,
  sha: string,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<CommitStatusFact[] | null> {
  if (!isFullCommitId(sha)) return null;
  try {
    const result = await gh(
      operatorRoot,
      [
        "api",
        "--paginate",
        `repos/{owner}/{repo}/commits/${sha}/statuses?per_page=100`,
        "--jq",
        ".[]? | {state: .state, context: .context, created_at: .created_at, description: .description}",
      ],
      undefined,
      options?.spawnFn,
      COMMIT_STATUS_TIMEOUT_MS,
    );
    if (!result.ok) return null;
    const statuses: CommitStatusFact[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = JSON.parse(line) as CommitStatusFact;
      if (
        typeof parsed.state !== "string" ||
        typeof parsed.context !== "string" ||
        typeof parsed.created_at !== "string"
      ) {
        return null;
      }
      statuses.push(parsed);
    }
    return statuses;
  } catch {
    return null;
  }
}

// The PR's commit shas, OLDEST first (GitHub's order for pulls/<n>/commits). The CI admission
// carry-forward walks them newest-first from the head (src/pr/admission.ts). WHY --paginate: a PR
// above 100 commits keeps its newest commits on page 2, which a single page would never reach. GitHub
// lists at most 250 commits per pull request, so the call is at most three requests, and it stays
// bounded by its timeout. Null on any failure or a malformed sha, so the caller can fail closed; an
// empty array means the list has no commits.
export async function fetchPrCommitShas(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<string[] | null> {
  try {
    const result = await gh(
      operatorRoot,
      [
        "api",
        "--paginate",
        `repos/{owner}/{repo}/pulls/${pr}/commits?per_page=100`,
        "--jq",
        ".[]?.sha",
      ],
      undefined,
      options?.spawnFn,
      COMMIT_STATUS_TIMEOUT_MS,
    );
    if (!result.ok) return null;
    const shas: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const sha = line.trim();
      if (sha === "") continue;
      if (!isFullCommitId(sha)) return null;
      shas.push(sha);
    }
    return shas;
  } catch {
    return null;
  }
}

// Never throws by default: a 403, a hung gh (timeout), or garbage jq must not take the watch tick
// down. Unreadable reads as no rows, which the watch reads as not in-flight.
//
// WHY failClosed: two readers must tell a failed read from a head with no status rows, because an
// empty answer for an unreadable head reads as "no status". The CI override check
// (src/ci/publish.ts, src/pr/teardown.ts) would then write over a human's decision, and `pr-hero status`,
// the skill's only reading of the gate (src/commands/status.ts), would send a review out blind. The
// default keeps the empty answer every watch and admission caller relies on.
//
// Three modes, because the readers need different things from a bad row:
// - false (default): a failed read returns [], and a bad row is dropped.
// - "read": a failed read throws, and so does an abbreviated sha, which is a head that cannot be read.
//   A bad row is still dropped, so one garbage line cannot hide a valid override on the same head.
//   This is the mode the override checks use: the only unknown is whether gh answered at all.
// - true: a failed read throws, and so does a bad row, because the row it would drop could be the
//   override. Used by `pr-hero status` and admission, which must not read past a row they cannot parse.
export async function fetchCommitStatuses(
  operatorRoot: string,
  sha: string,
  options?: { spawnFn?: typeof Bun.spawn; failClosed?: boolean | "read" },
): Promise<CommitStatusFact[]> {
  const failClosed = options?.failClosed;
  const strictRead = failClosed === true || failClosed === "read";
  const strictRows = failClosed === true;
  const unreadable = (why: string): CommitStatusFact[] => {
    if (strictRead) {
      throw new CliError(
        `could not read the statuses of ${sha.slice(0, 7)}: ${why}`,
      );
    }
    return [];
  };
  if (!isFullCommitId(sha)) return unreadable("not a full commit id");
  try {
    const result = await gh(
      operatorRoot,
      [
        "api",
        `repos/{owner}/{repo}/commits/${sha}/status?per_page=100`,
        "--jq",
        ".statuses[]? | {state: .state, context: .context, created_at: .created_at, description: .description, target_url: .target_url}",
      ],
      undefined,
      options?.spawnFn,
      COMMIT_STATUS_TIMEOUT_MS,
    );
    if (!result.ok) return unreadable(result.stderr.trim() || "gh failed");
    const statuses: CommitStatusFact[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      // Every bad line takes one of two paths, decided per line: a line that does not parse, and a line
      // that parses to something other than a status (`null`, a bare string, a row missing a field). Both
      // are skipped by default and in "read" mode, and both throw under true. The shape check sits inside
      // this per-line handling on purpose: outside it, a `null` throws a TypeError into the outer catch,
      // which returns [] and drops every status, not just the bad line.
      const parsed = parseStatusLine(line);
      if (parsed === null) {
        if (strictRows) {
          return unreadable(
            `unreadable commit status line from gh api: ${line.slice(0, 120)}`,
          );
        }
        // Drop the bad line; keep whatever parsed. One garbage object must not hide a real pending on
        // the next line.
        continue;
      }
      statuses.push(parsed);
    }
    return statuses;
  } catch (error) {
    if (strictRead) throw error;
    return [];
  }
}

// One line of the commit-status stream as a status fact, or null when the line is not one:
// unparseable JSON, or JSON that is not an object with the three string fields a status
// read needs. Pure, so both modes of fetchCommitStatuses judge a line the same way.
function parseStatusLine(line: string): CommitStatusFact | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const fact = parsed as Partial<CommitStatusFact>;
  if (
    typeof fact.state !== "string" ||
    typeof fact.context !== "string" ||
    typeof fact.created_at !== "string"
  ) {
    return null;
  }
  return fact as CommitStatusFact;
}

// WHY this exact refspec pair (paid-for): a merged PR's branch is usually
// deleted, so nothing but `refs/pull/<n>/head` keeps headRefOid fetchable —
// and fetching the base branch by name in the same call brings the merge
// commit and the baseRefOid ancestry along, so every rev the flow
// canonicalizes afterwards resolves against a single fetch.
export async function fetchPrRefs(
  gitDirOwner: string,
  pr: number,
  baseRefName: string,
): Promise<void> {
  const result = await git(gitDirOwner, [
    "fetch",
    "origin",
    `refs/pull/${pr}/head`,
    baseRefName,
  ]);
  if (!result.ok) {
    throw new CliError(
      `git fetch origin refs/pull/${pr}/head ${baseRefName} failed: ` +
        result.stderr.trim(),
    );
  }
}

// Create, reuse, or recreate the detached worktree at the PR's head. The
// decision itself is pure (decideWorktree); this runs the inspections that
// feed it and the git plumbing that enacts it.
export async function ensureWorktree(
  gitDirOwner: string,
  worktreePath: string,
  headSha: string,
): Promise<WorktreeDecision> {
  // Prune first: a worktree deleted by hand leaves a stale registration
  // behind, and a stale registration makes the add below refuse.
  const pruned = await git(gitDirOwner, ["worktree", "prune"]);
  if (!pruned.ok) {
    throw new CliError(`git worktree prune failed: ${pruned.stderr.trim()}`);
  }
  const exists = existsSync(worktreePath);
  let headMatches = false;
  let dirty = false;
  if (exists) {
    const head = await git(worktreePath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    headMatches = head.ok && head.stdout.trim() === headSha;
    if (headMatches) {
      const status = await git(worktreePath, ["status", "--porcelain"]);
      if (!status.ok) {
        throw new CliError(
          `git status failed in worktree ${worktreePath}: ` +
            status.stderr.trim(),
        );
      }
      dirty = worktreeDirty(status.stdout);
    }
  }
  const decision = decideWorktree({ exists, headMatches, dirty });
  if (decision.action === "recreate") {
    // --force is REQUIRED, and never rm -rf (VERIFIED 2026-08-10): a plain
    // `worktree remove` exits 128 on the untracked .codegraph/, and rm -rf
    // would yank .codegraph/daemon.sock out from under a live codegraph
    // daemon instead of letting git detach the tree cleanly.
    const removed = await git(gitDirOwner, [
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    if (!removed.ok) {
      throw new CliError(
        `git worktree remove --force ${worktreePath} failed: ` +
          removed.stderr.trim(),
      );
    }
    const reprune = await git(gitDirOwner, ["worktree", "prune"]);
    if (!reprune.ok) {
      throw new CliError(`git worktree prune failed: ${reprune.stderr.trim()}`);
    }
  }
  if (decision.action !== "reuse") {
    const added = await git(gitDirOwner, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      headSha,
    ]);
    if (!added.ok) {
      throw new CliError(
        `git worktree add --detach ${worktreePath} ${headSha} failed: ` +
          added.stderr.trim(),
      );
    }
  }
  return decision;
}

// Builds the worktree's OWN index — never another checkout's, whose bytes
// may differ (the ROADMAP forbids riding a sibling's index). Synchronous by
// design: the initial build is ~10s/~68MB (measured 8x in the bench), and a
// pipeline started before the index exists would run its hunters with an
// inert codegraph grant. The measured elapsed feeds telemetry.index_ms,
// which local mode hardcodes to 0 because it never builds anything.
export async function initCodegraphIndex(
  worktreePath: string,
): Promise<number> {
  const started = performance.now();
  const proc = Bun.spawn(["codegraph", "init", worktreePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new CliError(
      `codegraph init ${worktreePath} failed: ${stderr.trim()}`,
    );
  }
  return Math.round(performance.now() - started);
}

export interface ComparisonOutcome {
  greptileFound: boolean;
  greptileOnly: number;
  both: number;
  prheroOnly: number;
  markdownPath: string;
  jsonPath: string;
  // The whole bucketing, not just its cardinalities. writeComparison already
  // computes this to write comparison.md; discarding it left the terminal
  // structurally unable to say anything but numbers, and `greptileOnly` is
  // THE measured number — "a recall miss with a name, a file and a line"
  // (compare/compare.ts). IN-MEMORY ONLY: comparison.json's bytes are unchanged, and
  // must stay so — the ledger reads them back through StoredComparison.
  result: ComparisonResult;
}

// The in-process replacement for scripts/compare-pr.ts, run against the
// findings this review just produced. Throws on any gh failure — the CALLER
// decides that a comparison failure must not fail the run, because the
// review artifacts are already on disk and are the product.
export async function writeComparison(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  diffFromSha: string;
  runDir: string;
  generatedAt: string;
  runStatus: RunStatus;
  findings: PrHeroFindingRef[];
}): Promise<ComparisonOutcome> {
  const comments = await fetchPrComments(input.operatorRoot, input.pr);
  const body = pickGreptileComment(comments);
  const greptile = body === null ? [] : parseGreptileComment(body);
  const result = compareFindings(input.findings, greptile);
  const markdownPath = path.join(input.runDir, "comparison.md");
  const jsonPath = path.join(input.runDir, "comparison.json");
  await Bun.write(markdownPath, renderComparison(input.pr, result));
  await Bun.write(
    jsonPath,
    `${JSON.stringify(
      buildComparisonJson({
        pr: input.pr,
        headSha: input.headSha,
        diffFromSha: input.diffFromSha,
        runDir: input.runDir,
        generatedAt: input.generatedAt,
        runStatus: input.runStatus,
        greptileFound: body !== null,
        result,
      }),
      null,
      2,
    )}\n`,
  );
  return {
    greptileFound: body !== null,
    greptileOnly: result.greptileOnly.length,
    both: result.both.length,
    prheroOnly: result.prheroOnly.length,
    markdownPath,
    jsonPath,
    result,
  };
}

// Publishes the review as ONE marked PR comment: update the existing marked
// comment when there is one, create it otherwise. Idempotency lives in the
// marker contract (prCommentMarker as the body's first line, matched by
// findMarkedCommentId on the bare prefix) — a re-run refreshes the same
// comment instead of stacking a new one per run. Throws CliError on any gh
// failure and is NOT
// caught here: the caller asked for a public side effect, so the caller
// decides what a failed one means.
// ROADMAP B6 addition: `spawnFn`, same invisible-to-production seam as the
// other B6 functions (see gh()'s WHY). Needed so test/cli.test.ts can drive
// the WHOLE step-14 sequence — review, Outside Diff in the summary, summary
// PATCH LAST —
// through one shared fake gh, the same way test/pr/pr.test.ts already does for
// the per-finding functions; a summary PATCH the caller-level test could not
// see would leave the "PATCHed last" ordering unpinned.
//
// `knownCommentId` (create-first rework, Juanma's PR #2 feedback item 2):
// when the caller already knows the comment id — because IT just created
// the comment moments ago in this same run, and now wants the closing
// PATCH — skip the re-fetch-and-find-by-marker lookup entirely and PATCH
// that id directly. Without this, the closing PATCH would re-discover the
// comment via `findMarkedCommentId`, which is both a wasted round-trip
// (the id is already known) and, in a NO-op fake spawn, indistinguishable
// from "no comment exists yet" — silently creating a SECOND comment instead
// of patching the first. Omitted (the ordinary re-run path, where the
// existing comment came from a PREVIOUS run, not this one), the lookup runs
// exactly as before.
// `markerPrefix` defaults inside findMarkedCommentId itself (undefined here
// triggers ITS default, PR_COMMENT_MARKER_PREFIX), so every existing caller
// — both of which always pass a `knownCommentId` and never reach the lookup
// at all — stays byte-identical. ROADMAP Pillar 3's CI skip-comment posting
// is the first caller to exercise the lookup fallback for real, passing
// ci/gates.ts's SKIP_SIZE_COMMENT_MARKER / SKIP_BUDGET_COMMENT_MARKER so a
// repeat CI run finds and updates its own prior skip comment instead of
// stacking a new one.
// `timeoutMs` bounds the lookup and the write alike (F004). Its default is the
// findings POST's bound, and both production callers are on that path; the
// parameter exists so a test can prove a hang fails inside a few ms.
export async function postPrComment(
  operatorRoot: string,
  pr: number,
  body: string,
  spawnFn?: typeof Bun.spawn,
  knownCommentId?: number,
  markerPrefix?: string,
  timeoutMs: number = POSTING_GH_TIMEOUT_MS,
): Promise<{ action: "created" | "updated"; commentId: number }> {
  const existingId =
    knownCommentId ??
    findMarkedCommentId(
      await fetchPrComments(operatorRoot, pr, { spawnFn, timeoutMs }),
      markerPrefix,
    );
  const action = existingId === null ? "created" : "updated";
  // The body travels on stdin via `-F body=@-` (see gh()); PATCH updates the
  // found comment in place, POST creates the first one.
  const result =
    existingId === null
      ? await gh(
          operatorRoot,
          [
            "api",
            "--method",
            "POST",
            `repos/{owner}/{repo}/issues/${pr}/comments`,
            "-F",
            "body=@-",
          ],
          body,
          spawnFn,
          timeoutMs,
        )
      : await gh(
          operatorRoot,
          [
            "api",
            "--method",
            "PATCH",
            `repos/{owner}/{repo}/issues/comments/${existingId}`,
            "-F",
            "body=@-",
          ],
          body,
          spawnFn,
          timeoutMs,
        );
  if (!result.ok) {
    throw new CliError(
      `gh api (${action} PR comment) failed: ${result.stderr.trim()}`,
    );
  }
  // gh api prints the API's response object; its .id names the comment this
  // run touched, which the summary reports for later verification by hand.
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  const commentId = (parsed as { id?: unknown } | null)?.id;
  if (typeof commentId !== "number") {
    throw new CliError(
      `gh api ${action} a PR comment but returned no comment id: ` +
        result.stdout.slice(0, 120),
    );
  }
  return { action, commentId };
}

// The CI skip notice's channel (pr/admission.ts's publishCiSkip). It used to
// go through postPrComment's find-and-update, which PATCHed the previous
// notice on every push. GitHub neither notifies on an edit nor moves the
// comment down the timeline, so a later skip was invisible: on #315 the
// budget notice was created at 01:48 and silently re-edited at 02:48.
//
// Repost instead: POST the fresh notice at the bottom FIRST, then list the
// comments and DELETE the older ones under the same marker. That order is
// the point. A failed POST throws before anything is deleted, so the old
// notice survives. Listing AFTER the POST also catches a notice a concurrent
// run created in between. Everything after the POST is best-effort cleanup:
// a failed, rejected or hung listing or DELETE is logged and never fails the
// run, because the fresh notice already landed and one stale duplicate is
// the safe direction of error (the next skip removes it).
//
// Every call is bounded. gh() arms its watchdog only when given a timeout,
// and an accepted-but-unanswered request would otherwise park publishCiSkip
// before the step summary and CI outputs are written.
//
// Deletes only what this identity wrote: the body must START WITH the marker
// (findMarkedCommentId's rule, so a quoted marker or the summary is never
// touched) AND the author must be the one GitHub returned for the new
// notice. A PATCH on someone else's comment fails on its own; a DELETE with
// a write-scoped token does not, so a collaborator who pastes the notice's
// source would otherwise lose their comment. Unknown author → delete nothing.
const SKIP_NOTICE_GH_TIMEOUT_MS = 30_000;

export async function repostMarkedPrComment(input: {
  operatorRoot: string;
  pr: number;
  body: string;
  markerPrefix: string;
  spawnFn?: typeof Bun.spawn;
  // Test-only seam, like spawnFn.
  timeoutMs?: number;
}): Promise<{ commentId: number; deletedIds: number[] }> {
  const { operatorRoot, pr, spawnFn } = input;
  const timeoutMs = input.timeoutMs ?? SKIP_NOTICE_GH_TIMEOUT_MS;
  const created = await gh(
    operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      "-F",
      "body=@-",
    ],
    input.body,
    spawnFn,
    timeoutMs,
  );
  if (!created.ok) {
    throw new CliError(
      `gh api (post PR comment) failed: ${created.stderr.trim()}`,
    );
  }
  const commentId = parsePostedCommentId(created.stdout, "PR comment");
  const deletedIds: number[] = [];
  const author = postedCommentAuthor(created.stdout);
  if (author === undefined) {
    log(
      "could not tell who posted the new notice — older notices left in place",
    );
    return { commentId, deletedIds };
  }
  let previous: number[];
  try {
    previous = (await fetchPrComments(operatorRoot, pr, { spawnFn, timeoutMs }))
      .filter(
        (c) =>
          c.id !== commentId &&
          c.user === author &&
          typeof c.body === "string" &&
          c.body.startsWith(input.markerPrefix),
      )
      .map((c) => c.id);
  } catch (error) {
    log(
      "could not list older notices " +
        `(${error instanceof Error ? error.message : String(error)}) — the new one was posted`,
    );
    return { commentId, deletedIds };
  }
  for (const id of previous) {
    try {
      const deleted = await gh(
        operatorRoot,
        [
          "api",
          "--method",
          "DELETE",
          `repos/{owner}/{repo}/issues/comments/${id}`,
        ],
        undefined,
        spawnFn,
        timeoutMs,
      );
      if (deleted.ok) {
        deletedIds.push(id);
      } else {
        log(
          `could not delete the previous notice ${id} ` +
            `(${deleted.stderr.trim()}) — the new one was posted`,
        );
      }
    } catch (error) {
      log(
        `could not delete the previous notice ${id} ` +
          `(${error instanceof Error ? error.message : String(error)}) — the new one was posted`,
      );
    }
  }
  return { commentId, deletedIds };
}

function postedCommentAuthor(stdout: string): string | undefined {
  try {
    const login = (JSON.parse(stdout) as { user?: { login?: unknown } } | null)
      ?.user?.login;
    return typeof login === "string" && login !== "" ? login : undefined;
  } catch {
    return undefined;
  }
}

// Mirror of scripts/compare-pr.ts's fetch, kept shape-identical on purpose.
// --paginate matters: a busy PR accumulates enough comments to push
// Greptile's off page 1, and a missing comment looks identical to "Greptile
// found nothing" — the exact failure mode that would silently flatter
// pr-hero. API order is preserved verbatim (no sort, no reverse):
// pickGreptileComment reads "newest" as LAST.
//
// Exported since B3: the watch guard reads the same comments to learn which
// heads a pr-hero marker already declares (watch/watch.ts imports this one-way;
// pr.ts never imports watch/watch.ts, so the no-mutual-shells rule holds).
export async function fetchPrComments(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn; timeoutMs?: number },
): Promise<
  {
    id: number;
    user: string;
    body: string;
    created_at?: string;
    updated_at?: string;
  }[]
> {
  const result = await gh(
    operatorRoot,
    [
      "api",
      "--paginate",
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      "--jq",
      ".[] | {id: .id, user: .user.login, body: .body, created_at: .created_at, updated_at: .updated_at}",
    ],
    undefined,
    options?.spawnFn,
    options?.timeoutMs,
  );
  if (!result.ok) {
    // Live evidence on MusiveTech/musive 2026-08-17: REST GET on
    // issues/<n>/comments can 404 while POST on the same path and GraphQL
    // both succeed — posting dies at the pre-flight fetch with no review
    // published. Fall back to GraphQL so listing tracks the write path.
    if (is404(result.stderr)) {
      return fetchPrCommentsGraphql(
        operatorRoot,
        pr,
        options?.spawnFn,
        options?.timeoutMs,
      );
    }
    throw new CliError(
      `gh api issues/${pr}/comments failed: ${result.stderr.trim()}`,
    );
  }
  // `--jq` streams one JSON object per line.
  const comments: {
    id: number;
    user: string;
    body: string;
    created_at?: string;
    updated_at?: string;
  }[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as {
        id: number;
        user: string;
        body: string;
        created_at?: unknown;
        updated_at?: unknown;
      };
      comments.push({
        id: parsed.id,
        user: parsed.user,
        body: parsed.body,
        ...(typeof parsed.created_at === "string"
          ? { created_at: parsed.created_at }
          : {}),
        ...(typeof parsed.updated_at === "string"
          ? { updated_at: parsed.updated_at }
          : {}),
      });
    } catch {
      throw new CliError(`unparseable line from gh api: ${line.slice(0, 120)}`);
    }
  }
  return comments;
}

// ---------------------------------------------------------------------------
// Inline review surface (ROADMAP B6, WU4/WU5) — the fetcher, the atomic
// review submission with its 422 recovery, and the per-finding issue
// comment. pr/inline.ts plans WHAT to post (pure); everything below executes
// that plan and is the only place in the engine allowed to.

// Review-level (inline) comments, as opposed to fetchPrComments's top-level
// issue comments — a DIFFERENT GitHub endpoint (`pulls/<n>/comments`, not
// `issues/<n>/comments`). Shape-identical to fetchPrComments on purpose
// (same --paginate + --jq style, same loud parse failure): the two fetchers
// read two different comment streams the same way, so a bug in one parsing
// discipline is not a bug the other could hide.
//
// `in_reply_to_id` is what `pr-hero triage reply` uses to bind a triage
// response to its finding thread (W1). The finder still only needs
// `path`/`line` plus the marker; projecting the reply-to id here costs
// nothing and means the bind path does not make a second fetch shape.
export interface PrReviewComment {
  id: number;
  user: string;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  in_reply_to_id: number | null;
  created_at?: string;
}

export async function fetchPrReviewComments(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn; timeoutMs?: number },
): Promise<PrReviewComment[]> {
  const result = await gh(
    operatorRoot,
    [
      "api",
      "--paginate",
      `repos/{owner}/{repo}/pulls/${pr}/comments`,
      "--jq",
      ".[] | {id: .id, user: .user.login, body: .body, path: .path, " +
        "line: .line, original_line: .original_line, " +
        "in_reply_to_id: .in_reply_to_id, created_at: .created_at}",
    ],
    undefined,
    options?.spawnFn,
    options?.timeoutMs,
  );
  if (!result.ok) {
    if (is404(result.stderr)) {
      return fetchPrReviewCommentsGraphql(
        operatorRoot,
        pr,
        options?.spawnFn,
        options?.timeoutMs,
      );
    }
    throw new CliError(
      `gh api pulls/${pr}/comments failed: ${result.stderr.trim()}`,
    );
  }
  const comments: PrReviewComment[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      comments.push(JSON.parse(line) as PrReviewComment);
    } catch {
      throw new CliError(`unparseable line from gh api: ${line.slice(0, 120)}`);
    }
  }
  return comments;
}

// Both channels pr-hero's own per-finding comments can live in, reduced to
// pr/inline.ts's PostedFindingComment shape. A comment that does not parse as a
// finding marker is silently excluded — this is where the two marker
// prefixes' disjointness (pr/preflight.ts) actually pays for itself: the
// summary comment's `<!-- pr-hero-report ` marker never parses as a
// `<!-- pr-hero-finding ` one, so it drops out of this list without any
// special-casing, and a human's reply (any shape) drops out the same way.
export async function fetchPostedFindingComments(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn; timeoutMs?: number },
): Promise<PostedFindingComment[]> {
  const [reviewComments, issueComments] = await Promise.all([
    fetchPrReviewComments(operatorRoot, pr, options),
    fetchPrComments(operatorRoot, pr, options),
  ]);
  const out: PostedFindingComment[] = [];
  for (const comment of reviewComments) {
    const marker = parseFindingMarker(comment.body);
    if (marker === null) continue;
    out.push({
      id: comment.id,
      channel: "review",
      marker,
      livePath: comment.path,
      liveLine: comment.line ?? undefined,
      ...(comment.created_at === undefined
        ? {}
        : { created_at: comment.created_at }),
    });
  }
  for (const comment of issueComments) {
    const marker = parseFindingMarker(comment.body);
    if (marker === null) continue;
    out.push({
      id: comment.id,
      channel: "issue",
      marker,
      ...(comment.created_at === undefined
        ? {}
        : { created_at: comment.created_at }),
    });
  }
  return out;
}

// gh api prints "<message> (HTTP <code>)" on stderr for any non-2xx
// response. Matching only the status code — never the message, which
// GitHub varies by cause ("Unprocessable Entity", or a specific field
// error) — is what lets the SAME recovery apply whether the rejection is
// "this comment could not anchor" or "you already have a pending review"
// (a leftover from a prior crashed run): the spec explicitly rules out
// reason-string special-casing (design D1), because GitHub's 422 body does
// not reliably name which comment failed.
function is422(stderr: string): boolean {
  return /\(HTTP 422\)/.test(stderr);
}

function is404(stderr: string): boolean {
  return /\(HTTP 404\)/.test(stderr);
}

// GraphQL fallback for fetchPrComments — same shape the REST --jq path
// produces. Variable names are repoOwner/repoName so they cannot collide
// with gh -f name= interpolating $name inside the query document.
const PR_ISSUE_COMMENTS_QUERY =
  "query($repoOwner:String!,$repoName:String!,$number:Int!,$cursor:String){" +
  "repository(owner:$repoOwner,name:$repoName){pullRequest(number:$number){" +
  "comments(first:100,after:$cursor){" +
  "pageInfo{endCursor hasNextPage}" +
  "nodes{databaseId body createdAt updatedAt author{login}}}}}}";

const PR_REVIEW_COMMENTS_QUERY =
  "query($repoOwner:String!,$repoName:String!,$number:Int!,$cursor:String){" +
  "repository(owner:$repoOwner,name:$repoName){pullRequest(number:$number){" +
  `reviewThreads(first:${THREAD_PAGE_SIZE},after:$cursor){` +
  "pageInfo{endCursor hasNextPage}" +
  "nodes{comments(first:100){nodes{" +
  "fullDatabaseId body createdAt author{login __typename} path line originalLine " +
  "replyTo{fullDatabaseId}}}}}}}}";

// Parses `gh api repos/.../compare/{base}...{head}` — filenames only.
export function parseCompareChangedFiles(stdout: string): string[] {
  return parseCompareChangedFilesWithStatus(stdout).map((entry) => entry.path);
}

export type CompareChangedFileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed";

export interface CompareChangedFile {
  path: string;
  status: CompareChangedFileStatus;
}

const COMPARE_CHANGED_FILE_STATUSES = new Set<CompareChangedFileStatus>([
  "added",
  "modified",
  "removed",
  "renamed",
]);

function asCompareChangedFileStatus(
  value: unknown,
): CompareChangedFileStatus | null {
  if (typeof value !== "string") return null;
  return (COMPARE_CHANGED_FILE_STATUSES as ReadonlySet<string>).has(value)
    ? (value as CompareChangedFileStatus)
    : null;
}

// Parses `gh api repos/.../compare/{base}...{head}` — filenames and status.
export function parseCompareChangedFilesWithStatus(
  stdout: string,
): CompareChangedFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError(
      `gh api compare returned invalid JSON: ${stdout.slice(0, 120)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CliError("gh api compare returned no object");
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw new CliError("gh api compare returned no files list");
  }
  const paths: CompareChangedFile[] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { filename?: unknown; status?: unknown };
    const filename = record.filename;
    const status = asCompareChangedFileStatus(record.status) ?? "modified";
    if (typeof filename === "string" && filename.length > 0) {
      paths.push({ path: filename, status });
    }
  }
  return paths;
}

export async function ghCompareChangedFiles(
  operatorRoot: string,
  base: string,
  head: string,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<string[]> {
  const files = await ghCompareChangedFilesWithStatus(
    operatorRoot,
    base,
    head,
    options,
  );
  return files.map((entry) => entry.path);
}

export async function ghCompareChangedFilesWithStatus(
  operatorRoot: string,
  base: string,
  head: string,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<CompareChangedFile[]> {
  const repo = await ghRepoOwnerName(operatorRoot, options?.spawnFn);
  const result = await gh(
    operatorRoot,
    ["api", `repos/${repo.owner}/${repo.name}/compare/${base}...${head}`],
    undefined,
    options?.spawnFn,
  );
  if (!result.ok) {
    throw new CliError(`gh api compare failed: ${result.stderr.trim()}`);
  }
  return parseCompareChangedFilesWithStatus(result.stdout);
}

const PR_HERO_WORKFLOW_FILE = "pr-hero.yml";
const COMPLETED_WORKFLOW_CONCLUSIONS = new Set(["success", "failure"]);

// Distinct head SHAs from completed pr-hero workflow runs on a branch.
export function parsePrHeroWorkflowRunHeads(stdout: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError(
      `gh run list returned invalid JSON: ${stdout.slice(0, 120)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliError("gh run list must return a JSON array");
  }
  const heads = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { headSha?: unknown; conclusion?: unknown };
    const conclusion = record.conclusion;
    if (
      typeof conclusion !== "string" ||
      !COMPLETED_WORKFLOW_CONCLUSIONS.has(conclusion)
    ) {
      continue;
    }
    const headSha = record.headSha;
    if (typeof headSha === "string" && isFullCommitId(headSha)) {
      heads.add(headSha);
    }
  }
  return heads;
}

export async function ghPrHeroWorkflowRunHeads(
  operatorRoot: string,
  branch: string,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<Set<string>> {
  const result = await gh(
    operatorRoot,
    [
      "run",
      "list",
      "--workflow",
      PR_HERO_WORKFLOW_FILE,
      "--branch",
      branch,
      "--json",
      "headSha,conclusion",
    ],
    undefined,
    options?.spawnFn,
  );
  if (!result.ok) {
    throw new CliError(`gh run list failed: ${result.stderr.trim()}`);
  }
  return parsePrHeroWorkflowRunHeads(result.stdout);
}

async function ghGraphql(
  operatorRoot: string,
  query: string,
  variables: Record<string, string | number>,
  what: string,
  spawnFn?: typeof Bun.spawn,
  timeoutMs?: number,
): Promise<string> {
  assertBalancedGraphql(query, what);
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    const flag = typeof value === "number" ? "-F" : "-f";
    args.push(flag, `${key}=${value}`);
  }
  const result = await gh(operatorRoot, args, undefined, spawnFn, timeoutMs);
  if (!result.ok) {
    throw new CliError(
      `gh api graphql (${what}) failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function graphqlLogin(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const login = (value as { login?: unknown }).login;
  return typeof login === "string" ? login : "";
}

// WHY a bot gets the REST spelling: REST reports a GitHub App as
// `github-actions[bot]`, while GraphQL reports the bare login. Without this the
// CI adjudicator's login would differ between the two read paths.
function graphqlReviewLogin(value: unknown): string {
  const login = graphqlLogin(value);
  const typename =
    typeof value === "object" && value !== null
      ? (value as { __typename?: unknown }).__typename
      : undefined;
  return typename === "Bot" && login !== "" ? `${login}[bot]` : login;
}

function issueCommentsFromNodes(nodes: unknown[]): {
  id: number;
  user: string;
  body: string;
  created_at?: string;
  updated_at?: string;
}[] {
  const comments: {
    id: number;
    user: string;
    body: string;
    created_at?: string;
    updated_at?: string;
  }[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as {
      databaseId?: unknown;
      body?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
      author?: unknown;
    };
    const id = graphqlDatabaseId(record.databaseId);
    if (id === null) continue;
    comments.push({
      id,
      user: graphqlLogin(record.author),
      body: typeof record.body === "string" ? record.body : "",
      ...(typeof record.createdAt === "string"
        ? { created_at: record.createdAt }
        : {}),
      ...(typeof record.updatedAt === "string"
        ? { updated_at: record.updatedAt }
        : {}),
    });
  }
  return comments;
}

interface IssueCommentsGraphqlPage {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function parseIssueCommentsGraphqlPage(
  stdout: string,
): IssueCommentsGraphqlPage {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError(
      "gh api graphql (issueComments) returned invalid JSON: " +
        stdout.slice(0, 120),
    );
  }
  const connection = (
    parsed as {
      data?: {
        repository?: {
          pullRequest?: { comments?: unknown };
        };
      };
    } | null
  )?.data?.repository?.pullRequest?.comments;
  if (typeof connection !== "object" || connection === null) {
    throw new CliError(
      "gh api graphql (issueComments) returned no comment list",
    );
  }
  const record = connection as Record<string, unknown>;
  const nodes = record.nodes;
  if (!Array.isArray(nodes)) {
    throw new CliError(
      "gh api graphql (issueComments) returned no comment list",
    );
  }
  const pageInfo = record.pageInfo;
  if (typeof pageInfo !== "object" || pageInfo === null) {
    throw new CliError("gh api graphql (issueComments) returned no pageInfo");
  }
  const hasNextPage =
    (pageInfo as { hasNextPage?: unknown }).hasNextPage === true;
  const endCursorRaw = (pageInfo as { endCursor?: unknown }).endCursor;
  const endCursor =
    typeof endCursorRaw === "string" && endCursorRaw.length > 0
      ? endCursorRaw
      : null;
  if (hasNextPage && endCursor === null) {
    throw new CliError(
      "gh api graphql (issueComments) hasNextPage is true but endCursor is missing",
    );
  }
  return { nodes, hasNextPage, endCursor };
}

async function fetchPrCommentsGraphql(
  operatorRoot: string,
  pr: number,
  spawnFn?: typeof Bun.spawn,
  timeoutMs?: number,
): Promise<
  {
    id: number;
    user: string;
    body: string;
    created_at?: string;
    updated_at?: string;
  }[]
> {
  assertBalancedGraphql(PR_ISSUE_COMMENTS_QUERY, "issueComments");
  const repo = await ghRepoOwnerName(operatorRoot, spawnFn, timeoutMs);
  const comments: {
    id: number;
    user: string;
    body: string;
    created_at?: string;
    updated_at?: string;
  }[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let pageCount = 0;
  while (hasNextPage) {
    pageCount++;
    const variables: Record<string, string | number> = {
      repoOwner: repo.owner,
      repoName: repo.name,
      number: pr,
    };
    if (cursor !== null) {
      variables.cursor = cursor;
    }
    const stdout = await ghGraphql(
      operatorRoot,
      PR_ISSUE_COMMENTS_QUERY,
      variables,
      "issueComments",
      spawnFn,
      timeoutMs,
    );
    const page = parseIssueCommentsGraphqlPage(stdout);
    comments.push(...issueCommentsFromNodes(page.nodes));
    hasNextPage = page.hasNextPage;
    cursor = page.endCursor;
    if (hasNextPage && pageCount >= GRAPHQL_COMMENT_MAX_PAGES) {
      throw new CommentsTruncatedError(
        `gh api graphql (issueComments) exceeded ${GRAPHQL_COMMENT_MAX_PAGES} pages`,
      );
    }
  }
  return comments;
}

interface ReviewCommentsGraphqlPage {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function parseReviewCommentsGraphqlPage(
  stdout: string,
): ReviewCommentsGraphqlPage {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError(
      "gh api graphql (reviewComments) returned invalid JSON: " +
        stdout.slice(0, 120),
    );
  }
  const connection = (
    parsed as {
      data?: {
        repository?: {
          pullRequest?: { reviewThreads?: unknown };
        };
      };
    } | null
  )?.data?.repository?.pullRequest?.reviewThreads;
  if (typeof connection !== "object" || connection === null) {
    throw new CliError(
      "gh api graphql (reviewComments) returned no thread list",
    );
  }
  const record = connection as Record<string, unknown>;
  const nodes = record.nodes;
  if (!Array.isArray(nodes)) {
    throw new CliError(
      "gh api graphql (reviewComments) returned no thread list",
    );
  }
  const pageInfo = record.pageInfo;
  if (typeof pageInfo !== "object" || pageInfo === null) {
    throw new CliError("gh api graphql (reviewComments) returned no pageInfo");
  }
  const hasNextPage =
    (pageInfo as { hasNextPage?: unknown }).hasNextPage === true;
  const endCursorRaw = (pageInfo as { endCursor?: unknown }).endCursor;
  const endCursor =
    typeof endCursorRaw === "string" && endCursorRaw.length > 0
      ? endCursorRaw
      : null;
  if (hasNextPage && endCursor === null) {
    throw new CliError(
      "gh api graphql (reviewComments) hasNextPage is true but endCursor is missing",
    );
  }
  return { nodes, hasNextPage, endCursor };
}

function reviewCommentsFromThreadNodes(
  threadNodes: unknown[],
): PrReviewComment[] {
  const comments: PrReviewComment[] = [];
  for (const thread of threadNodes) {
    if (typeof thread !== "object" || thread === null) continue;
    const commentNodes = (thread as { comments?: { nodes?: unknown } }).comments
      ?.nodes;
    if (!Array.isArray(commentNodes)) continue;
    for (const node of commentNodes) {
      if (typeof node !== "object" || node === null) continue;
      const record = node as {
        fullDatabaseId?: unknown;
        body?: unknown;
        createdAt?: unknown;
        author?: unknown;
        path?: unknown;
        line?: unknown;
        originalLine?: unknown;
        replyTo?: { fullDatabaseId?: unknown } | null;
      };
      const id = graphqlDatabaseId(record.fullDatabaseId);
      if (id === null) continue;
      const line =
        typeof record.line === "number" && Number.isInteger(record.line)
          ? record.line
          : null;
      const originalLine =
        typeof record.originalLine === "number" &&
        Number.isInteger(record.originalLine)
          ? record.originalLine
          : null;
      const replyToId = graphqlDatabaseId(record.replyTo?.fullDatabaseId);
      comments.push({
        id,
        user: graphqlReviewLogin(record.author),
        body: typeof record.body === "string" ? record.body : "",
        path: typeof record.path === "string" ? record.path : "",
        line,
        original_line: originalLine,
        in_reply_to_id: replyToId,
        ...(typeof record.createdAt === "string"
          ? { created_at: record.createdAt }
          : {}),
      });
    }
  }
  return comments;
}

async function fetchPrReviewCommentsGraphql(
  operatorRoot: string,
  pr: number,
  spawnFn?: typeof Bun.spawn,
  timeoutMs?: number,
): Promise<PrReviewComment[]> {
  assertBalancedGraphql(PR_REVIEW_COMMENTS_QUERY, "reviewComments");
  const repo = await ghRepoOwnerName(operatorRoot, spawnFn, timeoutMs);
  const comments: PrReviewComment[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let pageCount = 0;
  while (hasNextPage) {
    pageCount++;
    const variables: Record<string, string | number> = {
      repoOwner: repo.owner,
      repoName: repo.name,
      number: pr,
    };
    if (cursor !== null) {
      variables.cursor = cursor;
    }
    const stdout = await ghGraphql(
      operatorRoot,
      PR_REVIEW_COMMENTS_QUERY,
      variables,
      "reviewComments",
      spawnFn,
      timeoutMs,
    );
    const page = parseReviewCommentsGraphqlPage(stdout);
    comments.push(...reviewCommentsFromThreadNodes(page.nodes));
    hasNextPage = page.hasNextPage;
    cursor = page.endCursor;
    if (hasNextPage && pageCount >= GRAPHQL_COMMENT_MAX_PAGES) {
      throw new CommentsTruncatedError(
        `gh api graphql (reviewComments) exceeded ${GRAPHQL_COMMENT_MAX_PAGES} pages`,
      );
    }
  }
  return comments;
}

export interface ReviewSubmissionOutcome {
  // "posted": every finding in `findings` is now in the one review.
  // "demoted": the review was rejected (422); `findings` is the subset of
  //   the ORIGINAL submission still classified fresh after a FULL re-match —
  //   the caller puts these in the summary Outside Diff bucket (issues
  //   #16/#17) instead of posting them as issue comments.
  //
  // WHY a full re-match, not a re-match over `findings` alone (CRIT-A,
  // verify-report-pr3 #3305 — the bug the previous `consumedCommentIds`
  // design left in place): matchPostedFindings is one-to-one only across the
  // finding list it is handed. Re-running it over `findings` — a SUBSET of
  // what buildPostPlan matched in the first place — can DISSOLVE A TIE: a
  // comment the full plan adjudicated to some OTHER, already-persisting
  // finding becomes the sole remaining candidate here and silently swallows
  // a genuinely new finding, even though the plan itself resolved that exact
  // tie by posting fresh. Re-matching the FULL finding list (`allFindings`,
  // the exact set the plan matched) against the fresh fetch reproduces the
  // plan's own adjudication byte-for-byte whenever GitHub created nothing —
  // the common case, since a 422 means the review was never persisted — and
  // diverges from it only where GitHub genuinely created something between
  // the plan and this call, which is the only case the recovery should
  // differ in at all. Tie- and order-independent by construction: unlike the
  // old subset-and-exclude approach, nothing here depends on which findings
  // happened to be excluded first.
  outcome: "posted" | "demoted";
  findings: Finding[];
}

// The one atomic review submission (spec "One review submission for
// anchorable findings"), plus its 422 recovery (spec "GitHub is the anchor
// authority", design D1). `findings` is the plan's `reviewComments` — the
// set pr/inline.ts already classified anchorable AND unmatched to a prior
// comment; an empty set never reaches gh at all (spec "Zero anchorable
// findings": an empty `comments[]` review is never sent).
//
// WHY re-fetch-and-rematch, not fail-loud, not parse-and-retry-the-offender,
// not N separate POSTs (design D1, rejected alternatives kept here because
// they will keep sounding reasonable to the next person who reads this):
// fail-loud means a review that already cost real hunter/refuter money says
// NOTHING on the PR — the worst outcome available. Parsing the 422 to retry
// only the offending comment assumes GitHub's error body names it reliably;
// it does not (verified against `gh api` 2026-08-10 — the response is a
// generic "Unprocessable Entity" with, at best, a field-level error array
// that does not carry the comments[] index). N separate
// `POST pulls/<n>/comments` calls trade the one atomicity problem for a
// worse one: N GitHub notifications instead of one review, and a partial
// failure midway leaves some findings posted and others not, with no single
// state to reconcile against. Re-fetching and re-running matchPostedFindings
// — the SAME function an ordinary second run already uses for cross-run
// identity — means the recovery is not a special code path at all: whatever
// the live PR already carries is `persist`, whatever it does not is
// `fresh`, and only `fresh` reaches the caller, this time for the summary
// Outside Diff bucket (issues #16/#17) rather than a second review attempt.
// The matcher doubles as the recovery mechanism.
export async function postPrReview(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  findings: Finding[];
  // The FULL finding list this run is considering — the exact set
  // buildPostPlan matched against `posted` to produce the plan in the first
  // place (not just `findings`, the anchorable-fresh subset). REQUIRED, not
  // optional, so a caller cannot silently narrow it and reintroduce CRIT-A —
  // see ReviewSubmissionOutcome's WHY above for the failure this closes.
  allFindings: PrHeroFindingRef[];
  webUrl?: string;
  spawnFn?: typeof Bun.spawn;
  // Bounds the submission and its 422 recovery reads (F004). Defaults to the
  // posting bound; a timeout is NOT retried, because the submission may already
  // have landed and a second POST would duplicate the review.
  timeoutMs?: number;
}): Promise<ReviewSubmissionOutcome> {
  if (input.findings.length === 0) {
    return { outcome: "posted", findings: [] };
  }
  const body = {
    // GitHub #39 (ROADMAP-DOORDASH M1). WITHOUT this, `POST
    // .../pulls/<n>/reviews` resolves every `line` against the PR's LATEST
    // commit at post time — not the commit the lines were computed on. A
    // review takes minutes; an author who pushes while it runs gets one of
    // two outcomes, and the silent one is the reason this line exists: a
    // finding's line that still EXISTS in the newer diff but now means
    // something else anchors cleanly to code the finding was never about.
    // No error, no signal, nothing a reader could tell apart from a real
    // finding. Pinned, GitHub anchors to the reviewed commit and marks the
    // comment outdated ITSELF once the lines move — the reconciliation the
    // engine would otherwise have to invent.
    //
    // The pin also creates a NEW 422 class, and that is the pin working
    // rather than a regression: if `headSha` is rewritten out of the PR
    // mid-run (a force-push), GitHub rejects the whole submission because
    // the commit is no longer part of it, where the unpinned code would
    // have silently posted against whatever replaced it. The recovery below
    // is exactly right for that — re-fetch, re-match, demote the survivors
    // into the summary's Comments Outside Diff bucket. Degraded, honest,
    // and never a hard failure.
    commit_id: input.headSha,
    event: "COMMENT",
    comments: input.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      body: renderInlineComment(finding, input.headSha, input.webUrl),
    })),
  };
  // `--input -`, not `-F`: gh's `-F`/`-f` field composition has no way to
  // express an ARRAY of objects, and comments[] is exactly that. The whole
  // request body travels on stdin as one JSON document — same ARG_MAX/no-
  // shell reasoning as postPrComment's `-F body=@-`, just for a body gh
  // cannot compose from flags at all.
  const result = await gh(
    input.operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/pulls/${input.pr}/reviews`,
      "--input",
      "-",
    ],
    JSON.stringify(body),
    input.spawnFn,
    input.timeoutMs ?? POSTING_GH_TIMEOUT_MS,
  );
  if (result.ok) {
    return { outcome: "posted", findings: input.findings };
  }
  if (!is422(result.stderr)) {
    throw new CliError(
      `gh api (post PR review) failed: ${result.stderr.trim()}`,
    );
  }
  const posted = await fetchPostedFindingComments(
    input.operatorRoot,
    input.pr,
    {
      spawnFn: input.spawnFn,
      timeoutMs: input.timeoutMs ?? POSTING_GH_TIMEOUT_MS,
    },
  );
  const match = matchPostedFindings({
    findings: input.allFindings,
    posted,
    headSha: input.headSha,
  });
  const stillFreshIds = new Set(match.fresh.map((finding) => finding.id));
  return {
    outcome: "demoted",
    findings: input.findings.filter((finding) => stillFreshIds.has(finding.id)),
  };
}

// One un-anchorable (or 422-demoted) finding, posted as its own top-level
// issue comment (spec "One issue comment per un-anchorable finding": never
// pooled). Always a fresh POST, never a PATCH — unlike postPrComment's
// single summary comment, there is no "the" prior comment to update; a
// finding either already has one (the caller's plan already excluded it,
// via pr/inline.ts's matcher) or it does not.
export async function postIssueComment(
  operatorRoot: string,
  pr: number,
  finding: Finding,
  headSha: string,
  webUrl?: string,
  spawnFn?: typeof Bun.spawn,
): Promise<number> {
  const body = renderIssueFindingComment(finding, headSha, webUrl);
  const result = await gh(
    operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      "-F",
      "body=@-",
    ],
    body,
    spawnFn,
  );
  if (!result.ok) {
    throw new CliError(
      `gh api (post finding issue comment) failed: ${result.stderr.trim()}`,
    );
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  const commentId = (parsed as { id?: unknown } | null)?.id;
  if (typeof commentId !== "number") {
    throw new CliError(
      "gh api posted a finding issue comment but returned no comment id: " +
        result.stdout.slice(0, 120),
    );
  }
  return commentId;
}

// A fresh top-level issue comment with a pre-rendered body. Always a POST,
// never find-and-update: unlike the summary, every re-review's closing
// comment is its own entry in the timeline on purpose.
async function postIssueCommentBody(
  operatorRoot: string,
  pr: number,
  body: string,
  spawnFn?: typeof Bun.spawn,
  timeoutMs?: number,
): Promise<number> {
  const result = await gh(
    operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      "-F",
      "body=@-",
    ],
    body,
    spawnFn,
    timeoutMs,
  );
  if (!result.ok) {
    throw new CliError(
      `gh api (post issue comment) failed: ${result.stderr.trim()}`,
    );
  }
  return parsePostedCommentId(result.stdout, "issue comment");
}

function parsePostedCommentId(stdout: string, what: string): number {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  const commentId = (parsed as { id?: unknown } | null)?.id;
  if (typeof commentId !== "number") {
    throw new CliError(
      `gh api posted a ${what} but returned no comment id: ` +
        stdout.slice(0, 120),
    );
  }
  return commentId;
}

// Inline triage reply: POST pulls/<n>/comments with in_reply_to set to the
// finding's own review-comment id. The parent id is resolved by the caller
// from fetchPostedFindingComments + matchPostedFindingExact — this function
// never looks at path/line. Body on stdin (ARG_MAX / no-shell, same as
// postIssueComment).
export async function postReviewCommentReply(input: {
  operatorRoot: string;
  pr: number;
  inReplyTo: number;
  body: string;
  spawnFn?: typeof Bun.spawn;
  // Optional per-call watchdog. Absent keeps the historical unbounded wait
  // for the interactive triage path (a human is watching); the verified-gone
  // collapse loop passes one, because nothing is watching an unattended run.
  timeoutMs?: number;
}): Promise<number> {
  const result = await gh(
    input.operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/pulls/${input.pr}/comments`,
      "-F",
      "body=@-",
      "-F",
      `in_reply_to=${input.inReplyTo}`,
    ],
    input.body,
    input.spawnFn,
    input.timeoutMs,
  );
  if (!result.ok) {
    throw new CliError(
      `gh api (post triage review reply) failed: ${result.stderr.trim()}`,
    );
  }
  return parsePostedCommentId(result.stdout, "triage review reply");
}

// Un-anchorable finding (#17 channel): GitHub issue comments have no
// native thread, so the reply is another top-level issue comment. The
// caller puts the permalink in the body; this function does not guess one.
export async function postIssueTriageComment(input: {
  operatorRoot: string;
  pr: number;
  body: string;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const result = await gh(
    input.operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${input.pr}/comments`,
      "-F",
      "body=@-",
    ],
    input.body,
    input.spawnFn,
  );
  if (!result.ok) {
    throw new CliError(
      `gh api (post triage issue comment) failed: ${result.stderr.trim()}`,
    );
  }
  return parsePostedCommentId(result.stdout, "triage issue comment");
}

export type ResolveThreadOutcome =
  | "resolved"
  | "already-resolved"
  | "not-found";

// One more `}` than the first live query: 7 opens (query / repository /
// pullRequest / reviewThreads / nodes / comments / nodes) need 7 closes.
// Live W1 triage on pr-hero #34 failed with
// `Expected NAME, actual: (none) ("") at [1, 202]` — GraphQL reaching EOF
// on the last brace, which was one short. Variable names are `repoOwner` /
// `repoName` so they cannot collide with `gh -f name=` interpolating `$name`
// inside the query document.
const REVIEW_THREADS_QUERY =
  "query($repoOwner:String!,$repoName:String!,$number:Int!){" +
  "repository(owner:$repoOwner,name:$repoName){pullRequest(number:$number){" +
  "reviewThreads(first:100){nodes{id isResolved comments(first:1){" +
  "nodes{fullDatabaseId}}}}}}}";

const RESOLVE_THREAD_MUTATION =
  "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){" +
  "thread{isResolved}}}";

// Fake-gh tests never send the document to GitHub, so they cannot catch a
// truncated query. Live W1 on #34 failed with GraphQL EOF
// (`Expected NAME, actual: (none) ("")`) because REVIEW_THREADS_QUERY was
// one `}` short. Count here, before spawn.
function assertBalancedGraphql(document: string, what: string): void {
  const opens = (document.match(/{/g) ?? []).length;
  const closes = (document.match(/}/g) ?? []).length;
  if (opens !== closes) {
    throw new CliError(
      `gh api graphql (${what}) query is unbalanced: ${opens} { vs ${closes} }`,
    );
  }
}

interface RepoOwnerName {
  owner: string;
  name: string;
}

async function ghRepoOwnerName(
  operatorRoot: string,
  spawnFn?: typeof Bun.spawn,
  timeoutMs?: number,
): Promise<RepoOwnerName> {
  const result = await gh(
    operatorRoot,
    ["repo", "view", "--json", "owner,name"],
    undefined,
    spawnFn,
    timeoutMs,
  );
  if (!result.ok) {
    throw new CliError(`gh repo view failed: ${result.stderr.trim()}`);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CliError(
      "gh repo view --json owner,name returned invalid JSON: " +
        result.stdout.slice(0, 120),
    );
  }
  const record = parsed as { name?: unknown; owner?: unknown };
  const name = record.name;
  const owner =
    typeof record.owner === "object" && record.owner !== null
      ? (record.owner as { login?: unknown }).login
      : undefined;
  if (typeof name !== "string" || name.length === 0) {
    throw new CliError("gh repo view returned no repository name");
  }
  if (typeof owner !== "string" || owner.length === 0) {
    throw new CliError("gh repo view returned no repository owner");
  }
  return { owner, name };
}

function graphqlDatabaseId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

interface GraphQlThread {
  id: string;
  isResolved: boolean;
  comments: { nodes: { fullDatabaseId: unknown }[] };
}

function parseReviewThreads(stdout: string): GraphQlThread[] {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError(
      "gh api graphql (reviewThreads) returned invalid JSON: " +
        stdout.slice(0, 120),
    );
  }
  const nodes = (
    parsed as {
      data?: {
        repository?: {
          pullRequest?: { reviewThreads?: { nodes?: unknown } };
        };
      };
    } | null
  )?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) {
    throw new CliError(
      "gh api graphql (reviewThreads) returned no thread list",
    );
  }
  return nodes as GraphQlThread[];
}

// Map a REST review-comment id to its GraphQL review thread and resolve it.
// Idempotent: an already-resolved thread is a skip, not an error. A comment
// with no thread (deleted, or outside the first 100 threads) is not-found
// — the caller logs and still treats the reply post as success.
export async function resolveReviewThreadForComment(input: {
  operatorRoot: string;
  pr: number;
  commentId: number;
  spawnFn?: typeof Bun.spawn;
  // Applied to EVERY gh call this function makes — the repo lookup and both
  // graphql round trips. A bound on two of three still hangs on the third.
  timeoutMs?: number;
}): Promise<ResolveThreadOutcome> {
  assertBalancedGraphql(REVIEW_THREADS_QUERY, "reviewThreads");
  assertBalancedGraphql(RESOLVE_THREAD_MUTATION, "resolveReviewThread");
  const repo = await ghRepoOwnerName(
    input.operatorRoot,
    input.spawnFn,
    input.timeoutMs,
  );
  const listed = await gh(
    input.operatorRoot,
    [
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `repoOwner=${repo.owner}`,
      "-f",
      `repoName=${repo.name}`,
      "-F",
      `number=${input.pr}`,
    ],
    undefined,
    input.spawnFn,
    input.timeoutMs,
  );
  if (!listed.ok) {
    throw new CliError(
      `gh api graphql (reviewThreads) failed: ${listed.stderr.trim()}`,
    );
  }
  const thread = parseReviewThreads(listed.stdout).find((candidate) => {
    const first = candidate.comments?.nodes?.[0]?.fullDatabaseId;
    return graphqlDatabaseId(first) === input.commentId;
  });
  if (thread === undefined) return "not-found";
  if (thread.isResolved) return "already-resolved";
  const mutated = await gh(
    input.operatorRoot,
    [
      "api",
      "graphql",
      "-f",
      `query=${RESOLVE_THREAD_MUTATION}`,
      "-f",
      `id=${thread.id}`,
    ],
    undefined,
    input.spawnFn,
    input.timeoutMs,
  );
  if (!mutated.ok) {
    throw new CliError(
      `gh api graphql (resolveReviewThread) failed: ${mutated.stderr.trim()}`,
    );
  }
  return "resolved";
}

// Re-export for callers that already import check-run constants from pr.ts.
export { ADMISSION_CHECK_RUN_NAME };

const ADMISSION_CHECK_RUN_TIMEOUT_MS = 15_000;

function admissionCheckRunConclusion(
  status: AdmissionAttemptStatus,
): "success" | "failure" | "neutral" | "cancelled" | "skipped" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    // Explicit, never left to `default`: standing down for a review already
    // in flight is not a failure, and GitHub renders `skipped` as grey rather
    // than red on the PR (musive #1935 showed a red check for exactly this).
    case "yielded":
      return "skipped";
    // #326: a size or budget gate skip. It was `skipped` (grey) before the
    // status split, so it stays grey; `neutral` would change how the PR reads.
    case "gate-skipped":
      return "skipped";
    default:
      return "neutral";
  }
}

function admissionCheckRunStatus(
  status: AdmissionAttemptStatus,
): "queued" | "in_progress" | "completed" {
  if (
    status === "reserved" ||
    status === "provider-started" ||
    status === "unknown"
  ) {
    return "in_progress";
  }
  return "completed";
}

function parseAdmissionCheckRunRow(line: string): AdmissionRecord | null {
  if (line.trim() === "") return null;
  try {
    const row = JSON.parse(line) as {
      id?: number;
      name?: string;
      status?: string;
      output?: { text?: string | null };
    };
    if (row.name !== ADMISSION_CHECK_RUN_NAME) return null;
    const text = row.output?.text;
    if (typeof text !== "string") return null;
    return parseAdmissionRecord(text);
  } catch {
    return null;
  }
}

// Authoritative durable ledger for CI admission attempts on a ref. Fail-open:
// a missing `checks: read` scope must not abort a review that already passed
// the pure admission gate — an empty read underestimates attempts (more spend,
// never silent skip).
//
// `includeHistory` adds `filter=all`. GitHub's check-runs endpoint defaults to
// `filter=latest`, which returns only the newest check run per name. Every
// admission attempt on a head is its own check run with the same name, so the
// default hides all earlier attempts on that head. A per-head read that decides
// whether a workflow run spent (countableWorkflowHeads) needs that history: a head
// with `[completed, gate-skipped]` would otherwise look like `[gate-skipped]` and
// be dropped. Leave it off for a read that wants current state. The request stays
// paginated (`--paginate`), so every page of history is read.
export async function listAdmissionCheckRuns(
  operatorRoot: string,
  ref: string,
  options?: { spawnFn?: typeof Bun.spawn; includeHistory?: boolean },
): Promise<AdmissionRecord[]> {
  if (!isFullCommitId(ref) && ref.trim().length === 0) return [];
  const historyQuery = options?.includeHistory === true ? "?filter=all" : "";
  try {
    const result = await gh(
      operatorRoot,
      [
        "api",
        `repos/{owner}/{repo}/commits/${ref}/check-runs${historyQuery}`,
        "--paginate",
        "--jq",
        `.check_runs[] | select(.name == "${ADMISSION_CHECK_RUN_NAME}") | {id: .id, name: .name, status: .status, output: {text: .output.text}}`,
      ],
      undefined,
      options?.spawnFn,
      ADMISSION_CHECK_RUN_TIMEOUT_MS,
    );
    if (!result.ok) return [];
    const records: AdmissionRecord[] = [];
    for (const line of result.stdout.split("\n")) {
      const record = parseAdmissionCheckRunRow(line);
      if (record !== null) records.push(record);
    }
    return records;
  } catch {
    return [];
  }
}

export async function upsertAdmissionCheckRun(
  operatorRoot: string,
  input: {
    headSha: string;
    record: AdmissionRecord;
    checkRunId?: number;
  },
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<number> {
  if (!isFullCommitId(input.headSha)) {
    throw new CliError(
      `admission check run: head sha is not a full 40-char id: ${input.headSha.slice(0, 16)}`,
    );
  }
  const serialized = serializeAdmissionRecord(input.record);
  const checkStatus = admissionCheckRunStatus(input.record.status);
  const args = [
    "api",
    "--method",
    input.checkRunId === undefined ? "POST" : "PATCH",
    input.checkRunId === undefined
      ? "repos/{owner}/{repo}/check-runs"
      : `repos/{owner}/{repo}/check-runs/${input.checkRunId}`,
    "-f",
    `name=${ADMISSION_CHECK_RUN_NAME}`,
    "-f",
    `head_sha=${input.headSha}`,
    "-f",
    `external_id=${input.record.reservationId}`,
    "-f",
    `status=${checkStatus}`,
    "-f",
    "output[title]=pr-hero CI admission",
    "-f",
    `output[summary]=${input.record.status} (attempt ${input.record.attemptNumber})`,
    "-f",
    `output[text]=${serialized}`,
  ];
  if (checkStatus === "completed") {
    args.push(
      "-f",
      `conclusion=${admissionCheckRunConclusion(input.record.status)}`,
    );
  }
  let lastStderr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await gh(
      operatorRoot,
      args,
      undefined,
      options?.spawnFn,
      ADMISSION_CHECK_RUN_TIMEOUT_MS,
    );
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.stdout) as { id?: number };
        if (typeof parsed.id === "number") return parsed.id;
      } catch {
        if (input.checkRunId !== undefined) return input.checkRunId;
      }
      throw new CliError(
        "gh api upserted an admission check run but returned no check run id",
      );
    }
    lastStderr = result.stderr.trim();
  }
  throw new CliError(`gh api (admission check run) failed: ${lastStderr}`);
}

// ---------------------------------------------------------------------------
// Inline review surface orchestration (ROADMAP B6, WU6) — the ONLY place
// that composes pr/inline.ts's pure plan with this module's own I/O
// primitives into the actual post sequence. Shared verbatim by reviewPr's
// step 14 (a review that just finished) and postCommand (a review read off
// disk, src/commands/post.ts): the SAME code posts either way, because a finding does not
// know or care whether it came from a fresh run or a `--from <run-dir>`
// replay. Extracted from cli.ts (cli-decomp S2, Cluster C).
//
// `spawnFn` is the same invisible-to-production seam this module's other B6
// functions already use (see gh()'s WHY comment above) — threaded through
// here so test/pr/inline-post.test.ts can drive the WHOLE sequence, including
// the summary PATCH, through one shared fake gh.
// ---------------------------------------------------------------------------

// Fetch + anchor + plan, with NO posting — the exact subset `post --dry-run`
// needs (spec "Dry-run from a prior run directory": a read-only comment
// fetch, zero mutating HTTP calls) and the first half of postInlineFindings,
// factored out so the two never compute two different plans for the same
// state.
export async function resolveInlinePostPlan(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  doc: FindingsDocument;
  diffPatch: string;
  spawnFn?: typeof Bun.spawn;
}): Promise<{
  plan: PostPlan;
  previousHeadSha: string | undefined;
  // Whether a marked summary comment already exists on the PR — threaded
  // through so postInlineFindings knows whether to CREATE the summary up
  // front (design rework: create-first fixes the summary's position in the
  // timeline; see postInlineFindings's own WHY) or leave a pre-existing one
  // alone until the closing PATCH.
  existingSummaryId: number | null;
  summaryBody: string | null;
  // The FULL finding list the plan matched against — threaded through to
  // postPrReview's 422 recovery so it can re-match with the SAME finding
  // set the plan used, never a narrower one (CRIT-A, verify-report-pr3
  // #3305: re-matching a subset can dissolve a tie the plan already
  // resolved). See ReviewSubmissionOutcome's WHY in pr/pr.ts.
  findingRefs: PrHeroFindingRef[];
  posted: PostedFindingComment[];
}> {
  const issueComments = await fetchPrComments(input.operatorRoot, input.pr, {
    spawnFn: input.spawnFn,
    timeoutMs: POSTING_GH_TIMEOUT_MS,
  });
  const existingSummaryId = findMarkedCommentId(issueComments);
  const summaryBody = summaryBodyForId(issueComments, existingSummaryId);
  const previousHeadSha =
    summaryBody === null
      ? undefined
      : (parseMarkerHead(summaryBody) ?? undefined);
  const posted = await fetchPostedFindingComments(
    input.operatorRoot,
    input.pr,
    { spawnFn: input.spawnFn, timeoutMs: POSTING_GH_TIMEOUT_MS },
  );
  const anchors = parseHunkAnchors(input.diffPatch);
  const findingRefs: PrHeroFindingRef[] = input.doc.findings.map((f) => {
    const ref = {
      id: f.id,
      path: f.path,
      line: f.line,
      claim: f.claim,
      tier: f.tier,
      proof_refs: f.proof_refs,
    };
    // Resolve here, not only inside buildPostPlan: postPrReview's 422
    // rematch uses this same list as `allFindings`, and CRIT-A requires
    // that rematch to see the SAME lines the plan matched against. A
    // re-anchored 544→938 finding compared at 544 against a comment stored
    // at 938 would miss the persist and duplicate. Original order is
    // load-bearing (a persist-first reorder dissolves the CRIT-A tie).
    const postLine = resolvePostLine(ref, anchors);
    return postLine === undefined ? ref : { ...ref, line: postLine };
  });
  const plan = buildPostPlan({
    findings: findingRefs,
    anchors,
    posted,
    headSha: input.headSha,
  });
  return {
    plan,
    previousHeadSha,
    existingSummaryId,
    summaryBody,
    findingRefs,
    posted,
  };
}

function summaryBodyForId(
  comments: { id: number; body: string }[],
  summaryId: number | null,
): string | null {
  if (summaryId === null) return null;
  return comments.find((c) => c.id === summaryId)?.body ?? null;
}

// A finding's own posted comment, as a clickable link for the summary's
// index (Juanma's PR #2 feedback: each index line links to its own
// comment). GitHub's fragment conventions for the two comment families
// differ — a REVIEW (inline) comment anchors on `#discussion_r<id>`, a
// top-level issue comment on `#issuecomment-<id>` — so the channel the
// comment actually landed in decides the shape, never guessed from one.
function findingCommentUrl(
  webUrl: string,
  pr: number,
  channel: "review" | "issue",
  id: number,
): string {
  const fragment =
    channel === "review" ? `discussion_r${id}` : `issuecomment-${id}`;
  return `${webUrl}/pull/${pr}#${fragment}`;
}

// Watchdog for the verified-gone collapse loop's `gh` calls. Every LLM step
// in the pipeline is bounded by `stepTimeoutMs`; the collapse loop's two gh
// calls were the only awaits on the `--post` path with no bound at all, and
// an accepted-but-unanswered GitHub request there hangs `review --pr --post`
// forever — including an unattended `--yes` run launched by the watcher,
// where nothing is present to notice or ^C it. Two minutes is generous for a
// single REST/graphql round trip and still finite; the failure it converts is
// "hangs until someone kills it" → "one logged line, thread left open".
const COLLAPSE_GH_TIMEOUT_MS = 120_000;

// The bound on every gh call the findings POST makes: the summary create and
// PATCH, the review submission and its 422 recovery reads, the pre-POST head
// re-read, and the reads around them. WHY 120 s: the POST runs after the review
// has already finished, so a slow GitHub answer for a large review still lands
// well inside it. WHY a bound at all (F004, PR #330): an accepted-but-unanswered
// call parked publishRunOutcome forever, and the pending commit status with it.
// A timeout fails exactly like a non-zero gh exit, so the posting catch records
// the step error and the publisher reports it. WHY no retry: a timed-out POST
// may already have landed, and a retry would duplicate the review. A local
// `pr-hero review --pr N --post` runs this same code, so it now also fails after
// 120 s instead of hanging. That is intended.
export const POSTING_GH_TIMEOUT_MS = 120_000;

// The actual post sequence (design D6, reordered per Juanma's PR #2
// feedback item 2; W2 issues #16/#17 retire the issue-comment loop):
// summary CREATED FIRST when none exists yet → review submission (with
// 422 recovery into the summary Outside Diff bucket) → summary PATCHED
// LAST with the final delta, comment links, and the Outside Diff union.
// NO `sessionFailed` awareness here — same contract as this module's own
// primitives (see postPrReview's own WHY): the guard belongs to the
// caller that decides whether to invoke this at all (postInlineIfEligible,
// below).
//
// WHY create-first: the summary was landing BELOW every finding in the
// Conversation timeline (real posted evidence: review comments 13:12:43,
// summary 13:12:45) because it was created LAST. Creation order fixes a
// comment's position; a PATCH never moves it. So on a PR with no summary
// yet, this posts a placeholder summary — the full index, the PLANNED
// Outside Diff bucket (known before any write), and the PLANNED delta,
// just without per-finding review-comment links (they do not exist yet)
// — as the FIRST write of the run, then patches it again at the end with
// the ACTUAL delta, the links, and any 422-demoted findings that joined
// the bucket. On a re-run (a summary already exists), the early create is
// skipped entirely: that comment's position was already fixed by a
// PREVIOUS run, and creating again would either duplicate it or waste an
// API call patching it twice.
// The final PATCH's delta-must-describe-what-was-posted invariant (PR2
// verification, WARN-3) is unchanged — the placeholder is provisional, the
// closing PATCH is authoritative, same as before this rework.

// One wording PER refusal, each said by both the post sequence's precondition
// and `post --dry-run`'s preview of it. The preview and the post disagreeing
// about whether a run dir may be published is the failure the whole $0-gate
// suite exists to prevent, and two hand-written messages is how that starts.
export function missingRereviewBlockMessage(
  pr: number,
  summaryId: number,
): string {
  return (
    `PR #${pr} already carries a pr-hero summary (comment ${summaryId}), so ` +
    "this post is a re-review — but the run directory carries no `rereview` " +
    "block in its pipeline.json, so the summary would report the old " +
    'absence matcher\'s "N resolved" and write no state block. Re-run ' +
    `\`pr-hero review --pr ${pr} --post\` instead.`
  );
}

// The same rule read in the other direction. Same shared-wording reason, and
// it names the mismatch specifically: the run dir describes a re-review of a
// summary the PR no longer has.
export function vanishedPriorSummaryMessage(pr: number): string {
  return (
    "The run directory carries a `rereview` block in its pipeline.json, so " +
    `this post is a re-review — but PR #${pr} no longer carries a pr-hero ` +
    "summary comment for it to be a re-review OF. Its `live[]` rows, " +
    "`resolved_ids` and `R###` numbering all name review threads the PR has " +
    "no record of, so this would publish a brand new summary claiming a " +
    `delta against a review that is not there. Re-run \`pr-hero review --pr ` +
    `${pr} --post\` instead.`
  );
}

// The `--pr --post` half of the same state (see the guard's WHY below): that
// caller does not refuse, it drops the re-review framing and says so. Loud on
// purpose — an operator who sees a first-review comment where a delta was
// expected must be able to read WHY off the run log instead of suspecting the
// re-review silently broke. A silent downgrade would be the same class of
// defect as a guard that never fires.
function vanishedPriorSummaryDegradedMessage(pr: number): string {
  return (
    "warning: the pr-hero summary comment this re-review was computed " +
    `against is gone from PR #${pr} — deleted, or never re-findable, while ` +
    "the review ran. Its `live[]` rows and `R###` ids name review threads " +
    "the PR has no record of, so this post drops the re-review framing: no " +
    "`Δ since` delta, no `Still live:` list and no state block. The findings " +
    "themselves are published, as the first review of what the PR carries " +
    `now. Re-run \`pr-hero review --pr ${pr} --post\` if you want a full ` +
    "re-review against the PR's current state."
  );
}

export async function postInlineFindings(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  doc: FindingsDocument;
  diffPatch: string;
  webUrl: string | undefined;
  spawnFn?: typeof Bun.spawn;
  rereview?: RereviewProvenance;
  rereviewPriors?: readonly {
    id: string;
    claim: string;
    locs: readonly string[];
  }[];
  // Watchdog for the collapse loop's gh calls. A seam, like `spawnFn`: no
  // production caller sets it, the tests drive the timeout path with it.
  ghTimeoutMs?: number;
  // S4: the CI mode the summary comment's disclaimer follows. Omitted is
  // advisory: the local `post` command, and every caller that never sets it.
  ciMode?: CiMode;
  // Set ONLY by `post --from` (`runPostCommand`). A PR that already carries a
  // pr-hero summary is by definition a re-review, so publishing it without a
  // `rereview` block renders the absence-matcher delta ("N resolved") and no
  // state block — the PR 1759 shape, observed live on PR #49. That caller
  // reconstructs the block from the run's `pipeline.json` and cannot see the
  // PR, so it asks the sequence owner — which has just read the comments — to
  // enforce the precondition and refuse before any write.
  //
  // A flag rather than an unconditional invariant, for two reasons that are
  // not stylistic — and BOTH of them are about this direction only, a
  // `rereview` block that is ABSENT. The `--pr --post` path computes its own
  // case from the same comments and reaches `rereview === undefined` only in
  // case A (no summary head AND no finding markers), so the check is
  // structurally dead there — except in one race, a summary created by a
  // concurrent run between this run's phase-B fetch and this one, where
  // aborting a review that has already been paid for would be the wrong
  // direction of error. And the existing postInlineFindings suites script
  // prior summaries with no block on purpose; the flag keeps this a
  // `post --from` rule, not a rewrite of what a first-review post means.
  //
  // Neither reason survives the trip to the OPPOSITE direction — a `rereview`
  // block whose summary has vanished — which is why that case carries its own
  // flag below instead of riding on this one. Gating it here is precisely
  // what left it structurally dead on `--pr --post`, the primary path.
  requireRereviewOnPriorSummary?: boolean;
  // Also set ONLY by `post --from` (`runPostCommand`), and deliberately NOT
  // the mirror of the flag above: unset, the vanished-summary case degrades
  // rather than passing. The two callers meet the same state having paid very
  // different prices for it — see the guard's own WHY below.
  refuseOnVanishedPriorSummary?: boolean;
}): Promise<InlinePostOutcome> {
  const { operatorRoot, pr, headSha, doc, webUrl, spawnFn } = input;
  const ghTimeoutMs = input.ghTimeoutMs ?? COLLAPSE_GH_TIMEOUT_MS;
  const {
    plan,
    previousHeadSha,
    existingSummaryId,
    summaryBody,
    findingRefs,
    posted,
  } = await resolveInlinePostPlan(input);
  const previousState =
    summaryBody === null ? null : parseStateBlock(summaryBody);
  const postedReviewCount = nextStateReviewCount({
    existingSummaryId,
    state: previousState,
    summaryBody,
  });

  // Before the create-first POST and before the review submission — the last
  // point at which refusing costs nothing. Keyed on `existingSummaryId`, not
  // on `previousHeadSha`: a summary whose `head=` will not parse is still a
  // prior review, and rendering the matcher delta over it is still the lie.
  if (
    input.requireRereviewOnPriorSummary === true &&
    input.rereview === undefined &&
    existingSummaryId !== null
  ) {
    throw new CliError(missingRereviewBlockMessage(pr, existingSummaryId));
  }

  // The mirror STATE, at the same point — and deliberately NOT the mirror
  // ANSWER. The run dir CAN carry a valid `rereview` block while the summary
  // it was computed against is gone from the PR: deleted mid-run (the window
  // is real — the comments are read in phase B, the pipeline then runs 8-25
  // minutes), or `post --from` run long after `review`, which this seam
  // deliberately allows. Then `existingSummaryId === null` falls into the
  // create-first branch below and, left alone, `renderBody`/`overlayDelta`
  // publish a BRAND NEW comment full of re-review vocabulary sourced from a
  // stale directory: a delta counted in `unconfirmed`/`carried`, a `Still
  // live:` list of `R###` ids, a state block — none of it naming a thread
  // that exists.
  //
  // The two callers meet that state having paid very different prices, so
  // they answer it differently ON PURPOSE. Only `post --from` sets
  // `refuseOnVanishedPriorSummary`:
  //   - `post --from` REFUSES. Nothing has been spent; the operator re-runs
  //     `review --pr <n> --post` and gets a correct result for free.
  //   - `--pr --post` has ALREADY paid for a full review ($2.49-$6.34 on this
  //     repo). Throwing that away to avoid a stale framing is the wrong
  //     direction of error — the very rule the flag above cites. So it posts,
  //     with the re-review framing DROPPED (`framing` below): no delta
  //     overlay, no `Still live:`, no state block. That is not a downgrade of
  //     the findings, it is an accurate description of what the run now is —
  //     the review this one was a re-review OF is no longer on the PR, so
  //     what remains is a first review of the current state, and the findings
  //     are as valid as they were a minute ago. The degradation is LOGGED,
  //     never silent: a quiet downgrade would be the same class of defect as
  //     a guard that never fires, which is exactly what this one was while it
  //     hung off `requireRereviewOnPriorSummary`.
  //
  // Narrowed to `summary_marker` on purpose: a block whose L came from
  // `finding_markers` was ALREADY computed with no summary in sight, so a
  // missing summary at post time is agreement, not drift — and its R### ids
  // name finding threads that do still exist. Refusing OR degrading there
  // would break obligation S-A ("with the summary comment absent, L is
  // recovered from per-finding markers and the run does NOT fall to
  // first-review semantics"), which is a case the design supports rather
  // than a hazard.
  const priorSummaryVanished =
    input.rereview?.last_head_source === "summary_marker" &&
    existingSummaryId === null;
  if (priorSummaryVanished && input.refuseOnVanishedPriorSummary === true) {
    throw new CliError(vanishedPriorSummaryMessage(pr));
  }
  if (priorSummaryVanished) log(vanishedPriorSummaryDegradedMessage(pr));

  // Every re-review-framed surface reads off THIS, never `input.rereview`
  // directly — the delta overlay, the `Still live:` list it carries, and the
  // state block appended after the report marker. The collapse loop at the
  // bottom deliberately does NOT: a verified-gone prior's ✅ reply and thread
  // resolve are bound to per-finding REVIEW threads, which the summary
  // comment's disappearance says nothing about, and `--pr --post` binds them
  // through priors it is still holding in memory. Suppressing those would
  // leave a thread that IS gone sitting open on the PR.
  const framing = priorSummaryVanished ? undefined : input.rereview;
  const rereviewDelta =
    framing === undefined
      ? undefined
      : rereviewDeltaFromProvenance(framing, doc.findings.length);
  const overlayDelta = (delta: PrCommentDelta): PrCommentDelta =>
    rereviewDelta === undefined ? delta : { ...delta, rereview: rereviewDelta };
  const byId = new Map(doc.findings.map((f) => [f.id, f]));
  const findingsFor = (refs: PrHeroFindingRef[]): Finding[] =>
    refs
      .map((ref) => {
        const found = byId.get(ref.id);
        if (found === undefined) return undefined;
        // The planner may have moved `line` onto a hunter-cited in-diff
        // proof_ref (Musive #1727). GitHub's `line` and the finding marker
        // must share that post line or a re-run duplicates. findings.json
        // keeps the original line; only the posted comment is overlaid.
        return found.line === ref.line ? found : { ...found, line: ref.line };
      })
      .filter((f): f is Finding => f !== undefined);

  // Initial Outside Diff set: plan.issueComments stays the un-anchorable
  // bucket (field name unchanged this slice). Known before any write, so
  // the create-first POST already includes it — after the review, the
  // closing PATCH may grow it with 422-demoted findings.
  const plannedOutsideDiff = findingsFor(plan.issueComments);

  // The state block is merged ONCE, here, and both writes append the same
  // string, so the create-first POST and the closing PATCH cannot disagree
  // about which rows exist or what their ids are. Its budget is derived from
  // the POST-shaped body, the one body known before any write (see
  // stateBlockBudget). The findings are read off the same resolved refs the
  // plan posted from, so a fresh row's locs name the line the comment sits on.
  const lineById = new Map(findingRefs.map((ref) => [ref.id, ref.line]));
  const freshChannel = (id: string): FindingChannel =>
    plan.issueComments.some((f) => f.id === id) ||
    plan.persisting.some(
      (match) => match.finding.id === id && match.posted.channel === "issue",
    )
      ? "outside"
      : "inline";
  const freshFindings: FreshStateFinding[] = doc.findings.map((f) => ({
    path: f.path,
    line: lineById.get(f.id) ?? f.line,
    proof_refs: f.proof_refs,
    tier: f.tier,
    severity: f.severity,
    claim: f.claim,
    channel: freshChannel(f.id),
  }));
  const referenceBody = renderPrComment(
    doc,
    webUrl,
    overlayDelta({ ...plan.delta, previousHeadSha }),
    plannedOutsideDiff,
    undefined,
    undefined,
    input.ciMode,
  );
  const merged =
    framing === undefined
      ? undefined
      : mergeStateFindings({
          headSha: doc.head_sha,
          reviews: postedReviewCount,
          live: framing.live,
          previous: previousState,
          retiredIds: [
            ...(framing.resolved_ids ?? []),
            ...(framing.worsened ?? []).map((w) => w.priorId),
          ],
          fresh: freshFindings,
          stateBudget: stateBlockBudget(referenceBody.length),
        });

  const renderBody = (
    delta: PrCommentDelta,
    outside: readonly Finding[],
    moved: string | undefined,
    urls?: ReadonlyMap<string, string>,
  ): string => {
    const body = renderPrComment(
      doc,
      webUrl,
      overlayDelta(delta),
      outside,
      moved,
      urls,
      input.ciMode,
    );
    if (merged === undefined) {
      const counts = tierCountsFromFindings(
        canonicalAdmissionFindings(doc.findings),
      );
      return `${body}${renderCiAdmissionBlock(doc.head_sha, counts, postedReviewCount)}`;
    }
    // The drop line sits right above the state block it accounts for. Empty
    // when the cap dropped nothing.
    const note = droppedStateNote(merged.dropped);
    const noteLine = note === "" ? "" : `${note}\n`;
    return `${body}${noteLine}${renderStateBlock(doc.head_sha, merged.rows, postedReviewCount, merged.hw)}`;
  };

  // The id this run's own creation just returned, if any — threaded to the
  // closing PATCH below so it updates THIS comment directly rather than
  // re-discovering it by marker (postPrComment's `knownCommentId`; see its
  // own WHY).
  let summaryCommentId = existingSummaryId;
  if (existingSummaryId === null) {
    const plannedDelta: PrCommentDelta = { ...plan.delta, previousHeadSha };
    const created = await postPrComment(
      operatorRoot,
      pr,
      // `movedHeadSha: undefined` — the re-read has not happened yet, and it
      // deliberately does not happen before this write. Same shape as the
      // absent link map above: the placeholder is provisional, the closing
      // PATCH is authoritative, and the re-read belongs as close to the
      // ANCHOR-BEARING call as it can get, not one write earlier.
      renderBody(plannedDelta, plannedOutsideDiff, undefined),
      spawnFn,
    );
    summaryCommentId = created.commentId;
  }

  const reviewFindings = findingsFor(plan.reviewComments);
  const reachedIds = new Set<string>();

  // GitHub #39 — the head re-read, HERE and not inside postPrReview, for one
  // reason that is not stylistic: postPrReview returns early on zero
  // anchorable findings without touching gh at all (spec "Zero anchorable
  // findings"), and a run with nothing to anchor STILL publishes a summary
  // comment — the ✅ clean bill included. That summary read against a head
  // the PR has since moved past is the same undisclosed staleness the issue
  // is about, so the check belongs to the sequence owner, which posts on
  // every path, rather than to the primitive that sometimes does not.
  //
  // Immediately before the review submission: this is the tightest window
  // available around the anchor-bearing call, and the window is the whole
  // point — a check run minutes earlier would answer a question about a
  // different moment. The comparison happens exactly ONCE, here, and both
  // surfaces render the same answer; deriving it twice is how two surfaces
  // start disagreeing about whether the PR moved.
  //
  // Never aborts, never filters, never re-runs anything. What a re-review
  // should DO about findings computed on a stale head is ROADMAP item 7's
  // design work, and with `commit_id` pinned (pr/pr.ts) the answer here
  // collapses to a sentence: post, pinned, and say which commit this is
  // about. Silently dropping the post would be the invisible loss this
  // project's direction-of-error rule ranks worst.
  const liveHeadSha = await ghPrHeadSha(operatorRoot, pr, { spawnFn });
  const movedHeadSha =
    liveHeadSha !== undefined && liveHeadSha !== headSha
      ? liveHeadSha
      : undefined;

  const reviewResult = await postPrReview({
    operatorRoot,
    pr,
    headSha,
    findings: reviewFindings,
    // The FULL finding list, not just `reviewFindings` — see
    // ReviewSubmissionOutcome's WHY in pr/pr.ts (CRIT-A, verify-report-pr3
    // #3305). This is exactly the line a caller could silently narrow and
    // reintroduce the tie-dissolution bug; test/cli.test.ts's tie-repro
    // fails if this is ever swapped back to `reviewFindings`.
    allFindings: findingRefs,
    webUrl,
    spawnFn,
  });
  // On 422, reviewResult.findings JOIN the Outside Diff set instead of
  // posting as issue comments (issues #16/#17). Dedupe by id so a finding
  // cannot appear twice if it somehow sat in both buckets.
  let outsideDiff = plannedOutsideDiff;
  if (reviewResult.outcome === "posted") {
    for (const finding of reviewFindings) reachedIds.add(finding.id);
  } else {
    const stillUnmatched = new Set(
      reviewResult.findings.map((finding) => finding.id),
    );
    for (const finding of reviewFindings) {
      if (!stillUnmatched.has(finding.id)) reachedIds.add(finding.id);
    }
    const already = new Set(outsideDiff.map((finding) => finding.id));
    outsideDiff = [
      ...outsideDiff,
      ...reviewResult.findings.filter((finding) => !already.has(finding.id)),
    ];
  }

  // Outside Diff findings reached the summary — they must not fire
  // droppedFindingIds. No rematch-before-POST: that block existed only to
  // prevent duplicate issue comments, and this slice posts none. Re-review
  // identity for the bucket is the next slice.
  for (const finding of outsideDiff) reachedIds.add(finding.id);

  // Receipt shape unchanged this slice: issue_comment_ids stays [].
  const issueCommentIds: number[] = [];

  const droppedFindingIds = computeDroppedFindingIds(
    [...plan.reviewComments, ...plan.issueComments],
    reachedIds,
  );

  const commentUrlByFindingId = await buildCommentUrlMap({
    operatorRoot,
    pr,
    headSha,
    webUrl,
    spawnFn,
    persisting: plan.persisting,
    issueIdByFindingId: new Map(),
    freshlyPostedReview:
      reviewResult.outcome === "posted" ? reviewFindings : [],
  });

  const delta: PrCommentDelta = { ...plan.delta, previousHeadSha };
  const patched = await postPrComment(
    operatorRoot,
    pr,
    renderBody(delta, outsideDiff, movedHeadSha, commentUrlByFindingId),
    spawnFn,
    summaryCommentId ?? undefined,
  );
  // `patched.action` is always "updated" once the create-first branch above
  // ran (this call PATCHes the comment it just created), which would report
  // a first-EVER run as "updated" — misleading to a human reading the log
  // or post.json. The outward-facing action names whether THIS RUN created
  // the summary at all (existingSummaryId was null before this run), not
  // which HTTP verb the LAST of its two calls happened to use.
  const summary = {
    action: existingSummaryId === null ? ("created" as const) : patched.action,
    commentId: patched.commentId,
  };

  if (input.rereview !== undefined) {
    const targets = collapseTargets({
      verifiedGoneIds: input.rereview.resolved_ids ?? [],
      priors: input.rereviewPriors ?? [],
      posted,
    });
    for (const target of targets) {
      if (target.channel !== "review") continue;
      // The reply is bounded AND caught, and a failure `continue`s past the
      // resolve on purpose. Resolving a thread whose ✅ reply never landed
      // closes the conversation with no explanation of why — a silent
      // resolve, which is the same false `resolved` the whole verified-gone
      // path is built to never produce. Degrading to "thread left open" is
      // always the safe direction: the finding stays visible on the PR.
      try {
        await postReviewCommentReply({
          operatorRoot,
          pr,
          inReplyTo: target.commentId,
          body:
            "✅ **RESOLVED** · verified gone\n\n" +
            "This finding was checked at the current head and is no longer present.\n",
          spawnFn,
          timeoutMs: ghTimeoutMs,
        });
      } catch (error) {
        log(
          `collapse skipped for ${target.priorId}: the verified-gone reply did ` +
            `not post (${error instanceof Error ? error.message : String(error)}) ` +
            "— thread left open",
        );
        continue;
      }
      try {
        const resolveOutcome = await resolveReviewThreadForComment({
          operatorRoot,
          pr,
          commentId: target.commentId,
          spawnFn,
          timeoutMs: ghTimeoutMs,
        });
        if (resolveOutcome === "resolved") {
          log(`resolved: review thread for ${target.priorId} (verified-gone)`);
        } else if (resolveOutcome === "already-resolved") {
          log(`resolved: thread already closed for ${target.priorId}`);
        } else {
          log(
            `resolve skipped: no review thread found for comment ${target.commentId}`,
          );
        }
      } catch (error) {
        log(
          `resolve failed for ${target.priorId} after the verified-gone reply posted: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Closes a RE-review with a visible comment. Everything above only PATCHed
  // the existing summary, and an edit is invisible on GitHub: no
  // notification, no move down the timeline. With zero new findings no
  // review is submitted either, so the PR looked untouched and a reader could
  // not tell "ran and found nothing" from "never ran". A first review needs
  // none: the summary it just created is already the new comment.
  //
  // Last, after the collapse loop, so it really is the closing word. Caught
  // AND bounded, like the collapse loop's reply: the review is already paid
  // for and published, so losing the receipt must never fail the run, and a
  // catch alone cannot stop a request that is accepted but never answered.
  // As the last await here, a hang would park the caller's receipt write
  // and teardown forever.
  let closingCommentId: number | undefined;
  if (existingSummaryId !== null) {
    try {
      closingCommentId = await postIssueCommentBody(
        operatorRoot,
        pr,
        renderRereviewClosedComment({
          headSha,
          delta: overlayDelta(delta),
          newPosted: reachedIds.size,
          totalFindings: doc.findings.length,
          runStatus: doc.run_status,
          summaryUrl:
            webUrl === undefined
              ? undefined
              : findingCommentUrl(webUrl, pr, "issue", existingSummaryId),
        }),
        spawnFn,
        ghTimeoutMs,
      );
      log(`posted: re-review closing comment ${closingCommentId}`);
    } catch (error) {
      log(
        "re-review closing comment did not post " +
          `(${error instanceof Error ? error.message : String(error)}) ` +
          "— the summary was still updated",
      );
    }
  }

  return {
    reviewOutcome: reviewResult.outcome,
    reviewFindingCount: reviewFindings.length,
    issueCommentIds,
    outsideDiffCount: outsideDiff.length,
    summary,
    delta: overlayDelta(plan.delta),
    droppedFindingIds,
    commentUrls: commentUrlByFindingId,
    movedHeadSha,
    ...(closingCommentId === undefined ? {} : { closingCommentId }),
  };
}

// Maps every CURRENTLY-live finding (persisting from a prior run, or
// freshly posted this run) to its own comment's URL, for the summary's
// closing PATCH (Juanma's PR #2 feedback: each index line links to its own
// comment). Two sources, none of which can be read off the plan alone:
//   - persisting matches already carry the prior comment's id/channel
//     (`plan.persisting`, from pr/inline.ts's matcher) — free, no extra fetch;
//     leftover W1 issue-comment orphans still resolve here via channel
//     "issue";
//   - fresh REVIEW comments' ids are NOT returned by `POST .../reviews` at
//     all (GitHub's response is the review object, not its comments[]), so
//     the only way to learn them is a follow-up read-only fetch, matched
//     back to a finding by the SAME marker fields the identity contract
//     already uses (path, line, this run's headSha, and the claim
//     fingerprint) — deterministic here because this run posted them
//     moments ago with exactly those fields.
// Fresh un-anchorable findings have no per-finding comment (issues #16/#17:
// they land in the summary Outside Diff section), so they contribute no
// url; the index line stays unlinked. `issueIdByFindingId` is kept so a
// leftover caller can still hand ids through; postInlineFindings passes
// an empty map.
// `webUrl === undefined` skips all of it: no repo web url means no comment
// URL is buildable, and renderPrComment already degrades to plain text when
// a finding's id is absent from the map, never a broken link.
async function buildCommentUrlMap(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  webUrl: string | undefined;
  spawnFn?: typeof Bun.spawn;
  persisting: PostPlan["persisting"];
  issueIdByFindingId: Map<string, number>;
  freshlyPostedReview: Finding[];
}): Promise<Map<string, string>> {
  const { operatorRoot, pr, headSha, webUrl, spawnFn } = input;
  const urls = new Map<string, string>();
  if (webUrl === undefined) return urls;
  for (const match of input.persisting) {
    urls.set(
      match.finding.id,
      findingCommentUrl(webUrl, pr, match.posted.channel, match.posted.id),
    );
  }
  for (const [findingId, id] of input.issueIdByFindingId) {
    urls.set(findingId, findingCommentUrl(webUrl, pr, "issue", id));
  }
  if (input.freshlyPostedReview.length > 0) {
    const freshReview = await fetchPrReviewComments(operatorRoot, pr, {
      spawnFn,
      timeoutMs: POSTING_GH_TIMEOUT_MS,
    });
    for (const finding of input.freshlyPostedReview) {
      const fingerprint = claimFingerprint(finding.claim);
      const match = freshReview.find((c) => {
        const marker = parseFindingMarker(c.body);
        return (
          marker !== null &&
          marker.path === finding.path &&
          marker.line === finding.line &&
          marker.headSha === headSha &&
          marker.c === fingerprint
        );
      });
      if (match) {
        urls.set(finding.id, findingCommentUrl(webUrl, pr, "review", match.id));
      }
    }
  }
  return urls;
}

// The `sessionFailed` guard (spec "sessionFailed suppresses all posting"):
// the single decision point for BOTH callers on whether to invoke
// postInlineFindings at all. `null` means "skipped, nothing was posted, zero
// HTTP calls were made" — the exact shape the spec's scenario asserts.
//
// Neither `requireRereviewOnPriorSummary` nor `refuseOnVanishedPriorSummary`
// is declared here, and that absence is the contract, not an oversight: this
// is the `--pr --post` entry point, the one that has already paid for a full
// review, and both flags exist to make `post --from` refuse where refusing is
// free. See their WHYs on postInlineFindings.
export async function postInlineIfEligible(input: {
  sessionFailed: boolean;
  skippedReason: string;
  operatorRoot: string;
  pr: number;
  headSha: string;
  doc: FindingsDocument;
  diffPatch: string;
  webUrl: string | undefined;
  spawnFn?: typeof Bun.spawn;
  rereview?: RereviewProvenance;
  rereviewPriors?: readonly {
    id: string;
    claim: string;
    locs: readonly string[];
  }[];
  // S4: the CI mode the summary's footer names. Omitted is advisory, which is
  // what the local `post` command gets.
  ciMode?: CiMode;
}): Promise<InlinePostOutcome | null> {
  if (input.sessionFailed) {
    log(input.skippedReason);
    return null;
  }
  return postInlineFindings(input);
}

// post.json — the receipt (design's File Changes table): channel, comment
// ids, demotions, mirroring pipeline.json's provenance role so the
// idempotency proof (WU7/4.4) can read back exactly what a run posted
// without re-deriving it from GitHub.
export async function writePostReceipt(
  runDir: string,
  pr: number,
  headSha: string,
  outcome: InlinePostOutcome,
): Promise<void> {
  const receipt = {
    pr,
    head_sha: headSha,
    generated_at: new Date().toISOString(),
    review: {
      outcome: outcome.reviewOutcome,
      finding_count: outcome.reviewFindingCount,
    },
    issue_comment_ids: outcome.issueCommentIds,
    summary_comment: outcome.summary,
    delta: outcome.delta,
    dropped_finding_ids: outcome.droppedFindingIds,
  };
  await Bun.write(
    path.join(runDir, "post.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}
