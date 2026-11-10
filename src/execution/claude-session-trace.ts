import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { redactEvidenceText } from "../security/evidence-redaction";
import { redactDiagnostic } from "../security/redact";
import type { TransportRequest } from "./contracts";

// The CLI's own session id (`--session-id` requires a UUID). Anything else is
// not a filename we will search for.
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLAUDE_TRACE_MISSES = [
  "no session id",
  "session file missing",
  "more than one session file",
  "session trace write failed",
] as const;

export type ClaudeTraceMiss = (typeof CLAUDE_TRACE_MISSES)[number];

const NO_SESSION: ClaudeTraceMiss = "no session id";

// The transport sees the CLI stdout; the harness owns the run-dir path. The
// request object is the only value both already hold, so the id crosses
// without a new field on TransportOutcome.
const retained = new WeakMap<TransportRequest, string | ClaudeTraceMiss>();

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

export function sessionIdFromCliStdout(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const sessionId = (parsed as { session_id?: unknown }).session_id;
  return typeof sessionId === "string" && SESSION_ID.test(sessionId)
    ? sessionId
    : undefined;
}

export function retainClaudeSession(
  request: TransportRequest,
  stdout: string,
): void {
  retained.set(request, sessionIdFromCliStdout(stdout) ?? NO_SESSION);
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

// Copies one attempt's session JSONL into the run dir. Undefined means the
// attempt was not a finished Claude CLI process, or the copy landed. A miss
// string is a warning: the caller must not fail the attempt.
export async function copyRetainedClaudeSession(
  request: TransportRequest,
  dest: string,
): Promise<ClaudeTraceMiss | undefined> {
  const noted = retained.get(request);
  if (noted === undefined) {
    await dropStaleTrace(dest);
    return undefined;
  }
  if (noted === NO_SESSION) {
    await dropStaleTrace(dest);
    return NO_SESSION;
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
    const redacted = redactSessionJsonl(await Bun.file(source).text());
    await mkdir(path.dirname(dest), { recursive: true });
    await Bun.write(dest, redacted);
    return undefined;
  } catch {
    await dropStaleTrace(dest);
    return "session trace write failed";
  }
}

// Same key rule as redactEvidence. Embedded JSON is parsed before any text
// pattern runs, so a regex cannot eat the quotes that the next parse needs.
const SESSION_SECRET_KEY =
  /authorization|cookie|password|secret|api.?key|access.?token|refresh.?token|^token$|^key$/i;
const MAX_DEPTH = 12;
const MAX_NODES = 20_000;

// One JSON object per line. A line that cannot be redacted is omitted, not copied raw.
export function redactSessionJsonl(text: string): string {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  const redacted = lines.map((line) => {
    if (line.length === 0) return line;
    try {
      return JSON.stringify(
        redactSessionValue(JSON.parse(line), 0, { nodes: 0 }),
      );
    } catch {
      return JSON.stringify({ crysk: "session line omitted" });
    }
  });
  return redacted.join("\n") + (trailingNewline ? "\n" : "");
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
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("non-JSON session value");
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SESSION_SECRET_KEY.test(key)
        ? "[REDACTED]"
        : redactSessionValue(item, depth + 1, budget);
    }
    return out;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  throw new Error("non-JSON session value");
}

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
      const inner = JSON.parse(trimmed) as unknown;
      if (typeof inner === "object" && inner !== null) {
        return JSON.stringify(redactSessionValue(inner, depth + 1, budget));
      }
    } catch {
      // Text that only looks like JSON. The text patterns run on it below.
    }
  }
  return redactDiagnostic(redactEvidenceText(value));
}

async function dropStaleTrace(dest: string): Promise<void> {
  await unlink(dest).catch(() => undefined);
}
