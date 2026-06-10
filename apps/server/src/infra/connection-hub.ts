import type { WebSocket } from "ws";
import {
  nowIso,
  type RunnerCommand,
  type RunnerRegistration,
  type ServerEvent,
} from "@roamcli/protocol";
import type { ServerStore } from "./sqlite-store.js";

interface RunnerConnection {
  runner: RunnerRegistration;
  socket: WebSocket;
}

export interface RunnerConnectionLifecycle {
  onRunnerReplaced?: (runnerId: string) => void;
  onRunnerDisconnected?: (runnerId: string) => void;
}

export class ConnectionHub {
  private readonly streamClients = new Set<WebSocket>();
  private readonly runners = new Map<string, RunnerConnection>();

  constructor(
    private readonly store: ServerStore,
    private readonly lifecycle: RunnerConnectionLifecycle = {},
  ) {}

  addStream(socket: WebSocket): void {
    this.streamClients.add(socket);
    for (const { runner } of this.runners.values()) {
      sendJson(socket, { type: "runner:online", runner });
    }
    socket.once("close", () => {
      this.streamClients.delete(socket);
    });
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
    return this.runners.has(runnerId);
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
    for (const socket of this.streamClients) {
      sendJson(socket, event);
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
