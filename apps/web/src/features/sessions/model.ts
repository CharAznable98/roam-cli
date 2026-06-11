import type { Project, RunnerRegistration, Session } from "@roamcli/protocol";

export function getSelectedProject(
  projects: Project[],
  selectedProjectId: string,
): Project | undefined {
  return (
    projects.find((project) => project.id === selectedProjectId) ??
    projects[0]
  );
}

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

export function getProjectSessions(
  sessions: Session[],
  projectId: string | undefined,
): Session[] {
  return sessions.filter(
    (session) => session.projectId === projectId && !session.archivedAt,
  );
}

export function getSelectedSession(
  sessions: Session[],
  visibleSessions: Session[],
  selectedSessionId: string,
): Session | undefined {
  return (
    sessions.find(
      (session) => session.id === selectedSessionId && !session.archivedAt,
    ) ??
    visibleSessions[0] ??
    sessions.find((session) => !session.archivedAt)
  );
}
