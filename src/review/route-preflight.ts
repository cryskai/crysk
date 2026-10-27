// Route and provider capability preflights: resolve logical route plans,
// enforce executable and provider capability gates, and admit production
// routes across Claude and OpenCode runners before confirming or spending tokens.

import {
  capabilityGateDecision,
  produceClaudeCapabilityReport,
} from "#model/provider-capabilities";
import {
  buildResolvedRoutePlan,
  type ResolvedRoutePlan,
  type RoutingConfig,
} from "#model/routing";
import { resolveEngineAssets } from "../assets";
import { CliError } from "../errors";
import type { RunnerBackend } from "../execution/contracts";
import {
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
  admitRoutePlan,
  createDefaultTransportRegistry,
  type D1_11ReadinessEvidence,
  type TransportRegistry,
} from "../transport-registry";
import type { OpenCodeSdkLike } from "../transports/opencode-client";
import { DEFAULT_CONSOLIDATE_MODEL, DEFAULT_SCOUT_MODEL } from "./pipeline";
import type { CliOptions, SummarySettings } from "./preflight";
import { type ParsedAgent, parseAgentFile } from "./prompt-set";
import type { ReviewSpec } from "./spec";

export function pipelineSummarizerInput(
  summary: SummarySettings,
):
  | { summarizer: { promptPath: string; model?: string } }
  | Record<string, never> {
  return summary.enabled
    ? {
        summarizer: {
          promptPath: resolveEngineAssets().summarizerPromptPath,
          ...(summary.model === undefined ? {} : { model: summary.model }),
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
): { scout: { promptPath: string; model?: string } } | Record<string, never> {
  return options.scout
    ? {
        scout: {
          promptPath: resolveEngineAssets().scoutPromptPath,
          ...(options.scoutModel === undefined
            ? {}
            : { model: options.scoutModel }),
        },
      }
    : {};
}

// The consolidation pass is ENGINE-owned like the scout, and on by default in
// both product paths (local and PR/CI) with no flag: it was measured as a net
// gain on the Martian 50 (lab bench/METRICS.md 2026-10-27), and a failed pass
// falls back to the unconsolidated findings. The lab's direct `runPipeline`
// callers do not go through here, so their pipeline is unchanged.
export function pipelineConsolidateInput(): {
  consolidate: { promptPath: string; model?: string };
} {
  return {
    consolidate: { promptPath: resolveEngineAssets().consolidatePromptPath },
  };
}

export async function buildCliRoutePlan(params: {
  spec: ReviewSpec;
  options: CliOptions;
  agentFiles: Map<string, ParsedAgent>;
  routingConfig?: RoutingConfig;
  summary: SummarySettings;
  summarizerEnabled?: boolean;
  scoutEnabled?: boolean;
  // Defaults ON, like the stage itself in both product paths; a re-review
  // that skips discovery passes false, the scout's condition, so the plan
  // never carries a route for a step that will not run.
  consolidateEnabled?: boolean;
}): Promise<ResolvedRoutePlan> {
  const summarizerEnabled = params.summarizerEnabled ?? params.summary.enabled;
  const scoutEnabled = params.scoutEnabled ?? params.options.scout;
  const consolidateEnabled = params.consolidateEnabled ?? true;
  let summarizerFrontmatter: string | undefined;
  if (summarizerEnabled) {
    try {
      const parsed = await parseAgentFile(
        resolveEngineAssets().summarizerPromptPath,
      );
      summarizerFrontmatter = parsed.model;
    } catch {
      // Engine-owned prompt may be unreadable in tests; route resolution still
      // falls through CLI > spec > frontmatter precedence without it.
    }
  }
  let scoutFrontmatter: string | undefined;
  if (scoutEnabled) {
    try {
      const parsed = await parseAgentFile(
        resolveEngineAssets().scoutPromptPath,
      );
      scoutFrontmatter = parsed.model;
    } catch {
      // Same contract as the summarizer branch above.
    }
  }
  let consolidateFrontmatter: string | undefined;
  if (consolidateEnabled) {
    try {
      const parsed = await parseAgentFile(
        resolveEngineAssets().consolidatePromptPath,
      );
      consolidateFrontmatter = parsed.model;
    } catch {
      // Same contract as the summarizer branch above.
    }
  }
  return buildResolvedRoutePlan({
    agents: params.spec.agents,
    cliModel: params.options.model,
    routingConfig: params.routingConfig,
    frontmatterModel: (agentKey) => params.agentFiles.get(agentKey)?.model,
    ...(summarizerEnabled
      ? {
          summarizer: {
            model: params.summary.model,
            frontmatterModel: summarizerFrontmatter,
          },
        }
      : {}),
    ...(scoutEnabled
      ? {
          scout: {
            model: params.options.scoutModel,
            frontmatterModel: scoutFrontmatter,
            defaultModel: DEFAULT_SCOUT_MODEL,
          },
        }
      : {}),
    ...(consolidateEnabled
      ? {
          consolidate: {
            frontmatterModel: consolidateFrontmatter,
            defaultModel: DEFAULT_CONSOLIDATE_MODEL,
          },
        }
      : {}),
  });
}

// Pre-confirm route resolution: legacy runs without operator routing may omit
// route provenance when the plan cannot be built, but admission failures must
// always surface before confirm — never be swallowed into routePlan = undefined.
export async function resolveRoutePlanAtConfirm(input: {
  routingConfigured: boolean;
  buildRoutePlan: () => Promise<ResolvedRoutePlan>;
  registry?: TransportRegistry;
}): Promise<ResolvedRoutePlan | undefined> {
  const registry =
    input.registry ?? createDefaultTransportRegistry({ mode: "production" });
  let routePlan: ResolvedRoutePlan;
  try {
    routePlan = await input.buildRoutePlan();
  } catch (error) {
    if (input.routingConfigured) throw error;
    return undefined;
  }
  await admitRoutePlan(routePlan, registry);
  return routePlan;
}

export interface ProductionRoutePlanResult {
  readonly routePlan: ResolvedRoutePlan;
  readonly productionAdmission: ProductionAdmissionContext;
}

// Production admission: discover per-backend executable authority, derive
// D1-11 evidence from exact-binding probes, and admit with one shared registry.
export async function resolveProductionRoutePlanAtConfirm(input: {
  routingConfigured: boolean;
  workspaceRoot: string;
  buildRoutePlan: () => Promise<ResolvedRoutePlan>;
  authorityDeps?: ResolveRunnerAuthorityDeps;
  loadSdk?: () => Promise<OpenCodeSdkLike>;
  env?: RunnerAuthorityOptions["env"];
}): Promise<ProductionRoutePlanResult | undefined> {
  let routePlan: ResolvedRoutePlan;
  try {
    routePlan = await input.buildRoutePlan();
  } catch (error) {
    if (input.routingConfigured) throw error;
    return undefined;
  }

  const productionAdmission = await prepareProductionAdmissionContext({
    workspaceRoot: input.workspaceRoot,
    plan: routePlan,
    authorityDeps: input.authorityDeps,
    loadSdk: input.loadSdk,
    env: input.env,
  });
  if ("error" in productionAdmission) {
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
    const capabilityReport = await produceClaudeCapabilityReport({});
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
