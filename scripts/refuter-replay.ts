// Re-run ONLY the refuter over findings that already exist in finished run
// dirs, with a selectable model, and score the verdicts against hand labels.
// No hunters, no dedupe, no pipeline: one refuter step per case.
//
//   bun run scripts/refuter-replay.ts --cases <cases.json> --model opus|sonnet \
//     --out <results.jsonl> [--concurrency 4] [--system-prompt <file>]
//     [--user-prompt-template <file>]
//
// cases.json: { "cases": [{ "run": "<run dir>", "finding": "F003",
//   "expect": "keep" | "drop", "label": "speculative", "note": "..." }] }
//
// The step is built exactly as runRefuter builds it (src/review/pipeline.ts):
// the run's own nonce, the same one-finding JSON, the same prompt. For a
// finding the run submitted, the rebuilt prompt is checked against the
// recorded userPromptSha256 before anything is spent, so a replay can never
// silently ask a different question. Findings the run never submitted (the
// advisory tier) are built from findings.json the same way, with no recorded
// SHA to check.
//
// The refuter gets what it got on the benchmark: a detached worktree of the
// corpus clone at the head SHA and an empty MCP registry (no Martian clone
// has a .codegraph index, and none may get one). Results append per case, so
// a rerun skips (run, finding, model) rows already in --out.

import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Effort } from "#model/catalog";
import { wrapBlock } from "#review/boundary";
import {
  extractJsonObject,
  type RefuterResult,
  validateRefuterResult,
} from "#review/drafts";
import type { Finding } from "#review/findings";
import { makeProofRefResolver, refuterPrompt } from "#review/pipeline";
import {
  ClaudeCodeRunner,
  DEFAULT_STEP_MAX_ATTEMPTS,
  type StepSpec,
} from "#review/step-runner";
import { resolveRunnerAuthority } from "../src/runner-authority";
import { BENCH_HOME, CORPORA } from "./martian-corpora";

function argValue(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  return i < 0 ? undefined : Bun.argv[i + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const casesPath = argValue("--cases");
const model = argValue("--model");
const outPath = argValue("--out");
const concurrency = Number(argValue("--concurrency") ?? 4);
// Overrides every run's recorded refuter.system.md. Needed for runs whose
// findings were all advisory (they never spawned a refuter, so recorded no
// system prompt), and for replaying a candidate prompt.
const systemPromptOverride = argValue("--system-prompt");
// A candidate user prompt: a file whose {{FINDING}} line is replaced by the
// nonce-wrapped finding block, in place of the engine's refuterPrompt. The
// recorded SHA cannot match a candidate, so the check is skipped for it.
const userPromptTemplatePath = argValue("--user-prompt-template");
const userPromptTemplate =
  userPromptTemplatePath === undefined
    ? undefined
    : await Bun.file(userPromptTemplatePath).text();
if (!casesPath || !model || !outPath) {
  fail(
    "usage: bun run scripts/refuter-replay.ts --cases <cases.json> --model <model> --out <results.jsonl> [--concurrency 4]",
  );
}

interface ReplayCase {
  run: string;
  finding: string;
  expect: "keep" | "drop";
  label: string;
  // "refuted": the finding lives in findings.json debug.refuted, not in the
  // posted list (the run deleted it). Its id may collide with a posted one.
  source?: "posted" | "refuted";
  note?: string;
}

interface PipelineMeta {
  head_sha: string;
  boundary_nonce: string;
  steps: Array<{ name: string; effort?: Effort; tools?: string[] }>;
}

const expandHome = (p: string) =>
  p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;

const cases = (
  (await Bun.file(casesPath).json()) as { cases: ReplayCase[] }
).cases.map((c) => ({ ...c, run: expandHome(c.run) }));

// The runs root names the corpus, and the corpus names its clone.
function cloneFor(runDir: string): string {
  const root = path.basename(path.dirname(runDir));
  const corpus = Object.values(CORPORA).find((c) => c.runs === root);
  if (corpus === undefined) fail(`no corpus owns runs root ${root}`);
  return path.join(BENCH_HOME, corpus.clone);
}

const done = new Set<string>();
const outFile = Bun.file(outPath);
if (await outFile.exists()) {
  for (const line of (await outFile.text()).split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      run: string;
      finding: string;
      model: string;
      status: string;
    };
    // A failed step (quota, auth, timeout) is not an answer: rerun it.
    if (row.status === "ok") done.add(`${row.run}|${row.finding}|${row.model}`);
  }
}

const scratch = await mkdtemp(path.join(tmpdir(), "refuter-replay-"));
const mcpConfigPath = path.join(scratch, "mcp.json");
await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

// The runner only spawns inside its workspace root, so the root is the
// scratch dir that holds every worktree and step artifact.
const authority = await resolveRunnerAuthority({
  workspaceRoot: scratch,
});
if (authority.error !== undefined) {
  fail(`execution authority unavailable: ${authority.error}`);
}
const runner = new ClaudeCodeRunner(authority.runnerOptions);

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(
      `git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`,
    );
  }
}

// One worktree per run dir (a run dir is one clone at one head).
let worktreeLock: Promise<void> = Promise.resolve();
const worktrees = new Map<string, Promise<{ clone: string; dir: string }>>();
function worktreeFor(runDir: string, head: string) {
  let wt = worktrees.get(runDir);
  if (wt === undefined) {
    wt = (async () => {
      const clone = cloneFor(runDir);
      const dir = path.join(scratch, `wt-${worktrees.size}`);
      // Serialised: two concurrent `worktree add` on one clone race on its
      // git lock and one of them fails.
      const add = worktreeLock.then(() =>
        git(clone, ["worktree", "add", "--detach", dir, head]),
      );
      worktreeLock = add.catch(() => {});
      await add;
      return { clone, dir };
    })();
    worktrees.set(runDir, wt);
  }
  return wt;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function replay(c: ReplayCase) {
  const meta = (await Bun.file(
    path.join(c.run, "pipeline.json"),
  ).json()) as PipelineMeta;
  const doc = (await Bun.file(path.join(c.run, "findings.json")).json()) as {
    findings: Finding[];
    debug?: { refuted?: Finding[] };
  };
  const pool =
    c.source === "refuted" ? (doc.debug?.refuted ?? []) : doc.findings;
  const f = pool.find((x) => x.id === c.finding);
  if (f === undefined) {
    throw new Error(`${c.run}: no ${c.source ?? "posted"} ${c.finding}`);
  }

  const oneJson = JSON.stringify(
    [
      {
        id: f.id,
        location: `${f.path}:${f.line}`,
        severity: f.severity,
        claim: f.claim,
        proof_refs: f.proof_refs,
      },
    ],
    null,
    2,
  );
  const prompt =
    userPromptTemplate === undefined
      ? refuterPrompt(oneJson, meta.boundary_nonce)
      : userPromptTemplate.replace(
          "{{FINDING}}",
          wrapBlock("finding", meta.boundary_nonce, oneJson),
        );
  const evidence = Bun.file(
    path.join(c.run, "steps", `evidence.refuter-${f.id}.attempt1.request.json`),
  );
  let promptCheck: "match" | "unrecorded" | "candidate" =
    userPromptTemplate === undefined ? "unrecorded" : "candidate";
  if (userPromptTemplate === undefined && (await evidence.exists())) {
    const recorded = ((await evidence.json()) as { userPromptSha256: string })
      .userPromptSha256;
    if (recorded !== sha256(prompt)) {
      throw new Error(`${c.run} ${f.id}: rebuilt prompt != recorded SHA`);
    }
    promptCheck = "match";
  }

  // Effort and tools come from the run's own refuter step when it had one;
  // a run whose findings were all advisory never spawned a refuter, so fall
  // back to the frontmatter values every Martian run recorded.
  const recordedStep = meta.steps.find((s) => s.name.startsWith("refuter-"));
  const effort: Effort = recordedStep?.effort ?? "high";
  const tools = recordedStep?.tools ?? [
    "Read",
    "Grep",
    "Glob",
    "mcp__codegraph__codegraph_explore",
  ];

  const { dir } = await worktreeFor(c.run, meta.head_sha);
  const patch = await Bun.file(path.join(c.run, "diff.patch")).text();
  const resolveProofRef = makeProofRefResolver(dir, patch);
  const caseDir = path.join(scratch, `${path.basename(c.run)}-${f.id}`);
  const systemPromptPath = path.join(caseDir, "refuter.system.md");
  const recordedSystem = Bun.file(
    path.join(c.run, "steps", "refuter.system.md"),
  );
  const systemSource =
    systemPromptOverride !== undefined
      ? Bun.file(systemPromptOverride)
      : recordedSystem;
  if (!(await systemSource.exists())) {
    throw new Error(
      `${c.run}: no recorded refuter.system.md; pass --system-prompt`,
    );
  }
  await Bun.write(systemPromptPath, await systemSource.text());
  await chmod(systemPromptPath, 0o600);

  const spec: StepSpec = {
    name: `refuter-${f.id}`,
    systemPromptPath,
    prompt,
    tools,
    mcpConfigPath,
    model: model as string,
    effort,
    cwd: dir,
    outPath: path.join(caseDir, `refuter-${f.id}.result.json`),
    timeoutMs: 10 * 60 * 1000,
    maxAttempts: DEFAULT_STEP_MAX_ATTEMPTS,
    parse: (finalText) => {
      const extracted = extractJsonObject(finalText);
      if (extracted === undefined) {
        throw new Error("refuter final message has no JSON object");
      }
      return validateRefuterResult(extracted, [f.id], { resolveProofRef });
    },
  };
  const result = await runner.run(spec);
  // A failed step reads as `inconclusive`, exactly as runRefuter treats it.
  const entry =
    result.status === "ok"
      ? (result.output as RefuterResult).results[0]
      : undefined;
  const verdict =
    result.status === "ok"
      ? ((result.output as RefuterResult).results[0]?.outcome ?? "inconclusive")
      : "inconclusive";
  return {
    run: c.run,
    finding: f.id,
    model,
    severity: f.severity,
    tier: f.tier,
    original_verdict: c.source === "refuted" ? "refuted" : f.refuter_verdict,
    verdict,
    refuter_proof_refs: entry?.proof_refs ?? [],
    status: result.status,
    denial: result.denialCode ?? null,
    stderr_tail:
      result.status === "ok" ? null : (result.stderrTail ?? "").slice(-400),
    expect: c.expect,
    label: c.label,
    prompt_check: promptCheck,
    notional_usd: result.usageV2?.notionalCostUsd ?? null,
    wall_ms: result.usageV2?.wallMs ?? null,
  };
}

const pending = cases.filter(
  (c) => !done.has(`${c.run}|${c.finding}|${model}`),
);
console.error(
  `${cases.length} cases, ${cases.length - pending.length} already in ${outPath}, ${pending.length} to run on ${model}`,
);

let next = 0;
let failures = 0;
async function worker() {
  while (next < pending.length) {
    const c = pending[next++] as ReplayCase;
    try {
      const row = await replay(c);
      // appendFile, not read-then-write: the workers share one file.
      await appendFile(outPath as string, `${JSON.stringify(row)}\n`);
      console.error(
        `  ${path.basename(c.run)} ${c.finding} ${row.verdict} (expect ${c.expect})`,
      );
    } catch (error) {
      failures++;
      console.error(`  ERROR ${path.basename(c.run)} ${c.finding}: ${error}`);
    }
  }
}

try {
  await Promise.all(Array.from({ length: concurrency }, worker));
} finally {
  for (const [, wt] of worktrees) {
    const { clone, dir } = await wt.catch(() => ({ clone: "", dir: "" }));
    if (clone) await git(clone, ["worktree", "remove", "--force", dir]);
  }
  await rm(scratch, { recursive: true, force: true });
}
process.exit(failures > 0 ? 1 : 0);
