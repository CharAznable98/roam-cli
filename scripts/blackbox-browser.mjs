#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.ROAMCLI_BLACKBOX_TOKEN ?? "dev-token";
const suppliedBaseUrl = process.env.ROAMCLI_BLACKBOX_BASE_URL;
const timeoutMs = Number(process.env.ROAMCLI_BLACKBOX_TIMEOUT_MS ?? 45_000);
const runnerId =
  process.env.ROAMCLI_BLACKBOX_RUNNER_ID ?? `blackbox-${process.pid}`;
const children = [];
const tempDirs = [];
const tempPaths = [];
const logs = [];
let baseUrl = suppliedBaseUrl?.replace(/\/$/, "");
let workspace =
  process.env.ROAMCLI_BLACKBOX_WORKSPACE === undefined
    ? undefined
    : resolve(process.env.ROAMCLI_BLACKBOX_WORKSPACE);

process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});

try {
  await run();
  console.log("[pass] RoamCli browser blackbox completed");
} catch (error) {
  console.error("[fail] RoamCli browser blackbox failed");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  if (logs.length > 0) {
    console.error("\n--- child process logs ---");
    console.error(logs.slice(-100).join(""));
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function run() {
  if (workspace === undefined) {
    workspace = await mkdtemp(resolve(tmpdir(), "roamcli-blackbox-workspace-"));
    tempDirs.push(workspace);
  }

  const startedOwnServer = baseUrl === undefined;
  if (baseUrl === undefined) {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const dataDir = await mkdtemp(
      resolve(tmpdir(), "roamcli-blackbox-server-"),
    );
    tempDirs.push(dataDir);
    startChild("server", "pnpm", ["--filter", "@roamcli/server", "dev"], {
      HOST: "127.0.0.1",
      PORT: String(port),
      ROAMCLI_AUTH_TOKEN: token,
      ROAMCLI_DATA_DIR: dataDir,
      ROAMCLI_RUNNER_RPC_TIMEOUT_MS: "30000",
    });
    await waitForHttp("/v1/runners");
    pass(`server online at ${baseUrl}`);
  } else {
    await waitForHttp("/v1/runners");
    pass(`connected to existing server at ${baseUrl}`);
  }

  const browser = await launchBrowser();
  try {
    if (startedOwnServer) {
      await runNoRunnerJourney(browser);
      pass("empty runner state");
    }

    await ensureRunnerOnline();
    pass(`runner online: ${runnerId}`);

    await runUserJourney(browser, {
      name: "desktop",
      viewport: { width: 1440, height: 960 },
      mobile: false,
      tablet: false,
    });
    await runUserJourney(browser, {
      name: "tablet",
      viewport: { width: 900, height: 1024 },
      mobile: false,
      tablet: true,
    });
    await runUserJourney(browser, {
      name: "mobile",
      viewport: { width: 390, height: 844 },
      mobile: true,
      tablet: false,
    });
  } finally {
    await browser.close();
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch({
      headless: process.env.ROAMCLI_BLACKBOX_HEADFUL !== "1",
    });
  } catch (error) {
    const hint =
      "Unable to launch Chromium. Run `pnpm exec playwright install chromium` and retry `pnpm blackbox:browser`.";
    throw new Error(
      `${hint}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runUserJourney(browser, scenario) {
  const fileName = `.roamcli-blackbox-${scenario.name}-${process.pid}.txt`;
  const filePath = resolve(workspace, fileName);
  const initialValue = `initial-${scenario.name}-${Date.now()}`;
  const editedValue = `edited-${scenario.name}-${Date.now()}`;
  const patchedValue = `patched-${scenario.name}-${Date.now()}`;
  await writeFile(filePath, `${initialValue}\n`, "utf8");
  tempPaths.push(filePath);

  const context = await browser.newContext({ viewport: scenario.viewport });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  try {
    await page.addInitScript((authToken) => {
      window.localStorage.setItem("roamcli.token", authToken);
    }, token);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await expectText(page, "stream connected");
    await expectText(page, "1 runners online");

    const session = await createSessionFromUi(page, scenario, {
      title: `Blackbox ${scenario.name}`,
      prompt: `blackbox prompt ${scenario.name} ${Date.now()}`,
    });
    await expectText(page, `Blackbox ${scenario.name}`);

    const chatEcho = `chat echo ${scenario.name} ${Date.now()}`;
    await sendChatMessage(page, scenario, chatEcho);
    await expectText(page, chatEcho);
    pass(`${scenario.name}: chat round-trip`);

    await openTab(page, scenario, "files");
    await page.getByRole("treeitem", { name: fileName }).click();
    const editor = page.getByLabel(`Edit ${fileName}`);
    await editor.fill(`${editedValue}\n`);
    await page.getByRole("button", { name: "Save file" }).click();
    await expectFileContent(session.id, fileName, `${editedValue}\n`);
    await expectText(page, "Saved");
    pass(`${scenario.name}: file browse/edit/save`);

    await openTab(page, scenario, "terminal");
    const terminalEcho = `terminal echo ${scenario.name} ${Date.now()}`;
    await page
      .locator('input[placeholder="Send input to active session"]:visible')
      .fill(terminalEcho);
    await page.getByRole("button", { name: "Send terminal input" }).click();
    await expectText(page, terminalEcho);
    pass(`${scenario.name}: terminal input`);

    await assertExecApprovals(page, scenario);
    pass(`${scenario.name}: exec approval approve/reject`);

    const artifactFileName = `.roamcli-artifact-${scenario.name}-${process.pid}.log`;
    const artifactPath = resolve(workspace, artifactFileName);
    const artifactContent = `artifact ${scenario.name} ${Date.now()}\n`;
    await writeFile(artifactPath, artifactContent, "utf8");
    tempPaths.push(artifactPath);
    await sendChatMessage(
      page,
      scenario,
      `ROAMCLI_ARTIFACT: ${JSON.stringify({
        type: "artifact",
        path: artifactFileName,
        kind: "log",
        mimeType: "text/plain",
      })}`,
    );
    await openTab(page, scenario, "approvals");
    await expectText(page, artifactFileName);
    await expectText(page, "text/plain");
    pass(`${scenario.name}: artifact display`);

    const hunkId = `hunk-${scenario.name}-${Date.now()}`;
    const approvalLine = `ROAMCLI_APPROVAL: ${JSON.stringify({
      type: "approval_request",
      kind: "applyPatch",
      summary: `Apply blackbox patch ${scenario.name}`,
      payload: {
        hunks: [
          {
            id: hunkId,
            filePath: fileName,
            header: "@@ -1 +1 @@",
            lines: [`-${editedValue}`, `+${patchedValue}`],
            status: "pending",
          },
        ],
      },
    })}`;
    await sendChatMessage(page, scenario, approvalLine);
    await openTab(page, scenario, "approvals");
    await expectText(page, `Apply blackbox patch ${scenario.name}`);
    await page
      .getByRole("button", { name: `Accept patch hunk ${hunkId}` })
      .click();
    await page.getByRole("button", { name: "Apply" }).click();
    await expectFileContent(session.id, fileName, `${patchedValue}\n`);
    await expectText(page, "edited");
    pass(`${scenario.name}: patch review/apply`);

    if (consoleErrors.length > 0) {
      throw new Error(
        `${scenario.name} browser console errors:\n${consoleErrors.join("\n")}`,
      );
    }
  } catch (error) {
    const screenshot = resolve(
      tmpdir(),
      `roamcli-blackbox-${scenario.name}-${process.pid}.png`,
    );
    await page
      .screenshot({ path: screenshot, fullPage: true })
      .catch(() => undefined);
    throw new Error(
      `${scenario.name} journey failed. Screenshot: ${screenshot}\n${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
  } finally {
    await context.close();
  }
}

async function runNoRunnerJourney(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 760 },
  });
  const page = await context.newPage();
  try {
    await page.addInitScript((authToken) => {
      window.localStorage.setItem("roamcli.token", authToken);
    }, token);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await expectText(page, "No runners are online");
    await expectText(page, "pnpm --filter @roamcli/runner dev");
  } finally {
    await context.close();
  }
}

async function assertExecApprovals(page, scenario) {
  const approveSummary = `Approve exec ${scenario.name} ${Date.now()}`;
  await sendChatMessage(
    page,
    scenario,
    `ROAMCLI_APPROVAL: ${JSON.stringify({
      type: "approval_request",
      kind: "execCommand",
      summary: approveSummary,
      payload: { command: `echo ${scenario.name}` },
    })}`,
  );
  await openTab(page, scenario, "approvals");
  await expectText(page, approveSummary);
  await page
    .locator(".approval-card", { hasText: approveSummary })
    .getByRole("button", { name: "Approve" })
    .click();
  await expectText(page, "approved");

  const rejectSummary = `Reject exec ${scenario.name} ${Date.now()}`;
  await sendChatMessage(
    page,
    scenario,
    `ROAMCLI_APPROVAL: ${JSON.stringify({
      type: "approval_request",
      kind: "execCommand",
      summary: rejectSummary,
      payload: { command: "rm -rf /tmp/nope" },
    })}`,
  );
  await openTab(page, scenario, "approvals");
  await expectText(page, rejectSummary);
  await page
    .locator(".approval-card", { hasText: rejectSummary })
    .getByRole("button", { name: "Reject" })
    .click();
  await expectText(page, "rejected");
}

async function createSessionFromUi(page, scenario, values) {
  if (scenario.mobile) {
    await page.getByLabel("Mobile runner controls").locator("summary").click();
  }
  await page
    .locator('input[placeholder="Optional task name"]:visible')
    .fill(values.title);
  await page
    .locator("label.field:visible", { hasText: "Agent" })
    .locator("select")
    .selectOption("codex");
  await page
    .locator("label.field:visible", { hasText: "Working directory" })
    .locator("input")
    .fill(workspace);
  await page
    .locator('textarea[placeholder="Describe the work"]:visible')
    .fill(values.prompt);
  await page.getByRole("button", { name: "Create session" }).click();
  await expectText(page, values.prompt);
  return waitFor(async () => {
    const payload = await requestJson("/v1/sessions");
    return payload.sessions?.find(
      (session) =>
        session.runnerId === runnerId && session.title === values.title,
    );
  }, `session ${values.title} to be persisted`);
}

async function sendChatMessage(page, scenario, content) {
  await openTab(page, scenario, "chat");
  await page.getByLabel("Chat composer").fill(content);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function openTab(page, scenario, tab) {
  if (scenario.mobile) {
    const label =
      tab === "chat"
        ? "对话"
        : tab === "files"
          ? "文件"
          : tab === "terminal"
            ? "终端"
            : "审批";
    await page
      .getByRole("navigation", { name: "Mobile tabs" })
      .getByRole("button", { name: label })
      .click();
    return;
  }
  if (scenario.tablet) {
    const label =
      tab === "chat"
        ? "Conversation"
        : tab === "approvals"
          ? "Approvals"
          : titleCase(tab);
    await page
      .getByRole("navigation", { name: "Tablet workspace tabs" })
      .getByRole("button", { name: label })
      .click();
    return;
  }
  if (tab === "chat") {
    await page
      .getByRole("navigation", { name: "Tablet workspace tabs" })
      .getByRole("button", { name: "Conversation" })
      .click()
      .catch(() => undefined);
    return;
  }
  await page
    .getByRole("navigation", { name: "Tool tabs" })
    .getByRole("button", { name: titleCase(tab) })
    .click();
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
    process.env.ROAMCLI_BLACKBOX_RUNNER_ID === undefined &&
    existing.runners?.[0] !== undefined
  ) {
    return existing.runners[0];
  }

  const wsUrl = new URL("/v1/runner", baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const fakeCodex = await createFakeCodexCommand();
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

async function createFakeCodexCommand() {
  const dir = await mkdtemp(resolve(tmpdir(), "roamcli-blackbox-codex-"));
  tempDirs.push(dir);
  const script = resolve(dir, "fake-codex.mjs");
  await writeFile(
    script,
    [
      "let item = 0;",
      "let buffer = '';",
      "const prompt = process.argv.at(-1) ?? '';",
      "const resumed = process.argv.includes('resume');",
      "console.log(JSON.stringify({ type: 'thread.started', thread_id: resumed ? 'codex-thread-resumed' : 'codex-thread-1' }));",
      "emit(prompt);",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  const lines = buffer.split(/\\r?\\n/);",
      "  buffer = lines.pop() ?? '';",
      "  for (const line of lines) handleLine(line);",
      "});",
      "process.stdin.on('end', () => process.exit(0));",
      "function handleLine(line) {",
      "  const text = line.trim();",
      "  if (text.length === 0) return;",
      "  try {",
      "    const event = JSON.parse(text);",
      "    if (event && (event.type === 'approvalResponse' || event.type === 'controlSignal')) return;",
      "  } catch {}",
      "  emit(text);",
      "}",
      "function emit(text) {",
      "  item += 1;",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { id: `item_${item}`, type: 'agent_message', text } }));",
      "}",
    ].join("\n"),
    "utf8",
  );
  return script;
}

async function expectText(page, text) {
  await waitFor(
    async () => {
      const matches = await page
        .getByText(text, { exact: false })
        .evaluateAll((elements) =>
          elements.some((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          }),
        );
      return matches;
    },
    `visible text ${JSON.stringify(text)}`,
  );
}

async function expectFileContent(sessionId, path, expected) {
  await waitFor(
    async () => {
      const content = await requestJson(
        `/v1/sessions/${sessionId}/files/content?path=${encodeURIComponent(path)}&maxBytes=4096`,
      );
      return content.result?.content === expected;
    },
    `file ${path} to equal ${JSON.stringify(expected)}`,
  );
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

async function requestJson(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText} from ${path}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function waitFor(probe, description) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
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

function titleCase(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function pass(message) {
  console.log(`[pass] ${message}`);
}
