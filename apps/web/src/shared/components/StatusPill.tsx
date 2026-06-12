import type { SessionStatus } from "@roamcli/shared/protocol";

const styles: Record<SessionStatus, string> = {
  pending: "bg-ink-100 text-ink-700",
  running: "bg-cyan-50 text-signal-cyan",
  waiting_approval: "bg-amber-50 text-signal-amber",
  completed: "bg-emerald-50 text-signal-green",
  failed: "bg-red-50 text-signal-red",
  stopped: "bg-ink-200 text-ink-700"
};

const labels: Record<SessionStatus, string> = {
  pending: "待执行",
  running: "执行中",
  waiting_approval: "等待审批",
  completed: "已结束",
  failed: "失败",
  stopped: "已停止",
};

export function StatusPill({ status }: { status: SessionStatus }) {
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}>{labels[status]}</span>;
}
