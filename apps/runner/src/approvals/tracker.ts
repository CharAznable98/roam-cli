import { randomUUID } from "node:crypto";
import type { ApprovalRequestDraft } from "@roamcli/agent-plugin-sdk";
import type { Approval } from "@roamcli/shared/protocol";
import { nowIso } from "@roamcli/shared/protocol";
import type { RunnerEventSink, RunningSession } from "../sessions/types.js";

export interface ApprovalTrackerOptions {
  emit: RunnerEventSink;
}

export class ApprovalTracker {
  readonly #emit: RunnerEventSink;
  readonly #pending = new Map<string, RunningSession>();

  public constructor(options: ApprovalTrackerOptions) {
    this.#emit = options.emit;
  }

  public async request(running: RunningSession, draft: ApprovalRequestDraft): Promise<void> {
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
    this.#pending.set(approval.id, running);
    await this.#emit({ type: "sessionStatus", sessionId: running.session.id, status: "waiting_approval" });
    await this.#emit({ type: "approvalRequested", approval });
  }

  public resolve(approvalId: string, approved: boolean): void {
    const running = this.#pending.get(approvalId);
    if (running === undefined) {
      return;
    }
    this.#pending.delete(approvalId);
    running.child.write(`${JSON.stringify({ type: "approvalResponse", approvalId, approved })}\n`);
    void this.#emit({ type: "sessionStatus", sessionId: running.session.id, status: "running" });
  }

  public clear(running: RunningSession): void {
    for (const [approvalId, pending] of this.#pending) {
      if (pending === running) {
        this.#pending.delete(approvalId);
      }
    }
  }

}
