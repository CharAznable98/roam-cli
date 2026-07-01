export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  id: JsonRpcId;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export interface ThreadResponse {
  thread?: {
    id?: string;
  };
}

export type AskForApproval =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export type ThreadSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface TurnStartResponse {
  turn?: {
    id?: string;
  };
}

export interface TurnNotification {
  threadId?: string;
  turn?: {
    id?: string;
    status?: string;
    error?: {
      message?: string;
    } | null;
  };
}

export interface AgentMessageDeltaNotification {
  itemId?: string;
  delta?: string;
}

export interface ItemCompletedNotification {
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
}

export interface ItemStartedNotification {
  threadId?: string;
  turnId?: string;
  item?: {
    id?: string;
    type?: string;
    tool?: string;
    command?: string | null;
    cwd?: string | null;
    commandActions?: unknown[] | null;
    additionalPermissions?: unknown;
    environmentId?: string | null;
    networkApprovalContext?: unknown;
    proposedExecpolicyAmendment?: unknown;
    proposedNetworkPolicyAmendments?: unknown[] | null;
    changes?: unknown;
    status?: string;
  };
}

export interface ToolRequestUserInputOption {
  label?: string;
  description?: string;
}

export interface CommandApprovalParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: unknown[] | null;
  additionalPermissions?: unknown;
  availableDecisions?: unknown;
  environmentId?: string | null;
  networkApprovalContext?: unknown;
  proposedExecpolicyAmendment?: unknown;
  proposedNetworkPolicyAmendments?: unknown[] | null;
}

export interface FileChangeApprovalParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface PermissionApprovalParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  environmentId?: string | null;
  cwd?: string | null;
  reason?: string | null;
  permissions?: Record<string, unknown> | null;
}

export interface ToolRequestUserInputParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  questions?: Array<{
    id?: string;
    header?: string;
    question?: string;
    isOther?: boolean;
    isSecret?: boolean;
    options?: ToolRequestUserInputOption[] | null;
  }> | null;
}

export interface McpServerElicitationRequestParams {
  threadId?: string;
  turnId?: string | null;
  serverName?: string;
  mode?: string;
  message?: string;
  url?: string;
  elicitationId?: string;
  requestedSchema?: unknown;
  _meta?: unknown;
}

export type UserInput =
  | {
      type: "text";
      text: string;
      text_elements: [];
    }
  | {
      type: "localImage";
      path: string;
      detail?: "auto" | "low" | "high";
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
