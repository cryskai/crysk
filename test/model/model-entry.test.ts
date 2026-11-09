// odd/tasks/role-model-routing.md E-g (S7, S1, S3), unit E1: a `models` list
// entry is a model name or `{"model": ..., "effort": ...}`, and the old
// `#variant` suffix is refused everywhere a model is written.
import { describe, expect, test } from "bun:test";
import {
  ModelNameError,
  modelEntry,
  modelsNeedOpenCode,
  parseModelList,
  parseModelName,
  parseModelsConfig,
} from "#model/model-name";
import {
  buildResolvedRoutePlan,
  InvalidModelError,
  judgeModelChoice,
  resolveStepRoute,
} from "#model/routing";
import { ReviewSpecValidationError, validateReviewSpec } from "#review/spec";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

const VARIANT_HINT =
  '"opencode:openai/gpt-5#high": the #variant suffix is gone: write {"model": "opencode:openai/gpt-5", "effort": "high"} in models';

describe("an entry is a model name or {model, effort} (S7)", () => {
  test("object entries are accepted and kept as written, beside strings", () => {
    const models = {
      default: ["claude:sonnet-latest"],
      "hunter.logic": [
        { model: "claude:opus-latest", effort: "max" },
        { model: "opencode:openai/gpt-5", effort: "high" },
        { model: "claude:haiku-latest" },
      ],
    };
    expect(parseModelsConfig(models)).toEqual(models);
  });

  test("modelEntry reads either form as {name, effort?}", () => {
    expect(modelEntry("claude:sonnet-latest")).toEqual({
      name: "claude:sonnet-latest",
    });
    expect(modelEntry({ model: "claude:opus-latest" })).toEqual({
      name: "claude:opus-latest",
    });
    expect(modelEntry({ model: "claude:opus-latest", effort: "max" })).toEqual({
      name: "claude:opus-latest",
      effort: "max",
    });
  });

  test("a Claude effort outside the CLI's levels is refused with the levels", () => {
    expect(
      messageOf(() =>
        parseModelList(
          [{ model: "claude:opus-latest", effort: "extreme" }],
          "models.refuter",
        ),
      ),
    ).toBe(
      'models.refuter[0]: effort "extreme" is not a Claude effort level: use low, medium, high, xhigh or max',
    );
  });

  test("ultracode is refused: it is a Claude Code mode, not an effort level", () => {
    expect(
      messageOf(() =>
        parseModelList(
          [{ model: "claude:sonnet-latest", effort: "ultracode" }],
          "models.default",
        ),
      ),
    ).toBe(
      'models.default[0]: effort "ultracode" is not an effort level: on the Claude Code CLI it also turns on workflow orchestration. Write "xhigh" for its effort level',
    );
  });

  test("an OpenCode effort is a variant name: no spaces, at most 64 characters", () => {
    for (const effort of ["very high", "", "x".repeat(65), "high!"]) {
      expect(
        messageOf(() =>
          parseModelList(
            [{ model: "opencode:openai/gpt-5", effort }],
            "models.default",
          ),
        ),
        effort,
      ).toBe(
        `models.default[0]: effort ${JSON.stringify(effort)} is not an OpenCode variant name: use letters, digits, ".", "_" and "-", at most 64 characters`,
      );
    }
    // Provider-specific names pass through: the engine keeps no per-model table.
    for (const effort of [
      "none",
      "xhigh",
      "thinking",
      "low.v2",
      "x".repeat(64),
    ]) {
      expect(
        parseModelList(
          [{ model: "opencode:openai/gpt-5", effort }],
          "models.default",
        ),
      ).toEqual([{ model: "opencode:openai/gpt-5", effort }]);
    }
  });

  test("an effort that looks like a credential is refused and never echoed", () => {
    const secret = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const message = messageOf(() =>
      parseModelList(
        [{ model: "opencode:openai/gpt-5", effort: secret }],
        "models.default",
      ),
    );
    expect(message).toBe(
      "models.default[0]: the effort looks like a credential, and credentials are not permitted in models",
    );
    expect(message).not.toContain(secret);
  });

  test("an unknown key is refused and the two keys are named", () => {
    expect(
      messageOf(() =>
        parseModelsConfig({
          "hunter.logic": [{ model: "opencode:openai/gpt-5", variant: "high" }],
        }),
      ),
    ).toBe(
      'models.hunter.logic[0] has an unknown key "variant": an entry takes model and effort',
    );
  });

  test("an entry with no model, or of another shape, is refused", () => {
    expect(
      messageOf(() => parseModelList([{ effort: "high" }], "models.default")),
    ).toBe('models.default[0] needs a "model"');
    for (const bad of [3, null, ["claude:sonnet-latest"], true]) {
      expect(
        messageOf(() => parseModelList([bad], "models.default")),
        JSON.stringify(bad),
      ).toBe(
        'models.default[0] must be a model name or {"model": "<name>", "effort": "<level>"}',
      );
    }
    expect(
      messageOf(() =>
        parseModelList(
          [{ model: "claude:sonnet-latest", effort: 3 }],
          "models.default",
        ),
      ),
    ).toBe("models.default[0]: effort must be a string");
  });

  test("a bad model inside an object entry names its position", () => {
    expect(
      messageOf(() =>
        parseModelList(
          ["claude:sonnet-latest", { model: "claude:opus", effort: "high" }],
          "models.default",
        ),
      ),
    ).toStartWith('models.default[1]: "claude:opus" is not a model name');
  });

  test("the same model twice is refused, even with different efforts (D2)", () => {
    for (const list of [
      [
        { model: "claude:opus-latest", effort: "high" },
        { model: "claude:opus-latest", effort: "max" },
      ],
      [
        "opencode:openai/gpt-5",
        { model: "opencode:openai/gpt-5", effort: "high" },
      ],
    ]) {
      const name = modelEntry(list[0]).name;
      expect(
        messageOf(() => parseModelList(list, "models.default")),
        JSON.stringify(list),
      ).toBe(`models.default lists "${name}" twice`);
    }
  });

  test("models.judge takes no effort (D3)", () => {
    expect(
      messageOf(() =>
        parseModelsConfig({
          judge: [{ model: "claude:sonnet-latest", effort: "high" }],
        }),
      ),
    ).toBe(
      "models.judge[0] sets an effort: the materiality judge runs at the effort it was measured at, so models.judge takes model names only",
    );
    // An object entry without effort is still a model name.
    expect(
      parseModelsConfig({ judge: [{ model: "claude:opus-latest" }] }),
    ).toEqual({ judge: [{ model: "claude:opus-latest" }] });
    expect(
      judgeModelChoice({ judge: [{ model: "claude:opus-latest" }] }),
    ).toEqual({ model: "claude:opus-latest", dropped: [] });
  });

  test("an OpenCode model in an object entry needs the SDK", () => {
    expect(
      modelsNeedOpenCode({
        default: ["claude:sonnet-latest"],
        refuter: [{ model: "opencode:openai/gpt-5", effort: "high" }],
      }),
    ).toBe(true);
    expect(
      modelsNeedOpenCode({
        default: [{ model: "claude:sonnet-latest", effort: "high" }],
      }),
    ).toBe(false);
  });
});

describe("#variant is refused everywhere a model is written (S7)", () => {
  test("in the model name grammar, with the {model, effort} hint", () => {
    expect(() => parseModelName("opencode:openai/gpt-5#high")).toThrow(
      new ModelNameError(VARIANT_HINT),
    );
  });

  test("in models, naming the role and position", () => {
    expect(
      messageOf(() =>
        parseModelsConfig({ "hunter.logic": ["opencode:openai/gpt-5#high"] }),
      ),
    ).toBe(`models.hunter.logic[0]: ${VARIANT_HINT}`);
  });

  test("in --model (the CI model input becomes --model)", () => {
    const run = () =>
      resolveStepRoute({
        stepKey: "hunter-logic",
        role: "hunter",
        cliModel: "opencode:openai/gpt-5#high",
      });
    expect(run).toThrow(InvalidModelError);
    expect(messageOf(run)).toBe(`--model: ${VARIANT_HINT}`);
  });

  test("in a review spec's model", () => {
    expect(() =>
      validateReviewSpec({
        agents: [
          {
            key: "reliability",
            file: "deep-review-reliability.md",
            role: "hunter",
            model: "opencode:openai/gpt-5#high",
          },
          { key: "refuter", file: "review-refuter.md", role: "refuter" },
        ],
      }),
    ).toThrow(ReviewSpecValidationError);
  });

  test("on a Claude name too", () => {
    expect(messageOf(() => parseModelName("claude:opus-latest#max"))).toBe(
      '"claude:opus-latest#max": the #variant suffix is gone: write {"model": "claude:opus-latest", "effort": "max"} in models',
    );
  });
});

describe("an OpenCode entry's effort is the route's variant", () => {
  test("it reaches route.modelVariant and changes the fingerprint", () => {
    const step = (effort?: string) =>
      resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        modelRole: "refuter",
        models: {
          refuter: [
            effort === undefined
              ? "opencode:openai/gpt-5"
              : { model: "opencode:openai/gpt-5", effort },
          ],
        },
      });
    expect(step("high").route).toEqual({
      backend: "opencode",
      provider: "openai",
      modelFamily: "gpt-5",
      modelSnapshot: "gpt-5",
      modelVariant: "high",
    });
    expect(step("high").logicalIdentity).toBe("opencode:openai/gpt-5");
    // D1: no entry effort sends no variant.
    expect(step().route).not.toHaveProperty("modelVariant");
    expect(step("high").routeFingerprint).not.toBe(step().routeFingerprint);
  });

  test("a fallback carries its own entry's variant", () => {
    const step = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      modelRole: "hunter.logic",
      models: {
        "hunter.logic": [
          { model: "opencode:openai/gpt-5", effort: "high" },
          { model: "opencode:deepseek/deepseek-chat", effort: "max" },
          "opencode:openai/gpt-5-mini",
        ],
      },
    });
    expect(step.route.modelVariant).toBe("high");
    expect(step.fallbacks?.map((f) => f.route.modelVariant)).toEqual([
      "max",
      undefined,
    ]);
  });

  // A Claude entry's effort rides the plan step (`effort`), where the pipeline
  // reads it for `--effort`. It stays off the route and its fingerprint (a
  // launch flag, not a binding), but the plan's fingerprint includes it, so
  // two runs that differ only in effort never share one (Juanma, L38).
  test("a Claude entry's effort rides the plan step and its fingerprint, not the route", () => {
    const agents = [
      { key: "reliability", role: "hunter", model: undefined },
      { key: "refuter", role: "refuter" },
    ];
    const frontmatterModel = () => "sonnet";
    const plain = buildResolvedRoutePlan({
      agents,
      frontmatterModel,
      models: { default: ["claude:opus-latest"] },
    });
    const withEffort = buildResolvedRoutePlan({
      agents,
      frontmatterModel,
      models: { default: [{ model: "claude:opus-latest", effort: "max" }] },
    });
    expect(withEffort.routeFingerprint).not.toBe(plain.routeFingerprint);
    const lower = buildResolvedRoutePlan({
      agents,
      frontmatterModel,
      models: { default: [{ model: "claude:opus-latest", effort: "low" }] },
    });
    expect(lower.routeFingerprint).not.toBe(withEffort.routeFingerprint);
    // An entry without an effort keeps the plan it always had.
    const bare = buildResolvedRoutePlan({
      agents,
      frontmatterModel,
      models: { default: [{ model: "claude:opus-latest" }] },
    });
    expect(bare.routeFingerprint).toBe(plain.routeFingerprint);
    expect(withEffort.steps.map((s) => s.route)).toEqual(
      plain.steps.map((s) => s.route),
    );
    expect(withEffort.steps.map((s) => s.routeFingerprint)).toEqual(
      plain.steps.map((s) => s.routeFingerprint),
    );
    expect(withEffort.steps.map((s) => s.effort)).toEqual(["max", "max"]);
    expect(plain.steps.every((s) => !("effort" in s))).toBe(true);
  });

  test("each fallback step carries its own entry's effort", () => {
    const step = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      modelRole: "hunter.logic",
      models: {
        "hunter.logic": [
          { model: "claude:opus-latest", effort: "max" },
          "claude:sonnet-latest",
          { model: "opencode:openai/gpt-5", effort: "high" },
        ],
      },
    });
    expect(step.effort).toBe("max");
    expect(step.fallbacks?.map((f) => f.effort)).toEqual([undefined, "high"]);
  });

  test("--model carries no entry effort", () => {
    const step = resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      modelRole: "hunter.logic",
      cliModel: "sonnet",
      models: {
        "hunter.logic": [{ model: "claude:opus-latest", effort: "max" }],
      },
    });
    expect(step).not.toHaveProperty("effort");
  });
});

describe("the plan fingerprint and fallback efforts", () => {
  test("a fallback's effort changes the plan fingerprint too", () => {
    const agents = [{ key: "logic", role: "hunter", model: undefined }];
    const frontmatterModel = () => "sonnet";
    const plan = (effort?: string) =>
      buildResolvedRoutePlan({
        agents,
        frontmatterModel,
        models: {
          "hunter.logic": [
            "claude:opus-latest",
            effort === undefined
              ? "claude:sonnet-latest"
              : { model: "claude:sonnet-latest", effort },
          ],
        },
      }).routeFingerprint;
    expect(plan("low")).not.toBe(plan());
    expect(plan("low")).not.toBe(plan("high"));
  });
});
