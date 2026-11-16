// A minimal MCP client for tests: spawns `crysk mcp-search` exactly as the agy
// transport writes it into mcp_config.json, sends newline-delimited JSON-RPC
// and collects every stdout line, so a test can assert that stdout carries
// nothing but JSON-RPC.
import { selfInvocation } from "../../src/assets";
import { agySearchServer } from "../../src/transports/agy-cli";

export interface RpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
}

export class SearchClient {
  readonly stdoutLines: string[] = [];
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private buffer = "";
  private readonly waiters = new Map<
    number | string | null,
    (message: RpcMessage) => void
  >();
  private readonly pending = new Map<number | string | null, RpcMessage>();
  private readonly reading: Promise<void>;
  private nextId = 100;

  constructor(
    root: string,
    options: { readonly cwd?: string; readonly argsOverride?: string[] } = {},
  ) {
    const server = agySearchServer(selfInvocation(), root);
    const args = options.argsOverride ?? [...server.args];
    this.proc = Bun.spawn([server.command, ...args], {
      cwd: options.cwd ?? root,
      env: { HOME: process.env.HOME ?? "/nonexistent", PATH: "/usr/bin:/bin" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.reading = this.read();
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.stdoutLines.push(line);
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          newline = this.buffer.indexOf("\n");
          continue;
        }
        const id = message.id ?? null;
        const waiter = this.waiters.get(id);
        if (waiter !== undefined) {
          this.waiters.delete(id);
          waiter(message);
        } else {
          this.pending.set(id, message);
        }
        newline = this.buffer.indexOf("\n");
      }
    }
  }

  sendRaw(text: string): void {
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(text);
    stdin.flush();
  }

  send(message: Record<string, unknown>): void {
    this.sendRaw(`${JSON.stringify(message)}\n`);
  }

  waitFor(id: number | string | null, timeoutMs = 15_000): Promise<RpcMessage> {
    const ready = this.pending.get(id);
    if (ready !== undefined) {
      this.pending.delete(id);
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no response for id ${String(id)}`)),
        timeoutMs,
      );
      this.waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<RpcMessage> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.waitFor(id, timeoutMs);
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ToolResult> {
    const response = await this.request(
      "tools/call",
      {
        _meta: { progressToken: "t:1" },
        name,
        arguments: args,
      },
      timeoutMs,
    );
    if (response.error !== undefined) {
      throw new Error(`tools/call failed: ${response.error.message}`);
    }
    return response.result as ToolResult;
  }

  async text(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.call(name, args);
    return result.content.map((part) => part.text).join("");
  }

  async close(): Promise<{ exitCode: number | null; stderr: string }> {
    const stdin = this.proc.stdin as import("bun").FileSink;
    try {
      stdin.end();
    } catch {
      // already closed
    }
    const exitCode = await this.proc.exited;
    await this.reading;
    const stderr = await new Response(
      this.proc.stderr as ReadableStream<Uint8Array>,
    ).text();
    return { exitCode, stderr };
  }

  kill(): void {
    this.proc.kill();
  }
}
