import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAdjudicationResult } from "#rereview/adjudicate";
import type { PriorRecord } from "#rereview/classify";
import type { RereviewProvenance } from "#rereview/prepare";
import type { DraftFinding, HunterDraft } from "#review/drafts";
import {
  type PipelineInput,
  type PipelineResult,
  runPipeline,
} from "#review/pipeline";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import type { AdjudicationSubject } from "#triage/adjudication";
import type { SessionUsage } from "../../src/usage";

// ---------------------------------------------------------------------------
// The fake mirrors the real runner's contract: a handler's `ok` result carries
// the output that `spec.parse` produced from the final text, and a parse
// failure becomes a `failed` step. Tests reach `parse` through `parsed()`, so
// the adjudicator's real parser is exercised, not bypassed.
// ---------------------------------------------------------------------------

type StepScript = Record<string, (spec: StepSpec) => StepResult>;

class FakeStepRunner implements StepRunner {
  readonly specs: StepSpec[] = [];
  constructor(private readonly script: StepScript) {}
  async run(spec: StepSpec): Promise<StepResult> {
    this.specs.push(spec);
    const handler = this.script[spec.name];
    if (!handler) throw new Error(`unscripted step ${spec.name}`);
    return handler(spec);
  }
}

function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    wall_ms: 1_000,
    tokens_in: 100,
    tokens_out: 10,
    tokens_total: 110,
    cost_usd_est: 0.01,
    ...overrides,
  };
}

// The real runner would have parsed `finalText` through spec.parse; a parse
// failure is a failed step, not a rejected promise.
function parsed(spec: StepSpec, finalText: string): StepResult {
  try {
    return {
      name: spec.name,
      status: "ok",
      output: spec.parse?.(finalText),
      usage: usage(),
      attempts: 1,
      stderrTail: "",
      resultText: finalText,
    };
  } catch {
    return failedStep(spec);
  }
}

function failedStep(spec: StepSpec): StepResult {
  return {
    name: spec.name,
    status: "failed",
    usage: usage({ tokens_in: 5, tokens_out: 1, tokens_total: 6 }),
    attempts: 2,
    stderrTail: "API Error: Connection closed mid-response",
    resultText: "",
  };
}

const HUNTER_TOOLS = "Read, Grep, Glob, mcp__codegraph__codegraph_explore";

async function makeAgentsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-adjudicate-agents-"));
  const hunterFile = (name: string) =>
    [
      "---",
      `name: ${name}`,
      `description: ${name} hunter`,
      "model: sonnet",
      `tools: ${HUNTER_TOOLS}`,
      "---",
      "",
      `# ${name}`,
      "",
      "{{PRIORS}}",
      "",
      "{{GOTCHAS}}",
      "",
    ].join("\n");
  for (const name of [
    "deep-review-reliability",
    "deep-review-resilience",
    "deep-review-parity",
  ]) {
    await Bun.write(path.join(dir, `${name}.md`), hunterFile(name));
  }
  await Bun.write(
    path.join(dir, "review-refuter.md"),
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
  return dir;
}

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const GOTCHAS = "G-01: seeded fixture values carry unit contracts.";

const EMPTY_DRAFT: HunterDraft = { findings: [] as DraftFinding[] };

const HUNTERS_EMPTY: StepScript = {
  "hunter-reliability": (spec) => parsed(spec, JSON.stringify(EMPTY_DRAFT)),
  "hunter-resilience": (spec) => parsed(spec, JSON.stringify(EMPTY_DRAFT)),
};

const SUBJECT: AdjudicationSubject = {
  priorId: "R001",
  threadId: 501,
  replyId: 777,
  sev: "BLOCKER",
  locs: ["src/app.ts:10"],
  claim: "the loop never checks the empty-input case",
  argument: "src/app.ts:12 returns early when the input is empty",
};

async function makeInput(
  overrides: Partial<PipelineInput> = {},
): Promise<PipelineInput> {
  const runDir = await mkdtemp(path.join(tmpdir(), "pr-hero-adjudicate-run-"));
  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(diffPath, PATCH);
  const gotchasPath = path.join(runDir, "gotchas.md");
  await Bun.write(gotchasPath, GOTCHAS);
  return {
    pr: 1539,
    baseSha: "06e857b3",
    headSha: "4609456d",
    worktree: "/worktrees/dr-1539",
    diffPath,
    gotchasPath,
    agentsDir: await makeAgentsDir(),
    runDir,
    outPath: path.join(runDir, "findings.json"),
    mcpConfigPath: "/runs/mcp.json",
    hopBudget: 12,
    parityTriggerPaths: [],
    suspicionPriors: [],
    ...overrides,
  };
}

const ADJUDICATOR_OK: StepScript = {
  "adjudicate-R001": (spec) =>
    parsed(
      spec,
      JSON.stringify({ verdict: "upheld", evidence: ["src/app.ts:10"] }),
    ),
};

const SUBJECT_PRIOR: PriorRecord = {
  id: "R001",
  sev: "BLOCKER",
  tier: "blocking",
  channel: "inline",
  locs: ["src/app.ts:10"],
  claim: "the loop never checks the empty-input case",
  triage: null,
  newThreadReply: false,
};

function rereviewBlock(): RereviewProvenance {
  return {
    case: "C",
    last_reviewed_head: "1".repeat(40),
    last_head_source: "summary_marker",
    discovery_range: `${"1".repeat(40)}..${"2".repeat(40)}`,
    discovery_restricted: true,
    discovery_skipped_empty_delta: false,
    prior_findings: 1,
    settled_deterministically: 0,
    verified: 0,
    verification_capped: 0,
    verification_triggers: {
      applied: 0,
      touched: 0,
      overlap: 0,
      verify_all: 0,
    },
    live: [],
  };
}

describe("runAdjudicate wiring", () => {
  test("a queued subject is ruled on by a step named adjudicate-<priorId>", async () => {
    const runner = new FakeStepRunner({ ...HUNTERS_EMPTY, ...ADJUDICATOR_OK });
    const input = await makeInput({ adjudicationQueue: [SUBJECT] });
    const result: PipelineResult = await runPipeline(input, { runner });

    expect(result.adjudications).toEqual([
      {
        priorId: "R001",
        threadId: 501,
        replyId: 777,
        verdict: "upheld",
        evidence: ["src/app.ts:10"],
      },
    ]);
    expect(runner.specs.map((s) => s.name)).toContain("adjudicate-R001");
    expect(result.perAgent.adjudicator?.status).toBe("ok");
  });

  test("a failed adjudicator step is inconclusive with no evidence", async () => {
    const runner = new FakeStepRunner({
      ...HUNTERS_EMPTY,
      "adjudicate-R001": (spec) => failedStep(spec),
    });
    const input = await makeInput({ adjudicationQueue: [SUBJECT] });
    const result = await runPipeline(input, { runner });

    expect(result.adjudications).toEqual([
      {
        priorId: "R001",
        threadId: 501,
        replyId: 777,
        verdict: "inconclusive",
        evidence: [],
        failed: true,
      },
    ]);
  });

  test("a step that rejects is inconclusive with no evidence", async () => {
    const runner = new FakeStepRunner({
      ...HUNTERS_EMPTY,
      "adjudicate-R001": () => {
        throw new Error("transport exploded");
      },
    });
    const input = await makeInput({ adjudicationQueue: [SUBJECT] });
    const result = await runPipeline(input, { runner });

    expect(result.adjudications?.[0]?.verdict).toBe("inconclusive");
    expect(result.adjudications?.[0]?.evidence).toEqual([]);
    expect(result.adjudications?.[0]?.failed).toBe(true);
  });

  test("prose instead of a JSON object is inconclusive and failed", async () => {
    const runner = new FakeStepRunner({
      ...HUNTERS_EMPTY,
      "adjudicate-R001": (spec) =>
        parsed(spec, "The finding is not a defect, I am fairly sure."),
    });
    const input = await makeInput({ adjudicationQueue: [SUBJECT] });
    const result = await runPipeline(input, { runner });

    expect(result.adjudications?.[0]?.verdict).toBe("inconclusive");
    expect(result.adjudications?.[0]?.evidence).toEqual([]);
    expect(result.adjudications?.[0]?.failed).toBe(true);
  });

  test("a parsed inconclusive verdict is a ruling, not a failure: no failed key", async () => {
    const runner = new FakeStepRunner({
      ...HUNTERS_EMPTY,
      "adjudicate-R001": (spec) =>
        parsed(spec, JSON.stringify({ verdict: "inconclusive", evidence: [] })),
    });
    const input = await makeInput({ adjudicationQueue: [SUBJECT] });
    const result = await runPipeline(input, { runner });

    expect(result.adjudications?.[0]?.verdict).toBe("inconclusive");
    expect("failed" in (result.adjudications?.[0] ?? {})).toBe(false);
  });

  test("no adjudication queue: no result field and no adjudicate step", async () => {
    const runner = new FakeStepRunner({ ...HUNTERS_EMPTY, ...ADJUDICATOR_OK });
    const input = await makeInput();
    const result = await runPipeline(input, { runner });

    expect(result.adjudications).toBeUndefined();
    expect(runner.specs.some((s) => s.name.startsWith("adjudicate-"))).toBe(
      false,
    );
  });

  test("an upheld verdict never changes this run's gate: the prior stays suppressed until the next review reads the reply", async () => {
    const priors: PriorRecord[] = [
      {
        id: "R001",
        sev: "BLOCKER",
        tier: "blocking",
        channel: "inline",
        locs: ["src/app.ts:10"],
        claim: "the loop never checks the empty-input case",
        triage: null,
        newThreadReply: false,
      },
    ];
    const runner = new FakeStepRunner({ ...HUNTERS_EMPTY, ...ADJUDICATOR_OK });
    const input = await makeInput({
      adjudicationQueue: [SUBJECT],
      rereview: rereviewBlock(),
      phaseB: {
        priors,
        settled: [
          {
            id: "R001",
            status: "suppressed",
            locs: ["src/app.ts:10"],
            renamed: false,
          },
        ],
      },
    });
    const result = await runPipeline(input, { runner });

    expect(result.gatePriors?.find((row) => row.id === "R001")?.status).toBe(
      "suppressed",
    );
  });

  test("an upheld verdict leaves a verified-gone row verified-gone", async () => {
    const runner = new FakeStepRunner({ ...HUNTERS_EMPTY, ...ADJUDICATOR_OK });
    const rereview = rereviewBlock();
    const input = await makeInput({
      adjudicationQueue: [SUBJECT],
      rereview,
      phaseB: {
        priors: [SUBJECT_PRIOR],
        settled: [
          {
            id: "R001",
            status: "verified-gone",
            locs: ["src/app.ts:10"],
            renamed: false,
          },
        ],
      },
    });
    const result = await runPipeline(input, { runner });

    // The verifier's collapse still happens: R001 is counted as verified-gone
    // (provenance is filled onto the input's rereview block), and it is not
    // re-labelled ci-dismissed in the gate rows.
    expect(rereview.resolved_ids).toEqual(["R001"]);
    expect(
      result.gatePriors?.some((row) => row.status === "ci-dismissed"),
    ).toBe(false);
  });

  test("an upheld verdict leaves a returned row returned", async () => {
    const runner = new FakeStepRunner({ ...HUNTERS_EMPTY, ...ADJUDICATOR_OK });
    const input = await makeInput({
      adjudicationQueue: [SUBJECT],
      rereview: rereviewBlock(),
      phaseB: {
        priors: [SUBJECT_PRIOR],
        settled: [
          {
            id: "R001",
            status: "returned",
            locs: ["src/app.ts:10"],
            renamed: false,
          },
        ],
      },
    });
    const result = await runPipeline(input, { runner });

    expect(result.gatePriors?.find((row) => row.id === "R001")?.status).toBe(
      "returned",
    );
  });

  test("the adjudicator's parser is the one the step carries", async () => {
    const runner = new FakeStepRunner({ ...HUNTERS_EMPTY, ...ADJUDICATOR_OK });
    const input = await makeInput({ adjudicationQueue: [SUBJECT] });
    await runPipeline(input, { runner });
    const spec = runner.specs.find((s) => s.name === "adjudicate-R001");
    expect(spec?.parse?.('{"verdict":"rejected"}')).toEqual(
      parseAdjudicationResult('{"verdict":"rejected"}'),
    );
  });
});
