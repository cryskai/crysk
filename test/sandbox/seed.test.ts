// What init writes and sets, checked against the product's own parsers and
// renderers. A value that only looks right to this file is not enough: the
// routing string must parse through parseRoutingConfig and resolve to an
// OpenCode route, and the repo config must load through parseLocalConfig,
// because a rejected config burns a live run as PRH-CONFIG-INVALID.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GOTCHAS, VOLUME_BUGGY } from "../../fixtures/setup";
import {
  OUTCOME_MARKER_PREFIX,
  OVERRIDE_MARKER_PREFIX,
  STATUS_CONTEXT,
} from "../../scripts/sandbox/markers";
import { SANDBOX_REPO } from "../../scripts/sandbox/rails";
import {
  actionRefFor,
  GOTCHAS_PATH,
  OPENCODE_AUTH_VALUE,
  PLANTED_SITE,
  parseRoute,
  REPO_CONFIG_JSON,
  routingValueFor,
  sandboxFiles,
  VOLUME_PATH,
  WORKFLOW_PATH,
  workflowFor,
} from "../../scripts/sandbox/seed";
import { decidePublication, runPublish } from "../../src/ci/publish";
import { materializeCiOpenCodeData } from "../../src/ci/setup";
import { prheroLayout } from "../../src/home-preflight";
import { resolveModelRoute } from "../../src/model/routing";
import {
  gotchasUnusableReason,
  parseLocalConfig,
  parseRoutingConfig,
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
    expect(actionRefFor(REF)).toBe("juanmaagd/pr-hero@v0.3.0");
    expect(wf).toContain("uses: juanmaagd/pr-hero@v0.3.0");
    expect(wf).not.toContain("uses: ./");
    expect(wf).toContain("budget-usd: 0");
    // forceEngineFromPr is the `./`-only path; a published tag must not get it.
    expect(wf).not.toContain("Resolve the pull request head");
  });

  test("wires the routing variable and the OpenCode secret into the action", () => {
    const parsed = Bun.YAML.parse(workflowFor(REF)) as {
      jobs: {
        review: { steps: { id?: string; with?: Record<string, string> }[] };
      };
    };
    const step = parsed.jobs.review.steps.find((s) => s.id === "pr-hero");
    // GitHub Actions expressions, not JS templates: the braces are literal.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax
    expect(step?.with?.routing).toBe("${{ vars.PRHERO_ROUTING }}");
    expect(step?.with?.["opencode-auth"]).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax
      "${{ secrets.OPENCODE_AUTH_JSON }}",
    );
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

  test("routing is person-layer only, so the repo file must not carry it", () => {
    expect(() =>
      parseLocalConfig(
        JSON.stringify({ routing: JSON.parse(routingValueFor("big-pickle")) }),
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

describe("routing value", () => {
  test("parses through the real parser and resolves every role to the snapshot it names", () => {
    for (const snapshot of ["big-pickle", "deepseek-v4.1-flash-free"]) {
      const routing = parseRoutingConfig(
        JSON.parse(routingValueFor(snapshot)),
        "~/.prhero/config.json",
      );
      for (const logical of [
        "sonnet",
        "opus",
        "haiku",
        `opencode/${snapshot}`,
      ]) {
        const route = resolveModelRoute(logical, routing);
        expect({
          backend: route.backend,
          provider: route.provider,
          model: route.modelSnapshot,
        }).toEqual({
          backend: "opencode",
          provider: "opencode",
          model: snapshot,
        });
      }
    }
  });

  test("refuses a snapshot outside letters, digits, . and -, since it is written into the routing JSON", () => {
    for (const bad of ["", "a b", "a/b", "x;y", 'a"b']) {
      expect(() => routingValueFor(bad)).toThrow(/not valid/);
    }
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

  test("is accepted by the real CI materializer with the {} auth secret", async () => {
    home = await mkdtemp(path.join(tmpdir(), "pr-hero-sandbox-seed-"));
    const env = { HOME: home };
    await materializeCiOpenCodeData({
      routing: routingValueFor("big-pickle"),
      opencodeAuth: OPENCODE_AUTH_VALUE,
      home,
      env,
    });
    const layer = JSON.parse(
      await readFile(prheroLayout(home).reviewConfigPath, "utf8"),
    ) as {
      routing: { default: { backend: string; modelSnapshot: string } };
    };
    expect(layer.routing.default.backend).toBe("opencode");
    expect(layer.routing.default.modelSnapshot).toBe("big-pickle");
    expect(await readFile(resolveOpenCodeAuthPath(env, home), "utf8")).toBe(
      "{}",
    );
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
          PRHERO_OUTCOME_DIR: dir,
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
