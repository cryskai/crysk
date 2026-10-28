---
name: pr-hero-ci-setup
description: "Trigger: setup CI, add pr-hero to CI, GitHub Actions review, OpenCode, OPENCODE_AUTH_JSON, CRYSK_ROUTING, DeepSeek, admission policy, configure CI workflow, retrigger, force review, skipped review, /crysk review, /crysk override, pr-hero-force. Scaffolds the one workflow, secrets, routing, and admission config."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "3.2"
---

## Activation Contract

Load when the user asks to:
- Add `pr-hero` to GitHub Actions CI, scaffold `.github/workflows/pr-hero.yml`, or configure secrets. No local install is needed: the workflow file is the whole install.
- Configure **OpenCode** in CI (`OPENCODE_AUTH_JSON`, `CRYSK_ROUTING`, DeepSeek, mixed Claude+OpenCode).
- Tune CI spend / re-review / admission policy.
- Retrigger a skipped CI review (size, admission, or budget) without running the review locally.

## Hard Rules

- **Zero secret leakage:** NEVER print, `cat`, commit, or log API keys, tokens, or `OPENCODE_AUTH_JSON`. Reference `${{ secrets.* }}` names only. Inspect `auth.json` **keys and `type` only**.
- **No per-provider GitHub secrets:** Do not create `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`. One secret `OPENCODE_AUTH_JSON` (whole store or a CI-only subset) + public variable `CRYSK_ROUTING`. Cap 48 KB each.
- **No install needed:** run every pr-hero command as `npx -y pr-hero <command>` (Node is enough; the package brings its own Bun). A global `pr-hero` on PATH is the same command. CI itself needs no local CLI at all: the workflow runs the action. `npx -y pr-hero skills install` installs the pr-hero, triage, and CI-setup skills into every detected coding agent, with no TTY and no MCP or launchd registration (neither is needed for the CI loop, and npx's temporary cache refuses them).
- **Deterministic scaffolding:** Run `npx -y pr-hero setup --ci` (or `npx -y pr-hero ci init`) with the interview's flags. It writes the one workflow file, `.github/workflows/pr-hero.yml`. Do not fabricate it from memory. Fallback: copy `assets/workflow.yml`. Never scaffold a `pr-hero-force.yml`; it is retired.
- **`fetch-depth: 0` is mandatory** on `actions/checkout@v4`.
- **Gate mode:** the `pr-hero` commit status is the required check. The scaffold writes `mode: gate` explicitly: blocking findings, a size or budget skip, and a crash set it red. `mode: advisory` keeps it green for a finished review. The job's exit code stays `0` on findings either way, so do not gate on the job.
- **Required permissions:** `contents: read`, `pull-requests: write`, `issues: write`, `statuses: write`, **`checks: write`**, **`actions: read`** (the admission gate lists past runs; a private repo 403s without it). Template in `assets/workflow.yml` includes all six.
- **Retrigger is a PR comment: `gh pr comment <n> --body "/crysk review"`.** GitHub Actions runs the review on the runner with `--force`. The comment must be exactly `/crysk review` (or `/crysk review --full`), and its author needs write access; the action refuses anyone else. Do not run `pr-hero review --force` locally when the review should happen in CI. `gh run rerun` on a skipped run re-evaluates the gates and does not force. In this repo a comment run checks out the PR head commit before `uses: ./`, so it runs the PR's own engine, not the default branch's.
- **`/crysk recheck` re-reviews the head and asks the CI adjudicator to rule on pending dismissals.** It is `/crysk review` plus `--adjudicate`, with the same permission check and reaction; refused on fork pull requests. See `docs/github-actions.md` ("Rechecking a dismissal").
- **`/crysk stop` stops automatic reviews on the PR.** Post it before a push that should not be reviewed: CI admission skips every later automatic review, carrying the last verdict, until a `/crysk review` or `/crysk recheck` comment. It counts only from a user with write access (checked at admission), starts no run, and never turns the gate green. See `docs/github-actions.md` ("Stopping automatic reviews").
- **`--force` never widens discovery; `--full` does.** When a prior review of the same head was hollow or wrong and re-runs report "No changes to discover", comment `/crysk review --full`. It passes `--full`, which re-discovers the whole PR range.
- **When the comment trigger takes effect:** GitHub reads a comment-triggered workflow from the **default branch** (for this repo, `main`, not `dev`), so `/crysk review` works only once `pr-hero.yml` with its `issue_comment` trigger is merged there; a user repo also needs an action release that handles the comment, through the `@v0` it pins.
- **`/crysk` vs `/pr-hero`:** the commands are `/crysk review`, `/crysk recheck`, `/crysk override` and `/crysk stop`; the action still accepts `/pr-hero …` for one version. A `pr-hero.yml` scaffolded before the rename filters only `/pr-hero …`, so a `/crysk …` comment starts nothing there: re-run `pr-hero ci init --force` to accept both. The same rename moved `PRHERO_ROUTING` to `CRYSK_ROUTING` (the new workflow reads it first, then the old name).
- **Legacy scaffolds:** a `pr-hero.yml` scaffolded before the comment trigger has no `issue_comment` listener, so a comment does nothing. There, use `gh workflow run pr-hero-force.yml -f pr=<n>` (add `-f full=true` to re-discover), or re-scaffold with `pr-hero ci init --force`, which leaves `pr-hero-force.yml` in place.
- **Minimum action version:** this workflow listens to comments, and only an action release that ships the comment handling checks the command and the commenter's write access. An older action reviews on ANY comment starting with `/crysk review`, from anyone who can comment. Never pair this workflow with an older action; a pinned tag or sha must be at or after that release.
- **Older heads (this repo):** a comment run loads the PR head's own `action.yml`, so on a head from before the comment handling it reviews without reading the comment (no force, no `--full`); merge or rebase the PR onto a base that has it first.
- **Trust (this repo):** a comment run runs the PR head's code, including its `bun install`, with the workflow's secrets, so write access is checked twice: by the workflow's pre-checkout step (fail closed, before any head code runs) and again by the head's `action.yml`.
- **Admission config is repo-level:** Write `.prhero/config.json` on the default branch. That file **rejects** `routing`. Person-layer only (`$HOME/.prhero/config.json` on the runner, from `vars.CRYSK_ROUTING`).
- **`.prheroignore` is read from the base ref, not the PR branch, in CI.**
- **OpenCode is DATA:** quoted `routing: "${{ vars.CRYSK_ROUTING || vars.PRHERO_ROUTING }}"` + `opencode-auth: ${{ secrets.OPENCODE_AUTH_JSON }}`. Unset both = Claude CI. Never a per-provider Action input. Never echo the auth blob.
- **OpenCode procedure:** when OpenCode or mixed backends are in scope, follow `references/opencode-ci.md` before setting GitHub DATA (strip personal OAuth, `modelSnapshot`, logical vs role).

## Decision Gates

| Condition | Action |
|---|---|
| `gh auth status` succeeds | Offer `gh secret set` / `gh variable set` |
| `gh` missing/unauthenticated | Link to repo Settings → Secrets and variables → Actions (Variables tab for routing) |
| Credential: Claude | **`CLAUDE_CODE_OAUTH_TOKEN`** — subscription (`claude setup-token` only, NOT keychain). **`ANTHROPIC_API_KEY`** — pay-as-you-go. |
| Credential: OpenCode | Read `references/opencode-ci.md`. Secret + variable. Any one of the three secrets counts as a credential; with none, the run fails red with the `gh secret set` commands. |
| openai API key in CI | **Refuse.** openai → ChatGPT OAuth mapping; `type:"api"` is refused. Use a non-openai API token (tested: deepseek). |
| Hunters OpenCode / refuter Claude | DATA can: map only `sonnet`. Routing is by logical model, not role; hunters declare `sonnet`, refuter `opus`, summarizer `haiku`. The unmapped `opus` refuter falls through to the Claude CLI (current behavior), so keep a Claude secret. OpenCode-only (no Claude secret): use a `default` route or map all three aliases, never `sonnet` alone (`references/opencode-ci.md`). |
| Mixed OpenCode providers in one run | Out of scope (#195). One OpenCode provider per run. Mixed `claude-code` + one OpenCode provider is legal. |
| OpenCode CLI pin | Action installs **1.18.30** iff `opencode-auth != ''` OR routing contains `opencode`. Never `latest`. |
| Fork PRs | Their pushes skip (no secrets). A user with write access comments `/crysk review`, and that run (base context, with secrets) reviews the fork head. Review `if` never reads `secrets`; the action checks credentials (Anthropic **or** Claude OAuth **or** `OPENCODE_AUTH_JSON`). |
| Spend gates | Defaults: `budget-usd: 10.00` on metered routes (Anthropic key **or** OpenCode auth file), `max-changed-lines: 4000` and `max-changed-files: 50` on metered routes only; a Claude subscription route has no size limit unless the workflow or `.prhero/config.json` sets one. Claude-only OAuth stays unlimited-subscription unless OpenCode auth is also present. |
| Existing workflow | `setup --ci` skips; ask before `--force` |
| First-time admission | Recommend `ci_admission_observe_only: true` — `references/ci-admission.md` |
| User wants max CI spend | Lower `ci_max_attempts` and/or raise `ci_rereview_min_score` |
| Custom bot posts findings | Add login to `ci_trusted_actors` |
| CI skipped (size, admission, or budget) | `gh pr comment <n> --body "/crysk review"`. The review runs on GitHub Actions. Do not run `pr-hero review --force` locally for this. Legacy scaffold (no `issue_comment` trigger): `gh workflow run pr-hero-force.yml -f pr=<n>`. |
| Gate is red with blocking findings the team accepts | `gh pr comment <n> --body "/crysk override"` (write access, same-repo PRs only, valid for that head only; a same-head `/crysk review` keeps it red). |
| Prior review of the same head was hollow or wrong; re-runs say "No changes to discover" | `gh pr comment <n> --body "/crysk review --full"`. A plain `/crysk review` keeps the narrowed discovery. |
| Gate red: `pr-hero: review partial (N of M hunters failed, set abc123) — /pr-hero review retries it` | Some hunters failed and nothing blocking was found. `gh pr comment <n> --body "/crysk review"`. If the same hunters fail every run, fix their route (model, credential) or override. |
| Gate red: `pr-hero: review partial again (N of M hunters failed, set abc123) — fix the failing route or /pr-hero override` | The previous review of this head was partial with the same hunters failing, so a retry already failed the same way. Fix the failing hunter's route (model, credential), or `gh pr comment <n> --body "/crysk override"`. `pr-hero status` answers `override-or-fix`. |
| Gate error: `PRH-CANCELLED: not reviewed — /pr-hero review reviews this head` | The review run was cancelled (a newer push, or by hand). Comment `/crysk review` to review the head. |
| `PRH-MODEL-UNAVAILABLE` (lead "Provider <name>:") | Every hunter's route names a model the provider does not serve. Fix the model id in `CRYSK_ROUTING` (check `opencode models`). |
| `PRH-CRED-UNUSABLE` ("The route <provider>/<model> has no usable credential record") | `OPENCODE_AUTH_JSON` has no record for that provider. Add it to the blob, or route that model elsewhere. |
| Blocking findings answered `dismissed`, gate still red | `gh pr comment <n> --body "/crysk recheck"`: the CI adjudicator rules on each dismissal (at most 5 per run). On `upheld`, comment `/crysk review`: that next review stops counting it. `deferred` / `misclassified` never clear the gate. |
| Gate error: `PRH-GOTCHAS-MISSING` ("`.prhero/gotchas.md` is missing or still the scaffold") | Run `npx -y pr-hero init`, write real gotchas, delete the `human-attention-required` marker line, commit `.prhero/` to the default branch, then comment `/crysk review`. |
| Gate error: `PRH-HUNTERS-FAILED` (every hunter failed) | Check the route and credential first (the `PRH-CRED-UNUSABLE` and `PRH-MODEL-UNAVAILABLE` rows). Free OpenCode models fail intermittently: comment `/crysk review` to retry. |
| A `/crysk review` comment did nothing | The workflow is not on the default branch yet, the comment is not exact, the author lacks write access, or the workflow predates the comment trigger (re-scaffold with `--force`). |

## Review Settings Interview (ask the human, never choose for them)

Before step 4, ask the human these questions in their language. Use the native question UI when available (one grouped interaction is fine). Do not pick an answer for them, and do not skip a question because a default exists: the point is that they know these settings exist.

1. **Re-review level** (how pr-hero reviews new pushes on an open PR):
   - **Minimal**: one automatic review per PR; later pushes only on a `/crysk review` comment.
   - **Balanced (recommended)**: re-review when the push touches risky files or the previous pass found enough (score >= 4); at most 2 automatic passes.
   - **Thorough**: review every push, up to 4 automatic passes. Most coverage, most cost.
   - **Manual**: nothing automatic after the first review; every re-review starts with `/crysk review`.
2. **Gate or advisory**: gate turns the `crysk` check red on blocking findings (require it in branch protection to block merges); advisory keeps it green.
3. **How CI pays**:
   - **Claude subscription** (`CLAUDE_CODE_OAUTH_TOKEN`): do not ask for a budget. Tell them no `budget-usd` is written: a subscription review spends quota, not dollars, and CI applies no ceiling while the repo has neither an `ANTHROPIC_API_KEY` nor an `OPENCODE_AUTH_JSON` secret (either one makes CI metered and brings back the $10 ceiling, so a subscription mixed with OpenCode is the API-key answer).
   - **API key** (`ANTHROPIC_API_KEY` or an OpenCode provider): ask for the spend ceiling per review in USD (default 10, `0` = none).
4. **Changed-lines threshold**: a PR with more changed lines is skipped, not reviewed. Ask on any billing (default 4000, `0` = no limit, only if they say so): unlike the budget it matters on a subscription too, where an unset threshold means no limit at all.
5. **Advanced settings**: name them, then ask whether to review them now. Each keeps a working default if skipped:
   - score weights: blocking 2, advisory 1 (integers >= 1; `ci_blocking_weight`, `ci_advisory_weight`), and the score floor 4 (`ci_rereview_min_score`); used only by the risk-aware and thresholded policies;
   - observe only (`ci_admission_observe_only`): log what the rules would skip, but review every push; good for one PR cycle;
   - trusted actors (`ci_trusted_actors`): extra GitHub logins whose pr-hero markers count;
   - changed-files limit (`max_changed_files`): a PR touching more files is skipped; unset = none on a subscription, 50 on an API key;
   - exclusions: patterns in `.prheroignore` (gitignore syntax) the review never reads.

**On a re-run** (`.prhero/config.json` already has re-review keys, or the workflow already exists), first show the human the current values (`npx -y pr-hero config`) and offer **Keep current settings** for the level and for the line threshold. When they keep them, omit `--level` / `--max-changed-lines`: passing a flag overwrites that group, including a tuned `max_verification_steps`.

Then pass the answers to the scaffold as flags, never as hand-written YAML:

```bash
npx -y pr-hero setup --ci --level <minimal|balanced|thorough|manual> --ci-mode <gate|advisory> --billing <subscription|api> --max-changed-lines <n> [--budget-usd <n>]
```

It writes the workflow, merges the level's keys into `.prhero/config.json` (keeping other keys), and prints a summary of every setting. **Never run it without these flags**: with none it applies balanced and gate, and its summary says nobody chose them. Write any advanced answers into `.prhero/config.json` (and `.prheroignore`) afterwards. The summary `setup --ci` printed predates those edits, so when there were any, show the human the effective settings from `npx -y pr-hero config` instead. Otherwise show the printed summary, including any `Changed` and `Kept existing` lines: on a re-run (for example `--force` to refresh an old workflow) only the groups a flag names are overwritten, and keys nobody chose stay as the file had them; the workflow keeps its old `mode` and `budget-usd` unless `--ci-mode` or `--billing` / `--budget-usd` is passed. In a terminal, every question defaults to the repository's current value. Details: `references/ci-admission.md`.

## Execution Steps

1. **Inspect repo:** `git rev-parse --is-inside-work-tree`, `git remote get-url origin`, `gh auth status`.
2. **Credential path:** Claude-only → skip OpenCode. OpenCode or mix → **read `references/opencode-ci.md`** and execute it (metadata inspect, CI-only blob, secret, routing with `modelSnapshot`).
3. **Claude secret (if used):** `gh secret set CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (secure input, never print).
4. **Workflow:** run the interview above, then `npx -y pr-hero setup --ci` with its flags. It writes `.github/workflows/pr-hero.yml` and the level keys in `.prhero/config.json`. Confirm `checks: write` and `actions: read`, both `pull_request` and `issue_comment` triggers, quoted `routing` / `opencode-auth`. `--force` if an old template lacks them (an old `credentials` job or a missing `issue_comment` trigger means it predates the single workflow).
5. **Gotchas (required before the first review):** if `.prhero/` is missing on the default branch, run `npx -y pr-hero init` in the clone. The agent writes the gotchas from the repository it has in context, not from the template: the deliberate oddity that looks like a bug, the invariant enforced outside the diff, the ownership rule a newcomer would break. Each line is injected verbatim into every hunter's prompt. Delete the `human-attention-required` marker line (pr-hero refuses to review while it is there), then commit `.prhero/` to the default branch. Without it the run fails `PRH-GOTCHAS-MISSING`.
6. **Require the check:** in branch protection, require the `crysk` status check (the gate), not the `review` job. The legacy `pr-hero` status is still posted for one version, so a repository that already requires it keeps working; move the rule to `crysk`. A private repository on GitHub Free cannot require status checks (HTTP 403): report that the gate is advisory there. With `gh`, and only after asking the human: read the current protection first (`gh api repos/<o>/<r>/branches/<default>/protection`), because the PUT replaces all of it; then `gh api -X PUT repos/<o>/<r>/branches/<default>/protection` with `required_status_checks` contexts `["crysk"]`.
7. **Advanced settings:** write the answers from interview question 5 into `.prhero/config.json` (and `.prheroignore`); commit both to the default branch. **No `routing` key.** `npx -y pr-hero config` to verify.
8. **Verify:** `npx -y pr-hero doctor`. `git status`. Confirm no openai `type:"api"` blob, no echoed auth, `modelSnapshot` matches `opencode models` when OpenCode is on.
9. **Deploy:** Offer commit. Open a **same-repo** test PR (forks skip).

## Output Contract

Report:
- Secret status (set or manual link). Names only: which of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `OPENCODE_AUTH_JSON` exist. Never values.
- OpenCode (if in scope): `OPENCODE_AUTH_JSON` set; blob providers **names + type only**; whether the blob was stripped to one CI provider; `CRYSK_ROUTING` JSON (no credentials); `modelSnapshot` vs `opencode models`.
- Workflow path (`pr-hero.yml`) and whether `checks: write`, `actions: read`, the `issue_comment` trigger, and quoted `routing` / `opencode-auth` are present.
- The review settings summary `setup --ci` printed (level, gate, budget, advanced settings), and which ones the human chose. Confirm repo `.prhero/config.json` has no `routing` key.
- `npx -y pr-hero doctor` / `npx -y pr-hero config` outcome.
- Whether `.prhero/` exists on the default branch with real gotchas (no `human-attention-required` marker line).
- Whether `pr-hero` is a required check, or that the repository cannot require one (private repository on GitHub Free).
- Next steps: merge the workflow to the default branch (the comment trigger needs it there), open a same-repo test PR, when to turn off observe-only. If CI skipped, the override is `gh pr comment <n> --body "/crysk review"`.

## References

- `assets/workflow.yml` — the one review workflow (`pull_request` + `issue_comment` for `/crysk review`).
- `assets/admission-config.example.json` — starter `.prhero/config.json`.
- `references/ci-admission.md` — admission keys, modes, rollout, ledger.
- `references/opencode-ci.md` — OpenCode secret/variable procedure, routing, pin, openai vs deepseek.
- `docs/github-actions.md` — full CI integration docs.
