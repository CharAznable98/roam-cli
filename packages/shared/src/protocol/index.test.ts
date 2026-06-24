import { describe, expect, it } from "vitest";
import {
  ApiApplyPatchSchema,
  ApiApprovalResponseSchema,
  FileContentResultSchema,
  FileTreeResultSchema,
  FileWriteResultSchema,
  ImageAttachmentUploadSchema,
  PatchApplyResultSchema,
  ApiCreateSessionSchema,
  DEFAULT_MAX_IMAGE_BYTES,
  RunnerAuthenticateSchema,
  RunnerCommandSchema,
  RunnerRegistrationSchema,
  RunnerEventSchema,
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
        {
          kind: "vendor.custom-agent",
          label: "Custom",
          command: "custom-agent",
          parser: "custom-json",
          pluginName: "@vendor/custom-agent",
          pluginVersion: "1.0.0",
        },
      ],
      version: "1.0.0",
    });

    expect(runner.capabilities[0]?.supportsResume).toBe(false);
    expect(runner.capabilities[0]?.supportsImages).toBe(false);
    expect(runner.capabilities[0]?.supportedImageMimeTypes).toEqual([]);
    expect(runner.capabilities[0]?.maxImagesPerTurn).toBe(0);
    expect(runner.capabilities[0]?.maxImageBytes).toBe(DEFAULT_MAX_IMAGE_BYTES);
    expect(runner.capabilities[0]?.kind).toBe("vendor.custom-agent");
    expect(runner.capabilities[0]?.pluginName).toBe("@vendor/custom-agent");
  });

  it("validates image attachment uploads, runner refs, and public events", () => {
    const uploaded = ImageAttachmentUploadSchema.parse({
      name: "screen.png",
      mimeType: "image/png",
      size: 5,
      contentBase64: "aGVsbG8=",
    });
    expect(uploaded.size).toBe(5);
    expect(() =>
      ImageAttachmentUploadSchema.parse({
        ...uploaded,
        contentBase64: "not base64!",
      }),
    ).toThrow();

    const writeCommand = RunnerCommandSchema.parse({
      type: "writeSessionAttachments",
      requestId: "attachment-write-1",
      sessionId: "session-1",
      attachments: [uploaded],
    });
    expect(writeCommand.type).toBe("writeSessionAttachments");

    const runnerRef = {
      id: "attachment-1",
      kind: "image",
      name: "screen.png",
      mimeType: "image/png",
      size: 5,
      sha256: "0123456789abcdef0123456789abcdef",
      runnerStoragePath: "attachments/session-1/attachment-1/screen.png",
    } as const;
    const startCommand = RunnerCommandSchema.parse({
      type: "startSession",
      session: sessionRecord(),
      prompt: "describe",
      attachments: [runnerRef],
    });
    expect(startCommand.type).toBe("startSession");
    if (startCommand.type === "startSession") {
      expect(startCommand.attachments).toEqual([runnerRef]);
    }

    expect(
      RunnerEventSchema.parse({
        type: "attachmentWriteResult",
        result: {
          requestId: "attachment-write-1",
          sessionId: "session-1",
          attachments: [runnerRef],
        },
      }).type,
    ).toBe("attachmentWriteResult");

    const event = ServerEventSchema.parse({
      type: "message_attachment:created",
      attachment: {
        id: runnerRef.id,
        sessionId: "session-1",
        messageId: "message-1",
        runnerId: "runner-1",
        kind: "image",
        name: runnerRef.name,
        mimeType: runnerRef.mimeType,
        size: runnerRef.size,
        sha256: runnerRef.sha256,
        status: "available",
        createdAt: nowIso(),
      },
    });
    expect(event.type).toBe("message_attachment:created");
    if (event.type === "message_attachment:created") {
      expect(event.attachment).not.toHaveProperty("runnerStoragePath");
    }
  });

  it("accepts dynamic non-empty agent ids and rejects empty agent ids", () => {
    expect(
      ApiCreateSessionSchema.parse({
        projectId: "project-1",
        agent: "vendor.custom-agent",
        prompt: "run",
      }).agent,
    ).toBe("vendor.custom-agent");

    expect(() =>
      ApiCreateSessionSchema.parse({
        projectId: "project-1",
        agent: "",
        prompt: "run",
      }),
    ).toThrow();
  });

  it("validates event discriminators", () => {
    expect(
      ServerEventSchema.parse({
        type: "session:updated",
        session: {
          id: "s1",
          title: "Task",
          projectId: "project-1",
          runnerId: "r1",
          agent: "codex",
          status: "running",
          executionMode: "direct",
          executionFolder: "/tmp",
          cwd: "/tmp",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      }).type,
    ).toBe("session:updated");
  });

  it("accepts legacy git status runner events without a result kind", () => {
    const event = RunnerEventSchema.parse({
      type: "gitStatusResult",
      result: {
        requestId: "git-status-1",
        context: { kind: "project", projectId: "project-1" },
        branch: "main",
        detached: false,
        headSha: "abc123",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        clean: true,
        unborn: false,
        groups: [{ id: "unstaged", changes: [] }],
      },
    });

    expect(event).toMatchObject({
      type: "gitStatusResult",
      result: {
        kind: "repository",
        requestId: "git-status-1",
        clean: true,
      },
    });
  });

  it("validates file rpc payloads", () => {
    expect(
      FileTreeResultSchema.parse({
        requestId: "req-1",
        clientRequestId: "client-req-1",
        sessionId: "s1",
        root: {
          path: ".",
          name: ".",
          type: "directory",
          children: [
            { path: "README.md", name: "README.md", type: "file", size: 42 },
          ],
        },
      }),
    ).toMatchObject({
      clientRequestId: "client-req-1",
      root: { children: [{ name: "README.md" }] },
    });

    const textContent = FileContentResultSchema.parse({
      requestId: "req-2",
      sessionId: "s1",
      path: "README.md",
      kind: "text",
      content: "hello",
      truncated: false,
      encoding: "utf8",
    });
    expect(textContent.kind).toBe("text");
    if (textContent.kind === "text") {
      expect(textContent.content).toBe("hello");
    }

    expect(
      FileContentResultSchema.parse({
        requestId: "req-2-image",
        sessionId: "s1",
        path: "screen.png",
        kind: "image",
        contentBase64: "aGVsbG8=",
        mimeType: "image/png",
        size: 5,
        truncated: false,
        encoding: "base64",
      }).kind,
    ).toBe("image");

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

  it("validates patch apply, approval, and runner auth payloads", () => {
    expect(
      ApiApprovalResponseSchema.parse({
        approved: true,
      }).approved,
    ).toBe(true);

    expect(
      ApiApplyPatchSchema.parse({
        patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
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
    });
    expect(command.type).toBe("applyPatch");
    if (command.type === "applyPatch") {
      expect(command.strip).toBe(1);
    }

    expect(
      RunnerAuthenticateSchema.parse({
        type: "runnerAuthenticate",
        token: "runner-token",
        runner: runnerRegistration(),
      }).runner.runnerId,
    ).toBe("runner-1");

    expect(
      PatchApplyResultSchema.parse({
        requestId: "patch-1",
        sessionId: "s1",
        applied: true,
        changedFiles: ["README.md"],
        message: "applied",
      }).rejected,
    ).toEqual([]);

    expect(
      RunnerCommandSchema.parse({
        type: "checkSessionStatus",
        requestId: "check-1",
        sessionId: "s1",
      }),
    ).toMatchObject({
      type: "checkSessionStatus",
      requestId: "check-1",
      sessionId: "s1",
    });

    expect(
      RunnerEventSchema.parse({
        type: "sessionStatusCheckResult",
        result: {
          requestId: "check-1",
          sessionId: "s1",
          active: false,
        },
      }),
    ).toMatchObject({
      type: "sessionStatusCheckResult",
      result: { requestId: "check-1", sessionId: "s1", active: false },
    });
  });
});

function sessionRecord() {
  const now = nowIso();
  return {
    id: "session-1",
    title: "Session",
    projectId: "project-1",
    runnerId: "runner-1",
    agent: "codex",
    status: "running",
    executionMode: "direct",
    executionFolder: "/workspace",
    cwd: "/workspace",
    createdAt: now,
    updatedAt: now,
  };
}

function runnerRegistration() {
  return {
    runnerId: "runner-1",
    displayName: "Local",
    hostname: "devbox",
    workspaceRoot: "/workspace",
    profile: "standard",
    publicKey: "0123456789abcdef",
    capabilities: [
      {
        kind: "codex",
        label: "Codex",
        command: "codex",
        parser: "jsonl",
      },
    ],
    version: "1.0.0",
  };
}
