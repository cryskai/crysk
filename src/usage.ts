// Usage accounting for spawned engine sessions (`--output-format json`).
// Ported from deep-review runner/session.ts — paid-for lessons, not new code.

export interface SessionUsage {
  wall_ms: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
}

interface RawSessionResult {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// Session-total tokens is the MUST (Rec-R3); per-agent attribution is a
// documented SHOULD/best-effort gap — `--output-format json` only exposes the
// session aggregate (verified against a live headless run), never a
// per-hunter/refuter breakdown, so this slice does not populate it.
// (v2 note: each step IS its own session now, so this "session aggregate"
// becomes exactly the per-agent number v1 could not measure.)
export function parseUsage(rawStdout: string, wall_ms: number): SessionUsage {
  let parsed: RawSessionResult;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return {
      wall_ms,
      tokens_in: 0,
      tokens_out: 0,
      tokens_total: 0,
    };
  }
  const usage = parsed.usage ?? {};
  const tokens_in =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const tokens_out = usage.output_tokens ?? 0;
  return {
    wall_ms,
    tokens_in,
    tokens_out,
    tokens_total: tokens_in + tokens_out,
  };
}

export function zeroUsage(): SessionUsage {
  return {
    wall_ms: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_total: 0,
  };
}

// Accumulate usage across the attempts of one step: a failed attempt's tokens
// still cost money, so a StepResult must report what the step actually spent,
// never just what its successful attempt spent.
export function sumUsage(a: SessionUsage, b: SessionUsage): SessionUsage {
  return {
    wall_ms: a.wall_ms + b.wall_ms,
    tokens_in: a.tokens_in + b.tokens_in,
    tokens_out: a.tokens_out + b.tokens_out,
    tokens_total: a.tokens_total + b.tokens_total,
  };
}
