// OpenAI-compatible localhost shim over the Claude Code CLI, so Martian's own
// offline pipeline (steps 2, 2.5 and 3) runs unmodified on a Claude
// subscription instead of an API key.
//
//   bun run scripts/martian-claude-shim.ts [--port 8787] [--concurrency 4]
//   MARTIAN_BASE_URL=http://127.0.0.1:8787/v1 MARTIAN_API_KEY=local \
//   MARTIAN_MODEL=anthropic/claude-opus-4-5-20251101 uv run python -m ...
//
// Each chat completion becomes one `claude -p --model <exact id>` call. The
// request's system message replaces Claude Code's system prompt, so the judge
// sees what an API call would: no tools, no MCP, no settings, no CLAUDE.md.
// The model id must be exact (`anthropic/claude-opus-4-5-20251101`), never an
// alias: `opus` resolves to whatever is newest, and the published vendor rows
// were judged by Opus 4.5.
//
// Known gap, disclosed in every ledger entry that uses this: the CLI exposes
// no `temperature`, so Martian's `temperature=0.0` is not applied.
//
// Martian's steps 2.5 and 3 give each call 30 s (`LLM_CALL_TIMEOUT`) and send
// batches of 20-30 at once. Each call here spawns a CLI and waits for a slot,
// so queued calls overrun that budget and the client gives up. Step 2.5 then
// silently falls back to "no dedup", which inflates our false positives
// (Martian 50, 2026-10-25: 18 of 49 PRs, 80 abandoned calls). Raise
// `LLM_CALL_TIMEOUT` in the working copy before judging, and read the
// abandoned-call lines this shim prints: there must be none.

const EXACT_MODEL = /^(?:anthropic\/)?(claude-[a-z0-9.-]+-\d{8})$/;

function argValue(flag: string, fallback: string): string {
  const i = Bun.argv.indexOf(flag);
  return i < 0 ? fallback : (Bun.argv[i + 1] ?? fallback);
}

const port = Number(argValue("--port", "8787"));
const concurrency = Number(argValue("--concurrency", "4"));

let active = 0;
const waiting: Array<() => void> = [];
// A client that went away (Ctrl-C, timeout, retry) must not keep spending
// quota: a waiter woken after its request aborted passes the slot on instead
// of spawning, and a running child is killed on abort.
let abandoned = 0;
async function slot<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const queuedAt = Date.now();
  const onAbort = () => reportAbandoned(queuedAt);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    if (signal.aborted) {
      waiting.shift()?.();
      throw new Error("client went away before its turn");
    }
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  } finally {
    // Only an abort while this call is pending counts as abandoned.
    signal.removeEventListener("abort", onAbort);
  }
}

// A client that gives up is a scoring problem, not noise: Martian falls back
// or records an error for that review. Say how long it waited, every time.
function reportAbandoned(queuedAt: number): void {
  abandoned++;
  const seconds = Math.round((Date.now() - queuedAt) / 1000);
  console.error(
    `ABANDONED call #${abandoned}: the client gave up after ${seconds}s ` +
      `(${active} running, ${waiting.length} queued). Its timeout is shorter than ` +
      `this shim's latency: raise LLM_CALL_TIMEOUT in the Martian working copy ` +
      `and re-run the step with --force for this tool.`,
  );
}

interface ChatMessage {
  role: string;
  content: string;
}

async function complete(
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<{ text: string; model: string }> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const user = messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content)
    .join("\n\n");
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--system-prompt",
      system,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--tools",
      "",
    ],
    { stdin: new Blob([user]), stdout: "pipe", stderr: "pipe" },
  );
  const kill = () => proc.kill();
  signal.addEventListener("abort", kill, { once: true });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => signal.removeEventListener("abort", kill));
  if (signal.aborted) throw new Error("client went away; claude killed");
  if (code !== 0) throw new Error(`claude exited ${code}: ${err.slice(-500)}`);
  const result = JSON.parse(out) as {
    is_error?: boolean;
    result?: string;
    modelUsage?: Record<string, unknown>;
  };
  if (result.is_error || typeof result.result !== "string") {
    throw new Error(`claude returned an error: ${out.slice(0, 500)}`);
  }
  // Refuse to hand back an answer from a model other than the one asked for.
  const used = Object.keys(result.modelUsage ?? {});
  if (!used.includes(model)) {
    throw new Error(`asked for ${model}, claude used ${used.join(", ")}`);
  }
  return { text: result.result, model };
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    const body = (await req.json()) as {
      model?: string;
      messages?: ChatMessage[];
    };
    const exact = EXACT_MODEL.exec(body.model ?? "")?.[1];
    if (exact === undefined || !Array.isArray(body.messages)) {
      return Response.json(
        {
          error: { message: `need an exact dated model id, got ${body.model}` },
        },
        { status: 400 },
      );
    }
    try {
      const { text, model } = await slot(req.signal, () =>
        complete(exact, body.messages as ChatMessage[], req.signal),
      );
      return Response.json({
        id: `shim-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
      });
    } catch (error) {
      console.error(String(error));
      return Response.json(
        { error: { message: String(error) } },
        { status: 502 },
      );
    }
  },
});
console.error(
  `martian-claude-shim on http://127.0.0.1:${port}/v1 (concurrency ${concurrency})`,
);
