// The harness route seam (odd/tasks/route-plan-harness.md T1, S1). Offline:
// plans are pure, and the runner is prepared through the production path
// (resolveProductionRoutePlanAtConfirm + prepareRunnerForRoute) over fixture
// executables, with the same test seams cli-production-wiring.test.ts uses
// (authorityDeps, loadSdk, an env whose OpenCode auth file lives in the test
// dir). No step is ever executed against a provider.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelsConfig } from "#model/model-name";
import {
  buildResolvedRoutePlan,
  InvalidModelError,
  ModelRoutingError,
} from "#model/routing";
import { localReviewSpec } from "#review/preflight";
import type { StepRunner, StepSpec } from "#review/step-runner";
import {
  buildHarnessRoutePlan,
  HarnessRouteError,
  harnessIdentity,
  harnessModelChoice,
  prepareHarnessRunner,
  requireRoutedRunner,
  routeStep,
} from "../../src/harness/route-runner";
import { MultiProviderRunner } from "../../src/production-runtime";
import { resolveOpenCodeAuthPath } from "../../src/security/credential-broker";

const REFUTER = { key: "refuter", role: "refuter" } as const;

// The refuter step of the full production plan (every shipped agent, the
// bundled set) for the same choice: the single-step plan must agree with it.
function productionRefuterRoute(choice: {
  cliModel?: string;
  models?: ModelsConfig;
}) {
  const plan = buildResolvedRoutePlan({
    agents: localReviewSpec({}).agents,
    bundledAgents: true,
    ...choice,
  });
  const step = plan.steps.find((s) => s.stepKey === "refuter");
  if (step === undefined) throw new Error("no refuter in the full plan");
  return step;
}

function spec(overrides: Partial<StepSpec> = {}): StepSpec {
  return {
    name: "refuter",
    model: "opus",
    effort: "high",
    systemPromptPath: "/nonexistent/system.md",
    prompt: "p",
    tools: [],
    mcpConfigPath: "/nonexistent/mcp.json",
    cwd: "/nonexistent",
    outPath: "/nonexistent/out.json",
    timeoutMs: 1000,
    maxAttempts: 1,
    parse: (text) => text,
    ...overrides,
  };
}

describe("buildHarnessRoutePlan", () => {
  test("nothing chosen: the profile seat, as production routes the same step", () => {
    const plan = buildHarnessRoutePlan({
      agents: [REFUTER],
      bundledAgents: true,
    });
    expect(plan.steps.map((s) => s.stepKey)).toEqual(["refuter"]);
    const expected = productionRefuterRoute({});
    expect(plan.steps[0]?.route).toEqual(expected.route);
    expect(plan.steps[0]?.routeFingerprint).toBe(expected.routeFingerprint);
    expect(plan.steps[0]?.route.modelSnapshot).toBe("opus");
  });

  test("an explicit --model wins over models, in production precedence", () => {
    const choice = {
      cliModel: "haiku",
      models: { refuter: ["claude:sonnet-latest"] },
    };
    const plan = buildHarnessRoutePlan({
      agents: [REFUTER],
      bundledAgents: true,
      ...choice,
    });
    const expected = productionRefuterRoute(choice);
    expect(plan.steps[0]?.route).toEqual(expected.route);
    expect(plan.steps[0]?.route.modelSnapshot).toBe("haiku");
  });

  test("a models layer routes the step to OpenCode", () => {
    const models = { refuter: ["opencode:openai/gpt-x"] };
    const plan = buildHarnessRoutePlan({
      agents: [REFUTER],
      bundledAgents: true,
      models,
    });
    expect(plan.steps[0]?.route).toEqual(
      productionRefuterRoute({ models }).route,
    );
    expect(plan.steps[0]?.route.backend).toBe("opencode");
  });

  test("a full config's hunter.<key> roles do not refuse a refuter-only plan", () => {
    const models = {
      "hunter.logic": ["claude:haiku-latest"],
      refuter: ["claude:sonnet-latest"],
    };
    // Production refuses this for a plan without the logic hunter.
    expect(() =>
      buildResolvedRoutePlan({
        agents: [REFUTER],
        bundledAgents: true,
        models,
      }),
    ).toThrow(InvalidModelError);
    const plan = buildHarnessRoutePlan({
      agents: [REFUTER],
      bundledAgents: true,
      models,
    });
    expect(plan.steps[0]?.route.modelSnapshot).toBe("sonnet");
  });

  test("the materiality judge alone takes the profile's judge when none is chosen", () => {
    const plan = buildHarnessRoutePlan({ materiality: true });
    expect(plan.steps.map((s) => s.stepKey)).toEqual(["materiality"]);
    expect(plan.steps[0]?.route.modelSnapshot).toBe("sonnet");
  });

  test("an explicit judge choice is honored", () => {
    const plan = buildHarnessRoutePlan({
      materiality: true,
      models: { judge: ["claude:opus-latest"] },
    });
    expect(plan.steps[0]?.route.modelSnapshot).toBe("opus");
  });

  test("a judge outside the measured list is refused, not dropped", () => {
    expect(() =>
      buildHarnessRoutePlan({
        materiality: true,
        models: { judge: ["claude:haiku-latest"] },
      }),
    ).toThrow(HarnessRouteError);
  });

  test("a plan with no step is refused", () => {
    expect(() => buildHarnessRoutePlan({})).toThrow(HarnessRouteError);
  });
});

describe("routeStep", () => {
  test("gives a hand-built spec the plan's route and fallbacks", () => {
    const plan = buildHarnessRoutePlan({
      agents: [REFUTER],
      bundledAgents: true,
      models: { refuter: ["claude:opus-latest", "opencode:openai/gpt-x"] },
    });
    const routed = routeStep(plan, "refuter", spec());
    expect(routed.route).toEqual(plan.steps[0]?.route);
    expect(routed.fallbackRoutes).toEqual(
      plan.steps[0]?.fallbacks?.map((f) => f.route),
    );
    expect(routed.prompt).toBe("p");
  });

  test("a Claude models entry's effort outranks the spec's, fallbacks included", () => {
    const plan = buildHarnessRoutePlan({
      agents: [REFUTER],
      bundledAgents: true,
      models: {
        refuter: [
          { model: "claude:opus-latest", effort: "max" },
          "claude:sonnet-latest",
        ],
      },
    });
    const routed = routeStep(plan, "refuter", spec({ effort: "high" }));
    expect(routed.effort).toBe("max");
    expect(routed.fallbackEfforts).toEqual(["high"]);
  });

  test("with no entry effort the spec's effort stands", () => {
    const plan = buildHarnessRoutePlan({
      agents: [REFUTER],
      bundledAgents: true,
    });
    const routed = routeStep(plan, "refuter", spec({ effort: "low" }));
    expect(routed.effort).toBe("low");
    expect(routed.fallbackEfforts).toBeUndefined();
  });

  test("a step key the plan does not hold is refused", () => {
    const plan = buildHarnessRoutePlan({
      agents: [REFUTER],
      bundledAgents: true,
    });
    expect(() => routeStep(plan, "scout", spec({ name: "scout" }))).toThrow(
      HarnessRouteError,
    );
  });
});

describe("harnessIdentity", () => {
  const plan = buildHarnessRoutePlan({
    agents: [{ key: "reliability", role: "hunter" }, REFUTER],
    bundledAgents: true,
    models: { refuter: ["opencode:openai/gpt-x"] },
  });

  test("a step's identity is its route and route fingerprint in the plan", () => {
    const step = plan.steps.find((s) => s.stepKey === "refuter");
    if (step === undefined) throw new Error("no refuter in the plan");
    expect(harnessIdentity(plan, "refuter")).toEqual({
      route: step.route,
      routeFingerprint: plan.routeFingerprint as string,
      stepRouteFingerprint: step.routeFingerprint,
    });
  });

  test("a single-step plan needs no step key", () => {
    const single = buildHarnessRoutePlan({
      agents: [REFUTER],
      bundledAgents: true,
    });
    const [step] = single.steps;
    if (step === undefined) throw new Error("no step in the plan");
    expect(harnessIdentity(single)).toEqual({
      route: step.route,
      routeFingerprint: single.routeFingerprint as string,
      stepRouteFingerprint: step.routeFingerprint,
    });
  });

  test("a multi-step plan without a step key, or an unknown key, is refused", () => {
    expect(() => harnessIdentity(plan)).toThrow(HarnessRouteError);
    expect(() => harnessIdentity(plan, "scout")).toThrow(HarnessRouteError);
  });
});

describe("requireRoutedRunner", () => {
  test("an unrouted spec is refused before the inner runner sees it", async () => {
    const seen: StepSpec[] = [];
    const inner: StepRunner = {
      run: async (s) => {
        seen.push(s);
        throw new Error("unreachable");
      },
    };
    await expect(requireRoutedRunner(inner).run(spec())).rejects.toThrow(
      HarnessRouteError,
    );
    expect(seen).toEqual([]);
  });
});

// The production path, offline: fixture executables, a mock OpenCode SDK and
// an OpenCode auth file inside the test dir (cli-production-wiring.test.ts).
describe("prepareHarnessRunner", () => {
  let tmpDir: string;
  let claude: { canonicalPath: string };
  let opencode: { canonicalPath: string };
  let env: Record<string, string>;

  async function executable(name: string, script: string) {
    const file = path.join(tmpDir, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
    return { canonicalPath: await realpath(file) };
  }

  beforeEach(async () => {
    tmpDir = await realpath(
      await mkdtemp(path.join(tmpdir(), "crysk-route-runner-")),
    );
    claude = await executable("claude", "#!/bin/sh\necho ok\n");
    opencode = await executable(
      "opencode",
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "1.18.30"\n  exit 0\nfi\nexit 0\n',
    );
    const dataHome = path.join(tmpDir, "xdg-auth");
    const authFile = resolveOpenCodeAuthPath({ XDG_DATA_HOME: dataHome });
    await mkdir(path.dirname(authFile), { recursive: true });
    await writeFile(
      authFile,
      JSON.stringify({
        openai: {
          type: "oauth",
          refresh: "r",
          access: "a",
          expires: Date.now() + 240 * 60 * 60 * 1000,
        },
      }),
    );
    env = { PATH: tmpDir, XDG_DATA_HOME: dataHome };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const seams = () => ({
    env,
    loadSdk: async () =>
      ({
        createOpencodeClient: () => ({ session: {}, event: {} }),
      }) as unknown as import("../../src/transports/opencode-client").OpenCodeSdkLike,
    authorityDeps: {
      existsFn: (p: string) =>
        p === claude.canonicalPath ||
        p === opencode.canonicalPath ||
        p.startsWith(tmpDir),
      realpathFn: async (p: string) => p,
    },
  });

  const mixedPlan = () =>
    buildHarnessRoutePlan({
      agents: [{ key: "reliability", role: "hunter" }, REFUTER],
      bundledAgents: true,
      models: { refuter: ["opencode:openai/gpt-4o"] },
    });

  test("a Claude route binds to claude-code, an opencode: route to opencode", async () => {
    const plan = mixedPlan();
    const prepared = await prepareHarnessRunner({
      workspaceRoot: tmpDir,
      buildRoutePlan: () => plan,
      ...seams(),
    });
    try {
      expect(prepared.plan).toBe(plan);
      const inner = prepared.runtime.runner;
      expect(inner).toBeInstanceOf(MultiProviderRunner);
      const bind = (stepKey: string) =>
        (inner as MultiProviderRunner).resolveBinding(
          routeStep(plan, stepKey, spec({ name: stepKey })),
        );
      // The verified executable is the binding's own, never copied from the spec.
      expect(bind("hunter-reliability")?.executable.absolutePath).toBe(
        claude.canonicalPath,
      );
      expect(bind("refuter")?.executable.absolutePath).toBe(
        opencode.canonicalPath,
      );
      expect(bind("refuter")?.route).toEqual(
        harnessIdentity(plan, "refuter").route,
      );
      expect(prepared.deps.runner).toBe(prepared.runner);
      expect(prepared.deps.transportRegistry).toBe(prepared.runtime.registry);
      expect(prepared.deps.admissionEvidence?.has("opencode")).toBe(true);
    } finally {
      await prepared.dispose();
    }
  });

  test("an unrouted spec is refused, though the plan holds a Claude binding", async () => {
    const prepared = await prepareHarnessRunner({
      workspaceRoot: tmpDir,
      buildRoutePlan: mixedPlan,
      ...seams(),
    });
    try {
      // The inner runner would fall back to its Claude binding.
      expect(
        (prepared.runtime.runner as MultiProviderRunner).resolveBinding(spec())
          ?.route.backend,
      ).toBe("claude-code");
      await expect(prepared.runner.run(spec())).rejects.toThrow(
        HarnessRouteError,
      );
    } finally {
      await prepared.dispose();
    }
  });

  test("a plan that cannot be built surfaces its error, never the legacy runner", async () => {
    // A raw alias production would let fall back to the no-plan Claude path.
    await expect(
      prepareHarnessRunner({
        workspaceRoot: tmpDir,
        buildRoutePlan: () =>
          buildHarnessRoutePlan({
            agents: [REFUTER],
            cliModel: "not-a-model",
          }),
        ...seams(),
      }),
    ).rejects.toThrow(ModelRoutingError);
    await expect(
      prepareHarnessRunner({
        workspaceRoot: tmpDir,
        buildRoutePlan: () => buildHarnessRoutePlan({}),
        ...seams(),
      }),
    ).rejects.toThrow(HarnessRouteError);
  });
});

// S6: harness flags kept accepting a bare pinned Claude id
// (`--model claude-sonnet-4-5-20250929`), which used to reach the CLI as given.
describe("harnessModelChoice", () => {
  test("a bare pinned Claude id becomes its claude: name", () => {
    expect(harnessModelChoice("claude-sonnet-4-5-20250929")).toBe(
      "claude:claude-sonnet-4-5-20250929",
    );
  });

  test("aliases and prefixed names pass through unchanged", () => {
    expect(harnessModelChoice("sonnet")).toBe("sonnet");
    expect(harnessModelChoice("claude:opus-latest")).toBe("claude:opus-latest");
    expect(harnessModelChoice("opencode:openai/gpt-x")).toBe(
      "opencode:openai/gpt-x",
    );
    expect(harnessModelChoice(undefined)).toBeUndefined();
  });

  test("the plan routes a bare pinned id to that Claude model", () => {
    const plan = buildHarnessRoutePlan({
      agents: [{ key: "probe", role: "other" }],
      cliModel: "claude-sonnet-4-5-20250929",
    });
    const route = plan.steps[0]?.route;
    expect(route?.backend).toBe("claude-code");
    expect(route?.modelSnapshot).toBe("claude-sonnet-4-5-20250929");
  });
});
