import { ApprovalCenter } from "../features/approvals/ApprovalCenter";
import { ChatPanel } from "../features/conversation/ChatPanel";
import type { MarkdownFileLinkTarget } from "../features/conversation/file-links";
import { FilePanel } from "../features/files/FilePanel";
import { GitPanel } from "../features/git/GitPanel";
import { PushSettings } from "../features/pwa/PushSettings";
import { getNotificationSupport } from "../features/pwa/pwa";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_VISIBLE_SESSIONS_PER_PROJECT,
  MAX_PINNED_SESSIONS_PER_PROJECT,
  PROJECT_PROMPT_PRESET_CONTENT_MAX_LENGTH,
  PROJECT_PROMPT_PRESET_TITLE_MAX_LENGTH,
  type AccountSecurityState,
  type ApiChangePassword,
  type ApiCreateProjectPromptPreset,
  type ApiUpdateProjectPromptPreset,
  type FileNode,
  type GitJob,
  type InstallMetadata,
  type Project,
  type ProjectPromptPreset,
  type Session,
  type SessionStatus,
} from "@roamcli/shared/protocol";
import {
  Archive,
  ArrowLeft,
  Bell,
  BookOpen,
  BookmarkPlus,
  ChevronRight,
  Copy,
  FolderPlus,
  FolderOpen,
  GripVertical,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
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
  sortProjectsForDisplay,
  sortSessionsForDisplay,
} from "../features/sessions/model";
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
import { buildRunnerCommand, fallbackInstallMetadata } from "./runner-command";
import type { AppNotification } from "./state";
import type { useRoamController } from "./useRoamController";
import { StatusPill } from "../shared/components/StatusPill";
import type { AsyncState } from "../shared/types/async";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type AppShellProps = {
  controller: ReturnType<typeof useRoamController>;
};

type SettingsView =
  | "home"
  | "account"
  | "change-password"
  | "web-push"
  | "project";
type AccountRefreshState = "idle" | "loading" | "ready" | "error";

type SessionArchiveDialogState = {
  session: Session;
  error?: string;
  submitting?: "keep" | "remove";
};

type PromptPresetEditorState = {
  projectId: string;
  preset?: ProjectPromptPreset;
  initialTitle?: string;
  initialContent?: string;
};

const TERMINAL_GIT_JOB_STATUSES = new Set<GitJob["status"]>([
  "succeeded",
  "failed",
  "cancelled",
]);
const GIT_JOB_POLL_INTERVAL_MS = 500;

async function waitForGitJob(input: {
  jobId: string;
  projectId: string;
  getJobs: () => GitJob[];
  fetchGitJobs: (projectId: string) => Promise<GitJob[]>;
}): Promise<GitJob> {
  for (;;) {
    const eventJob = input.getJobs().find((job) => job.id === input.jobId);
    if (eventJob && TERMINAL_GIT_JOB_STATUSES.has(eventJob.status)) {
      return eventJob;
    }
    const jobs = await input.fetchGitJobs(input.projectId);
    const polledJob = jobs.find((job) => job.id === input.jobId);
    if (polledJob && TERMINAL_GIT_JOB_STATUSES.has(polledJob.status)) {
      return polledJob;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, GIT_JOB_POLL_INTERVAL_MS),
    );
  }
}

export function AppShell({ controller }: AppShellProps) {
  const [runnerFilterId, setRunnerFilterId] = useState("all");
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [mobileProjectModalOpen, setMobileProjectModalOpen] = useState(false);
  const [mobileSessionModalOpen, setMobileSessionModalOpen] = useState(false);
  const [mobileSessionSwitcherOpen, setMobileSessionSwitcherOpen] =
    useState(false);
  const [mobileStatusModalOpen, setMobileStatusModalOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<SettingsView>("home");
  const [settingsProjectId, setSettingsProjectId] = useState("");
  const [promptPresetEditor, setPromptPresetEditor] =
    useState<PromptPresetEditorState | null>(null);
  const [settingsAccountRefreshState, setSettingsAccountRefreshState] =
    useState<AccountRefreshState>("idle");
  const [settingsAccountRefreshKey, setSettingsAccountRefreshKey] = useState(0);
  const settingsAccountRefreshPendingRef = useRef(false);
  const [archiveDialog, setArchiveDialog] =
    useState<SessionArchiveDialogState | null>(null);
  const [runnerCommandPlugins, setRunnerCommandPlugins] = useState<string[]>(
    [],
  );
  const [runnerCustomPlugin, setRunnerCustomPlugin] = useState("");
  const {
    state,
    projectPromptPresetsByProject,
    projectPromptPresetStates,
    authView,
    accountSecurity,
    installMetadata,
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
    sessionActivities,
    sessionApprovals,
    sessionHunks,
    sessionFiles,
    sessionFileTreeState,
    sessionFileTreePathState,
    selectProject,
    createProject,
    archiveProject,
    toggleProjectPinned,
    createSession,
    renameSelectedSession,
    toggleSessionPinned,
    sendMessage,
    resolveApproval,
    resolveHunk,
    applyAcceptedPatch,
    sendControl,
    archiveSession,
    refreshSessionDetail,
    selectFile,
    openFileForEdit,
    startSelectedFileEdit,
    cancelSelectedFileEdit,
    loadSelectedDirectory,
    refreshSelectedFileTree,
    refreshSelectedFileContent,
    saveSelectedFile,
    projectPromptPresetErrorsByProject,
    refreshProjectPromptPresets,
    createProjectPromptPreset,
    updateProjectPromptPreset,
    deleteProjectPromptPreset,
    reorderProjectPromptPresets,
    fetchMessageAttachmentContent,
    fetchRunnerDirectoryTree,
    createRunnerDirectory,
    listAgentSkills,
    searchWorkspacePaths,
    fetchGitStatus,
    fetchGitDiff,
    fetchGitHistory,
    fetchGitCommitFiles,
    fetchGitBranches,
    fetchGitJobs,
    initGitRepository,
    stageGitPaths,
    unstageGitPaths,
    discardGitPaths,
    commitGitChanges,
    runGitRemoteOperation,
    removeGitWorktree,
  } = controller;
  const gitJobsRef = useRef(state.gitJobs);
  useEffect(() => {
    gitJobsRef.current = state.gitJobs;
  }, [state.gitJobs]);
  const requestSettingsAccountRefresh = useCallback(() => {
    if (settingsAccountRefreshPendingRef.current) {
      return;
    }
    settingsAccountRefreshPendingRef.current = true;
    setSettingsAccountRefreshKey((key) => key + 1);
  }, []);

  const openArchiveSessionDialog = useCallback(() => {
    if (selectedSession) {
      setArchiveDialog({ session: selectedSession });
    }
  }, [selectedSession]);

  const closeArchiveSessionDialog = useCallback(() => {
    setArchiveDialog((current) => (current?.submitting ? current : null));
  }, []);

  const submitArchiveSession = useCallback(
    async (worktree: "keep" | "remove") => {
      if (!archiveDialog) {
        return;
      }
      const { session } = archiveDialog;
      setArchiveDialog({ session, submitting: worktree });
      try {
        const shouldSendWorktreeStrategy =
          session.executionMode === "managed_worktree" &&
          !session.worktreeDeletedAt;
        const result = await archiveSession(
          session.id,
          shouldSendWorktreeStrategy ? { worktree } : {},
        );
        if (result?.job) {
          try {
            const job = await waitForGitJob({
              jobId: result.job.id,
              projectId: result.job.projectId,
              getJobs: () => gitJobsRef.current,
              fetchGitJobs,
            });
            if (job.status !== "succeeded") {
              throw new Error(job.errorSummary ?? "Worktree cleanup failed.");
            }
            try {
              await refreshSessionDetail(session.id);
            } catch {
              dispatch({ type: "sessionDeleted", sessionId: session.id });
            }
          } finally {
            dispatch({
              type: "sessionArchiveFinished",
              sessionId: session.id,
            });
          }
        }
        setArchiveDialog(null);
      } catch (archiveError: unknown) {
        setArchiveDialog({
          session,
          error: errorMessage(archiveError),
        });
      }
    },
    [archiveDialog, archiveSession, fetchGitJobs, refreshSessionDetail],
  );

  const setActiveTab = useCallback(
    (tab: WorkspaceTab) => {
      dispatch({ type: "activeTabChanged", tab });
    },
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
    () =>
      sortProjectsForDisplay(
        state.projects.filter((project) => !project.archivedAt),
      ),
    [state.projects],
  );
  const currentProjectSettingsTargetId =
    selectedProject?.id ?? activeProjects[0]?.id ?? "";
  useEffect(() => {
    if (
      settingsProjectId &&
      activeProjects.some((project) => project.id === settingsProjectId)
    ) {
      return;
    }
    setSettingsProjectId(selectedProject?.id ?? activeProjects[0]?.id ?? "");
  }, [activeProjects, selectedProject?.id, settingsProjectId]);
  const hasWorkspaceData =
    activeProjects.length > 0 ||
    state.sessions.some((session) => !session.archivedAt);
  const runnerInstallMetadata = installMetadata ?? fallbackInstallMetadata;
  const runnerCommandAgentPlugins = useMemo(
    () =>
      uniqueStrings([
        ...runnerCommandPlugins,
        ...(runnerCustomPlugin.trim() ? [runnerCustomPlugin.trim()] : []),
      ]),
    [runnerCommandPlugins, runnerCustomPlugin],
  );
  const runnerCommand = useMemo(
    () =>
      buildRunnerCommand(
        accountSecurity?.runnerToken ?? "",
        runnerInstallMetadata,
        runnerCommandAgentPlugins,
      ),
    [
      accountSecurity?.runnerToken,
      runnerCommandAgentPlugins,
      runnerInstallMetadata,
    ],
  );
  const toggleRunnerCommandPlugin = useCallback((packageName: string) => {
    setRunnerCommandPlugins((plugins) =>
      plugins.includes(packageName)
        ? plugins.filter((plugin) => plugin !== packageName)
        : [...plugins, packageName],
    );
  }, []);
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
  const selectedSessionWorkspaceAvailable =
    selectedSession !== undefined &&
    selectedRunner !== undefined &&
    !(
      selectedSession.executionMode === "managed_worktree" &&
      (selectedSession.status === "pending" ||
        selectedSession.worktreeDeletedAt !== undefined)
    );

  useEffect(() => {
    const openOnShortcut = (event: globalThis.KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", openOnShortcut);
    return () => window.removeEventListener("keydown", openOnShortcut);
  }, []);

  useEffect(() => {
    setMobileSessionModalOpen(false);
  }, [selectedProject?.id]);

  useEffect(() => {
    if (authView !== "authenticated") {
      setSettingsView("home");
      setSettingsDrawerOpen(false);
    }
  }, [authView]);

  const notify = useCallback(
    (tone: AppNotification["tone"], title: string, message: string) => {
      dispatch({ type: "notificationPushed", tone, title, message });
    },
    [dispatch],
  );
  const changeSettingsView = useCallback(
    (view: SettingsView) => {
      setSettingsView(view);
      if (view === "project") {
        setSettingsProjectId(currentProjectSettingsTargetId);
      }
      if (
        view === "account" &&
        authView === "authenticated" &&
        settingsDrawerOpen
      ) {
        requestSettingsAccountRefresh();
      }
    },
    [
      authView,
      currentProjectSettingsTargetId,
      requestSettingsAccountRefresh,
      settingsDrawerOpen,
    ],
  );

  useEffect(() => {
    if (authView !== "authenticated" || !settingsDrawerOpen) {
      settingsAccountRefreshPendingRef.current = false;
      setSettingsAccountRefreshState("idle");
      return;
    }
    if (settingsAccountRefreshKey === 0) {
      return;
    }

    let active = true;
    settingsAccountRefreshPendingRef.current = true;
    setSettingsAccountRefreshState("loading");
    void refreshAccountSecurity()
      .then((account) => {
        if (active && account) {
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
      })
      .finally(() => {
        if (active) {
          settingsAccountRefreshPendingRef.current = false;
        }
      });

    return () => {
      active = false;
      settingsAccountRefreshPendingRef.current = false;
    };
  }, [
    authView,
    notify,
    refreshAccountSecurity,
    settingsAccountRefreshKey,
    settingsDrawerOpen,
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

  const openSettingsDrawer = useCallback(
    (view: SettingsView = "home", projectId?: string) => {
      setSettingsView(view);
      if (projectId) {
        setSettingsProjectId(projectId);
      } else if (view === "project") {
        setSettingsProjectId(currentProjectSettingsTargetId);
      }
      setSettingsDrawerOpen(true);
      if (authView === "authenticated") {
        requestSettingsAccountRefresh();
      }
    },
    [authView, currentProjectSettingsTargetId, requestSettingsAccountRefresh],
  );

  const openPromptPresetManager = useCallback(
    (projectId: string) => {
      setMobileSessionModalOpen(false);
      setSettingsProjectId(projectId);
      setSettingsView("project");
      openSettingsDrawer("project", projectId);
    },
    [openSettingsDrawer],
  );

  const openSaveMessageAsPrompt = useCallback(
    (content: string) => {
      if (!selectedSession) {
        return;
      }
      const cleanContent = content.trim();
      if (!cleanContent) {
        notify("error", "Prompt was not saved", "Message text is empty.");
        return;
      }
      setPromptPresetEditor({
        projectId: selectedSession.projectId,
        initialTitle: promptTitleFromMessage(cleanContent),
        initialContent: cleanContent,
      });
    },
    [notify, selectedSession],
  );

  const openSettingsPromptPresetEditor = useCallback(
    (projectId: string, preset?: ProjectPromptPreset) => {
      setSettingsDrawerOpen(false);
      setSettingsView("home");
      setPromptPresetEditor(preset ? { projectId, preset } : { projectId });
    },
    [],
  );

  const savePromptPreset = useCallback(
    async (
      projectId: string,
      presetId: string | undefined,
      input: ApiCreateProjectPromptPreset | ApiUpdateProjectPromptPreset,
    ) => {
      try {
        if (presetId) {
          await updateProjectPromptPreset(projectId, presetId, input);
        } else {
          await createProjectPromptPreset(
            projectId,
            input as ApiCreateProjectPromptPreset,
          );
        }
        notify("success", "Prompt saved", "Project prompt preset saved.");
        setPromptPresetEditor(null);
      } catch (saveError: unknown) {
        notify("error", "Prompt was not saved", errorMessage(saveError));
        throw saveError;
      }
    },
    [createProjectPromptPreset, notify, updateProjectPromptPreset],
  );

  const removePromptPreset = useCallback(
    async (projectId: string, preset: ProjectPromptPreset) => {
      if (
        !window.confirm(
          `Delete prompt preset "${preset.title}"? This does not affect historical messages.`,
        )
      ) {
        return false;
      }
      try {
        await deleteProjectPromptPreset(projectId, preset.id);
        notify("success", "Prompt deleted", "Project prompt preset deleted.");
        return true;
      } catch (deleteError: unknown) {
        notify("error", "Prompt was not deleted", errorMessage(deleteError));
        return false;
      }
    },
    [deleteProjectPromptPreset, notify],
  );

  const reorderPromptPresets = useCallback(
    async (projectId: string, presetIds: string[]) => {
      try {
        await reorderProjectPromptPresets(projectId, presetIds);
      } catch (reorderError: unknown) {
        notify(
          "error",
          "Prompt order was not saved",
          errorMessage(reorderError),
        );
        throw reorderError;
      }
    },
    [notify, reorderProjectPromptPresets],
  );

  if (authView !== "authenticated") {
    return (
      <AuthGate mode={authView} onSetup={setupOwner} onLogin={loginOwner} />
    );
  }

  const workspaceActiveTab =
    state.activeTab === "chat" ? "files" : state.activeTab;

  return (
    <TooltipProvider>
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
            <button
              className="command-trigger"
              type="button"
              onClick={() => setCommandPaletteOpen(true)}
            >
              <Search size={15} />
              <span>Search or run command...</span>
              <kbd>⌘K</kbd>
            </button>
            <span
              className={`topbar-status ${state.connectionState === "open" ? "success" : "warning"}`}
            >
              {state.connectionState === "open"
                ? "stream connected"
                : "stream disconnected"}
            </span>
            {state.loadState === "error" ? (
              <button
                className="topbar-status topbar-status-button error"
                type="button"
                onClick={() => setMobileStatusModalOpen(true)}
              >
                API error
              </button>
            ) : (
              <span className="topbar-status success">
                {state.runners.length} runners online
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Settings"
                  onClick={() => openSettingsDrawer("home")}
                >
                  <Settings size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="mobile-topbar-icon-button"
                  aria-label="Open command palette"
                  onClick={() => setCommandPaletteOpen(true)}
                >
                  <Search size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Command palette</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="mobile-topbar-icon-button"
                  aria-label="Settings"
                  onClick={() => openSettingsDrawer("home")}
                >
                  <Settings size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
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
                runnerFilterId={runnerFilterId}
                sessions={state.sessions}
                selectedSessionId={selectedSession?.id ?? ""}
                onRunnerFilterChange={setRunnerFilterId}
                onSelectProject={selectProject}
                onSelectSession={setSelectedSessionId}
                onCreateProject={createProject}
                onFetchRunnerDirectoryTree={fetchRunnerDirectoryTree}
                onCreateRunnerDirectory={createRunnerDirectory}
                onArchiveProject={archiveProject}
                onToggleProjectPinned={toggleProjectPinned}
                onCreateSession={createSession}
                onToggleSessionPinned={toggleSessionPinned}
                onListAgentSkills={listAgentSkills}
                onSearchWorkspacePaths={searchWorkspacePaths}
                promptPresetsByProject={projectPromptPresetsByProject}
                promptPresetStates={projectPromptPresetStates}
                promptPresetErrorsByProject={projectPromptPresetErrorsByProject}
                onRefreshPromptPresets={refreshProjectPromptPresets}
                onManagePromptPresets={openPromptPresetManager}
                onFetchGitStatus={fetchGitStatus}
                onFetchGitBranches={fetchGitBranches}
              />
              {selectedSession ? (
                <ChatPanel
                  session={selectedSession}
                  messages={sessionMessages}
                  activities={sessionActivities}
                  onSend={sendMessage}
                  onControl={sendControl}
                  onRename={renameSelectedSession}
                  onDelete={openArchiveSessionDialog}
                  onCheckStatus={checkSelectedSessionStatus}
                  statusCheckState={sessionStatusCheckState}
                  canSend={canUseSelectedRunner}
                  canControl={canUseSelectedRunner}
                  onOpenSessionSwitcher={() =>
                    setMobileSessionSwitcherOpen(true)
                  }
                  onOpenFileLink={openMarkdownFileLink}
                  imageCapability={selectedRunner?.capabilities.find(
                    (capability) => capability.kind === selectedSession.agent,
                  )}
                  onFetchAttachmentContent={fetchMessageAttachmentContent}
                  onListAgentSkills={listAgentSkills}
                  onSearchWorkspacePaths={searchWorkspacePaths}
                  promptPresets={
                    projectPromptPresetsByProject[selectedSession.projectId] ??
                    []
                  }
                  promptPresetState={
                    projectPromptPresetStates[selectedSession.projectId] ??
                    "idle"
                  }
                  promptPresetError={
                    projectPromptPresetErrorsByProject[
                      selectedSession.projectId
                    ]
                  }
                  onRefreshPromptPresets={() =>
                    refreshProjectPromptPresets(selectedSession.projectId)
                  }
                  onManagePromptPresets={() =>
                    openPromptPresetManager(selectedSession.projectId)
                  }
                  onSaveMessageAsPrompt={openSaveMessageAsPrompt}
                  onNotify={notify}
                  statusBanner={
                    state.loadState === "error" ? (
                      <ApiConnectionBanner
                        onOpenConnection={() => setMobileStatusModalOpen(true)}
                      />
                    ) : undefined
                  }
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
                          <RunnerCommandBuilder
                            command={runnerCommand}
                            installMetadata={runnerInstallMetadata}
                            selectedPlugins={runnerCommandPlugins}
                            customPlugin={runnerCustomPlugin}
                            effectivePlugins={runnerCommandAgentPlugins}
                            tokenReady={Boolean(accountSecurity?.runnerToken)}
                            onTogglePlugin={toggleRunnerCommandPlugin}
                            onCustomPluginChange={setRunnerCustomPlugin}
                          />
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
                  {workspaceTabs.map((tab) => (
                    <WorkspaceTabButton
                      key={tab.id}
                      tab={tab}
                      activeTab={workspaceActiveTab}
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
                      editMode={state.fileEditMode}
                      contentState={state.fileContentState}
                      saveState={state.fileSaveState}
                      onSelectFile={selectFile}
                      onLoadDirectory={loadSelectedDirectory}
                      onRefreshTree={refreshSelectedFileTree}
                      onRefreshFile={refreshSelectedFileContent}
                      onStartEdit={startSelectedFileEdit}
                      onCancelEdit={cancelSelectedFileEdit}
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
                      archivingSessionIds={state.archivingSessionIds}
                      defaultContext={selectedGitContext}
                      onFetchStatus={fetchGitStatus}
                      onFetchDiff={fetchGitDiff}
                      onFetchHistory={fetchGitHistory}
                      onFetchCommitFiles={fetchGitCommitFiles}
                      onFetchBranches={fetchGitBranches}
                      gitJobs={state.gitJobs}
                      onFetchJobs={fetchGitJobs}
                      onInitRepository={initGitRepository}
                      onStagePaths={stageGitPaths}
                      onUnstagePaths={unstageGitPaths}
                      onDiscardPaths={discardGitPaths}
                      onCommit={commitGitChanges}
                      onRemoteOperation={runGitRemoteOperation}
                      onRemoveWorktree={removeGitWorktree}
                      canOpenFileForEdit={selectedSessionWorkspaceAvailable}
                      onOpenFileForEdit={openFileForEdit}
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
                  onToggleProjectPinned={toggleProjectPinned}
                  onNewSession={() => {
                    setMobileSessionSwitcherOpen(false);
                    setMobileSessionModalOpen(true);
                  }}
                  onToggleSessionPinned={toggleSessionPinned}
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
                    promptPresets={
                      projectPromptPresetsByProject[selectedProject.id] ?? []
                    }
                    promptPresetState={
                      projectPromptPresetStates[selectedProject.id] ?? "idle"
                    }
                    promptPresetError={
                      projectPromptPresetErrorsByProject[selectedProject.id]
                    }
                    onRefreshPromptPresets={() =>
                      refreshProjectPromptPresets(selectedProject.id)
                    }
                    onManagePromptPresets={() => {
                      setMobileSessionModalOpen(false);
                      openPromptPresetManager(selectedProject.id);
                    }}
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

            {archiveDialog ? (
              <SessionArchiveDialog
                state={archiveDialog}
                onClose={closeArchiveSessionDialog}
                onSubmit={submitArchiveSession}
              />
            ) : null}

            {promptPresetEditor ? (
              <PromptPresetEditorDialog
                state={promptPresetEditor}
                project={activeProjects.find(
                  (project) => project.id === promptPresetEditor.projectId,
                )}
                onClose={() => setPromptPresetEditor(null)}
                onSave={savePromptPreset}
                onDelete={removePromptPreset}
              />
            ) : null}

            <Sheet
              open={settingsDrawerOpen}
              onOpenChange={(open) => {
                setSettingsDrawerOpen(open);
                if (!open) {
                  setSettingsView("home");
                }
              }}
            >
              <SheetContent className="settings-drawer" side="right">
                <SheetHeader>
                  <SheetTitle>Settings</SheetTitle>
                </SheetHeader>
                <SettingsPanel
                  account={accountSecurity}
                  accountRefreshState={settingsAccountRefreshState}
                  runnerCommand={runnerCommand}
                  runnerInstallMetadata={runnerInstallMetadata}
                  runnerCommandPlugins={runnerCommandPlugins}
                  runnerCustomPlugin={runnerCustomPlugin}
                  runnerCommandAgentPlugins={runnerCommandAgentPlugins}
                  view={settingsView}
                  onViewChange={changeSettingsView}
                  projects={activeProjects}
                  currentProjectId={selectedProject?.id ?? ""}
                  projectId={settingsProjectId}
                  onProjectChange={setSettingsProjectId}
                  promptPresetsByProject={projectPromptPresetsByProject}
                  promptPresetStates={projectPromptPresetStates}
                  promptPresetErrorsByProject={
                    projectPromptPresetErrorsByProject
                  }
                  onRefreshPromptPresets={refreshProjectPromptPresets}
                  onNewPromptPreset={(projectId) =>
                    openSettingsPromptPresetEditor(projectId)
                  }
                  onEditPromptPreset={(projectId, preset) =>
                    openSettingsPromptPresetEditor(projectId, preset)
                  }
                  onDeletePromptPreset={removePromptPreset}
                  onReorderPromptPresets={reorderPromptPresets}
                  onLogout={logoutFromAccountSecurity}
                  onLogoutAll={logoutAllFromAccountSecurity}
                  onChangePassword={changePasswordFromAccountSecurity}
                  onRegenerateRunnerToken={regenerateRunnerTokenFromSettings}
                  onToggleRunnerCommandPlugin={toggleRunnerCommandPlugin}
                  onRunnerCustomPluginChange={setRunnerCustomPlugin}
                />
              </SheetContent>
            </Sheet>

            <AppCommandPalette
              open={commandPaletteOpen}
              onOpenChange={setCommandPaletteOpen}
              projects={activeProjects}
              sessions={state.sessions}
              files={sessionFiles}
              selectedProjectId={selectedProject?.id ?? ""}
              selectedSessionId={selectedSession?.id ?? ""}
              onSelectProject={selectProject}
              onSelectSession={setSelectedSessionId}
              onSelectFile={(path) => {
                setActiveTab("files");
                selectFile(path);
              }}
              onOpenTab={setActiveTab}
              onOpenSettings={(view) => openSettingsDrawer(view)}
              onNewSession={() => {
                setMobileSessionModalOpen(true);
                setCommandPaletteOpen(false);
              }}
            />
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
    </TooltipProvider>
  );
}

function RunnerCommandBuilder({
  command,
  installMetadata,
  selectedPlugins,
  customPlugin,
  effectivePlugins,
  tokenReady,
  onTogglePlugin,
  onCustomPluginChange,
}: {
  command: string;
  installMetadata: InstallMetadata;
  selectedPlugins: string[];
  customPlugin: string;
  effectivePlugins: string[];
  tokenReady: boolean;
  onTogglePlugin: (packageName: string) => void;
  onCustomPluginChange: (packageName: string) => void;
}) {
  const canCopy = tokenReady && effectivePlugins.length > 0;
  const copy = () => {
    if (!canCopy) {
      return;
    }
    void navigator.clipboard?.writeText(command);
  };

  return (
    <div className="runner-command-display runner-command-builder">
      <div className="runner-plugin-picker" aria-label="Runner agent plugins">
        {installMetadata.officialAgentPlugins.length > 0 ? (
          installMetadata.officialAgentPlugins.map((plugin) => (
            <label className="runner-plugin-option" key={plugin.packageName}>
              <input
                type="checkbox"
                checked={selectedPlugins.includes(plugin.packageName)}
                onChange={() => onTogglePlugin(plugin.packageName)}
              />
              <span>
                {plugin.label}
                <small>{plugin.packageName}</small>
              </span>
            </label>
          ))
        ) : (
          <p className="settings-meta">
            Official plugin metadata is unavailable.
          </p>
        )}
        <label className="runner-custom-plugin">
          <span>Custom plugin package</span>
          <input
            className="text-input"
            type="text"
            value={customPlugin}
            onChange={(event) => onCustomPluginChange(event.target.value)}
            placeholder="@vendor/roam-agent-plugin"
          />
        </label>
      </div>
      {effectivePlugins.length === 0 ? (
        <p className="form-error" role="alert">
          Select or enter at least one agent plugin before copying the command.
        </p>
      ) : null}
      <pre>{command}</pre>
      <button
        className="small-button runner-command-copy"
        type="button"
        onClick={copy}
        disabled={!canCopy}
      >
        <Copy size={14} />
        Copy command
      </button>
    </div>
  );
}

function ApiConnectionBanner({
  onOpenConnection,
}: {
  onOpenConnection: () => void;
}) {
  return (
    <div className="chat-api-error-banner" role="status">
      <div>
        <span>API connection failed</span>
        <p>Reconnect the backend route or update connection settings.</p>
      </div>
      <button className="small-button" type="button" onClick={onOpenConnection}>
        <WifiOff size={16} />
        Connection settings
      </button>
    </div>
  );
}

type CommandPaletteFile = {
  path: string;
  name: string;
};

function AppCommandPalette({
  open,
  onOpenChange,
  projects,
  sessions,
  files,
  selectedProjectId,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
  onSelectFile,
  onOpenTab,
  onOpenSettings,
  onNewSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  sessions: Session[];
  files: FileNode[];
  selectedProjectId: string;
  selectedSessionId: string;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSelectFile: (path: string) => void;
  onOpenTab: (tab: WorkspaceTab) => void;
  onOpenSettings: (view?: SettingsView) => void;
  onNewSession: () => void;
}) {
  const activeProjectIds = useMemo(
    () => new Set(projects.map((project) => project.id)),
    [projects],
  );
  const visibleSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !session.archivedAt && activeProjectIds.has(session.projectId),
      ),
    [activeProjectIds, sessions],
  );
  const fileItems = useMemo(() => flattenCommandFiles(files), [files]);
  const close = () => onOpenChange(false);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command Palette"
      description="Search projects, sessions, files, and actions."
      className="command-palette-dialog"
      showCloseButton
    >
      <Command shouldFilter>
        <CommandInput placeholder="Search or run command..." />
        <CommandList>
          <CommandEmpty>No command found.</CommandEmpty>
          <CommandGroup heading="Projects">
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                value={`project ${project.name} ${project.directory}`}
                onSelect={() => {
                  onSelectProject(project.id);
                  close();
                }}
              >
                <FolderOpen />
                <span>{project.name}</span>
                {project.id === selectedProjectId ? (
                  <span className="command-item-meta">Current</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Sessions">
            {visibleSessions.map((session) => (
              <CommandItem
                key={session.id}
                value={`session ${session.title} ${session.cwd}`}
                onSelect={() => {
                  onSelectSession(session.id);
                  onOpenTab("chat");
                  close();
                }}
              >
                <BookOpen />
                <span>{session.title}</span>
                {session.id === selectedSessionId ? (
                  <span className="command-item-meta">Current</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
          {fileItems.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Files">
                {fileItems.map((file) => (
                  <CommandItem
                    key={file.path}
                    value={`file ${file.path}`}
                    onSelect={() => {
                      onSelectFile(file.path);
                      close();
                    }}
                  >
                    <FolderOpen />
                    <span>{file.name}</span>
                    <span className="command-item-meta">{file.path}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem
              value="new session create session"
              onSelect={() => {
                onNewSession();
                close();
              }}
            >
              <Plus />
              <span>New Session</span>
            </CommandItem>
            <CommandItem
              value="open files panel"
              onSelect={() => {
                onOpenTab("files");
                close();
              }}
            >
              <FolderOpen />
              <span>Open Files</span>
            </CommandItem>
            <CommandItem
              value="open git panel"
              onSelect={() => {
                onOpenTab("git");
                close();
              }}
            >
              <RefreshCw />
              <span>Open Git</span>
            </CommandItem>
            <CommandItem
              value="open approvals panel"
              onSelect={() => {
                onOpenTab("approvals");
                close();
              }}
            >
              <ShieldCheck />
              <span>Open Approvals</span>
            </CommandItem>
            <CommandItem
              value="settings account security"
              onSelect={() => {
                onOpenSettings("home");
                close();
              }}
            >
              <Settings />
              <span>Open Settings</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

function flattenCommandFiles(nodes: FileNode[]): CommandPaletteFile[] {
  const files: CommandPaletteFile[] = [];
  const visit = (items: FileNode[]) => {
    for (const item of items) {
      if (item.type === "file") {
        files.push({ path: item.path, name: item.name });
      }
      if (item.children) {
        visit(item.children);
      }
    }
  };
  visit(nodes);
  return files;
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

const ACTIVE_RUNNER_STATUSES = new Set<SessionStatus>([
  "pending",
  "running",
  "waiting_approval",
  "waiting_input",
]);

function hasActiveRunnerWork(session: Session): boolean {
  return ACTIVE_RUNNER_STATUSES.has(session.status);
}

function SessionArchiveDialog({
  state,
  onClose,
  onSubmit,
}: {
  state: SessionArchiveDialogState;
  onClose: () => void;
  onSubmit: (worktree: "keep" | "remove") => Promise<void>;
}) {
  const { session, error, submitting } = state;
  const canRemoveWorktree =
    session.executionMode === "managed_worktree" &&
    !session.worktreeDeletedAt &&
    !hasActiveRunnerWork(session);
  const titleId = "session-archive-title";

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (!submitting && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="modal-panel session-archive-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <div>
            <h2 id={titleId}>Archive session</h2>
            <p className="archive-dialog-subtitle">{session.title}</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close archive dialog"
            onClick={onClose}
            disabled={Boolean(submitting)}
          >
            <X size={16} />
          </button>
        </div>

        <div className="archive-dialog-content">
          {canRemoveWorktree ? (
            <>
              <p>
                This session uses a managed Git worktree. Archiving can remove
                the worktree from disk while keeping the branch.
              </p>
              <code className="archive-dialog-path">
                {session.executionFolder}
              </code>
              <p className="archive-dialog-warning">
                Removing the worktree discards uncommitted files inside that
                worktree.
              </p>
            </>
          ) : (
            <p>
              This hides the session from active lists. Messages, approvals, and
              artifacts stay stored.
            </p>
          )}
          {error ? (
            <div className="archive-dialog-error" role="alert">
              <strong>
                {canRemoveWorktree
                  ? "Worktree cleanup failed."
                  : "Archive failed."}
              </strong>
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <div className="archive-dialog-actions">
          {canRemoveWorktree ? (
            <button
              className="small-button reject"
              type="button"
              onClick={() => void onSubmit("remove")}
              disabled={Boolean(submitting)}
            >
              {submitting === "remove" ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
              <span>{error ? "Retry remove" : "Archive and remove"}</span>
            </button>
          ) : null}
          <button
            className="small-button"
            type="button"
            onClick={() => void onSubmit("keep")}
            disabled={Boolean(submitting)}
          >
            {submitting === "keep" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : canRemoveWorktree ? (
              <FolderOpen size={14} />
            ) : (
              <Archive size={14} />
            )}
            <span>
              {canRemoveWorktree ? "Archive only" : "Archive session"}
            </span>
          </button>
          <button
            className="small-button"
            type="button"
            onClick={onClose}
            disabled={Boolean(submitting)}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

function SettingsPanel({
  account,
  accountRefreshState,
  runnerCommand,
  runnerInstallMetadata,
  runnerCommandPlugins,
  runnerCustomPlugin,
  runnerCommandAgentPlugins,
  view,
  onViewChange,
  projects,
  currentProjectId,
  projectId,
  onProjectChange,
  promptPresetsByProject,
  promptPresetStates,
  promptPresetErrorsByProject,
  onRefreshPromptPresets,
  onNewPromptPreset,
  onEditPromptPreset,
  onDeletePromptPreset,
  onReorderPromptPresets,
  onLogout,
  onLogoutAll,
  onChangePassword,
  onRegenerateRunnerToken,
  onToggleRunnerCommandPlugin,
  onRunnerCustomPluginChange,
}: {
  account: AccountSecurityState | undefined;
  accountRefreshState: AccountRefreshState;
  runnerCommand: string;
  runnerInstallMetadata: InstallMetadata;
  runnerCommandPlugins: string[];
  runnerCustomPlugin: string;
  runnerCommandAgentPlugins: string[];
  view: SettingsView;
  onViewChange: (view: SettingsView) => void;
  projects: Project[];
  currentProjectId: string;
  projectId: string;
  onProjectChange: (projectId: string) => void;
  promptPresetsByProject: Record<string, ProjectPromptPreset[]>;
  promptPresetStates: Record<string, AsyncState>;
  promptPresetErrorsByProject: Record<string, string>;
  onRefreshPromptPresets: (projectId: string) => Promise<ProjectPromptPreset[]>;
  onNewPromptPreset: (projectId: string) => void;
  onEditPromptPreset: (projectId: string, preset: ProjectPromptPreset) => void;
  onDeletePromptPreset: (
    projectId: string,
    preset: ProjectPromptPreset,
  ) => Promise<boolean>;
  onReorderPromptPresets: (
    projectId: string,
    presetIds: string[],
  ) => Promise<void>;
  onLogout: () => Promise<void>;
  onLogoutAll: () => Promise<void>;
  onChangePassword: (input: ApiChangePassword) => Promise<void>;
  onRegenerateRunnerToken: () => Promise<void>;
  onToggleRunnerCommandPlugin: (packageName: string) => void;
  onRunnerCustomPluginChange: (packageName: string) => void;
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
              icon={<BookOpen size={18} />}
              title="Project Settings"
              description="Project prompt presets and reusable instructions"
              onClick={() => onViewChange("project")}
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
              runnerInstallMetadata={runnerInstallMetadata}
              runnerCommandPlugins={runnerCommandPlugins}
              runnerCustomPlugin={runnerCustomPlugin}
              runnerCommandAgentPlugins={runnerCommandAgentPlugins}
              onChangePasswordOpen={() => onViewChange("change-password")}
              onLogout={onLogout}
              onLogoutAll={onLogoutAll}
              onRegenerateRunnerToken={onRegenerateRunnerToken}
              onToggleRunnerCommandPlugin={onToggleRunnerCommandPlugin}
              onRunnerCustomPluginChange={onRunnerCustomPluginChange}
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

      {view === "project" ? (
        <>
          <SettingsDetailHeader
            title="Project Settings"
            onBack={() => onViewChange("home")}
          />
          <ProjectSettingsPanel
            projects={projects}
            currentProjectId={currentProjectId}
            projectId={projectId}
            onProjectChange={onProjectChange}
            promptPresetsByProject={promptPresetsByProject}
            promptPresetStates={promptPresetStates}
            promptPresetErrorsByProject={promptPresetErrorsByProject}
            onRefreshPromptPresets={onRefreshPromptPresets}
            onNewPromptPreset={onNewPromptPreset}
            onEditPromptPreset={onEditPromptPreset}
            onDeletePromptPreset={onDeletePromptPreset}
            onReorderPromptPresets={onReorderPromptPresets}
          />
        </>
      ) : null}
    </section>
  );
}

function ProjectSettingsPanel({
  projects,
  currentProjectId,
  projectId,
  onProjectChange,
  promptPresetsByProject,
  promptPresetStates,
  promptPresetErrorsByProject,
  onRefreshPromptPresets,
  onNewPromptPreset,
  onEditPromptPreset,
  onDeletePromptPreset,
  onReorderPromptPresets,
}: {
  projects: Project[];
  currentProjectId: string;
  projectId: string;
  onProjectChange: (projectId: string) => void;
  promptPresetsByProject: Record<string, ProjectPromptPreset[]>;
  promptPresetStates: Record<string, AsyncState>;
  promptPresetErrorsByProject: Record<string, string>;
  onRefreshPromptPresets: (projectId: string) => Promise<ProjectPromptPreset[]>;
  onNewPromptPreset: (projectId: string) => void;
  onEditPromptPreset: (projectId: string, preset: ProjectPromptPreset) => void;
  onDeletePromptPreset: (
    projectId: string,
    preset: ProjectPromptPreset,
  ) => Promise<boolean>;
  onReorderPromptPresets: (
    projectId: string,
    presetIds: string[],
  ) => Promise<void>;
}) {
  const selectedProject = projects.find((project) => project.id === projectId);
  const selectedProjectId = selectedProject?.id ?? "";
  const presets = selectedProjectId
    ? (promptPresetsByProject[selectedProjectId] ?? [])
    : [];
  const promptPresetState = selectedProjectId
    ? (promptPresetStates[selectedProjectId] ?? "idle")
    : "idle";
  const sharedRefreshError = selectedProjectId
    ? promptPresetErrorsByProject[selectedProjectId]
    : undefined;
  const [refreshError, setRefreshError] = useState("");
  const [presetSearchQuery, setPresetSearchQuery] = useState("");
  const trimmedPresetSearchQuery = presetSearchQuery.trim().toLowerCase();
  const filteredPresets = useMemo(() => {
    if (!trimmedPresetSearchQuery) {
      return presets;
    }
    return presets.filter((preset) => {
      const title = preset.title.toLowerCase();
      const content = preset.content.toLowerCase();
      return (
        title.includes(trimmedPresetSearchQuery) ||
        content.includes(trimmedPresetSearchQuery)
      );
    });
  }, [presets, trimmedPresetSearchQuery]);
  const searchActive = trimmedPresetSearchQuery.length > 0;

  const refresh = useCallback(async () => {
    if (!selectedProjectId) {
      return;
    }
    setRefreshError("");
    try {
      await onRefreshPromptPresets(selectedProjectId);
    } catch (refreshFailure: unknown) {
      setRefreshError(errorMessage(refreshFailure));
    }
  }, [onRefreshPromptPresets, selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId && promptPresetState === "idle") {
      void refresh();
    }
  }, [promptPresetState, refresh, selectedProjectId]);

  useEffect(() => {
    setPresetSearchQuery("");
    setRefreshError("");
  }, [selectedProjectId]);

  if (projects.length === 0) {
    return (
      <div className="settings-detail project-settings-panel">
        <div className="empty-state compact">No active projects.</div>
      </div>
    );
  }

  return (
    <div className="settings-detail project-settings-panel">
      <section className="settings-section project-selector-section">
        <label className="field" htmlFor="settings-project-selector">
          <span>Project</span>
          <select
            id="settings-project-selector"
            value={selectedProjectId}
            onChange={(event) => onProjectChange(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.id === currentProjectId ? " (Current)" : ""}
              </option>
            ))}
          </select>
        </label>
        {selectedProject ? (
          <p className="settings-meta project-current-meta">
            {selectedProject.id === currentProjectId
              ? "Highlighted as the current workspace project."
              : "Changing this selector only changes Settings context."}
          </p>
        ) : null}
      </section>

      <section className="settings-section prompt-presets-section">
        <div className="prompt-presets-header">
          <div>
            <h3>Prompt Presets</h3>
            <p className="settings-meta">
              Reusable project instructions available from session composers.
            </p>
          </div>
          <div className="button-row prompt-presets-actions">
            <button
              className="small-button"
              type="button"
              onClick={() => void refresh()}
              disabled={!selectedProjectId || promptPresetState === "loading"}
            >
              <RefreshCw
                size={14}
                className={
                  promptPresetState === "loading" ? "animate-spin" : undefined
                }
              />
              Refresh
            </button>
            <button
              className="small-button"
              type="button"
              onClick={() => onNewPromptPreset(selectedProjectId)}
              disabled={!selectedProjectId}
            >
              <Plus size={14} />
              New
            </button>
          </div>
        </div>

        {refreshError || sharedRefreshError ? (
          <div className="form-error" role="alert">
            {refreshError || sharedRefreshError}
          </div>
        ) : null}

        <label className="prompt-preset-search">
          <span>Search prompt presets</span>
          <input
            type="search"
            value={presetSearchQuery}
            onChange={(event) => setPresetSearchQuery(event.target.value)}
            placeholder="Search title or content"
            disabled={!selectedProjectId || presets.length === 0}
          />
        </label>

        <PromptPresetList
          projectId={selectedProjectId}
          presets={filteredPresets}
          state={promptPresetState}
          reorderEnabled={!searchActive}
          emptyMessage={
            searchActive
              ? "No prompt presets match this search."
              : "No prompt presets for this project."
          }
          onEdit={(preset) => onEditPromptPreset(selectedProjectId, preset)}
          onDelete={(preset) =>
            void onDeletePromptPreset(selectedProjectId, preset)
          }
          onReorder={(presetIds) =>
            onReorderPromptPresets(selectedProjectId, presetIds)
          }
        />
      </section>
    </div>
  );
}

function PromptPresetList({
  projectId,
  presets,
  state,
  reorderEnabled,
  emptyMessage,
  onEdit,
  onDelete,
  onReorder,
}: {
  projectId: string;
  presets: ProjectPromptPreset[];
  state: AsyncState;
  reorderEnabled: boolean;
  emptyMessage: string;
  onEdit: (preset: ProjectPromptPreset) => void;
  onDelete: (preset: ProjectPromptPreset) => void;
  onReorder: (presetIds: string[]) => Promise<void>;
}) {
  const [reorderPending, setReorderPending] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    if (reorderPending || !reorderEnabled) {
      return;
    }
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = presets.findIndex((preset) => preset.id === active.id);
    const newIndex = presets.findIndex((preset) => preset.id === over.id);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const nextPresetIds = arrayMove(presets, oldIndex, newIndex).map(
      (preset) => preset.id,
    );
    setReorderPending(true);
    void onReorder(nextPresetIds)
      .finally(() => {
        setReorderPending(false);
      })
      .catch(() => undefined);
  };

  if (!projectId) {
    return <div className="empty-state compact">Select a project.</div>;
  }

  if (state === "loading" && presets.length === 0) {
    return <div className="empty-state compact">Loading prompt presets...</div>;
  }

  if (presets.length === 0) {
    return <div className="empty-state compact">{emptyMessage}</div>;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={presets.map((preset) => preset.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          className="prompt-preset-list"
          role="list"
          aria-busy={reorderPending || undefined}
        >
          {presets.map((preset) => (
            <SortablePromptPresetRow
              key={preset.id}
              preset={preset}
              reorderDisabled={reorderPending || !reorderEnabled}
              onEdit={() => onEdit(preset)}
              onDelete={() => onDelete(preset)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortablePromptPresetRow({
  preset,
  reorderDisabled,
  onEdit,
  onDelete,
}: {
  preset: ProjectPromptPreset;
  reorderDisabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: preset.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <article
      ref={setNodeRef}
      className={`prompt-preset-row ${isDragging ? "is-dragging" : ""}`}
      style={style}
      role="listitem"
    >
      <button
        className="prompt-preset-drag-handle"
        type="button"
        aria-label={`Drag prompt preset ${preset.title}`}
        disabled={reorderDisabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      <button className="prompt-preset-row-main" type="button" onClick={onEdit}>
        <span className="prompt-preset-row-title">{preset.title}</span>
        <span className="prompt-preset-row-content">
          {singleLinePreview(preset.content)}
        </span>
        <span className="prompt-preset-row-meta">
          Updated {formatDate(preset.updatedAt)}
        </span>
      </button>
      <details className="prompt-preset-row-actions">
        <summary aria-label={`Actions for ${preset.title}`}>
          <MoreHorizontal size={16} />
        </summary>
        <div className="prompt-preset-row-menu" role="menu">
          <button type="button" role="menuitem" onClick={onEdit}>
            Edit
          </button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </details>
    </article>
  );
}

function PromptPresetEditorDialog({
  state,
  project,
  onClose,
  onSave,
  onDelete,
}: {
  state: PromptPresetEditorState;
  project: Project | undefined;
  onClose: () => void;
  onSave: (
    projectId: string,
    presetId: string | undefined,
    input: ApiCreateProjectPromptPreset | ApiUpdateProjectPromptPreset,
  ) => Promise<void>;
  onDelete: (
    projectId: string,
    preset: ProjectPromptPreset,
  ) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState<"save" | "delete" | "">("");
  const titleId = "prompt-preset-editor-title";
  const isEditing = Boolean(state.preset);

  useEffect(() => {
    setTitle(state.preset?.title ?? state.initialTitle ?? "");
    setContent(state.preset?.content ?? state.initialContent ?? "");
    setError("");
    setSubmitting("");
  }, [
    state.initialContent,
    state.initialTitle,
    state.preset?.content,
    state.preset?.id,
    state.preset?.title,
  ]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!project) {
      return;
    }

    const cleanTitle = title.trim();
    const cleanContent = content.trim();
    if (!cleanTitle) {
      setError("Title is required.");
      return;
    }
    if (!cleanContent) {
      setError("Prompt content is required.");
      return;
    }
    if (cleanTitle.length > PROJECT_PROMPT_PRESET_TITLE_MAX_LENGTH) {
      setError(
        `Title must be ${PROJECT_PROMPT_PRESET_TITLE_MAX_LENGTH} characters or less.`,
      );
      return;
    }
    if (cleanContent.length > PROJECT_PROMPT_PRESET_CONTENT_MAX_LENGTH) {
      setError(
        `Prompt content must be ${PROJECT_PROMPT_PRESET_CONTENT_MAX_LENGTH} characters or less.`,
      );
      return;
    }

    setSubmitting("save");
    setError("");
    try {
      await onSave(project.id, state.preset?.id, {
        title: cleanTitle,
        content: cleanContent,
      });
    } catch (saveError: unknown) {
      setError(errorMessage(saveError));
    } finally {
      setSubmitting("");
    }
  };

  const deletePreset = async () => {
    if (!project || !state.preset) {
      return;
    }
    setSubmitting("delete");
    setError("");
    try {
      const deleted = await onDelete(project.id, state.preset);
      if (deleted) {
        onClose();
      }
    } catch (deleteError: unknown) {
      setError(errorMessage(deleteError));
    } finally {
      setSubmitting("");
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (!submitting && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="modal-panel prompt-preset-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <form onSubmit={(event) => void submit(event)}>
          <div className="modal-header">
            <div>
              <h2 id={titleId}>
                {isEditing ? "Edit Prompt Preset" : "New Prompt Preset"}
              </h2>
              <p className="archive-dialog-subtitle">
                {project?.name ?? "Project unavailable"}
              </p>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Close prompt preset editor"
              onClick={onClose}
              disabled={Boolean(submitting)}
            >
              <X size={16} />
            </button>
          </div>

          <div className="prompt-preset-editor-content">
            {!project ? (
              <div className="form-error" role="alert">
                The selected project is no longer available.
              </div>
            ) : null}
            <label className="field">
              <span>Title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={PROJECT_PROMPT_PRESET_TITLE_MAX_LENGTH}
                required
                disabled={!project || Boolean(submitting)}
              />
            </label>
            <label className="field">
              <span>Content</span>
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                maxLength={PROJECT_PROMPT_PRESET_CONTENT_MAX_LENGTH}
                required
                disabled={!project || Boolean(submitting)}
              />
            </label>
            <p className="settings-meta prompt-preset-editor-count">
              {content.length}/{PROJECT_PROMPT_PRESET_CONTENT_MAX_LENGTH}
            </p>
            {error ? (
              <div className="form-error" role="alert">
                {error}
              </div>
            ) : null}
          </div>

          <div className="archive-dialog-actions prompt-preset-editor-actions">
            {state.preset ? (
              <button
                className="small-button danger"
                type="button"
                onClick={() => void deletePreset()}
                disabled={Boolean(submitting)}
              >
                {submitting === "delete" ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
                Delete
              </button>
            ) : null}
            <button
              className="small-button"
              type="button"
              onClick={onClose}
              disabled={Boolean(submitting)}
            >
              Cancel
            </button>
            <button
              className="small-button accept"
              type="submit"
              disabled={!project || Boolean(submitting)}
            >
              {submitting === "save" ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <BookmarkPlus size={14} />
              )}
              Save
            </button>
          </div>
        </form>
      </section>
    </div>
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
  runnerInstallMetadata,
  runnerCommandPlugins,
  runnerCustomPlugin,
  runnerCommandAgentPlugins,
  onChangePasswordOpen,
  onLogout,
  onLogoutAll,
  onRegenerateRunnerToken,
  onToggleRunnerCommandPlugin,
  onRunnerCustomPluginChange,
}: {
  account: AccountSecurityState;
  runnerCommand: string;
  runnerInstallMetadata: InstallMetadata;
  runnerCommandPlugins: string[];
  runnerCustomPlugin: string;
  runnerCommandAgentPlugins: string[];
  onChangePasswordOpen: () => void;
  onLogout: () => Promise<void>;
  onLogoutAll: () => Promise<void>;
  onRegenerateRunnerToken: () => Promise<void>;
  onToggleRunnerCommandPlugin: (packageName: string) => void;
  onRunnerCustomPluginChange: (packageName: string) => void;
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
        <RunnerCommandBuilder
          command={runnerCommand}
          installMetadata={runnerInstallMetadata}
          selectedPlugins={runnerCommandPlugins}
          customPlugin={runnerCustomPlugin}
          effectivePlugins={runnerCommandAgentPlugins}
          tokenReady={Boolean(account.runnerToken)}
          onTogglePlugin={onToggleRunnerCommandPlugin}
          onCustomPluginChange={onRunnerCustomPluginChange}
        />
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
  onToggleProjectPinned,
  onNewSession,
  onToggleSessionPinned,
}: {
  activeProjects: Project[];
  selectedProject: Project | undefined;
  selectedSession: Session | undefined;
  runnerSessions: Session[];
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewProject: () => void;
  onArchiveProject: (projectId: string) => void;
  onToggleProjectPinned: (
    projectId: string,
    pinned: boolean,
  ) => void | Promise<void>;
  onNewSession: () => void;
  onToggleSessionPinned: (
    sessionId: string,
    pinned: boolean,
  ) => void | Promise<void>;
}) {
  const [showAllSessions, setShowAllSessions] = useState(false);
  const orderedSessions = useMemo(
    () => sortSessionsForDisplay(runnerSessions),
    [runnerSessions],
  );
  const selectedSessionIndex = orderedSessions.findIndex(
    (session) => session.id === selectedSession?.id,
  );
  const selectedSessionPinned = Boolean(selectedSession?.pinnedAt);
  const pinnedSessionCount = orderedSessions.filter(
    (session) => session.pinnedAt,
  ).length;
  const selectedSessionPinDisabled = Boolean(
    selectedSession &&
    !selectedSessionPinned &&
    pinnedSessionCount >= MAX_PINNED_SESSIONS_PER_PROJECT,
  );
  const hasSessionOverflow =
    orderedSessions.length > DEFAULT_VISIBLE_SESSIONS_PER_PROJECT;
  const visibleSessions = showAllSessions
    ? orderedSessions
    : orderedSessions.slice(0, DEFAULT_VISIBLE_SESSIONS_PER_PROJECT);

  useEffect(() => {
    setShowAllSessions(
      selectedSessionIndex >= DEFAULT_VISIBLE_SESSIONS_PER_PROJECT,
    );
  }, [selectedProject?.id, selectedSessionIndex]);

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
            <>
              <button
                className={`mobile-icon-button ${selectedProject.pinnedAt ? "is-active" : ""}`}
                type="button"
                aria-label={`${selectedProject.pinnedAt ? "Unpin" : "Pin"} selected project ${selectedProject.name}`}
                title={
                  selectedProject.pinnedAt ? "Unpin project" : "Pin project"
                }
                onClick={() =>
                  runAsyncAction(() =>
                    onToggleProjectPinned(
                      selectedProject.id,
                      !selectedProject.pinnedAt,
                    ),
                  )
                }
              >
                {selectedProject.pinnedAt ? (
                  <PinOff size={15} />
                ) : (
                  <Pin size={15} />
                )}
              </button>
              <button
                className="mobile-icon-button danger"
                type="button"
                aria-label={`Archive selected project ${selectedProject.name}`}
                title="Archive project"
                onClick={() => onArchiveProject(selectedProject.id)}
              >
                <Trash2 size={15} />
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="mobile-session-section">
        <div className="mobile-session-header">
          <span>Session</span>
        </div>
        <div
          className="mobile-session-list"
          role="group"
          aria-label="Mobile sessions"
        >
          {!selectedProject || orderedSessions.length === 0 ? (
            <div className="empty-state compact tree-empty-state">
              No sessions
            </div>
          ) : (
            <>
              {visibleSessions.map((session) => (
                <button
                  key={session.id}
                  className={`mobile-session-button ${session.id === selectedSession?.id ? "is-selected" : ""}`}
                  type="button"
                  onClick={() => onSelectSession(session.id)}
                >
                  <span className="truncate">{session.title}</span>
                  <StatusPill status={session.status} />
                </button>
              ))}
              {hasSessionOverflow ? (
                <button
                  className="tree-session-more-button mobile-session-more-button"
                  type="button"
                  onClick={() => setShowAllSessions((current) => !current)}
                >
                  {showAllSessions ? "收起" : "查看更多"}
                </button>
              ) : null}
            </>
          )}
        </div>
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
          {selectedSession ? (
            <button
              className={`mobile-icon-button ${selectedSessionPinned ? "is-active" : ""}`}
              type="button"
              aria-label={`${selectedSessionPinned ? "Unpin" : "Pin"} selected session ${selectedSession.title}`}
              disabled={selectedSessionPinDisabled}
              title={
                selectedSessionPinDisabled
                  ? "最多只能置顶 3 个 session"
                  : selectedSessionPinned
                    ? "Unpin session"
                    : "Pin session"
              }
              onClick={() =>
                runAsyncAction(() =>
                  onToggleSessionPinned(
                    selectedSession.id,
                    !selectedSessionPinned,
                  ),
                )
              }
            >
              {selectedSessionPinned ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function runAsyncAction(action: () => void | Promise<void>) {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // The controller owns user-visible error state for these actions.
  }
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

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function promptTitleFromMessage(content: string): string {
  const firstLine =
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "Prompt from message";
  return firstLine.replace(/\s+/g, " ").slice(0, 48) || "Prompt from message";
}

function singleLinePreview(content: string): string {
  return content.replace(/\s+/g, " ").trim() || "Empty prompt";
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
