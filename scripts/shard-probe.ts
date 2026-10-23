// Shard probe (ROADMAP A1 diagnostic — NOT a benchmark arm).
//
// THE QUESTION. Does splitting a large diff into K BLIND zones, one hunter copy
// per zone, find a known defect more often than one hunter over the full diff —
// NET OF COMPUTE? `scripts/scope-probe-scored-g2.ts` measured full 0/8 vs
// oracle-narrowed 4/8 (p~=0.077, ROADMAP.md, "scope-probe-scored-g2"), but its
// narrowed arm was handed the golden's own file: the narrowing KNEW where the
// bug was. Two things that result cannot separate are measured here at once:
// narrowing without an oracle, and "narrowing" vs simply "more samples".
//
// PRE-REGISTRATION, fixed 2026-10-06 before any spend (odd/tasks/shard-probe.md
// is the design record; this header restates it so the file stands alone):
//   - Hypothesis: a hunter that sees one blind zone of a large diff finds a
//     defect in that zone more often than a hunter that sees the whole diff,
//     and that gain is NOT explained by running K hunters instead of one.
//   - Tree: PR 1544 @ 27e85937, base 637a7be0, the 45-file / 4947-line diff
//     recorded by lab run 531. One golden on the tree.
//   - Arms (the ONE variable is how much of the diff each hunter call sees):
//       A `full`    — 1 runPipeline call over the full diff.
//       B `sharded` — K=5 calls, each over one zone's diff.
//       C `control` — K=5 calls, each over the FULL diff. Compute-matched to
//                     B, merged and scored exactly like B.
//   - Zone rule: `splitIntoZones` below — sections sorted by path, cut into at
//     most K contiguous zones balanced by patch lines, never splitting a file.
//     It reads the patch and nothing else; no golden information can reach it.
//   - Scoring: per arm per replicate, the findings of ALL that arm's calls
//     (survivors + refuted + deduped) are merged with call-prefixed ids and
//     scored by ONE lab `scoreTree` call — SAME MECHANISM, OR NO MATCH.
//   - Reading: the `READING` constant below, copied verbatim from the design
//     record and NOT to be revised after seeing the numbers.
//
// STATED LIMITS.
//   - One tree, one golden, n=6. A result here is one data point about one
//     defect shape, not a property of sharding.
//   - Cross-zone bugs are untested: the golden's mechanism sits inside one
//     file, so a cut can never separate it from its own evidence. A defect that
//     spans two zones is exactly where sharding should hurt, and there is no
//     corpus case for it.
//   - Sharded hunters are not sealed inside their zone. The worktree is the
//     full checkout and the hunter keeps Read/Grep/Glob, so a sharded call can
//     still read any file — the zone narrows what it is SHOWN, not what it can
//     reach.
//   - A ran 1 process; B and C ran 5 concurrently. A-vs-C therefore carries a
//     concurrency / rate-limit confound that B-vs-C does not, which is one more
//     reason the reading keys on B-vs-C.
//   - B and C findings are concatenated without cross-call dedupe, so `novel`
//     can count one underlying finding up to 5 times. Read `novel` per arm as
//     a noise indicator, not a count of distinct claims.
//
// EVERYTHING THAT IS NOT THE VARIABLE IS g2's, IDENTICALLY. Same hunter source
// (`slice3b-lifecycle-v2` lifecycle agent), same single-hunter PROBE_SPEC, same
// hopBudget, same gotchas, same step timeout, codegraph OFF via an empty MCP
// config, same runner authority, same one-controller-per-call ceiling wiring,
// same golden loader, same scorable set, same output hygiene. The priors are
// the one deliberate departure, and they are identical across all three arms —
// see SUSPICION_PRIORS.
//
// GOLDENS COME FROM train.jsonl, NOT test.jsonl. PR 1544 is on the dataset's
// BURNED list, which forces every one of its findings into TRAIN. The held-out
// test.jsonl is never opened by this probe, and must never be. Goldens are
// loaded in THIS driver process and passed only to `scoreTree` (scorer.ts:10-11:
// "The judge is deliberately NOT the engine: it sees golden bodies, which no
// hunter may ever see"). Nothing from a golden reaches a hunter's prompt, its
// worktree, its diff, the zone cut, or this file's output artifact.
//
// OUTPUT HYGIENE. The artifact carries golden KEYS and outcomes only. Golden
// bodies, golden claims and finding claim text never enter it, and judge
// `reasoning` (which paraphrases the golden by construction, scorer.ts:150) is
// dropped on the floor, never printed.
//
// COST. Two spend sources, and only ONE of them is in the cost totals:
//   1. Hunter steps — 11 runPipeline calls per replicate (1 + 5 + 5).
//   2. Judge calls — `scoreTree` spawns one short sonnet round-trip per
//      (golden x finding) pair, with no tools and no MCP. Counted
//      (`judge_calls`), never priced: the pipeline's usage accounting never
//      sees them, and a made-up per-call figure would be a fabricated cost.
//
// Run:
//   bun run scripts/shard-probe.ts plan              # $0: goldens, zones, worktree, call count
//   bun run scripts/shard-probe.ts run [replicates]  # default 6
//
// LIVE (`run`): spends real money; record the result (ROADMAP.md + the design
// record). `plan` spends nothing: no model calls, no judge calls.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPipeline } from "#review/pipeline";
import { gotchasUnusableReason } from "#review/preflight";
import type { SuspicionPrior } from "#review/prompt-set";
import type { ReviewSpec } from "#review/spec";
import { ClaudeCodeRunner } from "#review/step-runner";
import {
  type GoldenRow,
  goldenKey,
  goldensForTree,
  type ScorableFinding,
  scoreTree,
} from "../../deep-review/runner/scorer";
import { writeJsonAtomically } from "../src/execution/atomic-write";
import { resolveRunnerAuthority } from "../src/runner-authority";
import { redactDiagnostic } from "../src/security/redact";

const LAB = "/Users/juanma/Desktop/deep-review";
const WORKTREE =
  "/Users/juanma/Desktop/musive/musive-worktrees/shard-probe-1544";
const FULL_DIFF = `${LAB}/bench/runs/531/27e859379b71ab0d707b4cbddf5a278a8dbd2128/diff.patch`;
const AGENT_SOURCE = `${LAB}/agents/slice3b-lifecycle-v2/deep-review-lifecycle.md`;
const GOTCHAS = `${LAB}/intel/gotchas.md`;
// train.jsonl, not test.jsonl — see the BURNED note in the header.
const DATASET = `${LAB}/dataset/train.jsonl`;
const SMOKE_CONFIG = `${LAB}/runner/config/smoke.config.json`;
const PR = 1544;
const BASE_SHA = "637a7be04b2ad8ed121f35d1df7ddbe3772e2f5b";
const HEAD_SHA = "27e859379b71ab0d707b4cbddf5a278a8dbd2128";
const K = 5;
const DEFAULT_REPLICATES = 6;
const HOP_BUDGET = 12;
const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const OUT = path.join(LAB, "bench", "probes", "shard-probe-1544.json");

// WHY $90, and WHY it is checked against LIST-BASIS spend rather than
// `result.usage.cost_usd_est` alone. The run was authorized at ~$60-75; $90
// leaves room for variance on the 66 calls without letting a runaway (a retry
// storm, a hunter looping to its step timeout five times over) spend
// unbounded money. The legacy `usage.cost_usd_est` projects CASH only
// (`usage-normalized.ts`: `cost_usd_est: usage.cashCostUsd ?? 0`), and on a
// Claude subscription route cash is a truthful $0.00 with the list-basis
// figure filed as `usageV2.notionalCostUsd` instead (#173/#177). A cap on cash
// alone would therefore never fire on a subscription — a guard that cannot
// trip is not a guard. The transport files each attempt's figure in exactly
// ONE of the two fields (cash on a metered key, notional on a subscription),
// so `cash + notional` is the list-basis spend on either route, and that sum
// is what the cap reads. Judge calls are NOT in it (see COST in the header),
// and neither is a call whose spend came back unknown (`spendUnknown`, or a
// subscription call with no notional figure) — the cap is a floor on what was
// spent, never a ceiling on it.
const SPEND_CAP_USD = 90;

// WHY EMPTY, and WHY that departs from g2. g2 handed every arm one neutral
// prior, `packages/web/src/components/**`, chosen there because it did not
// name the golden's file. On THIS tree that same glob covers the golden's
// directory (`packages/web/src/components/SongComments/AudioTrimmer/`), so
// reusing it would leak a pointer at the answer into all three arms. A
// different "neutral" glob is worse in a sharded design: a prior naming a file
// lives in exactly one zone, so it would pull the four other sharded hunters
// toward a file outside what they were shown, and pull nothing in the full
// and control arms — the prior would itself vary with the arm. An empty list
// is the one prior set that is identical in effect across arms.
// `renderPriorsBlock([])` is "" and `wrapBlock` returns "" for empty content,
// so the agent's "## Suspicion priors" heading is followed by its own
// "Higher weight is more reason..." guidance with no file weighted — a
// coherent prompt, accepted cleanly by runPipeline.
const SUSPICION_PRIORS: SuspicionPrior[] = [];

// Copied verbatim from odd/tasks/shard-probe.md ("Design (pre-registered
// 2026-10-06, before any spend)"). A = full, B = sharded, C = control.
const READING =
  "Reading (n=6): support if B beats C by >=3/6; no effect if |B-C| <= 1 (and if C > A, the lever is replicates, not sharding); otherwise inconclusive, redesign nothing.";

// MODEL. Selected exactly as g2 selected it: NO `input.model` and no
// `AgentSpec.model`, so `resolveModel` (pipeline.ts) falls through to its third
// seat, the agent file's frontmatter (`model: sonnet`). That is an explicit
// choice recorded in the prompt set, not an implicit default, so it is left
// alone rather than pinned here — passing `input.model` would change the
// precedence path the engine takes (it also feeds route planning as
// `cliModel`). Effort is engine-resolved per role (#299) and therefore the same
// in all three arms. What each call ACTUALLY ran is recorded per call from its
// own pipeline.json and attempt log (`readHunterProvenance`).
const PROBE_SPEC: ReviewSpec = {
  agents: [
    { key: "lifecycle", file: "deep-review-lifecycle.md", role: "hunter" },
  ],
};
const HUNTER_STEP = "hunter-lifecycle";

type Arm = "full" | "sharded" | "control";
const ARMS: readonly Arm[] = ["full", "sharded", "control"];
const ARM_LETTER: Record<Arm, "A" | "B" | "C"> = {
  full: "A",
  sharded: "B",
  control: "C",
};

export interface Zone {
  index: number;
  paths: string[];
  lines: number;
  patch: string;
}

interface Section {
  original: number; // position in the input patch, for the coverage check
  path: string;
  lines: number;
  text: string;
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

// Blind, deterministic zone cut. Reads the patch and nothing else — no golden,
// no prior, no path weighting — so no information about where the defect is
// can shape the zones.
//
// Same `diff --git` record split as g2's `narrowPatch`, so hunk headers travel
// with their file and a file is never split. The path is the ` b/` side of the
// header (the post-image name, which is what the worktree holds). Sections are
// then ordered by path in BYTE order (an explicit comparator — not
// `localeCompare`, whose collation varies by ICU build), which means a zone's
// patch lists its files in sorted order, NOT in the original diff's order.
//
// "Lines" is the count of `\n` in a section, defined once here so a zone's
// size, the target and the plan output all mean the same thing.
//
// Cut rule: target = ceil(totalLines / k). Walk the sorted sections; start a
// new zone when adding the next section would push the current zone past the
// target AND the current zone is non-empty AND fewer than k zones exist yet
// (the current one included). So a section bigger than the target lands in a
// zone of its own, and once k zones exist the last one absorbs the remainder.
export function splitIntoZones(patch: string, k: number): Zone[] {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`splitIntoZones: k must be a positive integer, got ${k}`);
  }
  const parts = patch.split(/(?=^diff --git )/m).filter((s) => s.length > 0);
  if (parts.length === 0) throw new Error("splitIntoZones: empty patch");
  const sections: Section[] = parts.map((text, original) => {
    // A preamble (format-patch mail headers, a stray line) would otherwise be
    // silently glued to no file and dropped from every zone.
    const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(
      text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n")),
    );
    if (!text.startsWith("diff --git ") || header?.[2] === undefined) {
      throw new Error(
        `splitIntoZones: section ${original} has no parseable 'diff --git a/... b/...' header: ${JSON.stringify(text.slice(0, 80))}`,
      );
    }
    return { original, path: header[2], lines: countLines(text), text };
  });
  sections.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const total = sections.reduce((s, x) => s + x.lines, 0);
  const target = Math.ceil(total / k);
  const groups: Section[][] = [[]];
  let currentLines = 0;
  for (const section of sections) {
    const current = groups[groups.length - 1] as Section[];
    if (
      currentLines + section.lines > target &&
      current.length > 0 &&
      groups.length < k
    ) {
      groups.push([section]);
      currentLines = section.lines;
    } else {
      current.push(section);
      currentLines += section.lines;
    }
  }

  const zones: Zone[] = groups.map((group, index) => ({
    index,
    paths: group.map((s) => s.path),
    lines: group.reduce((s, x) => s + x.lines, 0),
    patch: group.map((s) => s.text).join(""),
  }));

  // Fail loud: every input section in exactly one zone, nothing invented.
  const seen = new Map<number, number>();
  for (const group of groups) {
    for (const s of group)
      seen.set(s.original, (seen.get(s.original) ?? 0) + 1);
  }
  const bad = parts.map((_, i) => i).filter((i) => seen.get(i) !== 1);
  const rejoined = zones.map((z) => z.patch).join("");
  if (
    bad.length > 0 ||
    seen.size !== parts.length ||
    rejoined.length !== patch.length ||
    zones.reduce((s, z) => s + z.lines, 0) !== countLines(patch) ||
    zones.length > k
  ) {
    throw new Error(
      `splitIntoZones: coverage check failed (sections not covered exactly once: [${bad.join(",")}], zones=${zones.length}, k=${k})`,
    );
  }
  return zones;
}

// The lab exports no golden loader — `score()` in runner/index.ts does this
// inline. Same steps, same alias source as g2, so the probe and the bench
// resolve identical goldens for a tree.
async function loadTreeGoldens(): Promise<GoldenRow[]> {
  const smokeConfig = JSON.parse(await Bun.file(SMOKE_CONFIG).text()) as {
    golden_commit_aliases?: Record<string, string>;
  };
  const goldens = (await Bun.file(DATASET).text())
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GoldenRow);
  const treeGoldens = goldensForTree(
    goldens,
    HEAD_SHA,
    smokeConfig.golden_commit_aliases ?? {},
  );
  if (treeGoldens.length === 0) {
    throw new Error(`no labelled goldens for ${HEAD_SHA}`);
  }
  return treeGoldens;
}

interface Inputs {
  fullPatch: string;
  diffSha256: string;
  zones: Zone[];
  treeGoldens: GoldenRow[];
  agentSource: string;
}

// Everything `run` needs that can be checked for $0, shared with `plan` so the
// two modes cannot disagree about what the run would see.
async function loadInputs(): Promise<Inputs> {
  const treeGoldens = await loadTreeGoldens();
  const fullPatch = await Bun.file(FULL_DIFF).text();
  const zones = splitIntoZones(fullPatch, K);
  if (zones.length !== K) {
    throw new Error(
      `pre-registered K=${K} but the diff cut into ${zones.length} zones`,
    );
  }
  const agentSource = await Bun.file(AGENT_SOURCE).text();
  // runPipeline's gotchas gate would otherwise turn every call into a
  // zero-finding `partial` — 66 silent misses that read as a result.
  const gotchasFile = Bun.file(GOTCHAS);
  const gotchas = (await gotchasFile.exists()) ? await gotchasFile.text() : "";
  const gotchasReason = gotchasUnusableReason(gotchas);
  if (gotchasReason !== undefined) {
    throw new Error(`gotchas unusable (${gotchasReason}): ${GOTCHAS}`);
  }
  verifyWorktree();
  return {
    fullPatch,
    diffSha256: createHash("sha256").update(fullPatch).digest("hex"),
    zones,
    treeGoldens,
    agentSource,
  };
}

function verifyWorktree(): void {
  if (!existsSync(WORKTREE)) {
    throw new Error(`worktree missing: ${WORKTREE}`);
  }
  const rev = Bun.spawnSync(["git", "-C", WORKTREE, "rev-parse", "HEAD"]);
  const head = rev.stdout.toString().trim();
  if (rev.exitCode !== 0 || head !== HEAD_SHA) {
    throw new Error(
      `worktree HEAD is ${head || "(unreadable)"}, expected ${HEAD_SHA}`,
    );
  }
}

interface PlannedCall {
  arm: Arm;
  tag: string; // "A0", "B3", "C1" — prefixes every finding id of the call
  zone?: number;
  patch: string;
}

function plannedCalls(arm: Arm, inputs: Inputs): PlannedCall[] {
  const letter = ARM_LETTER[arm];
  switch (arm) {
    case "full":
      return [{ arm, tag: `${letter}0`, patch: inputs.fullPatch }];
    case "sharded":
      return inputs.zones.map((z) => ({
        arm,
        tag: `${letter}${z.index}`,
        zone: z.index,
        patch: z.patch,
      }));
    case "control":
      // Compute-matched to `sharded`: the same number of calls, each over the
      // full diff.
      return inputs.zones.map((_, i) => ({
        arm,
        tag: `${letter}${i}`,
        patch: inputs.fullPatch,
      }));
  }
}

interface HunterProvenance {
  status?: string;
  attempts?: number;
  model?: string; // what the engine resolved and asked for
  effort?: string;
  modelSnapshot?: string;
  observedModels?: string[]; // what the provider says it ran
}

// pipeline.json's step rows, read loosely: `StepMeta` is not exported and this
// probe needs only provenance fields, each optional so an absent one stays
// absent instead of failing the record.
interface PlanStepRow {
  name?: string;
  model?: string;
  effort?: string;
  status?: string;
  attempts?: number;
  attemptLogPath?: string;
  route?: { modelSnapshot?: string };
}

// The engine's `model` field records what was ASKED for; the provider's own
// answer lives only in the attempt log's "--- observed models ---" section
// (harness.ts, #175 half 2). Both are recorded, and each is `undefined` rather
// than guessed when its source is missing.
async function readHunterProvenance(runDir: string): Promise<HunterProvenance> {
  const planFile = Bun.file(path.join(runDir, "pipeline.json"));
  if (!(await planFile.exists())) return {};
  let steps: PlanStepRow[] = [];
  try {
    steps = ((await planFile.json()) as { steps?: PlanStepRow[] }).steps ?? [];
  } catch {
    return {};
  }
  const step = steps.find((s) => s.name === HUNTER_STEP);
  if (step === undefined) return {};
  let observedModels: string[] | undefined;
  if (step.attemptLogPath !== undefined) {
    const log = Bun.file(path.join(runDir, step.attemptLogPath));
    if (await log.exists()) {
      const text = await log.text();
      const start = text.indexOf("--- observed models ---\n");
      const end = text.indexOf("--- result tail");
      if (start !== -1 && end > start) {
        const lines = text
          .slice(start + "--- observed models ---\n".length, end)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        observedModels = lines.length > 0 ? lines : undefined;
      }
    }
  }
  return {
    status: step.status,
    attempts: step.attempts,
    model: step.model,
    effort: step.effort,
    modelSnapshot: step.route?.modelSnapshot,
    observedModels,
  };
}

interface CallRecord {
  tag: string;
  zone?: number;
  diffFiles: number;
  diffLines: number;
  ok: boolean; // false when runPipeline rejected
  error?: string; // redacted, capped
  runStatus?: string;
  sessionFailed?: boolean;
  findings: number; // survivors + refuted + deduped
  survivors: number;
  refuted: number;
  deduped: number;
  cashUsd: number; // result.usage.cost_usd_est — $0 on a subscription
  notionalUsd?: number; // result.usageV2.notionalCostUsd — absent, never 0, when unknown
  listBasisUsd: number; // cash + notional; what the spend cap reads
  // Set only on a rejected call: it may have billed before it threw, and no
  // result came back to say how much, so its 0s above are "unknown", not "free".
  spendUnknown?: true;
  billingMode?: string;
  wallMs: number;
  hunter: HunterProvenance;
  locations: string[];
  runDir: string;
}

interface CallOutcome {
  record: CallRecord;
  scorable: ScorableFinding[];
}

async function runCall(
  call: PlannedCall,
  inputs: Inputs,
  runnerOptions: ConstructorParameters<typeof ClaudeCodeRunner>[0],
  ceilingController: AbortController,
): Promise<CallOutcome> {
  const base = await mkdtemp(path.join(tmpdir(), `pr-hero-shard-${call.tag}-`));
  const agentsDir = path.join(base, "agents");
  const runDir = path.join(base, "run");
  await mkdir(agentsDir);
  await mkdir(runDir);
  await writeFile(
    path.join(agentsDir, "deep-review-lifecycle.md"),
    inputs.agentSource,
  );
  const diffPath = path.join(base, "diff.patch");
  await writeFile(diffPath, call.patch);

  // CODEGRAPH OFF, as in g2 and in every arm here: an empty MCP config. The
  // golden's defect lives inside one file, so cross-file hops are not needed to
  // see it, and turning the index on would add a second variable.
  const mcpConfigPath = path.join(runDir, "mcp.json");
  await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

  const started = Date.now();
  // §5.3 D1-10b: ONE controller shared by the pipeline and the runner, and one
  // per CALL. The pipeline aborts it when the ceiling fires; the runner's
  // harness reads the same signal and refuses to start another attempt, so
  // in-flight steps stop instead of billing on past a report that has already
  // been returned. Two controllers would leave the ceiling unable to stop the
  // steps it is waiting on — and this probe spends real money. The spend cap
  // aborts the same controller from outside, which is why it is created by
  // the caller and not here.
  const result = await runPipeline(
    {
      pr: PR,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      worktree: WORKTREE,
      diffPath,
      gotchasPath: GOTCHAS,
      agentsDir,
      runDir,
      outPath: path.join(runDir, "findings.json"),
      mcpConfigPath,
      hopBudget: HOP_BUDGET,
      parityTriggerPaths: [],
      suspicionPriors: SUSPICION_PRIORS,
      stepTimeoutMs: STEP_TIMEOUT_MS,
      spec: PROBE_SPEC,
    },
    {
      runner: new ClaudeCodeRunner({
        ...runnerOptions,
        signal: ceilingController.signal,
      }),
      ceilingController,
    },
  );
  const wallMs = Date.now() - started;

  const { skillOutput } = result;
  // Surviving findings, refuted ones and dedupe losers all count as "the pass
  // saw it" — g2's candidate set, unchanged. Ids carry g2's origin prefix
  // (F/R/D) AND the call's tag, because the arm's calls are merged into ONE
  // scoreTree call, which keys its matched/novel bookkeeping on `id`, and every
  // call numbers its own findings from F001. Refuted and deduped rows carry no
  // `tier`; the scorer reads only path/line/symbol/claim, so a placeholder is
  // honest here.
  const refuted = skillOutput.debug.refuted;
  const deduped = skillOutput.debug.deduped ?? [];
  const scorable: ScorableFinding[] = [
    ...skillOutput.findings.map((f) => ({
      id: `${call.tag}-F${f.id}`,
      path: f.path,
      line: f.line,
      symbol: f.symbol,
      severity: f.severity,
      tier: f.tier,
      claim: f.claim,
    })),
    ...refuted.map((f) => ({
      id: `${call.tag}-R${f.id}`,
      path: f.path,
      line: f.line,
      symbol: f.symbol,
      severity: f.severity,
      tier: "refuted",
      claim: f.claim,
    })),
    ...deduped.map((f) => ({
      id: `${call.tag}-D${f.id}`,
      path: f.path,
      line: f.line,
      symbol: f.symbol,
      severity: f.severity,
      tier: "deduped",
      claim: f.claim,
    })),
  ];
  // Kept beside the run's own artifacts (tmp, never the output file, which
  // excludes claim text) so a scoring failure can be re-scored later without
  // paying for the hunters again.
  await writeFile(
    path.join(base, "scorable.json"),
    `${JSON.stringify(scorable, null, 2)}\n`,
  );

  const cashUsd = result.usage.cost_usd_est;
  const notionalUsd = result.usageV2?.notionalCostUsd;
  return {
    record: {
      tag: call.tag,
      ...(call.zone === undefined ? {} : { zone: call.zone }),
      diffFiles: call.patch.split(/^diff --git /m).length - 1,
      diffLines: countLines(call.patch),
      ok: true,
      runStatus: skillOutput.run_status,
      sessionFailed: result.sessionFailed,
      findings: scorable.length,
      survivors: skillOutput.findings.length,
      refuted: refuted.length,
      deduped: deduped.length,
      cashUsd,
      ...(notionalUsd === undefined ? {} : { notionalUsd }),
      listBasisUsd: cashUsd + (notionalUsd ?? 0),
      ...(result.usageV2 === undefined
        ? {}
        : { billingMode: result.usageV2.billingMode }),
      wallMs,
      hunter: await readHunterProvenance(runDir),
      locations: scorable.map((f) => `${f.path}:${f.line}`),
      runDir,
    },
    scorable,
  };
}

interface ArmRecord {
  arm: Arm;
  letter: "A" | "B" | "C";
  replicate: number;
  // True when the spend cap fired while at least one of this arm's calls was
  // still in flight: its findings are a truncated sample and it is not scored.
  aborted: boolean;
  scored: boolean;
  scoreError?: string;
  hit: boolean;
  matched: string[]; // golden keys hit, by mechanism
  findingsTotal: number;
  novel: number; // findings that matched no golden
  failedCalls: number; // rejected, or sessionFailed — a miss here may be no hunt at all
  costUsd: number; // sum of result.usage.cost_usd_est — CASH only
  notionalUsd: number; // sum of usageV2.notionalCostUsd over calls that reported it
  listBasisUsd: number;
  judgeCalls: number;
  wallMs: number; // hunting only, the arm's concurrent calls
  scoreWallMs: number;
  calls: CallRecord[];
}

interface SpendState {
  listBasisUsd: number;
  capTripped: boolean;
}

function round(n: number, digits = 4): number {
  return Number(n.toFixed(digits));
}

async function runArm(
  arm: Arm,
  replicate: number,
  inputs: Inputs,
  runnerOptions: ConstructorParameters<typeof ClaudeCodeRunner>[0],
  spend: SpendState,
): Promise<ArmRecord> {
  const calls = plannedCalls(arm, inputs);
  const controllers = calls.map(() => new AbortController());
  let pending = calls.length;
  let aborted = false;
  const started = Date.now();
  // allSettled, never all: one rejected call must not discard its siblings'
  // records — they were paid for.
  const settled = await Promise.allSettled(
    calls.map(async (call, i) => {
      try {
        const outcome = await runCall(
          call,
          inputs,
          runnerOptions,
          controllers[i] as AbortController,
        );
        spend.listBasisUsd += outcome.record.listBasisUsd;
        return outcome;
      } finally {
        pending--;
        if (spend.listBasisUsd > SPEND_CAP_USD && !spend.capTripped) {
          spend.capTripped = true;
          aborted = pending > 0;
          for (const controller of controllers) controller.abort();
        }
      }
    }),
  );
  const wallMs = Date.now() - started;

  const records: CallRecord[] = [];
  const scorable: ScorableFinding[] = [];
  settled.forEach((s, i) => {
    const call = calls[i] as PlannedCall;
    if (s.status === "fulfilled") {
      records.push(s.value.record);
      scorable.push(...s.value.scorable);
      return;
    }
    records.push({
      tag: call.tag,
      ...(call.zone === undefined ? {} : { zone: call.zone }),
      diffFiles: call.patch.split(/^diff --git /m).length - 1,
      diffLines: countLines(call.patch),
      ok: false,
      error: redactDiagnostic(String(s.reason)).slice(0, 200),
      findings: 0,
      survivors: 0,
      refuted: 0,
      deduped: 0,
      cashUsd: 0,
      listBasisUsd: 0,
      spendUnknown: true,
      wallMs,
      hunter: {},
      locations: [],
      runDir: "",
    });
  });

  // SAME MECHANISM, OR NO MATCH — one scoreTree call over the arm's merged
  // findings. The verdicts' `reasoning` is dropped (see OUTPUT HYGIENE).
  let matched: string[] = [];
  let novel = 0;
  let scored = false;
  let scoreError: string | undefined;
  const scoreStarted = Date.now();
  if (!aborted) {
    try {
      const score = await scoreTree({
        headSha: HEAD_SHA,
        pr: PR,
        goldens: inputs.treeGoldens,
        findings: scorable,
      });
      matched = score.matched;
      novel = score.novel.length;
      scored = true;
    } catch (error) {
      // Recorded, not thrown: a judge failure must not take the replicates
      // already paid for down with it. The scorable set is on disk beside each
      // call's runDir for a re-score.
      //
      // Only the message's HEAD, up to its first ": ", is kept. scorer.ts
      // throws `judge returned no JSON object: ${raw.slice(0, 200)}`, and that
      // raw judge text can paraphrase the golden (OUTPUT HYGIENE) — the head
      // ("judge returned no JSON object", "judge exited 1") says what failed
      // without carrying it.
      const message = error instanceof Error ? error.message : String(error);
      const head = message.split(": ")[0] ?? message;
      scoreError = redactDiagnostic(head).slice(0, 200);
    }
  }
  const scoreWallMs = Date.now() - scoreStarted;

  return {
    arm,
    letter: ARM_LETTER[arm],
    replicate,
    aborted,
    scored,
    ...(scoreError === undefined ? {} : { scoreError }),
    hit:
      scored && inputs.treeGoldens.some((g) => matched.includes(goldenKey(g))),
    matched,
    findingsTotal: scorable.length,
    novel,
    failedCalls: records.filter((r) => !r.ok || r.sessionFailed === true)
      .length,
    costUsd: round(records.reduce((s, r) => s + r.cashUsd, 0)),
    notionalUsd: round(records.reduce((s, r) => s + (r.notionalUsd ?? 0), 0)),
    listBasisUsd: round(records.reduce((s, r) => s + r.listBasisUsd, 0)),
    judgeCalls: scored ? inputs.treeGoldens.length * scorable.length : 0,
    wallMs,
    scoreWallMs: scored || scoreError !== undefined ? scoreWallMs : 0,
    calls: records,
  };
}

interface ReplicateRecord {
  replicate: number;
  // True until all three arms have run; a replicate cut by the spend cap or a
  // crash stays partial and is excluded from every summary.
  partial: boolean;
  arms: ArmRecord[];
}

function summarise(arm: Arm, replicates: ReplicateRecord[]) {
  const rows = replicates
    .filter((r) => !r.partial)
    .flatMap((r) => r.arms)
    .filter((a) => a.arm === arm && a.scored);
  const n = rows.length;
  const hits = rows.filter((a) => a.hit).length;
  const mean = (f: (a: ArmRecord) => number) =>
    n === 0 ? 0 : round(rows.reduce((s, a) => s + f(a), 0) / n, 2);
  return {
    arm,
    letter: ARM_LETTER[arm],
    n,
    hits,
    hits_over_n: `${hits}/${n}`,
    mean_findings: mean((a) => a.findingsTotal),
    mean_novel: mean((a) => a.novel),
    failed_calls: rows.reduce((s, a) => s + a.failedCalls, 0),
    judge_calls: rows.reduce((s, a) => s + a.judgeCalls, 0),
    cost_usd: round(rows.reduce((s, a) => s + a.costUsd, 0)),
    notional_usd: round(rows.reduce((s, a) => s + a.notionalUsd, 0)),
    list_basis_usd: round(rows.reduce((s, a) => s + a.listBasisUsd, 0)),
  };
}

function zoneManifest(zones: Zone[]) {
  return zones.map((z) => ({
    index: z.index,
    files: z.paths.length,
    lines: z.lines,
    paths: z.paths,
  }));
}

async function plan(replicates: number): Promise<void> {
  const inputs = await loadInputs();
  console.log(`probe: shard-probe-${PR}  head=${HEAD_SHA}  base=${BASE_SHA}`);
  console.log(`diff: ${FULL_DIFF}`);
  console.log(
    `  sha256=${inputs.diffSha256}  sections=${inputs.zones.reduce((s, z) => s + z.paths.length, 0)}  lines=${countLines(inputs.fullPatch)}`,
  );
  console.log(`goldens (train.jsonl): ${inputs.treeGoldens.length}`);
  for (const g of inputs.treeGoldens) {
    console.log(`  ${goldenKey(g)}  ${g.path}:${g.line}`);
  }
  console.log(
    `zones: K=${K}, target=ceil(${countLines(inputs.fullPatch)}/${K})=${Math.ceil(countLines(inputs.fullPatch) / K)} lines`,
  );
  for (const z of inputs.zones) {
    console.log(`  zone ${z.index}: ${z.paths.length} files, ${z.lines} lines`);
    for (const p of z.paths) console.log(`    ${p}`);
  }
  // Reporting only, computed AFTER the cut: the zones above never saw this.
  console.log("golden -> zone (reporting only, after zoning):");
  for (const g of inputs.treeGoldens) {
    const zone = inputs.zones.find((z) => z.paths.includes(g.path));
    console.log(
      `  ${goldenKey(g)} -> ${zone === undefined ? "NOT IN DIFF" : `zone ${zone.index}`}`,
    );
  }
  console.log(`worktree: ${WORKTREE} @ ${HEAD_SHA} (verified)`);
  const perReplicate = ARMS.reduce(
    (s, arm) => s + plannedCalls(arm, inputs).length,
    0,
  );
  console.log(
    `calls per replicate: ${perReplicate} (full 1 + sharded ${inputs.zones.length} + control ${inputs.zones.length})`,
  );
  console.log(
    `run would use: ${replicates} replicates = ${perReplicate * replicates} runPipeline calls, spend cap $${SPEND_CAP_USD} list-basis`,
  );
  console.log(
    `output: ${OUT} ${existsSync(OUT) ? "(EXISTS — run would refuse)" : "(absent)"}`,
  );
}

async function run(replicates: number): Promise<void> {
  const inputs = await loadInputs();
  // Never overwrite a recorded probe. Checked before authority resolution so a
  // refused run touches nothing; claimed with `wx` below so two runs racing
  // past this check cannot both own the file.
  if (existsSync(OUT)) {
    throw new Error(`refusing to overwrite recorded probe: ${OUT}`);
  }
  const runnerAuthority = await resolveRunnerAuthority({
    workspaceRoot: WORKTREE,
  });
  if (runnerAuthority.error !== undefined) {
    throw new Error(
      `execution authority unavailable: ${runnerAuthority.error}`,
    );
  }
  const runnerOptions = runnerAuthority.runnerOptions;

  const goldenKeys = inputs.treeGoldens.map(goldenKey);
  const startedAt = new Date().toISOString();
  const replicateRecords: ReplicateRecord[] = [];
  const spend: SpendState = { listBasisUsd: 0, capTripped: false };

  const report = (complete: boolean) => ({
    probe: `shard-probe-${PR}`,
    date: startedAt,
    updated: new Date().toISOString(),
    complete,
    ...(spend.capTripped ? { stop_reason: "spend-cap" } : {}),
    constants: {
      pr: PR,
      base_sha: BASE_SHA,
      head_sha: HEAD_SHA,
      diff_path: FULL_DIFF,
      diff_sha256: inputs.diffSha256,
      diff_lines: countLines(inputs.fullPatch),
      worktree: WORKTREE,
      hunter_source: AGENT_SOURCE,
      gotchas: GOTCHAS,
      hop_budget: HOP_BUDGET,
      step_timeout_ms: STEP_TIMEOUT_MS,
      suspicion_priors: SUSPICION_PRIORS,
      codegraph: "off (empty MCP config)",
      model_selection:
        "agent frontmatter via resolveModel; no input.model, no AgentSpec.model (as g2)",
      k: K,
      replicates,
      spend_cap_usd_list_basis: SPEND_CAP_USD,
    },
    arms: {
      A: "full — 1 call over the full diff",
      B: `sharded — ${K} calls, one blind zone each`,
      C: `control — ${K} calls, each over the full diff`,
    },
    reading: READING,
    scoring:
      "mechanism (runner/scorer.ts scoreTree + claudeJudge), one call per arm over the merged findings",
    goldens: goldenKeys,
    zones: zoneManifest(inputs.zones),
    spend: {
      list_basis_usd: round(spend.listBasisUsd),
      note: "hunter steps only; judge calls are counted per arm, never priced",
    },
    replicates: replicateRecords,
    summary: Object.fromEntries(
      ARMS.map((arm) => [arm, summarise(arm, replicateRecords)]),
    ),
  });

  const claim = await open(OUT, "wx");
  try {
    await claim.writeFile(`${JSON.stringify(report(false), null, 2)}\n`);
  } finally {
    await claim.close();
  }
  console.error(`claimed: ${OUT}`);

  outer: for (let r = 1; r <= replicates; r++) {
    const record: ReplicateRecord = { replicate: r, partial: true, arms: [] };
    replicateRecords.push(record);
    for (const arm of ARMS) {
      if (spend.capTripped) break outer;
      const armRecord = await runArm(arm, r, inputs, runnerOptions, spend);
      record.arms.push(armRecord);
      // Keys, counts and locations only — never a claim, never a judge
      // reasoning string.
      console.error(
        `[${arm} #${r}] hit=${armRecord.hit} matched=[${armRecord.matched.join(",")}] ` +
          `n=${armRecord.findingsTotal} novel=${armRecord.novel} failed=${armRecord.failedCalls} ` +
          `cash=$${armRecord.costUsd.toFixed(4)} list=$${armRecord.listBasisUsd.toFixed(4)} ` +
          `judge=${armRecord.judgeCalls}${armRecord.aborted ? " ABORTED" : ""}` +
          `${armRecord.scoreError === undefined ? "" : ` SCORE-ERROR ${armRecord.scoreError}`} ` +
          `models=[${armRecord.calls.map((c) => c.hunter.observedModels?.join("+") ?? c.hunter.model ?? "?").join(", ")}]`,
      );
      record.partial = record.arms.length < ARMS.length;
      // Rewritten after every arm (so after every replicate, and more): a
      // crash keeps every completed replicate, and the in-flight one is
      // visible as `partial`.
      await writeJsonAtomically(OUT, report(false));
    }
    if (spend.capTripped) break;
  }

  const complete =
    !spend.capTripped &&
    replicateRecords.length === replicates &&
    replicateRecords.every((r) => !r.partial);
  await writeJsonAtomically(OUT, report(complete));
  console.log(`written: ${OUT}`);
  if (spend.capTripped) {
    console.error(
      `STOPPED: list-basis spend $${spend.listBasisUsd.toFixed(2)} exceeded the $${SPEND_CAP_USD} cap`,
    );
  }
  console.log(JSON.stringify(report(complete).summary, null, 2));
}

function parseReplicates(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_REPLICATES);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`replicates must be a positive integer, got ${raw}`);
  }
  return n;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "plan") {
    await plan(parseReplicates(process.argv[3]));
  } else if (mode === "run") {
    await run(parseReplicates(process.argv[3]));
  } else {
    console.error(
      "usage: bun run scripts/shard-probe.ts plan | run [replicates=6]",
    );
    process.exit(2);
  }
}
