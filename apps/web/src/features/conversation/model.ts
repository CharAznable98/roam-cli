import type { Message } from "@roamcli/protocol";

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
  return sortMessages(
    exists
      ? items.map((item) => (item.id === next.id ? next : item))
      : [...items, next],
  );
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
    return sortMessages(
      messages.map((message) =>
        message.id === latest.id
          ? { ...message, content: message.content + content }
          : message,
      ),
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
