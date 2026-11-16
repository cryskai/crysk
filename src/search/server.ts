// odd/tasks/antigravity-oauth.md T4b (S5, L15): the JSON-RPC half of Crysk's
// read-only search MCP, newline-delimited over stdio, as agy 1.5.7 drives it:
// `server/discover` (id 1) before `initialize` (protocol 2025-11-25),
// `notifications/initialized`, `notifications/roots/list_changed`,
// `tools/list`, then `tools/call` with `_meta`. Any other request gets a
// JSON-RPC error and the server keeps serving; nothing here throws out.
import { callSearchTool, SEARCH_TOOLS } from "./tools";

export const SEARCH_SERVER_NAME = "crysk-search";
const SEARCH_SERVER_VERSION = "1.0.0";
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";
// One JSON-RPC line; a tools/call is a few hundred bytes.
const MAX_INPUT_LINE_BYTES = 1024 * 1024;

type Id = string | number;

interface RpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: Id | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function errorResponse(
  id: Id | null,
  code: number,
  message: string,
): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isId(value: unknown): value is Id {
  return typeof value === "string" || typeof value === "number";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// One parsed message in, at most one response out (undefined: no reply).
export async function handleSearchMessage(
  root: string,
  message: unknown,
): Promise<RpcResponse | undefined> {
  if (Array.isArray(message)) {
    return errorResponse(null, -32600, "batches are not supported");
  }
  const record = asRecord(message);
  if (record === undefined) {
    return errorResponse(null, -32600, "invalid request");
  }
  const { method } = record;
  const hasId = isId(record.id);
  if (typeof method !== "string") {
    // A client's response to us (we send no requests) or junk with no id.
    return hasId || record.id === null
      ? undefined
      : errorResponse(null, -32600, "invalid request");
  }
  // A notification: never answered.
  if (!("id" in record)) return undefined;
  if (!hasId) return errorResponse(null, -32600, "invalid request id");
  const id = record.id as Id;
  const params = asRecord(record.params) ?? {};
  switch (method) {
    // agy sends this first (L15); the spike's empty result let it proceed.
    case "server/discover":
      return { jsonrpc: "2.0", id, result: {} };
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: SEARCH_SERVER_NAME,
            version: SEARCH_SERVER_VERSION,
          },
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: SEARCH_TOOLS } };
    case "tools/call": {
      const result = await callSearchTool(root, params.name, params.arguments);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        },
      };
    }
    default:
      return errorResponse(id, -32601, "method not found");
  }
}

async function handleLine(
  root: string,
  line: string,
): Promise<RpcResponse | undefined> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return errorResponse(null, -32700, "parse error");
  }
  try {
    return await handleSearchMessage(root, message);
  } catch {
    const id = isId(asRecord(message)?.id)
      ? (asRecord(message)?.id as Id)
      : null;
    return errorResponse(id, -32603, "internal error");
  }
}

export interface SearchServerIo {
  readonly input: AsyncIterable<Uint8Array>;
  readonly write: (text: string) => void;
}

// Serves until stdin closes, one request at a time and in order: a tools/call
// is awaited (grep's regex runs in a worker) before the next line is read.
export async function runSearchServer(
  root: string,
  io: SearchServerIo,
): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  let discarding = false;
  const respond = (response: RpcResponse | undefined) => {
    if (response !== undefined) io.write(`${JSON.stringify(response)}\n`);
  };
  const lineOf = async (bytes: Buffer) => {
    const line = bytes.toString("utf8").trim();
    if (line !== "") respond(await handleLine(root, line));
  };
  for await (const chunk of io.input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (discarding) {
        discarding = false;
      } else {
        await lineOf(line);
      }
      newline = pending.indexOf(0x0a);
    }
    if (pending.length > MAX_INPUT_LINE_BYTES) {
      // Too long to be a request: drop it up to its newline, say so once.
      if (!discarding) {
        respond(errorResponse(null, -32600, "request too large"));
      }
      discarding = true;
      pending = Buffer.alloc(0);
    }
  }
  if (!discarding && pending.length > 0) await lineOf(pending);
}
