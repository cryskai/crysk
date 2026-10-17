# GitHub Actions Integration

pr-hero reviews every pull request automatically: a multi-agent hunt with adversarial refutation runs
inside a GitHub Actions job, posts findings as PR comments, and writes a step summary. Its commit status
(`pr-hero`) is a gate by default: blocking findings turn it red, so require it in branch protection to
block a merge on them. `mode: advisory` keeps it green. See [Gate mode](#gate-mode-the-status-is-the-check).

## Quick path

1. **Add one auth secret** (Settings → Secrets and variables → Actions → New repository secret):
   `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Pick one — never both blank. Leave OpenCode unset:
   that is today's Claude CI.
2. **Add the one workflow file.** Copy the YAML under [What the workflow does](#what-the-workflow-does)
   to `.github/workflows/pr-hero.yml`, or run `pr-hero setup --ci` (or `pr-hero ci init`) in a clone of
   your repo, which writes the same template (`uses: juanmaagd/pr-hero@v0`). You do not need pr-hero
   installed locally: the file is the whole install. It reviews every push to a pull request, answers a
   `/pr-hero review` comment (see [Re-review on demand](#re-review-on-demand)), and answers a
   `/pr-hero override` comment (see [Overriding a red gate](#overriding-a-red-gate)). Do **not** copy this
   repository's own `.github/workflows/pr-hero.yml`: that file is generated with
   `OWN_CI_WORKFLOW_OPTIONS` so this repo can dogfood the checkout (`uses: ./`,
   `max-changed-lines: 5000`, and a step that pins the pull request head on a comment run).
   `test/packaging.test.ts` asserts each file against its own generator options; it does **not** assert
   the two are byte-identical. The template wires quoted `routing` / `opencode-auth` inputs; empty
   values are absent, so Claude-only repos keep those lines.
3. **Open a pull request** from a branch in this repository (not a fork). pr-hero comments inline, posts
   a summary review, and writes a `$GITHUB_STEP_SUMMARY` block within a few minutes. If no credential
   secret is set, the run fails red and its step summary lists the commands that set one.
4. **Verify readiness any time** with `pr-hero doctor` — it checks for the required secrets when run
   inside Actions, and for the workflow file's presence locally.

To review with OpenCode instead of (or mixed with) Claude, add `OPENCODE_AUTH_JSON` and
`PRHERO_ROUTING` after step 1 — see [OpenCode in CI](#opencode-in-ci). You do not need a different
Action.

## What the workflow does

```yaml
name: pr-hero Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment: # `/pr-hero review` — read from the default branch's copy of this file
    types: [created]

permissions:
  actions: read # admission gate lists this workflow's past runs
  contents: read # actions/checkout
  pull-requests: write # inline comments + review + step summary
  issues: write # resolving/replying on review threads (GitHub models PR conversations as issues)
  statuses: write # commit status updates
  checks: write # admission attempt ledger

jobs:
  review:
    # Same-repo pushes, and comments that start with `/pr-hero review` or `/pr-hero override`. Never reads secrets.
    if: >-
      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/pr-hero review')) ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/pr-hero recheck')) ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/pr-hero override'))
    concurrency:
      group: ${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || (startsWith(github.event.comment.body, '/pr-hero review') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)) || (startsWith(github.event.comment.body, '/pr-hero recheck') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)) || (startsWith(github.event.comment.body, '/pr-hero override') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))) && format('pr-hero-review-{0}', github.event.pull_request.number || github.event.issue.number) || format('pr-hero-noop-{0}', github.run_id) }}
      cancel-in-progress: ${{ github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # see "Why fetch-depth: 0" below
      - name: Run pr-hero
        id: pr-hero
        uses: juanmaagd/pr-hero@v0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          claude-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          routing: "${{ vars.PRHERO_ROUTING }}"
          opencode-auth: ${{ secrets.OPENCODE_AUTH_JSON }}
```

`pr-hero setup --ci` generates this file, with comments explaining each piece — see
`generateCiWorkflowTemplate` in `src/ci/setup.ts`. It refuses to overwrite a customized workflow already
at that path unless you pass `--force`, and it never touches a `pr-hero-force.yml` scaffolded by an
older version (that file keeps working; you can delete it once this one is on your default branch).

The action does the rest: it checks that a credential is set (and fails the run red, with the commands
that fix it, when none is), parses a `/pr-hero review` comment and checks that its author has write
access, resolves the pull request and its head commit from the event, and uploads the run directory
(see [Triaging a CI review](#triaging-a-ci-review)).

Three choices in the job are load-bearing:

- **Concurrency is per job and keyed on the pull request number.** A workflow-level group keyed on
  `github.head_ref || github.ref` would put every comment on every pull request into one group, because
  `head_ref` is empty on `issue_comment`, so any comment could cancel any in-flight review. A fork's
  push, a comment that does not start with `/pr-hero review`, and a comment whose author GitHub does not
  associate with the repository as `OWNER`, `MEMBER` or `COLLABORATOR` each get a unique group, so
  those jobs never cancel or replace a review.
- **Only a new push cancels.** The `if:` filter is a prefix, so a near-miss comment ("/pr-hero review
  please") from an associated author lands in the pull request's group too; cancelling there would kill
  a paid review in flight before the action ignores the comment. A comment run queues instead. A push
  never waits: it cancels whatever is running, a forced review included, because that head is gone;
  comment again on the new head. GitHub keeps one *pending* run per group and a newer run replaces it,
  which is why a stranger's comment never enters the group: it could otherwise replace a maintainer's
  queued review with a run the action then refuses. Known gap: an associated author's later comment (a
  writer's near-miss or second real command, or a read-only member's or collaborator's refused one)
  still replaces a comment run already waiting behind a running review, and `--full` followed by a plain
  `/pr-hero review` loses the `--full`. Comment again to recover. The job `if:` does not check the
  association, so a writer GitHub reports under another one (a private org member shown as
  `CONTRIBUTOR`) still gets a review, because the action checks the real permission, but in its own
  group, unserialized beside a review already running.
- **Fork pushes are skipped.** GitHub gives fork `pull_request` runs no secrets. A maintainer comments
  `/pr-hero review` instead; see [Fork pull requests](#fork-pull-requests).

Keep every `with:` line even when you only use Claude: an unset secret or var expands to empty, which
the Action treats as absent. Deleting the line for the credential you *did* set is what breaks. The
quotes around `vars.PRHERO_ROUTING` are load-bearing — an unset repository variable must become the
empty string, not broken YAML.

**A run that cannot start the review still says so on the pull request.** When there is no
model credential, the pull request number or head cannot be resolved, the commenter's permission
cannot be verified, or an install step fails before pr-hero starts, pr-hero posts one `pr-hero`
commit status (`error`) and one comment on the pull request. A review that starts and then fails also
does, when the CLI reports an error or every review hunter fails; if the CLI takes the review's lock and then
stops before it reports an outcome, pr-hero posts the comment, and its `error` status on the head that lock is on, when that head's `pr-hero` status is still `pending` or cannot be read. A review cancelled mid-review sets `error` `PRH-CANCELLED: not reviewed — /pr-hero review reviews this head` on its head, so a cancelled gate never stays pending. Without a readable record of the lock, pr-hero posts the comment alone, with no status. A settled status (`success`, `error` or `failure`) stays as the CLI left it. The comment gives the error code, whose fix it is (your configuration, a provider, pr-hero,
or unclassified) and the command that fixes it.
A newer comment replaces the older one from the same author. pr-hero removes its earlier outcome comment once a later run has completed a review. A denied or ignored `/pr-hero review`
comment posts no comment: the trigger reacts to it instead ([Reactions on a command](#reactions-on-a-command)). A review that ran keeps its own status. A size or budget skip sets a `failure`
status in gate mode and none in advisory (see [Gate mode](#gate-mode-the-status-is-the-check)).

### Reactions on a command

The trigger answers a `/pr-hero` comment it does not review with a reaction on that comment, and no text reply:

- 👀 (`eyes`): the command is accepted. That is a writer's `/pr-hero review`, an override that unlocks its gate, and an authorised review on a repository with no credential, which then fails for the credential and says why.
- 👎 (`-1`): the command is refused. The commenter has no write or admin access, or the override is refused: on a fork, or when the lookup cannot say whether the pull request is a fork.
- 😕 (`confused`): a near miss, a comment that starts like a command but is not one, such as `/pr-hero review please` or `/pr-hero override --force`. A near miss runs nothing: no permission lookup, no review and no override. Only an exact command runs.

A commenter whose permission cannot be verified gets no reaction: its run is red, and its error comment explains why. A reaction is best effort. When GitHub refuses one, the run prints one warning, and its decision and exit code do not change. Only the first attempt of the comment's job reacts: a re-run (attempt 2 or later) keeps the decision, notices and exit code of the first attempt and adds no reaction, so the comment keeps the one the first attempt gave.

### Why `fetch-depth: 0`

`actions/checkout`'s default is a **shallow** clone. pr-hero computes the pull request's diff range and
commit ancestry from full git history — a shallow clone does not fail loudly here, it makes the review
silently miss context (wrong merge-base, incomplete blame). This is load-bearing, not cosmetic: never
trim it.

## Authentication

| Name | Kind | Required | Notes |
|---|---|---|---|
| `GITHUB_TOKEN` | secret | Yes (auto-provided) | GitHub injects this automatically; the action's `github-token` input defaults to it — you rarely need to set it explicitly. |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | One of the three credential secrets | The long-lived token printed by `claude setup-token` (valid ~1 year). Consumes directly from your Claude subscription (Pro/Team/Enterprise) with **zero extra API billing/costs**. Must come from that command — see the warning under Option 1. |
| `ANTHROPIC_API_KEY` | secret | One of the three credential secrets | A standard Anthropic API key, billed per token via your Anthropic Console account. |
| `OPENCODE_AUTH_JSON` | secret | One of the three credential secrets | Whole OpenCode `auth.json` blob (not a single key field). Cap **48 KB**. Never echo, log, or paste it into the workflow. The Action writes it `0600` at the OpenCode auth path. Leave unset for Claude-only CI. |
| `PRHERO_ROUTING` | repository **variable** | OpenCode path (with the secret above) | JSON object with the same shape as `config.routing` — the routing object, not the whole `~/.prhero/config.json`. Quoted in workflow `with.routing`. Unset = empty string. Cap **48 KB**. Written to the person-layer `$HOME/.prhero/config.json` on the runner. Repo `.prhero/config.json` **rejects** `routing`. |

The action treats Anthropic key **or** Claude OAuth **or** `OPENCODE_AUTH_JSON` as present. With none of
the three set, the run fails red before any spend, and its step summary lists the commands that set one.
Reference every secret **by name** (`${{ secrets.ANTHROPIC_API_KEY }}`, `${{ secrets.OPENCODE_AUTH_JSON }}`)
— never paste a literal key into the workflow file, a log line, or a PR comment. The action itself
follows the same rule: it never echoes, logs, or truncates a secret value anywhere in its output.

### How to obtain and configure credentials

#### Option 1: Claude Subscription OAuth Token (`CLAUDE_CODE_OAUTH_TOKEN`)
*Best for developers with Claude Pro, Team, or Enterprise subscriptions.*

1. In your local terminal where Claude Code CLI is installed, run:
   ```bash
   claude setup-token
   ```
2. Authorize via the browser login window.
3. Copy the resulting token string. The command prints it once and reports its
   validity period (~1 year); regenerate it the same way before it lapses.

> **Use only the token this command prints.** Two different credentials are both
> called a "Claude OAuth token", and only this one survives in CI. The session
> token that `/login` leaves in your keychain (or `~/.claude/.credentials.json`)
> expires in **hours** — the CLI hides that locally by silently rotating it with
> a refresh token, which CI does not have. Paste that one into the secret and
> reviews work for about a day, then stop with no error you will notice.

#### Option 2: Anthropic API Key (`ANTHROPIC_API_KEY`)
*Best for pay-as-you-go per-token billing on an Anthropic Console account.*

1. Go to [Anthropic Console Keys](https://console.anthropic.com/settings/keys).
2. Click **Create Key**, assign a name (e.g. `pr-hero-ci`), and copy the `sk-ant-...` key.

#### Setting the secret in GitHub

* **Via GitHub CLI (Fast):**
  ```bash
  gh secret set CLAUDE_CODE_OAUTH_TOKEN # or ANTHROPIC_API_KEY
  ```
  Paste the token when prompted. For OpenCode, see [OpenCode in CI](#opencode-in-ci) (`gh secret set`
  plus `gh variable set` — routing is a variable, not a secret).
* **Via GitHub Web UI:**
  1. Go to `https://github.com/<owner>/<repo>/settings/secrets/actions`.
  2. Click **New repository secret**.
  3. Enter Name (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`).
  4. Paste the token into Secret and click **Add secret**.

## OpenCode in CI

Leave `OPENCODE_AUTH_JSON` and `PRHERO_ROUTING` unset to keep today's Claude CI. To run OpenCode, set
**both** — the Action is backend-agnostic; the next provider is DATA (routing JSON + one `auth.json`
secret), not a new Action input.

### Wire it

1. **Repository variable** `PRHERO_ROUTING` — the routing object only (`default` / `mappings` /
   `disabled`), same shape as person-layer `config.routing`. Do not wrap it in `{"routing": ...}`
   and do not put credentials inside it (the variable is public). OpenCode does not resolve pr-hero
   aliases (`sonnet` / `opus` / `haiku`): set `modelSnapshot` to an id `opencode models` lists. Routing
   maps **logical model**, not hunter vs refuter. By default the hunters declare `sonnet`, the refuter
   declares `opus`, and the summarizer runs on `haiku`, so a mapping moves only the steps whose alias it
   names. An alias with no mapping and no `default` route currently falls through to the Claude CLI,
   which needs Claude credentials in that run; a `default` route covers every alias, the refuter
   included, so the refuter then runs on the default model.

   ```bash
   gh variable set PRHERO_ROUTING --body '{"default":{"backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"}}'
   ```

   Mixed Claude summarizer (`haiku`) + OpenCode default (hunters and refuter both use the default route):

   ```bash
   gh variable set PRHERO_ROUTING --body '{"default":{"backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"},"mappings":[{"logical":"haiku","backend":"claude-code","provider":"anthropic","gateway":"direct"}]}'
   ```

   Hunters on OpenCode, refuter on Claude: map only `sonnet`. The unmapped `opus` refuter, and the
   `haiku` summarizer (on unless `summary.enabled` is false), fall through to the Claude CLI, so keep
   `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) alongside `OPENCODE_AUTH_JSON`:

   ```bash
   gh variable set PRHERO_ROUTING --body '{"mappings":[{"logical":"sonnet","backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"}]}'
   ```

   Do not use that shape for an OpenCode-only run (no Claude credentials): the refuter and the
   summarizer would still be routed to the Claude CLI with no credentials to run them. Use a `default`
   route as above, or map all three aliases (`sonnet`, `opus`, `haiku`), each with its own
   `modelSnapshot`.

2. **Repository secret** `OPENCODE_AUTH_JSON` — one JSON object in OpenCode's `auth.json` shape. Never
   echo it. Cap 48 KB. If the personal store also has ChatGPT OAuth or extra providers, upload a
   **CI-only** subset (one non-openai `type: "api"` record). Do not put a personal OAuth session in
   GitHub.

   ```bash
   gh secret set OPENCODE_AUTH_JSON < auth.json   # paste or redirect; do not cat into logs
   ```

   Shape (placeholder keys only — never a real credential):

   ```json
   {
     "deepseek": { "type": "api", "key": "sk-test-fake" }
   }
   ```

3. Keep the generated workflow `with:` lines (`routing: "${{ vars.PRHERO_ROUTING }}"` and
   `opencode-auth: ${{ secrets.OPENCODE_AUTH_JSON }}`). Open a same-repo PR.

The Action writes routing to `$HOME/.prhero/config.json` on the runner (person layer) wrapping
`{"routing": <parsed>}`. It never writes repo `.prhero/config.json`; that file's parser rejects
`routing`. Empty or unset routing skips the person-layer write, so Claude-default CI stays available.
`OPENCODE_AUTH_JSON` is written `0600` at the OpenCode auth path; brokers read that file. Invalid JSON
fails the job loud.

### Pin 1.18.30

The Action installs OpenCode CLI **1.18.30** in its own step, only when `opencode-auth` is non-empty
**or** `routing` contains `opencode`. It never uses `latest`. The install appends `$HOME/.opencode/bin`
to `GITHUB_PATH` so a **later** step (Run pr-hero) sees the binary — the install step itself is not
the review. Claude-only CI (no OpenCode secret, routing does not mention `opencode`) skips this
install and still starts.

### openai vs deepseek

| Provider in `auth.json` | CI outcome |
|---|---|
| Non-openai API token (tested: **deepseek** `type: "api"`) | Executable metered path. Presence of the auth file applies the default spend ceiling — this is an invoice route, not an unlimited subscription. |
| `openai` with `type: "api"` | **Refused.** The engine maps openai to ChatGPT OAuth; a pay-as-you-go API key is not remapped. Do not put an openai API key in `OPENCODE_AUTH_JSON` and expect it to run. |
| Mixed OpenCode providers in one run | Out of scope ([#195](https://github.com/juanmaagd/pr-hero/issues/195)). One OpenCode provider per run. |
| `claude-code` + one OpenCode provider | Already works. Mix Claude credentials with one OpenCode `auth.json` entry and routing that names both backends. |

### Edges

- **Fork pushes** skip: GitHub does not give fork `pull_request` runs repository secrets. The review
  job `if` never reads `secrets`. A maintainer's `/pr-hero review` comment reviews a fork — see
  [Fork pull requests](#fork-pull-requests).
- **OpenCode-only** (only `OPENCODE_AUTH_JSON` set, no Claude secret) counts as a credential and
  reviews.
- **Mismatch fails closed:** Claude credentials plus OpenCode routing but no `OPENCODE_AUTH_JSON`
  passes the credential check (a Claude secret is set) and then **fails**, rather than skipping as a
  clean review.
- **48 KB** is the GitHub secret/variable size cap for both `OPENCODE_AUTH_JSON` and `PRHERO_ROUTING`.

## Token permissions

The workflow's `permissions:` block needs six scopes, each for a specific reason:

- **`contents: read`** — `actions/checkout` needs to read repository contents.
- **`pull-requests: write`** — posting inline findings, the summary review, and the step summary.
- **`issues: write`** — resolving and replying on review threads. GitHub's API models every PR
  conversation as an issue thread, so this scope is required even though nothing here touches an issue.
- **`statuses: write`** — updating the PR commit status context (pending, success, failure, error).
- **`checks: write`** — durable CI admission ledger (attempt reservations and terminal outcomes on Check Runs).
- **`actions: read`** — the admission gate lists this workflow's past runs (`gh run list`). A public
  repo serves that without the scope, so a missing grant only fails on a private repo, with HTTP 403.

## Security considerations

### Fork pull requests
In GitHub Actions, pull requests originating from forks do not receive repository secrets
(`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENCODE_AUTH_JSON`). This is GitHub's intentional
security boundary to prevent untrusted pull requests from exfiltrating credentials or consuming API
budget. Repository **variables** (`PRHERO_ROUTING`) are visible; that is why routing must not contain
credentials.

So the generated workflow skips a fork's `pull_request` runs: they could never authenticate. To review
a fork pull request, a user with write access comments `/pr-hero review` on it. That run is an
`issue_comment` run in the base repository's context, with its secrets: the action fetches the fork's
head commit and reviews it, while config and gotchas still come from the base checkout. A comment from
a user without write access is refused, so nobody outside the repository can spend its credentials.
If GitHub's API fails while checking that access (a 5xx, a rate limit, a timeout), the action retries
once and then fails the run red, asking for the comment again: it never reviews unchecked, and never
refuses silently.
No `pull_request_target` is involved. If you wire `pull_request_target` yourself, the action reviews
fork heads there too: that event runs in the base repository's context, with its secrets, so choosing
it is choosing base-context reviews of forks. pr-hero reads the head as text and never runs its code.

The job `if` never reads `secrets` (GitHub does not allow it there). Credential presence is checked
inside the action instead: a same-repo pull request with none of the three credential secrets fails
red, with the commands that fix it, rather than skipping green and reading as a clean review. A
credential already on the runner counts too: a Claude session file in `$HOME` or the OpenCode
`auth.json` store. A self-hosted runner with none of these is left to the engine's own credential
check, which can also see a macOS keychain entry. `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` set
in the job's own `env:` does not count: the action's run step binds both from its inputs, so wire the
secret as an input.

In this repository only, a comment run checks out the pull request's head and runs that engine
(`uses: ./`), so it refuses fork pull requests outright: there the fork would supply the engine and run
it with this repository's secrets. See [Re-review on demand](#re-review-on-demand).

### Action version pinning
The default workflow targets the floating major tag `uses: juanmaagd/pr-hero@v0`, which moves to every new 0.x release. While the major version is 0, a minor release may include breaking changes to the Action contract (see the pre-1.0 semantics in `docs/release-runbook.md`), so `@v0` is not a compatibility guarantee: read `CHANGELOG.md` before a new 0.x minor lands, or pin an exact tag or SHA. If your organization enforces strict immutable SHA pinning, you can pin the full commit SHA directly:
```yaml
- uses: juanmaagd/pr-hero@aff0324cd8c6a0c5fbf97ddbf3e6d234c9c612e4 # v0.1.0
```

`@v1` still exists and is frozen at the last 1.x release (versions were renumbered to 0.x because the
API is not yet stable — see `CHANGELOG.md`): existing workflows pinned to `@v1` keep working exactly as
they are today, but receive no further updates. New workflows should target `@v0`.

## Spend controls

Two independent gates run **before** any agent is spawned, so an oversized or over-budget PR costs
nothing:

| Gate | Input | Default | Disable |
|---|---|---|---|
| Size | `max-changed-lines` / `max-changed-files` | `4000` / `50` | `0` |
| Budget | `budget-usd` | route-derived (see below) | any value `<= 0` |

Both gates exit 0 and leave a courteous PR comment plus step-summary note when they trip — they are cost
gates, not quality gates, and never fail the job. The comment names the one-shot override: comment
`/pr-hero review` on the pull request (see [Re-review on demand](#re-review-on-demand)). That runs the review on
GitHub Actions. It does not change the ceilings for later pushes, and it does not review on the machine
of whoever comments.

**Leaving `budget-usd` unset resolves the ceiling from how the run is billed.** A Claude
subscription route (`CLAUDE_CODE_OAUTH_TOKEN`) draws on quota rather than a per-token invoice, so its
real cash cost is `$0.00` and there is no dollar figure to gate on — no ceiling is applied, and the run
emits a `::notice::` saying so. A metered route (`ANTHROPIC_API_KEY`, or OpenCode API-token auth via
`OPENCODE_AUTH_JSON`) gets a `10.00` default, because that is the case where a runaway PR really does
produce an invoice. Setting `budget-usd` explicitly is honoured verbatim on either route.

If **both** Claude credentials are set, the ceiling is applied: this project does not record which one
the Claude CLI actually bills, and a wrongly-removed ceiling costs money while a wrongly-applied one
costs one skipped review you can clear with `budget-usd: 0`. The same conservative rule applies when
the OpenCode auth file is present: CI treats the run as able to invoice (metered ceiling) even if a
Claude subscription token is also set. That does **not** stamp Claude CLI usage as metered solely
because OpenCode auth is present — OpenCode API-token billing is beside Claude's subscription quota.

**A `budget-usd` of `0` or below does not mean "spend nothing" — it disables the ceiling.** This
matches the sibling size-gate knobs' documented convention (`<= 0` disables the limit). Reading it the
other way ("always skip") would make pr-hero silently stop reviewing every PR while the job still shows
green. Because a disabled ceiling is otherwise indistinguishable from a passing one, a disabled budget
emits a `::warning::` workflow annotation on every run — check your job logs if you did not mean to
disable it.

## CI review admission

On every `synchronize` push, pr-hero decides whether another review is worth the spend **before**
fetching the worktree or spawning agents. The decision is deterministic, logged in the job summary,
and backed by a durable attempt ledger stored in GitHub Check Runs (`checks: write` permission).

### Policy configuration (`.prhero/config.json`)

These keys live in the **repository** config (not the PR branch worktree). A PR author cannot change
them to suppress review of their own PR. The same rule applies to `.prheroignore` (size-gate/diff
exclusions, see the README): under CI it is read from the PR's base ref, never the PR's own branch.

| Key | Default | Meaning |
|---|---|---|
| `ci_review_policy` | `risk_aware` | Admission mode — see table below. |
| `ci_max_attempts` | `2` | Automatic attempt budget per PR (same-head dedup is per head SHA). |
| `ci_rereview_min_score` | `4` | Prior findings score at or above this triggers re-review (`blocking×weight + advisory×weight`). |
| `ci_blocking_weight` | `2` | Score weight for blocking-tier findings. |
| `ci_advisory_weight` | `1` | Score weight for advisory-tier findings. |
| `ci_trusted_actors` | `[]` (+ `GITHUB_ACTOR`) | GitHub logins whose finding markers count as authoritative. |
| `ci_admission_observe_only` | `false` | When `true`, admission still evaluates and emits a `::notice::` with the would-be decision but **always runs** the review. Use during rollout. |

#### `ci_review_policy` modes

| Mode | Behavior |
|---|---|
| `once_per_pr` | One automatic review per PR; later pushes are reported as not reviewed. |
| `thresholded` | Re-review when the prior score reaches `ci_rereview_min_score`. |
| `risk_aware` | Re-review when the delta touches risky paths **or** the prior score reaches the threshold. Recommended default. |
| `every_push` | Review every push (still bounded by `ci_max_attempts`). |
| `manual_only` | No automatic re-review; a `/pr-hero review` comment is required. |

Example:

```json
{
  "ci_review_policy": "risk_aware",
  "ci_max_attempts": 2,
  "ci_rereview_min_score": 4,
  "ci_blocking_weight": 2,
  "ci_advisory_weight": 1,
  "ci_trusted_actors": ["my-org-bot"],
  "ci_admission_observe_only": false
}
```

### Re-review on demand

When CI skips a pull request — size gate, admission policy, or budget ceiling — comment on the pull
request:

```text
/pr-hero review
```

The review runs on the GitHub Actions runner, not on the machine of whoever comments. The comment must
start with `/pr-hero review` and be exactly that command (trailing whitespace and newlines are
ignored; leading whitespace means no job starts at all); anything else, such as
`/pr-hero review please`, starts a job that ends without reviewing. The commenter needs write access
to the repository; a comment from anyone else is refused. `gh run rerun` on a skipped run re-evaluates
the gates and does not force.

A local agent (Claude Code) posts the same comment:

```bash
gh pr comment <number> --body "/pr-hero review"
```

It must not run `pr-hero review --pr <n> --force` when the goal is a CI review.

The comment run passes `--force`. That bypasses the size gate, admission, and the budget ceiling for
that run only. It does not reset the durable ledger. An empty effective diff (everything excluded)
still does not review.

`--force` never widens discovery. A re-review only hunts the commits since the last completed review,
and that review is identified by the summary marker it posted for its head commit. So when a prior
review of the **same head** was hollow or wrong (for example, its hunters returned nothing), every
later run on that head reports "No changes to discover" and runs no hunter. Recover with `--full`,
which re-discovers the whole pull request range:

```text
/pr-hero review --full
```

Prior findings are still verified and triaged as usual; only discovery widens.

**Fork pull requests** are reviewed only this way: their own pushes are skipped, and a maintainer's
comment runs the review in the base repository's context (see
[Fork pull requests](#fork-pull-requests)).

**Workflows scaffolded before the comment trigger** have no `issue_comment` listener, so a comment does
nothing there. They have a dispatch-only `.github/workflows/pr-hero-force.yml` instead, which still
works because the action keeps the `pr-number`, `force`, and `full` inputs it sets:

```bash
gh workflow run pr-hero-force.yml -f pr=<number>              # force
gh workflow run pr-hero-force.yml -f pr=<number> -f full=true # force and re-discover
```

Re-scaffold with `pr-hero ci init --force` to switch to the comment trigger. It rewrites
`pr-hero.yml` only and leaves `pr-hero-force.yml` in place; delete that file yourself once the new
`pr-hero.yml` is on the default branch.

In this repository, a comment run reviews with the pull request's own engine: `pr-hero.yml` is
generated with `OWN_CI_WORKFLOW_OPTIONS`, so on a comment a first step resolves the PR head commit and
checkout pins that commit before `uses: ./`. A comment run starts on the default branch, so without the
pin it would run the default branch's engine instead of the one under review. Consumer workflows run
the published `juanmaagd/pr-hero@v0`, where the checkout does not select the engine.

- **When it takes effect.** GitHub reads a comment-triggered workflow from the default branch, so the
  comment trigger works only once `pr-hero.yml` with its `issue_comment` trigger is on the default
  branch; in this repository that means `main`, not `dev`. Until then a comment starts nothing. In a
  consumer repository, the comment handling also needs an action release that has it, reached through
  the `@v0` tag the workflow pins.
- **Minimum action version.** This workflow listens to comments, and only an action release that ships
  the comment handling checks the command and the commenter's write access. An older action reviews on
  ANY comment that starts with `/pr-hero review`, from anyone who can comment, with your secrets. Do
  not pair this workflow with an action older than the release that adds it: if you pin a tag or a
  commit sha instead of `@v0`, pin one at or after that release.
- **Older heads (this repository).** The comment run loads the PR head's own `action.yml`, so on a head
  from before the comment handling existed the run reviews without reading the comment: no `--force`
  and no `--full`. Merge or rebase the PR onto a base that has it first.
- **Trust (this repository).** A comment run here runs the PR head's code, including its
  `bun install`, with the workflow's secrets. So the commenter's write access is checked twice: by the
  workflow's own pre-checkout step, before any of the head's code runs, and again by the head's
  `action.yml`. The first check fails closed, so an old branch whose `action.yml` predates the check
  still refuses a commenter without write access.

### Check Runs ledger

Admission attempts are persisted as Check Runs named `pr-hero/ci-admission` on the reviewed commit.
The workflow needs **`checks: write`** (listed under [Token permissions](#token-permissions)) so pr-hero can
reserve attempts before provider spend and record outcomes. PR comments remain presentation only; the
Check Run ledger is authoritative.

An attempt counts toward `ci_max_attempts` when its run reached the provider (completed, failed, or
still in progress) or when admission itself skipped it. Two outcomes spend nothing and do not count: a
run that stood down for a review already in flight on the same head, and a run the size gate or the
budget ceiling skipped before any agent started. A cancelled row does not count either, but it is not
proof that nothing was spent: a cancel signal can arrive after the provider started, so a run that
GitHub concludes as `failure` (for example one killed by `timeout-minutes`) still counts. A skipped run
still shows as a skipped check on the commit.

Skipped and manual-required outcomes include admission metadata in the step summary: decision, reason,
current head, reviewed head, risk class, score, attempt count, remaining budget, policy mode, and a
short policy hash.

## Gate mode: the status is the check

The `pr-hero` commit status is the check you require in branch protection. The job's exit code does not
carry the review's findings: a finished review exits `0` even when it finds blocking-tier issues. Findings
are published as comments and a summary, and the commit status decides the gate.

The action's `mode` input picks what the status says. It defaults to `gate`:

- **`gate`** (the default): a finished review with blocking findings sets `failure`. A size or budget
  skip also sets `failure`, so an unreviewed head cannot read as a clean one. A clean review, or one with
  only advisory findings, sets `success`.
- **`advisory`**: the status is `success` for every finished review, whatever it finds. This is the
  posture pr-hero had before the gate. Skipped reviews post no status, as before.

Either way, a crash, a failed session and a missing findings count set `error`, which is a red check too.
The table shows the status and the job exit for each case:

| Cause | `gate` status | `advisory` status | Exit |
|---|---|---|---|
| Finished review with unresolved blocking findings (see below) | `failure`: `pr-hero: N blocking finding(s) — fix and push, or /pr-hero override` | `success` | `0` |
| Finished review where some hunters failed, none blocking (a blocking count still wins; when the same hunters fail every run, fix their route or `/pr-hero override`) | `failure`: `pr-hero: review partial (N of M hunters failed) — /pr-hero review retries it` | `success` | `0` |
| Finished pipeline in which no hunter ran on a review meant to run them (the budget ceiling or an unusable gotchas file stopped it first; a re-review that skipped discovery on purpose is not this case and stays green) | `error`: `review did not finish` | `success` | `0` |
| Finished review, clean or advisory-only | `success` | `success` | `0` |
| Size or budget skip (`/pr-hero review` reviews it anyway) | `failure`: `pr-hero skipped the review: … /pr-hero review reviews it anyway` | none | `0` |
| Admission skip for a low-risk or below-threshold delta, or once per PR | inherits the verdict of the pull request's last reviewed commit (see below): `success` `pr-hero: no review needed (<reason>); carried from <sha>`, or `failure` `pr-hero: N blocking finding(s) carried from <sha> — fix and push, or /pr-hero override`, or `failure` `pr-hero: review partial (N of M hunters failed) carried from <sha> — /pr-hero review retries it`; with no readable verdict, `failure` `pr-hero skipped the review (<reason>) and found no earlier verdict — /pr-hero review reviews it` | none | `0` |
| Same head, already reviewed | none (that head's own status already exists) | none | `0` |
| Manual re-review required (attempt budget used up, or `manual_only`) | `failure`: `pr-hero: review budget for this PR is used up — /pr-hero review reviews this head` (`manual_only` names the manual trigger instead) | none | `0` |
| Final status write failed (after its two attempts) | not written: the job fails with an `::error::` annotation | logged as a warning | `1` (gate only) |

Fatal failures (missing or invalid credentials, a crashed process, a malformed argument) and the two cases
below keep their own status and exit, as they did before the gate.

**A skipped head inherits the verdict of the last reviewed commit of its pull request.** When the admission gate
skips a new head as a low-risk or below-threshold delta, or once per PR, the head takes the newest review verdict from
this pull request's own commit statuses: a `pr-hero` success or failure that a finished review wrote, or a verdict
carried from this pull request. The gate walks the pull request's commits newest-first from the head, skips each commit
that carries no verdict, and stops at the first one that does, within the last 20 commits before the head. A skip's
failure, a fail-closed, budget or manual-only failure, an error, a pending status, and an override are not verdicts, so
the walk passes over them. The verdict never comes from comment content: a comment, a summary marker included, can name a head,
but only a write-access actor can set a commit's status, so a comment naming a green head carries nothing. A verdict
carried onto a skipped head may be carried again onto a later one, because it came from a real review. A red verdict
stays red, with its count, until the head is reviewed (`/pr-hero review`) or overridden. A green one reads as no review
needed. An override is never carried: it is a human's decision for the code at the head it names, and the skipped head
was never reviewed, so carrying it would turn a new head green with no review behind it. With no readable verdict (no
reviewed head, a failed read, a head missing from the pull request's commits, or no verdict within the last 20 commits),
the head is `failure` and says so: a trivial push must not pass the gate without a verdict behind it. A manual
re-review required is always `failure`, because its code was never reviewed, and carrying a green verdict over it would
let an unreviewed push pass the gate. A head whose newest `pr-hero` status is an override keeps it: a re-run of the gate
on that head writes no skip status over the override, when the head's statuses can be read. When they cannot, the skip's
status is written as planned and the run logs a warning, because a head that reads as nothing decided is the original
bug; that write can replace an override the run could not see. Advisory mode writes no status on a skipped head, as before.

**What counts as unresolved.** The count behind a blocking `failure` is every blocking finding that is still
open: this run's blocking findings, plus each blocking finding from an earlier review of the PR that has not
been cleared (subject to the known gap at the end of this paragraph). A finding is still open when it is carried forward unchanged, when the verifier could not
decide, when a triage reply deferred it, or when a triage reply dismissed it. A dismissal the adjudicator
upheld counts too. A finding whose dismissal the adjudicator rejected, or that a triage reply marked `misclassified`, stays open across later pushes too. A finding leaves the count only when the re-review verifies it gone, or when every file it
names was deleted. Triage replies (`applied`, `dismissed`,
`deferred`, `misclassified`) do not turn the gate green on their own, because the CI-side adjudicator checks them only when someone comments `/pr-hero recheck` (see [Rechecking a dismissal](#rechecking-a-dismissal)). The `pr-hero` status counts unresolved blocking findings across re-reviews, as above, while the step summary and the `blocking-count` output count only this run's own blocking findings. On a re-review the two numbers can differ: an earlier blocking finding can still be open while this run finds none. **State block.** From the second review on, the summary carries a `pr-hero-state` block: the merged live set of the pull request's open findings. It holds every surviving earlier finding and this run's findings, so a blocking finding first raised by a re-review still counts on the next review, including a same-head `/pr-hero review` that runs no hunters. A finding that a re-review verified gone leaves the block. Each row keeps its `R###` id. The block's `hw` field is the highest id ever assigned on the pull request, so a retired id is never reused. When the summary would exceed GitHub's comment size limit, the cap drops prior advisory findings first (unconfirmed, then carried), never a blocking finding, and the summary states how many finding identities it dropped from the block. Known gap: the first review writes no state block, so an outside-diff finding of the first review is not persisted. Its inline findings are recovered from their markers on the second review.


**Unlocking a gate.** A `failure` for blocking findings clears in one of two ways. A fix pushed to a new head
clears its own finding once the re-review verifies it gone. `/pr-hero override` from a user with write access
turns the status green for that head with no new review. The re-review does not clear it by itself: a same-head
`/pr-hero review` runs the same count, so the `failure` stays. The size and budget `failure` is the one that
`/pr-hero review` clears, because that run passes both gates. `/pr-hero override` is described next.

**Rechecking a dismissal.** Comment exactly `/pr-hero recheck` on the pull request. It is `/pr-hero review` plus the CI adjudicator:
the same write-access check and the same forced review of the head, and then the adjudicator rules on each pending `dismissed` reply
to a blocking finding, at most 5 per run. Only a dismissal the adjudicator upholds leaves the gate count. A `deferred` or
`misclassified` reply never does, and a rejected or inconclusive verdict keeps the finding counted. The verdict is posted as a reply
on the finding's thread by `github-actions[bot]`, and only replies from that login count, so a run with a custom token fails closed.
A new dismissal reply is pending again. A verdict counts only on the head it was given, so a push needs a new recheck. An adjudicator step that fails posts nothing for that dismissal: it prints a notice and stays pending for the next recheck. The recheck run itself never changes the count: an upheld verdict leaves it from the next review of the same head (`/pr-hero review`), which reads the reply back, and only when GitHub recorded the reply under `github-actions[bot]`. If the reply did not land under that login, the recheck warns and the finding keeps counting. Dismissals never ruled on are adjudicated before retries of an inconclusive one. Not on fork pull requests: the adjudicator needs this repository's checkout of the head,
so the comment is refused with a notice and a 👎 reaction.

**Overriding a red gate.** Comment exactly `/pr-hero override` on the pull request. The same rule as
`/pr-hero review` applies: a user with write or admin access may do it, and the pull request's author may too
when they have that access. Anyone else is refused with a notice and a 👎 reaction on the comment, and nothing is posted. The override turns the `pr-hero` status on the head it names
into `success`, with the description `pr-hero: overridden by @<login> — no review on this head`. It runs no
review and spends nothing, and it needs no credential, so a repository without one can still unlock its gate.

Every override is recorded. The status names who acted, and a pr-hero comment on the pull request names who,
on which head, and when (UTC). It starts with `<!-- pr-hero-override`, and no later cleanup removes it, so the
history of overrides stays on the pull request. The override also removes earlier outcome comments from the pull request, as a completed review does, and keeps every override record.

An override is valid only for the head it names. The newest status on a head wins, so the override stands
until one of two things happens: a new push creates a new head, which is reviewed on its own, or a later
`/pr-hero review` on that same head posts a newer status. A `failure` from that review then replaces the
override.

**An override stands against a review that was already running when it was posted; a review started after it replaces it.**
The rule holds for every verdict write (`success` or `failure`) of the review, including the publisher step's repost of a
status the CLI could not write. Each verdict write checks the head's newest `pr-hero` status first. When that status is an
override created after the review started, allowing 5 seconds of clock skew between the runner and GitHub, the write is
skipped and the run logs one line that the override stands. When the review's own pending status did not land, the allowance
is zero, because nothing else on the head shows when the review started. When the head's statuses cannot be read, the review's verdict is written and a warning is logged, since the override cannot be checked. A status row that does not parse is ignored and the valid rows decide, so a fresh override beside a malformed row still stands; only a failed read (GitHub's answer is an error or the lookup times out) counts as unreadable. The review's findings and comments are unchanged.
A review that fails (for example, every hunter failed), is cancelled, or crashes can replace the override with its own
`error` status; comment `/pr-hero override` again.

Two limits. First, a fork pull request cannot be overridden: `/pr-hero override` is refused there with a notice and a 👎 reaction,
because a fork's head can change after the comment, so the override would not be bound to the code you saw. Second, GitHub keeps one pending run per
concurrency group, and that applies to an override from an `OWNER`, `MEMBER` or `COLLABORATOR`: such an
override that is queued behind a running review is replaced if another comment on the same pull request
arrives before it starts, and then no override comment appears. Comment `/pr-hero override` again when that
happens. If the pull request lookup fails twice, the override is refused, since it cannot tell whether the
pull request comes from a fork; comment again. A
re-run of the comment's job (run attempt 2 or later) is refused with a notice and no reaction, because it would apply the
override to the head as it is at the re-run; comment `/pr-hero override` again.

**A failed final write.** In gate mode, when the review itself finished, the job fails with an `::error::`
annotation if the final status cannot be written. When the review was also delivered, the CLI records the status
it could not write, even if a step after delivery then failed, and the publisher step later in the same job posts that status once more, so the required
check can settle without a new run. The job still fails with its `::error::` annotation. If that second write
fails too, the publisher adds its own `::error::` annotation, and the head stays `pending` until a
`/pr-hero review` comment forces a review. If the review had already failed before delivery, the job exits with that failure,
and the failed status write is only logged, so it never replaces the review's own error. Either way the
commit-status lock is still released. On an already-reviewed head, the same-head admission skip runs first and
posts no status, so the head stays `pending` until a `/pr-hero review` comment forces a review, which writes the
status again. The pending status, written when a review starts, is best-effort in both modes.

**Local runs and the watcher post on `pr-hero/local`.** Only an explicit `--ci` run writes the `pr-hero`
status, which is the required check. A `pr-hero review --pr` you run locally, and each review that
`pr-hero watch` starts, post advisory statuses on `pr-hero/local` instead, so they cannot overwrite a red gate
on the same head. Only the `--ci` flag makes a run post to the gate; `CI=1` in your shell does not. The watcher yields
to a review in flight on either context, and it settles only its own leftover pending, on `pr-hero/local`. A `--ci`
run stands down only for a pending on `pr-hero`, because only it writes that context, so a local pending never
leaves the required check unsettled.

Local statuses used to share the `pr-hero` name. A status a local run wrote there before this change stays in
that head's history, and the next `--ci` run on the head is what settles the gate.

Three things can make the job fail. Only the first sets `status=error`:

| Cause | Exit | `status` |
|---|---|---|
| A genuinely fatal failure — missing/invalid credentials, a crashed process, a malformed argument | `2` for a bad argument, `1` otherwise | `error`, plus an `::error::` annotation naming it |
| Every hunter died, so nothing was reviewed | `1` | **unset** — see the known gaps below |
| The review ran, but some findings could not be posted to the PR | `1` | `reviewed`, describing the findings that did land |

The middle case publishes no outputs and no step summary on purpose: a run where nothing was hunted has
no result to report, and emitting `reviewed` with `findings-count=0` for it would read to a human as a
PR that came back clean.

## Outputs

| Output | Meaning |
|---|---|
| `status` | `reviewed`, `skipped-size`, `skipped-budget`, or `error` — see the caveat below. |
| `findings-count` | Total verified findings. |
| `blocking-count` | Blocking-tier findings. |
| `advisory-count` | Advisory-tier findings. |
| `cost-usd-est` | Estimated review cost in USD, e.g. `"2.45"`. |
| `run-dir` | Path to the run directory containing `findings.json` and `report.md`. |

A **clean** review (nothing found) still reports `status=reviewed`, just with `findings-count=0` — there
is no separate "clean" status. If you need `if:` logic that reacts to a clean PR, branch on
`findings-count == 0`, not on `status`.

### Known gaps: two cases leave `status` empty

**A concurrent review.** If two runs land on the exact same commit in quick succession (e.g. two rapid
pushes), the second one detects the first is still in-flight and exits `0` **without setting any output
at all**. This is a pre-existing behavior, not new in this release, and is tracked as an open follow-up
rather than silently absorbed into the enum (see
`openspec/changes/pillar3-github-actions-ci/spec.md` §1.1's Phase 5 amendment for the full reasoning).

**A review where every hunter died.** The job exits `1` and writes nothing, for the reason given under
"Gate mode" above: there is no outcome to report, and the alternative — a step summary reading
"No findings detected" over a review that never ran — is worse than silence. Giving this case a status
of its own is an open follow-up.

The two are told apart by the exit code: green with an empty `status` is the concurrent run, red with an
empty `status` is the dead one. If your workflow branches on `steps.<id>.outputs.status`, treat an
**empty** value on a green job as "no review outcome yet — a concurrent run owns this head", not as a
failure.

## Triaging a CI review

Answering a posted finding goes through the driver:

```bash
pr-hero triage reply --pr <n> --from <run-dir> --finding F001 \
  --tag applied --body-file reasoning.md
```

`--from` needs the **run directory that produced those findings** — the driver opens
`comparison.json` there and reads `findings.json` to map `F001` onto the posted
`<!-- pr-hero-finding` marker. Locally that directory is still on your disk. In Actions it lives on the
runner at `~/.prhero/repos/<host>/<owner>/<repo>/runs/pr-<n>-<sha>-1` and **dies with the job**, so the
action uploads it as an artifact in its last step.

### Downloading the run directory

```bash
# Find the review run for the PR (or read the run id off the checks tab)
gh run list --workflow "pr-hero Review" --branch <head-branch> --limit 5
# A `/pr-hero review` comment run is listed under the default branch instead
gh run list --workflow "pr-hero Review" --event issue_comment --limit 5

# Download the artifact into ./pr-hero-run/
gh run download <run-id> \
  -n pr-hero-run-<pr-number>-<head-sha> \
  -D pr-hero-run

# Then triage against it
pr-hero triage reply --pr <n> --from pr-hero-run --finding F001 \
  --tag applied --body-file reasoning.md
```

The artifact name carries **both** the PR number and the full head sha (`<head-sha>` is the pull
request head the action resolved for the run, on a comment run too, not the 8-character prefix in the
directory name), so a PR reviewed across several pushes has one unambiguous artifact per reviewed head. `gh run download` unpacks the run
directory's *contents*, not the directory itself — point `--from` at whatever directory you downloaded
into (`-D`), not at a `pr-<n>-<sha>-1` path inside it.

### What is in it, and how long it lives

The run directory holds the reviewed diff (`diff.patch`), the rendered agent prompts, every hunter draft,
`findings.json`, `pipeline.json`, `report.md`, and the per-attempt step logs. **On a public repository,
workflow artifacts are downloadable by anyone** — which is why `retention-days: 7` is deliberately short:
long enough to triage, short enough to bound exposure. Lengthen it only if you have weighed that.

Three properties of the action's upload step are load-bearing:

- **`if: always()`** — a *failed* review is when this directory matters most. When every hunter dies
  (e.g. bad credentials), the per-attempt logs under `steps/logs/` are the only record naming the cause.
- **`if-no-files-found: warn`** — a size-gated, budget-gated, or concurrent review writes no run
  directory. That is correct behavior and must never turn the job red.
- **`overwrite: true`** — artifact names are unique per workflow *run*, and `gh run rerun` reuses the run
  id, so a re-run's upload would otherwise conflict.

> **Known gap.** Four outcomes publish no usable `run-dir`, so the upload's empty-`run-dir` condition
> suppresses it for all of them:
>
> - a **concurrent review** and a run where **every hunter died** — the two cases that leave `status`
>   empty (see above), because no output is written at all;
> - a **fatal error**, which reports `status=error` but writes `run_dir=""` explicitly;
> - a **cancelled job**, where the signal handlers kill the child processes and exit without ever
>   reaching the code that writes the job's output file.
>
> The every-hunter-died and cancelled cases are exactly the failures `always()` exists to cover, so the
> gap bites hardest where the directory would help most. Closing it requires the action to publish
> `run-dir` on those paths — an open follow-up in the CLI, not something to work around in the workflow.
> `always()` still earns its place for a review that ran but could not post, and for a later step in the
> job failing.

## Reading a PR with `pr-hero status`

`pr-hero status --pr <n> [--json]` reads one PR's state through `gh`. It is read-only and writes nothing to
GitHub, so a skill can drive review, reply, fix and wait from it instead of reading comments by hand. Without
`--json` it prints a few lines on stderr. With `--json` it prints one object on stdout, and nothing else:

```json
{
  "schema": "pr-hero.status/v1",
  "pr": 12,
  "head": "<40-hex headRefOid>",
  "gate": { "state": "failure", "description": "pr-hero: 1 blocking finding(s) — fix and push, or /pr-hero override", "target_url": "<run url>", "created_at": "<ISO time>", "pending_in_flight": false, "override": { "active": false, "by": null } },
  "report": { "head": "<40-hex>", "complete": true, "reviews": 2, "outcome_code": null },
  "findings": [
    { "id": "R001", "path": "src/a.ts", "line": 10, "head": "<40-hex>", "comment_id": 41, "channel": "inline",
      "severity": "CRITICAL", "tier": "blocking", "blocking": true, "live_on_head": true,
      "triage": { "tag": "dismissed", "verdict": "upheld", "actor": "agent", "head": "<40-hex>" } }
  ],
  "unresolved_blocking": 1,
  "next_action": "triage",
  "reason": "1 live blocking finding(s) on this head have no triage reply at the head they were posted on; triage them first."
}
```

- `gate` is pr-hero's own commit status on the head. `state: "none"` means no `pr-hero` status is on it.
- `findings` covers every posted `<!-- pr-hero-finding` comment, on every head. `channel` is `inline` for a review
  thread and `outside` for a top-level comment. `triage` is the newest triage reply in its thread only.
- A finding joins its state-block row the way the engine binds a prior to its comment: the comment's anchor must land
  within the row's locations, and the claim fingerprint breaks only a tie. The anchor is the marker's path and line,
  and the review comment's live path and line when GitHub has moved them (a rename, or a re-anchored line), so a row
  the re-review rewrote to a new path still joins. A finding with no such row has `id: null`, and `live_on_head` is
  true only when it was posted on the current head. A row that is found keeps the finding live, so a carried finding
  from an older head stays live.
- `tier` is the tier the comment's header badge or the state row reports: `blocking` or `advisory`, or `unrecoverable`
  when neither can give one (the engine's own sentinel). It is never `null`. `blocking` is true for every tier but
  `advisory`, because the gate counts an unrecoverable row as blocking too: a finding that cannot be read as advisory
  is never read as clear. `unresolved_blocking` and `next_action` read `blocking`, never `tier`.
- `unresolved_blocking` is the count in a red gate's description when it has one. Otherwise it is the number of
  live blocking findings in `findings`.
- `report.outcome_code` is the `PRH-*` code of the newest outcome comment, when that comment has one.

`next_action` is decided in this order, and the first match wins:

| `next_action` | When |
| --- | --- |
| `wait` | The gate is pending and in flight (less than 90 minutes old). |
| `review` | No `pr-hero` status is on the head, the gate errored, a pending gate is older than 90 minutes and no run holds it, the gate is red over a partial review (`pr-hero: review partial (N of M hunters failed)`, or its carried form), or the gate passed over a partial review of this head (some reviewers failed), which the engine itself runs again. |
| `done` | The gate passed over a complete review of this head, and every finding posted on this head has a reply at that head. An override that turned the gate green is `done` even when a finding is still unanswered, because a human unlocked the head. A partial review of an older head is not this head's to act on. |
| `triage` | The gate is red and a live blocking finding on this head has no triage reply at the head it was posted on. Or the gate passed without an override and a finding posted on this head has no reply at that head: the triage skill answers advisory findings too. |
| `fix` | The gate is red, every live blocking finding is answered, and one of them is tagged `applied`. Push the fix; the next review verifies it. |
| `override-or-fix` | The gate is red, every live blocking finding is answered, and none is `applied`. A skipped review (size or budget) also lands here. Fix and push, or run `/pr-hero override`. |

The command fails closed. A failed `gh` read, a read that never answers within its bound, a truncated comment list, or a
gate status it cannot read exits 1 with nothing on stdout, so a partial answer never looks like a clean PR.

## Optional inputs

| Input | Default | Purpose |
|---|---|---|
| `pr-number` | resolved from the triggering event | Override when triggering from an event that carries no pull request. Only a legacy `pr-hero-force.yml` sets it, from its dispatch input; the current workflow passes nothing. |
| `force` | `false` | Bypass the size gate, CI admission, and the budget ceiling for this run. A `/pr-hero review` comment from a user with write access sets it on its own; a legacy `pr-hero-force.yml` sets it to `true`. A forced run that reviews a head clears a size or budget skip's `failure` status. |
| `mode` | `gate` | The commit status the review sets: `gate` turns it `failure` on blocking findings and on a size or budget skip, `advisory` keeps it `success` for a finished review. See [Gate mode](#gate-mode-the-status-is-the-check). |
| `full` | `false` | On a re-review, widen discovery to the full pull request range (`--full`). A `/pr-hero review --full` comment sets it on its own; a legacy `pr-hero-force.yml` passes its `full` dispatch input. Use it when a prior review of the same head was hollow or wrong. |
| `model` | engine default | Override every agent's model. |
| `scout` | `false` | Experimental diff-only pre-hunt stage; off by default. |
| `post` | `true` | Set `false` to run the review and write outputs/summary without posting to the PR. |
| `step-summary` | `true` | Set `false` to skip the `$GITHUB_STEP_SUMMARY` write. |
| `routing` | empty | Person-layer routing JSON (`config.routing` object). Wire from `vars.PRHERO_ROUTING` (quoted). See [OpenCode in CI](#opencode-in-ci). |
| `opencode-auth` | empty | Whole OpenCode `auth.json` blob. Wire from `secrets.OPENCODE_AUTH_JSON`. Never echo. |

## Error codes

When the action stops with an error, the annotation and the job summary start with the owner, then say what is wrong, why, and the command that fixes it. The owner tells you whose fix it is: **Your configuration:** means a secret, a variable, a workflow permission or a repository file needs a change; **Provider `<name>`:** means the provider rejected, limited or failed the request; **pr-hero defect:** means pr-hero itself failed, and the fix reports it with the run URL; **Unclassified:** means pr-hero could not attribute the failure and says so instead of guessing. **Not reviewed:** is a notice for a run that a newer push superseded, not an error.

### PRH-CRED-MISSING

**Owner:** your configuration

**What:** No credential for the {backend} route reached the action

**Why:** pr-hero cannot authenticate, so it cannot review this PR

**Fix**, on a Claude route:

Set one credential for the route you use:

```bash
claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN
gh secret set ANTHROPIC_API_KEY
opencode auth login && gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json
```

If the secret is already set, check that the workflow passes it to the action under `with:`, for example `claude-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` or `anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}`: a secret the workflow does not pass never reaches pr-hero.

Dependabot PRs read Dependabot secrets, so set this one too:

```bash
gh secret set --app dependabot CLAUDE_CODE_OAUTH_TOKEN
```

Then re-run the workflow:

```bash
gh run rerun {runId}
```

**Fix**, on an OpenCode route:

Set the OpenCode credential for the route you use:

```bash
opencode auth login && gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json
```

If the secret is already set, check that the workflow passes it to the action under `with:`, for example `opencode-auth: ${{ secrets.OPENCODE_AUTH_JSON }}`: a secret the workflow does not pass never reaches pr-hero.

An OpenCode route also needs the routing variable:

```bash
gh variable set PRHERO_ROUTING --body '<routing-object-json>'
```

Dependabot PRs read Dependabot secrets, so set this one too:

```bash
gh secret set --app dependabot OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json
```

A Claude route uses `CLAUDE_CODE_OAUTH_TOKEN` instead, from `claude setup-token`.

Then re-run the workflow:

```bash
gh run rerun {runId}
```

### PRH-CRED-UNUSABLE

**Owner:** your configuration

**What:** The {backend}/{provider} route for {step} has no usable credential ({detail})

**Why:** the credential store does not hold what this route needs

**Fix**, by failure class:

#### `missing_provider_record`

**What:** The route {provider}/{model} has no usable credential record

Every hunter of the run failed on the missing record, so the lead names the route. When the route is not known, the sentence reads "The {backend}/{provider} route for {step} has no usable credential ({detail})".

Add {provider} to the OpenCode store, then re-set the secret:

```bash
opencode auth login
gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json
```

#### `missing_subscription_record`

On the Claude route (`backend` is `claude-code`, or no OpenCode backend):

Log in again with `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN`:

```bash
claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

On the OpenCode route (`backend` is `opencode`):

Provider `openai` expects a ChatGPT login: run `opencode auth login` and choose ChatGPT, then re-set the secret:

```bash
opencode auth login
gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json
```

Or rename the provider in PRHERO_ROUTING.

#### `malformed_payload`

**What:** The credential store is not usable: {detail}

Check that the store is a JSON object:

```bash
jq -e 'type=="object"' ~/.local/share/opencode/auth.json
```

Then re-set the secret:

```bash
gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json
```

#### `source_read_failed`

Set the secret again:

```bash
gh secret set {secret}
```

#### `env-absent`

Set the secret again:

```bash
gh secret set {secret}
```

### PRH-CRED-REJECTED

**Owner:** your configuration

**What:** provider {provider} rejected the credential in {secret}

**Why:** it is expired, revoked, or a short-lived /login session token

**Fix:**

```bash
claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

Or, for OpenCode, re-export the auth store and re-set the secret:

```bash
gh secret set OPENCODE_AUTH_JSON < ~/.local/share/opencode/auth.json
```

Then ask for a new review:

```bash
gh pr comment {pr} --body "/pr-hero review"
```

### PRH-ROUTING-MISSING

**Owner:** your configuration

**What:** OpenCode auth is set but PRHERO_ROUTING is empty, so the default Claude route is used

**Why:** the run would fail later at the Claude credential check

**Fix:**

```bash
gh variable set PRHERO_ROUTING --body "$(jq -c .routing ~/.prhero/config.json)"
```

### PRH-ROUTING-INVALID

**Owner:** your configuration

**What:** PRHERO_ROUTING is invalid: {detail}

**Why:** pr-hero cannot tell which backend and model each agent should use

**Fix:**

Edit the JSON, then set it again:

```bash
gh variable set PRHERO_ROUTING --body "$(jq -c . routing.json)"
```

### PRH-ROUTE-UNRESOLVABLE

**Owner:** your configuration

**What:** Model routing for {step} has no usable route: {detail}

**Why:** every agent needs exactly one backend, provider and model

**Fix**, by reason:

#### `unmapped`

Add or complete this model's route in PRHERO_ROUTING, with an explicit `modelSnapshot`.

#### `ambiguous`

Remove the duplicate mapping for this route from PRHERO_ROUTING.

#### `spend-disabled`

Enable spend for this route in PRHERO_ROUTING.

#### `multiple-opencode-providers`

Keep one OpenCode provider per review in PRHERO_ROUTING.

### PRH-MODEL-UNAVAILABLE

**Owner:** provider

**What:** Provider {provider} does not serve the model configured for {step}

**Why:** the routing names a model this provider does not offer

**Fix:**

Fix the `modelSnapshot` for this step in PRHERO_ROUTING.

List the models this provider serves:

```bash
opencode models {provider}
```

#### `every_hunter`

**What:** the configured model {model} is not served by this provider

Every hunter of the run was refused for the same model, so the lead names the provider and the sentence names the model. When the model is not known, the sentence says "the configured model" and nothing else. A run where any hunter failed another way keeps `PRH-HUNTERS-FAILED`.

#### `provider_configuration_invalid`

**Owner:** your configuration

The `provider_configuration_invalid` cause shares this code. Its lead stays `Your configuration:`, and the fix is the one above.

### PRH-PROMPTSET-INVALID

**Owner:** your configuration

**What:** The prompt set is invalid: {detail}

**Why:** an agent file or PRHERO_EXTRA_HUNTERS entry cannot be loaded

**Fix:**

Fix the file or `agents_dir`, then check for free:

```bash
pr-hero review --pr {pr} --dry-run
```

### PRH-GOTCHAS-MISSING

**Owner:** your configuration

**What:** .prhero/gotchas.md is missing or still the scaffold

**Why:** reviews need real repository facts to be accurate

**Fix:**

Write real facts about this repository, delete the scaffold marker line, and commit the file to the base branch (comment-triggered runs read the base branch).

### PRH-CONFIG-INVALID

**Owner:** your configuration

**What:** .prhero/config.json is invalid: {detail}

**Why:** pr-hero refuses to guess repository settings

**Fix:**

Fix the file, then check it:

```bash
pr-hero review --pr {pr} --dry-run
```

### PRH-TOKEN-PERMISSION

**Owner:** your configuration

**What:** The workflow token lacks `{scope}: write`

**Why:** pr-hero cannot post its result on the PR

**Fix:**

Add `{scope}: write` to the job's `permissions:`, or re-scaffold the workflow:

```bash
pr-hero ci init --force
```

#### `no-scope`

When the scope is not known, pr-hero names the refusal and not a scope it cannot know.

**What:** GitHub refused the workflow token (HTTP 403) during {step}

**Why:** pr-hero cannot post its result on the PR

**Fix:**

Check that the workflow passes `github-token: ${{ secrets.GITHUB_TOKEN }}` on the action step, and keeps the `permissions:` block that `pr-hero ci init` scaffolds:

```bash
pr-hero ci init --force
```

### PRH-GITHUB-TOKEN-INVALID

**Owner:** your configuration

**What:** The github-token input is invalid

**Why:** every GitHub API call is rejected

**Fix:**

Set `github-token: ${{ secrets.GITHUB_TOKEN }}` on the action step.

### PRH-GITHUB-UNAVAILABLE

**Owner:** provider

**What:** the GitHub API failed (HTTP {detail})

**Why** and **Fix**, by cause:

#### `rate_limit`

**What:** the GitHub API rate limit was reached

**Why:** GitHub has throttled this token, so an immediate retry would fail the same way

**Fix:**

Wait for the limit to reset, then re-run the workflow:

```bash
gh run rerun {runId}
```

#### `server`

**Why:** the failure happened on GitHub's side, and a retry may succeed

**Fix:**

Re-run the workflow:

```bash
gh run rerun {runId}
```

### PRH-PR-UNRESOLVED

**Owner:** your configuration

**What:** pr-hero could not determine the pull request number or head

**Why:** nothing can be posted on a PR it cannot identify

**Fix:**

Run from a pull_request or issue_comment event, or pass the `pr-number` input.

#### `malformed-input`

The `pr-number` input was given but is not a positive integer. pr-hero names the input and never echoes its value.

**What:** pr-hero could not determine the pull request number or head ({detail})

**Why:** nothing can be posted on a PR it cannot identify

**Fix:**

Pass a positive integer as the `pr-number` input.

### PRH-STATUS-WRITE-FAILED

**Owner:** unclassified

**What:** pr-hero could not write its commit status ({detail})

**Why:** the required check has no result for this head without it

**Fix:**

Re-run the failed jobs:

```bash
gh run rerun {runId} --failed
```

If it repeats, report it.

#### `permission`

**Owner:** your configuration

**Why:** the required check has no result for this head without it

**Fix:**

Add `statuses: write` to the job's `permissions:`, or re-scaffold the workflow:

```bash
pr-hero ci init --force
```

#### `server`

**Owner:** provider

**Why:** the required check has no result for this head without it

**Fix:**

Re-run the workflow:

```bash
gh run rerun {runId}
```

### PRH-RUNTIME-UNAVAILABLE

**Owner:** pr-hero in the action, your configuration locally

**What:** a runtime pr-hero depends on is unusable: {detail}

#### `action`

**Why:** the action installs this runtime itself, so this is a pr-hero defect

**Fix:**

Report it with this run:

```bash
gh issue create -R juanmaagd/pr-hero --title "PRH-RUNTIME-UNAVAILABLE" --body "{runUrl}"
```

#### `local`

**Why:** a required tool is missing from your environment

**Fix:**

Reconcile the pr-hero install:

```bash
pr-hero upgrade --reconcile
```

### PRH-INSTALL-FAILED

**Owner:** unclassified

**What:** The {step} step failed

**Why:** a download or install step failed, and pr-hero cannot tell which external cause it was

**Fix:**

Re-run only the failed jobs:

```bash
gh run rerun {runId} --failed
```

If it repeats, report it.

### PRH-PROVIDER-LIMITED

**Owner:** provider

**What:** rate limit or quota reached

**Why:** the provider has throttled this account or key, so an immediate retry would fail the same way

**Fix:**

Wait, or raise the quota, then ask for a new review:

```bash
gh pr comment {pr} --body "/pr-hero review"
```

### PRH-PROVIDER-UNAVAILABLE

**Owner:** provider

**What:** unreachable

**Why:** the request did not complete, and the provider's outcome cannot be confirmed from here

**Fix:**

Re-run the workflow:

```bash
gh run rerun {runId}
```

### PRH-PROVIDER-REFUSED

**Owner:** provider

**What:** the request was refused

**Why:** the provider's safety system declined this input

**Fix:**

Ask for a new review once:

```bash
gh pr comment {pr} --body "/pr-hero review"
```

If it repeats, report it.

### PRH-ENGINE-DEFECT

**Owner:** pr-hero

**What:** pr-hero hit an internal error ({detail}) in {step}

**Why:** this is a defect in pr-hero, not in your configuration

**Fix:**

Report it, with this run:

```bash
gh issue create -R juanmaagd/pr-hero --title "PRH-ENGINE-DEFECT {detail}" --body "{runUrl}"
```

### PRH-HUNTERS-FAILED

**Owner:** unclassified

**What:** Every review hunter failed in {step}: {detail}

**Why:** no hunter returned a result, so there is no finding to report

When every failed hunter shares a `model_unavailable` cause with its provider known, the run renders `PRH-MODEL-UNAVAILABLE` instead; when every failed hunter shares a `missing_provider_record` cause with its provider and model known, it renders `PRH-CRED-UNUSABLE`. Any other cause, a missing provider or model, a mix of causes, a hunter with no cause, or a `runtime_unavailable` cause keeps this code.

**Fix:**

Re-run the failed jobs:

```bash
gh run rerun {runId} --failed
```

If it repeats, report it.

### PRH-UNCLASSIFIED

**Owner:** unclassified

**What:** pr-hero stopped at {step} and could not tell why

**Why:** rather than guess, it reports this honestly

**Fix:**

Re-run the failed jobs:

```bash
gh run rerun {runId} --failed
```

If it repeats, read the log and report it:

```bash
gh run view {runId} --log-failed
```

#### `github`

**What:** GitHub returned {detail} at {step}, and pr-hero cannot tell whose fix it is

**Why:** pr-hero does not map this GitHub status to an owner, so it does not guess

**Fix:**

Re-run the failed jobs:

```bash
gh run rerun {runId} --failed
```

If it repeats, read the log and report it:

```bash
gh run view {runId} --log-failed
```

### PRH-CANCELLED

**Owner:** unclassified

**Shown as:** `Not reviewed:`, as a notice rather than an error

**What:** The review was cancelled or superseded by a newer push

**Why:** a newer run replaces this one, so this result would describe an outdated head

**Fix:**

Ask for a review of the current head:

```bash
gh pr comment {pr} --body "/pr-hero review"
```

## Troubleshooting

- **`pr-hero doctor`** locally reports whether `.github/workflows/pr-hero.yml` exists; inside Actions it
  reports whether the required secrets (or OpenCode auth file) are present (never their values).
- **The review was skipped** (size, budget, or admission) — comment `/pr-hero review` on the pull
  request. `gh run rerun` on `pr-hero.yml` re-evaluates the gates and skips again. On a workflow
  scaffolded before the comment trigger, run `gh workflow run pr-hero-force.yml -f pr=<n>` instead.
- **A `/pr-hero review` comment did nothing** — the comment trigger reads `pr-hero.yml` from the
  default branch, so it works only once that file (with its `issue_comment` trigger) is merged there.
  The comment must be exactly `/pr-hero review` or `/pr-hero review --full`, and its author needs
  write access to the repository. An older `pr-hero.yml` has no comment trigger at all: re-scaffold
  with `pr-hero ci init --force`.
- **The run is red and names a missing credential** — none of `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, or `OPENCODE_AUTH_JSON` is set. The step summary lists the `gh secret set`
  commands; adding a secret does not re-run past workflows, so re-run that run afterwards.
- **Every re-run says "No changes to discover" after a hollow review** — a prior review of the same
  head completed without really reviewing (for example, every hunter returned nothing within
  seconds), and its summary marker now scopes discovery to nothing. On a head that was genuinely
  reviewed this message is expected and needs no action. Otherwise, comment `/pr-hero review --full`
  to re-discover the whole pull request; see [Re-review on demand](#re-review-on-demand).
- **No comment appears on the PR** — check `permissions: pull-requests: write` is present, and that at
  least one of the three credential secrets is set (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or
  `OPENCODE_AUTH_JSON`). Fork pushes never receive those secrets; a maintainer's `/pr-hero review`
  comment reviews them. OpenCode also needs `PRHERO_ROUTING`.
- **The review job is red** — never because of findings. Read `status` to tell the three causes apart:
  `error` is a fatal failure and the `::error::` annotation in the log names it; an **empty** `status`
  means every hunter died (the log shows their failures); `reviewed` means the review itself succeeded
  but some comments could not be posted. See "Gate mode" above. OpenCode routing without
  `OPENCODE_AUTH_JSON` fails closed rather than skipping.
