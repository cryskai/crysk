import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadQualifiedReview } from "../benchmarks/martian/martian-evidence";
import { computeQualifiedBenchmarkMetrics } from "../benchmarks/martian/martian-judge";
import { OpenCodeEvidenceCollector } from "../src/transports/opencode-evidence";

test("legacy proofless complete findings never qualifies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prhero-bench-proof-"));
  await writeFile(
    path.join(root, "findings.json"),
    JSON.stringify({ run_status: "complete", findings: [] }),
  );
  expect((await loadQualifiedReview(root)).qualified).toBe(false);
});
test("all-unknown costs and wall time remain unknown, with visible coverage", () => {
  const metrics = computeQualifiedBenchmarkMetrics(
    [{ pr: 1, status: "complete" }],
    2,
  );
  expect(metrics.costPerComplete).toBeNull();
  expect(metrics.totalSpendUsd).toBeNull();
  expect(metrics.wallMsPerComplete).toBeNull();
  expect(metrics.unknownCostCount).toBe(1);
  expect(metrics.missing).toBe(1);
});

import type { BenchmarkIdentity } from "../benchmarks/martian/martian-evidence";
import { evidenceSha256 } from "../src/execution/attempt-evidence";
import type { ProviderTransport } from "../src/execution/contracts";
import { StepExecutionHarness } from "../src/execution/harness";
import { attemptEvidencePath } from "../src/execution/step-artifacts";

async function realAttemptFixture(
  backend: "claude-code" | "opencode" = "claude-code",
) {
  const root = await mkdtemp(path.join(tmpdir(), "prhero-qualified-bench-"));
  const binary = path.join(root, "binary");
  await writeFile(binary, "fixture-binary");
  await writeFile(path.join(root, "system.md"), "system");
  await writeFile(path.join(root, "mcp.json"), '{"mcpServers":{}}');
  const route = {
    backend,
    provider: backend === "opencode" ? "openai" : "anthropic",
    modelFamily: "claude",
    modelSnapshot: "sonnet",
  };
  const transport: ProviderTransport = {
    backend,
    defaultRoute: route,
    admissionIdentity: {
      executable: backend === "opencode" ? "opencode" : "claude",
      provider: route.provider,
    },
    cancellationSemantics:
      backend === "opencode" ? "provider-proof" : "process-exit",
    capabilities: async () => ({
      backend,
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
    execute: async (request) => {
      const c = new OpenCodeEvidenceCollector({
        sessionId: request.sessionId,
        attempt: request.attempt,
      });
      c.record("runtime_identity", {
        sdkVersion: "1.18.25",
        serverVersion: "1.18.30",
        executableSha256: evidenceSha256("fixture-binary"),
      });
      c.record("server_qualification", {
        serverVersion: "1.18.30",
        consumedContractSha256: "a".repeat(64),
        openApiDocumentSha256: "b".repeat(64),
      });
      c.record("session_identity", {
        sessionId: "s",
        userMessageId: "msg-user",
        cwd: root,
      });
      c.record("subscription_ready", { sessionId: "s" });
      c.record("http_request", {
        requestId: 1,
        method: "POST",
        url: "http://unused.invalid/session/s/message",
      });
      c.record("request_body", {
        requestId: 1,
        body: { messageID: "msg-user" },
      });
      c.record("http_response", { requestId: 1, status: 200 });
      c.record("readback", {
        sessionId: "s",
        cwd: root,
        coverage: "complete",
        messages: [
          {
            info: {
              id: "observed-exit",
              sessionID: "s",
              role: "assistant",
              parentID: "msg-user",
              path: { cwd: root },
              finish: "stop",
              time: { completed: Date.parse("2026-09-13T00:00:00.000Z") },
            },
            parts: [
              {
                id: "p",
                sessionID: "s",
                messageID: "observed-exit",
                type: "text",
                text: '{"findings":[]}',
              },
            ],
          },
        ],
      });
      return {
        ...(backend === "opencode" ? { diagnosticEvidence: c.snapshot() } : {}),
        completion: "success",
        protocolIntegrity: "verified",
        terminalProof: {
          eventId: "observed-exit",
          providerStatus: "completed",
          providerObservedAt: "2026-09-13T00:00:00.000Z",
          exitCode: 0,
        },
        usage: {
          wallMs: 1,
          tokens: {},
          completeness: "complete",
          billingMode: "subscription",
          costSource: "provider",
          cashCostUsd: 0,
        },
        finalText: '{"findings":[]}',
        stderrTail: "",
      };
    },
    classifyFailure: () => undefined,
  };
  const step = {
    name: "hunter",
    systemPromptPath: path.join(root, "system.md"),
    mcpConfigPath: path.join(root, "mcp.json"),
    prompt: "review",
    tools: [],
    model: "sonnet",
    effort: "high" as const,
    route,
    cwd: root,
    outPath: path.join(root, "out.json"),
    timeoutMs: 1000,
    maxAttempts: 1,
    parse: JSON.parse,
  };
  const result = await new StepExecutionHarness({
    transport,
    binaryPath: binary,
    spawnFn: (() => {
      throw Error("no spawn");
    }) as typeof Bun.spawn,
  }).run(step);
  expect(result.status).toBe("ok");
  const identity: BenchmarkIdentity = {
    schemaVersion: 1,
    fingerprint: "a".repeat(64),
    requiredSteps: ["hunter"],
    pr: 14943,
    headSha: "head",
    baseSha: "base",
    routes: [route],
    routeFingerprint: "c".repeat(64),
    runtime: [
      {
        backend,
        ...(backend === "opencode"
          ? { sdkVersion: "1.18.25", serverVersion: "1.18.30" }
          : {}),
        executableSha256: evidenceSha256("fixture-binary"),
      },
    ],
  };
  const pipeline = {
    steps: [
      {
        name: "hunter",
        status: "ok",
        attempts: 1,
        outPath: step.outPath,
        attemptEvidencePath: path.relative(
          root,
          attemptEvidencePath(step.outPath, step.name, 1),
        ),
      },
    ],
    usage_v2: { completeness: "complete", cashCostUsd: 0 },
    route_fingerprint: "c".repeat(64),
  };
  await writeFile(path.join(root, "pipeline.json"), JSON.stringify(pipeline));
  await writeFile(
    path.join(root, "run-identity.json"),
    JSON.stringify(identity),
  );
  await writeFile(
    path.join(root, "findings.json"),
    JSON.stringify({
      schema_version: "1.0.0",
      pr: 14943,
      head_sha: "head",
      base_sha: "base",
      model: "sonnet",
      iteration: 1,
      parity_hunter_fired: false,
      run_status: "complete",
      telemetry: { wall_ms: 1 },
      findings: [],
      debug: { refuted: [] },
    }),
  );
  return { root, identity, pipeline, step };
}
test("actual harness proof qualifies schema-valid empty review; changed frozen identity and output do not", async () => {
  const x = await realAttemptFixture();
  const good = await loadQualifiedReview(x.root, x.identity);
  expect(good.reason).toBeUndefined();
  expect(good.qualified).toBe(true);
  expect(good.doc?.findings).toEqual([]);
  expect(
    (
      await loadQualifiedReview(x.root, {
        ...x.identity,
        fingerprint: "b".repeat(64),
      })
    ).qualified,
  ).toBe(false);
  await writeFile(x.step.outPath, '{"findings":["changed"]}');
  expect((await loadQualifiedReview(x.root, x.identity)).qualified).toBe(false);
});
// S2: the run must have executed the route plan its identity froze. A run
// whose pipeline.json records another plan fingerprint does not qualify, even
// when every step proof is otherwise intact.
test("a run that executed a different route plan than the frozen identity does not qualify", async () => {
  const x = await realAttemptFixture();
  await writeFile(
    path.join(x.root, "pipeline.json"),
    JSON.stringify({ ...x.pipeline, route_fingerprint: "d".repeat(64) }),
  );
  const result = await loadQualifiedReview(x.root, x.identity);
  expect(result.qualified).toBe(false);
  expect(result.reason).toBe(
    "executed route plan differs from frozen identity",
  );
  const { route_fingerprint: _, ...noPlan } = x.pipeline;
  await writeFile(path.join(x.root, "pipeline.json"), JSON.stringify(noPlan));
  expect((await loadQualifiedReview(x.root, x.identity)).reason).toBe(
    "executed route plan differs from frozen identity",
  );
});
// Identities frozen before S2 carry no plan fingerprint; already-scored
// attempts keep qualifying at judge time on their step proofs alone.
test("a legacy frozen identity without a route plan fingerprint still qualifies", async () => {
  const x = await realAttemptFixture();
  const { routeFingerprint: _, ...legacy } = x.identity;
  await writeFile(
    path.join(x.root, "run-identity.json"),
    JSON.stringify(legacy),
  );
  const result = await loadQualifiedReview(x.root, legacy as BenchmarkIdentity);
  expect(result.reason).toBeUndefined();
  expect(result.qualified).toBe(true);
});
test("untrusted evidence traversal, symlink escapes and oversized records fail closed", async () => {
  const x = await realAttemptFixture();
  const outside = await mkdtemp(path.join(tmpdir(), "prhero-outside-"));
  await writeFile(path.join(outside, "proof.json"), "{}");
  await symlink(
    path.join(outside, "proof.json"),
    path.join(x.root, "escape.json"),
  );
  for (const ref of ["../proof.json", "escape.json"]) {
    x.pipeline.steps[0].attemptEvidencePath = ref;
    await writeFile(
      path.join(x.root, "pipeline.json"),
      JSON.stringify(x.pipeline),
    );
    expect((await loadQualifiedReview(x.root, x.identity)).qualified).toBe(
      false,
    );
  }
  await writeFile(
    path.join(x.root, "huge.json"),
    " ".repeat(5 * 1024 * 1024 + 1),
  );
  x.pipeline.steps[0].attemptEvidencePath = "huge.json";
  await writeFile(
    path.join(x.root, "pipeline.json"),
    JSON.stringify(x.pipeline),
  );
  expect((await loadQualifiedReview(x.root, x.identity)).qualified).toBe(false);
});
test("actual judge CLI honors frozen selected denominator and includes valid empty without invoking a model", async () => {
  const x = await realAttemptFixture();
  const runs = await mkdtemp(path.join(tmpdir(), "prhero-judge-cli-"));
  const dir = "cal-14943-fixture";
  await import("node:fs/promises").then((fs) =>
    fs.rename(x.root, path.join(runs, dir)),
  );
  const schedule = {
    schemaVersion: 1,
    arm: "fixture",
    attempts: [
      {
        id: "fixture:14943:1",
        pr: 14943,
        replicate: 1,
        directory: dir,
        headSha: "head",
        baseSha: "base",
        identity: x.identity,
      },
      {
        id: "fixture:14943:2",
        pr: 14943,
        replicate: 2,
        directory: `${dir}-r2`,
        headSha: "head",
        baseSha: "base",
        identity: x.identity,
      },
    ],
  };
  await writeFile(
    path.join(runs, "schedule-fixture.json"),
    JSON.stringify(schedule),
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "../benchmarks/martian/martian-judge.ts"),
      "--runs",
      runs,
      "--arm",
      "fixture",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  expect({ code, stderr }).toMatchObject({ code: 0 });
  const report = await Bun.file(
    path.join(runs, "martian-judge-fixture.json"),
  ).json();
  expect(report.aggregate.completed).toBe(1);
  expect(report.aggregate.scheduled).toBe(2);
  expect(report.aggregate.missing).toBe(1);
  expect(report.aggregate.high_critical.precision).toBeUndefined();
  expect(report.aggregate.surfaces.surface_b).toContain("not run");
});

test("actual run CLI resumes only full matching proof, and preserves prior attempt when model identity changes", async () => {
  const x = await realAttemptFixture();
  const cases = await Bun.file(
    path.join(
      import.meta.dir,
      "../benchmarks/martian/corpora/martian-cal-cases.json",
    ),
  ).json();
  const row = cases.prs.find((r: { pr: number }) => r.pr === 14943);
  x.identity.headSha = row.headSha;
  x.identity.baseSha = row.baseSha;
  await writeFile(
    path.join(x.root, "run-identity.json"),
    JSON.stringify(x.identity),
  );
  const doc = await Bun.file(path.join(x.root, "findings.json")).json();
  doc.head_sha = row.headSha;
  doc.base_sha = row.baseSha;
  await writeFile(path.join(x.root, "findings.json"), JSON.stringify(doc));
  const runs = await mkdtemp(path.join(tmpdir(), "prhero-resume-cli-"));
  const dir = "cal-14943-fixture";
  await import("node:fs/promises").then((fs) =>
    fs.rename(x.root, path.join(runs, dir)),
  );
  const repo = path.join(runs, "repo");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  const preload = path.join(runs, "offline-preload.ts");
  const modulePath = path.join(
    import.meta.dir,
    "../benchmarks/martian/martian-evidence.ts",
  );
  await writeFile(
    preload,
    `import {mock} from 'bun:test';import * as real from ${JSON.stringify(modulePath)};const identity=${JSON.stringify(x.identity)};mock.module(${JSON.stringify(modulePath)},()=>({...real,freezeBenchmarkIdentity:async(input)=>({...identity,fingerprint:input.model==='changed'?'b'.repeat(64):identity.fingerprint})}));Bun.spawnSync=()=>({exitCode:0,stdout:Buffer.from(${JSON.stringify(row.headSha)}),stderr:Buffer.from('')});Bun.spawn=()=>{throw Error('OFFLINE: inference blocked')};globalThis.fetch=()=>{throw Error('OFFLINE: network blocked')};`,
  );
  const cli = path.join(
    import.meta.dir,
    "../benchmarks/martian/martian-cal.ts",
  );
  async function run(model?: string) {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        cli,
        "run",
        "--only",
        "14943",
        "--arm",
        "fixture",
        "--repo",
        repo,
        "--runs",
        runs,
        ...(model ? ["--model", model] : []),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    return {
      stderr: await new Response(proc.stderr).text(),
      code: await proc.exited,
    };
  }
  const matching = await run();
  expect(matching.stderr).toContain("SKIPPED, verified matching");
  expect(matching.code).toBe(0);
  const changed = await run("changed");
  expect(changed.code).not.toBe(0);
  expect(changed.stderr).not.toContain("SKIPPED");
  const archived = await import("node:fs/promises").then((fs) =>
    fs.readdir(path.join(runs, "incomplete-attempts")),
  );
  expect(archived).toHaveLength(1);
  expect(
    await Bun.file(
      path.join(runs, "incomplete-attempts", archived[0], "findings.json"),
    ).exists(),
  ).toBe(true);
});

test("missing scheduled hunter and altered frozen prompt cannot qualify", async () => {
  const x = await realAttemptFixture();
  x.identity.requiredSteps.push("hunter-missing");
  await writeFile(
    path.join(x.root, "run-identity.json"),
    JSON.stringify(x.identity),
  );
  expect((await loadQualifiedReview(x.root, x.identity)).qualified).toBe(false);
  x.identity.requiredSteps.pop();
  await writeFile(
    path.join(x.root, "run-identity.json"),
    JSON.stringify(x.identity),
  );
  await writeFile(x.step.systemPromptPath, "different prompt");
  expect((await loadQualifiedReview(x.root, x.identity)).qualified).toBe(false);
});

// The OpenCode route now comes from a model name (the routing config is gone,
// odd/tasks/role-model-routing.md S2), so the benchmark's `model` input says it.
test("positive OpenCode frozen identity supplies the actual installed SDK reader", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prhero-freeze-opencode-"));
  const agents = path.join(root, "agents");
  await mkdir(agents);
  const { localReviewSpec } = await import("#review/preflight");
  for (const a of localReviewSpec().agents)
    await writeFile(
      path.join(agents, a.file),
      `---\nname: ${a.key}\nmodel: sonnet\n---\nbody`,
    );
  await writeFile(path.join(root, "gotchas.md"), "gotchas");
  await writeFile(path.join(root, "binary"), "fixture");
  const modulePath = path.join(
    import.meta.dir,
    "../benchmarks/martian/martian-evidence.ts",
  );
  const script = path.join(root, "test.ts");
  await writeFile(
    script,
    `import {mock} from 'bun:test';import * as admission from ${JSON.stringify(path.join(import.meta.dir, "../src/transports/opencode-admission.ts"))};mock.module(${JSON.stringify(path.join(import.meta.dir, "../src/config/config.ts"))},()=>({loadEffectiveConfig:async()=>({effective:{}})}));mock.module(${JSON.stringify(path.join(import.meta.dir, "../src/transports/opencode-admission.ts"))},()=>({...admission,observeOpenCodeExecutable:async(executable,signal,deps)=>{const sdkVersion=await deps?.sdkVersion?.();if(sdkVersion!=='1.18.25')throw Error('SDK reader missing');return {sdkVersion,serverVersion:'1.18.30',executableSha256:executable.sha256};}}));Bun.which=()=>${JSON.stringify(path.join(root, "binary"))};Bun.spawnSync=(argv)=>({exitCode:0,stdout:Buffer.from(argv.includes('ls-files')?'':'fixture-head'),stderr:Buffer.from('')});Bun.spawn=()=>{throw Error('No inference')};globalThis.fetch=()=>{throw Error('No network')};const {freezeBenchmarkIdentity}=await import(${JSON.stringify(modulePath)});const result=await freezeBenchmarkIdentity(${JSON.stringify({ engineRoot: root, repo: root, agentsDir: agents, gotchasPath: path.join(root, "gotchas.md"), pr: 1, headSha: "head", baseSha: "base", model: "opencode:openai/model" })});console.log(JSON.stringify(result));`,
  );
  const proc = Bun.spawn([process.execPath, script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect({ code: await proc.exited, stderr }).toMatchObject({ code: 0 });
  const result = JSON.parse(stdout);
  expect(result.runtime[0].sdkVersion).toBe("1.18.25");
  expect(result.requiredSteps).toEqual([
    "hunter-reliability",
    "hunter-resilience",
    "hunter-logic",
  ]);
});

// L47 / S2: a benchmark that routes through the config's `models` must freeze
// the routes the review will execute, built by the production plan builder,
// never the prompts' `sonnet` frontmatter.
test("frozen identity routes come from the config's models, not the frontmatter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prhero-freeze-routed-"));
  const agents = path.join(root, "agents");
  await mkdir(agents);
  const { localReviewSpec } = await import("#review/preflight");
  for (const a of localReviewSpec().agents)
    await writeFile(
      path.join(agents, a.file),
      `---\nname: ${a.key}\nmodel: sonnet\n---\nbody`,
    );
  await writeFile(path.join(root, "gotchas.md"), "gotchas");
  await writeFile(path.join(root, "binary"), "fixture");
  const modulePath = path.join(
    import.meta.dir,
    "../benchmarks/martian/martian-evidence.ts",
  );
  const configPath = path.join(import.meta.dir, "../src/config/config.ts");
  const admissionPath = path.join(
    import.meta.dir,
    "../src/transports/opencode-admission.ts",
  );
  const input = {
    engineRoot: root,
    repo: root,
    agentsDir: agents,
    gotchasPath: path.join(root, "gotchas.md"),
    pr: 1,
    headSha: "head",
    baseSha: "base",
  };
  const script = path.join(root, "test.ts");
  await writeFile(
    script,
    `import {mock} from 'bun:test';import * as config from ${JSON.stringify(configPath)};import * as admission from ${JSON.stringify(admissionPath)};mock.module(${JSON.stringify(configPath)},()=>({...config,loadEffectiveConfig:async()=>({effective:{models:{default:['opencode:openai/gpt-x']}}})}));mock.module(${JSON.stringify(admissionPath)},()=>({...admission,observeOpenCodeExecutable:async(executable)=>({sdkVersion:'1.18.25',serverVersion:'1.18.30',executableSha256:executable.sha256})}));Bun.which=()=>${JSON.stringify(path.join(root, "binary"))};Bun.spawnSync=(argv)=>({exitCode:0,stdout:Buffer.from(argv.includes('ls-files')?'':'fixture-head'),stderr:Buffer.from('')});Bun.spawn=()=>{throw Error('No inference')};globalThis.fetch=()=>{throw Error('No network')};const {freezeBenchmarkIdentity}=await import(${JSON.stringify(modulePath)});const routed=await freezeBenchmarkIdentity(${JSON.stringify(input)});const split=await freezeBenchmarkIdentity(${JSON.stringify({ ...input, refuterModel: "opus" })});console.log(JSON.stringify({routed,split}));`,
  );
  const proc = Bun.spawn([process.execPath, script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect({ code: await proc.exited, stderr }).toMatchObject({ code: 0 });
  const { routed, split } = JSON.parse(stdout) as {
    routed: BenchmarkIdentity;
    split: BenchmarkIdentity;
  };
  expect(routed.routes.length).toBeGreaterThan(0);
  for (const route of routed.routes)
    expect(route).toMatchObject({
      backend: "opencode",
      provider: "openai",
      modelSnapshot: "gpt-x",
    });
  expect(routed.runtime.map((r) => r.backend)).toEqual(["opencode"]);
  expect(routed.routeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  // The per-role flag is a `models` layer over the config: the refuter moves
  // to opus while the hunters keep the configured route.
  expect(split.routeFingerprint).not.toBe(routed.routeFingerprint);
  expect(split.routes).toContainEqual(
    expect.objectContaining({ backend: "claude-code", provider: "anthropic" }),
  );
  expect(split.routes).toContainEqual(
    expect.objectContaining({ backend: "opencode", modelSnapshot: "gpt-x" }),
  );
});
test("OpenCode actual harness evidence requires complete attributable wire/readback capture, not only runtime labels", async () => {
  const x = await realAttemptFixture("opencode");
  const good = await loadQualifiedReview(x.root, x.identity);
  expect(good.reason).toBeUndefined();
  expect(good.qualified).toBe(true);
  const file = attemptEvidencePath(x.step.outPath, x.step.name, 1);
  const e = await Bun.file(file).json();
  const capPath = path.join(x.root, e.capture.relativePath);
  const cap = await Bun.file(capPath).json();
  cap.records = cap.records.filter(
    (r: { kind: string }) => r.kind !== "http_request",
  );
  await writeFile(capPath, JSON.stringify(cap));
  e.capture.sha256 = evidenceSha256(await Bun.file(capPath).bytes());
  await writeFile(file, JSON.stringify(e));
  expect((await loadQualifiedReview(x.root, x.identity)).qualified).toBe(false);
});
test("actual judge CLI reports a frozen zero-output schedule rather than dropping its denominator", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prhero-zero-output-"));
  await writeFile(
    path.join(root, "schedule-empty.json"),
    JSON.stringify({
      schemaVersion: 1,
      arm: "empty",
      attempts: [
        {
          id: "empty:14943:1",
          pr: 14943,
          replicate: 1,
          directory: "cal-14943-empty",
          headSha: "h",
          baseSha: "b",
        },
      ],
    }),
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "../benchmarks/martian/martian-judge.ts"),
      "--runs",
      root,
      "--arm",
      "empty",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  const report = await Bun.file(
    path.join(root, "martian-judge-empty.json"),
  ).json();
  expect(report.aggregate.completed).toBe(0);
  expect(report.aggregate.missing).toBe(1);
  expect(report.aggregate.scheduled).toBe(1);
  expect(report.aggregate.cost_per_complete).toBeNull();
});

async function judge(runs: string) {
  const preload = path.join(runs, "block.ts");
  await writeFile(
    preload,
    "Bun.spawn=()=>{throw Error('No model')};globalThis.fetch=()=>{throw Error('No network')};",
  );
  const p = Bun.spawn(
    [
      process.execPath,
      "--preload",
      preload,
      path.join(import.meta.dir, "../benchmarks/martian/martian-judge.ts"),
      "--runs",
      runs,
      "--arm",
      "independent",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  expect(await p.exited).toBe(0);
  return {
    report: await Bun.file(
      path.join(runs, "martian-judge-independent.json"),
    ).json(),
    stdout,
    stderr,
  };
}
async function schedule(
  runs: string,
  identity: BenchmarkIdentity | undefined,
  dir = "cal-14943-independent",
) {
  await writeFile(
    path.join(runs, "schedule-independent.json"),
    JSON.stringify({
      schemaVersion: 1,
      arm: "independent",
      attempts: [
        {
          id: "independent:14943:1",
          pr: 14943,
          replicate: 1,
          directory: dir,
          headSha: "head",
          baseSha: "base",
          identity,
        },
      ],
    }),
  );
}
test("actual judge keeps attempted no-findings failure spend and does not call it never attempted", async () => {
  const runs = await mkdtemp("/tmp/u7-failed-no-findings-");
  const dir = path.join(runs, "cal-14943-independent");
  await mkdir(dir);
  await writeFile(
    path.join(dir, "pipeline.json"),
    JSON.stringify({
      steps: [{ name: "hunter", status: "failed", attempts: 1 }],
      usage_v2: { completeness: "complete", cashCostUsd: 0.7 },
    }),
  );
  await schedule(runs, undefined);
  const { report } = await judge(runs);
  console.log("NO_FINDINGS_FAILURE", JSON.stringify(report.aggregate));
  expect(report.aggregate.known_spend_usd).toBe(0.7);
  expect(report.aggregate.attempted).toBe(1);
  expect(report.aggregate.partial).toBe(1);
  expect(report.aggregate.missing).toBe(0);
});
test("actual judge retains earlier paid failure preserved under incomplete-attempts", async () => {
  const x = await realAttemptFixture();
  const runs = await mkdtemp("/tmp/u7-archive-spend-");
  await (await import("node:fs/promises")).rename(
    x.root,
    path.join(runs, "cal-14943-independent"),
  );
  await schedule(runs, x.identity);
  const archive = path.join(
    runs,
    "incomplete-attempts",
    "cal-14943-independent-prior",
  );
  await mkdir(archive, { recursive: true });
  await writeFile(
    path.join(archive, "run-identity.json"),
    JSON.stringify(x.identity),
  );
  await writeFile(
    path.join(archive, "pipeline.json"),
    JSON.stringify({
      usage_v2: { completeness: "complete", cashCostUsd: 0.7 },
    }),
  );
  const { report } = await judge(runs);
  console.log("ARCHIVED_FAILURE_SPEND", report.aggregate.known_spend_usd);
  expect(report.aggregate.known_spend_usd).toBe(0.7);
});
test("actual judge keeps partial known spend from qualified completion", async () => {
  const x = await realAttemptFixture();
  x.pipeline.usage_v2 = { completeness: "partial", cashCostUsd: 0.7 };
  await writeFile(
    path.join(x.root, "pipeline.json"),
    JSON.stringify(x.pipeline),
  );
  const runs = await mkdtemp("/tmp/u7-partial-known-");
  await (await import("node:fs/promises")).rename(
    x.root,
    path.join(runs, "cal-14943-independent"),
  );
  await schedule(runs, x.identity);
  const { report } = await judge(runs);
  console.log(
    "COMPLETE_PARTIAL_KNOWN",
    report.aggregate.known_spend_usd,
    report.aggregate.total_cost_usd,
  );
  expect(report.aggregate.completed).toBe(1);
  expect(report.aggregate.known_spend_usd).toBe(0.7);
  expect(report.aggregate.total_cost_usd).toBeNull();
  expect(report.aggregate.unknown_cost_count).toBe(1);
});

// S2: the gate above is only sound if the plan the freeze builds is the plan
// the review subprocess builds. Build both offline, the review side through
// the production derivations review.ts uses on martian-cal's argv, and compare
// their fingerprints for no config, a routed `models` and `--model`.
test("frozen route plan fingerprint equals the one the review command builds", async () => {
  const { benchmarkRoutePlan } = await import(
    "../benchmarks/martian/martian-evidence"
  );
  const { loadRunConfig, resolvePromptSet } = await import("#review/run");
  const { parseArgs, resolveAgentsDirSetting, resolveMaterialityGate } =
    await import("#review/preflight");
  const { buildCliRoutePlan, isBundledAgentsDir } = await import(
    "#review/route-preflight"
  );
  const { resolveHomeDir } = await import("../src/brand-paths");
  const { readFile } = await import("node:fs/promises");
  const agentsDir = resolveAgentsDirSetting({ cwd: process.cwd() }).dir;
  const { localReviewSpec } = await import("#review/preflight");
  const sources = await Promise.all(
    localReviewSpec().agents.map(async (a) => ({
      name: a.file,
      source: await readFile(path.join(agentsDir, a.file), "utf8"),
    })),
  );
  const cases: Array<{ models?: Record<string, string[]>; model?: string }> = [
    {},
    { models: { default: ["opencode:openai/gpt-x"] } },
    { models: { default: ["opencode:openai/gpt-x"] }, model: "opus" },
  ];
  for (const c of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "prhero-freeze-parity-"));
    const home = await mkdtemp(path.join(tmpdir(), "prhero-freeze-home-"));
    if (c.models) {
      // `models` is a per-person key: it lives in the home config.
      await mkdir(resolveHomeDir(home), { recursive: true });
      await writeFile(
        path.join(resolveHomeDir(home), "config.json"),
        JSON.stringify({ models: c.models }),
      );
    }
    const argv = [
      "review",
      "--agents",
      agentsDir,
      "--no-summary",
      ...(c.model === undefined ? [] : ["--model", c.model]),
    ];
    let { options } = parseArgs(argv);
    const { loaded, config, summary, scout } = await loadRunConfig({
      root,
      home,
      configFlag: undefined,
      options,
      warn: () => {},
    });
    expect(config.models).toEqual(c.models);
    options = { ...options, scout };
    const { agents, spec, agentFiles } = await resolvePromptSet(
      options,
      loaded,
    );
    const review = await buildCliRoutePlan({
      spec,
      options,
      agentFiles,
      bundledAgents: isBundledAgentsDir(agents),
      models: config.models,
      summary,
      materialityEnabled: resolveMaterialityGate(config),
    });
    const frozen = await benchmarkRoutePlan({
      agentsDir,
      model: c.model,
      config,
      sources,
    });
    expect(frozen.routeFingerprint).toBe(review.routeFingerprint);
  }
});
