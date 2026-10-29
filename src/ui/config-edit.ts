import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mergeConfig,
  parseGlobalConfig,
  parseLocalConfig,
} from "#review/preflight";
import { resolveHomeDir, resolveRepoDir } from "../brand-paths";
import { bold, box, cyan, dim, sanitizeText, yellow } from "./primitives";
import type { KeyReader } from "./select";

export interface ConfigEntry {
  key: string;
  value: string;
  desc: string;
  type?: "string" | "number" | "boolean";
  currentRaw?: unknown;
}

export function getEditableLayerEntries(
  layer: "team" | "person" | "watch",
  rawData: Record<string, unknown>,
): ConfigEntry[] {
  if (layer === "team") {
    const base =
      typeof rawData.default_base === "string"
        ? rawData.default_base
        : "(not set)";
    const lines =
      typeof rawData.max_changed_lines === "number"
        ? rawData.max_changed_lines.toString()
        : "(not set)";
    const files =
      typeof rawData.max_changed_files === "number"
        ? rawData.max_changed_files.toString()
        : "(not set)";
    const steps =
      typeof rawData.max_verification_steps === "number"
        ? rawData.max_verification_steps.toString()
        : "(not set)";
    const summaryObj =
      typeof rawData.summary === "object" && rawData.summary !== null
        ? (rawData.summary as Record<string, unknown>)
        : {};
    const summaryEnabled =
      typeof summaryObj.enabled === "boolean"
        ? summaryObj.enabled
          ? "[✓] true"
          : "[ ] false"
        : "(not set)";
    const scoutVal =
      typeof rawData.scout === "boolean"
        ? rawData.scout
          ? "[✓] true"
          : "[ ] false"
        : "(not set)";
    const postVal =
      typeof rawData.post === "boolean"
        ? rawData.post
          ? "[✓] true"
          : "[ ] false"
        : "(not set)";

    return [
      {
        key: "default_base",
        value: base,
        desc: "Default base branch",
        type: "string",
        currentRaw: rawData.default_base,
      },
      {
        key: "max_changed_lines",
        value: lines,
        desc: "Line budget threshold (0 disables)",
        type: "number",
        currentRaw: rawData.max_changed_lines,
      },
      {
        key: "max_changed_files",
        value: files,
        desc: "File budget threshold (0 disables)",
        type: "number",
        currentRaw: rawData.max_changed_files,
      },
      {
        key: "max_verification_steps",
        value: steps,
        desc: "Max refuter verification steps",
        type: "number",
        currentRaw: rawData.max_verification_steps,
      },
      {
        key: "summary.enabled",
        value: summaryEnabled,
        desc: "Generate AI summary overview",
        type: "boolean",
        currentRaw: summaryObj.enabled,
      },
      {
        key: "scout",
        value: scoutVal,
        desc: "Run scout reconnaissance stage",
        type: "boolean",
        currentRaw: rawData.scout,
      },
      {
        key: "post",
        value: postVal,
        desc: "Publish review as PR comment",
        type: "boolean",
        currentRaw: rawData.post,
      },
    ];
  }

  if (layer === "person") {
    const lines =
      typeof rawData.max_changed_lines === "number"
        ? rawData.max_changed_lines.toString()
        : "(not set)";
    const files =
      typeof rawData.max_changed_files === "number"
        ? rawData.max_changed_files.toString()
        : "(not set)";
    const steps =
      typeof rawData.max_verification_steps === "number"
        ? rawData.max_verification_steps.toString()
        : "(not set)";
    const summaryObj =
      typeof rawData.summary === "object" && rawData.summary !== null
        ? (rawData.summary as Record<string, unknown>)
        : {};
    const summaryEnabled =
      typeof summaryObj.enabled === "boolean"
        ? summaryObj.enabled
          ? "[✓] true"
          : "[ ] false"
        : "(not set)";
    const scoutVal =
      typeof rawData.scout === "boolean"
        ? rawData.scout
          ? "[✓] true"
          : "[ ] false"
        : "(not set)";
    const postVal =
      typeof rawData.post === "boolean"
        ? rawData.post
          ? "[✓] true"
          : "[ ] false"
        : "(not set)";

    return [
      {
        key: "max_changed_lines",
        value: lines,
        desc: "Personal line budget ceiling (0 disables)",
        type: "number",
        currentRaw: rawData.max_changed_lines,
      },
      {
        key: "max_changed_files",
        value: files,
        desc: "Personal file budget ceiling (0 disables)",
        type: "number",
        currentRaw: rawData.max_changed_files,
      },
      {
        key: "max_verification_steps",
        value: steps,
        desc: "Personal max refuter ceiling",
        type: "number",
        currentRaw: rawData.max_verification_steps,
      },
      {
        key: "summary.enabled",
        value: summaryEnabled,
        desc: "Generate AI summary overview",
        type: "boolean",
        currentRaw: summaryObj.enabled,
      },
      {
        key: "scout",
        value: scoutVal,
        desc: "Personal scout reconnaissance ceiling",
        type: "boolean",
        currentRaw: rawData.scout,
      },
      {
        key: "post",
        value: postVal,
        desc: "Personal PR posting ceiling",
        type: "boolean",
        currentRaw: rawData.post,
      },
    ];
  }

  if (layer === "watch") {
    const cap =
      typeof rawData.daily_cap === "number"
        ? rawData.daily_cap.toString()
        : "(not set)";
    let windowStr = "(not set)";
    if (typeof rawData.window === "object" && rawData.window !== null) {
      const w = rawData.window as { start?: string; end?: string };
      if (w.start && w.end) {
        windowStr = `${w.start}-${w.end}`;
      }
    } else if (typeof rawData.window === "string") {
      windowStr = rawData.window;
    }
    return [
      {
        key: "daily_cap",
        value: cap,
        desc: "Daily automatic review limit",
        type: "number",
        currentRaw: rawData.daily_cap,
      },
      {
        key: "window",
        value: windowStr,
        desc: "Active hours window (e.g. 09:00-18:00)",
        type: "string",
        currentRaw: rawData.window,
      },
    ];
  }

  return [];
}

export function stepNumericValue(
  current: number,
  delta: number,
  min = 0,
  max?: number,
): number {
  const next = current + delta;
  const clampedMin = Math.max(min, next);
  return max !== undefined ? Math.min(max, clampedMin) : clampedMin;
}

export function toggleBooleanValue(current: boolean): boolean {
  return !current;
}

export function cycleStringPreset(
  current: string,
  presets: readonly string[],
): string {
  if (presets.length === 0) return current;
  const idx = presets.indexOf(current);
  if (idx === -1) return presets[0];
  return presets[(idx + 1) % presets.length];
}

export function renderConfigLayerSelection(
  layers: string[],
  cursor: number,
  width: number,
  styles: boolean,
): string[] {
  const lines = layers.map((layer, idx) => {
    const isSelected = idx === cursor;
    const prefix = isSelected ? "▸ " : "  ";
    const line = sanitizeText(`${prefix}${idx + 1}. ${layer}`);
    return isSelected ? bold(cyan(line, styles), styles) : line;
  });

  return box("Select Configuration Layer", lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export const DEFAULT_CARD_ACTIONS = [
  "[ Save changes ]",
  "[ Discard & back ]",
  "[ Clear all (unset) ]",
] as const;

export function renderConfigEditCard(
  title: string,
  entries: ConfigEntry[],
  cursor: number,
  width: number,
  styles: boolean,
  annotation?: string,
  actions: readonly string[] = DEFAULT_CARD_ACTIONS,
): string[] {
  const lines: string[] = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const isSelected = idx === cursor;
    const prefix = isSelected ? "▸ " : "  ";
    const rawLine = `${prefix}${entry.key}: ${entry.value} — ${entry.desc}`;
    const sanitized = sanitizeText(rawLine);
    lines.push(isSelected ? bold(cyan(sanitized, styles), styles) : sanitized);
  }

  if (actions.length > 0) {
    lines.push("");
    const innerWidth = Math.max(10, width - 4);
    lines.push(dim("─".repeat(innerWidth), styles));
    for (let i = 0; i < actions.length; i++) {
      const actionIdx = entries.length + i;
      const isSelected = actionIdx === cursor;
      const prefix = isSelected ? "▸ " : "  ";
      const line = `${prefix}${actions[i]}`;
      lines.push(
        isSelected ? bold(cyan(line, styles), styles) : sanitizeText(line),
      );
    }
  }

  if (annotation) {
    lines.push("");
    lines.push(sanitizeText(`  ${yellow("Note:", styles)} ${annotation}`));
  }

  return box(title, lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export async function saveLayerConfig(input: {
  layer: "team" | "person" | "watch";
  draft: Record<string, unknown>;
  home?: string;
  repoRoot?: string;
}): Promise<{ status: "ok"; annotation?: string }> {
  const home = input.home ?? os.homedir();
  let targetFile: string;

  if (input.layer === "team") {
    if (!input.repoRoot) {
      throw new Error(
        "cannot edit team configuration outside a git repository",
      );
    }
    targetFile = path.join(resolveRepoDir(input.repoRoot), "config.json");
  } else if (input.layer === "person") {
    targetFile = path.join(resolveHomeDir(home), "config.json");
  } else {
    targetFile = path.join(resolveHomeDir(home), "watch.json");
  }

  const dir = path.dirname(targetFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(targetFile, `${JSON.stringify(input.draft, null, 2)}\n`);

  let annotation: string | undefined;
  if (input.layer === "team") {
    const personFile = path.join(resolveHomeDir(home), "config.json");
    if (existsSync(personFile)) {
      try {
        const personData = JSON.parse(readFileSync(personFile, "utf-8"));
        if (
          typeof input.draft.max_verification_steps === "number" &&
          typeof personData.max_verification_steps === "number" &&
          input.draft.max_verification_steps > personData.max_verification_steps
        ) {
          annotation = `effective max_verification_steps remains ${personData.max_verification_steps} (capped by person config)`;
        } else if (
          typeof input.draft.max_changed_lines === "number" &&
          typeof personData.max_changed_lines === "number" &&
          input.draft.max_changed_lines > personData.max_changed_lines
        ) {
          annotation = `effective max_changed_lines remains ${personData.max_changed_lines} (capped by person config)`;
        } else if (
          typeof input.draft.max_changed_files === "number" &&
          typeof personData.max_changed_files === "number" &&
          input.draft.max_changed_files > personData.max_changed_files
        ) {
          annotation = `effective max_changed_files remains ${personData.max_changed_files} (capped by person config)`;
        }
      } catch {
        // ignore
      }
    }
  }

  const saveAnnotation = annotation
    ? `✓ Saved ${targetFile} (${annotation})`
    : `✓ Saved ${targetFile}`;

  return { status: "ok", annotation: saveAnnotation };
}

const TIME_WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function setConfigValue(input: {
  layer: "person" | "team" | "watch";
  key: string;
  value: string;
  home?: string;
  repoRoot?: string;
}): Promise<{ status: "ok"; annotation?: string }> {
  const home = input.home ?? os.homedir();

  if (input.layer === "team") {
    if (!input.repoRoot) {
      throw new Error(
        "cannot edit team configuration outside a git repository",
      );
    }
    const repoConfigPath = path.join(
      resolveRepoDir(input.repoRoot),
      "config.json",
    );
    let currentRepo: Record<string, unknown> = {};
    if (existsSync(repoConfigPath)) {
      try {
        currentRepo = JSON.parse(readFileSync(repoConfigPath, "utf-8"));
      } catch {
        currentRepo = {};
      }
    }

    let parsedVal: unknown = input.value;
    if (input.key === "max_verification_steps") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num < 0) {
        throw new Error(
          "max_verification_steps must be a non-negative integer",
        );
      }
      parsedVal = num;
      currentRepo.max_verification_steps = num;
    } else if (input.key === "max_changed_lines") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num < 0) {
        throw new Error("max_changed_lines must be a non-negative integer");
      }
      parsedVal = num;
      currentRepo.max_changed_lines = num;
    } else if (input.key === "max_changed_files") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num < 0) {
        throw new Error("max_changed_files must be a non-negative integer");
      }
      parsedVal = num;
      currentRepo.max_changed_files = num;
    } else if (input.key === "summary.enabled") {
      const b = input.value.toLowerCase() === "true";
      parsedVal = b;
      currentRepo.summary = {
        ...(typeof currentRepo.summary === "object" &&
        currentRepo.summary !== null
          ? (currentRepo.summary as Record<string, unknown>)
          : {}),
        enabled: b,
      };
    } else if (input.key === "summary.model") {
      if (typeof input.value !== "string" || input.value.trim().length === 0) {
        throw new Error("summary.model must be a non-empty string");
      }
      currentRepo.summary = {
        ...(typeof currentRepo.summary === "object" &&
        currentRepo.summary !== null
          ? (currentRepo.summary as Record<string, unknown>)
          : {}),
        model: input.value.trim(),
      };
    } else if (input.key === "default_base") {
      if (typeof input.value !== "string" || input.value.trim().length === 0) {
        throw new Error("default_base must be a non-empty string");
      }
      currentRepo.default_base = input.value.trim();
    } else if (input.key === "parity_trigger_paths") {
      let paths: string[];
      if (input.value.startsWith("[")) {
        try {
          paths = JSON.parse(input.value);
        } catch {
          throw new Error(
            "parity_trigger_paths must be an array of non-empty strings",
          );
        }
      } else {
        paths = input.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.some((p) => typeof p !== "string" || p.trim().length === 0)
      ) {
        throw new Error(
          "parity_trigger_paths must be an array of non-empty strings",
        );
      }
      currentRepo.parity_trigger_paths = paths;
    } else if (input.key === "agents_dir") {
      currentRepo.agents_dir = input.value.trim();
    } else if (input.key === "scout") {
      const b = input.value.toLowerCase() === "true";
      parsedVal = b;
      currentRepo.scout = b;
    } else if (input.key === "post") {
      const b = input.value.toLowerCase() === "true";
      parsedVal = b;
      currentRepo.post = b;
    } else {
      throw new Error(
        `unknown or unsupported key for team configuration: ${input.key}`,
      );
    }

    writeFileSync(repoConfigPath, `${JSON.stringify(currentRepo, null, 2)}\n`);

    // Check annotation from mergeConfig
    let annotation: string | undefined;
    const personConfigPath = path.join(resolveHomeDir(home), "config.json");
    if (existsSync(personConfigPath)) {
      try {
        const globalLayer = parseGlobalConfig(
          readFileSync(personConfigPath, "utf-8"),
        );
        const repoLayer = parseLocalConfig(
          readFileSync(repoConfigPath, "utf-8"),
        );
        const merged = mergeConfig(globalLayer, repoLayer);
        if (
          input.key === "max_verification_steps" &&
          globalLayer.max_verification_steps !== undefined &&
          parsedVal !== merged.effective.max_verification_steps
        ) {
          annotation = `written: ${parsedVal} — your effective value remains ${merged.effective.max_verification_steps}, capped by your Person layer`;
        } else if (
          input.key === "max_changed_lines" &&
          globalLayer.max_changed_lines !== undefined &&
          parsedVal !== merged.effective.max_changed_lines
        ) {
          annotation = `written: ${parsedVal} — your effective value remains ${merged.effective.max_changed_lines}, capped by your Person layer`;
        } else if (
          input.key === "max_changed_files" &&
          globalLayer.max_changed_files !== undefined &&
          parsedVal !== merged.effective.max_changed_files
        ) {
          annotation = `written: ${parsedVal} — your effective value remains ${merged.effective.max_changed_files}, capped by your Person layer`;
        } else if (
          input.key === "summary.enabled" &&
          globalLayer.summary?.enabled !== undefined &&
          merged.effective.summary?.enabled !== parsedVal
        ) {
          annotation = `written: ${parsedVal} — your effective value remains ${merged.effective.summary?.enabled}, capped by your Person layer`;
        } else if (
          input.key === "scout" &&
          globalLayer.scout !== undefined &&
          merged.effective.scout !== parsedVal
        ) {
          annotation = `written: ${parsedVal} — your effective value remains ${merged.effective.scout}, capped by your Person layer`;
        } else if (
          input.key === "post" &&
          globalLayer.post !== undefined &&
          merged.effective.post !== parsedVal
        ) {
          annotation = `written: ${parsedVal} — your effective value remains ${merged.effective.post}, capped by your Person layer`;
        }
      } catch {
        // Ignore
      }
    }

    return { status: "ok", annotation };
  }

  if (input.layer === "person") {
    if (
      input.key === "default_base" ||
      input.key === "parity_trigger_paths" ||
      input.key === "suspicion_priors"
    ) {
      throw new Error(
        `${input.key} is a per-repo key; use --team to configure it.`,
      );
    }

    const personConfigPath = path.join(resolveHomeDir(home), "config.json");
    let currentPerson: Record<string, unknown> = {};
    if (existsSync(personConfigPath)) {
      try {
        currentPerson = JSON.parse(readFileSync(personConfigPath, "utf-8"));
      } catch {
        currentPerson = {};
      }
    }

    if (input.key === "max_verification_steps") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num < 0) {
        throw new Error(
          "max_verification_steps must be a non-negative integer",
        );
      }
      currentPerson.max_verification_steps = num;
    } else if (input.key === "max_changed_lines") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num < 0) {
        throw new Error("max_changed_lines must be a non-negative integer");
      }
      currentPerson.max_changed_lines = num;
    } else if (input.key === "max_changed_files") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num < 0) {
        throw new Error("max_changed_files must be a non-negative integer");
      }
      currentPerson.max_changed_files = num;
    } else if (input.key === "summary.enabled") {
      const b = input.value.toLowerCase() === "true";
      currentPerson.summary = {
        ...(typeof currentPerson.summary === "object" &&
        currentPerson.summary !== null
          ? (currentPerson.summary as Record<string, unknown>)
          : {}),
        enabled: b,
      };
    } else if (input.key === "summary.model") {
      if (typeof input.value !== "string" || input.value.trim().length === 0) {
        throw new Error("summary.model must be a non-empty string");
      }
      currentPerson.summary = {
        ...(typeof currentPerson.summary === "object" &&
        currentPerson.summary !== null
          ? (currentPerson.summary as Record<string, unknown>)
          : {}),
        model: input.value.trim(),
      };
    } else if (input.key === "agents_dir") {
      currentPerson.agents_dir = input.value.trim();
    } else if (input.key === "scout") {
      const b = input.value.toLowerCase() === "true";
      currentPerson.scout = b;
    } else if (input.key === "post") {
      const b = input.value.toLowerCase() === "true";
      currentPerson.post = b;
    } else {
      throw new Error(
        `unknown or unsupported key for person configuration: ${input.key}`,
      );
    }

    writeFileSync(
      personConfigPath,
      `${JSON.stringify(currentPerson, null, 2)}\n`,
    );
    return { status: "ok" };
  }

  if (input.layer === "watch") {
    const watchConfigPath = path.join(resolveHomeDir(home), "watch.json");
    let currentWatch: Record<string, unknown> = {};
    if (existsSync(watchConfigPath)) {
      try {
        currentWatch = JSON.parse(readFileSync(watchConfigPath, "utf-8"));
      } catch {
        currentWatch = {};
      }
    }

    if (input.key === "daily_cap") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num <= 0) {
        throw new Error("daily_cap must be a positive integer");
      }
      currentWatch.daily_cap = num;
    } else if (input.key === "window") {
      const parts = input.value.split("-");
      if (
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1] ||
        !TIME_WINDOW_RE.test(parts[0]) ||
        !TIME_WINDOW_RE.test(parts[1]) ||
        parts[0] === parts[1]
      ) {
        throw new Error(
          "window must be in format 'HH:MM-HH:MM' with valid 24h times where start != end",
        );
      }
      currentWatch.window = { start: parts[0], end: parts[1] };
    } else {
      throw new Error(
        `unknown or unsupported key for watch configuration: ${input.key}`,
      );
    }

    writeFileSync(
      watchConfigPath,
      `${JSON.stringify(currentWatch, null, 2)}\n`,
    );
    return { status: "ok" };
  }

  return { status: "ok" };
}

export async function unsetConfigValue(input: {
  layer: "person" | "team" | "watch";
  key: string;
  home?: string;
  repoRoot?: string;
}): Promise<{ status: "ok" }> {
  const home = input.home ?? os.homedir();

  const removeKey = (obj: Record<string, unknown>, key: string) => {
    if (key.startsWith("summary.")) {
      const sub = key.slice("summary.".length);
      if (obj.summary && typeof obj.summary === "object") {
        delete (obj.summary as Record<string, unknown>)[sub];
      }
    } else {
      delete obj[key];
    }
  };

  if (input.layer === "team") {
    if (!input.repoRoot) {
      throw new Error(
        "cannot edit team configuration outside a git repository",
      );
    }
    const repoConfigPath = path.join(
      resolveRepoDir(input.repoRoot),
      "config.json",
    );
    if (existsSync(repoConfigPath)) {
      const current = JSON.parse(readFileSync(repoConfigPath, "utf-8"));
      removeKey(current, input.key);
      writeFileSync(repoConfigPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    return { status: "ok" };
  }

  if (input.layer === "person") {
    const personConfigPath = path.join(resolveHomeDir(home), "config.json");
    if (existsSync(personConfigPath)) {
      const current = JSON.parse(readFileSync(personConfigPath, "utf-8"));
      removeKey(current, input.key);
      writeFileSync(personConfigPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    return { status: "ok" };
  }

  if (input.layer === "watch") {
    const watchConfigPath = path.join(resolveHomeDir(home), "watch.json");
    if (existsSync(watchConfigPath)) {
      const current = JSON.parse(readFileSync(watchConfigPath, "utf-8"));
      removeKey(current, input.key);
      writeFileSync(watchConfigPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    return { status: "ok" };
  }

  return { status: "ok" };
}

export async function runConfigEditor(
  deps: {
    home?: string;
    repoRoot?: string;
    width?: number;
    styles?: boolean;
    createReader?: () => KeyReader;
    io?: { write: (t: string) => void; line: (t?: string) => void };
  } = {},
): Promise<number> {
  const styles = deps.styles ?? false;
  const io = deps.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };

  io.line();
  io.line(bold("Interactive Configuration Editor", styles));
  io.line(
    dim(
      "Person layer: ~/.crysk/config.json (~/.prhero/config.json on a pre-rename install)",
      styles,
    ),
  );
  if (deps.repoRoot) {
    io.line(
      dim(
        `Team layer: ${path.join(resolveRepoDir(deps.repoRoot), "config.json")}`,
        styles,
      ),
    );
  } else {
    io.line(dim("Team layer: (disabled outside git repository)", styles));
  }
  io.line(
    dim(
      "Watcher layer: ~/.crysk/watch.json (~/.prhero/watch.json on a pre-rename install)",
      styles,
    ),
  );
  io.line();
  io.line(
    "Use 'pr-hero config set <key> <value> [--person|--team|--watch]' to modify configuration.",
  );
  return 0;
}
