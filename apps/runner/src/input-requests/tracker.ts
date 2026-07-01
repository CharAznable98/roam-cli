import { randomUUID } from "node:crypto";
import type {
  UserInputDecision,
  UserInputRequestDraft,
} from "@roamcli/agent-plugin-sdk";
import { nowIso } from "@roamcli/shared/protocol";
import type { RunnerEventSink } from "../sessions/types.js";

export interface UserInputRequestTrackerOptions {
  emit: RunnerEventSink;
}

export class UserInputRequestTracker {
  readonly #emit: RunnerEventSink;
  readonly #pendingBySession = new Map<
    string,
    {
      inputRequestId: string;
      resolve: (decision: UserInputDecision) => void;
      reject: (error: Error) => void;
    }
  >();

  public constructor(options: UserInputRequestTrackerOptions) {
    this.#emit = options.emit;
  }

  public async request(
    session: {
      id: string;
      agent?: string;
    },
    draft: UserInputRequestDraft,
  ): Promise<UserInputDecision> {
    const existing = this.#pendingBySession.get(session.id);
    if (existing !== undefined) {
      throw new Error(
        `Session already has a pending user input request: ${session.id}`,
      );
    }

    const inputRequestId = randomUUID();
    const decision = new Promise<UserInputDecision>((resolve, reject) => {
      this.#pendingBySession.set(session.id, {
        inputRequestId,
        resolve,
        reject,
      });
    });

    await this.#emit({
      type: "sessionStatus",
      sessionId: session.id,
      status: "waiting_input",
    });
    await this.#emit({
      type: "agentActivity",
      sessionId: session.id,
      agent: session.agent ?? "unknown",
      kind: "status",
      label: draft.summary,
    });

    return decision;
  }

  public resolve(sessionId: string, content: string): void {
    const pending = this.#pendingBySession.get(sessionId);
    if (pending === undefined) {
      void this.#emit({
        type: "error",
        sessionId,
        message: "Session is not waiting for user input",
        code: "SESSION_NOT_WAITING_INPUT",
      });
      return;
    }
    this.#pendingBySession.delete(sessionId);
    void Promise.resolve()
      .then(() =>
        this.#emit({
          type: "sessionStatus",
          sessionId,
          status: "running",
        }),
      )
      .catch(() => undefined)
      .finally(() => {
        pending.resolve({
          inputRequestId: pending.inputRequestId,
          content,
          answeredAt: nowIso(),
        });
      });
  }

  public clear(sessionId: string): void {
    const pending = this.#pendingBySession.get(sessionId);
    if (pending === undefined) {
      return;
    }
    this.#pendingBySession.delete(sessionId);
    pending.reject(new Error("Session ended before user input was provided"));
  }
}
