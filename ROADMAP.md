# pr-hero — Roadmap

Redrawn 2026-10-27, after the Martian 50 milestone. The previous roadmap (2026-07-29 to 2026-10-17:
Phases A–E, THE PIVOT, the launch line) is archived at `docs/history/ROADMAP-2026-07-to-10.md`.
Item ids in code comments and old issues (A2, B7, C2, C7–C10, D, E, M0–M7) refer to that file.

## Where we are

The engine is stable and measured. On Martian's Code Review Bench (50 public PRs, 173 known bugs,
66 High/Critical, judged by Claude Opus 4.5 through Martian's own pipeline):

| | Value | Note |
|---|---|---|
| High+Critical caught | 52/66 (79%) | first of the 22 comparable tools |
| Precision / recall / F1 | 31.4% / 64.7% / 42.3 | with the consolidation stage; 38.6 on a same-session control |
| Adjusted precision | 58% | counts real bugs off Martian's list; our own classification, not audited |
| Review time | 4.3 min median | the repo's own CI, October 2026; tied with Greptile v4 on Martian's timing |

Measured on pr-hero 0.2.4 plus the consolidation stage (merged in #400). Raw data and caveats live in
the private lab ledger (`../deep-review/bench/METRICS.md`, 2026-10-25 to 2026-10-27).

What the numbers say: we catch the most serious bugs and we are fast, but we are loud. Precision is the
weakest number, and the review loop on a PR runs longer than it should. That is the main product work
after launch.

## Order

Launch first with what we have, improve after, and ship each improvement as an update with its own
measured number.

| Stage | Version | Theme | Public moment |
|---|---|---|---|
| 0 | 0.2.5 | Ship what is merged | none (quiet release) |
| 1 | 0.3.0 | Rebrand + launch | launch video, new site, benchmark story |
| 2 | 0.4 | Quieter, faster reviews | update post with a new benchmark |
| 3 | 0.5 | Platform: GitHub App, dashboard, ChatGPT subscription in CI | free beta, then product launch |
| 4 | 1.0 | Model squads | update post: pick your models |

Evals and hygiene run continuously alongside every stage (see the end of this file). Version numbers
are the maintainer's decision at release time; the table records intent.

## Stage 0 — Ship what is merged

- Release `dev` to `main` and npm: consolidation stage on by default, refuter v3.2 reverted, the
  benchmark tooling fixes.
- Reserve the new name everywhere it will be needed (package registry, domain, GitHub org) before it
  appears in any public file.

**Done when:** the release is on npm and the new name is reserved.

## Stage 1 — Rebrand and launch (0.3.0)

The current name collides with an unrelated AI product that owns the `.com`, and searching for it does
not find this project. Rename before launch, while the user base is small: every user, tutorial and
installed workflow added later makes it more expensive.

1. **Rename the product:** package, repository (GitHub redirects the old URLs, including `uses:`), README,
   docs, skills, CLI banner and help text.
2. **Dual-read compatibility, so no installed user breaks.** The engine must accept both the old and the
   new form of each contract for at least one minor version:
   - comment markers (`<!-- pr-hero-finding`, `<!-- pr-hero-report`, `<!-- pr-hero-triage`);
   - PR commands (`/pr-hero review`, `recheck`, `stop`, `override`);
   - environment variables (`PRHERO_*`);
   - the home directory (`~/.prhero`);
   - the old package name: a last release that points to the new one, then `npm deprecate`.
3. **Remove the Greptile comparison code and wording** (about 25 source files and 17 test files). The
   head-to-head is retired; Martian is the comparison field now. Do it during the rename, since every
   file is touched anyway.
4. **New site** under the new name and domain, with the benchmark section (bugs caught, precision,
   adjusted point, review time).
5. **Launch video and post.** Record after the rename, so it shows the final name, site and numbers.
   Material from the unpublished v0.2 video (OpenCode routes, the logic hunter) folds into it.

**Done when:** the new package installs and reviews a PR end to end, an old install keeps working
(markers, commands, env vars, home dir), and the launch is published.

## Stage 2 — Quieter, faster reviews (0.4)

The biggest product lever. Reviews post too many findings, rate most of them critical, and the
fix-and-re-review loop takes too long for how fast coding agents work now. Several items come from
Anthropic's "Solving code review at Anthropic" (claude.dev/blog, 2026-10-15) and are noted as such.

**First, the yardsticks** (built before any behaviour change, so every item below is measured):
- **Real-incident eval:** PRs that were later reverted or fix-forwarded, with the bug site confirmed by
  someone who knows the code; rescored on every prompt, model or tool change. Lives in the private lab.
  (Anthropic: "any incidents are now an eval".) **Parked (2026-11-03):** there are no collected cases
  yet, and no one to confirm the bug sites.
- **Noise metric:** per hunter, the share of findings triaged as fixed, wrong, intentional or did not
  matter, read from triage outcomes (the store's `finding_triage` table, plus the historical
  verdicts kept read-only in `comparison_rows`). **Done** (#446, #447): 24% of posted findings are
  immaterial by an exam-validated judge. The noise is spread across hunters (largest cell: resilience
  advisories, 9% of posted findings), so no single prompt is the cause.
- **Clean-PR arm:** PRs with no known bug, to count pure false positives. **Proxy measured
  (2026-11-01):** small and docs-only PRs are quiet (19 of 21 reviews of diffs of 100 lines or fewer
  had no blocking finding), so a dedicated arm is not urgent.
- **Loop metrics:** rounds to a green gate, and time from PR open to green. **Done** (#455), measured
  on PRs reviewed by v0.3.0 or later only. Most PRs are fast: half or more reach green on the first
  review, and time to green has a p50 of about 0.1 h. The cost is in a tail. On musive (n=18), 23% of
  PRs needed 3 or more fix rounds and 22% ended red. On this repo (n=29), no PR needed more than 2 fix
  rounds, and the p90 is 0.6 h. The review budget (2 automatic reviews here, 3 on musive) was used up on
  14–22% of PRs, so the tail is a floor set by the cap, not the natural length of the loop. A review
  run takes about 3–5 min, and the musive p90 comes from fix time, not engine time. The samples are
  small: track the tail (3+ fix rounds, ended red) rather than the medians, which are already at the
  floor.

**Then the changes**, one variable each, measured against the Martian 50 baseline with a same-session
control, plus the incident eval:

1. **Standard severity and categories** (#394, informed by #395): Martian's Low/Medium/High/Critical
   scale and its ten categories. **Dropped (2026-11-04):** Martian never reads a tool's own labels, so
   the rename cannot move the score. A coordinated schema bump with the lab is costly and risky. Over the
   111 judged Martian 50 true positives, the 1:1 severity mapping agreed exactly with the golden on 43%,
   and a 15→10 category table on 45%, below the 59% from labelling everything `bug`. Labels stay as they
   are; see `docs/research/finding-taxonomy.md`.
2. **Calibrated severity** (#19): today the hunter prompts forbid lowering severity, so two thirds of
   findings come out BLOCKER/CRITICAL and none SUGGESTION. Calibrate the criteria, not the temperature.
   **Parked by measurement (2026-11-01):** the blocking findings are real, so lowering severity would
   hide bugs, not fix a miscalibration. 48 of 52 blocking findings on re-reviews were judged material,
   and #19's own check found 35 of 36 musive 🔴 findings corroborated by the refuter.
3. **Empty is a valid answer:** the prompts say plainly that a review with no findings is a correct
   result, not a failed one. **Already true:** the reliability, logic and parity prompts say it (so did
   the lifecycle prompt, retired 2026-11-08), a quarter of reviews end with no findings, and 12 of 21 reviews of diffs of 100 lines or fewer
   found nothing.
4. **Materiality rule:** a real defect that is not crucial is not posted, or goes to the summary. The
   threshold is configurable. **Done for blocking findings** (#448, live on this repo since #449).
   **Open: WARNING advisories.** They reach neither the refuter nor the materiality judge, and the
   hunter prompts say "you do not filter — a downstream refuter owns precision", so 70% of the
   measured noise is advisories nothing checks. Sizing from existing verdicts: 0.73 WARNING advisories
   per review (half of reviews have none, max 6); the judge calls 65 of 185 immaterial (35%), more
   than half of all measured noise; about $0.011 per review on average and ~10 s on reviews that
   have any. Hiding them never touches the gate. This is a pipeline change, not a prompt change.
   **Not now (2026-11-02): small impact.** It would hide about one noisy comment every four reviews,
   WARNING advisories never block or lengthen the loop, and the judge calls 65% of them material, so
   a wrong call hides a useful one. A repo that wants silence already has `post_min_severity:
   blocking` at no cost. Revisit once the blocking materiality gate has demoted findings in
   production: it has demoted none since it went live (#449).
5. **Configurable strictness:** one setting decides what posts inline, what goes to the summary and
   what blocks the gate. **Partly done:** `post_min_severity` (#445) decides what posts.
6. **Owner-written review guide per repo** (Anthropic): a `REVIEW.md` that says what counts as a
   failure, caps nits, lists paths to skip and asks for file:line evidence. **Done** (#463, #464, #465,
   released in 0.3.3): a root `REVIEW.md` is the repo's review instructions, with `.crysk/gotchas.md` as
   the fallback, and both are optional. The hunters and the refuter read it as facts; with
   `materiality_gate` on, the judge applies its "Not blocking here" rules, but only to style, naming,
   test-hygiene, generated-code and dev-script findings. Measured: refuter replay kept the same verdict
   on 74 of 76 Martian cases and lost no corroborated finding. Not yet seen in production: an owner rule
   actually demoting a finding. Reading the file from the base branch instead of the PR checkout waits
   for the GitHub App (Stage 3).
7. **Depth by risk** (Anthropic): the admission risk picks the hunter set and effort, not only review or
   skip. **Parked (2026-11-04), worth doing later.** A $0.12 offline probe (lab ledger, "Jev as the
   review-depth router") found:
   - Jev ranks review depth better than diff size (Martian AUC 0.77 vs 0.66). Size thresholds learned on
     our repos do not transfer: they would send 12 of 34 Martian PRs with a High/Critical bug to low.
   - Jev's safe low bucket is narrow, and dropping hunters for it saves only ~3% of review tokens.
   - Agent skill `.md` files carry real blocking bugs, so neither Jev nor a docs glob may treat them
     as docs.

   The bigger lever is effort per level, not the hunter set: on one musive PR, Sonnet `high` cost 70%
   less per hunter than `xhigh` and ran ~3× faster, but found 3 of 4 known bugs. Next step, deferred
   for cost: Sonnet `high` vs `xhigh` on Martian Cal.com 10 (19 H+C, `xhigh` 16/19), same session,
   with replicates. `high` passes if it loses at most 1 H+C on average.
8. **A shorter loop:**
   - a round cap (about 3), after which the author is asked to rethink rather than patch again
     (Anthropic; our own cap is 2 review rounds per PR today). The cap is the existing `ci_max_attempts`
     (default 2), not a second counter: the rethink text belongs on its `max-attempts-exhausted` message.
   - ~~re-reviews skip findings on code that was already there at the first pass~~ and ~~minor
     findings are not re-raised every round~~: **dropped by measurement (2026-11-01).** A re-review
     already reads only the delta since the last review, so 2-6% of re-review findings sit on unchanged
     lines (Anthropic measured 59%) and 3% re-raise an open advisory. The extra rounds come from real
     bugs in the fixes: 85% of re-review findings are new findings on changed lines.
   - a blocking prior the materiality gate demotes on a later head is released (#451).
9. ~~**Re-review keeps history:** a re-review adds to the thread instead of rewriting the posted comment,
   so what was said at each head stays traceable.~~ **Dropped (2026-11-03):** inline findings already
   live in their own threads, and GitHub keeps the edit history of the summary comment. A new summary per
   head would break how a re-review finds its prior summary and state block.
10. ~~**PR score as an acceptance gate:** a deterministic score computed over the final evidence, not
    another model asked to grade 0–100. The fix loop runs until the score clears the repo's threshold,
    and some rules cannot be compensated by a high score.~~ **Dropped (2026-11-04):** the gate already
    exists, and a thresholded score has no data behind it. The `crysk` status is already a deterministic,
    non-compensable gate (red on an open blocking finding, a partial review, or a size or budget skip).
    Convoy's scoring, the 2026-09-16 plan's base, is still model-graded with no veto. Anthropic,
    SonarQube, CodeRabbit, Bugbot and Sourcery all gate on binary conditions, not a weighted number. A
    $0 replay (lab ledger, "Do advisory fields predict which advisories the loop fixes?", including its
    post-hoc correction) found `evidence_class` predicts which advisories get fixed (AUC 0.66), severity
    does not (0.52), and only ~1 in 5 green PRs still carries open advisories. That is too few to gate
    on. An informational "advisory debt" line was sized (~300 lines, plus a state-block field) and not
    worth it. Notes in Engram, `odd/pr-score-gate/tasks` and `planning/pr-scoring-*`.
11. **Flag the bug class with all its instances** (Anthropic), building on the consolidation stage.
12. **Greens no review saw** (found while closing #10): when a new head is skipped (budget used up,
    `max-attempts-exhausted`), it inherits the last verdict. A carried green stays green, and a carried
    red turns green once every blocking finding is answered, without verifying the fixes
    (`src/pr/admission.ts:603-648`). So code no review read can merge on a green `crysk`. **Done for the
    capped rules (2026-11-04):** since #442, 19 of 65 merged PRs here and on musive ended on a head no
    review read. 11 were a maintainer's `/crysk stop`, and one merged green over 11 unreviewed commits
    after the budget ran out. Under the budget used up or `manual_only`, a would-be green is now held
    `pending` until a manual `/crysk review` or `/crysk override`; a red still carries. `/crysk stop`, a
    low-risk or below-threshold delta and once per PR still carry a green. Open: the low-risk delta rule
    treats agent skill `.md` files as low risk (3 such carried greens here), which #7's probe found carry
    real blocking bugs.

**Done when:** precision and the noise metric improve with H+C recall within noise of 52/66, rounds to
green and time to green go down, and the new numbers are published.

## Stage 3 — Platform (0.5)

The product: a hosted platform around the open-source engine. One place to configure reviews and
see the state of every PR, kept cheap to run. The engine keeps working on its own, without the
platform, exactly as it does today.
Moved ahead of model squads on 2026-10-31: a ChatGPT subscription needs this stage's App to keep its
rotating credential alive between runs.

**Product decisions:**
- **Reviews run on the user's own CI runner**, with their model and their key or subscription. The
  platform coordinates; it does not run reviews or pay for models.
- **The App manages reviews, not a workflow the user edits.** On install it opens a pull request with
  a small stub workflow. From then on the backend turns webhooks into dispatches and decides the config
  and the engine version. Reviews post as `crysk[bot]`.
- **Crysk never holds a subscription credential.** Credentials live in the customer's repository
  secrets.
- **Config lives on the platform first.** The repo config file keeps working and, when it exists, wins
  for that repo.
- **Data:** the full repository never leaves the runner. By default the platform stores findings with
  their code snippets, encrypted, with bounded retention. A metadata-only mode stores no code.
- **The MVP (phases 1 and 2) ships as a free beta.**

### Phase 0 — Decisions (no code)

- Provider terms for subscriptions in CI: answered, 2026-11-04.
- Technical stack and hosting, with the monthly cost: answered, 2026-11-04.

**Done when:** each question has a written answer with its source.

### Phase 1 — Foundations

- **Hosted backend.** The runner authenticates with a GitHub OIDC token, so no Crysk key sits in the
  user's secrets.
- **GitHub App:** one-click install, the stub's pull request, the bot identity, webhooks to dispatches.
- **Updates without a workflow edit**, with a brake on the backend: release channels, staged rollout,
  kill switch. The backend sends config as data, never code.
- **Remote config**, with the precedence above.
- **Every run is recorded** (#157), with cost attribution (#139).
- **If the platform is down, reviews are delayed, not lost.**
- Measured: the time the platform adds before a review starts.

**Done when:** a repo installs the App, merges its pull request, gets reviews on its runner, and every
run is recorded.

### Phase 2 — Visible MVP

- Sign-in with GitHub.
- **Dashboard:** the list of PRs with their state; each PR opens its findings, triage and rounds. An
  Insights tab shows noise, time to green, and cost per PR and per model.
- **Credential setup:** API keys from the dashboard; a guided step for a Claude subscription token.
- The data policy above, including metadata-only mode.

**Done when:** a user sets up and follows their PRs without opening GitHub or a workflow file.

### Phase 3 — Differentiators

- **Project memory**, learned from triage outcomes and correctable in the UI. Announced only after an
  A/B shows the same review is more precise with memory than without.
- **ChatGPT subscription in CI**, connected from the dashboard, in private repositories.
- **API and MCP for agents:** above all "what blocks this PR" and "re-review now".

**Done when:** memory has a measured precision gain, and a ChatGPT subscription credential survives
consecutive runs.

### Later

- Overflow to the user's API key when the subscription quota runs out; reviewing each PR with its
  author's own credential.
- Org-wide policies (one `REVIEW.md`, strictness, ignored paths) and notifications (Slack, email).
- Per-repo "bugs caught before production"; real-traffic evals with consent; an incident eval fed by
  reverts in connected repos.
- Home hardening (#35), observability (#23), a security audit for larger teams.
- Reviews on Crysk-hosted compute, with no workflow file.

**Stage done when:** Phase 3's done-when holds and the beta has outside users.

## Stage 4 — Model squads (1.0)

Presets the user picks with one setting, each with its own measured number, like today's Claude default:

- **Claude** (default): Sonnet hunters, Opus refuter.
- **OpenAI** models, on an API key or, through Stage 3's App, a ChatGPT subscription.
- **Low-cost** models (the DeepSeek/GLM family already runs through OpenCode).
- Mixed providers in one review (#195), reasoning effort across backends (#207), and the OpenCode
  coverage gaps (#142).

Each squad is a Martian arm plus the incident eval, and the site shows quality and cost per squad.

**Done when:** at least three squads ship with published numbers and a one-line way to choose.

## Continuous

**Evals.** The incident eval, the noise metric and the loop metrics stay running after Stage 2. Martian
50 replicates before any number is quoted as final (single runs are n=1). Every live run lands in the
lab ledger the day it runs.

**Hygiene and open bugs**, picked up between stages:
- CI and posting: #321 (4xx retried as transient), #317 (all-excluded PR fails), #300 (`--post` from
  global config), #274 (forced re-review does not cancel the running one), #203 (admission ignores
  `.prheroignore`), #200 (size gate counts deletions), #178 (outside-diff findings cannot be closed).
- Execution: #303 (snapshot leak in `$TMPDIR`), #264 (target `.env` contamination), #299 (empty hunters
  on the Claude route), #40 (soft timeout that salvages findings).
- Tests and tooling: #174 (tests read the real environment), #46 and #45 (corpus), #113, #119, #134,
  #138, #70, #25 (tech-debt waves).
- Consolidation: #401 (pooled proof refs shift re-review identity).
- Remove the scout stage: it never earned its place and is off by default.

## Standing rules

- Measure before shipping a behaviour change: one variable per experiment, a same-session control,
  replicates before a number is quoted.
- LLMs judge, code governs: tiers, gates and scores are computed by code, never by a model.
- Isolation flags are a threat model (see CLAUDE.md rule 4).
- Every live run costs money and lands in the lab ledger the day it runs.
- Every change lands through a PR into `dev`, reviewed by pr-hero itself.
