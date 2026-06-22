import type {
  AccountSecurityState,
  AgentKind,
  ApiChangePassword,
  ApiAgentSkillList,
  ApiGitBlameQuery,
  ApiGitCommit,
  ApiGitContext,
  ApiGitFileDiffQuery,
  ApiGitHistoryQuery,
  ApiGitInit,
  ApiGitPaths,
  ApiGitRemoteOperation,
  ApiGitRemoveWorktree,
  ApiPathSearch,
  ExecutionMode,
  ImageAttachmentUpload,
  SessionStatus,
} from "@roamcli/shared/protocol";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  createRoamApiClient,
  sendStreamCommand,
  type RoamApiClient,
} from "../api";
import {
  appliedPatchApprovalIds,
  buildPatchFromHunks,
} from "../features/approvals/model";
import { toUiMessage } from "../features/conversation/model";
import {
  nearestTreeDirectoryPath,
  parentDirectory,
} from "../features/files/tree-model";
import {
  getRunnerSessions,
  getProjectSessions,
  getSelectedProject,
  getSelectedRunner,
  getSelectedSession,
} from "../features/sessions/model";
import { buildRunnerCommand } from "./runner-command";
import { loadLastSelection, saveLastSelection } from "./selection-storage";
import { appReducer, initialAppState, type AppState } from "./state";

const INITIAL_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const ACTIVE_SESSION_DETAIL_SYNC_INITIAL_DELAY_MS = 1_500;
const ACTIVE_SESSION_DETAIL_SYNC_BACKOFF_DELAY_MS = 10_000;
let fileTreeRequestSequence = 0;

export type StreamReconnectInfo = {
  mode: "connecting" | "connected" | "waiting";
  attempt: number;
  delayMs: number;
  nextAttemptAt?: number;
};

export type AuthViewState =
  | "checking"
  | "setup_required"
  | "login"
  | "authenticated";

export function useRoamController() {
  const [state, dispatch] = useReducer(
    appReducer,
    initialAppState,
    hydrateInitialSelection,
  );
  const [authView, setAuthView] = useState<AuthViewState>("checking");
  const [authEpoch, setAuthEpoch] = useState(0);
  const [accountSecurity, setAccountSecurity] = useState<
    AccountSecurityState | undefined
  >();
  const [streamReconnect, setStreamReconnect] = useState<StreamReconnectInfo>({
    mode: "connecting",
    attempt: 0,
    delayMs: INITIAL_RECONNECT_DELAY_MS,
  });
  const [checkingSessionStatusId, setCheckingSessionStatusId] = useState<
    string | undefined
  >();
  const apiRef = useRef<RoamApiClient | undefined>(undefined);
  const streamRef = useRef<WebSocket | undefined>(undefined);
  const reconnectStreamRef = useRef<(() => void) | undefined>(undefined);
  const workspaceSessionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const api = createRoamApiClient();
    apiRef.current = api;
    let cancelled = false;
    let socketGeneration = 0;
    let activeSocket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let retryDelayMs = INITIAL_RECONNECT_DELAY_MS;
    let retryAttempt = 0;
    let nextRemoteStateRequestId = 0;
    let latestBootstrapRequestId = 0;
    let latestNotificationRequestId = 0;
    let pendingBootstrapRequestId: number | undefined;
    let bootstrapReady = false;

    function transitionToUnauthenticated(
      nextView: Extract<AuthViewState, "setup_required" | "login"> = "login",
      message?: string,
    ) {
      bootstrapReady = false;
      pendingBootstrapRequestId = undefined;
      streamRef.current?.close();
      setAccountSecurity(undefined);
      setAuthView(nextView);
      dispatch({ type: "connectionChanged", status: "closed" });
      if (message) {
        dispatch({
          type: "errorChanged",
          title: "Session expired",
          message,
        });
      }
    }

    function loadRemoteState(failureMode: "bootstrap" | "notification") {
      const requestId = ++nextRemoteStateRequestId;
      const isBootstrap = failureMode === "bootstrap";
      if (isBootstrap) {
        latestBootstrapRequestId = requestId;
        pendingBootstrapRequestId = requestId;
        bootstrapReady = false;
      } else {
        latestNotificationRequestId = requestId;
      }
      if (failureMode === "bootstrap") {
        dispatch({ type: "bootstrapStarted" });
      }
      void api
        .loadInitialState()
        .then((remote) => {
          if (cancelled) {
            return;
          }
          if (isBootstrap) {
            if (requestId !== latestBootstrapRequestId) {
              return;
            }
            pendingBootstrapRequestId = undefined;
            bootstrapReady = true;
            dispatch({ type: "bootstrapSucceeded", remote });
            return;
          }
          if (
            pendingBootstrapRequestId !== undefined ||
            requestId !== latestNotificationRequestId
          ) {
            return;
          }
          dispatch({ type: "bootstrapSucceeded", remote });
        })
        .catch((loadError: unknown) => {
          if (cancelled) {
            return;
          }
          const message = errorMessage(loadError);
          if (isAuthErrorMessage(message)) {
            transitionToUnauthenticated(
              authViewFromErrorMessage(message),
              message,
            );
            return;
          }
          if (isBootstrap) {
            if (requestId !== latestBootstrapRequestId) {
              return;
            }
            pendingBootstrapRequestId = undefined;
            bootstrapReady = false;
            dispatch({ type: "bootstrapFailed", message });
            return;
          }
          if (!bootstrapReady || requestId !== latestNotificationRequestId) {
            return;
          }
          dispatch({
            type: "errorChanged",
            title: "RoamCli API request failed",
            message,
          });
        });
    }

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
            const shouldSyncMissedEvents = retryAttempt > 0;
            retryDelayMs = INITIAL_RECONNECT_DELAY_MS;
            retryAttempt = 0;
            clearRetryTimer();
            setStreamReconnect({
              mode: "connected",
              attempt: 0,
              delayMs: INITIAL_RECONNECT_DELAY_MS,
            });
            if (shouldSyncMissedEvents) {
              loadRemoteState("notification");
            }
            return;
          }
          void api.fetchAuthStatus().then((auth) => {
            if (!cancelled && auth.status !== "authenticated") {
              transitionToUnauthenticated(
                auth.status === "setup_required" ? "setup_required" : "login",
              );
            }
          });
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

    void api
      .fetchAuthStatus()
      .then(async (auth) => {
        if (cancelled) {
          return;
        }
        if (auth.status === "setup_required") {
          setAccountSecurity(undefined);
          setAuthView("setup_required");
          dispatch({ type: "connectionChanged", status: "closed" });
          return;
        }
        if (auth.status === "unauthenticated") {
          setAccountSecurity(undefined);
          setAuthView("login");
          dispatch({ type: "connectionChanged", status: "closed" });
          return;
        }
        setAuthView("authenticated");
        try {
          setAccountSecurity(await api.fetchAccountSecurity());
        } catch {
          // The main bootstrap below will surface auth/API failures.
        }
        loadRemoteState("bootstrap");
        connectStream();
      })
      .catch((authError: unknown) => {
        if (cancelled) {
          return;
        }
        const message = errorMessage(authError);
        dispatch({ type: "bootstrapFailed", message });
        setAuthView(authViewFromErrorMessage(message));
      });

    reconnectStreamRef.current = () => {
      retryDelayMs = INITIAL_RECONNECT_DELAY_MS;
      retryAttempt = 0;
      loadRemoteState("bootstrap");
      connectStream();
    };
    return () => {
      cancelled = true;
      reconnectStreamRef.current = undefined;
      clearRetryTimer();
      activeSocket?.close();
      if (streamRef.current === activeSocket) {
        streamRef.current = undefined;
      }
    };
  }, [authEpoch]);

  const refreshAuth = useCallback(() => {
    setAuthView("checking");
    setAuthEpoch((epoch) => epoch + 1);
  }, []);

  const setupOwner = useCallback(
    async (input: { setupToken: string; password: string }) => {
      const api = apiRef.current ?? createRoamApiClient();
      apiRef.current = api;
      const result = await api.setupOwner(input);
      setAccountSecurity(result.account);
      refreshAuth();
    },
    [refreshAuth],
  );

  const loginOwner = useCallback(
    async (password: string) => {
      const api = apiRef.current ?? createRoamApiClient();
      apiRef.current = api;
      const result = await api.login({ password });
      setAccountSecurity(result.account);
      refreshAuth();
    },
    [refreshAuth],
  );

  const logoutOwner = useCallback(async () => {
    const api = apiRef.current;
    if (api) {
      await api.logout();
    }
    streamRef.current?.close();
    setAccountSecurity(undefined);
    setAuthView("login");
    refreshAuth();
  }, [refreshAuth]);

  const logoutAllOwnerSessions = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    await api.logoutAll();
    streamRef.current?.close();
    setAccountSecurity(undefined);
    setAuthView("login");
    refreshAuth();
  }, [refreshAuth]);

  const changeOwnerPassword = useCallback(
    async (input: ApiChangePassword) => {
      const api = apiRef.current;
      if (!api) {
        throw new Error("API client is not ready.");
      }
      await api.changePassword(input);
      streamRef.current?.close();
      setAccountSecurity(undefined);
      setAuthView("login");
      refreshAuth();
    },
    [refreshAuth],
  );

  const regenerateRunnerToken = useCallback(async () => {
    const api = apiRef.current;
    if (!api) {
      throw new Error("API client is not ready.");
    }
    setAccountSecurity(await api.regenerateRunnerToken());
  }, []);

  const refreshAccountSecurity = useCallback(async () => {
    const api = apiRef.current;
    if (!api) {
      throw new Error("API client is not ready.");
    }
    setAccountSecurity(await api.fetchAccountSecurity());
  }, []);

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
    if (state.loadState !== "ready") {
      return;
    }
    saveLastSelection(
      selectedProject
        ? {
            projectId: selectedProject.id,
            sessionId: selectedSession?.id ?? "",
          }
        : undefined,
    );
  }, [selectedProject, selectedSession, state.loadState]);

  useEffect(() => {
    const sessionId = selectedSession?.id;
    const status = selectedSession?.status;
    if (!sessionId || !status || !isActiveSessionStatus(status)) {
      return;
    }

    let cancelled = false;
    let syncTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

    const scheduleNextSync = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      syncTimer = globalThis.setTimeout(syncStatus, delayMs);
    };

    const syncStatus = () => {
      const api = apiRef.current;
      if (!api) {
        scheduleNextSync(ACTIVE_SESSION_DETAIL_SYNC_INITIAL_DELAY_MS);
        return;
      }
      let nextDelayMs = ACTIVE_SESSION_DETAIL_SYNC_INITIAL_DELAY_MS;
      void api
        .fetchSessionDetail(sessionId)
        .then((detail) => {
          nextDelayMs = ACTIVE_SESSION_DETAIL_SYNC_BACKOFF_DELAY_MS;
          if (!cancelled) {
            dispatch({ type: "sessionDetailMerged", detail });
          }
        })
        .catch(() => {
          // Manual status checks surface errors; this background sync only repairs missed events.
        })
        .finally(() => {
          scheduleNextSync(nextDelayMs);
        });
    };

    scheduleNextSync(ACTIVE_SESSION_DETAIL_SYNC_INITIAL_DELAY_MS);
    return () => {
      cancelled = true;
      if (syncTimer) {
        globalThis.clearTimeout(syncTimer);
      }
    };
  }, [selectedSession?.id, selectedSession?.status]);

  const selectedGitContext = useMemo<ApiGitContext | undefined>(() => {
    if (
      selectedSession?.executionMode === "managed_worktree" &&
      selectedSession.status !== "pending" &&
      !selectedSession.worktreeDeletedAt
    ) {
      return { kind: "session_worktree", sessionId: selectedSession.id };
    }
    return selectedProject
      ? { kind: "project", projectId: selectedProject.id }
      : undefined;
  }, [
    selectedProject,
    selectedSession?.executionMode,
    selectedSession?.id,
    selectedSession?.status,
    selectedSession?.worktreeDeletedAt,
  ]);

  useEffect(() => {
    if (!selectedSession || !apiRef.current) {
      workspaceSessionIdRef.current = undefined;
      dispatch({ type: "sessionWorkspaceCleared" });
      return;
    }

    const sessionId = selectedSession.id;
    if (
      selectedSession.executionMode === "managed_worktree" &&
      (selectedSession.status === "pending" ||
        selectedSession.worktreeDeletedAt)
    ) {
      workspaceSessionIdRef.current = undefined;
      dispatch({
        type: "sessionWorkspaceUnavailable",
        sessionId,
        resetSelection: true,
      });
      return;
    }
    let cancelled = false;
    const resetSelection = workspaceSessionIdRef.current !== sessionId;
    workspaceSessionIdRef.current = sessionId;
    if (!selectedRunner) {
      dispatch({
        type: "sessionWorkspaceUnavailable",
        sessionId,
        resetSelection,
      });
      return;
    }
    const requestId = nextFileTreeRequestId();
    dispatch({
      type: "sessionWorkspaceLoading",
      sessionId,
      resetSelection,
      requestId,
    });

    void apiRef.current
      .fetchFileTree(sessionId, { path: ".", depth: 1, requestId })
      .then((fileTree) => {
        if (!cancelled) {
          dispatch({
            type: "fileTreeLoaded",
            sessionId,
            path: ".",
            files: fileTree,
            requestId,
          });
        }
      })
      .catch((fileError: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "fileTreeFailed",
            sessionId,
            path: ".",
            message: errorMessage(fileError),
            requestId,
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
    selectedSession?.worktreeDeletedAt,
    selectedRunner?.runnerId,
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
      gitBaseRef?: string;
      gitBranchName?: string;
      attachments?: ImageAttachmentUpload[];
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

  const renameSelectedSession = async (title: string) => {
    if (!selectedSession || !apiRef.current) {
      throw new Error("API client is not ready.");
    }
    try {
      const session = await apiRef.current.updateSession(selectedSession.id, {
        title,
      });
      dispatch({
        type: "serverEventReceived",
        event: { type: "session:updated", session },
      });
    } catch (renameError: unknown) {
      const message = errorMessage(renameError);
      dispatch({ type: "errorChanged", message });
      throw new Error(message);
    }
  };

  const sendMessage = async (
    content: string,
    attachments: ImageAttachmentUpload[] = [],
  ) => {
    if (!selectedSession || !apiRef.current) {
      throw new Error("API client is not ready.");
    }
    if (!streamRef.current || streamRef.current.readyState !== WebSocket.OPEN) {
      dispatch({
        type: "errorChanged",
        title: "Event stream is disconnected",
        message:
          "Message was not sent. Reload the page, then check that your login session and /v1/stream are connected.",
      });
      throw new Error("Event stream is disconnected.");
    }
    try {
      const result = await apiRef.current.createUserMessage(
        selectedSession.id,
        {
          content,
          attachments,
        },
      );
      dispatch({
        type: "serverEventReceived",
        event: { type: "message:created", message: result.message },
      });
      for (const attachment of result.attachments) {
        dispatch({
          type: "serverEventReceived",
          event: { type: "message_attachment:created", attachment },
        });
      }
    } catch (sendError: unknown) {
      const message = errorMessage(sendError);
      dispatch({ type: "errorChanged", message });
      throw new Error(message);
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
    const api = apiRef.current;
    if (!selectedSession || !api) return;
    const sessionId = selectedSession.id;
    const openPath = state.selectedFilePath;
    const patch = buildPatchFromHunks(
      sessionHunks.filter((hunk) => hunk.status === "accepted"),
    );
    const approvalIdsToResolve = appliedPatchApprovalIds(
      sessionHunks,
      sessionId,
    );
    if (!patch) {
      dispatch({
        type: "errorChanged",
        message: "No accepted patch hunks are ready to apply.",
      });
      return;
    }

    dispatch({ type: "patchApplyStarted" });
    void api
      .applyPatch(sessionId, patch)
      .then((result) => {
        dispatch({
          type: "patchApplySucceeded",
          sessionId,
          applied: result.applied,
          message: result.message,
        });
        if (result.applied) {
          for (const approvalId of approvalIdsToResolve) {
            void api
              .resolveApproval(approvalId, true)
              .then((approval) =>
                dispatch({ type: "approvalUpserted", approval }),
              )
              .catch((approvalError: unknown) =>
                dispatch({
                  type: "errorChanged",
                  title: "Patch approval sync failed",
                  message: errorMessage(approvalError),
                }),
              );
          }
        }
        if (openPath) {
          loadFileContent(sessionId, openPath);
        }
        if (result.applied) {
          const fileTree = state.filesBySession[sessionId] ?? [];
          for (const path of new Set(
            sessionHunks
              .filter((hunk) => hunk.status === "accepted")
              .map((hunk) =>
                nearestTreeDirectoryPath(
                  fileTree,
                  parentDirectory(hunk.filePath),
                ),
              ),
          )) {
            loadFileTreePath(sessionId, path, { force: true });
          }
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
          "Control signal was not sent. Reload the page, then check that your login session and /v1/stream are connected.",
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

  const selectFile = (path: string) => {
    if (!selectedSession || !apiRef.current) return;
    loadFileContent(selectedSession.id, path);
  };

  const loadSelectedDirectory = (path: string) => {
    if (!selectedSession || !apiRef.current) return;
    loadFileTreePath(selectedSession.id, path, { force: true });
  };

  const refreshSelectedFileTree = () => {
    if (!selectedSession || !apiRef.current) return;
    loadFileTreePath(selectedSession.id, ".", { force: true, resetTree: true });
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
        loadFileTreePath(
          sessionId,
          nearestTreeDirectoryPath(
            state.filesBySession[sessionId] ?? [],
            parentDirectory(path),
          ),
          { force: true },
        );
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

  const loadFileTreePath = (
    sessionId: string,
    path: string,
    options: { force?: boolean; resetTree?: boolean } = {},
  ) => {
    if (!apiRef.current) return;
    if (
      !options.force &&
      state.fileTreePathState[sessionId]?.[path] === "ready"
    ) {
      return;
    }
    const requestId = nextFileTreeRequestId();
    dispatch({
      type: "fileTreePathLoading",
      sessionId,
      path,
      requestId,
      ...(options.resetTree === undefined
        ? {}
        : { resetTree: options.resetTree }),
    });
    void apiRef.current
      .fetchFileTree(sessionId, { path, depth: 1, requestId })
      .then((fileTree) =>
        dispatch({
          type: "fileTreeLoaded",
          sessionId,
          path,
          files: fileTree,
          requestId,
        }),
      )
      .catch((fileError: unknown) =>
        dispatch({
          type: "fileTreeFailed",
          sessionId,
          path,
          message: errorMessage(fileError),
          requestId,
        }),
      );
  };

  const requireApiClient = useCallback(() => {
    if (!apiRef.current) {
      throw new Error("API client is not ready.");
    }
    return apiRef.current;
  }, []);

  const checkSelectedSessionStatus = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId) {
      return;
    }
    setCheckingSessionStatusId(sessionId);
    try {
      const session = await requireApiClient().checkSessionStatus(sessionId);
      dispatch({
        type: "serverEventReceived",
        event: { type: "session:updated", session },
      });
    } catch (statusError: unknown) {
      dispatch({
        type: "errorChanged",
        title: "Session status check failed",
        message: errorMessage(statusError),
      });
    } finally {
      setCheckingSessionStatusId((currentSessionId) =>
        currentSessionId === sessionId ? undefined : currentSessionId,
      );
    }
  }, [requireApiClient, selectedSession?.id]);

  const fetchMessageAttachmentContent = useCallback(
    async (sessionId: string, attachmentId: string) => {
      return requireApiClient().fetchMessageAttachmentContent(
        sessionId,
        attachmentId,
      );
    },
    [requireApiClient],
  );

  const fetchRunnerDirectoryTree = useCallback(
    async (runnerId: string, options: { path?: string; depth?: number } = {}) =>
      requireApiClient().fetchRunnerDirectoryTree(runnerId, options),
    [requireApiClient],
  );

  const createRunnerDirectory = useCallback(
    async (runnerId: string, input: { parentPath: string; name: string }) =>
      requireApiClient().createRunnerDirectory(runnerId, input),
    [requireApiClient],
  );

  const listAgentSkills = useCallback(
    async (input: ApiAgentSkillList) => {
      return requireApiClient().listAgentSkills(input);
    },
    [requireApiClient],
  );

  const searchWorkspacePaths = useCallback(
    async (input: ApiPathSearch) => {
      return requireApiClient().searchWorkspacePaths(input);
    },
    [requireApiClient],
  );

  const fetchGitStatus = useCallback(
    async (context: ApiGitContext) => {
      const api = requireApiClient();
      try {
        return await api.fetchGitStatus(context);
      } catch (gitError: unknown) {
        const message = errorMessage(gitError);
        if (!isNonGitRepositoryError(message)) {
          dispatch({
            type: "errorChanged",
            title: "Git status failed",
            message,
          });
        }
        throw new Error(message);
      }
    },
    [requireApiClient],
  );

  const fetchGitDiff = useCallback(
    async (query: ApiGitFileDiffQuery) => {
      const api = requireApiClient();
      try {
        return await api.fetchGitDiff(query);
      } catch (gitError: unknown) {
        const message = errorMessage(gitError);
        dispatch({ type: "errorChanged", title: "Git diff failed", message });
        throw new Error(message);
      }
    },
    [requireApiClient],
  );

  const fetchGitBlame = useCallback(
    async (query: ApiGitBlameQuery) => {
      const api = requireApiClient();
      try {
        return await api.fetchGitBlame(query);
      } catch (gitError: unknown) {
        const message = errorMessage(gitError);
        dispatch({ type: "errorChanged", title: "Git blame failed", message });
        throw new Error(message);
      }
    },
    [requireApiClient],
  );

  const fetchGitHistory = useCallback(
    async (query: ApiGitHistoryQuery) => {
      const api = requireApiClient();
      try {
        return await api.fetchGitHistory(query);
      } catch (gitError: unknown) {
        const message = errorMessage(gitError);
        dispatch({
          type: "errorChanged",
          title: "Git history failed",
          message,
        });
        throw new Error(message);
      }
    },
    [requireApiClient],
  );

  const fetchGitBranches = useCallback(
    async (context: ApiGitContext) => {
      const api = requireApiClient();
      try {
        return await api.fetchGitBranches(context);
      } catch (gitError: unknown) {
        const message = errorMessage(gitError);
        dispatch({
          type: "errorChanged",
          title: "Git branches failed",
          message,
        });
        throw new Error(message);
      }
    },
    [requireApiClient],
  );

  const fetchGitJobs = useCallback(
    async (projectId: string) => {
      const api = requireApiClient();
      return api.fetchGitJobs(projectId);
    },
    [requireApiClient],
  );

  const runGitJob = useCallback(
    async (
      run: () => Promise<Awaited<ReturnType<RoamApiClient["stageGitPaths"]>>>,
    ) => {
      try {
        const job = await run();
        if (job.status === "failed") {
          dispatch({
            type: "errorChanged",
            title: "Git operation failed",
            message: job.errorSummary ?? `${job.operation} failed`,
          });
        }
        return job;
      } catch (gitError: unknown) {
        const message = errorMessage(gitError);
        dispatch({
          type: "errorChanged",
          title: "Git operation failed",
          message,
        });
        throw new Error(message);
      }
    },
    [],
  );

  const initGitRepository = useCallback(
    (input: ApiGitInit) =>
      runGitJob(() => requireApiClient().initGitRepository(input)),
    [requireApiClient, runGitJob],
  );
  const stageGitPaths = useCallback(
    (input: ApiGitPaths) =>
      runGitJob(() => requireApiClient().stageGitPaths(input)),
    [requireApiClient, runGitJob],
  );
  const unstageGitPaths = useCallback(
    (input: ApiGitPaths) =>
      runGitJob(() => requireApiClient().unstageGitPaths(input)),
    [requireApiClient, runGitJob],
  );
  const discardGitPaths = useCallback(
    (input: ApiGitPaths) =>
      runGitJob(() => requireApiClient().discardGitPaths(input)),
    [requireApiClient, runGitJob],
  );
  const commitGitChanges = useCallback(
    (input: ApiGitCommit) =>
      runGitJob(() => requireApiClient().commitGitChanges(input)),
    [requireApiClient, runGitJob],
  );
  const runGitRemoteOperation = useCallback(
    (input: ApiGitRemoteOperation) =>
      runGitJob(() => requireApiClient().runGitRemoteOperation(input)),
    [requireApiClient, runGitJob],
  );
  const removeGitWorktree = useCallback(
    (input: ApiGitRemoveWorktree) =>
      runGitJob(() => requireApiClient().removeGitWorktree(input)),
    [requireApiClient, runGitJob],
  );

  const sessionMessages = selectedSession
    ? state.messages
        .filter((message) => message.sessionId === selectedSession.id)
        .map((message) =>
          toUiMessage(
            message,
            state.messageAttachments.filter(
              (attachment) => attachment.messageId === message.id,
            ),
          ),
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
  const sessionFiles = selectedSession
    ? (state.filesBySession[selectedSession.id] ?? [])
    : [];
  const sessionFileTreeState = selectedSession
    ? (state.fileTreeState[selectedSession.id] ?? "idle")
    : "idle";
  const sessionFileTreePathState = selectedSession
    ? (state.fileTreePathState[selectedSession.id] ?? {})
    : {};
  const sessionStatusCheckState: "idle" | "loading" =
    checkingSessionStatusId === selectedSession?.id ? "loading" : "idle";

  return {
    state,
    authView,
    accountSecurity,
    streamReconnect,
    reconnectStream,
    setupOwner,
    loginOwner,
    logoutOwner,
    logoutAllOwnerSessions,
    changeOwnerPassword,
    regenerateRunnerToken,
    refreshAccountSecurity,
    sessionStatusCheckState,
    checkSelectedSessionStatus,
    dispatch,
    selectedRunner,
    selectedProject,
    selectedGitContext,
    runnerSessions: projectSessions,
    selectedSession,
    sessionMessages,
    sessionApprovals,
    sessionHunks,
    sessionFiles,
    sessionFileTreeState,
    sessionFileTreePathState,
    runnerCommand: buildRunnerCommand(accountSecurity?.runnerToken ?? ""),
    selectRunner,
    selectProject,
    createProject,
    archiveProject,
    createSession,
    renameSelectedSession,
    sendMessage,
    resolveApproval,
    resolveHunk,
    applyAcceptedPatch,
    sendControl,
    deleteSelectedSession,
    selectFile,
    loadSelectedDirectory,
    refreshSelectedFileTree,
    saveSelectedFile,
    fetchMessageAttachmentContent,
    fetchRunnerDirectoryTree,
    createRunnerDirectory,
    listAgentSkills,
    searchWorkspacePaths,
    fetchGitStatus,
    fetchGitDiff,
    fetchGitBlame,
    fetchGitHistory,
    fetchGitBranches,
    fetchGitJobs,
    initGitRepository,
    stageGitPaths,
    unstageGitPaths,
    discardGitPaths,
    commitGitChanges,
    runGitRemoteOperation,
    removeGitWorktree,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthErrorMessage(message: string): boolean {
  return (
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("setup_required")
  );
}

function authViewFromErrorMessage(
  message: string,
): Extract<AuthViewState, "setup_required" | "login"> {
  return message.includes("setup_required") ? "setup_required" : "login";
}

function isNonGitRepositoryError(message: string): boolean {
  return message.toLowerCase().includes("not a git repository");
}

function hydrateInitialSelection(state: AppState): AppState {
  const selection = loadLastSelection();
  return selection
    ? {
        ...state,
        selectedProjectId: selection.projectId,
        selectedSessionId: selection.sessionId,
      }
    : state;
}

function nextFileTreeRequestId(): string {
  fileTreeRequestSequence += 1;
  return `file-tree-${Date.now()}-${fileTreeRequestSequence}`;
}

function isActiveSessionStatus(status: SessionStatus): boolean {
  return (
    status === "pending" ||
    status === "running" ||
    status === "waiting_approval"
  );
}
