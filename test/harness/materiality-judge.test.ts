// The probes' materiality judge on the route seam (route-plan-harness S4, S6).
// Offline: the runner is prepared by an injected fake, so nothing spawns.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { JUDGE_SYSTEM, renderJudgePrompt } from "#compare/materiality";
import { defaultEffortForRole } from "#model/catalog";
import type { ResolvedRoutePlan } from "#model/routing";
import type { StepResult, StepSpec } from "#review/step-runner";
import {
  JUDGE_MODEL,
  judgeClaim,
  judgeRouteFields,
} from "../../scripts/materiality-spawn";
import {
  MATERIALITY_JUDGE_CHOICE,
  materialityJudgeIdentity,
  materialityJudgePlan,
  runMaterialityJudge,
} from "../../src/harness/materiality-judge";
import { harnessIdentity } from "../../src/harness/route-runner";
import { zeroUsage } from "../../src/usage";

const CLAIM = { name: "judge-1", prTitle: "Fix volume", claim: "gain > 1" };

function fakePrepare(result: Partial<StepResult>) {
  const seen: { specs: StepSpec[]; roots: string[]; disposed: number } = {
    specs: [],
    roots: [],
    disposed: 0,
  };
  const prepare = async (workspaceRoot: string, plan: ResolvedRoutePlan) => {
    seen.roots.push(workspaceRoot);
    return {
      plan,
      runner: {
        run: async (spec: StepSpec): Promise<StepResult> => {
          seen.specs.push(spec);
          return {
            name: spec.name,
            status: "ok",
            usage: { ...zeroUsage(), cost_usd_est: 0.02 },
            attempts: 1,
            stderrTail: "",
            resultText: "",
            ...result,
          };
        },
      },
      dispose: async () => {
        seen.disposed += 1;
      },
    };
  };
  return { seen, prepare };
}

describe("materialityJudgePlan", () => {
  test("the default judge is opus, an explicit choice", () => {
    expect(MATERIALITY_JUDGE_CHOICE).toBe("claude:opus-latest");
    const route = harnessIdentity(materialityJudgePlan()).route;
    expect(route.backend).toBe("claude-code");
    expect(route.modelSnapshot).toBe("opus");
    expect(JUDGE_MODEL).toBe("opus");
  });

  test("a judge outside the measured list is refused", () => {
    expect(() => materialityJudgePlan("opencode:openai/gpt-x")).toThrow();
  });

  test("the identity is the plan's", () => {
    const plan = materialityJudgePlan();
    expect(materialityJudgeIdentity()).toEqual(harnessIdentity(plan));
  });
});

describe("runMaterialityJudge", () => {
  test("runs the judge step on its route and records it", async () => {
    const { seen, prepare } = fakePrepare({
      output: { label: "material", reason: "breaks playback" },
    });
    const outcome = await runMaterialityJudge(CLAIM, { prepare });
    const identity = materialityJudgeIdentity();
    expect(outcome).toEqual({
      label: "material",
      reason: "breaks playback",
      cost: 0.02,
      route: identity.route,
      routeFingerprint: identity.routeFingerprint,
    });
    const [spec] = seen.specs;
    expect(spec?.route).toEqual(identity.route);
    expect(spec?.name).toBe("judge-1");
    expect(spec?.tools).toEqual([]);
    expect(spec?.effort).toBe(defaultEffortForRole("other"));
    expect(spec?.prompt).toBe(renderJudgePrompt("Fix volume", "gain > 1"));
    expect(await Bun.file(spec?.systemPromptPath ?? "").exists()).toBe(false);
    // One fresh tmp workspace per spawn, admitted as the root, then removed.
    expect(seen.roots).toHaveLength(1);
    expect(seen.roots[0]).toBe(spec?.cwd);
    expect(existsSync(seen.roots[0] ?? "")).toBe(false);
    expect(seen.disposed).toBe(1);
  });

  test("the system prompt is the judge's", async () => {
    let system = "";
    const { prepare } = fakePrepare({ output: { label: "immaterial" } });
    await runMaterialityJudge(CLAIM, {
      prepare: async (root, plan) => {
        const prepared = await prepare(root, plan);
        return {
          ...prepared,
          runner: {
            run: async (spec) => {
              system = await Bun.file(spec.systemPromptPath).text();
              return prepared.runner.run(spec);
            },
          },
        };
      },
    });
    expect(system).toBe(JUDGE_SYSTEM);
  });

  test("a failed step comes back as label null with the route", async () => {
    const { prepare } = fakePrepare({ status: "failed", stderrTail: "boom" });
    const outcome = await runMaterialityJudge(CLAIM, { prepare });
    expect(outcome.label).toBeNull();
    expect(outcome.error).toBe("boom");
    expect(outcome.route).toEqual(materialityJudgeIdentity().route);
  });

  test("never throws: a refused plan or a failed prepare is an error", async () => {
    const refused = await runMaterialityJudge(CLAIM, {
      judge: "opencode:openai/gpt-x",
      prepare: fakePrepare({}).prepare,
    });
    expect(refused.label).toBeNull();
    expect(refused.error).toBeDefined();
    const failed = await runMaterialityJudge(CLAIM, {
      prepare: async () => {
        throw new Error("no claude");
      },
    });
    expect(failed).toMatchObject({ label: null, error: "no claude", cost: 0 });
  });

  test("judgeClaim keeps its one-argument signature", () => {
    expect(judgeClaim.length).toBe(1);
  });

  test("results files record the opus judge's route", () => {
    const identity = materialityJudgeIdentity();
    expect(judgeRouteFields()).toEqual({
      judge_route: identity.route,
      judge_route_fingerprint: identity.routeFingerprint,
    });
  });
});
