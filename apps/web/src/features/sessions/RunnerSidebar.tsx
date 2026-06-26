import type {
  ApiGitContext,
  DirectoryCreateResult,
  FileNode,
  GitBranchList,
  GitStatusResult,
  Project,
  ProjectPromptPreset,
  RunnerRegistration,
  Session,
} from "@roamcli/shared/protocol";
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
import {
  FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { NewSessionForm, type NewSessionValues } from "./NewSessionForm";
import type {
  AgentSkillFetcher,
  PathSearchFetcher,
} from "../conversation/prompt-resources";
import type { AsyncState } from "../../shared/types/async";
import {
  composeProjectDirectory,
  projectDirectoryName,
} from "./project-directory";
import { StatusPill } from "../../shared/components/StatusPill";
import { LazyFileTree, type TreePathStates } from "../files/LazyFileTree";
import {
  isTreeDirectoryLoaded,
  replaceTreeChildren,
  upsertTreeChild,
} from "../files/tree-model";

type FetchRunnerDirectoryTree = (
  runnerId: string,
  options?: { path?: string; depth?: number },
) => Promise<FileNode[]>;

type CreateRunnerDirectory = (
  runnerId: string,
  input: { parentPath: string; name: string },
) => Promise<DirectoryCreateResult>;

type GitStatusFetcher = (context: ApiGitContext) => Promise<GitStatusResult>;
type GitBranchesFetcher = (context: ApiGitContext) => Promise<GitBranchList>;

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
  onFetchRunnerDirectoryTree: FetchRunnerDirectoryTree;
  onCreateRunnerDirectory: CreateRunnerDirectory;
  onArchiveProject: (projectId: string) => void;
  onCreateSession: (
    projectId: string,
    values: NewSessionValues,
  ) => void | Promise<void>;
  onListAgentSkills: AgentSkillFetcher;
  onSearchWorkspacePaths: PathSearchFetcher;
  promptPresetsByProject?: Record<string, ProjectPromptPreset[]>;
  promptPresetStates?: Record<string, AsyncState>;
  promptPresetErrorsByProject?: Record<string, string>;
  onRefreshPromptPresets?:
    | ((projectId: string) => Promise<ProjectPromptPreset[]>)
    | undefined;
  onManagePromptPresets?: ((projectId: string) => void) | undefined;
  onFetchGitStatus: GitStatusFetcher;
  onFetchGitBranches: GitBranchesFetcher;
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
  onFetchRunnerDirectoryTree,
  onCreateRunnerDirectory,
  onArchiveProject,
  onCreateSession,
  onListAgentSkills,
  onSearchWorkspacePaths,
  promptPresetsByProject = {},
  promptPresetStates = {},
  promptPresetErrorsByProject = {},
  onRefreshPromptPresets,
  onManagePromptPresets,
  onFetchGitStatus,
  onFetchGitBranches,
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
            onFetchRunnerDirectoryTree={onFetchRunnerDirectoryTree}
            onCreateRunnerDirectory={onCreateRunnerDirectory}
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
              onListAgentSkills={onListAgentSkills}
              onSearchWorkspacePaths={onSearchWorkspacePaths}
              promptPresets={promptPresetsByProject[sessionProject.id] ?? []}
              promptPresetState={
                promptPresetStates[sessionProject.id] ?? "idle"
              }
              promptPresetError={promptPresetErrorsByProject[sessionProject.id]}
              onRefreshPromptPresets={
                onRefreshPromptPresets
                  ? () => onRefreshPromptPresets(sessionProject.id)
                  : undefined
              }
              onManagePromptPresets={
                onManagePromptPresets
                  ? () => {
                      setSessionProjectId(undefined);
                      onManagePromptPresets(sessionProject.id);
                    }
                  : undefined
              }
              onFetchGitStatus={onFetchGitStatus}
              onFetchGitBranches={onFetchGitBranches}
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
  onFetchRunnerDirectoryTree,
  onCreateRunnerDirectory,
  onCreated,
}: {
  runners: RunnerRegistration[];
  onCreate: (values: {
    name: string;
    runnerId: string;
    directory: string;
  }) => void | Promise<void>;
  onFetchRunnerDirectoryTree: FetchRunnerDirectoryTree;
  onCreateRunnerDirectory: CreateRunnerDirectory;
  onCreated?: () => void;
}) {
  const directoryLabelId = useId();
  const [name, setName] = useState("");
  const [runnerId, setRunnerId] = useState(runners[0]?.runnerId ?? "");
  const [directorySuffix, setDirectorySuffix] = useState("");
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const selectedRunner =
    runners.find((runner) => runner.runnerId === runnerId) ?? runners[0];
  const runnerBaseDirectory = selectedRunner?.workspaceRoot ?? "";
  const directoryValue = selectedRunner
    ? composeProjectDirectory(runnerBaseDirectory, directorySuffix)
    : "";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanRunnerId = runnerId || runners[0]?.runnerId || "";
    const runner = runners.find((item) => item.runnerId === cleanRunnerId);
    if (!cleanRunnerId || !runner) {
      setError("Choose an online runner before creating a project.");
      return;
    }

    let cleanDirectory: string;
    try {
      cleanDirectory = composeProjectDirectory(
        runner.workspaceRoot,
        directorySuffix,
      );
    } catch (directoryError: unknown) {
      setError(errorMessage(directoryError, "Directory is invalid."));
      return;
    }

    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim() || projectDirectoryName(cleanDirectory),
        runnerId: cleanRunnerId,
        directory: cleanDirectory,
      });
      setName("");
      setDirectorySuffix("");
      setError("");
      onCreated?.();
    } catch (createError: unknown) {
      setError(errorMessage(createError, "Project was not created."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
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
              setDirectorySuffix("");
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
        <div className="field">
          <span id={directoryLabelId}>Directory</span>
          <button
            className="directory-select-button"
            type="button"
            aria-labelledby={directoryLabelId}
            disabled={!selectedRunner}
            onClick={() => setDirectoryPickerOpen(true)}
          >
            <span className="truncate">
              {directoryValue || "Choose a directory"}
            </span>
            <Folder size={15} />
          </button>
        </div>
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
      {directoryPickerOpen && selectedRunner ? (
        <DirectoryPickerModal
          runner={selectedRunner}
          selectedPath={directorySuffix || "."}
          onFetchRunnerDirectoryTree={onFetchRunnerDirectoryTree}
          onCreateRunnerDirectory={onCreateRunnerDirectory}
          onChoose={(path) => {
            setDirectorySuffix(path === "." ? "" : path);
            setError("");
            setDirectoryPickerOpen(false);
          }}
          onClose={() => setDirectoryPickerOpen(false)}
        />
      ) : null}
    </>
  );
}

function DirectoryPickerModal({
  runner,
  selectedPath,
  onFetchRunnerDirectoryTree,
  onCreateRunnerDirectory,
  onChoose,
  onClose,
}: {
  runner: RunnerRegistration;
  selectedPath: string;
  onFetchRunnerDirectoryTree: FetchRunnerDirectoryTree;
  onCreateRunnerDirectory: CreateRunnerDirectory;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [pathStates, setPathStates] = useState<TreePathStates>({});
  const [draftPath, setDraftPath] = useState(selectedPath || ".");
  const [folderName, setFolderName] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const activeLoadRequestsRef = useRef<Record<string, number>>({});
  const nextLoadRequestIdRef = useRef(0);
  const hiddenDirectoryPaths = useMemo(
    () => runtimeDirectoryPaths(runner),
    [runner],
  );
  const displayDirectory = composeProjectDirectory(
    runner.workspaceRoot,
    draftPath === "." ? "" : draftPath,
  );

  const loadDirectory = (path: string, options: { force?: boolean } = {}) => {
    if (!options.force && pathStates[path] === "ready") {
      return;
    }
    const requestId = ++nextLoadRequestIdRef.current;
    activeLoadRequestsRef.current[path] = requestId;
    setPathStates((current) => ({ ...current, [path]: "loading" }));
    void onFetchRunnerDirectoryTree(runner.runnerId, { path, depth: 1 })
      .then((children) => {
        if (activeLoadRequestsRef.current[path] !== requestId) {
          return;
        }
        setNodes((current) =>
          replaceTreeChildren(
            current,
            path,
            filterPickerNodes(children, hiddenDirectoryPaths),
          ),
        );
        setPathStates((current) => ({ ...current, [path]: "ready" }));
      })
      .catch((loadError: unknown) => {
        if (activeLoadRequestsRef.current[path] !== requestId) {
          return;
        }
        setPathStates((current) => ({ ...current, [path]: "error" }));
        setError(errorMessage(loadError, "Directory could not be loaded."));
      });
  };

  useEffect(() => {
    activeLoadRequestsRef.current = {};
    setNodes([]);
    setPathStates({});
    setDraftPath(selectedPath || ".");
    loadDirectory(".", { force: true });
    // The modal is remounted when the runner changes; this effect initializes its tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.runnerId, selectedPath]);

  const createFolder = async () => {
    const cleanName = folderName.trim();
    const validation = validateFolderName(
      cleanName,
      draftPath,
      hiddenDirectoryPaths,
    );
    if (validation) {
      setError(validation);
      return;
    }
    setCreating(true);
    const parentPath = draftPath;
    const parentLoaded =
      parentPath === "."
        ? pathStates[parentPath] === "ready"
        : isTreeDirectoryLoaded(nodes, parentPath);
    try {
      const result = await onCreateRunnerDirectory(runner.runnerId, {
        parentPath,
        name: cleanName,
      });
      if (parentLoaded) {
        setNodes((current) =>
          shouldShowPickerNode(result.node, hiddenDirectoryPaths)
            ? upsertTreeChild(current, parentPath, result.node)
            : current,
        );
      } else {
        loadDirectory(parentPath, { force: true });
      }
      setPathStates((current) => ({
        ...current,
        ...(parentLoaded ? { [parentPath]: "ready" as const } : {}),
        [result.path]: "ready",
      }));
      setDraftPath(result.path);
      setFolderName("");
      setError("");
    } catch (createError: unknown) {
      setError(errorMessage(createError, "Directory was not created."));
    } finally {
      setCreating(false);
    }
  };

  return (
    <SidebarModal title="Choose directory" onClose={onClose}>
      <div className="directory-picker">
        <div className="directory-picker-current">
          <span>{runner.displayName}</span>
          <strong>{displayDirectory}</strong>
        </div>
        <div className="directory-picker-tree" role="tree">
          <button
            className={`tree-row ${draftPath === "." ? "is-selected" : ""}`}
            type="button"
            role="treeitem"
            aria-expanded
            onClick={() => setDraftPath(".")}
          >
            <Folder size={15} />
            <span className="truncate">{runner.workspaceRoot}</span>
          </button>
          <LazyFileTree
            nodes={nodes}
            selectedDirectoryPath={draftPath}
            pathStates={pathStates}
            onSelectDirectory={setDraftPath}
            onLoadDirectory={loadDirectory}
            resetKey={runner.runnerId}
          />
        </div>
        <form
          className="directory-create-row"
          onSubmit={(event) => {
            event.preventDefault();
            void createFolder();
          }}
        >
          <input
            value={folderName}
            aria-label="New folder name"
            placeholder="New folder"
            onChange={(event) => {
              setFolderName(event.target.value);
              setError("");
            }}
          />
          <button className="small-button" type="submit" disabled={creating}>
            <FolderPlus size={15} />
            <span>{creating ? "Creating..." : "New folder"}</span>
          </button>
        </form>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="form-actions">
          <button className="small-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-action-button"
            type="button"
            onClick={() => onChoose(draftPath)}
          >
            <Folder size={16} />
            <span>Choose</span>
          </button>
        </div>
      </div>
    </SidebarModal>
  );
}

function filterPickerNodes(
  nodes: FileNode[],
  hiddenDirectoryPaths: Set<string>,
): FileNode[] {
  return nodes
    .filter((node) => shouldShowPickerNode(node, hiddenDirectoryPaths))
    .map((node) =>
      node.children
        ? {
            ...node,
            children: filterPickerNodes(node.children, hiddenDirectoryPaths),
          }
        : node,
    );
}

function shouldShowPickerNode(
  node: FileNode,
  hiddenDirectoryPaths: Set<string>,
): boolean {
  return !hiddenDirectoryPaths.has(normalizePickerPath(node.path));
}

function validateFolderName(
  name: string,
  parentPath: string,
  hiddenDirectoryPaths: Set<string>,
): string | undefined {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    return "Folder name must be a single directory name.";
  }
  if (hiddenDirectoryPaths.has(childPickerPath(parentPath, name))) {
    return "Folder name is reserved for RoamCli runtime data.";
  }
  return undefined;
}

function runtimeDirectoryPaths(runner: RunnerRegistration): Set<string> {
  return new Set([normalizePickerPath(runner.dataDir ?? ".roam-runner")]);
}

function childPickerPath(parentPath: string, childName: string): string {
  return normalizePickerPath(
    parentPath === "." ? childName : `${parentPath}/${childName}`,
  );
}

function normalizePickerPath(path: string): string {
  const normalized = path
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
  return normalized || ".";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
