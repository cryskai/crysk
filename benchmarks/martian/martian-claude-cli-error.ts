// Why a `claude -p --output-format json` spawn failed, in words a human can act on.
//
// The CLI reports API failures (a usage limit, a 429, an overloaded model) on
// STDOUT as a JSON envelope with `is_error` and `result`, and exits 1 with an
// empty stderr. Reading only stderr turned every such failure into
// `claude exited 1: ` — 609 of them on the 2026-11-13 Martian judge pass, with
// the cause ("You've hit your 5-hour limit · resets 9:20pm") one field away.
export function claudeCliFailure(
  code: number,
  stdout: string,
  stderr: string,
): string {
  const detail = envelopeResult(stdout) ?? (stderr.trim() || stdout.trim());
  return `claude exited ${code}: ${detail.slice(-500)}`;
}

function envelopeResult(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: unknown;
      api_error_status?: unknown;
    };
    if (typeof parsed.result !== "string" || parsed.result === "") {
      return undefined;
    }
    const status =
      typeof parsed.api_error_status === "number"
        ? ` (HTTP ${parsed.api_error_status})`
        : "";
    return `${parsed.result}${status}`;
  } catch {
    return undefined;
  }
}
