#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerPassword =
  process.env.ROAMCLI_BLACKBOX_PASSWORD ?? "roamcli-blackbox-password";
const suppliedBaseUrl = process.env.ROAMCLI_BLACKBOX_BASE_URL;
const timeoutMs = Number(process.env.ROAMCLI_BLACKBOX_TIMEOUT_MS ?? 45_000);
const runNonce = `${process.pid}-${Date.now().toString(36)}`;
const runnerId =
  process.env.ROAMCLI_BLACKBOX_RUNNER_ID ?? `blackbox-${runNonce}`;
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
let cookieHeader = "";
let runnerToken = "";
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
        ROAMCLI_DATA_DIR: dataDir,
        ROAMCLI_RUNNER_RPC_TIMEOUT_MS: "30000",
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
      name: "desktop-direct",
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
    await runAccountSecurityJourney(browser, {
      name: "desktop",
      viewport: { width: 1440, height: 960 },
      mobile: false,
    });
    await runAccountSecurityJourney(browser, {
      name: "mobile",
      viewport: { width: 390, height: 844 },
      mobile: true,
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

async function authenticate({ setupDataDir }) {
  const statusPayload = await requestJson("/v1/auth/status");
  const status = statusPayload.auth?.status;
  if (status === "setup_required") {
    if (!setupDataDir) {
      throw new Error(
        "Server requires setup. Run against a local server started by this script, or complete setup before using ROAMCLI_BLACKBOX_BASE_URL.",
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
  if (runnerToken.length === 0) {
    throw new Error("account security state did not include a runner token");
  }
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

async function addAuthCookie(context) {
  if (!cookieHeader) {
    throw new Error("owner session cookie is not available");
  }
  const [name, ...valueParts] = cookieHeader.split("=");
  const value = valueParts.join("=");
  if (!name || !value) {
    throw new Error("owner session cookie is malformed");
  }
  await context.addCookies([
    {
      name,
      value,
      url: baseUrl,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

async function syncCookieFromContext(context) {
  const cookies = await context.cookies(baseUrl);
  const sessionCookie = cookies.find((cookie) => cookie.value.length > 0);
  if (!sessionCookie) {
    throw new Error("owner session cookie was not set after browser login");
  }
  cookieHeader = `${sessionCookie.name}=${sessionCookie.value}`;
}

function formatBrowserErrors(scenario, consoleErrors, browserHttpErrors) {
  const sections = [];
  if (consoleErrors.length > 0) {
    sections.push(
      `${scenario.name} browser console errors:\n${consoleErrors.join("\n")}`,
    );
  }
  if (browserHttpErrors.length > 0) {
    sections.push(
      `${scenario.name} browser HTTP errors:\n${browserHttpErrors.join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function isExpectedBrowserCancellation(message) {
  return message.trim() === "Canceled";
}

async function runUserJourney(browser, scenario) {
  const projectName = `Blackbox Project ${scenario.name} ${runNonce}`;
  const projectDir = resolve(
    workspace,
    `.roamcli-blackbox-project-${scenario.name}-${runNonce}`,
  );
  const projectDirectorySuffix = relative(workspace, projectDir);
  const fileName = `roamcli-blackbox-${scenario.name}-${runNonce}.txt`;
  const markdownFileName = `roamcli-blackbox-${scenario.name}-${runNonce}.md`;
  const imageFileName = `roamcli-blackbox-${scenario.name}-${runNonce}.png`;
  const initialValue = `initial-${scenario.name}-${Date.now()}`;
  const markdownHeading = `Markdown file ${scenario.name} ${Date.now()}`;
  const markdownValue = `# ${markdownHeading}\n\n- rendered file item\n`;
  const editedValue = `edited-${scenario.name}-${Date.now()}`;
  const patchedValue = `patched-${scenario.name}-${Date.now()}`;
  const executionMode =
    scenario.name === "desktop" ? "managed_worktree" : "direct";
  await prepareProjectDirectory(projectDir, {
    fileName,
    initialValue,
    markdownFileName,
    markdownValue,
    imageFileName,
  });
  tempDirs.push(projectDir);

  const context = await browser.newContext({ viewport: scenario.viewport });
  await addAuthCookie(context);
  const page = await context.newPage();
  const consoleErrors = [];
  const browserHttpErrors = [];
  const browserHttpErrorReads = new Set();
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !isExpectedBrowserCancellation(text)) {
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (error) => {
    if (!isExpectedBrowserCancellation(error.message)) {
      consoleErrors.push(error.message);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) {
      return;
    }
    const read = response
      .text()
      .then((body) => {
        browserHttpErrors.push(
          `${response.status()} ${response.statusText()} ${response.request().method()} ${response.url()}: ${body.slice(0, 500)}`,
        );
      })
      .catch(() => {
        browserHttpErrors.push(
          `${response.status()} ${response.statusText()} ${response.request().method()} ${response.url()}`,
        );
      })
      .finally(() => browserHttpErrorReads.delete(read));
    browserHttpErrorReads.add(read);
  });

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    if (scenario.mobile) {
      await expectText(page, "Online");
      await assertMobileConnectionSheet(page);
    } else {
      await expectText(page, "stream connected");
      await expectText(page, "runners online");
    }

    const project = await createProjectFromUi(page, scenario, {
      name: projectName,
      directory: projectDir,
      directorySuffix: projectDirectorySuffix,
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
        !session.executionFolder.includes(".roam-runner/worktrees")
      ) {
        throw new Error(
          `desktop session did not use a managed worktree: ${JSON.stringify(session)}`,
        );
      }
      pass(`${scenario.name}: managed worktree execution folder`);
    }

    await assertMobileTouchTargets(page, scenario);
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
      await assertManagedWorktreeGitUi(page, scenario, project, session, {
        fileName,
        editedValue,
      });
      await Promise.allSettled(browserHttpErrorReads);
      if (consoleErrors.length > 0 || browserHttpErrors.length > 0) {
        throw new Error(
          formatBrowserErrors(scenario, consoleErrors, browserHttpErrors),
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
    await assertFileOpensReadOnly(page, fileName, `${initialValue}\n`);
    await assertFileEditCancelDiscards(page, fileName, {
      original: `${initialValue}\n`,
      cancelled: `cancelled-${scenario.name}-${Date.now()}\n`,
    });
    await page
      .locator('section[aria-label="Files"]')
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await replaceEditorContent(page, fileName, `${editedValue}\n`);
    await page.getByRole("button", { name: "Save file" }).click();
    await expectFileContent(session.id, fileName, `${editedValue}\n`);
    await expectSaveButtonDisabled(page);
    await assertNoVisibleText(page, "Saved");
    await captureScreenshot(page, scenario, "file-edit-save");
    pass(`${scenario.name}: file browse/edit/save`);

    await assertMarkdownFilePreview(page, scenario, {
      fileName: markdownFileName,
      heading: markdownHeading,
      source: markdownValue,
    });
    await captureScreenshot(page, scenario, "file-markdown-preview");
    pass(`${scenario.name}: markdown file preview`);

    await assertImageFilePreview(page, scenario, imageFileName);
    await captureScreenshot(page, scenario, "file-image-preview");
    pass(`${scenario.name}: image file preview`);

    await assertProjectGitUi(page, scenario, project, fileName);
    await assertMobileGitTouchTargets(page, scenario);
    await captureScreenshot(page, scenario, "git-project-diff");
    await assertGitDiffEditOpensFile(page, scenario, fileName);
    await captureScreenshot(page, scenario, "git-diff-edit-file");
    pass(`${scenario.name}: project Git tab diff`);

    await waitForSessionStatus(session.id, "completed");
    await assertExecApprovals(page, scenario, session.id);
    await captureScreenshot(page, scenario, "exec-approval");
    pass(`${scenario.name}: exec approval approve/reject`);

    const artifactFileName = `roamcli-artifact-${scenario.name}-${runNonce}.log`;
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

    await Promise.allSettled(browserHttpErrorReads);
    if (consoleErrors.length > 0 || browserHttpErrors.length > 0) {
      throw new Error(
        formatBrowserErrors(scenario, consoleErrors, browserHttpErrors),
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

async function assertManagedWorktreeGitUi(
  page,
  scenario,
  project,
  session,
  values,
) {
  const gitContext = { kind: "session_worktree", sessionId: session.id };
  await writeFile(
    resolve(session.executionFolder, values.fileName),
    `${values.editedValue}\n`,
    "utf8",
  );
  await writeFile(
    resolve(project.directory, values.fileName),
    `project-${values.editedValue}\n`,
    "utf8",
  );

  await openTab(page, scenario, "git");
  await expectGitContextLabel(page, `Worktree - ${session.title}`);
  await expectText(page, values.fileName);
  await expectText(page, "Working tree diff");
  await waitForGitStatus(gitContext, (status) => !status.clean);
  await waitForGitDiffReady(page);
  await assertGitDiffFullscreen(page);
  await assertNoRunnerRequestFailed(page);
  await captureScreenshot(page, scenario, "git-worktree-diff");
  await selectGitContext(page, `Project - ${project.name}`);
  await waitForGitStatus(
    { kind: "project", projectId: project.id },
    (status) => !status.clean,
  );
  await waitForGitDiffReady(page);
  await assertNoVisibleButton(page, "Edit");
  await selectGitContext(page, `Worktree - ${session.title}`);
  await waitForGitStatus(gitContext, (status) => !status.clean);
  await waitForGitDiffReady(page);
  await assertGitDiffEditOpensFile(page, scenario, values.fileName);
  await captureScreenshot(page, scenario, "git-worktree-diff-edit-file");
  await openTab(page, scenario, "git");
  await waitForGitDiffReady(page);

  await clickGitActionAndExpectJob(page, "/v1/git/stage", () =>
    clickGitMenuItem(page, "File actions", "Stage"),
  );
  await waitForGitStatus(gitContext, (status) =>
    status.groups.some(
      (group) =>
        group.id === "staged" &&
        group.changes.some((change) => change.path === values.fileName),
    ),
  );

  await page
    .locator(".git-commit-box textarea")
    .fill(`blackbox git ${scenario.name} ${Date.now()}`);
  await clickGitActionAndExpectJob(page, "/v1/git/commit", () =>
    page.getByRole("button", { name: "Commit staged" }).click(),
  );
  await waitForGitStatus(gitContext, (status) => status.clean);
  await expectText(page, "Working tree is clean");
  await assertNoRunnerRequestFailed(page);
  await captureScreenshot(page, scenario, "git-worktree-commit");

  await page.getByRole("tab", { name: "Branch & Sync" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await clickGitActionAndExpectJob(page, "/v1/git/worktree/remove", () =>
    clickGitMenuItem(page, "Branch actions", "Remove worktree"),
  );
  await waitFor(async () => {
    const payload = await requestJson(`/v1/sessions/${session.id}`);
    return typeof payload.session?.worktreeDeletedAt === "string";
  }, `worktree removal to be persisted for ${session.id}`);
  await expectGitContextLabel(page, `Project - ${project.name}`);
  await assertNoRunnerRequestFailed(page);
  await captureScreenshot(page, scenario, "git-worktree-remove");
  pass(`${scenario.name}: Git worktree stage/commit/remove`);
}

async function expectGitContextLabel(page, text) {
  await waitFor(
    async () =>
      page
        .locator(".git-context-field select")
        .evaluate((select, expectedText) => {
          if (!(select instanceof HTMLSelectElement)) {
            return false;
          }
          const selectedLabel =
            select.options[select.selectedIndex]?.textContent ?? "";
          return selectedLabel.includes(expectedText);
        }, text)
        .catch(() => false),
    `Git context label ${text}`,
  );
}

async function selectGitContext(page, text) {
  await page.locator(".git-context-field select").selectOption({ label: text });
  await expectGitContextLabel(page, text);
}

async function assertProjectGitUi(page, scenario, project, fileName) {
  const gitContext = { kind: "project", projectId: project.id };
  await openTab(page, scenario, "git");
  await expectText(page, "Git");
  await expectText(page, fileName);
  await expectText(page, "Working tree diff");
  await waitForGitStatus(gitContext, (status) => !status.clean);
  await waitForGitDiffReady(page);
  await assertGitDiffFullscreen(page);
  await assertNoRunnerRequestFailed(page);
}

async function assertGitDiffEditOpensFile(page, scenario, fileName) {
  await openTab(page, scenario, "git");
  await waitForGitDiffReady(page);
  await page
    .locator('section[aria-label="Git"]')
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await waitForFileEditorMode(page, fileName);
  await assertNoVisibleText(page, "Editable");
  await assertNoVisibleText(page, "Saved");
}

async function assertGitDiffFullscreen(page) {
  const fullscreenButton = page.getByRole("button", {
    name: "Fullscreen diff",
  });
  await fullscreenButton.click();
  await waitFor(
    async () =>
      (await page.locator(".git-diff-pane.is-fullscreen").count()) > 0,
    "Git diff pane to enter fullscreen",
  );
  await page.keyboard.press("Escape");
  await waitFor(
    async () =>
      (await page.locator(".git-diff-pane.is-fullscreen").count()) === 0,
    "Git diff pane to exit fullscreen",
  );
}

async function assertFileOpensReadOnly(page, fileName, expectedValue) {
  const preview = page.locator(".monaco-file-editor").last();
  await waitFor(
    async () => (await preview.count()) > 0 && (await preview.isVisible()),
    `read-only source preview for ${fileName}`,
  );
  await page
    .locator('section[aria-label="Files"] .editor-header h3', {
      hasText: fileName,
    })
    .waitFor();
  await expectText(page, expectedValue.trim());
  await page
    .locator('section[aria-label="Files"]')
    .getByRole("button", { name: "Edit", exact: true })
    .waitFor();
  await assertNoVisibleButton(page, "Save file");
  await assertNoVisibleText(page, "Editable");
  await assertNoVisibleText(page, "Saved");
}

async function assertFileEditCancelDiscards(page, fileName, values) {
  const filesPanel = page.locator('section[aria-label="Files"]');
  await filesPanel.getByRole("button", { name: "Edit", exact: true }).click();
  await replaceEditorContent(page, fileName, values.cancelled);
  const saveButton = filesPanel.getByRole("button", { name: "Save file" });
  await waitFor(
    async () =>
      (await saveButton.count()) > 0 && (await saveButton.isEnabled()),
    "Save file button to become enabled after dirty edit",
  );
  const dialogPromise = page.waitForEvent("dialog");
  const cancelClick = filesPanel
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  const dialog = await dialogPromise;
  const expectedMessage = `Discard unsaved changes in ${fileName}?`;
  if (dialog.message() !== expectedMessage) {
    throw new Error(
      `Unexpected cancel confirmation: ${dialog.message()} (expected ${expectedMessage})`,
    );
  }
  await dialog.accept();
  await cancelClick;
  await assertFileOpensReadOnly(page, fileName, values.original);
}

async function assertMarkdownFilePreview(page, scenario, values) {
  const filesPanel = page.locator('section[aria-label="Files"]');
  await openTab(page, scenario, "files");
  await page.getByRole("treeitem", { name: values.fileName }).click();
  await page.getByRole("heading", { name: values.heading }).waitFor();
  await expectText(page, "rendered file item");
  const marker = await page
    .locator(".file-markdown-preview li", { hasText: "rendered file item" })
    .first()
    .evaluate((item) => {
      const list = item.parentElement;
      const itemStyle = window.getComputedStyle(item);
      const listStyle = list
        ? window.getComputedStyle(list)
        : window.getComputedStyle(item);
      return {
        itemDisplay: itemStyle.display,
        listStyleType: listStyle.listStyleType || itemStyle.listStyleType,
      };
    });
  if (marker.itemDisplay !== "list-item" || marker.listStyleType === "none") {
    throw new Error(
      `Markdown list marker is not visible: ${JSON.stringify(marker)}`,
    );
  }
  await waitFor(
    async () =>
      (await page
        .locator('section[aria-label="Files"] .monaco-file-editor')
        .count()) === 0,
    `${values.fileName} source editor hidden in rendered markdown mode`,
  );

  await filesPanel.getByRole("button", { name: "Source", exact: true }).click();
  const source = page.locator(
    'section[aria-label="Files"] .monaco-file-editor',
  );
  await waitFor(
    async () => (await source.count()) > 0 && (await source.isVisible()),
    `${values.fileName} source preview`,
  );
  await expectText(page, values.source.split("\n")[0]);

  await filesPanel
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await filesPanel
    .getByRole("button", { name: "Fullscreen preview", exact: true })
    .click();
  await waitFor(
    async () =>
      (await page.locator(".editor-placeholder.is-fullscreen").count()) > 0,
    "file preview to enter fullscreen",
  );
  await page.keyboard.press("Escape");
  await waitFor(
    async () =>
      (await page.locator(".editor-placeholder.is-fullscreen").count()) === 0,
    "file preview to exit fullscreen",
  );

  await page
    .locator('section[aria-label="Files"]')
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await waitForFileEditorMode(page, values.fileName);
  await assertNoVisibleButton(page, "Preview");
  await filesPanel.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: values.heading }).waitFor();
}

async function assertImageFilePreview(page, scenario, imageFileName) {
  const filesPanel = page.locator('section[aria-label="Files"]');
  await openTab(page, scenario, "files");
  await page.getByRole("treeitem", { name: imageFileName }).click();
  const image = filesPanel.getByRole("img", {
    name: `Preview ${imageFileName}`,
  });
  await image.waitFor();
  const metrics = await image.evaluate((element) => {
    const image = element;
    const rect = image.getBoundingClientRect();
    const style = window.getComputedStyle(image);
    return {
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      width: rect.width,
      height: rect.height,
      display: style.display,
      visibility: style.visibility,
    };
  });
  if (
    !metrics.complete ||
    metrics.naturalWidth !== 1 ||
    metrics.naturalHeight !== 1 ||
    metrics.width < 80 ||
    metrics.height < 80 ||
    metrics.display === "none" ||
    metrics.visibility === "hidden"
  ) {
    throw new Error(
      `1x1 image preview is not discoverable: ${JSON.stringify(metrics)}`,
    );
  }
  await assertNoVisibleButton(page, "Edit");
  await assertNoVisibleButton(page, "Save file");
  await filesPanel
    .getByRole("button", { name: "Fullscreen preview", exact: true })
    .click();
  await waitFor(
    async () =>
      (await page.locator(".editor-placeholder.is-fullscreen").count()) > 0,
    "image preview to enter fullscreen",
  );
  await page.keyboard.press("Escape");
  await waitFor(
    async () =>
      (await page.locator(".editor-placeholder.is-fullscreen").count()) === 0,
    "image preview to exit fullscreen",
  );
}

async function waitForFileEditorMode(page, fileName) {
  const filesPanel = page.locator('section[aria-label="Files"]');
  await filesPanel
    .locator(".editor-header h3", { hasText: fileName })
    .waitFor();
  await filesPanel
    .getByRole("button", { name: "Cancel", exact: true })
    .waitFor();
  await filesPanel.getByRole("button", { name: "Save file" }).waitFor();
  await waitFor(
    async () =>
      (await filesPanel.locator(".monaco-file-editor").count()) > 0 &&
      (await filesPanel.locator(".monaco-file-editor").last().isVisible()),
    `file editor for ${fileName}`,
  );
}

async function waitForGitStatus(gitContext, predicate) {
  return waitFor(
    async () => {
      const payload = await requestJson("/v1/git/status", {
        method: "POST",
        body: JSON.stringify(gitContext),
      });
      const status = payload.result;
      return status?.kind === "repository" && predicate(status);
    },
    `Git status ${JSON.stringify(gitContext)}`,
  );
}

async function clickGitMenuItem(page, menuLabel, itemName) {
  const menu = page
    .locator(".git-action-menu", {
      has: page.locator(`summary[aria-label="${menuLabel}"]`),
    })
    .last();
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: itemName, exact: true }).click();
}

async function clickGitActionAndExpectJob(page, path, click) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === path,
      { timeout: timeoutMs },
    ),
    click(),
  ]);
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok()) {
    throw new Error(
      `${path} failed with ${response.status()} ${response.statusText()}: ${JSON.stringify(payload)}`,
    );
  }
  if (payload.job?.status === "failed") {
    throw new Error(
      `${path} returned failed job: ${payload.job.errorSummary ?? JSON.stringify(payload.job)}`,
    );
  }
  return payload.job;
}

async function waitForGitDiffReady(page) {
  await waitFor(async () => {
    if (await hasVisibleText(page, "Loading diff...")) return false;
    if (await hasVisibleText(page, "Loading...")) return false;
    const renderedLines = await page
      .locator(".git-diff-pane .view-line")
      .count()
      .catch(() => 0);
    return renderedLines > 0;
  }, "Git Monaco diff to render");
}

async function assertNoRunnerRequestFailed(page) {
  if (await hasVisibleText(page, "Runner request failed")) {
    throw new Error("Runner request failed notification is visible");
  }
}

async function assertMobileGitTouchTargets(page, scenario) {
  if (!scenario.mobile) {
    return;
  }
  const firstActionMenu = page.locator(".git-panel .git-action-menu").first();
  if ((await firstActionMenu.count()) > 0) {
    await firstActionMenu.locator("summary").click();
  }
  const failures = await page.evaluate(() => {
    const minSize = 44;
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const targets = [
      ...Array.from(
        document.querySelectorAll(".git-panel .git-action-menu > summary"),
      ).map((element, index) => ({
        name: `Git action summary ${index + 1}`,
        element,
      })),
      ...Array.from(
        document.querySelectorAll(".git-panel .git-action-menu-content button"),
      )
        .filter(visible)
        .map((element, index) => ({
          name: `Git action menu item ${index + 1}`,
          element,
        })),
      ...Array.from(
        document.querySelectorAll(".git-panel .git-tree-folder summary"),
      ).map((element, index) => ({
        name: `Git tree folder ${index + 1}`,
        element,
      })),
    ];
    return targets
      .map(({ name, element }) => {
        const rect = element.getBoundingClientRect();
        return {
          name,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          tooSmall: rect.width < minSize || rect.height < minSize,
        };
      })
      .filter((target) => target.tooSmall);
  });
  await page.keyboard.press("Escape");
  if (failures.length > 0) {
    throw new Error(
      `mobile Git touch targets below 44px: ${JSON.stringify(failures)}`,
    );
  }
}

async function assertMobileTouchTargets(page, scenario) {
  if (!scenario.mobile) {
    return;
  }
  const conversation = page.getByRole("region", { name: "Conversation" });
  await conversation.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menu", { name: "Session actions" }).waitFor();
  const failures = await page.evaluate(() => {
    const minSize = 44;
    const targets = [
      {
        name: "Session actions button",
        element: document.querySelector(
          '.session-actions > button[aria-label="Session actions"]',
        ),
      },
      {
        name: "Send message button",
        element: document.querySelector('button[aria-label="Send message"]'),
      },
      ...Array.from(document.querySelectorAll(".session-action-menu-item")).map(
        (element, index) => ({
          name: `Session action menu item ${index + 1}`,
          element,
        }),
      ),
    ];
    return targets
      .map(({ name, element }) => {
        if (!element) {
          return { name, missing: true };
        }
        const rect = element.getBoundingClientRect();
        return {
          name,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          tooSmall: rect.width < minSize || rect.height < minSize,
        };
      })
      .filter((target) => target.missing || target.tooSmall);
  });
  await page.keyboard.press("Escape");
  if (failures.length > 0) {
    throw new Error(
      `mobile touch targets below 44px: ${JSON.stringify(failures)}`,
    );
  }
}

async function clickSessionAction(page, scenario, actionName) {
  const conversation = page.getByRole("region", { name: "Conversation" });
  await conversation.getByRole("button", { name: "Session actions" }).click();
  await page
    .getByRole("menu", { name: "Session actions" })
    .getByRole("menuitem", { name: sessionActionMenuItemName(actionName) })
    .click();
}

function sessionActionMenuItemName(actionName) {
  return actionName.replace(/ session$/u, "");
}

async function assertResumeFromUi(page, scenario, session) {
  await openTab(page, scenario, "chat");
  await clickSessionAction(page, scenario, "Resume session");
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
  await addAuthCookie(context);
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await expectText(page, "No runners are online");
    await expectText(page, "pnpm --filter @roamcli/runner dev");
    const runnerUrl = new URL("/v1/runner", baseUrl);
    runnerUrl.protocol = runnerUrl.protocol === "https:" ? "wss:" : "ws:";
    await expectText(page, runnerUrl.toString());
    const bodyText = await page.locator("body").innerText();
    if (!baseUrl.includes(":8787") && bodyText.includes("127.0.0.1:8787")) {
      throw new Error("no-runner command still hardcodes 127.0.0.1:8787");
    }
    await captureScreenshot(page, { name: "no-runner" }, "empty-runner-state");
  } finally {
    await context.close();
  }
}

async function runAccountSecurityJourney(browser, scenario) {
  await authenticate({});
  const context = await browser.newContext({ viewport: scenario.viewport });
  await addAuthCookie(context);
  const page = await context.newPage();
  const consoleErrors = [];
  const browserHttpErrors = [];
  const browserHttpErrorReads = new Set();
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !isExpectedBrowserCancellation(text)) {
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (error) => {
    if (!isExpectedBrowserCancellation(error.message)) {
      consoleErrors.push(error.message);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) {
      return;
    }
    const read = response
      .text()
      .then((body) => {
        browserHttpErrors.push(
          `${response.status()} ${response.statusText()} ${response.request().method()} ${response.url()}: ${body.slice(0, 500)}`,
        );
      })
      .catch(() => {
        browserHttpErrors.push(
          `${response.status()} ${response.statusText()} ${response.request().method()} ${response.url()}`,
        );
      })
      .finally(() => browserHttpErrorReads.delete(read));
    browserHttpErrorReads.add(read);
  });

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    if (scenario.mobile) {
      await expectText(page, "Online");
      await page
        .getByRole("button", { name: "Open Account & Security" })
        .click();
    } else {
      await expectText(page, "stream connected");
      await page.getByRole("button", { name: "Account & Security" }).click();
    }

    const dialog = page.getByRole("dialog", { name: "Account & Security" });
    await dialog.waitFor();
    await expectTextIn(dialog, "Runner Token");
    await expectTextIn(dialog, runnerToken);
    await expectTextIn(dialog, "--token");
    await expectTextIn(dialog, "Copy command");
    await captureScreenshot(
      page,
      { name: `account-${scenario.name}` },
      "account-security-open",
    );

    await dialog.getByRole("button", { name: "Log out", exact: true }).click();
    await expectText(page, "Owner Login");
    await waitFor(
      async () =>
        (await page
          .getByRole("dialog", { name: "Account & Security" })
          .count()) === 0,
      `${scenario.name} account security modal to close after logout`,
    );

    await page.getByLabel("Password").fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    if (scenario.mobile) {
      await expectText(page, "Online");
    } else {
      await expectText(page, "stream connected");
    }
    await waitFor(
      async () =>
        (await page
          .getByRole("dialog", { name: "Account & Security" })
          .count()) === 0,
      `${scenario.name} account security modal to stay closed after login`,
    );
    await captureScreenshot(
      page,
      { name: `account-${scenario.name}` },
      "account-security-login",
    );
    await syncCookieFromContext(context);

    await Promise.allSettled(browserHttpErrorReads);
    if (consoleErrors.length > 0 || browserHttpErrors.length > 0) {
      throw new Error(
        formatBrowserErrors(scenario, consoleErrors, browserHttpErrors),
      );
    }
    pass(`${scenario.name}: account security logout/login`);
  } catch (error) {
    const screenshot = resolve(
      artifactDir,
      `account-${scenario.name}-failure.png`,
    );
    await page
      .screenshot({ path: screenshot, fullPage: true })
      .catch(() => undefined);
    throw new Error(
      `${scenario.name} account security journey failed. Screenshot: ${screenshot}\n${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
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
  await expectText(page, "Completed");
  await clickSessionAction(page, scenario, "Resume session");
  await expectText(page, `Resume session ${session.id}`);
}

async function assertMarkdownRendering(page, scenario, sessionId) {
  const heading = `Markdown browser ${scenario.name} ${Date.now()}`;
  const longPath = `/workspace/${"nested-directory/".repeat(8)}ChatPanel.test.tsx`;
  const markdown = [
    `# ${heading}`,
    "",
    "- rendered list item",
    `- long inline code \`${longPath}:123\` stays inside the message bubble`,
    `- long file link [deep file](${longPath}:456) remains contained`,
    "",
    "```ts",
    "const rendered = true;",
    `const veryLongPath = "${longPath}/${"segment-".repeat(18)}final.ts";`,
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
    await selectProjectRunnerFromUi(dialog);
    await fillProjectDirectoryFromUi(page, dialog, values);
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
  await selectProjectRunnerFromUi(dialog);
  await fillProjectDirectoryFromUi(page, dialog, values);
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

async function selectProjectRunnerFromUi(dialog) {
  await dialog
    .locator("label.field:visible", { hasText: "Runner" })
    .locator("select")
    .selectOption(runnerId);
}

async function fillProjectDirectoryFromUi(page, dialog, values) {
  await dialog.getByLabel("Directory", { exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose directory" });
  await picker.waitFor();
  await expectTextIn(picker, workspace);

  const directoryName = values.directorySuffix
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (!directoryName) {
    throw new Error(`missing project directory suffix for ${values.directory}`);
  }

  await picker.getByRole("treeitem", { name: directoryName }).click();
  await picker.getByRole("button", { name: "Choose" }).click();
  await picker.waitFor({ state: "hidden" });
  await expectTextIn(dialog, values.directorySuffix);
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
    await waitForNewSessionFormReady(dialog);
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
  await waitForNewSessionFormReady(dialog);
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

async function waitForNewSessionFormReady(dialog) {
  await waitFor(async () => {
    const loading = await dialog
      .locator(".new-session-loading")
      .isVisible()
      .catch(() => false);
    if (loading) {
      return false;
    }
    return dialog
      .locator("label.field:visible", { hasText: "Execution" })
      .locator("select")
      .isVisible()
      .catch(() => false);
  }, "new session form to finish loading");
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
        ? "Chat"
        : tab === "files"
          ? "Files"
          : tab === "git"
            ? "Git"
            : "Approvals";
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

async function replaceEditorContent(page, fileName, value) {
  await waitForFileEditorMode(page, fileName);
  await page
    .locator(".monaco-file-editor")
    .last()
    .click({
      position: { x: 24, y: 24 },
    });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.insertText(value);
}

async function expectSaveButtonDisabled(page) {
  const saveButton = page.getByRole("button", { name: "Save file" });
  await waitFor(
    async () =>
      (await saveButton.count()) > 0 && (await saveButton.isDisabled()),
    "Save file button to be disabled",
  );
}

async function assertNoVisibleButton(page, name) {
  await waitFor(
    async () => {
      const buttons = page.getByRole("button", { name, exact: true });
      const count = await buttons.count();
      for (let index = 0; index < count; index += 1) {
        if (
          await buttons
            .nth(index)
            .isVisible()
            .catch(() => false)
        ) {
          return false;
        }
      }
      return true;
    },
    `button ${JSON.stringify(name)} to be hidden`,
  );
}

async function ensureRunnerOnline() {
  const existing = await requestJson("/v1/runners");
  const requested = existing.runners?.find(
    (runner) => runner.runnerId === runnerId,
  );
  if (requested !== undefined) {
    return requested;
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
      runnerToken,
      "--runner-id",
      runnerId,
      "--workspace",
      workspace,
      "--profile",
      "trusted",
    ],
    {
      ROAM_RUNNER_SERVER: wsUrl.toString(),
      ROAM_RUNNER_TOKEN: runnerToken,
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

async function prepareProjectDirectory(projectDir, values) {
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, values.fileName),
    `${values.initialValue}\n`,
    "utf8",
  );
  await writeFile(
    resolve(projectDir, values.markdownFileName),
    values.markdownValue,
    "utf8",
  );
  await writeFile(
    resolve(projectDir, values.imageFileName),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await runCommand("git", ["init"], { cwd: projectDir });
  await runCommand("git", ["config", "user.email", "blackbox@example.test"], {
    cwd: projectDir,
  });
  await runCommand("git", ["config", "user.name", "RoamCli Blackbox"], {
    cwd: projectDir,
  });
  await runCommand(
    "git",
    ["add", values.fileName, values.markdownFileName, values.imageFileName],
    {
      cwd: projectDir,
    },
  );
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

async function assertNoVisibleText(page, text) {
  await waitFor(
    async () => !(await hasVisibleText(page, text)),
    `visible text ${JSON.stringify(text)} to be hidden`,
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
  await assertNoLayoutOverflow(page, scenario, label);
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

async function assertNoLayoutOverflow(page, scenario, label) {
  const metrics = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    );
    const criticalSelectors = [
      ".app-shell",
      ".app-grid",
      ".chat-column",
      ".message-list",
      ".composer",
      ".bottom-tabs",
      ".tablet-tabs",
      ".left-column",
      ".workspace-column",
    ];
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const serialize = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        selector:
          element.className && typeof element.className === "string"
            ? `.${element.className.trim().replace(/\s+/g, ".")}`
            : element.tagName.toLowerCase(),
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
      };
    };
    const critical = criticalSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .map(serialize),
    );
    const criticalOverflow = critical.filter(
      (entry) =>
        entry.left < -1 ||
        entry.right > viewportWidth + 1 ||
        entry.width > viewportWidth + 1,
    );
    const messageOverflow = Array.from(
      document.querySelectorAll(".message-list *"),
    )
      .filter(isVisible)
      .map(serialize)
      .filter((entry) => entry.left < -1 || entry.right > viewportWidth + 1)
      .slice(0, 8);

    return {
      viewportWidth,
      documentWidth,
      criticalOverflow,
      messageOverflow,
    };
  });

  if (metrics.documentWidth > metrics.viewportWidth + 1) {
    throw new Error(
      `${scenario.name}/${label} document overflow: ${JSON.stringify(metrics)}`,
    );
  }
  if (
    metrics.criticalOverflow.length > 0 ||
    metrics.messageOverflow.length > 0
  ) {
    throw new Error(
      `${scenario.name}/${label} visible layout overflow: ${JSON.stringify(
        metrics,
      )}`,
    );
  }
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
