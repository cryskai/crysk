import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRunDir } from "../../src/ci/platform-report";
import {
  buildFindingStateRecord,
  FINDING_STATE_FILE,
  writeFindingStateRecord,
} from "../../src/pr/finding-state-record";

const rows = [
  {
    id: "R001",
    sev: "CRITICAL",
    tier: "blocking",
    channel: "inline",
    locs: ["src/secret.ts:10"],
    c: "fingerprint",
    claim: "PLANTED-CLAIM quoting the customer's code",
    status: "carried",
  },
  {
    id: "R002",
    sev: "WARNING",
    tier: "advisory",
    channel: "inline",
    locs: ["src/app.ts:20"],
    c: "fingerprint",
    claim: "another claim",
    status: "unconfirmed",
  },
] as const;

describe("buildFindingStateRecord", () => {
  const record = buildFindingStateRecord({
    rows,
    freshFindingIds: ["F001", "F002"],
    freshIds: ["R002", undefined],
    resolvedIds: ["R000"],
    supersededIds: ["R005"],
    dropped: 1,
  });

  test("holds each open finding's id, status and tier", () => {
    expect(record.open).toEqual([
      { id: "R001", status: "carried", tier: "blocking" },
      { id: "R002", status: "unconfirmed", tier: "advisory" },
    ]);
  });

  test("maps this run's findings to their stable ids, skipping any without one", () => {
    expect(record.fresh).toEqual({ F001: "R002" });
  });

  test("names what this run resolved, and whether the cap dropped rows", () => {
    expect(record.resolved).toEqual(["R000"]);
    expect(record.dropped).toBe(1);
  });

  test("names what a stronger finding replaced, apart from what was resolved", () => {
    expect(record.superseded).toEqual(["R005"]);
    expect(record.resolved).not.toContain("R005");
  });

  test("carries no text of the review", () => {
    const text = JSON.stringify(record);
    expect(text).not.toContain("PLANTED-CLAIM");
    expect(text).not.toContain("secret.ts");
    expect(text).not.toContain("fingerprint");
  });
});

describe("writeFindingStateRecord", () => {
  test("the report step reads back what the run wrote", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "finding-state-"));
    const record = {
      open: [],
      fresh: {},
      resolved: ["R001"],
      superseded: [],
      dropped: 0,
    };
    writeFindingStateRecord(dir, record);
    expect(
      JSON.parse(readFileSync(path.join(dir, FINDING_STATE_FILE), "utf8")),
    ).toEqual(record);
    expect(readRunDir(dir).findingStates).toEqual(record);
  });

  test("a directory it cannot write to never throws", () => {
    expect(() =>
      writeFindingStateRecord("/nonexistent/run/dir", {
        open: [],
        fresh: {},
        resolved: [],
        superseded: [],
        dropped: 0,
      }),
    ).not.toThrow();
  });
});
