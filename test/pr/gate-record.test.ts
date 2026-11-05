import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRunDir } from "../../src/ci/platform-report";
import { GATE_RECORD_FILE, writeGateRecord } from "../../src/pr/gate-record";

describe("writeGateRecord", () => {
  test("records the count, and the report step reads it back", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gate-record-"));
    writeGateRecord(dir, 3);
    expect(
      JSON.parse(readFileSync(path.join(dir, GATE_RECORD_FILE), "utf8")),
    ).toEqual({
      unresolved_blocking: 3,
    });
    expect(readRunDir(dir).gate).toEqual({ unresolved_blocking: 3 });
  });

  test("a directory it cannot write to never throws: the review's result stands", () => {
    expect(() => writeGateRecord("/nonexistent/run/dir", 1)).not.toThrow();
  });
});
