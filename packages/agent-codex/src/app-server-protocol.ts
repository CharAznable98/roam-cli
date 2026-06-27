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

export interface CommandApprovalParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: unknown[] | null;
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
