import type { RunnerRegistration, Session } from "@roamcli/protocol";

export function getSelectedRunner(
  runners: RunnerRegistration[],
  selectedRunnerId: string,
): RunnerRegistration | undefined {
  return (
    runners.find((runner) => runner.runnerId === selectedRunnerId) ??
    runners[0]
  );
}

export function getRunnerSessions(
  sessions: Session[],
  runnerId: string | undefined,
): Session[] {
  return sessions.filter((session) => session.runnerId === runnerId);
}

export function getSelectedSession(
  sessions: Session[],
  runnerSessions: Session[],
  selectedSessionId: string,
): Session | undefined {
  return (
    sessions.find((session) => session.id === selectedSessionId) ??
    runnerSessions[0] ??
    sessions[0]
  );
}
