import { DiffEditor } from "@monaco-editor/react";
import type {
  ApiGitCommit,
  ApiGitContext,
  ApiGitFileDiffQuery,
  ApiGitHistoryQuery,
  ApiGitInit,
  ApiGitPaths,
  ApiGitRemoteOperation,
  ApiGitRemoveWorktree,
  GitBranchList,
  GitChange,
  GitChangeGroup,
  GitCommitPage,
  GitCommitSummary,
  GitFileDiff,
  GitJob,
  GitStatus,
  GitStatusResult,
  Project,
  Session,
} from "@roamcli/shared/protocol";
import {
  Check,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  List,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";

type AsyncState = "idle" | "loading" | "ready" | "error";
type GitTab = "changes" | "history" | "branch";
type ChangeViewMode = "tree" | "list";
const GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type GitContextOption = {
  key: string;
  label: string;
  context: ApiGitContext;
  isDefault: boolean;
};

type Notify = (
  tone: "success" | "error",
  title: string,
  message: string,
) => void;

type GitPanelProps = {
  active: boolean;
  project: Project | undefined;
  runnerOnline: boolean;
  sessions: Session[];
  defaultContext: ApiGitContext | undefined;
  onFetchStatus: (context: ApiGitContext) => Promise<GitStatusResult>;
  onFetchDiff: (query: ApiGitFileDiffQuery) => Promise<GitFileDiff>;
  onFetchHistory: (query: ApiGitHistoryQuery) => Promise<GitCommitPage>;
  onFetchBranches: (context: ApiGitContext) => Promise<GitBranchList>;
  onInitRepository: (input: ApiGitInit) => Promise<GitJob>;
  onStagePaths: (input: ApiGitPaths) => Promise<GitJob>;
  onUnstagePaths: (input: ApiGitPaths) => Promise<GitJob>;
  onDiscardPaths: (input: ApiGitPaths) => Promise<GitJob>;
  onCommit: (input: ApiGitCommit) => Promise<GitJob>;
  onRemoteOperation: (input: ApiGitRemoteOperation) => Promise<GitJob>;
  onRemoveWorktree: (input: ApiGitRemoveWorktree) => Promise<GitJob>;
  canOpenFileForEdit: boolean;
  onOpenFileForEdit: (path: string) => void;
  onNotify: Notify;
};

export function GitPanel({
  active,
  project,
  runnerOnline,
  sessions,
  defaultContext,
  onFetchStatus,
  onFetchDiff,
  onFetchHistory,
  onFetchBranches,
  onInitRepository,
  onStagePaths,
  onUnstagePaths,
  onDiscardPaths,
  onCommit,
  onRemoteOperation,
  onRemoveWorktree,
  canOpenFileForEdit,
  onOpenFileForEdit,
  onNotify,
}: GitPanelProps) {
  const defaultContextKey = defaultContext ? contextKey(defaultContext) : "";
  const [selectedContextKey, setSelectedContextKey] =
    useState(defaultContextKey);
  const [activeTab, setActiveTab] = useState<GitTab>("changes");
  const [statusResult, setStatusResult] = useState<
    GitStatusResult | undefined
  >();
  const [statusState, setStatusState] = useState<AsyncState>("idle");
  const [statusError, setStatusError] = useState("");
  const [branches, setBranches] = useState<GitBranchList | undefined>();
  const [branchesState, setBranchesState] = useState<AsyncState>("idle");
  const [branchesError, setBranchesError] = useState("");
  const [historyPage, setHistoryPage] = useState<GitCommitPage | undefined>();
  const [historyState, setHistoryState] = useState<AsyncState>("idle");
  const [historyError, setHistoryError] = useState("");
  const [selectedCommitSha, setSelectedCommitSha] = useState("");
  const [selectedCommitPath, setSelectedCommitPath] = useState("");
  const [selectedChange, setSelectedChange] = useState<GitChange | undefined>();
  const [diff, setDiff] = useState<GitFileDiff | undefined>();
  const [diffState, setDiffState] = useState<AsyncState>("idle");
  const [diffError, setDiffError] = useState("");
  const [jobState, setJobState] = useState<AsyncState>("idle");
  const [jobError, setJobError] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [changeViewMode, setChangeViewMode] = usePersistentChangeViewMode();
  const [diffEditorMounted, setDiffEditorMounted] = useState(active);
  const panelRef = useRef<HTMLElement | null>(null);
  const statusContextKeyRef = useRef("");
  const historyScopeRef = useRef("");
  const statusRequestSequenceRef = useRef(0);
  const compactDiff = useCompactDiff(panelRef);

  useEffect(() => {
    if (active) {
      setDiffEditorMounted(true);
    }
  }, [active]);

  useEffect(() => {
    setSelectedContextKey(defaultContextKey);
  }, [defaultContextKey]);

  const contextOptions = useMemo(
    () => buildContextOptions(project, sessions, defaultContextKey),
    [defaultContextKey, project, sessions],
  );
  const activeContextKey = selectedContextKey || defaultContextKey;
  const selectedContextOption = contextOptions.find(
    (option) => option.key === activeContextKey,
  );
  const selectedContext =
    contextFromKey(selectedContextKey, contextOptions) ?? defaultContext;
  const selectedContextIdentity = selectedContext
    ? contextKey(selectedContext)
    : "";
  const selectedContextMatchesDefault =
    defaultContext !== undefined &&
    selectedContextIdentity === defaultContextKey;
  const status = isRepositoryStatus(statusResult) ? statusResult : undefined;
  const nonGitStatus =
    statusResult?.kind === "not_git_repository" ? statusResult : undefined;
  const historyScope = status
    ? `${selectedContextIdentity}:${historyRef(status)}:${status.headSha ?? ""}`
    : selectedContextIdentity;
  const stagedChanges =
    status?.groups.find((group) => group.id === "staged")?.changes ?? [];
  const selectedCommit = historyPage?.commits.find(
    (commit) => commit.sha === selectedCommitSha,
  );
  const selectedCommitFile = selectedCommit?.files?.find(
    (file) => file.path === selectedCommitPath,
  );
  const selectedMode = selectedChange?.staged ? "staged" : "working_tree";
  const diffTarget =
    selectedContext &&
    activeTab === "history" &&
    selectedCommit &&
    selectedCommitFile
      ? {
          key: [
            "history",
            selectedCommit.sha,
            selectedCommit.parents[0] ?? GIT_EMPTY_TREE_SHA,
            selectedCommitFile.oldPath ?? "",
            selectedCommitFile.path,
          ].join(":"),
          query: {
            context: selectedContext,
            path: selectedCommitFile.path,
            ...(selectedCommitFile.oldPath
              ? { oldPath: selectedCommitFile.oldPath }
              : {}),
            mode: "commit",
            oldRef: selectedCommit.parents[0] ?? GIT_EMPTY_TREE_SHA,
            newRef: selectedCommit.sha,
          } satisfies Partial<ApiGitFileDiffQuery>,
        }
      : selectedContext && activeTab === "changes" && selectedChange
        ? {
            key: [
              "changes",
              selectedMode,
              selectedChange.oldPath ?? "",
              selectedChange.path,
            ].join(":"),
            query: {
              context: selectedContext,
              path: selectedChange.path,
              ...(selectedChange.oldPath
                ? { oldPath: selectedChange.oldPath }
                : {}),
              mode: selectedMode,
            } satisfies Partial<ApiGitFileDiffQuery>,
          }
        : undefined;
  const diffTargetQuery = diffTarget?.query as
    | Partial<ApiGitFileDiffQuery>
    | undefined;
  const hasCurrentDiff =
    diffTarget !== undefined &&
    diffTargetQuery !== undefined &&
    diffState === "ready" &&
    diff !== undefined &&
    diff.path === diffTargetQuery.path &&
    diff.mode === diffTargetQuery.mode &&
    optionalValue(diff.oldPath) === optionalValue(diffTargetQuery.oldPath) &&
    optionalValue(diff.oldRef) === optionalValue(diffTargetQuery.oldRef) &&
    optionalValue(diff.newRef) === optionalValue(diffTargetQuery.newRef);
  const showTextDiff = hasCurrentDiff && !diff.binary && !diff.tooLarge;
  const diffLanguage = showTextDiff
    ? (diff.language ?? "plaintext")
    : "plaintext";
  const fileActionBusy = jobState === "loading";
  const canEditSelectedDiff =
    activeTab === "changes" &&
    selectedChange !== undefined &&
    !selectedChange.staged &&
    selectedChange.status !== "deleted" &&
    canOpenFileForEdit &&
    selectedContextMatchesDefault &&
    showTextDiff;

  useLayoutEffect(() => {
    statusContextKeyRef.current = selectedContextIdentity;
    statusRequestSequenceRef.current += 1;
  }, [selectedContextIdentity]);

  useLayoutEffect(() => {
    historyScopeRef.current = historyScope;
  }, [historyScope]);

  useEffect(() => {
    if (!active) {
      return;
    }
    if (!selectedContext || !project || !runnerOnline) {
      setStatusResult(undefined);
      setStatusState("idle");
      return;
    }
    setStatusState("loading");
    setStatusError("");
    setBranches(undefined);
    setBranchesState("idle");
    setBranchesError("");
    setHistoryPage(undefined);
    setHistoryState("idle");
    setHistoryError("");
    setSelectedCommitSha("");
    setSelectedCommitPath("");
    setSelectedChange(undefined);
    setDiff(undefined);
    void reloadStatus(selectedContext);
    // reloadStatus maintains its own stale-response guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, project, runnerOnline, selectedContextIdentity]);

  useEffect(() => {
    if (!active || !selectedContext || !status) {
      setBranches(undefined);
      setBranchesState("idle");
      setBranchesError("");
      return;
    }
    let cancelled = false;
    setBranchesState("loading");
    setBranchesError("");
    void onFetchBranches(selectedContext)
      .then((nextBranches) => {
        if (cancelled) return;
        setBranches(nextBranches);
        setBranchesState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBranches(undefined);
        setBranchesState("error");
        setBranchesError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [onFetchBranches, active, selectedContext, status]);

  useEffect(() => {
    if (!active || activeTab !== "history" || !selectedContext || !status) {
      return;
    }
    setHistoryState("loading");
    setHistoryError("");
    setHistoryPage(undefined);
    setSelectedCommitSha("");
    setSelectedCommitPath("");
    if (status.unborn) {
      setHistoryState("ready");
      return;
    }
    let cancelled = false;
    void onFetchHistory({
      context: selectedContext,
      ref: historyRef(status),
      limit: 50,
    })
      .then((page) => {
        if (cancelled) return;
        setHistoryPage(page);
        setHistoryState("ready");
        const firstCommit = page.commits[0];
        setSelectedCommitSha(firstCommit?.sha ?? "");
        setSelectedCommitPath(firstCommit?.files?.[0]?.path ?? "");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setHistoryError(errorMessage(error));
        setHistoryState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [
    onFetchHistory,
    active,
    activeTab,
    selectedContext,
    status?.branch,
    status?.headSha,
    status?.unborn,
  ]);

  useEffect(() => {
    if (!active || !selectedContext || !diffTarget?.query.context) {
      setDiff(undefined);
      setDiffState("idle");
      setDiffError("");
      return;
    }
    let cancelled = false;
    const query = diffTarget.query as ApiGitFileDiffQuery;
    const targetKey = diffTarget.key;
    setDiffState("loading");
    setDiffError("");
    void onFetchDiff(query)
      .then((nextDiff) => {
        if (cancelled || targetKey !== diffTarget.key) {
          return;
        }
        setDiff(nextDiff);
        setDiffState("ready");
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDiff(undefined);
          setDiffState("error");
          setDiffError(errorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onFetchDiff, active, selectedContext, diffTarget?.key]);

  const applyReloadedStatus = (nextStatus: GitStatusResult) => {
    setStatusResult(nextStatus);
    setStatusState("ready");
    setStatusError("");
    if (isRepositoryStatus(nextStatus)) {
      setSelectedChange((current) =>
        current && changeStillExists(nextStatus, current)
          ? current
          : firstChange(nextStatus),
      );
    } else {
      setSelectedChange(undefined);
      setDiff(undefined);
    }
  };

  const isCurrentStatusReload = (
    requestSequence: number,
    requestContextKey: string,
  ) =>
    statusRequestSequenceRef.current === requestSequence &&
    statusContextKeyRef.current === requestContextKey;

  const reloadStatus = async (context: ApiGitContext) => {
    const requestContextKey = contextKey(context);
    const requestSequence = statusRequestSequenceRef.current + 1;
    statusRequestSequenceRef.current = requestSequence;
    try {
      const nextStatus = await onFetchStatus(context);
      if (!isCurrentStatusReload(requestSequence, requestContextKey)) {
        return;
      }
      applyReloadedStatus(nextStatus);
    } catch (error: unknown) {
      if (!isCurrentStatusReload(requestSequence, requestContextKey)) {
        return;
      }
      setStatusResult(undefined);
      setStatusState("error");
      setStatusError(errorMessage(error));
    }
  };

  const refresh = () => {
    if (!selectedContext || !project) return;
    setSelectedContextKey(contextKey(selectedContext));
    setStatusState("loading");
    void reloadStatus(selectedContext);
  };

  const loadMoreHistory = () => {
    if (
      !selectedContext ||
      !status ||
      status.unborn ||
      !historyPage?.nextCursor
    ) {
      return;
    }
    const requestHistoryScope = historyScope;
    setHistoryState("loading");
    setHistoryError("");
    void onFetchHistory({
      context: selectedContext,
      ref: historyRef(status),
      cursor: historyPage.nextCursor,
      limit: 50,
    })
      .then((page) => {
        if (historyScopeRef.current !== requestHistoryScope) {
          return;
        }
        setHistoryPage((current) =>
          current
            ? {
                ...page,
                commits: [...current.commits, ...page.commits],
              }
            : page,
        );
        setHistoryState("ready");
      })
      .catch((error: unknown) => {
        if (historyScopeRef.current !== requestHistoryScope) {
          return;
        }
        setHistoryState("error");
        setHistoryError(errorMessage(error));
      });
  };

  const runJob = async (
    run: () => Promise<GitJob>,
    messages: { pending: string; success: string; failure: string },
    refreshContext = selectedContext,
  ) => {
    const refreshTarget = refreshContext ?? selectedContext;
    if (!selectedContext || !project || !refreshTarget) return;
    setJobState("loading");
    setJobError("");
    try {
      const job = await run();
      if (job.status === "failed") {
        const message = job.errorSummary ?? messages.failure;
        setJobState("error");
        setJobError(message);
        onNotify("error", messages.failure, message);
      } else {
        setJobState("ready");
        onNotify("success", messages.success, messages.pending);
      }
      await reloadStatus(refreshTarget);
      return job;
    } catch (error: unknown) {
      const message = errorMessage(error);
      setJobState("error");
      setJobError(message);
      onNotify("error", messages.failure, message);
      return undefined;
    }
  };

  if (!project || !selectedContext) {
    return (
      <section className="tool-panel git-panel" aria-label="Git">
        <div className="empty-state compact">
          Select a project to inspect Git.
        </div>
      </section>
    );
  }

  if (!runnerOnline) {
    return (
      <section className="tool-panel git-panel" aria-label="Git">
        <div className="empty-state compact">Project runner is offline.</div>
      </section>
    );
  }

  return (
    <section ref={panelRef} className="tool-panel git-panel" aria-label="Git">
      <div className="tool-panel-header git-panel-header">
        <div className="git-title-block">
          <h2 className="panel-title">Git</h2>
          {status ? <GitBranchSummary status={status} /> : null}
        </div>
        <div className="git-header-actions">
          <button
            className="icon-button"
            type="button"
            title="Refresh Git"
            aria-label="Refresh Git"
            onClick={refresh}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      <div className="git-toolbar">
        <label className="field git-context-field">
          <select
            aria-label="Git context"
            title={selectedContextOption?.label}
            value={activeContextKey}
            onChange={(event) => setSelectedContextKey(event.target.value)}
          >
            {contextOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          {selectedContextOption?.isDefault ? (
            <span className="git-context-badge">Current</span>
          ) : null}
        </label>
        {status ? (
          <div className="git-tabs" role="tablist" aria-label="Git views">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "changes"}
              className={activeTab === "changes" ? "is-active" : ""}
              onClick={() => setActiveTab("changes")}
            >
              Changes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "history"}
              className={activeTab === "history" ? "is-active" : ""}
              onClick={() => setActiveTab("history")}
            >
              History
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "branch"}
              className={activeTab === "branch" ? "is-active" : ""}
              onClick={() => setActiveTab("branch")}
            >
              Branch & Sync
            </button>
          </div>
        ) : null}
      </div>

      {statusState === "loading" ? (
        <div className="empty-state compact">Loading Git status...</div>
      ) : null}
      {statusState === "error" ? (
        <GitErrorPanel
          title="Git status failed"
          message={statusError}
          compact
        />
      ) : null}
      {nonGitStatus ? (
        <NonGitState
          message={nonGitStatus.message}
          onInit={() =>
            void runJob(() => onInitRepository({ context: selectedContext }), {
              pending: "Repository initialized.",
              success: "Git repository initialized",
              failure: "Init repository failed",
            })
          }
        />
      ) : null}

      {status ? (
        <>
          {activeTab === "changes" ? (
            <div className="git-grid">
              <aside className="git-sidebar">
                <div className="git-sidebar-header">
                  <h3>Changes</h3>
                  <SegmentedControl
                    value={changeViewMode}
                    onChange={setChangeViewMode}
                  />
                </div>
                <GitChangeNavigator
                  status={status}
                  viewMode={changeViewMode}
                  selectedChange={selectedChange}
                  onSelectChange={setSelectedChange}
                  onStageAll={(paths) =>
                    void runJob(
                      () => onStagePaths({ context: selectedContext, paths }),
                      {
                        pending: stagedMessage(paths.length),
                        success: "Files staged",
                        failure: "Stage failed",
                      },
                    )
                  }
                  onUnstageAll={(paths) =>
                    void runJob(
                      () => onUnstagePaths({ context: selectedContext, paths }),
                      {
                        pending: unstagedMessage(paths.length),
                        success: "Files unstaged",
                        failure: "Unstage failed",
                      },
                    )
                  }
                />
                <CommitBox
                  message={commitMessage}
                  stagedCount={stagedChanges.length}
                  busy={jobState === "loading"}
                  error={jobError}
                  onChange={setCommitMessage}
                  onCommit={(message) =>
                    void runJob(
                      () => onCommit({ context: selectedContext, message }),
                      {
                        pending: "Commit created.",
                        success: "Commit created",
                        failure: "Commit failed",
                      },
                    ).then((job) => {
                      if (job?.status === "succeeded") {
                        setCommitMessage("");
                      }
                    })
                  }
                />
              </aside>
              <DiffPane
                title={selectedChange?.path ?? "No file selected"}
                eyebrow={
                  selectedChange?.staged ? "Staged diff" : "Working tree diff"
                }
                actions={
                  selectedChange ? (
                    <>
                      {canEditSelectedDiff ? (
                        <button
                          className="small-button"
                          type="button"
                          onClick={() => onOpenFileForEdit(selectedChange.path)}
                        >
                          <Pencil size={14} />
                          Edit
                        </button>
                      ) : null}
                      <ChangeActionMenu
                        change={selectedChange}
                        busy={fileActionBusy}
                        onStage={() =>
                          void runJob(
                            () =>
                              onStagePaths({
                                context: selectedContext,
                                paths: gitActionPaths([selectedChange]),
                              }),
                            {
                              pending: stagedMessage(1),
                              success: "File staged",
                              failure: "Stage failed",
                            },
                          )
                        }
                        onUnstage={() =>
                          void runJob(
                            () =>
                              onUnstagePaths({
                                context: selectedContext,
                                paths: gitActionPaths([selectedChange]),
                              }),
                            {
                              pending: unstagedMessage(1),
                              success: "File unstaged",
                              failure: "Unstage failed",
                            },
                          )
                        }
                        onDiscard={() => {
                          if (
                            window.confirm(
                              `Discard changes in ${selectedChange.path}?`,
                            )
                          ) {
                            void runJob(
                              () =>
                                onDiscardPaths({
                                  context: selectedContext,
                                  paths: gitActionPaths([selectedChange]),
                                }),
                              {
                                pending: "Changes discarded.",
                                success: "Changes discarded",
                                failure: "Discard failed",
                              },
                            );
                          }
                        }}
                      />
                    </>
                  ) : null
                }
                canFullscreen={diffTarget !== undefined}
                diffState={diffState}
                diffError={diffError}
                showTextDiff={showTextDiff}
                binary={diff?.binary === true}
                tooLarge={diff?.tooLarge === true}
                editorMounted={diffEditorMounted}
                oldContent={showTextDiff ? diff.oldContent : ""}
                newContent={showTextDiff ? diff.newContent : ""}
                language={diffLanguage}
                compactDiff={compactDiff}
              />
            </div>
          ) : null}

          {activeTab === "history" ? (
            <div className="git-grid">
              <aside className="git-sidebar">
                <HistoryList
                  state={historyState}
                  error={historyError}
                  page={historyPage}
                  selectedSha={selectedCommitSha}
                  onSelect={(commit) => {
                    setSelectedCommitSha(commit.sha);
                    setSelectedCommitPath(commit.files?.[0]?.path ?? "");
                  }}
                  onLoadMore={loadMoreHistory}
                />
              </aside>
              <HistoryDetails
                commit={selectedCommit}
                selectedPath={selectedCommitPath}
                onSelectPath={setSelectedCommitPath}
                diffPane={
                  <DiffPane
                    title={selectedCommitFile?.path ?? "No file selected"}
                    eyebrow="Commit diff"
                    canFullscreen={diffTarget !== undefined}
                    diffState={diffState}
                    diffError={diffError}
                    showTextDiff={showTextDiff}
                    binary={diff?.binary === true}
                    tooLarge={diff?.tooLarge === true}
                    editorMounted={diffEditorMounted}
                    oldContent={showTextDiff ? diff.oldContent : ""}
                    newContent={showTextDiff ? diff.newContent : ""}
                    language={diffLanguage}
                    compactDiff={compactDiff}
                  />
                }
              />
            </div>
          ) : null}

          {activeTab === "branch" ? (
            <BranchSyncView
              status={status}
              branches={branches}
              branchesState={branchesState}
              branchesError={branchesError}
              selectedContext={selectedContext}
              onFetch={() =>
                void runJob(
                  () =>
                    onRemoteOperation({
                      context: selectedContext,
                      operation: "fetch",
                    }),
                  {
                    pending: "Fetched latest refs.",
                    success: "Fetch complete",
                    failure: "Fetch failed",
                  },
                )
              }
              onPull={() =>
                void runJob(
                  () =>
                    onRemoteOperation({
                      context: selectedContext,
                      operation: "pull",
                    }),
                  {
                    pending: "Pulled latest changes.",
                    success: "Pull complete",
                    failure: "Pull failed",
                  },
                )
              }
              onPush={() =>
                void runJob(
                  () =>
                    onRemoteOperation({
                      context: selectedContext,
                      operation: "push",
                    }),
                  {
                    pending: "Pushed commits.",
                    success: "Push complete",
                    failure: "Push failed",
                  },
                )
              }
              onRemoveWorktree={() => {
                if (selectedContext.kind !== "session_worktree") {
                  return;
                }
                const worktreeContext = selectedContext;
                const projectContext: ApiGitContext = {
                  kind: "project",
                  projectId: project.id,
                };
                if (
                  window.confirm(
                    "Remove this worktree from disk? The branch will not be deleted.",
                  )
                ) {
                  void runJob(
                    () => onRemoveWorktree({ context: worktreeContext }),
                    {
                      pending: "Worktree removed.",
                      success: "Worktree removed",
                      failure: "Remove worktree failed",
                    },
                    projectContext,
                  ).then(() =>
                    setSelectedContextKey(contextKey(projectContext)),
                  );
                }
              }}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function GitBranchSummary({ status }: { status: GitStatus }) {
  return (
    <p className="git-branch-summary">
      <span>
        {status.branch ?? (status.detached ? "Detached HEAD" : "HEAD")}
      </span>
      {status.upstream ? <span>{status.upstream}</span> : null}
      {status.ahead || status.behind ? (
        <span>
          ahead {status.ahead}, behind {status.behind}
        </span>
      ) : null}
    </p>
  );
}

function NonGitState({
  message,
  onInit,
}: {
  message: string;
  onInit: () => void;
}) {
  return (
    <div className="git-empty-panel">
      <GitBranch size={28} />
      <div>
        <h3>This project is not a Git repository.</h3>
        <p>
          Git changes, history, and worktrees are unavailable until this
          directory is initialized.
        </p>
        <small>{message}</small>
      </div>
      <button type="button" className="primary-action-button" onClick={onInit}>
        <GitBranch size={15} />
        Init repository
      </button>
    </div>
  );
}

function SegmentedControl({
  value,
  onChange,
}: {
  value: ChangeViewMode;
  onChange: (value: ChangeViewMode) => void;
}) {
  return (
    <div className="git-segmented" aria-label="Change view">
      <button
        type="button"
        className={value === "tree" ? "is-active" : ""}
        onClick={() => onChange("tree")}
        title="Tree view"
      >
        <FileText size={14} />
        Tree
      </button>
      <button
        type="button"
        className={value === "list" ? "is-active" : ""}
        onClick={() => onChange("list")}
        title="List view"
      >
        <List size={14} />
        List
      </button>
    </div>
  );
}

function GitChangeNavigator({
  status,
  viewMode,
  selectedChange,
  onSelectChange,
  onStageAll,
  onUnstageAll,
}: {
  status: GitStatus;
  viewMode: ChangeViewMode;
  selectedChange: GitChange | undefined;
  onSelectChange: (change: GitChange) => void;
  onStageAll: (paths: string[]) => void;
  onUnstageAll: (paths: string[]) => void;
}) {
  if (status.clean) {
    return <div className="empty-state compact">Working tree is clean.</div>;
  }
  return viewMode === "tree" ? (
    <GitChangeTrees
      groups={status.groups}
      selectedChange={selectedChange}
      onSelectChange={onSelectChange}
      onStageAll={onStageAll}
      onUnstageAll={onUnstageAll}
    />
  ) : (
    <GitChangeList
      groups={status.groups}
      selectedChange={selectedChange}
      onSelectChange={onSelectChange}
      onStageAll={onStageAll}
      onUnstageAll={onUnstageAll}
    />
  );
}

function GitChangeTrees({
  groups,
  selectedChange,
  onSelectChange,
  onStageAll,
  onUnstageAll,
}: {
  groups: GitChangeGroup[];
  selectedChange: GitChange | undefined;
  onSelectChange: (change: GitChange) => void;
  onStageAll: (paths: string[]) => void;
  onUnstageAll: (paths: string[]) => void;
}) {
  const visibleGroups = groups.filter((group) => group.changes.length > 0);
  return (
    <div className="git-change-list">
      {visibleGroups.map((group) => (
        <section key={group.id} className="git-change-group">
          <GroupHeader
            group={group}
            onStageAll={onStageAll}
            onUnstageAll={onUnstageAll}
          />
          <div className="git-tree-list">
            {buildChangeTree(group.changes).map((node) => (
              <ChangeTreeNodeView
                key={node.path}
                node={node}
                selectedChange={selectedChange}
                onSelectChange={onSelectChange}
                depth={0}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ChangeTreeNodeView({
  node,
  selectedChange,
  onSelectChange,
  depth,
}: {
  node: ChangeTreeNode;
  selectedChange: GitChange | undefined;
  onSelectChange: (change: GitChange) => void;
  depth: number;
}) {
  const children = node.children.map((child) => (
    <ChangeTreeNodeView
      key={child.path}
      node={child}
      selectedChange={selectedChange}
      onSelectChange={onSelectChange}
      depth={depth + 1}
    />
  ));
  if (node.change) {
    return (
      <>
        <button
          type="button"
          aria-label={node.change.path}
          className={
            selectedChange?.path === node.change.path &&
            selectedChange.staged === node.change.staged
              ? "is-selected"
              : ""
          }
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onSelectChange(node.change as GitChange)}
        >
          <span className={`git-status-dot ${node.change.status}`} />
          <span className="truncate">{node.name}</span>
        </button>
        {children}
      </>
    );
  }
  return (
    <details className="git-tree-folder" open>
      <summary style={{ paddingLeft: 8 + depth * 14 }}>
        <ChevronRight size={13} />
        <span className="truncate">{node.name}</span>
      </summary>
      {children}
    </details>
  );
}

function GitChangeList({
  groups,
  selectedChange,
  onSelectChange,
  onStageAll,
  onUnstageAll,
}: {
  groups: GitChangeGroup[];
  selectedChange: GitChange | undefined;
  onSelectChange: (change: GitChange) => void;
  onStageAll: (paths: string[]) => void;
  onUnstageAll: (paths: string[]) => void;
}) {
  return (
    <div className="git-change-list">
      {groups
        .filter((group) => group.changes.length > 0)
        .map((group) => (
          <section key={group.id} className="git-change-group">
            <GroupHeader
              group={group}
              onStageAll={onStageAll}
              onUnstageAll={onUnstageAll}
            />
            {group.changes.map((change) => (
              <button
                key={`${group.id}:${change.path}:${change.staged ? "staged" : "worktree"}`}
                type="button"
                className={
                  selectedChange?.path === change.path &&
                  selectedChange.staged === change.staged
                    ? "is-selected"
                    : ""
                }
                onClick={() => onSelectChange(change)}
              >
                <span className={`git-status-dot ${change.status}`} />
                <span className="truncate">{change.path}</span>
              </button>
            ))}
          </section>
        ))}
    </div>
  );
}

function GroupHeader({
  group,
  onStageAll,
  onUnstageAll,
}: {
  group: GitChangeGroup;
  onStageAll: (paths: string[]) => void;
  onUnstageAll: (paths: string[]) => void;
}) {
  const paths = gitActionPaths(group.changes);
  const canStage = group.id === "changes" || group.id === "untracked";
  const canUnstage = group.id === "staged";
  return (
    <h3>
      <span>{groupLabel(group.id)}</span>
      <span className="git-group-meta">
        <span>{group.changes.length}</span>
        {canStage || canUnstage ? (
          <ActionMenu label={`${groupLabel(group.id)} actions`}>
            {canStage ? (
              <button type="button" onClick={() => onStageAll(paths)}>
                <Check size={14} />
                Stage all
              </button>
            ) : null}
            {canUnstage ? (
              <button type="button" onClick={() => onUnstageAll(paths)}>
                <RotateCcw size={14} />
                Unstage all
              </button>
            ) : null}
          </ActionMenu>
        ) : null}
      </span>
    </h3>
  );
}

function CommitBox({
  message,
  stagedCount,
  busy,
  error,
  onChange,
  onCommit,
}: {
  message: string;
  stagedCount: number;
  busy: boolean;
  error: string;
  onChange: (message: string) => void;
  onCommit: (message: string) => void;
}) {
  const disabled = stagedCount === 0 || busy || message.trim().length === 0;
  return (
    <form
      className="git-commit-box"
      onSubmit={(event) => {
        event.preventDefault();
        const cleanMessage = message.trim();
        if (cleanMessage) {
          onCommit(cleanMessage);
        }
      }}
    >
      <label className="field">
        <span>Commit message</span>
        <textarea
          name="commitMessage"
          value={message}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
        />
      </label>
      <button
        className="primary-action-button"
        type="submit"
        disabled={disabled}
      >
        <GitCommitHorizontal size={15} />
        Commit staged
      </button>
      {stagedCount === 0 ? (
        <p className="git-muted-help">Stage files to commit.</p>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}

function ChangeActionMenu({
  change,
  busy,
  onStage,
  onUnstage,
  onDiscard,
}: {
  change: GitChange;
  busy: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}) {
  return (
    <ActionMenu label="File actions">
      {!change.staged ? (
        <button type="button" disabled={busy} onClick={onStage}>
          <Check size={14} />
          Stage
        </button>
      ) : null}
      {change.staged ? (
        <button type="button" disabled={busy} onClick={onUnstage}>
          <RotateCcw size={14} />
          Unstage
        </button>
      ) : null}
      {!change.staged ? (
        <button type="button" disabled={busy} onClick={onDiscard}>
          <Trash2 size={14} />
          Discard
        </button>
      ) : null}
    </ActionMenu>
  );
}

function DiffPane({
  title,
  eyebrow,
  actions,
  canFullscreen,
  diffState,
  diffError,
  showTextDiff,
  binary,
  tooLarge,
  editorMounted,
  oldContent,
  newContent,
  language,
  compactDiff,
}: {
  title: string;
  eyebrow: string;
  actions?: ReactNode;
  canFullscreen: boolean;
  diffState: AsyncState;
  diffError: string;
  showTextDiff: boolean;
  binary: boolean;
  tooLarge: boolean;
  editorMounted: boolean;
  oldContent: string;
  newContent: string;
  language: string;
  compactDiff: boolean;
}) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  useEffect(() => {
    setFullscreen(false);
  }, [title, eyebrow]);

  return (
    <section className={`git-diff-pane ${fullscreen ? "is-fullscreen" : ""}`}>
      <div className="git-diff-header">
        <div className="min-w-0">
          <p className="text-xs uppercase text-ink-500">{eyebrow}</p>
          <h3>{title}</h3>
        </div>
        {actions || canFullscreen ? (
          <div className="git-file-actions">
            {actions}
            {canFullscreen ? (
              <button
                className="icon-button"
                type="button"
                aria-label={
                  fullscreen ? "Exit fullscreen diff" : "Fullscreen diff"
                }
                title={fullscreen ? "Exit fullscreen diff" : "Fullscreen diff"}
                onClick={() => setFullscreen((current) => !current)}
              >
                {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {diffState === "loading" ? (
        <div className="empty-state compact">Loading diff...</div>
      ) : null}
      {diffState === "error" ? (
        <GitErrorPanel title="Git diff failed" message={diffError} compact />
      ) : null}
      {diffState === "ready" && !showTextDiff ? (
        <div className="empty-state compact">
          {binary
            ? "Binary file diff is not displayed."
            : tooLarge
              ? "Diff is too large to display."
              : "No text diff to display."}
        </div>
      ) : null}
      {editorMounted ? (
        <DiffEditor
          className={`monaco-diff ${showTextDiff ? "" : "is-hidden"}`}
          height={
            showTextDiff
              ? fullscreen || !compactDiff
                ? "100%"
                : "360px"
              : "0px"
          }
          original={oldContent}
          modified={newContent}
          originalModelPath="roam-git://diff/original"
          modifiedModelPath="roam-git://diff/modified"
          originalLanguage={language}
          modifiedLanguage={language}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          options={{
            readOnly: true,
            renderSideBySide: !compactDiff,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
          }}
        />
      ) : null}
    </section>
  );
}

function HistoryList({
  state,
  error,
  page,
  selectedSha,
  onSelect,
  onLoadMore,
}: {
  state: AsyncState;
  error: string;
  page: GitCommitPage | undefined;
  selectedSha: string;
  onSelect: (commit: GitCommitSummary) => void;
  onLoadMore: () => void;
}) {
  if (state === "loading" && !page) {
    return <div className="empty-state compact">Loading history...</div>;
  }
  if (state === "error" && !page) {
    return <GitErrorPanel title="Git history failed" message={error} compact />;
  }
  if (!page || page.commits.length === 0) {
    return <div className="empty-state compact">No commits found.</div>;
  }
  return (
    <div className="git-history-list">
      {page.commits.map((commit) => (
        <button
          key={commit.sha}
          type="button"
          className={selectedSha === commit.sha ? "is-selected" : ""}
          onClick={() => onSelect(commit)}
        >
          <code>{commit.sha.slice(0, 8)}</code>
          <span className="truncate">{commit.summary}</span>
          <small>{commit.authorName}</small>
        </button>
      ))}
      {page.nextCursor ? (
        <button
          className="small-button git-load-more"
          type="button"
          disabled={state === "loading"}
          onClick={onLoadMore}
        >
          {state === "loading" ? "Loading..." : "Load more"}
        </button>
      ) : null}
      {state === "error" && error ? (
        <GitErrorPanel title="Git history failed" message={error} compact />
      ) : null}
    </div>
  );
}

function HistoryDetails({
  commit,
  selectedPath,
  onSelectPath,
  diffPane,
}: {
  commit: GitCommitSummary | undefined;
  selectedPath: string;
  onSelectPath: (path: string) => void;
  diffPane: ReactNode;
}) {
  if (!commit) {
    return (
      <section className="git-diff-pane">
        <div className="empty-state compact">Select a commit.</div>
      </section>
    );
  }
  return (
    <section className="git-history-details">
      <section className="git-commit-detail">
        <div>
          <code>{commit.sha.slice(0, 12)}</code>
          <h3>{commit.summary}</h3>
          <p>{commit.authorName}</p>
        </div>
      </section>
      <div className="git-commit-files">
        <h3>Changed files</h3>
        {(commit.files ?? []).length === 0 ? (
          <div className="empty-state compact">No changed files listed.</div>
        ) : (
          commit.files?.map((file) => (
            <button
              key={`${commit.sha}:${file.path}`}
              type="button"
              className={selectedPath === file.path ? "is-selected" : ""}
              onClick={() => onSelectPath(file.path)}
            >
              <span className={`git-status-dot ${file.status}`} />
              <span className="truncate">{file.path}</span>
            </button>
          ))
        )}
      </div>
      {diffPane}
    </section>
  );
}

function BranchSyncView({
  status,
  branches,
  branchesState,
  branchesError,
  selectedContext,
  onFetch,
  onPull,
  onPush,
  onRemoveWorktree,
}: {
  status: GitStatus;
  branches: GitBranchList | undefined;
  branchesState: AsyncState;
  branchesError: string;
  selectedContext: ApiGitContext;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onRemoveWorktree: () => void;
}) {
  return (
    <section className="git-branch-view">
      <section className="git-branch-card">
        <div>
          <span>Current branch</span>
          <strong>
            {status.branch ?? (status.detached ? "Detached HEAD" : "HEAD")}
          </strong>
        </div>
        <div>
          <span>Upstream</span>
          <strong>{status.upstream ?? "None"}</strong>
        </div>
        <div>
          <span>Sync</span>
          <strong>
            ahead {status.ahead}, behind {status.behind}
          </strong>
        </div>
        <ActionMenu label="Branch actions">
          <button type="button" onClick={onFetch}>
            <RefreshCw size={14} />
            Fetch
          </button>
          <button type="button" onClick={onPull}>
            <GitPullRequest size={14} />
            Pull
          </button>
          <button type="button" onClick={onPush}>
            <Upload size={14} />
            Push
          </button>
          {selectedContext.kind === "session_worktree" ? (
            <button type="button" onClick={onRemoveWorktree}>
              <Trash2 size={14} />
              Remove worktree
            </button>
          ) : null}
        </ActionMenu>
      </section>
      <section className="git-branch-list-panel">
        <h3>Branches</h3>
        {branchesState === "loading" ? (
          <div className="empty-state compact">Loading refs...</div>
        ) : null}
        {branchesState === "error" ? (
          <GitErrorPanel
            title="Git branches failed"
            message={branchesError}
            compact
          />
        ) : null}
        {branches?.branches.map((branch) => (
          <div
            className="git-branch-row"
            key={`${branch.remote}:${branch.name}`}
          >
            <span>{branch.name}</span>
            <small>
              {branch.remote ? "remote" : branch.current ? "current" : "local"}
            </small>
          </div>
        ))}
      </section>
    </section>
  );
}

function ActionMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="git-action-menu">
      <summary aria-label={label} title={label}>
        <MoreHorizontal size={16} />
      </summary>
      <div className="git-action-menu-content">{children}</div>
    </details>
  );
}

function GitErrorPanel({
  title,
  message,
  action,
  compact = false,
}: {
  title: string;
  message: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`git-error-panel ${compact ? "compact" : ""}`} role="alert">
      <div>
        <strong>{title}</strong>
        <pre>{message}</pre>
      </div>
      <div className="git-error-actions">
        <button
          type="button"
          className="small-button"
          onClick={() => void copyText(message)}
        >
          <Copy size={14} />
          Copy
        </button>
        {action}
      </div>
    </div>
  );
}

function buildContextOptions(
  project: Project | undefined,
  sessions: Session[],
  defaultKey: string,
): GitContextOption[] {
  if (!project) {
    return [];
  }
  const options: GitContextOption[] = [
    {
      key: contextKey({ kind: "project", projectId: project.id }),
      label: `Project - ${project.name}`,
      isDefault: defaultKey === `project:${project.id}`,
      context: {
        kind: "project",
        projectId: project.id,
      } satisfies ApiGitContext,
    },
  ];
  for (const session of sessions) {
    if (
      session.executionMode !== "managed_worktree" ||
      session.status === "pending" ||
      session.worktreeDeletedAt
    ) {
      continue;
    }
    const key = contextKey({ kind: "session_worktree", sessionId: session.id });
    options.push({
      key,
      label: `Worktree - ${session.title}`,
      isDefault: defaultKey === key,
      context: { kind: "session_worktree", sessionId: session.id },
    });
  }
  return options;
}

function contextFromKey(
  key: string,
  options: ReturnType<typeof buildContextOptions>,
): ApiGitContext | undefined {
  return options.find((option) => option.key === key)?.context;
}

function contextKey(context: ApiGitContext): string {
  return context.kind === "project"
    ? `project:${context.projectId}`
    : `session:${context.sessionId}`;
}

function isRepositoryStatus(
  status: GitStatusResult | undefined,
): status is GitStatus {
  return status?.kind === "repository";
}

function firstChange(status: GitStatus): GitChange | undefined {
  for (const group of status.groups) {
    const change = group.changes[0];
    if (change) {
      return change;
    }
  }
  return undefined;
}

function changeStillExists(status: GitStatus, change: GitChange): boolean {
  return status.groups.some((group) =>
    group.changes.some(
      (candidate) =>
        candidate.path === change.path && candidate.staged === change.staged,
    ),
  );
}

function groupLabel(groupId: string): string {
  if (groupId === "staged") return "Staged";
  if (groupId === "changes") return "Working tree";
  if (groupId === "conflicts") return "Conflicts";
  if (groupId === "untracked") return "Untracked";
  if (groupId === "ignored") return "Ignored";
  return "Submodules";
}

function historyRef(status: GitStatus): string {
  return status.branch ?? "HEAD";
}

function optionalValue(value: string | undefined): string {
  return value ?? "";
}

function stagedMessage(count: number): string {
  return count === 1 ? "Staged 1 file." : `Staged ${count} files.`;
}

function unstagedMessage(count: number): string {
  return count === 1 ? "Unstaged 1 file." : `Unstaged ${count} files.`;
}

function gitActionPaths(changes: GitChange[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.oldPath) {
      paths.add(change.oldPath);
    }
    paths.add(change.path);
  }
  return [...paths];
}

type ChangeTreeNode = {
  name: string;
  path: string;
  children: ChangeTreeNode[];
  change?: GitChange;
};

function buildChangeTree(changes: GitChange[]): ChangeTreeNode[] {
  const root: ChangeTreeNode = { name: "", path: "", children: [] };
  for (const change of changes) {
    const parts = change.path.split("/");
    let current = root;
    let currentPath = "";
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let next = current.children.find((child) => child.name === part);
      if (!next) {
        next = { name: part, path: currentPath, children: [] };
        current.children.push(next);
      }
      if (index === parts.length - 1) {
        next.change = change;
      }
      current = next;
    });
  }
  return sortTree(root.children);
}

function sortTree(nodes: ChangeTreeNode[]): ChangeTreeNode[] {
  return nodes
    .map((node) => ({ ...node, children: sortTree(node.children) }))
    .sort((a, b) => {
      if (Boolean(a.change) !== Boolean(b.change)) {
        return a.change ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    });
}

function useCompactDiff(panelRef: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < 900,
  );
  useLayoutEffect(() => {
    const update = () => {
      const panelWidth =
        panelRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      setCompact(window.innerWidth < 900 || panelWidth < 760);
    };
    update();
    const observer =
      typeof ResizeObserver === "undefined" || !panelRef.current
        ? undefined
        : new ResizeObserver(update);
    if (panelRef.current && observer) {
      observer.observe(panelRef.current);
    }
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [panelRef]);
  return compact;
}

function usePersistentChangeViewMode(): [
  ChangeViewMode,
  (mode: ChangeViewMode) => void,
] {
  const [mode, setMode] = useState<ChangeViewMode>(() => {
    if (typeof window === "undefined") return "tree";
    return window.localStorage.getItem("roam.git.changeView") === "list"
      ? "list"
      : "tree";
  });
  const update = (nextMode: ChangeViewMode) => {
    setMode(nextMode);
    window.localStorage.setItem("roam.git.changeView", nextMode);
  };
  return [mode, update];
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Clipboard permission can be unavailable in browser automation or mobile UIs.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
