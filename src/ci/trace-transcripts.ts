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
  const conversation: Conversation = { input: [], output: [], tools: [] };
  const byId = new Map<string, ToolCall>();
  let current: { id: string | undefined; message: ChatMessage } | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || !isRecord(entry.message)) continue;
    const at = timeOf(entry.timestamp);
    const message = entry.message;
    if (entry.type === "assistant") {
      widen(conversation, at);
      const id = nonEmpty(message.id);
      if (current === undefined || id === undefined || current.id !== id) {
        current = { id, message: { role: "assistant", parts: [] } };
        conversation.output.push(current.message);
      }
      const model = nonEmpty(message.model);
      if (model !== undefined) conversation.responseModel = model;
      const stop = nonEmpty(message.stop_reason);
      if (stop !== undefined) {
        current.message.finish_reason = stop;
        conversation.finishReason = stop;
      }
      for (const block of Array.isArray(message.content)
        ? message.content.filter(isRecord)
        : []) {
        const part = claudePart(block);
        if (part === undefined) continue;
        current.message.parts.push(part);
        if (part.type === "tool_call") {
          const call: ToolCall = {
            ...(part.id === undefined ? {} : { id: part.id }),
            name: part.name,
            ...(part.arguments === undefined
              ? {}
              : { arguments: part.arguments }),
            ...(at === undefined ? {} : { startMs: at }),
          };
          conversation.tools.push(call);
          if (part.id !== undefined) byId.set(part.id, call);
        }
      }
    } else if (entry.type === "user") {
      widen(conversation, at);
      current = undefined;
      const content = message.content;
      if (typeof content === "string") {
        if (conversation.output.length === 0) {
          conversation.input.push(userText(content));
        }
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content.filter(isRecord)) {
        if (block.type === "tool_result") {
          const call = byId.get(String(block.tool_use_id));
          if (call === undefined) continue;
          const result = resultText(block.content);
          if (result !== undefined) call.result = result;
          if (block.is_error === true) call.isError = true;
          if (at !== undefined) call.endMs = at;
        } else if (
          block.type === "text" &&
          typeof block.text === "string" &&
          conversation.output.length === 0
        ) {
          conversation.input.push(userText(block.text));
        }
      }
    }
  }
  return conversation;
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
