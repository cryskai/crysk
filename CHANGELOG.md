# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`npx pr-hero` without Bun**: `bin/pr-hero.js` now starts under Node too. It runs the CLI in-process under Bun,
  and under Node it starts Bun on `src/cli.ts`: the bundled `bun` dependency (pinned to 1.3.14, an
  `optionalDependency`) first, then `bun` on PATH. It forwards SIGTERM, SIGHUP and the exit code (Ctrl+C reaches Bun from the terminal), and
  exits 127 with an install hint when no Bun is found. `@opencode-ai/sdk` moves to `dependencies`, and the action
  installs with `--omit=optional`, so CI does not download the bundled Bun. MCP and launchd registration refuse a
  run from npx's temporary cache: "install pr-hero (npm i -g pr-hero) to register".

### Changed
- **Gate: a partial review is red**: in gate mode a finished review where some hunters failed, and no blocking
  finding survived, sets `failure` with `pr-hero: review partial (N of M hunters failed) — /pr-hero review retries it`
  instead of `success`. A blocking count still wins. A skip carries a partial verdict red, and `pr-hero status`
  answers `review` for it. Advisory mode is unchanged.

### Fixed
- **A cancelled review no longer leaves its `pr-hero` status pending.** A cancel kills the CLI before its own settle lands, so the head's status stayed `pending: pr-hero reviewing` forever. A separate `Settle a cancelled review` step now runs only on a cancel and sets this run's own pending on the locked head to `error` `PRH-CANCELLED: not reviewed — /pr-hero review reviews this head`. The `!cancelled()` publish step is unchanged, so a superseded run still reports no false failure.
- **A re-review's fresh findings reach the state block.** From the second review on, the summary's `pr-hero-state` block holds this run's findings as well as the earlier ones. Before, it held only the earlier findings, so a blocking finding first raised by a re-review was forgotten by the next review, and a same-head forced re-review could read green. Known gap: the first review writes no state block, so its outside-diff findings are not persisted; its inline findings are recovered from their markers on the second review.
- **A run whose every hunter failed for one cause no longer shows placeholders.** The hunters-failed path renders a
  shared cause only when its sentence is complete with the params that path has: `model_unavailable` with the provider
  known, and `missing_provider_record` with the provider and model known. Every other cause keeps `PRH-HUNTERS-FAILED`.
  The sandbox reads `PRH-MODEL-UNAVAILABLE` and a hunter-route `PRH-CRED-UNUSABLE` as the same hunters-failed path.
- **A model the provider does not serve is named after the provider.** A provider refusal whose `status=` slot
  reports HTTP 404 now classifies as `model_unavailable`, a terminal cause that is never retried. Its CI outcome is
  `PRH-MODEL-UNAVAILABLE` with the lead `Provider <name>:` instead of `Unclassified:`, and the code's owner is now
  the provider. The `provider_configuration_invalid` cause keeps its `Your configuration:` lead. Other refusal
  statuses classify as before.
- **A run whose every hunter hit the same unserved model says so.** The CLI record of a `hunters-failed` run now
  names each failed hunter's transport cause, provider and model (`hunter_failures`). When every hunter failed with
  `model_unavailable`, the publisher renders `PRH-MODEL-UNAVAILABLE` with the lead `Provider <name>:` and the model,
  instead of `PRH-HUNTERS-FAILED`. Any other mix, and a record without the field, render as before.
- **A run whose every hunter lacks the route's credential record names it.** An OpenCode route whose provider has no
  record in the auth store now carries the typed cause `missing_provider_record`, from the broker's own refusal and not
  from its message text. When every failed hunter shares a cause with a code of its own, the publisher renders that
  code and its owner: `PRH-CRED-UNUSABLE` with `Your configuration:` and the route (`route <provider>/<model> has no
  usable credential record`). A mix of causes, or `runtime_unavailable`, still renders `PRH-HUNTERS-FAILED`.

### Added
- **`/pr-hero recheck` and the CI adjudicator**: a PR comment that is exactly `/pr-hero recheck` runs `/pr-hero review` with `--adjudicate`. The CI adjudicator rules on up to 5 pending `dismissed` replies to blocking findings, and only an upheld dismissal leaves the gate count. `deferred` and `misclassified` never do, and a rejected or inconclusive verdict keeps the finding counted. Verdicts are replies by `github-actions[bot]`, so a custom token fails closed. The recheck run never changes the count itself: an upheld finding leaves it from the next review of the same head, which reads the reply back. A verdict counts only on the head it was given, and a failed adjudicator step posts nothing and stays pending. Refused on fork pull requests, with the same permission check as `/pr-hero review`.
- **`pr-hero status --pr <n> [--json]`**: a read-only command that reads one PR's pr-hero gate, its posted
  findings, and a `next_action` (`wait`, `review`, `triage`, `fix`, `override-or-fix`, `done`) through `gh` alone. With
  `--json` it prints one `pr-hero.status/v1` object on stdout. It fails closed: a failed read or a truncated comment
  list, or a read that never answers within its bound, exits 1 with nothing on stdout. A green gate with a finding
  on this head that has no reply is `triage`, not `done`, because the triage skill answers advisory findings too. A
  green gate over a partial review of this head (some reviewers failed) is `review`. Each finding carries `blocking`,
  which is true for an unrecoverable tier as it is for a blocking one, so such a finding is never read as clear. A
  finding whose badge and state row both fail to give a tier reads as `tier: "unrecoverable"`, never `null`. The
  triage skill runs it as step 0. `docs/github-actions.md` has the shape.
- **Gate mode for CI**: the action's `mode` input (`gate` or `advisory`, default `gate`) decides what the
  `pr-hero` commit status says. `gate` sets `failure` on unresolved blocking findings, on a size or budget
  skip, and on a crash, and `success` otherwise. `advisory` keeps the previous posture: a finished review is
  always `success`. Local runs and the watcher post their status on `pr-hero/local`, which the required check
  never reads, so a local run cannot overwrite a red gate. A watcher run also stands down for a local review
  already in flight on the same head, while a `--ci` run still stands down only for a pending on `pr-hero`. When
  the review itself failed before delivery, a failed final status write is logged and never replaces that failure.
  When a delivered review's final status write fails, including when a step after the delivery failed, the publisher
  step of the same job posts that status once more, so the required check does not stay pending; the job still fails.
  `/pr-hero override` unlocks a red gate for the head it names, and is refused on a pull request from a fork. When the
  override's status is written, it also removes earlier outcome comments from the pull request, as a completed review
  does, and keeps every override record.
- **Reactions answer a `/pr-hero` comment the trigger does not review**: a refused or near-miss comment gets a
  reaction on the comment and no text reply. 👀 marks an accepted command, 👎 a refused one (no write access, or a
  refused override), and 😕 a near miss, which runs nothing. A reaction is best effort: when GitHub refuses it, the run
  prints one warning and its outcome does not change. Only a comment's first attempt reacts: a re-run keeps its decision and adds no reaction. A comment run's head lookup for an authorised commenter with no
  credential is retried once, so a transient failure no longer leaves that run without its status.

### Fixed
- **An unreadable override check is no longer silent**: when a review's override check cannot read the head's statuses, the verdict is written as before and the run logs a warning that says so, and the publisher's repost of an unsettled status logs the same warning. A malformed status row is ignored and the valid rows decide, so a valid fresh override beside a garbage row still stands and nothing is written over it; only a failed gh read (an error or a timeout) counts as unreadable and writes the verdict with the warning.
- **A skipped head no longer leaves the gate silent**: in gate mode, a head the admission gate skips (low-risk or
  below-threshold delta, or once per PR) inherits the verdict of the pull request's last reviewed commit, read from
  that commit's own statuses (the newest earlier commit with a review's verdict, within the last 20), never from
  comment content, so a comment naming a green head carries nothing. A skip's failure is not a verdict, so one skip no
  longer hides a green review on an older commit. A red review stays red and a clean one reads as
  no review needed. An override is never carried, and a head whose newest status is an override keeps it, when that
  head's statuses can be read: a re-run writes no skip status over it. When they cannot be read, the skip's status is
  written as planned and the run logs a warning. With no readable verdict, or when the attempt budget is used up, the head is
  `failure` with the way to review it. Before this, an admission skip posted no status, so a required check could
  block with no explanation, or pass a head nobody decided about.
- **An outside-channel triage reply keeps its `#issuecomment` link when the repo's web URL cannot be read**: the link
  is what binds the reply to its finding, and a failed `gh repo view` used to post the reply with no link at all. The
  reply now falls back to the PR's own URL, then to the repo's `nameWithOwner` on the GitHub host. It posts without a
  link only when none of the three is known.
- **The gate counts unresolved findings, not only this run's**: a blocking finding an earlier review left
  open stays counted through a re-review that carries it, through a same-head `/pr-hero review` that runs no
  hunters, through a triage reply on its own, and through later pushes after a rejected dismissal or a
  `misclassified` reply. Before this, each of those read green. A finding leaves the
  count only when the re-review verifies it gone or its files were deleted. Known gap: a blocking finding first
  raised by a re-review, rather than by the first review, is not yet carried to the reviews after it. An advisory
  finding from this run never clears a blocking one at the same spot.
- **An override holds against every verdict write of the review (`success` or `failure`), when the head's statuses can be
  read**: the check covers a body that failed after delivery, and the publisher step's repost of a status the CLI could
  not write. An `error` write, such as a
  review whose hunters all failed, is not a verdict and may replace the override. The run's start is stamped before its
  pending status is posted, with a 5-second clock-skew allowance, so an override posted while that post was slow stands;
  when that pending did not land, the allowance is dropped. The CLI's head-status read asks for 100 contexts per page, as
  the publisher's does, so a busy head's `pr-hero` row is not missed. A failed head lookup for `/pr-hero override` gets its
  own refusal notice, apart from the notice for a proven fork.

## [0.2.3] - 2026-10-16

### Added
- **Re-reviews post a closing comment**: a re-review with `--post` only edits the existing summary
  comment in place, and GitHub neither notifies on an edit nor moves the comment down the timeline.
  A re-review that found nothing therefore left the PR looking untouched, so nobody could tell "ran
  and found nothing" from "never ran". Every re-review now ends with a new comment
  (`<!-- pr-hero-rereview-closed head=<sha> -->`) carrying the reviewed head, the same delta line as
  the summary, how many new findings it posted, a partial-coverage warning when steps failed, and a
  link to the updated summary. A first review posts none, because its new summary is already visible.
  If the closing comment fails to post, the run logs it and still succeeds.

### Fixed
- **CI skip notices stay visible on later pushes**: a skipped review (size, budget, coverage, or
  manual override) used to edit its earlier notice in place. GitHub neither notifies on an edit nor
  moves the comment down the timeline, so a skip on a later push was invisible. On #315 the budget
  notice was created at 01:48 and silently re-edited at 02:48. The notice is now posted fresh at the
  bottom of the PR. Afterwards, older notices with the same marker are deleted, but only those
  posted by the same account, so the PR still carries a single notice. If the post fails, nothing is
  deleted. Every GitHub call is bounded by a timeout. A failed, rejected or hung listing or delete is
  logged and the run continues.

## [0.2.2] - 2026-10-07

### Added
- **`full` action input and `full` force-dispatch input**: the action passes `--full` when `full` is
  `'true'`, and `pr-hero-force.yml` (the scaffolded template and this repository's own) gains a
  boolean `full` dispatch input, off by default, wired to it. It is the only CI recovery when a prior
  review of the same head was hollow or wrong: that review's complete summary marker makes every later
  run on the head skip discovery ("No changes to discover"), and `--force` never widens discovery. Run
  `gh workflow run pr-hero-force.yml -f pr=<n> -f full=true`. See `docs/github-actions.md`, "Manual
  override".

### Fixed
- **Patches over 128 KiB can be reviewed on Linux** (#314, 2026-10-05): the Claude Code CLI
  transport passed the whole user prompt, which embeds the patch, as one argv string. Linux caps a
  single argv string at 131072 bytes, so on a 175,805-byte patch `execve` failed with `E2BIG` and
  every hunter failed in seconds without reaching the provider. The prompt now travels on stdin
  (`claude -p` with no positional prompt). `buildStepArgv` no longer takes a prompt argument.
- **A failed `claude` spawn reports why** (#314): a spawn that throws (for example `E2BIG`, `ENOENT`)
  is now a failed attempt whose reason reads `spawn failed: <code>: <message>`, instead of an attempt
  settled as cancelled with no cause. It is terminal (`runtime_unavailable`): no child started, so it
  is never retried with a format reminder. The progress output prints the reason for a failed hunter
  or summarizer, redacted and skipping the harness's own bookkeeping notes:
  `hunter logic: failed — <reason> (the run continues)`.
- **A CI run that yields to an in-flight review is no longer recorded as a failed admission**
  (2026-10-02): when another pr-hero review (for example a local hook-triggered one) already held a
  `pending` commit status on the PR head, the CI run stood down with exit 0 but left its
  `pr-hero/ci-admission` reservation unsettled, and teardown's safety net settled it `failed`. The PR
  showed a red check, and the row counted as a spent attempt for any later run on that head. The run
  now settles its reservation as a new terminal status, `yielded`, which completes the check run as
  `skipped`, never counts toward the budget, and does not block the next reservation.
- **This repository's force workflow reviews with the pull request's own engine** (found on #305,
  2026-10-02): `gh workflow run pr-hero-force.yml` starts on the default branch, and the workflow
  checked out that branch before `uses: ./`, so a forced review ran the default branch's engine
  instead of the one under review. On #305 `main` lagged `dev`: four hunters returned no drafts in 59
  seconds and the run posted a complete summary marker for the PR head, so every later run on that
  head skipped discovery. The gate now reads the fork verdict and the head commit in one
  `gh pr view` call before checkout, fails unless the head is a full 40-character commit sha, and
  checkout pins that commit.
  Consumer workflows run the published `juanmaagd/pr-hero@v0` and are unchanged.

## [0.2.1] - 2026-10-02

### Added
- **`effort:` agent frontmatter key**: a prompt may declare how hard its model works, one of `low`,
  `medium`, `high`, `xhigh`, `max` (the Claude CLI's `--effort` levels). An unknown value fails at
  preflight and names the file. When the key is omitted the engine supplies a per-role default (hunter
  `xhigh`, refuter `high`, summarizer, scout and rereview verifier `high`), so a custom prompt set still
  runs at an explicit level. See `docs/configuration.md`, "Effort".
- **Effort in the run artifacts**: each attempt's request plan records the `effort` that was requested
  and `effortApplied`, and each step in `pipeline.json` records `effort` and, when it has a route,
  `effort_applied`. The effort is not part of the route fingerprint.

### Changed
- **pr-hero now owns the effort and always passes `--effort`** (#299, 2026-10-02). It used to pass none,
  so every step ran at the Claude CLI's implicit default: `high`, except on Sonnet 5.5 and Opus 5.5,
  where it is `medium`. When the `sonnet` alias moved to claude-sonnet-5-5 the bundled hunters silently
  dropped from `high` to `medium` and stopped exploring: on a real 280-line PR, 0 of 8 hunter runs found
  anything at `medium`, 6 of 8 at `high`, 8 of 8 (and all 4 known bugs) at `xhigh` (about 4.5 minutes
  per review), and 7 of 8 at `max` (about 19 minutes). The bundled hunters keep `sonnet` and now declare
  `effort: xhigh`; the bundled refuter keeps `opus` and now declares `effort: high`. The refuter is
  `high`, not `medium`, because on real findings `medium` refuted a pre-labeled known blocker in 3 of 4
  verdicts (a deleted finding) where `high` kept it as latent in 3 of 4, even though `refuter-probe`
  had passed 16 of 16 at `medium`. This supersedes an earlier unreleased change that moved the hunters to
  `opus`; that change is reverted and the hunters stay on `sonnet`. Expect a higher per-review cost
  and wall time than the 0.2.0 band: `xhigh` hunters cost roughly three times `high` per hunter, and the
  cost band does not yet price effort. The child environment is an allowlist that never carries
  `CLAUDE_CODE_EFFORT_LEVEL`, so an operator's shell cannot override the engine's level. OpenCode has no
  equivalent control and does not map one: the requested level is recorded with `effortApplied: false`.

### Fixed
- **Verified execution snapshots no longer fill the disk** (#303, 2026-10-02): every step copied the
  verified provider binary (about 217 MB for `claude`) into `$TMPDIR/prhero-exec-snapshots` and never
  removed it, so one benchmark machine accumulated 153 GB and reached 98% disk. Each step now removes
  its snapshot after its last attempt, resolving a binding no longer writes one, a process removes the
  snapshots it still holds when it exits, and the next run (or `pr-hero gc`) sweeps snapshots left by
  processes that died without cleaning up: a dead owner pid, or older than 6 hours. Snapshots stay
  private per call; they are not shared across steps.

## [0.2.0] - 2026-09-26

### Added
- **OpenCode as an alternative execution runtime**: hunters, the refuter, and the scout can now run
  through the OpenCode SDK instead of only the Claude Code CLI — a route-keyed, provider-neutral
  runtime composition with exact-binding readiness checks feeding `doctor`/`init` and the review plan
  card, and a `provider_api_token` credential broker generic over every OpenCode provider (adding a new
  one is an `auth.json` entry, a route, and a pricing file — no code). Opt-in; Claude-only behavior is
  unchanged (#106, #107, #108, #112, #114, #115, #168).
- **OpenCode in GitHub Actions**: operators can select OpenCode in CI via a `PRHERO_ROUTING` variable
  and an `OPENCODE_AUTH_JSON` secret, with API-token CI correctly detected as metered rather than an
  unlimited subscription, documented end-to-end in `docs/github-actions.md` (#209, #210, #211).
- **Manual re-run from GitHub Actions**: a new `pr-hero-force.yml` `workflow_dispatch` workflow lets an
  operator dispatch `gh workflow run pr-hero-force.yml -f pr=<n>` to run a skipped review on Actions with
  `--force`, bypassing the size gate, CI admission, and the budget ceiling for that one run (#269).
- **Skip re-review when nothing justifies another run**: CI now skips re-reviewing a PR when the prior
  findings don't warrant another pass, instead of always re-running discovery (#109).
- **`.prheroignore`**: a repo-root file declaring which paths pr-hero excludes from a review. Excluded
  paths fall out of the reviewed diff and hunters/scout input, and stop counting toward the cost band,
  the size-gate threshold, and the watcher's pre-launch check, both locally and in CI (#202, #204, #205).
- **New `logic` hunter (category 15)**: a CWE-derived, language-agnostic local-logic-error sweep,
  promoted from a benchmark-only modifier into the bundled default prompt set (#261, #265).
- **Findings schema v1.1**: hunters may now report an open specialty slug instead of only the four
  built-in hunter names, and severity category `1-15` instead of `1-14`; a v1.0 reader/validator is kept
  for backward compatibility (#110).
- **Operator configuration guide**: `docs/configuration.md` documents the two-layer person/team
  configuration, routing, and credentials end-to-end, linked from the README (#283).

### Changed
- **The refuter now defaults to `opus`**: the bundled refuter prompt declares the `opus` alias instead
  of `sonnet`, so the adversarial step that judges every severe finding runs on the latest Opus the
  Claude CLI resolves, with no pr-hero release needed per model version. Hunters stay on `sonnet` and
  the summarizer on `haiku`. OpenCode operators whose routing maps only `sonnet` and has no `default`
  route: the refuter is now unmapped and falls through to the Claude CLI, which needs Claude
  credentials; map `opus` or add a `default` route to keep it on OpenCode (see `docs/github-actions.md`,
  "OpenCode in CI") (#292).
- **Provider-reported cost replaces bundled pricing tables**: a metered route is now admitted on the
  provider transport's own reported cost instead of a rate table pr-hero has to keep updated. Per-provider
  pricing catalogues (including a real z.ai rate table) shipped first to unblock non-Anthropic providers,
  then were removed once transport-reported cost proved sufficient for all routes (#162, #167, #170,
  #172, #198).
- **No more hardcoded Claude model alias**: the CLI resolves `sonnet`/other Anthropic aliases itself and
  pr-hero records what actually ran, instead of pinning and asserting a version internally — an alias
  repoint from Anthropic no longer needs a pr-hero release (#176).
- **Raised the size gate's default line limit**: the engine default (`DEFAULT_SIZE_GATE.maxChangedLines`)
  and the GitHub Action's `max-changed-lines` input both move from `1500`/`1000` to `4000` — an owner
  decision, not a new measurement, because the old defaults were skipping too many real PRs outright.
  The files ceiling (150 engine / 50 action) is unchanged.
- **Renumbered releases to 0.x**: `1.0.0` is now `0.1.0` and `1.1.0` is now `0.1.1` — the public API
  (CLI surface, config schema, GitHub Actions contract) is not yet stable, and the `1.x` numbering
  overstated that. The floating Action tag moves from `@v1` to `@v0`. The `v1` tag itself stays
  **frozen** at the last 1.x release so existing `uses: juanmaagd/pr-hero@v1` workflows keep resolving
  exactly what they always have — they simply receive no further updates. New and existing repos should
  migrate to `@v0`.
- **Release guard**: `.github/workflows/release.yml` now fails fast, before building anything, when the
  pushed tag's version does not match `package.json`'s `version` — see `docs/release-runbook.md`.

### Fixed
- **OpenCode works from the standalone binary**: the compiled binary installed by `install.sh` could
  not use the OpenCode backend at all — admission reported the SDK as "not installed" even when it
  was. pr-hero now loads the SDK's client entry, which has no external dependencies, instead of the
  full index; a load failure now names its real cause; and the compiled-binary smoke that gates CI and
  every release asset exercises this load path (#289).
- **OpenCode free models work again**: OpenCode's free-tier gateway began refusing any turn whose tool
  list lacks `bash` or `read` (`403 … free tier can only be used from within OpenCode`), and pr-hero
  always denies `bash`. On free routes only, those tools now stay visible with OpenCode permission
  `ask`, and pr-hero rejects every permission request automatically, so a step still never executes a
  command; every other route keeps denying them outright. The server attests the posture it launched
  with, and pr-hero refuses to lift the deny when that attestation is missing (#290).
- **OpenCode SDK transport stabilization**: a long tail of correctness fixes surfaced while
  operationalizing the OpenCode runtime — tool-surface enumeration instead of trusting the provider's
  default, text-part harvesting instead of reasoning text, turn boundaries ending at the actual end of
  turn, MCP registry wiring so hunters reach codegraph, credential-projection ordering, a typed session
  wire format with canonical snapshots and fail-closed identity reconciliation, terminal-state
  arbitration and usage-identity dedup, stream-delta dedup by event id, provider SSE refusals filed as
  `runtime_unavailable` instead of a burned format retry, a hunter that never made a tool call now fails
  instead of posting a clean bill, an absent SDK degrading `doctor` instead of crashing it, and resolving
  the SDK correctly from standalone compiled binaries (#117, #123, #125, #129, #130, #140, #143, #144,
  #145, #151, #208, #215, #216, #217, #218, #219, #220, #221, #222, #223, #225, #226, #227, #228, #263,
  #270, #273, #281).
- **Billing and credential correctness**: a `claude-code` route on an API key is now billed as metered
  instead of silently admitted as subscription (#278); the harness no longer performs a per-step
  credential projection the OpenCode transport never reads, which could throw and print a false
  "operator environment" warning (#282); an attempt whose credential projection degrades onto a raw key
  now has its spend fenced instead of going unreserved (#284).
- **`.prheroignore` scoping**: pr-hero's own default exclusions are now scoped to prose files only, so
  executable code inside `docs/research/**` is no longer accidentally excluded from review (#262).
- **In-flight lock released on cancellation**: a cancelled review run no longer leaves the PR's in-flight
  lock held, which had blocked the very next push's review from starting (#163).
- **Re-review checks proof against the reviewed tree**: `proof_refs` are now verified against the tree
  that was actually reviewed (#165).
- **Deduplication no longer discards on similarity alone**: a later claim looking similar to an earlier
  one is no longer treated as permission to drop the earlier finding (#155).
- **CI budget ceiling defaults to unlimited on a subscription route**: a subscription route no longer
  gets silently capped by a budget ceiling meant for metered spend (#160).
- **Subscription cost marked as notional**: a subscription run's reported cost is now clearly labeled as
  a notional list-price figure, not actual cash spend (#177).
- **Install → ready path**: fixed four defects (three found by inspection, one more while fixing them)
  blocking the documented install-then-review path, so a fresh `install.sh` run actually reaches a
  working `pr-hero` (#179).
- **Empty separator row removed**: the report no longer prints an empty separator row for a claim-less
  live finding (#181).
- **Partial review forces full coverage next time**: a review where some hunters or the refuter failed
  (but not all) no longer causes the next review on the same head to skip discovery entirely (#224).
- **Pipeline records why a step failed before its first attempt**: a step that died before spawning now
  carries a redacted failure reason in `pipeline.json` instead of silently discarding it (#271).
- **Re-review recovers carried finding state**: severity, tier, and claim text now carry forward
  correctly on a second review instead of resetting to generic placeholder values (#285).
- **Re-review reports skipped discovery honestly**: a re-review that skips discovery now says explicitly
  that no hunter ran, instead of falsely reporting a clean bill (#286).

## [0.1.1] - 2026-09-04

_Originally published as tag `v1.1.0`; renumbered to `0.1.1` afterward (see "Renumbered releases to 0.x"
above). `0.1.0` below was originally published as `v1.0.0`._

### Added

#### Multi-Runtime Execution Harness (D1)
- **Decoupled StepExecutionHarness**: Extracted provider-agnostic harness (`src/execution/harness.ts`) managing process-group lifecycle (`PGID`), signal escalation (`TERM → KILL → reap`), and terminal proofs.
- **Concurrency & Spend Limiter**: Integrated `concurrency-limiter` and `spend-limiter` with transactional spend reservation ledgers, protecting operators from runaway API spend.
- **Cross-Provider Usage Normalization**: Standardized token usage and cost accounting across models and transports (`src/execution/usage-normalized.ts`).
- **OpenCode SDK Transport Foundations**: Initial client adapter, server launcher, and event-stream mapping for OpenCode runtime support.

#### Security & Isolation Architecture
- **WorkspaceReadBroker**: Canonical path resolution and boundary verification, preventing symlink traversal and reads outside the workspace.
- **CredentialBroker**: Ephemeral credential projection isolating sensitive tokens from agent child processes.
- **Diagnostic Redaction**: Automated scrubbing of sensitive environment variables and credentials from diagnostic error tails.
- **Security Policy**: Added `SECURITY.md` establishing coordinated vulnerability disclosure through GitHub Private Vulnerability Reporting.

#### Distribution, CI & Packaging (Pillar 3)
- **CI Run Directory Upload**: Automatic upload of run artifacts (`findings.json`, `diff.patch`, `report.md`) from GitHub Actions runs, enabling local triage via `pr-hero triage reply`.
- **Automated Floating Major Tag**: Release pipeline now automatically updates the floating `v1` tag upon publishing stable semantic releases.
- **Compiled Binary Smoke Verification**: Added `scripts/compiled-smoke.ts` exercising 18 integrity checks on standalone compiled binaries prior to release artifact distribution.

### Fixed
- **BunFS Asset Resolution**: Corrected asset path resolution inside compiled Bun executables so bundled prompts and skills resolve reliably without filesystem dependencies.
- **Install Script Shell PATH Guidance**: Updated `install.sh` to explicitly instruct operators on exporting `$HOME/.prhero/bin` in the current shell session, preventing `command not found` on fresh installs.
- **Floating Tag Prerelease Exclusion**: Restricted floating major tag updates to stable semantic releases (`^v[0-9]+\.[0-9]+\.[0-9]+$`), preventing `-beta` or `-rc` builds from moving production tags.

## [0.1.0] - 2026-08-25

### Added

#### Core Review Engine & Pipeline
- **Parallel Multi-Agent Hunter Architecture**: Orchestrated fanout of specialized review hunters (`reliability`, `resilience`, `parity`, and `lifecycle`) executing in parallel across repository checkouts and pull request diffs.
- **Specialized Hunter Classes**:
  - `lifecycle`: Specialized state-machine and lifecycle-contract hunter focusing on latches, effects, unmount/cleanup paths, re-entrancy, and resource leaks.
  - `reliability`: Hunter targeting crash bugs, unhandled null/undefined values, type-boundary violations, and exception escapes.
  - `resilience`: Hunter evaluating edge-case degradation, timeout handling, retries, and network/subsystem fault tolerance.
  - `parity`: Hunter ensuring consistency and contract parity across mirrored implementations and platform bridges (triggered via `parity_trigger_paths`).
- **Mechanical Deduplication Stage**: Deterministic deduplication engine (`src/dedupe.ts`) that merges hunter draft findings, normalizes line/symbol ranges, reconciles overlapping candidate claims, and generates unified finding candidates.
- **Adversarial Refuter v2**: High-precision refutation engine (`src/refuter.ts`) evaluating high-severity candidate findings with mandatory own-expansion, visiting referenced proof sites, and actively hunting counterexamples.
- **4-Outcome Refuter Vocabulary**: Refuter verdicts standardizing on a strict 4-outcome vocabulary:
  - `corroborated`: Defect positively verified and supported by adversarial analysis.
  - `refuted`: Finding disproven with explicit, cited code contradiction (dropped from final output).
  - `inconclusive`: Counterexample search yielded no definitive contradiction; finding preserved and assigned to advisory tier.
  - `downgraded-latent`: Real defect mechanism identified but verified to be dormant or unreachable in the current code path; preserved and assigned to advisory tier (never deleted).
  - *(Plus `not_submitted` for findings below the refutation severity threshold).*
- **Deterministic Tiering**: Clean separation of blocking vs. advisory tiers computed strictly in deterministic code (`src/findings.ts`) based on severity, evidence class, and refuter verdicts—never delegated to model discretion.
- **Assistant Posture**: Core design philosophy operating as an intelligent code-review assistant rather than an obstructing merge gate; every report includes an explicit non-blocking disclaimer and CI runs exit 0 on discovered findings.
- **Incremental Re-Review (Item 7)**: Smart verification of prior findings across subsequent pushes (`src/rereview.ts`), validating fixed claims without re-running redundant whole-repo sweeps, avoiding archaeology, and explicitly reporting `unconfirmed` when verification is inconclusive rather than falsely assuming resolution from absence.
- **Reconnaissance Scout Stage (`--scout`)**: Opt-in pre-hunt scout phase (`src/scout.ts`) performing lightweight diff analysis to identify suspicious hotspots and route hunter attention efficiently.

#### Storage & Observability
- **Canonical Product Store (`prhero.db`)**: SQLite-backed canonical database (`~/.prhero/prhero.db`) serving as the durable source of truth for all review runs, structured findings, proof references, hop trails, and debug telemetry.
- **Query Server Daemon**: Local query daemon (`src/server.ts`, `pr-hero server`) providing IPC interfaces and query endpoints for inspecting review history, findings, and telemetry.
- **Historical Migration & Backfill**: Automated migration framework (`src/store.ts`) backfilling legacy run directories and comparison ledgers into the canonical database schema with zero data loss.

#### Configuration System (C5)
- **Two-Layer Person vs. Team Configuration**: Clear hierarchy between operator machine defaults (`~/.prhero/config.json`) and repo-committed team configuration (`<repo>/.prhero/config.json`).
- **Capped Operator Spend Protections**: Non-bypassable protection invariant where team-level configuration can only narrow or lower spend-sensitive knobs (`max_verification_steps`, `max_changed_lines`, `max_changed_files`, disabling `summary.enabled`, `scout`, `post`), preventing repository configs from enlarging the operator's bill.
- **Interactive Configuration Manager**:
  - `pr-hero config`: Read-only inspection displaying every effective key, resolved value, source layer (`repo`, `global`, `capped`, `default`), and file paths.
  - `pr-hero config set` / `unset`: CLI mutations supporting `--person`, `--team`, and `--watch` layer targets.
  - `pr-hero config --edit`: Full-featured interactive terminal editor with buffered drafts, layer switching, Save/Discard actions, and capped ceiling annotations.

#### Distribution & Onboarding (Pillar 1)
- **Cross-Platform Standalone Binaries**: Self-contained compiled executables with zero external runtime dependencies targeting `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`.
- **NPM Global Package**: Published `pr-hero` package on npm for Bun and Node environments.
- **Universal Install Script (`install.sh`)**: One-line curl installer featuring automated platform detection, SHA256 checksum verification, and idempotent shell PATH configuration.
- **Interactive Setup Wizards (`pr-hero init` & `pr-hero setup`)**: Guided onboarding initializing `.prhero/config.json`, scaffolding `gotchas.md`, registering MCP servers, and synchronizing agent skills.
- **Bundled Asset Architecture**: In-binary asset bundling for agent prompts (`prompts/*.md`) and skills via static import manifests, eliminating external path dependencies.
- **System Doctor (`pr-hero doctor`)**: Comprehensive preflight diagnostics verifying Git status, Claude authentication / OAuth tokens, GitHub CLI (`gh`), codegraph availability, and configuration validity across both terminal and CI environments.

#### Terminal User Interface (Pillar 2)
- **Zero-Argument TUI Dashboard**: Interactive root dashboard menu launched by `pr-hero` in interactive TTY sessions with context-aware navigation, doctor status badges, and quick-action shortcuts.
- **Review Confirmation Plan**: Upfront execution plan displaying target branch/PR, diff statistics, participating hunters, refuter settings, and estimated USD cost bands prior to review execution (bypassed with `--yes`).
- **Activity & Run Monitor (`pr-hero activity`)**: Live dashboard showing in-flight review processes, elapsed execution time, PID management, safe process termination (`--kill <pid>`), daily watcher spend tracking, and recent run history.

#### GitHub Actions CI Integration (Pillar 3)
- **Official Composite Action (`action.yml`)**: Reusable GitHub Action referenced via `@v0` for automated pull request code reviews on `ubuntu-latest` and `macos-latest`.
- **CI Step Summary & Outputs**: Markdown summary output formatted for `$GITHUB_STEP_SUMMARY` and machine-readable Action step outputs (`status`, `findings-count`, `blocking-count`, `advisory-count`, `cost-usd-est`, `run-dir`).
- **Spend & Size Safety Gates**: Automated budget guards (`max-changed-lines`, `max-changed-files`, `budget-usd`) skipping oversized or cost-prohibitive PRs cleanly with explicit skip status annotations.
- **CI Automated Scaffolding**: `pr-hero setup --ci` and `pr-hero ci init` commands generating byte-accurate `.github/workflows/pr-hero.yml` configurations, complemented by the `pr-hero-ci-setup` agent skill.

[Unreleased]: https://github.com/juanmaagd/pr-hero/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/juanmaagd/pr-hero/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/juanmaagd/pr-hero/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/juanmaagd/pr-hero/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/juanmaagd/pr-hero/compare/v1.1.0...v0.2.0
[0.1.1]: https://github.com/juanmaagd/pr-hero/releases/tag/v1.1.0
[0.1.0]: https://github.com/juanmaagd/pr-hero/releases/tag/v1.0.0
