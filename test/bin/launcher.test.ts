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
  "crysk: Bun was not found. Crysk runs on Bun (>= 1.3): install it from https://bun.sh, or install Crysk with npm i -g crysk.\n";

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

// The launcher probes a Bun with `--version` before using it, so every fake that
// must reach its real behavior answers that probe first.
const VERSION_OK = `if [ "$1" = "--version" ]; then echo 1.3.14; exit 0; fi`;

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
    fakeBunOn(pathDir, `${VERSION_OK}\nexit 3`);

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
    const ready = path.join(tmp, "ready");
    mkdirSync(pathDir);
    // The fake writes READY only after its trap is installed, and the launcher registers its
    // own handlers before the child can start, so READY means both sides are listening.
    fakeBunOn(
      pathDir,
      `${VERSION_OK}
trap 'echo got-term > "$MARK"; exit 0' TERM
touch "$READY"
while :; do sleep 0.1; done`,
    );

    const proc = Bun.spawn([NODE, launcher()], {
      env: {
        PATH: `${pathDir}${path.delimiter}${path.dirname(NODE)}:/bin:/usr/bin`,
        MARK: mark,
        READY: ready,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    // A readiness handshake, not a fixed sleep: a loaded runner can take longer than any
    // fixed wait to start Node, the launcher and the fake.
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(ready)).toBe(true);
    proc.kill("SIGTERM");

    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    expect(exited).toBe(true);
    expect(existsSync(mark)).toBe(true);
    expect(readFileSync(mark, "utf8")).toContain("got-term");
  },
  // The handshake may wait up to 10 s and the exit up to 5 s; Bun's 5 s default would cut
  // it first (review #348 F003).
  20_000,
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

test.skipIf(process.platform === "win32")(
  "a bundled Bun that fails `--version` is skipped for the Bun on PATH",
  () => {
    writeExecutable(
      path.join(pkg, "node_modules", "bun", "bin", "bun.exe"),
      "exit 1",
    );
    const pathDir = path.join(tmp, "path-bin");
    mkdirSync(pathDir);
    fakeBunOn(pathDir, 'echo "PATHBUN $@"');

    const result = runLauncher(["x"], {
      PATH: `${pathDir}${path.delimiter}${path.dirname(NODE)}`,
    });

    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toContain(
      `PATHBUN ${path.join(pkg, "src", "cli.ts")} x`,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "when neither the bundled Bun nor the Bun on PATH runs, exit 127 and name both and the fix",
  () => {
    writeExecutable(
      path.join(pkg, "node_modules", "bun", "bin", "bun.exe"),
      "exit 1",
    );
    const pathDir = path.join(tmp, "path-bin");
    mkdirSync(pathDir);
    fakeBunOn(pathDir, "exit 1");

    const result = runLauncher([], {
      PATH: `${pathDir}${path.delimiter}${path.dirname(NODE)}`,
    });

    const err = decode(result.stderr);
    expect(result.exitCode).toBe(127);
    expect(err).toContain("bundled");
    expect(err).toContain("PATH");
    expect(err).toContain("npm i -g bun");
    expect(err).toContain("https://bun.sh");
    expect(err).toContain("reinstall crysk");
  },
);

test.skipIf(process.platform === "win32")(
  "SIGINT sent to the launcher alone reaches the child when stdin is not a TTY",
  async () => {
    const pathDir = path.join(tmp, "path-bin");
    const mark = path.join(tmp, "mark");
    const ready = path.join(tmp, "ready");
    mkdirSync(pathDir);
    // The loop is bounded (about 10 s) so a regression that drops the signal
    // cannot leave the fake running for good.
    fakeBunOn(
      pathDir,
      `${VERSION_OK}\ntrap 'echo got-int > "$MARK"; exit 0' INT\n` +
        `touch "$READY"\ni=0\nwhile [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`,
    );

    const proc = Bun.spawn([NODE, launcher()], {
      env: {
        PATH: `${pathDir}${path.delimiter}${path.dirname(NODE)}:/bin:/usr/bin`,
        MARK: mark,
        READY: ready,
      },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let waited = 0; !existsSync(ready) && waited < 5000; waited += 50) {
      await Bun.sleep(50);
    }
    expect(existsSync(ready)).toBe(true);
    proc.kill("SIGINT");

    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    expect(exited).toBe(true);
    expect(existsSync(mark)).toBe(true);
    expect(readFileSync(mark, "utf8")).toContain("got-int");
  },
);

test.skipIf(process.platform === "win32")(
  "on a TTY, SIGINT sent to the launcher alone is ignored and the child keeps running",
  async () => {
    const pathDir = path.join(tmp, "path-bin");
    const mark = path.join(tmp, "mark");
    const ready = path.join(tmp, "ready");
    mkdirSync(pathDir);
    // The child gets the terminal's process group in real use, so a signal the
    // launcher ignores must not reach it; the child then exits on its own.
    fakeBunOn(
      pathDir,
      `${VERSION_OK}\ntrap 'echo got-int > "$MARK"; exit 0' INT\n` +
        `touch "$READY"\ni=0\nwhile [ $i -lt 15 ]; do sleep 0.1; i=$((i+1)); done\necho done-alone > "$MARK"`,
    );

    const proc = Bun.spawn([NODE, launcher()], {
      env: {
        PATH: `${pathDir}${path.delimiter}${path.dirname(NODE)}:/bin:/usr/bin`,
        MARK: mark,
        READY: ready,
      },
      terminal: { cols: 80, rows: 24, data() {} },
    });
    for (let waited = 0; !existsSync(ready) && waited < 5000; waited += 50) {
      await Bun.sleep(50);
    }
    expect(existsSync(ready)).toBe(true);
    proc.kill("SIGINT");

    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(8000).then(() => false),
    ]);
    expect(exited).toBe(true);
    expect(readFileSync(mark, "utf8")).toBe("done-alone\n");
  },
);

test.skipIf(process.platform === "win32")(
  "a child that dies from SIGINT makes the launcher die from SIGINT, not exit 0",
  () => {
    const pathDir = nodeOnlyDir();
    fakeBunOn(pathDir, `${VERSION_OK}\nkill -INT $$\nsleep 5`);

    const result = runLauncher([], { PATH: `${pathDir}:/bin:/usr/bin` });

    expect(result.exitCode).not.toBe(0);
    expect(result.signalCode).toBe("SIGINT");
  },
);
