import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildFindingsUpload,
  buildRunReport,
  type RunDirFacts,
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

  describe("what the refuter removed, as counts", () => {
    const report = (refuted: unknown[]) =>
      buildRunReport({
        outcome: "reviewed",
        prNumber: 7,
        triggerHeadSha: TRIGGER_HEAD,
        run: readRunDir(
          fixtureDir({
            "findings.json": { ...FINDINGS, debug: { refuted } },
          }),
        ),
      });
    const refuted = (hunter: unknown) => ({
      ...finding("F100", "blocking"),
      hunter,
      refuter_verdict: "refuted",
    });

    test("counts refuted findings per hunter, since they never reach findings[]", () => {
      const body = report([
        refuted("reliability"),
        refuted("reliability"),
        refuted("risk"),
      ]);
      expect(body?.counts.refuted_by_hunter).toEqual({
        reliability: 2,
        risk: 1,
      });
      expect(body?.counts).toMatchObject({ blocking: 1, advisory: 2 });
    });

    test("a run that refuted nothing says so, which is not the same as not knowing", () => {
      expect(report([])?.counts.refuted_by_hunter).toEqual({});
    });

    test("a hunter name that is not a plain identifier never leaves the runner", () => {
      const body = report([refuted("src/secret.ts leaks"), refuted(undefined)]);
      expect(body?.counts.refuted_by_hunter).toEqual({ unknown: 2 });
      expect(JSON.stringify(body)).not.toContain("secret.ts");
    });

    test("an entry that is not a finding costs only its own name, never the report", () => {
      const body = report([null, "text", 7, refuted("risk")]);
      expect(body?.counts.refuted_by_hunter).toEqual({ unknown: 3, risk: 1 });
      expect(body?.outcome).toBe("reviewed");
    });

    test("a hunter named like an object's own property is counted like any other", () => {
      const text = JSON.stringify(
        report([
          refuted("constructor"),
          refuted("constructor"),
          refuted("__proto__"),
        ]),
      );
      expect(JSON.parse(text).counts.refuted_by_hunter).toEqual(
        JSON.parse('{"constructor": 2, "__proto__": 1}'),
      );
    });

    test("a refuted finding's claim never leaves the runner", () => {
      expect(JSON.stringify(report([refuted("risk")]))).not.toContain(CLAIM);
    });
  });

  test("sends how long indexing took, apart from the review", () => {
    const body = buildRunReport({
      outcome: "reviewed",
      prNumber: 7,
      triggerHeadSha: TRIGGER_HEAD,
      run: readRunDir(
        fixtureDir({
          "findings.json": {
            ...FINDINGS,
            telemetry: { ...FINDINGS.telemetry, index_ms: 1200, sync_ms: 300 },
          },
        }),
      ),
    });
    expect(body?.usage).toMatchObject({ index_ms: 1200, sync_ms: 300 });
  });

  test("a run that built no index sends no indexing time, which is not a time of zero", () => {
    const body = buildRunReport({
      outcome: "reviewed",
      prNumber: 7,
      triggerHeadSha: TRIGGER_HEAD,
      run: readRunDir(
        fixtureDir({
          "findings.json": {
            ...FINDINGS,
            telemetry: { ...FINDINGS.telemetry, index_ms: 0 },
          },
        }),
      ),
    });
    expect(body?.usage).not.toHaveProperty("index_ms");
  });

  test("an engine that measured no sync sends none", () => {
    const body = buildRunReport({
      outcome: "reviewed",
      prNumber: 7,
      triggerHeadSha: TRIGGER_HEAD,
      run: readRunDir(fixtureDir({ "findings.json": FINDINGS })),
    });
    expect(body?.usage).not.toHaveProperty("sync_ms");
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
      refuted_by_hunter: {},
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
    expect(body?.counts).toEqual({
      blocking: 1,
      advisory: 2,
      refuted_by_hunter: {},
    });
  });

  describe("finding_states", () => {
    const build = (findingStates: unknown) =>
      buildRunReport({
        outcome: "success",
        prNumber: 7,
        triggerHeadSha: TRIGGER_HEAD,
        run: { ...withFindings(), findingStates },
      });
    const good = {
      open: [{ id: "R001", status: "carried", tier: "blocking" }],
      fresh: { F001: "R002" },
      resolved: ["R000"],
      superseded: ["R003"],
      dropped: 0,
    };

    test("what a stronger finding replaced crosses only as ids", () => {
      const body = build({
        ...good,
        superseded: ["R003", "quoting the customer's code"],
      });
      expect(body?.finding_states?.superseded).toEqual(["R003"]);
    });

    test("a record from before that field reads as nothing replaced", () => {
      const { superseded: _omitted, ...older } = good;
      expect(build(older)?.finding_states?.superseded).toEqual([]);
    });

    test("sends what the run recorded", () => {
      expect(build(good)?.finding_states).toEqual(good);
    });

    test("no record sends nothing, so the platform can say it does not know", () => {
      expect(build(undefined)).not.toHaveProperty("finding_states");
    });

    test.each([
      ["text"],
      [{ open: "x" }],
      [{ open: [], fresh: {}, resolved: "x" }],
      [{ ...good, dropped: -1 }],
    ])("a malformed record sends nothing: %j", (bad) => {
      expect(build(bad)).not.toHaveProperty("finding_states");
    });

    test("only the known fields of known shapes pass, so no text can ride along", () => {
      const body = build({
        open: [
          { id: "R001", status: "carried", tier: "blocking", claim: CLAIM },
          { id: "not an id", status: "carried", tier: "blocking" },
          { id: "R002", status: CLAIM, tier: "blocking" },
          { id: "R003", status: "carried", tier: CLAIM },
        ],
        fresh: { F001: "R002", "F002 extra": "R003", F003: CLAIM },
        resolved: ["R000", CLAIM],
        dropped: 0,
        note: CLAIM,
      });
      expect(JSON.stringify(body)).not.toContain("PLANTED-CLAIM");
      expect(body?.finding_states).toEqual({
        open: [{ id: "R001", status: "carried", tier: "blocking" }],
        fresh: { F001: "R002" },
        resolved: ["R000"],
        superseded: [],
        dropped: 0,
      });
    });

    test("is capped, and the cut counts as dropped so the platform does not read it as resolved", () => {
      const open = Array.from({ length: 600 }, (_, i) => ({
        id: `R${String(i + 1).padStart(3, "0")}`,
        status: "carried",
        tier: "advisory",
      }));
      const states = build({
        open,
        fresh: {},
        resolved: [],
        dropped: 2,
      })?.finding_states;
      expect(states?.open).toHaveLength(500);
      expect(states?.dropped).toBe(102);
    });
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

// The report the base code (before the cache split) sent for FINDINGS + PIPELINE, byte for byte.
const LEGACY_REPORT =
  '{"outcome":"reviewed","pr_number":7,"head_sha":"067297acd7e7aac125a156bf597f4d05d255659e","base_sha":"b4efc4c2c2e3b37445b4505171006ed05130c2cc","run_status":"complete","schema_version":"1.1.0","engine_version":"1.4.2","model":"sonnet","counts":{"blocking":1,"advisory":2,"refuted_by_hunter":{}},"usage":{"tokens_in":1000,"tokens_out":500,"cost_usd":0.75,"cost_is_floor":true,"wall_ms":5000,"index_ms":1},"agents":[{"agent_key":"reliability","model":"claude-sonnet-4-5","tokens_in":600,"tokens_out":300,"cost_usd":0.4,"duration_ms":3000,"attempts":2,"status":"ok"},{"agent_key":"refuter","model":"claude-opus-4-1","tokens_in":400,"tokens_out":200,"cost_usd":0.35,"duration_ms":1000,"attempts":1,"status":"ok"}]}';

// One step's or one run's `usage_v2` as the Claude CLI transport writes it: the four disjoint leaves, and
// the list total in cash on a per-token key or in notional on a subscription, never both.
function usageV2(
  billingMode: string,
  leaves: [number, number, number, number],
  listUsd: number,
): Record<string, unknown> {
  const [inputUncached, inputCacheRead, inputCacheWrite, outputVisible] =
    leaves;
  return {
    wallMs: 1000,
    tokens: { inputUncached, inputCacheRead, inputCacheWrite, outputVisible },
    completeness: "complete",
    billingMode,
    ...(billingMode === "metered"
      ? { cashCostUsd: listUsd }
      : { cashCostUsd: 0, notionalCostUsd: listUsd }),
    costSource: billingMode === "metered" ? "provider" : "subscription",
  };
}

const tokensOf = (leaves: [number, number, number, number]) => ({
  input_uncached: leaves[0],
  input_cache_read: leaves[1],
  input_cache_write: leaves[2],
  output: leaves[3],
});

// A hunter, a refuter fanned out over two findings, the summary row (whose step is `summarizer`), and a
// warmup step no agent row owns.
function cachedRun(billingMode: "subscription" | "metered") {
  return {
    findings: {
      ...FINDINGS,
      telemetry: {
        ...FINDINGS.telemetry,
        per_agent: {
          ...FINDINGS.telemetry.per_agent,
          summary: { tokens_in: 1, tokens_out: 1, cost_usd_est: 0 },
        },
      },
    },
    pipeline: {
      usage_v2: usageV2(billingMode, [10, 5000, 700, 300], 2.5),
      steps: [
        {
          name: "warmup-1",
          model: "m-warm",
          usage_v2: usageV2(billingMode, [1, 0, 400, 1], 0.5),
        },
        {
          name: "hunter-reliability",
          model: "claude-sonnet-4-5",
          usage_v2: usageV2(billingMode, [5, 3000, 200, 200], 1.25),
        },
        {
          name: "refuter-F001",
          model: "claude-opus-4-1",
          usage_v2: usageV2(billingMode, [2, 1000, 50, 50], 0.375),
        },
        {
          name: "refuter-F002",
          model: "claude-opus-4-1",
          usage_v2: usageV2(billingMode, [1, 900, 40, 40], 0.25),
        },
        {
          name: "summarizer",
          model: "m-summary",
          usage_v2: usageV2(billingMode, [1, 100, 10, 9], 0.125),
        },
      ],
    },
  };
}

describe("buildRunReport: the cache split and the list-price cost", () => {
  const report = (run: RunDirFacts) =>
    buildRunReport({
      outcome: "reviewed",
      prNumber: 7,
      triggerHeadSha: TRIGGER_HEAD,
      run,
    });
  const agent = (body: RunReportBody | null, key: string) =>
    body?.agents.find((row) => row.agent_key === key);

  test("a subscription run sends its token split, its notional cost as the list cost, and its billing", () => {
    const body = report(cachedRun("subscription"));
    expect(body?.usage).toMatchObject({
      tokens: tokensOf([10, 5000, 700, 300]),
      list_cost_usd: 2.5,
      billing: "subscription",
    });
    expect(agent(body, "reliability")).toMatchObject({
      tokens: tokensOf([5, 3000, 200, 200]),
      list_cost_usd: 1.25,
    });
    // Both refuter steps sum into the one refuter row.
    expect(agent(body, "refuter")).toMatchObject({
      tokens: tokensOf([3, 1900, 90, 90]),
      list_cost_usd: 0.625,
    });
    // The summary row owns the `summarizer` step through the alias.
    expect(agent(body, "summary")).toMatchObject({
      tokens: tokensOf([1, 100, 10, 9]),
      list_cost_usd: 0.125,
    });
  });

  test("a metered run sends its cash cost as the list cost", () => {
    const body = report(cachedRun("metered"));
    expect(body?.usage).toMatchObject({
      tokens: tokensOf([10, 5000, 700, 300]),
      list_cost_usd: 2.5,
      billing: "metered",
    });
    expect(agent(body, "refuter")).toMatchObject({
      tokens: tokensOf([3, 1900, 90, 90]),
      list_cost_usd: 0.625,
    });
  });

  test("a step no agent row owns stays in the run totals and in no agent's", () => {
    const body = report(cachedRun("subscription"));
    const summed = (body?.agents ?? []).reduce(
      (total, row) => total + (row.list_cost_usd ?? 0),
      0,
    );
    // 2.5 for the run, 0.5 of it the warmup's.
    expect(summed).toBe(2);
    const cacheWrite = (body?.agents ?? []).reduce(
      (total, row) => total + (row.tokens?.input_cache_write ?? 0),
      0,
    );
    expect(cacheWrite).toBe(300);
  });

  test("the existing fields keep their values and meaning beside the new ones", () => {
    const body = report(cachedRun("subscription"));
    expect(body?.usage).toMatchObject({
      tokens_in: 1000,
      tokens_out: 500,
      cost_usd: 0.75,
      cost_is_floor: true,
    });
    expect(agent(body, "refuter")).toMatchObject({
      model: "claude-opus-4-1",
      tokens_in: 400,
      tokens_out: 200,
      cost_usd: 0.35,
    });
  });

  test("a run from before usage_v2 sends exactly what it sent before", () => {
    const body = report(
      readRunDir(
        fixtureDir({ "findings.json": FINDINGS, "pipeline.json": PIPELINE }),
      ),
    );
    expect(JSON.stringify(body)).toBe(LEGACY_REPORT);
  });

  test("adding usage_v2 changes no existing field: without the new keys the report is the old one", () => {
    const pipeline = {
      usage_v2: usageV2("subscription", [1, 2, 3, 4], 1),
      steps: PIPELINE.steps.map((step) => ({
        ...step,
        usage_v2: usageV2("subscription", [1, 2, 3, 4], 0.5),
      })),
    };
    const body = report({ findings: FINDINGS, pipeline });
    const stripped = JSON.parse(JSON.stringify(body), (key, value) =>
      ["tokens", "list_cost_usd", "billing"].includes(key) ? undefined : value,
    );
    expect(JSON.stringify(stripped)).toBe(LEGACY_REPORT);
    expect(body?.usage.tokens).toBeDefined();
  });

  test("a run with no pipeline.json, or one without usage_v2, sends none of the new fields", () => {
    for (const pipeline of [
      undefined,
      PIPELINE,
      { usage_v2: null, steps: [] },
    ]) {
      const body = report({ findings: FINDINGS, pipeline });
      const text = JSON.stringify(body);
      for (const key of ["tokens", "list_cost_usd", "billing"]) {
        expect(text).not.toContain(`"${key}"`);
      }
    }
  });

  test("a malformed field costs only that field, never the report", () => {
    const run = cachedRun("subscription");
    const pipeline = {
      usage_v2: {
        ...usageV2("subscription", [10, 5000, 700, 300], 2.5),
        tokens: {
          inputUncached: 10,
          inputCacheRead: "lots",
          inputCacheWrite: -1,
          outputVisible: 300.4,
        },
        notionalCostUsd: Number.NaN,
        billingMode: "barter",
      },
      steps: [
        { name: "hunter-reliability", model: "m", usage_v2: "not usage" },
        {
          name: "refuter-F001",
          model: "m",
          usage_v2: { ...usageV2("subscription", [1, 1, 1, 1], 1), tokens: 7 },
        },
      ],
    };
    const body = report({ findings: run.findings, pipeline });
    expect(body?.usage.tokens).toEqual({ input_uncached: 10, output: 300 });
    expect(body?.usage).not.toHaveProperty("list_cost_usd");
    expect(body?.usage).not.toHaveProperty("billing");
    expect(agent(body, "reliability")).not.toHaveProperty("tokens");
    expect(agent(body, "reliability")).not.toHaveProperty("list_cost_usd");
    // The refuter's tokens are not an object, but its cost still is.
    expect(agent(body, "refuter")).not.toHaveProperty("tokens");
    expect(agent(body, "refuter")?.list_cost_usd).toBe(1);
    expect(body?.usage.tokens_in).toBe(1000);
  });

  test("an empty token record sends no tokens object", () => {
    const pipeline = {
      usage_v2: { ...usageV2("subscription", [0, 0, 0, 0], 0), tokens: {} },
      steps: [],
    };
    const body = report({ findings: FINDINGS, pipeline });
    expect(body?.usage).not.toHaveProperty("tokens");
    expect(body?.usage.list_cost_usd).toBe(0);
  });

  test("free or unknown billing sends no billing and no list cost, since neither field can be read", () => {
    for (const billingMode of ["free", "unknown"]) {
      const pipeline = {
        usage_v2: { ...usageV2(billingMode, [1, 2, 3, 4], 1), cashCostUsd: 1 },
        steps: [
          {
            name: "hunter-reliability",
            model: "m",
            usage_v2: {
              ...usageV2(billingMode, [1, 2, 3, 4], 1),
              cashCostUsd: 1,
            },
          },
        ],
      };
      const body = report({ findings: FINDINGS, pipeline });
      expect(body?.usage.tokens).toEqual(tokensOf([1, 2, 3, 4]));
      expect(body?.usage).not.toHaveProperty("billing");
      expect(body?.usage).not.toHaveProperty("list_cost_usd");
      expect(agent(body, "reliability")).not.toHaveProperty("list_cost_usd");
    }
  });

  test("a run that mixes billing sums each step's own list cost, and a multi-model step each model's", () => {
    const pipeline = {
      // sumNormalizedUsage says unknown once two steps disagree.
      usage_v2: { ...usageV2("unknown", [3, 3, 3, 3], 0), cashCostUsd: 2 },
      steps: [
        {
          name: "hunter-reliability",
          model: "m",
          usage_v2: usageV2("subscription", [1, 1, 1, 1], 1.5),
        },
        {
          name: "refuter-F001",
          model: "m",
          usage_v2: { ...usageV2("unknown", [2, 2, 2, 2], 0), cashCostUsd: 2 },
          model_attempts: [
            { model: "a", usage_v2: usageV2("subscription", [1, 1, 1, 1], 1) },
            { model: "b", usage_v2: usageV2("metered", [1, 1, 1, 1], 2) },
          ],
        },
      ],
    };
    const body = report({ findings: FINDINGS, pipeline });
    expect(body?.usage).not.toHaveProperty("billing");
    expect(body?.usage.list_cost_usd).toBe(4.5);
    expect(agent(body, "reliability")?.list_cost_usd).toBe(1.5);
    expect(agent(body, "refuter")?.list_cost_usd).toBe(3);
  });

  test("a mixed run whose steps cannot all be priced sends no run list cost", () => {
    const pipeline = {
      usage_v2: usageV2("unknown", [2, 2, 2, 2], 0),
      steps: [
        {
          name: "hunter-reliability",
          model: "m",
          usage_v2: usageV2("subscription", [1, 1, 1, 1], 1.5),
        },
        {
          name: "refuter-F001",
          model: "m",
          usage_v2: usageV2("free", [1, 1, 1, 1], 0),
        },
      ],
    };
    const body = report({ findings: FINDINGS, pipeline });
    expect(body?.usage).not.toHaveProperty("list_cost_usd");
    expect(agent(body, "reliability")?.list_cost_usd).toBe(1.5);
  });

  test("reasoning output counts as output and an inclusive total's uncached residual as uncached input", () => {
    const pipeline = {
      usage_v2: {
        ...usageV2("metered", [0, 0, 0, 0], 1),
        tokens: {
          inputUncached: 4,
          inputOther: 6,
          inputCacheRead: 20,
          outputVisible: 7,
          outputReasoning: 3,
          outputOther: 1,
          inputKnown: 30,
          outputKnown: 11,
          totalKnown: 41,
        },
      },
      steps: [],
    };
    const body = report({ findings: FINDINGS, pipeline });
    expect(body?.usage.tokens).toEqual({
      input_uncached: 10,
      input_cache_read: 20,
      output: 11,
    });
  });

  test("a step is summed into one agent row at most, the exact name winning over a prefix", () => {
    const pipeline = {
      steps: [
        {
          name: "materiality-F001",
          model: "m",
          usage_v2: usageV2("metered", [1, 1, 1, 1], 1),
        },
      ],
    };
    const findings = {
      ...FINDINGS,
      telemetry: {
        ...FINDINGS.telemetry,
        per_agent: {
          materiality: { tokens_in: 1, tokens_out: 1 },
          "materiality-F001": { tokens_in: 1, tokens_out: 1 },
        },
      },
    };
    const body = report({ findings, pipeline });
    expect(agent(body, "materiality")).not.toHaveProperty("list_cost_usd");
    expect(agent(body, "materiality-F001")?.list_cost_usd).toBe(1);
  });

  test("the zero report of a run that wrote no findings stays zero, whatever pipeline.json says", () => {
    const body = report({ pipeline: cachedRun("metered").pipeline });
    expect(body?.usage).toEqual({ tokens_in: 0, tokens_out: 0, cost_usd: 0 });
    expect(body?.agents).toEqual([]);
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
      refuted_by_hunter: {},
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
