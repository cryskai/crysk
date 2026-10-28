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
      chosen: { level: true, maxChangedLines: true, mode: true, billing: true },
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

  test("advanced: every answer is written, the default ones included", async () => {
    const { prompter } = scripted([
      "balanced",
      "gate",
      "subscription",
      "0", // no line limit, said explicitly
      "y",
      "", // blocking weight: Enter takes the default 2, still written
      "0", // advisory weight 0: rejected, re-asked
      "3",
      "n", // observe only: an explicit no is written as false
      "bot-a, bot-b",
      "40",
      "dist/**, !", // a bare ! is not a pattern: re-asked
      "dist/**, *.lock",
    ]);
    const c = await askChoices(prompter, () => {});
    expect(c.advanced).toEqual({
      ci_blocking_weight: 2,
      ci_advisory_weight: 3,
      ci_admission_observe_only: false,
      ci_trusted_actors: ["bot-a", "bot-b"],
      max_changed_files: 40,
      ignorePatterns: ["dist/**", "*.lock"],
    });
  });

  test("a re-run starts from the repository: Enter keeps a tuned config and workflow", async () => {
    const asked: { q: string; def: string }[] = [];
    const enter: SetupPrompter = {
      choose: async (q, options, def) => {
        asked.push({
          q,
          def: `${def} of ${options.map((o) => o.value).join("|")}`,
        });
        return def;
      },
      confirm: async (_q, def) => def,
      text: async (q, def) => {
        asked.push({ q, def });
        return "";
      },
    };
    const c = await askChoices(enter, () => {}, {
      config: {
        ci_review_policy: "every_push",
        ci_max_attempts: 5,
        max_changed_lines: 9000,
      },
      workflow: { mode: "advisory", budgetUsd: "7" },
    });
    expect(asked[0]?.def).toContain(
      "keep of minimal|balanced|thorough|manual|keep",
    );
    expect(c.chosen.level).toBe(false);
    expect(c.mode).toBe("advisory");
    expect(c.billing).toBe("api");
    expect(c.budgetUsd).toBe(7);
    expect(c.maxChangedLines).toBe(9000);
  });

  test("a config that spells a preset defaults to that preset", async () => {
    let levelDefault = "";
    const enter: SetupPrompter = {
      choose: async (q, _o, def) => {
        if (q === "Re-review level") levelDefault = String(def);
        return def;
      },
      confirm: async (_q, def) => def,
      text: async () => "",
    };
    await askChoices(enter, () => {}, {
      config: {
        ci_review_policy: "once_per_pr",
        ci_max_attempts: 1,
        max_verification_steps: 8,
      },
      workflow: {},
    });
    expect(levelDefault).toBe("minimal");
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
      chosen: {
        level: false,
        maxChangedLines: false,
        mode: false,
        billing: true,
      },
    });
  });

  test("--max-changed-lines alone is a choice too, and marks only that key chosen", () => {
    const c = choicesFromFlags({ maxChangedLines: 1500 });
    expect(c?.maxChangedLines).toBe(1500);
    expect(c?.chosen).toEqual({
      level: false,
      maxChangedLines: true,
      mode: false,
      billing: false,
    });
  });

  test("--level marks the level chosen", () => {
    expect(choicesFromFlags({ reviewLevel: "manual" })?.chosen).toEqual({
      level: true,
      maxChangedLines: false,
      mode: false,
      billing: false,
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
