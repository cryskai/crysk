// The npm entry point (bin/pr-hero.js) runs under Node (npx) and under Bun
// (bun install -g, a checkout). These tests pin the Node path: Bun discovery
// order, argument forwarding, exit-code and signal propagation, and the
// message when no Bun exists. Fixtures copy the REAL launcher into a temp
// package so nothing here depends on the repo's own node_modules.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..", "..");
const REAL_LAUNCHER = path.join(REPO, "bin", "pr-hero.js");
const NODE = Bun.which("node") ?? "node";
const NOT_FOUND_MESSAGE =
  "pr-hero: Bun was not found. pr-hero runs on Bun (>= 1.3): install it from https://bun.sh, or install pr-hero with npm i -g pr-hero.\n";

let tmp = "";
let pkg = "";

beforeEach(() => {
  tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "prhero-launcher-"));
  pkg = path.join(tmp, "pkg");
  mkdirSync(path.join(pkg, "bin"), { recursive: true });
  copyFileSync(REAL_LAUNCHER, path.join(pkg, "bin", "pr-hero.js"));
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ type: "module" }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function launcher(): string {
  return path.join(pkg, "bin", "pr-hero.js");
}

function writeExecutable(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function fakeBunOn(dir: string, body: string): string {
  const file = path.join(dir, "bun");
  writeExecutable(file, body);
  return file;
}

// Directory holding a `node` link, but no `bun`. Node's own dir may contain
// bun (e.g. a version manager), so the link is made in a separate directory.
function nodeOnlyDir(): string {
  const dir = path.join(tmp, "node-only");
  mkdirSync(dir, { recursive: true });
  symlinkSync(NODE, path.join(dir, "node"));
  return dir;
}

function runLauncher(args: string[], env: Record<string, string>) {
  return Bun.spawnSync([NODE, launcher(), ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test.skipIf(process.platform === "win32")(
  "a bundled Bun dependency wins over a Bun on PATH",
  () => {
    writeExecutable(
      path.join(pkg, "node_modules", "bun", "bin", "bun.exe"),
      'echo "FAKEBUN $@"',
    );
    const pathDir = path.join(tmp, "path-bin");
    mkdirSync(pathDir);
    fakeBunOn(pathDir, 'echo "PATHBUN $@"');

    const result = runLauncher(["--version"], {
      PATH: `${pathDir}${path.delimiter}${path.dirname(NODE)}`,
    });

    const out = decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(out).toContain(
      `FAKEBUN ${path.join(pkg, "src", "cli.ts")} --version`,
    );
    expect(out).not.toContain("PATHBUN");
  },
);

test.skipIf(process.platform === "win32")(
  "without the bundled dependency, Bun is found on PATH and args are forwarded in order",
  () => {
    const pathDir = path.join(tmp, "path-bin");
    mkdirSync(pathDir);
    fakeBunOn(pathDir, 'echo "PATHBUN $@"');

    const result = runLauncher(["a", "b"], {
      PATH: `${pathDir}${path.delimiter}${path.dirname(NODE)}`,
    });

    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toContain(
      `PATHBUN ${path.join(pkg, "src", "cli.ts")} a b`,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "the child's exit code is the launcher's exit code",
  () => {
    const pathDir = path.join(tmp, "path-bin");
    mkdirSync(pathDir);
    fakeBunOn(pathDir, "exit 3");

    const result = runLauncher([], {
      PATH: `${pathDir}${path.delimiter}${path.dirname(NODE)}`,
    });

    expect(result.exitCode).toBe(3);
  },
);

test.skipIf(process.platform === "win32")(
  "no Bun anywhere exits 127 with the exact message",
  () => {
    const result = runLauncher([], { PATH: nodeOnlyDir() });

    expect(result.exitCode).toBe(127);
    expect(decode(result.stderr)).toBe(NOT_FOUND_MESSAGE);
  },
);

test.skipIf(process.platform === "win32")(
  "SIGTERM to the launcher reaches the Bun child",
  async () => {
    const pathDir = path.join(tmp, "path-bin");
    const mark = path.join(tmp, "mark");
    mkdirSync(pathDir);
    fakeBunOn(
      pathDir,
      `trap 'echo got-term > "$MARK"; exit 0' TERM\nwhile :; do sleep 0.1; done`,
    );

    const proc = Bun.spawn([NODE, launcher()], {
      env: {
        PATH: `${pathDir}${path.delimiter}${path.dirname(NODE)}:/bin:/usr/bin`,
        MARK: mark,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(500);
    proc.kill("SIGTERM");

    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    expect(exited).toBe(true);
    expect(existsSync(mark)).toBe(true);
    expect(readFileSync(mark, "utf8")).toContain("got-term");
  },
);

test("under Bun, the launcher runs the CLI in-process and prints its usage", () => {
  const result = Bun.spawnSync([process.execPath, REAL_LAUNCHER, "--help"], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(decode(result.stderr)).toContain("Usage:");
});
