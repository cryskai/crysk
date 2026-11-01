import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createResolvedRoutePlan, resolveStepRoute } from "#model/routing";
import type { DraftFinding, HunterDraft } from "#review/drafts";
import {
  mergeRunEnvelope,
  type Telemetry,
  validateFindingsDocument,
} from "#review/findings";
import {
  MATERIALITY_TITLE_FALLBACK,
  type PipelineInput,
  runPipeline,
} from "#review/pipeline";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import { DefaultTransportRegistry } from "../../src/transport-registry";
import type { SessionUsage } from "../../src/usage";

// ---------------------------------------------------------------------------
// The materiality gate's pipeline wiring (odd/tasks/materiality-gate.md S2,
// S5-S7, S9, S14). The fake mirrors the real runner's contract: a handler's
// `ok` result carries the output `spec.parse` produced from the final text,
// and a parse failure becomes a failed step, so the judge's real parser
// (parseJudgeVerdict) is exercised, not bypassed.
// ---------------------------------------------------------------------------

type StepScript = Record<string, (spec: StepSpec) => StepResult>;

class FakeStepRunner implements StepRunner {
  readonly specs: StepSpec[] = [];
  constructor(private readonly script: StepScript) {}
  async run(spec: StepSpec): Promise<StepResult> {
    this.specs.push(spec);
    const handler =
      this.script[spec.name] ??
      (spec.name.startsWith("refuter-") ? this.script.refuter : undefined) ??
      (spec.name.startsWith("materiality-")
        ? this.script.materiality
        : undefined);
    if (!handler) throw new Error(`unscripted step ${spec.name}`);
    return handler(spec);
  }
}

function usage(): SessionUsage {
  return {
    wall_ms: 1_000,
    tokens_in: 100,
    tokens_out: 10,
    tokens_total: 110,
    cost_usd_est: 0.01,
  };
}

function ok(spec: StepSpec, output: unknown): StepResult {
  return {
    name: spec.name,
    status: "ok",
    output,
    usage: usage(),
    attempts: 1,
    stderrTail: "",
    resultText: "",
  };
}

function failed(spec: StepSpec): StepResult {
  return {
    name: spec.name,
    status: "failed",
    usage: usage(),
    attempts: 2,
    stderrTail: "API Error: Connection closed mid-response",
    resultText: "",
  };
}

function parsed(spec: StepSpec, finalText: string): StepResult {
  try {
    return ok(spec, spec.parse?.(finalText));
  } catch {
    return failed(spec);
  }
}

// None of these match SAFETY_PATTERN, so each is judgeable. PROTECTED does.
const CLAIMS = {
  width:
    "the cached width is scaled by the device pixel ratio twice, so the " +
    "rendered element ends up at double its intended size on retina screens",
  exporter:
    "the exporter writes whatever unit it received into the manifest " +
    "duration field, so downstream consumers read a broken contract",
  protected:
    "the session token is written to the debug log on every request, so " +
    "anyone reading the log can replay the session",
};

function draft(overrides: Partial<DraftFinding> = {}): DraftFinding {
  return {
    id: "REL-1",
    category: 1,
    path: "src/app.ts",
    line: 10,
    symbol: "run",
    severity: "BLOCKER",
    evidence_class: "deterministic",
    causal_disposition: "introduced",
    claim: CLAIMS.width,
    proof_refs: ["src/app.ts:10"],
    hunter: "reliability",
    hops_used: 0,
    hop_trail: [],
    dedupe_key: "src/app.ts:run:1",
    ...overrides,
  };
}

const HUNTER_TOOLS = "Read, Grep, Glob, mcp__codegraph__codegraph_explore";

async function makeAgentsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-materiality-agents-"));
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

const BUNDLED_MATERIALITY_PROMPT = path.join(
  import.meta.dir,
  "..",
  "..",
  "prompts",
  "materiality.md",
);

const NONCE = "0123456789abcdef0123456789abcdef";

async function makeInput(
  overrides: Partial<PipelineInput> = {},
): Promise<PipelineInput> {
  const runDir = await mkdtemp(path.join(tmpdir(), "pr-hero-materiality-run-"));
  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(diffPath, PATCH);
  const gotchasPath = path.join(runDir, "gotchas.md");
  await Bun.write(
    gotchasPath,
    "G-01: seeded fixture values carry unit contracts.",
  );
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
    boundaryNonce: NONCE,
    ...overrides,
  };
}

const GATE_ON = { materiality: { promptPath: BUNDLED_MATERIALITY_PROMPT } };

// One refuter step per severe finding; each answers for its own id.
const corroborate = (spec: StepSpec): StepResult =>
  ok(spec, {
    results: [
      {
        finding_id: spec.name.slice("refuter-".length),
        outcome: "corroborated",
        proof_refs: [],
      },
    ],
  });

function hunters(findings: DraftFinding[]): StepScript {
  const empty: HunterDraft = { findings: [] };
  return {
    "hunter-reliability": (spec) => ok(spec, { findings }),
    "hunter-resilience": (spec) => ok(spec, empty),
    refuter: corroborate,
  };
}

const verdict = (label: string, reason = "rule 7 speculative hardening") =>
  JSON.stringify({ label, reason });

async function readMaterialityRecord(
  runDir: string,
): Promise<Record<string, unknown>> {
  const plan = JSON.parse(
    await Bun.file(path.join(runDir, "pipeline.json")).text(),
  ) as { materiality: Record<string, unknown> };
  return plan.materiality;
}

const judgeSteps = (runner: FakeStepRunner) =>
  runner.specs.filter((s) => s.name.startsWith("materiality-"));

describe("materiality gate: off by default (S2)", () => {
  test("absent input: no judge step, tiers unchanged, record says skipped", async () => {
    const input = await makeInput();
    const runner = new FakeStepRunner(hunters([draft()]));

    const result = await runPipeline(input, { runner });

    expect(judgeSteps(runner)).toEqual([]);
    expect(result.skillOutput.findings.map((f) => f.tier)).toEqual([
      "blocking",
    ]);
    expect("materiality" in (result.skillOutput.findings[0] ?? {})).toBe(false);
    expect(result.perAgent.materiality).toBeUndefined();
    expect(await readMaterialityRecord(input.runDir)).toEqual({
      enabled: false,
      status: "skipped",
      judged: 0,
      demoted: 0,
      protected: 0,
      failed: 0,
      skipped_unsafe: 0,
      duration_ms: 0,
    });
  });

  test("a prTitle alone, with the gate off, changes nothing", async () => {
    const plain = await makeInput();
    const titled = await makeInput({ prTitle: "fix: width on retina" });
    const a = await runPipeline(plain, {
      runner: new FakeStepRunner(hunters([draft()])),
    });
    const b = await runPipeline(titled, {
      runner: new FakeStepRunner(hunters([draft()])),
    });
    expect(b.skillOutput).toEqual(a.skillOutput);
  });
});

describe("materiality gate: the judge's verdict (S5, S6)", () => {
  test("immaterial demotes a blocking finding to advisory and records why", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, { runner });

    const [finding] = result.skillOutput.findings;
    expect(finding?.tier).toBe("advisory");
    expect(finding?.refuter_verdict).toBe("corroborated");
    expect(finding?.materiality).toEqual({
      label: "immaterial",
      reason: "rule 7 speculative hardening",
    });
    expect(result.skillOutput.run_status).toBe("complete");
    expect(result.perAgent.materiality?.status).toBe("ok");
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      enabled: true,
      status: "ran",
      judged: 1,
      demoted: 1,
      protected: 0,
      failed: 0,
      skipped_unsafe: 0,
      model: "sonnet",
      prompt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("material keeps the finding blocking and unmarked", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("material")),
    });

    const result = await runPipeline(input, { runner });

    const [finding] = result.skillOutput.findings;
    expect(finding?.tier).toBe("blocking");
    expect(finding?.materiality).toBeUndefined();
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      judged: 1,
      demoted: 0,
    });
  });

  test("a safety-protected blocker is never sent and stays blocking", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([
        draft({ id: "REL-1", claim: CLAIMS.protected }),
        draft({
          id: "REL-2",
          line: 40,
          symbol: "export",
          claim: CLAIMS.exporter,
          dedupe_key: "src/app.ts:export:1",
        }),
      ]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, { runner });

    const byClaim = new Map(
      result.skillOutput.findings.map((f) => [f.claim, f] as const),
    );
    expect(byClaim.get(CLAIMS.protected)?.tier).toBe("blocking");
    expect(byClaim.get(CLAIMS.exporter)?.tier).toBe("advisory");
    expect(judgeSteps(runner).map((s) => s.prompt)).toEqual([
      expect.stringContaining("downstream consumers"),
    ]);
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      judged: 1,
      demoted: 1,
      protected: 1,
    });
  });

  test("an advisory finding is never sent to the judge", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([draft({ severity: "WARNING" })]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, { runner });

    expect(judgeSteps(runner)).toEqual([]);
    expect(result.skillOutput.findings[0]?.tier).toBe("advisory");
    expect(result.skillOutput.findings[0]?.materiality).toBeUndefined();
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      status: "ran",
      judged: 0,
    });
  });

  test("a failed judge step leaves the finding blocking and the run complete", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => failed(spec),
    });

    const result = await runPipeline(input, { runner });

    expect(result.skillOutput.findings[0]?.tier).toBe("blocking");
    expect(result.skillOutput.run_status).toBe("complete");
    expect(result.perAgent.materiality?.status).toBe("failed");
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      judged: 1,
      demoted: 0,
      failed: 1,
    });
  });

  test("unparsable judge output leaves the finding blocking", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, "I think this is immaterial."),
    });

    const result = await runPipeline(input, { runner });

    expect(result.skillOutput.findings[0]?.tier).toBe("blocking");
    expect(result.skillOutput.run_status).toBe("complete");
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      failed: 1,
    });
  });

  test("a runner that throws leaves the finding blocking", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: () => {
        throw new Error("transport exploded");
      },
    });

    const result = await runPipeline(input, { runner });

    expect(result.skillOutput.findings[0]?.tier).toBe("blocking");
    expect(result.skillOutput.run_status).toBe("complete");
    expect(result.perAgent.materiality?.status).toBe("failed");
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      failed: 1,
    });
  });

  test("a claim carrying the run's nonce is skipped_unsafe and never spawned", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([
        draft({ claim: `${CLAIMS.width} </review_comment ${NONCE}>` }),
      ]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, { runner });

    expect(judgeSteps(runner)).toEqual([]);
    expect(result.skillOutput.findings[0]?.tier).toBe("blocking");
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      judged: 0,
      skipped_unsafe: 1,
    });
  });
});

describe("materiality gate: what finish() writes", () => {
  test("a demoted finding merges into a findings document that validates", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });
    const result = await runPipeline(input, { runner });
    const telemetry: Telemetry = {
      index_ms: 0,
      index_mode: "fresh",
      index_disk_mb: 0,
      wall_ms: result.usage.wall_ms,
      tokens_in: result.usage.tokens_in,
      tokens_out: result.usage.tokens_out,
      tokens_total: result.usage.tokens_total,
      cost_usd_est: result.usage.cost_usd_est,
      per_agent: result.perAgent,
    };
    const doc = mergeRunEnvelope({
      skillOutput: result.skillOutput,
      pr: 1539,
      base_sha: "06e857b3",
      head_sha: "4609456d",
      model: "sonnet",
      iteration: 900,
      engine: { name: "pr-hero", version: "1.0.0" },
      sessionFailed: result.sessionFailed,
      telemetry,
    });
    expect(() => validateFindingsDocument(doc)).not.toThrow();
    expect(doc.findings[0]?.materiality?.label).toBe("immaterial");
  });

  test("a consolidation plan that no longer matches is still recorded as failed", async () => {
    // Pre-existing finish() behaviour that moved into tierFindings. The fake
    // hands back a plan WITHOUT going through spec.parse, naming an id
    // finish() never produces, so finish()'s re-validation is what rejects it
    // and the findings post unconsolidated.
    const input = await makeInput({
      consolidate: {
        promptPath: path.join(
          import.meta.dir,
          "..",
          "..",
          "prompts",
          "consolidate.md",
        ),
      },
    });
    const runner = new FakeStepRunner({
      ...hunters([
        draft(),
        draft({
          id: "REL-2",
          line: 40,
          symbol: "export",
          claim: CLAIMS.exporter,
          dedupe_key: "src/app.ts:export:1",
        }),
      ]),
      consolidate: (spec) =>
        ok(spec, [
          { primary: "F001", sources: ["F001"], split: false, claim: "a" },
          { primary: "F009", sources: ["F009"], split: false, claim: "ghost" },
        ]),
    });

    const result = await runPipeline(input, { runner });

    const plan = JSON.parse(
      await Bun.file(path.join(input.runDir, "pipeline.json")).text(),
    ) as { consolidation: Record<string, unknown> };
    expect(plan.consolidation).toMatchObject({
      status: "failed",
      reason: "plan no longer matches findings",
      findings_out: 2,
    });
    expect(result.skillOutput.findings.map((f) => f.id)).toEqual([
      "F001",
      "F002",
    ]);
  });
});

describe("materiality gate: consolidation cannot launder a protected finding (S4)", () => {
  test("a protected finding folded into a benign primary keeps the primary protected", async () => {
    const input = await makeInput({
      ...GATE_ON,
      consolidate: {
        promptPath: path.join(
          import.meta.dir,
          "..",
          "..",
          "prompts",
          "consolidate.md",
        ),
      },
    });
    const runner = new FakeStepRunner({
      ...hunters([
        draft({ claim: CLAIMS.protected }),
        draft({
          id: "REL-2",
          line: 40,
          symbol: "export",
          claim: CLAIMS.exporter,
          dedupe_key: "src/app.ts:export:1",
        }),
      ]),
      consolidate: (spec) =>
        ok(spec, [
          {
            primary: "F002",
            sources: ["F001", "F002"],
            split: false,
            claim:
              "the request handler logs per-request state twice, which is noisy",
          },
        ]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, { runner });

    expect(judgeSteps(runner)).toEqual([]);
    expect(result.skillOutput.findings.map((f) => [f.id, f.tier])).toEqual([
      ["F002", "blocking"],
    ]);
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      judged: 0,
      demoted: 0,
      protected: 1,
    });
  });
});

describe("materiality gate: a path-protected source survives consolidation (S4)", () => {
  test("a finding protected only by its path keeps the merged primary protected", async () => {
    const input = await makeInput({
      ...GATE_ON,
      consolidate: {
        promptPath: path.join(
          import.meta.dir,
          "..",
          "..",
          "prompts",
          "consolidate.md",
        ),
      },
    });
    const runner = new FakeStepRunner({
      ...hunters([
        draft({
          path: "src/auth/session.ts",
          proof_refs: ["src/auth/session.ts:10"],
          dedupe_key: "src/auth/session.ts:run:1",
        }),
        draft({
          id: "REL-2",
          line: 40,
          symbol: "export",
          claim: CLAIMS.exporter,
          dedupe_key: "src/app.ts:export:1",
        }),
      ]),
      consolidate: (spec) =>
        ok(spec, [
          {
            primary: "F002",
            sources: ["F001", "F002"],
            split: false,
            claim:
              "the request handler logs per-request state twice, which is noisy",
          },
        ]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, { runner });

    expect(judgeSteps(runner)).toEqual([]);
    expect(result.skillOutput.findings.map((f) => f.tier)).toEqual([
      "blocking",
    ]);
  });
});

describe("materiality gate: the spawned step (S3, S9)", () => {
  async function worktreeWith(file: string, text: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-materiality-wt-"));
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await Bun.write(path.join(dir, file), text);
    return dir;
  }
  const fileText = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );

  test("tools [], an empty MCP registry, sonnet even under --model opus", async () => {
    const worktree = await worktreeWith("src/app.ts", fileText);
    const input = await makeInput({
      ...GATE_ON,
      worktree,
      model: "opus",
      prTitle: "fix: width on retina",
    });
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("material")),
    });

    await runPipeline(input, { runner });

    const [judge] = judgeSteps(runner);
    expect(judge?.name).toBe("materiality-F001");
    expect(judge?.tools).toEqual([]);
    expect(judge?.model).toBe("sonnet");
    expect(judge?.mcpConfigPath).not.toBe(input.mcpConfigPath);
    expect(await Bun.file(judge?.mcpConfigPath ?? "").text()).toBe(
      '{"mcpServers":{}}',
    );
    expect(judge?.timeoutMs).toBe(3 * 60 * 1000);
    expect(judge?.maxAttempts).toBe(2);
    // Hunters do run on the overridden model; only the judge is pinned.
    expect(
      runner.specs.find((s) => s.name === "hunter-reliability")?.model,
    ).toBe("opus");

    const prompt = judge?.prompt ?? "";
    expect(prompt).toContain(`<pr_title ${NONCE}>`);
    expect(prompt).toContain("fix: width on retina");
    expect(prompt).toContain(`<review_comment ${NONCE}>`);
    expect(prompt).toContain(`<code_window ${NONCE}>`);
    expect(prompt).toContain("10> line 10");
    expect(prompt).toContain("35  line 35");
    expect(prompt).not.toContain("line 36");

    const system = await Bun.file(judge?.systemPromptPath ?? "").text();
    expect(system).toContain("Runtime safety");
    expect(system).toContain("Posting policy (materiality)");
  });

  test("no title: the prompt carries the fallback", async () => {
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("material")),
    });

    await runPipeline(input, { runner });

    expect(judgeSteps(runner)[0]?.prompt).toContain(MATERIALITY_TITLE_FALLBACK);
    expect(MATERIALITY_TITLE_FALLBACK).toBe("(title unavailable)");
  });

  test("a path that walks out of the worktree is judged without a window", async () => {
    // Not "secret.txt": a path the safety guard matches is never judged.
    const outside = await worktreeWith("notes.txt", "OUTSIDE CONTENT");
    const worktree = await worktreeWith("src/app.ts", fileText);
    await symlink(
      path.join(outside, "notes.txt"),
      path.join(worktree, "link.txt"),
    );
    const escaped = path.relative(worktree, path.join(outside, "notes.txt"));
    const input = await makeInput({ ...GATE_ON, worktree });
    const runner = new FakeStepRunner({
      ...hunters([
        draft({ id: "REL-1", path: escaped, line: 1 }),
        draft({
          id: "REL-2",
          path: "link.txt",
          line: 1,
          claim: CLAIMS.exporter,
          dedupe_key: "link.txt:run:1",
        }),
      ]),
      materiality: (spec) => parsed(spec, verdict("material")),
    });

    await runPipeline(input, { runner });

    const prompts = judgeSteps(runner).map((s) => s.prompt);
    expect(prompts.length).toBe(2);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("OUTSIDE CONTENT");
      expect(prompt).not.toContain("code_window");
    }
  });
});

describe("materiality gate: route and ceiling (S14, S5)", () => {
  test("a caller plan with no judge step stands down rather than spawn route-less", async () => {
    const claude = (stepKey: string, role: string) =>
      resolveStepRoute({ stepKey, role, specModel: "sonnet" });
    const routePlan = createResolvedRoutePlan([
      claude("hunter-reliability", "hunter"),
      claude("hunter-resilience", "hunter"),
      claude("hunter-parity", "hunter"),
      claude("refuter", "refuter"),
    ]);
    const input = await makeInput({ ...GATE_ON, routePlan });
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, {
      runner,
      transportRegistry: new DefaultTransportRegistry(),
    });

    expect(judgeSteps(runner)).toEqual([]);
    expect(result.skillOutput.findings[0]?.tier).toBe("blocking");
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      enabled: true,
      status: "unsupported_route",
      reason: "route plan carries no judge step",
      judged: 0,
    });
  });

  test("a caller plan with a claude-code judge step spawns it on that route", async () => {
    const claude = (stepKey: string, role: string, model = "sonnet") =>
      resolveStepRoute({ stepKey, role, specModel: model });
    const routePlan = createResolvedRoutePlan([
      claude("hunter-reliability", "hunter"),
      claude("hunter-resilience", "hunter"),
      claude("hunter-parity", "hunter"),
      claude("refuter", "refuter"),
      claude("materiality", "other", "sonnet"),
    ]);
    const input = await makeInput({ ...GATE_ON, routePlan });
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, {
      runner,
      transportRegistry: new DefaultTransportRegistry(),
    });

    expect(judgeSteps(runner)[0]?.route?.backend).toBe("claude-code");
    expect(result.skillOutput.findings[0]?.tier).toBe("advisory");
  });

  test("an in-run plan built over routing that sends sonnet to OpenCode stands down", async () => {
    // Hunters moved to haiku so the sonnet→OpenCode mapping reaches only the
    // judge: the hunters share the judge's alias by default.
    const input = await makeInput({
      ...GATE_ON,
      model: "haiku",
      routingConfig: {
        mappings: [
          {
            logical: "sonnet",
            backend: "opencode",
            provider: "anthropic",
            modelSnapshot: "claude-sonnet-5-5",
          },
        ],
      },
    });
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, { runner });

    expect(judgeSteps(runner)).toEqual([]);
    expect(result.skillOutput.findings[0]?.tier).toBe("blocking");
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      status: "unsupported_route",
      reason: "judge route is not the measured claude-code route",
    });
  });

  test("a claude-code judge step behind a non-direct gateway stands down", async () => {
    // claude-code over openrouter passes the snapshot verbatim as --model:
    // a different, unmeasured judge, so the gate must not run it.
    const claude = (stepKey: string, role: string) =>
      resolveStepRoute({ stepKey, role, specModel: "sonnet" });
    const judge = claude("materiality", "other");
    const routePlan = createResolvedRoutePlan([
      claude("hunter-reliability", "hunter"),
      claude("hunter-resilience", "hunter"),
      claude("hunter-parity", "hunter"),
      claude("refuter", "refuter"),
      {
        ...judge,
        route: {
          ...judge.route,
          gateway: "openrouter",
          modelSnapshot: "other/model",
        },
      },
    ]);
    const input = await makeInput({ ...GATE_ON, routePlan });
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, {
      runner,
      transportRegistry: new DefaultTransportRegistry(),
    });

    expect(judgeSteps(runner)).toEqual([]);
    expect(result.skillOutput.findings[0]?.tier).toBe("blocking");
    // The reason names the rejected route in hand, not a re-resolution from
    // config (which, absent here, would claim the plan has no judge step).
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      status: "unsupported_route",
      reason: "judge route is not the measured claude-code route",
    });
  });

  test("a queued fan-out judges only what fits the ceiling; the rest stays blocking", async () => {
    // max_concurrent_steps 1 queues the judge steps one after another, so
    // the budget is per wave, not per step: one 9-minute wave fits a 13.5
    // minute ceiling, a second does not.
    const input = await makeInput({
      ...GATE_ON,
      pipelineTimeoutMs: 810_000,
      ceilingGraceMs: 10,
      config: {
        effective: { max_concurrent_steps: 1 },
        sources: {},
        global_present: false,
      } as unknown as PipelineInput["config"],
    });
    const runner = new FakeStepRunner({
      ...hunters([
        draft(),
        draft({
          id: "REL-2",
          line: 40,
          symbol: "export",
          claim: CLAIMS.exporter,
          dedupe_key: "src/app.ts:export:1",
        }),
      ]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, { runner });

    expect(judgeSteps(runner).map((s) => s.name)).toEqual(["materiality-F001"]);
    expect(result.skillOutput.findings.map((f) => [f.id, f.tier])).toEqual([
      ["F001", "advisory"],
      ["F002", "blocking"],
    ]);
    expect(result.skillOutput.run_status).toBe("complete");
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      status: "ran",
      judged: 1,
      demoted: 1,
      reason: "ceiling budget: judged 1 of 2",
    });
  });

  test("not enough ceiling budget: status ceiling, nothing spawned, finding blocking", async () => {
    // The ceiling itself is far away; only the judge's worst case does not
    // fit inside it, so the run is complete and the gate stands down.
    const input = await makeInput({
      ...GATE_ON,
      pipelineTimeoutMs: 60_000,
      ceilingGraceMs: 10,
    });
    const runner = new FakeStepRunner({
      ...hunters([draft()]),
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, { runner });

    expect(judgeSteps(runner)).toEqual([]);
    expect(result.skillOutput.findings[0]?.tier).toBe("blocking");
    expect(result.skillOutput.run_status).toBe("complete");
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      enabled: true,
      status: "ceiling",
      reason: "ceiling budget",
    });
  });

  test("an aborted ceiling: the judge never runs and the record says ceiling", async () => {
    const controller = new AbortController();
    const input = await makeInput(GATE_ON);
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) => {
        // The ceiling fires while the hunters are out.
        controller.abort();
        return ok(spec, { findings: [draft()] });
      },
      "hunter-resilience": (spec) => ok(spec, { findings: [] }),
      refuter: corroborate,
      materiality: (spec) => parsed(spec, verdict("immaterial")),
    });

    const result = await runPipeline(input, {
      runner,
      ceilingController: controller,
    });

    expect(judgeSteps(runner)).toEqual([]);
    expect(
      result.skillOutput.findings.every((f) => f.materiality === undefined),
    ).toBe(true);
    expect(await readMaterialityRecord(input.runDir)).toMatchObject({
      enabled: true,
      status: "ceiling",
      judged: 0,
    });
  });
});
