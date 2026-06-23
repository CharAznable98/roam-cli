import { ApprovalCenter } from "../features/approvals/ApprovalCenter";
import { ArtifactList } from "../features/approvals/ArtifactList";
import { ChatPanel } from "../features/conversation/ChatPanel";
import type { MarkdownFileLinkTarget } from "../features/conversation/file-links";
import { FilePanel } from "../features/files/FilePanel";
import { GitPanel } from "../features/git/GitPanel";
import { PushSettings } from "../features/pwa/PushSettings";
import { getNotificationSupport } from "../features/pwa/pwa";
import type {
  AccountSecurityState,
  ApiChangePassword,
  Project,
  Session,
} from "@roamcli/shared/protocol";
import {
  ArrowLeft,
  Bell,
  ChevronRight,
  Copy,
  FolderPlus,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
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
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BottomTabs } from "./BottomTabs";
import { workspaceTabs, type WorkspaceTab } from "./navigation";
import type { AppNotification } from "./state";
import type { useRoamController } from "./useRoamController";

type AppShellProps = {
  controller: ReturnType<typeof useRoamController>;
};

type SettingsView = "home" | "account" | "change-password" | "web-push";
type AccountRefreshState = "idle" | "loading" | "ready" | "error";

export function AppShell({ controller }: AppShellProps) {
  const [mobileProjectModalOpen, setMobileProjectModalOpen] = useState(false);
  const [mobileSessionModalOpen, setMobileSessionModalOpen] = useState(false);
  const [mobileSessionSwitcherOpen, setMobileSessionSwitcherOpen] =
    useState(false);
  const [mobileStatusModalOpen, setMobileStatusModalOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<SettingsView>("home");
  const [settingsAccountRefreshState, setSettingsAccountRefreshState] =
    useState<AccountRefreshState>("idle");
  const {
    state,
    authView,
    accountSecurity,
    streamReconnect,
    reconnectStream,
    setupOwner,
    loginOwner,
    logoutOwner,
    logoutAllOwnerSessions,
    changeOwnerPassword,
    regenerateRunnerToken,
    refreshAccountSecurity,
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
    fetchGitHistory,
    fetchGitBranches,
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
  const showWorkspace =
    state.loadState === "ready" || state.loadState === "error";
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

  useEffect(() => {
    if (authView !== "authenticated") {
      setSettingsView("home");
    }
  }, [authView]);

  useEffect(() => {
    if (state.activeTab !== "settings") {
      setSettingsView("home");
    }
  }, [state.activeTab]);

  const notify = useCallback(
    (tone: AppNotification["tone"], title: string, message: string) => {
      dispatch({ type: "notificationPushed", tone, title, message });
    },
    [dispatch],
  );

  useEffect(() => {
    if (authView !== "authenticated" || state.activeTab !== "settings") {
      setSettingsAccountRefreshState("idle");
      return;
    }

    let active = true;
    setSettingsAccountRefreshState("loading");
    void refreshAccountSecurity()
      .then(() => {
        if (active) {
          setSettingsAccountRefreshState("ready");
        }
      })
      .catch((accountError: unknown) => {
        notify(
          "error",
          "Account settings unavailable",
          errorMessage(accountError),
        );
        if (active) {
          setSettingsAccountRefreshState("error");
        }
      });

    return () => {
      active = false;
    };
  }, [
    authView,
    notify,
    refreshAccountSecurity,
    state.activeTab,
  ]);

  const logoutFromAccountSecurity = useCallback(async () => {
    try {
      await logoutOwner();
    } catch (logoutError: unknown) {
      notify("error", "Log out failed", errorMessage(logoutError));
    }
  }, [logoutOwner, notify]);

  const logoutAllFromAccountSecurity = useCallback(async () => {
    try {
      await logoutAllOwnerSessions();
    } catch (logoutError: unknown) {
      notify("error", "Log out all failed", errorMessage(logoutError));
    }
  }, [logoutAllOwnerSessions, notify]);

  const changePasswordFromAccountSecurity = useCallback(
    async (input: ApiChangePassword) => {
      try {
        await changeOwnerPassword(input);
      } catch (changeError: unknown) {
        notify("error", "Password change failed", errorMessage(changeError));
      }
    },
    [changeOwnerPassword, notify],
  );

  const regenerateRunnerTokenFromSettings = useCallback(async () => {
    try {
      await regenerateRunnerToken();
      notify(
        "success",
        "Runner token regenerated",
        "The runner token and command have been updated.",
      );
    } catch (runnerError: unknown) {
      notify("error", "Runner token update failed", errorMessage(runnerError));
    }
  }, [notify, regenerateRunnerToken]);

  if (authView !== "authenticated") {
    return (
      <AuthGate mode={authView} onSetup={setupOwner} onLogin={loginOwner} />
    );
  }

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
            aria-label="Open connection status"
            title="Connection status"
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
              onFetchGitStatus={fetchGitStatus}
              onFetchGitBranches={fetchGitBranches}
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
                  {state.loadState === "error" ? (
                    <>
                      <span>API connection failed</span>
                      <p className="session-empty-meta">
                        Check your login session or backend route, then
                        reconnect the stream.
                      </p>
                      <button
                        className="small-button"
                        type="button"
                        onClick={() => setMobileStatusModalOpen(true)}
                      >
                        <WifiOff size={16} />
                        Connection settings
                      </button>
                    </>
                  ) : (
                    <>
                      <span>
                        {state.runners.length === 0 && !hasWorkspaceData
                          ? "No runners are online"
                          : selectedProject
                            ? "Create a session in the selected project."
                            : "Create a project to start a session."}
                      </span>
                      <p className="session-empty-meta">
                        {state.runners.length === 0 && !hasWorkspaceData
                          ? "Start a runner to create or resume sessions."
                          : selectedProject
                            ? `${selectedProject.name} · ${state.runners.length} ${state.runners.length === 1 ? "runner" : "runners"} online`
                            : `${state.runners.length} ${state.runners.length === 1 ? "runner" : "runners"} online`}
                      </p>
                      {state.runners.length === 0 && !hasWorkspaceData ? (
                        <pre>{runnerCommand}</pre>
                      ) : (
                        <button
                          className="small-button"
                          type="button"
                          aria-label="Choose session"
                          onClick={() => setMobileSessionSwitcherOpen(true)}
                        >
                          Choose session
                        </button>
                      )}
                    </>
                  )}
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
                    onFetchHistory={fetchGitHistory}
                    onFetchBranches={fetchGitBranches}
                    onInitRepository={initGitRepository}
                    onStagePaths={stageGitPaths}
                    onUnstagePaths={unstageGitPaths}
                    onDiscardPaths={discardGitPaths}
                    onCommit={commitGitChanges}
                    onRemoteOperation={runGitRemoteOperation}
                    onRemoveWorktree={removeGitWorktree}
                    onNotify={(tone, title, message) =>
                      dispatch({
                        type: "notificationPushed",
                        tone,
                        title,
                        message,
                      })
                    }
                  />
                </div>
                <div className="workspace-surface approvals-surface">
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
                <div className="workspace-surface settings-surface">
                  <SettingsPanel
                    account={accountSecurity}
                    accountRefreshState={settingsAccountRefreshState}
                    runnerCommand={runnerCommand}
                    view={settingsView}
                    onViewChange={setSettingsView}
                    onLogout={logoutFromAccountSecurity}
                    onLogoutAll={logoutAllFromAccountSecurity}
                    onChangePassword={changePasswordFromAccountSecurity}
                    onRegenerateRunnerToken={regenerateRunnerTokenFromSettings}
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
                  onFetchGitStatus={fetchGitStatus}
                  onFetchGitBranches={fetchGitBranches}
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

function AuthGate({
  mode,
  onSetup,
  onLogin,
}: {
  mode: "checking" | "setup_required" | "login";
  onSetup: (input: { setupToken: string; password: string }) => Promise<void>;
  onLogin: (password: string) => Promise<void>;
}) {
  const [setupToken, setSetupToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const isSetup = mode === "setup_required";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (mode === "checking") {
      return;
    }
    if (isSetup && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      if (isSetup) {
        await onSetup({ setupToken, password });
      } else {
        await onLogin(password);
      }
    } catch (submitError: unknown) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-gate">
      <form className="auth-panel" onSubmit={(event) => void submit(event)}>
        <div className="auth-panel-header">
          <p className="topbar-kicker">RoamCli</p>
          <h1>{isSetup ? "Set Up Owner Access" : "Owner Login"}</h1>
        </div>
        {mode === "checking" ? (
          <div className="empty-state compact">Checking session...</div>
        ) : (
          <>
            {isSetup ? (
              <label className="field">
                <span>Setup token</span>
                <input
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                  autoComplete="one-time-code"
                  required
                />
              </label>
            ) : null}
            <label className="field">
              <span>Password</span>
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete={isSetup ? "new-password" : "current-password"}
                minLength={isSetup ? 12 : 1}
                required
              />
            </label>
            {isSetup ? (
              <label className="field">
                <span>Confirm password</span>
                <input
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
              </label>
            ) : null}
            {error ? (
              <div className="form-error" role="alert">
                {error}
              </div>
            ) : null}
            <button className="primary-action-button" type="submit">
              <KeyRound size={16} />
              {submitting
                ? isSetup
                  ? "Setting up..."
                  : "Signing in..."
                : isSetup
                  ? "Complete setup"
                  : "Sign in"}
            </button>
          </>
        )}
      </form>
    </main>
  );
}

function SettingsPanel({
  account,
  accountRefreshState,
  runnerCommand,
  view,
  onViewChange,
  onLogout,
  onLogoutAll,
  onChangePassword,
  onRegenerateRunnerToken,
}: {
  account: AccountSecurityState | undefined;
  accountRefreshState: AccountRefreshState;
  runnerCommand: string;
  view: SettingsView;
  onViewChange: (view: SettingsView) => void;
  onLogout: () => Promise<void>;
  onLogoutAll: () => Promise<void>;
  onChangePassword: (input: ApiChangePassword) => Promise<void>;
  onRegenerateRunnerToken: () => Promise<void>;
}) {
  return (
    <section className="tool-panel settings-panel" aria-label="Settings">
      {view === "home" ? (
        <>
          <div className="tool-panel-header">
            <h2 className="panel-title">Settings</h2>
          </div>
          <div className="settings-list" role="list">
            <SettingsListItem
              icon={<ShieldCheck size={18} />}
              title="Account & Security"
              description="Owner password, runner token, and web sessions"
              onClick={() => onViewChange("account")}
            />
            <SettingsListItem
              icon={<Bell size={18} />}
              title="Web Push"
              description="Browser notification permission"
              status={getNotificationSupport()}
              onClick={() => onViewChange("web-push")}
            />
          </div>
        </>
      ) : null}

      {view === "account" ? (
        <>
          <SettingsDetailHeader
            title="Account & Security"
            onBack={() => onViewChange("home")}
          />
          {account && accountRefreshState === "ready" ? (
            <AccountSecurityPanel
              account={account}
              runnerCommand={runnerCommand}
              onChangePasswordOpen={() => onViewChange("change-password")}
              onLogout={onLogout}
              onLogoutAll={onLogoutAll}
              onRegenerateRunnerToken={onRegenerateRunnerToken}
            />
          ) : accountRefreshState === "error" ? (
            <div className="empty-state compact">
              Account settings could not be loaded.
            </div>
          ) : (
            <div className="empty-state compact">
              Loading account settings...
            </div>
          )}
        </>
      ) : null}

      {view === "change-password" ? (
        <>
          <SettingsDetailHeader
            title="Change Password"
            backLabel="Account & Security"
            onBack={() => onViewChange("account")}
          />
          <ChangePasswordPanel onChangePassword={onChangePassword} />
        </>
      ) : null}

      {view === "web-push" ? (
        <>
          <SettingsDetailHeader
            title="Web Push"
            onBack={() => onViewChange("home")}
          />
          <div className="settings-detail">
            <PushSettings />
          </div>
        </>
      ) : null}
    </section>
  );
}

function SettingsListItem({
  icon,
  title,
  description,
  status,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  status?: string;
  onClick: () => void;
}) {
  return (
    <button className="settings-list-item" type="button" onClick={onClick}>
      <span className="settings-list-icon">{icon}</span>
      <span className="settings-list-copy">
        <span className="settings-list-title">{title}</span>
        <span className="settings-list-description">{description}</span>
      </span>
      <span className="settings-list-trailing">
        {status ? <span className="settings-status">{status}</span> : null}
        <ChevronRight size={16} />
      </span>
    </button>
  );
}

function SettingsDetailHeader({
  title,
  backLabel = "Settings",
  onBack,
}: {
  title: string;
  backLabel?: string;
  onBack: () => void;
}) {
  return (
    <div className="tool-panel-header settings-detail-header">
      <button
        className="small-button settings-back-button"
        type="button"
        onClick={onBack}
      >
        <ArrowLeft size={15} />
        {backLabel}
      </button>
      <h2 className="panel-title">{title}</h2>
    </div>
  );
}

function AccountSecurityPanel({
  account,
  runnerCommand,
  onChangePasswordOpen,
  onLogout,
  onLogoutAll,
  onRegenerateRunnerToken,
}: {
  account: AccountSecurityState;
  runnerCommand: string;
  onChangePasswordOpen: () => void;
  onLogout: () => Promise<void>;
  onLogoutAll: () => Promise<void>;
  onRegenerateRunnerToken: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState<
    "runner" | "logout" | "all" | ""
  >("");

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
  };

  const regenerate = async () => {
    if (
      !window.confirm(
        "Regenerate the Runner token? Current online runners stay connected, but old-token reconnects will fail.",
      )
    ) {
      return;
    }
    setSubmitting("runner");
    await onRegenerateRunnerToken();
    setSubmitting("");
  };

  const logout = async () => {
    setSubmitting("logout");
    await onLogout();
    setSubmitting("");
  };

  const logoutAll = async () => {
    if (!window.confirm("Log out all web sessions?")) {
      return;
    }
    setSubmitting("all");
    await onLogoutAll();
    setSubmitting("");
  };

  return (
    <div className="account-security-panel settings-detail">
      <section className="settings-section">
        <h3>Runner Token</h3>
        <div className="secret-display" aria-label="Runner token">
          {account.runnerToken}
        </div>
        <pre className="command-display">{runnerCommand}</pre>
        <div className="button-row">
          <button
            className="small-button"
            type="button"
            onClick={() => copy(account.runnerToken)}
          >
            <Copy size={14} />
            Copy token
          </button>
          <button
            className="small-button"
            type="button"
            onClick={() => copy(runnerCommand)}
          >
            <Copy size={14} />
            Copy command
          </button>
          <button
            className="small-button danger"
            type="button"
            onClick={() => void regenerate()}
            disabled={submitting === "runner"}
          >
            <RotateCcw size={14} />
            {submitting === "runner" ? "Regenerating" : "Regenerate"}
          </button>
        </div>
        <p className="settings-meta">
          Created {formatDate(account.runnerTokenCreatedAt)} · Updated{" "}
          {formatDate(account.runnerTokenUpdatedAt)}
          {account.runnerTokenLastUsedAt
            ? ` · Last used ${formatDate(account.runnerTokenLastUsedAt)}`
            : ""}
        </p>
      </section>

      <section className="settings-section">
        <h3>Web Sessions</h3>
        <div className="session-list">
          {account.sessions.map((session) => (
            <div className="session-row" key={session.id}>
              <span>
                {session.current ? "Current session" : "Signed-in session"}
              </span>
              <span>{formatDate(session.lastSeenAt)}</span>
            </div>
          ))}
        </div>
        <div className="button-row">
          <button
            className="small-button"
            type="button"
            onClick={() => void logout()}
            disabled={submitting === "logout"}
          >
            <LogOut size={14} />
            Log out
          </button>
          <button
            className="small-button danger"
            type="button"
            onClick={() => void logoutAll()}
            disabled={submitting === "all"}
          >
            <LogOut size={14} />
            Log out all
          </button>
        </div>
      </section>

      <section className="settings-section">
        <button
          className="settings-list-item compact"
          type="button"
          onClick={onChangePasswordOpen}
        >
          <span className="settings-list-icon">
            <KeyRound size={18} />
          </span>
          <span className="settings-list-copy">
            <span className="settings-list-title">Change Password</span>
            <span className="settings-list-description">
              Update owner access credentials
            </span>
          </span>
          <span className="settings-list-trailing">
            <ChevronRight size={16} />
          </span>
        </button>
      </section>
    </div>
  );
}

function ChangePasswordPanel({
  onChangePassword,
}: {
  onChangePassword: (input: ApiChangePassword) => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validationError, setValidationError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setValidationError("");
    if (newPassword !== confirmPassword) {
      setValidationError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    await onChangePassword({ currentPassword, newPassword });
    setSubmitting(false);
  };

  return (
    <form
      className="settings-detail password-settings-form"
      onSubmit={(event) => void submitPassword(event)}
    >
      <label className="field">
        <span>Current password</span>
        <input
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      <label className="field">
        <span>New password</span>
        <input
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      {validationError ? (
        <div className="form-error" role="alert">
          {validationError}
        </div>
      ) : null}
      <button
        className="primary-action-button"
        type="submit"
        disabled={submitting}
      >
        <KeyRound size={16} />
        {submitting ? "Changing password" : "Change password"}
      </button>
    </form>
  );
}

function MobileStatusSheet({
  connectionState,
  loadState,
  runnerCount,
  streamReconnect,
  onReconnect,
}: {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
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
