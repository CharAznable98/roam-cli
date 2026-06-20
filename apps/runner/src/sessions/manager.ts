import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentKind,
  RunnerAttachmentRef,
  RunnerCommand,
  RunnerProfile,
  Session,
} from "@roamcli/shared/protocol";
import { spawnAgentProcess, type AgentProcess } from "../agents/process.js";
import type { LoadedAgent } from "../agents/registry.js";
import { ApprovalTracker } from "../approvals/tracker.js";
import { resolveWorkspaceChild } from "../workspace/scope.js";
import { SessionAttachmentStore } from "./attachments.js";
import { SessionOutputHandler } from "./output.js";
import type { RunnerEventSink, RunningSession } from "./types.js";
import { WorkspaceCommandHandler } from "./workspace-commands.js";

const execFileAsync = promisify(execFile);

export interface SessionManagerOptions {
  workspace: string;
  stateDir?: string;
  profile: RunnerProfile;
  agents: readonly LoadedAgent[];
  approvalSecret?: string;
  emit: RunnerEventSink;
}

export class SessionManager {
  readonly #workspace: string;
  readonly #attachments: SessionAttachmentStore;
  readonly #profile: RunnerProfile;
  readonly #agents: Map<AgentKind, LoadedAgent>;
  readonly #emit: RunnerEventSink;
  readonly #approvals: ApprovalTracker;
  readonly #output: SessionOutputHandler;
  readonly #workspaceCommands: WorkspaceCommandHandler;
  readonly #sessions = new Map<string, RunningSession>();
  readonly #startingSessionIds = new Set<string>();
  readonly #sessionCwds = new Map<string, string>();

  public constructor(options: SessionManagerOptions) {
    this.#workspace = options.workspace;
    this.#attachments = new SessionAttachmentStore(
      options.stateDir ?? join(this.#workspace, ".roam-runner"),
    );
    this.#profile = options.profile;
    this.#agents = new Map(
      options.agents.map((agent) => [agent.capability.kind, agent]),
    );
    this.#emit = options.emit;
    this.#approvals = new ApprovalTracker({
      emit: this.#emit,
      ...(options.approvalSecret === undefined
        ? {}
        : { approvalSecret: options.approvalSecret }),
    });
    this.#output = new SessionOutputHandler({
      approvals: this.#approvals,
      emit: this.#emit,
    });
    this.#workspaceCommands = new WorkspaceCommandHandler({
      workspace: this.#workspace,
      emit: this.#emit,
      getSessionCwd: (sessionId, cwd) => this.#getSessionCwd(sessionId, cwd),
      getStartedSessionCwd: (sessionId) => this.#sessionCwds.get(sessionId),
      verifyPatchSignature: (command) =>
        this.#approvals.verifyPatchSignature(command),
    });
  }

  public async handle(command: RunnerCommand): Promise<void> {
    switch (command.type) {
      case "startSession":
        await this.start(
          command.session,
          command.prompt,
          command.resumeThreadId,
          command.attachments,
        );
        return;
      case "deliverInput":
        this.deliverInput(command.sessionId, command.content);
        return;
      case "checkSessionStatus":
        await this.#emit({
          type: "sessionStatusCheckResult",
          result: {
            requestId: command.requestId,
            sessionId: command.sessionId,
            active:
              this.#sessions.has(command.sessionId) ||
              this.#startingSessionIds.has(command.sessionId),
          },
        });
        return;
      case "listAgentSkills":
        await this.#listAgentSkills(command);
        return;
      case "searchWorkspacePaths":
        await this.#workspaceCommands.searchWorkspacePaths(command);
        return;
      case "writeSessionAttachments":
        try {
          await this.#emit({
            type: "attachmentWriteResult",
            result: await this.#attachments.writeSessionAttachments(
              command.requestId,
              command.sessionId,
              command.attachments,
            ),
          });
        } catch (error: unknown) {
          await this.#emitCommandError(
            command.requestId,
            command.sessionId,
            error,
          );
        }
        return;
      case "readSessionAttachment":
        try {
          await this.#emit({
            type: "attachmentContentResult",
            result: await this.#attachments.readSessionAttachment(
              command.requestId,
              command.sessionId,
              command.attachmentId,
              command.runnerStoragePath,
              command.maxBytes,
            ),
          });
        } catch (error: unknown) {
          await this.#emitCommandError(
            command.requestId,
            command.sessionId,
            error,
          );
        }
        return;
      case "deleteSessionAttachments":
        try {
          await this.#emit({
            type: "attachmentDeleteResult",
            result: await this.#attachments.deleteSessionAttachments(
              command.requestId,
              command.sessionId,
              command.attachments,
            ),
          });
        } catch (error: unknown) {
          await this.#emitCommandError(
            command.requestId,
            command.sessionId,
            error,
          );
        }
        return;
      case "readFileTree":
        await this.#workspaceCommands.readFileTree(command);
        return;
      case "readFileContent":
        await this.#workspaceCommands.readFileContent(command);
        return;
      case "writeFileContent":
        await this.#workspaceCommands.writeFileContent(command);
        return;
      case "applyPatch":
        await this.#workspaceCommands.applyPatch(command);
        return;
      case "gitStatus":
        await this.#workspaceCommands.readGitStatus(command);
        return;
      case "gitFileDiff":
        await this.#workspaceCommands.readGitFileDiff(command);
        return;
      case "gitBlame":
        await this.#workspaceCommands.readGitBlame(command);
        return;
      case "gitCommitPage":
        await this.#workspaceCommands.readGitCommitPage(command);
        return;
      case "gitBranchList":
        await this.#workspaceCommands.readGitBranches(command);
        return;
      case "gitInit":
        await this.#workspaceCommands.initGitRepository(command);
        return;
      case "gitStagePaths":
        await this.#workspaceCommands.stageGitPaths(command);
        return;
      case "gitUnstagePaths":
        await this.#workspaceCommands.unstageGitPaths(command);
        return;
      case "gitDiscardPaths":
        await this.#workspaceCommands.discardGitPaths(command);
        return;
      case "gitCommit":
        await this.#workspaceCommands.commitGitChanges(command);
        return;
      case "gitRemoteOperation":
        await this.#workspaceCommands.runGitRemoteOperation(command);
        return;
      case "gitRemoveWorktree":
        await this.#workspaceCommands.removeGitWorktree(command);
        return;
      case "resolveApproval":
        this.resolveApproval(
          command.approvalId,
          command.approved,
          command.signedAt,
          command.signature,
        );
        return;
      case "controlSignal":
        this.control(command.sessionId, command.signal);
        return;
    }
  }

  public async start(
    session: Session,
    prompt: string,
    resumeThreadId?: string,
    attachments: readonly RunnerAttachmentRef[] = [],
  ): Promise<void> {
    if (
      this.#sessions.has(session.id) ||
      this.#startingSessionIds.has(session.id)
    ) {
      await this.#emit({
        type: "error",
        sessionId: session.id,
        message: "Session is already running",
        code: "SESSION_EXISTS",
      });
      return;
    }

    const agent = this.#agents.get(session.agent);
    if (agent === undefined) {
      await this.#emit({
        type: "error",
        sessionId: session.id,
        message: `Unsupported agent: ${session.agent}`,
        code: "UNSUPPORTED_AGENT",
      });
      return;
    }

    this.#startingSessionIds.add(session.id);
    let cwd: string;
    try {
      cwd = await this.#prepareExecutionFolder(session);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        sessionId: session.id,
        message,
        code: "INVALID_CWD",
      });
      this.#startingSessionIds.delete(session.id);
      return;
    }

    let child: AgentProcess;
    try {
      const launch = agent.definition.buildLaunch({
        profile: this.#profile,
        env: process.env,
        prompt,
        attachments: attachments.map((attachment) => ({
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          localPath: this.#attachments.localPathFor(
            attachment.runnerStoragePath,
          ),
        })),
        ...(resumeThreadId ? { resumeThreadId } : {}),
      });
      child = await spawnAgentProcess(launch.command, launch.args, {
        cwd,
        env: process.env,
        preferPty: launch.preferPty,
        requirePty: launch.requirePty,
      });
      const running: RunningSession = {
        session: { ...session, cwd },
        child,
        parser: agent.definition.createParser(),
        stopRequested: false,
        outputTasks: new Set(),
      };
      this.#sessions.set(session.id, running);
      this.#sessionCwds.set(session.id, cwd);

      child.onData((chunk) => this.#trackOutput(running, chunk));
      child.onError((error) => {
        void this.#emit({
          type: "error",
          sessionId: session.id,
          message: error.message,
          code: "SPAWN_ERROR",
        });
      });
      child.onExit(({ code, signal }) => {
        void this.#finishSession(running, code, signal);
      });

      await this.#emit({
        type: "sessionStatus",
        sessionId: session.id,
        status: "running",
      });
      if (launch.promptDelivery === "stdin") {
        child.write(prompt);
        if (!prompt.endsWith("\n")) {
          child.write("\n");
        }
      } else {
        child.endInput();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        sessionId: session.id,
        message,
        code: "SPAWN_ERROR",
      });
      await this.#emit({
        type: "sessionStatus",
        sessionId: session.id,
        status: "failed",
      });
      return;
    } finally {
      this.#startingSessionIds.delete(session.id);
    }
  }

  async #listAgentSkills(
    command: Extract<RunnerCommand, { type: "listAgentSkills" }>,
  ): Promise<void> {
    const agent = this.#agents.get(command.agent);
    if (!agent?.definition.listSkills) {
      await this.#emit({
        type: "agentSkillListResult",
        result: {
          requestId: command.requestId,
          agent: command.agent,
          basePath: command.basePath,
          queriedAt: new Date().toISOString(),
          skills: [],
        },
      });
      return;
    }

    try {
      const skills = await agent.definition.listSkills({
        profile: this.#profile,
        env: process.env,
        workspace: this.#workspace,
        basePath: command.basePath,
      });
      await this.#emit({
        type: "agentSkillListResult",
        result: {
          requestId: command.requestId,
          agent: command.agent,
          basePath: command.basePath,
          queriedAt: new Date().toISOString(),
          skills: [...skills],
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        requestId: command.requestId,
        message,
        code: "SKILL_LIST_ERROR",
      });
    }
  }

  public deliverInput(sessionId: string, content: string): void {
    const running = this.#sessions.get(sessionId);
    if (running === undefined) {
      void this.#emit({
        type: "error",
        sessionId,
        message: "Session is not running",
        code: "SESSION_NOT_RUNNING",
      });
      return;
    }
    running.child.write(content);
    if (!content.endsWith("\n")) {
      running.child.write("\n");
    }
  }

  public async readFileTree(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path = ".",
    depth = 3,
  ): Promise<void> {
    await this.#workspaceCommands.readFileTree({
      type: "readFileTree",
      requestId,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      path,
      depth,
    });
  }

  public async readFileContent(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path: string,
    maxBytes = 256 * 1024,
  ): Promise<void> {
    await this.#workspaceCommands.readFileContent({
      type: "readFileContent",
      requestId,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      path,
      maxBytes,
    });
  }

  public async writeFileContent(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path: string,
    content: string,
  ): Promise<void> {
    await this.#workspaceCommands.writeFileContent({
      type: "writeFileContent",
      requestId,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      path,
      content,
    });
  }

  public async applyPatch(
    command: Extract<RunnerCommand, { type: "applyPatch" }>,
  ): Promise<void> {
    await this.#workspaceCommands.applyPatch(command);
  }

  public resolveApproval(
    approvalId: string,
    approved: boolean,
    signedAt: string,
    signature: string,
  ): void {
    this.#approvals.resolve(approvalId, approved, signedAt, signature);
  }

  public control(
    sessionId: string,
    signal: "interrupt" | "stop" | "resume",
  ): void {
    const running = this.#sessions.get(sessionId);
    if (running === undefined) {
      void this.#emit({
        type: "error",
        sessionId,
        message: "Session is not running",
        code: "SESSION_NOT_RUNNING",
      });
      return;
    }
    if (signal === "interrupt") {
      running.child.interrupt();
    } else if (signal === "stop") {
      running.stopRequested = true;
      running.child.kill("SIGTERM");
      running.stopTimer ??= setTimeout(() => {
        running.child.kill("SIGKILL");
      }, 1500);
      running.stopTimer.unref?.();
    } else {
      running.child.write(
        `${JSON.stringify({ type: "controlSignal", signal: "resume" })}\n`,
      );
    }
  }

  async #emitCommandError(
    requestId: string,
    sessionId: string,
    error: unknown,
  ): Promise<void> {
    await this.#emit({
      type: "error",
      requestId,
      sessionId,
      message: error instanceof Error ? error.message : String(error),
      code: "ATTACHMENT_ERROR",
    });
  }

  #trackOutput(running: RunningSession, chunk: string | Buffer): void {
    const task = this.#output.handle(running, chunk);
    running.outputTasks.add(task);
    void task
      .finally(() => {
        running.outputTasks.delete(task);
      })
      .catch(() => undefined);
  }

  async #finishSession(
    running: RunningSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this.#sessions.delete(running.session.id);
    await Promise.allSettled([...running.outputTasks]);
    this.#approvals.clear(running);
    if (running.stopTimer !== undefined) {
      clearTimeout(running.stopTimer);
    }
    const status =
      code === 0
        ? "completed"
        : running.stopRequested || signal === "SIGTERM" || signal === "SIGINT"
          ? "stopped"
          : "failed";
    await this.#emit({
      type: "sessionStatus",
      sessionId: running.session.id,
      status,
    });
  }

  #resolveCwd(cwd: string): string {
    return resolveWorkspaceChild(this.#workspace, cwd);
  }

  async #prepareExecutionFolder(session: Session): Promise<string> {
    if (session.executionMode !== "managed_worktree") {
      return this.#resolveCwd(session.executionFolder ?? session.cwd);
    }

    const projectCwd = this.#resolveCwd(session.cwd);
    const worktreeCwd = this.#resolveCwd(session.executionFolder);
    const existing = await stat(worktreeCwd).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (existing !== undefined) {
      if (!existing.isDirectory()) {
        throw new Error(
          `Managed worktree path is not a directory: ${session.executionFolder}`,
        );
      }
      await this.#assertManagedWorktree(projectCwd, worktreeCwd);
      return worktreeCwd;
    }
    const branchName = session.gitBranchName;
    if (branchName === undefined) {
      throw new Error("Managed worktree sessions require a git branch name");
    }
    const baseRef = session.gitBaseRef ?? "HEAD";
    await execFileAsync("git", [
      "-C",
      projectCwd,
      "rev-parse",
      "--verify",
      `${baseRef}^{commit}`,
    ]);
    await mkdir(dirname(worktreeCwd), { recursive: true });
    await execFileAsync("git", [
      "-C",
      projectCwd,
      "worktree",
      "add",
      "-b",
      branchName,
      worktreeCwd,
      baseRef,
    ]);
    return worktreeCwd;
  }

  async #assertManagedWorktree(
    projectCwd: string,
    worktreeCwd: string,
  ): Promise<void> {
    const [projectRealPath, worktreeRealPath] = await Promise.all([
      realpath(projectCwd),
      realpath(worktreeCwd),
    ]);
    if (projectRealPath === worktreeRealPath) {
      throw new Error(
        `Managed worktree path points at the project directory: ${worktreeCwd}`,
      );
    }

    const inside = await execFileAsync("git", [
      "-C",
      worktreeCwd,
      "rev-parse",
      "--is-inside-work-tree",
    ])
      .then(({ stdout }) => String(stdout).trim())
      .catch(() => "false");
    if (inside !== "true") {
      throw new Error(
        `Managed worktree path is not a git worktree: ${worktreeCwd}`,
      );
    }

    const { stdout } = await execFileAsync("git", [
      "-C",
      projectCwd,
      "worktree",
      "list",
      "--porcelain",
    ]);
    const worktreePaths = String(stdout)
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    const realWorktreePaths = await Promise.all(
      worktreePaths.map((path) => realpath(path).catch(() => path)),
    );
    if (!realWorktreePaths.includes(worktreeRealPath)) {
      throw new Error(
        `Managed worktree path is not registered for the project: ${worktreeCwd}`,
      );
    }
  }

  #getSessionCwd(
    sessionId: string,
    cwd: string | undefined,
  ): string | undefined {
    const existing = this.#sessionCwds.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    if (cwd === undefined) {
      return undefined;
    }
    const resolved = this.#resolveCwd(cwd);
    this.#sessionCwds.set(sessionId, resolved);
    return resolved;
  }
}
