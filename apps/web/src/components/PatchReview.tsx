import type { PatchHunk } from "@roamcli/protocol";
import { Check, CheckCheck, Loader2, X } from "lucide-react";

type PatchReviewProps = {
  hunks: PatchHunk[];
  onResolveHunk: (hunkId: string, status: "accepted" | "rejected") => void;
  onApplyPatch: () => void;
  applyState: "idle" | "loading" | "ready" | "error";
};

export function PatchReview({ hunks, onResolveHunk, onApplyPatch, applyState }: PatchReviewProps) {
  const acceptedCount = hunks.filter((hunk) => hunk.status === "accepted").length;
  const pendingCount = hunks.filter((hunk) => hunk.status === "pending").length;
  const canApply = acceptedCount > 0 && applyState !== "loading";

  return (
    <div className="space-y-3">
      <div className="patch-toolbar">
        <div className="min-w-0">
          <h3 className="panel-title">Patch Hunks</h3>
          <p className="text-xs text-ink-500">
            {acceptedCount} accepted · {pendingCount} pending
          </p>
        </div>
        <button className="small-button accept" type="button" disabled={!canApply} onClick={onApplyPatch}>
          {applyState === "loading" ? <Loader2 className="spin" size={14} /> : <CheckCheck size={14} />}
          Apply
        </button>
      </div>
      {hunks.length === 0 ? <div className="empty-state compact">No patch hunks for this session.</div> : null}
      {hunks.map((hunk) => (
        <article key={hunk.id} className="hunk">
          <div className="hunk-header">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink-900">{hunk.filePath}</p>
              <p className="truncate text-xs text-ink-500">{hunk.header}</p>
            </div>
            <span className={`hunk-status ${hunk.status}`}>{hunk.status}</span>
          </div>
          <pre>
            {hunk.lines.map((line) => (
              <code key={`${hunk.id}-${line}`}>{line}</code>
            ))}
          </pre>
          <div className="flex justify-end gap-2">
            <button
              className="small-button accept"
              type="button"
              aria-label={`Accept patch hunk ${hunk.id}`}
              disabled={hunk.status !== "pending"}
              onClick={() => onResolveHunk(hunk.id, "accepted")}
            >
              <Check size={14} />
              Accept
            </button>
            <button
              className="small-button reject"
              type="button"
              aria-label={`Reject patch hunk ${hunk.id}`}
              disabled={hunk.status !== "pending"}
              onClick={() => onResolveHunk(hunk.id, "rejected")}
            >
              <X size={14} />
              Reject
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
