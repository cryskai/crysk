// Entry point of the CI sandbox runner: `bun scripts/sandbox.ts <command>`.
// The logic lives in scripts/sandbox/, where the tests import it, so tsc and the
// test run cover it. This file only wires the real I/O and exits with the code.

import { runCli } from "./sandbox/cli";
import { realDeps } from "./sandbox/real";

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2), realDeps()));
}
