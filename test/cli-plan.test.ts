// The plan card and its details view, as LINES. Both pairs of renderers
// (local mode's and PR mode's) were `(ctx) => void` runs of log() calls until
// WU4 and therefore had ZERO coverage: the card that decides whether an
// operator spends $4 was the least-tested output in the CLI, and the details
// pair could sit dead through a clean `bun run check` because biome does not
// flag exported symbols.
//
// Everything here asserts the RETURNED array. `styles` arrives as a parameter
// (ui/primitives.ts's contract), so both the painted and the unpainted shape are
// assertable offline with no TTY anywhere.

import { describe, expect, test } from "bun:test";
import { aliasCanonical, lookupAlias } from "#model/catalog";
import {
  createResolvedRoutePlan,
  type RoutingConfig,
  resolveStepRoute,
} from "#model/routing";
import type { CliOptions, ConfigSources } from "#review/preflight";
import type { ParsedAgent } from "#review/prompt-set";
import { estimateCost, formatModelRoute } from "#review/report";
import type { SizeGateVerdict } from "#review/size-gate";
import type { ReviewSpec } from "#review/spec";
import {
  type ConfigProvenance,
  type PlanContext,
  type PrPlanContext,
  planDetails,
  prPlanDetails,
  renderPlan,
  renderPrPlan,
} from "#ui/plan";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const joined = (lines: string[]): string => stripAnsi(lines.join("\n"));

// The width every case below renders at. Same value ui/result.test.ts pins,
// so the two halves of the terminal surface are asserted against one grid.
const PINNED_WIDTH = 80;
// Narrow enough to move the wrap points: at 40 columns the decision block's
// money line is two rows, not one, which is exactly the failure an unpinned
// width used to produce inside a split pane.
const NARROW_WIDTH = 40;

// The gap between the label column and the value column, checked WITHOUT
// hard-coding either width — a pin on "11" or "12" would have to be edited by
// whoever adds a longer label, which is precisely the person it exists to
// stop. The value column is read off the wrapped continuation lines (row()
// indents them to exactly it), and every label-bearing line must then have a
// space in the position just before it.
function expectEveryLabelKeepsItsGap(lines: string[]): void {
  const indents = lines
    .filter((line) => /^ {3,}\S/.test(line))
    .map((line) => line.match(/^ +/)?.[0].length ?? 0);
  expect(indents.length).toBeGreaterThan(0);
  const valueCol = Math.min(...indents);
  for (const line of lines) {
    if (!/^ {2}\S/.test(line)) continue;
    expect(line.length).toBeGreaterThan(valueCol);
    expect(line[valueCol - 1]).toBe(" ");
    expect(line[valueCol]).not.toBe(" ");
  }
}

const options = (over: Partial<CliOptions> = {}): CliOptions => ({
  repo: ".",
  head: "HEAD",
  hopBudget: 3,
  scout: false,
  full: false,
  dryRun: false,
  yes: false,
  post: false,
  twoDot: false,
  onPush: false,
  force: false,
  all: false,
  fixes: false,
  incidents: false,
  issues: false,
  proximity: false,
  threads: false,
  ...over,
});

const spec: ReviewSpec = {
  agents: [
    { key: "reliability", file: "a.md", role: "hunter", model: "sonnet" },
    {
      key: "parity",
      file: "b.md",
      role: "hunter",
      model: "sonnet",
      trigger: ["packages/**"],
    },
    { key: "refuter", file: "c.md", role: "refuter", model: "opus" },
  ],
};

const agentFiles = new Map<string, ParsedAgent>();

const okGate: SizeGateVerdict = {
  ok: true,
  effectiveLines: 120,
  effectiveFiles: 4,
  excludedFiles: 0,
  excludedLines: 0,
};

const failedGate: SizeGateVerdict = {
  ok: false,
  reason: "lines",
  effectiveLines: 9000,
  effectiveFiles: 40,
  excludedFiles: 0,
  excludedLines: 0,
  limit: 800,
  message: "diff too big",
};

const diffStat = { files: 4, insertions: 90, deletions: 30 };

const planContext = (over: Partial<PlanContext> = {}): PlanContext => ({
  options: options(),
  repoRoot: "/tmp/pr-hero-fake-repo",
  baseRef: { ref: "main", source: "flag" },
  baseSha: "1111111111111111111111111111111111111111",
  diffFromSha: "2222222222222222222222222222222222222222",
  headSha: "3333333333333333333333333333333333333333",
  diffStat,
  diffPath: "/tmp/pr-hero-fake-repo/.prhero/runs/r1/diff.patch",
  agentsDir: "/tmp/agents",
  agentFiles,
  spec,
  runDir: "/tmp/pr-hero-fake-repo/.prhero/runs/local-abcdef",
  config: { parity_trigger_paths: ["packages/**"], suspicion_priors: [] },
  summary: { enabled: true, model: "haiku" },
  parityFires: true,
  codegraphAvailable: true,
  estimate: estimateCost(diffStat, 2, true),
  hunterCount: 2,
  sizeGate: okGate,
  droppedPaths: [],
  // PINNED, on every case. Without it these renderers measured
  // process.stdout.columns — the terminal that happened to be running the
  // suite — so an assertion like "the money line is the last line" passed in
  // an 80-column pane and failed in a 40-column one. See the determinism
  // block at the bottom of this file.
  width: PINNED_WIDTH,
  ...over,
});

const prPlanContext = (over: Partial<PrPlanContext> = {}): PrPlanContext => ({
  options: options({ pr: 6 }),
  operatorRoot: "/tmp/pr-hero-fake-repo",
  target: {
    number: 6,
    title: "terminal surface: print the findings",
    state: "OPEN",
    headSha: "3333333333333333333333333333333333333333",
    baseRef: "main",
    baseRefName: "main",
    baseSource: "base-branch",
    ghDiffStat: { files: 4, insertions: 90, deletions: 30 },
  },
  worktreePath: "/tmp/pr-hero-worktrees/pr-6",
  runDir: "/tmp/pr-hero-fake-repo/.prhero/runs/pr-6-17069c75-1",
  diffStat,
  agentsDir: "/tmp/agents",
  agentFiles,
  spec,
  config: { parity_trigger_paths: [], suspicion_priors: [] },
  summary: { enabled: true, model: "haiku" },
  estimate: estimateCost(diffStat, 2, true),
  hunterCount: 2,
  sizeGate: okGate,
  droppedPaths: [],
  // Pinned for the reason PlanContext's is.
  width: PINNED_WIDTH,
  ...over,
});

describe("renderPlan", () => {
  test("returns lines and prints nothing itself", () => {
    const lines = renderPlan(planContext(), false);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(8);
  });

  test("card, agent grid, both endpoints and the decision block, in order", () => {
    const lines = renderPlan(planContext(), false);
    const text = joined(lines);
    expect(lines[0]).toContain("╭─ pr-hero · review");
    expect(text).toContain("main..HEAD");
    expect(text).toContain("4 files  +90 −30");
    // Every spec agent, with the refuter's fixed trigger phrasing.
    expect(text).toContain("reliability");
    expect(text).toContain("per severe finding");
    expect(text).toContain("summarizer");
    expect(text).toContain("haiku");
    expect(text).toContain("+ summarizer");
    // BOTH endpoints, short-sha'd — the rule the details view spells out.
    expect(text).toContain("main → 1111111111  (--base)");
    expect(text).toContain("2222222222 → 3333333333  (merge base)");
    expect(text).toContain("hop budget 3");
    // The decision block is LAST: gate verdict, then the money.
    const gateAt = lines.findIndex((l) => l.includes("size gate"));
    const moneyAt = lines.findIndex((l) => l.includes("estimate $"));
    expect(gateAt).toBeGreaterThan(0);
    expect(moneyAt).toBeGreaterThan(gateAt);
    expect(moneyAt).toBe(lines.length - 1);
  });

  test("a non-firing conditional hunter says so", () => {
    const text = joined(renderPlan(planContext({ parityFires: false }), false));
    expect(text).toContain("✗ will not fire");
  });

  test("a disabled summarizer is visible and not billed", () => {
    const text = joined(
      renderPlan(
        planContext({
          summary: { enabled: false, model: "opus" },
          estimate: estimateCost(diffStat, 2, false),
        }),
        false,
      ),
    );
    expect(text).toContain("summarizer");
    expect(text).toContain("opus");
    expect(text).toContain("disabled");
    expect(text).toContain("+ summarizer disabled");
  });

  // ROADMAP-DOORDASH M5. The scout row prints on EVERY plan, off included:
  // it adds a paid stage to the front of the run and the band below it
  // already counts one, so "disabled" is information, not noise.
  test("the scout row states itself whether or not the flag is on", () => {
    const off = joined(renderPlan(planContext(), false));
    expect(off).toContain("scout");
    expect(off).toContain("disabled");
    expect(off).not.toContain("+ scout");

    const on = joined(
      renderPlan(
        planContext({
          options: options({ scout: true }),
          estimate: estimateCost(diffStat, 2, true, true),
        }),
        false,
      ),
    );
    expect(on).toContain("diff-only, before the hunters (experimental)");
    // Default model, shown before the money is spent rather than discovered
    // in the artifact after.
    expect(on).toContain("sonnet");
  });

  test("--scout-model is shown, and --model still outranks it", () => {
    const scoutModel = joined(
      renderPlan(
        planContext({ options: options({ scout: true, scoutModel: "haiku" }) }),
        false,
      ),
    );
    expect(scoutModel).toContain("haiku");

    const overridden = joined(
      renderPlan(
        planContext({
          options: options({
            scout: true,
            scoutModel: "haiku",
            model: "opus",
          }),
        }),
        false,
      ),
    );
    // The plan must print the model that will actually run, or it is a plan
    // for a different run than the one about to happen.
    expect(overridden).toContain("scout       opus");
  });

  test("--two-dot renames the range, and --force annotates a failed gate", () => {
    const text = joined(
      renderPlan(
        planContext({
          options: options({ twoDot: true, force: true }),
          sizeGate: failedGate,
        }),
        false,
      ),
    );
    expect(text).toContain("(--two-dot, two-point range)");
    expect(text).toContain("--force given: reviewing anyway.");
  });

  test("dropped paths are stated in the decision block", () => {
    const text = joined(
      renderPlan(planContext({ droppedPaths: ["bun.lock"] }), false),
    );
    expect(text).toContain("exclusions: 1 excluded file(s) dropped");
    expect(text).toContain("diff.raw.patch");
  });

  test("styles off means not one escape byte; styles on paints", () => {
    expect(renderPlan(planContext(), false).join("\n")).not.toContain(ESC);
    expect(renderPlan(planContext(), true).join("\n")).toContain(ESC);
  });

  test("painting never changes the text, only the bytes around it", () => {
    expect(joined(renderPlan(planContext(), true))).toBe(
      joined(renderPlan(planContext(), false)),
    );
  });
});

describe("planDetails", () => {
  test("carries the full shas and the prose the card demoted", () => {
    const text = joined(planDetails(planContext(), false));
    expect(text.startsWith("details")).toBe(true);
    expect(text).toContain("1111111111111111111111111111111111111111");
    // Wrapped to the value column by row(), so the sentence is asserted in
    // the piece that cannot straddle the break.
    expect(text).toContain("merge base of main and");
    expect(text).toContain("only what this branch adds is reviewed");
    expect(text).toContain("bypassPermissions");
    expect(text).toContain("codegraph_explore is live");
  });

  test("--two-dot explains the reversal instead of the merge base", () => {
    const text = joined(
      planDetails(planContext({ options: options({ twoDot: true }) }), false),
    );
    expect(text).toContain("REVERSED");
    expect(text).not.toContain("merge base of");
  });

  test("a missing codegraph index is named, not implied", () => {
    const text = joined(
      planDetails(planContext({ codegraphAvailable: false }), false),
    );
    expect(text).toContain("NOT FOUND");
  });

  test("styles off means not one escape byte", () => {
    expect(planDetails(planContext(), false).join("\n")).not.toContain(ESC);
    expect(planDetails(planContext(), true).join("\n")).toContain(ESC);
  });

  test("the widest label keeps its gap — permissions did not", () => {
    // The live run printed `permissionssteps run with --permission-mode…`:
    // "permissions" is exactly as wide as row()'s default label field, so
    // padEnd() gave it nothing and the two columns welded together.
    const lines = planDetails(planContext(), false).map(stripAnsi);
    expect(lines.some((l) => /^ {2}permissions +steps run with /.test(l))).toBe(
      true,
    );
    expectEveryLabelKeepsItsGap(lines);
  });
});

describe("renderPrPlan", () => {
  test("the PR card, its endpoints post-fetch, and the decision block", () => {
    const lines = renderPrPlan(
      prPlanContext({
        resolved: {
          baseSha: "1111111111111111111111111111111111111111",
          diffFromSha: "2222222222222222222222222222222222222222",
          diffPath: "/tmp/run/diff.patch",
          parityFires: false,
        },
      }),
      false,
    );
    const text = joined(lines);
    expect(lines[0]).toContain("╭─ pr-hero · PR #6");
    expect(text).toContain("terminal surface: print the findings");
    expect(text).toContain("OPEN · base main");
    expect(text).toContain("main → 1111111111  (PR base tip)");
    expect(text).toContain("2222222222 → 3333333333  (merge base)");
    expect(text).toContain("worktree will be created");
    expect(text).toContain("summarizer");
    expect(text).toContain("haiku");
    expect(text).toContain("+ summarizer");
    expect(joined([lines[lines.length - 1] ?? ""])).toContain("estimate $");
  });

  test("pre-fetch the plan admits both unknowns instead of guessing", () => {
    const text = joined(renderPrPlan(prPlanContext(), false));
    expect(text).toContain("resolved after fetch");
    // The unresolved endpoint names the OPERATION, never a placeholder where a
    // sha belongs: a bare "?" was equally honest and read as a bug.
    expect(text).toContain(
      "merge base of main → 3333333333  (exact sha after fetch)",
    );
    expect(text).not.toContain("?");
    expect(text).toContain("decided by the diff after fetch");
    expect(text).toContain("summarizer");
    expect(text).toContain("haiku");
  });

  test("gh counters are labelled as such", () => {
    const text = joined(renderPrPlan(prPlanContext(), false));
    expect(text).toContain("(gh counters)");
  });

  test("--post announces the one idempotent comment", () => {
    const text = joined(
      renderPrPlan(
        prPlanContext({ options: options({ pr: 6, post: true }) }),
        false,
      ),
    );
    expect(text).toContain("one marked PR comment");
  });

  test("an estimated gate verdict carries its note", () => {
    const text = joined(
      renderPrPlan(
        prPlanContext({
          sizeGate: failedGate,
          sizeGateNote: "(estimate from GitHub's aggregate counters)",
        }),
        false,
      ),
    );
    expect(text).toContain("size gate");
    expect(text).toContain("(estimate from GitHub's aggregate counters)");
  });

  test("D4 — case D banners the force-push full-range review", () => {
    const ctx = prPlanContext({
      rereview: {
        case: "D",
        lastHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        discoveryRestricted: false,
        skipDiscovery: false,
      },
    });
    expect(joined(renderPrPlan(ctx, false))).toContain("not an ancestor");
    expect(joined(prPlanDetails(ctx, false))).toContain("not an ancestor");
  });

  test("an interactive override annotates confirmed, not --force", () => {
    const text = joined(
      renderPrPlan(
        prPlanContext({
          sizeGate: failedGate,
          sizeGateConfirmed: true,
        }),
        false,
      ),
    );
    expect(text).toContain("confirmed: reviewing anyway.");
    expect(text).not.toContain("--force given");
  });

  test("styles off means not one escape byte; painting keeps the text", () => {
    expect(renderPrPlan(prPlanContext(), false).join("\n")).not.toContain(ESC);
    expect(renderPrPlan(prPlanContext(), true).join("\n")).toContain(ESC);
    expect(joined(renderPrPlan(prPlanContext(), true))).toBe(
      joined(renderPrPlan(prPlanContext(), false)),
    );
  });
});

describe("prPlanDetails", () => {
  test("names both roots and the resolved range", () => {
    const text = joined(
      prPlanDetails(
        prPlanContext({
          resolved: {
            baseSha: "1111111111111111111111111111111111111111",
            diffFromSha: "2222222222222222222222222222222222222222",
            diffPath: "/tmp/run/diff.patch",
            parityFires: true,
          },
        }),
        false,
      ),
    );
    expect(text).toContain("operator checkout; gh and git run here");
    expect(text).toContain("the PR's head commit");
    expect(text).toContain("2222222222222222222222222222222222222222");
    expect(text).toContain("bypassPermissions");
  });

  test("pre-fetch the diff row says where the band came from", () => {
    const text = joined(prPlanDetails(prPlanContext(), false));
    expect(text).toContain("band from gh; exact numstat after fetch");
    expect(text).toContain("resolved after fetch");
  });

  test("--post gets its own row", () => {
    const text = joined(
      prPlanDetails(
        prPlanContext({ options: options({ pr: 6, post: true }) }),
        false,
      ),
    );
    expect(text).toContain("idempotent — one comment per PR");
  });

  test("styles off means not one escape byte", () => {
    expect(prPlanDetails(prPlanContext(), false).join("\n")).not.toContain(ESC);
    expect(prPlanDetails(prPlanContext(), true).join("\n")).toContain(ESC);
  });

  test("the widest label keeps its gap here too", () => {
    // The same collision, in the view that actually printed it live (PR mode's
    // details is what `review --pr 7` shows).
    const lines = prPlanDetails(
      prPlanContext({ options: options({ pr: 7, post: true }) }),
      false,
    ).map(stripAnsi);
    expect(lines.some((l) => /^ {2}permissions +steps run with /.test(l))).toBe(
      true,
    );
    expectEveryLabelKeepsItsGap(lines);
  });
});

// ---------------------------------------------------------------------------
// The regression these four renderers were written to have and did not: WIDTH
// AS A PARAMETER. Before this block they passed no width at all, so every
// row() and box() inside them — including the ones under decisionLines,
// markerRowLines, planDetails and prPlanDetails — fell back to ui/primitives.ts's
// terminalWidth() and measured whatever terminal ran `bun test`. The suite was
// therefore green at 80 columns and red in a ~40-column pane, on assertions
// about wrap points nobody could stub.
//
// `process.stdout.columns` is stubbed rather than COLUMNS= set: the env var
// does not reach process.stdout.columns when stdout is a pipe, so it would
// prove nothing. stderr is stubbed too, because terminalWidth() falls through
// to it. Restored in a finally — bun runs a file's tests in one process, and a
// leaked stub would poison every other suite.
function stubColumns(columns: number): () => void {
  const streams = [process.stdout, process.stderr];
  const saved = streams.map((s) =>
    Object.getOwnPropertyDescriptor(s, "columns"),
  );
  for (const stream of streams) {
    Object.defineProperty(stream, "columns", {
      value: columns,
      configurable: true,
      writable: true,
    });
  }
  return () => {
    streams.forEach((stream, i) => {
      const descriptor = saved[i];
      if (descriptor === undefined) {
        delete (stream as { columns?: number }).columns;
        return;
      }
      Object.defineProperty(stream, "columns", descriptor);
    });
  };
}

// The same context with the width taken back off, to exercise the one
// remaining fallback (the renderer's own entry point) on purpose.
function unpinned<T extends { width?: number }>(ctx: T): T {
  const copy = { ...ctx };
  delete copy.width;
  return copy;
}

describe("plan renderers are deterministic offline", () => {
  test("the pinned width, not the terminal, decides the layout", () => {
    const before = {
      plan: renderPlan(planContext(), false),
      planDetails: planDetails(planContext(), false),
      prPlan: renderPrPlan(prPlanContext(), false),
      prPlanDetails: prPlanDetails(prPlanContext(), false),
    };
    const restore = stubColumns(NARROW_WIDTH);
    try {
      expect(renderPlan(planContext(), false)).toEqual(before.plan);
      expect(planDetails(planContext(), false)).toEqual(before.planDetails);
      expect(renderPrPlan(prPlanContext(), false)).toEqual(before.prPlan);
      expect(prPlanDetails(prPlanContext(), false)).toEqual(
        before.prPlanDetails,
      );
    } finally {
      restore();
    }
  });

  test("a different width really does change the output", () => {
    const wide = renderPlan(planContext(), false);
    const narrow = renderPlan(planContext({ width: NARROW_WIDTH }), false);
    expect(narrow).not.toEqual(wide);
    expect(narrow.length).toBeGreaterThan(wide.length);
    // The decision block is where the old flakiness lived: at 80 columns the
    // money line is one row (and therefore the last line), at 40 it wraps to
    // two — the exact assertion that used to fail for no reason but the pane.
    const wideMoney = wide.filter((l) => l.includes("estimate $"));
    expect(wideMoney).toHaveLength(1);
    expect(wide.indexOf(wideMoney[0] ?? "")).toBe(wide.length - 1);
    expect(narrow[narrow.length - 1]).not.toContain("estimate $");
  });

  test("every renderer threads the width all the way down", () => {
    // No width in the context: the entry point's terminalWidth() fallback
    // fires, and the result must be byte-identical to the same width pinned.
    // Anything inside these renderers still reaching for its own width would
    // break this, which is what makes it a threading test and not a restating
    // of the fallback.
    const restore = stubColumns(NARROW_WIDTH);
    try {
      expect(renderPlan(unpinned(planContext()), false)).toEqual(
        renderPlan(planContext({ width: NARROW_WIDTH }), false),
      );
      expect(planDetails(unpinned(planContext()), false)).toEqual(
        planDetails(planContext({ width: NARROW_WIDTH }), false),
      );
      expect(renderPrPlan(unpinned(prPlanContext()), false)).toEqual(
        renderPrPlan(prPlanContext({ width: NARROW_WIDTH }), false),
      );
      expect(prPlanDetails(unpinned(prPlanContext()), false)).toEqual(
        prPlanDetails(prPlanContext({ width: NARROW_WIDTH }), false),
      );
    } finally {
      restore();
    }
  });

  test("a failed gate with exclusions stays deterministic too", () => {
    // The longest decision block there is: gate verdict, exclusion note,
    // --force note, money. Every one of those four goes through
    // markerRowLines, so this is the case that catches a missed width
    // argument on any of them.
    const ctx = planContext({
      options: options({ force: true }),
      sizeGate: failedGate,
      droppedPaths: ["bun.lock", "dist/app.js"],
    });
    const pinned = renderPlan(ctx, false);
    const restore = stubColumns(NARROW_WIDTH);
    try {
      expect(renderPlan(ctx, false)).toEqual(pinned);
    } finally {
      restore();
    }
    expect(renderPlan({ ...ctx, width: NARROW_WIDTH }, false)).not.toEqual(
      pinned,
    );
  });
});

// ---------------------------------------------------------------------------
// C5 O-7 — the plan names any value the operator cannot see in the checkout.
//
// A global ~/.prhero/config.json changes what a review does from a file that
// is not in the repository at all. Every case below asserts the RETURNED
// lines, and the last one asserts zero escape bytes with styles off — the
// same three renderer criteria the rest of this file holds to.
// ---------------------------------------------------------------------------

const GLOBAL_CONFIG_PATH = "/Users/x/.prhero/config.json";
const REPO_CONFIG_PATH = "/tmp/pr-hero-fake-repo/.prhero/config.json";

// row() wraps at the pinned width, so a tag can straddle two lines. These
// assertions are about WHICH tags appear, not which column they land in — the
// wrap itself is already pinned by the determinism block above — so they match
// against the unwrapped text.
const flat = (lines: string[]): string => joined(lines).replace(/\s+/g, " ");

const provenance = (
  over: Partial<ConfigProvenance> = {},
  sources: Partial<ConfigSources> = {},
): ConfigProvenance => ({
  agentsDirSource: "repo",
  repoConfigPath: REPO_CONFIG_PATH,
  globalConfigPath: GLOBAL_CONFIG_PATH,
  globalPresent: false,
  ...over,
  sources: {
    agents_dir: "repo",
    default_base: "repo",
    parity_trigger_paths: "repo",
    suspicion_priors: "repo",
    summary: { enabled: "repo", model: "default" },
    routing: "default",
    max_verification_steps: "default",
    max_changed_lines: "default",
    max_changed_files: "default",
    scout: "default",
    post: "default",
    ci_review_policy: "default",
    ci_max_attempts: "default",
    ci_max_reviews: "default",
    ci_rereview_min_score: "default",
    ci_blocking_weight: "default",
    ci_advisory_weight: "default",
    ci_trusted_actors: "repo",
    ci_admission_observe_only: "default",
    ...sources,
  },
});

describe("plan card config provenance (C5 O-7)", () => {
  test("tags a global-sourced value and a capped one, and names the file", () => {
    const text = flat(
      renderPlan(
        planContext({
          configProvenance: provenance(
            { agentsDirSource: "global", globalPresent: true },
            {
              agents_dir: "global",
              summary: { enabled: "capped", model: "global" },
              max_verification_steps: "capped",
            },
          ),
        }),
        false,
      ),
    );
    expect(text).toContain("CONFIG");
    // The biggest spend lever in the file, arriving from outside the repo.
    expect(text).toContain("agents_dir ← global");
    // `capped` is NOT `global`: the operator has to see that a ceiling BOUND,
    // not merely that a global file existed.
    expect(text).toContain("summary.enabled ← capped");
    expect(text).toContain("max_verification_steps ← capped");
    expect(text).toContain("summary.model ← global");
    // Where to go look, on the card itself.
    expect(text).toContain(GLOBAL_CONFIG_PATH);
  });

  // The unsurprising case costs the card nothing: a repo-sourced value is
  // visible by opening the checkout, so it is not tagged and the row does not
  // even appear.
  test("an all-repo run prints no CONFIG row at all", () => {
    const lines = renderPlan(
      planContext({ configProvenance: provenance() }),
      false,
    );
    expect(flat(lines)).not.toContain("CONFIG");
    // …and byte-identical to a plan that carries no provenance at all, so the
    // row cannot cost layout on the common path.
    expect(lines).toEqual(renderPlan(planContext(), false));
  });

  // Judgment ledger JD-21: O-7 says "any value that did not come from the
  // repo file", which includes `default`; §3.6 tags only global and capped.
  // §3.6's reading is implemented — a defaulted value is byte-for-byte pre-C5
  // behaviour and already has its own row on this card, so tagging six of
  // them per quiet repo would bury the one tag that is new information.
  test("a defaulted value is not tagged", () => {
    const text = flat(
      renderPlan(
        planContext({
          configProvenance: provenance(
            {},
            {
              agents_dir: "default",
              default_base: "default",
              parity_trigger_paths: "default",
              suspicion_priors: "default",
              summary: { enabled: "default", model: "default" },
              max_verification_steps: "default",
            },
          ),
        }),
        false,
      ),
    );
    expect(text).not.toContain("CONFIG");
    expect(text).not.toContain("← default");
  });

  // Judgment ledger JD-10: ConfigSource has no `flag` member, so the record
  // cannot name a flag-supplied value. The card must therefore not claim a
  // LAYER won a key a flag decided — D5 lets a flag exceed a cap on purpose,
  // and printing `capped` next to a value --no-summary already overrode would
  // be the plan describing a run that is not the one about to happen.
  test("a flag-decided value carries no layer tag", () => {
    // `default_base: "global"` is unreachable today — it is a `repo` key, the
    // global parser rejects it and the fold refuses it. It is here because the
    // suppression is generic on purpose: the card must not start naming a
    // layer for a flag-decided key the day a direction changes.
    const sources: Partial<ConfigSources> = {
      agents_dir: "global",
      default_base: "global",
      summary: { enabled: "capped", model: "global" },
    };
    const flagged = flat(
      renderPlan(
        planContext({
          options: options({
            agents: "/flagged/set",
            base: "release",
            summary: true,
            model: "opus",
          }),
          // --agents won, so the RESOLUTION says flag even though the record
          // still remembers a global value existed.
          configProvenance: provenance({ agentsDirSource: "flag" }, sources),
        }),
        false,
      ),
    );
    expect(flagged).not.toContain("agents_dir ←");
    expect(flagged).not.toContain("default_base ←");
    expect(flagged).not.toContain("summary.enabled ←");
    expect(flagged).not.toContain("summary.model ←");

    // Same sources, no flags: now every one of them is named. agents_dir's
    // resolution changes with the flag too — that IS the mechanism, not a
    // second switch beside it.
    const unflagged = flat(
      renderPlan(
        planContext({
          configProvenance: provenance({ agentsDirSource: "global" }, sources),
        }),
        false,
      ),
    );
    expect(unflagged).toContain("agents_dir ← global");
    expect(unflagged).toContain("default_base ← global");
    expect(unflagged).toContain("summary.enabled ← capped");
    expect(unflagged).toContain("summary.model ← global");
  });

  test("the PR card tags the same way", () => {
    const text = flat(
      renderPrPlan(
        prPlanContext({
          configProvenance: provenance(
            { agentsDirSource: "global", globalPresent: true },
            { agents_dir: "global" },
          ),
        }),
        false,
      ),
    );
    expect(text).toContain("agents_dir ← global");
    expect(text).toContain(GLOBAL_CONFIG_PATH);
  });

  // The details view is the un-dense one, so it answers the other half of the
  // question — "where do I even write this" — with both paths, present or not.
  test("both details views name both files whether or not they exist", () => {
    for (const lines of [
      planDetails(planContext({ configProvenance: provenance() }), false),
      prPlanDetails(prPlanContext({ configProvenance: provenance() }), false),
    ]) {
      const text = flat(lines);
      expect(text).toContain(REPO_CONFIG_PATH);
      expect(text).toContain(GLOBAL_CONFIG_PATH);
      expect(text).toContain("absent");
      expect(text).toContain(
        "every value came from the repo file or a built-in default",
      );
    }

    const present = flat(
      planDetails(
        planContext({
          configProvenance: provenance(
            { agentsDirSource: "global", globalPresent: true },
            { agents_dir: "global" },
          ),
        }),
        false,
      ),
    );
    expect(present).toContain("(present)");
    expect(present).toContain("agents_dir ← global");
  });

  // ui/primitives.ts's contract, on the rows this slice added: styles arrive as a
  // parameter, and with them off nothing paints.
  test("no escape bytes with styles off, and the width still decides", () => {
    const ctx = planContext({
      configProvenance: provenance(
        { agentsDirSource: "global", globalPresent: true },
        {
          agents_dir: "global",
          summary: { enabled: "capped", model: "global" },
          max_verification_steps: "capped",
        },
      ),
    });
    for (const lines of [
      renderPlan(ctx, false),
      planDetails(ctx, false),
      renderPrPlan(
        prPlanContext({ configProvenance: ctx.configProvenance }),
        false,
      ),
      prPlanDetails(
        prPlanContext({ configProvenance: ctx.configProvenance }),
        false,
      ),
    ]) {
      expect(lines.join("")).not.toContain(ESC);
    }
    // Painted, the same rows still carry the same text.
    expect(flat(renderPlan(ctx, true))).toContain("agents_dir ← global");
    // And the tags wrap on the PINNED width, never on the pane's. Captured
    // BEFORE the stub, or the two sides of the comparison are the same
    // expression and the assertion cannot fail — the determinism block above
    // takes the same precaution for the same reason.
    const pinned = renderPlan(ctx, false);
    const restore = stubColumns(NARROW_WIDTH);
    try {
      expect(renderPlan(ctx, false)).toEqual(pinned);
    } finally {
      restore();
    }
    expect(renderPlan({ ...ctx, width: NARROW_WIDTH }, false)).not.toEqual(
      renderPlan(ctx, false),
    );
  });

  // -------------------------------------------------------------------------
  // The empty-tag caption may not claim an origin configTags never checked.
  //
  // Judgment ledger JD-10 is the reason the hole exists: configTags suppresses
  // the tag for a flag-decided key, because ConfigSource has no `flag` member
  // and naming a LAYER for a key a flag decided would name the file that lost
  // (D5 — a flag may exceed a cap on purpose). Suppressing the tag was right;
  // what was never adjusted is the caption on the other side of the same
  // `tags.length === 0` test, which goes on asserting that every value came
  // from the repo file or a default. On a run where a flag decided one, that
  // sentence is false about exactly the value the operator most recently
  // typed. The fix is a caption scoped to what the function verified, not a
  // flag tag — a flag tag reopens JD-10.
  // -------------------------------------------------------------------------

  const ALL_REPO_CAPTION =
    "every value came from the repo file or a built-in default";
  const FLAGGED_CAPTION =
    "every value a flag did not decide came from the repo file or a built-in default";

  test("a flag-decided value voids the all-repo caption", () => {
    const lines = planDetails(
      planContext({
        options: options({ base: "release" }),
        configProvenance: provenance(),
      }),
      false,
    );
    const text = flat(lines);
    // The load-bearing half: the FALSE claim is gone. `default_base` came from
    // --base, so "every value came from the repo file or a built-in default"
    // is a statement about this run that is not true of it.
    expect(text).not.toContain(ALL_REPO_CAPTION);
    // And the replacement is a claim, not a shrug: it still names repo/default
    // as the origin of everything the flags left alone.
    expect(text).toContain(FLAGGED_CAPTION);
    expect(lines.join("")).not.toContain(ESC);
  });

  // The case that kills a vague caption. Both suppressed keys have a source
  // the record REMEMBERS — `capped` and `global` — so a caption that tried to
  // say "no cap narrowed a value" or "nothing came from the global file"
  // would be false here too, on a different word.
  test("a capped-and-global pair a flag overrode still voids the caption", () => {
    const text = flat(
      planDetails(
        planContext({
          options: options({ summary: true, model: "opus" }),
          configProvenance: provenance(
            { globalPresent: true },
            { summary: { enabled: "capped", model: "global" } },
          ),
        }),
        false,
      ),
    );
    expect(text).not.toContain(ALL_REPO_CAPTION);
    expect(text).toContain(FLAGGED_CAPTION);
    // The suppression itself is unchanged: still no layer named for a key a
    // flag decided (JD-10).
    expect(text).not.toContain("summary.enabled ←");
    expect(text).not.toContain("summary.model ←");
  });

  // With no flag in play the old sentence is exact, and stays: every source is
  // repo-or-default, `flag` is excluded by the branch, and `global`/`env` both
  // produce a tag — so nothing unchecked can reach here.
  test("with no flags the all-repo caption is still the exact one", () => {
    const text = flat(
      planDetails(planContext({ configProvenance: provenance() }), false),
    );
    expect(text).toContain(ALL_REPO_CAPTION);
    expect(text).not.toContain(FLAGGED_CAPTION);
  });

  // -------------------------------------------------------------------------
  // Judgment ledger JD-9: a global `agents_dir` silently preempts
  // PRHERO_AGENTS_DIR. The C5 mitigation was "the card prints
  // `agents_dir ← global`, so the operator sees which one won" — but the tag
  // fired on `global` alone, so the REVERSE direction was invisible: an
  // env-sourced prompt set is exactly as absent from the checkout as a
  // global-sourced one, which is the surprise O-7 exists to prevent.
  // -------------------------------------------------------------------------
  test("an env-sourced agents_dir is tagged like a global-sourced one", () => {
    const ctx = planContext({
      configProvenance: provenance({ agentsDirSource: "env" }),
    });
    const lines = renderPlan(ctx, false);
    const text = flat(lines);
    expect(text).toContain("CONFIG");
    expect(text).toContain("agents_dir ← env");
    expect(lines.join("")).not.toContain(ESC);
    // The details view says it too, and the presence of a tag means the
    // all-repo caption is correctly out of the way.
    const details = flat(planDetails(ctx, false));
    expect(details).toContain("agents_dir ← env");
    expect(details).not.toContain(ALL_REPO_CAPTION);
    // The PR card is the same code path, and the same operator surprise.
    expect(
      flat(
        renderPrPlan(
          prPlanContext({ configProvenance: ctx.configProvenance }),
          false,
        ),
      ),
    ).toContain("agents_dir ← env");
  });
});

describe("plan card and details route dimensions display", () => {
  const routingConfig: RoutingConfig = {
    mappings: [
      {
        logical: aliasCanonical("sonnet"),
        backend: "claude-code",
        provider: lookupAlias("sonnet").provider,
        gateway: "direct",
        modelFamily: "sonnet",
        modelSnapshot: "sonnet",
      },
      {
        logical: aliasCanonical("haiku"),
        backend: "claude-code",
        provider: lookupAlias("haiku").provider,
        gateway: "direct",
        modelFamily: "haiku",
        modelSnapshot: "haiku",
      },
      {
        logical: aliasCanonical("opus"),
        backend: "claude-code",
        provider: lookupAlias("opus").provider,
        gateway: "direct",
        modelFamily: "opus",
        modelSnapshot: "opus",
      },
      {
        logical: "openai/o3-mini",
        backend: "opencode",
        provider: "openai",
        gateway: "configured",
        modelFamily: "o3-mini",
        modelSnapshot: "o3-mini-2025-01-31",
      },
    ],
  };

  const hunter1 = resolveStepRoute({
    stepKey: "hunter-reliability",
    role: "hunter",
    cliModel: "sonnet",
    routingConfig,
  });
  const hunter2 = resolveStepRoute({
    stepKey: "hunter-parity",
    role: "hunter",
    cliModel: "sonnet",
    routingConfig,
  });
  const refuter = resolveStepRoute({
    stepKey: "refuter",
    role: "refuter",
    cliModel: "openai/o3-mini",
    routingConfig,
  });
  const summarizer = resolveStepRoute({
    stepKey: "summarizer",
    role: "summarizer",
    cliModel: "haiku",
    routingConfig,
  });

  const routePlan = createResolvedRoutePlan([
    hunter1,
    hunter2,
    refuter,
    summarizer,
  ]);

  const sonnetRouteLabel = `${aliasCanonical("sonnet")} [direct, claude-code]`;

  test("formatModelRoute formats direct and configured routes with dimensions", () => {
    expect(formatModelRoute(hunter1.route, "sonnet")).toBe(
      `sonnet -> ${sonnetRouteLabel}`,
    );

    expect(formatModelRoute(refuter.route, "openai/o3-mini")).toBe(
      "openai/o3-mini -> openai/o3-mini-2025-01-31 [configured, opencode]",
    );

    expect(formatModelRoute(hunter1.route)).toBe(sonnetRouteLabel);
  });

  test("planDetails renders route dimensions for each step", () => {
    const lines = planDetails(planContext({ routePlan }), false);
    const text = flat(lines);
    expect(text).toContain("route hunter-reliability");
    expect(text).toContain(sonnetRouteLabel);
    expect(text).toContain("route refuter");
    expect(text).toContain("openai/o3-mini-2025-01-31 [configured, opencode]");
  });

  test("renderPlan displays resolved route dimensions on agent rows when routePlan is supplied", () => {
    const lines = renderPlan(planContext({ routePlan }), false);
    const text = flat(lines);
    expect(text).toContain("reliability");
    expect(text).toContain(sonnetRouteLabel);
    expect(text).toContain("openai/o3-mini-2025-01-31 [configured, opencode]");
  });

  test("prPlanDetails and renderPrPlan render route dimensions", () => {
    const lines = prPlanDetails(prPlanContext({ routePlan }), false);
    const text = flat(lines);
    expect(text).toContain("route hunter-reliability");
    expect(text).toContain(sonnetRouteLabel);

    const prLines = renderPrPlan(prPlanContext({ routePlan }), false);
    const prText = flat(prLines);
    expect(prText).toContain(sonnetRouteLabel);
  });
});

// S4: the RUN row's count is the config's suspicion priors, labelled as such, not prior findings.
describe("renderPlan: the RUN row labels the config suspicion priors (S4)", () => {
  test("the count reads as suspicion priors", () => {
    const text = joined(renderPlan(planContext(), false));
    expect(text).toContain("0 suspicion prior(s)");
  });
});
