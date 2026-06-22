import type {
  AgentKind,
  ApiGitContext,
  ExecutionMode,
  GitBranch,
  GitBranchList,
  GitStatus,
  GitStatusResult,
  ImageAttachmentUpload,
  Project,
  RunnerCapability,
  RunnerRegistration,
} from "@roamcli/shared/protocol";
import { ImagePlus, RefreshCw, Send, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  addDraftImages,
  draftImagesToUploads,
  formatBytes,
  imageInputLimits,
  revokeDraftPreview,
  type DraftImageAttachment,
} from "../conversation/attachments";
import { PromptComposer } from "../conversation/PromptComposer";
import type {
  AgentSkillFetcher,
  PathSearchFetcher,
} from "../conversation/prompt-resources";

export type NewSessionValues = {
  title: string;
  prompt: string;
  agent: AgentKind;
  executionMode: ExecutionMode;
  gitBaseRef?: string;
  gitBranchName?: string;
  attachments?: ImageAttachmentUpload[];
};

type AsyncState = "idle" | "loading" | "ready" | "error";

type BaseRefOption = {
  value: string;
  label: string;
  meta: string;
};

type GitStatusFetcher = (context: ApiGitContext) => Promise<GitStatusResult>;
type GitBranchesFetcher = (context: ApiGitContext) => Promise<GitBranchList>;

type NewSessionFormProps = {
  project: Project;
  runner: RunnerRegistration;
  onCreate: (values: NewSessionValues) => void | Promise<void>;
  onCreated?: () => void;
  onListAgentSkills?: AgentSkillFetcher | undefined;
  onSearchWorkspacePaths?: PathSearchFetcher | undefined;
  onFetchGitStatus?: GitStatusFetcher | undefined;
  onFetchGitBranches?: GitBranchesFetcher | undefined;
};

export function NewSessionForm({
  project,
  runner,
  onCreate,
  onCreated,
  onListAgentSkills = emptyAgentSkillList,
  onSearchWorkspacePaths = emptyPathSearch,
  onFetchGitStatus,
  onFetchGitBranches,
}: NewSessionFormProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImageAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftImageStripRef = useRef<HTMLDivElement>(null);
  const [executionMode, setExecutionMode] =
    useState<ExecutionMode>("managed_worktree");
  const [gitBaseRef, setGitBaseRef] = useState("HEAD");
  const [gitBranchName, setGitBranchName] = useState("");
  const [sessionOptionsState, setSessionOptionsState] =
    useState<AsyncState>("loading");
  const [sessionOptionsError, setSessionOptionsError] = useState("");
  const [gitStatusResult, setGitStatusResult] = useState<
    GitStatusResult | undefined
  >();
  const [gitBranches, setGitBranches] = useState<GitBranchList | undefined>();
  const [gitBranchesState, setGitBranchesState] =
    useState<AsyncState>("idle");
  const [gitBranchesError, setGitBranchesError] = useState("");
  const agentOptions = useMemo(
    () =>
      runner.capabilities.map(
        (capability: RunnerCapability) => capability.kind,
      ),
    [runner.capabilities],
  );
  const [agent, setAgent] = useState<AgentKind>(
    runner.capabilities[0]?.kind ?? "codex",
  );
  const imageCapability = useMemo(
    () => runner.capabilities.find((capability) => capability.kind === agent),
    [agent, runner.capabilities],
  );
  const imageLimits = useMemo(
    () => imageInputLimits(imageCapability),
    [imageCapability],
  );
  const gitContext = useMemo<ApiGitContext>(
    () => ({ kind: "project", projectId: project.id }),
    [project.id],
  );
  const repositoryStatus = isRepositoryStatus(gitStatusResult)
    ? gitStatusResult
    : undefined;
  const canUseManagedWorktree = Boolean(
    repositoryStatus && !repositoryStatus.unborn,
  );
  const baseRefOptions = useMemo(
    () => buildBaseRefOptions(repositoryStatus, gitBranches),
    [repositoryStatus, gitBranches],
  );

  useEffect(() => {
    if (imageLimits.supported) {
      return;
    }
    setDraftImages((current) => {
      current.forEach(revokeDraftPreview);
      return [];
    });
  }, [imageLimits.supported]);

  useEffect(() => {
    let cancelled = false;
    setSessionOptionsState("loading");
    setSessionOptionsError("");
    setGitStatusResult(undefined);
    setGitBranches(undefined);
    setGitBranchesState("idle");
    setGitBranchesError("");
    setGitBranchName("");

    const loadStatus =
      onFetchGitStatus ?? (() => defaultGitStatus(gitContext));
    void loadStatus(gitContext)
      .then((statusResult) => {
        if (cancelled) {
          return;
        }
        setGitStatusResult(statusResult);
        setSessionOptionsState("ready");
        if (isWorktreeCapableStatus(statusResult)) {
          setExecutionMode("managed_worktree");
          setGitBaseRef(defaultBaseRef(statusResult));
        } else {
          setExecutionMode("direct");
          setGitBaseRef("");
        }
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        setGitStatusResult(undefined);
        setSessionOptionsState("error");
        setSessionOptionsError(
          errorMessage(loadError, "Project Git options could not be loaded."),
        );
        setExecutionMode("direct");
        setGitBaseRef("");
      });

    return () => {
      cancelled = true;
    };
  }, [gitContext, onFetchGitStatus]);

  useEffect(() => {
    if (!repositoryStatus || repositoryStatus.unborn) {
      setGitBranches(undefined);
      setGitBranchesState("idle");
      setGitBranchesError("");
      return;
    }

    let cancelled = false;
    setGitBranchesState("loading");
    setGitBranchesError("");
    const loadBranches =
      onFetchGitBranches ?? (() => defaultGitBranches(gitContext));
    void loadBranches(gitContext)
      .then((branches) => {
        if (cancelled) {
          return;
        }
        setGitBranches(branches);
        setGitBranchesState("ready");
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        setGitBranches(undefined);
        setGitBranchesState("error");
        setGitBranchesError(
          errorMessage(loadError, "Branch refs could not be loaded."),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [gitContext, onFetchGitBranches, repositoryStatus]);

  useEffect(() => {
    if (!canUseManagedWorktree || !repositoryStatus) {
      return;
    }
    const fallbackRef = defaultBaseRef(repositoryStatus);
    setGitBaseRef((current) =>
      current && baseRefOptions.some((option) => option.value === current)
        ? current
        : fallbackRef,
    );
  }, [baseRefOptions, canUseManagedWorktree, repositoryStatus]);

  useEffect(() => {
    const strip = draftImageStripRef.current;
    if (
      draftImages.length === 0 ||
      typeof strip?.scrollIntoView !== "function"
    ) {
      return;
    }
    const scrollIntoView = () => {
      strip.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(scrollIntoView);
    } else {
      scrollIntoView();
    }
  }, [draftImages.length]);

  const addFiles = (files: FileList | File[]) => {
    const result = addDraftImages(
      Array.from(files),
      draftImages,
      imageCapability,
    );
    if (result.attachments.length > 0) {
      setDraftImages((current) => [...current, ...result.attachments]);
    }
    setError(result.error ?? "");
  };

  const removeDraftImage = (id: string) => {
    setDraftImages((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) {
        revokeDraftPreview(removed);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
    setError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      setError("Prompt is required.");
      return;
    }
    if (executionMode === "managed_worktree" && !canUseManagedWorktree) {
      setError(
        "New branch worktrees require a Git repository with at least one commit.",
      );
      return;
    }

    setSubmitting(true);
    try {
      await onCreate({
        title: title.trim() || cleanPrompt.slice(0, 48),
        prompt: cleanPrompt,
        agent,
        executionMode,
        ...(executionMode === "managed_worktree" && gitBaseRef.trim()
          ? { gitBaseRef: gitBaseRef.trim() }
          : {}),
        ...(executionMode === "managed_worktree" && gitBranchName.trim()
          ? { gitBranchName: gitBranchName.trim() }
          : {}),
        attachments: await draftImagesToUploads(draftImages),
      });
      draftImages.forEach(revokeDraftPreview);
      setDraftImages([]);
      setTitle("");
      setPrompt("");
      setError("");
      onCreated?.();
    } catch (createError: unknown) {
      setError(errorMessage(createError, "Session was not created."));
    } finally {
      setSubmitting(false);
    }
  };

  if (sessionOptionsState === "loading") {
    return (
      <div className="new-session-loading" role="status">
        <RefreshCw size={16} />
        <div>
          <strong>Loading session options...</strong>
          <p>Checking whether this project can create Git worktrees.</p>
        </div>
      </div>
    );
  }

  return (
    <form className="new-session-form" onSubmit={submit}>
      <label className="field">
        <span>Title</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Optional task name"
        />
      </label>
      <label className="field">
        <span>Agent</span>
        <select
          value={agent}
          onChange={(event) => setAgent(event.target.value as AgentKind)}
        >
          {agentOptions.map((option: AgentKind) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Project directory</span>
        <input value={project.directory} readOnly />
      </label>
      <label className="field">
        <span>Execution</span>
        <select
          value={executionMode}
          onChange={(event) =>
            setExecutionMode(event.target.value as ExecutionMode)
          }
        >
          <option value="managed_worktree" disabled={!canUseManagedWorktree}>
            New branch worktree
          </option>
          <option value="direct">Local</option>
        </select>
      </label>
      {!canUseManagedWorktree ? (
        <p
          className="field-help"
          role={sessionOptionsState === "error" ? "alert" : undefined}
        >
          {sessionOptionsState === "error"
            ? sessionOptionsError
            : managedWorktreeUnavailableMessage(repositoryStatus)}
        </p>
      ) : null}
      {executionMode === "managed_worktree" ? (
        <>
          <label className="field">
            <span>Base ref</span>
            <select
              value={gitBaseRef}
              onChange={(event) => setGitBaseRef(event.target.value)}
            >
              {baseRefOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {gitBranchesState === "loading" ? (
            <p className="field-help">Loading branch refs...</p>
          ) : null}
          {gitBranchesState === "error" ? (
            <p className="field-help warning">{gitBranchesError}</p>
          ) : null}
          <label className="field">
            <span>Branch name</span>
            <input
              value={gitBranchName}
              onChange={(event) => setGitBranchName(event.target.value)}
              placeholder="Auto-generated"
            />
          </label>
        </>
      ) : null}
      <label
        className="field"
        onDragOver={(event) => {
          if (imageLimits.supported) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          if (!imageLimits.supported) {
            return;
          }
          event.preventDefault();
          addFiles(event.dataTransfer.files);
        }}
      >
        <span>Prompt</span>
        <PromptComposer
          value={prompt}
          ariaLabel="Prompt"
          ariaInvalid={Boolean(error)}
          runnerId={runner.runnerId}
          agent={agent}
          basePath={project.directory}
          onListAgentSkills={onListAgentSkills}
          onSearchWorkspacePaths={onSearchWorkspacePaths}
          onChange={(nextPrompt) => {
            setPrompt(nextPrompt);
            setError("");
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (files.length > 0) {
              event.preventDefault();
              addFiles(files);
            }
          }}
          rows={4}
          placeholder="Describe the work"
          suggestionPlacement="below"
        />
      </label>
      {draftImages.length > 0 ? (
        <div
          className="draft-image-strip"
          aria-label="Attached images"
          ref={draftImageStripRef}
        >
          {draftImages.map((attachment) => (
            <div className="draft-image-tile" key={attachment.id}>
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" />
              ) : (
                <div className="image-placeholder compact">Image preview</div>
              )}
              <div className="draft-image-meta">
                <span>{attachment.file.name || "image"}</span>
                <small>{formatBytes(attachment.file.size)}</small>
              </div>
              <button
                className="draft-image-remove"
                type="button"
                aria-label={`Remove ${attachment.file.name || "image"}`}
                title="Remove image"
                onClick={() => removeDraftImage(attachment.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept={imageLimits.accept}
        multiple
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.files) {
            addFiles(event.target.files);
          }
          event.target.value = "";
        }}
      />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          className="small-button"
          type="button"
          title={
            imageLimits.supported
              ? "Attach images"
              : "This agent does not accept image input"
          }
          disabled={!imageLimits.supported || submitting}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus size={15} />
          <span>Images</span>
        </button>
        <button
          className="primary-action-button"
          type="submit"
          title="Create session"
          disabled={submitting}
        >
          <Send size={16} />
          <span>{submitting ? "Creating session..." : "Create session"}</span>
        </button>
      </div>
    </form>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isRepositoryStatus(
  status: GitStatusResult | undefined,
): status is GitStatus {
  return status?.kind === "repository";
}

function isWorktreeCapableStatus(
  status: GitStatusResult | undefined,
): status is GitStatus {
  return isRepositoryStatus(status) && !status.unborn;
}

function managedWorktreeUnavailableMessage(
  status: GitStatus | undefined,
): string {
  if (status?.unborn) {
    return [
      "This repository has no commits yet.",
      "Local sessions are available until the first commit exists.",
    ].join(" ");
  }
  return "This directory is not a Git repository. Local sessions are available.";
}

function defaultBaseRef(status: GitStatus): string {
  return status.branch ?? "HEAD";
}

function buildBaseRefOptions(
  status: GitStatus | undefined,
  branches: GitBranchList | undefined,
): BaseRefOption[] {
  if (!status) {
    return [];
  }

  const options: BaseRefOption[] = [];
  const seen = new Set<string>();
  const add = (option: BaseRefOption) => {
    if (seen.has(option.value)) {
      return;
    }
    seen.add(option.value);
    options.push(option);
  };

  const currentValue = defaultBaseRef(status);
  add({
    value: currentValue,
    label: status.branch
      ? `Current branch (${status.branch})`
      : "HEAD (detached)",
    meta: "current",
  });

  const localBranches =
    branches?.branches.filter((branch) => !branch.remote) ?? [];
  const remoteBranches =
    branches?.branches.filter(
      (branch) => branch.remote && isSelectableRemoteBranch(branch),
    ) ?? [];

  for (const branch of localBranches) {
    add(branchRefOption(branch));
  }
  for (const branch of remoteBranches) {
    add(branchRefOption(branch));
  }

  return options;
}

function branchRefOption(branch: GitBranch): BaseRefOption {
  const meta = branch.remote ? "remote" : "local";
  return {
    value: branch.name,
    label: `${branch.name} (${meta})`,
    meta,
  };
}

function isSelectableRemoteBranch(branch: GitBranch): boolean {
  const name = branch.name.trim();
  return !name.includes(" -> ") && !/\/HEAD(?:$|\s)/.test(name);
}

async function defaultGitStatus(
  context: ApiGitContext,
): Promise<GitStatusResult> {
  return {
    kind: "repository",
    requestId: "default-git-status",
    context,
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    clean: true,
    unborn: false,
    groups: [],
  };
}

async function defaultGitBranches(
  context: ApiGitContext,
): Promise<GitBranchList> {
  return {
    requestId: "default-git-branches",
    context,
    branches: [],
  };
}

async function emptyAgentSkillList(
  input: Parameters<AgentSkillFetcher>[0],
): Promise<Awaited<ReturnType<AgentSkillFetcher>>> {
  return {
    requestId: "empty-agent-skills",
    agent: input.agent,
    basePath: input.basePath,
    queriedAt: new Date().toISOString(),
    skills: [],
  };
}

async function emptyPathSearch(
  input: Parameters<PathSearchFetcher>[0],
): Promise<Awaited<ReturnType<PathSearchFetcher>>> {
  return {
    requestId: "empty-path-search",
    basePath: input.basePath,
    query: input.query,
    entries: [],
  };
}
