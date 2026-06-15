import type { Message } from "@roamcli/shared/protocol";

export type UiMessage = Message & {
  variant?: "message" | "thought" | "tool";
  toolName?: string;
};

export function toUiMessage(message: Message): UiMessage {
  if (message.role === "tool") {
    return { ...message, variant: "tool" };
  }
  return message;
}

export function upsertMessage<T extends Message>(items: T[], next: T): T[] {
  const exists = items.some((item) => item.id === next.id);
  if (exists) {
    return items.map((item) => (item.id === next.id ? next : item));
  }
  return sortMessages([...items, next]);
}

export function appendTokenMessage<T extends UiMessage>(
  messages: T[],
  sessionId: string,
  content: string,
): T[] {
  const latest = [...messages]
    .reverse()
    .find((message) => message.sessionId === sessionId);
  if (latest && isStreamAssistantMessage(latest)) {
    return messages.map((message) =>
      message.id === latest.id
        ? { ...message, content: message.content + content }
        : message,
    ) as T[];
  }
  return sortMessages([
    ...messages,
    {
      id: `stream-${sessionId}-${Date.now()}-${messages.length}`,
      sessionId,
      role: "assistant",
      content,
      encrypted: false,
      createdAt: nextMessageTimestamp(latest),
    } as T,
  ]);
}

export function sortMessages<T extends Message>(messages: T[]): T[] {
  return [...messages].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}

export function nextMessageTimestamp(previous: Message | undefined): string {
  const now = Date.now();
  const previousTime = previous ? Date.parse(previous.createdAt) : 0;
  return new Date(Math.max(now, previousTime + 1)).toISOString();
}

export function isStreamAssistantMessage(message: Message): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  return (
    message.id.startsWith(`stream-${message.sessionId}-`) ||
    message.id.startsWith(`stream_${message.sessionId}_`)
  );
}

export function hasLaterFinalAssistantMessage(
  messages: Message[],
  message: Message,
): boolean {
  if (!isStreamAssistantMessage(message)) {
    return false;
  }
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) {
    return false;
  }
  const sameSession = (item: Message) => item.sessionId === message.sessionId;
  let turnStart = -1;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const item = messages[cursor];
    if (item && sameSession(item) && item.role === "user") {
      turnStart = cursor;
      break;
    }
  }
  const nextUserOffset = messages
    .slice(index + 1)
    .findIndex((item) => sameSession(item) && item.role === "user");
  const turnEnd =
    nextUserOffset === -1 ? messages.length : index + 1 + nextUserOffset;

  for (const item of messages.slice(turnStart + 1, turnEnd)) {
    if (
      sameSession(item) &&
      item.id !== message.id &&
      item.role === "assistant" &&
      !isStreamAssistantMessage(item)
    ) {
      return true;
    }
  }
  return false;
}
