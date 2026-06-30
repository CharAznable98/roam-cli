import type {
  Project,
  RunnerRegistration,
  Session,
} from "@roamcli/shared/protocol";

export function getSelectedProject(
  projects: Project[],
  selectedProjectId: string,
): Project | undefined {
  return selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId)
    : undefined;
}

export function getSelectedRunner(
  runners: RunnerRegistration[],
  selectedRunnerId: string,
): RunnerRegistration | undefined {
  return (
    runners.find((runner) => runner.runnerId === selectedRunnerId) ?? runners[0]
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
  _sessions: Session[],
  visibleSessions: Session[],
  selectedSessionId: string,
): Session | undefined {
  return (
    visibleSessions.find(
      (session) => session.id === selectedSessionId && !session.archivedAt,
    ) ?? visibleSessions[0]
  );
}

export function sortProjectsForDisplay(projects: Project[]): Project[] {
  return [...projects].sort(compareProjectsForDisplay);
}

export function sortSessionsForDisplay(sessions: Session[]): Session[] {
  return [...sessions].sort(compareSessionsForDisplay);
}

export function compareProjectsForDisplay(
  left: Project,
  right: Project,
): number {
  return (
    comparePinnedAt(left.pinnedAt, right.pinnedAt) ||
    compareIsoDesc(left.lastActiveAt, right.lastActiveAt) ||
    compareIsoDesc(left.createdAt, right.createdAt)
  );
}

export function compareSessionsForDisplay(
  left: Session,
  right: Session,
): number {
  return (
    comparePinnedAt(left.pinnedAt, right.pinnedAt) ||
    compareIsoDesc(left.createdAt, right.createdAt)
  );
}

function comparePinnedAt(left: string | undefined, right: string | undefined) {
  if (left && right) {
    return compareIsoDesc(left, right);
  }
  if (left) {
    return -1;
  }
  if (right) {
    return 1;
  }
  return 0;
}

function compareIsoDesc(left: string, right: string): number {
  return right.localeCompare(left);
}
