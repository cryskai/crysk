import { existsSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import {
  isSecretName,
  nameParts,
  redactEvidenceText,
  redactSecretShapes,
} from "../security/evidence-redaction";
import { redactDiagnostic } from "../security/redact";
import type { TransportRequest } from "./contracts";

export const CLAUDE_TRACE_MISSES = [
  "session file missing",
  "more than one session file",
  "session trace write failed",
] as const;

export type ClaudeTraceMiss = (typeof CLAUDE_TRACE_MISSES)[number];

// The transport names the CLI's session; the harness owns the run-dir path.
// The request object is the only value both already hold, so the id crosses
// without a new field on TransportRequest or TransportOutcome.
const retained = new WeakMap<TransportRequest, string>();

export function claudeSessionTracePath(
  outPath: string,
  stepName: string,
  attempt: number,
): string {
  return path.join(
    path.dirname(outPath),
    `trace.${stepName}.attempt${attempt}.jsonl`,
  );
}

export function claudeTraceCaptureAnnotation(reason: ClaudeTraceMiss): string {
  return `[pr-hero] claude session trace was not copied (${reason})`;
}

// A fresh id for the CLI's `--session-id`, which requires a UUID. The engine
// picks it instead of reading the CLI's result: an attempt that times out, is
// killed or is cancelled prints no result, yet its session file is written as
// the conversation goes, and failed attempts are the transcripts that matter
// most.
export function newClaudeSessionId(): string {
  return crypto.randomUUID();
}

// Called once the child is spawned, so an attempt that never started a CLI
// (prompt integrity denied, execve refused) has no transcript to look for.
export function retainClaudeSession(
  request: TransportRequest,
  sessionId: string,
): void {
  retained.set(request, sessionId);
}

async function findSessionFile(
  configHome: string,
  sessionId: string,
): Promise<string | ClaudeTraceMiss> {
  const projects = path.join(configHome, "projects");
  if (!existsSync(projects)) return "session file missing";
  const matches: string[] = [];
  const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
  for await (const relative of glob.scan({ cwd: projects, onlyFiles: true })) {
    matches.push(path.join(projects, relative));
    if (matches.length > 1) return "more than one session file";
  }
  const only = matches[0];
  return only === undefined ? "session file missing" : only;
}

// Copies one attempt's session JSONL into the run dir, whatever way the
// attempt ended. Undefined means no Claude CLI process was spawned, or the
// copy landed. A miss string is a warning: the caller must not fail the
// attempt.
export async function copyRetainedClaudeSession(
  request: TransportRequest,
  dest: string,
): Promise<ClaudeTraceMiss | undefined> {
  const noted = retained.get(request);
  if (noted === undefined) {
    await dropStaleTrace(dest);
    return undefined;
  }
  try {
    const source = await findSessionFile(
      request.isolation.syntheticConfigHome,
      noted,
    );
    if (
      source === "session file missing" ||
      source === "more than one session file"
    ) {
      await dropStaleTrace(dest);
      return source;
    }
    await copySessionJsonl(source, dest);
    return undefined;
  } catch {
    await dropStaleTrace(dest);
    return "session trace write failed";
  }
}

// A session file can be any size (a 61 MB one took about 526 MB to redact
// whole), and several hunters copy at once. So the copy streams: one line at
// a time, a line over MAX_LINE_BYTES becomes the omitted marker without being
// held, and the copy stops at MAX_COPY_BYTES with the truncated marker.
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_COPY_BYTES = 64 * 1024 * 1024;
const OMITTED_LINE = JSON.stringify({ crysk: "session line omitted" });
const TRUNCATED_LINE = `${JSON.stringify({ crysk: "session truncated" })}\n`;
const NEWLINE = 0x0a;

async function copySessionJsonl(source: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const out = await open(dest, "w");
  const reader = Bun.file(source).stream().getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const truncatedBytes = encoder.encode(TRUNCATED_LINE).byteLength;
  let written = 0;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let overLimit = false;

  // False once the cap is reached: the truncated marker is written instead.
  const emit = async (line: string, newline: boolean): Promise<boolean> => {
    const bytes = encoder.encode(newline ? `${line}\n` : line);
    if (written + bytes.byteLength + truncatedBytes > MAX_COPY_BYTES) {
      await out.write(TRUNCATED_LINE);
      return false;
    }
    await out.write(bytes);
    written += bytes.byteLength;
    return true;
  };
  const finishLine = (): string => {
    const line = overLimit
      ? OMITTED_LINE
      : redactSessionLine(decoder.decode(Buffer.concat(pending)));
    pending = [];
    pendingBytes = 0;
    overLimit = false;
    return line;
  };
  const hold = (bytes: Uint8Array): void => {
    if (overLimit || bytes.byteLength === 0) return;
    if (pendingBytes + bytes.byteLength > MAX_LINE_BYTES) {
      overLimit = true;
      pending = [];
      pendingBytes = 0;
      return;
    }
    pending.push(bytes);
    pendingBytes += bytes.byteLength;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (
        let at = value.indexOf(NEWLINE);
        at !== -1;
        at = value.indexOf(NEWLINE, start)
      ) {
        hold(value.subarray(start, at));
        start = at + 1;
        if (!(await emit(finishLine(), true))) return;
      }
      hold(value.subarray(start));
    }
    if (pendingBytes > 0 || overLimit) await emit(finishLine(), false);
  } finally {
    await reader.cancel().catch(() => undefined);
    await out.close();
  }
}

// The key rule of redactEvidence, kept whole: a match loses its value
// whatever its type.
const SESSION_SECRET_KEY =
  /authorization|cookie|password|secret|api.?key|access.?token|refresh.?token|^token$|^key$/i;
// Wider names for the session copy only. A config file a hunter Reads holds
// `apiToken`, `github_token`, `private_key`, `session`; OpenCode captures and
// code windows keep the narrower shared rule. `sessionId` (the CLI's own UUID
// on every line) and `author` are not credentials.
const SESSION_SECRET_WORDS = new Set([
  "auth",
  "oauth",
  "cookie",
  "cookies",
  "credential",
  "credentials",
]);
function isSessionSecretName(name: string): boolean {
  if (isSecretName(name)) return true;
  const parts = nameParts(name);
  return (
    parts.some((part) => SESSION_SECRET_WORDS.has(part)) ||
    parts.at(-1) === "session"
  );
}
const MAX_DEPTH = 12;
const MAX_NODES = 20_000;

function redactSessionLine(line: string): string {
  if (line.length === 0) return line;
  try {
    return JSON.stringify(
      redactSessionValue(JSON.parse(line), 0, { nodes: 0 }),
    );
  } catch {
    return OMITTED_LINE;
  }
}

// One JSON object per line. A line that cannot be redacted is omitted, not copied raw.
export function redactSessionJsonl(text: string): string {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  return (
    lines.map(redactSessionLine).join("\n") + (trailingNewline ? "\n" : "")
  );
}

function redactSessionValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): unknown {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw new Error("session redaction limit");
  }
  if (typeof value === "string")
    return redactSessionString(value, depth, budget);
  if (Array.isArray(value)) {
    return value.map((item) => redactSessionValue(item, depth + 1, budget));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SESSION_SECRET_KEY.test(key)) out[key] = "[REDACTED]";
      else if (isSessionSecretName(key))
        out[key] = redactStrings(item, depth + 1, budget);
      else out[key] = redactSessionValue(item, depth + 1, budget);
    }
    return out;
  }
  return redactScalar(value);
}

// Under a credential name every string goes; numbers, booleans and null stay,
// so a count is never mistaken for a secret.
function redactStrings(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): unknown {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw new Error("session redaction limit");
  }
  if (typeof value === "string") return "[REDACTED]";
  if (Array.isArray(value)) {
    return value.map((item) => redactStrings(item, depth + 1, budget));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactStrings(item, depth + 1, budget);
    }
    return out;
  }
  return redactScalar(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("non-JSON session value");
  }
  return true;
}

function redactScalar(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  throw new Error("non-JSON session value");
}

// A string that holds JSON (a config file a hunter Read) is redacted twice
// over: the quote-safe text patterns run on the raw string first, where a key
// still sits next to its value, then the parse redacts every key and string
// value. Text patterns that can eat a quote run only on strings that are not
// JSON, so the parse is never broken by a regex. If the parse fails anyway,
// the string goes through every text pattern instead.
function redactSessionString(
  value: string,
  depth: number,
  budget: { nodes: number },
): string {
  const trimmed = value.trim();
  const wrapped =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (wrapped) {
    try {
      const inner = JSON.parse(
        redactSecretShapes(trimmed, isSessionSecretName, true),
      ) as unknown;
      if (typeof inner === "object" && inner !== null) {
        return JSON.stringify(redactSessionValue(inner, depth + 1, budget));
      }
    } catch {
      // Text that only looks like JSON. The text patterns run on it below.
    }
  }
  return redactDiagnostic(
    redactEvidenceText(redactSecretShapes(value, isSessionSecretName, true)),
  );
}

// The session copy's string rules, for text that leaves the runner in a review
// trace (src/ci/trace-bundle.ts): prompts, outputs, tool arguments and results.
export function redactSessionText(value: string): string {
  return redactSessionString(value, 0, { nodes: 0 });
}

// The session copy's key rules over a whole parsed document, with no node cap:
// an OpenCode capture holds thousands of records, and redactEvidence, which
// wrote it, kept values under names such as `apiToken` (its key rule is the
// narrow shared one). Strings under a credential-like name go, numbers stay,
// and every other string takes redactSessionText. A branch deeper than the
// bound is replaced whole, never copied raw.
export function redactSessionDocument(value: unknown, depth = 0): unknown {
  if (depth > DOCUMENT_MAX_DEPTH) return "[REDACTED]";
  if (typeof value === "string") return redactSessionText(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSessionDocument(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SESSION_SECRET_KEY.test(key)) out[key] = "[REDACTED]";
      else if (isSessionSecretName(key)) out[key] = credentialValue(item);
      else out[key] = redactSessionDocument(item, depth + 1);
    }
    return out;
  }
  return typeof value === "number" || typeof value === "boolean" ? value : null;
}

const DOCUMENT_MAX_DEPTH = 64;

function credentialValue(value: unknown): unknown {
  try {
    return redactStrings(value, 0, { nodes: 0 });
  } catch {
    return "[REDACTED]";
  }
}

async function dropStaleTrace(dest: string): Promise<void> {
  await unlink(dest).catch(() => undefined);
}
