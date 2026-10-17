// Offline tests for pr/pr.ts's WU4/WU5 additions (ROADMAP B6): the review-level
// fetcher, the atomic review submission with its 422 recovery, and the
// per-finding issue comment. Same fake-spawn pattern as
// test/step-runner.test.ts's makeFakeSpawn: no real gh/PR anywhere here.
//
// Design Threat Matrix scope note (PR2 verification, WARN-1): the matrix's
// "Git repository selection" row (Applicable — "the `post` verb resolves
// operator root; rejects a run-dir from another PR") names a RED test that
// genuinely cannot be written here. The `post` verb it describes is WU6
// (tasks 3.1-3.3), not yet built — this file only exercises the I/O
// primitives (fetch/postPrReview/postIssueComment) the verb will eventually
// call, and none of them take a run-dir or resolve an operator root by
// themselves (their caller already has one). That RED test belongs beside
// the verb's own parsing/dispatch, in a future test/cli.test.ts addition
// for WU6 — flagged here rather than skipped in silence.
//
// The matrix's OTHER applicable row — "PR commands" (bodies travel on
// stdin, never interpolated into argv) — IS in scope for this file, and is
// covered below: "the body reaching gh on stdin carries the finding's
// identity marker and its claim, verbatim, never via argv".

import { describe, expect, test } from "bun:test";
import {
  ADMISSION_CHECK_RUN_NAME,
  type AdmissionRecord,
  serializeAdmissionRecord,
} from "#ci/admission-ledger";
import { SKIP_SIZE_COMMENT_MARKER } from "#ci/gates";
import type { PrHeroFindingRef } from "#compare/compare";
import {
  CommentsTruncatedError,
  fetchCommitStatuses,
  fetchCommitStatusList,
  fetchPostedFindingComments,
  fetchPrComments,
  fetchPrCommitShas,
  fetchPrReviewComments,
  GRAPHQL_COMMENT_MAX_PAGES,
  ghPrFiles,
  ghPrHeadSha,
  ghRepoWebUrl,
  listAdmissionCheckRuns,
  POSTING_GH_TIMEOUT_MS,
  parseCompareChangedFiles,
  parsePrHeroWorkflowRunHeads,
  postCommitStatus,
  postIssueComment,
  postIssueTriageComment,
  postPrComment,
  postPrReview,
  postReviewCommentReply,
  repostMarkedPrComment,
  resolveReviewThreadForComment,
  upsertAdmissionCheckRun,
} from "#pr/pr";
import {
  CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
  COMMIT_STATUS_CONTEXT,
  COMMIT_STATUS_TIMEOUT_MS,
  commitStatusRequest,
  findingMarker,
  LOCAL_COMMIT_STATUS_CONTEXT,
  PR_COMMENT_MARKER_PREFIX,
  PR_FINDING_MARKER_PREFIX,
} from "#pr/preflight";
import type { Finding } from "#review/findings";
import { renderIssueFindingComment } from "#review/report";
import { GH_PR_VIEW_TIMEOUT_MS } from "#store/gc-preflight";
import { CliError } from "../../src/errors";

// ---------------------------------------------------------------------------
// FakeSpawn: scripted {stdout, stderr, exitCode} per call, in call order.
// Mirrors makeFakeSpawn (test/step-runner.test.ts) but keyed off an argv
// PREDICATE list instead of a flat sequence — pr/pr.ts issues concurrent gh
// calls (fetchPostedFindingComments's Promise.all), so "the Nth call" is not
// a stable enough key.
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

interface ScriptEntry {
  // Matches when every token appears, in order, somewhere in argv.
  match: string[];
  response: ScriptedResponse;
}

interface RecordedCall {
  argv: string[];
  cwd: string | undefined;
  stdin: string | undefined;
}

function argvContains(argv: string[], tokens: string[]): boolean {
  const joined = argv.join(" ");
  return tokens.every((token) => joined.includes(token));
}

function makeFakeGh(script: ScriptEntry[]): {
  spawnFn: typeof Bun.spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const spawnFn = ((
    argv: string[],
    opts?: { cwd?: string; stdin?: Uint8Array },
  ) => {
    const stdin =
      opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin);
    calls.push({ argv, cwd: opts?.cwd, stdin });
    const entry = script.find((s) => argvContains(argv, s.match));
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

const repoView = {
  match: ["repo", "view", "--json", "owner,name"],
  response: {
    stdout: JSON.stringify({
      name: "musive",
      owner: { login: "MusiveTech" },
    }),
  },
};

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    category: 12,
    path: "src/app.ts",
    line: 42,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "the value is stored in seconds and read as milliseconds",
    proof_refs: [],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 2,
    hop_trail: [],
    dedupe_key: `${overrides.path ?? "src/app.ts"}::12`,
    ...overrides,
  };
}

// ndjson helper matching gh's `--jq` line-per-object streaming.
function ndjson(rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("fetchPrReviewComments", () => {
  test("projects id, user, body, path, line, original_line, in_reply_to_id", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 1,
              user: "octocat",
              body: "looks good",
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const comments = await fetchPrReviewComments(OPERATOR_ROOT, 42, {
      spawnFn,
    });
    expect(comments).toEqual([
      {
        id: 1,
        user: "octocat",
        body: "looks good",
        path: "src/a.ts",
        line: 10,
        original_line: 10,
        in_reply_to_id: null,
      },
    ]);
    const call = calls[0];
    expect(call?.argv).toContain("--paginate");
    expect(call?.argv.join(" ")).toContain("pulls/42/comments");
    // The fake gh harness returns scripted stdout regardless of --jq, so
    // pinning the RESPONSE (above) never proves the projection string
    // itself asks for every field the matcher needs — dropping one from
    // `--jq` would still pass a fixture-shaped test. Assert the field
    // names the matcher and a human reader both rely on actually reached
    // gh's argv (WARN-2, PR2 verification): id/user/body for identity and
    // display, path/line for the matcher's live-location preference (D2),
    // original_line + in_reply_to_id for the fields a raw fetch documents.
    const jqIndex = call?.argv.indexOf("--jq") ?? -1;
    expect(jqIndex).toBeGreaterThanOrEqual(0);
    const projection = call?.argv[jqIndex + 1] ?? "";
    // Exact "<key>: .<jq-path>" tokens, not bare field names: "line" is a
    // substring of "original_line", so a bare-name check would stay green
    // even if the `line: .line` clause itself were dropped.
    for (const token of [
      "id: .id",
      "user: .user.login",
      "body: .body",
      "path: .path",
      "line: .line",
      "original_line: .original_line",
      "in_reply_to_id: .in_reply_to_id",
    ]) {
      expect(projection).toContain(token);
    }
  });

  test("a non-404 non-2xx response fails loud", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stderr: "gh: server error (HTTP 500)", exitCode: 1 },
      },
    ]);
    await expect(
      fetchPrReviewComments(OPERATOR_ROOT, 42, { spawnFn }),
    ).rejects.toThrow(/pulls\/42\/comments failed/);
  });

  test("REST 404 on pulls/<n>/comments falls back to GraphQL", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
      {
        match: ["graphql", "reviewThreads"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        comments: {
                          nodes: [
                            {
                              fullDatabaseId: 9,
                              body: "inline",
                              author: { login: "pr-hero" },
                              path: "src/a.ts",
                              line: 12,
                              originalLine: 10,
                              replyTo: null,
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const comments = await fetchPrReviewComments(OPERATOR_ROOT, 42, {
      spawnFn,
    });
    expect(comments).toEqual([
      {
        id: 9,
        user: "pr-hero",
        body: "inline",
        path: "src/a.ts",
        line: 12,
        original_line: 10,
        in_reply_to_id: null,
      },
    ]);
    expect(calls.some((c) => c.argv.join(" ").includes("graphql"))).toBe(true);
  });

  test("GraphQL maps a Bot author to its [bot] login and keeps a User login", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
      {
        match: ["graphql", "reviewThreads"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        comments: {
                          nodes: [
                            {
                              fullDatabaseId: 9,
                              body: "bot",
                              author: {
                                login: "github-actions",
                                __typename: "Bot",
                              },
                              path: "src/a.ts",
                              line: 12,
                              originalLine: 10,
                              replyTo: null,
                            },
                            {
                              fullDatabaseId: 10,
                              body: "human",
                              author: { login: "octocat", __typename: "User" },
                              path: "src/a.ts",
                              line: 12,
                              originalLine: 10,
                              replyTo: { fullDatabaseId: 9 },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const comments = await fetchPrReviewComments(OPERATOR_ROOT, 42, {
      spawnFn,
    });
    expect(comments.map((c) => [c.id, c.user])).toEqual([
      [9, "github-actions[bot]"],
      [10, "octocat"],
    ]);
    expect(
      calls.some((c) => c.argv.join(" ").includes("author{login __typename}")),
    ).toBe(true);
  });

  test("an unparseable line fails loud rather than silently dropping it", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stdout: "not json\n" },
      },
    ]);
    await expect(
      fetchPrReviewComments(OPERATOR_ROOT, 42, { spawnFn }),
    ).rejects.toThrow(/unparseable line/);
  });
});

describe("parseCompareChangedFiles", () => {
  test("extracts filenames from a compare API payload", () => {
    expect(
      parseCompareChangedFiles(
        JSON.stringify({
          files: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
        }),
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("parsePrHeroWorkflowRunHeads", () => {
  const HEAD = "a".repeat(40);
  const OTHER = "b".repeat(40);

  test("counts only completed success/failure runs with full SHAs", () => {
    expect(
      parsePrHeroWorkflowRunHeads(
        JSON.stringify([
          { headSha: HEAD, conclusion: "success" },
          { headSha: OTHER, conclusion: "failure" },
          { headSha: "c".repeat(40), conclusion: "cancelled" },
          { headSha: "short", conclusion: "success" },
        ]),
      ),
    ).toEqual(new Set([HEAD, OTHER]));
  });
});

describe("fetchPrReviewComments — GraphQL pagination", () => {
  test("follows reviewThreads pageInfo until hasNextPage is false", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
      {
        match: ["graphql", "reviewThreads", "cursor1"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        comments: {
                          nodes: [
                            {
                              fullDatabaseId: 2,
                              body: "page-two",
                              author: { login: "pr-hero" },
                              path: "src/b.ts",
                              line: 2,
                              originalLine: 2,
                              replyTo: null,
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
      {
        match: ["graphql", "reviewThreads"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                    nodes: [
                      {
                        comments: {
                          nodes: [
                            {
                              fullDatabaseId: 1,
                              body: "page-one",
                              author: { login: "pr-hero" },
                              path: "src/a.ts",
                              line: 1,
                              originalLine: 1,
                              replyTo: null,
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const comments = await fetchPrReviewComments(OPERATOR_ROOT, 42, {
      spawnFn,
    });
    expect(comments.map((c) => c.id)).toEqual([1, 2]);
    expect(
      calls.filter((c) => c.argv.join(" ").includes("reviewThreads")).length,
    ).toBe(2);
  });
});

describe("fetchPrComments — REST 404 GraphQL fallback", () => {
  test("REST 404 on issues/<n>/comments falls back to GraphQL", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
      {
        match: ["graphql", "databaseId"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        databaseId: 7,
                        body: "summary",
                        author: { login: "pr-hero" },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const comments = await fetchPrComments(OPERATOR_ROOT, 42, { spawnFn });
    expect(comments).toEqual([{ id: 7, user: "pr-hero", body: "summary" }]);
    expect(calls.some((c) => c.argv.join(" ").includes("graphql"))).toBe(true);
  });

  test("S-B — REST updated_at is optional and forwarded", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 1,
              user: "pr-hero",
              body: "summary",
              created_at: "2026-08-20T12:00:00Z",
              updated_at: "2026-08-21T09:00:00Z",
            },
          ]),
        },
      },
    ]);
    const comments = await fetchPrComments(OPERATOR_ROOT, 42, { spawnFn });
    expect(comments).toEqual([
      {
        id: 1,
        user: "pr-hero",
        body: "summary",
        created_at: "2026-08-20T12:00:00Z",
        updated_at: "2026-08-21T09:00:00Z",
      },
    ]);
  });
});

describe("fetchPrComments — GraphQL pagination", () => {
  test("follows issue comment pageInfo until hasNextPage is false", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
      {
        match: ["graphql", "databaseId", "cursor1"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        databaseId: 8,
                        body: "page-two",
                        author: { login: "pr-hero" },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
      {
        match: ["graphql", "databaseId"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                    nodes: [
                      {
                        databaseId: 7,
                        body: "page-one",
                        author: { login: "pr-hero" },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const comments = await fetchPrComments(OPERATOR_ROOT, 42, { spawnFn });
    expect(comments.map((c) => c.id)).toEqual([7, 8]);
    expect(
      calls.filter((c) => c.argv.join(" ").includes("databaseId")).length,
    ).toBe(2);
  });

  test("throws CommentsTruncatedError when page limit is exceeded", async () => {
    const pages: ScriptEntry[] = [
      {
        match: ["issues/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
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
    await expect(
      fetchPrComments(OPERATOR_ROOT, 42, { spawnFn }),
    ).rejects.toBeInstanceOf(CommentsTruncatedError);
  });
});

describe("fetchPrReviewComments — GraphQL page limit", () => {
  test("throws CommentsTruncatedError when reviewThreads exceed page limit", async () => {
    const pages: ScriptEntry[] = [
      {
        match: ["pulls/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
    ];
    for (let i = 0; i < GRAPHQL_COMMENT_MAX_PAGES; i++) {
      const cursor = i === 0 ? "" : `cursor${i}`;
      pages.push({
        match:
          cursor.length === 0
            ? ["graphql", "reviewThreads"]
            : ["graphql", "reviewThreads", cursor],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: `cursor${i + 1}`,
                    },
                    nodes: [
                      {
                        comments: {
                          nodes: [
                            {
                              fullDatabaseId: i + 1,
                              body: `page-${i + 1}`,
                              author: { login: "pr-hero" },
                              path: "src/a.ts",
                              line: i + 1,
                              originalLine: i + 1,
                              replyTo: null,
                            },
                          ],
                        },
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
    await expect(
      fetchPrReviewComments(OPERATOR_ROOT, 42, { spawnFn }),
    ).rejects.toBeInstanceOf(CommentsTruncatedError);
  });
});

describe("fetchPostedFindingComments — marker prefix disjointness", () => {
  // The regression the design calls for explicitly (WARN scope, PR2): both
  // marker families now live in the SAME issue-comment stream, so the
  // summary comment must never be mistaken for a per-finding one, and vice
  // versa, when scanned by the ACTUAL matcher this run uses — not merely by
  // comparing the two prefix strings (that test already exists, PR1).
  test("a pr-hero-report summary comment is excluded from the finding set", async () => {
    const summaryMarker = `<!-- pr-hero-report head=${HEAD} -->\n## pr-hero review`;
    const findingMarkerBody =
      "<!-- pr-hero-finding path=src%2Fa.ts line=10 head=" +
      `${HEAD} c=abcdef123456 -->\nclaim text`;
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stdout: ndjson([]) },
      },
      {
        match: ["issues/42/comments"],
        response: {
          stdout: ndjson([
            { id: 1, user: "pr-hero", body: summaryMarker },
            { id: 2, user: "pr-hero", body: findingMarkerBody },
            { id: 3, user: "octocat", body: "just a human reply" },
          ]),
        },
      },
    ]);
    const posted = await fetchPostedFindingComments(OPERATOR_ROOT, 42, {
      spawnFn,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.id).toBe(2);
    expect(posted[0]?.channel).toBe("issue");
  });

  test("review comments with a finding marker are projected with their live path/line", async () => {
    const findingMarkerBody =
      "<!-- pr-hero-finding path=src%2Fa.ts line=10 head=" +
      `${HEAD} c=abcdef123456 -->\nclaim text`;
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 9,
              user: "pr-hero",
              body: findingMarkerBody,
              path: "src/a.ts",
              line: 12,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      { match: ["issues/42/comments"], response: { stdout: ndjson([]) } },
    ]);
    const posted = await fetchPostedFindingComments(OPERATOR_ROOT, 42, {
      spawnFn,
    });
    expect(posted).toEqual([
      {
        id: 9,
        channel: "review",
        marker: {
          path: "src/a.ts",
          line: 10,
          headSha: HEAD,
          c: "abcdef123456",
        },
        livePath: "src/a.ts",
        liveLine: 12,
      },
    ]);
  });
});

// PrHeroFindingRef conversion — postPrReview's `allFindings` argument is the
// FULL finding list the plan matched against (CRIT-A fix, verify-report-pr3
// #3305), not the review-submission subset. Findings' own shape already
// carries every field a ref needs.
function toRef(f: Finding): PrHeroFindingRef {
  return { id: f.id, path: f.path, line: f.line, claim: f.claim, tier: f.tier };
}

// GitHub #39: the re-read behind the moved-head disclosure. Its whole
// contract is that it never throws and never guesses — the pin is what makes
// the comments correct, this call only decides whether there is anything to
// SAY about it, so an unanswerable question must cost nothing.
describe("ghPrHeadSha", () => {
  test("asks for exactly one field and returns the trimmed sha", async () => {
    const { spawnFn, calls } = makeFakeGh([
      { match: ["headRefOid"], response: { stdout: `${HEAD}\n` } },
    ]);
    expect(await ghPrHeadSha(OPERATOR_ROOT, 42, { spawnFn })).toBe(HEAD);
    expect(calls[0]?.argv).toEqual([
      "gh",
      "pr",
      "view",
      "42",
      "--json",
      "headRefOid",
      "-q",
      ".headRefOid",
    ]);
  });

  test("a gh failure is undefined, never a throw — the post outlives it", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["headRefOid"],
        response: { stderr: "gh: rate limited (HTTP 403)", exitCode: 1 },
      },
    ]);
    expect(await ghPrHeadSha(OPERATOR_ROOT, 42, { spawnFn })).toBeUndefined();
  });

  // An empty answer is NOT a sha, and comparing "" against the reviewed head
  // would manufacture a mismatch out of a missing answer — a false "the PR
  // moved" notice on a PR that never moved.
  test("empty stdout is undefined, not an empty-string sha", async () => {
    const { spawnFn } = makeFakeGh([
      { match: ["headRefOid"], response: { stdout: "\n" } },
    ]);
    expect(await ghPrHeadSha(OPERATOR_ROOT, 42, { spawnFn })).toBeUndefined();
  });
});

describe("postPrReview", () => {
  test("zero anchorable findings never reaches gh at all", async () => {
    const { spawnFn, calls } = makeFakeGh([]);
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings: [],
      allFindings: [],
      spawnFn,
    });
    expect(outcome).toEqual({ outcome: "posted", findings: [] });
    expect(calls).toHaveLength(0);
  });

  test("multiple findings post as ONE review submission, not one per finding", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: { stdout: "{}", exitCode: 0 },
      },
    ]);
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
    ];
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings,
      allFindings: findings.map(toRef),
      spawnFn,
    });
    expect(outcome).toEqual({ outcome: "posted", findings });
    // Exactly one gh invocation for the review, carrying BOTH comments.
    const reviewCalls = calls.filter((c) =>
      c.argv.join(" ").includes("reviews"),
    );
    expect(reviewCalls).toHaveLength(1);
    const call = reviewCalls[0];
    expect(call?.argv).toContain("--input");
    expect(call?.argv.join(" ")).toContain("pulls/42/reviews");
  });

  // The load-bearing check itself: prove the body sent on stdin carries
  // event: COMMENT and a comments[] array with one entry per finding.
  test("the request body is a single COMMENT review with comments[] per finding", async () => {
    let capturedStdin: Uint8Array | undefined;
    const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
      if (argv.join(" ").includes("reviews")) capturedStdin = opts?.stdin;
      const encoder = new TextEncoder();
      const stream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
      return {
        stdout: stream("{}"),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
    ];
    await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings,
      allFindings: findings.map(toRef),
      spawnFn,
    });
    expect(capturedStdin).toBeDefined();
    const body = JSON.parse(new TextDecoder().decode(capturedStdin));
    expect(body.event).toBe("COMMENT");
    expect(body.comments).toHaveLength(2);
    expect(body.comments[0].path).toBe("src/a.ts");
    expect(body.comments[0].line).toBe(10);
    expect(typeof body.comments[0].body).toBe("string");
  });

  // GitHub #39, the defect itself. WITHOUT commit_id, GitHub resolves every
  // `line` against the PR's latest commit AT POST TIME, so a push mid-review
  // re-anchors the comments to code the findings were never about. The pin
  // travels on STDIN (`--input -`), never argv, so this asserts the recorded
  // stdin — argv would pass while the body carried nothing.
  test("the review submission is pinned to the reviewed head via commit_id", async () => {
    const { spawnFn, calls } = makeFakeGh([
      { match: ["pulls/42/reviews"], response: { stdout: "{}", exitCode: 0 } },
    ]);
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings,
      allFindings: findings.map(toRef),
      spawnFn,
    });
    const call = calls.find((c) => c.argv.join(" ").includes("reviews"));
    expect(call?.stdin).toBeDefined();
    const body = JSON.parse(call?.stdin ?? "{}");
    expect(body.commit_id).toBe(HEAD);
    // Not smuggled into argv on the way: the whole body is one stdin
    // document, and a commit_id on the command line would be a different
    // (shell-quoted) surface.
    expect(call?.argv.join(" ")).not.toContain(HEAD);
  });

  // The 422 recovery (spec "GitHub is the anchor authority", design D1):
  // the atomic submission is rejected, and every finding still reaches a
  // channel — none are silently dropped.
  test("a 422 demotes every still-unmatched finding, none dropped", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
      finding({ id: "F003", path: "src/c.ts", line: 30 }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
      { match: ["pulls/42/comments"], response: { stdout: ndjson([]) } },
      { match: ["issues/42/comments"], response: { stdout: ndjson([]) } },
    ]);
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings,
      allFindings: findings.map(toRef),
      spawnFn,
    });
    expect(outcome.outcome).toBe("demoted");
    expect(outcome.findings.map((f) => f.id).sort()).toEqual([
      "F001",
      "F002",
      "F003",
    ]);
    // The recovery re-fetches BOTH streams (the matcher's own contract).
    expect(
      calls.some((c) => c.argv.join(" ").includes("pulls/42/comments")),
    ).toBe(true);
    expect(
      calls.some((c) => c.argv.join(" ").includes("issues/42/comments")),
    ).toBe(true);
    // The rejected submission is never retried — exactly one attempt at the
    // review endpoint.
    expect(
      calls.filter((c) => c.argv.join(" ").includes("reviews")),
    ).toHaveLength(1);
    // GitHub #39's acceptance criterion that is most likely to break in
    // silence: the pin must not turn this recoverable demotion into a hard
    // failure. The rejected submission carried commit_id, and the recovery
    // ran anyway — which is also the shape of the NEW 422 class the pin
    // introduces (a force-push that rewrites the reviewed commit out of the
    // PR makes GitHub reject the submission outright, where the unpinned
    // code would have silently posted against whatever replaced it).
    const submission = calls.find((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    expect(JSON.parse(submission?.stdin ?? "{}").commit_id).toBe(HEAD);
  });

  // The matcher doubles as the recovery mechanism: a finding that the
  // re-fetch shows is ALREADY posted (e.g. a leftover from a crashed prior
  // run) is not reposted — it drops out of the demoted set because it is no
  // longer "fresh".
  test("a 422 does not repost a finding already covered by a leftover comment", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
    ];
    // F002 fix: the exact same-head branch now consults the claim
    // fingerprint too, so a "same finding, already posted" fixture needs a
    // REAL matching fingerprint — F001's default claim, not an arbitrary
    // placeholder `c` that happened to be irrelevant before this fix.
    const leftoverMarker = `${findingMarker({
      path: "src/a.ts",
      line: 10,
      headSha: HEAD,
      claim: "the value is stored in seconds and read as milliseconds",
    })}\nthe value is stored in seconds and read as milliseconds`;
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
      {
        match: ["pulls/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 7,
              user: "pr-hero",
              body: leftoverMarker,
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      { match: ["issues/42/comments"], response: { stdout: ndjson([]) } },
    ]);
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings,
      allFindings: findings.map(toRef),
      spawnFn,
    });
    expect(outcome.outcome).toBe("demoted");
    // F001 already has a home (the leftover comment); only F002 is fresh.
    expect(outcome.findings.map((f) => f.id)).toEqual(["F002"]);
  });

  // CRIT-A (verify-report-pr3, #3305) — the property this whole recovery
  // exists to hold: a finding must reach neither-channel NEVER, for ANY
  // arrangement, not just the one arrangement PR2's regression test covered.
  // This is the verifier's exact tie-dissolution repro. Prior comments R1 @
  // line 100 and R2 @ line 104 both sit within FINDING_LINE_WINDOW (5) of
  // F001 @ line 102 — a genuine tie the ORIGINAL plan (buildPostPlan, called
  // with the full finding list) resolves by posting F001 fresh, because
  // F002 @ line 104 exactly claims R2 and F001's distance to R1 and R2 is
  // identical (2 and 2). The bug this guards: re-matching only the review
  // submission's OWN subset (`findings: [F001]`) against a comment set with
  // R2 excluded would leave R1 as F001's SOLE candidate, dissolving the tie
  // and silently swallowing F001. Passing the FULL finding list as
  // `allFindings` reproduces the plan's own tie exactly, so F001 stays
  // fresh — this is the assertion that fails if `allFindings` is ever
  // narrowed back to `findings` (reintroducing CRIT-A).
  test("a tie the plan already resolved to 'post fresh' survives the 422 recovery (CRIT-A)", async () => {
    const r1 =
      "<!-- pr-hero-finding path=src%2Fa.ts line=100 head=" +
      `${HEAD} c=000000000000 -->\nprior claim one`;
    const r2 =
      "<!-- pr-hero-finding path=src%2Fa.ts line=104 head=" +
      `${HEAD} c=000000000000 -->\nprior claim two`;
    const f001 = finding({
      id: "F001",
      path: "src/a.ts",
      line: 102,
      claim: "a genuinely new finding, distinct from either prior comment",
    });
    const f002 = finding({
      id: "F002",
      path: "src/a.ts",
      line: 104,
      claim: "matches the prior comment at line 104 exactly",
    });
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
      {
        match: ["pulls/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 101,
              user: "pr-hero",
              body: r1,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
            {
              id: 102,
              user: "pr-hero",
              body: r2,
              path: "src/a.ts",
              line: 104,
              original_line: 104,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      { match: ["issues/42/comments"], response: { stdout: ndjson([]) } },
    ]);
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      // The submission the plan actually made: only F001 (F002 already
      // persisted to R2 and never reached the review endpoint at all).
      findings: [f001],
      // The FULL finding list, exactly as buildPostPlan saw it — this is
      // what preserves the tie.
      allFindings: [f001, f002].map(toRef),
      spawnFn,
    });
    expect(outcome.outcome).toBe("demoted");
    // F001 must still be here — reaching the issue-comment channel — never
    // silently dropped because R2 (claimed by F002) briefly looked like its
    // sole remaining candidate.
    expect(outcome.findings.map((f) => f.id)).toEqual(["F001"]);
  });

  test("a non-422 failure fails loud rather than silently degrading", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: { stderr: "gh: server error (HTTP 500)", exitCode: 1 },
      },
    ]);
    const f001 = finding({ id: "F001" });
    await expect(
      postPrReview({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        headSha: HEAD,
        findings: [f001],
        allFindings: [f001].map(toRef),
        spawnFn,
      }),
    ).rejects.toThrow(/post PR review/);
  });
});

describe("postIssueComment", () => {
  test("posts a standalone comment per finding and returns its id", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stdout: JSON.stringify({ id: 55 }), exitCode: 0 },
      },
    ]);
    const id = await postIssueComment(
      OPERATOR_ROOT,
      42,
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      HEAD,
      undefined,
      spawnFn,
    );
    expect(id).toBe(55);
    const call = calls.find((c) =>
      c.argv.join(" ").includes("issues/42/comments"),
    );
    expect(call?.argv).toContain("POST");
    expect(call?.argv).toContain("-F");
  });

  // WARN-1 from the PR2 verification: mutating this function to send
  // NOTHING on stdin left the suite green, so nothing proved the body —
  // including its identity marker, the thing spec R11's no-repost
  // guarantee rides on — ever reaches gh. Also closes the design's
  // Threat Matrix "PR commands" row's promised RED test: a body with
  // shell-special characters posts VERBATIM on stdin, never composed
  // into argv (no interpolation surface).
  test("the body reaching gh on stdin carries the finding's identity marker and its claim, verbatim, never via argv", async () => {
    let capturedStdin: Uint8Array | undefined;
    let capturedArgv: string[] = [];
    const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
      capturedArgv = argv;
      capturedStdin = opts?.stdin;
      const encoder = new TextEncoder();
      const stream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
      return {
        stdout: stream(JSON.stringify({ id: 55 })),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    const tricky = finding({
      id: "F009",
      path: "src/a.ts",
      line: 10,
      claim: "shell danger: `backticks`, --flags, $(subshell), and | pipes",
    });
    const id = await postIssueComment(
      OPERATOR_ROOT,
      42,
      tricky,
      HEAD,
      undefined,
      spawnFn,
    );
    expect(id).toBe(55);
    expect(capturedStdin).toBeDefined();
    const body = new TextDecoder().decode(capturedStdin);
    // Byte-identical to the renderer's own output — the exact body a
    // second run's matcher will parse back.
    expect(body).toBe(renderIssueFindingComment(tricky, HEAD, undefined));
    expect(body.startsWith(PR_FINDING_MARKER_PREFIX)).toBe(true);
    expect(body).toContain(
      "shell danger: `backticks`, --flags, $(subshell), and | pipes",
    );
    // No shell interpolation surface: none of the tricky claim text ever
    // reaches argv — the body travels ONLY on stdin.
    const argvJoined = capturedArgv.join(" ");
    expect(argvJoined).not.toContain("backticks");
    expect(argvJoined).not.toContain("subshell");
  });

  test("a response with no comment id fails loud", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stdout: "{}", exitCode: 0 },
      },
    ]);
    await expect(
      postIssueComment(
        OPERATOR_ROOT,
        42,
        finding({ id: "F001" }),
        HEAD,
        undefined,
        spawnFn,
      ),
    ).rejects.toThrow(/no comment id/);
  });

  test("a gh failure fails loud", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stderr: "gh: boom", exitCode: 1 },
      },
    ]);
    await expect(
      postIssueComment(
        OPERATOR_ROOT,
        42,
        finding({ id: "F001" }),
        HEAD,
        undefined,
        spawnFn,
      ),
    ).rejects.toThrow(/post finding issue comment/);
  });
});

// ROADMAP Pillar 3 (GitHub Actions CI): postPrComment's `markerPrefix`
// parameter, exercised with NO `knownCommentId` — the fallback lookup path
// both existing production callers (cli.ts's summary-comment create/update)
// always skip by passing one. This is the first caller to reach it for
// real: a CI gate-skip comment finding-or-updating itself by its OWN marker
// (ci/gates.ts's SKIP_SIZE_COMMENT_MARKER), never the summary comment's.
describe("postPrComment — custom marker prefix (ROADMAP Pillar 3 CI skip comments)", () => {
  test("with no prior comment, creates under the given marker prefix", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["--paginate", "issues/42/comments"],
        response: { stdout: "" },
      },
      {
        match: ["--method", "POST", "issues/42/comments"],
        response: { stdout: JSON.stringify({ id: 90 }) },
      },
    ]);
    const result = await postPrComment(
      OPERATOR_ROOT,
      42,
      `${SKIP_SIZE_COMMENT_MARKER}\nsize skip`,
      spawnFn,
      undefined,
      SKIP_SIZE_COMMENT_MARKER,
    );
    expect(result).toEqual({ action: "created", commentId: 90 });
    const created = calls.find((c) =>
      argvContains(c.argv, ["--method", "POST", "issues/42/comments"]),
    );
    expect(created?.stdin).toContain(SKIP_SIZE_COMMENT_MARKER);
  });

  // The idempotency proof: a comment already marked with the SIZE-skip
  // prefix is found and PATCHed — never a fresh POST — so a second CI run
  // on the same still-oversized PR does not stack a duplicate notice.
  test("with a prior skip comment under the same prefix, updates it in place", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["--paginate", "issues/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 91,
              user: "pr-hero-bot",
              body: `${SKIP_SIZE_COMMENT_MARKER}\nold size skip`,
            },
          ]),
        },
      },
      {
        match: ["--method", "PATCH", "issues/comments/91"],
        response: { stdout: JSON.stringify({ id: 91 }) },
      },
    ]);
    const result = await postPrComment(
      OPERATOR_ROOT,
      42,
      `${SKIP_SIZE_COMMENT_MARKER}\nnew size skip`,
      spawnFn,
      undefined,
      SKIP_SIZE_COMMENT_MARKER,
    );
    expect(result).toEqual({ action: "updated", commentId: 91 });
    expect(
      calls.some((c) =>
        argvContains(c.argv, ["--method", "POST", "issues/42/comments"]),
      ),
    ).toBe(false);
  });

  // Disjointness proven at the wiring level, not just the constant level: a
  // pre-existing SUMMARY comment (the default PR_COMMENT_MARKER_PREFIX) must
  // never be mistaken for a skip comment's own marker family.
  test("a comment under the default summary marker is NOT matched by a different marker prefix", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["--paginate", "issues/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 92,
              user: "pr-hero-bot",
              body: `${PR_COMMENT_MARKER_PREFIX}head=${"a".repeat(40)} -->\nsummary`,
            },
          ]),
        },
      },
      {
        match: ["--method", "POST", "issues/42/comments"],
        response: { stdout: JSON.stringify({ id: 93 }) },
      },
    ]);
    const result = await postPrComment(
      OPERATOR_ROOT,
      42,
      `${SKIP_SIZE_COMMENT_MARKER}\nsize skip`,
      spawnFn,
      undefined,
      SKIP_SIZE_COMMENT_MARKER,
    );
    expect(result).toEqual({ action: "created", commentId: 93 });
    expect(
      calls.some((c) =>
        argvContains(c.argv, ["--method", "PATCH", "issues/comments/92"]),
      ),
    ).toBe(false);
  });

  test("with no markerPrefix given, defaults to the summary comment's own marker (unchanged behavior)", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["--paginate", "issues/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 94,
              user: "pr-hero-bot",
              body: `${PR_COMMENT_MARKER_PREFIX}head=${"a".repeat(40)} -->\nsummary`,
            },
          ]),
        },
      },
      {
        match: ["--method", "PATCH", "issues/comments/94"],
        response: { stdout: JSON.stringify({ id: 94 }) },
      },
    ]);
    const result = await postPrComment(
      OPERATOR_ROOT,
      42,
      `${PR_COMMENT_MARKER_PREFIX}head=${"a".repeat(40)} -->\nupdated summary`,
      spawnFn,
    );
    expect(result).toEqual({ action: "updated", commentId: 94 });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("postReviewCommentReply", () => {
  test("POSTs in_reply_to as a field and the body on stdin", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["--method", "POST", "pulls/42/comments"],
        response: { stdout: JSON.stringify({ id: 77 }) },
      },
    ]);
    const id = await postReviewCommentReply({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      inReplyTo: 22,
      body: "marker\n\nbadge\n\nfixed",
      spawnFn,
    });
    expect(id).toBe(77);
    const call = calls[0];
    expect(call?.argv.join(" ")).toContain("in_reply_to=22");
    expect(call?.argv.join(" ")).toContain("body=@-");
    expect(call?.stdin).toBe("marker\n\nbadge\n\nfixed");
    expect(call?.argv.join(" ")).not.toContain("fixed");
  });
});

describe("postIssueTriageComment", () => {
  test("POSTs the body on stdin to the issue-comments endpoint", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["--method", "POST", "issues/42/comments"],
        response: { stdout: JSON.stringify({ id: 88 }) },
      },
    ]);
    const id = await postIssueTriageComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      body: "triage issue reply",
      spawnFn,
    });
    expect(id).toBe(88);
    expect(calls[0]?.stdin).toBe("triage issue reply");
  });
});

describe("resolveReviewThreadForComment", () => {
  test("resolves an unresolved thread whose first comment matches the REST id", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      {
        match: ["graphql", "reviewThreads"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "PRRT_family",
                        isResolved: false,
                        comments: { nodes: [{ fullDatabaseId: 22 }] },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
      {
        match: ["graphql", "resolveReviewThread"],
        response: {
          stdout: JSON.stringify({
            data: { resolveReviewThread: { thread: { isResolved: true } } },
          }),
        },
      },
    ]);
    const outcome = await resolveReviewThreadForComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      commentId: 22,
      spawnFn,
    });
    expect(outcome).toBe("resolved");
    expect(
      calls.some((call) => call.argv.join(" ").includes("resolveReviewThread")),
    ).toBe(true);
    // Live #34: GraphQL EOF (`Expected NAME, actual: (none) ("")`) was a
    // missing `}` — fake-gh never parsed the document. Variable names
    // `repoOwner`/`repoName` stay so `gh -f name=` cannot collide with `$name`.
    const listCall = calls.find(
      (call) =>
        call.argv.includes("graphql") &&
        call.argv.some((arg) => arg.includes("reviewThreads")),
    );
    expect(listCall?.argv.some((arg) => arg.startsWith("name="))).toBe(false);
    expect(listCall?.argv).toContain("repoOwner=MusiveTech");
    expect(listCall?.argv).toContain("repoName=musive");
    const mutateCall = calls.find((call) =>
      call.argv.join(" ").includes("resolveReviewThread"),
    );
    for (const call of [listCall, mutateCall]) {
      const document = (
        call?.argv.find((arg) => arg.startsWith("query=")) ?? ""
      ).slice("query=".length);
      const opens = (document.match(/{/g) ?? []).length;
      const closes = (document.match(/}/g) ?? []).length;
      expect(opens).toBe(closes);
      expect(opens).toBeGreaterThan(0);
    }
  });

  test("skips an already-resolved thread without mutating", async () => {
    const { spawnFn, calls } = makeFakeGh([
      repoView,
      {
        match: ["graphql", "reviewThreads"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "PRRT_family",
                        isResolved: true,
                        comments: { nodes: [{ fullDatabaseId: "22" }] },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const outcome = await resolveReviewThreadForComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      commentId: 22,
      spawnFn,
    });
    expect(outcome).toBe("already-resolved");
    expect(
      calls.some((call) => call.argv.join(" ").includes("resolveReviewThread")),
    ).toBe(false);
  });

  test("returns not-found when no thread's first comment matches", async () => {
    const { spawnFn } = makeFakeGh([
      repoView,
      {
        match: ["graphql", "reviewThreads"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { nodes: [] },
                },
              },
            },
          }),
        },
      },
    ]);
    await expect(
      resolveReviewThreadForComment({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        commentId: 22,
        spawnFn,
      }),
    ).resolves.toBe("not-found");
  });
});

describe("postCommitStatus", () => {
  test("returns the created_at GitHub answered with, for the cancel settle's identity (SB3)", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["statuses", HEAD],
        response: {
          stdout: '{"id":1,"created_at":"2026-10-17T10:00:00Z"}',
          exitCode: 0,
        },
      },
    ]);
    const request = commitStatusRequest({
      phase: "pending",
      posted: false,
      targetUrl: undefined,
      context: COMMIT_STATUS_CONTEXT,
    });
    expect(await postCommitStatus(OPERATOR_ROOT, HEAD, request, spawnFn)).toBe(
      "2026-10-17T10:00:00Z",
    );
  });

  test("POSTs state, context, description and target_url as -f fields, not argv prose", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["statuses", HEAD],
        response: { stdout: "{}", exitCode: 0 },
      },
    ]);
    const request = commitStatusRequest({
      phase: "pending",
      posted: false,
      targetUrl: "https://github.com/org/repo/pull/7",
      context: COMMIT_STATUS_CONTEXT,
    });
    await postCommitStatus(OPERATOR_ROOT, HEAD, request, spawnFn);
    expect(calls).toHaveLength(1);
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain("--method");
    expect(argv).toContain("POST");
    expect(argv.join(" ")).toContain(`repos/{owner}/{repo}/statuses/${HEAD}`);
    expect(argv).toContain(`state=${request.state}`);
    expect(argv).toContain(`context=${COMMIT_STATUS_CONTEXT}`);
    expect(argv).toContain(`description=${request.description}`);
    expect(argv).toContain(`target_url=${request.targetUrl}`);
    expect(calls[0]?.stdin).toBeUndefined();
  });

  // T3 S7: the POST carries the context the request was built with, never a
  // constant. A local run's status must land on pr-hero/local, so the gate's
  // context is named only by a CI run's request.
  test("POSTs the request's own context: a local request never names pr-hero", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["statuses", HEAD],
        response: { stdout: "{}", exitCode: 0 },
      },
    ]);
    const request = commitStatusRequest({
      phase: "success",
      posted: false,
      targetUrl: undefined,
      context: LOCAL_COMMIT_STATUS_CONTEXT,
    });
    await postCommitStatus(OPERATOR_ROOT, HEAD, request, spawnFn);
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain(`context=${LOCAL_COMMIT_STATUS_CONTEXT}`);
    expect(argv).not.toContain(`context=${COMMIT_STATUS_CONTEXT}`);
  });

  test("omits target_url when the request has none", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["statuses", HEAD],
        response: { stdout: "{}", exitCode: 0 },
      },
    ]);
    await postCommitStatus(
      OPERATOR_ROOT,
      HEAD,
      commitStatusRequest({
        phase: "success",
        posted: false,
        targetUrl: undefined,
        context: COMMIT_STATUS_CONTEXT,
      }),
      spawnFn,
    );
    expect(calls[0]?.argv.join(" ") ?? "").not.toContain("target_url=");
  });

  test("a non-2xx is a CliError naming the state", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["statuses", HEAD],
        response: {
          stdout: "",
          stderr: "missing permission (HTTP 403)",
          exitCode: 1,
        },
      },
    ]);
    await expect(
      postCommitStatus(
        OPERATOR_ROOT,
        HEAD,
        commitStatusRequest({
          phase: "pending",
          posted: false,
          targetUrl: undefined,
          context: COMMIT_STATUS_CONTEXT,
        }),
        spawnFn,
      ),
    ).rejects.toThrow(/commit status pending/);
    expect(calls).toHaveLength(2);
  });

  test("an abbreviated sha never reaches gh", async () => {
    const { spawnFn, calls } = makeFakeGh([]);
    await expect(
      postCommitStatus(
        OPERATOR_ROOT,
        "abc",
        commitStatusRequest({
          phase: "pending",
          posted: false,
          targetUrl: undefined,
          context: COMMIT_STATUS_CONTEXT,
        }),
        spawnFn,
      ),
    ).rejects.toThrow(/full 40-char id/);
    expect(calls).toHaveLength(0);
  });
});

describe("postCommitStatus bounds", () => {
  // makeFakeGh records argv/cwd/stdin only, and the bound under test travels
  // as Bun.spawn's `timeout` option — so this fake watches that option.
  function makeTimeoutRecordingGh(exitCode: number): {
    spawnFn: typeof Bun.spawn;
    timeouts: (number | undefined)[];
  } {
    const timeouts: (number | undefined)[] = [];
    const encoder = new TextEncoder();
    const spawnFn = ((_argv: string[], opts?: { timeout?: number }) => {
      timeouts.push(opts?.timeout);
      const stream = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(""));
            controller.close();
          },
        });
      return {
        stdout: stream(),
        stderr: stream(),
        exited: Promise.resolve(exitCode),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    return { spawnFn, timeouts };
  }

  const request = commitStatusRequest({
    phase: "error",
    posted: false,
    targetUrl: undefined,
    context: COMMIT_STATUS_CONTEXT,
  });

  test("the default settle keeps two attempts at the 15s bound", async () => {
    const { spawnFn, timeouts } = makeTimeoutRecordingGh(1);
    await expect(
      postCommitStatus(OPERATOR_ROOT, HEAD, request, spawnFn),
    ).rejects.toThrow(/commit status error/);
    expect(timeouts).toEqual([
      COMMIT_STATUS_TIMEOUT_MS,
      COMMIT_STATUS_TIMEOUT_MS,
    ]);
  });

  test("the cancellation settle is one attempt at the short bound", async () => {
    const { spawnFn, timeouts } = makeTimeoutRecordingGh(1);
    await expect(
      postCommitStatus(OPERATOR_ROOT, HEAD, request, spawnFn, {
        attempts: 1,
        timeoutMs: CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
      }),
    ).rejects.toThrow(/commit status error/);
    expect(timeouts).toEqual([CANCELLATION_COMMIT_STATUS_TIMEOUT_MS]);
  });

  test("a successful cancellation settle still spends only one call", async () => {
    const { spawnFn, timeouts } = makeTimeoutRecordingGh(0);
    await postCommitStatus(OPERATOR_ROOT, HEAD, request, spawnFn, {
      attempts: 1,
      timeoutMs: CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
    });
    expect(timeouts).toHaveLength(1);
  });
});

// ghPrFiles moved onto the WATCH TICK path with the pre-launch exclusion
// veto (PR #205), and pr-hero's own review of that PR flagged it as
// unbounded: `gh()`'s watchdog only arms when a `timeoutMs` is passed, so an
// accepted-but-unanswered `gh pr view` parked on `proc.exited` forever and
// took the tick — and watch.lock with it — down with it. `fetchCommitStatuses`
// on the same path already states the rule ("a 403, a hung gh (timeout), or
// garbage jq must not take the watch tick down"). Pinned with an injected
// spawn fake, the convention "postCommitStatus bounds" above already uses,
// because the bound travels as Bun.spawn's `timeout` option.
describe("ghPrFiles bounds", () => {
  function makeTimeoutRecordingGh(stdout: string): {
    spawnFn: typeof Bun.spawn;
    timeouts: (number | undefined)[];
  } {
    const timeouts: (number | undefined)[] = [];
    const encoder = new TextEncoder();
    const spawnFn = ((_argv: string[], opts?: { timeout?: number }) => {
      timeouts.push(opts?.timeout);
      const stream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
      return {
        stdout: stream(stdout),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    return { spawnFn, timeouts };
  }

  test("the per-file fetch is bounded at the same 15s `gh pr view` bound the GC uses", async () => {
    const { spawnFn, timeouts } = makeTimeoutRecordingGh('{"files":[]}');

    const out = await ghPrFiles(OPERATOR_ROOT, 42, { spawnFn });

    expect(out).toBe('{"files":[]}');
    expect(timeouts).toEqual([GH_PR_VIEW_TIMEOUT_MS]);
    // Not merely "some number": an unbounded call records `undefined`, which
    // is exactly the defect this pins.
    expect(timeouts[0]).not.toBeUndefined();
  });
});

// gh's own paging, as far as these tests need it: without --paginate the call answers the first page
// only; with it, every page, in order, on one stdout (the --jq projection runs per page).
function pagedFakeGh(pages: unknown[][]): {
  spawnFn: typeof Bun.spawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const encoder = new TextEncoder();
  const spawnFn = ((argv: string[]) => {
    calls.push(argv);
    const rows = argv.includes("--paginate") ? pages.flat() : (pages[0] ?? []);
    const text = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
    const stream = (value: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (value) controller.enqueue(encoder.encode(value));
          controller.close();
        },
      });
    return {
      stdout: stream(text),
      stderr: stream(""),
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

describe("fetchCommitStatusList: every page of the head's status list", () => {
  const T_OLD = "2026-10-16T10:00:00Z";
  const T_NEW = "2026-10-17T10:00:00Z";
  const VERDICT = {
    state: "failure",
    context: COMMIT_STATUS_CONTEXT,
    created_at: T_OLD,
    description:
      "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
  };

  test("a verdict on page 2, behind 100 newer rows on page 1, is found", async () => {
    const newer = Array.from({ length: 100 }, (_, i) => ({
      state: "success",
      context: "ci",
      created_at: T_NEW,
      description: `build ${i}`,
    }));
    const { spawnFn, calls } = pagedFakeGh([newer, [VERDICT]]);
    const statuses = await fetchCommitStatusList(OPERATOR_ROOT, HEAD, {
      spawnFn,
    });
    expect(calls[0]?.includes("--paginate")).toBe(true);
    expect(statuses?.length).toBe(101);
    expect(statuses?.find((s) => s.context === COMMIT_STATUS_CONTEXT)).toEqual(
      VERDICT,
    );
  });

  test("the list call keeps the --paginate read on the statuses endpoint, bounded by its timeout", async () => {
    const { spawnFn, calls } = pagedFakeGh([[VERDICT]]);
    await fetchCommitStatusList(OPERATOR_ROOT, HEAD, { spawnFn });
    const argv = calls[0] ?? [];
    expect(argv.join(" ")).toContain(
      `repos/{owner}/{repo}/commits/${HEAD}/statuses?per_page=100`,
    );
    expect(argv.indexOf("--paginate")).toBeLessThan(argv.indexOf("--jq"));
  });

  test("a failed page read fails closed (null), never a partial list", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: [`commits/${HEAD}/statuses`],
        response: { stdout: "", stderr: "gh: HTTP 502", exitCode: 1 },
      },
    ]);
    expect(
      await fetchCommitStatusList(OPERATOR_ROOT, HEAD, { spawnFn }),
    ).toBeNull();
  });
});

describe("fetchPrCommitShas: the PR's commits, oldest first", () => {
  const SHA_1 = "1".repeat(40);
  const SHA_2 = "2".repeat(40);
  const SHA_3 = "3".repeat(40);

  test("lists every page of pulls/<n>/commits, in GitHub's oldest-first order", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/7/commits"],
        response: { stdout: `${SHA_1}\n${SHA_2}\n${SHA_3}\n` },
      },
    ]);
    const shas = await fetchPrCommitShas(OPERATOR_ROOT, 7, { spawnFn });
    expect(shas).toEqual([SHA_1, SHA_2, SHA_3]);
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain("--paginate");
    expect(argv.join(" ")).toContain(
      "repos/{owner}/{repo}/pulls/7/commits?per_page=100",
    );
  });

  test("a failed call fails closed (null)", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/7/commits"],
        response: { stdout: "", stderr: "gh: Not Found", exitCode: 1 },
      },
    ]);
    expect(await fetchPrCommitShas(OPERATOR_ROOT, 7, { spawnFn })).toBeNull();
  });

  test("a malformed row fails closed (null), never a partial walk", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/7/commits"],
        response: { stdout: `${SHA_1}\nnot-a-sha\n` },
      },
    ]);
    expect(await fetchPrCommitShas(OPERATOR_ROOT, 7, { spawnFn })).toBeNull();
  });
});

describe("fetchCommitStatuses", () => {
  test("reads the combined status endpoint, latest per context, no pagination", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: [`commits/${HEAD}/status`],
        response: {
          stdout: ndjson([
            {
              state: "pending",
              context: COMMIT_STATUS_CONTEXT,
              created_at: "2026-08-18T16:30:00Z",
            },
            {
              state: "success",
              context: "ci",
              created_at: "2026-08-18T16:00:00Z",
            },
          ]),
        },
      },
    ]);
    const statuses = await fetchCommitStatuses(OPERATOR_ROOT, HEAD, {
      spawnFn,
    });
    const argv = calls[0]?.argv ?? [];
    expect(argv.join(" ")).toContain(`commits/${HEAD}/status`);
    expect(argv).not.toContain("--paginate");
    expect(statuses).toEqual([
      {
        state: "pending",
        context: COMMIT_STATUS_CONTEXT,
        created_at: "2026-08-18T16:30:00Z",
      },
      {
        state: "success",
        context: "ci",
        created_at: "2026-08-18T16:00:00Z",
      },
    ]);
  });

  // The publisher's reader asks for 100 contexts per page (src/ci/publish.ts, readHeadStatuses),
  // and this reader must see the same rows. At GitHub's default of 30 a busy head's pr-hero
  // row can be missing, and the CLI would then write its verdict over an override the
  // publisher sees. The path is asserted whole, because the fakes below match by substring.
  test("asks for 100 contexts per page, the same page size as the publisher's reader", async () => {
    const { spawnFn, calls } = makeFakeGh([
      { match: [`commits/${HEAD}/status`], response: { stdout: "" } },
    ]);
    await fetchCommitStatuses(OPERATOR_ROOT, HEAD, { spawnFn });
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain(
      `repos/{owner}/{repo}/commits/${HEAD}/status?per_page=100`,
    );
  });

  // The override check (src/pr/teardown.ts) tells an override from a review's own
  // status by its description, so the request must ask for it. The jq is asserted
  // because a fake that echoed the field would pass against a filter that drops it.
  test("the request asks for each status's description, and a row carries it, null when GitHub sends none", async () => {
    const override =
      "pr-hero: overridden by @maintainer — no review on this head";
    const { spawnFn, calls } = makeFakeGh([
      {
        match: [`commits/${HEAD}/status`],
        response: {
          stdout: ndjson([
            {
              state: "success",
              context: COMMIT_STATUS_CONTEXT,
              created_at: "2026-08-18T16:30:00Z",
              description: override,
            },
            {
              state: "pending",
              context: "ci",
              created_at: "2026-08-18T16:00:00Z",
              description: null,
            },
          ]),
        },
      },
    ]);
    const statuses = await fetchCommitStatuses(OPERATOR_ROOT, HEAD, {
      spawnFn,
    });
    const argv = calls[0]?.argv ?? [];
    const jq = argv[argv.indexOf("--jq") + 1] ?? "";
    expect(jq).toContain(".statuses[]?");
    expect(jq).toContain("description: .description");
    expect(statuses[0]?.description).toBe(override);
    expect(statuses[1]?.description).toBeNull();
  });

  test("a failed fetch is empty, not a throw", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: [`commits/${HEAD}/status`],
        response: {
          stdout: "",
          stderr: "Resource not accessible (HTTP 403)",
          exitCode: 1,
        },
      },
    ]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, HEAD, { spawnFn }),
    ).resolves.toEqual([]);
  });

  test("a garbage line is dropped, a well-formed neighbour is kept", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: [`commits/${HEAD}/status`],
        response: {
          stdout:
            "not-json\n" +
            ndjson([
              {
                state: "pending",
                context: COMMIT_STATUS_CONTEXT,
                created_at: "2026-08-18T16:30:00Z",
              },
            ]),
        },
      },
    ]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, HEAD, { spawnFn }),
    ).resolves.toEqual([
      {
        state: "pending",
        context: COMMIT_STATUS_CONTEXT,
        created_at: "2026-08-18T16:30:00Z",
      },
    ]);
  });

  test("an abbreviated sha is empty, not a throw", async () => {
    const { spawnFn, calls } = makeFakeGh([]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, "abc", { spawnFn }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // `pr-hero status` reads the gate's target_url for its own output. The jq is pinned
  // because a fake that echoed the field would pass against a filter that drops it.
  test("the request asks for each status's target_url, and a row carries it", async () => {
    const url = "https://github.com/MusiveTech/musive/actions/runs/9";
    const { spawnFn, calls } = makeFakeGh([
      {
        match: [`commits/${HEAD}/status`],
        response: {
          stdout: ndjson([
            {
              state: "success",
              context: COMMIT_STATUS_CONTEXT,
              created_at: "2026-08-18T16:30:00Z",
              target_url: url,
            },
          ]),
        },
      },
    ]);
    const statuses = await fetchCommitStatuses(OPERATOR_ROOT, HEAD, {
      spawnFn,
    });
    const argv = calls[0]?.argv ?? [];
    const jq = argv[argv.indexOf("--jq") + 1] ?? "";
    expect(jq).toContain("target_url: .target_url");
    expect(statuses[0]?.target_url).toBe(url);
  });

  // The default keeps the swallowing contract every watch and admission caller depends on.
  // `failClosed` is the status command's reading: an unreadable gate is an error, never
  // an empty list that reads as "no pr-hero status", which would send a review out blind.
  test("failClosed: a failed read throws a CliError, the default still returns empty", async () => {
    const failing = () =>
      makeFakeGh([
        {
          match: [`commits/${HEAD}/status`],
          response: {
            stdout: "",
            stderr: "Resource not accessible (HTTP 403)",
            exitCode: 1,
          },
        },
      ]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, HEAD, {
        spawnFn: failing().spawnFn,
      }),
    ).resolves.toEqual([]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, HEAD, {
        spawnFn: failing().spawnFn,
        failClosed: true,
      }),
    ).rejects.toBeInstanceOf(CliError);
  });

  test("failClosed: an unparseable line throws, where the default drops it", async () => {
    const garbage = () =>
      makeFakeGh([
        {
          match: [`commits/${HEAD}/status`],
          response: {
            stdout:
              "not-json\n" +
              ndjson([
                {
                  state: "pending",
                  context: COMMIT_STATUS_CONTEXT,
                  created_at: "2026-08-18T16:30:00Z",
                },
              ]),
          },
        },
      ]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, HEAD, {
        spawnFn: garbage().spawnFn,
        failClosed: true,
      }),
    ).rejects.toBeInstanceOf(CliError);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, HEAD, { spawnFn: garbage().spawnFn }),
    ).resolves.toHaveLength(1);
  });

  test("a line that is valid JSON but not a status is skipped by default, and the rest are kept", async () => {
    const pending = {
      state: "pending",
      context: COMMIT_STATUS_CONTEXT,
      created_at: "2026-08-18T16:30:00Z",
    };
    const { spawnFn } = makeFakeGh([
      {
        match: [`commits/${HEAD}/status`],
        response: {
          stdout: `null\n${ndjson([pending])}\nnot-json`,
        },
      },
    ]);
    const statuses = await fetchCommitStatuses(OPERATOR_ROOT, HEAD, {
      spawnFn,
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.state).toBe("pending");
  });

  test("failClosed: a line that is valid JSON but not a status throws", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: [`commits/${HEAD}/status`],
        response: {
          stdout: "null",
        },
      },
    ]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, HEAD, { spawnFn, failClosed: true }),
    ).rejects.toBeInstanceOf(CliError);
  });

  // failClosed: "read" is the override check's reading: a failed gh read throws, but a malformed
  // row is skipped, so one garbage line cannot hide a valid override on the same head.
  test('failClosed "read": a failed gh read still throws a CliError', async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: [`commits/${HEAD}/status`],
        response: { stdout: "", stderr: "gh: HTTP 500", exitCode: 1 },
      },
    ]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, HEAD, { spawnFn, failClosed: "read" }),
    ).rejects.toBeInstanceOf(CliError);
  });

  test('failClosed "read": an unparseable or non-status line is skipped, and the valid rows are kept', async () => {
    const valid = {
      state: "success",
      context: COMMIT_STATUS_CONTEXT,
      created_at: "2026-08-18T16:30:00Z",
      description: "pr-hero: overridden by @maintainer",
    };
    const { spawnFn } = makeFakeGh([
      {
        match: [`commits/${HEAD}/status`],
        response: { stdout: `not-json\nnull\n${ndjson([valid])}` },
      },
    ]);
    const statuses = await fetchCommitStatuses(OPERATOR_ROOT, HEAD, {
      spawnFn,
      failClosed: "read",
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.description).toBe(valid.description);
  });

  test('failClosed "read": an abbreviated sha throws, where the default is empty', async () => {
    const { spawnFn, calls } = makeFakeGh([]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, "abc", {
        spawnFn,
        failClosed: "read",
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(calls).toHaveLength(0);
  });

  test("failClosed: an abbreviated sha throws, where the default is empty", async () => {
    const { spawnFn, calls } = makeFakeGh([]);
    await expect(
      fetchCommitStatuses(OPERATOR_ROOT, "abc", { spawnFn, failClosed: true }),
    ).rejects.toBeInstanceOf(CliError);
    expect(calls).toHaveLength(0);
  });
});

function admissionRecordFixture(
  overrides: Partial<AdmissionRecord> = {},
): AdmissionRecord {
  return {
    schemaVersion: 1,
    prNumber: 42,
    headSha: HEAD,
    policyHash: "policyhash123456",
    reservationId: "reservation123456",
    attemptNumber: 1,
    status: "reserved",
    decisionReason: "",
    priorScore: null,
    blockingCount: null,
    advisoryCount: null,
    workflowRunId: null,
    createdAt: "2026-08-28T12:00:00.000Z",
    settledAt: null,
    ...overrides,
  };
}

describe("listAdmissionCheckRuns", () => {
  test("parses admission records from check-run output text", async () => {
    const record = admissionRecordFixture({
      status: "completed",
      decisionReason: "review complete",
    });
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["check-runs"],
        response: {
          stdout: ndjson([
            {
              id: 99,
              name: ADMISSION_CHECK_RUN_NAME,
              status: "completed",
              output: { text: serializeAdmissionRecord(record) },
            },
            {
              id: 100,
              name: "other/check",
              status: "completed",
              output: { text: "{}" },
            },
          ]),
        },
      },
    ]);
    const records = await listAdmissionCheckRuns(OPERATOR_ROOT, HEAD, {
      spawnFn,
    });
    expect(records).toEqual([record]);
    expect(calls[0]?.argv.join(" ")).toContain(`commits/${HEAD}/check-runs`);
    expect(calls[0]?.argv).toContain("--paginate");
  });

  test("fail-open returns an empty list on gh errors", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["check-runs"],
        response: { stderr: "forbidden (HTTP 403)", exitCode: 1 },
      },
    ]);
    await expect(
      listAdmissionCheckRuns(OPERATOR_ROOT, HEAD, { spawnFn }),
    ).resolves.toEqual([]);
  });
});

describe("upsertAdmissionCheckRun", () => {
  test("POSTs a new check run with serialized record in output.text", async () => {
    const record = admissionRecordFixture();
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["check-runs"],
        response: { stdout: JSON.stringify({ id: 501 }) },
      },
    ]);
    const id = await upsertAdmissionCheckRun(
      OPERATOR_ROOT,
      { headSha: HEAD, record },
      { spawnFn },
    );
    expect(id).toBe(501);
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain("--method");
    expect(argv).toContain("POST");
    expect(argv.join(" ")).toContain("repos/{owner}/{repo}/check-runs");
    expect(argv.join(" ")).toContain(`external_id=${record.reservationId}`);
    expect(argv.join(" ")).toContain(
      `output[text]=${serializeAdmissionRecord(record)}`,
    );
    expect(argv.join(" ")).toContain(`name=${ADMISSION_CHECK_RUN_NAME}`);
  });

  test("PATCHes when checkRunId is provided", async () => {
    const record = admissionRecordFixture({
      status: "completed",
      decisionReason: "review complete",
    });
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["check-runs/77"],
        response: { stdout: JSON.stringify({ id: 77 }) },
      },
    ]);
    const id = await upsertAdmissionCheckRun(
      OPERATOR_ROOT,
      { headSha: HEAD, record, checkRunId: 77 },
      { spawnFn },
    );
    expect(id).toBe(77);
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain("PATCH");
    expect(argv.join(" ")).toContain("check-runs/77");
    expect(argv.join(" ")).toContain("conclusion=success");
  });

  // musive #1935: a run that stood down for a review already in flight was
  // settled `failed` and showed a red check. A yield is not a failure.
  test("a yielded record completes the check run as skipped, never failure", async () => {
    const record = admissionRecordFixture({
      status: "yielded",
      decisionReason: "another pr-hero review is already in flight",
    });
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["check-runs/77"],
        response: { stdout: JSON.stringify({ id: 77 }) },
      },
    ]);
    await upsertAdmissionCheckRun(
      OPERATOR_ROOT,
      { headSha: HEAD, record, checkRunId: 77 },
      { spawnFn },
    );
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain("status=completed");
    expect(argv).toContain("conclusion=skipped");
  });
});

// F004 (PR #330): an accepted-but-unanswered gh call on the findings POST
// parked publishRunOutcome forever, and the pending commit status with it.
// Every call on that path now carries a bound. A bound that fires fails like
// any non-zero gh exit, with no retry: a timed-out POST may already have
// landed, and a retry would duplicate the review. The hang fakes close their
// streams on kill(), the same shape repostMarkedPrComment's tests use, because
// gh() reads both streams before it reports.
describe("the findings POST bounds every gh call (F004)", () => {
  function hangOn(
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
      const close = () => {
        if (safety !== undefined) clearTimeout(safety);
        for (const controller of held) {
          try {
            controller.close();
          } catch {
            // already closed by the safety net
          }
        }
        resolveExit(143);
      };
      // Safety net only: the bound under test (50 ms) must fire first. Without
      // this fallback a call that never gets a bound spins the runner forever
      // instead of failing its one test.
      safety = setTimeout(close, 2000);
      return { stdout: open(), stderr: open(), exited, kill: close };
    }) as unknown as typeof Bun.spawn;
  }

  // Wraps any fake and records the bound each call carries. The bound travels
  // as Bun.spawn's `timeout` option, the same lever gh() sets, so a dropped
  // argument shows up here as `undefined`.
  function recordTimeouts(base: typeof Bun.spawn): {
    spawnFn: typeof Bun.spawn;
    timeouts: { argv: string[]; timeout: number | undefined }[];
  } {
    const timeouts: { argv: string[]; timeout: number | undefined }[] = [];
    const spawnFn = ((argv: string[], opts?: { timeout?: number }) => {
      timeouts.push({ argv, timeout: opts?.timeout });
      return (base as unknown as (a: string[], o?: unknown) => unknown)(
        argv,
        opts,
      );
    }) as unknown as typeof Bun.spawn;
    return { spawnFn, timeouts };
  }

  const oneFinding = finding({ id: "F001", path: "src/a.ts", line: 10 });
  const reviewInput = (spawnFn: typeof Bun.spawn) => ({
    operatorRoot: OPERATOR_ROOT,
    pr: 42,
    headSha: HEAD,
    findings: [oneFinding],
    allFindings: [toRef(oneFinding)],
    spawnFn,
  });

  test("a summary create that never answers rejects within its bound", async () => {
    const base = makeFakeGh([]);
    await expect(
      postPrComment(
        OPERATOR_ROOT,
        42,
        "body",
        hangOn(base.spawnFn, (argv) => argv.includes("POST")),
        undefined,
        undefined,
        50,
      ),
    ).rejects.toThrow(/timed out after 50 ms/);
  });

  test("a summary PATCH that never answers rejects within its bound", async () => {
    const base = makeFakeGh([]);
    await expect(
      postPrComment(
        OPERATOR_ROOT,
        42,
        "body",
        hangOn(base.spawnFn, (argv) => argv.includes("PATCH")),
        77,
        undefined,
        50,
      ),
    ).rejects.toThrow(/timed out after 50 ms/);
  });

  test("a review POST that never answers rejects within its bound, and is not retried", async () => {
    const base = makeFakeGh([]);
    // Match on the joined argv: the endpoint is one element of the array.
    const isReview = (argv: string[]) =>
      argv.join(" ").includes("pulls/42/reviews");
    const rec = recordTimeouts(hangOn(base.spawnFn, isReview));
    await expect(
      postPrReview({ ...reviewInput(rec.spawnFn), timeoutMs: 50 }),
    ).rejects.toThrow(/timed out after 50 ms/);
    const reviewPosts = rec.timeouts.filter((t) => isReview(t.argv));
    expect(reviewPosts).toHaveLength(1);
    // No 422 recovery either: a timeout is not a 422, and its re-reads would
    // be the wrong answer to a submission that may already have landed.
    expect(rec.timeouts.some((t) => t.argv.includes("--paginate"))).toBe(false);
  });

  test("with no timeout passed, every findings-POST primitive sends the posting bound", async () => {
    const base = makeFakeGh([
      { match: ["headRefOid"], response: { stdout: `${HEAD}\n` } },
      {
        match: ["repo", "view", "--json", "url"],
        response: { stdout: "https://github.com/musive/pr-hero\n" },
      },
      // postPrComment's PATCH must answer with the comment id it reads back.
      {
        match: ["PATCH", "issues/comments/77"],
        response: { stdout: JSON.stringify({ id: 77 }) },
      },
    ]);
    const rec = recordTimeouts(base.spawnFn);
    await postPrComment(OPERATOR_ROOT, 42, "body", rec.spawnFn, 77);
    await postPrReview(reviewInput(rec.spawnFn));
    await ghPrHeadSha(OPERATOR_ROOT, 42, { spawnFn: rec.spawnFn });
    await ghRepoWebUrl(OPERATOR_ROOT, { spawnFn: rec.spawnFn });
    expect(rec.timeouts.map((t) => t.timeout)).toEqual([
      POSTING_GH_TIMEOUT_MS,
      POSTING_GH_TIMEOUT_MS,
      POSTING_GH_TIMEOUT_MS,
      POSTING_GH_TIMEOUT_MS,
    ]);
  });

  test("a comment read's GraphQL fallback carries the caller's bound on every call", async () => {
    const base = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
      {
        match: ["graphql", "databaseId"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const rec = recordTimeouts(base.spawnFn);
    await fetchPrComments(OPERATOR_ROOT, 42, {
      spawnFn: rec.spawnFn,
      timeoutMs: 50,
    });
    expect(rec.timeouts.some((t) => t.argv.includes("graphql"))).toBe(true);
    expect(rec.timeouts.map((t) => t.timeout)).toEqual(
      rec.timeouts.map(() => 50),
    );
  });

  test("a review read's GraphQL fallback carries the caller's bound on every call", async () => {
    const base = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stderr: "gh: Not Found (HTTP 404)", exitCode: 1 },
      },
      repoView,
      {
        match: ["graphql", "reviewThreads"],
        response: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const rec = recordTimeouts(base.spawnFn);
    await fetchPrReviewComments(OPERATOR_ROOT, 42, {
      spawnFn: rec.spawnFn,
      timeoutMs: 50,
    });
    expect(rec.timeouts.some((t) => t.argv.includes("graphql"))).toBe(true);
    expect(rec.timeouts.map((t) => t.timeout)).toEqual(
      rec.timeouts.map(() => 50),
    );
  });
});

// A CI skip notice used to be edited in place on every push (postPrComment's
// find-and-update). GitHub neither notifies on an edit nor moves the comment
// down the timeline, so a later skip was invisible (#315: created 01:48,
// silently edited 02:48). repostMarkedPrComment posts the fresh notice at the
// bottom FIRST, then deletes the older ones under the same marker.
describe("repostMarkedPrComment — a CI skip notice stays visible", () => {
  const BOT = "github-actions[bot]";
  const posted = (id: number) => ({
    match: ["--method", "POST", "issues/42/comments"],
    response: { stdout: JSON.stringify({ id, user: { login: BOT } }) },
  });
  const listing = (rows: { id: number; user: string; body: string }[]) => ({
    match: ["--paginate", "issues/42/comments"],
    response: { stdout: ndjson(rows) },
  });
  const notice = (id: number, user = BOT) => ({
    id,
    user,
    body: `${SKIP_SIZE_COMMENT_MARKER}\nnotice ${id}`,
  });

  // Overrides the fake for the calls `when` selects: `hang` never settles
  // until killed (gh()'s watchdog is the only way out), `throw` makes the
  // spawn itself reject, the shape a gh() failure takes before any exit code.
  function override(
    spawnFn: typeof Bun.spawn,
    when: (argv: string[]) => boolean,
    mode: "hang" | "throw",
  ): typeof Bun.spawn {
    return ((argv: string[], opts?: unknown) => {
      if (!when(argv)) {
        return (spawnFn as unknown as (a: string[], o?: unknown) => unknown)(
          argv,
          opts,
        );
      }
      if (mode === "throw") throw new Error("spawn exploded");
      // A real process's pipes close when it is killed, and gh() reads both
      // streams before it reports, so the fake closes them in kill() too.
      let resolveExit: (code: number) => void = () => {};
      const held: ReadableStreamDefaultController<Uint8Array>[] = [];
      const open = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            held.push(controller);
          },
        });
      return {
        stdout: open(),
        stderr: open(),
        exited: new Promise<number>((r) => {
          resolveExit = r;
        }),
        kill() {
          for (const controller of held) controller.close();
          resolveExit(143);
        },
      };
    }) as unknown as typeof Bun.spawn;
  }

  const isDelete = (argv: string[]) => argv.includes("DELETE");

  test("posts the new notice, then deletes every older own notice under the same marker", async () => {
    const { spawnFn, calls } = makeFakeGh([
      posted(95),
      listing([
        notice(91),
        {
          id: 92,
          user: BOT,
          body: `${PR_COMMENT_MARKER_PREFIX}head=${"a".repeat(40)} -->\nsummary`,
        },
        notice(94),
        notice(95),
      ]),
      { match: ["--method", "DELETE"], response: { stdout: "" } },
    ]);
    const result = await repostMarkedPrComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
      markerPrefix: SKIP_SIZE_COMMENT_MARKER,
      spawnFn,
    });
    expect(result).toEqual({ commentId: 95, deletedIds: [91, 94] });
    const postIndex = calls.findIndex((c) =>
      argvContains(c.argv, ["--method", "POST", "issues/42/comments"]),
    );
    expect(calls[postIndex]?.stdin).toBe(`${SKIP_SIZE_COMMENT_MARKER}\nnew`);
    // The listing is read AFTER the POST, so a notice a concurrent run
    // created in between is still seen and cleaned up.
    const listIndex = calls.findIndex((c) =>
      argvContains(c.argv, ["--paginate", "issues/42/comments"]),
    );
    expect(listIndex).toBeGreaterThan(postIndex);
    const deletes = calls.filter((c) => isDelete(c.argv));
    expect(deletes.map((c) => c.argv.join(" "))).toEqual([
      expect.stringContaining("issues/comments/91"),
      expect.stringContaining("issues/comments/94"),
    ]);
    expect(calls.some((c) => c.argv.includes("PATCH"))).toBe(false);
    expect(
      calls.some((c) => c.argv.join(" ").includes("issues/comments/92")),
    ).toBe(false);
  });

  test("a marked comment written by someone else is never deleted", async () => {
    const { spawnFn, calls } = makeFakeGh([
      posted(95),
      listing([notice(90, "a-collaborator"), notice(91)]),
      { match: ["--method", "DELETE"], response: { stdout: "" } },
    ]);
    const result = await repostMarkedPrComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
      markerPrefix: SKIP_SIZE_COMMENT_MARKER,
      spawnFn,
    });
    expect(result.deletedIds).toEqual([91]);
    expect(
      calls.some((c) => c.argv.join(" ").includes("issues/comments/90")),
    ).toBe(false);
  });

  test("when the new notice's author is unknown, nothing is deleted", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["--method", "POST", "issues/42/comments"],
        response: { stdout: JSON.stringify({ id: 95 }) },
      },
      listing([notice(91)]),
    ]);
    const result = await repostMarkedPrComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
      markerPrefix: SKIP_SIZE_COMMENT_MARKER,
      spawnFn,
    });
    expect(result).toEqual({ commentId: 95, deletedIds: [] });
    expect(calls.some((c) => isDelete(c.argv))).toBe(false);
  });

  test("with no prior notice, posts and deletes nothing", async () => {
    const { spawnFn, calls } = makeFakeGh([posted(96), listing([notice(96)])]);
    const result = await repostMarkedPrComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
      markerPrefix: SKIP_SIZE_COMMENT_MARKER,
      spawnFn,
    });
    expect(result).toEqual({ commentId: 96, deletedIds: [] });
    expect(calls.some((c) => isDelete(c.argv))).toBe(false);
  });

  test("a failed delete is logged and skipped — the fresh notice already landed", async () => {
    const { spawnFn } = makeFakeGh([
      posted(97),
      listing([notice(91)]),
      {
        match: ["--method", "DELETE"],
        response: { stderr: "HTTP 403", exitCode: 1 },
      },
    ]);
    const result = await repostMarkedPrComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
      markerPrefix: SKIP_SIZE_COMMENT_MARKER,
      spawnFn,
    });
    expect(result).toEqual({ commentId: 97, deletedIds: [] });
  });

  test("a delete whose gh call rejects is caught and the next one still runs", async () => {
    const base = makeFakeGh([
      posted(97),
      listing([notice(91), notice(92)]),
      { match: ["--method", "DELETE"], response: { stdout: "" } },
    ]);
    const result = await repostMarkedPrComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
      markerPrefix: SKIP_SIZE_COMMENT_MARKER,
      spawnFn: override(
        base.spawnFn,
        (argv) => isDelete(argv) && argv.join(" ").includes("comments/91"),
        "throw",
      ),
    });
    expect(result).toEqual({ commentId: 97, deletedIds: [92] });
  });

  test("a delete that never answers is bounded and the run still returns", async () => {
    const base = makeFakeGh([posted(97), listing([notice(91)])]);
    const result = await repostMarkedPrComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
      markerPrefix: SKIP_SIZE_COMMENT_MARKER,
      spawnFn: override(base.spawnFn, isDelete, "hang"),
      timeoutMs: 50,
    });
    expect(result).toEqual({ commentId: 97, deletedIds: [] });
  });

  test("a POST that never answers is bounded, throws, and deletes nothing", async () => {
    const base = makeFakeGh([listing([notice(91)])]);
    await expect(
      repostMarkedPrComment({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
        markerPrefix: SKIP_SIZE_COMMENT_MARKER,
        spawnFn: override(
          base.spawnFn,
          (argv) => argv.includes("POST"),
          "hang",
        ),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/post PR comment/);
    expect(base.calls.some((c) => isDelete(c.argv))).toBe(false);
  });

  test("a listing that never answers is bounded; the notice stays posted", async () => {
    const base = makeFakeGh([posted(97)]);
    const result = await repostMarkedPrComment({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
      markerPrefix: SKIP_SIZE_COMMENT_MARKER,
      spawnFn: override(
        base.spawnFn,
        (argv) => argv.includes("--paginate"),
        "hang",
      ),
      timeoutMs: 50,
    });
    expect(result).toEqual({ commentId: 97, deletedIds: [] });
  });

  test("a failed POST throws and deletes nothing — the old notice survives", async () => {
    const { spawnFn, calls } = makeFakeGh([
      listing([notice(91)]),
      {
        match: ["--method", "POST", "issues/42/comments"],
        response: { stderr: "HTTP 502", exitCode: 1 },
      },
    ]);
    await expect(
      repostMarkedPrComment({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        body: `${SKIP_SIZE_COMMENT_MARKER}\nnew`,
        markerPrefix: SKIP_SIZE_COMMENT_MARKER,
        spawnFn,
      }),
    ).rejects.toThrow(/post PR comment/);
    expect(calls.some((c) => isDelete(c.argv))).toBe(false);
  });
});
