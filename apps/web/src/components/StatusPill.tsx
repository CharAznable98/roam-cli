import type { SessionStatus } from "@roamcli/protocol";

const styles: Record<SessionStatus, string> = {
  pending: "bg-ink-100 text-ink-700",
  running: "bg-cyan-50 text-signal-cyan",
  waiting_approval: "bg-amber-50 text-signal-amber",
  completed: "bg-emerald-50 text-signal-green",
  failed: "bg-red-50 text-signal-red",
  stopped: "bg-ink-200 text-ink-700"
};

export function StatusPill({ status }: { status: SessionStatus }) {
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}>{status.replace("_", " ")}</span>;
}
