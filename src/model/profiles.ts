import type { Effort } from "./catalog";

// Model profiles (odd/tasks/model-profiles.md S1-S3): which model and effort
// each step role runs, as data. Claude is one profile among others and the
// fallback when nothing else is chosen, not a default hard-wired into the
// engine.
//
// Resolution per step (routing.ts, resolveStepChoices): `--model` > the spec's
// own model > `models[role]` > `models.default` > a user or lab prompt set's
// frontmatter > the active profile > `claude`. A prompt set its caller marks
// as the bundled one (`bundledAgents`) takes its routing from the profile,
// never from its own frontmatter. Phase 1: no production caller sets that
// flag yet, so production still reads the bundled frontmatter, which equals
// this profile (test/fixtures/model-profiles/baseline proves both paths).
//
// No value import on purpose: catalog.ts reads its role efforts from the
// `claude` profile, so a value import back from there would be a load cycle.

// The roles a profile assigns. `hunter` covers every `hunter.<key>` the
// profile does not name in `hunters`. `refuter` covers the verifier and the
// adjudicator too: they run the refuter's prompt family under its step key.
export const PROFILE_ROLES = [
  "hunter",
  "refuter",
  "consolidate",
  "scout",
  "summary",
  "judge",
] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

export interface ProfileRoute {
  // A model name in the new form (`claude:sonnet-latest`,
  // `opencode:openai/gpt-5`), the same names `models` takes.
  readonly model: string;
  readonly effort: Effort;
}

export interface ModelProfile {
  readonly id: string;
  // A role the profile leaves out falls back to the `claude` profile's.
  readonly roles: Readonly<Partial<Record<ProfileRole, ProfileRoute>>>;
  // Per-hunter overrides, keyed by specialty (`logic`, `parity`, ...).
  readonly hunters?: Readonly<Record<string, ProfileRoute>>;
  // The profile's prompt set (S4): the name of a set under
  // `prompts/profiles/<name>/` that holds only the files that differ from the
  // default set, every other prompt falling back to the default file by file
  // (profilePromptSet, src/review/prompt-set.ts). Absent: the default set, as
  // `claude` uses it. A user `agents_dir` still outranks it for the five
  // agent files.
  readonly promptSet?: string;
  // What was measured on the profile's models (S5). Absent: `claude`'s
  // measurements, as a role the profile leaves out takes `claude`'s route.
  readonly measured?: MeasuredFacts;
}

// Facts a lab run established for a profile, read by the gates that may only
// run on what was measured.
export interface MeasuredFacts {
  // The model names (as `models` writes them) the materiality judge was
  // measured on. `models.judge` may pick among these only, and a plan's judge
  // runs only on one of their routes (routing.ts, judgeModelChoice and
  // isMeasuredJudgeRoute). Absent: `claude`'s list.
  readonly judgeModels?: readonly string[];
}

// Exactly what 4898e1b4 runs with no configuration, read off the bundled
// prompts' frontmatter (prompts/default/*.md, consolidate.md, summarizer.md),
// the old DEFAULT_SCOUT_MODEL / DEFAULT_CONSOLIDATE_MODEL /
// DEFAULT_CONSOLIDATE_EFFORT / DEFAULT_SUMMARY_MODEL / MATERIALITY_JUDGE_MODEL
// constants and ROLE_EFFORT (catalog.ts, where the #299 evidence for the
// hunter and refuter levels lives). Pinned by
// test/fixtures/model-profiles/baseline and preflight-bundled-prompts.test.ts.
export const CLAUDE_PROFILE: ModelProfile = Object.freeze({
  id: "claude",
  roles: Object.freeze({
    hunter: Object.freeze({ model: "claude:sonnet-latest", effort: "xhigh" }),
    refuter: Object.freeze({ model: "claude:opus-latest", effort: "high" }),
    consolidate: Object.freeze({
      model: "claude:sonnet-latest",
      effort: "high",
    }),
    scout: Object.freeze({ model: "claude:sonnet-latest", effort: "high" }),
    summary: Object.freeze({ model: "claude:haiku-latest", effort: "high" }),
    judge: Object.freeze({ model: "claude:sonnet-latest", effort: "high" }),
  }),
  // The judge was measured on Claude sonnet and opus through the Claude Code
  // CLI (same bundled prompt, same bar; both passed, lab bench/METRICS.md
  // 2026-11-01); sonnet was chosen because it costs half for a difference
  // within one run's noise.
  measured: Object.freeze({
    judgeModels: Object.freeze(["claude:sonnet-latest", "claude:opus-latest"]),
  }),
} satisfies ModelProfile);

export const DEFAULT_PROFILE_ID = CLAUDE_PROFILE.id;

// THE registry. Phase 1 has no user-facing `profile` key, so `claude` is always
// the active profile outside tests.
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> =
  Object.freeze({ [CLAUDE_PROFILE.id]: CLAUDE_PROFILE });

export function modelProfile(id: string): ModelProfile {
  const profile = MODEL_PROFILES[id];
  if (profile === undefined) {
    throw new Error(
      `unknown model profile "${id}": known profiles are ${Object.keys(MODEL_PROFILES).join(", ")}`,
    );
  }
  return profile;
}

// The route a profile gives a step role: `hunter.<key>`, or a fixed role. A
// role the profile leaves out falls back to `claude` (S3's last seat).
export function profileRoute(
  profile: ModelProfile,
  role: string,
): ProfileRoute {
  if (role.startsWith("hunter.")) {
    const key = role.slice("hunter.".length);
    const own = profile.hunters?.[key] ?? profile.roles.hunter;
    if (own !== undefined) return own;
    return CLAUDE_PROFILE.hunters?.[key] ?? claudeRoute("hunter");
  }
  if (!isProfileRole(role)) {
    throw new Error(`no profile role "${role}"`);
  }
  return profile.roles[role] ?? claudeRoute(role);
}

// The models a profile's materiality judge was measured on (S5). A profile
// that measured nothing inherits `claude`'s list, so it judges only where
// `claude` would: a judge on an unmeasured model is a different judge.
export function profileJudgeModels(profile: ModelProfile): readonly string[] {
  const own = profile.measured?.judgeModels;
  if (own !== undefined) return own;
  const claude = CLAUDE_PROFILE.measured?.judgeModels;
  if (claude === undefined) throw new Error("claude profile lacks judgeModels");
  return claude;
}

function isProfileRole(role: string): role is ProfileRole {
  return (PROFILE_ROLES as readonly string[]).includes(role);
}

function claudeRoute(role: ProfileRole): ProfileRoute {
  const route = CLAUDE_PROFILE.roles[role];
  if (route === undefined) throw new Error(`claude profile lacks ${role}`);
  return route;
}

// A profile model in the form a prompt's frontmatter writes it: the Claude CLI
// alias for a `claude:<alias>-latest` name (`sonnet`), the name as written for
// anything else. It is what a step records as its model and what the no-plan
// path sends, so a zero-config run records exactly what it always recorded.
export function profileModelAlias(model: string): string {
  const match = /^claude:([a-z]+)-latest$/.exec(model);
  return match?.[1] ?? model;
}
