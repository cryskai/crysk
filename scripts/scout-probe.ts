// Scout-prompt probe (ROADMAP-DOORDASH M4 gate — `docs/scout-design.md` §3.10).
//
// This probe decides whether `prompts/scout.md` deserves M6's ~$224. Same
// discipline as refuter-probe: the prompt earns its A/B offline, on real diffs
// from the frozen M0 control set, before anything expensive runs.
//
// WHAT A RESULT MEANS — the two assertions answer DIFFERENT questions, and
// conflating them is the mistake this header exists to prevent.
//
//   COVERAGE (assertion 1) — "can a diff-only pass, with no repository access
//   at all, point at a defect a production reviewer caught and pr-hero missed?"
//   The five targets are the adjudicated `greptile_only` true-positive misses
//   (§2.3), so a hit is not "the scout said something plausible", it is "the
//   scout pointed at a place where a real defect provably was".
//     all five hit ≥2/3  → diff-only is a viable pre-hunter stage; M5 wiring
//                          and M6's A/B are worth paying for.
//     a case hit 0/3     → that case is either not diff-visible or the prompt
//                          is blind to its file type. §3.10's exclusion rule
//                          governs: at most ONE case may be reclassified, and
//                          only after two prompt iterations, with the reason
//                          written into the design doc. Two markdown-runbook
//                          cases are on the list precisely so a prompt that
//                          implicitly assumes TypeScript fails loudly here
//                          rather than quietly in M6.
//     hits on RAW but not CAPPED → not a coverage failure. It is the ceiling
//                          eating a good lead, which is a cap/prompt
//                          interaction M4 must see; both numbers are printed
//                          side by side so it cannot be misattributed.
//
//   RESTRAINT (assertion 2) — "is the scout SELECTIVE?" NOT "is it precise on
//   clean PRs". The six restraint PRs carry untriaged `prhero_only` rows, so
//   "this PR is clean" is not a claim this project owns and a precision number
//   against it would be fiction. What DashBench actually names as the failure
//   mode is filtering nothing — being loud everywhere — and `lead_coverage`
//   (fraction of changed hunks carrying ≥1 lead) measures that without knowing
//   a single defect count. It is a proxy, stated as one.
//   AMENDED 2026-08-18 (§3.10bis): `lead_coverage` is still computed and
//   printed, but it NO LONGER GATES. Its denominator is hunk COUNT, which
//   measures how git split the patch rather than how much changed, and it
//   ordered the six restraint PRs close to backwards — see the constant below
//   for the numbers. The gate is now the absolute one, ratified in the same
//   sentence of §3.10: mean leads per PR ≤ 6.
//     gate passes        → the scout narrows attention rather than restating
//                          the diff.
//     leads per PR high  → leading on every hunk is the same as leading on
//                          nothing; the lever is the prompt's cap discipline,
//                          not the driver's caps (§3.8: a truncation that fires
//                          routinely is a PROMPT defect, never a cap to raise).
//
// LIVE: spends real money (charter rule 6 — the result lands in a ledger). One
// diff-only sonnet step per (PR × replicate), no tools, one attempt. The
// default full run is 10 PRs × 3 replicates = 30 spawns.
//
// $0 SMOKE: `SCOUT_PROBE_DRY=1` runs the whole preflight, prints the plan, and
// exits BEFORE creating a run dir or spawning anything.
//
// Run:
//   SCOUT_PROBE_DRY=1 bun scripts/scout-probe.ts
//   bun scripts/scout-probe.ts [--only coverage|restraint] [--pr <n>]...
//     [--replicates 3] [--model sonnet] [--prompt prompts/scout.md] [--out <dir>]
//
// --model runs through the production route seam (src/harness/single-step.ts):
// `sonnet` (the default) is the Claude route the probe always ran,
// `claude:sonnet-latest`, and `opencode:<provider>/<model>` measures an
// OpenCode model. The report and every run record carry the route identity.

import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LINE_WINDOW, normalizePath } from "#compare/compare";
import { defaultEffortForRole } from "#model/catalog";
import { selectBoundaryNonce } from "#review/boundary";
import { extractJsonObject } from "#review/drafts";
import { parseAgentFile } from "#review/prompt-set";
import {
  capScoutLeads,
  type HunkCoverage,
  type HunkRange,
  hunkCoverage,
  parseHunkRanges,
  type ScoutLead,
  scoutPrompt,
  validateScoutLeads,
} from "#review/scout";
import type { StepSpec } from "#review/step-runner";
import {
  prepareSingleStepRunner,
  routeIdentityFields,
  singleStepRoute,
} from "../src/harness/single-step";
import { resolveRunClaudeCredential } from "../src/security/claude-credential";

// The frozen M0 control set (§1.1). These run dirs MUST survive until M6; the
// probe only ever READS `diff.patch` out of them.
const DIFF_ROOTS = [
  "/Users/juanma/Desktop/musive/musive-s1-prhero-runs",
  "/Users/juanma/Desktop/musive/musive-s2-prhero-runs",
  "/Users/juanma/Desktop/musive/musive-s3-prhero-runs",
];

interface CoverageTarget {
  pr: number;
  path: string;
  line: number;
}

// The five adjudicated `true-positive` misses over four PRs (§2.3, §3.10
// assertion 1). Two of them live in a markdown runbook on purpose — see the
// header.
const COVERAGE_TARGETS: CoverageTarget[] = [
  {
    pr: 1717,
    path: "packages/app/components/PaywallUpgrade/index.tsx",
    line: 119,
  },
  {
    pr: 1719,
    path: "packages/backend/src/Infrastructure/Http/SongSourceResolver.ts",
    line: 296,
  },
  { pr: 1722, path: "packages/backend/src/Utils/m4aRemux.ts", line: 181 },
  { pr: 1724, path: "docs/runbooks/mus-638-song-bucket-rollout.md", line: 144 },
  { pr: 1724, path: "docs/runbooks/mus-638-song-bucket-rollout.md", line: 140 },
];

// The six bucket-clean candidates (§3.10 assertion 2).
const RESTRAINT_PRS = [1698, 1703, 1708, 1715, 1720, 1721];

// The gates, stated once so they are arguable and so lowering one is a diff.
// AMENDED 2026-08-18, ratified by Juanma (`docs/scout-design.md` §3.10bis).
// The two `lead_coverage` RATIO gates are gone; the absolute one, ratified in
// the same sentence of §3.10, is the whole restraint gate now.
//
// WHY, and it is arithmetic rather than a result nobody liked: lead_coverage's
// denominator is hunk COUNT, which measures how git split the patch and not how
// much it changed. Measured on the restraint set, PR 1720 changed 1011 lines in
// 3 hunks while PR 1708 changed 386 in 95 — so the same scout emitting 6 leads
// on each scored 1.00 (worst possible) and 0.06 (best in the set). The run that
// was 4.6x DENSER in leads per changed line scored better. And on a 3-hunk PR
// the old 0.5 single-run ceiling permitted leads in ONE hunk: the quietest
// behaviour in all 60 measured runs — 2 leads over 1011 lines, 0.20 per 100 —
// still scored 0.667 and still failed. A gate no scout can pass is not
// measuring the scout.
//
// The circularity is on the record rather than hidden: this threshold set was
// chosen knowing v5's numbers. §3.11's two clean PRs in M6 are the guard that
// makes that survivable — they measure the DOWNSTREAM effect (hunters chasing
// spurious leads into junk findings), which this stage never could.
const RESTRAINT_MEAN_LEADS_MAX = 6;
// Still COMPUTED and still REPORTED, just not gated on. It remains the best
// available read on whether the scout is spreading itself over a whole diff,
// and deleting the measurement because the gate was wrong would throw away the
// evidence that proved it wrong.
const RESTRAINT_COVERAGE_DIAGNOSTIC_ONLY = true;
// §3.10 fixes the coverage gate at "2 of 3 replicates". `--replicates` exists
// for cheap prompt iteration, so the threshold scales with it rather than
// staying pinned at a literal 2 — at the ratified 3 replicates this is exactly
// the ratified gate.
const coverageRequiredHits = (replicates: number): number =>
  Math.max(1, Math.ceil((2 / 3) * replicates));

// The scout has no tools, so cwd is inert (§3.5's honest caveat: "no repo
// access" is enforced by the tool allow-list, never by a sandbox). An EMPTY
// scratch dir makes that visibly true instead of merely believed.
const SCRATCH_DIR_NAME = "scratch";

function fail(message: string): never {
  console.error(`scout-probe: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Flags — hand-rolled, and loudly intolerant of an unknown one: a silently
// ignored `--replicate 5` would produce a real number for a run nobody asked
// for, and the number would land in a commit description.

const argv = process.argv.slice(2);
let only: "coverage" | "restraint" | "both" = "both";
let replicates = 3;
let model = "sonnet";
let promptPath = "prompts/scout.md";
// The summarizer's non-hunter budget (§3.5 mechanism 4) is the DEFAULT, not a
// constant, because the first live pass measured 96-300s per scout step and
// killed one run of four at the ceiling. A watchdog is a hang guard — what
// forbids the scout from verifying is `tools: []`, mechanism 1 — so the number
// is tunable, and whichever value M6 runs under has to be the value M5 ships.
// Recorded in the artifact so a result always carries the ceiling it ran at.
let timeoutMinutes = 5;
let outDir: string | undefined;
const prFilter: number[] = [];

for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const value = argv[i + 1];
  const need = (): string => {
    if (value === undefined || value.startsWith("--")) {
      fail(`${flag} requires a value`);
    }
    i++;
    return value;
  };
  switch (flag) {
    case "--only": {
      const v = need();
      if (v !== "coverage" && v !== "restraint") {
        fail("--only must be `coverage` or `restraint`");
      }
      only = v;
      break;
    }
    case "--pr": {
      const n = Number(need());
      if (!Number.isInteger(n) || n <= 0)
        fail("--pr must be a positive integer");
      prFilter.push(n);
      break;
    }
    case "--replicates": {
      const n = Number(need());
      if (!Number.isInteger(n) || n <= 0) {
        fail("--replicates must be a positive integer");
      }
      replicates = n;
      break;
    }
    case "--timeout": {
      const n = Number(need());
      if (!Number.isFinite(n) || n <= 0) {
        fail("--timeout must be a positive number of minutes");
      }
      timeoutMinutes = n;
      break;
    }
    case "--model":
      model = need();
      break;
    case "--prompt":
      promptPath = need();
      break;
    case "--out":
      outDir = need();
      break;
    default:
      fail(
        `unknown flag ${flag} — usage: --only coverage|restraint, --pr <n> ` +
          "(repeatable), --replicates <n>, --timeout <minutes>, " +
          "--model <name>, --prompt <path>, --out <dir>",
      );
  }
}

const dryRun = process.env.SCOUT_PROBE_DRY === "1";

const targetsInScope = COVERAGE_TARGETS.filter(
  (t) =>
    only !== "restraint" && (prFilter.length === 0 || prFilter.includes(t.pr)),
);
const restraintPrsInScope = RESTRAINT_PRS.filter(
  (pr) =>
    only !== "coverage" && (prFilter.length === 0 || prFilter.includes(pr)),
);
// Distinct PRs, coverage first, in declaration order — the run order below is
// this list, so the money is spent on the gate that can fail hardest first.
const prsInScope = [
  ...new Set([...targetsInScope.map((t) => t.pr), ...restraintPrsInScope]),
];
if (prsInScope.length === 0) {
  fail("no PRs in scope — check --only and --pr");
}
// A run restricted by --pr cannot report a full PASS: its verdict covers only
// what was in scope. Iteration stays cheap; a subset never gets to look like
// the ratified gate.
const scope = prFilter.length === 0 && only === "both" ? "full" : "restricted";

// ---------------------------------------------------------------------------
// Diff resolution + preflight. Everything here is free, and it runs BEFORE any
// spawn so a broken setup costs $0.

// Sorted, not readdir order: s3 holds `pr-1722-...-1` AND `-2`, and an
// unsorted "first match" would resolve a different patch on a different
// machine — a probe whose INPUT varies measures nothing.
async function resolveDiffPath(pr: number): Promise<string> {
  for (const root of DIFF_ROOTS) {
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name.startsWith(`pr-${pr}-`))
        .map((e) => e.name)
        .sort();
    } catch {
      continue; // a missing root is reported by the caller's "no diff" failure
    }
    const first = entries[0];
    if (first !== undefined) return path.join(root, first, "diff.patch");
  }
  return fail(
    `no run dir named pr-${pr}-* under any control-set root — the frozen ` +
      "M0 control set is the probe's only input (design §1.1)",
  );
}

interface PrInput {
  pr: number;
  diffPath: string;
  patch: string;
  hunks: HunkRange[];
}

const inputs = new Map<number, PrInput>();
for (const pr of prsInScope) {
  const diffPath = await resolveDiffPath(pr);
  const file = Bun.file(diffPath);
  if (!(await file.exists())) fail(`missing ${diffPath}`);
  const patch = await file.text();
  if (patch.trim().length === 0) fail(`empty diff ${diffPath}`);
  inputs.set(pr, { pr, diffPath, patch, hunks: parseHunkRanges(patch) });
}

// A coverage target the scout CANNOT SEE is an unwinnable gate, and finding
// that out after paying for 15 spawns is exactly the failure this check
// exists to prevent. Each target must sit inside a right-side hunk range of
// its own PR's diff — the same containment test `hunkCoverage` applies to a
// lead, so passing here means a correct lead is reachable.
interface PreflightRow {
  pr: number;
  path: string;
  line: number;
  hunk: string;
}
const preflightRows: PreflightRow[] = [];
for (const target of targetsInScope) {
  const input = inputs.get(target.pr);
  if (input === undefined) fail(`no diff loaded for PR ${target.pr}`);
  const wanted = normalizePath(target.path);
  const onPath = input.hunks.filter((h) => normalizePath(h.path) === wanted);
  if (onPath.length === 0) {
    fail(
      `PR ${target.pr}: ${target.path} appears in no hunk of ${input.diffPath} ` +
        "— the target is not diff-visible and the gate is unwinnable",
    );
  }
  const enclosing = onPath.find(
    (h) => target.line >= h.start && target.line <= h.end,
  );
  if (enclosing === undefined) {
    fail(
      `PR ${target.pr}: ${target.path}:${target.line} falls in none of that ` +
        `path's hunk ranges (${onPath
          .map((h) => `${h.start}-${h.end}`)
          .join(", ")}) — the target is not diff-visible`,
    );
  }
  preflightRows.push({
    pr: target.pr,
    path: target.path,
    line: target.line,
    hunk: `${enclosing.start}-${enclosing.end}`,
  });
}

// `tools: []` emitting `--tools ""` is THE mechanism that makes the scout
// incapable of verification (§3.5 mechanism 1). A `tools:` line accidentally
// added to the frontmatter would silently turn this probe into a measurement
// of a different stage — one with repository access — so it is asserted before
// a cent is spent, not assumed.
const agent = await parseAgentFile(promptPath);
if (agent.tools.length > 0) {
  fail(
    `${promptPath} declares tools [${agent.tools.join(", ")}] — the scout ` +
      "must have none (design §3.5 mechanism 1)",
  );
}
const promptSource = await Bun.file(promptPath).text();
const promptSha256 = new Bun.CryptoHasher("sha256")
  .update(promptSource)
  .digest("hex");

// Built in the preflight, so an invalid --model fails a $0 dry run too.
const route = (() => {
  try {
    return singleStepRoute("scout", model);
  } catch (error) {
    return fail(`--model ${model}: ${(error as Error).message}`);
  }
})();
const ranOn = routeIdentityFields(route.identity);

const plannedSpawns = prsInScope.length * replicates;
console.error(
  [
    "scout-probe preflight OK",
    `  prompt      ${promptPath} (sha256 ${promptSha256.slice(0, 12)})`,
    `  model       ${model} (route ${ranOn.route.backend}:${ranOn.route.provider}/${ranOn.route.modelSnapshot}, fingerprint ${ranOn.step_route_fingerprint.slice(0, 12)})`,
    `  replicates  ${replicates}`,
    `  timeout     ${timeoutMinutes} min per step`,
    `  scope       ${scope} (--only ${only}${
      prFilter.length > 0 ? `, --pr ${prFilter.join(",")}` : ""
    })`,
    `  PRs         ${prsInScope.join(", ")}`,
    `  spawns      ${plannedSpawns}`,
    ...preflightRows.map(
      (r) => `  target      PR ${r.pr} ${r.path}:${r.line} in hunk ${r.hunk}`,
    ),
    ...restraintPrsInScope.map((pr) => {
      const input = inputs.get(pr);
      return `  restraint   PR ${pr} ${input?.hunks.length ?? 0} hunks`;
    }),
  ].join("\n"),
);

if (dryRun) {
  console.error("SCOUT_PROBE_DRY=1 — plan printed, nothing spawned, $0 spent");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The run. Everything below spends money.

const startedAt = Date.now();
// ABSOLUTE, and that word is a paid-for failure rather than a preference. The
// spawned CLI resolves `--append-system-prompt` (and `--mcp-config`) against
// ITS OWN cwd, which this probe deliberately points at an empty scratch dir —
// so a relative runDir became `<scratch>/<runDir>/scout.system.md` and all four
// runs of the first live pass died in under a second with "Append system prompt
// file not found", four format-retries and $0 of signal. The engine's own run
// dirs are absolute (`cli.ts`), so this is the probe matching the seam.
const runDir = path.resolve(
  outDir ??
    path.join(
      ".prhero",
      "scout-probe",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
);
const systemPromptPath = path.join(runDir, "scout.system.md");
await Bun.write(systemPromptPath, agent.body);
// Empty MCP registry + the runner's --strict-mcp-config: nothing can leak in,
// and it matches what M5 will hand a scout step.
const mcpConfigPath = path.join(runDir, "mcp.json");
await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
const scratchDir = path.join(runDir, SCRATCH_DIR_NAME);
// mkdir, not a placeholder file: the point of this directory is that it is
// EMPTY, so leaving a `.keep` in it would undercut the only thing it asserts.
await mkdir(scratchDir, { recursive: true });

// Prepared as a review prepares it: the run's Claude credential, production
// admission, the route seam.
const runner = await prepareSingleStepRunner({
  workspaceRoot: scratchDir,
  route,
  claudeRun: resolveRunClaudeCredential({}),
});

type RunRecord = typeof ranOn & {
  pr: number;
  replicate: number;
  status: "ok" | "failed";
  duration_ms: number;
  cost_usd: number;
  attempts: number;
  raw_lead_count: number;
  capped_lead_count: number;
  dropped: number;
  why_truncated: number;
  hunk_coverage_raw: HunkCoverage;
  hunk_coverage_capped: HunkCoverage;
  raw_leads: ScoutLead[];
  capped_leads: ScoutLead[];
  out_path: string;
  // Only on a failed run. The per-attempt logs collide across runs (the runner
  // keys them by step NAME, which is "scout" for every one), so the witness is
  // preserved here or it is lost.
  failure_tail?: string;
};

const emptyCoverage = (patch: string): HunkCoverage => hunkCoverage(patch, []);

async function runOnce(input: PrInput, replicate: number): Promise<RunRecord> {
  const outPath = path.join(runDir, `${input.pr}-r${replicate}.leads.json`);
  // Composed exactly the way pipeline.ts composes the summarizer's StepSpec
  // (`pipeline.ts:514-535`), so what M5 ships is what M4 tuned. A probe that
  // hand-rolled the spawn would measure the hand-rolled spawn.
  const spec: StepSpec = {
    // Unique per run, unlike M5's plain "scout". The runner keys its
    // per-attempt log as `<outDir>/logs/<name>.<attempt>.log`
    // (`step-runner.ts:433`), so a shared name would let 30 paid runs
    // overwrite one file and every failure would lose the log that explains
    // it. `name` reaches logs and telemetry only — never the prompt, the
    // model, the tools or the argv — so this costs the probe nothing
    // methodologically and buys back the diagnostic.
    name: `scout-${input.pr}-r${replicate}`,
    systemPromptPath,
    // One nonce per run (O-3.3), drawn against the only block this prompt
    // wraps — the patch. Each replicate is its own run, so it draws its own.
    prompt: scoutPrompt(input.patch, selectBoundaryNonce([input.patch])),
    tools: agent.tools,
    mcpConfigPath,
    model,
    effort: agent.effort ?? defaultEffortForRole("scout"),
    cwd: scratchDir,
    outPath,
    // §3.5 mechanism 4: one attempt, a bounded watchdog (`--timeout`, default
    // the summarizer's 5 minutes). (The runner's format-retry is capped at one
    // IN ADDITION to maxAttempts, so a prose-emitting scout still gets exactly
    // one reminder respawn — that is the seam M5 inherits, not a bug here.)
    timeoutMs: timeoutMinutes * 60 * 1000,
    maxAttempts: 1,
    parse: (finalText) => {
      const extracted = extractJsonObject(finalText);
      if (extracted === undefined) {
        throw new Error("scout final message has no JSON object");
      }
      return validateScoutLeads(extracted);
    },
  };

  const startedRun = Date.now();
  const result = await runner.run(spec);
  const duration_ms = Date.now() - startedRun;

  if (result.status !== "ok") {
    // A failed replicate is DATA, not an abort: it is reported in its own
    // column and never retried here (retrying would spend the maxAttempts: 1
    // decision the design made on purpose).
    return {
      ...ranOn,
      pr: input.pr,
      replicate,
      status: "failed",
      duration_ms,
      cost_usd: result.usage.cost_usd_est,
      attempts: result.attempts,
      raw_lead_count: 0,
      capped_lead_count: 0,
      dropped: 0,
      why_truncated: 0,
      hunk_coverage_raw: emptyCoverage(input.patch),
      hunk_coverage_capped: emptyCoverage(input.patch),
      raw_leads: [],
      capped_leads: [],
      out_path: outPath,
      failure_tail: `${result.stderrTail}\n${result.resultText}`.slice(-2000),
    };
  }

  const raw = result.output as ScoutLead[];
  const capped = capScoutLeads(raw);
  return {
    ...ranOn,
    pr: input.pr,
    replicate,
    status: "ok",
    duration_ms,
    cost_usd: result.usage.cost_usd_est,
    attempts: result.attempts,
    raw_lead_count: raw.length,
    capped_lead_count: capped.leads.length,
    dropped: capped.dropped,
    why_truncated: capped.whyTruncated,
    hunk_coverage_raw: hunkCoverage(input.patch, raw),
    hunk_coverage_capped: hunkCoverage(input.patch, capped.leads),
    raw_leads: raw,
    capped_leads: capped.leads,
    out_path: outPath,
  };
}

const records: RunRecord[] = [];
// SEQUENTIAL, replicate-outer: it mirrors M6's serial execution and keeps the
// live cost legible. Replicate-outer rather than PR-outer for refuter-probe's
// reason — any drift in service behaviour over the probe's wall clock then
// hits every PR evenly instead of loading one of them.
try {
  for (let r = 1; r <= replicates; r++) {
    for (const pr of prsInScope) {
      const input = inputs.get(pr);
      if (input === undefined) throw new Error(`no diff loaded for PR ${pr}`);
      const record = await runOnce(input, r);
      records.push(record);
      console.error(
        `[PR ${record.pr} #${r}] ${record.status} raw=${record.raw_lead_count} ` +
          `capped=${record.capped_lead_count} dropped=${record.dropped} ` +
          `whyTrunc=${record.why_truncated} ` +
          `cov=${record.hunk_coverage_capped.coverage.toFixed(2)} ` +
          `unmatched=${record.hunk_coverage_capped.unmatchedLeads} ` +
          `${(record.duration_ms / 1000).toFixed(0)}s ` +
          `$${record.cost_usd.toFixed(4)}`,
      );
    }
  }
} finally {
  await runner.dispose();
}

// ---------------------------------------------------------------------------
// Assertions.

// A hit reuses compare/compare.ts's window rather than a second definition of "the
// same place": the head-to-head, the §3.9 attribution rule and this gate must
// all agree, or a scout that "hit" here would be `unled` there.
function hits(leads: ScoutLead[], target: CoverageTarget): boolean {
  const wanted = normalizePath(target.path);
  return leads.some(
    (l) =>
      normalizePath(l.path) === wanted &&
      Math.abs(l.line - target.line) <= DEFAULT_LINE_WINDOW,
  );
}

interface CoverageCase {
  pr: number;
  path: string;
  line: number;
  replicates: number;
  hits_capped: number;
  hits_raw: number;
  required_hits: number;
  pass: boolean;
}

const requiredHits = coverageRequiredHits(replicates);
const coverageCases: CoverageCase[] = targetsInScope.map((target) => {
  const runs = records.filter((rec) => rec.pr === target.pr);
  // The denominator is --replicates, NOT the ok-run count: a failed replicate
  // counts as a MISS here. That is the conservative direction — a probe that
  // shrank its denominator when a spawn died would report a gate it did not
  // measure.
  const hits_capped = runs.filter((rec) =>
    hits(rec.capped_leads, target),
  ).length;
  const hits_raw = runs.filter((rec) => hits(rec.raw_leads, target)).length;
  return {
    pr: target.pr,
    path: target.path,
    line: target.line,
    replicates,
    // Gated on CAPPED: capped is what M5 hands the hunters, so a raw-only pass
    // would be a false pass of the M6 question. Raw is printed beside it
    // because a raw hit the cap ate is a cap/prompt interaction, not a
    // coverage failure.
    hits_capped,
    hits_raw,
    required_hits: requiredHits,
    pass: hits_capped >= requiredHits,
  };
});

// Restraint means are computed over OK runs only. A failed run carries zero
// leads and zero coverage, which would FLATTER both gates — the opposite of
// the coverage denominator's direction, and conservative for the same reason.
const restraintRuns = records.filter(
  (rec) => rec.status === "ok" && restraintPrsInScope.includes(rec.pr),
);
const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
const restraintCoverages = restraintRuns.map(
  (rec) => rec.hunk_coverage_capped.coverage,
);
const restraint = {
  runs: restraintRuns.length,
  failed_runs: records.filter(
    (rec) => rec.status === "failed" && restraintPrsInScope.includes(rec.pr),
  ).length,
  mean_lead_coverage: mean(restraintCoverages),
  max_lead_coverage:
    restraintCoverages.length === 0 ? 0 : Math.max(...restraintCoverages),
  mean_leads_per_pr: mean(restraintRuns.map((rec) => rec.capped_lead_count)),
  mean_raw_leads_per_pr: mean(restraintRuns.map((rec) => rec.raw_lead_count)),
  gates: {
    mean_leads_per_pr_max: RESTRAINT_MEAN_LEADS_MAX,
    lead_coverage_gated: !RESTRAINT_COVERAGE_DIAGNOSTIC_ONLY,
  },
  pass: false,
};
restraint.pass =
  restraint.runs > 0 && restraint.mean_leads_per_pr <= RESTRAINT_MEAN_LEADS_MAX;

const coverageAssertion = {
  requested: only !== "restraint",
  cases: coverageCases,
  required_hits: requiredHits,
  pass: coverageCases.length > 0 && coverageCases.every((c) => c.pass),
};
const restraintAssertion = {
  requested: only !== "coverage",
  ...restraint,
};

const totalCostUsd = records.reduce((s, rec) => s + rec.cost_usd, 0);
const wallMs = Date.now() - startedAt;
const failedRuns = records.filter((rec) => rec.status === "failed").length;
const gatesPassed =
  (!coverageAssertion.requested || coverageAssertion.pass) &&
  (!restraintAssertion.requested || restraintAssertion.pass);

const report = {
  generated_at: new Date().toISOString(),
  prompt_path: promptPath,
  prompt_sha256: promptSha256,
  model,
  ...ranOn,
  replicates,
  // The ceiling this result ran under. A coverage number is only comparable to
  // another one taken at the same watchdog: a killed run scores as a miss, so
  // without this field a tightened timeout would read as a worse prompt.
  timeout_minutes: timeoutMinutes,
  scope,
  only,
  pr_filter: prFilter,
  prs: prsInScope,
  run_dir: runDir,
  runs: records,
  failed_runs: failedRuns,
  coverage: coverageAssertion,
  restraint: restraintAssertion,
  total_cost_usd: Number(totalCostUsd.toFixed(4)),
  wall_ms: wallMs,
  verdict: gatesPassed ? "pass" : "fail",
};

const reportPath = path.join(runDir, "scout-probe.json");
await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);

// Printed FROM the report object, never computed a second time here: nothing
// may reach a commit description that is not also in the artifact.
const lines: string[] = [
  "",
  `scout-probe — ${report.prompt_path} (sha256 ${report.prompt_sha256.slice(0, 12)}) ` +
    `model=${report.model} replicates=${report.replicates} scope=${report.scope}`,
  "",
];
if (coverageAssertion.requested) {
  lines.push("COVERAGE — the five adjudicated greptile_only misses");
  for (const c of coverageAssertion.cases) {
    lines.push(
      `  PR ${c.pr} ${c.path}:${c.line}  capped ${c.hits_capped}/${c.replicates}  ` +
        `raw ${c.hits_raw}/${c.replicates}  (need ${c.required_hits})  ` +
        `${c.pass ? "PASS" : "FAIL"}`,
    );
  }
  lines.push(
    `  => coverage ${coverageAssertion.pass ? "PASS" : "FAIL"}` +
      (report.scope === "restricted"
        ? ` (RESTRICTED: ${coverageAssertion.cases.length} of ${COVERAGE_TARGETS.length} cases in scope)`
        : ""),
    "",
  );
}
if (restraintAssertion.requested) {
  lines.push(
    `RESTRAINT — ${restraintAssertion.runs} ok runs over ` +
      `${restraintPrsInScope.length} PRs (${restraintAssertion.failed_runs} failed)`,
    `  mean lead_coverage   ${restraintAssertion.mean_lead_coverage.toFixed(3)}  ` +
      "(diagnostic — NOT a gate since 2026-08-18, see §3.10bis)",
    `  max  lead_coverage   ${restraintAssertion.max_lead_coverage.toFixed(3)}  ` +
      "(diagnostic — NOT a gate since 2026-08-18, see §3.10bis)",
    `  mean leads per PR    ${restraintAssertion.mean_leads_per_pr.toFixed(2)}  ` +
      `gate <= ${RESTRAINT_MEAN_LEADS_MAX}  ` +
      `${restraintAssertion.mean_leads_per_pr <= RESTRAINT_MEAN_LEADS_MAX ? "PASS" : "FAIL"}`,
    `  mean RAW leads/PR    ${restraintAssertion.mean_raw_leads_per_pr.toFixed(2)}  ` +
      "(no gate — a raw count far above the capped one is a PROMPT defect, " +
      "never a cap to raise)",
    `  => restraint ${restraintAssertion.pass ? "PASS" : "FAIL"}` +
      (report.scope === "restricted"
        ? ` (RESTRICTED: ${restraintPrsInScope.length} of ${RESTRAINT_PRS.length} PRs in scope)`
        : ""),
    "",
  );
}
lines.push(
  `failed runs   ${report.failed_runs} of ${report.runs.length}`,
  `total cost    $${report.total_cost_usd.toFixed(4)}`,
  `wall clock    ${(report.wall_ms / 60000).toFixed(1)} min`,
  `artifact      ${reportPath}`,
  `VERDICT       ${report.verdict.toUpperCase()}`,
  "",
);
console.log(lines.join("\n"));

// A probe whose failure exits 0 is a gate that gets quietly lowered.
process.exit(gatesPassed ? 0 : 1);
