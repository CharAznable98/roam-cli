import type {
  AgentActivity,
  Message,
  MessageAttachment,
  SessionStatus,
} from "@roamcli/shared/protocol";

export type UiMessage = Message & {
  variant?: "message" | "thought" | "tool";
  toolName?: string;
  attachments?: MessageAttachment[];
};

export type ConversationDisplayItem =
  | { type: "message"; id: string; message: UiMessage }
  | {
      type: "activityGroup";
      id: string;
      activities: AgentActivity[];
      latest: boolean;
    }
  | { type: "intermediateGroup"; id: string; items: ConversationOutputItem[] };

export type ConversationOutputItem = Exclude<
  ConversationDisplayItem,
  { type: "intermediateGroup" }
>;

type TimelineEntry =
  | {
      type: "message";
      item: UiMessage;
      time: number;
      order: number;
    }
  | {
      type: "activity";
      item: AgentActivity;
      time: number;
      order: number;
    };

export function toUiMessage(
  message: Message,
  attachments: readonly MessageAttachment[] = [],
): UiMessage {
  if (message.role === "tool") {
    return { ...message, variant: "tool", attachments: [...attachments] };
  }
  return attachments.length > 0
    ? { ...message, attachments: [...attachments] }
    : message;
}

export function upsertMessage<T extends Message>(items: T[], next: T): T[] {
  const exists = items.some((item) => item.id === next.id);
  if (exists) {
    return items.map((item) => (item.id === next.id ? next : item));
  }
  return sortMessages([...items, next]);
}

export function sortMessages<T extends Message>(messages: T[]): T[] {
  return [...messages].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}

export function getConversationDisplayItems(
  messages: UiMessage[],
  activities: AgentActivity[],
  sessionStatus: SessionStatus,
): ConversationDisplayItem[] {
  const outputItems = buildTimelineOutputItems(
    messages,
    activities,
    isActiveSessionStatus(sessionStatus),
  );
  const displayItems: ConversationDisplayItem[] = [];
  let activeUser: UiMessage | undefined;
  let turnItems: ConversationOutputItem[] = [];

  const flushTurn = (closedByNextUser: boolean) => {
    if (activeUser === undefined) {
      for (const item of turnItems) {
        displayItems.push(item);
      }
      turnItems = [];
      return;
    }

    displayItems.push(toDisplayMessage(activeUser));
    const shouldCollapse = closedByNextUser || sessionStatus === "completed";
    pushTurnOutput(displayItems, activeUser, turnItems, shouldCollapse);
    turnItems = [];
  };

  for (const item of outputItems) {
    if (item.type === "message" && item.message.role === "user") {
      flushTurn(true);
      activeUser = item.message;
      continue;
    }
    turnItems.push(item);
  }

  flushTurn(false);
  return displayItems;
}

function buildTimelineOutputItems(
  messages: UiMessage[],
  activities: AgentActivity[],
  liveTrailingActivity: boolean,
): ConversationOutputItem[] {
  const timeline: TimelineEntry[] = [
    ...messages.map((message, index) => ({
      type: "message" as const,
      item: message,
      time: Date.parse(message.createdAt),
      order: index * 2,
    })),
    ...activities.map((activity, index) => ({
      type: "activity" as const,
      item: activity,
      time: Date.parse(activity.createdAt),
      order: index * 2 + 1,
    })),
  ].sort(
    (left, right) =>
      safeTime(left.time) - safeTime(right.time) ||
      timelineTieOrder(left, right) ||
      left.order - right.order,
  );

  const outputItems: ConversationOutputItem[] = [];
  let pendingActivities: AgentActivity[] = [];

  const flushActivities = (latest: boolean) => {
    if (pendingActivities.length === 0) {
      return;
    }
    outputItems.push(toActivityGroup(pendingActivities, latest));
    pendingActivities = [];
  };

  for (const entry of timeline) {
    if (entry.type === "activity") {
      pendingActivities.push(entry.item);
      continue;
    }
    if (isNormalMessage(entry.item)) {
      flushActivities(false);
    }
    outputItems.push(toDisplayMessage(entry.item));
  }

  flushActivities(liveTrailingActivity);
  return outputItems;
}

function safeTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function timelineTieOrder(left: TimelineEntry, right: TimelineEntry): number {
  if (left.type === right.type) {
    return 0;
  }
  if (left.type === "activity" && right.type === "message") {
    return compareActivityWithMessageTie(right.item);
  }
  if (left.type === "message" && right.type === "activity") {
    return -compareActivityWithMessageTie(left.item);
  }
  return 0;
}

function compareActivityWithMessageTie(message: UiMessage): number {
  if (message.role === "user") {
    return 1;
  }
  if (message.role === "assistant") {
    return -1;
  }
  return 0;
}

function isNormalMessage(message: UiMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

function isActiveSessionStatus(status: SessionStatus): boolean {
  return (
    status === "pending" ||
    status === "running" ||
    status === "waiting_approval" ||
    status === "waiting_input"
  );
}

function toActivityGroup(
  activities: AgentActivity[],
  latest: boolean,
): ConversationOutputItem {
  const first = activities[0];
  const last = activities.at(-1);
  const fallbackId = `activity-${activities.length}`;
  return {
    type: "activityGroup",
    id: `activity-${first?.id ?? fallbackId}-${last?.id ?? fallbackId}`,
    activities: [...activities],
    latest,
  };
}

function pushTurnOutput(
  displayItems: ConversationDisplayItem[],
  userMessage: UiMessage,
  items: ConversationOutputItem[],
  shouldCollapse: boolean,
): void {
  if (!shouldCollapse) {
    for (const item of items) {
      displayItems.push(item);
    }
    return;
  }

  const finalAssistantIndex = findLastAssistantIndex(items);
  if (finalAssistantIndex <= 0) {
    for (const item of items) {
      displayItems.push(item);
    }
    return;
  }

  const finalItem = items[finalAssistantIndex];
  if (!finalItem || finalItem.type !== "message") {
    for (const item of items) {
      displayItems.push(item);
    }
    return;
  }
  const finalSegmentStartIndex = findAssistantSegmentStartIndex(
    items,
    finalAssistantIndex,
  );
  const intermediateItems = items.slice(0, finalSegmentStartIndex);
  const finalSegmentItems = items.slice(
    finalSegmentStartIndex,
    finalAssistantIndex + 1,
  );
  const trailingItems = items.slice(finalAssistantIndex + 1);
  if (intermediateItems.some((item) => item.type === "message")) {
    displayItems.push({
      type: "intermediateGroup",
      id: `intermediate-${userMessage.id}-${finalItem.id}`,
      items: intermediateItems,
    });
  } else {
    for (const item of intermediateItems) {
      displayItems.push(item);
    }
  }
  for (const item of finalSegmentItems) {
    displayItems.push(item);
  }
  for (const item of trailingItems) {
    displayItems.push(item);
  }
}

function findAssistantSegmentStartIndex(
  items: ConversationOutputItem[],
  assistantIndex: number,
): number {
  let segmentStartIndex = assistantIndex;
  while (
    segmentStartIndex > 0 &&
    items[segmentStartIndex - 1]?.type === "activityGroup"
  ) {
    segmentStartIndex -= 1;
  }
  return segmentStartIndex;
}

function findLastAssistantIndex(items: ConversationOutputItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "message" && item.message.role === "assistant") {
      return index;
    }
  }
  return -1;
}

function toDisplayMessage(
  message: UiMessage,
): Extract<ConversationDisplayItem, { type: "message" }> {
  return { type: "message", id: message.id, message };
}
