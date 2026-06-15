import type { Session } from "@roamcli/shared/protocol";
import {
  Bot,
  ChevronDown,
  CircleStop,
  Play,
  Send,
  SquareTerminal,
  Trash2,
  User,
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { hasLaterFinalAssistantMessage, type UiMessage } from "./model";
import { StatusPill } from "../../shared/components/StatusPill";
import { MarkdownMessage } from "./MarkdownMessage";

type ChatPanelProps = {
  session: Session;
  messages: UiMessage[];
  onSend: (content: string) => void;
  onControl?: (signal: "stop" | "resume") => void;
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
  onDelete,
  canSend = true,
  canControl = true,
  onOpenSessionSwitcher,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const messageListRef = useRef<HTMLDivElement>(null);
  const messageScrollKey = messages
    .map((message) => `${message.id}:${message.content.length}`)
    .join("|");

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) {
      return;
    }
    list.scrollTop = list.scrollHeight;
  }, [session.id, messageScrollKey]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanDraft = draft.trim();
    if (!cleanDraft || !canSend) {
      return;
    }

    onSend(cleanDraft);
    setDraft("");
  };

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

      <div className="message-list" ref={messageListRef}>
        {messages.length === 0 ? (
          <div className="empty-state compact">
            No messages have been recorded for this session yet.
          </div>
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              collapsedIntermediate={hasLaterFinalAssistantMessage(
                messages,
                message,
              )}
            />
          ))
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          placeholder={
            canSend ? "Message the active session" : "Stream is reconnecting"
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

function MessageBubble({
  message,
  collapsedIntermediate,
}: {
  message: UiMessage;
  collapsedIntermediate?: boolean;
}) {
  if (collapsedIntermediate) {
    return (
      <details className="collapsible-message intermediate">
        <summary>
          <ChevronDown size={16} />
          Intermediate output
        </summary>
        <MarkdownMessage content={message.content} />
      </details>
    );
  }

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
