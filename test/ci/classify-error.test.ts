// T2c unit A (odd/tasks/agent-first-ci.md, S2/S3): classifyCliError maps only
// the error classes whose throw site and catalog text justify a class, by
// instanceof alone. Everything else is unclassified, so the record never guesses
// an owner from a message.

import { describe, expect, test } from "bun:test";
import { classifyCliError } from "#ci/classify-error";
import { CliError } from "../../src/errors";
import {
  AmbiguousMappingError,
  ModelRoutingError,
  UnauthorizedRouteError,
  UnmappedRouteError,
} from "../../src/model/routing";
import {
  admitOpenCodeVersionPair,
  OpenCodeProductionGatedError,
  OpenCodeVersionAdmissionError,
  RouteAdmissionError,
} from "../../src/transport-registry";
import { OpenCodeSdkUnavailableError } from "../../src/transports/opencode-admission";

describe("classifyCliError: the mapped classes", () => {
  test("an unmapped route is route/unmapped", () => {
    expect(classifyCliError(new UnmappedRouteError("x"))).toEqual({
      kind: "route",
      reason: "unmapped",
    });
  });

  test("a duplicate mapping is route/ambiguous", () => {
    expect(classifyCliError(new AmbiguousMappingError("x"))).toEqual({
      kind: "route",
      reason: "ambiguous",
    });
  });

  test("a route whose spend is disabled is route/spend-disabled", () => {
    expect(classifyCliError(new UnauthorizedRouteError("x"))).toEqual({
      kind: "route",
      reason: "spend-disabled",
    });
  });

  test("an OpenCode version the pair does not admit is capability/version_unsupported", () => {
    // The real throw site (transport-registry.ts admitOpenCodeVersionPair), not
    // a hand-built instance, so the test follows the class the code throws.
    let thrown: unknown;
    try {
      admitOpenCodeVersionPair({ sdkVersion: "0.0.0", serverVersion: "0.0.0" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenCodeVersionAdmissionError);
    expect(classifyCliError(thrown)).toEqual({
      kind: "capability",
      issue: "version_unsupported",
    });
  });

  test("an OpenCode SDK that is not installed is capability/sdk_unavailable", () => {
    expect(
      classifyCliError(new OpenCodeSdkUnavailableError("not installed")),
    ).toEqual({ kind: "capability", issue: "sdk_unavailable" });
  });
});

describe("classifyCliError: everything else is unclassified", () => {
  test.each([
    ["a plain Error", new Error("x")],
    ["a CliError, which carries no class", new CliError("x")],
    ["the base model routing error", new ModelRoutingError("x")],
    ["the base route admission error", new RouteAdmissionError("x")],
    [
      "a production gate, which no capability issue names",
      new OpenCodeProductionGatedError([]),
    ],
    ["a string", "x"],
    ["undefined", undefined],
  ])("%s is unknown", (_label, error) => {
    expect(classifyCliError(error)).toEqual({ kind: "unknown" });
  });

  test("a message that reads like a route error does not classify: instanceof only", () => {
    expect(
      classifyCliError(new Error("No route mapping found for logical model x")),
    ).toEqual({ kind: "unknown" });
  });
});
