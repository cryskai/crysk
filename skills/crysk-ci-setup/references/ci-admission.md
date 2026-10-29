# CI review admission — setup reference

Read this when configuring `.crysk/config.json` during CI setup. Full operator docs:
`docs/github-actions.md` (section **CI review admission**).

## Where config lives

- **Repository** `.crysk/config.json` on the default branch — authoritative.
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
| `max_verification_steps` | `8` | Max prior open findings verified per re-review (`0` pauses verification; capped key) |

`ci_max_reviews` is legacy — use `ci_max_attempts` (same fallback).

**Score:** `blocking × ci_blocking_weight + advisory × ci_advisory_weight`

**How a re-review depends on the previous pass:**
- **Whether it runs (admission):** in `risk_aware` and `thresholded` modes, the previous review's finding score (`blocking × 2 + advisory × 1` by default) is compared against `ci_rereview_min_score`, bounded by `ci_max_attempts` total automatic passes per PR.
- **What it does when it runs:** discovery is incremental by default (hunters examine only commits since the last completed review's head SHA; `/crysk review --full` widens to the full PR), and up to `max_verification_steps` verifier steps check whether prior open findings were fixed by the new push.

## Review levels (what setup --ci asks)

`setup --ci` (and `ci init`) asks for a level and always writes its keys. An agent asks the human and passes `--level`, `--ci-mode`, `--billing`, `--max-changed-lines` and `--budget-usd`; a terminal user gets the same questions from the CLI; with neither, `balanced` and `gate` apply and the summary says nobody chose them.

| Level | `ci_review_policy` | `ci_max_attempts` | `ci_rereview_min_score` | `max_verification_steps` |
|---|---|---|---|---|
| `minimal` | `once_per_pr` | 1 | (unset) | 8 |
| `balanced` (default) | `risk_aware` | 2 | 4 | 8 |
| `thorough` | `every_push` | 4 | (unset) | 8 |
| `manual` | `manual_only` | 1 | (unset) | 8 |

Billing: `--billing subscription` writes no `budget-usd` (a subscription spends quota, not dollars, and CI applies no ceiling while the repo has neither `ANTHROPIC_API_KEY` nor `OPENCODE_AUTH_JSON`, either of which makes the route metered; an explicit 0 would warn on every run and outlive a later API key); `--billing api` writes `--budget-usd` or the $10 default. `--budget-usd` alone implies `api`, and `--budget-usd` with `subscription` is refused.

Re-runs: a group (the level's keys, or `max_changed_lines`) is overwritten only when someone chose it this run (a flag or a terminal answer); otherwise it fills the file only if absent, and setup prints `Changed` and `Kept existing` lines. A `--force` refresh keeps the old workflow's `mode` and `budget-usd` unless a flag names them, and in a terminal every question defaults to the current value (a tuned level that matches no preset gets a "Keep current settings" option).

Size threshold: `max_changed_lines` is always written (default 4000, `--max-changed-lines`, `0` = no limit). Unlike the budget it applies on any billing: left unset, a subscription route reviews a PR of any size.

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
| **Manual required** | Budget exhausted or `manual_only` — comment `/crysk review` on the PR |

Skipped and manual-required posts include admission metadata in the step summary.

## Durable ledger

- Check Runs named `pr-hero/ci-admission` on the reviewed commit.
- Requires workflow permission **`checks: write`** (template includes it).
- Requires **`actions: read`** too: the gate lists this workflow's past runs, which a private repo refuses without it (HTTP 403).
- PR comments are presentation. The ledger counts a run that reached the provider (completed, failed, or still provider-started) and an admission skip. It does not count a run that yielded to an in-flight review, a size or budget gate skip, or a cancelled row (#164). A workflow run that concluded success or failure is dropped from the attempt count only when every ledger row on its head is a gate skip or a yield, because both are written before any provider spend. A cancelled row is not that proof: the signal handler that writes it can run after the provider started, so a run killed by `timeout-minutes` (concluded `failure`) still counts. A run whose row is still `reserved` stays counted too, because the provider-started write is best-effort and the run may have spent anyway.

## Rollout (recommended)

1. Ship workflow + secrets first.
2. Add `.crysk/config.json` with `"ci_admission_observe_only": true`.
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

Comment `/crysk review` on the pull request. GitHub Actions runs the review with `--force`. Posting the comment does not review anything on the machine that sends it:

```bash
gh pr comment <n> --body "/crysk review"
```

`/crysk review --full` also re-discovers the whole range. The comment must be exactly one of those two, and it works only once `pr-hero.yml` (with its `issue_comment` trigger) is on the default branch.

It bypasses the size gate, the admission rules (same commit, `once_per_pr`, score, low-risk delta, exhausted attempts, `manual_only`), and the budget ceiling. It does not reset the ledger.

Who can force: anyone with write access to the repository; a comment from anyone else is refused. A fork PR is reviewed only this way, since its own pushes are skipped. `gh run rerun` on a skipped run re-evaluates the gates and does not force.

A workflow scaffolded before the comment trigger has no `issue_comment` listener. There, use the legacy `gh workflow run pr-hero-force.yml -f pr=<n>`, or re-scaffold with `pr-hero ci init --force`.

A local agent posts the comment. It does not run `pr-hero review --pr <n> --force` when the review should happen in CI.

A red gate with blocking findings that the team accepts is unlocked by commenting exactly `/crysk override` on the pull request, not by `/crysk review`. In gate mode a same-head review re-runs the same blocking count and leaves the `failure` in place, so the gate clears only when a pushed fix is verified gone or the override is posted:

```bash
gh pr comment <n> --body "/crysk override"
```

The override sets the `pr-hero` status on that head to `success` with no review, no spend, and no credential, and only a user with write or admin access may post it. Each override is recorded: the status names who acted, and a `<!-- crysk-override` comment names who, which head, and when. It is valid only for the head it names, so a new push or a later `/crysk review` on that head replaces it, and it works only on pull requests from this repository, never on forks.
