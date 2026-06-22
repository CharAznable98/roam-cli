import type {
  AgentSkillListResult,
  AttachmentContentResult,
  AttachmentDeleteResult,
  AttachmentWriteResult,
  DirectoryCreateResult,
  FileContentResult,
  FileTreeResult,
  FileWriteResult,
  GitBlame,
  GitBranchList,
  GitCommitPage,
  GitFileDiff,
  GitJob,
  GitStatusResult,
  PatchApplyResult,
  PathSearchResult,
  RunnerCommand,
  SessionStatusCheckResult,
} from "@roamcli/shared/protocol";
import type { ConnectionHub } from "./connection-hub.js";

type RunnerRpcResult =
  | AgentSkillListResult
  | AttachmentWriteResult
  | AttachmentContentResult
  | AttachmentDeleteResult
  | DirectoryCreateResult
  | FileTreeResult
  | FileContentResult
  | FileWriteResult
  | PatchApplyResult
  | PathSearchResult
  | SessionStatusCheckResult
  | GitStatusResult
  | GitFileDiff
  | GitBlame
  | GitCommitPage
  | GitBranchList
  | GitJob;

export type RunnerRpcCommand = Extract<
  RunnerCommand,
  {
    type:
      | "readFileTree"
      | "readFileContent"
      | "writeFileContent"
      | "createDirectory"
      | "listAgentSkills"
      | "searchWorkspacePaths"
      | "checkSessionStatus"
      | "writeSessionAttachments"
      | "readSessionAttachment"
      | "deleteSessionAttachments"
      | "applyPatch"
      | "gitStatus"
      | "gitFileDiff"
      | "gitBlame"
      | "gitCommitPage"
      | "gitBranchList"
      | "gitInit"
      | "gitStagePaths"
      | "gitUnstagePaths"
      | "gitDiscardPaths"
      | "gitCommit"
      | "gitRemoteOperation"
      | "gitRemoveWorktree";
  }
>;

interface PendingRunnerRpc<T extends RunnerRpcResult = RunnerRpcResult> {
  runnerId: string;
  timer: NodeJS.Timeout;
  resolve: (result: T) => void;
  reject: (error: RunnerRpcError) => void;
}

export class RunnerRpcError extends Error {
  constructor(
    message: string,
    readonly code: "runner_offline" | "runner_timeout" | "runner_error",
    readonly runnerCode?: string,
  ) {
    super(message);
  }
}

export class RunnerRpcClient {
  private readonly pendingRunnerRpcs = new Map<string, PendingRunnerRpc>();

  constructor(private readonly hub: ConnectionHub) {}

  requestRunner<T extends RunnerRpcResult>(
    runnerId: string,
    command: RunnerRpcCommand,
    timeoutMs: number,
  ): Promise<T> {
    if (!this.hub.isRunnerOnline(runnerId)) {
      return Promise.reject(
        new RunnerRpcError("runner is offline", "runner_offline"),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRunnerRpcs.delete(command.requestId);
        reject(
          new RunnerRpcError("runner request timed out", "runner_timeout"),
        );
      }, timeoutMs);

      this.pendingRunnerRpcs.set(command.requestId, {
        runnerId,
        timer,
        resolve: resolve as (result: RunnerRpcResult) => void,
        reject,
      });

      try {
        if (!this.hub.sendToRunner(runnerId, command)) {
          throw new RunnerRpcError("runner is offline", "runner_offline");
        }
      } catch (error) {
        clearTimeout(timer);
        this.pendingRunnerRpcs.delete(command.requestId);
        reject(
          error instanceof RunnerRpcError
            ? error
            : new RunnerRpcError("runner is offline", "runner_offline"),
        );
      }
    });
  }

  resolveRunnerResponse(result: RunnerRpcResult): boolean {
    const requestId = "requestId" in result ? result.requestId : result.id;
    const pending = this.pendingRunnerRpcs.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingRunnerRpcs.delete(requestId);
    pending.resolve(result);
    return true;
  }

  rejectRunnerResponse(requestId: string, error: RunnerRpcError): boolean {
    const pending = this.pendingRunnerRpcs.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingRunnerRpcs.delete(requestId);
    pending.reject(error);
    return true;
  }

  rejectPendingForRunner(runnerId: string, error: RunnerRpcError): void {
    for (const [requestId, pending] of this.pendingRunnerRpcs) {
      if (pending.runnerId === runnerId) {
        clearTimeout(pending.timer);
        this.pendingRunnerRpcs.delete(requestId);
        pending.reject(error);
      }
    }
  }
}
