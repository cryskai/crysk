import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRunReport,
  type RunReportBody,
  readRunDir,
  runReportStep,
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

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
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

  test("posts one report and prints nothing on success", async () => {
    const r = run(ENV, () => json(200, { run_id: "r1", recorded: true }));
    expect(await r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
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
