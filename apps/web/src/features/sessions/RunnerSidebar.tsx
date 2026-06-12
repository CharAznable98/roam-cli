import type { Project, RunnerRegistration, Session } from "@roamcli/protocol";
import { Cpu, Folder, Laptop, Plus } from "lucide-react";
import { FormEvent, useState } from "react";
import { NewSessionForm } from "./NewSessionForm";
import { StatusPill } from "../../shared/components/StatusPill";

type RunnerSidebarProps = {
  projects: Project[];
  runners: RunnerRegistration[];
  selectedProjectId: string;
  sessions: Session[];
  selectedSessionId: string;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCreateProject: (values: { name: string; runnerId: string; directory: string }) => void;
  onCreateSession: Parameters<typeof NewSessionForm>[0]["onCreate"];
};

export function RunnerSidebar({
  projects,
  runners,
  selectedProjectId,
  sessions,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
  onCreateProject,
  onCreateSession
}: RunnerSidebarProps) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const selectedRunner = selectedProject
    ? runners.find((runner) => runner.runnerId === selectedProject.runnerId)
    : undefined;
  const visibleSessions = sessions.filter((session) => session.projectId === selectedProject?.id && !session.archivedAt);

  return (
    <aside className="left-column" aria-label="Projects and sessions">
      <section className="sidebar-runners">
        <h2 className="panel-title">Projects</h2>
        <div className="mt-3 space-y-2">
          {projects.map((project) => {
            const runner = runners.find((item) => item.runnerId === project.runnerId);
            return (
            <button
              key={project.id}
              type="button"
              className={`runner-button ${project.id === selectedProject?.id ? "is-selected" : ""}`}
              onClick={() => onSelectProject(project.id)}
            >
              <span className="runner-icon">
                <Folder size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{project.name}</span>
                <span className="block truncate text-xs text-ink-500">{project.directory}</span>
              </span>
              {runner ? (
                <span className="profile-badge" title={`${runner.displayName} runner`}>
                  <Laptop size={14} />
                </span>
              ) : null}
            </button>
            );
          })}
          {projects.length === 0 ? <div className="empty-state compact">Create a project to start a session.</div> : null}
        </div>
      </section>

      <ProjectForm runners={runners} onCreate={onCreateProject} />

      {selectedProject ? <section className="sidebar-sessions">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="panel-title">Sessions</h2>
          <span className="text-xs text-ink-500">{visibleSessions.length}</span>
        </div>
        <div className="sidebar-session-list">
          {visibleSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-button ${session.id === selectedSessionId ? "is-selected" : ""}`}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="session-agent-row">
                <Cpu size={15} />
                <span className="truncate">{session.agent}</span>
              </span>
              <span className="truncate text-left font-medium">{session.title}</span>
              <span className="session-meta-row">
                <span className="truncate text-xs text-ink-500">{session.executionMode} · {session.executionFolder}</span>
                <StatusPill status={session.status} />
              </span>
            </button>
          ))}
        </div>
      </section> : null}

      {selectedProject && selectedRunner ? <NewSessionForm project={selectedProject} runner={selectedRunner} onCreate={onCreateSession} /> : null}
    </aside>
  );
}

function ProjectForm({
  runners,
  onCreate,
}: {
  runners: RunnerRegistration[];
  onCreate: (values: { name: string; runnerId: string; directory: string }) => void;
}) {
  const [name, setName] = useState("");
  const [runnerId, setRunnerId] = useState(runners[0]?.runnerId ?? "");
  const [directory, setDirectory] = useState(runners[0]?.workspaceRoot ?? "");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanDirectory = directory.trim();
    const cleanRunnerId = runnerId || runners[0]?.runnerId || "";
    if (!cleanRunnerId || !cleanDirectory) return;
    onCreate({
      name: name.trim() || cleanDirectory.split("/").filter(Boolean).at(-1) || cleanDirectory,
      runnerId: cleanRunnerId,
      directory: cleanDirectory,
    });
    setName("");
  };

  return (
    <form className="sidebar-project-form" onSubmit={submit}>
      <div className="flex items-center justify-between">
        <h2 className="panel-title">New Project</h2>
        <button className="primary-icon-button" type="submit" aria-label="Create project" title="Create project">
          <Plus size={16} />
        </button>
      </div>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional project name" />
      </label>
      <label className="field">
        <span>Runner</span>
        <select
          value={runnerId}
          onChange={(event) => {
            const next = event.target.value;
            setRunnerId(next);
            setDirectory(runners.find((runner) => runner.runnerId === next)?.workspaceRoot ?? "");
          }}
        >
          {runners.map((runner) => (
            <option key={runner.runnerId} value={runner.runnerId}>
              {runner.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Directory</span>
        <input value={directory} onChange={(event) => setDirectory(event.target.value)} />
      </label>
    </form>
  );
}
