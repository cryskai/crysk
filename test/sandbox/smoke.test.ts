// smoke, end to end under fakes: the planted-bug PR, the poll, the collection,
// the report, and the cleanup. The world object is what the fake GitHub holds;
// tests change it between calls to script a run that completes late, times out,
// or leaves a PR open from an earlier run.

import { describe, expect, test } from "bun:test";
import { RUN_STEP_NAME, WORKFLOW_NAME } from "../../scripts/sandbox/markers";
import { SANDBOX_REPO } from "../../scripts/sandbox/rails";
import {
  sandboxFiles,
  WORKFLOW_PATH,
  workflowFor,
} from "../../scripts/sandbox/seed";
import { runSmoke } from "../../scripts/sandbox/smoke";
import { fail, type Harness, HEAD_SHA, harness, ok } from "./fakes";

const PR_NUMBER = 7;
const PR_URL = `https://github.com/${SANDBOX_REPO}/pull/${PR_NUMBER}`;
const REPORT_COMMENT = `<!-- pr-hero-report head=${HEAD_SHA} -->\n\n# pr-hero review`;

interface Run {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string;
  workflowName: string;
}

interface World {
  openPrs: { number: number; headRefName: string; url: string }[];
  runPolls: Run[][];
  stepConclusion: string;
  runStatus: string;
  statusState: { state: string; description: string } | undefined;
  issueComments: string[];
  inlineComments: string[];
  artifacts: string[];
  remoteFiles: Map<string, string>;
  statusFails: boolean;
}

function world(overrides: Partial<World> = {}): World {
  return {
    openPrs: [],
    runPolls: [[completedRun()]],
    stepConclusion: "success",
    runStatus: "completed",
    statusState: { state: "success", description: "review posted" },
    issueComments: [REPORT_COMMENT],
    inlineComments: [],
    artifacts: [`pr-hero-run-${PR_NUMBER}-${HEAD_SHA}`],
    remoteFiles: sandboxFiles("v0.2.0"),
    statusFails: false,
    ...overrides,
  };
}

function completedRun(): Run {
  return {
    databaseId: 42,
    headSha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    url: "https://github.com/juanmaagd/pr-hero-sandbox/actions/runs/42",
    workflowName: WORKFLOW_NAME,
  };
}

function ghFor(w: World) {
  return (args: readonly string[], h: Harness) => {
    if (args[0] === "pr" && args[1] === "list")
      return ok(JSON.stringify(w.openPrs));
    if (args[0] === "repo" && args[1] === "clone") {
      h.workspace.seed(args[3] ?? "", w.remoteFiles);
      return ok();
    }
    if (args[0] === "pr" && args[1] === "create") return ok(`${PR_URL}\n`);
    if (args[0] === "pr" && args[1] === "close") return ok();
    if (args[0] === "run" && args[1] === "list") {
      const page =
        w.runPolls.length > 1
          ? (w.runPolls.shift() ?? [])
          : (w.runPolls[0] ?? []);
      return ok(JSON.stringify(page));
    }
    if (args[0] === "run" && args[1] === "view") {
      return ok(
        JSON.stringify({
          status: w.runStatus,
          conclusion: w.runStatus === "completed" ? "success" : null,
          url: "u",
          jobs: [
            {
              name: "review",
              conclusion: w.stepConclusion,
              steps: [{ name: RUN_STEP_NAME, conclusion: w.stepConclusion }],
            },
          ],
        }),
      );
    }
    if (args[0] === "api") {
      const path = String(args[1]);
      if (args[2] === "-X") return ok();
      if (path.includes("/commits/")) {
        if (w.statusFails) return fail("HTTP 502: Bad Gateway");
        return ok(
          JSON.stringify({
            statuses:
              w.statusState === undefined
                ? []
                : [{ context: "pr-hero", ...w.statusState }],
          }),
        );
      }
      if (path.includes("/issues/")) {
        return ok(JSON.stringify(w.issueComments.map((body) => ({ body }))));
      }
      if (path.includes("/pulls/")) {
        return ok(JSON.stringify(w.inlineComments.map((body) => ({ body }))));
      }
      if (path.endsWith("/artifacts")) {
        return ok(
          JSON.stringify({ artifacts: w.artifacts.map((name) => ({ name })) }),
        );
      }
    }
    return ok();
  };
}

const SMOKE = {
  ref: "v0.2.0",
  keep: false,
  pollIntervalMs: 15_000,
  timeoutMs: 60_000,
};

describe("smoke: serialization", () => {
  test("refuses to start while a sandbox/ PR is open, and opens nothing", async () => {
    const w = world({
      openPrs: [
        { number: 3, headRefName: "sandbox/smoke-20261015T100000Z", url: "u3" },
      ],
    });
    const h = harness({ gh: ghFor(w) });
    const code = await runSmoke(h.deps, { ref: SMOKE.ref, keep: false });
    expect(code).toBe(1);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(
      false,
    );
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
    expect(
      h.logs.some((l) => l.includes("sandbox/smoke-20261015T100000Z")),
    ).toBe(true);
  });

  test("an open PR outside sandbox/ does not block", async () => {
    const w = world({
      openPrs: [{ number: 4, headRefName: "feat/x", url: "u4" }],
    });
    const h = harness({ gh: ghFor(w) });
    expect(await runSmoke(h.deps, SMOKE)).toBe(0);
  });
});

describe("smoke: the planted-bug PR", () => {
  test("a reviewed head exits 0, prints the PR URL before cleanup, and closes the PR with its branch", async () => {
    const h = harness({ gh: ghFor(world()) });
    const code = await runSmoke(h.deps, SMOKE);
    expect(code).toBe(0);
    expect(h.logs.some((l) => /path\s+reviewed/.test(l))).toBe(true);

    const urlAt = h.events.findIndex((e) => e.includes(PR_URL));
    const closeAt = h.events.findIndex((e) => e.startsWith("gh pr close"));
    expect(urlAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(urlAt);
    expect(h.ghCalls).toContainEqual([
      "pr",
      "close",
      String(PR_NUMBER),
      "-R",
      SANDBOX_REPO,
      "--delete-branch",
    ]);
  });

  test("--keep leaves the PR open", async () => {
    const h = harness({ gh: ghFor(world()) });
    expect(await runSmoke(h.deps, { ...SMOKE, keep: true })).toBe(0);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(
      false,
    );
  });

  test("commits the planted volume bug on a branch off main, pinned to the ref", async () => {
    const h = harness({ gh: ghFor(world()) });
    await runSmoke(h.deps, SMOKE);
    const messages = h.gitCalls
      .filter((c) => c.args[0] === "commit")
      .map((c) => c.args[2]);
    expect(messages).toEqual(["refactor: simplify volume scaling"]);
    const branch =
      h.gitCalls.find((c) => c.args[0] === "checkout")?.args[2] ?? "";
    expect(branch).toMatch(/^sandbox\/smoke-\d{8}T\d{6}Z$/);
    expect(h.gitCalls.map((c) => c.args)).toContainEqual([
      "push",
      "-u",
      "origin",
      branch,
    ]);
  });

  test("a branch whose workflow pins another ref gets a pin commit first", async () => {
    const w = world({ remoteFiles: sandboxFiles("v0.1.0") });
    const h = harness({ gh: ghFor(w) });
    await runSmoke(h.deps, { ...SMOKE, ref: "v0.2.0" });
    const messages = h.gitCalls
      .filter((c) => c.args[0] === "commit")
      .map((c) => c.args[2]);
    expect(messages).toEqual([
      "sandbox: pin action to v0.2.0",
      "refactor: simplify volume scaling",
    ]);
    expect(h.gitCalls.map((c) => c.args)).toContainEqual([
      "add",
      "--",
      WORKFLOW_PATH,
    ]);
    expect(workflowFor("v0.2.0")).toContain("uses: juanmaagd/pr-hero@v0.2.0");
  });
});

describe("smoke: polling", () => {
  test("waits on the head's run at the injected interval until it completes", async () => {
    const inProgress: Run = {
      ...completedRun(),
      status: "in_progress",
      conclusion: null,
    };
    const w = world({
      runPolls: [[inProgress], [inProgress], [completedRun()]],
      runStatus: "completed",
    });
    const h = harness({ gh: ghFor(w) });
    expect(await runSmoke(h.deps, SMOKE)).toBe(0);
    expect(h.clock.sleeps).toEqual([15_000, 15_000]);
  });

  test("a run that never completes times out, still collects, and still closes the PR", async () => {
    const inProgress: Run = {
      ...completedRun(),
      status: "in_progress",
      conclusion: null,
    };
    const w = world({
      runPolls: [[inProgress]],
      runStatus: "in_progress",
      statusState: undefined,
      issueComments: [],
    });
    const h = harness({ gh: ghFor(w) });
    const code = await runSmoke(h.deps, {
      ref: "v0.2.0",
      keep: false,
      pollIntervalMs: 15_000,
      timeoutMs: 30_000,
    });
    expect(code).toBe(1);
    expect(h.logs.some((l) => l.includes("timed out"))).toBe(true);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(true);
  });

  test("a run on an earlier head is never read as this head's run", async () => {
    // Only a stale run is listed, and this head has no evidence yet: the poll
    // must keep waiting, must not look at the stale run, and must not call it reviewed.
    const stale: Run = { ...completedRun(), headSha: "c".repeat(40) };
    const w = world({
      runPolls: [[stale]],
      statusState: undefined,
      issueComments: [],
      artifacts: [],
    });
    const h = harness({ gh: ghFor(w) });
    const code = await runSmoke(h.deps, {
      ref: "v0.2.0",
      keep: false,
      pollIntervalMs: 15_000,
      timeoutMs: 30_000,
    });
    expect(code).toBe(1);
    expect(h.clock.sleeps.length).toBeGreaterThan(0);
    expect(h.ghCalls.some((c) => c[0] === "run" && c[1] === "view")).toBe(
      false,
    );
  });
});

describe("smoke: cleanup", () => {
  test("runs after a collection failure, and the exit code is 1", async () => {
    const h = harness({ gh: ghFor(world({ statusFails: true })) });
    const code = await runSmoke(h.deps, SMOKE);
    expect(code).toBe(1);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(true);
  });

  test("a failed close turns a passing run into exit 1", async () => {
    const script = ghFor(world());
    const h = harness({
      gh: (args, hh) =>
        args[0] === "pr" && args[1] === "close"
          ? fail("boom")
          : script(args, hh),
    });
    expect(await runSmoke(h.deps, SMOKE)).toBe(1);
  });
});

describe("smoke: refusals", () => {
  test("a ref with shell or YAML metacharacters is refused before any call", async () => {
    const h = harness({ gh: ghFor(world()) });
    await expect(
      runSmoke(h.deps, { ref: "v0.2.0\nuses: ./", keep: false }),
    ).rejects.toThrow();
    expect(h.ghCalls).toEqual([]);
  });
});
