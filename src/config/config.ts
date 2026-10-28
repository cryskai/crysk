// The config domain: the two-layer read (repo `.prhero/config.json` +
// global `~/.prhero/config.json`), the pipeline-input adapters that turn an
// `EffectiveConfig`/`PipelineResult` into the JSON `pipeline.json` actually
// publishes, the review()/reviewPr() caller-seam wrappers around fail-soft
// metrics ingest and canonical-store persistence, and the repo-root
// resolver `configCommand` shares with `main`'s `setup` dispatch. Extracted
// from cli.ts (cli-decomp S2, Cluster A): every WHY comment below is carried
// over verbatim, unchanged in meaning or behavior.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRepoRoot } from "#git/git";
import type { FindingsDocument } from "#review/findings";
import type { PerAgentUsage, PipelineResult } from "#review/pipeline";
import {
  type CliOptions,
  type ConfigLayer,
  type ConfigSources,
  type LocalConfig,
  mergeConfig,
  parseGlobalConfig,
  parseLocalConfig,
} from "#review/preflight";
import { type FailSoftIngestInput, failSoftIngest } from "#store/metrics";
import { projectCompleteRun } from "#store/preflight";
import { openProductStore, saveRunTransaction } from "#store/store";
import { resolveHomeDir, resolveRepoDir } from "../brand-paths";
import { CliError } from "../errors";
import { prheroLayout } from "../home-preflight";

// C5 O-6's half of the pipeline input. Unconditional, unlike its two
// neighbours above: the summarizer and the scout are stages that may not run,
// while a config ALWAYS resolved to something — and D7's whole point is that
// the artifact must discriminate the builds. `global_present` is carried
// separately because `sources` cannot express it: a global file that exists
// and says `{}` leaves every source at `repo` or `default`, exactly like no
// file at all.
// #173 (§8: "Artifacts and reports show cash and notional totals
// separately"). The shell's one decision on the cash/notional split, extracted
// into a pure function for the same reason `pipelineScoutInput` above is one:
// `review()` and `reviewPr()` are I/O shells nothing can call offline, so a
// decision left inline in them is a decision no test can reach. That matters
// more here than usual — `notionalCostUsd` spent three slices fully built and
// entirely unpopulated, and the step that goes missing in that pattern is
// always the last wiring one. Deleting the four call sites below must fail a
// test; without this function it flipped nothing.
//
// Absence, never zero: a run whose steps reported no normalized usage, or
// reported usage carrying no provider figure, yields NO key at all, and both
// renderers omit their notional line on `undefined`. A `0` default would print
// "$0.00 at list price" for a run that never produced a list price — the same
// fabrication `normalizeUnavailableUsage` exists to refuse, relocated to the
// terminal.
export function notionalCostInput(
  result: Pick<PipelineResult, "usageV2">,
): { notionalUsd: number } | Record<string, never> {
  const notionalUsd = result.usageV2?.notionalCostUsd;
  return notionalUsd === undefined ? {} : { notionalUsd };
}

export function pipelineConfigInput(loaded: EffectiveConfig): {
  config: {
    effective: LocalConfig;
    sources: ConfigSources;
    global_present: boolean;
  };
} {
  return {
    config: {
      effective: loaded.effective,
      sources: loaded.sources,
      global_present: loaded.globalPresent,
    },
  };
}

// The ONE caller-layer seam review() and reviewPr() both call after writing
// their artifact (W4 Phase 6 remediation, GitHub #23 option D — spec
// "Fail-Soft Ingest": "WHEN a review finishes THEN the review still exits
// successfully"). A thin wrapper around failSoftIngest is deliberate: the
// verify report flagged that the fail-soft proof lived one layer BELOW this
// call (failSoftIngest's own unit tests), never at the layer review()/
// reviewPr() actually invoke — this function IS that layer, so a test
// against it proves the same seam the two real callers use, not a sibling
// one.
export function ingestReviewMetrics(input: FailSoftIngestInput): void {
  failSoftIngest(input);
}

export interface PersistCanonicalReviewInput {
  dbPath?: string;
  home?: string;
  repoId: string | null;
  runDir: string;
  checkoutPath: string | null;
  doc: FindingsDocument;
  perAgent?: Record<string, PerAgentUsage>;
  // The PR's diff base. Local runs pass none; the store keeps the value it has.
  diffFromSha?: string | null;
  generatedAt?: string;
  log?: (line: string) => void;
  // Test seam
  persist?: (input: PersistCanonicalReviewInput) => number;
}

// Canonical Product Store (Fundamentals #6 / observability-canonical-store.md).
// Persists the complete run result into ~/.prhero/prhero.db transactionally.
export function persistCanonicalReview(
  input: PersistCanonicalReviewInput,
): number {
  if (input.persist) {
    return input.persist(input);
  }
  if (input.repoId === null) {
    input.log?.(
      "warning: no repo_id resolved for this run; skipping canonical store persistence",
    );
    return 0;
  }
  try {
    const dbPath =
      input.dbPath ?? prheroLayout(input.home ?? os.homedir()).prheroDbPath;
    const db = openProductStore(dbPath);
    try {
      const projected = projectCompleteRun({
        doc: input.doc,
        perAgent: input.perAgent,
        diffFromSha: input.diffFromSha,
        repoId: input.repoId,
        runDir: input.runDir,
        checkoutPath: input.checkoutPath,
        generatedAt: input.generatedAt,
      });
      return saveRunTransaction(db, projected);
    } finally {
      db.close();
    }
  } catch (err) {
    input.log?.(
      `warning: canonical store persistence failed — the review itself is intact: ${(err as Error).message}`,
    );
    return 0;
  }
}

export interface EffectiveConfig {
  // The ONE shape every resolver downstream receives, exactly as before C5.
  // They cannot tell how it was built, which is the whole of D9's promise.
  effective: LocalConfig;
  sources: ConfigSources;
  repoConfigPath: string;
  globalConfigPath: string;
  // Additive beyond design §3.4's four fields, and O-6 needs it: pipeline.json
  // has to record whether a global layer EXISTED, and that is not derivable
  // from `sources` — a global file that exists and says `{}` leaves every
  // source at `repo` or `default`, indistinguishable from no file at all.
  // Returned from the same stat the read used, so the artifact cannot
  // disagree with what was actually loaded.
  globalPresent: boolean;
}

// C5 §3.4 — the two-layer read, and the ONLY place either config file is
// opened on the review path. Replaces the duplicated
// existsSync/parseLocalConfig/EMPTY_LOCAL_CONFIG block that used to sit in
// both review() and reviewPr().
//
// `root` is the OPERATOR root in both modes and NEVER the review worktree
// (O-8): a reviewed PR's tree must not influence engine config, and the
// global file is read from os.homedir(), which is one step further from a PR
// author's reach than the operator checkout already was. C5 cannot weaken
// that boundary; it only adds a source the author has strictly less access to.
//
// WHY a missing file yields an ABSENT layer instead of EMPTY_LOCAL_CONFIG:
// the constant materialises `parity_trigger_paths: []` and
// `suspicion_priors: []`, so handing it to the merge would make "no file at
// all" indistinguishable from "a file that said []", and provenance would
// report `repo` for a layer that does not exist. mergeConfig decides what an
// all-silent run resolves to; EMPTY_LOCAL_CONFIG is now the shape that comes
// OUT of that, not the input that goes in.
//
// `--config` overrides the repo path only. A flag that repointed the global
// layer is a footgun with no use case. Its missing-file CliError is
// unchanged: an explicitly named file that is not there stays an error,
// because silently falling back to "no parity triggers" would disable a
// hunter the caller just asked for, and a hunter that never fires looks
// exactly like a hunter that found nothing.
// The global layer on its own, and the ONE place `~/.prhero/config.json` is
// opened. Two callers need it for different reasons and must not read it two
// ways: loadEffectiveConfig folds it under the repo file, while `pr-hero init`
// needs it WITHOUT the repo file, because init is writing that file and asking
// what the global already supplies is the whole of O-9. A second read site
// would be a second chance for the two to disagree about what "the global
// layer" is — the same reason §3.4 collapsed review()/reviewPr()'s duplicated
// block into one function.
//
// A malformed global file throws here, so it fails init exactly as loudly as
// it fails a review. That is deliberate: a scaffold silently written against
// "no global file" when there IS one, broken, would hardcode into the repo
// file precisely the keys the operator was about to fix.
export async function loadGlobalConfigLayer(home: string): Promise<{
  filePath: string;
  layer: ConfigLayer | undefined;
}> {
  const filePath = prheroLayout(home).reviewConfigPath;
  if (!existsSync(filePath)) return { filePath, layer: undefined };
  return {
    filePath,
    layer: parseGlobalConfig(
      await Bun.file(filePath).text(),
      `~/${path.basename(path.dirname(filePath))}/config.json`,
    ),
  };
}

export async function loadEffectiveConfig(input: {
  root?: string | undefined;
  home: string;
  configFlag?: string | undefined;
}): Promise<EffectiveConfig> {
  const repoConfigPath = input.configFlag
    ? path.resolve(input.configFlag)
    : input.root
      ? path.join(resolveRepoDir(input.root), "config.json")
      : path.join(resolveHomeDir(input.home), "config.json");
  if (input.configFlag && !existsSync(repoConfigPath)) {
    throw new CliError(`config file not found: ${repoConfigPath}`);
  }
  const { filePath: globalConfigPath, layer: global } =
    await loadGlobalConfigLayer(input.home);
  // `global !== undefined` and not a second stat: the helper returns a layer
  // exactly when the file was there and read, so the artifact's
  // `global_present` cannot disagree with what was actually loaded — which is
  // the property the field was added for.
  const globalPresent = global !== undefined;
  const repo =
    (input.configFlag || input.root) && existsSync(repoConfigPath)
      ? parseLocalConfig(
          await Bun.file(repoConfigPath).text(),
          input.configFlag
            ? undefined
            : `${path.basename(path.dirname(repoConfigPath))}/config.json`,
        )
      : {};
  return {
    ...mergeConfig(global, repo),
    repoConfigPath,
    globalConfigPath,
    globalPresent,
  };
}

// `pr-hero config`'s and `setup`'s shared repo-root resolver: unlike the
// review path (a missing/invalid repo is a hard CliError), both commands
// treat "not inside a repo" as a valid state — `config` renders the global
// layer alone, `setup` runs the wizard against `process.cwd()` outright.
// `options.repoExplicit` still enforces the same failure the review path
// does when the operator NAMED a --repo: an explicit flag that does not
// resolve should not silently degrade to "no repo".
export async function resolveOptionalRepoRoot(
  options: CliOptions,
): Promise<string | undefined> {
  if (options.repoExplicit) {
    return await resolveRepoRoot(options.repo);
  }
  return await resolveRepoRoot(process.cwd()).catch(() => undefined);
}
