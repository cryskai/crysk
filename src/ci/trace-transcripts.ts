// Reads one attempt's raw transcript into the conversation a review trace
// shows (src/ci/trace-bundle.ts): the prompt the model got, what it answered,
// and each tool call with its arguments, result and timing.
//
// Two transcripts exist. A Claude CLI attempt leaves its session JSONL
// (steps/trace.<step>.attempt<n>.jsonl, copied and redacted by
// src/execution/claude-session-trace.ts). An OpenCode attempt leaves its
// HTTP/SSE capture (steps/evidence.<step>.attempt<n>.capture.json, written by
// src/execution/attempt-evidence.ts), whose last `readback` record holds the
// session's messages.
//
// WHY every read is best effort: these files come from CLIs this engine does
// not own, and a format change must cost the conversation, never the trace. A
// line or record that does not have the expected shape is skipped.
//
// The message parts follow the OpenTelemetry GenAI message schema (TextPart,
// ReasoningPart, ToolCallRequestPart; see GENAI_SEMCONV_VERSION in
// trace-bundle.ts).
//
// BUILTINS ONLY: the trace step runs under always(), so it can run before
// `bun install` (test/ci/platform-trace.test.ts walks the import closure).

import { closeSync, openSync, readSync } from "node:fs";

export type MessagePart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id?: string; name: string; arguments?: unknown };

export interface ChatMessage {
  role: "user" | "assistant";
  parts: MessagePart[];
  finish_reason?: string;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
  result?: string;
  isError?: boolean;
  startMs?: number;
  endMs?: number;
}

export interface Conversation {
  input: ChatMessage[];
  output: ChatMessage[];
  tools: ToolCall[];
  // The model the provider says answered, when the transcript names one.
  responseModel?: string;
  // The last answer's finish reason, as the provider spelled it.
  finishReason?: string;
  startMs?: number;
  endMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// A tool result's content: a string, or the text blocks of a block list.
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter(isRecord)
    .map((block) => (typeof block.text === "string" ? block.text : undefined))
    .filter((text): text is string => text !== undefined);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function widen(conversation: Conversation, ms: number | undefined): void {
  if (ms === undefined) return;
  if (conversation.startMs === undefined || ms < conversation.startMs) {
    conversation.startMs = ms;
  }
  if (conversation.endMs === undefined || ms > conversation.endMs) {
    conversation.endMs = ms;
  }
}

// The Claude CLI writes one line per content block, so the blocks of one
// answer share its message id and are joined back into one message here.
export function parseClaudeSession(text: string): Conversation {
  const reader = new ClaudeSessionReader(true);
  for (const line of text.split("\n")) reader.line(line);
  return reader.conversation;
}

// What a metadata trace keeps of a conversation: the tool calls' names, ids,
// times and status, the finish reason, the response model and the times. No
// message, no tool argument and no tool result.
export function withoutContent(conversation: Conversation): Conversation {
  return {
    ...conversation,
    input: [],
    output: [],
    tools: conversation.tools.map(
      ({ arguments: _a, result: _r, ...call }) => call,
    ),
  };
}

export interface ScanLimits {
  // Bytes read from the file at a time.
  chunkBytes: number;
  // A longer line is skipped without being held whole.
  lineBytes: number;
}

// The session copy's own line cap (MAX_LINE_BYTES in
// src/execution/claude-session-trace.ts): the copy omits a longer line, so a
// line past it is no line the copy wrote.
const SCAN_LIMITS: ScanLimits = {
  chunkBytes: 1024 * 1024,
  lineBytes: 4 * 1024 * 1024,
};
const NEWLINE = 0x0a;

// A metadata trace's read of a Claude session file: the same reducer as
// parseClaudeSession, fed one line at a time and keeping no content.
//
// WHY it streams: a session can reach 64 MiB and a run holds one per attempt;
// reading each whole only to drop its text cost a metadata trace memory it
// never sends (eight 30 MB sessions held several hundred MB). Here the file is
// read in chunks, only the current line is held (at most lineBytes), and each
// line is parsed and dropped before the next. undefined when the file cannot
// be opened; a read error keeps what was read before it.
export function scanClaudeSessionFile(
  file: string,
  limits: ScanLimits = SCAN_LIMITS,
): Conversation | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return undefined;
  }
  const reader = new ClaudeSessionReader(false);
  const buffer = Buffer.allocUnsafe(limits.chunkBytes);
  // The current line's bytes from earlier chunks, copied out of the buffer the
  // next read overwrites.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let overLimit = false;
  const hold = (bytes: Buffer): void => {
    if (overLimit || bytes.length === 0) return;
    if (pendingBytes + bytes.length > limits.lineBytes) {
      overLimit = true;
      pending = [];
      pendingBytes = 0;
      return;
    }
    pending.push(Buffer.from(bytes));
    pendingBytes += bytes.length;
  };
  // Decoded only once whole, so a character split across chunks stays whole.
  const finishLine = (tail: Buffer): void => {
    if (!overLimit) {
      if (pendingBytes === 0) {
        if (tail.length <= limits.lineBytes) reader.line(tail.toString("utf8"));
      } else if (pendingBytes + tail.length <= limits.lineBytes) {
        reader.line(
          Buffer.concat(
            [...pending, tail],
            pendingBytes + tail.length,
          ).toString("utf8"),
        );
      }
    }
    pending = [];
    pendingBytes = 0;
    overLimit = false;
  };
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, limits.chunkBytes, null);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      let start = 0;
      for (
        let at = chunk.indexOf(NEWLINE);
        at !== -1;
        at = chunk.indexOf(NEWLINE, start)
      ) {
        finishLine(chunk.subarray(start, at));
        start = at + 1;
      }
      hold(chunk.subarray(start));
    }
  } catch {
    // Best effort: what was read stands.
  } finally {
    closeSync(fd);
  }
  finishLine(Buffer.alloc(0));
  return reader.conversation;
}

// One session line at a time. Without content it keeps only what
// withoutContent would leave: no message, thinking, tool argument or result.
class ClaudeSessionReader {
  readonly conversation: Conversation = { input: [], output: [], tools: [] };
  private readonly byId = new Map<string, ToolCall>();
  private current: { id: string | undefined; message: ChatMessage } | undefined;

  constructor(private readonly content: boolean) {}

  line(line: string): void {
    if (line.trim() === "") return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(entry) || !isRecord(entry.message)) return;
    const at = timeOf(entry.timestamp);
    if (entry.type === "assistant") this.assistant(entry.message, at);
    else if (entry.type === "user") this.user(entry.message, at);
  }

  private assistant(message: Record<string, unknown>, at?: number): void {
    const conversation = this.conversation;
    widen(conversation, at);
    const id = nonEmpty(message.id);
    if (
      this.current === undefined ||
      id === undefined ||
      this.current.id !== id
    ) {
      this.current = { id, message: { role: "assistant", parts: [] } };
      if (this.content) conversation.output.push(this.current.message);
    }
    const current = this.current.message;
    const model = nonEmpty(message.model);
    if (model !== undefined) conversation.responseModel = model;
    const stop = nonEmpty(message.stop_reason);
    if (stop !== undefined) {
      current.finish_reason = stop;
      conversation.finishReason = stop;
    }
    for (const block of Array.isArray(message.content)
      ? message.content.filter(isRecord)
      : []) {
      const part = claudePart(block);
      if (part === undefined) continue;
      if (this.content) current.parts.push(part);
      if (part.type === "tool_call") {
        const call: ToolCall = {
          ...(part.id === undefined ? {} : { id: part.id }),
          name: part.name,
          ...(part.arguments === undefined || !this.content
            ? {}
            : { arguments: part.arguments }),
          ...(at === undefined ? {} : { startMs: at }),
        };
        conversation.tools.push(call);
        if (part.id !== undefined) this.byId.set(part.id, call);
      }
    }
  }

  private user(message: Record<string, unknown>, at?: number): void {
    const conversation = this.conversation;
    widen(conversation, at);
    this.current = undefined;
    const content = message.content;
    if (typeof content === "string") {
      if (this.content && conversation.output.length === 0) {
        conversation.input.push(userText(content));
      }
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content.filter(isRecord)) {
      if (block.type === "tool_result") {
        const call = this.byId.get(String(block.tool_use_id));
        if (call === undefined) continue;
        if (this.content) {
          const result = resultText(block.content);
          if (result !== undefined) call.result = result;
        }
        if (block.is_error === true) call.isError = true;
        if (at !== undefined) call.endMs = at;
      } else if (
        this.content &&
        block.type === "text" &&
        typeof block.text === "string" &&
        conversation.output.length === 0
      ) {
        conversation.input.push(userText(block.text));
      }
    }
  }
}

function userText(content: string): ChatMessage {
  return { role: "user", parts: [{ type: "text", content }] };
}

function claudePart(block: Record<string, unknown>): MessagePart | undefined {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", content: block.text };
  }
  // The CLI can record a thinking block with its text withheld; an empty one
  // says nothing and is left out.
  if (block.type === "thinking" && nonEmpty(block.thinking) !== undefined) {
    return { type: "reasoning", content: block.thinking as string };
  }
  if (block.type === "tool_use" && typeof block.name === "string") {
    return {
      type: "tool_call",
      ...(nonEmpty(block.id) === undefined ? {} : { id: block.id as string }),
      name: block.name,
      ...(block.input === undefined ? {} : { arguments: block.input }),
    };
  }
  return undefined;
}

// The capture's newest readback: the session's messages as OpenCode returned
// them, `{ info: { role, modelID, finish, time }, parts: [...] }` each. An
// absent or elided readback leaves the conversation empty. The capture comes
// parsed: the trace builder parses each one once, for its conversation and its
// redacted transcript.
export function openCodeConversation(capture: unknown): Conversation {
  const conversation: Conversation = { input: [], output: [], tools: [] };
  const records =
    isRecord(capture) && Array.isArray(capture.records)
      ? capture.records.filter(isRecord)
      : [];
  for (const record of records) widen(conversation, timeOf(record.observedMs));
  const readback = records
    .filter(
      (record) =>
        record.kind === "readback" &&
        isRecord(record.data) &&
        Array.isArray(record.data.messages),
    )
    .at(-1);
  const messages =
    readback !== undefined && isRecord(readback.data)
      ? (readback.data.messages as unknown[]).filter(isRecord)
      : [];
  for (const item of messages) {
    const info = isRecord(item.info) ? item.info : item;
    const parts = Array.isArray(item.parts) ? item.parts.filter(isRecord) : [];
    if (info.role === "user") {
      const texts = parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => ({ type: "text" as const, content: String(part.text) }));
      if (texts.length > 0)
        conversation.input.push({ role: "user", parts: texts });
      continue;
    }
    if (info.role !== "assistant") continue;
    const message: ChatMessage = { role: "assistant", parts: [] };
    const model = nonEmpty(info.modelID);
    if (model !== undefined) conversation.responseModel = model;
    const finish = nonEmpty(info.finish);
    if (finish !== undefined) {
      message.finish_reason = finish;
      conversation.finishReason = finish;
    }
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string") {
        message.parts.push({ type: "text", content: part.text });
      } else if (part.type === "reasoning" && nonEmpty(part.text)) {
        message.parts.push({ type: "reasoning", content: String(part.text) });
      } else if (part.type === "tool" && typeof part.tool === "string") {
        const state = isRecord(part.state) ? part.state : {};
        const time = isRecord(state.time) ? state.time : {};
        const id = nonEmpty(part.callID);
        const call: ToolCall = {
          ...(id === undefined ? {} : { id }),
          name: part.tool,
          ...(state.input === undefined ? {} : { arguments: state.input }),
        };
        const result = nonEmpty(state.output) ?? nonEmpty(state.error);
        if (result !== undefined) call.result = result;
        if (state.status === "error") call.isError = true;
        const start = timeOf(time.start);
        const end = timeOf(time.end);
        if (start !== undefined) call.startMs = start;
        if (end !== undefined) call.endMs = end;
        conversation.tools.push(call);
        message.parts.push({
          type: "tool_call",
          ...(id === undefined ? {} : { id }),
          name: part.tool,
          ...(call.arguments === undefined
            ? {}
            : { arguments: call.arguments }),
        });
      }
    }
    conversation.output.push(message);
  }
  return conversation;
}
