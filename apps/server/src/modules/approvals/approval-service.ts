import {
  nowIso,
  type Approval,
  type ApiApprovalResponse,
} from "@roamcli/protocol";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import type { ServerStore } from "../../infra/sqlite-store.js";
import { fail, ok, type ServiceResult } from "../result.js";
import type { ApprovalSignatureVerifier } from "./approval-signatures.js";

export class ApprovalService {
  constructor(
    private readonly store: ServerStore,
    private readonly hub: ConnectionHub,
    private readonly signatures: ApprovalSignatureVerifier,
  ) {}

  respondToApproval(
    approvalId: string,
    response: ApiApprovalResponse,
  ): ServiceResult<{ approval: Approval }> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) {
      return fail("approval_not_found");
    }
    if (approval.status !== "pending") {
      return fail("approval_already_resolved");
    }
    if (
      !this.signatures.isApprovalSignatureValid(
        approval.id,
        response.approved,
        response.signedAt,
        response.signature,
      )
    ) {
      return fail("invalid_signature");
    }

    const updated: Approval = {
      ...approval,
      status: response.approved ? "approved" : "rejected",
      resolvedAt: nowIso(),
      clientSignature: response.signature,
    };
    const sent = this.hub.sendToRunner(updated.runnerId, {
      type: "resolveApproval",
      approvalId: updated.id,
      approved: response.approved,
      signedAt: response.signedAt,
      signature: response.signature,
    });
    if (!sent) {
      return fail("runner_offline", { message: "runner is offline" });
    }

    this.store.upsertApproval(updated);
    this.hub.broadcast({ type: "approval:updated", approval: updated });

    return ok({ approval: updated });
  }
}
