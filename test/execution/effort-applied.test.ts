// S7 (E-g, E2): the one answer to "was the backend sent an effort", read by
// the request plan (attempt-evidence.ts), pipeline.json's step rows and each
// model_attempts row.
import { describe, expect, test } from "bun:test";
import {
  effortApplied,
  type ResolvedModelRoute,
} from "../../src/execution/contracts";

const CLAUDE: ResolvedModelRoute = {
  backend: "claude-code",
  provider: "anthropic",
  modelFamily: "sonnet",
  modelSnapshot: "sonnet",
};
const GPT: ResolvedModelRoute = {
  backend: "opencode",
  provider: "openai",
  modelFamily: "gpt-5",
  modelSnapshot: "gpt-5",
};

describe("effortApplied", () => {
  test("the Claude CLI is always sent --effort", () => {
    expect(effortApplied(CLAUDE)).toBe(true);
  });

  test("OpenCode only when an entry's effort set the variant", () => {
    expect(effortApplied(GPT)).toBe(false);
    expect(effortApplied({ ...GPT, modelVariant: "high" })).toBe(true);
  });
});
