declare module "@roamcli/shared/protocol" {
  export type AgentKind = string;
  export type RunnerProfile = "strict" | "standard" | "trusted";
  export type ExecutionMode = "direct" | "managed_worktree" | "remote";
  export type SessionStatus =
    | "pending"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "stopped";
  export type ChatRole = "user" | "assistant" | "system" | "tool";
  export type ApprovalKind = "execCommand" | "applyPatch";
  export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
  export type ArtifactKind = "patch" | "file" | "log";

  export interface ParserSchema<T> {
    parse(value: unknown): T;
  }

  export const RunnerProfileSchema: ParserSchema<RunnerProfile>;
  export const RunnerCommandSchema: ParserSchema<RunnerCommand>;

  export interface RunnerCapability {
    kind: AgentKind;
    label: string;
    command: string;
    args: string[];
    parser: string;
    supportsResume: boolean;
    pluginName?: string;
    pluginVersion?: string;
  }

  export interface RunnerRegistration {
    runnerId: string;
    displayName: string;
    hostname: string;
    workspaceRoot: string;
    profile: RunnerProfile;
    publicKey: string;
    capabilities: RunnerCapability[];
    version: string;
  }

  export interface Session {
    id: string;
    title: string;
    projectId: string;
    runnerId: string;
    agent: AgentKind;
    status: SessionStatus;
    executionMode: ExecutionMode;
    executionFolder: string;
    cwd: string;
    agentThreadId?: string;
    archivedAt?: string;
    createdAt: string;
    updatedAt: string;
  }

  export interface Message {
    id: string;
    sessionId: string;
    role: ChatRole;
    content: string;
    encrypted: boolean;
    createdAt: string;
  }

  export interface Approval {
    id: string;
    sessionId: string;
    runnerId: string;
    kind: ApprovalKind;
    summary: string;
    payload: Record<string, unknown>;
    status: ApprovalStatus;
    requestedAt: string;
    resolvedAt?: string;
    clientSignature?: string;
  }

  export interface Artifact {
    id: string;
    sessionId: string;
    kind: ArtifactKind;
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    storagePath: string;
    createdAt: string;
  }

  export interface FileNode {
    path: string;
    name: string;
    type: "file" | "directory";
    size?: number;
    children?: FileNode[];
  }

  export interface FileTreeResult {
    requestId: string;
    sessionId: string;
    root: FileNode;
  }

  export interface FileContentResult {
    requestId: string;
    sessionId: string;
    path: string;
    content: string;
    truncated: boolean;
    encoding: "utf8";
  }

  export interface FileWriteResult {
    requestId: string;
    sessionId: string;
    path: string;
    bytesWritten: number;
    encoding: "utf8";
  }

  export interface PatchApplyResult {
    requestId: string;
    sessionId: string;
    applied: boolean;
    changedFiles: string[];
    message: string;
    rejected: string[];
  }

  export type RunnerCommand =
    | {
        type: "startSession";
        session: Session;
        prompt: string;
        resumeThreadId?: string;
      }
    | { type: "deliverInput"; sessionId: string; content: string }
    | {
        type: "readFileTree";
        requestId: string;
        sessionId: string;
        cwd?: string;
        path?: string;
        depth?: number;
      }
    | {
        type: "readFileContent";
        requestId: string;
        sessionId: string;
        cwd?: string;
        path: string;
        maxBytes?: number;
      }
    | {
        type: "writeFileContent";
        requestId: string;
        sessionId: string;
        cwd?: string;
        path: string;
        content: string;
        encoding?: "utf8";
      }
    | {
        type: "applyPatch";
        requestId: string;
        sessionId: string;
        patch: string;
        strip?: number;
        signedAt: string;
        signature: string;
      }
    | {
        type: "resolveApproval";
        approvalId: string;
        approved: boolean;
        signedAt: string;
        signature: string;
      }
    | {
        type: "controlSignal";
        sessionId: string;
        signal: "interrupt" | "stop" | "resume";
      };

  export type RunnerEvent =
    | { type: "registered"; runner: RunnerRegistration }
    | { type: "sessionStatus"; sessionId: string; status: SessionStatus }
    | { type: "sessionThread"; sessionId: string; threadId: string }
    | {
        type: "assistantMessage";
        sessionId: string;
        content: string;
        encrypted: boolean;
      }
    | { type: "token"; sessionId: string; content: string; encrypted: boolean }
    | { type: "fileTreeResult"; result: FileTreeResult }
    | { type: "fileContentResult"; result: FileContentResult }
    | { type: "fileWriteResult"; result: FileWriteResult }
    | { type: "patchApplyResult"; result: PatchApplyResult }
    | { type: "approvalRequested"; approval: Approval }
    | { type: "artifactCreated"; artifact: Artifact }
    | {
        type: "error";
        requestId?: string;
        sessionId?: string;
        message: string;
        code?: string;
      };

  export function nowIso(): string;
}
