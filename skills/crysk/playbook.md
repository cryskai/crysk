# Crysk on your machine

For local use: models, effort, credentials, config keys, review instructions, local reviews, the watcher and `doctor`.
GitHub Actions, `CRYSK_*` secrets and `/crysk` comments belong to `crysk-ci-setup`. Answering posted findings belongs to
`crysk-loop`.

Read the live state before acting, and do not answer from memory:

- `crysk config`: every key, its effective value and the layer that decided it.
- `crysk --help`: the installed version's commands and flags.
- [crysk.dev/docs](https://crysk.dev/docs/): every page is also Markdown at the same URL with `.md`, indexed by
  [llms.txt](https://crysk.dev/llms.txt).

If Crysk is not on `PATH`, run commands as `npx -y crysk@0.9.0 <command>`.

## Mental model

- **Two config files.** `~/.crysk/config.json` is the person's and is never committed. `<repo>/.crysk/config.json` is the
  team's and is committed. `~/.crysk/watch.json` holds the watcher. An install from before the rename may use `~/.prhero`;
  do not create `~/.crysk` by hand while it is in use.
- **The repo file beats the global one,** except on capped keys (`max_*`, `summary.enabled`, `materiality_gate`, `post`), where
  the team can only ask for less.
- **Some keys live in one layer:** `models` and `credentials` are person-only, `default_base` and `suspicion_priors` repo-only.
- **Flags win,** and may exceed a cap.
- **Models are per role.** `models` maps `default`, `hunter.<key>`, `refuter`, `consolidate`, `summary` or `judge` to one to
  three models tried in order, on provider failures only. A role not listed uses `default`, except `judge`, which runs only on
  its profile's judge models. Names: `claude:<sonnet|opus|haiku|fable>-latest`, a pinned `claude:claude-…`, or
  `opencode:<provider>/<model>`.
- **Crysk stores no credential.** It reads the Claude CLI's login, `CRYSK_CLAUDE_*` variables (or `ANTHROPIC_API_KEY` /
  `CLAUDE_CODE_OAUTH_TOKEN`) or OpenCode's `auth.json`. A run uses one Claude credential, the first set in
  `credentials.claude` (default `["subscription", "api_key"]`).

## Rules

- Never print, `cat`, commit or log credentials. Inspect `auth.json` keys and `type` only.
- Run `crysk config` before and after a change, and finish with `crysk doctor`. Add `crysk review --dry-run` when models or
  credentials changed. Use a local dry run: PR mode returns before route admission.
- Never spend without consent: a real `crysk review`, `crysk watch install`, or `--force` past the size gate needs the user's yes.
- A `--pr` review posts to the pull request when `--post` is passed or the config's `post` is true. Unless the user asked for that, pass `--no-post`, or use `--dry-run`.
- Never invent a model id. An OpenCode model must be spelled as `opencode models <provider>` lists it.
- You cannot authenticate `claude` for the user. If `doctor` says it is missing or signed out, say so and stop.

## Changing config

`models` and `credentials` are objects: edit `~/.crysk/config.json` by hand, keep it valid JSON, keep every other key.

`crysk config set <key> <value>` with `--person`, `--team` or `--watch` handles only some scalar keys, and refuses the rest.
With `--team` it replaces a team file it cannot parse, so check that the file is valid JSON first, or edit it by hand.

Example: `{"models": {"default": ["opencode:deepseek/deepseek-v4-flash", "claude:sonnet-latest"], "refuter": ["claude:opus-latest"]}}`.
Write `claude:sonnet-latest`, never `claude:sonnet`. A role takes at most 3 models, none twice. Each fallback can bill and take
the step's full time again.

**Effort** goes per model: `{"model": "claude:opus-latest", "effort": "max"}`. Claude levels are `low`, `medium`, `high`,
`xhigh` and `max`. On OpenCode it must be a variant `opencode models <provider> --verbose` lists.

**Size and scope:** `max_changed_lines` and `max_changed_files` skip oversized diffs (locally 4000 lines and 150 files).
`max_concurrent_steps` limits the fan-out, `max_verification_steps` limits re-review verification (default 8), and
`post_min_severity` sets the lowest finding posted. Only the repo-root `.cryskignore` is read, case-sensitively.

**Review instructions:** a root `REVIEW.md` wins over `.crysk/gotchas.md`. A file that exists must hold real facts and no
`human-attention-required` line, or `review` and `doctor` refuse it. With neither, the default guidance applies.

## Running

- **Review:** `.crysk/` must be committed or gitignored. Expect about ten minutes for a typical pull request. Output lands in
  `~/.crysk/repos/<origin>/runs/<run>/`. The engine prints no dollar figure, so confirming spend means saying which credential
  the run bills (`crysk doctor` and `--dry-run` show it).
- **A pull request's CI state:** `crysk status --pr <n> --wait --json`, read-only.
- **Watcher:** `crysk watch add`, preview with `crysk watch --once --dry-run`, and only then `crysk watch install`.
  `crysk gc install` is separate.

## Report

What changed (file, layer, keys, never credential values); the `crysk config` lines proving it; the `doctor` or `--dry-run` result
and whether the next real run is subscription, metered or free; and anything left for the human.
