import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import {
  type BenchmarkIdentity,
  loadQualifiedReview,
} from "../../benchmarks/martian/martian-evidence";
import { evidenceSha256 } from "../../src/execution/attempt-evidence";
import { StepExecutionHarness } from "../../src/execution/harness";
import { attemptEvidencePath } from "../../src/execution/step-artifacts";
import { WorkspaceReadBroker } from "../../src/security/workspace-read-broker";
import { qualifyOpenCodeServer } from "../../src/transports/opencode-admission";
import { createOpenCodeClient } from "../../src/transports/opencode-client";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";

for (const selector of ["relative", "absolute", "git-C"] as const)
  for (const mode of ["valid", "wrong-readback"] as const)
    test(`${selector} authorized entry through harness to real SDK: ${mode}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "prhero-selector-"));
      try {
        await mkdir(join(root, "packages", "core"), { recursive: true });
        const canonical = await realpath(join(root, "packages", "core"));
        const bin = join(root, "opencode");
        const bytes = Buffer.from("#!/bin/sh\nexit 99\n");
        await writeFile(bin, bytes, { mode: 0o755 });
        const executable = await realpath(bin);
        await writeFile(join(root, "system.md"), "system");
        await writeFile(
          join(root, "mcp.json"),
          JSON.stringify({ mcpServers: {} }),
        );
        const broker = new WorkspaceReadBroker({ workspaceRoot: root });
        let selected =
          selector === "relative"
            ? "packages/core"
            : join(root, "packages", "core");
        if (selector === "git-C") {
          const authorization = broker.authorizeGitArgs([
            "-C",
            "packages/core",
            "status",
          ]);
          expect(authorization.approved).toBe(true);
          if (!authorization.approved)
            throw Error("unexpected selector denial");
          selected = authorization.canonicalPath;
          expect(selected).toBe(canonical);
        }
        const doc = await readFile(
          join(import.meta.dir, "../fixtures/opencode/qualified-openapi.json"),
          "utf8",
        );
        const requests: Request[] = [];
        let promptID = "";
        const fetcher = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          requests.push(request.clone());
          const path = new URL(request.url).pathname;
          let data: unknown = true;
          if (path === "/global/health")
            data = { healthy: true, version: "1.18.30" };
          else if (path === "/doc") return new Response(doc);
          else if (path === "/mcp") data = {};
          else if (path === "/session")
            data = { id: "ses_selector", directory: canonical };
          else if (path === "/experimental/tool/ids") data = ["read"];
          else if (path === "/event")
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"type":"server.connected","properties":{}}\n\n',
                    ),
                  );
                },
              }),
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          else if (path === "/session/status")
            data = { ses_selector: { type: "idle" } };
          else if (
            path === "/session/ses_selector/message" &&
            request.method === "POST"
          ) {
            promptID = (await request.json()).messageID;
            data = {};
          } else if (path === "/session/ses_selector/message")
            data = [
              // #214: this fixture's `tools: ["Read"]` step with an empty
              // `findings` draft and zero observed tool invocations used to
              // read as a hunt that never looked (`isVacuousHunt`),
              // which the harness now refuses to deliver as `ok`. A completed
              // "read" tool part fixes that — but it stays on this SAME flat
              // message, parented directly to the prompt, rather than dev's
              // real two-step shape (a `finish:"tool-calls"` step followed by
              // a separate parented `finish:"stop"` answer,
              // opencode-client.ts's `isIntermediateToolStep`): the
              // martian-evidence witness this test also exercises below
              // (`loadQualifiedReview` / `classifyObservationEvidence`)
              // requires EVERY assistant row in the readback to be a direct
              // child of the user message — a pre-existing dev assumption
              // this merge does not touch. The TEXT part is listed BEFORE the
              // tool part on purpose: `reconcileMessages` only records a
              // message's text part while `hasToolCalls` is still false for
              // that message, so the tool part (which flips `hasToolCalls`
              // true) has to be processed second or the answer text is
              // dropped as narration and `finalText` comes back empty.
              {
                info: {
                  id: "msg_final",
                  role: "assistant",
                  sessionID: "ses_selector",
                  parentID: promptID,
                  path: {
                    cwd: mode === "valid" ? canonical : root,
                    root: canonical,
                  },
                  time: { completed: 1 },
                  finish: "stop",
                  cost: 0.1,
                  tokens: { input: 1, output: 1 },
                },
                parts: [
                  {
                    id: "prt_final",
                    sessionID: "ses_selector",
                    messageID: "msg_final",
                    type: "text",
                    text: '{"findings":[]}',
                  },
                  {
                    id: "prt_tool_read",
                    sessionID: "ses_selector",
                    messageID: "msg_final",
                    type: "tool",
                    callID: "call_read_1",
                    tool: "read",
                    state: { status: "completed" },
                  },
                ],
              },
            ];
          return new Response(JSON.stringify(data), {
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch;
        const client = createOpenCodeClient({
          observedIdentity: {
            sdkVersion: "1.18.25",
            serverVersion: "1.18.30",
            executableSha256: evidenceSha256(bytes),
          },
          model: { providerID: "openai", modelID: "model" },
          loadSdk: async () => ({
            createOpencodeClient: (config) => createOpencodeClient(config),
          }),
          fetch: fetcher,
          readSystemPrompt: async (path) => readFile(path, "utf8"),
          readMcpConfig: async () => JSON.stringify({ mcpServers: {} }),
          launchServer: async () => ({
            url: "http://unused.invalid",
            pid: 1,
            close: async () => {},
          }),
          qualifyServer: (url, signal) =>
            qualifyOpenCodeServer(
              url,
              {
                sdkVersion: "1.18.25",
                serverVersion: "1.18.30",
                executablePath: executable,
                executableSha256: createHash("sha256")
                  .update(bytes)
                  .digest("hex"),
              },
              signal,
              fetcher,
            ),
        });
        const transport = new OpenCodeSdkTransport({
          client,
          admissionIdentity: { executable: "opencode", provider: "openai" },
          billingMode: "metered",
          pollIntervalMs: 1,
          pollRoundMs: 10,
          maxQuietRounds: 100,
          abortConfirmMs: 5,
          cleanupMs: 5,
        });
        const harness = new StepExecutionHarness({
          transport,
          workspaceRoot: root,
          binaryPath: executable,
          executableAllowlist: [
            {
              absolutePath: executable,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        });
        const result = await harness.run({
          name: "selector",
          systemPromptPath: join(root, "system.md"),
          prompt: "review",
          mcpConfigPath: join(root, "mcp.json"),
          tools: ["Read"],
          model: "model",
          effort: "high",
          route: {
            backend: "opencode",
            provider: "openai",
            modelFamily: "model",
            modelSnapshot: "model",
          },
          cwd: selected,
          outPath: join(root, "result.json"),
          timeoutMs: 3000,
          maxAttempts: 1,
          parse: (text) => JSON.parse(text),
        });
        expect(result.status).toBe(mode === "valid" ? "ok" : "failed");
        if (mode === "valid") {
          const route = {
            backend: "opencode" as const,
            provider: "openai",
            modelFamily: "model",
            modelSnapshot: "model",
          };
          const identity: BenchmarkIdentity = {
            schemaVersion: 1,
            fingerprint: "a".repeat(64),
            requiredSteps: ["selector"],
            pr: 14943,
            headSha: "head",
            baseSha: "base",
            routes: [route],
            runtime: [
              {
                backend: "opencode",
                sdkVersion: "1.18.25",
                serverVersion: "1.18.30",
                executableSha256: evidenceSha256(bytes),
              },
            ],
          };
          const artifactPath = attemptEvidencePath(
            join(root, "result.json"),
            "selector",
            1,
          );
          await writeFile(
            join(root, "run-identity.json"),
            JSON.stringify(identity),
          );
          await writeFile(
            join(root, "pipeline.json"),
            JSON.stringify({
              steps: [
                {
                  name: "selector",
                  status: "ok",
                  attempts: 1,
                  attemptEvidencePath: relative(root, artifactPath),
                },
              ],
              usage_v2: { completeness: "complete", cashCostUsd: 0.1 },
            }),
          );
          await writeFile(
            join(root, "findings.json"),
            JSON.stringify({
              schema_version: "1.0.0",
              pr: 14943,
              head_sha: "head",
              base_sha: "base",
              model: "model",
              iteration: 1,
              parity_hunter_fired: false,
              run_status: "complete",
              telemetry: { wall_ms: 1 },
              findings: [],
              debug: { refuted: [] },
            }),
          );
          const qualified = await loadQualifiedReview(root, identity);
          expect(qualified.reason).toBeUndefined();
          expect(qualified.qualified).toBe(true);
          const artifact = await Bun.file(artifactPath).json();
          const capturePath = join(root, artifact.capture.relativePath);
          const capture = await Bun.file(capturePath).json();
          capture.records = capture.records.filter(
            (record: { kind: string }) => record.kind !== "http_request",
          );
          await writeFile(capturePath, JSON.stringify(capture));
          artifact.capture.sha256 = evidenceSha256(
            await Bun.file(capturePath).bytes(),
          );
          await writeFile(artifactPath, JSON.stringify(artifact));
          expect((await loadQualifiedReview(root, identity)).qualified).toBe(
            false,
          );
        }
        expect(
          requests.some(
            (request) =>
              request.method === "POST" &&
              new URL(request.url).pathname.endsWith("/message"),
          ),
        ).toBe(true);
        for (const p of [
          "/mcp",
          "/session",
          "/experimental/tool/ids",
          "/session/ses_selector/message",
          // #223: GET /session/status is scoped by `directory` exactly like
          // the endpoints above — it must carry the SAME one session.create
          // used, or it watches an instance that has never heard of this
          // session.
          "/session/status",
        ]) {
          const matching = requests.filter(
            (request) => new URL(request.url).pathname === p,
          );
          expect(matching.length).toBeGreaterThan(0);
          for (const request of matching)
            expect(new URL(request.url).searchParams.get("directory")).toBe(
              canonical,
            );
        }
        if (mode === "wrong-readback")
          expect(result.stderrTail).toContain("cwd mismatch");
        await client.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
