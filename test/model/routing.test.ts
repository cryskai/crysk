// The route plan's mechanics that survived the move from alias-keyed routing to
// roles (odd/tasks/role-model-routing.md): precedence, fingerprints, freezing,
// the consolidate and judge steps, and spec validation. The role rules
// themselves are in role-routing.test.ts.
import { describe, expect, test } from "bun:test";
import {
  buildResolvedRoutePlan,
  claudeCliModel,
  computeRouteFingerprint,
  createResolvedRoutePlan,
  freezeRoutePlan,
  isMeasuredJudgeRoute,
  judgeModelChoice,
  MATERIALITY_STEP_KEY,
  ModelRoutingError,
  type ResolvedModelRoute,
  type ResolvedRoutePlan,
  type ResolvedStepRoute,
  resolveMaterialityJudgeRoute,
  resolveModelRoute,
  resolveStepModel,
  resolveStepRoute,
} from "#model/routing";
import { ReviewSpecValidationError, validateReviewSpec } from "#review/spec";

describe("precedence: --model > spec > models[role] > models.default > prompt", () => {
  const models = {
    default: ["claude:haiku-latest"],
    "hunter.reliability": ["claude:fable-latest"],
  };
  const base = {
    stepKey: "hunter-reliability",
    role: "hunter",
    modelRole: "hunter.reliability",
    frontmatterModel: "sonnet",
  };

  test("--model beats everything", () => {
    expect(
      resolveStepModel({
        ...base,
        cliModel: "opus",
        specModel: "haiku",
        models,
      }).raw,
    ).toBe("claude:opus-latest");
  });

  test("the spec's model beats models", () => {
    expect(resolveStepModel({ ...base, specModel: "opus", models }).raw).toBe(
      "claude:opus-latest",
    );
  });

  test("models[role] beats models.default", () => {
    expect(resolveStepModel({ ...base, models }).raw).toBe(
      "claude:fable-latest",
    );
  });

  test("models.default beats the prompt", () => {
    expect(
      resolveStepModel({ ...base, modelRole: "hunter.logic", models }).raw,
    ).toBe("claude:haiku-latest");
  });

  test("the prompt's alias is converted at the one conversion point", () => {
    expect(resolveStepModel(base).raw).toBe("claude:sonnet-latest");
  });

  test("throws when no model is available anywhere", () => {
    expect(() =>
      resolveStepModel({ stepKey: "reliability", role: "hunter" }),
    ).toThrow(
      new ModelRoutingError(
        "agent reliability has no model and no override given",
      ),
    );
  });
});

describe("routes", () => {
  test("a -latest name is the CLI alias; a pinned name is its id", () => {
    expect(resolveModelRoute("sonnet")).toEqual({
      backend: "claude-code",
      provider: "anthropic",
      modelFamily: "sonnet",
      modelSnapshot: "sonnet",
    });
    expect(resolveModelRoute("claude:claude-opus-5-5")).toEqual({
      backend: "claude-code",
      provider: "anthropic",
      modelFamily: "claude-opus-5-5",
      modelSnapshot: "claude-opus-5-5",
    });
    expect(claudeCliModel(resolveModelRoute("claude:fable-latest"))).toBe(
      "fable",
    );
  });

  test("an OpenCode name carries provider and model, and no variant", () => {
    expect(resolveModelRoute("opencode:openai/gpt-5")).toEqual({
      backend: "opencode",
      provider: "openai",
      modelFamily: "gpt-5",
      modelSnapshot: "gpt-5",
    });
  });

  test("slash grammar without a backend no longer resolves", () => {
    expect(() => resolveModelRoute("openai/gpt-4o")).toThrow(ModelRoutingError);
  });
});

describe("Deterministic Fingerprint, Plan Freeze, Secret-Free Guarantee", () => {
  test("computes deterministic SHA-256 fingerprint over the model name + route", () => {
    const route: ResolvedModelRoute = {
      backend: "claude-code",
      provider: "anthropic",
      modelFamily: "sonnet",
      modelSnapshot: "sonnet",
    };
    const fp1 = computeRouteFingerprint("claude:sonnet-latest", route);
    const fp2 = computeRouteFingerprint("claude:sonnet-latest", route);
    expect(fp1).toHaveLength(64);
    expect(fp1).toBe(fp2);
    expect(
      computeRouteFingerprint("claude:sonnet-latest", {
        ...route,
        modelVariant: "thinking",
      }),
    ).not.toBe(fp1);
  });

  test("errors never echo a secret pasted as a model", () => {
    const secretToken = "sk-ant-api03-abcdef1234567890_super_secret_token";
    let message = "";
    try {
      resolveModelRoute(`opencode:openai/${secretToken}`);
    } catch (err: unknown) {
      message = (err as Error).message;
    }
    expect(message).toContain("credentials are not permitted");
    expect(message).not.toContain(secretToken);
  });

  test("freezeRoutePlan recursively freezes whole route plan immutably", () => {
    const stepRoute: ResolvedStepRoute = {
      stepKey: "reliability",
      role: "hunter",
      logicalIdentity: "claude:sonnet-latest",
      route: resolveModelRoute("sonnet"),
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
    expect(step.logicalIdentity).toBe("claude:sonnet-latest");
    expect(step.route.backend).toBe("claude-code");
    expect(step.routeFingerprint).toHaveLength(64);
    const plan = createResolvedRoutePlan([step]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.routeFingerprint).toBeString();
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

  test("models.default on OpenCode gives consolidate the backend and model the scout gets", () => {
    const plan = buildResolvedRoutePlan({
      agents,
      models: { default: ["opencode:anthropic/claude-sonnet-5-5"] },
      scout: { defaultModel: "sonnet" },
      consolidate: { defaultModel: "sonnet" },
    });
    const consolidate = step(plan, "consolidate")?.route;
    expect(consolidate?.backend).toBe("opencode");
    expect(consolidate?.modelSnapshot).toBe("claude-sonnet-5-5");
    expect(consolidate).toEqual(step(plan, "scout")?.route);
  });
});

describe("buildResolvedRoutePlan: the materiality judge step", () => {
  const agents = [{ key: "reliability", role: "hunter", model: "sonnet" }];
  const step = (plan: ResolvedRoutePlan, key: string) =>
    plan.steps.find((s) => s.stepKey === key);

  test("a claude-code sonnet route is resolved for the judge when enabled", () => {
    const plan = buildResolvedRoutePlan({
      agents,
      consolidate: { defaultModel: "sonnet" },
      materiality: true,
    });
    const judge = step(plan, MATERIALITY_STEP_KEY);
    expect(judge?.role).toBe("other");
    expect(judge?.route.backend).toBe("claude-code");
    expect(judge?.logicalIdentity).toBe("claude:sonnet-latest");
    expect(isMeasuredJudgeRoute(judge?.route as ResolvedModelRoute)).toBe(true);
  });

  test("--model never moves the judge off sonnet", () => {
    const plan = buildResolvedRoutePlan({
      agents,
      cliModel: "opus",
      consolidate: { defaultModel: "sonnet" },
      materiality: true,
    });
    expect(step(plan, MATERIALITY_STEP_KEY)?.route.modelSnapshot).toBe(
      "sonnet",
    );
    expect(step(plan, "consolidate")?.route.modelSnapshot).toBe("opus");
  });

  test("off: no judge key, and the plan's fingerprint is today's", () => {
    const without = buildResolvedRoutePlan({
      agents,
      consolidate: { defaultModel: "sonnet" },
    });
    expect(step(without, MATERIALITY_STEP_KEY)).toBeUndefined();
    const withJudge = buildResolvedRoutePlan({
      agents,
      consolidate: { defaultModel: "sonnet" },
      materiality: true,
    });
    expect(withJudge.routeFingerprint).not.toBe(without.routeFingerprint);
    expect(
      buildResolvedRoutePlan({
        agents,
        consolidate: { defaultModel: "sonnet" },
      }).routeFingerprint,
    ).toBe(without.routeFingerprint);
  });

  test("a judge with no measured model left stands down and never throws", () => {
    const models = { judge: ["opencode:anthropic/claude-sonnet-5-5"] };
    expect(() =>
      buildResolvedRoutePlan({ agents, models, materiality: true }),
    ).not.toThrow();
    expect(resolveMaterialityJudgeRoute(models)).toBeUndefined();
    expect(judgeModelChoice(models)).toEqual({
      dropped: ["opencode:anthropic/claude-sonnet-5-5"],
    });
  });

  test("only sonnet and opus on the Claude CLI are the measured judge", () => {
    expect(isMeasuredJudgeRoute(resolveModelRoute("opus"))).toBe(true);
    expect(isMeasuredJudgeRoute(resolveModelRoute("haiku"))).toBe(false);
    expect(
      isMeasuredJudgeRoute(resolveModelRoute("claude:claude-sonnet-5-5")),
    ).toBe(false);
    expect(
      isMeasuredJudgeRoute(resolveModelRoute("opencode:anthropic/sonnet")),
    ).toBe(false);
  });
});

describe("ReviewSpec validation - models[] rejection & model validation", () => {
  const withModel = (model: string) => ({
    agents: [
      {
        key: "reliability",
        file: "deep-review-reliability.md",
        role: "hunter",
        model,
      },
      { key: "refuter", file: "review-refuter.md", role: "refuter" },
    ],
  });

  test("rejects agents with models property (including empty array [])", () => {
    for (const models of [[], ["sonnet", "opus"]]) {
      expect(() =>
        validateReviewSpec({
          agents: [
            {
              key: "reliability",
              file: "deep-review-reliability.md",
              role: "hunter",
              models,
            },
            { key: "refuter", file: "review-refuter.md", role: "refuter" },
          ],
        }),
      ).toThrow(
        /agents\[0\]\.models is not supported in D2; fan-out is a D3 capability/,
      );
    }
  });

  test("agent.model is a bare alias or a full model name", () => {
    for (const model of [
      "sonnet",
      "fable",
      "claude:opus-latest",
      "opencode:openai/gpt-4o",
    ]) {
      expect(validateReviewSpec(withModel(model)).agents[0].model).toBe(model);
    }
    for (const model of [
      "unknown-bare-model",
      "openai/gpt-4o",
      "claude:opus",
      "opencode:openai/gpt-4o#high",
    ]) {
      expect(() => validateReviewSpec(withModel(model)), model).toThrow(
        ReviewSpecValidationError,
      );
    }
  });
});
