import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { StepSpec } from "#review/step-runner";
import {
  redactEvidence,
  redactEvidenceText,
} from "../security/evidence-redaction";
import { writeJsonAtomically } from "./atomic-write";
import type { TransportOutcome, TransportRequest } from "./contracts";
import type { SettlementReceipt } from "./settlement";
import { attemptEvidencePath } from "./step-artifacts";

export const evidenceSha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export interface ExecutionAttemptEvidence {
  schemaVersion: 1;
  sessionId: string;
  attempt: number;
  stepName: string;
  identity: {
    route: TransportRequest["route"];
    executionModel: string;
    systemPromptSha256: string;
    userPromptSha256: string;
    canonicalCwdSha256: string;
    toolsConfigSha256?: string;
    executableSha256?: string;
  };
  outcome?: Pick<
    TransportOutcome,
    "completion" | "protocolIntegrity" | "terminalProof" | "usage"
  >;
  settlement: SettlementReceipt;
  delivered: boolean;
  outputSha256?: string;
  outputPath?: string;
  requestPlan?: { relativePath: string; sha256: string };
  capture?: {
    schema: string;
    status: "complete" | "incomplete" | "unavailable";
    sha256: string;
    relativePath: string;
  };
  // A capture the transport actually produced but that this function could
  // not persist (too large, an unrecognized schema, or a parse/write
  // failure) is a diagnostic loss worth recording — silently proceeding
  // without either `capture` or this field left every one of a real
  // production run's failed steps with NO way to tell whether a capture was
  // ever taken. Set only when `outcome.diagnosticEvidence` was present and
  // `capture` above was not populated for it.
  captureDropped?: { reason: string; bytes?: number };
}
interface ParsedCaptureRecord {
  seq: number;
  observedMs: number;
  kind: string;
  data: unknown;
}
interface ParsedCaptureWrapper {
  schemaVersion: number;
  sessionId: string;
  attempt: number;
  records: ParsedCaptureRecord[];
}
/**
 * Parses and structurally validates a capture's `redactedJson` as the
 * `{schemaVersion, sessionId, attempt, records: [{seq, observedMs, kind,
 * data}]}` wrapper `OpenCodeEvidenceCollector.snapshot()` produces. Returns
 * `undefined` on a JSON parse failure OR any shape mismatch — both mean the
 * same thing to the caller: this is not a capture whose records can be
 * redacted one at a time, so it must not fall back to redacting whatever
 * WAS parsed as one undifferentiated blob.
 */
function parseCaptureWrapper(
  redactedJson: string,
): ParsedCaptureWrapper | undefined {
  let value: unknown;
  try {
    value = JSON.parse(redactedJson);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.schemaVersion !== "number" ||
    typeof v.sessionId !== "string" ||
    typeof v.attempt !== "number" ||
    !Number.isInteger(v.attempt) ||
    !Array.isArray(v.records)
  )
    return undefined;
  const records: ParsedCaptureRecord[] = [];
  for (const item of v.records) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return undefined;
    const r = item as Record<string, unknown>;
    if (
      typeof r.seq !== "number" ||
      typeof r.observedMs !== "number" ||
      typeof r.kind !== "string" ||
      !("data" in r)
    )
      return undefined;
    records.push({
      seq: r.seq,
      observedMs: r.observedMs,
      kind: r.kind,
      data: r.data,
    });
  }
  return {
    schemaVersion: v.schemaVersion,
    sessionId: v.sessionId,
    attempt: v.attempt,
    records,
  };
}
/** Diagnostic control-plane persistence. Failure never changes execution/billing. */
export async function persistAttemptEvidence(
  step: StepSpec,
  request: TransportRequest,
  execution: {
    outcome?: TransportOutcome;
    receipt: SettlementReceipt;
    delivery?: { delivered: boolean };
    frozenIdentity?: FrozenAttemptIdentity;
  },
): Promise<void> {
  const file = attemptEvidencePath(step.outPath, step.name, request.attempt);
  const outcome = execution.outcome;
  const evidence: ExecutionAttemptEvidence = {
    schemaVersion: 1,
    sessionId: request.sessionId,
    attempt: request.attempt,
    stepName: step.name,
    identity: {
      route: request.route,
      executionModel: request.executionModel,
      systemPromptSha256: request.systemPromptSha256,
      userPromptSha256: evidenceSha256(request.userPrompt),
      canonicalCwdSha256: evidenceSha256(request.cwd),
    },
    settlement: execution.receipt,
    delivered: execution.delivery?.delivered === true,
  };
  if (outcome)
    evidence.outcome = {
      completion: outcome.completion,
      protocolIntegrity: outcome.protocolIntegrity,
      ...(outcome.terminalProof
        ? { terminalProof: outcome.terminalProof }
        : {}),
      usage: outcome.usage,
    };
  if (execution.frozenIdentity) {
    const { requestPlan, pendingRequestPlan, ...identity } =
      execution.frozenIdentity;
    Object.assign(evidence.identity, identity);
    // The freeze may return before its plan write finished (see
    // freezeAttemptEvidenceIdentity). By settlement that write is long done,
    // so wait for it here instead of losing the pointer.
    const plan = requestPlan ?? (await pendingRequestPlan);
    if (plan) evidence.requestPlan = plan;
  }
  if (evidence.delivered) {
    evidence.outputSha256 = evidenceSha256(await readFile(step.outPath));
    evidence.outputPath = path.basename(step.outPath);
  }
  const capture = outcome?.diagnosticEvidence;
  if (capture) {
    const captureBytes = Buffer.byteLength(capture.redactedJson);
    if (captureBytes > 4 * 1024 * 1024) {
      evidence.captureDropped = {
        reason: "capture exceeds the 4 MiB persist cap",
        bytes: captureBytes,
      };
    } else if (!/^pr-hero\.[a-z0-9.-]+$/.test(capture.schema)) {
      evidence.captureDropped = {
        reason: `capture schema "${capture.schema}" is not recognized`,
        bytes: captureBytes,
      };
    } else {
      // WHY per-record, not whole-blob: `redactEvidence()` bounds its
      // traversal to one shared 20000-node / depth-12 budget
      // (src/security/evidence-redaction.ts:35-38). Redacting the entire
      // parsed capture in ONE call spends that whole budget across every
      // record combined, and a real multi-minute hunter stream's capture
      // has thousands of them — the budget blew every time, throwing
      // "capture shape limit" for every real production capture, not just
      // pathological ones. `OpenCodeEvidenceCollector.record()` already
      // redacts each record's `data` individually at record time, each
      // call getting its OWN fresh budget; redacting per record here again,
      // instead of once for the whole blob, keeps exactly that same
      // per-record bound rather than a shared one a few thousand records
      // exhausts together. Raising the shared budget instead would weaken
      // it for every OTHER caller of `redactEvidence`, so that decision is
      // left to a human call — this function works within the existing
      // bound rather than asking for a wider one.
      const wrapper = parseCaptureWrapper(capture.redactedJson);
      if (!wrapper) {
        evidence.captureDropped = {
          reason: "capture wrapper shape is not recognized",
          bytes: captureBytes,
        };
      } else {
        try {
          const safe = {
            schemaVersion: wrapper.schemaVersion,
            sessionId: wrapper.sessionId,
            attempt: wrapper.attempt,
            records: wrapper.records.map((r) => ({
              seq: r.seq,
              observedMs: r.observedMs,
              kind: redactEvidenceText(r.kind),
              data: redactEvidence(r.data),
            })),
          };
          // PR #228 review, F003: `writeJsonAtomically` used to
          // pretty-print unconditionally, so a capture whose ORIGINAL
          // (compact) `redactedJson` sat just under the 4 MiB check above
          // could still land ~20-30% larger on disk once indentation and
          // newlines were added — close enough to `readEvidenceFile`'s
          // separate 5 MiB read bound (attempt-evidence.ts) that a live
          // capture was observed persisted at 4.9 MB. Serialized here
          // once, compact, and checked as THIS exact string — not the
          // pre-redaction estimate above, since redaction can itself grow
          // or shrink a record's size — so the file is never written
          // unless the exact bytes about to hit disk already fit, and the
          // persisted size always equals the checked size.
          const compactRedacted = JSON.stringify(safe);
          const redactedBytes = Buffer.byteLength(compactRedacted);
          if (redactedBytes > 4 * 1024 * 1024) {
            evidence.captureDropped = {
              reason: "capture exceeds the 4 MiB persist cap",
              bytes: redactedBytes,
            };
          } else {
            const captureFile = file.replace(/\.json$/, ".capture.json");
            await mkdir(path.dirname(file), { recursive: true });
            await writeJsonAtomically(captureFile, safe, { compact: true });
            const bytes = await readFile(captureFile);
            evidence.capture = {
              schema: capture.schema,
              status: capture.status,
              sha256: evidenceSha256(bytes),
              relativePath: path.basename(captureFile),
            };
          }
        } catch (error) {
          // Qualification requires an actual usable capture, but a capture
          // that WAS produced and then lost to a redaction or write failure
          // is still a diagnostic loss worth recording, never a silent
          // no-op.
          evidence.captureDropped = {
            reason:
              error instanceof Error
                ? `capture persist failed: ${error.message}`
                : "capture persist failed",
            bytes: captureBytes,
          };
        }
      }
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomically(file, redactEvidence(evidence));
}
/** Untrusted artifact references cannot read outside their owned run root. */
export async function readEvidenceFile(
  root: string,
  relative: string,
  maxBytes = 5 * 1024 * 1024,
  parseJson = true,
): Promise<{ bytes: Uint8Array; value: unknown }> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
    throw new Error("unsafe evidence path");
  const base = await realpath(root);
  const file = await realpath(path.resolve(root, relative));
  if (!file.startsWith(`${base}${path.sep}`))
    throw new Error("evidence escapes run root");
  const handle = await import("node:fs/promises").then((fs) =>
    fs.open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    ),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("evidence is not a regular file");
    if (metadata.size > maxBytes) throw new Error("evidence exceeds bound");
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new Error("evidence exceeds bound");
    const bounded = bytes.subarray(0, bytesRead);
    return {
      bytes: bounded,
      value: parseJson ? JSON.parse(bounded.toString("utf8")) : undefined,
    };
  } finally {
    await handle.close();
  }
}

export interface FrozenAttemptIdentity {
  toolsConfigSha256?: string;
  executableSha256?: string;
  requestPlan?: { relativePath: string; sha256: string };
  /** The plan write when it outlived the freeze timer; never rejects. */
  pendingRequestPlan?: Promise<
    { relativePath: string; sha256: string } | undefined
  >;
}

export async function freezeAttemptEvidenceIdentity(
  request: TransportRequest,
  step: StepSpec,
): Promise<FrozenAttemptIdentity> {
  const frozen: {
    toolsConfigSha256?: string;
    executableSha256?: string;
    requestPlan?: { relativePath: string; sha256: string };
  } = {};
  try {
    frozen.toolsConfigSha256 = evidenceSha256(
      JSON.stringify({
        tools: request.tools,
        mcp: request.mcpConfigPath
          ? await readFile(request.mcpConfigPath, {
              encoding: "utf8",
              signal: AbortSignal.timeout(100),
            })
          : null,
      }),
    );
  } catch {}
  try {
    frozen.executableSha256 = evidenceSha256(
      await readFile(request.isolation.verifiedBinaryPath, {
        signal: AbortSignal.timeout(100),
      }),
    );
  } catch {}
  const file = attemptEvidencePath(
    step.outPath,
    step.name,
    request.attempt,
  ).replace(/\.json$/, ".request.json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The timer keeps the spawn from waiting on disk I/O, but losing the race
  // must not lose the pointer: parallel steps hash the ~274 MB claude binary
  // synchronously, and one step's hash can block the event loop past another
  // step's timer (Martian dev-default arm, 2026-10-25: every run quarantined
  // as "missing frozen request plan" with each plan file on disk). The write
  // keeps going and persistAttemptEvidence awaits it at settlement.
  const planWrite = (async () => {
    const plan = {
      schemaVersion: 1,
      sessionId: request.sessionId,
      attempt: request.attempt,
      stepName: step.name,
      route: request.route,
      systemPromptSha256: request.systemPromptSha256,
      userPromptSha256: evidenceSha256(request.userPrompt),
      systemPromptPath: path.relative(
        path.dirname(file),
        step.systemPromptPath,
      ),
      // #299: the NAMES behind `toolsConfigSha256`. The hash can only
      // confirm a list someone already has; when a hunter returned a clean
      // bill without opening the code, the first question is whether it
      // was ever offered tools, and a digest cannot answer it. Additive:
      // the hash stays, and the plan's readers compare fields by name.
      toolNames: [...request.tools],
      // #299: the effort the engine REQUESTED, and whether this backend
      // could apply it. The CLI's implicit default (medium on the 5.5
      // family) is what the artifacts could not show before. OpenCode has
      // no `--effort`, so there the level is intent only, and
      // `effortApplied: false` keeps a reader from taking it as a fact
      // about the run. Additive, and deliberately NOT in `identity` or the
      // route fingerprint: those are compared across runs by the lab.
      effort: request.effort,
      effortApplied: request.route.backend === "claude-code",
      ...frozen,
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomically(file, plan);
    frozen.requestPlan = {
      relativePath: path.basename(file),
      sha256: evidenceSha256(await readFile(file)),
    };
  })();
  try {
    await Promise.race([
      planWrite,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(100, Math.max(1, step.timeoutMs)));
      }),
    ]);
  } catch {
  } finally {
    clearTimeout(timer);
  }
  if (frozen.requestPlan) return { ...frozen };
  return {
    ...frozen,
    pendingRequestPlan: planWrite.then(
      () => frozen.requestPlan,
      () => undefined,
    ),
  };
}
