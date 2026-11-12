// The route plan a whole-pipeline harness (refuter-probe, fixture-eval)
// passes runPipeline (odd/tasks/route-plan-harness.md S4). Today such a
// harness passes no plan, and runPipeline builds one for itself but runs the
// runner it was given, so a ClaudeCodeRunner beside an OpenCode route runs
// silently on Claude. With this plan the harness prepares the runner through
// the seam (prepareHarnessRunner) and runPipeline binds every step to its
// route.
//
// The plan is built from the SAME input runPipeline receives, with the same
// inputs runPipeline's own no-plan build reads (pipeline.ts, "Step 2.5"), so
// what a harness measured before is what it measures now (S6): the plan's
// fingerprint equals the one a no-plan run records. buildCliRoutePlan is the
// CLI's plan and differs on purpose (bundled root prompts, consolidation on),
// so a harness that mirrors a lab-style run cannot use it.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildResolvedRoutePlan, type ResolvedRoutePlan } from "#model/routing";
import type { PipelineInput } from "#review/pipeline";
import { parseAgentFile } from "#review/prompt-set";
import { defaultReviewSpec, validateReviewSpec } from "#review/spec";
import type { ResolvedModelRoute } from "../execution/contracts";
import { HarnessRouteError, harnessModelChoice } from "./route-runner";

// Every PipelineInput field runPipeline reads to build its own plan.
export type PipelinePlanInput = Pick<
  PipelineInput,
  | "spec"
  | "agentsDir"
  | "bundledAgents"
  | "modelProfile"
  | "model"
  | "models"
  | "config"
  | "summarizer"
  | "scout"
  | "consolidate"
  | "materiality"
>;

async function rootFrontmatter(
  stage: { promptPath: string; bundled?: boolean } | undefined,
): Promise<string | undefined> {
  if (stage === undefined || stage.bundled === true) return undefined;
  return (await parseAgentFile(stage.promptPath)).model;
}

// Unlike runPipeline, an unreadable prompt fails here: the harness learns of
// it before admission rather than from a plan that silently lacks a model.
export async function buildPipelineHarnessPlan(
  input: PipelinePlanInput,
): Promise<ResolvedRoutePlan> {
  const spec = validateReviewSpec(input.spec ?? defaultReviewSpec());
  // A diversity run routes its expanded legs (diversityCtx.routeAgents), which
  // this plan does not build; runPipeline would refuse it as a missing route.
  if (spec.multiModelDiversity?.enabled === true) {
    throw new HarnessRouteError(
      "a multi-model diversity spec routes its expanded legs; a pipeline harness plan does not build them",
    );
  }
  const frontmatter = new Map<string, string | undefined>();
  for (const agent of spec.agents) {
    const parsed = await parseAgentFile(path.join(input.agentsDir, agent.file));
    frontmatter.set(agent.key, parsed.model);
  }
  const models = input.models ?? input.config?.effective?.models;
  const stage = async (
    value:
      | { promptPath: string; model?: string; bundled?: boolean }
      | undefined,
  ) =>
    value === undefined
      ? undefined
      : {
          model: value.model,
          frontmatterModel: await rootFrontmatter(value),
          bundled: value.bundled === true,
        };
  const summarizer = await stage(input.summarizer);
  const scout = await stage(input.scout);
  const consolidate = await stage(input.consolidate);
  return buildResolvedRoutePlan({
    agents: spec.agents,
    cliModel: harnessModelChoice(input.model),
    models,
    ...(input.modelProfile === undefined
      ? {}
      : { profile: input.modelProfile }),
    ...(input.bundledAgents === true ? { bundledAgents: true } : {}),
    frontmatterModel: (agentKey) => frontmatter.get(agentKey),
    ...(summarizer === undefined ? {} : { summarizer }),
    ...(scout === undefined ? {} : { scout }),
    ...(consolidate === undefined ? {} : { consolidate }),
    ...(input.materiality === undefined ? {} : { materiality: true as const }),
  });
}

export interface PipelineRouteIdentity {
  readonly route: ResolvedModelRoute;
  readonly routeFingerprint: string;
  readonly stepRouteFingerprint: string;
}

interface RecordedPlan {
  route_fingerprint?: string;
  route_plan?: {
    steps?: Array<{
      stepKey: string;
      route: ResolvedModelRoute;
      routeFingerprint: string;
    }>;
  };
}

// The identity of the route a pipeline run executed for one step, read back
// from the run's own pipeline.json, never from the harness's intent.
export async function readPipelineRouteIdentity(
  runDir: string,
  stepKey: string,
): Promise<PipelineRouteIdentity> {
  const file = path.join(runDir, "pipeline.json");
  const recorded = JSON.parse(await readFile(file, "utf8")) as RecordedPlan;
  const step = recorded.route_plan?.steps?.find((s) => s.stepKey === stepKey);
  if (step === undefined || recorded.route_fingerprint === undefined) {
    throw new HarnessRouteError(
      `${file} records no route for step "${stepKey}"`,
    );
  }
  return {
    route: step.route,
    routeFingerprint: recorded.route_fingerprint,
    stepRouteFingerprint: step.routeFingerprint,
  };
}
