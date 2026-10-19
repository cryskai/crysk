#!/usr/bin/env node
// Entry point for `npx pr-hero`, `bun install -g pr-hero`, and a checkout.
// This file runs under Node (npx on a machine without Bun) or under Bun
// (bun install -g, a checkout). The runtime is detected at the top and each
// branch is self-contained.
//
// Under Bun, this file is always reached via `import`, so `import.meta.main`
// inside cli.ts is always false here: we must invoke the exported runCli()
// ourselves instead of relying on cli.ts's own `if (import.meta.main)` guard,
// which only fires for a directly executed entry file (e.g. `bun run
// src/cli.ts`).
//
// Under Node, the TypeScript CLI cannot be imported, so this file spawns Bun
// on src/cli.ts instead, where cli.ts's own `import.meta.main` guard fires
// because cli.ts is the directly executed entry. Bun is the bundled
// dependency (node_modules/bun) when present, otherwise `bun` on PATH.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (typeof globalThis.Bun !== "undefined") {
  const { runCli } = await import("../src/cli.ts");
  await runCli();
} else {
  launchOnBun();
}

function launchOnBun() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, "..", "src", "cli.ts");
  const { bun, tried } = chooseBun(here);

  if (bun === null) {
    if (tried.length === 0) {
      process.stderr.write(
        "pr-hero: Bun was not found. pr-hero runs on Bun (>= 1.3): install it from https://bun.sh, or install pr-hero with npm i -g pr-hero.\n",
      );
    } else {
      process.stderr.write(
        `pr-hero: no working Bun. Tried ${tried.join(" and ")}; neither ran \`bun --version\`. Fix: npm i -g bun, install Bun from https://bun.sh, or reinstall pr-hero.\n`,
      );
    }
    process.exit(127);
  }

  const child = spawn(bun, [cli, ...process.argv.slice(2)], {
    stdio: "inherit",
  });

  // WHY: without forwarding, a Node parent killed by SIGTERM exits and orphans
  // the Bun child, which keeps running with nobody waiting on it.
  // SIGINT on a TTY is not forwarded: the child shares the terminal's process
  // group, so Ctrl+C already reaches it, and a second SIGINT would cut short the
  // CLI's own async cancellation (lock release, commit-status settle). The parent
  // only ignores it there, so it waits for the child's exit.
  // Without a TTY (CI, a pipe, a supervisor that signals only the launcher's pid)
  // nothing else delivers it, so the parent must forward it or the CLI runs on.
  const onInterrupt = () => {
    if (shouldForwardSigint(process.stdin.isTTY)) child.kill("SIGINT");
  };
  process.on("SIGINT", onInterrupt);
  const forwarded = ["SIGTERM", "SIGHUP"];
  const handlers = new Map([["SIGINT", onInterrupt]]);
  for (const sig of forwarded) {
    const handler = () => child.kill(sig);
    handlers.set(sig, handler);
    process.on(sig, handler);
  }

  child.on("error", (err) => {
    process.stderr.write(
      `pr-hero: could not start Bun (${err.code ?? err.message})\n`,
    );
    process.exit(127);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      // WHY: re-raising the child's signal makes this process's exit status
      // match the child's, so callers see the same termination cause.
      for (const [sig, handler] of handlers)
        process.removeListener(sig, handler);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

// WHY: the bundled Bun is probed before use, and a broken one falls back to the
// Bun on PATH. An exec bit missing, a wrong-architecture binary, or a corrupted
// download all exist as files yet cannot run; without the probe the CLI would
// fail later with an opaque spawn error. Under Node this costs one extra spawn
// per invocation; the in-process Bun path skips it.
function chooseBun(here) {
  const tried = [];
  const bundled = findBundledBun(here);
  if (bundled !== null) {
    if (runsBun(bundled)) return { bun: bundled, tried };
    tried.push("the bundled Bun (node_modules/bun)");
  }
  const onPath = findBunOnPath();
  if (onPath !== null) {
    if (runsBun(onPath)) return { bun: onPath, tried };
    tried.push("bun on PATH");
  }
  return { bun: null, tried };
}

function findBundledBun(here) {
  const bundled = path.join(
    here,
    "..",
    "node_modules",
    "bun",
    "bin",
    "bun.exe",
  );
  if (isExecutableFile(bundled)) return bundled;

  try {
    const require = createRequire(import.meta.url);
    const bunPackage = require.resolve("bun/package.json");
    const resolved = path.join(path.dirname(bunPackage), "bin", "bun.exe");
    if (isExecutableFile(resolved)) return resolved;
  } catch {
    // Not installed as a dependency; the caller falls back to PATH.
  }
  return null;
}

function findBunOnPath() {
  const binary = process.platform === "win32" ? "bun.exe" : "bun";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function runsBun(bun) {
  const probe = spawnSync(bun, ["--version"], {
    stdio: "ignore",
    timeout: 5000,
  });
  return probe.status === 0;
}

// WHY: a terminal delivers SIGINT to the whole process group, so the child
// already has it when stdin is a TTY and forwarding would deliver it twice.
// Anywhere else the launcher is the only thing that receives it.
function shouldForwardSigint(isTTY) {
  return isTTY !== true;
}

function isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
