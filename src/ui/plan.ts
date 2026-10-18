// The plan card and its details view, as LINES. Both pairs of renderers
// (local mode's and PR mode's) are total functions of their inputs: `styles`
// arrives as a parameter, width is either explicit or resolved from
// ui/primitives.ts's terminalWidth(), and all returned content is assertable
// offline without a TTY.

import { existsSync } from "node:fs";
import path from "node:path";
import type { EffectiveConfig } from "#config/config";
import { exclusionLines } from "#git/git";
import { isFullCommitId } from "#git/refs";
import type { FreeRouteBilling } from "#model/free-discovery";
import type { ResolvedRoutePlan } from "#model/routing";
import type { PrTarget } from "#pr/preflight";
import { DEFAULT_SCOUT_MODEL } from "#review/pipeline";
import {
  type AgentsDirSource,
  type BaseRefResolution,
  type CliOptions,
  type ConfigSource,
  type ConfigSources,
  DEFAULT_SUMMARY_MODEL,
  type LocalConfig,
  type SummarySettings,
} from "#review/preflight";
import type { ParsedAgent } from "#review/prompt-set";
import {
  type DiffStat,
  type estimateCost,
  formatStepRoute,
} from "#review/report";
import { type SizeGateVerdict, sizeGateLine } from "#review/size-gate";
import type { ReviewSpec } from "#review/spec";
import {
  bold,
  box,
  green,
  labelColumnWidth,
  markerRowLines,
  red,
  row,
  section,
  shortPath,
  shortSha,
  terminalWidth,
  yellow,
} from "#ui/primitives";
import { FREE_STEPS_NOTE, freeBillingMode } from "#ui/select";

// C5 O-7's payload for both plan surfaces: everything the card and the
// details view need to name a value the operator cannot see by opening their
// checkout. Optional on both contexts, so a context assembled without it
// renders exactly the pre-C5 plan.
export interface ConfigProvenance {
  sources: ConfigSources;
  // Read off the RESOLUTION, never off `sources`: ConfigSource has no `flag`
  // member (judgment ledger JD-10), so the record cannot say that --agents
  // beat both layers — and a card that tagged such a run `global` would be
  // naming the file that LOST. AgentsDirSource can say it, so it is what the
  // tag is derived from.
  agentsDirSource: AgentsDirSource;
  repoConfigPath: string;
  globalConfigPath: string;
  globalPresent: boolean;
}

// The two halves the shell holds separately — the merge's record, and the
// agents-dir chain's own answer — joined once, so the three plan contexts
// (local, PR dry run, PR real) cannot assemble three different versions of
// the same fact.
export function configProvenanceOf(
  loaded: EffectiveConfig,
  agentsDirSource: AgentsDirSource,
): ConfigProvenance {
  return {
    sources: loaded.sources,
    agentsDirSource,
    repoConfigPath: loaded.repoConfigPath,
    globalConfigPath: loaded.globalConfigPath,
    globalPresent: loaded.globalPresent,
  };
}

// A value the operator cannot see in the checkout is tagged; a value from the
// repo file is not, because that is the unsurprising case and the card is
// already dense.
//
// `default` is deliberately NOT tagged (judgment ledger JD-21, where O-7's
// "any value that did not come from the repo file" and §3.6's "global or
// capped" disagree). §3.6's reading is the one that keeps the operator
// un-surprised: a defaulted value is byte-for-byte pre-C5 behaviour, and the
// card already prints every one of them in a row of its own — the summarizer
// row, the parity row, the priors count, the base's source tag. Tagging six
// defaults on every quiet repo would bury the one tag that is genuinely new
// information. Naming every key's layer is `pr-hero config`'s job (§3.10),
// where the whole point is the exhaustive list.
function configTag(key: string, source: ConfigSource): string | undefined {
  return source === "global" || source === "capped"
    ? `${key} ← ${source}`
    : undefined;
}

// Which keys a flag decided, so the two consumers below cannot disagree about
// it. A flag decided the value, so NO config layer did — and D5 lets a flag
// exceed a cap on purpose. ConfigSource cannot express that (JD-10), so the
// honest move is to print no tag at all rather than to name a layer that lost.
// `agents_dir` is read off the RESOLUTION, the only thing that can say a flag
// beat both layers. Shared rather than inlined because the suppression and the
// caption that has to account for it are two sides of one fact: when this said
// only "suppress the tag", configDetail went on claiming an origin for exactly
// the keys the suppression had removed from the check.
function flagDecided(
  provenance: ConfigProvenance,
  options: Pick<CliOptions, "base" | "summary" | "model">,
): { base: boolean; summary: boolean; model: boolean; any: boolean } {
  const base = options.base !== undefined;
  const summary = options.summary !== undefined;
  const model = options.model !== undefined;
  return {
    base,
    summary,
    model,
    any: base || summary || model || provenance.agentsDirSource === "flag",
  };
}

function configTags(
  provenance: ConfigProvenance,
  options: Pick<CliOptions, "base" | "summary" | "model">,
): string[] {
  const s = provenance.sources;
  const flagged = flagDecided(provenance, options);
  // Every key is listed, including the three `repo` ones that can never
  // produce a tag today: a direction change must not silently drop a key off
  // the card.
  return [
    // Both sources the operator cannot see by opening the checkout, not just
    // the global file. Judgment ledger JD-9 left "a global `agents_dir`
    // silently preempts PRHERO_AGENTS_DIR" open on the grounds that this tag
    // is the mitigation — but firing on `global` alone covered one direction
    // only: an env-sourced prompt set, which picks every hunter's model, was
    // as absent from the checkout as a global one and printed nothing. `flag`
    // stays untagged (D5, JD-10) and `repo` stays untagged (§3.6, the
    // unsurprising case).
    provenance.agentsDirSource === "global" ||
    provenance.agentsDirSource === "env"
      ? `agents_dir ← ${provenance.agentsDirSource}`
      : undefined,
    flagged.base ? undefined : configTag("default_base", s.default_base),
    configTag("parity_trigger_paths", s.parity_trigger_paths),
    configTag("suspicion_priors", s.suspicion_priors),
    flagged.summary
      ? undefined
      : configTag("summary.enabled", s.summary.enabled),
    flagged.model ? undefined : configTag("summary.model", s.summary.model),
    configTag("max_verification_steps", s.max_verification_steps),
  ].filter((tag): tag is string => tag !== undefined);
}

// The card's row, present only when there is something to say. Empty is the
// common case — one global file and one quiet repo produce at most a couple
// of tags — so this costs the card nothing on a run where nothing hoisted.
function configRow(
  provenance: ConfigProvenance | undefined,
  options: Pick<CliOptions, "base" | "summary" | "model">,
  styles: boolean,
  width: number,
): string[] {
  if (provenance === undefined) return [];
  const tags = configTags(provenance, options);
  if (tags.length === 0) return [];
  return row(
    "CONFIG",
    `${tags.join(" · ")}  (${provenance.globalConfigPath})`,
    {
      styles,
      width,
    },
  );
}

// The details view's row: both file paths whether or not they exist, because
// "where do I even write this" is the other half of the question a teammate
// asks the moment a value surprises them. Not dense, and this is the view
// that exists for the reader who wants the whole answer.
function configDetail(
  provenance: ConfigProvenance,
  options: Pick<CliOptions, "base" | "summary" | "model">,
): string {
  const tags = configTags(provenance, options);
  // No tags has TWO causes, and only one of them licenses the sentence this
  // used to print unconditionally. Nothing hoisted is one. The other is that a
  // flag decided a key and configTags suppressed its tag on purpose (JD-10) —
  // and on that run "every value came from the repo file or a built-in
  // default" is false about the one value the operator most recently typed.
  // The caption is therefore scoped to what the function actually checked; it
  // is not fixed by tagging the flag, which would reopen JD-10 by naming a
  // layer for a key no layer decided. With no flag in play the original
  // sentence is exact and stays: `flag` is excluded by the branch, `global`
  // and `env` both produce a tag, so only repo-or-default can reach it.
  return (
    `repo ${provenance.repoConfigPath}` +
    ` · global ${provenance.globalConfigPath}` +
    ` (${provenance.globalPresent ? "present" : "absent"})` +
    (tags.length > 0
      ? ` · ${tags.join(" · ")}`
      : flagDecided(provenance, options).any
        ? " — every value a flag did not decide came from the repo file or" +
          " a built-in default"
        : " — every value came from the repo file or a built-in default")
  );
}

export interface PlanContext {
  options: CliOptions;
  repoRoot: string;
  baseRef: BaseRefResolution;
  baseSha: string;
  diffFromSha: string;
  headSha: string;
  diffStat: DiffStat;
  diffPath: string;
  agentsDir: string;
  agentFiles: Map<string, ParsedAgent>;
  spec: ReviewSpec;
  runDir: string;
  config: LocalConfig;
  summary: SummarySettings;
  parityFires: boolean;
  codegraphAvailable: boolean;
  estimate: ReturnType<typeof estimateCost>;
  hunterCount: number;
  // The gate's ALREADY-EVALUATED verdict, carried in so the plan can print
  // it last. The gate is still decided by the shell, before the cost band's
  // confirm() — this only moves where the line lands on screen.
  sizeGate: SizeGateVerdict;
  droppedPaths: string[];
  // C5 O-7. Optional for the reason `resolved`/`rereview` are on the PR
  // context: a plan assembled without it renders the pre-C5 card.
  configProvenance?: ConfigProvenance;
  // D2 PR3: Optional resolved route plan for model routing display
  routePlan?: ResolvedRoutePlan;
  // Free verdicts of the admitted route plan, read off the admission that already
  // decided them. Absent means unknown, and the estimate line keeps its band.
  freeRoute?: FreeRouteBilling;
  // The terminal width every row and card below is laid out against, carried
  // in exactly as ui/result.ts's ResultInput carries it. Optional so the shell
  // may leave the one sniff to the renderer's entry point; the tests ALWAYS
  // pin it, because these renderers were the reason `bun test` in a narrow
  // pane could fail on a wrap point no test could stub.
  width?: number;
}

// Where the base ref came from, because "main" chosen by fallback and "main"
// asked for by name are the same string with very different confidence behind
// them. The full sentence lives in the details view now; the card carries the
// short tag below, which says the same thing in one token.
function baseSourceNote(ctx: PlanContext): string {
  switch (ctx.baseRef.source) {
    case "flag":
      return "--base";
    case "config":
      return "config default_base";
    case "remote":
      return "refs/remotes/origin/HEAD";
    default:
      return "fallback: no --base, no default_base, no remote head";
  }
}

function baseSourceTag(ctx: PlanContext): string {
  return ctx.baseRef.source === "fallback" ? "fallback" : baseSourceNote(ctx);
}

// The prose the plan card demotes: why the base ref is trusted, what the
// range actually means, and what the cost band was computed from. Long,
// true, and read at most once — so it does not belong between the operator
// and the yes/no they are about to give.
const PERMISSIONS_NOTE =
  "steps run with --permission-mode bypassPermissions, bounded only by " +
  "each agent's read-only tool allow-list";

function agentRow(
  ctx: {
    options: CliOptions;
    agentFiles: Map<string, ParsedAgent>;
    routePlan?: ResolvedRoutePlan;
  },
  agent: ReviewSpec["agents"][number],
  fires: string,
): string {
  const parsed = ctx.agentFiles.get(agent.key);
  const model = ctx.options.model ?? agent.model ?? parsed?.model ?? "?";
  if (ctx.routePlan) {
    const stepRoute = ctx.routePlan.steps.find(
      (s) =>
        s.stepKey === agent.key ||
        s.stepKey === `hunter-${agent.key}` ||
        (agent.role === "refuter" &&
          (s.role === "refuter" || s.stepKey === "refuter")),
    );
    if (stepRoute) {
      const formatted = formatStepRoute(stepRoute, model);
      return `${agent.key.padEnd(12)} ${formatted.padEnd(8)} ${fires}`;
    }
  }
  return `${agent.key.padEnd(12)} ${model.padEnd(8)} ${fires}`;
}

function summarizerRow(summary: SummarySettings): string {
  const model = summary.model ?? DEFAULT_SUMMARY_MODEL;
  return (
    `summarizer`.padEnd(12) +
    `${model}`.padEnd(8) +
    (summary.enabled ? "always" : "disabled")
  );
}

export function summarizerLabel(summary: SummarySettings): string {
  return summary.enabled ? "+ summarizer" : "+ summarizer disabled";
}

// Printed on EVERY plan, off included. The scout adds a paid stage to the
// front of the run and the operator is about to confirm a band that already
// counts it, so "scout: off" is information, not noise — and a stage that
// only appears when it is on is a stage nobody notices arriving.
function scoutRow(
  options: Pick<CliOptions, "scout" | "scoutModel" | "model">,
): string {
  const label = "scout".padEnd(12);
  if (!options.scout) return `${label}${"-".padEnd(8)}disabled`;
  // The same chain the pipeline resolves, printed before the money is spent:
  // --model > --scout-model > the engine default (the bundled prompt pins no
  // model, so there is no frontmatter seat to show here).
  const model = options.model ?? options.scoutModel ?? DEFAULT_SCOUT_MODEL;
  return `${label}${model.padEnd(8)}diff-only, before the hunters (experimental)`;
}

export function scoutLabel(options: Pick<CliOptions, "scout">): string {
  return options.scout ? " + scout" : "";
}

// Lives here rather than in review/run.ts, beside the two labels it composes.
// It was first extracted into review/run.ts with the other shared run stages,
// which made that domain module import #ui/plan by value while ui/plan already
// imports #review/pipeline and #review/size-gate: no file-level cycle, but the
// review domain depending on presentation. It is a log line, so it belongs to
// the presentation layer that owns its labels.
// The one-line expectation printed just before the pipeline starts. Returns
// the string only — the orchestrator still calls log(), because withCiWorkflowGroup
// wraps the two call sites differently (PR mode groups it in a CI log group;
// local mode does not).
export function reviewingLine(
  hunterCount: number,
  summary: SummarySettings,
  options: Pick<CliOptions, "scout">,
): string {
  return (
    `reviewing — ${hunterCount} hunter${hunterCount === 1 ? "" : "s"} + ` +
    `refuter ${summarizerLabel(summary)}${scoutLabel(options)}; ` +
    "comparable trees have taken " +
    "8–25 minutes"
  );
}

// The last block on screen and the only one an operator must read: the gate
// verdict, then the money. Both used to sit mid-list, where the eye that had
// already given up on the plan never reached them.
interface PlanDecision {
  sizeGate: SizeGateVerdict;
  freeRoute?: FreeRouteBilling;
  // Set only where the verdict is an ESTIMATE rather than the gate's own
  // answer (the PR dry run's aggregate counters); printed beside it so
  // nobody reads a guess as the verdict.
  sizeGateNote?: string;
  droppedPaths: string[];
  force: boolean;
  // Interactive override, distinct from --force: the operator confirmed
  // "review anyway" at the size-gate menu. The plan names which hatch
  // opened so a log cannot be read as "they passed --force".
  sizeGateConfirmed?: boolean;
  estimate: ReturnType<typeof estimateCost>;
  hunterCount: number;
  summarizer: boolean;
}

function decisionLines(
  d: PlanDecision,
  styles: boolean,
  width: number,
): string[] {
  // sizeGateLine's wording is FIXED — size-gate.test.ts pins five substrings
  // of it, and the watcher's log parser reads the same phrasing. The ✓/✗ is
  // decoration in front of it, never a replacement for it.
  const note = d.sizeGateNote === undefined ? "" : ` ${d.sizeGateNote}`;
  const lines = [
    "",
    ...markerRowLines(
      d.sizeGate.ok ? "✓" : "✗",
      `${sizeGateLine(d.sizeGate)}${note}`,
      d.sizeGate.ok ? green : red,
      styles,
      width,
    ),
    ...exclusionLines(d.droppedPaths, styles, width),
  ];
  if (!d.sizeGate.ok && d.force) {
    lines.push(
      ...markerRowLines(
        "!",
        "--force given: reviewing anyway.",
        yellow,
        styles,
        width,
      ),
    );
  } else if (!d.sizeGate.ok && d.sizeGateConfirmed) {
    lines.push(
      ...markerRowLines(
        "!",
        "confirmed: reviewing anyway.",
        yellow,
        styles,
        width,
      ),
    );
  }
  lines.push(
    ...markerRowLines(
      "$",
      planEstimateLine({
        estimate: d.estimate,
        hunterCount: d.hunterCount,
        summarizer: d.summarizer,
        ...(d.freeRoute === undefined ? {} : { freeRoute: d.freeRoute }),
      }),
      bold,
      styles,
      width,
    ),
  );
  return lines;
}

// The estimate row's text, shared by both plan cards. The band is token-derived
// whatever the route; the free verdict changes only the claim made about it. A
// free route bills nothing, so a dollar figure would read as a cost, and the
// band is relabelled as token-derived instead. A mix keeps the band and names
// the free share. No free step (metered or subscription) is today's line,
// byte-identical. The band never reads $0 – $0 here: estimateCost clamps the
// hunter seats (report.ts), so a free route is "not billed", never a zero estimate.
export function planEstimateLine(input: {
  estimate: { low: number; high: number };
  hunterCount: number;
  summarizer: boolean;
  freeRoute?: FreeRouteBilling;
}): string {
  const low = `$${input.estimate.low.toFixed(2)}`;
  const high = `$${input.estimate.high.toFixed(2)}`;
  // The mode is the prompt's too (ui/select.ts freeBillingMode): the card and
  // the confirm read one verdict, so they cannot disagree about what is billed.
  const billing = freeBillingMode(input.freeRoute);
  if (billing === "free") {
    return `estimate: free route (token-derived ${low} – ${high}, not billed)`;
  }
  const line =
    `estimate ${low} – ${high} (${input.hunterCount} hunter(s) + refuter ` +
    `${input.summarizer ? "+ summarizer" : "+ summarizer disabled"})`;
  return billing === "mixed" ? `${line} ${FREE_STEPS_NOTE}` : line;
}

// Both details views' rows, with a label column DERIVED from their own labels
// instead of inherited from row()'s fixed default.
//
// WHY: that default is 11 and "permissions" is 11 characters, so padEnd() gave
// it no gap and the live run printed
// `permissionssteps run with --permission-mode bypassPermissions…` — one word
// welded out of two columns. Deriving the width means the next label longer
// than any of today's cannot bring the collision back.
function detailRows(
  pairs: readonly [string, string][],
  styles: boolean,
  width: number,
): string[] {
  const labelWidth = labelColumnWidth(pairs.map(([label]) => label));
  return pairs.flatMap(([label, value]) =>
    row(label, value, { styles, width, labelWidth }),
  );
}

// NOT printed by default: everything the plan card demoted lands here, and
// the confirm menu's "Show details" option is the only thing that prints it.
// Exported ONLY for test/cli-plan.test.ts — a test is a real consumer, and
// these four renderers had zero coverage until WU4. Nothing else may import
// them:
// biome's unused-symbol rule does not flag exports, so an `export` for a
// hypothetical consumer is how dead code hides through a clean `bun run check`
// (which is exactly how this pair sat unread for two work units).
//
// `styles` ARRIVES AS A PARAMETER and so does the WIDTH (`ctx.width`, resolved
// once here): ui.ts's contract, and the only reason the returned lines can be
// asserted offline without a TTY.
export function planDetails(ctx: PlanContext, styles: boolean): string[] {
  const width = ctx.width ?? terminalWidth();
  const pairs: [string, string][] = [];
  const push = (label: string, value: string): void => {
    pairs.push([label, value]);
  };
  push("repo", ctx.repoRoot);
  push("base", `${ctx.baseRef.ref} → ${ctx.baseSha} (${baseSourceNote(ctx)})`);
  push("head", `${ctx.options.head} → ${ctx.headSha}`);
  // BOTH endpoints, always. The base ref the user asked for and the commit the
  // diff is actually computed from are different things whenever base has
  // moved on, and a plan that printed only one of them would leave the range
  // ambiguous in exactly the case that motivated the merge-base default. The
  // card satisfies that with its own BASE + RANGE pair (short shas); this
  // view adds the full shas and the sentence explaining the range.
  push(
    "diff from",
    ctx.options.twoDot
      ? `${ctx.baseSha} — --two-dot: the literal ${ctx.baseRef.ref}..` +
          `${ctx.options.head} two-point range, so commits base gained since ` +
          "the branch point appear REVERSED"
      : `${ctx.diffFromSha} — merge base of ${ctx.baseRef.ref} and ` +
          `${ctx.options.head}; only what this branch adds is reviewed`,
  );
  push("diff", ctx.diffPath);
  push("agents dir", ctx.agentsDir);
  if (ctx.routePlan) {
    for (const step of ctx.routePlan.steps) {
      const rawModel =
        step.role === "hunter"
          ? (ctx.options.model ??
            ctx.spec.agents.find(
              (a) =>
                a.key === step.stepKey || `hunter-${a.key}` === step.stepKey,
            )?.model ??
            ctx.agentFiles.get(step.stepKey.replace(/^hunter-/, ""))?.model)
          : step.role === "refuter"
            ? (ctx.options.model ??
              ctx.spec.agents.find((a) => a.role === "refuter")?.model ??
              ctx.agentFiles.get(step.stepKey)?.model)
            : undefined;
      push(`route ${step.stepKey}`, formatStepRoute(step, rawModel));
    }
  }
  if (ctx.configProvenance) {
    push("config", configDetail(ctx.configProvenance, ctx.options));
  }
  push("run dir", ctx.runDir);
  push("hop budget", String(ctx.options.hopBudget));
  push("summarizer", summarizerRow(ctx.summary));
  push("scout", scoutRow(ctx.options));
  push(
    "parity",
    ctx.config.parity_trigger_paths.length === 0
      ? "no parity_trigger_paths configured — the parity hunter never fires"
      : ctx.parityFires
        ? `fires (a changed path matches ${ctx.config.parity_trigger_paths.length} configured pattern(s))`
        : "configured, but no changed path matches — it will not fire",
  );
  push(
    "codegraph",
    ctx.codegraphAvailable
      ? "available (.codegraph found; codegraph_explore is live)"
      : "NOT FOUND — the agents' codegraph_explore grant is inert, so this " +
          "review runs on Read/Grep/Glob alone",
  );
  push("priors", `${ctx.config.suspicion_priors.length} suspicion prior(s)`);
  push("estimate", ctx.estimate.basis);
  push("permissions", PERMISSIONS_NOTE);
  return [section("details", styles), ...detailRows(pairs, styles, width)];
}

// The plan card as LINES, printed by the shell. Returning them rather than
// logging them is what makes the composition — card, agent grid, endpoints,
// decision block — assertable in one offline expectation.
export function renderPlan(ctx: PlanContext, styles: boolean): string[] {
  const width = ctx.width ?? terminalWidth();
  const lines = [
    ...box(
      "pr-hero · review",
      [
        `${ctx.baseRef.ref}..${ctx.options.head}`,
        `${shortPath(ctx.repoRoot)} · ${ctx.diffStat.files} files  ` +
          `+${ctx.diffStat.insertions} −${ctx.diffStat.deletions}`,
      ],
      { styles, width },
    ),
    "",
  ];
  let label = "AGENTS";
  for (const agent of ctx.spec.agents) {
    const fires =
      agent.role === "refuter"
        ? "per severe finding"
        : agent.trigger === undefined
          ? "always"
          : ctx.parityFires
            ? "triggered"
            : "✗ will not fire";
    lines.push(...row(label, agentRow(ctx, agent, fires), { styles, width }));
    label = "";
  }
  lines.push(...row(label, summarizerRow(ctx.summary), { styles, width }));
  lines.push(...row("", scoutRow(ctx.options), { styles, width }));
  label = "";
  lines.push(
    "",
    ...row(
      "BASE",
      `${ctx.baseRef.ref} → ${shortSha(ctx.baseSha)}  (${baseSourceTag(ctx)})`,
      { styles, width },
    ),
    // The second endpoint of the pair the details view explains: what the diff
    // is actually computed from, which is the merge base unless --two-dot moved
    // it back to the base tip.
    ...row(
      "RANGE",
      `${shortSha(ctx.diffFromSha)} → ${shortSha(ctx.headSha)}  ` +
        (ctx.options.twoDot ? "(--two-dot, two-point range)" : "(merge base)"),
      { styles, width },
    ),
    ...row(
      "RUN",
      `${path.basename(ctx.runDir)} · ` +
        (ctx.codegraphAvailable ? "codegraph live" : "codegraph NOT FOUND") +
        ` · hop budget ${ctx.options.hopBudget}` +
        ` · ${ctx.config.suspicion_priors.length} prior(s)`,
      { styles, width },
    ),
    ...configRow(ctx.configProvenance, ctx.options, styles, width),
    ...decisionLines(
      {
        sizeGate: ctx.sizeGate,
        droppedPaths: ctx.droppedPaths,
        force: ctx.options.force,
        estimate: ctx.estimate,
        hunterCount: ctx.hunterCount,
        summarizer: ctx.summary.enabled,
        ...(ctx.freeRoute === undefined ? {} : { freeRoute: ctx.freeRoute }),
      },
      styles,
      width,
    ),
  );
  return lines;
}

export interface PrPlanContext {
  options: CliOptions;
  operatorRoot: string;
  target: PrTarget;
  worktreePath: string;
  runDir: string;
  diffStat: DiffStat;
  agentsDir: string;
  agentFiles: Map<string, ParsedAgent>;
  spec: ReviewSpec;
  config: LocalConfig;
  summary: SummarySettings;
  estimate: ReturnType<typeof estimateCost>;
  hunterCount: number;
  // Same contract as PlanContext: the verdict is decided by the shell (and
  // in PR mode enforced before the run dir even exists), printed here.
  sizeGate: SizeGateVerdict;
  sizeGateNote?: string;
  droppedPaths: string[];
  // C5 O-7, same contract as PlanContext's.
  configProvenance?: ConfigProvenance;
  // D2 PR3: Optional resolved route plan for model routing display
  routePlan?: ResolvedRoutePlan;
  // Free verdicts of the admitted route plan, read off the admission that already
  // decided them. Absent means unknown, and the estimate line keeps its band.
  freeRoute?: FreeRouteBilling;
  // Set when this plan follows an interactive "Review anyway" at the
  // size-gate menu. Distinct from options.force so the decision block can
  // say "confirmed" rather than lie that --force was passed.
  sizeGateConfirmed?: boolean;
  // Present only once the fetch has happened: the canonical range and the
  // on-disk diff. A dry-run plan prints GitHub's own counters instead.
  resolved?: {
    baseSha: string;
    diffFromSha: string;
    diffPath: string;
    parityFires: boolean;
  };
  // Same contract, same reason as PlanContext.width.
  width?: number;
  // Item 7: queued verify steps shown as their own cost-band term (O-5a).
  verificationSteps?: number;
  rereview?: {
    case: string;
    lastHead: string | null;
    discoveryRestricted: boolean;
    skipDiscovery: boolean;
  };
}

function prBaseSourceNote(target: PrTarget): string {
  return target.baseSource === "merge-commit-parent"
    ? "first parent of the merge commit — base as it was when the PR landed"
    : `tip of ${target.baseRefName} as recorded on the PR`;
}

// A merged PR's baseRef is a `<sha>^1` EXPRESSION, not a branch name, so the
// card would otherwise carry a 40-char sha with a suffix. Shortened only for
// display, and only when it really is a full commit id — a branch name that
// happens to be long is left whole, because truncating a ref makes it
// unusable. The details view and pipeline.json both keep the full form.
function shortRev(rev: string): string {
  const bare = rev.replace(/\^\d*$/, "");
  return isFullCommitId(bare) ? shortSha(bare) + rev.slice(bare.length) : rev;
}

// The same fact in one token, for the card; the sentence above is the
// details view's job.
function prBaseSourceTag(target: PrTarget): string {
  return target.baseSource === "merge-commit-parent"
    ? "merge commit parent"
    : "PR base tip";
}

// Pre-fetch the parity trigger cannot be evaluated (there is no diff yet).
// When triggers are configured the parity hunter MIGHT fire, so it counts:
// both recorded cost overruns were under-estimates, and a band that errs
// high costs a second of hesitation while one that errs low costs money.
export function dryRunHunterCount(
  spec: ReviewSpec,
  config: LocalConfig,
): number {
  return spec.agents.filter(
    (a) =>
      a.role === "hunter" &&
      (a.trigger === undefined || config.parity_trigger_paths.length > 0),
  ).length;
}

// Predicted, not decided: the ensure step runs only after the confirm gate,
// so the plan can promise a create but must leave reuse-vs-recreate to the
// HEAD and cleanliness checks at run time.
function worktreePlanNote(worktreePath: string): string {
  return existsSync(worktreePath)
    ? "exists — reuse/recreate decided at run time"
    : "will create (git worktree add --detach)";
}

function codegraphPlanNote(worktreePath: string): string {
  if (existsSync(path.join(worktreePath, ".codegraph"))) {
    return (
      "available (.codegraph found in the worktree; codegraph_explore " +
      "is live)"
    );
  }
  return Bun.which("codegraph") === null
    ? "codegraph CLI not found — hunters run on Read/Grep/Glob alone"
    : "will `codegraph init` in the worktree (~10s measured)";
}

// Same three states as codegraphPlanNote, in card width.
function codegraphPlanTag(worktreePath: string): string {
  if (existsSync(path.join(worktreePath, ".codegraph"))) {
    return "codegraph live";
  }
  return Bun.which("codegraph") === null
    ? "codegraph NOT FOUND"
    : "codegraph init ~10s";
}

function prWorktreePlanTag(worktreePath: string): string {
  return existsSync(worktreePath)
    ? "worktree exists"
    : "worktree will be created";
}

// PR mode's half of planDetails — same contract, same test-only export:
// printed only when the confirm menu's "Show details" option asks for it.
export function prPlanDetails(ctx: PrPlanContext, styles: boolean): string[] {
  const width = ctx.width ?? terminalWidth();
  const pairs: [string, string][] = [];
  const push = (label: string, value: string): void => {
    pairs.push([label, value]);
  };
  push("repo", `${ctx.operatorRoot} (operator checkout; gh and git run here)`);
  push("head", `${ctx.target.headSha} (the PR's head commit)`);
  // BOTH endpoints, always — the rule local mode's details view spells out.
  // The card shows the pair as short shas; here they are whole, with the
  // sentence that says which is which.
  push(
    "base",
    ctx.resolved
      ? `${ctx.target.baseRef} → ${ctx.resolved.baseSha} ` +
          `(${prBaseSourceNote(ctx.target)})`
      : `${ctx.target.baseRef} (${prBaseSourceNote(ctx.target)}; resolved ` +
          "after fetch)",
  );
  if (ctx.resolved) {
    push(
      "diff from",
      `${ctx.resolved.diffFromSha} — merge base of base and the PR head; ` +
        "only what the PR adds is reviewed",
    );
  }
  push(
    "diff",
    ctx.resolved
      ? ctx.resolved.diffPath
      : "band from gh; exact numstat after fetch",
  );
  push(
    "worktree",
    `${ctx.worktreePath} — ${worktreePlanNote(ctx.worktreePath)}`,
  );
  push("agents dir", ctx.agentsDir);
  if (ctx.routePlan) {
    for (const step of ctx.routePlan.steps) {
      const rawModel =
        step.role === "hunter"
          ? (ctx.options.model ??
            ctx.spec.agents.find(
              (a) =>
                a.key === step.stepKey || `hunter-${a.key}` === step.stepKey,
            )?.model ??
            ctx.agentFiles.get(step.stepKey.replace(/^hunter-/, ""))?.model)
          : step.role === "refuter"
            ? (ctx.options.model ??
              ctx.spec.agents.find((a) => a.role === "refuter")?.model ??
              ctx.agentFiles.get(step.stepKey)?.model)
            : undefined;
      push(`route ${step.stepKey}`, formatStepRoute(step, rawModel));
    }
  }
  if (ctx.configProvenance) {
    // The repo path here is the OPERATOR checkout's, never the worktree's
    // (O-8) — printed so that fact is visible rather than asserted.
    push("config", configDetail(ctx.configProvenance, ctx.options));
  }
  push("run dir", ctx.runDir);
  push("hop budget", String(ctx.options.hopBudget));
  push("summarizer", summarizerRow(ctx.summary));
  push("scout", scoutRow(ctx.options));
  if (ctx.rereview) {
    const last =
      ctx.rereview.lastHead === null
        ? "none"
        : ctx.rereview.lastHead.slice(0, 8);
    push(
      "re-review",
      `case ${ctx.rereview.case} · L=${last}` +
        (ctx.rereview.skipDiscovery
          ? " · discovery skipped (empty delta)"
          : ctx.rereview.discoveryRestricted
            ? " · restricted L..H"
            : " · full B..H"),
    );
    if (ctx.rereview.case === "D") {
      push(
        "D4",
        "last reviewed head is not an ancestor of this head — full B..H",
      );
    }
  }
  if (ctx.verificationSteps !== undefined && ctx.verificationSteps > 0) {
    push(
      "verify",
      `${ctx.verificationSteps} verification step(s) (capped; not bypassed by --yes)`,
    );
  }
  if (ctx.options.post) {
    push(
      "post",
      "a marked PR comment will be created, or updated in place if one " +
        "exists (idempotent — one comment per PR, found by its marker)",
    );
  }
  push(
    "parity",
    ctx.config.parity_trigger_paths.length === 0
      ? "no parity_trigger_paths configured — the parity hunter never fires"
      : ctx.resolved === undefined
        ? `configured (${ctx.config.parity_trigger_paths.length} ` +
          "pattern(s)); whether a changed path matches is decided after fetch"
        : ctx.resolved.parityFires
          ? `fires (a changed path matches ${ctx.config.parity_trigger_paths.length} configured pattern(s))`
          : "configured, but no changed path matches — it will not fire",
  );
  push("codegraph", codegraphPlanNote(ctx.worktreePath));
  push("priors", `${ctx.config.suspicion_priors.length} suspicion prior(s)`);
  push("estimate", ctx.estimate.basis);
  push("permissions", PERMISSIONS_NOTE);
  return [section("details", styles), ...detailRows(pairs, styles, width)];
}

export function renderPrPlan(ctx: PrPlanContext, styles: boolean): string[] {
  const width = ctx.width ?? terminalWidth();
  const lines = [
    ...box(
      `pr-hero · PR #${ctx.target.number}`,
      [
        ctx.target.title,
        `${ctx.target.state} · base ${ctx.target.baseRefName} · ` +
          `${ctx.diffStat.files} files  +${ctx.diffStat.insertions} ` +
          `−${ctx.diffStat.deletions}` +
          (ctx.resolved ? "" : " (gh counters)"),
      ],
      { styles, width },
    ),
    "",
  ];
  let label = "AGENTS";
  for (const agent of ctx.spec.agents) {
    const fires =
      agent.role === "refuter"
        ? "per severe finding"
        : agent.trigger === undefined
          ? "always"
          : ctx.resolved === undefined
            ? "decided by the diff after fetch"
            : ctx.resolved.parityFires
              ? "triggered"
              : "✗ will not fire";
    lines.push(...row(label, agentRow(ctx, agent, fires), { styles, width }));
    label = "";
  }
  lines.push(...row(label, summarizerRow(ctx.summary), { styles, width }));
  lines.push(...row("", scoutRow(ctx.options), { styles, width }));
  if (ctx.rereview) {
    lines.push(
      ...row(
        "",
        `re-review   case ${ctx.rereview.case}` +
          (ctx.rereview.skipDiscovery
            ? "  discovery skipped"
            : ctx.rereview.discoveryRestricted
              ? "  restricted"
              : "  full range"),
        { styles, width },
      ),
    );
    if (ctx.rereview.case === "D") {
      lines.push(
        ...row(
          "",
          "⚠️ last reviewed head is not an ancestor — reviewing full B..H",
          { styles, width },
        ),
      );
    }
  }
  if (ctx.verificationSteps !== undefined && ctx.verificationSteps > 0) {
    lines.push(
      ...row("", `verify      ${ctx.verificationSteps} step(s)`, {
        styles,
        width,
      }),
    );
  }
  label = "";
  lines.push(
    "",
    ...row(
      "BASE",
      ctx.resolved
        ? `${shortRev(ctx.target.baseRef)} → ` +
            `${shortSha(ctx.resolved.baseSha)}  ` +
            `(${prBaseSourceTag(ctx.target)})`
        : `${shortRev(ctx.target.baseRef)}  (${prBaseSourceTag(ctx.target)}; ` +
            "resolved after fetch)",
      { styles, width },
    ),
    // The other endpoint. Pre-fetch there is no merge base yet, so the card
    // says so rather than showing the head alone — a single endpoint is the
    // ambiguity the details view's rule exists to prevent.
    ...row(
      "RANGE",
      ctx.resolved
        ? `${shortSha(ctx.resolved.diffFromSha)} → ` +
            `${shortSha(ctx.target.headSha)}  (merge base)`
        : // A bare "?" for the unresolved endpoint was honest and read as a
          // bug. Name the operation instead: the reader learns WHAT will be
          // reviewed (only what the PR adds) without being shown a
          // placeholder where a sha belongs.
          `merge base of ${shortRev(ctx.target.baseRef)} → ` +
            `${shortSha(ctx.target.headSha)}  (exact sha after fetch)`,
      { styles, width },
    ),
    ...row(
      "RUN",
      `${path.basename(ctx.runDir)} · ` +
        `${prWorktreePlanTag(ctx.worktreePath)} · ` +
        `${codegraphPlanTag(ctx.worktreePath)} · ` +
        `hop budget ${ctx.options.hopBudget} · ` +
        `${ctx.config.suspicion_priors.length} prior(s)`,
      { styles, width },
    ),
    ...configRow(ctx.configProvenance, ctx.options, styles, width),
  );
  if (ctx.options.post) {
    lines.push(
      ...row(
        "POST",
        "✓ one marked PR comment — created, or updated in place (idempotent)",
        { styles, width },
      ),
    );
  }
  lines.push(
    ...decisionLines(
      {
        sizeGate: ctx.sizeGate,
        ...(ctx.sizeGateNote === undefined
          ? {}
          : { sizeGateNote: ctx.sizeGateNote }),
        droppedPaths: ctx.droppedPaths,
        force: ctx.options.force,
        ...(ctx.sizeGateConfirmed === true ? { sizeGateConfirmed: true } : {}),
        estimate: ctx.estimate,
        hunterCount: ctx.hunterCount,
        summarizer: ctx.summary.enabled,
        ...(ctx.freeRoute === undefined ? {} : { freeRoute: ctx.freeRoute }),
      },
      styles,
      width,
    ),
  );
  return lines;
}
