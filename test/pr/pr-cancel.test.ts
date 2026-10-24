import { describe, expect, test } from "bun:test";
import {
  extractRunIdFromTargetUrl,
  type PrCancelJson,
  renderPrCancelLines,
  selectCancelableRuns,
  type WorkflowRunFact,
} from "#pr/pr-cancel";
import { buildPrStatus, renderPrStatusLines } from "#pr/pr-status";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function url(id: number): string {
  return `https://github.com/o/r/actions/runs/${id}`;
}

function run(
  overrides: Partial<WorkflowRunFact> & Pick<WorkflowRunFact, "id">,
): WorkflowRunFact {
  return {
    status: "in_progress",
    event: "pull_request",
    head_sha: HEAD,
    path: ".github/workflows/pr-hero.yml",
    html_url: url(overrides.id),
    display_title: "",
    pull_requests: [],
    ...overrides,
  };
}

describe("extractRunIdFromTargetUrl", () => {
  test("parses a standard Actions run URL and an attempt URL", () => {
    expect(
      extractRunIdFromTargetUrl("https://github.com/o/r/actions/runs/123"),
    ).toBe(123);
    expect(
      extractRunIdFromTargetUrl(
        "https://github.com/o/r/actions/runs/123/attempts/2",
      ),
    ).toBe(123);
  });

  test("returns null for null and for a non-Actions URL", () => {
    expect(extractRunIdFromTargetUrl(null)).toBeNull();
    expect(
      extractRunIdFromTargetUrl("https://github.com/o/r/pull/12"),
    ).toBeNull();
  });
});

describe("selectCancelableRuns", () => {
  test("keeps this PR's open pull_request and issue_comment runs, deduped ascending, and marks them unsettled", () => {
    const selected = selectCancelableRuns({
      pr: 12,
      head: HEAD,
      prTitle: "the title",
      gateTargetUrl: "https://github.com/o/r/actions/runs/50/attempts/2",
      gatePendingInFlight: true,
      workflowRuns: [
        run({ id: 30, status: "completed", pull_requests: [{ number: 12 }] }),
        run({ id: 10, pull_requests: [] }),
        run({
          id: 20,
          status: "queued",
          head_sha: OTHER,
          pull_requests: [{ number: 12 }],
        }),
        run({
          id: 40,
          head_sha: OTHER,
          pull_requests: [{ number: 99 }],
        }),
        run({
          id: 15,
          status: "queued",
          event: "issue_comment",
          head_sha: OTHER,
          display_title: "the title",
        }),
        run({
          id: 16,
          status: "queued",
          event: "issue_comment",
          head_sha: HEAD,
          display_title: "another pull request",
        }),
        run({
          id: 17,
          status: "queued",
          event: "issue_comment",
          head_sha: OTHER,
          display_title: "pr #12",
        }),
        run({
          id: 50,
          event: "issue_comment",
          head_sha: OTHER,
          path: ".github/workflows/other.yml",
        }),
        run({ id: 10, pull_requests: [] }),
      ],
    });
    expect(selected).toEqual([
      {
        run_id: 10,
        previous_status: "in_progress",
        settled: false,
        html_url: url(10),
      },
      {
        run_id: 15,
        previous_status: "queued",
        settled: false,
        html_url: url(15),
      },
      {
        run_id: 17,
        previous_status: "queued",
        settled: false,
        html_url: url(17),
      },
      {
        run_id: 20,
        previous_status: "queued",
        settled: false,
        html_url: url(20),
      },
      {
        run_id: 50,
        previous_status: "in_progress",
        settled: false,
        html_url: url(50),
      },
    ]);
  });

  test("does not select a run by gate URL alone when the gate is not pending in flight", () => {
    const selected = selectCancelableRuns({
      pr: 12,
      head: HEAD,
      prTitle: "the title",
      gateTargetUrl: url(50),
      gatePendingInFlight: false,
      workflowRuns: [
        run({
          id: 15,
          event: "issue_comment",
          head_sha: OTHER,
          display_title: "pr #12",
        }),
        run({
          id: 50,
          event: "issue_comment",
          head_sha: OTHER,
          path: ".github/workflows/other.yml",
        }),
      ],
    });
    expect(selected.map((fact) => fact.run_id)).toEqual([15]);
  });
});

describe("renderPrCancelLines", () => {
  test("summarizes the cancelled ids and the override, appends the status lines, and emits no ANSI", () => {
    const status = buildPrStatus({
      pr: 12,
      head: HEAD,
      nowMs: Date.parse("2026-10-24T00:00:00Z"),
      statuses: [],
      issueComments: [],
      reviewComments: [],
    });
    const result: PrCancelJson = {
      schema: "pr-hero.cancel/v1",
      pr: 12,
      head: HEAD,
      cancelled_runs: [
        {
          run_id: 123,
          previous_status: "in_progress",
          settled: true,
          html_url: url(123),
        },
      ],
      override_requested: true,
      status,
    };
    const lines = renderPrCancelLines(result);
    expect(lines).toEqual([
      "pr-hero cancel: PR #12",
      "cancelled: 123",
      "override: /pr-hero override posted",
      ...renderPrStatusLines(status),
    ]);
    for (const line of lines) expect(line).not.toContain("\x1b");
  });
});
