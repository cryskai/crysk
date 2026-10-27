// The choices `setup --ci` asks for, as data: the re-review level presets, the
// gate mode, the spend ceiling, and the advanced keys. Pure, so every choice
// and every line of the summary is testable offline; the prompts live in the
// command shell (src/commands/ci-setup.ts).
//
// WHY presets at all: before this, CI admission ran on defaults nobody was
// shown (risk_aware, 2 passes). A preset names the behaviour in words, and the
// keys it sets are always written to .prhero/config.json, so what a repo does
// is visible in the file it versions, never inherited silently.

import { DEFAULT_SIZE_GATE } from "#review/size-gate";
import { CI_DEFAULT_METERED_BUDGET_USD } from "./gates";
import {
  DEFAULT_CI_ADVISORY_WEIGHT,
  DEFAULT_CI_BLOCKING_WEIGHT,
} from "./review-admission";
import type { CiReviewPolicyMode } from "./review-policy";

export type ReviewLevel = "minimal" | "balanced" | "thorough" | "manual";

export interface ReviewLevelPreset {
  label: string;
  description: string;
  config: {
    ci_review_policy: CiReviewPolicyMode;
    ci_max_attempts: number;
    // Read only by risk_aware and thresholded, so the other presets leave it out.
    ci_rereview_min_score?: number;
    max_verification_steps: number;
  };
}

// Every preset verifies prior findings (8): even `minimal` and `manual` can be
// re-reviewed by hand with /pr-hero review, and a forced pass that confirms
// nothing it fixed would be worse than useless.
export const REVIEW_LEVELS: Record<ReviewLevel, ReviewLevelPreset> = {
  minimal: {
    label: "Minimal",
    description:
      "One automatic review per PR. Later pushes are reviewed only when you comment /pr-hero review.",
    config: {
      ci_review_policy: "once_per_pr",
      ci_max_attempts: 1,
      max_verification_steps: 8,
    },
  },
  balanced: {
    label: "Balanced (recommended)",
    description:
      "Re-review a push when it touches risky files or the previous pass found enough (score >= 4). At most 2 automatic passes per PR.",
    config: {
      ci_review_policy: "risk_aware",
      ci_max_attempts: 2,
      ci_rereview_min_score: 4,
      max_verification_steps: 8,
    },
  },
  thorough: {
    label: "Thorough",
    description:
      "Review every push, up to 4 automatic passes per PR. Most coverage, most cost.",
    config: {
      ci_review_policy: "every_push",
      ci_max_attempts: 4,
      max_verification_steps: 8,
    },
  },
  manual: {
    label: "Manual",
    description:
      "No automatic reviews after the first. Every re-review starts with a /pr-hero review comment.",
    config: {
      ci_review_policy: "manual_only",
      ci_max_attempts: 1,
      max_verification_steps: 8,
    },
  },
};

export const REVIEW_LEVEL_ORDER: readonly ReviewLevel[] = [
  "minimal",
  "balanced",
  "thorough",
  "manual",
];

export const DEFAULT_REVIEW_LEVEL: ReviewLevel = "balanced";

export function isReviewLevel(value: string): value is ReviewLevel {
  return (REVIEW_LEVEL_ORDER as readonly string[]).includes(value);
}

export type Billing = "subscription" | "api";

export interface AdvancedChoices {
  ci_blocking_weight?: number;
  ci_advisory_weight?: number;
  ci_admission_observe_only?: boolean;
  ci_trusted_actors?: string[];
  max_changed_files?: number;
  // Lines appended to .prheroignore; exclusions have no config key.
  ignorePatterns?: string[];
}

export interface CiSetupChoices {
  level: ReviewLevel;
  mode: "gate" | "advisory";
  // Undefined: nobody said how the review is paid, so no ceiling is written
  // and the action resolves it from the route's billing mode.
  billing?: Billing;
  // Only with billing "api"; undefined there means the $10 default.
  budgetUsd?: number;
  // Always written. Unlike the budget, a size threshold matters on any route:
  // left unset, a subscription route resolves to NO limit, so a huge PR would
  // run a review nobody asked for. 0 is the explicit, chosen "no limit".
  maxChangedLines: number;
  advanced: AdvancedChoices;
  // True when no human or agent chose: the summary must say so.
  defaulted: boolean;
}

// The engine's own default threshold, so a chosen default and an inherited one agree.
export const DEFAULT_MAX_CHANGED_LINES = DEFAULT_SIZE_GATE.maxChangedLines;

export function defaultChoices(): CiSetupChoices {
  return {
    level: DEFAULT_REVIEW_LEVEL,
    mode: "gate",
    maxChangedLines: DEFAULT_MAX_CHANGED_LINES,
    advanced: {},
    defaulted: true,
  };
}

// The `budget-usd` workflow input for these choices, or undefined to write none.
// A subscription gets an explicit 0 (no ceiling): a run there costs quota, not
// dollars, and leaving it empty trusts a billing-mode resolution that resolved
// this repo's own subscription as metered (see OWN_CI_WORKFLOW_OPTIONS in
// setup.ts). 0 disables a ceiling and never imposes one, so it is not the
// "raising a stranger's ceiling" the template refuses to do.
export function budgetInput(choices: CiSetupChoices): string | undefined {
  if (choices.billing === "subscription") return "0";
  if (choices.billing === "api") {
    return String(choices.budgetUsd ?? CI_DEFAULT_METERED_BUDGET_USD);
  }
  return undefined;
}

// The keys merged into .prhero/config.json. The level's keys are always there.
export function configPatch(choices: CiSetupChoices): Record<string, unknown> {
  const { ignorePatterns: _ignored, ...advanced } = choices.advanced;
  const patch: Record<string, unknown> = {
    ...REVIEW_LEVELS[choices.level].config,
    max_changed_lines: choices.maxChangedLines,
  };
  for (const [key, value] of Object.entries(advanced)) {
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

// One line per choice, plus how to change it. Returned, never logged.
export function renderChoicesSummary(choices: CiSetupChoices): string[] {
  const preset = REVIEW_LEVELS[choices.level];
  const c = preset.config;
  const a = choices.advanced;
  const budget = budgetInput(choices);
  const lines = [
    choices.defaulted
      ? "Review settings (defaults: nobody chose them; pass --level, --ci-mode and --billing, or run setup --ci in a terminal, to choose):"
      : "Review settings:",
    `  level            ${choices.level}: ${preset.description}`,
    `  policy           ${c.ci_review_policy}, at most ${c.ci_max_attempts} automatic pass${c.ci_max_attempts === 1 ? "" : "es"} per PR${c.ci_rereview_min_score === undefined ? "" : `, score floor ${c.ci_rereview_min_score}`}`,
    `  verification     up to ${c.max_verification_steps} prior findings checked per re-review`,
    `  gate             ${choices.mode === "gate" ? "gate: blocking findings turn the pr-hero check red" : "advisory: the pr-hero check stays green"}`,
    `  budget           ${
      budget === undefined
        ? "not set: resolved from how the review is paid (no ceiling on a subscription, $10 on an API key)"
        : budget === "0"
          ? "none (budget-usd: 0): a subscription spends quota, not dollars"
          : `$${budget} per review (budget-usd)`
    }`,
    `  score weights    blocking ${a.ci_blocking_weight ?? DEFAULT_CI_BLOCKING_WEIGHT}, advisory ${a.ci_advisory_weight ?? DEFAULT_CI_ADVISORY_WEIGHT}`,
    `  observe only     ${a.ci_admission_observe_only === true ? "yes: skip decisions are logged, every push is reviewed" : "no"}`,
    `  trusted actors   ${a.ci_trusted_actors && a.ci_trusted_actors.length > 0 ? a.ci_trusted_actors.join(", ") : "none beyond the workflow actor"}`,
    `  size limit       ${choices.maxChangedLines === 0 ? "no changed-lines limit (0)" : `${choices.maxChangedLines} changed lines`}, ${a.max_changed_files === undefined ? "files resolved from how the review is paid" : `${a.max_changed_files} files`}`,
    `  exclusions       ${a.ignorePatterns && a.ignorePatterns.length > 0 ? `${a.ignorePatterns.join(", ")} (.prheroignore)` : "none added (.prheroignore)"}`,
    "Change them later in .prhero/config.json and .github/workflows/pr-hero.yml (`npx -y pr-hero config` shows the effective values).",
  ];
  return lines;
}
