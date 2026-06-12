#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const runStartedAt = new Date();
const artifactDir = resolve(
  repoRoot,
  "artifacts",
  "blackbox-browser",
  runStartedAt.toISOString().replace(/[:.]/g, "-"),
);
const reportRows = [];
const screenshots = [];
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
  await writeReport("passed");
  console.log("[pass] RoamCli browser blackbox completed");
  console.log(`[pass] report: ${resolve(artifactDir, "report.md")}`);
} catch (error) {
  await writeReport("failed", error).catch(() => undefined);
  console.error("[fail] RoamCli browser blackbox failed");
  console.error(`[fail] report: ${resolve(artifactDir, "report.md")}`);
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
  await mkdir(artifactDir, { recursive: true });

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
    startChild(
      "server",
      "pnpm",
      ["--filter", "@roamcli/server", "exec", "tsx", "src/index.ts"],
      {
        HOST: "127.0.0.1",
        PORT: String(port),
        ROAMCLI_AUTH_TOKEN: token,
        ROAMCLI_DATA_DIR: dataDir,
        ROAMCLI_RUNNER_RPC_TIMEOUT_MS: "30000",
      },
    );
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
  const projectName = `Blackbox Project ${scenario.name} ${process.pid}`;
  const projectDir = resolve(
    workspace,
    `.roamcli-blackbox-project-${scenario.name}-${process.pid}`,
  );
  const fileName = `roamcli-blackbox-${scenario.name}-${process.pid}.txt`;
  const initialValue = `initial-${scenario.name}-${Date.now()}`;
  const editedValue = `edited-${scenario.name}-${Date.now()}`;
  const patchedValue = `patched-${scenario.name}-${Date.now()}`;
  const executionMode =
    scenario.name === "desktop" ? "managed_worktree" : "direct";
  await prepareProjectDirectory(projectDir, fileName, initialValue);
  tempDirs.push(projectDir);

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
    if (scenario.mobile) {
      await expectText(page, "Online");
      await assertMobileConnectionSheet(page);
    } else {
      await expectText(page, "stream connected");
      await expectText(page, "1 runners online");
    }

    const project = await createProjectFromUi(page, scenario, {
      name: projectName,
      directory: projectDir,
    });
    if (!scenario.mobile) {
      await expectText(page, projectName);
      await assertProjectTreeStartsCollapsed(page, projectName);
    }
    pass(`${scenario.name}: project created`);

    const session = await createSessionFromUi(page, scenario, {
      title: `Blackbox ${scenario.name}`,
      prompt: `blackbox prompt ${scenario.name} ${Date.now()}`,
      executionMode,
      projectId: project.id,
      projectName: project.name,
    });
    await expectText(page, `Blackbox ${scenario.name}`);
    await captureScreenshot(page, scenario, "session-created");
    if (scenario.name === "desktop") {
      if (
        session.executionMode !== "managed_worktree" ||
        session.executionFolder === projectDir ||
        !session.executionFolder.includes(".roamcli-worktrees")
      ) {
        throw new Error(
          `desktop session did not use a managed worktree: ${JSON.stringify(session)}`,
        );
      }
      pass(`${scenario.name}: managed worktree execution folder`);
    }

    await assertSessionResume(page, scenario, session);
    pass(`${scenario.name}: resume completed session`);
    await waitForSessionStatus(session.id, "completed");

    const chatEcho = `chat echo ${scenario.name} ${Date.now()}`;
    await sendChatMessageAndExpect(
      page,
      scenario,
      session.id,
      chatEcho,
      chatEcho,
    );
    await captureScreenshot(page, scenario, "chat-round-trip");
    pass(`${scenario.name}: chat round-trip`);
    await waitForSessionStatus(session.id, "completed");
    if (executionMode === "managed_worktree") {
      if (consoleErrors.length > 0) {
        throw new Error(
          `${scenario.name} browser console errors:\n${consoleErrors.join("\n")}`,
        );
      }
      pass(`${scenario.name}: managed worktree browser journey`);
      return;
    }

    await assertMarkdownRendering(page, scenario, session.id);
    await captureScreenshot(page, scenario, "markdown-rendering");
    pass(`${scenario.name}: markdown rendering`);
    await waitForSessionStatus(session.id, "completed");

    await openTab(page, scenario, "files");
    await page.getByRole("treeitem", { name: fileName }).click();
    const editor = page.getByLabel(`Edit ${fileName}`);
    await editor.fill(`${editedValue}\n`);
    await page.getByRole("button", { name: "Save file" }).click();
    await expectFileContent(session.id, fileName, `${editedValue}\n`);
    await expectText(page, "Saved");
    await captureScreenshot(page, scenario, "file-edit-save");
    pass(`${scenario.name}: file browse/edit/save`);

    await openTab(page, scenario, "terminal");
    const terminalEcho = `terminal echo ${scenario.name} ${Date.now()}`;
    await page
      .locator('input[placeholder="Send input to active session"]:visible')
      .fill(terminalEcho);
    await page.getByRole("button", { name: "Send terminal input" }).click();
    await expectText(page, terminalEcho);
    await captureScreenshot(page, scenario, "terminal-input");
    pass(`${scenario.name}: terminal input`);

    await waitForSessionStatus(session.id, "completed");
    await assertExecApprovals(page, scenario, session.id);
    await captureScreenshot(page, scenario, "exec-approval");
    pass(`${scenario.name}: exec approval approve/reject`);

    const artifactFileName = `roamcli-artifact-${scenario.name}-${process.pid}.log`;
    const artifactPath = resolve(session.executionFolder, artifactFileName);
    const artifactContent = `artifact ${scenario.name} ${Date.now()}\n`;
    await writeFile(artifactPath, artifactContent, "utf8");
    tempPaths.push(artifactPath);
    await sendChatMessageUntil(
      page,
      scenario,
      session.id,
      `ROAMCLI_ARTIFACT: ${JSON.stringify({
        type: "artifact",
        path: artifactFileName,
        kind: "log",
        mimeType: "text/plain",
      })}`,
      () => sessionHasArtifact(session.id, artifactFileName),
      `artifact ${artifactFileName} to be persisted`,
    );
    await openTab(page, scenario, "approvals");
    await expectText(page, "text/plain");
    await captureScreenshot(page, scenario, "artifact-display");
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
    await sendChatMessageUntil(
      page,
      scenario,
      session.id,
      approvalLine,
      () =>
        sessionHasApproval(session.id, `Apply blackbox patch ${scenario.name}`),
      `patch approval for ${scenario.name} to be persisted`,
    );
    await openTab(page, scenario, "approvals");
    await page
      .getByRole("button", { name: `Accept patch hunk ${hunkId}` })
      .click();
    await page.getByRole("button", { name: "Apply" }).click();
    await expectFileContent(session.id, fileName, `${patchedValue}\n`);
    await expectText(page, "edited");
    await captureScreenshot(page, scenario, "patch-review-apply");
    pass(`${scenario.name}: patch review/apply`);

    await assertResumeFromUi(page, scenario, session);
    await captureScreenshot(page, scenario, "resume-completed-session");
    pass(`${scenario.name}: resume completed session`);

    if (consoleErrors.length > 0) {
      throw new Error(
        `${scenario.name} browser console errors:\n${consoleErrors.join("\n")}`,
      );
    }
  } catch (error) {
    const screenshot = resolve(artifactDir, `${scenario.name}-failure.png`);
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

async function assertResumeFromUi(page, scenario, session) {
  await openTab(page, scenario, "chat");
  await page.getByRole("button", { name: "Resume session" }).click();
  await expectText(page, `Resume session ${session.id}`);
  await waitFor(async () => {
    const payload = await requestJson(`/v1/sessions/${session.id}`);
    return payload.session?.agentThreadId === "codex-thread-resumed";
  }, `session ${session.id} to resume with codex-thread-resumed`);
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
    await captureScreenshot(page, { name: "no-runner" }, "empty-runner-state");
  } finally {
    await context.close();
  }
}

async function assertExecApprovals(page, scenario, sessionId) {
  const approveSummary = `Approve exec ${scenario.name} ${Date.now()}`;
  await sendChatMessageUntil(
    page,
    scenario,
    sessionId,
    `ROAMCLI_APPROVAL: ${JSON.stringify({
      type: "approval_request",
      kind: "execCommand",
      summary: approveSummary,
      payload: { command: `echo ${scenario.name}` },
    })}`,
    () => sessionHasApproval(sessionId, approveSummary),
    `approval ${approveSummary} to be persisted`,
  );
  await openTab(page, scenario, "approvals");
  await page
    .locator(".approval-card", { hasText: approveSummary })
    .getByRole("button", { name: "Approve" })
    .click();
  await expectText(page, "approved");
  await waitForSessionStatus(sessionId, "completed");

  const rejectSummary = `Reject exec ${scenario.name} ${Date.now()}`;
  await sendChatMessageUntil(
    page,
    scenario,
    sessionId,
    `ROAMCLI_APPROVAL: ${JSON.stringify({
      type: "approval_request",
      kind: "execCommand",
      summary: rejectSummary,
      payload: { command: "rm -rf /tmp/nope" },
    })}`,
    () => sessionHasApproval(sessionId, rejectSummary),
    `approval ${rejectSummary} to be persisted`,
  );
  await openTab(page, scenario, "approvals");
  await page
    .locator(".approval-card", { hasText: rejectSummary })
    .getByRole("button", { name: "Reject" })
    .click();
  await expectText(page, "rejected");
  await waitForSessionStatus(sessionId, "completed");
}

async function assertSessionResume(page, scenario, session) {
  await openTab(page, scenario, "chat");
  const conversation = page.getByRole("region", { name: "Conversation" });
  await expectText(page, "已结束");
  await conversation.getByRole("button", { name: "Resume session" }).click();
  await expectText(page, `Resume session ${session.id}`);
}

async function assertMarkdownRendering(page, scenario, sessionId) {
  const heading = `Markdown browser ${scenario.name} ${Date.now()}`;
  const markdown = [
    `# ${heading}`,
    "",
    "- rendered list item",
    "",
    "```ts",
    "const rendered = true;",
    "```",
    "",
    "<div>raw html remains text</div>",
  ].join("\n");
  await sendChatMessageUntil(
    page,
    scenario,
    sessionId,
    markdown,
    async () => {
      const headingVisible = await page
        .getByRole("heading", { name: heading })
        .isVisible()
        .catch(() => false);
      const copyVisible = await page
        .getByRole("button", { name: "Copy ts code" })
        .last()
        .isVisible()
        .catch(() => false);
      const rawHtmlVisible = await hasVisibleText(
        page,
        "<div>raw html remains text</div>",
      );
      return headingVisible && copyVisible && rawHtmlVisible;
    },
    `markdown response ${heading} to render`,
  );
}

async function assertProjectTreeStartsCollapsed(page, projectName) {
  const group = page.getByRole("group", { name: `${projectName} sessions` });
  const initialGroups = await group.count();
  if (initialGroups !== 0) {
    throw new Error(
      `project ${projectName} session branch was expanded by default`,
    );
  }

  await page
    .getByRole("button", { name: `Expand project ${projectName}` })
    .click();
  await group.waitFor();
  await expectText(page, "No sessions");
  await page
    .getByRole("button", { name: `Collapse project ${projectName}` })
    .click();
  await waitFor(
    async () => (await group.count()) === 0,
    `project ${projectName} session branch to collapse`,
  );
}

async function createProjectFromUi(page, scenario, values) {
  if (scenario.mobile) {
    const switcher = await openMobileSessionSwitcher(page);
    await switcher.getByRole("button", { name: "New project" }).click();
    const dialog = page.getByRole("dialog", { name: "New Project" });
    await dialog.waitFor();
    await dialog
      .locator('input[placeholder="Optional project name"]')
      .fill(values.name);
    await dialog
      .locator("label.field", { hasText: "Directory" })
      .locator("input")
      .fill(values.directory);
    await dialog.getByRole("button", { name: "Create project" }).click();
    const project = await waitFor(async () => {
      const payload = await requestJson("/v1/projects");
      return payload.projects?.find((project) => project.name === values.name);
    }, `project ${values.name} to be persisted`);
    const reopenedSwitcher = await openMobileSessionSwitcher(page);
    await waitFor(
      async () =>
        (await reopenedSwitcher.locator("select").first().inputValue()) ===
        project.id,
      `mobile project selector to select ${values.name}`,
    );
    await closeDialog(reopenedSwitcher);
    return project;
  }

  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New Project" });
  await dialog.waitFor();
  await dialog
    .locator('input[placeholder="Optional project name"]')
    .fill(values.name);
  await dialog
    .locator("label.field", { hasText: "Directory" })
    .locator("input")
    .fill(values.directory);
  await dialog.getByRole("button", { name: "Create project" }).click();
  const project = await waitFor(async () => {
    const payload = await requestJson("/v1/projects");
    return payload.projects?.find((project) => project.name === values.name);
  }, `project ${values.name} to be persisted`);
  await waitFor(
    () => hasVisibleText(page, values.name),
    `project ${values.name} to render in tree`,
  );
  return project;
}

async function createSessionFromUi(page, scenario, values) {
  if (scenario.mobile) {
    const switcher = await openMobileSessionSwitcher(page);
    await switcher
      .getByRole("button", {
        name: `New session in selected project ${values.projectName}`,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `New Session - ${values.projectName}`,
    });
    await dialog.waitFor();
    await dialog
      .locator('input[placeholder="Optional task name"]')
      .fill(values.title);
    await dialog
      .locator("label.field:visible", { hasText: "Execution" })
      .locator("select")
      .selectOption(values.executionMode);
    await dialog
      .locator('textarea[placeholder="Describe the work"]')
      .fill(values.prompt);
    await dialog.getByRole("button", { name: "Create session" }).click();
    await expectText(page, values.prompt);
    const session = await waitFor(async () => {
      const payload = await requestJson("/v1/sessions");
      return payload.sessions?.find(
        (session) =>
          session.runnerId === runnerId &&
          session.projectId === values.projectId &&
          session.title === values.title,
      );
    }, `session ${values.title} to be persisted`);
    await page.getByRole("button", { name: /Switch Session/ }).waitFor();
    const reopenedSwitcher = await openMobileSessionSwitcher(page);
    await waitFor(
      async () =>
        (await reopenedSwitcher.locator("select").nth(1).inputValue()) ===
        session.id,
      `mobile session selector to select ${values.title}`,
    );
    await closeDialog(reopenedSwitcher);
    return session;
  }
  await page
    .getByRole("button", { name: `New session in ${values.projectName}` })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `New Session - ${values.projectName}`,
  });
  await dialog.waitFor();
  await dialog
    .locator('input[placeholder="Optional task name"]')
    .fill(values.title);
  await dialog
    .locator("label.field:visible", { hasText: "Agent" })
    .locator("select")
    .selectOption("codex");
  await dialog
    .locator("label.field:visible", { hasText: "Execution" })
    .locator("select")
    .selectOption(values.executionMode);
  await dialog
    .locator('textarea[placeholder="Describe the work"]')
    .fill(values.prompt);
  await dialog.getByRole("button", { name: "Create session" }).click();
  await expectText(page, values.prompt);
  return waitFor(async () => {
    const payload = await requestJson("/v1/sessions");
    return payload.sessions?.find(
      (session) =>
        session.runnerId === runnerId &&
        session.projectId === values.projectId &&
        session.title === values.title,
    );
  }, `session ${values.title} to be persisted`);
}

async function assertMobileConnectionSheet(page) {
  await page.getByRole("button", { name: "Open connection settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Connection" });
  await dialog.waitFor();
  await expectTextIn(dialog, "Stream");
  await expectTextIn(dialog, "open");
  await expectTextIn(dialog, "API");
  await expectTextIn(dialog, "ready");
  await expectTextIn(dialog, "Runners");
  await expectTextIn(dialog, "1");
  await dialog.getByRole("button", { name: "Reconnect now" }).waitFor();
  await closeDialog(dialog);
}

async function openMobileSessionSwitcher(page) {
  const dialog = page.getByRole("dialog", { name: "Switch Session" });
  await waitFor(async () => {
    if (await dialog.isVisible().catch(() => false)) {
      return true;
    }

    const trigger = page
      .getByRole("button", { name: /Switch Session|Choose session/ })
      .first();
    if (!(await trigger.isVisible().catch(() => false))) {
      return false;
    }

    await trigger.click({ timeout: 1_000 }).catch(() => undefined);
    return dialog.isVisible().catch(() => false);
  }, "mobile session switcher to open");
  return dialog;
}

async function closeDialog(dialog) {
  await dialog.getByRole("button", { name: "Close modal" }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function sendChatMessage(page, scenario, content) {
  await openTab(page, scenario, "chat");
  await page.getByLabel("Chat composer").fill(content);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function sendChatMessageAndExpect(
  page,
  scenario,
  sessionId,
  content,
  expectedText,
) {
  await sendChatMessageUntil(
    page,
    scenario,
    sessionId,
    content,
    () => hasVisibleText(page, expectedText),
    `visible text ${JSON.stringify(expectedText)}`,
  );
}

async function sendChatMessageUntil(
  page,
  scenario,
  sessionId,
  content,
  probe,
  description,
) {
  await sendChatMessage(page, scenario, content);
  try {
    await waitFor(probe, description);
    return;
  } catch (error) {
    if (!(await hasVisibleText(page, "Session is not running"))) {
      throw error;
    }
  }

  await waitForSessionStatus(sessionId, "stopped");
  await sendChatMessage(page, scenario, content);
  await waitFor(probe, description);
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
      "if (prompt.length > 0) setImmediate(() => process.exit(0));",
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

async function prepareProjectDirectory(projectDir, fileName, initialValue) {
  await mkdir(projectDir, { recursive: true });
  await writeFile(resolve(projectDir, fileName), `${initialValue}\n`, "utf8");
  await runCommand("git", ["init"], { cwd: projectDir });
  await runCommand("git", ["config", "user.email", "blackbox@example.test"], {
    cwd: projectDir,
  });
  await runCommand("git", ["config", "user.name", "RoamCli Blackbox"], {
    cwd: projectDir,
  });
  await runCommand("git", ["add", fileName], { cwd: projectDir });
  await runCommand("git", ["commit", "-m", "blackbox initial file"], {
    cwd: projectDir,
  });
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

async function expectTextIn(scope, text) {
  await waitFor(
    async () => {
      const matches = await scope
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
    `visible scoped text ${JSON.stringify(text)}`,
  );
}

async function hasVisibleText(page, text) {
  try {
    return await page
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
  } catch {
    return false;
  }
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

async function waitForSessionStatus(sessionId, status) {
  await waitFor(async () => {
    const detail = await requestJson(`/v1/sessions/${sessionId}`);
    return detail.session?.status === status;
  }, `session ${sessionId} to be ${status}`);
}

async function sessionHasApproval(sessionId, summary) {
  const detail = await requestJson(`/v1/sessions/${sessionId}`);
  return detail.approvals?.some((approval) => approval.summary === summary);
}

async function sessionHasArtifact(sessionId, name) {
  const detail = await requestJson(`/v1/sessions/${sessionId}`);
  return detail.artifacts?.some((artifact) => artifact.name === name);
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

async function runCommand(command, args, options = {}) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectCommand);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(
        new Error(
          `${command} ${args.join(" ")} failed code=${code ?? "null"} signal=${signal ?? "null"}\n${stdout}${stderr}`,
        ),
      );
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

function titleCase(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function pass(message) {
  reportRows.push({ status: "PASS", message });
  console.log(`[pass] ${message}`);
}

async function captureScreenshot(page, scenario, label) {
  await mkdir(artifactDir, { recursive: true });
  const sequence = String(screenshots.length + 1).padStart(2, "0");
  const name = `${sequence}-${slugify(scenario.name)}-${slugify(label)}.png`;
  const path = resolve(artifactDir, name);
  await page.screenshot({ path, fullPage: true });
  screenshots.push({
    scenario: scenario.name,
    label,
    relativePath: `./${name}`,
  });
}

async function writeReport(status, error) {
  await mkdir(artifactDir, { recursive: true });
  const reportPath = resolve(artifactDir, "report.md");
  const finishedAt = new Date();
  const lines = [
    "# RoamCli Browser Blackbox Report",
    "",
    `- Status: ${status}`,
    `- Started: ${runStartedAt.toISOString()}`,
    `- Finished: ${finishedAt.toISOString()}`,
    `- Base URL: ${baseUrl ?? "(not initialized)"}`,
    `- Runner ID: ${runnerId}`,
    `- Workspace: ${workspace ?? "(not initialized)"}`,
    "",
    "## Assertions",
    "",
    "| Result | Check |",
    "| --- | --- |",
    ...reportRows.map(
      (row) => `| ${row.status} | ${escapeTableCell(row.message)} |`,
    ),
    "",
    "## Screenshots",
    "",
  ];

  if (screenshots.length === 0) {
    lines.push("No screenshots were captured.");
  } else {
    for (const screenshot of screenshots) {
      lines.push(
        `### ${screenshot.scenario}: ${screenshot.label}`,
        "",
        `![${screenshot.scenario} ${screenshot.label}](${screenshot.relativePath})`,
        "",
      );
    }
  }

  if (error !== undefined) {
    lines.push(
      "## Failure",
      "",
      "```text",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      "```",
      "",
    );
  }

  await writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeTableCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
