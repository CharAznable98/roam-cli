#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import net from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerPassword =
  process.env.ROAMCLI_SMOKE_PASSWORD ?? "roamcli-smoke-password";
const workspace = resolve(process.env.ROAMCLI_SMOKE_WORKSPACE ?? repoRoot);
const suppliedBaseUrl = process.env.ROAMCLI_SMOKE_BASE_URL;
const timeoutMs = Number(process.env.ROAMCLI_SMOKE_TIMEOUT_MS ?? 30_000);
const runnerId = process.env.ROAMCLI_SMOKE_RUNNER_ID ?? `smoke-${process.pid}`;
const smokeMaxImageBytes = 5 * 1024 * 1024;
const smokeImageSizes = [1024, 512 * 1024, smokeMaxImageBytes];
const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});
const logs = [];
const children = [];
const tempDirs = [];
const tempPaths = [];

let baseUrl = suppliedBaseUrl?.replace(/\/$/, "");
let cookieHeader = "";
let runnerToken = "";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm smoke:e2e

Environment:
  ROAMCLI_SMOKE_BASE_URL        Connect to an existing server instead of starting one.
  ROAMCLI_SMOKE_PASSWORD        Owner password for login/setup. Default: roamcli-smoke-password.
  ROAMCLI_SMOKE_RUNNER_ID       Runner id to use or start. Default: smoke-<pid>.
  ROAMCLI_SMOKE_WORKSPACE       Workspace exposed to the runner. Default: repo root.
  ROAMCLI_SMOKE_SKIP_BUILD=1    Skip shared package prebuild.
  ROAMCLI_SMOKE_TIMEOUT_MS      Per-step timeout. Default: 30000.
  ROAMCLI_SMOKE_EXPECT_PATCH_APPLY=0
                                Skip patch apply assertion.`);
  process.exit(0);
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
        ROAMCLI_DATA_DIR: dataDir,
        ROAMCLI_RUNNER_RPC_TIMEOUT_MS: "10000",
      },
    );
    await waitForHttp("/v1/auth/status");
    await authenticate({ setupDataDir: dataDir });
    pass(`server online at ${baseUrl}`);
  } else {
    await waitForHttp("/v1/auth/status");
    await authenticate({});
    pass(`connected to existing server at ${baseUrl}`);
  }

  const runner = await ensureRunnerOnline();
  pass(`runner online: ${runner.runnerId}`);

  const project = await createProject(runner.runnerId);
  pass(`project created: ${project.id}`);

  const prompt = `roamcli smoke prompt ${Date.now()}`;
  const session = await createSession(project.id, prompt);
  pass(`session created: ${session.id}`);

  await waitForPersistedAssistantMessage(session.id, prompt);
  pass("assistant message persisted");

  await imageAttachmentAssertionEntry(project.id, runner);

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

  await patchApplyAssertionEntry(session.id);
}

async function authenticate({ setupDataDir }) {
  const statusPayload = await requestJson("/v1/auth/status");
  const status = statusPayload.auth?.status;
  if (status === "setup_required") {
    if (!setupDataDir) {
      fail(
        "Server requires setup. Provide ROAMCLI_SMOKE_PASSWORD and run against a server whose setup token is available locally.",
      );
    }
    const setupToken = await waitForSetupToken(setupDataDir);
    await requestJson("/v1/auth/setup", {
      method: "POST",
      body: JSON.stringify({ setupToken, password: ownerPassword }),
    });
    pass("owner setup completed");
  } else if (status === "unauthenticated") {
    await requestJson("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: ownerPassword }),
    });
    pass("owner login completed");
  }

  const accountPayload = await requestJson("/v1/auth/account");
  runnerToken = accountPayload.account?.runnerToken ?? "";
  assert(
    runnerToken.length > 0,
    "account security state did not include a runner token",
  );
}

async function waitForSetupToken(dataDir) {
  return waitFor(async () => {
    try {
      const value = (
        await readFile(resolve(dataDir, "setup-token.txt"), "utf8")
      ).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }, "setup token file");
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
      runnerToken,
      "--runner-id",
      runnerId,
      "--workspace",
      workspace,
      "--profile",
      "trusted",
      "--agent-plugin",
      "@roamcli/agent-codex",
    ],
    {
      ROAM_RUNNER_SERVER: wsUrl.toString(),
      ROAM_RUNNER_TOKEN: runnerToken,
      ROAM_RUNNER_ID: runnerId,
      ROAM_RUNNER_WORKSPACE: workspace,
      ROAM_RUNNER_PROFILE: "trusted",
      ROAMCLI_AGENT_CODEX_MODE: "exec-json",
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

async function createSession(projectId, prompt, attachments = []) {
  const payload = await requestJson("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      agent: "codex",
      prompt,
      title: "Smoke E2E",
      ...(attachments.length > 0 ? { attachments } : {}),
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
      "import { readFileSync } from 'node:fs';",
      "const valueOptions = new Set(['--color', '--model', '--profile', '--sandbox', '--cd', '--output-schema']);",
      "const imagePaths = [];",
      "const positional = [];",
      "let resumed = false;",
      "for (let index = 2; index < process.argv.length; index += 1) {",
      "  const arg = process.argv[index];",
      "  if (arg === 'resume') {",
      "    resumed = true;",
      "    continue;",
      "  }",
      "  if (arg === '--image') {",
      "    imagePaths.push(process.argv[index + 1] ?? '');",
      "    index += 1;",
      "    continue;",
      "  }",
      "  if (arg.startsWith('-')) {",
      "    if (valueOptions.has(arg)) index += 1;",
      "    continue;",
      "  }",
      "  positional.push(arg);",
      "}",
      "const imageSizes = imagePaths.map((imagePath) => readFileSync(imagePath).byteLength);",
      "const prompt = positional.at(-1) ?? '';",
      "console.log(JSON.stringify({ type: 'thread.started', thread_id: resumed ? 'codex-thread-resumed' : 'codex-thread-1' }));",
      "const imageSummary = imageSizes.length > 0 ? ` image-bytes:${imageSizes.join(',')}` : '';",
      "console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `${prompt}${imageSummary}` } }));",
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

async function imageAttachmentAssertionEntry(projectId, runner) {
  const imageCapability = runner.capabilities?.find(
    (capability) => capability.kind === "codex" && capability.supportsImages,
  );
  if (imageCapability === undefined) {
    pass(
      "image attachment assertion skipped: runner does not advertise images",
    );
    return;
  }
  if (imageCapability.maxImageBytes !== smokeMaxImageBytes) {
    pass(
      `image attachment assertion skipped: runner limit is ${imageCapability.maxImageBytes} bytes`,
    );
    return;
  }

  const prompt = `roamcli image smoke ${Date.now()}`;
  const attachments = smokeImageSizes.map((size, index) =>
    imageUploadFromBytes(
      `smoke-${index + 1}-${size}.png`,
      pngBytesOfSize(size),
    ),
  );
  const session = await createSession(projectId, prompt, attachments);
  await waitForPersistedAssistantMessage(
    session.id,
    `image-bytes:${smokeImageSizes.join(",")}`,
  );
  pass(`image attachments reached fake codex: ${smokeImageSizes.join(",")}`);

  const oversized = await requestRaw("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      agent: "codex",
      prompt: "reject oversized image",
      title: "Smoke oversized image",
      attachments: [
        imageUploadFromBytes(
          "smoke-too-large.png",
          pngBytesOfSize(smokeMaxImageBytes + 1),
        ),
      ],
    }),
  });
  assert(
    oversized.status === 400 && oversized.payload?.error === "image_too_large",
    `oversized image was not rejected by the image limit: ${JSON.stringify(oversized)}`,
  );
  pass("oversized image rejected at 5MB limit");
}

function imageUploadFromBytes(name, bytes) {
  return {
    name,
    mimeType: "image/png",
    size: bytes.byteLength,
    contentBase64: bytes.toString("base64"),
  };
}

function pngBytesOfSize(targetBytes) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(Buffer.from([0, 0, 0, 0, 255]));
  const chunks = [
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  const base = Buffer.concat([pngSignature(), ...chunks]);
  if (targetBytes === base.byteLength) {
    return base;
  }
  const fillerLength = targetBytes - base.byteLength - 12;
  assert(
    fillerLength >= 0,
    `target PNG size ${targetBytes} is too small for the generated image`,
  );
  return Buffer.concat([
    pngSignature(),
    chunks[0],
    chunks[1],
    pngChunk("ruNd", Buffer.alloc(fillerLength, 0x61)),
    chunks[2],
  ]);
}

function pngSignature() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.byteLength,
  );
  return chunk;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
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
  const payload = await requestJson(`/v1/sessions/${sessionId}/patches/apply`, {
    method: "POST",
    body: JSON.stringify({ patch, strip: 1 }),
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
  pass("owner-authorized patch apply changed a real workspace file");
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
  const method = init.method ?? "GET";
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(mutating ? { origin: baseUrl } : {}),
      ...init.headers,
    },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    cookieHeader = setCookie.split(";")[0] ?? cookieHeader;
  }
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
