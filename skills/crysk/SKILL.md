---
name: crysk
description: "Trigger: use or configure Crysk locally — change the review model or backend per role (models, fallback models, OpenCode, DeepSeek, custom model), effort, credentials order, config.json keys, REVIEW.md / gotchas.md, .cryskignore, size gate, run a review, `crysk watch/gc`, `crysk doctor/config`. Not CI (crysk-ci-setup) and not answering findings (crysk-loop)."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "1.0"
---

## Activation Contract

Load when the user wants to **operate or configure Crysk on their machine or repo**:
- Change which model or backend a step runs on (per role, with fallbacks: OpenCode, DeepSeek, a pinned Claude version).
- Tune effort, caps, the size gate, `.cryskignore`, `REVIEW.md` / `gotchas.md`, or any `config.json` key.
- Run a review (local branch or `--pr <n>`), understand its cost, or read its artifacts.
- Set up the watcher (`crysk watch`) or worktree GC (`crysk gc`).
- Diagnose a broken install or a refused run (`crysk doctor`, `crysk config`).

Route away: GitHub Actions, `CRYSK_*` secrets, `CRYSK_MODELS`, `/crysk review` comments → load `crysk-ci-setup`. Replying to posted `<!-- crysk-finding` comments → load `crysk-loop`.

## Source of Truth

This skill holds the mental model and the traps, not the reference. Before acting, read the live state, and for detail follow the linked section — do not answer from memory:
- `crysk config` — every key, its effective value, and **which layer decided it**. Read-only, $0.
- `crysk --help` — the installed version's real commands and flags.
- The docs on GitHub (they are not shipped in the npm package): [README](https://github.com/cryskai/crysk/blob/main/README.md), [configuration.md](https://github.com/cryskai/crysk/blob/main/docs/configuration.md).

If Crysk is not on `PATH`, run every command as `npx -y crysk <command>` (Node is enough). An install from before the rename (the package used to be `pr-hero`) still answers to `pr-hero`; either command is the same program.

## Mental Model

- **Two config files, owned by different people.** `~/.crysk/config.json` is the person's (never committed; `~/.prhero/config.json` on an install from before the rename — never create `~/.crysk` by hand while `~/.prhero` is in use, the CLI would switch homes); `<repo>/.crysk/config.json` is the team's (committed). `~/.crysk/watch.json` holds the watcher.
- **The one rule:** the repo file beats the global one, **except on capped keys** (`max_*`, and the on/off switches `summary.enabled`, `scout`, `materiality_gate`, `post`): there the team can only ask for *less*, so a committed file never enlarges a person's bill.
- **Some keys live in exactly one layer** and the parser refuses the other by name: `models` and `credentials` are person-only; `default_base`, `parity_trigger_paths`, `suspicion_priors` are repo-only. `--config <file>` replaces the repo layer only.
- **Flags always win**, and may exceed a cap (`--base`, `--agents`, `--model`, `--summary`/`--no-summary`, `--force`).
- **Models are assigned per role.** `models` maps a role (`default`, `hunter.<key>` per hunter, `refuter`, which also covers the re-review verifier and the CI adjudicator, `consolidate`, `scout`, `summary`, `judge`) to a list of one to three models tried in order; a role not listed uses `default`. With no `models`, each step runs its prompt's model: hunters, consolidation and scout `claude:sonnet-latest`, the refuter `claude:opus-latest`, the summarizer `claude:haiku-latest`. A model name carries its backend: `claude:<sonnet|opus|haiku|fable>-latest` (newest version), `claude:claude-…` (pinned), `opencode:<provider>/<model>`. The old `routing` key is gone and refused with the `models` form to write; `summary.model` is gone too (`"haiku"`, which `crysk init` used to write, still reads with a warning).
- **Crysk never stores a credential.** It reads the Claude CLI's login, `CRYSK_CLAUDE_*` (or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`) variables, or OpenCode's `auth.json`, and projects an ephemeral copy into each step. A run uses one Claude credential, the first set in `credentials.claude` (default `["subscription", "api_key"]`).

## Hard Rules

- **Never print, `cat`, commit, or log credentials** — Keychain records, API keys, or `auth.json` contents. Inspect `auth.json` provider **keys and `type` only**.
- **Read before writing, verify after:** run `crysk config` before a change and again after it; finish with `crysk doctor`, and `crysk review --dry-run` when the change touches models or credentials.
- **Prefer the CLI to hand edits:** scalar keys go through `crysk config set|unset <key> <val> [--person|--team|--watch]` (or `crysk config --edit`). `models` and `credentials` are objects, so they are written by hand into `~/.crysk/config.json` — keep the file valid JSON and preserve every other key.
- **Never spend without consent:** a real `crysk review`, `crysk watch install` (starts automatic spending) or `--force` past the size gate runs only after the user confirms. `--dry-run` variants are free.
- **Never invent a model id.** The bundled catalog only knows the Claude aliases; an OpenCode model must be spelled exactly as `opencode models <provider>` lists it, and a typo fails at the provider, not at Crysk.
- **You cannot authenticate `claude` for the user.** If `doctor` reports it missing or unauthenticated, say so and stop.

## Recipes

**Models per role** — [Models](https://github.com/cryskai/crysk/blob/main/docs/configuration.md#models), [Fallback models](https://github.com/cryskai/crysk/blob/main/docs/configuration.md#fallback-models)
1. Ask: which roles to move (`default` for all, or `hunter.<key>`, `refuter`, `summary`, …), which model for each and which fallbacks, and whether metered spend is acceptable.
2. Write `models` in `~/.crysk/config.json` (or `~/.prhero/config.json` if that is the home in use), e.g. `{"models": {"default": ["opencode:deepseek/deepseek-v4-flash", "claude:sonnet-latest"], "refuter": ["claude:opus-latest"]}}`. Write `claude:sonnet-latest`, never a bare `claude:sonnet` (refused); a full `claude-*` id pins a version.
3. Traps: at most 3 models per role and none twice; a role not listed uses `default`, except the materiality judge, which runs only `claude:sonnet-latest` or `claude:opus-latest` and never inherits `default`; the next model is tried only on a provider failure (rate limit, quota, network, timeout, model unavailable; a refused login skips the models on the same credential), never on a bad answer; each fallback can bill and take the step's full time again. Several OpenCode providers may be mixed in one review. A local `auth.json` `openai` record must be `type: "oauth"` (the subscription); an `openai` API key there is refused.
4. Verify: `crysk config`, `crysk doctor`, then a **local** `crysk review --dry-run` (PR-mode dry-run returns before route admission, so it can look clean on a plan that will be refused).

**Effort** — [Effort](https://github.com/cryskai/crysk/blob/main/docs/configuration.md#effort): per model, as a `models` entry `{"model": "claude:opus-latest", "effort": "max"}`; otherwise the `effort:` frontmatter of a prompt in a custom `agents_dir`, then the role default (hunters `xhigh`, refuter `high`). Claude levels are `low|medium|high|xhigh|max` (`ultracode` is refused). On OpenCode the effort is the model's variant, as OpenCode names it; the review refuses, before spending, a variant `opencode models <provider> --verbose` does not list. The `#variant` suffix is gone. `models.judge` and `--model` take no effort.

**Credentials / billing** — [Credentials](https://github.com/cryskai/crysk/blob/main/docs/configuration.md#credentials): one Claude credential per run, the first set in `credentials.claude` (default `["subscription", "api_key"]`; on macOS a Claude login always counts as the subscription). To bill an API key with a login present, write `{"credentials": {"claude": ["api_key", "subscription"]}}`. The Claude child sees only the chosen one. For OpenCode on this machine, only an `openai` entry of `type: "oauth"` is a subscription; every other provider is a metered API token unless its catalog prices the model at $0.

**Caps, size gate, exclusions** — [config.json keys](https://github.com/cryskai/crysk/blob/main/README.md#configjson-keys), [size gate](https://github.com/cryskai/crysk/blob/main/README.md#the-size-gate--a-cost-gate-not-a-quality-gate), [.cryskignore](https://github.com/cryskai/crysk/blob/main/README.md#cryskignore--repo-defined-exclusions): `max_changed_lines`/`max_changed_files` skip oversized diffs (a cost gate, not a quality one); `max_concurrent_steps` keeps the fan-out under a provider's rate limit; `max_verification_steps` (default `8`, `0` pauses) caps how many prior open findings a re-review spawns verifier steps for. `post_min_severity` (`suggestion` | `warning` | `blocking`, unset posts everything; `setup --ci` writes `warning`) is the lowest finding a PR review posts: hidden findings get no comment and the summary counts them, the gate is unchanged (a blocking finding always posts), and re-review admission scores only what was posted. Only the repo-root `.cryskignore` is read, and matching is case-sensitive.

**REVIEW.md / gotchas.md** — [REVIEW.md and gotchas.md](https://github.com/cryskai/crysk/blob/main/README.md#reviewmd-and-gotchasmd): optional; a root `REVIEW.md` wins over `.crysk/gotchas.md`. A file that exists must be real: read the code and write the actual traps, then delete the `human-attention-required` marker line, or `review` and `doctor` refuse it. With neither file the review runs on the default guidance.

**Running a review** — [Commands](https://github.com/cryskai/crysk/blob/main/README.md#commands): `.crysk/` must be committed or gitignored (clean-tree gate). Expect roughly $2–5 and ~10 minutes per typical PR; the printed band ignores billing mode. Artifacts land in `~/.crysk/repos/<origin>/runs/<run>/`. To check or wait on a PR's CI review state deterministically ($0, via `gh`), run `pr-hero status --pr <n> [--wait] [--json]`.

**Watcher / GC** — [crysk watch](https://github.com/cryskai/crysk/blob/main/README.md#watching-prs-automatically--crysk-watch): `watch add [--post]`, preview with `watch --once --dry-run`, and only then `watch install`. `daily_cap` and `window` live in `~/.crysk/watch.json`. GC is separate: `crysk gc install`.

## Output Contract

Report back to the user:
1. What changed: the file and layer, and the keys touched (never credential values).
2. The `crysk config` lines proving the new effective value and its layer.
3. `doctor` / `--dry-run` result, and whether the next real run is subscription, metered, or free.
4. Anything left for the human: authenticating `claude`, committing `.crysk/`, confirming spend.
