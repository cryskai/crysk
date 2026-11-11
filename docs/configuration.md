# Configuration, Models and Credentials

An operator guide: where config lives, which model each step of a review runs on, which credentials
Crysk reads and from where, and how to check all of it without spending money. For the day-to-day config
keys and the two-layer merge rule, see the README's
[Configuration — two layers](../README.md#configuration--two-layers) section first — this document
covers the two things that section does not: `models` and credentials.

## Quick path

1. `crysk config` — every key's effective value and which layer it came from. Read-only, $0.
2. `crysk doctor` — probes the *real* binding: binary, credential, isolation, billing mode. Read-only, $0.
3. `crysk review --dry-run` — resolves the plan and prints the cost band without spawning anything. $0.

## Where a key belongs, and the two traps

| Layer | File | Holds |
| --- | --- | --- |
| Global / per-person | `~/.crysk/config.json` (or `~/.prhero/config.json`, see below) | `models`, `credentials`, personal caps (`max_verification_steps`, `max_concurrent_steps`, `max_changed_lines`, `max_changed_files`) |
| Repo | `<repo>/.crysk/config.json` | `agents_dir`, `default_base`, `parity_trigger_paths`, `suspicion_priors` |
| Repo, review instructions | `<repo>/REVIEW.md`, else `<repo>/.crysk/gotchas.md` (optional) | facts the hunters and the refuter read; with `materiality_gate` on, the judge also reads it as owner policy for style, test, generated-code and dev-script findings only; see the README's `REVIEW.md` and `gotchas.md` section |

`max_concurrent_steps` caps how many steps (hunter, refuter, verify, adjudicate, scout and summarizer attempts) are in flight at once. It is a `capped` key, so the lowest layer wins, and unset means unlimited: no admission gate is built and the run behaves exactly as before. Set it below your provider's concurrency limit: a provider that allows 10 in-flight requests (OpenCode's `aiand` does) returns HTTP 429 when more are sent at once, and Crysk can lose refuters to that error, so a cap such as `8` keeps the fan-out inside the limit.

**Old directory names.** The directories used to be `~/.prhero/` and `<repo>/.prhero/`, and the ignore file
`.prheroignore`. Those are still read, for one version, when the new name does not exist. Nothing is moved for
you: `crysk doctor` prints the full procedure for your machine. For the home that is the `mv ~/.prhero ~/.crysk`
plus whatever still points at the old path (the `.prhero/bin` PATH line, the launchd agents, the MCP registration),
and for a repo `git mv .prhero .crysk` (plain `mv` plus a `.gitignore` edit if the directory is not tracked) and
`git mv .prheroignore .cryskignore`. A new-named directory only wins while it holds Crysk's own files
(`~/.crysk` needs a `config.json`, `prhero.db`, `repos/` and the like; `<repo>/.crysk` needs `config.json` or
`gotchas.md`), so an empty `~/.crysk` never hides a `~/.prhero` in use. Do not create `~/.crysk` by hand while
`~/.prhero` is in use. When both hold files, the `.crysk` one wins and the old one is ignored.

`models` and `credentials` are **person-layer-only** keys: they pick what a review spends, so a committed file
cannot set them. Put one in a repo file and the parser refuses it by name:

```
.crysk/config.json: models is a per-person key — put it in your person config (~/.crysk/config.json, or ~/.prhero/config.json on an install set up before the rename; do not create ~/.crysk while ~/.prhero is in use)
```

The reverse also throws (a repo-only key in the global file gets ` is a per-repo key — put it in the
repo config (<repo>/.crysk/config.json, or <repo>/.prhero/config.json in a repo set up before the
rename)`). Run `crysk config` to see, per key, which of the two files actually
spoke.

**`--config <file>` replaces the repo layer only.** There is no flag that repoints the global one —
it is always read from `os.homedir()`. Pointing `--config` at a file that contains `models` hits the
same per-person rejection above, because `--config` still parses as a repo-layer file.

## CI: models come from repository variables

Nothing in the engine reads a `CRYSK_MODELS` environment variable. `CRYSK_MODELS` and `CRYSK_CREDENTIALS`
are the *repository variable names* the scaffolded workflow passes to the action's `models` and
`credentials` inputs (`models: ${{ vars.CRYSK_MODELS }}`). The setup step parses each one with the same
parser as your person config and writes them to `$HOME/.crysk/config.json` on the runner (a fresh runner has
no `~/.prhero`) — the same global layer described above, never the repo file. A value the parser refuses
fails the run with `CRYSK-CONFIG-INVALID`, which names the input but never prints its content. A repository
connected to the Crysk platform takes both from the platform's model settings instead, which win whole: when
the platform sends any settings, the two inputs are ignored, with a warning; when it sends none, the inputs
apply. Unset, every role runs the model its prompt declares, on the
Claude CLI.

The credentials themselves are `CRYSK_*` secrets passed in the `crysk-secrets` input. Full wiring (the
secrets, the OpenCode provider slots, the pinned OpenCode CLI version, budget ceilings) is in
[`docs/github-actions.md`](github-actions.md#opencode-in-ci); `crysk ci init` scaffolds it and prints the
commands that set each variable and secret from your person config, and
[`skills/crysk-ci-setup/SKILL.md`](../skills/crysk-ci-setup/SKILL.md) walks an agent through it.

## Models

Every step of a review runs under a **role**, and `models` in your person config gives a role the models
it runs on, in the order to try them:

```json
{
  "models": {
    "default": ["claude:sonnet-latest"],
    "hunter.logic": ["opencode:deepseek/deepseek-v4-flash", "claude:sonnet-latest"],
    "refuter": [{ "model": "claude:opus-latest", "effort": "max" }],
    "summary": ["claude:haiku-latest"]
  }
}
```

### Roles

| Role | Steps | When the role is not listed |
| --- | --- | --- |
| `hunter.<key>` | one hunter: `hunter.logic`, `hunter.parity`, `hunter.reliability`, `hunter.resilience`, or the key of a hunter in your own prompt set | `default` |
| `refuter` | the refuter, and the re-review verifier and the CI adjudicator, which run its prompt family | `default` |
| `consolidate` | the consolidation pass after the refuter | `default` |
| `scout` | the experimental diff-only scout | `default` |
| `summary` | the summarizer | `default` |
| `judge` | the materiality judge (`materiality_gate`) | `claude:sonnet-latest`, never `default` |
| `default` | every role above that is not listed, the judge excepted | the model the step's prompt declares |

With no `models` at all, each step runs the model its prompt declares, as `claude:<alias>-latest`: the
bundled hunters, the consolidation pass and the scout declare `sonnet`, the refuter `opus`, the summarizer
`haiku`. A `hunter.<key>` that no hunter of the review declares fails when the plan is built, so a typo never
goes unnoticed; `hunter.parity` is accepted on the runs where the parity hunter does not fire.

**Which model a step runs on**, highest first: `--model` (one model for every step but the judge, no
fallbacks); `models[role]`; `models.default`; the prompt's own model.

### Model names

A model name says which backend runs it:

| Name | Runs on |
| --- | --- |
| `claude:sonnet-latest`, `claude:opus-latest`, `claude:haiku-latest`, `claude:fable-latest` | the Claude Code CLI, on the newest version of that model (the CLI's `sonnet`, `opus`, `haiku`, `fable` aliases, which move to each new release) |
| `claude:claude-sonnet-5-5`, or any full `claude-*` model id | the Claude Code CLI, pinned to that version |
| `opencode:<provider>/<model>` | OpenCode, on that provider's model id, as `opencode models <provider>` lists it. The model may hold more slashes (`opencode:openrouter/anthropic/claude-sonnet-4.5`): the provider runs to the first one |

A bare `claude:sonnet` is refused rather than guessed, so nobody reads it as a pin:

```
~/.crysk/config.json models.default[0]: "claude:sonnet" is not a model name: write "claude:sonnet-latest" for the newest sonnet, or a full name such as "claude-sonnet-5-5" to pin a version
```

There is no catalog of OpenCode models: the bundled one (`config/models/anthropic.json`) holds only the
Claude aliases, so an OpenCode model must be spelled exactly as its provider names it, and a wrong id fails
at the provider, not at Crysk. A name that looks like a credential is refused unseen.

### Lists

- **One to three models per role**, tried in order: the step runs on the first, and moves to the next only
  when the provider fails it (see [Fallback models](#fallback-models)). A fourth is refused (`models.default
  lists 4 models: at most 3 are allowed`).
- **No model twice in one list**, even with two efforts: the second would run only when the first failed,
  and a provider failure does not depend on effort.
- **An entry is a model name, or `{"model": "<name>", "effort": "<level>"}`** to set how hard that model
  works (see [Effort](#effort)). Any other key is refused.
- **Unknown roles are refused**, with the list of roles in the message.

### The materiality judge

The judge was measured on `claude:sonnet-latest` and `claude:opus-latest` only, so `models.judge` may
choose between those two and nothing else. Any other model in its list is dropped with a warning, and when
none is left the judge stands down (findings stay blocking). It takes model names only, never an effort, and
neither `--model` nor `models.default` ever moves it. Without `models.judge` it runs on
`claude:sonnet-latest`. It has no fallback: it keeps the first model of its list.

### What changed from `routing`

`routing` is gone. A config that still has it, in either file, is refused with the form that replaces it:

```
~/.crysk/config.json: `routing` is gone: set models per role, e.g. `"models": {"hunter.logic": ["claude:sonnet-latest"]}`
```

There is no `logical`, `gateway`, `modelSnapshot`, `disabled` or `allowSpend` any more: the role says which
step, the model name says which backend and model, and the provider's model id is part of the name.

`summary.model` is gone too. The one value `crysk init` used to write, `"haiku"`, still reads, with a
warning: in your person config it becomes `"models": {"summary": ["claude:haiku-latest"]}`, and in a repo file
it is ignored (the summary model is a person setting now, and `haiku` is the summarizer's own model anyway).
Any other value is refused with the new form.

The `#variant` suffix on an OpenCode model is gone as well; its replacement is the entry's `effort`:

```
~/.crysk/config.json models.default[0]: "opencode:openai/gpt-5#high": the #variant suffix is gone: write {"model": "opencode:openai/gpt-5", "effort": "high"} in models
```

`--model` and the CI `model` input take one model name, with no effort and no fallbacks; a bare `sonnet`,
`opus`, `haiku` or `fable` there still means its `-latest` model.

## Fallback models

Each role in `models` takes a list, and the list is tried in order. The step runs on the first model; when
the **provider** fails it, the step moves to the next one:

```json
{
  "models": {
    "hunter.logic": ["opencode:openai/gpt-5", "claude:sonnet-latest"],
    "default": ["claude:sonnet-latest", "claude:opus-latest"]
  }
}
```

A role not listed uses `models.default`, fallbacks included. A list of one model behaves exactly as
before: no fallback, and nothing new is recorded. `--model` names one model, so a run with it has no
fallbacks; the materiality judge keeps its one measured model.

**When it moves.** Only on a failure that is the provider's, not the model's answer, and only after the
model has used its own retries:

| Cause | Moves to the next model? |
| --- | --- |
| `rate_limit`, `quota_exhausted`, `network_transient`, `protocol_truncation`, `watchdog_timeout` (the step timed out), `model_unavailable` | yes |
| `auth_invalid` (the login was refused, "Not logged in") | yes, skipping every later model on the same credential |
| `format_violation` (a bad answer, after its one format retry) | no |
| `context_window_exceeded`, `output_limit_exceeded`, `safety_refusal` | no |
| anything else (configuration, protocol conformance, cancellation, an unconfirmed abort) | no |

"The same credential" is the binding's credential: every Claude model shares the run's one Claude
credential, and an OpenCode model's credential is its provider plus the kind of credential it runs on (a
DeepSeek API key, an OpenAI subscription). So a refused Claude login skips the other Claude models and moves
to an OpenCode model, a refused DeepSeek key skips the other DeepSeek models and moves to another provider,
and the reverse. A cancelled run starts no further model.

**A fenced credential.** A metered attempt whose cost the provider never reported (a timeout, a stream
cut short) fences its credential's spend for the rest of the run, so nothing spends on it blindly. A
later model on that credential is then refused before any request: it is recorded `skipped`, and the
list goes on to a model on another credential. So a metered OpenCode model that times out moves only to
a model on another credential, never to another model on the same one.

**Time.** Each model gets the step's own retries, each with the step's full timeout, so the longest a step
can take grows with the list: a step whose three models all keep timing out takes three times what one
model would. Only the run's own ceiling bounds the whole step.

**Cost.** The same holds for money: each model's attempts are paid on its own credential, so a step whose
three models all fail after spending can cost up to three times one model. The CI `budget-usd` check reads
the estimate before the run, which does not price fallbacks, and nothing caps dollars while the run goes.

**Checked before anything spends.** Every model of every list is resolved, bound and admitted with the rest
of the plan, before the cost confirmation, so a fallback that cannot run (no executable, no credential, a
backend not admitted) fails the run up front instead of when its turn comes. OpenCode models may name
several providers, and a free model may sit beside a metered one: each model runs through its own OpenCode
server, projected with only its own credential (see "Several OpenCode providers in one review" below). A
refused login moves past every other model on the same credential to the next one on another. The confirm
menu's free label counts the fallbacks too, so a free first model with a metered fallback is not shown as
free.

**What is recorded.** In `pipeline.json`, a step whose role listed several models has:

- `model`, `route` and `effort_applied` of the model that **ran** (the last one that reached its provider),
  written when the step settles over the first model stamped before the spawn, with its `effort` and, on
  OpenCode, the `variant` it was sent (see [Effort](#effort)).
- `model_attempts`: every model tried, in order, each with its `model`, `route`, `effort`,
  `effort_applied`, `variant` (when one was sent), `status` (`ok`, `failed` or `skipped`), `attempts`, the
  `cause` it failed on and its own `usage_v2`. `skipped` means it never reached its provider: after a
  refused login on its credential (`cause` `auth_invalid`), or with no cause when its credential was fenced
  or it failed before its first request. The step reports the cause and detail of the model that ran.
  Models can bill differently, so the step's `usage_v2` sums them and only these
  entries keep each model's billing.
- `attempts` counts every model's attempts that reached a provider, and attempts are numbered across models, so each model's
  attempt logs and settlement receipts keep their own files; the pointers name the last one.

Spend is reserved per attempt on the binding of the model that runs it, exactly as for a single model.
The per-agent model the platform report carries, and the provider and model named for a failed hunter,
are the ones that ran. A step with one model records exactly what it recorded before.

## Effort

How hard a model works is set per step with the Claude CLI's `--effort` control, and **Crysk owns it**:
every Claude Code step is spawned with an explicit `--effort <level>`, never the CLI's implicit default.
That default is `high`, except on Sonnet 5.5 and Opus 5.5, where it is `medium`, so leaving it implicit
meant a model alias moving to a new release could silently change how deeply a step explores.

An agent prompt may declare its own level in its frontmatter, beside `model:`:

```yaml
---
name: my-hunter
model: sonnet
effort: xhigh
tools: Read, Grep, Glob
---
```

The levels are `low`, `medium`, `high`, `xhigh` and `max`. Anything else fails at preflight and names the
file. When a prompt omits `effort:`, the engine supplies a default for the step's role, so a custom or lab
prompt set still runs at an explicit level:

| Role | Default | Why |
| --- | --- | --- |
| Hunter | `xhigh` | Measured on a real 280-line PR (Sonnet 5.5, 4 hunters x 2 replicates): `medium` found something in 0 of 8 runs, `high` in 6 of 8, `xhigh` in 8 of 8 and all 4 known bugs, `max` in 7 of 8 at about four times the wall time. |
| Refuter | `high` | `medium` refuted a pre-labeled known blocker in 3 of 4 verdicts on real findings, which deletes it; `high` kept it as latent in 3 of 4. |
| Summarizer, scout, rereview verifier | `high` | Unmeasured, so they keep what every model ran at before the 5.5 family. |

The bundled prompts declare `effort: xhigh` on the hunters and `effort: high` on the refuter. The rereview
verifier reuses the refuter's prompt, so it follows the refuter's frontmatter. There is no CLI flag or
environment variable that overrides effort, and the child process never inherits `CLAUDE_CODE_EFFORT_LEVEL`
from your shell. `xhigh` hunters cost roughly three times what `high` did per hunter, and the cost band does
not price effort yet, so expect the real bill to exceed the quote.

**Consolidation.** After the refuter, one more step reads the findings about to be posted and rewrites the
list so each comment states one defect: findings that describe the same defect are merged into one
primary finding (its location, tier and verdict are kept, and the evidence is pooled), and an unrelated aside inside a finding is split
into its own advisory comment. It reads only the claims (no tools, no code), and a plan that drops or invents
a finding is rejected, in which case the findings post unchanged. It is on by default in local and PR reviews,
has no flag, and costs one call per review at `high` effort, on the `consolidate` role's model (`sonnet` by
default, `prompts/consolidate.md`). Measured
offline on the Martian 50 it moved F1 from 39.7 to 42.3. Each run records the outcome under `consolidation`
in `pipeline.json`.

### Effort per model

A `models` entry can set the effort of that one model, which wins over the prompt's `effort:` and the role
default: **the entry's `effort`, then the prompt's `effort:`, then the role default.** Each fallback runs at
its own entry's effort, not the first model's:

```json
{
  "models": {
    "refuter": [
      { "model": "claude:opus-latest", "effort": "max" },
      { "model": "opencode:openai/gpt-5", "effort": "high" }
    ]
  }
}
```

- **On the Claude CLI** the effort is `--effort`: `low`, `medium`, `high`, `xhigh` or `max`. `ultracode` is
  refused by name: on the CLI it also turns on workflow orchestration, which a review step is not; write
  `xhigh` for its effort level. A model that does not support a level runs at the highest one it supports
  (the CLI's own rule).
- **On OpenCode** the effort is the model's **variant**, named as OpenCode names it, which differs per
  provider (Anthropic `high` and `max`, OpenAI `none` to `xhigh`, Google `low` and `high`; see OpenCode's
  [Variants](https://opencode.ai/docs/models/)). OpenCode runs a variant the model does not have at its
  default level, without an error, so Crysk checks every variant the plan would send, fallbacks included,
  against `opencode models <provider> --verbose --refresh` before the cost confirmation. A variant the model
  does not list, an effort on a model with no variants, or a listing that cannot be read stops the review
  before anything spends, naming the model and the variants it does have. An OpenCode model with no entry
  effort is sent no variant and runs at its default level.
- **`--model`, the CI `model` input and the materiality judge take no effort.**

Before that variants check, every OpenCode model the plan may run, fallbacks included, must have a record
for its provider in the OpenCode auth file the run reads, unless the provider declares the model free. A
model whose provider has none stops the review before anything spends, with or without an effort: in CI the
refusal names the `CRYSK_OPENCODE_<PROVIDER>_API_KEY` secret that did not reach the run
(`CRYSK-CRED-UNUSABLE`), and locally it says to run `opencode auth login`.

What ran is recorded: `effort` in each attempt's request plan and in `pipeline.json`, next to
`effortApplied` / `effort_applied`, which is `true` on the Claude CLI and on OpenCode only when a variant
was sent (then `variant` names it). On an OpenCode step with no variant, `effort` still shows the prompt's
level as intent, with `effort_applied: false`, so the run never reads as having run at that level.

## Credentials

**Crysk never stores a credential.** It reads them from wherever they already live and projects
a minimal, ephemeral copy into the child process's isolated environment. Four credential kinds
exist today:

| Kind | Source | Backend | Billing |
| --- | --- | --- | --- |
| `claude_subscription_oauth` | `CRYSK_CLAUDE_OAUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`, the macOS Keychain item `Claude Code-credentials` (via `/usr/bin/security`), or `~/.claude/.credentials.json` | `claude-code` | subscription (quota, `$0.00` cash) |
| `provider_api_token` | `CRYSK_CLAUDE_API_KEY` or `ANTHROPIC_API_KEY` (claude-code), or the named key in OpenCode's `auth.json` (opencode; in CI, built from `CRYSK_OPENCODE_<P>_API_KEY`) | `claude-code`, `opencode` | metered (real invoice) |
| `opencode_chatgpt_oauth` | the `openai` entry in `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`), which must be `type: "oauth"` (in CI, built from `CRYSK_OPENCODE_OPENAI_OAUTH`) | `opencode` | subscription |
| `provider_free` | the provider's own catalog declares the model free at runtime (`opencode models <provider> --verbose --refresh`, every cost leaf `0`, status active); the provider's `type: "api"` entry in `auth.json` is projected if one exists, otherwise nothing | `opencode` | free (not metered) |

### The one trap worth naming twice

An operator can run `opencode auth login` for several providers, see all of them in `opencode
models`, and have exactly one of them resolve to a subscription: the broker for
`opencode_chatgpt_oauth` reads the literal `openai` key in `auth.json` and requires that record's
`type` to be `"oauth"`. An `openai` entry holding a pay-as-you-go API key instead is refused —
loudly, at credential projection — rather than silently billed as if it were the ChatGPT
subscription. Every other provider (DeepSeek, Z.ai, etc.) resolves to `provider_api_token`
regardless of what it is named.

In CI the kind follows the secret instead of the provider's name: the setup step records which `CRYSK_*`
secret built each record, so an `openai` model on `CRYSK_OPENCODE_OPENAI_API_KEY` runs as a metered API
key, and on `CRYSK_OPENCODE_OPENAI_OAUTH` as the subscription (see
[How the OpenCode secrets become the auth file](github-actions.md#how-the-opencode-secrets-become-the-auth-file)).
The rule above holds for your own machine's `auth.json`, where no such record exists.

### Several OpenCode providers in one review

A review's models may name several OpenCode providers, for example a DeepSeek API key as the first model
and an OpenAI subscription as its fallback, and may mix a `provider_free` model with metered ones. Each
OpenCode credential is a provider plus its kind (`provider_api_token`, `opencode_chatgpt_oauth` or
`provider_free`), and every model is decided on its own:

- **One server per model, one record per server.** Each model's steps run through their own OpenCode
  server, launched under a synthetic home whose `auth.json` holds only that model's provider record. A
  DeepSeek server never sees the OpenAI record, and the other way round. Steps on different credentials
  never share a server.
- **Billing per model.** A metered model reserves spend and can fence its own credential's bucket; a
  subscription model reserves nothing; a free model settles at zero unless the provider prices it. The
  usage record of each attempt carries the billing of the credential it ran on.
- **Closed when done.** A server stops when its last step ends, whether it succeeded, failed or was
  cancelled, and any server still up stops when the run ends.

A plan on a single OpenCode credential behaves exactly as before.

### claude-code: one credential per run, in the order you choose

A run uses exactly **one** Claude credential, chosen once when it starts and never switched mid-run. Set
the order in your person config (`~/.crysk/config.json`; a repository file cannot set it; in CI, the
`CRYSK_CREDENTIALS` variable passed as the action's `credentials` input):

```json
{ "credentials": { "claude": ["subscription", "api_key"] } }
```

- `subscription` is the Claude Code subscription: the `CRYSK_CLAUDE_OAUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`
  variable (`claude setup-token`), or a login on this machine (the macOS Keychain item, or
  `~/.claude/.credentials.json`).
- `api_key` is an Anthropic API key, billed per token: `CRYSK_CLAUDE_API_KEY` or `ANTHROPIC_API_KEY`.

The run uses the first credential in the list that is set. A credential that is set but not listed is never
used. If none of the listed ones is set and the plan sends a step to the Claude CLI, the review stops before
it spends anything, with a message that names the order and what is set. A plan with no Claude step ignores
Claude credentials. A dry run never stops for this: it authenticates nothing.

**The default, when `credentials` is absent, is `["subscription", "api_key"]`.** This is a billing change
for anyone who has both a subscription and an API key: before, the Claude CLI preferred the key whenever
`ANTHROPIC_API_KEY` was set and the review billed per token; now the subscription runs and the key is not
used. Put `api_key` first to keep billing per token. With only one of them set, nothing changes.

The Claude child sees only the chosen credential, under the CLI's own name: `CLAUDE_CODE_OAUTH_TOKEN` for the
subscription, `ANTHROPIC_API_KEY` for the key. The other one, and `ANTHROPIC_AUTH_TOKEN`, are removed from its
environment. `ANTHROPIC_AUTH_TOKEN` is not a credential Crysk chooses: put an API key in `ANTHROPIC_API_KEY`
instead. How a run bills follows the choice: on the API key it is metered and the CI budget ceiling applies
(`$10` unless `budget-usd` says otherwise); on the subscription it draws on quota with no ceiling.

On macOS with `/usr/bin/security` present, a run on the subscription projects the Keychain OAuth record into
the child. A run on the API key attaches no Keychain broker at all. If the `Claude Code-credentials` item is
absent entirely, projection fails closed and the step does not run. If the Keychain item exists but the CLI
moved its OAuth record out of the expected shape, projection degrades (`#279`) and the child runs on the
run's own environment, which holds no API key on a subscription run, so it never bills a key the run did not
choose: it runs on whatever the Claude CLI's own credential store holds, and fails only if that is empty too.

## Verifying at $0

### `crysk config`

```
$ crysk config
  repo   <repo>/.crysk/config.json (absent)
  global ~/.crysk/config.json (present)

  agents_dir                default (unset)
  ...
  models                    global default=claude:sonnet-latest,
                            hunter.logic=opencode:deepseek/deepseek-v4-flash,claude:opus-latest
                            (effort high)
  credentials               global  claude=subscription,api_key
  max_changed_lines         global  3000
  post                      global  true
  ...

  repo beats global, except on a capped key — there the NARROWER value wins, so
  a committed file can spend less of your money but never more. capped means the
  repo asked for the wider value and the global ceiling took it away; default
  means neither file named the key, and the resolver's own fallback decides at
  run time.
```

### `crysk doctor`

The exact-binding probe: which binary, which credential kind, whether its projection is ready, and
what isolation actually holds — not a generic "is claude installed" check. Its Claude check applies the rule
a run chooses by: a `CRYSK_CLAUDE_OAUTH_TOKEN` or `CRYSK_CLAUDE_API_KEY` variable first, then the CLI's own
`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, then this machine's login (`~/.claude/.credentials.json`,
or on macOS the Keychain broker). `~/.claude.json` or `~/.claude/session.json` alone no longer count, and
neither does `ANTHROPIC_AUTH_TOKEN`; the hint names `CRYSK_CLAUDE_OAUTH_TOKEN` (from `claude setup-token`)
and `CRYSK_CLAUDE_API_KEY`.

```
$ crysk doctor
  [✓] claude: Claude Code CLI is installed and authenticated (2.1.281 (Claude Code))
  [!] provider:codegraph_policy_unenforced: no dedicated codegraph sensitive-file policy is
      enforced yet; isolation relies on --strict-mcp-config with a codegraph-only mcp.json
  ...
Environment is operational, but some optional tools or configurations are degraded.
```

### `crysk review --dry-run` — two caveats

- **In PR mode it returns before route admission.** `crysk review --pr <n> --dry-run` prints the
  plan and the cost band from the diff and the config alone, before any credential is projected or
  route bound, so a plan that would die immediately at admission (an OpenCode effort the model does not
  offer, a fallback with no executable) can still print a clean dry-run. Local dry-run resolves the
  route plan and admission first (`#120`), so it catches admission refusals. Neither stops for a missing
  Claude credential: a dry run authenticates nothing.
- **The cost band ignores billing mode.** It is a diff-size-and-agent-count estimate, calibrated from
  measured runs, not derived from a live route. It prints the same non-zero range on a `$0.00`
  subscription route as on a metered one — read it as "how big is this diff", not "what will this
  cost". A platform run's CI budget gate reads the platform's estimate instead, priced from the setup's
  models (see [GitHub Actions](github-actions.md)).

## What is proven for OpenCode, and what is not

OpenCode has completed real, end-to-end reviews — not a mock, not a fixture — but on narrow slices,
each ledgered live with real cost accounted:

- A subscription-style smoke (`#116`): one provider, one model, a 7-line diff, three hunters. All
  six conformance axes (auth, tools/MCP, terminal, usage, cleanup, provenance) verified live, at
  $0.00 cash. The refuter, scout, summarizer, parity hunter and codegraph/MCP integration were **not**
  exercised.
- The refuter on OpenCode (`#142`, item 1): closed — it ran, found the planted defect, and typed it
  correctly. It also returned `inconclusive` on a deterministic, 0-hop finding with two fabricated
  file citations — a real gap, but in `proof_refs` validation generally, not specific to OpenCode.
- A metered provider (`deepseek`) ran a real self-review at $0.06 and found a real issue the Claude
  arm on the same diff missed.
- A `provider_free` route completed a full PR-sized review (20 files, +365/−1987) at $0, wiring
  proven end to end — but it did roughly 1/17th the reading (input tokens) of a Claude control arm
  on the same diff and reported the same "nothing found" answer, which is weak evidence on a diff
  with no planted defect, not proof of equivalent quality.
- `zai` is code-path-identical to the proven `deepseek` route but unrun — no credential was
  available to prove it. `zai-coding-plan` (a flat-fee plan behind an API key) is priced `$0` by
  OpenCode's catalog, so it runs as `provider_free` with its own `auth.json` key projected
  (`#280`) — verified in code and tests, not in a live run.
- Codegraph/MCP integration on a target that actually has an index, and a fully parity-hunter- and
  scout-exercised run, remain unverified.

OpenCode is not a default backend. Treat it as proven for the slices above and unproven elsewhere.
