# Benchmarks

Harnesses and corpora for measuring Crysk against external review benchmarks. Each benchmark has its
own folder, with a `README.md` that explains how to run it.

| Benchmark | Folder | What it answers |
|---|---|---|
| [Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark) | [`martian/`](martian/README.md) | How Crysk compares with other review tools on 50 public PRs |
| [ReviewBench](https://github.com/review-bench/ReviewBench) | [`reviewbench/`](reviewbench/README.md) | How Crysk compares with other review tools on 25 to 219 real PRs |

## Adding a benchmark

1. Create `benchmarks/<name>/` with a `README.md` covering the question it answers, its cost, and how to run it.
2. Keep code in that folder until a second benchmark needs the same code. There is no shared layer yet.
3. Keep code that `src/` imports in `src/`. This folder is not published to npm, and `src/` is.

## Where results go

Never commit run output here: this repository is public. Raw data goes to
`../deep-review/bench/experiments/<date>-<slug>/`, and each live run gets a section in
`../deep-review/bench/METRICS.md` on the day it runs. See rule 6 in `CLAUDE.md`.
