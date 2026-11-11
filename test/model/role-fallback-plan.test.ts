// odd/tasks/role-model-routing.md S4 (E-d): a role's list is tried in order.
// The plan keeps the first model as the step's route, as before, and carries
// the rest as the step's fallbacks, so every candidate can be admitted and
// bound before anything spends.
import { describe, expect, test } from "bun:test";
import {
  buildResolvedRoutePlan,
  planRoutes,
  type ResolvedRoutePlan,
} from "#model/routing";

const AGENTS = [
  { key: "reliability", role: "hunter" },
  { key: "logic", role: "hunter" },
  { key: "refuter", role: "refuter" },
];

const FRONTMATTER: Record<string, string> = {
  reliability: "sonnet",
  logic: "sonnet",
  refuter: "opus",
};

function plan(
  over: Partial<Parameters<typeof buildResolvedRoutePlan>[0]> = {},
): ResolvedRoutePlan {
  return buildResolvedRoutePlan({
    agents: AGENTS,
    frontmatterModel: (key) => FRONTMATTER[key],
    summarizer: { frontmatterModel: "haiku" },
    ...over,
  });
}

function step(p: ResolvedRoutePlan, stepKey: string) {
  const found = p.steps.find((s) => s.stepKey === stepKey);
  if (found === undefined) throw new Error(`no step ${stepKey}`);
  return found;
}

describe("a role listing several models", () => {
  test("runs the first and carries the rest, in order, as its fallbacks", () => {
    const p = plan({
      models: {
        "hunter.logic": [
          "claude:sonnet-latest",
          "opencode:openai/gpt-5",
          "claude:opus-latest",
        ],
      },
    });
    const logic = step(p, "hunter-logic");
    expect(logic.logicalIdentity).toBe("claude:sonnet-latest");
    expect(logic.route.modelSnapshot).toBe("sonnet");
    expect(logic.fallbacks?.map((f) => f.logicalIdentity)).toEqual([
      "opencode:openai/gpt-5",
      "claude:opus-latest",
    ]);
    // A candidate is a route of the same step: same key, same role.
    for (const candidate of logic.fallbacks ?? []) {
      expect(candidate.stepKey).toBe("hunter-logic");
      expect(candidate.role).toBe("hunter");
    }
    expect(logic.fallbacks?.[0]?.route).toEqual({
      backend: "opencode",
      provider: "openai",
      modelFamily: "gpt-5",
      modelSnapshot: "gpt-5",
    });
    // Another hunter keeps its own (absent) list.
    expect(step(p, "hunter-reliability").fallbacks).toBeUndefined();
  });

  test("models.default lends its fallbacks to every role it covers", () => {
    const p = plan({
      models: { default: ["claude:sonnet-latest", "claude:opus-latest"] },
    });
    for (const key of ["hunter-reliability", "hunter-logic", "refuter"]) {
      expect(step(p, key).fallbacks?.map((f) => f.logicalIdentity)).toEqual([
        "claude:opus-latest",
      ]);
    }
  });

  test("planRoutes lists every step, then each step's fallbacks", () => {
    const p = plan({
      models: {
        "hunter.logic": ["claude:sonnet-latest", "claude:opus-latest"],
      },
    });
    const routes = planRoutes(p);
    expect(routes.map((r) => `${r.stepKey}=${r.logicalIdentity}`)).toEqual([
      ...p.steps.map((s) => `${s.stepKey}=${s.logicalIdentity}`),
      "hunter-logic=claude:opus-latest",
    ]);
  });

  test("the plan fingerprint changes with the fallbacks", () => {
    const one = plan({
      models: { "hunter.logic": ["claude:sonnet-latest"] },
    });
    const two = plan({
      models: {
        "hunter.logic": ["claude:sonnet-latest", "claude:opus-latest"],
      },
    });
    expect(two.routeFingerprint).not.toBe(one.routeFingerprint);
  });
});

describe("a list of one, and the paths that never had a list", () => {
  test("a list of one builds the plan a zero-config run builds", () => {
    const zero = plan();
    const listed = plan({
      models: { "hunter.logic": ["claude:sonnet-latest"] },
    });
    expect(listed.routeFingerprint).toBe(zero.routeFingerprint);
    expect(listed.steps).toEqual(zero.steps);
    for (const s of listed.steps) expect("fallbacks" in s).toBe(false);
    expect(planRoutes(zero)).toEqual(zero.steps);
  });

  test("--model names one model, so it has no fallbacks", () => {
    const p = plan({
      cliModel: "opus",
      models: {
        "hunter.logic": ["claude:sonnet-latest", "claude:opus-latest"],
      },
    });
    for (const s of p.steps) expect(s.fallbacks).toBeUndefined();
  });

  test("the judge keeps its one measured model (L6 item 5)", () => {
    const p = plan({
      materiality: true,
      models: { judge: ["claude:sonnet-latest", "claude:opus-latest"] },
    });
    const judge = step(p, "materiality");
    expect(judge.logicalIdentity).toBe("claude:sonnet-latest");
    expect(judge.fallbacks).toBeUndefined();
  });
});
