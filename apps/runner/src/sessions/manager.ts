import type { AgentKind, RunnerCommand, RunnerProfile, Session } from "@roamcli/protocol";
import { spawnAgentProcess, type AgentProcess } from "../agents/process.js";
import type { LoadedAgent } from "../agents/registry.js";
import { ApprovalTracker } from "../approvals/tracker.js";
import { resolveWorkspaceChild } from "../workspace/scope.js";
import { SessionOutputHandler } from "./output.js";
import type { RunnerEventSink, RunningSession } from "./types.js";
import { WorkspaceCommandHandler } from "./workspace-commands.js";

export interface SessionManagerOptions {
  workspace: string;
  profile: RunnerProfile;
  agents: readonly LoadedAgent[];
  approvalSecret?: string;
  emit: RunnerEventSink;
}

export class SessionManager {
  readonly #workspace: string;
  readonly #profile: RunnerProfile;
  readonly #agents: Map<AgentKind, LoadedAgent>;
  readonly #emit: RunnerEventSink;
  readonly #approvals: ApprovalTracker;
  readonly #output: SessionOutputHandler;
  readonly #workspaceCommands: WorkspaceCommandHandler;
  readonly #sessions = new Map<string, RunningSession>();
  readonly #sessionCwds = new Map<string, string>();

  public constructor(options: SessionManagerOptions) {
    this.#workspace = options.workspace;
    this.#profile = options.profile;
    this.#agents = new Map(options.agents.map((agent) => [agent.capability.kind, agent]));
    this.#emit = options.emit;
    this.#approvals = new ApprovalTracker({
      emit: this.#emit,
      ...(options.approvalSecret === undefined ? {} : { approvalSecret: options.approvalSecret })
    });
    this.#output = new SessionOutputHandler({ approvals: this.#approvals, emit: this.#emit });
    this.#workspaceCommands = new WorkspaceCommandHandler({
      workspace: this.#workspace,
      emit: this.#emit,
      getSessionCwd: (sessionId, cwd) => this.#getSessionCwd(sessionId, cwd),
      getStartedSessionCwd: (sessionId) => this.#sessionCwds.get(sessionId),
      verifyPatchSignature: (command) => this.#approvals.verifyPatchSignature(command)
    });
  }

  public async handle(command: RunnerCommand): Promise<void> {
    switch (command.type) {
      case "startSession":
        await this.start(command.session, command.prompt, command.resumeThreadId);
        return;
      case "deliverInput":
        this.deliverInput(command.sessionId, command.content);
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
      case "resolveApproval":
        this.resolveApproval(command.approvalId, command.approved, command.signedAt, command.signature);
        return;
      case "controlSignal":
        this.control(command.sessionId, command.signal);
        return;
    }
  }

  public async start(session: Session, prompt: string, resumeThreadId?: string): Promise<void> {
    if (this.#sessions.has(session.id)) {
      await this.#emit({ type: "error", sessionId: session.id, message: "Session is already running", code: "SESSION_EXISTS" });
      return;
    }

    const agent = this.#agents.get(session.agent);
    if (agent === undefined) {
      await this.#emit({ type: "error", sessionId: session.id, message: `Unsupported agent: ${session.agent}`, code: "UNSUPPORTED_AGENT" });
      return;
    }

    let cwd: string;
    try {
      cwd = this.#resolveCwd(session.cwd);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({ type: "error", sessionId: session.id, message, code: "INVALID_CWD" });
      return;
    }

    let child: AgentProcess;
    try {
      const launch = agent.definition.buildLaunch({
        profile: this.#profile,
        env: process.env,
        prompt,
        ...(resumeThreadId ? { resumeThreadId } : {}),
      });
      child = await spawnAgentProcess(launch.command, launch.args, {
        cwd,
        env: process.env,
        preferPty: launch.preferPty,
        requirePty: launch.requirePty
      });
      const running: RunningSession = {
        session: { ...session, cwd },
        child,
        parser: agent.definition.createParser(),
        stopRequested: false,
        outputTasks: new Set()
      };
      this.#sessions.set(session.id, running);
      this.#sessionCwds.set(session.id, cwd);

      child.onData((chunk) => this.#trackOutput(running, chunk));
      child.onError((error) => {
        void this.#emit({ type: "error", sessionId: session.id, message: error.message, code: "SPAWN_ERROR" });
      });
      child.onExit(({ code, signal }) => {
        void this.#finishSession(running, code, signal);
      });

      await this.#emit({ type: "sessionStatus", sessionId: session.id, status: "running" });
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
      await this.#emit({ type: "error", sessionId: session.id, message, code: "SPAWN_ERROR" });
      await this.#emit({ type: "sessionStatus", sessionId: session.id, status: "failed" });
      return;
    }
  }

  public deliverInput(sessionId: string, content: string): void {
    const running = this.#sessions.get(sessionId);
    if (running === undefined) {
      void this.#emit({ type: "error", sessionId, message: "Session is not running", code: "SESSION_NOT_RUNNING" });
      return;
    }
    running.child.write(content);
    if (!content.endsWith("\n")) {
      running.child.write("\n");
    }
  }

  public async readFileTree(requestId: string, sessionId: string, cwd: string | undefined, path = ".", depth = 3): Promise<void> {
    await this.#workspaceCommands.readFileTree({ type: "readFileTree", requestId, sessionId, ...(cwd === undefined ? {} : { cwd }), path, depth });
  }

  public async readFileContent(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path: string,
    maxBytes = 256 * 1024
  ): Promise<void> {
    await this.#workspaceCommands.readFileContent({ type: "readFileContent", requestId, sessionId, ...(cwd === undefined ? {} : { cwd }), path, maxBytes });
  }

  public async writeFileContent(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path: string,
    content: string
  ): Promise<void> {
    await this.#workspaceCommands.writeFileContent({ type: "writeFileContent", requestId, sessionId, ...(cwd === undefined ? {} : { cwd }), path, content });
  }

  public async applyPatch(command: Extract<RunnerCommand, { type: "applyPatch" }>): Promise<void> {
    await this.#workspaceCommands.applyPatch(command);
  }

  public resolveApproval(approvalId: string, approved: boolean, signedAt: string, signature: string): void {
    this.#approvals.resolve(approvalId, approved, signedAt, signature);
  }

  public control(sessionId: string, signal: "interrupt" | "stop" | "resume"): void {
    const running = this.#sessions.get(sessionId);
    if (running === undefined) {
      void this.#emit({ type: "error", sessionId, message: "Session is not running", code: "SESSION_NOT_RUNNING" });
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
      running.child.write(`${JSON.stringify({ type: "controlSignal", signal: "resume" })}\n`);
    }
  }

  #trackOutput(running: RunningSession, chunk: string | Buffer): void {
    const task = this.#output.handle(running, chunk);
    running.outputTasks.add(task);
    task.finally(() => {
      running.outputTasks.delete(task);
    });
  }

  async #finishSession(running: RunningSession, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.#sessions.delete(running.session.id);
    await Promise.allSettled([...running.outputTasks]);
    this.#approvals.clear(running);
    if (running.stopTimer !== undefined) {
      clearTimeout(running.stopTimer);
    }
    const status = code === 0 ? "completed" : running.stopRequested || signal === "SIGTERM" || signal === "SIGINT" ? "stopped" : "failed";
    await this.#emit({ type: "sessionStatus", sessionId: running.session.id, status });
  }

  #resolveCwd(cwd: string): string {
    return resolveWorkspaceChild(this.#workspace, cwd);
  }

  #getSessionCwd(sessionId: string, cwd: string | undefined): string | undefined {
    const existing = this.#sessionCwds.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    if (cwd === undefined) {
      return undefined;
    }
    try {
      const resolved = this.#resolveCwd(cwd);
      this.#sessionCwds.set(sessionId, resolved);
      return resolved;
    } catch {
      return undefined;
    }
  }
}
