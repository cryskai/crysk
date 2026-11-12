// model-profiles S5: the materiality judge's measured models are the active
// profile's data, not a hard-coded Claude check. `claude` keeps exactly
// sonnet and opus on the Claude CLI; a fixture profile whose measured judge is
// an OpenCode model admits the judge on that route, and only under it.
import { describe, expect, test } from "bun:test";
import { type ModelProfile, profileJudgeModels } from "#model/profiles";
import { CLAUDE_PROFILE } from "#model/profiles/claude";
import {
  buildResolvedRoutePlan,
  isMeasuredJudgeRoute,
  judgeModelChoice,
  MATERIALITY_STEP_KEY,
  MEASURED_JUDGE_MODELS,
  resolveMaterialityJudgeRoute,
  resolveModelRoute,
} from "#model/routing";
import { BASELINE_CASES, captureBaseline } from "./model-profiles-harness";

const OPENCODE_JUDGE = "opencode:openai/gpt-x";

// Test-only: a profile whose judge was "measured" on an OpenCode model. Every
// other role falls back to `claude`.
const OPENCODE_JUDGE_PROFILE: ModelProfile = {
  id: "fixture-opencode-judge",
  roles: { judge: { model: OPENCODE_JUDGE, effort: "high" } },
  measured: { judgeModels: [OPENCODE_JUDGE] },
};

const opencodeAgents = [
  { key: "reliability", role: "hunter", model: OPENCODE_JUDGE },
];

describe("the claude profile's measured judge (S5, S8)", () => {
  test("is exactly sonnet and opus, and the exported list reads it", () => {
    expect(profileJudgeModels(CLAUDE_PROFILE)).toEqual([
      "claude:sonnet-latest",
      "claude:opus-latest",
    ]);
    expect(MEASURED_JUDGE_MODELS).toEqual([
      "claude:sonnet-latest",
      "claude:opus-latest",
    ]);
  });

  test("a profile that measured nothing inherits claude's list", () => {
    expect(profileJudgeModels({ id: "bare", roles: {} })).toEqual([
      "claude:sonnet-latest",
      "claude:opus-latest",
    ]);
  });
});

describe("judge admission reads the active profile (S5)", () => {
  test("judgeModelChoice: the OpenCode judge is kept under the fixture, dropped under claude", () => {
    const models = { judge: [OPENCODE_JUDGE] };
    expect(judgeModelChoice(models, OPENCODE_JUDGE_PROFILE)).toEqual({
      model: OPENCODE_JUDGE,
      dropped: [],
    });
    expect(judgeModelChoice(undefined, OPENCODE_JUDGE_PROFILE)).toEqual({
      model: OPENCODE_JUDGE,
      dropped: [],
    });
    expect(judgeModelChoice(models)).toEqual({ dropped: [OPENCODE_JUDGE] });
    // The fixture never measured sonnet: under it, sonnet is the unmeasured one.
    expect(
      judgeModelChoice(
        { judge: ["claude:sonnet-latest"] },
        OPENCODE_JUDGE_PROFILE,
      ),
    ).toEqual({ dropped: ["claude:sonnet-latest"] });
  });

  test("isMeasuredJudgeRoute: the OpenCode route under the fixture only", () => {
    const opencode = resolveModelRoute(OPENCODE_JUDGE);
    expect(isMeasuredJudgeRoute(opencode, OPENCODE_JUDGE_PROFILE)).toBe(true);
    expect(isMeasuredJudgeRoute(opencode)).toBe(false);
    expect(isMeasuredJudgeRoute(opencode, CLAUDE_PROFILE)).toBe(false);
    expect(
      isMeasuredJudgeRoute(resolveModelRoute("sonnet"), OPENCODE_JUDGE_PROFILE),
    ).toBe(false);
    expect(isMeasuredJudgeRoute(resolveModelRoute("sonnet"))).toBe(true);
  });

  test("resolveMaterialityJudgeRoute: an OpenCode route under the fixture, none under claude", () => {
    const models = { judge: [OPENCODE_JUDGE] };
    expect(
      resolveMaterialityJudgeRoute(models, OPENCODE_JUDGE_PROFILE)?.route
        .backend,
    ).toBe("opencode");
    expect(resolveMaterialityJudgeRoute(models)).toBeUndefined();
  });

  test("the plan: an all-OpenCode plan carries the fixture's judge, not claude's", () => {
    const judgeStep = (profile?: ModelProfile) =>
      buildResolvedRoutePlan({
        agents: opencodeAgents,
        materiality: true,
        ...(profile === undefined ? {} : { profile }),
      }).steps.find((s) => s.stepKey === MATERIALITY_STEP_KEY);
    const fixture = judgeStep(OPENCODE_JUDGE_PROFILE);
    expect(fixture?.logicalIdentity).toBe(OPENCODE_JUDGE);
    expect(fixture?.route.backend).toBe("opencode");
    // Under claude the judge is claude-code and the plan runs no Claude step,
    // so it stands down as it always has.
    expect(judgeStep()).toBeUndefined();
  });
});

describe("through the pipeline (S5)", () => {
  const opencodeCase = BASELINE_CASES.find((c) => c.name === "opencode");
  if (opencodeCase === undefined) throw new Error("no opencode baseline case");
  const judgeSteps = (steps: readonly { name: string }[]) =>
    steps.filter((s) => s.name.startsWith("materiality"));

  test("the fixture profile runs the judge on its OpenCode route", async () => {
    const baseline = await captureBaseline(opencodeCase, {
      modelProfile: OPENCODE_JUDGE_PROFILE,
    });
    const judges = judgeSteps(baseline.steps);
    expect(judges.length).toBeGreaterThan(0);
    for (const judge of judges) {
      expect(judge).toMatchObject({
        backend: "opencode",
        provider: "openai",
        modelSnapshot: "gpt-x",
      });
    }
  });

  test("the claude profile on the same run spawns no judge", async () => {
    const baseline = await captureBaseline(opencodeCase);
    expect(judgeSteps(baseline.steps)).toEqual([]);
  });
});
