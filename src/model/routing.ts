import { createHash } from "node:crypto";
import type { ResolvedModelRoute, RunnerBackend } from "../execution/contracts";
import { redactDiagnostic } from "../security/redact";
import {
  isModelAlias,
  lookupAlias,
  type ModelAlias,
  reverseAliasForCanonical,
} from "./catalog";

export type ModelGateway = "configured" | "direct" | "openrouter";
export type { ResolvedModelRoute, RunnerBackend };

export interface RouteMapping {
  readonly logical?: string;
  readonly backend: RunnerBackend;
  readonly provider: string;
  readonly gateway?: ModelGateway;
  readonly modelFamily?: string;
  readonly modelSnapshot?: string;
  readonly modelVariant?: string;
  readonly disabled?: boolean;
  readonly allowSpend?: boolean;
}

export interface RoutingConfig {
  readonly default?: RouteMapping;
  readonly mappings?: readonly RouteMapping[] | Record<string, RouteMapping>;
  readonly disabled?: boolean;
}

function mappingNeedsOpenCodeSdk(mapping: RouteMapping | undefined): boolean {
  if (mapping === undefined) return false;
  return (
    mapping.backend === "opencode" &&
    mapping.disabled !== true &&
    mapping.allowSpend !== false
  );
}

// Spend that would actually open an OpenCode transport. A disabled route,
// a mapping that refuses spend, or no routing at all does not.
export function routingNeedsOpenCodeSdk(
  routing: RoutingConfig | undefined,
): boolean {
  if (routing === undefined || routing.disabled === true) return false;
  if (mappingNeedsOpenCodeSdk(routing.default)) return true;
  const mappings = routing.mappings;
  if (mappings === undefined) return false;
  const entries = Array.isArray(mappings) ? mappings : Object.values(mappings);
  return entries.some((entry) => mappingNeedsOpenCodeSdk(entry));
}

export interface ParsedLogicalIdentity {
  readonly raw: string;
  readonly canonical: string;
  readonly provider: string;
  readonly model: string;
  readonly variant?: string;
  readonly alias?: ModelAlias;
}

export interface ResolvedStepRoute {
  readonly stepKey: string;
  readonly role: string;
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
export class UnmappedRouteError extends ModelRoutingError {}
export class AmbiguousMappingError extends ModelRoutingError {}
export class UnauthorizedRouteError extends ModelRoutingError {}

export type { ModelAlias } from "./catalog";
export {
  aliasCanonical,
  isModelAlias,
  lookupAlias,
  MODEL_CATALOG,
} from "./catalog";

const SLASH_GRAMMAR_REGEX =
  /^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+)(?:#([a-zA-Z0-9._-]+))?$/;

export function parseLogicalIdentity(raw: string): ParsedLogicalIdentity {
  if (typeof raw !== "string") {
    throw new ModelRoutingError("Model identity must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ModelRoutingError("Model identity cannot be empty");
  }

  if (isModelAlias(trimmed)) {
    const aliasInfo = lookupAlias(trimmed);
    return {
      raw: trimmed,
      canonical: aliasInfo.canonical,
      provider: aliasInfo.provider,
      // #175: the alias IS the model segment now. `parsed.model` feeds both
      // `modelFamily` and `modelSnapshot` on the default alias route below,
      // so this is the single line that decides what our provenance claims
      // an alias run used — and after #175 it claims the name that was
      // actually sent to the CLI, not a version we never verified.
      model: aliasInfo.alias,
      alias: trimmed,
    };
  }

  const match = trimmed.match(SLASH_GRAMMAR_REGEX);
  if (match) {
    const [, provider, model, variant] = match;
    const canonical = `${provider}/${model}${variant ? `#${variant}` : ""}`;
    return {
      raw: trimmed,
      canonical,
      provider,
      model,
      ...(variant !== undefined ? { variant } : {}),
    };
  }

  const safeRaw = redactDiagnostic(raw);
  throw new ModelRoutingError(
    `Unknown model identity "${safeRaw}": bare model names must be an alias (sonnet|opus|haiku) or use slash grammar provider/model(#variant)`,
  );
}

// #175 follow-up, 2026-09-02. THE ONE PLACE a route's `modelSnapshot` may fall
// back to the parsed identity. It exists as a function because the fallback had
// THREE copies — array mappings, record mappings, default mapping — and a guard
// added to one of them is the "two copies drift" failure this repo keeps paying
// for.
//
// WHAT IT REFUSES, and why refusing is the only honest option: #175 made a bare
// alias parse to the alias WORD (`parsed.model === "sonnet"`), where it used to
// parse to a version pinned in our own catalogue. That pin was the lie #175
// deleted — only the Claude CLI knows what `sonnet` currently means. But the
// fallback then started handing the bare word to consumers that resolve
// nothing: `transport-registry.ts` forwards `modelSnapshot` verbatim as the
// OpenCode SDK's `modelID`, so a `{"sonnet": {"backend": "opencode"}}` config
// went from sending a real model id to sending the word "sonnet" to a live API.
//
// #176 follow-up, 2026-09-02. THE AXIS IS THE GATEWAY, NOT THE BACKEND. This
// guard's first version refused on `mapping.backend !== "claude-code"`, and
// that door had a hole the size of the defect it closed: `claude-code` only
// resolves the alias itself when the route's gateway is `direct`.
// `spawnModelForClaudeCli` is explicit about it — on any other gateway it
// returns `route.modelSnapshot` verbatim as `--model`, without ever consulting
// the alias table. So `{"sonnet": {"backend": "claude-code", "provider":
// "anthropic"}}` sent `--model sonnet` to a CLI pointed at a gateway that never
// heard of pr-hero's aliases. The predicate below therefore asks the only
// question that matters — DOES THE CONSUMER RESOLVE THIS WORD? — which is true
// in exactly one combination: `claude-code` AND `direct`.
//
// AND MIND THE TWO DIVERGENT GATEWAY DEFAULTS, because the divergence IS what
// let the hole open. Route resolution defaults an absent `gateway` to
// `"configured"` (the three `?? "configured"` call sites below);
// `spawnModelForClaudeCli` defaults an absent one to `"direct"` (and so does
// `report.ts`'s renderer). Those are not the same rule, and only the first one
// is correct here: this guard runs while the route is being BUILT, so it must
// use the value the route is about to assert, not the value a later reader
// would infer from a route that omitted it. Hence `gateway` is passed IN, read
// off the same `?? "configured"` expression that populates the route's own
// field — a fourth independent copy of that default inside this helper is
// exactly the drift this helper exists to prevent.
//
// HOW MUCH the old fallback actually got right, measured on `dev` rather than
// assumed, because it bounds what this guard is restoring: the snapshot came
// from the CATALOGUE, never from the mapping's `provider`. So `sonnet` ->
// opencode/`anthropic` did resolve to `claude-sonnet-5`, and that is the config
// this fix stops breaking — but `sonnet` -> opencode/`openai` sent
// `claude-sonnet-5` to OpenAI, nonsense before #175 and nonsense after. The
// guard refuses BOTH, which is why it is a guard and not a restored pin: we
// cannot know the version, and we must not fabricate one, so the route is
// refused and the operator is told the one thing that fixes it.
//
// THE PREDICATE IS THE ALIAS IDENTITY, not the model segment. `reverseAlias` is
// set for the bare word AND for its canonical `provider/alias` form — the key
// shape this repo's own configs use via `aliasCanonical()`, so a guard on the
// bare word alone would be bypassed by the recommended key. It is unset for
// slash grammar, where the segment is the operator's own words and forwarding
// them verbatim is correct. `anthropic/sonnet#high` is not the registered
// canonical and so passes through: that hole predates #175 (the same
// `?? parsed.model` produced `"sonnet"` for it on `dev` too) and is not this
// regression.
//
// WHY `modelFamily` KEEPS ITS `?? parsed.model` FALLBACK and is deliberately
// NOT guarded here — stated so the next reader does not "complete" the fix:
// (1) it never reaches a provider — the wire identity is `modelSnapshot`, read
// by `transport-registry.ts` for OpenCode's `modelID`, by
// `spawnModelForClaudeCli` for `--model`, and by pricing admission in
// `production-runtime.ts`; (2) `"sonnet"` is a truthful FAMILY label, not a
// fabricated version, so unlike the snapshot it asserts nothing false; and
// (3) this guard already refuses the whole route in the only case where an
// alias-derived family could reach a consumer that does not resolve aliases
// with no snapshot. Guarding it too would force operators to supply both fields
// and buy no safety.
function routeModelSnapshot(
  mapping: RouteMapping,
  parsed: ParsedLogicalIdentity,
  reverseAlias: ModelAlias | undefined,
  gateway: ModelGateway,
  mappingLabel: string,
): string {
  if (mapping.modelSnapshot !== undefined) {
    return mapping.modelSnapshot;
  }
  // The one combination whose consumer resolves the bare word itself, so the
  // alias IS the honest snapshot: the Claude CLI, reached directly.
  const consumerResolvesAlias =
    mapping.backend === "claude-code" && gateway === "direct";
  if (reverseAlias !== undefined && !consumerResolvesAlias) {
    // `UnmappedRouteError` and not a new class: a mapping was found, but it
    // leaves the alias unmapped to any provider model id, which is what this
    // error already names. Nothing in src/ catches these classes, so the
    // choice is about meaning, and a fifth class would have no consumer.
    throw new UnmappedRouteError(
      redactDiagnostic(
        `Model alias "${reverseAlias}" is routed to backend "${mapping.backend}" over the "${gateway}" gateway by the ${mappingLabel}, which supplies no "modelSnapshot". Only the Claude CLI reached over the "direct" gateway resolves a bare alias; every other gateway forwards the model identity verbatim to an endpoint that never registered pr-hero's aliases, so this route has no provider model id to send. Add an explicit "modelSnapshot" naming the provider's model id to that ${mappingLabel}, or set its "gateway" to "direct" if the Claude CLI really is resolving this alias.`,
      ),
    );
  }
  return parsed.model;
}

export function resolveModelRoute(
  logicalInput: string,
  config?: RoutingConfig,
): ResolvedModelRoute {
  const parsed = parseLogicalIdentity(logicalInput);
  const reverseAlias = reverseAliasForCanonical(parsed.canonical);

  if (config !== undefined) {
    if (config.disabled === true) {
      throw new UnauthorizedRouteError(
        redactDiagnostic(
          `Spend is disabled for model route "${parsed.canonical}"`,
        ),
      );
    }

    if (config.mappings !== undefined) {
      if (Array.isArray(config.mappings)) {
        const matches = config.mappings.filter((entry) => {
          if (!entry || typeof entry !== "object") return false;
          if (entry.logical === parsed.canonical) return true;
          if (entry.logical === parsed.raw) return true;
          if (parsed.alias && entry.logical === parsed.alias) return true;
          if (reverseAlias && entry.logical === reverseAlias) return true;
          return false;
        });

        if (matches.length > 1) {
          throw new AmbiguousMappingError(
            redactDiagnostic(
              `Ambiguous model routing: found ${matches.length} duplicate mappings for "${parsed.canonical}"`,
            ),
          );
        }

        if (matches.length === 1) {
          const m = matches[0];
          if (m.disabled === true || m.allowSpend === false) {
            throw new UnauthorizedRouteError(
              redactDiagnostic(
                `Spend is disabled for model route "${parsed.canonical}"`,
              ),
            );
          }
          // One `?? "configured"` per branch, shared by the route field and the
          // guard, so the value the guard judges is the value the route claims.
          const gateway = m.gateway ?? "configured";
          return {
            backend: m.backend,
            provider: m.provider,
            gateway,
            modelFamily: m.modelFamily ?? parsed.model,
            modelSnapshot: routeModelSnapshot(
              m,
              parsed,
              reverseAlias,
              gateway,
              "routing mapping",
            ),
            ...(m.modelVariant !== undefined || parsed.variant !== undefined
              ? { modelVariant: m.modelVariant ?? parsed.variant }
              : {}),
          };
        }
      } else if (
        typeof config.mappings === "object" &&
        config.mappings !== null
      ) {
        const record = config.mappings as Record<string, RouteMapping>;
        const candidateKeys = Array.from(
          new Set(
            [parsed.canonical, parsed.alias, reverseAlias, parsed.raw].filter(
              (key): key is string => key !== undefined,
            ),
          ),
        );
        const matchedKeys = candidateKeys.filter((key) => key in record);

        if (matchedKeys.length > 1) {
          throw new AmbiguousMappingError(
            redactDiagnostic(
              `Ambiguous model routing: found ${matchedKeys.length} duplicate mappings for "${parsed.canonical}" in record mappings`,
            ),
          );
        }

        const m = matchedKeys.length > 0 ? record[matchedKeys[0]] : undefined;

        if (m !== undefined) {
          if (m.disabled === true || m.allowSpend === false) {
            throw new UnauthorizedRouteError(
              redactDiagnostic(
                `Spend is disabled for model route "${parsed.canonical}"`,
              ),
            );
          }
          // Same shared `?? "configured"` as the array branch: the guard and
          // the recorded route must never read two different gateways.
          const gateway = m.gateway ?? "configured";
          return {
            backend: m.backend,
            provider: m.provider,
            gateway,
            modelFamily: m.modelFamily ?? parsed.model,
            modelSnapshot: routeModelSnapshot(
              m,
              parsed,
              reverseAlias,
              gateway,
              "routing mapping",
            ),
            ...(m.modelVariant !== undefined || parsed.variant !== undefined
              ? { modelVariant: m.modelVariant ?? parsed.variant }
              : {}),
          };
        }
      }
    }

    if (config.default !== undefined) {
      const def = config.default;
      if (def.disabled === true || def.allowSpend === false) {
        throw new UnauthorizedRouteError(
          redactDiagnostic("Spend is disabled for default model route"),
        );
      }
      // Third and last copy of the same shared default, for the same reason.
      const gateway = def.gateway ?? "configured";
      return {
        backend: def.backend,
        provider: def.provider,
        gateway,
        modelFamily: def.modelFamily ?? parsed.model,
        modelSnapshot: routeModelSnapshot(
          def,
          parsed,
          reverseAlias,
          gateway,
          "default routing mapping",
        ),
        ...(def.modelVariant !== undefined || parsed.variant !== undefined
          ? { modelVariant: def.modelVariant ?? parsed.variant }
          : {}),
      };
    }
  }

  if (parsed.alias !== undefined) {
    return {
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: parsed.model,
      modelSnapshot: parsed.model,
      ...(parsed.variant !== undefined ? { modelVariant: parsed.variant } : {}),
    };
  }

  throw new UnmappedRouteError(
    redactDiagnostic(
      `No route mapping found for logical model "${parsed.canonical}"`,
    ),
  );
}

export function computeRouteFingerprint(
  canonicalLogical: string,
  route: ResolvedModelRoute,
): string {
  const payload = JSON.stringify({
    logical: canonicalLogical,
    backend: route.backend,
    provider: route.provider,
    gateway: route.gateway ?? "",
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

export function resolveLogicalModel(
  cliModel?: string,
  specModel?: string,
  frontmatterModel?: string,
  stepName?: string,
): string {
  const model = cliModel ?? specModel ?? frontmatterModel;
  if (!model || (typeof model === "string" && model.trim().length === 0)) {
    throw new ModelRoutingError(
      `agent ${stepName ?? "step"} has no model and no override given`,
    );
  }
  return model.trim();
}

export interface ResolveStepRouteInput {
  readonly stepKey: string;
  readonly role: string;
  readonly cliModel?: string;
  readonly specModel?: string;
  readonly frontmatterModel?: string;
  readonly routingConfig?: RoutingConfig;
}

export function resolveStepRoute(
  input: ResolveStepRouteInput,
): ResolvedStepRoute {
  const logical = resolveLogicalModel(
    input.cliModel,
    input.specModel,
    input.frontmatterModel,
    input.stepKey,
  );
  const parsed = parseLogicalIdentity(logical);
  const route = resolveModelRoute(logical, input.routingConfig);
  const routeFingerprint = computeRouteFingerprint(parsed.canonical, route);
  return {
    stepKey: input.stepKey,
    role: input.role,
    logicalIdentity: parsed.canonical,
    route,
    routeFingerprint,
  };
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

export interface BuildRoutePlanInput {
  readonly agents: readonly { key: string; role: string; model?: string }[];
  readonly cliModel?: string;
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
}

export function buildResolvedRoutePlan(
  input: BuildRoutePlanInput,
): ResolvedRoutePlan {
  const stepRoutes: ResolvedStepRoute[] = [];
  for (const agent of input.agents) {
    stepRoutes.push(
      resolveStepRoute({
        stepKey: agentStepKey(agent),
        role: agent.role,
        cliModel: input.cliModel,
        specModel: agent.model,
        frontmatterModel: input.frontmatterModel?.(agent.key),
        routingConfig: input.routingConfig,
      }),
    );
  }
  if (input.summarizer) {
    stepRoutes.push(
      resolveStepRoute({
        stepKey: "summarizer",
        role: "summarizer",
        cliModel: input.cliModel,
        specModel: input.summarizer.model,
        frontmatterModel: input.summarizer.frontmatterModel,
        routingConfig: input.routingConfig,
      }),
    );
  }
  if (input.scout) {
    stepRoutes.push(
      resolveStepRoute({
        stepKey: "scout",
        role: "scout",
        cliModel: input.scout.model ?? input.cliModel,
        frontmatterModel:
          input.scout.frontmatterModel ?? input.scout.defaultModel,
        routingConfig: input.routingConfig,
      }),
    );
  }
  if (input.consolidate) {
    stepRoutes.push(
      resolveStepRoute({
        stepKey: "consolidate",
        role: "other",
        cliModel: input.consolidate.model ?? input.cliModel,
        frontmatterModel:
          input.consolidate.frontmatterModel ?? input.consolidate.defaultModel,
        routingConfig: input.routingConfig,
      }),
    );
  }
  return createResolvedRoutePlan(stepRoutes);
}

export function spawnModelForClaudeCli(
  route: ResolvedModelRoute,
  executionModel: string,
): string {
  const gateway = route.gateway ?? "direct";
  if (gateway !== "direct") {
    return route.modelSnapshot;
  }
  if (isModelAlias(executionModel)) {
    return executionModel;
  }
  try {
    const parsed = parseLogicalIdentity(executionModel);
    const alias = reverseAliasForCanonical(
      `${parsed.provider}/${parsed.model}`,
    );
    if (alias !== undefined) {
      return alias;
    }
  } catch {
    // executionModel is not a catalog alias or slash-grammar identity.
  }
  return route.modelSnapshot;
}
