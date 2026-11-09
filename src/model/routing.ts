import { createHash } from "node:crypto";
import type { ResolvedModelRoute, RunnerBackend } from "../execution/contracts";
import {
  hunterRole,
  isModelRole,
  type ModelName,
  ModelNameError,
  type ModelsConfig,
  modelNameFromAlias,
  parseModelName,
} from "./model-name";

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
  // `opencode:openai/gpt-5#high`). Prompt aliases appear in their converted form.
  readonly logicalIdentity: string;
  readonly route: ResolvedModelRoute;
  readonly routeFingerprint: string;
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
type ModelSource = "--model" | "spec" | "models" | "prompt";

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
// id, with the variant beside it. `modelFamily` keeps the alias where there is
// one, so a zero-config run records exactly what it recorded before.
export function routeForModel(name: ModelName): ResolvedModelRoute {
  return {
    backend: name.backend,
    provider: name.provider,
    modelFamily: name.alias ?? name.model,
    modelSnapshot: name.model,
    ...(name.variant === undefined ? {} : { modelVariant: name.variant }),
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
  readonly models?: ModelsConfig;
}

// The precedence (L5, L6 item 5):
//   1. `--model` (cliModel), the operator's override for one run;
//   2. the review spec's own model for the agent (AgentSpec.model: the lab's
//      spec and the diversity legs, whose whole point is to differ);
//   3. `models[role]`;
//   4. `models.default`;
//   5. the prompt's own alias, converted to `claude:<alias>-latest`.
// 1, 2 and 5 are internal or legacy inputs and keep accepting bare aliases.
//
// Only the FIRST model of a list is used for now. Trying the next one on a
// provider failure is the fallback runner's job (S4), which wraps the step's
// execution; until it lands, a list of three runs its first.
export function resolveStepModel(input: ResolveStepRouteInput): ModelName {
  if (input.cliModel !== undefined) {
    return toModelName(input.cliModel, "--model", input.stepKey);
  }
  if (input.specModel !== undefined) {
    return toModelName(input.specModel, "spec", input.stepKey);
  }
  const configured =
    (input.modelRole === undefined
      ? undefined
      : input.models?.[input.modelRole]) ?? input.models?.default;
  if (configured !== undefined && configured.length > 0) {
    return toModelName(configured[0], "models", input.stepKey);
  }
  if (
    input.frontmatterModel !== undefined &&
    input.frontmatterModel.trim().length > 0
  ) {
    return toModelName(input.frontmatterModel, "prompt", input.stepKey);
  }
  throw new ModelRoutingError(
    `agent ${input.stepKey} has no model and no override given`,
  );
}

export function resolveStepRoute(
  input: ResolveStepRouteInput,
): ResolvedStepRoute {
  return stepRouteFor(input.stepKey, input.role, resolveStepModel(input));
}

function stepRouteFor(
  stepKey: string,
  role: string,
  name: ModelName,
): ResolvedStepRoute {
  const route = routeForModel(name);
  return {
    stepKey,
    role,
    logicalIdentity: name.raw,
    route,
    routeFingerprint: computeRouteFingerprint(name.raw, route),
  };
}

// An internal model string (a bare alias or a full name) as a route, with no
// role and no `models`: what a caller outside the plan needs to know which
// backend a model runs on. The second parameter is the removed `routing`,
// always undefined now; it stays only while benchmarks/martian/martian-evidence.ts
// still passes it, and goes with that call.
export function resolveModelRoute(
  model: string,
  _removedRouting?: undefined,
): ResolvedModelRoute {
  return routeForModel(toModelName(model, "spec", "route"));
}

export function createResolvedRoutePlan(
  steps: readonly ResolvedStepRoute[],
): ResolvedRoutePlan {
  const sortedFingerprints = steps
    .map((s) => `${s.stepKey}:${s.routeFingerprint}`)
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
// the refuter agent's step key and so share its route.
function agentModelRole(agent: RouteAgent): string | undefined {
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

// The removed alias-keyed routing (S2). Typed loosely and refused at run time,
// kept only because scripts/opencode-prompt-probe.ts (imported by a test, so
// typechecked) still passes one; it goes when that script moves to `models`.
export type RoutingConfig = Readonly<Record<string, unknown>>;

export interface BuildRoutePlanInput {
  readonly agents: readonly RouteAgent[];
  readonly cliModel?: string;
  readonly models?: ModelsConfig;
  // Removed (S2): passing one throws. See RoutingConfig.
  readonly routingConfig?: RoutingConfig;
  readonly frontmatterModel?: (agentKey: string) => string | undefined;
  readonly summarizer?: { model?: string; frontmatterModel?: string };
  readonly scout?: {
    model?: string;
    frontmatterModel?: string;
    defaultModel?: string;
  };
  readonly consolidate?: {
    model?: string;
    frontmatterModel?: string;
    defaultModel?: string;
  };
  // The materiality judge (odd/tasks/materiality-gate.md S14). Present only
  // when the gate is enabled, so a run with the gate off keeps its plan's step
  // keys and fingerprint byte for byte.
  readonly materiality?: true;
}

// The step key the materiality judge runs under in every route plan.
export const MATERIALITY_STEP_KEY = "materiality";

// The judge was measured on Claude sonnet and opus through the Claude Code CLI
// (same bundled prompt, same bar; both passed, lab bench/METRICS.md
// 2026-11-01); sonnet was chosen because it costs half for a difference within
// one run's noise. A judge on any other model or transport is a different,
// unmeasured judge. So `models.judge` may pick between those two only, and
// neither `--model` nor `models.default` ever moves it (L6 item 5).
// MATERIALITY_JUDGE_MODEL is the alias a run with no route plan sends.
export const MATERIALITY_JUDGE_MODEL = "sonnet";
export const MEASURED_JUDGE_MODELS: readonly string[] = [
  "claude:sonnet-latest",
  "claude:opus-latest",
];

// The judge's model, and what `models.judge` listed that it cannot use. With no
// `models.judge`, the measured default.
export function judgeModelChoice(models: ModelsConfig | undefined): {
  model?: string;
  dropped: string[];
} {
  const listed = models?.judge ?? [`claude:${MATERIALITY_JUDGE_MODEL}-latest`];
  const usable = listed.filter((name) => MEASURED_JUDGE_MODELS.includes(name));
  return {
    ...(usable.length === 0 ? {} : { model: usable[0] }),
    dropped: listed.filter((name) => !MEASURED_JUDGE_MODELS.includes(name)),
  };
}

// The judge's route, or undefined when no measured model is left: the gate is
// optional and fails open toward blocking, so a judge it cannot run must make
// the stage stand down, never kill the run. Omitting it from the plan also
// keeps route admission from gating the run on a step that will never spawn.
export function resolveMaterialityJudgeRoute(
  models: ModelsConfig | undefined,
): ResolvedStepRoute | undefined {
  const { model } = judgeModelChoice(models);
  if (model === undefined) return undefined;
  return stepRouteFor(MATERIALITY_STEP_KEY, "other", parseModelName(model));
}

// The route the judge was measured on: sonnet or opus, through the Claude Code
// CLI talking to Anthropic.
export function isMeasuredJudgeRoute(route: ResolvedModelRoute): boolean {
  return (
    route.backend === "claude-code" &&
    route.provider === "anthropic" &&
    (route.modelSnapshot === "sonnet" || route.modelSnapshot === "opus")
  );
}

export function buildResolvedRoutePlan(
  input: BuildRoutePlanInput,
): ResolvedRoutePlan {
  if (input.routingConfig !== undefined) {
    // Loud, never ignored: a caller still routing would otherwise run every
    // step on its prompt's Claude model while believing it chose another.
    throw new InvalidModelError(
      '`routing` is gone: set models per role, e.g. `"models": {"hunter.logic": ["claude:sonnet-latest"]}`',
    );
  }
  assertHunterRolesExist(input.models, input.agents);
  const stepRoutes: ResolvedStepRoute[] = [];
  for (const agent of input.agents) {
    const modelRole = agentModelRole(agent);
    stepRoutes.push(
      resolveStepRoute({
        stepKey: agentStepKey(agent),
        role: agent.role,
        ...(modelRole === undefined ? {} : { modelRole }),
        cliModel: input.cliModel,
        specModel: agent.model,
        frontmatterModel: input.frontmatterModel?.(agent.key),
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
        frontmatterModel: input.summarizer.frontmatterModel,
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
        frontmatterModel:
          input.scout.frontmatterModel ?? input.scout.defaultModel,
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
        frontmatterModel:
          input.consolidate.frontmatterModel ?? input.consolidate.defaultModel,
        models: input.models,
      }),
    );
  }
  if (input.materiality) {
    // No `cliModel` and no `models.default` on purpose (judgeModelChoice).
    const judge = resolveMaterialityJudgeRoute(input.models);
    if (judge !== undefined) stepRoutes.push(judge);
  }
  return createResolvedRoutePlan(stepRoutes);
}
