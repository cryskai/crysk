import type { Effort } from "./catalog";
import { CLAUDE_PROFILE } from "./profiles/claude";
import { OPENAI_PROFILE } from "./profiles/openai";

// Model profiles (odd/tasks/model-profiles.md S1-S3): which model and effort
// each step role runs, as data. Claude is one profile among others and the
// fallback when nothing else is chosen, not a default hard-wired into the
// engine.
//
// Resolution per step (routing.ts, resolveStepChoices): `--model` > the spec's
// own model > `models[role]` > `models.default` > a user or lab prompt set's
// frontmatter > the active profile > the fallback profile. A prompt set its
// caller marks as the bundled one (`bundledAgents`) takes its routing from the profile,
// never from its own frontmatter. Phase 1: no production caller sets that
// flag yet, so production still reads the bundled frontmatter, which equals
// this profile (test/fixtures/model-profiles/baseline proves both paths).
//
// Only a type import from catalog.ts on purpose: catalog.ts reads its role
// efforts from the fallback profile, so a value import back from there would
// be a load cycle. Profile modules import only types from this file.

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
  // Absent: no effort is sent, so the model runs at its provider's default
  // level (an OpenCode route gets no variant).
  readonly effort?: Effort;
}

export interface ModelProfile {
  readonly id: string;
  // A role the profile leaves out falls back to the fallback profile's.
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
  // What was measured on the profile's models (S5). Absent: the fallback
  // profile's measurements, as a role the profile leaves out takes its route.
  readonly measured?: MeasuredFacts;
  // The models the materiality judge may run on when nothing was measured on
  // the profile's models: an owner's choice, recorded as one and never as a
  // measurement (openai-profile S9). `measured.judgeModels` wins when both
  // are set. Absent: the measured list, else the fallback profile's.
  readonly judgeModels?: readonly string[];
}

// Facts a lab run established for a profile, read by the gates that may only
// run on what was measured.
export interface MeasuredFacts {
  // The model names (as `models` writes them) the materiality judge was
  // measured on. `models.judge` may pick among these only, and a plan's judge
  // runs only on one of their routes (routing.ts, judgeModelChoice and
  // isMeasuredJudgeRoute). Absent: the fallback profile's list.
  readonly judgeModels?: readonly string[];
}

// THE registry: every profile the engine knows, each one data in its own
// module under src/model/profiles/. Engine code reads the active profile and
// never imports a profile module; only this file does (pinned by
// test/architecture/profile-registry.test.ts). Adding a profile is one module
// plus one line here.
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> =
  Object.freeze({
    [CLAUDE_PROFILE.id]: CLAUDE_PROFILE,
    [OPENAI_PROFILE.id]: OPENAI_PROFILE,
  });

// The profile a run uses when nothing chooses one, and the one that fills a
// role another profile leaves out. Being the fallback is the only thing that
// sets it apart from any other profile.
export const FALLBACK_PROFILE_ID = "claude";

export function modelProfile(id: string): ModelProfile {
  const profile = MODEL_PROFILES[id];
  if (profile === undefined) {
    throw new Error(
      `unknown model profile "${id}": known profiles are ${Object.keys(MODEL_PROFILES).join(", ")}`,
    );
  }
  return profile;
}

export const FALLBACK_PROFILE: ModelProfile = modelProfile(FALLBACK_PROFILE_ID);

// The active profile for a config's `profile` value (openai-profile S1, S3):
// the registered one, or the fallback when the config names none. The parser
// already refused an unknown id, so one here is a programming error.
export function resolveProfile(id: string | undefined): ModelProfile {
  return id === undefined ? FALLBACK_PROFILE : modelProfile(id);
}

// What the `profile` key accepts, for the config parser and `crysk config`.
export function profileIdProblem(value: unknown): string | undefined {
  const known = `profile must be one of ${Object.keys(MODEL_PROFILES).join(", ")}`;
  if (typeof value !== "string") return known;
  return Object.hasOwn(MODEL_PROFILES, value) ? undefined : known;
}

// The route a profile gives a step role: `hunter.<key>`, or a fixed role. A
// role the profile leaves out falls back to the fallback profile's (S3's last
// seat).
export function profileRoute(
  profile: ModelProfile,
  role: string,
): ProfileRoute {
  if (role.startsWith("hunter.")) {
    const key = role.slice("hunter.".length);
    const own = profile.hunters?.[key] ?? profile.roles.hunter;
    if (own !== undefined) return own;
    return FALLBACK_PROFILE.hunters?.[key] ?? fallbackRoute("hunter");
  }
  if (!isProfileRole(role)) {
    throw new Error(`no profile role "${role}"`);
  }
  return profile.roles[role] ?? fallbackRoute(role);
}

// The effort a role runs at wherever an engine path needs one: the Claude Code
// launch flag and the recorded step. The profile's own, else the fallback
// profile's for the role. An OpenCode route never gets this one: there only
// the profile's own effort becomes the variant (routing.ts, profileSeat), so a
// role the profile gives no effort runs at the provider's default level.
export function profileRoleEffort(profile: ModelProfile, role: string): Effort {
  const own = profileRoute(profile, role).effort;
  if (own !== undefined) return own;
  const fallback = profileRoute(FALLBACK_PROFILE, role).effort;
  if (fallback === undefined) {
    throw new Error(
      `${FALLBACK_PROFILE.id} profile lacks an effort for ${role}`,
    );
  }
  return fallback;
}

// Every model a profile's routes name, the fallback profile's for a role it
// leaves out: what the CI steps and the doctor read to decide which CLIs a run
// may need (openai-profile S6). The judge is included: it may join a plan.
export function profileModels(profile: ModelProfile): string[] {
  return [
    ...PROFILE_ROLES.map((role) => profileRoute(profile, role).model),
    ...Object.values(profile.hunters ?? {}).map((route) => route.model),
  ];
}

// Whether a profile id names a registered profile whose every route runs on
// OpenCode: what the CI steps that run before `bun install` read to name the
// backend of a standalone `profile` input, with no profile named here.
export function profileRunsOnlyOnOpenCode(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (!Object.hasOwn(MODEL_PROFILES, trimmed)) return false;
  const profile = MODEL_PROFILES[trimmed];
  return (
    profile !== undefined &&
    profileModels(profile).every((model) => model.startsWith("opencode:"))
  );
}

// The models a profile's materiality judge may run on (S5): what was measured
// on it, else the models its owner chose without a measurement (openai-profile
// S9), else the fallback profile's list, so a profile with neither judges only
// where the fallback would: a judge on an unmeasured model is a different
// judge.
export function profileJudgeModels(profile: ModelProfile): readonly string[] {
  const own = profile.measured?.judgeModels ?? profile.judgeModels;
  if (own !== undefined) return own;
  const fallback = FALLBACK_PROFILE.measured?.judgeModels;
  if (fallback === undefined) {
    throw new Error(`${FALLBACK_PROFILE.id} profile lacks judgeModels`);
  }
  return fallback;
}

function isProfileRole(role: string): role is ProfileRole {
  return (PROFILE_ROLES as readonly string[]).includes(role);
}

function fallbackRoute(role: ProfileRole): ProfileRoute {
  const route = FALLBACK_PROFILE.roles[role];
  if (route === undefined) {
    throw new Error(`${FALLBACK_PROFILE.id} profile lacks ${role}`);
  }
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
