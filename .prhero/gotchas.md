# pr-hero gotchas

Repo-specific facts a reviewer cannot infer from the diff. Injected verbatim
into every hunter's system prompt, so each line has to earn its tokens.

- Schema compatibility with the sibling lab (`../deep-review`) is deliberate
  and load-bearing: `src/findings.ts` mirrors the lab's validator, and hunter
  keys are pinned to the `reliability|resilience|parity|lifecycle` enum until a
  coordinated v1.1 bump. A key or field that looks "missing" is usually frozen
  on purpose — check C2 in `docs/history/ROADMAP-2026-07-to-10.md` (the
  archived roadmap) before calling it a defect.
- The isolation flags in `src/step-runner.ts` (`--strict-mcp-config`,
  `--setting-sources ""`, no Write/Task/Bash for agents, driver owns every file
  write) are a threat model, not preferences. They look over-restrictive; each
  one encodes a contamination incident. Tests assert them.
- The retry ordering, truncated-draft guard and watchdog constants in
  `src/step-runner.ts` are ported from a v1 engine that paid for each of them
  in failed overnight runs. Their WHY comments are the specification; the
  numbers are not arbitrary and are not tunable defaults.
- `runPipeline` deliberately never runs git and never writes `outPath`. The
  caller generates the diff and calls `mergeRunEnvelope` + `writeFindings`.
  That is a boundary, not an omission.
- `src/dedupe.ts` refuses to collapse symbol-less findings, and
  `src/root-cause.ts` clusters only on the FIRST proof_ref with no transitive
  union. Both are deliberate under-merging: over-merging flatters the engine's
  precision, so the error direction is chosen, not accidental.
- `src/root-cause.ts` is measurement only. Nothing there may delete, reorder,
  retier or renumber a finding — the lab's scorer reads `findings[]` alone.
- Everything under `src/` must stay pure-testable and offline: `bun test` never
  spawns a real model. Live evals live in `scripts/`, which neither `bun run
  check` nor `bun run typecheck` covers.
