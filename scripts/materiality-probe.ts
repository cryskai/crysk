// Materiality judge exam (Stage 2 noise yardstick, step 1 — NOT a benchmark arm).
//
// Before the judge labels a single engine finding, it must label anchors whose
// answer is already known, and clear the pass bar fixed in
// src/compare/materiality.ts:
//   - material:   Martian goldens rated High/Critical, all five public corpora
//                 (docs/benchmarks/martian-*-goldens.json). Labelled by Martian.
//   - immaterial: planted claims that are true but not worth posting
//                 (docs/benchmarks/materiality-planted-anchors.json).
//   - stability:  a fixed subset judged three times must keep its label.
// Martian Low style/speculative/doc_defect comments are reported as a
// secondary immaterial signal and never gate.
//
// WHAT A RESULT MEANS
//   passed      → the judge can label engine findings for the noise baseline.
//   material ✗  → it waves real bugs away; any noise number it produced would
//                 flatter a prompt that finds less.
//   immaterial ✗→ it calls nits material; it would hide exactly the noise
//                 Stage 2 is trying to remove.
//   stability ✗ → its labels are coin flips; no single-run number means much.
//
// One isolated spawn per claim: tools [], empty MCP config, model opus (the
// hunters run sonnet, so the judge never grades its own model's output).
//
// LIVE (`run`): spends real money; the result lands in the lab ledger the same
// day (charter rule 6). `plan` and `score` are $0.
//
//   bun run scripts/materiality-probe.ts plan
//   bun run scripts/materiality-probe.ts run [--out <dir>] [--concurrency <n>]
//   bun run scripts/materiality-probe.ts score <results.json>
//
// `run` checkpoints every judgment to runs.partial.json next to results.json;
// `score runs.partial.json` rescores an interrupted run.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { MartianGoldenPr } from "#compare/martian-adapter";
import {
  type Anchor,
  type ExamScore,
  goldenAnchors,
  JUDGE_SYSTEM,
  type JudgeRun,
  judgeSystemSha256,
  PASS_BAR,
  type PlantedAnchor,
  parseJudgeVerdict,
  plantedAnchors,
  renderJudgePrompt,
  scoreExam,
  stabilitySubset,
} from "#compare/materiality";
import { defaultEffortForRole } from "#model/catalog";
import { ClaudeCodeRunner } from "#review/step-runner";
import { resolveRunnerAuthority } from "../src/runner-authority";

const ROOT = path.join(import.meta.dir, "..");
const BENCH = path.join(ROOT, "docs", "benchmarks");
const CORPORA = ["cal", "discourse", "grafana", "keycloak", "sentry"];
const JUDGE_MODEL = "opus";
const STABILITY_PER_LABEL = 15;
const REPLICATES = 3;

interface Job {
  anchorId: string;
  replicate: number;
}

interface ResultsFile {
  judge_model: string;
  judge_system_sha256: string;
  pass_bar: typeof PASS_BAR;
  started_at: string;
  finished_at: string;
  cost_usd_est: number;
  anchors: Anchor[];
  runs: JudgeRun[];
  score: ExamScore;
}

function fail(message: string): never {
  console.error(`materiality-probe: ${message}`);
  process.exit(1);
}

async function loadAnchors(): Promise<Anchor[]> {
  const anchors: Anchor[] = [];
  for (const corpus of CORPORA) {
    const goldens = (await Bun.file(
      path.join(BENCH, `martian-${corpus}-goldens.json`),
    ).json()) as MartianGoldenPr[];
    anchors.push(...goldenAnchors(corpus, goldens));
  }
  const planted = (await Bun.file(
    path.join(BENCH, "materiality-planted-anchors.json"),
  ).json()) as { anchors: PlantedAnchor[] };
  anchors.push(...plantedAnchors(planted.anchors));
  return anchors;
}

function buildJobs(anchors: Anchor[]): Job[] {
  const jobs: Job[] = anchors.map((a) => ({ anchorId: a.id, replicate: 0 }));
  for (const id of stabilitySubset(anchors, STABILITY_PER_LABEL)) {
    for (let r = 1; r < REPLICATES; r += 1) {
      jobs.push({ anchorId: id, replicate: r });
    }
  }
  return jobs;
}

function describeAnchors(anchors: Anchor[], jobs: Job[]): string[] {
  const count = (pick: (a: Anchor) => boolean) => anchors.filter(pick).length;
  return [
    `material (gating):     ${count((a) => a.role === "gating" && a.expected === "material")}`,
    `immaterial (gating):   ${count((a) => a.role === "gating" && a.expected === "immaterial")}`,
    `immaterial (secondary): ${count((a) => a.role === "secondary")}`,
    `stability subset:      ${STABILITY_PER_LABEL} + ${STABILITY_PER_LABEL} anchors x ${REPLICATES} runs`,
    `judge spawns:          ${jobs.length}`,
    `judge model:           ${JUDGE_MODEL}  (tools [], empty MCP)`,
    `judge system sha256:   ${judgeSystemSha256()}`,
    `pass bar:              material >= ${PASS_BAR.material * 100}%, immaterial >= ${PASS_BAR.immaterial * 100}%, stability >= ${PASS_BAR.stability * 100}%`,
  ];
}

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function renderScore(score: ExamScore): string[] {
  const line = (name: string, r: ExamScore["material"]) =>
    `${name.padEnd(22)} ${pct(r.rate).padStart(6)}  (${r.hits}/${r.judged}, ${r.failed} failed)`;
  return [
    line("material", score.material),
    line("immaterial", score.immaterial),
    line("stability", score.stability),
    line("secondary immaterial", score.secondaryImmaterial),
    score.passed ? "PASSED" : `FAILED: ${score.reasons.join("; ")}`,
  ];
}

async function judgeOne(
  anchor: Anchor,
  replicate: number,
): Promise<{ run: JudgeRun; cost: number }> {
  const tmp = mkdtempSync(path.join(tmpdir(), "materiality-judge-"));
  try {
    const systemPromptPath = path.join(tmp, "system.md");
    const mcpConfigPath = path.join(tmp, "mcp.json");
    writeFileSync(systemPromptPath, JUDGE_SYSTEM);
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    chmodSync(systemPromptPath, 0o600);
    // Re-resolved per spawn: workspaceRoot must name the tmp dir this judge
    // actually runs in.
    const authority = await resolveRunnerAuthority({ workspaceRoot: tmp });
    if (authority.error !== undefined) {
      // Thrown, not fail(): the worker records it as this claim's error, so
      // one bad spawn never discards the judgments already paid for.
      throw new Error(`execution authority unavailable: ${authority.error}`);
    }
    const result = await new ClaudeCodeRunner(authority.runnerOptions).run({
      name: `materiality-${anchor.id}-${replicate}`,
      systemPromptPath,
      prompt: renderJudgePrompt(anchor.prTitle, anchor.claim),
      tools: [],
      mcpConfigPath,
      model: JUDGE_MODEL,
      effort: defaultEffortForRole("other"),
      cwd: tmp,
      outPath: path.join(tmp, "out.json"),
      timeoutMs: 3 * 60 * 1000,
      maxAttempts: 2,
      parse: parseJudgeVerdict,
    });
    const cost = result.usage.cost_usd_est;
    if (result.status !== "ok" || result.output === undefined) {
      return {
        run: {
          anchorId: anchor.id,
          replicate,
          label: null,
          error: result.stderrTail.slice(-300),
        },
        cost,
      };
    }
    const verdict = result.output as ReturnType<typeof parseJudgeVerdict>;
    return {
      run: {
        anchorId: anchor.id,
        replicate,
        label: verdict.label,
        reason: verdict.reason,
      },
      cost,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function run(args: string[]): Promise<void> {
  const anchors = await loadAnchors();
  const jobs = buildJobs(anchors);
  const concurrency = Number(flag(args, "--concurrency") ?? "4");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail("--concurrency must be a positive integer");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir =
    flag(args, "--out") ??
    path.join(homedir(), "Desktop", "materiality-probe", stamp);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "results.json");
  const partialPath = path.join(outDir, "runs.partial.json");

  for (const line of describeAnchors(anchors, jobs)) console.log(line);
  console.log(`writing ${outPath}`);

  const byId = new Map(anchors.map((a) => [a.id, a]));
  const startedAt = new Date().toISOString();
  const runs: JudgeRun[] = [];
  let cost = 0;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      if (job === undefined) break;
      const anchor = byId.get(job.anchorId);
      if (anchor === undefined) continue;
      let out: { run: JudgeRun; cost: number };
      try {
        out = await judgeOne(anchor, job.replicate);
      } catch (error) {
        out = {
          run: {
            anchorId: anchor.id,
            replicate: job.replicate,
            label: null,
            error: error instanceof Error ? error.message : String(error),
          },
          cost: 0,
        };
      }
      runs.push(out.run);
      cost += out.cost;
      // Checkpoint after every judgment, so a killed run keeps what it paid
      // for. Sync on purpose: concurrent workers never interleave a write.
      writeFileSync(
        partialPath,
        `${JSON.stringify({ judge_system_sha256: judgeSystemSha256(), anchors, runs }, null, 2)}\n`,
      );
      const mark =
        out.run.label === null
          ? "ERR"
          : out.run.label === anchor.expected
            ? "ok "
            : "MISS";
      console.log(
        `[${runs.length}/${jobs.length}] ${mark} ${anchor.id} r${job.replicate} → ${out.run.label ?? out.run.error}`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const score = scoreExam(anchors, runs);
  const results: ResultsFile = {
    judge_model: JUDGE_MODEL,
    judge_system_sha256: judgeSystemSha256(),
    pass_bar: PASS_BAR,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    cost_usd_est: cost,
    anchors,
    runs,
    score,
  };
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`);
  for (const line of renderScore(score)) console.log(line);
  console.log(`cost (est): $${cost.toFixed(2)}`);
}

async function score(args: string[]): Promise<void> {
  const file = args[0];
  if (file === undefined) fail("score needs a results.json path");
  const results = (await Bun.file(file).json()) as ResultsFile;
  if (results.judge_system_sha256 !== judgeSystemSha256()) {
    console.log(
      "note: the judge prompt changed since this run; rescoring the recorded labels only",
    );
  }
  for (const line of renderScore(scoreExam(results.anchors, results.runs))) {
    console.log(line);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "plan") {
  const anchors = await loadAnchors();
  for (const line of describeAnchors(anchors, buildJobs(anchors))) {
    console.log(line);
  }
} else if (command === "run") {
  await run(rest);
} else if (command === "score") {
  await score(rest);
} else {
  fail(
    "usage: materiality-probe.ts plan | run [--out <dir>] [--concurrency <n>] | score <results.json>",
  );
}
