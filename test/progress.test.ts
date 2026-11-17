// Offline tests for the progress panel's pure half: state transitions under
// the pipeline event stream, and the frame text each state renders — now a
// tree (ui/tree.ts), so the refuter's per-finding verdicts accumulate as
// leaves instead of overwriting one counter. The redraw/ticker mechanics in
// cli.ts are I/O, untested by construction.

import { describe, expect, test } from "bun:test";
import {
  applyProgressEvent,
  createPanelState,
  type PanelState,
  renderPanelLines,
  SPINNER_FRAMES,
} from "../src/progress";

const SPIN = SPINNER_FRAMES[0];

function freshState(): PanelState {
  return createPanelState("PR #1682", 0, ["reliability", "resilience"]);
}

// colors: false everywhere except the color test — plain text is what the
// transition assertions are about.
function lines(
  state: PanelState,
  nowMs: number,
  frame = 0,
  maxLines?: number,
): string[] {
  return renderPanelLines(state, nowMs, frame, false, maxLines);
}

function started(state: PanelState, models?: Record<string, string>): void {
  applyProgressEvent(
    state,
    {
      kind: "hunters-started",
      hunters: state.hunters.map((h) => h.key),
      ...(models === undefined ? {} : { models }),
    },
    1_000,
  );
}

describe("panel state transitions", () => {
  test("the header names the subject, the fan-out and the elapsed", () => {
    const rendered = lines(freshState(), 192_000);
    expect(rendered[0]).toBe(
      `${SPIN} reviewing PR #1682 · 2 hunters + refuter — 3m12s`,
    );
  });

  test("a spec without a refuter does not promise one", () => {
    const state = createPanelState("dev..HEAD", 0, ["reliability"], {
      refuter: false,
    });
    expect(lines(state, 0)[0]).toBe(
      `${SPIN} reviewing dev..HEAD · 1 hunter — 0s`,
    );
  });

  test("an enabled summarizer is present from the first frame", () => {
    const state = createPanelState("PR #1682", 0, ["reliability"], {
      refuter: false,
      summarizer: true,
    });
    expect(state.summarizer).toEqual({ status: "running" });
    expect(lines(state, 0)).toEqual([
      `${SPIN} reviewing PR #1682 · 1 hunter — 0s`,
      "├─ · reliability  waiting",
      `└─ ${SPIN} summarizer   0s`,
    ]);
  });

  test("summarizer completion and failure only change its cosmetic row", () => {
    const completed = createPanelState("PR #1682", 0, ["reliability"], {
      refuter: false,
      summarizer: true,
    });
    applyProgressEvent(
      completed,
      { kind: "summarizer-finished", ok: true, durationMs: 2_000 },
      2_000,
    );
    expect(lines(completed, 2_000)).toEqual([
      `${SPIN} reviewing PR #1682 · 1 hunter — 2s`,
      "├─ · reliability  waiting",
      "└─ ✓ summarizer   2s",
    ]);

    const failed = createPanelState("PR #1682", 0, ["reliability"], {
      refuter: false,
      summarizer: true,
    });
    applyProgressEvent(
      failed,
      { kind: "summarizer-finished", ok: false, durationMs: 3_000 },
      3_000,
    );
    expect(lines(failed, 3_000).at(-1)).toBe(
      "└─ ✗ summarizer   failed — the run continues",
    );
    expect(failed.hunters[0]?.status).toBe("waiting");
    expect(failed.dedupe).toBeUndefined();
    expect(failed.refuter).toBeUndefined();
  });

  test("seeded rows wait as pending leaves of the header", () => {
    const rendered = lines(freshState(), 0);
    expect(rendered[1]).toBe("├─ · reliability  waiting");
    expect(rendered[2]).toBe("└─ · resilience   waiting");
    expect(rendered).toHaveLength(3);
  });

  test("hunters-started flips the named rows to running with elapsed", () => {
    const state = freshState();
    started(state);
    const rendered = lines(state, 63_000);
    // Elapsed measured from the fan-out's own start, not the panel's.
    expect(rendered[1]).toBe(`├─ ${SPIN} reliability  1m02s`);
    expect(rendered[2]).toBe(`└─ ${SPIN} resilience   1m02s`);
  });

  test("the resolved model, when the event names it, becomes a column", () => {
    const state = freshState();
    started(state, { reliability: "sonnet", resilience: "opus" });
    const rendered = lines(state, 63_000);
    expect(rendered[1]).toBe(`├─ ${SPIN} reliability  sonnet   1m02s`);
    expect(rendered[2]).toBe(`└─ ${SPIN} resilience   opus     1m02s`);
  });

  test("a key the seed missed is added by the authoritative event", () => {
    const state = createPanelState("PR #1682", 0, ["reliability"]);
    applyProgressEvent(
      state,
      { kind: "hunters-started", hunters: ["reliability", "parity"] },
      0,
    );
    expect(lines(state, 0).some((line) => line.includes("parity"))).toBe(true);
  });

  test("hunter-finished renders duration + drafts, or the honest failure", () => {
    const state = freshState();
    started(state);
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "reliability",
        ok: true,
        durationMs: 122_000,
        drafts: 2,
      },
      122_000,
    );
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "resilience",
        ok: false,
        durationMs: 60_000,
      },
      122_000,
    );
    const rendered = lines(state, 122_000);
    expect(rendered[1]).toBe("├─ ✓ reliability  2m02s   2 drafts");
    expect(rendered[2]).toBe("└─ ✗ resilience   failed — the run continues");
  });

  // #314: "failed" alone hid an E2BIG that killed every hunter. The reason
  // rides as a leaf under the row, so the row's own wording is unchanged.
  test("a failed hunter shows the pipeline's reason as a leaf", () => {
    const state = freshState();
    started(state);
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "resilience",
        ok: false,
        durationMs: 7_000,
        reason: "spawn failed: E2BIG: argument list too long",
      },
      7_000,
    );
    const rendered = lines(state, 7_000);
    expect(rendered[2]).toBe("└─ ✗ resilience   failed — the run continues");
    expect(rendered[3]).toBe(
      "   └─ spawn failed: E2BIG: argument list too long",
    );
    expect(renderPanelLines(state, 7_000, 0, false).join("\n")).not.toContain(
      "\x1b[",
    );
  });

  // The panel is not width-aware and its redraw counts returned lines, so a
  // leaf that wraps would orphan a row on every redraw: the leaf is capped.
  test("a long failure reason is capped to keep the leaf on one row", () => {
    const state = freshState();
    started(state);
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "resilience",
        ok: false,
        durationMs: 1_000,
        reason: "r".repeat(160),
      },
      1_000,
    );
    const leaf = lines(state, 1_000)[3] ?? "";
    expect(leaf).toBe(`   └─ ${"r".repeat(63)}…`);
  });

  test("a failed hunter without a reason renders no leaf", () => {
    const state = freshState();
    started(state);
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "resilience",
        ok: false,
        durationMs: 1_000,
      },
      1_000,
    );
    expect(lines(state, 1_000)).toHaveLength(3);
  });

  test("a failed summarizer shows its reason as a leaf", () => {
    const state = createPanelState("PR #1682", 0, ["reliability"], {
      refuter: false,
      summarizer: true,
    });
    applyProgressEvent(
      state,
      {
        kind: "summarizer-finished",
        ok: false,
        durationMs: 3_000,
        reason: "API Error: Connection closed mid-response",
      },
      3_000,
    );
    expect(lines(state, 3_000).slice(-2)).toEqual([
      "└─ ✗ summarizer   failed — the run continues",
      "   └─ API Error: Connection closed mid-response",
    ]);
    expect(renderPanelLines(state, 3_000, 0, false).join("\n")).not.toContain(
      "\x1b[",
    );
  });

  test("one draft is one draft, not one drafts", () => {
    const state = freshState();
    started(state);
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "reliability",
        ok: true,
        durationMs: 1_000,
        drafts: 1,
      },
      1_000,
    );
    expect(lines(state, 1_000)[1]).toBe("├─ ✓ reliability  1s   1 draft");
  });

  test("dedupe appends its own row", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      { kind: "dedupe-finished", drafts: 6, findings: 4 },
      0,
    );
    expect(lines(state, 0)).toContain(
      "└─ ✓ dedupe       6 drafts → 4 findings",
    );
  });

  test("the refuter fan-out accumulates one leaf per finding", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      {
        kind: "refuter-started",
        severeFindings: 2,
        findings: [
          { id: "F001", location: "src/triage-write.ts:70" },
          { id: "F002", location: "src/ledger.ts:12" },
        ],
      },
      0,
    );
    // Every leaf is running from the start: the fan-out is parallel, so there
    // is no queue to be pending in.
    let rendered = lines(state, 0);
    expect(rendered[3]).toBe(`└─ ${SPIN} refuter      judging 0 of 2`);
    expect(rendered[4]).toBe(`   ├─ ${SPIN} F001  src/triage-write.ts:70`);
    expect(rendered[5]).toBe(`   └─ ${SPIN} F002  src/ledger.ts:12`);
    applyProgressEvent(
      state,
      {
        kind: "refuter-step-finished",
        findingId: "F001",
        verdict: "corroborated",
        durationMs: 1,
      },
      0,
    );
    rendered = lines(state, 0);
    // The verdict LANDS on its own leaf and stays there — the whole point of
    // the tree over the old self-overwriting counter.
    expect(rendered[3]).toBe(`└─ ${SPIN} refuter      judging 1 of 2`);
    expect(rendered[4]).toBe(
      "   ├─ ✓ F001  src/triage-write.ts:70   corroborated",
    );
    applyProgressEvent(
      state,
      {
        kind: "refuter-step-finished",
        findingId: "F002",
        verdict: "refuted",
        durationMs: 1,
      },
      0,
    );
    rendered = lines(state, 0);
    expect(rendered[3]).toBe("└─ ✓ refuter      2 judged");
    expect(rendered[5]).toBe("   └─ ✓ F002  src/ledger.ts:12   refuted");
  });

  test("without the submitted ids the leaves appear as they settle", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      { kind: "refuter-started", severeFindings: 2 },
      0,
    );
    expect(lines(state, 0)).toHaveLength(4);
    applyProgressEvent(
      state,
      {
        kind: "refuter-step-finished",
        findingId: "F001",
        verdict: "corroborated",
        durationMs: 1,
      },
      0,
    );
    expect(lines(state, 0)[4]).toBe("   └─ ✓ F001  corroborated");
  });

  test("a step-finished event before the leg started is ignored", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      {
        kind: "refuter-step-finished",
        findingId: "F001",
        verdict: "refuted",
        durationMs: 1,
      },
      0,
    );
    expect(state.refuter).toBeUndefined();
  });

  test("a retry becomes a leaf under the hunter that is retrying", () => {
    const state = freshState();
    started(state);
    applyProgressEvent(
      state,
      {
        kind: "step-retry",
        step: "hunter-reliability",
        attempt: 2,
        maxAttempts: 2,
        reason: "transient",
      },
      2_000,
    );
    const rendered = lines(state, 63_000);
    expect(rendered[1]).toBe(`├─ ${SPIN} reliability  1m02s`);
    expect(rendered[2]).toBe("│  └─ ↻ attempt 2 of 2  transient");
    // The row survives the retry: a finished hunter that says "attempt 2"
    // explains a duration that would otherwise read as a slow model.
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "reliability",
        ok: true,
        durationMs: 63_000,
        drafts: 0,
      },
      63_000,
    );
    expect(lines(state, 63_000)[2]).toBe("│  └─ ↻ attempt 2 of 2  transient");
  });

  test("the format retry names itself instead of faking an N-of-M", () => {
    const state = freshState();
    started(state);
    applyProgressEvent(
      state,
      {
        kind: "step-retry",
        step: "hunter-resilience",
        attempt: 2,
        maxAttempts: 2,
        reason: "format",
      },
      2_000,
    );
    expect(lines(state, 2_000).at(-1)).toBe("   └─ ↻ format retry");
  });

  test("a refuter step's retry is not drawn in the panel", () => {
    const state = freshState();
    started(state);
    const before = lines(state, 2_000);
    applyProgressEvent(
      state,
      {
        kind: "step-retry",
        step: "refuter-F001",
        attempt: 2,
        maxAttempts: 2,
        reason: "transient",
      },
      2_000,
    );
    expect(lines(state, 2_000)).toEqual(before);
  });

  test("a retry naming a hunter the panel does not know is ignored", () => {
    const state = freshState();
    started(state);
    const before = lines(state, 2_000);
    applyProgressEvent(
      state,
      {
        kind: "step-retry",
        step: "hunter-nope",
        attempt: 2,
        maxAttempts: 2,
        reason: "transient",
      },
      2_000,
    );
    expect(lines(state, 2_000)).toEqual(before);
  });

  test("the spinner advances with the frame index and wraps", () => {
    const state = freshState();
    expect(lines(state, 0, 1)[0]?.startsWith(SPINNER_FRAMES[1] ?? "")).toBe(
      true,
    );
    expect(
      lines(state, 0, SPINNER_FRAMES.length)[0]?.startsWith(SPIN ?? ""),
    ).toBe(true);
  });

  test("colors paint the symbols and dim the waiting rows only when asked", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      { kind: "hunters-started", hunters: ["reliability"] },
      0,
    );
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "reliability",
        ok: true,
        durationMs: 0,
      },
      0,
    );
    const colored = renderPanelLines(state, 0, 0, true);
    expect(colored[1]).toContain("\x1b[32m✓\x1b[0m");
    expect(colored[2]).toContain("\x1b[2m");
    const plain = renderPanelLines(state, 0, 0, false);
    expect(plain.join("\n")).not.toContain("\x1b[");
  });
});

// The panel is redrawn with cursor-up arithmetic against the line count it
// last emitted, so a tree that outgrows the terminal corrupts the screen.
// These are the assertions that keep that impossible.
describe("the height bound", () => {
  function refuterState(count: number, judged: number): PanelState {
    const state = createPanelState("PR #6", 0, ["reliability"]);
    started(state);
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "reliability",
        ok: true,
        durationMs: 1_000,
        drafts: count,
      },
      1_000,
    );
    applyProgressEvent(
      state,
      { kind: "dedupe-finished", drafts: count, findings: count },
      1_000,
    );
    applyProgressEvent(
      state,
      {
        kind: "refuter-started",
        severeFindings: count,
        findings: Array.from({ length: count }, (_, i) => ({
          id: `F${String(i + 1).padStart(3, "0")}`,
          location: `src/a.ts:${i + 1}`,
        })),
      },
      1_000,
    );
    for (let i = 0; i < judged; i++) {
      applyProgressEvent(
        state,
        {
          kind: "refuter-step-finished",
          findingId: `F${String(i + 1).padStart(3, "0")}`,
          verdict: "corroborated",
          durationMs: 1,
        },
        1_000,
      );
    }
    return state;
  }

  test("the returned line count never exceeds maxLines", () => {
    for (const max of [1, 2, 4, 8, 12, 20]) {
      for (const count of [1, 3, 20, 120]) {
        for (const judged of [0, 1, count]) {
          const rendered = lines(refuterState(count, judged), 5_000, 0, max);
          expect(rendered.length).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  test("maxLines 1 keeps the header — the one line that names the run", () => {
    const rendered = lines(refuterState(20, 3), 5_000, 0, 1);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("reviewing PR #6");
  });

  test("a finished leg collapses to its summary before anything is elided", () => {
    const rendered = lines(refuterState(6, 6), 5_000, 0, 5);
    expect(rendered.at(-1)).toBe("└─ ✓ refuter      6 judged  (+6 hidden)");
    // Four lines under a five-line budget: collapsing is enough, so nothing
    // is elided and every remaining row is a whole row.
    expect(rendered).toHaveLength(4);
  });

  test("a leg still running is elided in the middle, and says how much", () => {
    const rendered = lines(refuterState(40, 2), 5_000, 0, 8);
    expect(rendered).toHaveLength(8);
    expect(rendered[0]).toContain("reviewing PR #6");
    expect(rendered.some((line) => line.includes("lines hidden"))).toBe(true);
    // The tail is what just happened, so the newest leaves survive.
    expect(rendered.at(-1)).toBe(`   └─ ${SPIN} F040  src/a.ts:40`);
  });

  test("a bounded frame with styles off still carries no escape byte", () => {
    const rendered = lines(refuterState(40, 2), 5_000, 0, 8);
    expect(rendered.join("\n")).not.toContain("\x1b[");
  });
});
