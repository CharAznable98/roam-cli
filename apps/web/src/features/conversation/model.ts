import type { Message, SessionStatus } from "@roamcli/shared/protocol";

export type UiMessage = Message & {
  variant?: "message" | "thought" | "tool";
  toolName?: string;
};

export type ConversationDisplayItem =
  | { type: "message"; id: string; message: UiMessage }
  | { type: "intermediateGroup"; id: string; messages: UiMessage[] };

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

function isStreamAssistantMessage(message: Message): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  return (
    message.id.startsWith(`stream-${message.sessionId}-`) ||
    message.id.startsWith(`stream_${message.sessionId}_`)
  );
}

export function getConversationDisplayItems(
  messages: UiMessage[],
  sessionStatus: SessionStatus,
): ConversationDisplayItem[] {
  const displayItems: ConversationDisplayItem[] = [];
  let activeUser: UiMessage | undefined;
  let turnMessages: UiMessage[] = [];

  const flushTurn = (closedByNextUser: boolean) => {
    if (activeUser === undefined) {
      for (const message of turnMessages) {
        displayItems.push(toDisplayMessage(message));
      }
      turnMessages = [];
      return;
    }

    displayItems.push(toDisplayMessage(activeUser));
    const shouldCollapse = closedByNextUser || sessionStatus === "completed";
    pushTurnOutput(displayItems, activeUser, turnMessages, shouldCollapse);
    turnMessages = [];
  };

  for (const message of messages) {
    if (message.role === "user") {
      flushTurn(true);
      activeUser = message;
      continue;
    }
    turnMessages.push(message);
  }

  flushTurn(false);
  return displayItems;
}

function pushTurnOutput(
  displayItems: ConversationDisplayItem[],
  userMessage: UiMessage,
  messages: UiMessage[],
  shouldCollapse: boolean,
): void {
  if (!shouldCollapse) {
    for (const message of messages) {
      displayItems.push(toDisplayMessage(message));
    }
    return;
  }

  const finalAssistantIndex = findLastAssistantIndex(messages);
  if (finalAssistantIndex <= 0) {
    for (const message of messages) {
      displayItems.push(toDisplayMessage(message));
    }
    return;
  }

  const intermediateMessages = messages.slice(0, finalAssistantIndex);
  const finalMessage = messages[finalAssistantIndex];
  if (!finalMessage) {
    for (const message of messages) {
      displayItems.push(toDisplayMessage(message));
    }
    return;
  }
  const trailingMessages = messages.slice(finalAssistantIndex + 1);
  displayItems.push({
    type: "intermediateGroup",
    id: `intermediate-${userMessage.id}-${finalMessage.id}`,
    messages: intermediateMessages,
  });
  displayItems.push(toDisplayMessage(finalMessage));
  for (const message of trailingMessages) {
    displayItems.push(toDisplayMessage(message));
  }
}

function findLastAssistantIndex(messages: UiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return index;
    }
  }
  return -1;
}

function toDisplayMessage(message: UiMessage): ConversationDisplayItem {
  return { type: "message", id: message.id, message };
}
