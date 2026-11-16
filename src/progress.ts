// The live progress panel's pure half: panel state, its transitions under
// the pipeline's event stream, and frame-text assembly. Everything here is
// testable offline; cli.ts owns the I/O half — TTY detection, the tick, and
// the ANSI cursor positioning that redraws the frame in place.
//
// Deliberately NO percentage bar anywhere: step durations are unknowable up
// front, and a fake number invites exactly the Ctrl-C this slice exists to
// cure. The honest signals are a spinner, elapsed time, and per-step
// completions.
//
// The panel is a TREE (ui/tree.ts), not a list of lines, for one reason: the
// refuter runs ONE STEP PER FINDING and those verdicts used to be a counter
// that overwrote itself (`judging F001 (1 of 2)…`), so a run's most expensive
// leg reported a number instead of its results. As leaves they ACCUMULATE and
// can be watched landing. The second level is deliberately not models:
// spec.agents assigns exactly one model per agent, so a model level would
// give every node exactly one child — a list with extra glyphs.

import type { PipelineProgressEvent } from "#review/pipeline";
import { formatElapsed } from "#review/report";
import { renderTree, type TreeNode } from "#ui/tree";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

type PanelHunterStatus = "waiting" | "running" | "done" | "failed";
type PanelSummarizerStatus = "running" | "done" | "failed";

interface PanelHunter {
  key: string;
  status: PanelHunterStatus;
  durationMs?: number;
  // Resolved model, when the pipeline named it (hunters-started carries the
  // map). Absent is normal, not an error: only the pipeline knows what
  // resolveModel decided, and the panel may render a frame before it says.
  model?: string;
  drafts?: number;
  // The latest retry this hunter's step announced, as a leaf under its row.
  // Latest only: a step retries at most twice (one transient, one format), and
  // what an operator needs is "it is retrying now", not a history.
  retry?: { attempt: number; maxAttempts: number; reason: string };
  // Why the step failed, as the pipeline's event carried it (#314).
  failureReason?: string;
}

interface PanelSummarizer {
  // The summarizer starts with the pipeline, but it has no separate started
  // event. Seeding it as running keeps the first frame truthful.
  status: PanelSummarizerStatus;
  durationMs?: number;
  failureReason?: string;
}

// One refuter leaf: a finding submitted to the gate. Every leaf is running
// from the moment the leg starts — the fan-out is parallel, so there is no
// queue to be pending in.
interface PanelRefuterLeaf {
  id: string;
  location?: string;
  status: "running" | "done";
  verdict?: string;
}

export interface PanelState {
  // What the header says is under review: "PR #1682", or "dev..HEAD".
  subject: string;
  startedAtMs: number;
  // Whether the spec wires a refuter at all ("at most one" is spec-legal, and
  // a header promising one that never runs is a lie about the plan).
  hasRefuter: boolean;
  // Stamped by the hunters-started event so running rows show the fan-out's
  // own elapsed, not the panel's.
  huntersStartedAtMs?: number;
  hunters: PanelHunter[];
  // Cosmetic only: the pipeline owns summary semantics and run status.
  // Absent means the summary step was disabled for this run.
  summarizer?: PanelSummarizer;
  dedupe?: { drafts: number; findings: number };
  refuter?: {
    total: number;
    judged: number;
    done: boolean;
    findings: PanelRefuterLeaf[];
  };
}

// Rows are seeded "waiting" from the keys the caller already resolved, so
// the panel has its full shape from the first frame; the hunters-started
// event is authoritative and reconciles the set (a key it names that the
// seed missed is added, never dropped).
export function createPanelState(
  subject: string,
  startedAtMs: number,
  hunterKeys: string[],
  opts: { refuter?: boolean; summarizer?: boolean } = {},
): PanelState {
  return {
    subject,
    startedAtMs,
    hasRefuter: opts.refuter ?? true,
    hunters: hunterKeys.map((key) => ({ key, status: "waiting" as const })),
    ...(opts.summarizer === true
      ? { summarizer: { status: "running" as const } }
      : {}),
  };
}

export function applyProgressEvent(
  state: PanelState,
  event: PipelineProgressEvent,
  nowMs: number,
): void {
  switch (event.kind) {
    case "hunters-started": {
      state.huntersStartedAtMs = nowMs;
      for (const key of event.hunters) {
        const row = state.hunters.find((h) => h.key === key);
        const model = event.models?.[key];
        if (row) {
          row.status = "running";
          if (model !== undefined) row.model = model;
        } else {
          state.hunters.push({
            key,
            status: "running",
            ...(model === undefined ? {} : { model }),
          });
        }
      }
      return;
    }
    case "hunter-finished": {
      const row = state.hunters.find((h) => h.key === event.hunter);
      if (!row) return;
      row.status = event.ok ? "done" : "failed";
      row.durationMs = event.durationMs;
      if (event.drafts !== undefined) row.drafts = event.drafts;
      if (!event.ok && event.reason !== undefined) {
        row.failureReason = event.reason;
      }
      return;
    }
    case "dedupe-finished":
      state.dedupe = { drafts: event.drafts, findings: event.findings };
      return;
    case "refuter-started":
      // The submitted ids, when the pipeline named them, become the leaves up
      // front: the leg's whole shape is then visible from its first frame
      // instead of growing out of nothing. Without them the leaves appear as
      // they settle, which is the same information one step later.
      state.refuter = {
        total: event.severeFindings,
        judged: 0,
        done: false,
        findings: (event.findings ?? []).map((f) => ({
          id: f.id,
          ...(f.location === undefined ? {} : { location: f.location }),
          status: "running" as const,
        })),
      };
      return;
    case "refuter-step-finished": {
      if (!state.refuter) return;
      state.refuter.judged += 1;
      const leaf = state.refuter.findings.find((f) => f.id === event.findingId);
      if (leaf) {
        leaf.status = "done";
        leaf.verdict = event.verdict;
      } else {
        state.refuter.findings.push({
          id: event.findingId,
          status: "done",
          verdict: event.verdict,
        });
      }
      if (state.refuter.judged >= state.refuter.total) {
        state.refuter.done = true;
      }
      return;
    }
    case "verify-started":
    case "verify-step-finished":
      return;
    case "summarizer-finished": {
      if (!state.summarizer) return;
      state.summarizer.status = event.ok ? "done" : "failed";
      state.summarizer.durationMs = event.durationMs;
      if (!event.ok && event.reason !== undefined) {
        state.summarizer.failureReason = event.reason;
      }
      return;
    }
    case "step-retry": {
      // Hunter steps only, by design: their rows are the ones an operator
      // watches for minutes at a time. A refuter step's retry is reported on
      // the non-TTY line renderer, where nothing competes for the space, and
      // a leaf under a leaf would bury the verdict the row exists to show.
      const key = event.step.startsWith("hunter-")
        ? event.step.slice("hunter-".length)
        : undefined;
      if (key === undefined) return;
      const row = state.hunters.find((h) => h.key === key);
      if (!row) return;
      row.retry = {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        reason: event.reason,
      };
      return;
    }
  }
}

// The failure-reason leaf under a failed row (#314). Capped well below the
// pipeline's own 160: this panel is not width-aware, and its redraw walks the
// cursor up by the number of LINES it returned — a leaf that wraps in the
// terminal occupies two rows the arithmetic never counted, and every redraw
// after that leaves an orphaned copy behind. The full reason is in the
// non-TTY log line and the step's artifacts.
const PANEL_REASON_MAX_CHARS = 64;

function failureReasonChildren(reason: string | undefined): TreeNode[] {
  if (reason === undefined) return [];
  return [
    {
      label:
        reason.length <= PANEL_REASON_MAX_CHARS
          ? reason
          : `${reason.slice(0, PANEL_REASON_MAX_CHARS - 1)}…`,
    },
  ];
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

// The retry leaf. "attempt N of M" only for a transient retry: the format
// retry is capped at exactly one on its OWN budget (see FORMAT_RETRY_REMINDER),
// so printing it against maxAttempts would fabricate a number the runner's WHY
// comments contradict.
function retryChildren(hunter: PanelHunter): TreeNode[] {
  const retry = hunter.retry;
  if (retry === undefined) return [];
  return [
    {
      label:
        retry.reason === "format"
          ? "↻ format retry"
          : `↻ attempt ${retry.attempt} of ${retry.maxAttempts}`,
      ...(retry.reason === "format" ? {} : { detail: retry.reason }),
    },
  ];
}

// Sub-columns are aligned by padding here, in the caller, exactly as
// ui/tree.ts's `detail` contract asks: the tree owns nesting, not layout.
function hunterNode(
  hunter: PanelHunter,
  state: PanelState,
  nowMs: number,
  labelWidth: number,
  modelWidth: number,
): TreeNode {
  const label = pad(hunter.key, labelWidth);
  // The retry leaf outlives the retry: a finished row that says "attempt 2"
  // explains a duration that would otherwise look like a slow model.
  const children = [
    ...retryChildren(hunter),
    ...(hunter.status === "failed"
      ? failureReasonChildren(hunter.failureReason)
      : []),
  ];
  const model = modelWidth === 0 ? "" : pad(hunter.model ?? "", modelWidth);
  const parts: string[] = [];
  if (model.length > 0) parts.push(model);
  const node = (status: TreeNode["status"]): TreeNode => ({
    label,
    status,
    detail: parts.join("   "),
    ...(children.length === 0 ? {} : { children }),
  });
  switch (hunter.status) {
    case "waiting":
      parts.push("waiting");
      return node("pending");
    case "running":
      parts.push(
        formatElapsed(nowMs - (state.huntersStartedAtMs ?? state.startedAtMs)),
      );
      return node("running");
    case "done":
      parts.push(formatElapsed(hunter.durationMs ?? 0));
      if (hunter.drafts !== undefined) {
        parts.push(`${hunter.drafts} draft${hunter.drafts === 1 ? "" : "s"}`);
      }
      return node("done");
    case "failed":
      // A dead hunter is a partial run, never an abort — the row says so
      // rather than leaving the operator to guess from a red mark.
      parts.push("failed — the run continues");
      return node("failed");
  }
}

function refuterNode(
  refuter: NonNullable<PanelState["refuter"]>,
  labelWidth: number,
): TreeNode {
  const idWidth = Math.max(
    ...refuter.findings.map((f) => f.id.length),
    "F000".length,
  );
  const children: TreeNode[] = refuter.findings.map((leaf) => {
    const detail = [
      leaf.location === undefined ? "" : leaf.location,
      leaf.verdict === undefined ? "" : leaf.verdict,
    ]
      .filter((part) => part.length > 0)
      .join("   ");
    return {
      label: pad(leaf.id, idWidth),
      status: leaf.status === "done" ? ("done" as const) : ("running" as const),
      ...(detail.length === 0 ? {} : { detail }),
    };
  });
  return {
    label: pad("refuter", labelWidth),
    status: refuter.done ? "done" : "running",
    detail: refuter.done
      ? `${refuter.total} judged`
      : `judging ${refuter.judged} of ${refuter.total}`,
    children,
  };
}

function summarizerNode(
  summarizer: PanelSummarizer,
  state: PanelState,
  nowMs: number,
  labelWidth: number,
): TreeNode {
  const detail =
    summarizer.status === "running"
      ? formatElapsed(nowMs - state.startedAtMs)
      : summarizer.status === "done"
        ? formatElapsed(summarizer.durationMs ?? 0)
        : "failed — the run continues";
  const children =
    summarizer.status === "failed"
      ? failureReasonChildren(summarizer.failureReason)
      : [];
  return {
    label: pad("summarizer", labelWidth),
    status:
      summarizer.status === "running"
        ? "running"
        : summarizer.status === "done"
          ? "done"
          : "failed",
    detail,
    ...(children.length === 0 ? {} : { children }),
  };
}

// One frame of the panel as plain lines — no cursor movement, no clearing;
// the shell owns positioning. `frame` indexes SPINNER_FRAMES (the shell's
// tick advances it). `maxLines` bounds the WHOLE panel, header included,
// because the shell's redraw arithmetic is against the count returned here.
export function renderPanelLines(
  state: PanelState,
  nowMs: number,
  frame: number,
  colors: boolean,
  maxLines?: number,
): string[] {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
  const count = state.hunters.length;
  const header =
    `${spinner} reviewing ${state.subject} · ` +
    `${count} hunter${count === 1 ? "" : "s"}` +
    `${state.hasRefuter ? " + refuter" : ""} — ` +
    formatElapsed(nowMs - state.startedAtMs);
  if (maxLines !== undefined && maxLines <= 1) return [header];
  const labelWidth = Math.max(
    ...state.hunters.map((h) => h.key.length),
    "dedupe".length,
    "refuter".length,
    state.summarizer === undefined ? 0 : "summarizer".length,
  );
  const modelWidth = Math.max(
    0,
    ...state.hunters.map((h) => h.model?.length ?? 0),
  );
  const nodes: TreeNode[] = [];
  nodes.push(
    ...state.hunters.map((hunter) =>
      hunterNode(hunter, state, nowMs, labelWidth, modelWidth),
    ),
  );
  if (state.summarizer) {
    nodes.push(summarizerNode(state.summarizer, state, nowMs, labelWidth));
  }
  if (state.dedupe) {
    nodes.push({
      label: pad("dedupe", labelWidth),
      status: "done",
      detail:
        `${state.dedupe.drafts} draft${state.dedupe.drafts === 1 ? "" : "s"}` +
        ` → ${state.dedupe.findings} ` +
        `finding${state.dedupe.findings === 1 ? "" : "s"}`,
    });
  }
  if (state.refuter) nodes.push(refuterNode(state.refuter, labelWidth));
  return [
    header,
    ...renderTree(nodes, {
      styles: colors,
      frame: spinner,
      ...(maxLines === undefined ? {} : { maxLines: maxLines - 1 }),
    }),
  ];
}
