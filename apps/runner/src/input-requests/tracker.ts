import { randomUUID } from "node:crypto";
import type {
  UserInputDecision,
  UserInputRequestDraft,
} from "@roamcli/agent-plugin-sdk";
import { nowIso } from "@roamcli/shared/protocol";
import type {
  SessionGeneration,
  SessionWaitCoordinator,
} from "../sessions/wait-coordinator.js";
import type { RunnerEventSink } from "../sessions/types.js";

export interface UserInputRequestTrackerOptions {
  emit: RunnerEventSink;
  waits: SessionWaitCoordinator;
}

export class UserInputAcceptanceRetryableError extends Error {
  public constructor(cause: unknown) {
    super("User input acceptance status could not be synchronized", { cause });
    this.name = "UserInputAcceptanceRetryableError";
  }
}

interface PendingUserInputRequest {
  inputRequestId: string;
  token: SessionGeneration;
  resolve: (decision: UserInputDecision) => void;
  reject: (error: Error) => void;
  accepting: boolean;
  detachCancellation(): void;
}

export class UserInputRequestTracker {
  readonly #emit: RunnerEventSink;
  readonly #waits: SessionWaitCoordinator;
  readonly #pendingBySession = new Map<string, PendingUserInputRequest>();

  public constructor(options: UserInputRequestTrackerOptions) {
    this.#emit = options.emit;
    this.#waits = options.waits;
  }

  public async request(
    token: SessionGeneration,
    session: {
      id: string;
      agent?: string;
    },
    draft: UserInputRequestDraft,
  ): Promise<UserInputDecision> {
    const question = supportedQuestion(draft);
    draft.signal?.throwIfAborted();
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
        token,
        resolve,
        reject,
        accepting: false,
        detachCancellation: () => undefined,
      });
    });
    void decision.catch(() => undefined);

    if (!this.#waits.add(token, inputRequestId, "input")) {
      const pending = this.#pendingBySession.get(session.id);
      this.#pendingBySession.delete(session.id);
      const error = new Error(
        `Session ended before user input was requested: ${session.id}`,
      );
      pending?.reject(error);
      throw error;
    }
    if (draft.signal) {
      const signal = draft.signal;
      const cancel = () => {
        const pending = this.#pendingBySession.get(session.id);
        if (pending?.inputRequestId !== inputRequestId) return;
        this.#pendingBySession.delete(session.id);
        this.#waits.remove(token, inputRequestId);
        pending.detachCancellation();
        // Release the question synchronously, then settle only after its status
        // transition. The next native dialog can now use this session's slot.
        void this.#waits
          .syncStatus(token)
          .catch(() => undefined)
          .finally(() => {
            pending.reject(toError(signal.reason));
          });
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.#pendingBySession.get(session.id)!.detachCancellation = () =>
        signal.removeEventListener("abort", cancel);
    }
    try {
      await this.#emit({
        type: "agentActivity",
        sessionId: session.id,
        agent: session.agent ?? "unknown",
        kind: "status",
        label:
          question.header.length > 0
            ? `${question.header}: ${question.question}`
            : question.question,
        inputRequestId,
      });
      if (!this.#isPending(session.id, inputRequestId, token)) {
        return decision;
      }
      await this.#waits.syncStatus(token);
    } catch (error: unknown) {
      const pending = this.#pendingBySession.get(session.id);
      if (
        pending?.inputRequestId === inputRequestId &&
        pending.token.generation === token.generation
      ) {
        this.#pendingBySession.delete(session.id);
        this.#waits.remove(token, inputRequestId);
        pending.detachCancellation();
        pending.reject(toError(error));
        await this.#waits.syncStatus(token).catch(() => undefined);
      }
      throw error;
    }

    return decision;
  }

  public async resolve(
    sessionId: string,
    inputRequestId: string | undefined,
    content: string,
  ): Promise<boolean> {
    const pending = this.#pendingBySession.get(sessionId);
    if (pending === undefined) {
      return false;
    }
    if (
      inputRequestId !== undefined &&
      inputRequestId !== pending.inputRequestId
    ) {
      return false;
    }
    if (pending.accepting) {
      return false;
    }

    pending.accepting = true;
    if (!this.#waits.remove(pending.token, pending.inputRequestId)) {
      pending.accepting = false;
      return false;
    }

    try {
      await this.#waits.syncStatus(pending.token);
    } catch (error: unknown) {
      if (this.#pendingBySession.get(sessionId) === pending) {
        pending.accepting = false;
        this.#waits.add(pending.token, pending.inputRequestId, "input");
      }
      throw new UserInputAcceptanceRetryableError(error);
    }

    if (this.#pendingBySession.get(sessionId) !== pending) {
      return false;
    }
    this.#pendingBySession.delete(sessionId);
    pending.detachCancellation();
    pending.resolve({
      inputRequestId: pending.inputRequestId,
      content,
      answeredAt: nowIso(),
    });
    return true;
  }

  public clear(sessionId: string, token?: SessionGeneration): void {
    const pending = this.#pendingBySession.get(sessionId);
    if (
      pending === undefined ||
      (token !== undefined && pending.token.generation !== token.generation)
    ) {
      return;
    }
    this.#pendingBySession.delete(sessionId);
    this.#waits.remove(pending.token, pending.inputRequestId);
    pending.detachCancellation();
    pending.reject(new Error("Session ended before user input was provided"));
  }

  #isPending(
    sessionId: string,
    inputRequestId: string,
    token: SessionGeneration,
  ): boolean {
    const pending = this.#pendingBySession.get(sessionId);
    return (
      pending?.inputRequestId === inputRequestId &&
      pending.token.generation === token.generation &&
      this.#waits.has(token, inputRequestId)
    );
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function supportedQuestion(
  draft: UserInputRequestDraft,
): UserInputRequestDraft["questions"][number] {
  const question = draft.questions[0];
  if (
    draft.questions.length !== 1 ||
    question === undefined ||
    question.isSecret ||
    question.isOther ||
    (question.options?.length ?? 0) > 0
  ) {
    throw new Error(
      "RoamCli currently supports a single non-secret free-text question; structured choices, multiple questions, and secrets are not supported",
    );
  }
  return question;
}
