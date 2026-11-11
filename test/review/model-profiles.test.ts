// model-profiles S3 through the whole pipeline: a profile other than `claude`
// moves what each step runs, observed on the Claude argv (`--model`,
// `--effort`) and on pipeline.json, and a user prompt set's frontmatter still
// outranks it. Phase 1 has no `profile` config key, so a fixture profile is
// injected through PipelineInput.modelProfile.
import { describe, expect, test } from "bun:test";
import type { ModelProfile } from "#model/profiles";
import {
  BASELINE_CASES,
  type Baseline,
  captureBaseline,
  type RecordedStep,
} from "./model-profiles-harness";

// Differs from `claude` in every role it names; consolidate and summary are
// left out on purpose, so they fall back to the `claude` profile.
const FIXTURE_PROFILE: ModelProfile = {
  id: "fixture",
  roles: {
    hunter: { model: "claude:opus-latest", effort: "medium" },
    refuter: { model: "claude:haiku-latest", effort: "low" },
    scout: { model: "claude:haiku-latest", effort: "low" },
    judge: { model: "claude:opus-latest", effort: "medium" },
  },
  hunters: { logic: { model: "claude:haiku-latest", effort: "max" } },
};

function caseNamed(name: string) {
  const found = BASELINE_CASES.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no baseline case ${name}`);
  return found;
}

function flag(argv: readonly string[] | null, name: string) {
  if (argv === null) return undefined;
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

// [cliModel, argv --model, argv --effort, pipeline.json model, effort] per step.
function routing(baseline: Baseline): Record<string, unknown[]> {
  const rows = new Map(
    baseline.pipelineSteps.map((row) => [String(row.name), row]),
  );
  const out: Record<string, unknown[]> = {};
  for (const step of baseline.steps as RecordedStep[]) {
    const row = rows.get(step.name);
    out[step.name] = [
      step.cliModel,
      flag(step.argv, "--model"),
      flag(step.argv, "--effort"),
      row?.model,
      row?.effort,
    ];
  }
  return out;
}

describe("a fixture profile on the bundled set (S1, S3)", () => {
  test("every step without a frontmatter of its own follows the profile", async () => {
    const baseline = await captureBaseline(caseNamed("zero-config"), {
      bundledAgents: true,
      modelProfile: FIXTURE_PROFILE,
    });
    expect(routing(baseline)).toEqual({
      // Per-hunter override, then the profile's hunter role.
      "hunter-logic": ["haiku", "haiku", "max", "haiku", "max"],
      "hunter-parity": ["opus", "opus", "medium", "opus", "medium"],
      "hunter-reliability": ["opus", "opus", "medium", "opus", "medium"],
      "hunter-resilience": ["opus", "opus", "medium", "opus", "medium"],
      "refuter-F001": ["haiku", "haiku", "low", "haiku", "low"],
      // prompts/scout.md names no model: the profile's scout.
      scout: ["haiku", "haiku", "low", "haiku", "low"],
      // The judge reads the profile, still held to the measured list.
      "materiality-F001": ["opus", "opus", "medium", "opus", "medium"],
      // The engine-owned root prompts keep their frontmatter in phase 1
      // (consolidate.md: sonnet/high, summarizer.md: haiku), and the role
      // the fixture leaves out falls back to `claude` (summary effort high).
      consolidate: ["sonnet", "sonnet", "high", "sonnet", "high"],
      summarizer: ["haiku", "haiku", "high", "haiku", "high"],
    });
    const plan = baseline.plan?.steps.find((s) => s.stepKey === "hunter-logic");
    expect(plan?.logicalIdentity).toBe("claude:haiku-latest");
  });

  test("models[role] and models.default still outrank the profile", async () => {
    const baseline = await captureBaseline(
      {
        name: "fixture-models",
        models: {
          "hunter.logic": ["claude:sonnet-latest"],
          default: ["claude:sonnet-latest"],
        },
      },
      { bundledAgents: true, modelProfile: FIXTURE_PROFILE },
    );
    const r = routing(baseline);
    // The model is the entry's; with no entry effort the step keeps the
    // effort its prompt seat holds, which on the bundled set is the profile's.
    expect(r["hunter-logic"]?.slice(0, 3)).toEqual(["sonnet", "haiku", "max"]);
    expect(r["hunter-parity"]?.[0]).toBe("sonnet");
    expect(r["refuter-F001"]?.[0]).toBe("sonnet");
    expect(r.scout?.[0]).toBe("sonnet");
  });

  test("--model still outranks the profile", async () => {
    const baseline = await captureBaseline(caseNamed("cli-model"), {
      bundledAgents: true,
      modelProfile: FIXTURE_PROFILE,
    });
    const r = routing(baseline);
    for (const step of ["hunter-logic", "hunter-parity", "refuter-F001"]) {
      expect(r[step]?.[0]).toBe("haiku");
    }
  });
});

describe("a user prompt set's frontmatter outranks the profile (S3)", () => {
  test("model and effort lines win; an omitted effort falls to the profile", async () => {
    const baseline = await captureBaseline(caseNamed("custom-agents-dir"), {
      modelProfile: FIXTURE_PROFILE,
    });
    const r = routing(baseline);
    expect(r["hunter-logic"]).toEqual([
      "haiku",
      "haiku",
      "medium",
      "haiku",
      "medium",
    ]);
    expect(r["hunter-resilience"]?.slice(0, 3)).toEqual([
      "sonnet",
      "sonnet",
      "max",
    ]);
    expect(r["refuter-F001"]?.slice(0, 3)).toEqual([
      "sonnet",
      "sonnet",
      "medium",
    ]);
    // `model: haiku` with no `effort:`: the active profile's hunter effort,
    // where the `claude` profile gives xhigh (the baseline fixture).
    expect(r["hunter-reliability"]?.slice(0, 3)).toEqual([
      "haiku",
      "haiku",
      "medium",
    ]);
  });

  test("the unmarked bundled directory is read as a user set: its frontmatter wins", async () => {
    const baseline = await captureBaseline(caseNamed("zero-config"), {
      modelProfile: FIXTURE_PROFILE,
    });
    const r = routing(baseline);
    expect(r["hunter-parity"]?.slice(0, 3)).toEqual([
      "sonnet",
      "sonnet",
      "xhigh",
    ]);
    expect(r["refuter-F001"]?.slice(0, 3)).toEqual(["opus", "opus", "high"]);
  });
});
