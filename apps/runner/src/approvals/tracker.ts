import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRequestDraft,
} from "@roamcli/agent-plugin-sdk";
import type { Approval } from "@roamcli/shared/protocol";
import { nowIso } from "@roamcli/shared/protocol";
import type { RunnerEventSink } from "../sessions/types.js";

export interface ApprovalTrackerOptions {
  emit: RunnerEventSink;
}

export class ApprovalTracker {
  readonly #emit: RunnerEventSink;
  readonly #pending = new Map<
    string,
    {
      sessionId: string;
      resolve: (decision: ApprovalDecision) => void;
    }
  >();

  public constructor(options: ApprovalTrackerOptions) {
    this.#emit = options.emit;
  }

  public async request(
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
    const decision = new Promise<ApprovalDecision>((resolve) => {
      this.#pending.set(approval.id, {
        sessionId: session.id,
        resolve,
      });
    });
    await this.#emit({
      type: "sessionStatus",
      sessionId: session.id,
      status: "waiting_approval",
    });
    await this.#emit({ type: "approvalRequested", approval });
    return decision;
  }

  public resolve(approvalId: string, approved: boolean): void {
    const pending = this.#pending.get(approvalId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(approvalId);
    void Promise.resolve()
      .then(() =>
        this.#emit({
          type: "sessionStatus",
          sessionId: pending.sessionId,
          status: "running",
        }),
      )
      .catch(() => undefined)
      .finally(() => {
        pending.resolve({
          approvalId,
          approved,
          signedAt: nowIso(),
          signature: "",
        });
      });
  }

  public clear(sessionId: string): void {
    for (const [approvalId, pending] of this.#pending) {
      if (pending.sessionId === sessionId) {
        this.#pending.delete(approvalId);
        pending.resolve({
          approvalId,
          approved: false,
          signedAt: nowIso(),
          signature: "",
        });
      }
    }
  }

}
