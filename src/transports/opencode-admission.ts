import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface OpenCodeObservedIdentity {
  readonly sdkVersion: string;
  readonly serverVersion: string;
  readonly executablePath: string;
  readonly executableSha256: string;
}

// Absence and mismatch are different FACTS with different consequences, so
// they get different error identities. A mismatch (both versions present,
// either one wrong) is an admission-policy violation: the exact-version gate
// is a threat model (CLAUDE.md rule 4), and admitOpenCodeVersionPair keeps
// refusing it exactly as before. Absence (no `@opencode-ai/sdk` resolvable at
// all — e.g. a `bun build --compile` binary run from a directory with no
// node_modules, which is every real user's repo) is not a policy violation:
// there is nothing to admit or refuse, the OpenCode route is simply
// unavailable here, and Claude-only routes are unaffected. Collapsing the two
// into one "Unsupported observed OpenCode pair: undefined/x.y.z" message is
// what made doctor report a Claude-only setup as blocking (see
// OpenCodeSdkUnavailableError's doctor-side handling).
export class OpenCodeSdkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeSdkUnavailableError";
  }
}

// ONE sentence for every "the SDK is not resolvable" throw: the loader and
// the admission absence check. A version literal, not an interpolated
// missing value — the operator-facing text must name the pin and must not
// print the word "undefined". The transport test locks this sentence to
// SUPPORTED_OPENCODE_SDK_VERSION so the two pins cannot drift.
export function openCodeSdkUnavailableMessage(): string {
  return (
    "@opencode-ai/sdk@1.18.25 is not installed under ~/.crysk/node_modules " +
    "(~/.prhero/node_modules on an install not yet migrated). " +
    "Run pr-hero upgrade --reconcile to install it."
  );
}

// The counterpart for "installed but the import itself failed" — a
// DIFFERENT fact from openCodeSdkUnavailableMessage above, which by this
// point in loadOpenCodeSdk is already known to be false (the version check
// just passed, so the package IS installed). Collapsing an import failure
// into "not installed" is what shipped a compiled binary reporting
// "@opencode-ai/sdk@1.18.25 is not installed" while it plainly was — the real
// cause, a `ResolveMessage: Cannot find package 'which'` from cross-spawn
// (nested inside the SDK's full /v2 index), was thrown away. This one
// interpolates the failed specifier and the caught error's own name+message
// on purpose: they are the only place the real cause still lives once this
// throws. It names no install location: the specifier already carries the
// real one, and ~/.crysk/node_modules (or a legacy ~/.prhero) is only where a COMPILED binary looks.
// The version is a literal for the same reason as the sentence above, and
// its transport test locks it to SUPPORTED_OPENCODE_SDK_VERSION the same way.
export function openCodeSdkLoadFailedMessage(
  specifier: string,
  error: unknown,
): string {
  const detail =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    `@opencode-ai/sdk@1.18.25 is installed but failed to load "${specifier}": ` +
    `${detail}. This is a load failure, not a missing install — that error ` +
    "is the real cause."
  );
}
export interface OpenCodeExecutableIdentity {
  readonly absolutePath: string;
  readonly verifiedExecutionPath: string;
  readonly sha256: string;
}
export type OpenCodeIdentityObserver = (
  executable: OpenCodeExecutableIdentity,
  signal?: AbortSignal,
) => Promise<OpenCodeObservedIdentity>;

// Independently derived from anomalyco/opencode tag v1.18.30, commit
// 3104c1428ec91f809e5ab86631300de41eb6952e, packages/sdk/openapi.json.
// Source SHA256 00502bd13e9c86f3ca9e765e99a57e06fa9f434ca16f2a714766d1444f8d37f3.
// Same consumed projection independently matches SDK 1.18.25. This is a
// qualification policy, never a digest manufactured from the running server.
export const OPENCODE_CONSUMED_CONTRACT_SHA256 =
  "0126721f557bfb0fcbeed3567392416394921d0c5d38798392608ffd8f63e95d";
const operations: Record<string, readonly string[]> = {
  "/global/health": ["get"],
  "/session": ["post"],
  "/session/{sessionID}/message": ["get", "post"],
  "/session/status": ["get"],
  "/session/{sessionID}/abort": ["post"],
  "/experimental/tool/ids": ["get"],
  "/mcp": ["get"],
  "/event": ["get"],
};
const events = [
  "EventMessageUpdated",
  "EventMessageRemoved",
  "EventMessagePartUpdated",
  "EventMessagePartRemoved",
  "EventMessagePartDelta",
  "EventSessionError",
  "EventSessionStatus",
  "EventSessionIdle",
  "EventServerConnected",
];
const annotations = new Set([
  "description",
  "summary",
  "title",
  "examples",
  "example",
  "x-codeSamples",
  "tags",
]);
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("OpenCode contract object missing");
  return value as Record<string, unknown>;
}
function normalize(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    const values = value.map((item) => normalize(item));
    return [
      "required",
      "enum",
      "anyOf",
      "oneOf",
      "allOf",
      "parameters",
    ].includes(key)
      ? values.sort((a, b) =>
          JSON.stringify(a) < JSON.stringify(b)
            ? -1
            : JSON.stringify(a) > JSON.stringify(b)
              ? 1
              : 0,
        )
      : values;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(record(value))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([name]) => key === "properties" || !annotations.has(name))
        .map(([name, item]) => [name, normalize(item, name)]),
    );
  }
  return value;
}
export function consumedOpenCodeContractDigest(document: unknown): string {
  const root = record(document);
  const allPaths = record(root.paths);
  const sourceSchemas = record(record(root.components).schemas);
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};
  for (const [path, methods] of Object.entries(operations)) {
    paths[path] = Object.fromEntries(
      methods.map((method) => {
        const operation = record(allPaths[path])[method];
        if (operation === undefined)
          throw new Error(`OpenCode contract lacks ${method} ${path}`);
        return [method, operation];
      }),
    );
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = record(value);
    if (typeof node.$ref === "string") {
      if (!node.$ref.startsWith("#/components/schemas/"))
        throw new Error("Unsupported OpenCode contract reference");
      const name = node.$ref.slice("#/components/schemas/".length);
      if (name in schemas) return;
      let schema = record(sourceSchemas[name]);
      if (name === "Event") {
        const branches = schema.anyOf;
        if (!Array.isArray(branches))
          throw new Error("OpenCode Event union unavailable");
        const refs = new Set(branches.map((branch) => record(branch).$ref));
        if (events.some((event) => !refs.has(`#/components/schemas/${event}`)))
          throw new Error("OpenCode consumed Event branch missing");
        schema = {
          anyOf: events.map((event) => ({
            $ref: `#/components/schemas/${event}`,
          })),
        };
      }
      schemas[name] = schema;
      visit(schema);
    } else for (const item of Object.values(node)) visit(item);
  };
  visit(paths);
  return createHash("sha256")
    .update(JSON.stringify(normalize({ paths, components: { schemas } })))
    .digest("hex");
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // The promise may have been constructed by the caller before cancellation.
  // Observe its rejection even when the pre-aborted branch wins immediately.
  void work.catch(() => {});
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () =>
          reject(signal.reason ?? new Error("OpenCode observation aborted"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function boundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await withAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new Error("OpenCode observation byte limit exceeded");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

export async function observeOpenCodeExecutable(
  executable: OpenCodeExecutableIdentity,
  signal?: AbortSignal,
  dependencies: {
    spawn?: typeof Bun.spawn;
    sdkVersion?: () => Promise<string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<OpenCodeObservedIdentity> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("OpenCode version observation deadline")),
    dependencies.timeoutMs ?? 2_000,
  );
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const kill = () => {
    try {
      proc?.kill("SIGKILL");
    } catch {}
  };
  controller.signal.addEventListener("abort", kill, { once: true });
  try {
    const bytes = await withAbort(
      readFile(executable.absolutePath, { signal: controller.signal }),
      controller.signal,
    );
    if (createHash("sha256").update(bytes).digest("hex") !== executable.sha256)
      throw new Error("OpenCode executable changed before version observation");
    controller.signal.throwIfAborted();
    proc = (dependencies.spawn ?? Bun.spawn)(
      [executable.verifiedExecutionPath, "--version"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {} },
    );
    const [stdout, , code] = await withAbort(
      Promise.all([
        boundedText(
          proc.stdout as ReadableStream<Uint8Array>,
          4096,
          controller.signal,
        ),
        boundedText(
          proc.stderr as ReadableStream<Uint8Array>,
          4096,
          controller.signal,
        ),
        proc.exited,
      ]),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const serverVersion = stdout.trim();
    if (code !== 0 || !/^\d+\.\d+\.\d+$/.test(serverVersion))
      throw new Error("OpenCode version observation malformed");
    const sdkVersion = await withAbort(
      Promise.resolve(dependencies.sdkVersion?.()),
      controller.signal,
    );
    // Absence check FIRST, and separate from the mismatch check below: a
    // missing/blank SDK version means "not resolvable here" (see
    // OpenCodeSdkUnavailableError above), not "resolvable but wrong". Folding
    // this into the mismatch branch is exactly what produced
    // "Unsupported observed OpenCode pair: undefined/1.18.30" for every
    // compiled-binary install and made doctor report it as blocking.
    if (typeof sdkVersion !== "string" || sdkVersion.trim() === "")
      throw new OpenCodeSdkUnavailableError(openCodeSdkUnavailableMessage());
    if (sdkVersion !== "1.18.25" || serverVersion !== "1.18.30")
      throw new Error(
        `Unsupported observed OpenCode pair: ${sdkVersion}/${serverVersion}`,
      );
    return Object.freeze({
      sdkVersion,
      serverVersion,
      executablePath: executable.absolutePath,
      executableSha256: executable.sha256,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", kill);
    controller.abort();
    kill();
    if (proc !== undefined) {
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          proc.exited.catch(() => {}),
          new Promise<void>((resolve) => {
            reapTimer = setTimeout(resolve, 100);
          }),
        ]);
      } finally {
        if (reapTimer !== undefined) clearTimeout(reapTimer);
      }
    }
  }
}

// Qualification runs right after the server's "listening" line, on a runner
// that may be cold or CPU-contended, so a single shared deadline turned a slow
// but healthy server into a failed session (~10 s in). Each request gets its
// own deadline, and only transport-level failures are retried.
const QUALIFY_HEALTH_DEADLINE_MS = 2_000;
const QUALIFY_DOC_DEADLINE_MS = 4_000;
const QUALIFY_ATTEMPTS = 3;
const QUALIFY_BACKOFF_MS = [250, 500] as const;
const QUALIFY_DEADLINE_MESSAGE = "OpenCode health/doc deadline";
const BYTE_LIMIT_MESSAGE = "OpenCode observation byte limit exceeded";

// The only error class qualification retries: a request deadline, a
// fetch/connection failure while sending or reading, or an HTTP status >= 500.
// Everything else (an unhealthy body, a version or contract mismatch, a 4xx,
// malformed JSON, the byte limit) is NOT transport and is never retried: those
// are the identity and contract facts the guard exists to refuse, and a retry
// would only re-ask a server that already answered.
class OpenCodeQualificationTransportError extends Error {
  override readonly name = "OpenCodeQualificationTransportError";
}

export interface OpenCodeQualificationOptions {
  readonly healthDeadlineMs?: number;
  readonly docDeadlineMs?: number;
  readonly backoffMs?: readonly number[];
}

export async function qualifyOpenCodeServer(
  url: string,
  expected: OpenCodeObservedIdentity,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  options: OpenCodeQualificationOptions = {},
): Promise<{
  serverVersion: string;
  consumedContractSha256: string;
  openApiDocumentSha256: string;
}> {
  signal?.throwIfAborted();
  const backoffMs = options.backoffMs ?? QUALIFY_BACKOFF_MS;

  // One request, one deadline. The deadline covers the body read too, because
  // a server that sends headers and then stalls is the same failure as one
  // that never answers.
  const attempt = async (
    path: string,
    deadlineMs: number,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      controller.abort(new Error(QUALIFY_DEADLINE_MESSAGE));
    }, deadlineMs);
    // A caller abort is never a transport failure: rethrow it so the retry
    // loop stops. A deadline or a connection error is retryable.
    const transport = (error: unknown): unknown => {
      if (signal?.aborted) return error;
      if (deadlineHit)
        return new OpenCodeQualificationTransportError(
          QUALIFY_DEADLINE_MESSAGE,
        );
      if (error instanceof Error && error.message === BYTE_LIMIT_MESSAGE)
        return error;
      return new OpenCodeQualificationTransportError(
        error instanceof Error ? error.message : String(error),
      );
    };
    try {
      let response: Response;
      try {
        response = await withAbort(
          fetcher(new URL(path, url), { signal: controller.signal }),
          controller.signal,
        );
      } catch (error) {
        throw transport(error);
      }
      if (!response.ok || response.body === null) {
        const message = `OpenCode qualification unavailable: ${path}`;
        throw response.status >= 500
          ? new OpenCodeQualificationTransportError(message)
          : new Error(message);
      }
      let text: string;
      try {
        text = await boundedText(
          response.body,
          2 * 1024 * 1024,
          controller.signal,
        );
      } catch (error) {
        throw transport(error);
      }
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  };

  const get = async (path: string, deadlineMs: number): Promise<unknown> => {
    for (let n = 1; ; n++) {
      try {
        return await attempt(path, deadlineMs);
      } catch (error) {
        if (
          signal?.aborted ||
          !(error instanceof OpenCodeQualificationTransportError) ||
          n >= QUALIFY_ATTEMPTS
        )
          throw error;
        // The backoff listens to the caller too: an abort ends the wait at
        // once instead of after the sleep.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(sleep);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const sleep = setTimeout(
            done,
            backoffMs[n - 1] ?? backoffMs.at(-1) ?? 0,
          );
          signal?.addEventListener("abort", done, { once: true });
        });
        signal?.throwIfAborted();
      }
    }
  };

  const health = record(
    await get(
      "/global/health",
      options.healthDeadlineMs ?? QUALIFY_HEALTH_DEADLINE_MS,
    ),
  );
  if (health.healthy !== true || health.version !== expected.serverVersion)
    throw new Error(
      "OpenCode serving version differs from observed executable",
    );
  const document = await get(
    "/doc",
    options.docDeadlineMs ?? QUALIFY_DOC_DEADLINE_MS,
  );
  const consumedContractSha256 = consumedOpenCodeContractDigest(document);
  if (
    expected.sdkVersion !== "1.18.25" ||
    expected.serverVersion !== "1.18.30" ||
    consumedContractSha256 !== OPENCODE_CONSUMED_CONTRACT_SHA256
  )
    throw new Error("OpenCode served contract is not qualified");
  return {
    serverVersion: String(health.version),
    consumedContractSha256,
    openApiDocumentSha256: createHash("sha256")
      .update(JSON.stringify(document))
      .digest("hex"),
  };
}
