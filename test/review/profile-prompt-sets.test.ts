// model-profiles S4: every step's prompt is looked up through the active
// profile's prompt set, falling back file by file to the default set, and a
// user `agents_dir` outranks the profile for the five agent files it covers.
// No profile set ships in phase 1, so a test-only set
// (test/fixtures/model-profiles/prompt-sets/fixture) overrides the refuter and
// the consolidation prompt and falls back for everything else. Its frontmatter
// is deliberately wrong (haiku, low): an engine-owned prompt takes its routing
// from the profile, so a step that runs haiku or low read the file instead.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEffectiveConfig } from "#config/config";
import type { ModelProfile } from "#model/profiles";
import { CLAUDE_PROFILE } from "#model/profiles/claude";
import {
  type AgentsDirConfigSeat,
  localReviewSpec,
  preflightAgentsDir,
  resolveAgentsDirSetting,
} from "#review/preflight";
import {
  ENGINE_PROMPT_FILES,
  type ProfilePromptSets,
  profilePromptSet,
  promptSetFingerprint,
} from "#review/prompt-set";
import {
  buildCliRoutePlan,
  enginePromptPath,
  pipelineConsolidateInput,
  pipelineMaterialityInput,
  pipelineScoutInput,
  pipelineSummarizerInput,
} from "#review/route-preflight";
import { resolvePromptSet } from "#review/run";
import { resolveEngineAssets } from "../../src/assets";
import {
  BASELINE_CASES,
  baselinePath,
  captureBaseline,
  type RecordedStep,
} from "./model-profiles-harness";

const FIXTURE_SET_DIR = path.resolve(
  import.meta.dir,
  "../fixtures/model-profiles/prompt-sets/fixture",
);
const FIXTURE_SETS: ProfilePromptSets = {
  fixture: {
    "review-refuter.md": path.join(FIXTURE_SET_DIR, "review-refuter.md"),
    "consolidate.md": path.join(FIXTURE_SET_DIR, "consolidate.md"),
  },
};

// Moves every role whose prompt the set overrides, plus the summary, so the
// real summarizer.md (`model: haiku`) shows whether the profile decides.
const FIXTURE_PROFILE: ModelProfile = {
  id: "fixture",
  promptSet: "fixture",
  roles: {
    refuter: { model: "claude:sonnet-latest", effort: "medium" },
    consolidate: { model: "claude:opus-latest", effort: "max" },
    summary: { model: "claude:sonnet-latest", effort: "medium" },
    scout: { model: "claude:opus-latest", effort: "low" },
  },
};

const assets = resolveEngineAssets();
const AGENT_FILES = Object.keys(assets.bundledAgentFiles);
const fixture = { profile: FIXTURE_PROFILE, promptSets: FIXTURE_SETS };

describe("profilePromptSet: one lookup, split into agent and engine files", () => {
  test("claude names no set: nothing is overridden", () => {
    expect(profilePromptSet(CLAUDE_PROFILE, AGENT_FILES, FIXTURE_SETS)).toEqual(
      { agents: {}, engine: {} },
    );
  });

  test("a profile's set holds only the files that differ", () => {
    expect(
      profilePromptSet(FIXTURE_PROFILE, AGENT_FILES, FIXTURE_SETS),
    ).toEqual({
      agents: {
        "review-refuter.md": FIXTURE_SETS.fixture?.["review-refuter.md"],
      },
      engine: { "consolidate.md": FIXTURE_SETS.fixture?.["consolidate.md"] },
    });
  });

  test("a file that overrides nothing in the default set is refused", () => {
    expect(() =>
      profilePromptSet(FIXTURE_PROFILE, AGENT_FILES, {
        fixture: { "review-verifier.md": "/x/review-verifier.md" },
      }),
    ).toThrow(/review-verifier\.md/);
  });

  test("a set this build does not have is refused", () => {
    expect(() =>
      profilePromptSet(
        { ...FIXTURE_PROFILE, promptSet: "missing" },
        AGENT_FILES,
        {},
      ),
    ).toThrow(/missing/);
  });
});

describe("agent files: the profile's set over default, file by file (S4)", () => {
  test("claude: today's resolution, byte for byte", () => {
    expect(
      resolveAgentsDirSetting({ cwd: "/work", profile: CLAUDE_PROFILE }),
    ).toEqual({
      dir: assets.defaultAgentsDir,
      source: "default",
      kind: "dir",
    });
  });

  test("a profile set: its refuter, the default set's hunters", async () => {
    const resolution = resolveAgentsDirSetting({ cwd: "/work", ...fixture });
    expect(resolution.source).toBe("default");
    expect(resolution.promptSet).toBe("fixture");
    expect(resolution.files).toEqual({
      ...assets.bundledAgentFiles,
      "review-refuter.md": path.join(FIXTURE_SET_DIR, "review-refuter.md"),
    });
    // The merged set still matches the review spec, both directions.
    await preflightAgentsDir(
      resolution,
      localReviewSpec({}).agents.map((a) => a.file),
    );
  });

  const seat: AgentsDirConfigSeat = {
    value: "./prompts",
    layer: "repo",
    dir: "/repo/.crysk",
  };
  for (const [name, input] of [
    ["--agents", { flag: "/custom/agents" }],
    ["config agents_dir", { config: seat }],
    ["PRHERO_AGENTS_DIR", { env: "/env/agents" }],
  ] as const) {
    test(`a user ${name} outranks the profile's set`, () => {
      const resolution = resolveAgentsDirSetting({
        cwd: "/work",
        ...input,
        ...fixture,
      });
      expect(resolution.kind).toBe("dir");
      expect(resolution.files).toBeUndefined();
      expect(resolution.promptSet).toBeUndefined();
    });
  }
});

describe("engine-owned prompts: the profile's set over default (S4)", () => {
  const defaults: Record<string, string> = {
    "consolidate.md": assets.consolidatePromptPath,
    "scout.md": assets.scoutPromptPath,
    "summarizer.md": assets.summarizerPromptPath,
    "materiality.md": assets.materialityPromptPath,
  };

  test("claude: every engine prompt is today's path", () => {
    for (const file of ENGINE_PROMPT_FILES) {
      expect(enginePromptPath(file, { profile: CLAUDE_PROFILE })).toBe(
        defaults[file] as string,
      );
    }
  });

  test("a profile set: its consolidate, the default for the other three", () => {
    for (const file of ENGINE_PROMPT_FILES) {
      expect(enginePromptPath(file, fixture)).toBe(
        file === "consolidate.md"
          ? path.join(FIXTURE_SET_DIR, "consolidate.md")
          : (defaults[file] as string),
      );
    }
  });

  test("the stage inputs carry the resolved path and the engine-owned mark", () => {
    expect(pipelineConsolidateInput(fixture)).toEqual({
      consolidate: {
        promptPath: path.join(FIXTURE_SET_DIR, "consolidate.md"),
        bundled: true,
      },
    });
    expect(pipelineScoutInput({ scout: true }, fixture)).toEqual({
      scout: { promptPath: assets.scoutPromptPath, bundled: true },
    });
    expect(pipelineSummarizerInput({ enabled: true }, fixture)).toEqual({
      summarizer: { promptPath: assets.summarizerPromptPath, bundled: true },
    });
    expect(
      pipelineMaterialityInput({ materiality_gate: true }, fixture),
    ).toEqual({
      materiality: { promptPath: assets.materialityPromptPath },
    });
  });

  test("a user agents_dir does not cover them: the profile's consolidate still applies", () => {
    // The agents dir resolution is not an input to the engine prompts at all,
    // which is the precedence: agents_dir names five agent files and no more.
    const user = resolveAgentsDirSetting({
      cwd: "/work",
      flag: "/custom/agents",
      ...fixture,
    });
    expect(user.kind).toBe("dir");
    expect(enginePromptPath("consolidate.md", fixture)).toBe(
      path.join(FIXTURE_SET_DIR, "consolidate.md"),
    );
  });
});

// [model, effort] per step, from pipeline.json.
function routing(steps: readonly Record<string, unknown>[]) {
  return Object.fromEntries(
    steps.map((row) => [String(row.name), [row.model, row.effort]]),
  );
}

const zeroConfig = BASELINE_CASES.find((c) => c.name === "zero-config");
if (zeroConfig === undefined) throw new Error("no zero-config case");

// The production marking: the agents resolved as the bundled set, the four
// root prompts as engine-owned.
function bundledInputs(options: Parameters<typeof enginePromptPath>[1] = {}) {
  return {
    bundledAgents: true,
    ...pipelineSummarizerInput({ enabled: true }, options),
    ...pipelineScoutInput({ scout: true }, options),
    ...pipelineConsolidateInput(options),
    ...pipelineMaterialityInput({ materiality_gate: true }, options),
  };
}

describe("the pipeline over a profile's prompt set (S4, S3)", () => {
  test("pipeline.json names the profile's prompt set, and only when there is one", async () => {
    let claude: Record<string, unknown> = {};
    await captureBaseline(zeroConfig, bundledInputs(), (json) => {
      claude = json;
    });
    expect("profile_prompt_set" in claude).toBe(false);
    let profiled: Record<string, unknown> = {};
    await captureBaseline(
      zeroConfig,
      { ...bundledInputs(fixture), modelProfile: FIXTURE_PROFILE },
      (json) => {
        profiled = json;
      },
    );
    expect(profiled.profile_prompt_set).toEqual({
      profile: "fixture",
      name: "fixture",
    });
  });

  // Every S8 input as production runs it: the root prompts marked as the
  // engine's, the agents marked bundled only when they are (a person's
  // `agents_dir`, the custom case, is not).
  for (const c of BASELINE_CASES) {
    test(`claude, marked engine prompts: ${c.name} baseline, unchanged`, async () => {
      const actual = await captureBaseline(c, {
        ...bundledInputs(),
        bundledAgents: c.customFrontmatter === undefined,
      });
      const expected = JSON.parse(readFileSync(baselinePath(c.name), "utf8"));
      expect(actual).toEqual(expected);
    });
  }

  test("engine-owned root prompts route by the profile, not their frontmatter (S3)", async () => {
    // The real root prompts: consolidate.md says sonnet/high, summarizer.md
    // says haiku. The profile says otherwise, and decides.
    const baseline = await captureBaseline(zeroConfig, {
      ...bundledInputs(),
      modelProfile: FIXTURE_PROFILE,
    });
    const r = routing(baseline.pipelineSteps);
    expect(r.consolidate).toEqual(["opus", "max"]);
    expect(r.summarizer).toEqual(["sonnet", "medium"]);
    expect(r.scout).toEqual(["opus", "low"]);
  });

  test("a profile set's files run, its frontmatter does not route them, the rest fall back", async () => {
    const agents = resolveAgentsDirSetting({ cwd: "/work", ...fixture });
    const baseline = await captureBaseline(zeroConfig, {
      ...bundledInputs(fixture),
      ...(agents.files === undefined ? {} : { agentFiles: agents.files }),
      modelProfile: FIXTURE_PROFILE,
    });
    const expected = JSON.parse(
      readFileSync(baselinePath("zero-config"), "utf8"),
    );
    const sha = (steps: readonly RecordedStep[], name: string) =>
      steps.find((s) => s.name === name)?.systemPromptSha256;
    // Overridden: a different system prompt than the default set's.
    expect(sha(baseline.steps, "refuter-F001")).not.toBe(
      sha(expected.steps, "refuter-F001"),
    );
    expect(sha(baseline.steps, "consolidate")).not.toBe(
      sha(expected.steps, "consolidate"),
    );
    // Fallen back: byte-identical to the default set's.
    for (const name of [
      "hunter-logic",
      "hunter-parity",
      "hunter-reliability",
      "hunter-resilience",
      "scout",
      "summarizer",
      "materiality-F001",
    ]) {
      expect(sha(baseline.steps, name)).toBe(sha(expected.steps, name));
    }
    const r = routing(baseline.pipelineSteps);
    expect(r["refuter-F001"]).toEqual(["sonnet", "medium"]);
    expect(r.consolidate).toEqual(["opus", "max"]);
  });
});

describe("buildCliRoutePlan: engine-owned prompts take the profile's seat (S3)", () => {
  test("a fixture profile moves the summarizer, scout and consolidate routes", async () => {
    const plan = await buildCliRoutePlan({
      spec: localReviewSpec({}),
      options: { scout: true } as Parameters<
        typeof buildCliRoutePlan
      >[0]["options"],
      agentFiles: new Map(),
      bundledAgents: true,
      summary: { enabled: true },
      profile: FIXTURE_PROFILE,
    });
    const identity = (key: string) =>
      plan.steps.find((s) => s.stepKey === key)?.logicalIdentity;
    expect(identity("summarizer")).toBe("claude:sonnet-latest");
    expect(identity("scout")).toBe("claude:opus-latest");
    expect(identity("consolidate")).toBe("claude:opus-latest");
  });
});

// The prompt set's identity (pipeline.json and findings `prompt_set`) through
// the production entry point. `claude` must name and hash exactly what the
// default directory does; a profile's merged set is a different set, so it
// carries its own name and a different fingerprint.
describe("resolvePromptSet: the prompt set's identity under a profile (S4)", () => {
  async function identity(prompts?: Parameters<typeof resolvePromptSet>[2]) {
    const root = await mkdtemp(path.join(tmpdir(), "crysk-profile-set-"));
    const names = ["CRYSK_AGENTS_DIR", "PRHERO_AGENTS_DIR"] as const;
    const previous = names.map((name) => process.env[name]);
    for (const name of names) delete process.env[name];
    try {
      const loaded = await loadEffectiveConfig({ root, home: root });
      return (await resolvePromptSet({}, loaded, prompts)).promptSet;
    } finally {
      names.forEach((name, i) => {
        const value = previous[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
      await rm(root, { recursive: true, force: true });
    }
  }
  const specFiles = localReviewSpec({}).agents.map((a) => a.file);

  test("claude: the default set's name and fingerprint, unchanged", async () => {
    expect(await identity({ profile: CLAUDE_PROFILE })).toEqual({
      name: "default",
      sha256: await promptSetFingerprint(
        specFiles.map((f) => path.join(assets.defaultAgentsDir, f)),
      ),
    });
    expect(await identity()).toEqual(
      await identity({ profile: CLAUDE_PROFILE }),
    );
  });

  test("a profile's set: its own name, and the fingerprint of the merged files", async () => {
    const merged = { ...assets.bundledAgentFiles, ...FIXTURE_SETS.fixture };
    const own = await identity(fixture);
    expect(own).toEqual({
      name: "fixture",
      sha256: await promptSetFingerprint(
        specFiles.map((f) => merged[f] as string),
      ),
    });
    expect(own.sha256).not.toBe((await identity()).sha256);
  });
});
