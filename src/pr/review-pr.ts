// PR mode (ROADMAP B1): one command from a PR number to a reviewed range, a
// detached worktree, and a pipeline run. Moved out of
// src/cli.ts (cli-decomp Phase 2, odd/tasks/cli-decomposition.md) as a
// byte-for-byte relocation — no behaviour change.
//
// Two roots run through everything below, and confusing them is the failure
// this design exists to prevent:
//   - the OPERATOR root: --repo's toplevel. cwd for gh and for .prhero/
//     config+gotchas. Config is NEVER read from the worktree — the operator
//     checkout is the trust anchor, and a reviewed PR's tree must not
//     influence engine config. Dirtiness here is irrelevant.
//   - the GIT-DIR OWNER: the clone registered for this origin under
//     ~/.prhero/repos/<id>/registry.json. Fetch, worktree add/prune/remove
//     and the object-db git (rev-parse, diff) run against it, because
//     `git worktree add` is bound to one git dir (W3 / #24).
//   - the REVIEW root: the worktree, detached at the PR's head, living
//     under ~/.prhero/repos/<id>/worktrees/pr-<n>. The pipeline's cwd, the
//     tree the codegraph checks run against, and a root the run dir must
//     stay outside of.

import path from "node:path";
import {
  cliHeadField,
  hunterFailureRecords,
  writeCliRecord,
} from "#ci/cli-record";
import { planCiSizeSkip } from "#ci/gates";
import { withCiWorkflowGroup } from "#ci/reporter";
import { RECHECK_COMMAND, REVIEW_COMMAND } from "#ci/trigger";
import { pipelineConfigInput } from "#config/config";
import {
  exclusionLines,
  git,
  gitCommitExists,
  gitIsAncestor,
  gitNameOnly,
  gitNameStatus,
} from "#git/git";
import { engineIdentity } from "#git/identity";
import {
  type CiAdmissionLedgerState,
  holdCiAdmissionLedger,
  publishCiSkip,
  reserveCiAdmissionLedger,
  settleCiAdmissionLedger,
  settleCiGateSkip,
} from "#pr/admission";
import {
  evaluateCiAdmissionGate,
  isCiConfigError,
  recordCiConfigErrorSkip,
  yieldToInFlightReview,
} from "#pr/ci-admission-gate";
import { discoveryHunters, resolvePrDiscovery } from "#pr/discovery";
import type { InlinePostOutcome } from "#pr/inline";
import { resolvePrPlanAndConfirm } from "#pr/plan";
import {
  fetchPostedFindingComments,
  fetchPrComments,
  fetchPrReviewComments,
  ghPrFiles,
  ghPrView,
  postReviewCommentReply,
} from "#pr/pr";
import {
  createPrRunDir,
  resolveCiPosture,
  resolvePrTarget,
} from "#pr/preflight";
import { publishRunOutcome } from "#pr/publish-outcome";
import { resolveEagerLocalIgnore, resolvePrFetchAndRange } from "#pr/range";
import {
  renderPrDryRunPlan,
  resolvePrDryRunNumstat,
  resolvePrPromptSetAndBudget,
  resolvePrRunOptions,
  resolvePrTargetRecord,
} from "#pr/target";
import { finalizePrReviewRun, settleCommitStatusAndLedger } from "#pr/teardown";
import { setupPrWorktree } from "#pr/worktree-setup";
import {
  type HunterFailure,
  type PipelineResult,
  runPipeline,
} from "#review/pipeline";
import {
  type CliOptions,
  resolveMaxConcurrentSteps,
  resolveSharedPrefix,
} from "#review/preflight";
import { estimateCost } from "#review/report";
import {
  pipelineConsolidateInput,
  pipelineScoutInput,
  pipelineSummarizerInput,
} from "#review/route-preflight";
import {
  prepareRunnerForRoute,
  resolveParityFires,
  validateGotchas,
} from "#review/run";
import { sizeGateConfigFor, sizeGateLine } from "#review/size-gate";
import { registerActiveRun, unregisterActiveRun } from "#store/activity";
import {
  type AdjudicationOutcome,
  adjudicationMarker,
  CI_ADJUDICATOR_LOGIN,
} from "#triage/adjudication";
import { dryRunHunterCount, reviewingLine } from "#ui/plan";
import { log, styleEnabled, terminalWidth } from "#ui/primitives";
import { applySizeGate, startProgressRenderer } from "#ui/progress";
import { parsePrFiles } from "#watch/preflight";
import { commandHint } from "../brand";
import { CliError } from "../errors";
import { acquirePidLock } from "../home";
import { worktreeLockPath } from "../home-preflight";
import { readLocalIgnoreRules } from "../ignore-read";
import type { ProductionRuntime } from "../production-runtime";

// The CLI's record for a pipeline whose every hunter failed (cli.json,
// odd/tasks/agent-first-ci.md, T2c). reviewPr writes it right after the pipeline's
// group closes, before publishRunOutcome. A completed pipeline writes NOTHING here:
// the pipeline finishing is not the review being delivered, so reviewed is written by
// publishRunOutcome at the delivery point (recordReviewDelivered). A failure while
// posting therefore never leaves reviewed behind. A pipeline that never returned
// writes nothing either: its throw reaches the fatal record instead.
export function recordPipelineOutcome(
  result:
    | {
        readonly sessionFailed: boolean;
        readonly hunterFailures?: readonly HunterFailure[];
      }
    | undefined,
  headSha: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (result?.sessionFailed !== true) return;
  // WHY the causes ride on the record: the publisher names the provider and the model
  // when every hunter failed on the provider's side (PRH-MODEL-UNAVAILABLE). A run with
  // no failed hunter list keeps the record as it was before the field existed.
  const failures = result.hunterFailures ?? [];
  writeCliRecord(
    {
      v: 1,
      outcome: "hunters-failed",
      ...cliHeadField(headSha),
      ...(failures.length === 0
        ? {}
        : { hunter_failures: hunterFailureRecords(failures) }),
    },
    env,
  );
}

// T5b: one reply per adjudication, on the finding's own thread. Posted after the
// review is published. WHY a failed post only warns: no verdict changes this run's
// gate. A reply that fails or does not land leaves the dismissal with no CI ruling,
// so the next /crysk recheck rules on it again and the next review still counts
// the finding, which fails closed.
const ADJUDICATION_REPLY_TIMEOUT_MS = 30_000;

const ADJUDICATION_BADGES = {
  upheld: `✅ **CI adjudication: upheld** — the dismissal stands; from the next review of this head (${commandHint(REVIEW_COMMAND)}) this finding no longer counts toward the gate.`,
  rejected:
    "❌ **CI adjudication: rejected** — the finding stands and still counts.",
  inconclusive:
    "❔ **CI adjudication: inconclusive** — the repository did not settle it; the finding still counts.",
} as const;

// The author of a posted reply, read back from GitHub. The gh helper in pr.ts is
// private to that module, so the one GET this needs runs here, with the same
// spawn shape: cwd is the operator root, so gh resolves the repo from its remote.
async function readCommentAuthor(input: {
  operatorRoot: string;
  commentId: number;
  spawnFn?: typeof Bun.spawn;
}): Promise<string> {
  const spawn = input.spawnFn ?? Bun.spawn;
  const proc = spawn(
    [
      "gh",
      "api",
      `repos/{owner}/{repo}/pulls/comments/${input.commentId}`,
      "--jq",
      ".user.login",
    ],
    {
      cwd: input.operatorRoot,
      stdout: "pipe",
      stderr: "pipe",
      timeout: ADJUDICATION_REPLY_TIMEOUT_MS,
    },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh api (read comment author) exited ${exitCode}`);
  }
  return stdout.trim();
}

export async function postAdjudicationReplies(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  adjudications: readonly AdjudicationOutcome[];
  spawnFn?: typeof Bun.spawn;
}): Promise<void> {
  for (const entry of input.adjudications) {
    // No ruling exists: post nothing, so the dismissal stays pending for a later recheck.
    if (entry.failed === true) {
      process.stdout.write(
        `::notice::pr-hero: the CI adjudicator could not rule on ${entry.priorId}; it stays pending for the next ${commandHint(RECHECK_COMMAND, "")}\n`,
      );
      continue;
    }
    const marker = adjudicationMarker({
      verdict: entry.verdict,
      reply: entry.replyId,
      head: input.headSha,
    });
    const evidence =
      entry.evidence.length > 0
        ? `\n\nEvidence:\n${entry.evidence.map((e) => `- \`${e}\``).join("\n")}`
        : "";
    const body = `${marker}\n\n${ADJUDICATION_BADGES[entry.verdict]}${evidence}`;
    let commentId: number | undefined;
    try {
      commentId = await postReviewCommentReply({
        operatorRoot: input.operatorRoot,
        pr: input.pr,
        inReplyTo: entry.threadId,
        body,
        spawnFn: input.spawnFn,
        timeoutMs: ADJUDICATION_REPLY_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(
        `::warning::pr-hero: could not post the CI adjudication for ${entry.priorId}: ${message}\n`,
      );
    }
    // Only an upheld verdict can clear the finding on the next review, so only its
    // landing is checked. A read that fails counts as not landed.
    if (entry.verdict !== "upheld") continue;
    const author =
      commentId === undefined
        ? undefined
        : await readCommentAuthor({
            operatorRoot: input.operatorRoot,
            commentId,
            spawnFn: input.spawnFn,
          }).catch(() => undefined);
    if (author !== CI_ADJUDICATOR_LOGIN) {
      process.stdout.write(
        `::warning::pr-hero: the CI adjudication for ${entry.priorId} was not recorded under ${CI_ADJUDICATOR_LOGIN}; the finding still counts toward the gate\n`,
      );
    }
  }
}

export async function reviewPr(
  options: CliOptions,
  prArg: number | "current",
): Promise<number> {
  // 1-2 — the operator root, resolved config, prompt set, and PR record. See
  // resolvePrRunOptions / resolvePrPromptSetAndBudget / resolvePrTargetRecord
  // (src/pr/target.ts) for the full rationale, including why the gotchas
  // validation call below stays inline here rather than moving into that
  // module.
  const step1 = await resolvePrRunOptions(options, prArg);
  options = step1.options;
  const { operatorRoot, prNumber, home, isCi, loaded, config, summary } = step1;
  // S4 + T3 S7: the run's one posture. Every gate, skip, status, comment and
  // summary below takes these values; nothing re-resolves them. Both key on the
  // explicit --ci flag, never on `isCi` (which also folds in the CI/GITHUB_ACTIONS
  // environment): a shell that exports CI=1 is advisory, on pr-hero/local.
  const { ciMode, statusContext } = resolveCiPosture(options);
  // The eager, non-CI-only `.prheroignore` read (O-8). See
  // resolveEagerLocalIgnore (src/pr/range.ts) for the full rationale — under
  // CI this stays `undefined` on purpose; the CI read instead needs the
  // RESOLVED base sha, not known yet here (see resolvePrFetchAndRange below).
  const localIgnore = await resolveEagerLocalIgnore({
    isCi,
    operatorRoot,
    readLocal: readLocalIgnoreRules,
  });
  let step2: Awaited<ReturnType<typeof resolvePrPromptSetAndBudget>>;
  try {
    step2 = await resolvePrPromptSetAndBudget({
      options,
      loaded,
      config,
      isCi,
      operatorRoot,
    });
    await validateGotchas(step2.gotchasPath);
  } catch (error) {
    // WHY a row before the rethrow: this run stops before the admission
    // reservation below, so without one its head would count as a spent
    // attempt (see recordCiConfigErrorSkip). Only CI writes it, the same way the
    // size gate does, and never on a dry run, which writes nothing. The error
    // itself is rethrown unchanged.
    if (isCi && !options.dryRun && isCiConfigError(error)) {
      await recordCiConfigErrorSkip({
        operatorRoot,
        prNumber,
        config,
        resolveHeadSha: async () =>
          resolvePrTarget(await ghPrView(operatorRoot, prNumber)).headSha,
        reason: "configuration error before the review; no provider spend",
      });
    }
    throw error;
  }
  const {
    ciBudgetCeiling,
    ciSizeLimits,
    agents,
    spec,
    agentFiles,
    promptSet,
    gotchasPath,
  } = step2;
  const { dir: agentsDir, source: agentsDirSource } = agents;
  // CI resolves the limits from the route (resolveCiSizeLimits); a local run
  // keeps the flags. An `undefined` knob falls through to the repo config,
  // then the engine default, inside sizeGateConfigFor. Computed ONCE so the
  // dry-run plan and the real gate cannot disagree about the same PR.
  const sizeGateOverrides =
    ciSizeLimits === undefined
      ? options
      : {
          ...(ciSizeLimits.maxChangedLines === undefined
            ? {}
            : { maxChangedLines: ciSizeLimits.maxChangedLines }),
          ...(ciSizeLimits.maxChangedFiles === undefined
            ? {}
            : { maxChangedFiles: ciSizeLimits.maxChangedFiles }),
        };
  // Local mode's dirty-tree and HEAD-match gates are both skipped here ON
  // PURPOSE: the hunters read the worktree and never this checkout, and the
  // worktree satisfies the HEAD gate by construction (created detached at
  // the PR's own head).
  const { repoHome, gitDirOwner, target, worktreePath } =
    await resolvePrTargetRecord({
      home,
      operatorRoot,
      prNumber,
      dryRun: options.dryRun,
    });

  // The CI admission gate (ROADMAP Pillar 3): decides, before any git fetch
  // or worktree is touched, whether a CI-triggered review of an
  // already-reviewed head should run, skip, or fall back to a human
  // decision. See evaluateCiAdmissionGate (src/pr/ci-admission-gate.ts) for
  // the full rationale.
  const ciAdmissionGate = await evaluateCiAdmissionGate({
    operatorRoot,
    prNumber,
    headSha: target.headSha,
    config,
    isCi,
    ciMode,
    options,
  });
  if (ciAdmissionGate.exitCode !== undefined) return ciAdmissionGate.exitCode;
  const { ciPolicy, ciPolicyHash, ledgerRecords } = ciAdmissionGate;
  let ciAdmissionLedger: CiAdmissionLedgerState | null = null;

  // 3 — the free exit, BEFORE the git fetch: a PR-mode dry run still creates
  // NOTHING — no `git fetch`, no worktree, no run dir — but it does now make
  // a SECOND read-only `gh` call, alongside the `ghPrView` one at step 1
  // above. That call was always there; "fetches nothing" never meant "talks
  // to GitHub zero times", only that nothing GIT-side happens. Overriding
  // the original all-aggregate estimate (PR1b Addition 1 / #5557): the
  // aggregate counters carry no per-file paths, so `.prheroignore`
  // exclusions were structurally impossible to apply here, and that gap
  // widens from "tens of lines" (lockfiles) to "potentially thousands" (a
  // whole ignored directory) the moment a user defines their own rules — a
  // dry run that says SKIP for a PR the real per-file run happily accepts
  // reads as a broken tool, not a conservative estimate.
  if (options.dryRun) {
    const hunterCount = dryRunHunterCount(spec, config);
    const estimate = estimateCost(
      target.ghDiffStat,
      hunterCount,
      summary.enabled,
      options.scout,
      0,
      true,
    );
    const dryRunGateConfig = sizeGateConfigFor(
      sizeGateOverrides,
      config,
      localIgnore,
    );
    // See resolvePrDryRunNumstat (src/pr/target.ts) for the full rationale —
    // the degrade-to-aggregate-estimate rule PR1b Addition 1 / #5557 needs
    // when `gh`'s per-file `files` list is truncated, unavailable, or the
    // fetch itself throws (GH_PR_VIEW_TIMEOUT_MS bounds it).
    const perFile = await resolvePrDryRunNumstat({
      fetchFiles: async () =>
        parsePrFiles(await ghPrFiles(operatorRoot, prNumber)),
      totalFiles: target.ghDiffStat.files,
    });
    // See renderPrDryRunPlan (src/pr/target.ts) for the full rationale.
    return renderPrDryRunPlan({
      options,
      operatorRoot,
      prNumber,
      target,
      worktreePath,
      repoHome,
      agentsDir,
      agentsDirSource,
      agentFiles,
      spec,
      config,
      summary,
      loaded,
      isCi,
      hunterCount,
      estimate,
      dryRunGateConfig,
      perFile,
    });
  }

  if (isCi) {
    try {
      ciAdmissionLedger = await reserveCiAdmissionLedger({
        operatorRoot,
        prNumber,
        headSha: target.headSha,
        policy: ciPolicy,
        policyHash: ciPolicyHash,
        existing: ledgerRecords,
        decisionReason: options.force
          ? "manual override (--force)"
          : "admission: run",
        forced: options.force === true,
      });
      holdCiAdmissionLedger(ciAdmissionLedger);
    } catch (error) {
      throw new CliError(
        `CI admission reservation failed: ${(error as Error).message}`,
      );
    }
  }

  const lockPath = worktreeLockPath(home, repoHome.repoId, prNumber);
  await acquirePidLock(lockPath);
  try {
    // 4 — fetch, then canonicalize, then the base-ref `.prheroignore` read.
    // See resolvePrFetchAndRange (src/pr/range.ts) for the full rationale —
    // fetchPrRefs's refspec pair, why baseSha must be resolveCommit's output
    // (never target.baseRef/baseRefName directly — a merged PR's baseRef is
    // a `<sha>^1` EXPRESSION), and design D1 (CI reads the ignore file at the
    // resolved base sha, never author-controlled; non-CI reuses the eager
    // `localIgnore` read above rather than re-reading).
    const { headSha, baseSha, diffFromSha, prIgnore, headLabel } =
      await resolvePrFetchAndRange({
        gitDirOwner,
        prNumber,
        target,
        isCi,
        localIgnore,
        runGit: git,
      });

    // 5 — last-reviewed head, the two deltas (D9), Phase B classification,
    // and the size gate over the discovery range. Discovery is the
    // restricted L..H intersection (or full B..H); the size gate counts
    // that same discovery diff, never the whole PR, so a merge of main
    // cannot inflate the bill. Empty discovery is a re-review state, not
    // an error (C6) — first review (case A) still fails loud. See
    // resolvePrDiscovery (src/pr/discovery.ts) for the full rationale; the
    // three comment fetches stay here (its own header explains why).
    const [issueComments, postedFindings, reviewComments] = await Promise.all([
      fetchPrComments(operatorRoot, prNumber),
      fetchPostedFindingComments(operatorRoot, prNumber),
      fetchPrReviewComments(operatorRoot, prNumber),
    ]);
    const {
      prepared,
      skipDiscovery,
      rawDiff,
      effectiveDiff,
      anchorPatch,
      gateConfig,
      rereview,
      verifyQueue,
      overlapCandidates,
      adjudicationQueue,
      phaseB,
      diffStat,
      sizeGate,
    } = await resolvePrDiscovery({
      diffFromSha,
      headSha,
      full: options.full,
      adjudicate: options.adjudicate === true,
      baseRef: target.baseRef,
      headLabel,
      isCi,
      sizeGateOverrides,
      config,
      prIgnore,
      issueComments,
      postedFindings,
      reviewComments,
      git: {
        commitExists: (sha) => gitCommitExists(gitDirOwner, sha),
        isAncestor: (ancestor, descendant) =>
          gitIsAncestor(gitDirOwner, ancestor, descendant),
        nameOnly: (from, to) => gitNameOnly(gitDirOwner, from, to),
        nameStatus: (from, to) => gitNameStatus(gitDirOwner, from, to),
        runGit: (args) => git(gitDirOwner, args),
      },
      log,
    });

    // 5b(CI) — the assistant-posture branch, BEFORE applySizeGate: outside
    // CI, a hard skip in non-interactive mode THROWS a CliError (see
    // applySizeGate below), which the top-level catch turns into exit 1 —
    // exactly the "blocks CI" behavior spec 2.1 forbids. `--force` bypasses
    // here too, same as the non-CI path just below, since it answers the
    // same question ("is this diff too big to be worth its cost") either
    // way. planCiSizeSkip (ci/gates.ts) is the ONE call: it is null unless
    // isCi && the gate actually failed, so no separate isCi guard is needed
    // around it beyond --force.
    if (!options.force) {
      const sizePlan = planCiSizeSkip({
        isCi,
        verdict: sizeGate,
        prNumber,
        maxChangedLines: gateConfig.maxChangedLines,
        maxChangedFiles: gateConfig.maxChangedFiles,
        ciMode,
      });
      if (sizePlan !== null) {
        await settleCiGateSkip(
          ciAdmissionLedger,
          "diff exceeds the configured size gate",
        );
        return await publishCiSkip({
          operatorRoot,
          prNumber,
          post: options.post === true,
          isCi,
          stepSummaryFlag: options.stepSummary,
          plan: sizePlan,
          noticeMessage:
            "pr-hero review skipped — diff exceeds the configured size gate",
          ciMode,
          headSha,
        });
      }
    }

    // 5b — the size gate, on the REAL per-file numstat and placed here on
    // purpose: before createPrRunDir, so a skipped PR leaves no run dir
    // behind. That matters beyond tidiness — the watcher counts attempts from
    // run artifacts, so a gate skip cannot consume a poison-PR attempt even
    // when the watcher was the one that launched this review. Unattended
    // (--yes) still skips with no prompt; an interactive TTY is asked first.
    // A hard skip (and the interactive prompt) never reach the plan, so the
    // verdict states itself here. --force falls through and the plan's
    // decision block prints the same line plus the override note.
    const sizeGateChoice = await applySizeGate(sizeGate, options, () => {
      log(sizeGateLine(sizeGate));
      // The shell owns BOTH impure decisions here (style flag and width), the
      // same way printDryRun does — this is the one exclusion line that is
      // printed outside a plan renderer, so it cannot inherit a resolved width
      // from one.
      for (const line of exclusionLines(
        effectiveDiff.droppedPaths,
        styleEnabled(),
        terminalWidth(),
      )) {
        log(line);
      }
    });
    if (sizeGateChoice === "abort") return 1;
    const sizeGateConfirmed = !sizeGate.ok && !options.force;

    // Cross-machine TOCTOU: another pr-hero review already in flight on this
    // head. A stand-down settles the CI ledger as `yielded`, never leaving it
    // for teardown to mark `failed`. See yieldToInFlightReview
    // (src/pr/ci-admission-gate.ts) for the full rationale.
    const inFlightExit = await yieldToInFlightReview({
      operatorRoot,
      headSha,
      options,
      statusContext,
      ciAdmissionLedger,
    });
    if (inFlightExit !== undefined) return inFlightExit;

    // 6 — run dir + diff artifact (PR naming; outside BOTH roots).
    const runDir = await createPrRunDir(
      options,
      operatorRoot,
      worktreePath,
      repoHome.paths.runs,
      prNumber,
      headSha,
    );
    // diff.patch is the EFFECTIVE diff — exactly what the hunters read (see
    // filterDiffByIgnoreRules); diff.raw.patch preserves the unfiltered
    // bytes, and only when the filter actually dropped something.
    const diffPath = path.join(runDir, "diff.patch");
    await Bun.write(diffPath, effectiveDiff.patch);
    // anchor.patch is the full PR diff inline comments anchor against (see
    // resolvePrDiscovery). post --from and triage read it, falling back to
    // diff.patch for run dirs written before it existed.
    await Bun.write(path.join(runDir, "anchor.patch"), anchorPatch);
    if (effectiveDiff.droppedPaths.length > 0) {
      await Bun.write(path.join(runDir, "diff.raw.patch"), rawDiff);
    }

    // 7 — the plan and the paid gate, exactly like local mode but with the
    // real numstat replacing GitHub's counters.
    const parityFires = resolveParityFires(
      effectiveDiff.patch,
      config.parity_trigger_paths,
    );
    const activeHunters = discoveryHunters({
      skipDiscovery,
      agents: spec.agents,
      parityFires,
    });
    const hunterCount = activeHunters.length;
    // See resolvePrPlanAndConfirm (src/pr/plan.ts) for the full rationale —
    // the CI budget gate, route/capability resolution, the plan card, the
    // interactive confirm, and the "committed to spending" commit-status
    // hold that follows a successful one.
    const planResult = await resolvePrPlanAndConfirm({
      options,
      operatorRoot,
      prNumber,
      target,
      worktreePath,
      runDir,
      headSha,
      baseSha,
      diffFromSha,
      diffPath,
      diffStat,
      droppedPaths: effectiveDiff.droppedPaths,
      sizeGate,
      sizeGateConfirmed,
      agentsDir,
      agentsDirSource,
      agentFiles,
      spec,
      config,
      summary,
      loaded,
      isCi,
      ciMode,
      statusContext,
      ciBudgetCeiling,
      ciAdmissionLedger,
      skipDiscovery,
      hunterCount,
      parityFires,
      verifyQueue,
      prepared,
    });
    if (planResult.exitCode !== undefined) return planResult.exitCode;
    const {
      postEnabled,
      routePlan,
      productionAdmission,
      runnerAuthority,
      maxVerificationSteps,
      estimate,
      statusTargetUrl,
      freeRoute,
    } = planResult;

    let result: PipelineResult | undefined;
    let posted: InlinePostOutcome | null = null;
    // S4: written by publishRunOutcome's onBlockingCount sink, read by the
    // commit-status finally. Null until the findings doc exists.
    let blockingCount: number | null = null;
    // Set by the catch below, read by the commit-status finally: a body that threw
    // must keep its own error, so a failed status write there only logs.
    let bodyFailed = false;
    try {
      // 8-10 — the review root, its own codegraph index, and the MCP
      // registry the hunters read. See setupPrWorktree
      // (src/pr/worktree-setup.ts) for the full rationale.
      const { mcpConfigPath, indexMs } = await setupPrWorktree({
        gitDirOwner,
        worktreePath,
        headSha,
        registryPath: repoHome.paths.registry,
        prNumber,
        runDir,
      });

      // 11 — run, with live progress (same shape as local mode's leg). The
      // pipeline is untouched beyond the observational tap: it gets the worktree
      // as its cwd and the PR's real number for the envelope.
      // Spec 2.1: "Progress updates MUST use GitHub Actions log workflow
      // groups (`::group::` / `::endgroup::`) to structure runner logs
      // cleanly." One group around the whole hunt+refute run is the minimum
      // that satisfies it. The arm and the close both live inside
      // withCiWorkflowGroup rather than at this call site, and EVERY
      // statement of the setup below sits inside its body: the progress
      // renderer and registerActiveRun (whose mkdirSync/writeFileSync are
      // unguarded) can throw on a read-only or full runner filesystem, and
      // anything armed-but-not-yet-guarded there folds the whole rest of the
      // job log — the `::error::` annotation naming the cause included —
      // into a group nothing ever closes.
      let started = 0;
      await withCiWorkflowGroup(isCi, "pr-hero review", log, async () => {
        log(reviewingLine(hunterCount, summary, options));
        // runnerAuthority resolved before confirm with the exact-binding gate.
        if (runnerAuthority.error !== undefined) {
          throw new CliError(
            `execution authority unavailable: ${runnerAuthority.error}`,
          );
        }
        // §5.3 D1-10b: one controller shared by the pipeline and the runner,
        // exactly as in local mode — the ceiling aborts it and the harness
        // reads the same signal.
        const ceilingController = new AbortController();
        let productionRuntime: ProductionRuntime | undefined;
        started = performance.now();
        const progress = startProgressRenderer(
          started,
          `PR #${prNumber}`,
          activeHunters.map((a) => a.key),
          spec.agents.some((a) => a.role === "refuter"),
          summary.enabled,
        );
        try {
          const prepared = await prepareRunnerForRoute({
            routePlan,
            productionAdmission,
            workspaceRoot: worktreePath,
            runnerAuthority,
            ceilingController,
            onProgress: progress.onProgress,
            maxConcurrentSteps: resolveMaxConcurrentSteps(config),
          });
          productionRuntime = prepared.productionRuntime;
          // registerActiveRun rides INSIDE this try, not before it: the
          // renderer is already ticking by now, and a throw here used to
          // leak its 250ms interval — which keeps the event loop alive and
          // hangs process exit, the exact failure the finally below exists
          // to prevent.
          await registerActiveRun({
            pid: process.pid,
            repo: repoHome.paths.repoId ?? path.basename(gitDirOwner),
            pr: prNumber,
            runDir,
            startedAt: new Date().toISOString(),
          });
          await settleCiAdmissionLedger(
            ciAdmissionLedger,
            "provider-started",
            "pipeline starting",
          );
          result = await runPipeline(
            {
              pr: prNumber,
              // Same rule as local mode: record the commit the diff was actually
              // computed against, or nothing downstream can reproduce the range.
              baseSha: diffFromSha,
              headSha,
              worktree: worktreePath,
              diffPath,
              excludedPaths: effectiveDiff.droppedPaths,
              exclusions: effectiveDiff.exclusions,
              ignoreFile: {
                readFrom: isCi ? "base-ref" : "working-tree",
                ...(isCi ? { ref: baseSha } : {}),
                found: prIgnore.found,
              },
              gotchasPath,
              agentsDir,
              ...(agents.files ? { agentFiles: agents.files } : {}),
              runDir,
              outPath: path.join(runDir, "findings.json"),
              mcpConfigPath,
              hopBudget: options.hopBudget,
              ...(options.model ? { model: options.model } : {}),
              parityTriggerPaths: config.parity_trigger_paths,
              suspicionPriors: config.suspicion_priors,
              ...(skipDiscovery ? {} : pipelineSummarizerInput(summary)),
              ...(skipDiscovery ? {} : pipelineScoutInput(options)),
              ...(skipDiscovery ? {} : pipelineConsolidateInput()),
              ...(resolveSharedPrefix(options) ? { sharedPrefix: true } : {}),
              // NOT gated on skipDiscovery: an empty-delta re-review still
              // classifies and verifies against this config, and a run whose
              // artifact cannot name its config inputs is the unpoolable case
              // D7 exists to prevent — whether or not hunters fanned out.
              ...pipelineConfigInput(loaded),
              ...(routePlan === undefined ? {} : { routePlan }),
              engine: await engineIdentity(),
              promptSet,
              spec,
              ...(skipDiscovery ? { skipDiscovery: true } : {}),
              ...(rereview === undefined ? {} : { rereview }),
              ...(verifyQueue.length > 0 ? { verifyQueue } : {}),
              ...(overlapCandidates.length > 0 ? { overlapCandidates } : {}),
              ...(adjudicationQueue.length > 0 ? { adjudicationQueue } : {}),
              maxVerificationSteps,
              ...(phaseB === undefined ? {} : { phaseB }),
            },
            prepared.deps,
          );
        } finally {
          // try/finally, never success-only: a leaked interval keeps the
          // event loop alive and hangs process exit on the error path.
          // `::endgroup::` is no longer emitted here — it rides
          // withCiWorkflowGroup's own finally, which wraps this whole block.
          progress.stop();
          await unregisterActiveRun(process.pid);
          if (productionRuntime !== undefined) {
            await productionRuntime.dispose();
          }
        }
      });
      recordPipelineOutcome(result, headSha);
      // 12-16 — everything from the artifact write through CI publishing and
      // the ledger's terminal settlement. See publishRunOutcome
      // (src/pr/publish-outcome.ts) for the full rationale, including the
      // `onPosted` hazard: `posted` is declared outside this try (the
      // finally below reads it on every exit path, including a throw from
      // inside publishRunOutcome itself), so the callback assigns it the
      // instant the posting stage resolves — never only at the end.
      //
      // `await`, never a bare `return publishRunOutcome(...)`: this
      // sits inside a try/finally, and a bare `return` hands back the
      // pending promise WITHOUT suspending here, so the `finally` below runs
      // synchronously right away — before publishRunOutcome has done
      // anything, let alone fired `onPosted`. That would settle the commit
      // status (and read `posted`) against pre-run state on every call, not
      // just on a throw. The `await` is what makes this function actually
      // wait for publishRunOutcome to settle before the finally can run.
      const exitCode = await publishRunOutcome({
        result,
        started,
        indexMs,
        runDir,
        prNumber,
        diffFromSha,
        headSha,
        options,
        agentFiles,
        promptSet,
        operatorRoot,
        baseRef: target.baseRef,
        diffStat,
        droppedPaths: effectiveDiff.droppedPaths,
        diffPatch: anchorPatch,
        home,
        repoId: repoHome.repoId,
        postEnabled,
        rereview,
        phaseB,
        gitDirOwner,
        worktreePath,
        isCi,
        ciMode,
        estimate,
        freeRoute,
        ciAdmissionLedger,
        onPosted: (outcome) => {
          posted = outcome;
        },
        onBlockingCount: (count) => {
          blockingCount = count;
        },
      });
      // T5b: the verdicts are posted only after the review itself published.
      // Only a `--ci` run with posting on writes them to the PR.
      if (postEnabled && options.ci === true) {
        // The verdicts never change this run's count: the next review of this head
        // reads them back (see fillRereviewProvenance).
        await postAdjudicationReplies({
          operatorRoot,
          pr: prNumber,
          headSha,
          adjudications: result?.adjudications ?? [],
        });
      }
      return exitCode;
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      // The commit status must settle BEFORE the lock is released, and the
      // ledger settlement must still run on throw or early return. See
      // settleCommitStatusAndLedger (src/pr/teardown.ts) for the full
      // rationale, including why a failed write never replaces a body's error.
      await settleCommitStatusAndLedger({
        result,
        posted,
        operatorRoot,
        headSha,
        statusTargetUrl,
        ciAdmissionLedger,
        ciMode,
        statusContext,
        blockingCount,
        bodyFailed,
      });
    }
  } finally {
    // See finalizePrReviewRun (src/pr/teardown.ts) for the full rationale.
    await finalizePrReviewRun({
      ciAdmissionLedger,
      lockPath,
      home,
      repoId: repoHome.repoId,
    });
  }
}
