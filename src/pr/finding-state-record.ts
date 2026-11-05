import { writeFileSync } from "node:fs";
import path from "node:path";

export const FINDING_STATE_FILE = "finding-state.json";

// Which findings stay open after this run, under the ids that last across runs (R###). findings.json
// cannot say: it holds only this run's findings, renumbered each run, and a finding missing from it
// may simply not have been looked at. Only ids and statuses: nothing here can quote the customer's
// code, so it may leave the runner in metadata-only mode too.
export interface FindingStateRecord {
  open: { id: string; status: string; tier: string }[];
  // This run's finding id -> its stable id.
  fresh: Record<string, string>;
  // The stable ids this run verified gone. Absence never means resolved.
  resolved: string[];
  // The stable ids a stronger finding replaced this run, under a new id. Not fixed, so not resolved.
  superseded: string[];
  // Rows the state block's size cap left out, whose state is therefore unknown.
  dropped: number;
}

export function buildFindingStateRecord(input: {
  rows: readonly { id: string; status: string; tier: string }[];
  freshFindingIds: readonly string[];
  freshIds: readonly (string | undefined)[];
  resolvedIds: readonly string[];
  supersededIds: readonly string[];
  dropped: number;
}): FindingStateRecord {
  const fresh: Record<string, string> = {};
  input.freshFindingIds.forEach((findingId, index) => {
    const stable = input.freshIds[index];
    if (stable !== undefined) fresh[findingId] = stable;
  });
  return {
    open: input.rows.map(({ id, status, tier }) => ({ id, status, tier })),
    fresh,
    resolved: [...input.resolvedIds],
    superseded: [...input.supersededIds],
    dropped: input.dropped,
  };
}

// The report to the platform runs as another process, so it reads this file. A failure to write only
// costs the platform this detail; it must not change the review's result.
export function writeFindingStateRecord(
  runDir: string,
  record: FindingStateRecord,
): void {
  try {
    writeFileSync(
      path.join(runDir, FINDING_STATE_FILE),
      `${JSON.stringify(record)}\n`,
    );
  } catch {
    // see above
  }
}
