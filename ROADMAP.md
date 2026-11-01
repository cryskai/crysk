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
| 3 | 0.5 | Platform: GitHub App, dashboard, token broker | product launch |
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
  (Anthropic: "any incidents are now an eval".)
- **Noise metric:** per hunter, the share of findings triaged as fixed, wrong, intentional or did not
  matter, read from triage outcomes (the store's `finding_triage` table, plus the historical
  verdicts kept read-only in `comparison_rows`). **Done** (#446, #447): 24% of posted findings are
  immaterial by an exam-validated judge. The noise is spread across hunters (largest cell: resilience
  advisories, 9% of posted findings), so no single prompt is the cause.
- **Clean-PR arm:** PRs with no known bug, to count pure false positives. **Proxy measured
  (2026-11-01):** small and docs-only PRs are quiet (19 of 21 reviews of diffs of 100 lines or fewer
  had no blocking finding), so a dedicated arm is not urgent.
- **Loop metrics:** rounds to a green gate, and time from PR open to green.

**Then the changes**, one variable each, measured against the Martian 50 baseline with a same-session
control, plus the incident eval:

1. **Standard severity and categories** (#394, informed by #395): Martian's Low/Medium/High/Critical
   scale and its ten categories. Stage 1 of #394 maps without changing behaviour; stage 2 lets hunters
   emit the standard directly. The findings schema is shared with the lab, so it is a coordinated bump.
2. **Calibrated severity** (#19): today the hunter prompts forbid lowering severity, so two thirds of
   findings come out BLOCKER/CRITICAL and none SUGGESTION. Calibrate the criteria, not the temperature.
   **Parked by measurement (2026-11-01):** the blocking findings are real, so lowering severity would
   hide bugs, not fix a miscalibration. 48 of 52 blocking findings on re-reviews were judged material,
   and #19's own check found 35 of 36 musive 🔴 findings corroborated by the refuter.
3. **Empty is a valid answer:** the prompts say plainly that a review with no findings is a correct
   result, not a failed one. **Already true:** the reliability, logic, parity and lifecycle prompts say
   it, a quarter of reviews end with no findings, and 12 of 21 reviews of diffs of 100 lines or fewer
   found nothing.
4. **Materiality rule:** a real defect that is not crucial is not posted, or goes to the summary. The
   threshold is configurable. **Done for blocking findings** (#448, live on this repo since #449).
   **Open: WARNING advisories.** They reach neither the refuter nor the materiality judge, and the
   hunter prompts say "you do not filter — a downstream refuter owns precision", so 70% of the
   measured noise is advisories nothing checks. Sizing from existing verdicts: 0.73 WARNING advisories
   per review (half of reviews have none, max 6); the judge calls 65 of 185 immaterial (35%), more
   than half of all measured noise; about $0.011 per review on average and ~10 s on reviews that
   have any. Hiding them never touches the gate. This is a pipeline change, not a prompt change.
5. **Configurable strictness:** one setting decides what posts inline, what goes to the summary and
   what blocks the gate. **Partly done:** `post_min_severity` (#445) decides what posts.
6. **Owner-written review guide per repo** (Anthropic): a `REVIEW.md` that says what counts as a
   failure, caps nits, lists paths to skip and asks for file:line evidence.
7. **Depth by risk** (Anthropic): the admission risk picks the hunter set and effort, not only review or
   skip.
8. **A shorter loop:**
   - a round cap (about 3), after which the author is asked to rethink rather than patch again
     (Anthropic; our own cap is 2 review rounds per PR today);
   - ~~re-reviews skip findings on code that was already there at the first pass~~ and ~~minor
     findings are not re-raised every round~~: **dropped by measurement (2026-11-01).** A re-review
     already reads only the delta since the last review, so 2-6% of re-review findings sit on unchanged
     lines (Anthropic measured 59%) and 3% re-raise an open advisory. The extra rounds come from real
     bugs in the fixes: 85% of re-review findings are new findings on changed lines.
   - a blocking prior the materiality gate demotes on a later head is released (#451).
9. **Re-review keeps history:** a re-review adds to the thread instead of rewriting the posted comment,
   so what was said at each head stays traceable.
10. **PR score as an acceptance gate:** a deterministic score computed over the final evidence, not
    another model asked to grade 0–100. The fix loop runs until the score clears the repo's threshold,
    and some rules cannot be compensated by a high score (designed 2026-09-16; notes in Engram,
    `planning/pr-scoring-*`).
11. **Flag the bug class with all its instances** (Anthropic), building on the consolidation stage.

**Done when:** precision and the noise metric improve with H+C recall within noise of 52/66, rounds to
green and time to green go down, and the new numbers are published.

## Stage 3 — Platform (0.5)

The product: one place to configure everything and see the state of every review, kept cheap.
Moved ahead of model squads on 2026-10-31: a squad that cannot run on the user's own subscription
is half a feature, and subscriptions other than Claude's need this stage's backend (see the token
broker below).

- **GitHub App:** one-click install and repo selection.
- **Reviews keep running on the user's own CI runner**, with their model and their key or
  subscription. The App and its hosted backend coordinate (webhooks, configuration, state); they do
  not run reviews or pay for models. This keeps the "no extra cost on your plan" story and is the model
  Pullfrog (github.com/pullfrog/pullfrog) runs in production. Decided 2026-10-31.
- **Token broker:** a hosted store for subscription credentials whose refresh token rotates on every
  use (ChatGPT/Codex today, possibly others). GitHub Actions secrets cannot hold them: a job cannot
  write a secret back with its own token, so the stored chain goes stale after the first refresh.
  - The action authenticates with a GitHub OIDC token (`id-token: write`), so no Crysk key sits in
    the user's secrets.
  - At run start the broker takes a per-credential lock, refreshes if needed and hands out a fresh
    `auth.json`. The lock is required: two concurrent runs refreshing the same token break the chain.
  - The action's `post:` hook, which runs even on cancel or timeout, writes a rotated token back.
  - A credential OpenAI rejects is latched as dead and the user is told to re-run the login, instead
    of retrying it on every run.
  - Enrolment: `crysk auth codex` runs `codex login` against a temporary `CODEX_HOME` with
    `cli_auth_credentials_store = "file"`, then uploads the result.
  - Credentials are encrypted at rest. Holding third-party credentials raises the security bar for
    the whole backend.
- **Dashboard:** findings, triage, scores and cost per repo and per PR, on top of the existing store
  and server (`src/store/`, `src/server/`).
- **Persistent storage:** run history that survives CI runners (#157), backend and provider columns for
  cost attribution (#139), home hardening (#35), observability (#23).
- **Open question, answer before building the broker:** whether OpenAI's terms allow a ChatGPT
  subscription to be used from CI automation.

**Done when:** a team installs the App, reviews run on their runner, the dashboard shows their state,
and a ChatGPT subscription credential survives consecutive and concurrent runs.

## Stage 4 — Model squads (1.0)

Presets the user picks with one setting, each with its own measured number, like today's Claude default:

- **Claude** (default): Sonnet hunters, Opus refuter.
- **OpenAI** models, on an API key or, through Stage 3's token broker, a ChatGPT subscription.
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
