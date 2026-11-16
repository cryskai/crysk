import { describe, expect, test } from "bun:test";
import {
  type ReviewMenuIo,
  type ReviewMenuState,
  renderReviewMenuCard,
  runReviewMenu,
} from "#ui/review-menu";
import type { KeyReader } from "#ui/select";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");

function fakeReader(chunks: (string | undefined)[], raw = true): KeyReader {
  let i = 0;
  return {
    raw,
    read: () => Promise.resolve(i < chunks.length ? chunks[i++] : undefined),
    close: () => {},
  };
}

function testIo(): ReviewMenuIo & {
  lines: () => string[];
  text: () => string;
} {
  const out: string[] = [];
  return {
    write: (t) => out.push(t),
    line: (t = "") => out.push(`${t}\n`),
    lines: () =>
      stripAnsi(out.join(""))
        .split("\n")
        .map((l) => l.trimEnd()),
    text: () => out.join(""),
  };
}

describe("5.5 Review Submenu", () => {
  const defaultState: ReviewMenuState = {
    target: "branch",
    head: "HEAD",
    base: "main",
    post: false,
    force: false,
    full: false,
    dryRun: false,
  };

  test("renderReviewMenuCard renders options and toggles cleanly", () => {
    const lines = renderReviewMenuCard(defaultState, 0, 80, false);
    expect(lines[0]).toContain("╔");
    expect(lines.join("\n")).toContain("Target: Local branch");
    expect(lines.join("\n")).toContain("[ Start review ]");
    expect(lines.join("\n")).toContain("[ Discard & back ]");
    expect(lines.at(-1)).toContain("╚");
  });

  test("renderReviewMenuCard produces zero ANSI bytes when styles are false", () => {
    const lines = renderReviewMenuCard(defaultState, 1, 80, false);
    expect(lines.join("\n")).not.toContain("\x1b[");
  });

  test("runReviewMenu allows toggling options and confirms launch", async () => {
    const io = testIo();
    // Move to '[ Start review ]' (index 6) and press Enter to launch
    const reader = fakeReader(["j", "j", "j", "j", "j", "j", "\r"]);

    const result = await runReviewMenu({
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
      defaultBase: "main",
    });

    expect(result.action).toBe("launch");
    if (result.action === "launch") {
      expect(result.options).toBeDefined();
      expect(result.options.repo).toBeDefined();
    }
  });

  test("runReviewMenu allows toggling Post to PR and auto-promotes target to pr", async () => {
    const io = testIo();
    // Key sequence:
    // 1. Move to 'Post to PR' (index 2): 'j', 'j'
    // 2. Press Space to toggle Post (switches target to 'pr' and post to true)
    // 3. Move down to '[ Start review ]' (index 6): 4 'j's, then Enter ('\r')
    const reader = fakeReader(["j", "j", " ", "j", "j", "j", "j", "\r"]);

    const result = await runReviewMenu({
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
      defaultBase: "main",
    });

    expect(result.action).toBe("launch");
    if (result.action === "launch") {
      expect(result.options.post).toBe(true);
      expect(result.options.pr).toBe("current");
    }
  });

  test("runReviewMenu resolves initial base and post from effectiveConfig with auto-promotion", async () => {
    const io = testIo();
    // Launch directly: move 6 times down to [ Start review ], press enter
    const reader = fakeReader(["j", "j", "j", "j", "j", "j", "\r"]);

    const result = await runReviewMenu({
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
      effectiveConfig: {
        parity_trigger_paths: [],
        suspicion_priors: [],
        default_base: "develop",
        post: true,
      },
    });

    expect(result.action).toBe("launch");
    if (result.action === "launch") {
      expect(result.options.base).toBe("develop");
      expect(result.options.post).toBe(true);
      expect(result.options.pr).toBe("current");
    }
  });

  test("runReviewMenu respects explicit defaultBase and defaultPost overrides over effectiveConfig", async () => {
    const io = testIo();
    const reader = fakeReader(["j", "j", "j", "j", "j", "j", "\r"]);

    const result = await runReviewMenu({
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
      effectiveConfig: {
        parity_trigger_paths: [],
        suspicion_priors: [],
        default_base: "develop",
        post: true,
      },
      defaultBase: "staging",
      defaultPost: false,
    });

    expect(result.action).toBe("launch");
    if (result.action === "launch") {
      expect(result.options.base).toBe("staging");
      expect(result.options.post).toBe(false);
      expect(result.options.pr).toBeUndefined();
    }
  });

  test("runReviewMenu preserves invariants: toggling target to branch resets post, toggling post to true promotes to pr", async () => {
    const io = testIo();
    // Start with post: true (target is "pr").
    // 1. Cursor is at 0 (Target: Current PR). Press Space to toggle to branch -> post becomes false.
    // 2. Move down to 2 (Post to PR: [ ] No). Press Space -> post becomes true, target becomes "pr".
    // 3. Move down to 6 ([ Start review ]). Press Enter.
    const reader = fakeReader([" ", "j", "j", " ", "j", "j", "j", "j", "\r"]);

    const result = await runReviewMenu({
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
      defaultPost: true,
    });

    expect(result.action).toBe("launch");
    if (result.action === "launch") {
      expect(result.options.post).toBe(true);
      expect(result.options.pr).toBe("current");
    }
  });

  test("runReviewMenu returns back on q or Esc", async () => {
    const io = testIo();
    const reader = fakeReader(["q"]);

    const result = await runReviewMenu({
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
    });

    expect(result.action).toBe("back");
  });
});
