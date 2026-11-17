import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalStatusText,
  commandHint,
  commandLine,
  findMarker,
  isCommand,
  isLegacyStatusContext,
  isStatusContext,
  LOCAL_STATUS_CONTEXT,
  MARKER_BRAND_PATTERN,
  matchMarkerPrefix,
  readBrandEnv,
  STATUS_CONTEXT,
  startsWithCommand,
  statusContextForms,
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

// The legacy `/pr-hero` spelling stopped being a command on 2026-11-17: only `/crysk` is accepted.
describe("PR commands accept only the /crysk name", () => {
  test("isCommand matches the written form exactly after trimming", () => {
    expect(isCommand("/crysk review", "/crysk review")).toBe(true);
    expect(isCommand("  /crysk review\n", "/crysk review")).toBe(true);
  });

  test("the legacy /pr-hero form is no longer a command", () => {
    for (const command of [
      "/crysk review",
      "/crysk review --full",
      "/crysk recheck",
      "/crysk override",
      "/crysk stop",
    ]) {
      const legacy = command.replace("/crysk", "/pr-hero");
      expect(isCommand(legacy, command)).toBe(false);
      expect(startsWithCommand(`${legacy} please`, command)).toBe(false);
    }
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

  test("a command followed by other lines is the command", () => {
    expect(
      isCommand("/crysk review\n\nGenerated by Claude Code", "/crysk review"),
    ).toBe(true);
    for (const command of [
      "/crysk review --full",
      "/crysk recheck",
      "/crysk override",
      "/crysk stop",
    ]) {
      expect(isCommand(`${command}\n\nGenerated by Claude Code`, command)).toBe(
        true,
      );
    }
  });

  test("the first line must still be exact", () => {
    for (const body of [
      "/crysk review please\nsigned",
      "please\n/crysk review",
      "> /crysk review\n\nok",
      "/Crysk review\nsigned",
      "/crysk  review\nsigned",
      "/crysk review --full\nsigned",
    ]) {
      expect(isCommand(body, "/crysk review")).toBe(false);
    }
    expect(isCommand("/crysk review\nsigned", "/crysk review --full")).toBe(
      false,
    );
  });

  test("startsWithCommand looks only at the first line", () => {
    expect(
      startsWithCommand("note\n/crysk review please", "/crysk review"),
    ).toBe(false);
    expect(startsWithCommand("/crysk review please\nx", "/crysk review")).toBe(
      true,
    );
  });

  test("commandLine is the trimmed first line", () => {
    expect(commandLine("  /crysk review \n\nGenerated by X")).toBe(
      "/crysk review",
    );
    expect(commandLine("/crysk review\r\nsigned")).toBe("/crysk review");
    expect(commandLine("\n\n/crysk stop\nmore")).toBe("/crysk stop");
    expect(commandLine("")).toBe("");
  });

  test("startsWithCommand matches the command at the start of the trimmed text", () => {
    expect(startsWithCommand("/crysk review please", "/crysk review")).toBe(
      true,
    );
    expect(startsWithCommand(" /crysk review please", "/crysk review")).toBe(
      true,
    );
    expect(startsWithCommand("please /crysk review", "/crysk review")).toBe(
      false,
    );
  });

  test("a command that is not written in the /crysk form is a bug", () => {
    expect(() => isCommand("/pr-hero review", "/pr-hero review")).toThrow(
      "not a crysk command",
    );
  });
});

describe("command hints name the one command", () => {
  test("commandHint names the /crysk form, quoted or plain", () => {
    expect(commandHint("/crysk recheck")).toBe("`/crysk recheck`");
    expect(commandHint("/crysk recheck", "")).toBe("/crysk recheck");
  });
});

// The rename publishes every commit status on both names for one version: users keep
// `pr-hero` as a required check in branch protection, and a head that stops getting that
// context blocks forever.
describe("commit status contexts", () => {
  test("the contexts are written in the new name", () => {
    expect(STATUS_CONTEXT).toBe("crysk");
    expect(LOCAL_STATUS_CONTEXT).toBe("crysk/local");
  });

  test("a context is published on its own name first, then the legacy one", () => {
    expect(statusContextForms(STATUS_CONTEXT)).toEqual(["crysk", "pr-hero"]);
    expect(statusContextForms(LOCAL_STATUS_CONTEXT)).toEqual([
      "crysk/local",
      "pr-hero/local",
    ]);
  });

  test("only a crysk context has forms", () => {
    expect(() => statusContextForms("pr-hero")).toThrow();
    expect(() => statusContextForms("crysk-other")).toThrow();
  });

  test("isStatusContext matches either name of the same context and nothing else", () => {
    expect(isStatusContext("crysk", STATUS_CONTEXT)).toBe(true);
    expect(isStatusContext("pr-hero", STATUS_CONTEXT)).toBe(true);
    expect(isStatusContext("crysk/local", STATUS_CONTEXT)).toBe(false);
    expect(isStatusContext("pr-hero/local", STATUS_CONTEXT)).toBe(false);
    expect(isStatusContext("ci", STATUS_CONTEXT)).toBe(false);
    expect(isStatusContext("pr-hero/local", LOCAL_STATUS_CONTEXT)).toBe(true);
    expect(isStatusContext("pr-hero", LOCAL_STATUS_CONTEXT)).toBe(false);
  });

  test("isLegacyStatusContext names the old spelling, local included", () => {
    expect(isLegacyStatusContext("pr-hero")).toBe(true);
    expect(isLegacyStatusContext("pr-hero/local")).toBe(true);
    expect(isLegacyStatusContext("crysk")).toBe(false);
    expect(isLegacyStatusContext("crysk/local")).toBe(false);
  });
});

describe("canonicalStatusText", () => {
  test("a legacy lead word becomes the new one, colon form and plain form", () => {
    expect(canonicalStatusText("pr-hero: 2 blocking finding(s)")).toBe(
      "crysk: 2 blocking finding(s)",
    );
    expect(canonicalStatusText("pr-hero skipped the review: x")).toBe(
      "crysk skipped the review: x",
    );
    expect(canonicalStatusText("pr-hero reviewing")).toBe("crysk reviewing");
  });

  test("a text that already leads with the new name, or with neither, is unchanged", () => {
    expect(canonicalStatusText("crysk: review posted")).toBe(
      "crysk: review posted",
    );
    expect(canonicalStatusText("review posted")).toBe("review posted");
    expect(canonicalStatusText("CRYSK-CANCELLED: not reviewed")).toBe(
      "CRYSK-CANCELLED: not reviewed",
    );
    // A word that merely starts with the old name is not the old lead.
    expect(canonicalStatusText("pr-heroic: x")).toBe("pr-heroic: x");
  });

  // PR #549 R001: a status an earlier release wrote names the legacy command.
  test("a legacy command in the text becomes the /crysk one", () => {
    expect(
      canonicalStatusText(
        "pr-hero: 2 blocking finding(s) — fix and push, or /pr-hero override",
      ),
    ).toBe("crysk: 2 blocking finding(s) — fix and push, or /crysk override");
    expect(canonicalStatusText("crysk: x — /pr-hero review retries it")).toBe(
      "crysk: x — /crysk review retries it",
    );
    expect(canonicalStatusText("/pr-hero reviewing")).toBe(
      "/pr-hero reviewing",
    );
  });
});
