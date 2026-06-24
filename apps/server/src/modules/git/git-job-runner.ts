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

  enqueue(context: GitContextRef, work: () => Promise<void>): void {
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
  }
}

type PendingGitJob = {
  runnerId: string;
  job: GitJob;
  resolve?: () => void;
};

export class GitJobRunner {
  private readonly pendingJobs = new Map<string, PendingGitJob>();

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
    const requestId = newId(`git_${operation}`);
    const queuedJob = this.createQueuedJob(requestId, operation, resolved);
    if (!this.hub.isRunnerOnline(resolved.runnerId)) {
      return ok({
        job: this.failJob(
          queuedJob,
          new RunnerRpcError("runner is offline", "runner_offline"),
        ),
      });
    }

    this.pendingJobs.set(queuedJob.id, {
      runnerId: resolved.runnerId,
      job: queuedJob,
    });
    this.queue.enqueue(resolved.context, () =>
      this.dispatchQueuedJob(queuedJob.id, resolved, buildCommand),
    );
    return ok({ job: queuedJob });
  }

  handleRunnerJobResult(job: GitJob): boolean {
    const pending = this.pendingJobs.get(job.id);
    if (!pending) {
      return false;
    }
    this.pendingJobs.delete(job.id);
    pending.resolve?.();
    return true;
  }

  normalizeRunnerJobResult(job: GitJob): GitJob {
    const pending = this.pendingJobs.get(job.id);
    if (!pending) {
      return job;
    }
    return {
      ...job,
      operation: pending.job.operation,
      contextKind: pending.job.contextKind,
      ...(pending.job.sessionId ? { sessionId: pending.job.sessionId } : {}),
    };
  }

  hasActiveWorktreeRemovalJob(sessionId: string): boolean {
    for (const pending of this.pendingJobs.values()) {
      if (
        pending.job.sessionId === sessionId &&
        isWorktreeRemovalOperation(pending.job.operation) &&
        (pending.job.status === "queued" || pending.job.status === "running")
      ) {
        return true;
      }
    }
    return false;
  }

  failPendingForRunner(runnerId: string, error: RunnerRpcError): void {
    for (const [jobId, pending] of this.pendingJobs) {
      if (pending.runnerId === runnerId) {
        this.pendingJobs.delete(jobId);
        this.failJob(pending.job, error);
        pending.resolve?.();
      }
    }
  }

  private async dispatchQueuedJob<T extends RunnerRpcCommand>(
    jobId: string,
    resolved: GitResolvedContext,
    buildCommand: (resolved: GitResolvedContext, requestId: string) => T,
  ): Promise<void> {
    const pending = this.pendingJobs.get(jobId);
    if (!pending) {
      return;
    }
    if (!this.hub.isRunnerOnline(resolved.runnerId)) {
      this.pendingJobs.delete(jobId);
      this.failJob(
        pending.job,
        new RunnerRpcError("runner is offline", "runner_offline"),
      );
      return;
    }

    const running = this.markJobRunning(pending.job);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        const latest = this.pendingJobs.get(jobId);
        if (latest) {
          this.pendingJobs.delete(jobId);
          try {
            this.failJob(
              latest.job,
              new RunnerRpcError("runner request timed out", "runner_timeout"),
            );
          } catch {
            // The server may be shutting down while a queued runner job is still pending.
          }
        }
        finish();
      }, this.runnerRpcTimeoutMs);
      this.pendingJobs.set(jobId, {
        ...pending,
        job: running,
        resolve: finish,
      });
      try {
        if (
          !this.hub.sendToRunner(
            resolved.runnerId,
            buildCommand(resolved, jobId),
          )
        ) {
          throw new RunnerRpcError("runner is offline", "runner_offline");
        }
      } catch (error: unknown) {
        const latest = this.pendingJobs.get(jobId);
        this.pendingJobs.delete(jobId);
        this.failJob(
          latest?.job ?? running,
          error instanceof RunnerRpcError
            ? error
            : new RunnerRpcError("runner is offline", "runner_offline"),
        );
        finish();
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

  private markJobRunning(job: GitJob): GitJob {
    const running: GitJob = {
      ...job,
      status: "running",
      startedAt: nowIso(),
    };
    this.store.upsertGitJob(running);
    this.hub.broadcast({ type: "git:job", job: running });
    return running;
  }

  private failJob(job: GitJob, error: unknown): GitJob {
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

function isWorktreeRemovalOperation(operation: string): boolean {
  return (
    operation === "remove_worktree" || operation === "archive_remove_worktree"
  );
}
