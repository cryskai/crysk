// The I/O shell of `pr-hero status` (src/commands/status.ts), driven through the spawnFn seam
// with a fake gh. The pure decisions are tested in test/pr/pr-status.test.ts; this file pins
// what the shell adds: the reads it makes, the one stdout write it allows, and the fail-closed
// exits. A gh failure or a truncated comment read is a CliError and writes nothing to stdout.

import { describe, expect, test } from "bun:test";
import { runStatusCommand, statusCommand } from "#commands/status";
import { CommentsTruncatedError, GRAPHQL_COMMENT_MAX_PAGES } from "#pr/pr";
import { COMMIT_STATUS_CONTEXT, findingMarker } from "#pr/preflight";
import { renderStateBlock, stateFinding } from "#rereview/state";
import { parseArgs } from "#review/preflight";
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
    const entry = script.find((s) => s.match.every((t) => joined.includes(t)));
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
    "pr-hero: 1 blocking finding(s) — fix and push, or /pr-hero override",
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
