import {
  type CliOptions,
  DEFAULT_HOP_BUDGET,
  type LocalConfig,
} from "#review/preflight";
import { cycleStringPreset } from "./config-edit";
import { clearDrawnLines } from "./menu";
import { bold, box, cyan, dim, sanitizeText } from "./primitives";
import { type KeyReader, parseKey, splitKeys } from "./select";

export interface ReviewMenuState {
  target: "branch" | "pr";
  head: string;
  base: string;
  pr?: number | "current";
  post: boolean;
  force: boolean;
  full: boolean;
  dryRun: boolean;
}

export interface ReviewMenuIo {
  write: (text: string) => void;
  line: (text?: string) => void;
}

export const REVIEW_CARD_ACTIONS = [
  "[ Start review ]",
  "[ Discard & back ]",
] as const;

export function renderReviewMenuCard(
  state: ReviewMenuState,
  cursor: number,
  width: number,
  styles: boolean,
  actions: readonly string[] = REVIEW_CARD_ACTIONS,
): string[] {
  const targetLabel =
    state.target === "branch"
      ? "Local branch"
      : state.pr
        ? `PR #${state.pr}`
        : "Current PR";

  const fields = [
    `Target: ${targetLabel} — Review target mode`,
    `Base: ${state.base} · Head: ${state.head} — Git diff range`,
    `Post to PR: ${state.post ? "[✓] Yes" : "[ ] No"} — Publish comments to GitHub PR`,
    `Force review: ${state.force ? "[✓] Yes" : "[ ] No"} — Bypass size gate thresholds`,
    `Full verification: ${state.full ? "[✓] Yes" : "[ ] No"} — Run deep refuter checks`,
    `Dry run: ${state.dryRun ? "[✓] Yes" : "[ ] No"} — Execute without posting or resolving`,
  ];

  const lines: string[] = [];

  for (let idx = 0; idx < fields.length; idx++) {
    const isSelected = idx === cursor;
    const prefix = isSelected ? "▸ " : "  ";
    const line = sanitizeText(`${prefix}${fields[idx]}`);
    lines.push(isSelected ? bold(cyan(line, styles), styles) : line);
  }

  if (actions.length > 0) {
    lines.push("");
    const innerWidth = Math.max(10, width - 4);
    lines.push(dim("─".repeat(innerWidth), styles));
    for (let i = 0; i < actions.length; i++) {
      const actionIdx = fields.length + i;
      const isSelected = actionIdx === cursor;
      const prefix = isSelected ? "▸ " : "  ";
      const line = `${prefix}${actions[i]}`;
      lines.push(
        isSelected ? bold(cyan(line, styles), styles) : sanitizeText(line),
      );
    }
  }

  return box("Review PR Configuration", lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export type ReviewMenuOutcome =
  | { action: "launch"; options: CliOptions }
  | { action: "back" };

export async function runReviewMenu(
  deps: {
    createReader?: () => KeyReader;
    io?: ReviewMenuIo;
    styles?: boolean;
    width?: number;
    effectiveConfig?: LocalConfig;
    defaultBase?: string;
    defaultPost?: boolean;
  } = {},
): Promise<ReviewMenuOutcome> {
  const resolvedBase =
    deps.defaultBase ?? deps.effectiveConfig?.default_base ?? "main";
  const resolvedPost = deps.defaultPost ?? deps.effectiveConfig?.post ?? false;
  const resolvedTarget = resolvedPost ? "pr" : "branch";

  const state: ReviewMenuState = {
    target: resolvedTarget,
    head: "HEAD",
    base: resolvedBase,
    post: resolvedPost,
    force: false,
    full: false,
    dryRun: false,
  };

  const io = deps.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };
  const styles = deps.styles ?? false;
  const width = deps.width ?? 80;

  const createReader =
    deps.createReader ??
    (() => {
      const stdin = process.stdin;
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
          stdin.pause();
          try {
            stdin.setRawMode(false);
          } catch {
            // Ignore
          }
        },
      };
    });

  let cursor = 0;
  const fieldCount = 6;
  const actions = REVIEW_CARD_ACTIONS;
  const totalItems = fieldCount + actions.length;
  const ESC = "\x1b";
  const repaint = styles;
  let drawn = 0;

  const render = (clearScreen = false) => {
    const lines: string[] = [
      "",
      ...renderReviewMenuCard(state, cursor, width, styles, actions),
      dim("j/k: move • space/enter: toggle • q/esc: back", styles),
    ];

    let buf = "";
    if (repaint && clearScreen) {
      buf += `${ESC}[2J${ESC}[H`;
      drawn = 0;
    } else if (repaint && drawn > 0) {
      buf += `${ESC}[${drawn}A`;
    }
    for (const l of lines) {
      if (repaint && drawn > 0) buf += `${ESC}[2K`;
      buf += `${l}\n`;
    }
    io.write(buf);
    drawn = lines.length;
  };

  const reader = createReader();
  try {
    if (repaint) io.write(`${ESC}[?25l`);
    render(true);
    for (;;) {
      const chunk = await reader.read();
      if (chunk === undefined) return { action: "back" };

      for (const raw of splitKeys(chunk)) {
        const key = parseKey(raw);
        if (
          key.type === "escape" ||
          key.type === "ctrl-c" ||
          (key.type === "char" && key.char === "q")
        ) {
          return { action: "back" };
        }
        if (key.type === "up" || (key.type === "char" && key.char === "k")) {
          cursor = (cursor - 1 + totalItems) % totalItems;
          render(false);
          continue;
        }
        if (key.type === "down" || (key.type === "char" && key.char === "j")) {
          cursor = (cursor + 1) % totalItems;
          render(false);
          continue;
        }
        if (key.type === "char" && /^[1-9]$/.test(key.char)) {
          const numIdx = Number(key.char) - 1;
          if (numIdx < totalItems) {
            cursor = numIdx;
            render(false);
          }
          continue;
        }

        // Action buttons
        if (cursor >= fieldCount) {
          const actionIdx = cursor - fieldCount;
          if (key.type === "enter") {
            if (actionIdx === 0) {
              // Start review
              const options: CliOptions = {
                repo: ".",
                head: state.head,
                base: state.base,
                pr: state.target === "pr" ? (state.pr ?? "current") : undefined,
                post: state.post,
                force: state.force,
                full: state.full,
                dryRun: state.dryRun,
                hopBudget: DEFAULT_HOP_BUDGET,
                yes: false,
                twoDot: false,
                onPush: false,
                all: false,
                fixes: false,
                incidents: false,
                issues: false,
                proximity: false,
                threads: false,
              };
              return { action: "launch", options };
            }
            return { action: "back" };
          }
          continue;
        }

        // Field toggles / cycles
        if (
          key.type === "enter" ||
          key.type === "left" ||
          key.type === "right" ||
          (key.type === "char" &&
            (key.char === " " || key.char === "h" || key.char === "l"))
        ) {
          if (cursor === 0) {
            state.target = state.target === "branch" ? "pr" : "branch";
            if (state.target === "branch") state.post = false;
          } else if (cursor === 1) {
            state.base = cycleStringPreset(state.base, [
              "main",
              "master",
              "develop",
            ]);
          } else if (cursor === 2) {
            if (state.target === "branch") {
              state.target = "pr";
              state.post = true;
            } else {
              state.post = !state.post;
            }
          } else if (cursor === 3) {
            state.force = !state.force;
          } else if (cursor === 4) {
            state.full = !state.full;
          } else if (cursor === 5) {
            state.dryRun = !state.dryRun;
          }
          render(false);
        }
      }
    }
  } finally {
    clearDrawnLines(io, drawn, repaint);
    drawn = 0;
    if (repaint) io.write(`${ESC}[?25h`);
    reader.close();
  }
}
