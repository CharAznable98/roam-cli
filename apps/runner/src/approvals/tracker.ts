import { randomUUID } from "node:crypto";
import type { ApprovalRequestDraft } from "@roamcli/agent-plugin-sdk";
import type { Approval, RunnerCommand } from "@roamcli/protocol";
import { nowIso } from "@roamcli/protocol";
import { hashPayload, verifyApprovalSignature } from "@roamcli/security";
import type { RunnerEventSink, RunningSession } from "../sessions/types.js";

export interface ApprovalTrackerOptions {
  approvalSecret?: string;
  emit: RunnerEventSink;
}

export class ApprovalTracker {
  readonly #approvalSecret: string | undefined;
  readonly #emit: RunnerEventSink;
  readonly #pending = new Map<string, RunningSession>();

  public constructor(options: ApprovalTrackerOptions) {
    this.#approvalSecret = options.approvalSecret;
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

  public resolve(approvalId: string, approved: boolean, signedAt: string, signature: string): void {
    const running = this.#pending.get(approvalId);
    if (running === undefined) {
      return;
    }
    this.#pending.delete(approvalId);
    running.child.write(`${JSON.stringify({ type: "approvalResponse", approvalId, approved, signedAt, signature })}\n`);
    void this.#emit({ type: "sessionStatus", sessionId: running.session.id, status: "running" });
  }

  public clear(running: RunningSession): void {
    for (const [approvalId, pending] of this.#pending) {
      if (pending === running) {
        this.#pending.delete(approvalId);
      }
    }
  }

  public verifyPatchSignature(command: Extract<RunnerCommand, { type: "applyPatch" }>): string | undefined {
    if (this.#approvalSecret === undefined || this.#approvalSecret.length === 0) {
      return undefined;
    }
    const target = `patch:${command.sessionId}:${hashPayload(command.patch)}`;
    if (verifyApprovalSignature(this.#approvalSecret, target, true, command.signedAt, command.signature)) {
      return undefined;
    }
    return "Patch signature is invalid";
  }
}
