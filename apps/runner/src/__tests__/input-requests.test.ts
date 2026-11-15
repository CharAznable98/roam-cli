import type { RunnerEvent } from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  UserInputAcceptanceRetryableError,
  UserInputRequestTracker,
} from "../input-requests/tracker.js";
import { SessionWaitCoordinator } from "../sessions/wait-coordinator.js";

const plainQuestion = {
  id: "next",
  header: "Next",
  question: "What should happen next?",
  isOther: false,
  isSecret: false,
  options: null,
};

describe("UserInputRequestTracker", () => {
  it("does not publish an already cancelled question", async () => {
    const emit = vi.fn();
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const tracker = new UserInputRequestTracker({ emit, waits });
    const controller = new AbortController();
    controller.abort(new Error("Native dialog expired"));

    await expect(
      tracker.request(
        token,
        { id: "s1" },
        {
          summary: "Expired",
          questions: [plainQuestion],
          payload: {},
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("Native dialog expired");
    expect(emit).not.toHaveBeenCalled();
    expect(waits.hasWaits(token)).toBe(false);
  });

  it("withdraws a cancelled question before accepting the next one", async () => {
    const events: RunnerEvent[] = [];
    const emit = (event: RunnerEvent) => {
      events.push(event);
    };
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const tracker = new UserInputRequestTracker({ emit, waits });
    const controller = new AbortController();
    const first = tracker.request(
      token,
      { id: "s1" },
      {
        summary: "First",
        questions: [plainQuestion],
        payload: {},
        signal: controller.signal,
      },
    );
    void first.catch(() => undefined);
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "waiting_input",
      }),
    );
    const stale = events.find((e) => e.type === "agentActivity");
    controller.abort(new Error("Native dialog expired"));
    await expect(first).rejects.toThrow("Native dialog expired");
    expect(waits.hasWaits(token)).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "running",
    });
    if (stale?.type !== "agentActivity") throw new Error("Missing question");
    await expect(
      tracker.resolve("s1", stale.inputRequestId, "late"),
    ).resolves.toBe(false);

    const next = tracker.request(
      token,
      { id: "s1" },
      {
        summary: "Second",
        questions: [plainQuestion],
        payload: {},
      },
    );
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === "agentActivity")).toHaveLength(2),
    );
    await expect(
      tracker.resolve("s1", undefined, "second answer"),
    ).resolves.toBe(true);
    await expect(next).resolves.toMatchObject({ content: "second answer" });
  });

  it.each([false, true])(
    "does not revive input cancelled while answer status is synchronizing (sink fails=%s)",
    async (failStatus) => {
      const events: RunnerEvent[] = [];
      let holdRunning = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const emit = async (event: RunnerEvent) => {
        events.push(event);
        if (
          holdRunning &&
          event.type === "sessionStatus" &&
          event.status === "running"
        ) {
          holdRunning = false;
          await gate;
          if (failStatus) throw new Error("status sink failed");
        }
      };
      const waits = new SessionWaitCoordinator(emit);
      const token = waits.begin("s1");
      const tracker = new UserInputRequestTracker({ emit, waits });
      const controller = new AbortController();
      const decision = tracker.request(
        token,
        { id: "s1" },
        {
          summary: "First",
          questions: [plainQuestion],
          payload: {},
          signal: controller.signal,
        },
      );
      void decision.catch(() => undefined);
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          type: "sessionStatus",
          sessionId: "s1",
          status: "waiting_input",
        }),
      );
      holdRunning = true;
      const acceptance = tracker.resolve("s1", undefined, "too late");
      void acceptance.catch(() => undefined);
      await vi.waitFor(() =>
        expect(events.at(-1)).toEqual({
          type: "sessionStatus",
          sessionId: "s1",
          status: "running",
        }),
      );
      controller.abort(new Error("expired during acceptance"));
      release();
      if (failStatus)
        await expect(acceptance).rejects.toBeInstanceOf(
          UserInputAcceptanceRetryableError,
        );
      else await expect(acceptance).resolves.toBe(false);
      await expect(decision).rejects.toThrow("expired during acceptance");
      expect(waits.hasWaits(token)).toBe(false);
      await expect(
        tracker.resolve("s1", undefined, "retry stale"),
      ).resolves.toBe(false);
      const next = tracker.request(
        token,
        { id: "s1" },
        { summary: "Next", questions: [plainQuestion], payload: {} },
      );
      await vi.waitFor(() =>
        expect(
          events.filter((event) => event.type === "agentActivity"),
        ).toHaveLength(2),
      );
      await expect(tracker.resolve("s1", undefined, "current")).resolves.toBe(
        true,
      );
      await expect(next).resolves.toMatchObject({ content: "current" });
    },
  );

  it("detaches an answered question's cancellation before a replacement request", async () => {
    const events: RunnerEvent[] = [];
    const emit = (event: RunnerEvent) => {
      events.push(event);
    };
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const tracker = new UserInputRequestTracker({ emit, waits });
    const oldController = new AbortController();
    const first = tracker.request(
      token,
      { id: "s1" },
      {
        summary: "First",
        questions: [plainQuestion],
        payload: {},
        signal: oldController.signal,
      },
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "agentActivity")).toBe(true),
    );
    await tracker.resolve("s1", undefined, "first");
    await first;
    const second = tracker.request(
      token,
      { id: "s1" },
      { summary: "Second", questions: [plainQuestion], payload: {} },
    );
    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.type === "agentActivity"),
      ).toHaveLength(2),
    );
    oldController.abort(new Error("late old timer"));
    expect(waits.hasWaits(token)).toBe(true);
    await expect(tracker.resolve("s1", undefined, "second")).resolves.toBe(
      true,
    );
    await expect(second).resolves.toMatchObject({ content: "second" });
  });

  it.each([
    {
      name: "multiple questions",
      questions: [plainQuestion, { ...plainQuestion, id: "second" }],
    },
    {
      name: "choice options",
      questions: [
        {
          ...plainQuestion,
          options: [{ label: "One", description: "First option" }],
        },
      ],
    },
    {
      name: "secret input",
      questions: [{ ...plainQuestion, isSecret: true }],
    },
  ])(
    "rejects unsupported $name instead of silently dropping structure",
    async ({ questions }) => {
      const emit = () => undefined;
      const waits = new SessionWaitCoordinator(emit);
      const token = waits.begin("s1");
      const tracker = new UserInputRequestTracker({ emit, waits });

      await expect(
        tracker.request(
          token,
          { id: "s1", agent: "codex" },
          { summary: "Need input", questions, payload: { source: "test" } },
        ),
      ).rejects.toThrow("single non-secret free-text question");
    },
  );

  it("preserves the supported question text and resolves its answer", async () => {
    const events: RunnerEvent[] = [];
    const emit = (event: RunnerEvent) => {
      events.push(event);
    };
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const tracker = new UserInputRequestTracker({ emit, waits });
    const decision = tracker.request(
      token,
      { id: "s1", agent: "codex" },
      {
        summary: "Generic summary",
        questions: [plainQuestion],
        payload: { source: "test" },
      },
    );

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "agentActivity")).toBe(true);
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agentActivity",
        sessionId: "s1",
        agent: "codex",
        kind: "status",
        label: "Next: What should happen next?",
      }),
    );

    const request = events.find(
      (event) =>
        event.type === "agentActivity" && event.inputRequestId !== undefined,
    );
    if (
      request?.type !== "agentActivity" ||
      request.inputRequestId === undefined
    ) {
      throw new Error("user input request was not emitted");
    }
    await expect(
      tracker.resolve("s1", request.inputRequestId, "Continue"),
    ).resolves.toBe(true);
    await expect(decision).resolves.toMatchObject({ content: "Continue" });
  });

  it("does not acknowledge an answer until it has synchronously settled the pending decision", async () => {
    const events: RunnerEvent[] = [];
    let releaseRunningStatus: (() => void) | undefined;
    const runningStatusGate = new Promise<void>((resolve) => {
      releaseRunningStatus = resolve;
    });
    let blockRunningStatus = false;
    const emit = (event: RunnerEvent) => {
      events.push(event);
      if (
        blockRunningStatus &&
        event.type === "sessionStatus" &&
        event.status === "running"
      ) {
        return runningStatusGate;
      }
    };
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const tracker = new UserInputRequestTracker({ emit, waits });
    const decision = tracker.request(
      token,
      { id: "s1", agent: "codex" },
      { summary: "Need input", questions: [plainQuestion], payload: {} },
    );
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "waiting_input",
      });
    });
    const request = events.find(
      (
        event,
      ): event is Extract<RunnerEvent, { type: "agentActivity" }> & {
        inputRequestId: string;
      } => event.type === "agentActivity" && event.inputRequestId !== undefined,
    );
    if (request === undefined) {
      throw new Error("user input request was not emitted");
    }

    let delivered = 0;
    void decision.then(() => {
      delivered += 1;
    });
    blockRunningStatus = true;
    const acceptance = tracker.resolve(
      "s1",
      request.inputRequestId,
      "Continue",
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(delivered).toBe(0);
    await expect(
      tracker.resolve("s1", request.inputRequestId, "Duplicate"),
    ).resolves.toBe(false);
    expect(delivered).toBe(0);

    releaseRunningStatus?.();
    await expect(acceptance).resolves.toBe(true);
    await expect(decision).resolves.toMatchObject({ content: "Continue" });
    expect(delivered).toBe(1);
    await expect(
      tracker.resolve("s1", request.inputRequestId, "Late duplicate"),
    ).resolves.toBe(false);
  });

  it("keeps the pending answer retryable when status synchronization fails", async () => {
    const events: RunnerEvent[] = [];
    let failNextRunningStatus = true;
    const emit = (event: RunnerEvent) => {
      events.push(event);
      if (
        failNextRunningStatus &&
        event.type === "sessionStatus" &&
        event.status === "running"
      ) {
        failNextRunningStatus = false;
        throw new Error("status sink failed");
      }
    };
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const tracker = new UserInputRequestTracker({ emit, waits });
    const decision = tracker.request(
      token,
      { id: "s1", agent: "codex" },
      { summary: "Need input", questions: [plainQuestion], payload: {} },
    );
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "waiting_input",
      });
    });
    const request = events.find(
      (
        event,
      ): event is Extract<RunnerEvent, { type: "agentActivity" }> & {
        inputRequestId: string;
      } => event.type === "agentActivity" && event.inputRequestId !== undefined,
    );
    if (request === undefined) {
      throw new Error("user input request was not emitted");
    }

    let delivered = 0;
    void decision.then(() => {
      delivered += 1;
    });
    await expect(
      tracker.resolve("s1", request.inputRequestId, "First attempt"),
    ).rejects.toBeInstanceOf(UserInputAcceptanceRetryableError);
    await Promise.resolve();
    expect(delivered).toBe(0);

    await expect(
      tracker.resolve("s1", request.inputRequestId, "Retry"),
    ).resolves.toBe(true);
    await expect(decision).resolves.toMatchObject({ content: "Retry" });
    expect(delivered).toBe(1);
  });

  it.each(["activity", "waiting status"] as const)(
    "rolls back after a failed %s emit and does not retain stale pending state",
    async (failurePoint) => {
      const events: RunnerEvent[] = [];
      let shouldFail = true;
      const emit = (event: RunnerEvent) => {
        events.push(event);
        if (
          shouldFail &&
          ((failurePoint === "activity" && event.type === "agentActivity") ||
            (failurePoint === "waiting status" &&
              event.type === "sessionStatus" &&
              event.status === "waiting_input"))
        ) {
          shouldFail = false;
          throw new Error("sink failed");
        }
      };
      const waits = new SessionWaitCoordinator(emit);
      const token = waits.begin("s1");
      const tracker = new UserInputRequestTracker({ emit, waits });

      await expect(
        tracker.request(
          token,
          { id: "s1", agent: "codex" },
          {
            summary: "First",
            questions: [plainQuestion],
            payload: {},
          },
        ),
      ).rejects.toThrow("sink failed");
      const staleRequest = events.find(
        (event) =>
          event.type === "agentActivity" && event.inputRequestId !== undefined,
      );

      const nextDecision = tracker.request(
        token,
        { id: "s1", agent: "codex" },
        { summary: "Second", questions: [plainQuestion], payload: {} },
      );
      await vi.waitFor(() => {
        expect(
          events.filter(
            (event) =>
              event.type === "agentActivity" &&
              event.inputRequestId !== undefined,
          ),
        ).toHaveLength(2);
      });
      if (
        staleRequest?.type === "agentActivity" &&
        staleRequest.inputRequestId !== undefined
      ) {
        await expect(
          tracker.resolve("s1", staleRequest.inputRequestId, "stale"),
        ).resolves.toBe(false);
      }
      await expect(
        tracker.resolve("s1", undefined, "current legacy"),
      ).resolves.toBe(true);
      await expect(nextDecision).resolves.toMatchObject({
        content: "current legacy",
      });
    },
  );

  it("accepts id-less legacy responses for sequential requests in one session", async () => {
    const events: RunnerEvent[] = [];
    const emit = (event: RunnerEvent) => {
      events.push(event);
    };
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const tracker = new UserInputRequestTracker({ emit, waits });

    const first = tracker.request(
      token,
      { id: "s1", agent: "codex" },
      { summary: "First", questions: [plainQuestion], payload: {} },
    );
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "agentActivity")).toBe(true);
    });
    await expect(tracker.resolve("s1", undefined, "legacy")).resolves.toBe(
      true,
    );
    await expect(first).resolves.toMatchObject({ content: "legacy" });

    events.length = 0;
    const second = tracker.request(
      token,
      { id: "s1", agent: "codex" },
      { summary: "Second", questions: [plainQuestion], payload: {} },
    );
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "agentActivity")).toBe(true);
    });
    await expect(
      tracker.resolve("s1", undefined, "legacy again"),
    ).resolves.toBe(true);
    await expect(second).resolves.toMatchObject({ content: "legacy again" });
  });

  it("drops id-less responses after terminal cleanup and preserves generation isolation", async () => {
    const events: RunnerEvent[] = [];
    const emit = (event: RunnerEvent) => {
      events.push(event);
    };
    const waits = new SessionWaitCoordinator(emit);
    const tracker = new UserInputRequestTracker({ emit, waits });
    const firstToken = waits.begin("s1");
    const first = tracker.request(
      firstToken,
      { id: "s1", agent: "codex" },
      { summary: "First", questions: [plainQuestion], payload: {} },
    );
    await vi.waitFor(() => {
      expect(
        events.some(
          (event) =>
            event.type === "agentActivity" &&
            event.inputRequestId !== undefined,
        ),
      ).toBe(true);
    });
    const firstRequest = events.find(
      (
        event,
      ): event is Extract<RunnerEvent, { type: "agentActivity" }> & {
        inputRequestId: string;
      } => event.type === "agentActivity" && event.inputRequestId !== undefined,
    );
    if (firstRequest === undefined) {
      throw new Error("first request was not emitted");
    }

    tracker.clear("s1", firstToken);
    waits.finish(firstToken);
    await expect(first).rejects.toThrow(
      "Session ended before user input was provided",
    );
    await expect(
      tracker.resolve("s1", undefined, "stale legacy"),
    ).resolves.toBe(false);

    events.length = 0;
    const secondToken = waits.begin("s1");
    const second = tracker.request(
      secondToken,
      { id: "s1", agent: "codex" },
      { summary: "Restarted", questions: [plainQuestion], payload: {} },
    );
    await vi.waitFor(() => {
      expect(
        events.some(
          (event) =>
            event.type === "agentActivity" &&
            event.inputRequestId !== undefined,
        ),
      ).toBe(true);
    });
    await expect(
      tracker.resolve("s1", firstRequest.inputRequestId, "stale exact"),
    ).resolves.toBe(false);
    await expect(
      tracker.resolve("s1", undefined, "current legacy"),
    ).resolves.toBe(true);
    await expect(second).resolves.toMatchObject({ content: "current legacy" });
  });
});
