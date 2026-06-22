import type { RunnerEvent } from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { ApprovalTracker } from "../approvals/tracker.js";

describe("ApprovalTracker", () => {
  it("emits running before resolving approval decisions", async () => {
    const events: RunnerEvent[] = [];
    let releaseRunning!: () => void;
    const runningEmitted = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    const tracker = new ApprovalTracker({
      emit: async (event) => {
        events.push(event);
        if (event.type === "sessionStatus" && event.status === "running") {
          await runningEmitted;
        }
      },
    });
    const decisionPromise = tracker.request(
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

    tracker.resolve(
      approval.approval.id,
      true,
      "2026-06-21T00:00:00.000Z",
      "sig",
    );
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
      signedAt: "2026-06-21T00:00:00.000Z",
      signature: "sig",
    });
    expect(settled).toBe(true);
  });
});
