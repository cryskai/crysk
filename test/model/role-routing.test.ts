// odd/tasks/role-model-routing.md E-c: the route plan is built by role (S1),
// with precedence `--model` > the spec's model > models[role] > models.default
// > the prompt's alias as `claude:<alias>-latest` (L6 item 5).
import { describe, expect, test } from "bun:test";
import {
  buildResolvedRoutePlan,
  claudeCliModel,
  InvalidModelError,
  ModelRoutingError,
  type ResolvedRoutePlan,
} from "#model/routing";

const AGENTS = [
  { key: "reliability", role: "hunter" },
  { key: "logic", role: "hunter" },
  { key: "parity", role: "hunter" },
  { key: "refuter", role: "refuter" },
];

const FRONTMATTER: Record<string, string> = {
  reliability: "sonnet",
  logic: "sonnet",
  parity: "sonnet",
  refuter: "opus",
};

function plan(
  over: Partial<Parameters<typeof buildResolvedRoutePlan>[0]> = {},
): ResolvedRoutePlan {
  return buildResolvedRoutePlan({
    agents: AGENTS,
    frontmatterModel: (key) => FRONTMATTER[key],
    summarizer: { frontmatterModel: "haiku" },
    scout: { defaultModel: "sonnet" },
    consolidate: { frontmatterModel: "sonnet", defaultModel: "sonnet" },
    materiality: true,
    ...over,
  });
}

// stepKey -> what each backend is sent: `--model` for the Claude CLI, the
// provider/model/variant triple for OpenCode.
function wire(p: ResolvedRoutePlan): Record<string, string> {
  return Object.fromEntries(
    p.steps.map((step) => [
      step.stepKey,
      step.route.backend === "claude-code"
        ? `claude --model ${claudeCliModel(step.route)}`
        : `opencode ${step.route.provider}/${step.route.modelSnapshot}${step.route.modelVariant === undefined ? "" : `/${step.route.modelVariant}`}`,
    ]),
  );
}

describe("zero config: every step keeps its prompt's model", () => {
  test("each step is sent the alias it was sent before, named as -latest", () => {
    const p = plan();
    expect(wire(p)).toEqual({
      "hunter-reliability": "claude --model sonnet",
      "hunter-logic": "claude --model sonnet",
      "hunter-parity": "claude --model sonnet",
      refuter: "claude --model opus",
      summarizer: "claude --model haiku",
      scout: "claude --model sonnet",
      consolidate: "claude --model sonnet",
      materiality: "claude --model sonnet",
    });
    const identities = Object.fromEntries(
      p.steps.map((s) => [s.stepKey, s.logicalIdentity]),
    );
    expect(identities["hunter-logic"]).toBe("claude:sonnet-latest");
    expect(identities.refuter).toBe("claude:opus-latest");
    expect(identities.summarizer).toBe("claude:haiku-latest");
    // No gateway any more: the route says backend, provider and model.
    for (const step of p.steps) {
      expect(step.route).not.toHaveProperty("gateway");
      expect(step.route.provider).toBe("anthropic");
    }
  });
});

describe("models by role (S1)", () => {
  test("each hunter can get its own model; unlisted roles use default", () => {
    const p = plan({
      models: {
        default: ["claude:opus-latest"],
        "hunter.logic": [
          { model: "opencode:openai/gpt-5", effort: "high" },
          "claude:sonnet-latest",
        ],
        "hunter.parity": ["claude:claude-sonnet-5-5"],
        summary: ["claude:fable-latest"],
      },
    });
    expect(wire(p)).toEqual({
      "hunter-reliability": "claude --model opus",
      // FIRST model only until the fallback runner lands (S4).
      "hunter-logic": "opencode openai/gpt-5/high",
      "hunter-parity": "claude --model claude-sonnet-5-5",
      refuter: "claude --model opus",
      summarizer: "claude --model fable",
      scout: "claude --model opus",
      consolidate: "claude --model opus",
      // The judge never inherits `default` (L6 item 5).
      materiality: "claude --model sonnet",
    });
  });

  test("refuter, scout, consolidate and summary read their own roles", () => {
    const p = plan({
      models: {
        refuter: ["claude:claude-opus-5-5"],
        scout: ["claude:haiku-latest"],
        consolidate: ["opencode:deepseek/deepseek-chat"],
        summary: ["claude:sonnet-latest"],
      },
    });
    const w = wire(p);
    expect(w.refuter).toBe("claude --model claude-opus-5-5");
    expect(w.scout).toBe("claude --model haiku");
    expect(w.consolidate).toBe("opencode deepseek/deepseek-chat");
    expect(w.summarizer).toBe("claude --model sonnet");
    // Hunters had no role and no default: their prompts decide.
    expect(w["hunter-logic"]).toBe("claude --model sonnet");
  });

  test("a diversity leg reads its base hunter's role, but its own model wins", () => {
    const p = buildResolvedRoutePlan({
      agents: [
        {
          key: "logic--leg1",
          specialty: "logic",
          role: "hunter",
          model: "opus",
        },
        { key: "logic--leg2", specialty: "logic", role: "hunter" },
      ],
      frontmatterModel: () => "sonnet",
      models: { "hunter.logic": ["claude:haiku-latest"] },
    });
    expect(wire(p)).toEqual({
      "hunter-logic--leg1": "claude --model opus",
      "hunter-logic--leg2": "claude --model haiku",
    });
  });

  test("a hunter role the spec does not declare is refused, naming its hunters", () => {
    expect(() =>
      plan({ models: { "hunter.security": ["claude:opus-latest"] } }),
    ).toThrow(
      new InvalidModelError(
        "models.hunter.security names no hunter in this review: its hunters are reliability, logic, parity",
      ),
    );
  });

  test("a conditional hunter's role is accepted on a run where it does not fire", () => {
    // The plan is built over every declared hunter; parity's role is not a typo.
    expect(() =>
      plan({ models: { "hunter.parity": ["claude:opus-latest"] } }),
    ).not.toThrow();
  });
});

describe("--model wins over models (L6 item 5)", () => {
  test("a full model name moves every step but the judge", () => {
    const w = wire(
      plan({
        cliModel: "claude:opus-latest",
        models: { default: ["opencode:openai/gpt-5"] },
      }),
    );
    expect(w["hunter-logic"]).toBe("claude --model opus");
    expect(w.refuter).toBe("claude --model opus");
    expect(w.summarizer).toBe("claude --model opus");
    expect(w.scout).toBe("claude --model opus");
    expect(w.materiality).toBe("claude --model sonnet");
  });

  test("a bare alias still works and sends what claude:<alias>-latest sends", () => {
    expect(wire(plan({ cliModel: "sonnet" }))).toEqual(
      wire(plan({ cliModel: "claude:sonnet-latest" })),
    );
  });

  test("claude:sonnet is refused with the -latest hint, never sent as is", () => {
    expect(() => plan({ cliModel: "claude:sonnet" })).toThrow(
      InvalidModelError,
    );
    expect(() => plan({ cliModel: "claude:sonnet" })).toThrow(
      '--model: "claude:sonnet" is not a model name: write "claude:sonnet-latest"',
    );
  });

  test("a legacy raw id is a plain routing error the legacy path may swallow", () => {
    let error: unknown;
    try {
      plan({ cliModel: "claude-opus-4-5" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ModelRoutingError);
    expect(error).not.toBeInstanceOf(InvalidModelError);
  });
});

describe("the judge (L6 item 5)", () => {
  test("models.judge may pick opus", () => {
    expect(
      wire(plan({ models: { judge: ["claude:opus-latest"] } })).materiality,
    ).toBe("claude --model opus");
  });

  test("unmeasured judge models are dropped and the first measured one runs", () => {
    expect(
      wire(
        plan({
          models: {
            judge: [
              "opencode:openai/gpt-5",
              "claude:claude-opus-5-5",
              "claude:opus-latest",
            ],
          },
        }),
      ).materiality,
    ).toBe("claude --model opus");
  });

  test("with no measured model left, the judge stands down and the plan has no judge step", () => {
    const p = plan({ models: { judge: ["claude:haiku-latest"] } });
    expect(p.steps.some((s) => s.stepKey === "materiality")).toBe(false);
  });

  // The gate fails open: a judge the runner may not be able to bind stands down
  // instead of killing the run at admission (resolveMaterialityJudgeRoute).
  test("with every other step off Claude and no models.judge, the judge stands down", () => {
    const p = plan({ models: { default: ["opencode:openai/gpt-5"] } });
    expect(p.steps.some((s) => s.stepKey === "materiality")).toBe(false);
  });

  test("an explicit models.judge still runs on an OpenCode-only plan", () => {
    const p = plan({
      models: {
        default: ["opencode:openai/gpt-5"],
        judge: ["claude:sonnet-latest"],
      },
    });
    expect(wire(p).materiality).toBe("claude --model sonnet");
  });

  test("models.default never reaches the judge", () => {
    expect(
      wire(plan({ models: { default: ["claude:haiku-latest"] } })).materiality,
    ).toBe("claude --model sonnet");
  });
});

describe("--model outranks --scout-model on the scout's route", () => {
  // The scout step records `--model > --scout-model` (pipeline.ts runScout,
  // resolveModel); the route the backend is sent must agree, or the CLI runs
  // one model while the step reports another.
  test("with both, the scout is sent --model", () => {
    const p = plan({
      cliModel: "opus",
      scout: { model: "haiku", defaultModel: "sonnet" },
    });
    expect(wire(p).scout).toBe("claude --model opus");
  });

  test("--scout-model alone still routes the scout", () => {
    const p = plan({ scout: { model: "haiku", defaultModel: "sonnet" } });
    expect(wire(p).scout).toBe("claude --model haiku");
  });
});
