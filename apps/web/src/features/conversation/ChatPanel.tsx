import type { Session } from "@roamcli/protocol";
import { Bot, ChevronDown, CircleStop, Play, Send, SquareTerminal, Trash2, User } from "lucide-react";
import { FormEvent, useState } from "react";
import type { UiMessage } from "./model";
import { StatusPill } from "../../shared/components/StatusPill";
import { VoiceButton } from "./VoiceButton";

type ChatPanelProps = {
  session: Session;
  messages: UiMessage[];
  onSend: (content: string) => void;
  onControl?: (signal: "stop" | "resume") => void;
  onDelete?: () => void;
};

export function ChatPanel({ session, messages, onSend, onControl, onDelete }: ChatPanelProps) {
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanDraft = draft.trim();
    if (!cleanDraft) {
      return;
    }

    onSend(cleanDraft);
    setDraft("");
  };

  return (
    <section className="chat-column" aria-label="Conversation">
      <div className="chat-header">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold text-ink-900">{session.title}</h1>
            <StatusPill status={session.status} />
          </div>
          <p className="truncate text-xs text-ink-500">
            {session.agent} on {session.runnerId} · {session.cwd}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="icon-button" type="button" aria-label="Resume session" title="Resume session" onClick={() => onControl?.("resume")}>
            <Play size={17} />
          </button>
          <button className="icon-button" type="button" aria-label="Stop session" title="Stop session" onClick={() => onControl?.("stop")}>
            <CircleStop size={17} />
          </button>
          <button className="icon-button" type="button" aria-label="Delete session" title="Delete session" onClick={onDelete}>
            <Trash2 size={17} />
          </button>
        </div>
      </div>

      <div className="message-list">
        {messages.length === 0 ? (
          <div className="empty-state compact">No messages have been recorded for this session yet.</div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <VoiceButton onTranscript={(value) => setDraft(value)} />
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          placeholder="Message the active session"
          aria-label="Chat composer"
        />
        <button className="primary-icon-button" type="submit" aria-label="Send message" title="Send message">
          <Send size={17} />
        </button>
      </form>
    </section>
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
      <div className="message-avatar">{isUser ? <User size={16} /> : <Bot size={16} />}</div>
      <div className="message-body">
        <div className="message-meta">{message.role}</div>
        <p>{message.content}</p>
      </div>
    </article>
  );
}
