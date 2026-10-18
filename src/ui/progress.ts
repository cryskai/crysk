// Live progress for the paid leg, born from a real incident: the CLI went
// silent for ~10 minutes between `codegraph init` and `run complete`, and a
// paid run died to a Ctrl-C from a user who reasonably believed it hung.
// On a TTY: a multi-line panel redrawn in place (state and frame text are
// pure in progress.ts). Non-TTY (piped, backgrounded): one plain stderr
// line per event. I/O by nature, untested by construction — formatElapsed
// and the progress.ts halves are the pure, tested pieces.

import type { FreeRouteBilling } from "#model/free-discovery";
import type { PipelineProgressEvent } from "#review/pipeline";
import type { CliOptions } from "#review/preflight";
import { formatElapsed } from "#review/report";
import { type SizeGateVerdict, sizeGateDisposition } from "#review/size-gate";
import { log, styleEnabled } from "#ui/primitives";
import {
  type ConfirmResult,
  type ConfirmSpec,
  confirmReview,
  confirmSizeGate,
  freeBillingMode,
} from "#ui/select";
import { CliError } from "../errors";
import {
  applyProgressEvent,
  createPanelState,
  renderPanelLines,
} from "../progress";

export type { ConfirmResult };

export interface ProgressRenderer {
  onProgress: (event: PipelineProgressEvent) => void;
  stop: () => void;
}

// Height the panel assumes when the stream will not say (a TTY without rows),
// and the rows it leaves free below itself.
const PANEL_FALLBACK_ROWS = 24;
const PANEL_HEADROOM = 3;

export function startProgressRenderer(
  startedAtMs: number,
  subject: string,
  hunterKeys: string[],
  hasRefuter = true,
  hasSummarizer = false,
): ProgressRenderer {
  return process.stderr.isTTY
    ? startPanelRenderer(
        startedAtMs,
        subject,
        hunterKeys,
        hasRefuter,
        hasSummarizer,
      )
    : startLineRenderer(startedAtMs);
}

// The TTY panel: header + a TREE of agent rows (the refuter's per-finding
// leaves under it), redrawn in place with cursor-up (\x1b[<n>A) + per-line
// clear (\x1b[2K) on every event and on a 250ms tick that advances the
// spinner and the elapsed clocks. The cursor is deliberately NOT hidden:
// \x1b[?25l would need a restore on every exit path, and a leaked hidden
// cursor wrecks the user's terminal — a visible cursor over a redrawing
// panel is fine.
//
// Two things the tree made load-bearing that a fixed-height list did not:
//   - the height budget, recomputed EVERY draw (a mid-run resize must tighten
//     it on the next tick, not walk the cursor off the top of the screen);
//   - \x1b[0J after the frame. The old panel could only grow, so leftover
//     lines were impossible; a tree that collapses a finished branch shrinks,
//     and without the erase-to-end the previous frame's tail stays on screen
//     as orphaned rows.
// Exported for its test, which is the only consumer outside this module: the
// post-stop silence below is a CRITICAL invariant and an untested one regresses.
export function startPanelRenderer(
  startedAtMs: number,
  subject: string,
  hunterKeys: string[],
  hasRefuter = true,
  hasSummarizer = false,
): ProgressRenderer {
  // The NO_COLOR convention: any value disables color; a TTY alone is not
  // consent.
  const colors = process.env.NO_COLOR === undefined;
  const state = createPanelState(subject, startedAtMs, hunterKeys, {
    refuter: hasRefuter,
    summarizer: hasSummarizer,
  });
  let frame = 0;
  let drawnLines = 0;
  // Headroom, not the whole window: the summary block prints below the final
  // frame, and a panel that fills the terminal exactly would scroll it away
  // the moment anything else is written. 24 is the classic default for a
  // stream that will not say how tall it is.
  const budget = (): number =>
    Math.max((process.stderr.rows ?? PANEL_FALLBACK_ROWS) - PANEL_HEADROOM, 3);
  const draw = (): void => {
    const lines = renderPanelLines(
      state,
      performance.now(),
      frame,
      colors,
      budget(),
    );
    if (drawnLines > 0) process.stderr.write(`\x1b[${drawnLines}A`);
    for (const line of lines) {
      process.stderr.write(`\x1b[2K${line}\n`);
    }
    // See the header: the frame can shrink, so anything below it must go.
    process.stderr.write("\x1b[0J");
    drawnLines = lines.length;
  };
  const ticker = setInterval(() => {
    frame += 1;
    draw();
  }, 250);
  draw();
  // STOPPED IS LOAD-BEARING, and it is what makes \x1b[0J safe. The pipeline
  // ceiling resolves the run while in-flight step promises are ABANDONED, not
  // awaited (pipeline.ts: "abandoned, not awaited"), and their settle handlers
  // emit unconditionally. So an event can arrive after stop() — after the
  // result block has already printed below the final frame. Without this flag
  // that late event redraws: the cursor walks back UP over the summary and
  // \x1b[0J erases everything below it, deleting the findings of a paid run.
  // Found live by pr-hero reviewing its own PR #7 (F002, CRITICAL,
  // corroborated) — the erase-to-end-of-screen that fixed the shrinking-frame
  // bug created this one.
  let stopped = false;
  return {
    onProgress: (event: PipelineProgressEvent): void => {
      if (stopped) return;
      applyProgressEvent(state, event, performance.now());
      draw();
    },
    stop: (): void => {
      if (stopped) return;
      clearInterval(ticker);
      // One last draw so the completed states land; the frame then stays as
      // the static record, and the summary prints below it.
      draw();
      // AFTER the final draw, so stop() itself is not a no-op.
      stopped = true;
    },
  };
}

// "done", or the honest failure with its reason when the pipeline had one
// (#314: a CI log that said only "failed" for every hunter hid an E2BIG). A
// failed hunter or summarizer is a partial run, never an abort.
function finishedText(event: { ok: boolean; reason?: string }): string {
  if (event.ok) return "done";
  return event.reason === undefined
    ? "failed (the run continues)"
    : `failed — ${event.reason} (the run continues)`;
}

// Non-TTY: no redraw art, one plain line per event, elapsed prefix.
export function startLineRenderer(startedAtMs: number): ProgressRenderer {
  const line = (text: string): void => {
    log(`  [${formatElapsed(performance.now() - startedAtMs)}] ${text}`);
  };
  return {
    onProgress: (event: PipelineProgressEvent): void => {
      switch (event.kind) {
        case "hunters-started":
          // The expectation line printed right before runPipeline already
          // announced the fan-out; restating it here would be its echo.
          return;
        case "hunter-finished":
          // A failed hunter is honest, not alarming: one dead hunter is a
          // partial run, never an abort.
          line(`hunter ${event.hunter}: ${finishedText(event)}`);
          return;
        case "dedupe-finished":
          line(
            `dedupe: ${event.drafts} draft${event.drafts === 1 ? "" : "s"} ` +
              `-> ${event.findings} finding${event.findings === 1 ? "" : "s"}`,
          );
          return;
        case "refuter-started":
          line(
            `refuter: ${event.severeFindings} severe finding` +
              `${event.severeFindings === 1 ? "" : "s"} to judge`,
          );
          return;
        case "refuter-step-finished":
          line(`refuter ${event.findingId}: ${event.verdict}`);
          return;
        case "verify-started":
          line(
            `verify: ${event.queued} prior finding` +
              `${event.queued === 1 ? "" : "s"} to check`,
          );
          return;
        case "verify-step-finished":
          line(`verify ${event.findingId}: ${event.verdict}`);
          return;
        case "summarizer-finished":
          line(`summarizer: ${finishedText(event)}`);
          return;
        case "scout-started":
          line(`scout: reading the diff (${event.model})`);
          return;
        case "scout-finished":
          // "unled", never "the run continues": a scout failure is not a
          // partial review, it is the control pipeline. Naming it as a
          // degradation would teach an operator to distrust a complete run.
          line(
            event.ok
              ? `scout: ${event.leads ?? 0} lead(s)`
              : "scout: failed (the hunters run unled)",
          );
          return;
        case "step-retry":
          // EVERY step, hunters and refuter alike — this is the launchd log,
          // where a retry that explains a long wall time has to be readable
          // after the fact and nothing competes for the line.
          line(
            `retry ${event.step}: ` +
              (event.reason === "format"
                ? "format retry"
                : `attempt ${event.attempt} of ${event.maxAttempts} ` +
                  "(transient)"),
          );
          return;
      }
    },
    stop: (): void => {
      // Nothing ticking to stop — kept so both renderers share one shape.
    },
  };
}

// The cost band's gate. `details` is a thunk so the details view — which
// probes the filesystem — is built only if the human asks for it, and
// `canSkipPost` is what decides whether "Review, but don't post" exists at
// all: offering it to a run that was never going to post is a no-op dressed
// as a choice.
// The spec without its styles: a pure function of the run, so the billing
// wording it carries is testable offline. The free-route count is the same one
// the plan card was printed with (callers pass the same object to both).
export function confirmSpecFor(
  low: number,
  high: number,
  canSkipPost: boolean,
  details: () => string[],
  freeRoute: FreeRouteBilling | undefined,
): Omit<ConfirmSpec, "styles"> {
  const billing = freeBillingMode(freeRoute);
  return {
    low,
    high,
    canSkipPost,
    details,
    ...(billing === undefined ? {} : { billing }),
  };
}

export function confirm(
  low: number,
  high: number,
  canSkipPost: boolean,
  details: () => string[],
  freeRoute?: FreeRouteBilling,
): Promise<ConfirmResult> {
  return confirmReview({
    ...confirmSpecFor(low, high, canSkipPost, details, freeRoute),
    styles: styleEnabled(),
  });
}

// The size-gate override. `onBlock` runs for both the hard skip and the
// interactive prompt (PR mode prints the SKIP line here, because that path
// never reaches the plan). Local mode passes nothing: the plan already
// printed the verdict.
export async function applySizeGate(
  verdict: SizeGateVerdict,
  options: Pick<CliOptions, "force" | "yes">,
  onBlock?: () => void,
): Promise<"proceed" | "abort"> {
  const disposition = sizeGateDisposition(verdict, {
    force: options.force,
    yes: options.yes,
    interactive: Boolean(process.stdin.isTTY),
  });
  if (disposition.action === "proceed") return "proceed";
  onBlock?.();
  if (disposition.action === "skip") {
    throw new CliError(disposition.message);
  }
  const choice = await confirmSizeGate(styleEnabled());
  if (choice.kind === "cancel") {
    log("aborted; nothing was spent.");
    return "abort";
  }
  return "proceed";
}
