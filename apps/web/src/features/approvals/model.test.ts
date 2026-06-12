import type { Approval, PatchHunk } from "@roamcli/shared/protocol";
import { describe, expect, it } from "vitest";
import {
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

  it("appends newly streamed hunks in payload order", () => {
    const first = { ...hunk, id: "hunk-a", approvalId: "approval-1", sessionId: "session-1" };
    const second = { ...hunk, id: "hunk-b", approvalId: "approval-1", sessionId: "session-1" };

    expect(mergePatchHunks([], [first, second]).map((item) => item.id)).toEqual([
      "hunk-a",
      "hunk-b",
    ]);
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
});
