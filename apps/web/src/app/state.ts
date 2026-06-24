import type {
  AgentActivity,
  Approval,
  Artifact,
  FileContentResult,
  FileNode,
  FileTreeResult,
  Message,
  MessageAttachment,
  Project,
  RunnerRegistration,
  ServerEvent,
  Session,
} from "@roamcli/shared/protocol";
import { type UiMessage, upsertMessage } from "../features/conversation/model";
import {
  appliedPatchApprovalIds,
  extractPatchHunks,
  mergePatchHunks,
  type SessionPatchHunk,
} from "../features/approvals/model";
import { omitKey, upsertBy } from "../shared/lib/collections";
import type { AsyncState } from "../shared/types/async";
import type {
  InitialRemoteState,
  SessionDetailPayload,
} from "../api/contracts";
import type { WorkspaceTab } from "./navigation";
import { replaceTreeChildren } from "../features/files/tree-model";

export type LoadState = "loading" | "ready" | "error";
export type ConnectionState = "open" | "closed" | "error";

export interface AppNotification {
  id: string;
  tone: "error" | "success";
  title: string;
  message: string;
}

export interface AppState {
  activeTab: WorkspaceTab;
  projects: Project[];
  runners: RunnerRegistration[];
  sessions: Session[];
  messages: UiMessage[];
  activities: AgentActivity[];
  approvals: Approval[];
  artifacts: Artifact[];
  messageAttachments: MessageAttachment[];
  hunks: SessionPatchHunk[];
  filesBySession: Record<string, FileNode[]>;
  fileTreeState: Record<string, AsyncState>;
  fileTreePathState: Record<string, Record<string, AsyncState>>;
  fileTreeRequestIds: Record<string, Record<string, string>>;
  staleFileTreeRequestIds: Record<string, true>;
  selectedFilePath: string;
  fileContent: FileContentResult | undefined;
  editorContent: string;
  fileEditMode: boolean;
  fileContentState: AsyncState;
  fileSaveState: AsyncState;
  patchApplyState: AsyncState;
  selectedProjectId: string;
  selectedRunnerId: string;
  selectedSessionId: string;
  mobileNewSessionOpen: boolean;
  archivingSessionIds: Record<string, true>;
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
  activities: [],
  approvals: [],
  artifacts: [],
  messageAttachments: [],
  hunks: [],
  filesBySession: {},
  fileTreeState: {},
  fileTreePathState: {},
  fileTreeRequestIds: {},
  staleFileTreeRequestIds: {},
  selectedFilePath: "",
  fileContent: undefined,
  editorContent: "",
  fileEditMode: false,
  fileContentState: "idle",
  fileSaveState: "idle",
  patchApplyState: "idle",
  selectedProjectId: "",
  selectedRunnerId: "",
  selectedSessionId: "",
  mobileNewSessionOpen: false,
  archivingSessionIds: {},
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
  | { type: "sessionArchiveStarted"; sessionId: string }
  | { type: "sessionArchiveFinished"; sessionId: string }
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
      requestId?: string;
    }
  | {
      type: "fileTreePathLoading";
      sessionId: string;
      path: string;
      resetTree?: boolean;
      requestId?: string;
    }
  | {
      type: "fileTreeLoaded";
      sessionId: string;
      path: string;
      files: FileNode[];
      requestId?: string;
    }
  | {
      type: "fileTreeFailed";
      sessionId: string;
      path: string;
      message: string;
      requestId?: string;
    }
  | {
      type: "fileContentLoading";
      sessionId: string;
      path: string;
      edit?: boolean;
    }
  | { type: "fileContentLoaded"; result: FileContentResult }
  | {
      type: "fileContentFailed";
      sessionId: string;
      path: string;
      message: string;
    }
  | { type: "editorContentChanged"; content: string }
  | { type: "fileEditStarted" }
  | { type: "fileEditCancelled" }
  | { type: "fileSaveStarted" }
  | { type: "fileSaveSucceeded" }
  | { type: "fileSaveFailed"; message: string }
  | { type: "serverEventReceived"; event: ServerEvent }
  | { type: "sessionDetailMerged"; detail: SessionDetailPayload }
  | {
      type: "notificationPushed";
      tone: AppNotification["tone"];
      title: string;
      message: string;
    }
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
      const activeProjects = action.remote.projects.filter(
        (project) => !project.archivedAt,
      );
      const activeSessions = action.remote.sessions.filter(
        (session) => !session.archivedAt,
      );
      const cachedProject = activeProjects.find(
        (project) => project.id === state.selectedProjectId,
      );
      const cachedSession = cachedProject
        ? activeSessions.find(
            (session) =>
              session.id === state.selectedSessionId &&
              session.projectId === cachedProject.id,
          )
        : undefined;
      const defaultSelection = selectDefaultProjectSession(
        {
          ...state,
          runners: action.remote.runners,
          sessions: action.remote.sessions,
        },
        activeProjects,
      );
      const selectedProjectId = cachedProject
        ? cachedProject.id
        : defaultSelection.selectedProjectId;
      const selectedSessionId = cachedProject
        ? (cachedSession?.id ??
          activeSessions.find(
            (session) => session.projectId === cachedProject.id,
          )?.id ??
          "")
        : defaultSelection.selectedSessionId;
      const selectedProject = action.remote.projects.find(
        (project) => project.id === selectedProjectId,
      );
      const onlineRunnerIds = new Set(
        action.remote.runners.map((runner) => runner.runnerId),
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
        activities: action.remote.activities ?? [],
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
        "error",
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
    case "sessionSelected": {
      const session = state.sessions.find(
        (item) => item.id === action.sessionId && !item.archivedAt,
      );
      return session
        ? {
            ...state,
            selectedProjectId: session.projectId,
            selectedSessionId: session.id,
          }
        : state;
    }
    case "sessionCreated":
      return {
        ...state,
        sessions: upsertBy(state.sessions, action.session, (item) => item.id),
        selectedProjectId: action.session.projectId,
        selectedSessionId: action.session.id,
        activeTab: "chat",
        mobileNewSessionOpen: false,
      };
    case "sessionArchiveStarted":
      return {
        ...state,
        archivingSessionIds: {
          ...state.archivingSessionIds,
          [action.sessionId]: true,
        },
      };
    case "sessionArchiveFinished":
      return {
        ...state,
        archivingSessionIds: omitKey(
          state.archivingSessionIds,
          action.sessionId,
        ),
      };
    case "sessionDeleted":
      return removeSessionState(state, action.sessionId);
    case "sessionWorkspaceCleared":
      return {
        ...state,
        selectedFilePath: "",
        fileContent: undefined,
        editorContent: "",
        fileEditMode: false,
        fileContentState: "idle",
        fileSaveState: "idle",
      };
    case "sessionWorkspaceUnavailable": {
      const removedRequestIds = action.resetSelection
        ? Object.values(state.fileTreeRequestIds[action.sessionId] ?? {})
        : [];
      return {
        ...state,
        selectedFilePath: action.resetSelection ? "" : state.selectedFilePath,
        fileContent: action.resetSelection ? undefined : state.fileContent,
        editorContent: action.resetSelection ? "" : state.editorContent,
        fileEditMode: action.resetSelection ? false : state.fileEditMode,
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
        fileTreeRequestIds: action.resetSelection
          ? omitKey(state.fileTreeRequestIds, action.sessionId)
          : state.fileTreeRequestIds,
        staleFileTreeRequestIds: markStaleFileTreeRequestIds(
          state.staleFileTreeRequestIds,
          removedRequestIds,
        ),
      };
    }
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
              "error",
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
        "error",
        "Patch request failed",
        action.message,
      );
    case "sessionWorkspaceLoading":
      return {
        ...state,
        selectedFilePath: action.resetSelection ? "" : state.selectedFilePath,
        fileContent: action.resetSelection ? undefined : state.fileContent,
        editorContent: action.resetSelection ? "" : state.editorContent,
        fileEditMode: action.resetSelection ? false : state.fileEditMode,
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
        ...nextFileTreeRequestTracking(
          state,
          action.sessionId,
          ".",
          action.requestId,
          true,
        ),
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
        ...nextFileTreeRequestTracking(
          state,
          action.sessionId,
          action.path,
          action.requestId,
          action.resetTree === true,
        ),
      };
    case "fileTreeLoaded":
      if (
        !isCurrentFileTreeRequest(
          state,
          action.sessionId,
          action.path,
          action.requestId,
        )
      ) {
        return state;
      }
      return applyLoadedFileTree(
        state,
        action.sessionId,
        action.path,
        action.files,
      );
    case "fileTreeFailed":
      if (
        !isCurrentFileTreeRequest(
          state,
          action.sessionId,
          action.path,
          action.requestId,
        )
      ) {
        return state;
      }
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
          fileTreeRequestIds: removeFileTreeRequestId(
            state.fileTreeRequestIds,
            action.sessionId,
            action.path,
          ),
          staleFileTreeRequestIds: markStaleFileTreeRequestIds(
            state.staleFileTreeRequestIds,
            action.requestId === undefined ? [] : [action.requestId],
          ),
        },
        "error",
        "File tree request failed",
        action.message,
      );
    case "fileContentLoading":
      return {
        ...state,
        selectedFilePath: action.path,
        fileContent: undefined,
        editorContent: "",
        fileEditMode: action.edit === true,
        fileContentState: "loading",
        fileSaveState: "idle",
      };
    case "fileContentLoaded":
      return action.result.sessionId === state.selectedSessionId &&
        action.result.path === state.selectedFilePath
        ? {
            ...state,
            fileContent: action.result,
            editorContent: textFileContent(action.result) ?? "",
            fileEditMode:
              state.fileEditMode && isEditableFileContent(action.result),
            fileContentState: "ready",
          }
        : state;
    case "fileContentFailed":
      if (
        action.sessionId !== state.selectedSessionId ||
        action.path !== state.selectedFilePath ||
        state.fileContentState !== "loading"
      ) {
        return state;
      }
      return pushNotification(
        { ...state, fileEditMode: false, fileContentState: "error" },
        "error",
        "File content request failed",
        action.message,
      );
    case "editorContentChanged":
      return { ...state, editorContent: action.content };
    case "fileEditStarted":
      return { ...state, fileEditMode: true };
    case "fileEditCancelled":
      return {
        ...state,
        editorContent: state.fileContent
          ? (textFileContent(state.fileContent) ?? "")
          : state.editorContent,
        fileEditMode: false,
        fileSaveState: "idle",
      };
    case "fileSaveStarted":
      return { ...state, fileSaveState: "loading" };
    case "fileSaveSucceeded":
      return { ...state, fileSaveState: "ready" };
    case "fileSaveFailed":
      return pushNotification(
        { ...state, fileSaveState: "error" },
        "error",
        "File save failed",
        action.message,
      );
    case "serverEventReceived":
      return applyServerEvent(state, action.event);
    case "sessionDetailMerged":
      return mergeSessionDetailState(state, action.detail);
    case "notificationPushed":
      return pushNotification(state, action.tone, action.title, action.message);
    case "errorChanged":
      if (action.message === undefined) {
        return state;
      }
      return pushNotification(
        state,
        "error",
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

function mergeSessionDetailState(
  state: AppState,
  detail: SessionDetailPayload,
): AppState {
  const attachments = detail.attachments ?? [];
  const approvals = detail.approvals ?? [];
  const artifacts = detail.artifacts ?? [];
  const mergedApprovals = approvals.reduce(
    (items, approval) => upsertFreshApproval(items, approval),
    state.approvals,
  );
  const detailApprovalIds = new Set(approvals.map((approval) => approval.id));
  const freshDetailApprovals = mergedApprovals.filter((approval) =>
    detailApprovalIds.has(approval.id),
  );
  return {
    ...state,
    sessions: upsertFreshSession(state.sessions, detail.session),
    messages: mergeDetailMessages(state.messages, detail.messages),
    activities: mergeDetailActivities(
      state.activities,
      detail.activities ?? [],
    ),
    messageAttachments: attachments.reduce(
      (items, attachment) => upsertBy(items, attachment, (item) => item.id),
      state.messageAttachments,
    ),
    approvals: mergedApprovals,
    artifacts: artifacts.reduce(
      (items, artifact) => upsertBy(items, artifact, (item) => item.id),
      state.artifacts,
    ),
    hunks: mergePatchHunks(
      state.hunks,
      extractPatchHunks(freshDetailApprovals),
    ),
    selectedProjectId: state.selectedProjectId || detail.session.projectId,
    selectedSessionId: state.selectedSessionId || detail.session.id,
  };
}

function upsertFreshSession(items: Session[], next: Session): Session[] {
  const exists = items.some((item) => item.id === next.id);
  return exists
    ? items.map((item) =>
        item.id === next.id ? freshSession(item, next) : item,
      )
    : [next, ...items];
}

function freshSession(current: Session, next: Session): Session {
  return Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
    ? current
    : next;
}

function upsertFreshApproval(items: Approval[], next: Approval): Approval[] {
  const exists = items.some((item) => item.id === next.id);
  return exists
    ? items.map((item) =>
        item.id === next.id ? freshApproval(item, next) : item,
      )
    : [next, ...items];
}

function freshApproval(current: Approval, next: Approval): Approval {
  if (current.status !== "pending" && next.status === "pending") {
    return current;
  }

  const currentResolvedAt = current.resolvedAt
    ? Date.parse(current.resolvedAt)
    : undefined;
  const nextResolvedAt = next.resolvedAt
    ? Date.parse(next.resolvedAt)
    : undefined;
  if (currentResolvedAt !== undefined || nextResolvedAt !== undefined) {
    if (nextResolvedAt === undefined) {
      return current;
    }
    if (currentResolvedAt === undefined) {
      return next;
    }
    return nextResolvedAt < currentResolvedAt ? current : next;
  }

  return next;
}

function mergeDetailMessages(
  currentMessages: UiMessage[],
  detailMessages: Message[],
): UiMessage[] {
  return detailMessages.reduce((messages, message) => {
    const { messages: reconciledMessages, message: reconciledMessage } =
      reconcileStreamMessage(messages, message);
    return upsertMessage(
      reconciledMessages,
      preserveLongerStreamContent(reconciledMessages, reconciledMessage),
    );
  }, currentMessages);
}

function mergeDetailActivities(
  currentActivities: AgentActivity[],
  detailActivities: AgentActivity[],
): AgentActivity[] {
  return detailActivities.reduce(
    (activities, activity) => upsertAgentActivity(activities, activity),
    currentActivities,
  );
}

function upsertAgentActivity(
  activities: AgentActivity[],
  next: AgentActivity,
): AgentActivity[] {
  const exists = activities.some((activity) => activity.id === next.id);
  const merged = exists
    ? activities.map((activity) => (activity.id === next.id ? next : activity))
    : [...activities, next];
  return merged.sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}

function reconcileStreamMessage(
  messages: UiMessage[],
  message: Message,
): { messages: UiMessage[]; message: Message } {
  if (!isPersistedStreamMessage(message)) {
    return { messages, message };
  }

  const placeholderIndex = findMatchingStreamPlaceholderIndex(
    messages,
    message,
  );
  const placeholder = messages[placeholderIndex];
  if (!placeholder) {
    return { messages, message };
  }

  return {
    messages: messages.filter((_, index) => index !== placeholderIndex),
    message:
      message.streaming === true &&
      placeholder.content.length > message.content.length
        ? { ...message, content: placeholder.content }
        : message,
  };
}

function findMatchingStreamPlaceholderIndex(
  messages: UiMessage[],
  persistedMessage: Message,
): number {
  const persistedBoundaryId = latestStreamBoundaryIdBeforeMessage(
    messages,
    persistedMessage,
  );
  return messages.findIndex(
    (message, index) =>
      isClientStreamPlaceholder(message, persistedMessage.sessionId) &&
      latestStreamBoundaryIdBeforeIndex(
        messages,
        index,
        persistedMessage.sessionId,
      ) === persistedBoundaryId,
  );
}

function latestStreamBoundaryIdBeforeMessage(
  messages: UiMessage[],
  message: Message,
): string | undefined {
  const messageTime = Date.parse(message.createdAt);
  if (!Number.isFinite(messageTime)) {
    return undefined;
  }

  return messages.reduce<UiMessage | undefined>((latest, candidate) => {
    if (!isStreamSegmentBoundary(candidate, message.sessionId)) {
      return latest;
    }
    const candidateTime = Date.parse(candidate.createdAt);
    if (!Number.isFinite(candidateTime) || candidateTime > messageTime) {
      return latest;
    }
    if (!latest || Date.parse(latest.createdAt) <= candidateTime) {
      return candidate;
    }
    return latest;
  }, undefined)?.id;
}

function latestStreamBoundaryIdBeforeIndex(
  messages: UiMessage[],
  index: number,
  sessionId: string,
): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message && isStreamSegmentBoundary(message, sessionId)) {
      return message.id;
    }
  }
  return undefined;
}

function isStreamSegmentBoundary(
  message: UiMessage,
  sessionId: string,
): boolean {
  return (
    message.sessionId === sessionId &&
    !isClientStreamPlaceholder(message, sessionId) &&
    !isPersistedStreamMessage(message)
  );
}

function preserveLongerStreamContent(
  messages: UiMessage[],
  message: Message,
): Message {
  if (!isPersistedStreamMessage(message)) {
    return message;
  }
  if (message.streaming !== true) {
    return message;
  }

  const existingMessage = messages.find((item) => item.id === message.id);
  if (
    existingMessage &&
    existingMessage.content.length > message.content.length
  ) {
    return { ...message, content: existingMessage.content };
  }
  return message;
}

function isPersistedStreamMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.id.startsWith(`stream_${message.sessionId}_`)
  );
}

function isClientStreamPlaceholder(
  message: UiMessage,
  sessionId: string,
): boolean {
  return (
    message.role === "assistant" &&
    message.id.startsWith(`stream-${sessionId}-`)
  );
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
      sessions: upsertFreshSession(state.sessions, event.session),
      selectedProjectId: state.selectedProjectId || event.session.projectId,
      selectedSessionId: state.selectedSessionId || event.session.id,
    };
  }
  if (event.type === "session:deleted") {
    return removeSessionState(state, event.sessionId);
  }
  if (event.type === "message:created" || event.type === "message:updated") {
    return {
      ...state,
      messages: upsertMessage(state.messages, event.message),
    };
  }
  if (event.type === "activity:created") {
    return {
      ...state,
      activities: upsertAgentActivity(state.activities, event.activity),
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
    const requestId = fileTreeRequestGeneration(event.result);
    if (
      !shouldApplyFileTreeEvent(state, event.result.sessionId, path, requestId)
    ) {
      return state;
    }
    return applyLoadedFileTree(
      state,
      event.result.sessionId,
      path,
      event.result.root.children ?? [],
      {
        staleAncestorRequests: !isTrackedFileTreeRequest(
          state,
          event.result.sessionId,
          requestId,
        ),
      },
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
      editorContent: textFileContent(event.result) ?? "",
      fileEditMode: state.fileEditMode && isEditableFileContent(event.result),
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
          "error",
          "Patch was not applied",
          event.result.message,
        );
  }
  if (event.type === "error") {
    if (
      event.sessionId &&
      (!state.sessions.some((session) => session.id === event.sessionId) ||
        (event.code === "SESSION_NOT_RUNNING" &&
          state.archivingSessionIds[event.sessionId]))
    ) {
      return state;
    }
    return pushNotification(
      state,
      "error",
      "Runner request failed",
      event.message,
    );
  }
  return state;
}

function updateProjectState(state: AppState, project: Project): AppState {
  const projects = project.archivedAt
    ? state.projects.filter((item) => item.id !== project.id)
    : upsertBy(state.projects, project, (item) => item.id);
  const archivedSelectedProject =
    Boolean(project.archivedAt) && state.selectedProjectId === project.id;
  const fallbackSelection = archivedSelectedProject
    ? selectDefaultProjectSession(state, projects)
    : undefined;
  const selectedProjectId = fallbackSelection
    ? fallbackSelection.selectedProjectId
    : project.archivedAt
      ? state.selectedProjectId
      : state.selectedProjectId || projects[0]?.id || "";
  const selectedSessionId = fallbackSelection
    ? fallbackSelection.selectedSessionId
    : state.selectedSessionId;
  return {
    ...state,
    projects,
    selectedProjectId,
    selectedSessionId,
  };
}

function selectDefaultProjectSession(
  state: AppState,
  projects: Project[],
): Pick<AppState, "selectedProjectId" | "selectedSessionId"> {
  const onlineRunnerIds = new Set(
    state.runners.map((runner) => runner.runnerId),
  );
  const activeSessions = state.sessions.filter(
    (session) => !session.archivedAt,
  );
  const selectedProjectId =
    projects.find((project) => onlineRunnerIds.has(project.runnerId))?.id ??
    projects[0]?.id ??
    "";
  const selectedSessionId =
    activeSessions.find((session) => session.projectId === selectedProjectId)
      ?.id ?? "";
  return { selectedProjectId, selectedSessionId };
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
    activities: state.activities.filter(
      (activity) => activity.sessionId !== sessionId,
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
    fileTreeRequestIds: omitKey(state.fileTreeRequestIds, sessionId),
    archivingSessionIds: omitKey(state.archivingSessionIds, sessionId),
  };
}

function isCurrentFileTreeRequest(
  state: AppState,
  sessionId: string,
  path: string,
  requestId: string | undefined,
): boolean {
  if (requestId === undefined) {
    return state.fileTreePathState[sessionId]?.[path] === "loading";
  }
  if (state.staleFileTreeRequestIds[requestId]) {
    return false;
  }
  return state.fileTreeRequestIds[sessionId]?.[path] === requestId;
}

function isTrackedFileTreeRequest(
  state: AppState,
  sessionId: string,
  requestId: string,
): boolean {
  return Object.values(state.fileTreeRequestIds[sessionId] ?? {}).includes(
    requestId,
  );
}

function fileTreeRequestGeneration(result: FileTreeResult): string {
  return result.clientRequestId ?? result.requestId;
}

function shouldApplyFileTreeEvent(
  state: AppState,
  sessionId: string,
  path: string,
  requestId: string,
): boolean {
  if (state.staleFileTreeRequestIds[requestId]) {
    return false;
  }
  if (path !== "." && state.fileTreePathState[sessionId]?.["."] === "loading") {
    return false;
  }
  // Broadcasts that survive the stale/root guards may supersede pending local
  // loads; applyLoadedFileTree prunes the covered request ids.
  return true;
}

function isFileTreePathLoading(
  state: AppState,
  sessionId: string,
  path: string,
): boolean {
  return state.fileTreePathState[sessionId]?.[path] === "loading";
}

type PrunePathEntries = <T>(
  entriesByPath: Record<string, T>,
  path: string,
) => Record<string, T>;

function applyLoadedFileTree(
  state: AppState,
  sessionId: string,
  path: string,
  files: FileNode[],
  options: { staleAncestorRequests?: boolean } = {},
): AppState {
  const requestIdsByPath = state.fileTreeRequestIds[sessionId] ?? {};
  const pruneCoveredPathEntries: PrunePathEntries =
    options.staleAncestorRequests
      ? pruneOverlappingPathEntries
      : pruneDescendantPathEntries;
  const removedRequestIds = options.staleAncestorRequests
    ? overlappingPathEntryValues(requestIdsByPath, path)
    : descendantPathEntryValues(requestIdsByPath, path);
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
        ...pruneCoveredPathEntries(
          state.fileTreePathState[sessionId] ?? {},
          path,
        ),
        [path]: "ready",
      },
    },
    fileTreeRequestIds: pruneFileTreeRequestIds(
      state.fileTreeRequestIds,
      sessionId,
      path,
      pruneCoveredPathEntries,
    ),
    staleFileTreeRequestIds: markStaleFileTreeRequestIds(
      state.staleFileTreeRequestIds,
      removedRequestIds,
    ),
  };
}

function nextFileTreeRequestTracking(
  state: AppState,
  sessionId: string,
  path: string,
  requestId: string | undefined,
  resetTree: boolean,
): Pick<AppState, "fileTreeRequestIds" | "staleFileTreeRequestIds"> {
  if (requestId === undefined) {
    return {
      fileTreeRequestIds: state.fileTreeRequestIds,
      staleFileTreeRequestIds: state.staleFileTreeRequestIds,
    };
  }

  const currentSessionRequests = state.fileTreeRequestIds[sessionId] ?? {};
  const replacedRequestIds = resetTree
    ? Object.values(currentSessionRequests)
    : [currentSessionRequests[path]].filter(
        (value): value is string => value !== undefined,
      );
  const staleFileTreeRequestIds = markStaleFileTreeRequestIds(
    state.staleFileTreeRequestIds,
    replacedRequestIds.filter((value) => value !== requestId),
  );
  return {
    fileTreeRequestIds: {
      ...state.fileTreeRequestIds,
      [sessionId]: {
        ...(resetTree ? {} : currentSessionRequests),
        [path]: requestId,
      },
    },
    staleFileTreeRequestIds,
  };
}

function markStaleFileTreeRequestIds(
  current: Record<string, true>,
  requestIds: string[],
): Record<string, true> {
  if (requestIds.length === 0) {
    return current;
  }
  return {
    ...current,
    ...Object.fromEntries(requestIds.map((requestId) => [requestId, true])),
  };
}

function removeFileTreeRequestId(
  requestIdsBySession: Record<string, Record<string, string>>,
  sessionId: string,
  path: string,
): Record<string, Record<string, string>> {
  return pruneFileTreeRequestIds(requestIdsBySession, sessionId, path);
}

function pruneFileTreeRequestIds(
  requestIdsBySession: Record<string, Record<string, string>>,
  sessionId: string,
  path: string,
  prunePathEntries: PrunePathEntries = pruneDescendantPathEntries,
): Record<string, Record<string, string>> {
  const sessionRequestIds = requestIdsBySession[sessionId];
  if (!sessionRequestIds) {
    return requestIdsBySession;
  }
  const nextSessionRequestIds = prunePathEntries(sessionRequestIds, path);
  if (Object.keys(nextSessionRequestIds).length === 0) {
    return omitKey(requestIdsBySession, sessionId);
  }
  return {
    ...requestIdsBySession,
    [sessionId]: nextSessionRequestIds,
  };
}

function pruneDescendantPathEntries<T>(
  entriesByPath: Record<string, T>,
  path: string,
): Record<string, T> {
  if (path === ".") {
    return {};
  }
  const prefix = `${path}/`;
  return Object.fromEntries(
    Object.entries(entriesByPath).filter(([candidate]) => {
      return candidate !== path && !candidate.startsWith(prefix);
    }),
  );
}

function pruneOverlappingPathEntries<T>(
  entriesByPath: Record<string, T>,
  path: string,
): Record<string, T> {
  if (path === ".") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(entriesByPath).filter(([candidate]) => {
      return !isOverlappingTreePath(candidate, path);
    }),
  );
}

function descendantPathEntryValues<T>(
  entriesByPath: Record<string, T>,
  path: string,
): T[] {
  if (path === ".") {
    return Object.values(entriesByPath);
  }
  const prefix = `${path}/`;
  return Object.entries(entriesByPath)
    .filter(([candidate]) => candidate === path || candidate.startsWith(prefix))
    .map(([, value]) => value);
}

function overlappingPathEntryValues<T>(
  entriesByPath: Record<string, T>,
  path: string,
): T[] {
  if (path === ".") {
    return Object.values(entriesByPath);
  }
  return Object.entries(entriesByPath)
    .filter(([candidate]) => isOverlappingTreePath(candidate, path))
    .map(([, value]) => value);
}

function isOverlappingTreePath(candidate: string, path: string): boolean {
  if (candidate === ".") {
    return false;
  }
  return (
    candidate === path ||
    candidate.startsWith(`${path}/`) ||
    path.startsWith(`${candidate}/`)
  );
}

function upsertApprovalState(state: AppState, approval: Approval): AppState {
  const approvals = upsertFreshApproval(state.approvals, approval);
  const freshApproval = approvals.find((item) => item.id === approval.id);
  return {
    ...state,
    approvals,
    hunks: freshApproval
      ? mergePatchHunks(state.hunks, extractPatchHunks([freshApproval]))
      : state.hunks,
  };
}

let notificationSequence = 0;

function pushNotification(
  state: AppState,
  tone: AppNotification["tone"],
  title: string,
  message: string,
): AppState {
  return {
    ...state,
    notifications: nextNotifications(state.notifications, tone, title, message),
  };
}

function nextNotifications(
  notifications: AppNotification[],
  tone: AppNotification["tone"],
  title: string,
  message: string,
): AppNotification[] {
  const key = notificationKey(tone, title, message);
  const deduped = notifications.filter(
    (notification) =>
      notificationKey(
        notification.tone,
        notification.title,
        notification.message,
      ) !== key,
  );
  notificationSequence += 1;
  return [
    ...deduped,
    {
      id: `notification-${Date.now()}-${notificationSequence}`,
      tone,
      title,
      message,
    },
  ].slice(-3);
}

function notificationKey(
  tone: AppNotification["tone"],
  title: string,
  message: string,
): string {
  return `${tone}\n${title}\n${message}`;
}

function textFileContent(content: FileContentResult): string | undefined {
  return content.kind === undefined || content.kind === "text"
    ? content.content
    : undefined;
}

function isEditableFileContent(content: FileContentResult): boolean {
  return textFileContent(content) !== undefined && !content.truncated;
}
