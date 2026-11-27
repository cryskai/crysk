# Crysk

**[crysk.dev](https://crysk.dev)** · [docs](https://crysk.dev/docs/) · [npm](https://www.npmjs.com/package/crysk) · [skills](https://skills.sh/cryskai/crysk)

A multi-agent PR-review engine. Specialty hunter agents fan out in parallel over a repo checkout and
its diff, a mechanical dedupe merges their drafts, an adversarial refuter challenges every severe
finding whose evidence is inferred rather than read end to end, and deterministic code — never a
model — assigns blocking/advisory tiers.

Its measured profile, stated up front: **high precision, narrow coverage**. What it reports is
almost always real (13% false positives measured). Its hunters check value contracts across the diff
(units, domain, conversions, what consumers assume), resilience (lookup and dedupe keys, retries and
locks, CI guards, test isolation), local logic errors, and trust boundaries (outside input reaching a
query, command, file path or server-side request; missing or misplaced permission checks; a hunter
added 2026-11-15, after that measurement);
stale state, races and component lifecycle have no dedicated hunter since 2026-11-08. It says nothing
about style or convention. Locally it is an **assistant, not a merge gate**: every report closes with that
disclaimer, and nothing it prints blocks a merge. In CI its commit status is a gate by default: require the
`crysk` check in branch protection, and blocking findings block the merge. `mode: advisory` keeps that check
green.

> **Renamed from pr-hero.** Crysk used to be `pr-hero`. The package is now `crysk` (`npm install -g crysk`,
> `npx -y crysk`), and the `pr-hero` command stays as an alias for one version. What an install made under the
> old name wrote is still read for one version: `PRHERO_*` variables, `<!-- pr-hero-…` markers, `~/.prhero`,
> `.prhero/` and `.prheroignore`. The legacy `pr-hero` commit status is read but no longer written, so a branch
> protection rule that requires it must move to `crysk`. A workflow file scaffolded before the rename only
> answers `/pr-hero …`, which is no longer a command: re-run `crysk ci init --force` for it to accept `/crysk …`.
> The repository moved to `cryskai/crysk` and new workflows use `uses: cryskai/crysk@v0`. `juanmaagd/pr-hero`
> stays as a mirror with the same tags and releases, so a workflow that still says `uses: juanmaagd/pr-hero@v0`
> keeps working.

## Ways to use it

The user docs are at **[crysk.dev/docs](https://crysk.dev/docs/)**. Pick a path:

| Path | What you get | Start here |
| --- | --- | --- |
| **Crysk GitHub App** | Hosted setup and a dashboard. Opening through a waitlist. A ChatGPT plan works here. | [crysk.dev](https://crysk.dev/#waitlist) |
| **Open-source GitHub Action** | One workflow file in your repository, and the same review on every pull request. On your Claude plan or an API key. | [Quickstart](https://crysk.dev/docs/quickstart-github-actions/) |
| **Your terminal** | A review of a branch or pull request on your machine. It never blocks a merge. | [Use Crysk locally](https://crysk.dev/docs/local/quickstart/) |

The Action path needs no local install: your coding agent can set it up with the `crysk-ci-setup` skill
(`npx skills add cryskai/crysk`), or you run `npx -y crysk setup --ci` yourself.

## Requirements and install

These apply to the terminal path. The Action path needs none of them on your machine.

Crysk does not call any model API of its own. It **spawns the Claude Code CLI as a subprocess** and
inherits that CLI's authentication. `claude` is the engine; everything else here is plumbing.

| Dependency | Needed for | Without it |
| --- | --- | --- |
| **Claude Code CLI**, installed *and authenticated* | everything | nothing runs — it is the engine |
| **git** | everything | nothing runs |
| **Bun ≥ 1.3** on `PATH` | install options B and C only | option A carries its own runtime |
| **GitHub CLI (`gh`)**, authenticated | everything that reads or writes a pull request: `review --pr`, `--post`, `status`, `triage reply`, `watch`, `reverts`, `corpus` | required: `crysk doctor` fails without it |
| **codegraph** | optional code intelligence | hunters navigate with git and grep, with less structural context |

Run `crysk doctor` first: it checks every one of these and prints what is missing. The one thing it
cannot check is Bun — on an npm or source install the launcher itself is a Bun script, so a missing
Bun fails *before* any Crysk code runs, with `env: bun: No such file or directory`. Install Bun
(`brew install oven-sh/bun/bun`, or `curl -fsSL https://bun.sh/install | bash`) or use option A,
whose binary needs no Bun on your machine.

```bash
# Option A: Standalone binary (macOS / Linux, bundles its own Bun — still needs claude and git)
curl -fsSL https://raw.githubusercontent.com/cryskai/crysk/main/install.sh | bash

# Option B: Global npm install (brings Bun 1.4.4 as an optional dependency, or uses
# the Bun >= 1.3 on PATH when npm skips optional dependencies)
npm install -g crysk

# Option D: No install, for an agent or a one-off run (needs only Node). It cannot
# register the MCP server or the launchd agents: npx's cache is temporary, so those
# refuse and ask for option B. The launcher uses the bundled Bun only when it runs
# (`bun --version` is checked first), otherwise the Bun on PATH, and exits 127 naming both if neither works.
npx crysk doctor

# Option C: From source / development (the bin runs on Node; on a machine with Bun
# and no Node, run `bun bin/pr-hero.js` or use option A)
git clone https://github.com/cryskai/crysk.git && cd crysk
bun install && bun link
```

A local review bills against one Claude credential, chosen when it starts: your Claude subscription (quota,
no per-token invoice) or an API key (billed per token). Crysk prints no dollar figure. See
[Use your Claude plan](https://crysk.dev/docs/github-actions/claude-plan/) and the
[config reference](https://crysk.dev/docs/reference/config/) for `credentials`.

## Your first review

```bash
# 1. Install (option A shown), then put it on THIS shell's PATH: the installer edited your rc
#    file, and an rc file only reaches shells started after it. The installer prints the exact line
#    (~/.crysk/bin, or ~/.prhero/bin on a machine that already had a ~/.prhero).
export PATH="$HOME/.crysk/bin:$PATH"

# 2. What is installed, what is missing, what blocks a review.
crysk doctor

# 3. Skills + MCP registration, and — inside a git repo — scaffold .crysk/ and REVIEW.md.
cd /path/to/your-repo && crysk setup

# 4. Track the scaffold, or ignore .crysk/: a local review refuses a dirty tree.
git add .crysk
[ -f REVIEW.md ] && git add REVIEW.md
git commit -m "chore: crysk config"

# 5. Replace the placeholder in REVIEW.md with real review instructions (see below), then:
crysk review
```

`REVIEW.md` is given verbatim to every hunter, and what `setup` and `init` write there is a placeholder.
Crysk refuses to review while its `human-attention-required` marker line is still there: write a handful
of true lines about your repository and delete the marker, or delete the file to review with the default
guidance only. See [Write review instructions](https://crysk.dev/docs/reviews/review-instructions/).

Every run prints a plan, then asks for confirmation (`--yes` skips the prompt). `crysk review --pr`
reviews the current branch's pull request in an isolated worktree, and `--post` publishes it as one comment.
`crysk` with no arguments opens an interactive menu in a terminal.

## For AI agents

You are most likely here because someone told you to install Crysk and review a repo. The docs are plain
Markdown for you: the index is **<https://crysk.dev/llms.txt>**, and every page is also at its URL with
`.md` instead of the trailing slash. Four things go wrong when an agent runs the sequence above:

1. **The PATH export is not deferrable.** If each of your commands runs in its own shell, an `export PATH=...`
   in one does not reach the next. Prepend it to every Crysk invocation, or call the binary by absolute path:
   `~/.crysk/bin/crysk` (`~/.prhero/bin/pr-hero` on an install from before the rename).
2. **Committing the scaffold is yours.** `crysk setup` scaffolds `.crysk/` and `REVIEW.md` and neither commits
   nor ignores them, so the next `crysk review` fails the clean-tree gate on files `setup` itself created.
3. **Write the review instructions yourself.** You have the repository in context: write the deliberate oddity
   that looks like a bug, the invariant enforced in a file the diff never shows, the ownership rule a newcomer
   would violate. Leaving the placeholder is not a softer option, the review is refused.
4. **You cannot authenticate `claude`. Stop and ask the human.** Crysk spawns the Claude Code CLI and inherits
   its authentication. If `crysk doctor` reports `claude` missing or unauthenticated, say so and wait.

Skills for your agent: `npx skills add cryskai/crysk` (`crysk`, `crysk-ci-setup`, `crysk-pr`, `crysk-loop`).
[Let your agent fix findings](https://crysk.dev/docs/reviews/agent-fixes/) describes the loop.

## Commands

`crysk --help` prints every command and flag for the version you have installed. The commands you will use
(`review`, `init`, `setup`, `doctor`, `config`, `status`, `triage reply`, `watch`, `gc`, `usage`, `upgrade`,
`uninstall`) and their main flags are on the [CLI reference](https://crysk.dev/docs/local/cli/).

## Exit codes

The exit code says whether the review ran, never what it found: blocking findings still exit `0`. The verdict
is the `crysk` commit status and the posted comments. The same table holds in local, `--pr` and CI mode, gate
or advisory.

| Code | Meaning |
| --- | --- |
| `0` | The review is complete, with or without findings. |
| `1` | No usable review: every hunter failed, no reviewer ran, or findings that should have been posted were dropped. |
| `2` | Usage error. |
| `3` | The review is incomplete: it ran, but a step failed (a hunter, the refuter, verify, adjudicate, or the time ceiling). `findings.json` reads `run_status: "partial"`. Run it again. |

A script that merges on success should treat only `0` as a finished review. A local review that the size gate
skips exits `1`; a `--dry-run` that reports it would skip does not change its exit code.

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

The stage plan lives in `ROADMAP.md`,
and the earlier phases in `docs/history/`. The short version: the flow is data (`ReviewSpec`), agents are
prompt files, orchestration is testable TypeScript — models judge, code governs. See
[`docs/`](docs/README.md) for how the folder is organised.

## Docs

- [Overview](https://crysk.dev/docs/) and [Quickstart with GitHub Actions](https://crysk.dev/docs/quickstart-github-actions/)
- [How a review works](https://crysk.dev/docs/reviews/how-a-review-works/), [the check and the merge gate](https://crysk.dev/docs/reviews/merge-gate/), [comment commands](https://crysk.dev/docs/reviews/comment-commands/)
- [Exclude files](https://crysk.dev/docs/reviews/exclude-files/), [re-review levels](https://crysk.dev/docs/reviews/review-levels/), [size and spend limits](https://crysk.dev/docs/github-actions/size-and-spend/)
- [Use your Claude plan](https://crysk.dev/docs/github-actions/claude-plan/), [Use OpenAI models](https://crysk.dev/docs/github-actions/openai/), [other model providers](https://crysk.dev/docs/github-actions/other-providers/)
- [GitHub Action reference](https://crysk.dev/docs/github-actions/action-reference/), [`.crysk/config.json`](https://crysk.dev/docs/reference/config/), [error codes](https://crysk.dev/docs/reference/error-codes/), [troubleshooting](https://crysk.dev/docs/troubleshooting/)
- [Use Crysk locally](https://crysk.dev/docs/local/quickstart/) and the [CLI reference](https://crysk.dev/docs/local/cli/)
