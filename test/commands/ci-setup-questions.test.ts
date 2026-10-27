import { describe, expect, test } from "bun:test";
import {
  askChoices,
  choicesFromFlags,
  type SetupPrompter,
} from "#commands/ci-setup-questions";

// Answers are consumed in order; `choose` takes the option value, `confirm`
// "y"/"n", `text` the raw string ("" = default).
function scripted(answers: string[]): {
  prompter: SetupPrompter;
  asked: string[];
} {
  const asked: string[] = [];
  const next = (q: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new Error(`no scripted answer for: ${q}`);
    return a;
  };
  return {
    asked,
    prompter: {
      choose: async (q, options, def) => {
        const a = next(q);
        return (
          a === "" ? def : options.find((o) => o.value === a)?.value
        ) as never;
      },
      confirm: async (q, def) => {
        const a = next(q);
        return a === "" ? def : a === "y";
      },
      text: async (q) => next(q),
    },
  };
}

describe("askChoices", () => {
  test("subscription: no budget question, explains why, skips advanced", async () => {
    const lines: string[] = [];
    const { prompter, asked } = scripted([
      "thorough",
      "advisory",
      "subscription",
      "", // max changed lines: default 4000
      "n",
    ]);
    const c = await askChoices(prompter, (l = "") => lines.push(l));
    expect(c).toEqual({
      level: "thorough",
      mode: "advisory",
      billing: "subscription",
      maxChangedLines: 4000,
      advanced: {},
      defaulted: false,
      chosen: { level: true, maxChangedLines: true },
    });
    expect(asked.some((q) => /changed lines/i.test(q))).toBe(true);
    expect(asked.some((q) => /ceiling/i.test(q))).toBe(false);
    expect(lines.join("\n")).toContain("ANTHROPIC_API_KEY");
    expect(lines.join("\n")).not.toContain("budget-usd: 0");
    // The advanced settings are named up front even when skipped.
    expect(lines.join("\n")).toContain("trusted actors");
  });

  test("api: asks the ceiling, re-asks on a non-number, empty takes $10", async () => {
    const { prompter } = scripted(["", "", "api", "lots", "7.5", "2000", "n"]);
    const c = await askChoices(prompter, () => {});
    expect(c.billing).toBe("api");
    expect(c.budgetUsd).toBe(7.5);
    expect(c.level).toBe("balanced");
    expect(c.mode).toBe("gate");
    expect(c.maxChangedLines).toBe(2000);

    const { prompter: p2 } = scripted(["", "", "api", "", "", "n"]);
    expect((await askChoices(p2, () => {})).budgetUsd).toBe(10);
  });

  test("advanced: writes only what differs from the defaults", async () => {
    const { prompter } = scripted([
      "balanced",
      "gate",
      "subscription",
      "0", // no line limit, said explicitly
      "y",
      "", // blocking weight: default 2
      "0", // advisory weight 0: rejected, re-asked
      "3",
      "y", // observe only
      "bot-a, bot-b",
      "40",
      "dist/**, !", // a bare ! is not a pattern: re-asked
      "dist/**, *.lock",
    ]);
    const c = await askChoices(prompter, () => {});
    expect(c.advanced).toEqual({
      ci_advisory_weight: 3,
      ci_admission_observe_only: true,
      ci_trusted_actors: ["bot-a", "bot-b"],
      max_changed_files: 40,
      ignorePatterns: ["dist/**", "*.lock"],
    });
  });
});

describe("choicesFromFlags", () => {
  test("no flags: undefined, so setup asks or defaults", () => {
    expect(choicesFromFlags({})).toBeUndefined();
  });

  test("any flag is a choice; the rest fall back to balanced and gate", () => {
    expect(choicesFromFlags({ billing: "subscription" })).toEqual({
      level: "balanced",
      mode: "gate",
      billing: "subscription",
      maxChangedLines: 4000,
      advanced: {},
      defaulted: false,
      chosen: { level: false, maxChangedLines: false },
    });
  });

  test("--max-changed-lines alone is a choice too, and marks only that key chosen", () => {
    const c = choicesFromFlags({ maxChangedLines: 1500 });
    expect(c?.maxChangedLines).toBe(1500);
    expect(c?.chosen).toEqual({ level: false, maxChangedLines: true });
  });

  test("--level marks the level chosen", () => {
    expect(choicesFromFlags({ reviewLevel: "manual" })?.chosen).toEqual({
      level: true,
      maxChangedLines: false,
    });
  });

  test("--max-changed-files is written, not dropped", () => {
    expect(
      choicesFromFlags({ maxChangedFiles: 30 })?.advanced.max_changed_files,
    ).toBe(30);
  });

  test("--budget-usd alone implies an API key", () => {
    expect(choicesFromFlags({ budgetUsd: 5 })?.billing).toBe("api");
  });
});
