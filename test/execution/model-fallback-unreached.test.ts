// S4: "record which model actually ran". A model of a step's list that never
// reached its provider (it failed before any attempt, or its spend bucket was
// fenced) is not the model that ran, and the step keeps the cause, detail and
// attempts of the model that did. runWithFallback is driven directly here
// with a scripted `runOn`, so the shapes are exactly the harness's.
import { describe, expect, test } from "bun:test";
import type { ResolvedModelRoute } from "../../src/execution/contracts";
import { ranRoute, runWithFallback } from "../../src/execution/model-fallback";
import type { StepResult, StepSpec } from "../../src/review/step-runner";
import { zeroUsage } from "../../src/usage";

function route(modelSnapshot: string): ResolvedModelRoute {
  return {
    backend: "claude-code",
    provider: "anthropic",
    modelFamily: "claude",
    modelSnapshot,
  };
}

const SONNET = route("sonnet");
const OPUS = route("opus");
const HAIKU = route("haiku");

function step(fallbackRoutes: ResolvedModelRoute[]): StepSpec {
  return {
    name: "hunter-logic",
    systemPromptPath: "/s.md",
    prompt: "review",
    tools: ["Read"],
    mcpConfigPath: "/mcp.json",
    model: "sonnet",
    effort: "high",
    cwd: "/w",
    outPath: "/w/steps/hunter-logic.draft.json",
    timeoutMs: 1000,
    maxAttempts: 1,
    parse: (text: string) => JSON.parse(text),
    route: SONNET,
    fallbackRoutes,
  };
}

function rateLimited(): StepResult {
  return {
    name: "hunter-logic",
    status: "failed",
    usage: { ...zeroUsage(), wall_ms: 5 },
    attempts: 1,
    failureCause: "rate_limit",
    finalCause: "rate_limit",
    failureDetail: "429 from the provider",
    stderrTail: "provider error: rate_limit",
    resultText: "",
  };
}

// The shape `runOnBinding` returns when a model fails before any attempt
// (no binding, a denied workspace, a capability probe).
function neverStarted(): StepResult {
  return {
    name: "hunter-logic",
    status: "failed",
    usage: zeroUsage(),
    attempts: 0,
    stderrTail: "No admitted binding for step route",
    resultText: "",
  };
}

describe("a model that never reached its provider", () => {
  test("is not the model that ran, and the step keeps the cause of the one that did", async () => {
    const sent: string[] = [];
    const result = await runWithFallback({
      step: step([OPUS, HAIKU]),
      runOn: async (single) => {
        sent.push(single.route?.modelSnapshot ?? "");
        return single.route?.modelSnapshot === "sonnet"
          ? rateLimited()
          : neverStarted();
      },
      credentialOf: () => "claude",
      cancelled: () => false,
    });
    // It stops there: what kept it from starting is not the provider's.
    expect(sent).toEqual(["sonnet", "opus"]);
    expect(
      result.modelAttempts?.map((a) => [
        a.route.modelSnapshot,
        a.status,
        a.attempts,
        a.cause,
      ]),
    ).toEqual([
      ["sonnet", "failed", 1, "rate_limit"],
      ["opus", "skipped", 0, undefined],
    ]);
    expect(ranRoute(result)).toEqual(SONNET);
    expect(result.status).toBe("failed");
    expect(result.failureCause).toBe("rate_limit");
    expect(result.finalCause).toBe("rate_limit");
    expect(result.failureDetail).toBe("429 from the provider");
    expect(result.attempts).toBe(1);
    expect(result.stderrTail).toContain("provider error: rate_limit");
    expect(result.stderrTail).toContain("No admitted binding for step route");
  });

  test("a first model that never started leaves no model that ran", async () => {
    const result = await runWithFallback({
      step: step([OPUS]),
      runOn: async () => neverStarted(),
      credentialOf: () => "claude",
      cancelled: () => false,
    });
    expect(result.modelAttempts?.map((a) => a.status)).toEqual(["skipped"]);
    expect(ranRoute(result)).toBeUndefined();
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(result.stderrTail).toBe("No admitted binding for step route");
  });
});
