// The one seam probes, replays and benchmarks run steps through
// (odd/tasks/route-plan-harness.md S1). It replaces `new ClaudeCodeRunner`
// in harness code: a harness builds a route plan for the steps it runs,
// prepares the runner exactly as a review does (production admission, then
// prepareRunnerForRoute), gives each hand-built step its route, and records
// the identity of the route it ran. Measuring another profile or provider is
// then a different plan, never a harness change.
//
// Nothing here routes, admits or binds on its own: every decision is the
// production helper's. What the seam adds is refusal. Production has three
// silent ways onto the Claude CLI that a harness must never take: a plan that
// fails to build falls back to the no-plan path, prepareRunnerForRoute builds
// a ClaudeCodeRunner without a plan, and MultiProviderRunner sends a spec with
// no route to its Claude binding. Each is a refusal here, so a harness
// measuring an OpenCode model can never record a Claude run under its name.
import type { ModelsConfig } from "#model/model-name";
import { CLAUDE_PROFILE, profileRoute } from "#model/profiles";
import {
  type BuildRoutePlanInput,
  buildResolvedRoutePlan,
  MATERIALITY_STEP_KEY,
  type ResolvedRoutePlan,
} from "#model/routing";
import {
  type PipelineDeps,
  routeForStepKey,
  stepEffortFields,
  stepRouteFields,
} from "#review/pipeline";
import {
  type ProductionRoutePlanResult,
  resolveProductionRoutePlanAtConfirm,
} from "#review/route-preflight";
import { prepareRunnerForRoute } from "#review/run";
import type { StepRunner, StepSpec } from "#review/step-runner";
import type { ResolvedModelRoute } from "../execution/contracts";
import type { ProductionRuntime } from "../production-runtime";

export class HarnessRouteError extends Error {
  override name = "HarnessRouteError";
}

// buildResolvedRoutePlan's input with every step optional and the profile
// defaulting to `claude`, as a review's does. A single-step harness names its
// one step: `agents: [{ key: "refuter", role: "refuter" }]`, `scout: {...}`,
// `materiality: true`. `bundledAgents` (and `bundled` on a root prompt) gives
// the step the profile seat; a lab prompt set passes `frontmatterModel`
// instead, and its frontmatter wins as in production.
export type HarnessRoutePlanInput = Partial<BuildRoutePlanInput>;

// A full config's `hunter.<key>` roles for hunters this plan does not run. A
// review refuses them (they name no hunter in that review), but a harness
// running one step from a production config runs a subset by design.
function modelsForAgents(
  models: ModelsConfig | undefined,
  agents: BuildRoutePlanInput["agents"],
): ModelsConfig | undefined {
  if (models === undefined) return undefined;
  const hunters = new Set(
    agents
      .filter((agent) => agent.role === "hunter")
      .map((agent) => agent.specialty ?? agent.key),
  );
  return Object.fromEntries(
    Object.entries(models).filter(
      ([role]) =>
        !role.startsWith("hunter.") ||
        hunters.has(role.slice("hunter.".length)),
    ),
  );
}

// The route plan for the steps a harness runs. A whole-pipeline harness uses
// buildCliRoutePlan (#review/route-preflight) instead, the review's own plan.
export function buildHarnessRoutePlan(
  input: HarnessRoutePlanInput,
): ResolvedRoutePlan {
  const agents = input.agents ?? [];
  const profile = input.profile ?? CLAUDE_PROFILE;
  let models = modelsForAgents(input.models, agents);
  // Production adds the judge only beside a step that shares its credential,
  // so a judge alone would silently vanish. A harness that asks for the judge
  // runs it: with no choice, on the profile's judge seat.
  if (input.materiality === true && models?.judge === undefined) {
    models = { ...models, judge: [profileRoute(profile, "judge").model] };
  }
  const plan = buildResolvedRoutePlan({
    ...input,
    agents,
    profile,
    ...(models === undefined ? {} : { models }),
  });
  if (
    input.materiality === true &&
    !plan.steps.some((step) => step.stepKey === MATERIALITY_STEP_KEY)
  ) {
    throw new HarnessRouteError(
      `models.judge names no model the materiality judge was measured on (${(models?.judge ?? []).join(", ")}); a harness never runs the judge on another`,
    );
  }
  if (plan.steps.length === 0) {
    throw new HarnessRouteError(
      "the harness route plan has no step: name the agents or stages it runs",
    );
  }
  return plan;
}

function planStep(plan: ResolvedRoutePlan, stepKey: string) {
  const step = plan.steps.find((s) => s.stepKey === stepKey);
  if (step === undefined) {
    throw new HarnessRouteError(
      `no route for step "${stepKey}": the plan routes ${plan.steps.map((s) => s.stepKey).join(", ")}`,
    );
  }
  return step;
}

// A hand-built step with its route, fallbacks and efforts from the plan,
// through the pipeline's own stepRouteFields and stepEffortFields, so it binds
// and runs exactly as a review's step. The spec's effort is the level a
// review takes from the prompt's frontmatter or the role default: a Claude
// `models` entry's effort outranks it, as in production.
export function routeStep(
  plan: ResolvedRoutePlan,
  stepKey: string,
  spec: StepSpec,
): StepSpec {
  if (routeForStepKey(plan, stepKey) === undefined) planStep(plan, stepKey);
  return {
    ...spec,
    ...stepRouteFields(plan, stepKey),
    ...stepEffortFields(plan, stepKey, spec.effort, spec.effort),
  };
}

export interface HarnessIdentity {
  // The step's primary route in the plan, the one its binding was frozen on.
  readonly route: ResolvedModelRoute;
  // The plan's fingerprint: what pipeline.json records as route_fingerprint,
  // so a single-step row and a pipeline run compare on the same field.
  readonly routeFingerprint: string;
  // The step's own route fingerprint (route only, no effort).
  readonly stepRouteFingerprint: string;
}

// The identity a harness row records. A single-step plan needs no step key.
// It is the plan's primary model: a row whose step fell back to a later
// model must say so from the step's own result.
export function harnessIdentity(
  plan: ResolvedRoutePlan,
  stepKey?: string,
): HarnessIdentity {
  if (stepKey === undefined && plan.steps.length !== 1) {
    throw new HarnessRouteError(
      `the plan routes ${plan.steps.length} steps (${plan.steps.map((s) => s.stepKey).join(", ")}): name the step whose identity to record`,
    );
  }
  const step = stepKey === undefined ? plan.steps[0] : planStep(plan, stepKey);
  if (step === undefined) throw new HarnessRouteError("the plan has no step");
  if (plan.routeFingerprint === undefined) {
    throw new HarnessRouteError(
      "the route plan has no fingerprint: build it with createResolvedRoutePlan",
    );
  }
  return {
    route: step.route,
    routeFingerprint: plan.routeFingerprint,
    stepRouteFingerprint: step.routeFingerprint,
  };
}

// A runner that refuses a spec with no route instead of letting the
// production runner send it to its Claude binding.
export function requireRoutedRunner(inner: StepRunner): StepRunner {
  return {
    run: async (spec) => {
      if (spec.route === undefined) {
        throw new HarnessRouteError(
          `step "${spec.name}" has no route: give it one with routeStep before running it`,
        );
      }
      return inner.run(spec);
    },
  };
}

type AdmissionInput = Parameters<typeof resolveProductionRoutePlanAtConfirm>[0];

export interface PrepareHarnessRunnerInput {
  readonly workspaceRoot: string;
  // buildHarnessRoutePlan for a single-step harness, buildCliRoutePlan for a
  // whole pipeline. Called once, before admission, so its error surfaces.
  readonly buildRoutePlan: () => ResolvedRoutePlan | Promise<ResolvedRoutePlan>;
  // Passed through to production admission as given. A live harness passes
  // the run's Claude credential (resolveRunClaudeCredential) as a review
  // does; `checkCredentials: false` is a dry run's, never a default here.
  readonly claudeRun?: AdmissionInput["claudeRun"];
  readonly env?: AdmissionInput["env"];
  readonly checkCredentials?: boolean;
  // The production helpers' own test seams, passed through unchanged.
  readonly authorityDeps?: AdmissionInput["authorityDeps"];
  readonly loadSdk?: AdmissionInput["loadSdk"];
  readonly ceilingController?: AbortController;
  readonly onProgress?: PipelineDeps["onProgress"];
  readonly maxConcurrentSteps?: number;
}

export interface HarnessRunner {
  readonly plan: ResolvedRoutePlan;
  // The production runner behind requireRoutedRunner.
  readonly runner: StepRunner;
  // runPipeline's second argument, on the same guarded runner.
  readonly deps: PipelineDeps;
  readonly runtime: ProductionRuntime;
  readonly productionAdmission: ProductionRoutePlanResult["productionAdmission"];
  // The caller's `finally` runs it, as a review's does with the runtime.
  dispose(): Promise<void>;
}

export async function prepareHarnessRunner(
  input: PrepareHarnessRunnerInput,
): Promise<HarnessRunner> {
  const plan = await input.buildRoutePlan();
  const admitted = await resolveProductionRoutePlanAtConfirm({
    // A built plan cannot fail to build, so production's legacy fallback is
    // unreachable; `true` keeps it so if this ever changes.
    modelsConfigured: true,
    workspaceRoot: input.workspaceRoot,
    buildRoutePlan: async () => plan,
    ...(input.claudeRun === undefined ? {} : { claudeRun: input.claudeRun }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.checkCredentials === undefined
      ? {}
      : { checkCredentials: input.checkCredentials }),
    ...(input.authorityDeps === undefined
      ? {}
      : { authorityDeps: input.authorityDeps }),
    ...(input.loadSdk === undefined ? {} : { loadSdk: input.loadSdk }),
  });
  if (admitted === undefined) {
    throw new HarnessRouteError("production admission returned no route plan");
  }
  const ceilingController = input.ceilingController ?? new AbortController();
  const prepared = await prepareRunnerForRoute({
    routePlan: admitted.routePlan,
    productionAdmission: admitted.productionAdmission,
    workspaceRoot: input.workspaceRoot,
    // Read only on the legacy path, which a harness never takes (below).
    runnerAuthority: { error: "a harness never runs the legacy Claude runner" },
    ceilingController,
    onProgress: input.onProgress,
    ...(input.maxConcurrentSteps === undefined
      ? {}
      : { maxConcurrentSteps: input.maxConcurrentSteps }),
  });
  const runtime = prepared.productionRuntime;
  if (runtime === undefined) {
    throw new HarnessRouteError(
      "no production runtime was prepared; a harness never falls back to the legacy Claude runner",
    );
  }
  const runner = requireRoutedRunner(runtime.runner);
  return {
    plan: admitted.routePlan,
    runner,
    deps: { ...prepared.deps, runner },
    runtime,
    productionAdmission: admitted.productionAdmission,
    dispose: () => runtime.dispose(),
  };
}
