// Single-step harnesses on the route seam (odd/tasks/route-plan-harness.md
// T3, S3 and S6). Offline: plans are pure, and the runner is a fake behind an
// injected preparer, so no provider and no Keychain is ever reached.
import { describe, expect, test } from "bun:test";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import { requireRoutedRunner } from "../../src/harness/route-runner";
import {
  prepareSingleStepRunner,
  ranOnRoute,
  routeIdentityFields,
  type SingleStep,
  singleStepRoute,
} from "../../src/harness/single-step";

const CLAUDE_SONNET = {
  backend: "claude-code",
  provider: "anthropic",
  modelFamily: "sonnet",
  modelSnapshot: "sonnet",
} as const;

function spec(overrides: Partial<StepSpec> = {}): StepSpec {
  return {
    name: "refuter-F001",
    model: "sonnet",
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

// A preparer that records what it was given and runs specs on a fake runner
// behind the seam's own guard, as prepareHarnessRunner does.
function fakePreparer() {
  const seen: StepSpec[] = [];
  const inputs: unknown[] = [];
  let disposed = 0;
  const inner: StepRunner = {
    run: async (s) => {
      seen.push(s);
      return { name: s.name, status: "ok", output: "out" } as StepResult;
    },
  };
  const prepare = (async (input: {
    buildRoutePlan: () => unknown;
    workspaceRoot: string;
  }) => {
    inputs.push(input);
    const plan = await input.buildRoutePlan();
    const runner = requireRoutedRunner(inner);
    return {
      plan,
      runner,
      deps: { runner },
      dispose: async () => {
        disposed++;
      },
    };
  }) as unknown as NonNullable<
    Parameters<typeof prepareSingleStepRunner>[0]["prepare"]
  >;
  return { prepare, seen, inputs, disposed: () => disposed };
}

describe("singleStepRoute: today's model, as an explicit choice (S6)", () => {
  const steps: [SingleStep, string][] = [
    ["refuter", "refuter"],
    ["scout", "scout"],
    ["consolidate", "consolidate"],
    [{ key: "martian-judge" }, "martian-judge"],
    [{ key: "micro-eval" }, "micro-eval"],
  ];
  for (const [step, stepKey] of steps) {
    test(`${stepKey}: --model sonnet runs claude:sonnet-latest`, () => {
      const route = singleStepRoute(step, "sonnet");
      expect(route.stepKey).toBe(stepKey);
      expect(route.identity.route).toEqual(CLAUDE_SONNET);
      expect(route.plan.steps).toHaveLength(1);
    });
  }

  test("a bare alias and its claude: spelling are the same route", () => {
    const bare = singleStepRoute("refuter", "opus");
    const spelled = singleStepRoute("refuter", "claude:opus-latest");
    expect(bare.identity.stepRouteFingerprint).toBe(
      spelled.identity.stepRouteFingerprint,
    );
    expect(bare.identity.route.modelSnapshot).toBe("opus");
  });

  test("--model opencode:<provider>/<model> routes the step to OpenCode", () => {
    const route = singleStepRoute("refuter", "opencode:openai/gpt-x");
    expect(route.identity.route).toMatchObject({
      backend: "opencode",
      provider: "openai",
      modelSnapshot: "gpt-x",
    });
  });

  test("the model wins over a profile seat or a lab prompt's frontmatter", () => {
    // The scout and consolidate steps have a profile seat; the explicit model
    // must hold it, or a profile change would move what is measured.
    expect(singleStepRoute("scout", "haiku").identity.route.modelSnapshot).toBe(
      "haiku",
    );
    expect(
      singleStepRoute("consolidate", "opus").identity.route.modelSnapshot,
    ).toBe("opus");
  });
});

describe("routeIdentityFields", () => {
  test("the row fields are the seam's identity under snake_case names", () => {
    const route = singleStepRoute("refuter", "sonnet");
    expect(routeIdentityFields(route.identity)).toEqual({
      route: CLAUDE_SONNET,
      route_fingerprint: route.identity.routeFingerprint,
      step_route_fingerprint: route.identity.stepRouteFingerprint,
    } as never);
  });
});

describe("ranOnRoute: resume never orphans a paid row", () => {
  const sonnet = singleStepRoute("refuter", "sonnet");

  test("an old row keyed by the model string resumes under both spellings", () => {
    const old = { model: "sonnet" };
    expect(ranOnRoute(old, sonnet)).toBe(true);
    expect(
      ranOnRoute(old, singleStepRoute("refuter", "claude:sonnet-latest")),
    ).toBe(true);
  });

  test("an old row never resumes a different model or backend", () => {
    const old = { model: "sonnet" };
    expect(ranOnRoute(old, singleStepRoute("refuter", "opus"))).toBe(false);
    expect(
      ranOnRoute(old, singleStepRoute("refuter", "opencode:openai/gpt-x")),
    ).toBe(false);
  });

  test("an old row whose model no longer parses resumes only its own string", () => {
    expect(ranOnRoute({ model: "not a model" }, sonnet)).toBe(false);
    expect(ranOnRoute({}, sonnet)).toBe(false);
  });

  test("a new row matches on its step route fingerprint", () => {
    const row = {
      model: "claude:sonnet-latest",
      step_route_fingerprint: sonnet.identity.stepRouteFingerprint,
    };
    expect(ranOnRoute(row, sonnet)).toBe(true);
    const opencode = singleStepRoute("refuter", "opencode:openai/gpt-x");
    expect(ranOnRoute(row, opencode)).toBe(false);
    // The fingerprint decides, not a model string that happens to agree.
    expect(
      ranOnRoute(
        { model: "sonnet", step_route_fingerprint: "other" },
        singleStepRoute("refuter", "sonnet"),
      ),
    ).toBe(false);
  });
});

describe("prepareSingleStepRunner", () => {
  test("prepares on the route's plan and routes every spec before it runs", async () => {
    const route = singleStepRoute("refuter", "opencode:openai/gpt-x");
    const fake = fakePreparer();
    const runner = await prepareSingleStepRunner({
      workspaceRoot: "/scratch",
      route,
      prepare: fake.prepare,
    });
    const result = await runner.run(spec());
    expect(result.status).toBe("ok");
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]?.route).toEqual(route.identity.route);
    expect(fake.seen[0]?.route?.backend).toBe("opencode");
    expect(fake.seen[0]?.prompt).toBe("p");
    expect(fake.inputs[0]).toMatchObject({ workspaceRoot: "/scratch" });
    await runner.dispose();
    expect(fake.disposed()).toBe(1);
  });

  test("the default stays the Claude route a review runs today", async () => {
    const route = singleStepRoute("scout", "sonnet");
    const fake = fakePreparer();
    const runner = await prepareSingleStepRunner({
      workspaceRoot: "/scratch",
      route,
      prepare: fake.prepare,
    });
    await runner.run(spec({ name: "scout-1-r1", effort: "low" }));
    expect(fake.seen[0]?.route).toEqual(CLAUDE_SONNET as never);
    expect(fake.seen[0]?.effort).toBe("low");
  });

  test("the Claude credential and test seams pass through to the seam", async () => {
    const route = singleStepRoute("refuter", "sonnet");
    const fake = fakePreparer();
    const claudeRun = {
      selection: { status: "none" },
      env: { PATH: "/x" },
    } as never;
    await prepareSingleStepRunner({
      workspaceRoot: "/scratch",
      route,
      claudeRun,
      checkCredentials: false,
      prepare: fake.prepare,
    });
    expect(fake.inputs[0]).toMatchObject({
      claudeRun,
      checkCredentials: false,
    });
  });
});
