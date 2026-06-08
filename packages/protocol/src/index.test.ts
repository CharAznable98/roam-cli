import { describe, expect, it } from "vitest";
import {
  ApiApplyPatchSchema,
  ApiApprovalResponseSchema,
  FileContentResultSchema,
  FileTreeResultSchema,
  FileWriteResultSchema,
  PatchApplyResultSchema,
  RunnerCommandSchema,
  RunnerRegistrationSchema,
  ServerEventSchema,
  nowIso,
} from "./index.js";

describe("protocol schemas", () => {
  it("validates runner registration", () => {
    const runner = RunnerRegistrationSchema.parse({
      runnerId: "runner-local",
      displayName: "Local",
      hostname: "devbox",
      workspaceRoot: "/workspace",
      profile: "strict",
      publicKey: "0123456789abcdef",
      capabilities: [
        { kind: "mock", label: "Mock", command: "node", parser: "mock" },
      ],
      version: "1.0.0",
    });

    expect(runner.capabilities[0]?.supportsResume).toBe(false);
  });

  it("validates event discriminators", () => {
    expect(
      ServerEventSchema.parse({
        type: "session:updated",
        session: {
          id: "s1",
          title: "Task",
          runnerId: "r1",
          agent: "mock",
          status: "running",
          cwd: "/tmp",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      }).type,
    ).toBe("session:updated");
  });

  it("validates file rpc payloads", () => {
    expect(
      FileTreeResultSchema.parse({
        requestId: "req-1",
        sessionId: "s1",
        root: {
          path: ".",
          name: ".",
          type: "directory",
          children: [
            { path: "README.md", name: "README.md", type: "file", size: 42 },
          ],
        },
      }).root.children?.[0]?.name,
    ).toBe("README.md");

    expect(
      FileContentResultSchema.parse({
        requestId: "req-2",
        sessionId: "s1",
        path: "README.md",
        content: "hello",
        truncated: false,
        encoding: "utf8",
      }).content,
    ).toBe("hello");

    expect(
      FileWriteResultSchema.parse({
        requestId: "req-3",
        sessionId: "s1",
        path: "README.md",
        bytesWritten: 5,
        encoding: "utf8",
      }).bytesWritten,
    ).toBe(5);
  });

  it("validates patch apply and signed approval payloads", () => {
    const signedAt = nowIso();
    expect(
      ApiApprovalResponseSchema.parse({
        approved: true,
        signedAt,
        signature: "client-signature",
      }).signedAt,
    ).toBe(signedAt);

    expect(
      ApiApplyPatchSchema.parse({
        patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
        signedAt,
        signature: "patch-signature",
      }).strip,
    ).toBe(1);

    const writeCommand = RunnerCommandSchema.parse({
      type: "writeFileContent",
      requestId: "write-1",
      sessionId: "s1",
      path: "README.md",
      content: "updated",
    });
    expect(writeCommand.type).toBe("writeFileContent");

    const command = RunnerCommandSchema.parse({
      type: "applyPatch",
      requestId: "patch-1",
      sessionId: "s1",
      patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      signedAt,
      signature: "patch-signature",
    });
    expect(command.type).toBe("applyPatch");
    if (command.type === "applyPatch") {
      expect(command.strip).toBe(1);
      expect(command.signature).toBe("patch-signature");
    }

    expect(
      PatchApplyResultSchema.parse({
        requestId: "patch-1",
        sessionId: "s1",
        applied: true,
        changedFiles: ["README.md"],
        message: "applied",
      }).rejected,
    ).toEqual([]);
  });
});
