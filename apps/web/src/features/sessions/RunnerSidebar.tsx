import type { Project, RunnerRegistration, Session } from "@roamcli/shared/protocol";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Folder,
  FolderPlus,
  Laptop,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { FormEvent, useMemo, useState, type ReactNode } from "react";
import { NewSessionForm, type NewSessionValues } from "./NewSessionForm";
import { StatusPill } from "../../shared/components/StatusPill";

type RunnerSidebarProps = {
  projects: Project[];
  runners: RunnerRegistration[];
  selectedProjectId: string;
  sessions: Session[];
  selectedSessionId: string;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCreateProject: (values: {
    name: string;
    runnerId: string;
    directory: string;
  }) => void | Promise<void>;
  onArchiveProject: (projectId: string) => void;
  onCreateSession: (
    projectId: string,
    values: NewSessionValues,
  ) => void | Promise<void>;
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
  onArchiveProject,
  onCreateSession,
}: RunnerSidebarProps) {
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [sessionProjectId, setSessionProjectId] = useState<
    string | undefined
  >();
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archivedAt),
    [projects],
  );
  const sessionProject = activeProjects.find(
    (project) => project.id === sessionProjectId,
  );
  const sessionRunner = sessionProject
    ? runners.find((runner) => runner.runnerId === sessionProject.runnerId)
    : undefined;

  const toggleProject = (projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  return (
    <aside className="left-column" aria-label="Projects and sessions">
      <section className="sidebar-tree">
        <div className="sidebar-tree-header">
          <h2 className="panel-title">Projects</h2>
          <button
            className="primary-icon-button"
            type="button"
            aria-label="New project"
            title="New project"
            onClick={() => setProjectModalOpen(true)}
          >
            <FolderPlus size={16} />
          </button>
        </div>
        <div className="project-tree">
          {activeProjects.map((project) => {
            const runner = runners.find(
              (item) => item.runnerId === project.runnerId,
            );
            const projectSessions = sessions.filter(
              (session) =>
                session.projectId === project.id && !session.archivedAt,
            );
            const isExpanded = expandedProjectIds.has(project.id);
            return (
              <div className="project-tree-item" key={project.id}>
                <div
                  className={`project-tree-row ${project.id === selectedProjectId ? "is-selected" : ""}`}
                >
                  <button
                    className="tree-toggle-button"
                    type="button"
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} project ${project.name}`}
                    title={isExpanded ? "Collapse project" : "Expand project"}
                    onClick={() => toggleProject(project.id)}
                  >
                    {isExpanded ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="tree-project-button"
                    onClick={() => onSelectProject(project.id)}
                  >
                    <span className="runner-icon">
                      <Folder size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {project.name}
                      </span>
                      <span className="block truncate text-xs text-ink-500">
                        {project.directory}
                      </span>
                    </span>
                    {runner ? (
                      <span
                        className="profile-badge"
                        title={`${runner.displayName} runner`}
                      >
                        <Laptop size={14} />
                      </span>
                    ) : null}
                  </button>
                  <div className="tree-row-actions">
                    <button
                      className="tree-action-button"
                      type="button"
                      aria-label={`New session in ${project.name}`}
                      title="New session"
                      onClick={() => setSessionProjectId(project.id)}
                    >
                      <Plus size={15} />
                    </button>
                    <button
                      className="tree-action-button danger"
                      type="button"
                      aria-label={`Archive project ${project.name}`}
                      title="Archive project"
                      onClick={() => onArchiveProject(project.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                {isExpanded ? (
                  <div
                    className="tree-session-list"
                    role="group"
                    aria-label={`${project.name} sessions`}
                  >
                    {projectSessions.length > 0 ? (
                      projectSessions.map((session) => (
                        <button
                          key={session.id}
                          type="button"
                          className={`session-button tree-session-button ${session.id === selectedSessionId ? "is-selected" : ""}`}
                          onClick={() => onSelectSession(session.id)}
                        >
                          <span className="session-agent-row">
                            <Cpu size={15} />
                            <span className="truncate">{session.agent}</span>
                          </span>
                          <span className="truncate text-left font-medium">
                            {session.title}
                          </span>
                          <span className="session-meta-row">
                            <span className="truncate text-xs text-ink-500">
                              {session.executionMode} ·{" "}
                              {session.executionFolder}
                            </span>
                            <StatusPill status={session.status} />
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="empty-state compact tree-empty-state">
                        No sessions
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
          {activeProjects.length === 0 ? (
            <div className="empty-state compact">
              Create a project to start a session.
            </div>
          ) : null}
        </div>
      </section>

      {projectModalOpen ? (
        <SidebarModal
          title="New Project"
          onClose={() => setProjectModalOpen(false)}
        >
          <ProjectForm
            runners={runners}
            onCreate={onCreateProject}
            onCreated={() => setProjectModalOpen(false)}
          />
        </SidebarModal>
      ) : null}

      {sessionProject ? (
        <SidebarModal
          title={`New Session - ${sessionProject.name}`}
          onClose={() => setSessionProjectId(undefined)}
        >
          {sessionRunner ? (
            <NewSessionForm
              project={sessionProject}
              runner={sessionRunner}
              onCreate={async (values) => {
                await onCreateSession(sessionProject.id, values);
                setExpandedProjectIds((current) => {
                  const next = new Set(current);
                  next.add(sessionProject.id);
                  return next;
                });
              }}
              onCreated={() => setSessionProjectId(undefined)}
            />
          ) : (
            <div className="empty-state compact">
              The project runner is offline.
            </div>
          )}
        </SidebarModal>
      ) : null}
    </aside>
  );
}

export function SidebarModal({
  title,
  children,
  onClose,
  variant = "panel",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  variant?: "panel" | "sheet";
}) {
  return (
    <div
      className={`modal-backdrop ${variant === "sheet" ? "sheet-backdrop" : ""}`}
    >
      <section
        className={`modal-panel ${variant === "sheet" ? "modal-sheet" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2 className="panel-title">{title}</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close modal"
            title="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function ProjectForm({
  runners,
  onCreate,
  onCreated,
}: {
  runners: RunnerRegistration[];
  onCreate: (values: {
    name: string;
    runnerId: string;
    directory: string;
  }) => void | Promise<void>;
  onCreated?: () => void;
}) {
  const [name, setName] = useState("");
  const [runnerId, setRunnerId] = useState(runners[0]?.runnerId ?? "");
  const [directory, setDirectory] = useState(runners[0]?.workspaceRoot ?? "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanDirectory = directory.trim();
    const cleanRunnerId = runnerId || runners[0]?.runnerId || "";
    if (!cleanRunnerId) {
      setError("Choose an online runner before creating a project.");
      return;
    }
    if (!cleanDirectory) {
      setError("Directory is required.");
      return;
    }
    setSubmitting(true);
    try {
      await onCreate({
        name:
          name.trim() ||
          cleanDirectory.split("/").filter(Boolean).at(-1) ||
          cleanDirectory,
        runnerId: cleanRunnerId,
        directory: cleanDirectory,
      });
      setName("");
      setError("");
      onCreated?.();
    } catch (createError: unknown) {
      setError(errorMessage(createError, "Project was not created."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="sidebar-project-form" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Optional project name"
        />
      </label>
      <label className="field">
        <span>Runner</span>
        <select
          value={runnerId}
          onChange={(event) => {
            const next = event.target.value;
            setRunnerId(next);
            setDirectory(
              runners.find((runner) => runner.runnerId === next)
                ?.workspaceRoot ?? "",
            );
            setError("");
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
        <input
          value={directory}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setDirectory(event.target.value);
            setError("");
          }}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          className="primary-action-button"
          type="submit"
          title="Create project"
          disabled={submitting}
        >
          <FolderPlus size={16} />
          <span>{submitting ? "Creating project..." : "Create project"}</span>
        </button>
      </div>
    </form>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
