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

export const DEFAULT_GIT_JOB_TIMEOUT_MS = 30_000;
const GIT_JOB_RESULT_UNKNOWN = "runner_result_unknown";
const LATE_GIT_JOB_RESULT_RETENTION_MS = 5 * 60_000;

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
  job: GitJob;
  resolve?: () => void;
};

export class GitJobRunner {
  private readonly pendingJobs = new Map<string, PendingGitJob>();
  private readonly orphanExpiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: ServerStore,
    private readonly hub: ConnectionHub,
    private readonly rpc: RunnerRpcClient,
    private readonly gitJobTimeoutMs = DEFAULT_GIT_JOB_TIMEOUT_MS,
    private readonly queue = new GitMutationQueue(),
  ) {
    this.rehydratePersistedJobs();
  }

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
      job: queuedJob,
    });
    this.queue.enqueue(resolved.context, () =>
      this.dispatchQueuedJob(queuedJob.id, resolved, buildCommand),
    );
    return ok({ job: queuedJob });
  }

  canAcceptRunnerJobResult(job: GitJob): boolean {
    const stored = this.store.getGitJob(job.id);
    return (
      stored !== undefined &&
      (isActiveGitJob(stored) || canAcceptLateRunnerJobResult(stored))
    );
  }

  completeRunnerJobResult(job: GitJob): void {
    const orphanTimer = this.orphanExpiryTimers.get(job.id);
    if (orphanTimer) {
      clearTimeout(orphanTimer);
      this.orphanExpiryTimers.delete(job.id);
    }
    const pending = this.pendingJobs.get(job.id);
    this.pendingJobs.delete(job.id);
    pending?.resolve?.();
  }

  normalizeRunnerJobResult(job: GitJob): GitJob {
    const pending = this.pendingJobs.get(job.id);
    const authoritative = pending?.job ?? this.store.getGitJob(job.id);
    if (!authoritative) {
      return job;
    }
    const startedAt = authoritative.startedAt ?? job.startedAt;
    return {
      id: authoritative.id,
      projectId: authoritative.projectId,
      operation: authoritative.operation,
      contextKind: authoritative.contextKind,
      status: job.status,
      createdAt: authoritative.createdAt,
      ...(startedAt ? { startedAt } : {}),
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
      ...(job.errorSummary !== undefined
        ? { errorSummary: job.errorSummary }
        : {}),
      ...(authoritative.sessionId
        ? { sessionId: authoritative.sessionId }
        : {}),
    };
  }

  hasActiveWorktreeRemovalJob(sessionId: string): boolean {
    if (this.store.hasActiveWorktreeRemovalJob(sessionId)) {
      return true;
    }
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
      }, this.gitJobTimeoutMs);
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

  private rehydratePersistedJobs(): void {
    const now = Date.now();
    for (const job of this.store.listActiveGitJobs()) {
      const deadline = persistedJobDeadline(job, this.gitJobTimeoutMs);
      if (deadline <= now) {
        this.expireOrphanedJob(job.id);
        continue;
      }
      const timer = setTimeout(
        () => this.expireOrphanedJob(job.id),
        deadline - now,
      );
      timer.unref();
      this.orphanExpiryTimers.set(job.id, timer);
    }
  }

  private expireOrphanedJob(jobId: string): void {
    this.orphanExpiryTimers.delete(jobId);
    try {
      const job = this.store.getGitJob(jobId);
      if (!job || !isActiveGitJob(job)) {
        return;
      }
      const failed: GitJob = {
        ...job,
        status: "failed",
        finishedAt: nowIso(),
        errorCode: GIT_JOB_RESULT_UNKNOWN,
        errorSummary:
          "The server restarted before the runner result was confirmed; the Git operation outcome is unknown.",
      };
      this.store.upsertGitJob(failed);
      this.hub.broadcast({ type: "git:job", job: failed });
    } catch {
      // The store may already be closed during server shutdown.
    }
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

function isActiveGitJob(job: GitJob): boolean {
  return job.status === "queued" || job.status === "running";
}

function canAcceptLateRunnerJobResult(job: GitJob): boolean {
  if (
    job.status !== "failed" ||
    (job.errorCode !== GIT_JOB_RESULT_UNKNOWN &&
      job.errorCode !== "runner_timeout") ||
    !job.finishedAt
  ) {
    return false;
  }
  const finishedAt = Date.parse(job.finishedAt);
  return (
    Number.isFinite(finishedAt) &&
    Date.now() - finishedAt <= LATE_GIT_JOB_RESULT_RETENTION_MS
  );
}

function persistedJobDeadline(job: GitJob, timeoutMs: number): number {
  const timestamp = Date.parse(job.startedAt ?? job.createdAt);
  return (Number.isFinite(timestamp) ? timestamp : 0) + timeoutMs;
}
