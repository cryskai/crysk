// odd/tasks/antigravity-oauth.md T2 (S4): the `agy:<model-id>` grammar. The
// effort is part of the id (`gemini-4-argon-high`), so an `agy:` entry never
// takes an effort and its route carries no variant.
import { describe, expect, test } from "bun:test";
import {
  modelNameFromAlias,
  modelsNeedOpenCode,
  parseModelName,
  parseModelsConfig,
} from "#model/model-name";
import {
  buildResolvedRoutePlan,
  InvalidModelError,
  judgeModelChoice,
  planRoutes,
  resolveStepRoute,
} from "#model/routing";
import { effortApplied } from "../../src/execution/contracts";

// What `agy models` listed in T0 (L6). A fixture, not a table the engine
// keeps: the models come from Google's server, so only the grammar is checked.
const AGY_MODEL_IDS = [
  "gemini-4-argon-low",
  "gemini-4-argon-medium",
  "gemini-4-argon-high",
  "gemini-4-hydrogen-low",
  "gemini-4-hydrogen-medium",
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-xhigh",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-high",
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-high",
  "gemini-pro-orchestrator-g1-pro",
  "gpt-oss-120b-medium",
];

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

const AGY_EFFORT_REFUSAL =
  'sets an effort on an Antigravity model: the effort is part of the agy model id (for example "agy:gemini-4-argon-high"), so write the id with the level you want and no effort';

describe("parseModelName: agy names (S4)", () => {
  test("every id agy lists parses to the antigravity backend on google", () => {
    for (const id of AGY_MODEL_IDS) {
      expect(parseModelName(`agy:${id}`), id).toEqual({
        raw: `agy:${id}`,
        backend: "antigravity",
        provider: "google",
        model: id,
      });
    }
  });

  test("the id grammar is lowercase letters, digits, '.', '_' and '-', starting with a letter or digit", () => {
    for (const bad of [
      "agy:",
      "agy:Gemini-4-argon-high",
      "agy:-gemini",
      "agy:.gemini",
      "agy:google/gemini-4-argon-high",
      "agy:gemini 4",
      "agy:gemini:4",
    ]) {
      const message = messageOf(() => parseModelName(bad));
      expect(message, bad).toContain(
        "is not an Antigravity model name: use agy:<model-id>, the id as `agy models` lists it",
      );
    }
  });

  test("a bare alias still converts to claude; an agy name passes through modelNameFromAlias", () => {
    expect(modelNameFromAlias("agy:gemini-4-argon-high").backend).toBe(
      "antigravity",
    );
  });

  test("an unprefixed name lists the three forms", () => {
    expect(messageOf(() => parseModelName("gpt-5"))).toBe(
      '"gpt-5" is not a model name: a model is "claude:<name>", "opencode:<provider>/<model>" or "agy:<model-id>"',
    );
  });

  test("an agy #variant suffix says the effort is part of the id, not an effort entry", () => {
    expect(messageOf(() => parseModelName("agy:gemini-4-argon#high"))).toBe(
      '"agy:gemini-4-argon#high": the #variant suffix is gone, and an Antigravity model takes no effort: the effort is part of the agy model id, so write "agy:gemini-4-argon-high" if agy models lists it',
    );
  });

  test("agy names do not need OpenCode", () => {
    expect(
      modelsNeedOpenCode(
        parseModelsConfig({ default: ["agy:gemini-4-argon-high"] }),
      ),
    ).toBe(false);
  });
});

describe("an agy entry takes no effort (S4)", () => {
  test("an explicit effort is refused for every role but the judge, with the reason", () => {
    for (const role of [
      "default",
      "hunter.logic",
      "consolidate",
      "scout",
      "refuter",
      "summary",
    ]) {
      expect(
        messageOf(() =>
          parseModelsConfig({
            [role]: [{ model: "agy:gemini-4-argon", effort: "high" }],
          }),
        ),
        role,
      ).toBe(`models.${role}[0] ${AGY_EFFORT_REFUSAL}`);
    }
  });

  test("models.judge keeps its own no-effort message", () => {
    expect(
      messageOf(() =>
        parseModelsConfig({
          judge: [{ model: "agy:gemini-4-argon-high", effort: "high" }],
        }),
      ),
    ).toBe(
      "models.judge[0] sets an effort: the materiality judge runs at the effort it was measured at, so models.judge takes model names only",
    );
  });

  test("an effort that looks like a credential is refused as one, without echoing it", () => {
    const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
    const message = messageOf(() =>
      parseModelsConfig({
        default: [{ model: "agy:gemini-4-argon-high", effort: key }],
      }),
    );
    expect(message).toBe(
      "models.default[0]: the effort looks like a credential, and credentials are not permitted in models",
    );
  });

  test("an entry with no effort is kept as written", () => {
    expect(
      parseModelsConfig({
        default: [
          "agy:gemini-4-argon-high",
          { model: "agy:gpt-oss-120b-medium" },
        ],
      }),
    ).toEqual({
      default: [
        "agy:gemini-4-argon-high",
        { model: "agy:gpt-oss-120b-medium" },
      ],
    });
  });
});

describe("routing an agy name (S4)", () => {
  test("the route is antigravity on google, the id as family and snapshot, no variant, no effort", () => {
    const step = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      modelRole: "hunter.logic",
      models: { "hunter.logic": ["agy:claude-sonnet-5-5-high"] },
    });
    expect(step.route).toEqual({
      backend: "antigravity",
      provider: "google",
      modelFamily: "claude-sonnet-5-5-high",
      modelSnapshot: "claude-sonnet-5-5-high",
    });
    expect(step.effort).toBeUndefined();
    expect(effortApplied(step.route)).toBe(false);
  });

  test("a profile effort never reaches an agy route", () => {
    const step = resolveStepRoute({
      stepKey: "refuter",
      role: "refuter",
      profileModel: "agy:gemini-4-argon-high",
      profileEffort: "high",
    });
    expect(step.route.modelVariant).toBeUndefined();
    expect(step.effort).toBeUndefined();
  });

  test("an effort on an unparsed models object is still refused at routing", () => {
    expect(() =>
      resolveStepRoute({
        stepKey: "summary",
        role: "summarizer",
        modelRole: "summary",
        models: { summary: [{ model: "agy:gemini-4-argon", effort: "high" }] },
      }),
    ).toThrow(
      new InvalidModelError(`models for summary ${AGY_EFFORT_REFUSAL}`),
    );
  });

  test("a bad --model agy: name is an InvalidModelError, never the legacy path", () => {
    expect(() =>
      resolveStepRoute({
        stepKey: "hunter-logic",
        role: "hunter",
        cliModel: "agy:Bad",
      }),
    ).toThrow(InvalidModelError);
  });

  test("an agy model as a fallback is part of the plan's routes either way round", () => {
    for (const list of [
      ["agy:gemini-4-argon-high", "claude:sonnet-latest"],
      ["claude:sonnet-latest", "agy:gemini-4-argon-high"],
    ]) {
      const plan = buildResolvedRoutePlan({
        agents: [{ key: "logic", role: "hunter" }],
        models: { default: list },
      });
      const backends = planRoutes(plan).map((step) => step.route.backend);
      expect(backends, list.join(",")).toContain("antigravity");
    }
  });

  test("an agy judge is not a measured judge: dropped, never run", () => {
    expect(judgeModelChoice({ judge: ["agy:gemini-4-argon-high"] })).toEqual({
      dropped: ["agy:gemini-4-argon-high"],
    });
  });
});

// The paths T2 touched, held to what they did before it for claude: and
// opencode: names.
describe("claude: and opencode: are unchanged by agy (S4)", () => {
  test("parsing", () => {
    expect(parseModelName("claude:sonnet-latest")).toEqual({
      raw: "claude:sonnet-latest",
      backend: "claude-code",
      provider: "anthropic",
      model: "sonnet",
      alias: "sonnet",
    });
    expect(parseModelName("opencode:google/gemini-2.5-pro")).toEqual({
      raw: "opencode:google/gemini-2.5-pro",
      backend: "opencode",
      provider: "google",
      model: "gemini-2.5-pro",
    });
  });

  test("the #variant suffix message", () => {
    expect(messageOf(() => parseModelName("opencode:openai/gpt-5#high"))).toBe(
      '"opencode:openai/gpt-5#high": the #variant suffix is gone: write {"model": "opencode:openai/gpt-5", "effort": "high"} in models',
    );
  });

  test("efforts are still taken and checked", () => {
    expect(
      parseModelsConfig({
        default: [
          { model: "claude:opus-latest", effort: "max" },
          { model: "opencode:google/gemini-2.5-pro", effort: "high" },
        ],
      }),
    ).toEqual({
      default: [
        { model: "claude:opus-latest", effort: "max" },
        { model: "opencode:google/gemini-2.5-pro", effort: "high" },
      ],
    });
    expect(
      messageOf(() =>
        parseModelsConfig({
          refuter: [{ model: "claude:opus-latest", effort: "extreme" }],
        }),
      ),
    ).toBe(
      'models.refuter[0]: effort "extreme" is not a Claude effort level: use low, medium, high, xhigh or max',
    );
  });

  test("routing keeps an OpenCode effort as the variant and a Claude effort on the step", () => {
    const opencode = resolveStepRoute({
      stepKey: "summary",
      role: "summarizer",
      modelRole: "summary",
      models: { summary: [{ model: "opencode:openai/gpt-5", effort: "high" }] },
    });
    expect(opencode.route.modelVariant).toBe("high");
    expect(opencode.effort).toBe("high");
    expect(effortApplied(opencode.route)).toBe(true);
    const claude = resolveStepRoute({
      stepKey: "summary",
      role: "summarizer",
      modelRole: "summary",
      models: { summary: [{ model: "claude:haiku-latest", effort: "low" }] },
    });
    expect(claude.route.modelVariant).toBeUndefined();
    expect(claude.effort).toBe("low");
    expect(effortApplied(claude.route)).toBe(true);
  });
});
