---
name: pr-hero-triage
description: "Triage pr-hero findings posted as PR comments — for each one, reply in its own thread with applied, dismissed, deferred, or misclassified plus reasoning. Trigger: pr-hero finding comments on a PR you authored, responding to automated code review, `<!-- pr-hero-finding` markers in a PR."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "1.3"
---

## When to Use

Load this skill after pr-hero has posted findings on a PR you (the coding agent) authored, and
you need to answer each one so the review loop closes without a human in it by default.

Use it when you see comments whose FIRST line matches:

```
<!-- pr-hero-finding path=<url-encoded-path> line=<n> head=<40-hex-sha> c=<12-hex> -->
```

Do not use it for ordinary human review comments, or for pr-hero's own summary comment
(`<!-- pr-hero-report head=<sha> -->`). That comment is a status roll-up plus, since W2
(issues #16/#17), a `### Comments Outside Diff` bucket for findings GitHub would not
anchor. Those bucket findings have **no** `<!-- pr-hero-finding` marker and **no**
review thread. Do not reply on the summary. Do not invent a `gh` comment for them.
This skill only answers findings that already have their own `<!-- pr-hero-finding`
comment — almost always an inline review comment on Files changed.

## The strategic why

The bottleneck of coding with AI is the review. If an agent writes the code and only a human can
answer a review, the human is the queue. This skill exists so the default actor answering a
finding is an agent — **the human is the objector, never the gate**: free to weigh in with a
reaction or a reply whenever they have context or an opinion, never required for the loop to
close. That only works if the agent actually judges. Closing the loop means answering with a
tag, not applying the review as a todo list.

## You own the judgment

Every pr-hero comment is a **claim to verify**, not an order. An advisory report never blocks anything. A CI
report in gate mode can turn the `pr-hero` status red on blocking findings. Your reply is argument and evidence,
and it does not clear that status on its own: a fix pushed to the head and reviewed again does. You — the
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

## The loop, end to end

For EVERY `<!-- pr-hero-finding ` comment on this PR that has not already been triaged for the
current head:

1. **Read the finding.** Fetch the comment body (the marker plus pr-hero's claim/severity/tier
   text) and its GitHub comment id. New posts put that marker on an **inline review
   comment**. A leftover top-level issue comment with the same marker may still exist on
   an old PR (pre-W2); the driver still binds those by marker. A finding that appears
   only under `Comments Outside Diff` in the summary is not in this list — skip it.
2. **Read the marker's `head=`.** This IS the budget unit — see "One adjudication per finding per
   HEAD" below. If a triage reply already exists in this thread carrying the SAME head, skip it:
   it is already answered for this code.
3. **Judge the finding against the repository, then pick exactly one tag**: `applied`,
   `dismissed`, `deferred`, or `misclassified` (table below). The comment is a claim, not a
   task. You may reject it.
4. **For `dismissed`, `deferred`, and `misclassified`**: spawn the isolated adjudicator (see
   "The adjudicator spawn" below) and include its verdict in your reply. `applied` never spawns
   one.
5. **Reply through the driver**, not with `gh`. Write reasoning prose to a
   file and run:

   ```bash
   pr-hero triage reply --pr <n> --from <run-dir> --finding F00N \
     --tag <tag> --body-file <reasoning.md> [--verdict <v>] [--issue <n>]
   ```

   The driver resolves the parent from the posted `<!-- pr-hero-finding`
   marker (never a comment id, never the nearest line), prepends the triage
   marker and the visible badge, posts the reply, records the triage event
   transactionally in the canonical product store (`finding_triage` table in
   `~/.prhero/prhero.db`), and — when the parent is an inline review
   comment — resolves that review thread. If the driver says no posted marker
   matches this `F00N`, the finding lives in the summary bucket (or was
   never posted): stop. Do not fall back to `gh`. `applied` takes no
   `--verdict`. `dismissed` / `deferred` / `misclassified` require
   `--verdict` from the adjudicator. `--issue` is optional and only valid
   with `--tag deferred`.

   *(Note: The MCP server is strictly read-only for querying runs, findings, and
   past triage records via `prhero_get_triage` and `prhero_get_findings`. All
   mutations — posting comments, resolving threads, and updating the database —
   must be performed via `pr-hero triage reply`.)*

   **Greptile re-review:** Greptile updates its existing PR comment in place —
   it does not post a second one. Do not wait for a new Greptile comment to
   appear; poll for a body change on the existing one, or re-run
   `compare-pr.ts` when you need an updated head-to-head.

## The four tags

| tag | what it claims | what it must supply |
|---|---|---|
| `applied` | Fixed in this PR. | Nothing else — the re-review verifies it independently, so it pays no adjudicator. |
| `dismissed` | The finding is wrong. | POSITIVE DISPROOF WITH CITED CODE. "I did it on purpose" is not evidence; "this line already covers it, here" is. |
| `deferred` | The finding is right, but fixing it is out of this PR's scope. | Reasoning that says why, and what you are doing instead. A GitHub issue number is optional (`--issue`) — do not invent a tracking issue just to satisfy the tag. |
| `misclassified` | The finding is real, but pr-hero typed it wrong (severity, tier, or `causal_disposition`). | Name which field is wrong and why. This is the highest-value signal the loop produces — it points at a hunter/refuter defect, not a repository one. |

Pick exactly one. There is no preferred tag. If you are tempted to pick two, the finding is
`misclassified` (the label is wrong) rather than `dismissed` (the claim is wrong) — do not
split the difference.

### `applied`

Only after you independently confirmed the defect in the repository and fixed it in this PR.
Then reply. Do not restate the diff; a one-line pointer (commit sha or file) is enough. No
adjudicator. If you have not confirmed it, this is the wrong tag.

### `dismissed`

You are claiming pr-hero is wrong. Cite the exact line(s) that already handle the case, or the
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

- the finding (claim, path, line, severity/tier as pr-hero posted it),
- your argument (the case you are about to reply with), and
- read-only access to the repository at this PR's head.

**It must NEVER receive your own reasoning context** — not your conversation history, not your
scratch notes, not "why I believe this". Its entire value is having nothing to defend. An
adjudicator that inherited your context would simply agree with itself.

The adjudicator returns exactly one of `upheld`, `rejected`, or `inconclusive` — see
`adjudicator.md` for what each means and the burden-of-proof rule behind them. Pass that
exact word as `--verdict` on `pr-hero triage reply` (and mention it in the reasoning
prose). The driver writes it on the marker; the ledger and the escalation rule read it
back from there.

## One adjudication per finding per HEAD

This needs no new state. The finding's own marker already carries `head=<sha>`, so the bound is
read directly off the posted comments — do not invent a separate tracking file or counter.

- Same head, already triaged → skip. Nothing changed, nothing to re-judge.
- Head changed AND the new commits touched this finding's lines → re-triage is legitimate; this is
  the one case that pays for another adjudicator run.
- Head changed but did NOT touch those lines → the prior verdict stands; do not re-triage.

## The escalation stop

After **2 consecutive heads** land at `inconclusive` for the same finding, STOP triaging it and
say so in the reply: it escalates to a human. Do not spawn a third adjudicator round hoping for a
different answer — if two different heads with real code changes between them did not settle it,
a third will not, and by then the thread carries enough material for a person to rule in a minute.

**The count is read off the finding's PRIOR triage markers, not remembered or estimated.** Fetch
this finding's own reply thread, parse every `<!-- pr-hero-triage ` marker already posted in it in
order, and read their `verdict=` fields — the same field this round's reply will also carry. If
the most recent one is `verdict=inconclusive` AND the one before it is also `verdict=inconclusive`
(two markers, both `inconclusive`, both belonging to a head change that legitimately re-triaged —
see "One adjudication per finding per HEAD" above), this round is the escalation, not a third
adjudicator spawn. This is what makes the rule checkable: the markers ARE the state, there is
nothing else to consult.

## What you write vs what the driver posts

`--body-file` is **reasoning prose only**. Do not put a `<!-- pr-hero-triage` marker or a
badge line in that file — the driver prepends both, picks the parent comment from the posted
`<!-- pr-hero-finding` marker, records the decision to the canonical store (`finding_triage`
table), and resolves the inline review thread when there is one.
Passing a GitHub comment id, or posting with `gh api … in_reply_to`, is how replies landed
under Greptile on Musive #1724. Do not do that. Do not reply on
`<!-- pr-hero-report -->` either: that is the summary, including Outside Diff.

`--from` is the pr-hero run directory that produced these findings (`findings.json`). `--finding`
is the finding id (`F001`, …) from that file — never a comment id.

**When the review ran in CI, that directory is not on your machine.** A GitHub Actions review
writes it to `~/.prhero/repos/<host>/<owner>/<repo>/runs/pr-<n>-<sha>-1` on an ephemeral runner
that is destroyed when the job ends. The workflow uploads it as an artifact; download it before
you triage:

```bash
gh run list --workflow "pr-hero Review" --branch <head-branch> --limit 5
gh run download <run-id> -n pr-hero-run-<pr>-<head-sha> -D pr-hero-run
```

Then pass `--from pr-hero-run`. `gh run download` unpacks the run directory's *contents*, so the
`--from` target is the directory you downloaded into — not a `pr-<n>-<sha>-1` path inside it. If
the artifact is missing (a size- or budget-gated review writes no run directory, and so does a
run where every hunter died), you have no `--from` input: say so and stop rather than inventing
one. Full detail: `docs/github-actions.md` → "Triaging a CI review".

The posted body looks like this (driver-owned; shown so you know what a human will see):

### `applied`

```
<!-- pr-hero-triage tag=applied head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent -->

✅ **APPLIED** · agent

Fixed in this PR — see 3f9a2c1: `parseConfig` now validates `retries` before use.
```

`--body-file` for that reply is only the last paragraph.

### `dismissed` (needs `--verdict`)

```
<!-- pr-hero-triage tag=dismissed head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent verdict=upheld -->

❌ **DISMISSED** · agent · adjudicator: upheld

The finding claims `parseConfig` can throw when `raw.retries` is undefined. It cannot:
`config.ts:42` already guards it — `const retries = raw.retries ?? 3;` — and that line predates
this PR. The isolated adjudicator confirmed the citation independently and returned `upheld`.
```

### `deferred` (needs `--verdict`; `--issue` optional)

```
<!-- pr-hero-triage tag=deferred head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent verdict=upheld -->

📋 **DEFERRED** · agent · adjudicator: upheld

The finding is correct — `retryQueue.ts` has no backoff cap — but fixing it means redesigning the
retry policy, which is out of scope for this PR.
```

### `misclassified` (needs `--verdict`)

```
<!-- pr-hero-triage tag=misclassified head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent verdict=upheld -->

🏷️ **MISCLASSIFIED** · agent · adjudicator: upheld

The defect is real, but `causal_disposition` is wrong: this is filed `introduced` and it is
pre-existing — `ghPrList` (watch.ts:243) has carried this exact unbounded `gh` hang since before
this PR. The engine typed it wrong, not the code.
```

## Rules

- You own the judgment. A pr-hero finding is a claim to verify, never an order. `applied` is
  not the default tag.
- One tag per finding, no exceptions.
- `dismissed`, `deferred`, `misclassified` all require a spawned, isolated adjudicator; `applied`
  never does.
- The adjudicator never sees your reasoning context — only the finding, your argument, and the
  repo.
- Never call `gh` to post or resolve a triage reply. Run `pr-hero triage reply`.
  If that command posted the reply and then failed to resolve, re-run the
  **same** command — same-head skip retries resolve only. Do not `gh`.
- Never triage a finding that only exists under `### Comments Outside Diff` in the
  summary. It has no thread this slice (W2). If `pr-hero triage reply` reports no
  matching marker, stop.
- `dismissed`, `deferred`, and `misclassified` without `--verdict` are malformed. `applied` WITH
  `--verdict` is equally malformed.
- Never re-triage a finding whose head is unchanged since its last triage on this PR (the driver
  skips a same-head re-post).
- After 2 consecutive `inconclusive` heads — read off the finding's own prior triage markers, not
  memory — stop and hand the finding to a human.
