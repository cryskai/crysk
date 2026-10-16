// Pillar 3 Phase 4 (ROADMAP THE LAUNCH LINE): CI workflow scaffolding.
//
// generateCiWorkflowTemplate is PURE — a string builder with zero filesystem
// access, so its exact bytes are testable without touching disk (the "pure
// decisions pure, I/O in the shell" rule from CLAUDE.md). runCiSetup is the
// one impure edge in this module: it resolves the target path under the
// caller's repo, refuses to clobber a user's customized workflow without
// --force (a safety property, not a nicety — see spec.md §4.1), and writes
// the template.
//
// This module writes `.github/workflows/pr-hero.yml` into WHATEVER repo the
// caller points it at (via `pr-hero setup --ci` / `pr-hero ci init`). Pillar
// 3 Phase 5 (tasks.md 5.2) reuses this SAME function to produce this repo's
// own canonical example workflow at the identical relative path, rather than
// hand-authoring a second copy that could silently drift from what every
// caller of `setup --ci` actually gets — test/packaging.test.ts asserts the
// committed file's bytes equal generateCiWorkflowTemplate()'s output exactly.
//
// That one file is the whole install. It reviews every push and answers a
// `/pr-hero review` pull request comment, which used to need a second,
// dispatch-only `pr-hero-force.yml`. The action now owns everything the
// workflow used to wire around it: credential detection, the comment's
// parsing and the commenter's permission check, the pull request and head
// resolution, and the run-directory upload. runCiSetup no longer writes a
// force workflow, and it leaves an existing one alone: the skip comment still
// names it for repos scaffolded before the comment trigger, and the action
// keeps the inputs it sets.

import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseRoutingConfig } from "#review/preflight";
import { prheroLayout } from "../home-preflight";
import { resolveOpenCodeAuthPath } from "../security/credential-broker";

export const CI_WORKFLOW_RELATIVE_PATH = path.join(
  ".github",
  "workflows",
  "pr-hero.yml",
);

// The action reference the generated workflow resolves. A consumer repo has
// no copy of this action, so it must go through the published tag — that is
// the default. This repo generates its OWN workflow with `./`, because the
// source is right there in the tree and pointing at a tag that is not
// published yet would paint every PR here permanently red. A red check that
// can never go green is strictly worse than no check: it teaches the team to
// stop reading CI, which is the exact failure this pillar exists to prevent.
// `./` is also the only form that tests the action being changed by the very
// PR that changes it.
export interface CiWorkflowTemplateOptions {
  actionRef?: string;
  // Repo-local override for the action's own `budget-usd` default. Omitted
  // means "say nothing and inherit the action's default", which is what every
  // scaffolded repo gets: raising a stranger's spend ceiling from a template
  // they did not choose is not ours to do.
  //
  // Since issue #156 that inherited default is a POLICY, not a number:
  // action.yml's `budget-usd` default is empty, and the CLI resolves the
  // ceiling from the route's billing mode (ci/gates.ts's
  // `resolveCiBudgetCeiling`) — no ceiling on a Claude subscription, a default
  // ceiling on a metered ANTHROPIC_API_KEY route. Inheriting is therefore
  // strictly better than it was: a scaffolded repo now gets a ceiling exactly
  // when a ceiling means something.
  //
  // NOTHING sets this today, this repo included — see OWN_CI_WORKFLOW_OPTIONS
  // for why the one override that existed went away. The knob stays because a
  // repo that genuinely wants a fixed ceiling on a subscription route needs a
  // way to say so, and that is the only thing an explicit value now means.
  budgetUsd?: string;
  // Repo-local override for the action's own `max-changed-lines` default, and
  // omitted for the same reason as `budgetUsd`: a scaffolded repo inherits
  // action.yml's 4000 and decides for itself. THIS repo raises it because its
  // own slices routinely land near the line — D1-10c was skipped at 1023,
  // twenty-three lines over, and a skipped review is indistinguishable from a
  // clean one to anyone reading the checks.
  //
  // Raising it costs little and risks little HERE. It is a COST gate, never a
  // quality one — the size<->quality question is unmeasured in this project
  // (`scripts/scope-probe.ts`), so this number is not a claim that pr-hero
  // reviews a 1500-line diff as well as a 300-line one.
  //
  // Since issue #156 it is also the ONLY gate bounding a self-review's scope
  // here, which is what the number has to be read against: this comment used
  // to lean on `budget-usd` as "the real spend ceiling, which still refuses
  // the work outright". On this repo's subscription route it never was — it
  // gated `estimate.high`, a token-derived figure, against $0.00 of real
  // cash.
  maxChangedLines?: string;
  // THIS repo only: on a `/pr-hero review` comment, the workflow resolves
  // the pull request's head commit BEFORE checkout and checks out exactly
  // that commit, so `uses: ./` runs the engine under review. A comment run
  // starts on the default branch, and without the pin it runs THAT branch's
  // engine: on #305 (then a `workflow_dispatch` force run, which starts there
  // too) main lagged dev, a stale engine posted a hollow review on the PR
  // head, and its complete summary marker made every later run on that head
  // skip discovery. The head sha, not `refs/pull/<n>/merge`: the merge ref is
  // missing on a conflicted PR and moves with the base. A `pull_request` run
  // already checks out the pull request, so the pin applies to comments only.
  //
  // Its own flag, never inferred from `actionRef === "./"`: a consumer
  // template runs a published tag, where the checkout selects no engine, and
  // the scaffolded output must not change shape because of a ref string.
  forceEngineFromPr?: boolean;
}

export const DEFAULT_CI_ACTION_REF = "juanmaagd/pr-hero@v0";

// The options THIS repo generates its OWN workflow with. One exported source
// of truth rather than three hand-copied literals: the byte-equality drift
// tests and every regeneration read the same object, so a change here cannot
// leave the committed workflow and the tests disagreeing about what "ours"
// means. Nothing a scaffolded repo receives passes through here.
//
// `budgetUsd` is "0": the explicit, loud DISABLE, not a ceiling. History:
// it used to be "15.00", because a self-review's diff grows against the base
// every time a finding is answered, so an iterating PR walked toward the
// ceiling exactly when the check mattered most. Issue #156 dropped it on the
// promise that the route's billing mode would apply no ceiling on this repo's
// Claude subscription. That promise did not hold here: the route resolved as
// metered, and #326 (and earlier PRs) skipped at the $10 metered default on
// an `estimate.high` that is not this route's cash cost. A subscription has
// no dollar cost to cap, so this repo opts out explicitly; fixing the
// billing-mode resolution itself is a separate issue. `maxChangedLines`
// stays: that gate is real on any route.
export const OWN_CI_WORKFLOW_OPTIONS: CiWorkflowTemplateOptions = {
  actionRef: "./",
  maxChangedLines: "5000",
  budgetUsd: "0",
  forceEngineFromPr: true,
};

export function generateCiWorkflowTemplate(
  options: CiWorkflowTemplateOptions = {},
): string {
  const actionRef = options.actionRef ?? DEFAULT_CI_ACTION_REF;
  const pinEngine = options.forceEngineFromPr === true;
  const budgetLine =
    options.budgetUsd === undefined
      ? ""
      : `\n          budget-usd: ${options.budgetUsd}`;
  // Emitted before `budget-usd` to mirror action.yml's own declaration order,
  // so the generated file reads in the same sequence as the inputs it sets.
  const sizeGateLine =
    options.maxChangedLines === undefined
      ? ""
      : `\n          max-changed-lines: ${options.maxChangedLines}`;
  // Pinned, the sha is what checkout lands on, so the fork verdict and the
  // sha come from ONE read: two reads could straddle a push and describe two
  // different heads. An assignment, not a here-string into `read`, so a
  // failing `gh` fails the step under `bash -e` instead of reading as a fork.
  const gateStep = pinEngine
    ? `      # THIS repo only. A comment run starts on the default branch, and
      # \`uses: ./\` runs whatever engine is checked out, so without this step
      # a comment-forced review runs the default branch's engine, not the
      # engine under review: on #305 main lagged dev, a stale engine posted a
      # hollow review, and its complete summary marker made every later run
      # on that head skip discovery. The gate resolves the pull request's
      # head and checkout pins exactly that commit. The head sha, not
      # refs/pull/<n>/merge: the merge ref is missing on a conflicted pull
      # request and moves with the base.
      #
      # A fork is refused HERE, although the scaffolded workflow reviews one
      # on a maintainer's comment: with \`uses: ./\` the checked-out fork would
      # supply the engine itself, and run it with this repository's secrets.
      #
      # The commenter's write access is checked HERE too, first, although
      # action.yml checks it again. With \`uses: ./\` the action.yml that runs
      # is the checked-out head's own, so a same-repo head that predates that
      # check (an old bot branch) would let anyone who can comment start a
      # review with this repository's secrets. This step is the only code that
      # runs before the head does. It fails closed: nothing but admin or write
      # proceeds. A 404 (GitHub's answer for a non-collaborator) or an answer
      # that is not admin or write refuses quietly with a notice, exit 0.
      # Any other lookup failure (a 5xx,
      # a rate limit, a timeout) says nothing about the commenter, so it is
      # retried once and then fails the job red: a quiet refusal would show a
      # maintainer whose command met a GitHub hiccup the same notice a
      # stranger gets, on a default-branch run nobody sees from the PR.
      - name: Resolve the pull request head
        id: gate
        if: github.event_name == 'issue_comment'
        env:
          PR: \${{ github.event.issue.number }}
          COMMENTER: \${{ github.event.comment.user.login }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          gh_err=$(mktemp)
          trap 'rm -f "$gh_err"' EXIT
          for attempt in 1 2; do
            if permission=$(gh api "repos/$GITHUB_REPOSITORY/collaborators/$COMMENTER/permission" --jq .permission 2>"$gh_err"); then
              break
            fi
            permission=""
            case "$(<"$gh_err")" in
              *"HTTP 404"*) break ;;
            esac
            if [ "$attempt" = 2 ]; then
              echo "::error title=pr-hero::could not verify the commenter's write access: the GitHub API call failed twice, so no review was started. Comment /pr-hero review again to retry"
              exit 1
            fi
            sleep 2
          done
          case "$permission" in
            admin|write) ;;
            *)
              echo "::notice title=pr-hero::only users with write access to this repository can run /pr-hero review"
              echo "proceed=false" >> "$GITHUB_OUTPUT"
              exit 0
              ;;
          esac
          case "$PR" in
            ''|*[!0-9]*)
              echo "::error title=pr-hero::pr must be a positive integer"
              exit 1
              ;;
          esac
          # One read: the fork verdict and the commit checked out next must
          # describe the same head, even if the branch moves in between.
          pr_head=$(gh pr view "$PR" --repo "$GITHUB_REPOSITORY" --json headRepository,headRefOid --jq '.headRepository.nameWithOwner + " " + .headRefOid')
          head_repo=\${pr_head% *}
          sha=\${pr_head##* }
          if [ "$head_repo" != "$GITHUB_REPOSITORY" ]; then
            echo "::notice title=pr-hero::fork pull requests are not reviewed here: uses ./ would run the fork's own engine with this repository's secrets"
            echo "proceed=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          # Only a full commit sha may reach checkout: an empty ref makes
          # actions/checkout fall back to the default branch, which is the
          # engine this pin exists to avoid, and any other value would be
          # resolved as a ref name.
          if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
            echo "::error title=pr-hero::could not resolve the pull request head commit"
            exit 1
          fi
          echo "proceed=true" >> "$GITHUB_OUTPUT"
          echo "sha=$sha" >> "$GITHUB_OUTPUT"

`
    : "";
  const proceedIf =
    "github.event_name != 'issue_comment' || steps.gate.outputs.proceed == 'true'";
  const checkoutGate = pinEngine ? `\n        if: ${proceedIf}` : "";
  const checkoutRef = pinEngine
    ? `
          # The gate's head sha on a comment. On pull_request the gate is
          # skipped, its output is empty, and an empty ref keeps checkout on
          # that event's own ref.
          ref: \${{ steps.gate.outputs.sha }}`
    : "";
  const runStepGate = pinEngine ? `\n        if: ${proceedIf}` : "";
  return `# Generated by \`pr-hero setup --ci\` (or \`pr-hero ci init\`).
# Customize freely — re-running setup will not overwrite this file again
# unless you pass --force.
#
# This one file is the whole install. It reviews every push to a pull
# request. A pull request comment that is exactly \`/pr-hero review\` runs the
# review again with the skip gates bypassed, and \`/pr-hero review --full\`
# also re-discovers the whole range. The action parses the comment and
# refuses a commenter without write access.
name: pr-hero Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  # GitHub runs a comment-triggered workflow from the DEFAULT branch's copy
  # of this file, never the pull request's. The comment trigger works only
  # once this file is merged there; until then a comment starts nothing.
  issue_comment:
    types: [created]

# pull-requests: write lets pr-hero post inline comments and a step summary.
# contents: read is enough for actions/checkout. issues: write lets it
# resolve/reply on review threads (GitHub models PR conversations as issues).
# checks: write persists the durable CI admission attempt ledger (WU-02).
# actions: read lets the admission gate list this workflow's past runs; a
# public repo serves that without the scope, a private one returns HTTP 403.
permissions:
  actions: read
  contents: read
  pull-requests: write
  issues: write
  statuses: write
  checks: write

jobs:
  review:
    # This \`if\` routes events; it never checks credentials. The secrets
    # context is unreadable in a job-level \`if\`, so the action detects a
    # missing credential itself and fails the run with the commands that
    # fix it, instead of a skipped job that reads as a clean review.
    #
    # Fork pull_request runs are skipped: GitHub gives them no secrets, so
    # they could never authenticate. A maintainer comments \`/pr-hero review\`
    # instead, and that run (base-branch context, with secrets) reviews the
    # fork's head.
    #
    # A comment starts the job only when it BEGINS with \`/pr-hero review\`.
    # The action then requires an exact match after trimming, so a near-miss
    # such as "/pr-hero review please" starts a job the action ends without
    # reviewing.
    if: >-
      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/pr-hero review'))
    # Job-level and keyed on the pull request number. A workflow-level group
    # on \`github.head_ref || github.ref\` put every comment on every pull
    # request into ONE group, because head_ref is empty on issue_comment, so
    # any comment anywhere could cancel any in-flight review.
    #
    # Only a new push cancels. The group filter is a prefix, so a near-miss
    # comment can claim the pull request's group too; cancelling there would
    # kill a paid in-flight review before the action ignored the comment. A
    # comment run queues instead. A push never waits: it cancels whatever is
    # running, a forced comment run included, because the head it reviewed
    # is gone (comment again on the new head).
    #
    # GitHub keeps one PENDING run per group, and a newer run replaces it. So
    # a comment enters the pull request's group only when it starts with
    # /pr-hero review AND GitHub associates its author with the repository
    # as OWNER, MEMBER or COLLABORATOR; every other comment gets its own
    # group. Without that, anyone who can comment could replace a
    # maintainer's queued review with a run the action then refuses. The job
    # \`if:\` above does NOT check the association: a writer GitHub reports
    # under another one (a private org member shown as CONTRIBUTOR) still
    # runs, because the action checks the real permission, just in its own
    # group. KNOWN GAP: an associated author's later comment (a writer's
    # near-miss or second real command, or a read-only member's or
    # collaborator's refused one) still replaces a comment run waiting
    # behind a running review, and \`--full\` followed by a plain
    # \`/pr-hero review\` loses the \`--full\`; comment again to recover. A
    # writer reported under another association runs unserialized, beside
    # any review already running.
    #
    # A fork's push never enters the pull request's group: its job is skipped
    # above, and if a skipped job still claimed the group, the fork author's
    # push would cancel a maintainer's in-flight review of that fork. Every
    # other event gets a unique per-run group for the same reason, so a
    # skipped job can never cancel or replace a review.
    concurrency:
      group: \${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || (startsWith(github.event.comment.body, '/pr-hero review') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))) && format('pr-hero-review-{0}', github.event.pull_request.number || github.event.issue.number) || format('pr-hero-noop-{0}', github.run_id) }}
      cancel-in-progress: \${{ github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    # Backstop for a HUNG runner, not a second review budget. pr-hero already
    # enforces its own 75-minute whole-pipeline ceiling, which closes
    # artifacts and reports before exiting; a CI bound at or below that would
    # kill the job first and throw away the salvage. Above it, this only ever
    # fires when the process is genuinely stuck.
    timeout-minutes: 90
    steps:
${gateStep}      - name: Checkout${checkoutGate}
        uses: actions/checkout@v4
        with:${checkoutRef}
          # fetch-depth: 0 is load-bearing, not cosmetic: pr-hero computes
          # the pull request's diff range and commit ancestry from full git
          # history. actions/checkout's default is a SHALLOW clone, which
          # cannot produce an accurate diff or blame — trimming this line
          # does not fail loudly, it makes reviews silently miss context.
          fetch-depth: 0

      - name: Run pr-hero
        # The id keeps this step's outputs (\`status\`, \`run-dir\`, ...)
        # readable from any step you add below.
        # The action uploads the run directory as an artifact itself, so
        # \`pr-hero triage reply --from\` has an input in CI (see action.yml).
        id: pr-hero${runStepGate}
        uses: ${actionRef}
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}
          # Provide a Claude credential and/or OpenCode auth (never leave every
          # credential blank). Inputs are wired unconditionally: an unset secret
          # or var expands to empty, which the action treats as absent, so
          # leaving the one you do not use in place costs nothing. Deleting the
          # line for the secret you DID set is what breaks — the credential
          # never reaches the action, and it fails to authenticate silently.
          #   ANTHROPIC_API_KEY       — pay-as-you-go key (billed per token via Anthropic Console), or
          #   CLAUDE_CODE_OAUTH_TOKEN — from \`claude setup-token\`: a long-lived
          #     (~1 year) token that draws on your Claude subscription at no
          #     extra API cost. It must come from that command. The session
          #     token \`/login\` leaves in the keychain expires in HOURS and is
          #     kept alive by a refresh token CI does not have, so pasting that
          #     one here yields a secret that works for a day and then breaks
          #     reviews with no signal.
          #   OPENCODE_AUTH_JSON      — whole OpenCode auth.json store
          #   vars.PRHERO_ROUTING     — person-layer routing JSON; quoted so an
          #     unset var is the empty string rather than broken YAML
          anthropic-api-key: \${{ secrets.ANTHROPIC_API_KEY }}
          claude-token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          routing: "\${{ vars.PRHERO_ROUTING }}"
          opencode-auth: \${{ secrets.OPENCODE_AUTH_JSON }}${sizeGateLine}${budgetLine}
`;
}

export interface RunCiSetupOptions {
  cwd?: string;
  force?: boolean;
  exists?: (p: string) => boolean;
}

export type CiSetupResult =
  | { status: "created"; path: string }
  | { status: "overwritten"; path: string }
  | { status: "skipped-existing"; path: string; hint: string };

export async function runCiSetup(
  options: RunCiSetupOptions = {},
): Promise<CiSetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const targetPath = path.join(cwd, CI_WORKFLOW_RELATIVE_PATH);
  const alreadyExisted = exists(targetPath);

  if (alreadyExisted && !options.force) {
    return {
      status: "skipped-existing",
      path: targetPath,
      hint: `${CI_WORKFLOW_RELATIVE_PATH} already exists; pass --force to overwrite it`,
    };
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  // Only this one file. A legacy pr-hero-force.yml next to it is left as it
  // is: it still works, and deleting a file the user may dispatch is not a
  // scaffolder's call (see the header comment).
  await writeFile(targetPath, generateCiWorkflowTemplate());

  return {
    status: alreadyExisted ? "overwritten" : "created",
    path: targetPath,
  };
}

export interface MaterializeCiOpenCodeDataOptions {
  routing?: string;
  opencodeAuth?: string;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

// CI data plane: person-layer routing + 0600 auth.json. HOME must be a real
// directory — empty/unset fails loud with no cwd fallback, because falling
// back would write routing into the checkout (.prhero/config.json), which
// the repo parser rejects. Never log the auth blob; never inject readerFn.
export async function materializeCiOpenCodeData(
  options: MaterializeCiOpenCodeDataOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? "";
  if (home.trim() === "") {
    throw new Error(
      "HOME is empty or unset; refusing to materialize OpenCode CI data",
    );
  }

  const routingRaw = options.routing ?? env.ROUTING_INPUT ?? "";
  const authRaw = options.opencodeAuth ?? env.OPENCODE_AUTH_INPUT ?? "";

  let routingConfig: ReturnType<typeof parseRoutingConfig> | null = null;
  if (routingRaw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(routingRaw);
    } catch (error) {
      throw new Error(
        `CI routing input is not valid JSON: ${(error as Error).message}`,
      );
    }
    routingConfig = parseRoutingConfig(parsed, "~/.prhero/config.json");
    if (routingConfig === undefined) {
      throw new Error("CI routing input must be a JSON object");
    }
  }

  let authBody: string | undefined;
  if (authRaw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(authRaw);
    } catch {
      throw new Error("CI opencode-auth is not valid JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("CI opencode-auth must be a JSON object");
    }
    authBody = authRaw;
  }

  if (routingConfig !== null) {
    const layout = prheroLayout(home);
    await mkdir(layout.dir, { recursive: true });
    await writeFile(
      layout.reviewConfigPath,
      `${JSON.stringify({ routing: routingConfig }, null, 2)}\n`,
    );
  }

  if (authBody !== undefined) {
    const authPath = resolveOpenCodeAuthPath(env, home);
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, authBody, { mode: 0o600 });
    await chmod(authPath, 0o600);
  }
}

if (import.meta.main) {
  try {
    await materializeCiOpenCodeData();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(
      `pr-hero: failed to materialize OpenCode CI data: ${message}\n`,
    );
    process.exit(1);
  }
}
