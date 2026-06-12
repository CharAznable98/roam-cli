import {
  nowIso,
  type ApiCreateSession,
  type ClientCommand,
  type Session,
} from "@roamcli/shared/protocol";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import type { ServerStore } from "../../infra/sqlite-store.js";
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
  ) {}

  createSession(input: ApiCreateSession): ServiceResult<{ session: Session }> {
    return this.createAndStartSession(input);
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
    const archived = this.store.archiveSession(session.id, nowIso());
    if (archived) {
      this.hub.broadcast({ type: "session:updated", session: archived });
    }
    return ok(undefined);
  }

  handleClientCommand(command: ClientCommand): void {
    if (command.type === "createSession") {
      const result = this.createAndStartSession(command);
      if (!result.ok) {
        this.broadcastCommandError(result);
      }
      return;
    }

    if (command.type === "userMessage") {
      this.handleUserMessage(command);
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

  private createAndStartSession(
    input: ApiCreateSession | Extract<ClientCommand, { type: "createSession" }>,
  ): ServiceResult<{ session: Session }> {
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

    const session = createSessionRecord({
      ...input,
      runnerId: project.runnerId,
      executionMode: input.executionMode,
      executionFolder: project.directory,
      projectDirectory: project.directory,
      ...(runner?.workspaceRoot === undefined
        ? {}
        : { managedWorktreeBaseDirectory: runner.workspaceRoot }),
    });
    const message = createUserMessage(session.id, input.prompt);
    this.store.createSession(session);
    this.store.addMessage(message);
    this.hub.broadcast({ type: "session:created", session });
    this.hub.broadcast({ type: "message:created", message });

    const sent = this.hub.sendToRunner(session.runnerId, {
      type: "startSession",
      session,
      prompt: input.prompt,
    });
    if (!sent) {
      this.store.deleteSession(session.id);
      this.hub.broadcast({ type: "session:deleted", sessionId: session.id });
      return fail("runner_offline", { message: "runner is offline" });
    }

    return ok({ session });
  }

  private handleUserMessage(
    command: Extract<ClientCommand, { type: "userMessage" }>,
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

    const message = createUserMessage(session.id, command.content);
    this.store.addMessage(message);
    this.hub.broadcast({ type: "message:created", message });
    const runner = this.store.getRunner(session.runnerId);
    const canResume = runnerCanResume(runner, session.agent);
    if (session.status !== "running" && session.status !== "waiting_approval") {
      if (!this.hub.isRunnerOnline(session.runnerId)) {
        this.hub.broadcast({
          type: "error",
          message: "runner is offline",
          code: "runner_offline",
        });
        return;
      }
      if (!canResume) {
        this.hub.broadcast({
          type: "error",
          message: `${session.agent} session is not running`,
          code: "session_not_running",
        });
        return;
      }

      this.restartSession(session, command.content);
      return;
    }

    this.hub.sendToRunner(session.runnerId, {
      type: "deliverInput",
      sessionId: session.id,
      content: command.content,
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

      this.restartSession(session, `Resume session ${session.id}`);
      return;
    }

    this.hub.sendToRunner(session.runnerId, {
      type: "controlSignal",
      sessionId: session.id,
      signal: command.signal,
    });
  }

  private restartSession(session: Session, prompt: string): void {
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
      ...(session.agentThreadId
        ? { resumeThreadId: session.agentThreadId }
        : {}),
    });
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
