import type { WebSocket } from "ws";
import {
  nowIso,
  type RunnerCommand,
  type RunnerRegistration,
  type ServerEvent,
} from "@roamcli/shared/protocol";
import type { ServerStore } from "./sqlite-store.js";

interface RunnerConnection {
  runner: RunnerRegistration;
  socket: WebSocket;
}

interface StreamConnection {
  socket: WebSocket;
  authSessionId?: string;
}

export interface RunnerConnectionLifecycle {
  onRunnerReplaced?: (runnerId: string) => void;
  onRunnerDisconnected?: (runnerId: string) => void;
}

export class ConnectionHub {
  private readonly streamClients = new Set<StreamConnection>();
  private readonly runners = new Map<string, RunnerConnection>();

  constructor(
    private readonly store: ServerStore,
    private readonly lifecycle: RunnerConnectionLifecycle = {},
  ) {}

  addStream(socket: WebSocket, authSessionId?: string): void {
    const connection: StreamConnection = {
      socket,
      ...(authSessionId ? { authSessionId } : {}),
    };
    this.streamClients.add(connection);
    for (const runner of this.listOnlineRunners()) {
      sendJson(socket, { type: "runner:online", runner });
    }
    socket.once("close", () => {
      this.streamClients.delete(connection);
    });
  }

  closeStreamsForAuthSessions(sessionIds: string[]): void {
    const ids = new Set(sessionIds);
    for (const connection of this.streamClients) {
      if (connection.authSessionId && ids.has(connection.authSessionId)) {
        connection.socket.close(1008, "session revoked");
      }
    }
  }

  registerRunner(runner: RunnerRegistration, socket: WebSocket): void {
    const existing = this.runners.get(runner.runnerId);
    if (existing) {
      this.lifecycle.onRunnerReplaced?.(runner.runnerId);
    }
    existing?.socket.close(1000, "runner reconnected");
    this.runners.set(runner.runnerId, { runner, socket });
    this.store.setRunnerOnline(runner, true, nowIso());
    this.broadcast({ type: "runner:online", runner });

    socket.once("close", () => {
      const current = this.runners.get(runner.runnerId);
      if (current?.socket === socket) {
        this.runners.delete(runner.runnerId);
        this.lifecycle.onRunnerDisconnected?.(runner.runnerId);
        this.store.markRunnerOffline(runner.runnerId, nowIso());
        this.broadcast({ type: "runner:offline", runnerId: runner.runnerId });
      }
    });
  }

  isRunnerOnline(runnerId: string): boolean {
    return this.isRunnerConnectionHealthy(runnerId);
  }

  isRunnerConnectionHealthy(runnerId: string): boolean {
    const connection = this.runners.get(runnerId);
    return Boolean(
      connection && connection.socket.readyState === connection.socket.OPEN,
    );
  }

  listOnlineRunners(): RunnerRegistration[] {
    return [...this.runners.values()]
      .filter(({ socket }) => socket.readyState === socket.OPEN)
      .map(({ runner }) => runner);
  }

  markRunnerOffline(runnerId: string): void {
    const connection = this.runners.get(runnerId);
    if (connection) {
      this.runners.delete(runnerId);
      connection.socket.close(1000, "runner marked offline");
    }
    this.lifecycle.onRunnerDisconnected?.(runnerId);
    this.store.markRunnerOffline(runnerId, nowIso());
    this.broadcast({ type: "runner:offline", runnerId });
  }

  sendToRunner(runnerId: string, command: RunnerCommand): boolean {
    const connection = this.runners.get(runnerId);
    if (
      !connection ||
      connection.socket.readyState !== connection.socket.OPEN
    ) {
      return false;
    }
    sendJson(connection.socket, command);
    return true;
  }

  broadcast(event: ServerEvent): void {
    for (const connection of this.streamClients) {
      sendJson(connection.socket, event);
    }
  }

  sendError(socket: WebSocket, message: string, code?: string): void {
    sendJson(socket, { type: "error", message, ...(code ? { code } : {}) });
  }
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}
