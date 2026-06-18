import websocketPlugin from "@fastify/websocket";
import Fastify from "fastify";
import { requireAuth } from "../auth.js";
import { loadConfig, type ServerConfigInput } from "../config.js";
import { registerApiRoutes } from "../http/api-routes.js";
import { ConnectionHub } from "../infra/connection-hub.js";
import { ArtifactStorage } from "../infra/local-artifact-storage.js";
import { RunnerRpcClient, RunnerRpcError } from "../infra/runner-rpc-client.js";
import { ServerStore } from "../infra/sqlite-store.js";
import { ApprovalService } from "../modules/approvals/approval-service.js";
import { ApprovalSignatureVerifier } from "../modules/approvals/approval-signatures.js";
import { ArtifactService } from "../modules/artifacts/artifact-service.js";
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
  const signatures = new ApprovalSignatureVerifier(config.approvalSecret);
  const approvalService = new ApprovalService(store, hub, signatures);
  const artifactService = new ArtifactService(store, artifacts, hub);
  const sessionService = new SessionCommandService(store, hub, approvalService);
  const workspaceService = new WorkspaceService(
    store,
    rpc,
    signatures,
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
    if (pathname === "/v1" || pathname.startsWith("/v1/")) {
      await requireAuth(config.authToken, request, reply);
    }
  });

  await registerApiRoutes(app, context);
  registerWebSocketRoutes(app, context, config.authToken);

  if (config.webDistDir) {
    await registerWebDist(app, config.webDistDir);
  }

  return app;
}

export type { AppContext, RoamServer } from "./context.js";
