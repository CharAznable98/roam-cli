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
import type { GitJobRunner } from "../git/git-job-runner.js";

export class RunnerEventService {
  private lastOutputTimestampMs = 0;

  constructor(
    private readonly store: ServerStore,
    private readonly hub: ConnectionHub,
    private readonly rpc: RunnerRpcClient,
    private readonly gitJobs?: GitJobRunner,
    private readonly onArchiveRemoveWorktreeJobSucceeded?: (
      job: GitJob,
    ) => void,
  ) {
    this.reconcileCommittedEffects();
  }

  handle(event: RunnerEvent): void;
  handle(event: RunnerEvent, deferUntilCommit: true): () => void;
  handle(event: RunnerEvent, deferUntilCommit = false): void | (() => void) {
    const effects: Array<() => void> = [];
    this.persist(event, (effect) => effects.push(effect));
    const afterCommit = () => {
      for (const effect of effects) {
        try {
          effect();
        } catch {
          // A committed event must still ACK and run its remaining effects.
          // Durable business effects are retried from persisted state below.
        }
      }
      this.reconcileCommittedEffects();
    };
    if (deferUntilCommit) {
      return afterCommit;
    }
    afterCommit();
  }

  reconcileCommittedEffects(): void {
    if (!this.onArchiveRemoveWorktreeJobSucceeded) {
      return;
    }
    let jobs: GitJob[];
    try {
      jobs = this.store.listSucceededArchiveRemovalJobsPendingSessionArchive();
    } catch {
      return;
    }
    for (const job of jobs) {
      try {
        this.onArchiveRemoveWorktreeJobSucceeded(job);
      } catch {
        // The terminal job remains persisted and will be retried on the next
        // committed event, duplicate replay, or server restart.
      }
    }
  }

  private persist(
    event: RunnerEvent,
    defer: (effect: () => void) => void,
  ): void {
    if (event.type === "registered") {
      return;
    }

    if (event.type === "sessionStatus") {
      if (
        !isTerminalStatus(event.status) &&
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
        defer(() => this.hub.broadcast({ type: "session:updated", session }));
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
        defer(() => this.hub.broadcast({ type: "session:updated", session }));
      }
      return;
    }

    if (event.type === "sessionStatusCheckResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      return;
    }

    if (event.type === "sessionStartResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      return;
    }

    if (event.type === "agentSkillListResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      return;
    }

    if (event.type === "agentRuntimeConfigOptionsResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      return;
    }

    if (event.type === "pathSearchResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      return;
    }

    if (event.type === "agentActivity") {
      if (
        event.inputRequestId !== undefined &&
        !this.isTerminalSession(event.sessionId)
      ) {
        this.store.setPendingUserInputRequest(
          event.sessionId,
          event.inputRequestId,
        );
      }
      this.addActivity(
        {
          sessionId: event.sessionId,
          agent: event.agent,
          kind: event.kind,
          label: event.label,
        },
        defer,
      );
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
      defer(() =>
        this.hub.broadcast({
          type: result.created ? "message:created" : "message:updated",
          message: appendingExistingOutput
            ? { ...result.message, content: event.content ?? "" }
            : result.message,
          ...(appendingExistingOutput ? { contentMode: "append" } : {}),
        }),
      );
      return;
    }

    if (event.type === "fileTreeResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      if (isRunnerDirectoryResult(event.result.sessionId)) {
        return;
      }
      defer(() =>
        this.hub.broadcast({ type: "file:tree", result: event.result }),
      );
      return;
    }

    if (event.type === "fileContentResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      defer(() =>
        this.hub.broadcast({ type: "file:content", result: event.result }),
      );
      return;
    }

    if (event.type === "fileWriteResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      defer(() =>
        this.hub.broadcast({ type: "file:written", result: event.result }),
      );
      return;
    }

    if (event.type === "directoryCreateResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      return;
    }

    if (event.type === "attachmentWriteResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      return;
    }

    if (event.type === "attachmentContentResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      return;
    }

    if (event.type === "attachmentDeleteResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      return;
    }

    if (event.type === "patchApplyResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      defer(() =>
        this.hub.broadcast({ type: "patch:applied", result: event.result }),
      );
      return;
    }

    if (event.type === "gitStatusResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      defer(() =>
        this.hub.broadcast({ type: "git:status", result: event.result }),
      );
      return;
    }

    if (event.type === "gitFileDiffResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      defer(() =>
        this.hub.broadcast({ type: "git:diff", result: event.result }),
      );
      return;
    }

    if (event.type === "gitBlameResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      defer(() =>
        this.hub.broadcast({ type: "git:blame", result: event.result }),
      );
      return;
    }

    if (event.type === "gitCommitPageResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      defer(() =>
        this.hub.broadcast({ type: "git:history", result: event.result }),
      );
      return;
    }

    if (event.type === "gitCommitFilesResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      defer(() =>
        this.hub.broadcast({ type: "git:commitFiles", result: event.result }),
      );
      return;
    }

    if (event.type === "gitBranchListResult") {
      defer(() => this.rpc.resolveRunnerResponse(event.result));
      defer(() =>
        this.hub.broadcast({ type: "git:branches", result: event.result }),
      );
      return;
    }

    if (event.type === "gitJobResult") {
      const job =
        this.gitJobs?.normalizeRunnerJobResult(event.job) ?? event.job;
      if (this.gitJobs && !this.gitJobs.canAcceptRunnerJobResult(job)) {
        return;
      }
      this.store.upsertGitJob(job);
      this.applyGitJobSessionEffects(job, defer);
      defer(() => this.gitJobs?.completeRunnerJobResult(job));
      defer(() => this.rpc.resolveRunnerResponse(job));
      defer(() => this.hub.broadcast({ type: "git:job", job }));
      return;
    }

    if (event.type === "approvalRequested") {
      if (this.isTerminalSession(event.approval.sessionId)) {
        return;
      }
      const session = this.store.getSession(event.approval.sessionId);
      this.addActivity(
        {
          sessionId: event.approval.sessionId,
          agent: session?.agent ?? "unknown",
          kind: "approval",
          label: "Waiting for approval",
        },
        defer,
      );
      this.store.upsertApproval(event.approval);
      if (session?.status !== "waiting_input") {
        const updatedSession = this.store.updateSessionStatus(
          event.approval.sessionId,
          "waiting_approval",
          nowIso(),
        );
        if (updatedSession) {
          defer(() =>
            this.hub.broadcast({
              type: "session:updated",
              session: updatedSession,
            }),
          );
        }
      }
      defer(() =>
        this.hub.broadcast({
          type: "approval:requested",
          approval: event.approval,
        }),
      );
      return;
    }

    if (event.type === "artifactCreated") {
      this.store.addArtifact(event.artifact);
      defer(() =>
        this.hub.broadcast({
          type: "artifact:created",
          artifact: event.artifact,
        }),
      );
      return;
    }

    this.handleErrorEvent(event, defer);
  }

  private applyGitJobSessionEffects(
    job: GitJob,
    defer: (effect: () => void) => void,
  ): void {
    if (
      job.status === "succeeded" &&
      job.operation === "archive_remove_worktree"
    ) {
      defer(() => this.onArchiveRemoveWorktreeJobSucceeded?.(job));
      return;
    }
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
      defer(() =>
        this.hub.broadcast({ type: "session:updated", session: updated }),
      );
    }
  }

  private addActivity(
    input: Pick<AgentActivity, "sessionId" | "agent" | "kind" | "label">,
    defer: (effect: () => void) => void,
  ): AgentActivity {
    const activity = this.store.addAgentActivity({
      id: newId("activity"),
      sessionId: input.sessionId,
      agent: input.agent,
      kind: input.kind,
      label: input.label,
      createdAt: this.nextOutputTimestamp(),
    });
    defer(() => this.hub.broadcast({ type: "activity:created", activity }));
    return activity;
  }

  private nextOutputTimestamp(sessionId?: string): string {
    const latestSessionMessageTime =
      sessionId === undefined
        ? Number.NaN
        : Date.parse(
            this.store.listMessages(sessionId).at(-1)?.createdAt ?? "",
          );
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
    defer: (effect: () => void) => void,
  ): void {
    if (event.requestId) {
      defer(() =>
        this.rpc.rejectRunnerResponse(
          event.requestId!,
          new RunnerRpcError(event.message, "runner_error", event.code),
        ),
      );
      return;
    }

    if (!event.sessionId && isInternalRunnerError(event)) {
      return;
    }

    defer(() =>
      this.hub.broadcast({
        type: "error",
        message: event.message,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.code ? { code: event.code } : {}),
      }),
    );
    if (event.sessionId && event.code === "SESSION_NOT_RUNNING") {
      const session = this.store.updateSessionStatus(
        event.sessionId,
        "stopped",
        nowIso(),
      );
      if (session) {
        defer(() => this.hub.broadcast({ type: "session:updated", session }));
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
        defer(() => this.hub.broadcast({ type: "session:updated", session }));
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
