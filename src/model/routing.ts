import { createHash } from "node:crypto";
import type { ResolvedModelRoute, RunnerBackend } from "../execution/contracts";
import {
  hunterRole,
  isModelRole,
  type ModelListEntry,
  type ModelName,
  ModelNameError,
  type ModelsConfig,
  modelEntry,
  modelNameFromAlias,
  parseModelName,
} from "./model-name";
import {
  FALLBACK_PROFILE,
  type ModelProfile,
  profileJudgeModels,
  profileModelAlias,
  profileRoute,
} from "./profiles";

export type { ResolvedModelRoute, RunnerBackend };

// The route plan: which model each step runs, decided once before anything
// spends (odd/tasks/role-model-routing.md S1).
//
// WHY roles and not aliases: the old routing keyed every assignment by a
// Claude alias, so "the step" and "the model" were one word. Every hunter on
// `sonnet` had to run the same model, and pointing `sonnet` at OpenCode moved
// every step that happened to use it. A step now has a ROLE (`hunter.logic`,
// `refuter`, `summary`, ...), the operator's `models` maps roles to models, and
// a model name says which backend runs it (model-name.ts).

export interface ResolvedStepRoute {
  readonly stepKey: string;
  readonly role: string;
  // The model name the step resolved to, as written (`claude:sonnet-latest`,
  // `opencode:openai/gpt-5`). Prompt aliases appear in their converted form.
  // An entry's effort is not part of it: for OpenCode it is the route's
  // modelVariant, so the fingerprint still tells two efforts apart.
  readonly logicalIdentity: string;
  readonly route: ResolvedModelRoute;
  readonly routeFingerprint: string;
  // The `models` entry's effort as written (S7), on either backend. Absent
  // when the entry sets none, and always for `--model`, a spec model or a
  // prompt alias (D4), so a plan without efforts is the plan it always was.
  // The pipeline reads it for a Claude step's `--effort` (stepEffortFields);
  // an OpenCode effort is also the route's modelVariant. Never part of the
  // route's fingerprint (for Claude it is a launch flag, not a binding), but
  // part of the plan's (createResolvedRoutePlan).
  readonly effort?: string;
  // The models tried after this one, in the order the role lists them (S4).
  // Each is a route of this same step. Absent when the role names one model,
  // so a plan without lists is the plan it always was, byte for byte.
  readonly fallbacks?: readonly ResolvedStepRoute[];
}

export interface ResolvedRoutePlan {
  readonly planId?: string;
  readonly steps: readonly ResolvedStepRoute[];
  readonly routeFingerprint?: string;
}

export class ModelRoutingError extends Error {}

// A model written in the new form (`claude:...`, `opencode:...`) or in `models`
// that does not resolve. Always surfaced, never swallowed into the legacy
// no-plan path: its message is the fix (`write "claude:sonnet-latest"`), and a
// run without a plan would send the bad name to a provider as is.
export class InvalidModelError extends ModelRoutingError {}

const NEW_FORM_PREFIXES = ["claude:", "opencode:"];

// Where a step's model came from, for the error a bad one raises.
type ModelSource = "--model" | "spec" | "models" | "prompt" | "profile";

function toModelName(
  value: string,
  source: ModelSource,
  stepKey: string,
): ModelName {
  try {
    return source === "models"
      ? parseModelName(value)
      : modelNameFromAlias(value);
  } catch (error) {
    if (!(error instanceof ModelNameError)) throw error;
    const where =
      source === "--model"
        ? "--model"
        : source === "models"
          ? `models for ${stepKey}`
          : `the ${source} model of ${stepKey}`;
    const message = `${where}: ${error.message}`;
    if (
      source === "models" ||
      NEW_FORM_PREFIXES.some((prefix) => value.trim().startsWith(prefix))
    ) {
      throw new InvalidModelError(message);
    }
    throw new ModelRoutingError(message);
  }
}

// THE route of a model name. For a `-latest` name the model is the CLI alias
// (`sonnet`), which the Claude Code CLI resolves to the newest version itself;
// for a pinned name it is the full id; for OpenCode it is the provider's model
// id. `modelFamily` keeps the alias where there is one, so a zero-config run
// records exactly what it recorded before.
//
// An OpenCode entry's effort becomes the route's variant (S7: "OpenCode:
// `effort` becomes the model `variant`"), the field the removed `#variant`
// suffix used to fill, so binding, transport cache and fingerprint keep
// telling variants apart as they did. No effort, no variant (D1). A Claude
// entry's effort is not part of the route: it is a launch flag, not a binding,
// and rides the plan step instead (ResolvedStepRoute.effort).
export function routeForModel(
  name: ModelName,
  effort?: string,
): ResolvedModelRoute {
  return {
    backend: name.backend,
    provider: name.provider,
    modelFamily: name.alias ?? name.model,
    modelSnapshot: name.model,
    ...(effort !== undefined && name.backend === "opencode"
      ? { modelVariant: effort }
      : {}),
  };
}

// What the Claude Code CLI receives as `--model`: the route's model. The alias
// for a `-latest` name, the id for a pinned one. It used to be the step's own
// prompt alias on a `direct` gateway, so a model configured for a role never
// reached the CLI; the gateway is gone and the route is the one answer.
export function claudeCliModel(route: ResolvedModelRoute): string {
  return route.modelSnapshot;
}

export function computeRouteFingerprint(
  logicalIdentity: string,
  route: ResolvedModelRoute,
): string {
  const payload = JSON.stringify({
    logical: logicalIdentity,
    backend: route.backend,
    provider: route.provider,
    modelFamily: route.modelFamily,
    modelSnapshot: route.modelSnapshot,
    modelVariant: route.modelVariant ?? "",
  });
  return createHash("sha256").update(payload).digest("hex");
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export function freezeRoutePlan(plan: ResolvedRoutePlan): ResolvedRoutePlan {
  return deepFreeze(plan);
}

export interface ResolveStepRouteInput {
  readonly stepKey: string;
  readonly role: string;
  // The `models` key this step reads (`hunter.logic`, `refuter`, `summary`,
  // `scout`, `consolidate`). Absent: only `models.default` is consulted.
  readonly modelRole?: string;
  readonly cliModel?: string;
  readonly specModel?: string;
  readonly frontmatterModel?: string;
  // The active profile's model for this step's role (model-profiles S3), the
  // seat after the prompt's own. Absent: no profile seat, so a step with no
  // other model fails as it always did.
  readonly profileModel?: string;
  // That profile route's effort (openai-profile S4). It becomes the OpenCode
  // variant only on an OpenCode route, exactly as a `models` entry's effort
  // does; a Claude route's effort keeps riding the role effort as before, so
  // the `claude` profile's plans do not change.
  readonly profileEffort?: string;
  readonly models?: ModelsConfig;
}

// The precedence (L5, L6 item 5; model-profiles S3):
//   1. `--model` (cliModel), the operator's override for one run;
//   2. the review spec's own model for the agent (AgentSpec.model: the lab's
//      spec and the diversity legs, whose whole point is to differ);
//   3. `models[role]`;
//   4. `models.default`;
//   5. the prompt's own alias, converted to `claude:<alias>-latest`;
//   6. the active profile's model for the role (profiles.ts), which already
//      falls back to the `claude` profile role by role.
// 1, 2, 5 and 6 are internal or legacy inputs and keep accepting bare aliases.
//
// Only `models` holds a list. Its first model is the step's route and the rest
// are its fallbacks, tried in order when the provider fails the one before
// (S4; the runner side is model-fallback.ts). Every other source names one
// model, so it has no fallbacks. Only a `models` entry carries an effort (S7,
// D4: `--model`, the CI input and a spec's model take a model only).
interface StepModel {
  readonly name: ModelName;
  readonly effort?: string;
}

function stepModelOf(entry: ModelListEntry, stepKey: string): StepModel {
  const { name, effort } = modelEntry(entry);
  const parsed = toModelName(name, "models", stepKey);
  return effort === undefined ? { name: parsed } : { name: parsed, effort };
}

function resolveStepChoices(
  input: ResolveStepRouteInput,
): [StepModel, ...StepModel[]] {
  if (input.cliModel !== undefined) {
    return [{ name: toModelName(input.cliModel, "--model", input.stepKey) }];
  }
  if (input.specModel !== undefined) {
    return [{ name: toModelName(input.specModel, "spec", input.stepKey) }];
  }
  const configured =
    (input.modelRole === undefined
      ? undefined
      : input.models?.[input.modelRole]) ?? input.models?.default;
  if (configured !== undefined && configured.length > 0) {
    const [first, ...rest] = configured;
    return [
      stepModelOf(first, input.stepKey),
      ...rest.map((entry) => stepModelOf(entry, input.stepKey)),
    ];
  }
  if (
    input.frontmatterModel !== undefined &&
    input.frontmatterModel.trim().length > 0
  ) {
    return [
      { name: toModelName(input.frontmatterModel, "prompt", input.stepKey) },
    ];
  }
  if (input.profileModel !== undefined) {
    const name = toModelName(input.profileModel, "profile", input.stepKey);
    return [
      name.backend === "opencode" && input.profileEffort !== undefined
        ? { name, effort: input.profileEffort }
        : { name },
    ];
  }
  throw new ModelRoutingError(
    `agent ${input.stepKey} has no model and no override given`,
  );
}

export function resolveStepModels(
  input: ResolveStepRouteInput,
): [ModelName, ...ModelName[]] {
  const [first, ...rest] = resolveStepChoices(input);
  return [first.name, ...rest.map((choice) => choice.name)];
}

export function resolveStepModel(input: ResolveStepRouteInput): ModelName {
  return resolveStepModels(input)[0];
}

export function resolveStepRoute(
  input: ResolveStepRouteInput,
): ResolvedStepRoute {
  const [first, ...rest] = resolveStepChoices(input);
  const route = stepRouteFor(input.stepKey, input.role, first);
  if (rest.length === 0) return route;
  return {
    ...route,
    fallbacks: rest.map((choice) =>
      stepRouteFor(input.stepKey, input.role, choice),
    ),
  };
}

// One `models` entry as a step of its own, with no role precedence: what
// `crysk doctor` probes for each model a config names.
export function resolveModelEntryRoute(
  stepKey: string,
  role: string,
  entry: ModelListEntry,
): ResolvedStepRoute {
  return stepRouteFor(stepKey, role, stepModelOf(entry, stepKey));
}

// Every route a plan may execute: each step's model, then each step's
// fallbacks. Whatever binds, admits or picks a credential for a plan reads
// this, never `plan.steps` alone, so a fallback that cannot run fails before
// the run spends anything (S4) instead of when its turn comes.
export function planRoutes(
  plan: ResolvedRoutePlan,
): readonly ResolvedStepRoute[] {
  const fallbacks = plan.steps.flatMap((step) => step.fallbacks ?? []);
  return fallbacks.length === 0 ? plan.steps : [...plan.steps, ...fallbacks];
}

function stepRouteFor(
  stepKey: string,
  role: string,
  { name, effort }: StepModel,
): ResolvedStepRoute {
  const route = routeForModel(name, effort);
  return {
    stepKey,
    role,
    logicalIdentity: name.raw,
    route,
    routeFingerprint: computeRouteFingerprint(name.raw, route),
    ...(effort === undefined ? {} : { effort }),
  };
}

// An internal model string (a bare alias or a full name) as a route, with no
// role and no `models`: what a caller outside the plan needs to know which
// backend a model runs on.
export function resolveModelRoute(model: string): ResolvedModelRoute {
  return routeForModel(toModelName(model, "spec", "route"));
}

export function createResolvedRoutePlan(
  steps: readonly ResolvedStepRoute[],
): ResolvedRoutePlan {
  // A step's fallbacks join its entry only when it has some, and an entry's
  // effort only when it sets one, so a plan with no lists and no efforts keeps
  // the fingerprint it always had. The effort is part of the plan, not of the
  // route: two runs that differ only in effort are different plans, while the
  // same model at two efforts still shares its binding (Juanma, L38).
  const withEffort = (s: ResolvedStepRoute) =>
    `${s.routeFingerprint}${s.effort === undefined ? "" : `@${s.effort}`}`;
  const sortedFingerprints = steps
    .map(
      (s) =>
        `${s.stepKey}:${withEffort(s)}${(s.fallbacks ?? [])
          .map((f) => `>${withEffort(f)}`)
          .join("")}`,
    )
    .sort()
    .join(";");
  const planFingerprint = createHash("sha256")
    .update(sortedFingerprints)
    .digest("hex");
  const plan: ResolvedRoutePlan = {
    steps,
    routeFingerprint: planFingerprint,
  };
  return freezeRoutePlan(plan);
}

export function agentStepKey(agent: { key: string; role: string }): string {
  if (agent.role === "hunter") return `hunter-${agent.key}`;
  if (agent.role === "refuter") {
    return agent.key === "refuter" ? "refuter" : agent.key;
  }
  return agent.key;
}

interface RouteAgent {
  readonly key: string;
  readonly role: string;
  readonly model?: string;
  readonly specialty?: string;
}

// The `models` key an agent reads. A hunter reads `hunter.<specialty>`, so a
// diversity leg (`reliability--<leg>`) reads its base hunter's role. The
// refuter role also covers the verifier and the adjudicator: they run under
// the refuter agent's step key and so share its route. The same key names the
// agent's profile role (profiles.ts).
export function agentModelRole(agent: {
  readonly key: string;
  readonly role: string;
  readonly specialty?: string;
}): string | undefined {
  if (agent.role === "hunter") return hunterRole(agent.specialty ?? agent.key);
  if (agent.role === "refuter") return "refuter";
  return undefined;
}

// `hunter.<key>` is open at parse time (the spec is not loaded yet), so it is
// checked here, against EVERY hunter the spec declares, not only the ones that
// fire: parity is conditional, and its role must not read as a typo on the
// runs where it stays quiet.
function assertHunterRolesExist(
  models: ModelsConfig | undefined,
  agents: readonly RouteAgent[],
): void {
  if (models === undefined) return;
  const hunters = [
    ...new Set(
      agents
        .filter((agent) => agent.role === "hunter")
        .map((agent) => agent.specialty ?? agent.key),
    ),
  ];
  for (const role of Object.keys(models)) {
    if (!role.startsWith("hunter.") || !isModelRole(role)) continue;
    if (hunters.includes(role.slice("hunter.".length))) continue;
    throw new InvalidModelError(
      `models.${role} names no hunter in this review: its hunters are ${hunters.join(", ")}`,
    );
  }
}

export interface BuildRoutePlanInput {
  readonly agents: readonly RouteAgent[];
  readonly cliModel?: string;
  readonly models?: ModelsConfig;
  // The active profile (S3). Absent: `claude`. Phase 1 has no config key for
  // it, so only tests pass another.
  readonly profile?: ModelProfile;
  // The agents' prompt set is the engine's bundled one. Its frontmatter is
  // then never read for routing: the profile decides (S3, "only the bundled
  // set may drop those lines"). Absent or false: a user or lab set, whose
  // frontmatter wins over the profile and which gets no profile seat at all,
  // so a user prompt with no `model:` still fails as it did before profiles.
  readonly bundledAgents?: boolean;
  readonly frontmatterModel?: (agentKey: string) => string | undefined;
  // `bundled` marks an engine-owned root prompt resolved through the active
  // profile's prompt set (model-profiles S4): its frontmatter is then never
  // read for routing and the profile holds the seat, the bundled agents' rule.
  // Unmarked (the lab's direct callers, older harnesses): the frontmatter wins
  // over the profile as before, and the summarizer has no profile seat, so a
  // summarizer prompt with no `model:` still fails the plan.
  readonly summarizer?: {
    model?: string;
    frontmatterModel?: string;
    bundled?: boolean;
  };
  // `defaultModel` is the legacy spelling of the profile seat, still passed by
  // callers that predate profiles; it outranks the profile when given.
  readonly scout?: {
    model?: string;
    frontmatterModel?: string;
    defaultModel?: string;
    bundled?: boolean;
  };
  readonly consolidate?: {
    model?: string;
    frontmatterModel?: string;
    defaultModel?: string;
    bundled?: boolean;
  };
  // The materiality judge (odd/tasks/materiality-gate.md S14). Present only
  // when the gate is enabled, so a run with the gate off keeps its plan's step
  // keys and fingerprint byte for byte.
  readonly materiality?: true;
}

// The step key the materiality judge runs under in every route plan.
export const MATERIALITY_STEP_KEY = "materiality";

// The judge runs only on a model the active profile measured it on
// (profileJudgeModels; on `claude`, sonnet and opus through the Claude Code
// CLI). A judge on any other model or transport is a different, unmeasured
// judge. So `models.judge` may pick among those only, and neither `--model`
// nor `models.default` ever moves it (L6 item 5). MATERIALITY_JUDGE_MODEL is
// the alias a run with no route plan sends, read from the `claude` profile's
// judge.
export const MATERIALITY_JUDGE_MODEL = profileModelAlias(
  profileRoute(FALLBACK_PROFILE, "judge").model,
);
// The `claude` profile's measured judge models, for callers with no profile.
export const MEASURED_JUDGE_MODELS: readonly string[] =
  profileJudgeModels(FALLBACK_PROFILE);

// The judge's model, and what `models.judge` listed that it cannot use. With no
// `models.judge`, the active profile's judge, held to the same measured list.
export function judgeModelChoice(
  models: ModelsConfig | undefined,
  profile: ModelProfile = FALLBACK_PROFILE,
): {
  model?: string;
  dropped: string[];
} {
  // Names only: models.judge takes no effort (D3), so an entry is its name.
  const listed = (models?.judge ?? [profileRoute(profile, "judge").model]).map(
    (entry) => modelEntry(entry).name,
  );
  const measured = profileJudgeModels(profile);
  const usable = listed.filter((name) => measured.includes(name));
  return {
    ...(usable.length === 0 ? {} : { model: usable[0] }),
    dropped: listed.filter((name) => !measured.includes(name)),
  };
}

// The judge's route, or undefined when no measured model is left: the gate is
// optional and fails open toward blocking, so a judge it cannot run must make
// the stage stand down, never kill the run. Omitting it from the plan also
// keeps route admission from gating the run on a step that will never spawn.
export function resolveMaterialityJudgeRoute(
  models: ModelsConfig | undefined,
  profile: ModelProfile = FALLBACK_PROFILE,
): ResolvedStepRoute | undefined {
  const { model } = judgeModelChoice(models, profile);
  if (model === undefined) return undefined;
  return stepRouteFor(MATERIALITY_STEP_KEY, "other", {
    name: parseModelName(model),
  });
}

// Whether a route is one the active profile measured the judge on: the same
// backend, provider and model as a measured name's route. On `claude`, sonnet
// or opus through the Claude Code CLI talking to Anthropic; a pinned id
// (`claude-sonnet-5-5`) is a different model. The variant is not compared:
// the judge takes no effort (D3), so its route carries none.
export function isMeasuredJudgeRoute(
  route: ResolvedModelRoute,
  profile: ModelProfile = FALLBACK_PROFILE,
): boolean {
  return profileJudgeModels(profile).some((name) => {
    const measured = resolveModelRoute(name);
    return (
      route.backend === measured.backend &&
      route.provider === measured.provider &&
      route.modelSnapshot === measured.modelSnapshot
    );
  });
}

export function buildResolvedRoutePlan(
  input: BuildRoutePlanInput,
): ResolvedRoutePlan {
  assertHunterRolesExist(input.models, input.agents);
  const profile = input.profile ?? FALLBACK_PROFILE;
  // A role's profile seat: its model, and its effort when it has one. Reached
  // only when no `models` entry and no prompt names the step's model, so an
  // override on another model never inherits the profile's effort.
  const profileSeat = (role: string) => {
    const { model, effort } = profileRoute(profile, role);
    return effort === undefined
      ? { profileModel: model }
      : { profileModel: model, profileEffort: effort };
  };
  const stepRoutes: ResolvedStepRoute[] = [];
  for (const agent of input.agents) {
    const modelRole = agentModelRole(agent);
    const prompt =
      input.bundledAgents === true
        ? modelRole === undefined
          ? {}
          : profileSeat(modelRole)
        : { frontmatterModel: input.frontmatterModel?.(agent.key) };
    stepRoutes.push(
      resolveStepRoute({
        stepKey: agentStepKey(agent),
        role: agent.role,
        ...(modelRole === undefined ? {} : { modelRole }),
        cliModel: input.cliModel,
        specModel: agent.model,
        ...prompt,
        models: input.models,
      }),
    );
  }
  if (input.summarizer) {
    stepRoutes.push(
      resolveStepRoute({
        stepKey: "summarizer",
        role: "summarizer",
        modelRole: "summary",
        cliModel: input.cliModel,
        specModel: input.summarizer.model,
        ...(input.summarizer.bundled === true
          ? profileSeat("summary")
          : // No profile seat for an unmarked prompt: the summarizer never had
            // a default, so one without `model:` keeps failing the plan.
            { frontmatterModel: input.summarizer.frontmatterModel }),
        models: input.models,
      }),
    );
  }
  if (input.scout) {
    stepRoutes.push(
      resolveStepRoute({
        stepKey: "scout",
        role: "scout",
        modelRole: "scout",
        // `--model` outranks `--scout-model`, as the scout step records it.
        cliModel: input.cliModel ?? input.scout.model,
        ...(input.scout.bundled === true
          ? {}
          : {
              frontmatterModel:
                input.scout.frontmatterModel ?? input.scout.defaultModel,
            }),
        ...profileSeat("scout"),
        models: input.models,
      }),
    );
  }
  if (input.consolidate) {
    stepRoutes.push(
      resolveStepRoute({
        stepKey: "consolidate",
        role: "other",
        modelRole: "consolidate",
        cliModel: input.consolidate.model ?? input.cliModel,
        ...(input.consolidate.bundled === true
          ? {}
          : {
              frontmatterModel:
                input.consolidate.frontmatterModel ??
                input.consolidate.defaultModel,
            }),
        ...profileSeat("consolidate"),
        models: input.models,
      }),
    );
  }
  if (input.materiality) {
    // No `cliModel` and no `models.default` on purpose (judgeModelChoice).
    const judge = resolveMaterialityJudgeRoute(input.models, profile);
    // With no `models.judge`, the judge joins only a plan that already runs a
    // step on its backend and provider (on `claude`, a Claude step): on a plan
    // with none, the runner may hold no credential for it, and a judge it
    // cannot bind must stand down rather than fail admission for the whole
    // run. An explicit `models.judge` is the operator saying the judge can
    // run, so it always joins.
    const sharesCredential =
      judge !== undefined &&
      stepRoutes.some(
        (s) =>
          s.route.backend === judge.route.backend &&
          s.route.provider === judge.route.provider,
      );
    if (
      judge !== undefined &&
      (input.models?.judge !== undefined || sharesCredential)
    ) {
      stepRoutes.push(judge);
    }
  }
  return createResolvedRoutePlan(stepRoutes);
}
