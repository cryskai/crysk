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
import { spawn } from "node:child_process";
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
  const bun = findBun(here);

  if (bun === null) {
    process.stderr.write(
      "pr-hero: Bun was not found. pr-hero runs on Bun (>= 1.3): install it from https://bun.sh, or install pr-hero with npm i -g pr-hero.\n",
    );
    process.exit(127);
  }

  const child = spawn(bun, [cli, ...process.argv.slice(2)], {
    stdio: "inherit",
  });

  // WHY: without forwarding, a Node parent killed by SIGTERM exits and orphans
  // the Bun child, which keeps running with nobody waiting on it.
  const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map();
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

function findBun(here) {
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
    // Not installed as a dependency; fall through to PATH.
  }

  const binary = process.platform === "win32" ? "bun.exe" : "bun";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
