// Verifier exam: known-answer cases for the re-review verifier. Each case is a
// small repository as it looks at a pull request's current head, an earlier
// finding, and whether that finding's defect is still present there. Local
// only; the cases are kept outside this repository.
//
//   bun run benchmarks/verifier-exam/exam.ts check --bank <dir>
//   bun run benchmarks/verifier-exam/exam.ts run   --bank <dir> [--arm own|refuter]
//                                                  [--runs <n>] [--case <id,..>]
//
//   check  $0. Reads every case and reports what is malformed.
//   run    LIVE: one model call per case and run, on the refuter agent's
//          production model and effort. Lands in the lab ledger the day it runs.
//
//   --arm own      the verifier's own instructions (prompts/verifier.md), what
//                  the product's PR path runs. The default.
//   --arm refuter  the refuter agent's body, what a direct pipeline caller that
//                  passes no verifier body runs (and what the product ran
//                  before the verifier had one).
//   --home <dir>   where checkouts and reports go (default ~/.crysk/casebank,
//                  or CRYSK_CASEBANK_HOME).
//
// A case directory holds `case.json` and `head/` (the repository's files):
//   { "id", "expect": "present" | "gone",
//     "finding": { "claim", "locs": ["path:line"], "sev", "triage_tag" } }
//
// Grading. The verifier's `refuted` closes a finding, so:
//   expect gone     refuted -> pass; anything else -> the finding stays open on
//                   work the author finished (`kept-open`).
//   expect present  corroborated -> pass; inconclusive -> `unsure` (still open,
//                   so not the costly error); refuted -> `closed-live-defect`,
//                   the one error this stage must not make.

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProfile } from "#model/profiles";
import {
  type PipelineInput,
  type PipelineProgressEvent,
  runPipeline,
} from "#review/pipeline";
import { localReviewSpec } from "#review/preflight";
import { pipelineVerifierInput } from "#review/route-preflight";
import { buildPipelineHarnessPlan } from "../../src/harness/pipeline-plan";
import { prepareHarnessRunner } from "../../src/harness/route-runner";
import { resolveRunClaudeCredential } from "../../src/security/claude-credential";
import {
  BUNDLED_AGENTS_DIR,
  examDirs,
  examHome,
  removeTree,
  stepCostUsd,
} from "../hunter-exam/run-case";

export type Expect = "present" | "gone";
export type Arm = "own" | "refuter";
export type Grade =
  | "pass"
  | "kept-open"
  | "unsure"
  | "closed-live-defect"
  | "infra-error";

export interface VerifierCase {
  id: string;
  dir: string;
  expect: Expect;
  finding: { claim: string; locs: string[]; sev: string; triage_tag: string };
}

// `outcome` undefined means the step produced no verdict.
export function gradeVerdict(
  expect: Expect,
  outcome: string | undefined,
): Grade {
  if (outcome === undefined) return "infra-error";
  if (expect === "gone") return outcome === "refuted" ? "pass" : "kept-open";
  if (outcome === "refuted") return "closed-live-defect";
  return outcome === "inconclusive" ? "unsure" : "pass";
}

export function caseProblems(raw: unknown, dir: string): string[] {
  const problems: string[] = [];
  const c = raw as Partial<VerifierCase> | null;
  if (c === null || typeof c !== "object")
    return ["case.json is not an object"];
  if (typeof c.id !== "string" || c.id !== path.basename(dir)) {
    problems.push("id must equal the directory name");
  }
  if (c.expect !== "present" && c.expect !== "gone") {
    problems.push('expect must be "present" or "gone"');
  }
  // JSON spells a missing object as null as readily as it omits the key, and
  // a string or number here has none of the fields either: all read as absent.
  const f =
    typeof c.finding === "object" && c.finding !== null ? c.finding : undefined;
  if (f === undefined || typeof f.claim !== "string" || f.claim === "") {
    problems.push("finding.claim must be a non-empty string");
  }
  if (!Array.isArray(f?.locs) || f.locs.length === 0) {
    problems.push("finding.locs must be a non-empty array");
  } else {
    for (const loc of f.locs) {
      const file = String(loc).replace(/:\d+$/, "");
      if (!existsSync(path.join(dir, "head", file))) {
        problems.push(`finding.locs names ${file}, which head/ does not hold`);
      }
    }
  }
  if (typeof f?.triage_tag !== "string") {
    problems.push("finding.triage_tag must be a string (empty for none)");
  }
  return problems;
}

async function loadCases(
  bank: string,
  only: string[],
): Promise<VerifierCase[]> {
  const cases: VerifierCase[] = [];
  for (const name of (await readdir(bank)).sort()) {
    const dir = path.join(bank, name);
    const file = path.join(dir, "case.json");
    if (!existsSync(file)) continue;
    if (only.length > 0 && !only.includes(name)) continue;
    const raw = JSON.parse(await readFile(file, "utf8"));
    const problems = caseProblems(raw, dir);
    if (problems.length > 0) {
      throw new Error(`${name}: ${problems.join("; ")}`);
    }
    cases.push({ ...(raw as VerifierCase), dir });
  }
  return cases;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "case",
  GIT_AUTHOR_EMAIL: "case@example.invalid",
  GIT_COMMITTER_NAME: "case",
  GIT_COMMITTER_EMAIL: "case@example.invalid",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "gc.auto=0", ...args], {
    cwd,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${await new Response(proc.stderr).text()}`,
    );
  }
  return out.trim();
}

// The checkout the verifier reads: the case's head files as one commit over an
// empty base, so the run has a real range and a real patch like any review.
async function buildCheckout(
  c: VerifierCase,
  root: string,
): Promise<{
  repo: string;
  baseSha: string;
  headSha: string;
  diffPath: string;
}> {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-q"]);
  await git(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);
  const baseSha = await git(repo, ["rev-parse", "HEAD"]);
  await cp(path.join(c.dir, "head"), repo, { recursive: true });
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "head"]);
  const headSha = await git(repo, ["rev-parse", "HEAD"]);
  const diffPath = path.join(root, "diff.patch");
  await writeFile(diffPath, `${await git(repo, ["diff", baseSha, headSha])}\n`);
  return { repo, baseSha, headSha, diffPath };
}

export interface RunRow {
  case: string;
  expect: Expect;
  arm: Arm;
  run: number;
  outcome: string | undefined;
  grade: Grade;
  cost_usd: number;
  wall_ms: number;
  detail?: string;
}

async function runOnce(
  c: VerifierCase,
  arm: Arm,
  run: number,
  workRoot: string,
): Promise<RunRow> {
  const root = path.join(workRoot, `${c.id}-${arm}-${run}`);
  const started = performance.now();
  const row = (
    outcome: string | undefined,
    cost: number,
    detail?: string,
  ): RunRow => ({
    case: c.id,
    expect: c.expect,
    arm,
    run,
    outcome,
    grade: gradeVerdict(c.expect, outcome),
    cost_usd: cost,
    wall_ms: Math.round(performance.now() - started),
    ...(detail === undefined ? {} : { detail }),
  });
  try {
    const built = await buildCheckout(c, root);
    const runDir = path.join(root, "run");
    await mkdir(runDir, { recursive: true });
    const mcpConfigPath = path.join(runDir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    const profile = resolveProfile(undefined);
    const input: PipelineInput = {
      pr: 0,
      baseSha: built.baseSha,
      headSha: built.headSha,
      worktree: built.repo,
      diffPath: built.diffPath,
      agentsDir: BUNDLED_AGENTS_DIR,
      bundledAgents: true,
      modelProfile: profile,
      spec: localReviewSpec({}),
      runDir,
      outPath: path.join(runDir, "findings.json"),
      mcpConfigPath,
      hopBudget: 12,
      parityTriggerPaths: [],
      suspicionPriors: [],
      skipDiscovery: true,
      verifyQueue: [
        {
          priorId: "R001",
          sev: c.finding.sev === "BLOCKER" ? "BLOCKER" : "CRITICAL",
          trigger: c.finding.triage_tag === "applied" ? "applied" : "touched",
          claim: c.finding.claim,
          locs: c.finding.locs,
          authorReply: "",
          commentBody: "",
          triageTag: c.finding.triage_tag,
          deltaHunks: "",
        },
      ],
      ...(arm === "own" ? pipelineVerifierInput({ profile }) : {}),
    };
    let outcome: string | undefined;
    const harness = await prepareHarnessRunner({
      workspaceRoot: built.repo,
      buildRoutePlan: () => buildPipelineHarnessPlan(input),
      claudeRun: resolveRunClaudeCredential({}),
    });
    let status: string | undefined;
    let detail: string | undefined;
    try {
      const result = await runPipeline(
        { ...input, routePlan: harness.plan },
        {
          ...harness.deps,
          onProgress: (event: PipelineProgressEvent) => {
            if (event.kind === "verify-step-finished") outcome = event.verdict;
          },
        },
      );
      status = result.perAgent.verifier?.status;
      detail = result.perAgent.verifier?.detail;
    } finally {
      await harness.dispose();
    }
    const cost = await readFile(path.join(runDir, "pipeline.json"), "utf8")
      .then((raw) => stepCostUsd(JSON.parse(raw), "verify-V001"))
      .catch(() => 0);
    // A failed step also reports `inconclusive` on the event: only an ok step
    // carries a verdict.
    if (status !== "ok") return row(undefined, cost, detail ?? "step failed");
    // Kept: the rendered request and the verdict, for reading afterwards.
    await cp(path.join(runDir, "steps"), path.join(root, "steps"), {
      recursive: true,
    });
    return row(outcome, cost);
  } catch (error) {
    return row(undefined, 0, (error as Error).message);
  } finally {
    await removeTree(path.join(root, "repo")).catch(() => {});
    await removeTree(path.join(root, "run")).catch(() => {});
  }
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const bank = flag(argv, "--bank");
  if ((command !== "check" && command !== "run") || bank === undefined) {
    console.error(
      "usage: exam.ts check|run --bank <dir> [--arm own|refuter] [--runs <n>] [--case <id,..>] [--home <dir>]",
    );
    return 2;
  }
  const only = (flag(argv, "--case") ?? "").split(",").filter(Boolean);
  const cases = await loadCases(path.resolve(bank), only);
  // A mistyped --case must not read as a clean run.
  if (cases.length === 0) {
    console.error("no case matched");
    return 1;
  }
  if (command === "check") {
    for (const c of cases) console.log(`ok  ${c.id}`);
    console.log(`${cases.length} case(s)`);
    return 0;
  }
  const arm = (flag(argv, "--arm") ?? "own") as Arm;
  if (arm !== "own" && arm !== "refuter") {
    console.error("--arm is own or refuter");
    return 2;
  }
  const runs = Number(flag(argv, "--runs") ?? "1");
  if (!Number.isInteger(runs) || runs < 1) {
    console.error("--runs is a whole number, 1 or more");
    return 2;
  }
  const dirs = examDirs(flag(argv, "--home") ?? examHome());
  // One folder per invocation, so two invocations started together never
  // write the same report.
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const workRoot = path.join(dirs.work, "verifier-exam", stamp);
  const reportDir = path.join(dirs.reports, "verifier-exam", `${stamp}-${arm}`);
  await mkdir(reportDir, { recursive: true });
  const rows: RunRow[] = [];
  for (const c of cases) {
    for (let run = 1; run <= runs; run += 1) {
      const result = await runOnce(c, arm, run, workRoot);
      rows.push(result);
      console.log(
        `${result.grade.padEnd(18)} ${c.id.padEnd(28)} expect ${c.expect.padEnd(7)} ` +
          `got ${(result.outcome ?? "-").padEnd(13)} $${result.cost_usd.toFixed(3)} ` +
          `${Math.round(result.wall_ms / 1000)}s${result.detail ? ` (${result.detail})` : ""}`,
      );
      const kept = path.join(workRoot, `${c.id}-${arm}-${run}`, "steps");
      if (existsSync(kept)) {
        await cp(kept, path.join(reportDir, `${c.id}-${run}`), {
          recursive: true,
        });
      }
    }
  }
  await removeTree(workRoot).catch(() => {});
  const total = rows.reduce((sum, r) => sum + r.cost_usd, 0);
  await writeFile(
    path.join(reportDir, "report.json"),
    `${JSON.stringify({ arm, runs, total_cost_usd: total, rows }, null, 2)}\n`,
  );
  const count = (grade: Grade) => rows.filter((r) => r.grade === grade).length;
  console.log(
    `\narm ${arm}: ${count("pass")} pass, ${count("kept-open")} kept-open, ${count("unsure")} unsure, ` +
      `${count("closed-live-defect")} closed-live-defect, ${count("infra-error")} infra-error; ` +
      `$${total.toFixed(2)} notional\nreport: ${reportDir}`,
  );
  return count("closed-live-defect") > 0 || count("infra-error") > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
