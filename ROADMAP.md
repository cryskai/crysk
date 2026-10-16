# pr-hero — Roadmap

Defined 2026-07-29 with Juanma, right after the engine flip (deep-review's v1 monolith retired,
pr-hero@0.1.0 is the engine). Ordering principle: **the benchmark bar funds everything** — recall work
first (it is what cancels Greptile), production wiring second, platform/multi-model third (each lever
enters as a measured arm, never as faith), OSS productization last. One variable per experiment, always.

**That opening principle is history, kept for the record (noted 2026-08-16).** Two later decisions replaced
it and this file reads in their light: THE PIVOT (2026-08-10) retired the benchmark bar and made
Greptile the oracle rather than the target — "cancel Greptile" is a malformed question at the measured
overlap; and the DoorDash direction (2026-08-16, below) made **precision over recall the stated posture**
and coverage something bought with a measured scout, not with "recall work first". What survives from the
original ordering unchanged: every lever enters as a measured arm, one variable per experiment.

Working agreement on validation speed: full smokes are SLOW and are reserved for milestone validation.
Day-to-day iteration runs on offline gates (tests/typecheck/biome), the fixture eval, and surgical
single-tree replays against the specific goldens a change targets.

External references live in `docs/`, archived rather than linked because the sources go behind paywalls
and CDN walls. DoorDash engineering is the second reference implementation this roadmap reasons against,
after convoy — a production code-review agent at ~10,000 PRs/week over 56 repos, with published numbers.
Both posts absorbed 2026-08-16; between them they touch Phase B item 7, issues #19/#23/#39/#40/#41/#42,
Phase C's C7–C10, and Phase E's fixer loop.

- `docs/doordash-ai-code-reviewer.md` (2026-05-11) — product and architecture: the lead scout, focused
  context, precision over recall, the production lessons.
- `docs/doordash-dashbench-trust.md` (2026-07-06) — DashBench, the measurement layer: why acceptance
  rate is not ground truth, how they label without trusting any single source, and the measured
  scout-vs-no-scout tradeoff.
- `docs/doordash-audit.md` — **the closing artifact**: every DoorDash mechanism against pr-hero's code
  as of 2026-08-16, status per row (`built / partial / missing / ahead / deliberately-different`), file:line
  evidence, and the disposition each gap landed in. Also the recommended build order for the next
  session. Read it before starting any of C7–C10.
- `docs/martian-bench.md` — **the n-vs-n field (Juanma, 2026-08-19)**. Martian's Code Review Bench:
  50 public PRs (Sentry, Grafana, Cal.com, Discourse, Keycloak) with human goldens *and* stored reviews
  from Greptile, CodeRabbit, Bugbot, Copilot, and the rest. Protocol for running pr-hero locally on
  those SHAs without contamination, scoring against their judge (vendor-comparable) and against stored
  vendor comments (our H2H × N oracles). Does not reopen Phase A, does not replace the musive Greptile
  head-to-head, does not reorder M6. Cal.com 10 Surface A scored 2026-08-19 (`scripts/martian-cal.ts` +
  `scripts/martian-judge.ts`). Skill: `skills/martian-bench/SKILL.md`. Not the 50, not Surface B.

**The direction (Juanma, 2026-08-16): pr-hero pivots toward DoorDash's mechanisms and postures** —
staged noticing/verifying, focused routed context, reporting guardrails, a measurement layer that refuses
any single source as ground truth. What the pivot does NOT adopt is spelled out in the audit's header:
their numbers as targets, their scale, and any reordering of the stabilise-first sequence. Phase A stays
closed; time stays the binding constraint.

**The sequence lives in `ROADMAP-DOORDASH.md` — roadmap 2.** Decided the same day: every DoorDash-derived
change runs first as its own track (M0–M7: honesty fixes, #19's shape, scout design → probe → flag → A/B,
fill-ins), and this roadmap resumes at **Phase B item 7** when that track's splice conditions hold. Two
roadmaps, one order: that file governs until the splice; this file governs after.

**Precedence rule (Juanma, 2026-08-16): where the two disagree, the LATER post wins.** They disagree in
exactly one place and it is load-bearing — the May post's headline is a 60.2% acceptance rate; the July
post shows acceptance populates only two of the four confusion-matrix cells and demotes it to product
telemetry. Anything in this roadmap or in the issue tracker that reads acceptance as a success condition
predates that correction and is wrong.

## THE LAUNCH LINE — 2026-08-18. The destination is not the exit.

Decided by Juanma the same day: the two roadmaps stay, but they stop being the condition for shipping.
**Amended the same evening:** launch is not only distribution (npm / TUI / Action). It also includes the
**product fundamentals** a stranger would hit on the second push — re-review, and everything that
unblocks it — plus the canonical product store (`docs/observability-canonical-store.md`): W4's
metrics sidecar is not enough to ship. Rubric: if a stranger's second push, a CI run, or an install
would lie, fail mute, or be impossible → before launch. If it only makes reviews better or prettier
→ after.

The engine already does the *first* review on musive (local, `--pr --post`, watcher, triage, size gate)
as an **assistant, not a merge gate**. Claude Code only — no OpenCode, no model mix.

**How to read this file from here.** Four layers, one ship goal:

| Layer | What it is | Blocks launch? |
|---|---|---|
| **Floor** | Phase A closed + Phase B minus item 7 (and item 8's leftover polish) | already done |
| **Fundamentals** | finish DoorDash M5→M6, C4, item 7, C5, canonical store | **yes** |
| **Distribution** | the three pillars below | **yes** |
| **After** | C1b, C2, C3, C6, C8–C10, Phase D, rest of E, scout-as-default, named review pipelines | no |

Scout ON is not a launch requirement. **M6's outcome landed 2026-08-20: opt-in** — scout behind
`--scout`, default OFF. What launch required was that M5+M6 **run**, so item 7 is designed against the
pipeline we will actually have, which is now settled as the no-scout-by-default one. Item 7's gate is
unchanged and now rests on condition 1 (M1 seen live) alone — do not unblock by rewriting it.

### Fundamentals (this order — we are in the middle of the DoorDash track)

1. ~~**`ROADMAP-DOORDASH.md` M5** — wire the scout behind `--scout`, default OFF. Watcher does not learn
   the flag until M6 decides.~~ **DONE 2026-08-18** (`e1ed036`). Flag off by default, watcher untouched
   (it spawns `review --pr <n> --yes` and `parseArgs` refuses `--scout` on any other verb), fixture-eval
   green both ways at $0.30. Two design numbers changed on M4 evidence — the watchdog and the model
   default — both recorded in `docs/scout-design.md` §3.15.
2. **M6 — DECIDED 2026-08-20 by Juanma: OPT-IN.** The scout stays exactly as M5 shipped it —
   `src/scout.ts`, `prompts/scout.md`, `--scout`, default OFF, watcher still unaware of the flag. Not
   adopted as default, not dropped. Two things produced the call. **(a)** The pilot's 12 runs ($44.32, on
   disk, scorable forever) produced a CALIBRATION finding, not a scout verdict: the scout emits 4 leads
   against a 12 budget, covers 43% of the diff's files, and stacks against `MAX_LEADS_PER_PATH = 3` in
   the main file of 2 of 3 PRs — so the hunters converge on the same sites and 40% of the scout arm's
   drafts collapse in the merge (+100% gross work for +15% net). Scored at $0 this session, the floor
   table is 2/13 scout against 1/13 control with 11 cases never run, and the scorer prints its own limit
   beside it (`src/floor-test.ts:349`): it can say `drop` loudly, it cannot separate `adopt` from
   `opt-in`. **(b)** The same-build invariant broke, verified in code this session: C4 landed after the
   pilot (`d0cb47e`, `bbd5277`, both 2026-08-20) and `writeSystemPrompt` (`src/pipeline.ts:350-355`)
   prepends `RUNTIME_PREAMBLE` to every system prompt unconditionally — no flag, no arm-dependence. The
   12 runs stay valid as a pair but can no longer be pooled with anything today's engine produces, so
   **"run the remaining 44" no longer exists: reopening M6 costs 56 runs from zero** ($173.68–$374.22,
   ~4h44m per `plan`; ~$207 / ~7h31m at the pilot's measured ratios) on whatever build is current then,
   plus a recalibration decided before the spend. Full record: `docs/scout-design.md` §3.16 and §3.17;
   the leads analysis is reproducible at $0 from `<run>/steps/scout.leads.json`.
3. **C4** — engine-owned preamble + XML boundary tags on any user-authored text. Must exist **before**
   item 7 inlines previous findings and author replies (the rule is already on the C4 entry).
   **Design: `docs/c4-preamble-design.md`** (2026-08-19, awaiting ratification) — §5 is the done-checklist.
4. **Phase B item 7 — re-review.** Verification of prior findings; discovery over what changed; do not
   infer `resolved` from absence; after N pushes the author sees the current state. Still does not start
   until the splice conditions on that entry hold.
5. **C5** — global config with per-repo override. Also the load-bearing half of distribution pillar 1
   (bundled `agents_dir` as a person-key). A repo still cannot subscribe itself to extra spend.
6. **Canonical product store** — `docs/observability-canonical-store.md`. W4's `metrics.db` is a
   metrics sidecar; launch needs one product database. Spec, not a restatement: SQLite at
   `~/.prhero/prhero.db` is the source of truth (runs, full findings, proof refs, hop trails, debug
   rows, agent usage, comparison); JSON/report files become regenerable exports; a small local query
   server is the only normal database owner (CLI, later dashboard, and a read-only MCP agent share the
   same typed routes; no caller opens SQLite or sends arbitrary SQL); a review is not persisted until
   that transaction commits (replaces fail-soft ingest); GC may collect worktrees and exports, never
   canonical rows; mandatory idempotent backfill of historical `findings.json`, including pre-W4 runs.
   Independent of the DoorDash gate — can run in parallel with M5–M6. Does **not** include the web
   dashboard, remote hosting, or live-pipeline changes (those stay after, or out of this refactor).

**Where the Martian bench sits in this order (Juanma, 2026-08-19).** Not now. The fundamentals above
run first; the dedicated push on `docs/martian-bench.md` happens **at the end, once the engine is
stable and before launch** — one block of work, not a knob turned mid-track. The reasoning is the
instrument's own: Martian is how a *methodology change* gets measured against Greptile and CodeRabbit
on identical diffs, and there is no methodology change on the table while C4, item 7, C5 and the
canonical store are open. Tuning a benchmark against a moving engine measures the movement.

Consequences, so nobody has to re-derive them: the Cal.com 10 `hunters` baseline (13/19 High+Critical,
$43.32) stays frozen and re-readable at $0 — do not overwrite those run dirs. Surface B and the vendor
rows stay unfetched until that push. This is **not** a launch checkbox in "Launch is done when" — it is
a scheduled block before launch, and promoting it to a gate is Juanma's call, not a session's.

### Three distribution pillars (after fundamentals, or in parallel once M5–M6 are in flight)

1. **Install + configure in one flow.** npm distribution. `npm i -g pr-hero && pr-hero init` leaves a
   repo that `--dry-run`s. The load-bearing hole: today's `SUGGESTED_AGENTS_DIR` is a path on Juanma's
   machine (`preflight.ts:47-48`). A published package must **bundle a frozen production prompt set**
   and default `agents_dir` to it. `init` is a wizard, not a file dump: walk gotchas (empty still
   fails loud — a starter is not a skip), commit-vs-ignore for `.prhero/`, dependency preflight
   (`claude` authenticated, `git`, `gh`, codegraph). C5 (global config, per-repo override) belongs
   here: person-keys (`agents_dir` bundled, `summary`) default globally; repo-keys stay in
   `.prhero/`. The precedence rule on C5 is unchanged — a repo must not subscribe itself to extra spend.
   Design + slice plan (S1–S5): `docs/pillar1-distribution-onboarding-design.md` +
   `openspec/changes/pillar1-distribution-onboarding/`. D0 decided 2026-08-24: full open source, Apache-2.0.
2. **CLI menus + TUI for the happy path and every knob we already have.** Not a web dashboard (that is
   a later page). Not convoy's live per-step panel (later). Not per-hunter model picking (Phase D,
   after launch). What it IS: `init` as menus; the review plan/confirm/result that item 8 already
   shipped; `pr-hero` with no args as a menu (review / watch / init / config); and a config surface
   that covers the settings that exist today, so nobody has to hand-edit JSON for the happy path.

   Launch config surface — existing knobs only, no new ones from D2/C6:

   | Where | Knobs |
   |---|---|
   | `~/.prhero/config.json` — **the person** (C5, 2026-08-23) | `agents_dir` (bundled default), `summary.model`, and the ceilings for `summary.enabled` / `max_verification_steps` |
   | `<repo>/.prhero/config.json` — **the team**, committed | `agents_dir`, `parity_trigger_paths`, `suspicion_priors`, `default_base` (**repo-only** — a global value would preempt remote-head autodetection and review the wrong range), `summary.enabled` / `summary.model`, `max_verification_steps`. The team may only **narrow** the two capped keys. |
   | `.prhero/gotchas.md` | required, human-authored; wizard helps write them |
   | `~/.prhero/watch.json` | per-repo `post`, `on_push`, size-gate overrides; global `daily_cap`, `window`. Still the **only** thing that subscribes a repo to unattended spend, and still global-only. |
   | `watch install` | tick `interval` |
   | per-run, from the same menus | `--post`, `--force`, `--max-changed-lines` / `--max-changed-files`, `--hop-budget`, `--model` as a **single Claude override** for every agent — not routing |

   Commands that already work and are not launch blockers stay CLI: `ledger`, `triage`, `gc`,
   `reverts`, `corpus`.
3. **GitHub Actions CI.** A thin Action wrapping `pr-hero review --pr --ci --post --yes`. Documented
   `CLAUDE_CODE_OAUTH_TOKEN` (or the equivalent) in repo secrets. Unattended spend is bounded: the
   size gate plus an explicit cap (per-PR / daily). It comments, and its commit status is the required
   check: `mode: gate` (the default) turns it red on blocking findings, a size or budget skip, and a crash;
   `mode: advisory` keeps it green. The local watcher remains the Mac-side adapter — same product, two triggers.
   **Shipped 2026-08-24** (5 phases, `openspec/changes/pillar3-github-actions-ci/`): `action.yml`
   (composite action, repo root), the canonical `.github/workflows/pr-hero.yml`, and
   `docs/github-actions.md`. Assistant posture, the size/budget gates (including `budget-usd <= 0`
   disabling the ceiling with a loud `::warning::`), and `$GITHUB_OUTPUT`/`$GITHUB_STEP_SUMMARY`
   wiring are all implemented and offline-tested. **Not yet live-verified**: no `v1` tag exists, so
   this repo's own `.github/workflows/pr-hero.yml` (`uses: juanmaagd/pr-hero@v1`) cannot resolve the
   action until one is published — see the checklist below.

### Launch is done when

Fundamentals:

- [x] M5 ships, flag default OFF, fixture-eval green both ways — 2026-08-18, `e1ed036`
- [x] M6 has numbers in the ledger and a Juanma call: adopt / opt-in / drop — 2026-08-20, **opt-in**
      (the pilot's scored floor table is the ledger entry; `ROADMAP-DOORDASH.md` M6, `docs/scout-design.md` §3.17)
- [x] C4 is in front of every prompt that inlines user-authored text — 2026-08-20, `d0cb47e` + `bbd5277`
      (`docs/c4-preamble-design.md` §5 CLOSED; all four system-prompt write sites route through
      `writeSystemPrompt`, asserted at artifact level over every `*.system.md` a real run wrote)
- [x] item 7 is live: a second push verifies (or honestly says unconfirmed), does not claim
      `resolved` from absence, and the PR shows the current state rather than an archaeology
      — **2026-08-23, ticked by Juanma on the evidence below.** Proven on **pr-hero's own PR #49**,
      not musive: no musive PR was open, and the engine reviewing its own re-review code is
      stronger evidence than an external repo, not weaker. Four live runs, $16.84, ledger in that
      PR's description; runbook surfaces walked in `docs/item7-runbook.md`.
      - **Verifies, or says unconfirmed:** case C, restricted discovery, `verify` as its own plan
        term. Four priors checked → 1 `refuted` (→ `verified-gone`, thread collapsed with ✅),
        3 `inconclusive` (→ `unconfirmed`). Zero inferred.
      - **Does not claim `resolved` from absence — and this one FAILED first.** Run 2 published
        `Δ since e23d8063: 3 resolved · 0 new · 1 persist` where two had been checked: the PR 1759
        shape, live. `postCommand` never passed `rereview`, so the delta fell back to the absence
        matcher. Fixed in `3f32def`; run 3 published
        `1 resolved (verified) · 3 unconfirmed · 0 carried · 0 deferred · 1 new`. The clause is
        ticked because it was broken, caught by the runbook's own launch-fail list, and fixed —
        not because it never failed.
      - **Current state, not archaeology:** first `pr-hero-state` block this engine has written,
        `rereview` present in `pipeline.json` and **absent** on the same PR's first review.
      - **Triage feeds it:** run 4's `verification_triggers` were `{applied: 3, touched: 0}` —
        every verify step bought by a triage tag — and the engine still returned `unconfirmed`
        rather than believing the `applied` claim. `applied` is a trigger, not ground truth.
      - **Known debt, deliberately open:** four reviews found four defects of one class
        (bookkeeping trusted without reconciling against live state), each in the code written to
        prevent it. The first three were patched per call site, which is why a fourth call site
        was still open. Read `b58c181` before the next patch to that seam.
- [x] C5: person-keys default globally, repo-keys stay in `.prhero/` — **2026-08-23**, PRs #50 + #51
      (`afc4a13`, `dab203e`). Design `docs/c5-global-config-design.md`, Judgment Day ledger
      `docs/c5-judgment-ledger.md`, README rewritten around the two layers.
      - **The rule shipped as one sentence, not a per-key table:** *the more specific layer wins,
        except where the less specific one is protecting the operator's money.* `capped` applies
        exactly where "narrower" is definable — a boolean and a spawn count, never a model string.
      - **The repo layer is the TEAM layer.** `.prhero/` is committed, so it was always shared
        through git; naming that is what closed the design's open question and it is why
        `agents_dir` stays team-overridable.
      - **`pr-hero config`** answers "why is this value what it is" through the same
        `loadEffectiveConfig` a review uses, so it cannot drift from what runs. Its row set comes
        from exhaustive `Record`s: a new config key fails tsc until it has a cell.
      - **Judgment Day before any code**: 21 unique defects over two rounds, and the second
        re-judgment caught that round one's own fix was **inert** — a return-type widening moves no
        runtime value. Without it this would have shipped a merge writing false provenance into
        `pipeline.json`, which is the failure that made M6's twelve runs unpoolable.
      - **Three live reviews, $9.37**, found three more defects, two of them ledger rows JD-9 and
        JD-10 biting exactly where they were recorded. Ledgers in the PR descriptions.
      - **Known debt, open on purpose:** ledger rows JD-6..JD-21; `pr-hero config --model x` parses
        and is silently ignored, a gap shared with `ledger`/`gc`/`usage`/`reverts` and worth its own
        slice rather than a `config`-only guard.
- [x] Canonical store (`docs/observability-canonical-store.md`): `prhero.db` is source of truth,
      JSON is derived, local server owns SQLite, backfill reported, GC does not delete rows
      — **2026-08-23**, PR #53 (`04d8f1f`). Design `docs/canonical-store-design.md`, Judgment Day
      ledger `docs/canonical-store-judgment-ledger.md`, Schema v2 (bumped to v3 by PR #54,
      `c53011e`), 55/55 historical runs backfilled.

Distribution — on a machine that is not this one:

- [x] `npm i -g pr-hero` installs the command (package is not `"private": true`, builds to `dist/`, has `bin/pr-hero.js`, `engines`, Apache-2.0)
- [x] `pr-hero init` does not mention `deep-review` or a path under `/Users/juanma` (bundled default prompt assets via `import ... with { type: "file" }` manifest)
- [x] dependency preflight names whatever is missing (`claude` / `gh` / codegraph) instead of failing mute (`src/system-tools.ts` + `pr-hero doctor` tri-state)
- [x] every knob in the table above is settable from the TUI/menus (flags remain for scripts)
- [x] `pr-hero review --dry-run` and one `--pr --post` succeed on a stranger's repo — **2026-08-25**, verified on `juanmaagd/pr-hero-landing#1`
- [x] a second push on that PR exercises item 7, not a full re-hunt dressed as a delta — **2026-08-25**, verified on `juanmaagd/pr-hero-landing#1` (Case C restricted re-review in 8s, updated in-place with `pr-hero-state`)
- [x] the Action runs on an open PR, posts, and respects the cap
      - [x] `v1` and `v1.0.0` tags published — 2026-08-25 (`aff0324`)
      - [x] live open-PR run on stranger's repo (`juanmaagd/pr-hero-landing#1`) verified end-to-end via `uses: juanmaagd/pr-hero@v1`
- [x] every report still says assistant, not merge gate (verified footer & exit code 0) — superseded by the S4 gate mode: the commit status is the gate, the exit code is not, and `mode: advisory` restores the assistant posture

### Explicitly after launch

C1b hunter-emitted fingerprint. C2 schema v1.1. C3 resume. C6 learned-knowledge. C8–C10. Scout as
**default** (that is M6's decision, not a ship checkbox). OpenCode / multi-model / D1–D3. Web dashboard
(consumes the canonical store's routes; the store itself is a launch fundamental). Live per-step
status. Fixer loop. Homebrew (nice, not blocking). Item 8 leftovers (findings browser, progress tree).
Required status check. Cancelling Greptile.

## Phase A — Graduate Phase 0 (the bar: ≥80% catch, ≤20% FP)

The two known capability gaps, in attack order:

- **A1. Lifecycle-contract pass** — the missing hunter class. Enumerate-then-contradict applied to state:
  for every effect/latch/ref/timer/subscription the diff touches, a mandatory arm/re-arm/cleanup table
  crossed against resource-change modes (switch, error, early return, stall); report empty cells.
  Targets the stable misses G2/G4/G5 (0-for-history — any repeated catch is pure signal). New prompt set
  (scored sets are immutable); surgical replays of the G2/G4/G5 trees with replicates + N-of-M reading;
  watch advisory volume and blocking precision for regressions.
- **A2. Refuter v2** — precision + completeness guard. **Built and measured 2026-08-01** (iterations
  541–543, `bench/METRICS.md`). Per-finding refuter steps via the declarative spec (kills the 27e85937
  large-batch failure by construction); eligibility is severity alone, because the triage found the gate
  was not weak but *structurally bypassed* — 26 of 26 blocking findings were `deterministic` and the batch
  filter admitted only `inferential`, so blocking tier had zero adversarial checking; verdict vocabulary
  gains `downgraded-latent` ("real but unreachable today" → advisory, never deleted — the G6 lesson);
  mandatory own-expansion per finding (visit proof_refs AND hunt the counterexample; external measurement:
  −88.6% FP for −3.1% recall); refuted requires positive disproof with cited code.

  **Calibration, restated — the original gate was the wrong instrument.** It read "G5 still reaches
  blocking tier, ≥2 of 3", which conflates refuter behaviour with hunter run-to-run variance and therefore
  cannot answer what A2 asks. G5 came back 1/3 (A1 was 2/3; pooled, the lifecycle hunter catches G5 in
  3 of 6 runs on that tree — squarely inside this benchmark's documented variance), while the refuter
  returned `corroborated` on all 15 findings it judged: it removed and downgraded nothing, so the misses
  are provably upstream of the gate. **A refuter gate must assert what the refuter DID to a finding
  (removed / downgraded / preserved), never an end-to-end catch rate.** Standing calibration for any
  refuter change, in this order:
  1. `bun run refuter-probe` — the verdict-vocabulary matrix on planted claims, cents per run. A prompt
     edit that cannot pass this does not reach a paid replay.
  2. On a golden tree: no finding the refuter judged may be removed or downgraded without a cited
     contradiction, and 27e85937's batch must complete.
  3. Blocking-tier precision reported only once the novel findings are triaged — never inferred from
     volume.

  **What remains unproven**: the −88.6% FP figure. A2 judged 15/15 `deterministic` findings where every
  pre-A2 verdict was on an `inferential` one, so prompt effect and population shift are perfectly
  collinear in the live data and no number of musive replicates can separate them. The probe falsified the
  "deferential refuter" reading (3/3 correct refutations of a planted false claim, $0.58) but only for an
  adjacent, obvious contradiction.
- **A3. Dataset decisions (Juanma) — CLOSED 2026-08-01.** All three decisions made; see below and the
  graduation/G6 entries that follow.

  **The 10 triage verdicts: ratified, with one overturned on new evidence.** The row
  *"trim range not reset on song switch"* — the only medium-confidence verdict — was marked FALSE
  POSITIVE on the same "the component remounts on song switch" defence that the G6 investigation
  disproved. Verified directly: `firstTrimValue`/`secondTrimValue` are component state
  (`AudioTrimmer/index.tsx:64-65`) cleared in exactly two places, the add-comment success path (`:483`)
  and the cancel button (`:553`); **no effect keyed on `song.song.id` resets them**. Since the component
  survives a song switch, song A's trim range persists into song B. The claim is mechanically correct —
  **latent, not false**. The other nine stand (five true positives, three of which the team independently
  fixed later; the rest high-confidence and none resting on the disproved defence).

  **Revised precision: false positives 2/15 (13%)**, down from 3/15 (20%). The ≤20% half of the bar is
  met with margin.

  **Process fix, learned the hard way**: that triage recorded verdicts WITHOUT their reasoning, so the
  disputed row could not be re-examined when new evidence arrived — the verification had to be redone from
  scratch. Record the reasoning with the verdict, always.

- **A5. Lift the lifecycle pass's reachability suppression** — the recall lever, and the one grounded in a
  provable inconsistency rather than a guess. `agents/slice3b-lifecycle-v2/deep-review-lifecycle.md`
  contradicts itself: line 74 says *"Not reportable: a mode that is unreachable by construction"*, while
  line 125 says *"You do not filter — a downstream refuter owns precision, and a finding you suppress is
  simply lost."* That suppression is **why G2 scores 0 of 4** — G2 lives in a component with zero live
  callers at its commit, so conditions (b) reachable-with-cited-path and (d) user-visible-consequence can
  never be satisfied. (The value-contract pass has no reachability criteria at all, which is exactly why
  G3 lands 4/4 in that same unwired file.)

  The suppression was correct prudence when the refuter had only two doors, delete or block: emitting an
  unreachable defect meant either a false positive or a blocked merge. **A2 built the third door**, and
  `downgraded-latent` was measured working 3 of 3 (`refuter-probe`, `latent-claim` arm). The hunter is now
  suppressing precisely the class the gate knows how to handle correctly.

  Experiment (one variable, new prompt set since scored sets are immutable): drop the reachability
  suppression, let the hunter emit unreachable-but-real defects at CRITICAL, and let the refuter demote
  them. Target G2 @ `4609456d` — a cheap tree (~$3/run, so 3 replicates ≈ $10). Report the mean per the
  graduation rule. Watch blocking volume and the `downgraded-latent` rate as the regression signals.

  **G6 ground truth — DECIDED 2026-08-01 (Juanma): G6 stays, denominator 7, and its correct verdict is
  `downgraded-latent`, not `blocking`.** The dispute was framed as real-vs-not-real and that was the wrong
  question. Verified in the code at `f961e23a`: `SongComments` renders from a single slot with **no `key`**
  and no per-song conditional, so switching songs is a same-type same-position reconciliation — React
  updates props and `AudioTrimmer` **stays mounted**, while only `<audio key={reproductionUrl}>` remounts.
  `reset()`, the only writer that arms `isWaveformLoading`, sits in a `useEffect` with `[]`. The mechanism
  is therefore real and unguarded. What could NOT be established is a live trigger: every traced path
  closes-then-reopens behind a full-viewport click-eating overlay.

  Real defect, unreachable today — which is the definition A2 wrote for `downgraded-latent`. G6 is the
  lesson it was named after: the old refuter had only two doors, delete or block, and chose delete. The
  engine's correct behaviour on G6 is to find it and demote it to advisory, which the v2 refuter was
  measured doing 3 of 3 (`refuter-probe`, `latent-claim` arm).

  Product follow-up surfaced by the same investigation, independent of the benchmark:
  `useTriggerCardSliders.tsx:32-52` opens the comments slider from an effect with **no `sliderBoxContent`
  guard**, while its three sibling effects all have one (`views/Project/index.tsx:229,:290`,
  `views/PublicProject/index.tsx:233`). That missing guard is the only thing keeping G6 latent rather than
  live.

  **Graduation semantics — DECIDED 2026-08-01 (Juanma): a golden's score is the MEAN over its replicates,
  not a threshold.** A golden caught 2 of 3 times contributes 0.67, never 1.0. The reason is production:
  the engine runs **once per PR**, so the mean is literally the expected catch rate a real PR experiences,
  and a threshold answers a continuous reality with a binary. The prior unratified "≥2 of 3" rule had
  already broken on its own terms — G5 on the same tree scored 2/3 under A1 and 1/3 under A2, flipping
  from "caught" to "missed" on noise alone, while 3/3 and 2/3 counted identically.

  Two consequences, both accepted deliberately:
  1. **The bar gets harder.** ≥80% catch now means near-deterministic catching, not "caught at least
     sometimes". A bar that flatters the engine cannot decide whether to cancel Greptile.
  2. **Most historical scores become UNKNOWN rather than known.** They were single runs, and a single run
     has no mean. Converting them requires replicates. Recording them as unknown is more truthful than
     promoting one sample to a verdict.

  **The scoreboard, measured clean (2026-08-04, set `slice3b-lifecycle-v6-clean` `8671784895536467`).** Every
  number before this line was produced by a prompt whose worked examples named the goldens' own anchors — see
  the contamination correction in `../deep-review/bench/METRICS.md`. These are the first scores that are not:

  | golden | clean | before | note |
  |---|---|---|---|
  | **G4** | **1.00** (3 of 3) | 0.33 under A7, 0.00 across six runs before | single-variable v5→v6; removing the leak **tripled** it |
  | **G3** | **0.33** (1 of 3) | 3 of 3 under A5 | its severity calibration WAS the leak; ~0.33 is the honest rate |
  | **G2** | **0.00** (0 of 3) | 1 of 3 under A5 | does not reproduce without the leak; A5's headline stays retired |
  | **G1** | **0.00** (0 of 3) | 0 of 3 | unchanged |

  Only G4's row is a clean single-variable comparison. The G2-tree rows span three changes (A6, A7, the
  decontamination) and show direction, not cause — isolating them needs an arm that does not exist, v3 with
  clean examples. **Stated plainly: the benchmark was reading higher than the engine deserved on at least two
  goldens, and the only number that went UP when the prompt was cleaned is the one A7 earned.**
- **A4. Held-out benchmark** — only after the smoke-level bar is met: full run over the lab's
  `dataset/test.jsonl` (first and only read), measure against the bar, F2/SNR reported alongside. This is
  one of the few places a full smoke-scale run is mandatory.

- **A6. Make the stall row writable — BUILT, MEASURED, AND FALSIFIED 2026-08-02.** Diagnosed 2026-08-01 for
  $0 from artifacts on disk; the diagnosis was wrong, and the measurement that proved it is below. The reasoning
  is kept in full because it is the record of what was believed, why it was plausible, and exactly which claim
  the experiment killed.

  The lifecycle prompt names the mode explicitly (line 55: *"**Stall** — the op neither succeeds nor
  errors (an event never fires, the network hangs, media never reaches...)"*), so this is a compliance gap,
  not a design gap. Yet G4 — whose golden is exactly a missing stall backstop — scored **0 of 3**, and the
  hunter's own drafts from iterations 531–533 show what it produced instead: switch-mode findings, three
  runs running. The hunter works. The stall row is never generated.

  **Why, precisely.** Condition (c) demands *"no disarm or re-arm actually FIRES in this mode … Prove it by
  having read the whole owner plus every cleanup reachable via `codegraph_explore` — **not merely by not
  having found one yet**."* Switch, error and early-return are events that exist in the code: there is a
  line to cite. A stall is the absence of every event — there is nothing to point at, and (c) explicitly
  rejects "I did not find one" as proof. **Stall is the one mode whose burden of proof is unsatisfiable by
  construction**, so the row never gets written.

  How stark the miss is: at G4's tree (`27e85937`) the file contains **zero `setTimeout` occurrences** — the
  absence is total, not subtle. (Its sibling commit `f961e23a` has 3; the two are divergent, not
  parent/child.)

  Fix, following A5's template: turn *"I searched X, Y and Z and no disarm fires on a stall"* from an unmet
  burden into a **reportable statement**, exactly as A5 did for reachability. Built as
  `slice3b-lifecycle-v4-refuter` (`e5d9d0a10f3edbfe`): a **completed enumerated sweep** counts as positive proof
  (owner read in full with cited bounds → every ledger-named cleanup hop → backstop primitives searched by name
  with counts reported including zeros → the awaited operation followed into whatever performs it), plus a fourth
  absence-anchor form, both confined to mode 4.

  **Result — iterations 561–563, $33.65, G4 0.00 (0 of 3).** Not a single stall row was written. A grep over
  `claim` and `proof_refs` of every finding from every hunter in all three runs for
  `stall|backstop|timeout|never fires|swept|sweep|setTimeout` returns **zero hits**; the lifecycle hunter
  produced switch-mode findings again, the same shape as iterations 531–533. The prompt was clean before it ran
  — two rounds of blind dual review, five defects confirmed by both judges and corrected, plus one fix-caused
  defect caught in round two — so this is a falsified hypothesis, not a defective arm.

  **What it kills.** The diagnosis above says the stall column is empty *because* condition (c) demanded proof of
  a non-event and so could not be satisfied. A6 removed that impossibility and the row was still never written.
  **The proof standard was not the binding constraint.** A gate can be unsatisfiable and still not be the reason
  a thing does not happen — the hunter was never reaching the gate.

  **Cost lesson, recorded because it was a real error:** the ~$21 estimate was carried from this document
  without checking the tree. G4's tree is 45 files / +2775 −1237, so it bills ~$11/run, not ~$7. Estimate from
  the diff, never from a sibling golden.

- **A7. Force the cell to be generated — BUILT, MEASURED, AND IT WORKS. 2026-08-03.** Iterations 571–573,
  $48.30, set `slice3b-lifecycle-v5-refuter` (`fda1b839b067cb9d`). **G4 0.33 (1 of 3) — the first catch of G4 in
  the campaign's history**, against 0 of 6 before it. The lever A6's failure pointed at, and the first one
  grounded in a negative result rather than a reading of the prompt.

  **The mechanism is the result, and it is unambiguous.** All three runs emitted the `cells` array — 15, 20 and
  25 entries, i.e. 3, 4 and 5 resources × exactly five modes, so the completeness rule held — including **3, 4
  and 5 stall cells**, with verdicts spanning the whole vocabulary (`defect`, `clean`, `incoherent`,
  `unresolved`). A6 on this same tree produced zero stall anything. **Cell generation was the binding
  constraint.** A6 made the stall row permissible; A7 made it generated; they are complementary, which is why v5
  builds on v4 and the chain is measured at each step. The catch (iteration 572, F012, CRITICAL/blocking): the
  `<audio preload="metadata">` element has no timeout or deadline, and only `onLoadedMetadata`/`onError` can end
  `isWaveformLoading`.

  Cost lesson, again: $48.30 against a ~$34 estimate. The table costs output tokens and the estimate was taken
  from A6's per-run cost without adding them. **Two arms, two overruns, one root — estimating from the previous
  arm instead of from what the change does.**

  Step 2 tells the hunter to cross every ledger row against all five modes and says *"the unit of judgement is
  the **cell**, not the row"*. Three runs of evidence say it does not do that: it builds the ledger, finds a
  defect in an early mode (switch, every time), and reports that instead of completing the cross-product. The
  stall cell is never generated, so no proof standard — satisfiable or not — is ever reached. That also explains
  why A6's carefully-widened burden changed nothing.

  Experiment (one variable): make the cross-product an **output obligation**, not an internal instruction —
  require the mode table itself in the response, every row × every mode, each cell carrying one of
  `defect | clean (cited) | incoherent (why)`, emitted *before* any finding. A cell the hunter must fill is a
  cell it cannot skip. Target G4 @ `27e85937` again, since its golden is the one a completed table must surface,
  and it is now the only tree where a null result is informative. Budget ~$11/run × 3 ≈ **$34** — verify against
  the diff before committing to the number. Watch total findings and blocking volume: forcing a table is the
  lever most likely to produce a firehose, and that is the regression signal.

Gate to Phase B: bar met on the held-out set.

## THE PIVOT — 2026-08-10. The golden dataset is retired as the benchmark.

Decided by Juanma, and it reorders everything below: **stop improving the number, stabilize a version,
wire it up, and take the numbers from running in parallel with Greptile on live PRs.** His words:
*"dejemos de dar vueltas para mejorar el número"*, and — the constraint that reframed the method —
*"no me importa el gasto, me jode más el tiempo que está llevando esto."*

Cost was never the binding constraint; TIME WAS. The $0-diagnosis-first discipline and three rounds of
blind review over a six-line prompt edit saved money and spent sessions. That trade was mispriced.

**What replaced it.** Greptile already reviews every PR, so it is the oracle: nobody has to know in
advance whether a PR contains a bug. `pr-hero review` on the PR, `scripts/compare-pr.ts` against
Greptile's own comment, three buckets. **~$3 and ~4 minutes per PR**, on code from this week — against
a session and $12+ for one arm on July trees whose dataset turned out contaminated.

**First run, 8 PRs (1676-1684), $23.51, and the headline was not the one expected:**

| | Greptile | pr-hero | |
|---|---|---|---|
| 1677 | 1 (real bug: duplicate React keys) | 0 | **measured miss** |
| 1682 | 1 (style) | 3 blocking | pr-hero only |
| 1683 | 1 (convention) | 0 | out of scope |
| 1679 | 0 | 2 advisory | pr-hero only |
| 1684 | 0 | 1 blocking | pr-hero only |
| 1676, 1678, 1681 | 0 | 0 | agreement, clean |

**Greptile-only 3 · Both 0 · pr-hero-only 6. The overlap is ZERO.** In eight PRs they never once found
the same thing. These are not two reviewers on one scale — they have different biases. Greptile sweeps
wide and flags convention; pr-hero digs into lifecycle and state machines and says nothing elsewhere.

Two pr-hero findings verified by hand in the code:
- **1682** — `RenameSlider/index.tsx:65` passes `enabled={!isLoading}` to a `styled(TouchableOpacity)`
  whose `enabled` only drives `opacity` (`Styles.ts:8-16`). `TouchableOpacity` has `disabled`, not
  `enabled`. The button dims to 50% and stays pressable: **the UI lies**. Greptile reviewed that PR.
- **1679** — `LoadingSpinner.tsx:7-19` starts `Animated.loop` with `useNativeDriver` and returns no
  cleanup, in a component unmounted every time loading ends. Correctly tiered advisory, not blocking.

Zero false positives across the five PRs Greptile passed clean. The profile, now measured rather than
assumed: **high precision, narrow coverage.**

**What this does to the north star.** This document says the goal is to cancel Greptile ($912-1632/yr).
At zero overlap that question is malformed — each covers what the other does not. Cancelling Greptile
today loses 1677's duplicate keys; dropping pr-hero loses 1682's lying button. The decision is what each
is FOR, and the head-to-head answers it per PR for the price of a coffee.

**Update 2026-08-16 — the overlap is no longer zero, and the instrument has a named blind spot.** Over
the 15 PRs that now carry a `comparison.json` (19 runs, 1682–1724): **11 `greptile_only` · 13 `both` ·
28 `prhero_only`**, with only 12 of ~50 rows triaged. "Zero overlap" was true of the first eight and is
history; do not quote it as the current profile. And whatever the buckets say, they are two of four
confusion cells — they cannot see what BOTH reviewers missed, so "both passed it clean" is an unobserved
cell, not a measured true negative (Phase C, C10). The head-to-head stays the instrument; it is read with
that limit stated. `ROADMAP-DOORDASH.md` M0 triages the eleven `greptile_only` rows so the scout-probe
has real targets.

**Phase A is closed.** A8 (`slice3b-lifecycle-v7-cellproof`, lab `4da15bd`) was its last arm and it
worked on both mechanism gates — `incoherent` cells fell 55%→37.5%, defect cells rose 2→5, and G2's own
cell went from 0-of-3 to 2-of-3 adjudicated `defect`. It was deliberately NOT scored against the
goldens: scoring it would have been the exact loop this pivot ends. A4 (held-out set) does not run;
`dataset/test.jsonl` stays sealed, now permanently unless the decision is revisited.

**Next session starts at Phase B.**

## Phase B0 — Local mode (usable NOW, deliberately not gated on the bar)

Added 2026-08-04, and it corrects a conflation this document was making. Phase B was gated on the
benchmark bar because it *cancels Greptile* — a fail-closed merge gate had better not have holes. But
"Juanma can run it on a PR and read what it found" needs none of that, and the roadmap was making him
wait on a research campaign to touch his own tool.

The bar has two halves and they are in very different places: **precision is already met** (2/15 false
positives, 13%, against a ≤20% target) while **recall sits at 0.33** over the four goldens measured
clean. A tool with good precision and mediocre recall is useless as a GATE and genuinely useful as an
ASSISTANT — what it tells you is mostly true, it just does not tell you everything. That is exactly the
profile B0 ships.

`pr-hero review [--repo --base --head --agents --out --model --hop-budget --dry-run --yes]`
(`src/cli.ts`, pure decisions in `src/preflight.ts`, renderer in `src/report.ts`). It resolves refs,
generates the diff, preflights, runs the existing pipeline unchanged, and writes `findings.json` plus a
markdown `report.md`. Explicitly OUT of scope: posting to GitHub, the required status check, anything
fail-closed. Those stay in Phase B behind the bar, where they belong.

Three things it fixes that were latent, each found while building it:

1. **`defaultReviewSpec()` omits the lifecycle hunter.** Running the 5-file clean set with the 4-agent
   default silently drops the hunter the entire 2026-08 campaign is about, and nothing downstream
   notices. Local mode ships an explicit 5-agent spec and a **bidirectional** agents-dir preflight —
   every spec file must exist, and every agent file present must be referenced.
2. **Nothing in either repo measured a diff's size.** Two recorded cost overruns (`~$21`→actual,
   `~$34`→`$48.30`) share one root: estimating from the previous arm instead of from the change.
   `estimateCost` now reads `git diff --numstat` and prints a BAND before anything spawns, with its two
   calibration points named in the output. It is a guide, not a quote — the same tree has billed 34%
   apart across runs.
3. **A dirty working tree used to be reviewable.** Every step runs with the repo as cwd, so uncommitted
   changes get reviewed but never reported. Local mode refuses to run on a dirty tree or a head that
   does not match `HEAD`.

`--dry-run` is the $0 gate and does everything except spawn: resolve, preflight, diff, plan, cost band.
Use it first, always. The plan also surfaces that steps run under `--permission-mode bypassPermissions`
bounded only by each agent's read-only tool allow-list — the user should see that before every run, not
find it in the source.

Gate to Phase B: unchanged — the bar, on the held-out set. B0 does not move it and does not pretend to.

## Phase B — Production wiring

> **🔒 Item 7 is BLOCKED on `ROADMAP-DOORDASH.md` and item 8's review surface is DONE.** **Amended
> 2026-08-20:** M6 is decided (opt-in — scout behind `--scout`, default OFF), so the gate now rests on
> **condition 1 alone — M1 seen live**, which has not happened. Item 7 is NOT unblocked; it is blocked on
> one narrower thing. The conditions themselves are unchanged — do not rewrite them. **As of THE LAUNCH
> LINE (amended 2026-08-18) item 7 IS a launch fundamental**, so M5→M6→C4→item 7 is on the ship path, not
> a parallel research sideline. C5 is distribution pillar 1. C1b, C2, C3, C6, C8, C9, C10, and named review pipelines (`docs/review-strategies.md`) stay after launch
> and touch the DoorDash track nowhere. Only C7 (the scout *stage*) is the experiment; scout-as-default
> was M6's call and it went to opt-in.
>
> If the session is shipping: THE LAUNCH LINE, fundamentals first — M5 shipped 2026-08-18 (`e1ed036`) and
> M6 decided 2026-08-20, so right now that is **seeing M1 live** (condition 1), **C4** or the **canonical
> store** (they do not gate each other). Distribution pillars can proceed in parallel; item 7 cannot.
>
> **M6's corpus precondition is ALREADY MET — do not re-run `pr-hero corpus` and do not re-adjudicate.**
> §3.11's 2026-08-17 amendment asked for the floor test to be grown past its five cases before M6, and
> that happened in `c48fc9a`, `61a6fb9` and `de004ec`: **13 cases over 12 PRs**, canonical in
> `docs/scout-design.md` §2.4septies, each coordinate re-verified against the reviewed PR's own tree —
> which is the amendment's "adjudicating past the overstatement" branch, taken. A session that re-runs
> the corpus burns itself redoing finished work. What M6 actually lacks is INSTRUMENTS, not cases: the
> floor-test scorer and the run harness. Neither costs money; see the M6 entry in `ROADMAP-DOORDASH.md`.
>
> Before anything: item 8's entry below still says `IN PROGRESS 2026-08-12 (branch feat/terminal-ui)`.
> All three claims are false — the four `ui-*` modules are on `main`, `renderResult` is wired at
> `cli.ts:756` and `cli.ts:1393`, and that branch does not exist. Verify and close the entry first, or the
> next plan is built on something already shipped.

Gate removed 2026-08-10: this no longer waits on the bar. See THE PIVOT above.

Where it already stands: `pr-hero review` runs with zero flags inside a configured repo, the diff comes
from the merge base, `.prhero/` carries gotchas/priors/agents_dir, `pr-hero` is a linked global command,
and `scripts/compare-pr.ts` does the head-to-head read-only through `gh`. Eight PRs have been through it
end to end.

What is still manual, in the order it should be closed:

1. **`pr-hero review --pr <n>`** — the one command. Resolve head and `mergeCommit^1` through `gh`, create
   the detached worktree, ensure its own codegraph index (never reuse another checkout's — different
   bytes), run, then compare against Greptile automatically. Today that is ~6 hand-run steps per PR and
   it is the single biggest friction left. Worktree teardown is `git worktree remove`, never `rm -rf`:
   a live index holds an open `.codegraph/daemon.sock`.

   **BUILT 2026-08-10** (`src/pr.ts` I/O + `src/pr-preflight.ts` pure decisions). The design's spine is
   two roots, deliberately assigned: the OPERATOR checkout (gh + git cwd, `.prhero/` trust anchor, run-dir
   anchor; its dirtiness is irrelevant and both local gates are skipped there on purpose) and the REVIEW
   worktree (`~/.prhero/repos/<origin>/worktrees/pr-<n>`, pipeline cwd, owns its codegraph index — the
   availability check runs against IT, or hunters would ride another checkout's index). Two operator
   checkouts of the same origin share that tree; `git worktree add` runs against the registered
   git-dir owner (W3 / #24). MERGED resolves
   base to `mergeCommit^1` (base as it was when the PR landed — squash/rebase/merge all converge at the
   fork point via the existing merge-base default); OPEN/CLOSED use `baseRefOid`. The fetch rides
   `refs/pull/<n>/head` because a merged PR's branch is usually deleted. `--dry-run` is fetch-free and
   creates nothing: the cost band rides GitHub's own diff counters. Worktrees are KEPT AND REUSED
   (Juanma's call, 2026-08-10): reuse requires HEAD == PR head AND a clean porcelain ignoring the
   always-untracked `.codegraph/`; head-moved or dirtied trees are recreated via
   `git worktree remove --force` (verified: plain remove refuses on the untracked index). W3 / #18:
   unbounded keep is forbidden — `pr-hero gc` (the watcher tick / the end of `review --pr` /
   the optional `gc install` launchd agent) collects a tree
   when the PR is merged/closed OR it has sat idle >72h, whichever first; teardown is still
   `--force`, never `rm -rf`. Remaining home hardening (owner-gone recovery, runs
   TTL, I/O tests) is parked as GitHub #35 — live with W3 until a witness; do not fold it into
   W4. Exclusive worktree/registry locks landed with #24's follow-up on PR #36; GC's
   `gh pr view` is bounded so a stall cannot pin a review or watch lock. The Greptile
   comparison runs in-process and emits `comparison.md` + `comparison.json` — B4's seed, rows carrying
   `verdict: null, reasoning: null` (the A3 lesson) and the run's `run_status`; a run where every hunter
   died writes NO comparison at all, because "pr-hero 0" from a review that never happened would land in
   the ledger as a measured miss. Verified for $0 against real PR 1682: offline gates (289 tests), the
   fetch-free dry run, and a declined-confirm run that exercised fetch, `^1` resolution, merge-base and
   the real numstat (gh's counters matched exactly). Unexecuted until the first paid run: worktree
   creation, `codegraph init`, the pipeline itself, comparison writing. Known edge, loud by design: a
   CLOSED-unmerged PR whose base branch was deleted fails at the fetch. With musive-s3's `.prhero/`
   already populated, the whole command inside that checkout is literally `pr-hero review --pr <n>`.
2. **Post the report to the PR** via `gh` — orchestrator-only I/O; the spawned steps are sandboxed away
   from `gh` by `--strict-mcp-config` and `--setting-sources ""`, and that stays true.

   **BUILT 2026-08-10** (`--post`, explicit and never default; needs `--pr` by parseArgs rule).
   Idempotent by construction: the comment leads with `PR_COMMENT_MARKER` (`<!-- pr-hero-report -->`),
   and posting finds the NEWEST marked comment and PATCHes it in place — one comment per PR, re-runs
   refresh instead of stack. The body travels on stdin (`-F body=@-`), so no ARG_MAX and no shell. The
   public comment carries findings, the reviewed range, `run_status` and the engine identity — never
   cost or tokens, and always the not-a-merge-gate disclaimer, because at the measured recall this
   engine has no business implying it gates anything. A `sessionFailed` run never posts (a clean-bill
   comment from a review that never ran would be a public lie); a posting failure exits 1 because it
   was explicitly asked for. Verified boundary, stated plainly: the READ path (comments fetch now
   carrying ids) is live-verified against PR 1682 — where a `<!-- linear-linkback -->` bot comment
   confirmed in the wild why marker matching is exact-prefix; the WRITE path (POST create, PATCH
   update, stdin body, response-id parse) has never executed and stays that way until an authorized
   live post. The live protocol is TWO posts: the first proves create, an immediate second must report
   `updated` with the SAME comment id — one post alone leaves the idempotency untested.

   **Amended 2026-08-16 (`docs/doordash-audit.md` §2).** "A `sessionFailed` run never posts" guards the
   extreme case only. A `partial` run — some hunters died, the survivors found nothing — still posts the
   ✅ "found nothing to report" line with `partial` disclosed only in the `<sub>` footer. That is
   DoorDash's "never post a false-clean review" one notch over, and it is **issue #42**, first milestone
   of `ROADMAP-DOORDASH.md`.
3. **Trigger** — `branch-pr` hook or a local watcher (launchd/cron) so a review happens rather than being
   remembered. Note this spends money per PR without asking, so it needs an explicit opt-in.

   **BUILT 2026-08-11** (`src/watch.ts` I/O + `src/watch-preflight.ts` pure decisions; design ratified by
   Juanma the same day). Reframed during design: pr-hero is OSS, so the trigger is a PRODUCT feature —
   trigger adapters over the same `review --pr` command. The GitHub Action adapter stays in Phase E by
   Juanma's call; B3 is the local adapter. Tick model, never a daemon: launchd (or cron + the advisory
   lockfile) fires `pr-hero watch --once`; a workless tick costs one `gh pr list` per repo, and the gate
   (window/cap) runs before ANY call. Opt-in is structural — `~/.prhero/watch.json` lists exactly the
   repos the watcher may spend on, `post` per repo (ON for musive, OFF is the OSS default), global
   `daily_cap` (5) protecting the shared subscription-quota window, optional local-time window. The cap
   counter is watch.log itself, appended BEFORE each spawn: over-counting skips a review, under-counting
   is unbounded spend. Eligibility is per (pr, head) — a push re-arms the review so the posted comment
   tracks the live head: open non-draft, no comparison.json match (parsed fields via the ledger parser,
   never dir names), no marked comment declaring the head, and <2 artifact-counted attempts (poison-PR
   guard). The cross-machine guard rides the marker: it now carries `head=<sha>` and matching moved to
   the bare prefix `<!-- pr-hero-report ` so pre-B3 comments still PATCH instead of stacking (pinned by
   tests). Known debt, accepted ("no es perfecto pero está bien por ahora"): two watchers on one repo
   can duplicate one review inside a ~10-min race window (the PR still converges to one comment), and
   `post: false` has no shared state at all — exactly-once needs central event delivery, which is Phase
   E's Action; until then the operating model is one watcher per repo per team. Verified offline (428
   tests, marker back-compat pins, full eligibility matrix); the live tick, launchd install and first
   auto-spawned review are UNEXECUTED — `pr-hero watch --once --dry-run` is the $0 gate, always first.

   **Deferred by design (Juanma, 2026-08-11): parallel PR reviews per tick.** Today the tick is ONE
   review, FIFO by PR number, and the queue drains at ~4 PRs/hour — deliberate, because each review is
   already internally parallel (the hunter fan-out) and K simultaneous reviews would contend for the
   same subscription-quota window, CPU and rate limits while making the cap and the log illegible.
   Revisit when musive's PR volume outgrows the drain rate: the cheap knobs are a shorter interval or a
   `reviews_per_tick: K` config (needs per-PR locking and concurrent log-append discipline). True
   per-PR parallelism — one runner per PR, instantly — is what Phase E's GitHub Action gives for free,
   so measure whether the local knob is worth building before the Action makes it moot.

   **The missing input for that revisit, named 2026-08-16:** DoorDash posts ~7 minutes after a PR opens
   and argues that a comment arriving after a human already reviewed is acted on less — the change is no
   longer fresh. We record run duration (`wall_ms`), not PR-opened → comment-posted latency, which spans
   the tick interval plus the serial drain plus the run. Until that column exists (#23), "does the drain
   rate cost us relevance" has no number. Add the column before deciding `reviews_per_tick`.
4. **Accumulate the head-to-head** into a ledger across PRs, so the three buckets become a rate rather
   than a snapshot — a rate of *disagreement*, never a recall or precision figure: the buckets are two of
   four confusion cells (see THE PIVOT's 2026-08-16 update and C10). Six of the eight findings so far are unverified one by one; a verdict column with its
   reasoning is required — the A3 lesson was that verdicts recorded without reasoning cannot be
   re-examined when new evidence arrives.

   **BUILT 2026-08-10** (`pr-hero ledger [--repo --runs --out]`; pure half in `src/ledger.ts`).
   Sweeps `<runs-root>/*/comparison.json`, parses each back with loud per-field validation (a silently
   mis-read artifact becomes a silently wrong rate), and renders one markdown ledger to stdout. The
   denominator rule is the design: **one PR, one vote** — only each PR's latest run counts toward the
   totals (ordered by the new `generated_at` stamp, mtime as the fallback for files that predate it),
   because totals over all runs would let a re-reviewed PR vote twice. Verdicts are tallied AS-IS,
   whatever strings the triage wrote — the ledger reports the triage's own vocabulary and never defines
   a taxonomy; the A3 lesson lives in each row's reasoning, not in an enum invented before any triage
   happened. A **Pending triage** section names every verdict-null row of every latest run with an
   actionable identity (finding id or Greptile index + path:line), and the closing line routes verdicts
   INTO the run's own comparison.json. Verified against the real runs root: the 1682 row renders
   1/0/4 with 0/5 triaged and all five pending identities; counts stay counts ("N of M"), no
   percentage theater on small denominators. comparison.json gains `generated_at` (ISO 8601, stamped
   by the I/O shell — the pure builder owns no clock) going forward; no artifact carries it yet, since
   the stamping call site first executes on the next paid run.

5. **The size gate — "PR too large → skip"** — **BUILT 2026-08-11** (`src/size-gate.ts` pure;
   wired into local review, PR review, and the watcher). Defaults: **1500 effective changed lines,
   150 effective changed files**, with generated content (lockfiles, `*.min.js`/`*.min.css`, `*.snap`)
   excluded before the count. Escape hatches: `--force`, `--max-changed-lines`, `--max-changed-files`
   (0 disables a limit); per-repo thresholds ride `watch add`.

   **The gate has one direction, and two later sources name the other (2026-08-16, second pass —
   `docs/doordash-audit.md` §7).** Today a PR is either too big (skip) or reviewed at full price: five
   hunters, the refuter leg, the summarizer, whether it changed three lines or 1,400. Cloudflare tiers by
   the same inputs this gate already computes — trivial (≤10 lines, ≤20 files) gets two agents and a
   cheaper judge, lite (≤100) four, full otherwise or on any security-sensitive path — at $0.20 / $0.67 /
   $1.68, and 40% of their reviews landed in the two cheap tiers. DoorDash says "skip expensive passes on
   low-risk PRs" without a mechanism. This is a Phase C candidate, not a Phase B one: which hunters run
   changes what is found, so it is measured (one variable, on the control set) and it does not land inside
   `ROADMAP-DOORDASH.md` M6's window. The classifier is pure and belongs beside this gate; the policy —
   which agents per tier, and whether `parity_trigger_paths` generalises to "security-sensitive → always
   full" — is the design. Salesforce names the third answer to "too big": regroup the diff into logical
   units and review those, instead of skipping. Recorded as an option, not a plan.

   The line default moved 1500 → 2500 → 1500, and the round trip is the point. 2500 was a response to
   this repo's own PR #1 (1603 lines) being refused while its cost band read $3.18–6.86 — the gate
   firing where its stated reason did not hold. The real cause was found later: the gate counted lines
   it was not filtering (exclusions shrank the COUNT but the hunters were still handed the unfiltered
   diff, so the bill was never reduced) and counted formatting noise it should ignore. Both are fixed —
   `diff.patch` IS the effective diff (`diff.raw.patch` keeps the unfiltered bytes for audit, and
   `pipeline.json` records the dropped paths), and where git is reachable the count comes from
   `git diff -w --ignore-blank-lines --numstat` — so 1500 measures what actually gets paid for. The
   830..4000-line cost band remains unmeasured. An all-excluded diff is now a `nothing-to-review` exit
   (and its own watcher skip reason) instead of three hunters spawned on an empty patch.

   The whitespace-blindness is ASYMMETRIC by necessity: the PR dry run and both watcher tiers read
   GitHub's counters (`additions`/`deletions`/`changedFiles`, `gh pr view --json files`), which carry no
   whitespace information at all. Those paths label themselves estimates and can only over-count.

   **2026-09-25 — the line default moved again, 1500 -> 4000, and the action's own default 1000 ->
   4000.** Owner decision, not a measurement: 1500 was skipping too many real PRs outright. The
   830..4000 band above is still unmeasured — this just picks the top of it.

   The gate runs BEFORE the cost-band `confirm()`, never behind it — the watcher passes `--yes`, so a
   gate inside the prompt would never fire in the one place unattended spend actually happens. In
   watch mode the skip is `too-large`: it consumes no poison-PR attempt, writes no marker, and does
   not arm the on_push one-review-per-PR state, so a force-push that shrinks the PR re-qualifies it on
   the next tick. The watcher tiers its check — GitHub's aggregate counters ride free on the existing
   `gh pr list`, and only a PR that exceeds a limit costs a second call for per-file data.

   **The WHY was COST AND PREDICTABILITY, and only that**: small trees bill $1.9–$4.8, the 45-file
   bench tree billed $6.58–$17.92 across 18 iterations — ~3x the cost with ~2.7x the spread.

   **UPDATED 2026-08-12 — the size↔quality question is no longer unmeasured, and this entry used to
   say it was.** The scope probes ran and are reported here for the first time; the scripts are now
   tracked in `scripts/` rather than living untracked in a working tree.

   The first run (`scripts/scope-probe.ts`, ±12-line-window scoring) put G2 at **full 1/8 vs narrowed
   6/8, Fisher two-tailed p≈0.041**. That instrument was then proven broken in BOTH directions by the
   mechanism-scored G3 probes — it swallowed a real hit (`index.tsx:139` IS G3, 14 lines from the
   golden's recorded line) and credited a non-hit (`index.tsx:108` matched no golden at all). A number
   from an instrument that errs both ways cannot be corrected, only re-measured.

   `scripts/scope-probe-scored-g2.ts` re-measured it with the lab's pairwise mechanism judge
   (`runner/scorer.ts`'s SAME MECHANISM OR NO MATCH rule) as the ONLY changed variable — same tree,
   same `narrowPatch`, same lifecycle agent, codegraph off in both arms. Result over 8 replicates
   (`../deep-review/bench/probes/scope-probe-scored-g2.json`):

   | arm | G2 (`:96`) | findings/run | novel/run | cost, 8 runs |
   |---|---|---|---|---|
   | full | **0/8** | 0.63 | 0.63 | $6.71 |
   | narrowed | **4/8** | 0.63 | 0.13 | $4.41 |

   Fisher two-tailed **p≈0.077**. Against the reading PRE-REGISTERED before the run — deliberately,
   because the author had a stake in the exciting outcome — this is the "narrowed materially above
   full at a comparable margin" branch: **the headline SURVIVES the instrument fix.** The instrument
   changed, the number moved, the direction held.

   The unexpected part is the shape, not the size: total findings per run are IDENTICAL across arms
   (0.63), while novel non-golden findings fall 0.63 → 0.13. Narrowing does not produce less — it
   REDIRECTS attention onto the defect that matters. It is also ~34% cheaper.

   **Limits, stated as loudly as the result**: one golden, one tree, one hunter, n=8, and p≈0.077 has
   lost conventional significance. This is evidence, not proof, and the probe's own pre-registration
   says it is "still not a licence to redesign anything". G1 (`:111`) and G3 (`:153`) scored 0 in both
   arms and are confounded by which hunter slot ran, so they license nothing on their own.

   **What it does change**: this entry may no longer claim the thresholds rest on cost alone. There is
   now directional evidence that a narrower diff reviews BETTER, which means forcing past the gate on
   a large diff may cost recall and not only money — worth knowing, since pr-hero's own PR #4 needed
   `--force` at ~3330 changed lines. Attention dilution remains falsified as a MECHANISM
   (`fixtures/scale-probe.ts`), and these two results are not in conflict: nothing here says the
   hunter degrades with size, only that a narrowed diff concentrates it.

6. **Speak where the conversation happens — the inline surface.** NOT BUILT. Named 2026-08-11, and
   **RE-SCOPED 2026-08-12 after measuring Greptile instead of theorising about it** (musive PR 1583).
   Today pr-hero posts once and leaves: `--post` creates or PATCHes one marked issue comment, and that
   is the whole of its voice. `fetchPrComments` exists but never listens — its three callers are the
   watcher's marker guard (`watch.ts:320`), Greptile's comment for the head-to-head (`pr.ts:355`), and
   finding our own comment to update it (`pr.ts:402`).

   **What the measurement changed.** The entry used to say this slice had to *adjudicate a human's
   objection* — "a judgement step and therefore a spawned step with its own cost". The reviewer this
   project is benchmarked against does not do that and never has. On 1583 Greptile posted, Juanma
   replied at 13:31, and Greptile's 13:35 "answer" was a brand-new top-level finding on different
   lines. **It never argues; it re-reviews.** Juanma confirmed the behaviour and ruled out even an
   emoji acknowledgement. The machinery that loop needs already exists here: the `on_push` knob
   (`bf85a6d`).

   Greptile's actual architecture, measured, is a **split of surfaces by job**: ONE issue comment
   PATCHed in place as *state* (created 12:59:04, updated 13:42:38 across two fix rounds — carrying the
   summary, a confidence score whose prose narrates the delta since the last round, and a
   `Comments Outside Diff` fallback bucket marked `<!-- greptile_failed_comments -->` for findings
   GitHub refuses to anchor), and N inline review comments posted per round as *events*. That split is
   not cosmetic: **a PATCH to an issue comment notifies nobody**, so the summary is silent by nature and
   every notification rides the inline comments. It is the reason "answer back" cannot be bolted onto
   `--post`.

   **This slice (Juanma's scope call, 2026-08-12):** per-finding inline review comments via one review
   submission per run (`POST /pulls/<n>/reviews`, `event: COMMENT`, `comments[]` — Greptile's own shape,
   one notification instead of N, and partial failure collapses into one call); a `Comments Outside
   Diff` bucket in the summary for the un-anchorable, with permalink; **cross-run identity** so a
   re-review does not duplicate every unfixed finding; and a deterministic delta line
   (`N resolved · M new · K persist`) — our confidence score, computed rather than written.

   **Content split (Juanma, 2026-08-12): one finding, one place.** Every anchorable finding goes
   inline, advisory included, and `renderPrComment` **stops listing findings by tier** — the summary
   keeps the counts, the delta line and the outside-diff bucket, nothing more. This is the measured
   Greptile split, and the reason is re-review: two views of the same finding must be kept coherent on
   every push, and the one that drifts is the one that lies about what is already fixed. The cost is
   accepted and stated — the Conversation tab no longer shows at a glance what was found; Files changed
   does.

   **Cross-run identity is a MATCHING problem, not a key lookup, and that is load-bearing.** None of
   the three candidate keys survives a second run: `dedupe_key` is emitted by the LLM hunter
   (`HUNTER_OUTPUT_CONTRACT`, `pipeline.ts:208`; validated only as a non-empty string,
   `findings.ts:238`), `root_cause_id` derives from its first `proof_ref`, and `F00N` is positional,
   reassigned every run (`pipeline.ts:480`). What does survive is on GitHub's side: a review comment
   carries `line` kept current as pushes land, plus `original_line`/`original_commit_id`. Verified on
   1583 — comment `3674442892` was posted at `original_line 478 / original_start 471` on `63c96934` and
   now reads `line 511 / start 504` on `ecdc4808`. **GitHub tracks the drift for us**; matching runs
   over the live `line` by path plus a window (precedent: `compare.ts`, ±25). Identity is stated on each
   comment as `<!-- pr-hero-finding … -->`, so the state lives on GitHub and survives a machine change —
   the same reasoning that put `head=` in the summary marker.

   **Direction-of-error rule, inherited from C1a and `dedupe.ts` pass 2: err toward UNDER-matching.**
   An under-match posts a duplicate comment — visible, annoying, self-correcting. An over-match silently
   suppresses a genuinely new finding: an invisible miss, the worst failure mode a review tool has.

   Also corrected by the measurement, because the wrong version was briefly believed: **Greptile does
   not snap a comment to a nearby postable line.** `original_line 471-478` matches its own body's
   "Line: 471-478" exactly. It posts at the true line when the line is in the diff, and everything else
   falls to the outside-diff bucket. The summary keeps `ghRepoWebUrl` permalinks for those.

   **Every finding gets its OWN comment — no exceptions, and this DIVERGES from Greptile (Juanma,
   2026-08-12).** Greptile pools its un-anchorable findings into one `Comments Outside Diff` section
   inside the summary; pr-hero must not, because 6b makes every finding a thing that has to be
   *answerable*, and N findings pooled in one comment share one thread and one reaction box. Anchorable
   → its own inline review comment. Un-anchorable → **its own top-level issue comment**, which still
   carries its own reactions (verified: reactions ride inline in the comment fetch, no extra call).
   The summary keeps counts and the delta line only.

   Measured on this repo's own PR #1, which is why the pooled version was rejected: of its four
   findings, `size-gate.ts:345` (hunk 1-486) and `watch.ts:286` (hunk 268-319) are anchorable, while
   `pr.ts:68` (hunks 128-135, 157-184) and `cli.ts:318` (hunks 127-138, 330-343) are not. **Half would
   have been mute** — including `pr.ts:68`, the one finding already known to be misclassified and
   therefore the one most needing an objection. The hunters read the whole repo by design, so
   out-of-diff findings are not an edge case here.

   The cost is a noisier Conversation tab, and under the agent-first premise (see 6b) that cost is near
   zero: tidiness is a human preference, and the primary reader is an agent. Muting a subset of findings
   is not.

   **Retracted 2026-08-15 (Juanma, issues #16/#17, W2).** The "own top-level issue comment" rule above
   is the Conversation split that looked like a second review (Musive #1711 F001 `:958` vs F002 inline).
   First-review posting now matches Greptile: un-anchorable and 422-demoted findings live in the
   summary `Comments Outside Diff` bucket; inline review comments stay the only resolvable threads
   (W1 reply + Resolve). Do not rebuild R4. The remaining hole is cross-run identity for that bucket —
   parked on item 7, not redesigned in W2.

   **Live protocol, and it differs from the issue-comment one.** The WRITE path stays unexecuted until
   an authorized live post; `--dry-run` is the $0 gate, always first. Where the single marked comment
   needed two posts to prove create-then-update, this slice's idempotency proof is: **first run posts K
   inline comments; a second run on the SAME head must post ZERO.** One run proves nothing.

6b. **The triage loop — AGENT-FIRST. Designed with Juanma 2026-08-12; supersedes the old 6b/6c.**

   **The strategic why, in his words: the bottleneck of coding with AI is the review.** Everything in
   this item hangs off that. If an agent writes the code and a human is the only thing that can answer
   a review, the human is the queue. So the default actor is an agent and **the human is the objector,
   not the gate** — free to weigh in whenever they have context or an opinion, never required for the
   loop to close. Call it agent-first, AI-native, whichever; the load-bearing part is which way the
   default points.

   **The loop.** pr-hero posts one comment per finding (item 6). A skill — shipped BY pr-hero, same
   reasoning that made the trigger a product feature in B3 — drives the PR's coding agent to triage
   each one and reply in the thread with a label plus its reasoning. That reply is bound to its finding
   by GitHub's native `in_reply_to_id`: no ids in the body, no DSL, no heuristic parse.

   **Comments, not reactions, and the argument is this project's own.** A 👍/👎 was considered and
   rejected: it is one bit with no reasoning, which violates the A3 lesson *"record the reasoning with
   the verdict, always"* by construction. A labelled comment carries both. (Reactions remain available
   and free — they ride inline in the comment fetch — as a human's one-click objection, never as the
   record.)

   **The adversarial pair, and why it is shaped this way.** The coding agent must NOT simply rule on
   the review of its own code. But it must not be cut out either: it holds real context — it knows why
   the code is the way it is, and sometimes that IS the refutation. So each side supplies only what it
   actually has. **The author supplies the argument; an isolated subagent supplies the disinterest.**
   The author writes its case, and a spawned adjudicator — which never inherits the author's reasoning,
   only the finding, the argument and the repo — rules on it. That is the hunter/refuter pair one layer
   up, and the machinery already exists: a detached, read-only, one-step-per-finding spawn with its
   subject inlined in the prompt (`pipeline.ts:536-702`).

   **Burden of proof, or the argument becomes the attack surface.** The adjudicator reads the author's
   case, which is exactly the rationalization isolation was meant to exclude — a persuasive wrong
   argument is more dangerous than none. A2 already paid for the defence: **`refuted` requires positive
   disproof with cited code.** The burden falls on whoever wants the finding gone, and it is discharged
   by citing code, never by stating intent. "I did it on purpose" is not evidence; "this line already
   covers it, here" is.

   **TWO vocabularies, and conflating them was a real error in an earlier draft of this entry.**
   `refuter_verdict` (`findings.ts`) is a SCHEMA enum shared with the sibling lab and sacred under rule
   5 — not ours to extend. The triage TAGS an agent writes in a comment are a different thing entirely:
   they are ours, there may be as many as the work needs, and `ledger.ts` already tallies verdicts
   AS-IS with no enum in the parser — deliberately, so the taxonomy is discovered by triaging rather
   than invented before it (the A3 lesson). Adding a tag therefore costs no schema change. Corrected
   with Juanma 2026-08-12.

   Separating them surfaces a second distinction the draft had lost: what the AUTHOR claims and what
   the ADJUDICATOR returns are not the same vocabulary either.

   **What the author writes:**

   | tag | what it claims | what it must supply |
   |---|---|---|
   | `applied` | fixed in this PR | nothing — the re-review verifies it independently, so it pays no adjudicator |
   | `dismissed` | the finding is wrong | positive disproof with cited code |
   | `deferred` | the finding is right, but fixing it is out of this PR's scope | a REAL destination: an issue number |
   | `misclassified` | the finding is real, but the engine typed it wrong | which field is wrong and why |

   **What the adjudicator returns:** `upheld` (the author is right), `rejected` (the author is not, the
   finding stands), `inconclusive` (neither proven — the finding stays OPEN, so the party choosing what
   to cite can never force a binary).

   **`deferred` DOES need a destination — an earlier draft claimed this problem dissolved and it does
   not.** The draft mapped defer onto `downgraded-latent`, which means something else: "real but
   unreachable today", the G6 lesson, a defect with no live trigger. Juanma's defer is "real, reachable,
   and correct — it just belongs in another PR". Without an issue carrying it, defer is a dismiss with a
   better name, and worse, the ledger counts it as agreement. The skill should CREATE the issue and put
   its number in both the reply and the ledger row.

   **A `deferred` finding is suppressed only inside the PR that deferred it** (decided 2026-08-12). It
   stays `persist` across that PR's later heads, carrying its issue number, so nobody re-argues a
   settled point. It does NOT suppress anywhere else: a different PR is a different review, and the
   finding surfaces there again — the reply can simply cite the issue. The alternative, keying
   suppression on the issue's own state, buys a `gh` call per finding and a new failure mode (an issue
   closed without a fix silently buries the defect forever). Direction of error decides it, as
   everywhere else here: surfacing again is visible noise a human dismisses in one line, suppressing
   globally is an invisible loss.

   **`misclassified` earns its place on evidence.** It is exactly what happened to F003 on this repo's
   own PR #1: the finding was REAL — `gh` genuinely has no timeout anywhere — but the engine filed it
   `introduced` when it is plainly pre-existing, and the refuter corroborated it without questioning the
   class. That is neither `dismissed` (the claim is true) nor `deferred` (scope is not the issue): it is
   the ENGINE erring, not the code. It is also the single most valuable signal the loop can produce,
   because it points at a hunter or refuter defect rather than a repository one — and without its own
   tag it lands in the ledger as an ordinary disagreement and gets counted as a false positive it is not.

   **Cost, stated honestly because an earlier draft of this entry got it wrong.** Reading the triage is
   $0. The adjudication is a spawned step and costs money — but **only on findings the author wants
   rejected**. `applied` needs no judge at all: if the code changed, the re-review verifies it and the
   code does not lie. So the scrutiny lands exactly where the incentive to cheat is, and nothing is
   paid for what is verifiable for free. And it lands on the CONSUMER's side: pr-hero ships the skill,
   the consumer's agent spawns the adjudicator. pr-hero stays a reviewer and does not become a triager;
   its own cost model is unchanged.

   **The agent decides, and it is audited (Juanma's call, knowing the risk).** The label is the
   verdict and it closes the row. The risk was named before he chose: the author marks its own
   homework. Two things carry what the prompt cannot:
   - the isolated adjudicator with the burden-of-proof rule, and
   - **the delta, which is the real net.** Naively the matcher SUPPRESSES a persisting finding so it is
     not reposted — which would make a wrong `dismiss` vanish permanently, exactly the opposite of a
     net. So a dismissed finding that is still found must appear in the summary delta on EVERY
     subsequent run: `2 persist (1 dismissed)`. It is never reposted (no ping-pong) and never
     disappears. Zero extra cost — it reuses the matcher item 6 already builds.

   **WHAT STOPS AN ARGUMENT — decided with Juanma 2026-08-12, and this was the stated precondition for
   starting 6b at all.** Tracing it first corrected the fear: the loop does not spin on its own. Triage
   runs on FRESH findings, and by run two the matcher classifies an already-posted finding as
   `persist`, so it is never reposted and nobody calls the adjudicator again. The runaway cost was an
   assumption about an automatic re-triage that exists nowhere.

   The real hazard is the opposite one. Without a rule, an `inconclusive` sits open forever — neither
   settled nor dismissed, a thread nobody revisits. Not a loop, a LEAK. The design has to land between
   "re-triage always" (unbounded cost) and "never re-triage" (silent accumulation).

   **The head is the budget unit: one adjudication per finding per head.** This needs no new state —
   the per-finding marker already carries `head=<sha>`, so the bound is checkable by reading the
   posted comment itself, exactly like every other piece of cross-run state in item 6. Everything else
   follows:
   - head unchanged → no new code, nothing to re-judge, nothing spent;
   - head changed AND it touched the finding's lines → the evidence itself changed, so re-opening the
     adjudication is legitimate and is the only case that pays again;
   - head changed but did not touch those lines → the verdict stands, nothing spent.

   **The stop is escalation, not a retry counter: after 2 consecutive heads at `inconclusive`, the
   finding leaves the machine and goes to a human.** If two different heads with real code changes
   between them did not settle it, a third will not — and by then the thread carries enough material
   for a person to rule in a minute. The machine admitting it cannot converge is the terminator; a
   bigger attempt budget would only buy more of the same. This is also the human-as-objector rule
   arriving where it belongs: as the tie-break when the author and the adjudicator cannot agree.

   **What none of this fixes, stated because it is true.** Isolation is not a guarantee. The refuter is
   a detached, adversarial, per-finding judge built to demand cited disproof, and on this repo's own
   PR #1 it corroborated `pr.ts:68` — filed `introduced` when `ghPrList` (`watch.ts:243`) has carried
   the identical unbounded-`gh` hang the whole time, with no `AbortController`/`Promise.race`/timeout
   anywhere in `pr.ts` or `watch.ts` — without ever questioning the class. A prompt that asks for rigour
   is not a structure that enforces it. Three layers, none sufficient alone: the skill asks for
   criteria, the isolation removes the stake, the delta makes the failure visible over time.

6c. **Ledger write-back from the triage.** The two null columns B4 leaves — `comparison.json`'s
   `verdict: null, reasoning: null`, filled by hand today — are exactly what 6b's reply produces: the
   label is the `verdict`, the prose is the `reasoning`. Reading it is $0 and needs no I/O change if
   item 6's fetcher already projects `in_reply_to_id`. Constraints: schema 1.0.0 is additive-only until
   the coordinated v1.1 (C2) and both validators are allowlists, so any new field is optional; and the
   ledger **tallies verdicts AS-IS with no enum on purpose** (the taxonomy is not invented before the
   triage exists) — so the skill owning a vocabulary must not put that vocabulary in the parser.
   **Where the actor lives, and it is free** (decided 2026-08-12). `comparison.json` carries NO
   `schema_version` — it is pr-hero's own artifact, built by `buildComparisonJson` and read by
   `ledger.ts`, and it is NOT the findings schema shared with the lab. Rule 5 therefore does not apply
   and adding a field costs nothing: `actor: "agent" | "human" | null` sits beside `verdict` and
   `reasoning` on `ComparisonRow`, with the same loud per-field validation the parser already gives
   the other two.

   **The ledger must REPORT the split, not just store it.** 6b's whole premise is "the agent decides,
   and it is audited" — and audited is a word until a human can see, in one line, what fraction of the
   verdicts a machine wrote. The ledger should tally `N verdicts · M by agent · K by human` next to the
   buckets it already counts.

   **`inconclusive` leaves `verdict: null`, deliberately** (decided 2026-08-12). `ledger.ts:289` sends
   every `verdict === null` row to the Pending triage list, and a finding the adjudicator could not
   settle IS pending a human — which is exactly where 6b's escalation rule (2 consecutive inconclusive
   heads → a human) delivers it. The two mechanisms meet without either knowing about the other.
   The information that would otherwise be lost is recovered by the other two fields rather than by a
   new enum: `actor` set with `verdict` null means "adjudicated, could not settle"; both null means
   "nobody has looked yet". A reader can tell those apart, which is the only reason the null is safe.

7. **A re-review is not a review — and today we run it as one. NOT BUILT.** Raised by Juanma
   2026-08-12, immediately after item 6 shipped and its own live runs made the gap visible. He is right,
   and it is worse than a matter of efficiency.

   **DESIGNED 2026-08-20 — `docs/item7-rereview-design.md`.** §5 is the done-checklist. It resolves the
   open question this entry reserved for Juanma (verification pays on **site-changed ∪ `applied`**), it
   corrects two stale claims in the text below (§0.5, and the `commit_id` paragraph in amendment 2), and
   it carries the evidence that ends the verify-vs-infer argument with OUR data instead of DoorDash's:
   **musive PR 1759, two auto-launched runs 16 minutes apart on a byte-identical tree, byte-identical
   prompt set and a docs-only engine delta, where today's matcher would have reported `Δ 2 resolved`
   against zero commits** (§0.6). Read §0 before disagreeing with anything below.

   **🔒 BLOCKED — DO NOT START. Preceded by `ROADMAP-DOORDASH.md` (Juanma, 2026-08-16).** This item does
   not start until that track's splice conditions hold. **Promoted to THE LAUNCH LINE fundamentals
   2026-08-18** — launch waits on this item; the gate itself is unchanged. State as of 2026-08-18:

   | # | condition | state |
   |---|---|---|
   | 1 | M1 (#42, #39) merged **and seen live** | merged and pushed; **NOT yet seen live** — no auto-launched review has been checked by hand against them |
   | 2 | M2 — #19's shape decided | ✅ done. 53/53 findings postable → #19 is criteria-shaped, not a gate |
   | 3 | M6 — the scout A/B decided | ✅ **decided 2026-08-20: opt-in.** Scout stays behind `--scout`, default OFF — so this item is designed against the **no-scout-by-default** pipeline |
   | 4 | M0's control set and M6's numbers in the ledger | ✅ control set (`docs/scout-design.md` §1) + the pilot's scored floor table (`ROADMAP-DOORDASH.md` M6, `docs/scout-design.md` §3.17) |

   **Condition 3 was the real gate and it is not negotiable by convenience.** This item's discovery half
   runs "over what changed since the last review", so it must be designed for the pipeline we will
   actually have — and whether that pipeline has a scout stage is exactly what M6 decides. Designing it
   against today's pipeline and re-doing it after M6 is the waste this ordering exists to prevent.

   **Amended 2026-08-20.** Conditions 2, 3 and 4 now hold; **condition 1 does not** — M1 has still not
   been seen live. The gate therefore rests on condition 1 alone. That is a narrower gate, not an open
   one: this item does not start until an auto-launched review has been checked by hand against #42/#39.

   Do NOT unblock this item by rewriting the conditions. That was proposed once, on 2026-08-16, and
   rejected: the gate is not the obstacle, the unfinished experiment is.

   **What is NOT blocked (Juanma, 2026-08-16, still true for everything except launch):** C1b, C2, C3,
   C6, C8, C9, C10 and the distribution pillars do not wait on M6. C4 does — it must land before this
   item inlines user-authored text. Read the splice section in `ROADMAP-DOORDASH.md` before touching
   this entry.

   **Parked from W2 (Juanma, 2026-08-15) — read this before building this item.** Issues #16/#17 closed
   the *first* review's posting surface and explicitly left re-review for this slice. Do not reopen
   that product call; carry the hole:

   - Un-anchorable and 422-demoted findings now live only in the summary `Comments Outside Diff`
     bucket (`renderPrComment` / `postInlineFindings`). Zero `POST .../issues/<n>/comments` for
     findings. Inline comments stay the W1 reply+Resolve channel.
   - The bucket has **no** `<!-- pr-hero-finding -->` markers on purpose: a marker on the summary
     would make `fetchPostedFindingComments` treat the summary as a finding comment. Cross-run
     identity for those findings is therefore missing — a second `--post` can classify them as
     `fresh` even though they already sit in the bucket. `plan.issueComments` is still the
     classifier name; it no longer posts.
   - The rematch-before-issue-comment-POST block died with R4. Overlapping `--post` runs can both
     PATCH the same summary. True exactly-once is still Phase E.
   - Do not snap to a nearby hunk line. Do not bring R4 back to "make the bucket matchable".
     Identity for Outside Diff is this item's design work, next to verification vs discovery below.

   **We infer "fixed" from absence.** `MatchResult.resolved` is literally "a prior comment with nothing
   matched to it this run", so the deterministic-looking `Δ N resolved` line is deducing repair from
   non-detection. Absence has two causes: the defect was fixed, or the hunter simply did not find it
   this time. **This benchmark's run-to-run variance is documented as HIGH throughout Phase A** — a
   golden the lifecycle hunter catches in 3 of 6 runs on the same tree is recorded above. So the second
   cause is ordinary, not theoretical, and the delta can report a repair that never happened.

   **This retracts a claim made in 6b.** That entry says `applied` pays no adjudicator "because the
   re-review verifies it independently, and code does not lie". The re-review as built does NOT verify —
   it infers. So `applied` is currently accepted on the weakest evidence in the whole loop, which is
   exactly backwards: it is the tag whose author benefits most from being believed.

   **The gap, stated: a re-review is TWO jobs collapsed into one.**
   - **Verification** — for each previously posted finding, "is this specific defect still present at
     this location?" That is a bounded question with a checkable answer, and its shape is the REFUTER's
     (given a claim and a location, corroborate or refute), not the hunter's (find what is wrong). The
     machinery already exists — `pipeline.ts:536-702` is a detached, read-only, one-step-per-finding
     spawn with its subject inlined.
   - **Discovery** — over what CHANGED since the last review. Today we re-hunt the PR's whole diff, so
     we pay to re-examine untouched code and re-roll the dice on findings already adjudicated,
     reintroducing exactly the variance the verification half exists to remove.

   **Both corrections make it cheaper, not dearer** — a bounded verification costs less than a hunter
   pass, and discovery scoped to the delta-since-last-review is a smaller diff than the whole PR. That
   is unusual enough to be worth stating: the correct design is also the cheap one.

   Open, and the answer shapes the build: when an agent tags a finding `applied` and pushes the fix,
   does verification run on that finding regardless — paying a step per finding to be certain — or is
   "it did not come back" good enough? 6b's `applied` currently assumes the second and calls it the
   first.

   **Amended 2026-08-16 from an external production system, and the amendment is small on purpose.**
   Source: DoorDash engineering, *How DoorDash built an AI code reviewer engineers actually listen to*
   (2026-05-11) — ~10,000 PRs/week over 56 repos. Juanma paused this slice to absorb it. Three inputs
   land here; everything else the article contributes went to issues #39/#40, to #19/#23, or to Phase C.

   **CORRECTED 2026-08-20 — this line read "Their entire re-review guidance is one paragraph, under
   'Reporting needs its own guardrails'". It is two paragraphs, and the one that was missed is the one
   that matters for identity.** The immediately preceding bullet carries a second re-review sentence
   (`docs/doordash-ai-code-reviewer.md:277-278`):

   > **Correct findings can still be bad comments.** Broad summary notes, weak "consider checking"
   > language, and **duplicate comments across re-reviews** all erode trust, even when the underlying
   > concern is real.

   That is the only DoorDash statement bearing on cross-run duplicate suppression — precisely what
   `docs/item7-rereview-design.md` §3.4's identity mechanism exists to do. The guardrails paragraph, the
   one this entry did quote:

   > We added checks that prevent the reporter from posting a false-clean review if the analysis found
   > issues, reconcile stale findings when a PR changes during review, and collapse old comments during
   > re-review so the author sees the current state, not an accumulating pile of outdated bot feedback.

   1. **"Collapse old comments" is an acceptance criterion this entry does not state.** The matcher
      already gives it mechanically — a `persist` finding is not reposted — but the criterion the build
      must be checked against is the reader's: **after N pushes, the author sees the current state, not
      an archaeology of every round.** Written down because the matcher satisfying it is a claim, not a
      guarantee, and nothing tests it today.

   2. **"Reconcile stale findings when a PR changes DURING review" is a hazard this entry missed —
      the head moving mid-run, not between runs.** The *pinning* half was left this slice as **issue #39**.

      **CORRECTED 2026-08-20 — the paragraph below was stale and would have cost a rebuild.** It read
      "`postPrReview` (`pr.ts:735-801`) sends no `commit_id`". **It does**: `src/pr.ts:1107`,
      `commit_id: input.headSha`, with the rationale at `:1087-1106`. #39's pinning half SHIPPED
      2026-08-16 (M1) and the head is re-read before anchoring (`src/cli.ts:1899-1903`). Line refs in
      this entry also drifted: `pipeline.ts:536-702` → `src/pipeline.ts:922-1123`; `pr.ts:735-801` /
      `781-800` → `src/pr.ts:1069-1156`, 422 recovery `:1136-1155`.

      The *policy* half stays here and is design work: when the head moved
      under a review, what does a re-review DO with findings computed on the stale tree — re-verify
      them, demote them to the outside-diff bucket, or discard them? The 422 path
      only covers the case where the line vanished; a line that still exists and now
      means something else posts cleanly and lies. **Answered in `docs/item7-rereview-design.md` §3.9:
      with `movedHeadSha` set, stale-tree findings do not post inline — they go to the bucket, which
      §3.5 gives cross-run identity to, so the next run re-verifies rather than re-discovers.**

   3. **The open question above stays open, and the article does not close it.** It corroborates that
      reporting is its own failure surface, and its precision-over-recall ethos *leans* toward verifying
      rather than inferring — but it never says whether they verify a claimed fix. Recording the lean so
      nobody later reads this entry as settled by an outside source. The decision is still ours.

      **Updated hours later, from the second DoorDash post** (`docs/doordash-dashbench-trust.md`,
      2026-07-06). It does not decide the cost question either, but it removes the last excuse for
      treating absence as evidence, and it does so as a general property rather than as our local
      variance problem:

      > **Variance is a feature, not a bug.** LLMs are non-deterministic, so multiple runs of the same
      > agent surface additional valid findings, meaning **a single run understates an agent's real
      > coverage**, and you have to run repeatedly and aggregate to score it honestly.

      This entry already argues that from our own data (a golden the lifecycle hunter catches in 3 of 6
      runs on the same tree). What the second post adds is that the effect is structural, not a defect of
      our prompts that a better set would fix — which kills the "our variance will improve, so absence
      will get more trustworthy" line of hope. **A re-review that infers repair from non-detection is
      reading a single stochastic sample as a measurement**, and no amount of tuning makes one sample
      into an aggregate.

      So: still Juanma's call whether `applied` pays a verification step per finding. But the two options
      are no longer "verify" versus "trust absence" — they are "verify" versus "state the delta honestly
      as unconfirmed". A `Δ N resolved` line computed from absence should not use the word *resolved*
      unless something checked.

   Deliberately NOT amended: the verification/discovery split, the refuter-shaped verification half, and
   the delta-since-last-review scoping. The article agrees with all three by construction and adds
   nothing to them — noted so a future reader does not go looking for a change that is absent.

   **A second external reference for the re-review rules — and "a third option for the open question",
   RETRACTED 2026-08-20, see the correction below
   (2026-08-16, second pass — `docs/cloudflare-ai-code-review.md`, "Re-reviews").** Cloudflare runs
   incremental re-reviews at 2.7 reviews per MR, and its rules are worth holding next to this entry when
   it is designed: *fixed → omitted, thread auto-resolved; unfixed → re-emitted even if unchanged, so the
   thread stays alive; user-resolved → respected unless materially worsened; "won't fix" / "acknowledged"
   → treated as resolved; "I disagree" → the coordinator reads the justification and either resolves or
   argues back.* Three of those map onto what exists here (`persist` keeps the thread without reposting;
   `deferred`/`dismissed` are the tags; 6b's adjudicator is the argue-back, isolated instead of the same
   reviewer). **Mapping is not adoption — three of 6b's rules stay exactly as written:** `deferred` still
   needs a real destination (an issue number; a bare "acknowledged" has no analog here and is not being
   added), `dismissed` still needs positive disproof with cited code, and the party arguing back is never
   the same agent that wrote the code. Cloudflare's looser semantics are the reference, not the rule.

   **CORRECTED 2026-08-20 — the "third option" was a misattribution, and it was the load-bearing one.**
   The retracted text read: *"The one that matters for the open question: **their 'fixed' is a judgment,
   not an inference** — the coordinator re-reads the previous findings alongside the new diff and
   decides. That is a third option between 'pay a refuter step per finding' and 'trust absence': one
   pass, prior findings in context, cheaper than per-finding verification and stronger than
   non-detection."*

   The source does not say that. Read directly, Cloudflare's re-review section
   (`docs/cloudflare-ai-code-review.md:369-384`) states only the INPUT (`:371-373`) —

   > When a developer pushes new commits to an already-reviewed MR, the system runs an incremental
   > re-review that is aware of its own previous findings. The coordinator receives the full text of its
   > last review comment and a list of inline DiffNote comments it previously posted, along with their
   > resolution status.

   — and the OUTPUT RULE (`:377-378`):

   > **Fixed findings:** omit from the output, and the MCP server auto-resolves the corresponding
   > DiffNote thread.

   Between them, nothing. **It never says how fixedness is determined** — not verify, not infer, not
   judge. "The coordinator re-reads the previous findings and decides" is a reasonable architectural
   inference, but it was written here as what the source says, and it was the entire basis for the third
   option in the verify-vs-infer fork.

   The consequence is sharper than "unsupported". **"Omit fixed findings from the output" is equally
   consistent with inference from non-detection**: a coordinator whose sub-reviewers simply did not
   surface the issue on this run would also omit it. That is the exact failure mode this item exists to
   eliminate — so the source is compatible with Cloudflare having our bug.

   **This changes the RECORD, not the DESIGN.** `docs/item7-rereview-design.md` D1 and D8 rejected the
   one-pass judge independently, on our own PR 1759 evidence, before this reading. The correction exists
   so a future reader does not cite external validation that does not exist. The fork stands where
   DashBench left it: "verify" versus "state the delta honestly as unconfirmed".

   The two caveats that travelled with the retracted option are still true statements about a one-pass
   judge, and they are part of why D1/D8 landed where they did: DashBench's — one pass is one sample —
   and DoorDash's v2 — one session judging every finding is attention spread thin, the failure the
   per-finding refuter shape was chosen to avoid. **Note on that second caveat, 2026-08-20:** DoorDash
   diagnoses attention dilution in a *reviewing/discovery* session, not a judging one
   (`docs/doordash-ai-code-reviewer.md:69-75`) — "each reviewer had too much to do in a single session:
   read the full diff, evaluate it against all the rules that applied to the changed code, trace callers,
   check sibling implementations, and verify every potential concern. **Attention spread thin across the
   change**, and real findings sometimes got lost." Carrying it over to a JUDGING session is our
   plausible extension, not a quoted claim; do not cite it as DoorDash's finding about judges.

   Also inherited from them, for the build: previous findings and author
   replies become **user-authored text inside a prompt** the moment re-review inlines them; C4's
   boundary-tag rule applies from that day.

8. **The terminal surface is unreadable, and that is a Phase B problem. IN PROGRESS 2026-08-12** (branch
   `feat/terminal-ui`). Raised by Juanma while running real reviews: the whole flow — plan, confirm,
   progress, result — is one flat 15-char-padded label list. Paths, 40-char SHAs, prose paragraphs and the
   decision to spend $6 all carry equal weight, and long values wrap to column 0 and destroy the grid.
   Worse, after a paid run the terminal prints counts and three file paths and **never prints the findings**
   — the payload is the one thing you have to leave the terminal to read.

   **Why this is B and not E.** Phase E's TUI is a configuration front-end (dashboard, `runs` browser,
   provider limits) and is explicitly timed "only after Phase B proves the engine in anger on our own repo".
   This is the narrower thing that *makes* running it in anger bearable, which is squarely production
   wiring. It is also a down-payment, not a detour: `src/ui.ts` (pure formatters) and `src/ui-tree.ts` (a
   reusable tree component) are the substrate Phase E would build the TUI on.

   Six work units, each mergeable alone: (1) `src/ui.ts` pure formatters + one shared `log`, replacing the
   duplicate in `watch.ts`; (2) the plan card, regrouped with the size gate and cost band as the last block
   before the confirm, and the prose demoted to an unprinted `planDetails()`; (3) the confirm as a select;
   (4) the result block unified across local and PR mode **and the findings printed**, widening
   `ComparisonOutcome` to keep the `ComparisonResult` it currently computes and discards; (5) the findings
   browser; (6) the progress panel as a tree.

   Constraints that are not negotiable, both already paid for elsewhere: everything degrades to plain text
   when `process.stderr.isTTY` is falsy or `NO_COLOR` is set, and **every interactive path is guarded on
   `process.stdin.isTTY`**. The watcher spawns review with `--yes` and `stdin: "ignore"` (`src/watch.ts:475-495`);
   today `confirm()` degrades by accident because its stdin read resolves `{value: undefined}` immediately,
   but a `setRawMode` call in that same spot throws under launchd. Zero runtime dependencies — the repo has
   none today and a `[y/N]` prompt is not worth breaking that.

   The tree (WU6) has three consumers, which is what justifies building it as a component rather than
   drawing glyphs by hand: the progress panel, the plan card's agent list, and the findings browser — where
   `debug.root_causes.clusters` is already a two-level tree (RC001 → F001, F002) that today gets flattened
   into a counter. Its second level is deliberately NOT models: `spec.agents` assigns one model per agent
   (see C2), so a model level would give every node exactly one child. The real second level is the
   refuter's per-finding fan-out and runner retries, both invisible today. Bound the height — the panel
   redraws with `\x1b[<n>A` cursor-up, and a tree that outgrows the terminal corrupts the screen.

The required status check is shipped as gate mode (the `pr-hero` commit status, `mode: gate`, the default;
`mode: advisory` opts out). Still deliberately deferred: fail-closed for a head with no run (no status, no
merge), and the audited `skip-deep-review` label.

Cancelling Greptile is no longer the goal of this phase — see the north-star note in THE PIVOT.

## Phase C — Engine hardening (parallel-friendly, no benchmark coupling)

Convoy-inspired ops the engine still lacks, in value order:

- **C1. Fingerprint seeds — PROMOTE. A7's measurement turned this from a nice-to-have into a bar-blocker.**
  Hunters emit `specialty|path|symbol|root-cause` (convoy's dedup primitive); sharpens mechanical dedupe (the
  same-symbol over-merge case) and makes cross-run overlap measurable (the variance analysis pain).

  **Why it moved.** A7's blocking volume doubled (13/11/9 against A6's 4/4/9), which reads as a precision
  collapse. It is not one. **23 of those 33 blocking findings are a single root cause reported at ten different
  call sites** — 10 of 13, 7 of 11, 6 of 9. Strip the cluster and non-cluster blocking is 3/4/3, alongside A6's.
  The cluster is a **true positive**, verified end-to-end in the target repo at `27e85937`:
  `ProjectSongDuration.fromSeconds()` stores `Math.round(seconds * 1000)` and `ProjectSong.toDto()` emits that
  raw `.value`, while `Waveform/WaveformWithTime.tsx:13-14` documents `durationSec` as **SECONDS** and
  `computeProgress` divides bare. A milliseconds producer feeding a documented seconds consumer, across every
  host that renders a wave.

  It fans out because `dedupe_key` is `<path>:<symbol>:<category>` and each host has a different path. So the
  engine found a systemic defect and correctly named every site, and the benchmark counts that as ten precision
  failures. Until C1 lands, **report blocking volume as distinct root causes, never as a raw count** — and never
  infer precision from volume, which is the only reason this was caught at all.

  **C1 split in two on 2026-08-04, and the free half LANDED.** The entry above assumes the seed must be emitted
  by the hunter, which means a new prompt file → a new immutable set → a new paid arm. A7 proved output
  obligations move hunter behaviour hard, so that version perturbs the just-measured clean baseline in order to
  fix a problem that is purely one of MEASUREMENT. It did not need to.

  - **C1a — derived clustering. DONE, $0, no prompt change, no recall risk.** The signal already exists in
    current artifacts: findings in a fan-out all cite the same root-cause location as their FIRST proof_ref,
    because the hunter output contract already orders them `["producer path:line", "consumer path:line"]`.
    `src/root-cause.ts` partitions findings on that anchor, `pipeline.ts` stamps `root_cause_id` and puts the
    summary on `debug.root_causes`, and `scripts/cluster-report.ts` replays it over artifacts already on disk.
    Purely additive: both validators are allowlists, so no schema bump and C1 never depended on C2.
    **Non-destructive by construction** — the lab's scorer reads `findings[]` and ignores `debug.deduped[]`,
    so a collapse here would surface as a recall regression on a run whose recall did not change.

    Validated for $0 against A7's hand triage (the gate the standing rules ask for — plant it, observe it
    cheap, never discover on a paid run):

    | iter | blocking | root causes by hand | by the engine |
    |---|---|---|---|
    | 571 | 13 | 4 | 6 |
    | 572 | 11 | 5 | 7 |
    | 573 | 9 | 4 | **4** |

    Raw count 33 → hand 13 → engine 17: **80% of the distance from the dishonest number to the correct one**,
    mechanically. **Over-clustering: zero** (verified by hand — all 8 members of 571's cluster are the same
    ms/seconds defect at different hosts). The residual is real and it is the whole argument for C1b: one root
    cause has several citable sites (`ProjectSongDuration.ts:19-20` stores the ms, `ProjectSong.ts:454` emits
    the raw `.value`, `WaveformWithTime.tsx` is the shared consumer), and findings split by which one they
    cited first. No cheap normalization fixes that — they are different files.

    **Direction-of-error rule, now load-bearing:** the clusterer must err toward UNDER-clustering.
    Over-clustering deflates the apparent FP count, which is the direction that flatters the engine.
    Concretely paid for during review: a ref written `path.tsx: 12-14 (prose)` — a space after the colon —
    degenerates to a bare `path.tsx:` once the prose is cut, i.e. a FILE-level anchor, and in run 571 that was
    already welding F013 (blocking, a fetch-once lifecycle bug) to F014 (advisory, a memo bug) as one root
    cause. An anchor with no location component now yields no anchor at all. This is the SAME lesson
    `dedupe.ts:66-69` already carries from judgment day — pass 2 refuses to collapse symbol-less findings
    because keying on path alone over-merges distinct defects file-wide. New code did not inherit it; tests
    pin it now.

  - **C1b — hunter-emitted seed. DEFERRED, and now decided on evidence rather than faith.** What it buys is
    exactly the residual C1a leaves: 4 root causes across three runs. That is the number to weigh against a new
    prompt set, a new arm, and the risk of perturbing recall — not a guess.
- **C2. Schema v1.1** — lift the closed `Hunter` enum (unblocks arbitrary spec keys), make `engine` a
  first-class field; lab migration + validator both sides. Named review pipelines
  (`docs/review-strategies.md`, After layer) grow new hunter kinds (`security`, `react`, …) on this
  bump; the registry itself does not wait on C2.

  **What the enum actually blocks (recorded 2026-08-12).** `src/spec.ts` enforces two rules that together
  make the enum load-bearing far beyond schema hygiene: agent keys are unique (`:76`) and a hunter key must
  be one of the four enum values (`:93-98`). Three separate roadmap ambitions are blocked on this one line,
  and none of them is obvious from "arbitrary spec keys":

  - **Model diversity (D3).** Two hunters on the same specialty, different models (sonnet + a GPT/Grok leg).
    Needs a second key for the same specialty — `reliability` is taken and `reliability-b` is rejected.
  - **Review depth tiers.** Deep vs. normal vs. light is not only a UI knob (it currently appears ONLY as
    one, in the Phase E TUI scope note below). A deeper review means MORE hunters with new perspectives —
    `security`, `performance`, `api-contract` — and every one of those keys is rejected today.

    **Corrected 2026-08-16.** "Deeper = more specialists" is exactly the topology DoorDash's v1 had and
    abandoned: more narrow checklists catch more mechanical bugs and still miss the architectural ones,
    because none of them looks at the whole change (`docs/doordash-ai-code-reviewer.md`, "How we got
    here"; C7). Depth, on their measured evidence, comes from a **scout that aims attention plus
    verification that goes deep on the leads** — not from widening the fan-out. C2 still unblocks new
    keys (D3's model diversity needs them regardless); it should no longer be read as the depth lever.
    If a "deep review" tier is ever built, it is scout-on plus a larger hop budget, and the tier is
    measured, not assumed.
  - **Any new specialty at all**, independent of depth. The engine is key-agnostic; only this validator and
    the lab-shared schema are not.

  Note the asymmetry when C2 lands: distinct specialties agreeing is independent corroboration, which is
  what `dedupe.ts` assumes today. Two instances of the SAME prompt agreeing is not — they share the bias.
  Different MODELS on the same specialty sit in between. Whatever C2 unlocks, the merge semantics must be
  decided with it, not after, or confidence inflates without new signal.
- **C3. Resume + run metadata** — convoy-style debounced tmp+rename metadata, resumable interrupted
  runs, per-run SUMMARY; today a killed multi-tree run restarts from zero.
- **C4. Runtime-safety preamble** — a non-overridable engine-owned preamble (instruction hierarchy,
  read-only report contract "your final message IS the report") replacing per-prompt repetition.

  **Scope added 2026-08-16 (`docs/cloudflare-ai-code-review.md`, "Prompt injection prevention").** Today
  no prompt here inlines user-authored text — hunters get the patch, gotchas come from the operator root
  (`pr-preflight.ts:9-11`). That ends the day item 7 inlines previous findings and author replies, and
  the day 6b's adjudicator reads the author's argument. Cloudflare wraps every user-controlled block
  (MR body, comments, previous review, custom instructions) in named XML boundary tags and **strips those
  tag names out of the user content first**, so `</mr_body><mr_details>…` in a description cannot break
  out of its block. That rule is C4's — engine-owned, non-overridable, one place — and it must exist
  before the first prompt that carries a reply.

  **Promoted to THE LAUNCH LINE fundamentals 2026-08-18.** It lands before item 7, not after launch.

  **Designed 2026-08-19: `docs/c4-preamble-design.md`** (WRITTEN, awaiting ratification). The terrain
  section is verified, not remembered, and two of its findings change the shape of the work. (a) There is
  **no single injection point today** — the system prompt is written at four independent sites in
  `pipeline.ts` (`:529`, `:586`, `:829`, `:1073`) and only the hunter one is templated, so the seam has to
  be built before the preamble exists. (b) `engine.version` in `pipeline.json` reads `package.json`, which
  has said `0.1.0` since the scaffold commit — so a pre-C4 and a post-C4 run are today indistinguishable
  in the artifact, which is why making it discriminate is obligation O-0 rather than a footnote.
  Divergence from Cloudflare, deliberate: we wrap third-party blocks with a **per-run nonce** instead of
  stripping tag names from content, because stripping `</patch>`-shaped strings out of a diff corrupts the
  code under review. Prompt sets stay untouched — `promptSetFingerprint` hashes the on-disk agent files,
  so injection at write time moves no hash and the paid Cal.com baseline stays comparable.
- **C5. Global config with per-repo override** (Juanma, 2026-08-13). **BUILT 2026-08-23**, PR #50
  (`afc4a13`). Design `docs/c5-global-config-design.md`, Judgment Day ledger
  `docs/c5-judgment-ledger.md`. Two layers: `~/.prhero/config.json` (the person) and
  `<repo>/.prhero/config.json` — **which is the team's**, because it is committed and shared through
  git, a fact this entry originally missed. Remaining: `pr-hero config`, `init`'s O-9, and the
  re-anchoring this paragraph is part of.

  **This entry's own citations had all drifted, and fixing them is obligation O-11.** Recorded rather
  than silently overwritten, because a design whose evidence does not resolve is how a wrong premise
  survives a re-read — and this entry proves the point twice over:

  | This entry said | Actual |
  |---|---|
  | `parseLocalConfig` at `preflight.ts:999` | `src/preflight.ts:1512` |
  | `~/.prhero/` layout at `watch-preflight.ts:31` | `prheroLayout`, `src/home-preflight.ts:32-43` |
  | the spend rule at `watch-preflight.ts:50` | `src/watch-preflight.ts:43-47` |
  | "**four keys**" | **six** — `summary` and `max_verification_steps` joined later |
  | "`~/.prhero/` **belongs entirely to the watcher**" | the **product's** home, watcher as one tenant (`src/home-preflight.ts:7-12`); ratified by Juanma 2026-08-23 |

  The last two are worse than stale line numbers: they are stale *facts*, and the first of them
  ("four keys") would have made a reader miss that two of the six are exactly the ones that spend
  money.

  **The pain is concrete:** `agents_dir` is the same absolute path to the sibling prompt-set repo in every
  repo, retyped per `init`. A user preference (see B-summary's `summary.enabled`) is likewise a property
  of the person, not the repo. The rest — `default_base`, `parity_trigger_paths`, `suspicion_priors`,
  gotchas — is irreducibly per-repo and must stay there.

  **The rule that had to survive the merge, and it is the whole reason this was not a trivial file read:**
  `src/watch-preflight.ts:43-47` records that *nothing in a repo's own `.prhero/` can subscribe it to
  automatic spend*. Precedence is therefore NOT uniformly "repo wins", and each key's direction is
  declared explicitly next to the key — an undeclared key is a bug, not a default.

  **What was actually built refines this paragraph in two places** (`docs/c5-global-config-design.md`
  §1 D3, and the reason the design ran a Judgment Day before any code):

  1. The precedence collapsed to **one rule plus two exception lists**, not a per-key ordering: *the more
     specific layer wins, except where the less specific one is protecting the operator's money*. The
     exceptions are **placement** (a key meaningless outside one repo is rejected in the global file) and
     **widening** (the team layer may only narrow `summary.enabled` and `max_verification_steps`).
  2. `capped` applies **exactly where "narrower" is definable, and nowhere else**. A boolean has an
     ordering, a spawn count has one, a model string does not — so `summary.model` takes plain
     specificity. This paragraph's "global-only or global-capped" would have closed `summary.model`'s
     team seat; Juanma reversed that on 2026-08-23, and the reason it was wrong is the entry below.

  **And this entry got `default_base` right where the design first got it wrong.** "Irreducibly per-repo
  and must stay there" is correct, and a draft of the design classified it as a person key anyway —
  silently overriding a decision already recorded here. `resolveBaseRef` (`src/preflight.ts:1170-1175`)
  checks the config value **before** the remote head, so a hoisted global `default_base` makes every quiet
  repo review the wrong commit range: *"a wrong answer with a plausible face"*, in that file's own words.
  A single judge caught it, and only after the orchestrator re-verified it in code did it get fixed.
  The lesson is not about this key — **read the entry before rewriting what it decided.**
- **C6. The learned-knowledge file — pr-hero's own memory of a repo** (Juanma, 2026-08-13). NOT BUILT.
  A file at the repo root that the ENGINE writes: what it learns about this repo across reviews —
  conventions confirmed, false-positive patterns it already burned a refuter step on, invariants it
  discovered, corrections a human made to a finding. Read back into hunter prompts on the next run, so
  each review starts smarter than the last. Greptile ships something in this family; measure it before
  copying it (the same discipline that re-scoped B6).

  **It is NOT `gotchas.md`, and the split is the design.** Gotchas are HUMAN-signed, required, and
  fail-loud on empty (`src/pipeline.ts:641-648` — this entry said `:379`, drifted) precisely because
  they carry what a hunter *cannot infer*. This
  file carries what the engine *did* infer. Merging them would destroy the one property that makes the
  gotchas gate meaningful.

  Four hard problems, none optional:
  1. **Contamination has no gate.** A wrong lesson written once is injected into every future run and
     re-confirms itself. Needs provenance per line (which run, which finding, corroborated or human-
     confirmed) and a rule for what may be written unattended — the strong candidate being: only lessons
     a HUMAN adjudicated (the B6b triage loop already produces exactly that signal) get written
     automatically; everything else is proposed, not persisted.
  2. **It is a prompt-injection surface.** The file lives at the repo root, so on a PR review the head
     worktree contains the PR author's version of it. It MUST be read from the operator root, never the
     review root — the boundary `pr-preflight.ts:9-11` already draws for config. Otherwise a PR writes
     its own reviewer's system prompt.
  3. **It perturbs every measurement.** It changes hunter input, so any before/after comparison across a
     write is invalid unless the file is pinned. Benchmark arms must pin it the way prompt sets are
     frozen.
  4. **It grows without bound.** No eviction rule means the file eventually IS the context. Needs
     consolidation (merge duplicates, drop what the code no longer contains) and a size ceiling that
     fails loud rather than silently truncating.

  **Cross-reference added 2026-08-16.** DoorDash's review-profile rules answer problems 1 and 4 with two
  mechanisms worth borrowing here: every rule carries an `evidence` field naming the real PRs where the
  pattern bit (provenance as a first-class field, which is problem 1's ask), and every candidate rule
  passes the curation filter before it is kept — *CI would catch it → drop; the model already knows it →
  drop; no concrete file:line → drop* — which is an eviction rule (problem 4). C6 and C8 feed the same
  prompt slot; design them together, and run the filter over the existing gotchas first
  (`ROADMAP-DOORDASH.md` M7, after the A/B).

### C7–C9 — from DoorDash's production system (added 2026-08-16)

Source for all three: DoorDash engineering, *How DoorDash built an AI code reviewer engineers actually
listen to* (2026-05-11), archived at `docs/doordash-ai-code-reviewer.md`. ~10,000 PRs/week over 56
repos, three architecture generations, published numbers. **Placement decided by Juanma the same day:
Phase C, not a Phase B blocker** — *"primero vamos a estabilizar y resolver toda la bola que tenemos y
aprendimos"*. That is the pivot's own logic: time is the binding constraint, the head-to-head is the
instrument, and an unmeasured architectural change is exactly what the pivot ended.

- **C7. The lead scout — split NOTICING from VERIFYING. The single highest-value idea in the article,
  and the one that indicts our current topology.** NOT BUILT, not designed.

  **Why it is aimed at us specifically.** Their v1 was a fan-out of focused specialist agents — security,
  tests, performance, code quality, each with a narrow scope and a checklist. That is *this engine*:
  `reliability`, `resilience`, `parity`, `lifecycle`. They abandoned it, and the diagnosis is verbatim:

  > This was good at catching mechanical bugs like missing nil checks, unhandled errors, and obvious test
  > gaps. But it kept missing the architectural issues: a refactor that quietly changed a contract, a new
  > abstraction that didn't fit, a deletion that broke something three repos away. **Specialist agents
  > don't see the bigger picture, because none of them are looking at it.**

  **Our own measurement corroborates it, which is the only reason this entry exists.** THE PIVOT's first
  head-to-head recorded **zero overlap with Greptile across eight PRs** and the profile "high precision,
  narrow coverage". PR 1677's duplicate React keys — Greptile-only, a measured miss — is exactly the
  class their v1 kept dropping. Two independent systems reaching the same conclusion about the same
  topology is stronger evidence than either alone.

  **Their v2 is worth recording because it is the obvious fix and it FAILED.** Two parallel
  general-purpose reviewers, each seeing the whole change. Better on architecture, worse overall: each
  reviewer had to read the full diff, apply every rule, trace callers, check siblings and verify every
  concern in one session. *"Attention spread thin across the change, and real findings sometimes got
  lost."* Do not propose "one hunter that sees everything" as a shortcut past C7 — it has been tried.

  **v3, the shape to steal.** A scout runs first. It verifies nothing; it reads the diff and emits
  *investigation leads* — "this deletion looks suspicious", "this enum case isn't handled in the sibling
  file", "this error path is silently swallowing failures". Deep reviewers then take the leads and dig,
  keeping what holds up. Their framing of the second, less obvious job is the load-bearing part:

  > The scout does two things at once. The obvious one is what it produces: a list of suspect spots in
  > the diff. **The less obvious one is what it filters out**: the parts of the change that don't need
  > scrutiny. By the time the deep reviewers run, they're not trying to evaluate every line.

  **What this engine already has, so the delta is smaller than it looks.** The refuter IS their
  "disprove-it pass" — an explicit falsify-your-own-finding step before anything is posted, arrived at
  independently. C7 is the missing half at the OTHER end: we verify well and notice narrowly.

  **Rule 5 does NOT block this, and an earlier reading of it said otherwise.** Rule 5 seals *hunter spec
  keys* to `reliability|resilience|parity|lifecycle`. A scout is not a hunter: it emits leads, not
  schema-bound findings, and its output can travel as prompt input through the existing
  `{{PRIORS}}`/`{{GOTCHAS}}` templating (`prompt-set.ts`) with no schema change and no C2 dependency.
  What genuinely constrains it is rule 1 (design before code — this entry is a seat, not a licence) and
  rule 7 (one variable, measured in the head-to-head).

  Open questions the design must answer, none of them cheap:
  1. Do the leads REPLACE each hunter's own scan, or bias it? Replacing makes the scout a single point
     of failure for recall — the exact fragility a fan-out exists to avoid. Biasing risks changing
     nothing.
  2. What stops the scout from becoming v2 (one agent doing everything, attention spread thin)? Their
     answer is that it verifies nothing at all. Ours must be at least as strict.
  3. Direction of error: a missed lead is an invisible miss, the worst failure mode this project
     recognises. Does the scout get a recall-first prompt while the hunters stay precision-first?
  4. How is it measured? Not against the sealed goldens — against the live head-to-head, one variable.
     **Corrected the same day, after the second DoorDash post:** an earlier version of this line said
     "with acceptance rate (see #23) as the success condition". It is not one. See C10 — acceptance
     populates two of four confusion cells and can never see what we missed, which is the axis a scout
     exists to move. A staging arm measured on acceptance would be measuring the one thing staging does
     not primarily change.

  **It is measured, and the numbers are the strongest argument in either post** (`docs/doordash-dashbench-trust.md`,
  105 replayed PR cases, severity-weighted at critical=4 / high=2 / medium=1 / low=0.5):

  | System | Real findings | W. precision | W. recall | Cost / PR | Latency / PR |
  |---|---|---|---|---|---|
  | Scout + reviewer (their production) | 504 | 87.0% | 53.6% | $3.91 | 725s |
  | No scout, GPT 5.5 high | 164 | 84.1% | 30.7% | $0.75 | 170s |
  | No scout, Claude Opus 4.8 high | 115 | 89.8% | 20.2% | $0.65 | 113s |

  Staging bought **+75% relative weighted recall at flat precision**, for ~5x the money and ~4x the wall
  clock. That is the shape of the bet C7 is: it buys COVERAGE, which is precisely the axis our zero-overlap
  measurement says we are weak on, and it does not buy precision, which is the axis we are already strong
  on. Read the price honestly before designing — this is not a free improvement, and their own framing is
  *"not a trophy, but a measured tradeoff"*.

  Two details from the model-mix table that constrain the design:

  - **The scout does not have to be the expensive model, and the cheap scout won.** Kimi K2.6 scouting for
    a Fable 5 reviewer beat Sonnet 4.6 scouting for Opus 4.8 on every quality axis (65.2% vs 53.6%
    weighted recall, 89.2% vs 87.0% precision) at slightly lower cost. Scout tier and reviewer tier are
    independent knobs. Do not assume the scout needs the strongest model available.
  - **"Scouts improve breadth when the reviewer can verify aggressively."** That is their answer to open
    question 1 above, and it is a coupling, not a hint: a recall-first scout is only safe in front of a
    verifier willing to throw work away. We have that verifier — it is the refuter — which is an argument
    for wiring the scout's leads to the existing hunter/refuter pair rather than to a new judge.

  **Do not compare their 53.6% weighted recall to this project's 0.33 recall figure.** Different metric,
  different denominator, different corpus. Recorded because the comparison is tempting and would be
  meaningless.

- **C8. Review profiles — per-domain doctrine, routed by what the PR touches.** NOT BUILT.

  **The insight that makes this more than "better gotchas":**

  > AGENTS.md and CLAUDE.md files are written for engineers **authoring** code, not engineers
  > **reviewing** it. They mix architectural guidance, setup instructions, coding patterns, and style
  > notes into a single document. Useful for writing. Noisy for reviewing.

  Their profiles are mined from four sources — the review-relevant subset of AGENTS.md (boundaries,
  anti-patterns, contract rules; never setup), historical PR review comments (what senior engineers flag
  repeatedly), Slack decisions and post-mortems that never made it into docs, and incident history. Each
  profile is a small YAML rule set where every rule carries a `severity` and, critically, an `evidence`
  field naming the real PRs where the pattern bit.

  **The curation filter is the part to steal first, and it costs nothing to apply to what we already
  have.** Every candidate rule must survive: *if CI would already catch it, drop it. If the LLM knows it
  from general training, drop it. If we can't point to a concrete file-and-line in the codebase as
  evidence, drop it.* What survives is doctrine a senior engineer on that team would catch and nobody
  else would. That filter is directly applicable to `.prhero/` gotchas and priors today, and it is the
  cheapest experiment in this block.

  **Then routing.** A PR touching the payment gateway loads the PSP rules, payment core rules and
  monetary-security rules — *and nothing else*. A consumer-feed PR gets a different set entirely. Their
  claim is that routing is why acceptance holds across 56 very different repos: the agent is not applying
  one universal standard but the one that matters for that change.

  **Where it lands here.** `parity_trigger_paths` (`config.json`) is already a path→behaviour router — it
  decides whether the parity hunter spawns at all. C8 generalises that from "which agent runs" to "which
  doctrine each agent reads". Interacts directly with **C6** (learned knowledge) and **C5** (global vs
  per-repo config): C6 is what the engine infers, C8 is what humans and incidents encode, and both feed
  the same prompt slot. Design them together or they will fight over it.

- **C9. Hunt doctrine for the three classes the article says humans systematically miss.** NOT BUILT.

  Their "what it's actually good at" section names three, and the mapping to our hunters is uneven —
  which is the finding:

  1. **Deletions.** *"Humans skim deleted code. Additions look dangerous; deletions look like cleanup."*
     Removing a struct field, a config flag, a default behaviour or an interface method changes runtime
     behaviour while the code compiles and the tests pass. Their agent treats every deletion as a prompt:
     who depended on this, and what used to be true that is not anymore? **We do not hunt this as a
     class.** Cheapest of the three to try and the one with no existing owner.
  2. **Cross-boundary drift** — one side of a boundary updated, the sibling not: one brand's adapter, one
     of two producers, one handler of an enum. CI stays green because each side compiles alone. This is
     `parity`'s territory and it is conditional today (it spawns only on a trigger path), so the coverage
     question is whether the trigger list is the right gate.
  3. **Silent behaviour changes** — API changes that keep the signature, error handling that swallows
     more cases than before, cache misses now treated as errors or errors as misses. Partly `lifecycle`,
     partly `reliability`, owned as a named class by neither.

  Constraint that shapes any attempt: a scored prompt set is immutable, so this is a NEW set plus a
  `refuter-probe` gate plus a measured arm, never an edit in place. And rule 7 — deletions alone is one
  variable; all three at once is not an experiment, it is a rewrite.

- **C10. The measurement layer — and the blind spot the head-to-head shares with acceptance rate.**
  NOT BUILT. Source: `docs/doordash-dashbench-trust.md` (2026-07-06). This entry exists because the
  second post invalidated a claim this roadmap and two issues had accepted the same day, and the
  invalidation generalises to our own instrument.

  **Their argument, which is about confusion matrices and therefore not a matter of taste:** acceptance
  rate populates exactly two of four cells. Accepted → true positive. Rejected → false positive. It can
  never book a **false negative** (what the reviewer missed) or a **true negative** (clean code where
  silence was correct). Worse, both bookings assume the author's call is ground truth, and authors
  accept or reject *"for product and workflow reasons: timing, PR urgency, ownership context, how
  invasive the fix is, or whether the issue was already handled another way."*

  **Now turn that on THE PIVOT's instrument, because it has the identical shape.** The Greptile
  head-to-head buckets each finding as Greptile-only, pr-hero-only, or both. Those are also two cells:
  it can see what one reviewer found and the other did not, and it can see agreement. **It can never see
  what BOTH missed.** The zero-overlap result recorded above is real and it was worth every dollar — but
  "Greptile passed it clean and so did we" is not evidence the PR was clean, and five such PRs are not
  zero false negatives. They are five unobserved cells. That sentence is the single most useful thing
  the second post gives this project, and it costs nothing to accept.

  **What it does NOT mean, stated because the inference is available and wrong: Phase A does not reopen.**
  Juanma closed it on TIME, not on doubt about measurement — *"no me importa el gasto, me jode más el
  tiempo que está llevando esto"* — and DashBench actually corroborates the complaint that closed it. The
  lab's golden dataset turned out contaminated; DashBench's whole thesis is that single-source labels
  quietly poison scores, and their answer is not "label harder" but **triangulate and refuse to trust any
  one source**: the engineers who wrote the PRs annotate, the original findings are kept, an agentic judge
  runs, and where the three disagree a human adjudicates — and *those resolved cases become the judge's
  calibration data*. The judge is *"a calibrated signal, not ground truth."* Read as a critique of what
  the lab had, this is agreement, not a rebuke.

  **The cheap mechanisms, in ascending cost, and this is the actionable part:**

  1. **Reverted or hotfixed PRs are free known-bad cases.** A PR later reverted contained something worth
     catching, and nobody had to adjudicate anything to know it. Mining them is a `gh` search over history
     — see issue #41, which is where this half went, since it is corpus construction and not an
     experiment.
  2. **Benign PRs are the other half, and we already have five.** *"A reviewer that's loud on clean code
     is its own failure mode"* — their dataset deliberately includes PRs with close to zero real findings
     to measure restraint. The five PRs Greptile passed clean where pr-hero also said nothing are exactly
     that, and they are already on disk.
  3. **Aggregate over replicates or do not quote a recall number at all.** Their variance lesson (see item
     7's amendment) means a single run understates coverage by construction. Any future eval that reports
     one run's recall is reporting a sample and calling it a measurement — the same error item 7's
     "infer fixed from absence" makes, one layer up.
  4. **Severity weighting, if a score is ever needed.** Theirs is critical=4, high=2, medium=1, low=0.5,
     and its justification is the severity table: configurations that look close in aggregate miss very
     different kinds of issue. Note the interaction with issue #19 — weighting only means anything once
     severity is calibrated, so #19 comes first.
  5. **An agentic jury rather than a single judge**, which is where they are heading, to mitigate
     per-model bias. This project already owns both halves of that machinery: the refuter is a detached
     adversarial judge, and judgment-day is a blind dual-review protocol.

  **What must NOT be copied:** the scale. 1,000 raw candidates narrowed to 105 adjudicated cases with
  per-PR author annotation is a team-months instrument, and the constraint that closed Phase A was time.
  The shape is portable; the size is not.

  **The open decision, and it grazes territory Juanma owns:** whether the eval corpus the head-to-head
  already accumulates should be shaped DashBench-style from here on — triangulated labels, benign and
  reverted cases alongside the found ones, aggregation over replicates — or stay a plain running tally of
  the three buckets. The first article already put a continuous-eval future in this roadmap; this entry is
  what that future should look like if it happens. Not decided.

  **See-also, 2026-08-19 — a public gold that fills the both-missed cell without author annotation.**
  Martian's offline bench (`docs/martian-bench.md`) is 50 public PRs with human goldens plus every major
  vendor's already-collected reviews. Surface A (their LLM judge vs goldens) can book a false negative
  even when Greptile and pr-hero were both silent. Surface B is our H2H shape against N stored oracles
  on the same diff. Juanma 2026-08-19: lean on this as the n-vs-n field for methodology changes. It is
  **not** a reopening of Phase A and **not** a replacement of the musive head-to-head — triangulation,
  not a new single source. Cal.com 10 Surface A scored 2026-08-19; Surface B and the 50 are still later.

- **Per-stage model tiering** is a real lever the article documents (*"use cheaper models for simpler
  steps, reserve stronger models for verification-heavy steps, skip expensive passes on low-risk PRs"*),
  but it is not a Phase C entry: `AgentSpec` already carries `model`, so the mechanism exists and what is
  missing is the **measurement** to decide with. Their unit is **cost per successful review**, not token
  price — weak models on complex JSON schemas retry until they cost more than the strong model that got
  it right first time. Tracked on issue #23 (the store must separate retries caused by invalid output
  from transport retries; `attempts` alone cannot tell those apart) and exercised by Phase D's multi-model
  legs.

## Phase D — Multi-runtime + multi-model (Stage 2)

The economics (verified 2026-07-29): Anthropic prohibits Claude Pro/Max on OpenCode (plugins removed in
1.3.0) → Claude legs stay on Claude Code CLI (subscription, $0 marginal). **ChatGPT Plus works on
OpenCode with zero setup** → a Codex/GPT leg rides Juanma's existing subscription, $0 marginal, exactly
like convoy uses its Codex quota. OpenRouter (paid per token) only for diversity legs (Kimi/GLM/Grok).

- **D1. OpenCodeRunner** — second `StepRunner` against `@opencode-ai/sdk`: driver-owned config dir (the
  `--setting-sources ""` analog), read-only tool config + bash-policy deny floor, event-stream + status
  polling completion (never one blocking HTTP call), verified terminal message, total-wins usage, per-
  backend transient classifier. The interface obligations are already documented on `StepRunner`.
- **D2. Model routing** — convoy's `model-routing.ts` pattern: logical model identity vs gateway
  (`configured|direct|openrouter`), `provider/model#variant` effort syntax, frozen plan shows
  Logical/Target per step. NOTE (corrected 2026-08-12): an earlier draft of this line claimed the spec
  already carries `backend`/`models[]`. It does not — `src/spec.ts` has neither field; `AgentSpec` carries
  a single optional `model: string` and the validator accepts nothing else. D2 therefore includes the spec
  widening, and D3's fan-out is blocked on it rather than on wiring alone.
- **D3. Fan-out benchmark arm** — the honesty gate: same-hunter × N models (e.g. sonnet + GPT leg) vs
  baseline, same goldens, replicates. The Opus probe already showed tier doesn't move our misses;
  diversity must prove it buys recall (convoy's bet) before it costs a cent of routine spend.

  **Corrected 2026-08-16.** "Same goldens" is stale: the golden dataset was retired at THE PIVOT and
  stays sealed. D3's instrument is the live head-to-head on the frozen control set
  (`ROADMAP-DOORDASH.md` M0/M6), same protocol as the scout A/B — both arms same day, N × R replicates,
  read with C10's blind spot stated.

  **See-also, 2026-08-19.** A second comparable field now exists for model-mix / pipeline A/Bs that
  need to sit next to Greptile and CodeRabbit on *identical* public diffs: Martian offline
  (`docs/martian-bench.md`). It does not replace D3's musive instrument; it is how a D3 arm becomes
  vendor-n-vs-n once someone authorises that spend. One variable still.

  And the bet is no longer only convoy's: DashBench's model-mix table
  (`docs/doordash-dashbench-trust.md`, Appendix C) is direct external evidence — no configuration
  dominated every axis, a Kimi K2.6 scout beat a Sonnet 4.6 scout in front of the same reviewer, and the
  cheapest single-pass configs held precision while giving up half the recall. Two constraints it adds to
  D3's design: **the scout tier and the reviewer tier are independent knobs** (if C7 lands, D3 has two
  model dimensions, not one), and **cost per real finding**, not cost per PR, is the column that decides
  a mix (#23).

## Phase E — OSS productization (pr-hero as a product)

**Split 2026-08-18 (THE LAUNCH LINE).** The launch slice of this phase — npm, guided `init`, CLI/TUI
for existing knobs, thin GitHub Action, Claude-only — moved up and is specified at the top of this
file, together with the product fundamentals (M5→M6, C4, item 7, C5, canonical store). What remains
here is post-launch product: the web dashboard (it reads the store's routes; it does not own a second
database), convoy-style live per-step, the fixer loop, Homebrew, and the TUI-as-model-router once
Phase D exists.

From the productization vision + convoy's operational layer: `.prhero/` project config, GitHub Actions runner mode (claude-code-action +
CLAUDE_CODE_OAUTH_TOKEN as the documented fallback), built-in provider bench, human gates in specs,
TUI/dashboard (live per-step status, cost, provider limits — convoy's strongest UX), `runs` browser.
The engine-in-anger timing is met; the leftover items still wait on launch, not on more wiring.

**Named review pipelines (deferred 2026-08-18, Juanma).** Design-only:
`docs/review-strategies.md`. Convoy-shaped named recipes (selector, per-step models, later a kinded
step list), findings invariant, no markdown report bus unless a later product call. Not DoorDash, not
launch. Do not start it while M6 / C4 / item 7 / C5 / canonical store are open. When a pipeline *is*
an experiment, the n-vs-n field is Martian offline (`docs/martian-bench.md`) — same 50 PRs, one
pipeline id per arm, scored next to Greptile/CodeRabbit — not a musive-only story.

**Scope note (added 2026-08-12 by Juanma; narrowed 2026-08-18):** the *launch* TUI is the config
front-end for knobs that already exist (see THE LAUNCH LINE, pillar 2) — an alternative to memorizing
flags and hand-editing JSON. Picking which model runs which hunter, per-case deeper vs. lighter
review, and whatever D2's model routing exposes stay **after launch**; the first ship is Claude-only.
Runtime/language for a later web dashboard is open, not decided. The terminal TUI at launch stays in
this repo's TypeScript CLI (`src/ui*.ts`) — zero new runtime dependencies, same constraint as item 8.

**Onboarding DX (added 2026-08-11 by Juanma, from the first real onboarding pass; promoted to
THE LAUNCH LINE pillar 1 on 2026-08-18):** a guided
`pr-hero init` that collapses today's per-project ritual — scaffold, hand-write gotchas, decide
commit-vs-ignore for `.prhero/`, optionally `watch add` — into one complete, intuitive flow with
options. Concretely: walk the gotchas instead of leaving a template (refusing to run on empty is
right; writing them should be easier), make the ignore choice actionable (offer to append
`.git/info/exclude` — the polite variant for shared repos, and the reminder text already explains
why), offer watcher enrollment with its post flag, and keep every step flag-addressable so the
non-interactive path stays scriptable. The three-command onboarding is correct; it should also be
one obvious command.

**The fixer loop — close the gap between "the review found something" and "someone has to patch it"
(added 2026-08-16 from `docs/doordash-ai-code-reviewer.md`).** NOT BUILT, deliberately parked in E rather
than C: it is a product surface, not engine quality, and it presupposes the inline surface (B6) and the
triage loop (B6b) that already exist. Their shape: anyone replies in the PR thread tagging the agent —
*"can you handle the nil check here?"*, *"resolve the merge conflicts"* — and a fixer runs in a remote VM
with a full checkout plus **the original review context** (the diff, the finding, the surrounding code,
the suggested direction), makes the change and pushes it to the PR. No branch switching, no
re-explaining, and the output is a normal commit subject to the same CI and human review as any other.
Multiple comments on one PR are fixed concurrently, each in its own isolated worktree, merged back to the
head branch in order.

Why it fits here rather than being copied wholesale: their fixer runs on THEIR infrastructure, while
pr-hero's equivalent already has a home — B6b put the triage on the CONSUMER's side (pr-hero ships the
skill, the consumer's agent spawns the work) precisely so pr-hero stays a reviewer and its cost model
stays unchanged. A fixer should inherit that split, and the worktree isolation it needs is machinery
`src/pr.ts` already owns. Their own framing is the one to keep: *"this is not about removing engineer
ownership. It's about removing the mechanical handoff."*

**Distribution (added 2026-08-12 by Juanma; npm promoted to THE LAUNCH LINE pillar 1 on 2026-08-18):**
pr-hero as a product means an install, not a clone. npm is the launch registry; Homebrew stays
post-launch. Mechanism (versioning, release process) is decided when pillar 1 is built, not deferred
to "when Phase E starts".

## Standing rules (apply to every phase)

- Design before code: no step starts without certainty of what and how — verified against the real code
  and the convoy reference; when in doubt, ask Juanma (he is always available for decisions).
- Full smokes only at milestones; iterate on offline gates, the fixture eval, and surgical replays.
- Prompt sets immutable once scored; new behavior = new set, fingerprinted.
- One variable per experiment; replicates + N-of-M; misses attributed (hunter/merge/refuter) before
  choosing a lever.
- A gate asserts the mechanism it tests, never a downstream proxy. If a component's pass condition can be
  moved by something the component does not control, the gate measures that other thing — A2's original
  "G5 reaches blocking tier ≥2 of 3" tested the refuter through the hunter's variance and answered a
  question nobody asked. Where the mechanism can be planted and observed for cents, the cheap harness is
  the gate and the paid replay is confirmation, not discovery.
- The lab's `dataset/test.jsonl` stays sealed until A4.
- Cost is a first-class metric; every live run lands in the ledger with its engine identity.
- **No two-cell metric is a success condition** (added 2026-08-16, `docs/doordash-dashbench-trust.md`).
  Acceptance rate, `applied` rate, and the head-to-head buckets each see what was FOUND and what a human
  did with it — never what was missed, never where silence was correct. They are telemetry, recorded
  always, optimised against never. A change is judged on adjudicated real-vs-not-real findings, split by
  severity, with cost and latency beside them; and a recall figure from a single run is a sample, not a
  measurement — aggregate over replicates or do not quote it.
- **Correct findings can still be bad comments** (added 2026-08-16, `docs/doordash-ai-code-reviewer.md`).
  Anything posted names a file and line, the concrete behaviour at risk, and where to start; if no action
  point can be named, it is not posted inline. Precision is spent on the reader, not only on the claim.
- Convoy clone at `~/Desktop/convoy` + study notes at `../deep-review/intel/convoy.md` are the reference
  library.
