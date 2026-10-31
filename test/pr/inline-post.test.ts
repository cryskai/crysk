// Offline tests for pr/pr.ts's postInlineFindings/postInlineIfEligible
// orchestration and pr/inline.ts's postingExitCode/computeDroppedFindingIds
// (cli-decomp S2, Cluster C). Moved out of test/cli.test.ts, which tested
// this exact layer before it was extracted from cli.ts: PR2 verification
// (#3296) flagged the caller-wiring layer as load-bearing and missing --
// pr/pr.ts's primitives (postPrReview, postIssueComment, postPrComment) are
// individually correct and individually tested, but nothing proved the
// CALLER wires them the way design D6 requires -- ordering, the
// `sessionFailed` guard, and the exit-1 rule.
//
// Same fake-gh pattern as test/pr/pr.test.ts, extended to capture stdin
// (needed to tell a leftover W1 finding issue comment from the summary
// comment -- both hit the same `issues/<pr>/comments` endpoint). Duplicated
// rather than imported from test/pr/pr.test.ts or test/cli.test.ts: a TEST
// file's own fixtures are not a shared module, and importing them across
// suites is the kind of coupling that breaks one suite when the other's
// fixture shape changes for unrelated reasons (test/cli.test.ts's own
// header made the same call before this move).

import { describe, expect, test } from "bun:test";
import { parseCiAdmissionBlock, stateReviewCount } from "#ci/review-admission";
import type { PrHeroFindingRef } from "#compare/compare";
import {
  computeDroppedFindingIds,
  type InlinePostOutcome,
  postingExitCode,
} from "#pr/inline";
import {
  POSTING_GH_TIMEOUT_MS,
  postInlineFindings,
  postInlineIfEligible,
} from "#pr/pr";
import {
  claimFingerprint,
  findingMarker,
  PR_FINDING_MARKER_PREFIX,
  PR_REREVIEW_CLOSED_MARKER_PREFIX,
} from "#pr/preflight";
import { classifyPrior } from "#rereview/classify";
import {
  priorsFromStateFindings,
  type RereviewProvenance,
} from "#rereview/prepare";
import {
  assembleLive,
  type LiveFinding,
  parseStateBlock,
  stateFinding,
  unresolvedBlockingCount,
} from "#rereview/state";
import type { Finding, FindingsDocument, Telemetry } from "#review/findings";

// ---------------------------------------------------------------------------
// FakeGh: records every call's argv AND stdin (decoded), in order. Routes
// responses by argv predicate, same shape as test/pr/pr.test.ts's makeFakeGh —
// duplicated rather than imported: pr/pr.ts's test harness is a TEST file, and
// importing test fixtures across test files is the kind of coupling that
// breaks one suite when the other's fixture shape changes for unrelated
// reasons.

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
  // The bound the call carries (Bun.spawn's `timeout`, set by gh()). Optional
  // so the hand-built records in older fixtures stay valid.
  timeout?: number;
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
  const spawnFn = ((
    argv: string[],
    opts?: { stdin?: Uint8Array; timeout?: number },
  ) => {
    const stdin =
      opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin);
    calls.push({ argv, stdin, timeout: opts?.timeout });
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

// Empty issue/review comment streams — the common "nothing posted yet"
// baseline every scripted PR extends.
//
// GitHub #39: the head re-read joins the baseline, answering with the head
// the caller says it reviewed, because "the PR did not move" is the ordinary
// state every one of these tests is about. Entry order matters — `script.find`
// takes the FIRST match, and `headRefOid` is specific enough that no other
// entry can swallow it, but a broad `["pr", "view"]` entry added later would,
// so this one goes first.
function headRefOidScript(headSha: string): ScriptEntry {
  return { match: ["headRefOid"], response: { stdout: `${headSha}\n` } };
}

function emptyCommentScript(headSha: string = HEAD): ScriptEntry[] {
  return [
    headRefOidScript(headSha),
    { match: ["issues/42/comments", "--paginate"], response: { stdout: "" } },
    { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
  ];
}

const OPERATOR_ROOT = "/repo";
const HEAD = "b".repeat(40);
const OLD_HEAD = "a".repeat(40);

function diffAddingLines(path: string, count: number): string {
  const body = Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join(
    "\n",
  );
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${count} @@\n` +
    `${body}\n`
  );
}

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

function findingIssueCommentPosts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (c) =>
      c.argv.join(" ").includes("issues/42/comments") &&
      c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
  );
}

function summaryStdins(calls: RecordedCall[]): string[] {
  return calls
    .filter((c) => c.stdin?.startsWith("<!-- crysk-report "))
    .map((c) => c.stdin ?? "");
}

describe("postInlineFindings — step-14 ordering", () => {
  // Design rework (Juanma's PR #2 feedback item 2): the summary is CREATED
  // FIRST — before any finding is posted — so its position in the
  // Conversation timeline is fixed early, then PATCHED again LAST with the
  // final delta and comment links. Creation is a POST to
  // `issues/<pr>/comments`; the closing PATCH targets
  // `issues/comments/<id>` — two distinct endpoints, so the test tells them
  // apart by argv shape, not just by stdin prefix (both carry the same
  // marker prefix).
  test("summary created first, then review, then the summary PATCHed last", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }), // anchorable
      finding({ id: "F002", path: "src/b.ts", line: 999 }), // un-anchorable
    ];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(1);
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);

    const createIndex = calls.findIndex(
      (c) =>
        c.argv.join(" ").includes("POST") &&
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith("<!-- crysk-report "),
    );
    const reviewIndex = calls.findIndex((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    const patchIndex = calls.findIndex(
      (c) =>
        c.argv.join(" ").includes("PATCH") &&
        c.argv.join(" ").includes("issues/comments/") &&
        c.stdin?.startsWith("<!-- crysk-report "),
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    // The summary create is the FIRST mutating (POST/PATCH) call this run
    // makes — every call before it is a read-only fetch (resolving the
    // plan), never another write.
    const firstMutatingIndex = calls.findIndex(
      (c) => c.argv.includes("POST") || c.argv.includes("PATCH"),
    );
    expect(createIndex).toBe(firstMutatingIndex);
    expect(reviewIndex).toBeGreaterThan(createIndex);
    expect(patchIndex).toBeGreaterThan(reviewIndex);
    // The summary PATCH is the very LAST call this run makes. No finding
    // issue-comment POSTs sit between review and PATCH (issues #16/#17).
    expect(patchIndex).toBe(calls.length - 1);
    const createBody = calls[createIndex]?.stdin ?? "";
    const patchBody = calls[patchIndex]?.stdin ?? "";
    expect(createBody).toContain("### Comments Outside Diff (1)");
    expect(createBody).toContain("src/b.ts");
    expect(patchBody).toContain("### Comments Outside Diff (1)");
    expect(patchBody).toContain("src/b.ts");
  });

  // GitHub #39, the sequence half. The pin (pr/pr.ts) makes the comments
  // correct; these pin the DISCLOSURE — that a head which moved under the
  // run is said out loud on the PR and handed back to the caller, instead of
  // the run publishing as though nothing happened.
  const MOVED_HEAD = "e".repeat(40);

  test("a moved head is disclosed in the closing summary and on the outcome", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(MOVED_HEAD),
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.movedHeadSha).toBe(MOVED_HEAD);
    // Posted, pinned, disclosed — never aborted and never filtered. What a
    // re-review should DO about findings computed on a stale head is ROADMAP
    // item 7's design work; dropping the post here would be the invisible
    // loss the direction-of-error rule ranks worst.
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(1);
    const patch = calls
      .filter(
        (c) =>
          c.argv.join(" ").includes("PATCH") &&
          c.stdin?.startsWith("<!-- crysk-report "),
      )
      .at(-1);
    expect(patch?.stdin).toContain("⚠️ **The PR moved while this review ran.**");
    expect(patch?.stdin).toContain(`the PR head is now \`${MOVED_HEAD}\``);
    // The placeholder create predates the re-read on purpose (it is the
    // FIRST write of the run, and the check belongs next to the
    // anchor-bearing call); the closing PATCH is the authoritative body.
    const create = calls.find(
      (c) =>
        c.argv.join(" ").includes("POST") &&
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith("<!-- crysk-report "),
    );
    expect(create?.stdin).not.toContain("The PR moved");
  });

  test("the head is re-read BEFORE the review submission, not after it", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(MOVED_HEAD),
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    const readIndex = calls.findIndex((c) => c.argv.includes("headRefOid"));
    const reviewIndex = calls.findIndex((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    expect(readIndex).toBeGreaterThanOrEqual(0);
    // The window is the whole point: a check run earlier answers a question
    // about a different moment.
    expect(readIndex).toBe(reviewIndex - 1);
  });

  // The reason the re-read lives in the sequence owner and not inside
  // postPrReview: postPrReview returns early on zero anchorable findings
  // without touching gh, and a run with nothing to anchor STILL publishes a
  // summary — the ✅ clean bill included.
  test("a run with nothing to anchor still re-reads the head and still discloses", async () => {
    const findings = [finding({ id: "F001", path: "src/never.ts", line: 1 })];
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(MOVED_HEAD),
      ...emptyCommentScript(),
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
    expect(calls.some((c) => c.argv.includes("headRefOid"))).toBe(true);
    expect(outcome.movedHeadSha).toBe(MOVED_HEAD);
    expect(summaryStdins(calls).at(-1)).toContain(
      "⚠️ **The PR moved while this review ran.**",
    );
  });

  test("an unmoved head says nothing, and the submission still pins the reviewed head", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.movedHeadSha).toBeUndefined();
    expect(summaryStdins(calls).every((b) => !b.includes("The PR moved"))).toBe(
      true,
    );
    const submission = calls.find((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    expect(JSON.parse(submission?.stdin ?? "{}").commit_id).toBe(HEAD);
  });

  // The pin is the correctness mechanism; the re-read is only the
  // disclosure. A disclosure that cannot be made must not cost the post the
  // pin already protects — so a failed re-read publishes exactly the
  // unmoved body, and the run neither throws nor invents a mismatch.
  test("a re-read that fails posts anyway, claiming nothing about the head", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["headRefOid"],
        response: { stderr: "gh: rate limited (HTTP 403)", exitCode: 1 },
      },
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.movedHeadSha).toBeUndefined();
    expect(outcome.reviewOutcome).toBe("posted");
    expect(summaryStdins(calls).every((b) => !b.includes("The PR moved"))).toBe(
      true,
    );
  });

  // Acceptance criterion 4, at the sequence level: pinning must not turn a
  // recoverable demotion into a hard failure. A force-push does BOTH — it
  // moves the head AND rewrites the reviewed commit out of the PR, so the
  // pinned submission 422s. The findings must still land, in the summary's
  // Outside Diff bucket, alongside the moved-head notice.
  test("a moved head plus a 422 still demotes into the Outside Diff bucket", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(MOVED_HEAD),
      ...emptyCommentScript(),
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(outcome.outsideDiffCount).toBe(1);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.movedHeadSha).toBe(MOVED_HEAD);
    const patch = summaryStdins(calls).at(-1) ?? "";
    expect(patch).toContain("### Comments Outside Diff (1)");
    expect(patch).toContain("⚠️ **The PR moved while this review ran.**");
  });

  test("zero anchorable findings never reaches the reviews endpoint at all", async () => {
    const findings = [finding({ id: "F001", path: "src/never.ts", line: 1 })];
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      // "src/never.ts" is not in the diff at all — un-anchorable.
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const bodies = summaryStdins(calls);
    expect(bodies.length).toBeGreaterThan(0);
    expect(
      bodies.every((b) => b.includes("### Comments Outside Diff (1)")),
    ).toBe(true);
    expect(bodies.some((b) => b.includes("src/never.ts"))).toBe(true);
  });

  // W2 (issues #16/#17): un-anchorable findings pool into ONE summary
  // Comments Outside Diff section, never as standalone issue comments.
  // The prior suite pinned R4's "exactly one issue comment each"; that
  // channel is retired. Two un-anchorable findings, both in the summary
  // bucket, zero finding-marker POSTs, closes the new contract.
  test("two un-anchorable findings post in the summary Outside Diff section, never as issue comments", async () => {
    const findings = [
      finding({ id: "F001", path: "src/never-a.ts", line: 1 }),
      finding({ id: "F002", path: "src/never-b.ts", line: 1 }),
    ];
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      // Neither path is in the diff at all — both un-anchorable.
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(2);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const bodies = summaryStdins(calls);
    expect(bodies.length).toBe(2); // create + PATCH
    for (const body of bodies) {
      expect(body).toContain("### Comments Outside Diff (2)");
      expect(body).toContain("src/never-a.ts");
      expect(body).toContain("src/never-b.ts");
      expect(body).toContain(
        "the value is stored in seconds and read as milliseconds",
      );
    }
  });

  test("an off-hunk finding re-anchors to a hunter-cited in-diff proof_ref instead of Outside Diff (Musive #1727)", async () => {
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 544,
        proof_refs: ["src/a.ts:544", "src/a.ts:10 (the retry that causes it)"],
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(1);
    expect(outcome.outsideDiffCount).toBe(0);
    expect(outcome.issueCommentIds).toEqual([]);
    const review = calls.find((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    const body = JSON.parse(review?.stdin ?? "null") as {
      comments: { line: number; body: string }[];
    };
    expect(body.comments[0]?.line).toBe(10);
    expect(body.comments[0]?.body).toContain("line=10");
    // The summary still names the finding's original location — the claim
    // is about 544; only the GitHub anchor moved.
    const summaries = summaryStdins(calls);
    expect(summaries.some((s) => s.includes("src/a.ts:544"))).toBe(true);
    expect(summaries.every((s) => !s.includes("Comments Outside Diff"))).toBe(
      true,
    );
  });
});

describe("postInlineFindings — post_min_severity", () => {
  // The floor is a posting filter: a finding below it gets no inline comment
  // and no Outside Diff entry, and the summary counts it in one line. Its
  // absence from droppedFindingIds is the point: it was held back, not lost.
  test("findings below the floor are never posted and are counted in the summary", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({
        id: "F002",
        path: "src/a.ts",
        line: 12,
        severity: "WARNING",
        tier: "advisory",
      }),
      finding({
        id: "F003",
        path: "src/never.ts",
        line: 1,
        severity: "SUGGESTION",
        tier: "advisory",
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      postMinSeverity: "blocking",
    });
    expect(outcome.reviewFindingCount).toBe(1);
    expect(outcome.outsideDiffCount).toBe(0);
    expect(outcome.droppedFindingIds).toEqual([]);
    const review = calls.find((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    expect(review?.stdin).toContain("line=10 ");
    expect(review?.stdin).not.toContain("line=12 ");
    const bodies = summaryStdins(calls);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toContain(
        "2 advisory findings not posted (`post_min_severity: blocking`).",
      );
      expect(body).not.toContain("src/never.ts");
      expect(body).not.toContain("Comments Outside Diff");
      // Admission scores what was posted, so a hidden finding never spends a
      // re-review. The state block already holds posted rows only; the
      // admission block must agree with it.
      const admission = parseCiAdmissionBlock(body);
      expect(admission?.blocking).toBe(1);
      expect(admission?.advisory).toBe(0);
    }
  });

  test("without a floor every finding posts, as before", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({
        id: "F002",
        path: "src/a.ts",
        line: 12,
        severity: "SUGGESTION",
        tier: "advisory",
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewFindingCount).toBe(2);
    expect(summaryStdins(calls).some((b) => b.includes("not posted"))).toBe(
      false,
    );
  });
});

describe("postInlineFindings — the 422 recovery never drops a finding", () => {
  // Mirrors verify-report-pr2 (#3296)'s CRIT-1 repro at THIS composition
  // layer: a prior comment already claimed by a PERSISTING finding must not
  // become available to swallow a DIFFERENT, genuinely fresh finding during
  // the 422 recovery. Proven by mutation (Method, per the brief): with
  // `allFindings` narrowed back to just the review-submission subset
  // (`reviewFindings`) in postInlineFindings, this test's assertion on
  // `droppedFindingIds` / F002 in the summary Outside Diff fails (F002
  // disappears from both channels); reverted after observing the failure.
  test("a claimed comment does not swallow a fresh finding on 422", async () => {
    const claimedMarker = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD,
      claim: "F001's claim",
    });
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 100 }), // persists to P
      finding({ id: "F002", path: "src/a.ts", line: 103 }), // fresh, near P
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 7,
              user: "pr-hero",
              body: `${claimedMarker}\nclaim`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    // F001 already had a home (comment 7); F002 must surface in the
    // summary Outside Diff bucket — never dropped, never an issue comment.
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const patchBody =
      calls.find(
        (c) =>
          c.argv.join(" ").includes("PATCH") &&
          c.stdin?.startsWith("<!-- crysk-report "),
      )?.stdin ?? "";
    expect(patchBody).toContain("### Comments Outside Diff (1)");
    expect(patchBody).toContain("`src/a.ts:103`");
    expect(patchBody).toContain(
      "the value is stored in seconds and read as milliseconds",
    );
  });

  // CRIT-A (verify-report-pr3, #3305) — the verifier's exact tie-dissolution
  // repro, driven through the FULL composition (resolveInlinePostPlan →
  // postPrReview's 422 recovery), not just the pr/pr.ts unit. Prior comments R1
  // @ line 100 and R2 @ line 104 sit equidistant (2, 2) from F001 @ line
  // 102 — a genuine ambiguous tie the ORIGINAL plan resolves by posting F001
  // fresh, per spec "Ambiguous matches post as new, never a forced match".
  // F002 @ line 104 exactly claims R2 and persists. The failure this guards:
  // narrowing the 422 recovery's re-match to just the review submission's
  // own subset ([F001]) drops R2 from the candidate set (it is "claimed" by
  // F002), leaving R1 as F001's SOLE remaining candidate — dissolving the
  // tie and silently swallowing F001 into neither channel. Property under
  // test: no finding reaches neither channel, for this arrangement too, not
  // only the CRIT-1 arrangement above.
  test("a tie the plan resolved to post-fresh survives the 422 recovery, even though a sibling finding persists to the OTHER tied candidate (CRIT-A)", async () => {
    const r1 = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD,
      claim: "prior claim one",
    });
    const r2 = findingMarker({
      path: "src/a.ts",
      line: 104,
      headSha: OLD_HEAD,
      claim: "prior claim two",
    });
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 102,
        claim: "a genuinely new finding, tied between R1 and R2",
      }),
      finding({
        id: "F002",
        path: "src/a.ts",
        line: 104,
        claim: "exactly claims the prior comment at line 104",
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 101,
              user: "pr-hero",
              body: `${r1}\nprior claim one`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
            {
              id: 102,
              user: "pr-hero",
              body: `${r2}\nprior claim two`,
              path: "src/a.ts",
              line: 104,
              original_line: 104,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    // F001 must still reach a channel — never dropped because R2 (F002's
    // match) briefly looked like its sole remaining tie candidate.
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const patchBody =
      calls.find(
        (c) =>
          c.argv.join(" ").includes("PATCH") &&
          c.stdin?.startsWith("<!-- crysk-report "),
      )?.stdin ?? "";
    expect(patchBody).toContain("### Comments Outside Diff (1)");
    expect(patchBody).toContain("`src/a.ts:102`");
    expect(patchBody).toContain(
      "a genuinely new finding, tied between R1 and R2",
    );
  });
});

// The rematch-before-issue-comment-POST (live PR #4, comment 3767088276)
// existed only to prevent duplicate finding issue comments. W2 retires that
// POST, so the rematch is gone too — identity for the Outside Diff bucket
// is the next slice. These tests pin the retirement: zero finding issue
// comments, and a workless persist run still pays for no extra gh call.
describe("postInlineFindings — no finding issue-comment POST (issues #16/#17)", () => {
  test("a leftover concurrent issue comment does not recreate a finding issue comment; the finding reaches Outside Diff", async () => {
    const findings = [
      finding({
        id: "F001",
        path: "src/never.ts", // not in the diff — un-anchorable
        line: 1,
        claim: "an un-anchorable finding",
      }),
    ];
    // An existing SUMMARY comment is scripted so `postPrComment`'s own
    // internal existing-comment check doesn't add a THIRD indistinguishable
    // read. The concurrent leftover issue comment from another process is
    // NOT re-fetched this slice (rematch retired); the finding still lands
    // in the summary Outside Diff and is not dropped.
    const summaryMarker = `<!-- pr-hero-report head=${HEAD} -->`;
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        responses: [
          {
            stdout: ndjson([
              {
                id: 200,
                user: "pr-hero",
                body: `${summaryMarker}\nsummary body`,
              },
            ]),
          }, // 1st fetch (resolveInlinePostPlan's own existingSummaryId read)
          { stdout: "" }, // 2nd fetch (fetchPostedFindingComments, same plan snapshot)
        ],
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const issueGetCalls = calls.filter(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.argv.join(" ").includes("--paginate"),
    );
    expect(issueGetCalls.length).toBe(2);
    const patchBody =
      calls.find(
        (c) =>
          c.argv.join(" ").includes("PATCH") &&
          c.stdin?.startsWith("<!-- crysk-report "),
      )?.stdin ?? "";
    expect(patchBody).toContain("### Comments Outside Diff (1)");
    expect(patchBody).toContain("an un-anchorable finding");
  });

  test("nothing to post skips the re-fetch entirely — a workless run pays for no extra gh call", async () => {
    // Anchorable finding, already persisting from a prior run — the plan has
    // NOTHING to post in either channel. An existing summary comment is
    // scripted too, so `postPrComment`'s own internal existing-comment check
    // never fires either (it PATCHes the known summary id directly) — the
    // ONLY "issues/42/comments" reads in a fully-idempotent run are the two
    // the plan snapshot itself makes.
    const summaryMarker = `<!-- pr-hero-report head=${OLD_HEAD} -->`;
    const marker = findingMarker({
      path: "src/a.ts",
      line: 10,
      headSha: HEAD,
      claim: "unchanged claim",
    });
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 10,
        claim: "unchanged claim",
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 200,
              user: "pr-hero",
              body: `${summaryMarker}\nsummary body`,
            },
          ]),
        },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 9,
              user: "pr-hero",
              body: `${marker}\nunchanged claim`,
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.issueCommentIds.length).toBe(0);
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.droppedFindingIds).toEqual([]);
    // Exactly TWO reads of the issue endpoint (existingSummaryId + the
    // plan's own posted-comments read) — no rematch re-fetch (retired with
    // the issue-comment POST).
    const issueGetCalls = calls.filter(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.argv.join(" ").includes("--paginate"),
    );
    expect(issueGetCalls.length).toBe(2);
    const reviewGetCalls = calls.filter(
      (c) =>
        c.argv.join(" ").includes("pulls/42/comments") &&
        c.argv.join(" ").includes("--paginate"),
    );
    expect(reviewGetCalls.length).toBe(1);
  });
});

describe("postInlineFindings — idempotency, same head, drifted live line", () => {
  // Spec "Idempotency across two runs on the same head" + PR1's verify-report
  // §9 note: exercise a same-head case where liveLine != marker.line. GitHub
  // re-anchors a review comment's live `line` whenever the diff changes
  // (e.g. the base moved), even with no new push to THIS head — the
  // same-head match must key on the MARKER's stored line, not the drifted
  // live one, or an unmoved finding reposts.
  test("same head, live line drifted from the marker's stored line: zero reposts", async () => {
    const marker = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: HEAD, // SAME head as this run
      claim: "unchanged claim",
    });
    // F002 fix: the exact same-head branch now consults the claim
    // fingerprint too, so this genuinely idempotent case needs the
    // finding's claim to match what the marker was posted with — an
    // UNCHANGED claim, as the describe block's name promises.
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 100,
        claim: "unchanged claim",
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 7,
              user: "pr-hero",
              body: `${marker}\nunchanged claim`,
              path: "src/a.ts",
              // Drifted live line (base advanced, no new push) — 12 away
              // from the marker's stored 100, well outside the ±5 window.
              line: 112,
              original_line: 112,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewFindingCount).toBe(0); // matched, not fresh
    expect(outcome.issueCommentIds.length).toBe(0);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.delta).toEqual({ resolved: 0, new: 0, persist: 1 });
    // No POST to pulls/42/reviews and no per-finding issue comment — the
    // ONLY mutating call is the summary PATCH/POST.
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
    expect(
      calls.filter(
        (c) =>
          c.argv.join(" ").includes("issues/42/comments") &&
          c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
      ).length,
    ).toBe(0);
  });
});

// Incremental re-review: a finding the PREVIOUS head already posted inline
// is carried into this run. Its line sits outside the push delta but inside
// the full PR diff, which is what posting now receives as diffPatch. It must
// match the existing thread, not be posted a second time.
describe("postInlineFindings — carried finding already posted inline (incremental)", () => {
  test("a carried finding in the full PR diff matches its existing thread: no second review comment", async () => {
    const marker = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD, // posted by the previous review, before the push
      claim: "carried claim",
    });
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 100,
        claim: "carried claim",
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 9,
              user: "pr-hero",
              body: `${marker}\ncarried claim`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
  });
});

// Juanma's PR #2 feedback: the summary's index links each line to its own
// comment. Three sources feed `buildCommentUrlMap` (cli.ts) and none are
// exercised by makeFakeGh's STATELESS script — a persisting match's url
// needs no extra fetch, but a FRESHLY posted review comment's url needs a
// re-fetch to see what THIS run just posted, which a stateless fixture
// cannot simulate. This test uses a bespoke, call-counting fake instead.
describe("postInlineFindings — comment url map reaches the summary's index", () => {
  test("persisting, freshly-issued, and freshly-reviewed findings all resolve to a comment url", async () => {
    const WEB_URL = "https://github.com/musivetech/musive";
    const priorMarker = findingMarker({
      path: "src/a.ts",
      line: 10,
      headSha: OLD_HEAD,
      claim: "unchanged claim",
    });
    const findings = [
      // Persists — matched to comment id 7 from a prior run.
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 10,
        claim: "unchanged claim",
      }),
      // Fresh, anchorable — goes into the review submission.
      finding({
        id: "F002",
        path: "src/a.ts",
        line: 20,
        claim: "a fresh anchorable finding",
      }),
      // Fresh, un-anchorable — goes into the summary Outside Diff section.
      finding({
        id: "F003",
        path: "src/never.ts",
        line: 1,
        claim: "a fresh un-anchorable finding",
      }),
    ];
    let pullsCommentsCalls = 0;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const calls: RecordedCall[] = [];
    let nextId = 200;
    const respond = (stdout: string, exitCode = 0) => {
      const stream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (text) controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
      return {
        stdout: stream(stdout),
        stderr: stream(""),
        exited: Promise.resolve(exitCode),
        kill() {},
      };
    };
    const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
      const stdin =
        opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin);
      calls.push({ argv, stdin });
      const joined = argv.join(" ");
      if (
        joined.includes("issues/42/comments") &&
        joined.includes("--paginate")
      ) {
        return respond("");
      }
      if (
        joined.includes("pulls/42/comments") &&
        joined.includes("--paginate")
      ) {
        pullsCommentsCalls += 1;
        const rows: unknown[] = [
          {
            id: 7,
            user: "pr-hero",
            body: `${priorMarker}\nunchanged claim`,
            path: "src/a.ts",
            line: 10,
            original_line: 10,
            in_reply_to_id: null,
          },
        ];
        // Only the SECOND+ fetch (the re-fetch after the review posted)
        // sees F002's own comment — simulating "this run just created it".
        if (pullsCommentsCalls > 1) {
          const freshMarker = findingMarker({
            path: "src/a.ts",
            line: 20,
            headSha: HEAD,
            claim: "a fresh anchorable finding",
          });
          rows.push({
            id: 55,
            user: "pr-hero",
            body: `${freshMarker}\nfresh`,
            path: "src/a.ts",
            line: 20,
            original_line: 20,
            in_reply_to_id: null,
          });
        }
        return respond(ndjson(rows));
      }
      if (joined.includes("pulls/42/reviews")) {
        return respond("");
      }
      return respond(JSON.stringify({ id: nextId++ }));
    }) as unknown as typeof Bun.spawn;

    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 30),
      webUrl: WEB_URL,
      spawnFn,
    });

    expect(outcome.reviewFindingCount).toBe(1); // F002
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1); // F003
    expect(outcome.droppedFindingIds).toEqual([]);

    const patchCall = calls.find(
      (c) =>
        c.argv.join(" ").includes("PATCH") &&
        c.stdin?.startsWith("<!-- crysk-report "),
    );
    // F001, persisting, linked from plan.persisting with no extra fetch.
    expect(patchCall?.stdin).toContain(`${WEB_URL}/pull/42#discussion_r7`);
    // F002, freshly posted to the review, linked via the post-posting
    // re-fetch + marker match.
    expect(patchCall?.stdin).toContain(`${WEB_URL}/pull/42#discussion_r55`);
    // F003 has no per-finding comment — unlinked in the index, full body
    // in the Outside Diff bucket, never an #issuecomment- permalink.
    expect(patchCall?.stdin).not.toContain("#issuecomment-");
    expect(patchCall?.stdin).toContain("### Comments Outside Diff (1)");
    expect(patchCall?.stdin).toContain("a fresh un-anchorable finding");
    expect(patchCall?.stdin).toContain("`src/never.ts:1`");
  });
});

// WARN-5 (verify-report-pr3, #3305): `previousHeadSha` and the finding
// `claim` feed are dead at the composition layer — pinned one layer down
// (review/report.ts/pr/inline.ts) but not proven to actually REACH those functions
// from here. Both closed below.
describe("postInlineFindings — previousHeadSha reaches the rendered summary", () => {
  test("a prior summary comment's head= is threaded through to the delta's 'since' clause", async () => {
    const priorSummary = `<!-- pr-hero-report head=${OLD_HEAD} -->\n## pr-hero review`;
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([{ id: 1, user: "pr-hero", body: priorSummary }]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    const summaryCall = calls.find((c) =>
      c.stdin?.startsWith("<!-- crysk-report "),
    );
    expect(summaryCall).toBeDefined();
    // "diff from `aaaaaaaa`" (base_sha) ALSO contains OLD_HEAD's 8-char
    // prefix unconditionally, so assert the SPECIFIC "since" clause, not
    // merely the substring's presence — the weaker assertion would pass
    // even with previousHeadSha wired to undefined.
    expect(summaryCall?.stdin).toContain(`Δ since \`${OLD_HEAD.slice(0, 8)}\``);
  });
});

// WARN-5's other half: the fingerprint tie-break (design D3) depends on the
// REAL claim text reaching the matcher through resolveInlinePostPlan's
// `findingRefs` — a claim silently replaced by "" would disable the
// tie-break for every real run.
describe("postInlineFindings — the claim feed reaches the fingerprint tie-break", () => {
  test("a tie resolved by a matching fingerprint persists, using the finding's REAL claim text", async () => {
    const priorClaim = "the exact claim text this run's finding repeats";
    const r1 = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD,
      claim: "a different prior claim, at the same distance",
    });
    const r2 = findingMarker({
      path: "src/a.ts",
      line: 104,
      headSha: OLD_HEAD,
      claim: priorClaim,
    });
    // F001 sits equidistant (2) from both R1 (line 100) and R2 (line 104) —
    // an ambiguous tie UNLESS the fingerprint on its real claim breaks it
    // toward R2, whose stored fingerprint matches priorClaim.
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 102, claim: priorClaim }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 101,
              user: "pr-hero",
              body: `${r1}\na different prior claim, at the same distance`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
            {
              id: 102,
              user: "pr-hero",
              body: `${r2}\n${priorClaim}`,
              path: "src/a.ts",
              line: 104,
              original_line: 104,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    // The fingerprint tie-break resolved the ambiguity: F001 persists
    // (matched to R2), never posted fresh.
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.issueCommentIds.length).toBe(0);
    // R1 (unmatched this run) is the delta's "resolved" side; F001 is the
    // "persist" side (matched to R2 via the fingerprint tie-break).
    expect(outcome.delta).toEqual({ resolved: 1, new: 0, persist: 1 });
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
  });
});

// F004 (PR #330): the findings POST parked forever on an unanswered gh call,
// and the reads that run before and after the POST were unbounded too. Every
// call on this path must carry the posting bound, reads included, so a
// dropped argument on any one of them fails here instead of hanging in
// production.
describe("postInlineFindings — every gh call on the findings POST is bounded (F004)", () => {
  test("a first review: every gh call, reads and writes alike, carries the bound", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 999 }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(
      calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
    ).toBe(true);
    expect(calls.map((c) => c.timeout)).toEqual(
      calls.map(() => POSTING_GH_TIMEOUT_MS),
    );
  });

  test("a 422 recovery's re-reads carry the bound too", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(calls.some((c) => c.argv.includes("--paginate"))).toBe(true);
    expect(calls.map((c) => c.timeout)).toEqual(
      calls.map(() => POSTING_GH_TIMEOUT_MS),
    );
  });
});

describe("postInlineIfEligible — sessionFailed suppresses all posting", () => {
  test("sessionFailed true: zero HTTP calls, returns null", async () => {
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineIfEligible({
      sessionFailed: true,
      skippedReason: "post skipped: every hunter failed",
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [finding({ id: "F001" })] }),
      diffPatch: diffAddingLines("src/app.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("sessionFailed false: posts normally and returns the outcome", async () => {
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineIfEligible({
      sessionFailed: false,
      skippedReason: "unreachable",
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome).not.toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("postingExitCode — design D6's exit-1 rule", () => {
  function outcome(overrides: Partial<InlinePostOutcome>): InlinePostOutcome {
    return {
      reviewOutcome: "posted",
      reviewFindingCount: 0,
      issueCommentIds: [],
      outsideDiffCount: 0,
      summary: { action: "created", commentId: 1 },
      delta: { resolved: 0, new: 0, persist: 0 },
      droppedFindingIds: [],
      commentUrls: new Map(),
      movedHeadSha: undefined,
      ...overrides,
    };
  }

  test("exit 0 when every finding reached a channel", () => {
    expect(postingExitCode(outcome({ droppedFindingIds: [] }))).toBe(0);
  });

  test("exit 1 when any finding reached neither channel", () => {
    expect(postingExitCode(outcome({ droppedFindingIds: ["F002"] }))).toBe(1);
  });

  test("a null outcome (sessionFailed, or --post not given) is not itself a posting failure", () => {
    expect(postingExitCode(null)).toBe(0);
  });
});

describe("computeDroppedFindingIds — design D6's oracle", () => {
  // WARN-1 (verify-report-pr3, #3305): under the CRIT-A fix, a genuine drop
  // is no longer reachable through normal postInlineFindings execution — the
  // formula itself still needs its own pin, hand-built, the same way
  // postingExitCode is tested against a literal rather than a live outcome.
  function ref(id: string): PrHeroFindingRef {
    return { id, path: "src/a.ts", line: 1, claim: "x", tier: "blocking" };
  }

  test("every expected id reached: nothing dropped", () => {
    expect(
      computeDroppedFindingIds(
        [ref("F001"), ref("F002")],
        new Set(["F001", "F002"]),
      ),
    ).toEqual([]);
  });

  test("an expected id absent from reached: dropped", () => {
    expect(
      computeDroppedFindingIds([ref("F001"), ref("F002")], new Set(["F001"])),
    ).toEqual(["F002"]);
  });

  test("reached carrying an id NOT in expected does not manufacture a drop", () => {
    expect(
      computeDroppedFindingIds([ref("F001")], new Set(["F001", "F999"])),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The vanished prior summary on the path that has ALREADY PAID: `--pr --post`.
//
// Every guard test in the F008 suite above drives `runPostCommand`, and that
// is exactly how the vanished-summary guard stayed structurally dead on the
// primary path for a whole slice: it hung off `requireRereviewOnPriorSummary`,
// a flag only `post --from` sets. These drive `postInlineIfEligible` — what
// reviewPr's step 14 actually calls — because a defect on one path is
// invisible to every test of the other.
//
// The window is real: the PR's comments are read in phase B, the pipeline then
// runs 8-25 minutes, and the summary this re-review was computed against can
// be deleted inside it. The two callers meet that state having paid very
// different prices, so the answers differ on purpose: `post --from` refuses
// (free to re-run), `--pr --post` publishes the findings with the re-review
// framing dropped and says so in the log.
// ---------------------------------------------------------------------------

describe("postInlineIfEligible — a vanished prior summary degrades, never refuses", () => {
  const PRIOR_CLAIM = "the prior finding, still live and still unfixed";

  function liveRereview(
    over: Partial<RereviewProvenance> = {},
  ): RereviewProvenance {
    return {
      case: "C",
      last_reviewed_head: OLD_HEAD,
      last_head_source: "summary_marker",
      discovery_range: `${OLD_HEAD}..${HEAD}`,
      discovery_restricted: true,
      discovery_skipped_empty_delta: false,
      prior_findings: 1,
      settled_deterministically: 0,
      verified: 0,
      verification_capped: 0,
      verification_triggers: {
        applied: 0,
        touched: 0,
        overlap: 0,
        verify_all: 0,
      },
      // Non-empty on purpose: an empty `live[]` renders no `Still live:`
      // section even when the framing survives, so the absence assertion
      // below would pass against the defect and prove nothing.
      live: [
        {
          id: "R001",
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          status: "carried",
          locs: ["src/a.ts:10"],
          c: claimFingerprint(PRIOR_CLAIM),
          claim: PRIOR_CLAIM,
        },
      ],
      resolved_verified: 0,
      resolved_ids: [],
      returned: 0,
      re_tiered: 0,
      ...over,
    };
  }

  function prPostInput(spawnFn: typeof Bun.spawn) {
    return {
      sessionFailed: false,
      skippedReason: "unreachable",
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      rereview: liveRereview(),
      rereviewPriors: [],
    };
  }

  // Same stderr capture the F005 collapse suite uses: `log` writes there, and
  // the disclosure is half of what this fix is — a silent downgrade would be
  // the same class of defect as the dead guard it replaces.
  async function capturingLog<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; logged: string }> {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      return { result: await fn(), logged: chunks.join("") };
    } finally {
      process.stderr.write = origWrite;
    }
  }

  function lastSummaryBody(calls: RecordedCall[]): string {
    const bodies = summaryStdins(calls);
    return bodies[bodies.length - 1] ?? "";
  }

  test("the summary vanished mid-run: the findings post, the framing does not", async () => {
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript(HEAD));
    const { result: outcome, logged } = await capturingLog(() =>
      postInlineIfEligible(prPostInput(spawnFn)),
    );

    // The whole point of the asymmetry: a review that cost $2.49-$6.34 is
    // published, not thrown away over a framing that went stale.
    expect(outcome).not.toBeNull();
    expect(outcome?.reviewFindingCount).toBe(1);
    expect(outcome?.droppedFindingIds).toEqual([]);

    const body = lastSummaryBody(calls);
    // All three re-review surfaces, gone. NOT asserted via "Δ since": with
    // no summary on the PR `previousHeadSha` is undefined either way, so the
    // delta line reads a bare "Δ:" even on the defect — an assertion that
    // would pass against the bug and prove nothing.
    expect(body).not.toContain("Still live:");
    expect(body).not.toContain("<!-- crysk-state ");
    expect(body).not.toContain("unconfirmed");
    expect(body).not.toContain("carried");
    expect(body).not.toContain("R001");
    // And what it renders instead is exactly the first-review shape, which is
    // what this run now IS: the review it was a re-review OF is not there.
    expect(body).toContain("Δ: 0 resolved · 1 new · 0 persist");
    // post.json must describe the comment that was published, not the one the
    // stale block said it would be.
    expect(outcome?.delta).toEqual({ resolved: 0, new: 1, persist: 0 });

    // Loud. An operator who expected a delta must be able to read WHY off the
    // log rather than suspect the re-review silently broke.
    expect(logged).toContain(
      "the Crysk summary comment this re-review was computed against is gone",
    );
    expect(logged).toContain("drops the re-review framing");
    expect(logged).toContain("review --pr 42 --post");
  });

  test("`post --from` meets the same state and still refuses — the asymmetry is deliberate", async () => {
    // The regression guard on the split. `runPostCommand`'s own coverage sits
    // in the F008 suite above (live and --dry-run); this pins it at the seam,
    // one flag away from the degrade path, so the two answers stay visibly
    // different rather than drifting into one.
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript(HEAD));
    const { sessionFailed, skippedReason, ...postInput } = prPostInput(spawnFn);
    expect(sessionFailed).toBe(false);
    expect(skippedReason).toBe("unreachable");
    await expect(
      postInlineFindings({
        ...postInput,
        refuseOnVanishedPriorSummary: true,
      }),
    ).rejects.toThrow(/no longer carries a Crysk summary comment/);
    // Refused before any write, exactly as `post --from` always has.
    expect(calls.filter((c) => c.argv.includes("--method"))).toHaveLength(0);
  });

  test("the summary is still there: delta, live list and state block untouched", async () => {
    // The control. The degrade must fire on a VANISHED summary and nothing
    // else — a fix that drops the framing whenever a `rereview` block is
    // present would pass the first test and destroy the feature.
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 200,
              user: "pr-hero",
              body: `<!-- pr-hero-report head=${OLD_HEAD} -->\n## pr-hero review`,
              updated_at: "2026-08-20T00:00:00Z",
            },
          ]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ]);
    const { result: outcome, logged } = await capturingLog(() =>
      postInlineIfEligible(prPostInput(spawnFn)),
    );
    expect(outcome).not.toBeNull();
    const body = lastSummaryBody(calls);
    expect(body).toContain(`Δ since \`${OLD_HEAD.slice(0, 8)}\``);
    expect(body).toContain("0 unconfirmed · 1 carried · 0 deferred · 1 new");
    expect(body).toContain("Still live:");
    expect(body).toContain(PRIOR_CLAIM);
    expect(body).toContain(`<!-- crysk-state v=1 head=${HEAD} -->`);
    expect(logged).not.toContain("drops the re-review framing");
  });
});

// ---------------------------------------------------------------------------
// F005 — the verified-gone collapse loop's two gh calls are bounded.
//
// Every LLM step in the pipeline is bounded by `stepTimeoutMs`; these two were
// the only awaits on the `--post` path with no bound at all, so an
// accepted-but-unanswered GitHub request hung `review --pr --post` forever —
// including an unattended `--yes` run from the watcher, where nothing is
// present to notice it. The bound has to degrade to "thread left open": a
// resolve on a thread whose ✅ reply never landed is a silent close, the same
// false `resolved` item 7 exists to never produce.
// ---------------------------------------------------------------------------

describe("postInlineFindings — the collapse loop cannot hang (F005)", () => {
  const PRIOR_CLAIM = "the prior finding, checked and gone at this head";
  const PRIOR_MARKER = findingMarker({
    path: "src/a.ts",
    line: 10,
    headSha: OLD_HEAD,
    claim: PRIOR_CLAIM,
  });

  function rereview(): RereviewProvenance {
    return {
      case: "C",
      last_reviewed_head: OLD_HEAD,
      last_head_source: "summary_marker",
      discovery_range: `${OLD_HEAD}..${HEAD}`,
      discovery_restricted: true,
      discovery_skipped_empty_delta: false,
      prior_findings: 1,
      settled_deterministically: 0,
      verified: 1,
      verification_capped: 0,
      verification_triggers: {
        applied: 0,
        touched: 1,
        overlap: 0,
        verify_all: 0,
      },
      live: [],
      resolved_verified: 1,
      resolved_ids: ["R001"],
      returned: 0,
      re_tiered: 0,
    };
  }

  function priorCommentScript(hangOn: string): ScriptEntry[] {
    return [
      headRefOidScript(HEAD),
      { match: ["issues/42/comments", "--paginate"], response: { stdout: "" } },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 501,
              user: "pr-hero",
              body: `${PRIOR_MARKER}\n${PRIOR_CLAIM}`,
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      // Ahead of the successful entries so a `hangOn` naming any of them
      // wins the `script.find` — including `owner,name`, the repo lookup
      // resolveReviewThreadForComment makes BEFORE either graphql call. A
      // bound on two of three gh calls still hangs on the third.
      { match: [hangOn], response: { hang: true } },
      {
        match: ["repo", "view", "--json", "owner,name"],
        response: {
          stdout: JSON.stringify({
            owner: { login: "juanmaagd" },
            name: "pr-hero",
          }),
        },
      },
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ];
  }

  async function collapseWith(hangOn: string): Promise<{
    logged: string;
    calls: RecordedCall[];
  }> {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const { spawnFn, calls } = makeFakeGh(priorCommentScript(hangOn));
      await postInlineFindings({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        headSha: HEAD,
        doc: doc({ findings: [] }),
        diffPatch: diffAddingLines("src/a.ts", 20),
        webUrl: undefined,
        spawnFn,
        rereview: rereview(),
        rereviewPriors: [
          { id: "R001", claim: PRIOR_CLAIM, locs: ["src/a.ts:10"] },
        ],
        ghTimeoutMs: 30,
      });
      return { logged: chunks.join(""), calls };
    } finally {
      process.stderr.write = origWrite;
    }
  }

  test("a hung reply post leaves the thread open and never resolves it", async () => {
    // Without the bound this test does not fail — it never returns.
    const { logged, calls } = await collapseWith("in_reply_to=501");
    expect(logged).toContain("collapse skipped for R001");
    expect(logged).toContain("thread left open");
    expect(logged).toContain("timed out after 30 ms");
    // The resolve must NOT run: closing a thread whose ✅ reply never posted
    // is the false `resolved` the whole verified-gone path forbids.
    expect(
      calls.filter((c) => c.argv.join(" ").includes("reviewThreads")),
    ).toHaveLength(0);
    expect(logged).not.toContain("resolved: review thread for R001");
  });

  test("a hung thread-resolve is reported, not awaited forever", async () => {
    const { logged, calls } = await collapseWith("reviewThreads");
    expect(
      calls.filter((c) => c.argv.join(" ").includes("in_reply_to=501")),
    ).toHaveLength(1);
    expect(logged).toContain("resolve failed for R001");
    expect(logged).toContain("timed out after 30 ms");
    expect(logged).not.toContain("resolved: review thread for R001");
  });

  test("the resolve's inner repo lookup is bounded too", async () => {
    // `resolveReviewThreadForComment` makes THREE gh calls; `ghRepoOwnerName`
    // is the first and used to be the one nobody thought to bound.
    const { logged } = await collapseWith("owner,name");
    expect(logged).toContain("resolve failed for R001");
    expect(logged).toContain("timed out after 30 ms");
    expect(logged).not.toContain("resolved: review thread for R001");
  });

  // Two verified-gone priors, so the run-level notice is observably ONE line
  // where a per-prior line would print twice.
  const PRIOR_CLAIM_2 =
    "the second prior finding, checked and gone at this head";
  const PRIOR_MARKER_2 = findingMarker({
    path: "src/a.ts",
    line: 11,
    headSha: OLD_HEAD,
    claim: PRIOR_CLAIM_2,
  });

  async function collapseTwoWithLookupFailure(failure: string): Promise<{
    logged: string;
    calls: RecordedCall[];
  }> {
    const script: ScriptEntry[] = [
      headRefOidScript(HEAD),
      { match: ["issues/42/comments", "--paginate"], response: { stdout: "" } },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 501,
              user: "pr-hero",
              body: `${PRIOR_MARKER}\n${PRIOR_CLAIM}`,
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
            {
              id: 502,
              user: "pr-hero",
              body: `${PRIOR_MARKER_2}\n${PRIOR_CLAIM_2}`,
              path: "src/a.ts",
              line: 11,
              original_line: 11,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      { match: ["reviewThreads"], response: { stderr: failure, exitCode: 1 } },
      {
        match: ["repo", "view", "--json", "owner,name"],
        response: {
          stdout: JSON.stringify({
            owner: { login: "juanmaagd" },
            name: "pr-hero",
          }),
        },
      },
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ];
    const rereviewTwo: RereviewProvenance = {
      ...rereview(),
      prior_findings: 2,
      verified: 2,
      resolved_verified: 2,
      resolved_ids: ["R001", "R002"],
    };
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const { spawnFn, calls } = makeFakeGh(script);
      await postInlineFindings({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        headSha: HEAD,
        doc: doc({ findings: [] }),
        diffPatch: diffAddingLines("src/a.ts", 20),
        webUrl: undefined,
        spawnFn,
        rereview: rereviewTwo,
        rereviewPriors: [
          { id: "R001", claim: PRIOR_CLAIM, locs: ["src/a.ts:10"] },
          { id: "R002", claim: PRIOR_CLAIM_2, locs: ["src/a.ts:11"] },
        ],
        ghTimeoutMs: 30,
      });
      return { logged: chunks.join(""), calls };
    } finally {
      process.stderr.write = origWrite;
    }
  }

  test("a token that cannot resolve threads gets one run-level notice, not a line per prior", async () => {
    const { logged, calls } = await collapseTwoWithLookupFailure(
      "gh: Resource not accessible by integration (HTTP 403)",
    );
    const notice =
      "resolve skipped: the workflow token cannot resolve review threads " +
      "(Resource not accessible by integration); the verified-gone replies are posted";
    expect(logged.split(notice)).toHaveLength(2);
    expect(logged).not.toContain("resolve failed for R001");
    expect(logged).not.toContain("resolve failed for R002");
    // The replies still post: the gate and the reply are unaffected.
    expect(
      calls.filter((c) => c.argv.join(" ").includes("in_reply_to=501")),
    ).toHaveLength(1);
    expect(
      calls.filter((c) => c.argv.join(" ").includes("in_reply_to=502")),
    ).toHaveLength(1);
  });

  test("any other resolve failure keeps the per-prior line", async () => {
    const { logged } = await collapseTwoWithLookupFailure(
      "gh: Could not resolve to a PullRequest (HTTP 404)",
    );
    expect(logged).toContain("resolve failed for R001");
    expect(logged).toContain("resolve failed for R002");
    expect(logged).not.toContain("the workflow token cannot resolve");
  });
});

// A re-review PATCHes the summary in place, and GitHub neither notifies on an
// edit nor moves the comment down the timeline. A clean re-review used to
// leave the PR looking untouched, so a reader could not tell "ran and found
// nothing" from "never ran". The closing comment is the visible receipt.
describe("postInlineFindings — re-review closing comment", () => {
  const priorSummary = `<!-- pr-hero-report head=${OLD_HEAD} -->\n## pr-hero review`;

  function closingPosts(calls: RecordedCall[]): RecordedCall[] {
    return calls.filter(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.argv.includes("POST") &&
        c.stdin?.startsWith(PR_REREVIEW_CLOSED_MARKER_PREFIX),
    );
  }

  function rereviewScript(
    extra: ScriptEntry[] = [],
  ): ReturnType<typeof makeFakeGh> {
    return makeFakeGh([
      ...extra,
      headRefOidScript(HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([{ id: 1, user: "pr-hero", body: priorSummary }]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ]);
  }

  test("a clean re-review posts one closing comment after the summary PATCH", async () => {
    const { spawnFn, calls } = rereviewScript();
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: "https://github.com/o/r",
      spawnFn,
    });
    const closing = closingPosts(calls);
    expect(closing.length).toBe(1);
    const body = closing[0]?.stdin ?? "";
    expect(body.startsWith(`<!-- crysk-rereview-closed head=${HEAD} -->`)).toBe(
      true,
    );
    expect(body).toContain("Crysk re-review complete");
    expect(body).toContain(`\`${HEAD.slice(0, 8)}\``);
    expect(body).toContain("No findings in this pass.");
    expect(body).toContain(`Δ since \`${OLD_HEAD.slice(0, 8)}\``);
    expect(body).toContain(
      "[view summary](https://github.com/o/r/pull/42#issuecomment-1)\n",
    );
    // Posted LAST: after the summary PATCH, so it closes the run.
    const patchIndex = calls.findIndex(
      (c) =>
        c.argv.includes("PATCH") && c.stdin?.startsWith("<!-- crysk-report "),
    );
    const closingIndex = calls.indexOf(closing[0] as RecordedCall);
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(closingIndex).toBeGreaterThan(patchIndex);
    expect(outcome.closingCommentId).toBeGreaterThan(0);
    expect(outcome.summary.action).toBe("updated");
  });

  test("a re-review with new findings names how many were posted", async () => {
    const { spawnFn, calls } = rereviewScript();
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    const body = closingPosts(calls)[0]?.stdin ?? "";
    expect(body).toContain("1 new finding(s) posted in this pass.");
    expect(body).toContain("The summary comment above was updated.");
  });

  test("a partial re-review says so in the closing comment", async () => {
    const { spawnFn, calls } = rereviewScript();
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [], run_status: "partial" }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    const body = closingPosts(calls)[0]?.stdin ?? "";
    expect(body).toContain("Partial coverage");
    // The heading is what the notification and timeline preview show: a
    // partial pass must never read as a green "complete".
    const heading = body.split("\n")[1] ?? "";
    expect(heading).toContain(
      "### ⚠️ Crysk re-review finished with partial coverage",
    );
    expect(heading).not.toContain("✅");
    expect(body).not.toContain("No findings in this pass.");
  });

  test("a finding that persists on an existing comment is not reported as 'no findings'", async () => {
    const marker = findingMarker({
      path: "src/a.ts",
      line: 10,
      headSha: HEAD,
      claim: "unchanged claim",
    });
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([{ id: 1, user: "pr-hero", body: priorSummary }]),
        },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 9,
              user: "pr-hero",
              body: `${marker}\nunchanged claim`,
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [
          finding({
            id: "F001",
            path: "src/a.ts",
            line: 10,
            claim: "unchanged claim",
          }),
        ],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    const body = closingPosts(calls)[0]?.stdin ?? "";
    expect(body).not.toContain("No findings in this pass.");
    expect(body).toContain(
      "Nothing new was posted in this pass; findings already on the PR were kept.",
    );
  });

  test("a closing POST that never answers is bounded and the run still returns", async () => {
    const { spawnFn } = rereviewScript([
      {
        match: ["--method", "POST", "issues/42/comments"],
        response: { hang: true },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      ghTimeoutMs: 50,
    });
    expect(outcome.closingCommentId).toBeUndefined();
    expect(outcome.summary.action).toBe("updated");
  });

  test("a first review posts no closing comment — the new summary is already visible", async () => {
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(closingPosts(calls).length).toBe(0);
    expect(outcome.closingCommentId).toBeUndefined();
  });

  test("a failed closing POST degrades to a log line, never fails the paid run", async () => {
    const { spawnFn, calls } = rereviewScript([
      {
        match: ["--method", "POST", "issues/42/comments"],
        response: { stderr: "HTTP 502", exitCode: 1 },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(closingPosts(calls).length).toBe(1);
    expect(outcome.closingCommentId).toBeUndefined();
    expect(outcome.summary.action).toBe("updated");
  });
});

// S1, S3, S7 at the post seam. The state block is the only memory the next
// run has, so these read what the summary PATCH actually carries.
describe("postInlineFindings — the state block carries a re-review's fresh findings", () => {
  const PRIOR_SUMMARY = `<!-- pr-hero-report head=${OLD_HEAD} -->\n## pr-hero review`;

  function reviewScript(): ReturnType<typeof makeFakeGh> {
    return makeFakeGh([
      headRefOidScript(HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([{ id: 1, user: "pr-hero", body: PRIOR_SUMMARY }]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
  }

  function reviewProvenance(
    live: LiveFinding[],
    over: Partial<RereviewProvenance> = {},
  ): RereviewProvenance {
    return {
      case: "C",
      last_reviewed_head: OLD_HEAD,
      last_head_source: "summary_marker",
      discovery_range: `${OLD_HEAD}..${HEAD}`,
      discovery_restricted: true,
      discovery_skipped_empty_delta: false,
      prior_findings: live.length,
      settled_deterministically: 0,
      verified: 0,
      verification_capped: 0,
      verification_triggers: {
        applied: 0,
        touched: 0,
        overlap: 0,
        verify_all: 0,
      },
      live,
      resolved_verified: 0,
      resolved_ids: [],
      returned: 0,
      re_tiered: 0,
      ...over,
    } as RereviewProvenance;
  }

  function summaryState(calls: RecordedCall[]) {
    const bodies = summaryStdins(calls);
    return parseStateBlock(bodies[bodies.length - 1] ?? "");
  }

  test("S1 — review 2's fresh blocking finding is in the state, and review 3 still counts it", async () => {
    const { spawnFn, calls } = reviewScript();
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [
          finding({
            id: "F001",
            path: "src/a.ts",
            line: 10,
            tier: "blocking",
            severity: "BLOCKER",
            claim: "fresh blocker",
          }),
        ],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      rereview: reviewProvenance([]),
      rereviewPriors: [],
    });
    const state = summaryState(calls);
    expect(state?.findings.map((f) => [f.tier, f.claim])).toEqual([
      ["blocking", "fresh blocker"],
    ]);

    // Review 3: a same-head forced re-review with no survivors.
    const priors = priorsFromStateFindings(state?.findings ?? []);
    const ctx = {
      case: "C" as const,
      deletedFiles: new Set<string>(),
      renameMap: new Map<string, string>(),
      touched: () => false,
      summaryUpdatedAt: null,
    };
    const assembled = assembleLive({
      settled: priors.map((p) => classifyPrior(p, ctx)),
      priors,
      verifyVerdicts: new Map(),
    });
    expect(unresolvedBlockingCount([], assembled.gateRows)).toBe(1);
  });

  test("S1 — a prior row survives next to a fresh finding, with the prior id kept", async () => {
    const prior = stateFinding({
      id: "R001",
      sev: "CRITICAL",
      tier: "blocking",
      channel: "inline",
      locs: ["src/a.ts:300"],
      claim: "prior still live",
    });
    const { spawnFn, calls } = reviewScript();
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [
          finding({
            id: "F001",
            path: "src/a.ts",
            line: 10,
            tier: "blocking",
            severity: "BLOCKER",
            claim: "fresh blocker",
          }),
        ],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      rereview: reviewProvenance([{ ...prior, status: "carried" }]),
      rereviewPriors: [],
    });
    const state = summaryState(calls);
    expect(state?.findings.map((f) => [f.id, f.claim])).toEqual([
      ["R001", "prior still live"],
      ["R002", "fresh blocker"],
    ]);
  });

  test("S3 — a fresh row's locs use the line the comment was posted at, not findings.json's", async () => {
    const { spawnFn, calls } = reviewScript();
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [
          finding({
            id: "F001",
            path: "src/a.ts",
            line: 500,
            proof_refs: ["src/a.ts:12"],
            tier: "blocking",
            severity: "BLOCKER",
            claim: "moved",
          }),
        ],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      rereview: reviewProvenance([]),
      rereviewPriors: [],
    });
    expect(summaryState(calls)?.findings[0]?.locs).toEqual(["src/a.ts:12"]);
  });

  test("S7 — the create-first POST and the closing PATCH carry the same state block", async () => {
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [
          finding({
            id: "F001",
            path: "src/a.ts",
            line: 10,
            tier: "blocking",
            severity: "BLOCKER",
            claim: "fresh blocker",
          }),
          finding({
            id: "F002",
            path: "src/a.ts",
            line: 11,
            tier: "advisory",
            severity: "SUGGESTION",
            claim: "advisory near it",
          }),
        ],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: "https://github.com/o/r",
      spawnFn,
      rereview: reviewProvenance([], { last_head_source: "finding_markers" }),
      rereviewPriors: [],
    });
    const bodies = summaryStdins(calls);
    expect(bodies.length).toBe(2);
    const stateOf = (body: string) =>
      body.slice(body.indexOf("<!-- crysk-state "));
    expect(stateOf(bodies[0] ?? "")).toBe(stateOf(bodies[1] ?? ""));
    expect(stateOf(bodies[1] ?? "")).toContain("fresh blocker");
  });

  // S1 wiring, through the public post path. Each blocking claim renders in
  // the headline, the state block, and the demoted Outside Diff prompt, so six
  // 3000-char claims put the base PATCH near 72k. The limit is GitHub's.
  test("S1 — a 422 demotion whose Outside Diff bodies overflow the limit keeps the PATCH within it and every blocking state row", async () => {
    const GITHUB_LIMIT = 65536;
    const findings = Array.from({ length: 6 }, (_, i) =>
      finding({
        id: `F00${i + 1}`,
        path: "src/a.ts",
        line: 10 + i,
        tier: "blocking",
        severity: "BLOCKER",
        claim: `claim ${i} ${"z".repeat(4500)}`,
      }),
    );
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([{ id: 1, user: "pr-hero", body: PRIOR_SUMMARY }]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      rereview: reviewProvenance([]),
      rereviewPriors: [],
    });
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(outcome.outsideDiffCount).toBe(6);
    const patch = summaryStdins(calls).at(-1) ?? "";
    expect(patch.length).toBeLessThanOrEqual(GITHUB_LIMIT);
    const state = parseStateBlock(patch);
    expect(state?.findings).toHaveLength(6);
    expect(state?.findings.every((f) => f.tier === "blocking")).toBe(true);
  });
  // S1 — a demotion that compaction alone can fit must not evict the advisory
  // priors the POST state held. The eight blocking claims put the Outside
  // Diff bodies (and the state rows they also fill, protected) past the cap,
  // so a re-merge sized from the uncompacted PATCH would leave no budget.
  test("S1 — a demotion that compaction alone fits keeps every advisory prior row the POST state held", async () => {
    const GITHUB_LIMIT = 65536;
    const findings = Array.from({ length: 8 }, (_, i) =>
      finding({
        id: `F00${i + 1}`,
        path: "src/a.ts",
        line: 10 + i,
        tier: "blocking",
        severity: "BLOCKER",
        claim: `claim ${i} ${"z".repeat(4000)}`,
      }),
    );
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([{ id: 1, user: "pr-hero", body: PRIOR_SUMMARY }]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const advisoryPrior = stateFinding({
      id: "R001",
      sev: "WARNING",
      tier: "advisory",
      channel: "inline",
      locs: ["src/b.ts:5"],
      claim: "advisory prior kept",
    });
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      rereview: reviewProvenance([{ ...advisoryPrior, status: "carried" }]),
      rereviewPriors: [],
    });
    expect(outcome.reviewOutcome).toBe("demoted");
    const patch = summaryStdins(calls).at(-1) ?? "";
    expect(patch.length).toBeLessThanOrEqual(GITHUB_LIMIT);
    const state = parseStateBlock(patch);
    expect(state?.findings.find((f) => f.id === "R001")?.claim).toBe(
      "advisory prior kept",
    );
    expect(state?.findings.filter((f) => f.tier === "blocking")).toHaveLength(
      8,
    );
  });
});

// The summary's own counter, end to end: postInlineFindings writes it into the
// summary body, and a later run reads it back. A comment-triggered (forced)
// post must leave it where it was; an automatic post must still add one.
describe("postInlineFindings — the summary counter and a forced run", () => {
  async function postFirstReview(force: boolean | undefined) {
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      ...(force === undefined ? {} : { force }),
    });
    const bodies = summaryStdins(calls);
    return parseCiAdmissionBlock(bodies[bodies.length - 1] ?? "")?.reviews;
  }

  test("an automatic first review writes one review, as before", async () => {
    expect(await postFirstReview(undefined)).toBe(1);
    expect(await postFirstReview(false)).toBe(1);
  });

  test("a forced first review writes zero automatic reviews", async () => {
    expect(await postFirstReview(true)).toBe(0);
  });
});

// Blocker: a forced run's count of 0 must survive the MERGED render path (a
// re-review, which writes the state block). The state block omits 0, so the
// admission block has to carry it, or the next read counts the summary as one.
describe("postInlineFindings — a forced zero survives a merged re-review render", () => {
  const FIRST_HEAD = OLD_HEAD;

  function reviewProvenanceFor(): RereviewProvenance {
    return {
      case: "C",
      last_reviewed_head: FIRST_HEAD,
      last_head_source: "summary_marker",
      discovery_range: `${FIRST_HEAD}..${HEAD}`,
      discovery_restricted: true,
      discovery_skipped_empty_delta: false,
      prior_findings: 0,
      settled_deterministically: 0,
      verified: 0,
      verification_capped: 0,
      verification_triggers: {
        applied: 0,
        touched: 0,
        overlap: 0,
        verify_all: 0,
      },
      live: [],
      resolved_verified: 0,
      resolved_ids: [],
      returned: 0,
      re_tiered: 0,
    } as RereviewProvenance;
  }

  // Posts one review on HEAD (the second head) over a prior summary body, and
  // returns the body that run wrote.
  async function reReview(
    priorSummary: string,
    force: boolean,
  ): Promise<string> {
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([{ id: 1, user: "pr-hero", body: priorSummary }]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      rereview: reviewProvenanceFor(),
      rereviewPriors: [],
      force,
    });
    const bodies = summaryStdins(calls);
    return bodies[bodies.length - 1] ?? "";
  }

  async function firstReviewBody(force: boolean): Promise<string> {
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(FIRST_HEAD),
      { match: ["issues/42/comments", "--paginate"], response: { stdout: "" } },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: FIRST_HEAD,
      doc: doc({
        head_sha: FIRST_HEAD,
        findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      force,
    });
    const bodies = summaryStdins(calls);
    return bodies[bodies.length - 1] ?? "";
  }

  function countAfter(body: string): number {
    return stateReviewCount(
      parseStateBlock(body),
      true,
      parseCiAdmissionBlock(body),
    );
  }

  test("forced first review (0) then forced re-review through the merged path: still 0", async () => {
    const first = await firstReviewBody(true);
    expect(countAfter(first)).toBe(0);
    const second = await reReview(first, true);
    // The merged path really ran: it wrote a state block.
    expect(second).toContain("<!-- crysk-state ");
    expect(countAfter(second)).toBe(0);
  });

  test("automatic re-review after a forced zero: counts 1", async () => {
    const first = await firstReviewBody(true);
    const second = await reReview(first, false);
    expect(second).toContain("<!-- crysk-state ");
    expect(countAfter(second)).toBe(1);
  });
});
