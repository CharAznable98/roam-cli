import type {
  ApiGitBlameQuery,
  ApiGitCommit,
  ApiGitContext,
  ApiGitFileDiffQuery,
  ApiGitHistoryQuery,
  ApiGitInit,
  ApiGitPaths,
  ApiGitRemoteOperation,
  ApiGitRemoveWorktree,
  GitBlame,
  GitBranchList,
  GitCommitPage,
  GitContextRef,
  GitFileDiff,
  GitJob,
  GitStatus,
  Session,
} from "@roamcli/shared/protocol";
import { nowIso } from "@roamcli/shared/protocol";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import { newId } from "../../infra/ids.js";
import {
  RunnerRpcClient,
  RunnerRpcError,
  type RunnerRpcCommand,
} from "../../infra/runner-rpc-client.js";
import type { ServerStore } from "../../infra/sqlite-store.js";
import { fail, ok, type ServiceResult } from "../result.js";

type GitResolvedContext = {
  projectId: string;
  runnerId: string;
  cwd: string;
  context: GitContextRef;
  session?: Session;
};

export class GitService {
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: ServerStore,
    private readonly hub: ConnectionHub,
    private readonly rpc: RunnerRpcClient,
    private readonly runnerRpcTimeoutMs: number,
  ) {}

  async status(
    context: ApiGitContext,
  ): Promise<ServiceResult<{ result: GitStatus }>> {
    const resolved = this.resolveContext(context);
    if (!resolved.ok) {
      return resolved;
    }
    const requestId = newId("git_status");
    const result = await this.rpc.requestRunner<GitStatus>(
      resolved.value.runnerId,
      {
        type: "gitStatus",
        requestId,
        projectId: resolved.value.projectId,
        context: resolved.value.context,
        cwd: resolved.value.cwd,
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result });
  }

  async fileDiff(
    query: ApiGitFileDiffQuery,
  ): Promise<ServiceResult<{ result: GitFileDiff }>> {
    const resolved = this.resolveContext(query.context);
    if (!resolved.ok) {
      return resolved;
    }
    const result = await this.rpc.requestRunner<GitFileDiff>(
      resolved.value.runnerId,
      {
        type: "gitFileDiff",
        requestId: newId("git_diff"),
        projectId: resolved.value.projectId,
        context: resolved.value.context,
        cwd: resolved.value.cwd,
        path: query.path,
        mode: query.mode,
        ...(query.oldRef === undefined ? {} : { oldRef: query.oldRef }),
        ...(query.newRef === undefined ? {} : { newRef: query.newRef }),
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result });
  }

  async blame(
    query: ApiGitBlameQuery,
  ): Promise<ServiceResult<{ result: GitBlame }>> {
    const resolved = this.resolveContext(query.context);
    if (!resolved.ok) {
      return resolved;
    }
    const result = await this.rpc.requestRunner<GitBlame>(
      resolved.value.runnerId,
      {
        type: "gitBlame",
        requestId: newId("git_blame"),
        projectId: resolved.value.projectId,
        context: resolved.value.context,
        cwd: resolved.value.cwd,
        path: query.path,
        ...(query.ref === undefined ? {} : { ref: query.ref }),
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result });
  }

  async history(
    query: ApiGitHistoryQuery,
  ): Promise<ServiceResult<{ result: GitCommitPage }>> {
    const resolved = this.resolveContext(query.context);
    if (!resolved.ok) {
      return resolved;
    }
    const result = await this.rpc.requestRunner<GitCommitPage>(
      resolved.value.runnerId,
      {
        type: "gitCommitPage",
        requestId: newId("git_history"),
        projectId: resolved.value.projectId,
        context: resolved.value.context,
        cwd: resolved.value.cwd,
        ...(query.ref === undefined ? {} : { ref: query.ref }),
        ...(query.path === undefined ? {} : { path: query.path }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit,
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result });
  }

  async branches(
    context: ApiGitContext,
  ): Promise<ServiceResult<{ result: GitBranchList }>> {
    const resolved = this.resolveContext(context);
    if (!resolved.ok) {
      return resolved;
    }
    const result = await this.rpc.requestRunner<GitBranchList>(
      resolved.value.runnerId,
      {
        type: "gitBranchList",
        requestId: newId("git_branches"),
        projectId: resolved.value.projectId,
        context: resolved.value.context,
        cwd: resolved.value.cwd,
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result });
  }

  async stage(body: ApiGitPaths): Promise<ServiceResult<{ job: GitJob }>> {
    return this.runGitJob(body.context, "stage", (resolved, requestId) => ({
      type: "gitStagePaths",
      requestId,
      projectId: resolved.projectId,
      context: resolved.context,
      cwd: resolved.cwd,
      paths: body.paths,
    }));
  }

  async init(body: ApiGitInit): Promise<ServiceResult<{ job: GitJob }>> {
    return this.runGitJob(body.context, "init", (resolved, requestId) => ({
      type: "gitInit",
      requestId,
      projectId: resolved.projectId,
      context: resolved.context,
      cwd: resolved.cwd,
    }));
  }

  async unstage(body: ApiGitPaths): Promise<ServiceResult<{ job: GitJob }>> {
    return this.runGitJob(body.context, "unstage", (resolved, requestId) => ({
      type: "gitUnstagePaths",
      requestId,
      projectId: resolved.projectId,
      context: resolved.context,
      cwd: resolved.cwd,
      paths: body.paths,
    }));
  }

  async discard(body: ApiGitPaths): Promise<ServiceResult<{ job: GitJob }>> {
    return this.runGitJob(body.context, "discard", (resolved, requestId) => ({
      type: "gitDiscardPaths",
      requestId,
      projectId: resolved.projectId,
      context: resolved.context,
      cwd: resolved.cwd,
      paths: body.paths,
    }));
  }

  async commit(body: ApiGitCommit): Promise<ServiceResult<{ job: GitJob }>> {
    return this.runGitJob(body.context, "commit", (resolved, requestId) => ({
      type: "gitCommit",
      requestId,
      projectId: resolved.projectId,
      context: resolved.context,
      cwd: resolved.cwd,
      message: body.message,
    }));
  }

  async remote(
    body: ApiGitRemoteOperation,
  ): Promise<ServiceResult<{ job: GitJob }>> {
    return this.runGitJob(
      body.context,
      body.operation,
      (resolved, requestId) => ({
        type: "gitRemoteOperation",
        requestId,
        projectId: resolved.projectId,
        context: resolved.context,
        cwd: resolved.cwd,
        operation: body.operation,
      }),
    );
  }

  async removeWorktree(
    body: ApiGitRemoveWorktree,
  ): Promise<ServiceResult<{ job: GitJob }>> {
    const result = await this.runGitJob(
      body.context,
      "remove_worktree",
      (resolved, requestId) => ({
        type: "gitRemoveWorktree",
        requestId,
        projectId: resolved.projectId,
        context: resolved.context,
        cwd: resolved.cwd,
      }),
    );
    if (result.ok && result.value.job.status === "succeeded") {
      const session = this.store.markSessionWorktreeDeleted(
        body.context.sessionId,
        nowIso(),
      );
      if (session) {
        this.hub.broadcast({ type: "session:updated", session });
      }
    }
    return result;
  }

  jobs(projectId: string): ServiceResult<{ jobs: GitJob[] }> {
    const project = this.store.getProject(projectId);
    if (!project || project.archivedAt) {
      return fail("project_not_found");
    }
    return ok({ jobs: this.store.listGitJobs(projectId) });
  }

  private async runGitJob<T extends RunnerRpcCommand>(
    context: GitContextRef,
    operation: string,
    buildCommand: (resolved: GitResolvedContext, requestId: string) => T,
  ): Promise<ServiceResult<{ job: GitJob }>> {
    const resolved = this.resolveContext(context);
    if (!resolved.ok) {
      return resolved;
    }
    return this.enqueueWrite(resolved.value, async () => {
      const requestId = newId(`git_${operation}`);
      const queuedJob = this.createQueuedJob(
        requestId,
        operation,
        resolved.value,
      );
      try {
        const job = await this.rpc.requestRunner<GitJob>(
          resolved.value.runnerId,
          buildCommand(resolved.value, requestId),
          this.runnerRpcTimeoutMs,
        );
        return ok({ job });
      } catch (error: unknown) {
        const failed = this.failQueuedJob(queuedJob, error);
        if (error instanceof RunnerRpcError) {
          throw error;
        }
        return ok({ job: failed });
      }
    });
  }

  private enqueueWrite<T>(
    resolved: GitResolvedContext,
    work: () => Promise<ServiceResult<T>>,
  ): Promise<ServiceResult<T>> {
    const key = contextQueueKey(resolved.context);
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    const cleanup = current.finally(() => {
      if (this.writeQueues.get(key) === cleanup) {
        this.writeQueues.delete(key);
      }
    });
    this.writeQueues.set(key, cleanup);
    return current;
  }

  private resolveContext(
    context: GitContextRef,
  ): ServiceResult<GitResolvedContext> {
    if (context.kind === "project") {
      const project = this.store.getProject(context.projectId);
      if (!project || project.archivedAt) {
        return fail("project_not_found");
      }
      return ok({
        projectId: project.id,
        runnerId: project.runnerId,
        cwd: project.directory,
        context,
      });
    }

    const session = this.store.getSession(context.sessionId);
    if (!session || session.archivedAt) {
      return fail("session_not_found");
    }
    if (
      session.executionMode !== "managed_worktree" ||
      session.worktreeDeletedAt
    ) {
      return fail("worktree_not_available");
    }
    const project = this.store.getProject(session.projectId);
    if (!project || project.archivedAt) {
      return fail("project_not_found");
    }
    return ok({
      projectId: project.id,
      runnerId: session.runnerId,
      cwd: session.executionFolder,
      context,
      session,
    });
  }

  private createQueuedJob(
    requestId: string,
    operation: string,
    resolved: GitResolvedContext,
  ): GitJob {
    const job: GitJob = {
      id: requestId,
      projectId: resolved.projectId,
      ...(resolved.context.kind === "session_worktree"
        ? { sessionId: resolved.context.sessionId }
        : {}),
      contextKind: resolved.context.kind,
      operation,
      status: "queued",
      createdAt: nowIso(),
    };
    this.store.upsertGitJob(job);
    this.hub.broadcast({ type: "git:job", job });
    return job;
  }

  private failQueuedJob(job: GitJob, error: unknown): GitJob {
    const failed: GitJob = {
      ...job,
      status: "failed",
      finishedAt: nowIso(),
      errorCode: error instanceof RunnerRpcError ? error.code : "git_error",
      errorSummary: error instanceof Error ? error.message : String(error),
    };
    this.store.upsertGitJob(failed);
    this.hub.broadcast({ type: "git:job", job: failed });
    return failed;
  }
}

function contextQueueKey(context: GitContextRef): string {
  return context.kind === "project"
    ? `project:${context.projectId}`
    : `session_worktree:${context.sessionId}`;
}
