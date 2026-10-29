import { describe, expect, test } from "bun:test";
import path from "node:path";

// `init` is not exported as a testable-in-isolation shell in the usual
// sense — it reads the real `os.homedir()`, so driving it end-to-end would
// make this suite depend on the machine's `~/.crysk/config.json`). Its
// DECISION lives in `initGotchasInstructions` and is tested exhaustively in
// test/review/preflight.test.ts; what is left to guard here is the wiring —
// that `init` routes through that helper instead of printing the block
// again itself. Source-shape, like the count assertions in
// test/cli.test.ts's "every gotchas gate asks the shared predicate", and for
// the same reason. Moved here from test/cli.test.ts (cli-decomp S3) when
// `init` moved to src/commands/init.ts — the source-text needle now lives at
// its new home.
describe("init — gotchas block wiring", () => {
  test("`pr-hero init` prints its gotchas block through initGotchasInstructions", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../../src/commands/init.ts"),
    ).text();

    expect(source).toContain(
      "initGotchasInstructions(gotchasOutcome, dirName)",
    );
    // Both arms of the decision are present, so the helper cannot be called
    // with a constant.
    expect(source).toContain("wrote.includes(gotchasPath)");
    expect(source).toContain("{ written: true }");
    expect(source).toContain("written: false");

    // The assertions themselves moved out. If any of these come back to
    // src/commands/init.ts, they are unconditional again — which is the
    // defect.
    for (const needle of [
      "replace the <subsystem> lines",
      "marker line at the top",
      "refuses to review while that marker is present",
    ]) {
      expect(source).not.toContain(needle);
    }
  });
});
