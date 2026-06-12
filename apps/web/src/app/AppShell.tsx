import { ApprovalCenter } from "../features/approvals/ApprovalCenter";
import { ArtifactList } from "../features/approvals/ArtifactList";
import { ChatPanel } from "../features/conversation/ChatPanel";
import { FilePanel } from "../features/files/FilePanel";
import { PushSettings } from "../features/pwa/PushSettings";
import { FolderPlus, Plus, Trash2 } from "lucide-react";
import { NewSessionForm } from "../features/sessions/NewSessionForm";
import {
  ProjectForm,
  RunnerSidebar,
  SidebarModal,
} from "../features/sessions/RunnerSidebar";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { useMemo, useState } from "react";
import { BottomTabs } from "./BottomTabs";
import { workspaceTabs, type WorkspaceTab } from "./navigation";
import type { useRoamController } from "./useRoamController";

type AppShellProps = {
  controller: ReturnType<typeof useRoamController>;
};

export function AppShell({ controller }: AppShellProps) {
  const [mobileProjectModalOpen, setMobileProjectModalOpen] = useState(false);
  const [mobileSessionModalOpen, setMobileSessionModalOpen] = useState(false);
  const {
    state,
    token,
    setToken,
    dispatch,
    selectedRunner,
    selectedProject,
    runnerSessions,
    selectedSession,
    sessionMessages,
    sessionApprovals,
    sessionHunks,
    sessionTerminalLines,
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
    sendTerminalCommand,
    selectFile,
    saveSelectedFile,
  } = controller;

  const setActiveTab = (tab: WorkspaceTab) =>
    dispatch({ type: "activeTabChanged", tab });
  const setSelectedSessionId = (sessionId: string) =>
    dispatch({ type: "sessionSelected", sessionId });
  const activeProjects = useMemo(
    () => state.projects.filter((project) => !project.archivedAt),
    [state.projects],
  );

  return (
    <div className={`app-shell active-${state.activeTab}`}>
      <header className="topbar">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-ink-500">RoamCli</p>
          <h1 className="truncate text-lg font-semibold text-ink-900">
            Remote Agent Control
          </h1>
        </div>
        <div className="topbar-actions">
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
      </header>

      {state.error ? (
        <div className="error-banner" role="alert">
          <div>
            <strong>{state.error.title}</strong>
            <p>{state.error.message}</p>
          </div>
        </div>
      ) : null}

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
          <section
            className="mobile-controls"
            aria-label="Mobile project controls"
          >
            <div className="mobile-control-row">
              <label>
                <span>Project</span>
                <select
                  value={selectedProject?.id ?? ""}
                  onChange={(event) => selectProject(event.target.value)}
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
              <div className="mobile-control-actions">
                <button
                  className="primary-icon-button"
                  type="button"
                  aria-label="New project"
                  title="New project"
                  onClick={() => setMobileProjectModalOpen(true)}
                >
                  <FolderPlus size={16} />
                </button>
                {selectedProject ? (
                  <button
                    className="mobile-icon-button danger"
                    type="button"
                    aria-label={`Archive selected project ${selectedProject.name}`}
                    title="Archive project"
                    onClick={() => archiveProject(selectedProject.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="mobile-control-row">
              <label>
                <span>Session</span>
                <select
                  value={selectedSession?.id ?? ""}
                  disabled={!selectedProject || runnerSessions.length === 0}
                  onChange={(event) => setSelectedSessionId(event.target.value)}
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
              <div className="mobile-control-actions">
                {selectedProject ? (
                  <button
                    className="primary-icon-button"
                    type="button"
                    aria-label={`New session in selected project ${selectedProject.name}`}
                    title="New session"
                    onClick={() => setMobileSessionModalOpen(true)}
                  >
                    <Plus size={16} />
                  </button>
                ) : null}
              </div>
            </div>
          </section>

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
              />
            ) : (
              <section className="chat-column" aria-label="Conversation">
                <div className="empty-state compact">
                  {selectedProject ? "Create a session in the selected project." : "Create a project to start a session."}
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
                <div className="workspace-surface terminal-surface">
                  <TerminalPanel
                    lines={sessionTerminalLines}
                    streamState={state.connectionState}
                    onCommand={sendTerminalCommand}
                    onControl={sendControl}
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

          {mobileProjectModalOpen ? (
            <SidebarModal
              title="New Project"
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
              onClose={() => setMobileSessionModalOpen(false)}
            >
              {selectedRunner ? (
                <NewSessionForm
                  project={selectedProject}
                  runner={selectedRunner}
                  onCreate={(values) => createSession(selectedProject.id, values)}
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
