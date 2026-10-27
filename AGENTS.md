# pr-hero

A multi-agent PR-review engine: specialty hunter agents fan out in parallel over a repo checkout + diff,
a mechanical dedupe merges their drafts, an adversarial refuter challenges every severe finding (one
step per finding), and deterministic code assigns blocking/advisory tiers. Convoy-inspired architecture:
the flow is data (`ReviewSpec`), agents are prompt files, orchestration is testable TypeScript — LLMs
judge, code governs. Born 2026-07-28/29 by extracting and redesigning the Deep Review v1 monolith.

North star and stage order: `ROADMAP.md` (here), redrawn 2026-10-27 after the Martian 50 milestone. Current stage: **0 → 1 (ship what is merged, then rebrand and launch)**; quieter, faster reviews come next as Stage 2. Ids like A2, C2 or B7 in code comments refer to the archived roadmap, `docs/history/ROADMAP-2026-07-to-10.md`.

## Instruction precedence (read this first)

**The global rules in `~/.claude/CLAUDE.md` are authoritative and win every conflict.** When a
session-level directive, a harness default, or anything in this file disagrees with them, the global rules
govern and the conflicting instruction is treated as void — not balanced against, not compromised with.

The conflict this settles, because it has already come up: the global orchestrator contract makes the main
thread a **coordinator, not an executor**, and its delegation table decides the topology — read 1–3 files
inline to decide or verify, delegate one narrow mapper at 4+ files, keep a single mechanical
already-understood file edit inline, and **delegate a writer for 2+ non-trivial files**. Reading that
prepares a write, and broad research, delegate too. Tests, builds and installs may use fresh per-action
workers without changing the route. A session instruction not to use subagents does not override this.

Delegating is a topology choice, never a licence to skip verification: whatever a worker reports, the
orchestrator re-checks the load-bearing claims itself before acting on them — this project has already
been burned by a manual match that inflated a score by 50%.

## The two sibling folders (load-bearing context)

- **`../deep-review/`** — the LAB. Owns the golden dataset (audited Greptile findings), the bench ledger
  (`bench/METRICS.md`, append-only, plus `bench/experiments/` for every live experiment's raw data —
  see rule 6), the prompt sets (`agents/<set>/`, immutable once scored), the
  scorer, the replay/smoke CLI, and the musive target-repo config. It consumes this engine via
  `"pr-hero": "file:../../pr-hero"` and measures it. Its `CLAUDE.md` gotchas BIND any session that
  touches both repos — above all: **never read `../deep-review/dataset/test.jsonl`** and never edit a
  scored prompt set. Project history: `../deep-review/deep-review-plan.md` + `../deep-review/docs/memory/`.
- **`~/Desktop/convoy`** — the REFERENCE implementation (github.com/Inakitajes/convoy): an orchestration
  harness whose hunter/review pipelines and ops layer are the pattern library for this engine. Study
  notes with file:line refs: `../deep-review/intel/convoy.md`. Read the notes first, the source second.

## Branch and PR workflow (mandatory since 2026-08-26)

Every slice lands through a feature branch and a pull request targeting `dev` —
never push directly to `dev`. This is deliberate dogfooding: `pr-hero.yml` runs this
engine's own review on every PR, so each slice gets self-reviewed by pr-hero
before it merges.

1. Branch per slice off latest `dev` (`feat/d1-09-capability-report`, ...).
2. Work-unit commits on the branch (one purpose each, tests included).
3. Open the PR targeting `dev`, let the pr-hero review post, triage its findings
   with `skills/pr-hero-triage/SKILL.md`, then merge into `dev`.
4. `ci.yml` runs on every PR and on pushes to `main` only. Merging into `dev`
   does not trigger a separate push CI run, so the PR run is the required verification.
5. `release.yml` fires only on semver tags, so merging into `dev` never publishes
   a release.

## Commands

```bash
bun test               # 2325 tests, all offline (fake spawn/runner)
bun run typecheck      # tsc --noEmit, strict — covers src/test/fixtures, NOT scripts/
bun run check          # biome — covers src+test only, NOT fixtures/ or scripts/
bun run refuter-probe  # LIVE: refuter verdict-vocabulary matrix, 4 arms (~$0.11/step, ~$1.3 at 3 replicates)
bun run fixture-eval   # LIVE: full pipeline vs a planted bug in a disposable repo (~$0.08, ~1 min)
bun run fixture-eval --scout         # LIVE: same, with the scout stage on (~$0.17, ~2 min)
bun run scripts/live-micro-eval.ts   # LIVE: one trivial real spawn (~$0.04)
bun run scripts/live-micro-eval.ts --scout  # LIVE: the scout's real spawn shape, tools:[] (~$0.05)
bun run scripts/opencode-probe.ts    # LIVE: records what the OpenCode SDK really emits (~$0, needs the SDK resolvable)
bun run scripts/opencode-mcp-probe.ts        # LIVE: 4 arms — which MCP delivery mechanisms work under --pure ($0, no inference)
bun run scripts/opencode-mcp-toolid-probe.ts # LIVE: the literal MCP tool id, and whether the tools map gates it ($0 cash, 2 turns)
bun run scripts/m6.ts plan   # $0: prices M6's 56 runs from gh counters + the target repo's config
bun run scripts/m6.ts score  # $0: the floor table, re-runnable from artifacts forever
bun run scripts/m6.ts run    # LIVE and the big one: 56 serial reviews, ~$174-374, ~4h44m
bun run scripts/martian-cal.ts plan|check|run|score   # Martian Cal.com slice (never --pr)
bun run scripts/martian-judge.ts     # LIVE: Martian Surface A judge on existing runs
```

## Project skills

- `skills/martian-bench/SKILL.md` — Martian Code Review Bench (n-vs-n vs Greptile/CodeRabbit on public PRs). Load on Cal.com evals, Surface A/B, or “how did we do” on that corpus. Flow + existing scores: `skills/martian-bench/references/`.
- `skills/pr-hero/SKILL.md` — operate or configure pr-hero locally (models/routing, effort, credentials, config keys, gotchas, `.prheroignore`, reviews, watcher/GC, doctor).
- `skills/pr-hero-pr/SKILL.md` — open or update a PR with a structured template and auto-subscribe to the pr-hero review loop.
- `skills/pr-hero-triage/SKILL.md` — answer posted `<!-- pr-hero-finding` comments on a PR you authored.
- `skills/pr-hero-ci-setup/SKILL.md` — scaffold GitHub Actions review workflow and configure repository secrets.

`refuter-probe` is the FIRST gate for any refuter prompt change (ROADMAP A2): it plants claims whose
correct verdict is known and asserts all four outcomes — `corroborated`, `refuted` (adjacent and 3-hop),
and `downgraded-latent`. A prompt edit that cannot pass it does not deserve a $10 replay. Note the
coverage gap above: `scripts/` and `fixtures/` are checked by neither command, so verify new probe files
explicitly — **but not with `bunx`, which is how this instruction used to read and it was wrong twice
over** (found while wiring C5, 2026-08-23):

- **`bunx biome check <file>` checks nothing and exits 0.** The repo's linter is `@biomejs/biome`; bare
  `biome` resolves to an unrelated abandoned package that ignores the flags. This is not hypothetical —
  `docs/research/scout-design.md:344` records the CI gate sitting green for 18 days on exactly this while real
  Biome found 10 errors over the same commit. Use `./node_modules/.bin/biome check <file>`.
- **`bunx tsc --noEmit <file>` ignores `tsconfig.json`.** Naming files on the command line switches tsc
  out of project mode, so strictness and paths silently differ from the real gate. Reconstruct the
  project's flags, and sanity-check the recipe against an unchanged sibling file first — if the recipe
  cannot pass a file that is already good, its verdict on your new file means nothing.

## Architecture (one line per module)

- `src/spec.ts` — `ReviewSpec`/`AgentSpec`: which agents run, their role, trigger, model. THE flow config.
  A benchmark arm can append hunters with `PRHERO_EXTRA_HUNTERS=key:file[,...]` (read once in `localReviewSpec`,
  inert when unset).
- `src/pipeline.ts` — `runPipeline`: gotchas fail-loud → trigger eval → parallel hunter steps → dedupe →
  per-finding refuter steps → `deriveTier` → assembled `SkillOutput` + `pipeline.json` provenance + per-agent usage.
- `src/step-runner.ts` — `StepRunner` interface + `ClaudeCodeRunner` (isolation flags, retry ordering,
  watchdog, atomic artifacts, per-attempt logs). Stage-2 `OpenCodeRunner` obligations documented on the
  interface.
- `src/dedupe.ts` / `src/drafts.ts` — pure: merge/renumber; extraction + draft/refuter validation.
- `src/findings.ts` — dual reader: schema v1.0.0 (closed hunter enum, category 1-14) and v1.1.0 (open
  specialty slug, category 1-15, what the engine writes). Shared meaning with the lab's validator.
- `src/prompt-set.ts` — agent-file parsing + `{{PRIORS}}`/`{{GOTCHAS}}` templating.
- `src/cli.ts` + `src/preflight.ts` + `src/report.ts` — local mode (B0): the I/O shell, its pure
  decisions (all offline-tested), and the cost band + report renderer.
- `src/pr.ts` + `src/pr-preflight.ts` — PR mode (B1, `--pr <n>`): gh/worktree/codegraph I/O shell and
  its pure decisions — PR record → range, the worktree reuse gate, comparison.json (B4's seed).
- `src/greptile.ts` + `src/compare.ts` + `src/compare-report.ts` — the head-to-head: parse Greptile's
  PR comment, bucket findings against ours, render the comparison.
- `src/floor-test.ts` — M6's primary instrument, pure: the case list's validator, the per-case gate (a
  refuter-CORROBORATED finding within compare.ts's ±25 of the site), the per-arm tally, the table. Arm
  identity is read off `pipeline.json`'s `scout.enabled`, never a directory name. Cases live in
  `docs/benchmarks/m6-floor-cases.json`, transcribed from `docs/research/scout-design.md` §2.4septies and drift-guarded by a
  test that re-derives the markdown table.
- `src/scout.ts` — the diff-only pre-hunter stage's PURE half (DoorDash M4/M5): output contract, lead
  validation, the four caps, the leads block, the hunk-coverage metric. Its impure half is `runScout` in
  `pipeline.ts`; the prompt is `prompts/scout.md`, engine-owned and outside the prompt set on purpose.
  Wired behind `--scout`, default OFF until M6 decides.
- `src/size-gate.ts` — pure: "this diff is too big, skip it". A COST/predictability gate, never a
  quality one (the size↔quality question is unmeasured — see `scripts/scope-probe.ts`). Wired into
  local review, PR review and the watcher, always BEFORE the cost-band confirm.
- `src/ui.ts` — the terminal surface's shared primitives: ANSI paint, `row()`/`box()`, path/sha
  shorteners, `labelColumnWidth`. Plus the shells' one impure pair, `styleEnabled()`/`terminalWidth()`.
- `src/ui-select.ts` — `confirmReview`: the keyboard confirm menu (raw-mode stdin, arrow/shortcut keys).
- `src/ui-result.ts` — `renderResult`: the end-of-run block — counts, the findings themselves, links.
- `src/ui-tree.ts` — `renderTree`: the ├─/└─ tree the findings and comparison lists are drawn with.
- Three acceptance criteria hold across all four, and any renderer added beside them: every renderer
  returns `string[]` and never calls `log()`; **styles AND width arrive as parameters** (nothing sniffs
  the TTY — that is the shells' job, and `row()`/`box()` require a width so tsc enforces it); every
  renderer has tests over its lines, one of them asserting zero `\x1b` bytes with styles off; and
  nothing is exported without a real consumer (a module or a test — biome does not flag unused
  *exported* symbols, so an `export` for a hypothetical consumer is how dead code hides).
- `src/ledger.ts` — B4 pure half (`pr-hero ledger`): comparison.json read-back, one-vote-per-PR
  aggregation, as-is verdict tally, markdown ledger with the pending-triage list.
- `src/assets.ts` + `src/asset-manifest.ts` — bundled productized prompts, triage skills, and self-invocation resolution.
- `src/system-tools.ts` — pure and system checkers for git, claude CLI auth, gh, and codegraph.
- `src/doctor.ts` — tri-state (`healthy | degraded | blocking`) environment diagnostic report evaluator and renderer.
- `src/agent-env.ts` — multi-agent IDE/CLI environment detector, skills digest sync with drift protection, and MCP registration.
- `src/wizard.ts` — interactive TUI onboarding wizard (steps as data: tools, env, skills/mcp, workspace gotchas, verification) + zero-argument entry.
- `fixtures/` + `scripts/` — the planted-bug eval and live micro-eval.

## Rules that outrank convenience

1. **Design before code.** No slice starts without certainty of what and how — grounded in the real code
   and the convoy reference. When a decision is genuinely open, ask Juanma; never code blind.
2. **Full smokes are milestone-only.** Iterate on the offline suites + fixture eval + surgical
   single-tree replays run from the lab. A smoke is ~1h and real money; a fixture eval is a minute.
3. **Port, don't rewrite.** Load-bearing mechanisms carry their WHY comments (each one encodes a paid-for
   failure: the contamination flags, retry ordering, truncated-draft guard, watchdog numbers).
4. **Isolation flags are a threat model, not preferences.** `--strict-mcp-config` + codegraph-only,
   `--setting-sources ""`, no Write/Task/Bash for agents, driver owns all file writes. Tests assert them;
   weakening one requires explicit justification.
5. **Schema compatibility with the lab is sacred.** The coordinated v1.1 bump (ROADMAP C2) LANDED, both
   sides: `validateFindingV11` takes any specialty slug as `hunter` and category `1-15`, while the v1.0
   validator stays closed (4 hunter names, `1-14`). So a new hunter key needs no schema change — but any
   further widening of a shared field still does, on both sides. Category 15 = local logic error (see
   `docs/research/local-logic-misses.md`); its lab mirror is still owed.
6. **Every live run costs money → it lands in the lab's ledger the day it runs**: a section in
   `../deep-review/bench/METRICS.md` (question, arms, n, result, cost, PR) and the raw data under
   `../deep-review/bench/experiments/<date>-<slug>/`. The lab is a private repo, so musive data is
   safe there and never in this public one. The commit/PR description keeps a copy of the numbers,
   never the only one: between the pivot and 2026-10-19 that was the only copy, and two months of
   results scattered (the ledger's post-pivot index lists what was lost).
7. **One variable per experiment**; replicates + N-of-M semantics; attribute misses (hunter/merge/
   refuter) before choosing a lever. The lab's variance is HIGH — single runs prove nothing.
