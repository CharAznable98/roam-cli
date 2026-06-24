import {
  type AgentActivity,
  type GitJob,
  nowIso,
  type Message,
  type RunnerEvent,
  type SessionStatus,
} from "@roamcli/shared/protocol";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import {
  RunnerRpcClient,
  RunnerRpcError,
} from "../../infra/runner-rpc-client.js";
import type { ServerStore } from "../../infra/sqlite-store.js";
import { newId } from "../../infra/ids.js";

export class RunnerEventService {
  private lastOutputTimestampMs = 0;

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
      if (
        event.status === "waiting_approval" &&
        this.isTerminalSession(event.sessionId)
      ) {
        return;
      }
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

    if (event.type === "agentActivity") {
      this.addActivity({
        sessionId: event.sessionId,
        agent: event.agent,
        kind: event.kind,
        label: event.label,
      });
      return;
    }

    if (event.type === "assistantOutput") {
      const result = this.store.applyAssistantOutput(
        event.sessionId,
        event.outputId,
        event.content,
        event.mode,
        event.done,
        this.nextOutputTimestamp(event.sessionId),
        event.encrypted,
      );
      if (result === undefined) {
        return;
      }
      const appendingExistingOutput =
        !result.created && event.mode === "append";
      this.hub.broadcast({
        type: result.created ? "message:created" : "message:updated",
        message: appendingExistingOutput
          ? { ...result.message, content: event.content ?? "" }
          : result.message,
        ...(appendingExistingOutput ? { contentMode: "append" } : {}),
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
      this.applyGitJobSessionEffects(event.job);
      this.rpc.resolveRunnerResponse(event.job);
      this.hub.broadcast({ type: "git:job", job: event.job });
      return;
    }

    if (event.type === "approvalRequested") {
      const session = this.store.getSession(event.approval.sessionId);
      this.addActivity({
        sessionId: event.approval.sessionId,
        agent: session?.agent ?? "unknown",
        kind: "approval",
        label: "Waiting for approval",
      });
      this.store.upsertApproval(event.approval);
      if (!this.isTerminalSession(event.approval.sessionId)) {
        const session = this.store.updateSessionStatus(
          event.approval.sessionId,
          "waiting_approval",
          nowIso(),
        );
        if (session) {
          this.hub.broadcast({ type: "session:updated", session });
        }
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

  private applyGitJobSessionEffects(job: GitJob): void {
    if (
      job.status !== "succeeded" ||
      job.operation !== "remove_worktree" ||
      job.contextKind !== "session_worktree" ||
      !job.sessionId
    ) {
      return;
    }
    const session = this.store.getSession(job.sessionId);
    if (!session || session.worktreeDeletedAt) {
      return;
    }
    const updated = this.store.markSessionWorktreeDeleted(
      session.id,
      job.finishedAt ?? nowIso(),
    );
    if (updated) {
      this.hub.broadcast({ type: "session:updated", session: updated });
    }
  }

  private addActivity(
    input: Pick<AgentActivity, "sessionId" | "agent" | "kind" | "label">,
  ): AgentActivity {
    const activity = this.store.addAgentActivity({
      id: newId("activity"),
      sessionId: input.sessionId,
      agent: input.agent,
      kind: input.kind,
      label: input.label,
      createdAt: this.nextOutputTimestamp(),
    });
    this.hub.broadcast({ type: "activity:created", activity });
    return activity;
  }

  private nextOutputTimestamp(sessionId?: string): string {
    const latestSessionMessageTime =
      sessionId === undefined
        ? Number.NaN
        : Date.parse(this.store.listMessages(sessionId).at(-1)?.createdAt ?? "");
    const lowerBounds = [Date.now(), this.lastOutputTimestampMs + 1];
    if (Number.isFinite(latestSessionMessageTime)) {
      lowerBounds.push(latestSessionMessageTime + 1);
    }
    const next = Math.max(...lowerBounds);
    this.lastOutputTimestampMs = next;
    return new Date(next).toISOString();
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
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
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

  private isTerminalSession(sessionId: string): boolean {
    const session = this.store.getSession(sessionId);
    return session !== undefined && isTerminalStatus(session.status);
  }
}

function isRunnerDirectoryResult(sessionId: string): boolean {
  return sessionId.startsWith("runner-directory-");
}

function isTerminalStatus(status: SessionStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function isInternalRunnerError(
  event: Extract<RunnerEvent, { type: "error" }>,
): boolean {
  return event.code === "RUNNER_CONNECTION_ERROR";
}
