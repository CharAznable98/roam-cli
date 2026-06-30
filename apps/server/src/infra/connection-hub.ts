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
  activeSessionId?: string;
  subscriptionInitialized?: boolean;
  recentlyCreatedSessionIds?: Map<string, number>;
  isAuthorized?: () => boolean;
}

const RECENTLY_CREATED_SESSION_GRACE_MS = 10_000;

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

  addStream(
    socket: WebSocket,
    authSessionId?: string,
    isAuthorized?: () => boolean,
  ): void {
    const connection: StreamConnection = {
      socket,
      ...(authSessionId ? { authSessionId } : {}),
      ...(isAuthorized ? { isAuthorized } : {}),
    };
    this.streamClients.add(connection);
    if (!this.isStreamAuthorized(connection)) {
      return;
    }
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

  setStreamActiveSession(
    socket: WebSocket,
    sessionId: string | undefined,
  ): void {
    for (const connection of this.streamClients) {
      if (connection.socket === socket) {
        connection.subscriptionInitialized = true;
        connection.recentlyCreatedSessionIds?.clear();
        if (sessionId) {
          connection.activeSessionId = sessionId;
        } else {
          delete connection.activeSessionId;
        }
        return;
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
      if (!this.isStreamAuthorized(connection)) {
        continue;
      }
      if (event.type === "session:created") {
        rememberRecentlyCreatedSession(connection, event.session.id);
      }
      if (!shouldSendToStream(connection, event)) {
        continue;
      }
      sendJson(connection.socket, event);
    }
  }

  sendError(socket: WebSocket, message: string, code?: string): void {
    sendJson(socket, { type: "error", message, ...(code ? { code } : {}) });
  }

  private isStreamAuthorized(connection: StreamConnection): boolean {
    try {
      if (!connection.isAuthorized || connection.isAuthorized()) {
        return true;
      }
    } catch {
      // If authorization state cannot be checked, the stream is no longer safe to keep.
    }
    this.streamClients.delete(connection);
    connection.socket.close(1008, "session expired");
    return false;
  }
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function shouldSendToStream(
  connection: StreamConnection,
  event: ServerEvent,
): boolean {
  const sessionId = eventSessionId(event);
  return (
    sessionId === undefined ||
    !connection.subscriptionInitialized ||
    connection.activeSessionId === sessionId ||
    isRecentlyCreatedSession(connection, sessionId)
  );
}

function rememberRecentlyCreatedSession(
  connection: StreamConnection,
  sessionId: string,
): void {
  connection.recentlyCreatedSessionIds ??= new Map();
  connection.recentlyCreatedSessionIds.set(
    sessionId,
    Date.now() + RECENTLY_CREATED_SESSION_GRACE_MS,
  );
}

function isRecentlyCreatedSession(
  connection: StreamConnection,
  sessionId: string,
): boolean {
  const expiresAt = connection.recentlyCreatedSessionIds?.get(sessionId);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt < Date.now()) {
    connection.recentlyCreatedSessionIds?.delete(sessionId);
    return false;
  }
  return true;
}

function eventSessionId(event: ServerEvent): string | undefined {
  switch (event.type) {
    case "runner:online":
    case "runner:offline":
    case "project:created":
    case "project:updated":
    case "session:created":
    case "session:updated":
    case "session:deleted":
      return undefined;
    case "message:created":
    case "message:updated":
      return event.message.sessionId;
    case "activity:created":
      return event.activity.sessionId;
    case "message_attachment:created":
      return event.attachment.sessionId;
    case "approval:requested":
    case "approval:updated":
      return event.approval.sessionId;
    case "artifact:created":
      return event.artifact.sessionId;
    case "file:tree":
    case "file:content":
    case "file:written":
    case "patch:applied":
      return event.result.sessionId;
    case "git:status":
    case "git:diff":
    case "git:blame":
    case "git:history":
    case "git:commitFiles":
    case "git:branches":
      return event.result.context.kind === "session_worktree"
        ? event.result.context.sessionId
        : undefined;
    case "git:job":
      return event.job.sessionId;
    case "error":
      return event.sessionId;
  }
}
