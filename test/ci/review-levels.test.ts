import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  budgetInput,
  type CiSetupChoices,
  configPatch,
  defaultChoices,
  REVIEW_LEVELS,
  renderChoicesSummary,
} from "#ci/review-levels";
import { appendIgnorePatterns, writeRepoReviewConfig } from "#ci/setup";
import { parseLocalConfig } from "#review/preflight";

function choices(over: Partial<CiSetupChoices> = {}): CiSetupChoices {
  return { ...defaultChoices(), defaulted: false, ...over };
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
  test("subscription writes an explicit 0", () => {
    expect(budgetInput(choices({ billing: "subscription" }))).toBe("0");
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

describe("configPatch", () => {
  test("carries the level's keys and only the advanced keys that were set", () => {
    expect(
      configPatch(
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
      ci_review_policy: "every_push",
      ci_max_attempts: 4,
      max_verification_steps: 8,
      max_changed_lines: 4000,
      ci_blocking_weight: 3,
      ci_trusted_actors: ["bot"],
    });
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
    expect(text).toContain("budget-usd: 0");
    expect(text).toContain("observe only     yes");
    expect(text).toContain("gen/**");
    expect(text).toContain("npx -y pr-hero config");
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

  test("creates the file when absent", async () => {
    await withRepo(async (dir) => {
      const file = await writeRepoReviewConfig(dir, { ci_max_attempts: 1 });
      expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({
        ci_max_attempts: 1,
      });
    });
  });

  test("keeps the keys already there and overrides the ones it sets", async () => {
    await withRepo(async (dir) => {
      await mkdir(path.join(dir, ".prhero"));
      const file = path.join(dir, ".prhero", "config.json");
      await writeFile(file, JSON.stringify({ post: true, ci_max_attempts: 9 }));
      await writeRepoReviewConfig(dir, { ci_max_attempts: 2 });
      expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({
        post: true,
        ci_max_attempts: 2,
      });
    });
  });

  test("refuses invalid JSON and leaves the file as it was", async () => {
    await withRepo(async (dir) => {
      await mkdir(path.join(dir, ".prhero"));
      const file = path.join(dir, ".prhero", "config.json");
      await writeFile(file, "{ not json");
      await expect(
        writeRepoReviewConfig(dir, { ci_max_attempts: 2 }),
      ).rejects.toThrow(/not valid JSON/);
      expect(await readFile(file, "utf-8")).toBe("{ not json");
    });
  });

  test("refuses a value the review parser rejects, writing nothing", async () => {
    await withRepo(async (dir) => {
      await expect(
        writeRepoReviewConfig(dir, { ci_blocking_weight: 0 }),
      ).rejects.toThrow(/ci_blocking_weight/);
      expect(existsSync(path.join(dir, ".prhero", "config.json"))).toBe(false);
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
