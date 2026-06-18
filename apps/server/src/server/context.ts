import type { FastifyInstance } from "fastify";
import type { ArtifactStorage } from "../infra/local-artifact-storage.js";
import type { ConnectionHub } from "../infra/connection-hub.js";
import type { RunnerRpcClient } from "../infra/runner-rpc-client.js";
import type { ServerStore } from "../infra/sqlite-store.js";
import type { ApprovalService } from "../modules/approvals/approval-service.js";
import type { ArtifactService } from "../modules/artifacts/artifact-service.js";
import type { GitService } from "../modules/git/git-service.js";
import type { RunnerEventService } from "../modules/runners/runner-event-service.js";
import type { SessionCommandService } from "../modules/sessions/session-command-service.js";
import type { WorkspaceService } from "../modules/workspace/workspace-service.js";

export interface AppContext {
  store: ServerStore;
  artifacts: ArtifactStorage;
  hub: ConnectionHub;
  rpc: RunnerRpcClient;
  services: {
    approvals: ApprovalService;
    artifacts: ArtifactService;
    git: GitService;
    runnerEvents: RunnerEventService;
    sessions: SessionCommandService;
    workspace: WorkspaceService;
  };
}

export type RoamServer = FastifyInstance & { roam: AppContext };
