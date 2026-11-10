import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parseCliRecord, parseTriggerRecord } from "../../src/ci/outcome";
import { readRunSteps, runTraceStep } from "../../src/ci/platform-trace";

const RUN_TOKEN = "run_token_secret";
const HEAD = "067297acd7e7aac125a156bf597f4d05d255659e";
const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const PROMPT = "PLANTED-PROMPT review this diff";

interface Received {
  headers: Headers;
  body: Record<string, unknown>;
}

// A fake platform: answers each POST /runs/trace with the next status in
// `statuses` (the last one repeats) and keeps every request it got.
function fakePlatform(statuses: number[]) {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/runs/trace") {
        return new Response("not found", { status: 404 });
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      received.push({
        headers: request.headers,
        body: JSON.parse(gunzipSync(bytes).toString("utf8")),
      });
      const status =
        statuses[Math.min(received.length - 1, statuses.length - 1)] ?? 202;
      return Response.json(
        status < 300
          ? { recorded: true }
          : { message: `planted refusal ${status}` },
        { status },
      );
    },
  });
  return {
    received,
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

let root: string;
let outcomeDir: string;
let runDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "crysk-trace-step-"));
  outcomeDir = path.join(root, "pr-hero-outcome");
  runDir = path.join(root, "runs", "pr-7-067297ac-1");
  mkdirSync(outcomeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(file: string, body: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof body === "string" ? body : `${JSON.stringify(body)}\n`,
  );
}

function triggerRecord(over: Record<string, unknown> = {}): void {
  const record = {
    v: 1,
    decision: "review",
    params: {},
    pr: 7,
    head_sha: HEAD,
    repository: "acme/app",
    run_id: "42",
    run_attempt: 1,
    run_url: "https://github.com/acme/app/actions/runs/42",
    ...over,
  };
  const text = `${JSON.stringify(record)}\n`;
  // The fixture must be one the publisher itself would read.
  expect(parseTriggerRecord(text)).toBeDefined();
  write(path.join(outcomeDir, "trigger.json"), text);
}

function cliRecord(record: Record<string, unknown>): void {
  const text = `${JSON.stringify(record)}\n`;
  expect(parseCliRecord(text)).toBeDefined();
  write(path.join(outcomeDir, "cli-started"), "");
  write(path.join(outcomeDir, "cli.json"), text);
}

// A reviewed run: one hunter whose Claude session made no tool call.
function reviewedRunDir(): void {
  write(path.join(runDir, "pipeline.json"), {
    schema_version: "1.0.0",
    head_sha: HEAD,
    engine: { name: "pr-hero", version: "9.9.9" },
    steps: [
      {
        name: "hunter-logic",
        model: "sonnet",
        effort: "high",
        status: "ok",
        attempts: 1,
        systemPromptPath: path.join(runDir, "steps", "hunter-logic.system.md"),
        outPath: path.join(runDir, "steps", "hunter-logic.draft.json"),
      },
    ],
  });
  write(path.join(runDir, "findings.json"), {
    schema_version: "1.1.0",
    head_sha: HEAD,
    run_status: "complete",
    findings: [],
  });
  write(path.join(runDir, "steps", "hunter-logic.system.md"), "SYSTEM");
  write(path.join(runDir, "steps", "hunter-logic.draft.json"), "{}");
  write(path.join(runDir, "steps", "evidence.hunter-logic.attempt1.json"), {
    schemaVersion: 1,
    attempt: 1,
    stepName: "hunter-logic",
    identity: {
      route: { provider: "anthropic", modelSnapshot: "sonnet" },
      executionModel: "sonnet",
    },
    settlement: { timestamps: { startedAt: at(1), settledAt: at(5) } },
    outcome: {
      completion: "success",
      usage: {
        wallMs: 4000,
        tokens: { inputUncached: 10, outputVisible: 5 },
        billingMode: "metered",
        cashCostUsd: 0.01,
      },
    },
  });
  write(
    path.join(runDir, "steps", "trace.hunter-logic.attempt1.jsonl"),
    `${JSON.stringify({ type: "user", timestamp: at(1), message: { role: "user", content: PROMPT } })}\n`,
  );
  // Files the reader must not mistake for evidence.
  write(
    path.join(runDir, "steps", "evidence.hunter-logic.attempt1.request.json"),
    { stepName: "hunter-logic" },
  );
}

function env(over: Record<string, string> = {}): Record<string, string> {
  return {
    CRYSK_RUN_TOKEN: RUN_TOKEN,
    CRYSK_TRACE_CONTENT: "true",
    CRYSK_RUN_DIR: runDir,
    CRYSK_OUTCOME_DIR: outcomeDir,
    CRYSK_JOB_STATUS: "success",
    TRIGGER_PR: "7",
    TRIGGER_HEAD_SHA: HEAD,
    ...over,
  };
}

async function run(
  statuses: number[],
  environment: Record<string, string>,
  fetchOverride?: typeof fetch,
) {
  const platform = fakePlatform(statuses);
  const stdout: string[] = [];
  const sleeps: number[] = [];
  try {
    const code = await runTraceStep({
      fetch: fetchOverride ?? fetch,
      env: environment,
      baseUrl: platform.baseUrl,
      stdout: (text) => stdout.push(text),
      now: () => T0 + 30_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    return {
      code,
      out: stdout.join(""),
      received: platform.received,
      sleeps,
    };
  } finally {
    platform.stop();
  }
}

type Span = {
  name: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
};
function spansOf(body: Record<string, unknown>): Span[] {
  const otlp = body.otlp as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }>;
  };
  return otlp.resourceSpans.flatMap((r) =>
    r.scopeSpans.flatMap((s) => s.spans),
  );
}

describe("runTraceStep: the upload", () => {
  test("posts the gzip bundle to /runs/trace with the run token, and exits 0", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewed", head_sha: HEAD });
    reviewedRunDir();
    const r = await run([202], env());
    expect(r.code).toBe(0);
    expect(r.received).toHaveLength(1);
    const [request] = r.received;
    expect(request?.headers.get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.headers.get("content-encoding")).toBe("gzip");
    const body = request?.body ?? {};
    expect(body.schema).toBe("crysk.trace.v1");
    expect(body.outcome).toBe("reviewed");
    expect(body.code).toBeNull();
    expect(body.content).toBe(true);
    expect(body.truncated).toBe(false);
    expect(spansOf(body).map((span) => span.name)).toEqual([
      "invoke_workflow crysk.review",
      "invoke_agent hunter-logic",
      "chat sonnet",
    ]);
    expect(
      (body.transcripts as Array<{ kind: string }>).map((t) => t.kind),
    ).toEqual(["claude-session-jsonl"]);
    expect(JSON.stringify(body)).toContain(PROMPT);
    expect(r.out).not.toContain("::warning");
    expect(r.out).not.toContain(RUN_TOKEN);
  });

  test("trace content false: the bundle carries no content and no transcript", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewed", head_sha: HEAD });
    reviewedRunDir();
    for (const value of ["false", "", "TRUE"]) {
      const r = await run([202], env({ CRYSK_TRACE_CONTENT: value }));
      const body = r.received[0]?.body ?? {};
      expect(body.content).toBe(false);
      expect(body.transcripts).toEqual([]);
      expect(JSON.stringify(body)).not.toContain(PROMPT);
    }
  });

  // B2: a metadata trace carries nothing from a transcript, so reading one (up
  // to 65 MiB each) only cost memory. Nor are the prompt, body or output read.
  test("trace content false: no transcript, capture, prompt, body or output is read", () => {
    reviewedRunDir();
    write(path.join(runDir, "steps", "hunter-logic.body.md"), PROMPT);
    write(
      path.join(runDir, "steps", "evidence.hunter-logic.attempt1.capture.json"),
      { records: [] },
    );
    const pipeline = JSON.parse(
      readFileSync(path.join(runDir, "pipeline.json"), "utf8"),
    );
    const steps = readRunSteps(runDir, pipeline, false);
    expect(steps.map((step) => Object.keys(step).sort())).toEqual([
      ["attempts", "name"],
    ]);
    expect(
      steps[0]?.attempts.map((attempt) => Object.keys(attempt).sort()),
    ).toEqual([["attempt", "evidence"]]);
  });

  test("trace content false: a transcript's tool call leaves no span", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewed", head_sha: HEAD });
    reviewedRunDir();
    write(
      path.join(runDir, "steps", "trace.hunter-logic.attempt1.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        timestamp: at(2),
        message: {
          id: "msg_1",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
      })}\n`,
    );
    const r = await run([202], env({ CRYSK_TRACE_CONTENT: "false" }));
    const names = spansOf(r.received[0]?.body ?? {}).map((span) => span.name);
    expect(names).toEqual([
      "invoke_workflow crysk.review",
      "invoke_agent hunter-logic",
      "chat sonnet",
    ]);
  });

  test("with no run token nothing is sent, and the step still exits 0", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewed", head_sha: HEAD });
    reviewedRunDir();
    const r = await run([202], env({ CRYSK_RUN_TOKEN: "" }));
    expect(r.code).toBe(0);
    expect(r.received).toEqual([]);
    expect(r.out).toContain("::warning");
  });
});

describe("runTraceStep: which run directory", () => {
  test("an empty run_dir output falls back to the CLI's run-dir record", async () => {
    triggerRecord();
    cliRecord({
      v: 1,
      outcome: "hunters-failed",
      head_sha: HEAD,
      hunter_failures: [{ cause: "quota_exhausted" }],
    });
    reviewedRunDir();
    write(path.join(outcomeDir, "run-dir"), `${runDir}\n`);
    const r = await run([202], env({ CRYSK_RUN_DIR: "" }));
    const body = r.received[0]?.body ?? {};
    expect(body.outcome).toBe("hunters-failed");
    expect(body.code).toBe("CRYSK-PROVIDER-LIMITED");
    expect(spansOf(body).map((span) => span.name)).toContain(
      "invoke_agent hunter-logic",
    );
  });

  test("a run-dir record for another pull request is not read", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewed", head_sha: HEAD });
    reviewedRunDir();
    write(path.join(outcomeDir, "run-dir"), `${runDir}\n`);
    const r = await run([202], env({ CRYSK_RUN_DIR: "", TRIGGER_PR: "8" }));
    expect(spansOf(r.received[0]?.body ?? {}).map((s) => s.name)).toEqual([
      "invoke_workflow crysk.review",
    ]);
  });

  test("no run directory: a minimal trace from cli.json, with the publisher's code", async () => {
    triggerRecord();
    cliRecord({
      v: 1,
      outcome: "error",
      cls: { kind: "credential", failureClass: "missing_provider_record" },
      params: { provider: "openai" },
    });
    const r = await run([202], env({ CRYSK_RUN_DIR: "" }));
    expect(r.code).toBe(0);
    const body = r.received[0]?.body ?? {};
    expect(body.outcome).toBe("error");
    expect(body.code).toBe("CRYSK-CRED-UNUSABLE");
    const [root, ...rest] = spansOf(body);
    expect(rest).toEqual([]);
    expect(root?.attributes).toContainEqual({
      key: "crysk.cli.class",
      value: { stringValue: "credential" },
    });
  });

  test("a refusal before the CLI started takes the trigger record's code", async () => {
    triggerRecord({ decision: "no-credentials" });
    const r = await run([202], env({ CRYSK_RUN_DIR: "" }));
    const body = r.received[0]?.body ?? {};
    expect(body.outcome).toBe("error");
    expect(body.code).toBe("CRYSK-CRED-MISSING");
  });

  test("a cancelled job is an error with CRYSK-CANCELLED", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewing", head_sha: HEAD });
    reviewedRunDir();
    const r = await run(
      [202],
      env({ CRYSK_JOB_STATUS: "cancelled", CRYSK_RUN_DIR: "" }),
    );
    const body = r.received[0]?.body ?? {};
    expect(body.outcome).toBe("error");
    expect(body.code).toBe("CRYSK-CANCELLED");
  });

  // The job context's status inside a composite action is not documented, so
  // the step also reads the cancelled-run refresh, which runs only on a cancel.
  test("a cancelled-run refresh that ran marks the run cancelled, whatever job.status says", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewing", head_sha: HEAD });
    const r = await run(
      [202],
      env({
        CRYSK_JOB_STATUS: "",
        CRYSK_CANCEL_REFRESH: "success",
        CRYSK_RUN_DIR: "",
      }),
    );
    expect(r.received[0]?.body.code).toBe("CRYSK-CANCELLED");
  });

  // A3: the CLI finished and wrote its outcome; the cancel came after it.
  test("a job cancelled after the CLI wrote a terminal outcome keeps that outcome", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewed", head_sha: HEAD });
    const r = await run(
      [202],
      env({
        CRYSK_JOB_STATUS: "cancelled",
        CRYSK_CANCEL_REFRESH: "success",
        CRYSK_RUN_DIR: "",
      }),
    );
    expect(r.received[0]?.body.outcome).toBe("reviewed");
    expect(r.received[0]?.body.code).toBeNull();
  });

  test("a skipped cancelled-run refresh is no cancel", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewed", head_sha: HEAD });
    const r = await run(
      [202],
      env({ CRYSK_CANCEL_REFRESH: "skipped", CRYSK_RUN_DIR: "" }),
    );
    expect(r.received[0]?.body.outcome).toBe("reviewed");
    expect(r.received[0]?.body.code).toBeNull();
  });

  test("a run with no records names the action's own engine version", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "error", cls: { kind: "unknown" } });
    const actionPath = path.join(root, "action");
    write(path.join(actionPath, "package.json"), { version: "7.7.7" });
    const r = await run(
      [202],
      env({ CRYSK_RUN_DIR: "", CRYSK_ACTION_PATH: actionPath }),
    );
    expect(spansOf(r.received[0]?.body ?? {})[0]?.attributes).toContainEqual({
      key: "crysk.engine.version",
      value: { stringValue: "7.7.7" },
    });
  });

  test("a skipped review has no code", async () => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "skipped", skip: "size" });
    const r = await run([202], env({ CRYSK_RUN_DIR: "" }));
    const body = r.received[0]?.body ?? {};
    expect(body.outcome).toBe("skipped");
    expect(body.code).toBeNull();
  });
});

describe("runTraceStep: failures never fail the job", () => {
  beforeEach(() => {
    triggerRecord();
    cliRecord({ v: 1, outcome: "reviewed", head_sha: HEAD });
    reviewedRunDir();
  });

  test("a 503 is retried once", async () => {
    const r = await run([503, 202], env());
    expect(r.code).toBe(0);
    expect(r.received).toHaveLength(2);
    expect(r.sleeps).toHaveLength(1);
    expect(r.out).not.toContain("::warning");
  });

  test("a second 503 is a warning", async () => {
    const r = await run([503, 503], env());
    expect(r.code).toBe(0);
    expect(r.received).toHaveLength(2);
    expect(r.out).toContain("::warning");
    expect(r.out).toContain("HTTP 503");
  });

  test.each([400, 401, 413, 500])(
    "HTTP %d is a warning with no retry",
    async (status) => {
      const r = await run([status], env());
      expect(r.code).toBe(0);
      expect(r.received).toHaveLength(1);
      expect(r.out).toContain("::warning");
      expect(r.out).toContain(`HTTP ${status}`);
      expect(r.out).toContain(`planted refusal ${status}`);
    },
  );

  test("a request that cannot complete is a warning that never prints the token", async () => {
    const failing = (async () => {
      throw new Error(`connect refused for ${RUN_TOKEN}`);
    }) as unknown as typeof fetch;
    const r = await run([202], env(), failing);
    expect(r.code).toBe(0);
    expect(r.out).toContain("::warning");
    expect(r.out).not.toContain(RUN_TOKEN);
  });

  test("an unreadable run directory still sends the run's outcome", async () => {
    write(path.join(runDir, "pipeline.json"), "{not json");
    const r = await run([202], env());
    expect(r.code).toBe(0);
    expect(r.received[0]?.body.outcome).toBe("reviewed");
  });
});

// The step runs under always(), so it can run when `bun install` never did: a
// package import anywhere in its static import closure would fail the job at
// module load, outside every try/catch.
describe("platform-trace.ts runs before `bun install`", () => {
  const ROOT = path.resolve(import.meta.dir, "../..");
  const ENTRY = path.join(ROOT, "src/ci/platform-trace.ts");
  const subpaths: Record<string, string> = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ).imports;
  const IMPORT =
    /^(import|export)\s+(type\s+)?(?:[\w*${}\s,]*?\s*from\s+)?"([^"]+)"/gm;

  function resolveSpecifier(from: string, specifier: string): string | null {
    if (specifier.startsWith(".")) {
      return `${path.resolve(path.dirname(from), specifier)}.ts`;
    }
    if (specifier.startsWith("#")) {
      for (const [pattern, target] of Object.entries(subpaths)) {
        const prefix = pattern.replace("*", "");
        if (specifier.startsWith(prefix)) {
          return path.join(
            ROOT,
            target.replace("*", specifier.slice(prefix.length)),
          );
        }
      }
    }
    return null;
  }

  test("its import closure is builtins and in-repo modules only", () => {
    const files = new Set<string>();
    const offenders: string[] = [];
    const pending = [ENTRY];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (files.has(file)) continue;
      files.add(file);
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        if (match[2] !== undefined) continue;
        const specifier = match[3] ?? "";
        if (/^(node:|bun$|bun:)/.test(specifier)) continue;
        const resolved = resolveSpecifier(file, specifier);
        if (resolved === null || !existsSync(resolved)) {
          offenders.push(`${path.relative(ROOT, file)} imports "${specifier}"`);
        } else {
          pending.push(resolved);
        }
      }
    }
    // The walk reaches the builder, the redaction and the publisher's table.
    for (const reached of [
      "src/ci/trace-bundle.ts",
      "src/execution/claude-session-trace.ts",
      "src/security/evidence-redaction.ts",
      "src/ci/publish.ts",
    ]) {
      expect(files).toContain(path.join(ROOT, reached));
    }
    expect(offenders).toEqual([]);
  });
});
