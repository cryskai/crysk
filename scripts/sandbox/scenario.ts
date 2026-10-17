// The scenario runner. A scenario is data (scenarios.ts). This file executes it
// against the real sandbox: each phase acts on the scenario PR, waits for the run
// that action starts, observes the PR, and checks its expectations against that one
// observation. Every scenario gets its own branch and PR, and cleanup runs in a
// finally, unless --keep asked for the PR to stay.
//
// An invocation holds the run lock (lock.ts) from start to end, so two invocations on
// this machine cannot both start a scenario. Cleanup stops a run still in flight
// before anything else, under --keep too, so a PR is never kept, and never lets the
// next scenario start, over a live run.
//
// smoke is the review-free scenario, run through this same code (smoke.ts).

import { type CheckResult, describeCheck, evaluateChecks } from "./expect";
import { acquireRunLock, releaseRunLock } from "./lock";
import { FINDING_MARKER_PREFIX, STATUS_CONTEXT } from "./markers";
import {
  COMMENT_RUN_CLOCK_SKEW_MS,
  type CommentFact,
  classifyComment,
  classifyPath,
  invariantViolations,
  isHuntersFailed,
  isHuntersFailedStatus,
  type Observation,
  postedByThisRun,
  type RunFact,
  type SmokePath,
} from "./observe";
import {
  type Interrupts,
  SIGNAL_EXIT_CODES,
  stopAfterInterrupt,
  watchInterrupts,
} from "./poll";
import type { SandboxDeps, Signal } from "./ports";
import {
  closeScenarioPr,
  deleteScenarioBranch,
  listScenarioPrs,
  type ScenarioPr,
} from "./pr";
import {
  assertScenarioBranch,
  guardedGh,
  guardedGit,
  RailViolation,
  SANDBOX_REPO,
  SCENARIO_BRANCH_PREFIX,
} from "./rails";
import { cloneSandbox, commitPaths, ghJson, ghOk, git } from "./repo";
import {
  renderReport,
  renderScenarioTable,
  type ScenarioResult,
} from "./report";
import {
  cancelRun,
  cancelTiming,
  findLiveRuns,
  Interrupted,
  isPrCommentRun,
  listBranchRuns,
  listCommentRuns,
  pollTiming,
  pollUntil,
  type RunListItem,
  type RunScope,
  type RunTiming,
  type Stop,
  stopRun,
  Unrecoverable,
} from "./runs";
import {
  type Action,
  findScenario,
  type Phase,
  type Scenario,
} from "./scenarios";
import {
  MUTE_COMMIT_MESSAGE,
  PLANTED_COMMIT_MESSAGE,
  plantedVolume,
  VOLUME_PATH,
  validateRef,
  WORKFLOW_PATH,
  workflowFor,
} from "./seed";
import { type VariantName, workflowVariant } from "./variants";

export interface RunOptions extends RunTiming {
  ref: string;
  keep: boolean;
  // `--no-retry`: a free-model flake is reported and not re-run.
  noRetry?: boolean;
}

// The row name of a scenario's re-run. The table shows both attempts, and this is the
// mark that tells the second one apart.
const RERUN_NOTE = "(re-run after a hunters-failed flake)";

// One attempt in the run's queue. A re-run is an attempt too, so it passes the same
// serialization gate and signal check as the scenarios do.
interface Attempt {
  scenario: Scenario;
  rerun?: boolean;
}

// What a running scenario knows so far. Named Live, not Scenario, because the
// scenario data in scenarios.ts is the Scenario type.
interface Live {
  scenario: string;
  branch: string;
  dir: string;
  pushed: boolean;
  pr?: ScenarioPr;
  headSha?: string;
  // The run the latest wait returned, observed by the next observe.
  run?: RunListItem;
  // The run of the current phase as last seen, recorded as each poll reads it. It
  // is cleared at the start of every phase, so a run an earlier phase recorded is
  // never taken for this phase's run. A wait that is interrupted or times out
  // leaves it set, so cleanup can cancel it.
  inFlight?: { databaseId: number; completed: boolean };
  // Every comment run an ambiguous wait found, recorded before the wait gives up, so
  // cleanup cancels each of them whichever one the comment was.
  candidates?: number[];
  // When the scenario's comment was created, in epoch ms. Its run is created after
  // it, so a run created before it (less a skew) cannot be the comment's run.
  commentCreatedAt?: number;
  // The id of that comment, from the URL gh printed. Its reactions are read by it.
  commentId?: string;
  // When the push that starts the scenario was made (epoch ms, this machine's clock),
  // and when GitHub created the PR (its clock). Cleanup looks the PR's runs up from
  // these: see runs.ts.
  pushedAt?: number;
  prCreatedAt?: number;
}

// How a scenario's cleanup ended. `kept` is set when --keep left the PR open with no
// run of it still going. Only a kept PR is exempt from the serialization check.
type Cleanup =
  | { outcome: "done"; kept: boolean }
  | { outcome: "failed"; message: string }
  // A second signal ended the cleanup's waits. `prOpen` says whether a PR was left
  // open with what it left behind.
  | { outcome: "abandoned"; prOpen: boolean; signal: Signal };

// One scenario as it ran: its result for the table, how its cleanup ended, and the
// signal that interrupted its work, if one did.
interface Ran {
  result: ScenarioResult;
  cleanup: Cleanup;
  interruptedBy?: Signal;
  // Set on a flake attempt that its re-run replaced. Its row stays in the table, but the
  // exit code is the re-run's.
  superseded?: boolean;
}

function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

// Runs the named scenarios in order. Returns 0 when every expectation and every
// S7 check passed, and 1 otherwise, including a refused or failed scenario. A
// refused start (the lock is held, or a scenario PR is still open) runs nothing.
// A SIGINT or SIGTERM ends the scenario it lands in, after that scenario's cleanup,
// and starts no further scenario. A scenario whose only failures are the free model's
// hunters-failed flake is re-run once, on a fresh PR, unless --no-retry (see
// isFreeModelFlake).
export async function runScenarios(
  input: SandboxDeps,
  names: readonly string[],
  options: RunOptions,
): Promise<number> {
  validateRef(options.ref);
  const deps: SandboxDeps = {
    ...input,
    gh: guardedGh(input.gh),
    git: guardedGit(input.git),
  };
  const scenarios = names.map((name) => {
    const found = findScenario(name);
    if (found === undefined) throw new Error(`unknown scenario ${name}`);
    return found;
  });

  const attempt = await acquireRunLock(deps.lock);
  if (!attempt.held) {
    deps.log(`refusing to start: ${attempt.reason}`);
    return 1;
  }
  if (attempt.takenOverFrom !== undefined) {
    deps.log(
      `took over ${deps.lock.path} from pid ${attempt.takenOverFrom}, which is no longer running`,
    );
  }

  const ran: Ran[] = [];
  // The PRs that --keep left open with no run still going. A kept PR whose run could
  // not be stopped is not in this list, so it still blocks the next scenario.
  const kept: number[] = [];
  // The signal that stopped the invocation before its later scenarios ran, if one did.
  let skippedBy: Signal | undefined;
  // Installed for the whole invocation, so a signal between scenarios stops it too.
  const interrupts = watchInterrupts(deps.signals, deps.log);
  const queue: Attempt[] = scenarios.map((scenario) => ({ scenario }));
  try {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const outcome = await runAttempt(deps, next, options, kept, interrupts);
      ran.push(outcome);
      const rest = queue.map((pending) => pending.scenario);
      if (outcome.result.refused === true) {
        logNotRun(deps, rest);
        break;
      }
      const signal = interrupts.received();
      if (signal !== undefined) {
        logNotRun(deps, rest);
        if (rest.length > 0) skippedBy = signal;
        break;
      }
      // Once only: a re-run that flakes again is reported as it is.
      if (
        options.noRetry !== true &&
        next.rerun !== true &&
        isFreeModelFlake(outcome.result)
      ) {
        deps.log(
          `${next.scenario.name}: its only failed checks are the free model's hunters-failed flake; re-running it once`,
        );
        outcome.superseded = true;
        queue.unshift({ scenario: next.scenario, rerun: true });
      }
    }
  } finally {
    interrupts.dispose();
    await releaseLock(deps);
  }
  for (const line of renderScenarioTable(ran.map((r) => r.result))) {
    deps.log(line);
  }
  return exitCodeFor(ran, skippedBy);
}

// The one failure a re-run is for: every failed check carries the free model's flake
// cause, and nothing else went wrong. No error (a timeout or a cleanup failure is one),
// and no S7 violation. Any other failure is a finding, and stands as it is.
export function isFreeModelFlake(result: ScenarioResult): boolean {
  const failed = result.checks.filter((check) => !check.pass);
  return (
    result.exitCode === 1 &&
    result.error === undefined &&
    result.s7.length === 0 &&
    failed.length > 0 &&
    failed.every((check) => check.cause === "free-model-hunters-failed")
  );
}

// The hunters-failed flake belongs to this phase only when this run posted the
// PRH-HUNTERS-FAILED outcome on the observed head. A failed review step is not enough:
// a later phase whose step fails for another reason posts no outcome of its own, and
// the path it reads is an earlier phase's outcome, which is no flake of this phase.
// The code family is observe.ts's own (isHuntersFailed), so a run rendered with its
// shared hunter cause (PRH-MODEL-UNAVAILABLE, a hunter-route PRH-CRED-UNUSABLE) is the
// same flake as PRH-HUNTERS-FAILED, exactly as classifyPath reads it. Any outcome
// of this run with that code counts, not only the first one on the head, because an
// earlier phase's outcome may still sit on the PR above it. A phase with no trigger
// has no window, so its outcome counts (postedByThisRun reads it as this run's).
// The head's status carries the same code when the publisher's comment POST failed:
// it writes the status first. Its created_at is judged against the same window a
// comment is (postedByThisRun), so a status an earlier run left on the head is no
// flake of this phase. observe.ts's StatusFact has no timestamp, so the caller reads
// it from the commit statuses and passes it in.
function isOwnHuntersFailed(
  obs: Observation,
  statusCreatedAt: string | undefined,
): boolean {
  if (
    obs.comments.some(
      (c) =>
        c.kind === "outcome" &&
        isHuntersFailed(c.code, c.hunterRoute === true) &&
        (c.head === undefined || c.head === obs.headSha) &&
        postedByThisRun(c, obs),
    )
  )
    return true;
  if (
    obs.status?.state !== "error" ||
    !isHuntersFailedStatus(obs.status.description)
  )
    return false;
  if (obs.triggeredAt === undefined) return true;
  if (statusCreatedAt === undefined) return false;
  return (
    Date.parse(statusCreatedAt) >= obs.triggeredAt - COMMENT_RUN_CLOCK_SKEW_MS
  );
}

// One attempt: the serialization gate, then the scenario. A refused attempt runs
// nothing and comes back as a REFUSED row. A re-run passes the same gate as the first
// attempt, so the lock, the rails and the kept PRs apply to it unchanged.
async function runAttempt(
  deps: SandboxDeps,
  attempt: Attempt,
  options: RunOptions,
  kept: number[],
  interrupts: Interrupts,
): Promise<Ran> {
  const blocked = await serializationBlock(deps, options.keep ? kept : []);
  if (blocked !== undefined) {
    return {
      result: {
        name: rowName(attempt.scenario, attempt.rerun === true),
        path: "not run",
        checks: [],
        s7: [],
        error: blocked,
        refused: true,
        exitCode: 1,
      },
      cleanup: { outcome: "done", kept: false },
    };
  }
  return runOne(
    deps,
    attempt.scenario,
    options,
    kept,
    interrupts,
    attempt.rerun === true,
  );
}

// The scenario's name as its table row shows it: a re-run carries the flake's mark.
function rowName(scenario: Scenario, rerun: boolean): string {
  return rerun ? `${scenario.name} ${RERUN_NOTE}` : scenario.name;
}

function logNotRun(deps: SandboxDeps, rest: readonly Scenario[]): void {
  if (rest.length > 0) {
    deps.log(`not run: ${rest.map((s) => s.name).join(", ")}`);
  }
}

// The exit code, by precedence. A cleanup that failed, or was abandoned with its PR
// still open, is 1 whatever else happened. A cleanup abandoned with its PR closed
// exits with its signal's code. Then a signal that interrupted a scenario, or stopped
// the scenarios after it, gives its code: a signal never turns a failed scenario into
// a clean-looking exit, and a run that did not start every scenario is not a pass.
// Only otherwise does each scenario's own result stand, and a flake that a re-run
// replaced does not count.
function exitCodeFor(
  ran: readonly Ran[],
  skippedBy: Signal | undefined,
): number {
  if (ran.some((r) => r.cleanup.outcome === "failed")) return 1;
  for (const r of ran) {
    if (r.cleanup.outcome === "abandoned") {
      return r.cleanup.prOpen ? 1 : SIGNAL_EXIT_CODES[r.cleanup.signal];
    }
  }
  const interrupted = ran.find((r) => r.interruptedBy !== undefined);
  if (interrupted?.interruptedBy !== undefined) {
    return SIGNAL_EXIT_CODES[interrupted.interruptedBy];
  }
  if (skippedBy !== undefined) return SIGNAL_EXIT_CODES[skippedBy];
  return ran
    .filter((r) => r.superseded !== true)
    .every((r) => r.result.exitCode === 0)
    ? 0
    : 1;
}

// The lock is released whether the invocation ended well, failed, or was signalled.
// A release that fails is logged: the file is then stale once this process exits,
// and the next run takes it over.
async function releaseLock(deps: SandboxDeps): Promise<void> {
  try {
    await releaseRunLock(deps.lock);
  } catch (error) {
    deps.log(
      `could not release ${deps.lock.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// S6: runs are serialized. Returns the refusal reason when a scenario PR that this
// run may not pass is still open, and logs which one.
async function serializationBlock(
  deps: SandboxDeps,
  exempt: readonly number[],
): Promise<string | undefined> {
  const open = (await listScenarioPrs(deps)).filter(
    (pr) => !exempt.includes(pr.number),
  );
  if (open.length === 0) return undefined;
  deps.log(
    `refusing to start: ${open.length} scenario PR(s) still open (runs are serialized):`,
  );
  for (const pr of open)
    deps.log(`  #${pr.number} ${pr.headRefName} ${pr.url}`);
  deps.log("close them with `bun scripts/sandbox.ts clean`, then re-run");
  return `${open.length} scenario PR(s) still open`;
}

async function runOne(
  deps: SandboxDeps,
  scenario: Scenario,
  options: RunOptions,
  kept: number[],
  interrupts: Interrupts,
  rerun: boolean,
): Promise<Ran> {
  const branch = `${SCENARIO_BRANCH_PREFIX}${scenario.name}-${utcStamp(deps.clock.now())}`;
  assertScenarioBranch(branch);
  const live: Live = {
    scenario: scenario.name,
    branch,
    dir: await deps.workspace.mkdtemp(),
    pushed: false,
  };
  const checks: CheckResult[] = [];
  const s7: string[] = [];
  let path = "no observation";
  let error: string | undefined;
  interrupts.enterScenario();
  // The work stops making calls once a signal lands; cleanup below uses deps.
  const work = stopAfterInterrupt(deps, interrupts.scenario);
  try {
    await cloneSandbox(work, live.dir);
    // A recheck comment starts main's workflow exactly as a plain comment does.
    if (
      scenario.phases.some(
        (p) =>
          p.action.kind === "comment" ||
          p.action.kind === "dismiss-and-recheck",
      )
    ) {
      await requirePinnedMain(work, live.dir, options.ref);
    }
    let previous: Observation | undefined;
    for (const [index, phase] of scenario.phases.entries()) {
      live.inFlight = undefined;
      await perform(work, live, phase.action, options.ref);
      const polled = await waitForRun(
        work,
        live,
        phase,
        options,
        interrupts.scenario,
      );
      live.run = polled.run;
      if (!polled.completed) {
        deps.log(
          `timed out after ${Math.round(pollTiming(options).timeoutMs / 1000)}s waiting for the run; collecting what is visible`,
        );
      }
      const collected = await collect(work, live);
      // Only a comment phase has a triggering comment whose reactions a check can read.
      // A recheck phase posts its own triggering comment, so it counts too.
      const obs: Observation =
        phase.action.kind === "comment" ||
        phase.action.kind === "dismiss-and-recheck"
          ? {
              ...collected,
              reactions: await triggerReactions(work, live),
            }
          : collected;
      // A run that did not complete has no path to read. It is reported as
      // timed-out and fails the scenario, whatever its partial evidence says.
      const observed: SmokePath = polled.completed
        ? classifyPath(obs)
        : "timed-out";
      path = observed;
      const violations = invariantViolations(obs);
      const tag = scenario.phases.length > 1 ? `[${index + 1}] ` : "";
      // A check after a prior outcome is asserted only when the phase before it
      // left an outcome comment; otherwise it is named, so the skip is explained.
      const priorOutcome =
        previous?.comments.some((c) => c.kind === "outcome") === true;
      const after = phase.afterPriorOutcome ?? [];
      if (!priorOutcome) {
        for (const check of after) {
          deps.log(
            `  not asserted: ${scenario.name} [${index + 1}] ${describeCheck(check)} (phase ${index} posted no outcome comment)`,
          );
        }
      }
      // Same blocking test the status-matches-findings check reads: a finding
      // comment whose header is the blocking tier. A phase that carried none has
      // nothing for the next run to keep red, so its checks say so instead.
      const priorBlocking =
        previous?.comments.some(
          (c) => c.kind === "finding" && c.blocking === true,
        ) === true;
      const afterBlocking = phase.afterPriorBlocking ?? [];
      if (!priorBlocking) {
        for (const check of afterBlocking) {
          deps.log(
            `  not asserted: ${scenario.name} [${index + 1}] ${describeCheck(check)} (phase ${index} posted no blocking finding to carry)`,
          );
        }
      }
      const asserted = [
        ...phase.checks,
        ...(priorOutcome ? after : []),
        ...(priorBlocking ? afterBlocking : []),
      ];
      // A failed check of a run whose hunters failed is the free model's flake. It
      // keeps its failure and exit code; only its label says why. A head that posted
      // success was reviewed, whatever an outcome comment still says, so it is no flake.
      // Only this phase's own hunters-failed run counts (see isOwnHuntersFailed).
      const freeModelFlake =
        observed === "hunters-failed" &&
        obs.status?.state !== "success" &&
        isOwnHuntersFailed(obs, collected.statusCreatedAt);
      const phaseChecks = evaluateChecks(asserted, obs).map(
        (r): CheckResult =>
          freeModelFlake && !r.pass
            ? { ...r, cause: "free-model-hunters-failed" }
            : r,
      );
      checks.push(...phaseChecks.map((r) => ({ ...r, label: tag + r.label })));
      s7.push(...violations);
      const passed =
        polled.completed &&
        violations.length === 0 &&
        phaseChecks.every((r) => r.pass);
      for (const line of renderReport(
        obs,
        observed,
        violations,
        passed ? 0 : 1,
      )) {
        deps.log(line);
      }
      if (!polled.completed) {
        error = `timed out after ${Math.round(pollTiming(options).timeoutMs / 1000)}s waiting for the run`;
        break;
      }
      previous = obs;
    }
  } catch (caught) {
    // An interrupt is logged by its handler; anything else is a failed step.
    error = caught instanceof Error ? caught.message : String(caught);
    if (!(caught instanceof Interrupted)) {
      deps.log(`scenario ${scenario.name} stopped early: ${error}`);
    }
  }
  // Read before cleanup: a signal that landed during the work is what interrupted it.
  const interruptedBy = interrupts.received();
  interrupts.enterCleanup();
  const cleanup = await finish(deps, live, options, interrupts.cleanup);
  await deps.workspace.remove(live.dir).catch(() => undefined);
  if (cleanup.outcome === "done" && cleanup.kept && live.pr !== undefined) {
    kept.push(live.pr.number);
  }
  const failure = error ?? cleanupFailure(cleanup);
  return {
    result: {
      name: rowName(scenario, rerun),
      prUrl: live.pr?.url,
      path,
      checks,
      s7,
      error: failure,
      exitCode:
        failure === undefined && checks.every((c) => c.pass) && s7.length === 0
          ? 0
          : 1,
    },
    cleanup,
    interruptedBy,
  };
}

function cleanupFailure(cleanup: Cleanup): string | undefined {
  if (cleanup.outcome === "failed") return cleanup.message;
  if (cleanup.outcome === "abandoned") {
    return `cleanup abandoned by a second ${cleanup.signal}`;
  }
  return undefined;
}

// Runs one phase's action. The first phase opens the PR; later phases push or
// comment on it.
async function perform(
  deps: SandboxDeps,
  live: Live,
  action: Action,
  ref: string,
): Promise<void> {
  if (action.kind === "open") {
    await git(deps, live.dir, ["checkout", "-b", live.branch]);
    await pinVariant(deps, live, action.variant, ref);
    await deps.workspace.write(live.dir, VOLUME_PATH, plantedVolume());
    // The scenario's own file overrides ride on the same first commit (scenarios.ts).
    const overrides = action.overrides ?? [];
    for (const file of overrides) {
      await deps.workspace.write(live.dir, file.path, file.contents);
    }
    await commitPaths(
      deps,
      live.dir,
      [VOLUME_PATH, ...overrides.map((file) => file.path)],
      PLANTED_COMMIT_MESSAGE,
    );
    await pushBranch(deps, live);
    const pr = await openPr(deps, live);
    deps.log(`PR: ${pr.url}`);
    return;
  }
  if (action.kind === "push") {
    // A push with nothing new would be an empty commit, which the rails do not
    // make. A scenario that pushes must change the workflow, and says so if not.
    // A push that adds files is never empty.
    const files = action.files ?? [];
    const pinned = await pinVariant(deps, live, action.variant, ref);
    for (const file of files) {
      await deps.workspace.write(live.dir, file.path, file.contents);
    }
    if (files.length > 0) {
      await commitPaths(
        deps,
        live.dir,
        files.map((file) => file.path),
        MUTE_COMMIT_MESSAGE,
      );
    }
    if (!pinned && files.length === 0) {
      throw new Error(
        `the ${action.variant} workflow is already on ${live.branch}, so the push would be empty`,
      );
    }
    await pushBranch(deps, live);
    return;
  }
  if (action.kind === "dismiss-and-recheck") {
    await dismissBlockingFinding(deps, live, action.argument);
    await postComment(deps, live, "/pr-hero recheck");
    return;
  }
  await postComment(deps, live, action.body);
}

// A PR comment as the authenticated user, and the comment's id and creation time for
// the phase that waits on its run.
async function postComment(
  deps: SandboxDeps,
  live: Live,
  body: string,
): Promise<void> {
  const pr = requirePr(live);
  const url = await ghOk(deps, [
    "pr",
    "comment",
    String(pr.number),
    "-R",
    SANDBOX_REPO,
    "--body",
    body,
  ]);
  deps.log(`comment: ${url.trim()}`);
  live.commentId = commentIdOf(url);
  live.commentCreatedAt = await commentCreatedAt(deps, live.commentId);
}

// T5b: replies `dismissed` on the first blocking finding's thread, as a human author
// would. A PR with no blocking finding has nothing to dismiss, so no reply is posted.
async function dismissBlockingFinding(
  deps: SandboxDeps,
  live: Live,
  argument: string,
): Promise<void> {
  const pr = requirePr(live);
  const headSha = live.headSha;
  if (headSha === undefined)
    throw new Error("the branch has no head to dismiss on");
  const comments = await ghJson<{ id: number; body: string }[]>(deps, [
    "api",
    `repos/${SANDBOX_REPO}/pulls/${pr.number}/comments?per_page=100`,
  ]);
  const finding = comments.find(
    (c) =>
      c.body.startsWith(FINDING_MARKER_PREFIX) &&
      c.body.includes("🔴 blocking"),
  );
  if (finding === undefined) {
    deps.log("no blocking finding to dismiss");
    return;
  }
  await ghOk(deps, [
    "api",
    `repos/${SANDBOX_REPO}/pulls/${pr.number}/comments`,
    "--method",
    "POST",
    "-f",
    `body=<!-- pr-hero-triage tag=dismissed head=${headSha} actor=agent verdict=upheld -->\n\n${argument}`,
    "-F",
    `in_reply_to=${finding.id}`,
  ]);
  deps.log(`dismissed blocking finding ${finding.id}`);
}

// The id GitHub gave the comment whose URL gh printed. The comment's run and its
// reactions are read by this id.
function commentIdOf(url: string): string {
  const id = /#issuecomment-(\d+)$/.exec(url.trim())?.[1];
  if (id === undefined) {
    throw new Error(`gh pr comment printed no comment URL: ${url.trim()}`);
  }
  return id;
}

// When GitHub stored the comment. The comment's run is matched against this time, so
// it is read from the comment itself, not from this clock.
async function commentCreatedAt(
  deps: SandboxDeps,
  id: string,
): Promise<number> {
  const comment = await ghJson<{ created_at: string }>(deps, [
    "api",
    `repos/${SANDBOX_REPO}/issues/comments/${id}`,
  ]);
  return Date.parse(comment.created_at);
}

// The reactions on the triggering comment, read through the rails. A read that fails
// leaves the field unset, so the reaction check fails on what it could not read and
// never passes on it. An interrupt and a rail refusal are not read failures: they
// still throw, so a signal stops the scenario and a bug in the rails is not hidden.
async function triggerReactions(
  deps: SandboxDeps,
  live: Live,
): Promise<string[] | undefined> {
  if (live.commentId === undefined) return undefined;
  try {
    const reactions = await ghJson<{ content: string }[]>(deps, [
      "api",
      `repos/${SANDBOX_REPO}/issues/comments/${live.commentId}/reactions?per_page=100`,
    ]);
    return reactions.map((reaction) => reaction.content);
  } catch (error) {
    if (error instanceof Interrupted || error instanceof RailViolation) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.log(
      `could not read the reactions on the triggering comment: ${message}`,
    );
    return undefined;
  }
}

// Writes the variant's workflow onto the branch when it differs, and commits it.
// Returns whether a commit was made.
async function pinVariant(
  deps: SandboxDeps,
  live: Live,
  variant: VariantName,
  ref: string,
): Promise<boolean> {
  const wanted = workflowVariant(variant, ref);
  if ((await deps.workspace.read(live.dir, WORKFLOW_PATH)) === wanted) {
    return false;
  }
  await deps.workspace.write(live.dir, WORKFLOW_PATH, wanted);
  await commitPaths(
    deps,
    live.dir,
    [WORKFLOW_PATH],
    variantMessage(variant, ref),
  );
  return true;
}

function variantMessage(variant: VariantName, ref: string): string {
  return variant === "normal"
    ? `sandbox: pin action to ${ref}`
    : `sandbox: ${variant} variant for ${ref}`;
}

// The comment starts main's workflow, so main must be pinned to the ref under
// test before anything is pushed. Otherwise the review would run a different
// action and report it as this one.
async function requirePinnedMain(
  deps: SandboxDeps,
  dir: string,
  ref: string,
): Promise<void> {
  if ((await deps.workspace.read(dir, WORKFLOW_PATH)) !== workflowFor(ref)) {
    throw new Error(
      `main's workflow is not pinned to ${ref}, and a comment run uses main's workflow; ` +
        `run \`bun scripts/sandbox.ts init --ref ${ref}\` first`,
    );
  }
}

// Plain fast-forward pushes only: the rails refuse anything else (rails.ts).
async function pushBranch(deps: SandboxDeps, live: Live): Promise<void> {
  // Recorded before the push: a push that fails after the branch was created
  // still has to be cleaned up. The time is taken then too, since no run of the
  // scenario can predate the push.
  live.pushed = true;
  live.pushedAt = deps.clock.now().getTime();
  await git(deps, live.dir, ["push", "-u", "origin", live.branch]);
  live.headSha = (await git(deps, live.dir, ["rev-parse", "HEAD"])).trim();
}

async function openPr(deps: SandboxDeps, live: Live): Promise<ScenarioPr> {
  const out = await ghOk(deps, [
    "pr",
    "create",
    "-R",
    SANDBOX_REPO,
    "--base",
    "main",
    "--head",
    live.branch,
    "--title",
    scenarioTitle(live),
    "--body",
    `Scenario PR from pr-hero's sandbox runner (\`bun scripts/sandbox.ts run ${live.scenario}\`). ` +
      "It is closed by the runner unless --keep was given.",
  ]);
  const url = out.trim().split("\n").at(-1) ?? "";
  const match = /\/pull\/(\d+)$/.exec(url);
  if (match === null)
    throw new Error(`gh pr create printed no PR URL: ${out.trim()}`);
  const pr: ScenarioPr = {
    number: Number(match[1]),
    headRefName: live.branch,
    url,
  };
  live.pr = pr;
  live.prCreatedAt = await prCreatedAt(deps, pr.number);
  return pr;
}

// When GitHub created the PR. Its comment runs are matched against this time, so it
// is read from GitHub, as commentCreatedAt reads the comment's, not from this clock.
async function prCreatedAt(deps: SandboxDeps, number: number): Promise<number> {
  const pr = await ghJson<{ created_at: string }>(deps, [
    "api",
    `repos/${SANDBOX_REPO}/pulls/${number}`,
  ]);
  return Date.parse(pr.created_at);
}

// The PR title names the scenario and its stamped branch, so it is unique per run.
// That is what tells this scenario's comment run apart from any other run in the repo.
function scenarioTitle(live: Live): string {
  return `pr-hero sandbox ${live.scenario} ${live.branch}`;
}

function requirePr(live: Live): ScenarioPr {
  if (live.pr === undefined)
    throw new Error("the scenario PR does not exist yet");
  return live.pr;
}

// Polls for the run the phase waits for, until it completes or the deadline
// passes. The run is recorded on the scenario as each poll sees it, so cleanup can
// stop it even when the wait is interrupted. The run last seen comes back with
// `completed` false on the deadline, so the report still shows what the PR looked
// like when the runner gave up.
async function waitForRun(
  deps: SandboxDeps,
  live: Live,
  phase: Phase,
  options: RunOptions,
  stop: Stop,
): Promise<{ completed: boolean; run?: RunListItem }> {
  // SB3: the cancel is sent once per phase, while the head's gate reads pending.
  let cancelSent = false;
  const polled = await pollUntil(
    deps,
    stop,
    pollTiming(options),
    async () => {
      const run =
        phase.wait === "pull_request"
          ? await findPullRequestRun(deps, live)
          : await findCommentRun(deps, live);
      if (run !== undefined) {
        live.inFlight = {
          databaseId: run.databaseId,
          completed: run.status === "completed",
        };
        if (
          phase.cancelWhenPending === true &&
          run.status !== "completed" &&
          !cancelSent
        ) {
          const headSha = live.headSha;
          if (headSha !== undefined) {
            let gateState: string | undefined;
            try {
              const combined = await ghJson<{
                statuses: { context: string; state: string }[];
              }>(deps, [
                "api",
                `repos/${SANDBOX_REPO}/commits/${headSha}/status`,
              ]);
              gateState = combined.statuses.find(
                (s) => s.context === STATUS_CONTEXT,
              )?.state;
            } catch {
              // A failed status read is retried on the next tick.
            }
            if (gateState === "pending") {
              await cancelRun(deps, run.databaseId);
              cancelSent = true;
              deps.log(
                `cancel sent to run ${run.databaseId} while the gate was pending`,
              );
            }
          }
        }
      }
      return run;
    },
    (run) => run.status === "completed",
  );
  return { completed: polled.done, run: polled.last };
}

// The pull_request run of this head. Matched by head sha, so a stale run on an
// earlier head is never read as this one.
async function findPullRequestRun(
  deps: SandboxDeps,
  live: Live,
): Promise<RunListItem | undefined> {
  const runs = await listBranchRuns(deps, live.branch);
  return runs.find((r) => r.headSha === live.headSha);
}

// The issue_comment run of the comment. It runs main's workflow, so its head is
// main's and it names no PR branch, and it is not found by sha. It is the one run
// that shows this scenario's PR title and was created at or after the comment. The
// title keeps out a run from another scenario; the time keeps out an earlier run
// that carries this title, such as one left by a timed-out attempt.
async function findCommentRun(
  deps: SandboxDeps,
  live: Live,
): Promise<RunListItem | undefined> {
  const commentedAt = live.commentCreatedAt;
  if (commentedAt === undefined) {
    throw new Error("waiting for a comment run before any comment was posted");
  }
  const title = scenarioTitle(live);
  const fresh = (await listCommentRuns(deps)).filter((r) =>
    isPrCommentRun(r, title, commentedAt),
  );
  if (fresh.length > 1) {
    live.candidates = fresh.map((r) => r.databaseId);
    throw new Unrecoverable(
      `${fresh.length} issue_comment runs carry this PR's title after its comment, so the comment run is ambiguous`,
    );
  }
  return fresh[0];
}

// An observation plus the head status's created_at, which StatusFact does not carry.
type Collected = Observation & { statusCreatedAt?: string };

// Reads the observables of the phase. Each source is a separate call, so a failure
// in one is an error for the whole scenario, not a silently empty field.
async function collect(deps: SandboxDeps, live: Live): Promise<Collected> {
  const pr = requirePr(live);
  const headSha = live.headSha;
  if (headSha === undefined)
    throw new Error("the branch has no head to observe");
  const run = live.run;
  const runView =
    run === undefined
      ? undefined
      : await ghJson<{
          status: string;
          conclusion: string | null;
          jobs: { steps: { name: string; conclusion: string | null }[] }[];
        }>(deps, [
          "run",
          "view",
          String(run.databaseId),
          "-R",
          SANDBOX_REPO,
          "--json",
          "status,conclusion,jobs",
        ]);
  const combined = await ghJson<{
    statuses: {
      context: string;
      state: string;
      description: string;
      created_at: string;
    }[];
  }>(deps, ["api", `repos/${SANDBOX_REPO}/commits/${headSha}/status`]);
  const issueComments = await ghJson<{ body: string; created_at: string }[]>(
    deps,
    ["api", `repos/${SANDBOX_REPO}/issues/${pr.number}/comments?per_page=100`],
  );
  const inlineComments = await ghJson<{ body: string; created_at: string }[]>(
    deps,
    ["api", `repos/${SANDBOX_REPO}/pulls/${pr.number}/comments?per_page=100`],
  );
  const artifacts =
    run === undefined
      ? []
      : (
          await ghJson<{ artifacts: { name: string }[] }>(deps, [
            "api",
            `repos/${SANDBOX_REPO}/actions/runs/${run.databaseId}/artifacts`,
          ])
        ).artifacts.map((a) => a.name);
  const comments: CommentFact[] = [
    ...issueComments.map((c) => ({
      ...classifyComment(c.body, "issue"),
      createdAt: c.created_at,
    })),
    ...inlineComments.map((c) => ({
      ...classifyComment(c.body, "inline"),
      createdAt: c.created_at,
    })),
  ];
  const latest = combined.statuses.find((s) => s.context === STATUS_CONTEXT);
  const runFact: RunFact | undefined =
    run === undefined || runView === undefined
      ? undefined
      : {
          id: run.databaseId,
          event: run.event,
          status: runView.status,
          conclusion: runView.conclusion,
          steps: runView.jobs.flatMap((j) => j.steps),
        };
  return {
    prNumber: pr.number,
    prUrl: pr.url,
    headSha,
    run: runFact,
    status:
      latest === undefined
        ? undefined
        : { state: latest.state, description: latest.description },
    statusCreatedAt: latest?.created_at,
    comments,
    artifacts,
    // Only a comment run was started by the comment, so only it is judged against
    // the comment's time.
    triggeredAt:
      run?.event === "issue_comment" ? live.commentCreatedAt : undefined,
  };
}

// Cleanup. A run still in flight is cancelled and waited on first, under --keep as
// well, so no PR is kept or closed over a live run. Then --keep leaves the PR in place
// and says where it is (and that its run was cancelled, when it was). Otherwise the
// PR is closed with its branch, or a branch with no PR is deleted. A failure is
// returned, and a PR left open breaks serialization, so the invocation exits 1. Only
// the waits are interruptible, and a second signal ends them (see poll.ts).
async function finish(
  deps: SandboxDeps,
  live: Live,
  options: RunOptions,
  stop: Stop,
): Promise<Cleanup> {
  let runIds: number[] = [];
  try {
    // The runs the scenario already knows of go first, so a lookup that fails after
    // them cannot leave one of them running.
    runIds = knownRuns(live);
    const known = await cancelRuns(deps, runIds, options, stop);
    if (known !== undefined) return known;
    const pushedAt = live.pushedAt;
    if (pushedAt !== undefined && needsLookup(live)) {
      const found = await findLiveRuns(
        deps,
        runScope(live, pushedAt),
        pollTiming(options),
        stop,
      );
      const more = found.filter((id) => !runIds.includes(id));
      runIds = [...runIds, ...more];
      const stopped = await cancelRuns(deps, more, options, stop);
      if (stopped !== undefined) return stopped;
    }
    if (options.keep) {
      if (live.pushed) {
        const cancelled = runIds.length > 0 ? ", its run cancelled first" : "";
        deps.log(
          `kept: ${live.pr?.url ?? "no PR"} on ${live.branch}${cancelled} (clean with \`bun scripts/sandbox.ts clean\`)`,
        );
      }
      return { outcome: "done", kept: true };
    }
    if (live.pr !== undefined) {
      deps.log(`closing ${live.pr.url} and deleting ${live.branch}`);
      await closeScenarioPr(deps, live.pr);
    } else if (live.pushed) {
      deps.log(`deleting ${live.branch}`);
      await deleteScenarioBranch(deps, live.branch);
    }
    return { outcome: "done", kept: false };
  } catch (error) {
    if (error instanceof Interrupted) {
      deps.log(
        `left open: the cleanup wait was abandoned by a second ${error.signal}. Still open: ${leftOpen(live, runIds)}. Run \`bun scripts/sandbox.ts clean\` to close them.`,
      );
      return {
        outcome: "abandoned",
        prOpen: live.pr !== undefined,
        signal: error.signal,
      };
    }
    const message = `cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    deps.log(message);
    return { outcome: "failed", message };
  }
}

// Cancels each run and waits for it to complete. Returns the failed cleanup when one
// did not stop within the cancel wait, and undefined when all of them did.
async function cancelRuns(
  deps: SandboxDeps,
  runIds: readonly number[],
  options: RunOptions,
  stop: Stop,
): Promise<Cleanup | undefined> {
  for (const runId of runIds) {
    if (!(await stopRun(deps, runId, cancelTiming(options), stop))) {
      const message = `left open: run ${runId} has not completed after the cancel; its PR stays open until the run ends (then clean)`;
      deps.log(message);
      return { outcome: "failed", message };
    }
  }
  return undefined;
}

// What cleanup may still have open, for the operator to close with `clean`.
function leftOpen(live: Live, runIds: readonly number[]): string {
  const items: string[] = [];
  if (live.pr !== undefined) items.push(live.pr.url);
  if (live.pushed) items.push(`branch ${live.branch}`);
  if (runIds.length > 0) {
    for (const id of runIds) items.push(`run ${id}`);
  } else if (
    live.inFlight === undefined &&
    (live.pr !== undefined || live.headSha !== undefined)
  ) {
    items.push(`any run on ${live.branch}`);
  }
  return items.join(", ");
}

// The runs the scenario already knows of and must stop: the run its phase sighted, if
// it is still going, and every comment run an ambiguous wait recorded.
function knownRuns(live: Live): number[] {
  const sighted = live.inFlight;
  return [
    ...(sighted !== undefined && !sighted.completed
      ? [sighted.databaseId]
      : []),
    ...(live.candidates ?? []),
  ];
}

// Whether cleanup must look up the PR's runs, beyond the ones it knows of. A phase
// whose run completed, with no ambiguity left behind, stops nothing more, so a finished
// scenario makes no extra call. Any other run the poll never sighted (a comment run
// queued after its comment, say) is found by the lookup.
function needsLookup(live: Live): boolean {
  return !(live.inFlight?.completed === true && live.candidates === undefined);
}

// The scenario's PR as the run lookup sees it. Before the PR exists, only its branch
// and the push can hold a run.
function runScope(live: Live, pushedAt: number): RunScope {
  return {
    branch: live.branch,
    title: scenarioTitle(live),
    prCreatedAtMs: live.prCreatedAt,
    startedAtMs: pushedAt,
  };
}
