import {
  evidenceSha256,
  readEvidenceFile,
} from "../src/execution/attempt-evidence";
import type { DiagnosticEvidence } from "../src/execution/contracts";
import { attemptEvidencePath } from "../src/execution/step-artifacts";
import { redactEvidence } from "../src/security/evidence-redaction";
import {
  classifyObservationEvidence,
  redactEvidenceText,
} from "../src/transports/opencode-evidence";
// LIVE probe & #5982 same-session witness protocol:
// Diagnoses Martian arm failures across model/variant matrices with short watchdogs
// and attributable delivery evidence (EQ1a). Distinguishes proved text loss,
// persisted-empty completions, and external rejections without exposing secrets.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { defaultEffortForRole } from "#model/catalog";
import type { ModelsConfig } from "#model/model-name";
import { buildResolvedRoutePlan } from "#model/routing";
import type { ResolvedModelRoute } from "../src/execution/contracts";
import type { ProductionRuntime } from "../src/production-runtime";
import {
  createProductionRuntime,
  prepareProductionAdmissionContext,
} from "../src/production-runtime";

export type WitnessClassification =
  | "demonstrated_reconstruction_defect"
  | "persisted_final_empty"
  | "external_rejection"
  | "inconclusive";

export interface SessionWitnessIdentities {
  runId: string;
  attemptId: string;
  sessionId: string;
  userMessageId: string;
  gitCommitSha: string;
  sdkVersion: string;
  serverVersion: string;
  route: { provider: string; modelSnapshot: string; modelVariant?: string };
  cwd: string;
  credentialCategory: string;
  sanitizedEndpoint: string;
}

export interface SessionWitnessRequestWire {
  sanitizedPath: string;
  sanitizedQuery: Record<string, string> | string;
  sanitizedBody: unknown;
  timestamps: { sentAt: number; receivedAt?: number };
  status?: number;
  error?: string;
}

export interface SessionWitnessEventObservation {
  timestamp: number;
  seq: number;
  eventType: string;
  partId?: string;
  textDelta?: string;
}

export interface SessionWitnessReadbackMessagePart {
  id: string;
  type: string;
  text?: string;
  callId?: string;
}

export interface SessionWitnessReadbackMessage {
  id: string;
  role: string;
  parentId?: string;
  finishStatus?: string;
  parts?: SessionWitnessReadbackMessagePart[];
  toolCalls?: unknown[];
  finalText?: string;
}

export interface SessionWitnessReadback {
  directory?: string;
  messages: SessionWitnessReadbackMessage[];
}

export interface SessionWitnessSettlement {
  status: string;
  readbackAttempts: number;
  arbiterTerminalReason?: string;
  abortRequested: boolean;
  abortAcknowledged?: boolean;
  abortConfirmed?: boolean;
  usageCompleteness: "complete" | "incomplete" | "uncertain";
}

export interface SessionWitness {
  capture?: DiagnosticEvidence;
  identities: SessionWitnessIdentities;
  requestWire: SessionWitnessRequestWire;
  events: SessionWitnessEventObservation[];
  readback?: SessionWitnessReadback | null;
  settlement: SessionWitnessSettlement;
}

export function sanitizeWitness<T>(value: T): T {
  try {
    return redactEvidence(value) as T;
  } catch {
    return { captureStatus: "unavailable" } as T;
  }
}

export function classifyWitnessEvidence(
  witness: SessionWitness,
  reconstructedLocalText: string,
): WitnessClassification {
  return classifyObservationEvidence(witness.capture, reconstructedLocalText);
}

interface ArmDef {
  id: string;
  note: string;
  // The `models` the probe step runs on; absent runs the Claude control.
  models: ModelsConfig | undefined;
  parallel?: number;
}

interface RepResult {
  arm: string;
  rep: number;
  leg?: number;
  outcome:
    | "ok"
    | "timeout"
    | "instant-error"
    | "other-error"
    | "admission-error";
  classification: WitnessClassification;
  ms: number;
  attempts: number;
  cost_usd_est: number;
  stderrTail: string;
}

if (import.meta.main) {
  // The probe step has no hunter role of its own, so each arm sets `default`.
  // An effort is the OpenCode variant (S7), sent as the route's modelVariant.
  const armModels = (
    model: string,
    effort?: string,
    provider = "opencode-go",
  ): ModelsConfig => ({
    default: [
      effort === undefined
        ? `opencode:${provider}/${model}`
        : { model: `opencode:${provider}/${model}`, effort },
    ],
  });

  const ARMS: ArmDef[] = [
    { id: "A", note: "claude-code sonnet (control)", models: undefined },
    {
      id: "B",
      note: "deepseek-flash, effort high",
      models: armModels("deepseek-flash", "high"),
    },
    { id: "C", note: "deepseek-flash", models: armModels("deepseek-flash") },
    {
      id: "D",
      note: "glm-5.3-flash, effort high",
      models: armModels("glm-5.3-flash", "high"),
    },
    {
      id: "E",
      note: "glm-5.3-flash, effort low",
      models: armModels("glm-5.3-flash", "low"),
    },
    {
      id: "F",
      note: "B x3 parallel",
      models: armModels("deepseek-flash", "high"),
      parallel: 3,
    },
    {
      id: "G",
      note: "direct deepseek-flash",
      models: armModels("deepseek-flash", undefined, "deepseek"),
    },
  ];

  const flag = (n: string) => {
    const i = Bun.argv.indexOf(n);
    return i >= 0 ? Bun.argv[i + 1] : undefined;
  };
  const only = new Set(
    (flag("--only") ?? "A,B,C,D,E,F,G")
      .split(",")
      .map((s) => s.trim().toUpperCase()),
  );
  const reps = Number(flag("--reps") ?? "3");
  const timeoutSec = Number(flag("--timeout") ?? "120");
  const padKb = Number(flag("--pad-kb") ?? "0");
  const systemFile = flag("--system-file");
  const userFile = flag("--user-file");
  const stepCwd = flag("--cwd");
  const workspaceRoot =
    flag("--workspace-root") ??
    mkdtempSync(path.join(tmpdir(), "prhero-prompt-probe-"));
  const assertNonEmpty = Bun.argv.includes("--assert-nonempty");
  const hunterTools = Bun.argv.includes("--hunter-tools");
  const HUNTER_TOOLS = [
    "Read",
    "Grep",
    "Glob",
    "mcp__codegraph__codegraph_explore",
  ];
  const results: RepResult[] = [];

  function classify(
    status: string,
    stderr: string,
  ): "ok" | "timeout" | "instant-error" | "other-error" {
    if (status === "ok") return "ok";
    if (stderr.includes("timed out")) return "timeout";
    if (stderr.includes("session.prompt failed")) return "instant-error";
    return "other-error";
  }

  async function makeRuntime(
    arm: ArmDef,
  ): Promise<
    | { error: string }
    | { runtime: ProductionRuntime; route: ResolvedModelRoute }
  > {
    const plan = buildResolvedRoutePlan({
      agents: [{ key: "probe", role: "hunter" }],
      // A CLI model outranks `models`, so only the control arm passes one.
      ...(arm.models === undefined
        ? { cliModel: "sonnet" }
        : { models: arm.models }),
    });
    const admission = await prepareProductionAdmissionContext({
      workspaceRoot,
      plan,
    });
    if ("error" in admission)
      return { error: admission.error ?? "admission failed" };
    const runtime = await createProductionRuntime({
      ...admission.authorityOptions,
      plan,
      workspaceRoot,
      registry: admission.registry,
      evidence: admission.evidence,
      ...(admission.freeModelProbe === undefined
        ? {}
        : { freeModelProbe: admission.freeModelProbe }),
      mode: "production",
    });
    const route = plan.steps[0]?.route;
    if (route === undefined) {
      await runtime.dispose();
      return { error: "plan has no steps" };
    }
    return { runtime, route };
  }

  async function runLeg(
    arm: ArmDef,
    rep: number,
    leg: number | undefined,
    shared: { runtime: ProductionRuntime; route: ResolvedModelRoute },
  ) {
    const started = performance.now();
    const dir = mkdtempSync(
      path.join(tmpdir(), `prhero-probe-${arm.id}-r${rep}-`),
    );
    const systemPromptPath = path.join(dir, "system.md");
    const mcpConfigPath = path.join(dir, "mcp.json");
    writeFileSync(
      systemPromptPath,
      systemFile !== undefined
        ? await Bun.file(systemFile).text()
        : 'When asked for output, reply with exactly this JSON object and nothing else: {"probe":"alive"}',
    );
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    chmodSync(systemPromptPath, 0o600);

    const userPrompt =
      userFile !== undefined
        ? await Bun.file(userFile).text()
        : padKb > 0
          ? `Reply with the output object now.\n${"FILLER ".repeat(padKb * 146)}`
          : "Reply with the output object now.";

    const result = await shared.runtime.runner.run({
      name: `probe-${arm.id}-r${rep}${leg === undefined ? "" : `-l${leg}`}`,
      systemPromptPath,
      prompt: userPrompt,
      tools: hunterTools ? HUNTER_TOOLS : [],
      mcpConfigPath,
      model: "sonnet",
      effort: defaultEffortForRole("hunter"),
      cwd: stepCwd ?? workspaceRoot,
      outPath: path.join(dir, "out.json"),
      timeoutMs: timeoutSec * 1000,
      maxAttempts: 1,
      parse: (finalText: string) => {
        if (assertNonEmpty && finalText.trim().length === 0) {
          throw new Error("probe: delivered text is empty");
        }
        return finalText;
      },
      route: shared.route,
    });

    const ms = Math.round(performance.now() - started);
    const outcome = classify(result.status, result.stderrTail);
    let capture: DiagnosticEvidence | undefined;
    let evidence: unknown;
    try {
      const file = attemptEvidencePath(
        path.join(dir, "out.json"),
        result.name,
        result.attempts,
      );
      const loaded = await readEvidenceFile(dir, path.relative(dir, file));
      evidence = loaded.value;
      const ref = (
        evidence as {
          capture?: {
            relativePath: string;
            schema: string;
            sha256: string;
            status: DiagnosticEvidence["status"];
          };
        }
      ).capture;
      if (ref) {
        const artifact = await readEvidenceFile(dir, ref.relativePath);
        if (evidenceSha256(artifact.bytes) === ref.sha256)
          capture = {
            schema: ref.schema,
            status: ref.status,
            redactedJson: JSON.stringify(artifact.value),
          };
      }
    } catch {
      /* Missing observation is unavailable, never a synthetic witness. */
    }
    const classification = classifyObservationEvidence(
      capture,
      result.resultText,
    );
    writeFileSync(
      path.join(dir, "witness.json"),
      `${JSON.stringify(
        sanitizeWitness({
          schemaVersion: 1,
          evidence: evidence ?? null,
          capture: capture ? JSON.parse(capture.redactedJson) : null,
          captureStatus: capture?.status ?? "unavailable",
          classification,
        }),
        null,
        2,
      )}\n`,
    );

    results.push({
      arm: arm.id,
      rep,
      ...(leg === undefined ? {} : { leg }),
      outcome,
      classification,
      ms,
      attempts: result.attempts,
      cost_usd_est: result.usage.cost_usd_est,
      stderrTail: redactEvidenceText(result.stderrTail).slice(-300),
    });

    console.error(
      `  [${arm.id} rep${rep}${leg === undefined ? "" : ` leg${leg}`}] ${outcome} (${classification}) attempts=${result.attempts} ${ms}ms $${result.usage.cost_usd_est.toFixed(4)} resultText=${result.resultText.length}ch`,
    );
  }

  for (const arm of ARMS) {
    if (!only.has(arm.id)) continue;
    console.error(
      `\n=== arm ${arm.id}: ${arm.note} (reps=${arm.parallel ? 1 : reps})`,
    );
    const started = performance.now();
    const made = await makeRuntime(arm);
    if ("error" in made) {
      results.push({
        arm: arm.id,
        rep: 1,
        outcome: "admission-error",
        classification: "inconclusive",
        ms: Math.round(performance.now() - started),
        attempts: 0,
        cost_usd_est: 0,
        stderrTail: redactEvidenceText(made.error).slice(-300),
      });
      console.error(
        `  [${arm.id}] admission-error: ${redactEvidenceText(made.error)}`,
      );
      continue;
    }
    try {
      if (arm.parallel !== undefined) {
        await Promise.all(
          Array.from({ length: arm.parallel }, (_, leg) =>
            runLeg(arm, 1, leg, made),
          ),
        );
      } else {
        for (let rep = 1; rep <= reps; rep++) {
          await runLeg(arm, rep, undefined, made);
        }
      }
    } finally {
      await made.runtime.dispose();
    }
  }

  console.log(
    JSON.stringify({ timeoutSec, reps, homedir: homedir(), results }, null, 2),
  );
  process.exit(0);
}
