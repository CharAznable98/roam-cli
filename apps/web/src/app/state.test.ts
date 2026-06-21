import type {
  Approval,
  FileNode,
  Project,
  RunnerRegistration,
  ServerEvent,
  Session,
} from "@roamcli/shared/protocol";
import { describe, expect, it } from "vitest";
import type { SessionPatchHunk } from "../features/approvals/model";
import { appReducer, initialAppState, type AppState } from "./state";

describe("app reducer", () => {
  it("bootstraps a previous project and session selection when both are active", () => {
    const projects: Project[] = [
      makeProject("project-1"),
      makeProject("project-2"),
    ];
    const sessions: Session[] = [
      makeSession("session-1", "project-1"),
      makeSession("session-2", "project-2"),
    ];

    const next = appReducer(
      {
        ...initialAppState,
        selectedProjectId: "project-2",
        selectedSessionId: "session-2",
      },
      {
        type: "bootstrapSucceeded",
        remote: {
          projects,
          runners: [runner],
          sessions,
          messages: [],
          messageAttachments: [],
          approvals: [],
          artifacts: [],
        },
      },
    );

    expect(next.selectedProjectId).toBe("project-2");
    expect(next.selectedSessionId).toBe("session-2");
  });

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
          messageAttachments: [],
          approvals: [],
          artifacts: [],
        },
      },
    );

    expect(next.selectedProjectId).toBe("project-1");
    expect(next.selectedSessionId).toBe("session-1");
  });

  it("falls back to the default project when the previous project is archived", () => {
    const projects: Project[] = [
      { ...makeProject("project-1"), archivedAt: "2026-06-05T01:00:00.000Z" },
      makeProject("project-2"),
    ];
    const sessions: Session[] = [
      makeSession("session-1", "project-1"),
      makeSession("session-2", "project-2"),
    ];

    const next = appReducer(
      {
        ...initialAppState,
        selectedProjectId: "project-1",
        selectedSessionId: "session-1",
      },
      {
        type: "bootstrapSucceeded",
        remote: {
          projects,
          runners: [runner],
          sessions,
          messages: [],
          messageAttachments: [],
          approvals: [],
          artifacts: [],
        },
      },
    );

    expect(next.selectedProjectId).toBe("project-2");
    expect(next.selectedSessionId).toBe("session-2");
  });

  it("falls back to the default valid session when the previous session is missing", () => {
    const projects: Project[] = [
      makeProject("project-1"),
      makeProject("project-2"),
    ];
    const sessions: Session[] = [makeSession("session-2", "project-2")];

    const next = appReducer(
      {
        ...initialAppState,
        selectedProjectId: "project-1",
        selectedSessionId: "session-1",
      },
      {
        type: "bootstrapSucceeded",
        remote: {
          projects,
          runners: [runner],
          sessions,
          messages: [],
          messageAttachments: [],
          approvals: [],
          artifacts: [],
        },
      },
    );

    expect(next.selectedProjectId).toBe("project-2");
    expect(next.selectedSessionId).toBe("session-2");
  });

  it("prefers an online runner project when no previous project is selected", () => {
    const projects: Project[] = [
      makeProject("offline-project", "offline-runner"),
      makeProject("online-project", "runner-1"),
    ];
    const sessions: Session[] = [
      makeSession("offline-session", "offline-project", "offline-runner"),
      makeSession("online-session", "online-project", "runner-1"),
    ];

    const next = appReducer(initialAppState, {
      type: "bootstrapSucceeded",
      remote: {
        projects,
        runners: [runner],
        sessions,
        messages: [],
        messageAttachments: [],
        approvals: [],
        artifacts: [],
      },
    });

    expect(next.selectedProjectId).toBe("online-project");
    expect(next.selectedSessionId).toBe("online-session");
    expect(next.selectedRunnerId).toBe("runner-1");
  });

  it("selects the session project when switching directly to a session", () => {
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
      { type: "sessionSelected", sessionId: "session-2" },
    );

    expect(next.selectedProjectId).toBe("project-2");
    expect(next.selectedSessionId).toBe("session-2");
  });

  it("ignores direct switches to archived sessions", () => {
    const next = appReducer(
      {
        ...initialAppState,
        projects: [makeProject("project-1"), makeProject("project-2")],
        sessions: [
          makeSession("session-1", "project-1"),
          {
            ...makeSession("session-2", "project-2"),
            archivedAt: "2026-06-05T01:00:00.000Z",
          },
        ],
        selectedProjectId: "project-1",
        selectedSessionId: "session-1",
      },
      { type: "sessionSelected", sessionId: "session-2" },
    );

    expect(next.selectedProjectId).toBe("project-1");
    expect(next.selectedSessionId).toBe("session-1");
  });

  it("applies message server events", () => {
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

    expect(withMessage.messages).toHaveLength(1);
  });

  it("reconciles client stream placeholders when merging persisted session details", () => {
    const next = appReducer(
      {
        ...initialAppState,
        messages: [
          {
            id: "stream-session-1-100-0",
            sessionId: "session-1",
            role: "assistant",
            content: "partial answer with newer token",
            encrypted: false,
            createdAt: "2026-06-05T00:00:01.000Z",
          },
        ],
      },
      {
        type: "sessionDetailMerged",
        detail: {
          session: {
            ...makeSession("session-1", "project-1"),
            status: "running",
          },
          messages: [
            {
              id: "stream_session-1_100",
              sessionId: "session-1",
              role: "assistant",
              content: "partial answer",
              encrypted: false,
              createdAt: "2026-06-05T00:00:01.000Z",
            },
          ],
          attachments: [],
          approvals: [],
          artifacts: [],
        },
      },
    );

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.id).toBe("stream_session-1_100");
    expect(next.messages[0]?.content).toBe("partial answer with newer token");
  });

  it("reconciles stream placeholders when local timestamps trail persisted timestamps", () => {
    const next = appReducer(
      {
        ...initialAppState,
        messages: [
          {
            id: "user-1",
            sessionId: "session-1",
            role: "user",
            content: "prompt",
            encrypted: false,
            createdAt: "2026-06-05T00:00:10.000Z",
          },
          {
            id: "stream-session-1-100-1",
            sessionId: "session-1",
            role: "assistant",
            content: "answer with newer token",
            encrypted: false,
            createdAt: "2026-06-05T00:00:10.001Z",
          },
        ],
      },
      {
        type: "sessionDetailMerged",
        detail: {
          session: {
            ...makeSession("session-1", "project-1"),
            status: "running",
          },
          messages: [
            {
              id: "stream_session-1_100",
              sessionId: "session-1",
              role: "assistant",
              content: "answer",
              encrypted: false,
              createdAt: "2026-06-05T00:00:11.000Z",
            },
          ],
          attachments: [],
          approvals: [],
          artifacts: [],
        },
      },
    );

    expect(next.messages.map((message) => message.id)).toEqual([
      "user-1",
      "stream_session-1_100",
    ]);
    expect(next.messages[1]?.content).toBe("answer with newer token");
  });

  it("does not reconcile a current stream placeholder into an older turn", () => {
    const next = appReducer(
      {
        ...initialAppState,
        messages: [
          {
            id: "user-1",
            sessionId: "session-1",
            role: "user",
            content: "first prompt",
            encrypted: false,
            createdAt: "2026-06-05T00:00:00.000Z",
          },
          {
            id: "user-2",
            sessionId: "session-1",
            role: "user",
            content: "second prompt",
            encrypted: false,
            createdAt: "2026-06-05T00:00:02.000Z",
          },
          {
            id: "stream-session-1-300-2",
            sessionId: "session-1",
            role: "assistant",
            content: "second answer with newer token",
            encrypted: false,
            createdAt: "2026-06-05T00:00:03.000Z",
          },
        ],
      },
      {
        type: "sessionDetailMerged",
        detail: {
          session: {
            ...makeSession("session-1", "project-1"),
            status: "running",
          },
          messages: [
            {
              id: "stream_session-1_100",
              sessionId: "session-1",
              role: "assistant",
              content: "first answer",
              encrypted: false,
              createdAt: "2026-06-05T00:00:01.000Z",
            },
            {
              id: "stream_session-1_300",
              sessionId: "session-1",
              role: "assistant",
              content: "second answer",
              encrypted: false,
              createdAt: "2026-06-05T00:00:03.000Z",
            },
          ],
          attachments: [],
          approvals: [],
          artifacts: [],
        },
      },
    );

    expect(next.messages.map((message) => message.id)).toEqual([
      "user-1",
      "stream_session-1_100",
      "user-2",
      "stream_session-1_300",
    ]);
    expect(
      next.messages.find((message) => message.id === "stream_session-1_100")
        ?.content,
    ).toBe("first answer");
    expect(
      next.messages.find((message) => message.id === "stream_session-1_300")
        ?.content,
    ).toBe("second answer with newer token");
  });

  it("keeps newer local stream content when later session details are shorter", () => {
    const next = appReducer(
      {
        ...initialAppState,
        messages: [
          {
            id: "stream_session-1_100",
            sessionId: "session-1",
            role: "assistant",
            content: "partial answer with newer token",
            encrypted: false,
            createdAt: "2026-06-05T00:00:01.000Z",
          },
        ],
      },
      {
        type: "sessionDetailMerged",
        detail: {
          session: {
            ...makeSession("session-1", "project-1"),
            status: "running",
          },
          messages: [
            {
              id: "stream_session-1_100",
              sessionId: "session-1",
              role: "assistant",
              content: "partial answer",
              encrypted: false,
              createdAt: "2026-06-05T00:00:01.000Z",
            },
          ],
          attachments: [],
          approvals: [],
          artifacts: [],
        },
      },
    );

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.content).toBe("partial answer with newer token");
  });

  it("does not let stale session details regress fresher session or approval state", () => {
    const next = appReducer(
      {
        ...initialAppState,
        sessions: [
          {
            ...makeSession("session-1", "project-1"),
            status: "completed",
            updatedAt: "2026-06-05T00:00:02.000Z",
          },
        ],
        approvals: [
          {
            ...makePatchApproval(),
            status: "approved",
            resolvedAt: "2026-06-05T00:00:02.000Z",
          },
        ],
        hunks: [makePatchHunk("hunk-1", "edited")],
      },
      {
        type: "sessionDetailMerged",
        detail: {
          session: {
            ...makeSession("session-1", "project-1"),
            status: "running",
            updatedAt: "2026-06-05T00:00:01.000Z",
          },
          messages: [],
          attachments: [],
          approvals: [
            {
              ...makePatchApproval(),
              payload: { hunks: [makePatchHunk("hunk-1", "pending")] },
              status: "pending",
            },
          ],
          artifacts: [],
        },
      },
    );

    expect(next.sessions[0]?.status).toBe("completed");
    expect(next.approvals[0]?.status).toBe("approved");
    expect(next.hunks[0]?.status).toBe("edited");
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
    };

    const next = appReducer(state, {
      type: "sessionDeleted",
      sessionId: "session-1",
    });

    expect(next.selectedSessionId).toBe("");
    expect(next.messages).toEqual([]);
    expect(next.filesBySession).toEqual({});
    expect(next.fileTreeState).toEqual({});
  });

  it("stores dismissible notifications for errors", () => {
    const withNotification = appReducer(initialAppState, {
      type: "errorChanged",
      title: "Request failed",
      message: "not found",
    });

    expect(withNotification.notifications).toMatchObject([
      { title: "Request failed", message: "not found", tone: "error" },
    ]);

    const dismissed = appReducer(withNotification, {
      type: "notificationDismissed",
      id: withNotification.notifications[0]?.id ?? "",
    });

    expect(dismissed.notifications).toEqual([]);
  });

  it("does not clear existing notifications when a legacy error field is cleared", () => {
    const withNotification = appReducer(initialAppState, {
      type: "fileTreeFailed",
      sessionId: "session-1",
      path: ".",
      message: "runner offline",
    });

    const clearedErrorField = appReducer(withNotification, {
      type: "errorChanged",
      message: undefined,
    });

    expect(clearedErrorField.notifications).toEqual(
      withNotification.notifications,
    );
  });

  it("marks fully applied patch approvals as approved", () => {
    const next = appReducer(
      {
        ...initialAppState,
        approvals: [makePatchApproval()],
        hunks: [makePatchHunk("hunk-1", "accepted")],
      },
      {
        type: "patchApplySucceeded",
        sessionId: "session-1",
        applied: true,
        message: "ok",
      },
    );

    expect(next.patchApplyState).toBe("ready");
    expect(next.approvals[0]?.status).toBe("approved");
    expect(next.hunks[0]?.status).toBe("edited");
  });

  it("keeps patch approvals pending when unapplied hunks remain pending", () => {
    const next = appReducer(
      {
        ...initialAppState,
        approvals: [makePatchApproval()],
        hunks: [
          makePatchHunk("hunk-1", "accepted"),
          makePatchHunk("hunk-2", "pending"),
        ],
      },
      {
        type: "patchApplySucceeded",
        sessionId: "session-1",
        applied: true,
        message: "ok",
      },
    );

    expect(next.approvals[0]?.status).toBe("pending");
    expect(next.hunks.map((hunk) => hunk.status)).toEqual([
      "edited",
      "pending",
    ]);
  });

  it("falls back when the selected project is archived", () => {
    const next = appReducer(
      {
        ...initialAppState,
        runners: [runner],
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
    expect(next.selectedProjectId).toBe("project-2");
    expect(next.selectedSessionId).toBe("session-2");
  });

  it("clears the current selection when the last active project is archived", () => {
    const next = appReducer(
      {
        ...initialAppState,
        runners: [runner],
        projects: [makeProject("project-1")],
        sessions: [makeSession("session-1", "project-1")],
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

    expect(next.projects).toEqual([]);
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
        kind: "text",
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

    expect(next.fileContent).toMatchObject({
      kind: "text",
      content: "export const value = true;",
    });
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
          kind: "text",
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

  it("ignores stale file tree path loads after a root reset", () => {
    const files: FileNode[] = [
      {
        path: "src",
        name: "src",
        type: "directory",
      },
    ];
    const next = appReducer(
      {
        ...initialAppState,
        filesBySession: { "session-1": files },
        fileTreePathState: { "session-1": { ".": "loading" } },
      },
      {
        type: "fileTreeLoaded",
        sessionId: "session-1",
        path: "src",
        files: [
          {
            path: "src/App.tsx",
            name: "App.tsx",
            type: "file",
            size: 42,
          },
        ],
      },
    );

    expect(next.filesBySession["session-1"]).toEqual(files);
    expect(next.fileTreePathState["session-1"]).toEqual({ ".": "loading" });
  });

  it("ignores stale file tree path failures after the path is no longer loading", () => {
    const files: FileNode[] = [
      {
        path: "src",
        name: "src",
        type: "directory",
      },
    ];
    const state: AppState = {
      ...initialAppState,
      filesBySession: { "session-1": files },
      fileTreeState: { "session-1": "ready" },
      fileTreePathState: { "session-1": { ".": "ready" } },
    };

    const next = appReducer(state, {
      type: "fileTreeFailed",
      sessionId: "session-1",
      path: ".",
      message: "late failure",
    });

    expect(next).toBe(state);
    expect(next.notifications).toEqual([]);
  });

  it("ignores same-path file tree responses superseded by a newer request", () => {
    const files: FileNode[] = [
      {
        path: "src",
        name: "src",
        type: "directory",
      },
    ];
    const loadingOld = appReducer(
      {
        ...initialAppState,
        filesBySession: { "session-1": files },
        fileTreePathState: { "session-1": { src: "ready" } },
      },
      {
        type: "fileTreePathLoading",
        sessionId: "session-1",
        path: "src",
        requestId: "old-tree",
      },
    );
    const loadingNew = appReducer(loadingOld, {
      type: "fileTreePathLoading",
      sessionId: "session-1",
      path: "src",
      requestId: "new-tree",
    });

    const stale = appReducer(loadingNew, {
      type: "fileTreeLoaded",
      sessionId: "session-1",
      path: "src",
      requestId: "old-tree",
      files: [
        {
          path: "src/Stale.tsx",
          name: "Stale.tsx",
          type: "file",
          size: 1,
        },
      ],
    });

    expect(stale).toBe(loadingNew);
    expect(stale.staleFileTreeRequestIds["old-tree"]).toBe(true);

    const fresh = appReducer(loadingNew, {
      type: "fileTreeLoaded",
      sessionId: "session-1",
      path: "src",
      requestId: "new-tree",
      files: [
        {
          path: "src/Fresh.tsx",
          name: "Fresh.tsx",
          type: "file",
          size: 1,
        },
      ],
    });

    expect(fresh.filesBySession["session-1"]?.[0]).toMatchObject({
      path: "src",
      children: [{ path: "src/Fresh.tsx" }],
    });
    expect(fresh.fileTreeRequestIds["session-1"]).toBeUndefined();
  });

  it("ignores stale streamed file tree results after a root reset", () => {
    const files: FileNode[] = [
      {
        path: "src",
        name: "src",
        type: "directory",
      },
    ];
    const event: ServerEvent = {
      type: "file:tree",
      result: {
        requestId: "file-tree-1",
        sessionId: "session-1",
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
          ],
        },
      },
    };
    const next = appReducer(
      {
        ...initialAppState,
        filesBySession: { "session-1": files },
        fileTreePathState: { "session-1": { ".": "loading" } },
      },
      { type: "serverEventReceived", event },
    );

    expect(next.filesBySession["session-1"]).toEqual(files);
    expect(next.fileTreePathState["session-1"]).toEqual({ ".": "loading" });
  });

  it("applies streamed file tree updates when no local request is pending", () => {
    const event: ServerEvent = {
      type: "file:tree",
      result: {
        requestId: "broadcast-tree",
        sessionId: "session-1",
        root: {
          path: "src",
          name: "src",
          type: "directory",
          children: [
            {
              path: "src/Updated.tsx",
              name: "Updated.tsx",
              type: "file",
              size: 42,
            },
          ],
        },
      },
    };

    const next = appReducer(
      {
        ...initialAppState,
        filesBySession: {
          "session-1": [
            {
              path: "src",
              name: "src",
              type: "directory",
              children: [
                {
                  path: "src/Old.tsx",
                  name: "Old.tsx",
                  type: "file",
                  size: 1,
                },
              ],
            },
          ],
        },
        fileTreePathState: { "session-1": { ".": "ready", src: "ready" } },
      },
      { type: "serverEventReceived", event },
    );

    expect(next.filesBySession["session-1"]?.[0]).toMatchObject({
      path: "src",
      children: [{ path: "src/Updated.tsx" }],
    });
  });

  it("applies same-path broadcasts over pending local file tree loads", () => {
    const loadingLocal = appReducer(
      {
        ...initialAppState,
        filesBySession: {
          "session-1": [
            {
              path: "src",
              name: "src",
              type: "directory",
              children: [
                {
                  path: "src/Old.tsx",
                  name: "Old.tsx",
                  type: "file",
                  size: 1,
                },
              ],
            },
          ],
        },
      },
      {
        type: "fileTreePathLoading",
        sessionId: "session-1",
        path: "src",
        requestId: "local-tree",
      },
    );
    const broadcastEvent: ServerEvent = {
      type: "file:tree",
      result: {
        requestId: "broadcast-tree",
        sessionId: "session-1",
        root: {
          path: "src",
          name: "src",
          type: "directory",
          children: [
            {
              path: "src/Updated.tsx",
              name: "Updated.tsx",
              type: "file",
              size: 42,
            },
          ],
        },
      },
    };

    const broadcastApplied = appReducer(loadingLocal, {
      type: "serverEventReceived",
      event: broadcastEvent,
    });
    const staleLocal = appReducer(broadcastApplied, {
      type: "fileTreeLoaded",
      sessionId: "session-1",
      path: "src",
      requestId: "local-tree",
      files: [
        {
          path: "src/Stale.tsx",
          name: "Stale.tsx",
          type: "file",
          size: 1,
        },
      ],
    });

    expect(broadcastApplied.filesBySession["session-1"]?.[0]).toMatchObject({
      path: "src",
      children: [{ path: "src/Updated.tsx" }],
    });
    expect(broadcastApplied.fileTreeRequestIds["session-1"]).toBeUndefined();
    expect(broadcastApplied.staleFileTreeRequestIds["local-tree"]).toBe(true);
    expect(staleLocal).toBe(broadcastApplied);
  });

  it("marks pending ancestor file tree loads stale after child broadcasts", () => {
    const loadingParent = appReducer(
      {
        ...initialAppState,
        filesBySession: {
          "session-1": [
            {
              path: "src",
              name: "src",
              type: "directory",
              children: [
                {
                  path: "src/components",
                  name: "components",
                  type: "directory",
                  children: [
                    {
                      path: "src/components/Old.tsx",
                      name: "Old.tsx",
                      type: "file",
                      size: 1,
                    },
                  ],
                },
              ],
            },
          ],
        },
        fileTreePathState: {
          "session-1": {
            src: "ready",
            "src/components": "ready",
          },
        },
      },
      {
        type: "fileTreePathLoading",
        sessionId: "session-1",
        path: "src",
        requestId: "parent-tree",
      },
    );
    const childBroadcast: ServerEvent = {
      type: "file:tree",
      result: {
        requestId: "child-broadcast",
        sessionId: "session-1",
        root: {
          path: "src/components",
          name: "components",
          type: "directory",
          children: [
            {
              path: "src/components/Updated.tsx",
              name: "Updated.tsx",
              type: "file",
              size: 42,
            },
          ],
        },
      },
    };

    const broadcastApplied = appReducer(loadingParent, {
      type: "serverEventReceived",
      event: childBroadcast,
    });
    const staleParent = appReducer(broadcastApplied, {
      type: "fileTreeLoaded",
      sessionId: "session-1",
      path: "src",
      requestId: "parent-tree",
      files: [
        {
          path: "src/Stale.tsx",
          name: "Stale.tsx",
          type: "file",
          size: 1,
        },
      ],
    });

    expect(
      broadcastApplied.filesBySession["session-1"]?.[0],
    ).toMatchObject({
      path: "src",
      children: [
        {
          path: "src/components",
          children: [{ path: "src/components/Updated.tsx" }],
        },
      ],
    });
    expect(broadcastApplied.fileTreeRequestIds["session-1"]).toBeUndefined();
    expect(broadcastApplied.fileTreePathState["session-1"]).toEqual({
      "src/components": "ready",
    });
    expect(broadcastApplied.staleFileTreeRequestIds["parent-tree"]).toBe(true);
    expect(staleParent).toBe(broadcastApplied);
  });

  it("treats streamed depth-zero directory updates as empty child lists", () => {
    const event: ServerEvent = {
      type: "file:tree",
      result: {
        requestId: "depth-zero-tree",
        sessionId: "session-1",
        root: {
          path: "src",
          name: "src",
          type: "directory",
        },
      },
    };

    const next = appReducer(
      {
        ...initialAppState,
        filesBySession: {
          "session-1": [
            {
              path: "src",
              name: "src",
              type: "directory",
              children: [
                {
                  path: "src/Old.tsx",
                  name: "Old.tsx",
                  type: "file",
                  size: 1,
                },
              ],
            },
          ],
        },
        fileTreePathState: { "session-1": { ".": "ready", src: "ready" } },
      },
      { type: "serverEventReceived", event },
    );

    expect(next.filesBySession["session-1"]?.[0]).toMatchObject({
      path: "src",
      children: [],
    });
  });

  it("ignores streamed file tree updates from superseded local requests", () => {
    const loadingOld = appReducer(
      {
        ...initialAppState,
        filesBySession: {
          "session-1": [{ path: "src", name: "src", type: "directory" }],
        },
      },
      {
        type: "fileTreePathLoading",
        sessionId: "session-1",
        path: "src",
        requestId: "old-tree",
      },
    );
    const loadingNew = appReducer(loadingOld, {
      type: "fileTreePathLoading",
      sessionId: "session-1",
      path: "src",
      requestId: "new-tree",
    });
    const event: ServerEvent = {
      type: "file:tree",
      result: {
        requestId: "old-tree",
        sessionId: "session-1",
        root: {
          path: "src",
          name: "src",
          type: "directory",
          children: [
            {
              path: "src/Stale.tsx",
              name: "Stale.tsx",
              type: "file",
              size: 42,
            },
          ],
        },
      },
    };

    const next = appReducer(loadingNew, {
      type: "serverEventReceived",
      event,
    });

    expect(next).toBe(loadingNew);
  });

  it("ignores late broadcasts from failed file tree requests", () => {
    const loadingOld = appReducer(
      {
        ...initialAppState,
        filesBySession: {
          "session-1": [{ path: "src", name: "src", type: "directory" }],
        },
      },
      {
        type: "fileTreePathLoading",
        sessionId: "session-1",
        path: "src",
        requestId: "old-tree",
      },
    );
    const failedOld = appReducer(loadingOld, {
      type: "fileTreeFailed",
      sessionId: "session-1",
      path: "src",
      requestId: "old-tree",
      message: "timeout",
    });
    const loadingNew = appReducer(failedOld, {
      type: "fileTreePathLoading",
      sessionId: "session-1",
      path: "src",
      requestId: "new-tree",
    });
    const loadedNew = appReducer(loadingNew, {
      type: "fileTreeLoaded",
      sessionId: "session-1",
      path: "src",
      requestId: "new-tree",
      files: [
        {
          path: "src/Fresh.tsx",
          name: "Fresh.tsx",
          type: "file",
          size: 42,
        },
      ],
    });
    const lateFailedEvent: ServerEvent = {
      type: "file:tree",
      result: {
        requestId: "server-old-tree",
        clientRequestId: "old-tree",
        sessionId: "session-1",
        root: {
          path: "src",
          name: "src",
          type: "directory",
          children: [
            {
              path: "src/Stale.tsx",
              name: "Stale.tsx",
              type: "file",
              size: 1,
            },
          ],
        },
      },
    };

    const next = appReducer(loadedNew, {
      type: "serverEventReceived",
      event: lateFailedEvent,
    });

    expect(failedOld.staleFileTreeRequestIds["old-tree"]).toBe(true);
    expect(loadedNew.filesBySession["session-1"]?.[0]).toMatchObject({
      path: "src",
      children: [{ path: "src/Fresh.tsx" }],
    });
    expect(next).toBe(loadedNew);
  });

  it("ignores child tree updates superseded by a parent replacement", () => {
    const files: FileNode[] = [
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [
          {
            path: "src/components",
            name: "components",
            type: "directory",
          },
        ],
      },
    ];
    const childLoading = appReducer(
      {
        ...initialAppState,
        filesBySession: { "session-1": files },
      },
      {
        type: "fileTreePathLoading",
        sessionId: "session-1",
        path: "src/components",
        requestId: "child-tree",
      },
    );
    const parentLoading = appReducer(childLoading, {
      type: "fileTreePathLoading",
      sessionId: "session-1",
      path: "src",
      requestId: "parent-tree",
    });
    const parentLoaded = appReducer(parentLoading, {
      type: "fileTreeLoaded",
      sessionId: "session-1",
      path: "src",
      requestId: "parent-tree",
      files: [
        {
          path: "src/App.tsx",
          name: "App.tsx",
          type: "file",
          size: 42,
        },
      ],
    });
    const staleChildEvent: ServerEvent = {
      type: "file:tree",
      result: {
        requestId: "child-tree",
        sessionId: "session-1",
        root: {
          path: "src/components",
          name: "components",
          type: "directory",
          children: [
            {
              path: "src/components/Stale.tsx",
              name: "Stale.tsx",
              type: "file",
              size: 1,
            },
          ],
        },
      },
    };

    const next = appReducer(parentLoaded, {
      type: "serverEventReceived",
      event: staleChildEvent,
    });

    expect(parentLoaded.staleFileTreeRequestIds["child-tree"]).toBe(true);
    expect(next).toBe(parentLoaded);
  });

  it("clears descendant path states when replacing a loaded parent directory", () => {
    const next = appReducer(
      {
        ...initialAppState,
        filesBySession: {
          "session-1": [
            {
              path: "src",
              name: "src",
              type: "directory",
              children: [
                {
                  path: "src/components",
                  name: "components",
                  type: "directory",
                  children: [
                    {
                      path: "src/components/Button.tsx",
                      name: "Button.tsx",
                      type: "file",
                      size: 24,
                    },
                  ],
                },
              ],
            },
          ],
        },
        fileTreePathState: {
          "session-1": {
            ".": "ready",
            src: "loading",
            "src/components": "ready",
          },
        },
      },
      {
        type: "fileTreeLoaded",
        sessionId: "session-1",
        path: "src",
        files: [
          {
            path: "src/App.tsx",
            name: "App.tsx",
            type: "file",
            size: 42,
          },
        ],
      },
    );

    expect(next.filesBySession["session-1"]?.[0]).toMatchObject({
      path: "src",
      children: [{ path: "src/App.tsx" }],
    });
    expect(next.fileTreePathState["session-1"]).toEqual({
      ".": "ready",
      src: "ready",
    });
  });

  it("keeps open file edits when refreshing the current session workspace", () => {
    const next = appReducer(
      {
        ...initialAppState,
        selectedSessionId: "session-1",
        selectedFilePath: "src/App.tsx",
        fileContent: {
          requestId: "file-content-1",
          sessionId: "session-1",
          path: "src/App.tsx",
          kind: "text",
          content: "export const saved = true;",
          truncated: false,
          encoding: "utf8",
        },
        editorContent: "export const unsaved = true;",
        fileContentState: "ready",
        fileSaveState: "error",
      },
      {
        type: "sessionWorkspaceLoading",
        sessionId: "session-1",
        resetSelection: false,
      },
    );

    expect(next.selectedFilePath).toBe("src/App.tsx");
    expect(next.fileContent).toMatchObject({
      kind: "text",
      content: "export const saved = true;",
    });
    expect(next.editorContent).toBe("export const unsaved = true;");
    expect(next.fileContentState).toBe("ready");
    expect(next.fileSaveState).toBe("error");
    expect(next.fileTreeState["session-1"]).toBe("loading");
  });

  it("keeps open file edits when the current session workspace is unavailable", () => {
    const next = appReducer(
      {
        ...initialAppState,
        selectedSessionId: "session-1",
        selectedFilePath: "src/App.tsx",
        fileContent: {
          requestId: "file-content-1",
          sessionId: "session-1",
          path: "src/App.tsx",
          kind: "text",
          content: "export const saved = true;",
          truncated: false,
          encoding: "utf8",
        },
        editorContent: "export const unsaved = true;",
        fileContentState: "ready",
        fileSaveState: "error",
        fileTreeState: { "session-1": "loading" },
      },
      {
        type: "sessionWorkspaceUnavailable",
        sessionId: "session-1",
        resetSelection: false,
      },
    );

    expect(next.selectedFilePath).toBe("src/App.tsx");
    expect(next.fileContent).toMatchObject({
      kind: "text",
      content: "export const saved = true;",
    });
    expect(next.editorContent).toBe("export const unsaved = true;");
    expect(next.fileContentState).toBe("ready");
    expect(next.fileSaveState).toBe("error");
    expect(next.fileTreeState["session-1"]).toBe("idle");
  });

  it("clears open file edits when switching session workspaces", () => {
    const next = appReducer(
      {
        ...initialAppState,
        selectedSessionId: "session-2",
        selectedFilePath: "src/App.tsx",
        editorContent: "export const unsaved = true;",
        fileContentState: "ready",
        fileSaveState: "error",
        filesBySession: { "session-2": [] },
      },
      {
        type: "sessionWorkspaceLoading",
        sessionId: "session-2",
        resetSelection: true,
      },
    );

    expect(next.selectedFilePath).toBe("");
    expect(next.fileContent).toBeUndefined();
    expect(next.editorContent).toBe("");
    expect(next.fileContentState).toBe("idle");
    expect(next.fileSaveState).toBe("idle");
    expect(next.fileTreeState["session-2"]).toBe("loading");
  });

  it("clears open file edits when switching to an unavailable session workspace", () => {
    const next = appReducer(
      {
        ...initialAppState,
        selectedSessionId: "session-2",
        selectedFilePath: "src/App.tsx",
        editorContent: "export const unsaved = true;",
        fileContentState: "ready",
        fileSaveState: "error",
      },
      {
        type: "sessionWorkspaceUnavailable",
        sessionId: "session-2",
        resetSelection: true,
      },
    );

    expect(next.selectedFilePath).toBe("");
    expect(next.fileContent).toBeUndefined();
    expect(next.editorContent).toBe("");
    expect(next.fileContentState).toBe("idle");
    expect(next.fileSaveState).toBe("idle");
    expect(next.filesBySession).toEqual({});
    expect(next.fileTreeState["session-2"]).toBe("idle");
  });

  it("marks cleared file tree requests stale when a workspace becomes unavailable", () => {
    const unavailable = appReducer(
      {
        ...initialAppState,
        filesBySession: {
          "session-2": [
            {
              path: "src",
              name: "src",
              type: "directory",
              children: [],
            },
          ],
        },
        fileTreeRequestIds: {
          "session-2": {
            ".": "root-tree-old",
            src: "src-tree-old",
          },
        },
        fileTreePathState: {
          "session-2": {
            ".": "loading",
            src: "loading",
          },
        },
      },
      {
        type: "sessionWorkspaceUnavailable",
        sessionId: "session-2",
        resetSelection: true,
      },
    );

    expect(unavailable.staleFileTreeRequestIds["root-tree-old"]).toBe(true);
    expect(unavailable.staleFileTreeRequestIds["src-tree-old"]).toBe(true);

    const late = appReducer(unavailable, {
      type: "serverEventReceived",
      event: {
        type: "file:tree",
        result: {
          requestId: "server-root-tree-old",
          clientRequestId: "root-tree-old",
          sessionId: "session-2",
          root: {
            path: ".",
            name: "project",
            type: "directory",
            children: [
              {
                path: "src",
                name: "src",
                type: "directory",
                children: [],
              },
            ],
          },
        },
      },
    });

    expect(late).toBe(unavailable);
    expect(late.filesBySession["session-2"]).toBeUndefined();
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

function makeProject(id: string, runnerId = "runner-1"): Project {
  return {
    id,
    name: id,
    runnerId,
    directory: `/workspace/${id}`,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    lastActiveAt: "2026-06-05T00:00:00.000Z",
  };
}

function makeSession(
  id: string,
  projectId: string,
  runnerId = "runner-1",
): Session {
  return {
    id,
    title: id,
    projectId,
    runnerId,
    agent: "codex",
    status: "completed",
    executionMode: "direct",
    executionFolder: `/workspace/${projectId}`,
    cwd: `/workspace/${projectId}`,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
}

function makePatchApproval(): Approval {
  return {
    id: "approval-1",
    sessionId: "session-1",
    runnerId: "runner-1",
    kind: "applyPatch",
    summary: "Apply patch",
    payload: { hunks: [] },
    status: "pending",
    requestedAt: "2026-06-05T00:00:00.000Z",
  };
}

function makePatchHunk(
  id: string,
  status: SessionPatchHunk["status"],
): SessionPatchHunk {
  return {
    id,
    approvalId: "approval-1",
    sessionId: "session-1",
    filePath: "src/App.tsx",
    header: "@@ -1 +1 @@",
    lines: ["-before", "+after"],
    status,
  };
}
