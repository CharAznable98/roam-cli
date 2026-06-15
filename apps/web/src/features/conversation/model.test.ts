import { describe, expect, it, vi } from "vitest";
import {
  appendTokenMessage,
  getCollapsedIntermediateMessageIds,
  hasLaterFinalAssistantMessage,
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

  it("marks stream messages as intermediate only when a final assistant follows in the same turn", () => {
    const stream: UiMessage = {
      id: "stream-session-1-existing",
      sessionId: "session-1",
      role: "assistant",
      content: "draft",
      encrypted: false,
      createdAt: "2026-06-05T00:00:01.000Z",
    };
    const final: UiMessage = {
      ...stream,
      id: "final",
      content: "final",
      createdAt: "2026-06-05T00:00:02.000Z",
    };
    const nextUser: UiMessage = {
      ...stream,
      id: "user",
      role: "user",
      content: "next question",
      createdAt: "2026-06-05T00:00:03.000Z",
    };

    expect(hasLaterFinalAssistantMessage([stream, final], stream)).toBe(true);
    expect(
      hasLaterFinalAssistantMessage([stream, nextUser, final], stream),
    ).toBe(false);
  });

  it("marks stream messages as intermediate when the final assistant sorts before the stream in the same turn", () => {
    const user: UiMessage = {
      id: "user",
      sessionId: "session-1",
      role: "user",
      content: "question",
      encrypted: false,
      createdAt: "2026-06-05T00:00:01.000Z",
    };
    const final: UiMessage = {
      id: "final",
      sessionId: "session-1",
      role: "assistant",
      content: "final",
      encrypted: false,
      createdAt: "2026-06-05T00:00:02.000Z",
    };
    const stream: UiMessage = {
      id: "stream-session-1-existing",
      sessionId: "session-1",
      role: "assistant",
      content: "draft",
      encrypted: false,
      createdAt: "2026-06-05T00:00:03.000Z",
    };

    expect(hasLaterFinalAssistantMessage([user, final, stream], stream)).toBe(
      true,
    );
  });

  it("precomputes collapsed intermediate message ids by turn", () => {
    const user: UiMessage = {
      id: "user",
      sessionId: "session-1",
      role: "user",
      content: "question",
      encrypted: false,
      createdAt: "2026-06-05T00:00:01.000Z",
    };
    const stream: UiMessage = {
      id: "stream-session-1-existing",
      sessionId: "session-1",
      role: "assistant",
      content: "draft",
      encrypted: false,
      createdAt: "2026-06-05T00:00:03.000Z",
    };
    const final: UiMessage = {
      id: "final",
      sessionId: "session-1",
      role: "assistant",
      content: "final",
      encrypted: false,
      createdAt: "2026-06-05T00:00:02.000Z",
    };
    const nextUser: UiMessage = {
      ...user,
      id: "next-user",
      content: "next question",
      createdAt: "2026-06-05T00:00:04.000Z",
    };
    const nextStream: UiMessage = {
      ...stream,
      id: "stream-session-1-next",
      content: "next draft",
      createdAt: "2026-06-05T00:00:05.000Z",
    };
    const lateFinal: UiMessage = {
      ...final,
      id: "late-final",
      content: "late final",
      createdAt: "2026-06-05T00:00:06.000Z",
    };

    expect(
      [...getCollapsedIntermediateMessageIds([user, final, stream, nextUser])],
    ).toEqual(["stream-session-1-existing"]);
    expect(
      [
        ...getCollapsedIntermediateMessageIds([
          stream,
          nextUser,
          lateFinal,
          nextStream,
        ]),
      ],
    ).toEqual(["stream-session-1-next"]);
  });
});
