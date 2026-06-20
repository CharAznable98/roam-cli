import {
  type AttachmentContentResult,
  type AttachmentWriteResult,
  type ApiCreateMessage,
  nowIso,
  type ApiCreateSession,
  type ApiUpdateSession,
  type ClientCommand,
  type ImageAttachmentUpload,
  type Message,
  type MessageAttachment,
  type RunnerAttachmentRef,
  type Session,
} from "@roamcli/shared/protocol";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import { newId } from "../../infra/ids.js";
import {
  RunnerRpcError,
  type RunnerRpcClient,
} from "../../infra/runner-rpc-client.js";
import type {
  ServerStore,
  StoredMessageAttachment,
} from "../../infra/sqlite-store.js";
import type { ApprovalService } from "../approvals/approval-service.js";
import { fail, ok, type ServiceResult } from "../result.js";
import {
  createSessionRecord,
  createUserMessage,
  runnerCanResume,
  runnerExplicitlyCannotResume,
  runnerSupportsAgent,
} from "./session-records.js";

export class SessionCommandService {
  constructor(
    private readonly store: ServerStore,
    private readonly hub: ConnectionHub,
    private readonly approvals: ApprovalService,
    private readonly rpc: RunnerRpcClient,
    private readonly runnerRpcTimeoutMs: number,
  ) {}

  async createSession(
    input: ApiCreateSession,
  ): Promise<
    ServiceResult<{ session: Session; attachments: MessageAttachment[] }>
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

    const updated = this.store.updateSessionTitle(
      session.id,
      input.title,
      nowIso(),
    );
    if (!updated) {
      return fail("session_not_found");
    }

    this.hub.broadcast({ type: "session:updated", session: updated });
    return ok({ session: updated });
  }

  deleteSession(sessionId: string): ServiceResult<void> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found");
    }

    this.hub.sendToRunner(session.runnerId, {
      type: "controlSignal",
      sessionId: session.id,
      signal: "stop",
    });
    const archivedAt = nowIso();
    this.deleteRunnerAttachments(session, archivedAt);
    const archived = this.store.archiveSession(session.id, archivedAt);
    if (archived) {
      this.hub.broadcast({ type: "session:updated", session: archived });
    }
    return ok(undefined);
  }

  handleProjectArchived(projectId: string, archivedAt: string): void {
    const sessions = this.store
      .listSessions()
      .filter((session) => session.projectId === projectId);
    for (const session of sessions) {
      this.deleteRunnerAttachments(session, archivedAt);
    }
  }

  async handleClientCommand(command: ClientCommand): Promise<void> {
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
      );
      if (!result.ok) {
        const messages: Record<string, string> = {
          approval_not_found: "approval not found",
          invalid_signature: "invalid approval signature",
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

    this.handleControlSignal(command);
  }

  async createUserMessage(
    sessionId: string,
    input: ApiCreateMessage | Extract<ClientCommand, { type: "userMessage" }>,
  ): Promise<
    ServiceResult<{ message: Message; attachments: MessageAttachment[] }>
  > {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found", { message: "session not found" });
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
      session.status === "running" || session.status === "waiting_approval";
    if (attachments.length > 0 && isActive) {
      return fail("attachments_require_idle", {
        message:
          "Images can be sent after the current session turn has finished.",
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

    const message = createUserMessage(session.id, input.content);
    const storedAttachments = this.toStoredAttachments(
      session,
      message,
      runnerAttachments,
    );
    this.store.addMessage(message);
    this.store.addMessageAttachments(storedAttachments);
    this.hub.broadcast({ type: "message:created", message });
    this.broadcastAttachments(storedAttachments);

    if (!isActive) {
      this.restartSession(session, input.content, runnerAttachments);
      return ok({
        message,
        attachments: storedAttachments.map(toPublicAttachment),
      });
    }

    const sent = this.hub.sendToRunner(session.runnerId, {
      type: "deliverInput",
      sessionId: session.id,
      content: input.content,
    });
    if (!sent) {
      return fail("runner_offline", { message: "runner is offline" });
    }

    return ok({
      message,
      attachments: storedAttachments.map(toPublicAttachment),
    });
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
    input: ApiCreateSession | Extract<ClientCommand, { type: "createSession" }>,
  ): Promise<
    ServiceResult<{ session: Session; attachments: MessageAttachment[] }>
  > {
    const project = this.store.getProject(input.projectId);
    if (!project || project.archivedAt) {
      return fail("project_not_found", { message: "project not found" });
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

    const session = createSessionRecord({
      ...input,
      runnerId: project.runnerId,
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
    const message = createUserMessage(session.id, input.prompt);
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
    this.store.createSession(session);
    this.store.addMessage(message);
    this.store.addMessageAttachments(storedAttachments);
    this.hub.broadcast({ type: "session:created", session });
    this.hub.broadcast({ type: "message:created", message });
    this.broadcastAttachments(storedAttachments);

    const sent = this.hub.sendToRunner(session.runnerId, {
      type: "startSession",
      session,
      prompt: input.prompt,
      attachments: runnerAttachments,
    });
    if (!sent) {
      this.store.deleteSession(session.id);
      this.hub.broadcast({ type: "session:deleted", sessionId: session.id });
      return fail("runner_offline", { message: "runner is offline" });
    }

    return ok({
      session,
      attachments: storedAttachments.map(toPublicAttachment),
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

    if (
      command.signal === "resume" &&
      session.status !== "running" &&
      session.status !== "waiting_approval"
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
    const pending = this.store.updateSessionStatus(
      session.id,
      "pending",
      nowIso(),
    );
    if (pending) {
      this.hub.broadcast({ type: "session:updated", session: pending });
    }
    this.hub.sendToRunner(session.runnerId, {
      type: "startSession",
      session: pending ?? { ...session, status: "pending" },
      prompt,
      attachments: [...attachments],
      ...(session.agentThreadId
        ? { resumeThreadId: session.agentThreadId }
        : {}),
    });
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
    const maxImageBytes = capability.maxImageBytes ?? 10 * 1024 * 1024;
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
