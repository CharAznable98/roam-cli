import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentOutputParser } from "@roamcli/agent-plugin-sdk";
import type { AgentKind, Approval, RunnerCommand, RunnerEvent, RunnerProfile, Session } from "@roamcli/protocol";
import { nowIso } from "@roamcli/protocol";
import { hashPayload, verifyApprovalSignature } from "@roamcli/security";
import { spawnAgentProcess, type AgentProcess } from "./agent-process.js";
import { buildArtifact } from "./artifacts.js";
import type { LoadedAgent } from "./capabilities.js";
import { readFileContent, readFileTree, writeFileContent } from "./files.js";
import { parseAnsiChunk } from "./ansi.js";
import { applyUnifiedDiff } from "./patch.js";

export type RunnerEventSink = (event: RunnerEvent) => Promise<void> | void;

export interface SessionManagerOptions {
  workspace: string;
  profile: RunnerProfile;
  agents: readonly LoadedAgent[];
  approvalSecret?: string;
  emit: RunnerEventSink;
}

interface RunningSession {
  session: Session;
  child: AgentProcess;
  parser: AgentOutputParser;
  stopRequested: boolean;
  outputQueue: Promise<void>;
  stopTimer?: ReturnType<typeof setTimeout>;
}

export class SessionManager {
  readonly #workspace: string;
  readonly #profile: RunnerProfile;
  readonly #agents: Map<AgentKind, LoadedAgent>;
  readonly #approvalSecret: string | undefined;
  readonly #emit: RunnerEventSink;
  readonly #sessions = new Map<string, RunningSession>();
  readonly #sessionCwds = new Map<string, string>();
  readonly #pendingApprovals = new Map<string, RunningSession>();

  public constructor(options: SessionManagerOptions) {
    this.#workspace = options.workspace;
    this.#profile = options.profile;
    this.#agents = new Map(options.agents.map((agent) => [agent.capability.kind, agent]));
    this.#approvalSecret = options.approvalSecret;
    this.#emit = options.emit;
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
        await this.readFileTree(command.requestId, command.sessionId, command.cwd, command.path, command.depth);
        return;
      case "readFileContent":
        await this.readFileContent(command.requestId, command.sessionId, command.cwd, command.path, command.maxBytes);
        return;
      case "writeFileContent":
        await this.writeFileContent(command.requestId, command.sessionId, command.cwd, command.path, command.content);
        return;
      case "applyPatch":
        await this.applyPatch(command);
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
        outputQueue: Promise.resolve()
      };
      this.#sessions.set(session.id, running);
      this.#sessionCwds.set(session.id, cwd);

      child.onData((chunk) => {
        running.outputQueue = running.outputQueue
          .then(() => this.#handleOutput(running, chunk))
          .catch((error: unknown) => this.#handleOutputError(running, error));
      });
      child.onError((error) => {
        void this.#emit({ type: "error", sessionId: session.id, message: error.message, code: "SPAWN_ERROR" });
      });
      child.onExit(({ code, signal }) => {
        void running.outputQueue.then(() => {
          this.#sessions.delete(session.id);
          this.#clearPendingApprovals(running);
          if (running.stopTimer !== undefined) {
            clearTimeout(running.stopTimer);
          }
          const status = code === 0 ? "completed" : running.stopRequested || signal === "SIGTERM" || signal === "SIGINT" ? "stopped" : "failed";
          void this.#emit({ type: "sessionStatus", sessionId: session.id, status });
        });
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
    const sessionCwd = this.#getSessionCwd(sessionId, cwd);
    if (sessionCwd === undefined) {
      await this.#emit({ type: "error", requestId, sessionId, message: "Session cwd is unavailable", code: "SESSION_NOT_FOUND" });
      return;
    }
    try {
      const result = await readFileTree({ workspace: this.#workspace, sessionCwd, requestId, sessionId, path, depth });
      await this.#emit({ type: "fileTreeResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({ type: "error", requestId, sessionId, message, code: "FILE_TREE_ERROR" });
    }
  }

  public async readFileContent(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path: string,
    maxBytes = 256 * 1024
  ): Promise<void> {
    const sessionCwd = this.#getSessionCwd(sessionId, cwd);
    if (sessionCwd === undefined) {
      await this.#emit({ type: "error", requestId, sessionId, message: "Session cwd is unavailable", code: "SESSION_NOT_FOUND" });
      return;
    }
    try {
      const result = await readFileContent({ workspace: this.#workspace, sessionCwd, requestId, sessionId, path, maxBytes });
      await this.#emit({ type: "fileContentResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({ type: "error", requestId, sessionId, message, code: "FILE_CONTENT_ERROR" });
    }
  }

  public async writeFileContent(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path: string,
    content: string
  ): Promise<void> {
    const sessionCwd = this.#getSessionCwd(sessionId, cwd);
    if (sessionCwd === undefined) {
      await this.#emit({ type: "error", requestId, sessionId, message: "Session cwd is unavailable", code: "SESSION_NOT_FOUND" });
      return;
    }
    try {
      const result = await writeFileContent({ workspace: this.#workspace, sessionCwd, requestId, sessionId, path, content });
      await this.#emit({ type: "fileWriteResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({ type: "error", requestId, sessionId, message, code: "FILE_WRITE_ERROR" });
    }
  }

  public async applyPatch(command: Extract<RunnerCommand, { type: "applyPatch" }>): Promise<void> {
    const signatureError = this.#verifyPatchSignature(command);
    if (signatureError !== undefined) {
      await this.#emit({
        type: "patchApplyResult",
        result: {
          requestId: command.requestId,
          sessionId: command.sessionId,
          applied: false,
          changedFiles: [],
          message: signatureError,
          rejected: [signatureError]
        }
      });
      return;
    }

    const sessionCwd = this.#sessionCwds.get(command.sessionId);
    if (sessionCwd === undefined) {
      await this.#emit({
        type: "patchApplyResult",
        result: {
          requestId: command.requestId,
          sessionId: command.sessionId,
          applied: false,
          changedFiles: [],
          message: "Session cwd is unavailable",
          rejected: ["Session cwd is unavailable"]
        }
      });
      return;
    }

    const result = await applyUnifiedDiff({
      workspace: this.#workspace,
      sessionCwd,
      requestId: command.requestId,
      sessionId: command.sessionId,
      patch: command.patch,
      ...(command.strip === undefined ? {} : { strip: command.strip })
    });
    await this.#emit({ type: "patchApplyResult", result });
  }

  #verifyPatchSignature(command: Extract<RunnerCommand, { type: "applyPatch" }>): string | undefined {
    if (this.#approvalSecret === undefined || this.#approvalSecret.length === 0) {
      return undefined;
    }
    const target = `patch:${command.sessionId}:${hashPayload(command.patch)}`;
    if (verifyApprovalSignature(this.#approvalSecret, target, true, command.signedAt, command.signature)) {
      return undefined;
    }
    return "Patch signature is invalid";
  }

  public resolveApproval(approvalId: string, approved: boolean, signedAt: string, signature: string): void {
    const running = this.#pendingApprovals.get(approvalId);
    if (running === undefined) {
      return;
    }
    this.#pendingApprovals.delete(approvalId);
    running.child.write(`${JSON.stringify({ type: "approvalResponse", approvalId, approved, signedAt, signature })}\n`);
    void this.#emit({ type: "sessionStatus", sessionId: running.session.id, status: "running" });
  }

  #clearPendingApprovals(running: RunningSession): void {
    for (const [approvalId, pending] of this.#pendingApprovals) {
      if (pending === running) {
        this.#pendingApprovals.delete(approvalId);
      }
    }
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

  async #handleOutput(running: RunningSession, chunk: string | Buffer): Promise<void> {
    const terminal = parseAnsiChunk(chunk);
    const parsed = running.parser.feed(chunk);
    await this.#emit({ type: "terminalData", sessionId: running.session.id, chunk: terminal.raw });
    if (parsed.threadId !== undefined) {
      await this.#emit({ type: "sessionThread", sessionId: running.session.id, threadId: parsed.threadId });
    }
    if (parsed.text.length > 0) {
      await this.#emit({ type: "token", sessionId: running.session.id, content: parsed.text, encrypted: false });
    }

    for (const draft of parsed.approvals) {
      const approval: Approval = {
        id: randomUUID(),
        sessionId: running.session.id,
        runnerId: running.session.runnerId,
        kind: draft.kind,
        summary: draft.summary,
        payload: draft.payload,
        status: "pending",
        requestedAt: nowIso()
      };
      this.#pendingApprovals.set(approval.id, running);
      await this.#emit({ type: "sessionStatus", sessionId: running.session.id, status: "waiting_approval" });
      await this.#emit({ type: "approvalRequested", approval });
    }

    for (const draft of parsed.artifacts) {
      try {
        const artifact = await buildArtifact(
          running.session.id,
          this.#resolveSessionPath(running.session.cwd, draft.path),
          draft.kind ?? "file",
          draft.mimeType ?? "application/octet-stream"
        );
        await this.#emit({ type: "artifactCreated", artifact });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#emit({ type: "error", sessionId: running.session.id, message, code: "ARTIFACT_ERROR" });
      }
    }
  }

  async #handleOutputError(running: RunningSession, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.#emit({ type: "error", sessionId: running.session.id, message, code: "OUTPUT_ERROR" });
  }

  #resolveCwd(cwd: string): string {
    const candidate = resolve(this.#workspace, cwd);
    if (candidate !== this.#workspace && !candidate.startsWith(`${this.#workspace}/`)) {
      throw new Error(`Path escapes workspace: ${cwd}`);
    }
    return candidate;
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

  #resolveSessionPath(sessionCwd: string, path: string): string {
    const candidate = resolve(sessionCwd, path);
    if (candidate !== sessionCwd && !candidate.startsWith(`${sessionCwd}/`)) {
      throw new Error(`Path escapes session cwd: ${path}`);
    }
    return candidate;
  }
}
