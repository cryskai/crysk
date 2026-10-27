// The questions `setup --ci` asks a person at a terminal, and how flags stand in
// for them when an agent runs it. The answers are plain data (CiSetupChoices);
// src/ci/review-levels.ts turns them into config keys and workflow inputs.

import { CI_DEFAULT_METERED_BUDGET_USD } from "#ci/gates";
import {
  DEFAULT_CI_ADVISORY_WEIGHT,
  DEFAULT_CI_BLOCKING_WEIGHT,
} from "#ci/review-admission";
import {
  type AdvancedChoices,
  type Billing,
  type CiSetupChoices,
  DEFAULT_MAX_CHANGED_LINES,
  DEFAULT_REVIEW_LEVEL,
  defaultChoices,
  REVIEW_LEVEL_ORDER,
  REVIEW_LEVELS,
  type ReviewLevel,
} from "#ci/review-levels";
import type { CliOptions } from "#review/preflight";

export interface PromptOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

// Injectable so every question runs offline.
export interface SetupPrompter {
  choose<T extends string>(
    question: string,
    options: readonly PromptOption<T>[],
    defaultValue: T,
  ): Promise<T>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  text(question: string, defaultValue: string): Promise<string>;
}

// Choices passed as flags, for an agent that already asked the person.
// Any one of them means someone chose, so nothing is reported as a default.
export function choicesFromFlags(
  options: Pick<
    CliOptions,
    "reviewLevel" | "ciMode" | "billing" | "budgetUsd" | "maxChangedLines"
  >,
): CiSetupChoices | undefined {
  const given =
    options.reviewLevel !== undefined ||
    options.ciMode !== undefined ||
    options.billing !== undefined ||
    options.budgetUsd !== undefined ||
    options.maxChangedLines !== undefined;
  if (!given) return undefined;
  const billing: Billing | undefined =
    options.billing ?? (options.budgetUsd !== undefined ? "api" : undefined);
  return {
    level: options.reviewLevel ?? DEFAULT_REVIEW_LEVEL,
    mode: options.ciMode ?? "gate",
    ...(billing === undefined ? {} : { billing }),
    ...(options.budgetUsd === undefined
      ? {}
      : { budgetUsd: options.budgetUsd }),
    maxChangedLines: options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES,
    advanced: {},
    defaulted: false,
  };
}

// Re-asks until `parse` accepts the answer; an empty answer takes the default.
async function askValue<T>(
  prompter: SetupPrompter,
  question: string,
  defaultValue: string,
  parse: (raw: string) => T | undefined,
  say: (line?: string) => void,
  hint: string,
): Promise<T> {
  for (;;) {
    const raw = (await prompter.text(question, defaultValue)).trim();
    const value = parse(raw === "" ? defaultValue : raw);
    if (value !== undefined) return value;
    say(`  ${hint}`);
  }
}

function integerAtLeast(min: number): (raw: string) => number | undefined {
  return (raw) => {
    if (!/^\d+$/.test(raw)) return undefined;
    const n = Number(raw);
    return n >= min ? n : undefined;
  };
}

// "" means "leave it to the default resolution".
function optionalLimit(raw: string): number | null | undefined {
  if (raw === "") return null;
  return integerAtLeast(0)(raw);
}

function commaList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function askChoices(
  prompter: SetupPrompter,
  say: (line?: string) => void,
): Promise<CiSetupChoices> {
  const choices = defaultChoices();
  choices.defaulted = false;

  say();
  say("How should pr-hero re-review a pull request after new pushes?");
  choices.level = await prompter.choose<ReviewLevel>(
    "Re-review level",
    REVIEW_LEVEL_ORDER.map((value) => ({
      value,
      label: REVIEW_LEVELS[value].label,
      description: REVIEW_LEVELS[value].description,
    })),
    DEFAULT_REVIEW_LEVEL,
  );

  choices.mode = await prompter.choose<"gate" | "advisory">(
    "Should blocking findings block the merge?",
    [
      {
        value: "gate",
        label: "Gate",
        description:
          "Blocking findings turn the pr-hero check red. Require it in branch protection to block merges.",
      },
      {
        value: "advisory",
        label: "Advisory",
        description:
          "The pr-hero check stays green; findings are comments only.",
      },
    ],
    "gate",
  );

  choices.billing = await prompter.choose<Billing>(
    "How will CI pay for reviews?",
    [
      {
        value: "subscription",
        label: "Claude subscription",
        description:
          "CLAUDE_CODE_OAUTH_TOKEN. Reviews spend quota, not dollars.",
      },
      {
        value: "api",
        label: "API key",
        description:
          "ANTHROPIC_API_KEY or an OpenCode provider. Reviews are billed per token.",
      },
    ],
    "subscription",
  );
  if (choices.billing === "subscription") {
    say(
      "  No spend ceiling: a subscription review spends quota, not dollars, so the workflow gets budget-usd: 0.",
    );
  } else {
    choices.budgetUsd = await askValue(
      prompter,
      "Spend ceiling per review in USD (0 = none)",
      String(CI_DEFAULT_METERED_BUDGET_USD),
      (raw) => {
        const n = Number(raw);
        return raw !== "" && Number.isFinite(n) ? n : undefined;
      },
      say,
      "Enter a number, for example 10 or 7.5.",
    );
  }

  say();
  say(
    "Size threshold: a PR with more changed lines than this is skipped, not reviewed. It applies on any billing: without it a subscription reviews any size.",
  );
  choices.maxChangedLines = await askValue(
    prompter,
    "Max changed lines per review (0 = no limit)",
    String(DEFAULT_MAX_CHANGED_LINES),
    integerAtLeast(0),
    say,
    "Enter a whole number, 0 or more.",
  );

  say();
  say(
    "Advanced settings: score weights, observe-only mode, trusted actors, the changed-files limit, and exclusions. Each has a default that works.",
  );
  if (await prompter.confirm("Review the advanced settings now?", false)) {
    choices.advanced = await askAdvanced(prompter, say);
  }
  return choices;
}

async function askAdvanced(
  prompter: SetupPrompter,
  say: (line?: string) => void,
): Promise<AdvancedChoices> {
  const advanced: AdvancedChoices = {};

  say();
  say(
    "Score weights: a re-review runs when blocking x weight + advisory x weight reaches the score floor (risk-aware and thresholded policies only).",
  );
  const blocking = await askValue(
    prompter,
    "Weight of a blocking finding",
    String(DEFAULT_CI_BLOCKING_WEIGHT),
    integerAtLeast(1),
    say,
    "Enter a whole number, 1 or more.",
  );
  if (blocking !== DEFAULT_CI_BLOCKING_WEIGHT) {
    advanced.ci_blocking_weight = blocking;
  }
  const advisory = await askValue(
    prompter,
    "Weight of an advisory finding",
    String(DEFAULT_CI_ADVISORY_WEIGHT),
    integerAtLeast(1),
    say,
    "Enter a whole number, 1 or more.",
  );
  if (advisory !== DEFAULT_CI_ADVISORY_WEIGHT) {
    advanced.ci_advisory_weight = advisory;
  }

  say();
  say(
    "Observe only: log what the re-review rules would skip, but review every push anyway. Useful for one PR cycle while you tune them.",
  );
  if (await prompter.confirm("Turn on observe-only mode?", false)) {
    advanced.ci_admission_observe_only = true;
  }

  say();
  say(
    "Trusted actors: extra GitHub logins (bots, other automation) whose pr-hero markers count, besides the workflow's own actor.",
  );
  const actors = commaList(
    await prompter.text("Trusted actors, comma-separated (empty = none)", ""),
  );
  if (actors.length > 0) advanced.ci_trusted_actors = actors;

  say();
  say(
    "Changed-files limit: a PR touching more files is skipped. Empty keeps the default (none on a subscription, 50 on an API key).",
  );
  const files = await askValue(
    prompter,
    "Max changed files (empty = default, 0 = no limit)",
    "",
    optionalLimit,
    say,
    "Enter a whole number, or leave it empty.",
  );
  if (files !== null) advanced.max_changed_files = files;

  say();
  say(
    "Exclusions: files the review never reads (generated code, lockfiles, fixtures). They go in .prheroignore, one pattern per line, gitignore syntax.",
  );
  const patterns = commaList(
    await prompter.text(
      "Patterns to exclude, comma-separated (empty = none)",
      "",
    ),
  );
  if (patterns.length > 0) advanced.ignorePatterns = patterns;

  return advanced;
}

// The real prompter: numbered options on stderr, answers from stdin.
export function terminalPrompter(): SetupPrompter {
  async function ask(question: string): Promise<string> {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }
  return {
    async choose(question, options, defaultValue) {
      const defaultIndex = options.findIndex((o) => o.value === defaultValue);
      process.stderr.write(`${question}\n`);
      options.forEach((o, i) => {
        process.stderr.write(`  ${i + 1}. ${o.label}: ${o.description}\n`);
      });
      for (;;) {
        const raw = (
          await ask(`Choose 1-${options.length} [${defaultIndex + 1}]: `)
        ).trim();
        if (raw === "") return defaultValue;
        const n = Number(raw);
        const picked = Number.isInteger(n) ? options[n - 1] : undefined;
        if (picked !== undefined) return picked.value;
      }
    },
    async confirm(question, defaultYes) {
      const raw = (await ask(`${question} [${defaultYes ? "Y/n" : "y/N"}] `))
        .trim()
        .toLowerCase();
      if (raw === "") return defaultYes;
      return raw === "y" || raw === "yes";
    },
    async text(question, defaultValue) {
      const raw = await ask(
        `${question}${defaultValue === "" ? "" : ` [${defaultValue}]`}: `,
      );
      return raw;
    },
  };
}
