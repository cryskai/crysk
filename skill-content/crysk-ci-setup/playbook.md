# Crysk in GitHub Actions: setup

Load this to add Crysk to a repository's CI or change its CI settings. For a running repository (a skipped
review, a red gate, an error code), load `references/ci-operations.md` instead. Companion files come from
`npx -y crysk@0.12.0 skills load crysk-ci-setup <file>`.

## Hard rules

- **Never print, `cat`, commit or log a key, a token or an OpenCode `auth.json` record.** Refer to
  `${{ secrets.* }}` names only, and inspect `auth.json` keys and `type` only.
- **Nothing to install.** Run every command as `npx -y crysk@0.12.0 <command>`. Node is enough. CI itself needs no
  local CLI: the workflow file is the whole install.
- **Never write the workflow from memory.** `setup --ci` (the same as `ci init`) writes it. Fallback:
  `npx -y crysk@0.12.0 skills load crysk-ci-setup assets/workflow.yml`. It keeps `fetch-depth: 0`, the six permissions
  (`contents: read`, `pull-requests: write`, `issues: write`, `statuses: write`, `checks: write`, `actions: read`) and
  the `crysk-secrets` block, which names each secret and never passes `toJSON(secrets)`.
- **Commit to a branch and open a same-repository test pull request.** Commit to the default branch only if the user
  agrees. Push, merge and branch protection changes are theirs to approve.
- **Credentials:** one `CRYSK_*` secret each: `CRYSK_CLAUDE_OAUTH_TOKEN` (subscription, from `claude setup-token`),
  `CRYSK_CLAUDE_API_KEY`, and `CRYSK_OPENCODE_<P>_API_KEY` per OpenCode provider. With both Claude secrets set, the
  subscription runs unless `CRYSK_CREDENTIALS` is `{"claude": ["api_key", "subscription"]}`. A ChatGPT plan is not
  supported in the Action: it needs the Crysk GitHub App, so never store a ChatGPT login.
- **Models are public variables:** `CRYSK_MODELS` (role to model list), `CRYSK_CREDENTIALS` and
  `CRYSK_OPENCODE_PROVIDERS`. Unset `CRYSK_MODELS` means Claude. For OpenCode, DeepSeek, OpenAI or a mix, follow
  `npx -y crysk@0.12.0 skills load crysk-ci-setup references/opencode-ci.md` first.
- **`.crysk/config.json` refuses `models` and `credentials`.** Those live in the variables above.

## First: what is already there

```bash
git rev-parse --is-inside-work-tree && git remote get-url origin && gh auth status
ls .github/workflows/
```

| You find | Do |
|---|---|
| No Crysk workflow | Continue with "Set up". |
| A workflow whose only trigger is `workflow_dispatch`, with a `dispatch-id` input | The repository is on the Crysk platform. Do not scaffold over it. Its models, limits and review settings live in the Crysk dashboard. |
| `crysk.yml` or `pr-hero.yml` from `setup --ci` | See "Changing an existing setup". |
| Both `crysk.yml` and `pr-hero.yml` | Every pull request is reviewed twice, and setup refuses to run. Ask which one to delete. |

## Set up

1. **Interview.** Ask the questions below. Do not answer for the human, and do not skip one because a default exists.
2. **Scaffold** with their answers, never without flags on a first install (with none it applies `balanced` and `gate`,
   and its summary says nobody chose them):

   ```bash
   npx -y crysk@0.12.0 setup --ci --level <minimal|balanced|thorough|manual> --ci-mode <gate|advisory> --max-changed-lines <n>
   ```

   It writes `.github/workflows/crysk.yml`, merges the level's keys into `.crysk/config.json`, and prints the
   `gh secret set` and `gh variable set` commands for the person's models. Run the ones the human agrees to.
   `gh secret set` asks for each value, so it never reaches the chat.
3. **Advanced answers** go into `.crysk/config.json` and `.cryskignore` by hand, keeping every other key.
4. **Review instructions (recommended).** If the repository has neither `REVIEW.md` nor `.crysk/gotchas.md`, run
   `npx -y crysk@0.12.0 init`, then write real facts from the code: the oddity that looks like a bug, the invariant
   enforced elsewhere, the ownership rule a newcomer would break. Delete the `human-attention-required` line: Crysk
   refuses to review while it is there. With no file at all, reviews use the default guidance.
5. **Verify,** as below, then commit to a branch and open a same-repository test pull request (pushes from forks skip).
6. **Require the check,** only if the human agrees: branch protection must require the `crysk` status, not the `review`
   job. Read the current rule first (`gh api repos/<o>/<r>/branches/<default>/protection`), because the PUT replaces all of
   it. A private repository on GitHub Free cannot require checks (HTTP 403): say the gate is advisory there.

### Interview

1. **Re-review level.** Minimal: one automatic review per pull request. Balanced (recommended): re-review risky pushes or
   when the last pass found enough, at most 2 automatic passes. Thorough: every push, up to 4 passes, most cost. Manual:
   nothing automatic after the first review.
2. **Gate or advisory.** Gate turns the `crysk` check red on blocking findings. Advisory keeps it green.
3. **Changed-lines limit.** A larger pull request is skipped (default 4000, `0` for none).
4. **Advanced settings:** name them and ask whether to go through them now. Each is explained in
   `references/ci-admission.md`: score weights and floor, observe-only, trusted actors, changed-files limit, `.cryskignore`,
   posting floor (`post_min_severity`), materiality gate (`materiality_gate`, off unless they say yes).

Dollar limits are not a setup question. They belong to the Crysk platform (dashboard, Review > Limits) and apply only to
runs that bill an API key.

## Changing an existing setup

`setup --ci` over an existing workflow without `--force` exits 1 and writes nothing, neither the workflow nor the config.

- **To change settings only,** first show the current values (`npx -y crysk@0.12.0 config`), then edit
  `.crysk/config.json`, keeping every other key.
- **To refresh the workflow,** ask first, because `--force` replaces the file and hand edits are lost. `--force` alone
  keeps the settings: the old `mode` and size inputs carry over, and config keys are only filled in where absent. Adding
  `--level`, `--ci-mode` or `--max-changed-lines` overwrites that group. A `pr-hero.yml` is rewritten in place.
- A workflow that fails with `CRYSK-INPUT-REMOVED`, lacks the `issue_comment` trigger, or still has a `credentials` job
  needs that refresh.

## Verify

`crysk doctor` checks a local install, so it is not how CI is verified. Check instead:

- The workflow has `checks: write`, `actions: read`, the `pull_request` and `issue_comment` triggers, the `crysk-secrets`
  block and the `models` and `credentials` lines, with no removed input left.
- `gh secret list` and `gh variable list` show the expected names. Never read values.
- `npx -y crysk@0.12.0 config` shows the settings you meant, and `.crysk/config.json` has no `models` or `credentials` key.
- For OpenCode, every model id in `CRYSK_MODELS` is one `opencode models <provider>` lists, and each provider's token is
  in `CRYSK_OPENCODE_PROVIDERS`.
- `git status` shows only what you intended, with no secret.
- The real test is the first review on the test pull request.

## Report

Secret names set (never values); the models and credential variables; the workflow path and what you confirmed in it; the
settings summary and which ones the human chose; whether review instructions exist; whether `crysk` is required; and the
next steps: merge the workflow to the default branch (`/crysk` comments need it there), and when to turn off observe-only.

Docs: [crysk.dev/docs](https://crysk.dev/docs/), [quickstart](https://crysk.dev/docs/quickstart-github-actions/),
[Action reference](https://crysk.dev/docs/github-actions/action-reference/), [error codes](https://crysk.dev/docs/reference/error-codes/).
