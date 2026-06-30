// @vitest-environment jsdom
import "../test/setup.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  Project,
  ProjectPromptPreset,
  Session,
} from "@roamcli/shared/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoamController } from "./useRoamController";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class TestWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = TestWebSocket.OPEN;
  readonly sent: string[] = [];

  constructor(readonly url: URL) {
    super();
    testSockets.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = TestWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

let testSockets: TestWebSocket[] = [];

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

function preset(id: string, order: number): ProjectPromptPreset {
  return {
    id,
    projectId: "project-1",
    title: id,
    content: `${id} content`,
    order,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
}

describe("useRoamController prompt presets", () => {
  let reorderResponses: Array<Deferred<Response>>;
  let reorderBodies: string[][];
  let promptPresetFetchResponses: Array<Deferred<Response>>;
  let projectSummaries: Project[];
  let sessionSummaries: Session[];
  let sessionDetails: Map<string, unknown>;

  beforeEach(() => {
    reorderResponses = [];
    reorderBodies = [];
    promptPresetFetchResponses = [];
    projectSummaries = [];
    sessionSummaries = [];
    sessionDetails = new Map();
    testSockets = [];
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = new URL(String(input));
        if (requestUrl.pathname === "/v1/auth/status") {
          return jsonResponse({
            auth: { status: "authenticated", session: authSession },
          });
        }
        if (requestUrl.pathname === "/v1/auth/account") {
          return jsonResponse({ account: accountSecurity });
        }
        if (requestUrl.pathname === "/v1/runners") {
          return jsonResponse({ runners: [] });
        }
        if (requestUrl.pathname === "/v1/projects") {
          return jsonResponse({ projects: projectSummaries });
        }
        if (requestUrl.pathname === "/v1/sessions") {
          return jsonResponse({ sessions: sessionSummaries });
        }
        if (requestUrl.pathname.startsWith("/v1/sessions/")) {
          const sessionId = decodeURIComponent(
            requestUrl.pathname.replace("/v1/sessions/", ""),
          );
          return jsonResponse(
            sessionDetails.get(sessionId) ?? { error: "not found" },
            sessionDetails.has(sessionId) ? 200 : 404,
          );
        }
        if (requestUrl.pathname === "/v1/projects/project-1/prompt-presets") {
          if (init?.method === "POST") {
            return jsonResponse({ preset: preset("preset-created", 0) });
          }
          const response = promptPresetFetchResponses.shift();
          if (response) {
            return response.promise;
          }
          return jsonResponse({ presets: [] });
        }
        if (
          requestUrl.pathname ===
          "/v1/projects/project-1/prompt-presets/order"
        ) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            presetIds?: string[];
          };
          reorderBodies.push(body.presetIds ?? []);
          const response = reorderResponses.shift();
          if (response) {
            return response.promise;
          }
          return jsonResponse({
            presets: (body.presetIds ?? []).map((id, index) =>
              preset(id, index),
            ),
          });
        }
        return jsonResponse({ error: "not found" }, 404);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes prompt preset reorder requests per project", async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    reorderResponses.push(firstResponse, secondResponse);
    const { result } = renderHook(() => useRoamController());

    let firstReorder!: Promise<ProjectPromptPreset[]>;
    act(() => {
      firstReorder = result.current.reorderProjectPromptPresets("project-1", [
        "preset-2",
        "preset-1",
      ]);
    });
    await waitFor(() => expect(reorderBodies).toHaveLength(1));

    let secondReorder!: Promise<ProjectPromptPreset[]>;
    act(() => {
      secondReorder = result.current.reorderProjectPromptPresets("project-1", [
        "preset-1",
        "preset-2",
      ]);
    });
    await Promise.resolve();
    expect(reorderBodies).toEqual([["preset-2", "preset-1"]]);

    await act(async () => {
      firstResponse.resolve(
        jsonResponse({
          presets: [preset("preset-2", 0), preset("preset-1", 1)],
        }),
      );
      await firstReorder;
    });
    await waitFor(() =>
      expect(reorderBodies).toEqual([
        ["preset-2", "preset-1"],
        ["preset-1", "preset-2"],
      ]),
    );

    await act(async () => {
      secondResponse.resolve(
        jsonResponse({
          presets: [preset("preset-1", 0), preset("preset-2", 1)],
        }),
      );
      await secondReorder;
    });
  });

  it("records post-mutation prompt preset refresh failures", async () => {
    const refreshFailure = deferred<Response>();
    promptPresetFetchResponses.push(refreshFailure);
    const { result } = renderHook(() => useRoamController());

    await act(async () => {
      await result.current.createProjectPromptPreset("project-1", {
        title: "Created preset",
        content: "Created content",
      });
    });
    expect(
      result.current.projectPromptPresetErrorsByProject["project-1"],
    ).toBeUndefined();

    await act(async () => {
      refreshFailure.resolve(
        jsonResponse({ message: "refresh unavailable" }, 503),
      );
      await refreshFailure.promise;
    });

    await waitFor(() =>
      expect(
        result.current.projectPromptPresetErrorsByProject["project-1"],
      ).toMatch(/refresh unavailable/),
    );
  });

  it("subscribes to the selected session and lazy-loads its detail", async () => {
    projectSummaries = [
      {
        id: "project-1",
        name: "Project One",
        runnerId: "runner-1",
        directory: "/workspace",
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
        lastActiveAt: "2026-06-05T00:00:00.000Z",
      },
    ];
    sessionSummaries = [
      {
        id: "session-1",
        title: "Lazy session",
        projectId: "project-1",
        runnerId: "runner-1",
        agent: "codex",
        status: "completed",
        executionMode: "direct",
        executionFolder: ".",
        cwd: ".",
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
      },
    ];
    sessionDetails.set("session-1", {
      session: sessionSummaries[0],
      messages: [
        {
          id: "message-1",
          sessionId: "session-1",
          role: "assistant",
          content: "Loaded lazily",
          encrypted: false,
          createdAt: "2026-06-05T00:00:01.000Z",
        },
      ],
      attachments: [],
      approvals: [],
      artifacts: [],
    });
    const { result } = renderHook(() => useRoamController());

    await waitFor(() =>
      expect(result.current.selectedSession?.id).toBe("session-1"),
    );
    await waitFor(() =>
      expect(
        result.current.sessionMessages.some(
          (message) => message.content === "Loaded lazily",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        testSockets.some((socket) =>
          socket.sent.some((payload) =>
            payload.includes('"type":"activeSessionChanged"') &&
            payload.includes('"sessionId":"session-1"'),
          ),
        ),
      ).toBe(true),
    );
  });
});
