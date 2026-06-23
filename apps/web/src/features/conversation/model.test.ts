import type { AgentActivity } from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  appendTokenMessage,
  getConversationDisplayItems,
  sortMessages,
  toUiMessage,
  upsertMessage,
  type ConversationDisplayItem,
  type UiMessage,
} from "./model";

function makeMessage(
  message: Pick<UiMessage, "content" | "id" | "role"> & Partial<UiMessage>,
): UiMessage {
  return {
    sessionId: "session-1",
    encrypted: false,
    createdAt: "2026-06-05T00:00:00.000Z",
    ...message,
  };
}

function makeActivity(
  activity: Pick<AgentActivity, "id" | "label" | "kind"> &
    Partial<AgentActivity>,
): AgentActivity {
  return {
    sessionId: "session-1",
    agent: "claude-code",
    createdAt: "2026-06-05T00:00:00.000Z",
    ...activity,
  };
}

function displayShape(items: ConversationDisplayItem[]) {
  return items.map(displayItemShape);
}

function displayItemShape(item: ConversationDisplayItem): unknown {
  if (item.type === "message") {
    return item.message.id;
  }
  if (item.type === "activityGroup") {
    return {
      activity: item.activities.map((activity) => activity.label),
      latest: item.latest,
    };
  }
  return {
    intermediate: item.items.map((nested) =>
      nested.type === "message"
        ? nested.message.id
        : {
            activity: nested.activities.map((activity) => activity.label),
            latest: nested.latest,
          },
    ),
  };
}

describe("conversation model", () => {
  it("marks tool messages for collapsible rendering", () => {
    expect(
      toUiMessage({
        id: "message-1",
        sessionId: "session-1",
        role: "tool",
        content: "pnpm test",
        encrypted: false,
        createdAt: "2026-06-05T00:00:00.000Z",
      }),
    ).toMatchObject({ variant: "tool" });
  });

  it("sorts and upserts messages by timestamp", () => {
    const late: UiMessage = {
      id: "late",
      sessionId: "session-1",
      role: "assistant",
      content: "late",
      encrypted: false,
      createdAt: "2026-06-05T00:00:02.000Z",
    };
    const early: UiMessage = {
      ...late,
      id: "early",
      content: "early",
      createdAt: "2026-06-05T00:00:01.000Z",
    };

    expect(sortMessages([late, early]).map((message) => message.id)).toEqual([
      "early",
      "late",
    ]);
    expect(upsertMessage([early], { ...early, content: "updated" })).toEqual([
      { ...early, content: "updated" },
    ]);
  });

  it("preserves message position when updating an existing message", () => {
    const first: UiMessage = {
      id: "first",
      sessionId: "session-1",
      role: "assistant",
      content: "first",
      encrypted: false,
      createdAt: "2026-06-05T00:00:02.000Z",
    };
    const second: UiMessage = {
      ...first,
      id: "second",
      content: "second",
      createdAt: "2026-06-05T00:00:01.000Z",
    };

    expect(
      upsertMessage([first, second], { ...first, content: "updated" }).map(
        (message) => message.id,
      ),
    ).toEqual(["first", "second"]);
  });

  it("appends streamed tokens to the latest stream assistant message", () => {
    vi.setSystemTime(new Date("2026-06-05T00:00:03.000Z"));
    const seeded = appendTokenMessage([] as UiMessage[], "session-1", "hello");
    const appended = appendTokenMessage(seeded, "session-1", " world");

    expect(appended).toHaveLength(1);
    expect(appended[0]?.content).toBe("hello world");
    expect(appended[0]?.id).toMatch(/^stream-session-1-/);
    vi.useRealTimers();
  });

  it("does not re-sort the full message list for streaming token updates", () => {
    const newerUser: UiMessage = {
      id: "newer-user",
      sessionId: "session-1",
      role: "user",
      content: "question",
      encrypted: false,
      createdAt: "2026-06-05T00:00:03.000Z",
    };
    const stream: UiMessage = {
      id: "stream-session-1-existing",
      sessionId: "session-1",
      role: "assistant",
      content: "hello",
      encrypted: false,
      createdAt: "2026-06-05T00:00:02.000Z",
    };

    expect(
      appendTokenMessage([newerUser, stream], "session-1", " world").map(
        (message) => message.id,
      ),
    ).toEqual(["newer-user", "stream-session-1-existing"]);
  });

  it("groups completed turn output before the final assistant message", () => {
    const items = getConversationDisplayItems(
      [
        makeMessage({ id: "user", role: "user", content: "question" }),
        makeMessage({ id: "progress", role: "assistant", content: "working" }),
        makeMessage({ id: "final", role: "assistant", content: "answer" }),
      ],
      [],
      "completed",
    );

    expect(displayShape(items)).toEqual([
      "user",
      { intermediate: ["progress"] },
      "final",
    ]);
  });

  it("does not collapse the active turn until the session is completed", () => {
    const messages = [
      makeMessage({ id: "user", role: "user", content: "question" }),
      makeMessage({ id: "progress", role: "assistant", content: "working" }),
      makeMessage({ id: "latest", role: "assistant", content: "still going" }),
    ];

    expect(
      displayShape(getConversationDisplayItems(messages, [], "running")),
    ).toEqual(["user", "progress", "latest"]);
    expect(
      displayShape(getConversationDisplayItems(messages, [], "failed")),
    ).toEqual(["user", "progress", "latest"]);
    expect(
      displayShape(getConversationDisplayItems(messages, [], "stopped")),
    ).toEqual(["user", "progress", "latest"]);
    expect(
      displayShape(
        getConversationDisplayItems(messages, [], "waiting_approval"),
      ),
    ).toEqual(["user", "progress", "latest"]);
  });

  it("keeps old turns collapsed while a resumed turn is running", () => {
    const items = getConversationDisplayItems(
      [
        makeMessage({ id: "user-1", role: "user", content: "first" }),
        makeMessage({ id: "progress-1", role: "assistant", content: "work" }),
        makeMessage({ id: "final-1", role: "assistant", content: "answer" }),
        makeMessage({ id: "user-2", role: "user", content: "second" }),
        makeMessage({ id: "progress-2", role: "assistant", content: "work" }),
        makeMessage({ id: "latest-2", role: "assistant", content: "running" }),
      ],
      [],
      "running",
    );

    expect(displayShape(items)).toEqual([
      "user-1",
      { intermediate: ["progress-1"] },
      "final-1",
      "user-2",
      "progress-2",
      "latest-2",
    ]);
  });

  it("treats stream messages as ordinary turn output for grouping", () => {
    const items = getConversationDisplayItems(
      [
        makeMessage({ id: "user", role: "user", content: "question" }),
        makeMessage({
          id: "stream-session-1-existing",
          role: "assistant",
          content: "draft",
        }),
        makeMessage({ id: "final", role: "assistant", content: "answer" }),
      ],
      [],
      "completed",
    );

    expect(displayShape(items)).toEqual([
      "user",
      { intermediate: ["stream-session-1-existing"] },
      "final",
    ]);
  });

  it("does not render an empty intermediate group", () => {
    const items = getConversationDisplayItems(
      [
        makeMessage({ id: "user", role: "user", content: "question" }),
        makeMessage({ id: "final", role: "assistant", content: "answer" }),
      ],
      [],
      "completed",
    );

    expect(displayShape(items)).toEqual(["user", "final"]);
  });

  it("includes future non-assistant output before the final assistant in the outer group", () => {
    const items = getConversationDisplayItems(
      [
        makeMessage({ id: "user", role: "user", content: "question" }),
        makeMessage({ id: "tool", role: "tool", content: "pnpm test" }),
        makeMessage({ id: "system", role: "system", content: "note" }),
        makeMessage({ id: "final", role: "assistant", content: "answer" }),
      ],
      [],
      "completed",
    );

    expect(displayShape(items)).toEqual([
      "user",
      { intermediate: ["tool", "system"] },
      "final",
    ]);
  });

  it("groups activity above the next normal message without creating intermediate output", () => {
    const items = getConversationDisplayItems(
      [
        makeMessage({ id: "user", role: "user", content: "question" }),
        makeMessage({
          id: "final",
          role: "assistant",
          content: "answer",
          createdAt: "2026-06-05T00:00:03.000Z",
        }),
      ],
      [
        makeActivity({
          id: "activity-1",
          kind: "task_progress",
          label: "Reading file.ts",
          createdAt: "2026-06-05T00:00:01.000Z",
        }),
        makeActivity({
          id: "activity-2",
          kind: "task_progress",
          label: "Running tests",
          createdAt: "2026-06-05T00:00:02.000Z",
        }),
      ],
      "completed",
    );

    expect(displayShape(items)).toEqual([
      "user",
      { activity: ["Reading file.ts", "Running tests"], latest: false },
      "final",
    ]);
  });

  it("keeps trailing activity as the latest live group", () => {
    const items = getConversationDisplayItems(
      [makeMessage({ id: "user", role: "user", content: "question" })],
      [
        makeActivity({
          id: "activity-1",
          kind: "task_progress",
          label: "Reading file.ts",
          createdAt: "2026-06-05T00:00:01.000Z",
        }),
      ],
      "running",
    );

    expect(displayShape(items)).toEqual([
      "user",
      { activity: ["Reading file.ts"], latest: true },
    ]);
  });

  it("folds activity groups into intermediate output when message output is collapsed", () => {
    const items = getConversationDisplayItems(
      [
        makeMessage({ id: "user", role: "user", content: "question" }),
        makeMessage({
          id: "progress",
          role: "assistant",
          content: "working",
          createdAt: "2026-06-05T00:00:02.000Z",
        }),
        makeMessage({
          id: "final",
          role: "assistant",
          content: "answer",
          createdAt: "2026-06-05T00:00:04.000Z",
        }),
      ],
      [
        makeActivity({
          id: "activity-1",
          kind: "task_progress",
          label: "Reading file.ts",
          createdAt: "2026-06-05T00:00:01.000Z",
        }),
        makeActivity({
          id: "activity-2",
          kind: "task_progress",
          label: "Running tests",
          createdAt: "2026-06-05T00:00:03.000Z",
        }),
      ],
      "completed",
    );

    expect(displayShape(items)).toEqual([
      "user",
      {
        intermediate: [
          { activity: ["Reading file.ts"], latest: false },
          "progress",
          { activity: ["Running tests"], latest: false },
        ],
      },
      "final",
    ]);
  });
});
