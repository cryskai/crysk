import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumedOpenCodeContractDigest,
  OPENCODE_CONSUMED_CONTRACT_SHA256,
  OpenCodeSdkUnavailableError,
  observeOpenCodeExecutable,
  qualifyOpenCodeServer,
} from "../../src/transports/opencode-admission";

const identity = {
  sdkVersion: "1.18.25",
  serverVersion: "1.18.30",
  executablePath: "/unused",
  executableSha256: "test",
};
test("independent pinned contract projects to the qualified consumed digest", async () => {
  const doc = JSON.parse(
    await readFile(
      join(import.meta.dir, "../fixtures/opencode/qualified-openapi.json"),
      "utf8",
    ),
  );
  expect(consumedOpenCodeContractDigest(doc)).toBe(
    OPENCODE_CONSUMED_CONTRACT_SHA256,
  );
  doc.components.schemas.Event.anyOf = [];
  expect(() => consumedOpenCodeContractDigest(doc)).toThrow("branch missing");
});
test("actual health and contract both required before qualification", async () => {
  const doc = await readFile(
    join(import.meta.dir, "../fixtures/opencode/qualified-openapi.json"),
    "utf8",
  );
  const calls: string[] = [];
  const fetcher = (async (url: URL | RequestInfo) => {
    calls.push(String(url));
    return new Response(
      String(url).endsWith("/doc")
        ? doc
        : JSON.stringify({ healthy: true, version: "1.18.30" }),
    );
  }) as typeof fetch;
  await qualifyOpenCodeServer(
    "http://unused.invalid",
    identity,
    undefined,
    fetcher,
  );
  expect(calls.map((url) => new URL(url).pathname)).toEqual([
    "/global/health",
    "/doc",
  ]);
  await expect(
    qualifyOpenCodeServer(
      "http://unused.invalid",
      identity,
      undefined,
      (async (_url: URL | RequestInfo) =>
        new Response(
          JSON.stringify({ healthy: true, version: "9.9.9" }),
        )) as typeof fetch,
    ),
  ).rejects.toThrow("serving version");
});
test("version observer rejects changed bytes before any spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prhero-version-"));
  try {
    const path = join(dir, "binary");
    await writeFile(path, "fake");
    await expect(
      observeOpenCodeExecutable(
        {
          absolutePath: path,
          verifiedExecutionPath: path,
          sha256: createHash("sha256").update("old").digest("hex"),
        },
        undefined,
        {
          spawn: (() => {
            throw new Error("must not spawn");
          }) as typeof Bun.spawn,
        },
      ),
    ).rejects.toThrow("changed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// fix/opencode-sdk-absent-degraded: a compiled binary run outside the source
// tree resolves no `@opencode-ai/sdk` at all (readInstalledOpenCodeSdkVersion
// returns undefined). That is a DIFFERENT fact from a genuinely mismatched
// pair (both versions present, one of them wrong) and must not throw the same
// "Unsupported observed OpenCode pair" message doctor.ts pattern-matches on.
function fakeSpawnReturningVersion(serverVersion: string): typeof Bun.spawn {
  return (() => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(serverVersion));
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

async function withVersionFixture(
  run: (path: string, sha256: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prhero-sdk-absent-"));
  try {
    const path = join(dir, "binary");
    await writeFile(path, "fake");
    await run(path, createHash("sha256").update("fake").digest("hex"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("observed SDK absence is not a version mismatch", () => {
  test("undefined SDK version throws OpenCodeSdkUnavailableError, not the unsupported-pair error", async () => {
    await withVersionFixture(async (path, sha256) => {
      let caught: unknown;
      try {
        await observeOpenCodeExecutable(
          { absolutePath: path, verifiedExecutionPath: path, sha256 },
          undefined,
          {
            spawn: fakeSpawnReturningVersion("1.18.30"),
            sdkVersion: async () => undefined,
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OpenCodeSdkUnavailableError);
      expect((caught as Error).message).not.toContain(
        "Unsupported observed OpenCode pair",
      );
      expect((caught as Error).message).toContain(
        "pr-hero upgrade --reconcile",
      );
      expect((caught as Error).message).toContain("@opencode-ai/sdk@1.18.25");
      expect((caught as Error).message).toContain("~/.crysk/node_modules");
      expect((caught as Error).message).not.toContain("/$bunfs");
      expect((caught as Error).message).not.toContain("undefined");
    });
  });

  test("empty/whitespace SDK version throws OpenCodeSdkUnavailableError, not the unsupported-pair error", async () => {
    await withVersionFixture(async (path, sha256) => {
      let caught: unknown;
      try {
        await observeOpenCodeExecutable(
          { absolutePath: path, verifiedExecutionPath: path, sha256 },
          undefined,
          {
            spawn: fakeSpawnReturningVersion("1.18.30"),
            sdkVersion: async () => "   ",
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OpenCodeSdkUnavailableError);
      expect((caught as Error).message).not.toContain(
        "Unsupported observed OpenCode pair",
      );
    });
  });

  test.each([
    ["1.18.24", "1.18.30"],
    ["1.18.25", "1.18.29"],
  ])(
    "a genuinely mismatched pair (sdk %s / server %s) keeps today's error, unchanged",
    async (sdkVersion, serverVersion) => {
      await withVersionFixture(async (path, sha256) => {
        let caught: unknown;
        try {
          await observeOpenCodeExecutable(
            { absolutePath: path, verifiedExecutionPath: path, sha256 },
            undefined,
            {
              spawn: fakeSpawnReturningVersion(serverVersion),
              sdkVersion: async () => sdkVersion,
            },
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).not.toBeInstanceOf(OpenCodeSdkUnavailableError);
        expect((caught as Error).message).toBe(
          `Unsupported observed OpenCode pair: ${sdkVersion}/${serverVersion}`,
        );
      });
    },
  );
});

test.each(["timeout", "bytes", "abort"])(
  "version observation bounds and terminates %s",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "prhero-version-bound-"));
    let killed = false;
    try {
      const path = join(dir, "binary");
      await writeFile(path, "fake");
      const ctrl = new AbortController();
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === "bytes") {
            controller.enqueue(new Uint8Array(4097));
            controller.close();
          }
        },
      });
      const spawn = (() => ({
        stdout,
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        exited: new Promise<number>(() => {}),
        kill() {
          killed = true;
        },
      })) as unknown as typeof Bun.spawn;
      const work = observeOpenCodeExecutable(
        {
          absolutePath: path,
          verifiedExecutionPath: path,
          sha256: createHash("sha256").update("fake").digest("hex"),
        },
        ctrl.signal,
        { spawn, timeoutMs: 10, sdkVersion: async () => "1.18.25" },
      );
      if (mode === "abort") setTimeout(() => ctrl.abort(), 5);
      await expect(work).rejects.toThrow();
      expect(killed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("Claude registry construction and acquisition never inspect OpenCode", async () => {
  const { createDefaultTransportRegistry } = await import(
    "../../src/transport-registry"
  );
  const { spyOn } = await import("bun:test");
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("unexpected CLI");
  });
  const which = spyOn(Bun, "which").mockImplementation(() => {
    throw new Error("unexpected PATH lookup");
  });
  try {
    const registry = createDefaultTransportRegistry();
    registry.get("claude-code");
    expect(spawn).not.toHaveBeenCalled();
    expect(which).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
    which.mockRestore();
  }
});

test.each(["valid", "wrong-version", "missing-doc", "wrong-cwd"])(
  "real SDK qualification and scoped requests: %s",
  async (mode) => {
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    const { createOpenCodeClient } = await import(
      "../../src/transports/opencode-client"
    );
    const doc = await readFile(
      join(import.meta.dir, "../fixtures/opencode/qualified-openapi.json"),
      "utf8",
    );
    const requests: Request[] = [];
    let promptId: string | undefined;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request.clone());
      const path = new URL(request.url).pathname;
      let data: unknown;
      if (path === "/global/health")
        data = {
          healthy: true,
          version: mode === "wrong-version" ? "9.9.9" : "1.18.30",
        };
      else if (path === "/doc")
        return new Response(doc, {
          status: mode === "missing-doc" ? 404 : 200,
        });
      else if (path === "/mcp") data = {};
      else if (path === "/session")
        data = {
          id: "ses_wire",
          directory: mode === "wrong-cwd" ? "/other" : "/tmp",
        };
      else if (path === "/event")
        return new Response("", {
          headers: { "content-type": "text/event-stream" },
        });
      else if (path === "/experimental/tool/ids") data = ["read", "write"];
      else if (path === "/session/status")
        data = { ses_wire: { type: "idle" } };
      else if (
        path === "/session/ses_wire/message" &&
        request.method === "POST"
      ) {
        promptId = (await request.json()).messageID;
        data = {};
      } else if (path === "/session/ses_wire/message")
        data = [
          {
            info: {
              id: "msg_final",
              role: "assistant",
              sessionID: "ses_wire",
              parentID: promptId,
              path: { cwd: "/tmp", root: "/tmp" },
              time: { completed: 1 },
              finish: "stop",
              cost: 0.1,
              tokens: { input: 1, output: 1 },
            },
            parts: [
              {
                id: "prt_final",
                sessionID: "ses_wire",
                messageID: "msg_final",
                type: "text",
                text: "FINAL",
              },
            ],
          },
        ];
      else data = true;
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createOpenCodeClient({
      loadSdk: async () => ({
        createOpencodeClient: (config) =>
          createOpencodeClient({ ...config, fetch: fetcher }),
      }),
      qualifyServer: (url, signal) =>
        qualifyOpenCodeServer(url, identity, signal, fetcher),
      model: { providerID: "openai", modelID: "model" },
      readSystemPrompt: async () => "system",
      launchServer: async () => ({
        url: "http://unused.invalid",
        pid: 1,
        close: async () => {},
      }),
    });
    try {
      const create = client.createSession({
        cwd: "/tmp",
        systemPromptPath: "/unused",
        userPrompt: "review",
        tools: ["Read"],
      });
      if (mode !== "valid") {
        await expect(create).rejects.toThrow();
        expect(
          requests.some(
            (request) =>
              request.method === "POST" &&
              new URL(request.url).pathname.endsWith("/message"),
          ),
        ).toBe(false);
        return;
      }
      const session = await create;
      for (let i = 0; i < 30; i++) await Promise.resolve();
      const result = await client.pollStatus(session);
      expect(promptId).toMatch(/^msg/);
      expect(result.kind).toBe("terminal");
      if (result.kind === "terminal") expect(result.finalText).toBe("FINAL");
      for (const request of requests.filter((request) =>
        [
          "/session",
          "/experimental/tool/ids",
          "/session/ses_wire/message",
        ].includes(new URL(request.url).pathname),
      ))
        expect(new URL(request.url).searchParams.get("directory")).toBe("/tmp");
      // #223: GET /session/status is scoped by `directory` exactly like the
      // requests above — it must carry the SAME one session.create used, or
      // it watches an instance that has never heard of this session.
      const statusRequests = requests.filter(
        (request) => new URL(request.url).pathname === "/session/status",
      );
      expect(statusRequests.length).toBeGreaterThan(0);
      for (const request of statusRequests)
        expect(new URL(request.url).searchParams.get("directory")).toBe("/tmp");
    } finally {
      await client.close();
    }
  },
);
