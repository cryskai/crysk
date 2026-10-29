# OpenCode in CI — operator procedure

Read this when the operator wants OpenCode, DeepSeek, mixed Claude+OpenCode, or GitHub `OPENCODE_AUTH_JSON` / `CRYSK_ROUTING`. Full narrative: `docs/github-actions.md` (section **OpenCode in CI**).

Do **not** print, `cat`, or log credential values. Inspect **keys and `type` only**.

## Two GitHub boxes

| GitHub box | Name | Holds |
|---|---|---|
| **Secrets** (hidden) | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | Claude. Unchanged. |
| **Secrets** | `OPENCODE_AUTH_JSON` | One JSON object: the OpenCode `auth.json` store (or a **CI-only** subset). Cap 48 KB. |
| **Variables** (public) | `CRYSK_ROUTING` | Routing object only (`default` / `mappings` / `disabled`). No credentials. Cap 48 KB. Quoted in workflow `with.routing`. |

Do **not** create `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or any other per-provider GitHub secret. The Action has no per-provider inputs. Provider tokens live **inside** `OPENCODE_AUTH_JSON`.

Unset both OpenCode names = Claude-only CI.

## Local store (metadata only)

Default path: `$XDG_DATA_HOME/opencode/auth.json` or `~/.local/share/opencode/auth.json`.

```bash
python3 - <<'PY'
import json, os
p = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share"), "opencode", "auth.json")
print("exists", os.path.isfile(p))
if not os.path.isfile(p):
    raise SystemExit(0)
with open(p) as f:
    data = json.load(f)
print("providers", ",".join(sorted(data)))
for name, rec in data.items():
    t = rec.get("type") if isinstance(rec, dict) else "?"
    print(f"{name} type={t}")
PY
```

If the store is missing, have the operator authenticate the **CI provider** in OpenCode locally first (`opencode` auth/login for that provider). Do not collect the key in chat.

## What may go in the blob

| `auth.json` entry | CI |
|---|---|
| Non-openai `type: "api"` (tested: **deepseek**) | Executable metered path. Default spend ceiling applies. |
| `openai` `type: "api"` | **Refuse.** Engine maps `openai` to ChatGPT OAuth; a pay-as-you-go key is not remapped. |
| `openai` `type: "oauth"` | Do **not** put a personal ChatGPT session in a repository secret. |
| Several OpenCode providers in **one run** | Out of scope (#195). One OpenCode provider per run. |
| `claude-code` + **one** OpenCode provider | Legal. Keep a Claude secret and one OpenCode API record. |

If the personal store has extra providers (ChatGPT OAuth, zai, …), **do not upload it whole**. Write a 0600 temp object with **only** the CI provider, `gh secret set` from that file, delete the temp file.

```bash
# After writing a 0600 CI-only auth.json (deepseek-only). Never cat it.
gh secret set OPENCODE_AUTH_JSON < /path/to/ci-only-auth.json
```

`gh` missing/unauthenticated: Settings → Secrets and variables → Actions. Paste the JSON into secret `OPENCODE_AUTH_JSON`. Never paste it into the workflow YAML or the chat.

## Routing is logical model, not role

`CRYSK_ROUTING` maps **logical model identity** (`sonnet`, `haiku`), not hunter vs refuter.

Default prompt set:

| Step | Logical model |
|---|---|
| Hunters | `sonnet` |
| Refuter | `opus` |
| Summarizer | `haiku` |

A mapping moves only the steps whose logical model it names: a `sonnet` mapping moves the hunters and leaves the refuter alone. An alias with **no** mapping and **no** `default` route currently falls through to the Claude CLI (`claude-code` / `direct`), so that step needs Claude credentials in the run. A `default` route covers every alias, the refuter included.

| Routing shape | Hunters (`sonnet`) | Refuter (`opus`) |
|---|---|---|
| `default` route only | default route | default route (same model as the hunters) |
| Only a `sonnet` mapping to OpenCode | OpenCode | Claude CLI (needs a Claude secret) |
| `sonnet` and `opus` mappings to OpenCode | OpenCode | OpenCode |

OpenCode does not resolve pr-hero aliases. Any `opencode` route for `sonnet`/`opus`/`haiku` **must** set `modelSnapshot` to the provider model id. Confirm with `opencode models` (optionally `opencode models <provider>`). Do not guess `deepseek-chat` if the CLI lists `deepseek-v4-flash` / `deepseek-v4-pro`.

`gateway`: `"configured"` for OpenCode; `"direct"` for Claude CLI.

Do not wrap the variable in `{"routing": ...}`. Do not put keys in the variable (it is public).

### OpenCode-only (all logicals)

```bash
gh variable set CRYSK_ROUTING --body '{"default":{"backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"}}'
```

Replace `deepseek-v4-flash` with an id `opencode models` actually lists. The `default` route covers hunters (`sonnet`) and the refuter (`opus`) alike, so the refuter runs on this same model.

### Mixed: OpenCode default + Claude summarizer (legal DATA mix)

Hunters (`sonnet`) and refuter (`opus`) → the OpenCode default route, one API provider. Summarizer (`haiku`) → Claude.

```bash
gh variable set CRYSK_ROUTING --body '{"default":{"backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"},"mappings":[{"logical":"haiku","backend":"claude-code","provider":"anthropic","gateway":"direct"}]}'
```

Keep `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) for the Claude mapping. Presence of `OPENCODE_AUTH_JSON` still applies the metered ceiling.

### Mixed: OpenCode hunters + Claude refuter (legal DATA mix)

Map **only** `sonnet`. Hunters go to OpenCode; the unmapped `opus` refuter and the `haiku` summarizer (on unless `summary.enabled` is false) fall through to the Claude CLI (current behavior), so keep a Claude secret next to `OPENCODE_AUTH_JSON`.

```bash
gh variable set CRYSK_ROUTING --body '{"mappings":[{"logical":"sonnet","backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"}]}'
```

Do **not** use this shape in an OpenCode-only run (no Claude secret): the refuter and the summarizer are still routed to the Claude CLI and have no credentials to run them. For OpenCode-only, use the `default` route above, or map all three aliases (`sonnet`, `opus`, `haiku`), each with its own `modelSnapshot` (`opencode models` ids, same single OpenCode provider):

```bash
gh variable set CRYSK_ROUTING --body '{"mappings":[{"logical":"sonnet","backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"},{"logical":"opus","backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-pro"},{"logical":"haiku","backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"}]}'
```

## Workflow

Generated `with:` must keep:

```yaml
routing: "${{ vars.CRYSK_ROUTING || vars.PRHERO_ROUTING }}"
opencode-auth: ${{ secrets.OPENCODE_AUTH_JSON }}
```

Quotes around the routing var are load-bearing (unset → empty string). Re-scaffold with `pr-hero setup --ci --force` if an old template lacks them.

The Action installs OpenCode CLI **1.18.30** in its **own** step when `opencode-auth` is non-empty **or** routing contains `opencode`. Never `latest`. Claude-only (both OpenCode inputs empty / no `opencode` in routing) skips that install.

## Fail-closed edges

- Fork pushes still skip (no secrets); a maintainer's `/crysk review` comment reviews a fork.
- OpenCode-only (only `OPENCODE_AUTH_JSON`) counts as a credential and reviews.
- No credential at all fails the run red, with the `gh secret set` commands in the step summary.
- Claude credentials + OpenCode routing **without** `OPENCODE_AUTH_JSON` starts then **fails**.
- Invalid routing/auth JSON fails loud.

## After setting DATA

Open a **same-repo** PR (fork pushes skip). Confirm the review job materializes person-layer `$HOME/.crysk/config.json` and 0600 auth, and that spend notices show metered when the OpenCode file is present.
