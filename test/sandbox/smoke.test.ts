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

// What gh returns for an open PR. Only a same-repo PR owned by the sandbox owner
// is a scenario PR, so the fixtures say so unless a test is about a fork.
interface OpenPr {
  number: number;
  headRefName: string;
  url: string;
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string } | null;
}

const SAME_REPO = {
  isCrossRepository: false,
  headRepositoryOwner: { login: "juanmaagd" },
};

interface World {
  openPrs: OpenPr[];
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
        {
          number: 3,
          headRefName: "sandbox/smoke-20261015T100000Z",
          url: "u3",
          ...SAME_REPO,
        },
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
      openPrs: [{ number: 4, headRefName: "feat/x", url: "u4", ...SAME_REPO }],
    });
    const h = harness({ gh: ghFor(w) });
    expect(await runSmoke(h.deps, SMOKE)).toBe(0);
  });

  test("a fork PR on a sandbox/ branch does not block the run", async () => {
    const w = world({
      openPrs: [
        {
          number: 9,
          headRefName: "sandbox/x",
          url: "u9",
          isCrossRepository: true,
          headRepositoryOwner: { login: "stranger" },
        },
      ],
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
    // smoke is the review-free scenario, so its branch is named after it.
    expect(branch).toMatch(/^sandbox\/review-free-\d{8}T\d{6}Z$/);
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

  test("a run that never completes is cancelled, and its PR is left open for clean", async () => {
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
      cancelWaitMs: 30_000,
    });
    expect(code).toBe(1);
    expect(h.logs.some((l) => l.includes("timed out"))).toBe(true);
    expect(h.logs.some((l) => l.includes("left open"))).toBe(true);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(
      false,
    );
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

describe("smoke: a run that outlives the poll", () => {
  test("a timed-out run is cancelled, its completion awaited, and only then the PR closed", async () => {
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
    const base = ghFor(w);
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "run" && args[1] === "cancel") {
          w.runStatus = "completed";
          return ok();
        }
        return base(args, hh);
      },
    });
    const code = await runSmoke(h.deps, {
      ref: "v0.2.0",
      keep: false,
      pollIntervalMs: 15_000,
      timeoutMs: 30_000,
      cancelWaitMs: 60_000,
    });
    expect(code).toBe(1);
    expect(h.logs.some((l) => /path\s+timed-out/.test(l))).toBe(true);
    expect(h.ghCalls).toContainEqual([
      "run",
      "cancel",
      "42",
      "-R",
      SANDBOX_REPO,
    ]);
    const cancelAt = h.events.findIndex((e) => e.startsWith("gh run cancel"));
    const closeAt = h.events.findIndex((e) => e.startsWith("gh pr close"));
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(cancelAt);
  });

  test("a timeout with no run in sight has nothing to cancel, and is still timed-out", async () => {
    const w = world({
      runPolls: [[]],
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
    expect(h.logs.some((l) => /path\s+timed-out/.test(l))).toBe(true);
    expect(h.ghCalls.some((c) => c[0] === "run" && c[1] === "cancel")).toBe(
      false,
    );
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(true);
  });
});

describe("smoke: transient poll failures", () => {
  test("one failed run listing is retried, and the run is still found", async () => {
    const w = world();
    const base = ghFor(w);
    let failures = 1;
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "run" && args[1] === "list" && failures > 0) {
          failures -= 1;
          return fail("HTTP 502: Bad Gateway");
        }
        return base(args, hh);
      },
    });
    expect(await runSmoke(h.deps, SMOKE)).toBe(0);
    expect(h.clock.sleeps).toContain(15_000);
  });

  test("the poll stops only after five consecutive failures, and the PR is still cleaned up", async () => {
    // Exactly five listings fail and end the poll. The cleanup's lookup for an
    // unrecorded run then reads an empty list, so the PR still closes.
    const w = world();
    const base = ghFor(w);
    let failures = 5;
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "run" && args[1] === "list") {
          if (failures > 0) {
            failures -= 1;
            return fail("HTTP 502: Bad Gateway");
          }
          return ok("[]");
        }
        return base(args, hh);
      },
    });
    const code = await runSmoke(h.deps, { ...SMOKE, timeoutMs: 10 * 60_000 });
    expect(code).toBe(1);
    // Adapted: smoke is the review-free scenario, so the runner names it as such.
    const stoppedAt = h.events.findIndex((e) =>
      e.startsWith("log scenario review-free stopped early"),
    );
    expect(stoppedAt).toBeGreaterThan(0);
    expect(
      h.events.slice(0, stoppedAt).filter((e) => e.startsWith("gh run list"))
        .length,
    ).toBe(5);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(true);
  });
});

describe("smoke: signals", () => {
  // A run that stays in progress until the cancel completes it. The signal
  // fires on the second run listing, which is inside the poll, after the
  // scenario has installed its handlers.
  function interruptDuringPoll(w: World, signal: "SIGINT" | "SIGTERM") {
    const inProgress: Run = {
      ...completedRun(),
      status: "in_progress",
      conclusion: null,
    };
    w.runPolls = [[inProgress]];
    w.runStatus = "in_progress";
    w.statusState = undefined;
    w.issueComments = [];
    const base = ghFor(w);
    let polls = 0;
    return (args: readonly string[], hh: Harness) => {
      if (args[0] === "run" && args[1] === "list") {
        polls += 1;
        if (polls === 2) hh.signals.fire(signal);
      }
      if (args[0] === "run" && args[1] === "cancel") {
        w.runStatus = "completed";
        return ok();
      }
      return base(args, hh);
    };
  }

  const LONG_RUN = { ...SMOKE, timeoutMs: 10 * 60_000, cancelWaitMs: 60_000 };

  test("SIGINT during the poll cancels the run, closes the PR, and exits 130", async () => {
    const h = harness({
      gh: interruptDuringPoll(world(), "SIGINT"),
    });
    const code = await runSmoke(h.deps, LONG_RUN);
    expect(code).toBe(130);
    expect(h.logs.some((l) => l.includes("SIGINT"))).toBe(true);
    expect(h.ghCalls).toContainEqual([
      "run",
      "cancel",
      "42",
      "-R",
      SANDBOX_REPO,
    ]);
    expect(
      h.ghCalls.filter((c) => c[0] === "pr" && c[1] === "close").length,
    ).toBe(1);
    expect(h.signals.listeners()).toBe(0);
  });

  test("SIGTERM during the poll runs the same cleanup and exits 143", async () => {
    const h = harness({
      gh: interruptDuringPoll(world(), "SIGTERM"),
    });
    const code = await runSmoke(h.deps, LONG_RUN);
    expect(code).toBe(143);
    expect(h.logs.some((l) => l.includes("SIGTERM"))).toBe(true);
    expect(
      h.ghCalls.filter((c) => c[0] === "pr" && c[1] === "close").length,
    ).toBe(1);
  });

  test("a signal with a failed cleanup exits 1, not the signal's code", async () => {
    const script = interruptDuringPoll(world(), "SIGINT");
    const h = harness({
      gh: (args, hh) =>
        args[0] === "pr" && args[1] === "close"
          ? fail("HTTP 502: Bad Gateway")
          : script(args, hh),
    });
    expect(await runSmoke(h.deps, LONG_RUN)).toBe(1);
    expect(h.logs.some((l) => l.startsWith("cleanup failed"))).toBe(true);
  });

  test("a signal during cleanup after a completed scenario exits 0 and reports when it arrived", async () => {
    const base = ghFor(world());
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "pr" && args[1] === "close") hh.signals.fire("SIGINT");
        return base(args, hh);
      },
    });
    expect(await runSmoke(h.deps, SMOKE)).toBe(0);
    expect(
      h.logs.some((l) => l.includes("SIGINT received during cleanup")),
    ).toBe(true);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(true);
    expect(h.signals.listeners()).toBe(0);
  });

  test("a second signal during the cancel wait abandons it, names what may be open, and returns at once", async () => {
    // The first signal interrupts the poll. The cancel is accepted but the run
    // keeps going, and the second signal lands inside the cancel wait's second read.
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
    const base = ghFor(w);
    let polls = 0;
    let views = 0;
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "run" && args[1] === "list") {
          polls += 1;
          if (polls === 2) hh.signals.fire("SIGINT");
        }
        if (args[0] === "run" && args[1] === "view") {
          views += 1;
          if (views === 2) hh.signals.fire("SIGINT");
        }
        if (args[0] === "run" && args[1] === "cancel") return ok();
        return base(args, hh);
      },
    });
    // Once the second signal has landed, the cancel wait's sleep never resolves.
    // The wait must end on the signal itself, as a sleep cut short, and not on
    // the next timer or the next read. Without that wake, this test hangs.
    const sleep = h.clock.sleep;
    h.clock.sleep = (ms: number) =>
      views >= 2 ? new Promise<void>(() => undefined) : sleep(ms);
    expect(await runSmoke(h.deps, LONG_RUN)).toBe(1);
    // Two reads in all: the wait ended at the second signal, not at its deadline.
    expect(views).toBe(2);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(
      false,
    );
    const branch = h.gitCalls.find((c) => c.args[0] === "checkout")?.args[2];
    const line = h.logs.find((l) => l.startsWith("left open"));
    expect(line).toBeDefined();
    expect(line).toContain(PR_URL);
    expect(line).toContain(branch ?? "no branch");
    expect(line).toContain("run 42");
    expect(line).toContain("bun scripts/sandbox.ts clean");
  });

  test("the handlers are installed while the scenario runs and removed afterwards", async () => {
    let during = -1;
    const base = ghFor(world());
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "pr" && args[1] === "create") {
          during = hh.signals.listeners();
        }
        return base(args, hh);
      },
    });
    expect(await runSmoke(h.deps, SMOKE)).toBe(0);
    expect(during).toBe(2);
    expect(h.signals.listeners()).toBe(0);
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

// Cleanup's cancel path. A run the poll never recorded is the orphan case: the
// `opened` event queues it asynchronously, so it can appear after the scenario
// has already ended.
const CLEANUP_SMOKE = {
  ref: "v0.2.0",
  keep: false,
  pollIntervalMs: 15_000,
  timeoutMs: 10 * 60_000,
  cancelWaitMs: 60_000,
};
const QUEUED: Run = { ...completedRun(), status: "queued", conclusion: null };
const IN_PROGRESS: Run = {
  ...completedRun(),
  status: "in_progress",
  conclusion: null,
};

describe("smoke: a run the opened event queued", () => {
  test("a signal before the first sighting still cancels the run before the PR closes", async () => {
    // The run appears only on the third listing. The signal lands inside
    // `pr create`, so the scenario's poll never sees it.
    const w = world({
      runPolls: [[], [QUEUED]],
      runStatus: "queued",
      statusState: undefined,
      issueComments: [],
      artifacts: [],
    });
    const base = ghFor(w);
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "pr" && args[1] === "create") hh.signals.fire("SIGINT");
        if (args[0] === "run" && args[1] === "cancel") {
          w.runStatus = "completed";
          return ok();
        }
        return base(args, hh);
      },
    });
    expect(await runSmoke(h.deps, CLEANUP_SMOKE)).toBe(130);
    expect(h.ghCalls).toContainEqual([
      "run",
      "cancel",
      "42",
      "-R",
      SANDBOX_REPO,
    ]);
    const cancelAt = h.events.findIndex((e) => e.startsWith("gh run cancel"));
    const closeAt = h.events.findIndex((e) => e.startsWith("gh pr close"));
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(cancelAt);
  });

  test("a failed gh pr create still cancels the run its push queued", async () => {
    const w = world({
      runPolls: [[], [QUEUED]],
      runStatus: "queued",
      statusState: undefined,
      issueComments: [],
      artifacts: [],
    });
    const base = ghFor(w);
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "pr" && args[1] === "create") {
          return fail("HTTP 502: Bad Gateway");
        }
        if (args[0] === "run" && args[1] === "cancel") {
          w.runStatus = "completed";
          return ok();
        }
        return base(args, hh);
      },
    });
    expect(await runSmoke(h.deps, CLEANUP_SMOKE)).toBe(1);
    const cancelAt = h.events.findIndex((e) => e.startsWith("gh run cancel"));
    const deleteAt = h.events.findIndex(
      (e) => e.startsWith("gh api ") && e.endsWith(" -X DELETE"),
    );
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(cancelAt);
  });

  test("no run appearing within the lookup bound is reported, and the PR still closes", async () => {
    const w = world({
      runPolls: [[]],
      statusState: undefined,
      issueComments: [],
      artifacts: [],
    });
    const base = ghFor(w);
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "pr" && args[1] === "create") hh.signals.fire("SIGINT");
        return base(args, hh);
      },
    });
    expect(await runSmoke(h.deps, CLEANUP_SMOKE)).toBe(130);
    expect(
      h.logs.some((l) =>
        // Adapted: the branch is named for its scenario, review-free.
        /^no run on sandbox\/review-free-\S+ appeared within 60s/.test(l),
      ),
    ).toBe(true);
    expect(h.ghCalls.some((c) => c[0] === "run" && c[1] === "cancel")).toBe(
      false,
    );
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(true);
  });
});

describe("smoke: the cancel path's tolerance", () => {
  test("a run that completes between the check and the cancel is done, and the PR closes", async () => {
    // Interrupted in the poll, so the run is on record as in progress. gh then
    // refuses the cancel because the run has finished in the meantime.
    const w = world({
      runPolls: [[IN_PROGRESS]],
      runStatus: "in_progress",
      statusState: undefined,
      issueComments: [],
    });
    const base = ghFor(w);
    let polls = 0;
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "run" && args[1] === "list") {
          polls += 1;
          if (polls === 2) hh.signals.fire("SIGINT");
        }
        if (args[0] === "run" && args[1] === "cancel") {
          w.runStatus = "completed";
          return fail("Cannot cancel a workflow run that is completed");
        }
        return base(args, hh);
      },
    });
    expect(await runSmoke(h.deps, CLEANUP_SMOKE)).toBe(130);
    expect(h.ghCalls.some((c) => c[0] === "run" && c[1] === "cancel")).toBe(
      true,
    );
    expect(
      h.ghCalls.filter((c) => c[0] === "pr" && c[1] === "close").length,
    ).toBe(1);
    expect(h.logs.some((l) => l.startsWith("left open"))).toBe(false);
    // A refusal because the run already completed is the outcome, not a failed read.
    expect(h.logs.some((l) => l.startsWith("poll read failed"))).toBe(false);
  });

  test("a transient failure on the cleanup's first status read is retried", async () => {
    // The scenario times out, so its collection reads the run first (the first
    // `run view`). The second read is cleanup's first status check, and it fails once.
    const w = world({
      runPolls: [[IN_PROGRESS]],
      runStatus: "in_progress",
      statusState: undefined,
      issueComments: [],
    });
    const base = ghFor(w);
    let views = 0;
    const h = harness({
      gh: (args, hh) => {
        if (args[0] === "run" && args[1] === "view") {
          views += 1;
          if (views === 2) return fail("HTTP 502: Bad Gateway");
        }
        if (args[0] === "run" && args[1] === "cancel") {
          w.runStatus = "completed";
          return ok();
        }
        return base(args, hh);
      },
    });
    // The exit is the timed-out one. What is under test is that the cleanup
    // read survives the failure, cancels the run, and still closes the PR.
    expect(
      await runSmoke(h.deps, { ...CLEANUP_SMOKE, timeoutMs: 30_000 }),
    ).toBe(1);
    expect(h.logs.some((l) => l.includes("poll read failed (1 of 5)"))).toBe(
      true,
    );
    expect(h.ghCalls).toContainEqual([
      "run",
      "cancel",
      "42",
      "-R",
      SANDBOX_REPO,
    ]);
    expect(h.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(true);
  });
});
