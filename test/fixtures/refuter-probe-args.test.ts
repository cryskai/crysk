// The refuter probe's model choices (route-plan-harness S6): opus refuter and
// haiku hunter unless a flag or env names another model.
import { describe, expect, test } from "bun:test";
import { parseRefuterProbeArgs } from "../../fixtures/refuter-probe";

describe("parseRefuterProbeArgs", () => {
  test("defaults: 3 replicates, opus refuter, haiku hunter", () => {
    expect(parseRefuterProbeArgs([])).toEqual({
      replicates: 3,
      refuterModel: "opus",
      hunterModel: "haiku",
    });
  });

  test("the positional replicates keep working beside the flags", () => {
    expect(
      parseRefuterProbeArgs(["--refuter-model", "opencode:openai/gpt-5", "2"]),
    ).toEqual({
      replicates: 2,
      refuterModel: "opencode:openai/gpt-5",
      hunterModel: "haiku",
    });
  });

  test("the env picks a model when no flag does; a flag outranks it", () => {
    const env = {
      REFUTER_PROBE_REFUTER_MODEL: "sonnet",
      REFUTER_PROBE_HUNTER_MODEL: "sonnet",
    };
    expect(parseRefuterProbeArgs([], env)).toMatchObject({
      refuterModel: "sonnet",
      hunterModel: "sonnet",
    });
    expect(
      parseRefuterProbeArgs(["--hunter-model", "haiku"], env).hunterModel,
    ).toBe("haiku");
  });

  test("a flag with no model, or a bad replicate count, is refused", () => {
    expect(() => parseRefuterProbeArgs(["--refuter-model"])).toThrow();
    expect(() => parseRefuterProbeArgs(["0"])).toThrow();
  });
});
