import type { FastifyInstance } from "fastify";
import {
  ApiApplyPatchSchema,
  ApiApprovalResponseSchema,
  ApiCreateProjectSchema,
  ApiCreateSessionSchema,
  ApiUpdateProjectSchema,
  ApiWriteFileSchema,
  nowIso,
} from "@roamcli/shared/protocol";
import { newId } from "../infra/ids.js";
import { CreateArtifactRequestSchema } from "../infra/local-artifact-storage.js";
import type { AppContext } from "../server/context.js";
import { sendRunnerRpcError } from "./errors.js";
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

function registerProjectRoutes(app: FastifyInstance, context: AppContext): void {
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
    const duplicateProject = context.store.listProjects().find(
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
      ...(parsed.data.directory === undefined ? {} : { directory: parsed.data.directory }),
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
        return reply.code(404).send({ error: "session_not_found" });
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
        return reply.code(404).send({ error: "session_not_found" });
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
        return reply.code(404).send({ error: "session_not_found" });
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
