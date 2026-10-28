import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  findMarker,
  isCommand,
  MARKER_BRAND_PATTERN,
  matchMarkerPrefix,
  readBrandEnv,
  startsWithCommand,
} from "../src/brand";

describe("readBrandEnv", () => {
  test("reads the new CRYSK_ name first", () => {
    expect(
      readBrandEnv(
        { CRYSK_AGENTS_DIR: "new", PRHERO_AGENTS_DIR: "old" },
        "AGENTS_DIR",
      ),
    ).toEqual({ value: "new", name: "CRYSK_AGENTS_DIR" });
  });

  test("falls back to the legacy PRHERO_ name", () => {
    expect(readBrandEnv({ PRHERO_AGENTS_DIR: "old" }, "AGENTS_DIR")).toEqual({
      value: "old",
      name: "PRHERO_AGENTS_DIR",
    });
  });

  test("returns undefined when neither name is set", () => {
    expect(readBrandEnv({}, "AGENTS_DIR")).toBeUndefined();
  });

  test("an empty CRYSK_ value falls back to a non-empty legacy value", () => {
    expect(
      readBrandEnv(
        { CRYSK_AGENTS_DIR: "", PRHERO_AGENTS_DIR: "/x" },
        "AGENTS_DIR",
      ),
    ).toEqual({ value: "/x", name: "PRHERO_AGENTS_DIR" });
  });

  test("a variable set but empty still counts as set when nothing has a value", () => {
    expect(readBrandEnv({ CRYSK_NO_TUI: "" }, "NO_TUI")).toEqual({
      value: "",
      name: "CRYSK_NO_TUI",
    });
    expect(
      readBrandEnv({ CRYSK_NO_TUI: "", PRHERO_NO_TUI: "" }, "NO_TUI"),
    ).toEqual({ value: "", name: "CRYSK_NO_TUI" });
  });
});

// init reads the real home dir and the bare entry reads the real TTY, so
// neither can be driven end to end here. This guard pins the wiring instead:
// a direct read of a user-set PRHERO_ variable would skip the CRYSK_ name.
describe("user-set env vars go through readBrandEnv", () => {
  test("no src file reads them straight from the environment", () => {
    const srcDir = path.resolve(import.meta.dir, "../src");
    const files = readdirSync(srcDir, {
      recursive: true,
      encoding: "utf8",
    }).filter((file) => file.endsWith(".ts"));
    // Dot access, bracket access, or a destructure of any PRHERO_ variable.
    const direct =
      /env(?:\.|\[\s*["'`])PRHERO_|\{[^}]*\bPRHERO_\w+[^}]*\}\s*=\s*[\w.]*env\b/;
    const offenders = files.filter((file) =>
      direct.test(readFileSync(path.join(srcDir, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("comment markers read both names", () => {
  const prefix = "<!-- crysk-finding ";

  test("matchMarkerPrefix returns the new prefix when the body uses it", () => {
    expect(matchMarkerPrefix("<!-- crysk-finding path=a -->", prefix)).toBe(
      prefix,
    );
  });

  test("matchMarkerPrefix returns the legacy prefix for an old comment", () => {
    expect(matchMarkerPrefix("<!-- pr-hero-finding path=a -->", prefix)).toBe(
      "<!-- pr-hero-finding ",
    );
  });

  test("matchMarkerPrefix does not match a marker quoted mid-body", () => {
    expect(
      matchMarkerPrefix("see <!-- crysk-finding path=a -->", prefix),
    ).toBeUndefined();
  });

  test("matchMarkerPrefix works on a full marker without a trailing space", () => {
    expect(
      matchMarkerPrefix(
        "<!-- pr-hero-skip-size -->\nbody",
        "<!-- crysk-skip-size -->",
      ),
    ).toBe("<!-- pr-hero-skip-size -->");
  });

  test("findMarker returns the earliest of the two forms", () => {
    const body = "x\n<!-- pr-hero-state v=1 -->\n<!-- crysk-state v=1 -->";
    expect(findMarker(body, "<!-- crysk-state ")).toEqual({
      index: 2,
      prefix: "<!-- pr-hero-state ",
    });
    expect(findMarker("nothing", "<!-- crysk-state ")).toBeUndefined();
  });

  test("MARKER_BRAND_PATTERN matches both names inside a RegExp", () => {
    const re = new RegExp(`^<!-- ${MARKER_BRAND_PATTERN}-report -->$`);
    expect(re.test("<!-- crysk-report -->")).toBe(true);
    expect(re.test("<!-- pr-hero-report -->")).toBe(true);
    expect(re.test("<!-- other-report -->")).toBe(false);
  });
});

describe("PR commands accept both names", () => {
  test("isCommand matches the written form exactly after trimming", () => {
    expect(isCommand("/crysk review", "/crysk review")).toBe(true);
    expect(isCommand("  /crysk review\n", "/crysk review")).toBe(true);
  });

  test("isCommand also matches the legacy /pr-hero form", () => {
    expect(isCommand("/pr-hero review --full", "/crysk review --full")).toBe(
      true,
    );
  });

  test("isCommand is not loose: no extra words, case, or mixed names", () => {
    for (const body of [
      "/crysk review please",
      "/CRYSK review",
      "/crysk  review",
      "/crysk-review",
      "please /crysk review",
      "/pr-hero /crysk review",
    ]) {
      expect(isCommand(body, "/crysk review")).toBe(false);
    }
  });

  test("startsWithCommand matches either name at the start of the trimmed text", () => {
    expect(startsWithCommand("/crysk review please", "/crysk review")).toBe(
      true,
    );
    expect(startsWithCommand(" /pr-hero review please", "/crysk review")).toBe(
      true,
    );
    expect(startsWithCommand("please /crysk review", "/crysk review")).toBe(
      false,
    );
  });

  test("a command that is not written in the new form is a bug", () => {
    expect(() => isCommand("/pr-hero review", "/pr-hero review")).toThrow(
      "not a crysk command",
    );
  });
});
