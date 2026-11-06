import { describe, expect, test } from "bun:test";
import {
  isModelRole,
  ModelNameError,
  modelNameFromAlias,
  parseModelList,
  parseModelName,
  parseModelsConfig,
} from "#model/model-name";

describe("parseModelName: claude names (S3)", () => {
  test("the four -latest names follow the CLI alias of the same family", () => {
    for (const alias of ["sonnet", "opus", "haiku", "fable"] as const) {
      const parsed = parseModelName(`claude:${alias}-latest`);
      expect(parsed).toEqual({
        raw: `claude:${alias}-latest`,
        backend: "claude-code",
        provider: "anthropic",
        model: alias,
        alias,
      });
    }
  });

  test("a full claude-* id pins that version and is sent as is", () => {
    for (const id of [
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
      "claude-sonnet-4.5-20250929",
    ]) {
      expect(parseModelName(`claude:${id}`)).toEqual({
        raw: `claude:${id}`,
        backend: "claude-code",
        provider: "anthropic",
        model: id,
      });
    }
  });

  test("a bare claude:sonnet is refused with the -latest hint", () => {
    for (const alias of ["sonnet", "opus", "haiku", "fable"]) {
      expect(() => parseModelName(`claude:${alias}`)).toThrow(
        new ModelNameError(
          `"claude:${alias}" is not a model name: write "claude:${alias}-latest" for the newest ${alias}, or a full name such as "claude-${alias}-5-5" to pin a version`,
        ),
      );
    }
  });

  test("any other claude name is refused and the valid forms are listed", () => {
    for (const bad of [
      "claude:",
      "claude:gpt-5",
      "claude:Claude-Sonnet",
      "claude:sonnet-newest",
      "claude:claude-",
      "claude:claude-sonnet 5",
    ]) {
      expect(() => parseModelName(bad), bad).toThrow(ModelNameError);
      expect(() => parseModelName(bad), bad).toThrow(
        "claude:sonnet-latest, claude:opus-latest, claude:haiku-latest, claude:fable-latest or a full claude-* model name",
      );
    }
  });
});

describe("parseModelName: opencode names (S3)", () => {
  test("provider/model reaches OpenCode as provider and model", () => {
    expect(parseModelName("opencode:openai/gpt-5")).toEqual({
      raw: "opencode:openai/gpt-5",
      backend: "opencode",
      provider: "openai",
      model: "gpt-5",
    });
  });

  test("#variant is carried apart from the model", () => {
    expect(parseModelName("opencode:openai/gpt-5.1-codex#high")).toEqual({
      raw: "opencode:openai/gpt-5.1-codex#high",
      backend: "opencode",
      provider: "openai",
      model: "gpt-5.1-codex",
      variant: "high",
    });
  });

  test("a model id may itself hold a slash (provider is up to the first one)", () => {
    expect(
      parseModelName("opencode:openrouter/anthropic/claude-sonnet-4.5"),
    ).toEqual({
      raw: "opencode:openrouter/anthropic/claude-sonnet-4.5",
      backend: "opencode",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
    });
  });

  test("malformed opencode names are refused with the form to write", () => {
    for (const bad of [
      "opencode:",
      "opencode:openai",
      "opencode:openai/",
      "opencode:/gpt-5",
      "opencode:openai/gpt-5#",
      "opencode:openai/gpt 5",
    ]) {
      expect(() => parseModelName(bad), bad).toThrow(
        "opencode:<provider>/<model>[#variant]",
      );
    }
  });
});

describe("parseModelName: everything else", () => {
  test("a bare alias is refused with the claude:<alias>-latest hint", () => {
    expect(() => parseModelName("sonnet")).toThrow(
      new ModelNameError(
        `"sonnet" is not a model name: write "claude:sonnet-latest"`,
      ),
    );
  });

  test("an unprefixed name says which two forms exist", () => {
    for (const bad of ["openai/gpt-5", "gpt-5", "anthropic/sonnet", ""]) {
      expect(() => parseModelName(bad), bad).toThrow(
        'a model is "claude:<name>" or "opencode:<provider>/<model>[#variant]"',
      );
    }
  });

  test("a non-string is refused", () => {
    expect(() => parseModelName(42 as unknown as string)).toThrow(
      ModelNameError,
    );
  });

  test("a name that looks like a secret is refused without echoing it", () => {
    const secret = "opencode:openai/sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
    let message = "";
    try {
      parseModelName(`claude:${secret}`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA");
  });
});

describe("modelNameFromAlias: the one conversion point for internal aliases", () => {
  test("a bare prompt alias becomes claude:<alias>-latest", () => {
    for (const alias of ["sonnet", "opus", "haiku", "fable"]) {
      expect(modelNameFromAlias(alias).raw).toBe(`claude:${alias}-latest`);
    }
  });

  test("a full model name passes through unchanged", () => {
    expect(modelNameFromAlias("opencode:openai/gpt-5").raw).toBe(
      "opencode:openai/gpt-5",
    );
    expect(modelNameFromAlias("claude:claude-opus-5-5").raw).toBe(
      "claude:claude-opus-5-5",
    );
  });

  test("anything else is refused like a configured name", () => {
    expect(() => modelNameFromAlias("openai/gpt-5")).toThrow(ModelNameError);
  });
});

describe("roles (S1)", () => {
  test("the fixed roles and any hunter.<key> are roles", () => {
    for (const role of [
      "default",
      "consolidate",
      "scout",
      "judge",
      "refuter",
      "summary",
      "hunter.lifecycle",
      "hunter.logic",
      "hunter.parity",
      "hunter.reliability",
      "hunter.resilience",
      "hunter.security",
      "hunter.my-hunter-2",
    ]) {
      expect(isModelRole(role), role).toBe(true);
    }
  });

  test("anything else is not a role", () => {
    for (const bad of [
      "hunter",
      "hunter.",
      "hunter.Logic",
      "hunter.a.b",
      "hunters.logic",
      "verifier",
      "adjudicator",
      "summarizer",
      "sonnet",
    ]) {
      expect(isModelRole(bad), bad).toBe(false);
    }
  });
});

describe("parseModelList: list rules", () => {
  test("a list of one to three distinct names is kept in order", () => {
    expect(
      parseModelList(
        ["claude:sonnet-latest", "opencode:openai/gpt-5", "claude:opus-latest"],
        "models.default",
      ),
    ).toEqual([
      "claude:sonnet-latest",
      "opencode:openai/gpt-5",
      "claude:opus-latest",
    ]);
  });

  test("an empty list is refused", () => {
    expect(() => parseModelList([], "models.scout")).toThrow(
      "models.scout must list at least one model",
    );
  });

  test("more than three models are refused", () => {
    expect(() =>
      parseModelList(
        [
          "claude:sonnet-latest",
          "claude:opus-latest",
          "claude:haiku-latest",
          "claude:fable-latest",
        ],
        "models.default",
      ),
    ).toThrow("models.default lists 4 models: at most 3 are allowed");
  });

  test("a repeated model is refused", () => {
    expect(() =>
      parseModelList(
        ["claude:sonnet-latest", "claude:sonnet-latest"],
        "models.judge",
      ),
    ).toThrow('models.judge lists "claude:sonnet-latest" twice');
  });

  test("a string instead of a list is refused", () => {
    expect(() =>
      parseModelList("claude:sonnet-latest", "models.default"),
    ).toThrow("models.default must be a list of models");
  });

  test("a bad name inside the list names its position", () => {
    expect(() =>
      parseModelList(["claude:sonnet-latest", "claude:opus"], "models.default"),
    ).toThrow('models.default[1]: "claude:opus" is not a model name');
  });
});

describe("parseModelsConfig: the models object", () => {
  test("roles map to their lists", () => {
    expect(
      parseModelsConfig({
        default: ["claude:sonnet-latest"],
        "hunter.logic": ["opencode:openai/gpt-5#high", "claude:opus-latest"],
        summary: ["claude:haiku-latest"],
      }),
    ).toEqual({
      default: ["claude:sonnet-latest"],
      "hunter.logic": ["opencode:openai/gpt-5#high", "claude:opus-latest"],
      summary: ["claude:haiku-latest"],
    });
  });

  test("an unknown role is refused and the roles are listed", () => {
    expect(() =>
      parseModelsConfig({ summarizer: ["claude:haiku-latest"] }),
    ).toThrow(
      'models has an unknown role "summarizer": roles are default, hunter.<key>, consolidate, scout, judge, refuter, summary',
    );
  });

  test("a non-object is refused", () => {
    for (const bad of [[], "claude:sonnet-latest", null, 3]) {
      expect(() => parseModelsConfig(bad), JSON.stringify(bad)).toThrow(
        "models must be an object from role to a list of models",
      );
    }
  });

  test("an empty object is allowed and means every role keeps its default", () => {
    expect(parseModelsConfig({})).toEqual({});
  });
});
