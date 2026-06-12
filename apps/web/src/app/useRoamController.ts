import type { AgentKind, ExecutionMode } from "@roamcli/protocol";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  createRoamApiClient,
  sendStreamCommand,
  type RoamApiClient,
} from "../api";
import { buildPatchFromHunks } from "../features/approvals/model";
import {
  getRunnerSessions,
  getProjectSessions,
  getSelectedProject,
  getSelectedRunner,
  getSelectedSession,
} from "../features/sessions/model";
import { appReducer, initialAppState } from "./state";

const INITIAL_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export type StreamReconnectInfo = {
  mode: "connecting" | "connected" | "waiting";
  attempt: number;
  delayMs: number;
  nextAttemptAt?: number;
};

export function useRoamController() {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [token, setToken] = useState(
    () => localStorage.getItem("roamcli.token") ?? "dev-token",
  );
  const [streamReconnect, setStreamReconnect] = useState<StreamReconnectInfo>({
    mode: "connecting",
    attempt: 0,
    delayMs: INITIAL_RECONNECT_DELAY_MS,
  });
  const apiRef = useRef<RoamApiClient | undefined>(undefined);
  const streamRef = useRef<WebSocket | undefined>(undefined);
  const reconnectStreamRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    localStorage.setItem("roamcli.token", token);
    dispatch({ type: "bootstrapStarted" });
    const api = createRoamApiClient({ token });
    apiRef.current = api;
    let cancelled = false;
    let socketGeneration = 0;
    let activeSocket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let retryDelayMs = INITIAL_RECONNECT_DELAY_MS;
    let retryAttempt = 0;

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

    function clearRetryTimer() {
      if (retryTimer) {
        globalThis.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    }

    function scheduleReconnect() {
      if (cancelled || retryTimer) {
        return;
      }
      const delayMs = retryDelayMs;
      retryAttempt += 1;
      setStreamReconnect({
        mode: "waiting",
        attempt: retryAttempt,
        delayMs,
        nextAttemptAt: Date.now() + delayMs,
      });
      retryTimer = globalThis.setTimeout(() => {
        retryTimer = undefined;
        retryDelayMs = Math.min(delayMs * 2, MAX_RECONNECT_DELAY_MS);
        connectStream();
      }, delayMs);
    }

    function connectStream() {
      if (cancelled) {
        return;
      }
      clearRetryTimer();
      const generation = socketGeneration + 1;
      socketGeneration = generation;
      const previousSocket = activeSocket;
      setStreamReconnect({
        mode: "connecting",
        attempt: retryAttempt,
        delayMs: retryDelayMs,
      });
      const socket = api.connectStream(
        (event) => {
          if (!cancelled && generation === socketGeneration) {
            dispatch({ type: "serverEventReceived", event });
          }
        },
        (status) => {
          if (cancelled || generation !== socketGeneration) {
            return;
          }
          dispatch({ type: "connectionChanged", status });
          if (status === "open") {
            retryDelayMs = INITIAL_RECONNECT_DELAY_MS;
            retryAttempt = 0;
            clearRetryTimer();
            setStreamReconnect({
              mode: "connected",
              attempt: 0,
              delayMs: INITIAL_RECONNECT_DELAY_MS,
            });
            return;
          }
          scheduleReconnect();
        },
      );
      activeSocket = socket;
      streamRef.current = socket;
      if (
        previousSocket &&
        previousSocket !== socket &&
        previousSocket.readyState !== WebSocket.CLOSED
      ) {
        previousSocket.close();
      }
      if (!socket) {
        scheduleReconnect();
      }
    }

    reconnectStreamRef.current = () => {
      retryDelayMs = INITIAL_RECONNECT_DELAY_MS;
      retryAttempt = 0;
      connectStream();
    };
    connectStream();

    return () => {
      cancelled = true;
      reconnectStreamRef.current = undefined;
      clearRetryTimer();
      activeSocket?.close();
      if (streamRef.current === activeSocket) {
        streamRef.current = undefined;
      }
    };
  }, [token]);

  const reconnectStream = () => reconnectStreamRef.current?.();

  const selectedProject = useMemo(
    () => getSelectedProject(state.projects, state.selectedProjectId),
    [state.projects, state.selectedProjectId],
  );
  const selectedRunner = useMemo(
    () =>
      selectedProject
        ? state.runners.find(
            (runner) => runner.runnerId === selectedProject.runnerId,
          )
        : getSelectedRunner(state.runners, state.selectedRunnerId),
    [selectedProject, state.runners, state.selectedRunnerId],
  );
  const projectSessions = useMemo(
    () => getProjectSessions(state.sessions, selectedProject?.id),
    [selectedProject?.id, state.sessions],
  );
  const selectedSession = useMemo(
    () =>
      getSelectedSession(
        state.sessions,
        projectSessions,
        state.selectedSessionId,
      ),
    [projectSessions, state.selectedSessionId, state.sessions],
  );

  useEffect(() => {
    if (!selectedSession || !apiRef.current) {
      dispatch({ type: "sessionWorkspaceCleared" });
      return;
    }

    const sessionId = selectedSession.id;
    if (
      selectedSession.executionMode === "managed_worktree" &&
      selectedSession.status === "pending"
    ) {
      dispatch({ type: "sessionWorkspaceCleared" });
      return;
    }
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
  }, [
    selectedSession?.executionMode,
    selectedSession?.id,
    selectedSession?.status,
  ]);

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

  const selectProject = (projectId: string) => {
    const nextSession = state.sessions.find(
      (session) => session.projectId === projectId && !session.archivedAt,
    );
    dispatch({
      type: "projectSelected",
      projectId,
      nextSessionId: nextSession?.id ?? "",
    });
  };

  const createProject = async (values: {
    name: string;
    runnerId: string;
    directory: string;
  }) => {
    if (!apiRef.current) {
      throw new Error("API client is not ready.");
    }
    try {
      const project = await apiRef.current.createProject(values);
      dispatch({ type: "projectCreated", project });
    } catch (createError: unknown) {
      const message = errorMessage(createError);
      dispatch({ type: "errorChanged", message });
      throw new Error(message);
    }
  };

  const archiveProject = (projectId: string) => {
    if (!apiRef.current) return;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    if (
      !window.confirm(
        `Archive project "${project.name}"? Sessions stay recoverable and project files are not deleted.`,
      )
    ) {
      return;
    }
    void apiRef.current
      .archiveProject(projectId)
      .then((archivedProject) =>
        dispatch({ type: "projectUpdated", project: archivedProject }),
      )
      .catch((archiveError: unknown) =>
        dispatch({
          type: "errorChanged",
          message: errorMessage(archiveError),
        }),
      );
  };

  const createSession = async (
    projectId: string,
    values: {
      title: string;
      prompt: string;
      agent: AgentKind;
      executionMode: ExecutionMode;
    },
  ) => {
    if (!projectId || !apiRef.current) {
      throw new Error("API client is not ready.");
    }
    try {
      const session = await apiRef.current.createSession({
        projectId,
        ...values,
      });
      dispatch({ type: "sessionCreated", session });
    } catch (createError: unknown) {
      const message = errorMessage(createError);
      dispatch({ type: "errorChanged", message });
      throw new Error(message);
    }
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
        title: "Event stream is disconnected",
        message:
          "Message was not sent. Reload the page, then check that /v1/stream is connected with the current token.",
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
        title: "Event stream is disconnected",
        message:
          "Control signal was not sent. Reload the page, then check that /v1/stream is connected with the current token.",
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
        title: "Event stream is disconnected",
        message:
          "Terminal input was not sent. Reload the page, then check that /v1/stream is connected with the current token.",
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
    ? state.messages.filter(
        (message) => message.sessionId === selectedSession.id,
      )
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
    streamReconnect,
    reconnectStream,
    dispatch,
    selectedRunner,
    selectedProject,
    runnerSessions: projectSessions,
    selectedSession,
    sessionMessages,
    sessionApprovals,
    sessionHunks,
    sessionTerminalLines,
    sessionFiles,
    sessionFileTreeState,
    runnerCommand: `pnpm --filter @roamcli/runner dev --server ws://127.0.0.1:8787/v1/runner --token ${token || "dev-token"}`,
    selectRunner,
    selectProject,
    createProject,
    archiveProject,
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
