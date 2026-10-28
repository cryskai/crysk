import { existsSync } from "node:fs";
import path from "node:path";
import {
  budgetInput,
  type CiSetupChoices,
  type CurrentSettings,
  configPlan,
  defaultChoices,
  parseWorkflowChoices,
  renderChoicesSummary,
} from "#ci/review-levels";
import {
  appendIgnorePatterns,
  CI_WORKFLOW_RELATIVE_PATH,
  ignorePatternsError,
  runCiSetup,
  writeRepoReviewConfig,
} from "#ci/setup";
import { resolveOptionalRepoRoot } from "#config/config";
import {
  type CliOptions,
  GOTCHAS_PLACEHOLDER_MARKER,
  gotchasUnusableReason,
} from "#review/preflight";
import { log } from "#ui/primitives";
import { CliError } from "../errors";
import {
  checkGhStatus,
  type InstallResult,
  installSystemTool,
  type SystemToolStatus,
} from "../system-tools";
import {
  askChoices,
  choicesFromFlags,
  type SetupPrompter,
  terminalPrompter,
} from "./ci-setup-questions";

// What the gh check talks to, injectable so its every branch runs offline.
export interface GhPreflightDeps {
  check: () => Promise<SystemToolStatus>;
  // A human at a terminal. Agents run `setup --ci` with no TTY and must never
  // be left waiting on a prompt, so they only get the printed instructions.
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  install: () => Promise<InstallResult>;
  login: () => Promise<number>;
  installCommand: string;
  // Only where installSystemTool can actually install it (macOS with brew).
  // Elsewhere it would just hand back a manual command, so nothing is offered.
  canAutoInstall: boolean;
  log: (line?: string) => void;
}

const GH_WHY =
  "pr-hero's CI loop needs it on this machine: to add the repository secret (gh secret set), and after a pull request opens, to wait for its review (pr-hero status) and answer the findings (pr-hero triage reply).";

// Never blocks and never changes the exit code: the workflow file does not
// need gh, and a user may add the secret in GitHub's web UI instead.
export async function ghPreflight(deps: GhPreflightDeps): Promise<void> {
  let status = await deps.check();
  if (status.installed && status.authOk) return;
  const say = deps.log;
  say();
  say(
    `GitHub CLI (gh) is ${status.installed ? "not logged in" : "not installed"}. ${GH_WHY}`,
  );

  if (!status.installed) {
    let installCommand = deps.installCommand;
    if (
      deps.interactive &&
      deps.canAutoInstall &&
      (await deps.ask(`Install it now with \`${deps.installCommand}\`?`))
    ) {
      const result = await deps.install();
      installCommand = result.manualCommand ?? installCommand;
      if (!result.ok) {
        say(
          `The install failed${result.error ? `: ${result.error.trim()}` : "."}`,
        );
      }
      status = await deps.check();
    }
    if (!status.installed) {
      say(`  Install it: ${installCommand}`);
      say("  Then log in: gh auth login");
      return;
    }
  }

  if (!status.authOk) {
    if (deps.interactive && (await deps.ask("Run `gh auth login` now?"))) {
      await deps.login();
      status = await deps.check();
    }
    if (!status.authOk) {
      say("  Log in: gh auth login");
      return;
    }
  }
  say("gh is installed and logged in.");
}

async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [Y/n] `);
    return /^\s*(y|yes)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

function defaultGhPreflightDeps(): GhPreflightDeps {
  const canAutoInstall =
    process.platform === "darwin" && Bun.which("brew") !== null;
  return {
    check: () => checkGhStatus(),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: askYesNo,
    install: () => installSystemTool("gh"),
    login: async () => {
      // gh's own interactive login, on this terminal.
      const proc = Bun.spawn([Bun.which("gh") ?? "gh", "auth", "login"], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      return await proc.exited;
    },
    installCommand: canAutoInstall
      ? "brew install gh"
      : "see https://github.com/cli/cli#installation",
    canAutoInstall,
    log,
  };
}

// Shared shell for `pr-hero setup --ci` and `pr-hero ci init` — both are the
// same scaffolding action (runCiSetup), reached by two different command
// spellings. The refusal-without-force branch is a safety property (see
// spec.md §4.1 / ci/setup.ts's header comment), not a usage error, so it
// returns 1 rather than throwing CliUsageError: the invocation was valid,
// the outcome is just "nothing was written".
export interface CiSetupDeps {
  gh: GhPreflightDeps;
  // A person at a terminal gets the questions; anyone else gets flags or defaults.
  interactive: boolean;
  prompter: SetupPrompter;
}

function defaultCiSetupDeps(): CiSetupDeps {
  const gh = defaultGhPreflightDeps();
  return { gh, interactive: gh.interactive, prompter: terminalPrompter() };
}

// Flags win (an agent already asked the person), then a terminal's answers,
// then the defaults, which the summary reports as nobody's choice.
async function resolveChoices(
  options: CliOptions,
  deps: CiSetupDeps,
  current: CurrentSettings,
): Promise<CiSetupChoices> {
  const fromFlags = choicesFromFlags(options);
  const choices =
    fromFlags ??
    (deps.interactive
      ? await askChoices(deps.prompter, log, current)
      : defaultChoices());
  // A --force refresh rewrites the workflow; what nobody chose this run keeps
  // what the old workflow said, the same rule the config follows.
  if (!choices.chosen.mode && current.workflow.mode !== undefined) {
    choices.mode = current.workflow.mode;
  }
  if (!choices.chosen.billing && current.workflow.budgetUsd !== undefined) {
    choices.billing = "api";
    choices.budgetUsd = Number(current.workflow.budgetUsd);
  }
  return choices;
}

// What the repository says now. A config that is not valid JSON reads as
// empty here; writeRepoReviewConfig refuses it before anything is written.
async function readCurrentSettings(
  repoRoot: string,
  workflowPath: string,
): Promise<CurrentSettings> {
  let config: Record<string, unknown> = {};
  const configFile = Bun.file(path.join(repoRoot, ".prhero", "config.json"));
  if (await configFile.exists()) {
    try {
      const parsed: unknown = JSON.parse(await configFile.text());
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // refused later, by the writer
    }
  }
  const workflowFile = Bun.file(workflowPath);
  const workflow = (await workflowFile.exists())
    ? parseWorkflowChoices(await workflowFile.text())
    : {};
  return { config, workflow };
}

export async function ciSetupCommand(
  options: CliOptions,
  overrides: Partial<CiSetupDeps> = {},
): Promise<number> {
  const deps = { ...defaultCiSetupDeps(), ...overrides };
  const repoRoot = (await resolveOptionalRepoRoot(options)) ?? process.cwd();

  // Before any question: an existing workflow without --force writes nothing,
  // so asking first would collect answers that are then thrown away.
  const target = path.join(repoRoot, CI_WORKFLOW_RELATIVE_PATH);
  if (existsSync(target) && !options.force) {
    log(`${target} already exists.`);
    log(
      `${CI_WORKFLOW_RELATIVE_PATH} already exists; pass --force to overwrite it`,
    );
    return 1;
  }

  const current = await readCurrentSettings(repoRoot, target);
  const choices = await resolveChoices(options, deps, current);
  const budget = budgetInput(choices);
  // The config first: it is the write that can refuse (an invalid existing
  // file, a value the review parser rejects), and refusing before the workflow
  // is written leaves the repository as it was.
  const patterns = choices.advanced.ignorePatterns ?? [];
  const ignoreFile = Bun.file(path.join(repoRoot, ".prheroignore"));
  const patternProblem = ignorePatternsError(
    patterns,
    (await ignoreFile.exists()) ? await ignoreFile.text() : "",
  );
  if (patternProblem !== undefined) throw new CliError(patternProblem);
  const config = await writeRepoReviewConfig(repoRoot, configPlan(choices));
  const result = await runCiSetup({
    cwd: repoRoot,
    force: options.force,
    template: {
      mode: choices.mode,
      ...(budget === undefined ? {} : { budgetUsd: budget }),
    },
  });
  if (result.status === "skipped-existing") {
    log(`${result.path} already exists.`);
    log(result.hint);
    return 1;
  }

  log();
  log(
    result.status === "overwritten"
      ? `Overwrote ${result.path}`
      : `Created ${result.path}`,
  );
  log(`Updated ${config.file}`);
  if (patterns.length > 0) {
    log(`Updated ${await appendIgnorePatterns(repoRoot, patterns)}`);
  }
  log();
  for (const line of renderChoicesSummary(choices, config.kept)) log(line);
  // The summary describes the choices; these lines say where the file differs.
  for (const c of config.changed) {
    log(
      `Changed ${c.key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`,
    );
  }
  const keptKeys = Object.keys(config.kept);
  if (keptKeys.length > 0) {
    log(
      `Kept existing ${keptKeys.map((key) => `${key} ${JSON.stringify(config.kept[key])}`).join(", ")} in .prhero/config.json: nobody chose them this run (pass --level or --max-changed-lines, or answer in a terminal, to change them)`,
    );
  }
  log();
  log("Next steps:");
  let step = 0;
  const next = () => `  ${++step}.`;
  log(`${next()} Commit .github/workflows/pr-hero.yml and .prhero/config.json`);
  log(
    `${next()} Add a repository secret: ${
      choices.billing === "subscription"
        ? "CLAUDE_CODE_OAUTH_TOKEN (create it with `claude setup-token`)"
        : choices.billing === "api"
          ? "ANTHROPIC_API_KEY (or OPENCODE_AUTH_JSON for an OpenCode provider)"
          : "ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)"
    }`,
  );
  // The first PR of a new repository goes red without gotchas: every hunter's
  // prompt carries them, and PRH-GOTCHAS-MISSING refuses the review while the
  // file is absent or still the scaffold. So the init steps print only then;
  // a repo that already wrote real gotchas is not told to write them again.
  // Asked through gotchasUnusableReason, the one gate the review itself uses,
  // so a scaffold with no marker line gets the steps it will need.
  const gotchasPath = path.join(repoRoot, ".prhero", "gotchas.md");
  const gotchas = (await Bun.file(gotchasPath).exists())
    ? await Bun.file(gotchasPath).text()
    : undefined;
  if (gotchas === undefined || gotchasUnusableReason(gotchas) !== undefined) {
    log(
      `${next()} Run \`npx -y pr-hero init\` in a clone of the repository (it creates .prhero/config.json and .prhero/gotchas.md)`,
    );
    log(
      `${next()} Replace the placeholder lines in .prhero/gotchas.md with real facts about this repository, and delete the ${GOTCHAS_PLACEHOLDER_MARKER} marker line if it is there: pr-hero refuses to review the scaffold`,
    );
    log(
      `${next()} Commit .prhero/ to the default branch (comment-triggered runs read the base branch)`,
    );
  }
  // The check to require is `pr-hero` (the commit status, the gate), not the
  // `review` job, which stays green even when it finds blocking issues.
  log(
    `${next()} In branch protection, require the \`pr-hero\` status check (not the \`review\` job); a private repository on GitHub Free cannot require status checks`,
  );
  log(`${next()} Open a pull request to trigger the workflow`);
  // GitHub reads a comment-triggered workflow from the DEFAULT branch, so a
  // `/pr-hero review` on a pull request that only ADDS this file starts
  // nothing, with no error anywhere. Said here because this is where a new
  // user first reads how to force a review.
  log(
    `${next()} Comment /pr-hero review on a pull request to force a review; it works once this file is on the default branch`,
  );
  // Last, so a prompt it may show comes after everything above is printed.
  await ghPreflight(deps.gh);
  return 0;
}
