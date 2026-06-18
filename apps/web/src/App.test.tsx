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

function openSessionSwitcher(name: RegExp = /Real session|Created session/) {
  fireEvent.click(
    screen.queryByRole("button", { name: /Switch Session:/ }) ??
      screen.queryByRole("button", { name: "Switch Session" }) ??
      screen.getByRole("button", { name }),
  );
  return within(screen.getByRole("dialog", { name: "Switch Session" }));
}

describe("App", () => {
  let fetchRequests: string[];
  let fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  let deferredFileContent: Map<string, Deferred<Response>>;
  let failNextProjectCreate: boolean;
  let failNextSessionCreate: boolean;
  let failNextSessionRename: boolean;
  let remoteSessionTitle: string;
  let remoteSessionStatus: string;
  let remoteSessionExecutionMode: "direct" | "managed_worktree";
  let remoteSessionExecutionFolder: string;
  let remoteSessionWorktreeDeletedAt: string | undefined;
  let gitStatusClean: boolean;
  let failGitBlame: boolean;
  let sessionDetailMessages: Array<{
    id: string;
    sessionId: string;
    role: string;
    content: string;
    encrypted: boolean;
    createdAt: string;
  }>;

  beforeEach(() => {
    fetchRequests = [];
    fetchCalls = [];
    deferredFileContent = new Map();
    failNextProjectCreate = false;
    failNextSessionCreate = false;
    failNextSessionRename = false;
    remoteSessionTitle = session.title;
    remoteSessionStatus = session.status;
    remoteSessionExecutionMode = "direct";
    remoteSessionExecutionFolder = session.executionFolder;
    remoteSessionWorktreeDeletedAt = undefined;
    gitStatusClean = true;
    failGitBlame = false;
    sessionDetailMessages = [
      {
        id: "message-1",
        sessionId: "session-1",
        role: "assistant",
        content: "Loaded from API",
        encrypted: false,
        createdAt: "2026-06-05T00:00:00.000Z",
      },
    ];
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
          return jsonResponse({
            sessions: [
              {
                ...session,
                title: remoteSessionTitle,
                status: remoteSessionStatus,
                executionMode: remoteSessionExecutionMode,
                executionFolder: remoteSessionExecutionFolder,
                ...(remoteSessionWorktreeDeletedAt === undefined
                  ? {}
                  : { worktreeDeletedAt: remoteSessionWorktreeDeletedAt }),
              },
            ],
          });
        }
        if (requestUrl.pathname === "/v1/sessions/session-1") {
          if (init?.method === "PATCH") {
            if (failNextSessionRename) {
              failNextSessionRename = false;
              return jsonResponse({ error: "rename_failed" }, 500);
            }
            const body = JSON.parse(String(init.body ?? "{}")) as {
              title?: string;
            };
            remoteSessionTitle = body.title ?? remoteSessionTitle;
            return jsonResponse({
              session: {
                ...session,
                title: remoteSessionTitle,
                status: remoteSessionStatus,
                executionMode: remoteSessionExecutionMode,
                executionFolder: remoteSessionExecutionFolder,
                ...(remoteSessionWorktreeDeletedAt === undefined
                  ? {}
                  : { worktreeDeletedAt: remoteSessionWorktreeDeletedAt }),
                updatedAt: "2026-06-05T00:01:00.000Z",
              },
            });
          }
          if (init?.method === "DELETE") {
            return new Response(null, { status: 204 });
          }
          return jsonResponse({
            session: {
              ...session,
              title: remoteSessionTitle,
              status: remoteSessionStatus,
              executionMode: remoteSessionExecutionMode,
              executionFolder: remoteSessionExecutionFolder,
              ...(remoteSessionWorktreeDeletedAt === undefined
                ? {}
                : { worktreeDeletedAt: remoteSessionWorktreeDeletedAt }),
            },
            messages: sessionDetailMessages,
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
        if (requestUrl.pathname === "/v1/git/status") {
          const context = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse({
            result: {
              requestId: "git-status-1",
              context,
              branch: "main",
              detached: false,
              headSha: "abc123",
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              clean: gitStatusClean,
              unborn: false,
              groups: [
                { id: "staged", changes: [] },
                {
                  id: "changes",
                  changes: gitStatusClean
                    ? []
                    : [
                        {
                          path: "src/App.tsx",
                          status: "modified",
                          staged: false,
                        },
                      ],
                },
                { id: "conflicts", changes: [] },
                { id: "untracked", changes: [] },
                { id: "ignored", changes: [] },
                { id: "submodules", changes: [] },
              ],
            },
          });
        }
        if (requestUrl.pathname === "/v1/git/branches") {
          const context = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse({
            result: {
              requestId: "git-branches-1",
              context,
              branches: [{ name: "main", current: true, remote: false }],
            },
          });
        }
        if (requestUrl.pathname === "/v1/git/history") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse({
            result: {
              requestId: "git-history-1",
              context: body.context,
              commits: [
                {
                  sha: "abc123",
                  parents: [],
                  authorName: "Test User",
                  committerName: "Test User",
                  summary: "Initial commit",
                  refs: [],
                },
              ],
            },
          });
        }
        if (requestUrl.pathname === "/v1/git/blame") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          if (failGitBlame) {
            return jsonResponse({ error: "blame_failed" }, 500);
          }
          return jsonResponse({
            result: {
              requestId: "git-blame-1",
              context: body.context,
              path: body.path ?? "src/App.tsx",
              ranges: [],
              commits: {},
            },
          });
        }
        if (requestUrl.pathname === "/v1/git/diff") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse({
            result: {
              requestId: "git-diff-1",
              context: body.context,
              path: body.path ?? "src/App.tsx",
              mode: body.mode ?? "working_tree",
              oldContent: "",
              newContent: "",
              language: "typescript",
              binary: false,
              tooLarge: false,
            },
          });
        }
        if (requestUrl.pathname === "/v1/projects/project-1/git/jobs") {
          return jsonResponse({ jobs: [] });
        }
        if (requestUrl.pathname.startsWith("/v1/git/")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse({
            job: {
              id: "git-job-1",
              projectId: "project-1",
              ...(body.context?.kind === "session_worktree"
                ? { sessionId: body.context.sessionId }
                : {}),
              contextKind: body.context?.kind ?? "project",
              operation: requestUrl.pathname.split("/").at(-1) ?? "git",
              status: "succeeded",
              createdAt: "2026-06-05T00:00:00.000Z",
              startedAt: "2026-06-05T00:00:00.000Z",
              finishedAt: "2026-06-05T00:00:00.000Z",
            },
          });
        }
        if (requestUrl.pathname === "/v1/approvals/approval-1") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            approved?: boolean;
          };
          return jsonResponse({
            approval: {
              ...patchApproval,
              status: body.approved ? "approved" : "rejected",
            },
          });
        }
        return jsonResponse({ error: "not found" }, 404);
      }),
    );
  });

  it("renders real remote state from the API", async () => {
    render(<App />);

    expect((await screen.findAllByText("Real Project")).length).toBeGreaterThan(
      0,
    );
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

  it("uses project git context while a managed worktree session is pending", async () => {
    remoteSessionStatus = "pending";
    remoteSessionExecutionMode = "managed_worktree";
    remoteSessionExecutionFolder = "/workspace/.roamcli-worktrees/session-1";
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) => new URL(call.url).pathname === "/v1/git/status",
        ),
      ).toBe(true),
    );
    const statusCalls = fetchCalls.filter(
      (call) => new URL(call.url).pathname === "/v1/git/status",
    );
    expect(
      statusCalls.map((call) => JSON.parse(String(call.init?.body ?? "{}"))),
    ).toEqual([{ kind: "project", projectId: "project-1" }]);
  });

  it("renders blame fetch failures inside the Git panel", async () => {
    gitStatusClean = false;
    failGitBlame = true;
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    await tools.findByText("src/App.tsx");
    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) => new URL(call.url).pathname === "/v1/git/diff",
        ),
      ).toBe(true),
    );

    fireEvent.click(tools.getByRole("button", { name: "Load blame" }));

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) => new URL(call.url).pathname === "/v1/git/blame",
        ),
      ).toBe(true),
    );
    expect(await tools.findByText("Git blame failed")).toBeInTheDocument();
    expect(await tools.findByText(/blame_failed/)).toBeInTheDocument();
  });

  it("clears stale selected Git changes after refresh", async () => {
    gitStatusClean = false;
    render(<App />);
    await screen.findByText("Loaded from API");

    const toolsPanel = screen.getByRole("complementary", {
      name: "Workspace tools",
    });
    const tools = within(toolsPanel);
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    await tools.findByText("src/App.tsx");
    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) => new URL(call.url).pathname === "/v1/git/diff",
        ),
      ).toBe(true),
    );

    gitStatusClean = true;
    fireEvent.click(tools.getByRole("button", { name: "Refresh Git" }));

    await waitFor(() =>
      expect(
        fetchCalls.filter(
          (call) => new URL(call.url).pathname === "/v1/git/status",
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(await tools.findByText("Working tree is clean.")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        toolsPanel.querySelector(".git-surface .git-diff-pane h3"),
      ).toHaveTextContent("No file selected"),
    );
  });

  it("renames the selected session", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Rename session",
    });
    const titleInput = within(dialog).getByLabelText("Session name");
    const saveButton = within(dialog).getByRole("button", { name: "Save" });
    expect(titleInput).toHaveValue("Real session");
    expect(saveButton).toBeDisabled();

    fireEvent.change(titleInput, { target: { value: "   " } });
    expect(saveButton).toBeDisabled();
    expect(
      fetchCalls.find(
        (call) =>
          new URL(call.url).pathname === "/v1/sessions/session-1" &&
          call.init?.method === "PATCH",
      ),
    ).toBeUndefined();

    fireEvent.change(titleInput, {
      target: { value: "  Renamed session  " },
    });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    expect(
      await screen.findByRole("button", {
        name: "Switch Session: Renamed session",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Rename session" }),
    ).not.toBeInTheDocument();
    const patchCall = fetchCalls.find(
      (call) =>
        new URL(call.url).pathname === "/v1/sessions/session-1" &&
        call.init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.init?.body))).toEqual({
      title: "Renamed session",
    });
  });

  it("keeps the rename dialog open when the session update fails", async () => {
    failNextSessionRename = true;
    render(<App />);
    await screen.findByText("Loaded from API");

    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Rename session",
    });
    const titleInput = within(dialog).getByLabelText("Session name");
    fireEvent.change(titleInput, {
      target: { value: "Rejected session title" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText(/500/)).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Rename session" }),
    ).toBeInTheDocument();
    expect(titleInput).toHaveValue("Rejected session title");
    expect(
      screen.getByRole("button", { name: "Switch Session: Real session" }),
    ).toBeInTheDocument();
  });

  it("does not auto-load files for a selected session whose runner is offline", async () => {
    const offlineProject = {
      ...project,
      id: "offline-project",
      name: "Offline Project",
      runnerId: "offline-runner",
      directory: "/offline-workspace",
    };
    const offlineSession = {
      ...session,
      id: "offline-session",
      title: "Offline session",
      projectId: "offline-project",
      runnerId: "offline-runner",
      status: "completed",
      executionFolder: "/offline-workspace",
      cwd: "/offline-workspace",
    };
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchRequests.push(url);
        fetchCalls.push({ url, init });
        const requestUrl = new URL(url);
        if (requestUrl.pathname === "/v1/runners") {
          return jsonResponse({ runners: [runner] });
        }
        if (requestUrl.pathname === "/v1/projects") {
          return jsonResponse({ projects: [offlineProject] });
        }
        if (requestUrl.pathname === "/v1/sessions") {
          return jsonResponse({ sessions: [offlineSession] });
        }
        if (requestUrl.pathname === "/v1/sessions/offline-session") {
          return jsonResponse({
            session: offlineSession,
            messages: [
              {
                id: "offline-message",
                sessionId: "offline-session",
                role: "assistant",
                content: "Loaded from offline session",
                encrypted: false,
                createdAt: "2026-06-05T00:00:00.000Z",
              },
            ],
            approvals: [],
            artifacts: [],
          });
        }
        return jsonResponse({ error: "not found" }, 404);
      },
    );

    render(<App />);

    await screen.findByText("Loaded from offline session");
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      fetchRequests.some((url) =>
        url.includes("/v1/sessions/offline-session/files"),
      ),
    ).toBe(false);
    expect(
      screen.queryByText("File tree request failed"),
    ).not.toBeInTheDocument();
  });

  it("scrolls the message list to the bottom when opening a session and streaming messages", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    let scrollHeight = 1200;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeight;
      },
    });
    try {
      const { container } = render(<App />);
      await screen.findByText("Loaded from API");
      const messageList = container.querySelector(
        ".message-list",
      ) as HTMLElement | null;
      expect(messageList).not.toBeNull();
      await waitFor(() => expect(messageList!.scrollTop).toBe(1200));

      scrollHeight = 1800;
      act(() => {
        sockets[0]?.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "token",
              sessionId: "session-1",
              content: " streamed answer",
              encrypted: false,
            }),
          }),
        );
      });

      await screen.findByText("streamed answer");
      await waitFor(() => expect(messageList!.scrollTop).toBe(1800));

      messageList!.scrollTop = 1000;
      fireEvent.scroll(messageList!);

      scrollHeight = 2400;
      act(() => {
        sockets[0]?.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "token",
              sessionId: "session-1",
              content: " while reading",
              encrypted: false,
            }),
          }),
        );
      });

      await screen.findByText("streamed answer while reading");
      await act(async () => {
        await Promise.resolve();
      });
      expect(messageList!.scrollTop).toBe(1000);
    } finally {
      if (descriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          descriptor,
        );
      } else {
        delete (HTMLElement.prototype as { scrollHeight?: number })
          .scrollHeight;
      }
    }
  });

  it("disables disconnected chat sends instead of queueing commands", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    fireEvent.change(composer, {
      target: { value: "hello while disconnected" },
    });

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(composer).toHaveValue("hello while disconnected");
    expect(
      screen.queryByText("Event stream is disconnected"),
    ).not.toBeInTheDocument();
  });

  it("shows global errors as dismissible auto-closing notifications", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");
    vi.useFakeTimers();
    try {
      act(() => {
        sockets[0]?.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "error",
              message: "runner failed",
            }),
          }),
        );
      });

      act(() => {
        sockets[0]?.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "error",
              message: "runner failed again",
            }),
          }),
        );
      });
      expect(screen.getByText("runner failed")).toBeInTheDocument();
      expect(screen.getByText("runner failed again")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      const dismissButton = screen.getAllByRole("button", {
        name: "Dismiss notification: Runner request failed",
      })[0];
      expect(dismissButton).toBeDefined();
      fireEvent.click(dismissButton!);
      expect(screen.queryByText("runner failed")).not.toBeInTheDocument();
      expect(screen.getByText("runner failed again")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.queryByText("runner failed again")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects closed streams with increasing retry delays", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");
    fireEvent.click(await screen.findByRole("treeitem", { name: /App\.tsx/ }));
    const editor = await screen.findByRole("textbox", {
      name: "Edit src/App.tsx",
    });
    fireEvent.change(editor, {
      target: { value: "export const unsaved = true;\n" },
    });
    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    fireEvent.change(composer, {
      target: { value: "draft before reconnect" },
    });
    sessionDetailMessages = [
      ...sessionDetailMessages,
      {
        id: "message-missed",
        sessionId: "session-1",
        role: "assistant",
        content: "Missed while offline",
        encrypted: false,
        createdAt: "2026-06-05T00:00:01.000Z",
      },
    ];
    remoteSessionStatus = "completed";
    vi.useFakeTimers();
    try {
      expect(sockets).toHaveLength(1);

      act(() => {
        sockets[0]?.dispatchEvent(new Event("close"));
      });
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(sockets).toHaveLength(2);

      act(() => {
        sockets[1]?.dispatchEvent(new Event("close"));
      });
      await act(async () => {
        vi.advanceTimersByTime(9_999);
      });
      expect(sockets).toHaveLength(2);

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(sockets).toHaveLength(3);

      act(() => {
        sockets[2]?.dispatchEvent(new Event("open"));
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("Missed while offline")).toBeInTheDocument();
      expect(composer).toHaveValue("draft before reconnect");
      expect(
        screen.getByRole("textbox", { name: "Edit src/App.tsx" }),
      ).toHaveValue("export const unsaved = true;\n");
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      expect(JSON.parse(sockets[2]?.sent.at(-1) ?? "{}")).toMatchObject({
        type: "userMessage",
        sessionId: "session-1",
        content: "draft before reconnect",
      });
    } finally {
      vi.useRealTimers();
    }
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
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create session" }),
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
    expect(within(sessionDialog).getByRole("alert")).toHaveTextContent(
      "Prompt is required.",
    );
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
    expect(within(projectDialog).getByLabelText("Runner base")).toHaveValue(
      "/workspace",
    );
    expect(within(projectDialog).getByLabelText("Runner base")).toHaveAttribute(
      "readonly",
    );
    fireEvent.change(within(projectDialog).getByLabelText("Directory"), {
      target: { value: "../outside" },
    });
    fireEvent.click(
      within(projectDialog).getByRole("button", { name: "Create project" }),
    );
    expect(within(projectDialog).getByRole("alert")).toHaveTextContent(
      "Directory must stay under the runner base.",
    );
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
    fireEvent.click(
      within(projectDialog).getByRole("button", { name: "Create project" }),
    );

    expect(
      await within(projectDialog).findByText(/project_already_exists/),
    ).toBeInTheDocument();
    const failedProjectCreate = fetchCalls.find(
      (call) =>
        call.url.endsWith("/v1/projects") && call.init?.method === "POST",
    );
    expect(JSON.parse(String(failedProjectCreate?.init?.body))).toMatchObject({
      name: "Duplicate Project",
      directory: "/workspace",
    });
    expect(
      screen.getByRole("dialog", { name: "New Project" }),
    ).toBeInTheDocument();
    expect(within(projectDialog).getByLabelText("Name")).toHaveValue(
      "Duplicate Project",
    );
    expect(within(projectDialog).getByLabelText("Runner base")).toHaveValue(
      "/workspace",
    );
    expect(within(projectDialog).getByLabelText("Directory")).toHaveValue("");
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
    let sessionSwitcher = openSessionSwitcher();

    fireEvent.click(
      sessionSwitcher.getByRole("button", {
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

    sessionSwitcher = openSessionSwitcher(/Created session/);
    fireEvent.click(
      sessionSwitcher.getByRole("button", {
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
      expect(sessionSwitcher.getByLabelText("Project")).toHaveValue(""),
    );

    fireEvent.click(
      sessionSwitcher.getByRole("button", { name: "New project" }),
    );
    const projectDialog = screen.getByRole("dialog", { name: "New Project" });
    fireEvent.change(within(projectDialog).getByLabelText("Name"), {
      target: { value: "Mobile Project" },
    });
    expect(within(projectDialog).getByLabelText("Runner base")).toHaveValue(
      "/workspace",
    );
    fireEvent.change(within(projectDialog).getByLabelText("Directory"), {
      target: { value: "mobile" },
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
          return (
            body.name === "Mobile Project" &&
            body.directory === "/workspace/mobile"
          );
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

    const sessionSwitcher = openSessionSwitcher();
    expect(sessionSwitcher.getByLabelText("Project")).toHaveValue("project-1");

    fireEvent.click(
      sessionSwitcher.getByRole("button", {
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
      expect(sessionSwitcher.getByLabelText("Project")).toHaveValue(""),
    );
    expect(sessionSwitcher.getByLabelText("Project")).toHaveDisplayValue(
      "No project selected",
    );
    expect(
      sessionSwitcher.queryByRole("button", {
        name: /New session in selected project/,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Create a project to start a session.").length,
    ).toBeGreaterThan(0);
  });

  it("updates the mobile session switcher when project selection changes", async () => {
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

    const sessionSwitcher = openSessionSwitcher();

    fireEvent.change(sessionSwitcher.getByLabelText("Project"), {
      target: { value: "project-backup" },
    });

    expect(
      screen.getByRole("dialog", { name: "Switch Session" }),
    ).toBeInTheDocument();
    expect(
      sessionSwitcher.getByRole("button", {
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
    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();

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
    expect(
      within(patchCard as HTMLElement).queryByRole("button", {
        name: "Accept patch hunk hunk-1",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(patchCard as HTMLElement).queryByRole("button", {
        name: "Reject patch hunk hunk-1",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));

    await waitFor(() => expect(screen.getByText("edited")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();
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

  it("hides resolved approval actions after approve or reject", async () => {
    render(<App />);
    await screen.findByText("Apply generated patch");

    const approvalCard = screen
      .getByText("Apply generated patch")
      .closest("article");
    expect(approvalCard).not.toBeNull();
    fireEvent.click(
      within(approvalCard as HTMLElement).getByRole("button", {
        name: "Approve",
      }),
    );

    await waitFor(() =>
      expect(
        within(approvalCard as HTMLElement).getByText("approved"),
      ).toBeInTheDocument(),
    );
    expect(
      within(approvalCard as HTMLElement).queryByRole("button", {
        name: "Approve",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(approvalCard as HTMLElement).queryByRole("button", {
        name: "Reject",
      }),
    ).not.toBeInTheDocument();
    const approvalCall = fetchCalls.find((call) =>
      call.url.includes("/v1/approvals/approval-1"),
    );
    expect(approvalCall?.init?.method).toBe("POST");
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

    const sessionSwitcher = openSessionSwitcher();
    fireEvent.change(sessionSwitcher.getByLabelText("Project"), {
      target: { value: "project-backup" },
    });
    expect(sessionSwitcher.getByLabelText("Project")).toHaveValue(
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

    expect(sessionSwitcher.getByLabelText("Project")).toHaveValue(
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

  it("collapses completed turn intermediates after the final assistant message", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "message:created",
            message: {
              id: "message-user-fold",
              sessionId: "session-1",
              role: "user",
              content: "question",
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
              id: "message-progress-1",
              sessionId: "session-1",
              role: "assistant",
              content: "checking files",
              encrypted: false,
              createdAt: new Date(Date.now() + 2000).toISOString(),
            },
          }),
        }),
      );
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "message:created",
            message: {
              id: "message-progress-2",
              sessionId: "session-1",
              role: "assistant",
              content: "running tests",
              encrypted: false,
              createdAt: new Date(Date.now() + 3000).toISOString(),
            },
          }),
        }),
      );
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "message:created",
            message: {
              id: "message-final",
              sessionId: "session-1",
              role: "assistant",
              content: "final answer",
              encrypted: false,
              createdAt: new Date(Date.now() + 4000).toISOString(),
            },
          }),
        }),
      );
    });

    const conversation = screen.getByRole("region", { name: "Conversation" });
    expect(
      within(conversation).queryByText("中间过程（2 条）"),
    ).not.toBeInTheDocument();

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "session:updated",
            session: {
              ...session,
              status: "completed",
              updatedAt: new Date(Date.now() + 5000).toISOString(),
            },
          }),
        }),
      );
    });

    const intermediate =
      await within(conversation).findByText("中间过程（2 条）");
    const group = intermediate.closest("details");
    expect(group).not.toHaveAttribute("open");
    expect(group).not.toBeNull();
    expect(within(group!).getByText("checking files")).toBeInTheDocument();
    expect(within(group!).getByText("running tests")).toBeInTheDocument();
    expect(within(conversation).getByText("final answer")).toBeInTheDocument();
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
