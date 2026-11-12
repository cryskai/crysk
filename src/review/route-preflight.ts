// Route and provider capability preflights: resolve logical route plans,
// enforce executable and provider capability gates, and admit production
// routes across Claude and OpenCode runners before confirming or spending tokens.

import type { ModelsConfig } from "#model/model-name";
import { FALLBACK_PROFILE, type ModelProfile } from "#model/profiles";
import {
  capabilityGateDecision,
  produceClaudeCapabilityReport,
} from "#model/provider-capabilities";
import {
  buildResolvedRoutePlan,
  InvalidModelError,
  planRoutes,
  type ResolvedRoutePlan,
} from "#model/routing";
import { type EngineAssets, resolveEngineAssets } from "../assets";
import { CliError } from "../errors";
import type { RunnerBackend } from "../execution/contracts";
import {
  type OpenCodeCredentialRefusal,
  type ProductionAdmissionContext,
  prepareProductionAdmissionContext,
  probeBindingsReadiness,
} from "../production-runtime";
import type {
  ResolveRunnerAuthorityDeps,
  RunnerAuthorityOptions,
  RunnerAuthorityResolution,
} from "../runner-authority";
import {
  ClaudeCredentialRefusalError,
  CredentialRefusalError,
  claudeCredentialRefusal,
  type RunClaudeCredential,
} from "../security/claude-credential";
import {
  admitRoutePlan,
  createDefaultTransportRegistry,
  type D1_11ReadinessEvidence,
  type TransportRegistry,
} from "../transport-registry";
import type { OpenCodeSdkLike } from "../transports/opencode-client";
import {
  type AgentsDirResolution,
  type CliOptions,
  type ConfigLayer,
  resolveMaterialityGate,
  type SummarySettings,
} from "./preflight";
import {
  type EnginePromptFile,
  type ParsedAgent,
  type ProfilePromptSets,
  profilePromptSet,
} from "./prompt-set";
import type { ReviewSpec } from "./spec";

// Where the engine-owned root prompts are looked up (model-profiles S4). All
// optional: production passes nothing, which is the `claude` profile over the
// runtime's own assets. `promptSets` is injected by tests only, since no
// profile ships a set yet.
export interface EnginePromptOptions {
  profile?: ModelProfile;
  promptSets?: ProfilePromptSets;
  assets?: EngineAssets;
}

// What a production caller hands the pipeline*Input helpers: the run's
// profile is required (openai-profile S3), so a caller cannot forget it and
// silently read the fallback profile's prompts.
export type RunPromptOptions = EnginePromptOptions & { profile: ModelProfile };

// THE read site for an engine-owned root prompt: the active profile's set,
// falling back to the default file. A user `agents_dir` never reaches here:
// it covers the five agent files only, as it always did.
export function enginePromptPath(
  file: EnginePromptFile,
  options: EnginePromptOptions = {},
): string {
  const assets = options.assets ?? resolveEngineAssets();
  const override = profilePromptSet(
    options.profile ?? FALLBACK_PROFILE,
    Object.keys(assets.bundledAgentFiles),
    options.promptSets,
  ).engine[file];
  if (override !== undefined) return override;
  switch (file) {
    case "consolidate.md":
      return assets.consolidatePromptPath;
    case "scout.md":
      return assets.scoutPromptPath;
    case "summarizer.md":
      return assets.summarizerPromptPath;
    case "materiality.md":
      return assets.materialityPromptPath;
  }
}

// Every input below marks its prompt `bundled`: it is the engine's own, so its
// model and effort come from the active profile and never from its
// frontmatter (S3), in the plan and in the step alike. The materiality judge
// needs no mark: its model is pinned (judgeModelChoice) and its frontmatter
// was never read for routing.
export function pipelineSummarizerInput(
  summary: SummarySettings,
  prompts: RunPromptOptions,
):
  | { summarizer: { promptPath: string; model?: string; bundled: true } }
  | Record<string, never> {
  return summary.enabled
    ? {
        summarizer: {
          promptPath: enginePromptPath("summarizer.md", prompts),
          ...(summary.model === undefined ? {} : { model: summary.model }),
          bundled: true,
        },
      }
    : {};
}

// The scout's prompt is ENGINE-owned and lives outside the agents dir, on
// purpose and twice over (§3.7): a `review-scout.md` dropped in the agents dir
// without a spec entry is a hard CliError, and a new prompt-set directory
// holding byte-identical hunter files would be a new fingerprint — which is
// exactly the one-variable property M6 needs to be true by construction rather
// than argued. `prompts/` is the door the summarizer already walked through.
export function pipelineScoutInput(
  options: Pick<CliOptions, "scout" | "scoutModel">,
  prompts: RunPromptOptions,
):
  | { scout: { promptPath: string; model?: string; bundled: true } }
  | Record<string, never> {
  return options.scout
    ? {
        scout: {
          promptPath: enginePromptPath("scout.md", prompts),
          ...(options.scoutModel === undefined
            ? {}
            : { model: options.scoutModel }),
          bundled: true,
        },
      }
    : {};
}

// The consolidation pass is ENGINE-owned like the scout, and on by default in
// both product paths (local and PR/CI) with no flag: it was measured as a net
// gain on the Martian 50 (lab bench/METRICS.md 2026-10-27), and a failed pass
// falls back to the unconsolidated findings. The lab's direct `runPipeline`
// callers do not go through here, so their pipeline is unchanged.
export function pipelineConsolidateInput(prompts: RunPromptOptions): {
  consolidate: { promptPath: string; model?: string; bundled: true };
} {
  return {
    consolidate: {
      promptPath: enginePromptPath("consolidate.md", prompts),
      bundled: true,
    },
  };
}

// The materiality gate (odd/tasks/materiality-gate.md) is ENGINE-owned like
// the consolidation pass but OFF by default: it is config-only
// (`materiality_gate`), and absent means today's pipeline, byte for byte. The
// judge's model is pinned inside the pipeline, so nothing but the prompt path
// travels here.
export function pipelineMaterialityInput(
  config: Pick<ConfigLayer, "materiality_gate">,
  prompts: RunPromptOptions,
): { materiality: { promptPath: string } } | Record<string, never> {
  return resolveMaterialityGate(config)
    ? {
        materiality: {
          promptPath: enginePromptPath("materiality.md", prompts),
        },
      }
    : {};
}

// Whether a run's agents are the engine's bundled prompt set, the one input
// that decides whether their routing comes from the model profile or from
// their frontmatter (model-profiles S3). The resolution's SOURCE, not its
// `kind`: `kind === "bundled"` is the compiled binary only, while dev and npm
// resolve the same bundled set to a real directory with source "default".
// Every product path reads it here, for the plan and the pipeline alike, so the
// two can never disagree about it.
export function isBundledAgentsDir(
  agents: Pick<AgentsDirResolution, "source">,
): boolean {
  return agents.source === "default";
}

export async function buildCliRoutePlan(params: {
  spec: ReviewSpec;
  options: CliOptions;
  agentFiles: Map<string, ParsedAgent>;
  // isBundledAgentsDir of the run's agents. Required so no caller can drop it
  // and build a plan that disagrees with the steps the pipeline composes.
  bundledAgents: boolean;
  models?: ModelsConfig;
  summary: SummarySettings;
  summarizerEnabled?: boolean;
  scoutEnabled?: boolean;
  // Defaults ON, like the stage itself in both product paths; a re-review
  // that skips discovery passes false, the scout's condition, so the plan
  // never carries a route for a step that will not run.
  consolidateEnabled?: boolean;
  // Defaults OFF, unlike consolidation: the gate is opt-in, and a judge key in
  // the plan changes its fingerprint, so absent must mean today's plan.
  materialityEnabled?: boolean;
  // The active model profile (openai-profile S3): the config's `profile`,
  // resolved once (resolveProfile). Required so the compiler finds every
  // caller: a missed one would silently plan the fallback profile.
  profile: ModelProfile;
}): Promise<ResolvedRoutePlan> {
  const summarizerEnabled = params.summarizerEnabled ?? params.summary.enabled;
  const scoutEnabled = params.scoutEnabled ?? params.options.scout;
  const consolidateEnabled = params.consolidateEnabled ?? true;
  // The root prompts are the engine's own (pipeline*Input marks them), so
  // their frontmatter is not read: the profile holds their seat (S3), the
  // same seat the pipeline gives each step, and the two cannot disagree.
  return buildResolvedRoutePlan({
    agents: params.spec.agents,
    cliModel: params.options.model,
    models: params.models,
    profile: params.profile,
    ...(params.bundledAgents ? { bundledAgents: true } : {}),
    frontmatterModel: (agentKey) => params.agentFiles.get(agentKey)?.model,
    ...(summarizerEnabled
      ? { summarizer: { model: params.summary.model, bundled: true } }
      : {}),
    ...(scoutEnabled
      ? { scout: { model: params.options.scoutModel, bundled: true } }
      : {}),
    ...(consolidateEnabled ? { consolidate: { bundled: true } } : {}),
    ...(params.materialityEnabled === true
      ? { materiality: true as const }
      : {}),
  });
}

// Whether a run needs the Claude binary's execution authority: always for the
// legacy no-plan runner (it is the Claude CLI), otherwise only when some route
// or fallback runs on claude-code. CI skips the Claude install exactly when no
// step routes to it (routing-claude=false), so this check must agree.
export function claudeAuthorityRequired(
  routePlan: ResolvedRoutePlan | undefined,
): boolean {
  if (routePlan === undefined) return true;
  return planRoutes(routePlan).some(
    (step) => step.route.backend === "claude-code",
  );
}

// Whether a plan that failed to build may fall back to the legacy no-plan
// path (a prompt or `--model` naming a raw Claude id the CLI resolves itself).
// Never when `models` is set, and never for a model written in the new form:
// both are the operator's words, and the error is how to fix them.
function planErrorIsFatal(error: unknown, modelsConfigured: boolean): boolean {
  return modelsConfigured || error instanceof InvalidModelError;
}

// Pre-confirm route resolution: legacy runs without `models` may omit route
// provenance when the plan cannot be built, but admission failures must
// always surface before confirm — never be swallowed into routePlan = undefined.
export async function resolveRoutePlanAtConfirm(input: {
  modelsConfigured: boolean;
  buildRoutePlan: () => Promise<ResolvedRoutePlan>;
  registry?: TransportRegistry;
}): Promise<ResolvedRoutePlan | undefined> {
  const registry =
    input.registry ?? createDefaultTransportRegistry({ mode: "production" });
  let routePlan: ResolvedRoutePlan;
  try {
    routePlan = await input.buildRoutePlan();
  } catch (error) {
    if (planErrorIsFatal(error, input.modelsConfigured)) throw error;
    return undefined;
  }
  await admitRoutePlan(routePlan, registry);
  return routePlan;
}

// The OpenCode refusal: a route the plan runs has no credential record in the run's
// OpenCode auth file (openCodeCredentialRefusal, production-runtime.ts). It is the
// failure the route's first step would hit (CRYSK-CRED-UNUSABLE), raised before any
// spend.
export class OpenCodeCredentialRefusalError extends CredentialRefusalError {
  constructor(refusal: OpenCodeCredentialRefusal) {
    super(
      refusal.message,
      { kind: "credential", failureClass: refusal.failureClass },
      refusal.params,
      refusal.failureClass === "subscription_expiring"
        ? `subscription login for OpenCode provider ${refusal.params.provider} expires within the review; refused before any provider spend`
        : `no credential record for OpenCode provider ${refusal.params.provider}; refused before any provider spend`,
    );
  }
}

export interface ProductionRoutePlanResult {
  readonly routePlan: ResolvedRoutePlan;
  readonly productionAdmission: ProductionAdmissionContext;
}

// Production admission: discover per-backend executable authority, derive
// D1-11 evidence from exact-binding probes, and admit with one shared registry.
export async function resolveProductionRoutePlanAtConfirm(input: {
  modelsConfigured: boolean;
  workspaceRoot: string;
  buildRoutePlan: () => Promise<ResolvedRoutePlan>;
  authorityDeps?: ResolveRunnerAuthorityDeps;
  loadSdk?: () => Promise<OpenCodeSdkLike>;
  env?: RunnerAuthorityOptions["env"];
  // S5: the Claude credential chosen at run start. Its env replaces `env` (it is the
  // process environment with one Claude credential left), and a plan that needs
  // Claude with no listed credential present is refused here, before admission.
  claudeRun?: RunClaudeCredential;
  // False on a dry run, which authenticates nothing: no OpenCode route is refused
  // for a missing record (the Claude check is skipped by passing no claudeRun).
  checkCredentials?: boolean;
}): Promise<ProductionRoutePlanResult | undefined> {
  const refuse = (planHasClaudeRoute: boolean): void => {
    if (input.claudeRun === undefined) return;
    const refusal = claudeCredentialRefusal(
      input.claudeRun.selection,
      planHasClaudeRoute,
    );
    if (refusal !== undefined) throw new ClaudeCredentialRefusalError(refusal);
  };
  let routePlan: ResolvedRoutePlan;
  try {
    routePlan = await input.buildRoutePlan();
  } catch (error) {
    if (planErrorIsFatal(error, input.modelsConfigured)) throw error;
    // The legacy no-plan path runs every step on the Claude CLI.
    refuse(true);
    return undefined;
  }
  refuse(
    planRoutes(routePlan).some((step) => step.route.backend === "claude-code"),
  );

  const env = input.claudeRun?.env ?? input.env;
  const productionAdmission = await prepareProductionAdmissionContext({
    workspaceRoot: input.workspaceRoot,
    plan: routePlan,
    authorityDeps: input.authorityDeps,
    loadSdk: input.loadSdk,
    ...(input.checkCredentials === false ? { checkCredentials: false } : {}),
    ...(env === undefined ? {} : { env }),
    ...(input.claudeRun?.kind === undefined
      ? {}
      : { claudeCredential: input.claudeRun.kind }),
  });
  if ("error" in productionAdmission) {
    if (productionAdmission.credentialRefusal !== undefined) {
      throw new OpenCodeCredentialRefusalError(
        productionAdmission.credentialRefusal,
      );
    }
    throw new CliError(
      `production admission failed: ${productionAdmission.error}`,
    );
  }
  await admitRoutePlan(routePlan, productionAdmission.registry, {
    mode: "production",
    evidence: productionAdmission.evidence,
  });
  return { routePlan, productionAdmission };
}

export async function enforceProviderCapabilityGate(input: {
  routePlan: ResolvedRoutePlan | undefined;
  workspaceRoot: string;
  runnerAuthority?: RunnerAuthorityResolution;
  authorityOptions?: RunnerAuthorityOptions;
  admissionRegistry?: TransportRegistry;
  productionEvidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
}): Promise<void> {
  if (input.routePlan === undefined) {
    if (input.runnerAuthority?.error !== undefined) {
      throw new CliError(
        `execution authority unavailable: ${input.runnerAuthority.error}`,
      );
    }
    // S5: the run env (one Claude credential, under the CLI's name), the same object
    // the legacy runner hands its child, so the auth check sees the credential the
    // run chose (a CRYSK_* secret included) and never one it stripped.
    const runEnv = input.runnerAuthority?.runnerOptions?.childEnv;
    const capabilityReport = await produceClaudeCapabilityReport(
      runEnv === undefined ? {} : { env: { ...runEnv } },
    );
    const capabilityGate = capabilityGateDecision(capabilityReport);
    if (!capabilityGate.ok) {
      throw new CliError(
        `provider capability gate failed: ${capabilityGate.reason}`,
      );
    }
    return;
  }
  const authorityOptions =
    input.authorityOptions ??
    (input.runnerAuthority?.error !== undefined
      ? undefined
      : {
          workspaceRoot: input.workspaceRoot,
          binaryPath: input.runnerAuthority?.runnerOptions.binaryPath,
          executableAllowlists: {
            "claude-code":
              input.runnerAuthority?.runnerOptions.executableAllowlist ?? [],
          },
        });
  if (authorityOptions === undefined) {
    throw new CliError(
      `execution authority unavailable: ${input.runnerAuthority?.error ?? "missing production authority options"}`,
    );
  }
  const probe = await probeBindingsReadiness({
    ...authorityOptions,
    plan: input.routePlan,
    workspaceRoot: input.workspaceRoot,
    registry: input.admissionRegistry,
    mode: "production",
    evidence: input.productionEvidence,
  });
  if (!probe.decision.ok) {
    await probe.dispose();
    throw new CliError(
      `provider capability gate failed: ${probe.decision.reason}`,
    );
  }
  await probe.dispose();
}
