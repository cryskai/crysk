import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
  if (noted === undefined) return undefined;
  if (noted === NO_SESSION) return NO_SESSION;
  try {
    const source = await findSessionFile(
      request.isolation.syntheticConfigHome,
      noted,
    );
    if (
      source === "session file missing" ||
      source === "more than one session file"
    ) {
      return source;
    }
    const redacted = redactEvidenceText(
      redactDiagnostic(await Bun.file(source).text()),
    );
    await mkdir(path.dirname(dest), { recursive: true });
    await Bun.write(dest, redacted);
    return undefined;
  } catch {
    return "session trace write failed";
  }
}
