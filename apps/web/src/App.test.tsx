// @vitest-environment jsdom
import "./test/setup.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const runner = {
  runnerId: "real-runner",
  displayName: "Real Runner",
  hostname: "devbox.local",
  workspaceRoot: "/workspace",
  profile: "trusted",
  publicKey: "0123456789abcdef",
  capabilities: [
    {
      kind: "codex",
      label: "Codex",
      command: "codex",
      args: [],
      parser: "codex-json",
      supportsResume: true,
      pluginName: "@roamcli/agent-codex",
      pluginVersion: "1.1.0",
    },
  ],
  version: "0.1.0",
};

const backupRunner = {
  ...runner,
  runnerId: "backup-runner",
  displayName: "Backup Runner",
  hostname: "backup.local",
};

const project = {
  id: "project-1",
  name: "Real Project",
  runnerId: "real-runner",
  directory: "/workspace",
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
  lastActiveAt: "2026-06-05T00:00:00.000Z",
};

const backupProject = {
  ...project,
  id: "project-backup",
  name: "Backup Project",
  runnerId: "backup-runner",
};

const session = {
  id: "session-1",
  title: "Real session",
  projectId: "project-1",
  runnerId: "real-runner",
  agent: "codex",
  status: "running",
  executionMode: "direct",
  executionFolder: "/workspace",
  cwd: "/workspace",
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
};

const patchArtifact = {
  id: "artifact-1",
  sessionId: "session-1",
  kind: "patch",
  name: "changes.patch",
  mimeType: "text/x-diff",
  size: 128,
  sha256: "0123456789abcdef0123456789abcdef",
  storagePath: "artifacts/session-1/changes.patch",
  createdAt: "2026-06-05T00:00:00.000Z",
};

const patchHunk = {
  id: "hunk-1",
  filePath: "src/App.tsx",
  header: "@@ -1 +1 @@",
  lines: ["-old", "+new"],
  status: "pending",
} as const;

const secondPatchHunk = {
  id: "hunk-2",
  filePath: "src/Other.tsx",
  header: "@@ -2 +2 @@",
  lines: ["-before", "+after"],
  status: "pending",
} as const;

const patchApproval = {
  id: "approval-1",
  sessionId: "session-1",
  runnerId: "real-runner",
  kind: "applyPatch",
  summary: "Apply generated patch",
  payload: { hunks: [patchHunk] },
  status: "pending",
  requestedAt: "2026-06-05T00:00:00.000Z",
} as const;

let sockets: TestWebSocket[];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class TestWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = TestWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(readonly url: URL) {
    super();
    sockets.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.dispatchEvent(new Event("close"));
  }

  dispatchEvent(event: Event) {
    if (event.type === "open") {
      this.readyState = TestWebSocket.OPEN;
    }
    if (event.type === "close") {
      this.readyState = TestWebSocket.CLOSED;
    }
    return super.dispatchEvent(event);
  }
}

describe("App", () => {
  let fetchRequests: string[];
  let fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  let deferredFileContent: Map<string, Deferred<Response>>;
  let failNextProjectCreate: boolean;
  let failNextSessionCreate: boolean;

  beforeEach(() => {
    fetchRequests = [];
    fetchCalls = [];
    deferredFileContent = new Map();
    failNextProjectCreate = false;
    failNextSessionCreate = false;
    sockets = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchRequests.push(url);
        fetchCalls.push({ url, init });
        const requestUrl = new URL(url);
        if (requestUrl.pathname === "/v1/runners") {
          return jsonResponse({ runners: [runner] });
        }
        if (requestUrl.pathname === "/v1/projects" && init?.method === "POST") {
          if (failNextProjectCreate) {
            failNextProjectCreate = false;
            return jsonResponse({ error: "project_already_exists" }, 409);
          }
          return jsonResponse({
            project: {
              ...project,
              id: "project-created",
              name: "Created Project",
              directory: "/workspace/created",
            },
          });
        }
        if (requestUrl.pathname === "/v1/projects") {
          return jsonResponse({ projects: [project] });
        }
        if (requestUrl.pathname === "/v1/projects/project-1/archive") {
          return jsonResponse({
            project: {
              ...project,
              archivedAt: "2026-06-05T01:00:00.000Z",
              updatedAt: "2026-06-05T01:00:00.000Z",
            },
          });
        }
        if (requestUrl.pathname === "/v1/sessions" && init?.method === "POST") {
          if (failNextSessionCreate) {
            failNextSessionCreate = false;
            return jsonResponse({ error: "session_create_failed" }, 500);
          }
          return jsonResponse({
            session: {
              ...session,
              id: "session-created",
              title: "Created session",
              status: "pending",
            },
          });
        }
        if (requestUrl.pathname === "/v1/sessions") {
          return jsonResponse({ sessions: [session] });
        }
        if (requestUrl.pathname === "/v1/sessions/session-1") {
          if (init?.method === "DELETE") {
            return new Response(null, { status: 204 });
          }
          return jsonResponse({
            session,
            messages: [
              {
                id: "message-1",
                sessionId: "session-1",
                role: "assistant",
                content: "Loaded from API",
                encrypted: false,
                createdAt: "2026-06-05T00:00:00.000Z",
              },
            ],
            approvals: [patchApproval],
            artifacts: [patchArtifact],
          });
        }
        if (requestUrl.pathname === "/v1/sessions/session-1/files") {
          return jsonResponse({
            root: {
              path: ".",
              name: "workspace",
              type: "directory",
              children: [
                {
                  path: "src",
                  name: "src",
                  type: "directory",
                  children: [
                    {
                      path: "src/App.tsx",
                      name: "App.tsx",
                      type: "file",
                      size: 42,
                    },
                    {
                      path: "src/Slow.tsx",
                      name: "Slow.tsx",
                      type: "file",
                      size: 12,
                    },
                    {
                      path: "src/Fast.tsx",
                      name: "Fast.tsx",
                      type: "file",
                      size: 12,
                    },
                  ],
                },
              ],
            },
          });
        }
        if (requestUrl.pathname === "/v1/sessions/session-1/files/content") {
          const requestedPath = requestUrl.searchParams.get("path") ?? "";
          const deferredResponse = deferredFileContent.get(requestedPath);
          if (deferredResponse) {
            return deferredResponse.promise;
          }
          if (init?.method === "PUT") {
            return jsonResponse({
              result: {
                requestId: "file-write-1",
                sessionId: "session-1",
                path: "src/App.tsx",
                bytesWritten: 48,
                encoding: "utf8",
              },
            });
          }
          return jsonResponse({
            result: {
              requestId: "file-content-1",
              sessionId: "session-1",
              path: requestedPath,
              content:
                requestedPath === "src/App.tsx"
                  ? "export function RealContent() { return null; }"
                  : `export const file = ${JSON.stringify(requestedPath)};`,
              truncated: false,
              encoding: "utf8",
            },
          });
        }
        if (requestUrl.pathname === "/v1/sessions/session-1/patches/apply") {
          return jsonResponse({
            result: {
              requestId: "patch-apply-1",
              sessionId: "session-1",
              applied: true,
              changedFiles: ["src/App.tsx"],
              message: "applied",
              rejected: [],
            },
          });
        }
        return jsonResponse({ error: "not found" }, 404);
      }),
    );
  });

  it("renders real remote state from the API", async () => {
    render(<App />);

    expect(await screen.findAllByText("Real Project")).toHaveLength(2);
    expect(screen.getByTitle("Real Runner runner")).toBeInTheDocument();
    expect(screen.getAllByText("Real session").length).toBeGreaterThan(0);
    expect(screen.getByText("Loaded from API")).toBeInTheDocument();
    expect(screen.getAllByText("执行中").length).toBeGreaterThan(0);
    expect(screen.getByText("changes.patch")).toBeInTheDocument();
    expect(
      screen.getByText(/artifacts\/session-1\/changes.patch/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Mobile tabs" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Projects and sessions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Conversation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    ).toBeInTheDocument();
  });

  it("does not describe disconnected stream commands as an unreachable server", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    fireEvent.change(screen.getByRole("textbox", { name: "Chat composer" }), {
      target: { value: "hello while disconnected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("Event stream is disconnected"),
    ).toBeInTheDocument();
    expect(within(alert).getByText(/Message was not sent/)).toBeInTheDocument();
    expect(
      within(alert).queryByText(/pnpm --filter @roamcli\/server dev/),
    ).not.toBeInTheDocument();
  });

  it("renders agent messages as markdown while keeping user messages literal", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "message:created",
            message: {
              id: "message-agent-markdown",
              sessionId: "session-1",
              role: "assistant",
              content: [
                "# Agent result",
                "",
                "- markdown item",
                "",
                "```ts",
                "const answer = 42;",
                "```",
                "",
                "<div>raw html stays text</div>",
              ].join("\n"),
              encrypted: false,
              createdAt: new Date(Date.now() + 1000).toISOString(),
            },
          }),
        }),
      );
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "message:created",
            message: {
              id: "message-user-literal",
              sessionId: "session-1",
              role: "user",
              content: "**literal user markdown**",
              encrypted: false,
              createdAt: new Date(Date.now() + 2000).toISOString(),
            },
          }),
        }),
      );
    });

    const conversation = screen.getByRole("region", { name: "Conversation" });
    expect(
      await within(conversation).findByRole("heading", {
        name: "Agent result",
      }),
    ).toBeInTheDocument();
    expect(within(conversation).getByText("markdown item")).toBeInTheDocument();
    expect(
      within(conversation).getByRole("button", { name: "Copy ts code" }),
    ).toBeInTheDocument();
    expect(
      within(conversation).getByText("<div>raw html stays text</div>"),
    ).toBeInTheDocument();
    const userArticle = within(conversation)
      .getByText("**literal user markdown**")
      .closest("article");
    expect(userArticle?.querySelector("strong")).toBeNull();
  });

  it("exposes mobile parity tabs when real state is loaded", async () => {
    render(<App />);
    await screen.findAllByText("Real Project");
    const mobileTabs = within(
      screen.getByRole("navigation", { name: "Mobile tabs" }),
    );

    expect(
      mobileTabs.getByRole("button", { name: "对话" }),
    ).toBeInTheDocument();
    expect(
      mobileTabs.getByRole("button", { name: "文件" }),
    ).toBeInTheDocument();
    expect(
      mobileTabs.getByRole("button", { name: "终端" }),
    ).toBeInTheDocument();
    expect(
      mobileTabs.getByRole("button", { name: "审批" }),
    ).toBeInTheDocument();
  });

  it("uses a collapsed project tree with modal create actions", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");
    const sidebar = within(
      screen.getByRole("complementary", { name: "Projects and sessions" }),
    );

    expect(
      sidebar.queryByRole("group", { name: "Real Project sessions" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      sidebar.getByRole("button", { name: "Expand project Real Project" }),
    );
    expect(
      sidebar.getByRole("group", { name: "Real Project sessions" }),
    ).toBeInTheDocument();
    fireEvent.click(
      sidebar.getByRole("button", { name: "Collapse project Real Project" }),
    );
    expect(
      sidebar.queryByRole("group", { name: "Real Project sessions" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      sidebar.getByRole("button", { name: "New session in Real Project" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "New Session - Real Project",
    });
    expect(within(dialog).getByDisplayValue("/workspace")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Prompt"), {
      target: { value: "Run the focused task" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create session" }));

    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (
            !call.url.endsWith("/v1/sessions") ||
            call.init?.method !== "POST"
          ) {
            return false;
          }
          return JSON.parse(String(call.init.body)).projectId === "project-1";
        }),
      ).toBe(true),
    );
    expect(
      sidebar.getByRole("group", { name: "Real Project sessions" }),
    ).toBeInTheDocument();
  });

  it("shows inline validation for empty modal submissions", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");
    const sidebar = within(
      screen.getByRole("complementary", { name: "Projects and sessions" }),
    );

    fireEvent.click(
      sidebar.getByRole("button", { name: "New session in Real Project" }),
    );
    const sessionDialog = screen.getByRole("dialog", {
      name: "New Session - Real Project",
    });
    fireEvent.click(
      within(sessionDialog).getByRole("button", { name: "Create session" }),
    );
    expect(
      within(sessionDialog).getByRole("alert"),
    ).toHaveTextContent("Prompt is required.");
    expect(
      fetchCalls.some(
        (call) =>
          call.url.endsWith("/v1/sessions") && call.init?.method === "POST",
      ),
    ).toBe(false);
    fireEvent.click(
      within(sessionDialog).getByRole("button", { name: "Close modal" }),
    );

    fireEvent.click(sidebar.getByRole("button", { name: "New project" }));
    const projectDialog = screen.getByRole("dialog", { name: "New Project" });
    fireEvent.change(within(projectDialog).getByLabelText("Directory"), {
      target: { value: "" },
    });
    fireEvent.click(
      within(projectDialog).getByRole("button", { name: "Create project" }),
    );
    expect(
      within(projectDialog).getByRole("alert"),
    ).toHaveTextContent("Directory is required.");
    expect(
      fetchCalls.some(
        (call) =>
          call.url.endsWith("/v1/projects") && call.init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("keeps the new session modal open with form context when creation fails", async () => {
    failNextSessionCreate = true;
    render(<App />);
    await screen.findByText("Loaded from API");
    const sidebar = within(
      screen.getByRole("complementary", { name: "Projects and sessions" }),
    );

    fireEvent.click(
      sidebar.getByRole("button", { name: "New session in Real Project" }),
    );
    const sessionDialog = screen.getByRole("dialog", {
      name: "New Session - Real Project",
    });
    fireEvent.change(within(sessionDialog).getByLabelText("Title"), {
      target: { value: "Keep this title" },
    });
    fireEvent.change(within(sessionDialog).getByLabelText("Prompt"), {
      target: { value: "Keep this prompt after failure" },
    });
    fireEvent.click(
      within(sessionDialog).getByRole("button", { name: "Create session" }),
    );

    expect(
      await within(sessionDialog).findByText(/session_create_failed/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "New Session - Real Project" }),
    ).toBeInTheDocument();
    expect(within(sessionDialog).getByLabelText("Title")).toHaveValue(
      "Keep this title",
    );
    expect(within(sessionDialog).getByLabelText("Prompt")).toHaveValue(
      "Keep this prompt after failure",
    );
  });

  it("keeps the new project modal open with form context when creation fails", async () => {
    failNextProjectCreate = true;
    render(<App />);
    await screen.findByText("Loaded from API");
    const sidebar = within(
      screen.getByRole("complementary", { name: "Projects and sessions" }),
    );

    fireEvent.click(sidebar.getByRole("button", { name: "New project" }));
    const projectDialog = screen.getByRole("dialog", { name: "New Project" });
    fireEvent.change(within(projectDialog).getByLabelText("Name"), {
      target: { value: "Duplicate Project" },
    });
    fireEvent.change(within(projectDialog).getByLabelText("Directory"), {
      target: { value: "/workspace" },
    });
    fireEvent.click(
      within(projectDialog).getByRole("button", { name: "Create project" }),
    );

    expect(
      await within(projectDialog).findByText(/project_already_exists/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "New Project" }),
    ).toBeInTheDocument();
    expect(within(projectDialog).getByLabelText("Name")).toHaveValue(
      "Duplicate Project",
    );
    expect(within(projectDialog).getByLabelText("Directory")).toHaveValue(
      "/workspace",
    );
  });

  it("archives the selected project and leaves the workspace in an empty state", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");
    const sidebar = within(
      screen.getByRole("complementary", { name: "Projects and sessions" }),
    );

    fireEvent.click(
      sidebar.getByRole("button", { name: "Archive project Real Project" }),
    );

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) =>
            call.url.endsWith("/v1/projects/project-1/archive") &&
            call.init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(window.confirm).toHaveBeenCalledWith(
      'Archive project "Real Project"? Sessions stay recoverable and project files are not deleted.',
    );
    expect(
      screen.getAllByText("Create a project to start a session.").length,
    ).toBeGreaterThan(0);
  });

  it("supports mobile modal create actions and selected project archive", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");
    const mobileControls = within(
      screen.getByRole("region", { name: "Mobile project controls" }),
    );

    fireEvent.click(
      mobileControls.getByRole("button", {
        name: "New session in selected project Real Project",
      }),
    );
    const sessionDialog = screen.getByRole("dialog", {
      name: "New Session - Real Project",
    });
    fireEvent.change(within(sessionDialog).getByLabelText("Prompt"), {
      target: { value: "Run from the mobile controls" },
    });
    fireEvent.click(
      within(sessionDialog).getByRole("button", { name: "Create session" }),
    );
    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (
            !call.url.endsWith("/v1/sessions") ||
            call.init?.method !== "POST"
          ) {
            return false;
          }
          return JSON.parse(String(call.init.body)).projectId === "project-1";
        }),
      ).toBe(true),
    );

    fireEvent.click(
      mobileControls.getByRole("button", {
        name: "Archive selected project Real Project",
      }),
    );
    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) =>
            call.url.endsWith("/v1/projects/project-1/archive") &&
            call.init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(screen.getByLabelText("Project")).toHaveValue("");

    fireEvent.click(mobileControls.getByRole("button", { name: "New project" }));
    const projectDialog = screen.getByRole("dialog", { name: "New Project" });
    fireEvent.change(within(projectDialog).getByLabelText("Name"), {
      target: { value: "Mobile Project" },
    });
    fireEvent.change(within(projectDialog).getByLabelText("Directory"), {
      target: { value: "/workspace/mobile" },
    });
    fireEvent.click(
      within(projectDialog).getByRole("button", { name: "Create project" }),
    );

    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (
            !call.url.endsWith("/v1/projects") ||
            call.init?.method !== "POST"
          ) {
            return false;
          }
          const body = JSON.parse(String(call.init.body));
          return body.name === "Mobile Project" && body.directory === "/workspace/mobile";
        }),
      ).toBe(true),
    );
  });

  it("keeps the mobile project select visibly empty after archiving the selected project", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "runner:online", runner: backupRunner }),
        }),
      );
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "project:created",
            project: backupProject,
          }),
        }),
      );
    });

    const mobileControls = within(
      screen.getByRole("region", { name: "Mobile project controls" }),
    );
    expect(mobileControls.getByLabelText("Project")).toHaveValue("project-1");

    fireEvent.click(
      mobileControls.getByRole("button", {
        name: "Archive selected project Real Project",
      }),
    );

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) =>
            call.url.endsWith("/v1/projects/project-1/archive") &&
            call.init?.method === "POST",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(mobileControls.getByLabelText("Project")).toHaveValue(""),
    );
    expect(mobileControls.getByLabelText("Project")).toHaveDisplayValue(
      "No project selected",
    );
    expect(
      mobileControls.queryByRole("button", {
        name: /New session in selected project/,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Create a project to start a session.").length,
    ).toBeGreaterThan(0);
  });

  it("closes the mobile new session modal when project selection changes", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "runner:online", runner: backupRunner }),
        }),
      );
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "project:created",
            project: backupProject,
          }),
        }),
      );
    });

    const mobileControls = within(
      screen.getByRole("region", { name: "Mobile project controls" }),
    );
    fireEvent.click(
      mobileControls.getByRole("button", {
        name: "New session in selected project Real Project",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "New Session - Real Project" }),
    ).toBeInTheDocument();

    fireEvent.change(mobileControls.getByLabelText("Project"), {
      target: { value: "project-backup" },
    });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /New Session/ })).not.toBeInTheDocument(),
    );
    expect(
      mobileControls.getByRole("button", {
        name: "New session in selected project Backup Project",
      }),
    ).toBeInTheDocument();
  });

  it("loads the selected session file tree and displays real file content", async () => {
    render(<App />);

    const fileButton = await screen.findByRole("treeitem", {
      name: /App\.tsx/,
    });
    expect(
      fetchRequests.some((url) =>
        url.includes("/v1/sessions/session-1/files?path=.&depth=3"),
      ),
    ).toBe(true);

    fireEvent.click(fileButton);

    const editor = await screen.findByRole("textbox", {
      name: "Edit src/App.tsx",
    });
    expect(editor).toHaveValue(
      "export function RealContent() { return null; }",
    );
    expect(screen.getByText("Editable")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save file" })).toBeDisabled();
    const contentUrl = fetchRequests.find((url) =>
      url.includes("/v1/sessions/session-1/files/content"),
    );
    expect(contentUrl).toBeDefined();
    expect(new URL(contentUrl ?? "").searchParams.get("path")).toBe(
      "src/App.tsx",
    );
  });

  it("keeps the currently selected file when an older file response finishes later", async () => {
    const slowContent = deferred<Response>();
    const fastContent = deferred<Response>();
    deferredFileContent.set("src/Slow.tsx", slowContent);
    deferredFileContent.set("src/Fast.tsx", fastContent);
    render(<App />);

    fireEvent.click(await screen.findByRole("treeitem", { name: /Slow\.tsx/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /Fast\.tsx/ }));

    fastContent.resolve(
      jsonResponse({
        result: {
          requestId: "fast-content",
          sessionId: "session-1",
          path: "src/Fast.tsx",
          content: "export const fast = true;",
          truncated: false,
          encoding: "utf8",
        },
      }),
    );
    const editor = await screen.findByRole("textbox", {
      name: "Edit src/Fast.tsx",
    });
    expect(editor).toHaveValue("export const fast = true;");

    slowContent.resolve(
      jsonResponse({
        result: {
          requestId: "slow-content",
          sessionId: "session-1",
          path: "src/Slow.tsx",
          content: "export const slow = true;",
          truncated: false,
          encoding: "utf8",
        },
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Edit src/Fast.tsx" }),
      ).toHaveValue("export const fast = true;"),
    );
  });

  it("edits and saves real file content through the API", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("treeitem", { name: /App\.tsx/ }));
    const editor = await screen.findByRole("textbox", {
      name: "Edit src/App.tsx",
    });
    fireEvent.change(editor, {
      target: { value: "export const saved = true;\n" },
    });

    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const saveCall = fetchCalls.find(
      (call) =>
        call.url.includes("/v1/sessions/session-1/files/content") &&
        call.init?.method === "PUT",
    );
    expect(saveCall).toBeDefined();
    expect(JSON.parse(String(saveCall?.init?.body))).toEqual({
      path: "src/App.tsx",
      content: "export const saved = true;\n",
      encoding: "utf8",
    });
  });

  it("calls patch hunk and apply APIs from PatchReview actions", async () => {
    render(<App />);
    await screen.findByText("Apply generated patch");

    const patchCard = screen.getByText("src/App.tsx").closest("article");
    expect(patchCard).not.toBeNull();
    fireEvent.click(
      within(patchCard as HTMLElement).getByRole("button", {
        name: "Accept patch hunk hunk-1",
      }),
    );

    await waitFor(() =>
      expect(screen.getByText("accepted")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(screen.getByText("edited")).toBeInTheDocument());
    const applyCall = fetchCalls.find((call) =>
      call.url.includes("/v1/sessions/session-1/patches/apply"),
    );
    expect(applyCall?.init?.method).toBe("POST");
    const body = JSON.parse(String(applyCall?.init?.body)) as {
      patch: string;
      signedAt: string;
      signature: string;
    };
    expect(body.patch).toContain("diff --git a/src/App.tsx b/src/App.tsx");
    expect(body.patch).toContain("@@ -1 +1 @@");
    expect(body.signedAt).toMatch(/2026|20/);
    expect(body.signature.length).toBeGreaterThan(16);
  });

  it("keeps streamed approval hunks in payload order", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "approval:requested",
            approval: {
              ...patchApproval,
              id: "approval-stream",
              payload: {
                hunks: [
                  { ...patchHunk, id: "hunk-a" },
                  { ...secondPatchHunk, id: "hunk-b" },
                ],
              },
            },
          }),
        }),
      );
    });

    await screen.findByRole("button", { name: "Accept patch hunk hunk-b" });
    const hunkActions = screen
      .getAllByRole("button", { name: /Accept patch hunk/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(hunkActions).toEqual([
      "Accept patch hunk hunk-1",
      "Accept patch hunk hunk-a",
      "Accept patch hunk hunk-b",
    ]);
  });

  it("renders terminal:data stream output and sends terminal input to the selected session", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(new Event("open"));
    });
    expect(await screen.findByText("stream connected")).toBeInTheDocument();

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "terminal:data",
            sessionId: "session-1",
            chunk: "runner$ pnpm test",
          }),
        }),
      );
    });
    expect(await screen.findByText("runner$ pnpm test")).toBeInTheDocument();

    fireEvent.change(
      screen.getByPlaceholderText("Send input to active session"),
      { target: { value: "ls -la" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Send terminal input" }),
    );

    expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}")).toMatchObject({
      type: "userMessage",
      sessionId: "session-1",
      content: "ls -la",
    });
  });

  it("keeps the selected project stable when its runner goes offline", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "runner:online", runner: backupRunner }),
        }),
      );
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "project:created",
            project: backupProject,
          }),
        }),
      );
    });

    const mobileControls = within(
      screen.getByRole("region", { name: "Mobile project controls" }),
    );
    fireEvent.change(mobileControls.getByLabelText("Project"), {
      target: { value: "project-backup" },
    });
    expect(mobileControls.getByLabelText("Project")).toHaveValue(
      "project-backup",
    );

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "runner:offline",
            runnerId: "backup-runner",
          }),
        }),
      );
    });

    expect(mobileControls.getByLabelText("Project")).toHaveValue(
      "project-backup",
    );
  });

  it("renders interleaved user and streamed assistant turns in chronological order", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    const firstUserAt = new Date(Date.now() + 1000).toISOString();
    const secondUserAt = new Date(Date.now() + 2000).toISOString();

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "message:created",
            message: {
              id: "message-user-1",
              sessionId: "session-1",
              role: "user",
              content: "first question",
              encrypted: false,
              createdAt: firstUserAt,
            },
          }),
        }),
      );
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "token",
            sessionId: "session-1",
            content: "first answer",
            encrypted: false,
          }),
        }),
      );
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "message:created",
            message: {
              id: "message-user-2",
              sessionId: "session-1",
              role: "user",
              content: "second question",
              encrypted: false,
              createdAt: secondUserAt,
            },
          }),
        }),
      );
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "token",
            sessionId: "session-1",
            content: "second answer",
            encrypted: false,
          }),
        }),
      );
    });

    const conversation = screen.getByRole("region", { name: "Conversation" });
    await waitFor(() =>
      expect(
        within(conversation).getByText("second answer"),
      ).toBeInTheDocument(),
    );
    const visibleMessages = [
      ...conversation.querySelectorAll(".message-body p"),
    ].map((item) => item.textContent);
    expect(visibleMessages.slice(-4)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ]);
  });

  it("renders streamed assistant token previews as markdown", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "token",
            sessionId: "session-1",
            content: "**draft preview**",
            encrypted: false,
          }),
        }),
      );
    });

    const conversation = screen.getByRole("region", { name: "Conversation" });
    const preview = await within(conversation).findByText("draft preview");
    expect(preview.tagName.toLowerCase()).toBe("strong");
  });

  it("sends terminal control signals for interrupt and stop", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(new Event("open"));
    });

    const terminal = within(screen.getByRole("region", { name: "Terminal" }));
    fireEvent.click(
      terminal.getByRole("button", { name: "Interrupt session" }),
    );
    expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}")).toMatchObject({
      type: "controlSignal",
      sessionId: "session-1",
      signal: "interrupt",
    });

    fireEvent.click(terminal.getByRole("button", { name: "Stop session" }));
    expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}")).toMatchObject({
      type: "controlSignal",
      sessionId: "session-1",
      signal: "stop",
    });
  });

  it("deletes the selected session through the API and removes local session state", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));

    await waitFor(() =>
      expect(screen.queryByText("Real session")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("Create a session in the selected project."),
    ).toBeInTheDocument();
    const deleteCall = fetchCalls.find(
      (call) =>
        call.url.endsWith("/v1/sessions/session-1") &&
        call.init?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    expect(window.confirm).toHaveBeenCalledWith(
      'Delete session "Real session"?',
    );
  });

  it("does not import mock data into the runtime app", () => {
    const rootPath = resolve(process.cwd(), "apps/web/src/App.tsx");
    const packagePath = resolve(process.cwd(), "src/App.tsx");
    const appSource = readFileSync(
      existsSync(rootPath) ? rootPath : packagePath,
      "utf8",
    );
    expect(appSource).not.toContain("mockData");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
