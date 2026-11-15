// odd/tasks/antigravity-oauth.md T4 (E4): the default registry runs agy: models
// on AgyCliTransport, and a plan that never names one pays nothing for it.
import { describe, expect, test } from "bun:test";
import {
  createResolvedRoutePlan,
  resolveStepRoute,
} from "../src/model/routing";
import {
  admitRoutePlan,
  createDefaultTransportRegistry,
} from "../src/transport-registry";
import { AgyCliTransport } from "../src/transports/agy-cli";
import { ClaudeCodeCliTransport } from "../src/transports/claude-code-cli";

function planOf(model: string) {
  return createResolvedRoutePlan([
    resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      modelRole: "hunter.logic",
      models: { "hunter.logic": [model] },
    }),
  ]);
}

describe("the antigravity backend in the default registry", () => {
  test("is registered and builds the agy transport", () => {
    const registry = createDefaultTransportRegistry();
    expect(registry.has("antigravity")).toBe(true);
    expect(registry.get("antigravity")).toBeInstanceOf(AgyCliTransport);
  });

  test("carries the authority's agy path, never a second lookup", () => {
    const registry = createDefaultTransportRegistry({
      antigravityBinaryPath: "/opt/agy/agy",
    });
    const transport = registry.get("antigravity") as AgyCliTransport;
    expect(transport.configuredBinaryPath).toBe("/opt/agy/agy");
    expect(
      (createDefaultTransportRegistry().get("antigravity") as AgyCliTransport)
        .configuredBinaryPath,
    ).toBeUndefined();
  });

  test("admits an agy route through the capability gate", async () => {
    const admitted = await admitRoutePlan(
      planOf("agy:gemini-4-argon-high"),
      createDefaultTransportRegistry(),
    );
    expect(admitted.reports.get("antigravity")?.backend).toBe("antigravity");
  });

  test("the route's model is the bare agy id", () => {
    const step = planOf("agy:gemini-4-argon-high").steps[0];
    expect(step?.route).toMatchObject({
      backend: "antigravity",
      provider: "google",
      modelSnapshot: "gemini-4-argon-high",
    });
  });

  test("its capability report is static and never blocking", async () => {
    const registry = createDefaultTransportRegistry({ mode: "conformance" });
    const agy = await registry.getCapabilityReport("antigravity", {
      mode: "conformance",
    });
    expect(agy.backend).toBe("antigravity");
    expect(agy.issues.every((issue) => !issue.blocking)).toBe(true);
    expect(registry.get("claude-code")).toBeInstanceOf(ClaudeCodeCliTransport);
  });
});
