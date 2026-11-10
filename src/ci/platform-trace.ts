// The action's trace step: send the platform the review's full trace, so every
// run on a platform-managed repository can be studied afterwards, the failed
// ones above all (odd/tasks/review-traces.md in the platform repository).
//
// It runs only in platform mode (action.yml gates the step on
// `workflow_dispatch`, a non-empty `dispatch-id` and a run token being present),
// under always(), after the report step and the cancelled-run refresh. A
// standalone run never reaches it, so it sends nothing anywhere.
//
// WHAT IT SENDS: the crysk.trace.v1 bundle src/ci/trace-bundle.ts builds from
// the run directory, gzip-compressed, to POST /runs/trace with the run token.
// Content (prompts, outputs, tool arguments and results, transcripts) goes only
// when the same exchange as the token said `trace_content` (CRYSK_TRACE_CONTENT
// is exactly `true`); otherwise metadata only.
//
// WHICH RUN DIRECTORY: the run step's `run_dir` output, else the run-dir record
// the CLI wrote into the outcome directory (src/ci/cli-record.ts recordRunDir).
// That output is empty when every hunter failed, on a fatal error and on a
// cancelled job, the runs a trace is most for. With neither, the trace is the
// run's root alone, built from cli.json.
//
// WHICH CODE: the one the publish step renders (decidePublication), from the
// same records, so the trace and the pull request name the same CRYSK-* code.
//
// WHY it never fails the job: tracing is best effort (S10). A 503 is retried
// once (the platform answers it when its storage failed and released the
// claim); any other failure is a `::warning::` and the step exits 0.
//
// BUILTINS ONLY: under always() this step can run when `bun install` never did.
// test/ci/platform-trace.test.ts walks the import closure.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  CLI_RECORD_FILE,
  type CliRecord,
  parseCliRecord,
  parseSetupRecord,
  parseTriggerRecord,
  RUN_DIR_FILE,
} from "./outcome";
import { PLATFORM_API_URL } from "./platform";
import { decidePublication } from "./publish";
import {
  encodeTrace,
  type TraceAttemptInput,
  type TraceOutcome,
  type TraceRunInput,
  type TraceStepInput,
} from "./trace-bundle";

// A 25 MB body over a slow link, but never the job's tail held for long.
const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_DELAY_MS = 2_000;
// The CLI's session copy stops at 64 MiB (claude-session-trace.ts); a prompt or
// an output file past this is not read.
const MAX_TRANSCRIPT_BYTES = 65 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const OUTCOMES = new Set<string>([
  "reviewed",
  "hunters-failed",
  "skipped",
  "yielded",
  "error",
]);

function readText(file: string, max: number): string | undefined {
  try {
    if (statSync(file).size > max) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(file: string): unknown {
  const text = readText(file, MAX_FILE_BYTES);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function mtimeMs(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The run step's output, else the CLI's record of it. The record is read only
// when it names this pull request's run directory (`pr-<n>-...`): the trigger
// clears it at job start, and this keeps a leftover from ever standing in.
export function locateRunDir(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const output = env.CRYSK_RUN_DIR ?? "";
  if (output !== "" && isDirectory(output)) return output;
  const outcomeDir = env.CRYSK_OUTCOME_DIR ?? "";
  if (outcomeDir === "") return undefined;
  const recorded = readText(path.join(outcomeDir, RUN_DIR_FILE), 4096)
    ?.split("\n")[0]
    ?.trim();
  if (recorded === undefined || !path.isAbsolute(recorded)) return undefined;
  const pr = env.TRIGGER_PR ?? "";
  if (pr === "" || !path.basename(recorded).startsWith(`pr-${pr}-`)) {
    return undefined;
  }
  return isDirectory(recorded) ? recorded : undefined;
}

const EVIDENCE = /^evidence\.(.+)\.attempt(\d+)\.json$/;
const CAPTURE = /^evidence\.(.+)\.attempt(\d+)\.capture\.json$/;
const TRANSCRIPT = /^trace\.(.+)\.attempt(\d+)\.jsonl$/;

// Every step the run directory holds files for: pipeline.json's steps, and any
// step whose evidence or transcript exists without a pipeline row (a run that
// stopped before it wrote pipeline.json).
export function readRunSteps(
  runDir: string,
  pipeline: unknown,
): TraceStepInput[] {
  const stepsDir = path.join(runDir, "steps");
  let names: string[] = [];
  try {
    names = readdirSync(stepsDir);
  } catch {
    names = [];
  }
  const steps = new Map<string, Map<number, TraceAttemptInput>>();
  const attemptOf = (step: string, n: number): TraceAttemptInput => {
    const attempts = steps.get(step) ?? new Map<number, TraceAttemptInput>();
    steps.set(step, attempts);
    const found = attempts.get(n) ?? { attempt: n };
    attempts.set(n, found);
    return found;
  };
  for (const name of names.sort()) {
    const file = path.join(stepsDir, name);
    const capture = CAPTURE.exec(name);
    if (capture?.[1] !== undefined) {
      const text = readText(file, MAX_TRANSCRIPT_BYTES);
      if (text !== undefined) {
        attemptOf(capture[1], Number(capture[2])).openCodeCapture = text;
      }
      continue;
    }
    const evidence = EVIDENCE.exec(name);
    if (evidence?.[1] !== undefined) {
      const parsed = readJson(file);
      if (parsed !== undefined) {
        attemptOf(evidence[1], Number(evidence[2])).evidence = parsed;
      }
      continue;
    }
    const transcript = TRANSCRIPT.exec(name);
    if (transcript?.[1] !== undefined) {
      const text = readText(file, MAX_TRANSCRIPT_BYTES);
      if (text !== undefined) {
        attemptOf(transcript[1], Number(transcript[2])).sessionJsonl = text;
      }
    }
  }
  const metas =
    isRecord(pipeline) && Array.isArray(pipeline.steps)
      ? pipeline.steps.filter(isRecord)
      : [];
  const allNames = [
    ...new Set([
      ...metas.map((meta) => String(meta.name)),
      ...[...steps.keys()].sort(),
    ]),
  ];
  return allNames.map((name) => {
    const meta = metas.find((item) => item.name === name);
    // pipeline.json names absolute paths of the runner that wrote them; the
    // files sit in steps/ under the same basename.
    const inSteps = (value: unknown, fallback: string) =>
      path.join(
        stepsDir,
        typeof value === "string" && value !== ""
          ? path.basename(value)
          : fallback,
      );
    const systemPrompt = readText(
      inSteps(meta?.systemPromptPath, `${name}.system.md`),
      MAX_FILE_BYTES,
    );
    const promptBody = readText(
      path.join(stepsDir, `${name}.body.md`),
      MAX_FILE_BYTES,
    );
    const output =
      typeof meta?.outPath === "string"
        ? readText(inSteps(meta.outPath, ""), MAX_FILE_BYTES)
        : undefined;
    return {
      name,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(promptBody === undefined ? {} : { promptBody }),
      ...(output === undefined ? {} : { output }),
      attempts: [...(steps.get(name)?.values() ?? [])],
    };
  });
}

interface OutcomeFacts {
  outcome: TraceOutcome;
  code: string | null;
  cli?: CliRecord;
  startedAtMs?: number;
}

// A cancelled job: job.status says so, or the cancelled-run refresh ran (it
// runs only on a cancel). The second signal is there because the job context's
// value inside a composite action is not documented.
function wasCancelled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const refresh = env.CRYSK_CANCEL_REFRESH ?? "";
  return (
    env.CRYSK_JOB_STATUS === "cancelled" ||
    (refresh !== "" && refresh !== "skipped")
  );
}

// The outcome from cli.json (a killed CLI that left `reviewing`, or none, is an
// error), and the code the publisher renders from the same records.
export function readOutcome(
  env: Readonly<Record<string, string | undefined>>,
): OutcomeFacts {
  const dir = env.CRYSK_OUTCOME_DIR ?? "";
  const triggerFile = path.join(dir, "trigger.json");
  const startedFile = path.join(dir, "cli-started");
  const startedAtMs =
    dir === "" ? undefined : (mtimeMs(startedFile) ?? mtimeMs(triggerFile));
  const timing = startedAtMs === undefined ? {} : { startedAtMs };
  if (wasCancelled(env)) {
    const cli =
      dir === ""
        ? undefined
        : parseCliRecord(
            readText(path.join(dir, CLI_RECORD_FILE), MAX_FILE_BYTES) ?? "",
          );
    return {
      outcome: "error",
      code: "CRYSK-CANCELLED",
      ...(cli === undefined ? {} : { cli }),
      ...timing,
    };
  }
  if (dir === "") return { outcome: "error", code: null };
  const record = parseTriggerRecord(
    readText(triggerFile, MAX_FILE_BYTES) ?? "",
  );
  const cliStarted = existsSync(startedFile);
  const cli = cliStarted
    ? parseCliRecord(
        readText(path.join(dir, CLI_RECORD_FILE), MAX_FILE_BYTES) ?? "",
      )
    : undefined;
  const setupText = readText(path.join(dir, "setup.json"), MAX_FILE_BYTES);
  const setup =
    setupText === undefined ? undefined : parseSetupRecord(setupText);
  const outcome: TraceOutcome =
    cli !== undefined && OUTCOMES.has(cli.outcome)
      ? (cli.outcome as TraceOutcome)
      : "error";
  let code: string | null = null;
  if (outcome === "error" || outcome === "hunters-failed") {
    const plan = decidePublication({
      record,
      cliStarted,
      ...(cli === undefined ? {} : { cliRecord: cli }),
      ...(setup === undefined ? {} : { setup }),
    });
    code =
      plan.kind === "remote" || plan.kind === "local"
        ? plan.rendered.code
        : null;
  }
  return { outcome, code, ...(cli === undefined ? {} : { cli }), ...timing };
}

// The engine that wrote the run's records, else the action's own package.json
// (CRYSK_ACTION_PATH, the step's github.action_path): a refusal before the review
// wrote anything still names its engine. Never derived from import.meta, which
// only src/assets.ts may do.
function engineVersion(
  env: Readonly<Record<string, string | undefined>>,
  ...docs: unknown[]
): string | undefined {
  for (const doc of docs) {
    if (isRecord(doc) && isRecord(doc.engine)) {
      const version = doc.engine.version;
      if (typeof version === "string" && version !== "") return version;
    }
  }
  const actionPath = env.CRYSK_ACTION_PATH ?? "";
  if (actionPath === "") return undefined;
  const pkg = readJson(path.join(actionPath, "package.json"));
  return isRecord(pkg) && typeof pkg.version === "string" && pkg.version !== ""
    ? pkg.version
    : undefined;
}

export function readTraceRun(
  env: Readonly<Record<string, string | undefined>>,
  now: number,
): TraceRunInput {
  const facts = readOutcome(env);
  const runDir = locateRunDir(env);
  const pipeline =
    runDir === undefined
      ? undefined
      : readJson(path.join(runDir, "pipeline.json"));
  const findings =
    runDir === undefined
      ? undefined
      : readJson(path.join(runDir, "findings.json"));
  const pr = Number(env.TRIGGER_PR ?? "");
  const head = [
    facts.cli?.head_sha,
    isRecord(findings) ? findings.head_sha : undefined,
    env.TRIGGER_HEAD_SHA,
  ].find((sha): sha is string => typeof sha === "string" && SHA.test(sha));
  const version = engineVersion(env, findings, pipeline);
  return {
    outcome: facts.outcome,
    code: facts.code,
    ...(facts.cli === undefined ? {} : { cli: facts.cli }),
    ...(pipeline === undefined ? {} : { pipeline }),
    ...(findings === undefined ? {} : { findings }),
    steps: runDir === undefined ? [] : readRunSteps(runDir, pipeline),
    ...(Number.isInteger(pr) && pr > 0 ? { prNumber: pr } : {}),
    ...(head === undefined ? {} : { headSha: head }),
    ...(version === undefined ? {} : { engineVersion: version }),
    startedAtMs: Math.min(facts.startedAtMs ?? now, now),
    endedAtMs: now,
  };
}

export type SendTraceResult =
  | { ok: true; recorded: boolean }
  // `message` names the HTTP status and the API's own `message`. It never
  // carries the token.
  | { ok: false; message: string };

export interface SendTraceDeps {
  fetch: typeof fetch;
  baseUrl: string;
  runToken: string;
  sleep: (ms: number) => Promise<void>;
}

async function apiMessage(response: Response): Promise<string | undefined> {
  try {
    const parsed = (await response.json()) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message !== ""
      ? parsed.message
      : undefined;
  } catch {
    return undefined;
  }
}

export async function sendTrace(
  deps: SendTraceDeps,
  body: Uint8Array,
): Promise<SendTraceResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await deps.fetch(`${deps.baseUrl}/runs/trace`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.runToken}`,
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
        // A copy over a plain ArrayBuffer, the body type fetch accepts.
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 503 && attempt === 1) {
        await response.body?.cancel().catch(() => undefined);
        await deps.sleep(RETRY_DELAY_MS);
        continue;
      }
      if (!response.ok) {
        const message = await apiMessage(response);
        return {
          ok: false,
          message: `HTTP ${response.status}${message === undefined ? "" : ` — ${message}`}`,
        };
      }
      const reply: unknown = await response.json().catch(() => ({}));
      return {
        ok: true,
        recorded: !(isRecord(reply) && reply.recorded === false),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: `the request could not complete: ${detail.split(deps.runToken).join("***")}`,
      };
    }
  }
}

function escapeCommandData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export interface TraceStepDeps {
  fetch: typeof fetch;
  env: Readonly<Record<string, string | undefined>>;
  baseUrl: string;
  stdout: (text: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// The step's shell. ALWAYS 0: see the header.
export async function runTraceStep(deps: TraceStepDeps): Promise<number> {
  const runToken = deps.env.CRYSK_RUN_TOKEN ?? "";
  const warn = (message: string): void =>
    deps.stdout(
      `::warning title=crysk::${escapeCommandData(`Crysk trace not uploaded: ${message}`)}\n`,
    );
  try {
    if (runToken === "") {
      warn("no run token reached this step.");
      return 0;
    }
    const content = deps.env.CRYSK_TRACE_CONTENT === "true";
    const run = readTraceRun(deps.env, (deps.now ?? Date.now)());
    const encoded = encodeTrace(run, content);
    if (!encoded.ok) {
      warn(
        `the trace is too large even without its content (${encoded.jsonBytes} bytes of JSON).`,
      );
      return 0;
    }
    const result = await sendTrace(
      {
        fetch: deps.fetch,
        baseUrl: deps.baseUrl,
        runToken,
        sleep:
          deps.sleep ??
          ((ms) => {
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, ms);
            return promise;
          }),
      },
      encoded.body,
    );
    if (!result.ok) {
      warn(result.message);
      return 0;
    }
    const dropped = [
      encoded.droppedTranscripts > 0
        ? `${encoded.droppedTranscripts} transcripts`
        : "",
      encoded.droppedContent ? "the content" : "",
    ].filter((part) => part !== "");
    deps.stdout(
      `Crysk trace ${result.recorded ? "recorded" : "sent (not recorded again)"}: ${Math.ceil(encoded.body.byteLength / 1024)} KB gzip${dropped.length > 0 ? `, without ${dropped.join(" and ")} to fit the size cap` : ""}.\n`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`the trace could not be built: ${detail.split(runToken).join("***")}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(
    await runTraceStep({
      fetch,
      env: process.env,
      baseUrl: PLATFORM_API_URL,
      stdout: (text) => process.stdout.write(text),
    }),
  );
}
