import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StepSpec } from "#review/step-runner";
import {
  evidenceSha256,
  freezeAttemptEvidenceIdentity,
  readEvidenceFile,
} from "../../src/execution/attempt-evidence";
import type {
  ProviderTransport,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import {
  attemptEvidencePath,
  attemptLogPath,
} from "../../src/execution/step-artifacts";
import {
  classifyObservationEvidence,
  OpenCodeEvidenceCollector,
} from "../../src/transports/opencode-evidence";

const block = () => {
  throw new Error("NO NETWORK/SPAWN");
};

async function setup(
  change?: (r: TransportRequest) => Promise<void>,
  outcomeOverrides?: Partial<TransportOutcome>,
) {
  const dir = await mkdtemp("/tmp/producer-negative-");
  const binary = path.join(dir, "synthetic-binary");
  const mcp = path.join(dir, "mcp.json");
  const sys = path.join(dir, "system.md");
  await writeFile(binary, "ADMITTED-BINARY");
  await writeFile(mcp, '{"mcpServers":{}}');
  await writeFile(sys, "system");
  const transport: ProviderTransport = {
    backend: "claude-code",
    capabilities: async () => ({
      backend: "claude-code",
      status: "ready",
      auth: {
        kind: "claude_subscription_oauth",
        projectionReady: true,
        probe: "not_run",
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: true,
        codegraphPolicy: true,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: true,
        usageMode: "snapshot",
      },
      cancellation: { deadlineMs: 20, conformance: "passed" },
      billing: { mode: "subscription", pricingReady: true },
      issues: [],
    }),
    execute: async (r: TransportRequest) => {
      await change?.(r);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        terminalProof: {
          eventId: "actual-fixture-exit",
          providerStatus: "process_group_exited",
          providerObservedAt: new Date().toISOString(),
          exitCode: 0,
        },
        finalText: '{"findings":[]}',
        usage: {
          wallMs: 1,
          tokens: {},
          completeness: "complete",
          billingMode: "subscription",
          costSource: "provider",
          cashCostUsd: 0,
        },
        stderrTail:
          "Cookie: session=SYNTHETIC_COOKIE; csrf=SYNTHETIC_CSRF\nhttps://u:SYNTHETIC_PASSWORD@host/path",
        ...outcomeOverrides,
      };
    },
    classifyFailure: () => undefined,
  };
  const harness = new StepExecutionHarness({
    transport,
    binaryPath: binary,
    spawnFn: block as typeof Bun.spawn,
  });
  const step: StepSpec = {
    name: "hunter",
    systemPromptPath: sys,
    prompt: "review",
    tools: [],
    mcpConfigPath: mcp,
    model: "sonnet",
    effort: "high",
    cwd: dir,
    outPath: path.join(dir, "out.json"),
    timeoutMs: 50,
    maxAttempts: 1,
    parse: JSON.parse,
  };
  return { harness, step, dir, binary, mcp };
}
// PR #228 CI failure follow-up: `persistAttemptEvidence` races against a
// timer of at most `min(100, step.timeoutMs)` ms inside the harness
// (src/execution/harness.ts) — `StepExecutionHarness.run()` can return
// before the evidence file is ever written. A plain `readFile` right after
// `x.harness.run(x.step)` only passed locally because redacting a few
// thousand records happened to finish inside that window; on a slower CI
// runner (or under concurrent load) it does not, and every test in this
// file that reads the evidence JSON this way is exposed to the same race,
// not just the ones with the largest fixtures. Polling instead of a fixed
// sleep means a fast write is observed immediately and a slow one still
// succeeds, bounded by a real timeout with a clear failure message instead
// of an opaque ENOENT. NOT a fix for the race itself — the harness still
// races the timer exactly as before; this only makes the TEST observe the
// eventual, correct result instead of an arbitrary snapshot mid-write.
async function waitForEvidence(step: StepSpec, attempt = 1, timeoutMs = 10000) {
  const file = attemptEvidencePath(step.outPath, step.name, attempt);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(
          `evidence file never appeared within ${timeoutMs}ms: ${file}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    return JSON.parse(text);
  }
}
test("actual harness artifact redacts synthetic Cookie and URL credentials", async () => {
  const x = await setup();
  const result = await x.harness.run(x.step);
  expect(result.status).toBe("ok");
  const log = await readFile(
    attemptLogPath(x.step.outPath, "hunter", 1),
    "utf8",
  );
  console.log(
    "LOG_SECRET_LEAK",
    log.includes("SYNTHETIC_COOKIE"),
    log.includes("SYNTHETIC_CSRF"),
    log.includes("SYNTHETIC_PASSWORD"),
  );
  expect(log).not.toContain("SYNTHETIC_COOKIE");
  expect(log).not.toContain("SYNTHETIC_CSRF");
  expect(log).not.toContain("SYNTHETIC_PASSWORD");
  const e = await waitForEvidence(x.step);
  expect(e.delivered).toBe(true);
  expect(e.outcome.terminalProof.eventId).toBe("actual-fixture-exit");
});
test("actual harness proof preserves frozen inputs when execution mutates files", async () => {
  const x = await setup(async (r) => {
    await writeFile(r.isolation.verifiedBinaryPath, "AFTER-EXECUTION");
    if (!r.mcpConfigPath) throw new Error("missing fixture config");
    await writeFile(r.mcpConfigPath, '{"mcpServers":{"new":{}}}');
  });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  console.log(
    "POSTEXEC_IDENTITY",
    e.identity.executableSha256 === evidenceSha256("AFTER-EXECUTION"),
    e.identity.toolsConfigSha256 ===
      evidenceSha256(
        JSON.stringify({ tools: [], mcp: '{"mcpServers":{"new":{}}}' }),
      ),
  );
  expect(e.identity.executableSha256).toBe(evidenceSha256("ADMITTED-BINARY"));
  expect(e.identity.toolsConfigSha256).toBe(
    evidenceSha256(JSON.stringify({ tools: [], mcp: '{"mcpServers":{}}' })),
  );
});
test("actual harness bounds optional evidence write after settlement", async () => {
  const x = await setup();
  const original = Bun.write;
  Bun.write = ((...args: Parameters<typeof Bun.write>) =>
    String(args[0]).includes("evidence.hunter.attempt")
      ? new Promise<number>(() => {})
      : original(...args)) as typeof Bun.write;
  try {
    const result = await Promise.race([
      x.harness.run(x.step).then(() => "finished"),
      new Promise((r) => setTimeout(() => r("pending"), 200)),
    ]);
    console.log(
      "HANG_RESULT",
      result,
      "evidencepath",
      attemptEvidencePath(x.step.outPath, "hunter", 1),
    );
    expect(result).toBe("finished");
  } finally {
    Bun.write = original;
  }
});
test("classifier rejects non-string terminal text as inconclusive", () => {
  const c = new OpenCodeEvidenceCollector({ sessionId: "h", attempt: 1 });
  c.record("session_identity", {
    sessionId: "s",
    userMessageId: "u",
    cwd: "/work",
  });
  c.record("readback", {
    sessionId: "s",
    cwd: "/work",
    coverage: "complete",
    messages: [
      {
        info: {
          id: "a",
          sessionID: "s",
          role: "assistant",
          parentID: "u",
          path: { cwd: "/work" },
          finish: "stop",
          time: { completed: 1 },
        },
        parts: [
          { id: "p", sessionID: "s", messageID: "a", type: "text", text: 123 },
        ],
      },
    ],
  });
  const verdict = classifyObservationEvidence(c.snapshot(), "");
  console.log("MALFORMED_TEXT_CLASSIFICATION", verdict);
  expect(verdict).toBe("inconclusive");
});
test("persistAttemptEvidence writes the OpenCode capture once overhead accounting keeps a realistic-sized snapshot under the persist cap", async () => {
  // 1700-byte deltas land ~2313 records: comfortably under the SEPARATE
  // 20000-node budget `redactEvidence` re-applies to the whole parsed blob at
  // persist time (see the sibling test below, which pins that gap), while
  // still landing (pre-fix) ~2000-2100 bytes over the byte cap every run —
  // deterministic, not the flaky few-dozen-byte margin a coarser or finer
  // delta size produces. This isolates the comma/wrapper overhead fix under
  // test here from that other, pre-existing node-budget limit.
  const collector = new OpenCodeEvidenceCollector({
    sessionId: "s",
    attempt: 1,
  });
  for (let i = 0; i < 20000; i++)
    collector.record("event", {
      type: "message.part.delta",
      properties: { delta: "x".repeat(1700) },
    });
  const diagnosticEvidence = collector.snapshot();
  const x = await setup(undefined, { diagnosticEvidence });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  expect(e.capture).toBeDefined();
  expect(e.captureDropped).toBeUndefined();
  expect(e.capture.schema).toBe("pr-hero.opencode-observations.v1");
  const captureFile = path.join(x.dir, e.capture.relativePath);
  const bytes = await readFile(captureFile);
  expect(evidenceSha256(bytes)).toBe(e.capture.sha256);
});
test("persistAttemptEvidence persists a realistic multi-thousand-record capture by redacting each record individually", async () => {
  // SUPERSEDES the earlier pin of the "capture shape limit" gap. That gap
  // was `persistAttemptEvidence` re-redacting the ENTIRE parsed blob in one
  // `redactEvidence()` call sharing a SINGLE 20000-node budget
  // (src/security/evidence-redaction.ts:35-38), while `record()` redacts
  // each record's `data` individually with its OWN fresh budget
  // (opencode-evidence.ts). A capture with many small events (delta=500,
  // ~6800 records here) fits comfortably under the 4 MiB byte cap but blew
  // the SHARED whole-blob budget by roughly 8x.
  //
  // Fix: this function now validates the wrapper shape and redacts each
  // record's `data` on its own, one fresh budget per record — exactly the
  // bound the collector already enforces at record time. No persisted value
  // escapes redaction; the 4 MiB byte cap still bounds the total. Raising
  // `redactEvidence`'s shared budget was rejected as a security-module
  // change outside a writer's authorization.
  const collector = new OpenCodeEvidenceCollector({
    sessionId: "s",
    attempt: 1,
  });
  for (let i = 0; i < 20000; i++)
    collector.record("event", {
      type: "message.part.delta",
      properties: { delta: "x".repeat(500) },
    });
  const diagnosticEvidence = collector.snapshot();
  const x = await setup(undefined, { diagnosticEvidence });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  const captureFile = e.capture
    ? path.join(x.dir, e.capture.relativePath)
    : undefined;
  const captureBytes = captureFile ? await readFile(captureFile) : undefined;
  expect(e.captureDropped).toBeUndefined();
  expect(e.capture).toBeDefined();
  expect(e.capture.schema).toBe("pr-hero.opencode-observations.v1");
  expect(captureBytes).toBeDefined();
  expect(evidenceSha256(captureBytes as Uint8Array)).toBe(e.capture.sha256);
  const parsedCapture = JSON.parse((captureBytes as Buffer).toString("utf8"));
  expect(Array.isArray(parsedCapture.records)).toBe(true);
  expect(parsedCapture.records.length).toBeGreaterThan(2499);
});
test("persistAttemptEvidence redacts a secret-looking value inside a record's data even at multi-thousand-record scale", async () => {
  // Defense in depth: `DiagnosticEvidence` is a generic transport contract,
  // not something only OpenCodeEvidenceCollector produces, so this function
  // cannot assume an incoming capture was already redacted. Per-record
  // redaction (this commit) must still catch a secret that slipped through
  // raw — and it must do so at the SAME multi-thousand-record scale that
  // used to blow the shared whole-blob budget before any redaction ran, so
  // this hand-builds ~3000 filler records (bypassing the collector, which
  // would redact at record time and prove nothing about this code path)
  // plus one record carrying a raw, unredacted secret.
  const records: Array<{
    seq: number;
    observedMs: number;
    kind: string;
    data: unknown;
  }> = [];
  for (let i = 0; i < 3000; i++) {
    records.push({
      seq: i + 1,
      observedMs: i,
      kind: "event",
      data: {
        type: "message.part.delta",
        properties: { delta: "x".repeat(50) },
      },
    });
  }
  records.push({
    seq: 3001,
    observedMs: 3001,
    kind: "event",
    data: { note: "Cookie: session=SYNTHETIC_UNREDACTED_SECRET_COOKIE" },
  });
  const redactedJson = JSON.stringify({
    schemaVersion: 1,
    sessionId: "s",
    attempt: 1,
    records,
  });
  const x = await setup(undefined, {
    diagnosticEvidence: {
      schema: "pr-hero.opencode-observations.v1",
      status: "complete",
      redactedJson,
    },
  });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  expect(e.captureDropped).toBeUndefined();
  expect(e.capture).toBeDefined();
  const captureFile = path.join(x.dir, e.capture.relativePath);
  const rawCaptureText = (await readFile(captureFile)).toString("utf8");
  expect(rawCaptureText).not.toContain("SYNTHETIC_UNREDACTED_SECRET_COOKIE");
  expect(rawCaptureText).toContain("[REDACTED HEADER]");
});
test("persistAttemptEvidence drops a well-schemed but non-wrapper capture with a specific reason", async () => {
  const redactedJson = JSON.stringify({ not: "a capture wrapper at all" });
  const x = await setup(undefined, {
    diagnosticEvidence: {
      schema: "pr-hero.opencode-observations.v1",
      status: "complete",
      redactedJson,
    },
  });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  expect(e.capture).toBeUndefined();
  expect(e.captureDropped).toBeDefined();
  expect(e.captureDropped.reason).toBe(
    "capture wrapper shape is not recognized",
  );
  expect(e.captureDropped.bytes).toBe(Buffer.byteLength(redactedJson));
});
test("persistAttemptEvidence records captureDropped with a reason and size when a capture is too large to persist", async () => {
  const oversized = "x".repeat(5 * 1024 * 1024);
  const redactedJson = JSON.stringify({
    schemaVersion: 1,
    sessionId: "s",
    attempt: 1,
    records: [{ seq: 1, observedMs: 0, kind: "event", data: oversized }],
  });
  const x = await setup(undefined, {
    diagnosticEvidence: {
      schema: "pr-hero.opencode-observations.v1",
      status: "complete",
      redactedJson,
    },
  });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  expect(e.capture).toBeUndefined();
  expect(e.captureDropped).toBeDefined();
  expect(typeof e.captureDropped.reason).toBe("string");
  expect(e.captureDropped.reason.length).toBeGreaterThan(0);
  expect(e.captureDropped.bytes).toBe(Buffer.byteLength(redactedJson));
});
// PR #228 review, F003 (WARNING): `persistAttemptEvidence` checked
// `capture.redactedJson` (COMPACT JSON) against the 4 MiB persist cap, but
// `writeJsonAtomically` then pretty-printed the redacted `safe` object
// unconditionally — `JSON.stringify(value, null, 2)`'s per-level indentation
// and newlines inflate a multi-thousand-record array well past what was
// checked. A live capture was observed persisted at 4.9 MB, and
// `readEvidenceFile` (used by scripts/martian-evidence.ts) enforces a
// SEPARATE 5 MiB read bound, so a capture that just barely passed the 4 MiB
// check could still land past that too. 15000 records of a realistic
// message.part.delta shape, sized so the collector's OWN byte cap (its F001
// invariant) leaves the compact snapshot just 288 bytes under 4 MiB, is
// deterministic and reproduces the real gap: pretty-printing this exact
// snapshot lands at ~4.96 MB, comfortably past both bounds.
test("a capture whose compact JSON is just under the persist cap survives persistence and stays readable by readEvidenceFile (F003)", async () => {
  const collector = new OpenCodeEvidenceCollector({
    sessionId: "s",
    attempt: 1,
  });
  for (let i = 0; i < 15000; i++) {
    collector.record("event", {
      type: "message.part.delta",
      properties: { delta: "x".repeat(380) },
    });
  }
  const diagnosticEvidence = collector.snapshot();
  const sourceBytes = Buffer.byteLength(diagnosticEvidence.redactedJson);
  // The collector's own invariant (#228 F001) already guarantees this; it
  // is the near-cap starting point this fix must survive, not what is
  // under test here.
  expect(sourceBytes).toBeLessThanOrEqual(4 * 1024 * 1024);

  const x = await setup(undefined, { diagnosticEvidence });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  expect(e.captureDropped).toBeUndefined();
  expect(e.capture).toBeDefined();
  const captureFile = path.join(x.dir, e.capture.relativePath);
  const persisted = await readFile(captureFile);
  expect(persisted.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(evidenceSha256(persisted)).toBe(e.capture.sha256);

  // readEvidenceFile's SEPARATE 5 MiB read bound must not reject this file.
  const read = await readEvidenceFile(x.dir, e.capture.relativePath);
  expect((read.value as { records: unknown[] }).records.length).toBeGreaterThan(
    0,
  );
});
// The other half of the same gap: redaction itself can GROW a record (a
// short secret-looking value like `password: "x"` becomes the fixed
// `"[REDACTED]"` marker, longer than what it replaced), so checking only
// the PRE-redaction size is not enough either. 40936 records of
// `password: "x"` are sized so the ORIGINAL compact JSON sits 53 bytes
// under the 4 MiB cap (passing the old, still-present pre-redaction gate)
// while the REDACTED compact JSON lands at ~4.56 MB — comfortably over.
test("a capture whose redacted output grows past the cap is dropped with no dangling capture reference (F003)", async () => {
  const RECORD_COUNT = 40936;
  const records: Array<{
    seq: number;
    observedMs: number;
    kind: string;
    data: unknown;
  }> = [];
  for (let i = 0; i < RECORD_COUNT; i++) {
    records.push({
      seq: i + 1,
      observedMs: i,
      kind: "event",
      data: { note: "filler-record-payload", password: "x" },
    });
  }
  const redactedJson = JSON.stringify({
    schemaVersion: 1,
    sessionId: "s",
    attempt: 1,
    records,
  });
  const originalBytes = Buffer.byteLength(redactedJson);
  // Passes the existing PRE-redaction gate — this is not the #001-era bug.
  expect(originalBytes).toBeLessThanOrEqual(4 * 1024 * 1024);

  const x = await setup(undefined, {
    diagnosticEvidence: {
      schema: "pr-hero.opencode-observations.v1",
      status: "complete",
      redactedJson,
    },
  });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  expect(e.capture).toBeUndefined();
  expect(e.captureDropped).toBeDefined();
  expect(e.captureDropped.reason).toBe("capture exceeds the 4 MiB persist cap");
  expect(e.captureDropped.bytes).toBeGreaterThan(4 * 1024 * 1024);

  // No dangling capture file left behind for a capture never referenced.
  const captureFile = attemptEvidencePath(x.step.outPath, "hunter", 1).replace(
    /\.json$/,
    ".capture.json",
  );
  const exists = await readFile(captureFile)
    .then(() => true)
    .catch(() => false);
  expect(exists).toBe(false);
});
test("persistAttemptEvidence records captureDropped with a reason when a capture schema is not recognized", async () => {
  const x = await setup(undefined, {
    diagnosticEvidence: {
      schema: "not-a-recognized-schema",
      status: "complete",
      redactedJson: JSON.stringify({
        schemaVersion: 1,
        sessionId: "s",
        attempt: 1,
        records: [],
      }),
    },
  });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  expect(e.capture).toBeUndefined();
  expect(e.captureDropped).toBeDefined();
  expect(typeof e.captureDropped.reason).toBe("string");
  expect(e.captureDropped.reason.length).toBeGreaterThan(0);
});
test("persistAttemptEvidence records captureDropped with a reason when a capture payload cannot be parsed", async () => {
  const x = await setup(undefined, {
    diagnosticEvidence: {
      schema: "pr-hero.opencode-observations.v1",
      status: "complete",
      redactedJson: "not valid json{",
    },
  });
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  expect(e.capture).toBeUndefined();
  expect(e.captureDropped).toBeDefined();
  expect(typeof e.captureDropped.reason).toBe("string");
  expect(e.captureDropped.reason.length).toBeGreaterThan(0);
});
// #299: the request plan is the record of what the model was ALLOWED to do.
// It carried only a hash of the tool list, so after a run that skipped the
// code nobody could say, from the artifacts, whether tools had been on offer.
test("the request plan records the effective tool names beside their hash", async () => {
  const x = await setup();
  x.step.tools = ["Read", "Grep", "mcp__codegraph__codegraph_explore"];
  await x.harness.run(x.step);
  const e = await waitForEvidence(x.step);
  const planFile = attemptEvidencePath(x.step.outPath, x.step.name, 1).replace(
    /\.json$/,
    ".request.json",
  );
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  expect(plan.toolNames).toEqual([
    "Read",
    "Grep",
    "mcp__codegraph__codegraph_explore",
  ]);
  // Additive: the hash is still there and still agrees with the attempt record.
  expect(plan.toolsConfigSha256).toBe(e.identity.toolsConfigSha256);
  expect(e.requestPlan.sha256).toBe(evidenceSha256(await readFile(planFile)));
});

test("a tool-less step records an empty name list, not an absent one", async () => {
  const x = await setup();
  await x.harness.run(x.step);
  await waitForEvidence(x.step);
  const planFile = attemptEvidencePath(x.step.outPath, x.step.name, 1).replace(
    /\.json$/,
    ".request.json",
  );
  expect(JSON.parse(await readFile(planFile, "utf8")).toolNames).toEqual([]);
});

// #299: the effort is the other half of what a step was allowed to do. A hunter
// that returned a clean bill is read against the effort it ran at, and the CLI's
// implicit default (medium on the 5.5 family) is exactly what the artifacts could
// not show before.
test("the request plan records the requested effort and that it was applied", async () => {
  const x = await setup();
  (x.step as { effort?: string }).effort = "xhigh";
  await x.harness.run(x.step);
  await waitForEvidence(x.step);
  const planFile = attemptEvidencePath(x.step.outPath, x.step.name, 1).replace(
    /\.json$/,
    ".request.json",
  );
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  expect(plan.effort).toBe("xhigh");
  // The fixture's transport is `claude-code` (route.backend), where the flag exists.
  expect(plan.effortApplied).toBe(true);
});

// OpenCode has no `--effort`. The requested level is still recorded (it is the
// engine's intent, and the diff against what ran is the finding), but a reader
// must never be able to take "effort: xhigh" on that backend as a fact about the run.
test("the request plan says plainly when the backend could not apply the effort", async () => {
  const x = await setup();
  const request: TransportRequest = {
    sessionId: "effort-opencode-1",
    attempt: 1,
    route: {
      backend: "opencode",
      provider: "deepseek",
      modelFamily: "deepseek",
      modelSnapshot: "deepseek-v4",
    },
    executionModel: "deepseek-v4",
    systemPromptPath: x.step.systemPromptPath,
    systemPromptSha256: "deadbeef",
    userPrompt: "review",
    cwd: x.dir,
    tools: [],
    effort: "xhigh",
    isolation: {
      credentialProjectionId: "operator-env-fallback",
      env: {},
      syntheticHome: x.dir,
      syntheticConfigHome: x.dir,
      syntheticTmp: x.dir,
      verifiedBinaryPath: x.binary,
    },
  };
  const frozen = await freezeAttemptEvidenceIdentity(request, x.step);
  expect(frozen.requestPlan).toBeDefined();
  const planFile = attemptEvidencePath(x.step.outPath, x.step.name, 1).replace(
    /\.json$/,
    ".request.json",
  );
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  expect(plan.effort).toBe("xhigh");
  expect(plan.effortApplied).toBe(false);
});

// Martian Cal.com `dev-default` arm, 2026-10-25: every run was quarantined as
// "missing frozen request plan" although each `.request.json` was on disk.
// Parallel steps hash the ~274 MB claude binary synchronously, so one step's
// hash blocks the event loop past another step's 100 ms freeze timer, and the
// freeze returned before it recorded the pointer. The starver below blocks the
// loop on every timers phase, which reproduces that deterministically: the
// timer always fires before the plan write's I/O chain completes.
test("the evidence points at the request plan even when the freeze timer wins the race", async () => {
  const x = await setup();
  x.step.timeoutMs = 10000;
  const busyWait = (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {}
  };
  const starver = setInterval(() => busyWait(120), 0);
  try {
    await x.harness.run(x.step);
  } finally {
    clearInterval(starver);
  }
  const e = await waitForEvidence(x.step);
  const planFile = attemptEvidencePath(x.step.outPath, x.step.name, 1).replace(
    /\.json$/,
    ".request.json",
  );
  expect(e.requestPlan).toEqual({
    relativePath: path.basename(planFile),
    sha256: evidenceSha256(await readFile(planFile)),
  });
});
