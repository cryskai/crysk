// odd/tasks/role-model-routing.md E-f F2 (L37, L39, D4): a config key that is
// a pasted credential is never echoed in the unknown-key message, whether it
// is a known key shape or a long plain hex or base64 value.
import { describe, expect, test } from "bun:test";
import { parseGlobalConfig } from "#review/preflight";

const GROQ_KEY = `gsk_${"a1B2c3D4e5".repeat(5)}Zz`;
const HEX_64 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const BASE64_KEY = "dGhpc0lzTm90QVJlYWxLZXlCdXRMb29rc0xpa2VPbmUxMjM0NTY3OA==";

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

describe("a credential-shaped config key is never echoed (F2)", () => {
  test("an unknown top-level key", () => {
    for (const secret of [GROQ_KEY, HEX_64, BASE64_KEY]) {
      const message = messageOf(() =>
        parseGlobalConfig(JSON.stringify({ [secret]: {} })),
      );
      expect(message).toBe("~/.crysk/config.json unknown key: [REDACTED]");
    }
  });

  test("an unknown credentials key", () => {
    for (const secret of [GROQ_KEY, HEX_64, BASE64_KEY]) {
      const message = messageOf(() =>
        parseGlobalConfig(JSON.stringify({ credentials: { [secret]: [] } })),
      );
      expect(message).toStartWith(
        '~/.crysk/config.json credentials has an unknown key "[REDACTED]": only claude is supported',
      );
      expect(message).not.toContain(secret);
    }
  });

  // Touched existing behavior: an ordinary unknown key is still named.
  test("an ordinary unknown credentials key is still named", () => {
    expect(
      messageOf(() =>
        parseGlobalConfig(JSON.stringify({ credentials: { openai: [] } })),
      ),
    ).toStartWith(
      '~/.crysk/config.json credentials has an unknown key "openai"',
    );
  });
});
