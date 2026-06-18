import type { Session } from "@roamcli/shared/protocol";
import {
  Bot,
  ChevronDown,
  CircleStop,
  Pencil,
  Play,
  Send,
  SquareTerminal,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getConversationDisplayItems, type UiMessage } from "./model";
import { StatusPill } from "../../shared/components/StatusPill";
import { MarkdownMessage } from "./MarkdownMessage";

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 160;

type ChatPanelProps = {
  session: Session;
  messages: UiMessage[];
  onSend: (content: string) => void;
  onControl?: (signal: "stop" | "resume") => void;
  onRename?: (title: string) => void | Promise<void>;
  onDelete?: () => void;
  canSend?: boolean;
  canControl?: boolean;
  onOpenSessionSwitcher?: () => void;
};

export function ChatPanel({
  session,
  messages,
  onSend,
  onControl,
  onRename,
  onDelete,
  canSend = true,
  canControl = true,
  onOpenSessionSwitcher,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(session.title);
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [renameError, setRenameError] = useState<string | undefined>();
  const messageListRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const messageScrollKey = messages
    .map((message) => `${message.id}:${message.content.length}`)
    .join("|");
  const conversationLayoutKey = `${session.status}|${messageScrollKey}`;
  const displayItems = useMemo(
    () => getConversationDisplayItems(messages, session.status),
    [messages, session.status],
  );

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
  }, [session.id]);

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

  const submitDraft = () => {
    const cleanDraft = draft.trim();
    if (!cleanDraft || !canSend) {
      return;
    }

    onSend(cleanDraft);
    setDraft("");
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitDraft();
  };

  const handleComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    const isSubmitShortcut = event.metaKey || event.ctrlKey;
    if (
      event.key !== "Enter" ||
      !isSubmitShortcut ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();
    submitDraft();
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
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="icon-button"
            type="button"
            aria-label="Rename session"
            title="Rename session"
            disabled={!onRename}
            onClick={openRenameDialog}
          >
            <Pencil size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Resume session"
            title="Resume session"
            disabled={!canControl}
            onClick={() => onControl?.("resume")}
          >
            <Play size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Stop session"
            title="Stop session"
            disabled={!canControl}
            onClick={() => onControl?.("stop")}
          >
            <CircleStop size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Delete session"
            title="Delete session"
            onClick={onDelete}
          >
            <Trash2 size={17} />
          </button>
        </div>
      </div>

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

      <div
        className="message-list"
        ref={messageListRef}
        onScroll={handleMessageListScroll}
      >
        {messages.length === 0 ? (
          <div className="empty-state compact">
            No messages have been recorded for this session yet.
          </div>
        ) : (
          displayItems.map((item) =>
            item.type === "intermediateGroup" ? (
              <IntermediateOutputGroup key={item.id} messages={item.messages} />
            ) : (
              <MessageBubble key={item.id} message={item.message} />
            ),
          )
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          rows={2}
          placeholder={
            canSend
              ? "Message the active session, Cmd/Ctrl+Enter to send"
              : "Stream is reconnecting"
          }
          aria-label="Chat composer"
        />
        <button
          className="primary-icon-button"
          type="submit"
          aria-label="Send message"
          title="Send message"
          disabled={!canSend || draft.trim().length === 0}
        >
          <Send size={17} />
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unable to rename session.";
}

function IntermediateOutputGroup({ messages }: { messages: UiMessage[] }) {
  return (
    <details className="collapsible-message intermediate-group">
      <summary>
        <ChevronDown size={16} />
        中间过程（{messages.length} 条）
      </summary>
      <div className="intermediate-group-list">
        {messages.map((message) => (
          <IntermediateMessage key={message.id} message={message} />
        ))}
      </div>
    </details>
  );
}

function IntermediateMessage({ message }: { message: UiMessage }) {
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
          <MarkdownMessage content={message.content} />
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: UiMessage }) {
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
          <MarkdownMessage content={message.content} />
        )}
      </div>
    </article>
  );
}
