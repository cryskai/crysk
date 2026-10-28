# pr-hero

A multi-agent PR-review engine. Specialty hunter agents fan out in parallel over a repo checkout and
its diff, a mechanical dedupe merges their drafts, an adversarial refuter challenges every severe
finding, and deterministic code — never a model — assigns blocking/advisory tiers.

Its measured profile, stated up front: **high precision, narrow coverage**. What it reports is
almost always real (13% false positives measured); it specializes in lifecycle and state-machine
defects — stuck loading latches, missing cleanups, re-entrancy, stalls — and says nothing about
style or convention. Locally it is an **assistant, not a merge gate**: every report closes with that
disclaimer, and nothing it prints blocks a merge. In CI its commit status is a gate by default: require the
`pr-hero` check in branch protection, and blocking findings block the merge. `mode: advisory` keeps that check
green.

## Two ways to use it

- **Local CLI**: install pr-hero on your machine and review branches or PRs from your terminal.
  Start at [Requirements](#requirements).
- **CI only, no local install**: install the skills into your coding agent, add one workflow file
  to the repository, and every pull request is reviewed in GitHub Actions. Nothing below
  Requirements applies to this path. It is described next.

### CI only: skills plus one workflow

You need Node (for `npx`), an authenticated `gh`, and a GitHub repository with Actions enabled. You do
**not** need Bun, the Claude Code CLI, or a global pr-hero install: the review runs on the GitHub
runner, which installs its own runtime. `npx -y pr-hero setup --ci` checks `gh` for you: when it is
missing or logged out, it says why it is needed and prints the commands, and in a terminal it offers
to install it (macOS with Homebrew) and to run `gh auth login`. It never blocks the setup.

1. **Install the skills** into your coding agent from [skills.sh](https://skills.sh/juanmaagd/pr-hero):

   ```bash
   npx skills add juanmaagd/pr-hero
   ```

   `pr-hero-ci-setup` sets up the workflow, `pr-hero-pr` opens a PR and waits for its review, and
   `pr-hero-triage` answers the findings. `pr-hero` covers the local CLI, which this path does not use.

2. **Ask your agent to set up pr-hero CI** in the repository. `pr-hero-ci-setup` first asks you how
   re-reviews should work: a level (minimal, balanced, thorough or manual), gate or advisory, how CI
   pays (a subscription gets no spend ceiling, an API key gets one you choose), the changed-lines
   threshold above which a PR is skipped (default 4000, on any billing), and whether to tune the
   advanced settings (score weights, observe-only, trusted actors, files limit, exclusions). Then it runs
   `npx -y pr-hero setup --ci` with your answers (writes `.github/workflows/pr-hero.yml` and the
   level's keys in `.prhero/config.json`, and prints a summary) and `npx -y pr-hero init`
   (writes `.prhero/gotchas.md`), writes the repository gotchas, and stores
   one secret with `gh secret set`: `CLAUDE_CODE_OAUTH_TOKEN` (subscription; `claude setup-token`
   prints it on any machine that has the Claude Code CLI, so this one does not need it) or
   `ANTHROPIC_API_KEY` (pay as you go). Without an agent, run the same
   commands yourself and follow the [Quick path](docs/github-actions.md#quick-path).

3. **Merge the workflow and `.prhero/` into the default branch.** A comment-triggered run
   (`/crysk review`) reads both from the base branch, so it starts nothing until the workflow is
   there, and fails `PRH-GOTCHAS-MISSING` until `.prhero/` is.
   Then require the `pr-hero` status check in branch protection if you want it to block merges.

4. **Open pull requests as usual.** Every new PR gets a review posted as PR comments; later pushes
   follow the level you chose (balanced re-reviews a push only when it is risky or the last pass
   found enough, at most 2 automatic passes), and a PR above the size threshold is skipped. Comment
   `/crysk review` to review a skipped push anyway. Ask your agent
   to open the PR (`pr-hero-pr`), and it waits for the review with `npx -y pr-hero status --pr <n>
   --wait --json`, then hands the findings to `pr-hero-triage`, which replies to each one in its
   thread and pushes the fixes.

Everything about the workflow (credentials, OpenCode routing, spend limits, the gate, error codes)
is in [`docs/github-actions.md`](docs/github-actions.md).

## Requirements

These apply to the local CLI. The [CI-only path](#ci-only-skills-plus-one-workflow) needs none of them
on your machine.

pr-hero does not call any model API of its own. It **spawns the Claude Code CLI as a subprocess** and
inherits that CLI's authentication. `claude` is the engine; everything else here is plumbing.

| Dependency | Needed for | Without it |
| --- | --- | --- |
| **Claude Code CLI**, installed *and authenticated* | everything | nothing runs — it is the engine |
| **git** | everything | nothing runs |
| **Bun ≥ 1.3** on `PATH` | install options B and C only | option A carries its own runtime |
| **GitHub CLI (`gh`)**, authenticated | `review --pr`, `--post`, `watch`, `reverts`, `corpus` | local review still works in full |
| **codegraph** | optional code intelligence | hunters navigate with git and grep, with less structural context |

Run `pr-hero doctor` first: it checks every one of these and prints what is missing. The one thing it
cannot check is Bun — on an npm or source install the launcher itself is a Bun script, so a missing
Bun fails *before* any pr-hero code runs, with `env: bun: No such file or directory`. Install Bun
(`brew install oven-sh/bun/bun`, or `curl -fsSL https://bun.sh/install | bash`) or use option A,
whose binary needs no Bun on your machine.

### What a review bills against

pr-hero inherits whatever authentication your `claude` CLI already uses:

- **Signed in with a Claude subscription** → runs consume your **subscription quota**. No per-token
  invoice arrives.
- **`ANTHROPIC_API_KEY` exported in the environment** → `claude` picks it up and the same runs are
  **billed as API usage**.

The dollar figures pr-hero prints — the cost band before a run, `pr-hero usage` after one — are
always a **token-derived estimate**, because that is the only unit comparable across both models. On
a subscription, read them as "how much of my window will this consume", not as a bill. If you keep an
`ANTHROPIC_API_KEY` in a project `.env`, be deliberate about sourcing it into the shell you launch
pr-hero from: that single step is what moves a run from quota to invoice.

## Installation

```bash
# Option A: Standalone binary (macOS / Linux, bundles its own Bun — still needs claude and git)
curl -fsSL https://raw.githubusercontent.com/juanmaagd/pr-hero/main/install.sh | bash

# Option B: Global npm install (brings Bun 1.3.14 as an optional dependency, or uses
# the Bun >= 1.3 on PATH when npm skips optional dependencies)
npm install -g pr-hero

# Option D: No install, for an agent or a one-off run (needs only Node). It cannot
# register the MCP server or the launchd agents: npx's cache is temporary, so those
# refuse and ask for option B. The launcher uses the bundled Bun only when it runs
# (`bun --version` is checked first), otherwise the Bun on PATH, and exits 127 naming both if neither works.
npx pr-hero doctor

# Option C: From source / development (the bin runs on Node; on a machine with Bun
# and no Node, run `bun bin/pr-hero.js` or use option A)
git clone https://github.com/juanmaagd/pr-hero.git && cd pr-hero
bun install && bun link
```

See [Requirements](#requirements) above — `claude` and `git` are needed by every option.

## From install to first review

Only want the CI review? You do not need to install anything: see [GitHub Actions — Quick path](docs/github-actions.md#quick-path) (`npx -y pr-hero setup --ci`, `npx -y pr-hero init`, one secret).

Seven steps, in this order. Steps 2, 5 and 6 are the ones that get skipped, and
each one breaks the step after it.

```bash
# 1. Install (option A shown; B and C put pr-hero on PATH themselves)
curl -fsSL https://raw.githubusercontent.com/juanmaagd/pr-hero/main/install.sh | bash

# 2. Put it on THIS shell's PATH. The installer edited your rc file, and an rc
#    file only reaches shells started after it — the one you are in is not one.
export PATH="$HOME/.prhero/bin:$PATH"     # fish: set -gx PATH $HOME/.prhero/bin $PATH

# 3. What is installed, what is missing, what blocks a review.
pr-hero doctor

# 4. Skills + MCP registration, and — inside a git repo — scaffold .prhero/.
cd /path/to/your-repo && pr-hero setup

# 5. Track that scaffold, or ignore it. Local review refuses to run on a dirty
#    tree, and an untracked .prhero/ is a dirty tree.
git add .prhero && git commit -m "chore: pr-hero config"   # or: echo '.prhero/' >> .gitignore

# 6. Replace the placeholder gotchas with real ones. Not paperwork — see below.
$EDITOR .prhero/gotchas.md

# 7. Review the checked-out branch against its merge base.
pr-hero review
```

**On step 4.** `setup` is fully non-interactive — it asks nothing and is safe to run
unattended. It is also optional for reviewing: `review` never checks whether it ran,
only `pr-hero doctor` reports it. What it buys is the skills, the MCP registration and
the repo scaffold; skip it and you scaffold the repo yourself with `pr-hero init`. It does
**not** commit or `.gitignore` what it scaffolds, which is why step 5 exists.

**Skill drift.** `setup` (and `upgrade`) installs the bundled skills into each agent's skills
directory. A skill copy that differs from the bundled one and has no recorded digest is kept as it is and reported as drift, never overwritten, so your local edits survive; `pr-hero setup` prints each kept skill, and `pr-hero upgrade` replaces it.

**Skills without pr-hero.** The public skills are also on
[skills.sh](https://skills.sh/juanmaagd/pr-hero), installable into any agent with the
[skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add juanmaagd/pr-hero                            # pick interactively
npx skills add juanmaagd/pr-hero --skill pr-hero            # or pr-hero-pr, pr-hero-triage, pr-hero-ci-setup
```

**On step 6.** `gotchas.md` is injected verbatim into every hunter's system prompt, and
what `setup`/`init` write there is a placeholder: `- <subsystem>: <the thing that looks
like a bug but is deliberate, and why>`. A review that reads *that* is a review billed in
full by hunters who know nothing about your repo, and it comes back looking clean. So
pr-hero refuses to run while the scaffold's `human-attention-required` marker line is
still present. Write a handful of true lines, delete the marker.

Other entry points, once the above works:

```bash
pr-hero                          # the interactive TUI menu, in a TTY
pr-hero review --pr              # the current branch's PR, in an isolated worktree
pr-hero review --pr 123          # any PR by number
```

> **Breaking change in v2.0**: Invoking `pr-hero` with zero arguments in a TTY now opens the **interactive TUI menu** instead of implicitly starting a local `review`. In non-interactive environments, it prints the help text and exits with code 2. Set `PRHERO_NO_TUI=1` to bypass the TUI in automation.

Every paid run prints a plan and a cost band, then asks for confirmation (`--yes` skips the prompt).

### For AI agents

You are most likely here because someone told you to install pr-hero and review a repo.
Four things go wrong when an agent runs the sequence above:

1. **Step 2 is not optional, and not deferrable.** If each of your commands runs in its own
   shell, an `export PATH=...` in one does not reach the next. Either prepend the export to
   every pr-hero invocation, or call the binary by absolute path: `~/.prhero/bin/pr-hero`.
2. **Step 5 is yours.** `pr-hero setup` scaffolds `.prhero/` and neither commits nor
   ignores it, so the next `pr-hero review` fails the clean-tree gate — on files `setup`
   itself created. Commit them or add `.prhero/` to `.gitignore` before reviewing.
3. **Write the gotchas yourself (step 6).** You have the repository in context, which makes
   you the best gotchas author available. Read the code and write the real ones: the
   deliberate oddity that looks like a bug, the invariant enforced in a file the diff never
   shows, the ownership rule a newcomer would violate. Leaving the placeholder is not a
   softer option — the review is refused until you replace it and delete the
   `human-attention-required` marker line.
4. **You cannot authenticate `claude`. Stop and ask the human.** pr-hero spawns the Claude
   Code CLI and inherits its authentication; there is no pr-hero-side key to set. If
   `pr-hero doctor` reports `claude` missing or unauthenticated, say so and wait — every
   step after it fails until a person fixes it.

## Configuration — two layers

There are two config files, and the difference between them is *who they belong to*:

| File | Whose | Committed? |
| --- | --- | --- |
| `~/.prhero/config.json` | **yours**, across every repo on this machine | no — it is your machine |
| `<repo>/.prhero/config.json` | **the team's** | yes, normally — it is shared through git |

`pr-hero init` creates the repo file and `gotchas.md`, and never overwrites existing ones —
`pr-hero setup` scaffolds the same two files when it runs inside a git repo, so a repo you set up
needs no separate `init`. (Running `init` afterwards is harmless: it keeps what exists and reprints
the git reminder.) Commit `.prhero/` or add it to `.gitignore` — an untracked one trips local
mode's clean-tree gate.

**Run `pr-hero config` to see which layer decided what.** It lists every key with its value, the
layer it came from, and both file paths whether or not they exist. It never edits anything.

Routing a model to a specific backend/provider, and how pr-hero reads credentials for each backend,
are their own topic — see [`docs/configuration.md`](docs/configuration.md).

### The one rule

> The more specific layer wins — **except** where the less specific one is protecting your money.

So the team file usually beats your global one. The exception exists because a committed file must
never be able to enlarge *your* bill: on the two keys that spend, the team can only ask for **less**.

### `config.json` keys

| Key | Where it can live | What it does |
| --- | --- | --- |
| `agents_dir` | both | Directory holding the agent prompt files (`deep-review-*.md`, `review-*.md`). Relative paths resolve against **the file that named it**. |
| `default_base` | **repo only** | Base ref when `--base` is not given (e.g. `"dev"`). Without it: the remote head (`origin/HEAD`), then `main`. Rejected in the global file on purpose — see below. |
| `parity_trigger_paths` | **repo only** | Glob list. The parity hunter runs only when a changed path matches one — no globs, no parity hunter. |
| `suspicion_priors` | **repo only** | `[{path, weight, reason}]` hints injected into hunter prompts — point them at your known hotspots. |
| `summary.enabled` | both — team may only turn it **off** | Whether the engine-owned summarizer runs. Defaults to `true`, because it spends money and a silent opt-out would make the bill differ from the plan. |
| `summary.model` | both | Model for that step. Defaults to whatever `prompts/summarizer.md` declares (`haiku`). |
| `max_verification_steps` | both — team may only **lower** it | Cap on re-review verification spawns (item 7). Defaults to `8`; `0` is legal and pauses verification. |
| `max_concurrent_steps` | both — team may only **lower** it | Cap on steps (hunters, refuters, verify, scout, summarizer) in flight at once. Unset means unlimited. Set it below a provider's concurrency limit (e.g. `8` for one that allows 10 in-flight requests) so a refuter fan-out does not draw HTTP 429s. |
| `max_changed_lines` | both — team may only **lower** it | Line budget threshold before the size gate skips a review. Defaults to `4000`; `0` disables line budget check. |
| `max_changed_files` | both — team may only **lower** it | File count budget threshold before the size gate skips a review. Defaults to `150`; `0` disables file budget check. |
| `scout` | both — team may only turn it **off** | Whether the reconnaissance scout hunter runs before review. Defaults to `false`. |
| `post` | both — team may only turn it **off** | Whether review reports publish as GitHub PR comments by default. Defaults to `false`. |

**Why `default_base` is repo-only, since it is the one restriction that looks arbitrary:** the
resolver checks the config value *before* the remote head. A global `default_base` would therefore
preempt autodetection on every repo that stays quiet, so the first repo whose default branch differs
would silently review the wrong commit range — with a plausible branch name on the plan card.

**Flags always win, and may exceed a cap.** A flag is you typing an intent in front of the cost band,
which is a different thing from a committed file asking on your behalf. `--agents` overrides
`agents_dir` (then the repo file, then the global, then `PRHERO_AGENTS_DIR`); `--base` overrides
`default_base`; `--summary` / `--no-summary` and `--model` override the summary keys.

### `gotchas.md`

Repo-specific traps the hunters must know (fragile invariants, deliberate oddities, past incidents).
**Required, and it must be real** — not merely non-empty. The file `init`/`setup` scaffold carries a
`human-attention-required` marker line, and `review` and `doctor` both refuse it by name: a
placeholder passes any emptiness check while telling every hunter nothing, which buys a full-price
review that reports clean. Replace the `<subsystem>` lines with facts about your repo, then delete
the marker line. Reviewing a tree you cannot write to? Supply it from outside with
`--gotchas <file>` (and `--config <file>`).

## Commands

| Command | What it does |
| --- | --- |
| `pr-hero` / `pr-hero menu` | Open the interactive terminal user interface (TUI) with context-aware navigation, review launcher, and submenus. |
| `pr-hero review` | Review the checked-out branch against the merge base with `--base`. Requires a clean tree sitting on `--head` (default `HEAD`). |
| `pr-hero review --pr [n]` | Review a GitHub PR: by number, or — bare, no number — the PR that belongs to the current branch (errors loudly if it has none). Resolves the range through `gh`, runs in a detached worktree with its own codegraph index, then records the result in the run's `findings.json`. |
| `pr-hero review --pr <n> --post` | Same, then publish the report as **one** marked PR comment — re-runs update it in place, never stack. |
| `pr-hero doctor` | Run diagnostic environment and dependency checks (git, claude auth, gh, codegraph, config). Works inside or outside a repository. |
| `pr-hero setup` | Machine-level onboarding: skill synchronization and MCP registration — and, when run inside a git repo, it also scaffolds that repo's `.prhero/config.json` and `.prhero/gotchas.md`, so no separate `init` is needed there. Fully non-interactive. It does **not** commit or `.gitignore` what it scaffolds; do that yourself before reviewing. |
| `pr-hero activity [--kill <pid>]` | Inspect running reviews (with elapsed time, PID, repo/PR), watcher spend against daily cap, and completed run history. `--kill <pid>` safely terminates a running review. |
| `pr-hero post --pr <n> --from <run-dir>` | Replay-publish a previous run's findings onto the PR (same plan as `--pr --post`). `--dry-run` previews at $0. |
| `pr-hero triage reply --pr <n> --from <run-dir> --finding F00N --tag <tag> --body-file <path>` | Post one triage reply. The driver picks the parent from the posted `<!-- crysk-finding` marker (never path/line), renders the marker + badge, posts, and resolves the inline review thread. Reads `anchor.patch` (else `diff.patch`) from the run dir to remap post lines the same way `--post` does. `--body-file` is reasoning only. |
| `pr-hero status --pr <n> [--wait] [--json]` | Read-only, through `gh` only: the PR's pr-hero gate, its posted findings, and a `next_action` (`wait`, `review`, `triage`, `fix`, `recheck`, `override-or-fix`, `done`). `--wait` polls until an in-flight or newly-triggered review settles before emitting (a review that has not posted its first status within 3 minutes is not waited for: counted from the `/pr-hero` comment, or, after a push, from when `--wait` starts; a run still queued after that returns the current status); `--json` prints one `pr-hero.status/v1` object on stdout. See [`docs/github-actions.md`](docs/github-actions.md#reading-a-pr-with-pr-hero-status). |
| `pr-hero config` | Read-only, $0: every config key with its value and **which layer decided it** (`repo` / `global` / `capped` / `default`), plus both file paths whether or not they exist. |
| `pr-hero config set <key> <val> [--person\|--team\|--watch]` | Set a scalar configuration value in the selected layer (defaults to `--person`). Capped team keys accept and annotate over-ceiling values. |
| `pr-hero config unset <key> [--person\|--team\|--watch]` | Remove a configuration value from the selected layer. |
| `pr-hero config --edit` | Open the interactive configuration editor across Person, Team, and Watcher layers with buffered draft editing, Save/Discard/Clear actions, and capped ceiling annotations. |
| `pr-hero upgrade [--check]` | Upgrade `pr-hero` to the latest release and reconcile installed skills and MCP registrations. `--check` checks for updates without installing. |
| `pr-hero uninstall [--purge]` | Managed uninstallation: unloads launchd background daemons, cleans up skills, unregisters MCPs, and optionally purges `~/.prhero` with `--purge`. |
| `pr-hero init` | Scaffold `.prhero/` in the current repo — the command for every repo after the one you ran `setup` in. Omits keys your global file already supplies, so a new repo does not re-state what you have already said once. Idempotent: existing files are kept untouched, and it reprints the commit-or-ignore reminder. |
| `pr-hero watch add` | Opt the current repo (or `--repo <path>`) into the watcher; `--post` makes its reviews publish to the PR. Idempotent — re-adding updates the post flag. See [Watching PRs automatically](#watching-prs-automatically--pr-hero-watch). |
| `pr-hero watch remove` | Take the current repo (or `--repo <path>`) back out. Idempotent — removing what is not listed just says so. |
| `pr-hero watch status` | Read-only, $0: config summary, today's launches vs the cap, launchd state, lock, last activity. |
| `pr-hero watch --once` | Run ONE watcher tick: scan the watched repos, pick the next unreviewed open PR, review it. `--dry-run` shows the whole decision for $0. |
| `pr-hero watch install` | Install the macOS launchd agent that runs a tick every `--interval` minutes (default 15). **This is the opt-in to automatic spend.** |
| `pr-hero watch uninstall` | Unload and remove that agent. |
| `pr-hero gc` | Collect worktrees under `~/.prhero` that are merged/closed or idle >72h. `--dry-run` prints the table and removes nothing. `--repo <clone>` scopes to one origin; default is the whole home. Also removes leftover verified execution snapshots under `$TMPDIR/prhero-exec-snapshots` (dead owner process or older than 6h). |
| `pr-hero gc install` | Install the macOS launchd agent that runs `pr-hero gc` every `--interval` minutes (default 360 = 6h). No reviews, no `watch.json`, no daily cap — the $0 sweeper so trees do not wait for a review or the watcher. |
| `pr-hero gc uninstall` | Unload and remove that GC agent. |
| `pr-hero gc status` | Read-only, $0: whether the GC agent is installed, its interval, plist, and tick log. |
| `pr-hero usage [--all]` | Read-only, $0: print the observability store's per-run rows (cost, tokens, findings) — every completed review, local and PR, auto-ingests into one global `~/.prhero/metrics.db`. Scoped to the current checkout's origin by default; `--all` shows every origin instead. |

Flags worth knowing: `--dry-run` (plan + cost band, creates nothing), `--yes`, `--model <m>`,
`--scout` / `--no-scout` (toggle pre-hunt reconnaissance scout),
`--no-shared-prefix` (turn off the default shared hunter prefix: hunters share one cached system prompt
holding the patch, their roles move to the user message and a one-turn warm-up writes the cache first; Anthropic routes only,
since other providers already cache each hunter's own loop),
`--post` / `--no-post` (toggle PR comment publishing),
`--force` (local only: review this diff even when the size gate would skip it;
in GitHub Actions the same forced re-review is a `/crysk review` comment on the pull request,
which runs on the Actions runner; `/crysk override` instead unlocks a red gate with no review),
`--full` (run un-capped refuter verification steps),
`--no-summary` (skip the summarizer; see `summary` in config above),
`--out <dir>` (run dir for `review`),
`--all` (`usage` only: every origin instead of just this checkout's).
`pr-hero --help` lists everything.

### PR mode, in one paragraph

`--pr` resolves the range from the PR itself: a merged PR diffs from its merge commit's first parent
(the base as it was when the PR landed — merge, squash and rebase all converge at the fork point),
an open one from the recorded base tip. The review runs in a worktree at
`~/.prhero/repos/<origin>/worktrees/pr-<n>` — your checkout, your index and your uncommitted work are
never touched, and reviews run while you keep working. Two checkouts of the same GitHub repo share
one worktree. Worktrees are kept and reused across re-runs until GC (`pr-hero gc`: merged/closed or
72h idle). That collector is not a background timer — it runs when you invoke it, at the end of
`review --pr`, on a watcher tick, or on a schedule via `pr-hero gc install` (macOS launchd, default
every 6h, no reviews, no `watch.json`). Each run prints the cleanup command (`git worktree remove --force …` — never `rm -rf`, a live
codegraph daemon holds a socket in there).

## When to run it

Reviews launch two ways: **by hand**, or through the opt-in local watcher (`pr-hero watch`, below)
— nothing else ever fires on its own. The two moments where a manual run makes sense:

1. **Before opening the PR** — `pr-hero review` on your branch. The cheapest moment to catch
   something: you are still in context and nothing is published yet.
2. **On an existing PR** — the moment it opens, standing on its branch, the whole command is:

   ```bash
   pr-hero review --pr --post
   ```

   Bare `--pr` resolves the branch's own PR (loud error if there is none), the review runs in its
   worktree while you keep working, and `--post` publishes the one marked comment. A PR number works
   anywhere (`--pr <n>`), no matter what you have checked out.

### Automation and CI — status

| Stage | Status |
| --- | --- |
| Manual CLI (`review`, `--pr`, `--post`) | **Available now** — this README. |
| Auto-trigger on new PRs / new pushes (local watcher) | **Available now** — `pr-hero watch`, below. Deliberately opt-in: every review spends real money, so nothing fires until you `watch add` a repo AND `watch install` the agent. |
| CI mode (GitHub Actions) | **Available now** — official `action.yml` at the repo root, canonical `.github/workflows/pr-hero.yml`, full setup in [`docs/github-actions.md`](docs/github-actions.md). The commit-status gate (`mode: gate`, the default; `mode: advisory` opts out), exit 0 on findings, the size/budget gates, and `pr-hero setup --ci` scaffolding all apply. |
| Required status check that blocks merges | **Available in CI** — the `pr-hero` commit status is the check (`mode: gate`, the default). Require it in branch protection. Fail-closed for a head with no run stays deferred. |

## Watching PRs automatically — `pr-hero watch`

The watcher is a **tick, not a daemon**: `pr-hero watch --once` makes one pass — list open PRs in
each configured repo, skip what is already covered, launch **at most one** review — and exits.
launchd (installed below) fires a tick every N minutes and is the supervisor. Drafts are skipped,
and each PR is reviewed **once** by default — see the `on_push` knob below.

### Opt in

```bash
cd /path/to/your-repo
pr-hero init             # once per repo, if .prhero/ does not exist yet
pr-hero watch add --post # opt THIS repo in; --post publishes each review to its PR
pr-hero watch install    # start ticking — this is the moment automatic spending starts
pr-hero watch status     # anytime: config, cap usage, launchd, lock, last activity
```

A repo is watched **only** if added (`--repo <path>` works from anywhere; `watch remove` takes it
back out; both are idempotent). Preview any tick for $0 first: `pr-hero watch --once --dry-run`
prints every candidate, every skip and its reason (draft / reviewed-local / reviewed-remote /
in-flight / attempts / cap / window), and the one (pr, head) a real tick would launch. `install` accepts
`--interval <min>` (default 15) and captures your current `PATH` (launchd's own PATH knows nothing
of `bun`, `gh`, `claude` or `codegraph`) — re-run `install` after moving tools around;
`watch uninstall` stops the schedule.

Worktree GC is a **separate** agent: `pr-hero gc install` (default every 6 hours, `--interval` in
minutes). It runs `pr-hero gc` — no reviews, no `watch.json`, no daily cap. Preview with
`pr-hero gc --dry-run`; `gc status` / `gc uninstall` match the watcher verbs.

### The underlying file — `~/.prhero/watch.json`

`watch add`/`watch remove` own the repo list — there is no need to edit the file by hand for
membership, and their rewrites preserve any keys they do not know. The two global knobs are still
plain JSON you may tune directly:

```json
{
  "repos": [{ "path": "~/Desktop/your-repo", "post": true }],
  "daily_cap": 5,
  "window": { "start": "09:00", "end": "19:00" }
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `repos[].path` | — | Operator checkout of a repo to watch (its `.prhero/` config and gotchas are used, exactly like `review --pr`). Managed by `watch add`/`remove`. |
| `repos[].post` | `false` | Pass `--post` to the spawned review — publish each result as the PR's one marked comment. Managed by `watch add [--post]`. |
| `repos[].on_push` | `false` | Re-review the repo's PRs on every new push. Default: one review per PR — see below. Managed by `watch add [--on-push]`. |
| `daily_cap` | `5` | Global max reviews launched per local calendar day, across all repos. `0` pauses launching entirely. |
| `window` | `null` (always) | Local-time window outside which ticks do nothing, e.g. `{"start":"09:00","end":"19:00"}`. Overnight windows (`start` > `end`) work. |

### One review per PR — the `on_push` knob

By default a push to an already-reviewed PR does **not** re-trigger a review: an active PR takes
many pushes, and re-billing $2–5 for each would drain the cap on one PR's churn. The posted
comment names the exact sha it reviewed, so it never lies about coverage — a reader sees at a
glance that later pushes are unreviewed. When the new head deserves a fresh pass, run it by hand
(`pr-hero review --pr <n> --post`); `pr-hero watch add --on-push` restores per-push re-review for
a repo that wants it. Planned follow-up: a cheap independent judge that reacts to pushes by
checking whether the new head addressed the posted findings and replies in-thread, instead of
re-reviewing from scratch.

### What keeps the bill bounded

- **The cap and the window** exist because the watcher and your interactive Claude sessions share
  the same subscription quota — a runaway watcher would starve the work you are actually doing.
  The cap is counted from `~/.prhero/watch.log` (the `launched` lines ARE the counter), and a
  launch is logged *before* it starts, so even a crashed review counts.
- **Max 2 attempts per (pr, head)**: a PR that keeps killing the review is dropped until it gets
  a new push, instead of eating the cap every day.
- **Cross-machine guard**: a posted pr-hero comment declares which head it reviewed; any watcher
  that sees the current head already declared skips the PR (and under the one-review-per-PR
  default, any pr-hero comment at all is proof enough). A fresh pending `pr-hero` commit status
  on the head (the yellow dot while a review is running) skips as `in-flight`.

### Operating model and honest limits

Run **one watcher per repo per team**. The comment-based cross-machine guard only protects repos
with `post: true`, and only after the first comment lands. A pending `pr-hero` commit status
closes the rest of the race once either review has started — two watchers can still duplicate
if both launch before either posts `pending`. With `post: true` the PR still converges to a
single comment. Not macOS? `watch --once` from cron works the same —
the PID lockfile keeps overlapping ticks from doubling up. Logs: structured events in
`~/.prhero/watch.log`, raw tick/review output in `~/.prhero/launchd.log`.

## What a run produces

Run artifacts land **outside** the repo, in `~/.prhero/repos/<origin>/runs/<run>/`:

| File | What it is |
| --- | --- |
| `report.md` | The human-readable review. |
| `findings.json` | The machine artifact (schema v1.0.0): findings, tiers, refuter verdicts, usage, provenance. |
| `diff.patch`, `pipeline.json`, `steps/` | The exact diff reviewed — after exclusions, so it is byte-for-byte what the hunters read — plus pipeline provenance (including the excluded paths), per-agent drafts and logs. |
| `diff.raw.patch` | The unfiltered diff of the same range. Written **only** when exclusions actually dropped a file, since otherwise it would duplicate `diff.patch`. |
| `anchor.patch` | The full PR diff (merge-base..head, after exclusions) that inline comments anchor against. On a first review it equals `diff.patch`; on an incremental re-review `diff.patch` is only the push delta, and this file still covers the whole PR, so a finding on an untouched line of the PR gets a review thread. |

## Cost and expectations

- **$2–5 per review** of a typical PR-sized diff — the floor is real, because hunters read the tree,
  not just the diff — and larger trees cost more (a 45-file tree measured $11–15). Wall time is
  minutes, not seconds: ~10 for a small diff, up to ~25 measured on a large tree. The printed band
  is an order-of-magnitude guide, not a quote — the same tree has billed 34% apart across runs.
### The size gate — a cost gate, not a quality gate

Past a size threshold pr-hero **skips the review** instead of running it. Small trees bill $1.9–$4.8;
the 45-file / +2775 −1237 bench tree billed $6.58–$17.92 across 18 iterations — the cost roughly
triples *and* its spread widens to ~2.7x. The gate exists because that bill is unpredictable, and
because an unattended watcher must not be the thing that discovers it.

**It is not a claim about quality.** We have no evidence that a bigger diff reviews worse: attention
dilution was tested and falsified (`fixtures/scale-probe.ts`), and the one measured Greptile-only
miss came from a 7-file PR. If a large diff is worth its price, review it anyway.
Locally that is `--force`. In GitHub Actions it is a pull request comment, `/crysk review`,
from a user with write access (a workflow scaffolded before the comment trigger uses
`gh workflow run pr-hero-force.yml -f pr=<n>` instead). The comment does not review on your
machine; the Actions runner does. It also clears the CI admission rules and the budget ceiling for
that one run. `gh run rerun` on a skipped run does not: it measures the gates again and skips again.

The gate counts **effective** changed lines (insertions + deletions) and files — excluded content is
subtracted first, so a regenerated lockfile beside a ten-line change does not trip it. Excluded by
default: `bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`,
`*.min.js`, `*.min.css`, `*.snap`. A repo can add its own exclusions with `.prheroignore` — see
below.

Those exclusions come out of the **reviewed diff itself**: `diff.patch` is what the hunters are
handed, so the number the gate measures is the number that gets paid for. If every changed file is
excluded, there is nothing to review — pr-hero exits without spawning anything.

### `.prheroignore` — repo-defined exclusions

A `.prheroignore` file at the **repo root** adds your own exclusions on top of the 9 defaults above.
The dialect is a **subset of gitignore(5)**, not a full reimplementation — most everyday patterns
work exactly like `.gitignore`, but two things are worth knowing before you rely on it:

- **Only one file, at the repo root, is read.** Nested per-directory `.prheroignore` files (the way
  git supports a `.gitignore` in every directory) are **not** read. A file at
  `openspec/.prheroignore` is silently ignored — put every rule in the one at the repo root instead.
- **Matching is case-sensitive**, matching git's own behavior. This is a deliberate departure from
  the `ignore` npm package (the common JS gitignore implementation), which is case-insensitive by
  default — if that is where your intuition comes from, `README.md` will not match `readme.md` here.

Supported: comments (`#`) and blank lines, negation (`!pattern` re-includes), anchoring
(a leading or interior `/`), trailing-slash directory-only rules, `*`/`?`/`[a-z]`-style classes,
`**` at any position (including matching zero directories), and literal `{`/`}` (this dialect has no
brace-alternation syntax — braces are always literal characters, unlike some glob libraries).
The **last matching rule wins**, builtins evaluated first, then your file's rules in order — so a
rule can re-include one of the 9 defaults (`!bun.lock`) or exclude something the defaults do not.

One documented deviation from real git: unlike `git`, which cannot re-include a file whose parent
directory is itself excluded (gitignore(5) states this outright — it is a tree-walk optimization),
this engine matches a finite diff file list, not a tree walk, so `docs/` then `!docs/keep.md` DOES
re-include `docs/keep.md` here.

Under CI (GitHub Actions, or any `CI`/`GITHUB_ACTIONS` environment), `.prheroignore` is read from
the PR's **base ref**, never the PR's own branch — a PR cannot widen its own exclusions to hide
changes from its own review. Local review, and local `--pr <n>` review without CI, read it from your
working tree instead. A malformed file aborts the whole review before anything is spent, naming the
file, line number, and offending text.

`pr-hero watch` honors `.prheroignore` too, in its per-tick scheduling filter (both the aggregate
check and the per-file rescue), and in a one-call pre-launch check that catches a PR whose files are
all excluded but whose aggregate alone would not have flagged it. It reads `.prheroignore` from the
watched repo's own working tree on the machine running the watcher — never a base ref — because the
watcher runs from an operator's own checkout of a repo that operator explicitly opted in, with no PR
author supplying that checkout the way CI's PR-triggered runs have one.

The count is also **whitespace-blind wherever git is reachable** (local mode and PR mode count from
`git diff -w --ignore-blank-lines --numstat`), so a formatter or linter sweep does not consume the
budget. Two paths cannot be: `--pr <n> --dry-run` and the watcher's per-tick checks read GitHub's own
counters, which carry no whitespace information — both label their verdict an estimate, and both can
only ever over-count, never under-count.

| Profile | Lines | Files | For |
| --- | --- | --- | --- |
| Conservative | `--max-changed-lines 800` | `--max-changed-files 150` | Tight budget; only small PRs auto-review. |
| **Default (shipped)** | **4000** | **150** | Everyday PRs pass; only very large trees are skipped. |
| Permissive | `--max-changed-lines 0` | `--max-changed-files 150` | You would rather pay than skip — disables the line limit. |

```bash
pr-hero review --pr 42 --dry-run          # prints the gate verdict, spends nothing
pr-hero review --pr 42 --force            # local: review it anyway (does NOT skip the cost prompt)
gh pr comment 42 --body "/crysk review"  # CI: same forced re-review, on the Actions runner
gh pr comment 42 --body "/crysk override"  # CI: unlock a red gate on this head, no review, $0
gh pr comment 42 --body "/crysk stop"      # CI: skip automatic reviews on later pushes, until /crysk review
pr-hero review --pr 42 --max-changed-lines 0   # 0 disables that limit entirely
pr-hero watch add --max-changed-lines 800       # per-repo threshold for the watcher
```

A skipped review exits 1 with a one-line reason and no stack. In watch mode it logs
`skipped … reason=too-large` (or `reason=nothing-to-review`, when every changed file is excluded)
and costs nothing further: it does **not** consume a poison-PR attempt,
writes no review marker, and does not arm the one-review-per-PR state — a force-push that shrinks the
PR makes it eligible again on the next tick, because the gate is recomputed every tick.

- Findings vary run to run on the same tree. That is the nature of the instrument: treat single
  runs as evidence, not verdicts, and triage before acting.
- Verify what it reports. Findings are claims with cited code, tiered by deterministic rules — the
  report says so itself. An advisory report reads *assistant report, not a merge gate; every line is a claim to
  verify.* A CI report in gate mode backs the `pr-hero` commit status, the required check: a blocking finding
  sets that status to failure.

## Isolation model

Spawned agents run with a read-only tool surface (Read/Grep/Glob plus the codegraph MCP server and
nothing else): no Write, no Bash, no network tools, `--strict-mcp-config`, no user settings. The
driver owns every file write and all `gh`/`git` I/O. In PR mode the reviewed tree is a detached
worktree containing only tracked bytes at the PR's head — agents never see your working copy.

## Development

```bash
bun test               # offline test suite — no network, no spawns, fake runners
bun run typecheck      # tsc --noEmit, strict
bun run check          # biome over src + test
```

The architecture in one line each lives in `CLAUDE.md`; the stage plan lives in `ROADMAP.md`,
and the earlier phases in `docs/history/`. The short version: the flow is data (`ReviewSpec`), agents are
prompt files, orchestration is testable TypeScript — models judge, code governs.
