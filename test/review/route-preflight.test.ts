import { describe, expect, test } from "bun:test";
import { MATERIALITY_STEP_KEY } from "#model/routing";
import {
  type AgentsDirSource,
  type CliOptions,
  resolveAgentsDirSetting,
} from "#review/preflight";
import { parseAgentSource } from "#review/prompt-set";
import {
  buildCliRoutePlan,
  isBundledAgentsDir,
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
    options: { model: "opus", scout: false } as CliOptions,
    agentFiles: new Map(),
    bundledAgents: false,
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

  test("enabled: the judge key on claude-code, sonnet despite --model opus", async () => {
    const plan = await buildCliRoutePlan({
      ...params,
      materialityEnabled: true,
    });
    const judge = plan.steps.find((s) => s.stepKey === MATERIALITY_STEP_KEY);
    expect(judge?.route.backend).toBe("claude-code");
    expect(judge?.route.modelSnapshot).toBe("sonnet");
  });
});

// model-profiles S3 in production: only the bundled set (source "default")
// routes by the profile; every set a person points at keeps its frontmatter.
// The agents' frontmatter says haiku, which the `claude` profile never does,
// so the plan shows which of the two decided.
describe("the bundled-agents flag on the production plan (model-profiles S3)", () => {
  const seat = {
    value: "./prompts",
    layer: "repo" as const,
    dir: "/repo/.crysk",
  };
  const resolutions: Record<
    AgentsDirSource,
    Parameters<typeof resolveAgentsDirSetting>[0]
  > = {
    default: { cwd: "/work" },
    flag: { flag: "/custom/agents", cwd: "/work" },
    repo: { config: seat, cwd: "/work" },
    global: { config: { ...seat, layer: "global" }, cwd: "/work" },
    env: { env: "/env/agents", cwd: "/work" },
  };
  const spec = defaultReviewSpec();
  const haiku = new Map(
    spec.agents.map((a) => [
      a.key,
      parseAgentSource(
        `---\nname: ${a.key}\nmodel: haiku\neffort: low\n---\nbody\n`,
      ),
    ]),
  );

  for (const [source, input] of Object.entries(resolutions)) {
    test(`source ${source}`, async () => {
      const agents = resolveAgentsDirSetting(input);
      expect(agents.source).toBe(source as AgentsDirSource);
      const bundled = isBundledAgentsDir(agents);
      expect(bundled).toBe(source === "default");
      const plan = await buildCliRoutePlan({
        spec,
        options: { scout: false } as CliOptions,
        agentFiles: haiku,
        bundledAgents: bundled,
        summary: { enabled: false },
        consolidateEnabled: false,
      });
      const identities = new Set(
        plan.steps
          .filter((s) => s.role === "hunter" || s.role === "refuter")
          .map((s) => s.logicalIdentity),
      );
      expect([...identities].sort()).toEqual(
        bundled
          ? ["claude:opus-latest", "claude:sonnet-latest"]
          : ["claude:haiku-latest"],
      );
    });
  }
});
