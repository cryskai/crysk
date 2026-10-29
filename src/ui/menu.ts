import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_VERIFICATION_STEPS } from "#review/preflight";
import { DEFAULT_SIZE_GATE } from "#review/size-gate";
import { listActiveRuns } from "#store/activity";
import { DEFAULT_DAILY_CAP } from "#watch/preflight";
import { resolveHomeDir, resolveRepoDir } from "../brand-paths";
import { runDoctor } from "../doctor";
import {
  getMenuOptions,
  type MenuItem,
  type MenuStatusInfo,
  type RepoContext,
  resolveMenuContext,
} from "../menu-context";
import {
  cycleStringPreset,
  DEFAULT_CARD_ACTIONS,
  getEditableLayerEntries,
  renderConfigEditCard,
  saveLayerConfig,
  stepNumericValue,
} from "./config-edit";
import {
  bold,
  box,
  cyan,
  dim,
  sanitizeText,
  terminalWidth,
} from "./primitives";
import { type KeyReader, parseKey, splitKeys } from "./select";

const SOLID_BANNER_LINES = [
  "██████╗ ██████╗       ██╗  ██╗███████╗██████╗  ██████╗ ",
  "██╔══██╗██╔══██╗      ██║  ██║██╔════╝██╔══██╗██╔═══██╗",
  "██████╔╝██████╔╝█████╗███████║█████╗  ██████╔╝██║   ██║",
  "██╔═══╝ ██╔══██╗╚════╝██╔══██║██╔══╝  ██╔══██╗██║   ██║",
  "██║     ██║  ██║      ██║  ██║███████╗██║  ██║╚██████╔╝",
  "╚═╝     ╚═╝  ╚═╝      ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ",
];

export function renderSolidHeader(width: number, styles: boolean): string[] {
  if (width >= 60) {
    return SOLID_BANNER_LINES.map((line) => cyan(bold(line, styles), styles));
  }
  const title = "PR-HERO — Multi-Agent PR Review";
  const truncated =
    width < title.length ? title.slice(0, Math.max(0, width)) : title;
  return [cyan(bold(truncated, styles), styles)];
}

export function renderContextBox(
  context: RepoContext,
  width: number,
  styles: boolean,
): string[] {
  const lines: string[] = [];

  if (context.kind === "configured-repo") {
    const name = sanitizeText(context.name);
    const root = sanitizeText(context.root);
    const base = context.defaultBase
      ? sanitizeText(context.defaultBase)
      : "auto";
    lines.push(`Repository:  ${name} (${root})`, `Base branch: ${base}`);
  } else if (context.kind === "unconfigured-repo") {
    const name = sanitizeText(context.name);
    const root = sanitizeText(context.root);
    lines.push(
      `Unconfigured Repository: ${name} (${root})`,
      "Run 'Initialize repo' to scaffold .crysk/ configuration.",
    );
  } else {
    const cwd = sanitizeText(context.cwd);
    lines.push(
      `Not inside a repository (${cwd})`,
      "Global commands and configuration are available.",
    );
  }

  return box("Current Context", lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export function renderMenuCard(
  items: MenuItem[],
  selectedIndex: number,
  width: number,
  styles: boolean,
): string[] {
  const lines: string[] = [];

  items.forEach((item, index) => {
    const isSelected = index === selectedIndex;
    const prefix = isSelected ? "▸ " : "  ";
    const num = `${index + 1}. `;
    const badge = item.badge ? ` (${item.badge})` : "";
    const submenu = item.isSubmenu ? " →" : "";

    const rawLine = `${prefix}${num}${item.label}${badge}${submenu} - ${item.desc}`;
    lines.push(sanitizeText(rawLine));
  });

  return box("Main Menu", lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export function renderPersistentFooter(
  selectedItem: MenuItem | undefined,
  _width: number,
  styles: boolean,
): string[] {
  const enterAction = selectedItem?.isSubmenu ? "open submenu" : "run";
  const hints = `j/k: move • 1-9: select • enter: ${enterAction} • q: quit`;

  const lines = [dim(hints, styles)];

  if (selectedItem) {
    lines.push(dim(`$ crysk ${selectedItem.cliHint}`, styles));
  }

  return lines;
}

export async function gatherMenuStatus(
  home: string = os.homedir(),
  cwd: string = process.cwd(),
): Promise<MenuStatusInfo> {
  let upgradeAvailable = false;
  try {
    const upgradeCache = path.join(resolveHomeDir(home), "upgrade-check.json");
    if (existsSync(upgradeCache)) {
      const parsed = JSON.parse(readFileSync(upgradeCache, "utf-8"));
      upgradeAvailable = Boolean(
        parsed.latestVersion && parsed.updateAvailable,
      );
    }
  } catch {
    // Ignore
  }

  let activeReviewsCount = 0;
  try {
    const active = await listActiveRuns({ home });
    activeReviewsCount = active.length;
  } catch {
    // Ignore
  }

  let doctorStatus: MenuStatusInfo["doctorStatus"];
  try {
    const report = await runDoctor({ home, cwd });
    doctorStatus = report.overall;
  } catch {
    // Ignore
  }

  return {
    upgradeAvailable,
    activeReviewsCount,
    doctorStatus,
  };
}

export interface MenuLoopIo {
  write: (text: string) => void;
  line: (text?: string) => void;
}

export interface MenuLoopOptions {
  context?: RepoContext;
  status?: MenuStatusInfo;
  // `context`/`status` pin only the FIRST render. Every time an action
  // returns, the loop refreshes them — and that refresh used the real
  // `resolveMenuContext` (a git subprocess) and `gatherMenuStatus` (the full
  // doctor: real `Bun.spawn` of git/claude/gh/codegraph, `gh auth status`
  // among them, which is a live network round trip). A caller that injected
  // both values still shelled out, so the refresh needs a seam of its own.
  // Both default to the real resolvers; no production caller passes either.
  resolveContext?: (cwd: string) => Promise<RepoContext>;
  gatherStatus?: (home: string, cwd: string) => Promise<MenuStatusInfo>;
  createReader?: () => KeyReader;
  io?: MenuLoopIo;
  styles?: boolean;
  width?: number;
  home?: string;
  cwd?: string;
  dispatchAction?: (
    action: string,
    item?: MenuItem,
  ) => Promise<number | "back">;
}

export function createDefaultStdinReader(): KeyReader {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return {
      raw: false,
      read: async () => undefined,
      close: () => {},
    };
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
      stdin.pause();
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignore
      }
    },
  };
}

export function clearDrawnLines(
  io: MenuLoopIo,
  drawn: number,
  repaint: boolean,
): void {
  if (!repaint || drawn <= 0) return;
  const ESC = "\x1b";
  let eraseBuf = `${ESC}[${drawn}A`;
  for (let i = 0; i < drawn; i++) {
    eraseBuf += `${ESC}[2K\n`;
  }
  eraseBuf += `${ESC}[${drawn}A`;
  io.write(eraseBuf);
}

export async function runMenuLoop(
  options: MenuLoopOptions = {},
): Promise<number> {
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const io = options.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };
  const styles = options.styles ?? false;
  let width = options.width ?? terminalWidth();

  const resolveContext = options.resolveContext ?? resolveMenuContext;
  const gatherStatus = options.gatherStatus ?? gatherMenuStatus;

  let context = options.context ?? (await resolveContext(cwd));
  let status = options.status ?? (await gatherStatus(home, cwd));
  let items = getMenuOptions(context, status);
  let cursor = 0;

  const createReader = options.createReader ?? createDefaultStdinReader;

  let isInteractive = true;
  const ESC = "\x1b";
  const repaint = styles;
  let drawn = 0;

  const render = (clearScreen = false) => {
    const lines: string[] = [];
    lines.push("");
    lines.push(...renderSolidHeader(width, styles));
    lines.push("");
    lines.push(...renderContextBox(context, width, styles));
    lines.push("");
    lines.push(...renderMenuCard(items, cursor, width, styles));
    lines.push("");
    lines.push(...renderPersistentFooter(items[cursor], width, styles));

    let buf = "";
    if (repaint && clearScreen) {
      buf += `${ESC}[2J${ESC}[H`;
      drawn = 0;
    } else if (repaint && drawn > 0) {
      buf += `${ESC}[${drawn}A`;
    }
    for (const line of lines) {
      if (repaint && drawn > 0) buf += `${ESC}[2K`;
      buf += `${line}\n`;
    }
    io.write(buf);
    drawn = lines.length;
  };

  const onResize = () => {
    if (!isInteractive) return;
    width = terminalWidth();
    render(true);
  };
  process.on("SIGWINCH", onResize);

  try {
    if (repaint) io.write(`${ESC}[?25l`);
    let needsClear = true;
    for (;;) {
      render(needsClear);
      needsClear = false;
      const reader = createReader();
      let chosenItem: MenuItem | undefined;

      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk === undefined) {
            return 0;
          }

          let shouldBreakInner = false;
          for (const rawKey of splitKeys(chunk)) {
            const key = parseKey(rawKey);
            if (
              key.type === "escape" ||
              (key.type === "char" && key.char === "q")
            ) {
              return 0;
            }
            if (key.type === "ctrl-c") {
              return 130;
            }
            if (
              key.type === "up" ||
              (key.type === "char" && key.char === "k")
            ) {
              cursor = (cursor - 1 + items.length) % items.length;
              render(false);
              continue;
            }
            if (
              key.type === "down" ||
              (key.type === "char" && key.char === "j")
            ) {
              cursor = (cursor + 1) % items.length;
              render(false);
              continue;
            }
            if (key.type === "char" && /^[1-9]$/.test(key.char)) {
              const numIdx = Number(key.char) - 1;
              if (numIdx >= 0 && numIdx < items.length) {
                cursor = numIdx;
                render(false);
              }
              continue;
            }
            if (key.type === "enter") {
              chosenItem = items[cursor];
              shouldBreakInner = true;
              break;
            }
          }

          if (shouldBreakInner) break;
        }
      } finally {
        reader.close();
      }

      if (!chosenItem) continue;
      if (chosenItem.id === "quit") return 0;

      // Dispatch action
      if (options.dispatchAction) {
        isInteractive = false;
        drawn = 0;
        if (repaint) io.write(`${ESC}[?25h`);
        let exit: number | "back";
        try {
          exit = await options.dispatchAction(chosenItem.id, chosenItem);
        } finally {
          isInteractive = true;
          width = terminalWidth();
          drawn = 0;
          if (repaint) io.write(`${ESC}[?25l`);
        }
        if (exit === "back") {
          context = await resolveContext(cwd);
          status = await gatherStatus(home, cwd);
          items = getMenuOptions(context, status);
          cursor = Math.min(cursor, items.length - 1);
          needsClear = true;
          continue;
        }
        if (
          typeof exit === "number" &&
          (chosenItem.id === "review" || chosenItem.id === "lifecycle")
        ) {
          return exit;
        }
      } else {
        io.line(`\n[Action: ${chosenItem.label}]`);
      }

      // Pause before returning to menu
      drawn = 0;
      if (repaint) io.write(`${ESC}[?25h`);
      io.line();
      io.line(dim("Press any key to return to menu...", styles));
      const pauseReader = createReader();
      try {
        await pauseReader.read();
      } finally {
        pauseReader.close();
        if (repaint) io.write(`${ESC}[?25l`);
      }

      // Refresh context and status on return
      drawn = 0;
      context = await resolveContext(cwd);
      status = await gatherStatus(home, cwd);
      items = getMenuOptions(context, status);
      cursor = Math.min(cursor, items.length - 1);
      needsClear = true;
    }
  } finally {
    clearDrawnLines(io, drawn, repaint);
    drawn = 0;
    if (repaint) io.write(`${ESC}[?25h`);
    process.off("SIGWINCH", onResize);
  }
}

export async function runLifecycleSubmenu(deps: {
  createReader?: () => KeyReader;
  io?: MenuLoopIo;
  styles?: boolean;
  width?: number;
  dispatch?: (cmd: string) => Promise<number>;
}): Promise<number | "back"> {
  const io = deps.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };
  const styles = deps.styles ?? false;
  const width = deps.width ?? 80;
  const createReader = deps.createReader ?? createDefaultStdinReader;

  const items = [
    {
      id: "upgrade",
      label: "Upgrade & sync",
      desc: "Upgrade crysk and reconcile skills",
      isTerminal: true,
    },
    {
      id: "setup",
      label: "Sync skills & MCP",
      desc: "Reconcile installed skills and MCP registrations",
      isTerminal: false,
    },
    {
      id: "uninstall",
      label: "Managed uninstall",
      desc: "Remove daemon, skills and registrations",
      isTerminal: true,
    },
    {
      id: "back",
      label: "Back",
      desc: "Return to main menu",
      isTerminal: false,
    },
  ];

  let cursor = 0;
  const ESC = "\x1b";
  const repaint = styles;
  let drawn = 0;

  const render = (clearScreen = false) => {
    const cardLines = items.map((item, idx) => {
      const prefix = idx === cursor ? "▸ " : "  ";
      return `${prefix}${idx + 1}. ${item.label} - ${item.desc}`;
    });
    const lines: string[] = [
      "",
      ...box("Lifecycle & Maintenance", cardLines, {
        width,
        styles,
        borderStyle: "double",
      }),
      dim("j/k: move • enter: select • q/esc: back", styles),
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

  try {
    if (repaint) io.write(`${ESC}[?25l`);
    let needsClear = true;
    for (;;) {
      render(needsClear);
      needsClear = false;
      const reader = createReader();
      let chosen: (typeof items)[0] | undefined;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk === undefined) return "back";
          let done = false;
          for (const raw of splitKeys(chunk)) {
            const key = parseKey(raw);
            if (
              key.type === "escape" ||
              key.type === "ctrl-c" ||
              (key.type === "char" && key.char === "q")
            ) {
              return "back";
            }
            if (
              key.type === "up" ||
              (key.type === "char" && key.char === "k")
            ) {
              cursor = (cursor - 1 + items.length) % items.length;
              render(false);
              continue;
            }
            if (
              key.type === "down" ||
              (key.type === "char" && key.char === "j")
            ) {
              cursor = (cursor + 1) % items.length;
              render(false);
              continue;
            }
            if (key.type === "char" && /^[1-4]$/.test(key.char)) {
              cursor = Number(key.char) - 1;
              render(false);
              continue;
            }
            if (key.type === "enter") {
              chosen = items[cursor];
              done = true;
              break;
            }
          }
          if (done) break;
        }
      } finally {
        reader.close();
      }

      if (!chosen || chosen.id === "back") return "back";
      if (deps.dispatch) {
        drawn = 0;
        if (repaint) io.write(`${ESC}[?25h`);
        let code = 0;
        try {
          code = await deps.dispatch(chosen.id);
        } finally {
          drawn = 0;
          if (repaint) io.write(`${ESC}[?25l`);
        }
        if (chosen.isTerminal) return code;

        io.line();
        io.line(dim("Press any key to return to menu...", styles));
        const pauseReader = createReader();
        try {
          await pauseReader.read();
        } finally {
          pauseReader.close();
          if (repaint) io.write(`${ESC}[?25l`);
        }
        needsClear = true;
      }
    }
  } finally {
    clearDrawnLines(io, drawn, repaint);
    drawn = 0;
    if (repaint) io.write(`${ESC}[?25h`);
  }
}

export async function runWatcherSubmenu(deps: {
  createReader?: () => KeyReader;
  io?: MenuLoopIo;
  styles?: boolean;
  width?: number;
  inRepo?: boolean;
  home?: string;
  dispatch?: (subcommand: string) => Promise<number>;
}): Promise<number | "back"> {
  const io = deps.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };
  const styles = deps.styles ?? false;
  const width = deps.width ?? 80;
  const inRepo = deps.inRepo ?? true;
  const home = deps.home ?? os.homedir();
  const createReader = deps.createReader ?? createDefaultStdinReader;

  const items = [
    {
      id: "status",
      label: "Watcher status",
      desc: "View watcher daemon status and enrolled repos",
    },
    {
      id: "config",
      label: "Configure limits & window",
      desc: "Edit daily review cap and active time window (~/.crysk/watch.json)",
    },
    {
      id: "install",
      label: "Install launchd daemon",
      desc: "Enable background background daemon",
    },
    {
      id: "uninstall",
      label: "Uninstall launchd daemon",
      desc: "Disable background daemon",
    },
    ...(inRepo
      ? [
          {
            id: "add",
            label: "Add current repo to watcher",
            desc: "Enroll this repository in background watcher",
          },
          {
            id: "add-on-push",
            label: "Add repo with on-push re-reviews",
            desc: "Enroll repository and trigger review on each push",
          },
          {
            id: "remove",
            label: "Remove repo from watcher",
            desc: "Unenroll a repository",
          },
        ]
      : []),
    { id: "back", label: "Back", desc: "Return to main menu" },
  ];

  let cursor = 0;
  const ESC = "\x1b";
  const repaint = styles;
  let drawn = 0;

  const render = (clearScreen = false) => {
    const cardLines = items.map((item, idx) => {
      const prefix = idx === cursor ? "▸ " : "  ";
      return `${prefix}${idx + 1}. ${item.label} - ${item.desc}`;
    });
    const lines: string[] = [
      "",
      ...box("Watcher Daemon Submenu", cardLines, {
        width,
        styles,
        borderStyle: "double",
      }),
      dim("j/k: move • enter: select • q/esc: back", styles),
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

  try {
    if (repaint) io.write(`${ESC}[?25l`);
    let needsClear = true;
    for (;;) {
      if (repaint) io.write(`${ESC}[?25l`);
      render(needsClear);
      needsClear = false;
      const reader = createReader();
      let chosen: (typeof items)[0] | undefined;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk === undefined) return "back";
          let done = false;
          for (const raw of splitKeys(chunk)) {
            const key = parseKey(raw);
            if (
              key.type === "escape" ||
              key.type === "ctrl-c" ||
              (key.type === "char" && key.char === "q")
            ) {
              return "back";
            }
            if (
              key.type === "up" ||
              (key.type === "char" && key.char === "k")
            ) {
              cursor = (cursor - 1 + items.length) % items.length;
              render(false);
              continue;
            }
            if (
              key.type === "down" ||
              (key.type === "char" && key.char === "j")
            ) {
              cursor = (cursor + 1) % items.length;
              render(false);
              continue;
            }
            if (key.type === "char" && /^[1-9]$/.test(key.char)) {
              const idx = Number(key.char) - 1;
              if (idx >= 0 && idx < items.length) {
                cursor = idx;
                render(false);
              }
              continue;
            }
            if (key.type === "enter") {
              chosen = items[cursor];
              done = true;
              break;
            }
          }
          if (done) break;
        }
      } finally {
        reader.close();
      }

      if (!chosen || chosen.id === "back") return "back";

      if (chosen.id === "config") {
        drawn = 0;
        await runLayerConfigCardEditor({
          layer: "watch",
          title: `Watcher Daemon Configuration (${path.join(resolveHomeDir(home), "watch.json")})`,
          createReader,
          io,
          styles,
          width,
          home,
        });
        drawn = 0;
        needsClear = true;
        continue;
      }

      if (deps.dispatch) {
        drawn = 0;
        if (repaint) io.write(`${ESC}[?25h`);
        try {
          await deps.dispatch(chosen.id);
        } finally {
          drawn = 0;
          if (repaint) io.write(`${ESC}[?25l`);
        }
        io.line();
        io.line(dim("Press any key to return to menu...", styles));
        const pauseReader = createReader();
        try {
          await pauseReader.read();
        } finally {
          pauseReader.close();
          if (repaint) io.write(`${ESC}[?25l`);
        }
        needsClear = true;
      }
    }
  } finally {
    clearDrawnLines(io, drawn, repaint);
    drawn = 0;
    if (repaint) io.write(`${ESC}[?25h`);
  }
}

export async function runLayerConfigCardEditor(deps: {
  layer: "team" | "person" | "watch";
  title: string;
  createReader: () => KeyReader;
  io: MenuLoopIo;
  styles: boolean;
  width: number;
  repoRoot?: string;
  home?: string;
}): Promise<void> {
  const home = deps.home ?? os.homedir();
  const repoRoot = deps.repoRoot;
  const ESC = "\x1b";
  const repaint = deps.styles;
  let drawn = 0;
  let editCursor = 0;
  let annotation: string | undefined;

  const readLayerData = (): Record<string, unknown> => {
    let filePath: string | undefined;
    if (deps.layer === "team") {
      if (!repoRoot) return {};
      filePath = path.join(resolveRepoDir(repoRoot), "config.json");
    } else if (deps.layer === "person") {
      filePath = path.join(resolveHomeDir(home), "config.json");
    } else if (deps.layer === "watch") {
      filePath = path.join(resolveHomeDir(home), "watch.json");
    }
    if (filePath && existsSync(filePath)) {
      try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        return {};
      }
    }
    return {};
  };

  const draft: Record<string, unknown> = readLayerData();
  const actions = DEFAULT_CARD_ACTIONS;

  const render = (clearScreen = false) => {
    const entries = getEditableLayerEntries(deps.layer, draft);
    const lines: string[] = [
      "",
      ...renderConfigEditCard(
        deps.title,
        entries,
        editCursor,
        deps.width,
        deps.styles,
        annotation,
        actions,
      ),
      dim(
        "j/k: move • space: toggle • ←/→: adjust • enter: select/save • u: reset • q/esc: discard",
        deps.styles,
      ),
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
    deps.io.write(buf);
    drawn = lines.length;
  };

  try {
    if (repaint) deps.io.write(`${ESC}[?25l`);
    let needsClear = true;
    for (;;) {
      render(needsClear);
      needsClear = false;

      const entries = getEditableLayerEntries(deps.layer, draft);
      const totalItems = entries.length + actions.length;
      if (entries.length === 0) return;

      const reader = deps.createReader();
      let shouldExit = false;

      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk === undefined) {
            shouldExit = true;
            break;
          }
          let actionTaken = false;
          for (const raw of splitKeys(chunk)) {
            const key = parseKey(raw);
            if (
              key.type === "escape" ||
              key.type === "ctrl-c" ||
              (key.type === "char" && key.char === "q")
            ) {
              shouldExit = true;
              break;
            }
            if (
              key.type === "up" ||
              (key.type === "char" && key.char === "k")
            ) {
              editCursor = (editCursor - 1 + totalItems) % totalItems;
              annotation = undefined;
              render(false);
              continue;
            }
            if (
              key.type === "down" ||
              (key.type === "char" && key.char === "j")
            ) {
              editCursor = (editCursor + 1) % totalItems;
              annotation = undefined;
              render(false);
              continue;
            }
            if (key.type === "char" && /^[1-9]$/.test(key.char)) {
              const idx = Number(key.char) - 1;
              if (idx < totalItems) {
                editCursor = idx;
                annotation = undefined;
                render(false);
              }
              continue;
            }

            // If cursor is on Action buttons:
            if (editCursor >= entries.length) {
              const actionIdx = editCursor - entries.length;
              if (key.type === "enter") {
                if (actionIdx === 0) {
                  // Save changes
                  const res = await saveLayerConfig({
                    layer: deps.layer,
                    draft,
                    home,
                    repoRoot,
                  });
                  annotation = res.annotation;
                  actionTaken = true;
                  break;
                }
                if (actionIdx === 1) {
                  // Discard & back
                  shouldExit = true;
                  break;
                }
                if (actionIdx === 2) {
                  // Clear all (unset)
                  for (const k of Object.keys(draft)) delete draft[k];
                  annotation =
                    "✓ Cleared draft overrides to (not set) (hit Save changes to apply)";
                  actionTaken = true;
                  break;
                }
              }
              continue;
            }

            // Cursor is on a field:
            const currentEntry = entries[editCursor];
            if (!currentEntry) continue;

            // Space: Boolean toggle in draft
            if (key.type === "char" && key.char === " ") {
              if (
                currentEntry.type === "boolean" ||
                currentEntry.key === "summary.enabled"
              ) {
                const currentBool = currentEntry.currentRaw === true;
                const nextBool = !currentBool;
                if (currentEntry.key === "summary.enabled") {
                  draft.summary = {
                    ...(typeof draft.summary === "object" &&
                    draft.summary !== null
                      ? (draft.summary as Record<string, unknown>)
                      : {}),
                    enabled: nextBool,
                  };
                } else {
                  draft[currentEntry.key] = nextBool;
                }
                actionTaken = true;
                break;
              }
            }

            // Left: Decrement numeric in draft
            if (
              key.type === "left" ||
              (key.type === "char" && key.char === "h")
            ) {
              if (currentEntry.type === "number") {
                let delta = -1;
                let min = 0;
                if (currentEntry.key === "max_changed_lines") delta = -250;
                else if (currentEntry.key === "max_changed_files") delta = -25;
                else if (currentEntry.key === "daily_cap") {
                  delta = -1;
                  min = 1;
                }

                const currentNum =
                  typeof currentEntry.currentRaw === "number"
                    ? currentEntry.currentRaw
                    : currentEntry.key === "max_changed_lines"
                      ? DEFAULT_SIZE_GATE.maxChangedLines
                      : currentEntry.key === "max_changed_files"
                        ? DEFAULT_SIZE_GATE.maxChangedFiles
                        : currentEntry.key === "max_verification_steps"
                          ? DEFAULT_MAX_VERIFICATION_STEPS
                          : currentEntry.key === "daily_cap"
                            ? DEFAULT_DAILY_CAP
                            : 1;

                const nextNum = stepNumericValue(currentNum, delta, min);
                draft[currentEntry.key] = nextNum;
                actionTaken = true;
                break;
              }
            }

            // Right: Increment numeric in draft
            if (
              key.type === "right" ||
              (key.type === "char" && key.char === "l")
            ) {
              if (currentEntry.type === "number") {
                let delta = 1;
                let min = 0;
                if (currentEntry.key === "max_changed_lines") delta = 250;
                else if (currentEntry.key === "max_changed_files") delta = 25;
                else if (currentEntry.key === "daily_cap") {
                  delta = 1;
                  min = 1;
                }

                const currentNum =
                  typeof currentEntry.currentRaw === "number"
                    ? currentEntry.currentRaw
                    : currentEntry.key === "max_changed_lines"
                      ? DEFAULT_SIZE_GATE.maxChangedLines
                      : currentEntry.key === "max_changed_files"
                        ? DEFAULT_SIZE_GATE.maxChangedFiles
                        : currentEntry.key === "max_verification_steps"
                          ? DEFAULT_MAX_VERIFICATION_STEPS
                          : currentEntry.key === "daily_cap"
                            ? DEFAULT_DAILY_CAP
                            : 1;

                const nextNum = stepNumericValue(currentNum, delta, min);
                draft[currentEntry.key] = nextNum;
                actionTaken = true;
                break;
              }
            }

            // Enter: Cycle presets or boolean toggle
            if (key.type === "enter") {
              if (
                currentEntry.type === "boolean" ||
                currentEntry.key === "summary.enabled"
              ) {
                const currentBool = currentEntry.currentRaw === true;
                const nextBool = !currentBool;
                if (currentEntry.key === "summary.enabled") {
                  draft.summary = {
                    ...(typeof draft.summary === "object" &&
                    draft.summary !== null
                      ? (draft.summary as Record<string, unknown>)
                      : {}),
                    enabled: nextBool,
                  };
                } else {
                  draft[currentEntry.key] = nextBool;
                }
                actionTaken = true;
                break;
              }
              if (currentEntry.key === "default_base") {
                const currentStr =
                  typeof currentEntry.currentRaw === "string"
                    ? currentEntry.currentRaw
                    : "main";
                const nextStr = cycleStringPreset(currentStr, [
                  "main",
                  "master",
                  "develop",
                ]);
                draft.default_base = nextStr;
                actionTaken = true;
                break;
              }
            }

            // u: Reset key in draft
            if (key.type === "char" && key.char === "u") {
              if (currentEntry.key.startsWith("summary.")) {
                if (
                  typeof draft.summary === "object" &&
                  draft.summary !== null
                ) {
                  delete (draft.summary as Record<string, unknown>).enabled;
                }
              } else {
                delete draft[currentEntry.key];
              }
              annotation = `✓ Draft reset ${currentEntry.key} to default`;
              actionTaken = true;
              break;
            }
          }
          if (shouldExit || actionTaken) break;
        }
      } finally {
        reader.close();
      }

      if (shouldExit) return;
    }
  } finally {
    clearDrawnLines(deps.io, drawn, repaint);
    drawn = 0;
    if (repaint) deps.io.write(`${ESC}[?25h`);
  }
}

export async function runConfigSubmenu(deps: {
  createReader?: () => KeyReader;
  io?: MenuLoopIo;
  styles?: boolean;
  width?: number;
  repoRoot?: string;
  home?: string;
}): Promise<number | "back"> {
  const io = deps.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };
  const styles = deps.styles ?? false;
  const width = deps.width ?? 80;
  const home = deps.home ?? os.homedir();
  const repoRoot = deps.repoRoot;
  const inRepo = Boolean(repoRoot);
  const createReader = deps.createReader ?? createDefaultStdinReader;

  const ESC = "\x1b";
  const repaint = styles;
  let drawn = 0;
  let layerCursor = 0;

  const layerItems = [
    {
      id: "team" as const,
      label: "Repository configuration",
      file: repoRoot
        ? path.join(resolveRepoDir(repoRoot), "config.json")
        : ".crysk/config.json",
      disabled: !inRepo,
    },
    {
      id: "person" as const,
      label: "Global configuration",
      file: path.join(resolveHomeDir(home), "config.json"),
      disabled: false,
    },
    {
      id: "back" as const,
      label: "Back",
      file: "Return to main menu",
      disabled: false,
    },
  ];

  const render = (clearScreen = false) => {
    const cardLines = layerItems.map((item, idx) => {
      const isSelected = idx === layerCursor;
      const prefix = isSelected ? "▸ " : "  ";
      const suffix = item.disabled
        ? " (disabled outside git repository)"
        : ` (${item.file})`;
      const line = sanitizeText(`${prefix}${idx + 1}. ${item.label}${suffix}`);
      return isSelected
        ? bold(cyan(line, styles), styles)
        : item.disabled
          ? dim(line, styles)
          : line;
    });
    const lines = [
      "",
      ...box("Select Configuration Layer", cardLines, {
        width,
        styles,
        borderStyle: "double",
      }),
      dim("j/k: move • enter: select • q/esc: back", styles),
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

  try {
    if (repaint) io.write(`${ESC}[?25l`);
    let needsClear = true;
    for (;;) {
      if (repaint) io.write(`${ESC}[?25l`);
      render(needsClear);
      needsClear = false;

      const reader = createReader();
      let selectedNext: "team" | "person" | "back" | undefined;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk === undefined) return "back";
          let shouldBreak = false;
          for (const raw of splitKeys(chunk)) {
            const key = parseKey(raw);
            if (
              key.type === "escape" ||
              key.type === "ctrl-c" ||
              (key.type === "char" && key.char === "q")
            ) {
              return "back";
            }
            if (
              key.type === "up" ||
              (key.type === "char" && key.char === "k")
            ) {
              layerCursor =
                (layerCursor - 1 + layerItems.length) % layerItems.length;
              render(false);
              continue;
            }
            if (
              key.type === "down" ||
              (key.type === "char" && key.char === "j")
            ) {
              layerCursor = (layerCursor + 1) % layerItems.length;
              render(false);
              continue;
            }
            if (key.type === "char" && /^[1-3]$/.test(key.char)) {
              layerCursor = Number(key.char) - 1;
              render(false);
              continue;
            }
            if (key.type === "enter") {
              const item = layerItems[layerCursor];
              if (item.disabled) continue;
              selectedNext = item.id;
              shouldBreak = true;
              break;
            }
          }
          if (shouldBreak) break;
        }
      } finally {
        reader.close();
      }

      if (selectedNext === "back" || !selectedNext) return "back";

      const title =
        selectedNext === "team"
          ? `Repository Configuration (${path.join(resolveRepoDir(repoRoot ?? "."), "config.json")})`
          : `Global Configuration (${path.join(resolveHomeDir(home), "config.json")})`;

      drawn = 0;
      await runLayerConfigCardEditor({
        layer: selectedNext,
        title,
        createReader,
        io,
        styles,
        width,
        repoRoot,
        home,
      });
      drawn = 0;
      needsClear = true;
    }
  } finally {
    clearDrawnLines(io, drawn, repaint);
    drawn = 0;
    if (repaint) io.write(`${ESC}[?25h`);
  }
}
