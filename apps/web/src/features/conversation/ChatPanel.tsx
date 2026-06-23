import type {
  AgentActivity,
  ImageAttachmentUpload,
  MessageAttachment,
  RunnerCapability,
  Session,
} from "@roamcli/shared/protocol";
import {
  Bot,
  ChevronDown,
  CircleStop,
  ImagePlus,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Send,
  SquareTerminal,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getConversationDisplayItems,
  type ConversationOutputItem,
  type UiMessage,
} from "./model";
import { StatusPill } from "../../shared/components/StatusPill";
import { MarkdownMessage } from "./MarkdownMessage";
import type {
  MarkdownFileLinkContext,
  MarkdownFileLinkTarget,
} from "./file-links";
import {
  addDraftImages,
  draftImagesToUploads,
  formatBytes,
  imageInputLimits,
  revokeDraftPreview,
  type DraftImageAttachment,
} from "./attachments";
import { PromptComposer } from "./PromptComposer";
import { SkillListDialog } from "./SkillListDialog";
import type { AgentSkillFetcher, PathSearchFetcher } from "./prompt-resources";

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 160;

type ChatPanelProps = {
  session: Session;
  messages: UiMessage[];
  activities?: AgentActivity[];
  onSend: (
    content: string,
    attachments: ImageAttachmentUpload[],
  ) => void | Promise<void>;
  onControl?: (signal: "stop" | "resume") => void;
  onRename?: (title: string) => void | Promise<void>;
  onDelete?: () => void;
  onCheckStatus?: () => void | Promise<void>;
  statusCheckState?: "idle" | "loading";
  canSend?: boolean;
  canControl?: boolean;
  onOpenSessionSwitcher?: () => void;
  onOpenFileLink?: ((target: MarkdownFileLinkTarget) => void) | undefined;
  imageCapability?: RunnerCapability | undefined;
  onFetchAttachmentContent?:
    | ((sessionId: string, attachmentId: string) => Promise<Blob>)
    | undefined;
  onListAgentSkills?: AgentSkillFetcher | undefined;
  onSearchWorkspacePaths?: PathSearchFetcher | undefined;
  statusBanner?: ReactNode;
};

export function ChatPanel({
  session,
  messages,
  activities = [],
  onSend,
  onControl,
  onRename,
  onDelete,
  onCheckStatus,
  statusCheckState = "idle",
  canSend = true,
  canControl = true,
  onOpenSessionSwitcher,
  onOpenFileLink,
  imageCapability,
  onFetchAttachmentContent,
  onListAgentSkills = emptyAgentSkillList,
  onSearchWorkspacePaths = emptyPathSearch,
  statusBanner,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(session.title);
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [renameError, setRenameError] = useState<string | undefined>();
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [skillListOpen, setSkillListOpen] = useState(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const compactComposerPlaceholder = useCompactComposerPlaceholder();
  const messageScrollKey = messages
    .map((message) => `${message.id}:${message.content.length}`)
    .join("|");
  const activityScrollKey = activities
    .map((activity) => `${activity.id}:${activity.label}`)
    .join("|");
  const conversationLayoutKey = `${session.status}|${messageScrollKey}|${activityScrollKey}`;
  const displayItems = useMemo(
    () => getConversationDisplayItems(messages, activities, session.status),
    [messages, activities, session.status],
  );
  const fileLinkContext = useMemo<MarkdownFileLinkContext>(
    () => ({
      cwd: session.cwd,
      executionFolder: session.executionFolder,
    }),
    [session.cwd, session.executionFolder],
  );
  const imageLimits = useMemo(
    () => imageInputLimits(imageCapability),
    [imageCapability],
  );
  const claudeTurnInProgress =
    session.agent === "claude-code" &&
    (session.status === "pending" ||
      session.status === "running" ||
      session.status === "waiting_approval");
  const canSubmitMessage = canSend && !claudeTurnInProgress;

  const scrollToBottom = () => {
    const list = messageListRef.current;
    if (!list) {
      return;
    }
    list.scrollTop = list.scrollHeight;
    shouldAutoScrollRef.current = true;
  };

  useEffect(() => {
    scrollToBottom();
    setAttachmentError(undefined);
    setDraftImages((current) => {
      current.forEach(revokeDraftPreview);
      return [];
    });
    setSessionMenuOpen(false);
    setSkillListOpen(false);
  }, [session.id]);

  useEffect(() => {
    if (!sessionMenuOpen) {
      return;
    }

    const closeOnOutsidePointer = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && !sessionMenuRef.current?.contains(target)) {
        setSessionMenuOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setSessionMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [sessionMenuOpen]);

  useEffect(() => {
    setRenameDialogOpen(false);
    setRenameDraft(session.title);
    setRenameSubmitting(false);
    setRenameError(undefined);
  }, [session.id, session.title]);

  useEffect(() => {
    if (renameDialogOpen) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renameDialogOpen]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) {
      return;
    }
    scrollToBottom();
  }, [conversationLayoutKey]);

  const handleMessageListScroll = () => {
    const list = messageListRef.current;
    if (!list) {
      return;
    }
    shouldAutoScrollRef.current = isNearMessageListBottom(list);
  };

  const addFiles = (files: FileList | File[]) => {
    const result = addDraftImages(
      Array.from(files),
      draftImages,
      imageCapability,
    );
    if (result.attachments.length > 0) {
      setDraftImages((current) => [...current, ...result.attachments]);
    }
    setAttachmentError(result.error);
  };

  const removeDraftImage = (id: string) => {
    setDraftImages((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) {
        revokeDraftPreview(removed);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
    setAttachmentError(undefined);
  };

  const submitDraft = async () => {
    const cleanDraft = draft.trim();
    if (!cleanDraft || !canSubmitMessage || submitting) {
      return;
    }

    setSubmitting(true);
    setAttachmentError(undefined);
    try {
      await onSend(cleanDraft, await draftImagesToUploads(draftImages));
      draftImages.forEach(revokeDraftPreview);
      setDraftImages([]);
      setDraft("");
    } catch (error) {
      setAttachmentError(getErrorMessage(error, "Message was not sent."));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitDraft();
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isSubmitShortcut = event.metaKey || event.ctrlKey;
    if (
      event.key !== "Enter" ||
      !isSubmitShortcut ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();
    void submitDraft();
  };

  const openRenameDialog = () => {
    setRenameDraft(session.title);
    setRenameError(undefined);
    setRenameDialogOpen(true);
  };

  const closeRenameDialog = () => {
    if (renameSubmitting) {
      return;
    }
    setRenameDialogOpen(false);
    setRenameDraft(session.title);
    setRenameError(undefined);
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanTitle = renameDraft.trim();
    if (
      !onRename ||
      renameSubmitting ||
      !cleanTitle ||
      cleanTitle === session.title
    ) {
      return;
    }
    setRenameSubmitting(true);
    setRenameError(undefined);
    try {
      await onRename(cleanTitle);
      setRenameDialogOpen(false);
    } catch (error) {
      setRenameError(getErrorMessage(error));
    } finally {
      setRenameSubmitting(false);
    }
  };

  const canSubmitRename =
    Boolean(onRename) &&
    !renameSubmitting &&
    renameDraft.trim().length > 0 &&
    renameDraft.trim() !== session.title;
  const checkingStatus = statusCheckState === "loading";
  const canResumeSession =
    canControl &&
    session.status !== "pending" &&
    session.status !== "running" &&
    session.status !== "waiting_approval";
  const canStopSession =
    canControl &&
    (session.status === "pending" ||
      session.status === "running" ||
      session.status === "waiting_approval");
  const showFailureNotice = session.status === "failed";

  return (
    <section className="chat-column" aria-label="Conversation">
      <div className="chat-header">
        <button
          className="session-title-button"
          type="button"
          aria-label={
            onOpenSessionSwitcher
              ? `Switch Session: ${session.title}`
              : undefined
          }
          onClick={onOpenSessionSwitcher}
          disabled={!onOpenSessionSwitcher}
        >
          <div className="session-title-row">
            <h1 className="session-title-text truncate text-base font-semibold text-ink-900">
              {session.title}
            </h1>
            <StatusPill status={session.status} />
            {onOpenSessionSwitcher ? (
              <ChevronDown className="session-switch-icon" size={16} />
            ) : null}
          </div>
          <p className="session-meta-line truncate text-xs text-ink-500">
            {session.agent} on {session.runnerId} · {session.cwd}
          </p>
        </button>
        <div className="session-actions" ref={sessionMenuRef}>
          <button
            className="icon-button"
            type="button"
            aria-label="Session actions"
            aria-expanded={sessionMenuOpen}
            aria-haspopup="menu"
            title="Session actions"
            onClick={() => setSessionMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={17} />
          </button>
          {sessionMenuOpen ? (
            <div
              className="session-actions-dropdown"
              role="menu"
              aria-label="Session actions"
            >
              <button
                className="session-action-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setSessionMenuOpen(false);
                  setSkillListOpen(true);
                }}
              >
                <SquareTerminal size={17} />
                <span className="session-action-title">Skill list</span>
              </button>
              <button
                className="session-action-menu-item"
                type="button"
                role="menuitem"
                disabled={!onRename}
                onClick={() => {
                  setSessionMenuOpen(false);
                  openRenameDialog();
                }}
              >
                <Pencil size={17} />
                <span className="session-action-title">Rename</span>
              </button>
              <button
                className="session-action-menu-item"
                type="button"
                role="menuitem"
                disabled={!onCheckStatus || checkingStatus}
                onClick={() => {
                  setSessionMenuOpen(false);
                  void onCheckStatus?.();
                }}
              >
                <RefreshCw
                  size={17}
                  className={checkingStatus ? "animate-spin" : ""}
                />
                <span className="session-action-title">
                  {checkingStatus ? "Checking" : "Check status"}
                </span>
              </button>
              <button
                className="session-action-menu-item"
                type="button"
                role="menuitem"
                disabled={!canResumeSession}
                onClick={() => {
                  setSessionMenuOpen(false);
                  onControl?.("resume");
                }}
              >
                <Play size={17} />
                <span className="session-action-title">Resume</span>
              </button>
              <button
                className="session-action-menu-item"
                type="button"
                role="menuitem"
                disabled={!canStopSession}
                onClick={() => {
                  setSessionMenuOpen(false);
                  onControl?.("stop");
                }}
              >
                <CircleStop size={17} />
                <span className="session-action-title">Stop</span>
              </button>
              <button
                className="session-action-menu-item danger"
                type="button"
                role="menuitem"
                disabled={!onDelete}
                onClick={() => {
                  setSessionMenuOpen(false);
                  onDelete?.();
                }}
              >
                <Trash2 size={17} />
                <span className="session-action-title">Archive</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {statusBanner}

      {renameDialogOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (!renameSubmitting && event.target === event.currentTarget) {
              closeRenameDialog();
            }
          }}
        >
          <form
            className="modal-panel rename-session-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-session-title"
            onSubmit={submitRename}
          >
            <div className="modal-header">
              <h2 id="rename-session-title" className="panel-title">
                Rename session
              </h2>
              <button
                className="icon-button"
                type="button"
                aria-label="Close rename dialog"
                title="Close"
                onClick={closeRenameDialog}
                disabled={renameSubmitting}
              >
                <X size={16} />
              </button>
            </div>
            <label className="field">
              <span>Session name</span>
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                aria-label="Session name"
                aria-describedby={
                  renameError ? "rename-session-error" : undefined
                }
                aria-invalid={renameError ? "true" : undefined}
                disabled={renameSubmitting}
              />
            </label>
            {renameError ? (
              <p className="form-error" id="rename-session-error">
                {renameError}
              </p>
            ) : null}
            <div className="form-actions">
              <button
                className="small-button"
                type="button"
                onClick={closeRenameDialog}
                disabled={renameSubmitting}
              >
                Cancel
              </button>
              <button
                className="primary-action-button"
                type="submit"
                disabled={!canSubmitRename}
              >
                {renameSubmitting ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {skillListOpen ? (
        <SkillListDialog
          runnerId={session.runnerId}
          agent={session.agent}
          basePath={session.executionFolder}
          onListAgentSkills={onListAgentSkills}
          onClose={() => setSkillListOpen(false)}
        />
      ) : null}

      <div
        className="message-list"
        ref={messageListRef}
        onScroll={handleMessageListScroll}
      >
        {showFailureNotice ? (
          <div className="session-failure-notice" role="status">
            <strong>Session failed</strong>
            <span>
              Check status to refresh the terminal state, or resume the session
              to continue from the last recorded context.
            </span>
          </div>
        ) : null}
        {messages.length === 0 && activities.length === 0 ? (
          <div className="empty-state compact">
            No messages have been recorded for this session yet.
          </div>
        ) : (
          displayItems.map((item) =>
            item.type === "intermediateGroup" ? (
              <IntermediateOutputGroup
                key={item.id}
                items={item.items}
                fileLinkContext={fileLinkContext}
                onOpenFileLink={onOpenFileLink}
              />
            ) : item.type === "activityGroup" ? (
              <AgentActivityGroup key={item.id} group={item} />
            ) : (
              <MessageBubble
                key={item.id}
                message={item.message}
                fileLinkContext={fileLinkContext}
                onOpenFileLink={onOpenFileLink}
                onFetchAttachmentContent={onFetchAttachmentContent}
              />
            ),
          )
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <div
          className={`composer-input-surface ${
            draftImages.length > 0 ? "has-attachments" : ""
          }`}
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
          {draftImages.length > 0 ? (
            <DraftImageStrip
              attachments={draftImages}
              onRemove={removeDraftImage}
            />
          ) : null}
          <PromptComposer
            value={draft}
            onChange={setDraft}
            runnerId={session.runnerId}
            agent={session.agent}
            basePath={session.executionFolder}
            onListAgentSkills={onListAgentSkills}
            onSearchWorkspacePaths={onSearchWorkspacePaths}
            onKeyDown={handleComposerKeyDown}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (files.length > 0) {
                event.preventDefault();
                addFiles(files);
              }
            }}
            rows={2}
            placeholder={
              canSubmitMessage
                ? compactComposerPlaceholder
                  ? "Message the active session"
                  : "Message the active session, Cmd/Ctrl+Enter to send"
                : claudeTurnInProgress
                  ? "Waiting for Claude Code"
                  : "Stream is reconnecting"
            }
            ariaLabel="Chat composer"
          />
          {attachmentError ? (
            <p className="form-error composer-error" role="alert">
              {attachmentError}
            </p>
          ) : null}
        </div>
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
        <button
          className="icon-button composer-attach-button"
          type="button"
          aria-label="Attach images"
          title={
            imageLimits.supported
              ? "Attach images"
              : "This agent does not accept image input"
          }
          disabled={!imageLimits.supported || submitting}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus size={17} />
        </button>
        <button
          className="primary-icon-button"
          type="submit"
          aria-label="Send message"
          title="Send message"
          disabled={
            !canSubmitMessage || submitting || draft.trim().length === 0
          }
        >
          {submitting ? <LoaderCircle size={17} /> : <Send size={17} />}
        </button>
      </form>
    </section>
  );
}

function isNearMessageListBottom(list: HTMLElement): boolean {
  const distanceFromBottom =
    list.scrollHeight - list.scrollTop - list.clientHeight;
  return distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
}

function useCompactComposerPlaceholder(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < 768,
  );

  useEffect(() => {
    const listener = () => setCompact(window.innerWidth < 768);
    listener();
    window.addEventListener("resize", listener);
    return () => window.removeEventListener("resize", listener);
  }, []);

  return compact;
}

function getErrorMessage(
  error: unknown,
  fallback = "Unable to rename session.",
): string {
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
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

function DraftImageStrip({
  attachments,
  onRemove,
}: {
  attachments: DraftImageAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="draft-image-strip" aria-label="Attached images">
      {attachments.map((attachment) => (
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
            onClick={() => onRemove(attachment.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function IntermediateOutputGroup({
  items,
  fileLinkContext,
  onOpenFileLink,
}: {
  items: ConversationOutputItem[];
  fileLinkContext: MarkdownFileLinkContext;
  onOpenFileLink?: ((target: MarkdownFileLinkTarget) => void) | undefined;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const keepExpandedOutputVisible = () => {
    const details = detailsRef.current;
    if (!details?.open || typeof details.scrollIntoView !== "function") {
      return;
    }
    const scrollIntoView = () => {
      details.scrollIntoView({ block: "start", inline: "nearest" });
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(scrollIntoView);
    } else {
      scrollIntoView();
    }
  };

  return (
    <details
      className="collapsible-message intermediate-group"
      onToggle={keepExpandedOutputVisible}
      ref={detailsRef}
    >
      <summary>
        <ChevronDown size={16} />
        Intermediate output ({items.length})
      </summary>
      <div className="intermediate-group-list">
        {items.map((item) =>
          item.type === "activityGroup" ? (
            <AgentActivityGroup key={item.id} group={item} nested />
          ) : (
            <IntermediateMessage
              key={item.id}
              message={item.message}
              fileLinkContext={fileLinkContext}
              onOpenFileLink={onOpenFileLink}
            />
          ),
        )}
      </div>
    </details>
  );
}

function AgentActivityGroup({
  group,
  nested = false,
}: {
  group: Extract<ConversationOutputItem, { type: "activityGroup" }>;
  nested?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const latest = group.activities.at(-1);
  const stepCountLabel = `${group.activities.length} ${group.activities.length === 1 ? "step" : "steps"}`;
  const title =
    group.latest && latest
      ? latest.label
      : `Activity (${group.activities.length})`;
  const buttonLabel =
    group.latest && latest ? `${title} · ${stepCountLabel}` : title;

  useEffect(() => {
    if (!group.latest) {
      setOpen(false);
    }
  }, [group.latest]);

  return (
    <div
      className={`collapsible-message activity-group${nested ? " nested" : ""}${group.latest ? " latest" : ""}${open ? " is-open" : ""}`}
    >
      <button
        className="activity-group-trigger"
        type="button"
        aria-label={buttonLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <LoaderCircle
          size={15}
          className={group.latest ? "animate-spin" : undefined}
        />
        <span className="activity-group-title">{title}</span>
        {group.latest && latest ? (
          <span className="activity-group-count" aria-hidden="true">
            · {stepCountLabel}
          </span>
        ) : null}
      </button>
      {open ? (
        <ol className="activity-list">
          {group.activities.map((activity) => (
            <li key={activity.id}>
              <span className="activity-dot" aria-hidden="true" />
              <span className="activity-label">{activity.label}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function IntermediateMessage({
  message,
  fileLinkContext,
  onOpenFileLink,
}: {
  message: UiMessage;
  fileLinkContext: MarkdownFileLinkContext;
  onOpenFileLink?: ((target: MarkdownFileLinkTarget) => void) | undefined;
}) {
  const label = message.variant === "tool" ? "tool" : message.role;
  return (
    <div className={`intermediate-message ${message.role}`}>
      <div className="intermediate-message-meta">{label}</div>
      <div className="intermediate-message-body">
        {message.variant === "tool" ? (
          <details className="collapsible-message tool">
            <summary>
              <SquareTerminal size={16} />
              Tool call {message.toolName ? `· ${message.toolName}` : ""}
            </summary>
            <pre>{message.content}</pre>
          </details>
        ) : message.role === "user" ? (
          <p>{message.content}</p>
        ) : (
          <MarkdownMessage
            content={message.content}
            fileLinkContext={fileLinkContext}
            onOpenFileLink={onOpenFileLink}
          />
        )}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  fileLinkContext,
  onOpenFileLink,
  onFetchAttachmentContent,
}: {
  message: UiMessage;
  fileLinkContext: MarkdownFileLinkContext;
  onOpenFileLink?: ((target: MarkdownFileLinkTarget) => void) | undefined;
  onFetchAttachmentContent?:
    | ((sessionId: string, attachmentId: string) => Promise<Blob>)
    | undefined;
}) {
  if (message.variant === "thought") {
    return (
      <details className="collapsible-message">
        <summary>
          <ChevronDown size={16} />
          Thought
        </summary>
        <p>{message.content}</p>
      </details>
    );
  }

  if (message.variant === "tool") {
    return (
      <details className="collapsible-message tool">
        <summary>
          <SquareTerminal size={16} />
          Tool call {message.toolName ? `· ${message.toolName}` : ""}
        </summary>
        <pre>{message.content}</pre>
      </details>
    );
  }

  const isUser = message.role === "user";
  return (
    <article className={`message ${isUser ? "user" : "assistant"}`}>
      <div className="message-avatar">
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>
      <div className="message-body">
        <div className="message-meta">{message.role}</div>
        {isUser ? (
          <p>{message.content}</p>
        ) : (
          <MarkdownMessage
            content={message.content}
            fileLinkContext={fileLinkContext}
            onOpenFileLink={onOpenFileLink}
          />
        )}
        <MessageAttachmentGallery
          attachments={message.attachments ?? []}
          onFetchAttachmentContent={onFetchAttachmentContent}
        />
      </div>
    </article>
  );
}

function MessageAttachmentGallery({
  attachments,
  onFetchAttachmentContent,
}: {
  attachments: MessageAttachment[];
  onFetchAttachmentContent?:
    | ((sessionId: string, attachmentId: string) => Promise<Blob>)
    | undefined;
}) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="message-attachment-grid" aria-label="Message images">
      {attachments.map((attachment) => (
        <MessageAttachmentImage
          key={attachment.id}
          attachment={attachment}
          onFetchAttachmentContent={onFetchAttachmentContent}
        />
      ))}
    </div>
  );
}

function MessageAttachmentImage({
  attachment,
  onFetchAttachmentContent,
}: {
  attachment: MessageAttachment;
  onFetchAttachmentContent?:
    | ((sessionId: string, attachmentId: string) => Promise<Blob>)
    | undefined;
}) {
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [unavailable, setUnavailable] = useState(
    attachment.status !== "available",
  );

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setImageUrl(undefined);
    setUnavailable(attachment.status !== "available");
    if (attachment.status !== "available" || !onFetchAttachmentContent) {
      return undefined;
    }

    void onFetchAttachmentContent(attachment.sessionId, attachment.id)
      .then((blob) => {
        if (cancelled || typeof URL.createObjectURL !== "function") {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
        setUnavailable(false);
      })
      .catch(() => {
        if (!cancelled) {
          setUnavailable(true);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [
    attachment.id,
    attachment.sessionId,
    attachment.status,
    onFetchAttachmentContent,
  ]);

  if (unavailable || !imageUrl) {
    return (
      <div className="message-image-placeholder">
        <ImagePlus size={18} />
        <span>Image unavailable</span>
      </div>
    );
  }

  return (
    <figure className="message-image-frame">
      <img src={imageUrl} alt={attachment.name} />
      <figcaption>{attachment.name}</figcaption>
    </figure>
  );
}
