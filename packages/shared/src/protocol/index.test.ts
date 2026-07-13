import { describe, expect, it } from "vitest";
import {
  ApiApplyPatchSchema,
  ApiApprovalResponseSchema,
  ApiCreateProjectPromptPresetSchema,
  FileContentResultSchema,
  FileTreeResultSchema,
  FileWriteResultSchema,
  ImageAttachmentUploadSchema,
  PatchApplyResultSchema,
  ApiCreateSessionSchema,
  ApiReorderProjectPromptPresetsSchema,
  ApiUpdateProjectPromptPresetSchema,
  ClientCommandSchema,
  DEFAULT_MAX_IMAGE_BYTES,
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_REQUEST,
  PROJECT_PROMPT_PRESET_CONTENT_MAX_LENGTH,
  PROJECT_PROMPT_PRESET_TITLE_MAX_LENGTH,
  RunnerAuthenticateSchema,
  RunnerCommandSchema,
  RunnerEventAckSchema,
  RunnerEventEnvelopeSchema,
  RunnerEventNackSchema,
  RunnerEventResumeSchema,
  RunnerRegistrationSchema,
  RunnerEventSchema,
  ServerEventSchema,
  SessionStatusCheckResultSchema,
  nowIso,
} from "./index.js";

describe("protocol schemas", () => {
  it("validates optional ACK v1 negotiation and transport control frames", () => {
    const streamId = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      RunnerAuthenticateSchema.parse({
        type: "runnerAuthenticate",
        token: "runner-token",
        runner: runnerRegistration(),
        eventDelivery: {
          protocol: "ack_v1",
          streamId,
          acknowledgedThrough: 3,
        },
      }).eventDelivery,
    ).toEqual({ protocol: "ack_v1", streamId, acknowledgedThrough: 3 });
    expect(
      RunnerEventResumeSchema.parse({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId,
        ackThrough: 3,
      }),
    ).toMatchObject({ ackThrough: 3 });
    expect(
      RunnerEventEnvelopeSchema.parse({
        type: "runnerEvent",
        protocol: "ack_v1",
        streamId,
        sequence: 4,
        event: {
          type: "sessionStatus",
          sessionId: "session-1",
          status: "running",
        },
      }),
    ).toMatchObject({ sequence: 4 });
    expect(
      RunnerEventAckSchema.parse({
        type: "runnerEventAck",
        protocol: "ack_v1",
        streamId,
        ackThrough: 4,
      }),
    ).toMatchObject({ ackThrough: 4 });
    expect(
      RunnerEventNackSchema.parse({
        type: "runnerEventNack",
        protocol: "ack_v1",
        streamId,
        ackThrough: 3,
        expectedSequence: 4,
      }),
    ).toMatchObject({ expectedSequence: 4 });
    expect(
      RunnerEventEnvelopeSchema.safeParse({
        type: "runnerEvent",
        protocol: "ack_v1",
        streamId,
        sequence: 0,
        event: { type: "registered", runner: runnerRegistration() },
      }).success,
    ).toBe(false);
  });

  it("represents unsupported approval signatures without a fake public key", () => {
    expect(
      RunnerRegistrationSchema.parse({
        runnerId: "runner-1",
        displayName: "Runner 1",
        hostname: "host",
        workspaceRoot: "/workspace",
        profile: "standard",
        approvalSignatureMode: "unsupported",
        capabilities: [
          {
            kind: "codex",
            label: "Codex",
            command: "codex",
            parser: "codex-app-server",
          },
        ],
        version: "1.1.0",
      }),
    ).toMatchObject({ approvalSignatureMode: "unsupported" });
  });
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
    expect(() =>
      ImageAttachmentUploadSchema.parse({
        ...uploaded,
        size: MAX_ATTACHMENT_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      ImageAttachmentUploadSchema.parse({
        ...uploaded,
        size: MAX_ATTACHMENT_BYTES,
        contentBase64: "A".repeat(MAX_ATTACHMENT_BASE64_LENGTH + 4),
      }),
    ).toThrow();
    expect(() =>
      ImageAttachmentUploadSchema.parse({
        ...uploaded,
        size: uploaded.size + 1,
      }),
    ).toThrow("Declared attachment size does not match the payload");

    const writeCommand = RunnerCommandSchema.parse({
      type: "writeSessionAttachments",
      requestId: "attachment-write-1",
      sessionId: "session-1",
      attachments: [uploaded],
    });
    expect(writeCommand.type).toBe("writeSessionAttachments");
    expect(() =>
      RunnerCommandSchema.parse({
        type: "writeSessionAttachments",
        requestId: "attachment-write-too-many",
        sessionId: "session-1",
        attachments: Array.from(
          { length: MAX_ATTACHMENTS_PER_REQUEST + 1 },
          () => uploaded,
        ),
      }),
    ).toThrow();

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

  it("validates active session subscription commands", () => {
    expect(
      ClientCommandSchema.parse({
        type: "activeSessionChanged",
        requestId: "active-session-1",
        sessionId: "session-1",
      }),
    ).toEqual({
      type: "activeSessionChanged",
      requestId: "active-session-1",
      sessionId: "session-1",
    });
    expect(
      ClientCommandSchema.parse({
        type: "activeSessionChanged",
        requestId: "active-session-none",
      }),
    ).toEqual({
      type: "activeSessionChanged",
      requestId: "active-session-none",
    });
  });

  it("preserves runtime config on stream create-session commands", () => {
    expect(
      ClientCommandSchema.parse({
        type: "createSession",
        requestId: "create-session-1",
        projectId: "project-1",
        agent: "codex",
        prompt: "run",
        agentRuntimeConfig: {
          model: "gpt-5-codex",
          reasoningEffort: "high",
          serviceTier: "flex",
        },
      }),
    ).toEqual({
      type: "createSession",
      requestId: "create-session-1",
      projectId: "project-1",
      agent: "codex",
      executionMode: "direct",
      prompt: "run",
      agentRuntimeConfig: {
        model: "gpt-5-codex",
        reasoningEffort: "high",
        serviceTier: "flex",
      },
      attachments: [],
    });
  });

  it("accepts dynamic non-empty agent ids and rejects empty agent ids", () => {
    expect(
      ApiCreateSessionSchema.parse({
        requestId: "create-session-dynamic-agent",
        projectId: "project-1",
        agent: "vendor.custom-agent",
        prompt: "run",
      }).agent,
    ).toBe("vendor.custom-agent");

    expect(() =>
      ApiCreateSessionSchema.parse({
        requestId: "create-session-empty-agent",
        projectId: "project-1",
        agent: "",
        prompt: "run",
      }),
    ).toThrow();
  });

  it("validates project prompt preset inputs", () => {
    expect(
      ApiCreateProjectPromptPresetSchema.parse({
        title: "  Review checklist  ",
        content: "  Keep bullets concise.\nPreserve line breaks.  ",
      }),
    ).toEqual({
      title: "Review checklist",
      content: "Keep bullets concise.\nPreserve line breaks.",
    });

    expect(() =>
      ApiCreateProjectPromptPresetSchema.parse({
        title: "x".repeat(PROJECT_PROMPT_PRESET_TITLE_MAX_LENGTH + 1),
        content: "Valid content",
      }),
    ).toThrow();
    expect(() =>
      ApiCreateProjectPromptPresetSchema.parse({
        title: "Valid title",
        content: "x".repeat(PROJECT_PROMPT_PRESET_CONTENT_MAX_LENGTH + 1),
      }),
    ).toThrow();
    expect(() => ApiUpdateProjectPromptPresetSchema.parse({})).toThrow();
    expect(
      ApiUpdateProjectPromptPresetSchema.parse({ content: "  Updated  " }),
    ).toEqual({ content: "Updated" });
    expect(
      ApiReorderProjectPromptPresetsSchema.parse({
        presetIds: ["promptPreset-1", "promptPreset-2"],
      }),
    ).toEqual({ presetIds: ["promptPreset-1", "promptPreset-2"] });
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

  it("accepts only finished terminal Git jobs as runner results", () => {
    const now = nowIso();
    const job = {
      id: "git-job-1",
      projectId: "project-1",
      contextKind: "project" as const,
      operation: "stage",
      createdAt: now,
    };

    expect(
      RunnerEventSchema.safeParse({
        type: "gitJobResult",
        job: { ...job, status: "running", startedAt: now },
      }).success,
    ).toBe(false);
    expect(
      RunnerEventSchema.safeParse({
        type: "gitJobResult",
        job: { ...job, status: "succeeded" },
      }).success,
    ).toBe(false);
    expect(
      RunnerEventSchema.parse({
        type: "gitJobResult",
        job: { ...job, status: "succeeded", finishedAt: now },
      }),
    ).toMatchObject({ job: { status: "succeeded", finishedAt: now } });
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
        groups: [
          {
            id: "changes",
            changes: [
              {
                path: "src/App.tsx",
                status: "modified",
                staged: false,
              },
            ],
          },
          {
            id: "untracked",
            changes: [
              {
                path: "scratch.txt",
                status: "untracked",
                staged: false,
              },
            ],
          },
          {
            id: "conflicts",
            changes: [
              {
                path: "conflicted.txt",
                status: "conflicted",
                staged: false,
              },
            ],
          },
          {
            id: "ignored",
            changes: [
              {
                path: "cache.tmp",
                status: "ignored",
                staged: false,
              },
            ],
          },
          {
            id: "submodules",
            changes: [
              {
                path: "vendor/lib",
                status: "submodule",
                staged: false,
              },
            ],
          },
        ],
      },
    });

    expect(event).toMatchObject({
      type: "gitStatusResult",
      result: {
        kind: "repository",
        requestId: "git-status-1",
        clean: true,
        groups: [
          { id: "unstaged", changes: [{ path: "src/App.tsx" }] },
          { id: "unstaged", changes: [{ path: "scratch.txt" }] },
          { id: "unstaged", changes: [{ path: "conflicted.txt" }] },
          { id: "unstaged", changes: [{ path: "cache.tmp" }] },
          { id: "unstaged", changes: [{ path: "vendor/lib" }] },
        ],
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
      cwd: "/workspace/project",
      patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    });
    expect(command.type).toBe("applyPatch");
    if (command.type === "applyPatch") {
      expect(command.strip).toBe(1);
      expect(command.cwd).toBe("/workspace/project");
    }

    expect(
      RunnerCommandSchema.parse({
        type: "resolveUserInput",
        sessionId: "s1",
        inputRequestId: "input-1",
        content: "continue",
      }),
    ).toMatchObject({ inputRequestId: "input-1" });
    expect(
      RunnerEventSchema.parse({
        type: "agentActivity",
        sessionId: "s1",
        agent: "codex",
        kind: "status",
        label: "Need input",
        inputRequestId: "input-1",
      }),
    ).toMatchObject({ inputRequestId: "input-1" });

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
        deliverInput: {
          deliveryId: "delivery-1",
          inputRequestId: "input-1",
          content: "continue",
        },
      }),
    ).toMatchObject({
      type: "checkSessionStatus",
      requestId: "check-1",
      sessionId: "s1",
      deliverInput: {
        deliveryId: "delivery-1",
        inputRequestId: "input-1",
        content: "continue",
      },
    });

    expect(
      RunnerEventSchema.parse({
        type: "sessionStatusCheckResult",
        result: {
          requestId: "check-1",
          sessionId: "s1",
          active: false,
          inputReceipt: {
            deliveryId: "delivery-1",
            ownership: "not_owned",
          },
        },
      }),
    ).toMatchObject({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "check-1",
        sessionId: "s1",
        active: false,
        inputReceipt: {
          deliveryId: "delivery-1",
          ownership: "not_owned",
        },
      },
    });

    expect(
      RunnerCommandSchema.parse({
        type: "checkSessionStatus",
        requestId: "legacy-check",
        sessionId: "s1",
      }),
    ).not.toHaveProperty("deliverInput");
    expect(
      SessionStatusCheckResultSchema.parse({
        requestId: "legacy-check",
        sessionId: "s1",
        active: true,
      }),
    ).not.toHaveProperty("inputDelivered");
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
