// The general hunter replaced the product's four default hunters (logic,
// reliability, resilience, security): one prompt, `general`, measured at about
// a third of the four hunters' cost. Nothing a user already has stops working,
// because the platform sends stored profiles and `v0` floats: a
// `models.hunter.<old>` role and a leftover old prompt in a custom agents_dir
// are accepted, have no effect, and warn exactly once. The tail of every
// message is quoted by the changelog, so it is asserted verbatim. Modelled on
// test/parity-removal-compat.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPlatformPerson } from "#ci/platform-config";
import { loadEffectiveConfig } from "#config/config";
import { FALLBACK_PROFILE } from "#model/profiles";
import {
  buildResolvedRoutePlan,
  InvalidModelError,
  removedHunterRoles,
} from "#model/routing";
import {
  agentFilePath,
  agentsDirProblems,
  localReviewSpec,
} from "#review/preflight";
import { resolvePromptSet } from "#review/run";
import type { AgentSpec } from "#review/spec";
import { BUNDLED_AGENT_FILES } from "../src/asset-manifest";
import { CliError } from "../src/errors";

const TAIL =
  "is ignored: the general hunter replaced the logic, reliability, resilience and security hunters";
const PARITY_TAIL = "is ignored: the parity hunter was removed";
const RETIRED = ["logic", "reliability", "resilience", "security"] as const;
const RETIRED_FILES = RETIRED.map((key) => `deep-review-${key}.md`);
const AGENT = "---\nname: ok\nmodel: sonnet\n---\nbody\n";

describe("the bundled set and the product spec", () => {
  test("the product spec runs one hunter, general, and the refuter", () => {
    const spec = localReviewSpec({});
    expect(spec.agents).toEqual([
      { key: "general", file: "deep-review-general.md", role: "hunter" },
      { key: "refuter", file: "review-refuter.md", role: "refuter" },
    ]);
  });

  test("the bundle carries the general prompt and none of the four old ones", () => {
    expect(Object.keys(BUNDLED_AGENT_FILES).sort()).toEqual([
      "deep-review-general.md",
      "review-refuter.md",
    ]);
    for (const file of RETIRED_FILES) {
      expect(
        existsSync(
          path.join(import.meta.dir, "..", "prompts", "default", file),
        ),
      ).toBe(false);
    }
  });
});

describe("a models.hunter.<old> role", () => {
  let root: string;
  let home: string;
  let agentsDir: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "gen-role-"));
    home = path.join(root, "home");
    agentsDir = path.join(root, "agents");
    mkdirSync(path.join(home, ".crysk"), { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    for (const agent of localReviewSpec({}).agents) {
      writeFileSync(path.join(agentsDir, agent.file), AGENT);
    }
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function resolveWith(models: Record<string, string[]>) {
    writeFileSync(
      path.join(home, ".crysk", "config.json"),
      JSON.stringify({ models }),
    );
    const loaded = await loadEffectiveConfig({ root, home });
    const warnings: string[] = [];
    const result = await resolvePromptSet(
      { agents: agentsDir },
      loaded,
      { profile: FALLBACK_PROFILE },
      (line) => warnings.push(line),
    );
    return { loaded, warnings, result };
  }

  for (const key of RETIRED) {
    test(`hunter.${key} is skipped with no throw, one warning, and no step`, async () => {
      const { loaded, warnings, result } = await resolveWith({
        [`hunter.${key}`]: ["claude:opus-latest"],
      });
      expect(warnings).toEqual([`models.hunter.${key} ${TAIL}`]);
      const plan = buildResolvedRoutePlan({
        agents: result.spec.agents,
        models: loaded.effective.models,
        profile: FALLBACK_PROFILE,
        bundledAgents: true,
      });
      expect(plan.steps.map((s) => s.stepKey)).not.toContain(`hunter-${key}`);
      expect(plan.steps.map((s) => s.stepKey)).toContain("hunter-general");
    });
  }

  test("a stored profile with all four roles warns once per role and runs the general hunter on its own route", async () => {
    const { loaded, warnings, result } = await resolveWith({
      "hunter.logic": ["claude:sonnet-latest"],
      "hunter.reliability": ["claude:sonnet-latest"],
      "hunter.resilience": ["claude:sonnet-latest"],
      "hunter.security": ["claude:sonnet-latest"],
      "hunter.general": ["claude:opus-latest"],
    });
    expect(warnings).toEqual(
      RETIRED.map((key) => `models.hunter.${key} ${TAIL}`),
    );
    const plan = buildResolvedRoutePlan({
      agents: result.spec.agents,
      models: loaded.effective.models,
      profile: FALLBACK_PROFILE,
      bundledAgents: true,
    });
    const hunters = plan.steps.filter((s) => s.role === "hunter");
    expect(hunters.map((s) => s.stepKey)).toEqual(["hunter-general"]);
    expect(hunters[0]?.route.modelSnapshot).toContain("opus");
  });

  test("the parity role keeps its own message", async () => {
    const { warnings } = await resolveWith({
      "hunter.parity": ["claude:opus-latest"],
      "hunter.logic": ["claude:opus-latest"],
    });
    expect(warnings).toEqual([
      `models.hunter.parity ${PARITY_TAIL}`,
      `models.hunter.logic ${TAIL}`,
    ]);
  });

  test("a review with only hunter.general warns about nothing", async () => {
    const { warnings } = await resolveWith({
      "hunter.general": ["claude:opus-latest"],
    });
    expect(warnings).toEqual([]);
  });

  test("any other unknown hunter role still throws, naming the one hunter", () => {
    expect(() =>
      buildResolvedRoutePlan({
        agents: localReviewSpec({}).agents,
        models: {
          "hunter.logic": ["claude:opus-latest"],
          "hunter.nonesuch": ["claude:opus-latest"],
        },
      }),
    ).toThrow(InvalidModelError);
    expect(() =>
      buildResolvedRoutePlan({
        agents: localReviewSpec({}).agents,
        models: { "hunter.nonesuch": ["claude:opus-latest"] },
      }),
    ).toThrow(
      /^models\.hunter\.nonesuch names no hunter in this review: its hunters are general$/,
    );
  });

  test("a stored platform person with the old roles passes the platform's own check", () => {
    expect(() =>
      assertPlatformPerson(
        {
          models: {
            "hunter.logic": ["claude:sonnet-latest"],
            "hunter.security": ["claude:sonnet-latest"],
          },
        },
        "f",
      ),
    ).not.toThrow();
  });
});

describe("the four old prompts in a custom agents_dir", () => {
  let root: string;
  let agentsDir: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "gen-dir-"));
    agentsDir = path.join(root, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "review-refuter.md"), AGENT);
    for (const file of RETIRED_FILES) {
      writeFileSync(path.join(agentsDir, file), AGENT);
    }
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function resolve() {
    const loaded = await loadEffectiveConfig({ root, home: root });
    const warnings: string[] = [];
    const result = await resolvePromptSet(
      { agents: agentsDir },
      loaded,
      { profile: FALLBACK_PROFILE },
      (line) => warnings.push(line),
    );
    return { warnings, result };
  }

  test("beside a general prompt, the review runs, the old files are not used, and one warning each says so", async () => {
    writeFileSync(path.join(agentsDir, "deep-review-general.md"), AGENT);
    const { warnings, result } = await resolve();
    expect(warnings).toEqual(RETIRED_FILES.map((file) => `${file} ${TAIL}`));
    expect(result.spec.agents.map((a) => a.file)).toEqual([
      "deep-review-general.md",
      "review-refuter.md",
    ]);
    expect([...result.agentFiles.keys()].sort()).toEqual([
      "general",
      "refuter",
    ]);
  });

  // A set copied from the old default has no general prompt. Warn, never
  // error (S3): the general hunter runs the bundled prompt, every other agent
  // still reads the directory, and one warning says how to bring your own.
  test("without a general prompt, the general hunter runs the bundled one, with one warning and no error", async () => {
    const { warnings, result } = await resolve();
    expect(warnings).toEqual([
      `${agentsDir} has no deep-review-general.md: the general hunter runs ` +
        "the bundled prompt. To use your own, copy " +
        "prompts/default/deep-review-general.md from the crysk package into " +
        "that directory and edit it",
      ...RETIRED_FILES.map((file) => `${file} ${TAIL}`),
    ]);
    expect(result.spec.agents.map((a) => a.key)).toEqual([
      "general",
      "refuter",
    ]);
    expect(agentFilePath(result.agents, "deep-review-general.md")).toBe(
      BUNDLED_AGENT_FILES["deep-review-general.md"] as string,
    );
    expect(agentFilePath(result.agents, "review-refuter.md")).toBe(
      path.join(agentsDir, "review-refuter.md"),
    );
    // Parsed from where each one lives: the bundled general prompt, the
    // directory's own refuter.
    expect(result.agentFiles.get("general")?.name).toBe("crysk-general");
    expect(result.agentFiles.get("refuter")?.name).toBe("ok");
    // Still the user's set, named after its directory, not "default".
    expect(result.promptSet.name).toBe("agents");
  });

  test("a missing general prompt does not hide another unreferenced file", async () => {
    writeFileSync(path.join(agentsDir, "deep-review-extra.md"), "x");
    const error = await resolve().catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain("deep-review-extra.md");
    expect(message).not.toContain("deep-review-general.md");
  });

  test("a directory with its own general prompt uses it and prints no bundled-prompt warning", async () => {
    writeFileSync(path.join(agentsDir, "deep-review-general.md"), AGENT);
    const { warnings, result } = await resolve();
    expect(warnings.some((line) => line.includes("bundled prompt"))).toBe(
      false,
    );
    expect(agentFilePath(result.agents, "deep-review-general.md")).toBe(
      path.join(agentsDir, "deep-review-general.md"),
    );
    expect(result.agents.kind).toBe("dir");
  });

  test("an old file does not hide another unreferenced file", async () => {
    writeFileSync(path.join(agentsDir, "deep-review-general.md"), AGENT);
    writeFileSync(path.join(agentsDir, "deep-review-extra.md"), "x");
    const error = await resolve().catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain("deep-review-extra.md");
    for (const file of RETIRED_FILES) expect(message).not.toContain(file);
  });
});

// A user who wants an old hunter back keeps their own copy of its prompt in a
// custom agents_dir and names it with CRYSK_EXTRA_HUNTERS. The spec then
// carries the hunter, so its file and its `models` role are live again: no
// warning. The bundle no longer carries the prompt, so this needs the copy.
describe("an old hunter kept with CRYSK_EXTRA_HUNTERS and the user's own prompt", () => {
  const spec = localReviewSpec({
    CRYSK_EXTRA_HUNTERS: "logic:deep-review-logic.md",
  });
  const files = spec.agents.map((a) => a.file);

  test("the spec carries it beside the general hunter", () => {
    expect(spec.agents.map((a: AgentSpec) => a.key)).toEqual([
      "general",
      "logic",
      "refuter",
    ]);
  });

  test("its file is used, not ignored, and its role is live", () => {
    expect(agentsDirProblems(files, files)).toEqual([]);
    const models = { "hunter.logic": ["claude:opus-latest"] };
    expect(removedHunterRoles(models, spec.agents)).toEqual([]);
    const plan = buildResolvedRoutePlan({
      agents: spec.agents,
      models,
      profile: FALLBACK_PROFILE,
      bundledAgents: true,
    });
    expect(plan.steps.map((s) => s.stepKey)).toContain("hunter-logic");
  });

  test("without the user's copy the missing file is an error", () => {
    expect(
      agentsDirProblems(
        files,
        files.filter((f) => f !== "deep-review-logic.md"),
      ),
    ).toEqual([
      'the spec references "deep-review-logic.md" but the dir does not have it',
    ]);
  });
});
