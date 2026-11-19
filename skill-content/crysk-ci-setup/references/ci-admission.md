# CI review admission: settings reference

Read this when choosing what goes in `.crysk/config.json`. User docs:
[re-review levels](https://crysk.dev/docs/reviews/review-levels/), [config reference](https://crysk.dev/docs/reference/config/).
Commit the file through a pull request and merge it to the default branch and to any branch pull requests target.
Check the result with `crysk config`.

## Keys

| Key | Default | Meaning |
|---|---|---|
| `ci_review_policy` | `risk_aware` | When a push earns an automatic review |
| `ci_max_attempts` | `2` | Automatic reviews per pull request |
| `ci_rereview_min_score` | `4` | Score floor for a re-review |
| `ci_blocking_weight` / `ci_advisory_weight` | `2` / `1` | Score = blocking × weight + advisory × weight |
| `ci_trusted_actors` | `[]` | Extra logins whose Crysk markers count |
| `ci_admission_observe_only` | `false` | Log what would be skipped, but review every push |
| `max_verification_steps` | `8` | Earlier open findings a re-review verifies (`0` pauses it) |
| `max_changed_lines` / `max_changed_files` | see below | A larger pull request is skipped |
| `post_min_severity` | `warning` from setup | Lowest severity posted |
| `materiality_gate` | off | Judge whether blocking findings matter in normal use |

## Levels (what `setup --ci` writes)

| Level | `ci_review_policy` | `ci_max_attempts` | `ci_rereview_min_score` |
|---|---|---|---|
| `minimal` | `once_per_pr` | 1 | unset |
| `balanced` | `risk_aware` | 2 | 4 |
| `thorough` | `every_push` | 4 | unset |
| `manual` | `manual_only` | 1 | unset |

## Policies

| Policy | Behaviour |
|---|---|
| `risk_aware` | Re-review a risky delta, or when the last score reaches the floor |
| `thresholded` | Score only, ignoring path risk |
| `once_per_pr` | One automatic review; later pushes are not reviewed |
| `every_push` | Every push, still capped by `ci_max_attempts` |
| `manual_only` | Nothing automatic after the first review |

A skipped push is **not** a clean review. It inherits the last verdict. A red whose blocking findings are all answered turns
green marked `fixes unverified`. Under a used-up budget or `manual_only`, that green is held `pending` until `/crysk review`
or `/crysk override`.

## Size limits

Setup always writes `max_changed_lines` (default 4000, `0` for none). When neither the workflow nor the config sets a limit, a
Claude subscription route has none, and a pay-per-token route uses 4000 lines and 50 files.

## Posting floor and materiality

`post_min_severity`: `suggestion` posts everything, `warning` hides advisory suggestions, `blocking` posts only blocking
findings. Hidden findings are counted in the summary. The gate is unchanged, and hidden findings never trigger a re-review.

`materiality_gate: true` sends each blocking finding the safety guard does not protect to an isolated judge, about one call
and 10 seconds per pull request. An immaterial finding is posted as advisory and stops blocking. Security, credential,
permission, sandbox, injection and data-loss findings are never demoted, and any judge failure keeps the finding blocking. It
runs only on its profile's judge models (`claude:sonnet-latest` or `claude:opus-latest`; the `openai` profile adds
`opencode:openai/gpt-6.1-terra`), so the default profile needs a Claude secret. A finding that blocked on an earlier push still
counts on a re-review. A global config can turn the key off.

## Rollout

1. Ship the workflow and secrets.
2. Set `"ci_admission_observe_only": true`.
3. Open a test pull request and read the `::notice::` lines for what would have been skipped.
4. Set it back to `false` when the behaviour matches what you want.

The gate needs the workflow's `checks: write` (its `crysk/ci-admission` check runs are the attempt ledger) and `actions: read`.
