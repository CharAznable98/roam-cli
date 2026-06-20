import {
  nowIso,
  type Message,
  type RunnerEvent,
} from "@roamcli/shared/protocol";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import {
  RunnerRpcClient,
  RunnerRpcError,
} from "../../infra/runner-rpc-client.js";
import type { ServerStore } from "../../infra/sqlite-store.js";
import { newId } from "../../infra/ids.js";

export class RunnerEventService {
  constructor(
    private readonly store: ServerStore,
    private readonly hub: ConnectionHub,
    private readonly rpc: RunnerRpcClient,
  ) {}

  handle(event: RunnerEvent): void {
    if (event.type === "registered") {
      return;
    }

    if (event.type === "sessionStatus") {
      const session = this.store.updateSessionStatus(
        event.sessionId,
        event.status,
        nowIso(),
      );
      if (session) {
        this.hub.broadcast({ type: "session:updated", session });
      }
      return;
    }

    if (event.type === "sessionThread") {
      const session = this.store.updateSessionThread(
        event.sessionId,
        event.threadId,
        nowIso(),
      );
      if (session) {
        this.hub.broadcast({ type: "session:updated", session });
      }
      return;
    }

    if (event.type === "sessionStatusCheckResult") {
      this.rpc.resolveRunnerResponse(event.result);
      return;
    }

    if (event.type === "agentSkillListResult") {
      this.rpc.resolveRunnerResponse(event.result);
      return;
    }

    if (event.type === "pathSearchResult") {
      this.rpc.resolveRunnerResponse(event.result);
      return;
    }

    if (event.type === "assistantMessage") {
      const message: Message = {
        id: newId("message"),
        sessionId: event.sessionId,
        role: "assistant",
        content: event.content,
        encrypted: event.encrypted,
        createdAt: nowIso(),
      };
      this.store.addMessage(message);
      this.hub.broadcast({ type: "message:created", message });
      return;
    }

    if (event.type === "token") {
      this.store.appendAssistantToken(
        event.sessionId,
        event.content,
        nowIso(),
        event.encrypted,
      );
      this.hub.broadcast({
        type: "token",
        sessionId: event.sessionId,
        content: event.content,
        encrypted: event.encrypted,
      });
      return;
    }

    if (event.type === "fileTreeResult") {
      this.rpc.resolveRunnerResponse(event.result);
      if (isRunnerDirectoryResult(event.result.sessionId)) {
        return;
      }
      this.hub.broadcast({ type: "file:tree", result: event.result });
      return;
    }

    if (event.type === "fileContentResult") {
      this.rpc.resolveRunnerResponse(event.result);
      this.hub.broadcast({ type: "file:content", result: event.result });
      return;
    }

    if (event.type === "fileWriteResult") {
      this.rpc.resolveRunnerResponse(event.result);
      this.hub.broadcast({ type: "file:written", result: event.result });
      return;
    }

    if (event.type === "directoryCreateResult") {
      this.rpc.resolveRunnerResponse(event.result);
      return;
    }

    if (event.type === "attachmentWriteResult") {
      this.rpc.resolveRunnerResponse(event.result);
      return;
    }

    if (event.type === "attachmentContentResult") {
      this.rpc.resolveRunnerResponse(event.result);
      return;
    }

    if (event.type === "attachmentDeleteResult") {
      this.rpc.resolveRunnerResponse(event.result);
      return;
    }

    if (event.type === "patchApplyResult") {
      this.rpc.resolveRunnerResponse(event.result);
      this.hub.broadcast({ type: "patch:applied", result: event.result });
      return;
    }

    if (event.type === "gitStatusResult") {
      this.rpc.resolveRunnerResponse(event.result);
      this.hub.broadcast({ type: "git:status", result: event.result });
      return;
    }

    if (event.type === "gitFileDiffResult") {
      this.rpc.resolveRunnerResponse(event.result);
      this.hub.broadcast({ type: "git:diff", result: event.result });
      return;
    }

    if (event.type === "gitBlameResult") {
      this.rpc.resolveRunnerResponse(event.result);
      this.hub.broadcast({ type: "git:blame", result: event.result });
      return;
    }

    if (event.type === "gitCommitPageResult") {
      this.rpc.resolveRunnerResponse(event.result);
      this.hub.broadcast({ type: "git:history", result: event.result });
      return;
    }

    if (event.type === "gitBranchListResult") {
      this.rpc.resolveRunnerResponse(event.result);
      this.hub.broadcast({ type: "git:branches", result: event.result });
      return;
    }

    if (event.type === "gitJobResult") {
      this.store.upsertGitJob(event.job);
      this.rpc.resolveRunnerResponse(event.job);
      this.hub.broadcast({ type: "git:job", job: event.job });
      return;
    }

    if (event.type === "approvalRequested") {
      this.store.upsertApproval(event.approval);
      const session = this.store.updateSessionStatus(
        event.approval.sessionId,
        "waiting_approval",
        nowIso(),
      );
      if (session) {
        this.hub.broadcast({ type: "session:updated", session });
      }
      this.hub.broadcast({
        type: "approval:requested",
        approval: event.approval,
      });
      return;
    }

    if (event.type === "artifactCreated") {
      this.store.addArtifact(event.artifact);
      this.hub.broadcast({
        type: "artifact:created",
        artifact: event.artifact,
      });
      return;
    }

    this.handleErrorEvent(event);
  }

  private handleErrorEvent(
    event: Extract<RunnerEvent, { type: "error" }>,
  ): void {
    if (event.requestId) {
      this.rpc.rejectRunnerResponse(
        event.requestId,
        new RunnerRpcError(event.message, "runner_error", event.code),
      );
      return;
    }

    if (!event.sessionId && isInternalRunnerError(event)) {
      return;
    }

    this.hub.broadcast({
      type: "error",
      message: event.message,
      ...(event.code ? { code: event.code } : {}),
    });
    if (event.sessionId && event.code === "SESSION_NOT_RUNNING") {
      const session = this.store.updateSessionStatus(
        event.sessionId,
        "stopped",
        nowIso(),
      );
      if (session) {
        this.hub.broadcast({ type: "session:updated", session });
      }
      return;
    }

    if (event.sessionId) {
      const session = this.store.updateSessionStatus(
        event.sessionId,
        "failed",
        nowIso(),
      );
      if (session) {
        this.hub.broadcast({ type: "session:updated", session });
      }
    }
  }
}

function isRunnerDirectoryResult(sessionId: string): boolean {
  return sessionId.startsWith("runner-directory-");
}

function isInternalRunnerError(
  event: Extract<RunnerEvent, { type: "error" }>,
): boolean {
  return event.code === "RUNNER_CONNECTION_ERROR";
}
