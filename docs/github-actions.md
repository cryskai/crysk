# GitHub Actions Integration

pr-hero reviews every pull request automatically: a multi-agent hunt with adversarial refutation runs
inside a GitHub Actions job, posts findings as PR comments, writes a step summary, and never blocks the
merge on its own findings.

## Quick path

1. **Add one auth secret** (Settings → Secrets and variables → Actions → New repository secret):
   `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Pick one — never both blank. Leave OpenCode unset:
   that is today's Claude CI.
2. **Add the workflow files.** Run `pr-hero setup --ci` (or `pr-hero ci init`) in a clone of your repo.
   That writes two consumer templates (`uses: juanmaagd/pr-hero@v0`): `.github/workflows/pr-hero.yml`
   (automatic, on each push) and `.github/workflows/pr-hero-force.yml` (manual dispatch, always
   `--force`). Do **not** copy this repository's
   own `.github/workflows/pr-hero.yml`: that file is generated with `OWN_CI_WORKFLOW_OPTIONS` so this
   repo can dogfood the checkout (`uses: ./` and `max-changed-lines: 5000`). `test/packaging.test.ts`
   asserts each file against its own generator options; it does **not** assert the two files are
   byte-identical. The consumer template already wires a credentials job plus quoted `routing` /
   `opencode-auth` inputs; empty values are absent, so Claude-only repos keep those lines.
3. **Open a pull request** from a branch in this repository (not a fork). pr-hero comments inline, posts
   a summary review, and writes a `$GITHUB_STEP_SUMMARY` block within a few minutes.
4. **Verify readiness any time** with `pr-hero doctor` — it checks for the required secrets when run
   inside Actions, and for the workflow file's presence locally.

To review with OpenCode instead of (or mixed with) Claude, add `OPENCODE_AUTH_JSON` and
`PRHERO_ROUTING` after step 1 — see [OpenCode in CI](#opencode-in-ci). You do not need a different
Action.

## What the workflow does

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: pr-hero-${{ github.workflow }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: true

permissions:
  actions: read # admission gate lists this workflow's past runs
  contents: read # actions/checkout
  pull-requests: write # inline comments + review + step summary
  issues: write # resolving/replying on review threads (GitHub models PR conversations as issues)
  statuses: write # commit status updates
  checks: write # admission attempt ledger

jobs:
  credentials:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      has_creds: ${{ steps.detect.outputs.has_creds }}
    steps:
      - id: detect
        env:
          # Secrets are legal in job env, never in a job-level `if`.
          HAS_CREDS: ${{ secrets.ANTHROPIC_API_KEY != '' || secrets.CLAUDE_CODE_OAUTH_TOKEN != '' || secrets.OPENCODE_AUTH_JSON != '' }}
        run: echo "has_creds=${HAS_CREDS}" >> "$GITHUB_OUTPUT"

  review:
    needs: credentials
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository &&
      needs.credentials.outputs.has_creds == 'true'
    runs-on: ubuntu-latest
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
      - name: Upload pr-hero run directory # see "Triaging a CI review" below
        if: always() && steps.pr-hero.outputs.run-dir != ''
        uses: actions/upload-artifact@v4
        with:
          name: pr-hero-run-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}
          path: ${{ steps.pr-hero.outputs.run-dir }}
          include-hidden-files: true
          if-no-files-found: warn
          overwrite: true
          retention-days: 7
```

`pr-hero setup --ci` generates this operator-facing surface (credentials union, quoted routing var,
OpenCode auth secret) plus skip-notice copy and comments — see `src/ci-setup.ts`'s
`generateCiWorkflowTemplate`. It refuses to overwrite a customized workflow already at that path
unless you pass `--force`. Keep every `with:` line even when you only use Claude: an unset secret or
var expands to empty, which the Action treats as absent. Deleting the line for the credential you *did*
set is what breaks. The quotes around `vars.PRHERO_ROUTING` are load-bearing — an unset repository
variable must become the empty string, not broken YAML.

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

The credentials job treats Anthropic key **or** Claude OAuth **or** `OPENCODE_AUTH_JSON` as present.
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

- **Fork PRs** still skip: GitHub does not give forks repository secrets. The review job `if` never
  reads `secrets` — see [Fork pull requests](#fork-pull-requests).
- **OpenCode-only** (only `OPENCODE_AUTH_JSON` set, no Claude secret) **does** start the review job.
- **Mismatch fails closed:** Claude credentials plus OpenCode routing but no `OPENCODE_AUTH_JSON`
  starts the job (the skip union is already satisfied) and then **fails**, rather than skipping as a
  clean review.
- **48 KB** is the GitHub secret/variable size cap for both `OPENCODE_AUTH_JSON` and `PRHERO_ROUTING`.

## Token permissions

The workflow's `permissions:` block needs six scopes, each for a specific reason:

- **`contents: read`** — `actions/checkout` needs to read repository contents.
- **`pull-requests: write`** — posting inline findings, the summary review, and the step summary.
- **`issues: write`** — resolving and replying on review threads. GitHub's API models every PR
  conversation as an issue thread, so this scope is required even though nothing here touches an issue.
- **`statuses: write`** — updating the PR commit status context (pending, success, error).
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

The generated workflow still skips forks, then uses a credentials job so the review job `if` never
reads `secrets`:

```yaml
# credentials job — secrets are legal in this job's env, not in a job-level `if`
HAS_CREDS: ${{ secrets.ANTHROPIC_API_KEY != '' || secrets.CLAUDE_CODE_OAUTH_TOKEN != '' || secrets.OPENCODE_AUTH_JSON != '' }}

# review job — github + needs only
if: >-
  github.event.pull_request.head.repo.full_name == github.repository &&
  needs.credentials.outputs.has_creds == 'true'
```

Same-repo PRs with none of the three credential secrets skip (with a notice that names all three)
instead of failing. Fork PRs skip without that notice — they never receive secrets, so warning on
every fork would be noise.

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
gates, not quality gates, and never fail the job. The comment names the one-shot override:
`gh workflow run pr-hero-force.yml -f pr=<n>`. That dispatches [the force workflow](#manual-override)
on GitHub Actions. It does not change the ceilings for later pushes, and it does not review on the
machine that sends the command.

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
| `manual_only` | No automatic re-review; explicit override required. |

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

### Manual override

When CI skips a pull request — size gate, admission policy, or budget ceiling — dispatch the
force workflow. The review runs on the GitHub Actions runner. The command does not review on
the machine where you type it:

```bash
gh workflow run pr-hero-force.yml -f pr=<number>
```

Write access on the repository is required (`workflow_dispatch`). A fork pull request is refused.
`gh run rerun` on the automatic workflow re-evaluates the gates and does not force.

A local agent (Claude Code) uses that same `gh workflow run`. It must not run
`pr-hero review --pr <n> --force` when the goal is a CI review.

The dispatched run passes `--force`. That bypasses the size gate, admission, and the budget
ceiling for that run only. It does not reset the durable ledger. An empty effective diff
(everything excluded) still does not review.

`--force` never widens discovery. A re-review only hunts the commits since the last completed review,
and that review is identified by the summary marker it posted for its head commit. So when a prior
review of the **same head** was hollow or wrong (for example, its hunters returned nothing), every
later run on that head reports "No changes to discover" and runs no hunter. Recover with the `full`
dispatch input, which passes `--full` and re-discovers the whole pull request range:

```bash
gh workflow run pr-hero-force.yml -f pr=<number> -f full=true
```

Prior findings are still verified and triaged as usual; only discovery widens.

In this repository, `pr-hero-force.yml` runs the pull request's own engine: it is generated with
`OWN_CI_WORKFLOW_OPTIONS`, so its gate resolves the PR head commit first and checkout pins that commit
before `uses: ./`. A dispatch starts on the default branch, so without the pin a forced review would
run the default branch's engine instead of the one under review. Consumer workflows run the published
`juanmaagd/pr-hero@v0`, where the checkout does not select the engine.

- **When it takes effect.** `workflow_dispatch` reads the workflow file from the default branch, so in
  this repository the engine pin and the `full` dispatch input work only once that YAML is on `main`;
  in a consumer repository, `full` needs an action release that declares it, reached through the
  `@v0` tag the workflow pins.
- **`full` on older heads.** In this repository the forced review loads the PR head's own `action.yml`,
  so on a head from before the `full` input existed `full=true` does nothing: merge or rebase the PR
  onto a base that has it first.
- **Trust.** In this repository a forced review runs the PR head's code, including its `bun install`,
  with the workflow's secrets, so dispatch it only for heads you trust: on a bot-authored same-repo
  branch (for example Dependabot's) it skips the secret withholding GitHub applies to that bot's
  `pull_request` runs.

### Check Runs ledger

Admission attempts are persisted as Check Runs named `pr-hero/ci-admission` on the reviewed commit.
The workflow needs **`checks: write`** (listed under [Token permissions](#token-permissions)) so pr-hero can
reserve attempts before provider spend and record outcomes. PR comments remain presentation only; the
Check Run ledger is authoritative.

An attempt counts toward `ci_max_attempts` when its run reached the provider (completed, failed, or
still in progress) or when admission itself skipped it. Three outcomes spend nothing and do not count:
a cancelled run, a run that stood down for a review already in flight on the same head, and a run the
size gate or the budget ceiling skipped before any agent started. A skipped run still shows as a
skipped check on the commit.

Skipped and manual-required outcomes include admission metadata in the step summary: decision, reason,
current head, reviewed head, risk class, score, attempt count, remaining budget, policy mode, and a
short policy hash.

## Assistant posture: it never blocks your merge

pr-hero is a reviewer, not a merge gate. The job exits `0` even when it finds blocking-tier issues —
findings are published as comments and a summary, and the decision to act on them is yours. Nothing
about *what* a review found can turn the job red.

Three things can. Only the first sets `status=error`:

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
"Assistant posture" above: there is no outcome to report, and the alternative — a step summary reading
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
workflow uploads it as an artifact.

### Downloading the run directory

```bash
# Find the review run for the PR (or read the run id off the checks tab)
gh run list --workflow "pr-hero Review" --branch <head-branch> --limit 5

# Download the artifact into ./pr-hero-run/
gh run download <run-id> \
  -n pr-hero-run-<pr-number>-<head-sha> \
  -D pr-hero-run

# Then triage against it
pr-hero triage reply --pr <n> --from pr-hero-run --finding F001 \
  --tag applied --body-file reasoning.md
```

The artifact name carries **both** the PR number and the full head sha (`<head-sha>` is
`github.event.pull_request.head.sha`, not the 8-character prefix in the directory name), so a PR reviewed
across several pushes has one unambiguous artifact per reviewed head. `gh run download` unpacks the run
directory's *contents*, not the directory itself — point `--from` at whatever directory you downloaded
into (`-D`), not at a `pr-<n>-<sha>-1` path inside it.

### What is in it, and how long it lives

The run directory holds the reviewed diff (`diff.patch`), the rendered agent prompts, every hunter draft,
`findings.json`, `pipeline.json`, `report.md`, and the per-attempt step logs. **On a public repository,
workflow artifacts are downloadable by anyone** — which is why `retention-days: 7` is deliberately short:
long enough to triage, short enough to bound exposure. Lengthen it only if you have weighed that.

Three properties of the upload step are load-bearing:

- **`if: always()`** — a *failed* review is when this directory matters most. When every hunter dies
  (e.g. bad credentials), the per-attempt logs under `steps/logs/` are the only record naming the cause.
- **`if-no-files-found: warn`** — a size-gated, budget-gated, or concurrent review writes no run
  directory. That is correct behavior and must never turn the job red.
- **`overwrite: true`** — artifact names are unique per workflow *run*, and `gh run rerun` reuses the run
  id, so a re-run's upload would otherwise conflict.

> **Known gap.** Four outcomes publish no usable `run-dir`, so the `steps.pr-hero.outputs.run-dir != ''`
> condition suppresses the upload for all of them:
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

## Optional inputs

| Input | Default | Purpose |
|---|---|---|
| `pr-number` | resolved from the triggering event | Override when triggering from a non-`pull_request` event. `pr-hero-force.yml` sets this from the dispatch input. |
| `force` | `false` | Bypass the size gate, CI admission, and the budget ceiling for this run. `pr-hero-force.yml` sets it to `true`. |
| `full` | `false` | On a re-review, widen discovery to the full pull request range (`--full`). `pr-hero-force.yml` passes its `full` dispatch input. Use it when a prior review of the same head was hollow or wrong. |
| `model` | engine default | Override every agent's model. |
| `scout` | `false` | Experimental diff-only pre-hunt stage; off by default. |
| `post` | `true` | Set `false` to run the review and write outputs/summary without posting to the PR. |
| `step-summary` | `true` | Set `false` to skip the `$GITHUB_STEP_SUMMARY` write. |
| `routing` | empty | Person-layer routing JSON (`config.routing` object). Wire from `vars.PRHERO_ROUTING` (quoted). See [OpenCode in CI](#opencode-in-ci). |
| `opencode-auth` | empty | Whole OpenCode `auth.json` blob. Wire from `secrets.OPENCODE_AUTH_JSON`. Never echo. |

## Troubleshooting

- **`pr-hero doctor`** locally reports whether `.github/workflows/pr-hero.yml` exists; inside Actions it
  reports whether the required secrets (or OpenCode auth file) are present (never their values).
- **The review was skipped** (size, budget, or admission) — dispatch
  `gh workflow run pr-hero-force.yml -f pr=<n>`. `gh run rerun` on `pr-hero.yml` re-evaluates the
  gates and skips again. The force workflow has to be on the default branch before `workflow_dispatch`
  can see it.
- **Every re-run says "No changes to discover" after a hollow review** — a prior review of the same
  head completed without really reviewing (for example, every hunter returned nothing within
  seconds), and its summary marker now scopes discovery to nothing. On a head that was genuinely
  reviewed this message is expected and needs no action. Otherwise, dispatch `gh workflow run pr-hero-force.yml -f pr=<n> -f full=true` to re-discover the whole pull
  request; see [Manual override](#manual-override).
- **No comment appears on the PR** — check `permissions: pull-requests: write` is present, and that at
  least one of the three credential secrets is set (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or
  `OPENCODE_AUTH_JSON`). Fork PRs never receive those secrets. OpenCode also needs `PRHERO_ROUTING`.
- **The review job is red** — never because of findings. Read `status` to tell the three causes apart:
  `error` is a fatal failure and the `::error::` annotation in the log names it; an **empty** `status`
  means every hunter died (the log shows their failures); `reviewed` means the review itself succeeded
  but some comments could not be posted. See "Assistant posture" above. OpenCode routing without
  `OPENCODE_AUTH_JSON` fails closed rather than skipping.
