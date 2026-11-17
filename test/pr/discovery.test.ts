import { describe, expect, test } from "bun:test";
import {
  AllExcludedError,
  discoveryHunters,
  type PrDiscoveryGit,
  resolvePrDiscovery,
} from "#pr/discovery";
import { patchNumstat } from "#rereview/base-merge-filter";
import { skippedDiscoveryMessage } from "#rereview/plan";
import { renderStateBlock, stateFinding } from "#rereview/state";
import { allExcludedMessage } from "#review/preflight";
import { evaluateSizeGate } from "#review/size-gate";
import type { AgentSpec } from "#review/spec";
import { adjudicationMarker, CI_ADJUDICATOR_LOGIN } from "#triage/adjudication";
import { triageMarker } from "#triage/triage";
import { CliError } from "../../src/errors";
import { parseIgnoreFile } from "../../src/ignore-file";

const HUNTER_A: AgentSpec = {
  key: "hunter-a",
  role: "hunter",
  file: "hunter-a.md",
};
const HUNTER_B: AgentSpec = {
  key: "hunter-b",
  role: "hunter",
  file: "hunter-b.md",
  trigger: ["some/path/**"],
};

// Invariant 1 (rereview-coverage fix): the gate is `skipDiscovery` ALONE —
// never a hardcoded case check that would silently reintroduce the exact
// defect the fix closes (a case-B re-review that skips discovery even when
// it has something to discover).
describe("discoveryHunters", () => {
  test("skipDiscovery true returns no hunters regardless of triggers", () => {
    expect(
      discoveryHunters({
        skipDiscovery: true,
        agents: [HUNTER_A, HUNTER_B],
      }),
    ).toEqual([]);
  });

  test("skipDiscovery false selects hunters exactly like selectActiveHunters", () => {
    const result = discoveryHunters({
      skipDiscovery: false,
      agents: [HUNTER_A, HUNTER_B],
    });
    expect(result.map((a) => a.key)).toEqual(["hunter-a"]);
  });
});

const L = "1111111111111111111111111111111111111111";
const H = "2222222222222222222222222222222222222222";
const B = "3333333333333333333333333333333333333333";
const PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/src/a.ts\n" +
  "+++ b/src/a.ts\n" +
  "@@ -1 +1 @@\n" +
  "-old\n" +
  "+new\n";

function fakeRunGit(args: string[]) {
  if (args[0] === "diff" && args.includes("--numstat")) {
    return Promise.resolve({
      ok: true,
      stdout: "1\t1\tsrc/a.ts\n",
      stderr: "",
    });
  }
  return Promise.resolve({ ok: true, stdout: PATCH, stderr: "" });
}

function baseGit() {
  return {
    commitExists: () => Promise.resolve(true),
    isAncestor: () => Promise.resolve(true),
    nameOnly: () => Promise.resolve([] as string[]),
    nameStatus: () => Promise.resolve(""),
    runGit: fakeRunGit,
  };
}

function markerComment(complete: boolean) {
  const coverage = complete ? "" : " coverage=partial";
  return {
    id: 1,
    user: "pr-hero",
    body: `<!-- pr-hero-report head=${L}${coverage} -->\n\nprevious review body`,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

// Every login the fixtures reply as is a writer, so the existing expectations hold. A test that
// depends on a login's permission passes its own map.
const WRITERS: ReadonlyMap<string, boolean | null> = new Map([
  ["pr-hero", true],
  ["reviewer", true],
  ["someone", true],
  ["author", true],
  [CI_ADJUDICATOR_LOGIN, true],
  ["crysk-app[bot]", true],
]);

const POSTED_FINDING = {
  id: 100,
  channel: "review" as const,
  marker: { path: "src/a.ts", line: 10, headSha: L, c: "abc" },
  created_at: "2026-01-01T00:00:00Z",
};

// Invariants 2 & 3 together (rereview-coverage fix): a PARTIAL prior review
// must force `plan.verifyAll: true` (invariant 2 — the marker's own
// completeness, not a hardcoded default), and that `verifyAll` must actually
// reach `buildPhaseBQueue` so an untouched, untriaged prior gets QUEUED for
// re-verification rather than silently carried forward unexamined
// (invariant 3 — the wiring gap the fix closes). Both are proven through the
// real outcome — which queue the prior lands in — not by inspecting an
// intermediate field.
describe("resolvePrDiscovery — rereview-coverage fix (invariants 2 & 3)", () => {
  test("a partial last review forces verifyAll and queues an untouched prior for re-verification", async () => {
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerComment(false)],
      postedFindings: [POSTED_FINDING],
      replyWriters: WRITERS,
      reviewComments: [],
      git: baseGit(),
      log: () => {},
    });
    expect(result.prepared.plan.verifyAll).toBe(true);
    expect(result.verifyQueue.map((v) => v.priorId)).toEqual(["R001"]);
    expect(result.overlapCandidates).toEqual([]);
  });

  test("a complete last review does not force verifyAll, and the same untouched prior is carried instead", async () => {
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerComment(true)],
      postedFindings: [POSTED_FINDING],
      replyWriters: WRITERS,
      reviewComments: [],
      git: baseGit(),
      log: () => {},
    });
    expect(result.prepared.plan.verifyAll).toBe(false);
    expect(result.verifyQueue).toEqual([]);
    expect(result.overlapCandidates.map((v) => v.priorId)).toEqual(["R001"]);
  });
});

function markerCommentForHead(head: string, complete: boolean) {
  const coverage = complete ? "" : " coverage=partial";
  return {
    id: 1,
    user: "pr-hero",
    body: `<!-- pr-hero-report head=${head}${coverage} -->\n\nprevious review body`,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

// GitHub #166: a re-review whose head equals the last reviewed head (case B,
// `L === H`) is not a rare edge — a merged PR's head can never advance, so
// EVERY local re-run of a merged PR lands here. Discovery correctly finds
// nothing to discover and runs zero discovery hunters; this suite pins the
// two halves of the fix: (1) goal 1 — that "zero hunters ran" does not mean
// "priors are dropped", Phase B still classifies and carries them; (2) goal
// 3 — that the skip is no longer silent on the CLI/CI log.
//
// pr-hero review #286 then found the notice itself asserted facts the flag
// does not carry: "no hunter ran... not re-verified" is false whenever a
// verifier IS queued in the same pass (case B's `case_b_reply` trigger,
// rereview/classify.ts ~143-151). The notice now prints only AFTER
// `verifyQueue` is known (discovery.ts moved the log call past the Phase B
// block), and names the real count instead of a blanket "not re-verified".
describe("resolvePrDiscovery — case B same-head re-review (GitHub #166)", () => {
  test("skips discovery, marks the provenance, and logs a one-line operator notice", async () => {
    const logs: string[] = [];
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerCommentForHead(H, true)],
      postedFindings: [
        {
          ...POSTED_FINDING,
          marker: { ...POSTED_FINDING.marker, headSha: H },
        },
      ],
      replyWriters: WRITERS,
      reviewComments: [],
      git: baseGit(),
      log: (line) => {
        if (line !== undefined) logs.push(line);
      },
    });

    expect(result.prepared.case).toBe("B");
    expect(result.skipDiscovery).toBe(true);
    expect(result.rawDiff).toBe("");
    expect(result.rereview?.discovery_skipped_empty_delta).toBe(true);
    // #286: no reason to distrust the delta (a genuinely empty one, not an
    // excluded one) — reason is "no_delta", never "all_excluded".
    expect(result.rereview?.discovery_skip_reason).toBe("no_delta");
    expect(logs.some((line) => line.includes("No discovery hunter ran"))).toBe(
      true,
    );
    // #286: nothing was queued for verification this pass — the notice must
    // say so plainly, never the blanket (and here false-adjacent) "not
    // re-verified" the old wording used.
    expect(
      logs.some((line) =>
        line.includes("No prior finding is queued for re-verification"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("not re-verified"))).toBe(false);
  });

  // #286 finding 2/5: case B's `case_b_reply` trigger (rereview/classify.ts
  // ~143-151) queues a prior for THIS pass's verifier even though discovery
  // itself is skipped — the notice must reflect the real queue, not a
  // blanket claim made before the queue existed.
  test("a case-B reply queues a prior for verification, and the notice says so", async () => {
    const logs: string[] = [];
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerCommentForHead(H, true)],
      postedFindings: [
        {
          ...POSTED_FINDING,
          marker: { ...POSTED_FINDING.marker, headSha: H },
        },
      ],
      // A reply on the finding's own thread AFTER the summary was posted —
      // exactly what `enrichPriorsFromThreads` reads to set
      // `newThreadReply: true`, the input `classifyPrior`'s case-B branch
      // gates on.
      replyWriters: WRITERS,
      reviewComments: [
        {
          id: 900,
          user: "reviewer",
          body: "still an issue?",
          path: "src/a.ts",
          line: 10,
          original_line: 10,
          in_reply_to_id: POSTED_FINDING.id,
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
      git: baseGit(),
      log: (line) => {
        if (line !== undefined) logs.push(line);
      },
    });

    expect(result.verifyQueue.map((v) => v.priorId)).toEqual(["R001"]);
    expect(
      logs.some((line) =>
        line.includes("1 prior finding is re-verified this pass."),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("not re-verified"))).toBe(false);
    expect(
      logs.some((line) => line.includes("No prior finding is queued")),
    ).toBe(false);
  });

  // A prior with no comment of its own: GitHub could not anchor the finding, so it
  // lives only as row R001 in the summary's state block. Its answer is a top-level
  // comment whose triage marker names that row.
  test("an applied reply to a prior with no comment queues it for verification", async () => {
    const logs: string[] = [];
    const summary = `${markerCommentForHead(H, true).body}\n\n${renderStateBlock(
      H,
      [
        stateFinding({
          id: "R001",
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: ["src/a.ts:10"],
          claim: "a finding GitHub could not anchor",
        }),
      ],
      1,
      1,
    )}`;
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [
        { ...markerCommentForHead(H, true), body: summary },
        {
          id: 2,
          user: "pr-hero",
          body: `${triageMarker({
            tag: "applied",
            headSha: H,
            actor: "agent",
            row: "R001",
          })}\n\nfixed in x`,
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
      postedFindings: [],
      replyWriters: WRITERS,
      reviewComments: [],
      git: baseGit(),
      log: (line) => {
        if (line !== undefined) logs.push(line);
      },
    });

    expect(result.verifyQueue.map((v) => v.priorId)).toEqual(["R001"]);
  });

  // #286 finding 1: a REAL, non-empty delta that the size gate / ignore
  // rules excluded entirely is a different truth than "nothing changed" —
  // `filterDiffByIgnoreRules` (wired through `gateConfig.excludeRules`)
  // drops the only changed file, and the notice/provenance must say WHAT was
  // excluded, never "no changes".
  test("a real delta entirely excluded by ignore rules names the reason and the paths", async () => {
    const logs: string[] = [];
    const excludingGit = {
      ...baseGit(),
      // Case B's `skipPlannedDiscovery` short-circuits before the real diff
      // is ever read, so this exercises case C instead (L reachable, an
      // ancestor of H, but L !== H): a genuine restricted delta whose ONLY
      // file is `dist/bundle.js`, on both the PR range and the delta range,
      // so `restrictedDiscoveryFiles`'s intersection is non-empty and
      // discovery proceeds to actually read (and then exclude) a real diff.
      nameOnly: () => Promise.resolve(["dist/bundle.js"]),
      runGit: (args: string[]) => {
        if (args[0] === "diff" && args.includes("--numstat")) {
          return Promise.resolve({
            ok: true,
            stdout: "1\t1\tdist/bundle.js\n",
            stderr: "",
          });
        }
        return Promise.resolve({
          ok: true,
          stdout:
            "diff --git a/dist/bundle.js b/dist/bundle.js\n" +
            "index 1111111..2222222 100644\n" +
            "--- a/dist/bundle.js\n" +
            "+++ b/dist/bundle.js\n" +
            "@@ -1 +1 @@\n" +
            "-old\n" +
            "+new\n",
          stderr: "",
        });
      },
    };
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: parseIgnoreFile("dist/**\n", "user"), found: true },
      issueComments: [markerCommentForHead(L, true)],
      postedFindings: [],
      replyWriters: WRITERS,
      reviewComments: [],
      git: excludingGit,
      log: (line) => {
        if (line !== undefined) logs.push(line);
      },
    });

    expect(result.skipDiscovery).toBe(true);
    expect(result.rereview?.discovery_skip_reason).toBe("all_excluded");
    expect(result.rereview?.discovery_excluded_paths).toEqual([
      "dist/bundle.js",
    ]);
    expect(
      logs.some(
        (line) =>
          line.includes("Every changed file") && line.includes("excluded"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("No changes to discover"))).toBe(
      false,
    );
  });

  test("goal 1 — a live prior is carried through Phase B, never silently dropped", async () => {
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerCommentForHead(H, true)],
      postedFindings: [
        {
          ...POSTED_FINDING,
          marker: { ...POSTED_FINDING.marker, headSha: H },
        },
      ],
      replyWriters: WRITERS,
      reviewComments: [],
      git: baseGit(),
      log: () => {},
    });

    // Phase B ran (not skipped): the prior settles "carried" — still live,
    // not touched, not queued for re-verification — rather than vanishing
    // because discovery itself found nothing new to read.
    expect(result.phaseB).toBeDefined();
    expect(result.phaseB?.settled.map((s) => s.status)).toEqual(["carried"]);
    expect(result.phaseB?.priors.map((p) => p.id)).toEqual(["R001"]);
  });
});

// pr-hero on #286: the Phase B queue is capped downstream at
// max_verification_steps, and priors past the cap are marked unconfirmed, not
// re-verified. The notice must state the capped number, never the raw queue.
describe("skippedDiscoveryMessage — the verification cap (#286)", () => {
  const base = {
    headSha: H,
    reason: "no_delta" as const,
    excludedPaths: [] as string[],
  };

  test("a queue within the cap says every queued prior is re-verified", () => {
    const line = skippedDiscoveryMessage({
      ...base,
      queuedForVerification: 3,
      maxVerificationSteps: 8,
    });
    expect(line).toContain("3 prior findings are re-verified this pass.");
    expect(line).not.toContain("unconfirmed");
  });

  test("a queue over the cap names the verified count and the capped remainder", () => {
    const line = skippedDiscoveryMessage({
      ...base,
      queuedForVerification: 12,
      maxVerificationSteps: 8,
    });
    expect(line).toContain("8 prior findings are re-verified this pass");
    expect(line).toContain(
      "4 more stay unconfirmed (max_verification_steps 8)",
    );
    expect(line).not.toContain("12 prior findings");
  });

  test("a cap of 0 never claims a re-verification", () => {
    const line = skippedDiscoveryMessage({
      ...base,
      queuedForVerification: 2,
      maxVerificationSteps: 0,
    });
    expect(line).toContain("No prior finding is re-verified this pass");
    expect(line).toContain("2 stay unconfirmed");
  });
});

// #206 follow-up (pr-hero on #285): review comments and issue comments are
// different GitHub resources, and nothing documents that their numeric ids
// share a namespace. A posted inline finding must recover ITS OWN body even
// when an issue comment carries the same id — otherwise the prior silently
// inherits another comment's severity, which is worse than UNRECOVERABLE.
describe("resolvePrDiscovery — #206 body recovery keys by comment kind", () => {
  test("an issue comment sharing an inline finding's id never supplies its severity", async () => {
    const inlineBody =
      `<!-- pr-hero-finding path=src%2Fa.ts line=10 head=${L} c=abc -->\n` +
      "\n" +
      "🔴 blocking · BLOCKER · introduced · reliability\n" +
      "`src/a.ts:10`\n" +
      "\n" +
      "the retry loop never clears the prior timer\n";
    const collidingIssueBody =
      "🟡 advisory · WARNING · introduced · logic\n" +
      "`src/other.ts:1`\n" +
      "\n" +
      "an unrelated issue comment that happens to share the id\n";
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [
        markerComment(false),
        {
          id: POSTED_FINDING.id,
          user: "someone",
          body: collidingIssueBody,
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      postedFindings: [POSTED_FINDING],
      replyWriters: WRITERS,
      reviewComments: [
        {
          id: POSTED_FINDING.id,
          user: "pr-hero",
          body: inlineBody,
          path: "src/a.ts",
          line: 10,
          original_line: 10,
          in_reply_to_id: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      git: baseGit(),
      log: () => {},
    });
    expect(result.verifyQueue.map((v) => v.sev)).toEqual(["BLOCKER"]);
    expect(result.verifyQueue[0]?.claim).toContain(
      "the retry loop never clears the prior timer",
    );
  });
});

// T5b: `--adjudicate` makes discovery hand back the pending dismissals of
// blocking priors. The queue is empty unless the flag is set, so a normal run
// never spends an adjudicator call.
describe("resolvePrDiscovery — T5b adjudication queue", () => {
  const INLINE_BLOCKING =
    `<!-- pr-hero-finding path=src%2Fa.ts line=10 head=${L} c=abc -->\n` +
    "\n" +
    "🔴 blocking · BLOCKER · introduced · reliability\n" +
    "`src/a.ts:10`\n" +
    "\n" +
    "the retry loop never clears the prior timer\n";
  const DISMISSED_REPLY =
    `<!-- pr-hero-triage tag=dismissed head=${H} actor=agent verdict=upheld -->\n` +
    "\n" +
    "the timer is cleared in the caller\n";

  type ReviewComment = NonNullable<
    Parameters<typeof resolvePrDiscovery>[0]["reviewComments"]
  >[number];

  type RunOptions = {
    writers?: ReadonlyMap<string, boolean | null>;
    log?: (line?: string) => void;
  };

  function run(adjudicate: boolean | undefined) {
    return runWithReplies(adjudicate, []);
  }

  function runWithReplies(
    adjudicate: boolean | undefined,
    extraReplies: readonly ReviewComment[],
    options: RunOptions = {},
  ) {
    return resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: true,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerCommentForHead(L, true)],
      postedFindings: [POSTED_FINDING],
      replyWriters: options.writers ?? WRITERS,
      reviewComments: [
        {
          id: POSTED_FINDING.id,
          user: "pr-hero",
          body: INLINE_BLOCKING,
          path: "src/a.ts",
          line: 10,
          original_line: 10,
          in_reply_to_id: null,
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: 200,
          user: "author",
          body: DISMISSED_REPLY,
          path: "src/a.ts",
          line: 10,
          original_line: 10,
          in_reply_to_id: POSTED_FINDING.id,
          created_at: "2026-01-02T00:00:00Z",
        },
        ...extraReplies,
      ],
      git: baseGit(),
      log: options.log ?? (() => {}),
      ...(adjudicate === undefined ? {} : { adjudicate }),
    });
  }

  test("without --adjudicate the queue is empty", async () => {
    const result = await run(false);
    expect(result.adjudicationQueue).toEqual([]);
  });

  test("a CI verdict on another head does not take the dismissal out of the queue", async () => {
    const otherHead = "c".repeat(40);
    const result = await runWithReplies(true, [
      {
        id: 201,
        user: CI_ADJUDICATOR_LOGIN,
        body: adjudicationMarker({
          verdict: "upheld",
          reply: 200,
          head: otherHead,
        }),
        path: "src/a.ts",
        line: 10,
        original_line: 10,
        in_reply_to_id: POSTED_FINDING.id,
        created_at: "2026-01-03T00:00:00Z",
      },
    ]);
    expect(result.adjudicationQueue.map((s) => s.priorId)).toEqual(["R001"]);
  });

  test("with --adjudicate a pending dismissal of a blocking prior is queued", async () => {
    const result = await run(true);
    expect(result.adjudicationQueue.map((s) => s.priorId)).toEqual(["R001"]);
    expect(result.adjudicationQueue[0]?.threadId).toBe(POSTED_FINDING.id);
    expect(result.adjudicationQueue[0]?.replyId).toBe(200);
  });

  // A blocking finding GitHub could not anchor: it is row R001 of the summary, and its
  // dismissal is a top-level reply naming that row (reply 2).
  function summaryRowRun(
    extraIssueComments: readonly {
      id: number;
      user: string;
      body: string;
      created_at?: string;
    }[],
    summaryUser?: string,
    options: RunOptions = {},
  ) {
    const summary = `${markerCommentForHead(L, true).body}\n\n${renderStateBlock(
      L,
      [
        stateFinding({
          id: "R001",
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: ["src/a.ts:10"],
          claim: "a finding GitHub could not anchor",
        }),
      ],
      1,
      1,
    )}`;
    return resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: true,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [
        {
          ...markerCommentForHead(L, true),
          body: summary,
          ...(summaryUser === undefined ? {} : { user: summaryUser }),
        },
        ...extraIssueComments,
      ],
      postedFindings: [],
      replyWriters: options.writers ?? WRITERS,
      reviewComments: [],
      git: baseGit(),
      log: options.log ?? (() => {}),
      adjudicate: true,
    });
  }

  const ROW_DISMISSAL = {
    id: 2,
    user: "author",
    body: `${triageMarker({ tag: "dismissed", headSha: H, actor: "human", verdict: "upheld", row: "R001" })}\n\nthe timer is cleared in the caller`,
    created_at: "2026-01-02T00:00:00Z",
  };

  test("a dismissed reply to a prior with no comment is queued with --adjudicate", async () => {
    const result = await summaryRowRun([ROW_DISMISSAL]);
    expect(result.adjudicationQueue.map((s) => s.priorId)).toEqual(["R001"]);
    expect(result.adjudicationQueue[0]?.replyId).toBe(2);
    expect(
      result.adjudicationQueue[0] && "threadId" in result.adjudicationQueue[0],
    ).toBe(false);
  });

  test("a dismissed reply to a prior with no comment is not queued once the CI bot upheld it", async () => {
    const result = await summaryRowRun([
      ROW_DISMISSAL,
      {
        id: 3,
        user: CI_ADJUDICATOR_LOGIN,
        body: adjudicationMarker({ verdict: "upheld", reply: 2, head: H }),
        created_at: "2026-01-03T00:00:00Z",
      },
    ]);
    expect(result.adjudicationQueue).toEqual([]);
  });

  test("in platform mode the platform bot's ruling counts when that bot posted the summary", async () => {
    const previous = process.env.CRYSK_PLATFORM_ACTOR;
    process.env.CRYSK_PLATFORM_ACTOR = "crysk-app[bot]";
    try {
      const result = await summaryRowRun(
        [
          ROW_DISMISSAL,
          {
            id: 3,
            user: "crysk-app[bot]",
            body: adjudicationMarker({ verdict: "upheld", reply: 2, head: H }),
            created_at: "2026-01-03T00:00:00Z",
          },
        ],
        "crysk-app[bot]",
      );
      expect(result.adjudicationQueue).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CRYSK_PLATFORM_ACTOR;
      else process.env.CRYSK_PLATFORM_ACTOR = previous;
    }
  });

  test("in platform mode the platform bot's ruling does not count when another bot posted the summary", async () => {
    const previous = process.env.CRYSK_PLATFORM_ACTOR;
    process.env.CRYSK_PLATFORM_ACTOR = "crysk-app[bot]";
    try {
      const result = await summaryRowRun(
        [
          ROW_DISMISSAL,
          {
            id: 3,
            user: "crysk-app[bot]",
            body: adjudicationMarker({ verdict: "upheld", reply: 2, head: H }),
            created_at: "2026-01-03T00:00:00Z",
          },
        ],
        "github-actions[bot]",
      );
      expect(result.adjudicationQueue.map((s) => s.priorId)).toEqual(["R001"]);
    } finally {
      if (previous === undefined) delete process.env.CRYSK_PLATFORM_ACTOR;
      else process.env.CRYSK_PLATFORM_ACTOR = previous;
    }
  });

  // The review reads a triage reply only from a login with write access, the rule the gate and
  // crysk status apply (triage/reply.ts countedTriageReplies).
  function writersWith(login: string, writer: boolean | null) {
    const writers = new Map(WRITERS);
    writers.set(login, writer);
    return writers;
  }

  function collectLog(logged: string[]) {
    return (line?: string) => {
      if (line !== undefined) logged.push(line);
    };
  }

  function priorTriageTag(result: {
    phaseB?: { priors: { id: string; triage: { tag: string } | null }[] };
  }) {
    return (
      result.phaseB?.priors.find((prior) => prior.id === "R001")?.triage?.tag ??
      null
    );
  }

  test("a dismissed reply from a login without write access is not queued", async () => {
    const result = await runWithReplies(true, [], {
      writers: writersWith("author", false),
    });
    expect(result.adjudicationQueue).toEqual([]);
  });

  test("a dismissed row reply from a login without write access is not queued", async () => {
    const result = await summaryRowRun([ROW_DISMISSAL], undefined, {
      writers: writersWith("author", false),
    });
    expect(result.adjudicationQueue).toEqual([]);
  });

  test("a permission that did not read counts as no access", async () => {
    const logged: string[] = [];
    const nulled = await runWithReplies(true, [], {
      writers: writersWith("author", null),
      log: collectLog(logged),
    });
    expect(nulled.adjudicationQueue).toEqual([]);
    expect(
      logged.some(
        (line) =>
          line.includes("Could not read whether") && line.includes("author"),
      ),
    ).toBe(true);

    logged.length = 0;
    const missing = await runWithReplies(true, [], {
      writers: new Map<string, boolean | null>(),
      log: collectLog(logged),
    });
    expect(missing.adjudicationQueue).toEqual([]);
    expect(
      logged.some(
        (line) =>
          line.includes("Could not read whether") && line.includes("author"),
      ),
    ).toBe(true);
  });

  test("a writer's dismissal is queued as before", async () => {
    const result = await runWithReplies(true, [], {
      writers: writersWith("author", true),
    });
    expect(result.adjudicationQueue.map((s) => s.priorId)).toEqual(["R001"]);
  });

  test("an upheld dismissal from a login without write access stays counted", async () => {
    const result = await runWithReplies(
      true,
      [
        {
          id: 201,
          user: CI_ADJUDICATOR_LOGIN,
          body: adjudicationMarker({ verdict: "upheld", reply: 200, head: H }),
          path: "src/a.ts",
          line: 10,
          original_line: 10,
          in_reply_to_id: POSTED_FINDING.id,
          created_at: "2026-01-03T00:00:00Z",
        },
      ],
      { writers: writersWith("author", false) },
    );
    expect(result.adjudicationQueue).toEqual([]);
    // The non-writer's dismissal is not read at all, so the prior carries no dismissal.
    expect(priorTriageTag(result)).not.toBe("dismissed");
  });

  test("a bare applied reply from a login without write access is not read", async () => {
    const plainApplied = {
      id: 202,
      user: "author",
      body: "applied: the timer is cleared in the caller",
      path: "src/a.ts",
      line: 10,
      original_line: 10,
      in_reply_to_id: POSTED_FINDING.id,
      created_at: "2026-01-05T00:00:00Z",
    };
    const denied = await runWithReplies(false, [plainApplied], {
      writers: writersWith("author", false),
    });
    expect(priorTriageTag(denied)).not.toBe("applied");

    const allowed = await runWithReplies(false, [plainApplied], {
      writers: writersWith("author", true),
    });
    expect(priorTriageTag(allowed)).toBe("applied");
  });

  test("the note names the logins whose replies are not read", async () => {
    const logged: string[] = [];
    await runWithReplies(true, [], {
      writers: writersWith("author", false),
      log: collectLog(logged),
    });
    expect(
      logged.some(
        (line) => line.includes("are not read") && line.includes("author"),
      ),
    ).toBe(true);

    logged.length = 0;
    await runWithReplies(true, [], { log: collectLog(logged) });
    expect(logged.some((line) => line.includes("are not read"))).toBe(false);
  });

  test("a comment that is not a triage reply is untouched", async () => {
    const logged: string[] = [];
    const result = await summaryRowRun(
      [
        ROW_DISMISSAL,
        {
          id: 3,
          user: CI_ADJUDICATOR_LOGIN,
          body: adjudicationMarker({ verdict: "upheld", reply: 2, head: H }),
          created_at: "2026-01-03T00:00:00Z",
        },
      ],
      undefined,
      { writers: new Map([["author", true]]), log: collectLog(logged) },
    );
    expect(result.adjudicationQueue).toEqual([]);
    expect(logged.some((line) => line.includes("Could not read"))).toBe(false);
  });
});

// Inline anchoring (the review payload's path/line) must see the FULL PR
// diff, not the discovery diff. On an incremental re-review the discovery
// range is last-reviewed-head..head, so a finding on a line the push did not
// touch is outside the delta yet inside the PR: it was published as an
// "outside diff" comment with no review thread. `anchorPatch` is the PR-range
// diff for that anchoring; the discovery diff itself keeps its narrow range.
const SESSION_HUNK =
  "diff --git a/src/session.ts b/src/session.ts\n" +
  "index 3333333..4444444 100644\n" +
  "--- a/src/session.ts\n" +
  "+++ b/src/session.ts\n" +
  "@@ -50 +50 @@\n" +
  "-old\n" +
  "+new\n";

function rangeGit(outputs: Record<string, string>, calls: string[][]) {
  return {
    commitExists: () => Promise.resolve(true),
    isAncestor: () => Promise.resolve(true),
    nameOnly: (from: string, to: string) =>
      Promise.resolve(
        from === B && to === H ? ["src/a.ts", "src/session.ts"] : ["src/a.ts"],
      ),
    nameStatus: () => Promise.resolve(""),
    runGit: (args: string[]) => {
      calls.push(args);
      if (args.includes("--numstat")) {
        return Promise.resolve({
          ok: true,
          stdout: "1\t1\tsrc/a.ts\n",
          stderr: "",
        });
      }
      return Promise.resolve({
        ok: true,
        stdout: outputs[args[1]] ?? "",
        stderr: "",
      });
    },
  };
}

function discoveryFor(
  git: PrDiscoveryGit,
  overrides: Partial<Parameters<typeof resolvePrDiscovery>[0]>,
) {
  return resolvePrDiscovery({
    diffFromSha: B,
    headSha: H,
    full: false,
    baseRef: B,
    headLabel: "PR #1 head",
    isCi: false,
    sizeGateOverrides: {},
    config: { suspicion_priors: [] },
    prIgnore: { rules: [], found: false },
    issueComments: [markerCommentForHead(L, true)],
    postedFindings: [],
    replyWriters: WRITERS,
    reviewComments: [],
    git,
    log: () => {},
    ...overrides,
  });
}

// The stat the plan prints is the discovery range's own: the delta for an
// incremental re-review, never the whole pull request.
describe("resolvePrDiscovery — diffStat is the discovery range's stat", () => {
  function statGit(calls: string[][]) {
    const git = rangeGit(
      { [`${L}..${H}`]: PATCH, [`${B}..${H}`]: PATCH + SESSION_HUNK },
      calls,
    );
    return {
      ...git,
      runGit: (args: string[]) => {
        calls.push(args);
        if (!args.includes("--numstat")) return git.runGit(args);
        const whole = args.includes(`${B}..${H}`) && !args.includes("--");
        return Promise.resolve({
          ok: true,
          stdout: whole
            ? "1\t1\tsrc/a.ts\n9\t9\tsrc/session.ts\n"
            : "1\t1\tsrc/a.ts\n",
          stderr: "",
        });
      },
    };
  }

  test("an incremental re-review measures only the push delta", async () => {
    const result = await discoveryFor(statGit([]), {});
    expect(result.prepared.discoveryFrom).toBe(L);
    expect(result.diffStat).toEqual({ files: 1, insertions: 1, deletions: 1 });
  });
});

describe("resolvePrDiscovery — anchorPatch is the full PR diff (inline anchoring)", () => {
  test("an incremental re-review anchors against merge-base..head, not the push delta", async () => {
    const calls: string[][] = [];
    const git = rangeGit(
      { [`${L}..${H}`]: PATCH, [`${B}..${H}`]: PATCH + SESSION_HUNK },
      calls,
    );
    const result = await discoveryFor(git, {});
    expect(result.prepared.discoveryFrom).toBe(L);
    expect(result.effectiveDiff.patch).not.toContain("src/session.ts");
    expect(result.anchorPatch).toContain("src/session.ts");
    expect(result.anchorPatch).toContain("+new");
  });

  test("a full pass anchors on the discovery patch itself, with no extra git diff", async () => {
    const calls: string[][] = [];
    const git = rangeGit({ [`${B}..${H}`]: PATCH }, calls);
    const result = await discoveryFor(git, {
      full: true,
      issueComments: [],
    });
    expect(result.prepared.discoveryFrom).toBe(B);
    expect(result.anchorPatch).toBe(result.effectiveDiff.patch);
    const diffCalls = calls.filter(
      (args) => args[0] === "diff" && !args.includes("--numstat"),
    );
    expect(diffCalls.map((args) => args[1])).toEqual([`${B}..${H}`]);
  });

  test("an empty delta still anchors on the full PR diff", async () => {
    const calls: string[][] = [];
    const git = rangeGit({ [`${B}..${H}`]: PATCH + SESSION_HUNK }, calls);
    // Same-head re-review (case B): discovery is skipped, the delta is empty.
    const result = await discoveryFor(git, {
      issueComments: [markerCommentForHead(H, true)],
      postedFindings: [],
    });
    expect(result.skipDiscovery).toBe(true);
    expect(result.effectiveDiff.patch).toBe("");
    expect(result.anchorPatch).toContain("src/session.ts");
  });
});

// #317: a first review (case A) whose every changed file is excluded throws a
// typed error, so the CI path can end it as a skip instead of exit 1. It stays
// a CliError with the same message, so every other caller is unchanged.
describe("resolvePrDiscovery — a first review with every file excluded (#317)", () => {
  function excludingGit() {
    return {
      ...baseGit(),
      runGit: (args: string[]) =>
        Promise.resolve({
          ok: true,
          stdout:
            "diff --git a/dist/bundle.js b/dist/bundle.js\n" +
            "index 1111111..2222222 100644\n" +
            "--- a/dist/bundle.js\n" +
            "+++ b/dist/bundle.js\n" +
            "@@ -1 +1 @@\n" +
            "-old\n" +
            "+new\n",
          stderr: "",
          args,
        }),
    };
  }

  test("throws AllExcludedError naming the excluded paths, with the existing message", async () => {
    const run = resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: true,
      sizeGateOverrides: {},
      config: { suspicion_priors: [] },
      prIgnore: { rules: parseIgnoreFile("dist/**\n", "user"), found: true },
      issueComments: [],
      postedFindings: [],
      replyWriters: WRITERS,
      reviewComments: [],
      git: excludingGit(),
      log: () => {},
    });
    const error = await run.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AllExcludedError);
    expect(error).toBeInstanceOf(CliError);
    expect((error as AllExcludedError).droppedPaths).toEqual([
      "dist/bundle.js",
    ]);
    expect((error as Error).message).toBe(
      allExcludedMessage(["dist/bundle.js"]),
    );
  });
});

describe("resolvePrDiscovery — a merge of the base branch between reviews", () => {
  const FILE_HEADER =
    "diff --git a/src/a.ts b/src/a.ts\n" +
    "index 1111111..2222222 100644\n" +
    "--- a/src/a.ts\n" +
    "+++ b/src/a.ts\n";
  const AUTHOR_HUNK =
    "@@ -10,3 +10,3 @@\n ctx\n-author old\n+author new\n ctx\n";
  const BASE_HUNK = "@@ -80,3 +80,3 @@\n ctx\n-base old\n+base new\n ctx\n";
  // The pull request's own diff: only the author's change.
  const PR_RANGE = `${FILE_HEADER}@@ -10,3 +10,3 @@\n ctx\n-author older\n+author new\n ctx\n`;

  // The merge base is not an ancestor of the last reviewed head: the author
  // merged the base branch in between. Every other ancestry check holds.
  function mergedGit(outputs: Record<string, string>, calls: string[][]) {
    return {
      ...rangeGit(outputs, calls),
      isAncestor: (ancestor: string, descendant: string) =>
        Promise.resolve(!(ancestor === B && descendant === L)),
    };
  }

  test("leaves out the hunks the merge brought in and records how many", async () => {
    const logs: string[] = [];
    const git = mergedGit(
      {
        [`${L}..${H}`]: FILE_HEADER + AUTHOR_HUNK + BASE_HUNK,
        [`${B}..${H}`]: PR_RANGE,
      },
      [],
    );
    const result = await discoveryFor(git, {
      log: (line?: string) => {
        logs.push(line ?? "");
      },
    });
    expect(result.effectiveDiff.patch).toContain("+author new");
    expect(result.effectiveDiff.patch).not.toContain("base new");
    expect(result.rawDiff).toBe(FILE_HEADER + AUTHOR_HUNK + BASE_HUNK);
    expect(result.baseMergeHunksDropped).toBe(1);
    expect(result.rereview?.base_merge_hunks_dropped).toBe(1);
    expect(logs.some((line) => line.includes("merge of the base branch"))).toBe(
      true,
    );
  });

  test("an ordinary push reads the delta unchanged, with no second diff", async () => {
    const calls: string[][] = [];
    const git = rangeGit(
      {
        [`${L}..${H}`]: FILE_HEADER + AUTHOR_HUNK + BASE_HUNK,
        [`${B}..${H}`]: PR_RANGE,
      },
      calls,
    );
    const result = await discoveryFor(git, {});
    expect(result.rawDiff).toBe(FILE_HEADER + AUTHOR_HUNK + BASE_HUNK);
    expect(result.effectiveDiff.patch).toBe(
      FILE_HEADER + AUTHOR_HUNK + BASE_HUNK,
    );
    expect(result.baseMergeHunksDropped).toBe(0);
    expect(result.rereview?.base_merge_hunks_dropped).toBeUndefined();
    const prRangeCalls = calls.filter(
      (args) =>
        args[0] === "diff" &&
        args.includes(`${B}..${H}`) &&
        args.includes("--") &&
        !args.includes("--numstat"),
    );
    expect(prRangeCalls).toEqual([]);
    // The ordinary path still reads its stat from git's numstat.
    expect(calls.some((args) => args.includes("--numstat"))).toBe(true);
  });

  test("the stat and the size gate count the filtered delta, not the range", async () => {
    const WIDE_AUTHOR_HUNK =
      "@@ -10,3 +10,4 @@\n ctx\n-author old\n+author new\n+author more\n ctx\n";
    const WIDE_PR_RANGE = `${FILE_HEADER}@@ -10,3 +10,4 @@\n ctx\n-author older\n+author new\n+author more\n ctx\n`;
    const calls: string[][] = [];
    const git = mergedGit(
      {
        [`${L}..${H}`]: FILE_HEADER + WIDE_AUTHOR_HUNK + BASE_HUNK,
        [`${B}..${H}`]: WIDE_PR_RANGE,
      },
      calls,
    );
    const result = await discoveryFor(git, {});
    // The fake numstat would report 1 file with 1 insertion and 1 deletion.
    expect(result.diffStat).toEqual({ files: 1, insertions: 2, deletions: 1 });
    expect(calls.some((args) => args.includes("--numstat"))).toBe(false);
    expect(result.sizeGate).toEqual(
      evaluateSizeGate(
        patchNumstat(FILE_HEADER + WIDE_AUTHOR_HUNK),
        result.gateConfig,
      ),
    );
  });

  test("a delta made only of the merge skips discovery", async () => {
    const git = mergedGit(
      {
        [`${L}..${H}`]: FILE_HEADER + BASE_HUNK,
        [`${B}..${H}`]: PR_RANGE,
      },
      [],
    );
    const result = await discoveryFor(git, {});
    expect(result.skipDiscovery).toBe(true);
    expect(result.rereview?.discovery_skip_reason).toBe("no_delta");
    expect(result.rereview?.base_merge_hunks_dropped).toBe(1);
  });
});
