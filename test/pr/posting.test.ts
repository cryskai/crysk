// Offline behavior tests for pr/posting.ts's postFindingsIfEnabled — zero
// direct tests existed before this file (rg over test/ for the name
// returned nothing).
//
// ghRepoWebUrl and postInlineIfEligible already accept an
// invisible-to-production spawnFn of their own (pr.ts's established seam);
// postFindingsIfEnabled just never exposed the option, so it gained one
// spawnFn field threaded to both. writePostReceipt runs for real against a
// temp runDir: the real post.json content, read back off disk, is the
// observable for "did the receipt get written, and with what".
//
// Same fake-gh shape as test/pr/inline-post.test.ts (argv+stdin capture,
// call-counted sequential responses) — duplicated per this repo's
// convention that a test file's own gh fixture is not a shared module.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { postFindingsIfEnabled } from "#pr/posting";
import type { Finding, FindingsDocument, Telemetry } from "#review/findings";

const OPERATOR_ROOT = "/repo";
const HEAD = "b".repeat(40);
const OLD_HEAD = "a".repeat(40);
const PR = 42;

interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}
interface ScriptEntry {
  match: string[];
  response?: ScriptedResponse;
}

function argvContains(argv: string[], tokens: string[]): boolean {
  const joined = argv.join(" ");
  return tokens.every((token) => joined.includes(token));
}

function makeFakeGh(script: ScriptEntry[]): {
  spawnFn: typeof Bun.spawn;
  calls: string[][];
  // The stdin of every call that had one: the summary comment's body travels
  // this way, so a test reads what was posted, not what was rendered.
  stdins: string[];
} {
  const calls: string[][] = [];
  const stdins: string[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let nextId = 100;
  const spawnFn = ((
    argv: string[],
    opts?: { stdin?: Uint8Array; timeout?: number },
  ) => {
    calls.push(argv);
    if (opts?.stdin !== undefined) stdins.push(decoder.decode(opts.stdin));
    const entry = script.find((s) => argvContains(argv, s.match));
    const scripted =
      entry?.response ??
      (argv.includes("--method")
        ? { stdout: JSON.stringify({ id: nextId++ }), exitCode: 0 }
        : { stdout: "", exitCode: 0 });
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
  return { spawnFn, calls, stdins };
}

function headRefOidScript(headSha: string): ScriptEntry {
  return { match: ["headRefOid"], response: { stdout: `${headSha}\n` } };
}

function emptyCommentScript(headSha: string = HEAD): ScriptEntry[] {
  return [
    headRefOidScript(headSha),
    {
      match: [`issues/${PR}/comments`, "--paginate"],
      response: { stdout: "" },
    },
    { match: [`pulls/${PR}/comments`, "--paginate"], response: { stdout: "" } },
  ];
}

function diffAddingLines(filePath: string, count: number): string {
  const body = Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join(
    "\n",
  );
  return (
    `diff --git a/${filePath} b/${filePath}\n` +
    "index 0000000..1111111 100644\n" +
    `--- a/${filePath}\n` +
    `+++ b/${filePath}\n` +
    `@@ -0,0 +1,${count} @@\n${body}\n`
  );
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
  const findings: Finding[] = overrides.findings ?? [];
  return {
    schema_version: "1.0.0",
    pr: PR,
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

async function tmpRunDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pr-hero-posting-"));
}

describe("postFindingsIfEnabled — postEnabled gate", () => {
  test("post disabled: makes no gh call and reports nothing posted", async () => {
    const runDir = await tmpRunDir();
    const result = await postFindingsIfEnabled({
      ciMode: "advisory",
      postEnabled: false,
      sessionFailed: false,
      operatorRoot: OPERATOR_ROOT,
      pr: PR,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 5),
      runDir,
      // No spawnFn: if postEnabled's guard did not short-circuit, this would
      // attempt a real `gh` call and either throw or hit the network.
    });
    expect(result).toEqual({ posted: null, postedWebUrl: undefined });
    await expect(
      readFile(path.join(runDir, "post.json"), "utf8"),
    ).rejects.toThrow();
  });
});

describe("postFindingsIfEnabled — sessionFailed suppression", () => {
  test("session failed: still resolves the repo web url, but posts and records nothing", async () => {
    const runDir = await tmpRunDir();
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["repo", "view", "url"],
        response: { stdout: "https://github.com/acme/widgets\n" },
      },
    ]);
    const result = await postFindingsIfEnabled({
      ciMode: "advisory",
      postEnabled: true,
      sessionFailed: true,
      operatorRoot: OPERATOR_ROOT,
      pr: PR,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 5),
      runDir,
      spawnFn,
    });
    expect(result).toEqual({
      posted: null,
      postedWebUrl: "https://github.com/acme/widgets",
    });
    expect(calls.some((c) => argvContains(c, ["repo", "view"]))).toBe(true);
    expect(calls.some((c) => argvContains(c, ["issues", "comments"]))).toBe(
      false,
    );
    await expect(
      readFile(path.join(runDir, "post.json"), "utf8"),
    ).rejects.toThrow();
  });
});

describe("postFindingsIfEnabled — repo web url resolution", () => {
  test("an unresolvable repo web url posts with undefined webUrl, plain locations", async () => {
    const runDir = await tmpRunDir();
    const { spawnFn } = makeFakeGh([
      { match: ["repo", "view", "url"], response: { exitCode: 1 } },
      ...emptyCommentScript(),
    ]);
    const result = await postFindingsIfEnabled({
      ciMode: "advisory",
      postEnabled: true,
      sessionFailed: false,
      operatorRoot: OPERATOR_ROOT,
      pr: PR,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 5),
      runDir,
      spawnFn,
    });
    expect(result.postedWebUrl).toBeUndefined();
    expect(result.posted).not.toBeNull();
  });
});

describe("postFindingsIfEnabled — real posting writes the post.json receipt", () => {
  test("a clean run posts and records the exact outcome to post.json", async () => {
    const runDir = await tmpRunDir();
    const { spawnFn } = makeFakeGh([
      {
        match: ["repo", "view", "url"],
        response: { stdout: "https://github.com/acme/widgets\n" },
      },
      ...emptyCommentScript(),
    ]);
    const result = await postFindingsIfEnabled({
      ciMode: "advisory",
      postEnabled: true,
      sessionFailed: false,
      operatorRoot: OPERATOR_ROOT,
      pr: PR,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 5),
      runDir,
      spawnFn,
    });
    expect(result.posted).not.toBeNull();
    expect(result.postedWebUrl).toBe("https://github.com/acme/widgets");
    const receipt = JSON.parse(
      await readFile(path.join(runDir, "post.json"), "utf8"),
    );
    expect(receipt.pr).toBe(PR);
    expect(receipt.head_sha).toBe(HEAD);
    expect(receipt.review.outcome).toBe(result.posted?.reviewOutcome);
    expect(receipt.review.finding_count).toBe(
      result.posted?.reviewFindingCount,
    );
    expect(receipt.issue_comment_ids).toEqual(result.posted?.issueCommentIds);
    expect(receipt.summary_comment).toEqual(result.posted?.summary);
    expect(receipt.dropped_finding_ids).toEqual(
      result.posted?.droppedFindingIds,
    );
  });
});

// WHY onDelivered (F002 on #330): the delivery point is the POST's resolution,
// not the receipt write after it. A caller that records "delivered" must learn
// of the POST the moment it lands, so a failed receipt write cannot be read as
// a failed delivery.
describe("postFindingsIfEnabled — onDelivered at the delivery point", () => {
  function cleanRunScripts(): ScriptEntry[] {
    return [
      {
        match: ["repo", "view", "url"],
        response: { stdout: "https://github.com/acme/widgets\n" },
      },
      ...emptyCommentScript(),
    ];
  }

  test("a successful POST calls onDelivered once, before the receipt is written", async () => {
    const runDir = await tmpRunDir();
    const { spawnFn } = makeFakeGh(cleanRunScripts());
    let calls = 0;
    let receiptAtDelivery: boolean | undefined;
    const result = await postFindingsIfEnabled({
      ciMode: "advisory",
      postEnabled: true,
      sessionFailed: false,
      operatorRoot: OPERATOR_ROOT,
      pr: PR,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 5),
      runDir,
      spawnFn,
      onDelivered: () => {
        calls += 1;
        receiptAtDelivery = existsSync(path.join(runDir, "post.json"));
      },
    });
    expect(result.posted).not.toBeNull();
    expect(calls).toBe(1);
    expect(receiptAtDelivery).toBe(false);
    expect(existsSync(path.join(runDir, "post.json"))).toBe(true);
  });

  test("a receipt write that throws after the POST still reached onDelivered first, and the throw propagates", async () => {
    const runDir = await tmpRunDir();
    // A directory where post.json goes: the receipt write itself throws.
    await mkdir(path.join(runDir, "post.json"));
    const { spawnFn } = makeFakeGh(cleanRunScripts());
    let calls = 0;
    await expect(
      postFindingsIfEnabled({
        ciMode: "advisory",
        postEnabled: true,
        sessionFailed: false,
        operatorRoot: OPERATOR_ROOT,
        pr: PR,
        headSha: HEAD,
        doc: doc({ findings: [] }),
        diffPatch: diffAddingLines("src/app.ts", 5),
        runDir,
        spawnFn,
        onDelivered: () => {
          calls += 1;
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("a POST that rejects never calls onDelivered", async () => {
    const runDir = await tmpRunDir();
    const { spawnFn } = makeFakeGh([
      ...cleanRunScripts(),
      {
        match: [`issues/${PR}/comments`, "--method"],
        response: { stderr: "gh: HTTP 502", exitCode: 1 },
      },
    ]);
    let calls = 0;
    await expect(
      postFindingsIfEnabled({
        ciMode: "advisory",
        postEnabled: true,
        sessionFailed: false,
        operatorRoot: OPERATOR_ROOT,
        pr: PR,
        headSha: HEAD,
        doc: doc({ findings: [] }),
        diffPatch: diffAddingLines("src/app.ts", 5),
        runDir,
        spawnFn,
        onDelivered: () => {
          calls += 1;
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("a failed session never calls onDelivered, and posts nothing", async () => {
    const runDir = await tmpRunDir();
    const { spawnFn } = makeFakeGh(cleanRunScripts());
    let calls = 0;
    const result = await postFindingsIfEnabled({
      ciMode: "advisory",
      postEnabled: true,
      sessionFailed: true,
      operatorRoot: OPERATOR_ROOT,
      pr: PR,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 5),
      runDir,
      spawnFn,
      onDelivered: () => {
        calls += 1;
      },
    });
    expect(result.posted).toBeNull();
    expect(calls).toBe(0);
  });

  test("posting off never calls onDelivered", async () => {
    const runDir = await tmpRunDir();
    let calls = 0;
    const result = await postFindingsIfEnabled({
      ciMode: "advisory",
      postEnabled: false,
      sessionFailed: false,
      operatorRoot: OPERATOR_ROOT,
      pr: PR,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: "",
      runDir,
      onDelivered: () => {
        calls += 1;
      },
    });
    expect(result.posted).toBeNull();
    expect(calls).toBe(0);
  });
});

// S4, PR comment chain: publish-outcome -> postFindingsIfEnabled -> the
// summary comment -> renderPrComment. Each run's mode reaches the comment
// body it posts; an advisory run keeps today's disclaimer.
describe("postFindingsIfEnabled — the CI gate mode reaches the PR comment (S4)", () => {
  async function postedSummary(ciMode: "gate" | "advisory"): Promise<string> {
    const runDir = await tmpRunDir();
    const { spawnFn, stdins } = makeFakeGh([
      {
        match: ["repo", "view", "url"],
        response: { stdout: "https://github.com/acme/widgets\n" },
      },
      ...emptyCommentScript(),
    ]);
    await postFindingsIfEnabled({
      postEnabled: true,
      sessionFailed: false,
      operatorRoot: OPERATOR_ROOT,
      pr: PR,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 5),
      runDir,
      spawnFn,
      ciMode,
    });
    return stdins.find((body) => body.startsWith("<!-- pr-hero-report ")) ?? "";
  }

  test("a gate run's summary comment backs the required status, and never disclaims a merge gate", async () => {
    const summary = await postedSummary("gate");
    expect(summary).toContain(
      "Assistant report backing the pr-hero commit status, the required check in gate mode: every line above is a claim to verify.",
    );
    expect(summary).not.toContain("not a merge gate");
  });

  test("an advisory run's summary comment keeps today's disclaimer", async () => {
    const summary = await postedSummary("advisory");
    expect(summary).toContain(
      "Assistant report, not a merge gate: every line above is a claim to verify.",
    );
  });
});
