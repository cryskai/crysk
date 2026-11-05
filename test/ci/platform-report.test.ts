import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildFindingsUpload,
  buildRunReport,
  type RunReportBody,
  readRunDir,
  runReportStep,
  sendRunFindings,
  sendRunReport,
} from "../../src/ci/platform-report";

const RUN_TOKEN = "run_token_secret";
const BASE = "https://platform.test";
const HEAD = "067297acd7e7aac125a156bf597f4d05d255659e";
const BASE_SHA = "b4efc4c2c2e3b37445b4505171006ed05130c2cc";
const TRIGGER_HEAD = "a".repeat(40);
const CLAIM = "PLANTED-CLAIM stale derived state after mutation in secret.ts";
const SUMMARY = "PLANTED-SUMMARY this change uploads the customer's key";
const HOP = "PLANTED-HOP secret.ts:save";

function finding(id: string, tier: "blocking" | "advisory") {
  return {
    id,
    category: 1,
    path: "src/secret.ts",
    line: 42,
    severity: tier === "blocking" ? "BLOCKER" : "WARNING",
    evidence_class: "deterministic",
    refuter_verdict: "not_submitted",
    causal_disposition: "introduced",
    claim: CLAIM,
    proof_refs: ["diff-hunk#1"],
    hunter: "reliability",
    tier,
    hops_used: 1,
    hop_trail: [HOP],
    dedupe_key: `secret.ts:${id}`,
  };
}

const FINDINGS = {
  schema_version: "1.1.0",
  pr: 7,
  base_sha: BASE_SHA,
  head_sha: HEAD,
  model: "sonnet",
  iteration: 1,
  engine: { name: "pr-hero", version: "1.4.2" },
  parity_hunter_fired: false,
  run_status: "complete",
  summary: { prose: SUMMARY, score: 4, score_reason: SUMMARY },
  telemetry: {
    index_ms: 1,
    index_mode: "fresh",
    index_disk_mb: 1,
    wall_ms: 5000.4,
    tokens_in: 1000,
    tokens_out: 500,
    tokens_total: 1500,
    cost_usd_est: 0.75,
    cost_usd_est_is_floor: true,
    per_agent: {
      reliability: {
        tokens_total: 900,
        duration_ms: 3000,
        tokens_in: 600,
        tokens_out: 300,
        cost_usd_est: 0.4,
        attempts: 2,
        status: "ok",
        detail: SUMMARY,
      },
      refuter: {
        tokens_total: 600,
        duration_ms: 1000,
        tokens_in: 400,
        tokens_out: 200,
        cost_usd_est: 0.35,
        attempts: 1,
        status: "ok",
      },
    },
  },
  findings: [
    finding("F001", "blocking"),
    finding("F002", "advisory"),
    finding("F003", "advisory"),
  ],
  debug: { refuted: [] },
};

const PIPELINE = {
  steps: [
    { name: "hunter-reliability", model: "claude-sonnet-4-5" },
    { name: "refuter-F001", model: "claude-opus-4-1" },
    { name: "refuter-F002", model: "ignored-second" },
  ],
};

function fixtureDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "platform-report-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  return dir;
}

const withFindings = () =>
  readRunDir(fixtureDir({ "findings.json": FINDINGS }));

describe("buildRunReport", () => {
  const body = buildRunReport({
    outcome: "reviewed",
    prNumber: 7,
    triggerHeadSha: TRIGGER_HEAD,
    run: readRunDir(
      fixtureDir({ "findings.json": FINDINGS, "pipeline.json": PIPELINE }),
    ),
  });

  test("maps the envelope, counts and usage from the run directory", () => {
    expect(body).toMatchObject({
      outcome: "reviewed",
      pr_number: 7,
      head_sha: HEAD,
      base_sha: BASE_SHA,
      run_status: "complete",
      schema_version: "1.1.0",
      engine_version: "1.4.2",
      model: "sonnet",
      counts: { blocking: 1, advisory: 2 },
      usage: {
        tokens_in: 1000,
        tokens_out: 500,
        cost_usd: 0.75,
        cost_is_floor: true,
        wall_ms: 5000,
      },
    });
  });

  test("maps per-agent usage and the model of the agent's step", () => {
    expect(body?.agents).toEqual([
      {
        agent_key: "reliability",
        model: "claude-sonnet-4-5",
        tokens_in: 600,
        tokens_out: 300,
        cost_usd: 0.4,
        duration_ms: 3000,
        attempts: 2,
        status: "ok",
      },
      {
        agent_key: "refuter",
        model: "claude-opus-4-1",
        tokens_in: 400,
        tokens_out: 200,
        cost_usd: 0.35,
        duration_ms: 1000,
        attempts: 1,
        status: "ok",
      },
    ]);
  });

  test("the summary, verifier and adjudicator rows take the model of their differently named steps", () => {
    const report = buildRunReport({
      outcome: "reviewed",
      prNumber: 7,
      triggerHeadSha: TRIGGER_HEAD,
      run: {
        findings: {
          ...FINDINGS,
          telemetry: {
            ...FINDINGS.telemetry,
            per_agent: {
              summary: { tokens_in: 1, tokens_out: 1, cost_usd_est: 0.1 },
              verifier: { tokens_in: 2, tokens_out: 2, cost_usd_est: 0.2 },
              adjudicator: { tokens_in: 3, tokens_out: 3, cost_usd_est: 0.3 },
              scout: { tokens_in: 4, tokens_out: 4, cost_usd_est: 0.4 },
              materiality: { tokens_in: 5, tokens_out: 5, cost_usd_est: 0.5 },
            },
          },
        },
        pipeline: {
          steps: [
            { name: "summarizer", model: "m-summary" },
            { name: "verify-V001", model: "m-verify" },
            { name: "adjudicate-F001", model: "m-adjudicate" },
            { name: "scout", model: "m-scout" },
            { name: "materiality-F001", model: "m-materiality" },
          ],
        },
      },
    });
    expect(
      Object.fromEntries(
        (report?.agents ?? []).map((agent) => [agent.agent_key, agent.model]),
      ),
    ).toEqual({
      summary: "m-summary",
      verifier: "m-verify",
      adjudicator: "m-adjudicate",
      scout: "m-scout",
      materiality: "m-materiality",
    });
  });

  test("a per_agent row that is not an object is skipped, never read", () => {
    const report = buildRunReport({
      outcome: "reviewed",
      prNumber: 7,
      triggerHeadSha: TRIGGER_HEAD,
      run: {
        findings: {
          ...FINDINGS,
          telemetry: {
            ...FINDINGS.telemetry,
            per_agent: {
              broken: null,
              text: "x",
              list: [1],
              reliability: { tokens_in: 6, tokens_out: 1 },
            },
          },
        },
      },
    });
    expect(report?.agents.map((agent) => agent.agent_key)).toEqual([
      "reliability",
    ]);
  });

  test("never carries a finding, a claim, a summary, a hop trail or a failure detail", () => {
    const text = JSON.stringify(body);
    for (const planted of [CLAIM, SUMMARY, HOP, "secret.ts", "PLANTED"]) {
      expect(text).not.toContain(planted);
    }
    expect(Object.keys(body ?? {}).sort()).toEqual(
      [
        "agents",
        "base_sha",
        "counts",
        "engine_version",
        "head_sha",
        "model",
        "outcome",
        "pr_number",
        "run_status",
        "schema_version",
        "usage",
      ].sort(),
    );
  });

  test("sends the gate's own count of open blocking findings when the run recorded one", () => {
    const body = buildRunReport({
      outcome: "success",
      prNumber: 7,
      triggerHeadSha: TRIGGER_HEAD,
      run: { ...withFindings(), gate: { unresolved_blocking: 2 } },
    });
    expect(body?.counts).toEqual({
      blocking: 1,
      advisory: 2,
      unresolved_blocking: 2,
    });
  });

  test("zero open blocking findings is sent, because it is a statement", () => {
    const body = buildRunReport({
      outcome: "success",
      prNumber: 7,
      triggerHeadSha: TRIGGER_HEAD,
      run: { ...withFindings(), gate: { unresolved_blocking: 0 } },
    });
    expect(body?.counts.unresolved_blocking).toBe(0);
  });

  test.each([
    [undefined],
    [{}],
    [{ unresolved_blocking: -1 }],
    [{ unresolved_blocking: 1.5 }],
    [{ unresolved_blocking: "2" }],
    ["2"],
  ])("a missing or malformed gate record sends no count: %j", (gate) => {
    const body = buildRunReport({
      outcome: "success",
      prNumber: 7,
      triggerHeadSha: TRIGGER_HEAD,
      run: { ...withFindings(), gate },
    });
    expect(body?.counts).toEqual({ blocking: 1, advisory: 2 });
  });

  test("a floor that is not set is not sent, and agents are capped at 64", () => {
    const per_agent = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [
        `a${i}`,
        { tokens_total: 1, duration_ms: 1 },
      ]),
    );
    const doc = {
      ...FINDINGS,
      telemetry: {
        ...FINDINGS.telemetry,
        cost_usd_est_is_floor: undefined,
        per_agent,
      },
    };
    const capped = buildRunReport({
      outcome: "reviewed",
      prNumber: 7,
      triggerHeadSha: "",
      run: { findings: doc },
    });
    expect(capped?.usage).not.toHaveProperty("cost_is_floor");
    expect(capped?.agents).toHaveLength(64);
  });

  test("a run with no run directory reports outcome, pr and the trigger's head with zeros", () => {
    for (const run of [{}, readRunDir(""), { findings: { nope: true } }]) {
      expect(
        buildRunReport({
          outcome: "skipped-size",
          prNumber: 9,
          triggerHeadSha: TRIGGER_HEAD,
          run,
        }),
      ).toEqual({
        outcome: "skipped-size",
        pr_number: 9,
        head_sha: TRIGGER_HEAD,
        counts: { blocking: 0, advisory: 0 },
        usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
        agents: [],
      });
    }
  });

  test("an empty outcome is reported as error; no usable head builds nothing", () => {
    expect(
      buildRunReport({
        outcome: "",
        prNumber: 1,
        triggerHeadSha: TRIGGER_HEAD,
        run: {},
      })?.outcome,
    ).toBe("error");
    expect(
      buildRunReport({
        outcome: "error",
        prNumber: 1,
        triggerHeadSha: "not-a-sha",
        run: {},
      }),
    ).toBeNull();
  });

  test("readRunDir treats unreadable and malformed files as absent", () => {
    const dir = fixtureDir({});
    writeFileSync(path.join(dir, "findings.json"), "{not json");
    expect(readRunDir(dir)).toEqual({});
  });
});

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BODY = buildRunReport({
  outcome: "reviewed",
  prNumber: 7,
  triggerHeadSha: TRIGGER_HEAD,
  run: {},
}) as RunReportBody;

describe("sendRunReport", () => {
  test("POSTs the JSON body to /runs/report with the run token as bearer", async () => {
    const { fn, calls } = fakeFetch(() =>
      json(200, { run_id: "r1", recorded: true }),
    );
    const result = await sendRunReport(
      { fetch: fn, baseUrl: BASE, runToken: RUN_TOKEN },
      BODY,
    );
    expect(result).toEqual({ ok: true, recorded: true, runId: "r1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/runs/report`);
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(BODY);
  });

  test("recorded=false (a repeat of the same attempt) is a success", async () => {
    const { fn } = fakeFetch(() =>
      json(200, { run_id: "r1", recorded: false }),
    );
    expect(
      await sendRunReport(
        { fetch: fn, baseUrl: BASE, runToken: RUN_TOKEN },
        BODY,
      ),
    ).toEqual({ ok: true, recorded: false, runId: "r1" });
  });

  for (const [status, message] of [
    [401, "bad token"],
    [400, "counts.blocking must be an integer"],
  ] as const) {
    test(`HTTP ${status} names the status and the API's message`, async () => {
      const { fn } = fakeFetch(() => json(status, { message }));
      expect(
        await sendRunReport(
          { fetch: fn, baseUrl: BASE, runToken: RUN_TOKEN },
          BODY,
        ),
      ).toEqual({ ok: false, message: `HTTP ${status} — ${message}` });
    });
  }

  test("a network error is a failure that never carries the token", async () => {
    const { fn } = fakeFetch(() => {
      throw new Error(`connect failed for ${RUN_TOKEN}`);
    });
    const result = await sendRunReport(
      { fetch: fn, baseUrl: BASE, runToken: RUN_TOKEN },
      BODY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("connect failed");
      expect(result.message).not.toContain(RUN_TOKEN);
    }
  });
});

describe("buildFindingsUpload", () => {
  test("is the schema version and the findings objects, whole and in order, and nothing else", () => {
    const upload = buildFindingsUpload(FINDINGS, "full");
    expect(upload).not.toBeNull();
    expect(Object.keys(upload?.body ?? {}).sort()).toEqual([
      "findings",
      "schema_version",
    ]);
    expect(upload?.body.schema_version).toBe("1.1.0");
    expect(upload?.body.findings).toEqual(FINDINGS.findings);
    expect(upload?.dropped).toBe(0);
    const text = JSON.stringify(upload?.body);
    expect(text).not.toContain(SUMMARY);
    expect(text).not.toContain("debug");
    expect(text).not.toContain("refuted");
    expect(text).not.toContain("telemetry");
  });

  test("a document with debug arrays never carries them", () => {
    const upload = buildFindingsUpload(
      {
        ...FINDINGS,
        debug: {
          refuted: [finding("F900", "blocking")],
          deduped: [finding("F901", "blocking")],
        },
      },
      "full",
    );
    const text = JSON.stringify(upload?.body);
    expect(text).not.toContain("F900");
    expect(text).not.toContain("F901");
  });

  test("no document, an unreadable one, or zero findings is nothing to send", () => {
    expect(buildFindingsUpload(undefined, "full")).toBeNull();
    expect(buildFindingsUpload({ schema_version: "9.9.9" }, "full")).toBeNull();
    expect(buildFindingsUpload("not a document", "full")).toBeNull();
    expect(
      buildFindingsUpload({ ...FINDINGS, findings: [] }, "metadata_only"),
    ).toBeNull();
  });

  test("sends the first 500 findings in the engine's order and counts the rest as dropped", () => {
    const many = Array.from({ length: 503 }, (_, i) =>
      finding(`F${String(i + 1).padStart(4, "0")}`, "advisory"),
    );
    const upload = buildFindingsUpload({ ...FINDINGS, findings: many }, "full");
    expect(upload?.body.findings).toHaveLength(500);
    expect(upload?.body.findings).toEqual(many.slice(0, 500));
    expect(upload?.dropped).toBe(3);
  });

  test("exactly 500 findings drops none", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      finding(`F${String(i + 1).padStart(4, "0")}`, "advisory"),
    );
    const upload = buildFindingsUpload({ ...FINDINGS, findings: many }, "full");
    expect(upload?.body.findings).toHaveLength(500);
    expect(upload?.dropped).toBe(0);
  });

  // The text-bearing and unknown fields a metadata_only upload must never carry.
  const RICH = {
    ...finding("F001", "blocking"),
    symbol: "PLANTED-SYMBOL save",
    root_cause_id: "RC-1",
    materiality: { label: "immaterial", reason: "PLANTED-REASON secret.ts" },
    future_field: "PLANTED-UNKNOWN secret.ts",
  };
  const ALLOWED = {
    id: "F001",
    category: 1,
    path: "src/secret.ts",
    line: 42,
    severity: "BLOCKER",
    tier: "blocking",
    hunter: "reliability",
    evidence_class: "deterministic",
    refuter_verdict: "not_submitted",
    causal_disposition: "introduced",
    root_cause_id: "RC-1",
    hops_used: 1,
  };

  test("metadata_only keeps only the allowlisted non-text fields, with their values", () => {
    const upload = buildFindingsUpload(
      { ...FINDINGS, findings: [RICH] },
      "metadata_only",
    );
    expect(upload?.body.findings).toEqual([ALLOWED]);
    const text = JSON.stringify(upload?.body);
    for (const key of [
      "claim",
      "proof_refs",
      "hop_trail",
      "symbol",
      "dedupe_key",
      "materiality",
      "future_field",
    ]) {
      expect(text).not.toContain(`"${key}"`);
    }
    for (const planted of [
      CLAIM,
      HOP,
      "PLANTED-SYMBOL",
      "PLANTED-REASON",
      "PLANTED-UNKNOWN",
      "diff-hunk#1",
      "secret.ts:F001",
    ]) {
      expect(text).not.toContain(planted);
    }
  });

  test("metadata_only keeps the cap, the order and the schema version", () => {
    const many = Array.from({ length: 502 }, (_, i) =>
      finding(`F${String(i + 1).padStart(4, "0")}`, "advisory"),
    );
    const upload = buildFindingsUpload(
      { ...FINDINGS, findings: many },
      "metadata_only",
    );
    expect(upload?.body.schema_version).toBe("1.1.0");
    expect(upload?.body.findings).toHaveLength(500);
    expect(upload?.dropped).toBe(2);
    expect(upload?.body.findings.map((f) => (f as { id: string }).id)).toEqual(
      many.slice(0, 500).map((f) => f.id),
    );
  });

  test("full keeps every field of every finding, the unknown ones too", () => {
    const upload = buildFindingsUpload(
      { ...FINDINGS, findings: [RICH] },
      "full",
    );
    expect(upload?.body.findings).toEqual([RICH]);
  });
});

describe("sendRunFindings", () => {
  const UPLOAD = { schema_version: "1.1.0", findings: FINDINGS.findings };

  test("POSTs the JSON body to /runs/findings with the run token as bearer", async () => {
    const { fn, calls } = fakeFetch(() =>
      json(200, { stored: 3, recorded: true, mode: "full" }),
    );
    const result = await sendRunFindings(
      { fetch: fn, baseUrl: BASE, runToken: RUN_TOKEN },
      UPLOAD,
    );
    expect(result).toEqual({
      ok: true,
      stored: 3,
      recorded: true,
      mode: "full",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/runs/findings`);
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(UPLOAD);
  });

  test("recorded=false (a repeat) and metadata_only are successes", async () => {
    const { fn } = fakeFetch(() =>
      json(200, { stored: 0, recorded: false, mode: "metadata_only" }),
    );
    expect(
      await sendRunFindings(
        { fetch: fn, baseUrl: BASE, runToken: RUN_TOKEN },
        UPLOAD,
      ),
    ).toEqual({ ok: true, stored: 0, recorded: false, mode: "metadata_only" });
  });

  for (const [status, message] of [
    [409, "the run was not reported first"],
    [401, "bad token"],
    [400, "findings[0].id is required"],
    [413, "payload too large"],
  ] as const) {
    test(`HTTP ${status} names the status and the API's message`, async () => {
      const { fn } = fakeFetch(() => json(status, { message }));
      expect(
        await sendRunFindings(
          { fetch: fn, baseUrl: BASE, runToken: RUN_TOKEN },
          UPLOAD,
        ),
      ).toEqual({ ok: false, message: `HTTP ${status} — ${message}` });
    });
  }

  test("an error without a JSON message still names the status", async () => {
    const { fn } = fakeFetch(() => new Response("nope", { status: 413 }));
    expect(
      await sendRunFindings(
        { fetch: fn, baseUrl: BASE, runToken: RUN_TOKEN },
        UPLOAD,
      ),
    ).toEqual({ ok: false, message: "HTTP 413" });
  });

  test("a network error is a failure that never carries the token", async () => {
    const { fn } = fakeFetch(() => {
      throw new Error(`connect failed for ${RUN_TOKEN}`);
    });
    const result = await sendRunFindings(
      { fetch: fn, baseUrl: BASE, runToken: RUN_TOKEN },
      UPLOAD,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("connect failed");
      expect(result.message).not.toContain(RUN_TOKEN);
    }
  });
});

describe("runReportStep", () => {
  const dir = fixtureDir({
    "findings.json": FINDINGS,
    "pipeline.json": PIPELINE,
  });
  const ENV = {
    CRYSK_RUN_TOKEN: RUN_TOKEN,
    CRYSK_OUTCOME: "reviewed",
    CRYSK_RUN_DIR: dir,
    TRIGGER_PR: "7",
    TRIGGER_HEAD_SHA: TRIGGER_HEAD,
  };

  function run(
    env: Record<string, string>,
    respond: () => Response | Promise<Response>,
  ) {
    const { fn, calls } = fakeFetch(respond);
    const out: string[] = [];
    return {
      calls,
      out,
      code: runReportStep({
        fetch: fn,
        env,
        baseUrl: BASE,
        stdout: (text) => out.push(text),
      }),
    };
  }

  test("posts the report first and prints nothing on success", async () => {
    const r = run(ENV, () => json(200, { run_id: "r1", recorded: true }));
    expect(await r.code).toBe(0);
    expect(r.calls[0]?.url).toBe(`${BASE}/runs/report`);
    expect(JSON.parse(String(r.calls[0]?.init.body)).counts).toEqual({
      blocking: 1,
      advisory: 2,
    });
    expect(r.out).toEqual([]);
  });

  test("a rejected report is a warning with the status and message, and exits 0", async () => {
    for (const [status, message] of [
      [401, "bad token"],
      [400, "pr_number invalid"],
    ] as const) {
      const r = run(ENV, () => json(status, { message }));
      expect(await r.code).toBe(0);
      const text = r.out.join("");
      expect(text).toStartWith("::warning");
      expect(text).toContain(String(status));
      expect(text).toContain(message);
      expect(text).not.toContain(RUN_TOKEN);
    }
  });

  test("a network error is a warning, not a failure", async () => {
    const r = run(ENV, () => {
      throw new Error("ECONNRESET");
    });
    expect(await r.code).toBe(0);
    expect(r.out.join("")).toContain("::warning");
    expect(r.out.join("")).toContain("ECONNRESET");
  });

  test("a run without a run directory still reports, from the trigger's head", async () => {
    const r = run(
      { ...ENV, CRYSK_RUN_DIR: "", CRYSK_OUTCOME: "skipped-size" },
      () => json(200, { run_id: "r1", recorded: true }),
    );
    expect(await r.code).toBe(0);
    expect(JSON.parse(String(r.calls[0]?.init.body))).toMatchObject({
      outcome: "skipped-size",
      pr_number: 7,
      head_sha: TRIGGER_HEAD,
      counts: { blocking: 0, advisory: 0 },
    });
  });

  test("a throw while building the report is a warning that never carries the token", async () => {
    const env = {
      ...ENV,
      get TRIGGER_HEAD_SHA(): string {
        throw new Error(`boom ${RUN_TOKEN}`);
      },
    };
    const r = run(env, () => json(200, {}));
    expect(await r.code).toBe(0);
    expect(r.calls).toHaveLength(0);
    const text = r.out.join("");
    expect(text).toStartWith("::warning");
    expect(text).toContain("boom");
    expect(text).not.toContain(RUN_TOKEN);
  });

  test("a missing token, pr number or head warns and sends nothing", async () => {
    for (const patch of [
      { CRYSK_RUN_TOKEN: "" },
      { TRIGGER_PR: "" },
      { TRIGGER_PR: "0" },
      { CRYSK_RUN_DIR: "", TRIGGER_HEAD_SHA: "" },
    ]) {
      const r = run({ ...ENV, ...patch }, () => json(200, {}));
      expect(await r.code).toBe(0);
      expect(r.calls).toHaveLength(0);
      expect(r.out.join("")).toContain("::warning");
    }
  });
});

describe("runReportStep findings upload", () => {
  const ok = (call: Call): Response =>
    call.url.endsWith("/runs/report")
      ? json(200, { run_id: "r1", recorded: true })
      : json(200, { stored: 3, recorded: true, mode: "full" });

  function envFor(files: Record<string, unknown>): Record<string, string> {
    return {
      CRYSK_RUN_TOKEN: RUN_TOKEN,
      CRYSK_DATA_MODE: "full",
      CRYSK_OUTCOME: "reviewed",
      CRYSK_RUN_DIR: fixtureDir(files),
      TRIGGER_PR: "7",
      TRIGGER_HEAD_SHA: TRIGGER_HEAD,
    };
  }

  async function run(
    env: Record<string, string>,
    respond: (call: Call) => Response | Promise<Response>,
  ) {
    const { fn, calls } = fakeFetch(respond);
    const out: string[] = [];
    const code = await runReportStep({
      fetch: fn,
      env,
      baseUrl: BASE,
      stdout: (text) => out.push(text),
    });
    return { calls, out, code, text: out.join("") };
  }

  const withFindings = envFor({
    "findings.json": FINDINGS,
    "pipeline.json": PIPELINE,
  });

  test("uploads the findings right after a successful report, with the same token, and prints nothing", async () => {
    const r = await run(withFindings, ok);
    expect(r.code).toBe(0);
    expect(r.calls.map((call) => call.url)).toEqual([
      `${BASE}/runs/report`,
      `${BASE}/runs/findings`,
    ]);
    const headers = new Headers(r.calls[1]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
    expect(JSON.parse(String(r.calls[1]?.init.body))).toEqual({
      schema_version: "1.1.0",
      findings: FINDINGS.findings,
    });
    expect(r.out).toEqual([]);
  });

  test("the findings body is exactly schema_version and findings: no debug, summary or telemetry", async () => {
    const env = envFor({
      "findings.json": {
        ...FINDINGS,
        debug: { refuted: [finding("F900", "blocking")], deduped: [] },
      },
    });
    const r = await run(env, ok);
    const sent = JSON.parse(String(r.calls[1]?.init.body));
    expect(Object.keys(sent).sort()).toEqual(["findings", "schema_version"]);
    const text = String(r.calls[1]?.init.body);
    expect(text).not.toContain("F900");
    expect(text).not.toContain(SUMMARY);
  });

  test("a repeat (recorded=false) and a metadata-only repository are silent successes", async () => {
    const r = await run(withFindings, (call) =>
      call.url.endsWith("/runs/report")
        ? json(200, { run_id: "r1", recorded: false })
        : json(200, { stored: 0, recorded: false, mode: "metadata_only" }),
    );
    expect(r.calls).toHaveLength(2);
    expect(r.out).toEqual([]);
  });

  test("a run without findings.json reports but sends no findings", async () => {
    const r = await run(envFor({ "pipeline.json": PIPELINE }), ok);
    expect(r.calls.map((call) => call.url)).toEqual([`${BASE}/runs/report`]);
    expect(r.out).toEqual([]);
  });

  test("a run with no run directory sends no findings", async () => {
    const r = await run({ ...withFindings, CRYSK_RUN_DIR: "" }, ok);
    expect(r.calls.map((call) => call.url)).toEqual([`${BASE}/runs/report`]);
  });

  test("zero findings sends no findings call", async () => {
    const r = await run(
      envFor({ "findings.json": { ...FINDINGS, findings: [] } }),
      ok,
    );
    expect(r.calls.map((call) => call.url)).toEqual([`${BASE}/runs/report`]);
    expect(r.out).toEqual([]);
  });

  test("a failed report sends no findings call", async () => {
    for (const respond of [
      () => json(401, { message: "bad token" }),
      () => json(400, { message: "invalid" }),
      () => {
        throw new Error("ECONNRESET");
      },
    ]) {
      const r = await run(withFindings, respond);
      expect(r.code).toBe(0);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.url).toBe(`${BASE}/runs/report`);
    }
  });

  for (const [status, message] of [
    [409, "the run was not reported first"],
    [401, "bad token"],
    [400, "findings invalid"],
    [413, "too large"],
  ] as const) {
    test(`HTTP ${status} on the findings is a warning with the status and message, exit 0, no token`, async () => {
      const r = await run(withFindings, (call) =>
        call.url.endsWith("/runs/report")
          ? json(200, { run_id: "r1", recorded: true })
          : json(status, { message }),
      );
      expect(r.code).toBe(0);
      expect(r.text).toStartWith("::warning");
      expect(r.text).toContain("findings");
      expect(r.text).toContain(String(status));
      expect(r.text).toContain(message);
      expect(r.text).not.toContain(RUN_TOKEN);
    });
  }

  test("a network error on the findings is a warning, not a failure, and never carries the token", async () => {
    const r = await run(withFindings, (call) => {
      if (call.url.endsWith("/runs/report")) {
        return json(200, { run_id: "r1", recorded: true });
      }
      throw new Error(`ECONNRESET ${RUN_TOKEN}`);
    });
    expect(r.code).toBe(0);
    expect(r.text).toStartWith("::warning");
    expect(r.text).toContain("ECONNRESET");
    expect(r.text).not.toContain(RUN_TOKEN);
  });

  test("more than 500 findings sends the first 500 and warns how many were dropped", async () => {
    const many = Array.from({ length: 503 }, (_, i) =>
      finding(`F${String(i + 1).padStart(4, "0")}`, "advisory"),
    );
    const r = await run(
      envFor({ "findings.json": { ...FINDINGS, findings: many } }),
      ok,
    );
    expect(r.code).toBe(0);
    const sent = JSON.parse(String(r.calls[1]?.init.body));
    expect(sent.findings).toHaveLength(500);
    expect(sent.findings[499].id).toBe("F0500");
    expect(r.text).toStartWith("::warning");
    expect(r.text).toContain("3");
    expect(r.text).toContain("500");
    expect(r.text).not.toContain(RUN_TOKEN);
  });

  const rich = {
    ...finding("F001", "blocking"),
    symbol: "PLANTED-SYMBOL save",
    materiality: { label: "immaterial", reason: "PLANTED-REASON secret.ts" },
  };

  test("CRYSK_DATA_MODE=metadata_only uploads the allowlisted fields only", async () => {
    const r = await run(
      {
        ...envFor({ "findings.json": { ...FINDINGS, findings: [rich] } }),
        CRYSK_DATA_MODE: "metadata_only",
      },
      ok,
    );
    expect(r.calls).toHaveLength(2);
    const body = String(r.calls[1]?.init.body);
    for (const planted of [CLAIM, HOP, "PLANTED-SYMBOL", "PLANTED-REASON"]) {
      expect(body).not.toContain(planted);
    }
    expect(JSON.parse(body).findings[0]).toMatchObject({
      id: "F001",
      path: "src/secret.ts",
      line: 42,
      tier: "blocking",
    });
    expect(r.out).toEqual([]);
  });

  test("an absent, empty or unrecognised CRYSK_DATA_MODE is metadata_only: no finding text leaves", async () => {
    const base = envFor({
      "findings.json": { ...FINDINGS, findings: [rich] },
    });
    const { CRYSK_DATA_MODE: _unset, ...absent } = base;
    for (const env of [
      absent,
      { ...base, CRYSK_DATA_MODE: "" },
      { ...base, CRYSK_DATA_MODE: "FULL" },
      { ...base, CRYSK_DATA_MODE: "full " },
      { ...base, CRYSK_DATA_MODE: "garbage" },
    ]) {
      const r = await run(env, ok);
      expect(r.calls).toHaveLength(2);
      const body = String(r.calls[1]?.init.body);
      expect(body).not.toContain(CLAIM);
      expect(body).not.toContain("PLANTED-SYMBOL");
      expect(body).not.toContain("proof_refs");
    }
  });

  test("CRYSK_DATA_MODE=full uploads the findings whole", async () => {
    const r = await run(
      envFor({ "findings.json": { ...FINDINGS, findings: [rich] } }),
      ok,
    );
    expect(JSON.parse(String(r.calls[1]?.init.body)).findings).toEqual([rich]);
  });
});

// The step runs before `bun install` when the action's `if` admits a publish-only
// or install-failed run, so a package import anywhere in its static import
// closure would fail the job at module load, outside every try/catch.
describe("platform-report.ts runs before `bun install`", () => {
  const ROOT = path.resolve(import.meta.dir, "../..");
  const ENTRY = path.join(ROOT, "src/ci/platform-report.ts");
  const subpaths: Record<string, string> = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ).imports;
  // `import type` and `export type` are erased before the module loads.
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

  function closure(): { files: Set<string>; offenders: string[] } {
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
    return { files, offenders };
  }

  test("its import closure is builtins and in-repo modules only", () => {
    const { files, offenders } = closure();
    // The walk reaches the modules the finding named, so it is not vacuous.
    for (const reached of [
      "src/review/findings.ts",
      "src/review/materiality-gate.ts",
      "src/compare/materiality.ts",
      "src/review/boundary.ts",
      "src/security/evidence-redaction.ts",
    ]) {
      expect(files).toContain(path.join(ROOT, reached));
    }
    expect(offenders).toEqual([]);
  });
});
