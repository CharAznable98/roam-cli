import type { RunnerRegistration, Session } from "@roamcli/protocol";
import { Cpu, Laptop, ShieldCheck } from "lucide-react";
import { NewSessionForm } from "./NewSessionForm";
import { StatusPill } from "./StatusPill";

type RunnerSidebarProps = {
  runners: RunnerRegistration[];
  selectedRunnerId: string;
  sessions: Session[];
  selectedSessionId: string;
  onSelectRunner: (runnerId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: Parameters<typeof NewSessionForm>[0]["onCreate"];
};

export function RunnerSidebar({
  runners,
  selectedRunnerId,
  sessions,
  selectedSessionId,
  onSelectRunner,
  onSelectSession,
  onCreateSession
}: RunnerSidebarProps) {
  const selectedRunner = runners.find((runner) => runner.runnerId === selectedRunnerId) ?? runners[0];
  const visibleSessions = sessions.filter((session) => session.runnerId === selectedRunner?.runnerId);

  if (!selectedRunner) {
    return null;
  }

  return (
    <aside className="left-column" aria-label="Runners and sessions">
      <section>
        <h2 className="panel-title">Runners</h2>
        <div className="mt-3 space-y-2">
          {runners.map((runner) => (
            <button
              key={runner.runnerId}
              type="button"
              className={`runner-button ${runner.runnerId === selectedRunnerId ? "is-selected" : ""}`}
              onClick={() => onSelectRunner(runner.runnerId)}
            >
              <span className="runner-icon">
                <Laptop size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{runner.displayName}</span>
                <span className="block truncate text-xs text-ink-500">{runner.hostname}</span>
              </span>
              <span className="profile-badge" title={`${runner.profile} profile`}>
                <ShieldCheck size={14} />
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="min-h-0 flex-1">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="panel-title">Sessions</h2>
          <span className="text-xs text-ink-500">{visibleSessions.length}</span>
        </div>
        <div className="space-y-2 overflow-auto pr-1">
          {visibleSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-button ${session.id === selectedSessionId ? "is-selected" : ""}`}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="flex items-center gap-2">
                <Cpu size={15} />
                <span className="truncate">{session.agent}</span>
              </span>
              <span className="truncate text-left font-medium">{session.title}</span>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-ink-500">{session.cwd}</span>
                <StatusPill status={session.status} />
              </span>
            </button>
          ))}
        </div>
      </section>

      <NewSessionForm runner={selectedRunner} onCreate={onCreateSession} />
    </aside>
  );
}
