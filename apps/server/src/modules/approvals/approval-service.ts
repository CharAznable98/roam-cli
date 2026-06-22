import {
  nowIso,
  type Approval,
  type ApiApprovalResponse,
} from "@roamcli/shared/protocol";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import type { ServerStore } from "../../infra/sqlite-store.js";
import { fail, ok, type ServiceResult } from "../result.js";

export class ApprovalService {
  constructor(
    private readonly store: ServerStore,
    private readonly hub: ConnectionHub,
  ) {}

  respondToApproval(
    approvalId: string,
    response: ApiApprovalResponse,
    resolverSessionId?: string,
  ): ServiceResult<{ approval: Approval }> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) {
      return fail("approval_not_found");
    }
    if (approval.status !== "pending") {
      return fail("approval_already_resolved");
    }
    const updated: Approval = {
      ...approval,
      status: response.approved ? "approved" : "rejected",
      resolvedAt: nowIso(),
      resolvedBy: "owner",
      ...(resolverSessionId ? { resolverSessionId } : {}),
    };
    const sent = this.hub.sendToRunner(updated.runnerId, {
      type: "resolveApproval",
      approvalId: updated.id,
      approved: response.approved,
    });
    if (!sent) {
      return fail("runner_offline", { message: "runner is offline" });
    }

    this.store.upsertApproval(updated);
    this.hub.broadcast({ type: "approval:updated", approval: updated });

    return ok({ approval: updated });
  }
}
