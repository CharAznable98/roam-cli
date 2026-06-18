import { DiffEditor } from "@monaco-editor/react";
import type {
  ApiGitBlameQuery,
  ApiGitCommit,
  ApiGitContext,
  ApiGitFileDiffQuery,
  ApiGitInit,
  ApiGitPaths,
  ApiGitRemoteOperation,
  ApiGitRemoveWorktree,
  GitBlame,
  GitChange,
  GitFileDiff,
  GitJob,
  GitStatus,
  Project,
  Session,
} from "@roamcli/shared/protocol";
import {
  Check,
  Copy,
  Download,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

type AsyncState = "idle" | "loading" | "ready" | "error";

type GitContextOption = {
  key: string;
  label: string;
  context: ApiGitContext;
};

type GitPanelProps = {
  active: boolean;
  project: Project | undefined;
  runnerOnline: boolean;
  sessions: Session[];
  defaultContext: ApiGitContext | undefined;
  onFetchStatus: (context: ApiGitContext) => Promise<GitStatus>;
  onFetchDiff: (query: ApiGitFileDiffQuery) => Promise<GitFileDiff>;
  onFetchBlame: (query: ApiGitBlameQuery) => Promise<GitBlame>;
  onInitRepository: (input: ApiGitInit) => Promise<GitJob>;
  onStagePaths: (input: ApiGitPaths) => Promise<GitJob>;
  onUnstagePaths: (input: ApiGitPaths) => Promise<GitJob>;
  onDiscardPaths: (input: ApiGitPaths) => Promise<GitJob>;
  onCommit: (input: ApiGitCommit) => Promise<GitJob>;
  onRemoteOperation: (input: ApiGitRemoteOperation) => Promise<GitJob>;
  onRemoveWorktree: (input: ApiGitRemoveWorktree) => Promise<GitJob>;
};

export function GitPanel({
  active,
  project,
  runnerOnline,
  sessions,
  defaultContext,
  onFetchStatus,
  onFetchDiff,
  onFetchBlame,
  onInitRepository,
  onStagePaths,
  onUnstagePaths,
  onDiscardPaths,
  onCommit,
  onRemoteOperation,
  onRemoveWorktree,
}: GitPanelProps) {
  const defaultContextKey = defaultContext ? contextKey(defaultContext) : "";
  const [selectedContextKey, setSelectedContextKey] =
    useState(defaultContextKey);
  const [status, setStatus] = useState<GitStatus | undefined>();
  const [statusState, setStatusState] = useState<AsyncState>("idle");
  const [statusError, setStatusError] = useState("");
  const [selectedChange, setSelectedChange] = useState<GitChange | undefined>();
  const [diff, setDiff] = useState<GitFileDiff | undefined>();
  const [diffState, setDiffState] = useState<AsyncState>("idle");
  const [diffError, setDiffError] = useState("");
  const [blame, setBlame] = useState<GitBlame | undefined>();
  const [jobState, setJobState] = useState<AsyncState>("idle");
  const [jobError, setJobError] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [diffEditorMounted, setDiffEditorMounted] = useState(active);
  const compactDiff = useCompactDiff();

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
  const selectedContext =
    contextFromKey(selectedContextKey, contextOptions) ?? defaultContext;
  const stagedChanges =
    status?.groups.find((group) => group.id === "staged")?.changes ?? [];
  const selectedMode = selectedChange?.staged ? "staged" : "working_tree";
  const hasCurrentDiff =
    selectedChange !== undefined &&
    diffState === "ready" &&
    diff !== undefined &&
    diff.path === selectedChange.path &&
    diff.mode === selectedMode;
  const showTextDiff =
    hasCurrentDiff && !diff.binary && !diff.tooLarge;
  const diffLanguage = showTextDiff ? (diff.language ?? "plaintext") : "plaintext";
  const canInit = Boolean(selectedContext && isNonGitError(statusError));

  useEffect(() => {
    if (!active) {
      return;
    }
    if (!selectedContext || !project || !runnerOnline) {
      setStatus(undefined);
      setStatusState("idle");
      return;
    }
    let cancelled = false;
    setStatusState("loading");
    setStatusError("");
    setSelectedChange(undefined);
    setDiff(undefined);
    setBlame(undefined);

    void onFetchStatus(selectedContext)
      .then((nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setStatusState("ready");
        setSelectedChange(firstChange(nextStatus));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus(undefined);
        setStatusState("error");
        setStatusError(errorMessage(error));
      });

    return () => {
      cancelled = true;
    };
  }, [
    onFetchStatus,
    active,
    project,
    runnerOnline,
    selectedContext,
  ]);

  useEffect(() => {
    if (!active || !selectedContext || !selectedChange) {
      setDiff(undefined);
      setDiffState("idle");
      setDiffError("");
      return;
    }
    let cancelled = false;
    setDiffState("loading");
    setDiffError("");
    setBlame(undefined);
    void onFetchDiff({
      context: selectedContext,
      path: selectedChange.path,
      mode: selectedMode,
    })
      .then((nextDiff) => {
        if (!cancelled) {
          setDiff(nextDiff);
          setDiffState("ready");
        }
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
  }, [onFetchDiff, active, selectedChange, selectedContext, selectedMode]);

  const refresh = () => {
    if (!selectedContext || !project) return;
    setSelectedContextKey(contextKey(selectedContext));
    setStatusState("loading");
    void Promise.allSettled([
      onFetchStatus(selectedContext).then((nextStatus) => {
        setStatus(nextStatus);
        setStatusState("ready");
        setStatusError("");
        setSelectedChange((current) => current ?? firstChange(nextStatus));
      }),
    ]).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        setStatusState("error");
        setStatusError(errorMessage(failed.reason));
      }
    });
  };

  const runJob = async (
    run: () => Promise<GitJob>,
    refreshContext = selectedContext,
  ) => {
    const refreshTarget = refreshContext ?? selectedContext;
    if (!selectedContext || !project || !refreshTarget) return;
    setJobState("loading");
    setJobError("");
    try {
      const job = await run();
      setJobState(job.status === "failed" ? "error" : "ready");
      setJobError(job.errorSummary ?? "");
      await Promise.allSettled([
        onFetchStatus(refreshTarget).then((nextStatus) => {
          setStatus(nextStatus);
          setStatusState("ready");
          setStatusError("");
          setSelectedChange((current) =>
            current && changeStillExists(nextStatus, current)
              ? current
              : firstChange(nextStatus),
          );
        }),
      ]);
      return job;
    } catch (error: unknown) {
      setJobState("error");
      setJobError(errorMessage(error));
      return undefined;
    }
  };

  const loadBlame = () => {
    if (!selectedContext || !selectedChange) return;
    void onFetchBlame({ context: selectedContext, path: selectedChange.path })
      .then(setBlame)
      .catch((error: unknown) => setDiffError(errorMessage(error)));
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
    <section className="tool-panel git-panel" aria-label="Git">
      <div className="tool-panel-header git-panel-header">
        <h2 className="panel-title">Git</h2>
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
            value={selectedContextKey || defaultContextKey}
            onChange={(event) => setSelectedContextKey(event.target.value)}
          >
            {contextOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="git-remote-actions">
          <button
            type="button"
            className="small-button"
            onClick={() =>
              void runJob(() =>
                onRemoteOperation({
                  context: selectedContext,
                  operation: "fetch",
                }),
              )
            }
          >
            <Download size={14} />
            Fetch
          </button>
          <button
            type="button"
            className="small-button"
            onClick={() =>
              void runJob(() =>
                onRemoteOperation({
                  context: selectedContext,
                  operation: "pull",
                }),
              )
            }
          >
            <GitPullRequest size={14} />
            Pull
          </button>
          <button
            type="button"
            className="small-button"
            onClick={() =>
              void runJob(() =>
                onRemoteOperation({
                  context: selectedContext,
                  operation: "push",
                }),
              )
            }
          >
            <Upload size={14} />
            Push
          </button>
        </div>
      </div>

      {statusState === "error" ? (
        <GitErrorPanel
          title="Git status failed"
          message={statusError}
          action={
            canInit ? (
              <button
                type="button"
                className="primary-action-button"
                onClick={() =>
                  void runJob(() =>
                    onInitRepository({ context: selectedContext }),
                  )
                }
              >
                <GitBranch size={15} />
                Init repository
              </button>
            ) : undefined
          }
        />
      ) : null}

      <div className="git-grid">
        <aside className="git-sidebar">
          <GitChangeList
            status={status}
            selectedChange={selectedChange}
            onSelectChange={setSelectedChange}
          />

          <form
            className="git-commit-box"
            onSubmit={(event) => {
              event.preventDefault();
              const messageInput =
                event.currentTarget.elements.namedItem("commitMessage");
              const message =
                messageInput instanceof HTMLTextAreaElement
                  ? messageInput.value.trim()
                  : commitMessage.trim();
              if (!message) {
                setJobError("Commit message is required.");
                setJobState("error");
                return;
              }
              void runJob(() =>
                onCommit({ context: selectedContext, message }),
              ).then((job) => {
                if (job?.status === "succeeded") {
                  setCommitMessage("");
                }
              });
            }}
          >
            <label className="field">
              <span>Commit message</span>
              <textarea
                name="commitMessage"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                rows={3}
              />
            </label>
            <button
              className="primary-action-button"
              type="submit"
              disabled={stagedChanges.length === 0 || jobState === "loading"}
            >
              <GitCommitHorizontal size={15} />
              Commit staged
            </button>
          </form>

          {selectedContext.kind === "session_worktree" ? (
            <button
              type="button"
              className="danger-text-button"
              onClick={() => {
                const projectContext: ApiGitContext = {
                  kind: "project",
                  projectId: project.id,
                };
                if (
                  window.confirm(
                    "Remove this worktree from disk? The branch will not be deleted.",
                  )
                ) {
                  void runJob(() =>
                    onRemoveWorktree({ context: selectedContext }),
                  projectContext).then(() =>
                    setSelectedContextKey(contextKey(projectContext)),
                  );
                }
              }}
            >
              <Trash2 size={14} />
              Remove worktree
            </button>
          ) : null}

          {jobState === "error" && jobError ? (
            <GitErrorPanel
              title="Git operation failed"
              message={jobError}
              compact
            />
          ) : null}
        </aside>

        <main className="git-diff-pane">
          <div className="git-diff-header">
            <div className="min-w-0">
              <p className="text-xs uppercase text-ink-500">
                {selectedMode === "staged"
                  ? "Staged diff"
                  : "Working tree diff"}
              </p>
              <h3>{selectedChange?.path ?? "No file selected"}</h3>
            </div>
            {selectedChange ? (
              <div className="git-file-actions">
                <button
                  type="button"
                  className="small-button"
                  onClick={() =>
                    void runJob(() =>
                      onStagePaths({
                        context: selectedContext,
                        paths: [selectedChange.path],
                      }),
                    )
                  }
                >
                  <Check size={14} />
                  Stage
                </button>
                <button
                  type="button"
                  className="small-button"
                  onClick={() =>
                    void runJob(() =>
                      onUnstagePaths({
                        context: selectedContext,
                        paths: [selectedChange.path],
                      }),
                    )
                  }
                >
                  <RotateCcw size={14} />
                  Unstage
                </button>
                <button
                  type="button"
                  className="small-button"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Discard changes in ${selectedChange.path}?`,
                      )
                    ) {
                      void runJob(() =>
                        onDiscardPaths({
                          context: selectedContext,
                          paths: [selectedChange.path],
                        }),
                      );
                    }
                  }}
                >
                  <Trash2 size={14} />
                  Discard
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Load blame"
                  aria-label="Load blame"
                  onClick={loadBlame}
                >
                  <History size={15} />
                </button>
              </div>
            ) : null}
          </div>

          {diffState === "loading" ? (
            <div className="empty-state compact">Loading diff...</div>
          ) : null}
          {diffState === "error" ? (
            <GitErrorPanel
              title="Git diff failed"
              message={diffError}
              compact
            />
          ) : null}
          {hasCurrentDiff ? (
            !showTextDiff ? (
              <div className="empty-state compact">
                {diff.binary
                  ? "Binary file diff is not displayed."
                  : "Diff is too large to display."}
              </div>
            ) : null
          ) : null}

          {diffEditorMounted ? (
            <DiffEditor
              className={`monaco-diff ${showTextDiff ? "" : "is-hidden"}`}
              height={showTextDiff ? "100%" : "0px"}
              original={showTextDiff ? diff.oldContent : ""}
              modified={showTextDiff ? diff.newContent : ""}
              originalModelPath="roam-git://diff/original"
              modifiedModelPath="roam-git://diff/modified"
              originalLanguage={diffLanguage}
              modifiedLanguage={diffLanguage}
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

          {blame ? <BlameSummary blame={blame} /> : null}
        </main>
      </div>
    </section>
  );
}

function GitChangeList({
  status,
  selectedChange,
  onSelectChange,
}: {
  status: GitStatus | undefined;
  selectedChange: GitChange | undefined;
  onSelectChange: (change: GitChange) => void;
}) {
  if (!status) {
    return <div className="empty-state compact">No Git status loaded.</div>;
  }
  if (status.clean) {
    return <div className="empty-state compact">Working tree is clean.</div>;
  }
  return (
    <div className="git-change-list">
      {status.groups
        .filter((group) => group.changes.length > 0)
        .map((group) => (
          <section key={group.id} className="git-change-group">
            <h3>
              <span>{groupLabel(group.id)}</span>
              <span>{group.changes.length}</span>
            </h3>
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

function BlameSummary({ blame }: { blame: GitBlame }) {
  const commits = Object.values(blame.commits).slice(0, 5);
  return (
    <div className="git-blame-panel">
      <h3>Blame</h3>
      <p>{blame.ranges.length} ranges</p>
      {commits.map((commit) => (
        <div key={commit.sha} className="git-commit-row">
          <code>{commit.sha.slice(0, 8)}</code>
          <span>{commit.authorName}</span>
          <span className="truncate">{commit.summary}</span>
        </div>
      ))}
    </div>
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
      label: `Project - ${project.name}${defaultKey === `project:${project.id}` ? " (selected session)" : ""}`,
      context: {
        kind: "project",
        projectId: project.id,
      } satisfies ApiGitContext,
    },
  ];
  for (const session of sessions) {
    if (
      session.executionMode !== "managed_worktree" ||
      session.worktreeDeletedAt
    ) {
      continue;
    }
    const key = contextKey({ kind: "session_worktree", sessionId: session.id });
    options.push({
      key,
      label: `Worktree - ${session.title}${defaultKey === key ? " (selected session)" : ""}`,
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
  if (groupId === "changes") return "Changes";
  if (groupId === "conflicts") return "Conflicts";
  if (groupId === "untracked") return "Untracked";
  if (groupId === "ignored") return "Ignored";
  return "Submodules";
}

function isNonGitError(message: string): boolean {
  return message.toLowerCase().includes("not a git repository");
}

function useCompactDiff(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < 900,
  );
  useEffect(() => {
    const listener = () => setCompact(window.innerWidth < 900);
    listener();
    window.addEventListener("resize", listener);
    return () => window.removeEventListener("resize", listener);
  }, []);
  return compact;
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
