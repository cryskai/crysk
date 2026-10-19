// countFreeRouteSteps: how many steps of an admitted route plan the free
// probe declared free, read from the memoised verdicts only. The plan line
// uses it to say "not billed" instead of quoting a dollar band for work that
// costs nothing. It must never spawn: the admission already decided every
// verdict it needs, and a fresh probe here would be a second network call.

import { describe, expect, test } from "bun:test";
import {
  countFreeRouteSteps,
  type FreeModelProbe,
} from "#model/free-discovery";

type Step = Parameters<typeof countFreeRouteSteps>[0]["steps"][number];

const opencodeStep = (model: string): Step =>
  ({
    route: { backend: "opencode", provider: "opencode", modelSnapshot: model },
  }) as unknown as Step;

const claudeStep: Step = {
  route: {
    backend: "claude-code",
    provider: "anthropic",
    modelSnapshot: "claude-sonnet",
  },
} as unknown as Step;

const oauthStep: Step = {
  route: {
    backend: "opencode",
    provider: "openai",
    modelSnapshot: "gpt-5",
  },
} as unknown as Step;

function recordingProbe(verdicts: Record<string, boolean>) {
  const calls: string[] = [];
  const probe: FreeModelProbe = async (provider, model) => {
    calls.push(`${provider}/${model}`);
    return verdicts[model] ?? false;
  };
  return { probe, calls };
}

describe("countFreeRouteSteps", () => {
  test("every step free: free equals total", async () => {
    const { probe } = recordingProbe({ "free-a": true, "free-b": true });
    const result = await countFreeRouteSteps({
      steps: [opencodeStep("free-a"), opencodeStep("free-b")],
      probe,
    });
    expect(result).toEqual({ free: 2, total: 2 });
  });

  test("mixed: the free opencode step counts, the claude-code step does not", async () => {
    const { probe } = recordingProbe({ "free-a": true });
    const result = await countFreeRouteSteps({
      steps: [opencodeStep("free-a"), claudeStep],
      probe,
    });
    expect(result).toEqual({ free: 1, total: 2 });
  });

  test("metered: every opencode verdict false leaves nothing free", async () => {
    const { probe } = recordingProbe({});
    const result = await countFreeRouteSteps({
      steps: [opencodeStep("paid-a"), opencodeStep("paid-b")],
      probe,
    });
    expect(result).toEqual({ free: 0, total: 2 });
  });

  test("subscription: claude-code and OAuth steps are never probed and never free", async () => {
    const { probe, calls } = recordingProbe({ "gpt-5": true });
    const result = await countFreeRouteSteps({
      steps: [claudeStep, oauthStep],
      probe,
    });
    expect(result).toEqual({ free: 0, total: 2 });
    expect(calls).toEqual([]);
  });

  test("probes only the api-token opencode steps, never claude-code", async () => {
    const { probe, calls } = recordingProbe({ "free-a": true });
    await countFreeRouteSteps({
      steps: [claudeStep, opencodeStep("free-a")],
      probe,
    });
    expect(calls).toEqual(["opencode/free-a"]);
  });

  test("no probe available: nothing is known free, so nothing is claimed", async () => {
    const result = await countFreeRouteSteps({
      steps: [opencodeStep("free-a")],
      probe: undefined,
    });
    expect(result).toEqual({ free: 0, total: 1 });
  });

  test("a throwing probe fails closed: that step is not free", async () => {
    const probe: FreeModelProbe = async () => {
      throw new Error("spawn failed");
    };
    const result = await countFreeRouteSteps({
      steps: [opencodeStep("free-a")],
      probe,
    });
    expect(result).toEqual({ free: 0, total: 1 });
  });
});
