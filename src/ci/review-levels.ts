// The choices `setup --ci` asks for, as data: the re-review level presets, the
// gate mode, the spend ceiling, and the advanced keys. Pure, so every choice
// and every line of the summary is testable offline; the prompts live in the
// command shell (src/commands/ci-setup.ts).
//
// WHY presets at all: before this, CI admission ran on defaults nobody was
// shown (risk_aware, 2 passes). A preset names the behaviour in words, and the
// keys it sets are always written to .crysk/config.json, so what a repo does
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
// re-reviewed by hand with /crysk review, and a forced pass that confirms
// nothing it fixed would be worse than useless.
export const REVIEW_LEVELS: Record<ReviewLevel, ReviewLevelPreset> = {
  minimal: {
    label: "Minimal",
    description:
      "One automatic review per PR. Later pushes are reviewed only when you comment /crysk review.",
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
      "No automatic reviews after the first. Every re-review starts with a /crysk review comment.",
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
  // Lines appended to .cryskignore; exclusions have no config key.
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
  // Which groups someone chose this run. A chosen group overrides the file; an
  // unchosen one only fills a group the file does not have yet, so re-running
  // setup (say `--force` to refresh an old workflow) never resets tuned keys.
  // `mode` and `billing` guard the workflow the same way: on a --force refresh
  // an unchosen one keeps what the old workflow said.
  chosen: {
    level: boolean;
    maxChangedLines: boolean;
    mode: boolean;
    billing: boolean;
  };
}

// What the repository already says, read before asking: the defaults a
// re-run should start from, so pressing Enter changes nothing.
export interface CurrentSettings {
  config: Record<string, unknown>;
  workflow: {
    mode?: "gate" | "advisory";
    budgetUsd?: string;
    maxChangedLines?: string;
    maxChangedFiles?: string;
  };
}

export const NO_CURRENT_SETTINGS: CurrentSettings = {
  config: {},
  workflow: {},
};

const LEVEL_KEYS = [
  "ci_review_policy",
  "ci_max_attempts",
  "ci_rereview_min_score",
  "max_verification_steps",
] as const;

// The preset the file's level keys spell exactly, "custom" when they are set
// but match none, undefined when the file sets none of them.
export function presetMatching(
  config: Record<string, unknown>,
): ReviewLevel | "custom" | undefined {
  if (!LEVEL_KEYS.some((key) => key in config)) return undefined;
  for (const level of REVIEW_LEVEL_ORDER) {
    const preset = REVIEW_LEVELS[level].config as Record<string, unknown>;
    if (LEVEL_KEYS.every((key) => config[key] === preset[key])) return level;
  }
  return "custom";
}

// The two inputs setup writes into the workflow, read back from an existing one.
export function parseWorkflowChoices(
  text: string,
): CurrentSettings["workflow"] {
  // One input per line, quoted or not, with an optional trailing comment. A
  // number must be a whole number (sizes) or a plain decimal (budget): a value
  // like `1.2.3` reads as absent rather than becoming NaN in the new file.
  const input = (name: string, value: string): string | undefined =>
    new RegExp(`^\\s+${name}:\\s*["']?(${value})["']?\\s*(?:#.*)?$`, "m").exec(
      text,
    )?.[1];
  const mode = input("mode", "gate|advisory") as
    | "gate"
    | "advisory"
    | undefined;
  const budgetUsd = input("budget-usd", "-?\\d+(?:\\.\\d+)?");
  const maxChangedLines = input("max-changed-lines", "\\d+");
  const maxChangedFiles = input("max-changed-files", "\\d+");
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(maxChangedLines === undefined ? {} : { maxChangedLines }),
    ...(maxChangedFiles === undefined ? {} : { maxChangedFiles }),
  };
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
    chosen: {
      level: false,
      maxChangedLines: false,
      mode: false,
      billing: false,
    },
  };
}

// The `budget-usd` workflow input for these choices, or undefined to write none.
// A subscription writes none. CI bills as metered only when a non-empty
// ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is present (envBillsMetered), so
// a subscription-only repo already gets no ceiling. An explicit 0 would print
// the disabled-ceiling warning on every run and, worse, stay an operator
// override if an API key is added later, defeating the $10 fail-safe that the
// key's mere presence is meant to bring back (gates.ts, CiBillingMode).
export function budgetInput(choices: CiSetupChoices): string | undefined {
  if (choices.billing === "api") {
    return String(choices.budgetUsd ?? CI_DEFAULT_METERED_BUDGET_USD);
  }
  return undefined;
}

// How the choices land in .crysk/config.json. `set` overrides; each group in
// `fillIfAbsent` is written only when the file has none of its keys, and kept
// whole otherwise, so a tuned policy is never half-replaced by a preset.
export interface ConfigPlan {
  set: Record<string, unknown>;
  fillIfAbsent: Record<string, unknown>[];
  // Keys a chosen preset removes from the file.
  remove: string[];
}

export function configPlan(choices: CiSetupChoices): ConfigPlan {
  const { ignorePatterns: _ignored, ...advanced } = choices.advanced;
  const set: Record<string, unknown> = {};
  const fillIfAbsent: Record<string, unknown>[] = [];
  const remove: string[] = [];
  const levelKeys = { ...REVIEW_LEVELS[choices.level].config };
  const lineKeys = { max_changed_lines: choices.maxChangedLines };
  if (choices.chosen.level) {
    Object.assign(set, levelKeys);
    for (const key of [...LEVEL_KEYS, "ci_max_reviews"]) {
      if (!(key in levelKeys)) remove.push(key);
    }
  } else fillIfAbsent.push(levelKeys);
  if (choices.chosen.maxChangedLines) Object.assign(set, lineKeys);
  else fillIfAbsent.push(lineKeys);
  // An advanced key is present only because someone gave it.
  for (const [key, value] of Object.entries(advanced)) {
    if (value !== undefined) set[key] = value;
  }
  return { set, fillIfAbsent, remove };
}

// One line per choice, plus how to change it. Returned, never logged.
// `kept` holds the file's values for keys nobody chose this run; where a group
// was kept the summary shows those values, never the preset it did not write.
// `effective` is the config file as written: the advanced lines report it, so
// a tuned value nobody touched this run is shown as it stands.
export function renderChoicesSummary(
  choices: CiSetupChoices,
  kept: Record<string, unknown> = {},
  effective: Record<string, unknown> = {},
): string[] {
  const preset = REVIEW_LEVELS[choices.level];
  const levelKept = LEVEL_KEYS.filter((key) => key in kept);
  const c = preset.config;
  const a: AdvancedChoices = {
    ...(effective as AdvancedChoices),
    ...choices.advanced,
  };
  const budget = budgetInput(choices);
  const lines = [
    choices.defaulted
      ? "Review settings (defaults: nobody chose them; pass --level, --ci-mode and --billing, or run setup --ci in a terminal, to choose):"
      : "Review settings:",
    ...(levelKept.length > 0
      ? [
          `  level            kept the existing settings: ${levelKept.map((key) => `${key} ${JSON.stringify(kept[key])}`).join(", ")}`,
        ]
      : [
          `  level            ${choices.level}: ${preset.description}`,
          `  policy           ${c.ci_review_policy}, at most ${c.ci_max_attempts} automatic pass${c.ci_max_attempts === 1 ? "" : "es"} per PR${c.ci_rereview_min_score === undefined ? "" : `, score floor ${c.ci_rereview_min_score}`}`,
          `  verification     up to ${c.max_verification_steps} prior findings checked per re-review`,
        ]),
    `  gate             ${choices.mode === "gate" ? "gate: blocking findings turn the pr-hero check red" : "advisory: the pr-hero check stays green"}`,
    `  budget           ${
      budget === undefined
        ? choices.billing === "subscription"
          ? "not set: no ceiling while the repo has no ANTHROPIC_API_KEY or OPENCODE_AUTH_JSON secret (a subscription spends quota, not dollars); adding either brings back the $10 ceiling"
          : "not set: resolved from how the review is paid (no ceiling on a subscription, $10 on an API key)"
        : Number(budget) <= 0
          ? `none (budget-usd: ${budget}; 0 or less disables the ceiling)`
          : `$${budget} per review (budget-usd)`
    }`,
    `  score weights    blocking ${a.ci_blocking_weight ?? DEFAULT_CI_BLOCKING_WEIGHT}, advisory ${a.ci_advisory_weight ?? DEFAULT_CI_ADVISORY_WEIGHT}`,
    `  observe only     ${a.ci_admission_observe_only === true ? "yes: skip decisions are logged, every push is reviewed" : "no"}`,
    `  trusted actors   ${a.ci_trusted_actors && a.ci_trusted_actors.length > 0 ? a.ci_trusted_actors.join(", ") : "none beyond the workflow actor"}`,
    `  size limit       ${"max_changed_lines" in kept ? `${JSON.stringify(kept.max_changed_lines)} changed lines (kept)` : choices.maxChangedLines === 0 ? "no changed-lines limit (0)" : `${choices.maxChangedLines} changed lines`}, ${a.max_changed_files === undefined ? "files resolved from how the review is paid" : `${a.max_changed_files} files`}`,
    `  exclusions       ${a.ignorePatterns && a.ignorePatterns.length > 0 ? `${a.ignorePatterns.join(", ")} (.cryskignore)` : "none added (.cryskignore)"}`,
    "Change them later in the repo config (.crysk/config.json, or .prhero/config.json in a repo set up before the rename) and .github/workflows/pr-hero.yml (`npx -y pr-hero config` shows the effective values).",
  ];
  return lines;
}
