// What init writes and sets, checked against the product's own parsers and
// renderers. A value that only looks right to this file is not enough: the
// models value must go through the CI setup step's own materializer, and the repo
// config must load through parseLocalConfig, because a rejected config burns a live
// run as CRYSK-CONFIG-INVALID.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { planCiReviewManualRequired } from "#ci/gates";
import { resolveCiReviewPolicy } from "#ci/review-admission";
import { GOTCHAS, VOLUME_BUGGY } from "../../fixtures/setup";
import {
  OUTCOME_MARKER_PREFIX,
  OVERRIDE_MARKER_PREFIX,
  SKIP_MARKERS,
  STATUS_CONTEXT,
} from "../../scripts/sandbox/markers";
import {
  classifyComment,
  END_OF_BUDGET_SENTENCE,
} from "../../scripts/sandbox/observe";
import { SANDBOX_REPO } from "../../scripts/sandbox/rails";
import {
  actionRefFor,
  BUDGET_ONE_CONFIG_JSON,
  GOTCHAS_PATH,
  MODELS_VARIABLE,
  modelsValueFor,
  PLANTED_SITE,
  parseRoute,
  REPO_CONFIG_JSON,
  sandboxFiles,
  VOLUME_PATH,
  WORKFLOW_PATH,
  workflowFor,
} from "../../scripts/sandbox/seed";
import { parseCryskSecrets } from "../../src/ci/crysk-secrets";
import { MODELS_INPUT_LINE } from "../../src/ci/outcome";
import { decidePublication, runPublish } from "../../src/ci/publish";
import { materializeCiOpenCodeData } from "../../src/ci/setup";
import { prheroLayout } from "../../src/home-preflight";
import {
  gotchasUnusableReason,
  parseGlobalConfig,
  parseLocalConfig,
} from "../../src/review/preflight";
import { resolveOpenCodeAuthPath } from "../../src/security/credential-broker";

const REF = "v0.3.0";
let home: string | undefined;

afterEach(async () => {
  if (home !== undefined) await rm(home, { recursive: true, force: true });
  home = undefined;
});

describe("workflow", () => {
  test("is the product renderer's output pinned to the ref, with budget-usd 0", () => {
    const wf = workflowFor(REF);
    expect(actionRefFor(REF)).toBe("cryskai/crysk@v0.3.0");
    expect(wf).toContain("uses: cryskai/crysk@v0.3.0");
    expect(wf).not.toContain("uses: ./");
    expect(wf).toContain("budget-usd: 0");
    // forceEngineFromPr is the `./`-only path; a published tag must not get it.
    expect(wf).not.toContain("Resolve the pull request head");
  });

  test("wires the models variable and the Claude subscription secret into the action", () => {
    const parsed = Bun.YAML.parse(workflowFor(REF)) as {
      jobs: {
        review: { steps: { id?: string; with?: Record<string, string> }[] };
      };
    };
    const step = parsed.jobs.review.steps.find((s) => s.id === "pr-hero");
    // GitHub Actions expressions, not JS templates: the braces are literal.
    expect(`models: ${step?.with?.models}`).toBe(MODELS_INPUT_LINE);
    expect(MODELS_INPUT_LINE).toContain(`vars.${MODELS_VARIABLE}`);
    expect(step?.with?.["crysk-secrets"]).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax
      "CRYSK_CLAUDE_OAUTH_TOKEN=${{ secrets.CRYSK_CLAUDE_OAUTH_TOKEN }}",
    );
    // The removed inputs are not passed: the trigger would stop the run.
    for (const removed of [
      "routing",
      "opencode-auth",
      "claude-token",
      "anthropic-api-key",
    ]) {
      expect(step?.with?.[removed]).toBeUndefined();
    }
  });

  test("the sandbox files carry the workflow at its canonical path", () => {
    expect(sandboxFiles(REF).get(WORKFLOW_PATH)).toBe(workflowFor(REF));
  });
});

describe("repo config", () => {
  test("loads through the real repo-config parser with the permissive admission policy", () => {
    const layer = parseLocalConfig(REPO_CONFIG_JSON);
    expect(layer.ci_review_policy).toBe("every_push");
    expect(layer.ci_max_attempts).toBe(100);
  });

  test("the budget scenarios' config loads through the real parser, with a budget of one", () => {
    const layer = parseLocalConfig(BUDGET_ONE_CONFIG_JSON);
    expect(layer.ci_review_policy).toBe("every_push");
    expect(layer.ci_max_attempts).toBe(1);
    // Admission resolves it to one automatic review on every push.
    const policy = resolveCiReviewPolicy(layer);
    expect(policy.mode).toBe("every_push");
    expect(policy.maxAttempts).toBe(1);
  });

  test("models are person-layer only, so the repo file must not carry them", () => {
    expect(() =>
      parseLocalConfig(
        JSON.stringify({ models: JSON.parse(modelsValueFor("big-pickle")) }),
      ),
    ).toThrow();
  });
});

describe("gotchas", () => {
  test("pass the fail-loud gate and describe the sandbox's real contract", () => {
    expect(gotchasUnusableReason(GOTCHAS)).toBeUndefined();
    expect(sandboxFiles(REF).get(GOTCHAS_PATH)).toBe(GOTCHAS);
  });
});

describe("models value", () => {
  test("refuses a snapshot outside letters, digits, . and -, since it is written into the models JSON", () => {
    for (const bad of ["", "a b", "a/b", "x;y", 'a"b']) {
      expect(() => modelsValueFor(bad)).toThrow(/not valid/);
    }
  });

  test("routes every role through the default list to one free OpenCode model, and parses through the real config parser", () => {
    const value = modelsValueFor("deepseek-v4.1-flash-free");
    expect(JSON.parse(value)).toEqual({
      default: ["opencode:opencode/deepseek-v4.1-flash-free"],
    });
    expect(
      parseGlobalConfig(JSON.stringify({ models: JSON.parse(value) })).models,
    ).toEqual(JSON.parse(value));
  });

  test("--route parses to claude, or to an OpenCode snapshot, and anything else is an error", () => {
    expect(parseRoute("claude")).toEqual({ route: { kind: "claude" } });
    expect(parseRoute("opencode:glm-5.3-flash-free")).toEqual({
      route: { kind: "opencode", modelSnapshot: "glm-5.3-flash-free" },
    });
    for (const bad of ["", "opencode:", "opencode:a b", "Claude", "gemini"]) {
      expect("error" in parseRoute(bad)).toBe(true);
    }
  });

  // The variable reaches the setup step as the `models` input (MODELS_INPUT). The
  // real CI materializer writes it as the person config and reports an OpenCode
  // model, which turns on the Install OpenCode CLI step; a free model needs no
  // CRYSK_OPENCODE_* secret, so no auth file is written.
  test("is what the real CI materializer writes as the person config, with an OpenCode model and no auth file", async () => {
    home = await mkdtemp(path.join(tmpdir(), "crysk-sandbox-seed-"));
    const env = { HOME: home };
    const result = await materializeCiOpenCodeData({
      home,
      env,
      modelsInput: modelsValueFor("big-pickle"),
      // The sandbox's secrets as the scaffold renders them with only the token set:
      // every other line arrives empty.
      cryskSecrets: parseCryskSecrets(
        "CRYSK_CLAUDE_OAUTH_TOKEN=fixture-token\nCRYSK_CLAUDE_API_KEY=\nCRYSK_OPENCODE_OPENAI_OAUTH=\nCRYSK_OPENCODE__API_KEY=\n",
      ),
    });
    expect(result.openCodeModels).toBe(true);
    expect(result.openCodeAuthWritten).toBe(false);
    const written = JSON.parse(
      await readFile(prheroLayout(home).reviewConfigPath, "utf8"),
    );
    expect(written).toEqual({
      models: { default: ["opencode:opencode/big-pickle"] },
    });
    expect(existsSync(resolveOpenCodeAuthPath(env, home))).toBe(false);
  });
});

describe("the override marker pinned against the product's publisher", () => {
  test("the override comment the publisher posts starts with OVERRIDE_MARKER_PREFIX", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prhero-seed-override-"));
    try {
      await writeFile(
        path.join(dir, "trigger.json"),
        JSON.stringify({
          v: 1,
          decision: "override",
          params: {},
          pr: 7,
          head_sha: "a".repeat(40),
          actor: "maintainer",
          repository: SANDBOX_REPO,
          run_id: "1",
          run_attempt: 1,
          run_url: "https://example.invalid/run/1",
        }),
      );
      const posted: string[] = [];
      runPublish({
        env: {
          CRYSK_OUTCOME_DIR: dir,
          GITHUB_REPOSITORY: SANDBOX_REPO,
          GITHUB_RUN_ID: "1",
        },
        gh: (args, stdin) => {
          if (args.includes("POST") && stdin !== undefined) posted.push(stdin);
          return {
            exitCode: 0,
            stdout: args.includes("POST") ? JSON.stringify([2, "bot"]) : "",
            stderr: "",
          };
        },
        stdout: () => {},
        appendSummary: () => {},
      });
      expect(posted).toHaveLength(1);
      expect(posted[0]?.startsWith(OVERRIDE_MARKER_PREFIX)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("markers pinned against the product's publisher", () => {
  test("the outcome marker and the status context are the ones decidePublication writes", () => {
    const publication = decidePublication({
      record: {
        v: 1,
        decision: "no-credentials",
        params: { pr: 7 },
        pr: 7,
        head_sha: "a".repeat(40),
        repository: SANDBOX_REPO,
        run_id: "1",
        run_attempt: 1,
        run_url: "https://example.invalid/run/1",
      },
      cliStarted: false,
    });
    expect(publication.kind).toBe("remote");
    if (publication.kind !== "remote") return;
    expect(publication.commentBody.startsWith(OUTCOME_MARKER_PREFIX)).toBe(
      true,
    );
    expect(publication.status?.context).toBe(STATUS_CONTEXT);
  });
});

describe("the end-of-budget sentence pinned against the product's notice (S10)", () => {
  test("planCiReviewManualRequired's comment opens with the marker and states END_OF_BUDGET_SENTENCE", () => {
    const plan = planCiReviewManualRequired({
      prNumber: 7,
      ciMode: "gate",
      verdict: {
        action: "manual-required",
        reason: "max-attempts-exhausted",
        prior: { blocking: 1, advisory: 0, score: 3, source: "none" },
        reviewCount: 1,
        maxAttempts: 1,
        minScore: 4,
      },
    });
    expect(plan.comment.split("\n", 1)[0]).toBe(
      SKIP_MARKERS["manual-required"],
    );
    expect(plan.comment).toContain(END_OF_BUDGET_SENTENCE);
    expect(classifyComment(plan.comment, "issue")).toEqual({
      source: "issue",
      kind: "skip",
      skip: "manual-required",
      endOfBudget: true,
    });
  });
});

describe("PLANTED_SITE: the planted bug's answer-key range (review-free)", () => {
  test("names the planted volume file, over the whole buggy file", () => {
    expect(PLANTED_SITE.path).toBe(VOLUME_PATH);
    expect(PLANTED_SITE.lineMin).toBe(1);
    // The buggy file's line count, read from its fixture: 4 lines of code and the closing brace.
    expect(PLANTED_SITE.lineMax).toBe(
      VOLUME_BUGGY.trimEnd().split("\n").length,
    );
    expect(PLANTED_SITE.lineMax).toBe(5);
  });
});
