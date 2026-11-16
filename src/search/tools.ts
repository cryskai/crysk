// odd/tasks/antigravity-oauth.md T4b (S5): the three read-only tools of
// Crysk's search MCP, `grep`, `glob` and `list`, close to Claude's Grep and
// Glob so an agy step searches the way a Claude step does. In-process only:
// no shell, no child process, no network, no write. Every path goes through
// confine.ts; every result is capped (counts, line length, response bytes)
// and says when it was cut. Files and directories that `.gitignore` ignores
// are skipped, except a path the caller names (confine.ts, gitignore.ts).
import {
  gitignoreLayers,
  listDirectory,
  type ResolvedPath,
  readConfinedFile,
  resolveInside,
  SearchError,
  WalkBudget,
  walkFiles,
} from "./confine";
import { RegexTimeout, RegexWorker } from "./regex-worker";

export const SEARCH_LIMITS = {
  // Files above this are skipped by grep (generated or vendored, mostly).
  maxFileBytes: 1024 * 1024,
  // A NUL byte in this prefix marks a file binary.
  binarySniffBytes: 8 * 1024,
  defaultGrepResults: 200,
  maxGrepResults: 500,
  maxGlobPaths: 2000,
  maxListEntries: 2000,
  maxResponseBytes: 256 * 1024,
  // An output line is cut here.
  maxOutputLineChars: 500,
  // A regex runs on whole lines (L17 A5: a cut line let `$` match at the
  // cut) in a worker, and one call's matching stops after this (L17 A4).
  regexBudgetMs: 10_000,
  maxPatternChars: 1000,
  // Entries one call may visit, and its wall-clock budget.
  maxWalkEntries: 200_000,
  deadlineMs: 20_000,
} as const;

export interface SearchToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

export const SEARCH_TOOLS: readonly SearchToolDefinition[] = [
  {
    name: "grep",
    description:
      "Search file contents in the repository with a JavaScript regular expression. Returns one `path:line:text` line per match, paths relative to the repository root. Skips .git, files ignored by .gitignore (a file or directory named in `path` is searched even if ignored; rules still apply below it), binary files and files over 1 MiB.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "JavaScript regular expression to search for",
        },
        path: {
          type: "string",
          description:
            "File or directory to search, relative to the repository root (default: the whole repository)",
        },
        glob: {
          type: "string",
          description:
            'Only search files matching this glob, e.g. "*.ts" or "src/**/*.go". A glob with no "/" matches file names at any depth',
        },
        ignore_case: {
          type: "boolean",
          description: "Case-insensitive search",
        },
        max_results: {
          type: "number",
          description: `Maximum matching lines to return (default ${SEARCH_LIMITS.defaultGrepResults}, at most ${SEARCH_LIMITS.maxGrepResults})`,
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description:
      "List repository files matching a glob pattern such as **/*.ts or src/**/test_*.py, sorted, relative to the repository root. Skips files ignored by .gitignore; a directory named in `path` is searched even if ignored, but rules still apply below it.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, relative to `path`",
        },
        path: {
          type: "string",
          description:
            "Directory to search in, relative to the repository root (default: the root)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list",
    description:
      "List the entries of one repository directory, leaving out .git and entries ignored by .gitignore. Directories end with /.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory relative to the repository root (default: the root)",
        },
      },
    },
  },
];

export interface SearchToolResult {
  readonly text: string;
  readonly isError: boolean;
}

function fail(message: string): SearchToolResult {
  return { text: message, isError: true };
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new SearchError(`${key} must be a string`);
  }
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value === "") {
    throw new SearchError(`${key} is required`);
  }
  return value;
}

// Collects output lines under the byte cap.
class Output {
  private readonly lines: string[] = [];
  private bytes = 0;
  full = false;

  add(line: string): boolean {
    const cut =
      line.length > SEARCH_LIMITS.maxOutputLineChars
        ? `${line.slice(0, SEARCH_LIMITS.maxOutputLineChars)}…`
        : line;
    const size = Buffer.byteLength(cut) + 1;
    if (this.bytes + size > SEARCH_LIMITS.maxResponseBytes) {
      this.full = true;
      return false;
    }
    this.lines.push(cut);
    this.bytes += size;
    return true;
  }

  get count(): number {
    return this.lines.length;
  }

  render(empty: string, notes: readonly string[]): string {
    const body = this.lines.length === 0 ? empty : this.lines.join("\n");
    return notes.length === 0 ? body : `${body}\n${notes.join("\n")}`;
  }
}

function budget(): WalkBudget {
  return new WalkBudget(
    SEARCH_LIMITS.maxWalkEntries,
    performance.now() + SEARCH_LIMITS.deadlineMs,
  );
}

function compileGlob(pattern: string): Bun.Glob {
  if (pattern.length > SEARCH_LIMITS.maxPatternChars) {
    throw new SearchError(
      `glob is longer than ${SEARCH_LIMITS.maxPatternChars} characters`,
    );
  }
  try {
    return new Bun.Glob(pattern);
  } catch {
    throw new SearchError("invalid glob pattern");
  }
}

// Relative to the search base, like ripgrep's --glob and Claude's Glob.
function relativeToBase(base: ResolvedPath, rel: string): string {
  return base.rel === "" ? rel : rel.slice(base.rel.length + 1);
}

// A file's text for grep: undefined when unreadable or refused, "binary"
// with a NUL in its first bytes, "too-large" over maxFileBytes.
function readText(
  root: string,
  abs: string,
): string | "binary" | "too-large" | undefined {
  const bytes = readConfinedFile(root, abs, SEARCH_LIMITS.maxFileBytes);
  if (bytes === undefined || bytes === "too-large") return bytes;
  if (bytes.subarray(0, SEARCH_LIMITS.binarySniffBytes).includes(0)) {
    return "binary";
  }
  return bytes.toString("utf8");
}

// Files go to the regex worker in batches of about this much text.
const GREP_BATCH_BYTES = 1024 * 1024;
const GREP_BATCH_FILES = 256;

async function grep(
  root: string,
  args: Record<string, unknown>,
): Promise<SearchToolResult> {
  const pattern = requiredString(args, "pattern");
  if (pattern.length > SEARCH_LIMITS.maxPatternChars) {
    return fail(
      `pattern is longer than ${SEARCH_LIMITS.maxPatternChars} characters`,
    );
  }
  const ignoreCase = args.ignore_case;
  if (ignoreCase !== undefined && typeof ignoreCase !== "boolean") {
    return fail("ignore_case must be a boolean");
  }
  const requestedMax = args.max_results;
  if (
    requestedMax !== undefined &&
    (typeof requestedMax !== "number" || !Number.isFinite(requestedMax))
  ) {
    return fail("max_results must be a number");
  }
  const maxResults = Math.max(
    1,
    Math.min(
      Math.floor(requestedMax ?? SEARCH_LIMITS.defaultGrepResults),
      SEARCH_LIMITS.maxGrepResults,
    ),
  );
  const flags = ignoreCase === true ? "i" : "";
  try {
    // Compiled here only to refuse an invalid pattern; it runs in the worker.
    new RegExp(pattern, flags);
  } catch {
    return fail("invalid regular expression");
  }
  const globText = optionalString(args, "glob");
  const glob = globText === undefined ? undefined : compileGlob(globText);
  const byName = globText !== undefined && !globText.includes("/");
  const base = resolveInside(root, optionalString(args, "path"));

  const walk = budget();
  const output = new Output();
  let truncated = false;
  let skipped = 0;
  // One past the output cut, so Output still marks a cut line with "…".
  const matcher = new RegexWorker(
    pattern,
    flags,
    SEARCH_LIMITS.regexBudgetMs,
    SEARCH_LIMITS.maxOutputLineChars + 1,
  );
  let batch: { readonly rel: string; readonly text: string }[] = [];
  let batchBytes = 0;
  // false once no more output is wanted.
  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true;
    const files = batch;
    batch = [];
    batchBytes = 0;
    const result = await matcher.match(
      files.map((file) => file.text),
      maxResults - output.count,
    );
    for (const [index, line, text] of result.matches) {
      const file = files[index] as { readonly rel: string };
      if (!output.add(`${file.rel}:${line}:${text}`)) return false;
    }
    if (result.more) {
      truncated = true;
      return false;
    }
    return true;
  };
  try {
    let wanted = true;
    for (const file of walkFiles(root, base, walk)) {
      if (glob !== undefined) {
        const subject = byName
          ? (file.rel.split("/").pop() ?? file.rel)
          : relativeToBase(base, file.rel);
        if (!glob.match(subject)) continue;
      }
      const text = readText(root, file.abs);
      if (text === "too-large") skipped++;
      if (text === undefined || text === "binary" || text === "too-large") {
        continue;
      }
      batch.push({ rel: file.rel, text });
      batchBytes += text.length;
      if (batchBytes >= GREP_BATCH_BYTES || batch.length >= GREP_BATCH_FILES) {
        wanted = await flush();
        if (!wanted) break;
      }
    }
    if (wanted) await flush();
  } catch (error) {
    if (error instanceof RegexTimeout) {
      return fail(
        `pattern took too long (over ${SEARCH_LIMITS.regexBudgetMs / 1000} s of matching); simplify the regular expression or narrow the path or glob`,
      );
    }
    throw error;
  } finally {
    matcher.close();
  }
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `[truncated: more than ${maxResults} matches; narrow the pattern, path or glob]`,
    );
  }
  if (output.full) {
    notes.push(
      `[truncated: response reached ${SEARCH_LIMITS.maxResponseBytes} bytes; narrow the search]`,
    );
  }
  if (walk.exhausted) {
    notes.push(
      "[truncated: the search budget ran out; narrow the path or glob]",
    );
  }
  if (skipped > 0) {
    notes.push(
      `[skipped ${skipped} file(s) over ${SEARCH_LIMITS.maxFileBytes} bytes]`,
    );
  }
  return { text: output.render("No matches found", notes), isError: false };
}

function glob(root: string, args: Record<string, unknown>): SearchToolResult {
  const matcher = compileGlob(requiredString(args, "pattern"));
  const base = resolveInside(root, optionalString(args, "path"));
  if (!base.isDirectory) return fail("path is not a directory");
  const walk = budget();
  const matches: string[] = [];
  let truncated = false;
  for (const file of walkFiles(root, base, walk)) {
    if (!matcher.match(relativeToBase(base, file.rel))) continue;
    if (matches.length >= SEARCH_LIMITS.maxGlobPaths) {
      truncated = true;
      break;
    }
    matches.push(file.rel);
  }
  matches.sort();
  const output = new Output();
  for (const match of matches) {
    if (!output.add(match)) break;
  }
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `[truncated: more than ${SEARCH_LIMITS.maxGlobPaths} paths; narrow the pattern or path]`,
    );
  }
  if (output.full) {
    notes.push(
      `[truncated: response reached ${SEARCH_LIMITS.maxResponseBytes} bytes]`,
    );
  }
  if (walk.exhausted) {
    notes.push("[truncated: the search budget ran out; narrow the path]");
  }
  return { text: output.render("No files found", notes), isError: false };
}

function list(root: string, args: Record<string, unknown>): SearchToolResult {
  const base = resolveInside(root, optionalString(args, "path"));
  if (!base.isDirectory) return fail("path is not a directory");
  const entries = listDirectory(
    root,
    base.abs,
    base.rel,
    gitignoreLayers(root, base.rel),
  );
  const output = new Output();
  let truncated = false;
  for (const entry of entries) {
    if (output.count >= SEARCH_LIMITS.maxListEntries) {
      truncated = true;
      break;
    }
    if (!output.add(entry.isDirectory ? `${entry.name}/` : entry.name)) break;
  }
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `[truncated: more than ${SEARCH_LIMITS.maxListEntries} entries]`,
    );
  }
  if (output.full) {
    notes.push(
      `[truncated: response reached ${SEARCH_LIMITS.maxResponseBytes} bytes]`,
    );
  }
  return { text: output.render("(empty directory)", notes), isError: false };
}

type Handler = (
  root: string,
  args: Record<string, unknown>,
) => SearchToolResult | Promise<SearchToolResult>;

const HANDLERS: Readonly<Record<string, Handler>> = { grep, glob, list };

export async function callSearchTool(
  root: string,
  name: unknown,
  args: unknown,
): Promise<SearchToolResult> {
  if (typeof name !== "string" || !Object.hasOwn(HANDLERS, name)) {
    return fail(`unknown tool: ${String(name).slice(0, 64)}`);
  }
  const handler = HANDLERS[name] as Handler;
  const record =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : args === undefined
        ? {}
        : undefined;
  if (record === undefined) return fail("arguments must be an object");
  try {
    return await handler(root, record);
  } catch (error) {
    // Only our own refusals carry their message: an fs error names host paths.
    return fail(error instanceof SearchError ? error.message : "search failed");
  }
}
