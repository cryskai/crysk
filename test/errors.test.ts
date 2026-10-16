// The CLI error classes and the record class they can carry (odd/tasks/agent-first-ci.md,
// T2d-1 / S2). A class is data on the error; the message is never changed by it, so
// local output that prints the message stays byte-identical.

import { describe, expect, test } from "bun:test";
import { classifyCliError } from "#ci/classify-error";
import {
  CliError,
  CliUsageError,
  recordClassOf,
  withRecordClass,
  withUsageClass,
} from "../src/errors";

describe("CliError and CliUsageError carry an optional record class", () => {
  test("a CliError without a class has none, and keeps its message", () => {
    const error = new CliError("plain");
    expect(error.cls).toBeUndefined();
    expect(error.message).toBe("plain");
  });

  test("a CliError stores the class it was given, and keeps its message", () => {
    const error = new CliError("gotchas missing", {
      cls: { kind: "gotchas", reason: "placeholder" },
    });
    expect(error.cls).toEqual({ kind: "gotchas", reason: "placeholder" });
    expect(error.message).toBe("gotchas missing");
    expect(error).toBeInstanceOf(CliError);
  });

  test("a CliUsageError stores the class it was given, and keeps its message", () => {
    const error = new CliUsageError("bad key", {
      cls: { kind: "config-parse", source: "repo-config" },
    });
    expect(error.cls).toEqual({ kind: "config-parse", source: "repo-config" });
    expect(error.message).toBe("bad key");
    expect(error).toBeInstanceOf(CliUsageError);
  });
});

describe("an unset class adds no own property to a CLI error", () => {
  // WHY pinned: Bun prints an error's enumerable own properties when it is uncaught.
  // A `cls: undefined` own property shows up there as a new line in the local output.
  test("a CliError without a class has no own enumerable property", () => {
    expect(Object.keys(new CliError("x"))).toEqual([]);
  });

  test("a CliUsageError without a class has no own enumerable property", () => {
    expect(Object.keys(new CliUsageError("x"))).toEqual([]);
  });

  test("a CliError with a class stores it as its own property, and classifyCliError reads it", () => {
    const error = new CliError("x", { cls: { kind: "invariant" } });
    expect(Object.keys(error)).toEqual(["cls"]);
    expect(error.cls).toEqual({ kind: "invariant" });
    expect(classifyCliError(error)).toEqual({ kind: "invariant" });
  });

  test("a CliUsageError with a class stores it as its own property, and classifyCliError reads it", () => {
    const error = new CliUsageError("x", { cls: { kind: "invariant" } });
    expect(Object.keys(error)).toEqual(["cls"]);
    expect(error.cls).toEqual({ kind: "invariant" });
    expect(classifyCliError(error)).toEqual({ kind: "invariant" });
  });
});

describe("withUsageClass", () => {
  test("gives a classless CliUsageError the class, with the same message", () => {
    let thrown: unknown;
    try {
      withUsageClass({ kind: "config-parse", source: "extra-hunters" }, () => {
        throw new CliUsageError("PRHERO_EXTRA_HUNTERS[0] must be key:file.md");
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as CliUsageError).cls).toEqual({
      kind: "config-parse",
      source: "extra-hunters",
    });
    expect((thrown as CliUsageError).message).toBe(
      "PRHERO_EXTRA_HUNTERS[0] must be key:file.md",
    );
  });

  test("keeps a class the error already carries", () => {
    let thrown: unknown;
    try {
      withUsageClass({ kind: "config-parse", source: "repo-config" }, () => {
        throw new CliUsageError("routing bad", {
          cls: { kind: "config-parse", source: "routing" },
        });
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as CliUsageError).cls).toEqual({
      kind: "config-parse",
      source: "routing",
    });
  });

  test("passes other errors through unchanged, and returns the value on success", () => {
    const other = new Error("not a usage error");
    expect(() =>
      withUsageClass({ kind: "unknown" }, () => {
        throw other;
      }),
    ).toThrow(other);
    expect(withUsageClass({ kind: "unknown" }, () => 42)).toBe(42);
  });
});

describe("withRecordClass: a record class beside a plain error", () => {
  test("returns the same error object, with the class recorded for it", () => {
    const thrown = new Error("agent file has no frontmatter block");
    const returned = withRecordClass(thrown, { kind: "prompt-set" });
    expect(returned).toBe(thrown);
    expect(recordClassOf(thrown)).toEqual({ kind: "prompt-set" });
    expect(thrown.message).toBe("agent file has no frontmatter block");
  });

  test("stays a plain Error, not a CliError, so main() keeps the uncaught path", () => {
    // WHY pinned: main() in src/cli.ts prints a CliError as one line and lets every
    // other error take the uncaught path that local runs have always used.
    const error = withRecordClass(new Error("x"), { kind: "prompt-set" });
    expect(error).not.toBeInstanceOf(CliError);
    expect(error.name).toBe("Error");
  });

  test("adds no enumerable property, so the uncaught print shows nothing new", () => {
    // WHY pinned: Bun prints an error's enumerable own properties when it is
    // uncaught. A class stored as a property would appear in the local output.
    const error = withRecordClass(new Error("x"), { kind: "prompt-set" });
    expect(Object.keys(error)).toEqual([]);
  });

  test("a plain error with no class recorded has none", () => {
    expect(recordClassOf(new Error("x"))).toBeUndefined();
    expect(recordClassOf("not an object")).toBeUndefined();
    expect(recordClassOf(undefined)).toBeUndefined();
  });

  test("the classifier reads the recorded class", () => {
    expect(
      classifyCliError(withRecordClass(new Error("x"), { kind: "prompt-set" })),
    ).toEqual({ kind: "prompt-set" });
  });
});
