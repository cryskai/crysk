import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTriageReplyCommand, triageCommand } from "#commands/triage";
import { findingMarker } from "#pr/preflight";
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
  cost_usd_est: 1,
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
  ];
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
