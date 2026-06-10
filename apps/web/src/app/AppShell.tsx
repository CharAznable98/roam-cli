import { ApprovalCenter } from "../features/approvals/ApprovalCenter";
import { ArtifactList } from "../features/approvals/ArtifactList";
import { ChatPanel } from "../features/conversation/ChatPanel";
import { FilePanel } from "../features/files/FilePanel";
import { PushSettings } from "../features/pwa/PushSettings";
import { NewSessionForm } from "../features/sessions/NewSessionForm";
import { RunnerSidebar } from "../features/sessions/RunnerSidebar";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { BottomTabs } from "./BottomTabs";
import { workspaceTabs, type WorkspaceTab } from "./navigation";
import type { useRoamController } from "./useRoamController";

type AppShellProps = {
  controller: ReturnType<typeof useRoamController>;
};

export function AppShell({ controller }: AppShellProps) {
  const {
    state,
    token,
    setToken,
    dispatch,
    selectedRunner,
    runnerSessions,
    selectedSession,
    sessionMessages,
    sessionApprovals,
    sessionHunks,
    sessionTerminalLines,
    sessionFiles,
    sessionFileTreeState,
    serverCommand,
    runnerCommand,
    selectRunner,
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
              ? "server offline"
              : `${state.runners.length} runners online`}
          </span>
        </div>
      </header>

      {state.error ? (
        <div className="error-banner" role="alert">
          <div>
            <strong>RoamCli server is not reachable</strong>
            <p>{state.error}</p>
          </div>
          <pre>{serverCommand}</pre>
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

      {selectedRunner ? (
        <>
          <section
            className="mobile-controls"
            aria-label="Mobile runner controls"
          >
            <label>
              <span>Runner</span>
              <select
                value={state.selectedRunnerId}
                onChange={(event) => selectRunner(event.target.value)}
              >
                {state.runners.map((runner) => (
                  <option key={runner.runnerId} value={runner.runnerId}>
                    {runner.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Session</span>
              <select
                value={selectedSession?.id ?? ""}
                onChange={(event) => setSelectedSessionId(event.target.value)}
              >
                {runnerSessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                  </option>
                ))}
              </select>
            </label>
            <details
              open={state.mobileNewSessionOpen}
              onToggle={(event) =>
                dispatch({
                  type: "mobileNewSessionOpenChanged",
                  open: event.currentTarget.open,
                })
              }
            >
              <summary>New session</summary>
              <NewSessionForm
                key={selectedRunner.runnerId}
                runner={selectedRunner}
                onCreate={createSession}
              />
            </details>
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
              runners={state.runners}
              selectedRunnerId={state.selectedRunnerId}
              sessions={state.sessions}
              selectedSessionId={selectedSession?.id ?? ""}
              onSelectRunner={selectRunner}
              onSelectSession={setSelectedSessionId}
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
                  Create a session on the selected runner.
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
