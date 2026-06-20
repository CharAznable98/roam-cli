import type { GitJob, RunnerCommand } from "@roamcli/shared/protocol";
import { applyUnifiedDiff } from "../workspace/patch.js";
import {
  readFileContent,
  readFileTree,
  searchWorkspacePaths,
  writeFileContent,
} from "../workspace/files.js";
import {
  commitGitChanges,
  discardGitPaths,
  initGitRepository,
  readGitBlame,
  readGitBranches,
  readGitCommitPage,
  readGitFileDiff,
  readGitStatus,
  removeGitWorktree,
  runGitRemoteOperation,
  stageGitPaths,
  unstageGitPaths,
} from "../workspace/git.js";
import type { RunnerEventSink } from "./types.js";

type GitMutationCommand = Extract<
  RunnerCommand,
  {
    type:
      | "gitInit"
      | "gitStagePaths"
      | "gitUnstagePaths"
      | "gitDiscardPaths"
      | "gitCommit"
      | "gitRemoteOperation"
      | "gitRemoveWorktree";
  }
>;

export interface WorkspaceCommandHandlerOptions {
  workspace: string;
  emit: RunnerEventSink;
  getSessionCwd(sessionId: string, cwd: string | undefined): string | undefined;
  getStartedSessionCwd(sessionId: string): string | undefined;
  verifyPatchSignature(
    command: Extract<RunnerCommand, { type: "applyPatch" }>,
  ): string | undefined;
}

export class WorkspaceCommandHandler {
  readonly #workspace: string;
  readonly #emit: RunnerEventSink;
  readonly #getSessionCwd: WorkspaceCommandHandlerOptions["getSessionCwd"];
  readonly #getStartedSessionCwd: WorkspaceCommandHandlerOptions["getStartedSessionCwd"];
  readonly #verifyPatchSignature: WorkspaceCommandHandlerOptions["verifyPatchSignature"];

  public constructor(options: WorkspaceCommandHandlerOptions) {
    this.#workspace = options.workspace;
    this.#emit = options.emit;
    this.#getSessionCwd = options.getSessionCwd;
    this.#getStartedSessionCwd = options.getStartedSessionCwd;
    this.#verifyPatchSignature = options.verifyPatchSignature;
  }

  public async readFileTree(
    command: Extract<RunnerCommand, { type: "readFileTree" }>,
  ): Promise<void> {
    const sessionCwd = await this.#resolveFileCommandCwd(
      command.requestId,
      command.sessionId,
      command.cwd,
    );
    if (sessionCwd === undefined) {
      return;
    }
    try {
      const result = await readFileTree({
        workspace: this.#workspace,
        sessionCwd,
        requestId: command.requestId,
        sessionId: command.sessionId,
        ...(command.path === undefined ? {} : { path: command.path }),
        ...(command.depth === undefined ? {} : { depth: command.depth }),
      });
      await this.#emit({ type: "fileTreeResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        requestId: command.requestId,
        sessionId: command.sessionId,
        message,
        code: "FILE_TREE_ERROR",
      });
    }
  }

  public async readFileContent(
    command: Extract<RunnerCommand, { type: "readFileContent" }>,
  ): Promise<void> {
    const sessionCwd = await this.#resolveFileCommandCwd(
      command.requestId,
      command.sessionId,
      command.cwd,
    );
    if (sessionCwd === undefined) {
      return;
    }
    try {
      const result = await readFileContent({
        workspace: this.#workspace,
        sessionCwd,
        requestId: command.requestId,
        sessionId: command.sessionId,
        path: command.path,
        ...(command.maxBytes === undefined
          ? {}
          : { maxBytes: command.maxBytes }),
      });
      await this.#emit({ type: "fileContentResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        requestId: command.requestId,
        sessionId: command.sessionId,
        message,
        code: "FILE_CONTENT_ERROR",
      });
    }
  }

  public async writeFileContent(
    command: Extract<RunnerCommand, { type: "writeFileContent" }>,
  ): Promise<void> {
    const sessionCwd = await this.#resolveFileCommandCwd(
      command.requestId,
      command.sessionId,
      command.cwd,
    );
    if (sessionCwd === undefined) {
      return;
    }
    try {
      const result = await writeFileContent({
        workspace: this.#workspace,
        sessionCwd,
        requestId: command.requestId,
        sessionId: command.sessionId,
        path: command.path,
        content: command.content,
      });
      await this.#emit({ type: "fileWriteResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        requestId: command.requestId,
        sessionId: command.sessionId,
        message,
        code: "FILE_WRITE_ERROR",
      });
    }
  }

  public async searchWorkspacePaths(
    command: Extract<RunnerCommand, { type: "searchWorkspacePaths" }>,
  ): Promise<void> {
    try {
      const result = await searchWorkspacePaths({
        workspace: this.#workspace,
        requestId: command.requestId,
        basePath: command.basePath,
        query: command.query,
        limit: command.limit,
      });
      await this.#emit({ type: "pathSearchResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        requestId: command.requestId,
        message,
        code: "PATH_SEARCH_ERROR",
      });
    }
  }

  public async applyPatch(
    command: Extract<RunnerCommand, { type: "applyPatch" }>,
  ): Promise<void> {
    const signatureError = this.#verifyPatchSignature(command);
    if (signatureError !== undefined) {
      await this.#emitPatchResult(command, signatureError);
      return;
    }

    const sessionCwd = this.#getStartedSessionCwd(command.sessionId);
    if (sessionCwd === undefined) {
      await this.#emitPatchResult(command, "Session cwd is unavailable");
      return;
    }

    const result = await applyUnifiedDiff({
      workspace: this.#workspace,
      sessionCwd,
      requestId: command.requestId,
      sessionId: command.sessionId,
      patch: command.patch,
      ...(command.strip === undefined ? {} : { strip: command.strip }),
    });
    await this.#emit({ type: "patchApplyResult", result });
  }

  public async readGitStatus(
    command: Extract<RunnerCommand, { type: "gitStatus" }>,
  ): Promise<void> {
    await this.#runGitRead(command, "GIT_STATUS_ERROR", async () => {
      const result = await readGitStatus({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
      });
      await this.#emit({ type: "gitStatusResult", result });
    });
  }

  public async readGitFileDiff(
    command: Extract<RunnerCommand, { type: "gitFileDiff" }>,
  ): Promise<void> {
    await this.#runGitRead(command, "GIT_DIFF_ERROR", async () => {
      const result = await readGitFileDiff({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        path: command.path,
        mode: command.mode ?? "working_tree",
        ...(command.oldRef === undefined ? {} : { oldRef: command.oldRef }),
        ...(command.newRef === undefined ? {} : { newRef: command.newRef }),
      });
      await this.#emit({ type: "gitFileDiffResult", result });
    });
  }

  public async readGitBlame(
    command: Extract<RunnerCommand, { type: "gitBlame" }>,
  ): Promise<void> {
    await this.#runGitRead(command, "GIT_BLAME_ERROR", async () => {
      const result = await readGitBlame({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        path: command.path,
        ...(command.ref === undefined ? {} : { ref: command.ref }),
      });
      await this.#emit({ type: "gitBlameResult", result });
    });
  }

  public async readGitCommitPage(
    command: Extract<RunnerCommand, { type: "gitCommitPage" }>,
  ): Promise<void> {
    await this.#runGitRead(command, "GIT_HISTORY_ERROR", async () => {
      const result = await readGitCommitPage({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        ...(command.ref === undefined ? {} : { ref: command.ref }),
        ...(command.path === undefined ? {} : { path: command.path }),
        ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
        limit: command.limit ?? 50,
      });
      await this.#emit({ type: "gitCommitPageResult", result });
    });
  }

  public async readGitBranches(
    command: Extract<RunnerCommand, { type: "gitBranchList" }>,
  ): Promise<void> {
    await this.#runGitRead(command, "GIT_BRANCH_ERROR", async () => {
      const result = await readGitBranches({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
      });
      await this.#emit({ type: "gitBranchListResult", result });
    });
  }

  public async initGitRepository(
    command: Extract<RunnerCommand, { type: "gitInit" }>,
  ): Promise<void> {
    await this.#runGitMutation(command, "init", () =>
      initGitRepository({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        operation: "init",
      }),
    );
  }

  public async stageGitPaths(
    command: Extract<RunnerCommand, { type: "gitStagePaths" }>,
  ): Promise<void> {
    await this.#runGitMutation(command, "stage", () =>
      stageGitPaths({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        operation: "stage",
        paths: command.paths,
      }),
    );
  }

  public async unstageGitPaths(
    command: Extract<RunnerCommand, { type: "gitUnstagePaths" }>,
  ): Promise<void> {
    await this.#runGitMutation(command, "unstage", () =>
      unstageGitPaths({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        operation: "unstage",
        paths: command.paths,
      }),
    );
  }

  public async discardGitPaths(
    command: Extract<RunnerCommand, { type: "gitDiscardPaths" }>,
  ): Promise<void> {
    await this.#runGitMutation(command, "discard", () =>
      discardGitPaths({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        operation: "discard",
        paths: command.paths,
      }),
    );
  }

  public async commitGitChanges(
    command: Extract<RunnerCommand, { type: "gitCommit" }>,
  ): Promise<void> {
    await this.#runGitMutation(command, "commit", () =>
      commitGitChanges({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        operation: "commit",
        message: command.message,
      }),
    );
  }

  public async runGitRemoteOperation(
    command: Extract<RunnerCommand, { type: "gitRemoteOperation" }>,
  ): Promise<void> {
    await this.#runGitMutation(command, command.operation, () =>
      runGitRemoteOperation({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        operation: command.operation,
        remoteOperation: command.operation,
      }),
    );
  }

  public async removeGitWorktree(
    command: Extract<RunnerCommand, { type: "gitRemoveWorktree" }>,
  ): Promise<void> {
    await this.#runGitMutation(command, "remove_worktree", () =>
      removeGitWorktree({
        workspace: this.#workspace,
        cwd: command.cwd,
        requestId: command.requestId,
        projectId: command.projectId,
        context: command.context,
        operation: "remove_worktree",
      }),
    );
  }

  async #resolveFileCommandCwd(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
  ): Promise<string | undefined> {
    try {
      const sessionCwd = this.#getSessionCwd(sessionId, cwd);
      if (sessionCwd === undefined) {
        await this.#emitSessionCwdUnavailable(requestId, sessionId);
      }
      return sessionCwd;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        requestId,
        sessionId,
        message,
        code: "INVALID_CWD",
      });
      return undefined;
    }
  }

  async #emitSessionCwdUnavailable(
    requestId: string,
    sessionId: string,
  ): Promise<void> {
    await this.#emit({
      type: "error",
      requestId,
      sessionId,
      message: "Session cwd is unavailable",
      code: "SESSION_NOT_FOUND",
    });
  }

  async #runGitRead(
    command: Extract<RunnerCommand, { requestId: string }>,
    code: string,
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        requestId: command.requestId,
        message,
        code,
      });
    }
  }

  async #runGitMutation(
    command: GitMutationCommand,
    operation: string,
    run: () => Promise<GitJob>,
  ): Promise<void> {
    try {
      const job = await run();
      await this.#emit({ type: "gitJobResult", job });
    } catch (error: unknown) {
      await this.#emit({
        type: "gitJobResult",
        job: failedGitJob(command, operation, error),
      });
    }
  }

  async #emitPatchResult(
    command: Extract<RunnerCommand, { type: "applyPatch" }>,
    message: string,
  ): Promise<void> {
    await this.#emit({
      type: "patchApplyResult",
      result: {
        requestId: command.requestId,
        sessionId: command.sessionId,
        applied: false,
        changedFiles: [],
        message,
        rejected: [message],
      },
    });
  }
}

function failedGitJob(
  command: GitMutationCommand,
  operation: string,
  error: unknown,
): GitJob {
  const timestamp = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: command.requestId,
    projectId: command.projectId,
    ...(command.context.kind === "session_worktree"
      ? { sessionId: command.context.sessionId }
      : {}),
    contextKind: command.context.kind,
    operation,
    status: "failed",
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    errorCode: "GIT_OPERATION_ERROR",
    errorSummary: message,
  };
}
