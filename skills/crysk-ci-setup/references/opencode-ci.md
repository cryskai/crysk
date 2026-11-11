# OpenCode in CI — operator procedure

Read this when the operator wants OpenCode, DeepSeek, mixed Claude+OpenCode, fallback models, or different models per step in GitHub Actions. Full narrative: `docs/github-actions.md` (sections **OpenCode in CI** and **`CRYSK_*` secrets**); model rules: `docs/configuration.md` (section **Models**).

Do **not** print, `cat`, or log credential values. Inspect **keys and `type` only**.

## What goes where

| GitHub box | Name | Holds |
|---|---|---|
| **Secrets** (hidden) | `CRYSK_CLAUDE_OAUTH_TOKEN` or `CRYSK_CLAUDE_API_KEY` | Claude, when any step runs a `claude:` model. |
| **Secrets** | `CRYSK_OPENCODE_<P>_API_KEY` | One per OpenCode provider the models name. `<P>` is the provider id upper case, `-` and `.` as `_` (`deepseek` → `DEEPSEEK`, `github-copilot` → `GITHUB_COPILOT`). |
| **Secrets** | `CRYSK_OPENCODE_OPENAI_OAUTH` | Only for an OpenAI (ChatGPT) subscription: the `openai` record of OpenCode's `auth.json`, base64 on one line. |
| **Variables** (public) | `CRYSK_MODELS` | The `models` object: role → ordered list of models. No credentials. |
| **Variables** | `CRYSK_OPENCODE_PROVIDERS` | JSON array of the `<P>` tokens whose API keys the workflow forwards, at most 5, e.g. `["DEEPSEEK"]`. |
| **Variables** | `CRYSK_CREDENTIALS` (optional) | The Claude order, e.g. `{"claude": ["api_key", "subscription"]}`. Unset: subscription first. |

Do **not** create `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or any other secret outside the `CRYSK_*` names: the workflow forwards only the names in its `crysk-secrets` block, never `toJSON(secrets)`. The old `OPENCODE_AUTH_JSON` secret and `CRYSK_ROUTING` variable are read by nothing, and the `opencode-auth` / `routing` inputs that carried them stop the run (`CRYSK-INPUT-REMOVED`).

Unset `CRYSK_MODELS` = Claude-only CI.

## Fastest path: `crysk ci init`

If the operator already has `models` in `~/.crysk/config.json`, `npx -y crysk ci init` (or `setup --ci`) prints every `gh secret set` / `gh variable set` command for it: the Claude secret, one `CRYSK_OPENCODE_<P>_API_KEY` per provider (plus the `_OAUTH` line for openai), `CRYSK_MODELS`, `CRYSK_CREDENTIALS` and `CRYSK_OPENCODE_PROVIDERS`. It never runs them. It refuses, writing nothing, when the models name more than 5 OpenCode providers. Run the commands the human agrees to; `gh secret set` asks for each value, so it never appears in the chat.

## Models per role

`CRYSK_MODELS` maps a **role** to a list of one to three models, tried in order (the next one only on a provider failure: rate limit, quota, network, timeout, model unavailable):

| Role | Steps |
|---|---|
| `default` | every role not listed (not the judge) |
| `hunter.<key>` | one hunter: `logic`, `parity`, `reliability`, `resilience` |
| `refuter` | refuter, re-review verifier, CI adjudicator |
| `consolidate`, `scout`, `summary` | those steps |
| `judge` | materiality judge: only `claude:sonnet-latest` or `claude:opus-latest`, never `default` |

Model names: `claude:sonnet-latest` / `opus-latest` / `haiku-latest` / `fable-latest` (newest), a full `claude:claude-…` id (pinned), or `opencode:<provider>/<model>`. There is no `modelSnapshot`, `gateway` or alias mapping any more: the provider's model id is part of the name. Confirm the id with `opencode models <provider>`; do not guess `deepseek-chat` if the CLI lists `deepseek-v4-flash` / `deepseek-v4-pro`. An entry may be `{"model": "...", "effort": "..."}`; on OpenCode the effort must be one of the model's variants (`opencode models <provider> --verbose`), or the review stops before spending.

### OpenCode-only

```bash
gh variable set CRYSK_MODELS --body '{"default": ["opencode:deepseek/deepseek-v4-flash"]}'
gh variable set CRYSK_OPENCODE_PROVIDERS --body '["DEEPSEEK"]'
gh secret set CRYSK_OPENCODE_DEEPSEEK_API_KEY
```

Every step runs on DeepSeek. Without a Claude secret, keep `materiality_gate` off: the judge runs only on Claude.

### OpenCode hunters, Claude refuter and summarizer, Claude fallback

```bash
gh variable set CRYSK_MODELS --body '{"default": ["opencode:deepseek/deepseek-v4-flash", "claude:sonnet-latest"], "refuter": ["claude:opus-latest"], "summary": ["claude:haiku-latest"]}'
```

Keep `CRYSK_CLAUDE_OAUTH_TOKEN` (or `CRYSK_CLAUDE_API_KEY`) beside the DeepSeek secret. The OpenCode auth file still applies the metered ceiling.

### Two OpenCode providers

```bash
gh variable set CRYSK_MODELS --body '{"default": ["opencode:deepseek/deepseek-v4-pro", "opencode:openai/gpt-5"]}'
gh variable set CRYSK_OPENCODE_PROVIDERS --body '["DEEPSEEK"]'
```

Each model runs on its own provider's secret, through its own OpenCode server. Here OpenAI is the ChatGPT subscription through `CRYSK_OPENCODE_OPENAI_OAUTH`, which has its own fixed line, so only DeepSeek needs a token; for an OpenAI API key instead, list `"OPENAI"` too and set `CRYSK_OPENCODE_OPENAI_API_KEY`.

## OpenAI

| Secret | CI |
|---|---|
| `CRYSK_OPENCODE_OPENAI_API_KEY` | Metered API key. Runs. |
| `CRYSK_OPENCODE_OPENAI_OAUTH` | The ChatGPT subscription. Wins when both are set. |
| `_OAUTH` for any other provider the models use | **Refused**, naming the secret. Use that provider's `_API_KEY`. |

Setting the subscription (the record keeps its refresh token, so OpenCode renews the access token during a run; the renewed token is not saved, so re-run this after an `opencode auth login`):

```bash
jq -c .openai ~/.local/share/opencode/auth.json | base64 -w0 | gh secret set CRYSK_OPENCODE_OPENAI_OAUTH   # on macOS, drop -w0
```

Ask the human before putting a personal ChatGPT session in a repository secret: anyone who can change the workflow on the default branch can use it.

## Workflow

The scaffold's `with:` must keep the `crysk-secrets: |` block (the fixed Claude and OpenAI lines plus the five `CRYSK_OPENCODE_${{ fromJSON(vars.CRYSK_OPENCODE_PROVIDERS || '[]')[i] }}_API_KEY=…` slots) and:

```yaml
models: ${{ vars.CRYSK_MODELS }}
credentials: ${{ vars.CRYSK_CREDENTIALS }}
```

Copy it from `assets/workflow.yml` or re-scaffold with `npx -y crysk ci init --force`; never write it from memory. An unused slot renders as `CRYSK_OPENCODE__API_KEY=` and is skipped.

The Action installs OpenCode CLI **1.18.30** in its **own** step when the setup step built an OpenCode auth file **or** the models in effect name `opencode:`. Never `latest`. Claude-only skips that install.

## Fail-closed edges

- Fork pushes still skip (no secrets); a maintainer's `/crysk review` comment reviews a fork.
- OpenCode-only (only `CRYSK_OPENCODE_*` secrets) counts as a credential and reviews, as long as no step runs a `claude:` model.
- No credential at all fails the run red, with the `gh secret set` commands in the step summary.
- An OpenCode model whose provider has no secret starts, then **fails** for the missing record (unless the provider serves that model free).
- A `CRYSK_MODELS` or `CRYSK_CREDENTIALS` value the parser refuses fails the run (`CRYSK-CONFIG-INVALID`), naming the input, never its content.

## After setting DATA

Open a **same-repo** PR (fork pushes skip). In the review job's log, the setup step prints one notice per OpenCode provider naming the secret it used, and the spend notices show metered when the OpenCode auth file is present.
