import { describe, expect, test } from "bun:test";
import { runCancelCommand } from "#commands/cancel";
import { COMMIT_STATUS_CONTEXT } from "#pr/preflight";
import { CliError } from "../../src/errors";

type Scripted = { stdout?: string; stderr?: string; exitCode?: number };

interface ScriptEntry {
  match: string[];
  responses: Scripted[];
}

interface RecordedCall {
  argv: string[];
}

function makeFakeGh(script: ScriptEntry[]): {
  spawnFn: typeof Bun.spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const cursors = new Map<number, number>();
  const encoder = new TextEncoder();
  const spawnFn = ((argv: string[]) => {
    calls.push({ argv: [...argv] });
    const joined = argv.join(" ");
    const index = script.findIndex((entry) =>
      entry.match.every((token) => joined.includes(token)),
    );
    const entry = index === -1 ? undefined : script[index];
    const cursor = cursors.get(index) ?? 0;
    const scripted =
      entry === undefined
        ? { stdout: "", exitCode: 1, stderr: "unscripted gh call" }
        : entry.responses[Math.min(cursor, entry.responses.length - 1)];
    if (entry !== undefined && cursor < entry.responses.length) {
      cursors.set(index, cursor + 1);
    }
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    return {
      stdout: stream(scripted?.stdout ?? ""),
      stderr: stream(scripted?.stderr ?? ""),
      exited: Promise.resolve(scripted?.exitCode ?? 0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

const OPERATOR_ROOT = "/repo";
const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);
const NOW = Date.parse("2026-10-24T12:00:00Z");
const SLUG = "acme/widgets";
const RUN_ID = 123;
const RUN_URL = `https://github.com/${SLUG}/actions/runs/${RUN_ID}`;

const prView = (head: string): Scripted => ({
  stdout: JSON.stringify({
    additions: 1,
    baseRefName: "dev",
    baseRefOid: "d".repeat(40),
    changedFiles: 1,
    deletions: 0,
    headRefOid: head,
    mergeCommit: null,
    number: 12,
    state: "OPEN",
    title: "t",
  }),
});

function ndjson(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

function workflowRun(head: string) {
  return {
    id: RUN_ID,
    status: "in_progress",
    event: "pull_request",
    head_sha: head,
    path: ".github/workflows/pr-hero.yml",
    html_url: RUN_URL,
    display_title: "t",
    pull_requests: [{ number: 12 }],
  };
}

function runsPayload(head: string | null): Scripted {
  return {
    stdout: JSON.stringify({
      workflow_runs: head === null ? [] : [workflowRun(head)],
    }),
  };
}

const repoView: ScriptEntry = {
  match: ["nameWithOwner"],
  responses: [{ stdout: `${SLUG}\n` }],
};

const emptyComments: ScriptEntry = {
  match: ["issues/12/comments"],
  responses: [{ stdout: "" }],
};

const emptyReviewComments: ScriptEntry = {
  match: ["pulls/12/comments"],
  responses: [{ stdout: "" }],
};

const emptyStatuses: ScriptEntry = {
  match: [`commits/${HEAD}/status`],
  responses: [{ stdout: "" }],
};

const overrideCanLand: ScriptEntry[] = [
  { match: [".head.repo.full_name"], responses: [{ stdout: `${SLUG}\n` }] },
  { match: [".permissions.push"], responses: [{ stdout: "true\n" }] },
  {
    match: ["vnd.github.raw"],
    responses: [{ stdout: "on:\n  issue_comment:\n    types: [created]\n" }],
  },
];

function five(payload: Scripted): Scripted[] {
  return [payload, payload, payload, payload, payload];
}

function baseScript(extra: ScriptEntry[]): ScriptEntry[] {
  return [
    repoView,
    {
      match: ["pr", "view", "12"],
      responses: [prView(HEAD)],
    },
    emptyStatuses,
    {
      match: ["per_page=100"],
      responses: [runsPayload(HEAD)],
    },
    {
      match: ["run", "cancel", String(RUN_ID)],
      responses: [{ stdout: "" }],
    },
    {
      match: [`actions/runs/${RUN_ID}`],
      responses: [{ stdout: JSON.stringify({ status: "completed" }) }],
    },
    emptyComments,
    emptyReviewComments,
    ...extra,
  ];
}

describe("runCancelCommand", () => {
  test("cancels an in-flight run, polls until it is completed, and returns PrCancelJson", async () => {
    const { spawnFn, calls } = makeFakeGh(
      baseScript([]).map((entry) =>
        entry.match.some((token) => token.startsWith("actions/runs/"))
          ? {
              ...entry,
              responses: [
                { stdout: JSON.stringify({ status: "in_progress" }) },
                { stdout: JSON.stringify({ status: "completed" }) },
              ],
            }
          : entry,
      ),
    );
    const written: string[] = [];
    const sleeps: number[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "");
    expect(parsed).toMatchObject({
      schema: "pr-hero.cancel/v1",
      pr: 12,
      head: HEAD,
      override_requested: false,
      cancelled_runs: [
        {
          run_id: RUN_ID,
          previous_status: "in_progress",
          settled: true,
          html_url: RUN_URL,
        },
      ],
    });
    expect(parsed.status.schema).toBe("pr-hero.status/v1");
    expect(parsed.status.head).toBe(HEAD);
    const cancelAt = calls.findIndex(
      (call) =>
        call.argv.includes("run") &&
        call.argv.includes("cancel") &&
        call.argv.includes(String(RUN_ID)) &&
        call.argv.includes("-R") &&
        call.argv.includes(SLUG),
    );
    const completedAt = calls.findIndex(
      (call, index) =>
        index > cancelAt &&
        call.argv.join(" ").includes(`actions/runs/${RUN_ID}`),
    );
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(completedAt).toBeGreaterThan(cancelAt);
    expect(sleeps).toContain(3_000);
  });

  test("treats HTTP 409 from gh run cancel as already settled", async () => {
    const { spawnFn } = makeFakeGh(
      baseScript([]).map((entry) =>
        entry.match.includes("cancel")
          ? {
              ...entry,
              responses: [
                {
                  exitCode: 1,
                  stderr:
                    "HTTP 409: Cannot cancel a workflow run that is completed\n",
                },
              ],
            }
          : entry,
      ),
    );
    const written: string[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(written[0] ?? "");
    expect(parsed.cancelled_runs).toEqual([
      {
        run_id: RUN_ID,
        previous_status: "in_progress",
        settled: true,
        html_url: RUN_URL,
      },
    ]);
  });

  test("posts /pr-hero override only after the run is completed, then waits until the gate records it", async () => {
    const overrideComment = {
      id: 7,
      user: "maintainer",
      body: "/pr-hero override",
      created_at: new Date(NOW - 1_000).toISOString(),
    };
    const errorGate = {
      state: "error",
      context: COMMIT_STATUS_CONTEXT,
      created_at: new Date(NOW - 500).toISOString(),
      description:
        "PRH-CANCELLED: not reviewed — /pr-hero review reviews this head",
      target_url: RUN_URL,
    };
    const overrideGate = {
      state: "success",
      context: COMMIT_STATUS_CONTEXT,
      created_at: new Date(NOW).toISOString(),
      description:
        "pr-hero: overridden by @maintainer — no review on this head",
      target_url: RUN_URL,
    };
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      ...overrideCanLand,
      {
        match: [`commits/${HEAD}/status`],
        responses: [
          { stdout: "" },
          { stdout: ndjson([errorGate]) },
          { stdout: ndjson([overrideGate]) },
        ],
      },
      { match: ["per_page=100"], responses: [runsPayload(HEAD)] },
      {
        match: ["run", "cancel", String(RUN_ID)],
        responses: [{ stdout: "" }],
      },
      {
        match: ["--body", "/pr-hero override"],
        responses: [{ stdout: "" }],
      },
      {
        match: [`actions/runs/${RUN_ID}`],
        responses: [
          { stdout: JSON.stringify({ status: "in_progress" }) },
          { stdout: JSON.stringify({ status: "completed" }) },
        ],
      },
      {
        match: ["issues/12/comments"],
        responses: [{ stdout: ndjson([overrideComment]) }],
      },
      emptyReviewComments,
    ]);
    const written: string[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      override: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(written[0] ?? "");
    expect(parsed.override_requested).toBe(true);
    expect(parsed.head).toBe(HEAD);
    expect(parsed.status.head).toBe(HEAD);
    expect(parsed.status.gate.override.active).toBe(true);
    expect(parsed.cancelled_runs[0].settled).toBe(true);
    const commentAt = calls.findIndex((call) => call.argv.includes("comment"));
    const completedAt = calls.findIndex((call) =>
      call.argv.join(" ").includes(`actions/runs/${RUN_ID}`),
    );
    expect(commentAt).toBeGreaterThan(completedAt);
    expect(calls[commentAt]?.argv).toContain("--body");
    expect(calls[commentAt]?.argv).toContain("/pr-hero override");
  });

  test("throws CliError and writes nothing when gh pr view fails", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pr", "view", "12"],
        responses: [{ exitCode: 1, stderr: "no such pull request\n" }],
      },
    ]);
    const written: string[] = [];
    await expect(
      runCancelCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      }),
    ).rejects.toThrow(/gh pr view 12 failed/);
    expect(written).toEqual([]);
  });

  test("throws when the head moves before --override and does not post the comment", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      {
        match: ["pr", "view", "12"],
        responses: [prView(HEAD), prView(OTHER)],
      },
      ...overrideCanLand,
      emptyStatuses,
      { match: ["per_page=100"], responses: [runsPayload(HEAD)] },
      {
        match: ["run", "cancel", String(RUN_ID)],
        responses: [{ stdout: "" }],
      },
      {
        match: [`actions/runs/${RUN_ID}`],
        responses: [{ stdout: JSON.stringify({ status: "completed" }) }],
      },
      emptyComments,
    ]);
    const written: string[] = [];
    await expect(
      runCancelCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        override: true,
        wait: true,
        spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(written).toEqual([]);
    expect(calls.some((call) => call.argv.includes("comment"))).toBe(false);
    expect(
      calls.some(
        (call) => call.argv.includes("cancel") && call.argv.includes("run"),
      ),
    ).toBe(true);
  });

  test("polls up to 15s every 3s when the head was just pushed and no run is visible yet", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      emptyStatuses,
      {
        match: ["per_page=100"],
        responses: [...five(runsPayload(null)), runsPayload(HEAD)],
      },
      {
        match: ["run", "cancel", String(RUN_ID)],
        responses: [{ stdout: "" }],
      },
      {
        match: [`actions/runs/${RUN_ID}`],
        responses: [{ stdout: JSON.stringify({ status: "completed" }) }],
      },
      emptyComments,
      emptyReviewComments,
    ]);
    const sleeps: number[] = [];
    const written: string[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(sleeps[0]).toBe(3_000);
    expect(JSON.parse(written[0] ?? "").cancelled_runs[0].run_id).toBe(RUN_ID);
    expect(
      calls.some(
        (call) => call.argv.includes("cancel") && call.argv.includes("run"),
      ),
    ).toBe(true);
  });

  test("polls the startup grace on --wait even when no run is visible yet", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      emptyStatuses,
      { match: ["per_page=100"], responses: [runsPayload(null)] },
      emptyComments,
      emptyReviewComments,
    ]);
    const sleeps: number[] = [];
    const written: string[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(sleeps).toEqual([3_000, 3_000, 3_000, 3_000, 3_000]);
    expect(JSON.parse(written[0] ?? "").cancelled_runs).toEqual([]);
    expect(
      calls.some(
        (call) => call.argv.includes("cancel") && call.argv.includes("run"),
      ),
    ).toBe(false);
    expect(
      calls.some((call) => call.argv.join(" ").includes("committer.date")),
    ).toBe(false);
  });

  test("stops the startup poll at 15s when no run appears", async () => {
    const { spawnFn } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      emptyStatuses,
      { match: ["per_page=100"], responses: [runsPayload(null)] },
      emptyComments,
      emptyReviewComments,
    ]);
    const sleeps: number[] = [];
    const written: string[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(sleeps).toEqual([3_000, 3_000, 3_000, 3_000, 3_000]);
    expect(JSON.parse(written[0] ?? "").cancelled_runs).toEqual([]);
  });

  test("does not treat a 409 inside a run id as already settled", async () => {
    const { spawnFn } = makeFakeGh(
      baseScript([]).map((entry) =>
        entry.match.includes("cancel")
          ? {
              ...entry,
              responses: [
                {
                  exitCode: 1,
                  stderr:
                    "HTTP 403: https://api.github.com/repos/acme/widgets/actions/runs/12409/cancel\n",
                },
              ],
            }
          : entry,
      ),
    );
    const written: string[] = [];
    await expect(
      runCancelCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        wait: true,
        spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      }),
    ).rejects.toThrow(/gh run cancel 123 failed/);
    expect(written).toEqual([]);
  });

  test("--override forces the startup wait and still posts when a run appears late", async () => {
    const overrideComment = {
      id: 7,
      user: "maintainer",
      body: "/pr-hero override",
      created_at: new Date(NOW - 1_000).toISOString(),
    };
    const overrideGate = {
      state: "success",
      context: COMMIT_STATUS_CONTEXT,
      created_at: new Date(NOW).toISOString(),
      description:
        "pr-hero: overridden by @maintainer — no review on this head",
      target_url: RUN_URL,
    };
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      ...overrideCanLand,
      {
        match: [`commits/${HEAD}/status`],
        responses: [{ stdout: "" }, { stdout: ndjson([overrideGate]) }],
      },
      {
        match: ["per_page=100"],
        responses: [...five(runsPayload(null)), runsPayload(HEAD)],
      },
      {
        match: ["run", "cancel", String(RUN_ID)],
        responses: [{ stdout: "" }],
      },
      {
        match: ["--body", "/pr-hero override"],
        responses: [{ stdout: "" }],
      },
      {
        match: [`actions/runs/${RUN_ID}`],
        responses: [{ stdout: JSON.stringify({ status: "completed" }) }],
      },
      {
        match: ["issues/12/comments"],
        responses: [{ stdout: ndjson([overrideComment]) }],
      },
      emptyReviewComments,
    ]);
    const sleeps: number[] = [];
    const written: string[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      override: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(sleeps).toContain(3_000);
    expect(JSON.parse(written[0] ?? "").override_requested).toBe(true);
    const cancelAt = calls.findIndex(
      (call) => call.argv.includes("cancel") && call.argv.includes("run"),
    );
    const commentAt = calls.findIndex((call) => call.argv.includes("comment"));
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(commentAt).toBeGreaterThan(cancelAt);
  });

  test("times out at 90s before posting /pr-hero override", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      ...overrideCanLand,
      emptyStatuses,
      { match: ["per_page=100"], responses: [runsPayload(HEAD)] },
      {
        match: ["run", "cancel", String(RUN_ID)],
        responses: [{ stdout: "" }],
      },
      {
        match: [`actions/runs/${RUN_ID}`],
        responses: [{ stdout: JSON.stringify({ status: "in_progress" }) }],
      },
      emptyComments,
    ]);
    const written: string[] = [];
    await expect(
      runCancelCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        override: true,
        spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      }),
    ).rejects.toThrow(/90000/);
    expect(written).toEqual([]);
    expect(calls.some((call) => call.argv.includes("comment"))).toBe(false);
  });

  test("throws when a denial outcome lands instead of the override", async () => {
    const outcome = [
      `<!-- pr-hero-outcome v=1 head=${HEAD} run=9 attempt=1 -->`,
      "",
      "### PRH-CANCELLED: not reviewed",
      "",
      "body",
    ].join("\n");
    const { spawnFn } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      ...overrideCanLand,
      {
        match: [`commits/${HEAD}/status`],
        responses: [
          { stdout: "" },
          {
            stdout: ndjson([
              {
                state: "error",
                context: COMMIT_STATUS_CONTEXT,
                created_at: new Date(NOW - 500).toISOString(),
                description: "PRH-CANCELLED: not reviewed",
                target_url: RUN_URL,
              },
            ]),
          },
        ],
      },
      { match: ["per_page=100"], responses: [runsPayload(HEAD)] },
      {
        match: ["run", "cancel", String(RUN_ID)],
        responses: [{ stdout: "" }],
      },
      {
        match: ["--body", "/pr-hero override"],
        responses: [{ stdout: "" }],
      },
      {
        match: [`actions/runs/${RUN_ID}`],
        responses: [{ stdout: JSON.stringify({ status: "completed" }) }],
      },
      {
        match: ["issues/12/comments"],
        responses: [
          { stdout: "" },
          {
            stdout: ndjson([
              {
                id: 9,
                user: "maintainer",
                body: "/pr-hero override",
                created_at: new Date(NOW - 1_000).toISOString(),
              },
              {
                id: 10,
                user: "github-actions[bot]",
                body: outcome,
                created_at: new Date(NOW - 100).toISOString(),
              },
            ]),
          },
        ],
      },
      emptyReviewComments,
    ]);
    const written: string[] = [];
    await expect(
      runCancelCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        override: true,
        spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      }),
    ).rejects.toThrow(/denied/);
    expect(written).toEqual([]);
  });

  test("refuses --override on a fork before cancelling", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      {
        match: [".head.repo.full_name"],
        responses: [{ stdout: "stranger/widgets\n" }],
      },
    ]);
    const written: string[] = [];
    await expect(
      runCancelCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        override: true,
        spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      }),
    ).rejects.toThrow(/from a fork/);
    expect(written).toEqual([]);
    expect(
      calls.some(
        (call) => call.argv.includes("cancel") && call.argv.includes("run"),
      ),
    ).toBe(false);
  });

  test("refuses --override without write access before cancelling", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      {
        match: [".head.repo.full_name"],
        responses: [{ stdout: `${SLUG}\n` }],
      },
      { match: [".permissions.push"], responses: [{ stdout: "false\n" }] },
    ]);
    const written: string[] = [];
    await expect(
      runCancelCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        override: true,
        spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      }),
    ).rejects.toThrow(/needs write access/);
    expect(written).toEqual([]);
    expect(
      calls.some(
        (call) => call.argv.includes("cancel") && call.argv.includes("run"),
      ),
    ).toBe(false);
  });

  test("refuses --override when the workflow has no issue_comment trigger", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      {
        match: [".head.repo.full_name"],
        responses: [{ stdout: `${SLUG}\n` }],
      },
      { match: [".permissions.push"], responses: [{ stdout: "true\n" }] },
      {
        match: ["vnd.github.raw"],
        responses: [{ stdout: "on:\n  pull_request:\n" }],
      },
    ]);
    const written: string[] = [];
    await expect(
      runCancelCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        override: true,
        spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      }),
    ).rejects.toThrow(/no issue_comment/);
    expect(written).toEqual([]);
    expect(
      calls.some(
        (call) => call.argv.includes("cancel") && call.argv.includes("run"),
      ),
    ).toBe(false);
  });

  test("without --json, stdout stays empty", async () => {
    const { spawnFn } = makeFakeGh(baseScript([]));
    const written: string[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: false,
      wait: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(written).toEqual([]);
  });

  test("stops waiting when the head moves after /pr-hero override was posted", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      {
        match: ["pr", "view", "12"],
        responses: [prView(HEAD), prView(HEAD), prView(OTHER)],
      },
      ...overrideCanLand,
      emptyStatuses,
      { match: ["per_page=100"], responses: [runsPayload(HEAD)] },
      {
        match: ["run", "cancel", String(RUN_ID)],
        responses: [{ stdout: "" }],
      },
      {
        match: [`actions/runs/${RUN_ID}`],
        responses: [{ stdout: JSON.stringify({ status: "completed" }) }],
      },
      emptyComments,
      {
        match: ["--body", "/pr-hero override"],
        responses: [{ stdout: "" }],
      },
    ]);
    const written: string[] = [];
    await expect(
      runCancelCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        override: true,
        spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      }),
    ).rejects.toThrow(/head moved while waiting/);
    expect(written).toEqual([]);
    expect(calls.some((call) => call.argv.includes("--body"))).toBe(true);
  });

  test("does not cancel another PR's comment run when the title is shared", async () => {
    const shared = {
      stdout: JSON.stringify({
        workflow_runs: [
          {
            ...workflowRun(OTHER),
            id: 77,
            event: "issue_comment",
            display_title: "t",
            pull_requests: [],
          },
        ],
      }),
    };
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      {
        match: ["pr", "list"],
        responses: [
          {
            stdout: JSON.stringify([
              { number: 12, title: "t" },
              { number: 13, title: "t" },
            ]),
          },
        ],
      },
      emptyStatuses,
      { match: ["per_page=100"], responses: [shared] },
      emptyComments,
      emptyReviewComments,
    ]);
    const written: string[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(JSON.parse(written[0] ?? "").cancelled_runs).toEqual([]);
    expect(
      calls.some(
        (call) => call.argv.includes("cancel") && call.argv.includes("run"),
      ),
    ).toBe(false);
  });

  test("cancels the pending gate run when the workflow list 404s", async () => {
    const pending = {
      state: "pending",
      context: COMMIT_STATUS_CONTEXT,
      created_at: new Date(NOW).toISOString(),
      description: "pr-hero: review in progress",
      target_url: RUN_URL,
    };
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      { match: ["pr", "view", "12"], responses: [prView(HEAD)] },
      {
        match: [`commits/${HEAD}/status`],
        responses: [{ stdout: ndjson([pending]) }],
      },
      {
        match: ["per_page=100"],
        responses: [
          {
            exitCode: 1,
            stderr:
              "HTTP 404: Not Found (https://api.github.com/repos/acme/widgets/actions/workflows/pr-hero.yml)\n",
          },
        ],
      },
      {
        match: [`actions/runs/${RUN_ID}`],
        responses: [
          { stdout: JSON.stringify(workflowRun(HEAD)) },
          { stdout: JSON.stringify({ status: "completed" }) },
        ],
      },
      {
        match: ["run", "cancel", String(RUN_ID)],
        responses: [{ stdout: "" }],
      },
      emptyComments,
      emptyReviewComments,
    ]);
    const written: string[] = [];
    const code = await runCancelCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(JSON.parse(written[0] ?? "").cancelled_runs).toEqual([
      {
        run_id: RUN_ID,
        previous_status: "in_progress",
        settled: true,
        html_url: RUN_URL,
      },
    ]);
    expect(
      calls.some(
        (call) => call.argv.includes("cancel") && call.argv.includes("run"),
      ),
    ).toBe(true);
  });
});
