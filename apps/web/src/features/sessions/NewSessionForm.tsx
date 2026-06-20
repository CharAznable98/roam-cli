import type {
  AgentKind,
  ExecutionMode,
  ImageAttachmentUpload,
  Project,
  RunnerCapability,
  RunnerRegistration,
} from "@roamcli/shared/protocol";
import { ImagePlus, Send, X } from "lucide-react";
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

type NewSessionFormProps = {
  project: Project;
  runner: RunnerRegistration;
  onCreate: (values: NewSessionValues) => void | Promise<void>;
  onCreated?: () => void;
  onListAgentSkills?: AgentSkillFetcher | undefined;
  onSearchWorkspacePaths?: PathSearchFetcher | undefined;
};

export function NewSessionForm({
  project,
  runner,
  onCreate,
  onCreated,
  onListAgentSkills = emptyAgentSkillList,
  onSearchWorkspacePaths = emptyPathSearch,
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
          <option value="managed_worktree">New branch worktree</option>
          <option value="direct">Local</option>
        </select>
      </label>
      {executionMode === "managed_worktree" ? (
        <>
          <label className="field">
            <span>Base ref</span>
            <input
              value={gitBaseRef}
              onChange={(event) => setGitBaseRef(event.target.value)}
              placeholder="HEAD"
            />
          </label>
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
