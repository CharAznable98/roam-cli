import fs from "node:fs";
import path from "node:path";
import staticPlugin from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import {
  ApiApplyPatchSchema,
  ApiApprovalResponseSchema,
  ApiCreateSessionSchema,
  ApiWriteFileSchema,
  ClientCommandSchema,
  RunnerEventSchema,
  RunnerRegistrationSchema,
  nowIso,
  type Approval,
  type ClientCommand,
  type Message,
  type RunnerEvent,
  type RunnerRegistration,
  type Session,
} from "@roamcli/protocol";
import { hashPayload, verifyApprovalSignature } from "@roamcli/security";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { ArtifactStorage, CreateArtifactRequestSchema } from "./artifacts.js";
import { isAuthorized, requireAuth } from "./auth.js";
import { loadConfig, type ServerConfigInput } from "./config.js";
import { ConnectionHub, RunnerRpcError, parseSocketJson } from "./hub.js";
import { newId } from "./ids.js";
import { ServerStore } from "./store.js";

const SessionParamsSchema = z.object({ id: z.string().min(1) });
const ApprovalParamsSchema = z.object({ id: z.string().min(1) });
const FileTreeQuerySchema = z.object({
  path: z.preprocess(
    (value) => (value === undefined || value === "" ? "." : value),
    z.string().min(1),
  ),
  depth: z.preprocess(
    (value) => (value === undefined || value === "" ? 3 : value),
    z.coerce.number().int().min(0).max(8),
  ),
});
const FileContentQuerySchema = z.object({
  path: z.string().min(1),
  maxBytes: z.preprocess(
    (value) => (value === undefined || value === "" ? 256 * 1024 : value),
    z.coerce
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
  ),
});

export interface AppContext {
  store: ServerStore;
  artifacts: ArtifactStorage;
  hub: ConnectionHub;
}

export type RoamServer = FastifyInstance & { roam: AppContext };

export async function createServer(
  input: ServerConfigInput = {},
): Promise<RoamServer> {
  const config = loadConfig(input);
  const app = Fastify({ logger: false }) as unknown as RoamServer;
  const store = new ServerStore(config.dataDir);
  const artifacts = new ArtifactStorage(config.dataDir);
  const hub = new ConnectionHub(store);
  app.roam = { store, artifacts, hub };

  app.addHook("onClose", async () => {
    store.close();
  });

  await app.register(websocketPlugin);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/v1/")) {
      await requireAuth(config.authToken, request, reply);
    }
  });

  app.get("/v1/sessions", async () => ({ sessions: store.listSessions() }));

  app.get("/v1/runners", async () => ({ runners: store.listOnlineRunners() }));

  app.post("/v1/sessions", async (request, reply) => {
    const parsed = ApiCreateSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    if (!hub.isRunnerOnline(parsed.data.runnerId)) {
      return reply.code(409).send({ error: "runner_offline" });
    }

    const session = createSessionRecord(parsed.data);
    store.createSession(session);
    const message = createUserMessage(session.id, parsed.data.prompt);
    store.addMessage(message);
    hub.broadcast({ type: "session:created", session });
    hub.broadcast({ type: "message:created", message });
    hub.sendToRunner(session.runnerId, {
      type: "startSession",
      session,
      prompt: parsed.data.prompt,
    });

    return reply.code(201).send({ session });
  });

  app.get("/v1/sessions/:id", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const session = store.getSession(params.id);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    return {
      session,
      messages: store.listMessages(session.id),
      approvals: store.listApprovals(session.id),
      artifacts: store.listArtifacts(session.id),
    };
  });

  app.delete("/v1/sessions/:id", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const session = store.getSession(params.id);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    hub.sendToRunner(session.runnerId, {
      type: "controlSignal",
      sessionId: session.id,
      signal: "stop",
    });
    store.deleteSession(session.id);
    artifacts.deleteSessionArtifacts(session.id);
    hub.broadcast({ type: "session:deleted", sessionId: session.id });
    return reply.code(204).send();
  });

  app.get("/v1/sessions/:id/files", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const parsed = FileTreeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const session = store.getSession(params.id);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    try {
      const result = await hub.requestRunner(
        session.runnerId,
        {
          type: "readFileTree",
          requestId: newId("file_tree"),
          sessionId: session.id,
          path: parsed.data.path,
          depth: parsed.data.depth,
        },
        config.runnerRpcTimeoutMs,
      );
      return { result };
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.get("/v1/sessions/:id/files/content", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const parsed = FileContentQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const session = store.getSession(params.id);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    try {
      const result = await hub.requestRunner(
        session.runnerId,
        {
          type: "readFileContent",
          requestId: newId("file_content"),
          sessionId: session.id,
          path: parsed.data.path,
          maxBytes: parsed.data.maxBytes,
        },
        config.runnerRpcTimeoutMs,
      );
      return { result };
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.put("/v1/sessions/:id/files/content", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const parsed = ApiWriteFileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const session = store.getSession(params.id);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    try {
      const result = await hub.requestRunner(
        session.runnerId,
        {
          type: "writeFileContent",
          requestId: newId("file_write"),
          sessionId: session.id,
          path: parsed.data.path,
          content: parsed.data.content,
          encoding: parsed.data.encoding,
        },
        config.runnerRpcTimeoutMs,
      );
      return { result };
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/sessions/:id/patches/apply", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const parsed = ApiApplyPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const session = store.getSession(params.id);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    if (
      !isValidApprovalSignature(
        config.approvalSecret,
        patchSignatureTarget(session.id, parsed.data.patch),
        true,
        parsed.data.signedAt,
        parsed.data.signature,
      )
    ) {
      return reply.code(403).send({ error: "invalid_signature" });
    }

    try {
      const result = await hub.requestRunner(
        session.runnerId,
        {
          type: "applyPatch",
          requestId: newId("patch_apply"),
          sessionId: session.id,
          patch: parsed.data.patch,
          strip: parsed.data.strip,
          signedAt: parsed.data.signedAt,
          signature: parsed.data.signature,
        },
        config.runnerRpcTimeoutMs,
      );
      return { result };
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/approvals/:id", async (request, reply) => {
    const params = ApprovalParamsSchema.parse(request.params);
    const parsed = ApiApprovalResponseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const approval = store.getApproval(params.id);
    if (!approval) {
      return reply.code(404).send({ error: "approval_not_found" });
    }
    if (
      !isValidApprovalSignature(
        config.approvalSecret,
        approval.id,
        parsed.data.approved,
        parsed.data.signedAt,
        parsed.data.signature,
      )
    ) {
      return reply.code(403).send({ error: "invalid_signature" });
    }

    const updated: Approval = {
      ...approval,
      status: parsed.data.approved ? "approved" : "rejected",
      resolvedAt: nowIso(),
      clientSignature: parsed.data.signature,
    };
    store.upsertApproval(updated);
    hub.broadcast({ type: "approval:updated", approval: updated });
    hub.sendToRunner(updated.runnerId, {
      type: "resolveApproval",
      approvalId: updated.id,
      approved: parsed.data.approved,
      signedAt: parsed.data.signedAt,
      signature: parsed.data.signature,
    });

    return { approval: updated };
  });

  app.post("/v1/artifacts", async (request, reply) => {
    const parsed = CreateArtifactRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    if (!store.getSession(parsed.data.sessionId)) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    const artifact = artifacts.write(parsed.data);
    store.addArtifact(artifact);
    hub.broadcast({ type: "artifact:created", artifact });
    return reply.code(201).send({ artifact });
  });

  app.get("/v1/stream", { websocket: true }, (socket, request) => {
    if (!isAuthorized(config.authToken, request)) {
      socket.close(1008, "unauthorized");
      return;
    }
    hub.addStream(socket);
    socket.on("message", (data) => {
      try {
        const command = ClientCommandSchema.parse(parseSocketJson(data));
        handleClientCommand(command, store, hub, config.approvalSecret);
      } catch (error) {
        hub.sendError(
          socket,
          error instanceof Error ? error.message : "invalid command",
          "invalid_command",
        );
      }
    });
  });

  app.get("/v1/runner", { websocket: true }, (socket, request) => {
    if (!isAuthorized(config.authToken, request)) {
      socket.close(1008, "unauthorized");
      return;
    }

    let registeredRunner: RunnerRegistration | undefined;

    socket.on("message", (data) => {
      try {
        const payload = parseSocketJson(data);
        if (!registeredRunner) {
          registeredRunner = parseRunnerRegistration(payload);
          hub.registerRunner(registeredRunner, socket);
          return;
        }

        const event = RunnerEventSchema.parse(payload);
        handleRunnerEvent(event, store, hub);
      } catch (error) {
        hub.sendError(
          socket,
          error instanceof Error ? error.message : "invalid runner event",
          "invalid_runner_event",
        );
      }
    });
  });

  if (config.webDistDir) {
    await registerWebDist(app, config.webDistDir);
  }

  return app;
}

function createSessionRecord(
  input: z.infer<typeof ApiCreateSessionSchema>,
): Session {
  const now = nowIso();
  return {
    id: newId("session"),
    title: input.title ?? input.prompt.slice(0, 80),
    runnerId: input.runnerId,
    agent: input.agent,
    status: "pending",
    cwd: input.cwd,
    createdAt: now,
    updatedAt: now,
  };
}

function createUserMessage(sessionId: string, content: string): Message {
  return {
    id: newId("message"),
    sessionId,
    role: "user",
    content,
    encrypted: false,
    createdAt: nowIso(),
  };
}

function parseRunnerRegistration(payload: unknown): RunnerRegistration {
  const direct = RunnerRegistrationSchema.safeParse(payload);
  if (direct.success) {
    return direct.data;
  }

  const wrapped = RunnerEventSchema.safeParse(payload);
  if (wrapped.success && wrapped.data.type === "registered") {
    return wrapped.data.runner;
  }

  return RunnerRegistrationSchema.parse(payload);
}

function handleClientCommand(
  command: ClientCommand,
  store: ServerStore,
  hub: ConnectionHub,
  approvalSecret: string | undefined,
): void {
  if (command.type === "createSession") {
    if (!hub.isRunnerOnline(command.runnerId)) {
      hub.broadcast({
        type: "error",
        message: "runner is offline",
        code: "runner_offline",
      });
      return;
    }
    const session = createSessionRecord(command);
    const message = createUserMessage(session.id, command.prompt);
    store.createSession(session);
    store.addMessage(message);
    hub.broadcast({ type: "session:created", session });
    hub.broadcast({ type: "message:created", message });
    hub.sendToRunner(session.runnerId, {
      type: "startSession",
      session,
      prompt: command.prompt,
    });
    return;
  }

  if (command.type === "userMessage") {
    const session = store.getSession(command.sessionId);
    if (!session) {
      hub.broadcast({
        type: "error",
        message: "session not found",
        code: "session_not_found",
      });
      return;
    }
    const message = createUserMessage(session.id, command.content);
    store.addMessage(message);
    hub.broadcast({ type: "message:created", message });
    const runner = store.getRunner(session.runnerId);
    const capability = runner?.capabilities.find((item) => item.kind === session.agent);
    const canResumeCodexJson = capability?.parser === "codex-json" && session.agentThreadId !== undefined;
    if (session.status !== "running" && session.status !== "waiting_approval") {
      if (!hub.isRunnerOnline(session.runnerId)) {
        hub.broadcast({
          type: "error",
          message: "runner is offline",
          code: "runner_offline",
        });
        return;
      }
      if (!canResumeCodexJson) {
        hub.broadcast({
          type: "error",
          message: `${session.agent} session is not running`,
          code: "session_not_running",
        });
        return;
      }

      const pending = store.updateSessionStatus(session.id, "pending", nowIso());
      if (pending) {
        hub.broadcast({ type: "session:updated", session: pending });
      }
      hub.sendToRunner(session.runnerId, {
        type: "startSession",
        session: pending ?? { ...session, status: "pending" },
        prompt: command.content,
        resumeThreadId: session.agentThreadId,
      });
      return;
    }
    hub.sendToRunner(session.runnerId, {
      type: "deliverInput",
      sessionId: session.id,
      content: command.content,
    });
    return;
  }

  if (command.type === "approvalResponse") {
    const approval = store.getApproval(command.approvalId);
    if (!approval) {
      hub.broadcast({
        type: "error",
        message: "approval not found",
        code: "approval_not_found",
      });
      return;
    }
    if (
      !isValidApprovalSignature(
        approvalSecret,
        approval.id,
        command.approved,
        command.signedAt,
        command.signature,
      )
    ) {
      hub.broadcast({
        type: "error",
        message: "invalid approval signature",
        code: "invalid_signature",
      });
      return;
    }
    const updated: Approval = {
      ...approval,
      status: command.approved ? "approved" : "rejected",
      resolvedAt: nowIso(),
      clientSignature: command.signature,
    };
    store.upsertApproval(updated);
    hub.broadcast({ type: "approval:updated", approval: updated });
    hub.sendToRunner(updated.runnerId, {
      type: "resolveApproval",
      approvalId: updated.id,
      approved: command.approved,
      signedAt: command.signedAt,
      signature: command.signature,
    });
    return;
  }

  const session = store.getSession(command.sessionId);
  if (!session) {
    hub.broadcast({
      type: "error",
      message: "session not found",
      code: "session_not_found",
    });
    return;
  }

  if (command.signal === "resume" && session.status !== "running" && session.status !== "waiting_approval") {
    if (!hub.isRunnerOnline(session.runnerId)) {
      hub.broadcast({
        type: "error",
        message: "runner is offline",
        code: "runner_offline",
      });
      return;
    }
    const runner = store.getRunner(session.runnerId);
    const capability = runner?.capabilities.find((item) => item.kind === session.agent);
    if (capability?.supportsResume === false) {
      hub.broadcast({
        type: "error",
        message: `${session.agent} sessions cannot be resumed`,
        code: "resume_unsupported",
      });
      return;
    }

    const pending = store.updateSessionStatus(session.id, "pending", nowIso());
    if (pending) {
      hub.broadcast({ type: "session:updated", session: pending });
    }
    const resumeThreadId = capability?.parser === "codex-json" ? session.agentThreadId : undefined;
    hub.sendToRunner(session.runnerId, {
      type: "startSession",
      session: pending ?? { ...session, status: "pending" },
      prompt: `Resume session ${session.id}`,
      ...(resumeThreadId ? { resumeThreadId } : {}),
    });
    return;
  }

  hub.sendToRunner(session.runnerId, {
    type: "controlSignal",
    sessionId: session.id,
    signal: command.signal,
  });
}

function handleRunnerEvent(
  event: RunnerEvent,
  store: ServerStore,
  hub: ConnectionHub,
): void {
  if (event.type === "registered") {
    store.setRunnerOnline(event.runner, true, nowIso());
    hub.broadcast({ type: "runner:online", runner: event.runner });
    return;
  }

  if (event.type === "sessionStatus") {
    const session = store.updateSessionStatus(
      event.sessionId,
      event.status,
      nowIso(),
    );
    if (session) {
      hub.broadcast({ type: "session:updated", session });
    }
    return;
  }

  if (event.type === "sessionThread") {
    const session = store.updateSessionThread(
      event.sessionId,
      event.threadId,
      nowIso(),
    );
    if (session) {
      hub.broadcast({ type: "session:updated", session });
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
    store.addMessage(message);
    hub.broadcast({ type: "message:created", message });
    return;
  }

  if (event.type === "token") {
    store.appendAssistantToken(event.sessionId, event.content, nowIso());
    hub.broadcast({
      type: "token",
      sessionId: event.sessionId,
      content: event.content,
      encrypted: event.encrypted,
    });
    return;
  }

  if (event.type === "terminalData") {
    hub.broadcast({
      type: "terminal:data",
      sessionId: event.sessionId,
      chunk: event.chunk,
    });
    return;
  }

  if (event.type === "fileTreeResult") {
    hub.resolveRunnerResponse(event.result);
    hub.broadcast({ type: "file:tree", result: event.result });
    return;
  }

  if (event.type === "fileContentResult") {
    hub.resolveRunnerResponse(event.result);
    hub.broadcast({ type: "file:content", result: event.result });
    return;
  }

  if (event.type === "fileWriteResult") {
    hub.resolveRunnerResponse(event.result);
    hub.broadcast({ type: "file:written", result: event.result });
    return;
  }

  if (event.type === "patchApplyResult") {
    hub.resolveRunnerResponse(event.result);
    hub.broadcast({ type: "patch:applied", result: event.result });
    return;
  }

  if (event.type === "approvalRequested") {
    store.upsertApproval(event.approval);
    const session = store.updateSessionStatus(
      event.approval.sessionId,
      "waiting_approval",
      nowIso(),
    );
    if (session) {
      hub.broadcast({ type: "session:updated", session });
    }
    hub.broadcast({ type: "approval:requested", approval: event.approval });
    return;
  }

  if (event.type === "artifactCreated") {
    store.addArtifact(event.artifact);
    hub.broadcast({ type: "artifact:created", artifact: event.artifact });
    return;
  }

  hub.broadcast({
    type: "error",
    message: event.message,
    ...(event.code ? { code: event.code } : {}),
  });
  if (event.sessionId && event.code !== "SESSION_NOT_RUNNING") {
    const session = store.updateSessionStatus(
      event.sessionId,
      "failed",
      nowIso(),
    );
    if (session) {
      hub.broadcast({ type: "session:updated", session });
    }
  }
}

function sendRunnerRpcError(reply: FastifyReply, error: unknown) {
  if (error instanceof RunnerRpcError && error.code === "runner_offline") {
    return reply.code(409).send({ error: "runner_offline" });
  }
  if (error instanceof RunnerRpcError && error.code === "runner_timeout") {
    return reply.code(504).send({ error: "runner_timeout" });
  }
  throw error;
}

function isValidApprovalSignature(
  secret: string | undefined,
  approvalId: string,
  approved: boolean,
  signedAt: string,
  signature: string,
): boolean {
  if (!secret) {
    return true;
  }
  return verifyApprovalSignature(secret, approvalId, approved, signedAt, signature);
}

function patchSignatureTarget(sessionId: string, patch: string): string {
  return `patch:${sessionId}:${hashPayload(patch)}`;
}

async function registerWebDist(
  app: FastifyInstance,
  webDistDir: string,
): Promise<void> {
  await app.register(staticPlugin, {
    root: webDistDir,
    prefix: "/",
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/v1/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const indexPath = path.join(webDistDir, "index.html");
    if (fs.existsSync(indexPath)) {
      return reply.type("text/html").send(fs.createReadStream(indexPath));
    }
    return reply.code(404).send({ error: "not_found" });
  });
}
