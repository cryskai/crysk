# Crysk in CI: day-to-day operations

Read this when a repository already runs Crysk and something needs handling. To answer findings on a pull request, use
the `crysk-loop` skill. Everything here that sends a comment needs `gh`, authenticated with write access.

## Who decides what

- **Retrying a failed review, or asking for one that never ran:** you may post `/crysk review`.
- **Forcing a review past a size or cost limit:** ask the user first. It bypasses the limit and spends money.
- **`/crysk override`:** never post it. Tell a maintainer what it would accept, and let them decide.
- **`/crysk stop`:** only when the gate is already green. On a red gate, tell the user: a stop can turn answered findings
  green with no review having checked the fixes.

## Commands

Post them with `gh pr comment <n> --body "<command>"`. The first line must be exactly the command, and the author needs
write access. `/crysk` is the only spelling.

| Comment | Effect |
|---|---|
| `/crysk review` | A forced review of the head, past the size, admission and cost limits. |
| `/crysk review --full` | The same, re-discovering the whole pull request. Use it when an earlier review of this head was hollow and re-runs say "No changes to discover". |
| `/crysk recheck` | `/crysk review` plus the CI adjudicator ruling on pending dismissals, at most 5 per run. Refused on forks. |
| `/crysk stop` | Automatic reviews are skipped from the next push until a `/crysk review` or `/crysk recheck`. Starts no run. |
| `/crysk override` | A maintainer turns the gate green on that head with no review. Same-repository pull requests only. |

- Do not run `crysk review --force` locally when the review belongs in CI. `gh run rerun` on a skipped run re-evaluates the
  limits and does not force.
- **Scaffolded workflows:** GitHub reads a comment-triggered workflow from the default branch, so commands work only once
  the workflow is merged there. A fork's pushes are skipped; a `/crysk review` from someone with write access reviews it.
- **Platform repositories:** the workflow only listens to `workflow_dispatch`, and the platform reads the comments. It has
  no comment trigger on purpose, and the same commands work.
- **Action version:** only an action release with the comment handling checks the command and the commenter's write access. An older one reviews on any comment starting with `/crysk review`, from anyone who can comment, so a pinned tag or SHA must be at or after that release.
- **A command that did nothing:** the workflow is not on the default branch, the first line is not exact, the author lacks
  write access, or the workflow predates the comment trigger or the rename (a `pr-hero.yml` that filters `/pr-hero`).
  Refresh an old workflow with `setup --ci --force`, after asking.

## The gate

The required check is the `crysk` commit status, not the `review` job, whose exit code stays `0` on findings. A branch rule
that still requires the old `pr-hero` status must move to `crysk`.

| What you see | What to do |
|---|---|
| A review was skipped for size or cost | Ask the user. Then `/crysk review`, a smaller pull request, or a changed limit: `max_changed_lines` for size, the dashboard (Review > Limits) for cost. |
| A push was skipped by a review rule | The last verdict carries. Answered blocking findings can turn it green, marked `fixes unverified`. See `ci-admission.md`. |
| `crysk: waiting for a manual review` | The attempt budget is used up, or the policy is manual. A person chooses `/crysk review` or `/crysk override`. |
| `crysk: review partial` | Some hunters failed and nothing blocking was found. `/crysk review` retries it. |
| `crysk: review partial again` | The retry failed the same way. Fix those hunters' model or credential, or tell a maintainer. |
| `CRYSK-CANCELLED` | The run was cancelled. `/crysk review` reviews the head. |
| Blocking findings answered `dismissed`, gate still red | `/crysk recheck`. After `upheld`, `/crysk review` stops counting them. `deferred` and `misclassified` never clear the gate. |
| Blocking findings the team accepts | Tell a maintainer: only `/crysk override` accepts them. |

## Error codes

| Code | Fix |
|---|---|
| `CRYSK-INPUT-REMOVED` | The workflow passes a removed input (`claude-token`, `anthropic-api-key`, `opencode-auth`, `routing`). Refresh it with `setup --ci --force`, after asking, then set the `CRYSK_*` secrets and variables it prints. |
| `CRYSK-MODEL-UNAVAILABLE` | A route names a model the provider does not serve. Fix the id in `CRYSK_MODELS` (`opencode models <provider>`). |
| `CRYSK-CRED-UNUSABLE` | No key reached the run for that provider. Set `CRYSK_OPENCODE_<P>_API_KEY`, add its token to `CRYSK_OPENCODE_PROVIDERS`, or move the model. |
| `CRYSK-CONFIG-INVALID` naming `models` or `credentials` | The variable is not valid JSON or breaks a rule; the step's log names the entry. |
| `CRYSK-GOTCHAS-MISSING` | `REVIEW.md` or `.crysk/gotchas.md` is empty or still the scaffold. Write real facts and delete the `human-attention-required` line, or delete the file. Then `/crysk review`. |
| `CRYSK-HUNTERS-FAILED` | Every hunter failed. Check route and credential first. Free OpenCode models fail intermittently, so one `/crysk review` retry is reasonable. |

Full list: [error codes](https://crysk.dev/docs/reference/error-codes/) and
[troubleshooting](https://crysk.dev/docs/troubleshooting/).

## Reducing noise

- **Too many comments:** `post_min_severity: "blocking"` in `.crysk/config.json` posts only blocking findings. `"warning"`
  hides advisory suggestions. The gate does not change.
- **Blocking findings that are real but improbable:** offer `materiality_gate: true`. See `ci-admission.md` for its cost and
  limits.
- **`materiality_gate` on, nothing demoted:** read the `materiality` record in the run's `pipeline.json` (in the
  `crysk-run-*` artifact). `unsupported_route`: `models.judge` lists none of the profile's judge models. `ceiling`: no room
  was left for a judge wave. `ran` with `judged: 0`: nothing was eligible. `skipped` on a re-review with no new commits is
  expected. `skipped` elsewhere: the key did not reach the run, so check that the config is merged into the branch pull
  requests target, and that a global config does not set it `false`.

## Spending less

Lower `ci_max_attempts` or raise `ci_rereview_min_score`. For a dollar limit, use the platform dashboard (Review > Limits),
which applies to runs billing an API key. A Claude subscription run is never skipped for cost.
