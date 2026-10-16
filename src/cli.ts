#!/usr/bin/env bun
// Local mode (ROADMAP B0): point the engine at a real repo + branch and get a
// human-readable review back. The lab drives this engine to MEASURE it; this
// is the other consumer — a developer, on their own tree, before the PR.
//
// The shape here is deliberate: every pure decision lives in preflight.ts and
// report.ts, and this file is the I/O shell — git, filesystem, stdin, spawn.
// That split is why the whole preflight can be tested offline, which matters
// more than usual when the alternative is testing it live at ~$10 a run.
//
// Two hard rules run through the sequence below:
//   1. every failure is loud and lands BEFORE any spend, and
//   2. human-readable output goes to stderr so stdout stays clean.
//
// cli-decomp Phase 2 (odd/tasks/cli-decomposition.md) moved the three
// orchestrators that used to live here — review(), reviewPr(), menuCommand()
// — out to their own domain modules (src/review/review.ts, src/pr/review-pr.ts,
// src/commands/menu.ts). This file now holds only the entry points: main()
// (argv parsing + command dispatch) and runCli() (signal handling + process
// exit).

import { activityCommand } from "#commands/activity";
import { ciSetupCommand } from "#commands/ci-setup";
import { configCommand } from "#commands/config";
import { doctorCommand } from "#commands/doctor";
import { init } from "#commands/init";
import { ledgerCommand } from "#commands/ledger";
import { mcpCommand } from "#commands/mcp";
import { menuCommand } from "#commands/menu";
import { postCommand } from "#commands/post";
import { triageCommand } from "#commands/triage";
import { uninstallCommand } from "#commands/uninstall";
import { upgradeCommand } from "#commands/upgrade";
import { usageCommand } from "#commands/usage";
import { resolveOptionalRepoRoot } from "#config/config";
import { corpusCommand } from "#corpus/corpus";
import { settleHeldAdmissionLedgerOnSignal } from "#pr/admission";
import {
  type PrDryRunSizeGateResult,
  resolvePrDryRunSizeGate,
} from "#pr/preflight";
import { revertsCommand } from "#pr/reverts";
import {
  heldCommitStatusLock,
  holdCommitStatusLock,
  releaseCommitStatusLock,
  settleHeldCommitStatusOnSignal,
} from "#pr/status";

export {
  heldCommitStatusLock,
  holdCommitStatusLock,
  type PrDryRunSizeGateResult,
  releaseCommitStatusLock,
  resolvePrDryRunSizeGate,
  settleHeldCommitStatusOnSignal,
};

import { classifyCliError } from "#ci/classify-error";
import { writeFatalCliRecord } from "#ci/cli-record";
import {
  reportFatalCiError,
  reportFatalCiErrorIfInJobStep,
} from "#ci/reporter";
import {
  createRunDir,
  DEFAULT_HEAD_REF,
  DEFAULT_HOP_BUDGET,
  HELP_TEXT,
  parseArgs,
  preflightAgentsDir,
  resolveAgentsDir,
} from "#review/preflight";
import { CliError, CliUsageError } from "./errors";

export { createRunDir, preflightAgentsDir, resolveAgentsDir };

import {
  type ProductionRoutePlanResult,
  pipelineScoutInput,
  pipelineSummarizerInput,
  resolveProductionRoutePlanAtConfirm,
  resolveRoutePlanAtConfirm,
} from "#review/route-preflight";

export {
  type ProductionRoutePlanResult,
  pipelineScoutInput,
  pipelineSummarizerInput,
  resolveProductionRoutePlanAtConfirm,
  resolveRoutePlanAtConfirm,
};

import { review } from "#review/review";
import { unregisterActiveRun } from "#store/activity";
import { gcCommand } from "#store/gc";
import {
  type ConfigProvenance,
  configProvenanceOf,
  dryRunHunterCount,
  type PlanContext,
  type PrPlanContext,
  planDetails,
  prPlanDetails,
  renderPlan,
  renderPrPlan,
} from "#ui/plan";

export {
  type ConfigProvenance,
  configProvenanceOf,
  dryRunHunterCount,
  type PlanContext,
  type PrPlanContext,
  planDetails,
  prPlanDetails,
  renderPlan,
  renderPrPlan,
};

import { log, terminalWidth } from "#ui/primitives";
import { startPanelRenderer } from "#ui/progress";

export { startPanelRenderer };

import { watchCommand } from "#watch/watch";
import { killAllChildProcesses } from "./execution/spawned-process";
import { isMachineOnboarded, runWizard } from "./wizard";

// bin/pr-hero.js and the `import.meta.main` guard both go through the exported
// runCli() below, which is this function's only production caller. It is
// exported all the same because cli.test.ts drives it directly — a test IS a
// real consumer (project rule 3), and it is the only way to prove the two
// internal catches below write `status=error` without spawning a subprocess
// and guessing at its exit code.
export async function main(argv: string[]): Promise<number> {
  // Bare zero-argument entry
  if (argv.length === 0) {
    if (process.env.PRHERO_NO_TUI !== undefined) {
      log(HELP_TEXT);
      return 0;
    }
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      log(HELP_TEXT);
      log();
      log("error: no command given (interactive TTY required for menu)");
      return 2;
    }
    if (terminalWidth() < 24) {
      log("terminal too narrow (width < 24 columns)");
      log();
      log(HELP_TEXT);
      return 2;
    }
    if (!isMachineOnboarded()) {
      return await runWizard();
    }
    return await menuCommand({
      repo: ".",
      head: DEFAULT_HEAD_REF,
      hopBudget: DEFAULT_HOP_BUDGET,
      scout: false,
      full: false,
      dryRun: false,
      yes: false,
      post: false,
      twoDot: false,
      onPush: false,
      force: false,
      all: false,
      fixes: false,
      incidents: false,
      issues: false,
      proximity: false,
      threads: false,
    });
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    log(HELP_TEXT);
    log();
    log(`error: ${(error as Error).message}`);
    await reportFatalCiErrorIfInJobStep(error);
    return 2;
  }
  if (parsed.command === "help") {
    log(HELP_TEXT);
    return 0;
  }
  if (parsed.command === "menu") {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      log(HELP_TEXT);
      log();
      log("error: interactive TTY required for menu");
      return 2;
    }
    if (terminalWidth() < 24) {
      log("terminal too narrow (width < 24 columns)");
      log();
      log(HELP_TEXT);
      return 2;
    }
    return await menuCommand(parsed.options);
  }
  try {
    return parsed.command === "init"
      ? await init(parsed.options)
      : parsed.command === "setup"
        ? parsed.options.ci
          ? await ciSetupCommand(parsed.options)
          : await runWizard({
              cwd:
                (await resolveOptionalRepoRoot(parsed.options)) ??
                process.cwd(),
            })
        : parsed.command === "ci"
          ? await ciSetupCommand(parsed.options)
          : parsed.command === "doctor"
            ? await doctorCommand(parsed.options)
            : parsed.command === "activity"
              ? await activityCommand(parsed.options)
              : parsed.command === "ledger"
                ? await ledgerCommand(parsed.options)
                : parsed.command === "watch"
                  ? await watchCommand(parsed.options)
                  : parsed.command === "post"
                    ? await postCommand(parsed.options)
                    : parsed.command === "triage"
                      ? await triageCommand(parsed.options)
                      : parsed.command === "gc"
                        ? await gcCommand(parsed.options)
                        : parsed.command === "usage"
                          ? await usageCommand(parsed.options)
                          : parsed.command === "reverts"
                            ? await revertsCommand(parsed.options)
                            : parsed.command === "corpus"
                              ? await corpusCommand(parsed.options)
                              : parsed.command === "config"
                                ? await configCommand(parsed.options)
                                : parsed.command === "mcp"
                                  ? await mcpCommand(parsed.options)
                                  : parsed.command === "upgrade"
                                    ? await upgradeCommand(parsed.options)
                                    : parsed.command === "uninstall"
                                      ? await uninstallCommand(parsed.options)
                                      : await review(parsed.options);
  } catch (error) {
    if (error instanceof CliError || error instanceof CliUsageError) {
      writeFatalCliRecord(classifyCliError(error));
      log(`error: ${error.message}`);
      await reportFatalCiErrorIfInJobStep(error);
      return 1;
    }
    throw error;
  }
}

// Exported so bin/pr-hero.js can drive the exact same signal-handling +
// exit-code path as a direct `bun run src/cli.ts` invocation. `bun bin/pr-hero.js
// ...` (the npm-installed entrypoint) reaches this file through `import`, and
// `import.meta.main` is false for every imported module — only the directly
// executed entry file gets `true` — so the guard below never ran for it and the
// installed `pr-hero` command was a silent, zero-output, exit-0 no-op. Covered
// by packaging.test.ts's subprocess spawn of bin/pr-hero.js.
export async function runCli(
  argv: string[] = Bun.argv.slice(2),
): Promise<void> {
  const restoreCursor = () => {
    try {
      process.stderr.write("\x1b[?25h");
    } catch {
      // Ignore
    }
  };
  process.on("SIGTERM", async () => {
    restoreCursor();
    try {
      killAllChildProcesses();
      await unregisterActiveRun(process.pid);
    } catch {
      // Ignore
    }
    // After killing the children (stop spending first), before exiting: the
    // in-flight lock this process took is released by its holder, or the next
    // run skips the head for the rest of the 90-minute TTL (#146).
    await settleHeldCommitStatusOnSignal();
    await settleHeldAdmissionLedgerOnSignal();
    process.exit(143);
  });
  process.on("SIGINT", async () => {
    restoreCursor();
    try {
      killAllChildProcesses();
      await unregisterActiveRun(process.pid);
    } catch {
      // Ignore
    }
    await settleHeldCommitStatusOnSignal();
    await settleHeldAdmissionLedgerOnSignal();
    process.exit(130);
  });
  process.on("exit", () => {
    restoreCursor();
  });
  let exitCode: number;
  try {
    exitCode = await main(argv);
  } catch (error) {
    // Before the rethrow below, and whatever GITHUB_OUTPUT says: a crash in
    // action mode is the record's to name, unless this job already recorded its
    // terminal outcome (writeFatalCliRecord keeps that one).
    writeFatalCliRecord(classifyCliError(error));
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath === undefined || outputPath.length === 0) {
      // Not a real GitHub Actions job step — preserve the original
      // uncaught-exception path so a local `bun run src/cli.ts` crash still
      // prints its full stack trace instead of a swallowed one-line message.
      throw error;
    }
    await reportFatalCiError(error, outputPath);
    exitCode = 1;
  }
  process.exit(exitCode);
}

// Only when executed, never on import — the pure helpers (and runCli itself)
// stay importable from tests / bin/pr-hero.js without the CLI trying to run a
// review as a side effect of the import.
if (import.meta.main) {
  await runCli();
}
