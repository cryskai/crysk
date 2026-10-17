import { describe, expect, test } from "bun:test";
import { discoveryHunters, resolvePrDiscovery } from "#pr/discovery";
import { skippedDiscoveryMessage } from "#rereview/plan";
import type { AgentSpec } from "#review/spec";
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
        parityFires: true,
      }),
    ).toEqual([]);
  });

  test("skipDiscovery false selects hunters exactly like selectActiveHunters", () => {
    const result = discoveryHunters({
      skipDiscovery: false,
      agents: [HUNTER_A, HUNTER_B],
      parityFires: false,
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
      config: { parity_trigger_paths: [], suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerComment(false)],
      postedFindings: [POSTED_FINDING],
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
      config: { parity_trigger_paths: [], suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerComment(true)],
      postedFindings: [POSTED_FINDING],
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
      config: { parity_trigger_paths: [], suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerCommentForHead(H, true)],
      postedFindings: [
        {
          ...POSTED_FINDING,
          marker: { ...POSTED_FINDING.marker, headSha: H },
        },
      ],
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
      config: { parity_trigger_paths: [], suspicion_priors: [] },
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
      config: { parity_trigger_paths: [], suspicion_priors: [] },
      prIgnore: { rules: parseIgnoreFile("dist/**\n", "user"), found: true },
      issueComments: [markerCommentForHead(L, true)],
      postedFindings: [],
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
      config: { parity_trigger_paths: [], suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerCommentForHead(H, true)],
      postedFindings: [
        {
          ...POSTED_FINDING,
          marker: { ...POSTED_FINDING.marker, headSha: H },
        },
      ],
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
      config: { parity_trigger_paths: [], suspicion_priors: [] },
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

  function run(adjudicate: boolean | undefined) {
    return resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: true,
      sizeGateOverrides: {},
      config: { parity_trigger_paths: [], suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerCommentForHead(L, true)],
      postedFindings: [POSTED_FINDING],
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
      ],
      git: baseGit(),
      log: () => {},
      ...(adjudicate === undefined ? {} : { adjudicate }),
    });
  }

  test("without --adjudicate the queue is empty", async () => {
    const result = await run(false);
    expect(result.adjudicationQueue).toEqual([]);
  });

  test("with --adjudicate a pending dismissal of a blocking prior is queued", async () => {
    const result = await run(true);
    expect(result.adjudicationQueue.map((s) => s.priorId)).toEqual(["R001"]);
    expect(result.adjudicationQueue[0]?.threadId).toBe(POSTED_FINDING.id);
    expect(result.adjudicationQueue[0]?.replyId).toBe(200);
  });
});
