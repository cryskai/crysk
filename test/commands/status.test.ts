// The I/O shell of `pr-hero status` (src/commands/status.ts), driven through the spawnFn seam
// with a fake gh. The pure decisions are tested in test/pr/pr-status.test.ts; this file pins
// what the shell adds: the reads it makes, the one stdout write it allows, and the fail-closed
// exits. A gh failure or a truncated comment read is a CliError and writes nothing to stdout.

import { describe, expect, test } from "bun:test";
import { OVERRIDE_DESCRIPTION_PREFIX } from "#ci/override";
import { renderCiAdmissionBlock } from "#ci/review-admission";
import { runStatusCommand, statusCommand } from "#commands/status";
import { carriedBlockingDescription } from "#pr/admission";
import { CommentsTruncatedError, GRAPHQL_COMMENT_MAX_PAGES } from "#pr/pr";
import { COMMIT_STATUS_CONTEXT, findingMarker } from "#pr/preflight";
import { renderStateBlock, stateFinding } from "#rereview/state";
import { parseArgs } from "#review/preflight";
import { triageMarker } from "#triage/triage";
import { CliError, CliUsageError } from "../../src/errors";

type ScriptEntry = {
  match: string[];
  response: { stdout?: string; stderr?: string; exitCode?: number };
};

interface RecordedCall {
  argv: string[];
}

// Same contract as the fakes in test/pr/pr.test.ts: a token list matches when every token is
// a substring of the joined argv, and the first matching entry answers.
function makeFakeGh(script: ScriptEntry[]): {
  spawnFn: typeof Bun.spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const encoder = new TextEncoder();
  const spawnFn = ((argv: string[]) => {
    calls.push({ argv });
    const joined = argv.join(" ");
    // The reply authors of the fixtures have write access. These entries come last, so a test
    // scripts another answer for a login by putting its own entry first.
    const entry = [
      ...script,
      ...["dev", "developer"].map(
        (login): ScriptEntry => ({
          match: [`collaborators/${login}/permission`],
          response: { stdout: "write\n" },
        }),
      ),
    ].find((s) => s.match.every((t) => joined.includes(t)));
    const scripted = entry?.response ?? { stdout: "", exitCode: 0 };
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    return {
      stdout: stream(scripted.stdout ?? ""),
      stderr: stream(scripted.stderr ?? ""),
      exited: Promise.resolve(scripted.exitCode ?? 0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

// A gh call that never answers. Its streams stay open until the command's own bound kills
// it, and kill() closes both streams and resolves exited, which is what gh() reads before it
// can report the timeout. The safety net only makes a missing bound fail as an assertion
// rather than as bun's test timeout: it kills the call after 2 s, well past the 50 ms bound.
function hangingSpawn(
  base: typeof Bun.spawn,
  when: (argv: string[]) => boolean,
): typeof Bun.spawn {
  return ((argv: string[], opts?: unknown) => {
    if (!when(argv)) {
      return (base as unknown as (a: string[], o?: unknown) => unknown)(
        argv,
        opts,
      );
    }
    const held: ReadableStreamDefaultController<Uint8Array>[] = [];
    const open = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          held.push(controller);
        },
      });
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let safety: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (safety !== undefined) clearTimeout(safety);
      for (const controller of held) {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      resolveExit(143);
    };
    safety = setTimeout(kill, 2_000);
    return { stdout: open(), stderr: open(), exited, kill };
  }) as unknown as typeof Bun.spawn;
}

const OPERATOR_ROOT = "/repo";
const HEAD = "b".repeat(40);
const NOW = Date.parse("2026-10-17T12:00:00Z");
const CLAIM = "the value is stored in seconds and read as milliseconds";

const prView = {
  match: ["pr", "view", "12", "--json"],
  response: {
    stdout: JSON.stringify({
      additions: 1,
      baseRefName: "dev",
      baseRefOid: "c".repeat(40),
      changedFiles: 1,
      deletions: 0,
      headRefOid: HEAD,
      mergeCommit: null,
      number: 12,
      state: "OPEN",
      title: "t",
    }),
  },
};

function ndjson(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

const gateRow = {
  state: "failure",
  context: COMMIT_STATUS_CONTEXT,
  created_at: new Date(NOW - 5 * 60_000).toISOString(),
  description:
    "pr-hero: 1 blocking finding(s) — fix and push, or /crysk override",
  target_url: "https://github.com/MusiveTech/musive/actions/runs/9",
};

// A summary whose state block carries one live row, and one inline finding posted on HEAD.
// The row is built with the state module's own writer, so its fingerprint is the real one.
const summaryBody = [
  `<!-- pr-hero-report head=${HEAD} -->`,
  "",
  renderStateBlock(
    HEAD,
    [
      stateFinding({
        id: "R001",
        sev: "CRITICAL",
        tier: "blocking",
        channel: "inline",
        locs: ["src/a.ts:10"],
        claim: CLAIM,
      }),
    ],
    1,
  ),
].join("\n");

const findingBody = [
  findingMarker({ path: "src/a.ts", line: 10, headSha: HEAD, claim: CLAIM }),
  "",
  "🔴 blocking · CRITICAL · introduced · reliability",
  "",
  "`src/a.ts:10`",
  "",
  CLAIM,
].join("\n");

const happyScript: ScriptEntry[] = [
  prView,
  {
    match: [`commits/${HEAD}/status`],
    response: { stdout: ndjson([gateRow]) },
  },
  {
    match: ["issues/12/comments"],
    response: {
      stdout: ndjson([{ id: 100, user: "pr-hero", body: summaryBody }]),
    },
  },
  {
    match: ["pulls/12/comments"],
    response: {
      stdout: ndjson([
        {
          id: 41,
          user: "pr-hero",
          body: findingBody,
          path: "src/a.ts",
          line: 10,
          original_line: 10,
          in_reply_to_id: null,
        },
      ]),
    },
  },
];

describe("runStatusCommand --json", () => {
  test("writes exactly one JSON object to stdout, and returns 0", async () => {
    const { spawnFn } = makeFakeGh(happyScript);
    const written: string[] = [];
    const code = await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "");
    expect(parsed.schema).toBe("pr-hero.status/v1");
    expect(parsed.pr).toBe(12);
    expect(parsed.head).toBe(HEAD);
    expect(parsed.gate.state).toBe("failure");
    expect(parsed.gate.target_url).toBe(gateRow.target_url);
    expect(parsed.findings[0]).toMatchObject({
      id: "R001",
      comment_id: 41,
      channel: "inline",
      tier: "blocking",
      live_on_head: true,
    });
    expect(parsed.next_action).toBe("triage");
    expect(written[0]?.endsWith("\n")).toBe(true);
  });

  test("reads the PR head, the gate, and both comment streams, and nothing else", async () => {
    const { spawnFn, calls } = makeFakeGh(happyScript);
    await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      out: () => {},
    });
    const joined = calls.map((c) => c.argv.join(" "));
    expect(joined.some((a) => a.includes("pr view 12"))).toBe(true);
    expect(joined.some((a) => a.includes(`commits/${HEAD}/status`))).toBe(true);
    expect(joined.some((a) => a.includes("issues/12/comments"))).toBe(true);
    expect(joined.some((a) => a.includes("pulls/12/comments"))).toBe(true);
    // Read-only: no call writes to GitHub.
    for (const call of calls) {
      expect(call.argv.join(" ")).not.toMatch(/-X (POST|PATCH|PUT|DELETE)/);
      expect(call.argv).not.toContain("POST");
    }
  });

  test("a gate read that fails is a CliError, and nothing reaches stdout", async () => {
    const { spawnFn } = makeFakeGh([
      prView,
      {
        match: [`commits/${HEAD}/status`],
        response: {
          stderr: "Resource not accessible (HTTP 403)",
          exitCode: 1,
        },
      },
      ...happyScript.slice(2),
    ]);
    const written: string[] = [];
    await expect(
      runStatusCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        spawnFn,
        nowMs: NOW,
        out: (text) => written.push(text),
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(written).toEqual([]);
  });

  test("a comment read that fails is a CliError, and nothing reaches stdout", async () => {
    const { spawnFn } = makeFakeGh([
      prView,
      {
        match: [`commits/${HEAD}/status`],
        response: { stdout: ndjson([gateRow]) },
      },
      {
        match: ["issues/12/comments"],
        response: { stderr: "HTTP 500", exitCode: 1 },
      },
    ]);
    const written: string[] = [];
    await expect(
      runStatusCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        spawnFn,
        nowMs: NOW,
        out: (text) => written.push(text),
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(written).toEqual([]);
  });

  test("a comment read that never answers is a timeout CliError, and nothing reaches stdout", async () => {
    const { spawnFn } = makeFakeGh(happyScript);
    const hanging = hangingSpawn(spawnFn, (argv) =>
      argv.join(" ").includes("issues/12/comments"),
    );
    const written: string[] = [];
    const run = runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn: hanging,
      nowMs: NOW,
      ghTimeoutMs: 50,
      out: (text) => written.push(text),
    });
    await expect(run).rejects.toBeInstanceOf(CliError);
    await expect(run).rejects.toThrow(/timed out after 50 ms/);
    expect(written).toEqual([]);
  });

  test("a PR view that never answers is a timeout CliError, and nothing reaches stdout", async () => {
    const { spawnFn } = makeFakeGh(happyScript);
    const hanging = hangingSpawn(spawnFn, (argv) =>
      argv.join(" ").includes("pr view 12"),
    );
    const written: string[] = [];
    const run = runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn: hanging,
      nowMs: NOW,
      ghTimeoutMs: 50,
      out: (text) => written.push(text),
    });
    await expect(run).rejects.toBeInstanceOf(CliError);
    await expect(run).rejects.toThrow(/timed out after 50 ms/);
    expect(written).toEqual([]);
  });

  test("a truncated comment read is a CommentsTruncatedError (a CliError), and nothing reaches stdout", async () => {
    // The REST listing 404s, so the reader falls back to GraphQL, and every page says there is
    // another one: the reader gives up at its page limit (the pattern in test/pr/pr.test.ts).
    const pages: ScriptEntry[] = [
      prView,
      {
        match: [`commits/${HEAD}/status`],
        response: { stdout: ndjson([gateRow]) },
      },
      {
        match: ["issues/12/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      {
        match: ["repo", "view", "--json", "owner,name"],
        response: {
          stdout: JSON.stringify({
            name: "musive",
            owner: { login: "MusiveTech" },
          }),
        },
      },
    ];
    for (let i = 0; i < GRAPHQL_COMMENT_MAX_PAGES; i++) {
      const cursor = i === 0 ? "" : `cursor${i}`;
      pages.push({
        match:
          cursor.length === 0
            ? ["graphql", "databaseId"]
            : ["graphql", "databaseId", cursor],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: `cursor${i + 1}`,
                    },
                    nodes: [
                      {
                        databaseId: i + 1,
                        body: `page-${i + 1}`,
                        author: { login: "pr-hero" },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      });
    }
    const { spawnFn } = makeFakeGh(pages);
    const written: string[] = [];
    const error = await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      out: (text) => written.push(text),
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CommentsTruncatedError);
    expect(error).toBeInstanceOf(CliError);
    expect(written).toEqual([]);
  });

  test("a PR record that names no valid head is refused, and nothing reaches stdout", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pr", "view", "12", "--json"],
        response: {
          stdout: JSON.stringify({
            additions: 1,
            baseRefName: "dev",
            baseRefOid: "c".repeat(40),
            changedFiles: 1,
            deletions: 0,
            headRefOid: "not-a-sha",
            mergeCommit: null,
            number: 12,
            state: "OPEN",
            title: "t",
          }),
        },
      },
    ]);
    const written: string[] = [];
    await expect(
      runStatusCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        spawnFn,
        nowMs: NOW,
        out: (text) => written.push(text),
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
    expect(written).toEqual([]);
  });
});

describe("runStatusCommand human output", () => {
  test("without --json, nothing goes to stdout and the command still succeeds", async () => {
    const { spawnFn } = makeFakeGh(happyScript);
    const written: string[] = [];
    const code = await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: false,
      spawnFn,
      nowMs: NOW,
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(written).toEqual([]);
  });
});

describe("statusCommand argument guard", () => {
  test("refuses to run without a numeric --pr, before any read", async () => {
    const parsed = parseArgs(["status", "--pr", "12", "--json"]).options;
    await expect(
      statusCommand({ ...parsed, pr: undefined }),
    ).rejects.toBeInstanceOf(CliUsageError);
    await expect(
      statusCommand({ ...parsed, pr: "current" }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });
});

describe("runStatusCommand --wait", () => {
  test("returns immediately on the first poll without sleeping when already settled", async () => {
    const { spawnFn } = makeFakeGh(happyScript);
    const sleeps: number[] = [];
    const written: string[] = [];
    const code = await runStatusCommand({
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
    expect(sleeps).toEqual([]);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "").next_action).toBe("triage");
  });

  test("polls through pending until the review settles and writes only the settled JSON", async () => {
    let statusPolls = 0;
    const base = makeFakeGh(happyScript).spawnFn;
    const encoder = new TextEncoder();
    const spawnFn = ((argv: string[], opts?: unknown) => {
      if (argv.join(" ").includes(`commits/${HEAD}/status`)) {
        statusPolls += 1;
        if (statusPolls < 3) {
          const pendingRow = {
            state: "pending",
            context: COMMIT_STATUS_CONTEXT,
            created_at: new Date(NOW - 10_000).toISOString(),
            description: "pr-hero: review in progress",
            target_url: null,
          };
          const stream = (text: string) =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (text) controller.enqueue(encoder.encode(text));
                controller.close();
              },
            });
          return {
            stdout: stream(ndjson([pendingRow])),
            stderr: stream(""),
            exited: Promise.resolve(0),
            kill() {},
          };
        }
      }
      return (base as unknown as (a: string[], o?: unknown) => unknown)(
        argv,
        opts,
      );
    }) as unknown as typeof Bun.spawn;

    const sleeps: number[] = [];
    const written: string[] = [];
    const code = await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      pollIntervalMs: 1_000,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(statusPolls).toBe(3);
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "").next_action).toBe("triage");
  });

  test("throws a timeout CliError with nothing on stdout when maxWaitMs is exceeded", async () => {
    const pendingRow = {
      state: "pending",
      context: COMMIT_STATUS_CONTEXT,
      created_at: new Date(NOW - 5_000).toISOString(),
      description: "pr-hero: review in progress",
      target_url: null,
    };
    const { spawnFn } = makeFakeGh([
      prView,
      {
        match: [`commits/${HEAD}/status`],
        response: { stdout: ndjson([pendingRow]) },
      },
      ...happyScript.slice(2),
    ]);
    const written: string[] = [];
    const sleeps: number[] = [];
    const run = runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      pollIntervalMs: 1_000,
      maxWaitMs: 2_500,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      out: (text) => written.push(text),
    });
    await expect(run).rejects.toBeInstanceOf(CliError);
    await expect(run).rejects.toThrow(/Timed out after 2500 ms/);
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(written).toEqual([]);
  });

  test("retries a transient gh failure on a subsequent poll while waiting, then settles", async () => {
    let statusPolls = 0;
    const base = makeFakeGh(happyScript).spawnFn;
    const encoder = new TextEncoder();
    const spawnFn = ((argv: string[], opts?: unknown) => {
      if (argv.join(" ").includes(`commits/${HEAD}/status`)) {
        statusPolls += 1;
        const stream = (text: string) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (text) controller.enqueue(encoder.encode(text));
              controller.close();
            },
          });
        if (statusPolls === 1) {
          return {
            stdout: stream(
              ndjson([
                {
                  state: "pending",
                  context: COMMIT_STATUS_CONTEXT,
                  created_at: new Date(NOW - 5_000).toISOString(),
                  description: "pr-hero: review in progress",
                  target_url: null,
                },
              ]),
            ),
            stderr: stream(""),
            exited: Promise.resolve(0),
            kill() {},
          };
        }
        if (statusPolls === 2) {
          return {
            stdout: stream(""),
            stderr: stream("HTTP 502 Bad Gateway"),
            exited: Promise.resolve(1),
            kill() {},
          };
        }
      }
      return (base as unknown as (a: string[], o?: unknown) => unknown)(
        argv,
        opts,
      );
    }) as unknown as typeof Bun.spawn;

    const written: string[] = [];
    const code = await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      pollIntervalMs: 1_000,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(statusPolls).toBe(3);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "").next_action).toBe("triage");
  });
});

describe("crysk status — the review's verdict time", () => {
  const OLDER = "d".repeat(40);
  const EARLIER = "e".repeat(40);
  const REVIEW_RED =
    "pr-hero: 1 blocking finding(s) — fix and push, or /crysk override";
  const VERDICT_AT = "2026-10-30T10:00:00Z";
  const CARRIED_AT = "2026-10-30T12:00:00Z";

  const commitStatus = (
    state: string,
    created_at: string,
    description: string,
  ) => ({
    state,
    context: COMMIT_STATUS_CONTEXT,
    created_at,
    description,
    target_url: null,
  });

  // The summary the review wrote for `head`, with one blocking row.
  const summaryFor = (head: string) =>
    [
      `<!-- pr-hero-report head=${head} -->`,
      "",
      renderStateBlock(
        head,
        [
          stateFinding({
            id: "R001",
            sev: "CRITICAL",
            tier: "blocking",
            channel: "inline",
            locs: ["src/a.ts:10"],
            claim: CLAIM,
          }),
        ],
        1,
      ),
    ].join("\n");

  // A finding comment posted on `head`, as the review writes it.
  const findingAt = (head: string) =>
    [
      findingMarker({
        path: "src/a.ts",
        line: 10,
        headSha: head,
        claim: CLAIM,
      }),
      "",
      "🔴 blocking · CRITICAL · introduced · reliability",
      "",
      "`src/a.ts:10`",
      "",
      CLAIM,
    ].join("\n");

  // The head is carried from OLDER: the review of OLDER wrote its verdict at VERDICT_AT, and its
  // finding was posted on EARLIER. The reply is stamped with EARLIER and created at replyAt.
  const carriedScript = (replyAt: string): ScriptEntry[] => [
    prView,
    {
      match: [`commits/${HEAD}/status`],
      response: {
        stdout: ndjson([
          commitStatus(
            "failure",
            CARRIED_AT,
            carriedBlockingDescription(1, OLDER),
          ),
        ]),
      },
    },
    {
      match: ["pulls/12/commits"],
      response: { stdout: `${OLDER}\n${HEAD}\n` },
    },
    {
      match: [`commits/${OLDER}/statuses`],
      response: {
        stdout: ndjson([commitStatus("failure", VERDICT_AT, REVIEW_RED)]),
      },
    },
    {
      match: ["issues/12/comments"],
      response: {
        stdout: ndjson([{ id: 100, user: "pr-hero", body: summaryFor(OLDER) }]),
      },
    },
    {
      match: ["pulls/12/comments"],
      response: {
        stdout: ndjson([
          {
            id: 41,
            user: "pr-hero",
            body: findingAt(EARLIER),
            path: "src/a.ts",
            line: 10,
            original_line: 10,
            in_reply_to_id: null,
            created_at: "2026-10-30T09:00:00Z",
          },
          {
            id: 42,
            user: "developer",
            body: `${triageMarker({ tag: "applied", headSha: EARLIER, actor: "agent" })}\n\nreasoning`,
            path: "src/a.ts",
            line: 10,
            original_line: 10,
            in_reply_to_id: 41,
            created_at: replyAt,
          },
        ]),
      },
    },
  ];

  const runCarried = async (script: ScriptEntry[]) => {
    const { spawnFn, calls } = makeFakeGh(script);
    const written: string[] = [];
    await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      out: (text) => written.push(text),
    });
    return { next: JSON.parse(written[0] ?? "").next_action, calls };
  };

  test("a head with a review's own verdict never lists the pull request's commits", async () => {
    const { spawnFn, calls } = makeFakeGh(happyScript);
    await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      out: () => {},
    });
    expect(
      calls.some((c) => c.argv.join(" ").includes("pulls/12/commits")),
    ).toBe(false);
  });

  const commitListingsFor = async (script: ScriptEntry[]) => {
    const { spawnFn, calls } = makeFakeGh(script);
    await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      out: () => {},
    });
    return calls.filter((c) => c.argv.join(" ").includes("pulls/12/commits"));
  };

  test("a head with no crysk status never lists the pull request's commits", async () => {
    expect(
      await commitListingsFor([
        prView,
        { match: [`commits/${HEAD}/status`], response: { stdout: "" } },
      ]),
    ).toHaveLength(0);
  });

  test("a head with a pending status never lists the pull request's commits", async () => {
    expect(
      await commitListingsFor([
        prView,
        {
          match: [`commits/${HEAD}/status`],
          response: {
            stdout: ndjson([
              commitStatus(
                "pending",
                new Date(NOW - 5_000).toISOString(),
                "pr-hero: review in progress",
              ),
            ]),
          },
        },
      ]),
    ).toHaveLength(0);
  });

  test("a head an override turned green never lists the pull request's commits", async () => {
    expect(
      await commitListingsFor([
        prView,
        {
          match: [`commits/${HEAD}/status`],
          response: {
            stdout: ndjson([
              commitStatus(
                "success",
                new Date(NOW - 5_000).toISOString(),
                `${OVERRIDE_DESCRIPTION_PREFIX}dev`,
              ),
            ]),
          },
        },
      ]),
    ).toHaveLength(0);
  });

  test("a head a skip carried reads the carried review's verdict: a reply after it answers", async () => {
    const { next, calls } = await runCarried(
      carriedScript("2026-10-30T11:00:00Z"),
    );
    expect(next).toBe("fix");
    expect(
      calls.filter((c) => c.argv.join(" ").includes("pulls/12/commits")),
    ).toHaveLength(1);
  });

  test("a head a skip carried: a reply from before the carried review's verdict does not answer", async () => {
    const { next } = await runCarried(carriedScript("2026-10-30T09:00:00Z"));
    expect(next).toBe("triage");
  });

  test("the walk runs once per head across polls", async () => {
    let statusPolls = 0;
    let commitListings = 0;
    let commentsFailed = false;
    const base = makeFakeGh(carriedScript("2026-10-30T11:00:00Z")).spawnFn;
    const encoder = new TextEncoder();
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    const spawnFn = ((argv: string[], opts?: unknown) => {
      const joined = argv.join(" ");
      if (joined.includes("pulls/12/commits")) commitListings += 1;
      if (joined.includes(`commits/${HEAD}/status`)) {
        statusPolls += 1;
        if (statusPolls === 1) {
          return {
            stdout: stream(
              ndjson([
                commitStatus(
                  "pending",
                  new Date(NOW - 5_000).toISOString(),
                  "pr-hero: review in progress",
                ),
              ]),
            ),
            stderr: stream(""),
            exited: Promise.resolve(0),
            kill() {},
          };
        }
      }
      // One transient failure after the walk on poll 2: the next poll must reuse the walk.
      if (
        joined.includes("issues/12/comments") &&
        statusPolls === 2 &&
        !commentsFailed
      ) {
        commentsFailed = true;
        return {
          stdout: stream(""),
          stderr: stream("HTTP 502 Bad Gateway"),
          exited: Promise.resolve(1),
          kill() {},
        };
      }
      return (base as unknown as (a: string[], o?: unknown) => unknown)(
        argv,
        opts,
      );
    }) as unknown as typeof Bun.spawn;

    const written: string[] = [];
    const code = await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      pollIntervalMs: 1_000,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(statusPolls).toBe(3);
    expect(commitListings).toBe(1);
    expect(JSON.parse(written[0] ?? "").next_action).toBe("fix");
  });

  test("a walk that read nothing is read again on the next poll", async () => {
    let statusPolls = 0;
    let commitListings = 0;
    let commentsFailed = false;
    const base = makeFakeGh(carriedScript("2026-10-30T11:00:00Z")).spawnFn;
    const encoder = new TextEncoder();
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    const failed = (stderr: string) => ({
      stdout: stream(""),
      stderr: stream(stderr),
      exited: Promise.resolve(1),
      kill() {},
    });
    const spawnFn = ((argv: string[], opts?: unknown) => {
      const joined = argv.join(" ");
      if (joined.includes(`commits/${HEAD}/status`)) {
        statusPolls += 1;
        // Poll 1 settles nothing, so no walk runs on it; polls 2 and 3 see the carried red.
        if (statusPolls === 1) {
          return {
            stdout: stream(
              ndjson([
                commitStatus(
                  "pending",
                  new Date(NOW - 5_000).toISOString(),
                  "pr-hero: review in progress",
                ),
              ]),
            ),
            stderr: stream(""),
            exited: Promise.resolve(0),
            kill() {},
          };
        }
      }
      if (joined.includes("pulls/12/commits")) {
        commitListings += 1;
        // The walk on poll 2 reads nothing: poll 3 must walk again rather than hold the null.
        if (commitListings === 1) return failed("HTTP 502 Bad Gateway");
      }
      // One transient failure after the walk on poll 2, so poll 3 runs on the same head.
      if (
        joined.includes("issues/12/comments") &&
        statusPolls === 2 &&
        !commentsFailed
      ) {
        commentsFailed = true;
        return failed("HTTP 502 Bad Gateway");
      }
      return (base as unknown as (a: string[], o?: unknown) => unknown)(
        argv,
        opts,
      );
    }) as unknown as typeof Bun.spawn;

    const written: string[] = [];
    const code = await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      pollIntervalMs: 1_000,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(commitListings).toBe(2);
    expect(JSON.parse(written[0] ?? "").next_action).toBe("fix");
  });
});

describe("runStatusCommand: the reply authors' permissions", () => {
  const replyBy = (user: string, id: number) => ({
    id,
    user,
    created_at: new Date(NOW - 60_000).toISOString(),
    body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nreasoning`,
    path: "src/a.ts",
    line: 10,
    original_line: 10,
    in_reply_to_id: 41,
  });
  const withReplies = (replies: unknown[]): ScriptEntry[] =>
    happyScript.map((entry) =>
      entry.match[0] === "pulls/12/comments"
        ? {
            ...entry,
            response: {
              stdout: ndjson([
                {
                  id: 41,
                  user: "pr-hero",
                  body: findingBody,
                  path: "src/a.ts",
                  line: 10,
                  original_line: 10,
                  in_reply_to_id: null,
                },
                ...replies,
              ]),
            },
          }
        : entry,
    );

  test("a reply author's permission that does not read fails the command, and nothing reaches stdout", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["collaborators/stranger/permission"],
        response: { stderr: "HTTP 500", exitCode: 1 },
      },
      ...withReplies([replyBy("stranger", 42)]),
    ]);
    const written: string[] = [];
    const run = runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    await expect(run).rejects.toBeInstanceOf(CliError);
    await expect(run).rejects.toThrow(
      /could not read whether stranger has write access/,
    );
    expect(written).toEqual([]);
  });

  test("a stale reply from a login whose permission does not read does not fail the command", async () => {
    // Older than the verdict on HEAD (happyScript's red gate), at an older head: the gate drops it.
    const staleBy = {
      ...replyBy("ghost", 42),
      created_at: new Date(NOW - 10 * 60_000).toISOString(),
      body: `${triageMarker({ tag: "applied", headSha: "d".repeat(40), actor: "agent" })}\n\nreasoning`,
    };
    const run = async (script: ScriptEntry[]) => {
      const written: string[] = [];
      const code = await runStatusCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 12,
        json: true,
        spawnFn: makeFakeGh(script).spawnFn,
        nowMs: NOW,
        sleepFn: async () => {},
        out: (text) => written.push(text),
      });
      return { code, written };
    };
    const withStale = await run([
      {
        match: ["collaborators/ghost/permission"],
        response: { stderr: "HTTP 500", exitCode: 1 },
      },
      ...withReplies([staleBy]),
    ]);
    const without = await run(withReplies([]));
    expect(withStale.code).toBe(0);
    expect(withStale.written).toEqual(without.written);
  });

  test("the permission of a reply author is asked once across polls", async () => {
    const pending = {
      state: "pending",
      context: COMMIT_STATUS_CONTEXT,
      created_at: new Date(NOW - 5_000).toISOString(),
      description: "pr-hero: review in progress",
      target_url: null,
    };
    const base = makeFakeGh(withReplies([replyBy("dev", 42)])).spawnFn;
    let statusPolls = 0;
    let permissionAsks = 0;
    const spawnFn = ((argv: string[], opts?: unknown) => {
      const joined = argv.join(" ");
      if (joined.includes("collaborators/dev/permission")) permissionAsks += 1;
      if (joined.includes(`commits/${HEAD}/status`)) {
        statusPolls += 1;
        const row = statusPolls === 1 ? pending : gateRow;
        return makeFakeGh([
          {
            match: [`commits/${HEAD}/status`],
            response: { stdout: ndjson([row]) },
          },
        ]).spawnFn(argv);
      }
      return (base as unknown as (a: string[], o?: unknown) => unknown)(
        argv,
        opts,
      );
    }) as unknown as typeof Bun.spawn;

    const written: string[] = [];
    const code = await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      wait: true,
      spawnFn,
      nowMs: NOW,
      pollIntervalMs: 1_000,
      sleepFn: async () => {},
      out: (text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(statusPolls).toBe(2);
    expect(permissionAsks).toBe(1);
  });
});

// The skill loads the playbook of the engine that reviewed the PR. Status runs
// every round of the loop, so it is what notices a new engine version: it
// records the version for `skills load` and names the reload command.
describe("runStatusCommand — the engine version", () => {
  const stampedScript = (user: string): ScriptEntry[] =>
    happyScript.map((entry) =>
      entry.match.includes("issues/12/comments")
        ? {
            ...entry,
            response: {
              stdout: ndjson([
                {
                  id: 100,
                  user,
                  body: `${summaryBody}\n${renderCiAdmissionBlock(HEAD, { blocking: 1, advisory: 0 }, 1, "0.10.0")}`,
                },
              ]),
            },
          }
        : entry,
    );

  async function run(user: string) {
    const { spawnFn } = makeFakeGh(stampedScript(user));
    const recorded: string[] = [];
    const written: string[] = [];
    const code = await runStatusCommand({
      operatorRoot: OPERATOR_ROOT,
      pr: 12,
      json: true,
      spawnFn,
      nowMs: NOW,
      cliVersion: "0.9.5",
      recordEngine: (version, at) => recorded.push(`${version} ${at}`),
      out: (text) => written.push(text),
    });
    return { code, recorded, json: JSON.parse(written[0] ?? "{}") };
  }

  test("records the version and prints the reload command", async () => {
    const { code, recorded, json } = await run("github-actions[bot]");
    expect(code).toBe(0);
    expect(recorded).toEqual([`0.10.0 ${gateRow.created_at}`]);
    expect(json.report.engine_version).toBe("0.10.0");
    expect(json.skills_reload).toBe(
      "npx -y crysk@0.10.0 skills load crysk-loop",
    );
  });

  test("records nothing when no bot wrote the summary", async () => {
    const { recorded, json } = await run("someone");
    expect(recorded).toEqual([]);
    expect(json.skills_reload).toBeNull();
  });
});
