#!/usr/bin/env node
// Exercises the installed Pi CLI and real RoamCli Server/Runner against a
// deterministic local OpenAI-compatible HTTP backend. This does not test an LLM.
import { createServer, request as httpRequest } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  access,
  unlink,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawnWorkspace, terminateTestChild } from "./process-helpers.mjs";
import { piInvocation } from "../packages/agent-pi/dist/command.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/pi-e2e.mjs [--only-startup | --only-input]\n\nRequires a built workspace and an installed Pi CLI. Starts an isolated Server,\nRunner and deterministic local HTTP model fixture; never uses user model\nconfiguration or credentials. Evidence is retained under artifacts/pi-e2e.\nThe model backend is controlled test code, not an actual LLM.",
  );
  process.exit(0);
}
for (const path of [
  "apps/server/dist/index.js",
  "apps/runner/dist/index.js",
  "packages/agent-pi/dist/index.js",
]) {
  try {
    await access(resolve(root, path));
  } catch {
    throw new Error(
      `Missing ${path}. Build the workspace before running Pi E2E.`,
    );
  }
}
const invocation = piInvocation("pi", process.env);
const { stdout: versionOutput } = await promisify(execFile)(
  invocation.command,
  [...invocation.args, "--version"],
  { windowsHide: true, timeout: 15000 },
);
const actualPi = versionOutput.trim();
console.log(
  `[info] Installed Pi ${actualPi}; controlled HTTP backend, not an actual LLM`,
);
const onlyStartup = process.argv.includes("--only-startup");
const onlyInput = process.argv.includes("--only-input");
await mkdir(resolve(root, "artifacts/pi-e2e"), { recursive: true });
const evidence = await mkdtemp(resolve(root, "artifacts/pi-e2e/run-"));
const home = resolve(evidence, "home");
const agentDir = resolve(home, ".pi/agent");
await mkdir(resolve(agentDir, "skills/fixture"), { recursive: true });
await mkdir(resolve(agentDir, "extensions"), { recursive: true });
await writeFile(
  resolve(agentDir, "skills/fixture/SKILL.md"),
  "---\nname: fixture\ndescription: Controlled native Pi skill fixture\n---\nSKILL_EXPANSION_PROOF\n",
);
await writeFile(
  resolve(agentDir, "extensions/unknown.js"),
  `import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
export default function(pi) {
  pi.registerTool({
    name: 'independent_unknown', label: 'Independent fixture',
    description: 'Controlled test tool',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    async execute(id, args, signal, onUpdate, ctx) {
      await writeFile(resolve(ctx.cwd, 'unknown-proof.txt'), 'executed\\n');
      return {content: [{type: 'text', text: 'UNKNOWN_EXECUTED'}], details: {}};
    }
  });
  pi.registerCommand('fixture-handled', {description: 'No-message handled command', handler: async () => {}});
  for (const method of ['input', 'select', 'confirm', 'editor']) {
    pi.registerCommand('fixture-' + method, {
      description: 'Controlled native UI ' + method,
      handler: async (args, ctx) => {
        let value;
        if (method === 'select') value = await ctx.ui.select('Fixture select', ['Alpha', 'Beta']);
        else if (method === 'confirm') value = await ctx.ui.confirm('Fixture confirm', 'Confirm the test?');
        else if (method === 'editor') value = await ctx.ui.editor('Fixture editor', 'Initial text');
        else value = await ctx.ui.input('Fixture input', 'Controlled placeholder');
        ctx.ui.notify('FIXTURE_DIALOG:' + method + ':' + String(value));
      }
    });
  }
  pi.on('session_start', async (_event, ctx) => {
    if (existsSync(resolve(ctx.cwd, 'startup-question.txt'))) {
      const value = await ctx.ui.input('Fixture startup input', 'Startup answer');
      ctx.ui.notify('FIXTURE_STARTUP:' + String(value));
    }
  });
}
`,
);
const checks = [];
const childLogs = [];
const children = [];
const requests = [];
const apiCalls = [];
const snapshots = [];
const streamEvents = [];
const holds = new Map();
let cookie = "";
let base;
let runnerToken;
let stream;
let fixture;
let serverChild;
const runners = new Map();
const WebSocket = createRequire(resolve(root, "apps/server/package.json"))(
  "ws",
);
const model = "independent-fixture/fixture-vision";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
function assert(value, message) {
  if (!value) throw new Error(message);
}
function pass(message, detail = {}) {
  checks.push({ message, ...detail });
  console.log(`[pass] ${message}`);
}
async function wait(probe, description, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await probe();
    if (value) return value;
    await sleep(75);
  }
  throw new Error(`Timeout: ${description}`);
}
async function json(path, body, method = body ? "POST" : "GET", raw = false) {
  const call = { method, path, startedAt: new Date().toISOString() };
  apiCalls.push(call);
  try {
    const response = await fetch(base + path, {
      method,
      signal: AbortSignal.timeout(25000),
      headers: {
        "content-type": "application/json",
        // A fresh connection avoids Node 26/Undici retaining a stale idle socket
        // across the deliberate 26-second human-input wait. A separate native
        // node:http probe confirmed the Server remains responsive in that case.
        connection: "close",
        origin: base,
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    call.status = response.status;
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    const payload = await response.json();
    if (!response.ok && !raw)
      throw new Error(`${response.status} ${JSON.stringify(payload)}`);
    call.endedAt = new Date().toISOString();
    return raw ? { status: response.status, payload } : payload;
  } catch (error) {
    call.error = String(error);
    call.endedAt = new Date().toISOString();
    if (String(error).includes("timeout")) {
      call.freshSocketProbe = await new Promise((resolveProbe) => {
        const probe = httpRequest(
          new URL(path, base),
          { method: "GET", agent: false, headers: { cookie, origin: base } },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.once("end", () =>
              resolveProbe({
                status: response.statusCode,
                bodyBytes: Buffer.concat(chunks).length,
              }),
            );
          },
        );
        probe.setTimeout(2000, () =>
          probe.destroy(new Error("fresh socket timeout")),
        );
        probe.once("error", (probeError) =>
          resolveProbe({ error: String(probeError) }),
        );
        probe.end();
      });
    }
    throw new Error(`${method} ${path}: ${String(error)}`, { cause: error });
  }
}
function child(label, args, env = {}) {
  const proc = spawnWorkspace(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(proc);
  for (const channel of ["stdout", "stderr"]) {
    proc[channel].setEncoding("utf8");
    proc[channel].on("data", (data) => {
      for (const line of data.split("\n"))
        if (!/setup token:|runnerToken|authorization|api.?key/i.test(line))
          childLogs.push(`[${label}:${channel}] ${line}`);
    });
  }
  return proc;
}
async function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise((r) => {
    proc.once("exit", r);
    terminateTestChild(proc);
  });
}
function text(content) {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((x) => x.type === "text")
          .map((x) => x.text)
          .join("\n")
      : "";
}
function sse(response, content, tool) {
  const id = `chatcmpl-${randomUUID()}`;
  const emit = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture-vision", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  emit({ role: "assistant" });
  if (tool) {
    emit({
      tool_calls: [
        {
          index: 0,
          id: `call_${randomUUID().replaceAll("-", "")}`,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(tool.args) },
        },
      ],
    });
    emit({}, "tool_calls");
  } else {
    emit({ content });
    emit({}, "stop");
  }
  response.end("data: [DONE]\n\n");
}
async function startFixture() {
  fixture = createServer(async (req, res) => {
    if (!req.url.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let source = "";
    for await (const chunk of req) source += chunk;
    const body = JSON.parse(source);
    requests.push(body);
    const messages = body.messages ?? [];
    const index = messages.findLastIndex((x) => x.role === "user");
    const prompt = text(messages[index]?.content);
    const last = messages.at(-1);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (prompt.includes("HOLD_")) {
      const marker = prompt.match(/HOLD_[A-Z]+/)?.[0];
      holds.set(marker, { res, prompt });
      res.write(": waiting\n\n");
      return;
    }
    if (last?.role === "tool") {
      sse(res, `TOOL_FINISHED ${prompt}`);
      return;
    }
    if (prompt.includes("CASE_WRITE"))
      sse(res, "", {
        name: "write",
        args: { path: "write-proof.txt", content: "fixture-write\n" },
      });
    else if (prompt.includes("CASE_READ"))
      sse(res, "", { name: "read", args: { path: "seed.txt" } });
    else if (prompt.includes("CASE_COMMAND"))
      sse(res, "", { name: "bash", args: { command: "echo FIXTURE_COMMAND" } });
    else if (prompt.includes("CASE_UNKNOWN"))
      sse(res, "", { name: "independent_unknown", args: {} });
    else if (prompt.includes("CASE_IMAGE"))
      sse(
        res,
        `IMAGE_PRESENT:${messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image_url" && b.image_url?.url?.startsWith("data:image/")))}`,
      );
    else if (prompt.includes("SKILL_EXPANSION_PROOF"))
      sse(res, "SKILL_EXPANDED");
    else if (prompt.includes("中文运行中引导")) sse(res, "中文已收到");
    else sse(res, `FIXTURE_REPLY ${prompt}`);
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const port = fixture.address().port;
  await writeFile(
    resolve(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "independent-fixture": {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "controlled-fixture-no-secret",
          models: [
            {
              id: "fixture-vision",
              name: "Independent fixture vision",
              input: ["text", "image"],
              reasoning: false,
              contextWindow: 32768,
              maxTokens: 2048,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    resolve(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "independent-fixture",
      defaultModel: "fixture-vision",
      defaultThinkingLevel: "off",
      defaultProjectTrust: "always",
      autoCompaction: false,
    }),
  );
}
async function startServer() {
  const dataDir = resolve(evidence, "server");
  await mkdir(dataDir, { recursive: true });
  const temp = createServer();
  await new Promise((r) => temp.listen(0, "127.0.0.1", r));
  const port = temp.address().port;
  await new Promise((r) => temp.close(r));
  base = `http://127.0.0.1:${port}`;
  serverChild = child("server", [resolve(root, "apps/server/dist/index.js")], {
    HOST: "127.0.0.1",
    PORT: String(port),
    ROAMCLI_DATA_DIR: dataDir,
    ROAMCLI_RUNNER_RPC_TIMEOUT_MS: "20000",
  });
  await wait(async () => {
    try {
      return await exists(resolve(dataDir, "setup-token.txt"));
    } catch {
      return false;
    }
  }, "server setup token");
  await wait(async () => {
    try {
      return (await fetch(base + "/v1/auth/status")).ok;
    } catch {
      return false;
    }
  }, "server ready");
  const token = (
    await readFile(resolve(dataDir, "setup-token.txt"), "utf8")
  ).trim();
  await json("/v1/auth/setup", {
    setupToken: token,
    password: "isolated-independent-fixture-password",
  });
  runnerToken = (await json("/v1/auth/account")).account.runnerToken;
  stream = new WebSocket(base.replace("http", "ws") + "/v1/stream", {
    headers: { cookie, origin: base },
  });
  stream.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());
      streamEvents.push(event);
    } catch {
      /* Only JSON application events are relevant to the fixture. */
    }
  });
  await new Promise((r, j) => {
    stream.once("open", r);
    stream.once("error", j);
  });
  pass("real Server owner setup and authenticated stream");
}
async function startRunner(profile) {
  const workspace = resolve(evidence, profile);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "seed.txt"), "read-fixture\n");
  const id = `independent-${profile}-${process.pid}`;
  const proc = child(
    `runner-${profile}`,
    [
      resolve(root, "apps/runner/dist/index.js"),
      "--server",
      base.replace("http", "ws") + "/v1/runner",
      "--runner-id",
      id,
      "--workspace",
      workspace,
      "--data-dir",
      ".runner",
      "--profile",
      profile,
      "--agent-plugin",
      "@roamcli/agent-pi",
    ],
    {
      ROAM_RUNNER_TOKEN: runnerToken,
      USERPROFILE: home,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
    },
  );
  const item = { proc, id, workspace, profile };
  runners.set(profile, item);
  const runner = await wait(async () => {
    const d = await json("/v1/runners");
    return d.runners?.find((x) => x.runnerId === id);
  }, `runner ${profile}`);
  assert(
    runner.capabilities
      .find((x) => x.kind === "pi")
      .permissionNotice.includes("no OS sandbox"),
    "missing Pi capability sandbox notice",
  );
  const projects = await json("/v1/projects");
  item.project =
    projects.projects.find((x) => x.runnerId === id) ??
    (
      await json("/v1/projects", {
        name: `Independent ${profile}`,
        runnerId: id,
        directory: workspace,
      })
    ).project;
  return item;
}
async function createSession(runner, prompt, attachments) {
  return (
    await json("/v1/sessions", {
      requestId: randomUUID(),
      projectId: runner.project.id,
      agent: "pi",
      title: "Independent actual Pi fixture",
      prompt,
      agentRuntimeConfig: { model },
      ...(attachments ? { attachments } : {}),
    })
  ).session;
}
const snapshot = (id) => json(`/v1/sessions/${id}`);
async function complete(session, decision = true) {
  return wait(async () => {
    const d = await snapshot(session.id);
    for (const a of d.approvals ?? [])
      if (a.status === "pending") {
        await json(`/v1/approvals/${a.id}`, { approved: decision });
      }
    if (d.session.status === "failed")
      throw new Error(
        `Pi failed: ${JSON.stringify(streamEvents.filter((event) => event.type === "error" && event.sessionId === session.id).slice(-3))}`,
      );
    if (d.session.status === "completed") {
      snapshots.push(d);
      return d;
    }
    return false;
  }, `complete ${session.id}`);
}
async function follow(session, content, attachments) {
  return json(`/v1/sessions/${session.id}/messages`, {
    requestId: randomUUID(),
    content,
    ...(attachments ? { attachments } : {}),
  });
}
function png() {
  const crc = (data) => {
    let v = 0xffffffff;
    for (const b of data) {
      v ^= b;
      for (let i = 0; i < 8; i++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    }
    return (v ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const t = Buffer.from(name);
    const b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length);
    t.copy(b, 4);
    data.copy(b, 8);
    b.writeUInt32BE(crc(Buffer.concat([t, data])), 8 + data.length);
    return b;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((32 * 4 + 1) * 32);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      raw[y * 129 + 1 + x * 4] = 255;
      raw[y * 129 + 4 + x * 4] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const imageBytes = png();
const image = {
  name: "red-square.png",
  mimeType: "image/png",
  contentBase64: imageBytes.toString("base64"),
  size: imageBytes.length,
};

async function runCases() {
  await startFixture();
  await startServer();
  const standard = await startRunner("standard");
  const options = (
    await json("/v1/agent/runtime-config/options", {
      runnerId: standard.id,
      agent: "pi",
      basePath: standard.workspace,
    })
  ).result;
  assert(
    options.models?.some((x) => x.value === model),
    "fixture model absent",
  );
  pass("real Pi model discovery through Server and Runner");
  const skills = (
    await json("/v1/agent/skills", {
      runnerId: standard.id,
      agent: "pi",
      basePath: standard.workspace,
    })
  ).result;
  assert(
    skills.skills?.some(
      (x) => x.name === "fixture" && x.insertText === "/skill:fixture",
    ),
    "native fixture skill absent",
  );
  pass("real Pi skill discovery through Server and Runner");
  const handledSession = await createSession(standard, "/fixture-handled");
  const handled = await complete(handledSession);
  assert(
    await exists(handled.session.agentThreadId),
    "handled native session file was not persisted",
  );
  await follow(handledSession, "FOLLOW_HANDLED_SESSION");
  const handledResumed = await complete(handledSession);
  assert(
    handledResumed.session.agentThreadId === handled.session.agentThreadId,
    "handled follow-up changed native session file",
  );
  assert(
    handledResumed.messages.some(
      (x) =>
        x.role === "assistant" && x.content.includes("FOLLOW_HANDLED_SESSION"),
    ),
    "handled follow-up reply missing",
  );
  pass(
    "no-message extension command persisted native session and resumed same file",
  );
  const startupFlag = resolve(standard.workspace, "startup-question.txt");
  await writeFile(startupFlag, "trigger isolated startup UI");
  const startupEventIndex = streamEvents.length;
  const startupResponse = await json(
    "/v1/sessions",
    {
      requestId: randomUUID(),
      projectId: standard.project.id,
      agent: "pi",
      title: "Native startup dialog limitation",
      prompt: "/fixture-handled",
      agentRuntimeConfig: { model },
    },
    "POST",
    true,
  );
  assert(
    startupResponse.status === 201 ||
      (startupResponse.status === 400 &&
        startupResponse.payload.error === "runner_error"),
    "unexpected startup rejection response",
  );
  const startupSession = await wait(
    () =>
      streamEvents
        .slice(startupEventIndex)
        .find((event) => event.type === "session:created")?.session,
    "startup session creation event",
  );
  const startupFailure = await wait(async () => {
    const detail = await snapshot(startupSession.id);
    return detail.session.status === "failed" ? detail : false;
  }, "transparent startup dialog failure");
  snapshots.push(startupFailure);
  const startupError = streamEvents.find(
    (event) =>
      event.type === "error" &&
      event.sessionId === startupSession.id &&
      /startup.*dialog|dialog.*startup/i.test(event.message),
  );
  assert(
    startupError,
    "startup dialog failure did not explain the native RPC limitation",
  );
  assert(
    /command|tool|local/i.test(startupError.message),
    "startup dialog error omitted the recovery guidance",
  );
  assert(
    !startupFailure.activities.some((x) =>
      x.label.includes("Fixture startup input"),
    ) &&
      !streamEvents.some(
        (event) =>
          event.type === "session:updated" &&
          event.session.id === startupSession.id &&
          event.session.status === "waiting_input",
      ),
    "unsupported startup dialog left an unanswerable user-input request",
  );
  await unlink(startupFlag);
  pass(
    "unsupported native startup dialog failed with recovery guidance and no pending user input",
  );
  const startupRuntimeErrors = streamEvents.filter(
    (event) =>
      event.sessionId === startupSession.id &&
      ["PI_ERROR", "SPAWN_ERROR"].includes(event.code),
  );
  assert(
    startupRuntimeErrors.every((event) =>
      /startup.*dialog|dialog.*startup/i.test(event.message),
    ),
    "startup failure was overwritten by a generic RPC closure",
  );
  if (onlyStartup) return;
  for (const [method, answer, expected] of [
    ["input", "中文回答", "中文回答"],
    ["select", "Beta", "Beta"],
    ["confirm", "yes", "true"],
    ["editor", "Edited text 中文", "Edited text 中文"],
  ]) {
    if (onlyInput && method !== "input") continue;
    const dialog = await createSession(standard, `/fixture-${method}`);
    const waiting = await wait(async () => {
      const d = await snapshot(dialog.id);
      if (d.session.status === "failed")
        throw new Error(`Dialog ${method} failed before input`);
      return d.session.status === "waiting_input" ? d : false;
    }, `native ${method} reaches Roam user-input tracker`);
    snapshots.push(waiting);
    if (method === "input") {
      console.log(
        "[info] Holding native input dialog for 26 seconds across RPC and Runner deadlines",
      );
      await sleep(26_000);
      assert(
        (await snapshot(dialog.id)).session.status === "waiting_input",
        "waiting input timed out before answer",
      );
    }
    await follow(dialog, answer);
    const answered = await complete(dialog);
    assert(
      answered.activities.some((x) =>
        x.label.includes(`FIXTURE_DIALOG:${method}:${expected}`),
      ),
      `native ${method} did not receive answer`,
    );
    pass(
      `native ${method} dialog answered through Roam user-input tracker${method === "input" ? " after 26-second wait" : ""}`,
    );
  }
  if (onlyInput) return;
  let resumable;
  for (const profile of ["standard", "strict", "trusted"]) {
    const runner =
      profile === "standard" ? standard : await startRunner(profile);
    const reading = await complete(await createSession(runner, "CASE_READ"));
    assert(
      reading.approvals.length === 0,
      `${profile} read requested approval`,
    );
    assert(
      reading.activities.some(
        (x) =>
          x.label.includes("read: finished") &&
          x.label.includes("read-fixture"),
      ),
      "read did not return seed content",
    );
    pass(`${profile} native read completed without approval`);
    const writing = await createSession(runner, "CASE_WRITE");
    if (profile !== "trusted") {
      const pending = await wait(async () => {
        const d = await snapshot(writing.id);
        return d.approvals.find((x) => x.status === "pending") ? d : false;
      }, `${profile} write approval`);
      assert(
        !(await exists(resolve(runner.workspace, "write-proof.txt"))),
        "file mutated before approval",
      );
      assert(
        pending.approvals[0].kind === "applyPatch",
        "wrong write approval kind",
      );
    }
    const written = await complete(writing);
    assert(
      (await readFile(resolve(runner.workspace, "write-proof.txt"), "utf8")) ===
        "fixture-write\n",
      "wrong file output",
    );
    assert(
      written.approvals.length === (profile === "trusted" ? 0 : 1),
      "wrong write approvals",
    );
    assert(
      written.messages.some(
        (x) => x.role === "assistant" && x.content.includes("TOOL_FINISHED"),
      ),
      "assistant reply not persisted",
    );
    assert(
      written.artifacts.some((x) => x.name === "write-proof.txt"),
      "write artifact absent",
    );
    pass(
      `${profile} native write, approval policy, artifact and assistant persistence`,
      {
        sessionFile: written.session.agentThreadId,
        artifactCount: written.artifacts.length,
      },
    );
    for (const [kind, decision] of [
      ["COMMAND", true],
      ["UNKNOWN", false],
    ]) {
      const caseSession = await createSession(runner, `CASE_${kind}`);
      const done = await complete(caseSession, decision);
      assert(
        done.approvals.length === (profile === "trusted" ? 0 : 1),
        `${profile} ${kind} wrong approval count`,
      );
      if (kind === "COMMAND")
        assert(
          done.activities.some(
            (x) =>
              x.label.includes("bash: finished") &&
              x.label.includes("FIXTURE_COMMAND"),
          ),
          `${profile} command did not execute successfully`,
        );
      if (kind === "UNKNOWN")
        assert(
          (await exists(resolve(runner.workspace, "unknown-proof.txt"))) ===
            (profile === "trusted"),
          `${profile} unknown denial did not prevent execution`,
        );
      pass(
        `${profile} native ${kind.toLowerCase()} ${profile === "trusted" ? "automatic" : decision ? "approved" : "denied"}`,
      );
    }
    if (profile === "standard")
      resumable = {
        runner,
        session: writing,
        sessionFile: written.session.agentThreadId,
      };
  }
  const imageSession = await createSession(standard, "CASE_IMAGE", [image]);
  const im = await complete(imageSession);
  assert(
    im.messages.some(
      (x) => x.role === "assistant" && x.content === "IMAGE_PRESENT:true",
    ),
    "image not delivered to HTTP model payload",
  );
  pass("image reached actual Pi and compatible model HTTP payload");
  const skillSession = await createSession(standard, "/skill:fixture");
  const sk = await complete(skillSession);
  assert(
    sk.messages.some(
      (x) => x.role === "assistant" && x.content === "SKILL_EXPANDED",
    ),
    "skill expansion absent",
  );
  pass("native Pi slash skill expanded and reply persisted");
  const steering = await createSession(standard, "HOLD_STEER");
  await wait(() => holds.has("HOLD_STEER"), "steer provider in flight");
  const rejected = await json(
    `/v1/sessions/${steering.id}/messages`,
    {
      requestId: randomUUID(),
      content: "active image should be rejected",
      attachments: [image],
    },
    "POST",
    true,
  );
  assert(
    rejected.status === 409 &&
      rejected.payload.error === "attachments_require_idle",
    "active image was not rejected",
  );
  pass("running image upload rejected with attachments_require_idle");
  await follow(steering, "中文运行中引导");
  sse(holds.get("HOLD_STEER").res, "INITIAL_HOLD_RELEASED");
  holds.delete("HOLD_STEER");
  const steered = await complete(steering);
  assert(
    steered.messages.some(
      (x) => x.role === "assistant" && x.content === "中文已收到",
    ),
    "Chinese steering not consumed",
  );
  pass("running Chinese steer consumed by native Pi and persisted");
  const stopping = await createSession(standard, "HOLD_STOP");
  await wait(() => holds.has("HOLD_STOP"), "stop provider in flight");
  await follow(stopping, "NEVER_EXECUTE_QUEUED");
  stream.send(
    JSON.stringify({
      type: "controlSignal",
      requestId: randomUUID(),
      sessionId: stopping.id,
      signal: "stop",
    }),
  );
  await wait(async () => {
    const d = await snapshot(stopping.id);
    return d.session.status === "stopped";
  }, "stopped");
  pass("stop aborted real Pi while Chinese/text input queue existed");
  const beforeRestart = await snapshot(resumable.session.id);
  await stop(standard.proc);
  await wait(async () => {
    const d = await json("/v1/runners");
    return !d.runners.find((x) => x.runnerId === standard.id);
  }, "runner offline");
  const restarted = await startRunner("standard");
  await follow(resumable.session, "RESUME_NATIVE_PROOF");
  const resumed = await complete(resumable.session);
  assert(
    resumed.session.agentThreadId === resumable.sessionFile,
    "resumed a different native session",
  );
  assert(
    resumed.messages.length > beforeRestart.messages.length,
    "reply not persisted after restart",
  );
  pass(
    "Runner restart resumed identical native Pi sessionFile and persisted follow-up reply",
    { sessionFile: resumed.session.agentThreadId },
  );
  const stoppedBefore = await snapshot(stopping.id);
  await follow(stopping, "AFTER_STOP_RESUME");
  const stoppedResumed = await complete(stopping);
  assert(
    stoppedResumed.session.agentThreadId ===
      stoppedBefore.session.agentThreadId,
    "stopped resume changed native session file",
  );
  assert(
    !requests.some((x) =>
      text(x.messages?.at(-1)?.content).includes("NEVER_EXECUTE_QUEUED"),
    ),
    "stop left queued input for resumed run",
  );
  pass(
    "stopped session resumed same native file without executing cleared queue",
  );
  await writeFile(
    resolve(evidence, "samples.json"),
    JSON.stringify(
      {
        skills,
        options,
        firstWrite: beforeRestart,
        resumed,
        stoppedResumed,
        image: im,
        skill: sk,
        steered,
      },
      null,
      2,
    ),
  );
  pass("controlled actual-Pi end-to-end suite complete");
}
try {
  await runCases();
} catch (error) {
  checks.push({ failure: error.stack ?? String(error) });
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  stream?.close();
  for (const proc of children.reverse()) await stop(proc);
  for (const h of holds.values()) h.res.destroy();
  fixture?.closeAllConnections();
  if (fixture) await new Promise((r) => fixture.close(r));
  await writeFile(
    resolve(evidence, "result.json"),
    JSON.stringify(
      {
        actualPi,
        modelBackend: "controlled HTTP fixture, not an actual LLM",
        checks,
        requestCount: requests.length,
      },
      null,
      2,
    ),
  );
  await writeFile(resolve(evidence, "child.log"), childLogs.join("\n"));
  await writeFile(
    resolve(evidence, "model-requests.json"),
    JSON.stringify(requests, null, 2),
  );
  console.log(`Evidence: ${evidence}`);
  await writeFile(
    resolve(evidence, "all-snapshots.json"),
    JSON.stringify(snapshots, null, 2),
  );
  await writeFile(
    resolve(evidence, "api-calls.json"),
    JSON.stringify(apiCalls, null, 2),
  );
  await writeFile(
    resolve(evidence, "stream-events.json"),
    JSON.stringify(streamEvents, null, 2),
  );
}
