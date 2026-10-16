---
name: pr-hero-ci-setup
description: "Trigger: setup CI, add pr-hero to CI, GitHub Actions review, OpenCode, OPENCODE_AUTH_JSON, PRHERO_ROUTING, DeepSeek, admission policy, configure CI workflow, retrigger, force review, skipped review, /pr-hero review, pr-hero-force. Scaffolds the one workflow, secrets, routing, and admission config."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "3.0"
---

## Activation Contract

Load when the user asks to:
- Add `pr-hero` to GitHub Actions CI, scaffold `.github/workflows/pr-hero.yml`, or configure secrets. No local install is needed: the workflow file is the whole install.
- Configure **OpenCode** in CI (`OPENCODE_AUTH_JSON`, `PRHERO_ROUTING`, DeepSeek, mixed Claude+OpenCode).
- Tune CI spend / re-review / admission policy.
- Retrigger a skipped CI review (size, admission, or budget) without running the review locally.

## Hard Rules

- **Zero secret leakage:** NEVER print, `cat`, commit, or log API keys, tokens, or `OPENCODE_AUTH_JSON`. Reference `${{ secrets.* }}` names only. Inspect `auth.json` **keys and `type` only**.
- **No per-provider GitHub secrets:** Do not create `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`. One secret `OPENCODE_AUTH_JSON` (whole store or a CI-only subset) + public variable `PRHERO_ROUTING`. Cap 48 KB each.
- **Deterministic scaffolding:** Run `pr-hero setup --ci` (or `pr-hero ci init`). It writes the one workflow file, `.github/workflows/pr-hero.yml`. Do not fabricate it from memory. Fallback: copy `assets/workflow.yml`. Never scaffold a `pr-hero-force.yml`; it is retired.
- **`fetch-depth: 0` is mandatory** on `actions/checkout@v4`.
- **Assistant posture:** pr-hero is a reviewer, not a merge gate (`exit 0` on findings).
- **Required permissions:** `contents: read`, `pull-requests: write`, `issues: write`, `statuses: write`, **`checks: write`**, **`actions: read`** (the admission gate lists past runs; a private repo 403s without it). Template in `assets/workflow.yml` includes all six.
- **Retrigger is a PR comment: `gh pr comment <n> --body "/pr-hero review"`.** GitHub Actions runs the review on the runner with `--force`. The comment must be exactly `/pr-hero review` (or `/pr-hero review --full`), and its author needs write access; the action refuses anyone else. Do not run `pr-hero review --force` locally when the review should happen in CI. `gh run rerun` on a skipped run re-evaluates the gates and does not force. In this repo a comment run checks out the PR head commit before `uses: ./`, so it runs the PR's own engine, not the default branch's.
- **`--force` never widens discovery; `--full` does.** When a prior review of the same head was hollow or wrong and re-runs report "No changes to discover", comment `/pr-hero review --full`. It passes `--full`, which re-discovers the whole PR range.
- **When the comment trigger takes effect:** GitHub reads a comment-triggered workflow from the **default branch** (for this repo, `main`, not `dev`), so `/pr-hero review` works only once `pr-hero.yml` with its `issue_comment` trigger is merged there; a user repo also needs an action release that handles the comment, through the `@v0` it pins.
- **Legacy scaffolds:** a `pr-hero.yml` scaffolded before the comment trigger has no `issue_comment` listener, so a comment does nothing. There, use `gh workflow run pr-hero-force.yml -f pr=<n>` (add `-f full=true` to re-discover), or re-scaffold with `pr-hero ci init --force`, which leaves `pr-hero-force.yml` in place.
- **Minimum action version:** this workflow listens to comments, and only an action release that ships the comment handling checks the command and the commenter's write access. An older action reviews on ANY comment starting with `/pr-hero review`, from anyone who can comment. Never pair this workflow with an older action; a pinned tag or sha must be at or after that release.
- **Older heads (this repo):** a comment run loads the PR head's own `action.yml`, so on a head from before the comment handling it reviews without reading the comment (no force, no `--full`); merge or rebase the PR onto a base that has it first.
- **Trust (this repo):** a comment run runs the PR head's code, including its `bun install`, with the workflow's secrets, so write access is checked twice: by the workflow's pre-checkout step (fail closed, before any head code runs) and again by the head's `action.yml`.
- **Admission config is repo-level:** Write `.prhero/config.json` on the default branch. That file **rejects** `routing`. Person-layer only (`$HOME/.prhero/config.json` on the runner, from `vars.PRHERO_ROUTING`).
- **`.prheroignore` is read from the base ref, not the PR branch, in CI.**
- **OpenCode is DATA:** quoted `routing: "${{ vars.PRHERO_ROUTING }}"` + `opencode-auth: ${{ secrets.OPENCODE_AUTH_JSON }}`. Unset both = Claude CI. Never a per-provider Action input. Never echo the auth blob.
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
| Fork PRs | Their pushes skip (no secrets). A user with write access comments `/pr-hero review`, and that run (base context, with secrets) reviews the fork head. Review `if` never reads `secrets`; the action checks credentials (Anthropic **or** Claude OAuth **or** `OPENCODE_AUTH_JSON`). |
| Spend gates | Defaults: `budget-usd: 10.00` on metered routes (Anthropic key **or** OpenCode auth file), `max-changed-lines: 4000`, `max-changed-files: 50`. Claude-only OAuth stays unlimited-subscription unless OpenCode auth is also present. |
| Existing workflow | `setup --ci` skips; ask before `--force` |
| First-time admission | Recommend `ci_admission_observe_only: true` — `references/ci-admission.md` |
| User wants max CI spend | Lower `ci_max_attempts` and/or raise `ci_rereview_min_score` |
| Custom bot posts findings | Add login to `ci_trusted_actors` |
| CI skipped (size, admission, or budget) | `gh pr comment <n> --body "/pr-hero review"`. The review runs on GitHub Actions. Do not run `pr-hero review --force` locally for this. Legacy scaffold (no `issue_comment` trigger): `gh workflow run pr-hero-force.yml -f pr=<n>`. |
| Prior review of the same head was hollow or wrong; re-runs say "No changes to discover" | `gh pr comment <n> --body "/pr-hero review --full"`. A plain `/pr-hero review` keeps the narrowed discovery. |
| A `/pr-hero review` comment did nothing | The workflow is not on the default branch yet, the comment is not exact, the author lacks write access, or the workflow predates the comment trigger (re-scaffold with `--force`). |

## Admission Interview (ask before writing config)

Ask these in plain language; map answers to `.prhero/config.json`:

1. **Attempts per PR?** Default `2` (`ci_max_attempts`). Same commit never double-reviews.
2. **When should a push trigger re-review?** Balanced → `risk_aware`; score only → `thresholded`; once then stop → `once_per_pr`; every push → `every_push`; manual only → `manual_only`.
3. **Score floor?** Default `4` with weights 2/1.
4. **Observe first?** If unsure, `ci_admission_observe_only: true` for one PR cycle.
5. **Non-default bot actor?** Collect GitHub logins for `ci_trusted_actors`.

Use `assets/admission-config.example.json`. Details: `references/ci-admission.md`.

## Execution Steps

1. **Inspect repo:** `git rev-parse --is-inside-work-tree`, `git remote get-url origin`, `gh auth status`.
2. **Credential path:** Claude-only → skip OpenCode. OpenCode or mix → **read `references/opencode-ci.md`** and execute it (metadata inspect, CI-only blob, secret, routing with `modelSnapshot`).
3. **Claude secret (if used):** `gh secret set CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (secure input, never print).
4. **Workflow:** `pr-hero setup --ci`. It writes `.github/workflows/pr-hero.yml` only. Confirm `checks: write` and `actions: read`, both `pull_request` and `issue_comment` triggers, quoted `routing` / `opencode-auth`. `--force` if an old template lacks them (an old `credentials` job or a missing `issue_comment` trigger means it predates the single workflow).
5. **Admission config:** Interview above. `.prhero/config.json` on the default branch. **No `routing` key.** `pr-hero config` to verify.
6. **Verify:** `pr-hero doctor`. `git status`. Confirm no openai `type:"api"` blob, no echoed auth, `modelSnapshot` matches `opencode models` when OpenCode is on.
7. **Deploy:** Offer commit. Open a **same-repo** test PR (forks skip).

## Output Contract

Report:
- Secret status (set or manual link). Names only: which of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `OPENCODE_AUTH_JSON` exist. Never values.
- OpenCode (if in scope): `OPENCODE_AUTH_JSON` set; blob providers **names + type only**; whether the blob was stripped to one CI provider; `PRHERO_ROUTING` JSON (no credentials); `modelSnapshot` vs `opencode models`.
- Workflow path (`pr-hero.yml`) and whether `checks: write`, `actions: read`, the `issue_comment` trigger, and quoted `routing` / `opencode-auth` are present.
- Admission policy (mode, attempts, observe-only). Confirm repo `.prhero/config.json` has no `routing` key.
- `pr-hero doctor` / `pr-hero config` outcome.
- Next steps: merge the workflow to the default branch (the comment trigger needs it there), open a same-repo test PR, when to turn off observe-only. If CI skipped, the override is `gh pr comment <n> --body "/pr-hero review"`.

## References

- `assets/workflow.yml` — the one review workflow (`pull_request` + `issue_comment` for `/pr-hero review`).
- `assets/admission-config.example.json` — starter `.prhero/config.json`.
- `references/ci-admission.md` — admission keys, modes, rollout, ledger.
- `references/opencode-ci.md` — OpenCode secret/variable procedure, routing, pin, openai vs deepseek.
- `docs/github-actions.md` — full CI integration docs.
