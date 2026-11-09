import { describe, expect, test } from "bun:test";
import {
  buildResolvedRoutePlan,
  computeRouteFingerprint,
  createResolvedRoutePlan,
  resolveStepRoute,
} from "#model/routing";
import { resolveRoutePlanAtConfirm } from "../src/cli";
import {
  DefaultTransportRegistry,
  OpenCodeProductionGatedError,
  RouteAdmissionError,
} from "../src/transport-registry";

describe("resolveRoutePlanAtConfirm", () => {
  const sonnetPlan = createResolvedRoutePlan([
    resolveStepRoute({
      stepKey: "hunter-reliability",
      role: "hunter",
      cliModel: "sonnet",
    }),
  ]);

  test("returns undefined when build fails and routing is not configured", async () => {
    const result = await resolveRoutePlanAtConfirm({
      modelsConfigured: false,
      buildRoutePlan: async () => {
        throw new Error("unmapped model");
      },
    });
    expect(result).toBeUndefined();
  });

  test("rethrows build failures when models are configured", async () => {
    await expect(
      resolveRoutePlanAtConfirm({
        modelsConfigured: true,
        buildRoutePlan: async () => {
          throw new Error("unmapped model");
        },
      }),
    ).rejects.toThrow("unmapped model");
  });

  test("rethrows admission failures even when models are not configured", async () => {
    const opencodePlan = createResolvedRoutePlan([
      resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opencode:openai/gpt-4o",
      }),
    ]);

    await expect(
      resolveRoutePlanAtConfirm({
        modelsConfigured: false,
        buildRoutePlan: async () => opencodePlan,
        registry: new DefaultTransportRegistry(),
      }),
    ).rejects.toThrow(OpenCodeProductionGatedError);
  });

  test("rethrows unregistered backend admission failures without models", async () => {
    // `codex` is no backend a model name can say: the route is built by hand.
    const route = {
      backend: "codex" as const,
      provider: "openai",
      modelFamily: "gpt-4o",
      modelSnapshot: "gpt-4o",
    };
    const codexPlan = createResolvedRoutePlan([
      {
        stepKey: "hunter-reliability",
        role: "hunter",
        logicalIdentity: "codex:openai/gpt-4o",
        route: route as unknown as Parameters<
          typeof computeRouteFingerprint
        >[1],
        routeFingerprint: computeRouteFingerprint(
          "codex:openai/gpt-4o",
          route as unknown as Parameters<typeof computeRouteFingerprint>[1],
        ),
      },
    ]);

    await expect(
      resolveRoutePlanAtConfirm({
        modelsConfigured: false,
        buildRoutePlan: async () => codexPlan,
        registry: new DefaultTransportRegistry(),
      }),
    ).rejects.toThrow(RouteAdmissionError);
  });

  // A model written in the new form is the operator's words, never a legacy
  // id to pass through: `--model claude:sonnet` must stop with the hint.
  test("rethrows an invalid new-form model even when models are not configured", async () => {
    await expect(
      resolveRoutePlanAtConfirm({
        modelsConfigured: false,
        buildRoutePlan: async () =>
          buildResolvedRoutePlan({
            agents: [{ key: "reliability", role: "hunter" }],
            cliModel: "claude:sonnet",
          }),
        registry: new DefaultTransportRegistry({ mode: "conformance" }),
      }),
    ).rejects.toThrow(
      '--model: "claude:sonnet" is not a model name: write "claude:sonnet-latest"',
    );
  });

  test("a legacy raw id still falls back to the no-plan path", async () => {
    const result = await resolveRoutePlanAtConfirm({
      modelsConfigured: false,
      buildRoutePlan: async () =>
        buildResolvedRoutePlan({
          agents: [{ key: "reliability", role: "hunter" }],
          cliModel: "claude-opus-4-5",
        }),
      registry: new DefaultTransportRegistry({ mode: "conformance" }),
    });
    expect(result).toBeUndefined();
  });

  test("returns the plan when build and admission succeed", async () => {
    const result = await resolveRoutePlanAtConfirm({
      modelsConfigured: false,
      buildRoutePlan: async () => sonnetPlan,
      registry: new DefaultTransportRegistry({ mode: "conformance" }),
    });
    expect(result).toBe(sonnetPlan);
  });
});
