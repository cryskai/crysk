# Martian bench — operational flow

Canonical protocol: `docs/benchmarks/martian-bench.md`. This file is the runbook.

## Layout on disk

| Path | Role |
|---|---|
| `~/Desktop/martian-cal/cal.com` | Blobless clone (`git clone --filter=blob:none`). GitHub renamed the repo `calcom/cal.diy`; clone via `cal.com` still works |
| `~/Desktop/martian-cal/runs/cal-<pr>-hunters/` | Baseline arm (`hunters`). Sacred until a **new** arm id is chosen |
| `~/Desktop/martian-cal/runs/martian-judge.json` | Surface A scores for the dirs the judge scanned |
| `docs/benchmarks/martian-cal-cases.json` | SHAs + GitHub size stats (captured 2026-08-19). All ten PRs are MERGED |
| `docs/benchmarks/martian-cal-goldens.json` | Vendored Martian Cal.com goldens (10 PRs, 41 issues) |
| `docs/benchmarks/martian-cal-gotchas.md` | Intentionally thin. No gold, no vendor comments |

A new arm **must** use a new suffix (`cal-<pr>-scout`, `cal-<pr>-hunters-v2`, …). `run` skips only schema-valid completed reviews with matching frozen identity and attributable attempt evidence. Legacy files alone do not qualify. Unqualified prior directories are preserved under `incomplete-attempts/`; use a new arm rather than rewriting a historical baseline.

## Isolation (fairness)

Martian’s online methodology: two GitHub bots on one PR contaminate. We stay off the original thread.

Required flags (the harness already passes them):

```text
pr-hero review --repo <clone> --base <baseSha> --head <headSha>
  --two-dot --yes --no-summary
  --agents <SUGGESTED_AGENTS_DIR>
  --gotchas docs/benchmarks/martian-cal-gotchas.md
  --out ~/Desktop/martian-cal/runs/<arm-dir>
```

`--two-dot` is load-bearing: merged PRs make `main...head` empty, and a shallow fetch of two SHAs may lack the merge-base.

Never:

- `--pr` / `--post` on `calcom/cal.com#N`
- GitHub MCP or Bash in the hunter tool list (`pipeline.json` would invalidate the arm)
- Goldens or stored vendor reviews in hunter context
- `codegraph init` inside the Cal.com clone (dirties the tree; local mode does not init it)

Engine isolation stays: `--strict-mcp-config`, `--setting-sources ""`, no Write/Task/Bash for agents.

## Baseline pipeline (arm `hunters`)

- Hunters: reliability, resilience, lifecycle + refuter
- Scout **off**, summarizer **off**, parity never fires
- Prompt set: `slice3b-lifecycle-v6-clean` (`sha256: 5ac28df9bddbd4c8`)
- Agents dir: `SUGGESTED_AGENTS_DIR` = `/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v6-clean` (immutable — scored)

One variable if you change any of those. Name the new arm.

## The other four corpora (authorised 2026-10-25)

`--corpus sentry|grafana|keycloak|discourse` selects the other forty PRs (`cal` is the default).
Each corpus is data in `scripts/martian-corpora.ts` plus three docs files:
`docs/benchmarks/martian-<corpus>-{cases.json,goldens.json,gotchas.md}`.

- Case files come from `bun run scripts/martian-cases.ts <corpus>` (read-only `gh api`). Never hand-edit them; `test/martian-corpora.test.ts` checks them against the goldens.
- Fifteen PRs live in synthetic forks (`ai-code-review-evaluation/*`). Their rows carry `remote`, and the SHAs are fetched from there.
- The four new clones are empty repos that fetch only each PR's two commits (`--depth=1`, blobless). Sentry costs ~235 MB, not a full clone.
- Runs land in `~/Desktop/martian-cal/runs-<corpus>/<corpus>-<pr>-<arm>/`.
- The harness passes the **shipped** size gate (`DEFAULT_SIZE_GATE`, 4000 lines) explicitly, so an operator config that lowers it cannot drop a PR every vendor reviewed.

Judging like the vendor rows (no API key):

```bash
bun run scripts/martian-claude-shim.ts --port 8787 &       # OpenAI-compatible -> claude -p
cp <martian>/offline/results/benchmark_data.json <copy>    # never mutate the upstream file
bun run scripts/martian-inject.ts --arm <arm> --data <copy>
MARTIAN_BASE_URL=http://127.0.0.1:8787/v1 MARTIAN_API_KEY=local \
MARTIAN_MODEL=anthropic/claude-opus-4-5-20251101 \
  uv run python -m code_review_benchmark.step2_extract_comments --tool pr-hero   # then 2.5 and 3
```

The shim refuses aliases (`opus` is the newest model, not the judge of the published rows) and checks that the reply came from the requested model. The CLI has no `temperature`, so Martian's `temperature=0.0` is not applied: say so wherever these numbers appear.

## Commands

```bash
# $0 — size gate + cost band
bun run scripts/martian-cal.ts plan              # default: 3-PR pilot
bun run scripts/martian-cal.ts plan --all        # ten
bun run scripts/martian-cal.ts plan --only 11059,7232

# $0 — fetch SHAs, dry-run CLI
bun run scripts/martian-cal.ts check --all

# LIVE — serial reviews. Skips dirs with findings.json
bun run scripts/martian-cal.ts run --all
bun run scripts/martian-cal.ts run --only 10600,10967

# $0 — juxtapose findings vs goldens. NOT precision/recall
bun run scripts/martian-cal.ts score --all

# LIVE — Surface A. Martian JUDGE_PROMPT, Claude Code CLI, sonnet, tools:[]
bun run scripts/martian-judge.ts
bun run scripts/martian-judge.ts --runs ~/Desktop/martian-cal/runs
```

Default `plan|check|run|score` is the 3-PR pilot (`14943,8330,8087`). `--all` is the ten.

After `run`, each dir must contain `findings.json` + `martian-review.json` (adapter). Then judge.

## Two scoring surfaces

Do not collapse them.

**Surface A — goldens (vendor-comparable shape).** LLM: “same underlying issue?” Semantic, not path±25. Our implementation: `scripts/martian-judge.ts`. Prompt is Martian’s; gateway is Claude Code CLI `sonnet` `tools:[]`, **not** `MARTIAN_API_KEY` / their Opus 4.5 tables. Label both. Sibling findings at the same `path:line` are not extra FPs (mechanical analogue of their step 2.5).

Profiles (Martian): Strict = bug/security/concurrency/data/api · Core = Strict + perf/test_gap/doc_defect · All = + style/speculative. Our script scores All. Report High+Critical recall from the gold-side categories even when quoting All P/R.

**Surface B — stored vendor reviews.** `offline/results/benchmark_data.json` in [withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark). Bucket like `src/compare.ts` (location-only, path + line ±25) unless a **labelled** semantic pass is added. Not built yet. Always say ran/not.

Injecting `tool: "pr-hero"` into a **copy** of `benchmark_data.json` and running *their* `step3_judge_comments` is optional and needs their API key. Do not mutate the upstream file.

## Cost bands (order of magnitude)

| Slice | Band |
|---|---|
| Cal.com 10, 1 pipeline | ~$40–45 reviews + ~$1 judge (measured 2026-08-19: $42.43 + $0.89) |
| Cal.com 10 × 2 methodologies | ~$80–90 |
| 50 PRs × 1 pipeline | ~$150–200 — milestone only |

`plan` before `run`. Size gate still applies; record skips, do not silently drop them from the denominator.

## Clone / SHA notes

```bash
git clone --filter=blob:none https://github.com/calcom/cal.com.git ~/Desktop/martian-cal/cal.com
# SHAs are in docs/benchmarks/martian-cal-cases.json — do not guess
git -C ~/Desktop/martian-cal/cal.com fetch --filter=blob:none origin <baseSha> <headSha>
```

Harness checks out `headSha` detached + `--force` per PR. Do not leave the clone on a dirty worktree you care about.

## Done checklist

- [ ] One variable named
- [ ] `findings.json` + `martian-review.json` per PR
- [ ] Surface A artifact (`martian-judge.json`) with gateway + model labelled
- [ ] Surface B named ran or not
- [ ] Ledger in `docs/benchmarks/martian-bench.md` with cost
- [ ] High+Critical recall reported
- [ ] Compared to corpus.md baseline when this is a new arm
- [ ] Engram `topic_key: eval/martian-code-review-bench`
