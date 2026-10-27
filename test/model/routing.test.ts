import { describe, expect, test } from "bun:test";
import { aliasCanonical, lookupAlias } from "#model/catalog";
import {
  AmbiguousMappingError,
  buildResolvedRoutePlan,
  computeRouteFingerprint,
  createResolvedRoutePlan,
  freezeRoutePlan,
  ModelRoutingError,
  parseLogicalIdentity,
  type ResolvedModelRoute,
  type ResolvedRoutePlan,
  type ResolvedStepRoute,
  type RoutingConfig,
  resolveLogicalModel,
  resolveModelRoute,
  resolveStepRoute,
  spawnModelForClaudeCli,
  UnauthorizedRouteError,
  UnmappedRouteError,
} from "#model/routing";
import { ReviewSpecValidationError, validateReviewSpec } from "#review/spec";

describe("Task 1.1: Model Routing - parseLogicalIdentity", () => {
  test("parses explicit aliases: sonnet, opus, haiku", () => {
    const sonnet = parseLogicalIdentity("sonnet");
    expect(sonnet.canonical).toBe(aliasCanonical("sonnet"));
    expect(sonnet.provider).toBe(lookupAlias("sonnet").provider);
    expect(sonnet.model).toBe("sonnet");
    expect(sonnet.alias).toBe("sonnet");
    expect(sonnet.variant).toBeUndefined();

    const opus = parseLogicalIdentity("opus");
    expect(opus.canonical).toBe(aliasCanonical("opus"));
    expect(opus.provider).toBe(lookupAlias("opus").provider);
    expect(opus.model).toBe("opus");
    expect(opus.alias).toBe("opus");
    expect(opus.variant).toBeUndefined();

    const haiku = parseLogicalIdentity("haiku");
    expect(haiku.canonical).toBe(aliasCanonical("haiku"));
    expect(haiku.provider).toBe(lookupAlias("haiku").provider);
    expect(haiku.model).toBe("haiku");
    expect(haiku.alias).toBe("haiku");
    expect(haiku.variant).toBeUndefined();
  });

  test("parses slash grammar provider/model and provider/model#variant", () => {
    const gpt = parseLogicalIdentity("openai/gpt-4o");
    expect(gpt.canonical).toBe("openai/gpt-4o");
    expect(gpt.provider).toBe("openai");
    expect(gpt.model).toBe("gpt-4o");
    expect(gpt.variant).toBeUndefined();
    expect(gpt.alias).toBeUndefined();

    const o3 = parseLogicalIdentity("openai/o3-mini#high");
    expect(o3.canonical).toBe("openai/o3-mini#high");
    expect(o3.provider).toBe("openai");
    expect(o3.model).toBe("o3-mini");
    expect(o3.variant).toBe("high");
    expect(o3.alias).toBeUndefined();

    const openrouterClaude = parseLogicalIdentity(
      "anthropic/claude-3.7-sonnet#thinking",
    );
    expect(openrouterClaude.canonical).toBe(
      "anthropic/claude-3.7-sonnet#thinking",
    );
    expect(openrouterClaude.provider).toBe("anthropic");
    expect(openrouterClaude.model).toBe("claude-3.7-sonnet");
    expect(openrouterClaude.variant).toBe("thinking");
  });

  test("trims whitespace from input", () => {
    const sonnet = parseLogicalIdentity("  sonnet  ");
    expect(sonnet.canonical).toBe(aliasCanonical("sonnet"));

    const slash = parseLogicalIdentity("  openai/gpt-4o#fast  ");
    expect(slash.canonical).toBe("openai/gpt-4o#fast");
    expect(slash.variant).toBe("fast");
  });

  test("rejects bare unknown strings without slash", () => {
    expect(() => parseLogicalIdentity("gpt-4o")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("gemini-2.5-pro")).toThrow(/bare/i);
    expect(() => parseLogicalIdentity("llama3")).toThrow(ModelRoutingError);
  });

  test("rejects non-string, empty, blank, or invalid slash strings", () => {
    // @ts-expect-error test non-string input
    expect(() => parseLogicalIdentity(123)).toThrow(ModelRoutingError);
    // @ts-expect-error test null input
    expect(() => parseLogicalIdentity(null)).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("   ")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("openai/")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("/gpt-4o")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("openai//gpt-4o")).toThrow(
      ModelRoutingError,
    );
    expect(() => parseLogicalIdentity("openai/gpt-4o#")).toThrow(
      ModelRoutingError,
    );
  });
});

describe("Task 1.1: Model Precedence (CLI > AgentSpec > frontmatter)", () => {
  test("CLI model overrides AgentSpec and frontmatter", () => {
    const resolved = resolveLogicalModel(
      "openai/gpt-4o",
      "opus",
      "haiku",
      "reliability",
    );
    expect(resolved).toBe("openai/gpt-4o");
  });

  test("AgentSpec model overrides frontmatter when CLI is unset", () => {
    const resolved = resolveLogicalModel(
      undefined,
      "opus",
      "haiku",
      "reliability",
    );
    expect(resolved).toBe("opus");
  });

  test("frontmatter model is used when CLI and AgentSpec are unset", () => {
    const resolved = resolveLogicalModel(
      undefined,
      undefined,
      "haiku",
      "reliability",
    );
    expect(resolved).toBe("haiku");
  });

  test("throws when no model is available anywhere", () => {
    expect(() =>
      resolveLogicalModel(undefined, undefined, undefined, "reliability"),
    ).toThrow(/reliability/);
  });
});

describe("Task 1.1: ReviewSpec validation - models[] rejection & model validation", () => {
  test("rejects agents with models property (including empty array [])", () => {
    expect(() =>
      validateReviewSpec({
        agents: [
          {
            key: "reliability",
            file: "deep-review-reliability.md",
            role: "hunter",
            models: [],
          },
          { key: "refuter", file: "review-refuter.md", role: "refuter" },
        ],
      }),
    ).toThrow(
      /agents\[0\]\.models is not supported in D2; fan-out is a D3 capability/,
    );

    expect(() =>
      validateReviewSpec({
        agents: [
          {
            key: "reliability",
            file: "deep-review-reliability.md",
            role: "hunter",
            models: ["sonnet", "opus"],
          },
          { key: "refuter", file: "review-refuter.md", role: "refuter" },
        ],
      }),
    ).toThrow(
      /agents\[0\]\.models is not supported in D2; fan-out is a D3 capability/,
    );
  });

  test("validates agent.model against aliases and slash grammar", () => {
    // Valid alias
    const validAlias = validateReviewSpec({
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          model: "sonnet",
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    expect(validAlias.agents[0].model).toBe("sonnet");

    // Valid slash grammar
    const validSlash = validateReviewSpec({
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          model: "openai/gpt-4o#high",
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    expect(validSlash.agents[0].model).toBe("openai/gpt-4o#high");

    // Invalid model throws ReviewSpecValidationError
    expect(() =>
      validateReviewSpec({
        agents: [
          {
            key: "reliability",
            file: "deep-review-reliability.md",
            role: "hunter",
            model: "unknown-bare-model",
          },
          { key: "refuter", file: "review-refuter.md", role: "refuter" },
        ],
      }),
    ).toThrow(ReviewSpecValidationError);
  });
});

describe("Task 1.1: resolveModelRoute - Gateways, Mappings, Errors", () => {
  test("unmapped alias without config resolves to default direct claude-code", () => {
    const sonnetRoute = resolveModelRoute("sonnet");
    expect(sonnetRoute).toEqual({
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: "sonnet",
      modelSnapshot: "sonnet",
    });

    const opusRoute = resolveModelRoute("opus");
    expect(opusRoute).toEqual({
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: "opus",
      modelSnapshot: "opus",
    });

    const haikuRoute = resolveModelRoute("haiku");
    expect(haikuRoute).toEqual({
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: "haiku",
      modelSnapshot: "haiku",
    });
  });

  test("exact configured|direct|openrouter gateways from config mappings", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: aliasCanonical("sonnet"),
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "sonnet",
          modelSnapshot: "claude-sonnet-5-20250219",
        },
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o-2024-08-06",
        },
        {
          logical: "deepseek/deepseek-r1",
          backend: "opencode",
          provider: "deepseek",
          gateway: "openrouter",
          modelFamily: "deepseek-r1",
          modelSnapshot: "deepseek/deepseek-r1",
        },
      ],
    };

    const direct = resolveModelRoute("sonnet", config);
    expect(direct.gateway).toBe("direct");
    expect(direct.backend).toBe("claude-code");

    const configured = resolveModelRoute("openai/gpt-4o", config);
    expect(configured.gateway).toBe("configured");
    expect(configured.backend).toBe("opencode");
    expect(configured.provider).toBe("openai");

    const openrouter = resolveModelRoute("deepseek/deepseek-r1", config);
    expect(openrouter.gateway).toBe("openrouter");
    expect(openrouter.backend).toBe("opencode");
  });

  test("preserves variant in resolved route", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: "openai/o3-mini#high",
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "o3-mini",
          modelSnapshot: "o3-mini-2025-01-31",
          modelVariant: "high",
        },
      ],
    };

    const route = resolveModelRoute("openai/o3-mini#high", config);
    expect(route.modelVariant).toBe("high");
  });

  test("unmapped non-alias without default throws UnmappedRouteError", () => {
    expect(() => resolveModelRoute("openai/gpt-4o")).toThrow(
      UnmappedRouteError,
    );
    expect(() => resolveModelRoute("openai/gpt-4o", { mappings: [] })).toThrow(
      UnmappedRouteError,
    );
    expect(() =>
      resolveModelRoute(aliasCanonical("sonnet"), { mappings: [] }),
    ).toThrow(UnmappedRouteError);
  });

  test("unmapped non-alias with default resolves to default mapping", () => {
    const config: RoutingConfig = {
      default: {
        backend: "opencode",
        provider: "openrouter",
        gateway: "openrouter",
        modelFamily: "auto",
        modelSnapshot: "auto",
      },
    };

    const route = resolveModelRoute("google/gemini-2.5-flash", config);
    expect(route.backend).toBe("opencode");
    expect(route.provider).toBe("openrouter");
    expect(route.gateway).toBe("openrouter");
  });

  test("duplicate mapping throws AmbiguousMappingError", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o-1",
        },
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
          gateway: "openrouter",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o-2",
        },
      ],
    };

    expect(() => resolveModelRoute("openai/gpt-4o", config)).toThrow(
      AmbiguousMappingError,
    );
  });

  test("disabled spend throws UnauthorizedRouteError", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o",
          disabled: true,
        },
        {
          logical: aliasCanonical("sonnet"),
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "sonnet",
          modelSnapshot: "sonnet",
          allowSpend: false,
        },
      ],
    };

    expect(() => resolveModelRoute("openai/gpt-4o", config)).toThrow(
      UnauthorizedRouteError,
    );
    expect(() => resolveModelRoute("sonnet", config)).toThrow(
      UnauthorizedRouteError,
    );
  });

  test("config.disabled throws UnauthorizedRouteError", () => {
    const config: RoutingConfig = {
      disabled: true,
      mappings: [
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
        },
      ],
    };
    expect(() => resolveModelRoute("openai/gpt-4o", config)).toThrow(
      UnauthorizedRouteError,
    );
  });

  test("resolves route from record mappings object", () => {
    const config: RoutingConfig = {
      mappings: {
        "openai/gpt-4o": {
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o-2024-08-06",
        },
        sonnet: {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "sonnet",
          modelSnapshot: "sonnet",
          disabled: true,
        },
      },
    };

    const route = resolveModelRoute("openai/gpt-4o", config);
    expect(route.backend).toBe("opencode");
    expect(route.provider).toBe("openai");
    expect(route.gateway).toBe("configured");

    expect(() => resolveModelRoute("sonnet", config)).toThrow(
      UnauthorizedRouteError,
    );
  });

  test("record mappings with multiple matching keys (alias + canonical) throws AmbiguousMappingError", () => {
    const config: RoutingConfig = {
      mappings: {
        sonnet: {
          backend: "claude-code",
          provider: "anthropic",
          disabled: true,
        },
        [aliasCanonical("sonnet")]: {
          backend: "claude-code",
          provider: "anthropic",
          disabled: false,
        },
      },
    };

    expect(() => resolveModelRoute("sonnet", config)).toThrow(
      AmbiguousMappingError,
    );
    expect(() => resolveModelRoute(aliasCanonical("sonnet"), config)).toThrow(
      AmbiguousMappingError,
    );
  });

  test("disabled default route throws UnauthorizedRouteError", () => {
    const disabledDef: RoutingConfig = {
      default: {
        backend: "opencode",
        provider: "openrouter",
        disabled: true,
      },
    };
    expect(() =>
      resolveModelRoute("google/gemini-2.5-pro", disabledDef),
    ).toThrow(UnauthorizedRouteError);

    const noSpendDef: RoutingConfig = {
      default: {
        backend: "opencode",
        provider: "openrouter",
        allowSpend: false,
      },
    };
    expect(() =>
      resolveModelRoute("google/gemini-2.5-pro", noSpendDef),
    ).toThrow(UnauthorizedRouteError);
  });
});

describe("Task 1.1: Deterministic Fingerprint, Plan Freeze, Secret-Free Guarantee", () => {
  test("computes deterministic SHA-256 fingerprint over canonical logical + target dimensions", () => {
    const route: ResolvedModelRoute = {
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: "sonnet",
      modelSnapshot: "claude-sonnet-5-20250219",
      modelVariant: "thinking",
    };

    const fp1 = computeRouteFingerprint(
      `${aliasCanonical("sonnet")}#thinking`,
      route,
    );
    const fp2 = computeRouteFingerprint(
      `${aliasCanonical("sonnet")}#thinking`,
      route,
    );
    expect(fp1).toBeString();
    expect(fp1).toHaveLength(64);
    expect(fp1).toBe(fp2);

    // Changing any target dimension changes the fingerprint
    const fpDiff = computeRouteFingerprint(
      `${aliasCanonical("sonnet")}#thinking`,
      {
        ...route,
        gateway: "configured",
      },
    );
    expect(fpDiff).not.toBe(fp1);
  });

  test("fingerprint and error messages never include credentials or secret tokens", () => {
    const secretToken = "sk-ant-api03-abcdef1234567890_super_secret_token";
    const route: ResolvedModelRoute = {
      backend: "opencode",
      provider: "openai",
      gateway: "configured",
      modelFamily: "gpt-4o",
      modelSnapshot: "gpt-4o",
    };

    const fp = computeRouteFingerprint("openai/gpt-4o", route);
    expect(fp).not.toContain(secretToken);
    expect(fp).toHaveLength(64);

    // Errors thrown by model routing redact secrets
    try {
      parseLogicalIdentity(`invalid/${secretToken}`);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(secretToken);
      expect(msg).toContain("[REDACTED]");
    }
  });

  test("freezeRoutePlan recursively freezes whole route plan immutably", () => {
    const stepRoute: ResolvedStepRoute = {
      stepKey: "reliability",
      role: "hunter",
      logicalIdentity: aliasCanonical("sonnet"),
      route: {
        backend: "claude-code",
        provider: "anthropic",
        gateway: "direct",
        modelFamily: "sonnet",
        modelSnapshot: "sonnet",
      },
      routeFingerprint: "a".repeat(64),
    };

    const plan: ResolvedRoutePlan = {
      steps: [stepRoute],
      routeFingerprint: "b".repeat(64),
    };

    const frozen = freezeRoutePlan(plan);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.steps)).toBe(true);
    expect(Object.isFrozen(frozen.steps[0])).toBe(true);
    expect(Object.isFrozen(frozen.steps[0].route)).toBe(true);

    expect(() => {
      // @ts-expect-error test mutating frozen plan
      frozen.steps = [];
    }).toThrow();
  });

  test("resolveStepRoute and createResolvedRoutePlan build end-to-end frozen plan", () => {
    const step = resolveStepRoute({
      stepKey: "reliability",
      role: "hunter",
      cliModel: "sonnet",
    });

    expect(step.stepKey).toBe("reliability");
    expect(step.role).toBe("hunter");
    expect(step.logicalIdentity).toBe(aliasCanonical("sonnet"));
    expect(step.route.backend).toBe("claude-code");
    expect(step.routeFingerprint).toHaveLength(64);

    const plan = createResolvedRoutePlan([step]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.routeFingerprint).toBeString();
  });
});

describe("spawnModelForClaudeCli", () => {
  test("direct gateway passes the logical alias to Claude Code --model", () => {
    expect(
      spawnModelForClaudeCli(
        {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "sonnet",
          modelSnapshot: "sonnet",
        },
        "sonnet",
      ),
    ).toBe("sonnet");
  });

  test("configured gateway passes the operator snapshot to Claude Code --model", () => {
    expect(
      spawnModelForClaudeCli(
        {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "configured",
          modelFamily: "sonnet",
          modelSnapshot: "claude-sonnet-5-20250219",
        },
        "sonnet",
      ),
    ).toBe("claude-sonnet-5-20250219");
  });

  // #175. The reverse lookup is keyed on `provider/alias`, so a VERSIONED
  // slash-grammar identity no longer collapses to a bare alias -- the
  // operator named a version and the CLI is handed that version. Before
  // #175 this returned "sonnet", silently discarding the pin the operator
  // typed; the catalogue's own `claude-sonnet-5` was what made that
  // collapse look like a mapping rather than a loss.
  test("direct gateway keeps an operator's versioned slash-grammar model", () => {
    expect(
      spawnModelForClaudeCli(
        {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "claude-sonnet-5",
          modelSnapshot: "claude-sonnet-5",
        },
        "anthropic/claude-sonnet-5",
      ),
    ).toBe("claude-sonnet-5");
  });

  test("direct gateway maps slash-grammar executionModel back to Claude alias", () => {
    expect(
      spawnModelForClaudeCli(
        {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "sonnet",
          modelSnapshot: "sonnet",
        },
        aliasCanonical("sonnet"),
      ),
    ).toBe("sonnet");
  });
});

// #175 follow-up, 2026-09-02. The regression this suite pins: #175 made a bare
// alias parse to the alias WORD (`parsed.model === "sonnet"`), where it used to
// parse to a pinned family (`claude-sonnet-5`). Every `modelSnapshot ??
// parsed.model` fallback therefore started handing `"sonnet"` to backends that
// do not resolve aliases -- `transport-registry.ts` forwards `modelSnapshot`
// verbatim as the OpenCode SDK's `modelID`, so a working operator config began
// sending a nonsense identifier to a live API. The fix refuses instead of
// fabricating; these tests fail if the refusal is removed from ANY of the three
// fallback sites (array mappings, record mappings, default mapping).
describe("#175 follow-up: alias routes refuse a fabricated modelSnapshot", () => {
  test("array mapping: bare alias on a non-claude-code backend without modelSnapshot throws", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: "sonnet",
          backend: "opencode",
          provider: "anthropic",
        },
      ],
    };

    expect(() => resolveModelRoute("sonnet", config)).toThrow(
      UnmappedRouteError,
    );
    let message = "";
    try {
      resolveModelRoute("sonnet", config);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("sonnet");
    expect(message).toContain("opencode");
    expect(message).toContain("modelSnapshot");
  });

  test("record mapping: bare alias on a non-claude-code backend without modelSnapshot throws", () => {
    const config: RoutingConfig = {
      mappings: {
        opus: {
          backend: "opencode",
          provider: "anthropic",
        },
      },
    };

    expect(() => resolveModelRoute("opus", config)).toThrow(UnmappedRouteError);
    let message = "";
    try {
      resolveModelRoute("opus", config);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("opus");
    expect(message).toContain("opencode");
    expect(message).toContain("modelSnapshot");
  });

  test("default mapping: bare alias falling through to a non-claude-code default without modelSnapshot throws", () => {
    const config: RoutingConfig = {
      default: {
        backend: "opencode",
        provider: "anthropic",
      },
    };

    expect(() => resolveModelRoute("haiku", config)).toThrow(
      UnmappedRouteError,
    );
    let message = "";
    try {
      resolveModelRoute("haiku", config);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("haiku");
    expect(message).toContain("opencode");
    expect(message).toContain("modelSnapshot");
  });

  // The canonical form is the SAME alias identity, and it is the key shape this
  // repo's own configs use (`aliasCanonical("sonnet")`). A guard that only
  // caught the bare word would be bypassed by the recommended key.
  test("canonical alias identity is refused the same way as the bare word", () => {
    const config: RoutingConfig = {
      mappings: {
        [aliasCanonical("sonnet")]: {
          backend: "opencode",
          provider: "anthropic",
        },
      },
    };

    expect(() => resolveModelRoute(aliasCanonical("sonnet"), config)).toThrow(
      UnmappedRouteError,
    );
  });

  test("an explicit modelSnapshot still resolves and is forwarded verbatim, on every branch", () => {
    const arrayRoute = resolveModelRoute("sonnet", {
      mappings: [
        {
          logical: "sonnet",
          backend: "opencode",
          provider: "anthropic",
          modelSnapshot: "claude-sonnet-5-20250219",
        },
      ],
    });
    expect(arrayRoute.modelSnapshot).toBe("claude-sonnet-5-20250219");
    expect(arrayRoute.backend).toBe("opencode");

    const recordRoute = resolveModelRoute("opus", {
      mappings: {
        opus: {
          backend: "opencode",
          provider: "openai",
          modelSnapshot: "gpt-4o",
        },
      },
    });
    expect(recordRoute.modelSnapshot).toBe("gpt-4o");

    const defaultRoute = resolveModelRoute("haiku", {
      default: {
        backend: "opencode",
        provider: "anthropic",
        modelSnapshot: "claude-haiku-4-5-20251001",
      },
    });
    expect(defaultRoute.modelSnapshot).toBe("claude-haiku-4-5-20251001");
  });

  // The whole point of #175: the Claude CLI resolves the alias itself, so the
  // alias word IS the honest snapshot there. Regressing this would re-pin.
  //
  // #176 follow-up, 2026-09-02: the two mapped cases below GAINED an explicit
  // `gateway: "direct"`, and the gain is a correction, not upkeep. As first
  // written they asserted the defect: without a `gateway` the route resolves to
  // `"configured"`, on which `spawnModelForClaudeCli` forwards the snapshot
  // verbatim as `--model` -- so what this test called "still resolves" was the
  // engine shipping the word "sonnet" to an endpoint that cannot resolve it.
  // `direct` is the gateway the sentence above was always describing; saying so
  // is what makes the assertion true. The third case (`resolveModelRoute`
  // with no config at all) is untouched: it never reaches the guard, because
  // the alias-default branch builds `gateway: "direct"` itself.
  test("a bare alias on direct-gateway claude-code still resolves and still carries the alias", () => {
    const mapped = resolveModelRoute("sonnet", {
      mappings: [
        {
          logical: "sonnet",
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
        },
      ],
    });
    expect(mapped.modelSnapshot).toBe("sonnet");
    expect(mapped.backend).toBe("claude-code");

    const viaDefault = resolveModelRoute("opus", {
      default: {
        backend: "claude-code",
        provider: "anthropic",
        gateway: "direct",
      },
    });
    expect(viaDefault.modelSnapshot).toBe("opus");

    const unmapped = resolveModelRoute("haiku");
    expect(unmapped.modelSnapshot).toBe("haiku");
    expect(unmapped.backend).toBe("claude-code");
  });

  test("slash-grammar routes on opencode are untouched: the operator's own words are forwarded", () => {
    const route = resolveModelRoute("zai/glm-4.6", {
      mappings: [
        { logical: "zai/glm-4.6", backend: "opencode", provider: "zai" },
      ],
    });
    expect(route.modelSnapshot).toBe("glm-4.6");
    expect(route.modelFamily).toBe("glm-4.6");

    const viaDefault = resolveModelRoute("zai/glm-4.6", {
      default: { backend: "opencode", provider: "zai" },
    });
    expect(viaDefault.modelSnapshot).toBe("glm-4.6");
  });
});

// #176 follow-up, 2026-09-02. The FIRST guard keyed the refusal on the BACKEND
// (`mapping.backend !== "claude-code"`), and that is the wrong axis. The
// question a bare alias asks is "does the eventual consumer resolve this word
// itself?", and only the GATEWAY answers it: `spawnModelForClaudeCli` forwards
// `modelSnapshot` verbatim as `--model` on ANY non-`direct` gateway, so a
// `claude-code` mapping behind `configured` or `openrouter` sends the literal
// word "sonnet" to an endpoint that never registered pr-hero's aliases -- the
// exact corruption the first guard claimed to close, left open on its
// backend-shaped door.
//
// The omitted-gateway case is the one the first guard actually let through:
// route resolution defaults an absent `gateway` to `"configured"`, so the
// shortest config an operator can write (`{"sonnet": {"backend":
// "claude-code", "provider": "anthropic"}}`) resolved and shipped the alias.
describe("#176 follow-up: the refusal is keyed on the gateway, not the backend", () => {
  test("claude-code with the gateway OMITTED (so `configured`) and no modelSnapshot throws", () => {
    const config: RoutingConfig = {
      mappings: [
        { logical: "sonnet", backend: "claude-code", provider: "anthropic" },
      ],
    };

    expect(() => resolveModelRoute("sonnet", config)).toThrow(
      UnmappedRouteError,
    );
    let message = "";
    try {
      resolveModelRoute("sonnet", config);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("sonnet");
    expect(message).toContain("claude-code");
    expect(message).toContain("configured");
    expect(message).toContain("modelSnapshot");
  });

  test("claude-code with an EXPLICIT `configured` gateway and no modelSnapshot throws", () => {
    const config: RoutingConfig = {
      mappings: {
        opus: {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "configured",
        },
      },
    };

    expect(() => resolveModelRoute("opus", config)).toThrow(UnmappedRouteError);
  });

  test("claude-code behind an `openrouter` gateway and no modelSnapshot throws", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: "sonnet",
          backend: "claude-code",
          provider: "anthropic",
          gateway: "openrouter",
        },
      ],
    };

    expect(() => resolveModelRoute("sonnet", config)).toThrow(
      UnmappedRouteError,
    );
    let message = "";
    try {
      resolveModelRoute("sonnet", config);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("openrouter");
  });

  test("the default mapping is guarded on the same axis: claude-code + omitted gateway throws", () => {
    expect(() =>
      resolveModelRoute("haiku", {
        default: { backend: "claude-code", provider: "anthropic" },
      }),
    ).toThrow(UnmappedRouteError);

    expect(() =>
      resolveModelRoute("haiku", {
        default: {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "openrouter",
        },
      }),
    ).toThrow(UnmappedRouteError);
  });

  // The one shape that genuinely resolves the alias downstream, and therefore
  // the one shape that may keep the bare word: `spawnModelForClaudeCli` only
  // hands the CLI an alias when the gateway is `direct`.
  test("claude-code with an EXPLICIT `direct` gateway still resolves and carries the alias, on every branch", () => {
    const arrayRoute = resolveModelRoute("sonnet", {
      mappings: [
        {
          logical: "sonnet",
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
        },
      ],
    });
    expect(arrayRoute.modelSnapshot).toBe("sonnet");
    expect(arrayRoute.gateway).toBe("direct");

    const recordRoute = resolveModelRoute(aliasCanonical("opus"), {
      mappings: {
        [aliasCanonical("opus")]: {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
        },
      },
    });
    expect(recordRoute.modelSnapshot).toBe("opus");

    const defaultRoute = resolveModelRoute("haiku", {
      default: {
        backend: "claude-code",
        provider: "anthropic",
        gateway: "direct",
      },
    });
    expect(defaultRoute.modelSnapshot).toBe("haiku");
  });

  // The predicate is a CONJUNCTION, and this pins its other half. `direct` on
  // `opencode` is not the Claude CLI: `transport-registry.ts` still forwards
  // `modelSnapshot` as the SDK's `modelID`, and the OpenCode SDK has never
  // heard of pr-hero's aliases whatever the gateway says. A guard narrowed to
  // `gateway === "direct"` alone would reopen #176's original defect.
  test("a `direct` gateway does NOT excuse a non-claude-code backend", () => {
    expect(() =>
      resolveModelRoute("sonnet", {
        mappings: [
          {
            logical: "sonnet",
            backend: "opencode",
            provider: "anthropic",
            gateway: "direct",
          },
        ],
      }),
    ).toThrow(UnmappedRouteError);

    expect(() =>
      resolveModelRoute("opus", {
        default: {
          backend: "opencode",
          provider: "anthropic",
          gateway: "direct",
        },
      }),
    ).toThrow(UnmappedRouteError);
  });

  // #175's whole point, and it never reaches the helper: the alias-default
  // branch builds its own route with `gateway: "direct"`.
  test("a bare alias with NO mapping at all still resolves to the direct claude-code route", () => {
    for (const alias of ["sonnet", "opus", "haiku"] as const) {
      const route = resolveModelRoute(alias);
      expect(route.backend).toBe("claude-code");
      expect(route.gateway).toBe("direct");
      expect(route.modelSnapshot).toBe(alias);
    }
  });

  test("an explicit modelSnapshot is forwarded verbatim even on a non-direct gateway", () => {
    const route = resolveModelRoute("sonnet", {
      mappings: [
        {
          logical: "sonnet",
          backend: "claude-code",
          provider: "anthropic",
          gateway: "openrouter",
          modelSnapshot: "anthropic/claude-sonnet-5",
        },
      ],
    });
    expect(route.modelSnapshot).toBe("anthropic/claude-sonnet-5");
    expect(route.gateway).toBe("openrouter");

    const viaDefault = resolveModelRoute("opus", {
      default: {
        backend: "claude-code",
        provider: "anthropic",
        modelSnapshot: "claude-opus-5-20250219",
      },
    });
    expect(viaDefault.modelSnapshot).toBe("claude-opus-5-20250219");
    expect(viaDefault.gateway).toBe("configured");
  });

  // Slash grammar is not an alias identity, so no gateway makes it refuse.
  test("slash grammar on a claude-code `configured` gateway is still forwarded verbatim", () => {
    const route = resolveModelRoute("anthropic/claude-sonnet-5", {
      mappings: [
        {
          logical: "anthropic/claude-sonnet-5",
          backend: "claude-code",
          provider: "anthropic",
        },
      ],
    });
    expect(route.modelSnapshot).toBe("claude-sonnet-5");
    expect(route.gateway).toBe("configured");
  });
});

describe("buildResolvedRoutePlan: the consolidate step", () => {
  const agents = [{ key: "reliability", role: "hunter", model: "sonnet" }];
  const step = (plan: ResolvedRoutePlan, key: string) =>
    plan.steps.find((s) => s.stepKey === key);

  test("a route is resolved for consolidate when enabled, like the scout", () => {
    const plan = buildResolvedRoutePlan({
      agents,
      scout: { defaultModel: "sonnet" },
      consolidate: { defaultModel: "sonnet" },
    });
    expect(step(plan, "consolidate")?.role).toBe("other");
    expect(step(plan, "consolidate")?.logicalIdentity).toBe(
      step(plan, "scout")?.logicalIdentity,
    );
  });

  test("no consolidate route when the stage is not enabled", () => {
    const plan = buildResolvedRoutePlan({ agents });
    expect(step(plan, "consolidate")).toBeUndefined();
  });

  test("an OpenCode mapping gives consolidate the backend and model the scout gets", () => {
    const routingConfig: RoutingConfig = {
      mappings: [
        {
          logical: "sonnet",
          backend: "opencode",
          provider: "anthropic",
          modelSnapshot: "claude-sonnet-5-20250219",
        },
      ],
    };
    const plan = buildResolvedRoutePlan({
      agents,
      routingConfig,
      scout: { defaultModel: "sonnet" },
      consolidate: { defaultModel: "sonnet" },
    });
    const consolidate = step(plan, "consolidate")?.route;
    expect(consolidate?.backend).toBe("opencode");
    expect(consolidate?.modelSnapshot).toBe("claude-sonnet-5-20250219");
    expect(consolidate).toEqual(step(plan, "scout")?.route);
  });
});
