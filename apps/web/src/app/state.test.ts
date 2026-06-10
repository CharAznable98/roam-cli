import type { ServerEvent } from "@roamcli/protocol";
import { describe, expect, it } from "vitest";
import { appReducer, initialAppState, type AppState } from "./state";

describe("app reducer", () => {
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
