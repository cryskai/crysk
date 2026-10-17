# CI sandbox

`juanmaagd/pr-hero-sandbox` is a public scratch repository where the pr-hero review
action runs for real on GitHub's runners, against planted-bug pull requests. It exists so
the pipeline and the Action can be run realistically, including their failure paths,
without opening a PR on the product repo for every test. The goal is realistic runs
that are cheap. The repo is public, so Actions minutes are free.

Code: `scripts/sandbox/` (runner, scenarios, rails). Tests: `test/sandbox/`, offline,
under fakes. Run them with `bun test test/sandbox`.

## Commands

```bash
bun scripts/sandbox.ts init --ref <ref> [--route claude|opencode:<modelSnapshot>]  # idempotent bootstrap; route defaults to claude
bun scripts/sandbox.ts run <scenario...> --ref <ref> [--keep] [--no-retry]  # run scenarios in order, one PR each
bun scripts/sandbox.ts smoke --ref <ref> [--keep] [--no-retry]  # alias of `run review-free`
bun scripts/sandbox.ts list                             # open sandbox/ PRs, then the scenarios
bun scripts/sandbox.ts clean                            # close open sandbox/ PRs, delete their branches
```

- `<ref>` is a tag or branch of `juanmaagd/pr-hero`, pinned into the sandbox workflow.
  Letters, digits, `.`, `_`, `/`, `-`.
- `init` creates the public repo if it is absent, seeds `main` with the fixture's correct
  sources, the product's scaffolded workflow, the repo config and the gotchas, and sets the
  `OPENCODE_AUTH_JSON` secret to `{}` (harmless while routing is unset). The planted bug is
  not on `main`; each scenario commits it on its own branch. A second run with the same ref
  writes nothing. A present secret is left alone, because GitHub never returns its value.
- `--route` sets the model route of every review in the sandbox. The default, `claude`,
  needs the repo secret `CLAUDE_CODE_OAUTH_TOKEN`: `init` checks that it is present, and
  refuses before it changes the routing when it is not, with the command the owner runs:
  `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo juanmaagd/pr-hero-sandbox`. Under `claude`,
  `init` deletes the `PRHERO_ROUTING` variable if it is set, so the scaffolded workflow runs
  the engine's default stack (sonnet hunters, opus refuter, haiku summarizer), which is
  production's. `opencode:<modelSnapshot>` sets `PRHERO_ROUTING` to that OpenCode model
  instead. The snapshot takes letters, digits, `.` and `-`; anything else is refused.
- `run` exits 1 on any failed expectation, any S7 violation, or a refused run. The table
  at the end names each scenario's path and prints every expectation as PASS or FAIL. Run
  does not take `--route`: it runs on the route `init` set.
- A scenario whose only failures are the free model's hunters-failed flake is re-run once,
  on a fresh PR. The table shows both attempts, and the second row is marked
  `(re-run after a hunters-failed flake)`. The exit code is the re-run's. A flake that
  repeats is reported as it is, not re-run again. `--no-retry` turns the re-run off.
- `--keep` leaves each scenario PR open and prints where it is. `clean` closes them. A run
  still going when a phase ends (a timeout, or a signal) is cancelled first, with or without
  `--keep`; the PR is kept only once that run has stopped.
- A phase waits up to 2700 s (45 minutes) for its run: `DEFAULT_TIMEOUT_MS` in
  `scripts/sandbox/runs.ts`. A live free-model review once took 24m36s, and at the old
  25-minute ceiling it was cancelled just before it finished.
- One invocation runs at a time on this machine. It takes `~/.prhero/sandbox.lock` exclusively
  and records its pid there. A second invocation is refused while the lock's process is alive;
  a lock whose process is gone is taken over. A lock that names no pid is refused, and is
  removed by hand once no run is in progress. The lock is released on exit, failure, or signal.

## Cost

- The pre-model scenarios, `no-credential`, `bad-routing`, and the first phase of `size-skip`, cost $0.
  No model is reached.
- The default `claude` route is subscription-backed, $0 cash, and uses subscription quota.
  Reviews run on the `CLAUDE_CODE_OAUTH_TOKEN` subscription. `init` never sets an Anthropic
  API key, so no review is billed per token. `init` refuses the `claude` route while
  `ANTHROPIC_API_KEY` is set on the sandbox, before it writes anything; remove it with
  `gh secret delete ANTHROPIC_API_KEY --repo juanmaagd/pr-hero-sandbox`.
- The `opencode:<modelSnapshot>` route runs reviews on one OpenCode model at cost 0. The
  sandbox used `opencode/big-pickle` until 2026-10-17: it leaks its reasoning into its
  answers, and in about half of its live runs every hunter failed. `deepseek-v4.1-flash-free`
  and `glm-5.3-flash-free` answered cleanly in a probe.
- Free-model hunters can fail. When they do, the run posts `PRH-HUNTERS-FAILED`, and
  the expectations of that run that fail are printed as
  `FAIL (free-model hunters failed: re-run)`. Only that label marks a flake; a plain `FAIL`
  is a finding until a re-run shows otherwise. A flake is re-run once automatically (see
  Commands). The label names the free model, but the re-run rule keys on the cause alone, so
  a hunters-failed run on the claude route is re-run the same way. The hunters-failed
  tolerance and this label need an action ref at or after T2c (`98569d1`), where the publisher renders `PRH-HUNTERS-FAILED`; on an older ref an all-hunters-failed run shows `review did not finish` with no PRH code, and S7 reports it.

## Scenarios

Each phase acts on the scenario PR, waits for the run that action starts, and checks
one observation of the PR. S7 invariants are checked on every observation.

| Scenario | What it proves | Expectations | Cost |
|---|---|---|---|
| `no-credential` | With no model credential input, the action stops before any model. | Outcome comment `PRH-CRED-MISSING`; status `error` with that code; no report on the head. | $0 |
| `bad-routing` | A malformed routing input is refused before any model runs. | Outcome comment `PRH-ROUTING-INVALID`; status `error` with that code; no report on the head. | $0 |
| `bad-gotchas` | A scaffold `.prhero/gotchas.md` on the branch is refused before admission and spend, and the outcome names its owner. | Outcome comment `PRH-GOTCHAS-MISSING` with the owner lead `Your configuration:`; status `error` with that code; no report on the head. The branch commits the scaffold on top of the planted volume (the scenario's file override). | $0 |
| `review-free` | The normal workflow on the claude route reviews the planted bug end to end, and its gate status agrees with the findings it posted. | Path `reviewed`; the run's review step succeeded; the status agrees with the blocking findings on the PR (see Gate status below); at least one report on the head; no outcome comment. | $0 (claude route, subscription quota) |
| `cleanup` | An outcome comment from a failed run is removed once a later run on the same branch completes its review. | Phase 1 (`no-credential`): outcome `PRH-CRED-MISSING`. Phase 2 (push, normal): path `reviewed`; the run's review step succeeded; the status agrees with the blocking findings; a report; no outcome comment. | $0 (phase 2 on the claude route) |
| `comment-trigger` | `/pr-hero review` starts an `issue_comment` run that completes the review, and cleans up after a failed first run. | Phase 1 (normal): path `reviewed` or `hunters-failed`; this is a precondition, not the subject. Phase 2 (`/pr-hero review`): the comment run completed; its review step succeeded; the run left its own artifact (`pr-hero-run-<pr>-<sha>`); path `reviewed`; the triggering comment has the `eyes` reaction. Only the run's own review passes: a skip is a failure, because a forced run bypasses admission and budget. Status and report are not asserted here, since phase 1 left them on the same head. If phase 1 posted an outcome comment, phase 2 also expects none left; otherwise that check is printed as `not asserted`. | $0 (claude route, subscription quota) |
| `near-miss` | A `/pr-hero review` comment that is not the exact command runs no review: it gets the `confused` reaction and no text reply. | Phase 1 (normal): path `reviewed` or `hunters-failed`; a precondition, as in `comment-trigger`. Phase 2 (`/pr-hero review please`): the comment run completed; the triggering comment has the `confused` reaction; the run left no review evidence of its own (no `pr-hero-run-<pr>-<sha>` artifact, and no skip marker posted after its trigger), although its `Run pr-hero` step concludes `success`; this run posted no outcome comment (a `PRH-HUNTERS-FAILED` outcome that phase 1 left may remain). | $0 (phase 1 on the claude route; phase 2 reaches no model) |

| `same-head-rereview` | A blocking finding survives `/pr-hero review` on the same head, so the gate stays red and the author cannot re-run its way to green (S7). | Phase 1 (normal): path `reviewed`; the status agrees with the blocking findings on the PR. Phase 2 (`/pr-hero review`, same head): the comment run completed and its review step succeeded. Its status must still be `failure`, but only when phase 1 posted a blocking finding to carry; otherwise that check is printed as `not asserted: no blocking finding to carry`, because the free model may find nothing to carry. | $0 (claude route, subscription quota) |
| `rereview-fresh-finding` | A blocking finding first found by a re-review is kept in the state block, so the next re-review still counts it (D3, T5c). | Phase 1 (normal): path `reviewed`. Phase 2 (push adding `src/mute.ts`): the pull_request run completed. Phase 3 (`/pr-hero review`): the comment run completed; its review step succeeded; the status agrees with the findings; the report carries a state row at `src/mute.ts`. | $0 (claude route, subscription quota) |
| `review-advisory` | With `mode: advisory`, the status stays `success` for a finished review, whatever it finds. | Path `reviewed`; the run's review step succeeded; status `success`; at least one report on the head; no outcome comment. | $0 (claude route, subscription quota) |
| `override` | A red gate on a reviewed head is unlocked by `/pr-hero override` (S8): the status turns `success` with the actor's name, and an audit comment is posted on that head, with no review and no cost. | Phase 1 (`normal` variant): path `reviewed`; the run's review step succeeded; the status matches the blocking findings; a report; no outcome comment. Phase 2 (`/pr-hero override`): the comment run completed; the head's status is `success` with a description that starts `pr-hero: overridden by @`; the run posted an `<!-- pr-hero-override` comment on that head, after its trigger. | $0 (phase 1 on the claude route; phase 2 reaches no model) |
| `size-skip` | In gate mode, a diff over the size gate sets a red head, and `/pr-hero review` reviews that same head. | Phase 1 (`size-skip` variant, `max-changed-lines: 1`): path `skipped:size`; status `failure` with a description that starts `pr-hero skipped the review`; no report. Phase 2 (`/pr-hero review`): the comment run completed; its review step succeeded; the run left its own evidence; path `reviewed`. | $0 (phase 1 reaches no model; phase 2 on the claude route) |
| `recheck-dismissal` | A false dismissal does not turn the gate green: `/pr-hero recheck` has the CI adjudicator rule on the dismissal, and the finding still counts (T5b, D5). | Phase 1 (normal): path `reviewed`; the status agrees with the blocking findings. Phase 2 (a `dismissed` reply on the first blocking finding's thread, then `/pr-hero recheck`): the comment run completed; its review step succeeded; the head's status is still `failure`; this run posted a CI adjudication reply (`<!-- pr-hero-adjudication`) whose verdict is `rejected` or `inconclusive`. | $0 (claude route, subscription quota) |
| `cancel` | A review run cancelled mid-review leaves the `pr-hero` status settled, not pending (SB3). | Phase 1 (normal): the run is cancelled while the head's `pr-hero` status is pending; the run concluded `cancelled`; the status is not pending. | Up to one cancelled review (cost not measured) |

**Gate status.** `review-free` and `cleanup` do not pin the status to one state, because the free model
finds different things from run to run. Their check, `status matches the blocking findings`, requires
`failure` when the PR shows a blocking finding comment (the `🔴 blocking` header the product posts) and
`success` when it shows none. `review-advisory` pins `success`. The offline fake (`test/sandbox/world.ts`)
models blocking findings only behind an option, so the live runs remain the proof of the product's gate.

**Reaction check.** A comment phase reads the reactions on its own comment, through the rails, as one
GET. The check `the triggering comment has the <content> reaction` asserts the reaction the trigger gives
it: `eyes` for an accepted command (`comment-trigger`), `confused` for a near miss (`near-miss`). A read
that fails leaves the reactions unread, and the check fails on that; it never passes. The check
`the run left no review evidence of its own` asserts that a near miss's run reviewed nothing. It reads the run's artifact and
its skip marker, not its step: the composite `Run pr-hero` step has no `if:` and always concludes, so a near miss's step reads
`success` (GitHub reports it that way). The check `this run posted no outcome comment` reads only the outcome comments this run
created, so a `PRH-HUNTERS-FAILED` outcome from phase 1 does not fail it.

The S7 invariants, checked on every observation, are: an `error` status without a `PRH-`
code; an outcome comment on a head whose status is `success`; a status still `pending`
after its run completed.

## Rails

The runner can reach one repository, and nothing else.

- The target is hardcoded to `juanmaagd/pr-hero-sandbox`. Every `gh` and `git` call goes
  through an allowlist (`scripts/sandbox/rails.ts`). A verb that is not listed is refused.
- `gh` may view, create or clone only the sandbox repo, list and set its secrets, read and
  set its variables, delete exactly `PRHERO_ROUTING` (the claude route's one delete, in
  `--repo <sandbox>` form), list, create, view, close and comment on its PRs, and list and view its runs. `gh api`
  is GET under the sandbox (the reactions read of a comment phase included), plus one DELETE
  of a `sandbox/` branch ref. Field flags are refused, and so is a POST to a reactions path.
- `git` pushes only `origin <branch>`, where the branch is `main` or a `sandbox/` branch,
  and never forced. Force flags, `+` refspecs, `:` deletes, mirror, delete, amend and
  orphan are refused.
- No `repo delete`. `clean` closes PRs and deletes their `sandbox/` branches, nothing else.
- Runs are serialized. A run refuses to start while any scenario PR is open, and while the
  run lock is held. The open PRs are read whole (not searched: the search index lags), and
  filtered to `sandbox/` heads in this repository, so unrelated PRs cannot hide one. With
  `--keep`, a PR is exempt from this check only once its run has stopped. A PR that a failed
  cleanup left open, including one whose run could not be cancelled, blocks the next run
  until `clean` closes it.

## Ref model

- `pull_request` runs read the PR branch's workflow, so the branch's own pin decides them.
- `issue_comment` runs read the default branch's workflow, so `main` must be pinned.
  `init --ref <ref>` pins `main`. A comment scenario refuses to start, and pushes nothing,
  when `main` is not pinned to the ref under test.
- Each scenario branch carries its variant's workflow, built for the same ref. A workflow
  that differs from `main`'s is committed on the branch. A variant's faults sit on top of
  the pinned workflow.

Faults enter only through the sandbox workflow's own inputs and steps, never through
product code. The workflow is the product's scaffold, with `uses: juanmaagd/pr-hero@<ref>`.
The `advisory` variant replaces the scaffold's `mode: gate` line, and `size-skip` adds
`max-changed-lines: 1` after `opencode-auth`. Each refuses unless its anchor line appears exactly
once, so a scaffold change fails the run loudly instead of testing a different workflow.

## Adding a scenario

1. Add the data in `scripts/sandbox/scenarios.ts`: phases, each with an action (`open`,
   `push`, or `comment`), a `wait`, and its `checks`. Use `afterPriorOutcome` for a check
   that only applies when the phase before posted an outcome comment. Use `afterPriorBlocking`
   for a check that only applies when the phase before posted a blocking finding comment.
2. If the scenario needs a different workflow, add a variant in
   `scripts/sandbox/variants.ts`. A variant is a transform that refuses unless its anchor
   line appears exactly once in the scaffold.
3. Add tests. In `test/sandbox/expect.test.ts`, give each phase a recorded pass fixture and
   a recorded fail fixture. A phase without them fails the suite. In
   `test/sandbox/scenario.test.ts`, run the scenario against the fake
   (`test/sandbox/world.ts`); its `runOutcomes` option chooses what each run decides.

## When to use it

- Before any dev→main release.
- For any PR that touches `action.yml`, `src/ci/*`, or the posting path. Use the sandbox
  instead of forcing reviews on the product PR.

## Pending

SB3 is not built yet: `stale-tmp` and `rerun-after-push`. The `timeout` scenario can now
build on the `cancel` probe.
