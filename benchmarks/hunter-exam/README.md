# Hunter exam

Planted-defect cases with known answers, graded by a script from each hunter's own draft. It answers one
question about one hunter prompt: does it see the defects it is there to see, and does it stay quiet on code
that only looks wrong. It runs locally, one hunter at a time, and is meant to be run in a loop by an agent
that edits a prompt and needs a verdict it can read.

It does not say how the product ranks against other tools (that is the Martian benchmark) or what happens to
findings on real pull requests (that is the store).

## Status: the machinery works, the bank does not discriminate yet

As of 2026-11-15 the pass rate of this exam is **not a quality metric**. On 14 single runs, one per case, the
logic hunter found every planted defect (15 of 15). An exam everything passes cannot tell a better prompt from a worse
one. What did move: the severity a found defect is reported at (blocking defects rated blocking in 8 of 8
plain cases, 3 of 5 when the same defect sits inside a larger real commit), and a correct look-alike reported
as a defect in 2 of 3 runs of the first case. Only the logic hunter has been run, and no change larger than
497 lines.

The cases were chosen for being provable (recent, small fixes that came with a test), not for being hard.
What the bank needs next is cases taken from known misses of the pipeline, where the current prompts fail by
construction, and more cases with look-alikes. Until then, use it to compare one thing against another on
the same case (a paired run), not as a score.

## Commands

```bash
bun run benchmarks/hunter-exam/exam.ts plan  --hunter logic   # $0: what is stored, what would be bought
bun run benchmarks/hunter-exam/exam.ts run   --hunter logic   # LIVE for what is not stored
bun run benchmarks/hunter-exam/exam.ts score --hunter logic   # $0: grade stored runs again
bun run benchmarks/hunter-exam/exam.ts list                   # $0: the catalogue of cases and their classification
bun run benchmarks/hunter-exam/exam.ts check                  # $0: builds every case and checks its key and hygiene
bun run benchmarks/hunter-exam/exam.ts where                  # $0: the folder it writes to, and its sizes
bun run benchmarks/hunter-exam/exam.ts clean [--all]          # delete downloads; --all also deletes paid runs
```

`--hunter` is required. `--agents <dir>` examines another prompt set, and `--hunter key:file.md` a hunter that
is not in the spec yet. The header of `exam.ts` lists every option and the exit codes.

## Choosing what to run

The whole bank is never the default thing to run. Every case is classified, and the same options narrow
`list`, `check`, `plan`, `run` and `score`:

| option | keeps |
|---|---|
| `--quick` | the small set meant for a fast check: a few cases spanning projects, areas and depths |
| `--area <a,..>` | cases with a defect in that area: `logic`, `state`, `contract`, `failure`, `security`, `concurrency`, `data` |
| `--min-depth <n>` | cases with a defect at least that far outside the changed lines (0 in the hunk, 1 same file, 2 another file, 3 several files or runtime order) |
| `--project <p,..>`, `--lang <l,..>`, `--origin synthetic\|real-fix\|real-intro` | by where the case comes from |
| `--case <id,..>`, `--failed-from <report.json>` | named cases, or the ones that did not pass last time |

A usual loop: `list` to see what exists, `run --quick` after an edit, `run --area <the hunter's area>` before
accepting it, `run --failed-from` to repeat only what failed.

A run is one model call on the hunter's production model and effort: one hunter, no refuter, the layout a
local review uses, no priors and no review instructions. Every live run goes in the lab ledger the day it runs.

## Where things go

Everything the exam downloads, installs or writes lives under one folder, `~/.crysk/casebank` (set
`CRYSK_CASEBANK_HOME` or pass `--home` to move it):

| folder | holds | safe to delete |
|---|---|---|
| `runs/` | stored runs, reused while the request is unchanged | costs money to rebuild |
| `reports/` | `report.json` and each run's artifacts, one folder per invocation | costs money to rebuild |
| `repos/` | mirrors of the real repositories some cases are built on | yes, downloaded again |
| `deps/` | dependencies installed to run a case's proof | yes, installed again |
| `work/` | checkouts in use, removed when a run ends | yes |

The folder's name is plain on purpose: a hunter sees the path of its checkout, and a path that says "exam"
tells it that it is being examined.

## Cases

`bank.json` holds the N-of-M threshold. Each `cases/<id>/` holds what the repository is built from and
`key.json`, the case's answer: its classification, each planted defect (`must_find`: area, class, depth, what
is wrong, the lines a finding must point at) and each correct look-alike (`must_not`). The key never enters
the repository a hunter reads.

- Small case (`origin: synthetic`): `base/` is the whole tree before the change.
- Case on a real repository (`origin: real-fix`): a real fix commit, reverted. `source.json` pins the
  repository and commit and lists paths to `drop` (the changelog, which describes fixes in words);
  `base.patch` removes the test the fix came with; `proof.json` records that the fix's own test passes at the
  pin and fails with the change. The tree is exported without the project's history.
  `case-from-fix.ts` writes the patches, and `--move-comments` moves comments the change would remove into
  the base, so a comment that explains the defect does not show up in the diff.
- Case on the commit that introduced a defect (`origin: real-intro`): the real commit a later fix repaired,
  reviewed as it was, nothing reverted. `case-from-fix.ts --intro` writes it; `proof.json` has
  `kind: "blame"`, the fix and the introducing commit. Unlike a reverted fix, the defect is part of the
  change's own logic and not an off-topic hunk.
- All: `head.patch` and the files under `head/` are the change under review, `message.txt` its commit message.

What the first runs showed about each kind, so the next reader does not pay for it again: a reverted fix
alone is a change of a few lines that consists of the defect, and a hunter finds it every time; inside a
carrier it is still found, because a hunk unrelated to the commit's purpose stands out, but it is reported at
a lower severity. Each defect therefore carries an expected `severity` (`blocking` or `advisory`, by its
consequence), and a run reports, beside found and missed, how many blocking defects were rated blocking.

Rules for a case:

1. Each defect is proven by running code (the case's own, or the fix's test), not by opinion.
2. One defect per site: the grader reads only where a finding points, so two defects on the same lines cannot
   be told apart.
3. A `must_not` site is correct code with a written reason, and nothing else on those lines is arguable.
4. Nothing in names, comments or the commit message points at the defect.
5. Read the claims of a new case's first run before trusting its key: a hunter may find a real defect nobody
   planted.
6. Holdout cases are kept out of this repository: a public key ends up in training data.
