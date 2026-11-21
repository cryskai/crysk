// S1/S3 (odd/tasks/marker-trust.md): every reader of the review's own summary reads it only from a
// trusted author. Each case plants a summary-shaped comment from an outsider AFTER the real one: the
// newest marker by any author would be the outsider's, so the real one winning is the discriminating
// outcome.

import { describe, expect, test } from "bun:test";
import { postPrComment, resolveInlinePostPlan } from "#pr/pr";
import {
  findTrustedMarkedCommentId,
  PR_COMMENT_MARKER_PREFIX,
} from "#pr/preflight";
import type { FindingsDocument } from "#review/findings";
import { markerCommentSeen, markerDeclaredHeads } from "#watch/preflight";
import { markerTrust } from "../../src/trust/marker-trust";

const REAL_HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const FORGED_HEAD = "f".repeat(40);
const HEAD = "c".repeat(40);

const summary = (head: string) =>
  `${PR_COMMENT_MARKER_PREFIX}head=${head} -->\n## Crysk review`;
const closing = (head: string) =>
  `<!-- crysk-rereview-closed head=${head} -->\n### re-review complete`;

// Trust as a run resolves it: a configured login and the local poster's own login.
const TRUST = markerTrust(["configured-actor", "local-dev"]);

function ndjson(rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

// A gh that answers each read by the first entry whose tokens all appear in argv, and records
// every call. An unscripted write answers with a fresh id.
function fakeGh(script: { match: string[]; stdout: string }[]) {
  const calls: string[][] = [];
  let nextId = 500;
  const spawnFn = ((argv: string[]) => {
    calls.push(argv);
    const entry = script.find((s) => s.match.every((t) => argv.includes(t)));
    const stdout =
      entry?.stdout ??
      (argv.includes("--method") ? JSON.stringify({ id: nextId++ }) : "");
    return {
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

function issueComments(rows: { id: number; user: string; body: string }[]) {
  return [
    {
      match: ["--paginate", "repos/{owner}/{repo}/issues/42/comments"],
      stdout: ndjson(rows),
    },
    {
      match: ["--paginate", "repos/{owner}/{repo}/pulls/42/comments"],
      stdout: "",
    },
  ];
}

describe("findTrustedMarkedCommentId", () => {
  test("a forged summary posted after the real one loses", () => {
    expect(
      findTrustedMarkedCommentId(
        [
          { id: 1, user: "github-actions[bot]", body: summary(REAL_HEAD) },
          { id: 2, user: "mallory", body: summary(FORGED_HEAD) },
        ],
        TRUST,
      ),
    ).toBe(1);
  });

  test("an outsider's summary alone is no summary", () => {
    expect(
      findTrustedMarkedCommentId(
        [{ id: 2, user: "mallory", body: summary(FORGED_HEAD) }],
        TRUST,
      ),
    ).toBeNull();
  });

  test.each([
    ["the Actions bot", "github-actions[bot]"],
    ["an App bot", "crysk-ai[bot]"],
    ["a configured login", "configured-actor"],
    ["the local poster", "local-dev"],
  ])("a summary by %s is still found", (_kind, user) => {
    expect(
      findTrustedMarkedCommentId(
        [
          { id: 1, user, body: summary(REAL_HEAD) },
          { id: 2, user: "mallory", body: summary(FORGED_HEAD) },
        ],
        TRUST,
      ),
    ).toBe(1);
  });

  test("a history that moved from the Actions bot to the App still finds its newest summary", () => {
    expect(
      findTrustedMarkedCommentId(
        [
          { id: 1, user: "github-actions[bot]", body: summary(OTHER_HEAD) },
          { id: 3, user: "crysk-ai[bot]", body: summary(REAL_HEAD) },
          { id: 4, user: "mallory", body: summary(FORGED_HEAD) },
        ],
        TRUST,
      ),
    ).toBe(3);
  });
});

describe("the post plan reads the real summary and closing comment", () => {
  const doc = { findings: [] } as unknown as FindingsDocument;

  test("a forged summary and closing comment after the real ones are ignored", async () => {
    const { spawnFn } = fakeGh(
      issueComments([
        { id: 1, user: "github-actions[bot]", body: summary(REAL_HEAD) },
        { id: 2, user: "github-actions[bot]", body: closing(REAL_HEAD) },
        { id: 3, user: "mallory", body: summary(FORGED_HEAD) },
        { id: 4, user: "mallory", body: closing(FORGED_HEAD) },
      ]),
    );
    const plan = await resolveInlinePostPlan({
      operatorRoot: "/repo",
      pr: 42,
      headSha: HEAD,
      doc,
      diffPatch: "",
      trust: TRUST,
      spawnFn,
    });
    expect(plan.existingSummaryId).toBe(1);
    expect(plan.previousHeadSha).toBe(REAL_HEAD);
    expect(plan.priorClosingCommentId).toBe(2);
  });

  test("the local poster's own summary is its re-review's summary", async () => {
    const { spawnFn } = fakeGh(
      issueComments([
        { id: 1, user: "local-dev", body: summary(REAL_HEAD) },
        { id: 3, user: "mallory", body: summary(FORGED_HEAD) },
      ]),
    );
    const plan = await resolveInlinePostPlan({
      operatorRoot: "/repo",
      pr: 42,
      headSha: HEAD,
      doc,
      diffPatch: "",
      trust: TRUST,
      spawnFn,
    });
    expect(plan.existingSummaryId).toBe(1);
  });
});

describe("postPrComment never PATCHes an outsider's summary", () => {
  test("with only a forged summary on the PR, it creates its own", async () => {
    const { spawnFn, calls } = fakeGh(
      issueComments([{ id: 3, user: "mallory", body: summary(FORGED_HEAD) }]),
    );
    const result = await postPrComment(
      "/repo",
      42,
      summary(HEAD),
      TRUST,
      spawnFn,
    );
    expect(result.action).toBe("created");
    expect(calls.some((argv) => argv.includes("PATCH"))).toBe(false);
  });

  test("with the real summary before a forged one, it PATCHes the real one", async () => {
    const { spawnFn, calls } = fakeGh(
      issueComments([
        { id: 1, user: "crysk-ai[bot]", body: summary(REAL_HEAD) },
        { id: 3, user: "mallory", body: summary(FORGED_HEAD) },
      ]),
    );
    await postPrComment("/repo", 42, summary(HEAD), TRUST, spawnFn);
    const patch = calls.find((argv) => argv.includes("PATCH"));
    expect(patch?.join(" ")).toContain("issues/comments/1");
  });
});

describe("the watcher reads only trusted summaries", () => {
  test("a forged summary declares no head and proves no review", () => {
    const forged = [{ user: "mallory", body: summary(FORGED_HEAD) }];
    expect(markerDeclaredHeads(forged, TRUST)).toEqual([]);
    expect(markerCommentSeen(forged, TRUST)).toBe(false);
  });

  test("the local poster's summary still settles its head next to a forged one", () => {
    const comments = [
      { user: "local-dev", body: summary(REAL_HEAD) },
      { user: "mallory", body: summary(FORGED_HEAD) },
    ];
    expect(markerDeclaredHeads(comments, TRUST)).toEqual([REAL_HEAD]);
    expect(markerCommentSeen(comments, TRUST)).toBe(true);
  });
});
