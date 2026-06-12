import type { Project, RunnerRegistration, ServerEvent, Session } from "@roamcli/protocol";
import { describe, expect, it } from "vitest";
import { appReducer, initialAppState, type AppState } from "./state";

describe("app reducer", () => {
  it("bootstraps a selected session from the selected project only", () => {
    const projects: Project[] = [
      makeProject("project-1"),
      makeProject("project-2"),
    ];
    const sessions: Session[] = [
      makeSession("session-2", "project-2"),
      makeSession("session-1", "project-1"),
    ];

    const next = appReducer(
      {
        ...initialAppState,
        selectedProjectId: "project-1",
        selectedSessionId: "session-2",
      },
      {
        type: "bootstrapSucceeded",
        remote: {
          projects,
          runners: [runner],
          sessions,
          messages: [],
          approvals: [],
          artifacts: [],
        },
      },
    );

    expect(next.selectedProjectId).toBe("project-1");
    expect(next.selectedSessionId).toBe("session-1");
  });

  it("applies message and terminal server events", () => {
    const withMessage = appReducer(initialAppState, {
      type: "serverEventReceived",
      event: {
        type: "message:created",
        message: {
          id: "message-1",
          sessionId: "session-1",
          role: "user",
          content: "hello",
          encrypted: false,
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      },
    });
    const withTerminal = appReducer(withMessage, {
      type: "serverEventReceived",
      event: {
        type: "terminal:data",
        sessionId: "session-1",
        chunk: "\u001b[32mok\u001b[0m",
      },
    });

    expect(withTerminal.messages).toHaveLength(1);
    expect(withTerminal.terminalLines["session-1"]).toEqual(["ok"]);
  });

  it("cleans session-owned state when a session is deleted", () => {
    const state: AppState = {
      ...initialAppState,
      selectedSessionId: "session-1",
      messages: [
        {
          id: "message-1",
          sessionId: "session-1",
          role: "assistant",
          content: "hello",
          encrypted: false,
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      ],
      filesBySession: { "session-1": [] },
      fileTreeState: { "session-1": "ready" as const },
      terminalLines: { "session-1": ["ok"] },
    };

    const next = appReducer(state, {
      type: "sessionDeleted",
      sessionId: "session-1",
    });

    expect(next.selectedSessionId).toBe("");
    expect(next.messages).toEqual([]);
    expect(next.filesBySession).toEqual({});
    expect(next.fileTreeState).toEqual({});
    expect(next.terminalLines).toEqual({});
  });

  it("clears the current selection when the selected project is archived", () => {
    const next = appReducer(
      {
        ...initialAppState,
        projects: [makeProject("project-1"), makeProject("project-2")],
        sessions: [
          makeSession("session-1", "project-1"),
          makeSession("session-2", "project-2"),
        ],
        selectedProjectId: "project-1",
        selectedSessionId: "session-1",
      },
      {
        type: "projectUpdated",
        project: {
          ...makeProject("project-1"),
          archivedAt: "2026-06-05T01:00:00.000Z",
        },
      },
    );

    expect(next.projects.map((project) => project.id)).toEqual(["project-2"]);
    expect(next.selectedProjectId).toBe("");
    expect(next.selectedSessionId).toBe("");
  });

  it("does not auto-select another project when an archive event is replayed", () => {
    const state: AppState = {
      ...initialAppState,
      projects: [makeProject("project-2")],
      sessions: [makeSession("session-2", "project-2")],
      selectedProjectId: "",
      selectedSessionId: "",
    };

    const next = appReducer(state, {
      type: "projectUpdated",
      project: {
        ...makeProject("project-1"),
        archivedAt: "2026-06-05T01:00:00.000Z",
      },
    });

    expect(next.projects.map((project) => project.id)).toEqual(["project-2"]);
    expect(next.selectedProjectId).toBe("");
    expect(next.selectedSessionId).toBe("");
  });

  it("updates selected file content only for the active session and path", () => {
    const event: ServerEvent = {
      type: "file:content",
      result: {
        requestId: "file-content-1",
        sessionId: "session-1",
        path: "src/App.tsx",
        content: "export const value = true;",
        truncated: false,
        encoding: "utf8",
      },
    };
    const next = appReducer(
      {
        ...initialAppState,
        selectedSessionId: "session-1",
        selectedFilePath: "src/App.tsx",
      },
      { type: "serverEventReceived", event },
    );

    expect(next.fileContent?.content).toBe("export const value = true;");
    expect(next.editorContent).toBe("export const value = true;");
    expect(next.fileContentState).toBe("ready");
  });

  it("ignores stale async file content loads", () => {
    const next = appReducer(
      {
        ...initialAppState,
        selectedSessionId: "session-1",
        selectedFilePath: "src/Fast.tsx",
        fileContentState: "loading",
      },
      {
        type: "fileContentLoaded",
        result: {
          requestId: "file-content-1",
          sessionId: "session-1",
          path: "src/Slow.tsx",
          content: "export const slow = true;",
          truncated: false,
          encoding: "utf8",
        },
      },
    );

    expect(next.fileContent).toBeUndefined();
    expect(next.editorContent).toBe("");
    expect(next.fileContentState).toBe("loading");
  });
});

const runner: RunnerRegistration = {
  runnerId: "runner-1",
  displayName: "Runner One",
  hostname: "devbox.local",
  workspaceRoot: "/workspace",
  profile: "trusted",
  publicKey: "0123456789abcdef",
  capabilities: [],
  version: "1.1.0",
};

function makeProject(id: string): Project {
  return {
    id,
    name: id,
    runnerId: "runner-1",
    directory: `/workspace/${id}`,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    lastActiveAt: "2026-06-05T00:00:00.000Z",
  };
}

function makeSession(id: string, projectId: string): Session {
  return {
    id,
    title: id,
    projectId,
    runnerId: "runner-1",
    agent: "codex",
    status: "completed",
    executionMode: "direct",
    executionFolder: `/workspace/${projectId}`,
    cwd: `/workspace/${projectId}`,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
}
