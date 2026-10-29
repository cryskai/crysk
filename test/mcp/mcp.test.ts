// Unit and protocol tests for pr-hero MCP server (Fundamentals #6 / observability-canonical-store.md).
// 100% offline, tests tool dispatch and JSON-RPC protocol against mock & live client.

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_VERSION,
  processMcpMessage,
  type ToolCallResult,
} from "#mcp/preflight";
import type { FindingsDocument } from "#review/findings";
import { ProductStoreClient } from "#server/client";
import { startProductStoreServer } from "#server/server";
import { projectCompleteRun } from "#store/preflight";

function getToolResult(response: unknown): ToolCallResult {
  return (response as { result: ToolCallResult }).result;
}

function sampleDoc(
  overrides: Partial<FindingsDocument> = {},
): FindingsDocument {
  return {
    schema_version: "1.0.0",
    pr: 10,
    base_sha: "basesha1234567890",
    head_sha: "headsha1234567890",
    model: "sonnet",
    iteration: 1,
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: {
      index_ms: 100,
      index_mode: "sync",
      sync_ms: 50,
      index_disk_mb: 10,
      wall_ms: 3000,
      tokens_in: 5000,
      tokens_out: 500,
      tokens_total: 5500,
      cost_usd_est: 0.15,
      per_agent: {
        reliability: { tokens_total: 5500, duration_ms: 2500 },
      },
    },
    findings: [
      {
        id: "F001",
        category: 1,
        path: "src/engine.ts",
        line: 42,
        severity: "BLOCKER",
        evidence_class: "deterministic",
        refuter_verdict: "corroborated",
        causal_disposition: "introduced",
        claim: "Unchecked null dereference",
        proof_refs: ["src/engine.ts:42-45"],
        hunter: "reliability",
        hops_used: 2,
        hop_trail: ["read engine.ts", "verify null check"],
        dedupe_key: "src/engine.ts:42:1",
        tier: "blocking",
      },
    ],
    debug: {
      refuted: [],
    },
    ...overrides,
  };
}

describe("Read-Only MCP Server Protocol & Tools", () => {
  test("handles initialize request with capabilities and server info", async () => {
    const mockClient = {} as ProductStoreClient;
    const response = await processMcpMessage(mockClient, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "crysk-store",
          version: MCP_SERVER_VERSION,
        },
      },
    });
  });

  test("handles ping and notifications/initialized", async () => {
    const mockClient = {} as ProductStoreClient;
    const pingRes = await processMcpMessage(mockClient, {
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
    });
    expect(pingRes).toEqual({ jsonrpc: "2.0", id: 2, result: {} });

    const notifRes = await processMcpMessage(mockClient, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notifRes).toBeNull();
  });

  test("tools/list returns all 7 read-only tool definitions", async () => {
    const mockClient = {} as ProductStoreClient;
    const response = await processMcpMessage(mockClient, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });

    expect(response?.id).toBe(3);
    const result = (response as { result: { tools: unknown[] } })?.result;
    expect(result.tools.length).toBe(7);
    // The wire answer, not the constant: this is what an agent sees.
    expect((result.tools as { name: string }[]).map((t) => t.name)).toEqual([
      "crysk_health",
      "crysk_list_runs",
      "crysk_get_run",
      "crysk_get_findings",
      "crysk_search_findings",
      "crysk_get_usage",
      "crysk_get_triage",
    ]);
  });

  test("tools/call still answers the pre-rename prhero_* names with the same result", async () => {
    // One canned answer per client method, so a crysk_* name and its prhero_*
    // alias can be compared on the real dispatch, args included.
    const client = {
      health: async () => ({ ok: true }),
      listRuns: async (a: unknown) => ({ listRuns: a }),
      getRun: async (id: number) => ({ id }),
      getFindingsDocument: async (id: number) => ({ doc: id }),
      searchFindings: async (a: unknown) => ({ searchFindings: a }),
      getUsage: async (a: unknown) => ({ getUsage: a }),
      getTriage: async (id: number) => ({ triage: id }),
    } as unknown as ProductStoreClient;
    const args: Record<string, Record<string, unknown>> = {
      health: {},
      list_runs: { repo_id: "r", pr: 3, limit: 2 },
      get_run: { run_id: 4 },
      get_findings: { run_id: 4 },
      search_findings: { repo_id: "r", tier: "blocking" },
      get_usage: { repo_id: "r" },
      get_triage: { run_id: 4 },
    };
    for (const [suffix, arguments_] of Object.entries(args)) {
      const call = (name: string) =>
        processMcpMessage(client, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: arguments_ },
        });
      const current = await call(`crysk_${suffix}`);
      expect(getToolResult(current).isError).toBeUndefined();
      expect(await call(`prhero_${suffix}`)).toEqual(current);
    }
  });

  test("tools/list advertises only the crysk_* names, never the aliases", async () => {
    const response = await processMcpMessage({} as ProductStoreClient, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/list",
    });
    const names = (
      response as { result: { tools: { name: string }[] } }
    ).result.tools.map((t) => t.name);
    expect(names.every((n) => n.startsWith("crysk_"))).toBe(true);
  });

  test("an unknown prhero_* name is still an unknown tool", async () => {
    const response = await processMcpMessage({} as ProductStoreClient, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "prhero_nope" },
    });
    expect(getToolResult(response).isError).toBe(true);
    expect(JSON.stringify(response)).toContain("Unknown tool: prhero_nope");
  });

  test("executes tool calls against a live ProductStoreClient", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcp-test-"));
    const dbPath = path.join(dir, "mcp.db");
    const socketPath = path.join(dir, "mcp.sock");

    const serverHandle = startProductStoreServer({
      dbPath,
      socketPath,
    });
    const client = new ProductStoreClient({ socketPath });

    try {
      // 1. Health tool
      const healthRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "crysk_health",
        },
      });
      const healthData = JSON.parse(
        getToolResult(healthRes).content[0]?.text ?? "{}",
      );
      expect(healthData.status).toBe("ok");
      expect(healthData.runs_count).toBe(0);

      // Save a sample run
      const saveRes = await client.saveRun(
        projectCompleteRun({
          doc: sampleDoc(),
          repoId: "github.com/juanmaagd/pr-hero",
          runDir: "run-mcp-1",
          checkoutPath: null,
        }),
      );
      const runId = saveRes.run_id;

      // Record a triage event
      await client.recordTriage(runId, {
        finding_id: "F001",
        comment_id: 112233,
        tag: "applied",
        actor: "agent",
        reasoning: "Fixed in commit test",
      });

      // 2. List runs tool
      const listRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "crysk_list_runs",
          arguments: { repo_id: "github.com/juanmaagd/pr-hero" },
        },
      });
      const listData = JSON.parse(
        getToolResult(listRes).content[0]?.text ?? "[]",
      );
      expect(listData.length).toBe(1);
      expect(listData[0].run_dir).toBe("run-mcp-1");

      // 3. Get run tool
      const getRunRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "crysk_get_run",
          arguments: { run_id: runId },
        },
      });
      const getRunData = JSON.parse(
        getToolResult(getRunRes).content[0]?.text ?? "{}",
      );
      expect(getRunData.id).toBe(runId);

      // 4. Get findings tool
      const getFindingsRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "crysk_get_findings",
          arguments: { run_id: runId },
        },
      });
      const findingsData = JSON.parse(
        getToolResult(getFindingsRes).content[0]?.text ?? "{}",
      );
      expect(findingsData.findings.length).toBe(1);
      expect(findingsData.findings[0].id).toBe("F001");

      // 5. Search findings tool
      const searchRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: {
          name: "crysk_search_findings",
          arguments: { tier: "blocking" },
        },
      });
      const searchData = JSON.parse(
        getToolResult(searchRes).content[0]?.text ?? "[]",
      );
      expect(searchData.length).toBe(1);
      expect(searchData[0].finding_id).toBe("F001");

      // 6. Get usage tool
      const usageRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: {
          name: "crysk_get_usage",
          arguments: { all: true },
        },
      });
      const usageData = JSON.parse(
        getToolResult(usageRes).content[0]?.text ?? "{}",
      );
      expect(usageData.rows.length).toBe(1);

      // 7. Get triage tool
      const triageRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 16,
        method: "tools/call",
        params: {
          name: "crysk_get_triage",
          arguments: { run_id: runId },
        },
      });
      const triageData = JSON.parse(
        getToolResult(triageRes).content[0]?.text ?? "[]",
      );
      expect(triageData.length).toBe(1);
      expect(triageData[0].tag).toBe("applied");

      // 8. Unknown tool returns error
      const unknownRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: {
          name: "crysk_unknown_tool",
        },
      });
      expect(getToolResult(unknownRes).isError).toBe(true);
    } finally {
      serverHandle.stop();
    }
  });

  test("returns -32601 on unknown JSON-RPC method with id, but returns null for notifications", async () => {
    const mockClient = {} as ProductStoreClient;
    const responseWithId = await processMcpMessage(mockClient, {
      jsonrpc: "2.0",
      id: 99,
      method: "unknown/method",
    });

    expect(responseWithId).toEqual({
      jsonrpc: "2.0",
      id: 99,
      error: {
        code: -32601,
        message: "Method not found: unknown/method",
      },
    });

    // Notifications (no id) must return null
    const notifResponse = await processMcpMessage(mockClient, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 123 },
    });
    expect(notifResponse).toBeNull();

    const customNotif = await processMcpMessage(mockClient, {
      jsonrpc: "2.0",
      method: "$/customNotification",
    });
    expect(customNotif).toBeNull();
  });

  test("validates and coerces parameters across tool calls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcp-params-test-"));
    const dbPath = path.join(dir, "mcp.db");
    const socketPath = path.join(dir, "mcp.sock");

    const serverHandle = startProductStoreServer({
      dbPath,
      socketPath,
    });
    const client = new ProductStoreClient({ socketPath });

    try {
      const saveRes = await client.saveRun(
        projectCompleteRun({
          doc: sampleDoc(),
          repoId: "github.com/juanmaagd/pr-hero",
          runDir: "run-mcp-params",
          checkoutPath: null,
        }),
      );
      const runId = saveRes.run_id;

      // 1. search_findings with run_id
      const searchRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "crysk_search_findings",
          arguments: { run_id: runId, tier: "blocking" },
        },
      });
      const searchData = JSON.parse(
        getToolResult(searchRes).content[0]?.text ?? "[]",
      );
      expect(searchData.length).toBe(1);
      expect(searchData[0].finding_id).toBe("F001");

      // 2. Numeric coercion with string numbers
      const getRunRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "crysk_get_run",
          arguments: { run_id: String(runId) },
        },
      });
      const getRunData = JSON.parse(
        getToolResult(getRunRes).content[0]?.text ?? "{}",
      );
      expect(getRunData.id).toBe(runId);

      // 3. Validation error on missing required run_id
      const missingRunRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "crysk_get_run",
          arguments: {},
        },
      });
      expect(getToolResult(missingRunRes).isError).toBe(true);
      expect(getToolResult(missingRunRes).content[0]?.text).toContain(
        "Missing required parameter: run_id",
      );

      // 4. Validation error on malformed optional integer in search_findings
      const malformedSearchRes = await processMcpMessage(client, {
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: {
          name: "crysk_search_findings",
          arguments: { run_id: "not-a-number" },
        },
      });
      expect(getToolResult(malformedSearchRes).isError).toBe(true);
      expect(getToolResult(malformedSearchRes).content[0]?.text).toContain(
        "Invalid run_id: must be a positive integer",
      );
    } finally {
      serverHandle.stop();
    }
  });
});
