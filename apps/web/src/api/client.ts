import type {
  AgentKind,
  ApiCreateProject,
  ApiCreateSession,
  ApiGitBlameQuery,
  ApiGitCommit,
  ApiGitContext,
  ApiGitFileDiffQuery,
  ApiGitHistoryQuery,
  ApiGitInit,
  ApiGitPaths,
  ApiGitRemoteOperation,
  ApiGitRemoveWorktree,
  ApiUpdateProject,
  ApiUpdateSession,
  Approval,
  ClientCommand,
  DirectoryCreateResult,
  ExecutionMode,
  FileContentResult,
  FileNode,
  FileWriteResult,
  GitBlame,
  GitBranchList,
  GitCommitPage,
  GitFileDiff,
  GitJob,
  GitStatus,
  ImageAttachmentUpload,
  Message,
  MessageAttachment,
  PatchApplyResult,
  Project,
  RunnerRegistration,
  ServerEvent,
  Session,
} from "@roamcli/shared/protocol";
import type { InitialRemoteState, SessionDetailPayload } from "./contracts";
import { toUiMessage } from "../features/conversation/model";

export interface RoamApiOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

export interface RoamApiClient {
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
  updateSession(sessionId: string, input: ApiUpdateSession): Promise<Session>;
  checkSessionStatus(sessionId: string): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  fetchMessageAttachmentContent(
    sessionId: string,
    attachmentId: string,
  ): Promise<Blob>;
  fetchFileTree(
    sessionId: string,
    options?: { path?: string; depth?: number },
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
  fetchGitStatus(context: ApiGitContext): Promise<GitStatus>;
  fetchGitDiff(query: ApiGitFileDiffQuery): Promise<GitFileDiff>;
  fetchGitBlame(query: ApiGitBlameQuery): Promise<GitBlame>;
  fetchGitHistory(query: ApiGitHistoryQuery): Promise<GitCommitPage>;
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

interface GitStatusResponse {
  result: GitStatus;
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

interface GitBranchesResponse {
  result: GitBranchList;
}

interface GitJobResponse {
  job: GitJob;
}

interface GitJobsResponse {
  jobs: GitJob[];
}

export function createRoamApiClient(
  options: RoamApiOptions = {},
): RoamApiClient {
  const baseUrl = options.baseUrl ?? window.location.origin;
  const token = options.token;
  const fetchImpl = options.fetchImpl ?? fetch;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
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
    const headers = new Headers();
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    const response = await fetchImpl(`${baseUrl}${path}`, { headers });
    if (!response.ok) {
      throw new Error("Attachment is unavailable.");
    }
    return response.blob();
  }

  return {
    async loadInitialState() {
      const [{ runners }, { projects }, { sessions }] = await Promise.all([
        request<RunnersResponse>("/v1/runners"),
        request<ProjectsResponse>("/v1/projects"),
        request<SessionsResponse>("/v1/sessions"),
      ]);
      const details = await Promise.all(
        sessions.map((session) =>
          request<SessionDetailPayload>(`/v1/sessions/${session.id}`),
        ),
      );
      return {
        projects,
        runners,
        sessions,
        messages: details.flatMap((detail) =>
          detail.messages.map((message) => toUiMessage(message)),
        ),
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

    async deleteSession(sessionId) {
      await request<void>(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    },

    async fetchMessageAttachmentContent(sessionId, attachmentId) {
      return requestBlob(
        `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
      );
    },

    async fetchFileTree(sessionId, options = {}) {
      const query = new URLSearchParams();
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
      const signedAt = new Date().toISOString();
      const signature = await signApprovalLike(
        token,
        `patch:${sessionId}:${await sha256Hex(patch)}`,
        true,
        signedAt,
      );
      const { result } = await request<PatchApplyResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/patches/apply`,
        {
          method: "POST",
          body: JSON.stringify({ patch, strip: 1, signedAt, signature }),
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
      const signedAt = new Date().toISOString();
      const signature = await signApprovalLike(
        token,
        approvalId,
        approved,
        signedAt,
      );
      const { approval } = await request<ApprovalResponse>(
        `/v1/approvals/${approvalId}`,
        {
          method: "POST",
          body: JSON.stringify({ approved, signedAt, signature }),
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
      if (token) {
        url.searchParams.set("token", token);
      }
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
  return `${status}${body ? `: ${body}` : ""}`;
}

function isHtmlResponse(contentType: string, body: string): boolean {
  return (
    contentType.includes("text/html") ||
    /^\s*<!doctype html/i.test(body) ||
    /^\s*<html/i.test(body)
  );
}

async function signApprovalLike(
  secret: string | undefined,
  approvalId: string,
  approved: boolean,
  signedAt: string,
): Promise<string> {
  if (!secret) {
    throw new Error("API token is required to sign approvals");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `${approvalId}.${approved ? "1" : "0"}.${signedAt}`,
    ),
  );
  return base64Url(new Uint8Array(signature));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
