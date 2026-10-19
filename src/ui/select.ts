// The terminal surface's INTERACTIVE half: the keyboard-driven menu that
// replaced the cost band's `[y/N]` read. ui/primitives.ts stays pure by construction;
// this module is where the one unavoidable side effect — putting the user's
// terminal into raw mode — is quarantined behind an injected reader, so every
// decision above it (which options exist, where the cursor lands, what a key
// means, what "Show details" does) is a total function testable with no TTY.
//
// The threat model that shapes the whole file: the watcher spawns reviews with
// `--yes` AND `stdin: "ignore"` (watch/watch.ts). The old confirm() degraded there by
// accident — its stdin read resolved `{ value: undefined }` immediately — but
// `setRawMode` in that same position THROWS under launchd. So raw mode is
// entered only behind an isTTY + setRawMode-exists guard, the non-TTY path
// keeps the old plain-text behaviour byte for byte, and the restore lives in a
// `finally` so a throw mid-menu cannot strand a human in raw mode.

import type { FreeRouteBilling } from "#model/free-discovery";
import { bold, dim, log } from "./primitives";

export type ConfirmResult =
  | { kind: "review"; post: boolean }
  | { kind: "cancel" };

// What a keypress MEANS, decided once. "char" carries the lowercased
// character so shortcut matching never re-derives it.
export type Key =
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "enter" }
  | { type: "escape" }
  | { type: "ctrl-c" }
  | { type: "cancel" }
  | { type: "char"; char: string }
  | { type: "ignore" };

const ESC = "\x1b";
const CTRL_C = "\x03";

// One chunk off a raw stdin can carry several keys: a held arrow, a paste, or
// simply two presses inside one tick. Splitting is pure and separate from
// interpretation so both halves stay testable.
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === ESC && chunk[i + 1] === "[") {
      // CSI: ESC [ ...params... final-byte in 0x40–0x7E.
      let j = i + 2;
      while (j < chunk.length && !/[@-~]/.test(chunk[j] as string)) j++;
      keys.push(chunk.slice(i, Math.min(j + 1, chunk.length)));
      i = j + 1;
      continue;
    }
    keys.push(chunk[i] as string);
    i++;
  }
  return keys;
}

export function parseKey(key: string): Key {
  if (key === `${ESC}[A`) return { type: "up" };
  if (key === `${ESC}[B`) return { type: "down" };
  if (key === `${ESC}[C`) return { type: "right" };
  if (key === `${ESC}[D`) return { type: "left" };
  // \r is what a raw-mode terminal sends for Enter; \n only ever arrives from
  // a cooked stream. Both count — a menu that ignored one would look dead.
  if (key === "\r" || key === "\n") return { type: "enter" };
  if (key === CTRL_C) return { type: "ctrl-c" };
  if (key === ESC) return { type: "escape" };
  // Any other control byte (backspace, tab, Ctrl-anything) is noise, not a
  // shortcut: matching it against option letters would fire a $6 review on a
  // stray keystroke.
  if (key.length !== 1) return { type: "ignore" };
  const code = key.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return { type: "ignore" };
  return { type: "char", char: key.toLowerCase() };
}

interface MenuOption {
  // "review" and "cancel" terminate; "details" is a VIEW action that
  // re-presents the menu instead of resolving it.
  action: "review" | "details" | "cancel";
  label: string;
  hint?: string;
  // Lowercase single characters. `y`/`n` are kept on the review/cancel rows on
  // purpose: they are what a decade of `[y/N]` prompts trained into fingers.
  shortcuts: string[];
  post: boolean;
}

export interface ConfirmSpec {
  low: number;
  high: number;
  // Set only for a route the plan card already priced as free or mixed. Absent
  // means today's wording on both the menu hint and the plain prompt.
  billing?: FreeBillingMode;
  // Only true when the run was actually going to post: offering "don't post"
  // to a run that never would is an option with no meaning behind it.
  canSkipPost: boolean;
  // A thunk, not an array: building the details view costs filesystem probes
  // (worktree/codegraph existence), and most runs never open it.
  details: () => string[];
  styles: boolean;
}

// The option list, composed and nothing more — the single place that decides
// what a human is offered, so a test can assert it without a terminal.
export function menuOptions(canSkipPost: boolean): MenuOption[] {
  const options: MenuOption[] = [
    {
      action: "review",
      label: "Review it",
      shortcuts: ["r", "y"],
      post: canSkipPost,
    },
  ];
  if (canSkipPost) {
    options.push({
      action: "review",
      label: "Review, but don't post",
      shortcuts: ["p"],
      post: false,
    });
  }
  options.push(
    { action: "details", label: "Show details", shortcuts: ["d"], post: false },
    {
      action: "cancel",
      label: "Cancel",
      shortcuts: ["c", "n", "q"],
      post: false,
    },
  );
  return options;
}

export type SizeGateConfirmResult = { kind: "proceed" } | { kind: "cancel" };

// Continue / Cancel only. No cost hint (the gate exists because we will
// not guess at this bill) and no details view (the SKIP line above the
// menu already named the reason and the two flag hatches).
export function sizeGateMenuOptions(): MenuOption[] {
  return [
    {
      action: "review",
      label: "Review anyway",
      shortcuts: ["r", "y"],
      post: false,
    },
    {
      action: "cancel",
      label: "Cancel",
      shortcuts: ["c", "n", "q"],
      post: false,
    },
  ];
}

const LABEL_WIDTH = 32;

// The billing mode of an admitted route plan, derived ONCE from the same
// free-step count the plan card prints (planEstimateLine in ui/plan.ts reads
// this too). All steps free: nothing is billed. Some free: the band stays and
// names the free share. Otherwise there is no mode, and today's wording stands.
export type FreeBillingMode = "free" | "mixed";

export const FREE_STEPS_NOTE = "(free steps not billed)";

export function freeBillingMode(
  free: FreeRouteBilling | undefined,
): FreeBillingMode | undefined {
  if (free === undefined || free.total === 0) return undefined;
  if (free.free === free.total) return "free";
  return free.free > 0 ? "mixed" : undefined;
}

function band(low: number, high: number): string {
  return `$${low.toFixed(2)} – $${high.toFixed(2)}`;
}

// The menu's first-row hint. A free route shows no dollar figure at all: the
// band would read as spend, which is the claim the plan card just retracted.
export function costHint(
  low: number,
  high: number,
  billing?: FreeBillingMode,
): string {
  if (billing === "free") return "free route (not billed)";
  if (billing === "mixed") return `${band(low, high)} ${FREE_STEPS_NOTE}`;
  return band(low, high);
}

// The plain [y/N] prompt's sentence, without its question mark and answer
// domain. Metered is the sentence this module always printed, byte for byte.
export function spendSentence(
  low: number,
  high: number,
  billing?: FreeBillingMode,
): string {
  const range = `$${low.toFixed(2)}–$${high.toFixed(2)}`;
  if (billing === "free") {
    return `Run this review on a free route (token-derived ${range}, not billed)`;
  }
  const note = billing === "mixed" ? ` ${FREE_STEPS_NOTE}` : "";
  return `Spend an estimated ${range} on this review${note}`;
}

// The frame, as lines. Built unstyled and painted per line, same rule as the
// plan card: the pointer is plain text either way, so a piped run reads
// correctly with no escapes at all.
export function renderMenu(
  options: MenuOption[],
  cursor: number,
  styles: boolean,
): string[] {
  return options.map((option, i) => {
    const active = i === cursor;
    const head = active ? "❯ " : "  ";
    const body = option.hint
      ? `${option.label.padEnd(LABEL_WIDTH)}${option.hint}`
      : option.label;
    const line = `  ${head}${body}`;
    if (!styles) return line;
    return active ? bold(line, true) : dim(line, true);
  });
}

// Cursor movement WRAPS. A four-item menu is short enough that walking off
// either end and landing on the other end is what a human expects, and it
// removes the dead keypress at the boundaries.
export function moveCursor(cursor: number, delta: number, len: number): number {
  return (cursor + delta + len) % len;
}

// The injected input. `raw` decides which of the two prompts runs at all:
// true is the menu, false is the legacy one-chunk `[y/N]` read that the
// watcher's `stdin: "ignore"` depends on.
export interface KeyReader {
  raw: boolean;
  // A raw reader yields keypress chunks; a line reader yields the single
  // chunk it read. `undefined` means the stream ended without an answer —
  // exactly what a closed/ignored stdin produces, and it must read as "no".
  read(): Promise<string | undefined>;
  close(): void;
}

export interface ConfirmIo {
  write: (text: string) => void;
  line: (text?: string) => void;
}

const defaultIo: ConfirmIo = {
  write: (text) => process.stderr.write(text),
  line: (text) => log(text),
};

// The pure-ish core: given a reader and an io sink, run the menu to a
// decision. Every branch here is reachable from a test with a scripted reader.
export async function runConfirm(
  spec: ConfirmSpec,
  reader: KeyReader,
  io: ConfirmIo = defaultIo,
): Promise<ConfirmResult> {
  if (!reader.raw) return runPlainConfirm(spec, reader, io);

  const options = menuOptions(spec.canSkipPost);
  const withHint = options.map((option, i) =>
    i === 0
      ? { ...option, hint: costHint(spec.low, spec.high, spec.billing) }
      : option,
  );
  let cursor = 0;
  // Repainting in place needs cursor-movement escapes, which are exactly what
  // must never reach a pipe. When styling is off the frames are simply
  // appended — uglier, but honest bytes.
  const repaint = spec.styles;
  let drawn = 0;

  const draw = (): void => {
    if (repaint && drawn > 0) io.write(`${ESC}[${drawn}A`);
    const lines = renderMenu(withHint, cursor, spec.styles);
    for (const line of lines) {
      if (repaint) io.write(`${ESC}[2K`);
      io.line(line);
    }
    drawn = lines.length;
  };

  io.line();
  draw();

  for (;;) {
    const chunk = await reader.read();
    // Stream ended mid-menu (stdin closed under us). Never a licence to
    // spend: an unanswered prompt is a "no".
    if (chunk === undefined) {
      io.line();
      return { kind: "cancel" };
    }
    for (const rawKey of splitKeys(chunk)) {
      const key = parseKey(rawKey);
      if (key.type === "ignore") continue;
      if (
        key.type === "cancel" ||
        key.type === "escape" ||
        key.type === "ctrl-c"
      ) {
        // Loud, never swallowed: a Ctrl-C that produced silence looks like a
        // hang, and the caller's "aborted" line lands under this.
        io.line();
        io.line("^C");
        return { kind: "cancel" };
      }
      if (key.type === "up" || key.type === "down") {
        cursor = moveCursor(
          cursor,
          key.type === "up" ? -1 : 1,
          withHint.length,
        );
        draw();
        continue;
      }
      const chosen =
        key.type === "enter"
          ? withHint[cursor]
          : key.type === "char"
            ? withHint.find((option) => option.shortcuts.includes(key.char))
            : undefined;
      if (chosen === undefined) continue;
      if (chosen.action === "details") {
        // A VIEW, not a decision: print and fall back into the same loop. The
        // frame counter resets because the details pushed the old frame up.
        io.line();
        for (const line of spec.details()) io.line(line);
        drawn = 0;
        io.line();
        draw();
        continue;
      }
      io.line();
      return chosen.action === "cancel"
        ? { kind: "cancel" }
        : { kind: "review", post: chosen.post };
    }
  }
}

// The non-TTY path, unchanged in behaviour from the confirm() this replaced:
// same sentence, same `[y/N]`, one chunk read, `y`/`yes` proceeds and
// EVERYTHING else — including a stdin that yields nothing at all — cancels.
// The watcher runs here (with --yes short-circuiting above it) and a shell
// pipeline runs here; neither may be handed a menu.
async function runPlainConfirm(
  spec: ConfirmSpec,
  reader: KeyReader,
  io: ConfirmIo,
): Promise<ConfirmResult> {
  io.line();
  io.write(`${spendSentence(spec.low, spec.high, spec.billing)}? [y/N] `);
  const answer = (await reader.read())?.trim().toLowerCase() ?? "";
  io.line();
  return answer === "y" || answer === "yes"
    ? { kind: "review", post: spec.canSkipPost }
    : { kind: "cancel" };
}

// One chunk off Bun.stdin, then release it. Reading the whole stream would
// block until EOF, which never comes on an interactive terminal.
function createLineReader(): KeyReader {
  return {
    raw: false,
    read: async () => {
      const stream = Bun.stdin.stream().getReader();
      const { value } = await stream.read();
      await stream.cancel();
      return value === undefined ? undefined : new TextDecoder().decode(value);
    },
    close: () => {
      // Nothing held open: the reader above cancels its own stream.
    },
  };
}

// The one place raw mode is entered. BOTH guards matter: `isTTY` is false
// under the watcher's `stdin: "ignore"`, and `setRawMode` is absent entirely
// on some non-tty stdin shapes — calling it there throws, which is precisely
// the failure this whole module is arranged to avoid.
function createStdinReader(stdin = process.stdin): KeyReader {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return createLineReader();
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  const pending: string[] = [];
  let deliver: ((chunk: string) => void) | undefined;
  const onData = (chunk: string): void => {
    if (deliver === undefined) {
      pending.push(chunk);
      return;
    }
    const resolve = deliver;
    deliver = undefined;
    resolve(chunk);
  };
  stdin.on("data", onData);
  return {
    raw: true,
    read: () => {
      const queued = pending.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string>((resolve) => {
        deliver = resolve;
      });
    },
    close: () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    },
  };
}

// The shell. The `finally` is the load-bearing line in this file: a throw
// anywhere inside the menu must still hand the terminal back cooked.
export async function confirmReview(
  spec: ConfirmSpec,
  reader: KeyReader = createStdinReader(),
  io: ConfirmIo = defaultIo,
): Promise<ConfirmResult> {
  try {
    return await runConfirm(spec, reader, io);
  } finally {
    reader.close();
  }
}

// Sibling of runConfirm for the size-gate override. Same reader/io contract,
// same unanswered-is-no rule, no details view and no dollar hint — guessing
// at this bill is the thing the gate refuses to do.
export async function runSizeGateConfirm(
  styles: boolean,
  reader: KeyReader,
  io: ConfirmIo = defaultIo,
): Promise<SizeGateConfirmResult> {
  if (!reader.raw) return runPlainSizeGateConfirm(reader, io);

  const options = sizeGateMenuOptions();
  let cursor = 0;
  const repaint = styles;
  let drawn = 0;

  const draw = (): void => {
    if (repaint && drawn > 0) io.write(`${ESC}[${drawn}A`);
    const lines = renderMenu(options, cursor, styles);
    for (const line of lines) {
      if (repaint) io.write(`${ESC}[2K`);
      io.line(line);
    }
    drawn = lines.length;
  };

  io.line();
  draw();

  for (;;) {
    const chunk = await reader.read();
    if (chunk === undefined) {
      io.line();
      return { kind: "cancel" };
    }
    for (const rawKey of splitKeys(chunk)) {
      const key = parseKey(rawKey);
      if (key.type === "ignore") continue;
      if (
        key.type === "cancel" ||
        key.type === "escape" ||
        key.type === "ctrl-c"
      ) {
        io.line();
        io.line("^C");
        return { kind: "cancel" };
      }
      if (key.type === "up" || key.type === "down") {
        cursor = moveCursor(cursor, key.type === "up" ? -1 : 1, options.length);
        draw();
        continue;
      }
      const chosen =
        key.type === "enter"
          ? options[cursor]
          : key.type === "char"
            ? options.find((option) => option.shortcuts.includes(key.char))
            : undefined;
      if (chosen === undefined) continue;
      io.line();
      return chosen.action === "cancel"
        ? { kind: "cancel" }
        : { kind: "proceed" };
    }
  }
}

async function runPlainSizeGateConfirm(
  reader: KeyReader,
  io: ConfirmIo,
): Promise<SizeGateConfirmResult> {
  io.line();
  io.write("This diff exceeds the size gate. Review anyway? [y/N] ");
  const answer = (await reader.read())?.trim().toLowerCase() ?? "";
  io.line();
  return answer === "y" || answer === "yes"
    ? { kind: "proceed" }
    : { kind: "cancel" };
}

export async function confirmSizeGate(
  styles: boolean,
  reader: KeyReader = createStdinReader(),
  io: ConfirmIo = defaultIo,
): Promise<SizeGateConfirmResult> {
  try {
    return await runSizeGateConfirm(styles, reader, io);
  } finally {
    reader.close();
  }
}
