// odd/tasks/openai-profile.md S2, S4, S5, S9: the `openai` profile, Juanma's
// approved table ("Asi si"), as one more lego piece next to `claude`.
import { describe, expect, test } from "bun:test";
import { MODEL_PROFILES, profileRoute, resolveProfile } from "#model/profiles";
import {
  MATERIALITY_STEP_KEY,
  planRoutes,
  type ResolvedRoutePlan,
} from "#model/routing";
import type { CliOptions } from "#review/preflight";
import {
  buildCliRoutePlan,
  claudeAuthorityRequired,
  pipelineConsolidateInput,
  pipelineScoutInput,
  pipelineSummarizerInput,
} from "#review/route-preflight";
import { defaultReviewSpec } from "#review/spec";
import { captureBaseline } from "../review/model-profiles-harness";

const OPENAI = resolveProfile("openai");

async function openaiPlan(
  overrides: Partial<Parameters<typeof buildCliRoutePlan>[0]> = {},
): Promise<ResolvedRoutePlan> {
  return buildCliRoutePlan({
    spec: defaultReviewSpec(),
    options: { scout: true } as CliOptions,
    agentFiles: new Map(),
    bundledAgents: true,
    models: undefined,
    summary: { enabled: true },
    materialityEnabled: true,
    profile: OPENAI,
    ...overrides,
  });
}

describe("the openai profile (S2)", () => {
  test("is registered beside claude", () => {
    expect(Object.keys(MODEL_PROFILES).sort()).toEqual(["claude", "openai"]);
    expect(OPENAI.id).toBe("openai");
  });

  test("holds the approved table", () => {
    const pick = (role: string) => {
      const route = profileRoute(OPENAI, role);
      return [route.model, route.effort];
    };
    expect(pick("hunter")).toEqual(["opencode:openai/gpt-6.1-terra", "xhigh"]);
    expect(pick("hunter.logic")).toEqual([
      "opencode:openai/gpt-6.1-terra",
      "xhigh",
    ]);
    expect(pick("refuter")).toEqual(["opencode:openai/gpt-6.1-sol", "high"]);
    expect(pick("consolidate")).toEqual([
      "opencode:openai/gpt-6.1-terra",
      "high",
    ]);
    expect(pick("scout")).toEqual(["opencode:openai/gpt-6.1-terra", undefined]);
    expect(pick("judge")).toEqual(["opencode:openai/gpt-6.1-terra", undefined]);
    expect(pick("summary")).toEqual(["opencode:openai/gpt-6-luna", undefined]);
  });

  test("ships no prompt set of its own yet", () => {
    expect(OPENAI.promptSet).toBeUndefined();
  });
});

describe("a zero-config openai plan (S4, S5, S9)", () => {
  test("every step runs on OpenAI through OpenCode, with no Claude fallback", async () => {
    const plan = await openaiPlan();
    for (const step of planRoutes(plan)) {
      expect({ step: step.stepKey, backend: step.route.backend }).toEqual({
        step: step.stepKey,
        backend: "opencode",
      });
      expect(step.route.provider).toBe("openai");
    }
    expect(plan.steps.every((s) => s.fallbacks === undefined)).toBe(true);
    expect(claudeAuthorityRequired(plan)).toBe(false);
  });

  test("the profile's effort becomes the OpenCode variant, and no effort sends none", async () => {
    const plan = await openaiPlan();
    const byKey = new Map(plan.steps.map((s) => [s.stepKey, s.route]));
    for (const step of plan.steps) {
      if (step.role === "hunter") {
        expect(step.route.modelSnapshot).toBe("gpt-6.1-terra");
        expect(step.route.modelVariant).toBe("xhigh");
      }
      if (step.role === "refuter") {
        expect(step.route.modelSnapshot).toBe("gpt-6.1-sol");
        expect(step.route.modelVariant).toBe("high");
      }
    }
    expect(byKey.get("consolidate")).toMatchObject({
      modelSnapshot: "gpt-6.1-terra",
      modelVariant: "high",
    });
    expect(byKey.get("scout")?.modelSnapshot).toBe("gpt-6.1-terra");
    expect(byKey.get("scout")?.modelVariant).toBeUndefined();
    expect(byKey.get("summarizer")?.modelSnapshot).toBe("gpt-6-luna");
    expect(byKey.get("summarizer")?.modelVariant).toBeUndefined();
  });

  test("the judge stands down: nothing was measured on terra", async () => {
    const plan = await openaiPlan();
    expect(plan.steps.map((s) => s.stepKey)).not.toContain(
      MATERIALITY_STEP_KEY,
    );
  });

  test("a models override on another model does not inherit the profile's effort", async () => {
    const plan = await openaiPlan({
      models: { "hunter.reliability": ["opencode:openai/gpt-6-luna"] },
    });
    const overridden = plan.steps.filter(
      (s) => s.role === "hunter" && s.route.modelSnapshot === "gpt-6-luna",
    );
    expect(overridden).toHaveLength(1);
    expect(overridden[0]?.route.modelVariant).toBeUndefined();
    expect(overridden[0]?.effort).toBeUndefined();
  });

  test("an explicit Claude judge in models still joins, and then needs Claude", async () => {
    const plan = await openaiPlan({
      models: { judge: ["claude:sonnet-latest"] },
    });
    const judge = plan.steps.find((s) => s.stepKey === MATERIALITY_STEP_KEY);
    expect(judge?.route.backend).toBe("claude-code");
    expect(claudeAuthorityRequired(plan)).toBe(true);
  });
});

describe("a pipeline run on the openai profile (S5)", () => {
  test("spawns every step on OpenAI through OpenCode and none on Claude", async () => {
    const prompts = { profile: OPENAI };
    const baseline = await captureBaseline(
      { name: "openai", opencode: true },
      {
        bundledAgents: true,
        modelProfile: OPENAI,
        ...pipelineSummarizerInput({ enabled: true }, prompts),
        ...pipelineScoutInput({ scout: true }, prompts),
        ...pipelineConsolidateInput(prompts),
      },
    );
    expect(baseline.steps.length).toBeGreaterThan(0);
    for (const step of baseline.steps) {
      expect({ step: step.name, backend: step.backend }).toEqual({
        step: step.name,
        backend: "opencode",
      });
      expect(step.provider).toBe("openai");
      expect(step.cliModel).toBeNull();
    }
    for (const step of baseline.plan?.steps ?? []) {
      expect(step.route.backend).toBe("opencode");
    }
  });
});
