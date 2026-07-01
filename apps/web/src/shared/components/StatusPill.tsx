import type { SessionStatus } from "@roamcli/shared/protocol";

const styles: Record<SessionStatus, string> = {
  pending: "bg-ink-100 text-ink-700",
  running: "bg-cyan-50 text-signal-cyan",
  waiting_approval: "bg-amber-50 text-signal-amber",
  waiting_input: "bg-cyan-50 text-signal-cyan",
  completed: "bg-emerald-50 text-signal-green",
  failed: "bg-red-50 text-signal-red",
  stopped: "bg-ink-200 text-ink-700",
};

const labels: Record<SessionStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting_approval: "Waiting approval",
  waiting_input: "Waiting input",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

export function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}
