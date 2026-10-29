// Read-only MCP server (Fundamentals #6 / observability-canonical-store.md),
// pure half: tool definitions, request schemas, dispatch routing, and JSON-RPC
// serialization contracts.
//
// 100% pure and offline-testable: no network, no stdio handles, no filesystem.

import type { Tier } from "#review/findings";
import type { ProductStoreClient } from "#server/client";
import { currentMcpToolName } from "../brand";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_SERVER_NAME = "crysk-store";
export const MCP_SERVER_VERSION = "1.0.0";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "crysk_health",
    description:
      "Check the health, schema version, and run count of the Crysk canonical product store.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "crysk_list_runs",
    description:
      "List review runs from the canonical store, optionally filtered by repository ID, PR number, and limit.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Repository identifier (e.g. github.com/owner/repo)",
        },
        pr: {
          type: "number",
          description: "Pull request number",
        },
        limit: {
          type: "number",
          description: "Maximum number of runs to return (default: 50)",
        },
      },
    },
  },
  {
    name: "crysk_get_run",
    description:
      "Retrieve full telemetry, timing, summary score, and cost breakdown of a single review run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "number",
          description: "Canonical run ID",
        },
      },
      required: ["run_id"],
    },
  },
  {
    name: "crysk_get_findings",
    description:
      "Retrieve the complete FindingsDocument of a run, including all findings, hop trails, and proof refs.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "number",
          description: "Canonical run ID",
        },
      },
      required: ["run_id"],
    },
  },
  {
    name: "crysk_search_findings",
    description:
      "Search findings across historical runs by file path, tier (blocking/advisory), repository, or specific run ID.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Repository identifier",
        },
        run_id: {
          type: "number",
          description: "Canonical run ID to filter findings within",
        },
        path: {
          type: "string",
          description: "Relative file path",
        },
        tier: {
          type: "string",
          enum: ["blocking", "advisory"],
          description: "Tier filter",
        },
        limit: {
          type: "number",
          description: "Maximum number of findings to return",
        },
      },
    },
  },
  {
    name: "crysk_get_usage",
    description:
      "Retrieve aggregated token usage, cost breakdown, and run counts (global or scoped to a repository).",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description:
            "Repository identifier (optional; omit for global usage)",
        },
        all: {
          type: "boolean",
          description: "Include all repos (default: true if repo_id omitted)",
        },
      },
    },
  },
  {
    name: "crysk_get_triage",
    description:
      "Retrieve recorded triage decisions (applied, dismissed, deferred, misclassified) for a review run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "number",
          description: "Canonical run ID",
        },
      },
      required: ["run_id"],
    },
  },
];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function formatToolSuccess(data: unknown): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function formatToolError(message: string): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

export function parseOptionalInteger(
  val: unknown,
  paramName?: string,
  min = 0,
): number | undefined {
  if (val === undefined || val === null || val === "") return undefined;
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isInteger(n) || Number.isNaN(n) || n < min) {
    throw new Error(
      `Invalid ${paramName ?? "parameter"}: must be ${min === 1 ? "a positive integer" : `an integer >= ${min}`}`,
    );
  }
  return n;
}

export function parseRequiredInteger(val: unknown, paramName: string): number {
  if (val === undefined || val === null || val === "") {
    throw new Error(`Missing required parameter: ${paramName}`);
  }
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isInteger(n) || Number.isNaN(n) || n < 1) {
    throw new Error(`Invalid ${paramName}: must be a positive integer`);
  }
  return n;
}

export async function handleMcpToolCall(
  client: ProductStoreClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  try {
    // A pre-rename name reaches the same handler; the default branch still
    // reports the name the caller sent.
    switch (currentMcpToolName(name)) {
      case "crysk_health": {
        const health = await client.health();
        return formatToolSuccess(health);
      }

      case "crysk_list_runs": {
        const repo_id =
          typeof args.repo_id === "string" && args.repo_id.trim() !== ""
            ? args.repo_id.trim()
            : undefined;
        const pr = parseOptionalInteger(args.pr, "pr", 0);
        const limit = parseOptionalInteger(args.limit, "limit", 1);
        const runs = await client.listRuns({ repo_id, pr, limit });
        return formatToolSuccess(runs);
      }

      case "crysk_get_run": {
        const run_id = parseRequiredInteger(args.run_id, "run_id");
        const run = await client.getRun(run_id);
        if (!run) {
          return formatToolError(`Run #${run_id} not found`);
        }
        return formatToolSuccess(run);
      }

      case "crysk_get_findings": {
        const run_id = parseRequiredInteger(args.run_id, "run_id");
        const doc = await client.getFindingsDocument(run_id);
        if (!doc) {
          return formatToolError(
            `Findings document for run #${run_id} not found`,
          );
        }
        return formatToolSuccess(doc);
      }

      case "crysk_search_findings": {
        const repo_id =
          typeof args.repo_id === "string" && args.repo_id.trim() !== ""
            ? args.repo_id.trim()
            : undefined;
        const run_id = parseOptionalInteger(args.run_id, "run_id", 1);
        const path =
          typeof args.path === "string" && args.path.trim() !== ""
            ? args.path.trim()
            : undefined;
        const tier =
          typeof args.tier === "string" &&
          (args.tier === "blocking" || args.tier === "advisory")
            ? (args.tier as Tier)
            : undefined;
        const limit = parseOptionalInteger(args.limit, "limit", 1);
        const findings = await client.searchFindings({
          repo_id,
          run_id,
          path,
          tier,
          limit,
        });
        return formatToolSuccess(findings);
      }

      case "crysk_get_usage": {
        const repo_id =
          typeof args.repo_id === "string" && args.repo_id.trim() !== ""
            ? args.repo_id.trim()
            : undefined;
        const all =
          typeof args.all === "boolean" ? args.all : repo_id === undefined;
        const usage = await client.getUsage({ repo_id, all });
        return formatToolSuccess(usage);
      }

      case "crysk_get_triage": {
        const run_id = parseRequiredInteger(args.run_id, "run_id");
        const triage = await client.getTriage(run_id);
        return formatToolSuccess(triage);
      }

      default:
        return formatToolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return formatToolError(`Tool execution failed: ${(err as Error).message}`);
  }
}

export async function processMcpMessage(
  client: ProductStoreClient,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  // JSON-RPC 2.0 §4.1: If the request is a notification, the server MUST NOT reply
  if (request.id === undefined || request.id === null) {
    return null;
  }

  const id = request.id;
  const { method, params } = request;

  switch (method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
          },
        },
      };
    }

    case "notifications/initialized": {
      return null;
    }

    case "ping": {
      return {
        jsonrpc: "2.0",
        id,
        result: {},
      };
    }

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS,
        },
      };
    }

    case "tools/call": {
      const toolName = typeof params?.name === "string" ? params.name : "";
      const toolArgs =
        typeof params?.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};

      const toolResult = await handleMcpToolCall(client, toolName, toolArgs);
      return {
        jsonrpc: "2.0",
        id,
        result: toolResult,
      };
    }

    default: {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
    }
  }
}
