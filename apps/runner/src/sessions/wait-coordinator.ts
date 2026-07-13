import type { SessionStatus } from "@roamcli/shared/protocol";
import type { RunnerEventSink } from "./types.js";

export interface SessionGeneration {
  sessionId: string;
  generation: number;
}

export type SessionWaitReason = "approval" | "input";

interface SessionWaitState {
  generation: number;
  active: boolean;
  reasons: Map<string, SessionWaitReason>;
  statusTail: Promise<void>;
}

/**
 * Owns the status transition gate shared by approval and user-input requests.
 * Mutations are synchronous; status emission is serialized and re-checks the
 * current generation immediately before publishing a transition.
 */
export class SessionWaitCoordinator {
  readonly #emit: RunnerEventSink;
  readonly #states = new Map<string, SessionWaitState>();
  #nextGeneration = 0;

  public constructor(emit: RunnerEventSink) {
    this.#emit = emit;
  }

  public begin(sessionId: string): SessionGeneration {
    const generation = ++this.#nextGeneration;
    this.#states.set(sessionId, {
      generation,
      active: true,
      reasons: new Map(),
      statusTail: Promise.resolve(),
    });
    return { sessionId, generation };
  }

  public isActive(token: SessionGeneration): boolean {
    const state = this.#states.get(token.sessionId);
    return state?.generation === token.generation && state.active;
  }

  public add(
    token: SessionGeneration,
    reasonId: string,
    reason: SessionWaitReason,
  ): boolean {
    const state = this.#activeState(token);
    if (state === undefined) {
      return false;
    }
    state.reasons.set(reasonId, reason);
    return true;
  }

  public has(token: SessionGeneration, reasonId: string): boolean {
    return this.#activeState(token)?.reasons.has(reasonId) ?? false;
  }

  public hasWaits(token: SessionGeneration): boolean {
    return (this.#activeState(token)?.reasons.size ?? 0) > 0;
  }

  public remove(token: SessionGeneration, reasonId: string): boolean {
    return this.#activeState(token)?.reasons.delete(reasonId) ?? false;
  }

  public finish(token: SessionGeneration): boolean {
    const state = this.#activeState(token);
    if (state === undefined) {
      return false;
    }
    state.active = false;
    state.reasons.clear();
    this.#states.delete(token.sessionId);
    return true;
  }

  public async syncStatus(token: SessionGeneration): Promise<void> {
    const state = this.#activeState(token);
    if (state === undefined) {
      return;
    }
    const operation = state.statusTail.then(async () => {
      const current = this.#activeState(token);
      if (current === undefined) {
        return;
      }
      await this.#emit({
        type: "sessionStatus",
        sessionId: token.sessionId,
        status: preferredStatus(current.reasons.values()),
      });
    });
    state.statusTail = operation.catch(() => undefined);
    await operation;
  }

  public async emitStatus(
    token: SessionGeneration,
    status: SessionStatus,
  ): Promise<void> {
    const state = this.#activeState(token);
    if (state === undefined) {
      return;
    }
    const operation = state.statusTail.then(async () => {
      if (!this.isActive(token)) {
        return;
      }
      await this.#emit({
        type: "sessionStatus",
        sessionId: token.sessionId,
        status,
      });
    });
    state.statusTail = operation.catch(() => undefined);
    await operation;
  }

  #activeState(token: SessionGeneration): SessionWaitState | undefined {
    const state = this.#states.get(token.sessionId);
    if (
      state === undefined ||
      state.generation !== token.generation ||
      !state.active
    ) {
      return undefined;
    }
    return state;
  }
}

function preferredStatus(
  reasons: IterableIterator<SessionWaitReason>,
): SessionStatus {
  let hasApproval = false;
  for (const reason of reasons) {
    if (reason === "input") {
      return "waiting_input";
    }
    hasApproval = true;
  }
  return hasApproval ? "waiting_approval" : "running";
}
