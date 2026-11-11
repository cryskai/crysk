// odd/tasks/model-profiles.md S1-S3: profiles as data, `claude` as exactly
// today's defaults, and the profile as the last seat of a step's resolution.
import { describe, expect, test } from "bun:test";
import { defaultEffortForRole } from "#model/catalog";
import {
  CLAUDE_PROFILE,
  DEFAULT_PROFILE_ID,
  MODEL_PROFILES,
  type ModelProfile,
  modelProfile,
  profileModelAlias,
  profileRoute,
} from "#model/profiles";
import {
  buildResolvedRoutePlan,
  judgeModelChoice,
  MATERIALITY_JUDGE_MODEL,
  ModelRoutingError,
  resolveStepRoute,
} from "#model/routing";
import { DEFAULT_SCOUT_MODEL } from "#review/pipeline";
import { DEFAULT_SUMMARY_MODEL } from "#review/preflight";

describe("the registry (S1)", () => {
  test("claude is registered and is the default profile", () => {
    expect(DEFAULT_PROFILE_ID).toBe("claude");
    expect(MODEL_PROFILES.claude).toBe(CLAUDE_PROFILE);
    expect(modelProfile("claude")).toBe(CLAUDE_PROFILE);
  });

  test("an unknown profile names the known ones", () => {
    expect(() => modelProfile("nope")).toThrow(/known profiles are claude/);
  });
});

describe("the claude profile is exactly today's defaults (S2)", () => {
  test("every role's model and effort", () => {
    const pick = (role: string) => {
      const route = profileRoute(CLAUDE_PROFILE, role);
      return [route.model, route.effort];
    };
    expect(pick("hunter.logic")).toEqual(["claude:sonnet-latest", "xhigh"]);
    expect(pick("hunter.anything-else")).toEqual([
      "claude:sonnet-latest",
      "xhigh",
    ]);
    expect(pick("refuter")).toEqual(["claude:opus-latest", "high"]);
    expect(pick("consolidate")).toEqual(["claude:sonnet-latest", "high"]);
    expect(pick("scout")).toEqual(["claude:sonnet-latest", "high"]);
    expect(pick("summary")).toEqual(["claude:haiku-latest", "high"]);
    expect(pick("judge")).toEqual(["claude:sonnet-latest", "high"]);
  });

  test("the old constants read the profile and keep their alias values", () => {
    expect(DEFAULT_SCOUT_MODEL).toBe("sonnet");
    expect(DEFAULT_SUMMARY_MODEL).toBe("haiku");
    expect(MATERIALITY_JUDGE_MODEL).toBe("sonnet");
    expect(defaultEffortForRole("hunter")).toBe("xhigh");
    expect(defaultEffortForRole("refuter")).toBe("high");
    expect(defaultEffortForRole("summarizer")).toBe("high");
    expect(defaultEffortForRole("scout")).toBe("high");
    expect(defaultEffortForRole("verifier")).toBe("high");
    expect(defaultEffortForRole("other")).toBe("high");
  });

  test("the judge's default is the profile's, on the measured list", () => {
    expect(judgeModelChoice(undefined)).toEqual({
      model: "claude:sonnet-latest",
      dropped: [],
    });
  });
});

describe("profileRoute and profileModelAlias", () => {
  const partial: ModelProfile = {
    id: "partial",
    roles: { hunter: { model: "opencode:openai/gpt-x", effort: "low" } },
    hunters: { parity: { model: "claude:opus-latest", effort: "max" } },
  };

  test("a role the profile leaves out falls back to claude's", () => {
    expect(profileRoute(partial, "refuter")).toEqual(
      profileRoute(CLAUDE_PROFILE, "refuter"),
    );
  });

  test("a hunter override beats the profile's hunter role", () => {
    expect(profileRoute(partial, "hunter.parity").model).toBe(
      "claude:opus-latest",
    );
    expect(profileRoute(partial, "hunter.logic").model).toBe(
      "opencode:openai/gpt-x",
    );
  });

  test("an unknown role is refused", () => {
    expect(() => profileRoute(CLAUDE_PROFILE, "default")).toThrow(
      /no profile role/,
    );
  });

  test("a claude -latest name becomes its alias; anything else is kept", () => {
    expect(profileModelAlias("claude:sonnet-latest")).toBe("sonnet");
    expect(profileModelAlias("claude:claude-opus-5-5")).toBe(
      "claude:claude-opus-5-5",
    );
    expect(profileModelAlias("opencode:openai/gpt-x")).toBe(
      "opencode:openai/gpt-x",
    );
  });
});

describe("the profile is the last seat (S3)", () => {
  test("the prompt's frontmatter outranks the profile seat", () => {
    const step = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      frontmatterModel: "haiku",
      profileModel: "claude:opus-latest",
    });
    expect(step.logicalIdentity).toBe("claude:haiku-latest");
  });

  test("with no other model, the profile seat decides", () => {
    const step = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      profileModel: "claude:opus-latest",
    });
    expect(step.logicalIdentity).toBe("claude:opus-latest");
    expect(step.route.modelSnapshot).toBe("opus");
  });

  test("a profile model resolves to the same identity as its prompt alias", () => {
    // Why the bundled set can move from frontmatter to the profile without
    // moving a single route fingerprint.
    const viaAlias = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      frontmatterModel: "sonnet",
    });
    const viaProfile = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      profileModel: "claude:sonnet-latest",
    });
    expect(viaProfile).toEqual(viaAlias);
  });

  const agents = [
    { key: "logic", role: "hunter" },
    { key: "refuter", role: "refuter" },
  ];
  const opusEverywhere: ModelProfile = {
    id: "opus-everywhere",
    roles: {
      hunter: { model: "claude:opus-latest", effort: "high" },
      refuter: { model: "claude:opus-latest", effort: "high" },
    },
  };

  test("a bundled set ignores its frontmatter and routes by the profile", () => {
    const plan = buildResolvedRoutePlan({
      agents,
      bundledAgents: true,
      profile: opusEverywhere,
      frontmatterModel: () => "haiku",
    });
    expect(plan.steps.map((s) => s.logicalIdentity)).toEqual([
      "claude:opus-latest",
      "claude:opus-latest",
    ]);
  });

  test("a user set's frontmatter outranks the profile", () => {
    const plan = buildResolvedRoutePlan({
      agents,
      profile: opusEverywhere,
      frontmatterModel: () => "haiku",
    });
    expect(plan.steps.map((s) => s.logicalIdentity)).toEqual([
      "claude:haiku-latest",
      "claude:haiku-latest",
    ]);
  });

  test("a user prompt with no model still fails, as before profiles", () => {
    expect(() =>
      buildResolvedRoutePlan({
        agents,
        frontmatterModel: () => undefined,
      }),
    ).toThrow(ModelRoutingError);
  });

  test("the zero-config plan through the claude profile equals the frontmatter plan", () => {
    const frontmatter: Record<string, string> = {
      logic: "sonnet",
      refuter: "opus",
    };
    const legacy = buildResolvedRoutePlan({
      agents,
      frontmatterModel: (key) => frontmatter[key],
      summarizer: { frontmatterModel: "haiku" },
      scout: { defaultModel: "sonnet" },
      consolidate: { frontmatterModel: "sonnet", defaultModel: "sonnet" },
      materiality: true,
    });
    const profiled = buildResolvedRoutePlan({
      agents,
      bundledAgents: true,
      summarizer: { frontmatterModel: "haiku" },
      scout: {},
      consolidate: { frontmatterModel: "sonnet" },
      materiality: true,
    });
    expect(profiled).toEqual(legacy);
  });

  test("the scout and the judge take the active profile's model", () => {
    const plan = buildResolvedRoutePlan({
      agents,
      profile: {
        id: "judge-opus",
        roles: {
          scout: { model: "claude:haiku-latest", effort: "low" },
          judge: { model: "claude:opus-latest", effort: "high" },
        },
      },
      frontmatterModel: () => "sonnet",
      scout: {},
      materiality: true,
    });
    const identity = (key: string) =>
      plan.steps.find((s) => s.stepKey === key)?.logicalIdentity;
    expect(identity("scout")).toBe("claude:haiku-latest");
    expect(identity("materiality")).toBe("claude:opus-latest");
  });
});
