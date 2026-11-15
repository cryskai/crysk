// odd/tasks/antigravity-oauth.md T5 (S7): the Install Antigravity CLI step.
// Offline: the manifest server and the download are an injected fetch, and the
// archives are tar headers written here byte by byte, so the refused shapes
// (traversal, two entries, a link) are exact and need no host tar.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  AGY_MANIFEST_BASE_URL,
  agyManifestUrl,
  agyPlatformKey,
  installAgy,
  runAgyInstall,
  sha512Hex,
} from "#ci/agy-install";

const BINARY = new TextEncoder().encode(
  "#!/bin/sh\necho 'agy 9.9.9-fixture'\n",
);
const DOWNLOAD_URL = "https://downloads.example.test/agy/cli_linux_x64.tar.gz";

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

// One tar entry: a 512-byte header (GNU magic, as the real release uses) and
// its data padded to a block.
function tarEntry(
  name: string,
  data: Uint8Array,
  options: { typeflag?: string; linkname?: string } = {},
): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, offset: number) =>
    header.set(new TextEncoder().encode(text), offset);
  put(name, 0);
  put(octal(0o755, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(data.length, 12), 124);
  put(octal(1_700_000_000, 12), 136);
  put(options.typeflag ?? "0", 156);
  if (options.linkname !== undefined) put(options.linkname, 157);
  put("ustar  \0", 257);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  const out = new Uint8Array(512 + padded.length);
  out.set(header);
  out.set(padded, 512);
  return out;
}

function tarGz(...entries: Uint8Array[]): Uint8Array {
  const end = new Uint8Array(1024 * 10);
  const total = entries.reduce((n, e) => n + e.length, 0) + end.length;
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    tar.set(entry, offset);
    offset += entry.length;
  }
  return gzipSync(tar);
}

const GOOD = tarGz(tarEntry("antigravity", BINARY));

interface Served {
  readonly manifest?: { status?: number; body?: string };
  readonly download?: { status?: number; body?: Uint8Array };
}

function fakeFetch(served: Served) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (url.startsWith(AGY_MANIFEST_BASE_URL)) {
      return new Response(served.manifest?.body ?? "", {
        status: served.manifest?.status ?? 200,
      });
    }
    if (url === DOWNLOAD_URL) {
      const body = served.download?.body ?? GOOD;
      return new Response(body.slice().buffer as ArrayBuffer, {
        status: served.download?.status ?? 200,
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchFn, calls };
}

const manifestFor = (
  archive: Uint8Array,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    version: "9.9.9",
    url: DOWNLOAD_URL,
    sha512: sha512Hex(archive),
    ...extra,
  });

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crysk-agy-install-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function install(served: Served) {
  const root = await scratch();
  const installDir = path.join(root, "bin");
  const { fetchFn, calls } = fakeFetch(served);
  const versions: string[] = [];
  let error: unknown;
  let result: Awaited<ReturnType<typeof installAgy>> | undefined;
  try {
    result = await installAgy({
      fetch: fetchFn,
      installDir,
      platformKey: "linux_amd64",
      runVersion: async (binary) => {
        versions.push(binary);
        return "agy 9.9.9\n";
      },
    });
  } catch (caught) {
    error = caught;
  }
  const files = existsSync(installDir) ? readdirSync(installDir) : [];
  return { root, installDir, calls, versions, error, result, files };
}

describe("agyPlatformKey", () => {
  test("maps the four builds the auto-updater publishes", () => {
    expect(agyPlatformKey("linux", "x64")).toBe("linux_amd64");
    expect(agyPlatformKey("linux", "arm64")).toBe("linux_arm64");
    expect(agyPlatformKey("darwin", "arm64")).toBe("darwin_arm64");
    expect(agyPlatformKey("darwin", "x64")).toBe("darwin_amd64");
    expect(agyManifestUrl("linux_amd64")).toBe(
      `${AGY_MANIFEST_BASE_URL}/linux_amd64.json`,
    );
  });

  test("refuses any other runner by name", () => {
    expect(() => agyPlatformKey("win32", "x64")).toThrow(
      /no build for this runner \(win32\/x64\)/,
    );
    expect(() => agyPlatformKey("linux", "ia32")).toThrow(/linux\/ia32/);
  });
});

describe("installAgy", () => {
  test("a good archive installs agy 0755, then runs its --version by absolute path", async () => {
    const run = await install({ manifest: { body: manifestFor(GOOD) } });
    expect(run.error).toBeUndefined();
    expect(run.calls).toEqual([
      `${AGY_MANIFEST_BASE_URL}/linux_amd64.json`,
      DOWNLOAD_URL,
    ]);
    const binary = path.join(run.installDir, "agy");
    expect(run.files).toEqual(["agy"]);
    expect(readFileSync(binary)).toEqual(Buffer.from(BINARY));
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(run.versions).toEqual([binary]);
    expect(run.result).toEqual({
      binary,
      version: "9.9.9",
      reported: "agy 9.9.9",
    });
  });

  test("an uppercase sha512 in the manifest is the same hex string", async () => {
    const run = await install({
      manifest: {
        body: manifestFor(GOOD, { sha512: sha512Hex(GOOD).toUpperCase() }),
      },
    });
    expect(run.error).toBeUndefined();
  });

  test("a sha512 mismatch installs nothing and executes nothing", async () => {
    const run = await install({
      manifest: { body: manifestFor(GOOD, { sha512: "a".repeat(128) }) },
    });
    expect(String(run.error)).toContain("does not match the manifest's sha512");
    expect(run.files).toEqual([]);
    expect(run.versions).toEqual([]);
  });

  test("a tampered download (the manifest's sha512 of another archive) is refused", async () => {
    const other = tarGz(tarEntry("antigravity", new Uint8Array([1, 2, 3])));
    const run = await install({
      manifest: { body: manifestFor(GOOD) },
      download: { body: other },
    });
    expect(String(run.error)).toContain("does not match");
    expect(run.files).toEqual([]);
    expect(run.versions).toEqual([]);
  });

  const refused: [string, Uint8Array, RegExp][] = [
    [
      "a path traversal entry",
      tarGz(tarEntry("../antigravity", BINARY)),
      /unexpected entry \("\.\.\/antigravity"\)/,
    ],
    [
      "an absolute path entry",
      tarGz(tarEntry("/tmp/antigravity", BINARY)),
      /unexpected entry/,
    ],
    [
      "a ./-prefixed name",
      tarGz(tarEntry("./antigravity", BINARY)),
      /unexpected entry/,
    ],
    [
      "two entries",
      tarGz(tarEntry("antigravity", BINARY), tarEntry("antigravity", BINARY)),
      /more than one entry/,
    ],
    [
      "a second, differently named entry",
      tarGz(tarEntry("antigravity", BINARY), tarEntry("evil", BINARY)),
      /more than one entry/,
    ],
    [
      "a symlink entry",
      tarGz(
        tarEntry("antigravity", new Uint8Array(0), {
          typeflag: "2",
          linkname: "/bin/sh",
        }),
      ),
      /not a regular file/,
    ],
    [
      "a hardlink entry",
      tarGz(
        tarEntry("antigravity", new Uint8Array(0), {
          typeflag: "1",
          linkname: "/etc/passwd",
        }),
      ),
      /not a regular file/,
    ],
    [
      "a directory entry",
      tarGz(tarEntry("antigravity", new Uint8Array(0), { typeflag: "5" })),
      /not a regular file/,
    ],
    [
      "a pax header before the file",
      tarGz(
        tarEntry("PaxHeader/antigravity", new Uint8Array(30), {
          typeflag: "x",
        }),
        tarEntry("antigravity", BINARY),
      ),
      /unexpected entry/,
    ],
    ["an empty archive", tarGz(), /does not hold antigravity/],
    [
      "data hidden after the end marker",
      (() => {
        const tar = new Uint8Array(512 * 6);
        tar.set(tarEntry("antigravity", BINARY));
        tar.set(tarEntry("evil", BINARY), 512 * 4);
        return gzipSync(tar);
      })(),
      /data after its end marker/,
    ],
    [
      "a corrupted header checksum",
      (() => {
        const entry = tarEntry("antigravity", BINARY);
        entry[100] = "1".charCodeAt(0);
        return gzipSync(entry);
      })(),
      /bad checksum/,
    ],
    [
      "a truncated file",
      (() => {
        const entry = tarEntry("antigravity", BINARY);
        return gzipSync(entry.subarray(0, 520));
      })(),
      /truncated/,
    ],
    [
      "bytes that are not gzip",
      new TextEncoder().encode("plain"),
      /not a gzip/,
    ],
  ];
  for (const [label, archive, message] of refused) {
    test(`${label} is refused, with nothing written or executed`, async () => {
      const run = await install({
        manifest: { body: manifestFor(archive) },
        download: { body: archive },
      });
      expect(String(run.error)).toMatch(message);
      expect(run.files).toEqual([]);
      expect(run.versions).toEqual([]);
    });
  }

  const badManifests: [string, string, RegExp][] = [
    [
      "no version",
      JSON.stringify({ url: DOWNLOAD_URL, sha512: "a".repeat(128) }),
      /has no version/,
    ],
    [
      "no url",
      JSON.stringify({ version: "1", sha512: "a".repeat(128) }),
      /has no url/,
    ],
    [
      "no sha512",
      JSON.stringify({ version: "1", url: DOWNLOAD_URL }),
      /has no sha512/,
    ],
    [
      "a short sha512",
      JSON.stringify({ version: "1", url: DOWNLOAD_URL, sha512: "abc" }),
      /has no sha512/,
    ],
    [
      "an http url",
      JSON.stringify({
        version: "1",
        url: "http://downloads.example.test/a.tgz",
        sha512: "a".repeat(128),
      }),
      /not https/,
    ],
    ["not JSON", "<html>", /not JSON/],
    ["a JSON array", "[]", /not a JSON object/],
  ];
  for (const [label, body, message] of badManifests) {
    test(`a manifest with ${label} is refused before any download`, async () => {
      const run = await install({ manifest: { body } });
      expect(String(run.error)).toMatch(message);
      expect(run.calls).toEqual([`${AGY_MANIFEST_BASE_URL}/linux_amd64.json`]);
      expect(run.files).toEqual([]);
    });
  }

  test("an HTTP error on the manifest stops before any download", async () => {
    const run = await install({ manifest: { status: 503, body: "busy" } });
    expect(String(run.error)).toContain("answered HTTP 503");
    expect(run.calls).toHaveLength(1);
    expect(run.files).toEqual([]);
  });

  test("an HTTP error on the download installs nothing", async () => {
    const run = await install({
      manifest: { body: manifestFor(GOOD) },
      download: { status: 404 },
    });
    expect(String(run.error)).toContain("download answered HTTP 404");
    expect(run.files).toEqual([]);
  });

  test("a network failure is named, not thrown raw", async () => {
    const root = await scratch();
    const error = await installAgy({
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
      installDir: path.join(root, "bin"),
      platformKey: "linux_amd64",
      runVersion: async () => "",
    }).catch((caught: unknown) => caught);
    expect(String(error)).toContain("manifest could not be fetched");
    expect(String(error)).toContain("ECONNRESET");
  });
});

describe("runAgyInstall (the step's entry)", () => {
  async function runStep(
    env: Record<string, string>,
    platform: NodeJS.Platform = "linux",
  ) {
    const root = await scratch();
    const githubPath = path.join(root, "github-path");
    await writeFile(githubPath, "");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { fetchFn } = fakeFetch({ manifest: { body: manifestFor(GOOD) } });
    const exitCode = await runAgyInstall({
      env: { GITHUB_PATH: githubPath, ...env },
      fetch: fetchFn,
      platform,
      arch: "x64",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      runVersion: async () => "agy 9.9.9\n",
    });
    return {
      root,
      exitCode,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      githubPath: readFileSync(githubPath, "utf8"),
    };
  }

  test("installs into AGY_INSTALL_DIR and adds it to GITHUB_PATH", async () => {
    const root = await scratch();
    const dir = path.join(root, "agy-bin");
    const run = await runStep({ AGY_INSTALL_DIR: dir });
    expect(run.exitCode).toBe(0);
    expect(run.githubPath).toBe(`${dir}\n`);
    expect(run.stdout).toContain(
      "installed the Antigravity CLI 9.9.9 (sha512 verified)",
    );
    expect(statSync(path.join(dir, "agy")).mode & 0o777).toBe(0o755);
  });

  test("a relative or missing AGY_INSTALL_DIR fails the step", async () => {
    for (const value of ["", "bin"]) {
      const run = await runStep({ AGY_INSTALL_DIR: value });
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("::error::");
      expect(run.githubPath).toBe("");
    }
  });

  test("an unsupported runner fails the step with its name and changes no PATH", async () => {
    const root = await scratch();
    const run = await runStep(
      { AGY_INSTALL_DIR: path.join(root, "b") },
      "win32",
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("no build for this runner (win32/x64)");
    expect(run.githubPath).toBe("");
  });
});

// The real entry point: runs the installed binary, so a fixture script stands in
// for agy. The manifest URL is a constant, so the script itself is not run here
// against a fake server; installAgy above covers its whole path.
describe("installAgy runs the installed binary's --version", () => {
  test("the default runner executes <dir>/agy --version", async () => {
    const root = await scratch();
    const { fetchFn } = fakeFetch({ manifest: { body: manifestFor(GOOD) } });
    const result = await installAgy({
      fetch: fetchFn,
      installDir: path.join(root, "bin"),
      platformKey: "linux_amd64",
    });
    expect(result.reported).toBe("agy 9.9.9-fixture");
  });
});

describe("readCapped streams a download without a declared length", () => {
  test("a chunked body over the cap is refused before it is fully buffered", async () => {
    const { readCapped } = await import("../../src/ci/agy-install");
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = new Response(body);
    expect(response.headers.get("content-length")).toBeNull();
    await expect(readCapped(response, 4096)).rejects.toThrow(
      "larger than the install allows",
    );
    // It stopped reading soon after the cap, not after the whole body.
    expect(pulled).toBeLessThan(20);
  });

  test("a chunked body within the cap is returned whole", async () => {
    const { readCapped } = await import("../../src/ci/agy-install");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );
    expect(Array.from(await readCapped(response, 10))).toEqual([1, 2, 3]);
  });
});
