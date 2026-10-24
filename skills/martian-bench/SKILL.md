---
name: martian-bench
description: "Trigger: martian-bench, Martian, code-review-bench, n-vs-n, Cal.com eval, compare Greptile CodeRabbit. Isolated Martian offline scoring vs goldens and vendors."
license: MIT
metadata:
  author: pr-hero
  version: "1.0"
  # Lab-only (needs the private ../deep-review lab): hidden from skills.sh / `npx skills add`.
  internal: true
---

## Activation Contract

Load when scoring, running, or comparing a pr-hero methodology on Martian’s Code Review Bench — Cal.com evals, n-vs-n vs Greptile/CodeRabbit/Bugbot, Surface A/B, or “how did we do” on that corpus.

Do not load for musive H2H alone (`src/compare.ts`), M6 scout A/B on musive, or a product review of our own PRs.

## Hard Rules

- Never `pr-hero review --pr` on the original public PR. Local `--repo --base --head --two-dot --yes` only. `--pr` posts a commit status on other people’s merged heads.
- Never feed goldens, vendor reviews, or GitHub comments to hunters. Gold is judge-only. Gotchas stay `docs/benchmarks/martian-cal-gotchas.md` (thin, no gold).
- `--out` and `--gotchas` live **outside** the clone. Do not `codegraph init` on Cal.com.
- One variable per arm. Name arm id + prompt-set sha. Cal.com 10 `*-hunters` dirs are the baseline — do not overwrite them for a new arm.
- Do not headline All-profile F1. Report High+Critical recall. Martian F1 is not a launch gate. THE PIVOT holds.
- Do not skip Cal.com for Keycloak/Sentry/Grafana/Discourse. Do not run the 50 without Juanma authorising that spend.
- Job is not done until Surface A is written **and** Surface B is named ran or not.
- Do not sit our Claude-CLI-sonnet judge next to Martian’s published Opus 4.5 vendor rows as the same judge.
- Read `references/corpus.md` before any spend. Lab `../deep-review/dataset/test.jsonl` stays sealed.

## Decision Gates

| Ask | Do |
|---|---|
| How did we do / read scores | Corpus + `martian-judge.json`. **$0.** No re-run |
| Run / remaining / `--all` Cal.com | `plan` → `check` → `run` → judge → ledger |
| New methodology (scout, prompt, model) | **New** run-dir suffix, one variable, same 10, vs `hunters` baseline |
| Surface B | Location-only vs stored reviews; label if a semantic pass is added |
| 50 PRs / other four repos | Refuse until Cal.com + explicit authorisation |
| Fork 50 + GitHub App | Refuse |
| Refuter prompt edit | `refuter-probe` first, then fixture-eval, then Martian |

## Execution Steps

1. Load `references/corpus.md` and `docs/benchmarks/martian-bench.md`. Name the baseline arm and whether this spend is new.
2. Confirm authorised slice, one variable, cost band: `bun run scripts/martian-cal.ts plan`.
3. `check` then `run`. Isolation is the engine’s. Resume requires the frozen schedule/identity and attributable delivered-attempt proof; existing files alone never qualify. Preserve unqualified directories under `incomplete-attempts/`. Unknown spend remains unknown.
4. Surface A: `bun run scripts/martian-judge.ts`. Label gateway + model. Sibling same `path:line` are not extra FPs.
5. Surface B only if authorised. Always **say** whether it ran.
6. Ledger in `docs/benchmarks/martian-bench.md`. Quote High+Critical recall; All F1 is secondary.
7. Triangulate via corpus.md. If Martian and musive disagree: musive + human wins for product; Martian wins for vendor n-vs-n. Do not average.

## Output Contract

Return: arm id + prompt-set sha + scout on/off + judge gateway/model; cost and wall; per-PR tp/fp/fn and High+Critical recall; Surface B ran or not; delta vs Cal.com 10 `hunters` if this is a new arm; which corpus evals were consulted.

## References

- `references/flow.md` — clone, flags, commands, resume, cost
- `references/corpus.md` — baseline scores + other evals to triangulate
- `../../docs/benchmarks/martian-bench.md` — protocol, isolation, two surfaces
- `../../scripts/martian-cal.ts` / `../../scripts/martian-judge.ts`
- `../../src/martian-adapter.ts` / `../../test/martian-adapter.test.ts`
