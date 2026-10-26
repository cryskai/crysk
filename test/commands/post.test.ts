import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPostCommand } from "#commands/post";
import { claimFingerprint } from "#pr/preflight";
import type { Finding, FindingsDocument, Telemetry } from "#review/findings";
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

// ---------------------------------------------------------------------------
// runPostCommand — CRIT-B (verify-report-pr3, #3305): the `post` verb is the
// $0 gate standing in front of the first live GitHub write this project will
// ever make. It had zero covering tests and was structurally untestable —
// unexported, and its dry-run branch never threaded `spawnFn`, so even an
// exported version would still have reached the real `gh`. Fixed by
// extracting `runPostCommand` (everything after `resolveRepoRoot`'s real
// `git` call, which stays in the unexported, untested-by-design
// `postCommand` shell) as an exported, `spawnFn`-injectable function.
//
// Uses a REAL temp directory for findings.json/diff.patch (runPostCommand
// reads them off disk via Bun.file — that I/O is not worth faking) but a
// FAKE gh for every network-shaped call, via the same makeFakeGh harness
// used everywhere else in this file.

const RUN_HEAD = "c".repeat(40);

async function writeRunDir(
  overrides: Partial<FindingsDocument> = {},
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-post-test-"));
  const runDoc = doc({ head_sha: RUN_HEAD, ...overrides });
  await Bun.write(
    path.join(dir, "findings.json"),
    JSON.stringify(runDoc, null, 2),
  );
  await Bun.write(
    path.join(dir, "diff.patch"),
    diffAddingLines("src/a.ts", 200),
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("runPostCommand — CRIT-B: the $0 gate before the first live write", () => {
  test("dry-run performs ZERO mutating gh calls — inverting this must fail a test", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      // The read-only comment fetches DID happen (this is a real preview,
      // not a no-op) — but nothing in them mutates.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.argv).not.toContain("--method");
        expect(call.argv.join(" ")).not.toContain("reviews");
      }
    } finally {
      await cleanup();
    }
  });

  test("dry-run lists un-anchorable findings as outside, not issue", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/never.ts", line: 1 })],
    });
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const logged = chunks.join("");
      expect(logged).toContain("1 outside diff");
      expect(logged).toContain("outside src/never.ts:1 F001");
      expect(logged).not.toContain("issue comment(s)");
      expect(logged).not.toContain("  issue   ");
      for (const call of calls) {
        expect(call.argv).not.toContain("--method");
      }
    } finally {
      process.stderr.write = origWrite;
      await cleanup();
    }
  });

  test("a live post (no --dry-run) performs exactly the expected mutating calls and writes post.json", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(RUN_HEAD),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.argv.join(" ").includes("issues/42/comments") &&
            c.stdin?.startsWith("<!-- pr-hero-report "),
        ),
      ).toBe(true);
      // WARN-2 (verify-report-pr3): post.json is written but was never
      // asserted anywhere — WU7/4.4's idempotency proof reads it back.
      const receiptPath = path.join(dir, "post.json");
      const receipt = JSON.parse(await Bun.file(receiptPath).text());
      expect(receipt.pr).toBe(42);
      expect(receipt.head_sha).toBe(RUN_HEAD);
      expect(receipt.review.outcome).toBe("posted");
      expect(receipt.review.finding_count).toBe(1);
      expect(Array.isArray(receipt.issue_comment_ids)).toBe(true);
      expect(receipt.dropped_finding_ids).toEqual([]);
      expect(receipt.summary_comment.action).toBe("created");
    } finally {
      await cleanup();
    }
  });

  // S2 (refuter v3.2 posting policy): the preview must say what the live
  // post does. An anchorable latent finding is summary-only, never `review`.
  test("dry-run lists an anchorable latent finding as summary-only, not review", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [
        finding({
          id: "F001",
          path: "src/a.ts",
          line: 10,
          refuter_verdict: "downgraded-latent",
          tier: "advisory",
        }),
      ],
    });
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const { spawnFn } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const logged = chunks.join("");
      expect(logged).toContain("plan: 0 review comment(s), 0 outside diff");
      expect(logged).toContain("1 summary-only (latent)");
      expect(logged).toContain("latent  src/a.ts:10 F001");
      expect(logged).not.toContain("review  src/a.ts:10 F001");
    } finally {
      process.stderr.write = origWrite;
      await cleanup();
    }
  });

  test("a live post of a latent finding submits no review and puts it in the summary's own section", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [
        finding({
          id: "F001",
          path: "src/a.ts",
          line: 10,
          refuter_verdict: "downgraded-latent",
          tier: "advisory",
        }),
      ],
    });
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(RUN_HEAD),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(false);
      const summaries = calls.filter(
        (c) =>
          c.argv.join(" ").includes("issues/42/comments") &&
          c.stdin?.startsWith("<!-- pr-hero-report "),
      );
      expect(summaries.length).toBeGreaterThan(0);
      for (const summary of summaries) {
        expect(summary.stdin).toContain(
          "### Not posted inline: real but not reached at this commit (1)",
        );
        expect(summary.stdin).not.toContain("### Comments Outside Diff");
      }
      const receipt = JSON.parse(
        await Bun.file(path.join(dir, "post.json")).text(),
      );
      expect(receipt.review.finding_count).toBe(0);
      expect(receipt.dropped_finding_ids).toEqual([]);
      expect(receipt.delta).toEqual({ resolved: 0, new: 1, persist: 0 });
    } finally {
      await cleanup();
    }
  });

  // WARN-3 (deferred from PR2's verification): assertRunMatchesPr's call
  // site inside the verb, not just the pure function — reject a run-dir
  // whose OWN findings.json disagrees with --pr, before any gh call at all.
  test("a run-dir for a DIFFERENT pr is rejected before any gh call — assertRunMatchesPr's call site", async () => {
    const { dir, cleanup } = await writeRunDir({ pr: 17 });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 18,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(CliUsageError);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // The run-status guard: a partial run refuses to post live and makes zero
  // gh calls — this is the property M4 (verify-report-pr3's mutation table)
  // proved unpinned by forcing the guard to `false`.
  test("the run-status guard refuses a partial run on a live post: exit 1, zero gh calls", async () => {
    const { dir, cleanup } = await writeRunDir({ run_status: "partial" });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(1);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("the run-status guard on a dry-run of a partial run: exit 0, zero gh calls, no plan printed", async () => {
    const { dir, cleanup } = await writeRunDir({ run_status: "partial" });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // Juanma's decision (verify-report-pr3, #3305): the verb guards on the
  // PERSISTED `sessionFailed`, matching `--pr --post` exactly — a partial
  // run with `sessionFailed: false` (some hunter found nothing, or none ran
  // because gotchas were missing) still posts, same as the live path.
  test("sessionFailed: false persisted on a partial run — posts anyway, matching --pr --post", async () => {
    const { dir, cleanup } = await writeRunDir({
      run_status: "partial",
      sessionFailed: false,
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(RUN_HEAD),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // The other branch of the same decision: sessionFailed: true persisted —
  // even on a "complete"-looking run_status, the persisted flag is
  // authoritative and refuses to publish.
  test("sessionFailed: true persisted — refuses to post even if run_status looks complete", async () => {
    const { dir, cleanup } = await writeRunDir({
      run_status: "complete",
      sessionFailed: true,
    });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(1);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // Back-compat (mandatory): an artifact written BEFORE this change has no
  // `sessionFailed` field at all. Absent must fall back to today's
  // conservative `run_status !== "complete"` proxy — never to `false`,
  // which would publish a dead run as clean.
  test("sessionFailed absent (legacy artifact) — falls back to the run_status proxy: partial refuses", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-post-test-"));
    try {
      // Hand-built, deliberately WITHOUT `sessionFailed`, unlike writeRunDir
      // (which always calls doc(), and doc()'s spread would carry `undefined`
      // through JSON.stringify as an omitted key anyway — written explicitly
      // here so the "legacy artifact" shape is unambiguous to a reader).
      const legacyDoc = {
        schema_version: "1.0.0",
        pr: 42,
        base_sha: OLD_HEAD,
        head_sha: RUN_HEAD,
        model: "sonnet",
        iteration: 0,
        parity_hunter_fired: false,
        run_status: "partial",
        telemetry: TELEMETRY,
        findings: [],
        debug: { refuted: [] },
      };
      expect("sessionFailed" in legacyDoc).toBe(false);
      await Bun.write(
        path.join(dir, "findings.json"),
        JSON.stringify(legacyDoc, null, 2),
      );
      await Bun.write(
        path.join(dir, "diff.patch"),
        diffAddingLines("src/a.ts", 200),
      );
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(1);
      expect(calls.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sessionFailed absent (legacy artifact), run_status complete — the proxy proceeds to post", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-post-test-"));
    try {
      const legacyDoc = {
        schema_version: "1.0.0",
        pr: 42,
        base_sha: OLD_HEAD,
        head_sha: RUN_HEAD,
        model: "sonnet",
        iteration: 0,
        parity_hunter_fired: false,
        run_status: "complete",
        telemetry: TELEMETRY,
        findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
        debug: { refuted: [] },
      };
      await Bun.write(
        path.join(dir, "findings.json"),
        JSON.stringify(legacyDoc, null, 2),
      );
      await Bun.write(
        path.join(dir, "diff.patch"),
        diffAddingLines("src/a.ts", 200),
      );
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(RUN_HEAD),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F008 — `post --from` is a re-review too.
//
// Found by a LIVE case-C re-review of PR #49, which is the part that matters:
// `postCommand` called `postInlineFindings` with no `rereview` at all, so a
// run whose pipeline.json recorded {case C, verified 4, live 2} published
// "Δ since e23d8063: 3 resolved · 0 new · 1 persist" — the absence matcher's
// count, three "resolved" for two checks, the exact PR 1759 shape the feature
// exists to prevent — plus no state block, which then costs the NEXT run its
// priors. Nothing offline caught it; the whole `post --from` seam had no
// re-review coverage. These are that coverage.
// ---------------------------------------------------------------------------

describe("runPostCommand — post --from carries the re-review (F008)", () => {
  const SUMMARY_MARKER = `<!-- pr-hero-report head=${OLD_HEAD} -->`;

  function liveRow(over: {
    id: string;
    sev: Finding["severity"];
    status: string;
    line: number;
    claim: string;
  }) {
    return {
      id: over.id,
      sev: over.sev,
      tier: over.sev === "SUGGESTION" ? "advisory" : "blocking",
      channel: "inline",
      status: over.status,
      locs: [`src/a.ts:${over.line}`],
      c: claimFingerprint(over.claim),
      claim: over.claim,
    };
  }

  function rereviewBlock(over: Record<string, unknown> = {}) {
    return {
      case: "C",
      last_reviewed_head: OLD_HEAD,
      last_head_source: "summary_marker",
      discovery_range: `${OLD_HEAD}..${RUN_HEAD}`,
      discovery_restricted: true,
      discovery_skipped_empty_delta: false,
      prior_findings: 3,
      settled_deterministically: 1,
      verified: 2,
      verification_capped: 0,
      verification_triggers: {
        applied: 0,
        touched: 2,
        overlap: 0,
        verify_all: 0,
      },
      live: [
        liveRow({
          id: "R001",
          sev: "CRITICAL",
          status: "carried",
          line: 10,
          claim: "the prior nobody touched",
        }),
        liveRow({
          id: "R002",
          sev: "WARNING",
          status: "unconfirmed",
          line: 20,
          claim: "checked, and the check did not settle it",
        }),
        liveRow({
          id: "R003",
          sev: "WARNING",
          status: "unconfirmed",
          line: 30,
          claim: "the other one the check did not settle",
        }),
      ],
      resolved_verified: 0,
      resolved_ids: [],
      returned: 0,
      re_tiered: 0,
      ...over,
    };
  }

  // A run dir as `pr-hero review --pr <n>` leaves it: findings.json,
  // diff.patch AND pipeline.json. `writeRunDir` deliberately writes only the
  // first two — pipeline.json stays optional, so every first-review post in
  // the suite above keeps proving that path unchanged.
  async function writeRereviewRunDir(
    pipeline: Record<string, unknown> | null,
    docOverrides: Partial<FindingsDocument> = {},
  ): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const { dir, cleanup } = await writeRunDir(docOverrides);
    if (pipeline !== null) {
      await Bun.write(
        path.join(dir, "pipeline.json"),
        JSON.stringify(pipeline, null, 2),
      );
    }
    return { dir, cleanup };
  }

  function priorSummaryScript(): ScriptEntry[] {
    return [
      headRefOidScript(RUN_HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 200,
              user: "pr-hero",
              body: `${SUMMARY_MARKER}\n## pr-hero review`,
              updated_at: "2026-08-20T00:00:00Z",
            },
          ]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ];
  }

  function summaryPatch(calls: RecordedCall[]): string {
    const patches = calls.filter((c) =>
      c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    return patches[patches.length - 1]?.stdin ?? "";
  }

  test("the delta and the state block come from live[], never from the matcher", async () => {
    const { dir, cleanup } = await writeRereviewRunDir(
      { rereview: rereviewBlock() },
      { findings: [] },
    );
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const body = summaryPatch(calls);
      // The gate vocabulary, counted off live[]: two unconfirmed, one
      // carried, nothing resolved because nothing was checked-and-gone.
      expect(body).toContain(
        "Δ since `aaaaaaaa`: 2 unconfirmed · 1 carried · 0 deferred · 0 new",
      );
      // The matcher's shape, in any form, is the defect.
      expect(body).not.toContain("persist");
      expect(body).not.toContain("resolved (verified)");
      // §3.6: the state block, AFTER the report marker, so the next run has
      // priors with real claims instead of `priorsFromPostedMarkers`' "".
      expect(body).toContain(`<!-- pr-hero-state v=1 head=${RUN_HEAD} -->`);
      expect(body.indexOf("<!-- pr-hero-state ")).toBeGreaterThan(0);
      expect(body).toContain("the prior nobody touched");
      // C7: zero new findings is not a clean bill while priors are live.
      expect(body).not.toContain("found nothing to report");
      expect(body).toContain("`carried`");
      expect(body).toContain("`unconfirmed`");
      // Nothing was verified gone, so nothing is collapsed.
      expect(
        calls.filter((c) => c.argv.join(" ").includes("reviewThreads")),
      ).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a run dir with no rereview block refuses on a PR that already has a summary", async () => {
    // The self-perpetuating half: publishing this as a first review would
    // print the matcher delta AND write no state block, so the next
    // re-review falls back to claim-less priors.
    const { dir, cleanup } = await writeRereviewRunDir(null, {
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/no\s+`rereview` block in its pipeline\.json/);
      // Refused BEFORE any write: the summary create and the review
      // submission are both downstream of the precondition.
      expect(calls.filter((c) => c.argv.includes("--method"))).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a rereview block whose summary the PR no longer has refuses before any write", async () => {
    // The mirror direction, and the one nobody tested: the run dir DID come
    // from a re-review, but the summary it was computed against is gone from
    // the PR — deleted, or `post --from` run long enough after `review` that
    // it did not survive. `existingSummaryId === null` then routes into the
    // create-first branch, so without the precondition this publishes a BRAND
    // NEW comment carrying a `Δ since` delta, a `Still live:` list of `R###`
    // ids and a state block — none of it describing a thread that exists.
    const { dir, cleanup } = await writeRereviewRunDir(
      { rereview: rereviewBlock() },
      { findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })] },
    );
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/no longer carries a pr-hero summary comment/);
      // Refused BEFORE any write. Refusing after posting the very comment the
      // refusal is about would be worse than not refusing at all.
      expect(calls.filter((c) => c.argv.includes("--method"))).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a finding_markers block with no summary is S-A, not drift — it posts", async () => {
    // The narrowing the vanished-summary guard needs. Design obligation S-A:
    // "with the summary comment absent, L is recovered from per-finding
    // markers and the run does NOT fall to first-review semantics". Such a
    // block was computed with no summary in sight, so a missing summary at
    // post time is agreement, and its R### ids name finding threads that DO
    // still exist. A guard keyed on `rereview !== undefined` alone refuses
    // here and breaks a case the design supports.
    const { dir, cleanup } = await writeRereviewRunDir(
      { rereview: rereviewBlock({ last_head_source: "finding_markers" }) },
      { findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })] },
    );
    try {
      const { spawnFn } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).resolves.toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("an unreadable rereview block refuses before a single gh call, naming the field", async () => {
    const { dir, cleanup } = await writeRereviewRunDir({
      rereview: rereviewBlock({ live: [{ id: "R001", status: "carried" }] }),
    });
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/unreadable re-review block \(rereview\.live\[0\]\)/);
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("verified-gone findings refuse: the run dir cannot supply the priors collapse binds through", async () => {
    // `assembleLive` retires a verified-gone entry from `live[]`, so the rows
    // the collapse binding needs are exactly the rows the artifact no longer
    // holds — and re-deriving them from the PR renumbers `R###`. Refuse, and
    // name the path that still holds them.
    const { dir, cleanup } = await writeRereviewRunDir({
      rereview: rereviewBlock({
        resolved_verified: 2,
        resolved_ids: ["R004", "R005"],
      }),
    });
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(
        /records 2 verified-gone finding\(s\) \(R004, R005\)[\s\S]*review --pr 42 --post/,
      );
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("--dry-run refuses exactly what the post refuses — the preview cannot disagree", async () => {
    // A $0 gate that green-lights a run dir the live path then rejects has
    // answered a different question than the one asked.
    const missing = await writeRereviewRunDir(null);
    const verifiedGone = await writeRereviewRunDir({
      rereview: rereviewBlock({ resolved_verified: 1, resolved_ids: ["R004"] }),
    });
    try {
      const first = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: missing.dir,
          dryRun: true,
          spawnFn: first.spawnFn,
        }),
      ).rejects.toThrow(/no\s+`rereview` block in its pipeline\.json/);
      expect(
        first.calls.filter((c) => c.argv.includes("--method")),
      ).toHaveLength(0);

      const second = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: verifiedGone.dir,
          dryRun: true,
          spawnFn: second.spawnFn,
        }),
      ).rejects.toThrow(/records 1 verified-gone finding/);
      expect(second.calls).toHaveLength(0);
    } finally {
      await missing.cleanup();
      await verifiedGone.cleanup();
    }
  });

  test("--dry-run refuses the vanished summary too — both directions, one answer", async () => {
    // The mirrored half of the same rule: a $0 preview that green-lights a
    // run dir the live path rejects has answered a different question, and
    // that is as true of the re-review-without-a-summary direction as it is
    // of the summary-without-a-rereview-block one above.
    const { dir, cleanup } = await writeRereviewRunDir(
      { rereview: rereviewBlock() },
      { findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })] },
    );
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: true,
          spawnFn,
        }),
      ).rejects.toThrow(/no longer carries a pr-hero summary comment/);
      expect(calls.filter((c) => c.argv.includes("--method"))).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a worsened prior reaches the summary — both severities, from pipeline.json", async () => {
    // W-worse through the `post --from` seam: the "returned" line is the
    // only place the summary names the severity a prior came back at.
    const { dir, cleanup } = await writeRereviewRunDir({
      rereview: rereviewBlock({
        worsened: [
          { priorId: "R001", priorSev: "WARNING", discoverySev: "CRITICAL" },
        ],
      }),
    });
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      expect(
        await runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).toBe(0);
      expect(summaryPatch(calls)).toContain(
        "returned R001: WARNING → CRITICAL",
      );
    } finally {
      await cleanup();
    }
  });

  test("a pipeline.json that is not JSON refuses before a single gh call", async () => {
    const { dir, cleanup } = await writeRereviewRunDir(null);
    try {
      await Bun.write(path.join(dir, "pipeline.json"), "{ not json");
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/pipeline\.json is not valid JSON/);
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a first review is untouched: no summary, no block, matcher delta stays", async () => {
    // The regression boundary. `post --from` on a PR with no prior pr-hero
    // comment is not a re-review and must keep rendering byte-identically.
    const { dir, cleanup } = await writeRereviewRunDir(null, {
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(RUN_HEAD),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const body = summaryPatch(calls);
      expect(body).toContain("1 new · 0 persist");
      expect(body).not.toContain("<!-- pr-hero-state ");
    } finally {
      await cleanup();
    }
  });
});

// anchor.patch is the full PR diff inline comments anchor against; diff.patch
// is the push delta on an incremental re-review. post --from must anchor on
// anchor.patch when the run dir has one, and fall back to diff.patch for run
// dirs written before anchor.patch existed.
describe("runPostCommand — anchor.patch is the anchoring diff", () => {
  test("a finding anchorable only in anchor.patch is planned inline, not outside", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    await Bun.write(
      path.join(dir, "diff.patch"),
      diffAddingLines("src/b.ts", 200),
    );
    await Bun.write(
      path.join(dir, "anchor.patch"),
      diffAddingLines("src/a.ts", 200),
    );
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const { spawnFn } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(chunks.join("")).not.toContain("outside src/a.ts:10 F001");
    } finally {
      process.stderr.write = origWrite;
      await cleanup();
    }
  });

  test("a run dir without anchor.patch falls back to diff.patch", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const { spawnFn } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(chunks.join("")).not.toContain("outside src/a.ts:10 F001");
    } finally {
      process.stderr.write = origWrite;
      await cleanup();
    }
  });
});
