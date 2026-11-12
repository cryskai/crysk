// odd/tasks/openai-profile.md S6: the CI setup step, the doctor and the SDK
// reconcile read the person's `profile`, so `openai` alone writes the OpenAI
// credential, probes OpenAI routes and needs the OpenCode SDK, not Claude.
import { describe, expect, test } from "bun:test";
import { openCodeProvidersOfPerson } from "#ci/setup";
import { routingNeedsOpenCode } from "#model/model-name";
import { resolveProfile } from "#model/profiles";
import { planRoutes } from "#model/routing";
import { openCodeRoutingSdkCheck } from "../../src/doctor";
import { buildDoctorRoutePlan } from "../../src/production-runtime";

const OPENAI = resolveProfile("openai");
const CLAUDE = resolveProfile("claude");

describe("the setup step's OpenCode providers (S6)", () => {
  test.each<[string, Record<string, unknown>, string[]]>([
    ["no profile, no models", {}, []],
    ["openai alone", { profile: "openai" }, ["openai"]],
    [
      "openai with a Claude default",
      { profile: "openai", models: { default: ["claude:sonnet-latest"] } },
      [],
    ],
    [
      "openai with another OpenCode provider for one role",
      {
        profile: "openai",
        models: { summary: ["opencode:deepseek/deepseek-chat"] },
      },
      ["deepseek", "openai"],
    ],
    ["claude", { profile: "claude" }, []],
  ])("%s", (_l, person, expected) => {
    expect(openCodeProvidersOfPerson(person)).toEqual(expected);
  });
});

describe("the OpenCode SDK need (S6)", () => {
  test("openai alone needs it; claude alone does not", () => {
    expect(routingNeedsOpenCode(undefined, OPENAI)).toBe(true);
    expect(routingNeedsOpenCode(undefined, CLAUDE)).toBe(false);
    expect(
      routingNeedsOpenCode({ default: ["claude:sonnet-latest"] }, OPENAI),
    ).toBe(false);
  });

  test("the doctor's SDK check runs for openai with no models", () => {
    expect(
      openCodeRoutingSdkCheck({ models: undefined, sdkVersion: undefined }),
    ).toBeUndefined();
    expect(
      openCodeRoutingSdkCheck({
        models: undefined,
        profile: OPENAI,
        sdkVersion: undefined,
      }),
    ).toBeDefined();
  });
});

describe("the doctor's route plan (S6)", () => {
  test("openai with no Claude needed probes the profile's OpenAI routes", () => {
    const plan = buildDoctorRoutePlan(undefined, {
      profile: OPENAI,
      claudeRequired: false,
    });
    // PR #521 R002: with the variant a review's routes carry, so the probe
    // checks the bindings a review opens.
    const routes = planRoutes(plan).map((s) => [
      s.route.backend,
      s.route.provider,
      s.route.modelSnapshot,
      s.route.modelVariant,
    ]);
    expect(routes).toEqual([
      ["opencode", "openai", "gpt-6.1-terra", "xhigh"],
      ["opencode", "openai", "gpt-6.1-sol", "high"],
    ]);
  });

  test("the claude profile's doctor plan is unchanged: no variant", () => {
    const plan = buildDoctorRoutePlan(undefined, { profile: CLAUDE });
    expect(
      plan.steps.map((s) => [s.logicalIdentity, s.route.modelVariant]),
    ).toEqual([
      ["claude:sonnet-latest", undefined],
      ["claude:opus-latest", undefined],
    ]);
  });

  test("openai with a models entry keeps the profile's steps beside it", () => {
    const plan = buildDoctorRoutePlan(
      { summary: ["opencode:deepseek/deepseek-chat"] },
      { profile: OPENAI, claudeRequired: false },
    );
    expect(planRoutes(plan).map((s) => s.route.provider)).toEqual([
      "openai",
      "openai",
      "deepseek",
    ]);
  });
});
