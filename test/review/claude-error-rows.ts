// The mapping table of the Claude CLI's `-p --output-format json` errors, as fake
// envelopes (odd/tasks/claude-error-map.md, S3). One row per table row, shared by the
// transport test (cause, detail) and the runner test (retry behaviour) so the two cannot
// drift from each other.

import type { TransportFailureCause } from "../../src/execution/contracts";

export interface ClaudeErrorRow {
  readonly name: string;
  // Envelope fields. An absent field is absent from the JSON.
  readonly status?: number;
  readonly terminalReason?: string;
  readonly subtype?: string;
  readonly message?: string;
  // The process exit code: an API rejection exits 0 (CLI 2.1.312) or 1
  // (anthropics/claude-code#103807).
  readonly exitCode: 0 | 1;
  readonly cause: TransportFailureCause;
  // Whether the cause earns another attempt inside the backoff budget.
  readonly retried: boolean;
}

export function claudeErrorEnvelope(row: ClaudeErrorRow): string {
  return JSON.stringify({
    type: "result",
    subtype: row.subtype ?? "success",
    is_error: true,
    ...(row.terminalReason === undefined
      ? {}
      : { terminal_reason: row.terminalReason }),
    ...(row.message === undefined ? {} : { result: row.message }),
    ...(row.status === undefined ? {} : { api_error_status: row.status }),
    usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
  });
}

const SUBSCRIPTION_LIMIT =
  "You've hit your 5-hour limit · resets 12:40pm (Asia/Tokyo)";

export const CLAUDE_ERROR_ROWS: ClaudeErrorRow[] = [
  {
    name: "401 invalid API key",
    status: 401,
    terminalReason: "api_error",
    message: "Invalid API key · Fix external API key",
    exitCode: 0,
    cause: "auth_invalid",
    retried: false,
  },
  {
    name: "401 invalid OAuth token",
    status: 401,
    terminalReason: "api_error",
    message:
      "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    exitCode: 1,
    cause: "auth_invalid",
    retried: false,
  },
  {
    name: "403 permission_error",
    status: 403,
    terminalReason: "api_error",
    message: "permission_error: OAuth is disabled for this organization",
    exitCode: 0,
    cause: "auth_invalid",
    retried: false,
  },
  {
    name: "402 billing_error",
    status: 402,
    terminalReason: "api_error",
    message: "billing_error: There's an issue with your billing",
    exitCode: 0,
    cause: "quota_exhausted",
    retried: false,
  },
  {
    name: "400 credit balance",
    status: 400,
    terminalReason: "api_error",
    message:
      "Credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    exitCode: 0,
    cause: "quota_exhausted",
    retried: false,
  },
  {
    name: "400 workspace usage limit",
    status: 400,
    terminalReason: "api_error",
    message:
      "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
    exitCode: 0,
    cause: "quota_exhausted",
    retried: false,
  },
  {
    name: "400 spend limit wording",
    status: 400,
    terminalReason: "api_error",
    message: "Your organization has reached its monthly spend limit.",
    exitCode: 0,
    cause: "quota_exhausted",
    retried: false,
  },
  {
    name: "429 subscription usage limit (exit 1)",
    status: 429,
    terminalReason: "api_error",
    message: SUBSCRIPTION_LIMIT,
    exitCode: 1,
    cause: "quota_exhausted",
    retried: false,
  },
  {
    name: "429 tier spend cap",
    status: 429,
    terminalReason: "api_error",
    message: "You have exceeded your monthly spend cap for this tier.",
    exitCode: 0,
    cause: "quota_exhausted",
    retried: false,
  },
  {
    name: "429 per-minute rate limit",
    status: 429,
    terminalReason: "api_error",
    message:
      "rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
    exitCode: 0,
    cause: "rate_limit",
    retried: true,
  },
  {
    name: "429 rate limit that says the limit resets",
    status: 429,
    terminalReason: "api_error",
    message: "rate_limit_error: limit reached, it resets in 20 seconds",
    exitCode: 0,
    cause: "rate_limit",
    retried: true,
  },
  {
    name: "429 rate_limit_error",
    status: 429,
    terminalReason: "api_error",
    message: "rate_limit_error: Number of requests has exceeded your limit",
    exitCode: 0,
    cause: "rate_limit",
    retried: true,
  },
  {
    name: "404 model not found",
    status: 404,
    terminalReason: "api_error",
    message:
      "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it.",
    exitCode: 0,
    cause: "model_unavailable",
    retried: false,
  },
  {
    name: "413 request_too_large",
    status: 413,
    terminalReason: "api_error",
    message: "request_too_large: Request exceeds the maximum allowed size",
    exitCode: 0,
    cause: "context_window_exceeded",
    retried: false,
  },
  {
    name: "prompt_too_long terminal reason",
    status: 400,
    terminalReason: "prompt_too_long",
    message: "Prompt is too long",
    exitCode: 0,
    cause: "context_window_exceeded",
    retried: false,
  },
  {
    name: "400 invalid_request_error",
    status: 400,
    terminalReason: "api_error",
    message:
      "invalid_request_error: messages: text content blocks must be non-empty",
    exitCode: 0,
    cause: "provider_configuration_invalid",
    retried: false,
  },
  {
    name: "500",
    status: 500,
    terminalReason: "api_error",
    message: "api_error: Internal server error",
    exitCode: 0,
    cause: "network_transient",
    retried: true,
  },
  {
    name: "502",
    status: 502,
    terminalReason: "api_error",
    message: "Bad gateway",
    exitCode: 0,
    cause: "network_transient",
    retried: true,
  },
  {
    name: "503",
    status: 503,
    terminalReason: "api_error",
    message: "Service unavailable",
    exitCode: 0,
    cause: "rate_limit",
    retried: true,
  },
  {
    name: "service unavailable with no status",
    terminalReason: "api_error",
    message: "API Error: Service Unavailable",
    exitCode: 0,
    cause: "rate_limit",
    retried: true,
  },
  {
    name: "504 timeout_error",
    status: 504,
    terminalReason: "api_error",
    message: "timeout_error: Request timed out",
    exitCode: 0,
    cause: "network_transient",
    retried: true,
  },
  {
    name: "529 overloaded_error",
    status: 529,
    terminalReason: "api_error",
    message: "overloaded_error: Overloaded",
    exitCode: 0,
    cause: "rate_limit",
    retried: true,
  },
  {
    name: "usage limit with no status",
    terminalReason: "api_error",
    message: "You've hit your 5-hour limit · resets 12:40pm (Asia/Tokyo)",
    exitCode: 1,
    cause: "quota_exhausted",
    retried: false,
  },
  {
    name: "overloaded with no status",
    terminalReason: "api_error",
    message: "API Error: overloaded_error",
    exitCode: 0,
    cause: "rate_limit",
    retried: true,
  },
  {
    name: "api_error with no status (connection failure)",
    terminalReason: "api_error",
    message: "API Error: Connection closed mid-response",
    exitCode: 0,
    cause: "network_transient",
    retried: true,
  },
  {
    name: "max_output_tokens",
    terminalReason: "max_output_tokens",
    message: "Output exceeded the max_output_tokens cap",
    exitCode: 0,
    cause: "output_limit_exceeded",
    retried: false,
  },
  {
    name: "error_max_turns subtype",
    subtype: "error_max_turns",
    terminalReason: "max_turns",
    exitCode: 1,
    cause: "output_limit_exceeded",
    retried: false,
  },
  {
    name: "max_turns terminal reason alone",
    terminalReason: "max_turns",
    message: "Reached the maximum number of turns",
    exitCode: 0,
    cause: "output_limit_exceeded",
    retried: false,
  },
  {
    name: "aborted_streaming",
    terminalReason: "aborted_streaming",
    exitCode: 1,
    cause: "network_transient",
    retried: true,
  },
  {
    name: "aborted_tools",
    terminalReason: "aborted_tools",
    exitCode: 1,
    cause: "network_transient",
    retried: true,
  },
  {
    name: "error_during_execution without a status",
    subtype: "error_during_execution",
    exitCode: 1,
    cause: "network_transient",
    retried: true,
  },
  {
    name: "model_error",
    terminalReason: "model_error",
    exitCode: 0,
    cause: "protocol_mismatch",
    retried: false,
  },
  {
    name: "malformed_tool_use_exhausted",
    terminalReason: "malformed_tool_use_exhausted",
    exitCode: 0,
    cause: "protocol_mismatch",
    retried: false,
  },
  {
    name: "Not logged in, no status (the existing witness)",
    terminalReason: "api_error",
    message: "Not logged in · Please run /login",
    exitCode: 1,
    cause: "auth_invalid",
    retried: false,
  },
];
