#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import net from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.ROAMCLI_SMOKE_TOKEN ?? "dev-token";
const workspace = resolve(process.env.ROAMCLI_SMOKE_WORKSPACE ?? repoRoot);
const suppliedBaseUrl = process.env.ROAMCLI_SMOKE_BASE_URL;
const timeoutMs = Number(process.env.ROAMCLI_SMOKE_TIMEOUT_MS ?? 30_000);
const runnerId = process.env.ROAMCLI_SMOKE_RUNNER_ID ?? `smoke-${process.pid}`;
const logs = [];
const children = [];
const tempDirs = [];
const tempPaths = [];

let baseUrl = suppliedBaseUrl?.replace(/\/$/, "");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm smoke:e2e

Environment:
  ROAMCLI_SMOKE_BASE_URL        Connect to an existing server instead of starting one.
  ROAMCLI_SMOKE_TOKEN           Bearer token. Default: dev-token.
  ROAMCLI_SMOKE_RUNNER_ID       Runner id to use or start. Default: smoke-<pid>.
  ROAMCLI_SMOKE_WORKSPACE       Workspace exposed to the runner. Default: repo root.
  ROAMCLI_SMOKE_SKIP_BUILD=1    Skip shared package prebuild.
  ROAMCLI_SMOKE_TIMEOUT_MS      Per-step timeout. Default: 30000.
  ROAMCLI_SMOKE_EXPECT_PATCH_APPLY=0
                                Skip patch apply assertion.`);
  process.exit(0);
}

if (typeof WebSocket !== "function") {
  fail(
    "This Node.js runtime does not provide a global WebSocket implementation.",
  );
}

process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});

try {
  await runSmoke();
  await cleanup();
  console.log("[pass] RoamCli smoke/E2E completed");
} catch (error) {
  await cleanup();
  console.error("[fail] RoamCli smoke/E2E failed");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  if (logs.length > 0) {
    console.error("\n--- child process logs ---");
    console.error(logs.slice(-80).join(""));
  }
  process.exitCode = 1;
}

async function runSmoke() {
  if (process.env.ROAMCLI_SMOKE_SKIP_BUILD !== "1") {
    await runCommand("build:shared", "pnpm", [
      "--filter",
      "@roamcli/shared",
      "build",
    ]);
    await runCommand("build:agent-plugin-sdk", "pnpm", [
      "--filter",
      "@roamcli/agent-plugin-sdk",
      "build",
    ]);
    await runCommand("build:agent-codex", "pnpm", [
      "--filter",
      "@roamcli/agent-codex",
      "build",
    ]);
  }

  if (baseUrl === undefined) {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const dataDir = await mkdtemp(resolve(tmpdir(), "roamcli-smoke-server-"));
    tempDirs.push(dataDir);
    startChild(
      "server",
      "pnpm",
      ["--filter", "@roamcli/server", "exec", "tsx", "src/index.ts"],
      {
        HOST: "127.0.0.1",
        PORT: String(port),
        ROAMCLI_AUTH_TOKEN: token,
        ROAMCLI_DATA_DIR: dataDir,
        ROAMCLI_RUNNER_RPC_TIMEOUT_MS: "10000",
      },
    );
    await waitForHttp("/v1/runners");
    pass(`server online at ${baseUrl}`);
  } else {
    await waitForHttp("/v1/runners");
    pass(`connected to existing server at ${baseUrl}`);
  }

  const stream = await connectStream();
  try {
    const runner = await ensureRunnerOnline();
    pass(`runner online: ${runner.runnerId}`);

    const project = await createProject(runner.runnerId);
    pass(`project created: ${project.id}`);

    const prompt = `roamcli smoke prompt ${Date.now()}`;
    const session = await createSession(project.id, prompt);
    pass(`session created: ${session.id}`);

    await waitForPersistedAssistantMessage(session.id, prompt);
    pass("assistant message persisted");

    const tree = await requestJson(
      `/v1/sessions/${session.id}/files?path=.&depth=2`,
    );
    const root = tree.result?.root;
    assert(
      root?.type === "directory",
      "file tree response did not include a directory root",
    );
    assert(
      hasTreePath(root, "package.json") || hasTreePath(root, "apps"),
      "file tree did not include expected repo entries",
    );
    pass("file tree returned from runner");

    const content = await requestJson(
      `/v1/sessions/${session.id}/files/content?path=package.json&maxBytes=8192`,
    );
    assert(
      content.result?.content?.includes('"name": "roamcli"'),
      "file content did not include root package.json contents",
    );
    assert(
      content.result?.encoding === "utf8",
      "file content response did not report utf8 encoding",
    );
    pass("file content returned from runner");

    await fileSaveAssertionEntry(session.id);

    const terminalInput = `terminal-smoke-${Date.now()}`;
    const terminalSeen = waitForStreamEvent(stream, (event) => {
      return (
        event.type === "terminal:data" &&
        event.sessionId === session.id &&
        event.chunk.includes(terminalInput)
      );
    });
    stream.send(
      JSON.stringify({
        type: "userMessage",
        requestId: `smoke-input-${Date.now()}`,
        sessionId: session.id,
        content: terminalInput,
      }),
    );
    await terminalSeen;
    await waitForPersistedAssistantMessage(session.id, terminalInput);
    pass("terminal input delivered and persisted");

    await patchApplyAssertionEntry(session.id);
  } finally {
    stream.close();
  }
}

async function ensureRunnerOnline() {
  const existing = await requestJson("/v1/runners");
  const requested = existing.runners?.find(
    (runner) => runner.runnerId === runnerId,
  );
  if (requested !== undefined) {
    return requested;
  }
  if (
    suppliedBaseUrl !== undefined &&
    process.env.ROAMCLI_SMOKE_RUNNER_ID === undefined &&
    existing.runners?.[0] !== undefined
  ) {
    return existing.runners[0];
  }

  const wsUrl = new URL("/v1/runner", baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const fakeCodex = await createFakeCodexCommand("smoke");
  startChild(
    "runner",
    "pnpm",
    [
      "--filter",
      "@roamcli/runner",
      "dev",
      "--server",
      wsUrl.toString(),
      "--token",
      token,
      "--runner-id",
      runnerId,
      "--workspace",
      workspace,
      "--profile",
      "trusted",
    ],
    {
      ROAM_RUNNER_SERVER: wsUrl.toString(),
      ROAM_RUNNER_TOKEN: token,
      ROAM_RUNNER_ID: runnerId,
      ROAM_RUNNER_WORKSPACE: workspace,
      ROAM_RUNNER_PROFILE: "trusted",
      ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      ROAMCLI_AGENT_CODEX_ARGS: JSON.stringify([fakeCodex]),
    },
  );

  return waitFor(async () => {
    const payload = await requestJson("/v1/runners");
    return payload.runners?.find((runner) => runner.runnerId === runnerId);
  }, `runner ${runnerId} to come online`);
}

async function createProject(activeRunnerId) {
  const payload = await requestJson("/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      name: `Smoke Project ${process.pid}`,
      runnerId: activeRunnerId,
      directory: workspace,
    }),
  });
  assert(
    payload.project?.id,
    "create project response did not include project.id",
  );
  return payload.project;
}

async function createSession(projectId, prompt) {
  const payload = await requestJson("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      agent: "codex",
      prompt,
      title: "Smoke E2E",
    }),
  });
  assert(
    payload.session?.id,
    "create session response did not include session.id",
  );
  return payload.session;
}

async function createFakeCodexCommand(label) {
  const dir = await mkdtemp(resolve(tmpdir(), `roamcli-${label}-codex-`));
  tempDirs.push(dir);
  const script = resolve(dir, "fake-codex.mjs");
  await writeFile(
    script,
    [
      "const prompt = process.argv.at(-1) ?? '';",
      "const resumed = process.argv.includes('resume');",
      "console.log(JSON.stringify({ type: 'thread.started', thread_id: resumed ? 'codex-thread-resumed' : 'codex-thread-1' }));",
      "console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: prompt } }));",
    ].join("\n"),
    "utf8",
  );
  return script;
}

async function waitForPersistedAssistantMessage(sessionId, expected) {
  return waitFor(
    async () => {
      const payload = await requestJson(`/v1/sessions/${sessionId}`);
      return payload.messages?.some(
        (message) =>
          message.role === "assistant" && message.content.includes(expected),
      );
    },
    `assistant message containing ${JSON.stringify(expected)} to persist`,
  );
}

async function patchApplyAssertionEntry(sessionId) {
  if (process.env.ROAMCLI_SMOKE_EXPECT_PATCH_APPLY === "0") {
    pass("patch apply assertion skipped");
    return;
  }
  const filePath = `.roamcli-smoke-${process.pid}.txt`;
  const absolutePath = resolve(workspace, filePath);
  tempPaths.push(absolutePath);
  const oldValue = `old-${Date.now()}`;
  const newValue = `new-${Date.now()}`;
  await writeFile(absolutePath, `${oldValue}\n`, "utf8");
  const patch = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1 +1 @@",
    `-${oldValue}`,
    `+${newValue}`,
    "",
  ].join("\n");
  const invalidSignature = await requestRaw(
    `/v1/sessions/${sessionId}/patches/apply`,
    {
      method: "POST",
      body: JSON.stringify({
        patch,
        strip: 1,
        signedAt: new Date().toISOString(),
        signature: "not-valid",
      }),
    },
  );
  assert(
    invalidSignature.status === 403 &&
      invalidSignature.payload?.error === "invalid_signature",
    `invalid patch signature was not rejected: ${JSON.stringify(invalidSignature)}`,
  );
  pass("invalid patch apply signature rejected");
  const signedAt = new Date().toISOString();
  const signature = signApprovalLike(
    `patch:${sessionId}:${sha256Hex(patch)}`,
    true,
    signedAt,
  );
  const payload = await requestJson(`/v1/sessions/${sessionId}/patches/apply`, {
    method: "POST",
    body: JSON.stringify({ patch, strip: 1, signedAt, signature }),
  });
  assert(
    payload.result?.applied === true,
    `patch apply did not report applied=true: ${JSON.stringify(payload)}`,
  );
  assert(
    payload.result?.changedFiles?.includes(filePath),
    "patch apply response did not include changed file",
  );
  const content = await requestJson(
    `/v1/sessions/${sessionId}/files/content?path=${encodeURIComponent(filePath)}&maxBytes=1024`,
  );
  assert(
    content.result?.content === `${newValue}\n`,
    "patched file content was not returned by runner",
  );
  pass("signed patch apply changed a real workspace file");
}

async function fileSaveAssertionEntry(sessionId) {
  const filePath = `.roamcli-smoke-save-${process.pid}.txt`;
  const absolutePath = resolve(workspace, filePath);
  tempPaths.push(absolutePath);
  const oldValue = `save-old-${Date.now()}`;
  const newValue = `save-new-${Date.now()}`;
  await writeFile(absolutePath, `${oldValue}\n`, "utf8");

  const write = await requestJson(`/v1/sessions/${sessionId}/files/content`, {
    method: "PUT",
    body: JSON.stringify({
      path: filePath,
      content: `${newValue}\n`,
      encoding: "utf8",
    }),
  });
  assert(
    write.result?.bytesWritten === Buffer.byteLength(`${newValue}\n`, "utf8"),
    `file write returned unexpected result: ${JSON.stringify(write)}`,
  );

  const content = await requestJson(
    `/v1/sessions/${sessionId}/files/content?path=${encodeURIComponent(filePath)}&maxBytes=1024`,
  );
  assert(
    content.result?.content === `${newValue}\n`,
    "saved file content was not returned by runner",
  );
  pass("file edit/save changed a real workspace file");
}

async function connectStream() {
  const url = new URL("/v1/stream", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  const socket = new WebSocket(url.toString());
  socket.__events = [];
  socket.addEventListener("message", (message) => {
    try {
      socket.__events.push(JSON.parse(message.data));
    } catch {
      socket.__events.push({ type: "unparseable", raw: message.data });
    }
  });
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(
      () => rejectOpen(new Error(`Timed out opening stream ${url}`)),
      timeoutMs,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolveOpen();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        rejectOpen(new Error(`Failed to open stream ${url}`));
      },
      { once: true },
    );
  });
  return socket;
}

async function waitForStreamEvent(socket, predicate) {
  const existing = socket.__events.find(predicate);
  if (existing !== undefined) {
    return existing;
  }
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      rejectEvent(new Error("Timed out waiting for stream event"));
    }, timeoutMs);
    function onMessage(message) {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (predicate(event)) {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolveEvent(event);
      }
    }
    socket.addEventListener("message", onMessage);
  });
}

async function waitForHttp(path) {
  await waitFor(async () => {
    try {
      await requestJson(path);
      return true;
    } catch {
      return false;
    }
  }, `${path} to respond`);
}

async function waitFor(probe, description) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

async function requestJson(path, init = {}) {
  const { ok, status, statusText, payload } = await requestRaw(path, init);
  if (!ok) {
    throw new Error(
      `${status} ${statusText} from ${path}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function requestRaw(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    payload,
  };
}

function startChild(label, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => logs.push(`[${label}:stdout] ${chunk}`));
  child.stderr.on("data", (chunk) => logs.push(`[${label}:stderr] ${chunk}`));
  child.on("exit", (code, signal) => {
    logs.push(
      `[${label}] exited code=${code ?? "null"} signal=${signal ?? "null"}\n`,
    );
  });
  return child;
}

async function runCommand(label, command, args, env = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = startChild(label, command, args, env);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(
          new Error(
            `${label} failed with code=${code ?? "null"} signal=${signal ?? "null"}`,
          ),
        );
      }
    });
  });
}

async function cleanup() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolveCleanup) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveCleanup();
            return;
          }
          child.once("exit", resolveCleanup);
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 2_000).unref();
        }),
    ),
  );
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await Promise.all(tempPaths.map((path) => rm(path, { force: true })));
}

async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolvePort(address.port);
        } else {
          rejectPort(new Error("Unable to allocate a local port"));
        }
      });
    });
  });
}

function hasTreePath(node, path) {
  if (node?.path === path || node?.name === path) {
    return true;
  }
  return node?.children?.some((child) => hasTreePath(child, path)) ?? false;
}

function pass(message) {
  console.log(`[pass] ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function fail(message) {
  throw new Error(message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signApprovalLike(approvalId, approved, signedAt) {
  return createHmac("sha256", token)
    .update(`${approvalId}.${approved ? "1" : "0"}.${signedAt}`)
    .digest("base64url");
}
