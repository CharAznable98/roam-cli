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
import type {
  Approval,
  Artifact,
  AuthStatus,
  GitCommitSummary,
  Message,
  MessageAttachment,
} from "@roamcli/shared/protocol";
import { App } from "./App";
import { LAST_SELECTION_STORAGE_KEY } from "./app/selection-storage";

const GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

vi.mock("@monaco-editor/react", () => {
  function Editor({
    value = "",
    onChange,
    className,
    wrapperProps,
    options,
  }: {
    value?: string;
    onChange?: (value: string | undefined, event: unknown) => void;
    className?: string;
    wrapperProps?: { "aria-label"?: string };
    options?: { ariaLabel?: string; readOnly?: boolean };
  }) {
    return (
      <textarea
        aria-label={
          options?.ariaLabel ?? wrapperProps?.["aria-label"] ?? "Monaco editor"
        }
        className={className}
        readOnly={options?.readOnly}
        value={value}
        onChange={(event) => onChange?.(event.currentTarget.value, event)}
      />
    );
  }

  function DiffEditor({
    className,
    modified = "",
  }: {
    className?: string;
    modified?: string;
  }) {
    return (
      <div
        className={className}
        data-testid="monaco-diff-editor"
        data-modified={modified}
      />
    );
  }

  return { default: Editor, Editor, DiffEditor };
});

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
} satisfies Artifact;

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

const authSession = {
  id: "auth-session-1",
  createdAt: "2026-06-05T00:00:00.000Z",
  lastSeenAt: "2026-06-05T00:00:00.000Z",
  idleExpiresAt: "2026-06-06T00:00:00.000Z",
  absoluteExpiresAt: "2026-07-05T00:00:00.000Z",
  userAgent: "Vitest",
  current: true,
};

const accountSecurity = {
  sessions: [authSession],
  runnerToken: "runner-token",
  runnerTokenCreatedAt: "2026-06-05T00:00:00.000Z",
  runnerTokenUpdatedAt: "2026-06-05T00:00:00.000Z",
};

let authStatus: AuthStatus;
let accountSecurityResponses: Array<typeof accountSecurity>;
let queuedAccountSecurityResponses: Array<Deferred<Response>>;
let sockets: TestWebSocket[];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type MockGitChange = {
  path: string;
  oldPath?: string;
  status: string;
  staged: boolean;
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

function mockGitContextKey(context: {
  kind?: string;
  projectId?: string;
  sessionId?: string;
}) {
  return context.kind === "session_worktree"
    ? `session:${context.sessionId}`
    : `project:${context.projectId}`;
}

function gitStatusPayload(
  context: unknown,
  clean: boolean,
  changes: MockGitChange[],
  options: { unborn?: boolean } = {},
) {
  const visibleChanges = clean ? [] : changes;
  return {
    kind: "repository",
    requestId: "git-status-1",
    context,
    branch: "main",
    detached: false,
    headSha: options.unborn ? undefined : "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    clean,
    unborn: options.unborn ?? false,
    groups: [
      {
        id: "staged",
        changes: visibleChanges.filter((change) => change.staged),
      },
      {
        id: "changes",
        changes: visibleChanges.filter((change) => !change.staged),
      },
      { id: "conflicts", changes: [] },
      { id: "untracked", changes: [] },
      { id: "ignored", changes: [] },
      { id: "submodules", changes: [] },
    ],
  };
}

function gitBlamePayload(context: unknown, path: string, summary: string) {
  const sha = `sha-${path.replace(/[^a-z0-9]/gi, "-")}`;
  return {
    requestId: `git-blame-${path}`,
    context,
    path,
    ranges: [{ startLine: 1, endLine: 1, commitSha: sha }],
    commits: {
      [sha]: {
        sha,
        authorName: "Test User",
        summary,
      },
    },
  };
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
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
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

function openSettingsTab() {
  fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
}

async function findSessionFile(name: RegExp) {
  const src = await screen.findByRole("treeitem", { name: /src/ });
  if (src.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(src);
  }
  return screen.findByRole("treeitem", { name });
}

async function flushAppEffects(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  });
}

function isSessionFileTreeRequest(
  url: string,
  path: string,
  depth = "1",
): boolean {
  const requestUrl = new URL(url);
  return (
    requestUrl.pathname === "/v1/sessions/session-1/files" &&
    requestUrl.searchParams.get("path") === path &&
    requestUrl.searchParams.get("depth") === depth
  );
}

function openSessionActions() {
  fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
  return within(screen.getByRole("menu", { name: "Session actions" }));
}

function authMockResponse(
  pathname: string,
  init?: RequestInit,
): Response | Promise<Response> | undefined {
  if (pathname === "/v1/auth/status") {
    return jsonResponse({ auth: authStatus });
  }
  if (pathname === "/v1/auth/login" && init?.method === "POST") {
    authStatus = {
      status: "authenticated",
      session: authSession,
    };
    return jsonResponse({ auth: authStatus, account: accountSecurity });
  }
  if (pathname === "/v1/auth/logout" && init?.method === "POST") {
    authStatus = { status: "unauthenticated" };
    return new Response(null, { status: 204 });
  }
  if (pathname === "/v1/auth/logout-all" && init?.method === "POST") {
    authStatus = { status: "unauthenticated" };
    return new Response(null, { status: 204 });
  }
  if (pathname === "/v1/auth/password" && init?.method === "POST") {
    authStatus = { status: "unauthenticated" };
    return new Response(null, { status: 204 });
  }
  if (
    pathname === "/v1/auth/runner-token/regenerate" &&
    init?.method === "POST"
  ) {
    return jsonResponse({
      account: {
        ...accountSecurity,
        runnerToken: "runner-token-regenerated",
        runnerTokenUpdatedAt: "2026-06-05T00:01:00.000Z",
      },
    });
  }
  if (pathname === "/v1/auth/account") {
    const queuedResponse = queuedAccountSecurityResponses.shift();
    if (queuedResponse) {
      return queuedResponse.promise;
    }
    return jsonResponse({
      account: accountSecurityResponses.shift() ?? accountSecurity,
    });
  }
  return undefined;
}

describe("App", () => {
  let fetchRequests: string[];
  let fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  let deferredFileContent: Map<string, Deferred<Response>>;
  let deferredGitStatus: Map<string, Deferred<Response>>;
  let deferredGitDiff: Map<string, Deferred<Response>>;
  let deferredGitHistory: Map<string, Deferred<Response>>;
  let deferredGitBlame: Map<string, Deferred<Response>>;
  let queuedRunnerResponses: Array<Deferred<Response>>;
  let failBootstrapRunners: boolean;
  let failNextProjectCreate: boolean;
  let failNextSessionCreate: boolean;
  let failNextSessionRename: boolean;
  let runnerOnline: boolean;
  let defaultProjectVisible: boolean;
  let defaultSessionVisible: boolean;
  let remoteSessionTitle: string;
  let remoteSessionStatus: string;
  let statusCheckResultStatus: string;
  let remoteSessionExecutionMode: "direct" | "managed_worktree";
  let remoteSessionExecutionFolder: string;
  let remoteSessionWorktreeDeletedAt: string | undefined;
  let gitStatusClean: boolean;
  let gitStatusUnborn: boolean;
  let gitStatusChanges: MockGitChange[];
  let gitHistoryCommits: GitCommitSummary[];
  let gitHistoryNextCursor: string | undefined;
  let failNextGitStatus: boolean;
  let failNonGitStatus: boolean;
  let failGitBlame: boolean;
  let sessionDetailMessages: Message[];
  let sessionDetailAttachments: MessageAttachment[];
  let sessionDetailApprovals: Approval[];
  let sessionDetailArtifacts: Artifact[];

  beforeEach(() => {
    fetchRequests = [];
    fetchCalls = [];
    deferredFileContent = new Map();
    deferredGitStatus = new Map();
    deferredGitDiff = new Map();
    deferredGitHistory = new Map();
    deferredGitBlame = new Map();
    queuedRunnerResponses = [];
    queuedAccountSecurityResponses = [];
    failBootstrapRunners = false;
    failNextProjectCreate = false;
    failNextSessionCreate = false;
    failNextSessionRename = false;
    runnerOnline = true;
    defaultProjectVisible = true;
    defaultSessionVisible = true;
    remoteSessionTitle = session.title;
    remoteSessionStatus = session.status;
    statusCheckResultStatus = "stopped";
    authStatus = {
      status: "authenticated",
      session: authSession,
    };
    accountSecurityResponses = [accountSecurity];
    remoteSessionExecutionMode = "direct";
    remoteSessionExecutionFolder = session.executionFolder;
    remoteSessionWorktreeDeletedAt = undefined;
    gitStatusClean = true;
    gitStatusUnborn = false;
    gitStatusChanges = [
      {
        path: "src/App.tsx",
        status: "modified",
        staged: false,
      },
    ];
    gitHistoryCommits = [
      {
        sha: "abc123",
        parents: ["parent123"],
        authorName: "Test User",
        committerName: "Test User",
        summary: "Initial commit",
        refs: [],
        files: [
          {
            path: "src/App.tsx",
            status: "modified",
            staged: false,
          },
        ],
      },
    ];
    gitHistoryNextCursor = undefined;
    failNextGitStatus = false;
    failNonGitStatus = false;
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
    sessionDetailAttachments = [];
    sessionDetailApprovals = [patchApproval];
    sessionDetailArtifacts = [patchArtifact];
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
        const authResponse = authMockResponse(requestUrl.pathname, init);
        if (authResponse) {
          return authResponse;
        }
        if (requestUrl.pathname === "/v1/runners") {
          const queuedResponse = queuedRunnerResponses.shift();
          if (queuedResponse) {
            return queuedResponse.promise;
          }
          if (failBootstrapRunners) {
            return jsonResponse({ message: "backend route unavailable" }, 503);
          }
          return jsonResponse({ runners: runnerOnline ? [runner] : [] });
        }
        if (requestUrl.pathname === "/v1/runners/real-runner/directories") {
          if (init?.method === "POST") {
            const body = JSON.parse(String(init.body ?? "{}")) as {
              parentPath?: string;
              name?: string;
            };
            const parentPath = body.parentPath || ".";
            const path =
              parentPath === "."
                ? body.name || "created"
                : `${parentPath}/${body.name || "created"}`;
            return jsonResponse(
              {
                result: {
                  requestId: "directory-create-1",
                  path,
                  node: {
                    path,
                    name: body.name || "created",
                    type: "directory",
                    children: [],
                  },
                },
              },
              201,
            );
          }
          const requestedPath = requestUrl.searchParams.get("path") ?? ".";
          return jsonResponse({
            result: {
              root: {
                path: requestedPath,
                name: requestedPath === "." ? "workspace" : requestedPath,
                type: "directory",
                children:
                  requestedPath === "."
                    ? [
                        {
                          path: "mobile",
                          name: "mobile",
                          type: "directory",
                          children: [],
                        },
                      ]
                    : [],
              },
            },
          });
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
          return jsonResponse({
            projects: defaultProjectVisible ? [project] : [],
          });
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
            sessions: defaultSessionVisible
              ? [
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
                ]
              : [],
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
            attachments: sessionDetailAttachments,
            approvals: sessionDetailApprovals,
            artifacts: sessionDetailArtifacts,
          });
        }
        if (
          requestUrl.pathname === "/v1/sessions/session-1/status/check" &&
          init?.method === "POST"
        ) {
          remoteSessionStatus = statusCheckResultStatus;
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
              updatedAt: "2026-06-05T00:02:00.000Z",
            },
          });
        }
        if (
          requestUrl.pathname === "/v1/sessions/session-1/messages" &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(String(init.body ?? "{}")) as {
            content?: string;
          };
          const message: Message = {
            id: "message-sent",
            sessionId: "session-1",
            role: "user",
            content: body.content ?? "",
            encrypted: false,
            createdAt: "2026-06-05T00:00:02.000Z",
          };
          sessionDetailMessages = [...sessionDetailMessages, message];
          return jsonResponse({ message, attachments: [] }, 201);
        }
        if (requestUrl.pathname === "/v1/sessions/session-1/files") {
          const requestedPath = requestUrl.searchParams.get("path") ?? ".";
          if (requestedPath === "src") {
            return jsonResponse({
              root: {
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
                  {
                    path: "src/logo.png",
                    name: "logo.png",
                    type: "file",
                    size: 11,
                  },
                ],
              },
            });
          }
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
              kind: requestedPath.endsWith(".png") ? "image" : "text",
              ...(requestedPath.endsWith(".png")
                ? {
                    contentBase64: "aW1hZ2UtYnl0ZXM=",
                    mimeType: "image/png",
                    size: 11,
                  }
                : {
                    content:
                      requestedPath === "src/App.tsx"
                        ? "export function RealContent() { return null; }"
                        : `export const file = ${JSON.stringify(requestedPath)};`,
                  }),
              truncated: false,
              encoding: requestedPath.endsWith(".png") ? "base64" : "utf8",
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
          const deferredResponse = deferredGitStatus.get(
            mockGitContextKey(context),
          );
          if (deferredResponse) {
            return deferredResponse.promise;
          }
          if (failNextGitStatus) {
            failNextGitStatus = false;
            return jsonResponse({ error: "status_failed" }, 500);
          }
          if (failNonGitStatus) {
            failNonGitStatus = false;
            return jsonResponse({
              result: {
                kind: "not_git_repository",
                requestId: "git-status-1",
                context,
                message: "This directory is not a Git repository.",
              },
            });
          }
          return jsonResponse({
            result: gitStatusPayload(
              context,
              gitStatusClean,
              gitStatusChanges,
              {
                unborn: gitStatusUnborn,
              },
            ),
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
          const deferredResponse =
            deferredGitHistory.get(
              `${mockGitContextKey(body.context)}:${body.ref ?? ""}:${body.cursor ?? ""}`,
            ) ?? deferredGitHistory.get(body.cursor ?? "");
          if (deferredResponse) {
            return deferredResponse.promise;
          }
          return jsonResponse({
            result: {
              requestId: "git-history-1",
              context: body.context,
              commits: gitHistoryCommits,
              ...(gitHistoryNextCursor
                ? { nextCursor: gitHistoryNextCursor }
                : {}),
            },
          });
        }
        if (requestUrl.pathname === "/v1/git/blame") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const requestedPath = body.path ?? "src/App.tsx";
          if (failGitBlame) {
            return jsonResponse({ error: "blame_failed" }, 500);
          }
          const deferredResponse = deferredGitBlame.get(requestedPath);
          if (deferredResponse) {
            return deferredResponse.promise;
          }
          return jsonResponse({
            result: gitBlamePayload(
              body.context,
              requestedPath,
              `Blame for ${requestedPath}`,
            ),
          });
        }
        if (requestUrl.pathname === "/v1/git/diff") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const requestedPath = body.path ?? "src/App.tsx";
          const requestedMode = body.mode ?? "working_tree";
          const deferredResponse =
            deferredGitDiff.get(`${requestedMode}:${requestedPath}`) ??
            deferredGitDiff.get(requestedPath);
          if (deferredResponse) {
            return deferredResponse.promise;
          }
          return jsonResponse({
            result: {
              requestId: "git-diff-1",
              context: body.context,
              path: requestedPath,
              mode: requestedMode,
              oldContent: "",
              newContent: `diff for ${requestedPath}`,
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
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
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
    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem(LAST_SELECTION_STORAGE_KEY) ?? "null"),
      ).toEqual({ projectId: "project-1", sessionId: "session-1" });
    });
  });

  it("exposes account security from the Settings tab", async () => {
    render(<App />);

    await screen.findByText("Loaded from API");
    expect(
      screen.queryByRole("button", { name: "Open Account & Security" }),
    ).not.toBeInTheDocument();
    openSettingsTab();
    fireEvent.click(screen.getByRole("button", { name: /Account & Security/ }));

    expect(
      screen.getByRole("region", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText("Runner token")).toHaveTextContent(
      "runner-token",
    );
    expect(screen.getByText(/--token 'runner-token'/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Change Password/ }));
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Account & Security" }));
    expect(await screen.findByLabelText("Runner token")).toHaveTextContent(
      "runner-token",
    );
  });

  it("refreshes account security when Settings opens", async () => {
    accountSecurityResponses = [
      accountSecurity,
      {
        ...accountSecurity,
        runnerToken: "runner-token-refreshed",
        runnerTokenUpdatedAt: "2026-06-05T00:02:00.000Z",
        sessions: [
          {
            ...authSession,
            id: "auth-session-refreshed",
            lastSeenAt: "2026-06-05T00:02:00.000Z",
          },
        ],
      },
    ];
    render(<App />);

    await screen.findByText("Loaded from API");
    openSettingsTab();
    fireEvent.click(screen.getByRole("button", { name: /Account & Security/ }));

    expect(
      await screen.findByText("runner-token-refreshed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/--token 'runner-token-refreshed'/),
    ).toBeInTheDocument();
    expect(
      fetchCalls.filter(
        (call) => new URL(call.url).pathname === "/v1/auth/account",
      ),
    ).toHaveLength(2);
  });

  it("waits for Settings account refresh before showing account actions", async () => {
    render(<App />);

    await screen.findByText("Loaded from API");
    const delayedAccount = deferred<Response>();
    queuedAccountSecurityResponses.push(delayedAccount);
    openSettingsTab();
    fireEvent.click(screen.getByRole("button", { name: /Account & Security/ }));

    expect(screen.getByText("Loading account settings...")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Regenerate" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Log out all" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      delayedAccount.resolve(
        jsonResponse({
          account: {
            ...accountSecurity,
            runnerToken: "runner-token-after-refresh",
            runnerTokenUpdatedAt: "2026-06-05T00:03:00.000Z",
          },
        }),
      );
      await delayedAccount.promise;
    });

    expect(
      await screen.findByText("runner-token-after-refresh"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeEnabled();
  });

  it("keeps cached account hidden when Settings account refresh fails", async () => {
    render(<App />);

    await screen.findByText("Loaded from API");
    const failedAccount = deferred<Response>();
    queuedAccountSecurityResponses.push(failedAccount);
    openSettingsTab();
    fireEvent.click(screen.getByRole("button", { name: /Account & Security/ }));

    expect(screen.getByText("Loading account settings...")).toBeInTheDocument();

    await act(async () => {
      failedAccount.reject(new Error("account API unavailable"));
      await expect(failedAccount.promise).rejects.toThrow(
        "account API unavailable",
      );
    });

    expect(
      await screen.findByText("Account settings could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.getByText("Account settings unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Runner token")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Regenerate" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Settings reachable before runners connect", async () => {
    runnerOnline = false;
    defaultProjectVisible = false;
    defaultSessionVisible = false;
    render(<App />);

    await screen.findByText("No runners are online");
    openSettingsTab();
    fireEvent.click(screen.getByRole("button", { name: /Account & Security/ }));

    expect(await screen.findByLabelText("Runner token")).toHaveTextContent(
      "runner-token",
    );
    expect(
      screen.getAllByText(/--token 'runner-token'/).length,
    ).toBeGreaterThan(0);
  });

  it("uses native confirmation and global notification for runner token regeneration", async () => {
    render(<App />);

    await screen.findByText("Loaded from API");
    openSettingsTab();
    fireEvent.click(screen.getByRole("button", { name: /Account & Security/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));

    expect(window.confirm).toHaveBeenCalledWith(
      "Regenerate the Runner token? Current online runners stay connected, but old-token reconnects will fail.",
    );
    expect(
      await screen.findByText("runner-token-regenerated"),
    ).toBeInTheDocument();
    expect(screen.getByText("Runner token regenerated")).toBeInTheDocument();
  });

  it("leaves Settings for login after logout and does not restore a settings child view after login", async () => {
    render(<App />);

    await screen.findByText("Loaded from API");
    openSettingsTab();
    fireEvent.click(screen.getByRole("button", { name: /Account & Security/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));

    expect(
      await screen.findByRole("heading", { name: "Owner Login" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Settings" }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Loaded from API")).toBeInTheDocument();
    openSettingsTab();
    expect(
      screen.getByRole("button", { name: /Account & Security/ }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
  });

  it("shows setup after an authenticated browser loses owner configuration", async () => {
    render(<App />);

    await screen.findByText("Loaded from API");
    authStatus = { status: "setup_required" };

    act(() => {
      sockets[0]?.dispatchEvent(new Event("close"));
    });

    expect(
      await screen.findByRole("heading", { name: "Set Up Owner Access" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Setup token")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Owner Login" }),
    ).not.toBeInTheDocument();
  });

  it("retries the bootstrap API from connection recovery", async () => {
    failBootstrapRunners = true;
    render(<App />);

    expect(
      await screen.findByText("API connection failed"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loaded from API")).not.toBeInTheDocument();

    failBootstrapRunners = false;
    fireEvent.click(
      screen.getByRole("button", { name: "Connection settings" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Connection" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reconnect now" }),
    );

    expect(await screen.findByText("Loaded from API")).toBeInTheDocument();
    expect(screen.queryByText("API connection failed")).not.toBeInTheDocument();
    expect(
      fetchCalls.filter((call) => new URL(call.url).pathname === "/v1/runners")
        .length,
    ).toBeGreaterThan(1);
  });

  it("keeps Settings reachable when the bootstrap API fails", async () => {
    failBootstrapRunners = true;
    render(<App />);

    expect(
      await screen.findByText("API connection failed"),
    ).toBeInTheDocument();
    openSettingsTab();
    fireEvent.click(screen.getByRole("button", { name: /Account & Security/ }));

    expect(await screen.findByLabelText("Runner token")).toHaveTextContent(
      "runner-token",
    );
    expect(screen.getByText(/--token 'runner-token'/)).toBeInTheDocument();
  });

  it("ignores stale bootstrap failures after a later recovery succeeds", async () => {
    failBootstrapRunners = true;
    render(<App />);
    expect(
      await screen.findByText("API connection failed"),
    ).toBeInTheDocument();

    failBootstrapRunners = false;
    const staleFailure = deferred<Response>();
    const successfulRetry = deferred<Response>();
    queuedRunnerResponses.push(staleFailure, successfulRetry);

    fireEvent.click(
      screen.getByRole("button", { name: "Connection settings" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Connection" });
    const reconnectButton = within(dialog).getByRole("button", {
      name: "Reconnect now",
    });

    fireEvent.click(reconnectButton);
    fireEvent.click(reconnectButton);

    await act(async () => {
      successfulRetry.resolve(jsonResponse({ runners: [runner] }));
      await successfulRetry.promise;
    });
    expect(await screen.findByText("Loaded from API")).toBeInTheDocument();

    await act(async () => {
      staleFailure.resolve(
        jsonResponse({ message: "stale backend failure" }, 503),
      );
      await staleFailure.promise;
    });

    expect(screen.getByText("Loaded from API")).toBeInTheDocument();
    expect(screen.queryByText("API connection failed")).not.toBeInTheDocument();
  });

  it("keeps the initial bootstrap authoritative while missed-events sync is pending", async () => {
    const initialBootstrap = deferred<Response>();
    const missedEventsSync = deferred<Response>();
    queuedRunnerResponses.push(initialBootstrap, missedEventsSync);

    vi.useFakeTimers();
    try {
      render(<App />);
      await flushAppEffects();
      expect(sockets).toHaveLength(1);

      act(() => {
        sockets[0]?.dispatchEvent(new Event("close"));
      });

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(sockets).toHaveLength(2);

      act(() => {
        sockets[1]?.dispatchEvent(new Event("open"));
      });

      await act(async () => {
        missedEventsSync.resolve(
          jsonResponse({ message: "temporary sync failure" }, 503),
        );
        await missedEventsSync.promise;
      });

      await act(async () => {
        initialBootstrap.resolve(jsonResponse({ runners: [runner] }));
        await initialBootstrap.promise;
      });

      expect(screen.getByText("Loaded from API")).toBeInTheDocument();
      expect(
        screen.queryByText("API connection failed"),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks only the selected session status from the session actions menu", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    const menu = openSessionActions();
    expect(menu.getByRole("menuitem", { name: /Check status/ })).toBeEnabled();
    expect(menu.getByRole("menuitem", { name: /Resume/ })).toBeDisabled();
    expect(menu.getByRole("menuitem", { name: /Stop/ })).toBeDisabled();

    fireEvent.click(menu.getByRole("menuitem", { name: /Check status/ }));

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) =>
            call.url.endsWith("/v1/sessions/session-1/status/check") &&
            call.init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("1 runners online")).toBeInTheDocument();
  });

  it("automatically repairs stale active session status from persisted session state", async () => {
    remoteSessionStatus = "pending";
    render(<App />);
    await screen.findByText("Loaded from API");
    expect(screen.getByText("Pending")).toBeInTheDocument();

    const countSessionDetailReads = () =>
      fetchCalls.filter((call) => {
        const requestUrl = new URL(call.url);
        return (
          requestUrl.pathname === "/v1/sessions/session-1" &&
          (call.init?.method ?? "GET") === "GET"
        );
      }).length;
    const initialSessionDetailReads = countSessionDetailReads();
    remoteSessionStatus = "completed";

    await waitFor(
      () =>
        expect(countSessionDetailReads()).toBeGreaterThan(
          initialSessionDetailReads,
        ),
      { timeout: 2500 },
    );
    expect(
      fetchCalls.some(
        (call) =>
          call.url.endsWith("/v1/sessions/session-1/status/check") &&
          call.init?.method === "POST",
      ),
    ).toBe(false);
    expect(await screen.findByText("Completed")).toBeInTheDocument();
  });

  it("merges missed session detail payloads during passive status repair", async () => {
    remoteSessionStatus = "running";
    sessionDetailApprovals = [];
    sessionDetailArtifacts = [];
    render(<App />);
    await screen.findByText("Loaded from API");
    expect(screen.queryByText("Late patch approval")).not.toBeInTheDocument();

    const countSessionDetailReads = () =>
      fetchCalls.filter((call) => {
        const requestUrl = new URL(call.url);
        return (
          requestUrl.pathname === "/v1/sessions/session-1" &&
          (call.init?.method ?? "GET") === "GET"
        );
      }).length;
    const initialSessionDetailReads = countSessionDetailReads();
    remoteSessionStatus = "waiting_approval";
    sessionDetailMessages = [
      ...sessionDetailMessages,
      {
        id: "message-late",
        sessionId: "session-1",
        role: "assistant",
        content: "Approval required",
        encrypted: false,
        createdAt: "2026-06-05T00:00:01.000Z",
      },
    ];
    sessionDetailApprovals = [
      {
        ...patchApproval,
        id: "approval-late",
        summary: "Late patch approval",
        payload: {
          hunks: [{ ...patchHunk, id: "hunk-late" }],
        },
      },
    ];
    sessionDetailArtifacts = [
      {
        ...patchArtifact,
        id: "artifact-late",
        name: "late.patch",
        storagePath: "artifacts/session-1/late.patch",
      },
    ];

    await waitFor(
      () =>
        expect(countSessionDetailReads()).toBeGreaterThan(
          initialSessionDetailReads,
        ),
      { timeout: 2500 },
    );

    expect(await screen.findByText("Late patch approval")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "Accept patch hunk hunk-late",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Approval required")).toBeInTheDocument();
    expect(
      screen.getByText(/artifacts\/session-1\/late.patch/),
    ).toBeInTheDocument();
    expect(
      fetchCalls.some(
        (call) =>
          call.url.endsWith("/v1/sessions/session-1/status/check") &&
          call.init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("backs off passive session detail polling after a successful sync", async () => {
    remoteSessionStatus = "running";
    vi.useFakeTimers();
    try {
      render(<App />);
      await flushAppEffects();
      expect(screen.getByText("Loaded from API")).toBeInTheDocument();

      const countSessionDetailReads = () =>
        fetchCalls.filter((call) => {
          const requestUrl = new URL(call.url);
          return (
            requestUrl.pathname === "/v1/sessions/session-1" &&
            (call.init?.method ?? "GET") === "GET"
          );
        }).length;
      const initialSessionDetailReads = countSessionDetailReads();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });
      const firstRepairReadCount = countSessionDetailReads();
      expect(firstRepairReadCount).toBeGreaterThan(initialSessionDetailReads);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });
      expect(countSessionDetailReads()).toBe(firstRepairReadCount);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(countSessionDetailReads()).toBeGreaterThan(firstRepairReadCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps existing sessions reachable when their runner is offline", async () => {
    runnerOnline = false;
    remoteSessionStatus = "running";
    render(<App />);
    await screen.findByText("Loaded from API");

    expect(screen.queryByText("No runners are online")).not.toBeInTheDocument();
    expect(screen.getByText("0 runners online")).toBeInTheDocument();
    expect(screen.getAllByText("Real session").length).toBeGreaterThan(0);

    fireEvent.click(
      openSessionActions().getByRole("menuitem", { name: /Check status/ }),
    );

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) =>
            call.url.endsWith("/v1/sessions/session-1/status/check") &&
            call.init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
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

  it("loads current branch history and commit file diffs inside the Git panel", async () => {
    gitStatusClean = false;
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    await tools.findByText("src/App.tsx");
    fireEvent.click(tools.getByRole("tab", { name: "History" }));

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) => new URL(call.url).pathname === "/v1/git/history",
        ),
      ).toBe(true),
    );
    expect(
      (await tools.findAllByText("Initial commit")).length,
    ).toBeGreaterThan(0);
    expect(await tools.findByText("Changed files")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (new URL(call.url).pathname !== "/v1/git/diff") return false;
          const body = JSON.parse(String(call.init?.body ?? "{}"));
          return (
            body.mode === "commit" &&
            body.path === "src/App.tsx" &&
            body.oldRef === "parent123" &&
            body.newRef === "abc123"
          );
        }),
      ).toBe(true),
    );
  });

  it("renders children under changed file path nodes in tree view", async () => {
    gitStatusClean = false;
    gitStatusChanges = [
      {
        path: "foo",
        status: "deleted",
        staged: false,
      },
      {
        path: "foo/bar",
        status: "added",
        staged: false,
      },
    ];
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));

    expect(
      await tools.findByRole("button", { name: "foo" }),
    ).toBeInTheDocument();
    expect(
      await tools.findByRole("button", { name: "foo/bar" }),
    ).toBeInTheDocument();
  });

  it("passes oldPath when diffing renamed changes", async () => {
    gitStatusClean = false;
    gitStatusChanges = [
      {
        path: "src/New.tsx",
        oldPath: "src/Old.tsx",
        status: "renamed",
        staged: true,
      },
    ];
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    await tools.findByText("src/New.tsx");

    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (new URL(call.url).pathname !== "/v1/git/diff") return false;
          const body = JSON.parse(String(call.init?.body ?? "{}"));
          return (
            body.mode === "staged" &&
            body.path === "src/New.tsx" &&
            body.oldPath === "src/Old.tsx"
          );
        }),
      ).toBe(true),
    );
  });

  it("includes old paths when unstaging staged rename groups", async () => {
    gitStatusClean = false;
    gitStatusChanges = [
      {
        path: "src/New.tsx",
        oldPath: "src/Old.tsx",
        status: "renamed",
        staged: true,
      },
    ];
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    await tools.findByText("src/New.tsx");
    fireEvent.click(tools.getByLabelText("Staged actions"));
    fireEvent.click(tools.getByRole("button", { name: "Unstage all" }));

    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (new URL(call.url).pathname !== "/v1/git/unstage") return false;
          const body = JSON.parse(String(call.init?.body ?? "{}"));
          return (
            Array.isArray(body.paths) &&
            body.paths.join("\n") === "src/Old.tsx\nsrc/New.tsx"
          );
        }),
      ).toBe(true),
    );
  });

  it("shows empty history without fetching commits for unborn repositories", async () => {
    gitStatusUnborn = true;
    gitStatusClean = true;
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    expect(
      await tools.findByText("Working tree is clean."),
    ).toBeInTheDocument();
    fireEvent.click(tools.getByRole("tab", { name: "History" }));

    expect(await tools.findByText("No commits found.")).toBeInTheDocument();
    expect(
      fetchCalls.some(
        (call) => new URL(call.url).pathname === "/v1/git/history",
      ),
    ).toBe(false);
  });

  it("diffs root history commits against the empty tree", async () => {
    gitHistoryCommits = [
      {
        sha: "root123",
        parents: [],
        authorName: "Test User",
        committerName: "Test User",
        summary: "Root commit",
        refs: [],
        files: [
          {
            path: "README.md",
            status: "added",
            staged: false,
          },
        ],
      },
    ];
    gitStatusClean = false;
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    await tools.findByText("src/App.tsx");
    fireEvent.click(tools.getByRole("tab", { name: "History" }));

    expect((await tools.findAllByText("Root commit")).length).toBeGreaterThan(
      0,
    );
    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (new URL(call.url).pathname !== "/v1/git/diff") return false;
          const body = JSON.parse(String(call.init?.body ?? "{}"));
          return (
            body.mode === "commit" &&
            body.path === "README.md" &&
            body.oldRef === GIT_EMPTY_TREE_SHA &&
            body.newRef === "root123"
          );
        }),
      ).toBe(true),
    );
  });

  it("uses oldPath when diffing renamed history files", async () => {
    gitHistoryCommits = [
      {
        sha: "rename123",
        parents: ["parent123"],
        authorName: "Test User",
        committerName: "Test User",
        summary: "Rename file",
        refs: [],
        files: [
          {
            path: "src/New.tsx",
            oldPath: "src/Old.tsx",
            status: "renamed",
            staged: false,
          },
        ],
      },
    ];
    gitStatusClean = false;
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    await tools.findByText("src/App.tsx");
    fireEvent.click(tools.getByRole("tab", { name: "History" }));

    expect((await tools.findAllByText("Rename file")).length).toBeGreaterThan(
      0,
    );
    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (new URL(call.url).pathname !== "/v1/git/diff") return false;
          const body = JSON.parse(String(call.init?.body ?? "{}"));
          return (
            body.mode === "commit" &&
            body.path === "src/New.tsx" &&
            body.oldPath === "src/Old.tsx" &&
            body.oldRef === "parent123" &&
            body.newRef === "rename123"
          );
        }),
      ).toBe(true),
    );
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
    expect(
      await tools.findByText("Working tree is clean."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        toolsPanel.querySelector(".git-surface .git-diff-pane h3"),
      ).toHaveTextContent("No file selected"),
    );
  });

  it("surfaces Git status reload failures after jobs", async () => {
    gitStatusClean = false;
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

    failNextGitStatus = true;
    fireEvent.click(tools.getByLabelText("File actions"));
    fireEvent.click(tools.getByRole("button", { name: "Stage" }));

    expect(await tools.findByText("Git status failed")).toBeInTheDocument();
    expect(await tools.findByText(/status_failed/)).toBeInTheDocument();
  });

  it("keeps non-git status failures inline without a global notification", async () => {
    failNonGitStatus = true;
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));

    expect(
      await tools.findByText("This project is not a Git repository."),
    ).toBeInTheDocument();
    expect(
      await tools.findByText("This directory is not a Git repository."),
    ).toBeInTheDocument();
    expect(
      tools.getByRole("button", { name: "Init repository" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Dismiss notification: Git status failed",
      }),
    ).not.toBeInTheDocument();
  });

  it("ignores stale Git status refresh responses after switching context", async () => {
    remoteSessionExecutionMode = "managed_worktree";
    remoteSessionExecutionFolder = "/workspace/.roamcli-worktrees/session-1";
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    expect(
      await tools.findByText("Working tree is clean."),
    ).toBeInTheDocument();

    const staleWorktreeStatus = deferred<Response>();
    deferredGitStatus.set("session:session-1", staleWorktreeStatus);
    fireEvent.click(tools.getByRole("button", { name: "Refresh Git" }));
    fireEvent.change(tools.getByRole("combobox"), {
      target: { value: "project:project-1" },
    });

    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (new URL(call.url).pathname !== "/v1/git/status") return false;
          const body = JSON.parse(String(call.init?.body ?? "{}"));
          return body.kind === "project" && body.projectId === "project-1";
        }),
      ).toBe(true),
    );
    expect(
      await tools.findByText("Working tree is clean."),
    ).toBeInTheDocument();

    await act(async () => {
      staleWorktreeStatus.resolve(
        jsonResponse({
          result: gitStatusPayload(
            { kind: "session_worktree", sessionId: "session-1" },
            false,
            [{ path: "src/Stale.tsx", status: "modified", staged: false }],
          ),
        }),
      );
    });

    expect(tools.queryByText("src/Stale.tsx")).not.toBeInTheDocument();
    expect(tools.getByText("Working tree is clean.")).toBeInTheDocument();
  });

  it("ignores stale Git history load-more responses after switching context", async () => {
    remoteSessionExecutionMode = "managed_worktree";
    remoteSessionExecutionFolder = "/workspace/.roamcli-worktrees/session-1";
    gitHistoryCommits = [
      {
        sha: "session123",
        parents: ["parent123"],
        authorName: "Test User",
        committerName: "Test User",
        summary: "Session commit",
        refs: [],
        files: [
          {
            path: "src/App.tsx",
            status: "modified",
            staged: false,
          },
        ],
      },
    ];
    gitHistoryNextCursor = "cursor-2";
    const staleHistoryPage = deferred<Response>();
    deferredGitHistory.set("cursor-2", staleHistoryPage);
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    expect(
      await tools.findByText("Working tree is clean."),
    ).toBeInTheDocument();
    fireEvent.click(tools.getByRole("tab", { name: "History" }));
    expect(
      (await tools.findAllByText("Session commit")).length,
    ).toBeGreaterThan(0);

    fireEvent.click(tools.getByRole("button", { name: "Load more" }));
    gitHistoryCommits = [
      {
        sha: "project123",
        parents: ["parent456"],
        authorName: "Test User",
        committerName: "Test User",
        summary: "Project commit",
        refs: [],
        files: [
          {
            path: "src/App.tsx",
            status: "modified",
            staged: false,
          },
        ],
      },
    ];
    gitHistoryNextCursor = undefined;
    fireEvent.change(tools.getByRole("combobox"), {
      target: { value: "project:project-1" },
    });

    expect(
      (await tools.findAllByText("Project commit")).length,
    ).toBeGreaterThan(0);

    await act(async () => {
      staleHistoryPage.resolve(
        jsonResponse({
          result: {
            requestId: "git-history-stale",
            context: { kind: "session_worktree", sessionId: "session-1" },
            commits: [
              {
                sha: "stale123",
                parents: ["parent123"],
                authorName: "Test User",
                committerName: "Test User",
                summary: "Stale commit",
                refs: [],
                files: [
                  {
                    path: "src/Stale.tsx",
                    status: "modified",
                    staged: false,
                  },
                ],
              },
            ],
          },
        }),
      );
    });

    expect(tools.queryByText("Stale commit")).not.toBeInTheDocument();
    expect(tools.getAllByText("Project commit").length).toBeGreaterThan(0);
  });

  it("ignores stale Git diff responses after changing selected file", async () => {
    gitStatusClean = false;
    gitStatusChanges = [
      {
        path: "src/App.tsx",
        status: "modified",
        staged: false,
      },
      {
        path: "src/Slow.tsx",
        status: "modified",
        staged: false,
      },
    ];
    const appDiff = deferred<Response>();
    const slowDiff = deferred<Response>();
    deferredGitDiff.set("working_tree:src/App.tsx", appDiff);
    deferredGitDiff.set("working_tree:src/Slow.tsx", slowDiff);
    render(<App />);
    await screen.findByText("Loaded from API");

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    fireEvent.click(tools.getByRole("button", { name: "Git" }));
    await tools.findByText("src/App.tsx");
    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (new URL(call.url).pathname !== "/v1/git/diff") return false;
          const body = JSON.parse(String(call.init?.body ?? "{}"));
          return body.path === "src/App.tsx";
        }),
      ).toBe(true),
    );

    fireEvent.click(tools.getByRole("button", { name: "src/Slow.tsx" }));
    await waitFor(() =>
      expect(
        fetchCalls.some((call) => {
          if (new URL(call.url).pathname !== "/v1/git/diff") return false;
          const body = JSON.parse(String(call.init?.body ?? "{}"));
          return body.path === "src/Slow.tsx";
        }),
      ).toBe(true),
    );

    await act(async () => {
      slowDiff.resolve(
        jsonResponse({
          result: {
            requestId: "git-diff-slow",
            context: { kind: "project", projectId: "project-1" },
            path: "src/Slow.tsx",
            mode: "working_tree",
            oldContent: "",
            newContent: "Current slow diff",
            language: "typescript",
            binary: false,
            tooLarge: false,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId("monaco-diff-editor")).toHaveAttribute(
        "data-modified",
        "Current slow diff",
      ),
    );

    await act(async () => {
      appDiff.resolve(
        jsonResponse({
          result: {
            requestId: "git-diff-app",
            context: { kind: "project", projectId: "project-1" },
            path: "src/App.tsx",
            mode: "working_tree",
            oldContent: "",
            newContent: "Stale app diff",
            language: "typescript",
            binary: false,
            tooLarge: false,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId("monaco-diff-editor")).toHaveAttribute(
        "data-modified",
        "Current slow diff",
      ),
    );
  });

  it("renames the selected session", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    fireEvent.click(
      openSessionActions().getByRole("menuitem", { name: /Rename/ }),
    );

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

    fireEvent.click(
      openSessionActions().getByRole("menuitem", { name: /Rename/ }),
    );

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
        const authResponse = authMockResponse(requestUrl.pathname, init);
        if (authResponse) {
          return authResponse;
        }
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
    fireEvent.click(await findSessionFile(/App\.tsx/));
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

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const messageCall = fetchCalls.find(
        (call) =>
          new URL(call.url).pathname === "/v1/sessions/session-1/messages",
      );
      expect(JSON.parse(String(messageCall?.init?.body ?? "{}"))).toMatchObject(
        {
          content: "draft before reconnect",
          attachments: [],
        },
      );
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
      mobileTabs.getByRole("button", { name: "Chat" }),
    ).toBeInTheDocument();
    expect(
      mobileTabs.getByRole("button", { name: "Files" }),
    ).toBeInTheDocument();
    expect(
      mobileTabs.getByRole("button", { name: "Approvals" }),
    ).toBeInTheDocument();
  });

  it("does not add session switching to mobile workspace tabs", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    const mobileTabs = within(
      screen.getByRole("navigation", { name: "Mobile tabs" }),
    );
    fireEvent.click(mobileTabs.getByRole("button", { name: "Approvals" }));

    const tools = within(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    );
    expect(
      tools.queryByRole("button", { name: /Switch Session/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Switch Session" }),
    ).not.toBeInTheDocument();
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
    expect(
      await within(dialog).findByDisplayValue("/workspace"),
    ).toBeInTheDocument();
    fireEvent.change(await within(dialog).findByLabelText("Prompt"), {
      target: { value: "Run the focused task" },
    });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Create session" }),
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
      await within(sessionDialog).findByRole("button", {
        name: "Create session",
      }),
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
    fireEvent.click(within(projectDialog).getByLabelText("Directory"));
    const directoryDialog = await screen.findByRole("dialog", {
      name: "Choose directory",
    });
    fireEvent.change(
      within(directoryDialog).getByLabelText("New folder name"),
      {
        target: { value: "../outside" },
      },
    );
    fireEvent.click(
      within(directoryDialog).getByRole("button", { name: "New folder" }),
    );
    expect(within(directoryDialog).getByRole("alert")).toHaveTextContent(
      "Folder name must be a single directory name.",
    );
    expect(
      fetchCalls.some(
        (call) =>
          call.url.endsWith("/v1/runners/real-runner/directories") &&
          call.init?.method === "POST",
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
    fireEvent.change(await within(sessionDialog).findByLabelText("Title"), {
      target: { value: "Keep this title" },
    });
    fireEvent.change(await within(sessionDialog).findByLabelText("Prompt"), {
      target: { value: "Keep this prompt after failure" },
    });
    fireEvent.click(
      await within(sessionDialog).findByRole("button", {
        name: "Create session",
      }),
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
    expect(within(projectDialog).getByLabelText("Directory")).toHaveTextContent(
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
    let sessionSwitcher = openSessionSwitcher();

    fireEvent.click(
      sessionSwitcher.getByRole("button", {
        name: "New session in selected project Real Project",
      }),
    );
    const sessionDialog = screen.getByRole("dialog", {
      name: "New Session - Real Project",
    });
    fireEvent.change(await within(sessionDialog).findByLabelText("Prompt"), {
      target: { value: "Run from the mobile controls" },
    });
    fireEvent.click(
      await within(sessionDialog).findByRole("button", {
        name: "Create session",
      }),
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
    fireEvent.click(within(projectDialog).getByLabelText("Directory"));
    const directoryDialog = await screen.findByRole("dialog", {
      name: "Choose directory",
    });
    fireEvent.click(await screen.findByRole("treeitem", { name: /mobile/ }));
    fireEvent.click(
      within(directoryDialog).getByRole("button", { name: "Choose" }),
    );
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

  it("falls back to a remaining mobile project after archiving the selected project", async () => {
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
      expect(sessionSwitcher.getByLabelText("Project")).toHaveValue(
        "project-backup",
      ),
    );
    expect(sessionSwitcher.getByLabelText("Project")).toHaveDisplayValue(
      "Backup Project",
    );
    expect(
      sessionSwitcher.getByRole("button", {
        name: "New session in selected project Backup Project",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Create a session in the selected project.").length,
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

  it("selects the owning project when a session from another project is clicked", async () => {
    const backupSession = {
      ...session,
      id: "session-backup",
      title: "Backup session",
      projectId: backupProject.id,
      runnerId: backupRunner.runnerId,
      executionFolder: "/backup-workspace",
      cwd: "/backup-workspace",
    };
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
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "session:created",
            session: backupSession,
          }),
        }),
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Expand project Backup Project" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Backup session/ }));

    expect(
      screen.getByRole("button", { name: "Switch Session: Backup session" }),
    ).toBeInTheDocument();

    const sessionSwitcher = openSessionSwitcher(/Backup session/);
    expect(sessionSwitcher.getByLabelText("Project")).toHaveValue(
      "project-backup",
    );
  });

  it("loads the selected session file tree and displays real file content", async () => {
    render(<App />);

    const fileButton = await findSessionFile(/App\.tsx/);
    expect(
      fetchRequests.some((url) => isSessionFileTreeRequest(url, ".")),
    ).toBe(true);
    expect(
      fetchRequests.some((url) => isSessionFileTreeRequest(url, "src")),
    ).toBe(true);

    fireEvent.click(fileButton);

    const editor = await screen.findByRole("textbox", {
      name: "Edit src/App.tsx",
    });
    expect(editor).toHaveValue(
      "export function RealContent() { return null; }",
    );
    expect(editor).toHaveClass("monaco-file-editor");
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

  it("resets expanded directories after refreshing the root file tree", async () => {
    render(<App />);

    await findSessionFile(/App\.tsx/);
    const srcRequestsBeforeRefresh = fetchRequests.filter((url) =>
      isSessionFileTreeRequest(url, "src"),
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh file tree" }));

    await waitFor(() => {
      expect(screen.getByRole("treeitem", { name: /src/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    fireEvent.click(screen.getByRole("treeitem", { name: /src/ }));
    expect(
      await screen.findByRole("treeitem", { name: /App\.tsx/ }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        fetchRequests.filter((url) => isSessionFileTreeRequest(url, "src"))
          .length,
      ).toBe(srcRequestsBeforeRefresh + 1);
    });
  });

  it("renders image files as image previews", async () => {
    render(<App />);

    fireEvent.click(await findSessionFile(/logo\.png/));

    const image = await screen.findByRole("img", {
      name: "Preview src/logo.png",
    });
    expect(image).toHaveAttribute(
      "src",
      "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
    );
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Edit src/logo.png" }),
    ).not.toBeInTheDocument();
  });

  it("opens runner-local markdown file links in the file panel", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "message:created",
            message: {
              id: "message-runner-local-link",
              sessionId: "session-1",
              role: "assistant",
              content: "Open [App](/workspace/src/App.tsx:7).",
              encrypted: false,
              createdAt: new Date(Date.now() + 1000).toISOString(),
            },
          }),
        }),
      );
    });

    const conversation = screen.getByRole("region", { name: "Conversation" });
    fireEvent.click(
      await within(conversation).findByRole("button", { name: "App" }),
    );

    const editor = await screen.findByRole("textbox", {
      name: "Edit src/App.tsx",
    });
    expect(editor).toHaveValue(
      "export function RealContent() { return null; }",
    );
    const contentUrl = fetchRequests.find((url) =>
      url.includes("/v1/sessions/session-1/files/content"),
    );
    expect(new URL(contentUrl ?? "").searchParams.get("path")).toBe(
      "src/App.tsx",
    );
  });

  it("refreshes the nearest visible parent after saving a linked deep file", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");
    await screen.findByRole("treeitem", { name: /src/ });

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "message:created",
            message: {
              id: "message-deep-file-link",
              sessionId: "session-1",
              role: "assistant",
              content: "Open [Button](/workspace/src/components/Button.tsx).",
              encrypted: false,
              createdAt: new Date(Date.now() + 1000).toISOString(),
            },
          }),
        }),
      );
    });

    const conversation = screen.getByRole("region", { name: "Conversation" });
    fireEvent.click(
      await within(conversation).findByRole("button", { name: "Button" }),
    );
    const editor = await screen.findByRole("textbox", {
      name: "Edit src/components/Button.tsx",
    });
    fireEvent.change(editor, {
      target: { value: "export const button = true;\n" },
    });

    const requestCountBeforeSave = fetchRequests.length;
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const refreshedFileTreePaths = fetchRequests
      .slice(requestCountBeforeSave)
      .filter((url) => new URL(url).pathname === "/v1/sessions/session-1/files")
      .map((url) => new URL(url).searchParams.get("path"));
    expect(refreshedFileTreePaths).toContain("src");
    expect(refreshedFileTreePaths).not.toContain("src/components");
  });

  it("keeps the currently selected file when an older file response finishes later", async () => {
    const slowContent = deferred<Response>();
    const fastContent = deferred<Response>();
    deferredFileContent.set("src/Slow.tsx", slowContent);
    deferredFileContent.set("src/Fast.tsx", fastContent);
    render(<App />);

    fireEvent.click(await findSessionFile(/Slow\.tsx/));
    fireEvent.click(await findSessionFile(/Fast\.tsx/));

    fastContent.resolve(
      jsonResponse({
        result: {
          requestId: "fast-content",
          sessionId: "session-1",
          path: "src/Fast.tsx",
          kind: "text",
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
          kind: "text",
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

    fireEvent.click(await findSessionFile(/App\.tsx/));
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

    const approvalCard = screen
      .getByText("Apply generated patch")
      .closest("article");
    expect(approvalCard).not.toBeNull();
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
      strip: number;
    };
    expect(body.patch).toContain("diff --git a/src/App.tsx b/src/App.tsx");
    expect(body.patch).toContain("@@ -1 +1 @@");
    expect(body.strip).toBe(1);
    expect(Object.keys(body)).toEqual(["patch", "strip"]);
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
    const approvalCall = fetchCalls.find((call) =>
      call.url.includes("/v1/approvals/approval-1"),
    );
    expect(approvalCall?.init?.method).toBe("POST");
  });

  it("refreshes the nearest visible parent after patching a new nested directory", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");
    await screen.findByRole("treeitem", { name: /src/ });

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "approval:requested",
            approval: {
              ...patchApproval,
              id: "approval-new-dir",
              payload: {
                hunks: [
                  {
                    ...patchHunk,
                    id: "hunk-new-dir",
                    filePath: "src/new/file.ts",
                  },
                ],
              },
            },
          }),
        }),
      );
    });

    const patchCard = await screen
      .findByText("src/new/file.ts")
      .then((element) => element.closest("article"));
    expect(patchCard).not.toBeNull();
    fireEvent.click(
      within(patchCard as HTMLElement).getByRole("button", {
        name: "Accept patch hunk hunk-new-dir",
      }),
    );

    await waitFor(() =>
      expect(
        within(patchCard as HTMLElement).getByText("accepted"),
      ).toBeInTheDocument(),
    );
    const requestCountBeforeApply = fetchRequests.length;
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));

    const refreshedFileTreePaths = () =>
      fetchRequests
        .slice(requestCountBeforeApply)
        .filter(
          (url) => new URL(url).pathname === "/v1/sessions/session-1/files",
        )
        .map((url) => new URL(url).searchParams.get("path"));
    await waitFor(() => {
      expect(refreshedFileTreePaths()).toContain("src");
    });
    expect(refreshedFileTreePaths()).not.toContain("src/new");
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
      within(conversation).queryByText("Intermediate output (2)"),
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

    const intermediate = await within(conversation).findByText(
      "Intermediate output (2)",
    );
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

    fireEvent.click(
      openSessionActions().getByRole("menuitem", { name: /Delete/ }),
    );

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
