// #303: the verified execution snapshot a step spawns from must exist while
// the step's attempts run and be gone once `run()` returns or throws, on
// every path — not only the happy one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderTransport,
  TransportOutcome,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import type { StepSpec } from "../../src/review/step-runner";
import {
  type CredentialBroker,
  type CredentialProjection,
  CredentialProjectionError,
} from "../../src/security/credential-broker";

const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

interface Sighting {
  readonly path: string;
  readonly existed: boolean;
}

function sight(target: string): Sighting {
  return { path: target, existed: existsSync(target) };
}

const SUCCESS: TransportOutcome = {
  completion: "success",
  protocolIntegrity: "verified",
  finalText: "{}",
  usage: {
    wallMs: 0,
    tokens: {},
    completeness: "complete",
    billingMode: "subscription",
  },
  stderrTail: "",
};

// Records where each attempt would spawn from, and whether the bytes were
// there at that moment.
function sightingTransport(sightings: Sighting[]): ProviderTransport {
  return {
    backend: "claude-code",
    capabilities: async () => {
      throw new Error("not used");
    },
    classifyFailure: () => undefined,
    async execute(request) {
      sightings.push(sight(request.isolation.verifiedBinaryPath));
      return SUCCESS;
    },
  };
}

// Sees the snapshot path before any attempt: projection receives it.
function sightingBroker(
  sightings: Sighting[],
  error?: CredentialProjectionError,
): CredentialBroker {
  return {
    async project(input): Promise<CredentialProjection> {
      sightings.push(sight(input.verifiedBinaryPath));
      if (error !== undefined) throw error;
      const home = path.join(tempDir, `home-${randomUUID()}`);
      await mkdir(home, { recursive: true });
      return {
        projectionId: "cred-sighting",
        kind: "claude_subscription_oauth",
        syntheticHome: home,
        syntheticConfigHome: path.join(home, ".claude"),
        syntheticTmp: path.join(home, "tmp"),
        env: { HOME: home },
        files: [],
        destroy: async () => {},
      };
    },
  };
}

let tempDir: string;
let snapshotBase: string;
let fixture: { canonicalPath: string; sha256: string };
const sightedPaths: string[] = [];

beforeEach(async () => {
  tempDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "pr-hero-exec-release-")),
  );
  snapshotBase = path.join(tempDir, "snaps");
  const binPath = path.join(tempDir, "bin", "claude");
  await mkdir(path.dirname(binPath), { recursive: true });
  const bytes = Buffer.concat([MACHO_PREFIX, Buffer.from(randomUUID())]);
  await writeFile(binPath, bytes);
  await chmod(binPath, 0o755);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  fixture = {
    canonicalPath: await realpath(binPath),
    sha256: hasher.digest("hex"),
  };
  await writeFile(path.join(tempDir, "system.md"), "system prompt");
});

afterEach(async () => {
  // A snapshot the harness failed to release may sit outside tempDir (the
  // real default base, before #303); remove exactly the dirs this test saw.
  for (const sighted of sightedPaths.splice(0)) {
    if (sighted !== fixture.canonicalPath) {
      await rm(path.dirname(sighted), { recursive: true, force: true });
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

function harness(
  overrides: Partial<ConstructorParameters<typeof StepExecutionHarness>[0]>,
): StepExecutionHarness {
  return new StepExecutionHarness({
    executableAllowlist: [
      { absolutePath: fixture.canonicalPath, sha256: fixture.sha256 },
    ],
    binaryPath: fixture.canonicalPath,
    executableSnapshotDir: snapshotBase,
    childEnv: { HOME: "/Users/operator-home", PATH: "/usr/bin:/bin" },
    ...overrides,
  });
}

function step(overrides: Partial<StepSpec> = {}): StepSpec {
  return {
    name: "snapshot-probe",
    systemPromptPath: path.join(tempDir, "system.md"),
    prompt: "p",
    tools: [],
    model: "sonnet",
    effort: "high",
    cwd: tempDir,
    outPath: path.join(tempDir, "out", "snapshot-probe.json"),
    mcpConfigPath: path.join(tempDir, "mcp.json"),
    timeoutMs: 5000,
    maxAttempts: 1,
    parse: (text) => JSON.parse(text),
    ...overrides,
  };
}

function remember(sightings: readonly Sighting[]): void {
  sightedPaths.push(...sightings.map((s) => s.path));
}

describe("verified execution snapshot release", () => {
  test("exists while the attempt spawns and is gone after a successful run", async () => {
    const sightings: Sighting[] = [];

    const result = await harness({
      transport: sightingTransport(sightings),
    }).run(step());
    remember(sightings);

    expect(result.status).toBe("ok");
    expect(sightings).toHaveLength(1);
    expect(sightings[0]?.path).not.toBe(fixture.canonicalPath);
    expect(sightings[0]?.existed).toBe(true);
    expect(existsSync(path.dirname(sightings[0]?.path ?? ""))).toBe(false);
    expect(path.dirname(path.dirname(sightings[0]?.path ?? ""))).toBe(
      snapshotBase,
    );
  });

  test("survives every attempt of a failing step and is gone after the last", async () => {
    const sightings: Sighting[] = [];

    const result = await harness({
      transport: sightingTransport(sightings),
    }).run(
      step({
        maxAttempts: 2,
        parse: () => {
          throw new Error("unparseable draft");
        },
      }),
    );
    remember(sightings);

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(sightings).toHaveLength(2);
    expect(sightings[1]?.path).toBe(sightings[0]?.path);
    expect(sightings.map((s) => s.existed)).toEqual([true, true]);
    expect(existsSync(path.dirname(sightings[0]?.path ?? ""))).toBe(false);
    expect(path.dirname(path.dirname(sightings[0]?.path ?? ""))).toBe(
      snapshotBase,
    );
  });

  test("is gone after run() throws", async () => {
    const sightings: Sighting[] = [];
    const run = harness({
      transport: sightingTransport([]),
      credentialBroker: sightingBroker(sightings),
      admissionGate: {
        admit: () => {
          throw new Error("admission exploded");
        },
      },
    }).run(step());

    await expect(run).rejects.toThrow("admission exploded");
    remember(sightings);

    expect(sightings).toHaveLength(1);
    expect(sightings[0]?.existed).toBe(true);
    expect(existsSync(path.dirname(sightings[0]?.path ?? ""))).toBe(false);
    expect(path.dirname(path.dirname(sightings[0]?.path ?? ""))).toBe(
      snapshotBase,
    );
  });

  test("is gone after a credential projection failure returns before any spawn", async () => {
    const sightings: Sighting[] = [];
    const spawned: Sighting[] = [];

    const result = await harness({
      transport: sightingTransport(spawned),
      credentialBroker: sightingBroker(
        sightings,
        new CredentialProjectionError("projection_layout_invalid"),
      ),
    }).run(step());
    remember(sightings);

    expect(result.status).toBe("failed");
    expect(result.stderrTail).toContain(
      "Credential projection failed (projection_layout_invalid)",
    );
    expect(spawned).toEqual([]);
    expect(sightings).toHaveLength(1);
    expect(sightings[0]?.existed).toBe(true);
    expect(existsSync(path.dirname(sightings[0]?.path ?? ""))).toBe(false);
    expect(path.dirname(path.dirname(sightings[0]?.path ?? ""))).toBe(
      snapshotBase,
    );
  });
});
