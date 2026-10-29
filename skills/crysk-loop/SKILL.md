---
name: crysk-loop
description: "Run the autonomous Crysk PR review loop end-to-end (review -> judge -> fix/reply -> wait -> recheck until done): triage Crysk findings posted as PR comments in their own thread with applied, dismissed, deferred, or misclassified plus reasoning, push verified fixes, and subscribe to re-reviews with `crysk status --pr <n> --wait --json` without stopping to ask the user. Trigger: Crysk (formerly pr-hero) finding comments on a PR you authored, crysk-loop, pr-hero-loop, closing the PR review loop, responding to automated code review, `<!-- crysk-finding` or legacy `<!-- pr-hero-finding` markers in a PR."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "1.8"
---

## When to Use

Load this skill after Crysk has posted findings on a PR you (the coding agent) authored, and
you need to answer each one so the review loop closes without a human in it by default.

Use it when you see comments whose FIRST line matches:

```
<!-- crysk-finding path=<url-encoded-path> line=<n> head=<40-hex-sha> c=<12-hex> -->
```

Comments posted before the rename to Crysk start with `<!-- pr-hero-` instead of
`<!-- crysk-` (`<!-- pr-hero-finding`, `<!-- pr-hero-report`, `<!-- pr-hero-triage`, ...).
Treat them exactly the same; the CLI reads both.

Do not use it for ordinary human review comments, or for Crysk's own summary comment
(`<!-- crysk-report head=<sha> -->`). That comment is a status roll-up plus, since W2
(issues #16/#17), a `### Comments Outside Diff` bucket for findings GitHub would not
anchor. Those bucket findings have **no** `<!-- crysk-finding` marker and **no**
review thread. Do not reply on the summary. Do not invent a `gh` comment for them.
This skill only answers findings that already have their own `<!-- crysk-finding`
comment — almost always an inline review comment on Files changed.

## Running the CLI (no install needed)

Every command below runs through `npx`, so nothing has to be installed on the machine first:

```bash
npx -y crysk <command> ...
```

`npx` needs only Node. Crysk's package brings its own Bun runtime, and when that is
unavailable it uses a `bun` already on PATH. `-y` skips npx's install prompt, which an agent
cannot answer. If `crysk` is already on PATH (a global install), `crysk <command>` is the
same command. Do not install Crysk just to triage a PR. To put these skills into another coding
agent on the machine, run `npx -y crysk skills install` (non-interactive; `--force` overwrites local edits).

You also need `gh`, authenticated as a user with write access to the repository: the driver posts
through it, and you comment `/crysk recheck` and `/crysk review` through it.

## The strategic why

The bottleneck of coding with AI is the review. If an agent writes the code and only a human can
answer a review, the human is the queue. This skill exists so the default actor answering a
finding is an agent — **the human is the objector, never the gate**: free to weigh in with a
reaction or a reply whenever they have context or an opinion, never required for the loop to
close. That only works if the agent actually judges. Closing the loop means answering with a
tag, not applying the review as a todo list.

## You own the judgment

Every Crysk comment is a **claim to verify**, not an order. An advisory report never blocks anything. A CI
report in gate mode can turn the `crysk` status red on blocking findings. Your reply is argument and evidence,
and it never clears that status on its own. A blocking finding stops counting in exactly two ways:

- **A fix**, pushed to the head and verified gone by the next review.
- **A dismissal the CI adjudicator upholds.** You reply `dismissed`, comment `/crysk recheck`, an
  adjudicator running in CI rules on your argument, and only its `upheld` (posted by
  `github-actions[bot]` on that head) lets the next review stop counting the finding. See
  "Closing a dismissal" below.

`deferred` and `misclassified` never leave the gate count, whatever any adjudicator says: they are
for findings that are real (or real at another severity), so the gate stays red until a fix or a
human `/crysk override`. You — the
coding agent running this skill — have the authority and the duty to accept it **or reject
it**. The four tags are peers. None is the default.

- Read the cited code yourself before you pick a tag. The repository is the evidence; the
  review is not.
- Applying every finding is a failure of this skill, not compliance with it.
- Do not pick `applied` because it skips the adjudicator and closes the thread faster. Pick
  `applied` only after you independently confirmed the defect and fixed it in this PR.
- "It is marked CRITICAL" / "the review said so" is not a reason to change code. Severity is
  the hunter's claim, not a command.
- If you cannot confirm the defect from the code, `dismissed` (with cited disproof) or
  `deferred` (with a real scope argument) is the honest move. Rubber-stamping a fix you did
  not verify is the failure this section exists to prevent.

## Review judgment: when to stop vs. when to request another pass

You also own the judgment of whether the PR needs **zero more reviews** (stop and merge) or **one more forced review** (when workflow rules suppressed an automatic run on a risky change). Always compare `report.head` against `head` in `crysk status --pr <n> --json` and inspect `git diff <report.head>..<head>`:

### A. Stopping diminishing returns (when to stop reviewing and merge)

Later review passes hunt only the push delta. Once the real defects from pass 1 are fixed, hunters scanning a small fix-up commit can surface increasingly contrived, speculative, or nitpicky claims. **Fixing a contrived finding just to turn the gate green is worse than a wasted edit:** it creates a new push, triggers another review pass on an even smaller delta, and feeds an endless spiral of defensive code and absurd findings.

1. **Never patch code to appease a contrived or over-severitied finding.**
   - If the claimed bug requires an impossible precondition, contradicts an intentional invariant, or is already guarded: tag it `dismissed` with cited code and use `/crysk recheck` so the CI adjudicator clears it **without** a code change or a new push.
   - If the observation is technically true but trivial, stylistic, pre-existing, or inflated to blocking: tag it `misclassified` or `deferred`. Never rewrite working code just to avoid asking for `/crysk override`.
2. **Do not auto-force past `ci_max_attempts` on routine fix-ups.** The repository's `ci_max_attempts` (default `2`) exists specifically to stop diminishing-returns re-reviews. When step 0 returns `next_action: "review"` with reason *"The automatic review budget for this PR is used up"*, inspect `git diff <report.head>..<head>`: if the commits since `report.head` only applied straightforward fixes for already-triaged findings, **stop the loop**. Do not post `/crysk review`. Tell the user the PR has completed its review passes, the fixes are in place, and it is ready for `/crysk override` and merge.
3. **Stop and recommend merge when only diminishing-returns items remain.** On `override-or-fix` (or pass 2+ when every real bug is fixed and the only remaining red-gate items are `deferred`, `misclassified`, or a contrived finding whose dismissal the adjudicator did not uphold), **do not cave in and edit the code**. Exit the loop, list the remaining finding(s) with a one-line explanation of why they are contrived/out-of-scope, and tell the user the PR is ready to `/crysk override` and merge.
4. **Stop automatic reviews BEFORE the push that should not be reviewed.** When you decide no further review pass is needed but you still have fixes to push, post `gh pr comment <n> --body "/crysk stop"` **first**, then `git push`. CI admission reads the stop on that push and skips the review, carrying the last verdict (a red gate stays red: it still needs `/crysk override`). The stop stays in force for every later push until someone comments `/crysk review` or `/crysk recheck`. It counts only from a user with write access, starts no workflow run, and costs $0. Never push first and try to stop the review afterwards: nothing cancels a review that already started.

### B. Requesting or suggesting another review when workflow rules skipped it

The opposite happens when a repository's workflow policy (`once_per_pr`, `thresholded`, `risk_aware` below the score floor, `ci_max_attempts` exhausted, or the size gate) suppresses an automatic review on a push that **genuinely changed load-bearing code**:
- Under `once_per_pr`, `thresholded`, or `risk_aware`, a skipped push can inherit a carried `success` status from `report.head`, so `next_action` reads `"done"` even though `report.head !== head` (the commits `report.head..head` were never reviewed).
- Under `ci_max_attempts` or the size/budget gate, the automatic run is blocked and `report.head !== head`.

Whenever `report.head !== head`, inspect `git diff <report.head>..<head>`:
- If that unreviewed delta introduced **new business logic, state-machine or concurrency changes, auth/security/isolation edits, or a non-trivial refactor** (for example, fixing a finding required redesigning a function rather than adding a guard), an extra review **is** justified:
  - When `next_action` is `"review"` or `"override-or-fix"` (and within the forced-run bound below), trigger `gh pr comment <n> --body "/crysk review"` and subscribe with `npx -y crysk status --pr <n> --wait --json` — or, if `next_action` is `"done"` on a carried green status (or the forced-run bound is reached), explicitly **recommend running `/crysk review`** to the user and name the exact files/changes in `report.head..head` that warrant a fresh pass before merging.

### C. Suspecting a flawed integration or design (stop patching, rethink the root cause)

Reaching zero findings after several rounds of band-aid fixes is a failure if the underlying design was wrong from the start. Contrast this with `### A` (where later rounds only surface contrived nits): here the findings are **real**, and the volume or churn is telling you the approach itself is broken.

Suspect a flawed integration or architecture when **either** of these signals appears. The number of findings alone is not a signal: a first round with many real findings on one new feature is normal polish.

1. **Whack-a-mole loops (fixes spawning new real findings):** By Round 2+, fixing the previous round's findings introduces *new*, legitimate blocking findings in the next review pass, on the same seam — a sign that patches are fighting the architecture rather than closing isolated defects (or a finding returns at higher severity in the summary report).
2. **Broken foundational assumption:** Two or more findings show that the code's mental model of an external API, lifecycle, concurrency guarantee, or module ownership does not hold (for example, the code infers from outside a system what that system already knows).

**Action when triggered:**
- **Halt the incremental fix-and-push loop before replying or patching.** Do **not** post `applied` replies for fixes that will not be pushed, and do not stack another round of tactical band-aids just to force the gate green. If unpushed local fix attempts exist, do not push them.
- If `/crysk stop` was posted to pause automatic reviews while refactoring, remember that `/crysk stop` is persistent. Once the clean redesign is implemented and pushed, comment `/crysk review` on the PR to lift the stop and ensure CI reviews the new architecture.
- Step back, identify the single root architectural or integration decision that caused the cluster of findings, and stop to report the diagnosis to the user (with the concrete alternative design or clean refactor plan) before continuing.

## Which command spelling to post

This skill names the commands as `/crysk review`, `/crysk recheck` and `/crysk override`. A
workflow set up before the rename to Crysk listens only for `/pr-hero review`, `/pr-hero recheck`
and `/pr-hero override`, and ignores `/crysk` comments. Comment triggers run the workflow on the
default branch, so check that file once per PR before posting any command. The workflow file is
`crysk.yml`, or `pr-hero.yml` in a repository set up before the rename (never both), so try either:

```bash
for f in crysk.yml pr-hero.yml; do
  gh api "repos/{owner}/{repo}/contents/.github/workflows/$f" --jq .content 2>/dev/null | base64 -d | grep -q "'/crysk review'" && exit 0
done; exit 1
```

Exit 0 means the workflow accepts `/crysk`: post the `/crysk` form. Otherwise post the same
command with `/pr-hero` in place of `/crysk`. If the workflow lives under another file name,
read that file instead.

## The loop, end to end

**Run this as a continuous autonomous loop (`while next_action !== "done"`).** Never end your turn or stop to ask the human for permission between `triage`, fixing code, `git push`, `recheck`, `review`, and waiting for CI to finish. Stop only when `next_action === "done"` or one of the hard escalation stops below triggers (repeated gate/runner failure, 6 forced runs on one head, 2 consecutive `inconclusive` heads, a suspected flawed design (### C), or `override-or-fix` with nothing left you can fix).

0. **Subscribe to and read the PR's settled state.** Run:

   ```bash
   npx -y crysk status --pr <n> --wait --json
   ```

   It is read-only (reads GitHub through `gh`, writes nothing) and **deterministic**:
   - When the head is already settled, it returns immediately on the first poll without sleeping.
   - When a review is in flight (`next_action === "wait"`) **or** booting in the 3-minute startup grace window right after a `git push`, `/crysk review`, or `/crysk recheck`, `--wait` polls every 15s until the review finishes and emits the settled JSON in one call. Never invent your own `sleep` loop.

   Act on its `next_action` and immediately loop back to step 0 until `done`:
   - `wait`: if `--wait` was omitted, re-run with `--wait` and let it block until the review finishes.
   - `review`: no review has run on this head, the last one did not finish, the CI adjudicator
     upheld every dismissal and the next review will stop counting them, or the automatic review
     budget for this PR is used up (or the review policy is manual-only). **Exception — budget used up on a routine fix-up:** when the reason is that the automatic review budget is used up and the latest push only fixed already-triaged findings (see "Stopping diminishing returns" above), do **not** force another review; stop the loop and report that the PR is ready for `/crysk override` and merge. Otherwise check the forced-run bound
     below, comment `gh pr comment <n> --body "/crysk review"`, and immediately run step 0 with `--wait`.
   - `triage`: a live blocking finding on this head has no triage reply at the head it was posted
     on, or the gate is green and a finding posted on this head has no reply yet (advisory findings
     need one too). Run the triage batch below (steps 1–6), which judges every finding, applies real fixes in the tree, posts all replies, and either pushes the fixes or triggers `recheck` before looping back to step 0 with `--wait`.
   - `fix`: a blocking finding is tagged `applied`, or a blocking finding has no comment thread
     (`comment_id` is null: a summary-only row, or one never posted inline). Commit and `git push` the fix, then immediately run step 0 with `--wait` so the next review verifies it. A thread-less finding cannot be answered with `triage reply`, so fix it or ask a maintainer for `/crysk override`.
   - `recheck`: blocking findings are answered `dismissed` (with no pending code fixes to push) and the CI adjudicator has not ruled on
     them on this head (or ruled `inconclusive`). Comment `gh pr comment <n> --body "/crysk recheck"`, then immediately run step 0 with `--wait` and follow "Closing a dismissal" below.
   - `override-or-fix`: the gate is red and nothing is left for `triage` or `recheck`. Read the
     `reason` and act on the case it names; never override it yourself:
     - the head was size- or budget-skipped (the gate description starts "crysk skipped the
       review", or "pr-hero skipped the review" on a status an older action wrote): comment `/crysk review`, then run step 0 with `--wait`;
     - the review is "partial again" with the same hunters failing: fix the failing hunter's route
       (model or credential), or ask a maintainer to override;
     - every blocking finding is already answered but none can clear without a fix (a dismissal the
       CI adjudicator rejected, a `deferred` / `misclassified` tag, or a `dismissed` finding with no
       review thread, which no adjudicator can rule on): if the adjudicator's rejection exposed a real defect you missed, fix, commit, and `git push` (then step 0 `--wait`); if the finding is `deferred`, `misclassified`, or still contrived/absurd ("Stopping diminishing returns" above), **do not edit code to appease it** — exit the loop and tell the maintainer the PR is ready for `/crysk override` and merge;
     - the red gate names no live blocking finding on this head (the `reason` quotes the gate
       description): read that description and act on what it says; when it names nothing you can
       fix, ask a maintainer.
   - `done`: nothing is owed on this head. The gate passed (or an override unlocked it) and every
     finding posted on this head has a reply. Before exiting, check whether `report.head && report.head !== head` (a green status carried over an unreviewed push under `once_per_pr`, `thresholded`, or `risk_aware`): if `git diff <report.head>..<head>` contains non-trivial logic or risky changes ("Requesting or suggesting another review" above), recommend `/crysk review` naming those changes; otherwise exit the loop and report that the PR is ready to merge.

   **Bound the forced runs.** `/crysk review` and `/crysk recheck` each run a full paid review
   that bypasses the size, budget and admission gates (`ci_max_attempts` included), and a gate
   `error` (expired token, missing credential, crash) makes step 0 say `review` again forever.
   Before posting either, count the ones already on this head, never from memory: the comments in
   `gh pr view <n> --json comments` whose body is exactly `/crysk review`, `/crysk recheck`,
   or their legacy spellings `/pr-hero review` and `/pr-hero recheck` (both still start a run), and whose `createdAt` is at or after the oldest `crysk` or `pr-hero` status on the head
   (`gh api "repos/{owner}/{repo}/commits/<head>/statuses?per_page=100" --jq '[.[] | select(.context == "crysk" or .context == "pr-hero")] | last.created_at'`;
   no status yet means none counted). Each reason step 0 gives gets its command once per head:
   one `/crysk review` each for a skipped head, a partial review, a used-up budget, a gate
   `error`, and an `upheld` dismissal; one `/crysk recheck` per pending dismissal, plus one retry
   when that run leaves no ruling or an `inconclusive` one. When the same reason comes back after
   its command already ran (a second `error` with the same description, a second partial, a second
   recheck with no ruling or `inconclusive` again), stop and hand it to a human. The hard ceiling
   is six per head; reaching it goes to a human too.

   `findings[]` lists each posted finding with its `id`, `path`, `line`, `head`, `live_on_head`, and
   its newest `triage` (`null` when none), and `ci_verdict`. `comment_id` can be null: a live row of
   the summary's state block that no comment carries (summary-only, or never posted inline). Its
   `head` is null too, and it has no thread to reply in: the CI adjudicator's ruling on that newest
   reply on this head (`upheld`, `rejected`, `inconclusive`, or `null`). `triage` is only the newest reply, so a finding can be
   answered at its own head and then re-answered at a later head. The thread (step 2 below) settles
   the per-head question, and the escalation count still reads the thread's prior markers.

For EVERY `<!-- crysk-finding ` comment on this PR that has not already been triaged for the
current head:

1. **Read the finding.** Fetch the comment body (the marker plus Crysk's claim/severity/tier
   text) and its GitHub comment id. New posts put that marker on an **inline review
   comment**. A leftover top-level issue comment with the same marker may still exist on
   an old PR (pre-W2); the driver still binds those by marker. A finding that appears
   only under `Comments Outside Diff` in the summary is not in this list — skip it.
2. **Read the marker's `head=`.** This IS the budget unit — see "One adjudication per finding per
   HEAD" below. If a triage reply already exists in this thread carrying the SAME head, skip it:
   it is already answered for this code.
3. **Judge the finding against the repository, then pick exactly one tag**: `applied`,
   `dismissed`, `deferred`, or `misclassified` (table below). The comment is a claim, not a
   task. You may reject it. Before touching code, replying, or applying fixes, evaluate whether the cluster of findings indicates a flawed integration or broken design (### C) rather than isolated defects — if so, halt the loop and report the diagnosis without posting replies or patching. When you confirm the defect is real, isolated, and in scope (`applied`), make the fix in the working tree now (and run the relevant tests), before posting the `applied` reply; **do not `git push` until you have replied to every finding on this head** (step 6).
4. **For `dismissed`, `deferred`, and `misclassified`**: spawn the isolated adjudicator (see
   "The adjudicator spawn" below) and include its verdict in your reply. `applied` never spawns
   one.
5. **Reply through the driver**, not with `gh`. Write reasoning prose to a
   file and run:

   ```bash
   npx -y crysk triage reply --pr <n> --from <run-dir> --finding F00N \
     --tag <tag> --body-file <reasoning.md> [--verdict <v>] [--issue <n>]
   ```

   The driver resolves the parent from the posted `<!-- crysk-finding`
   marker (never a comment id, never the nearest line), prepends the triage
   marker and the visible badge, posts the reply, records the triage event
   transactionally in the canonical product store (`finding_triage` table in
   `~/.crysk/prhero.db`), and — when the parent is an inline review
   comment — resolves that review thread. If the driver says no posted marker
   matches this `F00N`, the finding lives in the summary bucket (or was
   never posted): stop. Do not fall back to `gh`. `applied` takes no
   `--verdict`. `dismissed` / `deferred` / `misclassified` require
   `--verdict` from the adjudicator. `--issue` is optional and only valid
   with `--tag deferred`.
6. **Advance the loop in one batch once all findings on this head are answered:**
   - **If you made clean code fixes (`applied` or unthreaded blocking fixes):** if you decided this push needs no further review ("Stopping diminishing returns", rule 4), post `/crysk stop` before pushing, and after the push do **not** wait for a re-review: none will run. Report that the fixes are pushed and the PR is ready for `/crysk override` and merge (a carried green gate needs no override). Otherwise, commit and `git push` all fixes in a single push, then immediately run `npx -y crysk status --pr <n> --wait --json` to subscribe to the re-review on the new head. Do **not** run `/crysk recheck` before pushing: a new push invalidates prior-head recheck rulings and wastes a CI run.
   - **If no code changes were needed:** run `npx -y crysk status --pr <n> --wait --json` and execute its `next_action` (`recheck` when blocking findings were `dismissed`, or `done` when the gate is already green).

   *(Note: The MCP server is strictly read-only for querying runs, findings, and
   past triage records via `crysk_get_triage` and `crysk_get_findings`. All
   mutations — posting comments, resolving threads, and updating the database —
   must be performed via `npx -y crysk triage reply`.)*

   **Greptile re-review:** Greptile updates its existing PR comment in place —
   it does not post a second one. Do not wait for a new Greptile comment to
   appear; poll for a body change on the existing one.

## Closing a dismissal: `/crysk recheck`

Your local adjudicator (step 4) is a check on yourself before you post: its verdict goes in your
reply's marker, and the gate ignores it, because you ran it. The gate trusts only the CI
adjudicator. When step 0 says `recheck`:

1. Comment `gh pr comment <n> --body "/crysk recheck"`. It runs a review of the head and, for each
   blocking finding whose newest reply is `dismissed` (at most 5 per run), an adjudicator in CI that
   reads your argument and the repository at that head. You may comment it yourself: you only supply
   the argument, the CI adjudicator rules. (`/crysk override` is the opposite: never yours to post.)
2. Wait with `npx -y crysk status --pr <n> --wait --json` until the run settles. Each ruling is a reply on the finding's thread,
   from `github-actions[bot]`, whose first line is
   `<!-- crysk-adjudication verdict=<v> reply=<your reply's id> head=<sha> -->`. Step 0's
   `ci_verdict` reads it for you.
3. Act on the verdict:
   - `upheld`: the dismissal stands. The recheck run itself does not change its own count; step 0
     now says `review`. Comment `/crysk review`, then run `npx -y crysk status --pr <n> --wait --json`, and that review no longer counts the finding.
   - `rejected`: the finding stands. Re-read the adjudicator's evidence. Fix it, or, if you still hold
     it is wrong, ask a human (they may override). Do not re-post the same argument.
   - `inconclusive`: the repository did not settle it either way. On the same head you cannot post
     a stronger argument: the driver skips any second triage reply at a head that already has one
     (`skip post: … already triaged at this head`), and the next recheck re-adjudicates your
     original reply. Recheck once more; a second `inconclusive` on this head goes to a human. A
     stronger argument needs a new head: after a push, reply `dismissed` again with the new
     evidence, then recheck.
   - No ruling at all after the run: the adjudicator step failed. Nothing was posted and the
     dismissal is still pending; recheck once more. A second recheck with no ruling goes to a
     human (see "Bound the forced runs" in step 0).
4. A ruling counts only on the head it was given. After any push, step 0 asks for a recheck again.

Only an inline finding can be rechecked: the CI adjudicator answers on the finding's own review
thread. A legacy top-level finding (no review thread) cannot be cleared by a dismissal; step 0 says
`override-or-fix` for it.

## The four tags

| tag | what it claims | what it must supply |
|---|---|---|
| `applied` | Fixed in this PR. | Nothing else — the re-review verifies it independently, so it pays no adjudicator. |
| `dismissed` | The finding is wrong. | POSITIVE DISPROOF WITH CITED CODE. "I did it on purpose" is not evidence; "this line already covers it, here" is. |
| `deferred` | The finding is right, but fixing it is out of this PR's scope. | Reasoning that says why, and what you are doing instead. A GitHub issue number is optional (`--issue`) — do not invent a tracking issue just to satisfy the tag. |
| `misclassified` | The finding is real, but Crysk typed it wrong (severity, tier, or `causal_disposition`). | Name which field is wrong and why. This is the highest-value signal the loop produces — it points at a hunter/refuter defect, not a repository one. |

Pick exactly one. There is no preferred tag. If you are tempted to pick two, the finding is
`misclassified` (the label is wrong) rather than `dismissed` (the claim is wrong) — do not
split the difference.

### `applied`

Only after you independently confirmed the defect in the repository and fixed it in this PR.
Then reply. Do not restate the diff; a one-line pointer (commit sha or file) is enough. No
adjudicator. If you have not confirmed it, this is the wrong tag.

### `dismissed`

You are claiming Crysk is wrong. Cite the exact line(s) that already handle the case, or the
exact reason the claimed defect cannot occur. Then spawn the adjudicator — its burden of proof
rule is the same one you must meet, and it is the disinterested check on your own claim.

### `deferred`

Reply with why this is out of scope and what you are doing instead. If you
already have a tracking issue, pass `--issue <n>`; if you do not, omit it.
Do not create a GitHub issue just to fill the marker — some agents run on
providers that are not GitHub, and the coding agent decides whether an issue
belongs anywhere.

### `misclassified`

Name the exact field (`severity`, `tier`, or `causal_disposition`) and what it should be instead,
with the evidence. The finding itself is not wrong — only its classification is.

## The adjudicator spawn — isolation is load-bearing

For `dismissed`, `deferred`, and `misclassified`, spawn a FRESH, ISOLATED sub-agent using the
system prompt in `adjudicator.md` (same directory as this file).

**The isolation requirement, stated plainly: the adjudicator receives ONLY**

- the finding (claim, path, line, severity/tier as Crysk posted it),
- your argument (the case you are about to reply with), and
- read-only access to the repository at this PR's head.

**It must NEVER receive your own reasoning context** — not your conversation history, not your
scratch notes, not "why I believe this". Its entire value is having nothing to defend. An
adjudicator that inherited your context would simply agree with itself.

The adjudicator returns exactly one of `upheld`, `rejected`, or `inconclusive` — see
`adjudicator.md` for what each means and the burden-of-proof rule behind them. Pass that
exact word as `--verdict` on `npx -y crysk triage reply` (and mention it in the reasoning
prose). The driver writes it on the marker; the escalation rule reads it back from there.

## One adjudication per finding per HEAD

This needs no new state. The finding's own marker already carries `head=<sha>`, so the bound is
read directly off the posted comments — do not invent a separate tracking file or counter.

- Same head, already triaged → skip. Nothing changed, nothing to re-judge.
- Head changed AND the new commits touched this finding's lines → re-triage is legitimate; this is
  the one case that pays for another adjudicator run.
- Head changed but did NOT touch those lines → the prior verdict stands; do not re-triage.

## The escalation stops

Escalate to a human and stop the loop only when one of these hard triggers fires:
- **Flawed integration or design (### C):** Whack-a-mole findings on the same seam across review rounds, or broken foundational assumptions. Stop patching, do not push tactical band-aids, and report the architectural diagnosis and refactor plan to the human. If a `/crysk stop` was posted to pause reviews during refactoring, comment `/crysk review` once the clean redesign lands to lift the stop; otherwise let CI review the pushed redesign normally.
- **Inconclusive adjudication after 2 consecutive heads:** After **2 consecutive heads** land at `inconclusive` for the same finding, STOP triaging it and
say so in the reply: it escalates to a human. Do not spawn a third adjudicator round hoping for a
different answer — if two different heads with real code changes between them did not settle it,
a third will not, and by then the thread carries enough material for a person to rule in a minute.

**The count is read off the finding's PRIOR triage markers, not remembered or estimated.** Fetch
this finding's own reply thread, parse every `<!-- crysk-triage ` marker already posted in it in
order, and read their `verdict=` fields — the same field this round's reply will also carry. If
the most recent one is `verdict=inconclusive` AND the one before it is also `verdict=inconclusive`
(two markers, both `inconclusive`, both belonging to a head change that legitimately re-triaged —
see "One adjudication per finding per HEAD" above), this round is the escalation, not a third
adjudicator spawn. This is what makes the rule checkable: the markers ARE the state, there is
nothing else to consult.

## What you write vs what the driver posts

`--body-file` is **reasoning prose only**. Do not put a `<!-- crysk-triage` marker or a
badge line in that file — the driver prepends both, picks the parent comment from the posted
`<!-- crysk-finding` marker, records the decision to the canonical store (`finding_triage`
table), and resolves the inline review thread when there is one.
Passing a GitHub comment id, or posting with `gh api … in_reply_to`, is how replies landed
under Greptile on Musive #1724. Do not do that. Do not reply on
`<!-- crysk-report -->` either: that is the summary, including Outside Diff.

`--from` is the Crysk run directory that produced these findings (`findings.json`). `--finding`
is the finding id (`F001`, …) from that file — never a comment id.

**When the review ran in CI, that directory is not on your machine.** A GitHub Actions review
writes it to `~/.crysk/repos/<host>/<owner>/<repo>/runs/pr-<n>-<sha>-1` on an ephemeral runner
that is destroyed when the job ends. The workflow uploads it as an artifact; download it before
you triage:

```bash
# The artifact is crysk-run-<pr>-<head-sha>; a run of an action release from before the rename
# uploaded pr-hero-run-<pr>-<head-sha>. Try the new name first, then the old one.
# Each line printed is "<run-id> <artifact-name>": download with the name on the same line.
for NAME in crysk-run-<pr>-<head-sha> pr-hero-run-<pr>-<head-sha>; do
  gh api "repos/{owner}/{repo}/actions/artifacts?name=$NAME" \
    --jq '[.artifacts[] | select(.expired | not)] | sort_by(.created_at) | reverse | .[] | "\(.workflow_run.id) \(.name)"'
done
gh run download <run-id> -n <artifact-name> -D "crysk-run-<run-id>"
```

Look the run up by artifact name, not with `gh run list --branch`: a `/crysk review` or
`/crysk recheck` run is an `issue_comment` event, which GitHub files under the default branch, so
a branch listing never shows it, and that run usually holds the findings. Several runs can upload
the same name for one head (the automatic review, then a forced review or recheck; `overwrite: true`
in `action.yml` only dedupes within one run). Try the candidates newest first and keep the first one
`npx -y crysk triage reply ... --dry-run` binds (its success line starts with `plan: reply to`; do not match on "marker match", which the "no posted … marker matches" error also contains). Download each candidate
into its own fresh directory, as above: reusing one directory mixes `findings.json` from one run
with the patches of another, and the bind then judges files no single run wrote.

Then pass `--from crysk-run-<run-id>` for the candidate that bound. `gh run download` unpacks the run directory's *contents*, so the
`--from` target is the directory you downloaded into — not a `pr-<n>-<sha>-1` path inside it. If
the artifact is missing (a size- or budget-gated review writes no run directory, and so does a
run where every hunter died), you have no `--from` input: say so and stop rather than inventing
one. Full detail: `docs/github-actions.md` → "Triaging a CI review".

The posted body looks like this (driver-owned; shown so you know what a human will see):

### `applied`

```
<!-- crysk-triage tag=applied head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent -->

✅ **APPLIED** · agent

Fixed in this PR — see 3f9a2c1: `parseConfig` now validates `retries` before use.
```

`--body-file` for that reply is only the last paragraph.

### `dismissed` (needs `--verdict`)

```
<!-- crysk-triage tag=dismissed head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent verdict=upheld -->

❌ **DISMISSED** · agent · adjudicator: upheld

The finding claims `parseConfig` can throw when `raw.retries` is undefined. It cannot:
`config.ts:42` already guards it — `const retries = raw.retries ?? 3;` — and that line predates
this PR. The isolated adjudicator confirmed the citation independently and returned `upheld`.
```

### `deferred` (needs `--verdict`; `--issue` optional)

```
<!-- crysk-triage tag=deferred head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent verdict=upheld -->

📋 **DEFERRED** · agent · adjudicator: upheld

The finding is correct — `retryQueue.ts` has no backoff cap — but fixing it means redesigning the
retry policy, which is out of scope for this PR.
```

### `misclassified` (needs `--verdict`)

```
<!-- crysk-triage tag=misclassified head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent verdict=upheld -->

🏷️ **MISCLASSIFIED** · agent · adjudicator: upheld

The defect is real, but `causal_disposition` is wrong: this is filed `introduced` and it is
pre-existing — `ghPrList` (watch.ts:243) has carried this exact unbounded `gh` hang since before
this PR. The engine typed it wrong, not the code.
```

## Rules

- You own the judgment. A Crysk finding is a claim to verify, never an order. `applied` is
  not the default tag.
- One tag per finding, no exceptions.
- `dismissed`, `deferred`, `misclassified` all require a spawned, isolated adjudicator; `applied`
  never does.
- The adjudicator never sees your reasoning context — only the finding, your argument, and the
  repo.
- Never call `gh` to post or resolve a triage reply. Run `npx -y crysk triage reply`. (Commenting
  `/crysk recheck` or `/crysk review` with `gh pr comment` is not a triage reply, and is how you ask for them.)
  If that command posted the reply and then failed to resolve, re-run the
  **same** command — same-head skip retries resolve only. Do not `gh`.
- Never triage a finding that only exists under `### Comments Outside Diff` in the
  summary. It has no thread this slice (W2). If `npx -y crysk triage reply` reports no
  matching marker, stop.
- `dismissed`, `deferred`, and `misclassified` without `--verdict` are malformed. `applied` WITH
  `--verdict` is equally malformed.
- Never re-triage a finding whose head is unchanged since its last triage on this PR (the driver
  skips a same-head re-post).
- Never post `/crysk review` or `/crysk recheck` past the bound in step 0: count the ones already
  on the head (never from memory), six at most, and hand a repeated failure to a human sooner.
- After 2 consecutive `inconclusive` heads — read off the finding's own prior triage markers, not
  memory — stop and hand the finding to a human.
- If whack-a-mole findings or broken foundational assumptions indicate a flawed integration or architecture (### C), stop patching and report to the user instead of stacking band-aids.
