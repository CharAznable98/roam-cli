import type {
  Approval,
  Artifact,
  FileContentResult,
  FileNode,
  Message,
  RunnerRegistration,
  ServerEvent,
  Session,
} from "@roamcli/protocol";
import {
  appendTokenMessage,
  type UiMessage,
  upsertMessage,
} from "../features/conversation/model";
import {
  extractPatchHunks,
  mergePatchHunks,
  type SessionPatchHunk,
} from "../features/approvals/model";
import { appendTerminalChunk } from "../features/terminal/model";
import { omitKey, upsertBy } from "../shared/lib/collections";
import type { AsyncState } from "../shared/types/async";
import type { InitialRemoteState } from "../api/contracts";
import type { WorkspaceTab } from "./navigation";

export type LoadState = "loading" | "ready" | "error";
export type ConnectionState = "open" | "closed" | "error";

export interface AppError {
  title: string;
  message: string;
}

export interface AppState {
  activeTab: WorkspaceTab;
  runners: RunnerRegistration[];
  sessions: Session[];
  messages: UiMessage[];
  approvals: Approval[];
  artifacts: Artifact[];
  hunks: SessionPatchHunk[];
  filesBySession: Record<string, FileNode[]>;
  fileTreeState: Record<string, AsyncState>;
  selectedFilePath: string;
  fileContent: FileContentResult | undefined;
  editorContent: string;
  fileContentState: AsyncState;
  fileSaveState: AsyncState;
  terminalLines: Record<string, string[]>;
  patchApplyState: AsyncState;
  selectedRunnerId: string;
  selectedSessionId: string;
  mobileNewSessionOpen: boolean;
  loadState: LoadState;
  connectionState: ConnectionState;
  error: AppError | undefined;
}

export const initialAppState: AppState = {
  activeTab: "chat",
  runners: [],
  sessions: [],
  messages: [],
  approvals: [],
  artifacts: [],
  hunks: [],
  filesBySession: {},
  fileTreeState: {},
  selectedFilePath: "",
  fileContent: undefined,
  editorContent: "",
  fileContentState: "idle",
  fileSaveState: "idle",
  terminalLines: {},
  patchApplyState: "idle",
  selectedRunnerId: "",
  selectedSessionId: "",
  mobileNewSessionOpen: false,
  loadState: "loading",
  connectionState: "closed",
  error: undefined,
};

export type AppAction =
  | { type: "activeTabChanged"; tab: WorkspaceTab }
  | { type: "mobileNewSessionOpenChanged"; open: boolean }
  | { type: "bootstrapStarted" }
  | { type: "bootstrapSucceeded"; remote: InitialRemoteState }
  | { type: "bootstrapFailed"; message: string }
  | { type: "connectionChanged"; status: ConnectionState }
  | { type: "runnerSelected"; runnerId: string; nextSessionId: string }
  | { type: "sessionSelected"; sessionId: string }
  | { type: "sessionCreated"; session: Session }
  | { type: "sessionDeleted"; sessionId: string }
  | { type: "sessionWorkspaceCleared" }
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
  | { type: "sessionWorkspaceLoading"; sessionId: string }
  | { type: "fileTreeLoaded"; sessionId: string; files: FileNode[] }
  | { type: "fileTreeFailed"; sessionId: string; message: string }
  | { type: "fileContentLoading"; path: string }
  | { type: "fileContentLoaded"; result: FileContentResult }
  | { type: "fileContentFailed"; message: string }
  | { type: "editorContentChanged"; content: string }
  | { type: "fileSaveStarted" }
  | { type: "fileSaveSucceeded" }
  | { type: "fileSaveFailed"; message: string }
  | { type: "serverEventReceived"; event: ServerEvent }
  | { type: "errorChanged"; title?: string; message: string | undefined };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "activeTabChanged":
      return { ...state, activeTab: action.tab };
    case "mobileNewSessionOpenChanged":
      return { ...state, mobileNewSessionOpen: action.open };
    case "bootstrapStarted":
      return { ...state, loadState: "loading", error: undefined };
    case "bootstrapSucceeded":
      return {
        ...state,
        runners: action.remote.runners,
        sessions: action.remote.sessions,
        messages: action.remote.messages,
        approvals: action.remote.approvals,
        artifacts: action.remote.artifacts,
        hunks: extractPatchHunks(action.remote.approvals),
        selectedRunnerId:
          state.selectedRunnerId || action.remote.runners[0]?.runnerId || "",
        selectedSessionId:
          state.selectedSessionId || action.remote.sessions[0]?.id || "",
        loadState: "ready",
      };
    case "bootstrapFailed":
      return {
        ...state,
        loadState: "error",
        error: makeError("RoamCli API request failed", action.message),
      };
    case "connectionChanged":
      return { ...state, connectionState: action.status };
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
    case "patchApplySucceeded":
      return {
        ...state,
        patchApplyState: action.applied ? "ready" : "error",
        error: action.applied
          ? state.error
          : makeError("Patch was not applied", action.message),
        hunks: state.hunks.map((hunk) =>
          hunk.sessionId === action.sessionId && hunk.status === "accepted"
            ? { ...hunk, status: action.applied ? "edited" : "pending" }
            : hunk,
        ),
      };
    case "patchApplyFailed":
      return {
        ...state,
        patchApplyState: "error",
        error: makeError("Patch request failed", action.message),
      };
    case "sessionWorkspaceLoading":
      return {
        ...state,
        selectedFilePath: "",
        fileContent: undefined,
        editorContent: "",
        fileContentState: "idle",
        fileSaveState: "idle",
        fileTreeState: {
          ...state.fileTreeState,
          [action.sessionId]: "loading",
        },
      };
    case "fileTreeLoaded":
      return {
        ...state,
        filesBySession: {
          ...state.filesBySession,
          [action.sessionId]: action.files,
        },
        fileTreeState: {
          ...state.fileTreeState,
          [action.sessionId]: "ready",
        },
      };
    case "fileTreeFailed":
      return {
        ...state,
        error: makeError("File tree request failed", action.message),
        fileTreeState: {
          ...state.fileTreeState,
          [action.sessionId]: "error",
        },
      };
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
            editorContent: action.result.content,
            fileContentState: "ready",
          }
        : state;
    case "fileContentFailed":
      return {
        ...state,
        fileContentState: "error",
        error: makeError("File content request failed", action.message),
      };
    case "editorContentChanged":
      return { ...state, editorContent: action.content };
    case "fileSaveStarted":
      return { ...state, fileSaveState: "loading" };
    case "fileSaveSucceeded":
      return { ...state, fileSaveState: "ready" };
    case "fileSaveFailed":
      return {
        ...state,
        fileSaveState: "error",
        error: makeError("File save failed", action.message),
      };
    case "serverEventReceived":
      return applyServerEvent(state, action.event);
    case "errorChanged":
      return {
        ...state,
        error: makeError(
          action.title ?? "RoamCli request failed",
          action.message,
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
  if (event.type === "session:created" || event.type === "session:updated") {
    return {
      ...state,
      sessions: upsertBy(state.sessions, event.session, (item) => item.id),
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
  if (event.type === "terminal:data") {
    return {
      ...state,
      terminalLines: {
        ...state.terminalLines,
        [event.sessionId]: appendTerminalChunk(
          state.terminalLines[event.sessionId] ?? [],
          event.chunk,
        ),
      },
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
    return {
      ...state,
      filesBySession: {
        ...state.filesBySession,
        [event.result.sessionId]: event.result.root.children ?? [
          event.result.root,
        ],
      },
      fileTreeState: {
        ...state.fileTreeState,
        [event.result.sessionId]: "ready",
      },
    };
  }
  if (
    event.type === "file:content" &&
    event.result.sessionId === state.selectedSessionId &&
    event.result.path === state.selectedFilePath
  ) {
    return {
      ...state,
      fileContent: event.result,
      editorContent: event.result.content,
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
    return {
      ...state,
      patchApplyState: event.result.applied ? "ready" : "error",
      error: event.result.applied
        ? state.error
        : makeError("Patch was not applied", event.result.message),
    };
  }
  if (event.type === "error") {
    return {
      ...state,
      error: makeError("Runner request failed", event.message),
    };
  }
  return state;
}

function makeError(
  title: string,
  message: string | undefined,
): AppError | undefined {
  return message === undefined ? undefined : { title, message };
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
    approvals: state.approvals.filter(
      (approval) => approval.sessionId !== sessionId,
    ),
    artifacts: state.artifacts.filter(
      (artifact) => artifact.sessionId !== sessionId,
    ),
    hunks: state.hunks.filter((hunk) => hunk.sessionId !== sessionId),
    filesBySession: omitKey(state.filesBySession, sessionId),
    fileTreeState: omitKey(state.fileTreeState, sessionId),
    terminalLines: omitKey(state.terminalLines, sessionId),
  };
}

function upsertApprovalState(state: AppState, approval: Approval): AppState {
  return {
    ...state,
    approvals: upsertBy(state.approvals, approval, (item) => item.id),
    hunks: mergePatchHunks(state.hunks, extractPatchHunks([approval])),
  };
}
