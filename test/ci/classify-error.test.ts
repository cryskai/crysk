// T2c unit A (odd/tasks/agent-first-ci.md, S2/S3): classifyCliError maps only
// the error classes whose throw site and catalog text justify a class, by
// instanceof alone. Everything else is unclassified, so the record never guesses
// an owner from a message.

import { describe, expect, test } from "bun:test";
import { classifyCliError } from "#ci/classify-error";
import { parseGlobalConfig, parseRoutingConfig } from "#review/preflight";
import { CliError, CliUsageError, withRecordClass } from "../../src/errors";
import {
  AmbiguousMappingError,
  ModelRoutingError,
  UnauthorizedRouteError,
  UnmappedRouteError,
} from "../../src/model/routing";
import {
  admitOpenCodeVersionPair,
  DefaultTransportRegistry,
  OpenCodeProductionGatedError,
  OpenCodeVersionAdmissionError,
  RouteAdmissionError,
  SUPPORTED_OPENCODE_SDK_VERSION,
  SUPPORTED_OPENCODE_SERVER_VERSION,
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

  test("an OpenCode identity production cannot observe is unknown, not a version mismatch", () => {
    // The real throw site: production, with evidence that passes the D1-11 gate
    // (so the gate is not the one that throws) and no observed identity.
    const ready = {
      sdkAvailable: true,
      credentialAuthority: true,
      workspaceBroker: true,
      pricingReady: true,
    };
    let thrown: unknown;
    try {
      new DefaultTransportRegistry({ mode: "production" }).get("opencode", {
        evidence: new Map([["opencode", ready]]),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenCodeVersionAdmissionError);
    expect(classifyCliError(thrown)).toEqual({ kind: "unknown" });
  });

  test("declared OpenCode versions that contradict the observed identity are unknown, not a version mismatch", () => {
    // The real throw site: each declared version is admitted on its own, and
    // only the pair disagrees with the identity that was observed.
    let thrown: unknown;
    try {
      new DefaultTransportRegistry({ mode: "conformance" }).get("opencode", {
        observedOpenCodeIdentity: {
          sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION,
          serverVersion: SUPPORTED_OPENCODE_SERVER_VERSION,
          executablePath: "/fixture/opencode",
          executableSha256: "fixture",
        },
        serverVersion: "1.18.23",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenCodeVersionAdmissionError);
    expect(classifyCliError(thrown)).toEqual({ kind: "unknown" });
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

// T2d-1 (S2): a throw site that knows its class says so on the error, and the
// classifier reads that class before its instanceof mapping.
describe("classifyCliError: the class an error carries", () => {
  test("a CliError's own class wins", () => {
    expect(
      classifyCliError(
        new CliError("gotchas", { cls: { kind: "gotchas", reason: "empty" } }),
      ),
    ).toEqual({ kind: "gotchas", reason: "empty" });
  });

  test("a CliUsageError's own class wins", () => {
    expect(
      classifyCliError(
        new CliUsageError("bad", {
          cls: { kind: "config-parse", source: "extra-hunters" },
        }),
      ),
    ).toEqual({ kind: "config-parse", source: "extra-hunters" });
  });

  test("a plain error with a recorded class is read by its class", () => {
    expect(
      classifyCliError(withRecordClass(new Error("x"), { kind: "prompt-set" })),
    ).toEqual({ kind: "prompt-set" });
  });

  test("the invariant class is read from a CliError", () => {
    expect(
      classifyCliError(
        new CliError("internal: pipeline returned no result", {
          cls: { kind: "invariant" },
        }),
      ),
    ).toEqual({ kind: "invariant" });
  });
});

// The routing class renders PRH-ROUTING-INVALID, whose text names PRHERO_ROUTING. The
// person file's routing error must not take it; the routing parser itself keeps it.
describe("classifyCliError: the routing class depends on the layer that parsed", () => {
  function thrownBy(thrower: () => unknown): unknown {
    try {
      thrower();
    } catch (error) {
      return error;
    }
    throw new Error("expected the parser to throw");
  }

  test("a routing error in the person file is unclassified, same message", () => {
    const error = thrownBy(() => parseGlobalConfig('{"routing": "invalid"}'));
    expect(error).toBeInstanceOf(CliUsageError);
    expect((error as CliUsageError).message).toBe(
      "~/.prhero/config.json routing must be an object",
    );
    expect(classifyCliError(error)).toEqual({ kind: "unknown" });
  });

  test("a routing error from the routing parser keeps the routing class, same message", () => {
    // The repo file cannot reach this parser today: `routing` is not a repo key, so the
    // repo layer rejects it first as a per-person key. The parser keeps its class anyway.
    const error = thrownBy(() =>
      parseRoutingConfig("invalid", ".prhero/config.json"),
    );
    expect((error as CliUsageError).message).toBe(
      ".prhero/config.json routing must be an object",
    );
    expect(classifyCliError(error)).toEqual({
      kind: "config-parse",
      source: "routing",
    });
  });
});
