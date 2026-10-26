// Candidate post-refuter stage, replayed offline: one tool-free model call per
// PR that rewrites the posted findings so each comment states ONE defect.
// It merges findings that describe the same defect (two hunters, or one
// pattern at sibling sites) and lifts "separately…"/"also…" asides out of a
// claim: into their own finding when they name a distinct defect, otherwise
// it drops them. It never adds a defect, never judges correctness, never
// drops a whole finding.
//
//   bun run scripts/consolidate-replay.ts --arm dev-default --tool pr-hero-consol \
//     --out <dir> [--model sonnet] [--concurrency 4] [--only <label,...>]
//     [--variant base|strict]
//
// Reads every Martian 50 run dir, writes <dir>/consolidation.jsonl (one audit
// row per PR, resumable) and <dir>/injected-reviews.json: review entries in
// martian-inject's shape, rendered with the same renderInlineComment, under
// the given tool name, ready to splice into a COPY of benchmark_data.json.
// Goldens are used only to key the entry by PR URL; the model never sees them.

import { appendFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lookupGolden, type MartianGoldenPr } from "#compare/martian-adapter";
import { extractJsonObject } from "#review/drafts";
import type { Finding } from "#review/findings";
import { renderInlineComment } from "#review/report";
import { ClaudeCodeRunner } from "#review/step-runner";
import { resolveRunnerAuthority } from "../src/runner-authority";
import {
  BENCH_HOME,
  type CasesFile,
  CORPORA,
  corpusDocsFile,
} from "./martian-corpora";

function argValue(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  return i < 0 ? undefined : Bun.argv[i + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const arm = argValue("--arm") ?? fail("--arm is required");
const tool = argValue("--tool") ?? fail("--tool is required");
const outDir = argValue("--out") ?? fail("--out is required");
const model = argValue("--model") ?? "sonnet";
const concurrency = Number(argValue("--concurrency") ?? 4);
// --only cal-8087,keycloak-37634: consolidate just these PRs (a smoke run).
const only = argValue("--only")?.split(",");
// --variant strict: asides survive only as a concrete defect, and the drafts
// dedupe merged away are offered so a distinct defect they carry is rescued.
const variant = argValue("--variant") ?? "base";
if (variant !== "base" && variant !== "strict")
  fail(`unknown --variant ${variant}`);

const SYSTEM = `You consolidate the findings a code reviewer is about to post on one pull request, so that every posted comment states exactly ONE defect.

You receive the findings as JSON: id, path, line, severity, hunter, claim. You have no tools and no code: work only from the claims.

Do exactly two things.

1. Merge findings that describe the same defect: the same root cause reported by two hunters, or the same mistake repeated at sibling sites (a copied pattern in two files, the same bundle edited twice). Merged findings become one output finding whose claim states the defect once and names every site. Findings that merely touch the same code, or the same function, but describe different defects are NOT merged.

2. Split asides. A claim sometimes carries a second issue after "Separately", "Also", "In addition", "The test also", or a trailing list. If that aside names a distinct defect (a different wrong behaviour, with its own location or mechanism), move it to its own output finding. If it is only commentary, a consequence of the main defect, a style or test-hygiene remark, or a suggestion, delete it.

Rules:
- Never add a defect that is not in the input claims. Never judge whether a claim is correct, likely or important. Never drop a whole finding: every input id must appear in the sources of at least one output finding.
- Keep the reviewer's wording. Copy sentences; trim them; do not paraphrase into something new. Keep code identifiers, line references and the concrete consequence.
- Each output claim states one defect, its mechanism, and its consequence, in at most about 120 words.
- For a merge, "primary" is the most severe source (BLOCKER > CRITICAL > WARNING > SUGGESTION), ties broken by the first in input order. For a split aside, "primary" is the finding it came from and "split" is true.

Final message: exactly one JSON object, no prose, no code fences:
{"findings":[{"primary":"F001","sources":["F001","F004"],"split":false,"claim":"..."}]}`;

const STRICT_RULES = `

Two stricter rules apply on top of the above.

A. An aside survives as its own output finding ONLY when it names a concrete defect with a consequence a user or operator would hit: wrong output or data, a crash, a lost or duplicated write, a security or permission hole, a resource leak, a broken build or deploy. Everything else in an aside is deleted: performance worries without a concrete trigger, robustness or defensive-coding suggestions, missing logging or metrics, test hygiene, naming, style, documentation, "consider", "could", "might also".

B. You also receive "merged_drafts": findings an earlier mechanical dedupe merged INTO a posted finding ("merged_into"), so only the posted finding's claim would be published. Most restate the posted defect; ignore those. When a merged draft carries a DISTINCT defect that rule A would keep and that no output finding already states, emit it as its own output finding with "primary" set to its merged_into id, "split": true, and "draft" set to the draft's id. Never emit a draft that restates a posted defect.

Final message shape for this variant (draft is optional):
{"findings":[{"primary":"F001","sources":["F001"],"split":true,"draft":"RES-4","claim":"..."}]}`;

interface PlanEntry {
  primary: string;
  sources: string[];
  split?: boolean;
  // A rescued merged-away draft: its own location and evidence are posted.
  draft?: string;
  claim: string;
}

interface MergedDraft {
  id: string;
  merged_into: string;
  path: string;
  line: number;
  severity: Finding["severity"];
  claim: string;
  proof_refs: string[];
}

// Rejects a plan that drops a finding, names an unknown one, or detaches a
// primary from its sources. A rejected plan falls back to the input as is,
// so a bad call can cost precision but never recall.
function validatePlan(
  raw: unknown,
  ids: string[],
  draftIds: Set<string>,
): PlanEntry[] {
  const plan = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("no findings array");
  }
  const known = new Set(ids);
  const covered = new Set<string>();
  const out: PlanEntry[] = [];
  for (const e of plan as PlanEntry[]) {
    if (typeof e?.primary !== "string" || !known.has(e.primary)) {
      throw new Error(`unknown primary ${String(e?.primary)}`);
    }
    if (!Array.isArray(e.sources) || !e.sources.includes(e.primary)) {
      throw new Error(`${e.primary}: primary missing from sources`);
    }
    for (const s of e.sources) {
      if (!known.has(s)) throw new Error(`unknown source ${s}`);
      covered.add(s);
    }
    if (typeof e.claim !== "string" || e.claim.trim().length === 0) {
      throw new Error(`${e.primary}: empty claim`);
    }
    if (e.draft !== undefined) {
      if (!draftIds.has(e.draft)) throw new Error(`unknown draft ${e.draft}`);
      if (e.split !== true)
        throw new Error(`${e.draft}: a rescue must be a split`);
    }
    out.push({ ...e, split: e.split === true });
  }
  const missing = ids.filter((id) => !covered.has(id));
  if (missing.length > 0) throw new Error(`dropped ${missing.join(",")}`);
  return out;
}

// One output finding per plan entry. A merge keeps the primary's location,
// severity, tier and verdict, and pools the evidence. A split aside was never
// refuted on its own, so it posts advisory with `not_submitted`.
function applyPlan(
  findings: Finding[],
  plan: PlanEntry[],
  drafts: MergedDraft[],
): Finding[] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const draftById = new Map(drafts.map((d) => [d.id, d]));
  const splits = new Map<string, number>();
  return plan.map((e) => {
    const primary = byId.get(e.primary) as Finding;
    const proofRefs = [
      ...new Set(e.sources.flatMap((s) => byId.get(s)?.proof_refs ?? [])),
    ];
    if (!e.split) {
      return { ...primary, claim: e.claim, proof_refs: proofRefs };
    }
    const n = (splits.get(e.primary) ?? 0) + 1;
    splits.set(e.primary, n);
    const draft = e.draft === undefined ? undefined : draftById.get(e.draft);
    return {
      ...primary,
      id: `${primary.id}s${n}`,
      claim: e.claim,
      ...(draft === undefined
        ? { proof_refs: primary.proof_refs }
        : {
            path: draft.path,
            line: draft.line,
            severity: draft.severity,
            proof_refs: draft.proof_refs,
          }),
      tier: "advisory",
      refuter_verdict: "not_submitted",
    };
  });
}

interface PrJob {
  label: string;
  url: string;
  headSha: string;
  findings: Finding[];
  drafts: MergedDraft[];
}

const jobs: PrJob[] = [];
for (const [name, corpus] of Object.entries(CORPORA)) {
  const cases = (await Bun.file(
    corpusDocsFile(name, "cases.json"),
  ).json()) as CasesFile;
  const goldens = (await Bun.file(
    corpusDocsFile(name, "goldens.json"),
  ).json()) as MartianGoldenPr[];
  for (const row of cases.prs) {
    const label = `${name}-${row.pr}`;
    const dir = path.join(BENCH_HOME, corpus.runs, `${label}-${arm}`);
    const doc = (await Bun.file(path.join(dir, "findings.json")).json()) as {
      findings: Finding[];
      debug?: { deduped?: MergedDraft[] };
    };
    const posted = new Set(doc.findings.map((f) => f.id));
    jobs.push({
      label,
      url: lookupGolden(goldens, row.pr).url,
      headSha: row.headSha,
      findings: doc.findings,
      drafts: (doc.debug?.deduped ?? []).filter((d) =>
        posted.has(d.merged_into),
      ),
    });
  }
}

const auditPath = path.join(outDir, "consolidation.jsonl");
interface AuditRow {
  label: string;
  status: "ok" | "fallback" | "passthrough";
  reason?: string;
  plan?: PlanEntry[];
  in: number;
  out: number;
  notional_usd: number | null;
}
const audit = new Map<string, AuditRow>();
const auditFile = Bun.file(auditPath);
if (await auditFile.exists()) {
  for (const line of (await auditFile.text()).split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as AuditRow;
    // A fallback is not an answer: retry it.
    if (row.status !== "fallback") audit.set(row.label, row);
  }
}

const scratch = await mkdtemp(path.join(tmpdir(), "consolidate-"));
const systemPromptPath = path.join(scratch, "system.md");
const mcpConfigPath = path.join(scratch, "mcp.json");
await Bun.write(
  systemPromptPath,
  variant === "strict" ? SYSTEM + STRICT_RULES : SYSTEM,
);
await chmod(systemPromptPath, 0o600);
await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
const authority = await resolveRunnerAuthority({ workspaceRoot: scratch });
if (authority.error !== undefined) {
  fail(`execution authority unavailable: ${authority.error}`);
}
const runner = new ClaudeCodeRunner(authority.runnerOptions);

async function consolidate(job: PrJob): Promise<AuditRow> {
  const ids = job.findings.map((f) => f.id);
  // Nothing to merge or split in fewer than one claim.
  if (job.findings.length === 0) {
    return {
      label: job.label,
      status: "passthrough",
      in: 0,
      out: 0,
      notional_usd: null,
    };
  }
  const input = job.findings.map((f) => ({
    id: f.id,
    path: f.path,
    line: f.line,
    severity: f.severity,
    hunter: f.hunter,
    claim: f.claim,
  }));
  const result = await runner.run({
    name: `consolidate-${job.label}`,
    systemPromptPath,
    prompt:
      variant === "strict"
        ? `Findings:\n${JSON.stringify(input, null, 2)}\n\nmerged_drafts:\n${JSON.stringify(
            job.drafts.map((d) => ({
              id: d.id,
              merged_into: d.merged_into,
              path: d.path,
              line: d.line,
              severity: d.severity,
              claim: d.claim,
            })),
            null,
            2,
          )}`
        : `Findings:\n${JSON.stringify(input, null, 2)}`,
    tools: [],
    mcpConfigPath,
    model,
    effort: "high",
    cwd: scratch,
    outPath: path.join(scratch, `${job.label}.json`),
    timeoutMs: 10 * 60 * 1000,
    maxAttempts: 2,
    parse: (finalText) => {
      const extracted = extractJsonObject(finalText);
      if (extracted === undefined) throw new Error("no JSON object");
      return validatePlan(
        extracted,
        ids,
        new Set(variant === "strict" ? job.drafts.map((d) => d.id) : []),
      );
    },
  });
  const cost = result.usageV2?.notionalCostUsd ?? null;
  if (result.status !== "ok") {
    return {
      label: job.label,
      status: "fallback",
      reason: result.stderrTail.slice(-300),
      in: ids.length,
      out: ids.length,
      notional_usd: cost,
    };
  }
  const plan = result.output as PlanEntry[];
  return {
    label: job.label,
    status: "ok",
    plan,
    in: ids.length,
    out: plan.length,
    notional_usd: cost,
  };
}

const pending = jobs.filter(
  (j) => !audit.has(j.label) && (only === undefined || only.includes(j.label)),
);
console.error(
  `${jobs.length} PRs, ${audit.size} already consolidated, ${pending.length} to run on ${model}`,
);
let next = 0;
async function worker() {
  while (next < pending.length) {
    const job = pending[next++] as PrJob;
    const row = await consolidate(job);
    audit.set(job.label, row);
    await appendFile(auditPath, `${JSON.stringify(row)}\n`);
    console.error(`  ${job.label} ${row.status} ${row.in} -> ${row.out}`);
  }
}
try {
  await Promise.all(Array.from({ length: concurrency }, worker));
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const reviews = jobs.map((job) => {
  const row = audit.get(job.label);
  const findings =
    row?.status === "ok" && row.plan !== undefined
      ? applyPlan(job.findings, row.plan, job.drafts)
      : job.findings;
  return {
    tool,
    pr_url: job.url,
    repo_name: `${tool}__${job.label}__${arm}`,
    review_comments: findings.map((f) => ({
      path: f.path,
      line: f.line,
      body: renderInlineComment(f, job.headSha),
    })),
  };
});
await Bun.write(
  path.join(outDir, "injected-reviews.json"),
  JSON.stringify(reviews, null, 1),
);
const rows = [...audit.values()];
console.error(
  `findings ${rows.reduce((n, r) => n + r.in, 0)} -> ${rows.reduce((n, r) => n + r.out, 0)}, fallbacks ${rows.filter((r) => r.status === "fallback").length}, notional $${rows.reduce((n, r) => n + (r.notional_usd ?? 0), 0).toFixed(2)}`,
);
