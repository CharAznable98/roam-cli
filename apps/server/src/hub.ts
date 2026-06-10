import type { RawData, WebSocket } from "ws";
import {
  nowIso,
  type FileContentResult,
  type FileTreeResult,
  type FileWriteResult,
  type PatchApplyResult,
  type RunnerCommand,
  type RunnerRegistration,
  type ServerEvent,
} from "@roamcli/protocol";
import type { ServerStore } from "./store.js";

interface RunnerConnection {
  runner: RunnerRegistration;
  socket: WebSocket;
}

type RunnerRpcResult =
  | FileTreeResult
  | FileContentResult
  | FileWriteResult
  | PatchApplyResult;
type RunnerRpcCommand = Extract<
  RunnerCommand,
  {
    type:
      | "readFileTree"
      | "readFileContent"
      | "writeFileContent"
      | "applyPatch";
  }
>;

interface PendingRunnerRpc<T extends RunnerRpcResult = RunnerRpcResult> {
  runnerId: string;
  timer: NodeJS.Timeout;
  resolve: (result: T) => void;
  reject: (error: RunnerRpcError) => void;
}

export class RunnerRpcError extends Error {
  constructor(
    message: string,
    readonly code: "runner_offline" | "runner_timeout" | "runner_error",
    readonly runnerCode?: string,
  ) {
    super(message);
  }
}

export class ConnectionHub {
  private readonly streamClients = new Set<WebSocket>();
  private readonly runners = new Map<string, RunnerConnection>();
  private readonly pendingRunnerRpcs = new Map<string, PendingRunnerRpc>();

  constructor(private readonly store: ServerStore) {}

  addStream(socket: WebSocket): void {
    this.streamClients.add(socket);
    for (const runner of this.store.listOnlineRunners()) {
      sendJson(socket, { type: "runner:online", runner });
    }
    socket.once("close", () => {
      this.streamClients.delete(socket);
    });
  }

  registerRunner(runner: RunnerRegistration, socket: WebSocket): void {
    const existing = this.runners.get(runner.runnerId);
    if (existing) {
      this.rejectPendingForRunner(
        runner.runnerId,
        new RunnerRpcError("runner reconnected", "runner_offline"),
      );
    }
    existing?.socket.close(1000, "runner reconnected");
    this.runners.set(runner.runnerId, { runner, socket });
    this.store.setRunnerOnline(runner, true, nowIso());
    this.broadcast({ type: "runner:online", runner });

    socket.once("close", () => {
      const current = this.runners.get(runner.runnerId);
      if (current?.socket === socket) {
        this.runners.delete(runner.runnerId);
        this.rejectPendingForRunner(
          runner.runnerId,
          new RunnerRpcError("runner disconnected", "runner_offline"),
        );
        this.store.markRunnerOffline(runner.runnerId, nowIso());
        this.broadcast({ type: "runner:offline", runnerId: runner.runnerId });
      }
    });
  }

  isRunnerOnline(runnerId: string): boolean {
    return this.runners.has(runnerId);
  }

  sendToRunner(runnerId: string, command: RunnerCommand): boolean {
    const connection = this.runners.get(runnerId);
    if (!connection) {
      return false;
    }
    sendJson(connection.socket, command);
    return true;
  }

  requestRunner<T extends RunnerRpcResult>(
    runnerId: string,
    command: RunnerRpcCommand,
    timeoutMs: number,
  ): Promise<T> {
    const connection = this.runners.get(runnerId);
    if (
      !connection ||
      connection.socket.readyState !== connection.socket.OPEN
    ) {
      return Promise.reject(
        new RunnerRpcError("runner is offline", "runner_offline"),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRunnerRpcs.delete(command.requestId);
        reject(
          new RunnerRpcError("runner request timed out", "runner_timeout"),
        );
      }, timeoutMs);

      this.pendingRunnerRpcs.set(command.requestId, {
        runnerId,
        timer,
        resolve: resolve as (result: RunnerRpcResult) => void,
        reject,
      });

      try {
        sendJson(connection.socket, command);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRunnerRpcs.delete(command.requestId);
        reject(
          error instanceof RunnerRpcError
            ? error
            : new RunnerRpcError("runner is offline", "runner_offline"),
        );
      }
    });
  }

  resolveRunnerResponse(result: RunnerRpcResult): boolean {
    const pending = this.pendingRunnerRpcs.get(result.requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingRunnerRpcs.delete(result.requestId);
    pending.resolve(result);
    return true;
  }

  rejectRunnerResponse(requestId: string, error: RunnerRpcError): boolean {
    const pending = this.pendingRunnerRpcs.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingRunnerRpcs.delete(requestId);
    pending.reject(error);
    return true;
  }

  broadcast(event: ServerEvent): void {
    for (const socket of this.streamClients) {
      sendJson(socket, event);
    }
  }

  sendError(socket: WebSocket, message: string, code?: string): void {
    sendJson(socket, { type: "error", message, ...(code ? { code } : {}) });
  }

  private rejectPendingForRunner(
    runnerId: string,
    error: RunnerRpcError,
  ): void {
    for (const [requestId, pending] of this.pendingRunnerRpcs) {
      if (pending.runnerId === runnerId) {
        clearTimeout(pending.timer);
        this.pendingRunnerRpcs.delete(requestId);
        pending.reject(error);
      }
    }
  }
}

export function parseSocketJson(data: RawData): unknown {
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data.toString();
  return JSON.parse(text) as unknown;
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}
