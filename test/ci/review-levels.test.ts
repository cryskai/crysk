import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  budgetInput,
  type CiSetupChoices,
  configPlan,
  defaultChoices,
  parseWorkflowChoices,
  presetMatching,
  REVIEW_LEVELS,
  renderChoicesSummary,
} from "#ci/review-levels";
import { appendIgnorePatterns, writeRepoReviewConfig } from "#ci/setup";
import { parseLocalConfig } from "#review/preflight";
import { CliError } from "../../src/errors";

function choices(over: Partial<CiSetupChoices> = {}): CiSetupChoices {
  return {
    ...defaultChoices(),
    defaulted: false,
    chosen: { level: true, maxChangedLines: true, mode: true, billing: true },
    ...over,
  };
}

describe("review level presets", () => {
  test("each preset sets the agreed keys", () => {
    expect(REVIEW_LEVELS.minimal.config).toEqual({
      ci_review_policy: "once_per_pr",
      ci_max_attempts: 1,
      max_verification_steps: 8,
    });
    expect(REVIEW_LEVELS.balanced.config).toEqual({
      ci_review_policy: "risk_aware",
      ci_max_attempts: 2,
      ci_rereview_min_score: 4,
      max_verification_steps: 8,
    });
    expect(REVIEW_LEVELS.thorough.config).toEqual({
      ci_review_policy: "every_push",
      ci_max_attempts: 4,
      max_verification_steps: 8,
    });
    expect(REVIEW_LEVELS.manual.config).toEqual({
      ci_review_policy: "manual_only",
      ci_max_attempts: 1,
      max_verification_steps: 8,
    });
  });

  test("every preset's keys pass the repo config parser a review uses", () => {
    for (const preset of Object.values(REVIEW_LEVELS)) {
      expect(() =>
        parseLocalConfig(JSON.stringify(preset.config)),
      ).not.toThrow();
    }
  });

  test("the default is balanced, gate, no billing, and marked as nobody's choice", () => {
    const d = defaultChoices();
    expect(d.level).toBe("balanced");
    expect(d.mode).toBe("gate");
    expect(d.billing).toBeUndefined();
    expect(d.maxChangedLines).toBe(4000);
    expect(d.defaulted).toBe(true);
  });
});

describe("budgetInput", () => {
  // A subscription-only repo already resolves to no ceiling; an explicit 0
  // would warn on every run and outlive a later ANTHROPIC_API_KEY.
  test("subscription writes nothing", () => {
    expect(budgetInput(choices({ billing: "subscription" }))).toBeUndefined();
  });
  test("an API key with a 0 ceiling writes 0", () => {
    expect(budgetInput(choices({ billing: "api", budgetUsd: 0 }))).toBe("0");
  });
  test("api writes the chosen ceiling, or the $10 default", () => {
    expect(budgetInput(choices({ billing: "api", budgetUsd: 7.5 }))).toBe(
      "7.5",
    );
    expect(budgetInput(choices({ billing: "api" }))).toBe("10");
  });
  test("no billing writes nothing", () => {
    expect(budgetInput(choices())).toBeUndefined();
  });
});

describe("configPlan", () => {
  test("chosen keys are set; nothing is kept back", () => {
    expect(
      configPlan(
        choices({
          level: "thorough",
          advanced: {
            ci_blocking_weight: 3,
            ci_trusted_actors: ["bot"],
            ignorePatterns: ["dist/**"],
          },
        }),
      ),
    ).toEqual({
      set: {
        ci_review_policy: "every_push",
        ci_max_attempts: 4,
        max_verification_steps: 8,
        max_changed_lines: 4000,
        ci_blocking_weight: 3,
        ci_trusted_actors: ["bot"],
      },
      fillIfAbsent: [{ post_min_severity: "warning" }],
      remove: ["ci_rereview_min_score", "ci_max_reviews"],
    });
  });

  test("keys nobody chose only fill a group the file does not have yet", () => {
    expect(configPlan(defaultChoices())).toEqual({
      set: {},
      fillIfAbsent: [
        {
          ci_review_policy: "risk_aware",
          ci_max_attempts: 2,
          ci_rereview_min_score: 4,
          max_verification_steps: 8,
        },
        { max_changed_lines: 4000 },
        { post_min_severity: "warning" },
      ],
      remove: [],
    });
  });
});

describe("renderChoicesSummary posting line", () => {
  const posting = (effective: Record<string, unknown>) =>
    renderChoicesSummary(defaultChoices(), {}, effective).find((line) =>
      line.startsWith("  posting"),
    );

  test("reports the floor as written to the file", () => {
    expect(posting({ post_min_severity: "warning" })).toBe(
      "  posting          every finding except advisory suggestions, which are counted in the summary (post_min_severity)",
    );
    expect(posting({ post_min_severity: "blocking" })).toBe(
      "  posting          blocking findings only; advisory ones are counted in the summary (post_min_severity)",
    );
    expect(posting({})).toBe(
      "  posting          every finding (post_min_severity unset)",
    );
  });
});

describe("renderChoicesSummary", () => {
  test("a defaulted run says nobody chose and how to choose", () => {
    const text = renderChoicesSummary(defaultChoices()).join("\n");
    expect(text).toContain("defaults: nobody chose them");
    expect(text).toContain("--level");
    expect(text).toContain("size limit       4000 changed lines");
    expect(text).toContain(
      "risk_aware, at most 2 automatic passes per PR, score floor 4",
    );
  });

  test("a chosen run names each choice and how to change it", () => {
    const text = renderChoicesSummary(
      choices({
        level: "minimal",
        mode: "advisory",
        billing: "subscription",
        advanced: {
          ci_admission_observe_only: true,
          ignorePatterns: ["gen/**"],
        },
      }),
    ).join("\n");
    expect(text).not.toContain("nobody chose");
    expect(text).toContain("once_per_pr, at most 1 automatic pass per PR");
    expect(text).toContain("advisory");
    expect(text).toContain(
      "not set: no ceiling while the repo has no ANTHROPIC_API_KEY or OPENCODE_AUTH_JSON",
    );
    expect(text).toContain("observe only     yes");
    expect(text).toContain("gen/**");
    expect(text).toContain("npx -y crysk config");
  });

  test("an API key with no ceiling is not described as a subscription", () => {
    const text = renderChoicesSummary(
      choices({ billing: "api", budgetUsd: 0 }),
    ).join("\n");
    expect(text).toContain("none (budget-usd: 0;");
    expect(text).not.toContain("subscription");
  });

  test("a kept group shows the file's values, not the preset nobody wrote", () => {
    const text = renderChoicesSummary(defaultChoices(), {
      ci_max_attempts: 5,
      max_changed_lines: 9000,
    }).join("\n");
    expect(text).toContain("kept the existing settings: ci_max_attempts 5");
    expect(text).not.toContain("risk_aware");
    expect(text).toContain("9000 changed lines (kept)");
  });

  test("carries no escape bytes", () => {
    expect(renderChoicesSummary(defaultChoices()).join("\n")).not.toContain(
      "\x1b",
    );
  });
});

describe("writeRepoReviewConfig", () => {
  async function withRepo(fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), "prhero-levels-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const file = (dir: string) => path.join(dir, ".prhero", "config.json");
  async function seed(dir: string, body: string) {
    await mkdir(path.join(dir, ".prhero"));
    await writeFile(file(dir), body);
  }

  test("creates the file when absent, filling every group", async () => {
    await withRepo(async (dir) => {
      const r = await writeRepoReviewConfig(dir, {
        set: { ci_blocking_weight: 3 },
        fillIfAbsent: [{ ci_max_attempts: 1 }, { max_changed_lines: 4000 }],
        remove: [],
      });
      expect(JSON.parse(await readFile(r.file, "utf-8"))).toEqual({
        ci_blocking_weight: 3,
        ci_max_attempts: 1,
        max_changed_lines: 4000,
      });
      expect(r.changed).toEqual([]);
      expect(r.kept).toEqual({});
    });
  });

  test("a group with any key already present is kept whole, never partly filled", async () => {
    await withRepo(async (dir) => {
      await seed(dir, JSON.stringify({ post: true, ci_max_attempts: 3 }));
      const r = await writeRepoReviewConfig(dir, {
        set: {},
        fillIfAbsent: [
          { ci_review_policy: "risk_aware", ci_max_attempts: 2 },
          { max_changed_lines: 4000 },
        ],
        remove: [],
      });
      expect(JSON.parse(await readFile(file(dir), "utf-8"))).toEqual({
        post: true,
        ci_max_attempts: 3,
        max_changed_lines: 4000,
      });
      expect(r.kept).toEqual({ ci_max_attempts: 3 });
    });
  });

  test("a chosen key overrides and is reported with its old value", async () => {
    await withRepo(async (dir) => {
      await seed(dir, JSON.stringify({ post: true, ci_max_attempts: 9 }));
      const r = await writeRepoReviewConfig(dir, {
        set: { ci_max_attempts: 2, ci_review_policy: "risk_aware" },
        fillIfAbsent: [],
        remove: [],
      });
      expect(JSON.parse(await readFile(file(dir), "utf-8"))).toEqual({
        post: true,
        ci_max_attempts: 2,
        ci_review_policy: "risk_aware",
      });
      expect(r.changed).toEqual([{ key: "ci_max_attempts", from: 9, to: 2 }]);
    });
  });

  test("refuses invalid JSON with a CLI error and leaves the file as it was", async () => {
    await withRepo(async (dir) => {
      await seed(dir, "{ not json");
      const attempt = writeRepoReviewConfig(dir, {
        set: { ci_max_attempts: 2 },
        fillIfAbsent: [],
        remove: [],
      });
      await expect(attempt).rejects.toThrow(/not valid JSON/);
      await expect(attempt).rejects.toBeInstanceOf(CliError);
      expect(await readFile(file(dir), "utf-8")).toBe("{ not json");
    });
  });

  test("refuses a value the review parser rejects, writing nothing", async () => {
    await withRepo(async (dir) => {
      await expect(
        writeRepoReviewConfig(dir, {
          set: { ci_blocking_weight: 0 },
          fillIfAbsent: [],
          remove: [],
        }),
      ).rejects.toThrow(/ci_blocking_weight/);
      expect(existsSync(file(dir))).toBe(false);
    });
  });
});

describe("appendIgnorePatterns", () => {
  test("appends new patterns once, keeping what is there", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prhero-ignore-"));
    try {
      const file = path.join(dir, ".prheroignore");
      await writeFile(file, "dist/**");
      await appendIgnorePatterns(dir, ["dist/**", "gen/**", " "]);
      await appendIgnorePatterns(dir, ["gen/**"]);
      expect(await readFile(file, "utf-8")).toBe("dist/**\ngen/**\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("presetMatching", () => {
  test("no level keys: undefined", () => {
    expect(presetMatching({ post: true })).toBeUndefined();
  });
  test("exactly a preset's keys: that preset", () => {
    expect(presetMatching({ ...REVIEW_LEVELS.thorough.config })).toBe(
      "thorough",
    );
  });
  test("tuned keys that match no preset: custom", () => {
    expect(
      presetMatching({ ...REVIEW_LEVELS.balanced.config, ci_max_attempts: 5 }),
    ).toBe("custom");
  });
});

describe("parseWorkflowChoices", () => {
  test("reads the mode and the ceiling setup writes", () => {
    expect(
      parseWorkflowChoices(
        "        with:\n          budget-usd: 7.5\n          mode: advisory\n",
      ),
    ).toEqual({ mode: "advisory", budgetUsd: "7.5" });
  });
  test("a workflow without them reads as empty", () => {
    expect(parseWorkflowChoices("name: x\n")).toEqual({});
  });
});

describe("re-runs over a tuned file (PR #411 review)", () => {
  async function withFile(
    body: Record<string, unknown>,
    fn: (dir: string, file: string) => Promise<void>,
  ) {
    const dir = await mkdtemp(path.join(tmpdir(), "prhero-411-"));
    try {
      await mkdir(path.join(dir, ".prhero"));
      const file = path.join(dir, ".prhero", "config.json");
      await writeFile(file, JSON.stringify(body));
      await fn(dir, file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("switching balanced to minimal drops the orphan score floor, so the file reads as minimal again", async () => {
    await withFile({ ...REVIEW_LEVELS.balanced.config }, async (dir, file) => {
      const r = await writeRepoReviewConfig(
        dir,
        configPlan(choices({ level: "minimal" })),
      );
      const written = JSON.parse(await readFile(file, "utf-8"));
      expect(written.ci_rereview_min_score).toBeUndefined();
      expect(presetMatching(written)).toBe("minimal");
      expect(r.changed).toContainEqual({
        key: "ci_rereview_min_score",
        from: 4,
        to: undefined,
      });
    });
  });

  test("a legacy ci_max_reviews counts as a pass count already decided", async () => {
    await withFile({ ci_max_reviews: 5 }, async (dir, file) => {
      const r = await writeRepoReviewConfig(dir, configPlan(defaultChoices()));
      const written = JSON.parse(await readFile(file, "utf-8"));
      expect(written.ci_max_attempts).toBeUndefined();
      expect(written.ci_max_reviews).toBe(5);
      expect(r.kept).toEqual({ ci_max_reviews: 5 });
    });
  });

  test("the summary reports advanced values from the file as written", () => {
    const text = renderChoicesSummary(
      defaultChoices(),
      {},
      {
        ci_blocking_weight: 5,
        ci_admission_observe_only: true,
        max_changed_files: 30,
      },
    ).join("\n");
    expect(text).toContain("blocking 5");
    expect(text).toContain("observe only     yes");
    expect(text).toContain("30 files");
  });

  test("a negative ceiling reads as none, never as a negative price", () => {
    const text = renderChoicesSummary(
      choices({ billing: "api", budgetUsd: -5 }),
    ).join("\n");
    expect(text).toContain("none (budget-usd: -5;");
    expect(text).not.toContain("$-5");
  });
});

describe("parseWorkflowChoices on hand-edited workflows", () => {
  test("quotes and trailing comments still read", () => {
    expect(
      parseWorkflowChoices(
        "          mode: \"advisory\"  # report only\n          budget-usd: 7.5 # cap\n          max-changed-lines: 8000\n          max-changed-files: '30'\n",
      ),
    ).toEqual({
      mode: "advisory",
      budgetUsd: "7.5",
      maxChangedLines: "8000",
      maxChangedFiles: "30",
    });
  });
  test("a malformed number reads as absent, never as NaN", () => {
    expect(parseWorkflowChoices("          budget-usd: 1.2.3\n")).toEqual({});
  });
});
