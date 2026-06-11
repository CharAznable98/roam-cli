import { parseAnsiChunk } from "../ansi.js";
import type { ApprovalTracker } from "../approvals/tracker.js";
import { buildArtifact } from "../persistence/artifacts.js";
import { resolveSessionChild } from "../workspace/scope.js";
import type { RunnerEventSink, RunningSession } from "./types.js";

export interface SessionOutputHandlerOptions {
  approvals: ApprovalTracker;
  emit: RunnerEventSink;
}

export class SessionOutputHandler {
  readonly #approvals: ApprovalTracker;
  readonly #emit: RunnerEventSink;

  public constructor(options: SessionOutputHandlerOptions) {
    this.#approvals = options.approvals;
    this.#emit = options.emit;
  }

  public async handle(running: RunningSession, chunk: string | Buffer): Promise<void> {
    const terminal = parseAnsiChunk(chunk);
    const parsed = running.parser.feed(chunk);
    await this.#emit({ type: "terminalData", sessionId: running.session.id, chunk: terminal.raw });
    if (parsed.threadId !== undefined) {
      await this.#emit({ type: "sessionThread", sessionId: running.session.id, threadId: parsed.threadId });
    }
    for (const message of parsed.messages ?? []) {
      await this.#emit({ type: "assistantMessage", sessionId: running.session.id, content: message, encrypted: false });
    }
    if (parsed.text.length > 0) {
      await this.#emit({ type: "token", sessionId: running.session.id, content: parsed.text, encrypted: false });
    }

    for (const draft of parsed.approvals) {
      await this.#approvals.request(running, draft);
    }

    for (const draft of parsed.artifacts) {
      try {
        const artifact = await buildArtifact(
          running.session.id,
          resolveSessionChild(running.session.cwd, draft.path),
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
}
