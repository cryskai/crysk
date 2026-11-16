# The scout — design (ROADMAP-DOORDASH M3) and its frozen control set (M0)

Status: **RETIRED 2026-11-16: the scout stage was removed from the engine; this document is kept as history, and the line below no longer applies. M0 section filled 2026-08-16, design (M3) written 2026-08-16, never ratified.**
Nothing in M4–M6 starts before Juanma ratifies §3.14.

This file has two jobs. The first, done here, is to freeze what the paid A/B in M6 will be read against —
the runs already on disk, the buckets they produced, and the adjudicated verdict on every finding Greptile
caught that pr-hero missed. The second, M3's, is the scout design itself.

---

## 1. The control set (frozen 2026-08-16)

### 1.1 THESE RUN DIRS MUST SURVIVE UNTIL M6

**There is no TTL that deletes them, and there is no mechanism that protects them either.** Verified at
freeze time: `pr-hero gc` collects worktrees under `~/.prhero/repos/*/worktrees` only (`src/gc.ts:1-6`,
`src/gc-preflight.ts:5-7`) and never touches a runs root. So nothing will delete these — but nothing will
stop a hand from deleting them either, and they are **not under version control**. Re-creating them costs
a full control arm: ~30 live runs, real money, and models that have moved since.

The three roots, none of which may be pruned:

- `~/Desktop/musive/musive-s1-prhero-runs/`
- `~/Desktop/musive/musive-s2-prhero-runs/`
- `~/Desktop/musive/musive-s3-prhero-runs/`

> **THIS ALREADY HAPPENED — 2026-08-17, one day after the freeze.** All three roots were found in
> `~/.Trash`, discovered by accident while M4 was looking for the probe's input diffs, not by any check
> that exists. They were restored to the paths above with `cp -Rp`, and the restore was verified three
> ways: the counts match this section exactly (3 / 8 / 19 `comparison.json`, plus s3's
> `pr-1698-4ca9628a-1` with none, as §1.2 records); `diff -r` against the Trash copies is byte-identical
> for all three; and the `pr-1682-e3ab386a` replicate pair kept its original mtimes (`-1` 2026-08-10
> 21:55, `-2` 2026-08-11 16:37), which §2.6's defect 1 makes load-bearing — a plain `cp` would have
> restamped them and silently flipped which run votes in the ledger. **Nothing was lost.** The Trash
> copies were left in place as a second copy; emptying the Trash is now safe, and was not before.
>
> The warning above was correct and cost nothing to write. What it did not have was a mechanism. The
> paragraph says "nothing will stop a hand from deleting them"; a hand did, within 24 hours. Until M6
> consumes them, their presence is a precondition of every milestone that reads them: **M4 (probe input
> diffs), M6 (the control arm, and the variance third point), and every M0 verdict, which exists nowhere
> except inside these `comparison.json` files.**
>
> **The mechanism now exists: `docs/control-set-manifest.sha256`**, 635 files with their digests, paths
> relative to `~/Desktop/musive/`, committed to this repository — which is the point, since the runs
> themselves cannot be. It turns a future loss from accidental into loud. Verify with:
>
> ```
> cd ~/Desktop/musive && shasum -a 256 -c ~/Desktop/pr-hero/docs/control-set-manifest.sha256
> ```
>
> A failure means a file changed, moved or vanished. Note the one expected exception: **triaging a run
> rewrites its `comparison.json`**, so a verdict written after this manifest was generated shows up as a
> mismatch on that file and the manifest is regenerated deliberately, in the same commit as the verdict.
> A mismatch nobody can explain that way is the alarm this section wanted.

**There are five runs roots on disk, and only these three are the control set.** Named here so the next
reader does not have to re-derive it — and because this file's first draft said "three roots" as though
that were all of them:

| root | runs | Greptile | in the control set |
| --- | --- | --- | --- |
| `musive/musive-s1-prhero-runs` | 3 | yes | **yes** |
| `musive/musive-s2-prhero-runs` | 8 | yes | **yes** |
| `musive/musive-s3-prhero-runs` | 19 | yes | **yes** |
| `supermarket-pro-prhero-runs` | 3 (PRs 107, 109, 110) | **no** — `greptile_found: false` | no |
| `pr-hero-prhero-runs` + `~/.prhero/repos/.../pr-hero/runs` | 8 + 2 | **no** — `greptile_found: false` | no |

The two excluded roots are excluded for one reason only: Greptile is not installed on those repositories,
so every run there is `greptile_found: false` with **zero `greptile_only` rows** and no head-to-head to
read. This is what keeps §2's claim exact — *all* 18 `greptile_only` rows that exist anywhere on disk are
adjudicated, not merely all of them in the three roots above. Their 15 `prhero_only` rows are untriaged
and are not part of any count in this file.

### 1.2 What is actually there

**30 runs over 19 distinct PRs**, every one `run_status: complete` with `greptile.found: true`. All 30
ran with `model: sonnet` on every step, so the corpus is one configuration, not a mix.

> Correction to `ROADMAP-DOORDASH.md`'s state section, which was written from `musive-s3` alone and
> miscounted even that: it says "15 distinct PRs / 19 runs / 11 `greptile_only`, 13 `both`, 28
> `prhero_only`". The verified figures are below. The s1 and s2 roots were missed entirely, and they carry
> PRs 1710, 1719, 1720 and 1721 that appear nowhere in s3.

| PR | head | run dir | root | G-only | both | ph-only | rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1682 | `e3ab386a` | `pr-1682-e3ab386a-1` | s3 | 1 | 0 | 4 | 5 |
| 1682 | `e3ab386a` | `pr-1682-e3ab386a-2` | s3 | 0 | 1 | 3 | 4 |
| 1698 | `4ca9628a` | `pr-1698-4ca9628a-2` | s3 | 0 | 0 | 2 | 2 |
| 1700 | `f3175dea` | `pr-1700-f3175dea-1` | s3 | 1 | 0 | 1 | 2 |
| 1703 | `91ddfee1` | `pr-1703-91ddfee1-1` | s3 | 0 | 0 | 2 | 2 |
| 1703 | `b7b5cf1c` | `pr-1703-b7b5cf1c-1` | s3 | 0 | 0 | 1 | 1 |
| 1703 | `b7c4ae5a` | `pr-1703-b7c4ae5a-1` | s1 | 0 | 0 | 1 | 1 |
| 1705 | `28142bef` | `pr-1705-28142bef-1` | s3 | 1 | 0 | 2 | 3 |
| 1705 | `bcbac026` | `pr-1705-bcbac026-1` | s3 | 1 | 0 | 3 | 4 |
| 1707 | `dc388c06` | `pr-1707-dc388c06-1` | s3 | 1 | 1 | 0 | 2 |
| 1708 | `d720e927` | `pr-1708-d720e927-1` | s3 | 0 | 0 | 1 | 1 |
| 1710 | `9a2eea8b` | `pr-1710-9a2eea8b-1` | s2 | 1 | 0 | 0 | 1 |
| 1711 | `c3e3838a` | `pr-1711-c3e3838a-1` | s3 | 0 | 2 | 0 | 2 |
| 1711 | `c3e3838a` | `pr-1711-c3e3838a-1` | s2 | 1 | 1 | 0 | 2 |
| 1714 | `c3235192` | `pr-1714-c3235192-1` | s3 | 1 | 0 | 3 | 4 |
| 1714 | `c3235192` | `pr-1714-c3235192-1` | s2 | 1 | 0 | 3 | 4 |
| 1715 | `dc086cd1` | `pr-1715-dc086cd1-1` | s2 | 0 | 0 | 2 | 2 |
| 1715 | `dc086cd1` | `pr-1715-dc086cd1-1` | s3 | 0 | 0 | 2 | 2 |
| 1716 | `13218672` | `pr-1716-13218672-1` | s3 | 0 | 1 | 0 | 1 |
| 1717 | `052f77cb` | `pr-1717-052f77cb-1` | s3 | 1 | 3 | 0 | 4 |
| 1717 | `052f77cb` | `pr-1717-052f77cb-1` | s1 | 2 | 0 | 0 | 2 |
| 1718 | `902cca91` | `pr-1718-902cca91-1` | s3 | 0 | 1 | 0 | 1 |
| 1718 | `902cca91` | `pr-1718-902cca91-1` | s2 | 1 | 0 | 0 | 1 |
| 1719 | `43f5098f` | `pr-1719-43f5098f-1` | s2 | 2 | 0 | 3 | 5 |
| 1720 | `8888a69e` | `pr-1720-8888a69e-1` | s2 | 0 | 0 | 0 | 0 |
| 1721 | `ea23c289` | `pr-1721-ea23c289-1` | s2 | 0 | 0 | 1 | 1 |
| 1722 | `24a27ba8` | `pr-1722-24a27ba8-1` | s3 | 1 | 1 | 2 | 4 |
| 1722 | `24a27ba8` | `pr-1722-24a27ba8-2` | s3 | 0 | 2 | 2 | 4 |
| 1724 | `bda807b3` | `pr-1724-bda807b3-1` | s3 | 2 | 0 | 0 | 2 |
| 1724 | `bda807b3` | `pr-1724-bda807b3-1` | s1 | 0 | 4 | 1 | 5 |

`musive-s3-prhero-runs/pr-1698-4ca9628a-1/` exists but carries no `comparison.json` and is not part of
the set.

**Two views of the same 74 rows, because they answer different questions:**

| view | `greptile_only` | `both` | `prhero_only` | rows |
| --- | --- | --- | --- | --- |
| summed over all 30 runs | 18 | 17 | 39 | 74 |
| one vote per PR, latest run only (what `pr-hero ledger` reports) | see below | | | |

`pr-hero ledger` takes a single `--runs` root, so the latest-run view exists only per root today: s1 gives
`2 / 4 / 2` over 3 PRs, s2 gives `6 / 1 / 9` over 8 PRs, s3 gives `8 / 10 / 18` over 15 PRs. **A
cross-root ledger does not exist.** M6 needs one number over the whole set, so either the ledger learns to
take several roots or M6 aggregates by hand and says so.

### 1.3 Run-to-run variance, measured for free

Eight PRs were reviewed twice at the **same head with the same configuration**. This is the third data
point M6's protocol asks for — how much the buckets move on replay alone — and it was already paid for:

| PR | head | run A (G/both/ph) | run B (G/both/ph) | moved |
| --- | --- | --- | --- | --- |
| 1682 | `e3ab386a` | s3 1/0/4 | s3 0/1/3 | yes |
| 1711 | `c3e3838a` | s3 0/2/0 | s2 1/1/0 | yes |
| 1714 | `c3235192` | s3 1/0/3 | s2 1/0/3 | no |
| 1715 | `dc086cd1` | s2 0/0/2 | s3 0/0/2 | no |
| 1717 | `052f77cb` | s3 1/3/0 | s1 2/0/0 | yes |
| 1718 | `902cca91` | s3 0/1/0 | s2 1/0/0 | yes |
| 1722 | `24a27ba8` | s3 0/2/2 | s3 1/1/2 | yes |
| 1724 | `bda807b3` | s3 2/0/0 | s1 0/4/1 | yes |

**Six of eight pairs moved.** The two extremes are the ones M3 must design around: at `1717@052f77cb` one
run matched three of Greptile's findings and the other found nothing at all; at `1724@bda807b3` one run
matched four and the other matched zero. Those are not small deltas — they are the whole effect size the
scout is expected to produce.

The consequence for M6 is direct and unwelcome: **`R ≥ 2` replicates is very likely not enough** to
separate a scout effect from this noise, and the A/B protocol must be sized against these numbers rather
than against the roadmap's provisional `N=8, R=2`. M3 owns that calculation.

---

## 2. The M0 triage — every `greptile_only` row now carries a verdict

All **18** `greptile_only` rows across the 30 runs are adjudicated (16 written in M0, 2 pre-existing).
They cover **16 distinct findings**; two findings appear twice because the same PR was reviewed in two
roots (`1717` Styles.ts:84 in s1+s3, `1714` AudioPlayerStore.ts:400 in s2+s3), and both copies carry the
same verdict.

### 2.1 The vocabulary

Deliberately NOT the four triage tags (`applied`/`dismissed`/`deferred`/`misclassified`, `src/triage.ts:26`):
those describe what a PR author did about a pr-hero finding. These rows are findings pr-hero never made,
so the question is different — was it a real miss? The four strings below are the ones already on disk
from the earlier hand-triage of PRs 1700, 1703, 1682, 1698 and 1705, and `pr-hero ledger` tallies them
as-is:

- **`true-positive`** — a real defect, reachable at that head, traced end to end in code. **A genuine miss.**
- **`latent`** — the mechanism is real but not reachable at that head, or defused elsewhere in the PR chain.
- **`out-of-scope`** — a real observation, but style, convention, naming, type hygiene or a refactor
  suggestion. No behaviour at risk.
- **`false-positive`** — the claim is wrong at that head, with cited disproof.

### 2.2 The result

| verdict | rows |
| --- | --- |
| `true-positive` | **5** |
| `out-of-scope` | 10 |
| `latent` | 2 |
| `false-positive` | 1 |

**Only 5 of 18 `greptile_only` rows are real misses.** Eleven of eighteen — 61% — are not defects at all.

This is the single most consequential number M0 produced, and it changes how M6 must be read: the
`greptile_only` bucket **cannot be used as a raw score**. A scout arm that shrinks the bucket by absorbing
Greptile's convention opinions has not improved recall, it has learned to imitate a house style. M6 must
score against the adjudicated `true-positive` subset, never against bucket volume.

### 2.3 The five real misses — M4's target list

These are the only rows a scout-probe may plant as targets, because a target that is not a real defect
poisons the probe from the first run:

| PR | head | site | what pr-hero missed |
| --- | --- | --- | --- |
| 1717 | `052f77cb` | `packages/app/components/PaywallUpgrade/index.tsx:119` | Autoplay writes the destination index before `scrollToIndex`; in-flight `onScroll` rounds back to the source index and overwrites it. |
| 1719 | `43f5098f` | `packages/backend/src/Infrastructure/Http/SongSourceResolver.ts:296` | Pin-freshness check has no lower bound, so a future-dated `verifiedAt` passes; Redis re-arms the sliding TTL on every read, making a skewed pin effectively immortal. |
| 1722 | `24a27ba8` | `packages/backend/src/Utils/m4aRemux.ts:181` | `readMdatSize` trusts the declared atom size without checking it reaches EOF, so a truncated remux passes verification and overwrites the original object. |
| 1724 | `bda807b3` | `docs/runbooks/mus-638-song-bucket-rollout.md:144` | `$url` is unset under `set -u` in the emergency-rollback block, aborting after every mutation but before the direct-delivery proof. |
| 1724 | `bda807b3` | `docs/runbooks/mus-638-song-bucket-rollout.md:140-142` | App Runner poll has no deadline and no default arm; `ROLLBACK_*` statuses and a `None` lookup both spin forever. |

Two of these deserve a note in M3, because they shape what the scout must be able to see:

- **1722 is a regression the author confirmed.** The same PR's later commit `019547458` restores the guard
  as `if (offset + size > fileSize) return undefined;` under the comment *"The declared size is a claim,
  not a measurement"*, and its message names it *"a regression I introduced"*. It was findable from the
  diff: the diff itself replaces a whole-file-size comparison with an mdat-size one.
- **Two of the five live in a markdown runbook**, not in code. A diff-only scout reads them fine. A scout
  whose prompt implicitly assumes TypeScript will skip 40% of this target list.

Every verdict's full reasoning, with the `file:line` evidence it was read from, is in the row itself
(`reasoning` field of the matching `comparison.json`), never only here.

### 2.4bis The revert corpus, measured — it is small, and that is the finding

`pr-hero reverts` (#41) was built the same day and run over both repositories that have real history. The
numbers matter more than the tool:

| repository | window | commits scanned | candidates | body-linked | usable |
| --- | --- | --- | --- | --- | --- |
| `MusiveTech/musive` | 24 months | 4780 | 9 | 4 | **~3** |
| `JuanchiiGomezZ/supermarket-pro` | 24 months (whole history: Jan–Aug 2026) | 1624 | **0** | 0 | 0 |

The three usable musive cases are PRs **1160** (`fix: race condition restructure`, +25/−47 over 3 files,
reverted after 19 minutes), **1276** (`Fix/no ref/public project control slider`, +134/−56 over 4 files,
5 minutes) and **819** (`refactor: new uploading status card`, +569/−326 over 14 files, 4h25m). The fourth
body-linked pair, PR 478 (`feat: username cannot change`), is almost certainly a product decision rather
than a defect. The five pattern-only entries are hotfix merges whose reverted PR does not resolve.

supermarket-pro contributes **nothing** on this axis: 1624 commits and not one revert or hotfix merge.
Its history is seven months old, which is the likeliest explanation, and it will contribute later or
never — either way it is not a source of ground truth today.

**Three cases is not a benchmark.** That is the honest read, and it constrains the replacement metric
directly: revert mining can serve as a FLOOR ("the scout must catch these three") but cannot carry M6's
score on its own. Choosing what does is still open and is Juanma's call.

> **FALSIFIED 2026-08-17, and it is worse than "not a benchmark": it is ZERO.** M4's $0 prerequisite —
> extract each usable revert case's defect site — was run, and two of the three cases have positive
> proof that **no defect existed in the reverted patch**, because the identical patch was re-landed:
>
> | PR | evidence | verdict |
> |---|---|---|
> | **1276** | `git diff 1cd18c556 e8e2055ce` is **empty** — the revert was re-landed byte-identically **2m23s later** as #1278 | unusable |
> | **819** | `git patch-id --stable` is `143dbbf68237f07f474d398f4aa287d28a8a4c4d` for BOTH the PR head `ea0312631` and the re-land `dfb7555cc`, five days later | unusable |
> | **1160** | never re-landed (`git log -S'restructureProjectLevels'` returns only the PR and its revert); candidate site `packages/backend/src/App/UseCase/Internal/HandleSongProcessed.ts:162` @ `0674b3adf` | **ambiguous** |
>
> Both re-land checks were re-run by the orchestrator rather than taken from the agent that found them,
> per this project's own rule about load-bearing claims from workers.
>
> **A patch that comes back unchanged is positive proof that no reviewer could have flagged a defect in
> it.** Scoring 1276 or 819 as known-bad would make the floor test assert something demonstrably false —
> the exact failure the floor test exists to avoid. 1160 is the only survivor and it is unconfirmed: its
> PR body is empty, no symptom is recorded anywhere, and "reverted because it did not fix the incident"
> fits the 19-minute window and that afternoon's nine-PRs-of-firefighting as well as "reverted because it
> broke something" does. A human who remembers that afternoon settles it; nothing on disk can.
>
> **The defect this exposes is ours.** `pr-hero reverts` (#41) qualifies a candidate on whether the revert
> links back to the PR, and **never checks whether the reverted patch reappears afterwards**. The missing
> check is cheap, deterministic and needs no model: take `git patch-id --stable` of the PR head and look
> for it later in the history — if it returns, the revert was repository mechanics (a rollback to retry, a
> merge-order round-trip, "not ready for what is shipping"), not a defect. That one check turns 3 into 1
> at $0. Filed as its own issue; §2.4ter's wider sources need the same scepticism applied at adjudication
> time, because blame naming the last toucher is the same class of error.

### 2.4ter The WIDENED corpus, measured 2026-08-17 — reverts were the narrowest slice by two orders of magnitude

`pr-hero corpus` (GitHub #43) run over both repositories with all four sources and the same 24-month
window §2.4bis used. This is the measurement that issue's third acceptance criterion asks for.

| | musive | supermarket-pro |
| --- | --- | --- |
| merged PRs scanned | 1417 | 84 |
| `fix-subject` | 501 | 13 |
| `incident-keyword` | 21 | 10 |
| `bug-issue` | **0** | 1 |
| `proximity` | 20 | 4 |
| `review-thread` (caught in review) | 9 | 0 |
| **tier `issue-linked`** | 0 | 1 |
| **tier `blame-linked`** | **452** | 11 |
| **tier `proximity`** | 20 | 4 |
| **tier `keyword-only`** | 41 | 3 |
| **tier `review-caught`** | 9 | 0 |
| **total candidates** | **513** | **19** |

**What these numbers are NOT.** They are candidates, not cases. The artifact's own warning is the honest
read and it is repeated here because a 513 is exactly the kind of number that gets quoted without its
caveat: *a bug-fix PR proves something was wrong, not that a review should have caught it*, and blame
names the LAST toucher of the fixed lines, not necessarily the introducer. Turning any of these into a
known-bad case still costs one adjudication — the same price M0 paid per `greptile_only` row. What
changed is the SUPPLY, not the price.

**Three findings that do change a decision:**

1. **supermarket-pro goes from contributing nothing to contributing 19**, including one `issue-linked` —
   the strongest tier the artifact has. §2.4bis's "not a source of ground truth today" was true of
   reverts and false of the repository: it has known-bad history, reverts just could not see it.
2. **`bug-issue` is 0 on musive, and that is structural, not a bug.** musive tracks in Jira — its fix
   subjects read `fix(MUS-740):` — so there are no GitHub issues carrying a `bug` label to link to.
   Source 1 of #43 simply does not apply to that repository, and no flag or label list will change it.
3. **`proximity` produced 20 and 4 only because D1 was fixed the same day.** Before the fix the source
   returned zero on both repositories, silently — both use merge commits (musive 200 of 200 sampled,
   supermarket-pro 78 of 100), and `git log --numstat` emits no file lines for a merge without
   `-m --first-parent`. Had this measurement run one hour earlier it would have recorded a false zero
   for a whole source, in this file, as a finding.

**Blame quality, measured rather than assumed:** over musive's 458 blame resolutions, **7 (1%) name an
introducer whose PR number is HIGHER than the fix's**, of which **6 resolve a PR as its own introducer** —
impossible, and a real defect (`joinProximity` guards `ref.pr === fix.fixPr`, `blameResolve` does not).
At 1% it does not threaten the corpus, and it is recorded here rather than fixed.

> **Updated 2026-08-17.** `234a1ef` fixed it — `blameResolve` now drops a resolution landing on the fix PR
> itself, before proximity runs, and #44 is closed. **The table above was NOT regenerated**, by that
> commit's own decision ("no live re-run; the corpus on disk still stands"), so every count in this section
> is still the pre-fix measurement and `blame-linked` 452/11 still carries the ~1%. Anything that consumes
> these numbers as ground truth — growing M6's floor test being the case that matters — re-runs
> `pr-hero corpus` first. The 1 non-self anomaly (a different PR numbered above the fix) was deliberately
> left alone: two PRs merging out of order makes it legitimate.

**What this does and does not do to §3.11.** It removes "there is no cheap source for recall" as a
statement about the WORLD — there is one, and it is on disk. It does not remove the adjudication cost,
so the floor test can grow beyond 8 cases only as fast as someone judges them. The fork stays a fork.

### 2.4quater The first adjudication pass — 10 candidates in, 3 floor cases out

Run 2026-08-17 against the `blame-linked` tier of a re-mined corpus (see the run-hygiene note below). Ten
candidates, one isolated agent each, reading musive at the relevant commits and never the claim's prose.
**Every verdict below was re-verified by the orchestrator with its own git commands** — the project's rule
about load-bearing worker claims, applied because a wrong `usable` makes the benchmark assert something
false.

**Result: 3 usable, 7 not. A 30% conversion rate.**

| fix ← introducer | verdict | site / reason |
|---|---|---|
| 1557 ← 1471 | **usable** | `.github/workflows/build-check.yml` — `bunx biome` unscoped; the repo's linter is `@biomejs/biome`, so bun fetched an unrelated abandoned package that ignores the flags, printed nothing and exited 0. **The gate was green for 18 days without checking a file**; real Biome over the same commit found 10 errors. `git log -S` shows exactly two commits on that line: the introduction and the fix. |
| 1641 ← 853 | **usable** | `packages/app/hooks/useChangeCover.tsx:120` — `const previousProject` declared inside the `try` (93), dereferenced in the `catch` (225), no outer binding. Any upload throw yields `ReferenceError` before the rollback and before the error toast, so the optimistic cover stays applied silently. #853 added the file whole, so the whole mechanism is in its own diff. **The artifact's blamed line 135 is wrong; the site is 120.** |
| 1413 ← 1307 | **usable** | `packages/web/src/store/FileUploaderStore.ts:405` — `refreshSelectedProject()` swapped for `fetchAndSetSelectedProjectByProjectId(projectId)`; on a version upload that id is the TRACK's, so `selectedProject` is overwritten. **The fix repaired two defects and only this one is #1307's** — the stuck-item half blames to `75f84c8b48`, twelve days earlier (verified: 9 of those lines are that commit's, 1 is #1307's). |
| 1693 ← 1506 | rejected | code already present at the merge-base; #1506's hunk is a biome reflow, semantics identical |
| 1639 ← 920 | rejected | #920 ported the structure verbatim from the context file it deleted; the defect predates it |
| 1452 ← 1256 | rejected | #1256 touched 7 files, no driver; the buffering lives in `TigrisDriver.getSongStream` |
| 1516 ← 1014 | rejected | not a defect — #1014's checkout path already emitted the event with `amount_total`/`currency`/`transactionId`; the fix enriches an id shape for a requirement that did not yet exist |
| 1433 ← 639 | rejected | only two commits ever touched that allowlist and #639 is neither; #639 is a 644-file reformat |
| 1460 ← 960 | rejected | blame landed on a signature retype; the authorization hole is ~15 months older |
| 1458 ← 639 | rejected | **on a criterion the adjudication prompt did not state** — see below |

**The criterion that was missing, and it is the orchestrator's omission rather than the adjudicators':
the introducer PR must be REVIEWABLE BY THIS ENGINE.** 1458's defect is real (nested files' bytes never
freed, so `storage_used` is never decremented and FREE-plan owners are blocked by quota they no longer
occupy) and correctly attributed to #639, which created the storage ledger. But #639 is **65,725 changed
lines over 644 files**, and `size-gate.ts` defaults to 1500 lines / 150 files — **43× the line limit**. The
engine refuses the PR, both arms produce nothing, and the case cannot discriminate. A floor case needs a
real defect, correct attribution, diff-visibility AND a reviewable introducer. The three kept cases pass
the gate (282/10, 1125/23, 186/7 lines/files); 853 at 1125 lines is the closest to the limit.

**What the rejections actually say — and it is not what the corpus's own caveat predicted.** The artifact
warns that a bug-fix PR proves something was wrong, not that review should have caught it. That warning
fired **once** (1516). **Five of the six other rejections are misattribution**: blame named a reformat, a
port, a signature retype, or collateral hardening. The `blame-linked` tier is not polluted with non-defects.
It is polluted with the wrong author — which matters, because misattribution is mechanically improvable and
"this was not a defect" is not.

**A generalisable rule one adjudication produced, worth more than its case:** any fix that hardens call
sites as a consequence of a change one layer down will blame the call-site authors. That is systematic, not
bad luck, and it will recur in every driver/adapter fix in this corpus.

### 2.4quinquies `blameResolve` does not pass `-w -M -C`, and the effect is measured not assumed

`src/corpus.ts:561` runs `blame --porcelain -L <range> <parentSha> -- <path>`. No `-w` (ignore whitespace),
no `-M` (follow moves within a file), no `-C` (follow moves between files). Given §2.4quater's rejection
profile, the obvious hypothesis is that these flags fix the tier. **They fix half of it. Both halves were
tested rather than argued:**

| case | blame today | blame with `-w -M -C` |
|---|---|---|
| **1433** (pure tabs→spaces reformat) | `feat(backend): files folder system` — the 644-file reformat, WRONG | **`fix: download song`** — which is exactly the commit the adjudicating agent independently identified as the true origin, by reading the line's history |
| **1693** (biome reflow) | `chore: fix Biome CI on the merged branch` | **unchanged** — still wrong |

The second row is why this is recorded as a partial improvement rather than a fix. `-w` compares lines
ignoring whitespace; splitting a one-line arrow body into three lines produces genuinely new lines, and no
blame flag recovers that. So the flags are worth adding — one row shows two independent methods converging
on the same answer — and they will not by themselves make the tier trustworthy.

**Run hygiene, recorded because it nearly corrupted this section.** The first re-mine of the corpus reported
`blame-linked: 12` against §2.4ter's 452, which read as a catastrophic regression in `234a1ef`. It was not.
A controlled A/B — clean worktrees at `139a2fd` and `8ca557c`, same window, same flags, same clone — returned
**identical** results (340 scanned, 168 fix-subject, 153 blame-linked, 15 keyword-only), exonerating the
commit. The real cause was a transient `gh: Bad credentials (HTTP 401)` mid-run, invisible because the run
was captured with `tail`. A clean re-run gave **428 blame-linked**, consistent with §2.4ter. Two lessons,
both cheap: capture whole logs rather than tails, and **the corpus artifact has no field recording how many
introducer lookups failed**, so a degraded run is byte-indistinguishable from a complete one — the disease
#42 named, in another command.

### 2.4sexies Batch 2, and the floor test reaches thirteen cases

Ten more candidates, adjudicated against the RE-MINED corpus (post `c6a4d6e`) and with two changes to the
method that batch 1 paid for:

1. **The size gate is applied mechanically, before an agent is spent.** Batch 1 burned a full adjudication
   on 1458 only to find its introducer was 65,725 lines against a 1500-line gate. One `gh` call per
   introducer now settles that for free.
2. **The adjudicators are given the TECHNIQUE for the dominant failure mode, not just a warning about it.**
   Batch 1 was told "blame names the last toucher" and five of six rejections were still that. Batch 2's
   prompt opens with the concrete checks: does the construct already exist at `<mergeSha>^1`; does the hunk
   vanish under `git diff -w` (and the caveat that a one-line-to-three-line reflow survives `-w`); is the PR
   a port or rename; is the fix's edit at this site collateral hardening.

**Result: 5 usable of 10, against batch 1's 3 of 10.** Ten cases is far too few to call that difference
real, and it is recorded as an observation rather than an effect.

| fix ← introducer | verdict | site (in the INTRODUCER's coordinates) |
|---|---|---|
| 1434 ← 767 | **usable** | `packages/web/src/Context/AudioPlayerContext.tsx:278` — a preload fast-path promotes a cached `<audio>` element to the live player on `readyState >= 2`, but the element was cached fire-and-forget with no `error` listener; a partially decoded buffer is reused verbatim and plays as sustained static. The same hunk's fresh-load branch defends with a timeout, an error listener and a `loadedmetadata` wait — the asymmetry is entirely inside the diff. |
| 1124 ← 965 | **usable** | `.../Cloudflare/CludflareDriver.ts:338` — `ResponseContentDisposition: "attachment"` with no `filename=`, while the same hunk shows the object key is a UUID. Every downloaded file landed named after its UUID. Verified: 0 occurrences of the construct before #965, 4 within it. |
| 1394 ← 1179 | **usable** | `lambda/song-waveform/src/index.ts:145` — the `downsampleAudio(...)` normalisation is deleted while `PercivalBpmEstimator(..., 16000)` and `KeyExtractor(..., 16000, ...)` keep hardcoding the rate. Both halves are in the one diff. BPM and key were systematically wrong: 2 of 18 keys correct. |
| 1215 ← 1141 | **usable** | `.../Controllers/PublicProject.ts:216` — `const totalSeconds = project.totalDuration;` then `/3600`, where `totalDuration` carries MILLISECONDS (a convention that predates the PR: `formatTrackCardDuration = (timeInMs) => timeInMs / 1000`). A 1000× error: a 10-minute project advertised `166h 40m` in every shared link preview. The contradiction is the variable name fighting the field name, inside the added hunk. |
| 1376 ← 1248 | **usable** | `.../Tigris/TigrisDriver.ts:922` — `Range: "bytes=0-15"` feeding `fileType.fromBuffer(buf)` on adjacent ADDED lines. Sixteen bytes is below what `file-type@16.5.4` needs; its OGG branch throws on anything under 36, so every `.ogg`/`.opus` upload failed to complete. The fix widens exactly that line to `bytes=0-65535`. |
| 1536 ← 806 | rejected | #806's whole contribution to that file is one added line; the defect could not exist until an overlay added five months later |
| 1264 ← 1256 | rejected | the true author is **#1254, merged 29 minutes earlier** — verified: 15:17:43 vs 15:46:36 |
| 1045 ← 701 | rejected | the blamed line is `PRIVACY_POLICY_URL`, pulled in by a constants-move refactor riding along inside the FIX PR |
| 1109 ← 891 | rejected | **criterion 4** — real defect, correct attribution, but the consuming effect lives in a file the diff never touches |
| 1429 ← 1003 | rejected | the flawed predicate is pure context in #1003's diff; #1003 only added the cover-edit feature beside it |

**A third corpus defect, and this one would have made the benchmark unanswerable.** All five usable cases
needed their site corrected, because **the artifact reports the defect site in the FIX's coordinates, not
the INTRODUCER's** — the field is even labelled `replay range (defect site)`. Four are line drift (346→338,
146→145, 237→216, 982→922), tolerable inside `compare.ts`'s ±25 window. The fifth is categorical: the corpus
gives 1434's site as `packages/web/src/store/AudioPlayerStore.ts:209`, and **that file did not exist when
#767 merged** — it was created later by a Context→Store move, which is also why blame named the mover.
A benchmark replaying #767 against that path could never match, with any reviewer. Verified directly:
`git show <#767 head>:packages/web/src/store/AudioPlayerStore.ts` does not resolve.

**One limit no flag can fix, recorded so it is not chased.** 1264's true author merged 29 minutes before the
PR blame named. There was no reformat and no move — two real authors touched the same line in succession.
`-w -M -C` is irrelevant here; only reading the line's history separates them, which is what an adjudicator
does and a heuristic cannot.

**The floor test now has THIRTEEN cases over TWELVE PRs**, which is inside the 12–15 target §3.11 set when
corpus growth was promoted to the main path:

- **5** adjudicated `greptile_only` misses (§2.3) over PRs 1717, 1719, 1722, 1724 — 1724 carries two.
- **8** corpus cases over introducer PRs 1471, 853, 1307 (batch 1) and 767, 965, 1179, 1141, 1248 (batch 2).

At R=2 over 12 known-bad PRs plus 2 clean ones, both arms, M6 is **56 runs ≈ $224** — against the ~$96 a
five-case floor would have cost, and buying an instrument that can actually distinguish *adopt* from
*opt-in* rather than only shouting *drop*.

**Conversion, stated for whoever needs more cases later:** 20 candidates adjudicated, 8 usable — **40%**.
The funnel from the re-mined corpus is 507 fix-shaped → 424 `blame-linked` → 175 past the quality filter →
**66 whose introducer the engine will actually review**. At 40%, those 66 hold roughly 26 more cases, and
every one costs an adjudication.

### 2.4septies THE FLOOR TEST CASE LIST — canonical, and the only one M6 reads

Everything above is how these were found and why the rejected ones were rejected. This is the list itself.
**Every line number here is in the coordinates of the PR THAT GETS REVIEWED**, verified by the orchestrator
against that PR's own tree — not copied from the corpus artifact, for the reason in the note below.

The two case types differ in what gets reviewed, and M6 must not blur them:

- **Miss cases** — the PR under review IS the PR where our engine missed something Greptile found (§2.3).
- **Corpus cases** — the PR under review is the INTRODUCER, and the fix PR is only provenance.

| # | PR to review | site | type | what a reviewer must flag |
|---|---|---|---|---|
| 1 | **1717** | `packages/app/components/PaywallUpgrade/index.tsx:119` | miss | ordering bug, visible in the diff |
| 2 | **1719** | `packages/backend/src/Infrastructure/Http/SongSourceResolver.ts:296` | miss | missing lower bound |
| 3 | **1722** | `packages/backend/src/Utils/m4aRemux.ts:181` | miss | whole-file check swapped for an mdat one; author-confirmed regression |
| 4 | **1724** | `docs/runbooks/mus-638-song-bucket-rollout.md:144` | miss | shell under `set -u` in a markdown runbook |
| 5 | **1724** | `docs/runbooks/mus-638-song-bucket-rollout.md:140-142` | miss | unbounded poll in the same runbook |
| 6 | **1471** | `.github/workflows/build-check.yml:39` | corpus (fix 1557) | `bunx biome` unscoped — the gate checks nothing and exits 0 |
| 7 | **853** | `packages/app/hooks/useChangeCover.tsx:120` | corpus (fix 1641) | `const` in the `try`, dereferenced in the `catch` |
| 8 | **1307** | `packages/web/src/store/FileUploaderStore.ts:405` | corpus (fix 1413) | refreshes by the track's id, overwriting `selectedProject` |
| 9 | **767** | `packages/web/src/Context/AudioPlayerContext.tsx:278` | corpus (fix 1434) | preload fast-path trusts an unverified cached element |
| 10 | **965** | `packages/backend/src/Infrastructure/Cloudflare/CludflareDriver.ts:338` | corpus (fix 1124) | `attachment` with no `filename=`, beside a UUID key |
| 11 | **1179** | `lambda/song-waveform/src/index.ts:145` | corpus (fix 1394) | sample-rate normalisation deleted, `16000` left hardcoded |
| 12 | **1141** | `packages/backend/src/Infrastructure/Http/Controllers/PublicProject.ts:216` | corpus (fix 1215) | ms assigned to `totalSeconds`, then `/3600` |
| 13 | **1248** | `packages/backend/src/Infrastructure/Tigris/TigrisDriver.ts:922` | corpus (fix 1376) | `Range: "bytes=0-15"` feeding a magic-byte sniffer |

**13 cases over 12 PRs.** Case 4 and 5 share PR 1724, as cases 1–5 always did.

> **Cases 1-5's paths were REPO-RELATIVE-ised 2026-08-18, and it is the same defect this section exists
> to prevent.** They were carried over from §2.3 in their short display form —
> `PaywallUpgrade/index.tsx`, `m4aRemux.ts` — which reads fine to a human and matches NOTHING mechanically:
> `compare.ts`'s `normalizePath` is deliberately minimal (trim, drop one `./`) and explicitly refuses
> basename matching, because this monorepo has duplicate filenames across `packages/`. A scorer fed the
> short form would have scored all five miss cases as misses by BOTH arms — the exact failure the eight-row
> drift table below records for the corpus cases, arriving through a different door. The full paths were
> read from the frozen control set's own `comparison.json` rows (s1 `pr-1717-052f77cb-1`, s2
> `pr-1719-43f5098f-1`, s3 `pr-1722-24a27ba8-1`, s3 `pr-1724-bda807b3-1`), whose `start_line` values agree
> with this table's line numbers on every one of the five.
>
> **The machine-readable copy is `docs/m6-floor-cases.json`**, and `test/floor-test.test.ts` re-derives
> this table from this markdown and fails if the two disagree. The table above stays the canonical
> statement; the JSON is what the scorer reads, and neither may drift from the other in silence.

**Why this table exists rather than a pointer at the corpus artifact — corrected 2026-08-17, and worse than
§2.4sexies first stated.** That section said four of five batch-2 drifts were tolerable and one was
categorical. Measuring all EIGHT corpus cases against `compare.ts`'s ±25 window says otherwise:

| case | corpus said | truth | drift | would ±25 have matched? |
|---|---|---|---|---|
| 1557 | 143 | **39** | 104 | **no** |
| 1376 | 982 | **922** | 60 | **no** |
| 1434 | `store/AudioPlayerStore.ts:209` | `Context/AudioPlayerContext.tsx:278` | — | **no — the path did not exist yet** |
| 1215 | 237 | 216 | 21 | yes, barely |
| 1641 | 135 | 120 | 15 | yes |
| 1124 | 346 | 338 | 8 | yes |
| 1394 | 146 | 145 | 1 | yes |
| 1413 | 405 | 405 | 0 | yes |

**Three of eight would have failed to match, with any reviewer.** The drift is not noise around the true
site — it is the distance a file grew between the introducer and the fix, which is unbounded and grows with
the gap between them. A ±25 window cannot absorb it, and the two worst cases here are 60 and 104 lines. Had
M6 run against the corpus artifact's own coordinates, it would have scored three of its eight corpus cases
as misses by both arms and read that as evidence about the scout.

The command is not fixed here; the defect is filed. This table is what M6 reads until it is.

### 2.4 The restraint set for M4 — NOT yet established

M4's second assertion needs PRs that are genuinely clean, so a loud scout can be caught. The candidates by
bucket shape (`greptile_only` 0 and `both` 0) are PRs **1698, 1703, 1708, 1715, 1720, 1721**. But **that is
a bucket shape, not a triage**: several of them carry untriaged `prhero_only` rows, and a PR with a real
pr-hero-only defect is not clean. Triaging `prhero_only` rows was explicitly out of M0's scope. M3 must
either define restraint against a criterion these rows can satisfy as-is, or budget the triage.

### 2.5 How the verdicts were written, and by whom

`pr-hero triage` **cannot** reach these rows: `applyTriageReplies` binds only rows whose `prhero` side is
non-null (`src/triage-write.ts:78-83`) and resolves the parent from a posted `<!-- pr-hero-finding`
marker. A `greptile_only` row has `prhero: null` and no thread of its own. So the verdicts were written
directly into each `comparison.json`, which is also how PRs 1700 and 1705 were triaged before this
milestone. Building a `pr-hero triage row` write path is a candidate M7 fill-in, not a blocker.

Each verdict was adjudicated by an isolated agent reading the repository at that exact head (never the
claim's prose), and the rows carry **`actor: "agent"`** — the reasoning text is agent-authored, and
labelling it `human` would destroy the one distinction the field exists to make. Juanma's ratification is
recorded in this file and its commit, not by relabelling authorship. Any row he overrides becomes
`actor: "human"` at that point.

### 2.6 Two defects this milestone surfaced in our own tooling

Neither is fixed here; both are recorded so they are not rediscovered.

1. **Writing a `comparison.json` can silently change which run votes.** `aggregateLedger` orders runs by
   `generated_at`, falling back to file mtime for artifacts written before that stamp existed
   (`src/ledger.ts:37-40`). Writing a verdict bumps mtime, so triaging an *older* run can promote it over
   the newer one and flip the ledger's per-PR totals. Observed live during M0: writing s3's verdicts moved
   the totals from `8/10/18` over 36 rows to `9/9/19` over 37, because `pr-1682-e3ab386a-1` — the only
   file on disk with no `generated_at` — jumped ahead of `pr-1682-e3ab386a-2`. Original mtimes were
   restored and the totals returned. `pr-hero triage` writes through the same path (`src/cli.ts:2149`) and
   has the same exposure.
2. **`pipeline.json` records no provenance.** Its keys are `pr`, `base_sha`, `head_sha`, `out_path`,
   `excluded_paths`, `parity_hunter_fired`, `steps` — no engine version, no prompt-set identity, no
   fingerprint. The corpus above is *believed* to be one configuration because every step says
   `model: sonnet` and the production set is immutable, not because any artifact says so. **M3 item 7
   (scout provenance) is therefore not an addition to an existing provenance record — it has to build
   one**, or M6 cannot attribute a finding to "led" versus "found unled".

---

## 3. The design (M3) — WRITTEN, awaiting ratification

The M3 session was started and stopped early by Juanma, on the correct observation that **the DoorDash
track does not have to be finished for the main roadmap to continue** — only `ROADMAP.md` item 7 gates on
it, and the rest of Phase C does not. §3.1 and §3.2 are what that first session established; the design
proper was written in the session that followed.

> **Header corrected 2026-08-17.** This section used to read "PARTIAL, stopped deliberately" and to state
> that "the scout design proper — C7's four open questions, and M3 items 1 through 5 and 7 — is NOT
> written". That was true when it was written and was falsified the next day by §3.3–§3.14, which answer
> all four C7 questions and items 1–5 and 7. The clause it does NOT retract: **do not treat this section
> as a ratified design.** §3.14 still reads `Ratified: _pending_`, and nothing in M4–M6 may start before
> that line changes.

### 3.1 M3 item 6, the metric — this part IS answered, and the answer is uncomfortable

**Run-to-run variance, measured over the eight same-head replicate pairs in §1.3, counted in pr-hero
findings per run rather than in buckets:**

| measure | value |
|---|---|
| findings per run, mean | **1.87** |
| findings per run, standard deviation | **1.36** |
| mean absolute delta between same-head replicates | **1.38** |
| max delta | **5** — PR 1724 produced 5 findings in one run and **0** in the other, at the same commit |

**The noise is 74% of the signal.** Any scout effect smaller than roughly 1.4 findings per PR is
indistinguishable from re-running the engine unchanged.

**What that costs, paired by PR, at ~80% power and α=.05 (δ ≈ 2.8 × SE, SE = σ√(2/NR)):**

| N PRs | R replicates | runs total | detectable δ | as % of the 1.87 mean | ~cost at $4/run |
|---|---|---|---|---|---|
| 8 | 2 | 32 | 1.35 | **72%** | ~$128 |
| 8 | 3 | 48 | 1.10 | 59% | ~$192 |
| 15 | 2 | 60 | 0.98 | 53% | ~$240 |
| 15 | 3 | 90 | 0.80 | 43% | ~$360 |
| 19 | 3 | 114 | 0.71 | 38% | ~$456 |

So the roadmap's provisional `N=8, R=2` can detect **only a ~+72% effect** — that is, only if this scout
reproduces DoorDash's own +75% weighted-recall result almost exactly. **If the real effect here is +30%,
this corpus cannot see it at any affordable N.** That is the honest read, and it must be stated in the
forecast before any arm runs, not discovered afterwards.

**The metric shape that follows, two tiers, because one of them needs no statistics at all:**

1. **Floor test — deterministic, cheap, interpretable.** Eight known defects with known sites already
   exist: the 5 adjudicated `true-positive` misses (§2.3) and the 3 usable revert cases (§2.4bis). Does
   the scout arm catch what the control arm misses, case by case? Binary per case, no power calculation,
   and it fails loudly rather than ambiguously.
2. **Effect test — statistical, expensive, and honestly underpowered.** Paired per-PR count of
   **refuter-corroborated** findings (not raw volume — C1's lesson), with the refuted/downgraded rate as
   the precision guard. Sized from the table above with the detectable effect declared up front.

Counting corroborated findings rather than raw ones is safe here for a measured reason: precision is
already high and stable — 53/53 postable (§2.2 of the M2 write-up in #19) and 35 of 36 musive 🔴 findings
`corroborated` by the refuter. The refuter is doing its job, so surviving it is a usable proxy for "real".

**The caveat that does not go away:** neither tier sees what BOTH arms missed. That is C10's blind spot,
and no metric in this section closes it.

### 3.2 Engine facts the design must obey — mapped 2026-08-16, not yet turned into decisions

Recorded because they were read out of the real code and they constrain M3 items 1–5 and 7 hard:

- **`role` is `"hunter" | "refuter"` and nothing else** (`src/spec.ts:18-31`), hunter keys are sealed to
  the schema enum, and `agentsDirProblems` is **bidirectional** — a prompt file in the agents dir that no
  spec entry names is a hard `CliError`. A scout therefore cannot simply be dropped into a prompt set.
  **The precedent to copy is the summarizer**, which sits deliberately OUTSIDE `ReviewSpec` as an
  engine-owned stage (`src/pipeline.ts:85-87`). Keeping the scout there is also what keeps the prompt-set
  fingerprint untouched, which is what makes M6 one-variable.
  > **Refined 2026-08-16 (verification pass):** the bidirectional check is real (`agentsDirProblems`,
  > `src/preflight.ts:1181-1204`, thrown as a `CliError` by `preflightAgentsDir`, `src/cli.ts:2685-2702`,
  > wired on both the local and PR paths) but it only sees files matching `AGENT_FILE_PATTERNS =
  > ["deep-review-*.md", "review-*.md"]` (`src/preflight.ts:1173`). So the trap is narrower and sharper
  > than stated: a scout file named `review-scout.md` inside the agents dir is a hard failure, while the
  > summarizer's own home — `<repo>/prompts/summarizer.md`, outside the agents dir entirely
  > (`src/cli.ts:205-210`) — is invisible to it by construction. §3.7 takes that seat.
- **The delivery channel for leads is the USER prompt, not a new `{{LEADS}}` anchor.** `hunterPrompt`
  (`src/pipeline.ts:277-290`) already assembles engine-owned text beside `HUNTER_OUTPUT_CONTRACT`, whose
  own comment says it is *"driver source: covered by the engine version, NOT by the prompt-set
  fingerprint"* (`pipeline.ts:246-247`). A `{{LEADS}}` anchor would instead require editing every agent
  file — a prompt-set change that kills the one-variable property — and templating has **no unknown-token
  check**: an unresolved `{{...}}` ships verbatim into the model with no error, no warning and no test.
- **A pre-hunter stage attaches between `pipeline.ts:427` and `pipeline.ts:443`**, after the diff and
  changed paths are known and strictly before the loop that composes hunter prompt bytes. There is no
  existing sequential pre-hunter precedent — the summarizer runs *concurrently* and feeds nothing.
- **"Diff-only, no tools" is only partly expressible today.** `tools: []` emits `--tools ""`, which **no
  test covers**; `mcpConfigPath` is required and `--mcp-config` is emitted unconditionally; and `cwd` is
  always the worktree, so "no repo access" is enforced by the tool allow-list, never by a sandbox.
- **Provenance is worse than assumed and cheaper to fix than assumed.** `pipeline.json` records no engine
  version, no prompt-set identity, not even a timestamp. But `findings.ts` already **declares**
  `prompt_set?: {name, sha256}` and `driver_sha?` and no CLI path ever populates them — the schema seat
  exists, unused.
  > **Corrected 2026-08-16 while writing §3.3–§3.14**, after re-reading the code rather than this bullet:
  > the *findings* artifact is not provenance-free. Both `writeFindings` call sites pass
  > `engine: await engineIdentity()` (`src/cli.ts:707-717`, `:1211-1221`), so engine identity IS recorded
  > there; what is missing from `findings.json` is only `prompt_set` and `driver_sha`. The claim holds
  > exactly and only for `pipeline.json`, which records none of the three.
- **Two wiring hazards for any new stage:** a stage that omits `sumUsage(state.usageTotal, …)` is
  invisible in the run's cost total; and `estimateCost(diffStat, hunterCount, summarizerEnabled)`
  (`report.ts:75-102`) counts hunters and a summarizer boolean only, so a scout needs its own explicit
  parameter, copying the summarizer's precedent.
- **DashBench constrains the model choice:** the cheap scout won — Kimi scouting for Fable beat Sonnet
  scouting for Opus on every quality axis at lower cost. Scout tier and hunter tier are independent knobs.

### 3.3 The scout in one paragraph

**A single diff-only step that runs before the hunter fan-out, reads the patch and nothing else, and emits
a capped list of unverified suspicions — `{path, line, why}` — which are appended to every hunter's user
prompt as a "look here first" block. It has no repository access, no MCP, no tools, no priors and no
gotchas. It produces no findings, and there is no code path from a lead to the findings array. If it fails,
the run continues unled.** Everything below is the argument for each of those words, against the code in
§3.2 and the numbers in §1–§2.

### 3.4 C7 Q1 / M3 item 1 — leads BIAS the hunters' scan, they never replace it

**Decision: bias.** The hunter's own mandate is unchanged by one byte; the leads arrive as additional
input, explicitly labelled unverified, and the prompt says in as many words that the absence of a lead is
not evidence of absence.

The argument is not the roadmap's a-priori one ("replacing makes one stage a single point of failure").
That is true but it is taste. The measured argument is §1.3: **recall on a single run is already unstable —
mean absolute delta 1.38 findings between same-head replicates, max delta 5, and at `1724@bda807b3` one run
found five things the other did not.** A replace-topology makes total recall the product of two unstable
stages instead of the union of four semi-independent ones. We would be multiplying the noise we just
measured, in the direction of the invisible-miss failure mode this project ranks worst.

**The corollary, and it is the load-bearing half of this decision: we take DoorDash's leads half and
explicitly DO NOT take their filter half.** Their own framing calls filtering the less obvious job — *"what
it filters out: the parts of the change that don't need scrutiny"* — and for them it is where the cost
saving lives. Here it is refused in v1 for two reasons, both of which are ours and not theirs:

1. A filter converts a scout miss from "a hunter had to find it unaided" into "no hunter ever looked". That
   is an invisible miss created by construction, and §1.3 says the scout will miss things.
2. It cannot be measured with the instruments we have. C10's blind spot means neither arm can see what both
   missed; a filter's whole cost lands in exactly that blind spot.

A filtering arm is therefore a **separate, later experiment** with its own control, not a knob inside M6.
Recorded in §3.13.

### 3.5 C7 Q2 / M3 item 2 — what structurally stops the scout from becoming DoorDash's v2

Their v2 failed because one agent read the whole diff, applied every rule, traced callers, checked siblings
and verified every concern in one session — *"attention spread thin"*. The answer here is not a prompt that
asks the scout to be brief. It is that **the scout is not capable of verification**, enforced by four
mechanisms, three of them in code:

| # | Mechanism | Enforced by |
|---|---|---|
| 1 | No repository access — it cannot open a file, grep, or walk a call graph | `tools: []` and no codegraph MCP tool in the allow-list (`step-runner.ts:193-194`, `:174-176`) |
| 2 | No hop budget, no `hops_used`, no `hop_trail` — the vocabulary of investigation is absent from its contract | its own output contract (§3.7) |
| 3 | Its output type is not `DraftFinding` and never reaches `state.drafts`, dedupe, the refuter or `SkillOutput.findings` | the pipeline wiring (§3.9); a lead has no `severity`, no `evidence_class`, no `proof_refs`, no `dedupe_key` |
| 4 | One attempt, a 5-minute watchdog and a hard lead cap | its `StepSpec` (§3.8), copying the summarizer's non-hunter budgets (`pipeline.ts:525-526`) |

The honest caveat, straight from §3.2 and re-verified: **`cwd` is still the worktree and `--mcp-config` is
still emitted unconditionally**, so "no repo access" is enforced by the tool allow-list, never by a sandbox.
`tools: []` emitting `--tools ""` is real (`step-runner.ts:193-194`, no empty-array branch) and **no test
covers it** — the only `tools: []` in the repo today is the summarizer's `StepMeta` placeholder, overwritten
before any spawn. That is an M5 test obligation, listed in §3.12, and it is the single mechanism this whole
section rests on.

### 3.6 C7 Q3 / M3 item 3 — direction of error: recall-first scout, precision-first everything else

**The scout is prompted for recall within its cap; hunters and the refuter are untouched and stay
precision-first.** A spurious lead costs one hunter some attention on a diff it was going to read anyway; a
missed lead costs nothing that the unled pipeline would not also have cost. The asymmetry is not symmetric,
and DashBench's own line — *scouts improve breadth when the reviewer can verify aggressively* — describes
this engine, whose refuter corroborated 35 of 36 musive 🔴 findings (§3.1).

**The fail-open rule, which follows from the same asymmetry:** if the scout step fails, times out, or
returns unparseable output, **the hunters run unled and `run_status` stays `complete`.** This does not
contradict #42. #42 is about a review that lost a hunter or the refuter — a genuinely incomplete review. A
run without a scout is the *control pipeline*, which is by definition complete; it cannot have lost a
finding it was never going to produce. But it must never be silent:

- `pipeline.json` carries `scout.status: "failed"` (§3.9), and the run log emits a `scout-finished` event
  with `ok: false`.
- **M6 protocol rule:** a scout-arm run whose scout failed is EXCLUDED from the scout arm and re-run.
  Counting it would silently dilute the arm with control-arm runs — the exact way an A/B lies quietly.

### 3.7 M3 item 4 — where the scout prompt lives: `prompts/scout.md`, engine-owned

**Decision: `<repo>/prompts/scout.md`, bundled with the engine, passed in as `input.scout.promptPath`.
Byte-identical to the summarizer's arrangement (`src/cli.ts:205-210`, `pipeline.ts:85-87`, "deliberately
outside ReviewSpec"). The prompt set is not touched, not forked, and not re-fingerprinted.**

Why not a new prompt-set directory with byte-identical hunter files, the roadmap's other option: because a
new set is a new fingerprint, and rule 5 plus M6's one-variable requirement then have to be argued rather
than being true by construction. Engine-owned text is *"covered by the engine version, NOT by the
prompt-set fingerprint"* — the comment the engine already carries over `HUNTER_OUTPUT_CONTRACT`
(`pipeline.ts:245-247`). The scout is that kind of text.

Why not the agents dir: `ReviewSpec.role` is `"hunter" | "refuter"` with a runtime guard
(`spec.ts:24`, `:82-85`), so a scout cannot be a spec entry without widening the union — and a
`review-scout.md` dropped in the agents dir without a spec entry is a hard `CliError`
(`preflight.ts:1181-1204`). Both doors are closed on purpose. `prompts/` is open, and the summarizer walked
through it first.

**The scout's output contract is engine source too**, beside the other three
(`SCOUT_OUTPUT_CONTRACT`, next to `HUNTER_OUTPUT_CONTRACT` in `pipeline.ts`):

```
{"leads":[{"path":"...","line":123,"why":"one sentence"}]}
```

No severity, no evidence class, no proof refs, no hop trail. `{"leads":[]}` is a valid, expected result —
the same sentence the hunter contract already carries, for the same reason.

**Model: independent knob, defaulting to the run's model.** `--scout-model` exists from day one (the
summarizer's precedent, `pipeline.ts:507-512`) and DashBench says the cheap scout won. But it is **not
exercised in M6**: the whole control corpus is `model: sonnet` (§1.2), so the scout runs sonnet in the A/B
and the cheap-scout question becomes its own later experiment. Ratifying `--scout-model` is ratifying a
flag, not a second variable. The bundled `prompts/summarizer.md` frontmatter (`model: haiku`) shows the
seat works.

### 3.8 M3 item 5 — how leads reach the hunters, and the ceiling

**Delivery: appended to the hunter USER prompt, inside `hunterPrompt()`. Not `{{PRIORS}}`, not a new
`{{LEADS}}` anchor.** A `{{LEADS}}` anchor would require editing every agent file — a prompt-set change
that kills the one-variable property — and templating has no unknown-token check (`prompt-set.ts:78-88`,
two `replaceAll`s and nothing else), so a set whose files lack the anchor would ship `{{LEADS}}` verbatim
to the model with no error, no warning and no test. That failure is silent, which is the only kind this
project treats as unacceptable.

New signature: `hunterPrompt(patch, hopBudget, leads?)`. Block order, extending the verified order at
`pipeline.ts:277-290`: `patch` → hop budget → the self-reported-hops line → **the leads block** → 
`HUNTER_OUTPUT_CONTRACT`. Leads sit last before the contract so the diff is still what the hunter reads
first.

**The block, verbatim shape:**

```
Scout leads — UNVERIFIED suspicions from a diff-only pass that read no
code. They are not findings, they carry no evidence, and confirming one
still requires your own proof_refs. Their absence is not evidence of
absence: your own scan of the whole diff is unchanged.

- path:line — why
```

That paragraph is the anti-anchoring guard, and it is what keeps §3.4's "bias" from decaying into
"replace" in practice.

**Ceiling — hard, enforced by the driver, never by the prompt alone:**

| limit | value | why |
|---|---|---|
| leads per run | **12** | above this it is a filter of nothing; §3.10's restraint gate bites first |
| chars per `why` | **240** | one sentence; a paragraph is a finding in disguise |
| total block | **3000 chars** | bounded prompt growth per hunter, ×4 hunters |
| leads per path | **3** | stops one interesting file absorbing the whole budget |

Over-cap leads are truncated deterministically (input order, no re-ranking) and the drop is recorded as
`leads_truncated: n` in `pipeline.json`. A truncation that fires routinely is a prompt defect to fix in M4,
not a cap to raise.

**Every hunter gets the identical block.** Per-hunter filtering would require the scout to know the hunter
taxonomy, which drags it toward specialisation — the v1 topology C7 exists to correct — and it adds a
second variable to M6. Recorded as a lever in §3.13.

**No priors, no gotchas, no PR title or body.** Feeding the scout the same `{{PRIORS}}`/`{{GOTCHAS}}` the
hunters read would correlate its attention with theirs, and the independence of its pass is the entire
reason it can add coverage. "Diff-only" is meant literally.

### 3.9 M3 item 7 — provenance, and how a finding is traced to "led" or "unled"

**Attribution is computed, never self-reported.** The engine already distrusts self-reported hop counts in
its own prompt text (*"`hops_used` and `hop_trail` are self-reported and may be cross-checked against this
run's telemetry"*); asking a hunter to declare "I found this because of lead 3" repeats the mistake that
line was written to warn about, and it cannot be audited.

**The rule, applied at analysis time from the two artifacts:** a finding is `led` when some lead shares its
`path` and `|lead.line − finding.line| ≤ 25`; otherwise `unled`. The ±25 window is `compare.ts`'s existing
precedent, reused so the head-to-head and the attribution agree on what "the same place" means. It is
deliberately a proximity heuristic and will over-count — a lead and an independent finding in the same
function count as `led`. That biases *against* the scout looking useless, so it must be reported with the
window stated, and M6 reads the floor test (§3.11) as primary precisely because the floor test needs no
attribution at all.

**Nothing on the finding changes. No schema bump. Rule 5 untouched.**

**Artifacts:**

- `steps/scout.leads.json` — the raw validated leads, beside every other step's output.
- `pipeline.json` gains one key: `scout: {enabled, model, status, leads_count, leads_truncated,
  prompt_sha256, duration_ms}`. Additive; `watch-preflight.ts:553-577` is the only reader and reads named
  keys.
- **And, while `pipeline.json` is open, the three fields §3.2 found missing:** `engine`, `prompt_set:
  {name, sha256}`, `generated_at`. This is not scope creep — without a prompt-set identity in the artifact,
  M6's central claim ("both arms ran the same prompt set") is believed rather than recorded, and §2.6
  already shows what an artifact with no `generated_at` does to the ledger. `findings.ts` declares
  `prompt_set` and `driver_sha` and populates neither, so the same computation fills both seats.
- **Usage:** the scout stage MUST call `sumUsage(state.usageTotal, result.usage)` and write a `per_agent`
  row keyed `scout` — the summarizer's exact pattern (`pipeline.ts:571`), and the omission §3.2 names as a
  wiring hazard. `test/pipeline.test.ts:532` is the test to copy.
- **Cost band:** `estimateCost(diffStat, hunterCount, summarizerEnabled, scoutEnabled = false)`. Verified
  shape: `agents = max(1, hunterCount + (summarizerEnabled ? 1 : 0))` (`report.ts:75-101`), so the scout
  needs its own term or the pre-run band under-quotes every scout run. Three call sites
  (`cli.ts:576`, `:874-878`, `:1059`).

**Where the stage attaches:** `pipeline.ts` lines **436–442** — after `patch` and `changedPaths` exist and
after trigger evaluation, strictly before the hunter composition loop at `:443`. It is `await`ed, unlike
the summarizer, which is the first sequential pre-hunter stage in the engine. That has a cost this design
does not hide: **the scout is on the critical path and adds its full latency to every run.** DoorDash paid
~4× wall clock for staging; our scout is diff-only and one attempt, so the expected add is one short step,
and M6 records latency per arm as a first-class number (§3.11).

### 3.10 M3 item 6a — the M4 scout-probe protocol, in numbers

Same discipline as `refuter-probe`: the prompt earns its A/B offline before anything expensive runs.
`scripts/scout-probe.ts`, **3 replicates**, diff-only spawns.

**Assertion 1 — coverage.** Targets: the five adjudicated `true-positive` misses (§2.3), over four distinct
PRs. A hit = a lead whose `path` matches and whose `line` is within ±25 of the site.

| PR | site | note |
|---|---|---|
| 1717 | `PaywallUpgrade/index.tsx:119` | ordering bug, visible in the diff |
| 1719 | `SongSourceResolver.ts:296` | missing lower bound — the hardest of the five for a diff-only pass |
| 1722 | `m4aRemux.ts:181` | the diff itself swaps a whole-file check for an mdat one; author-confirmed regression |
| 1724 | `mus-638-song-bucket-rollout.md:144` | markdown runbook, shell under `set -u` |
| 1724 | `mus-638-song-bucket-rollout.md:140-142` | markdown runbook, unbounded poll |

**Gate: each of the five cases hit in at least 2 of 3 replicates.**

**The exclusion rule, because a gate with no escape hatch gets quietly lowered instead:** if a case is hit
0 of 3 across two separate prompt iterations, it may be reclassified as *not diff-visible* and moved out of
the gate — with the reason written in this file. **At most one case may be excluded. A second exclusion is
not a threshold problem, it is evidence that diff-only is the wrong call, and the design returns to Juanma
before M5.** Two of the five live in a markdown runbook, so a scout prompt that implicitly assumes
TypeScript fails 40% of this list; that is a prompt defect to fix in M4, never an exclusion.

**Assertion 2 — restraint. §2.4's gap is closed by re-defining what restraint measures, not by paying for a
triage.** The six bucket-clean candidates (1698, 1703, 1708, 1715, 1720, 1721) carry untriaged
`prhero_only` rows, so "this PR is clean" is not a claim we own. But the failure mode DashBench names is
not "flagged a clean PR" — it is *filtering nothing*, being loud everywhere. That is measurable without
knowing the defect count:

- **`lead_coverage` = fraction of the diff's changed hunks carrying ≥1 lead.** Gate: **mean ≤ 33% over the
  six PRs × 3 replicates, and no single run above 50%.**
- **Mean leads per PR ≤ 6** over the same set (the hard cap of 12 is the engine's floor, not the gate).

Stated as what it is: a proxy. It measures selectivity, which is a property of the scout, instead of
cleanliness, which is a property of a PR we have not triaged.

**Prerequisite, $0, done in M4's session:** extract the defect site from each of the three usable revert
cases (PRs 1160, 1276, 819 — §2.4bis) out of the revert diff, so M6's floor test has eight cases with
sites rather than five. `pr-hero reverts` gives the pairs; the sites are a read of what the revert undid.

> **DONE 2026-08-17, and it returned a negative result.** There are no three usable revert cases: 1276 and
> 819 were re-landed byte-identically and 1160 is unconfirmed (§2.4bis). **The floor test therefore starts
> at five cases over four PRs, not eight over seven**, and this prerequisite is closed rather than
> pending. The prerequisite did its job — it was $0, it ran before the money, and it caught a false
> premise inside a design that had already been ratified. That is the pattern working, not failing.
>
> M4's own gates are UNAFFECTED: assertion 1 targets the five adjudicated misses, which are untouched, and
> assertion 2's restraint set is untouched. What moved is M6's input, and it is handled in §3.11.

**Exit:** the gates pass at 3 replicates, and the numbers — including every excluded case and its reason —
land in the commit description.

### 3.10bis M4 RAN — coverage passes, restraint fails, and the restraint metric is the thing that broke

Executed 2026-08-17/18. **Coverage PASSES at the ratified threshold. Restraint FAILS two of its three
sub-gates.** M4's exit condition is therefore NOT met, and this section does not declare it met. What
follows is the measurement, the diagnosis, and an amendment offered for ratification — the thresholds
above are untouched.

**Final run: `prompts/scout.md` sha256 `68a81d26081e`, sonnet, R=3, 15-minute watchdog, all ten PRs in one
pass, 30 spawns, ZERO failed runs, 90 minutes, $10.47.** One artifact, one prompt sha, both assertions on
the same text and the same day: `.prhero/scout-probe/2026-08-18T08-01-49-028Z/scout-probe.json`.

| assertion 1 — coverage | hits | gate |
|---|---|---|
| 1717 `PaywallUpgrade/index.tsx:119` | 3/3 | PASS |
| 1719 `SongSourceResolver.ts:296` | 2/3 | PASS |
| 1722 `m4aRemux.ts:181` | 3/3 | PASS |
| 1724 `mus-638-song-bucket-rollout.md:144` | 3/3 | PASS |
| 1724 `mus-638-song-bucket-rollout.md:140` | 3/3 | PASS |

**Zero exclusions used; §3.10's exclusion-rule counter stays at zero.** The hits are semantic rather than
positional — every 1719 hit names the missing lower bound, the future `verifiedAt` and the negative-age
consequence in its own words.

| assertion 2 — restraint | measured | gate | |
|---|---|---|---|
| mean `lead_coverage` | **0.339** | ≤ 0.33 | FAIL |
| max single-run `lead_coverage` | **1.000** | ≤ 0.50 | FAIL |
| mean leads per PR | **3.83** | ≤ 6 | PASS |

**The diagnosis: `lead_coverage`'s denominator is hunk COUNT, which measures how git split the patch, not
how much the patch changed.** Measured over the restraint set at $0:

| PR | hunks | changed lines | lines/hunk | leads (final run) | cov |
|---|---|---|---|---|---|
| 1698 | 6 | 147 | 25 | 4 | 0.50 |
| 1703 | 5 | 235 | 47 | 1 | 0.20 |
| **1708** | **95** | **386** | **4** | 6 | **0.06** |
| 1715 | 10 | 441 | 44 | 5 | 0.30 |
| **1720** | **3** | **1011** | **337** | 6 | **1.00** |
| 1721 | 8 | 1320 | 165 | 4 | 0.38 |

PR 1720 changed **2.6× more lines than 1708 while carrying 1/32 of the hunks.** Two runs of the same prompt
on the same day make the inversion concrete:

- **1720 r3** — 6 leads over 1011 changed lines = **0.59 leads per 100 lines** → scores **1.00**, the worst
  possible.
- **1698 r3** — 4 leads over 147 changed lines = **2.72 leads per 100 lines** → scores **0.50**, passes.

**The run that was 4.6× denser in leads per changed line scored better.** The metric orders the six PRs
close to backwards. Two consequences follow arithmetically, neither of them about this prompt:

1. On a 3-hunk PR the max-gate permits leads in **one hunk only** (2 of 3 = 0.67). Passing it on 1720 means
   emitting at most one lead across 1011 changed lines. No prompt clears that without going mute on large
   PRs, which is the §3.6 recall-first decision reversed by accident.
2. Excluding 1720 alone, the mean over the other five is **0.251** — comfortably inside the gate. One PR
   whose hunk structure is pathological carries the mean past the threshold by 0.009.

**The absolute measure, which is also ratified, tells the opposite story and passes: 3.83 leads per PR
against a ceiling of 6 and a hard cap of 12.** Across diffs from 147 to 1320 changed lines the scout emitted
1-7 leads — it does not scale its noise with the diff at all.

**The amendment offered for ratification.** Two shapes; the recommendation is (b).

- **(a) Replace the denominator** — score leads per 100 changed lines instead of fraction-of-hunks. On the
  final run the six PRs give 2.72 / 0.43 / 1.55 / 1.13 / 0.59 / 0.30, a 9× spread against `lead_coverage`'s
  17×, and it no longer rewards a patch for being finely split. It needs a threshold nobody has ever set.
- **(b) Drop the two ratio gates and keep the absolute one.** Restraint becomes "mean leads per PR ≤ 6",
  which was ratified in the same sentence, measures the DashBench failure mode directly (*filtering
  nothing, being loud everywhere*), and needs no new number. Simpler, and it removes an instrument rather
  than replacing one broken instrument with an unvalidated one.

**The circularity, stated openly because it cannot be removed:** any threshold ratified now is chosen with
v5's numbers already on the table. That is exactly the "gate quietly lowered" failure this file warns about,
and the only honest mitigations are to name it and to keep the downstream guard. **§3.11's two clean PRs in
M6 are that guard** — they were written in as "not optional garnish" precisely because M4's restraint gate
measures the SCOUT's lead volume and not the pipeline-level effect of hunters chasing spurious leads. A
weakened M4 restraint gate therefore does not leave adoption unguarded; it moves the guard to where the
design already put a second one.

**Two open items this milestone produced and did not close:**

1. **PR 1720's leads were adjudicated and they are NOISE — 0 corroborated, 9 refuted.** This item was
   opened on the opposite hypothesis: that a test-only PR raising test-isolation concerns was correct
   behaviour scored as failure, since test isolation and shared global state is a category our own
   resilience hunter owns. **That hypothesis is dead.** The nine distinct concerns from three runs were
   adjudicated against the real tree at `8888a69e` under refuter discipline (try to DISPROVE; default to
   refuted when unverifiable), and the orchestrator re-verified the three load-bearing verdicts with `git
   show` rather than accepting them:
   - `ILogger.warn(content: LogInput)` takes exactly ONE argument, so the "if warn takes (message, meta)
     this assertion can never match" concern rests on a false premise.
   - `verifiedAt: nowSeconds` is written from the SAME `now()` call the freshness check compares against
     (`SongSourceResolver.ts:294` and `:338`), so the ms-vs-seconds mismatch is structurally impossible
     rather than merely untested.
   - `env.ts:138` is `export const env = envSchema.parse(process.env)` at module-evaluation time, so an
     incomplete ambient environment is a loud import crash, never the silent CI-dependent false pass the
     concern described.

   **The distribution of HOW they were refuted is the finding, and it is a scout defect, not a metric
   artifact.** Five of the nine (the positional `mock.calls[1][0]` index, the unstubbed-key fixture, the
   MUST-SURVIVE dependency, the `overwrite`-ignoring mock, the `overwrite:false` round-trip) are refuted
   by text **inside the diff the scout was reading** — the stub's own docstring stating it throws by
   design, sibling assertions checking `overwrite === true` four times in the same file, the adjacent
   dedicated NX tests. The scout had that text in front of it and flagged anyway. Only ONE concern needed
   a file outside the diff to refute, and it is precisely the one raised in all three runs: the
   multiplicity was measuring the blind spot, not the defect.

   **So there IS a prompt lever after all, and it costs no recall:** before emitting a lead, check whether
   the rest of the supplied diff already answers it. That is not "be quieter" — it is "read what you were
   given", and it removes claims the input itself refutes rather than removing suspicions. Tracked as the
   v6 change; it also has no reason to cost coverage, but that must be re-measured rather than assumed.

   **What this does NOT change: the metric inversion above stands on its own.** It is an arithmetic
   property of hunk-count denominators, established from hunk/line counts and lead densities, and it
   holds whether the leads are good or worthless. The two findings are independent, and the honest
   reading of M4 needs both — the scout over-flags on 1720 AND the gate would misorder these six PRs even
   if it did not.
2. **`why` truncation is no longer anecdotal.** It fired in most of the final 30 runs, one run at 5 of 7
   leads. §3.8 is explicit that routine truncation is a PROMPT defect to fix and never a cap to raise. Not
   gate-blocking, not fixed here, recorded so it is not rediscovered.

**The prompt lineage, because M6 must know what it is running and every change was bought by a
measurement, never by taste:**

| ver | sha256 | what changed, and what paid for it |
|---|---|---|
| v1 | `8226ba1fbe32` | written from this design doc alone. 1719 blind, 0 of 2. |
| v2 | `5922ecab8962` | two ordered questions, "is this wrong on its own terms?" first — v1's central question was *"what would have to be true elsewhere"* and all 8 leads over two 1719 runs were cross-file uncertainty. Still 0 of 2. |
| v3 | `db9e3f59e353` | written against the SOURCE research, which v1/v2 never used: DoorDash's three classes (deletions, one side of a boundary, silent behaviour changes), Cloudflare's *What NOT to Flag*, the three example lead phrasings, the anti-hedge rule, Salesforce's relate-the-fragments as a third question, consequence as the cap tiebreak. 1719 → 1 of 3. |
| v4 | `618ef49ea1fc` | the one-sided-bound pattern became an ACTIVE sweep, and the scout was told the caps keep leads **in the order it writes them**. 1719 → 3 of 3; full coverage 15 of 15. |
| v5 | `68a81d26081e` | one concern earns ONE lead across sibling files; "what is not tested" is not a lead, while a test asserting something FALSE still is. Restraint mean 0.377 → 0.315 at R=1 and 1721 halved; 1719 cost 3/3 → 2/3, inside the gate. |

**Cost of M4: $25.78** against a ratified band of $5-15. The overrun was authorised explicitly
(*"no te preocupes por el presupuesto, hagamos lo mejor y mas solido"*) to buy the full 30-spawn pass rather
than a cheaper slice; the first $2.09 of it bought two defects in the probe itself (a relative
`systemPromptPath` the spawned CLI resolved against its own cwd, killing four runs for $0, and a 5-minute
watchdog that killed 17% of runs at 10 minutes before being raised to 15).

**v6 was built, measured, and REVERTED — and the revert is the most useful thing M4 bought.**
`b4e87a1275ed` added one rule, the only lever the 1720 adjudication justified: *before you write a lead,
look for its answer in the diff*, written explicitly so it could not become a mute button (if the diff does
NOT settle the suspicion, it stands, and the `why` must say nothing in the patch establishes it). Measured
the same way as v5 — 30 spawns, R=3, 15-minute ceiling, zero failed runs, $11.22.

| | v5 `68a81d26` | v6 `b4e87a12` |
|---|---|---|
| coverage | **5 of 5 PASS** | **FAIL** — 1719 at 1/3 |
| restraint mean | 0.339 FAIL | **0.313 PASS** |
| restraint max | 1.000 FAIL | 0.667 FAIL |
| leads per PR | 3.83 | 3.28 |

**And 1719's single v6 "hit" is positional, not semantic.** The lead sits at `:271` against a site at
`:296` — exactly 25 lines, the last line the window admits — and it describes the changed return type and
the new thrown error classes, naming neither the missing lower bound nor the future `verifiedAt` nor the
negative age. Semantically v6 scored **0 of 3** on the case v4 had taken to 3 of 3. All three runs were
dominated by contract-change observations, which is the question-3 behaviour v2 existed to correct.

**The finding, and it is now measured rather than argued: "read what you were given" could not be separated
from "stay quiet" as written.** A suppression-flavoured block placed after the not-a-lead list appears to
dampen the ACTIVE arithmetic sweep v4 had bought. The rule may still be right; the way it was written is
not, and rewriting it is not this milestone's work. **v5 is the M4 prompt.** Trading a result on the gate
that decides whether the scout is worth anything, to buy a mean on a gate this section has just proven is
inverted, is a bad trade at any price.

**One more datum from the v6 run, and it closes the arithmetic case beyond argument:** on 1720 the scout
emitted **2 leads in two of three runs** — over 1011 changed lines that is **0.20 leads per 100 lines, the
quietest behaviour anywhere in M4's 60 measured runs** — and still scored **0.667, FAIL**. The max-gate is
not merely hard to pass on that PR; with 3 hunks it is unreachable by any scout that says anything at all
in more than one of them.

**RATIFIED 2026-08-18 by Juanma: option (b).** The two `lead_coverage` ratio gates are struck; restraint is
`mean leads per PR ≤ 6`, which v5 clears at **3.83**. Implemented the same day in `scripts/scout-probe.ts`
— the ratio is still computed and still printed, now labelled a diagnostic, because deleting the
measurement that proved the gate wrong would destroy the evidence along with the instrument.

**What was NOT changed, and this matters as much as what was:** the coverage gate, its five target cases,
its 2-of-3 threshold, its exclusion rule (counter still at zero), and §3.8's four caps. The amendment
removes one broken instrument. It does not touch the assertion that decides whether the scout is worth
anything.

**Exit: MET, on an amended gate, and the amendment's circularity is recorded above rather than buried.**

- **Coverage: PASS** — five of five cases, R=3, semantic hits verified case by case.
- **Restraint: PASS** — 3.83 leads per PR against a ceiling of 6, over 18 runs.
- **The M4 prompt is `prompts/scout.md` sha256 `68a81d26081e` (v5).**
- Zero exclusions used; zero failed runs in the two final 30-spawn passes.
- **Cost: $37.00**, against a $5-15 estimate. The overrun is not an accident to be excused: it bought two
  probe defects found before they could corrupt a result, a watchdog raised on evidence from 10 to 15
  minutes, six prompt versions, and one reverted experiment. The estimate was wrong because it assumed
  the prompt would be right early, and §3.10 said this is where the prompt gets written and rewritten.

**M5 may begin.** It inherits three things this milestone did not fix, all recorded above and none
blocking: `why` truncation firing in most runs (§3.8 calls it a prompt defect), scout latency of 86-600s
against §3.9's "one short step" expectation, and the v6 rule — *look for the answer in the diff before
writing a lead* — which is probably right and was demonstrably written wrong.

### 3.11 M3 item 6b — the M6 protocol, and the fork only Juanma can settle

§3.1 established the metric shape and the uncomfortable arithmetic behind it. What follows is the protocol
that shape implies.

**Tier 1 — the floor test. Deterministic, per-case, no statistics, and it is the primary instrument.**
**Eight known defects with known sites over SEVEN distinct PRs** — five adjudicated misses over four PRs
(§2.3; PR 1724 carries two of them) plus three revert cases (§2.4bis, sites extracted in M4). Both arms run
each PR. The question is binary per case: *did this arm produce a refuter-corroborated finding at the site?*
No power calculation, no adjudication toll, and it fails loudly. Its weakness is stated up front: **8 cases
cannot rank two arms that both score well.**

> **CORRECTED 2026-08-17: it is five cases over four PRs, not eight over seven.** The three revert cases
> do not exist — two were re-landed byte-identically, one is unconfirmed (§2.4bis). What remains is the
> five adjudicated `true-positive` misses over PRs 1717, 1719, 1722 and 1724.
>
> The arithmetic moves the wrong way, and the direction is the point: 4 known-bad + 2 clean × 2 arms × R=2
> is **24 runs, ~$96** — cheaper than the ratified ~$144, and the saving is the bad news. This section
> already warned that 8 cases cannot rank two arms that both score well; **5 is strictly worse at the same
> job.** A floor test that only fires on gross differences is still worth running, but it is no longer
> capable of the "adopt / opt-in / drop" three-way call M6 owes — it can say *drop* loudly and it cannot
> distinguish *adopt* from *opt-in*.
>
> **So the corpus growth demoted to a fallback four paragraphs below is promoted to the main path**, on
> Juanma's call 2026-08-17: adjudicate candidates out of §2.4ter's widened corpus BEFORE M6 rather than
> after an ambiguous result, targeting a floor of roughly 12–15 cases. The cost is ~$16 per known-bad case
> at R=2 (so ~$200 for M6 rather than ~$96) plus the adjudication sessions, and the reasoning that
> previously argued for waiting — THE PIVOT, an 8-of-8 result makes it unnecessary — no longer applies,
> because at 5 cases the result that would make it unnecessary cannot be produced.
>
> **The adjudication carries §2.4bis's lesson as a hard rule:** a candidate is usable only on positive
> evidence that a reviewer could have caught it at the introducer's diff. Blame naming the last toucher
> is not that evidence, and neither is a fix existing. Any candidate whose defect cannot be sited in a
> reviewable diff is dropped, and the drop count is reported beside the kept count — a corpus that
> converts 100% of candidates into cases is the same leniency smell M2 caught at 53/53.

**Plus 2 clean PRs, and they are not optional garnish.** The original M6 entry ran "an equal number of
clean ones" for a reason the floor test alone cannot cover: M4's restraint gate measures the SCOUT's lead
volume, not the downstream effect — hunters chasing spurious leads into junk findings. The precision guard
in Tier 2 runs only on known-bad PRs, so it cannot see it either. Two clean PRs from §2.4's six, both arms,
same replicates, reading one number: **does the scout arm produce MORE findings than the control on a PR
where the control produces few?** Without them, option (a) leaves pipeline-level restraint unmeasured, and
that is the one thing a "bias, never filter" design is most likely to get wrong.

**Tier 2 — the effect test. Paired per-PR count of refuter-corroborated findings.** Precision guard: the
refuter's refuted + downgraded rate per arm, which must not rise — never raw volume (C1). Latency and cost
per arm recorded beside them. Sizing, from §3.1's table:

| N | R | runs | detectable δ | % of the 1.87 mean | ~cost |
|---|---|---|---|---|---|
| 8 | 2 | 32 | 1.35 | **72%** | ~$128 |
| 8 | 3 | 48 | 1.10 | 59% | ~$192 |
| 15 | 3 | 90 | 0.80 | 43% | ~$360 |

**The fork, and it is a money-versus-power call, not a technical one.** Tier 2 at any affordable size can
only see an effect roughly the size of DoorDash's own +75%. If this scout delivers +30%, we pay $200–360 to
learn nothing, and the honest write-up of that outcome is "underpowered, no conclusion" — which is not the
same as "no effect" and will read like one anyway. Three options:

- **(a) Floor test only.** 7 known-bad PRs + 2 clean, R=2, both arms = **36 runs, ~$144**. Adopt/drop
  decided on the 8 cases, the restraint read on the clean pair, and the latency/cost numbers. No claim of
  statistical effect is made or implied.
- **(b) Floor test + Tier 2 at N=8, R=3** (48 runs, ~$192 — the 8 PRs are the 7 above plus one clean),
  with the detectable-effect number printed in the write-up before the result.
- **(c) Floor test + Tier 2 at N=15, R=3** (90 runs, ~$360, and the wall clock is the real cost at ~4
  min/run serial).

**Recommendation: (a).** The floor test answers the question that actually decides adoption — *does the
scout catch things the control misses?* — case by case, at the lowest cost, with no instrument we cannot
trust. Tier 2 buys a number we would have to caveat into uselessness. If the floor test comes out
ambiguous (say 4–5 of 8 in both arms), (b) becomes worth its money, and the corpus is still there.

> **DECIDED 2026-08-17: (a).** Ratified by Juanma — see §3.14. One refinement to the ambiguity fallback,
> created by #43 closing the same day: the floor test is binary per case and paired per PR, so it
> **extends incrementally at no methodological cost** — a case added later is its own self-contained pair
> and invalidates nothing already run. So an ambiguous floor is grown from the widened corpus (§2.4ter) at
> ~$16 per known-bad case at R=2, which buys deterministic cases instead of Tier 2's underpowered
> statistic at comparable money. Tier 2 is not deleted; it is demoted below corpus growth in the fallback
> order. Caveats on any such growth: `blame-linked` is the weakest tier, and while #44's self-blame defect
> was FIXED the same day (`234a1ef`, `blameResolve` now drops a resolution landing on the fix PR itself),
> **that commit did no live re-run — the 452/11 counts on disk predate it and still carry the ~1%**, so
> growing the floor from `blame-linked` means re-running `pr-hero corpus` first or adjudicating past the
> overstatement; musive's `issue-linked` is 0 structurally (Jira); and a supermarket-pro candidate would
> put a second repository inside this protocol, so **v1 stays musive-only**.

**Protocol invariants for whichever option is chosen:**

- Both arms run the same day, same engine build, same prompt set; the control arm is RE-RUN rather than
  read off the on-disk baselines, which serve as the third point (variance-only).
- A scout-arm run whose scout failed is excluded and re-run (§3.6).
- The cross-root ledger problem (§1.2) is real: `pr-hero ledger` takes one `--runs` root. M6 either teaches
  it several or aggregates by hand and says so in the write-up.
- C10's blind spot applies to the read of every number: neither tier sees what both arms missed.

**Exit:** the decision (adopt / opt-in / drop), the numbers, and the ledger entry.

### 3.12 What M5 owes, created by the decisions above

Test obligations, all offline, none optional:

1. **`tools: []` emits `--tools ""` and the spawned step really has no tools** — §3.5's mechanism 1 rests
   on it and nothing covers it today (`step-runner.ts:193-194`).
2. The leads block appears in the hunter user prompt in the documented order, and **is absent — byte for
   byte — when the scout is off**, which is what makes the control arm the control arm.
3. Cap enforcement: 12 leads, 240 chars, 3000 total, 3 per path, deterministic truncation, `leads_truncated`
   recorded.
4. Scout failure ⇒ hunters run unled, `run_status` stays `complete`, `scout.status: "failed"` is written,
   the event fires.
5. Scout usage lands in `state.usageTotal` and in `per_agent.scout` (copy `test/pipeline.test.ts:532`).
6. `estimateCost` with `scoutEnabled` raises the band; all three call sites pass it.
7. `pipeline.json` carries the new `scout`, `engine`, `prompt_set`, `generated_at` keys, and the existing
   reader still parses it.
8. `fixture-eval` passes with the flag on AND off (the planted bug still found, the band still honest); one
   `live-micro-eval` with the flag on.
9. **`prompts/scout.md` must not be named `review-*.md` or `deep-review-*.md`, and must not live in the
   agents dir** — a test that pins this, because the failure it prevents is a hard `CliError` on every run.

### 3.13 Levers deliberately NOT pulled in v1, so M6 stays one variable

Each is a real idea, deferred on purpose, with the reason recorded so it is not re-litigated:

- **The filter half** (scout marks parts of the diff as not needing scrutiny) — §3.4. Its cost lands
  entirely in C10's blind spot. Its own experiment, its own control.
- **Per-hunter lead filtering** — §3.8. Requires the scout to know the taxonomy; drags it toward v1.
- **A cheap scout tier** (`--scout-model haiku` and DashBench's Kimi result) — §3.7. The flag ships, the
  variable does not.
- **Priors / gotchas / PR body fed to the scout** — §3.8. Correlates its attention with the hunters'.
- **Repo access via codegraph for cross-file drift** — the roadmap's own escape hatch in C7 item 2. Not
  taken: it reopens the isolation question, costs money per run, and §3.5's mechanism 1 is what keeps the
  scout from becoming v2. If M6 says the scout's misses are all cross-file, THAT is the evidence that buys
  this lever, and not before.

### 3.14 Ratification

Juanma ratifies this design before M4 begins. The decisions above that are his to overturn, in the order
they would cost the most to change later:

1. **§3.11's fork — (a) floor test only, (b) +Tier 2 at ~$192, or (c) +Tier 2 at ~$360.** This is the only
   one that spends money, and the recommendation is (a).
2. **§3.4 — bias, and the filter half deferred.** The largest architectural commitment here.
3. **§3.7 — `prompts/scout.md`, engine-owned, prompt set untouched.**
4. **§3.10's exclusion rule** — at most one target case may be dropped from the coverage gate, and a second
   returns the diff-only decision to him.

**Ratified 2026-08-17 by Juanma.** All four as recommended:

1. **§3.11's fork → (a), the floor test alone.** 7 known-bad PRs + 2 clean, R=2, both arms — 36 runs,
   **~$144**. No statistical effect is claimed or implied, and the write-up says so. If the floor comes out
   ambiguous, it is GROWN from #43's widened corpus (§2.4ter) rather than backed by Tier 2 — the reasoning,
   the ~$16/case arithmetic and the three tier caveats are in `ROADMAP-DOORDASH.md`'s M3 entry, and the
   reason not to pre-pay that adjudication is THE PIVOT: sessions are the scarce resource and an 8-of-8 or
   1-of-8 result makes it unnecessary.
2. **§3.4 — bias, filter half deferred.** Stands.
3. **§3.7 — `prompts/scout.md`, engine-owned, prompt set untouched by construction.** Stands.
4. **§3.10's exclusion rule — at most one case, a second returns diff-only to Juanma.** Stands.

M4 may begin. Nothing in M5 or M6 starts without its own gate passing first.

### 3.15 M5 SHIPPED — the wiring, and the two numbers the design had estimated

**Done 2026-08-18, one session, `e1ed036`.** `--scout` exists on `review`, defaults OFF, and the watcher
does not know it exists. All nine §3.12 obligations carry a named test; four more were added because the
design implied them without listing them (model precedence, the `spec.parse` seam, the config seat, the
plan row). Offline: 1387 tests, tsc and biome clean, `scripts/` and `fixtures/` typechecked under an
explicit tsconfig — the coverage gap `CLAUDE.md` names, closed for this change rather than in general.

#### 3.15.1 Deviation 1 — the watchdog is 15 minutes, not 5

§3.5 mechanism 4 says "a 5-minute watchdog, copying the summarizer". That number was written before the
stage had ever run. M4 then measured it at **86-600s across 60 spawns** and raised its own probe watchdog
from 10 to 15 on that evidence (§3.10bis). A 5-minute ceiling would reap runs the only data we have calls
normal, and it would reap them as FAILURES — which, under §3.6's fail-open rule, means silently
converting scout-arm runs into control-arm runs. That is the exact way an A/B lies quietly, so the
measurement outranks the estimate that preceded it. One attempt is unchanged.

#### 3.15.2 Deviation 2 — `DEFAULT_SCOUT_MODEL`, because "the run's model" does not exist

§3.7 says the model is an "independent knob, defaulting to the run's model". There is no such thing. A
hunter's model comes from its own agent frontmatter; `input.model` is set only when `--model` is passed;
and `prompts/scout.md` carries no `model:` line at all. So a plain `pr-hero review --scout` would have
failed construction on `resolveModel` — fail-open would have swallowed it, every run would have gone
unled, and `pipeline.json` would have said `status: "failed"` on a scout that never got as far as a
spawn. It would have looked like a flaky provider.

Two exits. Adding `model: sonnet` to `prompts/scout.md` was rejected: that file is M4's ratified artifact
at sha256 `68a81d26081e`, and moving that sha for a prompt whose BODY nothing changed would break the
reference every M4 number is recorded against. So the engine owns the last seat:

```
--model  >  --scout-model  >  the prompt's frontmatter  >  DEFAULT_SCOUT_MODEL
```

The default sits LAST so a frontmatter model added later still outranks it. The value is not a taste
call: every one of M4's 60 measured spawns ran sonnet (`scripts/scout-probe.ts` defaults to it and never
reads the prompt's frontmatter), and M6's whole control corpus is sonnet (§1.2). It is the model the
scout has been measured on and the model the A/B will run it on. The cheap tier stays §3.13's later
experiment.

#### 3.15.3 One key beyond §3.9's list, and the reason it is not scope creep

`pipeline.json`'s `scout` row carries `why_truncated` alongside the seven keys §3.9 named. M5 inherits
M4's `why`-truncation defect — it fired in most runs — and §3.8 already rules that a truncation firing
routinely is a PROMPT defect to fix, never a cap to raise. A defect that only a probe nobody re-runs can
see is a defect nobody notices. It costs one integer per run.

#### 3.15.4 What the live gates bought, at $0.353

| gate | result | cost | wall |
|---|---|---|---|
| `live-micro-eval --scout` | ok, 1 lead, correct | $0.0539 | 3.6s |
| `fixture-eval` | PASS, planted bug hit | $0.1298 | 71.0s |
| `fixture-eval --scout` | PASS, planted bug hit | $0.1695 | 128.7s |

The micro-eval grew a `--scout` mode for one reason, and it is the mechanism this whole design rests on.
`--tools ""` is asserted at the argv layer (`test/step-runner.test.ts`), but **nothing had ever confirmed
that the CLI on the other side ACCEPTS an empty allow-list** rather than reading it as "unrestricted" or
refusing to start. §3.5's honest caveat still stands — `cwd` is the worktree and `--mcp-config` is still
emitted, so this is an allow-list and not a sandbox — but the allow-list is now known to be honoured by a
live session, not merely by our argv. The toolless scout found the planted off-by-one from the diff alone.

The scout-arm fixture run wrote `prompt_sha256: 68a81d26081e…` — M4's ratified v5, byte for byte — and
its single lead landed ON the planted defect at `src/volume.ts:4`.

#### 3.15.5 The number M6 must read twice

**The scout added 38.9s to a 71s run** — on haiku, over a two-file diff, one attempt. §3.9 stated the
critical-path cost rather than hiding it and expected "one short step"; §3.10bis already recorded 86-600s
against that expectation and called it an inherited concern. This is the third datum pointing the same
way, and the first from the production wiring rather than a probe. M6 records latency per arm as a
first-class number, and the adopt / opt-in / drop call will be made against a stage that is not free in
wall clock even when it is cheap in dollars.

#### 3.15.6 What M5 did NOT do

- **`#40`** (soft timeout, two-stage semantics). The M1 amendment orphaned it — "pick it up on its own
  merits, not as part of a milestone" — so M5's entry naming it is superseded, not skipped.
- **`prompts/scout.md` is untouched.** The three inherited concerns from §3.10bis (`why` truncation
  firing in most runs, scout latency, the v6 rule written wrong) are prompt work gated on `scout-probe`,
  not M5 scope. Its sha is still `68a81d26081e`.
- **The config seat stays closed.** `.prhero/config.json` rejects a `scout` key today, and gets one only
  after M6 says the stage is worth defaulting on.
- **No `--no-scout`.** The flag is off unless asked for, so a negation would only restate the default.

**M6 may begin.** It is the only paid experiment in this track, and nothing in it starts without §3.11's
protocol — the floor test grown past five cases first, per the 2026-08-17 amendment.

### 3.16 THE M6 PILOT — 3 PRs, R=2, and the harness earned its money before the data did

**Run 2026-08-18/19. 12 runs, $44.32 measured.** Not a result about the scout: 2 of 13 cases is
nothing to read. It was run to prove the harness against real merged PRs before committing five hours,
and it found two defects in the first ten minutes plus one side effect nobody had written down.

#### 3.16.1 What the harness got wrong, both caught live

1. **`--out` in PR mode names the run DIR, not a runs root.** `predictPrRunDir` short-circuits the
   smallest-unused-integer loop and returns an explicit `--out` verbatim, so one root for twelve reviews
   meant twelve reviews overwriting each other in place — and overwriting a run that cost money is
   exactly what that integer loop exists to prevent. Killed at ~$1-3. A new `m6.ts check` — the same argv
   with `--dry-run` appended — catches it for $0 and is now `run`'s documented prerequisite.
2. **A review can exit 0 without running.** The kill left a `pending` `pr-hero` commit status on PR 767's
   head; that status is a cross-machine in-flight lock with a 90-minute TTL, so the relaunched pilot's
   `--yes` runs printed `skip: a pr-hero review is already in-flight on this head` and returned **0**.
   Two runs were recorded as successes having written nothing. An empty effective diff and a size-gate
   skip do the same. Each is a HOLE in an arm that the floor table would report as a smaller denominator,
   and the run ended by printing `m6 run: every review exited 0` over exactly that hole.

#### 3.16.2 The side effect that was not written down

Every PR-mode review posts a `pr-hero` COMMIT STATUS on the head — pending, then success/error — as the
operator's own GitHub account. The harness never passes `--post`, and describing it that way was
incomplete: `--post` covers comments, not statuses. Over 14 merged PRs x 56 runs that is a visible mark on
closed work, and an ABORTED run leaves a `pending` that blocks the next attempt on that head for 90
minutes. 767's was superseded by hand with an `error` state saying no review was produced.

#### 3.16.3 The numbers, which are about COST and LATENCY, not about the scout

Measured over all 12 runs, 6 per arm. Every figure here is re-derivable from the artifacts:
per-run cost and wall clock live in `findings.json` at `telemetry.cost_usd_est` and `telemetry.wall_ms`,
and the scout stage at `telemetry.per_agent.scout.duration_ms`. **`pipeline.json` carries no cost field**
— reach for `findings.json`, or a ledger built on the wrong file reads $0 and says nothing.

| | control | scout arm | delta |
|---|---|---|---|
| runs | 6 | 6 | |
| cost per run, mean | **$3.36** | **$4.03** | **+20%** |
| wall clock per run, mean | **6.34 min** | **9.76 min** | **+54%** |

Scout stage duration, per run: **103, 148, 165, 209, 268, 286s — mean 196s.**

The last two runs were the 767 replicate-1 fill-in and they landed on the SAME two ratios the first ten
gave (+21%/+54% at N=10, +20%/+54% at N=12). Two replicates do not make a variance estimate, but a ratio
that does not move when the sample grows by a fifth is the cheapest reassurance available here — and §1.3
is the reason to want it, since six of eight same-head replicate pairs MOVED by as much as the whole
effect the scout is supposed to produce.

**Two corrections to the go/no-go, both from this table:**

- **The cost band holds, and the earlier "near the LOW end" read was an artifact of the small sample.**
  `estimateCost` gives the scout a full agent seat, predicting ~+33% against a measured +20%. Extrapolated,
  the full 56 runs are **~$207** — inside the $173.68-$374.22 band but mid-range, not at its floor. **What
  a decision actually costs is the REMAINING 44**, not 56: §2.4septies's clause makes the floor test extend
  incrementally, the 12 pilot runs are on disk, and `scripts/m6.ts run` resumes over them — **~$163**,
  conditional on the invariant that produced them (§3.11: same day, same engine build, same prompt set).
  If this engine build moves, those 12 stop being arm data and become a variance third point, and the
  price of the decision goes back to the full 56.
- **The wall-clock estimate was wrong and the error is worse than the first read said.** `plan` assumed
  ~4 min/run and printed ~4h44m. Measured, the full 56 are **~7h31m** — 59% more — and the remaining 44
  are **~5h54m**. The scout arm is the whole difference, and §3.11 said wall clock, not dollars, is M6's
  real constraint.

**The latency finding is now the strongest thing this milestone has measured, and it is not about
recall.** §3.9 expected "one short step". The evidence, in order: 38.9s (fixture, haiku, 2 files), then
86-600s (M4's probe), then 103-286s here on real PRs. **The scout adds ~3.3 minutes to every review**, and
the arm's total wall clock grows by more than the stage costs (+3.4 min/run against a 196s stage) because
the leads block lengthens every hunter's prompt too. For a PR-triggered reviewer whose whole product claim
is arriving before a human does, that is a product number and not just a benchmark one, and M6's adopt /
opt-in / drop call should read it beside whatever the floor test says.

**Spend ledger for M6 so far (rule 6):**

| | |
|---|---|
| the killed first attempt, `--out` defect | ~$1-3, no artifacts |
| the pilot, 10 runs | $32.25 |
| the 767 r1 fill-in, 2 runs | $12.07 |
| **on disk and scorable** | **$44.32 / 12 runs** |

#### 3.16.4 The two cases that did run

| # | PR | type | control | scout |
|---|---|---|---|---|
| 1 | 1717 | miss | **0/2** | **2/2** |
| 9 | 767 | corpus | 2/2 | 2/2 |

Case 1 is the cleanest shape a floor test can produce — consistent in both replicates in both directions,
against §1.3's measured noise where six of eight same-head pairs MOVED. Three caveats, all of which
survive into the write-up: it is ONE case; the scout's hit is at line 144 against a site at 119, which is
**exactly 25 — the inclusive boundary of the window**, not a comfortable match; and 1717 is by
construction a PR where the control was already recorded as missing (§2.3). Case 9 is hit by both arms in
every replicate, which is §3.11's stated weakness made concrete: a tie informs nothing. Its replicate 1
ran a day after its peers (the fill-in for the two runs the in-flight lock ate) — inside §3.11's engine
build and prompt set, outside its same-day wording, and recorded here rather than quietly averaged in.

#### 3.16.5 The clean pair, one PR of the two

| PR | control | scout |
|---|---|---|
| 1720 | 0 (0 corr) · 0 (0 corr) | **1 (0 corr, 1 cause)** · 0 (0 corr) |

The control is perfectly silent across both replicates, which is the best possible baseline: anything the
scout arm produces is attributable to the stage with no background to subtract. It produced one
`WARNING`, `not_submitted` (only severe findings reach the refuter), in one of two replicates. That is a
weak version of the failure §3.11 watches for rather than a clean bill: one advisory finding, not a
blocker, and not reproduced. 1721 has not run.

#### 3.16.6 What the pilot did NOT establish

Nothing about adopt / opt-in / drop. 2 of 13 cases, one of two clean PRs, and the one differing case is
the one the corpus already knew the control missed. The floor test's own caveat governs the read: it can
say `drop` loudly and it cannot distinguish `adopt` from `opt-in`.

### 3.17 THE DECISION — opt-in, 2026-08-20

**Juanma, 2026-08-20: OPT-IN.** The scout stays exactly as M5 shipped it — `src/scout.ts`,
`prompts/scout.md`, the `--scout` flag, default OFF, and the watcher still does not know the flag exists.
It is NOT adopted as default and it is NOT dropped. `ROADMAP.md` item 7's splice condition 3 ("M6
decided") is satisfied by this section, and item 7 is designed against the **no-scout-by-default**
pipeline.

Two things produced the call. Neither is the full matrix, and the second is why the full matrix stopped
being the question.

#### 3.17.1 Evidence 1 — §3.11's same-build invariant no longer covers the pilot runs

This is a new finding, read out of the code this session rather than remembered. **C4 shipped AFTER the
pilot ran**: `d0cb47e` and `bbd5277` are both dated 2026-08-20; the pilot is 2026-08-18/19.
`writeSystemPrompt` (`src/pipeline.ts:350-355`) prepends `RUNTIME_PREAMBLE` to **every** system prompt the
engine writes:

```ts
await Bun.write(systemPromptPath, `${RUNTIME_PREAMBLE}\n${body}`);
```

Unconditionally — there is no flag and no arm-dependence. `RUNTIME_PREAMBLE` has exactly two references in
`src/`: its definition at `src/pipeline.ts:309` and that one write site.

**Therefore §3.11's invariant — same day, same engine build, same prompt set — is broken for POOLING
purposes.** The 12 pilot runs remain internally valid as a pair: they were produced by one build with the
arms interleaved per PR, so nothing about §3.16's numbers is retracted and they stay scorable from
artifacts forever. What they can no longer be is pooled with any run produced by today's engine.

**The consequence, stated plainly: "run the remaining 44" no longer exists.** §3.16.3 priced the decision
at the remaining 44 — ~$163, ~5h54m — explicitly "conditional on the invariant that produced them", and
that condition has now failed. Buying M6's data means **56 runs from zero**: the `plan` band of
$173.68–$374.22 and ~4h44m serial, or ~$207 / ~7h31m if §3.16.3's measured per-run ratios still hold,
which is itself an assumption about a build the preamble has since moved. That arithmetic is what turned
a paused experiment into a decision.

#### 3.17.2 Evidence 2 — the floor test scored the pilot at $0

`bun run scripts/m6.ts score`, 8 runs scored from `~/Desktop/musive/musive-m6-runs`. This table is the
ledger entry that closes `ROADMAP.md` item 7's splice condition 4:

| # | PR | type | control | scout | site |
|---|---|---|---|---|---|
| 1 | 1717 | miss | 0/2 | 2/2 | `packages/app/components/PaywallUpgrade/index.tsx:119` |
| 2 | 1719 | miss | not run | not run | `packages/backend/src/Infrastructure/Http/SongSourceResolver.ts:296` |
| 3 | 1722 | miss | not run | not run | `packages/backend/src/Utils/m4aRemux.ts:181` |
| 4 | 1724 | miss | not run | not run | `docs/runbooks/mus-638-song-bucket-rollout.md:144` |
| 5 | 1724 | miss | not run | not run | `docs/runbooks/mus-638-song-bucket-rollout.md:140-142` |
| 6 | 1471 | corpus | not run | not run | `.github/workflows/build-check.yml:39` |
| 7 | 853 | corpus | not run | not run | `packages/app/hooks/useChangeCover.tsx:120` |
| 8 | 1307 | corpus | not run | not run | `packages/web/src/store/FileUploaderStore.ts:405` |
| 9 | 767 | corpus | 2/2 | 2/2 | `packages/web/src/Context/AudioPlayerContext.tsx:278` |
| 10 | 965 | corpus | not run | not run | `packages/backend/src/Infrastructure/Cloudflare/CludflareDriver.ts:338` |
| 11 | 1179 | corpus | not run | not run | `lambda/song-waveform/src/index.ts:145` |
| 12 | 1141 | corpus | not run | not run | `packages/backend/src/Infrastructure/Http/Controllers/PublicProject.ts:216` |
| 13 | 1248 | corpus | not run | not run | `packages/backend/src/Infrastructure/Tigris/TigrisDriver.ts:922` |

```
control: 1/13 cases hit in at least one replicate, 1 in every replicate, 1 found at the site before refutation
scout:   2/13 cases hit in at least one replicate, 2 in every replicate, 2 found at the site before refutation
```

The clean pair (§3.11), same command: PR 1720 control `0 (0 corr, 0 causes) · 0 (0 corr, 0 causes)` vs
scout `1 (0 corr, 1 cause) · 0 (0 corr, 0 causes)`; PR 1721 not run in either arm.

#### 3.17.3 Why that reads `opt-in` and nothing braver

The scorer prints its own limit beside the numbers, and it is the sentence that governs this decision
(`src/floor-test.ts:349`):

> It can say `drop` loudly; it cannot distinguish `adopt` from `opt-in`.

The pilot does not say the scout is bad — 2/13 against 1/13 is not a loud `drop`, and 11 of the 13 cases
were never run at all. It says the instrument, on this data, cannot rank the two arms. **`opt-in` is the
only call the evidence supports: not enough to adopt, not enough to drop**, and §3.16's calibration
defect — 4 leads against a 12 budget, 43% file coverage, stacking against `MAX_LEADS_PER_PATH = 3`, 40%
of scout-arm drafts collapsing in the merge — is the thing a future re-run would have to fix FIRST.
§3.16.3's latency finding points the same way: ~3.3 minutes added to every review is a product number, and
it caps the ceiling of this stage independently of what any floor table says.

**Reopening M6 later is legitimate.** It costs 56 runs from zero on whatever build is current then, plus a
recalibration decided before the money is spent — not after.
