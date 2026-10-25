# Martian Code Review Bench — the n-vs-n instrument

This document is the home for **how we measure pr-hero against other review products, and against our own methodology changes, on identical public diffs**. The bench is Martian’s Code Review Bench. We did not build it; we adopt it as the comparable field.

Status: **CAL.COM 10 SCORED 2026-08-19 (Surface A).** Harness: `scripts/martian-cal.ts` + `scripts/martian-judge.ts`. Skill: `skills/martian-bench/SKILL.md`. Default run is still the 3-PR pilot; `--all` is the ten. Not the 50, not Surface B. Roadmap: see-also on C10 and D3 in `ROADMAP.md`. Does **not** reopen Phase A, does **not** replace THE PIVOT’s musive head-to-head, does **not** reorder DoorDash M6.

**Frozen this session (Juanma, 2026-08-19):** we will lean on this benchmark hard. It is a real n-vs-n: every methodology change can sit next to Greptile, CodeRabbit, Cursor Bugbot, Copilot, Graphite, and the rest, on the same PRs. Skill: `skills/martian-bench/SKILL.md`.

---

## Decision Summary

| Area | Decision |
|---|---|
| Goal | Score **our** reviews on the **same diffs** other products already reviewed, so a pipeline change is an n-vs-n result, not a vibes comparison |
| Primary instrument | Martian **offline**: 50 public PRs, human goldens, stored reviews from every listed tool, LLM judge |
| Secondary | Martian **online** / Hugging Face dump — PRs where bots already commented; ground truth is author-fixes, not bugs. Do not treat as the comparable field |
| What this is not | A replacement for the musive Greptile head-to-head (`src/compare.ts`). That remains the product instrument on *our* repo |
| What this fills | C10’s both-missed cell (goldens exist even when Greptile and we were silent); vendor-comparable precision/recall/F-beta |
| How we run | **Local worktree** on the original PR SHA. Isolation flags stay. Hunters must never see GitHub review comments |
| Official “add a tool” path | Fork 50 PRs into an org with a GitHub App. **We refuse that** for v0. CLI + adapter (CodeSheriff’s pattern) |
| Product bar | Unchanged. THE PIVOT still holds: do not optimise a golden number as if it were production quality |
| One variable | Rule 7. One methodology (pipeline / scout / prompt set / model mix) per Martian arm |
| First spend | Cal.com 10 **done 2026-08-19**: reviews **$42.43** + judge **$0.89** = **$43.32**. Surface A only. Not the 50 |
| Skill | `skills/martian-bench/SKILL.md` (eval, not product). Flow + corpus in `references/` |

---

## Why this is the n-vs-n we did not have

Until now we could do three things:

1. Score against the lab’s sealed goldens — retired at THE PIVOT (contaminated, time-bound, not a vendor field).
2. Bucket against Greptile on musive — live, cheap, **one** oracle, cannot see what both missed.
3. A/B scout vs not on the frozen musive control set (M6) — one variable, still Greptile as the other reviewer.

None of those answers “did this pipeline catch what CodeRabbit caught on Grafana PR N, and did it catch the golden concurrency bug on Cal.com PR M?” Martian does, because **every tool already ran on the same 50 diffs** and the reviews are on disk.

That is the brutal part: a named pipeline (`hunters` vs `scout-led` vs a future security hunter) becomes a row in the same table as Greptile. Methodology changes stop being internal stories.

---

## Quick path (when a slice is authorised)

1. Clone [withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark) (MIT).
2. Read `offline/golden_comments/cal_dot_com.json` — 10 public PR URLs.
3. For each PR: worktree at the **PR head SHA** (not post-merge `main`). `pr-hero review --repo --base --head --yes`. Isolation on. No `--pr` against the original GitHub thread.
4. Map `findings.json` → Martian `candidates[]` (`claim` text; path/line come along for our own H2H, the judge matches semantically).
5. Inject as `tool: "pr-hero"` into a copy of `offline/results/benchmark_data.json`.
6. Run their `step3_judge_comments` (and 2.5 dedup) against the goldens.
7. Read two surfaces: (a) precision/recall vs goldens, same profiles as everyone; (b) overlap vs stored Greptile/CodeRabbit/… comments.

Expected result of a **pilot**: the adapter parses, one Cal.com PR produces a judge row, cost is on the order of one musive `--pr` (~$3–4). Nothing about the 50 is implied.

---

## What Martian actually is

Two benches that check each other. Sources: [leaderboard](https://codereview.withmartian.com/), [repo](https://github.com/withmartian/code-review-benchmark), [v0 post](https://withmartian.com/post/code-review-bench-v0), [methodology](https://github.com/withmartian/code-review-benchmark/blob/main/methodology/full.md), [Hugging Face](https://huggingface.co/datasets/code-review-bench/code-review-bench).

### Offline — the comparable field (this is ours)

| | |
|---|---|
| Size | 50 PRs, 5 repos, ~139–173 golden issues depending on profile |
| Repos | Sentry (Python), Grafana (Go), **Cal.com (TypeScript)**, Discourse (Ruby), Keycloak (Java) |
| Goldens | Human-curated; severity Low/Medium/High/Critical; categories `bug`, `security`, `concurrency`, `data`, `api`, `perf`, `test_gap`, `doc_defect`, `style`, `speculative` |
| Lineage | Greptile July 2025 (one bug/PR, catch-rate) → Augment Dec 2025 (expanded gold, precision/recall) → Martian (judge, dedup, more tools, published reviews) |
| Scoring profiles | **Strict** (bug/security/concurrency/data/api, 139) · **Core** default (+perf/test_gap/doc_defect, 158) · **All** (+style/speculative, 173). A match on an excluded category is *matched-excluded*: neither rewarded nor penalised |
| Judge | LLM: “same underlying issue?” Semantic, not path±25. Results stored per judge (Opus 4.5, Sonnet 4.5, GPT-5.2) |
| Already on disk | `offline/results/benchmark_data.json` (~22 MB) — every listed tool’s review comments on these PRs. `evaluations.json` per judge |

Tools already in that file include Augment, Baz, Claude, CodeAnt, CodeRabbit, Cursor Bugbot, Cubic, Devin, Gemini, Copilot, Graphite, Greptile, Propel, Qodo, and others. Adding us is a new `reviews[]` entry per PR, not a new dataset.

### Online — reality check, not our n-vs-n

Daily sample of **fresh** public PRs where a tracked bot commented. Precision/recall from “did the author fix what the bot said?” Hugging Face publishes a stratified dump (1,135 PRs, Feb–Apr 2026) with `pr_url`, `bot_suggestions`, `human_actions`.

Martian themselves: you cannot fairly run two bots on the same *live* GitHub PR (the second sees the first); tool mix correlates with repo mix; new/private tools have no online data. That is why offline exists.

We do **not** appear on the live online leaderboard without being an installed GitHub App on other people’s repos. We can still *replay* a Hugging Face `pr_url` locally (pre-fix SHA) as a later experiment. It is a different question (adoption, not gold).

---

## What they already published (so we do not scrape)

| Artifact | Path / URL | Use |
|---|---|---|
| Golden issues + PR URLs | `offline/golden_comments/{sentry,grafana,cal_dot_com,discourse,keycloak}.json` | Worklist. Each object has `url`, `pr_title`, `comments[]` |
| Other tools’ reviews | `offline/results/benchmark_data.json` | Oracle comments for our own overlap buckets |
| Per-judge scores | `offline/results/<model>/evaluations.json` | Sit next to Greptile’s published TP/FP/FN |
| PR labels | `offline/results/pr_labels.json` | Language, size, domain filters |
| Dashboard | `offline/analysis/` + the public site | How they present F-beta / profiles |
| Pipeline | `offline/code_review_benchmark/` steps 0–4 | Judge + dedup we reuse |
| Online sample | Hugging Face `code-review-bench/code-review-bench` | Optional later |

Example golden row (Cal.com, already public):

```text
https://github.com/calcom/cal.com/pull/8087
  Critical / concurrency — forEach with async callbacks, fire-and-forget
  Low / speculative — try/catch around dynamic import
```

Cal.com set (TypeScript — first slice): 8087, 10600, 10967, 22345, 7232, 8330, 11059, 14943, 14740, 22532.

---

## How n-vs-n works for us

Two scoring surfaces. Do not collapse them. They answer different questions.

```text
                    original public PR SHA
                            │
              pr-hero review (local, isolated)
                            │
                      findings.json
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     Martian candidates              our overlap
     + their LLM judge               vs stored reviews
              │                           │
              ▼                           ▼
     P/R/F-beta vs goldens         greptile_only /
     Strict / Core / All           coderabbit_only /
     comparable to vendors         both / prhero_only
                                   (N oracles, same diff)
```

### Surface A — goldens (vendor-comparable)

Martian’s judge, their profiles, their F-beta slider. This is how we say “pipeline `scout-led` got Core recall 0.X on the 50, Greptile got 0.Y on the same gold.”

Read it with Martian’s own caveat, which matches THE PIVOT and DashBench: **the gold is incomplete and biased toward issues Greptile/Augment noticed.** Real finds missing from the gold score as false positives; the denominator of recall is too small. Rankings can move when the gold grows. Report the judge model. Never quote a single F1 as the product bar.

### Surface B — stored vendor reviews (our H2H, many oracles)

`benchmark_data.json` already has Greptile’s (and everyone else’s) comments on that PR. After we emit findings we can bucket like `src/compare.ts`, except the other side is a stored review, not a live musive comment.

Matching rule is an open implementation choice at harness time. Today’s H2H is **location-only** (path + line ±25, explicitly not claim text — `compare.ts`). Martian’s judge is **semantic**. Surface B should not silently mix the two. Recommendation: keep location-only for the mechanical buckets (deterministic, testable), and optionally run Martian’s judge as a second pass labelled as such.

Surface B cannot see C10’s both-missed cell. Surface A can. That is why both exist.

### What “n vs n with every change” means

| Change | Martian arm | Must not mix in the same arm |
|---|---|---|
| Scout on vs off | `hunters` vs `scout-led` on the same PR list | prompt-set edit |
| New hunter / prompt set | new `--agents`, same pipeline shape | scout flag |
| Model mix | same steps, different per-step `model` | prompt-set edit |
| Refuter on vs off | own list the resolver still accepts | anything else |
| Named pipeline (after `docs/review-strategies.md`) | one pipeline id per arm | two pipelines in one run |

Same discipline as M6: replicates if we quote a number; one variable; attribute misses (hunter / merge / refuter / judge) before picking the next lever. A methodology that cannot beat *itself* on Cal.com does not deserve the 50.

---

## Isolation — the threat model that makes the comparison fair

Martian’s online methodology says two GitHub bots on one PR contaminate. Our engine already solves that if we stay off the original thread:

- Worktree of **our clone**, PR head SHA.
- `--setting-sources ""`, `--strict-mcp-config`, codegraph-only, no Write/Task/Bash for agents (`src/step-runner.ts`). Those flags are a threat model, not a preference.
- Do **not** use `pr-hero review --pr` against `calcom/cal.com#8087` as the eval path: PR mode fetches comments for comparison/posting. Fine *after* the run, as a human lookup. Not as hunter context.
- Do not paste golden comments or vendor reviews into the hunter prompt. Gold is for the judge. Vendor comments are for surface B after the fact.

If a run’s `pipeline.json` shows Bash or GitHub MCP in the hunter tool list, that arm is invalid for this bench.

---

## How this sits next to instruments we already have

| Instrument | Oracle | Both-missed cell | Vendor-comparable | Role after this doc |
|---|---|---|---|---|
| Lab `dataset/test.jsonl` | sealed goldens | yes (in theory) | no | **Stays sealed.** THE PIVOT. Not this bench |
| Musive Greptile H2H | Greptile on *our* PRs | no (C10) | no (one vendor, one repo) | **Product instrument.** Unchanged |
| M6 scout A/B | same H2H, frozen musive set | no | no | **DoorDash track.** Not replaced. Paused 2026-08-19 |
| Fixture eval | planted bug | n/a | no | Cheap gate before any Martian spend |
| Refuter-probe | planted verdicts | n/a | no | First gate for refuter prompt edits |
| **Martian offline** | public gold + N stored reviews | **yes** | **yes** | **n-vs-n field for methodology** |
| Martian online / HF | author-fixes | partial | noisy (selection bias) | Later, optional |

THE PIVOT retired *our* goldens as the thing we optimise. It did not forbid a **public, multi-vendor** gold used as a comparison field. The failure mode to avoid is the old one: chasing Martian Core F1 while musive H2H gets worse. If the two disagree, musive + human triage wins for product; Martian wins for “where we sit vs CodeRabbit.” Write both numbers. Do not average them into one.

DashBench (`docs/doordash-dashbench-trust.md`) is the philosophy: triangulate, trust no single source. Martian is a third source we did not have to annotate. C10’s cheap mechanisms (reverts, benign PRs, replicates) still apply *inside* a Martian arm.

---

## What we refuse

| Temptation | Why not |
|---|---|
| Fork 50 PRs + GitHub App to “be official” | We are a CLI. Isolation is the fairness. v0 is local. A later product call can submit results upstream |
| Optimise until we top the public leaderboard | Goldhart. Martian says the gold is wrong. THE PIVOT was this lesson internally |
| Quote online F1 (Greptile 60.8% etc.) as our target | Different distribution, different ground truth, we are not on that board |
| Run hunters on Python/Java/Ruby and treat a low F1 as a product fail | Our hunters are lifecycle/reliability/parity on RN. Cal.com is the fair first slice; the other 40 are a *coverage* experiment, not a shame number |
| One 50-PR run, one F1, ship it | Variance is HIGH. Replicates or do not quote recall (C10 §3) |
| Mix scout + prompt-set + model in one Martian weekend | Rule 7 |
| Let this unblock or replace M6 | M6 has a same-build invariant on musive runs already paid for. Different corpus, different question |
| Markdown-bus the adapter | Findings stay `findings.json`. The adapter *projects* claims into Martian candidates. The engine contract does not change |

---

## Cost and size

| Slice | Order-of-magnitude | When |
|---|---|---|
| Adapter spike, 0 live reviews | $0 | First engineering slice |
| 1 Cal.com PR, 1 pipeline | ~$3–4 (same band as musive `--pr`) | Pilot |
| 10 Cal.com, 1 pipeline | ~$30–40 | First comparable number vs TS goldens |
| 10 Cal.com × 2 methodologies | ~$60–80 | First n-vs-n of *us vs us* on their field |
| 50 PRs × 1 pipeline | ~$150–200 | After Cal.com says the adapter and the hunters even fire |
| 50 × 2 × replicates | M6-sized money | Milestone only (rule 2) |

Size gate still applies. Martian online skips >2000 lines / >50 commits; we keep `src/size-gate.ts` as a cost gate and record skips rather than silently dropping them from the denominator.

Judge spend (their LLM match) is extra and small next to hunters. Log it.

---

## Harness shape (Cal.com slice — built)

What is on disk for the TypeScript slice. Not the 50.

1. **Worklist** — `docs/martian-cal-goldens.json` + `docs/martian-cal-cases.json` (SHAs via `gh`, captured 2026-08-19).
2. **Driver** — `scripts/martian-cal.ts` (`plan|check|run|score`). Local `pr-hero review --repo --base --head --two-dot --yes --no-summary`. Refuses `--pr` / `--post`. `--out` outside the clone.
3. **Adapter** — `src/martian-adapter.ts`: `findings.json` → `martian-review.json` (`candidates[]` + `review_comments`). One candidate per finding.
4. **Judge (Surface A)** — `scripts/martian-judge.ts`. Martian’s `JUDGE_PROMPT` (“same underlying issue?”), one Claude Code spawn per PR (`tools: []`, model `sonnet`). **Not** their Python gateway / `MARTIAN_API_KEY`. Sibling findings at the same `path:line` are not extra FPs (mechanical analogue of their step 2.5). Artifact: `~/Desktop/martian-cal/runs/martian-judge.json`.
5. **Inject** — not done. A copy of `benchmark_data.json` with `tool: "pr-hero"` is still the path to sit in *their* Opus 4.5 / Sonnet 4.5 / GPT-5.2 tables.
6. **Surface B** — not done. Stored Greptile/CodeRabbit comments are still on their repo, not bucketed against us for the ten.

No schema bump. No hunter enum change. No GitHub App. `scripts/` is the home (same coverage gap as other eval scripts: explicit `bunx tsc` / biome over the new files).

Ledger: every live Martian arm lands in this file (rule 6). Run dirs are as sacred as M0’s musive roots until scored.

---

## Skill

`skills/martian-bench/SKILL.md` (2026-08-19). Eval, not product. Makes an agent unable to: `--pr` the original GitHub PR; feed goldens/vendor comments to hunters; mix two variables in one arm; quote an unreplicated 50-run; treat Martian F1 as a launch gate; skip Cal.com for Keycloak; finish without Surface A **and** naming whether Surface B ran. Flow + corpus (Cal.com 10 scores, musive H2H, M6, fixture-eval, refuter-probe) live in `skills/martian-bench/references/`.

---

## Open questions (parked until the harness slice)

1. **Surface B matcher** — keep `compare.ts` location-only, or add a labelled semantic pass with Martian’s judge.
2. **Which judge model we pin** — they publish three. Pick one and do not mix inside an A/B.
3. **Submitting results upstream** — a PR onto `withmartian/code-review-benchmark` is a product/comms call, not an eval requirement.
4. **Cal.com-only as the quoted field** vs always reporting all five repos with a language split. Recommendation: always split; never average Python+Java into the TS story.
5. **How this corpus lands in the canonical store** (`docs/observability-canonical-store.md`) — later; JSON overlay is enough for v0.

---

## Next step

**Scheduled, not open (Juanma, 2026-08-19): the dedicated Martian push happens at the END of the
roadmap — once the engine is stable, before launch.** Nothing here is authorised meanwhile. The
roadmap order (C4 → item 7 → C5 → canonical store) runs first, because this bench measures a
*methodology change* and none is on the table while those are open. The `hunters` baseline below is
frozen: $0 to re-read, do not overwrite the run dirs, do not fetch vendor rows until that push.

**Baseline validity across engine versions — ratified 2026-08-19 (Juanma).** C4 and the fundamentals
after it change the text every agent sees while leaving the prompt-set fingerprint byte-identical
(`promptSetFingerprint` hashes the on-disk agent files). The `hunters` baseline below stays a valid
comparison point across that change; the frontier gets **annotated** rather than the baseline discarded.
That annotation is not free today: `engine.version` reads `package.json`, unchanged at `0.1.0` since the
scaffold commit, so every run — before and after C4 — reports the same engine. Making it discriminate is
obligation O-0 of `docs/c4-preamble-design.md`. Until it lands, a delta against this baseline must state
the engine commit by hand.

Cal.com 10 Surface A is on disk. Skill: `skills/martian-bench/SKILL.md`. Next spends, when authorised: (1) Surface B vs stored Greptile/CodeRabbit comments, (2) inject into a copy of `benchmark_data.json` and run *their* judge if a key appears, (3) a second methodology arm on the same 10 (one variable). Not the 50. Do not chase this F1.

## Cal.com 10 results (2026-08-19)

Ledger. Pipeline `hunters` (reliability/resilience/lifecycle + refuter), scout off, summarizer off, parity off, prompt set `slice3b-lifecycle-v6-clean` (`sha256: 5ac28df9bddbd4c8`). Local `--two-dot`, never `--pr`. Codegraph not built (hunters on Read/Grep/Glob). Clone: `~/Desktop/martian-cal/cal.com`. Runs: `~/Desktop/martian-cal/runs/cal-<pr>-hunters`. Judge artifact: `~/Desktop/martian-cal/runs/martian-judge.json`.

**Judge (Surface A):** Martian `JUDGE_PROMPT`, Claude Code CLI, `sonnet`, `tools: []`. Not `MARTIAN_API_KEY`, not their published Opus 4.5 / Sonnet 4.5 / GPT-5.2 rows. Sibling `path:line` are not extra FPs. Unreplicated. Cal.com only. **Do not quote as the 50-PR offline board.**

Reviews **$42.43** (~74 min serial: 3-PR pilot + remaining 7). Judge **$0.89** (~4 min). **Total $43.32.**

| | P | R | F1 | tp | fp | fn | gold |
|---|---|---|---|---|---|---|---|
| **All** (what the script scored) | 0.44 | 0.41 | 0.43 | 17 | 22 | 24 | 41 |
| Strict recall, gold-side only (`bug/security/concurrency/data/api`) | — | 0.49 | — | 17 | — | 18 | 35 |
| Core recall, gold-side only (+ `perf/test_gap/doc_defect`) | — | 0.46 | — | 17 | — | 20 | 37 |

Precision is All-profile only: candidates are not categorized, so Strict/Core P is not computed here. 22532’s one TP is a **weak 0.65** same-site match — the golden says empty `{}` does *not* bump `@updatedAt`; our claim says it *does*, for the wrong scope. Count it, but do not treat it as a clean hit.

| PR | Files / eff. lines | Cost | Findings | tp/fp/fn | P / R | vs goldens (judge) |
|---|---|---|---|---|---|---|
| [14943](https://github.com/calcom/cal.com/pull/14943) | 3 / 44 | **$2.05** | 2 | 1/0/1 | 1.00 / 0.50 | **Hit** High/bug unscoped `deleteMany` (`retryCount > 1` without `method: SMS`). **Miss** High/concurrency atomic `retryCount + 1`. Two findings, same site — sibling rule kept FP = 0 |
| [8330](https://github.com/calcom/cal.com/pull/8330) | 4 / 121 | **$2.61** | 1 | 0/1/2 | 0.00 / 0.00 | **Miss** both Medium/bug goldens (dayjs `===`, `slotStartTime` vs `slotEndTime` — the second was found then merged away). Published claim is a novel busy-check skip → FP vs gold |
| [8087](https://github.com/calcom/cal.com/pull/8087) | 12 / 189 | **$4.85** | 6 | 1/1/1 | 0.50 / 0.50 | **Hit** Critical/concurrency `forEach`+async. Sibling rule collapsed extra sites to one FP. **Miss** Low/speculative try/catch (F004 nearby, not matched) |
| [10600](https://github.com/calcom/cal.com/pull/10600) | 16 / 294 | **$3.72** | 5 | 1/4/4 | 0.20 / 0.20 | **Hit** High/concurrency backup-code TOCTOU. **Miss** Medium/bug case-sensitive `indexOf`, plus style/docs/perf. Novels: totp gate, un-awaited Playwright assert, modal step leak |
| [10967](https://github.com/calcom/cal.com/pull/10967) | 22 / 388 | **$6.57** | 9 | 3/5/3 | 0.38 / 0.50 | **Hit** High/bug null `destinationCalendar`, High/bug self-`.find` on `externalId`, Medium/bug inverted org `slug`. **Miss** High/bug undefined `credential` into `updateEvent`, Low/api interface contract |
| [22345](https://github.com/calcom/cal.com/pull/22345) | 2 / 345 | **$2.03** | 0 | 0/0/2 | 0.00 / 0.00 | Empty review. **Miss** Low/bug unreachable SQL branches and Medium/speculative org-member filter. Insights/`Prisma.sql` is outside the hunter profile |
| [7232](https://github.com/calcom/cal.com/pull/7232) | 10 / 210 | **$5.38** | 6 | 2/1/1 | 0.67 / 0.67 | **Hit** Medium/concurrency unawaited `forEach` reminder deletes, High/data `immediateDelete` orphan row. **Miss** Medium/data nullable `cancelled` |
| [11059](https://github.com/calcom/cal.com/pull/11059) | 40 / 372 | **$7.43** | 14 | 6/3/3 | 0.67 / 0.67 | Best cell. **Hit** six High OAuth/credential-sync bugs (`refresh_token` literal, Zod computed keys, SafeParse wrapper stored as `key`, fetch `Response` vs `.data`, HubSpot shape, Bigin `credentialId` as `userId`). **Miss** Salesforce `statusText` / stale jsforce / webhook 400 vs 500 |
| [14740](https://github.com/calcom/cal.com/pull/14740) | 15 / 555 | **$3.50** | 7 | 2/5/4 | 0.29 / 0.33 | **Hit** High/security blacklist case bypass, Medium/bug wrong guests array for emails. **Miss** Critical/bug `isTeamAdmin && isTeamOwner` (should be `\|\|`), in-input dups, empty-string init, `disableStandardEmails` |
| [22532](https://github.com/calcom/cal.com/pull/22532) | 17 / 389 | **$4.30** | 3 | 1/2/3 | 0.33 / 0.25 | Weak TP on `updateManyByCredentialId({},)`. **Miss** Low/bug macOS `sed -i`, High/api generic `Error` → 500, Medium/bug hardcoded `en-US`. Novels: DWD `credentialId = -1`, cache-delete `onSuccess` no-op |

Profile confirmed off musive: concurrency / lifecycle / OAuth-credential plumbing **yes**. Small local logic (dayjs, slot arithmetic, SQL dead branches, locale, `sed`) **no**. 11059 is the hunter set doing what it is for. 8330 and 22345 are the counterexamples. 14740’s missed Critical `&&` vs `||` is a reliability miss worth a later one-variable look — not a reason to edit the prompt set tonight.

Commands:

```bash
bun run scripts/martian-cal.ts plan|check|run|score   # default = 3-PR pilot; --all = ten
bun run scripts/martian-judge.ts                      # Surface A on existing runs
```

## Cal.com 10 arm `opencode-glm` (2026-09-11, Surface A)

Second methodology arm. One variable vs `hunters`: the model route —
`opus` logical → `opencode-go/glm-5.3-flash#high [configured, opencode]` for
all 5 steps (`--model opus`; frontmatter `sonnet` overridden by CLI
precedence), same prompt set `slice3b-lifecycle-v6-clean`
(`sha256: 5ac28df9`), scout off, summarizer off, parity never fires. Local
`--two-dot`, never `--pr`. Runs: `~/Desktop/martian-cal/runs/cal-*-opencode-glm`.
Judge artifact: `~/Desktop/martian-cal/runs/martian-judge-opencode-glm.json`.

**Judge (Surface A):** Martian `JUDGE_PROMPT`, Claude Code CLI, `sonnet`,
`tools: []` — same judge shape as the baseline (gateway + model labelled, not
Martian's Opus 4.5 rows). Sibling `path:line` not extra FPs. Unreplicated.
Cal.com only. **Do not quote as the 50-PR offline board.**

Reviews **$0.84** (~2.5 h serial). Judge **$0.00** (subscription). **Total $0.84.**

| | P | R | F1 | tp | fp | fn | gold |
|---|---|---|---|---|---|---|---|
| **All** (what the script scored) | 0.47 | 0.51 | 0.49 | 21 | 24 | 20 | 41 |
| **High+Critical recall (headline)** | — | **0.68** | — | 13 | — | 6 | 19 |
| Strict recall, gold-side only (`bug/security/concurrency/data/api`) | — | 0.60 | — | 21 | — | 14 | 35 |

Delta vs `hunters` (tp/fp/fn): All P 0.44→0.47, R 0.41→0.51, F1 0.43→0.49;
Strict recall 17/35→21/35; **High+Critical recall 13/19 identical with
different composition.**

| PR | Findings | tp/fp/fn (`hunters`) | vs goldens (judge) |
|---|---|---|---|
| 14943 | 4 | 1/3/1 (1/0/1) | Same High/bug hit (unscoped `deleteMany`), +3 FP |
| 8330 | 6 | 2/4/0 (0/1/2) | **Best delta: both Medium/bug goldens HIT** (dayjs `===`, slot arithmetic) — the baseline's zero cell |
| 8087 | 4 | 1/0/1 (1/1/1) | Same Critical/concurrency `forEach` hit, FP 0 (was 1) |
| 10600 | 4 | 2/2/3 (1/4/4) | Kept High/concurrency TOCTOU, +Medium/bug, fewer FP |
| 10967 | 13 | 5/5/1 (3/5/3) | +2 TP (extra High/bug ×2); miss Low/api contract stands |
| 22345 | 1 | 0/1/2 (0/0/2) | Still ~empty (Insights/`Prisma.sql` outside hunter profile), +1 FP |
| 7232 | 11 | 2/4/1 (2/1/1) | Same Medium/concurrency + High/data hits, +3 FP |
| 11059 | 6 | 5/0/4 (6/3/3) | −1 TP (miss Salesforce-adjacent High), **zero FP** (was 3) |
| 14740 | 2 | 1/1/5 (2/5/4) | **Regression cell:** missed High/security blacklist bypass (baseline hit) and still misses Critical `&&` vs `\|\|`; sparse (2 findings) |
| 22532 | 8 | 2/4/2 (1/2/3) | Medium/bug + High/api hits (pair confidences not audited; baseline's TP was a flagged-weak 0.65) |

Profile: small-local-logic goldens (8330) now hit — the baseline's counterexamples
are shrinking. 14740 is the new counterexample (sparse + missed security High).
Cost per review collapsed ($0.04–0.19 vs $2–7): opencode-go/glm pricing, provider-reported.

How this arm came to be (one line each, full story in the session):
1. `hunters` re-run on the current global routing silently became an opencode
   arm (logical `sonnet` → default `opencode-go/deepseek-flash#high`).
2. That arm observed 8/10 failures: gateway `UnknownError` 500s and quiet timeouts
   investigated via `scripts/opencode-prompt-probe.ts`.
3. Historical attempts with `deepseek-flash` produced errors or empty results;
   `glm-5.3-flash` produced text in some attempts. The old probe generated its
   witness from the final result, so those records do **not** establish a
   provider outage, model health, or the cause of missing text. Treat their
   causal attribution as inconclusive, not as route qualification.
4. Historical retry, round-count timeout, and zero-spend patches were later
   audited. Missing observations do not prove non-execution or genuine zero
   cost. The corrective phase replaces those assumptions with monotonic
   bounds, incomplete accounting, and actual same-attempt observations.
5. Engine for this arm: `24115ab` + uncommitted `src/transports/opencode-sdk.ts`
   (Fix 1–3), `test/conformance/opencode-sdk-transport.test.ts`,
   `test/harness/spend-wiring.test.ts`, `scripts/martian-cal.ts` (`--arm`,
   `--model`), `scripts/martian-judge.ts` (`--arm`, 0600 fix),
   `scripts/opencode-prompt-probe.ts` (new). Harness `--arm`/`--model` support
   is arm infrastructure, not a methodology variable.
6. A same-night `opencode` (deepseek) arm attempt is NOT scored: cause unproved,
   0/10 PRs with findings on the final try (`cal-*-opencode` dirs stand,
   empty, as incomplete attempt records). Only `hunters` and `opencode-glm` are scored.
7. Regression gates: `bun run fixture-eval` pass (planted bug hit; runs
   `haiku`→glm-low route); refuter untouched so `refuter-probe` not re-run.

Surface B: **not run** (stored vendor reviews not bucketed for the ten).

## Cal.com 10 arms of 2026-09-17 (luna): miss attribution, the jev scout, and the `logic` hunter

Four arms, same day, same engine build, same base prompt set (`slice3b-lifecycle-v6-clean`), scout off unless
stated, summarizer off, parity never fires, no codegraph (matching CI, which installs none). **Hunters and
refuter ran on `opencode/openai gpt-5.6-luna`**, because the operator routing sends logical `sonnet` there —
the same silent-routing trap already recorded for an earlier `hunters` re-run. That makes these arms
comparable to each other and **not** to the 2026-08-19 Claude baseline. Subscription billing: $0.00 cash,
~1.8–2.8M tokens per arm.

Judge: Surface A, Martian `JUDGE_PROMPT`, Claude Code CLI `sonnet`, `tools: []` — but run from a scratch copy
with the **evidence-qualification gate bypassed**, because the OpenCode transport left 3–5 of 10 runs per arm
unqualified ("missing frozen request plan", "incomplete OpenCode capture"). The numbers below therefore score
`findings.json` directly. Surface B: **not run**.

| arm (mean of 2 runs) | gold TP /41 | FP | H+C /19 | precision | tokens |
|---|---|---|---|---|---|
| `luna-control` (3 hunters) | 14.0 | 16 | 11.5 | ~0.47 | 1.78M |
| `reliability-b` (reliability twice — equal-effort control) | 15.0 | 23 | 11.5 | ~0.39 | 2.47M |
| `logic` (+ logic hunter, JS/TS checklist — **contaminated, discarded**) | 19.0 | 18 | 14.0 | ~0.51 | 2.47M |
| `logic-agnostic` (+ logic hunter, 46 CWE checks) | **19.0** | 21.5 | **14.0** (14 in both runs) | ~0.47 | 2.63M |
| `jev-scout` (Jev as the scout stage, one run) | 18 | 19 | 13 | ~0.49 | 2.33M |

Per run, so the variance is visible: control 14/14 TP and 12/11 H+C; `reliability-b` 16/14 and 14/9; `logic`
18/20 and 12/16; `logic-agnostic` 18/20 and 14/14.

**What each arm settles.**

- The `logic` hunter's gain is **not** extra effort: `reliability-b` spends the same tokens for +1 TP and +7 FP.
- It is **not** the contaminated checklist either: replacing it with 46 language-agnostic CWE checks, written
  by a worker that never saw the goldens, keeps the same TP and the same H+C.
- It is mostly **consistency**, not new classes: only 1–3 goldens are unique to a logic arm; the rest are
  goldens the control finds *sometimes*. For a reviewer that runs once per PR, that is the whole point.
- The Jev scout stage bought recall at the same exchange rate as extra hunter budget, and ~40% of its apparent
  gain was run-to-run variance. Not adopted; `docs/research/jev-evaluation.md` records the eleven arms behind
  that call.

**Caveats.** n=10 PRs, 2 replicates, one corpus, and the logic hunter's *method* was designed from the miss
attribution of these same PRs (its checklist was not). A validation on a corpus that played no part in the
design is still owed.

**Miss attribution over these arms** — 28 distinct missed goldens, 50 golden×arm pairs; detail in
`docs/research/local-logic-misses.md`:

| | |
|---|---|
| Inside the diff | 26 of 28 |
| Never drafted by any hunter | 48 of 50 pairs (96%) |
| Lost to the refuter / to dedupe | 0 / 0 |
| Local-logic shape | 20 of 28 |
| Inside some hunter's stated scope | 54% (and 7 of 8 H+C) |
| Parity hunter fired | 0 of 20 runs |

## Cal.com 10 arm `dev-default` (2026-10-25, Surface A)

What `dev` ships, scored as-is for the landing page. Engine `0ded569`, bundled prompt set `prompts/default`
(`sha256: 9d195dd80531f42c`): reliability, resilience, lifecycle and logic hunters on `sonnet` at `xhigh`, refuter on
`opus` at `high`, parity never fired, scout off, summarizer off, no codegraph. Local `--two-dot`, never `--pr`. Effort
was checked in every request plan, because the `s55` arm ran at the CLI's implicit `medium` without anyone noticing.
**Several variables differ from `hunters`** (prompt set, effort, refuter model, logic hunter), so this is a snapshot
of dev, not an ablation.

Judge: Martian `JUDGE_PROMPT`, Claude Code CLI `sonnet`, `tools: []`, siblings at the same `path:line` not extra
FPs. Not Martian's Opus 4.5 gateway, so these numbers never sit next to their published vendor rows. Unreplicated.
Cal.com only. Surface B: **not run**.

| | P | R | F1 | tp | fp | fn | gold |
|---|---|---|---|---|---|---|---|
| All | 0.38 | 0.71 | 0.49 | 29 | 48 | 12 | 41 |
| **High+Critical recall (headline)** | — | **0.84** | — | 16 | — | 3 | 19 |

| PR | tp/fp/fn |
|---|---|
| 8087 | 2/1/0 |
| 8330 | 1/6/1 |
| 10600 | 3/7/2 |
| 10967 | 4/11/2 |
| 11059 | 8/4/1 |
| 7232 | 2/4/1 |
| 14740 | 4/5/2 |
| 14943 | 1/3/1 |
| 22345 | 1/1/1 |
| 22532 | 3/6/1 |

Missed High+Critical: 10967 (undefined `credential` passed to `updateEvent`), 11059 (Salesforce checks `statusText`
instead of `ok`), 14943 (stale `retryCount + 1` under concurrency).

Same judge, same ten PRs, one run each: `hunters` (2026-08-19) H+C 13/19, R 0.41, P 0.44; `s55` (2026-10-02) H+C 17/19,
R 0.71, P 0.53; `opush` (2026-10-02) H+C 19/19, R 0.71, P 0.47. `dev-default` matches their recall with lower
precision, because it raises more advisory findings. A gap of 1–3 H+C is inside the run-to-run variance measured on
2026-09-17.

Cost: Claude subscription, $0 cash; 19.5M tokens, $21.87 at API prices for the ten reviews; judge $0.

**Engine bug found by this run.** All ten runs completed and were quarantined as `missing frozen request plan`.
`freezeAttemptEvidenceIdentity` (`src/execution/attempt-evidence.ts`) races the plan write against a 100 ms timer and
returns before it sets `requestPlan`, so the evidence lacks the pointer while the sibling `.request.json` is on disk.
The judge ran from a temporary copy that falls back to the sibling file and still runs every digest and field check.
The patch and raw data are in the lab, `bench/experiments/2026-10-25-martian-cal-dev-default/`. The engine fix is
still owed.

## Benchmark qualification gates and metrics (Unit 7)

Only **schema-valid, attributable completed attempts** qualify for resume and
quality scoring. Historical files without real proof remain unqualified; they
are not silently upgraded by the new loader.

| Gate | Required evidence |
|---|---|
| Schedule | `schedule-<arm>.json` freezes selected PRs, head/base, replicate and output directory before execution. `--reps` creates separate attempt directories. Selection changes require a new arm. |
| Identity | `run-identity.json` freezes engine commit and file digests, prompt/config content, effective routes and observed executable/SDK/server identity. Missing identity refuses qualified reuse. |
| Completion | Findings schema validator, all required hunters and executed steps, actual delivered outcome, verified integrity, attributable terminal proof, matching request-plan/output/capture hashes. Mere file existence or a finish string is insufficient. |
| Isolation | Artifact reads are bounded, confined to the run directory, and reject traversal, nonregular files and symlink escapes. |
| Retry | A failed or mismatched previous directory is moved intact under `incomplete-attempts/`; it is never overwritten by the replacement attempt. |

OpenCode capture records real SDK wire metadata/body, events, prompt result and
same-session readback. Missing, capped or failed capture is inconclusive. A local
abort acknowledgement does not prove provider cessation. Claude uses its own
generic process-exit proof; OpenCode finish rules are not imposed on Claude.
A schema-valid `findings: []` with attributable proof is a completed empty review,
not transport failure. Neither zero findings nor successful delivery proves model
quality.

### Denominators and unknown telemetry

- **Completion rate:** completed / attempted. **Coverage:** completed / scheduled.
  Missing scheduled attempts are reported explicitly, including zero output dirs.
- **Cost per complete:** completed spend / completed reviews, only when every
  completed attempt has exact known spend. Otherwise the metric is `null`/unknown.
- **Wall time per complete:** completed wall time / completed reviews, subject to
  the same knownness rule. Known subtotals and unknown sample counts are separate.
- Failed attempts do not enter quality scores. Their reported spend remains in
  partial/all-attempt accounting; unknown spend never becomes zero. Preserved
  previous executions contribute spend and unknown counts, with a separate
  `preserved_attempts` count; they do not inflate the frozen schedule denominator.
- **H+C:** report High/Critical recall and TP/FN counts only. All-severity false
  positives cannot support an H+C precision/F1 claim.
- **Surface A:** offline judge output. **Surface B:** not run; no surfaced-success
  claim is made.

Tasks 8.1/8.2 remain a later, explicitly budgeted and ledgered phase: current
OpenAI/DeepSeek/MUSE route qualification, serial/concurrent repetitions, then
frozen paired benchmarks. These code corrections do not claim live qualification,
provider health, guaranteed model quality, or approval for fifty-PR expansion.

## Sources

- https://codereview.withmartian.com/
- https://github.com/withmartian/code-review-benchmark
- https://withmartian.com/post/code-review-bench-v0
- https://github.com/withmartian/code-review-benchmark/blob/main/methodology/full.md
- https://huggingface.co/datasets/code-review-bench/code-review-bench
- Internal: `ROADMAP.md` (THE PIVOT, C10, D3), `docs/review-strategies.md`, `docs/doordash-dashbench-trust.md`, `src/compare.ts`

