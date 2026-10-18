import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { qualifyOpenCodeServer } from "../../src/transports/opencode-admission";

const identity = {
  sdkVersion: "1.18.25",
  serverVersion: "1.18.30",
  executablePath: "/unused",
  executableSha256: "test",
};
// Small deadlines and backoff keep the suite fast; the production defaults
// (2 s health, 4 s doc, 250/500 ms) are the same code path.
const FAST = { healthDeadlineMs: 20, docDeadlineMs: 40, backoffMs: [1, 1] };
const URL_BASE = "http://unused.invalid";

const healthy = () =>
  new Response(JSON.stringify({ healthy: true, version: "1.18.30" }));
const contract = async () =>
  new Response(
    await readFile(
      join(import.meta.dir, "../fixtures/opencode/qualified-openapi.json"),
      "utf8",
    ),
  );

// A request the server never answers: it settles only when its own signal does,
// which is exactly how a per-request deadline ends a stuck fetch.
function hang(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise<Response>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

const pathOf = (url: URL | RequestInfo) => new URL(String(url)).pathname;

describe("qualifyOpenCodeServer retries transport failures only", () => {
  test("a /doc deadline is retried and qualification then succeeds", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
      const path = pathOf(url);
      calls.push(path);
      if (path === "/doc" && calls.filter((p) => p === "/doc").length === 1)
        return hang(init);
      return path === "/doc" ? contract() : healthy();
    }) as typeof fetch;
    const result = await qualifyOpenCodeServer(
      URL_BASE,
      identity,
      undefined,
      fetcher,
      FAST,
    );
    expect(result.serverVersion).toBe("1.18.30");
    expect(calls).toEqual(["/global/health", "/doc", "/doc"]);
  });

  test("a 503 is retried and qualification then succeeds", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: URL | RequestInfo) => {
      const path = pathOf(url);
      calls.push(path);
      if (path === "/global/health" && calls.length === 1)
        return new Response("down", { status: 503 });
      return path === "/doc" ? contract() : healthy();
    }) as typeof fetch;
    await qualifyOpenCodeServer(URL_BASE, identity, undefined, fetcher, FAST);
    expect(calls).toEqual(["/global/health", "/global/health", "/doc"]);
  });

  test("three consecutive deadlines throw the deadline after exactly three attempts", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push(pathOf(url));
      return hang(init);
    }) as typeof fetch;
    await expect(
      qualifyOpenCodeServer(URL_BASE, identity, undefined, fetcher, FAST),
    ).rejects.toThrow("OpenCode health/doc deadline");
    expect(calls).toEqual([
      "/global/health",
      "/global/health",
      "/global/health",
    ]);
  });

  test("a version mismatch throws on the first attempt without retry", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: URL | RequestInfo) => {
      calls.push(pathOf(url));
      return new Response(JSON.stringify({ healthy: true, version: "9.9.9" }));
    }) as typeof fetch;
    await expect(
      qualifyOpenCodeServer(URL_BASE, identity, undefined, fetcher, FAST),
    ).rejects.toThrow("serving version");
    expect(calls).toEqual(["/global/health"]);
  });

  test("a caller abort stops immediately without retrying", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push(pathOf(url));
      controller.abort(new Error("caller stopped"));
      return hang(init);
    }) as typeof fetch;
    await expect(
      qualifyOpenCodeServer(
        URL_BASE,
        identity,
        controller.signal,
        fetcher,
        FAST,
      ),
    ).rejects.toThrow("caller stopped");
    expect(calls).toHaveLength(1);
  });

  test("a caller abort during the backoff ends the wait at once", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetcher = (async (url: URL | RequestInfo) => {
      calls.push(pathOf(url));
      // A 503 starts the backoff; the abort lands while it sleeps.
      setTimeout(() => controller.abort(new Error("caller stopped")), 5);
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const started = Date.now();
    await expect(
      qualifyOpenCodeServer(URL_BASE, identity, controller.signal, fetcher, {
        ...FAST,
        backoffMs: [5_000, 5_000],
      }),
    ).rejects.toThrow("caller stopped");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(1);
  });
});
