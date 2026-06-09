import type {
  AgentKind,
  ApiCreateSession,
  Approval,
  Artifact,
  ClientCommand,
  FileContentResult,
  FileNode,
  FileWriteResult,
  Message,
  PatchApplyResult,
  PatchHunk,
  RunnerRegistration,
  ServerEvent,
  Session
} from "@roamcli/protocol";
import type { InitialRemoteState, SessionDetailPayload, UiMessage } from "../types";

export interface RoamApiOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

export interface RoamApiClient {
  loadInitialState(): Promise<InitialRemoteState>;
  createSession(input: { runnerId: string; agent: AgentKind; cwd: string; prompt: string; title?: string }): Promise<Session>;
  fetchFileTree(sessionId: string, options?: { path?: string; depth?: number }): Promise<FileNode[]>;
  fetchFileContent(sessionId: string, path: string, options?: { maxBytes?: number }): Promise<FileContentResult>;
  saveFileContent(sessionId: string, path: string, content: string): Promise<FileWriteResult>;
  applyPatch(sessionId: string, patch: string): Promise<PatchApplyResult>;
  resolveApproval(approvalId: string, approved: boolean): Promise<Approval>;
  connectStream(onEvent: (event: ServerEvent) => void, onStatus?: (status: "open" | "closed" | "error") => void): WebSocket | undefined;
}

interface SessionsResponse {
  sessions: Session[];
}

interface RunnersResponse {
  runners: RunnerRegistration[];
}

interface CreateSessionResponse {
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

interface FileContentResponse {
  result: FileContentResult;
}

interface FileWriteResponse {
  result: FileWriteResult;
}

interface PatchApplyResponse {
  result: PatchApplyResult;
}

export function createRoamApiClient(options: RoamApiOptions = {}): RoamApiClient {
  const baseUrl = options.baseUrl ?? window.location.origin;
  const token = options.token;
  const fetchImpl = options.fetchImpl ?? fetch;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers
      }
    });
    if (!response.ok) {
      const body = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      if (isHtmlResponse(contentType, body)) {
        throw new Error(formatUnexpectedResponse(path, contentType, body));
      }
      throw new Error(formatHttpError(path, response, body));
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const body = await response.text();
      throw new Error(formatUnexpectedResponse(path, contentType, body));
    }
    return (await response.json()) as T;
  }

  return {
    async loadInitialState() {
      const [{ runners }, { sessions }] = await Promise.all([
        request<RunnersResponse>("/v1/runners"),
        request<SessionsResponse>("/v1/sessions")
      ]);
      const details = await Promise.all(sessions.map((session) => request<SessionDetailPayload>(`/v1/sessions/${session.id}`)));
      return {
        runners,
        sessions,
        messages: details.flatMap((detail) => detail.messages.map(toUiMessage)),
        approvals: details.flatMap((detail) => detail.approvals),
        artifacts: details.flatMap((detail) => detail.artifacts)
      };
    },

    async createSession(input) {
      const payload: ApiCreateSession = input.title
        ? { runnerId: input.runnerId, agent: input.agent, cwd: input.cwd, prompt: input.prompt, title: input.title }
        : { runnerId: input.runnerId, agent: input.agent, cwd: input.cwd, prompt: input.prompt };
      const { session } = await request<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      return session;
    },

    async fetchFileTree(sessionId, options = {}) {
      const query = new URLSearchParams();
      query.set("path", options.path ?? ".");
      query.set("depth", String(options.depth ?? 3));
      const payload = await request<FileTreeResponse>(`/v1/sessions/${encodeURIComponent(sessionId)}/files?${query.toString()}`);
      const root = payload.result?.root ?? payload.root;
      return payload.files ?? root?.children ?? (root ? [root] : []);
    },

    async fetchFileContent(sessionId, path, options = {}) {
      const query = new URLSearchParams();
      query.set("path", path);
      query.set("maxBytes", String(options.maxBytes ?? 256 * 1024));
      const payload = await request<FileContentResponse | FileContentResult>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/files/content?${query.toString()}`
      );
      return normalizeFileContent(payload);
    },

    async saveFileContent(sessionId, path, content) {
      const { result } = await request<FileWriteResponse>(`/v1/sessions/${encodeURIComponent(sessionId)}/files/content`, {
        method: "PUT",
        body: JSON.stringify({ path, content, encoding: "utf8" })
      });
      return result;
    },

    async applyPatch(sessionId, patch) {
      const signedAt = new Date().toISOString();
      const signature = await signApprovalLike(token, `patch:${sessionId}:${await sha256Hex(patch)}`, true, signedAt);
      const { result } = await request<PatchApplyResponse>(`/v1/sessions/${encodeURIComponent(sessionId)}/patches/apply`, {
        method: "POST",
        body: JSON.stringify({ patch, strip: 1, signedAt, signature })
      });
      return result;
    },

    async resolveApproval(approvalId, approved) {
      const signedAt = new Date().toISOString();
      const signature = await signApprovalLike(token, approvalId, approved, signedAt);
      const { approval } = await request<ApprovalResponse>(`/v1/approvals/${approvalId}`, {
        method: "POST",
        body: JSON.stringify({ approved, signedAt, signature })
      });
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
    }
  };
}

export function sendStreamCommand(socket: WebSocket | undefined, command: ClientCommand): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(command));
  return true;
}

function toUiMessage(message: Message): UiMessage {
  if (message.role === "tool") {
    return { ...message, variant: "tool" };
  }
  return message;
}

function normalizeFileContent(payload: FileContentResponse | FileContentResult): FileContentResult {
  if ("result" in payload) {
    if (payload.result === undefined) {
      throw new Error("Invalid file content response");
    }
    return payload.result;
  }
  return payload;
}

function formatUnexpectedResponse(path: string, contentType: string, body: string): string {
  const received = contentType ? contentType.split(";")[0] : "unknown content";
  if (isHtmlResponse(contentType, body)) {
    return [
      `RoamCli API request ${path} returned HTML instead of JSON.`,
      "This usually means the web dev server is serving the React app for /v1 requests because the RoamCli server is not reachable.",
      "Start the server on http://127.0.0.1:8787, or set ROAMCLI_API_ORIGIN to the server URL before starting the web app."
    ].join(" ");
  }
  return `RoamCli API request ${path} returned ${received} instead of JSON.`;
}

function formatHttpError(path: string, response: Response, body: string): string {
  const status = `${response.status} ${response.statusText}`.trim();
  if (!body && response.status >= 500) {
    return [
      `RoamCli API request ${path} failed with ${status}.`,
      "The RoamCli server may not be running or the Vite dev proxy cannot reach it.",
      "Start the server on http://127.0.0.1:8787, or set ROAMCLI_API_ORIGIN to the server URL before starting the web app."
    ].join(" ");
  }
  return `${status}${body ? `: ${body}` : ""}`;
}

function isHtmlResponse(contentType: string, body: string): boolean {
  return contentType.includes("text/html") || /^\s*<!doctype html/i.test(body) || /^\s*<html/i.test(body);
}

async function signApprovalLike(secret: string | undefined, approvalId: string, approved: boolean, signedAt: string): Promise<string> {
  if (!secret) {
    throw new Error("API token is required to sign approvals");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${approvalId}.${approved ? "1" : "0"}.${signedAt}`));
  return base64Url(new Uint8Array(signature));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
