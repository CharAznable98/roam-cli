import { nowIso, type Message, type RunnerEvent } from "@roamcli/protocol";
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
      this.store.setRunnerOnline(event.runner, true, nowIso());
      this.hub.broadcast({ type: "runner:online", runner: event.runner });
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
      this.store.appendAssistantToken(event.sessionId, event.content, nowIso());
      this.hub.broadcast({
        type: "token",
        sessionId: event.sessionId,
        content: event.content,
        encrypted: event.encrypted,
      });
      return;
    }

    if (event.type === "terminalData") {
      this.hub.broadcast({
        type: "terminal:data",
        sessionId: event.sessionId,
        chunk: event.chunk,
      });
      return;
    }

    if (event.type === "fileTreeResult") {
      this.rpc.resolveRunnerResponse(event.result);
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

    if (event.type === "patchApplyResult") {
      this.rpc.resolveRunnerResponse(event.result);
      this.hub.broadcast({ type: "patch:applied", result: event.result });
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
