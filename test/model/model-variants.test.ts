// S7 (E-g, E2): the variants OpenCode lists for a model, read from the same
// `models <provider> --verbose --refresh` listing the free check reads.
import { describe, expect, test } from "bun:test";
import {
  createModelVariantsProbe,
  type FreeModelDiscoveryRunResult,
} from "#model/free-discovery";

const BINARY = "/opt/fake/opencode";

function listing(models: Record<string, Record<string, unknown>>): string {
  return Object.entries(models)
    .map(([id, model]) => `openai/${id}\n${JSON.stringify(model, null, 2)}`)
    .join("\n");
}

function runReturning(
  result: FreeModelDiscoveryRunResult | Error,
  calls: string[][] = [],
) {
  return async (argv: readonly string[]) => {
    calls.push([...argv]);
    if (result instanceof Error) throw result;
    return result;
  };
}

describe("createModelVariantsProbe", () => {
  test("lists a model's variants in OpenCode's order, from the free check's argv", async () => {
    const calls: string[][] = [];
    const probe = createModelVariantsProbe({
      binaryPath: BINARY,
      run: runReturning(
        {
          exitCode: 0,
          stdout: listing({
            "gpt-5": {
              status: "active",
              variants: { none: {}, low: {}, max: {} },
            },
          }),
        },
        calls,
      ),
    });
    expect(await probe("openai", "gpt-5")).toEqual({
      kind: "listed",
      variants: ["none", "low", "max"],
    });
    expect(calls).toEqual([
      [BINARY, "models", "openai", "--verbose", "--refresh"],
    ]);
  });

  test("a model with no variants, or an empty set, lists none", async () => {
    const probe = createModelVariantsProbe({
      binaryPath: BINARY,
      run: runReturning({
        exitCode: 0,
        stdout: listing({
          plain: { status: "active" },
          empty: { status: "active", variants: {} },
        }),
      }),
    });
    expect(await probe("openai", "plain")).toEqual({
      kind: "listed",
      variants: [],
    });
    expect(await probe("openai", "empty")).toEqual({
      kind: "listed",
      variants: [],
    });
  });

  test("one listing per provider, however many models ask", async () => {
    const calls: string[][] = [];
    const probe = createModelVariantsProbe({
      binaryPath: BINARY,
      run: runReturning(
        {
          exitCode: 0,
          stdout: listing({ a: { variants: { high: {} } }, b: {} }),
        },
        calls,
      ),
    });
    await Promise.all([probe("openai", "a"), probe("openai", "b")]);
    expect(calls).toHaveLength(1);
  });

  test("a failed, timed-out or missing listing is unavailable, with the reason", async () => {
    const exited = createModelVariantsProbe({
      binaryPath: BINARY,
      run: runReturning({ exitCode: 1, stdout: "" }),
    });
    expect(await exited("openai", "gpt-5")).toEqual({
      kind: "unavailable",
      reason: "opencode models openai exited 1",
    });
    const timedOut = createModelVariantsProbe({
      binaryPath: BINARY,
      run: runReturning(new Error("free-model probe timed out")),
    });
    expect(await timedOut("openai", "gpt-5")).toEqual({
      kind: "unavailable",
      reason: "opencode models openai timed out",
    });
    const absent = createModelVariantsProbe({
      binaryPath: BINARY,
      run: runReturning({ exitCode: 0, stdout: listing({ other: {} }) }),
    });
    expect(await absent("openai", "gpt-5")).toEqual({
      kind: "unavailable",
      reason: "openai/gpt-5 is not in opencode models openai",
    });
  });

  test("no absolute binary path runs nothing", async () => {
    const calls: string[][] = [];
    const probe = createModelVariantsProbe({
      binaryPath: "opencode",
      run: runReturning({ exitCode: 0, stdout: "" }, calls),
    });
    expect((await probe("openai", "gpt-5")).kind).toBe("unavailable");
    expect(calls).toEqual([]);
  });
});
