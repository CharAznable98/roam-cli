import websocketPlugin from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import { loadConfig, type ServerConfigInput } from "../config.js";
import { registerApiRoutes } from "../http/api-routes.js";
import { ConnectionHub } from "../infra/connection-hub.js";
import { ArtifactStorage } from "../infra/local-artifact-storage.js";
import { RunnerRpcClient, RunnerRpcError } from "../infra/runner-rpc-client.js";
import { ServerStore } from "../infra/sqlite-store.js";
import { ApprovalService } from "../modules/approvals/approval-service.js";
import { ArtifactService } from "../modules/artifacts/artifact-service.js";
import { AuthService } from "../modules/auth/auth-service.js";
import { GitService } from "../modules/git/git-service.js";
import { RunnerEventService } from "../modules/runners/runner-event-service.js";
import { SessionCommandService } from "../modules/sessions/session-command-service.js";
import { WorkspaceService } from "../modules/workspace/workspace-service.js";
import { registerWebSocketRoutes } from "../ws/routes.js";
import { type AppContext, type RoamServer } from "./context.js";
import { registerWebDist } from "./static-web.js";

export async function createServer(
  input: ServerConfigInput = {},
): Promise<RoamServer> {
  const config = loadConfig(input);
  const app = Fastify({ logger: false }) as unknown as RoamServer;
  const store = new ServerStore(config.dataDir);
  const artifacts = new ArtifactStorage(config.dataDir);
  const authService = new AuthService(store, config.dataDir);
  authService.initialize({ resetOwner: config.resetOwner });
  let insecureHttpWarningLogged = false;
  let rpc: RunnerRpcClient;
  const hub = new ConnectionHub(store, {
    onRunnerReplaced: (runnerId) => {
      rpc.rejectPendingForRunner(
        runnerId,
        new RunnerRpcError("runner reconnected", "runner_offline"),
      );
    },
    onRunnerDisconnected: (runnerId) => {
      rpc.rejectPendingForRunner(
        runnerId,
        new RunnerRpcError("runner disconnected", "runner_offline"),
      );
    },
  });
  rpc = new RunnerRpcClient(hub);
  const approvalService = new ApprovalService(store, hub);
  const artifactService = new ArtifactService(store, artifacts, hub);
  const sessionService = new SessionCommandService(
    store,
    hub,
    approvalService,
    rpc,
    config.runnerRpcTimeoutMs,
  );
  const workspaceService = new WorkspaceService(
    store,
    rpc,
    config.runnerRpcTimeoutMs,
  );
  const gitService = new GitService(store, hub, rpc, config.runnerRpcTimeoutMs);
  const runnerEventService = new RunnerEventService(store, hub, rpc);

  const context: AppContext = {
    store,
    artifacts,
    hub,
    rpc,
    services: {
      approvals: approvalService,
      auth: authService,
      artifacts: artifactService,
      git: gitService,
      runnerEvents: runnerEventService,
      sessions: sessionService,
      workspace: workspaceService,
    },
  };
  app.roam = context;

  app.addHook("onClose", async () => {
    store.close();
  });

  await app.register(websocketPlugin);

  app.addHook("preHandler", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!pathname.startsWith("/v1/")) {
      return;
    }
    if (!isOriginAllowed(request, config.publicOrigin)) {
      await reply.code(403).send({ error: "invalid_origin" });
      return;
    }
    if (
      pathname === "/v1/auth/status" ||
      pathname === "/v1/auth/setup" ||
      pathname === "/v1/auth/login" ||
      pathname === "/v1/stream" ||
      pathname === "/v1/runner"
    ) {
      return;
    }
    if (!authService.requireSession(request, reply)) {
      return reply;
    }
  });

  app.addHook("onRequest", async (request, _reply) => {
    if (insecureHttpWarningLogged) {
      return;
    }
    const forwardedProto = request.headers["x-forwarded-proto"];
    const proto =
      typeof forwardedProto === "string"
        ? forwardedProto.split(",")[0]?.trim()
        : request.protocol;
    const host =
      request.headers["x-forwarded-host"] ?? request.headers.host ?? "";
    if (
      proto === "http" &&
      typeof host === "string" &&
      host &&
      !isLoopbackHost(host)
    ) {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "auth.insecure_http_warning",
          host,
        }),
      );
      insecureHttpWarningLogged = true;
    }
  });

  await registerApiRoutes(app, context);
  registerWebSocketRoutes(app, context, config.publicOrigin);

  if (config.webDistDir) {
    await registerWebDist(app, config.webDistDir);
  }

  return app;
}

export type { AppContext, RoamServer } from "./context.js";

function isOriginAllowed(
  request: FastifyRequest,
  publicOrigin: string | undefined,
): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    return true;
  }
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    return false;
  }
  if (publicOrigin) {
    return normalizeOrigin(origin) === normalizeOrigin(publicOrigin);
  }
  const host = firstHeaderValue(
    request.headers["x-forwarded-host"] ?? request.headers.host,
  );
  if (!host) {
    return false;
  }
  const proto =
    firstHeaderValue(request.headers["x-forwarded-proto"]) ?? request.protocol;
  return normalizeOrigin(origin) === `${proto}://${host}`;
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value?.split(",")[0]?.trim();
}

function isLoopbackHost(host: string): boolean {
  const hostname = host.split(":")[0] ?? host;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
