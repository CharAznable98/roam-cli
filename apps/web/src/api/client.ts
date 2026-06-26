import type {
  AccountSecurityState,
  AgentSkillListResult,
  AgentKind,
  ApiChangePassword,
  ApiAgentSkillList,
  ApiCreateProjectPromptPreset,
  ApiCreateProject,
  ApiCreateSession,
  ApiGitBlameQuery,
  ApiGitCommit,
  ApiGitCommitFilesQuery,
  ApiGitContext,
  ApiGitFileDiffQuery,
  ApiGitHistoryQuery,
  ApiGitInit,
  ApiGitPaths,
  ApiGitRemoteOperation,
  ApiGitRemoveWorktree,
  ApiPathSearch,
  ApiLogin,
  ApiSetupOwner,
  ApiUpdateProject,
  ApiUpdateProjectPromptPreset,
  ApiUpdateSession,
  AuthStatus,
  Approval,
  ClientCommand,
  DirectoryCreateResult,
  ExecutionMode,
  FileContentResult,
  FileNode,
  FileWriteResult,
  GitBlame,
  GitBranchList,
  GitCommitFiles,
  GitCommitPage,
  GitFileDiff,
  GitJob,
  GitStatusResult,
  ImageAttachmentUpload,
  Message,
  MessageAttachment,
  PatchApplyResult,
  PathSearchResult,
  Project,
  ProjectPromptPreset,
  RunnerRegistration,
  ServerEvent,
  Session,
} from "@roamcli/shared/protocol";
import type { InitialRemoteState, SessionDetailPayload } from "./contracts";
import { toUiMessage } from "../features/conversation/model";

export interface RoamApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

export interface RoamApiClient {
  fetchAuthStatus(): Promise<AuthStatus>;
  setupOwner(input: ApiSetupOwner): Promise<{
    auth: AuthStatus;
    account: AccountSecurityState;
  }>;
  login(input: ApiLogin): Promise<{
    auth: AuthStatus;
    account: AccountSecurityState;
  }>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  fetchAccountSecurity(): Promise<AccountSecurityState>;
  changePassword(input: ApiChangePassword): Promise<void>;
  regenerateRunnerToken(): Promise<AccountSecurityState>;
  loadInitialState(): Promise<InitialRemoteState>;
  fetchRunnerDirectoryTree(
    runnerId: string,
    options?: { path?: string; depth?: number },
  ): Promise<FileNode[]>;
  createRunnerDirectory(
    runnerId: string,
    input: { parentPath: string; name: string },
  ): Promise<DirectoryCreateResult>;
  createProject(input: ApiCreateProject): Promise<Project>;
  updateProject(projectId: string, input: ApiUpdateProject): Promise<Project>;
  archiveProject(projectId: string): Promise<Project>;
  restoreProject(projectId: string): Promise<Project>;
  fetchProjectPromptPresets(projectId: string): Promise<ProjectPromptPreset[]>;
  createProjectPromptPreset(
    projectId: string,
    input: ApiCreateProjectPromptPreset,
  ): Promise<ProjectPromptPreset>;
  updateProjectPromptPreset(
    projectId: string,
    presetId: string,
    input: ApiUpdateProjectPromptPreset,
  ): Promise<ProjectPromptPreset>;
  deleteProjectPromptPreset(projectId: string, presetId: string): Promise<void>;
  reorderProjectPromptPresets(
    projectId: string,
    presetIds: string[],
  ): Promise<ProjectPromptPreset[]>;
  createSession(input: {
    projectId: string;
    agent: AgentKind;
    executionMode?: ExecutionMode;
    gitBaseRef?: string;
    gitBranchName?: string;
    prompt: string;
    title?: string;
    attachments?: ImageAttachmentUpload[];
  }): Promise<Session>;
  createUserMessage(
    sessionId: string,
    input: { content: string; attachments?: ImageAttachmentUpload[] },
  ): Promise<{ message: Message; attachments: MessageAttachment[] }>;
  fetchSessionDetail(sessionId: string): Promise<SessionDetailPayload>;
  updateSession(sessionId: string, input: ApiUpdateSession): Promise<Session>;
  checkSessionStatus(sessionId: string): Promise<Session>;
  deleteSession(
    sessionId: string,
    options?: { worktree?: "keep" | "remove" },
  ): Promise<{ job?: GitJob }>;
  fetchMessageAttachmentContent(
    sessionId: string,
    attachmentId: string,
  ): Promise<Blob>;
  fetchFileTree(
    sessionId: string,
    options?: { path?: string; depth?: number; requestId?: string },
  ): Promise<FileNode[]>;
  fetchFileContent(
    sessionId: string,
    path: string,
    options?: { maxBytes?: number },
  ): Promise<FileContentResult>;
  saveFileContent(
    sessionId: string,
    path: string,
    content: string,
  ): Promise<FileWriteResult>;
  applyPatch(sessionId: string, patch: string): Promise<PatchApplyResult>;
  listAgentSkills(input: ApiAgentSkillList): Promise<AgentSkillListResult>;
  searchWorkspacePaths(input: ApiPathSearch): Promise<PathSearchResult>;
  fetchGitStatus(context: ApiGitContext): Promise<GitStatusResult>;
  fetchGitDiff(query: ApiGitFileDiffQuery): Promise<GitFileDiff>;
  fetchGitBlame(query: ApiGitBlameQuery): Promise<GitBlame>;
  fetchGitHistory(query: ApiGitHistoryQuery): Promise<GitCommitPage>;
  fetchGitCommitFiles(query: ApiGitCommitFilesQuery): Promise<GitCommitFiles>;
  fetchGitBranches(context: ApiGitContext): Promise<GitBranchList>;
  fetchGitJobs(projectId: string): Promise<GitJob[]>;
  initGitRepository(input: ApiGitInit): Promise<GitJob>;
  stageGitPaths(input: ApiGitPaths): Promise<GitJob>;
  unstageGitPaths(input: ApiGitPaths): Promise<GitJob>;
  discardGitPaths(input: ApiGitPaths): Promise<GitJob>;
  commitGitChanges(input: ApiGitCommit): Promise<GitJob>;
  runGitRemoteOperation(input: ApiGitRemoteOperation): Promise<GitJob>;
  removeGitWorktree(input: ApiGitRemoveWorktree): Promise<GitJob>;
  resolveApproval(approvalId: string, approved: boolean): Promise<Approval>;
  connectStream(
    onEvent: (event: ServerEvent) => void,
    onStatus?: (status: "open" | "closed" | "error") => void,
  ): WebSocket | undefined;
}

interface SessionsResponse {
  sessions: Session[];
}

interface RunnersResponse {
  runners: RunnerRegistration[];
}

interface ProjectsResponse {
  projects: Project[];
}

interface ProjectResponse {
  project: Project;
}

interface ProjectPromptPresetsResponse {
  presets: ProjectPromptPreset[];
}

interface ProjectPromptPresetResponse {
  preset: ProjectPromptPreset;
}

interface CreateSessionResponse {
  session: Session;
  attachments?: MessageAttachment[];
}

interface CreateMessageResponse {
  message: Message;
  attachments: MessageAttachment[];
}

interface SessionResponse {
  session: Session;
}

interface ApprovalResponse {
  approval: Approval;
}

interface FileTreeResponse {
  root?: FileNode;
  files?: FileNode[];
  result?: {
    root: FileNode;
  };
}

interface DirectoryCreateResponse {
  result: DirectoryCreateResult;
}

interface FileContentResponse {
  result: FileContentResult;
}

interface FileWriteResponse {
  result: FileWriteResult;
}

interface PatchApplyResponse {
  result: PatchApplyResult;
}

interface AgentSkillListResponse {
  result: AgentSkillListResult;
}

interface PathSearchResponse {
  result: PathSearchResult;
}

interface GitStatusResponse {
  result: GitStatusResult;
}

interface GitDiffResponse {
  result: GitFileDiff;
}

interface GitBlameResponse {
  result: GitBlame;
}

interface GitHistoryResponse {
  result: GitCommitPage;
}

interface GitCommitFilesResponse {
  result: GitCommitFiles;
}

interface GitBranchesResponse {
  result: GitBranchList;
}

interface GitJobResponse {
  job: GitJob;
}

interface GitJobsResponse {
  jobs: GitJob[];
}

interface AuthStatusResponse {
  auth: AuthStatus;
}

interface AuthAccountResponse {
  auth: AuthStatus;
  account: AccountSecurityState;
}

interface AccountSecurityResponse {
  account: AccountSecurityState;
}

export function createRoamApiClient(
  options: RoamApiOptions = {},
): RoamApiClient {
  const baseUrl = options.baseUrl ?? window.location.origin;
  const fetchImpl = options.fetchImpl ?? fetch;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
      credentials: init.credentials ?? "same-origin",
    });
    if (!response.ok) {
      const body = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      if (isHtmlResponse(contentType, body)) {
        throw new Error(formatUnexpectedResponse(path, contentType, body));
      }
      throw new Error(formatHttpError(path, response, body));
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const body = await response.text();
      throw new Error(formatUnexpectedResponse(path, contentType, body));
    }
    return (await response.json()) as T;
  }

  async function requestBlob(path: string): Promise<Blob> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error("Attachment is unavailable.");
    }
    return response.blob();
  }

  function fetchSessionDetail(
    sessionId: string,
  ): Promise<SessionDetailPayload> {
    return request<SessionDetailPayload>(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  return {
    async fetchAuthStatus() {
      const { auth } = await request<AuthStatusResponse>("/v1/auth/status");
      return auth;
    },

    async setupOwner(input) {
      return request<AuthAccountResponse>("/v1/auth/setup", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    async login(input) {
      return request<AuthAccountResponse>("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    async logout() {
      await request<void>("/v1/auth/logout", { method: "POST" });
    },

    async logoutAll() {
      await request<void>("/v1/auth/logout-all", { method: "POST" });
    },

    async fetchAccountSecurity() {
      const { account } =
        await request<AccountSecurityResponse>("/v1/auth/account");
      return account;
    },

    async changePassword(input) {
      await request<void>("/v1/auth/password", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    async regenerateRunnerToken() {
      const { account } = await request<AccountSecurityResponse>(
        "/v1/auth/runner-token/regenerate",
        {
          method: "POST",
          body: JSON.stringify({ confirm: true }),
        },
      );
      return account;
    },

    async loadInitialState() {
      const [{ runners }, { projects }, { sessions }] = await Promise.all([
        request<RunnersResponse>("/v1/runners"),
        request<ProjectsResponse>("/v1/projects"),
        request<SessionsResponse>("/v1/sessions"),
      ]);
      const details = await Promise.all(
        sessions.map((session) => fetchSessionDetail(session.id)),
      );
      return {
        projects,
        runners,
        sessions,
        messages: details.flatMap((detail) =>
          detail.messages.map((message) => toUiMessage(message)),
        ),
        activities: details.flatMap((detail) => detail.activities ?? []),
        messageAttachments: details.flatMap(
          (detail) => detail.attachments ?? [],
        ),
        approvals: details.flatMap((detail) => detail.approvals),
        artifacts: details.flatMap((detail) => detail.artifacts),
      };
    },

    async fetchRunnerDirectoryTree(runnerId, options = {}) {
      const query = new URLSearchParams();
      query.set("path", options.path ?? ".");
      query.set("depth", String(options.depth ?? 1));
      const payload = await request<FileTreeResponse>(
        `/v1/runners/${encodeURIComponent(runnerId)}/directories?${query.toString()}`,
      );
      const root = payload.result?.root ?? payload.root;
      return payload.files ?? root?.children ?? (root ? [root] : []);
    },

    async createRunnerDirectory(runnerId, input) {
      const { result } = await request<DirectoryCreateResponse>(
        `/v1/runners/${encodeURIComponent(runnerId)}/directories`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
      return result;
    },

    async createProject(input) {
      const { project } = await request<ProjectResponse>("/v1/projects", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return project;
    },

    async updateProject(projectId, input) {
      const { project } = await request<ProjectResponse>(
        `/v1/projects/${encodeURIComponent(projectId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      );
      return project;
    },

    async archiveProject(projectId) {
      const { project } = await request<ProjectResponse>(
        `/v1/projects/${encodeURIComponent(projectId)}/archive`,
        { method: "POST" },
      );
      return project;
    },

    async restoreProject(projectId) {
      const { project } = await request<ProjectResponse>(
        `/v1/projects/${encodeURIComponent(projectId)}/restore`,
        { method: "POST" },
      );
      return project;
    },

    async fetchProjectPromptPresets(projectId) {
      const { presets } = await request<ProjectPromptPresetsResponse>(
        `/v1/projects/${encodeURIComponent(projectId)}/prompt-presets`,
      );
      return presets;
    },

    async createProjectPromptPreset(projectId, input) {
      const { preset } = await request<ProjectPromptPresetResponse>(
        `/v1/projects/${encodeURIComponent(projectId)}/prompt-presets`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
      return preset;
    },

    async updateProjectPromptPreset(projectId, presetId, input) {
      const { preset } = await request<ProjectPromptPresetResponse>(
        `/v1/projects/${encodeURIComponent(projectId)}/prompt-presets/${encodeURIComponent(presetId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      );
      return preset;
    },

    async deleteProjectPromptPreset(projectId, presetId) {
      await request<void>(
        `/v1/projects/${encodeURIComponent(projectId)}/prompt-presets/${encodeURIComponent(presetId)}`,
        { method: "DELETE" },
      );
    },

    async reorderProjectPromptPresets(projectId, presetIds) {
      const { presets } = await request<ProjectPromptPresetsResponse>(
        `/v1/projects/${encodeURIComponent(projectId)}/prompt-presets/order`,
        {
          method: "PUT",
          body: JSON.stringify({ presetIds }),
        },
      );
      return presets;
    },

    async createSession(input) {
      const payload: ApiCreateSession = input.title
        ? {
            projectId: input.projectId,
            agent: input.agent,
            executionMode: input.executionMode ?? "direct",
            ...(input.gitBaseRef === undefined
              ? {}
              : { gitBaseRef: input.gitBaseRef }),
            ...(input.gitBranchName === undefined
              ? {}
              : { gitBranchName: input.gitBranchName }),
            prompt: input.prompt,
            attachments: input.attachments ?? [],
            title: input.title,
          }
        : {
            projectId: input.projectId,
            agent: input.agent,
            executionMode: input.executionMode ?? "direct",
            ...(input.gitBaseRef === undefined
              ? {}
              : { gitBaseRef: input.gitBaseRef }),
            ...(input.gitBranchName === undefined
              ? {}
              : { gitBranchName: input.gitBranchName }),
            prompt: input.prompt,
            attachments: input.attachments ?? [],
          };
      const { session } = await request<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return session;
    },

    async createUserMessage(sessionId, input) {
      return request<CreateMessageResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            content: input.content,
            attachments: input.attachments ?? [],
          }),
        },
      );
    },

    fetchSessionDetail,

    async updateSession(sessionId, input) {
      const { session } = await request<CreateSessionResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      );
      return session;
    },

    async checkSessionStatus(sessionId) {
      const { session } = await request<SessionResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/status/check`,
        { method: "POST" },
      );
      return session;
    },

    async deleteSession(sessionId, options = {}) {
      const query = new URLSearchParams();
      if (options.worktree) {
        query.set("worktree", options.worktree);
      }
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return (
        (await request<{ job?: GitJob }>(
          `/v1/sessions/${encodeURIComponent(sessionId)}${suffix}`,
          {
            method: "DELETE",
          },
        )) ?? {}
      );
    },

    async fetchMessageAttachmentContent(sessionId, attachmentId) {
      return requestBlob(
        `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
      );
    },

    async fetchFileTree(sessionId, options = {}) {
      const query = new URLSearchParams();
      if (options.requestId) {
        query.set("requestId", options.requestId);
      }
      query.set("path", options.path ?? ".");
      query.set("depth", String(options.depth ?? 3));
      const payload = await request<FileTreeResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/files?${query.toString()}`,
      );
      const root = payload.result?.root ?? payload.root;
      return payload.files ?? root?.children ?? (root ? [root] : []);
    },

    async fetchFileContent(sessionId, path, options = {}) {
      const query = new URLSearchParams();
      query.set("path", path);
      query.set("maxBytes", String(options.maxBytes ?? 256 * 1024));
      const payload = await request<FileContentResponse | FileContentResult>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/files/content?${query.toString()}`,
      );
      return normalizeFileContent(payload);
    },

    async saveFileContent(sessionId, path, content) {
      const { result } = await request<FileWriteResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/files/content`,
        {
          method: "PUT",
          body: JSON.stringify({ path, content, encoding: "utf8" }),
        },
      );
      return result;
    },

    async applyPatch(sessionId, patch) {
      const { result } = await request<PatchApplyResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/patches/apply`,
        {
          method: "POST",
          body: JSON.stringify({ patch, strip: 1 }),
        },
      );
      return result;
    },

    async listAgentSkills(input) {
      const { result } = await request<AgentSkillListResponse>(
        "/v1/agent/skills",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
      return result;
    },

    async searchWorkspacePaths(input) {
      const { result } = await request<PathSearchResponse>(
        "/v1/workspace/path-search",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
      return result;
    },

    async fetchGitStatus(context) {
      const { result } = await request<GitStatusResponse>("/v1/git/status", {
        method: "POST",
        body: JSON.stringify(context),
      });
      return result;
    },

    async fetchGitDiff(query) {
      const { result } = await request<GitDiffResponse>("/v1/git/diff", {
        method: "POST",
        body: JSON.stringify(query),
      });
      return result;
    },

    async fetchGitBlame(query) {
      const { result } = await request<GitBlameResponse>("/v1/git/blame", {
        method: "POST",
        body: JSON.stringify(query),
      });
      return result;
    },

    async fetchGitHistory(query) {
      const { result } = await request<GitHistoryResponse>("/v1/git/history", {
        method: "POST",
        body: JSON.stringify(query),
      });
      return result;
    },

    async fetchGitCommitFiles(query) {
      const { result } = await request<GitCommitFilesResponse>(
        "/v1/git/commit-files",
        {
          method: "POST",
          body: JSON.stringify(query),
        },
      );
      return result;
    },

    async fetchGitBranches(context) {
      const { result } = await request<GitBranchesResponse>(
        "/v1/git/branches",
        {
          method: "POST",
          body: JSON.stringify(context),
        },
      );
      return result;
    },

    async fetchGitJobs(projectId) {
      const { jobs } = await request<GitJobsResponse>(
        `/v1/projects/${encodeURIComponent(projectId)}/git/jobs`,
      );
      return jobs;
    },

    async initGitRepository(input) {
      const { job } = await request<GitJobResponse>("/v1/git/init", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return job;
    },

    async stageGitPaths(input) {
      const { job } = await request<GitJobResponse>("/v1/git/stage", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return job;
    },

    async unstageGitPaths(input) {
      const { job } = await request<GitJobResponse>("/v1/git/unstage", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return job;
    },

    async discardGitPaths(input) {
      const { job } = await request<GitJobResponse>("/v1/git/discard", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return job;
    },

    async commitGitChanges(input) {
      const { job } = await request<GitJobResponse>("/v1/git/commit", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return job;
    },

    async runGitRemoteOperation(input) {
      const { job } = await request<GitJobResponse>("/v1/git/remote", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return job;
    },

    async removeGitWorktree(input) {
      const { job } = await request<GitJobResponse>("/v1/git/worktree/remove", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return job;
    },

    async resolveApproval(approvalId, approved) {
      const { approval } = await request<ApprovalResponse>(
        `/v1/approvals/${approvalId}`,
        {
          method: "POST",
          body: JSON.stringify({ approved }),
        },
      );
      return approval;
    },

    connectStream(onEvent, onStatus) {
      if (!WebSocketImpl) {
        onStatus?.("closed");
        return undefined;
      }
      const url = new URL("/v1/stream", baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocketImpl(url);
      socket.addEventListener("open", () => onStatus?.("open"));
      socket.addEventListener("close", () => onStatus?.("closed"));
      socket.addEventListener("error", () => onStatus?.("error"));
      socket.addEventListener("message", (event) => {
        try {
          onEvent(JSON.parse(String(event.data)) as ServerEvent);
        } catch {
          onStatus?.("error");
        }
      });
      return socket;
    },
  };
}

export function sendStreamCommand(
  socket: WebSocket | undefined,
  command: ClientCommand,
): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(command));
  return true;
}

function normalizeFileContent(
  payload: FileContentResponse | FileContentResult,
): FileContentResult {
  if ("result" in payload) {
    if (payload.result === undefined) {
      throw new Error("Invalid file content response");
    }
    return payload.result;
  }
  return payload;
}

function formatUnexpectedResponse(
  path: string,
  contentType: string,
  body: string,
): string {
  const received = contentType ? contentType.split(";")[0] : "unknown content";
  if (isHtmlResponse(contentType, body)) {
    return [
      `RoamCli API request ${path} returned HTML instead of JSON.`,
      "This usually means /v1 requests are being routed to the web app instead of the API.",
      "Check the API origin, reverse proxy, or WebSocket/API routing configuration.",
    ].join(" ");
  }
  return `RoamCli API request ${path} returned ${received} instead of JSON.`;
}

function formatHttpError(
  path: string,
  response: Response,
  body: string,
): string {
  const status = `${response.status} ${response.statusText}`.trim();
  if (!body && response.status >= 500) {
    return [
      `RoamCli API request ${path} failed with ${status}.`,
      "The API route or development proxy returned an empty server error.",
      "Check the API origin, reverse proxy, or WebSocket/API routing configuration.",
    ].join(" ");
  }
  const detail = parseHttpErrorBody(body);
  if (detail.message && shouldUseBodyMessageOnly(path, response, detail)) {
    return detail.message;
  }
  return `RoamCli API request ${path} failed with ${status}${detail.message ? `: ${detail.message}` : ""}.`;
}

function parseHttpErrorBody(body: string): {
  message: string;
  code?: string;
  error?: string;
} {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return { message: "" };
  }
  try {
    const parsed: unknown = JSON.parse(trimmedBody);
    if (isRecord(parsed)) {
      const error = firstStringValue(parsed, ["error"]);
      const code = firstStringValue(parsed, ["code"]) || error;
      const message = firstStringValue(parsed, ["message", "error", "detail"]);
      if (message) {
        return {
          message,
          ...(code ? { code } : {}),
          ...(error ? { error } : {}),
        };
      }
      const nestedError = parsed.error;
      if (isRecord(nestedError)) {
        const nestedErrorCode = firstStringValue(nestedError, ["error"]);
        const nestedCode = firstStringValue(nestedError, ["code"]);
        const nestedMessage = firstStringValue(nestedError, [
          "message",
          "detail",
        ]);
        if (nestedMessage) {
          return {
            message: nestedMessage,
            ...(nestedCode || nestedErrorCode
              ? { code: nestedCode || nestedErrorCode }
              : {}),
            ...(nestedErrorCode ? { error: nestedErrorCode } : {}),
          };
        }
      }
    }
  } catch {
    return { message: trimmedBody };
  }
  return {
    message: "The server returned an error response without a readable message",
  };
}

function shouldUseBodyMessageOnly(
  path: string,
  response: Response,
  detail: { message: string; code?: string; error?: string },
): boolean {
  if (response.status === 401 || response.status === 403) {
    return false;
  }
  return (
    response.status === 409 &&
    path.startsWith("/v1/sessions/") &&
    detail.error === "worktree_remove_failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstStringValue(
  record: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function isHtmlResponse(contentType: string, body: string): boolean {
  return (
    contentType.includes("text/html") ||
    /^\s*<!doctype html/i.test(body) ||
    /^\s*<html/i.test(body)
  );
}
