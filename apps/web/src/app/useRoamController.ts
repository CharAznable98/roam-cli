import type { AgentKind } from "@roamcli/protocol";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  createRoamApiClient,
  sendStreamCommand,
  type RoamApiClient,
} from "../api";
import { buildPatchFromHunks } from "../features/approvals/model";
import {
  getRunnerSessions,
  getSelectedRunner,
  getSelectedSession,
} from "../features/sessions/model";
import { appReducer, initialAppState } from "./state";

export function useRoamController() {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [token, setToken] = useState(
    () => localStorage.getItem("roamcli.token") ?? "dev-token",
  );
  const apiRef = useRef<RoamApiClient | undefined>(undefined);
  const streamRef = useRef<WebSocket | undefined>(undefined);

  useEffect(() => {
    localStorage.setItem("roamcli.token", token);
    dispatch({ type: "bootstrapStarted" });
    const api = createRoamApiClient({ token });
    apiRef.current = api;
    let cancelled = false;

    api
      .loadInitialState()
      .then((remote) => {
        if (!cancelled) {
          dispatch({ type: "bootstrapSucceeded", remote });
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "bootstrapFailed",
            message: errorMessage(loadError),
          });
        }
      });

    const socket = api.connectStream(
      (event) => dispatch({ type: "serverEventReceived", event }),
      (status) => dispatch({ type: "connectionChanged", status }),
    );
    streamRef.current = socket;

    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [token]);

  const selectedRunner = useMemo(
    () => getSelectedRunner(state.runners, state.selectedRunnerId),
    [state.runners, state.selectedRunnerId],
  );
  const runnerSessions = useMemo(
    () => getRunnerSessions(state.sessions, selectedRunner?.runnerId),
    [selectedRunner?.runnerId, state.sessions],
  );
  const selectedSession = useMemo(
    () =>
      getSelectedSession(
        state.sessions,
        runnerSessions,
        state.selectedSessionId,
      ),
    [runnerSessions, state.selectedSessionId, state.sessions],
  );

  useEffect(() => {
    if (!selectedSession || !apiRef.current) {
      dispatch({ type: "sessionWorkspaceCleared" });
      return;
    }

    const sessionId = selectedSession.id;
    let cancelled = false;
    dispatch({ type: "sessionWorkspaceLoading", sessionId });

    void apiRef.current
      .fetchFileTree(sessionId)
      .then((fileTree) => {
        if (!cancelled) {
          dispatch({ type: "fileTreeLoaded", sessionId, files: fileTree });
        }
      })
      .catch((fileError: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "fileTreeFailed",
            sessionId,
            message: errorMessage(fileError),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSession?.id]);

  const selectRunner = (runnerId: string) => {
    const nextSession = state.sessions.find(
      (session) => session.runnerId === runnerId,
    );
    dispatch({
      type: "runnerSelected",
      runnerId,
      nextSessionId: nextSession?.id ?? "",
    });
  };

  const createSession = (values: {
    title: string;
    cwd: string;
    prompt: string;
    agent: AgentKind;
  }) => {
    if (!selectedRunner || !apiRef.current) return;
    void apiRef.current
      .createSession({ runnerId: selectedRunner.runnerId, ...values })
      .then((session) => dispatch({ type: "sessionCreated", session }))
      .catch((createError: unknown) =>
        dispatch({
          type: "errorChanged",
          message: errorMessage(createError),
        }),
      );
  };

  const sendMessage = (content: string) => {
    if (!selectedSession) return;
    const sent = sendStreamCommand(streamRef.current, {
      type: "userMessage",
      requestId: `req-${Date.now()}`,
      sessionId: selectedSession.id,
      content,
    });
    if (!sent) {
      dispatch({
        type: "errorChanged",
        message: "The event stream is not connected; message was not sent.",
      });
    }
  };

  const resolveApproval = (approvalId: string, approved: boolean) => {
    void apiRef.current
      ?.resolveApproval(approvalId, approved)
      .then((approval) => dispatch({ type: "approvalUpserted", approval }))
      .catch((approvalError: unknown) =>
        dispatch({
          type: "errorChanged",
          message: errorMessage(approvalError),
        }),
      );
  };

  const resolveHunk = (hunkId: string, status: "accepted" | "rejected") => {
    dispatch({ type: "hunkResolved", hunkId, status });
  };

  const applyAcceptedPatch = () => {
    if (!selectedSession || !apiRef.current) return;
    const sessionId = selectedSession.id;
    const openPath = state.selectedFilePath;
    const patch = buildPatchFromHunks(
      sessionHunks.filter((hunk) => hunk.status === "accepted"),
    );
    if (!patch) {
      dispatch({
        type: "errorChanged",
        message: "No accepted patch hunks are ready to apply.",
      });
      return;
    }

    dispatch({ type: "patchApplyStarted" });
    void apiRef.current
      .applyPatch(sessionId, patch)
      .then((result) => {
        dispatch({
          type: "patchApplySucceeded",
          sessionId,
          applied: result.applied,
          message: result.message,
        });
        if (openPath) {
          loadFileContent(sessionId, openPath);
        }
      })
      .catch((patchError: unknown) =>
        dispatch({
          type: "patchApplyFailed",
          message: errorMessage(patchError),
        }),
      );
  };

  const sendControl = (signal: "interrupt" | "stop" | "resume") => {
    if (!selectedSession) return;
    const sent = sendStreamCommand(streamRef.current, {
      type: "controlSignal",
      requestId: `req-${Date.now()}`,
      sessionId: selectedSession.id,
      signal,
    });
    if (!sent) {
      dispatch({
        type: "errorChanged",
        message:
          "The event stream is not connected; control signal was not sent.",
      });
    }
  };

  const deleteSelectedSession = () => {
    if (!selectedSession || !apiRef.current) return;
    if (!window.confirm(`Delete session "${selectedSession.title}"?`)) {
      return;
    }
    const sessionId = selectedSession.id;
    void apiRef.current
      .deleteSession(sessionId)
      .then(() => dispatch({ type: "sessionDeleted", sessionId }))
      .catch((deleteError: unknown) =>
        dispatch({
          type: "errorChanged",
          message: errorMessage(deleteError),
        }),
      );
  };

  const sendTerminalCommand = (command: string) => {
    if (!selectedSession) return;
    const sent = sendStreamCommand(streamRef.current, {
      type: "userMessage",
      requestId: `req-${Date.now()}`,
      sessionId: selectedSession.id,
      content: command,
    });
    if (!sent) {
      dispatch({
        type: "errorChanged",
        message:
          "The event stream is not connected; terminal input was not sent.",
      });
    }
  };

  const selectFile = (path: string) => {
    if (!selectedSession || !apiRef.current) return;
    loadFileContent(selectedSession.id, path);
  };

  const saveSelectedFile = () => {
    if (!selectedSession || !state.selectedFilePath || !apiRef.current) return;
    const sessionId = selectedSession.id;
    const path = state.selectedFilePath;
    dispatch({ type: "fileSaveStarted" });
    void apiRef.current
      .saveFileContent(sessionId, path, state.editorContent)
      .then(() => {
        dispatch({ type: "fileSaveSucceeded" });
        loadFileContent(sessionId, path);
      })
      .catch((saveError: unknown) =>
        dispatch({
          type: "fileSaveFailed",
          message: errorMessage(saveError),
        }),
      );
  };

  const loadFileContent = (sessionId: string, path: string) => {
    if (!apiRef.current) return;
    dispatch({ type: "fileContentLoading", path });
    void apiRef.current
      .fetchFileContent(sessionId, path)
      .then((result) => dispatch({ type: "fileContentLoaded", result }))
      .catch((fileError: unknown) =>
        dispatch({
          type: "fileContentFailed",
          message: errorMessage(fileError),
        }),
      );
  };

  const sessionMessages = selectedSession
    ? state.messages.filter((message) => message.sessionId === selectedSession.id)
    : [];
  const sessionApprovals = selectedSession
    ? state.approvals.filter(
        (approval) => approval.sessionId === selectedSession.id,
      )
    : state.approvals;
  const sessionHunks = selectedSession
    ? state.hunks.filter((hunk) => hunk.sessionId === selectedSession.id)
    : [];
  const sessionTerminalLines = selectedSession
    ? (state.terminalLines[selectedSession.id] ?? [])
    : [];
  const sessionFiles = selectedSession
    ? (state.filesBySession[selectedSession.id] ?? [])
    : [];
  const sessionFileTreeState = selectedSession
    ? (state.fileTreeState[selectedSession.id] ?? "idle")
    : "idle";

  return {
    state,
    token,
    setToken,
    dispatch,
    selectedRunner,
    runnerSessions,
    selectedSession,
    sessionMessages,
    sessionApprovals,
    sessionHunks,
    sessionTerminalLines,
    sessionFiles,
    sessionFileTreeState,
    serverCommand:
      "PORT=8787 ROAMCLI_AUTH_TOKEN=dev-token ROAMCLI_DATA_DIR=.roamcli-server pnpm --filter @roamcli/server dev",
    runnerCommand: `pnpm --filter @roamcli/runner dev --server ws://127.0.0.1:8787/v1/runner --token ${token || "dev-token"}`,
    selectRunner,
    createSession,
    sendMessage,
    resolveApproval,
    resolveHunk,
    applyAcceptedPatch,
    sendControl,
    deleteSelectedSession,
    sendTerminalCommand,
    selectFile,
    saveSelectedFile,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
