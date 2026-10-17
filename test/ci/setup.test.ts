// Phase 4 (Pillar 3, ROADMAP THE LAUNCH LINE): CI workflow scaffolding +
// doctor CI diagnostics.
//
// Offline only: generateCiWorkflowTemplate is pure and asserted with Bun's
// built-in YAML parser (Bun.YAML.parse — no new dependency); runCiSetup
// touches only an mkdtemp fixture, the same pattern test/ci/reporter.test.ts
// uses for its impure edge functions; doctor's CI check is exercised through
// fully injected exists/env, never real process.env, network, or spawn.

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CI_WORKFLOW_RELATIVE_PATH,
  generateCiWorkflowTemplate,
  materializeCiOpenCodeData,
  OWN_CI_WORKFLOW_OPTIONS,
  runCiSetup,
} from "#ci/setup";
import { DEFAULT_PIPELINE_TIMEOUT_MS } from "#review/pipeline";
import {
  parseArgs,
  parseGlobalConfig,
  parseLocalConfig,
} from "#review/preflight";
import { runDoctor } from "../../src/doctor";
import { prheroLayout } from "../../src/home-preflight";
import { resolveOpenCodeAuthPath } from "../../src/security/credential-broker";
import { checkCiConfiguration } from "../../src/system-tools";

const OPENCODE_CI_ROUTING = JSON.stringify({
  default: {
    backend: "opencode",
    provider: "deepseek",
  },
});

const OPENCODE_CI_AUTH = JSON.stringify({
  deepseek: { type: "api", key: "oc-ci-fixture-not-a-secret" },
});

type WorkflowStep = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type ParsedWorkflow = {
  on: Record<string, { types?: string[] } | undefined>;
  concurrency?: unknown;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    | {
        if?: string;
        concurrency?: unknown;
        "timeout-minutes"?: number;
        steps?: WorkflowStep[];
      }
    | undefined
  >;
};

const parseWorkflow = (template: string) =>
  Bun.YAML.parse(template) as ParsedWorkflow;

const workflowSteps = (template: string): WorkflowStep[] =>
  parseWorkflow(template).jobs.review?.steps ?? [];

const scaffolded = () => generateCiWorkflowTemplate();
const own = () => generateCiWorkflowTemplate(OWN_CI_WORKFLOW_OPTIONS);

// The exact job-level group and cancel rule. Spelled out in full because
// every clause is load-bearing; see the template's own comments for why.
const WRITER_ASSOCIATION = `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)`;
// T6 (S8): the group also admits `/pr-hero override` from the same associations, so
// an override queues behind an in-flight review and lands last.
const REVIEW_CONCURRENCY_GROUP = `\${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || (startsWith(github.event.comment.body, '/pr-hero review') && ${WRITER_ASSOCIATION}) || (startsWith(github.event.comment.body, '/pr-hero recheck') && ${WRITER_ASSOCIATION}) || (startsWith(github.event.comment.body, '/pr-hero override') && ${WRITER_ASSOCIATION})) && format('pr-hero-review-{0}', github.event.pull_request.number || github.event.issue.number) || format('pr-hero-noop-{0}', github.run_id) }}`;
const PUSH_ONLY_CANCEL = `\${{ github.event_name == 'pull_request' }}`;

describe("generateCiWorkflowTemplate (pure)", () => {
  test("produces syntactically valid YAML", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate());
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
  });

  test("triggers on pull_request opened/synchronize/reopened", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      on: { pull_request: { types: string[] } };
    };
    expect(parsed.on.pull_request.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
    ]);
  });

  // A `/pr-hero review` comment is how a person or an agent asks for a
  // review CI skipped. That used to be a second, dispatch-only workflow
  // (pr-hero-force.yml); one file now listens for both events, and the
  // action parses the comment and checks who wrote it.
  test("listens for new comments, and never for a dispatch", () => {
    const template = generateCiWorkflowTemplate();
    expect(parseWorkflow(template).on.issue_comment?.types).toEqual([
      "created",
    ]);
    expect(template).not.toContain("workflow_dispatch:");
  });

  // Threat matrix RED (6): a job-level `if` cannot read `secrets` (S11/S12),
  // so credential presence is the action's to detect, loudly, inside the
  // run. The `if` only routes events. Fork pull_request runs never receive
  // secrets, so they are skipped here; a maintainer's comment reviews them.
  test("the review job skips fork pushes, starts only on a `/pr-hero review`, `/pr-hero recheck` or `/pr-hero override` comment, and never reads secrets", () => {
    const reviewIf = String(
      parseWorkflow(generateCiWorkflowTemplate()).jobs.review?.if ?? "",
    );
    expect(reviewIf).toBe(
      "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || " +
        "(github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/pr-hero review')) || " +
        "(github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/pr-hero recheck')) || " +
        "(github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/pr-hero override'))",
    );
    expect(reviewIf).not.toContain("secrets.");
  });

  // A workflow-level group keyed on `head_ref || ref` put every comment on
  // every pull request into ONE group (head_ref is empty on issue_comment),
  // so any comment anywhere could cancel any in-flight review.
  test.each([
    ["scaffolded", scaffolded],
    ["this repo's own", own],
  ])(
    "the %s workflow's concurrency is per job and per pull request, and only a push cancels",
    (_label, template) => {
      const parsed = parseWorkflow(template());
      expect(parsed.concurrency).toBeUndefined();
      expect(parsed.jobs.review?.concurrency).toEqual({
        group: REVIEW_CONCURRENCY_GROUP,
        "cancel-in-progress": PUSH_ONLY_CANCEL,
      });
    },
  );

  // GitHub keeps one PENDING run per group and a newer run replaces it, so
  // whoever can enter the pull request's group can cancel a maintainer's
  // queued `/pr-hero review`. Only a comment from an associated author may;
  // the job `if:` stays association-free, so a writer GitHub reports under
  // another association still runs (the action checks the real permission),
  // in its own group.
  test("only an OWNER, MEMBER or COLLABORATOR comment can enter the pull request's group", () => {
    const parsed = parseWorkflow(scaffolded());
    const group = String(
      (parsed.jobs.review?.concurrency as { group?: unknown } | undefined)
        ?.group ?? "",
    );
    expect(group).toContain(
      `(startsWith(github.event.comment.body, '/pr-hero review') && ${WRITER_ASSOCIATION})`,
    );
    expect(String(parsed.jobs.review?.if ?? "")).not.toContain(
      "author_association",
    );
  });

  // S8: an override from an author GitHub does not associate with the repository
  // gets its own group, exactly as a review does, so it cannot replace a
  // maintainer's queued review.
  test("an override comment joins the pull request's group only from an OWNER, MEMBER or COLLABORATOR", () => {
    const group = String(
      (
        parseWorkflow(scaffolded()).jobs.review?.concurrency as
          | { group?: unknown }
          | undefined
      )?.group ?? "",
    );
    expect(group).toContain(
      `(startsWith(github.event.comment.body, '/pr-hero override') && ${WRITER_ASSOCIATION})`,
    );
  });

  test("the docs' workflow snippet carries the generator's exact concurrency group", () => {
    const docs = readFileSync(
      path.resolve(import.meta.dir, "../../docs/github-actions.md"),
      "utf-8",
    );
    expect(docs).toContain(`\n      group: ${REVIEW_CONCURRENCY_GROUP}\n`);
  });

  // A copy-pasted docs workflow must admit the same comments the generator does. The
  // job `if:` is compared as parsed YAML, so the folded scalar's layout cannot hide a
  // missing `/pr-hero override` clause.
  test("the docs' workflow snippet admits the same comments as the generator's job", () => {
    const docs = readFileSync(
      path.resolve(import.meta.dir, "../../docs/github-actions.md"),
      "utf-8",
    );
    const workflowSection = docs.slice(
      docs.indexOf("## What the workflow does"),
    );
    const snippet = /```yaml\n([\s\S]*?)\n```/.exec(workflowSection)?.[1] ?? "";
    expect(snippet).toContain("name: pr-hero Review");
    const generatedIf = String(
      parseWorkflow(generateCiWorkflowTemplate()).jobs.review?.if ?? "",
    );
    expect(generatedIf).toContain(
      "startsWith(github.event.comment.body, '/pr-hero override')",
    );
    expect(String(parseWorkflow(snippet).jobs.review?.if ?? "")).toBe(
      generatedIf,
    );
  });

  test("there is exactly one job, so its bound is the whole workflow's bound", () => {
    // The old `credentials` gate job needed its own bound: it ran FIRST and
    // gated `review` through `needs:`, so a runner hung there inherited
    // GitHub's 360-minute default. With the gate inside the action there is
    // no second job left to hang.
    expect(
      Object.keys(parseWorkflow(generateCiWorkflowTemplate()).jobs),
    ).toEqual(["review"]);
  });

  // The action resolves the pull request, the head and the force/full
  // request from the event itself. Those inputs stay declared only for
  // workflows scaffolded before the comment trigger (pr-hero-force.yml).
  test.each([
    ["scaffolded", scaffolded],
    ["this repo's own", own],
  ])(
    "the %s workflow hands the action no pr-number, force or full",
    (_label, template) => {
      const run = workflowSteps(template()).find((s) => s.id === "pr-hero");
      expect(run).toBeDefined();
      const keys = Object.keys(run?.with ?? {});
      expect(keys).not.toContain("pr-number");
      expect(keys).not.toContain("force");
      expect(keys).not.toContain("full");
    },
  );

  test("credential detection and the run-directory upload live in the action, not here", () => {
    const template = generateCiWorkflowTemplate();
    expect(parseWorkflow(template).jobs.credentials).toBeUndefined();
    expect(template).not.toContain("has_creds");
    const uses = workflowSteps(template).map((step) => String(step.uses ?? ""));
    expect(uses.some((u) => u.startsWith("actions/upload-artifact@"))).toBe(
      false,
    );
    expect(template).toMatch(/action uploads the run directory/i);
  });

  test("explains the comment trigger's constraints, not merely that it exists", () => {
    const template = generateCiWorkflowTemplate();
    // GitHub reads a comment-triggered workflow from the default branch.
    expect(template).toMatch(/default branch/i);
    // Why the group is not keyed on the branch.
    expect(template).toContain("head_ref");
    // Why a comment run queues instead of cancelling.
    expect(template).toMatch(/near-miss/i);
  });

  test("grants pull-requests: write and contents: read", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      permissions: Record<string, string>;
    };
    expect(parsed.permissions["pull-requests"]).toBe("write");
    expect(parsed.permissions.contents).toBe("read");
  });

  // The CI admission gate lists this workflow's past runs (gh run list) to
  // build its attempt ledger. On a public repo that endpoint is readable
  // without the scope, so our own dogfooding never failed; on a private
  // consumer repo the scoped token gets HTTP 403 (issue #266).
  test("grants actions: read for the admission gate's gh run list", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      permissions: Record<string, string>;
    };
    expect(parsed.permissions.actions).toBe("read");
  });

  test("the skill's bundled workflow asset grants the same permissions", async () => {
    const asset = Bun.YAML.parse(
      await Bun.file(
        new URL(
          "../../skills/pr-hero-ci-setup/assets/workflow.yml",
          import.meta.url,
        ),
      ).text(),
    ) as { permissions: Record<string, string> };
    const generated = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      permissions: Record<string, string>;
    };
    expect(asset.permissions).toEqual(generated.permissions);
  });

  test("checks out with fetch-depth: 0", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const checkoutStep = parsed.jobs.review.steps.find(
      (step) => step.uses === "actions/checkout@v4",
    ) as { with?: { "fetch-depth"?: number } } | undefined;
    expect(checkoutStep?.with?.["fetch-depth"]).toBe(0);
  });

  test("explains WHY fetch-depth: 0 is required, not merely that it is set", () => {
    const template = generateCiWorkflowTemplate();
    expect(template).toMatch(/fetch-depth: 0 is load-bearing/i);
  });

  test("invokes the official composite action", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const usesValues = parsed.jobs.review.steps.map((step) => step.uses);
    expect(usesValues).toContain("juanmaagd/pr-hero@v0");
  });

  test("never embeds a secret value — references secrets by name only", () => {
    const template = generateCiWorkflowTemplate();
    expect(template).toContain(`\${{ secrets.ANTHROPIC_API_KEY }}`);
    expect(template).toContain(`\${{ secrets.GITHUB_TOKEN }}`);
    expect(template).toContain(`\${{ secrets.OPENCODE_AUTH_JSON }}`);
    expect(template).not.toMatch(/sk-ant-[a-z0-9-]+/i);
    expect(template).not.toMatch(/ghp_|ghs_/);
    expect(template).not.toContain("oc-ci-fixture-not-a-secret");
    // Threat matrix RED (8), the half that outlives the old skip notice: no
    // inlined OpenCode auth blob of any shape.
    expect(template).not.toMatch(/"type"\s*:\s*"api"/);
  });

  test("wires BOTH documented credential inputs, not just the API key", () => {
    // The `with:` comment tells the reader to provide EITHER secret. A repo
    // that follows it and sets only CLAUDE_CODE_OAUTH_TOKEN used to send an
    // empty credential and never authenticate, while `pr-hero doctor` — which
    // accepts either variable — reported a healthy CI configuration. Silent
    // auth failure behind a green diagnostic; the template has to pass the
    // path it documents.
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const step = parsed.jobs.review.steps.find(
      (s) => s.uses === "juanmaagd/pr-hero@v0",
    ) as { with?: Record<string, string> } | undefined;
    expect(step?.with?.["anthropic-api-key"]).toBe(
      `\${{ secrets.ANTHROPIC_API_KEY }}`,
    );
    expect(step?.with?.["claude-token"]).toBe(
      `\${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`,
    );
  });

  test("the review job is bounded ABOVE the pipeline's own ceiling", () => {
    // DEFAULT_PIPELINE_TIMEOUT_MS is 75 minutes (src/review/pipeline.ts). A CI
    // timeout at or below that steals the salvage path: GitHub kills the job
    // before the pipeline's own ceiling can fire, close its artifacts and
    // report. The CI bound is a backstop for a HUNG runner, not a second
    // review budget — so it sits above the internal one with room for
    // checkout and action setup.
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { "timeout-minutes"?: number } };
    };
    const ceiling = parsed.jobs.review["timeout-minutes"];
    expect(typeof ceiling).toBe("number");
    expect(ceiling as number).toBeGreaterThan(
      DEFAULT_PIPELINE_TIMEOUT_MS / 60_000,
    );
  });

  test("the OAuth comment names setup-token, the only token that survives CI", () => {
    // Two different credentials wear the name "Claude OAuth token" and only
    // one works here. `claude setup-token` mints a long-lived (~1 year)
    // token meant for headless use; the `/login` session token in the
    // keychain expires in HOURS and is silently rotated by the CLI's refresh
    // token, which CI does not have. A reader who extracts the session token
    // gets a secret that works for a day and then breaks CI with no signal.
    // The template is where that distinction has to be stated, because it is
    // what the reader has open when they choose.
    const template = generateCiWorkflowTemplate();
    expect(template).toContain("claude setup-token");
    expect(template).toMatch(
      /never .*\/login|not the .*\/login|\/login.*expires/i,
    );
  });

  test("is deterministic — calling it twice returns byte-identical output", () => {
    expect(generateCiWorkflowTemplate()).toBe(generateCiWorkflowTemplate());
  });

  // A scaffolded repo must inherit action.yml's spend ceiling, never one this
  // repo chose for itself. `budget-usd` is a real money cap on someone else's
  // account; raising it from a template they did not read is not ours to do.
  //
  // This repo DISABLES the ceiling instead (`budget-usd: 0`). It reviews
  // itself on a Claude subscription, where a dollar ceiling means nothing,
  // and the billing-mode policy that was supposed to apply no ceiling there
  // (#156) resolved this repo's route as metered and skipped #326 and its
  // predecessors at the $10 default. 0 is the operator's explicit, loud
  // disable; it never imposes a ceiling, so #156's objection to a fixed
  // value does not apply. The scaffolded template still says nothing.
  test("the scaffolded template sets no budget-usd, and this repo's own disables it", () => {
    expect(generateCiWorkflowTemplate()).not.toContain("budget-usd:");
    expect(generateCiWorkflowTemplate(OWN_CI_WORKFLOW_OPTIONS)).toContain(
      "budget-usd: 0\n",
    );
  });

  // Threat matrix RED (5): vars must be quoted so an unset PRHERO_ROUTING
  // becomes the empty string instead of breaking YAML. The auth secret is
  // referenced by name, never inlined.
  test("quoted with.routing is vars.PRHERO_ROUTING and with.opencode-auth is secrets.OPENCODE_AUTH_JSON", () => {
    const template = generateCiWorkflowTemplate();
    expect(template).toContain(`routing: "\${{ vars.PRHERO_ROUTING }}"`);
    const parsed = Bun.YAML.parse(template) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const step = parsed.jobs.review.steps.find(
      (s) => s.name === "Run pr-hero",
    ) as { with?: Record<string, string> } | undefined;
    expect(step?.with?.routing).toBe(`\${{ vars.PRHERO_ROUTING }}`);
    expect(step?.with?.["opencode-auth"]).toBe(
      `\${{ secrets.OPENCODE_AUTH_JSON }}`,
    );
  });
});

// ---------------------------------------------------------------------
// This repo's own comment runs (forceEngineFromPr).
//
// A comment run starts on the DEFAULT branch, and `uses: ./` runs whatever
// engine actions/checkout put on disk. On #305 that was main's engine, which
// lagged dev: four hunters returned nothing in 59 s and the complete summary
// marker they posted blocked every later review of that head. This repo's
// own workflow therefore resolves the PR head first and checks out that
// commit. A consumer repo runs the published tag, so its checkout picks no
// engine and gets no such step.
// ---------------------------------------------------------------------
describe("this repo's own comment runs pin the pull request head", () => {
  const PROCEED =
    "github.event_name != 'issue_comment' || steps.gate.outputs.proceed == 'true'";

  function stepOrder(template: string): Array<string | undefined> {
    return workflowSteps(template).map((step) => step.id ?? step.name);
  }

  function checkoutOf(template: string): WorkflowStep | undefined {
    return workflowSteps(template).find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
  }

  const REPOSITORY = "acme/widgets";
  const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

  type PrHead = {
    headRepository: { nameWithOwner: string } | null;
    headRefOid: string | null;
  };

  // A permission lookup that fails `times` times with `stderr` (gh's own
  // wording), then answers `answer`.
  type PermissionFailure = { stderr: string; times: number; answer?: string };
  const NOT_FOUND = "gh: Not Found (HTTP 404)";

  // Runs the gate step's own script under `bash -e`, the shell a `run:` step
  // gets by default, with `gh` replaced by a function that logs its arguments
  // and answers through real jq: gh's --jq flag speaks the same filter
  // language, so the parsing under test is the script's own. The commenter's
  // permission lookup answers `permission`; `null` makes every lookup fail
  // the way gh does on a 404, and a PermissionFailure scripts any other
  // failure. `sleep` is a function too, so the retry's pause is recorded and
  // costs no wall time.
  function runGate(
    template: string,
    pr: PrHead,
    permission: string | null | PermissionFailure = "write",
  ) {
    const gate = workflowSteps(template).find((step) => step.id === "gate");
    const dir = mkdtempSync(path.join(tmpdir(), "prhero-head-gate-"));
    const outputFile = path.join(dir, "github-output");
    const callLog = path.join(dir, "gh-calls");
    const sleepLog = path.join(dir, "sleeps");
    const failuresFile = path.join(dir, "permission-failures");
    const failure: PermissionFailure | undefined =
      permission === null
        ? { stderr: NOT_FOUND, times: 1_000 }
        : typeof permission === "string"
          ? undefined
          : permission;
    writeFileSync(outputFile, "");
    writeFileSync(callLog, "");
    writeFileSync(sleepLog, "");
    writeFileSync(failuresFile, String(failure?.times ?? 0));
    const fakeGh = [
      'sleep() { printf "%s\\n" "$*" >> "$SLEEP_LOG"; }',
      "gh() {",
      '  printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
      '  case "$*" in',
      "    *collaborators*)",
      '      failures=$(<"$FAKE_FAILURES_FILE")',
      '      if [ "$failures" -gt 0 ]; then',
      '        printf "%s\\n" "$((failures - 1))" > "$FAKE_FAILURES_FILE"',
      '        printf "%s\\n" "$FAKE_PERMISSION_STDERR" >&2',
      "        return 1",
      "      fi",
      '      printf "%s\\n" "$FAKE_PERMISSION"',
      "      return 0",
      "      ;;",
      "  esac",
      '  filter="."',
      "  while [ $# -gt 0 ]; do",
      '    if [ "$1" = "--jq" ]; then filter="$2"; fi',
      "    shift",
      "  done",
      '  printf "%s" "$FAKE_PR_JSON" | jq -r "$filter"',
      "}",
    ].join("\n");
    const result = Bun.spawnSync(
      ["bash", "-e", "-c", `${fakeGh}\n${gate?.run ?? "exit 99"}`],
      {
        env: {
          PATH: process.env.PATH ?? "",
          PR: "305",
          COMMENTER: "octocat",
          GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_OUTPUT: outputFile,
          GH_CALL_LOG: callLog,
          SLEEP_LOG: sleepLog,
          FAKE_PR_JSON: JSON.stringify(pr),
          FAKE_PERMISSION:
            typeof permission === "string"
              ? permission
              : (failure?.answer ?? ""),
          FAKE_PERMISSION_STDERR: failure?.stderr ?? "",
          FAKE_FAILURES_FILE: failuresFile,
        },
      },
    );
    const lines = (file: string) =>
      readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line !== "");
    const outputs = Object.fromEntries(
      lines(outputFile).map((line) => line.split("=", 2)),
    );
    const calls = lines(callLog);
    const sleeps = lines(sleepLog);
    rmSync(dir, { recursive: true, force: true });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      outputs,
      calls,
      lookups: calls.filter((call) => call.includes("collaborators")).length,
      sleeps,
    };
  }

  const sameRepoPr: PrHead = {
    headRepository: { nameWithOwner: REPOSITORY },
    headRefOid: HEAD_SHA,
  };
  const forkPr: PrHead = {
    headRepository: { nameWithOwner: "stranger/widgets" },
    headRefOid: HEAD_SHA,
  };
  // GitHub reports a null head repository once a fork is deleted.
  const deletedForkPr: PrHead = { headRepository: null, headRefOid: HEAD_SHA };

  test("resolves the PR head before it checks anything out, and only on a comment", () => {
    expect(stepOrder(own())).toEqual(["gate", "Checkout", "pr-hero"]);
    const gate = workflowSteps(own()).find((step) => step.id === "gate");
    expect(gate?.if).toBe("github.event_name == 'issue_comment'");
    expect(gate?.env?.PR).toBe(`\${{ github.event.issue.number }}`);
  });

  test("checks out the gate's head sha on a comment and the event's own ref on a push", () => {
    // On pull_request the gate is skipped, its sha output is empty, and an
    // empty `ref:` keeps actions/checkout on that event's default ref.
    const checkout = checkoutOf(own());
    expect(checkout?.with?.ref).toBe(`\${{ steps.gate.outputs.sha }}`);
    expect(checkout?.if).toBe(PROCEED);
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const run = workflowSteps(own()).find((step) => step.id === "pr-hero");
    expect(run?.if).toBe(PROCEED);
  });

  test("reads the fork verdict and the head sha in ONE gh call", () => {
    // Two reads could straddle a push: the fork verdict would describe one
    // head and the checked-out sha another.
    const gate = runGate(own(), sameRepoPr);
    expect(gate.exitCode).toBe(0);
    expect(gate.outputs).toEqual({ proceed: "true", sha: HEAD_SHA });
    const prReads = gate.calls.filter((call) => call.startsWith("pr view"));
    expect(prReads).toHaveLength(1);
    expect(prReads[0]).toContain("--json headRepository,headRefOid");
  });

  // The write-access check inside action.yml cannot protect THIS repo: here
  // `uses: ./` runs the checked-out head's own action.yml, so a same-repo head
  // that predates the check (an old bot branch) would let anyone who can
  // comment start a review with this repository's secrets. The gate is the
  // only code that runs before the head does, so the check has to live here,
  // and it fails closed: anything but admin or write refuses without reading
  // the PR or checking anything out. A 404 is GitHub's definitive answer for
  // a non-collaborator, so it refuses quietly after ONE lookup.
  test.each([
    ["read", "read"],
    ["triage", "triage"],
    ["none", "none"],
    ["an empty answer", ""],
    ["a failed lookup (HTTP 404)", null],
  ])(
    "refuses a commenter with %s before touching the PR head",
    (_label, permission) => {
      const gate = runGate(own(), sameRepoPr, permission);
      expect(gate.exitCode).toBe(0);
      expect(gate.outputs).toEqual({ proceed: "false" });
      expect(gate.stdout).toContain("::notice");
      expect(gate.stdout).toContain("write access");
      expect(gate.calls.some((call) => call.startsWith("pr view"))).toBe(false);
      expect(gate.lookups).toBe(1);
      expect(gate.sleeps).toEqual([]);
    },
  );

  // Any other lookup failure says nothing about the commenter, only about
  // the API. Refusing quietly there would show a maintainer the same notice
  // a stranger gets, on a default-branch run nobody sees from the PR. Still
  // fail-closed (no head is read or checked out), but red.
  test.each([
    ["a 5xx", "gh: Server Error (HTTP 502)"],
    [
      "a rate limit",
      "gh: API rate limit exceeded for installation. (HTTP 403)",
    ],
    ["a gh that cannot run", "bash: gh: command not found"],
  ])(
    "fails the job red on %s twice, after exactly one retry, before touching the PR head",
    (_label, stderr) => {
      const gate = runGate(own(), sameRepoPr, { stderr, times: 2 });
      expect(gate.exitCode).toBe(1);
      expect(gate.outputs).toEqual({});
      expect(gate.stdout).toContain("::error title=pr-hero::");
      expect(gate.stdout).toContain("/pr-hero review");
      expect(gate.lookups).toBe(2);
      expect(gate.sleeps).toHaveLength(1);
      expect(gate.calls.some((call) => call.startsWith("pr view"))).toBe(false);
    },
  );

  test("a lookup that fails once and then answers write proceeds", () => {
    const gate = runGate(own(), sameRepoPr, {
      stderr: "gh: Server Error (HTTP 502)",
      times: 1,
      answer: "write",
    });
    expect(gate.exitCode).toBe(0);
    expect(gate.outputs).toEqual({ proceed: "true", sha: HEAD_SHA });
    expect(gate.lookups).toBe(2);
    expect(gate.sleeps).toHaveLength(1);
  });

  test.each([["admin"], ["write"]])(
    "lets a commenter with %s through, after checking it first",
    (permission) => {
      const gate = runGate(own(), sameRepoPr, permission);
      expect(gate.outputs).toEqual({ proceed: "true", sha: HEAD_SHA });
      expect(gate.calls[0]).toBe(
        `api repos/${REPOSITORY}/collaborators/octocat/permission --jq .permission`,
      );
    },
  );

  test("passes the commenter to the gate through env, never inline", () => {
    const gate = workflowSteps(own()).find((step) => step.id === "gate");
    expect(gate?.env?.COMMENTER).toBe(
      `\${{ github.event.comment.user.login }}`,
    );
    expect(String(gate?.run)).not.toContain("github.event.comment");
  });

  // `ref: ""` makes actions/checkout fall back to the default branch on a
  // comment event, the very engine this pin exists to avoid, and any other
  // non-sha value would be resolved as a ref name. Only a full 40-hex commit
  // sha may proceed.
  test.each([
    ["a missing head commit", null],
    ["a branch name", "main"],
    [
      "a non-hex 40-character value",
      "g123456789abcdef0123456789abcdef01234567",
    ],
    ["a 39-character sha prefix", HEAD_SHA.slice(0, 39)],
    ["a 41-character value", `${HEAD_SHA}0`],
  ])("fails on %s instead of handing it to checkout", (_label, headRefOid) => {
    const gate = runGate(own(), {
      headRepository: { nameWithOwner: REPOSITORY },
      headRefOid,
    });
    expect(gate.exitCode).toBe(1);
    expect(gate.outputs).toEqual({});
  });

  // Here `uses: ./` runs the checked-out engine, so reviewing a fork would
  // run the fork's own code with this repository's secrets.
  test.each([
    ["a fork", forkPr],
    ["a deleted fork", deletedForkPr],
  ])("refuses %s without failing the job, and says why", (_kind, pr) => {
    const gate = runGate(own(), pr);
    expect(gate.exitCode).toBe(0);
    expect(gate.outputs).toEqual({ proceed: "false" });
    expect(gate.stdout).toContain("::notice");
    expect(gate.stdout).toContain("secrets");
  });

  test("the scaffolded workflow resolves nothing and pins no ref", () => {
    // A consumer repo runs juanmaagd/pr-hero@v0, so its checkout never
    // selects the engine and needs no pin.
    expect(stepOrder(scaffolded())).toEqual(["Checkout", "pr-hero"]);
    expect(checkoutOf(scaffolded())?.with?.ref).toBeUndefined();
    expect(checkoutOf(scaffolded())?.if).toBeUndefined();
  });

  test("the head pin is its own option, never inferred from a local action ref", () => {
    const localRefOnly = generateCiWorkflowTemplate({ actionRef: "./" });
    expect(stepOrder(localRefOnly)).toEqual(["Checkout", "pr-hero"]);
    expect(checkoutOf(localRefOnly)?.with?.ref).toBeUndefined();
  });
});

describe("materializeCiOpenCodeData (impure edge)", () => {
  async function withFixture<T>(
    fn: (paths: { home: string; workspace: string }) => Promise<T>,
  ): Promise<T> {
    const root = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-opencode-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    try {
      return await fn({ home, workspace });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Threat matrix RED (1): person-layer writes use prheroLayout(home), never
  // the workspace checkout's .prhero/config.json (repo parser rejects routing).
  test("writes routing at prheroLayout(home).reviewConfigPath and not the workspace", async () => {
    await withFixture(async ({ home, workspace }) => {
      const workspaceConfig = path.join(workspace, ".prhero", "config.json");
      await mkdir(path.dirname(workspaceConfig), { recursive: true });
      const workspaceBefore = `${JSON.stringify({ max_changed_lines: 50 })}\n`;
      await writeFile(workspaceConfig, workspaceBefore);

      await materializeCiOpenCodeData({
        home,
        env: { HOME: home },
        routing: OPENCODE_CI_ROUTING,
        opencodeAuth: "",
      });

      const expected = prheroLayout(home).reviewConfigPath;
      expect(expected).toBe(path.join(home, ".prhero", "config.json"));
      expect(existsSync(expected)).toBe(true);
      const layer = parseGlobalConfig(await readFile(expected, "utf8"));
      expect(layer.routing?.default?.backend).toBe("opencode");
      expect(layer.routing?.default?.provider).toBe("deepseek");

      expect(await readFile(workspaceConfig, "utf8")).toBe(workspaceBefore);
      expect(parseLocalConfig(workspaceBefore)).not.toHaveProperty("routing");
    });
  });

  // Threat matrix RED (2): the whole auth store lands 0600 at the broker path.
  test("writes 0600 auth.json at resolveOpenCodeAuthPath()", async () => {
    await withFixture(async ({ home }) => {
      const env = { HOME: home };
      await materializeCiOpenCodeData({
        home,
        env,
        routing: "",
        opencodeAuth: OPENCODE_CI_AUTH,
      });

      const authPath = resolveOpenCodeAuthPath(env, home);
      expect(authPath).toBe(
        path.join(home, ".local", "share", "opencode", "auth.json"),
      );
      expect(existsSync(authPath)).toBe(true);
      expect(statSync(authPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual(
        JSON.parse(OPENCODE_CI_AUTH),
      );
    });
  });

  // Threat matrix RED (3): empty HOME fails loud; never fall back to cwd.
  test("empty HOME is non-zero and leaves cwd untouched", async () => {
    await withFixture(async ({ workspace }) => {
      const workspaceConfig = path.join(workspace, ".prhero", "config.json");
      await expect(
        materializeCiOpenCodeData({
          env: { HOME: "" },
          routing: OPENCODE_CI_ROUTING,
          opencodeAuth: OPENCODE_CI_AUTH,
        }),
      ).rejects.toThrow(/HOME/);

      expect(existsSync(workspaceConfig)).toBe(false);
      expect(existsSync(path.join(workspace, ".prhero"))).toBe(false);
      expect(existsSync(path.join(workspace, ".local"))).toBe(false);

      const proc = Bun.spawn(
        ["bun", path.resolve(__dirname, "..", "..", "src", "ci", "setup.ts")],
        {
          cwd: workspace,
          env: {
            ...process.env,
            HOME: "",
            ROUTING_INPUT: OPENCODE_CI_ROUTING,
            OPENCODE_AUTH_INPUT: OPENCODE_CI_AUTH,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).not.toContain("oc-ci-fixture-not-a-secret");
      expect(existsSync(workspaceConfig)).toBe(false);
      expect(existsSync(path.join(workspace, ".local"))).toBe(false);
    });
  });

  test("empty routing skips the person-layer write", async () => {
    await withFixture(async ({ home }) => {
      await materializeCiOpenCodeData({
        home,
        env: { HOME: home },
        routing: "",
        opencodeAuth: OPENCODE_CI_AUTH,
      });
      expect(existsSync(prheroLayout(home).reviewConfigPath)).toBe(false);
      expect(existsSync(resolveOpenCodeAuthPath({ HOME: home }, home))).toBe(
        true,
      );
    });
  });
});

// The scaffold's own closing instructions are the first place a new user
// learns how to force a review, and GitHub reads a comment-triggered workflow
// from the DEFAULT branch. Committing the file to a feature branch and
// commenting there starts nothing, silently, so the next steps must say where
// the file has to land before `/pr-hero review` works.
// The setup step's own exit path (odd/tasks/agent-first-ci.md, T2b / A1): a
// malformed routing or auth input is the user's configuration, so the step
// leaves setup.json for the publisher. Spawned, like the empty-HOME test
// above, so the test exercises the real entry point and its real exit code.
describe("setup.ts records a malformed input for the outcome publisher", () => {
  const SETUP_SCRIPT = path.resolve(
    __dirname,
    "..",
    "..",
    "src",
    "ci",
    "setup.ts",
  );

  async function runSetup(
    env: Record<string, string>,
    prepare?: (outDir: string) => Promise<void>,
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "pr-hero-setup-record-"));
    const home = path.join(root, "home");
    const outDir = path.join(root, "outcome");
    await mkdir(home, { recursive: true });
    try {
      if (prepare !== undefined) await prepare(outDir);
      const proc = Bun.spawn(["bun", SETUP_SCRIPT], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          ROUTING_INPUT: "",
          OPENCODE_AUTH_INPUT: "",
          PRHERO_OUTCOME_DIR: outDir,
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const recordPath = path.join(outDir, "setup.json");
      const recordText = existsSync(recordPath)
        ? await readFile(recordPath, "utf8")
        : undefined;
      return { exitCode, stderr, recordText };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("a routing input that is not JSON records config-parse routing, with a fixed detail and no content", async () => {
    const result = await runSetup({
      ROUTING_INPUT: '{"SENTINEL-ROUTING-7f3a": ',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CI routing input is not valid JSON");
    expect(JSON.parse(result.recordText ?? "null")).toEqual({
      v: 1,
      cls: { kind: "config-parse", source: "routing" },
      detail: "the routing input is not valid JSON",
    });
    expect(result.recordText).not.toContain("SENTINEL");
  });

  // WHY a directory (F003 on #330): the setup record's temp name is unique per write
  // now, so a directory left at the old fixed `setup.json.tmp` by an earlier job
  // cannot stop this step's record. A directory fails any write to that path.
  test("a directory left at the old fixed setup temp name does not stop the record", async () => {
    const result = await runSetup(
      { ROUTING_INPUT: '{"SENTINEL-ROUTING-7f3a": ' },
      async (outDir) => {
        await mkdir(path.join(outDir, "setup.json.tmp"), { recursive: true });
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.recordText ?? "null")).toEqual({
      v: 1,
      cls: { kind: "config-parse", source: "routing" },
      detail: "the routing input is not valid JSON",
    });
  });

  test("a routing input of the wrong shape records config-parse routing too, without the key it names", async () => {
    const result = await runSetup({
      ROUTING_INPUT: '{"SENTINEL-KEY-7f3a": 1}',
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.recordText ?? "null")).toEqual({
      v: 1,
      cls: { kind: "config-parse", source: "routing" },
      detail: "the routing input is not a valid routing object",
    });
    expect(result.recordText).not.toContain("SENTINEL");
  });

  test("an OpenCode auth input that is not JSON records a credential malformed_payload, with a fixed detail", async () => {
    const result = await runSetup({
      OPENCODE_AUTH_INPUT: '{"SENTINEL-AUTH-7f3a": ',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CI opencode-auth is not valid JSON");
    expect(JSON.parse(result.recordText ?? "null")).toEqual({
      v: 1,
      cls: { kind: "credential", failureClass: "malformed_payload" },
      detail: "the opencode-auth input is not valid JSON",
    });
    expect(result.recordText).not.toContain("SENTINEL");
  });

  test("an OpenCode auth input that is JSON but not an object is the same class, with its own detail", async () => {
    const result = await runSetup({
      OPENCODE_AUTH_INPUT: '"SENTINEL-AUTH-7f3a"',
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.recordText ?? "null")).toEqual({
      v: 1,
      cls: { kind: "credential", failureClass: "malformed_payload" },
      detail: "the opencode-auth input must be a JSON object",
    });
    expect(result.recordText).not.toContain("SENTINEL");
  });

  test("a valid setup writes no record", async () => {
    const result = await runSetup({});
    expect(result.exitCode).toBe(0);
    expect(result.recordText).toBeUndefined();
  });

  test("an environment failure writes no record, so the publisher cannot blame the configuration for it", async () => {
    const result = await runSetup({
      HOME: "",
      ROUTING_INPUT: '{"SENTINEL-ROUTING-7f3a": ',
    });
    expect(result.exitCode).toBe(1);
    expect(result.recordText).toBeUndefined();
  });
});

describe("ci init next steps (CLI)", () => {
  test("say that /pr-hero review works once the workflow is on the default branch", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prhero-ci-init-"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      const result = Bun.spawnSync(
        [
          process.execPath,
          path.join(import.meta.dir, "../../src/cli.ts"),
          "ci",
          "init",
        ],
        { cwd: dir, env: { ...process.env, NO_COLOR: "1" } },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.exitCode).toBe(0);
      expect(output).toContain("Next steps:");
      expect(output).toContain("/pr-hero review");
      expect(output).toMatch(/default branch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runCiSetup (impure edge)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("creates .github/workflows/pr-hero.yml when absent", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-setup-"));

    const result = await runCiSetup({ cwd: dir });

    expect(result.status).toBe("created");
    const written = await readFile(
      path.join(dir, CI_WORKFLOW_RELATIVE_PATH),
      "utf8",
    );
    expect(written).toBe(generateCiWorkflowTemplate());
  });

  // One workflow is the whole install. A literal path, not a constant: the
  // force workflow's path constant went away with its generator.
  const LEGACY_FORCE_WORKFLOW = path.join(
    ".github",
    "workflows",
    "pr-hero-force.yml",
  );

  test("writes only pr-hero.yml, never a force workflow", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-setup-"));

    await runCiSetup({ cwd: dir });

    expect(existsSync(path.join(dir, CI_WORKFLOW_RELATIVE_PATH))).toBe(true);
    expect(existsSync(path.join(dir, LEGACY_FORCE_WORKFLOW))).toBe(false);
  });

  test("--force leaves a legacy pr-hero-force.yml exactly as it was", async () => {
    // The skip comment still names `gh workflow run pr-hero-force.yml` for
    // repos scaffolded before the comment trigger, and the action keeps the
    // inputs that file sets. Re-scaffolding must not delete or rewrite a
    // file the user may still dispatch.
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-setup-"));
    const legacy = path.join(dir, LEGACY_FORCE_WORKFLOW);
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, "# a legacy force workflow\n");

    await runCiSetup({ cwd: dir, force: true });

    expect(await readFile(legacy, "utf8")).toBe("# a legacy force workflow\n");
  });

  test("refuses to overwrite an existing workflow without --force", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-setup-"));
    const target = path.join(dir, CI_WORKFLOW_RELATIVE_PATH);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "# a user's customized workflow\n");

    const result = await runCiSetup({ cwd: dir });

    expect(result.status).toBe("skipped-existing");
    const stillThere = await readFile(target, "utf8");
    expect(stillThere).toBe("# a user's customized workflow\n");
  });

  test("overwrites the existing workflow when --force is passed", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-setup-"));
    const target = path.join(dir, CI_WORKFLOW_RELATIVE_PATH);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "# a user's customized workflow\n");

    const result = await runCiSetup({ cwd: dir, force: true });

    expect(result.status).toBe("overwritten");
    const written = await readFile(target, "utf8");
    expect(written).toBe(generateCiWorkflowTemplate());
  });
});

describe("checkCiConfiguration (pure diagnostic, system-tools.ts)", () => {
  test("local context: configured true when the workflow file exists", () => {
    const status = checkCiConfiguration({
      cwd: "/repo",
      isCi: false,
      exists: (p) => p === path.join("/repo", CI_WORKFLOW_RELATIVE_PATH),
    });
    expect(status.configured).toBe(true);
  });

  test("local context: configured false with a setup hint when absent", () => {
    const status = checkCiConfiguration({
      cwd: "/repo",
      isCi: false,
      exists: () => false,
    });
    expect(status.configured).toBe(false);
    expect(status.hint).toMatch(/setup --ci|ci init/);
  });

  test("GitHub Actions context: configured true when GITHUB_TOKEN and an Anthropic/Claude credential are present", () => {
    const status = checkCiConfiguration({
      isCi: true,
      env: {
        GITHUB_TOKEN: "ghs_realtoken",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth_realtoken",
      },
    });
    expect(status.configured).toBe(true);
  });

  test("GitHub Actions context: accepts ANTHROPIC_API_KEY as the alternative credential", () => {
    const status = checkCiConfiguration({
      isCi: true,
      env: {
        GITHUB_TOKEN: "ghs_realtoken",
        ANTHROPIC_API_KEY: "sk-ant-realkey",
      },
    });
    expect(status.configured).toBe(true);
  });

  test("GitHub Actions context: names the missing secret without ever echoing a present value", () => {
    const status = checkCiConfiguration({
      isCi: true,
      env: { GITHUB_TOKEN: "ghs_realtoken12345" },
      exists: () => false,
    });
    expect(status.configured).toBe(false);
    expect(status.message).toContain("ANTHROPIC_API_KEY");
    expect(status.message).not.toContain("ghs_realtoken12345");
  });

  test("GitHub Actions context: reports both secrets missing distinctly", () => {
    const status = checkCiConfiguration({
      isCi: true,
      env: {},
      exists: () => false,
    });
    expect(status.configured).toBe(false);
    expect(status.message).toContain("GITHUB_TOKEN");
    expect(status.message).toContain("ANTHROPIC_API_KEY");
  });

  test("GitHub Actions context: OpenCode auth file satisfies review auth without Anthropic", () => {
    const env = {
      GITHUB_TOKEN: "ghs_realtoken",
      XDG_DATA_HOME: "/xdg-data",
    };
    const authPath = resolveOpenCodeAuthPath(env);
    const status = checkCiConfiguration({
      isCi: true,
      env,
      exists: (p) => p === authPath,
    });
    expect(status.configured).toBe(true);
  });
});

describe("doctor CI diagnostics (Pillar 3)", () => {
  // `checkToolsOptions` was carrying only `env`, so `checkSystemTools` fell
  // back to its real `Bun.spawn` and every one of these five tests ran
  // `git --version`, `claude --version`, `gh --version`, `gh auth status`
  // and `codegraph --version` for real. `gh auth status` is a live network
  // round trip — measured at ~450ms of mostly-waiting per call — which is how
  // five tests that assert on a pure string check became the slowest thing in
  // the suite and timed out at bun's 5000ms default whenever `gh` was slow.
  //
  // The fakes are deliberately HEALTHY (every binary found, every probe exit
  // 0). These tests assert that the CI check alone decides `severity` and, in
  // the last one, `report.overall` — a fake-broken git would make that
  // "blocking" for the wrong reason and the assertion would stop meaning
  // anything. `env` stays per-test: it is the variable under study.
  const installedTools = {
    which: (bin: string) => `/usr/bin/${bin}`,
    exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
  };

  // Both "local repo context" tests inject `env: {}` explicitly. Without it
  // `runDoctor` falls back to the real `process.env`, and the CI check is the
  // one check in the report whose severity is decided BY the environment — so
  // these two would assert one thing on a developer laptop and another inside
  // a GitHub Actions runner, where `GITHUB_ACTIONS=true` is always set and the
  // secrets this check looks for are not.
  //
  // Verified, not theorised: `GITHUB_ACTIONS=true bun test test/ci/setup.test.ts`
  // failed both of these before the injection was added. That matters now that
  // .github/workflows/ci.yml runs this suite on every pull request — a gate
  // that goes red for a reason unrelated to any defect is how a team learns to
  // ignore the gate. A test that asserts on the environment has to supply it.
  test("local repo context: healthy when a CI workflow is configured", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      repoRoot: "/repo",
      home: "/home/user",
      exists: (p) => p === path.join("/repo", CI_WORKFLOW_RELATIVE_PATH),
      readFile: () => undefined,
      checkToolsOptions: { ...installedTools, env: {} },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("healthy");
  });

  test("local repo context: degraded (not blocking) when no CI workflow is configured", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      repoRoot: "/repo",
      home: "/home/user",
      exists: () => false,
      readFile: () => undefined,
      checkToolsOptions: { ...installedTools, env: {} },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("degraded");
    expect(ciCheck?.hint).toMatch(/setup --ci|ci init/);
  });

  test("generic non-GitHub CI (CI=true) is degraded, never blocking", async () => {
    // `CI=true` is the near-universal convention — GitLab, CircleCI, Jenkins,
    // Travis, Buildkite, and plenty of container builds all set it. The
    // secrets this check looks for (GITHUB_TOKEN plus Anthropic/Claude auth)
    // only ever exist inside a GitHub Actions job, so on any of those it found
    // nothing, marked the check blocking, and flipped report.overall — which
    // makes `pr-hero upgrade --reconcile` push an error and exit 1, and a bare
    // `pr-hero doctor` exit 1, on a machine where nothing is wrong.
    const report = await runDoctor({
      cwd: "/repo",
      repoRoot: "/repo",
      home: "/home/user",
      exists: () => false,
      readFile: () => undefined,
      checkToolsOptions: { ...installedTools, env: { CI: "true" } },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("degraded");
    // And it is asked the question a non-GitHub machine can actually answer:
    // "do you have a workflow?", not "where are your GitHub Actions secrets?"
    expect(ciCheck?.hint).toMatch(/setup --ci|ci init/);
  });

  test("GitHub Actions context: healthy when required secrets are present", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      home: "/home/user",
      exists: () => false,
      readFile: () => undefined,
      checkToolsOptions: {
        ...installedTools,
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_TOKEN: "ghs_realtoken",
          ANTHROPIC_API_KEY: "sk-ant-realkey",
        },
      },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("healthy");
  });

  test("GitHub Actions context: healthy when GITHUB_TOKEN and OpenCode auth file are present", async () => {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_TOKEN: "ghs_realtoken",
      XDG_DATA_HOME: "/xdg-data",
    };
    const authPath = resolveOpenCodeAuthPath(env);
    const report = await runDoctor({
      cwd: "/repo",
      home: "/home/user",
      exists: (p) => p === authPath,
      readFile: () => undefined,
      checkToolsOptions: {
        ...installedTools,
        env,
      },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("healthy");
  });

  test("GitHub Actions context: blocking when a required secret is missing, and never echoes any value", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      home: "/home/user",
      exists: () => false,
      readFile: () => undefined,
      checkToolsOptions: {
        ...installedTools,
        env: { GITHUB_ACTIONS: "true", GITHUB_TOKEN: "ghs_realtoken12345" },
      },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("blocking");
    expect(ciCheck?.message).toContain("ANTHROPIC_API_KEY");
    expect(ciCheck?.message).not.toContain("ghs_realtoken12345");
    expect(report.overall).toBe("blocking");
  });
});

describe("CLI wiring: setup --ci and ci init (parseArgs)", () => {
  test("setup --ci parses with command=setup, options.ci=true", () => {
    const parsed = parseArgs(["setup", "--ci"]);
    expect(parsed.command).toBe("setup");
    expect(parsed.options.ci).toBe(true);
  });

  test("plain setup (no --ci) still parses — the interactive wizard path", () => {
    const parsed = parseArgs(["setup"]);
    expect(parsed.command).toBe("setup");
    expect(parsed.options.ci).toBeUndefined();
  });

  test("ci init parses with command=ci, options.ciSubcommand=init", () => {
    const parsed = parseArgs(["ci", "init"]);
    expect(parsed.command).toBe("ci");
    expect(parsed.options.ciSubcommand).toBe("init");
  });

  test("ci init --force parses with options.force=true", () => {
    const parsed = parseArgs(["ci", "init", "--force"]);
    expect(parsed.options.force).toBe(true);
  });

  test("bare ci with no subcommand is rejected", () => {
    expect(() => parseArgs(["ci"])).toThrow();
  });

  test("--ci still requires --pr on the review command (unchanged Phase 3 behavior)", () => {
    expect(() => parseArgs(["review", "--ci"])).toThrow(/--pr/);
  });

  test("--ci on a command other than review or setup is rejected", () => {
    expect(() => parseArgs(["doctor", "--ci"])).toThrow(
      /review or setup command/,
    );
  });
});

// S4: the scaffold names its gate mode in the file itself, so a reader sees
// what turns the status red without consulting the action's defaults.
describe("scaffold writes the gate mode explicitly (S4)", () => {
  // The pr-hero step's own `with:`, found by its `uses:` line: the checkout
  // step above it has a `with:` block of its own.
  function withBlock(template: string): string[] {
    const lines = template.split("\n");
    const uses = lines.findIndex(
      (line) => line.trim().startsWith("uses:") && /pr-hero|\.\//.test(line),
    );
    expect(uses).toBeGreaterThan(-1);
    const start = lines.findIndex(
      (line, index) => index > uses && line.trim() === "with:",
    );
    expect(start).toBeGreaterThan(-1);
    const block: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.trim() !== "" && !line.startsWith("          ")) break;
      block.push(line);
    }
    return block;
  }

  test("the default scaffold writes mode: gate inside the pr-hero with: block", () => {
    const block = withBlock(generateCiWorkflowTemplate());
    expect(block).toContain("          mode: gate");
    expect(block.filter((line) => line.includes("mode:"))).toHaveLength(1);
  });

  test("the mode it is given is the one written", () => {
    const block = withBlock(generateCiWorkflowTemplate({ mode: "advisory" }));
    expect(block).toContain("          mode: advisory");
    expect(block.some((line) => line.includes("mode: gate"))).toBe(false);
  });

  test("this repo's own options name gate explicitly", () => {
    expect(OWN_CI_WORKFLOW_OPTIONS.mode).toBe("gate");
  });
});

// `/pr-hero recheck` is accepted wherever `/pr-hero review` is: the job's `if:`
// and the concurrency group, so the scaffolded workflow starts the same run.
describe("the scaffolded workflow accepts /pr-hero recheck", () => {
  test("the if and concurrency clauses mirror the review clauses", () => {
    const template = generateCiWorkflowTemplate();
    const recheck = "startsWith(github.event.comment.body, '/pr-hero recheck')";
    const review = "startsWith(github.event.comment.body, '/pr-hero review')";
    expect(template.split(review).length - 1).toBeGreaterThan(0);
    expect(template.split(recheck).length - 1).toBe(
      template.split(review).length - 1,
    );
  });
});
