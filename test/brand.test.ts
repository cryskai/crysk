import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readBrandEnv } from "../src/brand";

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

  test("a set but empty CRYSK_ value still wins over the legacy name", () => {
    expect(
      readBrandEnv({ CRYSK_NO_TUI: "", PRHERO_NO_TUI: "1" }, "NO_TUI"),
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
    const direct = /env\.PRHERO_(AGENTS_DIR|EXTRA_HUNTERS|NO_TUI)\b/;
    const offenders = files.filter((file) =>
      direct.test(readFileSync(path.join(srcDir, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
