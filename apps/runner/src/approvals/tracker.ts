import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRequestDraft,
} from "@roamcli/agent-plugin-sdk";
import type { Approval } from "@roamcli/shared/protocol";
import { nowIso } from "@roamcli/shared/protocol";
import type {
  SessionGeneration,
  SessionWaitCoordinator,
} from "../sessions/wait-coordinator.js";
import type { RunnerEventSink } from "../sessions/types.js";

export interface ApprovalTrackerOptions {
  emit: RunnerEventSink;
  waits: SessionWaitCoordinator;
}

export class ApprovalTracker {
  readonly #emit: RunnerEventSink;
  readonly #waits: SessionWaitCoordinator;
  readonly #pending = new Map<
    string,
    {
      sessionId: string;
      token: SessionGeneration;
      resolve: (decision: ApprovalDecision) => void;
      reject: (error: Error) => void;
    }
  >();

  public constructor(options: ApprovalTrackerOptions) {
    this.#emit = options.emit;
    this.#waits = options.waits;
  }

  public async request(
    token: SessionGeneration,
    session: {
      id: string;
      runnerId: string;
    },
    draft: ApprovalRequestDraft,
  ): Promise<ApprovalDecision> {
    const approval: Approval = {
      id: randomUUID(),
      sessionId: session.id,
      runnerId: session.runnerId,
      kind: draft.kind,
      summary: draft.summary,
      payload: draft.payload,
      status: "pending",
      requestedAt: nowIso(),
    };
    const decision = new Promise<ApprovalDecision>((resolve, reject) => {
      this.#pending.set(approval.id, {
        sessionId: session.id,
        token,
        resolve,
        reject,
      });
    });
    void decision.catch(() => undefined);
    if (!this.#waits.add(token, approval.id, "approval")) {
      const pending = this.#pending.get(approval.id);
      this.#pending.delete(approval.id);
      const error = new Error(
        `Session ended before approval was requested: ${session.id}`,
      );
      pending?.reject(error);
      throw error;
    }
    try {
      await this.#waits.syncStatus(token);
      if (!this.#isPending(approval.id, token)) {
        return decision;
      }
      await this.#emit({ type: "approvalRequested", approval });
    } catch (error: unknown) {
      if (this.#isPending(approval.id, token)) {
        const pending = this.#pending.get(approval.id);
        this.#pending.delete(approval.id);
        this.#waits.remove(token, approval.id);
        pending?.reject(toError(error));
        await this.#waits.syncStatus(token).catch(() => undefined);
      }
      throw error;
    }
    return decision;
  }

  public resolve(approvalId: string, approved: boolean): void {
    const pending = this.#pending.get(approvalId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(approvalId);
    this.#waits.remove(pending.token, approvalId);
    void this.#waits
      .syncStatus(pending.token)
      .catch(() => undefined)
      .finally(() => {
        pending.resolve({
          approvalId,
          approved,
          signedAt: nowIso(),
        });
      });
  }

  public clear(sessionId: string, token?: SessionGeneration): void {
    for (const [approvalId, pending] of this.#pending) {
      if (
        pending.sessionId === sessionId &&
        (token === undefined || pending.token.generation === token.generation)
      ) {
        this.#pending.delete(approvalId);
        this.#waits.remove(pending.token, approvalId);
        pending.resolve({
          approvalId,
          approved: false,
          signedAt: nowIso(),
        });
      }
    }
  }

  #isPending(approvalId: string, token: SessionGeneration): boolean {
    const pending = this.#pending.get(approvalId);
    return (
      pending?.token.generation === token.generation &&
      this.#waits.has(token, approvalId)
    );
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
