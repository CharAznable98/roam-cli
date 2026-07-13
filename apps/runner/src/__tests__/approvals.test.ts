import type { RunnerEvent } from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { ApprovalTracker } from "../approvals/tracker.js";
import { UserInputRequestTracker } from "../input-requests/tracker.js";
import { SessionWaitCoordinator } from "../sessions/wait-coordinator.js";

describe("ApprovalTracker", () => {
  it("emits running before resolving approval decisions", async () => {
    const events: RunnerEvent[] = [];
    let releaseRunning!: () => void;
    const runningEmitted = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    const emit = async (event: RunnerEvent) => {
      events.push(event);
      if (event.type === "sessionStatus" && event.status === "running") {
        await runningEmitted;
      }
    };
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const tracker = new ApprovalTracker({ emit, waits });
    const decisionPromise = tracker.request(
      token,
      { id: "s1", runnerId: "r1" },
      {
        kind: "execCommand",
        summary: "Run tests",
        payload: { command: "pnpm test" },
      },
    );

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "approvalRequested")).toBe(
        true,
      );
    });
    const approval = events.find((event) => event.type === "approvalRequested");
    if (approval?.type !== "approvalRequested") {
      throw new Error("approval was not emitted");
    }
    let settled = false;
    void decisionPromise.then(() => {
      settled = true;
    });

    tracker.resolve(approval.approval.id, true);
    await Promise.resolve();

    expect(events).toContainEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "running",
    });
    expect(settled).toBe(false);

    releaseRunning();

    await expect(decisionPromise).resolves.toEqual({
      approvalId: approval.approval.id,
      approved: true,
      signedAt: expect.any(String),
    });
    expect(settled).toBe(true);
  });

  it("keeps a session waiting until its final pending approval resolves", async () => {
    const events: RunnerEvent[] = [];
    const emit = (event: RunnerEvent) => {
      events.push(event);
    };
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const tracker = new ApprovalTracker({ emit, waits });
    const first = tracker.request(
      token,
      { id: "s1", runnerId: "r1" },
      { kind: "execCommand", summary: "First", payload: {} },
    );
    const second = tracker.request(
      token,
      { id: "s1", runnerId: "r1" },
      { kind: "execCommand", summary: "Second", payload: {} },
    );
    await vi.waitFor(() => {
      expect(
        events.filter((event) => event.type === "approvalRequested"),
      ).toHaveLength(2);
    });
    const approvals = events.filter(
      (event): event is Extract<RunnerEvent, { type: "approvalRequested" }> =>
        event.type === "approvalRequested",
    );

    tracker.resolve(approvals[0]!.approval.id, true);
    await expect(first).resolves.toMatchObject({ approved: true });
    expect(
      events.filter(
        (event) => event.type === "sessionStatus" && event.status === "running",
      ),
    ).toHaveLength(0);

    tracker.resolve(approvals[1]!.approval.id, false);
    await expect(second).resolves.toMatchObject({ approved: false });
    expect(
      events.filter(
        (event) => event.type === "sessionStatus" && event.status === "running",
      ),
    ).toHaveLength(1);
  });

  it("keeps the session waiting while user input remains pending", async () => {
    const events: RunnerEvent[] = [];
    const emit = (event: RunnerEvent) => {
      events.push(event);
    };
    const waits = new SessionWaitCoordinator(emit);
    const token = waits.begin("s1");
    const approvals = new ApprovalTracker({ emit, waits });
    const inputs = new UserInputRequestTracker({ emit, waits });

    const approvalDecision = approvals.request(
      token,
      { id: "s1", runnerId: "r1" },
      { kind: "execCommand", summary: "Approve", payload: {} },
    );
    const inputDecision = inputs.request(
      token,
      { id: "s1", agent: "codex" },
      {
        summary: "Need input",
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What next?",
            isOther: false,
            isSecret: false,
            options: null,
          },
        ],
        payload: {},
      },
    );
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "approvalRequested")).toBe(
        true,
      );
      expect(
        events.some(
          (event) =>
            event.type === "agentActivity" &&
            event.inputRequestId !== undefined,
        ),
      ).toBe(true);
    });
    const approval = events.find((event) => event.type === "approvalRequested");
    const input = events.find(
      (event) =>
        event.type === "agentActivity" && event.inputRequestId !== undefined,
    );
    if (
      approval?.type !== "approvalRequested" ||
      input?.type !== "agentActivity" ||
      input.inputRequestId === undefined
    ) {
      throw new Error("wait requests were not emitted");
    }

    approvals.resolve(approval.approval.id, true);
    await expect(approvalDecision).resolves.toMatchObject({ approved: true });
    expect(
      events.filter(
        (event) => event.type === "sessionStatus" && event.status === "running",
      ),
    ).toHaveLength(0);

    expect(inputs.resolve("s1", input.inputRequestId, "continue")).toBe(true);
    await expect(inputDecision).resolves.toMatchObject({ content: "continue" });
    expect(
      events.filter(
        (event) => event.type === "sessionStatus" && event.status === "running",
      ),
    ).toHaveLength(1);
  });

  it.each(["waiting status", "approval event"] as const)(
    "rolls back a request when the %s emit fails",
    async (failurePoint) => {
      const events: RunnerEvent[] = [];
      let shouldFail = true;
      const emit = (event: RunnerEvent) => {
        events.push(event);
        if (
          shouldFail &&
          ((failurePoint === "waiting status" &&
            event.type === "sessionStatus" &&
            event.status === "waiting_approval") ||
            (failurePoint === "approval event" &&
              event.type === "approvalRequested"))
        ) {
          shouldFail = false;
          throw new Error("sink failed");
        }
      };
      const waits = new SessionWaitCoordinator(emit);
      const token = waits.begin("s1");
      const tracker = new ApprovalTracker({ emit, waits });

      await expect(
        tracker.request(
          token,
          { id: "s1", runnerId: "r1" },
          { kind: "execCommand", summary: "First", payload: {} },
        ),
      ).rejects.toThrow("sink failed");

      const next = tracker.request(
        token,
        { id: "s1", runnerId: "r1" },
        { kind: "execCommand", summary: "Second", payload: {} },
      );
      await vi.waitFor(() => {
        expect(
          events.some(
            (event) =>
              event.type === "approvalRequested" &&
              event.approval.summary === "Second",
          ),
        ).toBe(true);
      });
      const approval = events.find(
        (event) =>
          event.type === "approvalRequested" &&
          event.approval.summary === "Second",
      );
      if (approval?.type !== "approvalRequested") {
        throw new Error("second approval was not emitted");
      }
      tracker.resolve(approval.approval.id, true);
      await expect(next).resolves.toMatchObject({ approved: true });
    },
  );
});
