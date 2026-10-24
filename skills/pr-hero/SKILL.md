---
name: pr-hero
description: "Trigger: use or configure pr-hero locally — change the review model or backend (routing, OpenCode, DeepSeek, custom model), effort, credentials, config.json keys, gotchas.md, .prheroignore, size gate, run a review, pr-hero watch/gc, pr-hero doctor/config. Not CI (pr-hero-ci-setup) and not answering findings (pr-hero-triage)."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "1.0"
---

## Activation Contract

Load when the user wants to **operate or configure pr-hero on their machine or repo**:
- Change which model or backend reviews run on (a custom model, OpenCode, DeepSeek, a pinned snapshot).
- Tune effort, caps, the size gate, `.prheroignore`, `gotchas.md`, or any `config.json` key.
- Run a review (local branch or `--pr <n>`), understand its cost, or read its artifacts.
- Set up the watcher (`pr-hero watch`) or worktree GC (`pr-hero gc`).
- Diagnose a broken install or a refused run (`pr-hero doctor`, `pr-hero config`).

Route away: GitHub Actions, CI secrets, `PRHERO_ROUTING`, `/pr-hero review` comments → load `pr-hero-ci-setup`. Replying to posted `<!-- pr-hero-finding` comments → load `pr-hero-triage`.

## Source of Truth

This skill holds the mental model and the traps, not the reference. Before acting, read the live state, and for detail follow the linked section — do not answer from memory:
- `pr-hero config` — every key, its effective value, and **which layer decided it**. Read-only, $0.
- `pr-hero --help` — the installed version's real commands and flags.
- The docs on GitHub (they are not shipped in the npm package): [README](https://github.com/juanmaagd/pr-hero/blob/main/README.md), [configuration.md](https://github.com/juanmaagd/pr-hero/blob/main/docs/configuration.md).

If pr-hero is not on `PATH`, run every command as `npx -y pr-hero <command>` (Node is enough).

## Mental Model

- **Two config files, owned by different people.** `~/.prhero/config.json` is the person's (never committed); `<repo>/.prhero/config.json` is the team's (committed). `~/.prhero/watch.json` holds the watcher.
- **The one rule:** the repo file beats the global one, **except on capped keys** (`max_*`, and the on/off switches `summary.enabled`, `scout`, `post`): there the team can only ask for *less*, so a committed file never enlarges a person's bill.
- **Some keys live in exactly one layer** and the parser refuses the other by name: `routing` is person-only; `default_base`, `parity_trigger_paths`, `suspicion_priors` are repo-only. `--config <file>` replaces the repo layer only.
- **Flags always win**, and may exceed a cap (`--base`, `--agents`, `--model`, `--summary`/`--no-summary`, `--force`).
- **Models are logical names.** Bundled hunters declare `sonnet`, the refuter `opus`, the summarizer `haiku`. `routing` maps those names to a backend + provider; an unmapped name falls through to the Claude CLI.
- **pr-hero never stores a credential.** It reads the Claude CLI's auth, ambient Anthropic keys, or OpenCode's `auth.json`, and projects an ephemeral copy into each step.

## Hard Rules

- **Never print, `cat`, commit, or log credentials** — Keychain records, API keys, or `auth.json` contents. Inspect `auth.json` provider **keys and `type` only**.
- **Read before writing, verify after:** run `pr-hero config` before a change and again after it; finish with `pr-hero doctor`, and `pr-hero review --dry-run` when the change touches models or routing.
- **Prefer the CLI to hand edits:** scalar keys go through `pr-hero config set|unset <key> <val> [--person|--team|--watch]` (or `pr-hero config --edit`). `routing` is an object, so it is the one key written by hand into `~/.prhero/config.json` — keep the file valid JSON and preserve every other key.
- **Never spend without consent:** a real `pr-hero review`, `pr-hero watch install` (starts automatic spending) or `--force` past the size gate runs only after the user confirms. `--dry-run` variants are free.
- **Never invent a model id.** The bundled catalog only knows Anthropic aliases; any other provider's model must be spelled exactly as that provider names it, and a typo fails at the provider, not at pr-hero.
- **You cannot authenticate `claude` for the user.** If `doctor` reports it missing or unauthenticated, say so and stop.

## Recipes

**Custom model / backend** — [Routing](https://github.com/juanmaagd/pr-hero/blob/main/docs/configuration.md#routing)
1. Ask: which logical names to move (`sonnet` hunters, `opus` refuter, `haiku` summarizer, or a `default` for all), which backend (`claude-code`, `opencode`, …), which provider and exact model id, and whether metered spend is acceptable.
2. Write `routing.mappings` (or `routing.default`) in `~/.prhero/config.json`. An alias (`sonnet`/`opus`/`haiku`) routed anywhere except `claude-code` over `gateway: "direct"` **requires** `modelSnapshot` — see [modelFamily / modelSnapshot](https://github.com/juanmaagd/pr-hero/blob/main/docs/configuration.md#modelfamily--modelsnapshot).
3. Traps: two mappings matching the same name is an error, not first-wins; all OpenCode mappings in one run must use **one** provider; `disabled: true` / `allowSpend: false` refuse loudly instead of falling back.
4. Verify: `pr-hero config`, `pr-hero doctor`, then a **local** `pr-hero review --dry-run` (PR-mode dry-run returns before route admission, so it can look clean on a route that will be refused).

**Effort** — [Effort](https://github.com/juanmaagd/pr-hero/blob/main/docs/configuration.md#effort): set by the `effort:` frontmatter of a prompt in a custom `agents_dir` (`low|medium|high|xhigh|max`), never by a flag or env var. Defaults: hunters `xhigh`, refuter `high`. It applies to `claude-code` only; OpenCode records it as not applied.

**Credentials / billing** — [Credentials](https://github.com/juanmaagd/pr-hero/blob/main/docs/configuration.md#credentials): on macOS a `claude-code` route runs on the Keychain subscription and strips ambient `ANTHROPIC_API_KEY`; elsewhere an ambient key makes it metered. For OpenCode, only an `openai` entry of `type: "oauth"` is a subscription; every other provider is a metered API token unless its catalog prices the model at $0.

**Caps, size gate, exclusions** — [config.json keys](https://github.com/juanmaagd/pr-hero/blob/main/README.md#configjson-keys), [size gate](https://github.com/juanmaagd/pr-hero/blob/main/README.md#the-size-gate--a-cost-gate-not-a-quality-gate), [.prheroignore](https://github.com/juanmaagd/pr-hero/blob/main/README.md#prheroignore--repo-defined-exclusions): `max_changed_lines`/`max_changed_files` skip oversized diffs (a cost gate, not a quality one); `max_concurrent_steps` keeps the fan-out under a provider's rate limit; `max_verification_steps` (default `8`, `0` pauses) caps how many prior open findings a re-review spawns verifier steps for. Only the repo-root `.prheroignore` is read, and matching is case-sensitive.

**gotchas.md** — [gotchas.md](https://github.com/juanmaagd/pr-hero/blob/main/README.md#gotchasmd): required and must be real. Read the code and write the actual traps, then delete the `human-attention-required` marker line, or `review` and `doctor` refuse it.

**Running a review** — [Commands](https://github.com/juanmaagd/pr-hero/blob/main/README.md#commands): `.prhero/` must be committed or gitignored (clean-tree gate). Expect roughly $2–5 and ~10 minutes per typical PR; the printed band ignores billing mode. Artifacts land in `~/.prhero/repos/<origin>/runs/<run>/`. To check or wait on a PR's CI review state deterministically ($0, via `gh`), run `pr-hero status --pr <n> [--wait] [--json]`. To stop an in-flight review, run `npx -y pr-hero cancel --pr <n> [--override] [--wait] [--json]`.

**Watcher / GC** — [pr-hero watch](https://github.com/juanmaagd/pr-hero/blob/main/README.md#watching-prs-automatically--pr-hero-watch): `watch add [--post]`, preview with `watch --once --dry-run`, and only then `watch install`. `daily_cap` and `window` live in `~/.prhero/watch.json`. GC is separate: `pr-hero gc install`.

## Output Contract

Report back to the user:
1. What changed: the file and layer, and the keys touched (never credential values).
2. The `pr-hero config` lines proving the new effective value and its layer.
3. `doctor` / `--dry-run` result, and whether the next real run is subscription, metered, or free.
4. Anything left for the human: authenticating `claude`, committing `.prhero/`, confirming spend.
