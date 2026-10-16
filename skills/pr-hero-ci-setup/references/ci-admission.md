# CI review admission — setup reference

Read this when configuring `.prhero/config.json` during CI setup. Full operator docs:
`docs/github-actions.md` (section **CI review admission**).

## Where config lives

- **Repository** `.prhero/config.json` on the default branch — authoritative.
- NOT in the PR branch worktree. Authors cannot change admission to suppress their own PR.
- Verify with `pr-hero config` after editing.

## Keys and defaults

| Key | Default | Meaning |
|---|---|---|
| `ci_review_policy` | `risk_aware` | When to spend on `synchronize` pushes |
| `ci_max_attempts` | `2` | Automatic attempt budget per PR |
| `ci_rereview_min_score` | `4` | Prior score floor for re-review |
| `ci_blocking_weight` | `2` | Score weight per blocking-tier finding |
| `ci_advisory_weight` | `1` | Score weight per advisory-tier finding |
| `ci_trusted_actors` | `[]` | Extra GitHub logins for authoritative markers (+ `GITHUB_ACTOR`) |
| `ci_admission_observe_only` | `false` | Log would-be skip/manual decisions but always run |

`ci_max_reviews` is legacy — use `ci_max_attempts` (same fallback).

**Score:** `blocking × ci_blocking_weight + advisory × ci_advisory_weight`

## Policy modes

| Mode | Use when |
|---|---|
| `risk_aware` | Default — re-review on risky delta OR score ≥ floor |
| `thresholded` | Score-only; ignore path risk classification |
| `once_per_pr` | One automatic review; later pushes reported as not reviewed |
| `every_push` | Review every push (still capped by `ci_max_attempts`) |
| `manual_only` | No automatic re-review; operator override only |

## Outcomes users see

| Outcome | Meaning |
|---|---|
| Review runs | Normal pipeline |
| **Skipped** | Push did not justify spend (same head, low score, docs-only delta, etc.) — **not** “clean” |
| **Manual required** | Budget exhausted or `manual_only` — `gh workflow run pr-hero-force.yml -f pr=<n>` |

Skipped and manual-required posts include admission metadata in the step summary.

## Durable ledger

- Check Runs named `pr-hero/ci-admission` on the reviewed commit.
- Requires workflow permission **`checks: write`** (template includes it).
- Requires **`actions: read`** too: the gate lists this workflow's past runs, which a private repo refuses without it (HTTP 403).
- PR comments are presentation. The ledger counts a run that reached the provider (completed, failed, or still provider-started) and an admission skip. It does not count a cancelled run, a run that yielded to an in-flight review, or a size or budget gate skip, since none of those spend anything. A workflow run whose ledger rows are all of those is dropped from the count; a run whose row is still `reserved` stays counted, because the provider-started write is best-effort and the run may have spent anyway.

## Rollout (recommended)

1. Ship workflow + secrets first.
2. Add `.prhero/config.json` with `"ci_admission_observe_only": true`.
3. Open a test PR; read `::notice::` lines for would-be skip/manual decisions.
4. Set `ci_admission_observe_only` to `false` when behavior matches intent.

## Example config

```json
{
  "ci_review_policy": "risk_aware",
  "ci_max_attempts": 2,
  "ci_rereview_min_score": 4,
  "ci_blocking_weight": 2,
  "ci_advisory_weight": 1,
  "ci_trusted_actors": [],
  "ci_admission_observe_only": true
}
```

## Manual override

Dispatch the force workflow. GitHub Actions runs the review with `--force`. The command itself does not review anything on the machine that sends it:

```bash
gh workflow run pr-hero-force.yml -f pr=<n>
```

It bypasses the size gate, the admission rules (same commit, `once_per_pr`, score, low-risk delta, exhausted attempts, `manual_only`), and the budget ceiling. It does not reset the ledger.

Who can dispatch: anyone with write access to the repository. A fork PR is refused. `gh run rerun` on the automatic workflow re-evaluates the gates and does not force.

A local agent uses this command. It does not run `pr-hero review --pr <n> --force` when the review should happen in CI.
