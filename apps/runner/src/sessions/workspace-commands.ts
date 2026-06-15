import type { RunnerCommand } from "@roamcli/shared/protocol";
import { applyUnifiedDiff } from "../workspace/patch.js";
import { readFileContent, readFileTree, writeFileContent } from "../workspace/files.js";
import type { RunnerEventSink } from "./types.js";

export interface WorkspaceCommandHandlerOptions {
  workspace: string;
  emit: RunnerEventSink;
  getSessionCwd(sessionId: string, cwd: string | undefined): string | undefined;
  getStartedSessionCwd(sessionId: string): string | undefined;
  verifyPatchSignature(command: Extract<RunnerCommand, { type: "applyPatch" }>): string | undefined;
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

  public async readFileTree(command: Extract<RunnerCommand, { type: "readFileTree" }>): Promise<void> {
    const sessionCwd = await this.#resolveFileCommandCwd(command.requestId, command.sessionId, command.cwd);
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
        ...(command.depth === undefined ? {} : { depth: command.depth })
      });
      await this.#emit({ type: "fileTreeResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({ type: "error", requestId: command.requestId, sessionId: command.sessionId, message, code: "FILE_TREE_ERROR" });
    }
  }

  public async readFileContent(command: Extract<RunnerCommand, { type: "readFileContent" }>): Promise<void> {
    const sessionCwd = await this.#resolveFileCommandCwd(command.requestId, command.sessionId, command.cwd);
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
        ...(command.maxBytes === undefined ? {} : { maxBytes: command.maxBytes })
      });
      await this.#emit({ type: "fileContentResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({ type: "error", requestId: command.requestId, sessionId: command.sessionId, message, code: "FILE_CONTENT_ERROR" });
    }
  }

  public async writeFileContent(command: Extract<RunnerCommand, { type: "writeFileContent" }>): Promise<void> {
    const sessionCwd = await this.#resolveFileCommandCwd(command.requestId, command.sessionId, command.cwd);
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
        content: command.content
      });
      await this.#emit({ type: "fileWriteResult", result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({ type: "error", requestId: command.requestId, sessionId: command.sessionId, message, code: "FILE_WRITE_ERROR" });
    }
  }

  public async applyPatch(command: Extract<RunnerCommand, { type: "applyPatch" }>): Promise<void> {
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
      ...(command.strip === undefined ? {} : { strip: command.strip })
    });
    await this.#emit({ type: "patchApplyResult", result });
  }

  async #resolveFileCommandCwd(requestId: string, sessionId: string, cwd: string | undefined): Promise<string | undefined> {
    try {
      const sessionCwd = this.#getSessionCwd(sessionId, cwd);
      if (sessionCwd === undefined) {
        await this.#emitSessionCwdUnavailable(requestId, sessionId);
      }
      return sessionCwd;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({ type: "error", requestId, sessionId, message, code: "INVALID_CWD" });
      return undefined;
    }
  }

  async #emitSessionCwdUnavailable(requestId: string, sessionId: string): Promise<void> {
    await this.#emit({ type: "error", requestId, sessionId, message: "Session cwd is unavailable", code: "SESSION_NOT_FOUND" });
  }

  async #emitPatchResult(command: Extract<RunnerCommand, { type: "applyPatch" }>, message: string): Promise<void> {
    await this.#emit({
      type: "patchApplyResult",
      result: {
        requestId: command.requestId,
        sessionId: command.sessionId,
        applied: false,
        changedFiles: [],
        message,
        rejected: [message]
      }
    });
  }
}
