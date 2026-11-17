import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTriageReplyCommand, triageCommand } from "#commands/triage";
import { answeredBlockingFindings } from "#pr/answered-findings";
import { buildPrStatus } from "#pr/pr-status";
import {
  COMMIT_STATUS_CONTEXT,
  type CommitStatusFact,
  findingMarker,
} from "#pr/preflight";
import { renderStateBlock, stateFinding } from "#rereview/state";
import type { Finding, FindingsDocument, Telemetry } from "#review/findings";
import type { CliOptions } from "#review/preflight";
import { triageMarker } from "#triage/triage";
import { CliUsageError } from "../../src/errors";

interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  // Streams and exit settle only when kill() fires — the shape of a `gh`
  // call GitHub accepted and never answered. Ported from
  // test/step-runner.test.ts's makeFakeSpawn, which is how that module's
  // watchdog is exercised without a real 30-minute wait; the collapse loop's
  // watchdog needs the same lever.
  hang?: boolean;
}

interface ScriptEntry {
  match: string[];
  response?: ScriptedResponse;
  // Sequential per-call responses for the SAME matched argv (call-counting):
  // consumed in order across repeated calls to the same endpoint, the last
  // entry repeating once exhausted. Needed to simulate a re-fetch of the
  // SAME endpoint returning a DIFFERENT answer than the first fetch did —
  // e.g. a concurrent process posting a comment between this run's plan
  // snapshot and its immediately-pre-post re-fetch. `response` and
  // `responses` are mutually exclusive; `response` is a plain single-value
  // shorthand kept for every pre-existing script.
  responses?: ScriptedResponse[];
}

interface RecordedCall {
  argv: string[];
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
  // gh api's create/update calls always print `{"id": N}`-shaped JSON; N
  // increments per call so two comments created in the same test never
  // collide on id.
  let nextId = 100;
  // Per-entry call counter, only consulted when an entry uses `responses`
  // (sequential) rather than `response` (single, repeats forever).
  const responseIndex = new Map<ScriptEntry, number>();
  const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
    const stdin =
      opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin);
    calls.push({ argv, stdin });
    const entry = script.find((s) => argvContains(argv, s.match));
    let scripted: ScriptedResponse | undefined;
    if (entry?.responses) {
      const i = responseIndex.get(entry) ?? 0;
      scripted = entry.responses[Math.min(i, entry.responses.length - 1)];
      responseIndex.set(entry, i + 1);
    } else {
      scripted = entry?.response;
    }
    if (scripted === undefined) {
      // Default: any unscripted --method POST/PATCH create succeeds with a
      // fresh id — covers the summary create/patch without a script entry
      // per call.
      //
      // GATED on --method since GitHub #39, and the gate is the point: an
      // unscripted READ used to get `{"id":N}` too, which was harmless only
      // as long as nothing read a scalar. `ghPrHeadSha` reads one (`gh pr
      // view --json headRefOid -q .headRefOid`), and a fabricated `{"id":102}`
      // is not the reviewed sha, so every unscripted post test started
      // reporting a moved head. An unscripted read now answers with NOTHING,
      // which ghPrHeadSha reads as "could not verify" and renders as silence
      // — the honest default for a question the script never answered. Tests
      // that need a definite answer script `headRefOid` explicitly.
      scripted = argv.includes("--method")
        ? { stdout: JSON.stringify({ id: nextId++ }), exitCode: 0 }
        : { stdout: "", exitCode: 0 };
    }
    const held: ReadableStreamDefaultController<Uint8Array>[] = [];
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (scripted?.hang) {
            held.push(controller);
            return;
          }
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    const stdout = stream(scripted.stdout ?? "");
    const stderr = stream(scripted.stderr ?? "");
    if (!scripted.hang) resolveExit(scripted.exitCode ?? 0);
    return {
      stdout,
      stderr,
      exited,
      kill() {
        for (const controller of held) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
        resolveExit(143);
      },
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

// The collaborator-permission lookup a reply's author gets before it counts as an answer.
function permissionEntry(
  login: string,
  response: ScriptedResponse,
): ScriptEntry {
  return { match: [`collaborators/${login}/permission`], response };
}

function ndjson(rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

const OPERATOR_ROOT = "/repo";
const HEAD = "b".repeat(40);
const OLD_HEAD = "a".repeat(40);

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    category: 12,
    path: "src/app.ts",
    line: 10,
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

const TELEMETRY: Telemetry = {
  index_ms: 0,
  index_mode: "sync",
  index_disk_mb: 0,
  wall_ms: 1000,
  tokens_in: 10,
  tokens_out: 10,
  tokens_total: 20,
};

function doc(overrides: Partial<FindingsDocument> = {}): FindingsDocument {
  const findings = overrides.findings ?? [];
  return {
    schema_version: "1.0.0",
    pr: 42,
    base_sha: OLD_HEAD,
    head_sha: HEAD,
    model: "sonnet",
    iteration: 0,
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: TELEMETRY,
    findings,
    debug: { refuted: [] },
    ...overrides,
  };
}

const RUN_HEAD = "c".repeat(40);

// The PR view `crysk status` reads first. Its head is HEAD, the head the fixtures reply to.
function prViewScript(): ScriptEntry {
  return {
    match: ["pr", "view", "42", "--json"],
    response: {
      stdout: JSON.stringify({
        additions: 1,
        baseRefName: "dev",
        baseRefOid: "c".repeat(40),
        changedFiles: 1,
        deletions: 0,
        headRefOid: HEAD,
        mergeCommit: null,
        number: 42,
        state: "OPEN",
        title: "t",
      }),
    },
  };
}

// The commit statuses of HEAD that `crysk status` reads. Empty by default: the verdict time is unknown.
function commitStatusScript(statuses: unknown[] = []): ScriptEntry {
  return {
    match: [`commits/${HEAD}/status`],
    response: { stdout: statuses.length === 0 ? "" : ndjson(statuses) },
  };
}

// The crysk red a skip or a review writes on a head, created at createdAt.
function redGateStatus(createdAt: string): unknown {
  return {
    state: "failure",
    context: COMMIT_STATUS_CONTEXT,
    created_at: createdAt,
    description:
      "crysk: 1 blocking finding(s) — fix and push, or /crysk override",
    target_url: null,
  };
}

// The bare `triage --pr --from` verb was retired with comparison.json.
// Its only supported subcommand is `triage reply`, and a
// bare triage must fail as a usage error before any gh call is made.
describe("triageCommand — the bare triage verb is retired", () => {
  test("bare triage is a CliUsageError that names `triage reply`, before any gh call", async () => {
    const error = await triageCommand({
      pr: 42,
      from: "/tmp/does-not-matter",
      triage: undefined,
    } as unknown as CliOptions).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliUsageError);
    expect((error as Error).message).toContain("triage reply");
  });
});

const F001_CLAIM = "the latch never resets";
const F001_PATH = "docs/runbook.md";

async function writeReplyRunDir(input?: {
  findingLine?: number;
  postLine?: number;
  path?: string;
}): Promise<{
  dir: string;
  bodyFile: string;
  cleanup: () => Promise<void>;
}> {
  const findingPath = input?.path ?? F001_PATH;
  const findingsLine = input?.findingLine ?? 144;
  const postLine = input?.postLine ?? findingsLine;
  // When post remaps off-hunk → in-diff, the hunk must cover the post line
  // only — not the hunter cite — or resolvePostLine never moves.
  const hunkStart = postLine !== findingsLine ? postLine : findingsLine;
  const hunkLength = 10;
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-reply-test-"));
  const runDoc = doc({
    head_sha: RUN_HEAD,
    findings: [
      finding({
        id: "F001",
        path: findingPath,
        line: findingsLine,
        claim: F001_CLAIM,
        ...(postLine !== findingsLine
          ? { proof_refs: [`${findingPath}:${postLine}`] }
          : {}),
      }),
    ],
  });
  await Bun.write(
    path.join(dir, "findings.json"),
    JSON.stringify(runDoc, null, 2),
  );
  const diffBody = Array.from(
    { length: hunkLength },
    (_, i) => `+line ${hunkStart + i}`,
  ).join("\n");
  const diffPatch =
    `diff --git a/${findingPath} b/${findingPath}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${findingPath}\n` +
    `+++ b/${findingPath}\n` +
    `@@ -0,0 +${hunkStart},${hunkLength} @@\n` +
    `${diffBody}\n`;
  await Bun.write(path.join(dir, "diff.patch"), diffPatch);
  const bodyFile = path.join(dir, "reason.md");
  await Bun.write(bodyFile, "Fixed by resetting the latch on unmount.");
  return {
    dir,
    bodyFile,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function greptileCollisionScript(input?: {
  postLine?: number;
  path?: string;
  statuses?: unknown[];
}): ScriptEntry[] {
  const postLine = input?.postLine ?? 144;
  const findingPath = input?.path ?? F001_PATH;
  return [
    {
      match: ["issues/42/comments", "--paginate"],
      response: { stdout: "" },
    },
    {
      match: ["pulls/42/comments", "--paginate"],
      response: {
        stdout: ndjson([
          {
            id: 11,
            user: "greptile-apps",
            body: "same line, not ours",
            path: findingPath,
            line: postLine,
            original_line: postLine,
            in_reply_to_id: null,
          },
          {
            id: 22,
            user: "pr-hero",
            body: `${findingMarker({
              path: findingPath,
              line: postLine,
              headSha: RUN_HEAD,
              claim: F001_CLAIM,
            })}\n${F001_CLAIM}`,
            path: findingPath,
            line: postLine,
            original_line: postLine,
            in_reply_to_id: null,
          },
        ]),
      },
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
                      id: "PRRT_f001",
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
    // The reply author of the fixtures has write access.
    permissionEntry("dev", { stdout: "write\n" }),
    prViewScript(),
    commitStatusScript(input?.statuses),
  ];
}

// A PR whose finding comment was posted by an earlier review: the summary is written for
// summaryHead (HEAD by default), the finding comment still carries commentHead (RUN_HEAD by
// default), and extraReviewComments are further review comments on the PR.
function carriedScript(
  extraReviewComments: unknown[] = [],
  options: {
    summaryHead?: string;
    commentHead?: string;
    statuses?: unknown[];
  } = {},
): ScriptEntry[] {
  const summaryHead = options.summaryHead ?? HEAD;
  const commentHead = options.commentHead ?? RUN_HEAD;
  const script = greptileCollisionScript({ statuses: options.statuses });
  const summaryBody = [
    `<!-- pr-hero-report head=${summaryHead} -->`,
    "",
    renderStateBlock(
      summaryHead,
      [
        stateFinding({
          id: "R001",
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: [`${F001_PATH}:144`],
          claim: F001_CLAIM,
        }),
      ],
      undefined,
      1,
    ),
  ].join("\n");
  script[0] = {
    match: ["issues/42/comments", "--paginate"],
    response: {
      stdout: ndjson([{ id: 5, user: "pr-hero", body: summaryBody }]),
    },
  };
  script[1] = {
    match: ["pulls/42/comments", "--paginate"],
    response: {
      stdout: ndjson([
        {
          id: 11,
          user: "greptile-apps",
          body: "same line, not ours",
          path: F001_PATH,
          line: 144,
          original_line: 144,
          in_reply_to_id: null,
        },
        {
          id: 22,
          user: "pr-hero",
          body: `${findingMarker({
            path: F001_PATH,
            line: 144,
            headSha: commentHead,
            claim: F001_CLAIM,
          })}\n${F001_CLAIM}`,
          path: F001_PATH,
          line: 144,
          original_line: 144,
          in_reply_to_id: null,
        },
        ...extraReviewComments,
      ]),
    },
  };
  return script;
}

describe("runTriageReplyCommand", () => {
  test("dry-run fetches but does not POST or resolve", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn, calls } = makeFakeGh(greptileCollisionScript());
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.argv).not.toContain("--method");
        expect(call.argv.join(" ")).not.toContain("resolveReviewThread");
      }
    } finally {
      await cleanup();
    }
  });

  test("#20: replies to the pr-hero marker, not Greptile at the same line", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn, calls } = makeFakeGh(greptileCollisionScript());
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const post = calls.find(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      );
      expect(post).toBeDefined();
      expect(post?.argv.join(" ")).toContain("in_reply_to=22");
      expect(post?.argv.join(" ")).not.toContain("in_reply_to=11");
      expect(post?.stdin).toContain("<!-- crysk-triage tag=applied");
      expect(post?.stdin).toContain("✅ **APPLIED**");
      expect(post?.stdin).toContain("Fixed by resetting the latch on unmount.");
      expect(
        calls.some((call) =>
          call.argv.join(" ").includes("resolveReviewThread"),
        ),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("binds when post remapped the line (findings.json:19 → posted marker:27)", async () => {
    const findingPath = "src/a.ts";
    const { dir, bodyFile, cleanup } = await writeReplyRunDir({
      path: findingPath,
      findingLine: 19,
      postLine: 27,
    });
    try {
      const { spawnFn, calls } = makeFakeGh(
        greptileCollisionScript({ path: findingPath, postLine: 27 }),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const post = calls.find(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      );
      expect(post?.argv.join(" ")).toContain("in_reply_to=22");
    } finally {
      await cleanup();
    }
  });

  // The outside channel: the finding is a top-level issue comment (id 555), with no review
  // thread. The reply's link is the only thing that binds it, so every test below reads the
  // body the POST carries. The caller scripts the gh reads that can name a web URL.
  function outsideChannelScript(urlReads: ScriptEntry[]): ScriptEntry[] {
    const finding = findingMarker({
      path: F001_PATH,
      line: 144,
      headSha: RUN_HEAD,
      claim: F001_CLAIM,
    });
    return [
      ...urlReads,
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            { id: 555, user: "pr-hero", body: `${finding}\n${F001_CLAIM}` },
          ]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
      prViewScript(),
      commitStatusScript(),
    ];
  }

  function postedBody(calls: RecordedCall[]): string | undefined {
    return calls.find((c) => c.argv.includes("--method"))?.stdin;
  }

  test("an outside-channel reply keeps its #issuecomment link when the repo web URL lookup fails, through the PR's own URL", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn, calls } = makeFakeGh(
        outsideChannelScript([
          {
            match: ["repo", "view", "--json", "url"],
            response: { stderr: "HTTP 500", exitCode: 1 },
          },
          {
            match: ["pr", "view", "42", "--json", "url"],
            response: { stdout: "https://github.com/musive/musive/pull/42\n" },
          },
        ]),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(postedBody(calls)).toContain(
        "In reply to: https://github.com/musive/musive/pull/42#issuecomment-555",
      );
    } finally {
      await cleanup();
    }
  });

  test("with the repo web URL and the PR URL both unreadable, the repo's nameWithOwner builds the link", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    const previousHost = process.env.GITHUB_SERVER_URL;
    process.env.GITHUB_SERVER_URL = "https://github.com";
    try {
      const { spawnFn, calls } = makeFakeGh(
        outsideChannelScript([
          {
            match: ["repo", "view", "--json", "url"],
            response: { stderr: "HTTP 500", exitCode: 1 },
          },
          {
            match: ["pr", "view", "42", "--json", "url"],
            response: { stderr: "HTTP 500", exitCode: 1 },
          },
          {
            match: ["repo", "view", "--json", "nameWithOwner"],
            response: { stdout: "musive/musive\n" },
          },
        ]),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(postedBody(calls)).toContain(
        "In reply to: https://github.com/musive/musive/pull/42#issuecomment-555",
      );
    } finally {
      if (previousHost === undefined) delete process.env.GITHUB_SERVER_URL;
      else process.env.GITHUB_SERVER_URL = previousHost;
      await cleanup();
    }
  });

  test("an empty GITHUB_SERVER_URL falls back to github.com, never to a host-less link", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    const previousHost = process.env.GITHUB_SERVER_URL;
    process.env.GITHUB_SERVER_URL = "";
    try {
      const { spawnFn, calls } = makeFakeGh(
        outsideChannelScript([
          {
            match: ["repo", "view", "--json", "url"],
            response: { stderr: "HTTP 500", exitCode: 1 },
          },
          {
            match: ["pr", "view", "42", "--json", "url"],
            response: { stderr: "HTTP 500", exitCode: 1 },
          },
          {
            match: ["repo", "view", "--json", "nameWithOwner"],
            response: { stdout: "musive/musive\n" },
          },
        ]),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(postedBody(calls)).toContain(
        "In reply to: https://github.com/musive/musive/pull/42#issuecomment-555",
      );
    } finally {
      if (previousHost === undefined) delete process.env.GITHUB_SERVER_URL;
      else process.env.GITHUB_SERVER_URL = previousHost;
      await cleanup();
    }
  });

  test("with no web URL of any kind readable, the reply posts without a link, as before", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn, calls } = makeFakeGh(
        outsideChannelScript([
          {
            match: ["repo", "view", "--json", "url"],
            response: { stderr: "HTTP 500", exitCode: 1 },
          },
          {
            match: ["pr", "view", "42", "--json", "url"],
            response: { stderr: "HTTP 500", exitCode: 1 },
          },
          {
            match: ["repo", "view", "--json", "nameWithOwner"],
            response: { stderr: "HTTP 500", exitCode: 1 },
          },
        ]),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const body = postedBody(calls);
      expect(body).toBeDefined();
      expect(body).not.toContain("In reply to:");
    } finally {
      await cleanup();
    }
  });

  test("refuses when diff.patch is missing", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    await rm(path.join(dir, "diff.patch"));
    try {
      const { spawnFn, calls } = makeFakeGh([]);
      await expect(
        runTriageReplyCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          findingId: "F001",
          tag: "applied",
          bodyFile,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/missing diff\.patch/);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("refuses a --body-file that already starts with the triage marker", async () => {
    const { dir, cleanup } = await writeReplyRunDir();
    const bodyFile = path.join(dir, "bad.md");
    await Bun.write(
      bodyFile,
      `${triageMarker({ tag: "applied", headSha: RUN_HEAD, actor: "agent" })}\nnope`,
    );
    try {
      const { spawnFn, calls } = makeFakeGh([]);
      await expect(
        runTriageReplyCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          findingId: "F001",
          tag: "applied",
          bodyFile,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/reasoning prose only/);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("live #34: resolve failure after a successful post says re-run, not gh", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const script = greptileCollisionScript().map((entry) =>
        entry.match.includes("reviewThreads")
          ? {
              ...entry,
              response: {
                stdout: "",
                stderr: 'Expected NAME, actual: (none) ("") at [1, 202]',
                exitCode: 1,
              },
            }
          : entry,
      );
      const { spawnFn, calls } = makeFakeGh(script);
      await expect(
        runTriageReplyCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          findingId: "F001",
          tag: "applied",
          bodyFile,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/resolve failed after the reply was on GitHub/);
      expect(
        calls.some(
          (call) =>
            call.argv.includes("--method") &&
            call.argv.join(" ").includes("pulls/42/comments"),
        ),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("skips resolve when the adjudicator is inconclusive", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn, calls } = makeFakeGh(greptileCollisionScript());
      await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "dismissed",
        verdict: "inconclusive",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(
        calls.some((call) =>
          call.argv.join(" ").includes("resolveReviewThread"),
        ),
      ).toBe(false);
      const post = calls.find((call) => call.argv.includes("--method"));
      expect(post?.stdin).toContain("verdict=inconclusive");
    } finally {
      await cleanup();
    }
  });
});

describe("runTriageReplyCommand — a --from id whose finding was carried", () => {
  test("a --from id whose finding was carried names the R### exit", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn } = makeFakeGh(
        carriedScript([], { summaryHead: RUN_HEAD, commentHead: OLD_HEAD }),
      );
      const error = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      const message = (error as Error).message;
      expect(message).toContain("no posted");
      expect(message).toContain("without --from");
      expect(message).toContain("crysk status --pr 42 --json");
      expect(message).toContain("R001");
    } finally {
      await cleanup();
    }
  });

  // WHY a reply is scripted: the rows hint reads the same writer lookup as the gate, and a
  // reply that is not counted must not take the hint away with it.
  test("the rows hint survives an existing triage reply", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn } = makeFakeGh([
        ...carriedScript(
          [
            {
              id: 23,
              user: "dev",
              in_reply_to_id: 22,
              body: `${triageMarker({ tag: "applied", headSha: RUN_HEAD, actor: "agent" })}\n\nthis round`,
            },
          ],
          { summaryHead: RUN_HEAD, commentHead: OLD_HEAD },
        ),
        permissionEntry("dev", { stdout: "write\n" }),
      ]);
      const error = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      const message = (error as Error).message;
      expect(message).toContain("no posted");
      expect(message).toContain("On this path:");
      expect(message).toContain("R001");
    } finally {
      await cleanup();
    }
  });
});

describe("runTriageReplyCommand — with a run directory, a reply already at the run's head", () => {
  const AFTER = "2026-10-30T11:00:00Z";

  // The run's finding is posted as comment 22 at RUN_HEAD (greptileCollisionScript). A reply from
  // `login` at that head sits in its thread, and the permission lookup of that login answers `permission`.
  function replyScript(login: string, permission: string): ScriptEntry[] {
    const reply = {
      id: 30,
      user: login,
      in_reply_to_id: 22,
      created_at: AFTER,
      path: F001_PATH,
      line: 144,
      original_line: 144,
      body: `${triageMarker({ tag: "applied", headSha: RUN_HEAD, actor: "agent" })}\n\nfixed by resetting the latch\n`,
    };
    return greptileCollisionScript().map((entry) => {
      if (entry.match[0] === "pulls/42/comments") {
        const rows = (entry.response?.stdout ?? "")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
        return {
          match: entry.match,
          response: { stdout: ndjson([...rows, reply]) },
        };
      }
      if (entry.match[0] === `collaborators/${login}/permission`) {
        return permissionEntry(login, { stdout: `${permission}\n` });
      }
      return entry;
    });
  }

  // Runs the reply from the run directory and returns the POSTs it made and what it logged.
  async function replyFromRunDir(script: ScriptEntry[]): Promise<{
    exitCode: number;
    calls: RecordedCall[];
    written: string;
  }> {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      },
    );
    try {
      const { spawnFn, calls } = makeFakeGh(script);
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      return { exitCode, calls, written: written.join("") };
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  }

  const postsOf = (calls: RecordedCall[]) =>
    calls.filter((call) => call.argv.includes("--method"));

  test("with a run directory, a writer's reply at the run's head is a repeat", async () => {
    // A writer (write permission) already answered this finding at the run's head: the driver skips.
    const { exitCode, calls, written } = await replyFromRunDir(
      replyScript("dev", "write"),
    );
    expect(exitCode).toBe(0);
    expect(postsOf(calls)).toHaveLength(0);
    expect(written).toContain("skip post");
  });

  test("with a run directory, a reply from a login without write access is not a repeat", async () => {
    // The same reply by a read-only login does not count as an answer, so the driver posts once.
    const { exitCode, calls, written } = await replyFromRunDir(
      replyScript("dev", "read"),
    );
    expect(exitCode).toBe(0);
    expect(postsOf(calls)).toHaveLength(1);
    expect(written).not.toContain("skip post");
  });
});

describe("runTriageReplyCommand — anchor.patch is the anchoring diff", () => {
  test("reads anchor.patch when diff.patch is absent", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    const diffPatch = await Bun.file(path.join(dir, "diff.patch")).text();
    await rm(path.join(dir, "diff.patch"));
    await Bun.write(path.join(dir, "anchor.patch"), diffPatch);
    try {
      const { spawnFn } = makeFakeGh([]);
      const failure = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: true,
        spawnFn,
      }).then(
        () => null,
        (error: unknown) => String(error),
      );
      expect(failure ?? "").not.toMatch(/diff\.patch/);
    } finally {
      await cleanup();
    }
  });
});

// triage-without-skill S2: "estaría buenísimo que lo resuelva solo con el número de PR y el id del hallazgo".
// Without --from the finding is read off the PR by its stable R### id (the one crysk status lists): the
// summary's state block names it, the posted
// finding comment carries its head, and the reply binds to that comment.
describe("runTriageReplyCommand — without a run directory", () => {
  function prScript(): ScriptEntry[] {
    const summaryBody = [
      `<!-- pr-hero-report head=${RUN_HEAD} -->`,
      "",
      renderStateBlock(
        RUN_HEAD,
        [
          stateFinding({
            id: "R001",
            sev: "CRITICAL",
            tier: "blocking",
            channel: "inline",
            locs: [`${F001_PATH}:144`],
            claim: F001_CLAIM,
          }),
        ],
        undefined,
        1,
      ),
    ].join("\n");
    const script = greptileCollisionScript();
    script[0] = {
      match: ["issues/42/comments", "--paginate"],
      response: {
        stdout: ndjson([{ id: 5, user: "pr-hero", body: summaryBody }]),
      },
    };
    return script;
  }

  async function bodyOnly(): Promise<{
    bodyFile: string;
    cleanup: () => Promise<void>;
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-triage-pr-"));
    const bodyFile = path.join(dir, "body.md");
    await Bun.write(bodyFile, "Fixed by resetting the latch on unmount.\n");
    return {
      bodyFile,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  test("binds R001 from the PR and writes the finding's head into the marker", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh(prScript());
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const post = calls.find(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      );
      expect(post?.argv.join(" ")).toContain("in_reply_to=22");
      expect(post?.stdin).toContain(
        `<!-- crysk-triage tag=applied head=${RUN_HEAD} actor=agent -->`,
      );
      expect(post?.stdin).toContain("Fixed by resetting the latch on unmount.");
    } finally {
      await cleanup();
    }
  });

  test("a finding carried from an earlier review is stamped with the reviewed head", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh(carriedScript());
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const post = calls.find(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      );
      expect(post?.argv.join(" ")).toContain("in_reply_to=22");
      expect(post?.stdin).toContain(
        `<!-- crysk-triage tag=applied head=${HEAD} actor=agent -->`,
      );
    } finally {
      await cleanup();
    }
  });

  test("a carried finding with a reply from the earlier review is answered again", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh(
        carriedScript([
          {
            id: 23,
            user: "dev",
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: RUN_HEAD, actor: "agent" })}\n\nfirst round`,
          },
        ]),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const post = calls.find(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      );
      expect(post).toBeDefined();
      expect(post?.stdin).toContain(`head=${HEAD}`);
    } finally {
      await cleanup();
    }
  });

  test("a second reply to the same review is skipped", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...carriedScript([
          {
            id: 23,
            user: "dev",
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nthis round`,
          },
        ]),
        permissionEntry("dev", { stdout: "write\n" }),
      ]);
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some(
          (call) =>
            call.argv.includes("--method") &&
            call.argv.join(" ").includes("pulls/42/comments"),
        ),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("a reply-shaped comment from a login without write access does not block the real reply", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...carriedScript([
          {
            id: 23,
            user: "drive-by",
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nfake`,
          },
        ]),
        permissionEntry("drive-by", { stdout: "read\n" }),
      ]);
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const posts = calls.filter(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]?.stdin).toContain(`head=${HEAD}`);
    } finally {
      await cleanup();
    }
  });

  test("a permission that does not read stops the command and posts nothing", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        permissionEntry("dev", { stderr: "HTTP 500", exitCode: 1 }),
        ...carriedScript([
          {
            id: 23,
            user: "dev",
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nthis round`,
          },
        ]),
      ]);
      await expect(
        runTriageReplyCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          findingId: "R001",
          tag: "applied",
          bodyFile,
          dryRun: false,
          spawnFn,
          sleepFn: async () => {},
        }),
      ).rejects.toThrow(
        /could not read whether dev has write access[\s\S]*Nothing was changed/,
      );
      expect(
        calls.filter((call) => call.argv.includes("--method")),
      ).toHaveLength(0);
      expect(
        calls.filter((call) =>
          call.argv.join(" ").includes("collaborators/dev/permission"),
        ),
      ).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  test("a permission that reads on the second ask counts", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...carriedScript([
          {
            id: 23,
            user: "dev",
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nthis round`,
          },
        ]),
        {
          match: ["collaborators/dev/permission"],
          responses: [
            { stderr: "HTTP 500", exitCode: 1 },
            { stdout: "write\n" },
          ],
        },
      ]);
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
        sleepFn: async () => {},
      });
      expect(exitCode).toBe(0);
      expect(
        calls.filter((call) => call.argv.includes("--method")),
      ).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("an admin's earlier reply is a repeat", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...carriedScript([
          {
            id: 23,
            user: "dev",
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nthis round`,
          },
        ]),
        permissionEntry("dev", { stdout: "admin\n" }),
      ]);
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some(
          (call) =>
            call.argv.includes("--method") &&
            call.argv.join(" ").includes("pulls/42/comments"),
        ),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("an older reply at this head does not block when a newer counted reply names another head", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const foreignHead = "e".repeat(40);
      const { spawnFn, calls } = makeFakeGh(
        carriedScript(
          [
            {
              id: 23,
              user: "dev",
              in_reply_to_id: 22,
              created_at: "2026-10-30T11:00:00Z",
              body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nthis round`,
            },
            {
              id: 24,
              user: "dev",
              in_reply_to_id: 22,
              created_at: "2026-10-30T11:00:00Z",
              body: `${triageMarker({ tag: "applied", headSha: foreignHead, actor: "agent" })}\n\nlater`,
            },
          ],
          { statuses: [redGateStatus("2026-10-30T10:00:00Z")] },
        ),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const posts = calls.filter(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]?.stdin).toContain(`head=${HEAD}`);
    } finally {
      await cleanup();
    }
  });

  test("an id the PR does not carry is refused, naming the PR", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh(prScript());
      const error = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R009",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect((error as Error).message).toContain(
        "PR #42 has no posted finding R009",
      );
      expect(calls.some((call) => call.argv.includes("--method"))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("triage reply — the reply the driver posts is the one the gate counts", () => {
  const VERDICT = "2026-10-30T10:00:00Z";
  const BEFORE = "2026-10-30T09:00:00Z";
  const AFTER = "2026-10-30T11:00:00Z";

  const rows = (entry: ScriptEntry) =>
    (entry.response?.stdout ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

  function gateFor(
    script: ScriptEntry[],
    reviewedHead: string,
    extraReviewComments: unknown[] = [],
  ) {
    return answeredBlockingFindings({
      pr: 42,
      reviewedHead,
      issueComments: rows(script[0]),
      reviewComments: [...rows(script[1]), ...extraReviewComments],
      trustedActors: new Set(["pr-hero", "dev"]),
      writers: new Map([["dev", true]]),
      verdictAt: VERDICT,
    });
  }

  // The stdin of the reply the driver POSTs, or undefined when it posts none.
  async function driverReply(
    script: ScriptEntry[],
  ): Promise<string | undefined> {
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-triage-roundtrip-"));
    try {
      const bodyFile = path.join(dir, "body.md");
      await Bun.write(bodyFile, "Fixed by resetting the latch on unmount.\n");
      const { spawnFn, calls } = makeFakeGh(script);
      await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      return calls.find(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      )?.stdin;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  function gateForIssue(
    script: ScriptEntry[],
    reviewedHead: string,
    extraIssueComments: unknown[] = [],
  ) {
    return answeredBlockingFindings({
      pr: 42,
      reviewedHead,
      issueComments: [...rows(script[0]), ...extraIssueComments],
      reviewComments: rows(script[1]),
      trustedActors: new Set(["pr-hero", "dev"]),
      writers: new Map([["dev", true]]),
      verdictAt: VERDICT,
    });
  }

  // The stdin of the top-level reply the driver POSTs for a finding with no comment.
  async function driverRowReply(
    script: ScriptEntry[],
  ): Promise<string | undefined> {
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-triage-roundtrip-"));
    try {
      const bodyFile = path.join(dir, "body.md");
      await Bun.write(bodyFile, "Fixed by resetting the latch on unmount.\n");
      const { spawnFn, calls } = makeFakeGh(script);
      await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      return rowPosts(calls)[0]?.stdin;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("a finding posted on the reviewed head", async () => {
    const script = carriedScript([], {
      summaryHead: RUN_HEAD,
      commentHead: RUN_HEAD,
    });
    expect(gateFor(script, RUN_HEAD)).toEqual({ blocking: 1, open: 1 });
    const body = await driverReply(script);
    expect(body).toBeDefined();
    expect(
      gateFor(script, RUN_HEAD, [
        { id: 99, user: "dev", in_reply_to_id: 22, body, created_at: AFTER },
      ]),
    ).toEqual({ blocking: 1, open: 0 });
  });

  test("a finding carried from an earlier review, never answered", async () => {
    const script = carriedScript();
    expect(gateFor(script, HEAD)).toEqual({ blocking: 1, open: 1 });
    const body = await driverReply(script);
    expect(body).toBeDefined();
    expect(body).toContain(`head=${HEAD}`);
    expect(
      gateFor(script, HEAD, [
        { id: 99, user: "dev", in_reply_to_id: 22, body, created_at: AFTER },
      ]),
    ).toEqual({ blocking: 1, open: 0 });
  });

  test("a finding carried from an earlier review, already answered in that round", async () => {
    const first = {
      id: 23,
      user: "dev",
      in_reply_to_id: 22,
      created_at: BEFORE,
      body: `${triageMarker({ tag: "applied", headSha: RUN_HEAD, actor: "agent" })}\n\nfirst round`,
    };
    const script = carriedScript([first]);
    expect(gateFor(script, HEAD)).toEqual({ blocking: 1, open: 1 });
    const body = await driverReply(script);
    expect(body).toBeDefined();
    expect(body).toContain(`head=${HEAD}`);
    expect(
      gateFor(script, HEAD, [
        { id: 99, user: "dev", in_reply_to_id: 22, body, created_at: AFTER },
      ]),
    ).toEqual({ blocking: 1, open: 0 });
  });

  test("status tells the same story for the answered-earlier case", async () => {
    const first = {
      id: 23,
      user: "dev",
      in_reply_to_id: 22,
      created_at: BEFORE,
      body: `${triageMarker({ tag: "applied", headSha: RUN_HEAD, actor: "agent" })}\n\nfirst round`,
    };
    const script = carriedScript([first]);
    const failingGate: CommitStatusFact = {
      state: "failure",
      context: COMMIT_STATUS_CONTEXT,
      created_at: VERDICT,
      description:
        "crysk: 1 blocking finding(s) — fix and push, or /crysk override",
      target_url: null,
    };
    const statusFor = (reviewComments: unknown[]) =>
      buildPrStatus({
        pr: 42,
        head: HEAD,
        nowMs: Date.parse(AFTER) + 60_000,
        statuses: [failingGate],
        writers: new Map([["dev", true]]),
        issueComments: rows(script[0]),
        reviewComments: [...rows(script[1]), ...reviewComments],
      });

    expect(statusFor([]).next_action).toBe("triage");
    const body = await driverReply(script);
    expect(body).toBeDefined();
    expect(
      statusFor([
        { id: 99, user: "dev", in_reply_to_id: 22, body, created_at: AFTER },
      ]).next_action,
    ).toBe("fix");
  });

  test("an older reply at this head and a newer one at another head: the driver replies, then the gate and status agree", async () => {
    const foreignHead = "e".repeat(40);
    const failingGate: CommitStatusFact = {
      state: "failure",
      context: COMMIT_STATUS_CONTEXT,
      created_at: VERDICT,
      description:
        "crysk: 1 blocking finding(s) — fix and push, or /crysk override",
      target_url: null,
    };
    const script = carriedScript(
      [
        {
          id: 23,
          user: "dev",
          in_reply_to_id: 22,
          created_at: AFTER,
          body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nthis round`,
        },
        {
          id: 24,
          user: "dev",
          in_reply_to_id: 22,
          created_at: AFTER,
          body: `${triageMarker({ tag: "applied", headSha: foreignHead, actor: "agent" })}\n\nlater`,
        },
      ],
      { statuses: [failingGate] },
    );
    const statusFor = (reviewComments: unknown[]) =>
      buildPrStatus({
        pr: 42,
        head: HEAD,
        nowMs: Date.parse(AFTER) + 60_000,
        statuses: [failingGate],
        writers: new Map([["dev", true]]),
        verdictAt: VERDICT,
        issueComments: rows(script[0]),
        reviewComments: [...rows(script[1]), ...reviewComments],
      });

    expect(gateFor(script, HEAD)).toEqual({ blocking: 1, open: 1 });
    expect(statusFor([]).next_action).toBe("triage");
    const body = await driverReply(script);
    expect(body).toContain(`head=${HEAD}`);
    const posted = [
      { id: 99, user: "dev", in_reply_to_id: 22, body, created_at: AFTER },
    ];
    expect(gateFor(script, HEAD, posted)).toEqual({ blocking: 1, open: 0 });
    expect(statusFor(posted).next_action).toBe("fix");
  });

  test("a finding with no comment", async () => {
    const script = rowScript();
    expect(gateFor(script, HEAD)).toEqual({ blocking: 1, open: 1 });
    const body = await driverRowReply(script);
    expect(body).toBeDefined();
    expect(
      gateForIssue(script, HEAD, [
        { id: 99, user: "dev", body, created_at: AFTER },
      ]),
    ).toEqual({ blocking: 1, open: 0 });
  });

  test("a finding with no comment, status moves from triage to fix", async () => {
    const script = rowScript();
    const failingGate: CommitStatusFact = {
      state: "failure",
      context: COMMIT_STATUS_CONTEXT,
      created_at: VERDICT,
      description:
        "crysk: 1 blocking finding(s) — fix and push, or /crysk override",
      target_url: null,
    };
    const statusFor = (issueComments: unknown[]) =>
      buildPrStatus({
        pr: 42,
        head: HEAD,
        nowMs: Date.parse(AFTER) + 60_000,
        statuses: [failingGate],
        writers: new Map([["dev", true]]),
        issueComments: [...rows(script[0]), ...issueComments],
        reviewComments: rows(script[1]),
      });

    expect(statusFor([]).next_action).toBe("triage");
    const body = await driverRowReply(script);
    expect(body).toBeDefined();
    expect(
      statusFor([{ id: 99, user: "dev", body, created_at: AFTER }]).next_action,
    ).toBe("fix");
  });
});

// A PR whose finding GitHub could not anchor: the summary's state block carries R001 with no comment
// of its own, and the review's comments hold only an unrelated one. extraIssueComments are further
// top-level comments on the PR.
function rowScript(
  extraIssueComments: unknown[] = [],
  summaryHead = HEAD,
  statuses: unknown[] = [],
): ScriptEntry[] {
  const summaryBody = [
    `<!-- pr-hero-report head=${summaryHead} -->`,
    "",
    renderStateBlock(
      summaryHead,
      [
        stateFinding({
          id: "R001",
          sev: "CRITICAL",
          tier: "blocking",
          channel: "outside",
          locs: [`${F001_PATH}:144`],
          claim: F001_CLAIM,
        }),
      ],
      undefined,
      1,
    ),
  ].join("\n");
  const script = greptileCollisionScript({ statuses });
  script[0] = {
    match: ["issues/42/comments", "--paginate"],
    response: {
      stdout: ndjson([
        { id: 5, user: "pr-hero", body: summaryBody },
        ...extraIssueComments,
      ]),
    },
  };
  script[1] = {
    match: ["pulls/42/comments", "--paginate"],
    response: {
      stdout: ndjson([
        {
          id: 11,
          user: "greptile-apps",
          body: "same line, not ours",
          path: F001_PATH,
          line: 144,
          original_line: 144,
          in_reply_to_id: null,
        },
      ]),
    },
  };
  script.push({
    match: ["repo", "view", "--json", "url"],
    response: { stdout: "https://github.com/MusiveTech/musive\n" },
  });
  return script;
}

function rowPosts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (call) =>
      call.argv.includes("--method") &&
      call.argv.join(" ").includes("issues/42/comments"),
  );
}

describe("runTriageReplyCommand — a finding with no comment", () => {
  async function bodyOnly(): Promise<{
    bodyFile: string;
    cleanup: () => Promise<void>;
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-triage-row-"));
    const bodyFile = path.join(dir, "body.md");
    await Bun.write(bodyFile, "Fixed by resetting the latch on unmount.\n");
    return {
      bodyFile,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  test("answers the row with a top-level comment that names it", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh(rowScript());
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const posts = rowPosts(calls);
      expect(posts).toHaveLength(1);
      const stdin = posts[0]?.stdin ?? "";
      expect(stdin.split("\n")[0]).toBe(
        `<!-- crysk-triage tag=applied head=${HEAD} actor=agent row=R001 -->`,
      );
      expect(stdin).toContain(`Finding R001 · \`${F001_PATH}:144\``);
      expect(stdin).toContain("#issuecomment-5");
      expect(stdin).toContain("Fixed by resetting the latch on unmount.");
      expect(
        calls.some(
          (call) =>
            call.argv.includes("--method") &&
            call.argv.join(" ").includes("pulls/42/comments"),
        ),
      ).toBe(false);
      expect(
        calls.some((call) =>
          call.argv.join(" ").includes("resolveReviewThread"),
        ),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("a dismissal carries its verdict before the row", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh(rowScript());
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "dismissed",
        verdict: "upheld",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(rowPosts(calls)[0]?.stdin?.split("\n")[0]).toBe(
        `<!-- crysk-triage tag=dismissed head=${HEAD} actor=agent verdict=upheld row=R001 -->`,
      );
    } finally {
      await cleanup();
    }
  });

  test("a second reply to the same review is skipped", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...rowScript([
          {
            id: 60,
            user: "dev",
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent", row: "R001" })}\n\nearlier`,
          },
        ]),
        permissionEntry("dev", { stdout: "write\n" }),
      ]);
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(rowPosts(calls)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a reply-shaped comment from a login without write access does not block the real reply", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...rowScript([
          {
            id: 60,
            user: "drive-by",
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent", row: "R001" })}\n\nfake`,
          },
        ]),
        permissionEntry("drive-by", { stdout: "read\n" }),
      ]);
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const posts = rowPosts(calls);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.stdin).toContain(`head=${HEAD}`);
    } finally {
      await cleanup();
    }
  });

  test("a permission that does not read stops the command and posts nothing", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        permissionEntry("dev", { stderr: "HTTP 500", exitCode: 1 }),
        ...rowScript([
          {
            id: 60,
            user: "dev",
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent", row: "R001" })}\n\nearlier`,
          },
        ]),
      ]);
      await expect(
        runTriageReplyCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          findingId: "R001",
          tag: "applied",
          bodyFile,
          dryRun: false,
          spawnFn,
          sleepFn: async () => {},
        }),
      ).rejects.toThrow(
        /could not read whether dev has write access[\s\S]*Nothing was changed/,
      );
      expect(
        calls.filter((call) => call.argv.includes("--method")),
      ).toHaveLength(0);
      expect(
        calls.filter((call) =>
          call.argv.join(" ").includes("collaborators/dev/permission"),
        ),
      ).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  test("a permission that reads on the second ask counts", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...rowScript([
          {
            id: 60,
            user: "dev",
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent", row: "R001" })}\n\nearlier`,
          },
        ]),
        {
          match: ["collaborators/dev/permission"],
          responses: [
            { stderr: "HTTP 500", exitCode: 1 },
            { stdout: "write\n" },
          ],
        },
      ]);
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
        sleepFn: async () => {},
      });
      expect(exitCode).toBe(0);
      expect(
        calls.filter((call) => call.argv.includes("--method")),
      ).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("an admin's earlier reply is a repeat", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...rowScript([
          {
            id: 60,
            user: "dev",
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent", row: "R001" })}\n\nearlier`,
          },
        ]),
        permissionEntry("dev", { stdout: "admin\n" }),
      ]);
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(rowPosts(calls)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a reply from an earlier review does not block a new one", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh(
        rowScript([
          {
            id: 60,
            user: "dev",
            body: `${triageMarker({ tag: "applied", headSha: RUN_HEAD, actor: "agent", row: "R001" })}\n\nearlier`,
          },
        ]),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const posts = rowPosts(calls);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.stdin).toContain(`head=${HEAD}`);
    } finally {
      await cleanup();
    }
  });

  test("a reply that names another row does not block this one", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const { spawnFn, calls } = makeFakeGh(
        rowScript([
          {
            id: 60,
            user: "dev",
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent", row: "R002" })}\n\nother row`,
          },
        ]),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(rowPosts(calls)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("an older reply at this head does not block when a newer counted reply names another head", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    try {
      const foreignHead = "e".repeat(40);
      const { spawnFn, calls } = makeFakeGh(
        rowScript(
          [
            {
              id: 60,
              user: "dev",
              created_at: "2026-10-30T11:00:00Z",
              body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent", row: "R001" })}\n\nthis round`,
            },
            {
              id: 61,
              user: "dev",
              created_at: "2026-10-30T11:00:00Z",
              body: `${triageMarker({ tag: "applied", headSha: foreignHead, actor: "agent", row: "R001" })}\n\nlater`,
            },
          ],
          HEAD,
          [redGateStatus("2026-10-30T10:00:00Z")],
        ),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const posts = calls.filter(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("issues/42/comments"),
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]?.stdin).toContain(`head=${HEAD}`);
    } finally {
      await cleanup();
    }
  });

  test("dry run posts nothing and says what it would do", async () => {
    const { bodyFile, cleanup } = await bodyOnly();
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      },
    );
    try {
      const { spawnFn, calls } = makeFakeGh(rowScript());
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        findingId: "R001",
        tag: "applied",
        bodyFile,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(calls.some((call) => call.argv.includes("--method"))).toBe(false);
      expect(written.join("")).toContain("plan: reply to summary row R001");
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });
});

describe("runTriageReplyCommand — a finding posted as a top-level comment", () => {
  const AFTER = "2026-10-30T11:00:00Z";
  const issueFinding = {
    id: 20,
    user: "pr-hero",
    body: `${findingMarker({ path: F001_PATH, line: 144, headSha: HEAD, claim: F001_CLAIM })}\n${F001_CLAIM}`,
  };

  // An old pull request: the finding is top-level comment 20, listed in the summary as an outside row.
  function issueFindingScript(
    issueReplies: unknown[] = [],
    reviewComments: unknown[] = [],
  ): ScriptEntry[] {
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
            channel: "outside",
            locs: [`${F001_PATH}:144`],
            claim: F001_CLAIM,
          }),
        ],
        undefined,
        1,
      ),
    ].join("\n");
    return [
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            { id: 5, user: "pr-hero", body: summaryBody },
            issueFinding,
            ...issueReplies,
          ]),
        },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: { stdout: ndjson(reviewComments) },
      },
      {
        match: ["repo", "view", "--json", "url"],
        response: { stdout: "https://github.com/MusiveTech/musive\n" },
      },
      permissionEntry("dev", { stdout: "write\n" }),
      prViewScript(),
      commitStatusScript(),
    ];
  }

  async function reply(script: ScriptEntry[]): Promise<{
    exitCode: number;
    calls: RecordedCall[];
    written: string;
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-triage-top-"));
    try {
      const bodyFile = path.join(dir, "body.md");
      await Bun.write(bodyFile, "Fixed by resetting the latch on unmount.\n");
      const written: string[] = [];
      const spy = spyOn(process.stderr, "write").mockImplementation(
        (chunk: string | Uint8Array) => {
          written.push(String(chunk));
          return true;
        },
      );
      try {
        const { spawnFn, calls } = makeFakeGh(script);
        const exitCode = await runTriageReplyCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          findingId: "R001",
          tag: "applied",
          bodyFile,
          dryRun: false,
          spawnFn,
        });
        return { exitCode, calls, written: written.join("") };
      } finally {
        spy.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const postsOf = (calls: RecordedCall[]) =>
    calls.filter((call) => call.argv.includes("--method"));

  test("a writer's linked reply to this review is a repeat", async () => {
    const linked = {
      id: 30,
      user: "dev",
      created_at: AFTER,
      body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nfixed\n\nIn reply to: https://github.com/MusiveTech/musive/pull/42#issuecomment-20\n`,
    };
    const { exitCode, calls, written } = await reply(
      issueFindingScript([linked]),
    );
    expect(exitCode).toBe(0);
    expect(postsOf(calls)).toHaveLength(0);
    expect(written).toContain("skip post: R001 already triaged at this head");
  });

  test("a reply in a review thread whose root shares the id is not its reply", async () => {
    const unrelatedRoot = {
      id: 20,
      user: "greptile-apps",
      body: "an unrelated review comment",
      path: F001_PATH,
      line: 144,
      original_line: 144,
      in_reply_to_id: null,
    };
    const threadReply = {
      id: 31,
      user: "dev",
      created_at: AFTER,
      body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nfixed`,
      path: F001_PATH,
      line: 144,
      original_line: 144,
      in_reply_to_id: 20,
    };
    const { exitCode, calls } = await reply(
      issueFindingScript([], [unrelatedRoot, threadReply]),
    );
    expect(exitCode).toBe(0);
    expect(postsOf(calls)).toHaveLength(1);
  });

  test("a stale newer reply does not make the driver post again", async () => {
    // The finding was posted on an older head and is carried; the review's verdict is written after
    // both replies, so the newer one, at the older head, is stale.
    const script = carriedScript(
      [
        {
          id: 11,
          user: "dev",
          in_reply_to_id: 22,
          created_at: "2026-10-30T10:30:00Z",
          body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n\nthis round`,
        },
        {
          id: 12,
          user: "dev",
          in_reply_to_id: 22,
          created_at: "2026-10-30T10:30:00Z",
          body: `${triageMarker({ tag: "applied", headSha: OLD_HEAD, actor: "agent" })}\n\nolder`,
        },
      ],
      {
        commentHead: OLD_HEAD,
        statuses: [redGateStatus("2026-10-30T12:00:00Z")],
      },
    );
    const { exitCode, calls } = await reply(script);
    expect(exitCode).toBe(0);
    expect(postsOf(calls)).toHaveLength(0);
  });
});
