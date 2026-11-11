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
// This module writes `.github/workflows/crysk.yml` into WHATEVER repo the
// caller points it at (via `crysk setup --ci` / `crysk ci init`); a repo that
// already has the pre-rename `pr-hero.yml` keeps that file, updated in place.
// Pillar 3 Phase 5 (tasks.md 5.2) reuses this SAME function to produce this
// repo's own canonical example workflow (at `crysk.yml`), rather than
// hand-authoring a second copy that could silently drift from what every
// caller of `setup --ci` actually gets — test/packaging.test.ts asserts the
// committed file's bytes equal generateCiWorkflowTemplate()'s output exactly.
//
// That one file is the whole install. It reviews every push and answers a
// `/crysk review` pull request comment, which used to need a second,
// dispatch-only `pr-hero-force.yml`. The action now owns everything the
// workflow used to wire around it: credential detection, the comment's
// parsing and the commenter's permission check, the pull request and head
// resolution, and the run-directory upload. runCiSetup no longer writes a
// force workflow, and it leaves an existing one alone: the skip comment still
// names it for repos scaffolded before the comment trigger, and the action
// keeps the inputs it sets.

import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type CryskSecretsParse,
  chooseOpenCodeSecret,
  cryskSecretsPresence,
  MAX_OPENCODE_PROVIDER_SLOTS,
  OPENCODE_OAUTH_SECRET_PROVIDER,
  opencodeSecretsFor,
  opencodeSecretToken,
  parseCryskSecrets,
} from "#ci/crysk-secrets";
import {
  CREDENTIALS_INPUT_LINE,
  type ErrorClass,
  MODELS_INPUT_LINE,
  type SetupRecord,
} from "#ci/outcome";
import { appendGithubOutput } from "#ci/platform";
import {
  assertPlatformPerson,
  deliverPlatformRepoLayer,
  PlatformConfigError,
  readPlatformConfig,
} from "#ci/platform-config";
import type { ConfigPlan } from "#ci/review-levels";
import {
  OVERRIDE_COMMAND,
  RECHECK_COMMAND,
  REVIEW_COMMAND,
  recordTempPath,
} from "#ci/trigger";
import { resolveRepoRoot } from "#git/git";
import {
  type ModelsConfig,
  modelEntry,
  parseModelName,
  parseModelsConfig,
} from "#model/model-name";
import { parseGlobalConfig, parseLocalConfig } from "#review/preflight";
import { commandForms } from "../brand";
import {
  duplicateWorkflowProblem,
  LEGACY_WORKFLOW_RELATIVE_PATH,
  resolveIgnoreFileName,
  resolveRepoDir,
  resolveWorkflowRelativePath,
  WORKFLOW_RELATIVE_PATH,
} from "../brand-paths";
import { CliError } from "../errors";
import { prheroLayout } from "../home-preflight";
import { parseIgnoreFile } from "../ignore-file";
import { credentialKindForRoute } from "../runner-authority";
import { resolveOpenCodeAuthPath } from "../security/credential-broker";
import {
  type OpenCodeSecretManifestEntry,
  openCodeSecretManifestPath,
  serializeOpenCodeSecretManifest,
} from "../security/opencode-secret-manifest";

// The file a repo with no workflow yet gets. A repo that already has the
// pre-rename `pr-hero.yml` keeps it: use resolveWorkflowRelativePath to find the
// file to act on, and LEGACY_CI_WORKFLOW_RELATIVE_PATH to name that one.
export const CI_WORKFLOW_RELATIVE_PATH = WORKFLOW_RELATIVE_PATH;
export const LEGACY_CI_WORKFLOW_RELATIVE_PATH = LEGACY_WORKFLOW_RELATIVE_PATH;

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
  // the route-derived limit (none on a subscription, 4000 on a metered key;
  // resolveCiSizeLimits) and decides for itself. THIS repo raises it because its
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
  // The files half of the size gate, emitted right after the lines input.
  maxChangedFiles?: string;
  // THIS repo only: on a `/crysk review` comment, the workflow resolves
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
  // S4: the action's `mode` input. Always written (default `gate`), so the
  // scaffolded file names the gate and does not inherit it silently. `advisory`
  // keeps the status green whatever the review finds, as before S4.
  mode?: "gate" | "advisory";
  // U5 (odd/tasks/role-model-routing.md, S8): the only CRYSK_* secrets this
  // workflow passes in the action's `crysk-secrets` input, one line each, with no
  // OpenCode slots and no models or credentials input. Only THIS repo's own
  // workflow sets it; unset, the scaffolded block (E-f F4) names the Claude pair,
  // the OpenAI OAuth record, the OpenCode slots and the two variables.
  cryskSecrets?: readonly string[];
}

export const DEFAULT_CI_ACTION_REF = "cryskai/crysk@v0";

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
//
// `cryskSecrets` names the Claude pair (U5): the action stops a run that passes the
// removed inputs, so this repo's own review passes CRYSK_* secrets. The repository
// must hold them before the PR that brings this file runs its review.
export const OWN_CI_WORKFLOW_OPTIONS: CiWorkflowTemplateOptions = {
  actionRef: "./",
  maxChangedLines: "5000",
  budgetUsd: "0",
  mode: "gate",
  forceEngineFromPr: true,
  cryskSecrets: ["CRYSK_CLAUDE_OAUTH_TOKEN", "CRYSK_CLAUDE_API_KEY"],
};

// The secrets every scaffolded workflow names: the Claude pair and the one OpenCode
// OAuth record the engine reads (OPENCODE_OAUTH_SECRET_PROVIDER), as the platform's
// stub names them. A secret the repository does not have arrives empty.
const SCAFFOLD_FIXED_SECRETS: readonly string[] = [
  "CRYSK_CLAUDE_OAUTH_TOKEN",
  "CRYSK_CLAUDE_API_KEY",
  `CRYSK_OPENCODE_${opencodeSecretToken(OPENCODE_OAUTH_SECRET_PROVIDER)}_OAUTH`,
];

// The repository variable listing the OpenCode providers a scaffolded workflow
// forwards keys for, as a JSON array of secret tokens (["DEEPSEEK"]). `crysk ci init`
// prints the command that sets it.
export const OPENCODE_PROVIDERS_VARIABLE = "CRYSK_OPENCODE_PROVIDERS";

// D2 (odd/tasks/role-model-routing.md L40-L42): slot i forwards
// CRYSK_OPENCODE_<token i>_API_KEY, the token read from the variable above, so a
// new provider needs a variable change, not a workflow edit. With the variable
// unset, or fewer providers than slots, a slot renders as `CRYSK_OPENCODE__API_KEY=`
// (verified on GitHub, run 42559256131), which the intake skips. The `|| '[]'`
// keeps an unset variable valid JSON for fromJSON.
function openCodeSlotLine(index: number): string {
  const token = `fromJSON(vars.${OPENCODE_PROVIDERS_VARIABLE} || '[]')[${index}]`;
  return `CRYSK_OPENCODE_\${{ ${token} }}_API_KEY=\${{ secrets[format('CRYSK_OPENCODE_{0}_API_KEY', ${token})] }}`;
}

// The credential lines of the Run Crysk step's `with:` block. A scaffolded repo
// gets every Claude and OpenCode line plus the models and credentials inputs from
// repository variables (D1, D2); this repo's own workflow names its secrets
// (`cryskSecrets`) and nothing else.
function credentialWithLines(options: CiWorkflowTemplateOptions): string {
  const names = options.cryskSecrets ?? SCAFFOLD_FIXED_SECRETS;
  const lines = [
    ...names.map((name) => `${name}=\${{ secrets.${name} }}`),
    ...(options.cryskSecrets === undefined
      ? Array.from({ length: MAX_OPENCODE_PROVIDER_SLOTS }, (_, i) =>
          openCodeSlotLine(i),
        )
      : []),
  ]
    .map((line) => `            ${line}`)
    .join("\n");
  const block = `          # The Crysk credentials: one CRYSK_* secret per line, each named
          # explicitly (never the whole secrets context, which would hand the
          # action every secret of the repository). A secret the repository does not have
          # arrives empty and counts as absent, so every line stays. With
          # both Claude secrets set, credentials.claude picks one (the subscription first).
          #   CRYSK_CLAUDE_OAUTH_TOKEN — from \`claude setup-token\`: a long-lived
          #     (~1 year) token that draws on your Claude subscription. The
          #     session token \`/login\` leaves in the keychain expires in hours.
          #   CRYSK_CLAUDE_API_KEY     — pay-as-you-go key (billed per token).`;
  if (options.cryskSecrets !== undefined) {
    return `${block}
          crysk-secrets: |
${lines}`;
  }
  return `${block}
          #   CRYSK_OPENCODE_OPENAI_OAUTH — an OpenAI (ChatGPT) subscription for
          #     OpenCode: the openai record of OpenCode's auth.json, base64 on one line.
          #   CRYSK_OPENCODE_<PROVIDER>_API_KEY — an OpenCode provider's API key,
          #     <PROVIDER> being its id uppercased with - and . as _. The ${MAX_OPENCODE_PROVIDER_SLOTS}
          #     lines after the fixed ones forward the providers listed in
          #     vars.${OPENCODE_PROVIDERS_VARIABLE} (a JSON array, e.g. ["DEEPSEEK"]);
          #     an unused line renders as CRYSK_OPENCODE__API_KEY= and is skipped.
          # \`crysk ci init\` prints the commands that set these secrets and variables.
          crysk-secrets: |
${lines}
          # The models per role and the Claude credential order, as JSON, from
          # repository variables. Unset, every role runs the default Claude model
          # and the subscription is tried first.
          ${MODELS_INPUT_LINE}
          ${CREDENTIALS_INPUT_LINE}`;
}

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
  const filesGateLine =
    options.maxChangedFiles === undefined
      ? ""
      : `\n          max-changed-files: ${options.maxChangedFiles}`;
  // S4: always written, never inherited. The gate is what makes a scaffolded
  // repo's pr-hero check red, so the file names it instead of relying on the
  // action's default, and a reader sees the consequence where they edit.
  const modeLine = `\n          mode: ${options.mode ?? "gate"}`;
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
              echo "::error title=crysk::could not verify the commenter's write access: the GitHub API call failed twice, so nothing was reviewed or overridden. Comment /crysk review, /crysk recheck or /crysk override again to retry"
              exit 1
            fi
            sleep 2
          done
          case "$permission" in
            admin|write) ;;
            *)
              echo "::notice title=crysk::only users with write access to this repository can run /crysk review, /crysk recheck or /crysk override"
              echo "proceed=false" >> "$GITHUB_OUTPUT"
              exit 0
              ;;
          esac
          case "$PR" in
            ''|*[!0-9]*)
              echo "::error title=crysk::pr must be a positive integer"
              exit 1
              ;;
          esac
          # One read: the fork verdict and the commit checked out next must
          # describe the same head, even if the branch moves in between.
          pr_head=$(gh pr view "$PR" --repo "$GITHUB_REPOSITORY" --json headRepository,headRefOid --jq '.headRepository.nameWithOwner + " " + .headRefOid')
          head_repo=\${pr_head% *}
          sha=\${pr_head##* }
          if [ "$head_repo" != "$GITHUB_REPOSITORY" ]; then
            echo "::notice title=crysk::fork pull requests are not reviewed here: uses ./ would run the fork's own engine with this repository's secrets"
            echo "proceed=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          # Only a full commit sha may reach checkout: an empty ref makes
          # actions/checkout fall back to the default branch, which is the
          # engine this pin exists to avoid, and any other value would be
          # resolved as a ref name.
          if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
            echo "::error title=crysk::could not resolve the pull request head commit"
            exit 1
          fi
          echo "proceed=true" >> "$GITHUB_OUTPUT"
          echo "sha=$sha" >> "$GITHUB_OUTPUT"

`
    : "";
  // One clause per command and per name, new name first: an Actions expression
  // has no regex, so the legacy /pr-hero forms are listed beside /crysk ones.
  const commandBodies = [
    REVIEW_COMMAND,
    RECHECK_COMMAND,
    OVERRIDE_COMMAND,
  ].flatMap(commandForms);
  const newNamesFirst = [
    ...commandBodies.filter((c) => c.startsWith("/crysk")),
    ...commandBodies.filter((c) => !c.startsWith("/crysk")),
  ];
  const ifCommentClauses = newNamesFirst
    .map(
      (c) =>
        `(github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '${c}'))`,
    )
    .join(" ||\n      ");
  const groupCommentClauses = newNamesFirst
    .map(
      (c) =>
        `(startsWith(github.event.comment.body, '${c}') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))`,
    )
    .join(" || ");
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
  return `# Generated by \`crysk setup --ci\` (or \`crysk ci init\`).
# Customize freely — re-running setup will not overwrite this file again
# unless you pass --force.
#
# This one file is the whole install. It reviews every push to a pull
# request. A pull request comment that is exactly \`/crysk review\` runs the
# review again with the skip gates bypassed, and \`/crysk review --full\`
# also re-discovers the whole range. A comment that is exactly
# \`/crysk override\` turns the gate green on that head with no review and
# no cost, and records who did it. A comment that is exactly
# \`/crysk recheck\` reviews the head and asks the CI adjudicator to rule on
# pending dismissals of blocking findings. The action parses the comment and
# refuses a commenter without write access. The older \`/pr-hero ...\` forms
# of these commands still work for one version.
name: Crysk Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  # GitHub runs a comment-triggered workflow from the DEFAULT branch's copy
  # of this file, never the pull request's. The comment trigger works only
  # once this file is merged there; until then a comment starts nothing.
  issue_comment:
    types: [created]

# pull-requests: write lets Crysk post inline comments and a step summary.
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
    # they could never authenticate. A maintainer comments \`/crysk review\`
    # instead, and that run (base-branch context, with secrets) reviews the
    # fork's head.
    #
    # A comment starts the job only when it BEGINS with \`/crysk review\`,
    # \`/crysk recheck\` or \`/crysk override\` (or the older \`/pr-hero\` forms
    # of the three). The action then requires an exact match after
    # trimming, so a near-miss such as "/crysk review please" starts a job the
    # action ends without reviewing or overriding.
    if: >-
      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) ||
      ${ifCommentClauses}
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
    # /crysk review, /crysk recheck or /crysk override (or the older /pr-hero forms), and GitHub associates its author
    # with the repository as OWNER, MEMBER or COLLABORATOR; every other comment
    # gets its own group. Without that, anyone who can comment could replace a
    # maintainer's queued review with a run the action then refuses. The job
    # \`if:\` above does NOT check the association: a writer GitHub reports
    # under another one (a private org member shown as CONTRIBUTOR) still
    # runs, because the action checks the real permission, just in its own
    # group. KNOWN GAP: an associated author's later comment (a writer's
    # near-miss or second real command, or a read-only member's or
    # collaborator's refused one) still replaces a comment run waiting
    # behind a running review, and \`--full\` followed by a plain
    # \`/crysk review\` loses the \`--full\`; comment again to recover. A
    # writer reported under another association runs unserialized, beside
    # any review already running.
    #
    # A fork's push never enters the pull request's group: its job is skipped
    # above, and if a skipped job still claimed the group, the fork author's
    # push would cancel a maintainer's in-flight review of that fork. Every
    # other event gets a unique per-run group for the same reason, so a
    # skipped job can never cancel or replace a review.
    concurrency:
      group: \${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || ${groupCommentClauses}) && format('pr-hero-review-{0}', github.event.pull_request.number || github.event.issue.number) || format('pr-hero-noop-{0}', github.run_id) }}
      cancel-in-progress: \${{ github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    # Backstop for a HUNG runner, not a second review budget. Crysk already
    # enforces its own 75-minute whole-pipeline ceiling, which closes
    # artifacts and reports before exiting; a CI bound at or below that would
    # kill the job first and throw away the salvage. Above it, this only ever
    # fires when the process is genuinely stuck.
    timeout-minutes: 90
    steps:
${gateStep}      - name: Checkout${checkoutGate}
        uses: actions/checkout@v4
        with:${checkoutRef}
          # fetch-depth: 0 is load-bearing, not cosmetic: Crysk computes
          # the pull request's diff range and commit ancestry from full git
          # history. actions/checkout's default is a SHALLOW clone, which
          # cannot produce an accurate diff or blame — trimming this line
          # does not fail loudly, it makes reviews silently miss context.
          fetch-depth: 0

      - name: Run Crysk
        # The id keeps this step's outputs (\`status\`, \`run-dir\`, ...)
        # readable from any step you add below.
        # The action uploads the run directory as an artifact itself, so
        # \`crysk triage reply --from\` has an input in CI (see action.yml).
        id: pr-hero${runStepGate}
        uses: ${actionRef}
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}
${credentialWithLines(options)}${sizeGateLine}${filesGateLine}${budgetLine}${modeLine}
`;
}

export interface RunCiSetupOptions {
  cwd?: string;
  force?: boolean;
  exists?: (p: string) => boolean;
  // What the person chose in setup --ci; absent keeps the template's defaults.
  template?: Pick<
    CiWorkflowTemplateOptions,
    "mode" | "budgetUsd" | "maxChangedLines" | "maxChangedFiles"
  >;
}

export type CiSetupResult =
  | { status: "created"; path: string }
  | { status: "overwritten"; path: string }
  | { status: "skipped-existing"; path: string; hint: string }
  // Both workflow files exist: writing either would leave two workflows
  // reviewing every pull request, so nothing is written, --force or not.
  | { status: "refused-duplicate"; hint: string };

export async function runCiSetup(
  options: RunCiSetupOptions = {},
): Promise<CiSetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const duplicate = duplicateWorkflowProblem(cwd, exists);
  if (duplicate !== undefined) {
    return { status: "refused-duplicate", hint: duplicate };
  }
  // The file a repo already has is rewritten in place; only a repo with none
  // gets the new name.
  const relativePath = resolveWorkflowRelativePath(cwd, exists);
  const targetPath = path.join(cwd, relativePath);
  const alreadyExisted = exists(targetPath);

  if (alreadyExisted && !options.force) {
    return {
      status: "skipped-existing",
      path: targetPath,
      hint: `${relativePath} already exists; pass --force to overwrite it`,
    };
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  // Only this one file. A legacy pr-hero-force.yml next to it is left as it
  // is: it still works, and deleting a file the user may dispatch is not a
  // scaffolder's call (see the header comment).
  await writeFile(targetPath, generateCiWorkflowTemplate(options.template));

  return {
    status: alreadyExisted ? "overwritten" : "created",
    path: targetPath,
  };
}

// Merges the setup choices into <repo>/.prhero/config.json, keeping every key
// already there. The merged file goes through parseLocalConfig, the parser a
// review reads it with, BEFORE anything is written: a value a review would
// refuse never reaches disk. A file that is not valid JSON is refused, never
// replaced, because replacing it would delete whatever the team wrote there.
export interface RepoReviewConfigWrite {
  file: string;
  // The file as written: what the summary reports as in force.
  config: Record<string, unknown>;
  // Keys that already held a different value and now hold the chosen one.
  changed: { key: string; from: unknown; to: unknown }[];
  // Keys already in the file that nobody chose this run, left untouched, with
  // the value they keep.
  kept: Record<string, unknown>;
}

export async function writeRepoReviewConfig(
  repoRoot: string,
  plan: ConfigPlan,
): Promise<RepoReviewConfigWrite> {
  const file = path.join(resolveRepoDir(repoRoot), "config.json");
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = await readFile(file, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CliError(
        `${file} is not valid JSON (${(error as Error).message}); fix it, then run setup --ci again`,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new CliError(
        `${file} must hold a JSON object; fix it, then run setup --ci again`,
      );
    }
    current = parsed as Record<string, unknown>;
  }
  const next: Record<string, unknown> = { ...current };
  const changed: RepoReviewConfigWrite["changed"] = [];
  const kept: Record<string, unknown> = {};
  // ci_max_reviews is the legacy name of ci_max_attempts: a file that sets it
  // has already decided the pass count, so filling ci_max_attempts would
  // silently override it (resolveCiReviewPolicy reads ci_max_attempts first).
  const has = (key: string): boolean =>
    key in current ||
    (key === "ci_max_attempts" && "ci_max_reviews" in current);
  for (const group of plan.fillIfAbsent) {
    const present = Object.keys(group).filter(has);
    if (present.length === 0) Object.assign(next, group);
    for (const key of present) {
      const fileKey =
        key in current
          ? key
          : key === "ci_max_attempts"
            ? "ci_max_reviews"
            : key;
      kept[fileKey] = current[fileKey];
    }
  }
  // A chosen preset drops the level keys it does not set (and the legacy
  // alias), so switching presets never leaves an orphan behind.
  for (const key of plan.remove) {
    if (key in current) {
      changed.push({ key, from: current[key], to: undefined });
      delete next[key];
    }
  }
  for (const [key, value] of Object.entries(plan.set)) {
    if (
      key in current &&
      JSON.stringify(current[key]) !== JSON.stringify(value)
    ) {
      changed.push({ key, from: current[key], to: value });
    }
    next[key] = value;
  }
  const body = `${JSON.stringify(next, null, 2)}\n`;
  parseLocalConfig(body);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return { file, config: next, changed, kept };
}

// Why these .prheroignore patterns would be refused, or undefined when they
// parse. Asked before anything is written, so a bad pattern stops setup with
// the repository unchanged instead of halfway through.
// `existing` is the current .prheroignore text: the file is parsed whole after
// the append, so a line already broken there must stop setup here too.
export function ignorePatternsError(
  patterns: readonly string[],
  existing = "",
): string | undefined {
  if (patterns.length === 0) return undefined;
  try {
    parseIgnoreFile(`${existing}\n${patterns.join("\n")}\n`, "user");
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

// Appends exclusion patterns to <repo>/.prheroignore, skipping lines already
// there. Validated with the same parser a review uses, before writing.
export async function appendIgnorePatterns(
  repoRoot: string,
  patterns: readonly string[],
): Promise<string> {
  const file = path.join(repoRoot, resolveIgnoreFileName(repoRoot));
  const current = existsSync(file) ? await readFile(file, "utf-8") : "";
  const present = new Set(current.split("\n").map((line) => line.trim()));
  const added = patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !present.has(p));
  if (added.length === 0) return file;
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  const body = `${current}${prefix}${added.join("\n")}\n`;
  parseIgnoreFile(body, "user");
  await writeFile(file, body);
  return file;
}

export interface MaterializeCiOpenCodeDataOptions {
  // E-f F3 (D1): the `models` and `credentials` inputs, raw JSON text, which a
  // standalone workflow fills from vars.CRYSK_MODELS and vars.CRYSK_CREDENTIALS.
  // Read with the engine's person parser and written as the personal file,
  // unless a platform person layer exists, which wins whole.
  modelsInput?: string;
  credentialsInput?: string;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  // Platform mode: the person layer the Crysk platform returned (`{}` when it
  // sent none), written as the personal file. Present means platform mode, in which the
  // personal file belongs to this run: a file an earlier run left behind is
  // removed when nothing is to be written, so it can never be read as this run's
  // person layer on a runner whose HOME outlives the job.
  platformPerson?: Record<string, unknown>;
  // U3: the parsed `crysk-secrets` input, when it was given. Its CRYSK_OPENCODE_*
  // secrets build the OpenCode auth file for the providers the models in effect
  // name.
  cryskSecrets?: CryskSecretsParse;
}

export interface MaterializeCiOpenCodeDataResult {
  // Notices for the job log: names and provider ids only, never a value.
  readonly notices: readonly string[];
  // Warnings for the job log, the same rule: the inputs a platform layer overrode.
  readonly warnings: readonly string[];
  // Whether this step wrote the OpenCode auth file from the CRYSK_OPENCODE_*
  // secrets for the providers the models name. The Install OpenCode CLI step
  // runs then (U5).
  readonly openCodeAuthWritten: boolean;
  // Whether the models in effect, the platform's or the inputs', run an
  // OpenCode model (the judge's entries aside). The Install OpenCode CLI step
  // runs then too, so a free model with no credential still gets the CLI.
  readonly openCodeModels: boolean;
}

// The file the publisher reads when this step fails on a malformed input, and
// the outcome directory the workflow binds for it (odd/tasks/agent-first-ci.md, A1).
const SETUP_RECORD_FILE = "setup.json";
const AUTH_CLASS: ErrorClass = {
  kind: "credential",
  failureClass: "malformed_payload",
};
// The models and credentials inputs (D1): CRYSK-CONFIG-INVALID's `models-input`
// and `credentials-input` variants, each naming its own input and variable. Their
// details name the input and never its content (the
// variable may hold anything, a pasted key included), so the publisher can put
// them on the PR. The parser's own message, which names the entry, goes to the
// step's log only, through F2's redaction; a JSON syntax error's text is never
// printed, since it can quote the input.
const INPUT_CLASS: Record<"models" | "credentials", ErrorClass> = {
  models: { kind: "config-parse", source: "models-input" },
  credentials: { kind: "config-parse", source: "credentials-input" },
};
const INPUTS_IGNORED_WARNING =
  "The models and credentials inputs are ignored: this repository is connected to the Crysk platform, whose model settings apply.";

// A crysk-secrets, models or credentials input the user configured wrongly. `message` is the
// line stderr has always printed; `cls` and `detail` are what the record carries.
class SetupInputError extends Error {
  readonly cls: ErrorClass;
  readonly detail: string;

  constructor(cls: ErrorClass, detail: string, message: string) {
    super(message);
    this.name = "SetupInputError";
    this.cls = cls;
    this.detail = detail;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

// One owner-only write for every credential file this step leaves: the mode on
// create, and again by chmod, since an existing file keeps its old mode through
// writeFile.
async function writeOwnerOnlyFile(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, { mode: 0o600 });
  await chmod(file, 0o600);
}

// The OpenCode providers the person layer's models name, every role and every
// fallback, sorted. The judge is skipped: it runs only claude: models (L6 item 5),
// so an opencode: entry there is dropped and never reaches the plan. `default` is
// counted even when every role overrides it (a record nobody reads costs nothing).
// Read through parseModelsConfig, the engine's own parser, so a change to the
// shape of a list entry (E-g) is a type error here, never a silent skip. Models
// that do not parse yield none; assertPlatformPerson and readConfigInput refuse
// them by name before this runs.
export function openCodeProvidersOfModels(models: unknown): string[] {
  if (models === undefined) return [];
  let config: ModelsConfig;
  try {
    config = parseModelsConfig(models);
  } catch {
    return [];
  }
  const providers = new Set<string>();
  for (const [role, list] of Object.entries(config)) {
    if (role === "judge") continue;
    for (const entry of list) {
      const parsed = parseModelName(modelEntry(entry).name);
      if (parsed.backend === "opencode") providers.add(parsed.provider);
    }
  }
  return [...providers].sort();
}

// Whether an OpenCode route this run can take bills per token (cryskai/platform#12
// item 5): an auth file exists AND some provider the run can route to binds an
// API key, by the same rule the run binds it with (credentialKindForRoute over the
// secret manifest's names, the provider literal without one). The providers come
// from `models` (every role and fallback) and from `routeModels`, every other
// source a step's route can come from: `--model`, a spec agent's model or
// diversity legs, and a prompt's own frontmatter model (routing.ts,
// resolveStepChoices). A source a step does not end up using can only make the
// run read as metered, the side that keeps the ceiling. The file alone is not
// enough: it also exists for a ChatGPT subscription, after an earlier run on a
// runner whose HOME persists, or from a local `opencode auth login`. And no file
// means no credential for a per-token route, as before: a free `opencode/*` model
// stays unmetered.
export function openCodeModelsBillMetered(input: {
  models: unknown;
  routeModels?: readonly (string | undefined)[];
  authFilePresent: boolean;
  openCodeSecretNames: readonly string[] | undefined;
}): boolean {
  if (!input.authFilePresent) return false;
  const providers = new Set(openCodeProvidersOfModels(input.models));
  for (const raw of input.routeModels ?? []) {
    if (raw === undefined) continue;
    let parsed: ReturnType<typeof parseModelName>;
    try {
      parsed = parseModelName(raw);
    } catch {
      // A bare alias (`sonnet`) is the legacy Claude form; routing converts it to
      // `claude:<alias>-latest`, never to an OpenCode route.
      continue;
    }
    if (parsed.backend === "opencode") providers.add(parsed.provider);
  }
  return [...providers].some(
    (provider) =>
      credentialKindForRoute(
        "opencode",
        provider,
        {},
        false,
        input.openCodeSecretNames,
      ) === "provider_api_token",
  );
}

interface OpenCodeAuthAssembly {
  // provider id -> its auth.json record.
  readonly records: Record<string, Record<string, unknown>>;
  readonly manifest: OpenCodeSecretManifestEntry[];
  readonly notices: string[];
  readonly problems: string[];
}

// U3 (S8/S9, L12 "Building auth.json"): the OpenCode auth file from the
// CRYSK_OPENCODE_* secrets, one record per provider the models name. Which
// secret serves a provider is chooseOpenCodeSecret, the rule credentialKindForRoute
// applies to the manifest's names in the run, so the record and the bound kind
// agree. `_API_KEY` becomes OpenCode's own API record; `_OAUTH` is the provider's
// login record kept whole, refresh token included, so the child can renew it.
function assembleOpenCodeAuth(
  parse: CryskSecretsParse,
  providers: readonly string[],
): OpenCodeAuthAssembly {
  const records: Record<string, Record<string, unknown>> = {};
  const manifest: OpenCodeSecretManifestEntry[] = [];
  const notices: string[] = [];
  const problems: string[] = [];
  const missing: string[] = [];
  for (const provider of providers) {
    const choice = chooseOpenCodeSecret(provider, parse.names);
    if (choice === undefined) {
      const token = opencodeSecretToken(provider);
      missing.push(
        token === undefined
          ? `OpenCode provider ${provider}: no CRYSK_OPENCODE_* secret name can carry this provider id, so the auth file has no record for it.`
          : `OpenCode provider ${provider}: no CRYSK_OPENCODE_${token}_API_KEY or CRYSK_OPENCODE_${token}_OAUTH secret is set, so the auth file has no record for it.`,
      );
      continue;
    }
    if (choice.kind === undefined) {
      problems.push(choice.problem);
      continue;
    }
    const secrets = opencodeSecretsFor(parse.secrets, provider);
    if (choice.kind === "oauth" && secrets?.oauth !== undefined) {
      records[provider] = { ...secrets.oauth };
    } else if (choice.kind === "api_key" && secrets?.apiKey !== undefined) {
      records[provider] = { type: "api", key: secrets.apiKey };
    } else {
      // The names and the values come from one parse, so this cannot happen.
      continue;
    }
    manifest.push({
      provider,
      secret: choice.secret,
      kind: choice.kind,
      ...(choice.unused === undefined ? {} : { unused: choice.unused }),
    });
    const label = choice.kind === "oauth" ? "subscription" : "API key";
    notices.push(
      choice.unused === undefined
        ? `OpenCode provider ${provider}: ${choice.secret} (${label}) builds its auth record.`
        : `OpenCode provider ${provider}: ${choice.secret} (${label}) builds its auth record; ${choice.unused} is not used, because the subscription comes first.`,
    );
  }
  // A provider with no secret is named whenever the crysk-secrets input was given,
  // also when no provider got a record and this step writes no auth file: a metered
  // model of that provider is then refused at admission (openCodeCredentialRefusal,
  // production-runtime.ts), and this line says why in the setup step. A notice, not a
  // failure: a free model of that provider runs with no record.
  notices.push(...missing);
  return { records, manifest, notices, problems };
}

// One of the two inputs (D1), read the way the person parser reads that key in
// ~/.crysk/config.json: the value is the key's own object, checked under that
// key alone. Returns undefined for an empty input.
function readConfigInput(
  raw: string | undefined,
  key: "models" | "credentials",
): unknown {
  if (raw === undefined || raw.trim() === "") return undefined;
  const label = `the ${key} input`;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SetupInputError(
      INPUT_CLASS[key],
      `${label} is not valid JSON`,
      `CI ${key} input is not valid JSON`,
    );
  }
  try {
    parseGlobalConfig(JSON.stringify({ [key]: value }), label);
  } catch (error) {
    throw new SetupInputError(
      INPUT_CLASS[key],
      `${label} does not follow the ${key} rules (the setup step's log names the entry)`,
      messageOf(error),
    );
  }
  return value;
}

// CI data plane: the person layer + 0600 auth.json. HOME must be a real
// directory — empty/unset fails loud with no cwd fallback, because falling
// back would write person keys into the checkout (.prhero/config.json), which
// the repo parser rejects. Never log the auth blob; never inject readerFn.
//
// The person layer in effect (D1): the platform's when it sent one, whole, with
// the models and credentials inputs ignored and a warning; otherwise the inputs,
// read with the person parser before anything is written. The `routing` and
// `opencode-auth` inputs are gone (S2, D6): the trigger stops a workflow that
// passes either, and this step does not read them.
//
// U3: the CRYSK_OPENCODE_* secrets build auth.json for the providers the models
// in effect name. A manifest beside it names the secret behind each record, for
// the run's credential kind. When they serve none, a manifest an earlier run left
// is removed, so it never describes a file it did not build, and an auth file
// already on the runner (a self-hosted runner's own) is left alone.
export async function materializeCiOpenCodeData(
  options: MaterializeCiOpenCodeDataOptions = {},
): Promise<MaterializeCiOpenCodeDataResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? "";
  if (home.trim() === "") {
    throw new Error(
      "HOME is empty or unset; refusing to materialize OpenCode CI data",
    );
  }

  const platformMode = options.platformPerson !== undefined;
  const platformPerson = options.platformPerson ?? {};
  const platformLayer = Object.keys(platformPerson).length > 0;
  const personFile = prheroLayout(home).reviewConfigPath;

  const warnings: string[] = [];
  let personBody: Record<string, unknown>;
  if (platformLayer) {
    // Validated whole by the engine's person parser before anything is written.
    assertPlatformPerson(platformPerson, personFile);
    personBody = { ...platformPerson };
    // The inputs are not even read: a value the platform overrides is not this
    // run's configuration, so a malformed one must not fail it.
    const inputGiven = [options.modelsInput, options.credentialsInput].some(
      (raw) => raw !== undefined && raw.trim() !== "",
    );
    if (inputGiven) warnings.push(INPUTS_IGNORED_WARNING);
  } else {
    const models = readConfigInput(options.modelsInput, "models");
    const credentials = readConfigInput(
      options.credentialsInput,
      "credentials",
    );
    personBody = {
      ...(models === undefined ? {} : { models }),
      ...(credentials === undefined ? {} : { credentials }),
    };
  }

  const providers = openCodeProvidersOfModels(personBody.models);
  const notices: string[] = [];
  const assembly =
    options.cryskSecrets === undefined
      ? undefined
      : assembleOpenCodeAuth(options.cryskSecrets, providers);
  if (assembly !== undefined && assembly.problems.length > 0) {
    const detail = assembly.problems.join("; ");
    throw new SetupInputError(
      AUTH_CLASS,
      detail,
      `CI crysk-secrets input: ${detail}`,
    );
  }
  const fromSecrets =
    assembly !== undefined && assembly.manifest.length > 0
      ? assembly
      : undefined;
  // Also when no record was built: the notices then name only the providers with no
  // secret (assembleOpenCodeAuth).
  if (assembly !== undefined) notices.push(...assembly.notices);

  if (Object.keys(personBody).length > 0) {
    await mkdir(path.dirname(personFile), { recursive: true });
    await writeFile(personFile, `${JSON.stringify(personBody, null, 2)}\n`);
  } else if (platformMode) {
    await rm(personFile, { force: true });
  }

  const authPath = resolveOpenCodeAuthPath(env, home);
  const manifestPath = openCodeSecretManifestPath(authPath);
  if (fromSecrets !== undefined) {
    await writeOwnerOnlyFile(
      authPath,
      `${JSON.stringify(fromSecrets.records, null, 2)}\n`,
    );
    await writeOwnerOnlyFile(
      manifestPath,
      serializeOpenCodeSecretManifest(fromSecrets.manifest),
    );
  } else {
    await rm(manifestPath, { force: true });
  }
  return {
    notices,
    warnings,
    openCodeAuthWritten: fromSecrets !== undefined,
    openCodeModels: providers.length > 0,
  };
}

// The env variable action.yml binds the `crysk-secrets` input to, in this step
// only, for its shell. The shell pipes it to this script on stdin (the flag
// below) and runs bun with the variable emptied, so it never enters this
// process's environment. WHY not read it here and `delete process.env[...]`:
// Bun.spawn without an explicit `env` (git's, on the platform path) gives the
// child the environment the process STARTED with, so a deleted variable still
// reaches it (probed on Bun 1.4.4). A non-empty variable here means the step was
// wired wrongly, and the script refuses to run.
const CRYSK_SECRETS_ENV = "CRYSK_SECRETS_INPUT";
const CRYSK_SECRETS_STDIN_FLAG = "--crysk-secrets-stdin";

interface CiOpenCodeSetupDeps {
  env: Readonly<Record<string, string | undefined>>;
  // The `crysk-secrets` input, already removed from `env` and process.env.
  cryskSecrets: string;
  // Workflow commands (`::add-mask::`) go here, the way platform.ts emits them.
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // Where the checkout is (the engine resolves its operator root from here).
  cwd: string;
  appendOutput: (text: string) => void;
}

// Workflow-command data escaping, as the runner's own toolkit does it.
function escapeCommandData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

// Platform mode only (the connect step announced a config file): the repo layer
// the platform sent reaches the run step as the `repo-config` output, which it
// passes as `--config`, but ONLY when the checkout has no repo config of its own.
// Returns whether the layer it delivered sets `post`.
async function deliverPlatformRepo(
  deps: CiOpenCodeSetupDeps,
  platformFile: string,
  repo: Record<string, unknown>,
): Promise<boolean> {
  if (Object.keys(repo).length === 0) return false;
  let root: string;
  try {
    root = await resolveRepoRoot(deps.cwd);
  } catch (error) {
    throw new PlatformConfigError(
      `the checked-out repository could not be found to decide whether it has its own config: ${messageOf(error)}`,
    );
  }
  const result = await deliverPlatformRepoLayer({
    repo,
    root,
    dir: path.dirname(platformFile),
  });
  if (result.status === "repo-file-wins") {
    deps.stderr(
      `::notice::${escapeCommandData(`Crysk platform config: this repository has its own ${path.relative(root, result.file)}, so it is used as is and the platform's repository settings are ignored.`)}\n`,
    );
  } else if (result.status === "written") {
    deps.appendOutput(`repo-config=${result.file}\n`);
    return repo.post !== undefined;
  }
  return false;
}

// WHY tmp then rename, the same as the trigger's record: the publisher reads the
// file in a later step and must never see a half-written one.
async function writeSetupRecord(
  dir: string,
  record: SetupRecord,
): Promise<void> {
  const finalPath = path.join(dir, SETUP_RECORD_FILE);
  // The temp name is unique per write (recordTempPath), so a stale file an earlier job
  // left at the fixed name cannot make this record's write fail (F003 on #330).
  const tempPath = recordTempPath(finalPath);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(record)}\n`);
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// The `crysk-secrets` input (S8, L13). Every value is masked before this step
// writes anything else, a refused input fails the step with a setup record,
// and later steps learn only which credentials exist: names, Claude
// kinds and OpenCode provider tokens, never a value, and never GITHUB_ENV.
// Empty input: nothing is printed or written, exactly as before the input
// existed. The OpenCode secrets build the auth file (U3, materializeCiOpenCodeData);
// the Claude ones are not read here yet (U5).
function intakeCryskSecrets(
  deps: CiOpenCodeSetupDeps,
): CryskSecretsParse | undefined {
  if (deps.cryskSecrets.trim() === "") return undefined;
  const parsed = parseCryskSecrets(deps.cryskSecrets);
  for (const value of parsed.masks) {
    deps.stdout(`::add-mask::${escapeCommandData(value)}\n`);
  }
  for (const notice of parsed.notices) {
    deps.stderr(`::notice::${escapeCommandData(notice)}\n`);
  }
  if (parsed.problems.length > 0) {
    const detail = parsed.problems.join("; ");
    throw new SetupInputError(
      AUTH_CLASS,
      detail,
      `CI crysk-secrets input: ${detail}`,
    );
  }
  const presence = cryskSecretsPresence(parsed);
  deps.appendOutput(
    `crysk-secrets=${presence.names.join(",")}\n` +
      `claude-credentials=${presence.claude.join(",")}\n` +
      `opencode-providers=${presence.opencodeProviders.join(",")}\n`,
  );
  return parsed;
}

// The step's whole job. Returns the exit code. A malformed secrets, models or
// credentials input is the user's configuration, so it also leaves setup.json for the publisher;
// any other failure (HOME, a write) stays unclassified, with no record.
async function runCiOpenCodeSetup(deps: CiOpenCodeSetupDeps): Promise<number> {
  try {
    const cryskSecrets = intakeCryskSecrets(deps);
    const platformFile = deps.env.CRYSK_PLATFORM_CONFIG_FILE ?? "";
    const platform =
      platformFile === "" ? undefined : readPlatformConfig(platformFile);
    // The connect step announces a config file only when the platform sent
    // configuration, so a connected run with none is told apart by this
    // presence boolean: it still owns the personal file (see the option).
    const platformMode =
      platform !== undefined || deps.env.CRYSK_PLATFORM_CONNECTED === "true";
    const materialized = await materializeCiOpenCodeData({
      env: deps.env,
      modelsInput: deps.env.MODELS_INPUT ?? "",
      credentialsInput: deps.env.CREDENTIALS_INPUT ?? "",
      ...(platformMode ? { platformPerson: platform?.person ?? {} } : {}),
      ...(cryskSecrets === undefined ? {} : { cryskSecrets }),
    });
    for (const warning of materialized.warnings) {
      deps.stderr(`::warning::${escapeCommandData(warning)}\n`);
    }
    for (const notice of materialized.notices) {
      deps.stderr(`::notice::${escapeCommandData(notice)}\n`);
    }
    // Presence only: the Install OpenCode CLI step keys on these, so the CLI is
    // installed when an OpenCode credential the run can use was written, or when
    // the models in effect run an OpenCode model (a free one needs none).
    if (materialized.openCodeAuthWritten) {
      deps.appendOutput("opencode-auth-file=true\n");
    }
    if (materialized.openCodeModels) {
      deps.appendOutput("opencode-models=true\n");
    }
    // WHY the run step needs to know: it passes `--post` whenever the `post`
    // input is true (the default), and an explicit CLI option outranks the
    // config, so a `post` the platform set would never take effect.
    let postFromPlatform = platform?.person.post !== undefined;
    if (platform !== undefined) {
      const repoPost = await deliverPlatformRepo(
        deps,
        platformFile,
        platform.repo,
      );
      postFromPlatform ||= repoPost;
    }
    if (postFromPlatform) deps.appendOutput("post-from-platform=true\n");
    return 0;
  } catch (error) {
    deps.stderr(
      `crysk: failed to materialize OpenCode CI data: ${messageOf(error)}\n`,
    );
    if (error instanceof PlatformConfigError) {
      deps.stderr(
        `::error::${escapeCommandData(`Crysk platform mode failed: ${messageOf(error)}`)}\n`,
      );
    }
    const outcomeDir = deps.env.CRYSK_OUTCOME_DIR ?? "";
    if (error instanceof SetupInputError && outcomeDir !== "") {
      try {
        await writeSetupRecord(outcomeDir, {
          v: 1,
          cls: error.cls,
          detail: error.detail,
        });
      } catch {
        deps.stderr(
          "crysk: could not write its setup outcome record, so the publisher reports this as an install failure.\n",
        );
      }
    }
    return 1;
  }
}

if (import.meta.main) {
  if ((process.env[CRYSK_SECRETS_ENV] ?? "") !== "") {
    process.stderr.write(
      `crysk: the crysk-secrets input reached setup.ts through its environment, which every child it spawns would inherit; pipe it on stdin with ${CRYSK_SECRETS_STDIN_FLAG} and run bun with ${CRYSK_SECRETS_ENV} empty.\n`,
    );
    process.exit(1);
  }
  const cryskSecrets = process.argv.includes(CRYSK_SECRETS_STDIN_FLAG)
    ? await Bun.stdin.text()
    : "";
  process.exit(
    await runCiOpenCodeSetup({
      env: process.env,
      cryskSecrets,
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
      cwd: process.cwd(),
      appendOutput: (text) =>
        appendGithubOutput(process.env.GITHUB_OUTPUT, text),
    }),
  );
}
