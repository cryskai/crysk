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
| **Manual required** | Budget exhausted or `manual_only` — comment `/pr-hero review` on the PR |

Skipped and manual-required posts include admission metadata in the step summary.

## Durable ledger

- Check Runs named `pr-hero/ci-admission` on the reviewed commit.
- Requires workflow permission **`checks: write`** (template includes it).
- Requires **`actions: read`** too: the gate lists this workflow's past runs, which a private repo refuses without it (HTTP 403).
- PR comments are presentation. The ledger counts a run that reached the provider (completed, failed, or still provider-started) and an admission skip. It does not count a run that yielded to an in-flight review, a size or budget gate skip, or a cancelled row (#164). A workflow run that concluded success or failure is dropped from the attempt count only when every ledger row on its head is a gate skip or a yield, because both are written before any provider spend. A cancelled row is not that proof: the signal handler that writes it can run after the provider started, so a run killed by `timeout-minutes` (concluded `failure`) still counts. A run whose row is still `reserved` stays counted too, because the provider-started write is best-effort and the run may have spent anyway.

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

Comment `/pr-hero review` on the pull request. GitHub Actions runs the review with `--force`. Posting the comment does not review anything on the machine that sends it:

```bash
gh pr comment <n> --body "/pr-hero review"
```

`/pr-hero review --full` also re-discovers the whole range. The comment must be exactly one of those two, and it works only once `pr-hero.yml` (with its `issue_comment` trigger) is on the default branch.

It bypasses the size gate, the admission rules (same commit, `once_per_pr`, score, low-risk delta, exhausted attempts, `manual_only`), and the budget ceiling. It does not reset the ledger.

Who can force: anyone with write access to the repository; a comment from anyone else is refused. A fork PR is reviewed only this way, since its own pushes are skipped. `gh run rerun` on a skipped run re-evaluates the gates and does not force.

A workflow scaffolded before the comment trigger has no `issue_comment` listener. There, use the legacy `gh workflow run pr-hero-force.yml -f pr=<n>`, or re-scaffold with `pr-hero ci init --force`.

A local agent posts the comment. It does not run `pr-hero review --pr <n> --force` when the review should happen in CI.
