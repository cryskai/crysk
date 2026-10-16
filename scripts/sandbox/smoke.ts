// smoke: one planted-bug PR through the free route, end to end, then cleanup.
//
// The PR is opened from a branch off main that pins the same action ref as the
// workflow it runs under, so the run exercises the ref under test and nothing
// else. The run is found by head sha (not by "latest"), because a stale run on
// an earlier head must never be read as this one. Whatever happens after the PR
// exists, cleanup runs in a finally: a scenario PR is never left open by accident
// unless --keep asked for it. Cleanup is also where a run still in flight is
// stopped: it is cancelled and waited on before its PR may close, so the
// serialization lock is never released while the review keeps running. A run the
// poll never saw is looked for on the scenario's branch first, because its
// `opened` event may have queued it after the scenario stopped looking.

import { STATUS_CONTEXT } from "./markers";
import {
  type CommentFact,
  classifyComment,
  classifyPath,
  exitCodeFor,
  invariantViolations,
  type Observation,
} from "./observe";
import type { SandboxDeps, Signal, SignalSource } from "./ports";
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
  SANDBOX_REPO,
  SCENARIO_BRANCH_PREFIX,
} from "./rails";
import { cloneSandbox, commitPaths, ghJson, ghOk, git } from "./repo";
import { renderReport } from "./report";
import {
  cancelTiming,
  findOrphanRuns,
  Interrupted,
  listBranchRuns,
  type PollTiming,
  pollTiming,
  pollUntil,
  type RunListItem,
  type Stop,
  stopRun,
  throwIfStopped,
} from "./runs";
import {
  PLANTED_COMMIT_MESSAGE,
  plantedVolume,
  VOLUME_PATH,
  validateRef,
  WORKFLOW_PATH,
  workflowFor,
} from "./seed";

const SIGNAL_EXIT_CODES: Record<Signal, number> = { SIGINT: 130, SIGTERM: 143 };

export interface SmokeOptions {
  ref: string;
  keep: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  cancelWaitMs?: number;
}

interface Scenario {
  branch: string;
  pushed: boolean;
  // The head pushed, once the push is confirmed. Cleanup looks for its run when
  // the poll never recorded one.
  headSha?: string;
  pr?: ScenarioPr;
  // The head's run as last seen. Cleanup cancels it unless it was seen completed.
  run?: { databaseId: number; completed: boolean };
}

// How cleanup ended. `failed` is an error, or a run left open after its cancel.
// `abandoned` is a second signal that ended the cleanup waits; it names the
// signal and whether a PR was left open with what it left behind.
type Cleanup =
  | { outcome: "done" }
  | { outcome: "failed" }
  | { outcome: "abandoned"; prOpen: boolean; signal: Signal };

const SMOKE_PR_BODY =
  "Scenario PR from pr-hero's sandbox runner (`bun scripts/sandbox.ts smoke`). " +
  "It carries one planted bug and is closed by the runner unless --keep was given.";

export function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export async function runSmoke(
  input: SandboxDeps,
  options: SmokeOptions,
): Promise<number> {
  validateRef(options.ref);
  const deps: SandboxDeps = {
    ...input,
    gh: guardedGh(input.gh),
    git: guardedGit(input.git),
  };

  const open = await listScenarioPrs(deps);
  if (open.length > 0) {
    deps.log(
      `refusing to start: ${open.length} scenario PR(s) still open (runs are serialized):`,
    );
    for (const pr of open)
      deps.log(`  #${pr.number} ${pr.headRefName} ${pr.url}`);
    deps.log("close them with `bun scripts/sandbox.ts clean`, then re-run");
    return 1;
  }

  const branch = `${SCENARIO_BRANCH_PREFIX}smoke-${utcStamp(deps.clock.now())}`;
  assertScenarioBranch(branch);
  const scenario: Scenario = { branch, pushed: false };
  const dir = await deps.workspace.mkdtemp();
  // Installed for the scenario and its cleanup. The first signal ends the work at
  // its next wait or call; a second one, during cleanup, ends cleanup's waits.
  const interrupts = watchInterrupts(deps.signals, deps.log);
  let scenarioCode: 0 | 1 = 1;
  let interruptedBy: Signal | undefined;
  let cleanup: Cleanup = { outcome: "done" };
  try {
    scenarioCode = await runScenario(
      stopAfterInterrupt(deps, interrupts),
      scenario,
      dir,
      options,
      interrupts,
    );
  } catch (error) {
    // An interrupt is logged by its handler; anything else is a failed step.
    if (!(error instanceof Interrupted)) {
      deps.log(
        `smoke stopped early: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    // Only a signal that arrived before this point interrupted the scenario.
    interruptedBy = interrupts.endScenario();
    cleanup = await finish(deps, scenario, options, interrupts);
    interrupts.dispose();
    await deps.workspace.remove(dir).catch(() => undefined);
  }
  return resultCode(cleanup, interruptedBy, scenarioCode);
}

// The exit code, by precedence. A cleanup that failed, or left a PR open, is 1
// whatever else happened. Then a signal that interrupted the scenario gives its
// code, so a signal never turns a failed cleanup into a clean-looking exit. Only
// otherwise does the scenario's own result stand. An abandoned cleanup with its PR
// already closed exits with the code of the signal that abandoned it.
function resultCode(
  cleanup: Cleanup,
  interruptedBy: Signal | undefined,
  scenarioCode: 0 | 1,
): number {
  if (cleanup.outcome === "failed") return 1;
  if (cleanup.outcome === "abandoned") {
    return cleanup.prOpen ? 1 : SIGNAL_EXIT_CODES[cleanup.signal];
  }
  if (interruptedBy !== undefined) return SIGNAL_EXIT_CODES[interruptedBy];
  return scenarioCode;
}

async function runScenario(
  deps: SandboxDeps,
  scenario: Scenario,
  dir: string,
  options: SmokeOptions,
  interrupts: Interrupts,
): Promise<0 | 1> {
  await cloneSandbox(deps, dir);
  const headSha = await pushScenario(deps, dir, scenario, options.ref);
  const pr = await openPr(deps, scenario);
  deps.log(`PR: ${pr.url}`);

  const timing = pollTiming(options);
  const polled = await waitForRun(
    deps,
    scenario,
    interrupts,
    headSha,
    scenario.branch,
    timing,
  );
  if (!polled.completed) {
    deps.log(
      `timed out after ${Math.round(timing.timeoutMs / 1000)}s waiting for the run`,
    );
  }
  const observed = await collect(deps, pr, headSha, polled.run);
  const path = polled.completed ? classifyPath(observed) : "timed-out";
  const violations = invariantViolations(observed);
  const exitCode = exitCodeFor(path, violations);
  for (const line of renderReport(observed, path, violations, exitCode))
    deps.log(line);
  return exitCode;
}

// Commits the planted bug on a branch off main. If the workflow on main pins
// another ref, the branch gets its own pin commit first, so the run under test
// uses the ref the operator asked for.
async function pushScenario(
  deps: SandboxDeps,
  dir: string,
  scenario: Scenario,
  ref: string,
): Promise<string> {
  await git(deps, dir, ["checkout", "-b", scenario.branch]);
  const pinned = workflowFor(ref);
  if ((await deps.workspace.read(dir, WORKFLOW_PATH)) !== pinned) {
    await deps.workspace.write(dir, WORKFLOW_PATH, pinned);
    await commitPaths(
      deps,
      dir,
      [WORKFLOW_PATH],
      `sandbox: pin action to ${ref}`,
    );
  }
  await deps.workspace.write(dir, VOLUME_PATH, plantedVolume());
  await commitPaths(deps, dir, [VOLUME_PATH], PLANTED_COMMIT_MESSAGE);
  // Recorded before the push: a push that fails after the branch was created
  // still has to be cleaned up.
  scenario.pushed = true;
  await git(deps, dir, ["push", "-u", "origin", scenario.branch]);
  const headSha = (await git(deps, dir, ["rev-parse", "HEAD"])).trim();
  // Recorded once the push is confirmed: cleanup looks for a run of this head
  // even when no PR was ever created for it.
  scenario.headSha = headSha;
  return headSha;
}

async function openPr(
  deps: SandboxDeps,
  scenario: Scenario,
): Promise<ScenarioPr> {
  const out = await ghOk(deps, [
    "pr",
    "create",
    "-R",
    SANDBOX_REPO,
    "--base",
    "main",
    "--head",
    scenario.branch,
    "--title",
    `pr-hero sandbox smoke ${scenario.branch}`,
    "--body",
    SMOKE_PR_BODY,
  ]);
  const url = out.trim().split("\n").at(-1) ?? "";
  const match = /\/pull\/(\d+)$/.exec(url);
  if (match === null)
    throw new Error(`gh pr create printed no PR URL: ${out.trim()}`);
  const pr: ScenarioPr = {
    number: Number(match[1]),
    headRefName: scenario.branch,
    url,
  };
  scenario.pr = pr;
  return pr;
}

// Polls for the run of this head until it completes, or the deadline passes. The
// run is recorded on the scenario as it is seen, so cleanup can stop it even when
// the poll itself is interrupted. On the deadline the run last seen is returned
// as not completed, and the report says the run timed out.
async function waitForRun(
  deps: SandboxDeps,
  scenario: Scenario,
  interrupts: Interrupts,
  headSha: string,
  branch: string,
  timing: PollTiming,
): Promise<{ completed: boolean; run?: RunListItem }> {
  const polled = await pollUntil(
    deps,
    interrupts.scenario,
    timing,
    async () => {
      const runs = await listBranchRuns(deps, branch);
      const run = runs.find((r) => r.headSha === headSha);
      if (run !== undefined) {
        scenario.run = {
          databaseId: run.databaseId,
          completed: run.status === "completed",
        };
      }
      return run;
    },
    (run) => run.status === "completed",
  );
  return { completed: polled.done, run: polled.last };
}

// Reads the observables of the head. Each source is a separate call, so a failure
// in one is an error for the whole smoke, not a silently empty field.
async function collect(
  deps: SandboxDeps,
  pr: ScenarioPr,
  headSha: string,
  run: RunListItem | undefined,
): Promise<Observation> {
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
    statuses: { context: string; state: string; description: string }[];
  }>(deps, ["api", `repos/${SANDBOX_REPO}/commits/${headSha}/status`]);
  const issueComments = await ghJson<{ body: string }[]>(deps, [
    "api",
    `repos/${SANDBOX_REPO}/issues/${pr.number}/comments?per_page=100`,
  ]);
  const inlineComments = await ghJson<{ body: string }[]>(deps, [
    "api",
    `repos/${SANDBOX_REPO}/pulls/${pr.number}/comments?per_page=100`,
  ]);
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
    ...issueComments.map((c) => classifyComment(c.body, "issue")),
    ...inlineComments.map((c) => classifyComment(c.body, "inline")),
  ];
  const latest = combined.statuses.find((s) => s.context === STATUS_CONTEXT);
  return {
    prNumber: pr.number,
    prUrl: pr.url,
    headSha,
    run:
      run === undefined || runView === undefined
        ? undefined
        : {
            id: run.databaseId,
            status: runView.status,
            conclusion: runView.conclusion,
            steps: runView.jobs.flatMap((j) => j.steps),
          },
    status:
      latest === undefined
        ? undefined
        : { state: latest.state, description: latest.description },
    comments,
    artifacts,
  };
}

// Cleanup. --keep leaves everything in place and says where it is. Otherwise every
// run of the head that may still be going is cancelled and waited on first, and
// only a completed run's PR is closed, with its branch. A branch with no PR is
// deleted. A failure here, or a run left open, makes the exit 1, because a
// scenario PR left open breaks serialization.
async function finish(
  deps: SandboxDeps,
  scenario: Scenario,
  options: SmokeOptions,
  interrupts: Interrupts,
): Promise<Cleanup> {
  if (options.keep) {
    if (scenario.pushed) {
      deps.log(
        `kept: ${scenario.pr?.url ?? "no PR"} on ${scenario.branch} (clean with \`bun scripts/sandbox.ts clean\`)`,
      );
    }
    return { outcome: "done" };
  }
  let runIds: number[] = [];
  try {
    runIds = await runsToStop(deps, scenario, options, interrupts.cleanup);
    for (const runId of runIds) {
      const stopped = await stopRun(
        deps,
        runId,
        cancelTiming(options),
        interrupts.cleanup,
      );
      if (!stopped) {
        deps.log(
          `left open: run ${runId} has not completed after the cancel; its PR stays open until the run ends (then clean)`,
        );
        return { outcome: "failed" };
      }
    }
    if (scenario.pr !== undefined) {
      deps.log(`closing ${scenario.pr.url} and deleting ${scenario.branch}`);
      await closeScenarioPr(deps, scenario.pr);
    } else if (scenario.pushed) {
      deps.log(`deleting ${scenario.branch}`);
      await deleteScenarioBranch(deps, scenario.branch);
    }
    return { outcome: "done" };
  } catch (error) {
    if (error instanceof Interrupted) {
      deps.log(
        `left open: the cleanup wait was abandoned by a second ${error.signal}. Still open: ${leftOpen(scenario, runIds)}. Run \`bun scripts/sandbox.ts clean\` to close them.`,
      );
      return {
        outcome: "abandoned",
        prOpen: scenario.pr !== undefined,
        signal: error.signal,
      };
    }
    deps.log(
      `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { outcome: "failed" };
  }
}

// What cleanup may still have open, for the operator to close with `clean`.
function leftOpen(scenario: Scenario, runIds: readonly number[]): string {
  const items: string[] = [];
  if (scenario.pr !== undefined) items.push(scenario.pr.url);
  if (scenario.pushed) items.push(`branch ${scenario.branch}`);
  if (runIds.length > 0) {
    for (const id of runIds) items.push(`run ${id}`);
  } else if (
    scenario.run === undefined &&
    (scenario.pr !== undefined || scenario.headSha !== undefined)
  ) {
    items.push(`any run on ${scenario.branch}`);
  }
  return items.join(", ");
}

// The runs cleanup must cancel. A run on record decides it. Without one, a PR or
// a pushed head may still have a run that its `opened` event queued, so the
// branch is looked up for it.
async function runsToStop(
  deps: SandboxDeps,
  scenario: Scenario,
  options: SmokeOptions,
  stop: Stop,
): Promise<number[]> {
  if (scenario.run !== undefined) {
    return scenario.run.completed ? [] : [scenario.run.databaseId];
  }
  if (scenario.pr === undefined && scenario.headSha === undefined) return [];
  return findOrphanRuns(deps, scenario.branch, pollTiming(options), stop);
}

// ---------------------------------------------------------------------------
// Interrupts. The first SIGINT or SIGTERM ends the scenario's waits and work at
// once, and cleanup runs as after a normal end. A second signal ends cleanup's
// waits too: cleanup then reports what it may have left open and gives up. The
// handlers are installed for the run only and removed after it.
// ---------------------------------------------------------------------------

export interface Interrupts {
  // Ends the scenario. Its first signal is the one that interrupts it.
  readonly scenario: Stop;
  // Ends cleanup's waits. Its second signal is the one that abandons them.
  readonly cleanup: Stop;
  // Marks the end of the scenario and returns the signal that interrupted it, if
  // any. Signals received after this arrived during cleanup.
  endScenario(): Signal | undefined;
  dispose(): void;
}

export function watchInterrupts(
  source: SignalSource,
  log: (line: string) => void,
): Interrupts {
  const received: Signal[] = [];
  let cleanupBegun = false;
  let wakeScenario!: (error: Error) => void;
  let wakeCleanup!: (error: Error) => void;
  const scenarioWake = new Promise<never>((_, reject) => {
    wakeScenario = reject;
  });
  const cleanupWake = new Promise<never>((_, reject) => {
    wakeCleanup = reject;
  });
  // Nobody may be waiting when a signal lands; that must not be an unhandled rejection.
  scenarioWake.catch(() => undefined);
  cleanupWake.catch(() => undefined);
  const installed = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      received.push(signal);
      if (received.length === 1) {
        // A first signal during cleanup finds the scenario already over, so it
        // leaves the exit code alone. It is reported, not acted on.
        log(
          cleanupBegun
            ? `${signal} received during cleanup: the scenario had already ended, so it does not change the exit code`
            : `${signal} received: stopping the scenario and cleaning up`,
        );
        wakeScenario(new Interrupted(signal));
      } else if (received.length === 2) {
        log(`${signal} received again: abandoning the cleanup wait`);
        wakeCleanup(new Interrupted(signal));
      }
    };
    source.on(signal, handler);
    return { signal, handler };
  });
  return {
    scenario: { signal: () => received[0], wake: scenarioWake },
    cleanup: { signal: () => received[1], wake: cleanupWake },
    endScenario: () => {
      cleanupBegun = true;
      return received[0];
    },
    dispose: () => {
      for (const { signal, handler } of installed) source.off(signal, handler);
    },
  };
}

// The work after a signal makes no new call, so nothing is created once cleanup
// has begun: a PR opened after the close would be left behind.
function stopAfterInterrupt(
  deps: SandboxDeps,
  interrupts: Interrupts,
): SandboxDeps {
  return {
    ...deps,
    gh: async (args) => {
      throwIfStopped(interrupts.scenario);
      return deps.gh(args);
    },
    git: async (args, cwd) => {
      throwIfStopped(interrupts.scenario);
      return deps.git(args, cwd);
    },
  };
}
