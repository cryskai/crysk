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
bun scripts/sandbox.ts init --ref <ref>                 # idempotent bootstrap of the sandbox repo
bun scripts/sandbox.ts run <scenario...> --ref <ref> [--keep]  # run scenarios in order, one PR each
bun scripts/sandbox.ts smoke --ref <ref> [--keep]       # alias of `run review-free`
bun scripts/sandbox.ts list                             # open sandbox/ PRs, then the scenarios
bun scripts/sandbox.ts clean                            # close open sandbox/ PRs, delete their branches
```

- `<ref>` is a tag or branch of `juanmaagd/pr-hero`, pinned into the sandbox workflow.
  Letters, digits, `.`, `_`, `/`, `-`.
- `init` creates the public repo if it is absent, seeds `main` with the fixture's correct
  sources, the product's scaffolded workflow, the repo config and the gotchas, and sets the
  `OPENCODE_AUTH_JSON` secret to `{}` and the `PRHERO_ROUTING` variable to the free route.
  The planted bug is not on `main`; each scenario commits it on its own branch. A second run with the same ref
  writes nothing. A present secret is left alone, because GitHub never returns its value.
- `run` exits 1 on any failed expectation, any S7 violation, or a refused run. The table
  at the end names each scenario's path and prints every expectation as PASS or FAIL.
- `--keep` leaves each scenario PR open and prints where it is. `clean` closes them. A run
  still going when a phase ends (a timeout, or a signal) is cancelled first, with or without
  `--keep`; the PR is kept only once that run has stopped.
- One invocation runs at a time on this machine. It takes `~/.prhero/sandbox.lock` exclusively
  and records its pid there. A second invocation is refused while the lock's process is alive;
  a lock whose process is gone is taken over. A lock that names no pid is refused, and is
  removed by hand once no run is in progress. The lock is released on exit, failure, or signal.

## Cost

- The pre-model scenarios, `no-credential` and `bad-routing`, cost $0. No model is reached.
- Reviews use the OpenCode free route `opencode/big-pickle`, which the OpenCode catalog
  lists at cost 0. It was proven live on 2026-10-16 with `OPENCODE_AUTH_JSON` set to `{}`.
  `init` sets no Anthropic or Claude secret, so no scenario can spend on a paid model.
- Free-model hunters can fail. When they do, the run posts `PRH-HUNTERS-FAILED`, and
  the expectations of that run that fail are printed as
  `FAIL (free-model hunters failed: re-run)`. The exit code stays 1. Re-run the
  scenario. Only that label marks a flake; a plain `FAIL` is a finding until a re-run
  shows otherwise. The hunters-failed tolerance and this label need an action ref at or after T2c (`98569d1`), where the publisher renders `PRH-HUNTERS-FAILED`; on an older ref an all-hunters-failed run shows `review did not finish` with no PRH code, and S7 reports it.

## Scenarios

Each phase acts on the scenario PR, waits for the run that action starts, and checks
one observation of the PR. S7 invariants are checked on every observation.

| Scenario | What it proves | Expectations | Cost |
|---|---|---|---|
| `no-credential` | With no model credential input, the action stops before any model. | Outcome comment `PRH-CRED-MISSING`; status `error` with that code; no report on the head. | $0 |
| `bad-routing` | A malformed routing input is refused before any model runs. | Outcome comment `PRH-ROUTING-INVALID`; status `error` with that code; no report on the head. | $0 |
| `review-free` | The normal workflow on the free route reviews the planted bug end to end. | Path `reviewed`; the run's review step succeeded; status `success`; at least one report on the head; no outcome comment. | $0 (free route) |
| `cleanup` | An outcome comment from a failed run is removed once a later run on the same branch completes its review. | Phase 1 (`no-credential`): outcome `PRH-CRED-MISSING`. Phase 2 (push, normal): path `reviewed`; the run's review step succeeded; status `success`; a report; no outcome comment. | $0 (phase 2 on the free route) |
| `comment-trigger` | `/pr-hero review` starts an `issue_comment` run that completes the review, and cleans up after a failed first run. | Phase 1 (normal): path `reviewed` or `hunters-failed`; this is a precondition, not the subject. Phase 2 (`/pr-hero review`): the comment run completed; its review step succeeded; the run left its own artifact (`pr-hero-run-<pr>-<sha>`); path `reviewed`. Only the run's own review passes: a skip is a failure, because a forced run bypasses admission and budget. Status and report are not asserted here, since phase 1 left them on the same head. If phase 1 posted an outcome comment, phase 2 also expects none left; otherwise that check is printed as `not asserted`. | $0 (free route) |

The S7 invariants, checked on every observation, are: an `error` status without a `PRH-`
code; an outcome comment on a head whose status is `success`; a status still `pending`
after its run completed.

## Rails

The runner can reach one repository, and nothing else.

- The target is hardcoded to `juanmaagd/pr-hero-sandbox`. Every `gh` and `git` call goes
  through an allowlist (`scripts/sandbox/rails.ts`). A verb that is not listed is refused.
- `gh` may view, create or clone only the sandbox repo, manage its secret and variable,
  list, create, view, close and comment on its PRs, and list and view its runs. `gh api`
  is GET under the sandbox, plus one DELETE of a `sandbox/` branch ref. Field flags are
  refused.
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

## Adding a scenario

1. Add the data in `scripts/sandbox/scenarios.ts`: phases, each with an action (`open`,
   `push`, or `comment`), a `wait`, and its `checks`. Use `afterPriorOutcome` for a check
   that only applies when the phase before posted an outcome comment.
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

SB3 is not built yet: a `cancel` probe (what the `pr-hero` status shows when a run is
cancelled, which answers the #162 question), `stale-tmp`, and `rerun-after-push`. The
`timeout` scenario waits for the cancel probe's answer.
