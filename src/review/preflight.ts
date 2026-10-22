// Everything local mode (ROADMAP B0) must decide BEFORE it is allowed to
// spend money, expressed as pure functions so it is all testable offline.
// The CLI in cli.ts is the I/O shell around these; nothing here touches the
// filesystem, git, or the network — a preflight that needs a live repo to be
// tested is a preflight that gets tested once, live, at $10 a go.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CI_REVIEW_POLICY_MODES,
  type CiReviewPolicyMode,
} from "#ci/review-policy";
import type { EffectiveConfig } from "#config/config";
import type {
  ModelGateway,
  RouteMapping,
  RoutingConfig,
  RunnerBackend,
} from "#model/routing";
import type { SuspicionPrior } from "#review/prompt-set";
import { type AgentSpec, isSafeSlug, type ReviewSpec } from "#review/spec";
import {
  ADJUDICATED_TAGS,
  type TriageTag,
  type TriageVerdict,
} from "#triage/triage";
import { type EngineAssets, resolveEngineAssets } from "../assets";
// CliError/CliUsageError and the git/ref pure helpers used to be DEFINED here
// and imported by value into git.ts — the bottom layer depending on a
// review-domain module. They live in ../errors and ../git/refs; this file
// imports only the ones it uses itself.
import { CliError, CliUsageError, withUsageClass } from "../errors";
import { DEFAULT_BASE_REF, listPaths } from "../git/refs";
import { redactDiagnostic } from "../security/redact";
// review/size-gate.ts imports only a TYPE from here, so this is not a runtime
// cycle — the type import is erased and size-gate has no load-time
// dependency on this module.
import { DEFAULT_SIZE_GATE, unquotePath } from "./size-gate";

// The lab's production value. Also the single biggest per-hunter cost lever
// in the whole engine: every hop is another round of tool calls against the
// tree, and hunter cost scales with hops far more sharply than with diff
// size. The fixture eval runs at 4 precisely because 12 is not cheap.
export const DEFAULT_HOP_BUDGET = 12;

// watch install's default StartInterval, in minutes. 15 keeps a fresh PR's
// wait bounded by the tick while staying far below GitHub's rate-limit radar
// (a tick is one `pr list` per repo plus a comments read per candidate).
export const DEFAULT_WATCH_INTERVAL_MIN = 15;

// gc install's default StartInterval, in minutes. The 72h TTL only
// evaluates when GC actually runs; 6h is frequent enough that a merged PR
// does not sit until tomorrow, and cheap (gh view per tree, no LLM).
export const DEFAULT_GC_INTERVAL_MIN = 360;

export const DEFAULT_HEAD_REF = "HEAD";

// Keep this in sync with prompts/summarizer.md. The prompt remains the source
// of truth for execution when no model override is configured; this value is
// only the honest model label shown in a preflight plan.
export const DEFAULT_SUMMARY_MODEL = "haiku";

export interface CliOptions {
  // Relative on purpose: parseArgs is pure, so "resolve against cwd" is the
  // caller's job, not a hidden dependency on process.cwd() in a pure function.
  repo: string;
  // UNSET when no --base was given, never pre-filled with a literal branch
  // name. Resolving the real default branch needs git (the remote head), and
  // parseArgs must stay pure — so the shell in cli.ts finishes the job via
  // resolveBaseRef. A default baked in here would be a wrong ref that nothing
  // downstream can tell apart from one the user asked for.
  base?: string;
  head: string;
  agents?: string;
  out?: string;
  // Gotchas describe the REPO, not the commit under review, so they must be
  // supplyable from outside the reviewed tree — see the note in cli.ts. The
  // same is true of the config: parity triggers and priors are properties of
  // the project, and requiring them in-tree silently disables the conditional
  // parity hunter on any tree you cannot add a file to.
  gotchas?: string;
  config?: string;
  model?: string;
  // Summary activation is tri-state at parse time: undefined means no flag,
  // so review can apply flag > config > the default-on setting.
  summary?: boolean;
  // The scout is tri-state at parse time: undefined means no flag,
  // so review can apply flag > config > default (false).
  scout?: boolean;
  // `--shared-prefix` / `--no-shared-prefix`. Undefined means the default,
  // which is ON (see resolveSharedPrefix).
  sharedPrefix?: boolean;
  // Independent model knob (§3.7), and NOT exercised by M6 — the whole
  // control corpus is sonnet, so ratifying this is ratifying a flag, not a
  // second variable. `--model` still outranks it (the JD override rule).
  scoutModel?: string;
  // Item 7: widen discovery to full B..H on a re-review. Default OFF — a
  // second push is delta-scoped unless asked otherwise. Verification,
  // triage, and classification still run (R2-C5). Review-only, like --scout.
  full: boolean;
  // T5b: with --pr --ci, also have the CI adjudicator rule on each pending
  // dismissal of a blocking finding. Set by a /pr-hero recheck comment. Absent
  // means off.
  adjudicate?: boolean;
  hopBudget: number;
  dryRun: boolean;
  yes: boolean;
  // PR mode (ROADMAP B1). Set only by --pr: head and base both come from the
  // PR record itself, so parseArgs rejects --base/--head/--two-dot beside it
  // — a hand-picked endpoint would silently contradict the PR's own range.
  // "current" is bare `--pr`: resolve the PR from the operator checkout's
  // current branch at run time (the shell owns that gh call). Absent means
  // local mode.
  pr?: number | "current";
  // Publish the review as ONE marked PR comment (ROADMAP B2) — created the
  // first time, updated in place after, never stacked. Tri-state at parse time:
  // undefined means no flag, resolved via flag > config > default (false).
  // Requires --pr (parseArgs enforces it): a comment needs a PR to land on.
  post?: boolean;
  // ledger only (ROADMAP B4): the runs root to scan for comparison.json
  // files. Unset means defaultRunRoot(home, repoId) — the shell resolves it,
  // because the default needs origin + ~/.prhero and parseArgs stays pure.
  runs?: string;
  // post/triage only (ROADMAP B6/B6c): the run dir to read findings.json +
  // diff.patch (post) or comparison.json (triage) from, instead of
  // producing a new run — the `ledger` verb's precedent (read run artifacts
  // off disk) applied to publishing/triaging instead of aggregating.
  // Required by both; parseArgs enforces it.
  from?: string;
  // `status` only (ROADMAP S9): print one JSON object on stdout instead of the human lines.
  // Refused on every other command, so the flag never parses and then does nothing.
  json?: boolean;
  // The escape hatch for change 3's default. See resolveDiffRange's WHY: the
  // three-dot (merge-base) range is right almost always, and this flag exists
  // for the rare caller who genuinely wants the literal two-point diff.
  twoDot: boolean;
  // watch only (ROADMAP B3): which watch action was asked for. "once" is one
  // tick (the launchd unit of work), install/uninstall manage the launchd
  // agent, add/remove/status manage and inspect the watch config so nobody
  // hand-edits JSON. Required for `watch` — a bare `pr-hero watch` has no
  // daemon mode to fall into, so it fails loud instead of hanging.
  watch?: "once" | "install" | "uninstall" | "add" | "remove" | "status";
  // gc install/uninstall/status manage a SEPARATE launchd agent from the
  // watcher: it runs `pr-hero gc` (no reviews, no watch.json, no window/cap).
  // Unset means the collector itself.
  gc?: "install" | "uninstall" | "status";
  // `skills install` (src/commands/skills.ts): the non-interactive install of
  // pr-hero's agent skills into every detected coding agent. Its only
  // subcommand; anything else after `skills` is a usage error.
  skills?: "install";
  // watch install and gc install: launchd StartInterval, in minutes.
  interval?: number;
  // watch add only: record on_push: true for the repo, so every new push
  // re-arms its PRs. The default (false) reviews each PR once — see the
  // re-arm policy note on candidateSkipReason in watch/preflight.ts.
  onPush: boolean;
  // Bypass the CI skips for THIS run: the size gate, review-policy
  // admission, and (in CI) the budget ceiling. The GitHub comment
  // `/pr-hero review` is what sets this flag from Actions. Deliberately
  // does NOT imply --yes: the interactive cost-band prompt is a separate
  // question from those skips.
  force: boolean;
  // usage only (W4 / #23): show every repo_id instead of the current
  // checkout's origin-scoped view (spec "Operator-Wide View Via --all").
  // Valid on no other command — a size-gate-style boolean, not a value
  // flag, so `usage --all` and `usage` are the whole surface.
  all: boolean;
  // Size-gate overrides. UNSET means "use DEFAULT_SIZE_GATE"; 0 is a real,
  // distinct value that DISABLES the limit, so these cannot default to 0.
  maxChangedLines?: number;
  maxChangedFiles?: number;
  // `triage reply` sub-word (W1). Unset means the existing bind-ledger
  // `triage` verb. Same pattern as watch's sub-words: `reply` is not its
  // own command, so `pr-hero reply` still fails as unknown.
  triage?: "reply";
  finding?: string;
  tag?: TriageTag;
  bodyFile?: string;
  verdict?: TriageVerdict;
  issue?: number;
  // reverts only (GitHub #41): the `git log --since=` window to mine for
  // reverted/hotfixed PRs. A string, not a date, because git's own date
  // parser accepts "24 months ago" as readily as "2025-01-01" and reusing it
  // beats re-implementing it here. Unset means DEFAULT_REVERTS_SINCE — the
  // shell applies it, so parseArgs stays pure and "the operator asked for a
  // window" stays distinguishable from "nobody said".
  since?: string;
  // corpus only (GitHub #43/#44): the five candidate sources. At least one is
  // REQUIRED (enforced post-loop, where the whole set is visible) — a bare
  // `pr-hero corpus` would be a $0 no-op that looks like a scan. --proximity
  // IMPLIES --fixes (proximity suspects are computed over the fix set),
  // applied here so the shell never re-derives the implication. --issues
  // upgrades a classified set and does NOT imply --fixes; it requires
  // --fixes and/or --incidents (--proximity already implies --fixes).
  fixes: boolean;
  incidents: boolean;
  issues: boolean;
  proximity: boolean;
  threads: boolean;
  // corpus only: the proximity window in days, kept VERBATIM like --since —
  // validateProximityDays in corpus/preflight.ts owns the 1..90 rule where
  // the join that consumes it is tested. Unset means DEFAULT_PROXIMITY_DAYS.
  proximityDays?: string;
  // corpus only: csv of issue labels that mark a referenced issue as a bug.
  // Unset means DEFAULT_BUG_LABELS. GitHub labels are case-sensitive, so the
  // split (splitBugLabels) never lowercases. Requires --issues — a value
  // flag of a source that is not on would be a silently dropped intention.
  bugLabels?: string;
  // mcp only (Canonical Store / MCP): optional socket or db path overrides.
  socket?: string;
  db?: string;
  // upgrade & uninstall only
  purge?: boolean;
  check?: boolean;
  reconcile?: boolean;
  // activity only
  kill?: number;
  // config only
  configSubcommand?: "set" | "unset" | "edit";
  configKey?: string;
  configValue?: string;
  configLayer?: "person" | "team" | "watch";
  edit?: boolean;
  repoExplicit?: boolean;
  // ROADMAP Pillar 3 (GitHub Actions CI). `ci` is the EXPLICIT flag only —
  // `isCiEnvironment()` ORs it with the GITHUB_ACTIONS/CI env vars, which
  // parseArgs (pure, no process.env read) cannot see. Both `budgetUsd` and
  // `stepSummary` require `--ci` at parse time (the `--post`-requires-`--pr`
  // precedent above): a spend ceiling or a summary toggle for a mode that
  // never activates would be exactly the "silently dropped intention" the
  // --bug-labels/--scout-model guards already refuse elsewhere in this file.
  //
  // Phase 4 (CI Scaffolding) gave `--ci` a SECOND, command-scoped meaning:
  // on `review` it activates the CI headless shell (requires --pr); on
  // `setup` it means "scaffold .github/workflows/pr-hero.yml instead of
  // running the interactive wizard" — see `ci init`'s dedicated command
  // below for the same scaffolding without touching `setup`'s wizard
  // default. `budgetUsd`/`stepSummary` still require the REVIEW reading of
  // `--ci` specifically (checked below), since neither means anything to
  // scaffolding.
  ci?: boolean;
  // `ci init` — the same scaffolding as `setup --ci`, as its own command.
  // Unset on every other command. "init" is the only sub-word today; kept
  // as a literal union (not a bare boolean) so a future `ci status` has
  // somewhere to go without a breaking change.
  ciSubcommand?: "init";
  // Unset means "no ceiling configured" (no gate, no disabled-ceiling
  // warning — there is nothing to disable). <= 0, GIVEN explicitly, disables
  // the ceiling too, but DOES warn: see ci/gates.ts's
  // budgetDisabledWarningMessage for why the two are not the same state.
  budgetUsd?: number;
  // Tri-state like `summary`/`scout`: unset means "the shell's own default
  // (on)", so `--step-summary` and `--no-step-summary` stay distinguishable
  // from "nobody said".
  stepSummary?: boolean;
  // S4: the commit-status gate for a `review --ci` run, required at parse time
  // like budgetUsd. `gate` (the CI default) turns the pr-hero commit status red
  // on blocking findings, a size or budget skip, and a crash; `advisory` keeps
  // today's posture. Unset means the run resolves it (resolveCiMode, pr/preflight).
  ciMode?: "gate" | "advisory";
}

// design.md 3.1's literal formula: Boolean(GITHUB_ACTIONS || CI || --ci).
// Pure — env arrives as a parameter (reviewPr's shell reads
// process.env.GITHUB_ACTIONS/CI and passes them in), so this stays offline-
// testable without process.env being a hidden dependency the way parseArgs
// itself refuses to have one. There is no `src/ci.ts` (design's proposed
// home for this function) — Phases 1-2 already folded the CI surface into
// ci/reporter.ts/ci/gates.ts instead, and this joins that same deviation
// rather than starting a third file for one function.
export function isCiEnvironment(
  options: { ci?: boolean },
  env: { GITHUB_ACTIONS?: string; CI?: string },
): boolean {
  return Boolean(env.GITHUB_ACTIONS || env.CI || options.ci);
}

export interface ParsedCli {
  command:
    | "review"
    | "init"
    | "setup"
    | "doctor"
    | "menu"
    | "activity"
    | "ledger"
    | "watch"
    | "post"
    | "triage"
    | "status"
    | "gc"
    | "usage"
    | "reverts"
    | "corpus"
    | "config"
    | "mcp"
    | "upgrade"
    | "uninstall"
    | "ci"
    | "skills"
    | "help";
  options: CliOptions;
}

export const HELP_TEXT = `pr-hero — multi-agent review of a real repo + branch

Usage:
  pr-hero [options]          Open interactive terminal user interface (TTY)
  pr-hero menu [options]     Open interactive terminal user interface
  pr-hero review [options]   Review a branch (zero flags inside a configured repo)
  pr-hero init [options]     Scaffold <repo>/.prhero/ (config.json + gotchas.md)
  pr-hero setup [options]    Run interactive onboarding wizard
  pr-hero setup --ci [--force]
                             Scaffold .github/workflows/pr-hero.yml instead
                             of the wizard. Refuses to overwrite an existing
                             workflow unless --force is passed
  pr-hero skills install [--force]
                             Install the triage and CI-setup skills into every detected coding agent (no TTY, no MCP)
  pr-hero ci init [--force]  Same scaffolding as "setup --ci", as its own
                             command
  pr-hero doctor [options]   Check system tools and environment readiness
  pr-hero activity [options] View currently running reviews and recent store history
  pr-hero activity --kill <pid> [--yes]
                             Safely terminate a running review (checks process identity)
  pr-hero upgrade [options]  Upgrade pr-hero to latest version & sync agent assets
  pr-hero uninstall [opts]   Remove pr-hero daemons, MCP registrations & skills
  pr-hero ledger [options]   Accumulate every run's comparison.json into one
                             markdown ledger (the three buckets as a rate)
  pr-hero mcp [options]      Start the read-only Model Context Protocol (MCP)
                             server over stdio for AI coding assistants. Read-only, $0
  pr-hero post --pr <n> --from <run-dir> [--dry-run]
                             Publish a PREVIOUSLY RUN review's findings.json
                             to PR <n>, reading it (and diff.patch) off disk
                             instead of running a fresh review — the same
                             fetch → match → post flow --pr --post uses.
                             --dry-run renders the planned comment set at $0
                             and posts nothing (the only way to preview a
                             plan, since --pr --dry-run returns before any
                             findings exist)
  pr-hero triage --pr <n> --from <run-dir> [--dry-run]
                             Read the PR's reply threads, bind every triage
                             reply (ROADMAP B6b's marker) to its finding's
                             row in that run's comparison.json, and write
                             verdict/reasoning/actor back — the ledger's two
                             null columns, filled from the loop instead of by
                             hand. --dry-run reports what would be bound and
                             writes nothing
  pr-hero triage reply --pr <n> --from <run-dir> --finding <id> --tag <tag>
                   --body-file <path> [--verdict <v>] [--issue <n>] [--dry-run]
                             Post one triage reply. The driver resolves the
                             parent from the posted <!-- pr-hero-finding
                             marker (never path/line), renders the marker +
                             badge, posts, and resolves the inline review
                             thread. --body-file is reasoning prose only.
                             --dry-run prints the parent and posts nothing
  pr-hero status --pr <n> [--json]
                             Read the PR's pr-hero gate, posted findings and
                             next action, through gh only and read-only. With
                             --json, one JSON object on stdout (schema
                             pr-hero.status/v1); without it, a few lines on
                             stderr. Exits 1 with no stdout when any read
                             fails. Skills drive review -> reply -> fix -> wait
                             from its next_action
  pr-hero reverts [options]  Mine the repo's default branch for PRs that were
                             later reverted or hotfixed, and write them as
                             markdown CANDIDATES for human confirmation. Runs
                             git log + gh api only: no review, no scoring, no
                             labelling of what the defect was, $0
  pr-hero corpus [options]   Widen the known-bad corpus beyond reverts with
                             five candidate sources, gated by their flags:
                             --fixes (fix-shaped merged PRs, blame-resolved
                             to their likely introducer), --incidents
                             (incident/outage keywords in title/body),
                             --issues (upgrade classified PRs that reference
                             a bug-labelled GitHub issue), --proximity
                             (prior PRs on the same files when the introducer
                             did not resolve), --threads (defects review DID
                             catch, from resolved review threads). At least
                             one source is required; --issues needs --fixes
                             and/or --incidents. All output is CANDIDATES
                             for human confirmation. git log + gh api only:
                             no review, no scoring, $0
  pr-hero watch --once       Run ONE watcher tick over ~/.prhero/watch.json:
                             pick the next unreviewed open PR across the
                             configured repos and review it. launchd (or cron)
                             is the scheduler; this never daemonizes
  pr-hero watch add          Opt the current repo (or --repo) into the watch
                             config; --post makes its reviews publish to the
                             PR, --on-push re-reviews on every push,
                             --max-changed-lines/--max-changed-files set the
                             repo's size gate.
                             Idempotent — re-adding updates the flags
  pr-hero watch remove       Remove the current repo (or --repo) from the
                             watch config (idempotent)
  pr-hero watch status       Read-only: config summary, today's launch count
                             vs the cap, launchd state, lock, last activity
  pr-hero watch install      Install the macOS launchd agent that runs
                             "watch --once" every --interval minutes
  pr-hero watch uninstall    Unload and remove that launchd agent
  pr-hero gc [--dry-run] [--repo <dir>]
                             Collect review worktrees under ~/.prhero/repos
                             that are merged/closed or idle >72h. --dry-run
                             prints the table and removes nothing. --repo
                             scopes to one origin; default is the whole home
  pr-hero gc install         Install the macOS launchd agent that runs
                             "pr-hero gc" every --interval minutes (default
                             ${DEFAULT_GC_INTERVAL_MIN} = 6h). No reviews,
                             no watch.json — the $0 sweeper so trees do not
                             wait for a review or the watcher
  pr-hero gc uninstall       Unload and remove that launchd agent
  pr-hero gc status          Read-only: whether the GC agent is installed
  pr-hero usage [--all]      Print the observability store's per-run rows
                             (cost, tokens, findings) for the current
                             checkout's origin — every review, local and
                             PR, auto-ingests into it. --all shows every
                             origin instead of just this one. Read-only, $0
  pr-hero config [options]   Print every config key's effective value and the
                             LAYER it came from — global (~/.prhero/config.json),
                             repo (<repo>/.prhero/config.json), capped (the
                             global ceiling narrowed the repo's value away) or
                             default (neither file spoke). Names both file
                             paths whether or not they exist. Resolves through
                             the same merge a review does, so it cannot drift
                             from what actually runs. Read-only — it never
                             writes either file. $0

Options:
  --repo <dir>        Repository to review (default: current directory)
  --pr [n]            Review GitHub PR #n — or, with no number, the PR that
                      belongs to the current branch. head and base come from
                      gh, the review runs in a detached worktree with its
                      own codegraph index, and the result is compared
                      against Greptile's comment on the PR. Excludes --base,
                      --head and --two-dot
  --post              With --pr only: publish the review to the PR as one
                      marked comment — created the first time, updated in
                      place on re-runs, never stacked. Explicit, never a
                      default. With watch add: record post: true, so the
                      watcher-launched reviews of that repo publish
  --base <ref>        Base branch or sha. Default, in order: the config's
                      default_base, then the remote head
                      (refs/remotes/origin/HEAD), then ${DEFAULT_BASE_REF}
  --head <ref>        Head branch or sha (default: ${DEFAULT_HEAD_REF})
  --agents <dir>      Prompt-set directory. Default, in order: the config's
                      agents_dir (relative paths resolve against the config
                      file), then PRHERO_AGENTS_DIR
  --out <dir>         Run directory; must live OUTSIDE the reviewed repo
                      (default: ~/.prhero/repos/<origin>/runs/<sha>-<n>).
                      For ledger, reverts and corpus: the file to write
                      instead of stdout
  --since <git-date>  reverts and corpus only: how far back to scan the
                      default branch, in any form git's --since accepts
                      ("6 months ago", "2025-01-01"). Default: 24 months ago
  --fixes             corpus only: mine fix-shaped merged PRs (anchored
                      conventional fix/bugfix subject) and blame-resolve each
                      to the PR that last touched the fixed lines
  --incidents         corpus only: mine merged PRs whose title or body carry
                      incident keywords (incident, outage, sentry,
                      crashlytics)
  --issues            corpus only: upgrade classified PRs that reference a
                      GitHub issue labelled as a bug. Requires --fixes
                      and/or --incidents — issue refs do not enter alone
  --proximity         corpus only: for fix PRs whose introducer did not
                      resolve, list prior PRs on the same files within
                      --proximity-days. Implies --fixes — proximity is
                      computed over the fix set
  --threads           corpus only: mine resolved review threads a later push
                      plausibly addressed — the defects review DID catch
  --proximity-days <n>
                      corpus only: the proximity window in days, an integer
                      between 1 and 90. Default: 7
  --bug-labels <csv>  corpus only: with --issues, issue labels that mark a
                      referenced issue as a bug (comma-separated,
                      case-sensitive). Default: bug
  --runs <dir>        ledger only: the runs root to scan for comparison.json
                      files (default: ~/.prhero/repos/<origin>/runs)
  --json              status only: print the status as one JSON object on
                      stdout (schema pr-hero.status/v1)
  --from <dir>        post/triage only: the run dir to read findings.json and
                      anchor.patch or diff.patch (post and triage reply) or comparison.json
                      (triage bind) from (required). triage reply maps
                      --finding F00N onto the posted marker via the same
                      post-line remapping post uses
  --finding <id>      triage reply only: the finding id in that run's
                      findings.json (F001, …). The driver maps it to the
                      posted comment; do not pass a GitHub comment id
  --tag <tag>         triage reply only: applied, dismissed, deferred, or
                      misclassified
  --body-file <path>  triage reply only: reasoning prose. The driver prepends
                      the triage marker and the visible badge
  --verdict <word>    triage reply only: upheld, rejected, or inconclusive.
                      Required for dismissed/deferred/misclassified;
                      forbidden for applied
  --issue <n>         triage reply only: optional GitHub issue number on
                      deferred. Not required — deferred is a tag plus
                      reasoning; the coding agent decides whether an issue
                      exists
  --gotchas <file>    Repo gotchas file (default: <repo>/.prhero/gotchas.md);
                      supply it from outside to review a tree you cannot dirty
  --config <file>     Local config (default: <repo>/.prhero/config.json) with
                      agents_dir, default_base, parity_trigger_paths and
                      suspicion_priors, optional summary settings, and
                      optional max_verification_steps (re-review verify cap;
                      default 8; 0 pauses verification), and optional
                      max_concurrent_steps (cap on steps in flight at once;
                      a positive integer; unset = unlimited)
  --model <model>     Override every agent's model
  --summary           Enable the engine-owned PR summary (default)
  --no-summary        Disable the engine-owned PR summary
  --scout             review only: run the diff-only scout stage before the
                      hunters, biasing their scan with unverified leads.
                      EXPERIMENTAL and off by default — the A/B that decides
                      whether it earns its cost has not run yet
  --scout-model <m>   Model for the scout stage (default: the run's model).
                      Requires --scout
  --no-shared-prefix  review only: turn off the shared hunter prefix. By
                      default the patch and output contract sit in each
                      hunter's system prompt, identical across hunters, and the
                      prompt cache is warmed once per group before the fan-out
                      (--shared-prefix forces it on)
  --full              review only: on a re-review, widen discovery to the
                      full PR range (B..H). Verification and triage still
                      run; the recorded case does not change. On GitHub,
                      comment /pr-hero review --full on the PR
  --adjudicate        with --pr --ci: also have the CI adjudicator rule on
                      each pending dismissal of a blocking finding (at most
                      5 per run) and post its verdict on the finding's
                      thread. Set by a /pr-hero recheck comment.
  --hop-budget <n>    Hops per hunter (default: ${DEFAULT_HOP_BUDGET}); the biggest
                      per-hunter cost lever there is
  --two-dot           Diff the literal <base>..<head> two-point range instead
                      of from the merge base. Rarely what you want: when base
                      has moved on, its newer commits show up REVERSED in the
                      review
  --once              watch only: run one tick and exit (launchd's unit of
                      work). Required — watch has no daemon mode
  --on-push           watch add only: re-review the repo's PRs on every new
                      push. Default: each PR is reviewed ONCE — a push does
                      not re-bill; re-review manually with review --pr <n>
  --interval <min>    watch install and gc install: minutes between launchd
                      ticks (watch default: ${DEFAULT_WATCH_INTERVAL_MIN};
                      gc default: ${DEFAULT_GC_INTERVAL_MIN})
  --dry-run           Resolve, preflight, print the plan and the cost band,
                      then exit without spawning anything. For watch --once:
                      print what would be skipped/launched and why, touching
                      nothing
  --max-changed-lines <n>
                      Size gate: skip the review when the diff has more than
                      n effective changed lines (insertions + deletions,
                      generated files like lockfiles and minified bundles
                      excluded, plus anything a repo's own .prheroignore
                      names). Default ${DEFAULT_SIZE_GATE.maxChangedLines}; 0 disables the limit.
                      With watch add: record the threshold for the repo
  --max-changed-files <n>
                      Size gate: same, on the effective changed-FILE count.
                      Default ${DEFAULT_SIZE_GATE.maxChangedFiles}; 0 disables the limit
  --ci-mode <gate|advisory>
                      With review --ci only. gate (the default): the
                      pr-hero commit status is failure on blocking findings
                      and on a size or budget skip, and error on a crash.
                      advisory: the status stays success whatever the
                      findings, as before
  --force             Review even when CI would skip: the size gate, the
                      review-policy admission rules, and the budget ceiling.
                      On GitHub, comment /pr-hero review on the PR to pass
                      this flag from Actions. An interactive TTY already
                      offers the size-gate choice as a menu; this flag is
                      the unattended hatch. Does NOT imply --yes — the
                      cost-band prompt still asks. With setup --ci /
                      ci init: overwrite an existing
                      .github/workflows/pr-hero.yml instead of refusing
  --all               usage only: show every origin's rows instead of just
                      the current checkout's
  --yes               Skip the confirmation prompt
  --help              Show this text

By default the diff runs from the MERGE BASE of base and head (the three-dot
range), so only what this branch adds is reviewed. The plan prints both the
base ref you asked for and the merge-base sha it actually used.

Every run costs real money. --dry-run costs nothing and answers most
questions; use it first.

The size gate is a COST gate, not a quality gate: past its limits a diff bills
several times more with a much wider spread, so pr-hero skips it unattended
rather than guess at the bill. An interactive run asks first. It says nothing
about how well a large diff reviews.`;

const VALUE_FLAGS = new Set([
  "--repo",
  "--base",
  "--head",
  "--agents",
  "--out",
  "--runs",
  "--from",
  "--gotchas",
  "--config",
  "--model",
  "--scout-model",
  "--hop-budget",
  "--interval",
  "--max-changed-lines",
  "--max-changed-files",
  "--budget-usd",
  "--ci-mode",
  "--finding",
  "--tag",
  "--body-file",
  "--verdict",
  "--issue",
  "--since",
  "--proximity-days",
  "--bug-labels",
  "--socket",
  "--db",
  "--kill",
]);

export function parseArgs(argv: string[]): ParsedCli {
  const options: CliOptions = {
    repo: ".",
    head: DEFAULT_HEAD_REF,
    hopBudget: DEFAULT_HOP_BUDGET,
    full: false,
    dryRun: false,
    yes: false,
    twoDot: false,
    onPush: false,
    force: false,
    all: false,
    fixes: false,
    incidents: false,
    issues: false,
    proximity: false,
    threads: false,
  };
  let command:
    | "review"
    | "init"
    | "setup"
    | "doctor"
    | "menu"
    | "activity"
    | "ledger"
    | "watch"
    | "post"
    | "triage"
    | "status"
    | "gc"
    | "usage"
    | "reverts"
    | "corpus"
    | "config"
    | "mcp"
    | "upgrade"
    | "uninstall"
    | "ci"
    | "skills"
    | "help"
    | undefined;
  // --head carries a baked-in default, so "was it explicitly given" cannot
  // be read off options afterwards — and the --pr exclusion below must fire
  // on an explicit --head even when its value equals that default.
  let headExplicit = false;
  // --once is watch's tick switch; folded into options.watch after the loop
  // so flag order (watch --once vs --once watch) cannot matter.
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") return { command: "help", options };
    // --pr takes an OPTIONAL value. A digit-LEADING next token is consumed
    // and validated — digit-leading on purpose, not full-match: garbage like
    // "12abc" must still reach the validator and fail loudly, never silently
    // become branch-mode. Anything else (nothing, a flag, a word — including
    // the command token, which the non-digit rule protects) is left alone
    // and the sentinel says "resolve the PR from the current branch".
    if (arg === "--pr") {
      const value = argv[i + 1];
      if (value !== undefined && /^\d/.test(value)) {
        i++;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new CliUsageError(
            `--pr must be a positive integer, got: ${value}`,
          );
        }
        options.pr = parsed;
      } else {
        options.pr = "current";
      }
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      // A flag swallowing the NEXT flag as its value is the classic way to
      // end up reviewing the wrong tree: `--base --head foo` would otherwise
      // resolve base to "--head".
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`${arg} needs a value`);
      }
      i++;
      if (arg === "--head") headExplicit = true;
      if (arg === "--repo") options.repoExplicit = true;
      applyValueFlag(options, arg, value);
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--summary") {
      options.summary = true;
      continue;
    }
    if (arg === "--no-summary") {
      options.summary = false;
      continue;
    }
    if (arg === "--scout") {
      options.scout = true;
      continue;
    }
    if (arg === "--no-scout") {
      options.scout = false;
      continue;
    }
    if (arg === "--no-shared-prefix") {
      options.sharedPrefix = false;
      continue;
    }
    if (arg === "--shared-prefix") {
      options.sharedPrefix = true;
      continue;
    }
    if (arg === "--ci") {
      options.ci = true;
      continue;
    }
    if (arg === "--step-summary") {
      options.stepSummary = true;
      continue;
    }
    if (arg === "--no-step-summary") {
      options.stepSummary = false;
      continue;
    }
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--adjudicate") {
      options.adjudicate = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }
    if (arg === "--post") {
      options.post = true;
      continue;
    }
    if (arg === "--no-post") {
      options.post = false;
      continue;
    }
    if (arg === "--two-dot") {
      options.twoDot = true;
      continue;
    }
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--on-push") {
      options.onPush = true;
      continue;
    }
    // NOT folded into --yes: --force overrides the size gate only. See the
    // WHY on CliOptions.force.
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--purge") {
      options.purge = true;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--reconcile") {
      options.reconcile = true;
      continue;
    }
    // The five corpus sources, size-gate-style booleans — no values, and the
    // post-loop corpus block owns their cross-command rules (required-set,
    // --proximity implies --fixes, --issues needs a classified-set source).
    if (arg === "--fixes") {
      options.fixes = true;
      continue;
    }
    if (arg === "--incidents") {
      options.incidents = true;
      continue;
    }
    if (arg === "--issues") {
      options.issues = true;
      continue;
    }
    if (arg === "--proximity") {
      options.proximity = true;
      continue;
    }
    if (arg === "--threads") {
      options.threads = true;
      continue;
    }
    if (arg === "--person") {
      options.configLayer = "person";
      continue;
    }
    if (arg === "--team") {
      options.configLayer = "team";
      continue;
    }
    if (arg === "--watch") {
      options.configLayer = "watch";
      continue;
    }
    if (arg === "--edit") {
      options.edit = true;
      options.configSubcommand = "edit";
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliUsageError(`unknown option: ${arg}`);
    }
    // install/uninstall/add/remove/status are watch's sub-words, not
    // commands of their own: they only parse AFTER `watch`, so `pr-hero
    // install` still fails with the unknown-command list instead of
    // silently touching launchd.
    if (
      command === "watch" &&
      options.watch === undefined &&
      (arg === "install" ||
        arg === "uninstall" ||
        arg === "add" ||
        arg === "remove" ||
        arg === "status")
    ) {
      options.watch = arg;
      continue;
    }
    if (command === "config" && options.configSubcommand === undefined) {
      if (arg === "set") {
        options.configSubcommand = "set";
        const key = argv[++i];
        if (!key || key.startsWith("-")) {
          throw new CliUsageError("config set requires <key> and <value>");
        }
        const val = argv[++i];
        if (!val || val.startsWith("--")) {
          throw new CliUsageError("config set requires <key> and <value>");
        }
        options.configKey = key;
        options.configValue = val;
        continue;
      }
      if (arg === "unset") {
        options.configSubcommand = "unset";
        const key = argv[++i];
        if (!key || key.startsWith("-")) {
          throw new CliUsageError("config unset requires <key>");
        }
        options.configKey = key;
        continue;
      }
      if (arg === "edit") {
        options.configSubcommand = "edit";
        continue;
      }
    }
    if (
      command === "gc" &&
      options.gc === undefined &&
      (arg === "install" || arg === "uninstall" || arg === "status")
    ) {
      options.gc = arg;
      continue;
    }
    if (
      command === "skills" &&
      options.skills === undefined &&
      arg === "install"
    ) {
      options.skills = "install";
      continue;
    }
    // `skills` has exactly one subcommand, `install`; any other word in that
    // slot is a usage error, not a generic unexpected argument.
    if (command === "skills" && options.skills === undefined) {
      throw new CliUsageError("pr-hero skills needs a subcommand: install");
    }
    if (
      command === "triage" &&
      options.triage === undefined &&
      arg === "reply"
    ) {
      options.triage = "reply";
      continue;
    }
    // `ci init` — see the CliOptions.ciSubcommand comment. "init" is the
    // only sub-word today; anything else falls through to the
    // `command !== undefined` unexpected-argument guard right below, same
    // as an unrecognized `watch`/`gc` sub-word would.
    if (
      command === "ci" &&
      options.ciSubcommand === undefined &&
      arg === "init"
    ) {
      options.ciSubcommand = "init";
      continue;
    }
    if (command !== undefined) {
      throw new CliUsageError(`unexpected argument: ${arg}`);
    }
    if (
      arg !== "review" &&
      arg !== "init" &&
      arg !== "setup" &&
      arg !== "doctor" &&
      arg !== "menu" &&
      arg !== "activity" &&
      arg !== "ledger" &&
      arg !== "watch" &&
      arg !== "post" &&
      arg !== "triage" &&
      arg !== "status" &&
      arg !== "gc" &&
      arg !== "usage" &&
      arg !== "reverts" &&
      arg !== "corpus" &&
      arg !== "config" &&
      arg !== "mcp" &&
      arg !== "upgrade" &&
      arg !== "update" &&
      arg !== "uninstall" &&
      arg !== "ci" &&
      arg !== "skills"
    ) {
      throw new CliUsageError(
        `unknown command: ${arg} (the commands are "menu", "review", "init", "setup", "doctor", ` +
          '"activity", "ledger", "watch", "post", "triage", "status", "gc", "usage", ' +
          '"reverts", "corpus", "config", "mcp", "upgrade", "uninstall", "ci" and "skills")',
      );
    }
    command = arg === "update" ? "upgrade" : arg;
  }
  if (command === undefined) {
    throw new CliUsageError(
      'no command given (did you mean "pr-hero review"?)',
    );
  }
  if (command === "skills" && options.skills === undefined) {
    throw new CliUsageError("pr-hero skills needs a subcommand: install");
  }
  // --pr derives the whole range from the PR record — head from GitHub, base
  // from the merge commit's parent or the base branch — so a hand-picked
  // endpoint or range shape beside it would silently contradict what the PR
  // actually contains. Checked after the loop so flag order cannot matter.
  if (options.pr !== undefined) {
    if (options.base !== undefined) {
      throw new CliUsageError(
        "--pr resolves base from the PR itself, so it cannot be combined " +
          "with --base",
      );
    }
    if (headExplicit) {
      throw new CliUsageError(
        "--pr reviews the PR's own head commit, so it cannot be combined " +
          "with --head",
      );
    }
    if (options.twoDot) {
      throw new CliUsageError(
        "--pr always diffs the PR from its merge base, so it cannot be " +
          "combined with --two-dot",
      );
    }
  }
  // Also after the loop, for the same flag-order reason: posting publishes a
  // PR comment, and only --pr names a PR to publish to. `watch` is excused —
  // there --post is `watch add`'s flag, validated in the watch block below.
  // `post` (the command) is ALSO excused: it always targets a PR via its own
  // required --pr, so it needs no --post flag at all — see the "post" block
  // below.
  if (
    options.post &&
    options.pr === undefined &&
    command !== "watch" &&
    command !== "post"
  ) {
    throw new CliUsageError(
      "--post publishes the review as a PR comment, so it requires --pr",
    );
  }
  // ROADMAP Pillar 3 (GitHub Actions CI). `--ci` runs the CI headless shell
  // (skip comments, step summary, structured outputs) against a PR — the
  // official action always passes both together, and nothing else in this
  // CLI has a CI-mode surface to activate. Phase 4 added a SECOND reading on
  // `setup`: scaffold the workflow file instead of running the wizard (see
  // the CliOptions.ci comment) — `setup --ci` never touches --pr.
  if (options.ci && command !== "review" && command !== "setup") {
    throw new CliUsageError("--ci only applies to the review or setup command");
  }
  if (options.ci && command === "review" && options.pr === undefined) {
    throw new CliUsageError(
      "--ci runs the CI headless shell against a PR, so it requires --pr",
    );
  }
  if (options.adjudicate && options.pr === undefined) {
    throw new CliUsageError(
      "--adjudicate runs the CI adjudicator against a PR, so it requires --pr",
    );
  }
  // The adjudicator's verdicts are posted only by the CI shell, so the flag is a
  // no-op anywhere else. Same reasoning as --budget-usd below.
  if (options.adjudicate && !(options.ci && command === "review")) {
    throw new CliUsageError("--adjudicate only applies with review --ci");
  }
  // Same "silently dropped intention" reasoning as --post/--pr above: a
  // spend ceiling or a summary toggle for a mode that never turns on would
  // be a flag the operator believes changed a run it did not. Scoped to
  // `review`'s reading of --ci specifically now that `setup --ci` exists —
  // neither flag means anything to scaffolding.
  if (
    options.budgetUsd !== undefined &&
    !(options.ci && command === "review")
  ) {
    throw new CliUsageError("--budget-usd only applies with review --ci");
  }
  // S4: the gate mode is a review reading of --ci, like budgetUsd. Without
  // it the flag would name a mode that never runs.
  if (options.ciMode !== undefined && !(options.ci && command === "review")) {
    throw new CliUsageError("--ci-mode only applies with review --ci");
  }
  if (
    options.stepSummary !== undefined &&
    !(options.ci && command === "review")
  ) {
    throw new CliUsageError(
      "--step-summary and --no-step-summary only apply with review --ci",
    );
  }
  // `ci` (the command) has exactly one sub-word today: `init`. A bare
  // `pr-hero ci` has no scaffolding action to fall into — same reasoning as
  // watch's `options.watch === undefined` guard below.
  if (command === "ci" && options.ciSubcommand === undefined) {
    throw new CliUsageError(
      'the "ci" command requires a subcommand: "ci init"',
    );
  }
  // The scout is a `review` stage and nothing else reads either flag.
  // Rejected elsewhere rather than ignored, the --from guard's reasoning: a
  // flag that parses and then does nothing is an operator believing they
  // changed a run they did not.
  if (
    command !== "review" &&
    (options.scout !== undefined || options.scoutModel)
  ) {
    throw new CliUsageError(
      "--scout and --scout-model only apply to the review command",
    );
  }
  if (command !== "review" && options.full) {
    throw new CliUsageError("--full only applies to the review command");
  }
  // A model for a stage that will not run is the same silent no-op, one level
  // down — and the likeliest way to produce it is believing the model flag
  // turns the stage on.
  if (options.scoutModel !== undefined && !options.scout) {
    throw new CliUsageError(
      "--scout-model sets the model for the scout stage, so it requires --scout",
    );
  }
  // `status` (ROADMAP S9) reads one PR and writes nothing, so its whole surface is --pr <n>
  // and --json. Every other flag is refused here, not ignored: a flag that parses and then
  // does nothing is an operator believing they changed a read they did not (the --from
  // guard's reasoning below). --json belongs to status alone.
  if (command === "status") {
    if (options.pr === undefined || options.pr === "current") {
      throw new CliUsageError("status requires --pr <n> (a PR number)");
    }
    for (const arg of argv) {
      if (arg.startsWith("-") && arg !== "--pr" && arg !== "--json") {
        throw new CliUsageError(
          `status takes only --pr <n> and --json, not ${arg}`,
        );
      }
    }
  } else if (options.json) {
    throw new CliUsageError("--json only applies to the status command");
  }
  // `post` (ROADMAP B6) and `triage` (ROADMAP B6c) share the same shape:
  // both read a PRIOR run's artifacts, named by --from, and act on the PR
  // named by --pr. Both flags required for either — a command with neither
  // has nothing to read and nowhere to bind it, and guessing either would
  // silently act on the wrong run or the wrong PR.
  if (command === "post" || command === "triage") {
    if (options.pr === undefined) {
      throw new CliUsageError(`${command} requires --pr <n>`);
    }
    if (options.from === undefined) {
      throw new CliUsageError(`${command} requires --from <run-dir>`);
    }
  } else if (options.from !== undefined) {
    throw new CliUsageError(
      "--from only applies to the post and triage commands",
    );
  }
  // --since names the `git log` window `reverts` and `corpus` mine, and
  // nothing else reads it. Rejected elsewhere rather than ignored: a flag
  // that parses and then does nothing is an operator believing they scoped a
  // command they did not — the same reasoning as the --from guard above.
  if (
    options.since !== undefined &&
    command !== "reverts" &&
    command !== "corpus"
  ) {
    throw new CliUsageError(
      "--since only applies to the reverts and corpus commands",
    );
  }
  // The corpus source flags and their two value flags are corpus-only, same
  // reasoning as the --since guard: each names the source it enables, and on
  // any other command it would be a silently dropped intention.
  if (command !== "corpus") {
    if (options.fixes) {
      throw new CliUsageError("--fixes only applies to the corpus command");
    }
    if (options.incidents) {
      throw new CliUsageError("--incidents only applies to the corpus command");
    }
    if (options.issues) {
      throw new CliUsageError("--issues only applies to the corpus command");
    }
    if (options.proximity) {
      throw new CliUsageError("--proximity only applies to the corpus command");
    }
    if (options.threads) {
      throw new CliUsageError("--threads only applies to the corpus command");
    }
    if (options.proximityDays !== undefined) {
      throw new CliUsageError(
        "--proximity-days only applies to the corpus command",
      );
    }
    if (options.bugLabels !== undefined) {
      throw new CliUsageError(
        "--bug-labels only applies to the corpus command",
      );
    }
  } else {
    // Checked after the loop, where the whole flag set is visible at once:
    // corpus with NO source would be a $0 no-op that looks like a scan, and
    // the error names all five so the fix is one copy-paste away.
    if (
      !options.fixes &&
      !options.incidents &&
      !options.issues &&
      !options.proximity &&
      !options.threads
    ) {
      throw new CliUsageError(
        "corpus needs at least one source: --fixes, --incidents, " +
          "--issues, --proximity or --threads",
      );
    }
    // Proximity suspects are computed over the fix set, so a --proximity run
    // IS a --fixes run. Applied here rather than in the shell so the
    // implication is one pure, tested rule instead of an I/O re-derivation.
    if (options.proximity) options.fixes = true;
    // --bug-labels is the value flag of --issues. Passing it without the
    // source would silently configure a walk that never consults the labels.
    if (options.bugLabels !== undefined && !options.issues) {
      throw new CliUsageError("--bug-labels requires --issues");
    }
    // Issue refs upgrade a classified set; they do not enter on their own.
    // --proximity has already implied --fixes, so --issues --proximity is
    // valid. --issues --threads is not: threads do not populate `working`.
    if (options.issues && !options.fixes && !options.incidents) {
      throw new CliUsageError(
        "--issues upgrades classified PRs; pass --fixes and/or --incidents",
      );
    }
  }
  // spec "--all misused on another command": --all is usage's own
  // operator-wide escape hatch, and valid on nothing else.
  if (options.all && command !== "usage") {
    throw new CliUsageError("--all only applies to usage");
  }
  if (options.kill !== undefined && command !== "activity") {
    throw new CliUsageError("--kill only applies to the activity command");
  }
  // The watch surface, validated after the loop for the same order-blindness.
  if (command === "watch") {
    if (once && options.watch !== undefined) {
      throw new CliUsageError(
        `--once cannot be combined with "${options.watch}"`,
      );
    }
    if (once) options.watch = "once";
    if (options.watch === undefined) {
      throw new CliUsageError(
        'watch needs an action: --once (one tick), "add", "remove", ' +
          '"status", "install" or "uninstall"',
      );
    }
    if (options.dryRun && options.watch !== "once") {
      throw new CliUsageError(
        `--dry-run only applies to watch --once, not "${options.watch}"`,
      );
    }
    // On watch, --post configures the repo being added — anywhere else in
    // the watch surface it would be a silently dropped intention.
    if (options.post && options.watch !== "add") {
      throw new CliUsageError(
        `--post with watch only applies to "watch add", not "${options.watch}"`,
      );
    }
    // Same rule for --on-push, for the same silently-dropped reason.
    if (options.onPush && options.watch !== "add") {
      throw new CliUsageError(
        `--on-push only applies to "watch add", not "${options.watch}"`,
      );
    }
  } else {
    if (once) {
      throw new CliUsageError("--once only applies to the watch command");
    }
    if (options.onPush) {
      throw new CliUsageError('--on-push only applies to "watch add"');
    }
  }
  if (options.interval !== undefined) {
    const allowed =
      (command === "watch" && options.watch === "install") ||
      (command === "gc" && options.gc === "install");
    if (!allowed) {
      throw new CliUsageError(
        "--interval only applies to watch install and gc install",
      );
    }
  }
  if (command === "gc" && options.gc !== undefined && options.dryRun) {
    throw new CliUsageError(
      `--dry-run only applies to bare gc, not "gc ${options.gc}"`,
    );
  }
  if (options.triage === "reply") {
    if (options.finding === undefined) {
      throw new CliUsageError("triage reply requires --finding <id>");
    }
    if (options.tag === undefined) {
      throw new CliUsageError("triage reply requires --tag <tag>");
    }
    if (options.bodyFile === undefined) {
      throw new CliUsageError("triage reply requires --body-file <path>");
    }
    if (ADJUDICATED_TAGS.has(options.tag) && options.verdict === undefined) {
      throw new CliUsageError(
        `triage reply --tag ${options.tag} requires --verdict ` +
          "(upheld, rejected, or inconclusive)",
      );
    }
    if (options.tag === "applied" && options.verdict !== undefined) {
      throw new CliUsageError(
        "triage reply --tag applied cannot take --verdict " +
          "(applied pays no adjudicator)",
      );
    }
    if (options.issue !== undefined && options.tag !== "deferred") {
      throw new CliUsageError(
        "triage reply --issue only applies to --tag deferred",
      );
    }
  } else {
    if (options.finding !== undefined) {
      throw new CliUsageError("--finding only applies to triage reply");
    }
    if (options.tag !== undefined) {
      throw new CliUsageError("--tag only applies to triage reply");
    }
    if (options.bodyFile !== undefined) {
      throw new CliUsageError("--body-file only applies to triage reply");
    }
    if (options.verdict !== undefined) {
      throw new CliUsageError("--verdict only applies to triage reply");
    }
    if (options.issue !== undefined) {
      throw new CliUsageError("--issue only applies to triage reply");
    }
  }
  if (command === "config" && options.configSubcommand !== undefined) {
    options.configLayer = options.configLayer ?? "person";
  }
  return { command, options };
}

function applyValueFlag(
  options: CliOptions,
  flag: string,
  value: string,
): void {
  switch (flag) {
    case "--repo":
      options.repo = value;
      return;
    case "--base":
      options.base = value;
      return;
    case "--head":
      options.head = value;
      return;
    case "--agents":
      options.agents = value;
      return;
    case "--out":
      options.out = value;
      return;
    case "--gotchas":
      options.gotchas = value;
      return;
    case "--config":
      options.config = value;
      return;
    case "--model":
      options.model = value;
      return;
    case "--scout-model":
      options.scoutModel = value;
      return;
    case "--runs":
      options.runs = value;
      return;
    case "--from":
      options.from = value;
      return;
    case "--interval": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--interval must be a positive integer (minutes), got: ${value}`,
        );
      }
      options.interval = parsed;
      return;
    }
    // >= 0, unlike every other numeric flag here: 0 is the documented
    // "disable this limit" value, not a nonsense input.
    case "--max-changed-lines":
      options.maxChangedLines = parseLimit(flag, value);
      return;
    case "--max-changed-files":
      options.maxChangedFiles = parseLimit(flag, value);
      return;
    // Unlike parseLimit (integer-only, size-gate's line/file counts):
    // spend is a float ($7.50), and <= 0 is a real, meaningful value (see
    // ci/gates.ts's evaluateBudgetGate) rather than a rejected input, so this
    // only refuses non-numbers, never negatives.
    case "--budget-usd": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new CliUsageError(`--budget-usd must be a number, got: ${value}`);
      }
      options.budgetUsd = parsed;
      return;
    }
    case "--ci-mode": {
      if (value !== "gate" && value !== "advisory") {
        throw new CliUsageError(
          `--ci-mode must be gate or advisory, got: ${value}`,
        );
      }
      options.ciMode = value;
      return;
    }
    case "--finding":
      options.finding = value;
      return;
    case "--tag": {
      if (
        value !== "applied" &&
        value !== "dismissed" &&
        value !== "deferred" &&
        value !== "misclassified"
      ) {
        throw new CliUsageError(
          `--tag must be applied, dismissed, deferred or misclassified, ` +
            `got: ${value}`,
        );
      }
      options.tag = value;
      return;
    }
    case "--body-file":
      options.bodyFile = value;
      return;
    case "--verdict": {
      if (
        value !== "upheld" &&
        value !== "rejected" &&
        value !== "inconclusive"
      ) {
        throw new CliUsageError(
          `--verdict must be upheld, rejected or inconclusive, got: ${value}`,
        );
      }
      options.verdict = value;
      return;
    }
    // Kept as a raw string and handed to `git log --since=` verbatim: git's
    // date parser is the authority on what "24 months ago" means, and a
    // validator here could only be a worse second opinion. It MUST have its
    // own case — the switch's `default:` is --hop-budget's integer parser,
    // so a missing case would reject a perfectly good date with an error
    // naming a flag the operator never typed.
    case "--since":
      options.since = value;
      return;
    // Kept verbatim, exactly like --since: the 1..90 range rule belongs to
    // validateProximityDays in corpus/preflight.ts, next to the join that
    // consumes the number — an integer parser HERE would be a second opinion
    // the shell's validator contradicts. Same own-case reasoning as --since
    // (the switch's `default:` is --hop-budget's integer parser).
    case "--proximity-days":
      options.proximityDays = value;
      return;
    // Also verbatim: splitBugLabels owns the trim/dedupe rules, and the csv
    // must survive byte-for-byte so error messages can quote what was typed.
    case "--bug-labels":
      options.bugLabels = value;
      return;
    case "--issue": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--issue must be a positive integer, got: ${value}`,
        );
      }
      options.issue = parsed;
      return;
    }
    case "--socket":
      options.socket = value;
      return;
    case "--db":
      options.db = value;
      return;
    case "--kill": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--kill must be a positive integer (PID), got: ${value}`,
        );
      }
      options.kill = parsed;
      return;
    }
    default: {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--hop-budget must be a positive integer, got: ${value}`,
        );
      }
      options.hopBudget = parsed;
    }
  }
}

function parseLimit(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliUsageError(
      `${flag} must be a non-negative integer (0 disables the limit), ` +
        `got: ${value}`,
    );
  }
  return parsed;
}

export type BaseRefSource = "flag" | "config" | "remote" | "fallback";

export interface BaseRefResolution {
  ref: string;
  source: BaseRefSource;
}

// C5 §3.6: `"config"` is RETIRED. Two files can carry `agents_dir` now, and
// one label covering both would tell the operator the value came from "the
// config" while leaving them to guess which of two files to open — for the
// single biggest spend lever in the file, whose prompt-set frontmatter picks
// every hunter's model.
export type AgentsDirSource = "flag" | "repo" | "global" | "env" | "default";

// What `dir` MEANS depends on `kind`, and the two cases are not
// interchangeable. A Bun-compiled binary embeds every prompt at a hashed,
// FLATTENED path (`/$bunfs/root/review-refuter-qkhw7k00.md`), and its
// containing "directory" is not one: `existsSync("/$bunfs/root")` is false and
// `Bun.Glob().scan({cwd})` on it THROWS ENOENT rather than yielding nothing.
// Only `Bun.file(<embedded path>)` reads. So in compiled mode there is no
// directory to join a basename onto — there is a MAP, and `dir` degrades to a
// display label for the plan card and the config row.
export interface AgentsDirResolution {
  // A real directory when `kind === "dir"`; a DISPLAY LABEL when `"bundled"`.
  // Never `/$bunfs/root`: that string is actionable to nobody and would name a
  // path that exists on no machine in every artifact it reached.
  dir: string;
  source: AgentsDirSource;
  kind: "dir" | "bundled";
  // Logical filename -> readable path. Present iff `kind === "bundled"`.
  files?: Record<string, string>;
}

// The label the shipped binary shows wherever a prompt-set path would go.
// A constant rather than a literal per site because `pr-hero init` already
// prints this exact wording for the same concept, and two copies drift the
// first time one of them is edited.
export const BUNDLED_AGENTS_DIR_LABEL = "bundled default (from engine)";

// THE read site for every agent file, and the reason it exists is that
// `path.join(agentsDir, agent.file)` is unfixable under compiled mode: the
// embedded name is hashed, so the logical basename joined onto anything names
// a file that does not exist. Callers ask this instead and never see the
// difference.
export function agentFilePath(
  resolution: Pick<AgentsDirResolution, "kind" | "dir" | "files">,
  file: string,
): string {
  if (resolution.kind === "bundled") {
    const embedded = resolution.files?.[file];
    if (embedded === undefined) {
      // A spec that names a prompt the build never embedded is a BUILD defect,
      // and it has to say so. Falling back to a join would hand the reader
      // "/$bunfs/root/<file>" — a path that reads plausibly, exists nowhere,
      // and sends them hunting a filesystem bug instead of a manifest gap.
      throw new Error(
        `the bundled prompt set has no "${file}" — the review spec references ` +
          "a prompt this build did not embed (asset-manifest.ts and the spec " +
          "have drifted)",
      );
    }
    return embedded;
  }
  return path.join(resolution.dir, file);
}

// The config seat as ONE object rather than three loose optionals. A value,
// the layer that spoke it, and the directory that value is relative TO are a
// single fact: split apart, a caller can hand over the GLOBAL file's
// `agents_dir` with the REPO's `.prhero/` as its base, which resolves a
// relative path against a directory the value never lived in and then labels
// the result `repo`. Grouped, that mistake does not type-check — which is the
// only mitigation available, because the two are both `string` and tsc cannot
// otherwise tell them apart (judgment ledger JD-14).
export interface AgentsDirConfigSeat {
  value: string;
  // Read off mergeConfig's source record by `agentsDirSeat` below: the merge
  // is the only thing that knows which layer won.
  layer: Extract<ConfigSource, "repo" | "global">;
  // The directory the RELATIVE case resolves against — the dirname of the
  // file `layer` names, never cwd and never the other layer's.
  dir: string;
}

// WHY `agents_dir` belongs in the config at all: requiring a flag that points
// into a SIBLING repository is the single thing that stopped this from being a
// one-word command inside the repo being reviewed. Recorded once in
// .prhero/config.json, `pr-hero review` needs no arguments.
//
// The relative case resolves against the CONFIG FILE's directory, not cwd: the
// config is the thing that names the path, so the path travels with it. A
// cwd-relative reading would make the same config mean different prompt sets
// depending on which subdirectory the developer happened to be standing in.
// After C5 "the config file" is whichever LAYER won, which is why the seat
// carries its own directory instead of taking one from the caller's context.
export function resolveAgentsDirSetting(input: {
  flag?: string | undefined;
  config?: AgentsDirConfigSeat | undefined;
  env?: string | undefined;
  cwd: string;
  // The runtime's packaged assets, injected. NOT a convenience: the real
  // `detectAssetMode()` reads `import.meta.dir`, which under `bun test` always
  // reports "dev", so the compiled branch below is unreachable from a test
  // without this seam — which is exactly how a shipped binary that could not
  // load a single prompt kept an entire offline suite green. Resolved lazily
  // inside the default branch so an explicit flag, config or env never pays
  // for asset detection.
  assets?: EngineAssets | undefined;
}): AgentsDirResolution {
  if (input.flag) {
    return {
      dir: path.resolve(input.cwd, input.flag),
      source: "flag",
      kind: "dir",
    };
  }
  if (input.config) {
    return {
      dir: path.resolve(input.config.dir, input.config.value),
      source: input.config.layer,
      kind: "dir",
    };
  }
  if (input.env) {
    return {
      dir: path.resolve(input.cwd, input.env),
      source: "env",
      kind: "dir",
    };
  }
  const assets = input.assets ?? resolveEngineAssets();
  // The compiled binary's default set is a MAP, never a directory: its
  // `defaultAgentsDir` is `path.dirname(<embedded path>)`, i.e. "/$bunfs/root",
  // which no `existsSync` accepts and no `Bun.Glob` can scan. Handing that
  // string on as a directory is the whole defect — every consumer downstream
  // would join a logical basename onto it and read a file that is not there.
  if (assets.mode === "compiled") {
    return {
      dir: BUNDLED_AGENTS_DIR_LABEL,
      source: "default",
      kind: "bundled",
      files: assets.bundledAgentFiles,
    };
  }
  return {
    dir: assets.defaultAgentsDir,
    source: "default",
    kind: "dir",
  };
}

// The seat, assembled from the merge's own source record. THIS is the one
// place that record is load-bearing at RUNTIME rather than for display
// (judgment ledger JD-14): a relative `"agents_dir": "./prompts"` in the
// global file must resolve under `~/.prhero/`, while the same string in the
// repo file resolves under `<repo>/.prhero/`. They are two different prompt
// sets — one the operator's, one the team's — and resolving the global value
// against the repo's directory picks a set nobody configured, or throws
// "agents dir does not exist" naming a path that appears in neither file.
//
// Pure and here rather than in the shell for CLAUDE.md's split: the FILES are
// the shell's business, the decision of which of them a value belongs to is
// not, and it is the half that has to be provable offline.
export function agentsDirSeat(input: {
  config: Pick<LocalConfig, "agents_dir">;
  sources: Pick<ConfigSources, "agents_dir">;
  repoConfigPath: string;
  globalConfigPath: string;
}): AgentsDirConfigSeat | undefined {
  const value = input.config.agents_dir;
  if (value === undefined) return undefined;
  // `agents_dir` is a `person` key, so `capped` cannot occur, and `default`
  // cannot occur for a value some layer demonstrably spoke. Everything that
  // is not `global` is therefore the repo file — written as the remainder
  // rather than as a second equality so a direction change cannot land the
  // value in a branch that silently drops it.
  const fromGlobal = input.sources.agents_dir === "global";
  return {
    value,
    layer: fromGlobal ? "global" : "repo",
    dir: path.dirname(
      fromGlobal ? input.globalConfigPath : input.repoConfigPath,
    ),
  };
}

export function emptyDiffMessage(
  baseRef: string,
  headRef: string,
  twoDot: boolean,
): string {
  return (
    `the diff ${baseRef}${twoDot ? ".." : "..."}${headRef} is empty; there ` +
    "is nothing to review. The usual cause is that head is already contained " +
    "in base (an already-merged branch), or that the branch's changes were " +
    "reverted."
  );
}

// The other empty diff: the range had changes, but every one of them was in a
// generated file the size gate excludes, so the EFFECTIVE diff — the one the
// hunters would be handed — is empty. Treated exactly like the empty-range
// case above rather than spawning hunters on an empty patch: three sessions
// reading nothing is a bill for no review at all.
export function allExcludedMessage(droppedPaths: string[]): string {
  return (
    `every changed file is excluded from review ` +
    `(${listPaths(droppedPaths)}), so the effective diff is empty and there ` +
    "is nothing to review. Nothing was spawned and nothing was spent."
  );
}

export interface NumstatDiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface NumstatFile {
  // The DESTINATION path — see resolveNumstatPath.
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

// `git diff --numstat` emits `<added>\t<deleted>\t<path>` per file, and for a
// binary file both counters are a literal `-`. A binary file is still a
// changed file (it counts toward `files`) but contributes no lines — reading
// `-` as NaN would poison the whole cost estimate.
export function parseNumstatFiles(raw: string): NumstatFile[] {
  const out: NumstatFile[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    // The path field may itself contain tabs only in quoted form, which git
    // escapes; joining the remainder keeps such a path whole instead of
    // truncating it at the first tab.
    const rawPath = fields.slice(2).join("\t");
    out.push({
      path: resolveNumstatPath(rawPath),
      insertions: countField(fields[0]),
      deletions: countField(fields[1]),
      binary: fields[0] === "-" && fields[1] === "-",
    });
  }
  return out;
}

// A rename does NOT arrive as a plain path. git renders it either whole
// (`old/name => new/name`) or with the common prefix/suffix factored out
// (`src/{old => new}/file.ts`, and the one-sided `src/{ => sub}/file.ts` /
// `src/{old => }/file.ts`). WHY resolving to the DESTINATION matters: every
// consumer here matches the path against globs, and `src/{a => b}/x.min.js`
// matches no exclusion pattern at all — a renamed lockfile would silently
// stop being excluded and push a small PR over the gate.
//
// The SAME globs also meet git's C-quoting, which `core.quotepath` leaves on by
// default for any non-ASCII path (`"canci\303\263n.min.js"`): the leading quote
// makes every pattern miss. Found by pr-hero reviewing its own PR #1 — the patch
// filter unquoted and this did not, so an excluded file vanished from
// diff.patch while its lines stayed in the count. Unquote LAST: git quotes only
// the side that needs it (`a.min.js => "canci\303\263n.min.js"`), so unquoting
// before resolving is a no-op that leaves the destination still quoted.
function resolveNumstatPath(field: string): string {
  return unquotePath(resolveRenameField(field));
}

function resolveRenameField(field: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(field);
  if (braced !== null) {
    // The one-sided forms leave an empty segment behind (`src/` + `` +
    // `/file`), so collapse the doubled separator the substitution creates.
    return collapseSeparators(`${braced[1]}${braced[3]}${braced[4]}`);
  }
  const arrow = field.indexOf(" => ");
  return arrow === -1 ? field : field.slice(arrow + 4);
}

function collapseSeparators(p: string): string {
  return p.replace(/\/{2,}/g, "/");
}

// The aggregate view, a pure sum over the per-file one: two parsers of the
// same format would drift, and the cost estimate and the size gate must
// never disagree about how big a diff is.
export function parseNumstat(raw: string): NumstatDiffStat {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const file of parseNumstatFiles(raw)) {
    files++;
    insertions += file.insertions;
    deletions += file.deletions;
  }
  return { files, insertions, deletions };
}

function countField(field: string | undefined): number {
  const parsed = Number(field);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function runDirCandidate(
  root: string,
  headSha: string,
  n: number,
): string {
  return path.join(root, `${headSha.slice(0, 8)}-${n}`);
}

export function assertOutsideRepo(runDir: string, repoRoot: string): void {
  const resolvedRun = path.resolve(runDir);
  const resolvedRepo = path.resolve(repoRoot);
  if (
    resolvedRun === resolvedRepo ||
    resolvedRun.startsWith(`${resolvedRepo}${path.sep}`)
  ) {
    throw new CliUsageError(
      `run dir ${resolvedRun} is inside the reviewed repo ${resolvedRepo}. ` +
        "Prompts and artifacts written inside the tree show up in the " +
        "hunters' own Grep results and contaminate the review — pick a " +
        "--out outside the repo.",
    );
  }
}

// repoId rides along with the run dir so the caller's fail-soft metrics
// ingest (W4 / #23) can reuse the SAME resolveRepoHome call below instead of
// paying for a second gitOriginUrl lookup. --out still skips resolveRepoHome
// itself (an explicit dir needs no ~/.prhero/repos/<id> registry, and must
// never gain the side effect of creating one just to learn an id — W4 Phase
// 6 remediation, GitHub #23 option D) — but it now tries origin via
// tryOriginRepoId (persist:false semantics) so a --out run on a checkout
// WITH a resolvable origin still ingests. repoId is null only when that
// origin lookup itself fails — the same no-origin escape hatch every other
// global-state path already has, never a throw.
export async function createRunDir(
  options: CliOptions,
  repoRoot: string,
  headSha: string,
): Promise<{ runDir: string; repoId: string | null }> {
  if (options.out) {
    const explicit = path.resolve(options.out);
    assertOutsideRepo(explicit, repoRoot);
    await mkdir(explicit, { recursive: true });
    const { tryOriginRepoId } = await import("../home");
    return { runDir: explicit, repoId: await tryOriginRepoId(repoRoot) };
  }
  const { resolveRepoHome } = await import("../home");
  const repoHome = await resolveRepoHome({
    home: os.homedir(),
    operatorRoot: repoRoot,
    persist: true,
  });
  const root = repoHome.paths.runs;
  // Smallest unused integer, so a second review of the same commit never
  // overwrites the first one's artifacts — a run that cost money is evidence.
  for (let n = 1; ; n++) {
    const candidate = runDirCandidate(root, headSha, n);
    if (existsSync(candidate)) continue;
    assertOutsideRepo(candidate, repoRoot);
    await mkdir(candidate, { recursive: true });
    return { runDir: candidate, repoId: repoHome.repoId };
  }
}

// Threat matrix, ported from the lab: a ReviewSpec's `file` values name the
// .md files that become the SYSTEM PROMPTS of spawned sessions. A basename
// that escapes agentsDir (separator, `..`, or an absolute path) must fail
// loud before any spawn, never be silently joined against a location the
// caller did not choose.
export function assertBasenameOnly(file: string, index: number): void {
  if (
    file.includes("/") ||
    file.includes("\\") ||
    file.includes("..") ||
    path.isAbsolute(file)
  ) {
    throw new CliUsageError(
      `spec.agents[${index}].file must be a plain basename (no "/", "\\", ` +
        `"..", or absolute paths), got: ${JSON.stringify(file)}`,
    );
  }
}

export const AGENT_FILE_PATTERNS = ["deep-review-*.md", "review-*.md"];

// BIDIRECTIONAL on purpose, and this is the check that pays for itself. The
// default spec declares four agents and omits the lifecycle hunter, so
// running the 5-file clean set with that spec silently drops the one hunter
// the whole campaign is about — the run completes, the artifacts validate,
// the cost looks normal, and nothing downstream notices. So: every file the
// spec names must exist, AND every agent file present must be named.
export function agentsDirProblems(
  specFiles: string[],
  presentFiles: string[],
): string[] {
  const problems: string[] = [];
  const present = new Set(presentFiles);
  const named = new Set(specFiles);
  for (const file of named) {
    if (!present.has(file)) {
      problems.push(
        `the spec references "${file}" but the dir does not have it`,
      );
    }
  }
  for (const file of presentFiles) {
    if (!named.has(file)) {
      problems.push(
        `the dir has "${file}" but no agent in the spec references it ` +
          "(it would never run)",
      );
    }
  }
  return problems.sort();
}

// The impure half of the agents-dir chain: the seat's `configDir` is the
// dirname of the file the WINNING layer lives in (agentsDirSeat, JD-14), and
// only the existence check below touches the disk.
export function resolveAgentsDir(
  // Narrowed to what it actually reads: `--agents` is the only flag in play,
  // and a wider type would let a caller believe this consults others.
  options: Pick<CliOptions, "agents">,
  loaded: EffectiveConfig,
  // Injected only by tests, which cannot otherwise reach the compiled branch:
  // detectAssetMode() reads `import.meta.dir` and always reports "dev" under
  // `bun test`.
  assets?: EngineAssets,
): AgentsDirResolution {
  const seat = agentsDirSeat({
    config: loaded.effective,
    sources: loaded.sources,
    repoConfigPath: loaded.repoConfigPath,
    globalConfigPath: loaded.globalConfigPath,
  });
  const resolution = resolveAgentsDirSetting({
    flag: options.agents,
    ...(seat === undefined ? {} : { config: seat }),
    env: process.env.PRHERO_AGENTS_DIR,
    cwd: process.cwd(),
    ...(assets === undefined ? {} : { assets }),
  });
  // Only a DIRECTORY can be checked for existence, and this gate running
  // unconditionally is the whole shipped defect: the compiled binary's bundled
  // set has no directory, `existsSync` on the embedded root is false, and every
  // run of the released binary died here with "agents dir does not exist"
  // before a single step spawned. A bundled set's conformance is checked by
  // preflightAgentsDir over the manifest's keys instead.
  if (resolution.kind === "dir" && !existsSync(resolution.dir)) {
    throw new CliError(`agents dir does not exist: ${resolution.dir}`, {
      cls: { kind: "prompt-set" },
    });
  }
  return resolution;
}

export async function preflightAgentsDir(
  agents: Pick<AgentsDirResolution, "kind" | "dir" | "files">,
  specFiles: string[],
): Promise<void> {
  const present = new Set<string>();
  if (agents.kind === "bundled") {
    // The manifest's keys ARE the present set, and there is nothing to scan:
    // Bun.Glob().scan() over the embedded root THROWS ENOENT rather than
    // yielding nothing, so a bundled set reaching the glob below is not a
    // degraded check but a crash. Key ORDER is irrelevant here — unlike the
    // fingerprint, agentsDirProblems compares sets bidirectionally.
    for (const file of Object.keys(agents.files ?? {})) present.add(file);
  } else {
    for (const pattern of AGENT_FILE_PATTERNS) {
      for await (const entry of new Bun.Glob(pattern).scan({
        cwd: agents.dir,
      })) {
        present.add(entry);
      }
    }
  }
  const problems = agentsDirProblems(specFiles, [...present]);
  if (problems.length > 0) {
    throw new CliError(
      `prompt set ${agents.dir} does not match the review spec:\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
      { cls: { kind: "prompt-set" } },
    );
  }
}

// EXPERIMENT (odd/tasks/logic-hunter.md T3): benchmark-only hunter fan-out,
// parsed once at localReviewSpec()'s call site below and INERT when unset —
// no other caller of this env var exists anywhere in production wiring.
// Format: "key:file[,key:file...]", e.g.
// "logic:deep-review-logic.md,reliability-b:deep-review-reliability.md" (a
// second leg on an EXISTING hunter file, distinguished only by key). Strict
// on purpose: a malformed value must fail loud rather than silently run
// fewer hunters than the operator asked for.
function parseExtraHunters(raw: string | undefined): AgentSpec[] {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map((rawEntry, i) => {
    const entry = rawEntry.trim();
    const sep = entry.indexOf(":");
    if (sep <= 0 || sep === entry.length - 1) {
      throw new CliUsageError(
        `PRHERO_EXTRA_HUNTERS[${i}] must be "key:file.md", got: ${JSON.stringify(rawEntry)}`,
      );
    }
    const key = entry.slice(0, sep).trim();
    const file = entry.slice(sep + 1).trim();
    if (!isSafeSlug(key)) {
      throw new CliUsageError(
        `PRHERO_EXTRA_HUNTERS[${i}].key "${key}" is not a safe slug ` +
          "(^[a-z0-9]+(?:-[a-z0-9]+)*$, 1-64 chars)",
      );
    }
    if (!file.endsWith(".md") || file.length <= ".md".length) {
      throw new CliUsageError(
        `PRHERO_EXTRA_HUNTERS[${i}].file "${file}" must be a ".md" basename`,
      );
    }
    assertBasenameOnly(file, i);
    return { key, file, role: "hunter" as const };
  });
}

// Local mode's wiring: the four unconditional hunters, the conditional
// parity hunter, and the refuter. Deliberately NOT defaultReviewSpec() — that
// one omits the lifecycle and logic hunters, and local mode targets the 6-file
// clean set. Hunter keys stay inside the findings-schema v1.1.0 Hunter/specialty
// set, which validateReviewSpec enforces.
//
// `env` is injectable (defaults to `process.env`) so PRHERO_EXTRA_HUNTERS can
// be exercised offline without mutating the real environment — same pattern
// as ui/primitives.ts's styleEnabled(). Unset or empty, this function returns
// byte-identical output to before T3 (test/review/preflight.test.ts pins it).
export function localReviewSpec(
  env: Record<string, string | undefined> = process.env,
): ReviewSpec {
  return {
    agents: [
      {
        key: "reliability",
        file: "deep-review-reliability.md",
        role: "hunter",
      },
      { key: "resilience", file: "deep-review-resilience.md", role: "hunter" },
      { key: "lifecycle", file: "deep-review-lifecycle.md", role: "hunter" },
      { key: "logic", file: "deep-review-logic.md", role: "hunter" },
      {
        key: "parity",
        file: "deep-review-parity.md",
        role: "hunter",
        trigger: "input",
      },
      // The boundary, not the three throws: assertBasenameOnly inside
      // parseExtraHunters is a fourth usage throw of the same parse (T2d-1).
      ...withUsageClass({ kind: "config-parse", source: "extra-hunters" }, () =>
        parseExtraHunters(env.PRHERO_EXTRA_HUNTERS),
      ),
      { key: "refuter", file: "review-refuter.md", role: "refuter" },
    ],
  };
}

export type ConfigDirection = "person" | "repo" | "capped";

// Declared per key, and this table IS the known-key set for both parsers and
// the merge — both derive from it below rather than restating it, because a
// second hand-written key list is how the table and the parser drift apart
// with nothing firing. A key added to LocalConfig without a row here fails
// tsc: an undeclared direction is a bug, never a silent default.
//
// The `capped` rows exist because the spend rule the watcher writes down
// (src/watch/preflight.ts:43-47) is DIRECTIONAL: the danger is a committed
// repo file enlarging the OPERATOR's bill, never the reverse. Plain
// specificity cannot express that asymmetry — "repo wins" lets a team raise
// my bill, "person wins" forbids a team from being more frugal.
export const CONFIG_DIRECTION: Record<keyof LocalConfig, ConfigDirection> = {
  agents_dir: "person",
  // `repo`, and this is the one that costs money if it is wrong:
  // resolveBaseRef checks the config value BEFORE the remote head, so a
  // global default_base would sit ahead of an autodetection that already
  // solves the common case for free. Every quiet repo whose default branch
  // differs would review the wrong range with a plausible branch name on the
  // plan card — verbatim the "wrong answer with a plausible face" failure the
  // comment at the top of this file names.
  default_base: "repo",
  // The values are paths INSIDE one repository. A global answer is meaningless
  // everywhere else and would silently arm or disarm the parity hunter across
  // every repo on the machine.
  parity_trigger_paths: "repo",
  suspicion_priors: "repo",
  // Per-field below — the two fields disagree, which is why SUMMARY_DIRECTION
  // exists. This row declares the key for the known-key set; the merge
  // descends into it rather than folding the object whole.
  summary: "capped",
  routing: "person",
  max_verification_steps: "capped",
  max_concurrent_steps: "capped",
  max_changed_lines: "capped",
  max_changed_files: "capped",
  scout: "capped",
  post: "capped",
  ci_review_policy: "repo",
  ci_max_attempts: "repo",
  ci_max_reviews: "repo",
  ci_rereview_min_score: "repo",
  ci_blocking_weight: "repo",
  ci_advisory_weight: "repo",
  ci_trusted_actors: "repo",
  ci_admission_observe_only: "repo",
};

// The ONE nested key, so this is a second table and not a pattern. `enabled`
// takes the cap because it switches spend on; `model` cannot be capped even
// in principle — "narrower" is undefinable for a string, and a direction that
// cannot be computed is worse than no direction at all.
export const SUMMARY_DIRECTION: Record<keyof SummaryConfig, ConfigDirection> = {
  enabled: "capped",
  model: "person",
};

export interface LocalConfig {
  parity_trigger_paths: string[];
  suspicion_priors: SuspicionPrior[];
  // Both optional, and both exist to make `pr-hero review` a zero-flag
  // command: the prompt set lives in a sibling repo, and the default branch is
  // a property of THIS repo that no constant can know.
  agents_dir?: string;
  default_base?: string;
  summary?: SummaryConfig;
  routing?: RoutingConfig;
  // Item 7: unattended bound on the verify queue. Absent means
  // DEFAULT_MAX_VERIFICATION_STEPS. 0 is legal — every queued prior lands
  // `unconfirmed` (the pause switch, same shape as watch daily_cap).
  max_verification_steps?: number;
  // Admission cap on in-flight steps (hunter, refuter, verify, adjudicate,
  // scout, summarizer attempts). Absent means unlimited: no gate is built.
  // Positive only: 0 would admit nothing and wedge every run.
  max_concurrent_steps?: number;
  max_changed_lines?: number;
  max_changed_files?: number;
  scout?: boolean;
  post?: boolean;
  // CI admission: when to spend on a synchronize push (see ci/review-admission.ts).
  ci_review_policy?: CiReviewPolicyMode;
  ci_max_attempts?: number;
  ci_max_reviews?: number;
  ci_rereview_min_score?: number;
  ci_blocking_weight?: number;
  ci_advisory_weight?: number;
  ci_trusted_actors?: string[];
  // When true, admission still evaluates and logs the would-be decision but
  // never suppresses a review (Phase 1 rollout — observe-only).
  ci_admission_observe_only?: boolean;
}

export interface SummaryConfig {
  enabled?: boolean;
  model?: string;
}

export interface SummarySettings {
  enabled: boolean;
  model?: string;
}

export const EMPTY_LOCAL_CONFIG: LocalConfig = {
  parity_trigger_paths: [],
  suspicion_priors: [],
};

// What a layer SAID, not what the engine will use — every key optional,
// including the two arrays LocalConfig declares required.
//
// WHY the distinction is load-bearing rather than cosmetic: a merge whose
// input cannot represent absence has already destroyed the fact it needs to
// fold on. Under LocalConfig a repo file that omits `parity_trigger_paths`
// hands the merge a materialised `[]`, the fold sees the repo layer speak,
// and provenance reports `repo` for a value that file never named. That is a
// lie in pipeline.json and in `pr-hero config`, and no amount of care in the
// merge can recover the bit the parser threw away.
//
// LocalConfig itself is unchanged: it is the EFFECTIVE config, the single
// shape the resolvers receive, produced once at the end of mergeConfig.
export type ConfigLayer = Partial<LocalConfig>;

// Derived, never restated: D2's "the table IS the known-key set" is only true
// if the parsers actually read the table. `Object.keys` rather than `in`,
// because `in` would admit `toString` and every other prototype member as a
// known key.
const KNOWN_CONFIG_KEYS = new Set<string>(Object.keys(CONFIG_DIRECTION));

const LOCAL_CONFIG_KEYS = new Set<string>(
  Object.keys(CONFIG_DIRECTION).filter((key) => key !== "routing"),
);

const GLOBAL_CONFIG_KEYS = new Set<string>(
  Object.keys(CONFIG_DIRECTION).filter(
    (key) => CONFIG_DIRECTION[key as keyof LocalConfig] !== "repo",
  ),
);

// The two file labels every rejection is templated over. A shared validator
// that hardcodes one file name sends the operator to edit the wrong file the
// moment the other file is the malformed one.
const REPO_CONFIG_LABEL = ".prhero/config.json";
const GLOBAL_CONFIG_LABEL = "~/.prhero/config.json";

// `.prhero/config.json` is optional and every setting inside it is optional —
// an absent config is a legal, complete configuration (parity simply never
// fires, while summary activation is resolved by resolveSummary). What is NOT
// tolerated is a malformed one: a typo'd key silently
// read as "no triggers" is exactly how the parity hunter stops firing without
// anyone noticing, so shape violations throw.
// WHY summary defaults on: it is the first defaulted setting that spends
// money, and a silent opt-out would make a normal review's bill differ from
// the plan. `--no-summary` and `summary.enabled: false` are the explicit exits.
//
// WHY it returns a ConfigLayer and no longer materialises the two arrays: the
// return object used to write `parity_trigger_paths` and `suspicion_priors`
// unconditionally, because LocalConfig required them. That destroyed the
// difference between "the file said []" and "the file never mentioned it" —
// and the merge downstream can only report truthful provenance for a key it
// can still see was absent. The `?? []` locals below stay exactly as they
// are: they feed the validators, and validating an absent key against the
// empty array is what keeps every error string byte-identical.
// The repo layer's usage errors carry the repo-config class (T2d-1). It passes the
// classed routing parser for symmetry only: `routing` is not a repo key, so the file is
// rejected as a per-person key before any routing value is parsed. The person layer's
// errors carry no class (see parseGlobalConfig).
export function parseLocalConfig(raw: string): ConfigLayer {
  return withUsageClass({ kind: "config-parse", source: "repo-config" }, () =>
    parseConfigLayer(
      raw,
      REPO_CONFIG_LABEL,
      LOCAL_CONFIG_KEYS,
      parseRoutingConfig,
    ),
  );
}

// The global layer's parser: same JSON dialect, same validators, same strict
// unknown-key rejection — it differs only in which keys it admits and in the
// file it names. It admits every key whose direction is not `repo`, and
// rejects the three that are, because no global answer to them could be
// right: two are lists of paths inside one repository and the third selects a
// commit range ahead of an autodetection that already works.
// Its routing object is parsed without the routing class. That class renders
// PRH-ROUTING-INVALID, whose text names PRHERO_ROUTING and `gh variable set`: the
// fix for the CI routing input, not for this personal file. The message is the same.
export function parseGlobalConfig(raw: string): ConfigLayer {
  return parseConfigLayer(
    raw,
    GLOBAL_CONFIG_LABEL,
    GLOBAL_CONFIG_KEYS,
    parseRoutingValue,
  );
}

// `??` is what makes an explicit `null` mean "absent" for the two arrays, and
// the returned layer has to agree with it: `{"suspicion_priors": null}`
// validates as the empty array, so it must not claim the layer spoke either.
function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function parseOptionalBoolean(
  value: unknown,
  key: string,
  file: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new CliUsageError(`${file} ${key} must be a boolean`);
  }
  return value;
}

// `parseRouting` is the layer's routing parser: the classed one for the repo file, the
// unclassed one for the person file (see parseGlobalConfig for why it differs).
function parseConfigLayer(
  raw: string,
  file: string,
  admitted: ReadonlySet<string>,
  parseRouting: typeof parseRoutingConfig,
): ConfigLayer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `${file} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(`${file} must be a JSON object`);
  }
  const config = parsed as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      throw new CliUsageError(`${file} unknown key: ${redactDiagnostic(key)}`);
    }
    // Templated over the OFFENDING key, never a fixed example: one hardcoded
    // key name across three rejections sends two operators out of three
    // looking for the wrong line in their config.
    if (!admitted.has(key)) {
      if (file === REPO_CONFIG_LABEL) {
        throw new CliUsageError(
          `${file}: ${key} is a per-person key — put it in ` +
            "~/.prhero/config.json",
        );
      }
      throw new CliUsageError(
        `${file}: ${key} is a per-repo key — put it in ` +
          "<repo>/.prhero/config.json",
      );
    }
  }
  const triggers = config.parity_trigger_paths ?? [];
  if (
    !Array.isArray(triggers) ||
    !triggers.every((p) => typeof p === "string" && p.length > 0)
  ) {
    throw new CliUsageError(
      `${file} parity_trigger_paths must be an array of non-empty strings`,
    );
  }
  const priors = config.suspicion_priors ?? [];
  if (!Array.isArray(priors)) {
    throw new CliUsageError(`${file} suspicion_priors must be an array`);
  }
  for (const [i, entry] of priors.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new CliUsageError(`suspicion_priors[${i}] must be an object`);
    }
    const prior = entry as Record<string, unknown>;
    if (typeof prior.path !== "string" || prior.path.length === 0) {
      throw new CliUsageError(`suspicion_priors[${i}].path required`);
    }
    if (typeof prior.weight !== "string" && typeof prior.weight !== "number") {
      throw new CliUsageError(
        `suspicion_priors[${i}].weight must be a string or a number`,
      );
    }
    if (typeof prior.reason !== "string" || prior.reason.length === 0) {
      throw new CliUsageError(`suspicion_priors[${i}].reason required`);
    }
  }
  const summary = parseSummaryConfig(config.summary, file);
  const routing = parseRouting(config.routing, file);
  const maxVerificationSteps = parseNonNegativeInteger(
    config.max_verification_steps,
    "max_verification_steps",
    file,
  );
  const maxConcurrentSteps = parsePositiveInteger(
    config.max_concurrent_steps,
    "max_concurrent_steps",
    file,
  );
  const maxChangedLines = parseNonNegativeInteger(
    config.max_changed_lines,
    "max_changed_lines",
    file,
  );
  const maxChangedFiles = parseNonNegativeInteger(
    config.max_changed_files,
    "max_changed_files",
    file,
  );
  const scout = parseOptionalBoolean(config.scout, "scout", file);
  const post = parseOptionalBoolean(config.post, "post", file);
  const ciReviewPolicy = parseCiReviewPolicyMode(config.ci_review_policy, file);
  const ciMaxAttempts = parseCiAdmissionInteger(
    config.ci_max_attempts,
    "ci_max_attempts",
    file,
    1,
  );
  const ciMaxReviews = parseCiAdmissionInteger(
    config.ci_max_reviews,
    "ci_max_reviews",
    file,
    1,
  );
  const ciRereviewMinScore = parseCiAdmissionInteger(
    config.ci_rereview_min_score,
    "ci_rereview_min_score",
    file,
    0,
  );
  const ciBlockingWeight = parseCiAdmissionInteger(
    config.ci_blocking_weight,
    "ci_blocking_weight",
    file,
    1,
  );
  const ciAdvisoryWeight = parseCiAdmissionInteger(
    config.ci_advisory_weight,
    "ci_advisory_weight",
    file,
    1,
  );
  const ciTrustedActors = config.ci_trusted_actors ?? [];
  if (
    !Array.isArray(ciTrustedActors) ||
    !ciTrustedActors.every((a) => typeof a === "string" && a.length > 0)
  ) {
    throw new CliUsageError(
      `${file} ci_trusted_actors must be an array of non-empty strings`,
    );
  }
  const ciAdmissionObserveOnly = parseOptionalBoolean(
    config.ci_admission_observe_only,
    "ci_admission_observe_only",
    file,
  );
  return {
    ...(given(config.parity_trigger_paths)
      ? { parity_trigger_paths: triggers as string[] }
      : {}),
    ...(given(config.suspicion_priors)
      ? { suspicion_priors: priors as SuspicionPrior[] }
      : {}),
    ...optionalString(config, "agents_dir", file),
    ...optionalString(config, "default_base", file),
    ...(summary === undefined ? {} : { summary }),
    ...(routing === undefined ? {} : { routing }),
    ...(maxVerificationSteps === undefined
      ? {}
      : { max_verification_steps: maxVerificationSteps }),
    ...(maxConcurrentSteps === undefined
      ? {}
      : { max_concurrent_steps: maxConcurrentSteps }),
    ...(maxChangedLines === undefined
      ? {}
      : { max_changed_lines: maxChangedLines }),
    ...(maxChangedFiles === undefined
      ? {}
      : { max_changed_files: maxChangedFiles }),
    ...(scout === undefined ? {} : { scout }),
    ...(post === undefined ? {} : { post }),
    ...(ciReviewPolicy === undefined
      ? {}
      : { ci_review_policy: ciReviewPolicy }),
    ...(ciMaxAttempts === undefined ? {} : { ci_max_attempts: ciMaxAttempts }),
    ...(ciMaxReviews === undefined ? {} : { ci_max_reviews: ciMaxReviews }),
    ...(ciRereviewMinScore === undefined
      ? {}
      : { ci_rereview_min_score: ciRereviewMinScore }),
    ...(ciBlockingWeight === undefined
      ? {}
      : { ci_blocking_weight: ciBlockingWeight }),
    ...(ciAdvisoryWeight === undefined
      ? {}
      : { ci_advisory_weight: ciAdvisoryWeight }),
    ...(ciTrustedActors.length > 0
      ? { ci_trusted_actors: ciTrustedActors as string[] }
      : {}),
    ...(ciAdmissionObserveOnly === undefined
      ? {}
      : { ci_admission_observe_only: ciAdmissionObserveOnly }),
  };
}

const CREDENTIAL_KEY_NAMES = new Set([
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "bearer",
  "auth",
  "credential",
  "credentials",
]);

function checkNoCredentials(
  obj: Record<string, unknown>,
  path: string,
  file: string,
): void {
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (
      CREDENTIAL_KEY_NAMES.has(lower) ||
      lower.includes("secret") ||
      lower.includes("password") ||
      lower.includes("token") ||
      lower.includes("apikey") ||
      lower.includes("api_key")
    ) {
      throw new CliUsageError(
        `${file} ${path}: credentials are not permitted in routing config`,
      );
    }
    const val = obj[key];
    if (typeof val === "string") {
      const redacted = redactDiagnostic(val);
      if (redacted !== val) {
        throw new CliUsageError(
          `${file} ${path}: credentials are not permitted in routing config`,
        );
      }
    }
  }
}

const KNOWN_ROUTE_MAPPING_KEYS = new Set([
  "logical",
  "backend",
  "provider",
  "gateway",
  "modelFamily",
  "modelSnapshot",
  "modelVariant",
  "disabled",
  "allowSpend",
]);

function parseRouteMapping(
  m: unknown,
  path: string,
  file: string,
): RouteMapping {
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    throw new CliUsageError(`${file} ${path} must be an object`);
  }
  const mapping = m as Record<string, unknown>;
  checkNoCredentials(mapping, path, file);

  for (const key of Object.keys(mapping)) {
    if (!KNOWN_ROUTE_MAPPING_KEYS.has(key)) {
      throw new CliUsageError(
        `${file} ${path} unknown key: ${redactDiagnostic(key)}`,
      );
    }
  }

  if (mapping.logical !== undefined) {
    if (
      typeof mapping.logical !== "string" ||
      mapping.logical.trim().length === 0
    ) {
      throw new CliUsageError(
        `${file} ${path}.logical must be a non-empty string`,
      );
    }
  }

  if (
    typeof mapping.backend !== "string" ||
    (mapping.backend !== "claude-code" && mapping.backend !== "opencode")
  ) {
    throw new CliUsageError(
      `${file} ${path}.backend must be claude-code|opencode`,
    );
  }

  if (
    typeof mapping.provider !== "string" ||
    mapping.provider.trim().length === 0
  ) {
    throw new CliUsageError(
      `${file} ${path}.provider must be a non-empty string`,
    );
  }

  if (mapping.gateway !== undefined) {
    if (
      typeof mapping.gateway !== "string" ||
      (mapping.gateway !== "configured" &&
        mapping.gateway !== "direct" &&
        mapping.gateway !== "openrouter")
    ) {
      throw new CliUsageError(
        `${file} ${path}.gateway must be configured|direct|openrouter`,
      );
    }
  }

  if (
    mapping.modelFamily !== undefined &&
    typeof mapping.modelFamily !== "string"
  ) {
    throw new CliUsageError(`${file} ${path}.modelFamily must be a string`);
  }
  if (
    mapping.modelSnapshot !== undefined &&
    typeof mapping.modelSnapshot !== "string"
  ) {
    throw new CliUsageError(`${file} ${path}.modelSnapshot must be a string`);
  }
  if (
    mapping.modelVariant !== undefined &&
    typeof mapping.modelVariant !== "string"
  ) {
    throw new CliUsageError(`${file} ${path}.modelVariant must be a string`);
  }
  if (mapping.disabled !== undefined && typeof mapping.disabled !== "boolean") {
    throw new CliUsageError(`${file} ${path}.disabled must be a boolean`);
  }
  if (
    mapping.allowSpend !== undefined &&
    typeof mapping.allowSpend !== "boolean"
  ) {
    throw new CliUsageError(`${file} ${path}.allowSpend must be a boolean`);
  }

  return {
    ...(mapping.logical ? { logical: mapping.logical as string } : {}),
    backend: mapping.backend as RunnerBackend,
    provider: mapping.provider as string,
    ...(mapping.gateway ? { gateway: mapping.gateway as ModelGateway } : {}),
    ...(mapping.modelFamily
      ? { modelFamily: mapping.modelFamily as string }
      : {}),
    ...(mapping.modelSnapshot
      ? { modelSnapshot: mapping.modelSnapshot as string }
      : {}),
    ...(mapping.modelVariant
      ? { modelVariant: mapping.modelVariant as string }
      : {}),
    ...(mapping.disabled !== undefined
      ? { disabled: mapping.disabled as boolean }
      : {}),
    ...(mapping.allowSpend !== undefined
      ? { allowSpend: mapping.allowSpend as boolean }
      : {}),
  };
}

// Every usage error of the routing object carries the routing class (T2d-1). The CI
// routing input (src/ci/setup.ts) keeps its own class and discards this one. The repo
// layer passes this parser too, but never reaches a routing value (see
// parseLocalConfig). The person layer calls parseRoutingValue directly, so its errors
// carry no class.
export function parseRoutingConfig(
  value: unknown,
  file: string,
): RoutingConfig | undefined {
  return withUsageClass({ kind: "config-parse", source: "routing" }, () =>
    parseRoutingValue(value, file),
  );
}

function parseRoutingValue(
  value: unknown,
  file: string,
): RoutingConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliUsageError(`${file} routing must be an object`);
  }
  const routing = value as Record<string, unknown>;
  checkNoCredentials(routing, "routing", file);

  for (const key of Object.keys(routing)) {
    if (key !== "mappings" && key !== "default" && key !== "disabled") {
      throw new CliUsageError(
        `${file} routing unknown key: ${redactDiagnostic(key)}`,
      );
    }
  }

  let mappings: RouteMapping[] | Record<string, RouteMapping> | undefined;
  if (routing.mappings !== undefined) {
    if (Array.isArray(routing.mappings)) {
      mappings = routing.mappings.map((m, i) =>
        parseRouteMapping(m, `routing.mappings[${i}]`, file),
      );
    } else if (
      typeof routing.mappings === "object" &&
      routing.mappings !== null
    ) {
      const rec = routing.mappings as Record<string, unknown>;
      const result: Record<string, RouteMapping> = {};
      for (const [k, v] of Object.entries(rec)) {
        result[k] = parseRouteMapping(v, `routing.mappings.${k}`, file);
      }
      mappings = result;
    } else {
      throw new CliUsageError(
        `${file} routing.mappings must be an array or object`,
      );
    }
  }

  let def: RouteMapping | undefined;
  if (routing.default !== undefined) {
    def = parseRouteMapping(routing.default, "routing.default", file);
  }

  if (routing.disabled !== undefined && typeof routing.disabled !== "boolean") {
    throw new CliUsageError(`${file} routing.disabled must be a boolean`);
  }

  return {
    ...(mappings ? { mappings } : {}),
    ...(def ? { default: def } : {}),
    ...(routing.disabled !== undefined
      ? { disabled: routing.disabled as boolean }
      : {}),
  };
}

function parseSummaryConfig(
  value: unknown,
  file: string,
): SummaryConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliUsageError(`${file} summary must be an object`);
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (key !== "enabled" && key !== "model") {
      throw new CliUsageError(`${file} summary unknown key: ${key}`);
    }
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new CliUsageError(`${file} summary.enabled must be a boolean`);
  }
  if (
    config.model !== undefined &&
    (typeof config.model !== "string" || config.model.trim().length === 0)
  ) {
    throw new CliUsageError(`${file} summary.model must be a non-empty string`);
  }
  return {
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(config.model === undefined ? {} : { model: config.model as string }),
  };
}

export const DEFAULT_MAX_VERIFICATION_STEPS = 8;

function parseNonNegativeInteger(
  value: unknown,
  key: string,
  file: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CliUsageError(`${file} ${key} must be a non-negative integer`);
  }
  return value;
}

function parsePositiveInteger(
  value: unknown,
  key: string,
  file: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CliUsageError(`${file} ${key} must be a positive integer`);
  }
  return value;
}

function parseCiAdmissionInteger(
  value: unknown,
  key: string,
  file: string,
  min: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseNonNegativeInteger(value, key, file);
  if (parsed === undefined) return undefined;
  if (parsed < min) {
    throw new CliUsageError(`${file} ${key} must be an integer >= ${min}`);
  }
  return parsed;
}

function parseCiReviewPolicyMode(
  value: unknown,
  file: string,
): CiReviewPolicyMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CliUsageError(
      `${file} ci_review_policy must be one of: ${CI_REVIEW_POLICY_MODES.join(", ")}`,
    );
  }
  if (!(CI_REVIEW_POLICY_MODES as readonly string[]).includes(value)) {
    throw new CliUsageError(
      `${file} ci_review_policy must be one of: ${CI_REVIEW_POLICY_MODES.join(", ")}`,
    );
  }
  return value as CiReviewPolicyMode;
}

// Widened, not weakened. Each of these reads exactly ONE property, so the
// parameter names that property instead of demanding a whole LocalConfig —
// which is what lets a caller hand over a raw parsed layer, before the merge
// has run, without either side lying about what it needs. The precedence each
// resolver applies is untouched.
export function resolveMaxVerificationSteps(
  config: Pick<ConfigLayer, "max_verification_steps">,
): number {
  return config.max_verification_steps ?? DEFAULT_MAX_VERIFICATION_STEPS;
}

// Undefined, not a default: an absent cap means no gate is constructed at all,
// which is today's unlimited behavior byte for byte.
export function resolveMaxConcurrentSteps(
  config: Pick<ConfigLayer, "max_concurrent_steps">,
): number | undefined {
  return config.max_concurrent_steps;
}

export function resolveSummary(
  options: Pick<CliOptions, "summary" | "model">,
  config: Pick<ConfigLayer, "summary">,
): SummarySettings {
  const model = options.model ?? config.summary?.model;
  return {
    enabled: options.summary ?? config.summary?.enabled ?? true,
    ...(model === undefined ? {} : { model }),
  };
}

// On by default since the 2026-10-22 Claude bench (musive 1722/1858/853, R=2,
// one variable): −28% $/review, −27% wall, no recall loss on the known bugs or
// the planted defect. Only an explicit --no-shared-prefix turns it off.
export function resolveSharedPrefix(
  options: Pick<CliOptions, "sharedPrefix">,
): boolean {
  return options.sharedPrefix !== false;
}

export function resolveScout(
  options: Pick<CliOptions, "scout">,
  config: Pick<ConfigLayer, "scout">,
): boolean {
  return options.scout ?? config.scout ?? false;
}

export function resolvePost(
  options: Pick<CliOptions, "post">,
  config: Pick<ConfigLayer, "post">,
): boolean {
  return options.post ?? config.post ?? false;
}

// Which layer produced each effective value. `capped` is deliberately NOT the
// same answer as `global`: the operator needs to see that a ceiling BOUND —
// that the team asked for something and was narrowed away — not merely that a
// global file happened to exist. `default` means no layer spoke at all and
// the downstream resolver's own fallback decides.
export type ConfigSource = "global" | "repo" | "capped" | "default";

// `summary` gets a per-field seat rather than one entry, because its two
// fields have DIFFERENT directions and a flat record cannot say
// `{ enabled: "capped", model: "global" }`. It is the only nested key, so this
// is one seat, not a pattern.
export type ConfigSources = Record<
  Exclude<keyof LocalConfig, "summary">,
  ConfigSource
> & {
  summary: Record<keyof SummaryConfig, ConfigSource>;
};

type ConfigLayerName = Exclude<ConfigSource, "capped" | "default">;

interface ConfigLayerEntry {
  name: ConfigLayerName;
  layer: ConfigLayer;
  // WHY a flag and not a name comparison: a `repo`-direction key may only be
  // folded from a layer that IS scoped to one repository. parseGlobalConfig
  // rejects those keys, but a fold that leans on another function's rejection
  // starts reporting `global` for a per-repo key the day that guarantee slips
  // — and D3b's deferred config.local.json is a second repo-scoped entry, so
  // `name === "repo"` would be wrong the moment the list grows.
  repoScoped: boolean;
}

interface FoldedValue<T> {
  value: T | undefined;
  source: ConfigSource;
}

function foldKey<T>(
  layers: readonly ConfigLayerEntry[],
  direction: ConfigDirection,
  read: (layer: ConfigLayer) => T | undefined,
  narrower?: (a: T, b: T) => T,
): FoldedValue<T> {
  let value: T | undefined;
  let source: ConfigSource = "default";
  for (const entry of layers) {
    if (direction === "repo" && !entry.repoScoped) continue;
    const spoken = read(entry.layer);
    if (spoken === undefined) continue;
    if (
      value === undefined ||
      direction !== "capped" ||
      narrower === undefined
    ) {
      value = spoken;
      source = entry.name;
      continue;
    }
    const narrowed = narrower(value, spoken);
    // WHY a tie reports the more specific layer and not `capped`: `capped` has
    // to mean the ceiling actually BOUND, or the operator cannot tell a
    // narrowing from a coincidence — and deleting the global file would change
    // nothing about a value both layers already agree on. (Judgment ledger
    // JD-20 left this label undefined; this is the choice, and it is tested.)
    value = narrowed;
    source = narrowed === spoken ? entry.name : "capped";
  }
  return { value, source };
}

// The merge, pure: two layers in, one effective LocalConfig plus its per-key
// provenance out. The signature names the two layers there are today, but the
// body folds over an ORDERED LIST, least specific first — so D3b's deferred
// third layer is one entry appended here plus a row in the direction table,
// not a rewrite of every rule below.
export function mergeConfig(
  global: ConfigLayer | undefined,
  repo: ConfigLayer,
): { effective: LocalConfig; sources: ConfigSources } {
  const layers: ConfigLayerEntry[] = [
    ...(global === undefined
      ? []
      : [{ name: "global" as const, layer: global, repoScoped: false }]),
    { name: "repo" as const, layer: repo, repoScoped: true },
  ];

  const agentsDir = foldKey(
    layers,
    CONFIG_DIRECTION.agents_dir,
    (layer) => layer.agents_dir,
  );
  const defaultBase = foldKey(
    layers,
    CONFIG_DIRECTION.default_base,
    (layer) => layer.default_base,
  );
  const triggers = foldKey(
    layers,
    CONFIG_DIRECTION.parity_trigger_paths,
    (layer) => layer.parity_trigger_paths,
  );
  const priors = foldKey(
    layers,
    CONFIG_DIRECTION.suspicion_priors,
    (layer) => layer.suspicion_priors,
  );
  // `summary` is descended into per-field: CONFIG_DIRECTION.summary declares
  // the key for the parsers, SUMMARY_DIRECTION decides each field. Folding the
  // object whole would silently adopt one layer's entire block.
  const summaryEnabled = foldKey(
    layers,
    SUMMARY_DIRECTION.enabled,
    (layer) => layer.summary?.enabled,
    (a, b) => a && b,
  );
  const summaryModel = foldKey(
    layers,
    SUMMARY_DIRECTION.model,
    (layer) => layer.summary?.model,
  );
  const maxSteps = foldKey(
    layers,
    CONFIG_DIRECTION.max_verification_steps,
    (layer) => layer.max_verification_steps,
    Math.min,
  );
  const maxConcurrentSteps = foldKey(
    layers,
    CONFIG_DIRECTION.max_concurrent_steps,
    (layer) => layer.max_concurrent_steps,
    Math.min,
  );
  const narrowSizeLimit = (a: number, b: number): number => {
    if (a === 0) return b;
    if (b === 0) return a;
    return Math.min(a, b);
  };
  const maxLines = foldKey(
    layers,
    CONFIG_DIRECTION.max_changed_lines,
    (layer) => layer.max_changed_lines,
    narrowSizeLimit,
  );
  const maxFiles = foldKey(
    layers,
    CONFIG_DIRECTION.max_changed_files,
    (layer) => layer.max_changed_files,
    narrowSizeLimit,
  );
  const scout = foldKey(
    layers,
    CONFIG_DIRECTION.scout,
    (layer) => layer.scout,
    (a, b) => a && b,
  );
  const post = foldKey(
    layers,
    CONFIG_DIRECTION.post,
    (layer) => layer.post,
    (a, b) => a && b,
  );
  const routing = foldKey(
    layers,
    CONFIG_DIRECTION.routing,
    (layer) => layer.routing,
  );
  const ciReviewPolicy = foldKey(
    layers,
    CONFIG_DIRECTION.ci_review_policy,
    (layer) => layer.ci_review_policy,
  );
  const ciMaxAttempts = foldKey(
    layers,
    CONFIG_DIRECTION.ci_max_attempts,
    (layer) => layer.ci_max_attempts,
  );
  const ciMaxReviews = foldKey(
    layers,
    CONFIG_DIRECTION.ci_max_reviews,
    (layer) => layer.ci_max_reviews,
  );
  const ciRereviewMinScore = foldKey(
    layers,
    CONFIG_DIRECTION.ci_rereview_min_score,
    (layer) => layer.ci_rereview_min_score,
  );
  const ciBlockingWeight = foldKey(
    layers,
    CONFIG_DIRECTION.ci_blocking_weight,
    (layer) => layer.ci_blocking_weight,
  );
  const ciAdvisoryWeight = foldKey(
    layers,
    CONFIG_DIRECTION.ci_advisory_weight,
    (layer) => layer.ci_advisory_weight,
  );
  const ciTrustedActors = foldKey(
    layers,
    CONFIG_DIRECTION.ci_trusted_actors,
    (layer) => layer.ci_trusted_actors,
    (a, b) => [...(a ?? []), ...(b ?? [])],
  );
  const ciAdmissionObserveOnly = foldKey(
    layers,
    CONFIG_DIRECTION.ci_admission_observe_only,
    (layer) => layer.ci_admission_observe_only,
  );

  const summary: SummaryConfig = {
    ...(summaryEnabled.value === undefined
      ? {}
      : { enabled: summaryEnabled.value }),
    ...(summaryModel.value === undefined ? {} : { model: summaryModel.value }),
  };

  const effective: LocalConfig = {
    // The ONE place `[]` is materialised, and it is here on purpose: the fold
    // above ran on absence and has already recorded `source: "default"` for a
    // key nobody named, so the array can be handed to the resolvers without
    // that fact being lost. Materialising it any earlier is what made
    // provenance a lie.
    parity_trigger_paths: triggers.value ?? [],
    suspicion_priors: priors.value ?? [],
    ...(agentsDir.value === undefined ? {} : { agents_dir: agentsDir.value }),
    ...(defaultBase.value === undefined
      ? {}
      : { default_base: defaultBase.value }),
    ...(summaryEnabled.value === undefined && summaryModel.value === undefined
      ? {}
      : { summary }),
    ...(routing.value === undefined ? {} : { routing: routing.value }),
    ...(maxSteps.value === undefined
      ? {}
      : { max_verification_steps: maxSteps.value }),
    ...(maxConcurrentSteps.value === undefined
      ? {}
      : { max_concurrent_steps: maxConcurrentSteps.value }),
    ...(maxLines.value === undefined
      ? {}
      : { max_changed_lines: maxLines.value }),
    ...(maxFiles.value === undefined
      ? {}
      : { max_changed_files: maxFiles.value }),
    ...(scout.value === undefined ? {} : { scout: scout.value }),
    ...(post.value === undefined ? {} : { post: post.value }),
    ...(ciReviewPolicy.value === undefined
      ? {}
      : { ci_review_policy: ciReviewPolicy.value }),
    ...(ciMaxAttempts.value === undefined
      ? {}
      : { ci_max_attempts: ciMaxAttempts.value }),
    ...(ciMaxReviews.value === undefined
      ? {}
      : { ci_max_reviews: ciMaxReviews.value }),
    ...(ciRereviewMinScore.value === undefined
      ? {}
      : { ci_rereview_min_score: ciRereviewMinScore.value }),
    ...(ciBlockingWeight.value === undefined
      ? {}
      : { ci_blocking_weight: ciBlockingWeight.value }),
    ...(ciAdvisoryWeight.value === undefined
      ? {}
      : { ci_advisory_weight: ciAdvisoryWeight.value }),
    ...(ciTrustedActors.value === undefined ||
    ciTrustedActors.value.length === 0
      ? {}
      : { ci_trusted_actors: ciTrustedActors.value }),
    ...(ciAdmissionObserveOnly.value === undefined
      ? {}
      : { ci_admission_observe_only: ciAdmissionObserveOnly.value }),
  };

  const sources: ConfigSources = {
    agents_dir: agentsDir.source,
    default_base: defaultBase.source,
    parity_trigger_paths: triggers.source,
    suspicion_priors: priors.source,
    summary: { enabled: summaryEnabled.source, model: summaryModel.source },
    routing: routing.source,
    max_verification_steps: maxSteps.source,
    max_concurrent_steps: maxConcurrentSteps.source,
    max_changed_lines: maxLines.source,
    max_changed_files: maxFiles.source,
    scout: scout.source,
    post: post.source,
    ci_review_policy: ciReviewPolicy.source,
    ci_max_attempts: ciMaxAttempts.source,
    ci_max_reviews: ciMaxReviews.source,
    ci_rereview_min_score: ciRereviewMinScore.source,
    ci_blocking_weight: ciBlockingWeight.source,
    ci_advisory_weight: ciAdvisoryWeight.source,
    ci_trusted_actors: ciTrustedActors.source,
    ci_admission_observe_only: ciAdmissionObserveOnly.source,
  };

  return { effective, sources };
}

// Same fail-loud discipline as the two array keys: an `agents_dir` that is a
// number, or an empty `default_base`, must not be read as "absent" — that is
// how a config silently stops configuring anything.
function optionalString(
  config: Record<string, unknown>,
  key: "agents_dir" | "default_base",
  file: string,
): Record<string, string> {
  const value = config[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliUsageError(`${file} ${key} must be a non-empty string`);
  }
  return { [key]: value };
}

export interface InitTemplateInput {
  agentsDir?: string | undefined;
  defaultBase: string;
  // What `~/.prhero/config.json` ALREADY says, or undefined when the operator
  // has no global file. C5 O-9: a scaffold that re-states what the global
  // layer already supplies ships the exact duplication C5 exists to delete —
  // §0.5 measured three byte-identical 212-byte configs on one machine.
  global?: ConfigLayer;
  // True when `--agents` named the prompt set on THIS init. A deliberate
  // narrowing of O-9's letter ("does not write a person key when the global
  // supplies it"), and D5's reasoning one command earlier: a flag is the
  // operator typing an intent, and a flag that parses and then writes nothing
  // is an operator believing they scaffolded a repo they did not. `PRHERO_
  // AGENTS_DIR` gets no such exception — the merged config already beats the
  // env var at review time (judgment ledger JD-9), so writing the env value
  // into the repo file would silently CHANGE which prompt set runs, not
  // preserve it.
  agentsDirFromFlag?: boolean;
}

export interface InitTemplateOmissions {
  agentsDir: boolean;
  summaryEnabled: boolean;
  summaryModel: boolean;
  // The same three facts as config-file key names, for init's log. Derived
  // here rather than rebuilt at the call site, because a scaffold that omits a
  // key and a log that does not mention it is worse than either alone: the
  // operator reads "agents_dir <path>" and never learns the file does not
  // contain that line.
  keys: string[];
}

// Which person/capped keys the repo scaffold LEAVES OUT, decided once and read
// by both the template below and init's own log.
//
// `default_base` is NOT here and must never be: it is a `repo` key (D4),
// `parseGlobalConfig` rejects it by name, so no global file can supply it and
// omitting it would scaffold a repo with no base ref at all. The two array
// keys are `repo` for the same reason. `summary.enabled` IS here even though
// O-9's wording names only the person keys — the template hardcodes `true`,
// which is exactly the value `capped` forbids the team file from raising over
// a global `false` (judgment ledger JD-17), so seeding it against a global
// that already spoke writes a line that is either dead on arrival or pure
// duplication.
export function initTemplateOmissions(
  input: InitTemplateInput,
): InitTemplateOmissions {
  const agentsDir =
    input.agentsDir === undefined ||
    (input.global?.agents_dir !== undefined &&
      input.agentsDirFromFlag !== true);
  const summaryEnabled = input.global?.summary?.enabled !== undefined;
  const summaryModel = input.global?.summary?.model !== undefined;
  return {
    agentsDir,
    summaryEnabled,
    summaryModel,
    keys: [
      ...(agentsDir ? ["agents_dir"] : []),
      ...(summaryEnabled ? ["summary.enabled"] : []),
      ...(summaryModel ? ["summary.model"] : []),
    ],
  };
}

// The scaffold `pr-hero init` writes. Kept pure and next to parseLocalConfig
// on purpose: a template its own parser would reject is a bug that only shows
// up on someone else's machine, and a round-trip test through parseLocalConfig
// costs nothing.
//
// With no global layer the bytes are exactly what they were before C5 — the
// regression boundary, and the reason `global` is optional rather than
// required.
export function initConfigTemplate(input: InitTemplateInput): string {
  const omit = initTemplateOmissions(input);
  const summary: SummaryConfig = {
    ...(omit.summaryEnabled ? {} : { enabled: true }),
    ...(omit.summaryModel ? {} : { model: DEFAULT_SUMMARY_MODEL }),
  };
  return `${JSON.stringify(
    {
      ...(omit.agentsDir ? {} : { agents_dir: input.agentsDir }),
      // Always written, whatever the global file says.
      default_base: input.defaultBase,
      // Dropped WHOLE when both fields hoisted: `"summary": {}` parses fine
      // and configures nothing, which is a line whose only effect is to make
      // the next reader wonder what it does.
      ...(Object.keys(summary).length === 0 ? {} : { summary }),
      parity_trigger_paths: [],
      suspicion_priors: [],
    },
    null,
    2,
  )}\n`;
}

// WHY init says this out loud: an untracked file under .prhero/ dirties the
// working tree, and the clean-tree gate in cli.ts then refuses to run at all.
// A first-time user who scaffolds and immediately hits "the working tree is
// dirty" has no way to connect the two.
export const INIT_GIT_REMINDER =
  "Now either commit .prhero/ or add it to .gitignore. Every review step " +
  "reads the checkout directly, so pr-hero refuses to run on a dirty tree — " +
  "and an untracked .prhero/ is exactly that.";

// The token every scaffolded gotchas file carries, and the primary signal
// that distinguishes "nobody has written this yet" from a real file (the
// exact-line rule further down is the only other one). It is not a
// new invention: `pr-hero setup`'s fallback already wrote it (wizard.ts), it
// simply had no reader. `pr-hero init`'s template now carries it too, so both
// scaffolds are detectable by one token instead of by matching their prose.
//
// WHY a marker rather than a heuristic (a `<subsystem>` scan, a length floor):
// a marker is a file DECLARING itself unfinished. Anything inferred from the
// prose would eventually reject somebody's real gotchas for looking generic,
// and the cost of a false positive here is a refused review.
//
// The one inference allowed beside the marker is an EXACT one: a file whose
// every non-blank line is a line one of our own scaffolds wrote. That is not
// a heuristic about prose — no real gotchas file consists solely of our
// template lines — and a real file that keeps one stray template line beside
// real ones still passes. It exists because a scaffold without its marker
// line — deleted by hand, or committed before the marker existed — reached
// every hunter as if it were real.
export const GOTCHAS_PLACEHOLDER_MARKER = "human-attention-required";

export const GOTCHAS_TEMPLATE = `<!-- ${GOTCHAS_PLACEHOLDER_MARKER}: delete THIS line once the gotchas below are real — pr-hero refuses to review while it is here. -->
# Repo gotchas

Facts a reviewer cannot infer from the diff alone. Each line is injected
verbatim into every hunter's system prompt, so keep them short and true.

- <subsystem>: <the thing that looks like a bug but is deliberate, and why>
- <subsystem>: <the invariant that is enforced somewhere the diff does not show>
- <subsystem>: <the naming/ownership rule a newcomer would violate>
`;

// `pr-hero setup`'s fallback scaffold (wizard.ts writes it when onboarding
// collected zero invariants). It lives here, beside GOTCHAS_TEMPLATE, so the
// gate below can recognise both scaffolds from one place.
export const SETUP_GOTCHAS_FALLBACK = `<!-- ${GOTCHAS_PLACEHOLDER_MARKER}: zero invariants defined during onboarding -->\n\n# Repository Gotchas & Invariants\n\n(No invariants defined during onboarding. Replace this with your project's real failure modes, then delete the marker line at the top — pr-hero refuses to review while it is there.)\n`;

// Every non-blank line the two scaffolds write, minus the marker line. A file
// made ONLY of these lines is a scaffold nobody filled in, whether its marker
// was deleted or it predates the marker. musive committed the pre-marker
// template, and its three `<subsystem>` lines were injected into every hunter.
//
// RETIRED lines are ones an earlier release's scaffold wrote and today's no
// longer does. A repo may still have them committed, so when a scaffold's
// wording changes, its old lines move here — otherwise that repo's scaffold
// slips past the gate again. (GOTCHAS_TEMPLATE's body has never changed; the
// setup fallback's sentence did, in 60c28c6.)
const RETIRED_SCAFFOLD_LINES = [
  "(No invariants defined during onboarding. Edit this file with project failure modes.)",
];

const SCAFFOLD_BODY_LINES = new Set([
  ...[GOTCHAS_TEMPLATE, SETUP_GOTCHAS_FALLBACK]
    .flatMap((scaffold) => scaffold.split("\n"))
    .map((line) => line.trim())
    .filter(
      (line) => line.length > 0 && !line.includes(GOTCHAS_PLACEHOLDER_MARKER),
    ),
  ...RETIRED_SCAFFOLD_LINES,
]);

export type GotchasUnusableReason = "empty" | "placeholder";

// The one gate every gotchas call site asks — local review, PR review, the
// pipeline's fail-loud abort, and `doctor`. It is a single exported predicate
// on purpose: four copies of `gotchas.trim().length === 0` are four things
// that drift apart, and the one they had already drifted from was the promise
// printed above them ("pr-hero refuses to run without it").
//
// The two arms are disjoint, so their order is NOT observable: a file holding
// the marker holds a non-whitespace token and therefore cannot also trim to
// empty. `empty` goes first only because it is the cheaper test. (The two
// reasons still render different messages — that is about what the caller
// says, not about which branch wins.)
export function gotchasUnusableReason(
  text: string,
): GotchasUnusableReason | undefined {
  if (text.trim().length === 0) return "empty";
  if (text.includes(GOTCHAS_PLACEHOLDER_MARKER)) return "placeholder";
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.every((line) => SCAFFOLD_BODY_LINES.has(line))) {
    return "placeholder";
  }
  return undefined;
}

// `pr-hero init`'s closing instruction block, as data.
//
// WHY it is a function of the outcome rather than a constant: `init` never
// overwrites, so the file the block talks about is either the scaffold this
// run just wrote or somebody else's file that was left alone — and those two
// need different sentences. Printed unconditionally, this block told a repo
// with real gotchas to "replace the <subsystem> lines" and "delete the
// marker line", neither of which is in its file. That is the same defect the
// `gotchas.trim().length === 0` gate was: a message asserting a state nobody
// checked.
//
// The KEPT arms therefore assert nothing of their own. They report what
// `gotchasUnusableReason` — the one gate every other call site uses — says
// about the bytes actually on disk, so the block cannot drift from the
// behaviour a following `pr-hero review` will have.
//
// The union is discriminated rather than a pair of optional fields on
// purpose: there is no `{ written: true, contents }` to get wrong, and no
// kept arm that forgot to pass the bytes.
export function initGotchasInstructions(
  outcome: { written: true } | { written: false; contents: string },
): string[] {
  if (outcome.written) {
    // Safe ONLY on this arm: the file is GOTCHAS_TEMPLATE, so it really does
    // carry `<subsystem>` lines and the marker.
    //
    // "refuses to run without it" was true of an ABSENT file and false of the
    // one this command just wrote: the scaffold is non-empty, so it used to
    // sail through the old gate and prime every hunter with `<subsystem>`
    // placeholders. The marker is what makes the old sentence true, so the
    // instruction has to name the marker.
    return [
      "Then edit .prhero/gotchas.md — two steps, both required:",
      "  1. replace the <subsystem> lines with facts about this repo",
      `  2. delete the \`${GOTCHAS_PLACEHOLDER_MARKER}\` marker line at the top`,
      "",
      "pr-hero refuses to review while that marker is present. It is not " +
        "pedantry: the file above is non-empty, so without the marker a " +
        "review would bill in full for hunters primed with placeholder text " +
        "and report a clean-LOOKING result.",
    ];
  }

  const reason = gotchasUnusableReason(outcome.contents);
  if (reason === "placeholder") {
    // NOT "replace the <subsystem> lines": a kept scaffold may be `pr-hero
    // setup`'s fallback (wizard.ts), which carries the marker and has no
    // `<subsystem>` lines at all. Naming them would be this same defect one
    // layer down.
    return [
      "The .prhero/gotchas.md already on disk is still a scaffold: it carries " +
        `the \`${GOTCHAS_PLACEHOLDER_MARKER}\` marker line or nothing but the ` +
        "scaffold's own lines, and pr-hero refuses to review it.",
      "",
      "Write facts about THIS repo into it, and delete the marker line if it " +
        "is still there.",
    ];
  }
  if (reason === "empty") {
    // No marker in an empty file, so nothing to delete — saying otherwise
    // would send the reader looking for a line that is not there.
    return [
      "The .prhero/gotchas.md already on disk is empty, and pr-hero refuses " +
        "to review without gotchas: an empty file makes the whole review a " +
        "zero-cost no-op that LOOKS like a clean result.",
      "",
      "Write facts about THIS repo into it — the deliberate oddities, the " +
        "invariants enforced somewhere the diff does not show.",
    ];
  }
  // Deliberately modest wording. The gate proves only that the file is
  // non-empty and marker-free; it does not prove the contents are good, so
  // this line reports the gate and claims nothing beyond it.
  return [
    "The .prhero/gotchas.md already on disk passes the gotchas gate and will " +
      "be used as-is.",
  ];
}

// The pipeline treats unusable gotchas as a fail-loud abort and returns a
// zero-cost partial run. Correct, but a bare "partial, 0 findings" tells the
// user nothing — so the CLI checks first and explains.
export function gotchasErrorMessage(
  gotchasPath: string,
  reason: GotchasUnusableReason,
): string {
  const why = [
    "Gotchas are the repo-specific facts a hunter cannot infer from the diff",
    "— deliberate oddities, invariants enforced elsewhere, conventions worth",
    "more than they look. They are injected verbatim into every hunter's",
    "system prompt, and the engine refuses to run without them.",
  ];
  if (reason === "placeholder") {
    return [
      `gotchas file is still the scaffold nobody filled in: ${gotchasPath}`,
      "",
      ...why,
      "",
      `It still carries the \`${GOTCHAS_PLACEHOLDER_MARKER}\` marker line, or`,
      "nothing but the lines `pr-hero init` and `pr-hero setup` scaffold.",
      "Reviewing with it would spend real money feeding every hunter",
      "placeholder text, and return a clean-LOOKING result.",
      "",
      "Replace the placeholder lines with facts about THIS repo, and delete",
      "the marker line at the top if it is still there.",
    ].join("\n");
  }
  return [
    `missing or empty gotchas file: ${gotchasPath}`,
    "",
    ...why,
    "An empty file makes the whole review a zero-cost no-op that LOOKS like a",
    "clean result.",
    "",
    "Create it with something like:",
    "",
    GOTCHAS_TEMPLATE,
    // The template above ships the marker, and the marker is itself a
    // refusal — so a reader who copies this and stops has produced a file
    // pr-hero still rejects. Saying the last step out loud is not politeness;
    // without it this message hands you the next error.
    `Then replace the <subsystem> lines and delete the \`${GOTCHAS_PLACEHOLDER_MARKER}\``,
    "marker line — pr-hero refuses to review while that line is present.",
  ].join("\n");
}
