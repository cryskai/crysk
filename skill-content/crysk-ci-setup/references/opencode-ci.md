# OpenCode in CI — operator procedure

Read this when the operator wants OpenCode, DeepSeek, mixed Claude+OpenCode, fallback models, or different models per step in GitHub Actions. User docs: [Other model providers](https://crysk.dev/docs/github-actions/other-providers/), [Use OpenAI models](https://crysk.dev/docs/github-actions/openai/), [Action reference](https://crysk.dev/docs/github-actions/action-reference/).

Do **not** print, `cat`, or log credential values. Inspect **keys and `type` only**.

## What goes where

| GitHub box | Name | Holds |
|---|---|---|
| **Secrets** (hidden) | `CRYSK_CLAUDE_OAUTH_TOKEN` or `CRYSK_CLAUDE_API_KEY` | Claude, when any step runs a `claude:` model. |
| **Secrets** | `CRYSK_OPENCODE_<P>_API_KEY` | One per OpenCode provider the models name. `<P>` is the provider id upper case, `-` and `.` as `_` (`deepseek` → `DEEPSEEK`, `github-copilot` → `GITHUB_COPILOT`). |
| **Variables** (public) | `CRYSK_MODELS` | The `models` object: role → ordered list of models. No credentials. |
| **Variables** | `CRYSK_OPENCODE_PROVIDERS` | JSON array of the `<P>` tokens whose API keys the workflow forwards, at most 5, e.g. `["DEEPSEEK"]`. |
| **Variables** | `CRYSK_CREDENTIALS` (optional) | The Claude order, e.g. `{"claude": ["api_key", "subscription"]}`. Unset: subscription first. |

Do **not** create `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or any other secret outside the `CRYSK_*` names: the workflow forwards only the names in its `crysk-secrets` block, never `toJSON(secrets)`. The old `OPENCODE_AUTH_JSON` secret and `CRYSK_ROUTING` variable are read by nothing, and the `opencode-auth` / `routing` inputs that carried them stop the run (`CRYSK-INPUT-REMOVED`).

Unset `CRYSK_MODELS` = Claude-only CI.

## Fastest path: `crysk ci init`

If the operator already has `models` in `~/.crysk/config.json`, `npx -y crysk@0.12.0 ci init` (or `setup --ci`) prints every `gh secret set` / `gh variable set` command for it: the Claude secret, one `CRYSK_OPENCODE_<P>_API_KEY` per provider (for openai, the API key and a note that a ChatGPT plan needs the Crysk GitHub App), `CRYSK_MODELS`, `CRYSK_CREDENTIALS` and `CRYSK_OPENCODE_PROVIDERS`. It never runs them. It refuses, writing nothing, when the models name more than 5 OpenCode providers. Run the commands the human agrees to; `gh secret set` asks for each value, so it never appears in the chat.

## Models per role

`CRYSK_MODELS` maps a **role** to a list of one to three models, tried in order (the next one only on a provider failure: rate limit, quota, network, timeout, model unavailable):

| Role | Steps |
|---|---|
| `default` | every role not listed (not the judge) |
| `hunter.<key>` | one hunter: `general`, the only bundled one (with no `models` it runs `claude:opus-latest` at `high` on the `claude` profile and `opencode:openai/gpt-6.2-sol` at `high` on `openai`). The old `logic`, `reliability`, `resilience` and `security` roles are ignored with a warning |
| `refuter` | refuter, re-review verifier, CI adjudicator |
| `consolidate`, `summary` | those steps |
| `judge` | materiality judge: only its profile's judge models (`claude:sonnet-latest` or `claude:opus-latest`; on the `openai` profile also `opencode:openai/gpt-6.1-terra`), never `default` |

Model names: `claude:sonnet-latest` / `opus-latest` / `haiku-latest` / `fable-latest` (newest), a full `claude:claude-…` id (pinned), or `opencode:<provider>/<model>`. There is no `modelSnapshot`, `gateway` or alias mapping any more: the provider's model id is part of the name. Confirm the id with `opencode models <provider>`; do not guess `deepseek-chat` if the CLI lists `deepseek-v4-flash` / `deepseek-v4-pro`. An entry may be `{"model": "...", "effort": "..."}`; on OpenCode the effort must be one of the model's variants (`opencode models <provider> --verbose`), or the review stops before spending.

### OpenCode-only

```bash
gh variable set CRYSK_MODELS --body '{"default": ["opencode:deepseek/deepseek-v4-flash"]}'
gh variable set CRYSK_OPENCODE_PROVIDERS --body '["DEEPSEEK"]'
gh secret set CRYSK_OPENCODE_DEEPSEEK_API_KEY
```

Every step runs on DeepSeek. Without a Claude secret on the default profile, keep `materiality_gate` off: the judge runs only on its profile's judge models, which are Claude's there (the `openai` profile runs it on `opencode:openai/gpt-6.1-terra`).

### Mixed

```bash
# OpenCode first with a Claude fallback, Claude for the refuter and summary
gh variable set CRYSK_MODELS --body '{"default": ["opencode:deepseek/deepseek-v4-flash", "claude:sonnet-latest"], "refuter": ["claude:opus-latest"], "summary": ["claude:haiku-latest"]}'
# Two OpenCode providers, each model on its own provider's secret
gh variable set CRYSK_MODELS --body '{"default": ["opencode:deepseek/deepseek-v4-pro", "opencode:openai/gpt-5"]}'
gh variable set CRYSK_OPENCODE_PROVIDERS --body '["DEEPSEEK", "OPENAI"]'
```

Keep a Claude secret beside the provider's when any role names `claude:`. An OpenCode key makes the run metered, so the platform's dollar limits can skip it.

## OpenAI

OpenAI runs in the Action on an API key, billed per token to the OpenAI account:

```bash
gh secret set CRYSK_OPENCODE_OPENAI_API_KEY
gh variable set CRYSK_OPENCODE_PROVIDERS --body '["OPENAI"]'
gh variable set CRYSK_PROFILE --body openai   # optional: the ready-made OpenAI models
```

Do not set an `_OAUTH` secret for any provider: only the Crysk platform manages that login.

A ChatGPT plan is not supported in the open-source Action. A stored login stops working, because OpenAI replaces its refresh token on every renewal. A ChatGPT plan needs the Crysk GitHub App: https://crysk.dev/docs/github-actions/openai/. If a human asks for a ChatGPT plan, say that and offer the API key; do not walk them through `opencode auth login` or `auth.json`.

## Workflow

The scaffold's `with:` must keep the `crysk-secrets: |` block (the fixed Claude lines, the fixed `_OAUTH` line, which stays empty in your repository, plus the five `CRYSK_OPENCODE_${{ fromJSON(vars.CRYSK_OPENCODE_PROVIDERS || '[]')[i] }}_API_KEY=…` slots) and:

```yaml
models: ${{ vars.CRYSK_MODELS }}
credentials: ${{ vars.CRYSK_CREDENTIALS }}
```

Load it with `npx -y crysk@0.12.0 skills load crysk-ci-setup assets/workflow.yml` or re-scaffold with `npx -y crysk@0.12.0 ci init --force`; never write it from memory. An unused slot renders as `CRYSK_OPENCODE__API_KEY=` and is skipped.

The Action installs OpenCode CLI **1.18.30** in its **own** step when the setup step built an OpenCode auth file **or** the models in effect name `opencode:`. Never `latest`. Claude-only skips that install.

## What fails, and how

- No credential at all fails the run red, with the `gh secret set` commands in the step summary.
- An OpenCode model whose provider has no secret fails for the missing record, unless the provider serves it free.
- A `CRYSK_MODELS` or `CRYSK_CREDENTIALS` value the parser refuses fails the run (`CRYSK-CONFIG-INVALID`).
- Fork pushes skip. A `/crysk review` from someone with write access reviews a fork.

Then open a same-repository pull request. The review job's setup step prints one notice per OpenCode provider naming the secret it used.
