import type { Approval, PatchHunk } from "@roamcli/shared/protocol";
import { Check, Clock, KeyRound, LoaderCircle, X } from "lucide-react";
import { PatchReview } from "./PatchReview";

type ApprovalCenterProps = {
  approvals: Approval[];
  hunks: PatchHunk[];
  onResolveApproval: (approvalId: string, approved: boolean) => void;
  onResolveHunk: (hunkId: string, status: "accepted" | "rejected") => void;
  onApplyPatch: () => void;
  patchApplyState: "idle" | "loading" | "ready" | "error";
  loading?: boolean;
};

export function ApprovalCenter({
  approvals,
  hunks,
  onResolveApproval,
  onResolveHunk,
  onApplyPatch,
  patchApplyState,
  loading = false,
}: ApprovalCenterProps) {
  const pendingCount = approvals.filter(
    (approval) => approval.status === "pending",
  ).length;
  return (
    <section className="tool-panel" aria-label="Approvals">
      <div className="tool-panel-header">
        <h2 className="panel-title">Approval Center</h2>
        <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-signal-amber">
          {loading ? "Loading" : `${pendingCount} pending`}
        </span>
      </div>
      <div className="space-y-3">
        {loading ? <ApprovalCenterSkeleton /> : null}
        {!loading && approvals.length === 0 ? (
          <div className="empty-state compact">No pending approvals.</div>
        ) : null}
        {!loading
          ? approvals.map((approval) => (
              <article key={approval.id} className="approval-card">
                <div className="flex items-start gap-3">
                  <div className="approval-icon">
                    {approval.kind === "applyPatch" ? (
                      <KeyRound size={17} />
                    ) : (
                      <Clock size={17} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="truncate font-medium text-ink-900">
                        {approval.summary}
                      </h3>
                      <span className={`approval-status ${approval.status}`}>
                        {approval.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      {approval.kind} · {approval.runnerId}
                    </p>
                    <pre>{JSON.stringify(approval.payload, null, 2)}</pre>
                  </div>
                </div>
                {approval.status === "pending" ? (
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className="small-button accept"
                      onClick={() => onResolveApproval(approval.id, true)}
                    >
                      <Check size={14} />
                      Approve
                    </button>
                    <button
                      type="button"
                      className="small-button reject"
                      onClick={() => onResolveApproval(approval.id, false)}
                    >
                      <X size={14} />
                      Reject
                    </button>
                  </div>
                ) : null}
              </article>
            ))
          : null}
      </div>
      {!loading ? (
        <PatchReview
          hunks={hunks}
          onResolveHunk={onResolveHunk}
          onApplyPatch={onApplyPatch}
          applyState={patchApplyState}
        />
      ) : null}
    </section>
  );
}

function ApprovalCenterSkeleton() {
  return (
    <div
      className="approval-loading"
      role="status"
      aria-label="Loading approvals"
    >
      <div className="approval-loading-row">
        <LoaderCircle size={15} />
        <span>Loading approvals...</span>
      </div>
      {[0, 1, 2].map((item) => (
        <div className="approval-card skeleton-approval-card" key={item}>
          <span className="skeleton-line medium" />
          <span className="skeleton-line wide" />
          <span className="skeleton-line narrow" />
        </div>
      ))}
    </div>
  );
}
