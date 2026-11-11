// Single-step harnesses on the route seam (odd/tasks/route-plan-harness.md S3,
// S6): refuter-replay, scout-probe, consolidate-replay, live-micro-eval and
// martian-judge each run one step. Each builds a one-step plan from the model
// it measures, prepares the runner through route-runner.ts, routes its spec,
// and records the route identity in its rows.
//
// The model is always the harness's own explicit choice, passed as the step's
// `--model` (cliModel): a bare alias (`sonnet`) is `claude:sonnet-latest`, the
// route the harness ran before the seam, and `opencode:<provider>/<model>`
// measures an OpenCode model through the same flag. Passing it explicitly
// means a profile or `models` change can never move what a harness measures.
import type { StepResult, StepSpec } from "#review/step-runner";
import type { ResolvedModelRoute } from "../execution/contracts";
import {
  buildHarnessRoutePlan,
  type HarnessIdentity,
  type HarnessRoutePlanInput,
  harnessIdentity,
  harnessModelChoice,
  type PrepareHarnessRunnerInput,
  prepareHarnessRunner,
  routeStep,
} from "./route-runner";

// A production step a harness replays, or a harness-only step with no
// production role (the Martian judge, the trivial micro-eval) under its own
// key. A harness-only step has no profile seat or `models` role: only the
// harness's model routes it.
export type SingleStep =
  | "refuter"
  | "scout"
  | "consolidate"
  | { readonly key: string };

export function singleStepPlanInput(
  step: SingleStep,
  model: string,
): HarnessRoutePlanInput {
  switch (step) {
    case "refuter":
      return {
        agents: [{ key: "refuter", role: "refuter" }],
        bundledAgents: true,
        cliModel: model,
      };
    // These take the model as the stage's own, not cliModel, so the bare
    // pinned id is spelled out here as buildHarnessRoutePlan does for cliModel.
    case "scout":
      return { scout: { model: harnessModelChoice(model) ?? model } };
    case "consolidate":
      return { consolidate: { model: harnessModelChoice(model) ?? model } };
    default:
      return { agents: [{ key: step.key, role: "other" }], cliModel: model };
  }
}

export interface SingleStepRoute {
  readonly step: SingleStep;
  // The model string the harness was given, as its rows record it.
  readonly model: string;
  readonly plan: ReturnType<typeof buildHarnessRoutePlan>;
  readonly stepKey: string;
  readonly identity: HarnessIdentity;
}

// Pure: an invalid model fails here, before anything is admitted or spent.
export function singleStepRoute(
  step: SingleStep,
  model: string,
): SingleStepRoute {
  const plan = buildHarnessRoutePlan(singleStepPlanInput(step, model));
  const identity = harnessIdentity(plan);
  const stepKey = plan.steps[0]?.stepKey as string;
  return { step, model, plan, stepKey, identity };
}

// The identity a row records, under the field names pipeline.json uses.
export interface RouteIdentityFields {
  readonly route: ResolvedModelRoute;
  readonly route_fingerprint: string;
  readonly step_route_fingerprint: string;
}

export function routeIdentityFields(
  identity: HarnessIdentity,
): RouteIdentityFields {
  return {
    route: identity.route,
    route_fingerprint: identity.routeFingerprint,
    step_route_fingerprint: identity.stepRouteFingerprint,
  };
}

// Whether a recorded row ran on the route this run measures, so a resume skips
// it. A row with a step route fingerprint matches on it alone. A row written
// before the seam carries only the model string it was keyed by: it matches
// that string, or any spelling of the same route (`sonnet` and
// `claude:sonnet-latest`), so no paid row is orphaned.
export function ranOnRoute(
  row: { readonly model?: unknown; readonly step_route_fingerprint?: unknown },
  current: SingleStepRoute,
): boolean {
  const fingerprint = current.identity.stepRouteFingerprint;
  if (typeof row.step_route_fingerprint === "string") {
    return row.step_route_fingerprint === fingerprint;
  }
  if (typeof row.model !== "string") return false;
  if (row.model === current.model) return true;
  try {
    return (
      singleStepRoute(current.step, row.model).identity.stepRouteFingerprint ===
      fingerprint
    );
  } catch {
    return false;
  }
}

export interface SingleStepRunner {
  readonly route: SingleStepRoute;
  // Routes the hand-built spec on the plan, then runs it on the guarded
  // production runner.
  run(spec: StepSpec): Promise<StepResult>;
  // The caller's `finally` runs it.
  dispose(): Promise<void>;
}

export type PrepareSingleStepRunnerInput = Omit<
  PrepareHarnessRunnerInput,
  "buildRoutePlan"
> & {
  readonly route: SingleStepRoute;
  // Test seam: prepareHarnessRunner unless given.
  readonly prepare?: typeof prepareHarnessRunner;
};

// A live harness passes `claudeRun: resolveRunClaudeCredential({})`, the
// credential a review chooses at run start; the rest passes through.
export async function prepareSingleStepRunner(
  input: PrepareSingleStepRunnerInput,
): Promise<SingleStepRunner> {
  const { route, prepare = prepareHarnessRunner, ...rest } = input;
  const prepared = await prepare({
    ...rest,
    buildRoutePlan: () => route.plan,
  });
  return {
    route,
    run: (spec) =>
      prepared.runner.run(routeStep(prepared.plan, route.stepKey, spec)),
    dispose: () => prepared.dispose(),
  };
}
