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

const session = {
  id: "session-1",
  title: "Real session",
  runnerId: "real-runner",
  agent: "codex",
  status: "running",
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
  static OPEN = 1;
  readonly readyState = TestWebSocket.OPEN;
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
}

describe("App", () => {
  let fetchRequests: string[];
  let fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  let deferredFileContent: Map<string, Deferred<Response>>;

  beforeEach(() => {
    fetchRequests = [];
    fetchCalls = [];
    deferredFileContent = new Map();
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

    expect(await screen.findAllByText("Real Runner")).toHaveLength(2);
    expect(screen.getAllByText("Real session").length).toBeGreaterThan(0);
    expect(screen.getByText("Loaded from API")).toBeInTheDocument();
    expect(screen.getByText("changes.patch")).toBeInTheDocument();
    expect(
      screen.getByText(/artifacts\/session-1\/changes.patch/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Mobile tabs" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Runners and sessions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Conversation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Workspace tools" }),
    ).toBeInTheDocument();
  });

  it("exposes mobile parity tabs when real state is loaded", async () => {
    render(<App />);
    await screen.findAllByText("Real Runner");
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

  it("shows the active fallback runner after the selected runner goes offline", async () => {
    render(<App />);
    await screen.findByText("Loaded from API");

    act(() => {
      sockets[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "runner:online", runner: backupRunner }),
        }),
      );
    });

    const mobileControls = within(
      screen.getByRole("region", { name: "Mobile runner controls" }),
    );
    fireEvent.change(mobileControls.getByLabelText("Runner"), {
      target: { value: "backup-runner" },
    });
    expect(mobileControls.getByLabelText("Runner")).toHaveValue(
      "backup-runner",
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

    expect(mobileControls.getByLabelText("Runner")).toHaveValue("real-runner");
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
      screen.getByText("Create a session on the selected runner."),
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
