import { describe, expect, test } from "bun:test";
import { MATERIALITY_STEP_KEY } from "#model/routing";
import type { CliOptions } from "#review/preflight";
import {
  buildCliRoutePlan,
  pipelineMaterialityInput,
} from "#review/route-preflight";
import { defaultReviewSpec } from "#review/spec";
import { resolveEngineAssets } from "../../src/assets";

describe("pipelineMaterialityInput (odd/tasks/materiality-gate.md S2)", () => {
  test("absent or false: no materiality input, today's pipeline", () => {
    expect(pipelineMaterialityInput({})).toEqual({});
    expect(pipelineMaterialityInput({ materiality_gate: false })).toEqual({});
  });

  test("true: the engine-owned prompt path and nothing else", () => {
    expect(pipelineMaterialityInput({ materiality_gate: true })).toEqual({
      materiality: { promptPath: resolveEngineAssets().materialityPromptPath },
    });
  });
});

describe("buildCliRoutePlan: the materiality judge key (S14)", () => {
  const params = {
    spec: defaultReviewSpec(),
    options: { model: "sonnet", scout: false } as CliOptions,
    agentFiles: new Map(),
    summary: { enabled: false },
  };
  const keys = (plan: { steps: readonly { stepKey: string }[] }) =>
    plan.steps.map((s) => s.stepKey);

  test("defaults OFF: no judge key and an unchanged fingerprint", async () => {
    const off = await buildCliRoutePlan(params);
    const explicitOff = await buildCliRoutePlan({
      ...params,
      materialityEnabled: false,
    });
    expect(keys(off)).not.toContain(MATERIALITY_STEP_KEY);
    expect(explicitOff.routeFingerprint).toBe(off.routeFingerprint);
    // Consolidation still defaults ON, exactly as before.
    expect(keys(off)).toContain("consolidate");
  });

  test("enabled: the judge key on claude-code, opus despite --model sonnet", async () => {
    const plan = await buildCliRoutePlan({
      ...params,
      materialityEnabled: true,
    });
    const judge = plan.steps.find((s) => s.stepKey === MATERIALITY_STEP_KEY);
    expect(judge?.route.backend).toBe("claude-code");
    expect(judge?.route.modelSnapshot).toBe("opus");
  });
});
