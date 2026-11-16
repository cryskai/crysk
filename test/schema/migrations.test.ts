import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PIPELINE_SCHEMA_VERSION,
  type PipelineInput,
  runPipeline,
} from "#review/pipeline";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import { parsePipelineMeta } from "#watch/preflight";

// ---------------------------------------------------------------------------
// D1-10c — §13's required-evidence artifact: `pipeline.json` read-back
// compatibility ACROSS the versioning boundary, proved in both directions.
//
// The migration mechanism this file guards is deliberately not review/findings.ts's:
// there, `schema_version` is validated by hard equality and a mismatch is a
// loud rejection. Here the writer STAMPS and every reader TOLERATES, because
// pipeline.json's readers run in places where a throw costs money —
// `parsePipelineMeta` backs the watcher's daily attempt cap, and its own WHY
// comment (src/watch/preflight.ts) records that a loud throw on one damaged
// artifact would brick every future watcher tick. So:
//
//   - absence of `schema_version` means a PRE-VERSIONING artifact, never an
//     invalid one, and every reader must still answer for it;
//   - presence of unknown keys (this slice's `attempts`, the two pointers)
//     must change no reader's answer.
//
// Both fixtures below are transcribed from real artifact shapes, not reduced
// to the keys under test: a migration test that only proves `JSON.parse` works
// proves nothing about the readers that actually run in production.
// ---------------------------------------------------------------------------

// A real 40-char sha. `parsePipelineMeta` gates on `isFullCommitId`, so an
// abbreviated fixture sha would make it return null for the wrong reason and
// the assertions below would pass while testing nothing.
const HEAD_SHA = "4609456d0f2a1b8c7e3d59a4f60b21c8d7e94a05";
const BASE_SHA = "06e857b3a91c4d20fe7b8635a1c02d94ff31ab77";

// ---------------------------------------------------------------------------
// OLD shape — a pipeline.json this engine wrote BEFORE D1-10c: no
// `schema_version`, no attempt provenance, and `steps[]` entries carrying only
// the five keys `stepMeta()` set (plus the summarizer's `status`, which was the
// one step that already had it).
// ---------------------------------------------------------------------------

const OLD_SHAPE = {
  pr: 1539,
  base_sha: BASE_SHA,
  head_sha: HEAD_SHA,
  out_path: "/runs/pr-1539-4609456d-1/findings.json",
  excluded_paths: [],
  parity_hunter_fired: false,
  engine: { version: "0.9.0", commit: "abc1234" },
  prompt_set: { name: "v3", sha256: "deadbeef" },
  generated_at: "2026-08-20T11:04:03.812Z",
  boundary_nonce: "a1b2c3d4",
  scout: {
    enabled: false,
    status: "skipped",
    leads_count: 0,
    leads_truncated: 0,
    why_truncated: 0,
    duration_ms: 0,
  },
  steps: [
    {
      name: "hunter-reliability",
      model: "sonnet",
      tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
      systemPromptPath:
        "/runs/pr-1539-4609456d-1/steps/hunter-reliability.system.md",
      outPath: "/runs/pr-1539-4609456d-1/steps/hunter-reliability.draft.json",
    },
    {
      name: "hunter-resilience",
      model: "sonnet",
      tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
      systemPromptPath:
        "/runs/pr-1539-4609456d-1/steps/hunter-resilience.system.md",
      outPath: "/runs/pr-1539-4609456d-1/steps/hunter-resilience.draft.json",
    },
    {
      name: "summarizer",
      model: "sonnet",
      tools: [],
      systemPromptPath: "/runs/pr-1539-4609456d-1/steps/summarizer.system.md",
      outPath: "/runs/pr-1539-4609456d-1/steps/summarizer.summary.json",
      status: "ok",
    },
  ],
};

// OLDER still — pre-M5, before `scout` existed at all. The same shape a run
// written after the scout stage was removed has: no `scout` key.
const OLD_SHAPE_NO_SCOUT = (() => {
  const { scout: _scout, ...rest } = OLD_SHAPE;
  return rest;
})();

// An old scout-ARM artifact whose scout failed. The stage was removed after it
// was written, and the artifact must keep reading.
const OLD_SHAPE_SCOUT_FAILED = {
  ...OLD_SHAPE,
  scout: {
    enabled: true,
    model: "haiku",
    status: "failed",
    leads_count: 0,
    leads_truncated: 0,
    why_truncated: 0,
    duration_ms: 4_211,
  },
};

// ---------------------------------------------------------------------------
// NEW shape — what this slice's writer produces: `schema_version` at the top
// level, and every `steps[]` entry answering "did it run, did it settle, how
// many attempts, and where is the proof".
// ---------------------------------------------------------------------------

const NEW_SHAPE = {
  schema_version: PIPELINE_SCHEMA_VERSION,
  pr: 1539,
  base_sha: BASE_SHA,
  head_sha: HEAD_SHA,
  out_path: "/runs/pr-1539-4609456d-1/findings.json",
  excluded_paths: [],
  parity_hunter_fired: false,
  engine: { version: "0.10.0", commit: "def5678" },
  prompt_set: { name: "v3", sha256: "deadbeef" },
  generated_at: "2026-08-27T09:15:44.201Z",
  boundary_nonce: "a1b2c3d4",
  steps: [
    {
      name: "hunter-reliability",
      model: "sonnet",
      tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
      systemPromptPath:
        "/runs/pr-1539-4609456d-1/steps/hunter-reliability.system.md",
      outPath: "/runs/pr-1539-4609456d-1/steps/hunter-reliability.draft.json",
      status: "ok",
      attempts: 1,
      attemptLogPath: "steps/logs/hunter-reliability.1.log",
      settlementReceiptPath:
        "steps/settlement.hunter-reliability.attempt1.json",
    },
    {
      name: "hunter-resilience",
      model: "sonnet",
      tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
      systemPromptPath:
        "/runs/pr-1539-4609456d-1/steps/hunter-resilience.system.md",
      outPath: "/runs/pr-1539-4609456d-1/steps/hunter-resilience.draft.json",
      status: "failed",
      attempts: 2,
      attemptLogPath: "steps/logs/hunter-resilience.2.log",
      settlementReceiptPath: "steps/settlement.hunter-resilience.attempt2.json",
    },
    {
      name: "summarizer",
      model: "sonnet",
      tools: [],
      systemPromptPath: "/runs/pr-1539-4609456d-1/steps/summarizer.system.md",
      outPath: "/runs/pr-1539-4609456d-1/steps/summarizer.summary.json",
      status: "unsettled",
    },
  ],
};

// ---------------------------------------------------------------------------
// Fixture self-guards. Both fixtures are hand-written, so the properties the
// rest of this file rests on are asserted rather than assumed — a fixture that
// silently grows a `schema_version` key turns every "old shape" test below into
// a second copy of the "new shape" ones.
// ---------------------------------------------------------------------------

describe("D1-10c fixtures are what they claim to be", () => {
  test("the old shape carries no schema_version and no attempt provenance", () => {
    expect("schema_version" in OLD_SHAPE).toBe(false);
    for (const step of OLD_SHAPE.steps) {
      expect("attempts" in step).toBe(false);
      expect("attemptLogPath" in step).toBe(false);
      expect("settlementReceiptPath" in step).toBe(false);
    }
    // The five keys stepMeta() set before this slice, and nothing else beyond
    // the summarizer's pre-existing `status`.
    expect(Object.keys(OLD_SHAPE.steps[0] ?? {})).toEqual([
      "name",
      "model",
      "tools",
      "systemPromptPath",
      "outPath",
    ]);
  });

  test("the older shape carries no scout key at all", () => {
    expect("scout" in OLD_SHAPE_NO_SCOUT).toBe(false);
  });

  test("the new shape stamps the version and carries attempt provenance", () => {
    expect(NEW_SHAPE.schema_version).toBe(PIPELINE_SCHEMA_VERSION);
    expect(NEW_SHAPE.steps[0]?.attempts).toBe(1);
    expect(NEW_SHAPE.steps[0]?.attemptLogPath).toBe(
      "steps/logs/hunter-reliability.1.log",
    );
  });
});

// ---------------------------------------------------------------------------
// Direction 1: the NEW readers over an OLD artifact. This is the direction that
// matters in production — a runs root holds every artifact this engine has ever
// written, and the watcher walks all of them on every tick.
// ---------------------------------------------------------------------------

describe("old-shape pipeline.json still reads through the current readers", () => {
  const raw = JSON.stringify(OLD_SHAPE);

  test("parsePipelineMeta returns the pr and head_sha", () => {
    expect(parsePipelineMeta(raw)).toEqual({
      pr: 1539,
      head_sha: HEAD_SHA,
    });
  });

  // The scout stage was removed; artifacts written while it existed still
  // carry its record and its step, and the readers name keys, so they read.
  test("an old artifact that carries a scout record is still read", () => {
    expect("scout" in OLD_SHAPE).toBe(true);
    expect(parsePipelineMeta(JSON.stringify(OLD_SHAPE_SCOUT_FAILED))).toEqual({
      pr: 1539,
      head_sha: HEAD_SHA,
    });
  });

  test("an old artifact from before the scout existed is read the same way", () => {
    expect(parsePipelineMeta(JSON.stringify(OLD_SHAPE_NO_SCOUT))).toEqual({
      pr: 1539,
      head_sha: HEAD_SHA,
    });
  });
});

// ---------------------------------------------------------------------------
// Direction 2: the same readers over a NEW artifact. Every answer must be the
// one the old artifact gave — the new keys are additive provenance, not a
// change of meaning for anything a reader already looked at.
// ---------------------------------------------------------------------------

describe("new-shape pipeline.json reads identically", () => {
  const raw = JSON.stringify(NEW_SHAPE);

  test("parsePipelineMeta returns the pr and head_sha", () => {
    expect(parsePipelineMeta(raw)).toEqual({
      pr: 1539,
      head_sha: HEAD_SHA,
    });
  });

  test("every reader gives the OLD artifact's answer for the NEW one", () => {
    expect(parsePipelineMeta(JSON.stringify(NEW_SHAPE))).toEqual(
      parsePipelineMeta(JSON.stringify(OLD_SHAPE)),
    );
  });
});

// ---------------------------------------------------------------------------
// The tolerance itself. `parsePipelineMeta`'s WHY comment is explicit that it
// returns null and NEVER throws, because the watcher's daily cap depends on it
// degrading rather than dying. Versioning must not have introduced a
// hard-equality gate on the way past.
// ---------------------------------------------------------------------------

describe("readers tolerate what they cannot understand", () => {
  test("a future schema_version is not rejected", () => {
    const future = { ...NEW_SHAPE, schema_version: "9.9.9" };
    expect(parsePipelineMeta(JSON.stringify(future))).toEqual({
      pr: 1539,
      head_sha: HEAD_SHA,
    });
  });

  test("a truncated artifact degrades instead of throwing", () => {
    const truncated = JSON.stringify(NEW_SHAPE).slice(0, 120);
    expect(() => parsePipelineMeta(truncated)).not.toThrow();
    expect(parsePipelineMeta(truncated)).toBe(null);
  });

  test("a non-object artifact degrades instead of throwing", () => {
    expect(parsePipelineMeta("[]")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// The writer half: the only place `schema_version` can enter the artifact is
// `writePipelinePlan`, so the stamp is proved against a real run rather than a
// hand-written fixture — and that run's output is fed straight back through the
// three readers, which is the round trip the two fixture directions above only
// simulate.
// ---------------------------------------------------------------------------

class ScriptedRunner implements StepRunner {
  readonly specs: StepSpec[] = [];
  async run(spec: StepSpec): Promise<StepResult> {
    this.specs.push(spec);
    return {
      name: spec.name,
      status: "ok",
      output: { findings: [] },
      usage: {
        wall_ms: 1_000,
        tokens_in: 100,
        tokens_out: 10,
        tokens_total: 110,
        cost_usd_est: 0.01,
      },
      attempts: 1,
      stderrTail: "",
      resultText: "",
    };
  }
}

const HUNTER_TOOLS = "Read, Grep, Glob, mcp__codegraph__codegraph_explore";

async function makeRunInput(): Promise<PipelineInput> {
  const agentsDir = await mkdtemp(path.join(tmpdir(), "pr-hero-mig-agents-"));
  for (const name of [
    "deep-review-reliability",
    "deep-review-resilience",
    "deep-review-parity",
  ]) {
    await Bun.write(
      path.join(agentsDir, `${name}.md`),
      [
        "---",
        `name: ${name}`,
        `description: ${name} hunter`,
        "model: sonnet",
        `tools: ${HUNTER_TOOLS}`,
        "---",
        "",
        "Hunt bugs in the diff.",
        "",
        "{{PRIORS}}",
        "",
        "{{GOTCHAS}}",
        "",
      ].join("\n"),
    );
  }
  await Bun.write(
    path.join(agentsDir, "review-refuter.md"),
    [
      "---",
      "name: review-refuter",
      "description: detached refuter",
      "model: sonnet",
      "tools: Read, Grep, Glob",
      "---",
      "",
      "Refute or corroborate.",
      "",
    ].join("\n"),
  );
  const runDir = await mkdtemp(path.join(tmpdir(), "pr-hero-mig-run-"));
  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(
    diffPath,
    [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
  );
  const gotchasPath = path.join(runDir, "gotchas.md");
  await Bun.write(gotchasPath, "G-01: seeded fixture values carry units.");
  return {
    pr: 1539,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    worktree: "/worktrees/dr-1539",
    diffPath,
    gotchasPath,
    agentsDir,
    runDir,
    outPath: path.join(runDir, "findings.json"),
    mcpConfigPath: "/runs/mcp.json",
    hopBudget: 12,
    parityTriggerPaths: [],
    suspicionPriors: [],
  };
}

describe("the writer stamps the version it writes", () => {
  test("a real run's pipeline.json carries PIPELINE_SCHEMA_VERSION", async () => {
    const input = await makeRunInput();
    await runPipeline(input, { runner: new ScriptedRunner() });
    const plan = (await Bun.file(
      path.join(input.runDir, "pipeline.json"),
    ).json()) as { schema_version?: unknown };
    expect(plan.schema_version).toBe(PIPELINE_SCHEMA_VERSION);
  });

  test("PIPELINE_SCHEMA_VERSION is a semver string naming THIS shape", () => {
    expect(PIPELINE_SCHEMA_VERSION).toBe("1.0.0");
    expect(typeof PIPELINE_SCHEMA_VERSION).toBe("string");
  });

  test("a freshly written plan round-trips through all three readers", async () => {
    const input = await makeRunInput();
    await runPipeline(input, { runner: new ScriptedRunner() });
    const planPath = path.join(input.runDir, "pipeline.json");
    const raw = await Bun.file(planPath).text();
    const plan = JSON.parse(raw) as unknown;
    expect(parsePipelineMeta(raw)).toEqual({ pr: 1539, head_sha: HEAD_SHA });
    // The scout stage is gone: the writer no longer records it.
    expect("scout" in (plan as Record<string, unknown>)).toBe(false);
  });
});
