// Refuter-discrimination probe (ROADMAP A2 diagnostic — NOT a benchmark arm).
//
// Feeds the REAL A2 refuter one finding per run, on the REAL model, and
// asserts the verdict. A calibration matrix over the verdict vocabulary A2
// introduced — four arms over the same fixture repo:
//   - `true-claim`       (control)  — accurate claim          → `corroborated`
//   - `false-claim`      (easy)     — contradicted nearby     → `refuted`
//   - `hard-false-claim` (depth)    — contradicted 3 files up → `refuted`
//   - `latent-claim`     (G6)       — real, unreachable code  → `downgraded-latent`
// See fixtures/refuter-probe.ts for why a fixture can answer this and a replay
// cannot, and for how each arm is planted.
//
// WHAT A RESULT MEANS
//   false-claim `refuted`         → the gate DISCRIMINATES. A2's 15/15
//                                   `corroborated` is then most plausibly
//                                   genuine hunter precision, and the
//                                   precision claim stands.
//   false-claim `corroborated`    → the v2 refuter is DEFERENTIAL: it
//                                   rubber-stamps whatever it is handed, and
//                                   A2's precision claim is unsupported by
//                                   that measurement. The lever moves to the
//                                   refuter prompt, not the hunters.
//   false-claim `inconclusive`    → not a polite refutation. The gate could
//                                   not tell with the contradicting guard one
//                                   line below the cited signature. Neither
//                                   verdict blocks a merge, so the practical
//                                   consequence matches deference — reported
//                                   separately because the fix differs.
//   false-claim `downgraded-late` → the fixture's live caller wiring broke;
//                                   treat the run as void, not as a result.
//   true-claim not `corroborated` → the PROBE is suspect. Every test arm means
//                                   nothing until the control passes.
//
//   hard-false `refuted`          → the gate does not just spot adjacent
//                                   contradictions, it WALKS the call chain:
//                                   three hops and three files out, and it
//                                   still found the clamp. This is the result
//                                   that would let A2's precision claim
//                                   generalise past toy distance.
//   hard-false `corroborated`     → the gate only catches OBVIOUS
//                                   contradictions. Whatever the easy arm
//                                   scored, refutation is a local text check,
//                                   not verification — so on real PRs, where
//                                   the disproof is never two lines away, it
//                                   should be expected to rubber-stamp.
//   hard-false `inconclusive`     → same practical consequence (nothing is
//                                   deleted), different fix: the gate knows it
//                                   did not verify. A depth/hop budget or an
//                                   explicit "follow the value" mandate is the
//                                   lever, not a stronger scepticism prompt.
//
//   latent `downgraded-latent`    → the G6 lesson HOLDS. A real defect nothing
//                                   can execute is kept, recorded, and left
//                                   advisory — the verdict A2 added the
//                                   vocabulary for, tested for the first time.
//   latent `refuted`              → the engine would DELETE a real defect.
//                                   This is exactly the G6 failure A2 exists
//                                   to prevent, and it is the most expensive
//                                   outcome on the whole matrix: refuted
//                                   findings leave findings[] entirely.
//   latent `corroborated`         → the engine would BLOCK a merge on code
//                                   nothing can run. Not a deletion, so far
//                                   cheaper than the above, but it is the
//                                   false-positive tax the latent verdict was
//                                   introduced to remove.
//   latent `inconclusive`         → the reachability question was never
//                                   answered. Advisory either way, but it says
//                                   the gate does not look for callers at all.
//
// LIVE: spends real money (charter rule 6 — the result lands in a ledger). One
// refuter step per attempt over a nine-file repo; the hunter leg is faked and
// free. The figures below were measured while the refuter ran on sonnet, so
// they UNDERSTATE an opus run and no opus figure has been recorded yet: the
// first two arms measured ~$0.10 per step (3 replicates x 2 arms = $0.5776);
// the new arms traverse more files, so a default 3 x 4 run was forecast near
// $1.5 on sonnet — still far below the ~$10 replay that cannot answer this
// question at all.
//
// Run: bun run scripts/refuter-probe.ts [replicates]
import path from "node:path";
import type { DraftFinding, HunterDraft, RefuterResult } from "#review/drafts";
import type { RefuterVerdict } from "#review/findings";
import { runPipeline } from "#review/pipeline";
import type { ReviewSpec } from "#review/spec";
import {
  ClaudeCodeRunner,
  type StepResult,
  type StepRunner,
  type StepSpec,
} from "#review/step-runner";
import {
  buildRefuterProbeFixture,
  EXPECTED_VERDICT,
  HUNTER_AGENT_FILE,
  HUNTER_KEY,
  PROBE_ARMS,
  type ProbeArm,
  REFUTER_AGENT_FILE,
} from "../fixtures/refuter-probe";
import { resolveRunnerAuthority } from "../src/runner-authority";
import { zeroUsage } from "../src/usage";

const REPLICATES = Number(process.argv[2] ?? 3);
const REFUTER_SOURCE_PATH = path.resolve(
  import.meta.dir,
  "../prompts/default/review-refuter.md",
);
// The production refuter model: it must equal the `model:` in
// prompts/default/review-refuter.md (test/review/preflight-bundled-prompts.test.ts
// asserts that value). A haiku refuter would answer a different question —
// this probe is about the v2 PROMPT's deference, not about what a cheap model
// can verify. Set on the AgentSpec on purpose, so the probe is pinned even if
// the agent file's frontmatter is later retuned; that also means retuning the
// frontmatter does NOT move this constant, and a probe run on a model
// production no longer uses proves nothing about production.
const REFUTER_MODEL = "opus";
// Effort is deliberately NOT pinned beside it: the fixture carries the refuter
// prompt verbatim, so the step runs at the `effort:` the frontmatter declares
// (`high`, #299), i.e. the production level. A pass at a lower level is not
// evidence for it: 16/16 at `medium` did not predict that `medium` refutes a
// real, known blocker on actual findings (3 of 4 verdicts on pr-1858).

// One hunter (never spawned — see the runner below) and one refuter, which is
// the minimum the pipeline accepts. The hunter is non-parity, so the
// conditional parity leg cannot fire.
const PROBE_SPEC: ReviewSpec = {
  agents: [
    { key: HUNTER_KEY, file: HUNTER_AGENT_FILE, role: "hunter" },
    {
      key: "refuter",
      file: REFUTER_AGENT_FILE,
      role: "refuter",
      model: REFUTER_MODEL,
    },
  ],
};

const refuterSource = await Bun.file(REFUTER_SOURCE_PATH).text();

// THE ENGINE SEAM. Hunter steps are answered with a canned draft carrying the
// arm's planted finding — free, deterministic, and not what is under test.
// Refuter steps go to a real ClaudeCodeRunner, so the genuine refuterPrompt,
// refuter.system.md write, isolation argv, retry ordering, watchdog,
// validateRefuterResult and verdict→tier mapping all stay in the path. A
// reimplementation of that leg would measure the reimplementation.
class PlantedDraftRunner implements StepRunner {
  constructor(
    private readonly draft: DraftFinding,
    private readonly live: StepRunner,
  ) {}

  async run(spec: StepSpec): Promise<StepResult> {
    if (spec.name.startsWith("refuter-")) return this.live.run(spec);
    if (!spec.name.startsWith("hunter-")) {
      // An unrecognised step name means the spec drifted; failing loudly beats
      // quietly answering it with the planted draft.
      throw new Error(`refuter probe: unexpected step ${spec.name}`);
    }
    const output: HunterDraft = { findings: [this.draft] };
    return {
      name: spec.name,
      status: "ok",
      output,
      // Zero on purpose: a fabricated bill for the fake leg would pollute the
      // only cost figure this probe reports honestly, the refuter's own.
      usage: zeroUsage(),
      attempts: 1,
      stderrTail: "",
      resultText: "",
    };
  }
}

interface Attempt {
  arm: ProbeArm;
  replicate: number;
  expected_verdict: RefuterVerdict;
  // The verdict STRING, never a boolean: `downgraded-latent` and
  // `inconclusive` are distinct outcomes with distinct diagnoses, and
  // collapsing them would destroy the result.
  verdict: RefuterVerdict;
  matched: boolean;
  refuter_cost_usd: number;
  refuter_status: string;
  run_status: string;
  refuter_proof_refs: string[];
  run_dir: string;
}

// The refuter's OWN proof refs never reach the SkillOutput — the pipeline keeps
// the outcome and drops the rest — so they are read back from the step
// artifact. They are the record of the own-expansion Mandate 1 demands, and the
// fastest way to tell a real refutation from a rubber stamp.
async function readRefuterProofRefs(
  runDir: string,
  findingId: string,
): Promise<string[]> {
  const artifact = Bun.file(
    path.join(runDir, "steps", `refuter-${findingId}.result.json`),
  );
  if (!(await artifact.exists())) return [];
  const parsed = (await artifact.json()) as RefuterResult;
  return parsed.results.flatMap((r) => r.proof_refs);
}

async function runOnce(arm: ProbeArm, replicate: number): Promise<Attempt> {
  const fixture = await buildRefuterProbeFixture(arm, refuterSource);

  // Empty MCP registry + the runner's --strict-mcp-config: the probe repo has
  // no codegraph index, so the refuter works from Read/Grep/Glob and nothing
  // else can leak in. Identical for both arms.
  const mcpConfigPath = path.join(fixture.runDir, "mcp.json");
  await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

  const runnerAuthority = await resolveRunnerAuthority({
    workspaceRoot: fixture.repoDir,
  });
  if (runnerAuthority.error !== undefined) {
    throw new Error(
      `execution authority unavailable: ${runnerAuthority.error}`,
    );
  }

  // §5.3 D1-10b: ONE controller shared by the pipeline and the runner. The
  // pipeline aborts it when the ceiling fires; the runner's harness reads the
  // same signal and refuses to start another attempt, so in-flight steps stop
  // instead of billing on past a report that has already been returned. Two
  // controllers would leave the ceiling unable to stop the steps it is waiting
  // on — and this probe spends real money.
  const ceilingController = new AbortController();
  const result = await runPipeline(
    {
      pr: 0,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      worktree: fixture.repoDir,
      diffPath: fixture.diffPath,
      gotchasPath: fixture.gotchasPath,
      agentsDir: fixture.agentsDir,
      runDir: fixture.runDir,
      outPath: path.join(fixture.runDir, "findings.json"),
      mcpConfigPath,
      hopBudget: 4,
      parityTriggerPaths: [],
      // Priors template into HUNTER bodies only, and this run's hunter is a
      // fake that is never spawned. The refuter body anchors {{GOTCHAS}} (the
      // repository facts, rendered from fixture.gotchasPath) but no
      // {{PRIORS}}, so empty priors keep the probe honest.
      suspicionPriors: [],
      stepTimeoutMs: 10 * 60 * 1000,
      spec: PROBE_SPEC,
    },
    {
      runner: new PlantedDraftRunner(
        fixture.draft,
        new ClaudeCodeRunner({
          ...runnerAuthority.runnerOptions,
          signal: ceilingController.signal,
        }),
      ),
      ceilingController,
    },
  );

  // `refuted` findings LEAVE findings[] for debug.refuted; every other verdict
  // stays in findings[] carrying refuter_verdict — `downgraded-latent` included
  // (pipeline.ts finish(): only `refuted` is diverted, the rest are tiered, and
  // deriveTier() lands `downgraded-latent` on advisory). Both places are read,
  // and the id is taken from the row rather than assumed — mergeAndDedupe
  // renumbers to F001 before the refuter runs, so the hunter's id is gone.
  const { skillOutput } = result;
  const rows = [...skillOutput.findings, ...skillOutput.debug.refuted];
  const row = rows[0];
  if (rows.length !== 1 || !row) {
    throw new Error(
      `refuter probe (${arm} #${replicate}): expected exactly one survivor, ` +
        `got ${rows.length}`,
    );
  }
  const refuter = result.perAgent.refuter;

  return {
    arm,
    replicate,
    expected_verdict: fixture.expectedVerdict,
    verdict: row.refuter_verdict,
    matched: row.refuter_verdict === fixture.expectedVerdict,
    // The refuter's bill alone. The whole-run total is inflated by nothing
    // here, but reporting per-agent keeps this comparable with a real run.
    refuter_cost_usd: refuter?.cost_usd_est ?? 0,
    refuter_status: refuter?.status ?? "missing",
    run_status: skillOutput.run_status,
    refuter_proof_refs: await readRefuterProofRefs(fixture.runDir, row.id),
    run_dir: fixture.runDir,
  };
}

const attempts: Attempt[] = [];
// Interleaved rather than grouped, so any drift in service behaviour over the
// probe's wall-clock hits every arm evenly instead of loading one of them. The
// arm list comes from the fixture: the matrix is declared once.
for (let r = 1; r <= REPLICATES; r++) {
  for (const arm of PROBE_ARMS) {
    const attempt = await runOnce(arm, r);
    attempts.push(attempt);
    console.error(
      `[${arm} #${r}] verdict=${attempt.verdict} ` +
        `expected=${attempt.expected_verdict} ` +
        `$${attempt.refuter_cost_usd.toFixed(4)} ${attempt.run_dir}`,
    );
  }
}

const summarise = (arm: ProbeArm) => {
  const rows = attempts.filter((a) => a.arm === arm);
  const verdicts: Record<string, number> = {};
  for (const row of rows) {
    verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1;
  }
  return {
    arm,
    expected_verdict: EXPECTED_VERDICT[arm],
    runs: rows.length,
    matched: rows.filter((a) => a.matched).length,
    verdicts,
    // Strict: every replicate must land on the expected verdict. The tally is
    // the real signal — variance is high and a single run proves nothing
    // (charter rule 7) — but a per-arm pass/fail stops a gate that
    // discriminates only sometimes from being read as one that always does.
    pass: rows.length > 0 && rows.every((a) => a.matched),
    refuter_cost_usd: Number(
      rows.reduce((s, a) => s + a.refuter_cost_usd, 0).toFixed(4),
    ),
  };
};

console.log(
  JSON.stringify(
    {
      replicates: REPLICATES,
      refuter_source: REFUTER_SOURCE_PATH,
      refuter_model: REFUTER_MODEL,
      "true-claim": summarise("true-claim"),
      "false-claim": summarise("false-claim"),
      "hard-false-claim": summarise("hard-false-claim"),
      "latent-claim": summarise("latent-claim"),
      total_refuter_cost_usd: Number(
        attempts.reduce((s, a) => s + a.refuter_cost_usd, 0).toFixed(4),
      ),
      attempts,
    },
    null,
    2,
  ),
);
