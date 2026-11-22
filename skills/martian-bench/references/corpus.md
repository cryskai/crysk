# Eval corpus — triangulate, do not replace

Martian is the n-vs-n field. It is not the only number. Read this **before** spend and **when** answering “how did we do”.

If Martian and musive disagree: musive + human triage wins for **product**. Martian wins for **where we sit vs CodeRabbit**. Write both. Do not average.

## 1. Martian Cal.com 10 — baseline arm `hunters` (2026-08-19)

On disk. **$0 to re-read.** Do not overwrite these dirs for a new arm.

| Artifact | Path |
|---|---|
| Ledger / how to read the number | `benchmarks/martian/README.md` § Cal.com 10 results |
| Judge JSON | `~/Desktop/martian-cal/runs/martian-judge.json` |
| Per-PR runs | `~/Desktop/martian-cal/runs/cal-<pr>-hunters/` |
| Adapter tests | `test/martian-adapter.test.ts` (offline) |

Pipeline: hunters (reliability/resilience/lifecycle + refuter), summarizer off, parity off, prompt set `slice3b-lifecycle-v6-clean` (`sha256: 5ac28df9bddbd4c8`). Judge: Martian prompt, Claude Code CLI `sonnet`, `tools:[]`. Unreplicated. Cal.com only.

**Headline (not All F1):** High+Critical recall **13/19 = 0.68**. High 12/17. Low 0/9. All-profile P 0.44 / R 0.41 / F1 0.43 (tp 17 fp 22 fn 24 / 41). Strict gold-side recall 17/35 = 0.49.

| Category | Recall |
|---|---|
| concurrency | 3/4 |
| data | 2/3 |
| security | 1/1 |
| bug | 10/23 |
| api | 1/4 |
| style / perf / docs / speculative | 0 |

**Best cells:** 11059 6/9 (OAuth/credential-sync), 7232 2/3 (reminder `forEach` + `immediateDelete`). **Zeros:** 8330 (dayjs `===`, slot arithmetic — second golden found then merged away), 22345 (empty review, Insights/`Prisma.sql`). **Weak TP:** 22532 0.65 same-site, opposite claim on `@updatedAt`. **Reliability miss:** 14740 Critical `isTeamAdmin && isTeamOwner` (should be OR).

Profile: concurrency / lifecycle / OAuth plumbing **yes**. Small local logic **no**.

Cost: reviews $42.43 + judge $0.89 = **$43.32**.

A new arm is a delta against **this** table, not against vibes.

## 2. Musive Greptile H2H — product instrument

`src/compare.ts` + `src/compare-report.ts` + `src/ledger.ts`. Location-only (path + line ±25), not claim text. Live on **our** repo. Cannot see C10’s both-missed cell. **Unchanged by Martian.** Do not retire it. Do not quote Martian F1 as if it replaced this.

## 3. M6 floor test — DoorDash track

`docs/benchmarks/m6-floor-cases.json`, `src/compare/floor-test.ts`. Frozen musive control set. It was built for a scout on/off A/B that was paused 2026-08-19 and retired 2026-11-16, when the scout stage was removed; `scripts/m6.ts` is gone, the case list and its scoring stay. **Different corpus, different question.** Do not mix a Martian weekend with an M6 variable.

Pilot learning (n=12 musive, before the removal): the scout concentrated findings instead of widening them; the prompt-set sha was identical across arms.

## 4. Fixture eval — cheap gate before Martian money

`bun run fixture-eval` (~$0.08, ~1 min). Planted bug in a disposable repo. A methodology that cannot catch the planted bug does not deserve a Cal.com re-run.

## 5. Refuter-probe — first gate for refuter prompt edits

`bun run refuter-probe`. Four known-correct verdicts: `corroborated`, `refuted` (adjacent and 3-hop), `downgraded-latent`. A prompt edit that cannot pass it does not deserve a $10 Martian replay (ROADMAP A2).

## 6. Live micro-eval

`bun run scripts/live-micro-eval.ts` (~$0.04). One trivial real spawn. Use to verify isolation flags / runner shape, not quality.

## 7. Lab goldens — sealed

`../deep-review/dataset/test.jsonl` — **never read**. THE PIVOT retired them as the thing we optimise. Prompt sets under `../deep-review/agents/<set>/` are **immutable once scored**. Martian does not reopen Phase A.

Lab ledger: `../deep-review/bench/METRICS.md` (append-only). Different instrument.

## 8. Vendor rows — Martian 50 with their own pipeline (2026-10-25)

Martian publishes `offline/results/<model>/evaluations.json` (Opus 4.5 / Sonnet 4.5 / GPT-5.2) and `offline/results/benchmark_data.json` (~22 MB stored reviews).

Arm `dev-default` is injected into a **copy** (`benchmarks/martian/martian-inject.ts`) and judged by their unmodified steps 2/2.5/3 with Opus 4.5 through `benchmarks/martian/martian-claude-shim.ts` (no temperature; `LLM_CALL_TIMEOUT` 300 s, see flow.md). Among the 22 tools judged on the current 173 goldens: pr-hero **#1 on High+Critical recall 78.8% (52/66)**, recall 64.2% (#2), precision 28.8% (lowest of the leaders), F1 39.7%. Weak spot: Discourse, 5/12 High+Critical overall and 1/4 on its security goldens (three Critical security misses). Ledger: `benchmarks/martian/README.md` § Martian 50. A new arm on the 50 is a delta against **this** row; compare only against tools whose goldens total 173.

Surface B = bucket our `martian-review.json` against those stored comments. Status: **not run**.

## 9. Arm `dev-2026-11-22` and the v0.12.0 fixes (2026-11-22)

`dev` at `c78c075c` (the v0.11.0 review path) scored **H+C 43/66, TP 91, FP 162, precision 36.0%**. It ranks #7 among the 66-H+C tools.
- **Part of the drop is noise.** The Cal.com 10 replicate spread is about 2 H+C and 4 TP.
- **Part is two pipeline bugs, fixed in v0.12.0.** Dedupe folded distinct contract claims together, and consolidation repair rules dropped claims.
- **Replay evidence:** the same stored drafts through the fixed pipeline on 9 PRs gave TP 17 → 23 and H+C 9 → 15 of 20.

Read the README section of that name before comparing a new arm against `dev-2026-11-13` or `dev-2026-11-22`. Lab: `bench/experiments/2026-11-22-martian-50-dev-2026-11-22/investigation/CONCLUSIONS.md`.

Lessons that change how to run an arm:
- **One 50-PR run cannot carry a delta under about 3 H+C.** Pair a new arm with a replicate control.
- **Test a post-hunter change without hunter noise.** Replay the stored drafts (lab `investigation/gate.ts` and `investigation/replay/`).
- **Redo one PR with `run --all`.** `run --only` refuses a frozen schedule, and `--all` skips the reviews that are already verified.
- **Never edit the worktree an arm runs from.** A review that starts mid-edit loads the edited engine.

## Comparison recipe (new arm)

1. Re-read §1 numbers. Copy the High+Critical 13/19 as the control.
2. Run the new arm into **new** dirs. Same 10 PRs, same judge script, same judge model.
3. Table: per-PR tp/fp/fn new vs `hunters`. Attribute misses: hunter / merge / refuter / judge.
4. Consult §2–§5. If fixture-eval or refuter-probe regressed, stop — do not publish a Martian win.
5. Ledger both All and High+Critical. Say Surface B ran or not.
