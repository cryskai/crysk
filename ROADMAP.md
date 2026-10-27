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
| 3 | 0.5 | Model squads | update post: pick your models |
| 4 | 1.0 | Platform: dashboard + GitHub App | product launch |

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
  matter, read from triage outcomes (`src/compare/ledger.ts` already reads verdicts).
- **Clean-PR arm:** PRs with no known bug, to count pure false positives.
- **Loop metrics:** rounds to a green gate, and time from PR open to green.

**Then the changes**, one variable each, measured against the Martian 50 baseline with a same-session
control, plus the incident eval:

1. **Standard severity and categories** (#394, informed by #395): Martian's Low/Medium/High/Critical
   scale and its ten categories. Stage 1 of #394 maps without changing behaviour; stage 2 lets hunters
   emit the standard directly. The findings schema is shared with the lab, so it is a coordinated bump.
2. **Calibrated severity** (#19): today the hunter prompts forbid lowering severity, so two thirds of
   findings come out BLOCKER/CRITICAL and none SUGGESTION. Calibrate the criteria, not the temperature.
3. **Empty is a valid answer:** the prompts say plainly that a review with no findings is a correct
   result, not a failed one.
4. **Materiality rule:** a real defect that is not crucial is not posted, or goes to the summary. The
   threshold is configurable.
5. **Configurable strictness:** one setting decides what posts inline, what goes to the summary and
   what blocks the gate.
6. **Owner-written review guide per repo** (Anthropic): a `REVIEW.md` that says what counts as a
   failure, caps nits, lists paths to skip and asks for file:line evidence.
7. **Depth by risk** (Anthropic): the admission risk picks the hunter set and effort, not only review or
   skip.
8. **A shorter loop:**
   - a round cap (about 3), after which the author is asked to rethink rather than patch again
     (Anthropic; our own cap is 2 review rounds per PR today);
   - re-reviews skip findings on code that was already there at the first pass (Anthropic: 59% of
     repeat flags were old code);
   - re-reviews look again only at what matters, and minor findings are not re-raised every round.
9. **Re-review keeps history:** a re-review adds to the thread instead of rewriting the posted comment,
   so what was said at each head stays traceable.
10. **PR score as an acceptance gate:** a deterministic score computed over the final evidence, not
    another model asked to grade 0–100. The fix loop runs until the score clears the repo's threshold,
    and some rules cannot be compensated by a high score (designed 2026-09-16; notes in Engram,
    `planning/pr-scoring-*`).
11. **Flag the bug class with all its instances** (Anthropic), building on the consolidation stage.

**Done when:** precision and the noise metric improve with H+C recall within noise of 52/66, rounds to
green and time to green go down, and the new numbers are published.

## Stage 3 — Model squads (0.5)

Presets the user picks with one setting, each with its own measured number, like today's Claude default:

- **Claude** (default): Sonnet hunters, Opus refuter.
- **OpenAI** models.
- **Low-cost** models (the DeepSeek/GLM family already runs through OpenCode).
- Mixed providers in one review (#195), reasoning effort across backends (#207), and the OpenCode
  coverage gaps (#142).

Each squad is a Martian arm plus the incident eval, and the site shows quality and cost per squad.

**Done when:** at least three squads ship with published numbers and a one-line way to choose.

## Stage 4 — Platform (1.0)

The product: one place to configure everything and see the state of every review, kept cheap.

- **Dashboard:** findings, triage, scores and cost per repo and per PR, on top of the existing store
  and server (`src/store/`, `src/server/`).
- **Persistent storage:** run history that survives CI runners (#157), backend and provider columns for
  cost attribution (#139), home hardening (#35), observability (#23).
- **GitHub App:** one-click install and repo selection.
- **Open design question:** a GitHub App needs a hosted webhook backend. Either reviews run hosted (we
  pay compute and models) or the App coordinates while reviews still run on the user's own CI runner
  with their model and key (cheaper to operate, and it keeps the "no extra cost on your plan" story).
  Decide at the start of this stage.

**Done when:** a team installs the App, reviews run, and the dashboard shows their state.

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
