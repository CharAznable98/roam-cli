import type { Approval, PatchHunk } from "@roamcli/shared/protocol";
import { describe, expect, it } from "vitest";
import {
  appliedPatchApprovalIds,
  buildPatchFromHunks,
  extractPatchHunks,
  mergePatchHunks,
} from "./model";

const hunk: PatchHunk = {
  id: "hunk-1",
  filePath: "src/App.tsx",
  header: "@@ -1 +1 @@",
  lines: ["-old", "+new"],
  status: "pending",
};

describe("approval patch model", () => {
  it("extracts patch hunks from applyPatch approvals with session metadata", () => {
    const approvals: Approval[] = [
      {
        id: "approval-1",
        sessionId: "session-1",
        runnerId: "runner-1",
        kind: "applyPatch",
        summary: "Apply patch",
        payload: { hunks: [hunk, { broken: true }] },
        status: "pending",
        requestedAt: "2026-06-05T00:00:00.000Z",
      },
      {
        id: "approval-2",
        sessionId: "session-1",
        runnerId: "runner-1",
        kind: "execCommand",
        summary: "Run command",
        payload: { command: "pnpm test" },
        status: "pending",
        requestedAt: "2026-06-05T00:00:00.000Z",
      },
    ];

    expect(extractPatchHunks(approvals)).toEqual([
      { ...hunk, approvalId: "approval-1", sessionId: "session-1" },
    ]);
  });

  it("maps resolved applyPatch approvals to terminal hunk states", () => {
    expect(
      extractPatchHunks([
        {
          id: "approval-1",
          sessionId: "session-1",
          runnerId: "runner-1",
          kind: "applyPatch",
          summary: "Apply patch",
          payload: { hunks: [hunk] },
          status: "approved",
          requestedAt: "2026-06-05T00:00:00.000Z",
        },
        {
          id: "approval-2",
          sessionId: "session-1",
          runnerId: "runner-1",
          kind: "applyPatch",
          summary: "Reject patch",
          payload: { hunks: [{ ...hunk, id: "hunk-2" }] },
          status: "rejected",
          requestedAt: "2026-06-05T00:00:00.000Z",
        },
      ]).map((item) => [item.id, item.status]),
    ).toEqual([
      ["hunk-1", "edited"],
      ["hunk-2", "rejected"],
    ]);
  });

  it("merges hunks by approval id and hunk id", () => {
    const current = [
      { ...hunk, approvalId: "approval-1", sessionId: "session-1" },
    ];
    const next = [
      {
        ...hunk,
        status: "accepted" as const,
        approvalId: "approval-1",
        sessionId: "session-1",
      },
    ];

    expect(mergePatchHunks(current, next)).toEqual(next);
  });

  it("preserves local hunk choices when persisted pending approvals replay", () => {
    const current = [
      {
        ...hunk,
        status: "accepted" as const,
        approvalId: "approval-1",
        sessionId: "session-1",
      },
    ];
    const next = [
      {
        ...hunk,
        status: "pending" as const,
        approvalId: "approval-1",
        sessionId: "session-1",
      },
    ];

    expect(mergePatchHunks(current, next)[0]?.status).toBe("accepted");
  });

  it("appends newly streamed hunks in payload order", () => {
    const first = {
      ...hunk,
      id: "hunk-a",
      approvalId: "approval-1",
      sessionId: "session-1",
    };
    const second = {
      ...hunk,
      id: "hunk-b",
      approvalId: "approval-1",
      sessionId: "session-1",
    };

    expect(mergePatchHunks([], [first, second]).map((item) => item.id)).toEqual(
      ["hunk-a", "hunk-b"],
    );
  });

  it("builds a unified diff from accepted hunks", () => {
    expect(buildPatchFromHunks([hunk])).toBe(
      [
        "diff --git a/src/App.tsx b/src/App.tsx",
        "--- a/src/App.tsx",
        "+++ b/src/App.tsx",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
  });

  it("returns only fully resolved approval ids after patch application", () => {
    expect(
      appliedPatchApprovalIds(
        [
          {
            ...hunk,
            status: "accepted",
            approvalId: "approval-1",
            sessionId: "session-1",
          },
          {
            ...hunk,
            id: "hunk-2",
            status: "rejected",
            approvalId: "approval-1",
            sessionId: "session-1",
          },
          {
            ...hunk,
            id: "hunk-3",
            status: "accepted",
            approvalId: "approval-2",
            sessionId: "session-1",
          },
          {
            ...hunk,
            id: "hunk-4",
            status: "pending",
            approvalId: "approval-2",
            sessionId: "session-1",
          },
        ],
        "session-1",
      ),
    ).toEqual(["approval-1"]);
  });
});
