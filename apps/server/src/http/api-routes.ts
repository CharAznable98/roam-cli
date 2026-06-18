import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ApiApplyPatchSchema,
  ApiApprovalResponseSchema,
  ApiCreateProjectSchema,
  ApiCreateSessionSchema,
  ApiGitBlameQuerySchema,
  ApiGitCommitSchema,
  ApiGitContextSchema,
  ApiGitFileDiffQuerySchema,
  ApiGitHistoryQuerySchema,
  ApiGitInitSchema,
  ApiGitPathsSchema,
  ApiGitRemoteOperationSchema,
  ApiGitRemoveWorktreeSchema,
  ApiUpdateProjectSchema,
  ApiUpdateSessionSchema,
  ApiWriteFileSchema,
  nowIso,
} from "@roamcli/shared/protocol";
import { newId } from "../infra/ids.js";
import { CreateArtifactRequestSchema } from "../infra/local-artifact-storage.js";
import type { AppContext } from "../server/context.js";
import { sendRunnerRpcError } from "./errors.js";
import type { ServiceResult } from "../modules/result.js";
import {
  ApprovalParamsSchema,
  FileContentQuerySchema,
  FileTreeQuerySchema,
  ProjectParamsSchema,
  SessionParamsSchema,
} from "./schemas.js";

export async function registerApiRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  registerRunnerRoutes(app, context);
  registerProjectRoutes(app, context);
  registerSessionRoutes(app, context);
  registerWorkspaceRoutes(app, context);
  registerGitRoutes(app, context);
  registerApprovalRoutes(app, context);
  registerArtifactRoutes(app, context);
}

function registerRunnerRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/runners", async () => ({
    runners: context.store.listOnlineRunners(),
  }));
}

function registerSessionRoutes(
  app: FastifyInstance,
  context: AppContext,
): void {
  app.get("/v1/sessions", async () => ({
    sessions: context.store.listSessions(),
  }));

  app.post("/v1/sessions", async (request, reply) => {
    const parsed = ApiCreateSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const result = context.services.sessions.createSession(parsed.data);
    if (!result.ok) {
      if (result.error === "runner_offline") {
        return reply.code(409).send({ error: "runner_offline" });
      }
      if (result.error === "unsupported_agent") {
        return reply.code(400).send({ error: "unsupported_agent" });
      }
      if (result.error === "project_not_found") {
        return reply.code(404).send({ error: "project_not_found" });
      }
      if (result.error === "unsupported_execution_mode") {
        return reply.code(400).send({ error: "unsupported_execution_mode" });
      }
      return reply.code(400).send({ error: result.error });
    }

    return reply.code(201).send(result.value);
  });

  app.patch("/v1/sessions/:id", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const parsed = ApiUpdateSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const result = context.services.sessions.updateSession(
      params.id,
      parsed.data,
    );
    if (!result.ok) {
      if (result.error === "session_not_found") {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return reply.code(400).send({ error: result.error });
    }

    return result.value;
  });

  app.get("/v1/sessions/:id", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const session = context.store.getSession(params.id);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    return {
      session,
      messages: context.store.listMessages(session.id),
      approvals: context.store.listApprovals(session.id),
      artifacts: context.store.listArtifacts(session.id),
    };
  });

  app.delete("/v1/sessions/:id", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const result = context.services.sessions.deleteSession(params.id);
    if (!result.ok) {
      if (result.error === "session_not_found") {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return reply.code(400).send({ error: result.error });
    }
    return reply.code(204).send();
  });
}

function registerProjectRoutes(
  app: FastifyInstance,
  context: AppContext,
): void {
  app.get("/v1/projects", async () => ({
    projects: context.store.listProjects(),
  }));

  app.post("/v1/projects", async (request, reply) => {
    const parsed = ApiCreateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    if (!context.hub.isRunnerOnline(parsed.data.runnerId)) {
      return reply.code(409).send({ error: "runner_offline" });
    }
    const runner = context.store.getRunner(parsed.data.runnerId);
    if (!runner) {
      return reply.code(404).send({ error: "runner_not_found" });
    }
    const duplicateProject = context.store
      .listProjects()
      .find(
        (project) =>
          project.runnerId === parsed.data.runnerId &&
          project.directory === parsed.data.directory,
      );
    if (duplicateProject) {
      return reply.code(409).send({ error: "project_already_exists" });
    }
    try {
      await context.services.workspace.validateRunnerDirectory(
        parsed.data.runnerId,
        parsed.data.directory,
      );
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
    const now = nowIso();
    const project = context.store.createProject({
      id: newId("project"),
      name: parsed.data.name,
      runnerId: parsed.data.runnerId,
      directory: parsed.data.directory,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    });
    context.hub.broadcast({ type: "project:created", project });
    return reply.code(201).send({ project });
  });

  app.patch("/v1/projects/:id", async (request, reply) => {
    const params = ProjectParamsSchema.parse(request.params);
    const parsed = ApiUpdateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const existing = context.store.getProject(params.id);
    if (!existing) {
      return reply.code(404).send({ error: "project_not_found" });
    }
    if (parsed.data.directory !== undefined) {
      if (!context.hub.isRunnerOnline(existing.runnerId)) {
        return reply.code(409).send({ error: "runner_offline" });
      }
      try {
        await context.services.workspace.validateRunnerDirectory(
          existing.runnerId,
          parsed.data.directory,
        );
      } catch (error) {
        return sendRunnerRpcError(reply, error);
      }
    }
    const update = {
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      ...(parsed.data.directory === undefined
        ? {}
        : { directory: parsed.data.directory }),
      updatedAt: nowIso(),
    };
    const project = context.store.updateProject(params.id, update);
    if (!project) {
      return reply.code(404).send({ error: "project_not_found" });
    }
    context.hub.broadcast({ type: "project:updated", project });
    return { project };
  });

  app.post("/v1/projects/:id/archive", async (request, reply) => {
    const params = ProjectParamsSchema.parse(request.params);
    const project = context.store.archiveProject(params.id, nowIso());
    if (!project) {
      return reply.code(404).send({ error: "project_not_found" });
    }
    context.hub.broadcast({ type: "project:updated", project });
    return { project };
  });

  app.post("/v1/projects/:id/restore", async (request, reply) => {
    const params = ProjectParamsSchema.parse(request.params);
    const project = context.store.restoreProject(params.id, nowIso());
    if (!project) {
      return reply.code(404).send({ error: "project_not_found" });
    }
    context.hub.broadcast({ type: "project:updated", project });
    return { project };
  });
}

function registerWorkspaceRoutes(
  app: FastifyInstance,
  context: AppContext,
): void {
  app.get("/v1/sessions/:id/files", async (request, reply) => {
    const params = SessionParamsSchema.parse(request.params);
    const parsed = FileTreeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    try {
      const result = await context.services.workspace.readFileTree(
        params.id,
        parsed.data,
      );
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
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

    try {
      const result = await context.services.workspace.readFileContent(
        params.id,
        parsed.data,
      );
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
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

    try {
      const result = await context.services.workspace.writeFileContent(
        params.id,
        parsed.data,
      );
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
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

    try {
      const result = await context.services.workspace.applyPatch(
        params.id,
        parsed.data,
      );
      if (!result.ok) {
        if (result.error === "session_not_found") {
          return reply.code(404).send({ error: "session_not_found" });
        }
        if (result.error === "invalid_signature") {
          return reply.code(403).send({ error: "invalid_signature" });
        }
        return reply.code(400).send({ error: result.error });
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });
}

function registerGitRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/git/status", async (request, reply) => {
    const parsed = ApiGitContextSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.status(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/diff", async (request, reply) => {
    const parsed = ApiGitFileDiffQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.fileDiff(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/blame", async (request, reply) => {
    const parsed = ApiGitBlameQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.blame(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/history", async (request, reply) => {
    const parsed = ApiGitHistoryQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.history(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/branches", async (request, reply) => {
    const parsed = ApiGitContextSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.branches(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/stage", async (request, reply) => {
    const parsed = ApiGitPathsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.stage(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/init", async (request, reply) => {
    const parsed = ApiGitInitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.init(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/unstage", async (request, reply) => {
    const parsed = ApiGitPathsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.unstage(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/discard", async (request, reply) => {
    const parsed = ApiGitPathsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.discard(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/commit", async (request, reply) => {
    const parsed = ApiGitCommitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.commit(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/remote", async (request, reply) => {
    const parsed = ApiGitRemoteOperationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.remote(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.post("/v1/git/worktree/remove", async (request, reply) => {
    const parsed = ApiGitRemoveWorktreeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    try {
      const result = await context.services.git.removeWorktree(parsed.data);
      if (!result.ok) {
        return sendServiceError(reply, result);
      }
      return result.value;
    } catch (error) {
      return sendRunnerRpcError(reply, error);
    }
  });

  app.get("/v1/projects/:id/git/jobs", async (request, reply) => {
    const params = ProjectParamsSchema.parse(request.params);
    const result = context.services.git.jobs(params.id);
    if (!result.ok) {
      return sendServiceError(reply, result);
    }
    return result.value;
  });
}

function registerApprovalRoutes(
  app: FastifyInstance,
  context: AppContext,
): void {
  app.post("/v1/approvals/:id", async (request, reply) => {
    const params = ApprovalParamsSchema.parse(request.params);
    const parsed = ApiApprovalResponseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const result = context.services.approvals.respondToApproval(
      params.id,
      parsed.data,
    );
    if (!result.ok) {
      if (result.error === "approval_not_found") {
        return reply.code(404).send({ error: "approval_not_found" });
      }
      if (result.error === "invalid_signature") {
        return reply.code(403).send({ error: "invalid_signature" });
      }
      if (result.error === "approval_already_resolved") {
        return reply.code(409).send({ error: "approval_already_resolved" });
      }
      if (result.error === "runner_offline") {
        return reply.code(409).send({ error: "runner_offline" });
      }
      return reply.code(400).send({ error: result.error });
    }
    return result.value;
  });
}

function sendServiceError(
  reply: FastifyReply,
  result: Exclude<ServiceResult<unknown>, { ok: true }>,
) {
  if (
    result.error === "project_not_found" ||
    result.error === "session_not_found"
  ) {
    return reply.code(404).send({ error: result.error });
  }
  if (result.error === "worktree_not_available") {
    return reply.code(409).send({ error: result.error });
  }
  return reply.code(400).send({
    error: result.error,
    ...(result.message ? { message: result.message } : {}),
    ...(result.code ? { code: result.code } : {}),
  });
}

function registerArtifactRoutes(
  app: FastifyInstance,
  context: AppContext,
): void {
  app.post("/v1/artifacts", async (request, reply) => {
    const parsed = CreateArtifactRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const result = context.services.artifacts.createArtifact(parsed.data);
    if (!result.ok) {
      if (result.error === "session_not_found") {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return reply.code(400).send({ error: result.error });
    }
    return reply.code(201).send(result.value);
  });
}
