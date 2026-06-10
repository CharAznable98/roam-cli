import { describe, expect, it, vi } from "vitest";
import {
  appendTokenMessage,
  sortMessages,
  toUiMessage,
  upsertMessage,
  type UiMessage,
} from "./model";

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

  it("appends streamed tokens to the latest stream assistant message", () => {
    vi.setSystemTime(new Date("2026-06-05T00:00:03.000Z"));
    const seeded = appendTokenMessage([] as UiMessage[], "session-1", "hello");
    const appended = appendTokenMessage(seeded, "session-1", " world");

    expect(appended).toHaveLength(1);
    expect(appended[0]?.content).toBe("hello world");
    expect(appended[0]?.id).toMatch(/^stream-session-1-/);
    vi.useRealTimers();
  });
});
