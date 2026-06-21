import { ApprovalCenter } from "../features/approvals/ApprovalCenter";
import { ArtifactList } from "../features/approvals/ArtifactList";
import { ChatPanel } from "../features/conversation/ChatPanel";
import type { MarkdownFileLinkTarget } from "../features/conversation/file-links";
import { FilePanel } from "../features/files/FilePanel";
import { GitPanel } from "../features/git/GitPanel";
import { PushSettings } from "../features/pwa/PushSettings";
import type { Project, Session } from "@roamcli/shared/protocol";
import {
  FolderPlus,
  Plus,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { NewSessionForm } from "../features/sessions/NewSessionForm";
import {
  ProjectForm,
  RunnerSidebar,
  SidebarModal,
} from "../features/sessions/RunnerSidebar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BottomTabs } from "./BottomTabs";
import { workspaceTabs, type WorkspaceTab } from "./navigation";
import type { AppNotification } from "./state";
import type { useRoamController } from "./useRoamController";

type AppShellProps = {
  controller: ReturnType<typeof useRoamController>;
};

export function AppShell({ controller }: AppShellProps) {
  const [mobileProjectModalOpen, setMobileProjectModalOpen] = useState(false);
  const [mobileSessionModalOpen, setMobileSessionModalOpen] = useState(false);
  const [mobileSessionSwitcherOpen, setMobileSessionSwitcherOpen] =
    useState(false);
  const [mobileStatusModalOpen, setMobileStatusModalOpen] = useState(false);
  const {
    state,
    token,
    setToken,
    streamReconnect,
    reconnectStream,
    sessionStatusCheckState,
    checkSelectedSessionStatus,
    dispatch,
    selectedRunner,
    selectedProject,
    selectedGitContext,
    runnerSessions,
    selectedSession,
    sessionMessages,
    sessionApprovals,
    sessionHunks,
    sessionFiles,
    sessionFileTreeState,
    sessionFileTreePathState,
    runnerCommand,
    selectProject,
    createProject,
    archiveProject,
    createSession,
    renameSelectedSession,
    sendMessage,
    resolveApproval,
    resolveHunk,
    applyAcceptedPatch,
    sendControl,
    deleteSelectedSession,
    selectFile,
    loadSelectedDirectory,
    refreshSelectedFileTree,
    saveSelectedFile,
    fetchMessageAttachmentContent,
    fetchRunnerDirectoryTree,
    createRunnerDirectory,
    listAgentSkills,
    searchWorkspacePaths,
    fetchGitStatus,
    fetchGitDiff,
    fetchGitBlame,
    initGitRepository,
    stageGitPaths,
    unstageGitPaths,
    discardGitPaths,
    commitGitChanges,
    runGitRemoteOperation,
    removeGitWorktree,
  } = controller;

  const setActiveTab = useCallback(
    (tab: WorkspaceTab) => dispatch({ type: "activeTabChanged", tab }),
    [dispatch],
  );
  const setSelectedSessionId = useCallback(
    (sessionId: string) => {
      dispatch({ type: "sessionSelected", sessionId });
    },
    [dispatch],
  );
  const openMarkdownFileLink = useCallback(
    (target: MarkdownFileLinkTarget) => {
      setActiveTab("files");
      selectFile(target.path);
    },
    [selectFile, setActiveTab],
  );
  const dismissNotification = useCallback(
    (id: string) => dispatch({ type: "notificationDismissed", id }),
    [dispatch],
  );
  const activeProjects = useMemo(
    () => state.projects.filter((project) => !project.archivedAt),
    [state.projects],
  );
  const hasWorkspaceData =
    activeProjects.length > 0 ||
    state.sessions.some((session) => !session.archivedAt);
  const showNoRunnerEmpty =
    state.loadState === "ready" &&
    state.runners.length === 0 &&
    !hasWorkspaceData;
  const showApiErrorEmpty = state.loadState === "error";
  const showWorkspace =
    state.loadState === "ready" &&
    (state.runners.length > 0 || hasWorkspaceData);
  const canUseStream = state.connectionState === "open";
  const canUseSelectedRunner = canUseStream && Boolean(selectedRunner);
  const compactStatus = getCompactStatusLabel(
    state.connectionState,
    state.loadState,
    streamReconnect.mode,
  );
  const topbarContext = selectedProject
    ? selectedSession
      ? `${selectedProject.name} / ${selectedSession.title}`
      : `${selectedProject.name} / No session selected`
    : "Runner-backed coding sessions";
  const CompactStatusIcon =
    state.connectionState === "open" && state.loadState !== "error"
      ? Wifi
      : WifiOff;

  useEffect(() => {
    setMobileSessionModalOpen(false);
  }, [selectedProject?.id]);

  return (
    <div className={`app-shell active-${state.activeTab}`}>
      <header className="topbar">
        <div className="topbar-title">
          <p className="topbar-kicker">RoamCli</p>
          <h1 className="truncate text-lg font-semibold text-ink-900">
            Remote Agent Control
          </h1>
          <p className="topbar-context">{topbarContext}</p>
        </div>
        <div className="topbar-actions topbar-actions-desktop">
          <span
            className={`topbar-status ${state.connectionState === "open" ? "success" : "warning"}`}
          >
            {state.connectionState === "open"
              ? "stream connected"
              : "stream disconnected"}
          </span>
          <label className="token-field">
            <span>Token</span>
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              aria-label="API token"
            />
          </label>
          <span
            className={`topbar-status ${
              state.loadState === "error" ? "error" : "success"
            }`}
          >
            {state.loadState === "error"
              ? "API error"
              : `${state.runners.length} runners online`}
          </span>
        </div>
        <div className="mobile-topbar-actions">
          <button
            className={`compact-status-button ${compactStatus.tone}`}
            type="button"
            aria-label="Open connection settings"
            title="Connection settings"
            onClick={() => setMobileStatusModalOpen(true)}
          >
            <CompactStatusIcon size={16} />
            <span>{compactStatus.label}</span>
          </button>
        </div>
      </header>

      <NotificationStack
        notifications={state.notifications}
        onDismiss={dismissNotification}
      />

      {state.loadState === "loading" ? (
        <div className="empty-state">Loading remote RoamCli state...</div>
      ) : null}

      {showNoRunnerEmpty ? (
        <div className="empty-state">
          <div>
            <h2>No runners are online</h2>
            <p>
              The RoamCli server is connected. Start a runner to create or
              resume sessions.
            </p>
            <pre>{runnerCommand}</pre>
          </div>
        </div>
      ) : null}

      {showApiErrorEmpty ? (
        <div className="empty-state app-error-state" role="alert">
          <div>
            <h2>API connection failed</h2>
            <p>
              Check the API token or backend route, then reconnect the stream.
            </p>
            <button
              className="primary-action-button"
              type="button"
              onClick={() => setMobileStatusModalOpen(true)}
            >
              <WifiOff size={16} />
              Connection settings
            </button>
          </div>
        </div>
      ) : null}

      {showWorkspace ? (
        <>
          <nav className="tablet-tabs" aria-label="Tablet workspace tabs">
            {workspaceTabs.map((tab) => (
              <WorkspaceTabButton
                key={tab.id}
                tab={tab}
                activeTab={state.activeTab}
                onChange={setActiveTab}
              />
            ))}
          </nav>

          <main className="app-grid">
            <RunnerSidebar
              projects={state.projects}
              runners={state.runners}
              selectedProjectId={selectedProject?.id ?? ""}
              sessions={state.sessions}
              selectedSessionId={selectedSession?.id ?? ""}
              onSelectProject={selectProject}
              onSelectSession={setSelectedSessionId}
              onCreateProject={createProject}
              onFetchRunnerDirectoryTree={fetchRunnerDirectoryTree}
              onCreateRunnerDirectory={createRunnerDirectory}
              onArchiveProject={archiveProject}
              onCreateSession={createSession}
              onListAgentSkills={listAgentSkills}
              onSearchWorkspacePaths={searchWorkspacePaths}
            />
            {selectedSession ? (
              <ChatPanel
                session={selectedSession}
                messages={sessionMessages}
                onSend={sendMessage}
                onControl={sendControl}
                onRename={renameSelectedSession}
                onDelete={deleteSelectedSession}
                onCheckStatus={checkSelectedSessionStatus}
                statusCheckState={sessionStatusCheckState}
                canSend={canUseSelectedRunner}
                canControl={canUseSelectedRunner}
                onOpenSessionSwitcher={() => setMobileSessionSwitcherOpen(true)}
                onOpenFileLink={openMarkdownFileLink}
                imageCapability={selectedRunner?.capabilities.find(
                  (capability) => capability.kind === selectedSession.agent,
                )}
                onFetchAttachmentContent={fetchMessageAttachmentContent}
                onListAgentSkills={listAgentSkills}
                onSearchWorkspacePaths={searchWorkspacePaths}
              />
            ) : (
              <section className="chat-column" aria-label="Conversation">
                <div className="empty-state compact session-empty-state">
                  <span>
                    {selectedProject
                      ? "Create a session in the selected project."
                      : "Create a project to start a session."}
                  </span>
                  <p className="session-empty-meta">
                    {selectedProject
                      ? `${selectedProject.name} · ${state.runners.length} ${state.runners.length === 1 ? "runner" : "runners"} online`
                      : `${state.runners.length} ${state.runners.length === 1 ? "runner" : "runners"} online`}
                  </p>
                  <button
                    className="small-button"
                    type="button"
                    aria-label="Choose session"
                    onClick={() => setMobileSessionSwitcherOpen(true)}
                  >
                    Choose session
                  </button>
                </div>
              </section>
            )}
            <aside className="workspace-column" aria-label="Workspace tools">
              <nav className="workspace-tabs" aria-label="Tool tabs">
                {workspaceTabs
                  .filter((tab) => tab.id !== "chat")
                  .map((tab) => (
                    <WorkspaceTabButton
                      key={tab.id}
                      tab={tab}
                      activeTab={
                        state.activeTab === "chat" ? "files" : state.activeTab
                      }
                      onChange={setActiveTab}
                    />
                  ))}
              </nav>
              <div className="workspace-scroll">
                <div className="workspace-surface files-surface">
                  <FilePanel
                    files={sessionFiles}
                    treeState={sessionFileTreeState}
                    treePathStates={sessionFileTreePathState}
                    selectedPath={state.selectedFilePath}
                    fileContent={state.fileContent}
                    editorContent={state.editorContent}
                    contentState={state.fileContentState}
                    saveState={state.fileSaveState}
                    onSelectFile={selectFile}
                    onLoadDirectory={loadSelectedDirectory}
                    onRefreshTree={refreshSelectedFileTree}
                    onChangeContent={(content) =>
                      dispatch({ type: "editorContentChanged", content })
                    }
                    onSaveFile={saveSelectedFile}
                    treeId={`${selectedSession?.id ?? "none"}:${sessionFileTreeState}`}
                  />
                </div>
                <div className="workspace-surface git-surface">
                  <GitPanel
                    active={state.activeTab === "git"}
                    project={selectedProject}
                    runnerOnline={Boolean(selectedRunner)}
                    sessions={runnerSessions}
                    defaultContext={selectedGitContext}
                    onFetchStatus={fetchGitStatus}
                    onFetchDiff={fetchGitDiff}
                    onFetchBlame={fetchGitBlame}
                    onInitRepository={initGitRepository}
                    onStagePaths={stageGitPaths}
                    onUnstagePaths={unstageGitPaths}
                    onDiscardPaths={discardGitPaths}
                    onCommit={commitGitChanges}
                    onRemoteOperation={runGitRemoteOperation}
                    onRemoveWorktree={removeGitWorktree}
                  />
                </div>
                <div className="workspace-surface approvals-surface">
                  <PushSettings />
                  <ApprovalCenter
                    approvals={sessionApprovals}
                    hunks={sessionHunks}
                    onResolveApproval={resolveApproval}
                    onResolveHunk={resolveHunk}
                    onApplyPatch={applyAcceptedPatch}
                    patchApplyState={state.patchApplyState}
                  />
                  <ArtifactList
                    artifacts={state.artifacts.filter(
                      (artifact) =>
                        !selectedSession ||
                        artifact.sessionId === selectedSession.id,
                    )}
                  />
                </div>
              </div>
            </aside>
          </main>

          <BottomTabs activeTab={state.activeTab} onChange={setActiveTab} />

          {mobileSessionSwitcherOpen ? (
            <SidebarModal
              title="Switch Session"
              variant="sheet"
              onClose={() => setMobileSessionSwitcherOpen(false)}
            >
              <MobileSessionSwitcher
                activeProjects={activeProjects}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                runnerSessions={runnerSessions}
                onSelectProject={selectProject}
                onSelectSession={(sessionId) => {
                  setSelectedSessionId(sessionId);
                  setMobileSessionSwitcherOpen(false);
                }}
                onNewProject={() => {
                  setMobileSessionSwitcherOpen(false);
                  setMobileProjectModalOpen(true);
                }}
                onArchiveProject={archiveProject}
                onNewSession={() => {
                  setMobileSessionSwitcherOpen(false);
                  setMobileSessionModalOpen(true);
                }}
              />
            </SidebarModal>
          ) : null}

          {mobileProjectModalOpen ? (
            <SidebarModal
              title="New Project"
              variant="sheet"
              onClose={() => setMobileProjectModalOpen(false)}
            >
              <ProjectForm
                runners={state.runners}
                onCreate={createProject}
                onFetchRunnerDirectoryTree={fetchRunnerDirectoryTree}
                onCreateRunnerDirectory={createRunnerDirectory}
                onCreated={() => setMobileProjectModalOpen(false)}
              />
            </SidebarModal>
          ) : null}

          {mobileSessionModalOpen && selectedProject ? (
            <SidebarModal
              title={`New Session - ${selectedProject.name}`}
              variant="sheet"
              onClose={() => setMobileSessionModalOpen(false)}
            >
              {selectedRunner ? (
                <NewSessionForm
                  project={selectedProject}
                  runner={selectedRunner}
                  onListAgentSkills={listAgentSkills}
                  onSearchWorkspacePaths={searchWorkspacePaths}
                  onCreate={(values) =>
                    createSession(selectedProject.id, values)
                  }
                  onCreated={() => setMobileSessionModalOpen(false)}
                />
              ) : (
                <div className="empty-state compact">
                  The project runner is offline.
                </div>
              )}
            </SidebarModal>
          ) : null}
        </>
      ) : null}

      {mobileStatusModalOpen ? (
        <SidebarModal
          title="Connection"
          variant="sheet"
          onClose={() => setMobileStatusModalOpen(false)}
        >
          <MobileStatusSheet
            token={token}
            onTokenChange={setToken}
            connectionState={state.connectionState}
            loadState={state.loadState}
            runnerCount={state.runners.length}
            streamReconnect={streamReconnect}
            onReconnect={reconnectStream}
          />
        </SidebarModal>
      ) : null}
    </div>
  );
}

function MobileStatusSheet({
  token,
  onTokenChange,
  connectionState,
  loadState,
  runnerCount,
  streamReconnect,
  onReconnect,
}: {
  token: string;
  onTokenChange: (token: string) => void;
  connectionState: "open" | "closed" | "error";
  loadState: "loading" | "ready" | "error";
  runnerCount: number;
  streamReconnect: ReturnType<typeof useRoamController>["streamReconnect"];
  onReconnect: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!streamReconnect.nextAttemptAt) {
      return;
    }
    const interval = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(interval);
  }, [streamReconnect.nextAttemptAt]);

  const retrySeconds = streamReconnect.nextAttemptAt
    ? Math.max(0, Math.ceil((streamReconnect.nextAttemptAt - now) / 1_000))
    : undefined;

  return (
    <div className="mobile-sheet-stack">
      <label className="field">
        <span>Token</span>
        <input
          value={token}
          onChange={(event) => onTokenChange(event.target.value)}
          aria-label="Mobile API token"
        />
      </label>
      <dl className="status-details">
        <div>
          <dt>Stream</dt>
          <dd>{connectionState}</dd>
        </div>
        <div>
          <dt>API</dt>
          <dd>{loadState}</dd>
        </div>
        <div>
          <dt>Runners</dt>
          <dd>{runnerCount}</dd>
        </div>
        <div>
          <dt>Reconnect</dt>
          <dd>
            {connectionState === "open"
              ? "ready"
              : retrySeconds !== undefined
                ? `in ${retrySeconds}s`
                : streamReconnect.mode}
          </dd>
        </div>
      </dl>
      <button
        className="primary-action-button"
        type="button"
        onClick={onReconnect}
      >
        <RefreshCw size={16} />
        Reconnect now
      </button>
    </div>
  );
}

function MobileSessionSwitcher({
  activeProjects,
  selectedProject,
  selectedSession,
  runnerSessions,
  onSelectProject,
  onSelectSession,
  onNewProject,
  onArchiveProject,
  onNewSession,
}: {
  activeProjects: Project[];
  selectedProject: Project | undefined;
  selectedSession: Session | undefined;
  runnerSessions: Session[];
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewProject: () => void;
  onArchiveProject: (projectId: string) => void;
  onNewSession: () => void;
}) {
  return (
    <div className="mobile-sheet-stack">
      <div className="mobile-sheet-row">
        <label className="field">
          <span>Project</span>
          <select
            value={selectedProject?.id ?? ""}
            onChange={(event) => onSelectProject(event.target.value)}
          >
            {!selectedProject ? (
              <option value="">
                {activeProjects.length === 0
                  ? "No projects"
                  : "No project selected"}
              </option>
            ) : null}
            {activeProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <div className="mobile-sheet-actions">
          <button
            className="primary-icon-button"
            type="button"
            aria-label="New project"
            title="New project"
            onClick={onNewProject}
          >
            <FolderPlus size={16} />
          </button>
          {selectedProject ? (
            <button
              className="mobile-icon-button danger"
              type="button"
              aria-label={`Archive selected project ${selectedProject.name}`}
              title="Archive project"
              onClick={() => onArchiveProject(selectedProject.id)}
            >
              <Trash2 size={15} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="mobile-sheet-row">
        <label className="field">
          <span>Session</span>
          <select
            value={selectedSession?.id ?? ""}
            disabled={!selectedProject || runnerSessions.length === 0}
            onChange={(event) => onSelectSession(event.target.value)}
          >
            {!selectedProject || runnerSessions.length === 0 ? (
              <option value="">No sessions</option>
            ) : null}
            {runnerSessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
        </label>
        <div className="mobile-sheet-actions">
          <button
            className="primary-icon-button"
            type="button"
            aria-label={
              selectedProject
                ? `New session in selected project ${selectedProject.name}`
                : "New session"
            }
            title="New session"
            disabled={!selectedProject}
            onClick={onNewSession}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function NotificationStack({
  notifications,
  onDismiss,
}: {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
}) {
  const timersRef = useRef(
    new Map<string, ReturnType<typeof globalThis.setTimeout>>(),
  );

  useEffect(() => {
    const visibleIds = new Set(
      notifications.map((notification) => notification.id),
    );
    for (const [id, timer] of timersRef.current) {
      if (!visibleIds.has(id)) {
        globalThis.clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }

    for (const notification of notifications) {
      if (timersRef.current.has(notification.id)) {
        continue;
      }
      const timer = globalThis.setTimeout(() => {
        timersRef.current.delete(notification.id);
        onDismiss(notification.id);
      }, 6_000);
      timersRef.current.set(notification.id, timer);
    }
  }, [notifications, onDismiss]);

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        globalThis.clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, []);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className="notification-stack" aria-live="polite">
      {notifications.map((notification) => (
        <article
          key={notification.id}
          className={`notification-card ${notification.tone}`}
        >
          <div>
            <strong>{notification.title}</strong>
            <p>{notification.message}</p>
          </div>
          <button
            className="notification-close"
            type="button"
            aria-label={`Dismiss notification: ${notification.title}`}
            title="Dismiss notification"
            onClick={() => onDismiss(notification.id)}
          >
            <X size={15} />
          </button>
        </article>
      ))}
    </div>
  );
}

function getCompactStatusLabel(
  connectionState: "open" | "closed" | "error",
  loadState: "loading" | "ready" | "error",
  reconnectMode: "connecting" | "connected" | "waiting",
) {
  if (loadState === "error") {
    return { label: "API error", tone: "error" };
  }
  if (connectionState === "open") {
    return { label: "Online", tone: "open" };
  }
  if (reconnectMode === "waiting" || reconnectMode === "connecting") {
    return { label: "Retrying", tone: "warning" };
  }
  return { label: "Offline", tone: "warning" };
}

function WorkspaceTabButton({
  tab,
  activeTab,
  onChange,
}: {
  tab: (typeof workspaceTabs)[number];
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      className={activeTab === tab.id ? "is-active" : ""}
      onClick={() => onChange(tab.id)}
    >
      <Icon size={16} />
      <span>{tab.label}</span>
    </button>
  );
}
