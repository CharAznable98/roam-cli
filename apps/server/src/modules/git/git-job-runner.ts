import type { GitContextRef, GitJob, Session } from "@roamcli/shared/protocol";
import { nowIso } from "@roamcli/shared/protocol";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import {
  RunnerRpcError,
  type RunnerRpcClient,
  type RunnerRpcCommand,
} from "../../infra/runner-rpc-client.js";
import { newId } from "../../infra/ids.js";
import type { ServerStore } from "../../infra/sqlite-store.js";
import { ok, type ServiceResult } from "../result.js";

export type GitResolvedContext = {
  projectId: string;
  runnerId: string;
  cwd: string;
  context: GitContextRef;
  session?: Session;
};

export class GitMutationQueue {
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  enqueue<T>(context: GitContextRef, work: () => Promise<T>): Promise<T> {
    const key = contextQueueKey(context);
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    let tracked: Promise<void>;
    tracked = current
      .catch(() => undefined)
      .then(() => {
        if (this.writeQueues.get(key) === tracked) {
          this.writeQueues.delete(key);
        }
      });
    this.writeQueues.set(key, tracked);
    return current;
  }
}

export class GitJobRunner {
  constructor(
    private readonly store: ServerStore,
    private readonly hub: ConnectionHub,
    private readonly rpc: RunnerRpcClient,
    private readonly runnerRpcTimeoutMs: number,
    private readonly queue = new GitMutationQueue(),
  ) {}

  async run<T extends RunnerRpcCommand>(
    resolved: GitResolvedContext,
    operation: string,
    buildCommand: (resolved: GitResolvedContext, requestId: string) => T,
  ): Promise<ServiceResult<{ job: GitJob }>> {
    return this.queue.enqueue(resolved.context, async () => {
      const requestId = newId(`git_${operation}`);
      const queuedJob = this.createQueuedJob(requestId, operation, resolved);
      try {
        const job = await this.rpc.requestRunner<GitJob>(
          resolved.runnerId,
          buildCommand(resolved, requestId),
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
