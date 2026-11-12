// Shared offline artifact authority for run/resume/judge. No CLI side effects.
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  type FindingsDocument,
  validateFindingsDocument,
} from "#review/findings";
import { type LocalConfig, localReviewSpec } from "#review/preflight";
import { type ParsedAgent, parseAgentSource } from "#review/prompt-set";
import {
  type ExecutionAttemptEvidence,
  evidenceSha256,
  readEvidenceFile,
} from "../../src/execution/attempt-evidence";
import type { ResolvedModelRoute } from "../../src/execution/contracts";
import { hasCapturedTerminal } from "../../src/transports/opencode-evidence";

export interface BenchmarkIdentity {
  schemaVersion: 1;
  fingerprint: string;
  requiredSteps: string[];
  pr: number;
  headSha: string;
  baseSha: string;
  routes: ResolvedModelRoute[];
  // The route plan's fingerprint, the one pipeline.json records as
  // `route_fingerprint` for the plan the run executed (S2). Absent on
  // identities frozen before it; those keep qualifying on step proofs alone.
  routeFingerprint?: string;
  runtime: Array<{
    backend: string;
    executableSha256: string;
    sdkVersion?: string;
    serverVersion?: string;
  }>;
}
export interface BenchmarkSchedule {
  schemaVersion: 1;
  arm: string;
  attempts: Array<{
    id: string;
    pr: number;
    replicate: number;
    directory: string;
    headSha: string;
    baseSha: string;
    identity?: BenchmarkIdentity;
  }>;
}
export function sameBenchmarkIdentity(
  a: BenchmarkIdentity,
  b: BenchmarkIdentity,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export async function freezeBenchmarkIdentity(input: {
  engineRoot: string;
  repo: string;
  agentsDir: string;
  gotchasPath: string;
  pr: number;
  headSha: string;
  baseSha: string;
  model?: string;
  hunterModel?: string;
  refuterModel?: string;
}): Promise<BenchmarkIdentity> {
  const { loadEffectiveConfig } = await import("#config/config");
  const loaded = await loadEffectiveConfig({
    root: input.repo,
    home: homedir(),
  });
  const names = localReviewSpec().agents.map((a) => a.file);
  const prompts = await Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(path.join(input.agentsDir, name), "utf8"),
    })),
  );
  // The routes the review will execute, built by the production plan builder
  // from the same inputs `crysk review` reads (S2, L47): the config's `models`,
  // the profile, the prompts' frontmatter and `--model`. Routes used to come
  // from the flags or the frontmatter with a `sonnet` fallback, so a run routed
  // through `models` froze the Claude identity. The fingerprint hashes these
  // routes (and the engine's files), so attempts frozen before this change no
  // longer match on resume and run again; judging still accepts them.
  const plan = await benchmarkRoutePlan({
    ...input,
    config: loaded.effective,
    sources: prompts,
  });
  const { planRoutes } = await import("#model/routing");
  const routes = planRoutes(plan).map((step) => step.route);
  const runtime: BenchmarkIdentity["runtime"] = [];
  for (const backend of new Set(routes.map((r) => r.backend))) {
    const binary = Bun.which(backend === "opencode" ? "opencode" : "claude");
    if (!binary) throw new Error(`missing ${backend} executable identity`);
    const executablePath = await realpath(binary);
    const executableSha256 = evidenceSha256(await readFile(executablePath));
    if (backend === "opencode") {
      const { observeOpenCodeExecutable } = await import(
        "../../src/transports/opencode-admission"
      );
      const { readInstalledOpenCodeSdkVersion } = await import(
        "../../src/transport-registry"
      );
      const observed = await observeOpenCodeExecutable(
        {
          absolutePath: executablePath,
          verifiedExecutionPath: executablePath,
          sha256: executableSha256,
        },
        undefined,
        { sdkVersion: readInstalledOpenCodeSdkVersion },
      );
      runtime.push({
        backend,
        executableSha256,
        sdkVersion: observed.sdkVersion,
        serverVersion: observed.serverVersion,
      });
    } else runtime.push({ backend, executableSha256 });
  }
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", input.engineRoot, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error("engine identity unavailable");
    return r.stdout.toString();
  };
  const files = git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const engineFiles = await Promise.all(
    files.map(async (file) => ({
      file,
      sha: evidenceSha256(
        await readFile(path.join(input.engineRoot, file)).catch(() =>
          Buffer.from("deleted"),
        ),
      ),
    })),
  );
  const fingerprint = evidenceSha256(
    JSON.stringify({
      input: { ...input, repo: await realpath(input.repo) },
      engineCommit: git("rev-parse", "HEAD").trim(),
      engineFiles,
      prompts,
      gotchas: await readFile(input.gotchasPath, "utf8"),
      config: loaded.effective,
      routes,
      runtime,
    }),
  );
  return {
    schemaVersion: 1,
    fingerprint,
    requiredSteps: localReviewSpec()
      .agents.filter((a) => a.role === "hunter" && a.trigger === undefined)
      .map((a) => `hunter-${a.key}`),
    pr: input.pr,
    headSha: input.headSha,
    baseSha: input.baseSha,
    routes,
    ...(plan.routeFingerprint === undefined
      ? {}
      : { routeFingerprint: plan.routeFingerprint }),
    runtime,
  };
}
// The route plan of the review martian-cal spawns (`review --agents <dir>
// --no-summary [--model m]`), through buildCliRoutePlan as review.ts builds it.
// `--hunter-model` / `--refuter-model` are not CLI flags (S5): they apply as a
// `models` layer over the config, one entry per hunter role and the refuter.
export async function benchmarkRoutePlan(input: {
  agentsDir: string;
  model?: string;
  hunterModel?: string;
  refuterModel?: string;
  config: LocalConfig;
  sources: Array<{ name: string; source: string }>;
}) {
  const { parseArgs, resolveMaterialityGate, resolveScout, resolveSummary } =
    await import("#review/preflight");
  const { validateReviewSpec } = await import("#review/spec");
  const { agentModelRole } = await import("#model/routing");
  const { modelNameFromAlias } = await import("#model/model-name");
  const { resolveProfile } = await import("#model/profiles");
  const { buildCliRoutePlan, isBundledAgentsDir } = await import(
    "#review/route-preflight"
  );
  const { options } = parseArgs([
    "review",
    "--agents",
    input.agentsDir,
    "--no-summary",
    ...(input.model === undefined ? [] : ["--model", input.model]),
  ]);
  const spec = validateReviewSpec(localReviewSpec());
  const agentFiles = new Map<string, ParsedAgent>();
  for (const agent of spec.agents) {
    const source = input.sources.find((p) => p.name === agent.file)?.source;
    if (source !== undefined)
      agentFiles.set(agent.key, parseAgentSource(source));
  }
  const overlay: Record<string, string[]> = {};
  for (const agent of spec.agents) {
    const role = agentModelRole(agent);
    const model =
      agent.role === "refuter" ? input.refuterModel : input.hunterModel;
    if (role !== undefined && model !== undefined)
      overlay[role] = [modelNameFromAlias(model).raw];
  }
  return buildCliRoutePlan({
    spec,
    options: { ...options, scout: resolveScout(options, input.config) },
    agentFiles,
    // martian-cal always passes `--agents`, so the set is a flag's, never the
    // bundled one, exactly as the review subprocess resolves it.
    bundledAgents: isBundledAgentsDir({ source: "flag" }),
    models:
      Object.keys(overlay).length === 0
        ? input.config.models
        : { ...input.config.models, ...overlay },
    summary: resolveSummary(options, input.config),
    // The profile the review subprocess resolves from the same config.
    profile: resolveProfile(input.config.profile),
    materialityEnabled: resolveMaterialityGate(input.config),
  });
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export async function loadQualifiedReview(
  root: string,
  expected?: BenchmarkIdentity,
): Promise<{
  qualified: boolean;
  reason?: string;
  doc?: FindingsDocument;
  costUsd?: number;
  knownCostUsd?: number;
  wallMs?: number;
}> {
  let knownCostUsd: number | undefined;
  let reportedCost: number | undefined;
  let reportedWall: number | undefined;
  try {
    const p = (await readEvidenceFile(root, "pipeline.json")).value as {
      usage_v2?: { completeness?: string; cashCostUsd?: number };
    };
    const u = p.usage_v2;
    if (
      typeof u?.cashCostUsd === "number" &&
      Number.isFinite(u.cashCostUsd) &&
      u.cashCostUsd >= 0
    ) {
      knownCostUsd = u.cashCostUsd;
      if (u.completeness === "complete") reportedCost = u.cashCostUsd;
    }
  } catch {}
  try {
    const identity = (await readEvidenceFile(root, "run-identity.json"))
      .value as BenchmarkIdentity;
    if (
      identity.schemaVersion !== 1 ||
      !hash(identity.fingerprint) ||
      !Array.isArray(identity.routes) ||
      !identity.routes.length ||
      !Array.isArray(identity.runtime) ||
      !identity.runtime.length
    )
      throw new Error("missing frozen identity");
    if (expected && !sameBenchmarkIdentity(identity, expected))
      throw new Error("frozen identity changed");
    const doc = validateFindingsDocument(
      (await readEvidenceFile(root, "findings.json")).value,
    );
    if (
      doc.run_status !== "complete" ||
      doc.sessionFailed === true ||
      doc.head_sha !== identity.headSha ||
      doc.base_sha !== identity.baseSha
    )
      throw new Error("incomplete or mismatched findings");
    const pipeline = (await readEvidenceFile(root, "pipeline.json")).value as {
      route_fingerprint?: string;
      steps?: Array<{
        name: string;
        status?: string;
        attempts?: number;
        outPath?: string;
        attemptEvidencePath?: string;
      }>;
      usage_v2?: {
        completeness?: string;
        cashCostUsd?: number;
        wallMs?: number;
      };
    };
    if (
      !Array.isArray(identity.requiredSteps) ||
      !identity.requiredSteps.length ||
      !Array.isArray(pipeline.steps) ||
      !pipeline.steps.length ||
      identity.requiredSteps.some(
        (name) => !pipeline.steps?.some((s) => s.name === name),
      )
    )
      throw new Error("missing expected steps");
    if (
      identity.routeFingerprint !== undefined &&
      pipeline.route_fingerprint !== identity.routeFingerprint
    )
      throw new Error("executed route plan differs from frozen identity");
    const names = new Set<string>();
    for (const step of pipeline.steps) {
      if (
        !step.name ||
        names.has(step.name) ||
        step.status !== "ok" ||
        !Number.isInteger(step.attempts) ||
        Number(step.attempts) < 1 ||
        !step.attemptEvidencePath
      )
        throw new Error("missing or incomplete step");
      names.add(step.name);
      const e = (await readEvidenceFile(root, step.attemptEvidencePath))
        .value as ExecutionAttemptEvidence;
      if (
        e.schemaVersion !== 1 ||
        e.stepName !== step.name ||
        e.attempt !== step.attempts ||
        !e.sessionId ||
        e.delivered !== true ||
        e.outcome?.completion !== "success" ||
        e.outcome.protocolIntegrity !== "verified" ||
        e.settlement?.sessionId !== e.sessionId ||
        e.settlement.attempt !== e.attempt ||
        e.settlement.outcome !== "completed"
      )
        throw new Error("invalid attributable step proof");
      if (!e.requestPlan) throw new Error("missing frozen request plan");
      const planArtifact = await readEvidenceFile(
        root,
        path.join(
          path.dirname(step.attemptEvidencePath),
          e.requestPlan.relativePath,
        ),
      );
      if (evidenceSha256(planArtifact.bytes) !== e.requestPlan.sha256)
        throw new Error("request plan digest mismatch");
      const plan = planArtifact.value as {
        schemaVersion: number;
        sessionId: string;
        attempt: number;
        stepName: string;
        systemPromptSha256: string;
        userPromptSha256: string;
        systemPromptPath: string;
        route: ResolvedModelRoute;
        toolsConfigSha256: string;
        executableSha256: string;
      };
      if (
        plan.schemaVersion !== 1 ||
        plan.sessionId !== e.sessionId ||
        plan.attempt !== e.attempt ||
        plan.stepName !== e.stepName ||
        plan.systemPromptSha256 !== e.identity.systemPromptSha256 ||
        plan.userPromptSha256 !== e.identity.userPromptSha256 ||
        plan.toolsConfigSha256 !== e.identity.toolsConfigSha256 ||
        plan.executableSha256 !== e.identity.executableSha256 ||
        JSON.stringify(plan.route) !== JSON.stringify(e.identity.route)
      )
        throw new Error("scheduled request identity mismatch");
      const system = await readEvidenceFile(
        root,
        path.join(
          path.dirname(step.attemptEvidencePath),
          plan.systemPromptPath,
        ),
        4 * 1024 * 1024,
        false,
      );
      // Compare actual frozen rendered prompt bytes, including the run nonce.
      if (evidenceSha256(system.bytes) !== plan.systemPromptSha256)
        throw new Error("system prompt digest mismatch");
      const proof = e.outcome.terminalProof;
      if (
        !proof?.eventId ||
        proof.providerStatus !== "completed" ||
        !Number.isFinite(Date.parse(proof.providerObservedAt))
      )
        throw new Error("missing observed terminal proof");
      if (
        !hash(e.identity?.systemPromptSha256) ||
        !hash(e.identity.userPromptSha256) ||
        !hash(e.identity.toolsConfigSha256) ||
        !hash(e.identity.canonicalCwdSha256) ||
        !hash(e.outputSha256) ||
        !identity.routes.some(
          (r) => JSON.stringify(r) === JSON.stringify(e.identity.route),
        )
      )
        throw new Error("step identity mismatch");
      const runtime = identity.runtime.find(
        (r) =>
          r.backend === e.identity.route.backend &&
          r.executableSha256 === e.identity.executableSha256,
      );
      if (!runtime) throw new Error("executable identity mismatch");
      // Step outPath predates portable provenance; derive the output under root,
      // rejecting absolute paths rather than trusting a producing machine's path.
      if (!e.outputPath || path.basename(e.outputPath) !== e.outputPath)
        throw new Error("missing delivered output reference");
      const relativeOutput = path.join(
        path.dirname(step.attemptEvidencePath),
        e.outputPath,
      );
      const artifact = await readEvidenceFile(root, relativeOutput);
      if (evidenceSha256(artifact.bytes) !== e.outputSha256)
        throw new Error("delivered output digest mismatch");
      if (e.identity.route.backend === "opencode") {
        const cap = e.capture;
        if (cap?.status !== "complete")
          throw new Error("incomplete OpenCode capture");
        const capPath = path.join(
          path.dirname(step.attemptEvidencePath),
          cap.relativePath,
        );
        const captured = await readEvidenceFile(root, capPath);
        if (evidenceSha256(captured.bytes) !== cap.sha256)
          throw new Error("capture digest mismatch");
        if (
          !hasCapturedTerminal(
            {
              schema: cap.schema,
              status: cap.status,
              redactedJson: JSON.stringify(captured.value),
            },
            proof.eventId,
            proof.providerObservedAt,
          )
        )
          throw new Error(
            "missing complete same-session wire and terminal witness",
          );
        const value = captured.value as {
          sessionId?: string;
          attempt?: number;
          records?: Array<{ kind: string; data: Record<string, unknown> }>;
        };
        if (
          value.sessionId !== e.sessionId ||
          value.attempt !== e.attempt ||
          !Array.isArray(value.records)
        )
          throw new Error("capture attempt mismatch");
        const serving = value.records.find(
          (r) => r.kind === "server_qualification",
        )?.data;
        if (
          !serving ||
          serving.serverVersion !== runtime.serverVersion ||
          !hash(serving.openApiDocumentSha256) ||
          !hash(serving.consumedContractSha256)
        )
          throw new Error("missing observed serving contract");
        const observed = value.records.find(
          (r) => r.kind === "runtime_identity",
        )?.data;
        if (
          observed?.sdkVersion !== runtime.sdkVersion ||
          observed?.serverVersion !== runtime.serverVersion ||
          observed?.executableSha256 !== runtime.executableSha256
        )
          throw new Error("runtime observation mismatch");
      }
    }
    const usage = pipeline.usage_v2;
    const costUsd =
      usage?.completeness === "complete" &&
      typeof usage.cashCostUsd === "number" &&
      Number.isFinite(usage.cashCostUsd) &&
      usage.cashCostUsd >= 0
        ? usage.cashCostUsd
        : undefined;
    const wallMs =
      typeof doc.telemetry.wall_ms === "number" &&
      Number.isFinite(doc.telemetry.wall_ms) &&
      doc.telemetry.wall_ms >= 0
        ? doc.telemetry.wall_ms
        : undefined;
    return { qualified: true, doc, costUsd, knownCostUsd, wallMs };
  } catch (error) {
    return {
      qualified: false,
      knownCostUsd,
      costUsd: reportedCost,
      wallMs: reportedWall,
      reason: error instanceof Error ? error.message : "invalid evidence",
    };
  }
}
export async function loadBenchmarkSchedule(
  root: string,
  arm: string,
): Promise<BenchmarkSchedule> {
  const value = (await readEvidenceFile(root, `schedule-${arm}.json`))
    .value as BenchmarkSchedule;
  if (
    value.schemaVersion !== 1 ||
    value.arm !== arm ||
    !Array.isArray(value.attempts)
  )
    throw new Error("invalid schedule");
  const ids = new Set<string>();
  const directories = new Set<string>();
  for (const a of value.attempts) {
    if (
      !a.id ||
      ids.has(a.id) ||
      !Number.isInteger(a.pr) ||
      a.pr < 1 ||
      !Number.isInteger(a.replicate) ||
      a.replicate < 1 ||
      !a.directory ||
      path.basename(a.directory) !== a.directory ||
      directories.has(a.directory)
    )
      throw new Error("invalid scheduled attempt");
    ids.add(a.id);
    directories.add(a.directory);
  }
  return value;
}
