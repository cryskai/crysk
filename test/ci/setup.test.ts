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
import { parseCryskSecrets } from "#ci/crysk-secrets";
import { deriveCiBillingMode } from "#ci/gates";
import {
  CI_WORKFLOW_RELATIVE_PATH,
  generateCiWorkflowTemplate,
  LEGACY_CI_WORKFLOW_RELATIVE_PATH,
  materializeCiOpenCodeData,
  OWN_CI_WORKFLOW_OPTIONS,
  runCiSetup,
} from "#ci/setup";
import { loadEffectiveConfig } from "#config/config";
import { DEFAULT_PIPELINE_TIMEOUT_MS } from "#review/pipeline";
import { parseArgs } from "#review/preflight";
import { runDoctor } from "../../src/doctor";
import { prheroLayout } from "../../src/home-preflight";
import { resolveRunClaudeCredential } from "../../src/security/claude-credential";
import { resolveOpenCodeAuthPath } from "../../src/security/credential-broker";
import { openCodeSecretManifestPath } from "../../src/security/opencode-secret-manifest";
import { checkCiConfiguration } from "../../src/system-tools";

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
const GROUP_COMMANDS = [
  "/crysk review",
  "/crysk recheck",
  "/crysk override",
  "/pr-hero review",
  "/pr-hero recheck",
  "/pr-hero override",
];
// The new names come first; the legacy /pr-hero forms are still admitted for one version.
const REVIEW_CONCURRENCY_GROUP = `\${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || ${GROUP_COMMANDS.map((c) => `(startsWith(github.event.comment.body, '${c}') && ${WRITER_ASSOCIATION})`).join(" || ")}) && format('pr-hero-review-{0}', github.event.pull_request.number || github.event.issue.number) || format('pr-hero-noop-{0}', github.run_id) }}`;
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
  test("the review job skips fork pushes, starts only on a `/crysk` (or legacy `/pr-hero`) review, recheck or override comment, and never reads secrets", () => {
    const reviewIf = String(
      parseWorkflow(generateCiWorkflowTemplate()).jobs.review?.if ?? "",
    );
    expect(reviewIf).toBe(
      "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || " +
        GROUP_COMMANDS.map(
          (c) =>
            `(github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '${c}'))`,
        ).join(" || "),
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
      `(startsWith(github.event.comment.body, '/crysk review') && ${WRITER_ASSOCIATION})`,
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
    for (const command of ["/crysk override", "/pr-hero override"]) {
      expect(group).toContain(
        `(startsWith(github.event.comment.body, '${command}') && ${WRITER_ASSOCIATION})`,
      );
    }
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
    expect(snippet).toContain("name: Crysk Review");
    const generatedIf = String(
      parseWorkflow(generateCiWorkflowTemplate()).jobs.review?.if ?? "",
    );
    for (const command of ["/crysk override", "/pr-hero override"]) {
      expect(generatedIf).toContain(
        `startsWith(github.event.comment.body, '${command}')`,
      );
    }
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
          "../../skills/crysk-ci-setup/assets/workflow.yml",
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
    expect(usesValues).toContain("cryskai/crysk@v0");
  });

  test("never embeds a secret value — references secrets by name only", () => {
    const template = generateCiWorkflowTemplate();
    expect(template).toContain(`\${{ secrets.CRYSK_CLAUDE_API_KEY }}`);
    expect(template).toContain(`\${{ secrets.GITHUB_TOKEN }}`);
    expect(template).toContain(`\${{ secrets.CRYSK_OPENCODE_OPENAI_OAUTH }}`);
    expect(template).not.toMatch(/sk-ant-[a-z0-9-]+/i);
    expect(template).not.toMatch(/ghp_|ghs_/);
    expect(template).not.toContain("oc-ci-fixture-not-a-secret");
    // Threat matrix RED (8), the half that outlives the old skip notice: no
    // inlined OpenCode auth blob of any shape.
    expect(template).not.toMatch(/"type"\s*:\s*"api"/);
  });

  test("wires BOTH documented Claude credentials, not just the API key", () => {
    // The `with:` comment tells the reader to provide EITHER secret. A repo
    // that follows it and sets only the OAuth token used to send an
    // empty credential and never authenticate, while `pr-hero doctor` — which
    // accepts either variable — reported a healthy CI configuration. Silent
    // auth failure behind a green diagnostic; the template has to pass the
    // path it documents.
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const step = parsed.jobs.review.steps.find(
      (s) => s.uses === "cryskai/crysk@v0",
    ) as { with?: Record<string, string> } | undefined;
    const lines = (step?.with?.["crysk-secrets"] ?? "").split("\n");
    expect(lines).toContain(
      `CRYSK_CLAUDE_API_KEY=\${{ secrets.CRYSK_CLAUDE_API_KEY }}`,
    );
    expect(lines).toContain(
      `CRYSK_CLAUDE_OAUTH_TOKEN=\${{ secrets.CRYSK_CLAUDE_OAUTH_TOKEN }}`,
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

  // E-f F4 (D1, D2): the scaffold's Run Crysk step names every CRYSK_* secret
  // explicitly, forwards the OpenCode API keys through slots driven by
  // vars.CRYSK_OPENCODE_PROVIDERS, and reads the models and credentials inputs
  // from repository variables. Secrets are referenced by name, never inlined.
  test("the Run Crysk step passes the fixed CRYSK_* secrets, five OpenCode slots and the two variables", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const step = parsed.jobs.review.steps.find((s) => s.name === "Run Crysk") as
      | { with?: Record<string, string> }
      | undefined;
    const lines = (step?.with?.["crysk-secrets"] ?? "").trimEnd().split("\n");
    const slot = (i: number) =>
      `fromJSON(vars.CRYSK_OPENCODE_PROVIDERS || '[]')[${i}]`;
    expect(lines).toEqual([
      "CRYSK_CLAUDE_OAUTH_TOKEN=$" + "{{ secrets.CRYSK_CLAUDE_OAUTH_TOKEN }}",
      "CRYSK_CLAUDE_API_KEY=$" + "{{ secrets.CRYSK_CLAUDE_API_KEY }}",
      "CRYSK_OPENCODE_OPENAI_OAUTH=$" +
        "{{ secrets.CRYSK_OPENCODE_OPENAI_OAUTH }}",
      ...[0, 1, 2, 3, 4].map(
        (i) =>
          `CRYSK_OPENCODE_$` +
          `{{ ${slot(i)} }}_API_KEY=$` +
          `{{ secrets[format('CRYSK_OPENCODE_{0}_API_KEY', ${slot(i)})] }}`,
      ),
    ]);
    expect(step?.with?.models).toBe("$" + "{{ vars.CRYSK_MODELS }}");
    expect(step?.with?.credentials).toBe("$" + "{{ vars.CRYSK_CREDENTIALS }}");
    expect(generateCiWorkflowTemplate()).not.toContain("toJSON(secrets)");
  });

  // An unused slot renders as `CRYSK_OPENCODE__API_KEY=` on GitHub (L42), and the
  // intake must skip all five of them, not refuse the input.
  test("five unused slots, as GitHub renders them, parse with no problem", () => {
    const rendered = [
      "CRYSK_CLAUDE_OAUTH_TOKEN=token",
      "CRYSK_CLAUDE_API_KEY=",
      "CRYSK_OPENCODE_OPENAI_OAUTH=",
      ...Array.from({ length: 5 }, () => "CRYSK_OPENCODE__API_KEY="),
    ].join("\n");
    const parse = parseCryskSecrets(rendered);
    expect(parse.problems).toEqual([]);
    expect(parse.secrets.claude.subscription).toBe("token");
    expect(parse.secrets.opencode.size).toBe(0);
  });
});

// U5 (odd/tasks/role-model-routing.md, S8): this repository's own workflow passes
// its credentials as CRYSK_* secrets in the crysk-secrets input, since the action
// stops a run that still passes the removed inputs. The scaffolded template is
// not changed here (E-f moves it).
describe("this repo's own workflow passes the CRYSK_* secrets", () => {
  function runCryskWith(template: string): Record<string, string> {
    const parsed = Bun.YAML.parse(template) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const step = parsed.jobs.review.steps.find((s) => s.name === "Run Crysk") as
      | { with?: Record<string, string> }
      | undefined;
    return step?.with ?? {};
  }

  test("its Run Crysk step passes the Claude pair in crysk-secrets and no removed input", () => {
    const withBlock = runCryskWith(own());
    for (const removed of [
      "anthropic-api-key",
      "claude-token",
      "opencode-auth",
      "routing",
    ]) {
      expect(withBlock[removed], removed).toBeUndefined();
    }
    const lines = (withBlock["crysk-secrets"] ?? "").split("\n");
    expect(lines).toContain(
      "CRYSK_CLAUDE_OAUTH_TOKEN=$" + "{{ secrets.CRYSK_CLAUDE_OAUTH_TOKEN }}",
    );
    expect(lines).toContain(
      "CRYSK_CLAUDE_API_KEY=$" + "{{ secrets.CRYSK_CLAUDE_API_KEY }}",
    );
    expect(own()).not.toContain("toJSON(secrets)");
  });

  test("the scaffolded template passes the CRYSK_* secrets too, never the removed inputs (E-f F4)", () => {
    const withBlock = runCryskWith(generateCiWorkflowTemplate());
    for (const removed of [
      "anthropic-api-key",
      "claude-token",
      "opencode-auth",
      "routing",
    ]) {
      expect(withBlock[removed], removed).toBeUndefined();
    }
    expect(withBlock["crysk-secrets"]).toContain(
      "CRYSK_CLAUDE_OAUTH_TOKEN=$" + "{{ secrets.CRYSK_CLAUDE_OAUTH_TOKEN }}",
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
      expect(gate.stdout).toContain("::error title=crysk::");
      expect(gate.stdout).toContain("/crysk review");
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
    // A consumer repo runs cryskai/crysk@v0, so its checkout never
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

  // Threat matrix RED (2): the auth file lands 0600 at the broker path. Built
  // from the CRYSK_OPENCODE_* secrets since the opencode-auth input went (D6).
  const DEEPSEEK_SECRETS = () =>
    parseCryskSecrets(
      "CRYSK_OPENCODE_DEEPSEEK_API_KEY=oc-ci-fixture-not-a-secret",
    );
  const DEEPSEEK_MODELS = JSON.stringify({
    default: ["opencode:deepseek/deepseek-chat"],
  });

  test("writes 0600 auth.json at resolveOpenCodeAuthPath()", async () => {
    await withFixture(async ({ home }) => {
      const env = { HOME: home };
      await materializeCiOpenCodeData({
        home,
        env,
        modelsInput: DEEPSEEK_MODELS,
        cryskSecrets: DEEPSEEK_SECRETS(),
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
      const workspaceConfig = path.join(workspace, ".crysk", "config.json");
      await expect(
        materializeCiOpenCodeData({
          env: { HOME: "" },
          modelsInput: DEEPSEEK_MODELS,
          cryskSecrets: DEEPSEEK_SECRETS(),
        }),
      ).rejects.toThrow(/HOME/);

      expect(existsSync(workspaceConfig)).toBe(false);
      expect(existsSync(path.join(workspace, ".crysk"))).toBe(false);
      expect(existsSync(path.join(workspace, ".local"))).toBe(false);

      const proc = Bun.spawn(
        [
          "bash",
          "--noprofile",
          "--norc",
          "-eo",
          "pipefail",
          "-c",
          `printf '%s' "$CRYSK_SECRETS_INPUT" | CRYSK_SECRETS_INPUT= bun "${path.resolve(__dirname, "..", "..", "src", "ci", "setup.ts")}" --crysk-secrets-stdin`,
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            HOME: "",
            MODELS_INPUT: DEEPSEEK_MODELS,
            CRYSK_SECRETS_INPUT:
              "CRYSK_OPENCODE_DEEPSEEK_API_KEY=oc-ci-fixture-not-a-secret",
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

  test("no platform layer and no models input skip the person-layer write", async () => {
    await withFixture(async ({ home }) => {
      await materializeCiOpenCodeData({
        home,
        env: { HOME: home },
        cryskSecrets: DEEPSEEK_SECRETS(),
      });
      expect(existsSync(prheroLayout(home).reviewConfigPath)).toBe(false);
      // No models name deepseek, so its secret builds nothing either.
      expect(existsSync(resolveOpenCodeAuthPath({ HOME: home }, home))).toBe(
        false,
      );
    });
  });

  // E-f F3 (D1): the credentials input reaches the run through the personal
  // file, so its order decides the Claude credential, and an api_key-first order
  // bills as metered.
  test("the credentials input reaches the run: an api_key-first order chooses the API key and bills as metered", async () => {
    await withFixture(async ({ home }) => {
      await materializeCiOpenCodeData({
        home,
        env: { HOME: home },
        credentialsInput: JSON.stringify({
          claude: ["api_key", "subscription"],
        }),
      });
      const loaded = await loadEffectiveConfig({ home });
      expect(loaded.effective.credentials).toEqual({
        claude: ["api_key", "subscription"],
      });
      const run = resolveRunClaudeCredential({
        credentials: loaded.effective.credentials,
        env: {
          HOME: home,
          CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-not-a-secret",
          ANTHROPIC_API_KEY: "fixture-key-not-a-secret",
        },
        loginPresent: false,
      });
      expect(run.kind).toBe("api_key");
      expect(deriveCiBillingMode(run.env)).toBe("metered");
    });
  });
});

// The scaffold's own closing instructions are the first place a new user
// learns how to force a review, and GitHub reads a comment-triggered workflow
// from the DEFAULT branch. Committing the file to a feature branch and
// commenting there starts nothing, silently, so the next steps must say where
// the file has to land before `/pr-hero review` works.
// The setup step's own exit path (odd/tasks/agent-first-ci.md, T2b / A1): a
// malformed auth input is the user's configuration, so the step
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
          MODELS_INPUT: "",
          CREDENTIALS_INPUT: "",
          CRYSK_OUTCOME_DIR: outDir,
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

  // The routing input is gone (S2) and the trigger stops a workflow that passes
  // one (CRYSK-INPUT-REMOVED, U5); action.yml does not bind it here. So the step
  // no longer reads it, and its old backstop and record class are gone (F0, D6).
  test("a routing value in the environment is not read: no failure and no record", async () => {
    const result = await runSetup({
      ROUTING_INPUT: '{"SENTINEL-ROUTING-7f3a": ',
    });
    expect(result.exitCode).toBe(0);
    expect(result.recordText).toBeUndefined();
    expect(result.stderr).not.toContain("routing");
  });

  // The opencode-auth input went the same way (D6): a value left in the
  // environment, a job-level env for instance, is not read.
  test("an opencode-auth value in the environment is not read: no failure and no record", async () => {
    const result = await runSetup({
      OPENCODE_AUTH_INPUT: '{"SENTINEL-AUTH-7f3a": ',
    });
    expect(result.exitCode).toBe(0);
    expect(result.recordText).toBeUndefined();
    expect(result.stderr).not.toContain("opencode-auth");
  });

  // WHY a directory (F003 on #330): the setup record's temp name is unique per write
  // now, so a directory left at the old fixed `setup.json.tmp` by an earlier job
  // cannot stop this step's record. A directory fails any write to that path.
  test("a directory left at the old fixed setup temp name does not stop the record", async () => {
    const result = await runSetup(
      { MODELS_INPUT: '{"SENTINEL-MODELS-7f3a": ' },
      async (outDir) => {
        await mkdir(path.join(outDir, "setup.json.tmp"), { recursive: true });
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.recordText ?? "null")).toEqual({
      v: 1,
      cls: { kind: "config-parse", source: "models-input" },
      detail: "the models input is not valid JSON",
    });
  });

  test("a valid setup writes no record", async () => {
    const result = await runSetup({});
    expect(result.exitCode).toBe(0);
    expect(result.recordText).toBeUndefined();
  });

  test("an environment failure writes no record, so the publisher cannot blame the configuration for it", async () => {
    const result = await runSetup({
      HOME: "",
      MODELS_INPUT: '{"SENTINEL-MODELS-7f3a": ',
    });
    expect(result.exitCode).toBe(1);
    expect(result.recordText).toBeUndefined();
  });
});

// The CRYSK_* secrets intake (odd/tasks/role-model-routing.md, S8, L13, U1):
// the setup step parses the `crysk-secrets` input, masks every value before it
// writes anything, and tells later steps only which credentials exist. Each
// test runs action.yml's own setup `run:` script under bash the way the runner
// does (`bash -eo pipefail`), so the stdin hand-off is what is tested.
describe("setup.ts reads the crysk-secrets input", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..");
  const SETUP_SCRIPT = path.join(REPO_ROOT, "src", "ci", "setup.ts");
  const setupStep = (
    Bun.YAML.parse(
      readFileSync(path.join(REPO_ROOT, "action.yml"), "utf8"),
    ) as { runs: { steps: { id?: string; run?: string }[] } }
  ).runs.steps.find((step) => step.id === "materialize");
  const STEP_SCRIPT = (setupStep?.run ?? "").replaceAll(
    `\${{ github.action_path }}`,
    REPO_ROOT,
  );
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const OAUTH_VALUE = b64({
    type: "oauth",
    access: "SENTINEL-ACCESS-55aa",
    refresh: "SENTINEL-REFRESH-55aa",
    expires: 1_900_000_000_000,
  });
  const SECRETS_INPUT = [
    "CRYSK_CLAUDE_OAUTH_TOKEN=SENTINEL-OAUTH-55aa",
    "CRYSK_CLAUDE_API_KEY=SENTINEL-APIKEY-55aa",
    "CRYSK_OPENCODE_DEEPSEEK_API_KEY=SENTINEL-DEEPSEEK-55aa",
    `CRYSK_OPENCODE_OPENAI_OAUTH=${OAUTH_VALUE}`,
    "CRYSK_OPENCODE_GROQ_API_KEY=",
    "CRYSK_CLAUDE_OAUTH_TOKEN_BACKUP=SENTINEL-BACKUP-55aa",
  ].join("\n");

  async function runSetup(
    env: Record<string, string>,
    options: {
      platform?: unknown;
      fakeGit?: boolean;
      // Run bun on setup.ts directly with `env`, bypassing the step's script.
      direct?: boolean;
      // Seeds the home before the step runs (a file an earlier run left).
      prepareHome?: (home: string) => Promise<void>;
    } = {},
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "pr-hero-setup-secrets-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const outDir = path.join(root, "outcome");
    const githubOutput = path.join(root, "github-output");
    const githubEnv = path.join(root, "github-env");
    const gitDump = path.join(root, "git-env-dump");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(githubOutput, "");
    await writeFile(githubEnv, "PRE_EXISTING=1\n");
    if (options.prepareHome !== undefined) await options.prepareHome(home);
    Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
    let pathEnv = process.env.PATH ?? "";
    if (options.fakeGit === true) {
      // A git first on PATH that records the environment it was given, then
      // runs the real one: the platform path's repo-root lookup spawns it.
      const realGit = Bun.which("git") as string;
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(
        path.join(bin, "git"),
        `#!/bin/sh\nenv >> "${gitDump}"\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      );
      pathEnv = `${bin}:${pathEnv}`;
    }
    let platformFile = "";
    if (options.platform !== undefined) {
      platformFile = path.join(root, "platform", "platform-config.json");
      await mkdir(path.dirname(platformFile), { recursive: true });
      await writeFile(platformFile, JSON.stringify(options.platform));
    }
    try {
      const argv =
        options.direct === true
          ? ["bun", SETUP_SCRIPT]
          : [
              "bash",
              "--noprofile",
              "--norc",
              "-eo",
              "pipefail",
              "-c",
              STEP_SCRIPT,
            ];
      const proc = Bun.spawn(argv, {
        cwd: workspace,
        env: {
          ...process.env,
          PATH: pathEnv,
          HOME: home,
          CRYSK_OUTCOME_DIR: outDir,
          GITHUB_OUTPUT: githubOutput,
          GITHUB_ENV: githubEnv,
          CRYSK_PLATFORM_CONFIG_FILE: platformFile,
          CRYSK_SECRETS_INPUT: "",
          MODELS_INPUT: "",
          CREDENTIALS_INPUT: "",
          // Empty, so the OpenCode auth file resolves under this test's HOME
          // and never at a data home the host may have set.
          XDG_DATA_HOME: "",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const recordPath = path.join(outDir, "setup.json");
      const homeFiles: string[] = [];
      for (const entry of new Bun.Glob("**/*").scanSync({
        cwd: home,
        dot: true,
      })) {
        homeFiles.push(await readFile(path.join(home, entry), "utf8"));
      }
      const authPath = resolveOpenCodeAuthPath({ HOME: home }, home);
      const manifestPath = openCodeSecretManifestPath(authPath);
      const authText = existsSync(authPath)
        ? await readFile(authPath, "utf8")
        : undefined;
      return {
        exitCode,
        stdout,
        stderr,
        output: await readFile(githubOutput, "utf8"),
        envFile: await readFile(githubEnv, "utf8"),
        record: existsSync(recordPath)
          ? await readFile(recordPath, "utf8")
          : undefined,
        gitDump: existsSync(gitDump)
          ? await readFile(gitDump, "utf8")
          : undefined,
        homeFiles,
        authText,
        auth:
          authText === undefined
            ? undefined
            : (JSON.parse(authText) as Record<string, Record<string, unknown>>),
        authMode: existsSync(authPath)
          ? statSync(authPath).mode & 0o777
          : undefined,
        manifestText: existsSync(manifestPath)
          ? await readFile(manifestPath, "utf8")
          : undefined,
        manifestMode: existsSync(manifestPath)
          ? statSync(manifestPath).mode & 0o777
          : undefined,
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("masks every value before any other line, and only masks carry a value", async () => {
    const result = await runSetup({ CRYSK_SECRETS_INPUT: SECRETS_INPUT });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((line) => line !== "");
    expect(lines).toEqual([
      "::add-mask::SENTINEL-OAUTH-55aa",
      "::add-mask::SENTINEL-APIKEY-55aa",
      "::add-mask::SENTINEL-DEEPSEEK-55aa",
      `::add-mask::${OAUTH_VALUE}`,
      "::add-mask::SENTINEL-ACCESS-55aa",
      "::add-mask::SENTINEL-REFRESH-55aa",
      "::add-mask::SENTINEL-BACKUP-55aa",
    ]);
    expect(result.stderr).not.toContain("SENTINEL");
    expect(result.stderr).not.toContain(OAUTH_VALUE);
    expect(result.stderr).toContain(
      "::notice::CRYSK_CLAUDE_OAUTH_TOKEN_BACKUP is reserved for several Claude accounts, which Crysk does not read yet; it is ignored.",
    );
    expect(result.record).toBeUndefined();
  });

  test("writes presence to GITHUB_OUTPUT, nothing to GITHUB_ENV, and no value anywhere", async () => {
    const result = await runSetup({ CRYSK_SECRETS_INPUT: SECRETS_INPUT });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      [
        "crysk-secrets=CRYSK_CLAUDE_API_KEY,CRYSK_CLAUDE_OAUTH_TOKEN,CRYSK_OPENCODE_DEEPSEEK_API_KEY,CRYSK_OPENCODE_OPENAI_OAUTH",
        "claude-credentials=subscription,api_key",
        "opencode-providers=DEEPSEEK,OPENAI",
        "",
      ].join("\n"),
    );
    expect(result.envFile).toBe("PRE_EXISTING=1\n");
    // No models name an OpenCode provider (no platform layer), so nothing is
    // written under HOME from these secrets (U3 writes only plan providers).
    expect(result.authText).toBeUndefined();
    expect(result.homeFiles.join("\n")).not.toContain("SENTINEL");
    expect(result.homeFiles.join("\n")).not.toContain(OAUTH_VALUE);
  });

  test("the values never reach a child process: git, spawned on the platform path, sees neither the input nor a value", async () => {
    const result = await runSetup(
      { CRYSK_SECRETS_INPUT: SECRETS_INPUT },
      {
        platform: { person: {}, repo: { default_base: "release" } },
        fakeGit: true,
      },
    );
    expect(result.exitCode).toBe(0);
    // git ran, so the check below is about a real child environment. Booleans,
    // so a failure never prints the environment it captured.
    const dump = result.gitDump ?? "";
    expect(dump.includes("HOME=")).toBe(true);
    // The step runs bun with the variable emptied, so at most `NAME=` is left.
    expect(/^CRYSK_SECRETS_INPUT=.+$/m.test(dump)).toBe(false);
    expect(dump.includes("SENTINEL")).toBe(false);
    expect(dump.includes(OAUTH_VALUE)).toBe(false);
    expect(result.output).toContain("repo-config=");
    expect(result.output).toContain("claude-credentials=subscription,api_key");
  });

  test("a malformed _OAUTH fails the step with a record naming the secret, never its value", async () => {
    const result = await runSetup({
      CRYSK_SECRETS_INPUT: [
        "CRYSK_CLAUDE_API_KEY=SENTINEL-APIKEY-55aa",
        "CRYSK_OPENCODE_OPENAI_OAUTH=SENTINEL-not-base64!",
      ].join("\n"),
    });
    expect(result.exitCode).toBe(1);
    // Masked even though the step fails.
    expect(result.stdout).toContain("::add-mask::SENTINEL-APIKEY-55aa");
    expect(result.stdout).toContain("::add-mask::SENTINEL-not-base64!");
    expect(result.stderr).toContain(
      "CI crysk-secrets input: CRYSK_OPENCODE_OPENAI_OAUTH is not base64",
    );
    expect(result.stderr).not.toContain("SENTINEL");
    expect(JSON.parse(result.record ?? "null")).toEqual({
      v: 1,
      cls: { kind: "credential", failureClass: "malformed_payload" },
      detail:
        "CRYSK_OPENCODE_OPENAI_OAUTH is not base64 (encode the OpenCode auth record with base64 -w0)",
    });
    expect(result.output).toBe("");
  });

  test("an empty input writes no mask and no output, exactly as before", async () => {
    const result = await runSetup({ CRYSK_SECRETS_INPUT: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.output).toBe("");
    expect(result.envFile).toBe("PRE_EXISTING=1\n");
  });

  test("the input reaching bun through its environment is refused before anything runs, never printed", async () => {
    const result = await runSetup(
      { CRYSK_SECRETS_INPUT: SECRETS_INPUT },
      { direct: true },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "crysk: the crysk-secrets input reached setup.ts through its environment",
    );
    expect(result.stderr).not.toContain("SENTINEL");
    expect(result.stdout).toBe("");
    expect(result.output).toBe("");
    expect(result.record).toBeUndefined();
  });

  test("without the stdin flag the script reads no secrets, as before the input existed", async () => {
    const result = await runSetup({}, { direct: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.output).toBe("");
  });

  // U3 (S8/S9, L12 "Building auth.json", L13): the OpenCode auth file is built
  // from the CRYSK_OPENCODE_* secrets, for the providers the person layer's
  // models name (fallbacks included). Assertions read keys, types and
  // booleans, so a failure never prints a credential file.
  const withModels = (models: Record<string, unknown[]>) => ({
    platform: { person: { models }, repo: {} },
  });
  const secretsLines = (...lines: string[]) => lines.join("\n");

  test("an _API_KEY becomes an api record, 0600, for the providers the models name only", async () => {
    const result = await runSetup(
      { CRYSK_SECRETS_INPUT: SECRETS_INPUT },
      withModels({
        default: ["claude:sonnet-latest"],
        "hunter.logic": [
          "claude:sonnet-latest",
          "opencode:deepseek/deepseek-chat",
        ],
      }),
    );
    expect(result.exitCode).toBe(0);
    const auth = result.auth ?? {};
    // openai has a secret too, but no model names it.
    expect(Object.keys(auth)).toEqual(["deepseek"]);
    expect(Object.keys(auth.deepseek ?? {}).sort()).toEqual(["key", "type"]);
    expect(auth.deepseek?.type).toBe("api");
    expect(auth.deepseek?.key === "SENTINEL-DEEPSEEK-55aa").toBe(true);
    expect(result.authMode).toBe(0o600);
    expect(result.manifestMode).toBe(0o600);
    expect(JSON.parse(result.manifestText ?? "null")).toEqual({
      v: 1,
      source: "crysk-secrets",
      providers: {
        deepseek: {
          secret: "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
          kind: "api_key",
        },
      },
    });
    expect(result.stderr).toContain(
      "::notice::OpenCode provider deepseek: CRYSK_OPENCODE_DEEPSEEK_API_KEY (API key) builds its auth record.",
    );
    expect(result.stderr.includes("SENTINEL")).toBe(false);
    expect(
      result.stdout
        .split("\n")
        .every((l) => l === "" || l.startsWith("::add-mask::")),
    ).toBe(true);
  });

  test("the providers are read off object entries too, effort or not (E-g)", async () => {
    const result = await runSetup(
      { CRYSK_SECRETS_INPUT: SECRETS_INPUT },
      withModels({
        default: [{ model: "claude:sonnet-latest", effort: "high" }],
        "hunter.logic": [
          { model: "opencode:deepseek/deepseek-chat", effort: "max" },
        ],
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(Object.keys(result.auth ?? {})).toEqual(["deepseek"]);
    expect(JSON.parse(result.manifestText ?? "null")?.providers).toEqual({
      deepseek: {
        secret: "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
        kind: "api_key",
      },
    });
  });

  test("an openai _OAUTH record is written whole, so the child can refresh it", async () => {
    const result = await runSetup(
      { CRYSK_SECRETS_INPUT: SECRETS_INPUT },
      withModels({ refuter: ["opencode:openai/gpt-5"] }),
    );
    expect(result.exitCode).toBe(0);
    const auth = result.auth ?? {};
    expect(Object.keys(auth)).toEqual(["openai"]);
    const record = auth.openai ?? {};
    expect(Object.keys(record).sort()).toEqual([
      "access",
      "expires",
      "refresh",
      "type",
    ]);
    expect(record.type).toBe("oauth");
    expect(record.access === "SENTINEL-ACCESS-55aa").toBe(true);
    expect(record.refresh === "SENTINEL-REFRESH-55aa").toBe(true);
    expect(record.expires === 1_900_000_000_000).toBe(true);
    expect(result.authMode).toBe(0o600);
  });

  test("with an openai _API_KEY and _OAUTH, the subscription comes first and the choice is recorded", async () => {
    const result = await runSetup(
      {
        CRYSK_SECRETS_INPUT: secretsLines(
          "CRYSK_OPENCODE_OPENAI_API_KEY=SENTINEL-OPENAI-KEY-55aa",
          `CRYSK_OPENCODE_OPENAI_OAUTH=${OAUTH_VALUE}`,
        ),
      },
      withModels({ default: ["opencode:openai/gpt-5"] }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.auth?.openai?.type).toBe("oauth");
    expect(JSON.parse(result.manifestText ?? "null")?.providers).toEqual({
      openai: {
        secret: "CRYSK_OPENCODE_OPENAI_OAUTH",
        kind: "oauth",
        unused: "CRYSK_OPENCODE_OPENAI_API_KEY",
      },
    });
    expect(result.stderr).toContain(
      "::notice::OpenCode provider openai: CRYSK_OPENCODE_OPENAI_OAUTH (subscription) builds its auth record; CRYSK_OPENCODE_OPENAI_API_KEY is not used, because the subscription comes first.",
    );
    expect(result.stderr.includes("SENTINEL")).toBe(false);
  });

  test("another provider's _OAUTH the models use fails the step, naming the secret", async () => {
    const result = await runSetup(
      {
        CRYSK_SECRETS_INPUT: secretsLines(
          "CRYSK_OPENCODE_DEEPSEEK_API_KEY=SENTINEL-DEEPSEEK-55aa",
          `CRYSK_OPENCODE_DEEPSEEK_OAUTH=${OAUTH_VALUE}`,
        ),
      },
      withModels({ default: ["opencode:deepseek/deepseek-chat"] }),
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.record ?? "null")).toEqual({
      v: 1,
      cls: { kind: "credential", failureClass: "malformed_payload" },
      detail:
        "CRYSK_OPENCODE_DEEPSEEK_OAUTH is an OpenCode subscription record, which Crysk reads only for openai for now; set CRYSK_OPENCODE_DEEPSEEK_API_KEY instead",
    });
    expect(result.authText).toBeUndefined();
    expect(result.manifestText).toBeUndefined();
    expect(result.stderr.includes("SENTINEL")).toBe(false);

    // Unused by the models, it is not read at all.
    const unused = await runSetup(
      {
        CRYSK_SECRETS_INPUT: secretsLines(
          `CRYSK_OPENCODE_DEEPSEEK_OAUTH=${OAUTH_VALUE}`,
          "CRYSK_OPENCODE_ZAI_API_KEY=SENTINEL-ZAI-55aa",
        ),
      },
      withModels({ default: ["opencode:zai/glm-5"] }),
    );
    expect(unused.exitCode).toBe(0);
    expect(Object.keys(unused.auth ?? {})).toEqual(["zai"]);
  });

  test("a provider the models name with no CRYSK secret gets a notice naming both secrets", async () => {
    const result = await runSetup(
      {
        CRYSK_SECRETS_INPUT:
          "CRYSK_OPENCODE_DEEPSEEK_API_KEY=SENTINEL-DEEPSEEK-55aa",
      },
      withModels({
        default: ["opencode:deepseek/deepseek-chat", "opencode:zai/glm-5"],
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(Object.keys(result.auth ?? {})).toEqual(["deepseek"]);
    expect(result.stderr).toContain(
      "::notice::OpenCode provider zai: no CRYSK_OPENCODE_ZAI_API_KEY or CRYSK_OPENCODE_ZAI_OAUTH secret is set, so the auth file has no record for it.",
    );
  });

  // D6 (E-f F3): the opencode-auth input is gone. The trigger stops a workflow
  // that passes one (CRYSK-INPUT-REMOVED) and action.yml never binds it here, so
  // a value left in the environment (a job-level env, say) is not read.
  test("an OPENCODE_AUTH_INPUT in the environment is not read, and a manifest an earlier run left is removed", async () => {
    const result = await runSetup(
      {
        OPENCODE_AUTH_INPUT: OPENCODE_CI_AUTH,
        CRYSK_SECRETS_INPUT: "CRYSK_CLAUDE_OAUTH_TOKEN=SENTINEL-OAUTH-55aa",
      },
      {
        ...withModels({ default: ["opencode:deepseek/deepseek-chat"] }),
        // A manifest an earlier CRYSK run left on a runner whose HOME persists.
        prepareHome: async (home) => {
          const file = openCodeSecretManifestPath(
            resolveOpenCodeAuthPath({ HOME: home }, home),
          );
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, "{}\n");
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.authText).toBeUndefined();
    // The manifest describes a file this step built from CRYSK secrets only.
    expect(result.manifestText).toBeUndefined();
    expect(result.output).not.toContain("opencode-auth-file");
    expect(result.stderr).not.toContain("opencode-auth");
  });

  // U5: the Install OpenCode CLI step follows this output, so the CLI is
  // installed when, and only when, this step wrote an OpenCode auth file.
  test("an auth file built from the CRYSK_* secrets reports opencode-auth-file=true", async () => {
    const result = await runSetup(
      { CRYSK_SECRETS_INPUT: SECRETS_INPUT },
      withModels({ default: ["opencode:deepseek/deepseek-chat"] }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output.split("\n")).toContain("opencode-auth-file=true");
  });

  test("OpenCode models with no secret serving them write no auth file and no opencode-auth-file output", async () => {
    const result = await runSetup(
      { CRYSK_SECRETS_INPUT: "CRYSK_CLAUDE_OAUTH_TOKEN=SENTINEL-OAUTH-55aa" },
      withModels({ default: ["opencode:deepseek/deepseek-chat"] }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.authText).toBeUndefined();
    expect(result.output).not.toContain("opencode-auth-file");
  });

  // E-f F3 (D1): a standalone workflow passes the models and credentials as two
  // inputs, filled from vars.CRYSK_MODELS and vars.CRYSK_CREDENTIALS. The setup
  // step reads them with the person parser and writes them as the personal file;
  // a platform person layer wins whole over them.
  describe("the models and credentials inputs (D1)", () => {
    const personOf = (result: { homeFiles: string[] }) =>
      result.homeFiles
        .map((text) => {
          try {
            return JSON.parse(text) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })
        .find(
          (value) =>
            value !== undefined &&
            ("models" in value ||
              "credentials" in value ||
              "max_changed_lines" in value),
        );
    const outputLines = (result: { output: string }) =>
      result.output.split("\n").filter((line) => line !== "");

    test("a standalone models input naming an OpenCode model, with its secret, builds auth.json and reports opencode-models=true", async () => {
      const models = {
        default: ["claude:sonnet-latest"],
        "hunter.logic": ["opencode:deepseek/deepseek-chat"],
      };
      const result = await runSetup({
        MODELS_INPUT: JSON.stringify(models),
        CRYSK_SECRETS_INPUT:
          "CRYSK_OPENCODE_DEEPSEEK_API_KEY=SENTINEL-DEEPSEEK-55aa",
      });
      expect(result.exitCode).toBe(0);
      expect(Object.keys(result.auth ?? {})).toEqual(["deepseek"]);
      expect(result.auth?.deepseek?.type).toBe("api");
      expect(result.auth?.deepseek?.key === "SENTINEL-DEEPSEEK-55aa").toBe(
        true,
      );
      expect(result.authMode).toBe(0o600);
      expect(outputLines(result)).toContain("opencode-auth-file=true");
      expect(outputLines(result)).toContain("opencode-models=true");
      expect(personOf(result)).toEqual({ models });
      expect(result.record).toBeUndefined();
    });

    test("a free OpenCode model with no secret still reports opencode-models=true, with no auth file", async () => {
      const result = await runSetup({
        MODELS_INPUT: JSON.stringify({
          default: ["opencode:opencode/big-pickle"],
        }),
      });
      expect(result.exitCode).toBe(0);
      expect(result.authText).toBeUndefined();
      expect(result.output).toBe("opencode-models=true\n");
    });

    test("Claude-only models report no opencode-models output", async () => {
      const result = await runSetup({
        MODELS_INPUT: JSON.stringify({ default: ["claude:sonnet-latest"] }),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("");
    });

    test("the credentials input lands in the personal file beside the models", async () => {
      const result = await runSetup({
        MODELS_INPUT: JSON.stringify({ default: ["claude:sonnet-latest"] }),
        CREDENTIALS_INPUT: JSON.stringify({
          claude: ["api_key", "subscription"],
        }),
      });
      expect(result.exitCode).toBe(0);
      expect(personOf(result)).toEqual({
        models: { default: ["claude:sonnet-latest"] },
        credentials: { claude: ["api_key", "subscription"] },
      });
    });

    test("an effort entry passes through the person parser", async () => {
      const models = {
        default: [{ model: "claude:sonnet-latest", effort: "high" }],
        "hunter.logic": [
          { model: "opencode:deepseek/deepseek-chat", effort: "max" },
        ],
      };
      const result = await runSetup({
        MODELS_INPUT: JSON.stringify(models),
        CRYSK_SECRETS_INPUT:
          "CRYSK_OPENCODE_DEEPSEEK_API_KEY=SENTINEL-DEEPSEEK-55aa",
      });
      expect(result.exitCode).toBe(0);
      expect(personOf(result)).toEqual({ models });
      expect(Object.keys(result.auth ?? {})).toEqual(["deepseek"]);
    });

    const MODELS_RECORD = (detail: string) => ({
      v: 1,
      cls: { kind: "config-parse", source: "models-input" },
      detail,
    });

    test("a models input that is not JSON fails as models-input with a fixed detail, never echoing it", async () => {
      const result = await runSetup({
        MODELS_INPUT: '{"SENTINEL-MODELS-55aa": ',
        CRYSK_SECRETS_INPUT:
          "CRYSK_OPENCODE_DEEPSEEK_API_KEY=SENTINEL-DEEPSEEK-55aa",
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.record ?? "null")).toEqual(
        MODELS_RECORD("the models input is not valid JSON"),
      );
      expect(result.stderr).toContain("CI models input is not valid JSON");
      for (const text of [result.record, result.stderr, result.output]) {
        expect((text ?? "").includes("SENTINEL")).toBe(false);
      }
      // Nothing is written before the inputs are read.
      expect(result.authText).toBeUndefined();
      expect(personOf(result)).toBeUndefined();
    });

    test("a models input the person parser refuses fails as models-input; the record names the input, never its content", async () => {
      const result = await runSetup({
        MODELS_INPUT: JSON.stringify({
          "SENTINEL-ROLE-55aa": ["claude:sonnet-latest"],
        }),
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.record ?? "null")).toEqual(
        MODELS_RECORD(
          "the models input does not follow the models rules (the setup step's log names the entry)",
        ),
      );
      expect((result.record ?? "").includes("SENTINEL")).toBe(false);
      // The parser's own message, on the step's log, names the role.
      expect(result.stderr).toContain("models has an unknown role");
      expect(personOf(result)).toBeUndefined();
    });

    test("a #variant suffix is refused by the person parser, with the new form on the log", async () => {
      const result = await runSetup({
        MODELS_INPUT: JSON.stringify({
          default: ["opencode:openai/gpt-5#high"],
        }),
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.record ?? "null")).toEqual(
        MODELS_RECORD(
          "the models input does not follow the models rules (the setup step's log names the entry)",
        ),
      );
      expect(result.stderr).toContain("the #variant suffix is gone");
      expect(result.output).toBe("");
    });

    test("a credentials input the person parser refuses fails as credentials-input, naming the credentials input", async () => {
      for (const [raw, detail] of [
        ['{"SENTINEL-CREDS-55aa"', "the credentials input is not valid JSON"],
        [
          JSON.stringify({ claude: ["SENTINEL-CREDS-55aa"] }),
          "the credentials input does not follow the credentials rules (the setup step's log names the entry)",
        ],
      ] as const) {
        const result = await runSetup({
          MODELS_INPUT: JSON.stringify({ default: ["claude:sonnet-latest"] }),
          CREDENTIALS_INPUT: raw,
        });
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.record ?? "null")).toEqual({
          v: 1,
          cls: { kind: "config-parse", source: "credentials-input" },
          detail,
        });
        expect((result.record ?? "").includes("SENTINEL")).toBe(false);
        expect(personOf(result)).toBeUndefined();
      }
    });

    test("with a platform person layer, the platform wins whole and the inputs are ignored with a warning", async () => {
      const result = await runSetup(
        {
          // Malformed on purpose: an ignored input is not even read.
          MODELS_INPUT: '{"SENTINEL-MODELS-55aa": ',
          CREDENTIALS_INPUT: JSON.stringify({ claude: ["api_key"] }),
          CRYSK_SECRETS_INPUT: SECRETS_INPUT,
        },
        withModels({ default: ["opencode:openai/gpt-5"] }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "::warning::The models and credentials inputs are ignored: this repository is connected to the Crysk platform, whose model settings apply.",
      );
      expect(result.stderr.includes("SENTINEL")).toBe(false);
      expect(personOf(result)).toEqual({
        models: { default: ["opencode:openai/gpt-5"] },
      });
      // The providers come from the platform's models, not the input's.
      expect(Object.keys(result.auth ?? {})).toEqual(["openai"]);
      expect(outputLines(result)).toContain("opencode-models=true");
      expect(result.record).toBeUndefined();
    });

    test("a connected run whose platform sent no person layer applies the inputs", async () => {
      const models = { default: ["claude:opus-latest"] };
      const result = await runSetup(
        { MODELS_INPUT: JSON.stringify(models) },
        { platform: { person: {}, repo: {} } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("::warning::");
      expect(personOf(result)).toEqual({ models });
    });

    test("no inputs and no platform: the personal file a self-hosted runner keeps is left alone", async () => {
      const own = { max_changed_lines: 123 };
      const result = await runSetup(
        { MODELS_INPUT: "", CREDENTIALS_INPUT: "  " },
        {
          prepareHome: async (home) => {
            const file = prheroLayout(home).reviewConfigPath;
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, JSON.stringify(own));
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(personOf(result)).toEqual(own);
      expect(result.output).toBe("");
    });
  });
});

describe("action.yml hands crysk-secrets only to the steps that read it", () => {
  type Step = {
    id?: string;
    name?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  };
  const action = Bun.YAML.parse(
    readFileSync(path.resolve(__dirname, "..", "..", "action.yml"), "utf8"),
  ) as {
    inputs: Record<string, { required?: boolean; default?: string }>;
    runs: { steps: Step[] };
  };
  const steps = action.runs.steps;

  test("the input is declared, optional and empty by default", () => {
    expect(action.inputs["crysk-secrets"]?.required).toBe(false);
    expect(action.inputs["crysk-secrets"]?.default).toBe("");
  });

  // The trigger reads it too, for presence (U5); its own test is in
  // test/ci/trigger.test.ts. Run Crysk reads the Claude values (test/ci/run.test.ts
  // and test/packaging.test.ts). No installer sees it.
  test("only the trigger's, the setup step's and Run Crysk's env bind it, and no script, condition or with: names it", () => {
    const binders = steps.filter((step) =>
      JSON.stringify(step).includes("inputs.crysk-secrets"),
    );
    expect(binders.map((step) => step.id)).toEqual([
      "trigger",
      "materialize",
      "run-crysk",
    ]);
    const run = binders[2] as Step;
    expect(run.env?.CRYSK_SECRETS_INPUT).toBe(`\${{ inputs.crysk-secrets }}`);
    expect(run.run ?? "").not.toContain("inputs.crysk-secrets");
    expect(run.if ?? "").not.toContain("crysk-secrets");
    const setup = binders[1] as Step;
    expect(setup.env?.CRYSK_SECRETS_INPUT).toBe(`\${{ inputs.crysk-secrets }}`);
    expect(setup.run ?? "").not.toContain("inputs.crysk-secrets");
    expect(setup.if ?? "").not.toContain("crysk-secrets");
    expect(JSON.stringify(setup.with ?? {})).not.toContain("crysk-secrets");
    // The shell pipes the value on stdin and runs bun with the variable empty.
    expect(setup.run).toBe(
      `printf '%s' "$CRYSK_SECRETS_INPUT" | CRYSK_SECRETS_INPUT= bun "\${{ github.action_path }}/src/ci/setup.ts" --crysk-secrets-stdin`,
    );
  });
});

describe("ci init next steps (CLI)", () => {
  test("say that /crysk review works once the workflow is on the default branch", () => {
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
      expect(output).toContain("/crysk review");
      expect(output).toMatch(/default branch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The first-PR walkthrough. Review instructions are optional (S3), so a repo
// with none is recommended a REVIEW.md, not told it must write one. A file that
// exists but is empty or still the scaffold turns the first PR red
// (CRYSK-GOTCHAS-MISSING), so that one gets the fix steps; real instructions get
// nothing.
// `ci init` through the real CLI, in a scratch repository, with a scratch HOME so
// the person config it reads is the test's (`personConfig`), never the host's.
async function runInit(
  files: Record<string, string> = {},
  personConfig?: unknown,
): Promise<{ output: string; code: number; workflowWritten: boolean }> {
  const root = await mkdtemp(path.join(tmpdir(), "prhero-ci-gotchas-"));
  const dir = path.join(root, "repo");
  const home = path.join(root, "home");
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    if (personConfig !== undefined) {
      await mkdir(path.join(home, ".crysk"), { recursive: true });
      await writeFile(
        path.join(home, ".crysk", "config.json"),
        JSON.stringify(personConfig),
      );
    }
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    for (const [rel, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), contents);
    }
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.join(import.meta.dir, "../../src/cli.ts"),
        "ci",
        "init",
      ],
      { cwd: dir, env: { ...process.env, HOME: home, NO_COLOR: "1" } },
    );
    return {
      output: `${result.stdout}${result.stderr}`,
      code: result.exitCode,
      workflowWritten: existsSync(path.join(dir, CI_WORKFLOW_RELATIVE_PATH)),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ci init review-instructions steps (CLI)", () => {
  test("a repo with no instructions file is recommended a REVIEW.md, as optional, before opening the PR", async () => {
    const { output, code } = await runInit();
    expect(code).toBe(0);
    expect(output).toContain("Optional, recommended: add a REVIEW.md");
    expect(output).not.toContain("human-attention-required");
    expect(output.indexOf("add a REVIEW.md")).toBeLessThan(
      output.indexOf("Open a pull request"),
    );
  });

  test("a scaffold still carrying the marker gets the fix steps for that file", async () => {
    const { output } = await runInit({
      ".crysk/gotchas.md":
        "<!-- human-attention-required: delete -->\n# Repo gotchas\n",
    });
    expect(output).toContain(
      "Write real facts about this repository into .crysk/gotchas.md",
    );
    expect(output).toContain("human-attention-required");
    expect(output).toContain("Commit .crysk/gotchas.md to the default branch");
  });

  test("a REVIEW.md scaffold whose marker line was deleted gets the fix steps naming REVIEW.md", async () => {
    const { output } = await runInit({
      "REVIEW.md":
        "# Review instructions\n\n- <subsystem>: <the naming/ownership rule a newcomer would violate>\n",
    });
    expect(output).toContain(
      "Write real facts about this repository into REVIEW.md",
    );
    expect(output).toContain("or delete REVIEW.md");
    expect(output).toContain("Commit REVIEW.md to the default branch");
  });

  test("an empty REVIEW.md gets the fix steps, never falling through to a real gotchas file", async () => {
    const { output } = await runInit({
      "REVIEW.md": "",
      ".crysk/gotchas.md": "- auth: the token is refreshed by the proxy\n",
    });
    expect(output).toContain(
      "Write real facts about this repository into REVIEW.md",
    );
  });

  test("real gotchas without the marker print no instruction steps, and still name the required check", async () => {
    const { output } = await runInit({
      ".crysk/gotchas.md":
        "- auth: the token is refreshed by the proxy, not here\n",
    });
    expect(output).not.toContain("Write real facts about this repository");
    expect(output).not.toContain("add a REVIEW.md");
    expect(output).not.toContain("human-attention-required");
    expect(output).toContain("require the `crysk` status check");
    expect(output).toContain("GitHub Free");
    // The steps stay numbered 1..n with no gap where the init steps were.
    const numbers = [...output.matchAll(/^ {2}(\d+)\. /gm)].map((m) =>
      Number(m[1]),
    );
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  test("every repo is told to require the crysk status check, not the review job", async () => {
    const { output } = await runInit();
    expect(output).toContain(
      "require the `crysk` status check (not the `review` job; the legacy `pr-hero` status is still posted for one version, so an existing rule on `pr-hero` keeps working)",
    );
  });
});

// E-f F4 (D1, D2): the scaffolded workflow reads the models, the credential order
// and the OpenCode providers from repository variables, so `ci init` prints the
// commands that set them from the person's own config, and the CRYSK_* secrets.
describe("ci init prints the CRYSK_* secrets and the workflow variables (CLI)", () => {
  test("a person config with models, credentials and an OpenCode provider gets every command", async () => {
    const { output, code } = await runInit(
      {},
      {
        models: {
          default: ["claude:sonnet-latest"],
          "hunter.logic": ["opencode:deepseek/deepseek-chat"],
        },
        credentials: { claude: ["api_key", "subscription"] },
      },
    );
    expect(code).toBe(0);
    expect(output).toContain("$ gh secret set CRYSK_CLAUDE_OAUTH_TOKEN");
    expect(output).toContain("$ gh secret set CRYSK_OPENCODE_DEEPSEEK_API_KEY");
    expect(output).toContain(
      '$ gh variable set CRYSK_MODELS --body "$(jq -c .models ~/.crysk/config.json)"',
    );
    expect(output).toContain(
      '$ gh variable set CRYSK_CREDENTIALS --body "$(jq -c .credentials ~/.crysk/config.json)"',
    );
    expect(output).toContain(
      `$ gh variable set CRYSK_OPENCODE_PROVIDERS --body '["DEEPSEEK"]'`,
    );
    expect(output).not.toMatch(
      /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENCODE_AUTH_JSON/,
    );
  });

  test("the judge's models are not forwarded, and OpenAI also gets its subscription command", async () => {
    const { output } = await runInit(
      {},
      {
        models: {
          default: ["opencode:openai/gpt-5"],
          judge: ["opencode:groq/llama"],
        },
      },
    );
    expect(output).toContain(
      `$ gh variable set CRYSK_OPENCODE_PROVIDERS --body '["OPENAI"]'`,
    );
    expect(output).toContain("gh secret set CRYSK_OPENCODE_OPENAI_OAUTH");
    expect(output).not.toContain("CRYSK_CREDENTIALS");
    expect(output).not.toContain("GROQ");
  });

  test("without a person config no variable is printed", async () => {
    const { output, code } = await runInit();
    expect(code).toBe(0);
    expect(output).toContain("$ gh secret set CRYSK_CLAUDE_OAUTH_TOKEN");
    expect(output).not.toContain("gh variable set");
  });

  test("models naming six OpenCode providers are refused before anything is written", async () => {
    const providers = ["a1", "b2", "c3", "d4", "e5", "f6"];
    const { output, code, workflowWritten } = await runInit(
      {},
      {
        models: Object.fromEntries(
          providers.map((p, i) => [
            i === 0 ? "default" : `hunter.h${i}`,
            [`opencode:${p}/model`],
          ]),
        ),
      },
    );
    expect(code).toBe(1);
    expect(workflowWritten).toBe(false);
    expect(output).toContain(
      "name 6 OpenCode providers (a1, b2, c3, d4, e5, f6), but the workflow forwards the keys of at most 5",
    );
  });
});

describe("runCiSetup (impure edge)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("creates .github/workflows/crysk.yml when absent", async () => {
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

  test("writes only the one workflow file, never a force workflow", async () => {
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

// S10: a repo that already has the pre-rename pr-hero.yml keeps it; the code
// never ends with both.
describe("runCiSetup — which workflow file (impure edge)", () => {
  let dir: string;
  const WORKFLOWS = path.join(".github", "workflows");
  const legacyFile = () => path.join(dir, WORKFLOWS, "pr-hero.yml");
  const freshFile = () => path.join(dir, WORKFLOWS, "crysk.yml");

  async function seed(...files: string[]): Promise<void> {
    dir = await mkdtemp(path.join(tmpdir(), "crysk-ci-setup-"));
    await mkdir(path.join(dir, WORKFLOWS), { recursive: true });
    for (const f of files) {
      await writeFile(path.join(dir, WORKFLOWS, f), `# ${f}, customized\n`);
    }
  }

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("--force on a pr-hero.yml repo rewrites that file and never creates crysk.yml", async () => {
    await seed("pr-hero.yml");

    const result = await runCiSetup({ cwd: dir, force: true });

    expect(result).toEqual({ status: "overwritten", path: legacyFile() });
    expect(await readFile(legacyFile(), "utf8")).toBe(
      generateCiWorkflowTemplate(),
    );
    expect(existsSync(freshFile())).toBe(false);
  });

  test("without --force the refusal names the pr-hero.yml that exists, and leaves it alone", async () => {
    await seed("pr-hero.yml");

    const result = await runCiSetup({ cwd: dir });

    expect(result).toEqual({
      status: "skipped-existing",
      path: legacyFile(),
      hint: `${path.join(WORKFLOWS, "pr-hero.yml")} already exists; pass --force to overwrite it`,
    });
    expect(await readFile(legacyFile(), "utf8")).toBe(
      "# pr-hero.yml, customized\n",
    );
    expect(existsSync(freshFile())).toBe(false);
  });

  test("a crysk.yml repo is acted on by name: the refusal names crysk.yml", async () => {
    await seed("crysk.yml");

    const result = await runCiSetup({ cwd: dir });

    expect(result.status).toBe("skipped-existing");
    if (result.status !== "skipped-existing") return;
    expect(result.path).toBe(freshFile());
    expect(result.hint).toContain("crysk.yml already exists");
  });

  test.each([false, true])(
    "both files present (force: %p): nothing is written, the reason names both",
    async (force) => {
      await seed("crysk.yml", "pr-hero.yml");

      const result = await runCiSetup({ cwd: dir, force });

      expect(result.status).toBe("refused-duplicate");
      if (result.status !== "refused-duplicate") return;
      expect(result.hint).toContain("crysk.yml");
      expect(result.hint).toContain("pr-hero.yml");
      expect(result.hint).toContain("review every pull request twice");
      expect(await readFile(freshFile(), "utf8")).toBe(
        "# crysk.yml, customized\n",
      );
      expect(await readFile(legacyFile(), "utf8")).toBe(
        "# pr-hero.yml, customized\n",
      );
    },
  );
});

describe("checkCiConfiguration — either workflow file, never both", () => {
  const root = "/repo";
  const at = (file: string) => path.join(root, ".github", "workflows", file);

  test("a pre-rename pr-hero.yml counts as configured and is named", () => {
    const status = checkCiConfiguration({
      cwd: root,
      isCi: false,
      exists: (p) => p === at("pr-hero.yml"),
    });
    expect(status.configured).toBe(true);
    expect(status.message).toContain("pr-hero.yml");
  });

  test("crysk.yml counts as configured and is named", () => {
    const status = checkCiConfiguration({
      cwd: root,
      isCi: false,
      exists: (p) => p === at("crysk.yml"),
    });
    expect(status.configured).toBe(true);
    expect(status.message).toContain("crysk.yml");
  });

  test("both present is not configured: the reason is the double review", () => {
    const status = checkCiConfiguration({
      cwd: root,
      isCi: false,
      exists: (p) => p === at("crysk.yml") || p === at("pr-hero.yml"),
    });
    expect(status.configured).toBe(false);
    expect(status.message).toContain("crysk.yml");
    expect(status.message).toContain("pr-hero.yml");
    expect(status.message).toContain("review every pull request twice");
  });

  test("the setup hint scaffolds crysk.yml", () => {
    const status = checkCiConfiguration({
      cwd: root,
      isCi: false,
      exists: () => false,
    });
    expect(status.hint).toContain(".github/workflows/crysk.yml");
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
    expect(status.message).toContain("CRYSK_CLAUDE_OAUTH_TOKEN");
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
    expect(status.message).toContain("CRYSK_CLAUDE_OAUTH_TOKEN");
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

  test("local repo context: a repo on the pre-rename pr-hero.yml is healthy", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      repoRoot: "/repo",
      home: "/home/user",
      exists: (p) => p === path.join("/repo", LEGACY_CI_WORKFLOW_RELATIVE_PATH),
      readFile: () => undefined,
      checkToolsOptions: { ...installedTools, env: {} },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("healthy");
    expect(ciCheck?.message).toContain("pr-hero.yml");
  });

  test("local repo context: both workflow files is degraded, naming the double review", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      repoRoot: "/repo",
      home: "/home/user",
      exists: (p) =>
        p === path.join("/repo", CI_WORKFLOW_RELATIVE_PATH) ||
        p === path.join("/repo", LEGACY_CI_WORKFLOW_RELATIVE_PATH),
      readFile: () => undefined,
      checkToolsOptions: { ...installedTools, env: {} },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("degraded");
    expect(ciCheck?.message).toContain("review every pull request twice");
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
    expect(ciCheck?.message).toContain("CRYSK_CLAUDE_OAUTH_TOKEN");
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
      (line) =>
        line.trim().startsWith("uses:") && /crysk|pr-hero|\.\//.test(line),
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

// `/crysk recheck` is accepted wherever `/crysk review` is, in both names: the job's
// `if:` and the concurrency group, so the scaffolded workflow starts the same run.
describe("the scaffolded workflow accepts recheck beside review", () => {
  test.each([
    ["/crysk review", "/crysk recheck"],
    ["/pr-hero review", "/pr-hero recheck"],
  ])(
    "the if and concurrency clauses for %s are mirrored for %s",
    (review, recheck) => {
      const template = generateCiWorkflowTemplate();
      const count = (command: string) =>
        template.split(`startsWith(github.event.comment.body, '${command}')`)
          .length - 1;
      expect(count(review)).toBeGreaterThan(0);
      expect(count(recheck)).toBe(count(review));
    },
  );

  test("the comments name /crysk recheck beside review and override", () => {
    const template = generateCiWorkflowTemplate();
    expect(template).toContain(
      "A comment that is exactly\n# `/crysk recheck` reviews the head",
    );
    expect(template).toContain(
      "BEGINS with `/crysk review`,\n    # `/crysk recheck` or `/crysk override`",
    );
    expect(template).toContain(
      "starts with\n    # /crysk review, /crysk recheck or /crysk override",
    );
  });
});
