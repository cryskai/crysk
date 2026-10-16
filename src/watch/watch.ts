// The watcher's I/O shell (ROADMAP B3): config read, git/gh calls, the
// runs-root scan, the comment fetch, the lockfile, the append-only log, the
// review spawn, the macOS notification, and launchd install/uninstall —
// every side effect `pr-hero watch` needs. Same contract as cli.ts and
// pr/pr.ts: untested by construction, and every decision it acts on is a pure
// function in watch/preflight.ts (or compare/ledger.ts), where the tests live.
//
// The tick never daemonizes. launchd (or cron) is the supervisor and the
// scheduler; one invocation is one pass over the configured repos, at most
// one spawned review, then exit.

import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseComparisonJson } from "#compare/ledger";
import { git, resolveRepoRoot } from "#git/git";
import {
  fetchCommitStatuses,
  fetchPrComments,
  ghPrFiles,
  ghPrList,
  ghRepoWebUrl,
  postCommitStatus,
} from "#pr/pr";
import {
  commitStatusRequest,
  IN_FLIGHT_TTL_MS,
  isInFlightCommitStatus,
  LOCAL_COMMIT_STATUS_CONTEXT,
  latestStatusInContext,
  prHtmlUrl,
  RUN_STATUS_CONTEXTS,
} from "#pr/preflight";
import {
  type CliOptions,
  DEFAULT_WATCH_INTERVAL_MIN,
  type NumstatFile,
} from "#review/preflight";
import {
  DEFAULT_SIZE_GATE,
  evaluateSizeGate,
  evaluateSizeGateAggregate,
  type SizeGateConfig,
  sizeGateConfig,
} from "#review/size-gate";
import { runGc } from "#store/gc";
import {
  box,
  log,
  row,
  section,
  shortPath,
  shortSha,
  styleEnabled,
  terminalWidth,
} from "#ui/primitives";
import { selfInvocation } from "../assets";
import { CliError, CliUsageError } from "../errors";
import { resolveRepoHome } from "../home";
import type { IgnoreRule } from "../ignore-file";
import {
  type IgnoreFileReadResult,
  readLocalIgnoreRules,
} from "../ignore-read";
import {
  countAttempts,
  countLaunchedToday,
  decideTick,
  expandTilde,
  findingsTierCounts,
  lastLogActivity,
  latestRunDirName,
  launchedLine,
  localIsoTimestamp,
  logLine,
  markerCommentSeen,
  markerDeclaredHeads,
  osascriptNotifyArgs,
  outcomeLine,
  outcomeNotificationText,
  type PrheroHomePaths,
  parseLockPid,
  parsePipelineMeta,
  parsePlistInterval,
  parsePrFiles,
  parsePrList,
  parseWatchConfig,
  pendingReviewsToSettle,
  preLaunchExclusionVeto,
  prheroHomePaths,
  type ReviewOutcome,
  type RunDirFact,
  removeWatchRepo,
  renderWatchPlist,
  renderWatchStatus,
  skipLine,
  type TickDecision,
  type TickLaunch,
  type TickRepoFacts,
  tickGate,
  upsertWatchRepo,
  WATCH_LAUNCHD_LABEL,
  type WatchConfig,
} from "./preflight";

async function run(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

export async function watchCommand(options: CliOptions): Promise<number> {
  if (options.watch === "install") {
    return watchInstall(options.interval ?? DEFAULT_WATCH_INTERVAL_MIN);
  }
  if (options.watch === "uninstall") return watchUninstall();
  if (options.watch === "add") return watchAdd(options);
  if (options.watch === "remove") return watchRemove(options);
  if (options.watch === "status") return watchStatus();
  return watchOnce(options.dryRun);
}

// ---------------------------------------------------------------------------
// The tick.

// The DI seam gatherRepoFacts needs to be unit-testable (prheroignore Phase
// 6, design D6): one shape per I/O call it makes, mirroring RereviewGit's
// pattern (src/rereview/prepare.ts) rather than inventing a new one. Every
// OTHER I/O gatherRepoFacts touches — resolveRepoHome, scanRunDirs,
// fetchPrComments, fetchCommitStatuses — is left as real I/O on purpose: a
// candidate that clears the size gate reaches those unconditionally, and a
// throwaway tmpdir git repo already exercises resolveRepoHome/scanRunDirs
// faithfully offline (test/watch/watch.test.ts). Faking the comments/statuses
// fetch too would need a live-looking `gh` response for every eligible
// candidate an offline test can never safely construct, so test/watch/watch.test.ts
// deliberately never lets a fixture PR become eligible through
// gatherRepoFacts itself — see that file's own header comment.
export interface WatchIo {
  git: (
    repo: string,
    args: string[],
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  ghPrList: (repoRoot: string) => Promise<string>;
  ghPrFiles: (repoRoot: string, pr: number) => Promise<string>;
  readIgnoreFile: (root: string) => Promise<IgnoreFileReadResult>;
}

// Production wiring: the real subprocess/gh/fs calls this module already
// carries. Tests construct their own WatchIo (or a narrower Pick<...>) with
// scripted fakes instead.
const productionWatchIo: WatchIo = {
  git,
  ghPrList,
  ghPrFiles,
  readIgnoreFile: readLocalIgnoreRules,
};

export interface WatchedRepoFacts extends TickRepoFacts {
  // TickRepoFacts.path is the resolved toplevel; the runs root rides along
  // for the post-run outcome scan.
  runsRoot: string;
  // The repo's own size-gate thresholds, carried to the SPAWN. See the WHY
  // on the review args in runTick: the spawned CLI re-runs the gate on the
  // real numstat, and it must be told the same numbers this tick used.
  maxChangedLines: number;
  maxChangedFiles: number;
  // The MERGED exclude rules (builtins + this repo's own `.prheroignore`)
  // gatherRepoFacts already read and built via sizeGateConfig() — carried
  // alongside the two limits above so applyPreLaunchVeto can rebuild the
  // EXACT same SizeGateConfig without a second `.prheroignore` read.
  excludeRules: IgnoreRule[];
}

async function watchOnce(dryRun: boolean): Promise<number> {
  const paths = prheroHomePaths(os.homedir());
  if (!existsSync(paths.watchConfigPath)) {
    throw new CliError(
      `no watch config at ${paths.watchConfigPath} — the watcher reviews (and ` +
        "spends money on) exactly the repos listed there, so it refuses to " +
        "guess. Opt a repo in with `pr-hero watch add` (run inside the " +
        "repo, or with --repo <path>).",
    );
  }
  const config = parseWatchConfig(await Bun.file(paths.watchConfigPath).text());

  const now = new Date();
  const ts = localIsoTimestamp(now);
  const dayPrefix = ts.slice(0, 10);
  const localMinutes = now.getHours() * 60 + now.getMinutes();
  const logText = existsSync(paths.logPath)
    ? await Bun.file(paths.logPath).text()
    : "";
  const gateInput = {
    window: config.window,
    localMinutes,
    dailyCap: config.dailyCap,
    launchedToday: countLaunchedToday(logText, dayPrefix),
  };

  // The real tick checks the gate BEFORE any git or gh call: a closed
  // window or a spent cap must cost nothing, because launchd fires this
  // every N minutes all day. The dry run deliberately keeps going — its
  // whole point is the full picture.
  if (!dryRun) {
    const gate = tickGate(gateInput);
    if (gate !== "open") {
      await mkdir(paths.dir, { recursive: true });
      await appendLog(
        paths.logPath,
        logLine(
          ts,
          gate === "window-closed"
            ? `tick idle reason=window-closed window=${config.window?.start}-${config.window?.end}`
            : `tick idle reason=cap-reached launched=${gateInput.launchedToday} cap=${config.dailyCap}`,
        ),
      );
      return 0;
    }
    // The lockfile — advisory, PID-holding, stolen when dead. launchd is
    // already single-instance per label; this covers cron and hand-run
    // ticks overlapping a slow review.
    const holder = await lockHolder(paths.lockPath);
    if (holder !== null) {
      await mkdir(paths.dir, { recursive: true });
      await appendLog(
        paths.logPath,
        logLine(ts, `tick skipped reason=lock-held pid=${holder}`),
      );
      return 0;
    }
    await mkdir(paths.dir, { recursive: true });
    await Bun.write(paths.lockPath, `${process.pid}\n`);
  }

  try {
    if (!dryRun) {
      // Each `gh pr view` is bounded (GH_PR_VIEW_TIMEOUT_MS) so a stall
      // cannot pin watch.lock and silence every later tick.
      await runGc({ home: os.homedir(), dryRun: false });
    }
    const repos = await gatherRepoFacts(
      config,
      os.homedir(),
      productionWatchIo,
    );
    const decision = decideTick({ ...gateInput, repos });
    if (dryRun) {
      printDryRun(paths, config, gateInput.launchedToday, decision, repos);
      return 0;
    }
    return await runTick(paths, decision, repos, productionWatchIo.ghPrFiles);
  } finally {
    if (!dryRun) await rm(paths.lockPath, { force: true });
  }
}

// Reads everything the pure decision needs, per configured repo. Read-only
// throughout (gh api GETs, git rev-parse, artifact reads) — safe for the
// dry run by construction.
export async function gatherRepoFacts(
  config: WatchConfig,
  home: string,
  io: WatchIo,
): Promise<WatchedRepoFacts[]> {
  const repos: WatchedRepoFacts[] = [];
  for (const entry of config.repos) {
    const expanded = expandTilde(entry.path, home);
    const toplevel = await io.git(expanded, ["rev-parse", "--show-toplevel"]);
    if (!toplevel.ok) {
      throw new CliError(
        `watch.json repo ${entry.path} is not a git repository ` +
          `(${expanded}): ${toplevel.stderr.trim()}`,
      );
    }
    const repoRoot = toplevel.stdout.trim();
    const repoHome = await resolveRepoHome({
      home,
      operatorRoot: repoRoot,
      persist: false,
    });
    const runsRoot = repoHome.paths.runs;
    const runDirs = await scanRunDirs(runsRoot);
    const prs = parsePrList(await io.ghPrList(repoRoot));

    // The remote guard costs one gh call per PR, so it only runs for
    // candidates the free checks have not already killed — the pure
    // decision treats an unfetched PR as unguarded. "Free" depends on the
    // re-arm policy: under on_push only a SAME-head local review kills a
    // candidate, while the one-review-per-PR default is done after ANY
    // local review of that number (reviewed-prior-head from local facts
    // alone), so its comments fetch is skipped too.
    //
    // `.prheroignore` is read ONCE per repo, here, from the operator's own
    // working tree — never a base ref. This is NOT the CI base-ref case
    // (design D1-D3, cli.ts): CI reads from a ref the PR author cannot
    // influence because the PR author supplies the checkout being reviewed.
    // The watcher runs from an OPERATOR's own machine, against repos that
    // operator explicitly opted into `pr-hero watch add` — there is no PR
    // author supplying this checkout, so the operator's own working tree IS
    // the trusted source here, the same way local (non-CI) review already
    // treats it (O-8). Do not "harden" this into a base-ref read; that would
    // require a `gh`/git fetch per repo per tick this mode has no PR context
    // to anchor, and would re-break the CLI-mode-vs-watcher parity found by
    // pr-hero's own review of PR #204 (CRITICAL, blocking) — the reason
    // this fix exists at all. The merged rule set (builtins + this repo's
    // `.prheroignore`) is built through the SAME sizeGateConfig() the CLI
    // paths use, so the watcher's gate agrees with what a real review would
    // decide, and it is carried on WatchedRepoFacts.excludeRules so the
    // pre-launch veto below can reuse it without a second read.
    const userIgnore = await io.readIgnoreFile(repoRoot);
    const gateConfig = sizeGateConfig(
      {
        maxChangedLines: entry.maxChangedLines,
        maxChangedFiles: entry.maxChangedFiles,
      },
      undefined,
      userIgnore.rules,
    );
    const remoteHeads: { pr: number; heads: string[]; markerSeen: boolean }[] =
      [];
    const tooLarge: number[] = [];
    const nothingToReview: number[] = [];
    const inFlight: { pr: number; head: string }[] = [];
    const pending: { pr: number; head: string }[] = [];
    const nowMs = Date.now();
    for (const candidate of prs) {
      if (candidate.isDraft) continue;
      const locallyBlocked = runDirs.localReviews.some(
        (r) =>
          r.pr === candidate.pr && (r.head === candidate.head || !entry.onPush),
      );
      if (locallyBlocked) continue;
      // The size gate, TIERED, same frugality rule as the comments fetch
      // below: `gh pr list` already handed us GitHub's aggregate counters,
      // so a PR under both limits by its aggregate is settled for FREE —
      // exclusions can only ever make it smaller. Only a PR whose aggregate
      // exceeds a limit is worth a second call, and then the per-file list
      // is fetched so an excluded lockfile can still rescue it.
      //
      // BOTH tiers are whitespace-NAIVE, and nothing here can fix that:
      // GitHub's aggregate counters and `gh pr view --json files` alike carry
      // no whitespace information, so a formatter sweep counts in full where
      // the real git-side gate (cli.ts, `git diff -w --ignore-blank-lines`)
      // counts zero. The error is one-directional — the watcher can only
      // OVER-count and therefore only over-skip, never under-skip — and the
      // spawned review re-runs the real gate on real git data anyway.
      //
      // Recomputed from live counters on EVERY tick and never persisted: a
      // force-push that shrinks the PR must make it eligible again next
      // tick (constraint (b) on candidateSkipReason).
      if (
        !evaluateSizeGateAggregate(
          {
            files: candidate.changedFiles,
            insertions: candidate.additions,
            deletions: candidate.deletions,
          },
          gateConfig,
        ).ok
      ) {
        const perFile = parsePrFiles(
          await io.ghPrFiles(repoRoot, candidate.pr),
        );
        // gh's `files` list can be truncated on a very large PR. A short
        // list under-counts, and under-counting here FALSELY RESCUES exactly
        // the monster the gate exists to stop — so a count that disagrees
        // with GitHub's own changedFiles is not trusted to rescue anything.
        const trustworthy = perFile.length >= candidate.changedFiles;
        const verdict = evaluateSizeGate(perFile, gateConfig);
        if (!trustworthy || !verdict.ok) {
          tooLarge.push(candidate.pr);
          // No comments fetch for a PR that is already skipped — the pure
          // decision reads an unfetched PR as unguarded, and too-large
          // fires before the remote checks.
          continue;
        }
        // Rescued by the exclusions, but rescued into NOTHING: every changed
        // file was generated content. Spawning would have the child exit on
        // an empty effective diff before it creates a run dir, and with no
        // run dir there is no attempt to count — so the same PR would be
        // re-spawned every tick. Settle it here instead.
        if (verdict.effectiveFiles === 0) {
          nothingToReview.push(candidate.pr);
          continue;
        }
      }
      const comments = await fetchPrComments(repoRoot, candidate.pr);
      remoteHeads.push({
        pr: candidate.pr,
        heads: markerDeclaredHeads(comments),
        markerSeen: markerCommentSeen(comments),
      });
      const statuses = await fetchCommitStatuses(repoRoot, candidate.head);
      // The watcher's own leftover pending is local-only (T3 S7): it settles
      // only what it posted. A pending on pr-hero is a CI run's to finish.
      const latest = latestStatusInContext(
        statuses,
        LOCAL_COMMIT_STATUS_CONTEXT,
      );
      if (latest?.state === "pending") {
        pending.push({ pr: candidate.pr, head: candidate.head });
      }
      // In flight on EITHER context: CI's gate or a local run already reviewing
      // this head is a reason to launch nothing here (T3 S7).
      if (
        isInFlightCommitStatus(
          statuses,
          nowMs,
          IN_FLIGHT_TTL_MS,
          RUN_STATUS_CONTEXTS,
        )
      ) {
        inFlight.push({ pr: candidate.pr, head: candidate.head });
      }
    }

    repos.push({
      path: repoRoot,
      post: entry.post,
      onPush: entry.onPush,
      prs,
      localReviews: runDirs.localReviews,
      remoteHeads,
      attempts: prs.map((candidate) => ({
        pr: candidate.pr,
        head: candidate.head,
        count: countAttempts(runDirs.facts, candidate.pr, candidate.head),
      })),
      tooLarge,
      nothingToReview,
      inFlight,
      pending,
      runsRoot,
      maxChangedLines: entry.maxChangedLines,
      maxChangedFiles: entry.maxChangedFiles,
      excludeRules: gateConfig.excludeRules,
    });
  }
  return repos;
}

// One level deep, like the ledger scan: run dirs are flat children of the
// runs root. comparison.json is read through the LEDGER's loud parser — the
// reviewed-local set must come from parsed artifact fields (pr + head_sha),
// never from directory names — while pipeline.json feeds the tolerant
// attempts counter (see the WHY on countAttempts in watch/preflight.ts).
async function scanRunDirs(runsRoot: string): Promise<{
  facts: RunDirFact[];
  localReviews: { pr: number; head: string }[];
}> {
  const facts: RunDirFact[] = [];
  const localReviews: { pr: number; head: string }[] = [];
  if (!existsSync(runsRoot)) return { facts, localReviews };
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsRoot, entry.name);
    const comparisonPath = path.join(dir, "comparison.json");
    if (existsSync(comparisonPath)) {
      try {
        const comparison = parseComparisonJson(
          await Bun.file(comparisonPath).text(),
        );
        localReviews.push({ pr: comparison.pr, head: comparison.head_sha });
      } catch (error) {
        // The pure parser names the field; only the shell knows the file —
        // the same wrap ledgerCommand uses. Loud on purpose: a mis-read
        // comparison.json would silently re-review (and re-bill) a PR.
        if (error instanceof CliUsageError) {
          throw new CliError(`${comparisonPath}: ${error.message}`);
        }
        throw error;
      }
    }
    const pipelinePath = path.join(dir, "pipeline.json");
    facts.push({
      name: entry.name,
      pipelineMeta: existsSync(pipelinePath)
        ? parsePipelineMeta(await Bun.file(pipelinePath).text())
        : null,
    });
  }
  return { facts, localReviews };
}

// The argv a launched review runs with, after the engine's own invocation. No
// `--ci`: the watcher is a local actor (T3 S7), so its child resolves advisory on
// pr-hero/local and can never write the gate's context. Exported so a test reads
// the real argv, not a copy of it.
export function localReviewArgv(input: {
  pr: number;
  post: boolean;
  sizeArgs: readonly string[];
}): string[] {
  return [
    "review",
    "--pr",
    String(input.pr),
    "--yes",
    ...input.sizeArgs,
    ...(input.post ? ["--post"] : []),
  ];
}

// The settle for a leftover pending this watcher owns (T3 S7). It settles on the
// LOCAL context only: a `pr-hero` pending belongs to a CI run the watcher cannot
// grade, and a `success` written here would turn a failed CI gate green.
export function orphanPendingSettleRequest(
  targetUrl: string | undefined,
): ReturnType<typeof commitStatusRequest> {
  return commitStatusRequest({
    phase: "success",
    posted: false,
    targetUrl,
    context: LOCAL_COMMIT_STATUS_CONTEXT,
  });
}

// Completes a leftover pending status on a PR this tick will not launch
// again. Fail-soft: a yellow dot is worse than silence, a thrown tick is
// worse than a yellow dot. Dry-run never calls this (runTick is live only).
async function settleOrphanPendings(
  repos: WatchedRepoFacts[],
  skips: TickDecision["skips"],
): Promise<void> {
  for (const job of pendingReviewsToSettle(skips, repos)) {
    try {
      const targetUrl = prHtmlUrl(await ghRepoWebUrl(job.repo), job.pr);
      await postCommitStatus(
        job.repo,
        job.head,
        orphanPendingSettleRequest(targetUrl),
      );
    } catch {
      // Leave the pending in place; the next live tick will try again.
    }
  }
}

export interface PreLaunchVetoResult {
  launch: TickLaunch | null;
  vetoed: boolean;
}

// The pre-launch veto's impure half (design D6): orchestrates the ONE
// ghPrFiles call the pure preLaunchExclusionVeto (watch/preflight.ts) needs,
// for the CHOSEN launch only, then re-decides. `io` is narrowed to just
// ghPrFiles — the only I/O this needs — so tests never have to stub the
// rest of WatchIo to exercise it.
export async function applyPreLaunchVeto(
  io: Pick<WatchIo, "ghPrFiles">,
  launch: TickLaunch,
  repos: readonly WatchedRepoFacts[],
): Promise<PreLaunchVetoResult> {
  const repo = repos.find((r) => r.path === launch.repo);
  const candidate = repo?.prs.find(
    (c) => c.pr === launch.pr && c.head === launch.head,
  );
  // Unreachable in production: `launch` always comes from decideTick(repos),
  // so it is derived FROM this same repos array. Kept as a defensive
  // fail-open rather than a non-null assertion, because a launch this
  // function cannot place is exactly the kind of surprise that must never
  // block a review it has no evidence against.
  if (repo === undefined || candidate === undefined) {
    return { launch, vetoed: false };
  }
  let perFile: NumstatFile[];
  try {
    perFile = parsePrFiles(await io.ghPrFiles(repo.path, launch.pr));
  } catch {
    // Fails open (D6): the size gate's own WHY above (gatherRepoFacts) already
    // treats an unfetched PR as unguarded, and the CLI gate stays the backstop
    // (see the WHY on sizeArgs in runTick). Failing closed here would
    // silently re-create the exact daily-cap burn this veto exists to stop.
    return { launch, vetoed: false };
  }
  const gateConfig: SizeGateConfig = {
    maxChangedLines: repo.maxChangedLines,
    maxChangedFiles: repo.maxChangedFiles,
    excludeRules: repo.excludeRules,
  };
  const vetoed = preLaunchExclusionVeto(
    perFile,
    candidate.changedFiles,
    gateConfig,
  );
  return { launch: vetoed ? null : launch, vetoed };
}

// How many candidates one tick will veto before it gives up and launches
// nothing. WHY a cap exists at all, and WHY this number (paid for by
// pr-hero's own review of PR #205, BLOCKER): the fall-through below is what
// stops the veto from starving the queue, but an UNBOUNDED fall-through
// turns a single tick into one `gh pr view` per open PR — a dependabot
// flood, or any repo whose front-of-queue is a run of lockfile bumps, would
// have every tick spend the whole GitHub budget walking the same list.
//
// 5 is anchored to cost, not to taste: it bounds the veto's added spend at 5
// `gh pr view` calls per tick, against the tick's ALREADY per-candidate
// `gh pr list` + comments + statuses traffic, and it is comfortably longer
// than any realistic run of consecutive all-excluded PRs at the low-numbered
// end of the queue.
//
// The ACCEPTED tradeoff, stated so the next reader does not rediscover it as
// a bug: with more than 5 all-excluded PRs ahead of a reviewable one, the
// reviewable one is still starved — bounded per tick, but stably, tick after
// tick, because nothing here is persisted. That is deliberate. The forbidden
// alternative is the unbounded loop; the other alternative, remembering the
// veto across ticks, is ruled out by constraint (b) on candidateSkipReason
// (a force-push that shrinks a PR must make it eligible again NEXT tick), so
// no veto verdict may survive the tick that computed it. A repo that hits
// this cap has a systemic flood that one launch slot per tick cannot fix
// anyway; the `tick veto-cap-reached` log line is how the operator sees it.
export const PRE_LAUNCH_VETO_MAX_ATTEMPTS = 5;

export interface LaunchSelection {
  launch: TickLaunch | null;
  // Every candidate this tick vetoed, in the order they were considered —
  // runTick logs one skip line each. Never persisted anywhere (constraint
  // (b) above); a vetoed PR is re-examined from live counters next tick.
  vetoed: TickLaunch[];
  capReached: boolean;
}

// The fix for the #205 LIVELOCK, and the whole reason this sits between
// decideTick and the spawn. decideTick returns at most ONE launch per tick
// ACROSS ALL configured repos (`eligible[0]`, ascending by PR number). The
// veto as first built turned that single slot into `null` and the tick
// returned 0 — so an all-excluded PR that is nevertheless ELIGIBLE (its
// aggregate is under both limits, so gatherRepoFacts's tier 2 never fetches
// its file list and `nothingToReview` cannot see it) won the slot, was
// vetoed, wrote no artifact any later tick could read back, and did it all
// again on the next tick, forever — starving every other eligible PR in
// every configured repo. The veto swapped "launch and waste the slot" for
// "veto and waste the slot".
//
// So: fall through to the next eligible candidate INSIDE the same tick. The
// vetoed PR still costs one `ghPrFiles` call every tick forever, which is
// accepted — it is far cheaper than the per-tick spawn it replaced, and it
// is the only shape compatible with never persisting the verdict.
//
// applyPreLaunchVeto stays strictly per-candidate (it never sees the list):
// its fail-open contract on a `ghPrFiles` failure is per-PR reasoning, and
// widening it to the queue would make that contract answer a question it
// has no evidence for.
export async function selectLaunchAfterVeto(
  io: Pick<WatchIo, "ghPrFiles">,
  eligible: readonly TickLaunch[],
  repos: readonly WatchedRepoFacts[],
): Promise<LaunchSelection> {
  const vetoed: TickLaunch[] = [];
  for (const candidate of eligible) {
    // Checked BEFORE the call, so the cap bounds gh calls and not merely
    // vetoes. It can only fire with a candidate still unconsidered, which is
    // exactly when "launched nothing" is a decision rather than an empty
    // queue — hence capReached, which runTick logs.
    if (vetoed.length >= PRE_LAUNCH_VETO_MAX_ATTEMPTS) {
      return { launch: null, vetoed, capReached: true };
    }
    const result = await applyPreLaunchVeto(io, candidate, repos);
    if (!result.vetoed)
      return { launch: result.launch, vetoed, capReached: false };
    vetoed.push(candidate);
  }
  return { launch: null, vetoed, capReached: false };
}

async function runTick(
  paths: PrheroHomePaths,
  decision: TickDecision,
  repos: WatchedRepoFacts[],
  ghPrFilesFn: WatchIo["ghPrFiles"],
): Promise<number> {
  await appendLog(
    paths.logPath,
    logLine(localIsoTimestamp(new Date()), "tick start"),
  );
  for (const skip of decision.skips) {
    await appendLog(
      paths.logPath,
      skipLine(
        localIsoTimestamp(new Date()),
        path.basename(skip.repo),
        skip.pr,
        skip.head,
        skip.reason,
      ),
    );
  }
  await settleOrphanPendings(repos, decision.skips);

  // Pre-launch exclusion veto (design D6, prheroignore Phase 6, built after
  // pr-hero's own review of PR #204 flagged the shape of this gap): a PR
  // whose files are ALL excluded generated content but whose AGGREGATE is
  // under both limits never reaches gatherRepoFacts's tier-2 per-file fetch,
  // so `nothingToReview` cannot see it there. Without this veto it launches,
  // the CLI exits on the empty effective diff before createPrRunDir, and it
  // relaunches every tick — $0 each time, but `launched` is logged at spawn
  // (below) BEFORE that exit, so it burns the daily cap and the tick's one
  // launch slot reviewing nothing. An extra ghPrFiles call per candidate
  // considered — at most PRE_LAUNCH_VETO_MAX_ATTEMPTS of them, see
  // selectLaunchAfterVeto — buys the same rescue tier 2 already gives a PR
  // whose aggregate happened to exceed a limit; applyPreLaunchVeto carries
  // the fail-open contract on a ghPrFiles failure.
  //
  // The WHOLE eligible queue goes in, NOT `[decision.launch]`: passing the
  // single chosen launch would leave every unit test on selectLaunchAfterVeto
  // green while the fall-through — the actual fix for the #205 livelock —
  // was dead in production. `decision.launch === null` still short-circuits,
  // because a closed window or a spent daily cap leaves `eligible` populated
  // while nothing at all may launch.
  const selection: LaunchSelection =
    decision.launch === null
      ? { launch: null, vetoed: [], capReached: false }
      : await selectLaunchAfterVeto(
          { ghPrFiles: ghPrFilesFn },
          decision.eligible,
          repos,
        );
  for (const vetoed of selection.vetoed) {
    await appendLog(
      paths.logPath,
      skipLine(
        localIsoTimestamp(new Date()),
        path.basename(vetoed.repo),
        vetoed.pr,
        vetoed.head,
        "nothing-to-review",
      ),
    );
  }
  if (selection.capReached) {
    await appendLog(
      paths.logPath,
      logLine(
        localIsoTimestamp(new Date()),
        `tick veto-cap-reached attempts=${PRE_LAUNCH_VETO_MAX_ATTEMPTS}`,
      ),
    );
  }
  // ONE count, used by BOTH tick-end lines. They diverged the moment the
  // fall-through landed: the old single-candidate veto nulled the launch
  // whenever it fired, so `launched=1` was unreachable with a vetoed
  // candidate and the two branches could not disagree. `selectLaunchAfterVeto`
  // makes `launch !== null` and `vetoed.length > 0` coexist BY DESIGN — it is
  // the headline case, a lower-numbered PR vetoed and a higher-numbered one
  // launched in the same tick — and the launched branch was still reporting
  // the pre-fall-through count.
  //
  // Computed once rather than corrected in place: two call sites deriving the
  // same number is what let them drift, and the operator's only window into a
  // tick is this log.
  const skippedThisTick = decision.skips.length + selection.vetoed.length;
  const launch = selection.launch;
  if (launch === null) {
    await appendLog(
      paths.logPath,
      logLine(
        localIsoTimestamp(new Date()),
        `tick end launched=0 skipped=${skippedThisTick}`,
      ),
    );
    return 0;
  }

  const repoBase = path.basename(launch.repo);
  // The launched repo's own size-gate thresholds, forwarded to the spawn.
  // NOT optional: the spawned CLI runs the gate AGAIN, on the real git
  // numstat, and without these it would use DEFAULT_SIZE_GATE — so a repo
  // configured with a RAISED threshold would pass the watch tier, get
  // launched, and then be refused by the CLI's default. That refusal
  // happens before createPrRunDir, so it leaves no run dir, so the attempts
  // guard never sees it: the same PR would be relaunched every tick and eat
  // the whole daily cap, every day, reviewing nothing.
  //
  // Deliberately NOT --force: the CLI gate stays live as the backstop (it
  // sees the true diff, not GitHub's counters). It just has to agree with
  // this tick on what the limits are.
  const launched = repos.find((r) => r.path === launch.repo);
  const sizeArgs =
    launched === undefined
      ? []
      : [
          "--max-changed-lines",
          String(launched.maxChangedLines),
          "--max-changed-files",
          String(launched.maxChangedFiles),
        ];
  // Append-BEFORE-spawn, the fail-safe direction: if the tick crashes with
  // the review in flight, the launch must already be on the books — an
  // over-counted cap skips one review, an under-counted cap is unbounded
  // spend. This line is also what makes preflight-failing spawns (which
  // leave no run dir for the attempts guard to see) cost at most
  // daily_cap launches a day.
  await appendLog(
    paths.logPath,
    launchedLine(
      localIsoTimestamp(new Date()),
      launch.pr,
      repoBase,
      launch.head,
    ),
  );

  // The engine re-invoking ITSELF, through the one resolver that knows how:
  // under launchd there is no user PATH, so a bare `pr-hero` (or a bare
  // `bun`) resolves in every terminal and in nothing launchd starts — and a
  // hand-built `[execPath, <dir>/cli.ts]` pair names a script the compiled
  // binary does not carry, which is the tick spawning a review that could
  // never start.
  const self = selfInvocation();
  const proc = Bun.spawn(
    [
      self.command,
      ...self.args,
      ...localReviewArgv({ pr: launch.pr, post: launch.post, sizeArgs }),
    ],
    {
      cwd: launch.repo,
      stdin: "ignore",
      // Inherit, explicitly: the review's progress goes wherever the tick's
      // own stderr goes (launchd.log under launchd), and an unread pipe
      // would fill and stall a long review. watch.log stays append-only by
      // construction — nothing streams into it.
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await proc.exited;

  const outcome: ReviewOutcome = {
    pr: launch.pr,
    ok: exitCode === 0,
    exitCode,
    counts:
      exitCode === 0
        ? await readTierCounts(launched?.runsRoot, launch.pr, launch.head)
        : null,
  };
  await appendLog(
    paths.logPath,
    outcomeLine(localIsoTimestamp(new Date()), repoBase, outcome),
  );
  await notify("pr-hero", outcomeNotificationText(outcome));
  await appendLog(
    paths.logPath,
    logLine(
      localIsoTimestamp(new Date()),
      `tick end launched=1 skipped=${skippedThisTick}`,
    ),
  );
  return 0;
}

// The finding counts for the notification — cosmetic by contract, so every
// failure path degrades to null and the notification says "counts
// unavailable" instead of the tick dying over decoration.
async function readTierCounts(
  runsRoot: string | undefined,
  pr: number,
  headSha: string,
): Promise<{ blocking: number; advisory: number } | null> {
  try {
    if (runsRoot === undefined || !existsSync(runsRoot)) return null;
    const names = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const latest = latestRunDirName(names, pr, headSha);
    if (latest === null) return null;
    const parsed: unknown = await Bun.file(
      path.join(runsRoot, latest, "findings.json"),
    ).json();
    return findingsTierCounts(parsed);
  } catch {
    return null;
  }
}

async function notify(title: string, text: string): Promise<void> {
  // macOS only; elsewhere the notification is silently skipped (the log
  // line above already carries the outcome).
  if (process.platform !== "darwin") return;
  try {
    await run(osascriptNotifyArgs(title, text));
  } catch {
    // Cosmetic by contract — a broken osascript must never fail the tick.
  }
}

async function appendLog(logPath: string, line: string): Promise<void> {
  await appendFile(logPath, `${line}\n`);
}

// The PID in the lockfile if it names a LIVE process, else null (no file,
// unreadable, or dead holder — all mean "take the lock"). EPERM means the
// process exists but is not ours: alive.
async function lockHolder(lockPath: string): Promise<number | null> {
  if (!existsSync(lockPath)) return null;
  const pid = parseLockPid(await Bun.file(lockPath).text());
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
}

// Rendered through the same src/ui/primitives.ts primitives as the review plan card, on
// purpose: two surfaces that answer the same question ("what would this
// spend?") that look nothing alike cost the reader a re-orientation every
// time they switch.
function printDryRun(
  paths: PrheroHomePaths,
  config: WatchConfig,
  launchedToday: number,
  decision: TickDecision,
  repos: WatchedRepoFacts[],
): void {
  // Both impure decisions are made HERE, at the shell boundary, and handed
  // down as values — ui.ts's contract. This printer is the shell, so it is
  // allowed to sniff; row() and box() are not, which is why width is now a
  // required option rather than one they fill in behind the caller's back.
  const styles = styleEnabled();
  const width = terminalWidth();
  const emit = (label: string, value: string): void => {
    for (const line of row(label, value, { styles, width })) log(line);
  };
  for (const line of box(
    "pr-hero · watch",
    [
      "dry run — nothing spawned, logged, or locked",
      `${config.repos.length} repo(s) · ${launchedToday}/${config.dailyCap} ` +
        "launches used today",
    ],
    { styles, width },
  )) {
    log(line);
  }
  log();
  emit("CONFIG", shortPath(paths.watchConfigPath));
  emit(
    "WINDOW",
    config.window === null
      ? "always"
      : `${config.window.start}-${config.window.end}`,
  );
  emit("GATE", decision.gate);
  for (const repo of repos) {
    log();
    log(`  ${section(shortPath(repo.path), styles)}`);
    if (repo.prs.length === 0) {
      log("    no open PRs");
      continue;
    }
    for (const candidate of repo.prs) {
      const skip = decision.skips.find(
        (s) =>
          s.repo === repo.path &&
          s.pr === candidate.pr &&
          s.head === candidate.head,
      );
      log(
        `    pr ${candidate.pr} head ${shortSha(candidate.head, 8)} — ` +
          (skip === undefined ? "eligible" : `skip: ${skip.reason}`),
      );
    }
  }
  log();
  if (decision.launch !== null) {
    emit(
      "LAUNCH",
      `pr ${decision.launch.pr} in ${shortPath(decision.launch.repo)}` +
        ` (review --pr ${decision.launch.pr} --yes` +
        `${decision.launch.post ? " --post" : ""})`,
    );
  } else if (decision.gate !== "open") {
    emit("LAUNCH", `nothing — gate is ${decision.gate}`);
  } else {
    emit("LAUNCH", "nothing — no eligible (pr, head)");
  }
  if (decision.eligible.length > 1) {
    emit(
      "WAITING",
      decision.eligible
        .slice(1)
        .map((e) => `pr ${e.pr} (${path.basename(e.repo)})`)
        .join(", "),
    );
  }
}

// ---------------------------------------------------------------------------
// launchd install/uninstall (macOS). Both idempotent, both loud about what
// they did; the plist body itself is pure (renderWatchPlist).

async function watchInstall(intervalMin: number): Promise<number> {
  if (process.platform !== "darwin") {
    throw new CliError(
      "watch install renders a macOS launchd agent. On other systems run " +
        "`pr-hero watch --once` from cron — the lockfile covers overlap.",
    );
  }
  const paths = prheroHomePaths(os.homedir());
  await mkdir(paths.dir, { recursive: true });
  await mkdir(path.dirname(paths.plistPath), { recursive: true });
  const plist = renderWatchPlist({
    invocation: selfInvocation(),
    intervalSeconds: intervalMin * 60,
    logPath: paths.launchdLogPath,
    pathEnv: process.env.PATH ?? "",
  });
  // Unload first so a re-install refreshes the running definition; launchd
  // ignores rewrites of a loaded plist until the next load.
  if (existsSync(paths.plistPath)) {
    const unloaded = await run(["launchctl", "unload", "-w", paths.plistPath]);
    log(
      unloaded.ok
        ? `unloaded previous ${WATCH_LAUNCHD_LABEL}`
        : "previous plist present but not loaded (fine, replacing it)",
    );
  }
  await Bun.write(paths.plistPath, plist);
  const loaded = await run(["launchctl", "load", "-w", paths.plistPath]);
  if (!loaded.ok) {
    throw new CliError(
      `launchctl load -w ${paths.plistPath} failed: ${loaded.stderr.trim()}`,
    );
  }
  log(`wrote  ${paths.plistPath}`);
  log(`loaded ${WATCH_LAUNCHD_LABEL} — one tick every ${intervalMin} min`);
  log(`tick output: ${paths.launchdLogPath}`);
  log(`event log:   ${paths.logPath}`);
  if (!existsSync(paths.watchConfigPath)) {
    log();
    log(
      `NOTE: no ${paths.watchConfigPath} yet — ticks will fail until a repo is ` +
        "opted in. Run `pr-hero watch add` inside the repo to watch.",
    );
  }
  return 0;
}

async function watchUninstall(): Promise<number> {
  if (process.platform !== "darwin") {
    throw new CliError(
      "watch uninstall manages a macOS launchd agent; there is nothing to " +
        "uninstall on this system.",
    );
  }
  const paths = prheroHomePaths(os.homedir());
  if (!existsSync(paths.plistPath)) {
    log(`nothing installed (no ${paths.plistPath})`);
    return 0;
  }
  const unloaded = await run(["launchctl", "unload", "-w", paths.plistPath]);
  log(
    unloaded.ok
      ? `unloaded ${WATCH_LAUNCHD_LABEL}`
      : `plist present but not loaded: ${unloaded.stderr.trim() || "(no detail)"}`,
  );
  await rm(paths.plistPath, { force: true });
  log(`removed ${paths.plistPath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Config management (add/remove) and the read-only status view. The config
// file is machine-owned through these verbs so nobody hand-edits JSON; every
// decision (upsert, removal, rendering) is pure in watch/preflight.ts.

async function watchAdd(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(options.repo);
  const home = os.homedir();
  const paths = prheroHomePaths(home);
  const raw = existsSync(paths.watchConfigPath)
    ? await Bun.file(paths.watchConfigPath).text()
    : null;
  const result = upsertWatchRepo(
    raw,
    repoRoot,
    {
      post: options.post ?? false,
      onPush: options.onPush,
      // Same disclosed reset semantics as post/on_push: an absent flag
      // records the shipped default rather than preserving the old value —
      // `watch add` states the whole intent on the command line.
      maxChangedLines:
        options.maxChangedLines ?? DEFAULT_SIZE_GATE.maxChangedLines,
      maxChangedFiles:
        options.maxChangedFiles ?? DEFAULT_SIZE_GATE.maxChangedFiles,
    },
    home,
  );
  await mkdir(paths.dir, { recursive: true });
  await Bun.write(paths.watchConfigPath, result.config);
  log(
    `${result.action} ${result.storedPath} (post=${options.post ?? false} ` +
      `on_push=${options.onPush} ` +
      `max_changed_lines=${options.maxChangedLines ?? DEFAULT_SIZE_GATE.maxChangedLines} ` +
      `max_changed_files=${options.maxChangedFiles ?? DEFAULT_SIZE_GATE.maxChangedFiles}` +
      `) in ${paths.watchConfigPath}`,
  );
  await resolveRepoHome({
    home,
    operatorRoot: repoRoot,
    persist: true,
  });
  // The same hint install prints in reverse: config without a schedule is
  // as inert as a schedule without config — but only when the plist is
  // genuinely absent, an installed watcher needs no reminder.
  if (!existsSync(paths.plistPath)) {
    log();
    log(
      "NOTE: launchd agent not installed — run `pr-hero watch install` to " +
        "start ticking (this is the moment automatic spending starts).",
    );
  }
  return 0;
}

async function watchRemove(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(options.repo);
  const home = os.homedir();
  const paths = prheroHomePaths(home);
  // Idempotent by contract: removing what is not there succeeds saying so —
  // a missing config file is just the emptiest way of not being listed.
  if (!existsSync(paths.watchConfigPath)) {
    log(`not listed: no ${paths.watchConfigPath} exists`);
    return 0;
  }
  const result = removeWatchRepo(
    await Bun.file(paths.watchConfigPath).text(),
    repoRoot,
    home,
  );
  if (result.action === "not-listed" || result.config === null) {
    log(`not listed: ${repoRoot} is not in ${paths.watchConfigPath}`);
    return 0;
  }
  await Bun.write(paths.watchConfigPath, result.config);
  log(`removed ${repoRoot} from ${paths.watchConfigPath}`);
  return 0;
}

// $0 and read-only, and it never throws over an absent piece: no config, no
// log, no plist and no lock are all ordinary states the report simply
// names. Even an INVALID config renders as a status line — a status that
// crashes on a broken setup is useless exactly when it is needed.
async function watchStatus(): Promise<number> {
  const home = os.homedir();
  const paths = prheroHomePaths(home);
  let config: WatchConfig | null = null;
  let configError: string | null = null;
  if (existsSync(paths.watchConfigPath)) {
    try {
      config = parseWatchConfig(await Bun.file(paths.watchConfigPath).text());
    } catch (error) {
      configError = (error as Error).message;
    }
  }
  const logText = existsSync(paths.logPath)
    ? await Bun.file(paths.logPath).text()
    : "";
  const installed = existsSync(paths.plistPath);
  const activity = lastLogActivity(logText);
  const lines = renderWatchStatus({
    watchConfigPath: paths.watchConfigPath,
    config,
    configError,
    launchedToday: countLaunchedToday(
      logText,
      localIsoTimestamp(new Date()).slice(0, 10),
    ),
    plistPath: paths.plistPath,
    installed,
    intervalSeconds: installed
      ? parsePlistInterval(await Bun.file(paths.plistPath).text())
      : null,
    lockPid: await lockHolder(paths.lockPath),
    lastLaunched: activity.launched,
    lastOutcome: activity.outcome,
  });
  for (const line of lines) log(line);
  return 0;
}
