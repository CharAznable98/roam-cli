#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "../apps/server/dist/app.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const password = "roamcli-pin-show-more-password";
const runStartedAt = new Date();
const artifactDir = resolve(
  repoRoot,
  "artifacts",
  "pin-show-more-browser",
  runStartedAt.toISOString().replace(/[:.]/g, "-"),
);
const viewportCases = {
  desktop: { width: 1440, height: 960 },
  mobile: { width: 390, height: 844 },
};
const rows = [];
const browserErrors = [];
let app;
let baseUrl;
let sessionCookie;
let dataDir;
let workspaceDir;

try {
  await run();
  await writeReport("passed");
  console.log("[pass] pin/show-more browser verification completed");
  console.log(`[pass] report: ${resolve(artifactDir, "report.md")}`);
} catch (error) {
  await writeReport("failed", error).catch(() => undefined);
  console.error("[fail] pin/show-more browser verification failed");
  console.error(`[fail] report: ${resolve(artifactDir, "report.md")}`);
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function run() {
  await mkdir(artifactDir, { recursive: true });
  dataDir = await mkdtemp(resolve(tmpdir(), "roamcli-pin-server-"));
  workspaceDir = await mkdtemp(resolve(tmpdir(), "roamcli-pin-workspace-"));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  app = await createServer({
    host: "127.0.0.1",
    port,
    dataDir,
    webDistDir: resolve(repoRoot, "apps/web/dist"),
    resetOwner: true,
  });
  await app.listen({ host: "127.0.0.1", port });
  await setupOwner();
  seedData(app.roam.store);
  pass(`server seeded at ${baseUrl}`);

  const browser = await chromium.launch({
    headless: process.env.ROAMCLI_PIN_SHOW_MORE_HEADFUL !== "1",
  });
  try {
    await runDesktop(browser);
    await runMobile(browser);
  } finally {
    await browser.close();
  }
}

async function setupOwner() {
  const setupToken = await readFile(
    resolve(dataDir, "setup-token.txt"),
    "utf8",
  );
  const response = await fetch(`${baseUrl}/v1/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ setupToken: setupToken.trim(), password }),
  });
  if (!response.ok) {
    throw new Error(
      `owner setup failed: ${response.status} ${await response.text()}`,
    );
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("owner setup did not return a session cookie");
  }
  sessionCookie = setCookie.split(";")[0];
  pass("owner setup completed");
}

function seedData(store) {
  const runnerId = "runner-pin-qa";
  const projectId = "project-alpha-pin";
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  store.createProject({
    id: projectId,
    name: "Alpha Pin QA",
    runnerId,
    directory: resolve(workspaceDir, "alpha"),
    createdAt: iso(-120_000),
    updatedAt: iso(-120_000),
    lastActiveAt: iso(-120_000),
  });
  for (let index = 1; index <= 7; index += 1) {
    store.createSession({
      id: `session-alpha-${index}`,
      title: `QA Session ${index}`,
      projectId,
      runnerId,
      agent: "codex",
      status: "completed",
      executionMode: "direct",
      executionFolder: `session-${index}`,
      cwd: resolve(workspaceDir, "alpha"),
      createdAt: iso(-80_000 + index * 1_000),
      updatedAt: iso(-80_000 + index * 1_000),
    });
  }
  store.createProject({
    id: "project-beta-recent",
    name: "Beta Recent",
    runnerId,
    directory: resolve(workspaceDir, "beta"),
    createdAt: iso(-20_000),
    updatedAt: iso(-20_000),
    lastActiveAt: iso(-20_000),
  });
}

async function runDesktop(browser) {
  const { context, page } = await newPage(browser, viewportCases.desktop);
  try {
    await page.goto(baseUrl);
    await page.getByRole("heading", { name: "Projects" }).waitFor();
    await page
      .getByRole("button", { name: "Expand project Alpha Pin QA" })
      .click();
    const sessionsGroup = page.getByRole("group", {
      name: "Alpha Pin QA sessions",
    });
    await assertRowCount(
      sessionsGroup,
      ".tree-session-row",
      5,
      "desktop default session count",
    );
    await assertVisible(
      sessionsGroup.getByText("QA Session 7"),
      "desktop newest session visible",
    );
    await assertHidden(
      sessionsGroup.getByText("QA Session 2"),
      "desktop hidden sixth session before show more",
    );
    await sessionsGroup.getByRole("button", { name: "查看更多" }).click();
    await assertRowCount(
      sessionsGroup,
      ".tree-session-row",
      7,
      "desktop expanded session count",
    );
    await assertVisible(
      sessionsGroup.getByText("QA Session 2"),
      "desktop hidden session visible after show more",
    );
    await clickSessionButton(
      sessionsGroup,
      ".tree-session-button",
      "QA Session 2",
    );
    await page
      .getByRole("button", { name: "Collapse project Alpha Pin QA" })
      .click();
    await page
      .getByRole("button", { name: "Expand project Alpha Pin QA" })
      .click();
    await assertRowCount(
      sessionsGroup,
      ".tree-session-row",
      7,
      "desktop selected hidden session keeps list expanded",
    );
    await sessionsGroup.getByRole("button", { name: "收起" }).click();
    await assertRowCount(
      sessionsGroup,
      ".tree-session-row",
      5,
      "desktop collapse button restores five sessions",
    );
    await page
      .getByRole("button", { name: "Collapse project Alpha Pin QA" })
      .click();
    await page
      .getByRole("button", { name: "Expand project Alpha Pin QA" })
      .click();
    await assertRowCount(
      sessionsGroup,
      ".tree-session-row",
      7,
      "desktop selected hidden session still visible after project reopen",
    );
    await clickSessionButton(
      sessionsGroup,
      ".tree-session-button",
      "QA Session 7",
    );
    await page
      .getByRole("button", { name: "Collapse project Alpha Pin QA" })
      .click();
    await page
      .getByRole("button", { name: "Expand project Alpha Pin QA" })
      .click();
    await assertRowCount(
      sessionsGroup,
      ".tree-session-row",
      5,
      "desktop project reopen defaults to collapsed when selected session is visible",
    );

    await page
      .getByRole("button", { name: "Pin project Alpha Pin QA" })
      .click();
    await waitForProjectPinned("project-alpha-pin", true);
    const projects = await apiJson("/v1/projects");
    assert(
      projects.projects[0]?.id === "project-alpha-pin",
      "pinned project should sort ahead of a more recent unpinned project",
    );

    for (const title of ["QA Session 7", "QA Session 6", "QA Session 5"]) {
      await page.getByRole("button", { name: `Pin session ${title}` }).click();
    }
    await waitForPinnedSessionCount("project-alpha-pin", 3);
    await waitFor(
      async () => {
        for (const title of ["QA Session 7", "QA Session 6", "QA Session 5"]) {
          if (
            !(await page
              .getByRole("button", { name: `Unpin session ${title}` })
              .isVisible())
          ) {
            return false;
          }
        }
        return true;
      },
      "desktop pinned session buttons reflected in UI",
    );
    await waitFor(
      async () =>
        await page
          .getByRole("button", { name: "Pin session QA Session 4" })
          .isDisabled(),
      "desktop fourth session pin button disabled at limit",
    );
    const limitResponse = await fetch(
      `${baseUrl}/v1/sessions/session-alpha-4`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
          origin: baseUrl,
        },
        body: JSON.stringify({ pinned: true }),
      },
    );
    assert(
      limitResponse.status === 409,
      `session pin limit API should return 409, got ${limitResponse.status}`,
    );
    await page.reload();
    await page.getByRole("heading", { name: "Projects" }).waitFor();
    await page
      .getByRole("button", { name: "Expand project Alpha Pin QA" })
      .click();
    await assertVisible(
      page.getByRole("button", { name: "Unpin project Alpha Pin QA" }),
      "desktop project pin persisted after reload",
    );
    await assertVisible(
      page.getByRole("button", { name: "Unpin session QA Session 5" }),
      "desktop session pin persisted after reload",
    );
    await assertNoHorizontalOverflow(page, "desktop");
    await page.screenshot({
      path: resolve(artifactDir, "desktop-pin-show-more.png"),
      fullPage: true,
    });
    pass("desktop pin/show-more flow");
  } finally {
    await context.close();
  }
}

async function runMobile(browser) {
  const { context, page } = await newPage(browser, viewportCases.mobile);
  try {
    await page.goto(baseUrl);
    const switcher = page.getByRole("button", { name: /Switch Session/ });
    await switcher.waitFor();
    await switcher.click();
    const dialog = page.getByRole("dialog", { name: "Switch Session" });
    await dialog.waitFor();
    await assertRowCount(
      dialog,
      ".mobile-session-button",
      5,
      "mobile default session count",
    );
    await assertHidden(
      dialog.getByText("QA Session 2"),
      "mobile hidden sixth session before show more",
    );
    await clickSessionButton(dialog, ".mobile-session-button", "QA Session 4");
    await page
      .getByRole("button", { name: "Switch Session: QA Session 4" })
      .click();
    await dialog.waitFor();
    await waitFor(
      async () =>
        await dialog
          .getByRole("button", { name: "Pin selected session QA Session 4" })
          .isDisabled(),
      "mobile selected session pin button disabled at limit",
    );
    await dialog.getByRole("button", { name: "查看更多" }).click();
    await assertRowCount(
      dialog,
      ".mobile-session-button",
      7,
      "mobile expanded session count",
    );
    await assertVisible(
      dialog.getByText("QA Session 2"),
      "mobile hidden session visible after show more",
    );
    await clickSessionButton(dialog, ".mobile-session-button", "QA Session 2");
    await page.getByRole("button", { name: /Switch Session/ }).click();
    await assertRowCount(
      dialog,
      ".mobile-session-button",
      7,
      "mobile selected hidden session keeps sheet expanded",
    );
    await clickSessionButton(dialog, ".mobile-session-button", "QA Session 5");
    await page.getByRole("button", { name: /Switch Session/ }).click();
    await assertRowCount(
      dialog,
      ".mobile-session-button",
      5,
      "mobile sheet reopen defaults to collapsed when selected session is visible",
    );
    await assertNoHorizontalOverflow(page, "mobile");
    await page.screenshot({
      path: resolve(artifactDir, "mobile-pin-show-more.png"),
      fullPage: true,
    });
    pass("mobile pin/show-more flow");
  } finally {
    await context.close();
  }
}

async function newPage(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const [name, value] = sessionCookie.split("=");
  await context.addCookies([
    {
      name,
      value,
      url: baseUrl,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserErrors.push(error.stack ?? error.message);
  });
  return { context, page };
}

async function apiJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { cookie: sessionCookie },
  });
  if (!response.ok) {
    throw new Error(
      `${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

async function waitForProjectPinned(projectId, expectedPinned) {
  await waitFor(async () => {
    const { projects } = await apiJson("/v1/projects");
    return (
      Boolean(
        projects.find((project) => project.id === projectId)?.pinnedAt,
      ) === expectedPinned
    );
  }, `project ${projectId} pinned=${expectedPinned}`);
}

async function waitForPinnedSessionCount(projectId, expectedCount) {
  await waitFor(async () => {
    const { sessions } = await apiJson("/v1/sessions");
    return (
      sessions.filter(
        (session) => session.projectId === projectId && session.pinnedAt,
      ).length === expectedCount
    );
  }, `project ${projectId} pinned session count ${expectedCount}`);
}

async function assertRowCount(scope, selector, expected, label) {
  await waitFor(
    async () => (await scope.locator(selector).count()) === expected,
    label,
  );
}

async function clickSessionButton(scope, selector, title) {
  await scope.locator(selector).filter({ hasText: title }).first().click();
}

async function assertVisible(locator, label) {
  await waitFor(async () => await locator.first().isVisible(), label);
}

async function assertHidden(locator, label) {
  await waitFor(
    async () =>
      (await locator.count()) === 0 || !(await locator.first().isVisible()),
    label,
  );
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(0, root.scrollWidth - window.innerWidth);
  });
  assert(
    overflow <= 1,
    `${label} should not horizontally overflow, got ${overflow}px`,
  );
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function pass(message) {
  rows.push(`- PASS: ${message}`);
  console.log(`[pass] ${message}`);
}

async function writeReport(status, error) {
  const lines = [
    `# Pin / Show More Browser Verification`,
    "",
    `Status: ${status}`,
    `Started: ${runStartedAt.toISOString()}`,
    "",
    "## Checks",
    ...rows,
  ];
  if (browserErrors.length > 0) {
    lines.push(
      "",
      "## Browser Errors",
      ...browserErrors.map((item) => `- ${item}`),
    );
  }
  if (error) {
    lines.push(
      "",
      "## Failure",
      "```",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      "```",
    );
  }
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "report.md"), `${lines.join("\n")}\n`);
}

async function cleanup() {
  if (app) {
    await app.close().catch(() => undefined);
  }
  for (const dir of [dataDir, workspaceDir]) {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          rejectPromise(new Error("unable to allocate port"));
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}
