import { writeFileSync } from "node:fs";
import path from "node:path";

export const GATE_RECORD_FILE = "gate.json";

// The count the `crysk` status is decided on: this run's blocking findings plus earlier ones still
// open. findings.json holds only this run's, so a same-head re-review there reads zero while the
// status stays red. The report to the platform runs as another process, so it reads this file. A
// failure to write only costs the platform the number; it must not change the review's result.
export function writeGateRecord(
  runDir: string,
  unresolvedBlocking: number,
): void {
  try {
    writeFileSync(
      path.join(runDir, GATE_RECORD_FILE),
      `${JSON.stringify({ unresolved_blocking: unresolvedBlocking })}\n`,
    );
  } catch {
    // see above
  }
}
