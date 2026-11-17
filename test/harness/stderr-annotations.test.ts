// PR #315 review F001: the harness appends bookkeeping lines to a step's
// stderrTail after the transport's own tail, and the progress reason
// (pipeline.ts stepFailureReason) must be able to skip them. This file pins
// the predicate that recognizes them, owned in harness.ts next to the
// appends. The texts are literal copies on purpose — the end-to-end proof
// that the harness's REAL appends match lives in credential-projection.test.ts.

import { describe, expect, test } from "bun:test";
import { isHarnessStderrAnnotation } from "../../src/execution/harness";
import { redactEvidenceText } from "../../src/security/evidence-redaction";
import { redactDiagnostic } from "../../src/security/redact";

const ANNOTATIONS = [
  "[pr-hero] credential projection unavailable (missing_subscription_record); child runs with operator environment",
  "[pr-hero] ambient credential bills metered — this attempt reserves against the spend ledger and fences its bucket if its usage cannot be confirmed",
  "[pr-hero] credential projection destroy failed",
];

describe("isHarnessStderrAnnotation", () => {
  for (const annotation of ANNOTATIONS) {
    test(`recognizes ${annotation.slice(10, 50)}`, () => {
      expect(isHarnessStderrAnnotation(annotation)).toBe(true);
      expect(isHarnessStderrAnnotation(`  ${annotation}\t`)).toBe(true);
    });
  }

  test("recognizes the projection warning for any failure class shape", () => {
    expect(
      isHarnessStderrAnnotation(
        "[pr-hero] credential projection unavailable (broker_error); child runs with operator environment",
      ),
    ).toBe(true);
  });

  // The transport's own diagnostic carries the same "[pr-hero] " tag, so a
  // tag-prefix filter would throw away the one line that names the cause.
  test("never matches the transport's spawn-failure line", () => {
    expect(
      isHarnessStderrAnnotation(
        "[pr-hero] spawn failed: E2BIG: argument list too long; no child started",
      ),
    ).toBe(false);
  });

  test("never matches child text that merely mentions an annotation", () => {
    expect(
      isHarnessStderrAnnotation("error: credential projection destroy failed"),
    ).toBe(false);
    expect(
      isHarnessStderrAnnotation(
        "[pr-hero] credential projection destroy failed: EBUSY",
      ),
    ).toBe(false);
    expect(isHarnessStderrAnnotation("")).toBe(false);
  });

  // stepFailureReason redacts the witness BEFORE it looks for annotations,
  // so an annotation the redaction rewrote would stop matching and become
  // the reason again.
  test("every annotation is a fixed point of the progress reason's redaction", () => {
    for (const annotation of ANNOTATIONS) {
      expect(redactEvidenceText(redactDiagnostic(annotation))).toBe(annotation);
    }
  });
});
