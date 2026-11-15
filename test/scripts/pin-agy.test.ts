// odd/tasks/antigravity-oauth.md T5 (S7, L22): the maintainer script that reads
// Google's auto-updater manifests and prints the pinned release to paste into
// src/ci/agy-install.ts. Offline: the manifests are an injected fetch.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AGY_PINNED_RELEASE,
  AGY_PLATFORM_KEYS,
  type AgyPlatformKey,
} from "#ci/agy-install";
import * as pin from "../../scripts/pin-agy";

const MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const SHA = (c: string) => c.repeat(128);

function manifests(
  overrides: Partial<Record<AgyPlatformKey, unknown>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [i, key] of AGY_PLATFORM_KEYS.entries()) {
    out[`${MANIFEST_BASE}/${key}.json`] = overrides[key] ?? {
      version: "2.0.1",
      url: `https://storage.googleapis.com/agy/2.0.1/${key}.tar.gz`,
      sha512: SHA("abcd"[i] as string),
    };
  }
  return out;
}

async function runScript(served: Record<string, unknown>, status = 200) {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await pin.runPinAgy({
    fetch: async (url: string) => {
      calls.push(url);
      const body = served[url];
      if (body === undefined) return new Response("", { status: 404 });
      return new Response(
        typeof body === "string" ? body : JSON.stringify(body),
        { status },
      );
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return {
    exitCode,
    calls,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

describe("scripts/pin-agy.ts", () => {
  test("reads the four manifests and prints the release table to paste", async () => {
    const run = await runScript(manifests());
    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual(
      AGY_PLATFORM_KEYS.map((key) => `${MANIFEST_BASE}/${key}.json`),
    );
    // Only the manifests: no archive is downloaded.
    expect(run.calls.every((url) => url.startsWith(MANIFEST_BASE))).toBe(true);
    expect(run.stdout).toContain('  version: "2.0.1",');
    expect(run.stdout).toContain(
      'url: "https://storage.googleapis.com/agy/2.0.1/darwin_arm64.tar.gz",',
    );
    expect(run.stdout).toContain(`"${SHA("c")}",`);
    expect(run.stderr).toBe("");
  });

  test("the table it prints for the pinned release is the one in the installer", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "../../src/ci/agy-install.ts"),
      "utf8",
    );
    expect(source).toContain(pin.renderAgyRelease(AGY_PINNED_RELEASE));
  });

  test("manifests that name different versions are refused, nothing printed", async () => {
    const run = await runScript(
      manifests({
        linux_arm64: {
          version: "2.0.0",
          url: "https://storage.googleapis.com/agy/2.0.0/x.tar.gz",
          sha512: SHA("e"),
        },
      }),
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "the manifests disagree on the version (linux_amd64 2.0.1, linux_arm64 2.0.0",
    );
    expect(run.stdout).toBe("");
  });

  const bad: [string, unknown, RegExp][] = [
    [
      "no version",
      { url: "https://x.test/a", sha512: SHA("a") },
      /has no version/,
    ],
    ["no url", { version: "1", sha512: SHA("a") }, /has no url/],
    [
      "an http url",
      { version: "1", url: "http://x.test/a", sha512: SHA("a") },
      /url is not https/,
    ],
    [
      "a short sha512",
      { version: "1", url: "https://x.test/a", sha512: "abc" },
      /no sha512 \(128 hex characters\)/,
    ],
    ["not JSON", "<html>", /not JSON/],
    ["a JSON array", [], /not a JSON object/],
  ];
  for (const [label, body, message] of bad) {
    test(`a manifest with ${label} is refused, nothing printed`, async () => {
      const run = await runScript(manifests({ darwin_amd64: body }));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toMatch(message);
      expect(run.stdout).toBe("");
    });
  }

  test("an HTTP error on a manifest is named", async () => {
    const run = await runScript(manifests(), 503);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("answered HTTP 503");
    expect(run.stdout).toBe("");
  });
});
