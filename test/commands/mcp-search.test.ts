// odd/tasks/antigravity-oauth.md T4b (S5, L15): `crysk mcp-search --root <dir>`
// speaks MCP over stdio the way agy drives it. Each test spawns the exact
// command the agy transport writes into mcp_config.json.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { selfInvocation } from "../../src/assets";
import { agySearchServer } from "../../src/transports/agy-cli";
import { SearchClient } from "../search/client";

let root = "";
let repo = "";

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "crysk-mcp-search-")),
  );
  repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(
    path.join(repo, "src", "a.ts"),
    "const NEEDLE = 1;\nexport {};\n",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function everyLineIsJsonRpc(lines: readonly string[]): void {
  for (const line of lines) {
    const parsed = JSON.parse(line) as { jsonrpc?: string };
    expect(parsed.jsonrpc).toBe("2.0");
  }
}

describe("the agy handshake (L15)", () => {
  test("server/discover, initialize, notifications, tools/list and tools/call with _meta", async () => {
    const client = new SearchClient(repo);
    // The exact order and shapes agy 1.5.7 sent the spike's server (L15).
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientInfo": {
            name: "antigravity-client",
            version: "v1.0.0",
          },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
      },
    });
    const discover = await client.waitFor(1);
    expect(discover.error).toBeUndefined();
    expect(discover.result).toEqual({});

    client.send({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        clientInfo: { name: "antigravity-client", version: "v1.0.0" },
        protocolVersion: "2025-11-25",
        capabilities: { roots: { listChanged: true } },
      },
    });
    const init = await client.waitFor(2);
    expect(init.result).toEqual({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "crysk-search", version: expect.any(String) },
    });

    client.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    client.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const list = await client.waitFor(3);
    const tools = (list.result as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["grep", "glob", "list"]);
    for (const tool of tools as unknown as {
      inputSchema: { type: string };
      description: string;
    }[]) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
    }

    client.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        _meta: {
          "antigravity.google/conversation_id": "c",
          progressToken: "p:4",
        },
        name: "grep",
        arguments: { pattern: "NEEDLE" },
      },
    });
    const call = await client.waitFor(4);
    expect(call.result).toEqual({
      content: [{ type: "text", text: "src/a.ts:1:const NEEDLE = 1;" }],
    });

    const { exitCode } = await client.close();
    expect(exitCode).toBe(0);
    // Notifications get no reply: exactly the four responses, nothing else.
    expect(client.stdoutLines).toHaveLength(4);
    everyLineIsJsonRpc(client.stdoutLines);
  });

  test("ping answers an empty result", async () => {
    const client = new SearchClient(repo);
    const pong = await client.request("ping");
    expect(pong.result).toEqual({});
    await client.close();
  });

  test("an unknown method is a JSON-RPC error and the server keeps serving", async () => {
    const client = new SearchClient(repo);
    const unknown = await client.request("resources/list");
    expect(unknown.error?.code).toBe(-32601);
    expect(unknown.result).toBeUndefined();
    expect(await client.text("grep", { pattern: "NEEDLE" })).toBe(
      "src/a.ts:1:const NEEDLE = 1;",
    );
    await client.close();
  });

  test("malformed lines are parse errors, never a crash", async () => {
    const client = new SearchClient(repo);
    client.sendRaw("{not json\n");
    const parse = await client.waitFor(null);
    expect(parse.error?.code).toBe(-32700);
    client.sendRaw('[{"jsonrpc":"2.0","id":7,"method":"ping"}]\n');
    const batch = await client.waitFor(null);
    expect(batch.error?.code).toBe(-32600);
    client.send({ jsonrpc: "2.0", id: 8 });
    // A message with an id and no method is a client response: ignored.
    const pong = await client.request("ping");
    expect(pong.result).toEqual({});
    const { exitCode } = await client.close();
    expect(exitCode).toBe(0);
    everyLineIsJsonRpc(client.stdoutLines);
  });

  test("tools/call with an unknown tool or bad arguments is an isError result", async () => {
    const client = new SearchClient(repo);
    const unknown = await client.call("write", { path: "x" });
    expect(unknown.isError).toBe(true);
    const missing = await client.call("grep", {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("pattern");
    const wrongType = await client.call("glob", { pattern: 5 });
    expect(wrongType.isError).toBe(true);
    await client.close();
  });
});

describe("the subcommand", () => {
  test("a missing or non-directory --root exits 2 with a message and no stdout", async () => {
    const self = selfInvocation();
    for (const args of [[], ["--root"], ["--root", path.join(root, "nope")]]) {
      const proc = Bun.spawn(
        [
          self.command,
          "--no-env-file",
          "--config=/dev/null",
          ...self.args,
          "mcp-search",
          ...args,
        ],
        { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).toBe(2);
      expect(await new Response(proc.stdout).text()).toBe("");
      expect(await new Response(proc.stderr).text()).toContain("--root");
    }
  });

  test("the repository's bunfig.toml preload and .env never run in the server (cwd is the repo)", async () => {
    // agy starts the MCP child in the reviewed repository; bun would load a
    // preload and a .env from there (measured) unless told not to.
    const marker = path.join(root, "preload-ran");
    writeFileSync(path.join(repo, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
    writeFileSync(
      path.join(repo, "evil.ts"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"); console.log("EVIL");\n`,
    );
    writeFileSync(path.join(repo, ".env"), "CRYSK_EVIL_ENV=1\n");
    const client = new SearchClient(repo, { cwd: repo });
    const pong = await client.request("ping");
    expect(pong.result).toEqual({});
    await client.close();
    expect(existsSync(marker)).toBe(false);
    everyLineIsJsonRpc(client.stdoutLines);
  });

  test("the transport's command hardens bun only when crysk runs as a script", () => {
    const script = agySearchServer(
      { command: "/opt/bun", args: ["/opt/crysk/src/cli.ts"] },
      "/w",
    );
    expect(script).toEqual({
      command: "/opt/bun",
      args: [
        "--no-env-file",
        "--config=/dev/null",
        "/opt/crysk/src/cli.ts",
        "mcp-search",
        "--root",
        "/w",
      ],
    });
    // The release binary is built with --no-compile-autoload-bunfig and
    // --no-compile-autoload-dotenv, and takes no bun flags.
    expect(agySearchServer({ command: "/opt/crysk", args: [] }, "/w")).toEqual({
      command: "/opt/crysk",
      args: ["mcp-search", "--root", "/w"],
    });
  });
});
