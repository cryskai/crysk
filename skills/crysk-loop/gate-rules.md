# Gate rules: carry, hold, override and when to stop reviewing

Read this for a row marked **ask**, when `report.head` differs from `head`, before `/crysk stop`, or when
the fixes themselves keep producing findings.

## What a skipped push does to the gate

A review rule can skip a push: a low-risk or below-threshold delta, `once_per_pr`, `/crysk stop`, the attempt
budget (`ci_max_attempts`) used up, or `manual_only`. The head then inherits the last reviewed verdict:

- A green stays green.
- A red stays red, unless every blocking finding is answered when the push arrives. An answer is your
  `applied` reply to the last review, or a `dismissed` the CI adjudicator upheld. The gate then turns green,
  marked `fixes unverified`. No review checked those fixes, so `applied` must mean you fixed it and ran the
  tests. **Reply first, then push.**
- Under a used-up budget or `manual_only`, where the gate would turn green it holds the head `pending`
  instead (`reason_code=manual_review_hold`). No later push is reviewed on its own, so a person chooses.

`deferred` and `misclassified` never leave the count. They name something real, so the gate stays red until a
fix or a maintainer's override.

Size and cost limits are different: they skip the review and turn the gate red
(`reason_code=review_skipped`). A forced review bypasses them and spends money, so it is the user's call.

## What to tell the user on an **ask** row

State the gate's situation, what was and was not reviewed (`git diff <report.head>..<head> --stat`), and the
choices, with your recommendation:

| Situation | Choices |
|---|---|
| `reason_code=review_skipped` | Force a review with `/crysk review`, reduce the pull request, or a maintainer overrides. For a cost limit, the limit itself is a setting in the Crysk dashboard. |
| `reason_code=manual_review_hold` | `/crysk review` to verify the head, or a maintainer's `/crysk override` to merge it unverified. |
| `reason_code=carried_red_all_answered` | `/crysk review` to verify this head, or a maintainer's override. |
| `reason_code=carried_partial_all_answered` | `/crysk review` to retry the partial review, or a maintainer's override. |
| `reason_code=review_needs_trigger` | `/crysk review`, or a maintainer's override. |

Recommend a review when the unreviewed delta holds new business logic, state or concurrency changes, auth,
security or isolation edits, or a non-trivial refactor. Name the files. If the delta only applies
straightforward fixes for findings already answered, say another review is unlikely to add anything.

## When a maintainer's override is the right thing to request

`/crysk override` is never yours to post. Ask a maintainer for it only when:

- a `deferred` or `misclassified` finding should merge unfixed;
- a contrived finding survives a rejected or inconclusive adjudication, and you have said why you consider it
  contrived;
- a partial review keeps failing on the same reviewers and their route cannot be fixed;
- the gate holds the head for a manual review and the delta does not justify another paid review.

Do not ask for it because reviews ran out while findings are still unanswered: answer them. If the review
itself is broken (every hunter failing, a credential or quota problem), report the failure. An override there
would hide it.

## `/crysk stop`

Post it only when `gate.state` is `success`, and before the push it should cover. It tells admission to skip
automatic reviews, and it stays in force until someone with write access comments `/crysk review` or
`/crysk recheck`. It starts no run and costs nothing. It cannot cancel a review that already started.

**On a red gate, do not post it: tell the user.** A stop turns the next push into a skip, and a skip can turn
a red whose findings you answered yourself into green, with no review having checked the fixes. That decision
is not the author's to take.

After the push, always run `status --wait` and act on what it returns. A skip can leave the head `pending` or
red, so never assume it is green.

## When an unreviewed delta matters

`report.head` differing from `head` means `git diff <report.head>..<head>` was never reviewed, even when
`next_action=done` under a carried green. If that delta is load-bearing (see above), recommend `/crysk review`
to the user and name the changes before calling the pull request ready. If it is not, say the pull request is
ready and mention the unreviewed commits.

## Diminishing returns

Later passes hunt only the push delta. Once the real defects are fixed, hunters scanning a small fix-up commit
can produce increasingly contrived claims. Fixing one just to turn the gate green is worse than a wasted edit:
it creates a push, another review of an even smaller delta, and a spiral of defensive code.

- Never patch code to appease a contrived or over-severe finding.
- If the claim needs an impossible precondition, contradicts an intended invariant or is already guarded,
  answer `dismissed` with cited code and let `/crysk recheck` rule, with no code change and no push.
- If it is true but trivial, pre-existing or inflated to blocking, answer `misclassified` or `deferred`.
- When only such findings remain, stop and list each with one line on why, and tell the user what a
  maintainer would need to decide.

## Flawed design

Reaching zero findings through rounds of band-aids is a failure if the design was wrong. Many real findings in a
first review of a new feature are normal. Suspect the design when either signal appears:

1. **Whack-a-mole.** From the second round on, fixing the last round's findings produces new, legitimate blocking
   findings on the same seam, or a finding returns at a higher severity.
2. **A broken assumption.** Two or more findings show that the code's model of an external API, lifecycle,
   concurrency guarantee or module ownership does not hold.

Then:

- Stop the fix-and-push loop before replying or patching. Post no `applied` for fixes that will not be pushed,
  and do not push partial attempts.
- Name the one decision that caused the cluster, and report it to the user with the concrete alternative.
- After the redesign is pushed, if a `/crysk stop` is in force, a `/crysk review` lifts it so the new design gets
  reviewed. Treat that like any forced review: within the limits, and with the user's yes when a limit applies.
