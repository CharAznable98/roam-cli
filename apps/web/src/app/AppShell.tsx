import { ApprovalCenter } from "../features/approvals/ApprovalCenter";
import { ArtifactList } from "../features/approvals/ArtifactList";
import { ChatPanel } from "../features/conversation/ChatPanel";
import { FilePanel } from "../features/files/FilePanel";
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
import { useCallback, useEffect, useMemo, useState } from "react";
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
    dispatch,
    selectedRunner,
    selectedProject,
    runnerSessions,
    selectedSession,
    sessionMessages,
    sessionApprovals,
    sessionHunks,
    sessionFiles,
    sessionFileTreeState,
    runnerCommand,
    selectProject,
    createProject,
    archiveProject,
    createSession,
    sendMessage,
    resolveApproval,
    resolveHunk,
    applyAcceptedPatch,
    sendControl,
    deleteSelectedSession,
    selectFile,
    saveSelectedFile,
  } = controller;

  const setActiveTab = (tab: WorkspaceTab) =>
    dispatch({ type: "activeTabChanged", tab });
  const setSelectedSessionId = (sessionId: string) =>
    dispatch({ type: "sessionSelected", sessionId });
  const dismissNotification = useCallback(
    (id: string) => dispatch({ type: "notificationDismissed", id }),
    [dispatch],
  );
  const activeProjects = useMemo(
    () => state.projects.filter((project) => !project.archivedAt),
    [state.projects],
  );
  const canUseStream = state.connectionState === "open";
  const compactStatus = getCompactStatusLabel(
    state.connectionState,
    state.loadState,
    streamReconnect.mode,
  );
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
          <p className="text-xs font-medium uppercase text-ink-500">RoamCli</p>
          <h1 className="truncate text-lg font-semibold text-ink-900">
            Remote Agent Control
          </h1>
        </div>
        <div className="topbar-actions topbar-actions-desktop">
          <span
            className={`rounded px-2 py-1 text-xs font-medium ${state.connectionState === "open" ? "bg-emerald-50 text-signal-green" : "bg-amber-50 text-signal-amber"}`}
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
            className={`rounded px-2 py-1 text-xs font-medium ${
              state.loadState === "error"
                ? "bg-red-50 text-signal-red"
                : "bg-emerald-50 text-signal-green"
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

      {state.loadState === "ready" && state.runners.length === 0 ? (
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

      {state.loadState === "ready" && state.runners.length > 0 ? (
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
              onArchiveProject={archiveProject}
              onCreateSession={createSession}
            />
            {selectedSession ? (
              <ChatPanel
                session={selectedSession}
                messages={sessionMessages}
                onSend={sendMessage}
                onControl={sendControl}
                onDelete={deleteSelectedSession}
                canSend={canUseStream}
                canControl={canUseStream}
                onOpenSessionSwitcher={() => setMobileSessionSwitcherOpen(true)}
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
                    aria-label="Switch Session"
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
                    selectedPath={state.selectedFilePath}
                    fileContent={state.fileContent}
                    editorContent={state.editorContent}
                    contentState={state.fileContentState}
                    saveState={state.fileSaveState}
                    onSelectFile={selectFile}
                    onChangeContent={(content) =>
                      dispatch({ type: "editorContentChanged", content })
                    }
                    onSaveFile={saveSelectedFile}
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
  useEffect(() => {
    if (notifications.length === 0) {
      return;
    }
    const timers = notifications.map((notification) =>
      globalThis.setTimeout(() => onDismiss(notification.id), 6_000),
    );
    return () => {
      timers.forEach((timer) => globalThis.clearTimeout(timer));
    };
  }, [notifications, onDismiss]);

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
