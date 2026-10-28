// Offline tests for the config domain (cli-decomp S2, Cluster A): the
// two-layer read (loadEffectiveConfig/loadGlobalConfigLayer), the
// pipeline-input adapters (notionalCostInput/pipelineConfigInput), and the
// review()/reviewPr() caller-seam wrappers (ingestReviewMetrics/
// persistCanonicalReview). Moved out of test/cli.test.ts, which tested these
// functions before they were extracted from cli.ts into src/config/config.ts.
//
// `tmpHome`/`tmpRoot`/`MUSIVE_CONFIG` and `doc`/`OPERATOR_ROOT`/`HEAD`/
// `OLD_HEAD`/`TELEMETRY` are duplicated from test/cli.test.ts rather than
// imported from it: there is no shared test-fixture module in this repo (the
// same call test/cli.test.ts itself made for its own fakeGh, borrowed from
// test/pr/pr.test.ts), and cli.test.ts still needs its own copies for the
// orchestration tests (runDoctorCommand, postInlineFindings, …) that did not
// move.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ingestReviewMetrics,
  loadEffectiveConfig,
  loadGlobalConfigLayer,
  notionalCostInput,
  persistCanonicalReview,
  pipelineConfigInput,
} from "#config/config";
import type { FindingsDocument, Telemetry } from "#review/findings";
import {
  DEFAULT_MAX_VERIFICATION_STEPS,
  EMPTY_LOCAL_CONFIG,
  resolveMaxVerificationSteps,
  resolveSummary,
} from "#review/preflight";
import { CliError } from "../../src/errors";

const OPERATOR_ROOT = "/repo";
const HEAD = "b".repeat(40);
const OLD_HEAD = "a".repeat(40);

const TELEMETRY: Telemetry = {
  index_ms: 0,
  index_mode: "sync",
  index_disk_mb: 0,
  wall_ms: 1000,
  tokens_in: 10,
  tokens_out: 10,
  tokens_total: 20,
  cost_usd_est: 1,
};

function doc(overrides: Partial<FindingsDocument> = {}): FindingsDocument {
  const findings = overrides.findings ?? [];
  return {
    schema_version: "1.0.0",
    pr: 42,
    base_sha: OLD_HEAD,
    head_sha: HEAD,
    model: "sonnet",
    iteration: 0,
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: TELEMETRY,
    findings,
    debug: { refuted: [] },
    ...overrides,
  };
}

// #173. The engine has now shipped three fully-built, correct, never-connected
// mechanisms (the spend ledger #171, the provider-cost disjunct, and
// `notionalCostUsd` itself), so the LAST wiring step gets its own pin rather
// than being trusted to the shell. The renderers and the pipeline rollup are
// covered by their own suites; without this, deleting all four call sites in
// `review()`/`reviewPr()` flips zero tests — verified by mutation, which is
// exactly how the previous three stayed invisible.
describe("notionalCostInput — the shell's cash/notional split (#173)", () => {
  test("a subscription run's list figure reaches the renderers", () => {
    expect(
      notionalCostInput({
        usageV2: {
          wallMs: 1,
          tokens: {},
          completeness: "complete",
          billingMode: "subscription",
          costSource: "subscription",
          cashCostUsd: 0,
          notionalCostUsd: 0.0455,
        },
      }),
    ).toEqual({ notionalUsd: 0.0455 });
  });

  // Absence over fabrication, on both doors into it: a runner that reported no
  // normalized usage at all, and one that reported usage carrying no list
  // figure. Both must yield NO key — the renderers omit their notional row on
  // `undefined`, and a `0` here would print a list-price claim for a run that
  // never produced one.
  test("no rollup, and a rollup with no list figure, both stay absent", () => {
    expect(notionalCostInput({})).toEqual({});
    expect(
      notionalCostInput({
        usageV2: {
          wallMs: 1,
          tokens: {},
          completeness: "unavailable",
          billingMode: "unknown",
          costSource: "unknown",
        },
      }),
    ).toEqual({});
  });

  // A metered route reports real cash and no notional, so it keeps showing a
  // single figure — the split must not invent a second one for it.
  test("a metered run with cash and no notional stays single-figure", () => {
    expect(
      notionalCostInput({
        usageV2: {
          wallMs: 1,
          tokens: {},
          completeness: "complete",
          billingMode: "metered",
          costSource: "provider",
          cashCostUsd: 0.42,
        },
      }),
    ).toEqual({});
  });
});

describe("ingestReviewMetrics — the review()/reviewPr() caller seam (W4 Phase 6)", () => {
  test("a throwing ingest degrades to a warning, never throws", () => {
    const warnings: string[] = [];
    expect(() =>
      ingestReviewMetrics({
        dbPath: "/tmp/does-not-matter.db",
        repoId: "github.com/acme/widgets",
        runDir: "/runs/local-1",
        checkoutPath: OPERATOR_ROOT,
        doc: doc({ pr: 0 }),
        perAgent: {},
        log: (line) => warnings.push(line),
        ingest: () => {
          throw new Error("disk full");
        },
      }),
    ).not.toThrow();
    expect(warnings).toEqual([
      "warning: metrics ingest failed — the review itself is intact: disk full",
    ]);
  });

  test("a successful ingest logs nothing and reaches the seam with the given runDir", () => {
    const warnings: string[] = [];
    const seenRunDirs: string[] = [];
    ingestReviewMetrics({
      dbPath: "/tmp/does-not-matter.db",
      repoId: "github.com/acme/widgets",
      runDir: "/runs/pr-42-1",
      checkoutPath: OPERATOR_ROOT,
      doc: doc({ pr: 42 }),
      perAgent: {},
      log: (line) => warnings.push(line),
      ingest: (input) => {
        seenRunDirs.push(input.runDir);
      },
    });
    expect(warnings).toEqual([]);
    expect(seenRunDirs).toEqual(["/runs/pr-42-1"]);
  });
});

describe("persistCanonicalReview — canonical product store persistence (Fundamentals #6)", () => {
  test("a null repoId logs a warning and returns 0", () => {
    const warnings: string[] = [];
    const runId = persistCanonicalReview({
      dbPath: "/tmp/does-not-matter.db",
      repoId: null,
      runDir: "/runs/local-1",
      checkoutPath: OPERATOR_ROOT,
      doc: doc({ pr: 0 }),
      perAgent: {},
      log: (line) => warnings.push(line),
    });
    expect(runId).toBe(0);
    expect(warnings).toEqual([
      "warning: no repo_id resolved for this run; skipping canonical store persistence",
    ]);
  });

  test("a throwing sqlite error logs a warning and returns 0 without crashing", () => {
    const warnings: string[] = [];
    const runId = persistCanonicalReview({
      dbPath: "/invalid/path/that/cannot/exist/prhero.db",
      repoId: "github.com/acme/widgets",
      runDir: "/runs/pr-42-1",
      checkoutPath: OPERATOR_ROOT,
      doc: doc({ pr: 42 }),
      perAgent: {},
      log: (line) => warnings.push(line),
    });
    expect(runId).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(
      "warning: canonical store persistence failed — the review itself is intact:",
    );
  });

  test("invokes custom persist seam when provided", () => {
    const seen: string[] = [];
    const runId = persistCanonicalReview({
      dbPath: "/tmp/does-not-matter.db",
      repoId: "github.com/acme/widgets",
      runDir: "/runs/pr-42-1",
      checkoutPath: OPERATOR_ROOT,
      doc: doc({ pr: 42 }),
      perAgent: {},
      persist: (input) => {
        seen.push(input.runDir);
        return 123;
      },
    });
    expect(runId).toBe(123);
    expect(seen).toEqual(["/runs/pr-42-1"]);
  });
});

// ---------------------------------------------------------------------------
// C5 — loadEffectiveConfig, the two-layer read (O-5, O-8, and §0.7's two
// branches that had zero coverage before this slice).
//
// Real files in real tmpdirs, because the whole point of this function is the
// filesystem: which paths it opens, which it refuses to open, and what a
// missing one means. A fake fs would prove the merge, which preflight.test.ts
// already proves purely.
// ---------------------------------------------------------------------------

async function tmpHome(global?: string): Promise<{
  home: string;
  cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(path.join(tmpdir(), "pr-hero-home-"));
  if (global !== undefined) {
    await mkdir(path.join(home, ".prhero"), { recursive: true });
    await Bun.write(path.join(home, ".prhero", "config.json"), global);
  }
  return {
    home,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

async function tmpRoot(repoConfig?: string): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "pr-hero-root-"));
  if (repoConfig !== undefined) {
    await mkdir(path.join(root, ".prhero"), { recursive: true });
    await Bun.write(path.join(root, ".prhero", "config.json"), repoConfig);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const MUSIVE_CONFIG = JSON.stringify(
  {
    agents_dir: "/Users/juanma/Desktop/deep-review/agents/slice3b-clean",
    default_base: "dev",
    parity_trigger_paths: [],
    suspicion_priors: [],
    summary: { enabled: false },
  },
  null,
  2,
);

describe("loadEffectiveConfig — O-5, no global file resolves as today", () => {
  test("every key resolves to exactly what the repo file said", async () => {
    const home = await tmpHome();
    const repo = await tmpRoot(MUSIVE_CONFIG);
    try {
      const loaded = await loadEffectiveConfig({
        root: repo.root,
        home: home.home,
      });
      // The §0.5 fixture, byte-for-byte what three real checkouts carry.
      expect(loaded.effective).toEqual({
        agents_dir: "/Users/juanma/Desktop/deep-review/agents/slice3b-clean",
        default_base: "dev",
        parity_trigger_paths: [],
        suspicion_priors: [],
        summary: { enabled: false },
      });
      // Table-driven over all keys: with no global layer every one of
      // them is the repo's or a default, and NOTHING says `global`/`capped`.
      expect(loaded.sources).toEqual({
        agents_dir: "repo",
        default_base: "repo",
        parity_trigger_paths: "repo",
        suspicion_priors: "repo",
        summary: { enabled: "repo", model: "default" },
        routing: "default",
        max_verification_steps: "default",
        max_concurrent_steps: "default",
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
        ci_trusted_actors: "default",
        ci_admission_observe_only: "default",
      });
      expect(loaded.globalPresent).toBe(false);
      expect(loaded.globalConfigPath).toBe(
        path.join(home.home, ".prhero", "config.json"),
      );
      expect(loaded.repoConfigPath).toBe(
        path.join(repo.root, ".prhero", "config.json"),
      );
      // The two resolvers that read this layer see today's answers.
      expect(resolveSummary({}, loaded.effective)).toEqual({ enabled: false });
      expect(resolveMaxVerificationSteps(loaded.effective)).toBe(
        DEFAULT_MAX_VERIFICATION_STEPS,
      );
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });

  // §0.7: `rg EMPTY_LOCAL_CONFIG test/` returned zero hits before C5 — the
  // fallback both read sites depended on was never exercised. It is now
  // reached through an ABSENT layer instead of a substituted constant, and
  // the shape the resolvers receive has to be identical either way.
  test("no repo config resolves to the EMPTY_LOCAL_CONFIG shape", async () => {
    const home = await tmpHome();
    const repo = await tmpRoot();
    try {
      const loaded = await loadEffectiveConfig({
        root: repo.root,
        home: home.home,
      });
      expect(loaded.effective).toEqual(EMPTY_LOCAL_CONFIG);
      // …and says so honestly: `default` for all keys, never `repo` for two
      // arrays no file ever named (O-14 at the shell layer).
      expect(loaded.sources).toEqual({
        agents_dir: "default",
        default_base: "default",
        parity_trigger_paths: "default",
        suspicion_priors: "default",
        summary: { enabled: "default", model: "default" },
        routing: "default",
        max_verification_steps: "default",
        max_concurrent_steps: "default",
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
        ci_trusted_actors: "default",
        ci_admission_observe_only: "default",
      });
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });

  // The other §0.7 branch. An explicitly named file that is not there stays
  // an ERROR: silently falling back to "no parity triggers" would disable a
  // hunter the caller just asked for, and a hunter that never fires looks
  // exactly like a hunter that found nothing.
  test("--config pointing at a missing file throws CliError", async () => {
    const home = await tmpHome();
    const repo = await tmpRoot(MUSIVE_CONFIG);
    try {
      const missing = path.join(repo.root, "nope", "config.json");
      const promise = loadEffectiveConfig({
        root: repo.root,
        home: home.home,
        configFlag: missing,
      });
      await expect(promise).rejects.toThrow(CliError);
      await expect(promise).rejects.toThrow(
        `config file not found: ${missing}`,
      );
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });

  test("--config points the REPO layer elsewhere, never the global one", async () => {
    const home = await tmpHome(JSON.stringify({ max_verification_steps: 4 }));
    const repo = await tmpRoot(MUSIVE_CONFIG);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "pr-hero-cfg-"));
    try {
      const flagPath = path.join(elsewhere, "other.json");
      await Bun.write(flagPath, JSON.stringify({ default_base: "trunk" }));
      const loaded = await loadEffectiveConfig({
        root: repo.root,
        home: home.home,
        configFlag: flagPath,
      });
      expect(loaded.repoConfigPath).toBe(flagPath);
      expect(loaded.effective.default_base).toBe("trunk");
      // The repo's own file is NOT read once --config names another.
      expect(loaded.effective.agents_dir).toBeUndefined();
      // Judgment ledger JD-16, named rather than fixed: --config is no longer
      // hermetic — the machine's global layer still merges in, and there is
      // no suppression flag. Pinned so the day someone wants one, this test
      // is the thing that has to change on purpose.
      expect(loaded.effective.max_verification_steps).toBe(4);
      expect(loaded.sources.max_verification_steps).toBe("global");
    } finally {
      await home.cleanup();
      await repo.cleanup();
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("loadEffectiveConfig — the global layer", () => {
  test("a quiet repo inherits the person's file", async () => {
    const home = await tmpHome(
      JSON.stringify({
        agents_dir: "/Users/x/sets/clean",
        summary: { enabled: false, model: "haiku" },
        max_verification_steps: 3,
      }),
    );
    const repo = await tmpRoot();
    try {
      const loaded = await loadEffectiveConfig({
        root: repo.root,
        home: home.home,
      });
      expect(loaded.globalPresent).toBe(true);
      expect(loaded.effective.agents_dir).toBe("/Users/x/sets/clean");
      expect(loaded.sources.agents_dir).toBe("global");
      expect(loaded.sources.summary.model).toBe("global");
      expect(loaded.sources.max_verification_steps).toBe("global");
      // A `repo` key stays absent: the global file cannot even carry one.
      expect(loaded.effective.default_base).toBeUndefined();
      expect(loaded.sources.default_base).toBe("default");
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });

  test("the cap binds through the shell, not just through the merge", async () => {
    const home = await tmpHome(
      JSON.stringify({
        summary: { enabled: false },
        max_verification_steps: 2,
      }),
    );
    const repo = await tmpRoot(
      JSON.stringify({
        summary: { enabled: true },
        max_verification_steps: 8,
      }),
    );
    try {
      const loaded = await loadEffectiveConfig({
        root: repo.root,
        home: home.home,
      });
      expect(loaded.effective.summary?.enabled).toBe(false);
      expect(loaded.sources.summary.enabled).toBe("capped");
      expect(loaded.effective.max_verification_steps).toBe(2);
      expect(loaded.sources.max_verification_steps).toBe("capped");
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });

  // Judgment ledger JD-11: after C5 the global file is read on EVERY review in
  // both modes, so one bad global file fails every repo on the machine. The
  // message has to name the file it is actually in, or the operator edits the
  // repo's config looking for a typo that is not there.
  test("a malformed global file names the global file", async () => {
    const home = await tmpHome('{"parity_trigger_paths": []}');
    const repo = await tmpRoot(MUSIVE_CONFIG);
    try {
      await expect(
        loadEffectiveConfig({ root: repo.root, home: home.home }),
      ).rejects.toThrow(
        "~/.prhero/config.json: parity_trigger_paths is a per-repo key",
      );
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });
});

// C5 O-9's shell half. `pr-hero init` needs the global layer WITHOUT the repo
// file — it is writing that file — so it cannot go through
// loadEffectiveConfig. It goes through the same helper loadEffectiveConfig
// does instead, because a second read site for `~/.prhero/config.json` is a
// second chance for init and review to disagree about what the global layer
// says.
describe("loadGlobalConfigLayer", () => {
  test("a missing file is an ABSENT layer, not an empty one", async () => {
    const home = await tmpHome();
    try {
      const loaded = await loadGlobalConfigLayer(home.home);
      expect(loaded.layer).toBeUndefined();
      expect(loaded.filePath).toBe(
        path.join(home.home, ".prhero", "config.json"),
      );
    } finally {
      await home.cleanup();
    }
  });

  test("a file that exists and says {} is a layer that supplies nothing", async () => {
    // The distinction O-6's `global_present` exists for, at the layer that
    // produces it: `{}` is a file, and "no file" is not.
    const home = await tmpHome("{}");
    try {
      expect((await loadGlobalConfigLayer(home.home)).layer).toEqual({});
    } finally {
      await home.cleanup();
    }
  });

  test("a present file is parsed by the GLOBAL parser", async () => {
    const home = await tmpHome(
      JSON.stringify({ agents_dir: "/g/agents", summary: { enabled: false } }),
    );
    try {
      expect((await loadGlobalConfigLayer(home.home)).layer).toEqual({
        agents_dir: "/g/agents",
        summary: { enabled: false },
      });
    } finally {
      await home.cleanup();
    }
  });

  test("a malformed global file throws, so init fails as loudly as a review", async () => {
    // Deliberate: a scaffold written against "no global file" when there IS
    // one, broken, would hardcode into the repo file exactly the keys the
    // operator was about to fix.
    const home = await tmpHome('{"default_base": "dev"}');
    try {
      await expect(loadGlobalConfigLayer(home.home)).rejects.toThrow(
        "~/.prhero/config.json: default_base is a per-repo key",
      );
    } finally {
      await home.cleanup();
    }
  });
});

// O-8. The offline half of the boundary: loadEffectiveConfig opens
// `<root>/.prhero/config.json` and nothing else, so a config.json sitting in
// the PR's head worktree is never even a candidate. reviewPr passes
// `root: operatorRoot` (src/cli.ts, step 1) and the worktree does not exist
// yet at that point — that wiring is what makes this test the whole story.
describe("loadEffectiveConfig — O-8, the worktree is never read", () => {
  test("a decoy config.json inside the head worktree is ignored", async () => {
    const home = await tmpHome();
    const operator = await tmpRoot(
      JSON.stringify({ agents_dir: "/operator/set", default_base: "dev" }),
    );
    try {
      // The reviewed PR's tree, as a sibling the way ~/.prhero/repos/<id>/
      // worktrees actually live — with a config the PR author committed.
      //
      // mkdtemp, like every other fixture in this file, and NOT
      // `path.join(operator.root, "..", "pr-hero-decoy-worktree")`. That built
      // a FIXED name one level above an mkdtemp-randomised root, which is the
      // OS tmp root itself — so every concurrent run of this suite (parallel
      // shards, a second `bun test` on the machine) shared one directory and
      // raced: one run's mkdir/Bun.write interleaving with another's cleanup
      // `rm` is a flaky ENOENT/EEXIST, or a run reading the other's decoy.
      // `operator.root` is itself a direct child of tmpdir(), so a randomised
      // name here is still the sibling the comment above describes, and the
      // "decoy-worktree" substring is kept because the last assertion below
      // is what gives it meaning.
      const worktree = await mkdtemp(
        path.join(tmpdir(), "pr-hero-decoy-worktree-"),
      );
      await mkdir(path.join(worktree, ".prhero"), { recursive: true });
      await Bun.write(
        path.join(worktree, ".prhero", "config.json"),
        JSON.stringify({
          agents_dir: "/attacker/set",
          default_base: "attacker-branch",
        }),
      );
      try {
        const loaded = await loadEffectiveConfig({
          root: operator.root,
          home: home.home,
        });
        expect(loaded.effective.agents_dir).toBe("/operator/set");
        expect(loaded.effective.default_base).toBe("dev");
        expect(loaded.repoConfigPath.startsWith(operator.root)).toBe(true);
        expect(loaded.repoConfigPath).not.toContain("decoy-worktree");
      } finally {
        await rm(worktree, { recursive: true, force: true });
      }
    } finally {
      await home.cleanup();
      await operator.cleanup();
    }
  });
});

// O-6's caller half: the block the CLI hands the pipeline. The artifact-level
// assertion lives in test/pipeline.test.ts, where the run harness is.
describe("pipelineConfigInput — O-6", () => {
  test("carries the effective config, the sources and global_present", () => {
    const loaded = {
      effective: { ...EMPTY_LOCAL_CONFIG, agents_dir: "/set" },
      sources: {
        agents_dir: "global" as const,
        default_base: "default" as const,
        parity_trigger_paths: "default" as const,
        suspicion_priors: "default" as const,
        summary: { enabled: "default" as const, model: "default" as const },
        routing: "default" as const,
        max_verification_steps: "default" as const,
        max_concurrent_steps: "default" as const,
        max_changed_lines: "default" as const,
        max_changed_files: "default" as const,
        scout: "default" as const,
        post: "default" as const,
        ci_review_policy: "default" as const,
        ci_max_attempts: "default" as const,
        ci_max_reviews: "default" as const,
        ci_rereview_min_score: "default" as const,
        ci_blocking_weight: "default" as const,
        ci_advisory_weight: "default" as const,
        ci_trusted_actors: "repo" as const,
        ci_admission_observe_only: "default" as const,
      },
      repoConfigPath: "/repo/.prhero/config.json",
      globalConfigPath: "/home/.prhero/config.json",
      globalPresent: true,
    };
    expect(pipelineConfigInput(loaded)).toEqual({
      config: {
        effective: loaded.effective,
        sources: loaded.sources,
        global_present: true,
      },
    });
    // Unconditional, unlike its summarizer/scout neighbours: an absent block
    // has to mean "predates C5", never "the CLI forgot".
    expect(
      pipelineConfigInput({ ...loaded, globalPresent: false }).config
        .global_present,
    ).toBe(false);
  });
});

describe("max_concurrent_steps layering", () => {
  test("is capped: the lower layer wins, and the source names the cap", async () => {
    const home = await tmpHome(JSON.stringify({ max_concurrent_steps: 4 }));
    const repo = await tmpRoot(JSON.stringify({ max_concurrent_steps: 8 }));
    try {
      const loaded = await loadEffectiveConfig({
        root: repo.root,
        home: home.home,
      });
      expect(loaded.effective.max_concurrent_steps).toBe(4);
      expect(loaded.sources.max_concurrent_steps).toBe("capped");
    } finally {
      await home.cleanup();
      await repo.cleanup();
    }
  });
});
