import { createHash } from "node:crypto";
import {
  type AttachmentContentResult,
  type AttachmentWriteResult,
  type ApiCreateMessage,
  DEFAULT_MAX_IMAGE_BYTES,
  type AgentRuntimeConfig,
  type GitContextRef,
  type GitJob,
  nowIso,
  type ApiCreateSession,
  type ApiUpdateSession,
  type ClientCommand,
  type ImageAttachmentUpload,
  MAX_PINNED_SESSIONS_PER_PROJECT,
  MAX_TOTAL_IMAGE_BYTES_PER_TURN,
  type Message,
  type MessageAttachment,
  type RunnerAttachmentRef,
  type RunnerCommand,
  type Session,
  type SessionStartResult,
  type SessionStatus,
  type SessionStatusCheckResult,
} from "@roamcli/shared/protocol";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import { newId } from "../../infra/ids.js";
import {
  RunnerRpcError,
  type RunnerRpcClient,
} from "../../infra/runner-rpc-client.js";
import type {
  PendingInputDelivery,
  ServerStore,
  StoredMessageAttachment,
} from "../../infra/sqlite-store.js";
import type { ApprovalService } from "../approvals/approval-service.js";
import { GitJobRunner } from "../git/git-job-runner.js";
import { fail, ok, type ServiceResult } from "../result.js";
import {
  createSessionRecord,
  createUserMessage,
  runnerCanResume,
  runnerExplicitlyCannotResume,
  runnerSupportsAgent,
} from "./session-records.js";

export type DeleteSessionOptions = {
  worktree?: "keep" | "remove";
};

type LegacyApiCreateSession = Omit<ApiCreateSession, "requestId"> & {
  requestId?: string;
};
type LegacyApiCreateMessage = Omit<ApiCreateMessage, "requestId"> & {
  requestId?: string;
};

export class SessionCommandService {
  private readonly gitJobs: GitJobRunner;
  private readonly pendingInputReconciliations = new Map<
    string,
    Promise<SessionStatusCheckResult>
  >();
  private readonly pendingInputSettlements = new Map<
    string,
    Promise<
      ServiceResult<{
        message: Message;
        attachments: MessageAttachment[];
        queued?: true;
      }>
    >
  >();
  private readonly pendingStartReconciliations = new Map<
    string,
    Promise<SessionStartResult>
  >();
  private readonly clientInputRequests = new Map<
    string,
    Promise<
      ServiceResult<{
        message: Message;
        attachments: MessageAttachment[];
        queued?: true;
      }>
    >
  >();

  constructor(
    private readonly store: ServerStore,
    private readonly hub: ConnectionHub,
    private readonly approvals: ApprovalService,
    private readonly rpc: RunnerRpcClient,
    private readonly runnerRpcTimeoutMs: number,
    gitJobs?: GitJobRunner,
  ) {
    this.gitJobs = gitJobs ?? new GitJobRunner(store, hub, rpc);
  }

  async createSession(
    input: ApiCreateSession | LegacyApiCreateSession,
  ): Promise<
    ServiceResult<{
      session: Session;
      attachments: MessageAttachment[];
      queued?: true;
    }>
  > {
    return this.createAndStartSession(input);
  }

  updateSession(
    sessionId: string,
    input: ApiUpdateSession,
  ): ServiceResult<{ session: Session }> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found");
    }

    const now = nowIso();
    let pinnedAt: string | null | undefined;
    if (input.pinned !== undefined) {
      if (input.pinned) {
        const project = this.store.getProject(session.projectId);
        if (session.archivedAt || project?.archivedAt) {
          return fail("session_pin_limit_exceeded");
        }
        if (
          !session.pinnedAt &&
          this.store.countPinnedSessions(session.projectId) >=
            MAX_PINNED_SESSIONS_PER_PROJECT
        ) {
          return fail("session_pin_limit_exceeded");
        }
        pinnedAt = session.pinnedAt ?? now;
      } else {
        pinnedAt = null;
      }
    }

    const updated = this.store.updateSession(session.id, {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(pinnedAt === undefined ? {} : { pinnedAt }),
      updatedAt: now,
    });
    if (!updated) {
      return fail("session_not_found");
    }

    this.hub.broadcast({ type: "session:updated", session: updated });
    return ok({ session: updated });
  }

  async checkSessionStatus(
    sessionId: string,
  ): Promise<ServiceResult<{ session: Session }>> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found");
    }

    if (!hasActiveRunnerWork(session)) {
      return ok({ session });
    }

    if (!this.hub.isRunnerConnectionHealthy(session.runnerId)) {
      this.hub.markRunnerOffline(session.runnerId);
      const stopped = this.stopSessionIfStillActive(session.id, nowIso());
      if (!stopped) {
        return fail("session_not_found");
      }
      return ok({ session: stopped });
    }

    try {
      const result = await this.rpc.requestRunner<SessionStatusCheckResult>(
        session.runnerId,
        {
          type: "checkSessionStatus",
          requestId: newId("session_status_check"),
          sessionId: session.id,
        },
        this.runnerRpcTimeoutMs,
      );
      if (!result.active) {
        const stopped = this.stopSessionIfStillActive(session.id, nowIso());
        if (!stopped) {
          return fail("session_not_found");
        }
        return ok({ session: stopped });
      }
    } catch (error) {
      if (error instanceof RunnerRpcError && error.code === "runner_offline") {
        this.hub.markRunnerOffline(session.runnerId);
        const stopped = this.stopSessionIfStillActive(session.id, nowIso());
        if (!stopped) {
          return fail("session_not_found");
        }
        return ok({ session: stopped });
      }
      if (
        error instanceof RunnerRpcError &&
        error.code === "runner_error" &&
        error.runnerCode === "SESSION_NOT_RUNNING"
      ) {
        const stopped = this.stopSessionIfStillActive(session.id, nowIso());
        if (!stopped) {
          return fail("session_not_found");
        }
        return ok({ session: stopped });
      }
      if (error instanceof RunnerRpcError && error.code === "runner_timeout") {
        return fail("runner_timeout", { message: "runner request timed out" });
      }
      return fail("runner_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return ok({ session: this.store.getSession(session.id) ?? session });
  }

  async deleteSession(
    sessionId: string,
    options: DeleteSessionOptions = {},
  ): Promise<ServiceResult<{ job?: GitJob }>> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found");
    }

    const archivedAt = nowIso();
    const shouldRemoveWorktree =
      options.worktree === "remove" &&
      session.executionMode === "managed_worktree";
    if (
      shouldRemoveWorktree &&
      !session.worktreeDeletedAt &&
      hasActiveRunnerWork(session)
    ) {
      return fail("worktree_remove_failed", {
        message: "Stop the session before archiving and removing its worktree.",
        code: "session_active",
      });
    }

    this.hub.sendToRunner(session.runnerId, {
      type: "controlSignal",
      sessionId: session.id,
      signal: "stop",
    });
    if (shouldRemoveWorktree && !session.worktreeDeletedAt) {
      return this.startArchiveRemoveWorktreeJob(session);
    }
    this.deleteRunnerAttachments(session, archivedAt);
    const archived = this.store.archiveSession(session.id, archivedAt);
    if (archived) {
      this.hub.broadcast({ type: "session:updated", session: archived });
    }
    return ok({});
  }

  public archiveSessionAfterWorktreeRemoval(job: GitJob): void {
    if (
      job.status !== "succeeded" ||
      job.operation !== "archive_remove_worktree" ||
      !job.sessionId
    ) {
      return;
    }
    const session = this.store.getSession(job.sessionId);
    if (!session || session.archivedAt) {
      return;
    }
    const archivedAt = nowIso();
    if (!session.worktreeDeletedAt) {
      this.store.markSessionWorktreeDeleted(session.id, archivedAt);
    }
    this.deleteRunnerAttachments(session, archivedAt);
    const archived = this.store.archiveSession(session.id, archivedAt);
    if (archived) {
      this.hub.broadcast({ type: "session:updated", session: archived });
    }
  }

  private async startArchiveRemoveWorktreeJob(
    session: Session,
  ): Promise<ServiceResult<{ job: GitJob }>> {
    const project = this.store.getProject(session.projectId);
    if (!project || project.archivedAt) {
      return fail("project_not_found");
    }
    const context = {
      kind: "session_worktree",
      sessionId: session.id,
    } satisfies GitContextRef;
    let result: ServiceResult<{ job: GitJob }>;
    try {
      result = await this.gitJobs.run(
        {
          projectId: project.id,
          runnerId: session.runnerId,
          cwd: session.executionFolder,
          context,
          session,
        },
        "archive_remove_worktree",
        (resolved, requestId) => ({
          type: "gitRemoveWorktree",
          requestId,
          projectId: resolved.projectId,
          context: resolved.context,
          cwd: resolved.cwd,
          jobOperation: "archive_remove_worktree",
        }),
      );
    } catch (error) {
      if (error instanceof RunnerRpcError) {
        return fail("worktree_remove_failed", {
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
    if (!result.ok) {
      return result;
    }
    if (result.value.job.status === "failed") {
      return fail("worktree_remove_failed", {
        message: result.value.job.errorSummary ?? "Remove worktree failed",
        ...(result.value.job.errorCode
          ? { code: result.value.job.errorCode }
          : {}),
      });
    }
    return result;
  }

  handleProjectArchived(projectId: string, archivedAt: string): void {
    const sessions = this.store
      .listSessions()
      .filter((session) => session.projectId === projectId);
    for (const session of sessions) {
      this.deleteRunnerAttachments(session, archivedAt);
    }
  }

  async handleClientCommand(
    command: ClientCommand,
    resolverSessionId?: string,
  ): Promise<void> {
    if (command.type === "createSession") {
      const result = await this.createAndStartSession(command);
      if (!result.ok) {
        this.broadcastCommandError(result);
      }
      return;
    }

    if (command.type === "userMessage") {
      const result = await this.createUserMessage(command.sessionId, command);
      if (!result.ok) {
        this.broadcastCommandError(result);
      }
      return;
    }

    if (command.type === "approvalResponse") {
      const result = this.approvals.respondToApproval(
        command.approvalId,
        command,
        resolverSessionId,
      );
      if (!result.ok) {
        const messages: Record<string, string> = {
          approval_not_found: "approval not found",
          approval_already_resolved: "approval already resolved",
          runner_offline: "runner is offline",
        };
        this.hub.broadcast({
          type: "error",
          message: messages[result.error] ?? result.error,
          code: result.error,
        });
      }
      return;
    }

    if (command.type === "activeSessionChanged") {
      return;
    }

    this.handleControlSignal(command);
  }

  async createUserMessage(
    sessionId: string,
    input:
      | ApiCreateMessage
      | LegacyApiCreateMessage
      | Extract<ClientCommand, { type: "userMessage" }>,
  ): Promise<
    ServiceResult<{
      message: Message;
      attachments: MessageAttachment[];
      queued?: true;
    }>
  > {
    const clientRequestId = "requestId" in input ? input.requestId : undefined;
    if (!clientRequestId) {
      return this.createUserMessageOnce(sessionId, input);
    }
    const key = `${sessionId}\0${clientRequestId}`;
    const existing = this.clientInputRequests.get(key);
    if (existing) {
      return existing;
    }
    const request = this.createUserMessageOnce(sessionId, input).finally(() => {
      if (this.clientInputRequests.get(key) === request) {
        this.clientInputRequests.delete(key);
      }
    });
    this.clientInputRequests.set(key, request);
    return request;
  }

  private async createUserMessageOnce(
    sessionId: string,
    input:
      | ApiCreateMessage
      | LegacyApiCreateMessage
      | Extract<ClientCommand, { type: "userMessage" }>,
  ): Promise<
    ServiceResult<{
      message: Message;
      attachments: MessageAttachment[];
      queued?: true;
    }>
  > {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found", { message: "session not found" });
    }

    const clientRequestId = "requestId" in input ? input.requestId : undefined;
    const stableMessageId = clientRequestId
      ? stableInputDeliveryId(session.id, clientRequestId)
      : undefined;
    if (stableMessageId) {
      const existing = this.store.getMessage(session.id, stableMessageId);
      if (existing) {
        const existingAttachments = this.store
          .listStoredMessageAttachments(session.id)
          .filter((attachment) => attachment.messageId === existing.id);
        if (
          existing.role !== "user" ||
          existing.content !== input.content ||
          !pendingAttachmentsMatchUploads(
            existingAttachments,
            input.attachments ?? [],
          )
        ) {
          return fail("runner_error", {
            message: "requestId was already used for different input",
            code: "INPUT_REQUEST_CONFLICT",
          });
        }
        return ok({
          message: existing,
          attachments: existingAttachments.map(toPublicAttachment),
        });
      }
      const pending = this.store.getPendingInputDelivery(stableMessageId);
      if (pending) {
        if (
          pending.sessionId !== session.id ||
          pending.runnerId !== session.runnerId ||
          pending.message.content !== input.content ||
          !pendingAttachmentsMatchUploads(
            pending.attachments,
            input.attachments ?? [],
          )
        ) {
          return fail("runner_error", {
            message: "requestId was already used for different input",
            code: "INPUT_REQUEST_CONFLICT",
          });
        }
        const accepted = {
          message: pending.message,
          attachments: pending.attachments.map(toPublicAttachment),
        };
        return pending.kind === "input"
          ? this.settlePendingInputDelivery(pending, accepted)
          : this.completeAcceptedDelivery(pending, accepted);
      }
    }

    const attachments = input.attachments ?? [];
    const attachmentValidation = this.validateAttachments(
      session.runnerId,
      session.agent,
      attachments,
    );
    if (!attachmentValidation.ok) {
      return attachmentValidation;
    }

    const runner = this.store.getRunner(session.runnerId);
    const canResume = runnerCanResume(runner, session.agent);
    const isActive =
      session.status === "running" ||
      session.status === "waiting_approval" ||
      session.status === "waiting_input";
    const turnInProgress = isActive || session.status === "pending";
    if (session.status === "pending") {
      return fail("session_turn_active", {
        message: "Wait for the pending session turn to start.",
      });
    }
    if (attachments.length > 0 && isActive) {
      return fail("attachments_require_idle", {
        message:
          "Images can be sent after the current session turn has finished.",
      });
    }
    if (turnInProgress && requiresIdleUserTurns(session)) {
      return fail("session_turn_active", {
        message:
          "Claude Code can accept the next message after the current turn completes.",
      });
    }

    if (!isActive) {
      if (!this.hub.isRunnerOnline(session.runnerId)) {
        return fail("runner_offline", { message: "runner is offline" });
      }
      if (!canResume) {
        return fail("session_not_running", {
          message: `${session.agent} session is not running`,
        });
      }
    }

    let runnerAttachments: RunnerAttachmentRef[] = [];
    if (attachments.length > 0) {
      const writeResult = await this.writeRunnerAttachments(
        session.runnerId,
        session.id,
        attachments,
      );
      if (!writeResult.ok) {
        return writeResult;
      }
      runnerAttachments = writeResult.value;
    }

    const generatedMessage = createUserMessage(session.id, input.content);
    const message = stableMessageId
      ? { ...generatedMessage, id: stableMessageId }
      : generatedMessage;
    const storedAttachments = this.toStoredAttachments(
      session,
      message,
      runnerAttachments,
    );
    const response = {
      message,
      attachments: storedAttachments.map(toPublicAttachment),
    };
    if (!isActive) {
      const restartedAt = nowIso();
      const restartedSession: Session = {
        ...session,
        status: "pending",
        updatedAt: restartedAt,
        worktreeDeletedAt: undefined,
      };
      const deliveryId = message.id;
      const startCommand = {
        type: "startSession" as const,
        requestId: newId("session_start"),
        deliveryId,
        session: restartedSession,
        prompt: input.content,
        attachments: [...runnerAttachments],
        ...(session.agentThreadId
          ? { resumeThreadId: session.agentThreadId }
          : {}),
      };
      const prepared = this.store.preparePendingSessionStart(
        {
          deliveryId,
          kind: "start",
          runnerId: session.runnerId,
          sessionId: session.id,
          message,
          attachments: storedAttachments,
          startCommand,
          createdAt: message.createdAt,
        },
        restartedAt,
      );
      this.hub.broadcast({
        type: "session:updated",
        session: prepared.session,
      });
      return this.completeAcceptedDelivery(prepared.delivery, response);
    }

    const inputRequestId =
      session.status === "waiting_input"
        ? this.store.getPendingUserInputRequest(session.id)
        : undefined;
    const pendingInput = this.store.putPendingInputDelivery({
      deliveryId: message.id,
      kind: "input",
      runnerId: session.runnerId,
      sessionId: session.id,
      ...(inputRequestId ? { inputRequestId } : {}),
      message,
      attachments: storedAttachments,
      createdAt: message.createdAt,
    });
    if (
      pendingInput.runnerId !== session.runnerId ||
      pendingInput.sessionId !== session.id ||
      pendingInput.inputRequestId !== inputRequestId ||
      pendingInput.message.content !== input.content
    ) {
      return fail("runner_error", {
        message: "requestId was already used for different input",
        code: "INPUT_REQUEST_CONFLICT",
      });
    }

    return this.settlePendingInputDelivery(pendingInput, response);
  }

  private async settlePendingInputDelivery(
    pending: PendingInputDelivery,
    accepted: { message: Message; attachments: MessageAttachment[] },
  ): Promise<
    ServiceResult<{
      message: Message;
      attachments: MessageAttachment[];
      queued?: true;
    }>
  > {
    if (pending.kind !== "input") {
      return this.completeAcceptedDelivery(pending, accepted);
    }
    const existing = this.pendingInputSettlements.get(pending.deliveryId);
    if (existing) {
      return existing;
    }
    const settlement = this.settlePendingInputDeliveryOnce(
      pending,
      accepted,
    ).finally(() => {
      if (this.pendingInputSettlements.get(pending.deliveryId) === settlement) {
        this.pendingInputSettlements.delete(pending.deliveryId);
      }
    });
    this.pendingInputSettlements.set(pending.deliveryId, settlement);
    return settlement;
  }

  private async settlePendingInputDeliveryOnce(
    pending: PendingInputDelivery,
    accepted: { message: Message; attachments: MessageAttachment[] },
  ): Promise<
    ServiceResult<{
      message: Message;
      attachments: MessageAttachment[];
      queued?: true;
    }>
  > {
    try {
      const result = await this.requestPendingInputReceipt(pending);
      const session = this.store.getSession(pending.sessionId);
      if (result.inputReceipt !== undefined) {
        if (result.inputReceipt.ownership === "owned") {
          return ok(this.finalizePendingInputDelivery(pending.deliveryId));
        }
        if (session?.status === "waiting_input") {
          this.rejectPendingInputDelivery(
            pending.deliveryId,
            "runner no longer owns the pending input delivery",
          );
          return fail("runner_error", {
            message: "runner no longer owns the pending input request",
            code: "INPUT_NOT_OWNED",
          });
        }
        if (result.active) {
          this.rejectPendingInputDelivery(
            pending.deliveryId,
            "runner no longer owns the pending input delivery",
          );
          return fail("runner_error", {
            message: "runner could not accept input for the active session",
            code: "AGENT_INPUT_ERROR",
          });
        }
      }
      if (result.inputDelivered === true) {
        return ok(this.finalizePendingInputDelivery(pending.deliveryId));
      }
      if (result.inputDelivered === false && result.active) {
        this.store.deletePendingInputDelivery(pending.deliveryId);
        return fail("runner_error", {
          message: "runner could not deliver input to the active session",
          code: "AGENT_INPUT_ERROR",
        });
      }
      if (result.inputDelivered === undefined && result.active) {
        if (!session) {
          this.store.deletePendingInputDelivery(pending.deliveryId);
          return fail("session_not_found");
        }
        const sent = pending.inputRequestId
          ? this.hub.sendToRunner(session.runnerId, {
              type: "resolveUserInput",
              sessionId: session.id,
              inputRequestId: pending.inputRequestId,
              content: pending.message.content,
            })
          : this.hub.sendToRunner(session.runnerId, {
              type: "deliverInput",
              sessionId: session.id,
              content: pending.message.content,
            });
        if (!sent) {
          return ok({ ...accepted, queued: true });
        }
        return ok(this.finalizePendingInputDelivery(pending.deliveryId));
      }

      if (!session) {
        this.store.deletePendingInputDelivery(pending.deliveryId);
        return fail("session_not_found");
      }
      if (!this.hub.isRunnerOnline(session.runnerId)) {
        return ok({ ...accepted, queued: true });
      }
      if (
        !runnerCanResume(this.store.getRunner(session.runnerId), session.agent)
      ) {
        return ok({ ...accepted, queued: true });
      }
      const promoted = this.promotePendingInputToStart(pending, session);
      const completed = await this.completePendingDelivery(promoted);
      if (
        !completed.ok &&
        this.store.getPendingInputDelivery(pending.deliveryId)
      ) {
        return ok({ ...accepted, queued: true });
      }
      return completed;
    } catch (error) {
      this.store.markPendingInputDeliveryAttempt(
        pending.deliveryId,
        nowIso(),
        error instanceof Error ? error.message : String(error),
      );
      if (this.store.getPendingInputDelivery(pending.deliveryId)) {
        return ok({ ...accepted, queued: true });
      }
      if (error instanceof RunnerRpcError) {
        if (error.code === "runner_offline") {
          return fail("runner_offline", { message: "runner is offline" });
        }
        if (error.code === "runner_timeout") {
          return fail("runner_timeout", {
            message: "runner request timed out",
          });
        }
      }
      return fail("runner_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async reconcilePendingInputDeliveries(
    runnerId: string,
  ): Promise<void> {
    if (!this.hub.isRunnerOnline(runnerId)) {
      return;
    }
    for (const pending of this.store.listPendingInputDeliveries(runnerId)) {
      if (!this.hub.isRunnerOnline(runnerId)) {
        return;
      }
      const session = this.store.getSession(pending.sessionId);
      if (
        pending.kind === "start" &&
        session &&
        !session.archivedAt &&
        (session.status === "running" ||
          session.status === "completed" ||
          session.status === "failed")
      ) {
        this.finalizePendingInputDelivery(pending.deliveryId);
        continue;
      }
      if (!session || session.archivedAt) {
        this.store.deletePendingInputDelivery(pending.deliveryId);
        continue;
      }
      if (pending.kind === "start" && session.status !== "pending") {
        this.store.deletePendingInputDelivery(pending.deliveryId);
        continue;
      }
      try {
        if (pending.kind === "start") {
          const completed = await this.completePendingDelivery(pending);
          if (
            !completed.ok &&
            (completed.error === "runner_offline" ||
              completed.error === "runner_timeout")
          ) {
            return;
          }
          continue;
        }
        const settled = await this.settlePendingInputDelivery(pending, {
          message: pending.message,
          attachments: pending.attachments.map(toPublicAttachment),
        });
        if (settled.ok && settled.value.queued) {
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.markPendingInputDeliveryAttempt(
          pending.deliveryId,
          nowIso(),
          message,
        );
        if (
          error instanceof RunnerRpcError &&
          (error.code === "runner_offline" || error.code === "runner_timeout")
        ) {
          return;
        }
        this.rejectPendingInputDelivery(pending.deliveryId, message);
      }
    }
  }

  private async completePendingDelivery(
    pending: PendingInputDelivery,
  ): Promise<
    ServiceResult<{ message: Message; attachments: MessageAttachment[] }>
  > {
    let confirmedStartOwnership = false;
    try {
      if (pending.kind === "start") {
        if (!this.runnerSupportsDurableSessionStart(pending)) {
          if (
            !pending.startCommand ||
            !this.hub.sendToRunner(pending.runnerId, pending.startCommand)
          ) {
            return fail("runner_offline", { message: "runner is offline" });
          }
          return ok(this.finalizePendingInputDelivery(pending.deliveryId));
        }
        const result = await this.requestPendingSessionStart(pending);
        if (result.ownership === "owned") {
          confirmedStartOwnership = true;
          return ok(this.finalizePendingInputDelivery(pending.deliveryId));
        }
        this.rejectPendingSessionStart(pending.deliveryId);
        return fail("runner_error", {
          message: "runner did not accept the pending session start",
          code: "START_NOT_OWNED",
        });
      }

      const result = await this.requestPendingInputReceipt(pending);
      if (result.inputReceipt?.ownership === "owned") {
        return ok(this.finalizePendingInputDelivery(pending.deliveryId));
      }
      if (result.inputReceipt?.ownership === "not_owned") {
        this.rejectPendingInputDelivery(
          pending.deliveryId,
          "runner no longer owns the pending input delivery",
        );
        return fail("runner_error", {
          message: "runner no longer owns the pending input delivery",
          code: "INPUT_NOT_OWNED",
        });
      }
      if (result.inputDelivered === true) {
        return ok(this.finalizePendingInputDelivery(pending.deliveryId));
      }
      if (result.inputDelivered === undefined && result.active) {
        const sent = pending.inputRequestId
          ? this.hub.sendToRunner(pending.runnerId, {
              type: "resolveUserInput",
              sessionId: pending.sessionId,
              inputRequestId: pending.inputRequestId,
              content: pending.message.content,
            })
          : this.hub.sendToRunner(pending.runnerId, {
              type: "deliverInput",
              sessionId: pending.sessionId,
              content: pending.message.content,
            });
        if (!sent) {
          return fail("runner_offline", { message: "runner is offline" });
        }
        return ok(this.finalizePendingInputDelivery(pending.deliveryId));
      }
      this.rejectPendingInputDelivery(
        pending.deliveryId,
        "runner did not accept the pending input delivery",
      );
      return fail("runner_error", {
        message: "runner did not accept the pending input delivery",
        code: "INPUT_NOT_OWNED",
      });
    } catch (error) {
      this.store.markPendingInputDeliveryAttempt(
        pending.deliveryId,
        nowIso(),
        error instanceof Error ? error.message : String(error),
      );
      if (error instanceof RunnerRpcError) {
        if (error.code === "runner_offline") {
          return fail("runner_offline", { message: "runner is offline" });
        }
        if (error.code === "runner_timeout") {
          return fail("runner_timeout", {
            message: "runner request timed out",
          });
        }
      }
      if (pending.kind === "start" && !confirmedStartOwnership) {
        this.rejectPendingSessionStart(pending.deliveryId);
      }
      return fail("runner_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async completeAcceptedDelivery(
    pending: PendingInputDelivery,
    accepted: { message: Message; attachments: MessageAttachment[] },
  ): Promise<
    ServiceResult<{
      message: Message;
      attachments: MessageAttachment[];
      queued?: true;
    }>
  > {
    const completed = await this.completePendingDelivery(pending);
    if (
      !completed.ok &&
      this.store.getPendingInputDelivery(pending.deliveryId)
    ) {
      return ok({ ...accepted, queued: true });
    }
    return completed;
  }

  private runnerSupportsDurableSessionStart(
    pending: PendingInputDelivery,
  ): boolean {
    const session = this.store.getSession(pending.sessionId);
    const runner = this.store.getRunner(pending.runnerId);
    return Boolean(
      session &&
      runner?.capabilities.some(
        (capability) =>
          capability.kind === session.agent &&
          capability.supportsDurableSessionStart,
      ),
    );
  }

  private requestPendingSessionStart(
    pending: PendingInputDelivery,
  ): Promise<SessionStartResult> {
    const existing = this.pendingStartReconciliations.get(pending.deliveryId);
    if (existing) {
      return existing;
    }
    if (!pending.startCommand) {
      return Promise.reject(new Error("pending session start has no command"));
    }
    this.store.markPendingInputDeliveryAttempt(pending.deliveryId, nowIso());
    const request = this.rpc
      .requestRunner<SessionStartResult>(
        pending.runnerId,
        {
          ...pending.startCommand,
          requestId: newId("session_start"),
          deliveryId: pending.deliveryId,
        },
        this.runnerRpcTimeoutMs,
      )
      .then((result) => {
        if (result.deliveryId !== pending.deliveryId) {
          throw new RunnerRpcError(
            "runner returned a mismatched session start receipt",
            "runner_error",
            "START_RECEIPT_MISMATCH",
          );
        }
        return result;
      })
      .finally(() => {
        if (
          this.pendingStartReconciliations.get(pending.deliveryId) === request
        ) {
          this.pendingStartReconciliations.delete(pending.deliveryId);
        }
      });
    this.pendingStartReconciliations.set(pending.deliveryId, request);
    return request;
  }

  private requestPendingInputReceipt(
    pending: PendingInputDelivery,
  ): Promise<SessionStatusCheckResult> {
    const existing = this.pendingInputReconciliations.get(pending.deliveryId);
    if (existing) {
      return existing;
    }
    const request = this.requestStableInputReceipt(
      pending.runnerId,
      pending.sessionId,
      pending.deliveryId,
      pending.message.content,
      pending.inputRequestId,
    ).finally(() => {
      if (
        this.pendingInputReconciliations.get(pending.deliveryId) === request
      ) {
        this.pendingInputReconciliations.delete(pending.deliveryId);
      }
    });
    this.pendingInputReconciliations.set(pending.deliveryId, request);
    return request;
  }

  private finalizePendingInputDelivery(deliveryId: string): {
    message: Message;
    attachments: MessageAttachment[];
  } {
    const finalized = this.store.finalizePendingInputDelivery(deliveryId);
    if (!finalized) {
      const pendingMessage = this.store.getMessageById(deliveryId);
      if (!pendingMessage) {
        throw new Error("pending input delivery no longer exists");
      }
      return {
        message: pendingMessage,
        attachments: this.store
          .listStoredMessageAttachments(pendingMessage.sessionId)
          .filter((attachment) => attachment.messageId === deliveryId)
          .map(toPublicAttachment),
      };
    }
    if (finalized.created) {
      this.hub.broadcast({
        type: "message:created",
        message: finalized.message,
      });
      this.broadcastAttachments(finalized.attachments);
    }
    return {
      message: finalized.message,
      attachments: finalized.attachments.map(toPublicAttachment),
    };
  }

  private rejectPendingInputDelivery(
    deliveryId: string,
    message: string,
  ): void {
    const pending = this.store.getPendingInputDelivery(deliveryId);
    if (!pending) {
      return;
    }
    this.store.deletePendingInputDelivery(deliveryId);
    this.hub.broadcast({
      type: "error",
      sessionId: pending.sessionId,
      messageId: pending.message.id,
      message,
      code: "INPUT_NOT_OWNED",
    });
  }

  private async requestStableInputReceipt(
    runnerId: string,
    sessionId: string,
    deliveryId: string,
    content: string,
    inputRequestId?: string,
  ): Promise<SessionStatusCheckResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.store.markPendingInputDeliveryAttempt(deliveryId, nowIso());
        const result = await this.rpc.requestRunner<SessionStatusCheckResult>(
          runnerId,
          {
            type: "checkSessionStatus",
            requestId: newId("input_delivery"),
            sessionId,
            deliverInput: {
              deliveryId,
              ...(inputRequestId === undefined ? {} : { inputRequestId }),
              content,
            },
          },
          this.runnerRpcTimeoutMs,
        );
        if (
          result.inputReceipt !== undefined &&
          result.inputReceipt.deliveryId !== deliveryId
        ) {
          throw new RunnerRpcError(
            "runner returned a mismatched input receipt",
            "runner_error",
            "INPUT_RECEIPT_MISMATCH",
          );
        }
        return result;
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof RunnerRpcError &&
          error.code === "runner_timeout"
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new RunnerRpcError("runner request timed out", "runner_timeout");
  }

  async readAttachmentContent(
    sessionId: string,
    attachmentId: string,
  ): Promise<
    ServiceResult<{
      attachment: MessageAttachment;
      content: Buffer;
    }>
  > {
    const session = this.store.getSession(sessionId);
    const attachment = this.store.getStoredMessageAttachment(
      sessionId,
      attachmentId,
    );
    if (!session || !attachment || attachment.status !== "available") {
      return fail("attachment_unavailable");
    }

    try {
      const result = await this.rpc.requestRunner<AttachmentContentResult>(
        session.runnerId,
        {
          type: "readSessionAttachment",
          requestId: newId("attachment_read"),
          sessionId,
          attachmentId,
          runnerStoragePath: attachment.runnerStoragePath,
          maxBytes: Math.max(1, attachment.size),
        },
        this.runnerRpcTimeoutMs,
      );
      return ok({
        attachment: toPublicAttachment(attachment),
        content: Buffer.from(result.contentBase64, "base64"),
      });
    } catch {
      return fail("attachment_unavailable");
    }
  }

  private async createAndStartSession(
    input:
      | ApiCreateSession
      | LegacyApiCreateSession
      | Extract<ClientCommand, { type: "createSession" }>,
  ): Promise<
    ServiceResult<{
      session: Session;
      attachments: MessageAttachment[];
      queued?: true;
    }>
  > {
    const project = this.store.getProject(input.projectId);
    if (!project || project.archivedAt) {
      return fail("project_not_found", { message: "project not found" });
    }
    const clientRequestId = "requestId" in input ? input.requestId : undefined;
    const creationRequestFingerprint = clientRequestId
      ? sessionCreationRequestFingerprint(input)
      : undefined;
    const stableSessionId = clientRequestId
      ? stableSessionCreationId(project.id, clientRequestId)
      : undefined;
    const stableMessageId =
      stableSessionId && clientRequestId
        ? stableInputDeliveryId(stableSessionId, clientRequestId)
        : undefined;
    if (stableSessionId && stableMessageId) {
      const existingSession = this.store.getSession(stableSessionId);
      if (existingSession) {
        const pending = this.store.getPendingInputDelivery(stableMessageId);
        const existingMessage = this.store.getMessage(
          stableSessionId,
          stableMessageId,
        );
        const storedAttachments = pending
          ? pending.attachments
          : this.store
              .listStoredMessageAttachments(stableSessionId)
              .filter((attachment) => attachment.messageId === stableMessageId);
        const message = pending?.message ?? existingMessage;
        if (
          this.store.getSessionCreationRequestFingerprint(stableSessionId) !==
            creationRequestFingerprint ||
          !message ||
          message.content !== input.prompt ||
          !pendingAttachmentsMatchUploads(
            storedAttachments,
            input.attachments ?? [],
          )
        ) {
          return fail("runner_error", {
            message: "requestId was already used for a different session",
            code: "INPUT_REQUEST_CONFLICT",
          });
        }
        return ok({
          session: existingSession,
          attachments: storedAttachments.map(toPublicAttachment),
        });
      }
    }
    if (!this.hub.isRunnerOnline(project.runnerId)) {
      return fail("runner_offline", { message: "runner is offline" });
    }
    const runner = this.store.getRunner(project.runnerId);
    if (!runnerSupportsAgent(runner, input.agent)) {
      return fail("unsupported_agent", {
        message: `Unsupported agent: ${input.agent}`,
      });
    }
    if (input.executionMode === "remote") {
      return fail("unsupported_execution_mode", {
        message: `${input.executionMode} execution is not available yet`,
      });
    }
    const attachments = input.attachments ?? [];
    const attachmentValidation = this.validateAttachments(
      project.runnerId,
      input.agent,
      attachments,
    );
    if (!attachmentValidation.ok) {
      return attachmentValidation;
    }
    const agentRuntimeConfig = normalizeAgentRuntimeConfig(
      "agentRuntimeConfig" in input
        ? (input.agentRuntimeConfig ?? {})
        : (this.store.getRunnerAgentRuntimeConfigSetting(
            project.runnerId,
            input.agent,
          )?.config ?? {}),
    );

    const generatedSession = createSessionRecord({
      ...input,
      runnerId: project.runnerId,
      agentRuntimeConfig,
      executionMode: input.executionMode,
      executionFolder: project.directory,
      projectDirectory: project.directory,
      ...(runner?.workspaceRoot === undefined
        ? {}
        : { managedWorktreeBaseDirectory: runner.workspaceRoot }),
      ...(runner?.dataDir === undefined
        ? {}
        : { managedWorktreeDataDirectory: runner.dataDir }),
    });
    const session = stableSessionId
      ? { ...generatedSession, id: stableSessionId }
      : generatedSession;
    const generatedMessage = createUserMessage(session.id, input.prompt);
    const message = stableMessageId
      ? { ...generatedMessage, id: stableMessageId }
      : generatedMessage;
    let runnerAttachments: RunnerAttachmentRef[] = [];
    if (attachments.length > 0) {
      const writeResult = await this.writeRunnerAttachments(
        session.runnerId,
        session.id,
        attachments,
      );
      if (!writeResult.ok) {
        return writeResult;
      }
      runnerAttachments = writeResult.value;
    }
    const storedAttachments = this.toStoredAttachments(
      session,
      message,
      runnerAttachments,
    );
    const startCommand = {
      type: "startSession" as const,
      requestId: newId("session_start"),
      deliveryId: message.id,
      session,
      prompt: input.prompt,
      attachments: runnerAttachments,
    };
    const prepared = this.store.createSessionWithPendingStart(
      session,
      {
        deliveryId: message.id,
        kind: "start",
        runnerId: session.runnerId,
        sessionId: session.id,
        message,
        attachments: storedAttachments,
        startCommand,
        createdAt: message.createdAt,
      },
      creationRequestFingerprint,
    );
    this.hub.broadcast({ type: "session:created", session });
    const completed = await this.completePendingDelivery(prepared.delivery);
    if (!completed.ok) {
      if (this.store.getPendingInputDelivery(prepared.delivery.deliveryId)) {
        return ok({
          session: this.store.getSession(session.id) ?? session,
          attachments: storedAttachments.map(toPublicAttachment),
          queued: true,
        });
      }
      return completed;
    }

    return ok({
      session: this.store.getSession(session.id) ?? session,
      attachments: completed.value.attachments,
    });
  }

  private handleControlSignal(
    command: Extract<ClientCommand, { type: "controlSignal" }>,
  ): void {
    const session = this.store.getSession(command.sessionId);
    if (!session) {
      this.hub.broadcast({
        type: "error",
        message: "session not found",
        code: "session_not_found",
      });
      return;
    }

    if (command.signal === "stop") {
      this.stopSessionIfStillActive(session.id, nowIso());
      this.hub.sendToRunner(session.runnerId, {
        type: "controlSignal",
        sessionId: session.id,
        signal: "stop",
      });
      return;
    }

    if (
      command.signal === "resume" &&
      session.status !== "running" &&
      session.status !== "waiting_approval" &&
      session.status !== "waiting_input"
    ) {
      if (!this.hub.isRunnerOnline(session.runnerId)) {
        this.hub.broadcast({
          type: "error",
          message: "runner is offline",
          code: "runner_offline",
        });
        return;
      }
      const runner = this.store.getRunner(session.runnerId);
      if (runnerExplicitlyCannotResume(runner, session.agent)) {
        this.hub.broadcast({
          type: "error",
          message: `${session.agent} sessions cannot be resumed`,
          code: "resume_unsupported",
        });
        return;
      }

      this.restartSession(session, `Resume session ${session.id}`, []);
      return;
    }

    this.hub.sendToRunner(session.runnerId, {
      type: "controlSignal",
      sessionId: session.id,
      signal: command.signal,
    });
  }

  private restartSession(
    session: Session,
    prompt: string,
    attachments: readonly RunnerAttachmentRef[],
  ): void {
    const restartedAt = nowIso();
    const restarted: Session = {
      ...session,
      status: "pending",
      updatedAt: restartedAt,
      worktreeDeletedAt: undefined,
    };
    const receipt = createUserMessage(session.id, prompt);
    const startCommand = {
      type: "startSession",
      requestId: newId("session_start"),
      deliveryId: receipt.id,
      session: restarted,
      prompt,
      attachments: [...attachments],
      ...(session.agentThreadId
        ? { resumeThreadId: session.agentThreadId }
        : {}),
    } satisfies Extract<RunnerCommand, { type: "startSession" }>;
    const prepared = this.store.preparePendingSessionStart(
      {
        deliveryId: receipt.id,
        kind: "start",
        runnerId: session.runnerId,
        sessionId: session.id,
        message: receipt,
        attachments: [],
        startCommand,
        persistMessage: false,
        createdAt: receipt.createdAt,
      },
      restartedAt,
    );
    this.hub.broadcast({
      type: "session:updated",
      session: prepared.session,
    });
    void this.completePendingDelivery(prepared.delivery).catch((error) => {
      this.hub.broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        code: "runner_error",
      });
    });
  }

  private promotePendingInputToStart(
    pending: PendingInputDelivery,
    session: Session,
  ): PendingInputDelivery {
    const restartedAt = nowIso();
    const restarted: Session = {
      ...session,
      status: "pending",
      updatedAt: restartedAt,
      worktreeDeletedAt: undefined,
    };
    const startCommand = {
      type: "startSession",
      requestId: newId("session_start"),
      deliveryId: pending.deliveryId,
      session: restarted,
      prompt: pending.message.content,
      attachments: pending.attachments.map(toRunnerAttachmentRef),
      ...(session.agentThreadId
        ? { resumeThreadId: session.agentThreadId }
        : {}),
    } satisfies Extract<RunnerCommand, { type: "startSession" }>;
    const promoted = this.store.promotePendingInputDeliveryToStart(
      pending.deliveryId,
      startCommand,
      restartedAt,
    );
    this.hub.broadcast({ type: "session:updated", session: promoted.session });
    return promoted.delivery;
  }

  private stopSessionIfStillActive(
    sessionId: string,
    stoppedAt: string,
  ): Session | undefined {
    const latest = this.store.getSession(sessionId);
    if (!latest) {
      return undefined;
    }
    if (!hasActiveRunnerWork(latest)) {
      return latest;
    }
    return this.stopActiveSession(latest, stoppedAt);
  }

  private stopActiveSession(
    session: Session,
    stoppedAt: string,
  ): Session | undefined {
    const cancellation = this.store.cancelPendingInputDeliveriesForSession(
      session.id,
      stoppedAt,
    );
    let stopped =
      cancellation.session?.status === "stopped"
        ? cancellation.session
        : this.store.updateSessionStatus(session.id, "stopped", stoppedAt);
    if (!stopped) {
      return undefined;
    }
    if (isUnconfirmedManagedWorktree(session)) {
      stopped =
        this.store.markSessionWorktreeDeleted(session.id, stoppedAt) ?? stopped;
    }
    this.hub.broadcast({ type: "session:updated", session: stopped });
    return stopped;
  }

  private rejectPendingSessionStart(deliveryId: string): void {
    const pending = this.store.getPendingInputDelivery(deliveryId);
    const session = this.store.rejectPendingSessionStart(deliveryId, nowIso());
    if (session) {
      this.hub.broadcast({ type: "session:updated", session });
    }
    if (pending && pending.persistMessage !== false) {
      this.hub.broadcast({
        type: "error",
        sessionId: pending.sessionId,
        messageId: pending.message.id,
        message: "runner did not accept the pending session start",
        code: "START_NOT_OWNED",
      });
    }
  }

  private validateAttachments(
    runnerId: string,
    agent: string,
    attachments: readonly ImageAttachmentUpload[],
  ): ServiceResult<void> {
    if (attachments.length === 0) {
      return ok(undefined);
    }
    const runner = this.store.getRunner(runnerId);
    const capability = runner?.capabilities.find((item) => item.kind === agent);
    if (!capability?.supportsImages) {
      return fail("image_input_unsupported", {
        message: `${agent} does not support image input`,
      });
    }
    const maxImagesPerTurn = capability.maxImagesPerTurn ?? 0;
    const supportedImageMimeTypes = capability.supportedImageMimeTypes ?? [];
    const maxImageBytes = capability.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    const maxTotalImageBytes =
      capability.maxTotalImageBytes ?? MAX_TOTAL_IMAGE_BYTES_PER_TURN;
    if (
      attachments.reduce((total, attachment) => total + attachment.size, 0) >
      maxTotalImageBytes
    ) {
      return fail("image_too_large", {
        message: `Images exceed the configured ${maxTotalImageBytes}-byte total limit.`,
      });
    }
    if (maxImagesPerTurn > 0 && attachments.length > maxImagesPerTurn) {
      return fail("too_many_images", {
        message: `A maximum of ${maxImagesPerTurn} images can be sent at once.`,
      });
    }
    for (const attachment of attachments) {
      if (
        supportedImageMimeTypes.length > 0 &&
        !supportedImageMimeTypes.includes(attachment.mimeType)
      ) {
        return fail("unsupported_image_type", {
          message: `${attachment.mimeType} images are not supported by ${agent}.`,
        });
      }
      if (attachment.size > maxImageBytes) {
        return fail("image_too_large", {
          message: `${attachment.name} is larger than the configured image limit.`,
        });
      }
    }
    return ok(undefined);
  }

  private async writeRunnerAttachments(
    runnerId: string,
    sessionId: string,
    attachments: readonly ImageAttachmentUpload[],
  ): Promise<ServiceResult<RunnerAttachmentRef[]>> {
    try {
      const result = await this.rpc.requestRunner<AttachmentWriteResult>(
        runnerId,
        {
          type: "writeSessionAttachments",
          requestId: newId("attachment_write"),
          sessionId,
          attachments: [...attachments],
        },
        this.runnerRpcTimeoutMs,
      );
      if (result.attachments.length !== attachments.length) {
        return fail("attachment_write_failed", {
          message: "Runner did not write all image attachments.",
        });
      }
      return ok(result.attachments);
    } catch (error) {
      if (error instanceof RunnerRpcError && error.code === "runner_offline") {
        return fail("runner_offline", { message: "runner is offline" });
      }
      if (error instanceof RunnerRpcError && error.code === "runner_timeout") {
        return fail("runner_timeout", {
          message: "runner request timed out",
        });
      }
      return fail("attachment_write_failed", {
        message: "Image attachments could not be stored by the runner.",
      });
    }
  }

  private toStoredAttachments(
    session: Session,
    message: Message,
    attachments: readonly RunnerAttachmentRef[],
  ): StoredMessageAttachment[] {
    const createdAt = nowIso();
    return attachments.map((attachment) => ({
      id: attachment.id,
      sessionId: session.id,
      messageId: message.id,
      runnerId: session.runnerId,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      sha256: attachment.sha256,
      runnerStoragePath: attachment.runnerStoragePath,
      status: "available",
      createdAt,
    }));
  }

  private deleteRunnerAttachments(session: Session, deletedAt: string): void {
    const attachments = this.store
      .listStoredMessageAttachments(session.id)
      .filter((attachment) => attachment.status === "available");
    if (attachments.length === 0) {
      return;
    }

    this.hub.sendToRunner(session.runnerId, {
      type: "deleteSessionAttachments",
      requestId: newId("attachment_delete"),
      sessionId: session.id,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        runnerStoragePath: attachment.runnerStoragePath,
      })),
    });
    const deleted = this.store.markSessionAttachmentsDeleted(
      session.id,
      deletedAt,
    );
    this.broadcastAttachments(deleted);
  }

  private broadcastAttachments(
    attachments: readonly StoredMessageAttachment[],
  ): void {
    for (const attachment of attachments) {
      this.hub.broadcast({
        type: "message_attachment:created",
        attachment: toPublicAttachment(attachment),
      });
    }
  }

  private broadcastCommandError(
    result: Exclude<ServiceResult<unknown>, { ok: true }>,
  ): void {
    this.hub.broadcast({
      type: "error",
      message: result.message ?? result.error,
      code: result.error,
    });
  }
}

function normalizeAgentRuntimeConfig(
  config: AgentRuntimeConfig,
): AgentRuntimeConfig {
  const normalized: AgentRuntimeConfig = {};
  if (config.model?.trim()) {
    normalized.model = config.model.trim();
  }
  if (config.reasoningEffort?.trim()) {
    normalized.reasoningEffort = config.reasoningEffort.trim();
  }
  if (config.fastMode !== undefined) {
    normalized.fastMode = config.fastMode;
  }
  if (config.serviceTier?.trim()) {
    normalized.serviceTier = config.serviceTier.trim();
  }
  return normalized;
}

function stableInputDeliveryId(sessionId: string, requestId: string): string {
  return `input_${createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(requestId)
    .digest("hex")}`;
}

function stableSessionCreationId(projectId: string, requestId: string): string {
  return `session_${createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(requestId)
    .digest("hex")}`;
}

function sessionCreationRequestFingerprint(
  input:
    | ApiCreateSession
    | LegacyApiCreateSession
    | Extract<ClientCommand, { type: "createSession" }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId: input.projectId,
        agent: input.agent,
        executionMode: input.executionMode ?? "direct",
        gitBaseRef: input.gitBaseRef ?? null,
        gitBranchName: input.gitBranchName ?? null,
        prompt: input.prompt,
        title: "title" in input ? (input.title ?? null) : null,
        agentRuntimeConfig:
          input.agentRuntimeConfig === undefined
            ? null
            : normalizeAgentRuntimeConfig(input.agentRuntimeConfig),
        attachments: (input.attachments ?? []).map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          sha256: createHash("sha256")
            .update(Buffer.from(attachment.contentBase64, "base64"))
            .digest("hex"),
        })),
      }),
    )
    .digest("hex");
}

function pendingAttachmentsMatchUploads(
  stored: readonly StoredMessageAttachment[],
  uploads: readonly ImageAttachmentUpload[],
): boolean {
  if (stored.length !== uploads.length) {
    return false;
  }
  return stored.every((attachment, index) => {
    const upload = uploads[index];
    return Boolean(
      upload &&
      attachment.name === upload.name &&
      attachment.mimeType === upload.mimeType &&
      attachment.size === upload.size &&
      attachment.sha256 ===
        createHash("sha256")
          .update(Buffer.from(upload.contentBase64, "base64"))
          .digest("hex"),
    );
  });
}

function toPublicAttachment(
  attachment: StoredMessageAttachment,
): MessageAttachment {
  return {
    id: attachment.id,
    sessionId: attachment.sessionId,
    messageId: attachment.messageId,
    runnerId: attachment.runnerId,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    sha256: attachment.sha256,
    status: attachment.status,
    createdAt: attachment.createdAt,
    ...(attachment.deletedAt ? { deletedAt: attachment.deletedAt } : {}),
  };
}

function toRunnerAttachmentRef(
  attachment: StoredMessageAttachment,
): RunnerAttachmentRef {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    sha256: attachment.sha256,
    runnerStoragePath: attachment.runnerStoragePath,
  };
}

const ACTIVE_RUNNER_STATUSES = new Set<SessionStatus>([
  "pending",
  "running",
  "waiting_approval",
  "waiting_input",
]);

function hasActiveRunnerWork(session: Session): boolean {
  return ACTIVE_RUNNER_STATUSES.has(session.status);
}

function requiresIdleUserTurns(session: Session): boolean {
  return session.agent === "claude-code";
}

function isUnconfirmedManagedWorktree(session: Session): boolean {
  return (
    session.executionMode === "managed_worktree" &&
    session.status === "pending" &&
    !session.worktreeDeletedAt
  );
}
