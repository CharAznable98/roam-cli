import type {
  Approval,
  Artifact,
  FileContentResult,
  FileNode,
  MessageAttachment,
  Project,
  RunnerRegistration,
  ServerEvent,
  Session,
} from "@roamcli/shared/protocol";
import {
  appendTokenMessage,
  type UiMessage,
  upsertMessage,
} from "../features/conversation/model";
import {
  appliedPatchApprovalIds,
  extractPatchHunks,
  mergePatchHunks,
  type SessionPatchHunk,
} from "../features/approvals/model";
import { omitKey, upsertBy } from "../shared/lib/collections";
import type { AsyncState } from "../shared/types/async";
import type { InitialRemoteState } from "../api/contracts";
import type { WorkspaceTab } from "./navigation";
import { replaceTreeChildren } from "../features/files/tree-model";

export type LoadState = "loading" | "ready" | "error";
export type ConnectionState = "open" | "closed" | "error";

export interface AppNotification {
  id: string;
  tone: "error";
  title: string;
  message: string;
}

export interface AppState {
  activeTab: WorkspaceTab;
  projects: Project[];
  runners: RunnerRegistration[];
  sessions: Session[];
  messages: UiMessage[];
  approvals: Approval[];
  artifacts: Artifact[];
  messageAttachments: MessageAttachment[];
  hunks: SessionPatchHunk[];
  filesBySession: Record<string, FileNode[]>;
  fileTreeState: Record<string, AsyncState>;
  fileTreePathState: Record<string, Record<string, AsyncState>>;
  selectedFilePath: string;
  fileContent: FileContentResult | undefined;
  editorContent: string;
  fileContentState: AsyncState;
  fileSaveState: AsyncState;
  patchApplyState: AsyncState;
  selectedProjectId: string;
  selectedRunnerId: string;
  selectedSessionId: string;
  mobileNewSessionOpen: boolean;
  loadState: LoadState;
  connectionState: ConnectionState;
  notifications: AppNotification[];
}

export const initialAppState: AppState = {
  activeTab: "chat",
  projects: [],
  runners: [],
  sessions: [],
  messages: [],
  approvals: [],
  artifacts: [],
  messageAttachments: [],
  hunks: [],
  filesBySession: {},
  fileTreeState: {},
  fileTreePathState: {},
  selectedFilePath: "",
  fileContent: undefined,
  editorContent: "",
  fileContentState: "idle",
  fileSaveState: "idle",
  patchApplyState: "idle",
  selectedProjectId: "",
  selectedRunnerId: "",
  selectedSessionId: "",
  mobileNewSessionOpen: false,
  loadState: "loading",
  connectionState: "closed",
  notifications: [],
};

export type AppAction =
  | { type: "activeTabChanged"; tab: WorkspaceTab }
  | { type: "mobileNewSessionOpenChanged"; open: boolean }
  | { type: "bootstrapStarted" }
  | { type: "bootstrapSucceeded"; remote: InitialRemoteState }
  | { type: "bootstrapFailed"; message: string }
  | { type: "connectionChanged"; status: ConnectionState }
  | { type: "projectSelected"; projectId: string; nextSessionId: string }
  | { type: "projectCreated"; project: Project }
  | { type: "projectUpdated"; project: Project }
  | { type: "runnerSelected"; runnerId: string; nextSessionId: string }
  | { type: "sessionSelected"; sessionId: string }
  | { type: "sessionCreated"; session: Session }
  | { type: "sessionDeleted"; sessionId: string }
  | { type: "sessionWorkspaceCleared" }
  | {
      type: "sessionWorkspaceUnavailable";
      sessionId: string;
      resetSelection: boolean;
    }
  | { type: "approvalUpserted"; approval: Approval }
  | {
      type: "hunkResolved";
      hunkId: string;
      status: "accepted" | "rejected";
    }
  | { type: "patchApplyStarted" }
  | {
      type: "patchApplySucceeded";
      sessionId: string;
      applied: boolean;
      message: string;
    }
  | { type: "patchApplyFailed"; message: string }
  | {
      type: "sessionWorkspaceLoading";
      sessionId: string;
      resetSelection: boolean;
    }
  | {
      type: "fileTreePathLoading";
      sessionId: string;
      path: string;
      resetTree?: boolean;
    }
  | {
      type: "fileTreeLoaded";
      sessionId: string;
      path: string;
      files: FileNode[];
    }
  | {
      type: "fileTreeFailed";
      sessionId: string;
      path: string;
      message: string;
    }
  | { type: "fileContentLoading"; path: string }
  | { type: "fileContentLoaded"; result: FileContentResult }
  | { type: "fileContentFailed"; message: string }
  | { type: "editorContentChanged"; content: string }
  | { type: "fileSaveStarted" }
  | { type: "fileSaveSucceeded" }
  | { type: "fileSaveFailed"; message: string }
  | { type: "serverEventReceived"; event: ServerEvent }
  | { type: "errorChanged"; title?: string; message: string | undefined }
  | { type: "notificationDismissed"; id: string };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "activeTabChanged":
      return { ...state, activeTab: action.tab };
    case "mobileNewSessionOpenChanged":
      return { ...state, mobileNewSessionOpen: action.open };
    case "bootstrapStarted":
      return { ...state, loadState: "loading" };
    case "bootstrapSucceeded": {
      const onlineRunnerIds = new Set(
        action.remote.runners.map((runner) => runner.runnerId),
      );
      const selectedProjectId =
        action.remote.projects.find(
          (project) =>
            project.id === state.selectedProjectId && !project.archivedAt,
        )?.id ??
        action.remote.projects.find(
          (project) =>
            !project.archivedAt && onlineRunnerIds.has(project.runnerId),
        )?.id ??
        action.remote.projects.find((project) => !project.archivedAt)?.id ??
        "";
      const selectedSessionId =
        action.remote.sessions.find(
          (session) =>
            session.id === state.selectedSessionId &&
            session.projectId === selectedProjectId &&
            !session.archivedAt,
        )?.id ??
        action.remote.sessions.find(
          (session) =>
            session.projectId === selectedProjectId && !session.archivedAt,
        )?.id ??
        "";
      const selectedProject = action.remote.projects.find(
        (project) => project.id === selectedProjectId,
      );
      const selectedRunnerId = action.remote.runners.some(
        (runner) => runner.runnerId === state.selectedRunnerId,
      )
        ? state.selectedRunnerId
        : selectedProject && onlineRunnerIds.has(selectedProject.runnerId)
          ? selectedProject.runnerId
          : action.remote.runners[0]?.runnerId || "";
      return {
        ...state,
        projects: action.remote.projects,
        runners: action.remote.runners,
        sessions: action.remote.sessions,
        messages: action.remote.messages,
        messageAttachments: action.remote.messageAttachments ?? [],
        approvals: action.remote.approvals,
        artifacts: action.remote.artifacts,
        hunks: extractPatchHunks(action.remote.approvals),
        selectedRunnerId,
        selectedProjectId,
        selectedSessionId,
        loadState: "ready",
      };
    }
    case "bootstrapFailed":
      return pushNotification(
        { ...state, loadState: "error" },
        "RoamCli API request failed",
        action.message,
      );
    case "connectionChanged":
      return { ...state, connectionState: action.status };
    case "projectSelected":
      return {
        ...state,
        selectedProjectId: action.projectId,
        selectedSessionId: action.nextSessionId,
      };
    case "projectCreated":
      return {
        ...state,
        projects: upsertBy(state.projects, action.project, (item) => item.id),
        selectedProjectId: action.project.id,
        selectedSessionId: "",
      };
    case "projectUpdated":
      return updateProjectState(state, action.project);
    case "runnerSelected":
      return {
        ...state,
        selectedRunnerId: action.runnerId,
        selectedSessionId: action.nextSessionId,
      };
    case "sessionSelected":
      return { ...state, selectedSessionId: action.sessionId };
    case "sessionCreated":
      return {
        ...state,
        sessions: upsertBy(state.sessions, action.session, (item) => item.id),
        selectedProjectId: action.session.projectId,
        selectedSessionId: action.session.id,
        activeTab: "chat",
        mobileNewSessionOpen: false,
      };
    case "sessionDeleted":
      return removeSessionState(state, action.sessionId);
    case "sessionWorkspaceCleared":
      return {
        ...state,
        selectedFilePath: "",
        fileContent: undefined,
        editorContent: "",
        fileContentState: "idle",
        fileSaveState: "idle",
      };
    case "sessionWorkspaceUnavailable":
      return {
        ...state,
        selectedFilePath: action.resetSelection ? "" : state.selectedFilePath,
        fileContent: action.resetSelection ? undefined : state.fileContent,
        editorContent: action.resetSelection ? "" : state.editorContent,
        fileContentState: action.resetSelection
          ? "idle"
          : state.fileContentState,
        fileSaveState: action.resetSelection ? "idle" : state.fileSaveState,
        filesBySession: action.resetSelection
          ? omitKey(state.filesBySession, action.sessionId)
          : state.filesBySession,
        fileTreeState: {
          ...state.fileTreeState,
          [action.sessionId]: "idle",
        },
        fileTreePathState: action.resetSelection
          ? omitKey(state.fileTreePathState, action.sessionId)
          : state.fileTreePathState,
      };
    case "approvalUpserted":
      return upsertApprovalState(state, action.approval);
    case "hunkResolved":
      return {
        ...state,
        hunks: state.hunks.map((hunk) =>
          hunk.id === action.hunkId ? { ...hunk, status: action.status } : hunk,
        ),
      };
    case "patchApplyStarted":
      return { ...state, patchApplyState: "loading" };
    case "patchApplySucceeded": {
      const appliedApprovalIds = action.applied
        ? new Set(appliedPatchApprovalIds(state.hunks, action.sessionId))
        : new Set<string>();
      return {
        ...state,
        patchApplyState: action.applied ? "ready" : "error",
        approvals: state.approvals.map((approval) =>
          appliedApprovalIds.has(approval.id) &&
          approval.kind === "applyPatch" &&
          approval.status === "pending"
            ? { ...approval, status: "approved" }
            : approval,
        ),
        notifications: action.applied
          ? state.notifications
          : nextNotifications(
              state.notifications,
              "Patch was not applied",
              action.message,
            ),
        hunks: state.hunks.map((hunk) =>
          hunk.sessionId === action.sessionId && hunk.status === "accepted"
            ? { ...hunk, status: action.applied ? "edited" : "pending" }
            : hunk,
        ),
      };
    }
    case "patchApplyFailed":
      return pushNotification(
        { ...state, patchApplyState: "error" },
        "Patch request failed",
        action.message,
      );
    case "sessionWorkspaceLoading":
      return {
        ...state,
        selectedFilePath: action.resetSelection ? "" : state.selectedFilePath,
        fileContent: action.resetSelection ? undefined : state.fileContent,
        editorContent: action.resetSelection ? "" : state.editorContent,
        fileContentState: action.resetSelection
          ? "idle"
          : state.fileContentState,
        fileSaveState: action.resetSelection ? "idle" : state.fileSaveState,
        fileTreeState: {
          ...state.fileTreeState,
          [action.sessionId]: "loading",
        },
        fileTreePathState: {
          ...state.fileTreePathState,
          [action.sessionId]: { ".": "loading" },
        },
      };
    case "fileTreePathLoading":
      return {
        ...state,
        filesBySession: action.resetTree
          ? omitKey(state.filesBySession, action.sessionId)
          : state.filesBySession,
        fileTreeState: {
          ...state.fileTreeState,
          [action.sessionId]:
            action.path === "."
              ? "loading"
              : (state.fileTreeState[action.sessionId] ?? "ready"),
        },
        fileTreePathState: {
          ...state.fileTreePathState,
          [action.sessionId]: {
            ...(action.resetTree
              ? {}
              : state.fileTreePathState[action.sessionId]),
            [action.path]: "loading",
          },
        },
      };
    case "fileTreeLoaded":
      if (!isFileTreePathLoading(state, action.sessionId, action.path)) {
        return state;
      }
      return applyLoadedFileTree(
        state,
        action.sessionId,
        action.path,
        action.files,
      );
    case "fileTreeFailed":
      return pushNotification(
        {
          ...state,
          fileTreeState: {
            ...state.fileTreeState,
            [action.sessionId]:
              action.path === "."
                ? "error"
                : (state.fileTreeState[action.sessionId] ?? "ready"),
          },
          fileTreePathState: {
            ...state.fileTreePathState,
            [action.sessionId]: {
              ...state.fileTreePathState[action.sessionId],
              [action.path]: "error",
            },
          },
        },
        "File tree request failed",
        action.message,
      );
    case "fileContentLoading":
      return {
        ...state,
        selectedFilePath: action.path,
        fileContent: undefined,
        editorContent: "",
        fileContentState: "loading",
        fileSaveState: "idle",
      };
    case "fileContentLoaded":
      return action.result.sessionId === state.selectedSessionId &&
        action.result.path === state.selectedFilePath
        ? {
            ...state,
            fileContent: action.result,
            editorContent:
              action.result.kind === undefined || action.result.kind === "text"
                ? action.result.content
                : "",
            fileContentState: "ready",
          }
        : state;
    case "fileContentFailed":
      return pushNotification(
        { ...state, fileContentState: "error" },
        "File content request failed",
        action.message,
      );
    case "editorContentChanged":
      return { ...state, editorContent: action.content };
    case "fileSaveStarted":
      return { ...state, fileSaveState: "loading" };
    case "fileSaveSucceeded":
      return { ...state, fileSaveState: "ready" };
    case "fileSaveFailed":
      return pushNotification(
        { ...state, fileSaveState: "error" },
        "File save failed",
        action.message,
      );
    case "serverEventReceived":
      return applyServerEvent(state, action.event);
    case "errorChanged":
      if (action.message === undefined) {
        return state;
      }
      return pushNotification(
        state,
        action.title ?? "RoamCli request failed",
        action.message,
      );
    case "notificationDismissed":
      return {
        ...state,
        notifications: state.notifications.filter(
          (notification) => notification.id !== action.id,
        ),
      };
  }
}

function applyServerEvent(state: AppState, event: ServerEvent): AppState {
  if (event.type === "runner:online") {
    return {
      ...state,
      runners: upsertBy(
        state.runners,
        event.runner,
        (runner) => runner.runnerId,
      ),
      selectedRunnerId: state.selectedRunnerId || event.runner.runnerId,
    };
  }
  if (event.type === "runner:offline") {
    return {
      ...state,
      runners: state.runners.filter(
        (runner) => runner.runnerId !== event.runnerId,
      ),
    };
  }
  if (event.type === "project:created") {
    return {
      ...state,
      projects: upsertBy(state.projects, event.project, (item) => item.id),
      selectedProjectId: state.selectedProjectId || event.project.id,
    };
  }
  if (event.type === "project:updated") {
    return updateProjectState(state, event.project);
  }
  if (event.type === "session:created" || event.type === "session:updated") {
    return {
      ...state,
      sessions: upsertBy(state.sessions, event.session, (item) => item.id),
      selectedProjectId: state.selectedProjectId || event.session.projectId,
      selectedSessionId: state.selectedSessionId || event.session.id,
    };
  }
  if (event.type === "session:deleted") {
    return removeSessionState(state, event.sessionId);
  }
  if (event.type === "message:created") {
    return {
      ...state,
      messages: upsertMessage(state.messages, event.message),
    };
  }
  if (event.type === "message_attachment:created") {
    return {
      ...state,
      messageAttachments: upsertBy(
        state.messageAttachments,
        event.attachment,
        (item) => item.id,
      ),
    };
  }
  if (event.type === "token") {
    return {
      ...state,
      messages: appendTokenMessage(
        state.messages,
        event.sessionId,
        event.content,
      ),
    };
  }
  if (
    event.type === "approval:requested" ||
    event.type === "approval:updated"
  ) {
    return upsertApprovalState(state, event.approval);
  }
  if (event.type === "artifact:created") {
    return {
      ...state,
      artifacts: upsertBy(state.artifacts, event.artifact, (item) => item.id),
    };
  }
  if (event.type === "file:tree") {
    const path = event.result.root.path;
    if (!isFileTreePathLoading(state, event.result.sessionId, path)) {
      return state;
    }
    return applyLoadedFileTree(
      state,
      event.result.sessionId,
      path,
      event.result.root.children ?? [event.result.root],
    );
  }
  if (
    event.type === "file:content" &&
    event.result.sessionId === state.selectedSessionId &&
    event.result.path === state.selectedFilePath
  ) {
    return {
      ...state,
      fileContent: event.result,
      editorContent:
        event.result.kind === undefined || event.result.kind === "text"
          ? event.result.content
          : "",
      fileContentState: "ready",
    };
  }
  if (
    event.type === "file:written" &&
    event.result.sessionId === state.selectedSessionId &&
    event.result.path === state.selectedFilePath
  ) {
    return { ...state, fileSaveState: "ready" };
  }
  if (event.type === "patch:applied") {
    return event.result.applied
      ? { ...state, patchApplyState: "ready" }
      : pushNotification(
          { ...state, patchApplyState: "error" },
          "Patch was not applied",
          event.result.message,
        );
  }
  if (event.type === "error") {
    return pushNotification(state, "Runner request failed", event.message);
  }
  return state;
}

function updateProjectState(state: AppState, project: Project): AppState {
  const projects = project.archivedAt
    ? state.projects.filter((item) => item.id !== project.id)
    : upsertBy(state.projects, project, (item) => item.id);
  const selectedProjectId = project.archivedAt
    ? state.selectedProjectId === project.id
      ? ""
      : state.selectedProjectId
    : state.selectedProjectId || projects[0]?.id || "";
  const selectedSessionId =
    state.selectedProjectId === project.id && project.archivedAt
      ? ""
      : state.selectedSessionId;
  return {
    ...state,
    projects,
    selectedProjectId,
    selectedSessionId,
  };
}

function removeSessionState(state: AppState, sessionId: string): AppState {
  return {
    ...state,
    sessions: state.sessions.filter((session) => session.id !== sessionId),
    selectedSessionId:
      state.selectedSessionId === sessionId ? "" : state.selectedSessionId,
    messages: state.messages.filter(
      (message) => message.sessionId !== sessionId,
    ),
    messageAttachments: state.messageAttachments.filter(
      (attachment) => attachment.sessionId !== sessionId,
    ),
    approvals: state.approvals.filter(
      (approval) => approval.sessionId !== sessionId,
    ),
    artifacts: state.artifacts.filter(
      (artifact) => artifact.sessionId !== sessionId,
    ),
    hunks: state.hunks.filter((hunk) => hunk.sessionId !== sessionId),
    filesBySession: omitKey(state.filesBySession, sessionId),
    fileTreeState: omitKey(state.fileTreeState, sessionId),
    fileTreePathState: omitKey(state.fileTreePathState, sessionId),
  };
}

function isFileTreePathLoading(
  state: AppState,
  sessionId: string,
  path: string,
): boolean {
  return state.fileTreePathState[sessionId]?.[path] === "loading";
}

function applyLoadedFileTree(
  state: AppState,
  sessionId: string,
  path: string,
  files: FileNode[],
): AppState {
  return {
    ...state,
    filesBySession: {
      ...state.filesBySession,
      [sessionId]: replaceTreeChildren(
        state.filesBySession[sessionId] ?? [],
        path,
        files,
      ),
    },
    fileTreeState: {
      ...state.fileTreeState,
      [sessionId]: "ready",
    },
    fileTreePathState: {
      ...state.fileTreePathState,
      [sessionId]: {
        ...pruneDescendantPathStates(
          state.fileTreePathState[sessionId] ?? {},
          path,
        ),
        [path]: "ready",
      },
    },
  };
}

function pruneDescendantPathStates(
  pathStates: Record<string, AsyncState>,
  path: string,
): Record<string, AsyncState> {
  if (path === ".") {
    return {};
  }
  const prefix = `${path}/`;
  return Object.fromEntries(
    Object.entries(pathStates).filter(([candidate]) => {
      return candidate !== path && !candidate.startsWith(prefix);
    }),
  );
}

function upsertApprovalState(state: AppState, approval: Approval): AppState {
  return {
    ...state,
    approvals: upsertBy(state.approvals, approval, (item) => item.id),
    hunks: mergePatchHunks(state.hunks, extractPatchHunks([approval])),
  };
}

let notificationSequence = 0;

function pushNotification(
  state: AppState,
  title: string,
  message: string,
): AppState {
  return {
    ...state,
    notifications: nextNotifications(state.notifications, title, message),
  };
}

function nextNotifications(
  notifications: AppNotification[],
  title: string,
  message: string,
): AppNotification[] {
  const key = notificationKey(title, message);
  const deduped = notifications.filter(
    (notification) =>
      notificationKey(notification.title, notification.message) !== key,
  );
  notificationSequence += 1;
  return [
    ...deduped,
    {
      id: `notification-${Date.now()}-${notificationSequence}`,
      tone: "error" as const,
      title,
      message,
    },
  ].slice(-3);
}

function notificationKey(title: string, message: string): string {
  return `${title}\n${message}`;
}
