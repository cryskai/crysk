import { describe, expect, test } from "bun:test";
import { claudeCliFailure } from "../benchmarks/martian/martian-claude-cli-error";

describe("claudeCliFailure", () => {
  test("names the usage limit the CLI reports on stdout", () => {
    const stdout = JSON.stringify({
      is_error: true,
      terminal_reason: "api_error",
      result: "You've hit your 5-hour limit · resets 9:20pm (Asia/Tokyo)",
      api_error_status: 429,
    });
    expect(claudeCliFailure(1, stdout, "")).toBe(
      "claude exited 1: You've hit your 5-hour limit · resets 9:20pm (Asia/Tokyo) (HTTP 429)",
    );
  });

  test("keeps stderr when stdout carries no envelope", () => {
    expect(claudeCliFailure(2, "", "boom\n")).toBe("claude exited 2: boom");
  });

  test("falls back to raw stdout when it is not JSON", () => {
    expect(claudeCliFailure(1, "not json", "")).toBe(
      "claude exited 1: not json",
    );
  });

  test("keeps only the last 500 characters", () => {
    const long = "x".repeat(600);
    expect(claudeCliFailure(1, "", long)).toBe(
      `claude exited 1: ${"x".repeat(500)}`,
    );
  });
});
