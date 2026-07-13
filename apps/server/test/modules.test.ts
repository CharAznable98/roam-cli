import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import type {
  RunnerCommand,
  RunnerRegistration,
  ServerEvent,
  Session,
  SessionStatus,
} from "@roamcli/shared/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionHub } from "../src/infra/connection-hub.js";
import {
  ArtifactStorage,
  CreateArtifactRequestSchema,
} from "../src/infra/local-artifact-storage.js";
import {
  RunnerRpcClient,
  RunnerRpcError,
} from "../src/infra/runner-rpc-client.js";
import { ServerStore } from "../src/infra/sqlite-store.js";
import { ApprovalService } from "../src/modules/approvals/approval-service.js";
import { GitJobRunner } from "../src/modules/git/git-job-runner.js";
import { GitService } from "../src/modules/git/git-service.js";
import { RunnerEventService } from "../src/modules/runners/runner-event-service.js";
import { ArtifactService } from "../src/modules/artifacts/artifact-service.js";
import { SessionCommandService } from "../src/modules/sessions/session-command-service.js";
import { WorkspaceService } from "../src/modules/workspace/workspace-service.js";

describe("RunnerRpcClient", () => {
  let dataDir: string;
  let store: ServerStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roamcli-rpc-test-"));
    store = new ServerStore(dataDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects offline runners and times out unanswered requests", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);

    await expect(
      rpc.requestRunner(
        "missing-runner",
        {
          type: "readFileTree",
          requestId: "request-offline",
          sessionId: "session-1",
          path: ".",
          depth: 1,
        },
        10,
      ),
    ).rejects.toMatchObject({ code: "runner_offline" });

    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const pending = rpc.requestRunner(
      "runner-1",
      {
        type: "readFileTree",
        requestId: "request-timeout",
        sessionId: "session-1",
        path: ".",
        depth: 1,
      },
      5,
    );

    expect(runnerMessages[0]).toMatchObject({
      type: "readFileTree",
      requestId: "request-timeout",
    });
    await expect(pending).rejects.toMatchObject({ code: "runner_timeout" });
  });

  it("rejects pending runner requests when the hub marks a runner offline", async () => {
    let rpc: RunnerRpcClient;
    const hub = new ConnectionHub(store, {
      onRunnerDisconnected: (runnerId) => {
        rpc.rejectPendingForRunner(
          runnerId,
          new RunnerRpcError("runner disconnected", "runner_offline"),
        );
      },
    });
    rpc = new RunnerRpcClient(hub);
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = rpc.requestRunner(
      "runner-1",
      {
        type: "readFileTree",
        requestId: "request-pending",
        sessionId: "session-1",
        path: ".",
        depth: 1,
      },
      1000,
    );
    expect(runnerMessages).toHaveLength(1);

    hub.markRunnerOffline("runner-1");

    await expect(pending).rejects.toMatchObject({ code: "runner_offline" });
  });
});

describe("SessionCommandService", () => {
  let dataDir: string;
  let store: ServerStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roamcli-session-test-"));
    store = new ServerStore(dataDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("sorts pinned projects and sessions before ordinary recency order", () => {
    store.createProject({
      ...projectRecord(),
      id: "project-1",
      createdAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-06-05T00:00:00.000Z",
      lastActiveAt: "2026-06-05T00:00:00.000Z",
    });
    store.createProject({
      ...projectRecord(),
      id: "project-2",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
      lastActiveAt: "2026-06-06T00:00:00.000Z",
    });
    store.updateProject("project-1", {
      pinnedAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });

    expect(store.listProjects().map((project) => project.id)).toEqual([
      "project-1",
      "project-2",
    ]);

    store.createSession({
      ...sessionRecord(),
      id: "session-1",
      projectId: "project-1",
      createdAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-06-05T00:00:00.000Z",
    });
    store.createSession({
      ...sessionRecord(),
      id: "session-2",
      projectId: "project-1",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    });
    store.updateSession("session-1", {
      pinnedAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });

    expect(store.listSessions().map((session) => session.id)).toEqual([
      "session-1",
      "session-2",
    ]);
  });

  it("limits pinned sessions to three per project", () => {
    const hub = new ConnectionHub(store);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      new RunnerRpcClient(hub),
      100,
    );
    store.createProject(projectRecord());
    for (let index = 1; index <= 4; index += 1) {
      store.createSession({
        ...sessionRecord(),
        id: `session-${index}`,
        title: `Session ${index}`,
      });
    }

    expect(service.updateSession("session-1", { pinned: true }).ok).toBe(true);
    expect(service.updateSession("session-2", { pinned: true }).ok).toBe(true);
    expect(service.updateSession("session-3", { pinned: true }).ok).toBe(true);

    expect(service.updateSession("session-4", { pinned: true })).toMatchObject({
      ok: false,
      error: "session_pin_limit_exceeded",
    });

    expect(service.updateSession("session-2", { pinned: false }).ok).toBe(true);
    expect(service.updateSession("session-4", { pinned: true }).ok).toBe(true);
  });

  it("rejects pinning archived sessions", () => {
    const hub = new ConnectionHub(store);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      new RunnerRpcClient(hub),
      100,
    );
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    store.createSession({
      ...sessionRecord(),
      id: "session-2",
      title: "Project archived session",
    });

    store.archiveSession("session-1", "2026-06-05T00:00:00.000Z");
    expect(service.updateSession("session-1", { pinned: true })).toMatchObject({
      ok: false,
      error: "session_pin_limit_exceeded",
    });

    store.archiveProject("project-1", "2026-06-05T00:00:01.000Z");
    expect(service.updateSession("session-2", { pinned: true })).toMatchObject({
      ok: false,
      error: "session_pin_limit_exceeded",
    });
    expect(service.updateSession("session-2", { pinned: false }).ok).toBe(true);
  });

  it("guards runner availability and agent support before starting sessions", async () => {
    const hub = new ConnectionHub(store);
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(
      store,
      hub,
      approvals,
      new RunnerRpcClient(hub),
      100,
    );
    store.createProject(projectRecord());

    const offline = await service.createSession({
      projectId: "project-1",
      agent: "codex",
      prompt: "hello",
    });
    expect(offline).toMatchObject({ ok: false, error: "runner_offline" });

    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const unsupported = await service.createSession({
      projectId: "project-1",
      agent: "gemini",
      prompt: "hello",
    });
    expect(unsupported).toMatchObject({
      ok: false,
      error: "unsupported_agent",
    });

    const created = await service.createSession({
      projectId: "project-1",
      agent: "codex",
      prompt: "hello",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("session was not created");
    }
    expect(store.listMessages(created.value.session.id)).toMatchObject([
      { role: "user", content: "hello" },
    ]);
    expect(runnerMessages.at(-1)).toMatchObject({
      type: "startSession",
      prompt: "hello",
      session: { id: created.value.session.id },
    });
  });

  it("applies runner agent runtime defaults only when the create request omits runtime config", async () => {
    const hub = new ConnectionHub(store);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      new RunnerRpcClient(hub),
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const setting = store.setRunnerAgentRuntimeConfigSetting(
      "runner-1",
      "codex",
      {
        model: "gpt-5.4-codex",
        reasoningEffort: "high",
        fastMode: true,
      },
      "2026-07-03T00:00:00.000Z",
    );

    const fromSetting = await service.createSession({
      projectId: "project-1",
      agent: "codex",
      prompt: "use setting",
    });

    expect(fromSetting.ok).toBe(true);
    if (!fromSetting.ok) {
      throw new Error("session with default runtime config was not created");
    }
    expect(fromSetting.value.session.agentRuntimeConfig).toEqual(
      setting?.config,
    );
    expect(runnerMessages.at(-1)).toMatchObject({
      type: "startSession",
      session: {
        id: fromSetting.value.session.id,
        agentRuntimeConfig: setting?.config,
      },
    });

    const explicitLocalDefault = await service.createSession({
      projectId: "project-1",
      agent: "codex",
      prompt: "use local default",
      agentRuntimeConfig: {},
    });

    expect(explicitLocalDefault.ok).toBe(true);
    if (!explicitLocalDefault.ok) {
      throw new Error("session with empty runtime config was not created");
    }
    expect(
      explicitLocalDefault.value.session.agentRuntimeConfig,
    ).toBeUndefined();
    expect(runnerMessages.at(-1)).toMatchObject({
      type: "startSession",
      session: {
        id: explicitLocalDefault.value.session.id,
      },
    });
    expect(runnerMessages.at(-1)).not.toMatchObject({
      session: { agentRuntimeConfig: expect.anything() },
    });
  });

  it("replays an initial durable start after the server commits before sending", async () => {
    let hub = new ConnectionHub(store);
    let rpc = new RunnerRpcClient(hub);
    let service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const durableRunner = durableRunnerRegistration();
    store.createProject(projectRecord());
    hub.registerRunner(durableRunner, fakeSocket<RunnerCommand>([]));
    const send = vi.spyOn(hub, "sendToRunner").mockReturnValueOnce(false);

    await expect(
      service.createSession({
        requestId: "initial-create-retry",
        projectId: "project-1",
        agent: "codex",
        prompt: "survive commit-before-send",
      }),
    ).resolves.toMatchObject({ ok: true, value: { queued: true } });
    send.mockRestore();
    const [pending] = store.listPendingInputDeliveries("runner-1");
    expect(pending).toMatchObject({
      kind: "start",
      message: { content: "survive commit-before-send" },
    });
    expect(store.listMessages(pending!.sessionId)).toEqual([]);

    await expect(
      service.createSession({
        requestId: "initial-create-retry",
        projectId: "project-1",
        agent: "codex",
        prompt: "survive commit-before-send",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { session: { id: pending!.sessionId } },
    });
    expect(store.listSessions()).toHaveLength(1);
    expect(store.listPendingInputDeliveries("runner-1")).toHaveLength(1);

    for (const changed of [
      { title: "Changed title" },
      { executionMode: "managed_worktree" as const },
      { gitBaseRef: "origin/changed" },
      { gitBranchName: "changed-branch" },
      { agentRuntimeConfig: { model: "changed-model" } },
    ]) {
      await expect(
        service.createSession({
          requestId: "initial-create-retry",
          projectId: "project-1",
          agent: "codex",
          prompt: "survive commit-before-send",
          ...changed,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "runner_error",
        code: "INPUT_REQUEST_CONFLICT",
      });
    }
    expect(store.listSessions()).toHaveLength(1);

    store.close();
    store = new ServerStore(dataDir);
    hub = new ConnectionHub(store);
    rpc = new RunnerRpcClient(hub);
    service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(durableRunner, fakeSocket(runnerMessages));
    const reconciliation = service.reconcilePendingInputDeliveries("runner-1");
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const start = runnerMessages[0];
    if (start?.type !== "startSession") {
      throw new Error("initial durable start was not reconciled");
    }
    expect(start.deliveryId).toBe(pending!.deliveryId);
    rpc.resolveRunnerResponse({
      requestId: start.requestId!,
      sessionId: pending!.sessionId,
      deliveryId: pending!.deliveryId,
      ownership: "owned",
    });
    await reconciliation;

    expect(store.getPendingInputDelivery(pending!.deliveryId)).toBeUndefined();
    expect(store.listMessages(pending!.sessionId)).toEqual([
      expect.objectContaining({ content: "survive commit-before-send" }),
    ]);
  });

  it("persists and clears runner agent runtime default settings", () => {
    const saved = store.setRunnerAgentRuntimeConfigSetting(
      "runner-1",
      "codex",
      { model: "gpt-5.4-codex", serviceTier: "flex" },
      "2026-07-03T00:00:00.000Z",
    );

    expect(saved).toEqual({
      runnerId: "runner-1",
      agent: "codex",
      config: { model: "gpt-5.4-codex", serviceTier: "flex" },
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    expect(store.listRunnerAgentRuntimeConfigSettings()).toEqual([saved]);
    expect(
      store.getRunnerAgentRuntimeConfigSetting("runner-1", "codex"),
    ).toEqual(saved);

    const cleared = store.setRunnerAgentRuntimeConfigSetting(
      "runner-1",
      "codex",
      {},
      "2026-07-03T00:01:00.000Z",
    );

    expect(cleared).toBeUndefined();
    expect(store.listRunnerAgentRuntimeConfigSettings()).toEqual([]);
  });

  it("rejects omitting explicit fields from a retried session request", async () => {
    const hub = new ConnectionHub(store);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      new RunnerRpcClient(hub),
      100,
    );
    store.createProject(projectRecord());
    hub.registerRunner(
      durableRunnerRegistration(),
      fakeSocket<RunnerCommand>([]),
    );
    const send = vi.spyOn(hub, "sendToRunner").mockReturnValueOnce(false);

    await expect(
      service.createSession({
        requestId: "explicit-create-fields",
        projectId: "project-1",
        agent: "codex",
        prompt: "same prompt",
        title: "Explicit title",
        agentRuntimeConfig: { model: "explicit-model" },
      }),
    ).resolves.toMatchObject({ ok: true, value: { queued: true } });
    send.mockRestore();

    await expect(
      service.createSession({
        requestId: "explicit-create-fields",
        projectId: "project-1",
        agent: "codex",
        prompt: "same prompt",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "runner_error",
      code: "INPUT_REQUEST_CONFLICT",
    });
    expect(store.listSessions()).toHaveLength(1);
  });

  it("stores attachment metadata only after the runner writes image bytes", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(store, hub, approvals, rpc, 100);
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    hub.registerRunner(imageRunnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createSession({
      projectId: "project-1",
      agent: "codex",
      prompt: "describe this image",
      attachments: [imageUpload()],
    });
    await vi.waitFor(() => {
      expect(runnerMessages[0]).toMatchObject({
        type: "writeSessionAttachments",
      });
    });
    const writeCommand = runnerMessages[0];
    if (writeCommand?.type !== "writeSessionAttachments") {
      throw new Error("attachment write command was not sent");
    }
    const runnerAttachment = runnerAttachmentRef(writeCommand.sessionId);
    rpc.resolveRunnerResponse({
      requestId: writeCommand.requestId,
      sessionId: writeCommand.sessionId,
      attachments: [runnerAttachment],
    });

    const created = await pending;

    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("session with image was not created");
    }
    expect(created.value.attachments).toHaveLength(1);
    expect(created.value.attachments[0]).not.toHaveProperty(
      "runnerStoragePath",
    );
    expect(store.listMessages(created.value.session.id)).toMatchObject([
      { role: "user", content: "describe this image" },
    ]);
    const publicAttachments = store.listMessageAttachments(
      created.value.session.id,
    );
    expect(publicAttachments).toEqual(created.value.attachments);
    expect(publicAttachments[0]).not.toHaveProperty("runnerStoragePath");
    expect(
      store.listStoredMessageAttachments(created.value.session.id)[0],
    ).toMatchObject({
      runnerStoragePath: runnerAttachment.runnerStoragePath,
    });
    expect(runnerMessages.at(-1)).toMatchObject({
      type: "startSession",
      prompt: "describe this image",
      attachments: [runnerAttachment],
    });
  });

  it("coalesces concurrent attachment session creates with the same requestId", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    hub.registerRunner(imageRunnerRegistration(), fakeSocket(runnerMessages));
    const input = {
      requestId: "concurrent-create-with-image",
      projectId: "project-1",
      agent: "codex" as const,
      prompt: "describe this image once",
      attachments: [imageUpload()],
    };

    const first = service.createSession(input);
    const second = service.createSession(input);
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const writeCommand = runnerMessages[0];
    if (writeCommand?.type !== "writeSessionAttachments") {
      throw new Error("attachment write command was not sent");
    }
    const runnerAttachment = runnerAttachmentRef(writeCommand.sessionId);
    rpc.resolveRunnerResponse({
      requestId: writeCommand.requestId,
      sessionId: writeCommand.sessionId,
      attachments: [runnerAttachment],
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ ok: true });
    expect(secondResult).toEqual(firstResult);
    if (!firstResult.ok || !secondResult.ok) {
      throw new Error("coalesced session creates did not succeed");
    }
    expect(secondResult.value.session.id).toBe(firstResult.value.session.id);
    expect(store.listSessions()).toHaveLength(1);
    expect(store.listMessages(firstResult.value.session.id)).toHaveLength(1);
    expect(
      store.listMessageAttachments(firstResult.value.session.id),
    ).toHaveLength(1);
    expect(runnerMessages).toHaveLength(2);
    expect(runnerMessages.map((message) => message.type)).toEqual([
      "writeSessionAttachments",
      "startSession",
    ]);
  });

  it("does not persist sessions or messages when runner image writes fail", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(store, hub, approvals, rpc, 100);
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    hub.registerRunner(imageRunnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createSession({
      projectId: "project-1",
      agent: "codex",
      prompt: "describe this image",
      attachments: [imageUpload()],
    });
    await vi.waitFor(() => {
      expect(runnerMessages[0]).toMatchObject({
        type: "writeSessionAttachments",
      });
    });
    const writeCommand = runnerMessages[0];
    if (writeCommand?.type !== "writeSessionAttachments") {
      throw new Error("attachment write command was not sent");
    }
    rpc.rejectRunnerResponse(
      writeCommand.requestId,
      new RunnerRpcError("disk full", "runner_error", "ATTACHMENT_ERROR"),
    );

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "attachment_write_failed",
    });
    expect(store.listSessions()).toEqual([]);
    expect(store.listMessages(writeCommand.sessionId)).toEqual([]);
    expect(store.listMessageAttachments(writeCommand.sessionId)).toEqual([]);
    expect(runnerMessages).toHaveLength(1);
  });

  it("enforces the runner-advertised total image budget before writing", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    const runner = imageRunnerRegistration();
    hub.registerRunner(
      {
        ...runner,
        capabilities: runner.capabilities.map((capability) => ({
          ...capability,
          maxImagesPerTurn: 2,
          maxImageBytes: 4,
          maxTotalImageBytes: 3,
        })),
      },
      fakeSocket(runnerMessages),
    );
    store.createProject(projectRecord());

    await expect(
      service.createSession({
        projectId: "project-1",
        agent: "codex",
        prompt: "too much in aggregate",
        attachments: [
          {
            name: "one.png",
            mimeType: "image/png",
            size: 2,
            contentBase64: Buffer.from("aa").toString("base64"),
          },
          {
            name: "two.png",
            mimeType: "image/png",
            size: 2,
            contentBase64: Buffer.from("bb").toString("base64"),
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, error: "image_too_large" });
    expect(runnerMessages).toEqual([]);
  });

  it.each(["pending", "running", "waiting_approval", "waiting_input"] as const)(
    "rejects active Claude Code messages before persistence when %s",
    async (status) => {
      const hub = new ConnectionHub(store);
      const approvals = new ApprovalService(store, hub);
      const service = new SessionCommandService(
        store,
        hub,
        approvals,
        new RunnerRpcClient(hub),
        100,
      );
      const runnerMessages: RunnerCommand[] = [];
      store.createProject(projectRecord());
      hub.registerRunner(
        claudeRunnerRegistration(),
        fakeSocket(runnerMessages),
      );
      store.createSession({
        ...sessionRecord(),
        agent: "claude-code",
        status,
      });

      const result = await service.createUserMessage("session-1", {
        content: "follow up",
      });

      expect(result).toMatchObject({
        ok: false,
        error: "session_turn_active",
      });
      expect(store.listMessages("session-1")).toEqual([]);
      expect(runnerMessages).toEqual([]);
    },
  );

  it("persists a waiting-input answer only after the matching runner receipt", async () => {
    const hub = new ConnectionHub(store);
    const approvals = new ApprovalService(store, hub);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(store, hub, approvals, rpc, 100);
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    store.createSession({
      ...sessionRecord(),
      status: "waiting_input",
    });
    new RunnerEventService(store, hub, rpc).handle({
      type: "agentActivity",
      sessionId: "session-1",
      agent: "codex",
      kind: "status",
      label: "Need input",
      inputRequestId: "input-request-1",
    });

    const pending = service.createUserMessage("session-1", {
      content: "continue",
    });

    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    expect(store.listMessages("session-1")).toEqual([]);
    expect(store.getPendingUserInputRequest("session-1")).toBe(
      "input-request-1",
    );
    const command = runnerMessages[0];
    expect(command).toMatchObject({
      type: "checkSessionStatus",
      sessionId: "session-1",
      deliverInput: {
        deliveryId: expect.any(String),
        inputRequestId: "input-request-1",
        content: "continue",
      },
    });
    if (command?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: true,
      inputReceipt: {
        deliveryId: command.deliverInput!.deliveryId!,
        ownership: "owned",
      },
    });

    const result = await pending;

    expect(result).toMatchObject({
      ok: true,
      value: { message: expect.objectContaining({ content: "continue" }) },
    });
    expect(store.listMessages("session-1")).toHaveLength(1);
    expect(store.getPendingUserInputRequest("session-1")).toBeUndefined();
  });

  it("retries a lost input receipt with the same delivery ID without persisting early", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      200,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      content: "continue exactly once",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(2));
    expect(store.listMessages("session-1")).toEqual([]);
    const [first, retry] = runnerMessages;
    if (
      first?.type !== "checkSessionStatus" ||
      retry?.type !== "checkSessionStatus"
    ) {
      throw new Error("stable input retry was not sent");
    }
    expect(retry.requestId).not.toBe(first.requestId);
    expect(retry.deliverInput?.deliveryId).toBe(first.deliverInput?.deliveryId);
    rpc.resolveRunnerResponse({
      requestId: retry.requestId,
      sessionId: "session-1",
      active: true,
      inputReceipt: {
        deliveryId: retry.deliverInput!.deliveryId!,
        ownership: "owned",
      },
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(store.listMessages("session-1")).toEqual([
      expect.objectContaining({ content: "continue exactly once" }),
    ]);
  });

  it("coalesces concurrent retries with the same client request ID", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const input = {
      requestId: "same-logical-request",
      content: "deliver only once",
    };
    const first = service.createUserMessage("session-1", input);
    const concurrentRetry = service.createUserMessage("session-1", input);
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: true,
      inputReceipt: {
        deliveryId: command.deliverInput!.deliveryId!,
        ownership: "owned",
      },
    });

    await expect(Promise.all([first, concurrentRetry])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(runnerMessages).toHaveLength(1);
    expect(store.listMessages("session-1")).toHaveLength(1);
  });

  it("coalesces same-request retry and reconcile through one legacy fallback delivery", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      10,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const input = {
      requestId: "legacy-fallback-once",
      content: "deliver one legacy fallback",
    };

    await expect(
      service.createUserMessage("session-1", input),
    ).resolves.toMatchObject({ ok: true, value: { queued: true } });
    const checksBeforeRetry = runnerMessages.filter(
      (command) => command.type === "checkSessionStatus",
    ).length;
    const finalize = vi.spyOn(store, "finalizePendingInputDelivery");

    const retry = service.createUserMessage("session-1", input);
    const reconciliation = service.reconcilePendingInputDeliveries("runner-1");
    await vi.waitFor(() =>
      expect(
        runnerMessages.filter(
          (command) => command.type === "checkSessionStatus",
        ),
      ).toHaveLength(checksBeforeRetry + 1),
    );
    const receiptCheck = runnerMessages.at(-1);
    if (receiptCheck?.type !== "checkSessionStatus") {
      throw new Error("legacy fallback receipt was not checked");
    }
    rpc.resolveRunnerResponse({
      requestId: receiptCheck.requestId,
      sessionId: "session-1",
      active: true,
    });

    await expect(retry).resolves.toMatchObject({ ok: true });
    await reconciliation;
    expect(
      runnerMessages.filter((command) => command.type === "deliverInput"),
    ).toEqual([
      {
        type: "deliverInput",
        sessionId: "session-1",
        content: "deliver one legacy fallback",
      },
    ]);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(store.listMessages("session-1")).toEqual([
      expect.objectContaining({ content: "deliver one legacy fallback" }),
    ]);
    expect(store.listPendingInputDeliveries("runner-1")).toEqual([]);
  });

  it("returns queued for a malformed receipt while the durable intent remains", async () => {
    const hub = new ConnectionHub(store);
    const broadcast = vi.spyOn(hub, "broadcast");
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const first = service.createUserMessage("session-1", {
      requestId: "malformed-receipt",
      content: "keep the durable intent",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const firstCommand = runnerMessages[0];
    if (firstCommand?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    const deliveryId = firstCommand.deliverInput!.deliveryId!;
    rpc.resolveRunnerResponse({
      requestId: firstCommand.requestId,
      sessionId: "session-1",
      active: true,
      inputReceipt: { deliveryId: "wrong-delivery", ownership: "owned" },
    });

    await expect(first).resolves.toMatchObject({
      ok: true,
      value: { queued: true },
    });
    expect(store.getPendingInputDelivery(deliveryId)).toBeDefined();

    const retry = service.createUserMessage("session-1", {
      requestId: "malformed-receipt",
      content: "keep the durable intent",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(2));
    const retryCommand = runnerMessages[1];
    if (retryCommand?.type !== "checkSessionStatus") {
      throw new Error("stable input retry was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: retryCommand.requestId,
      sessionId: "session-1",
      active: true,
      inputReceipt: { deliveryId, ownership: "not_owned" },
    });

    await expect(retry).resolves.toMatchObject({
      ok: false,
      error: "runner_error",
      code: "AGENT_INPUT_ERROR",
    });
    expect(store.getPendingInputDelivery(deliveryId)).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith({
      type: "error",
      sessionId: "session-1",
      messageId: deliveryId,
      message: expect.any(String),
      code: "INPUT_NOT_OWNED",
    });
  });

  it("rejects changed attachments when retrying a finalized client request ID", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    hub.registerRunner(imageRunnerRegistration(), fakeSocket(runnerMessages));

    const first = service.createUserMessage("session-1", {
      requestId: "attachment-idempotency",
      content: "same prompt",
      attachments: [imageUpload()],
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const writeCommand = runnerMessages[0];
    if (writeCommand?.type !== "writeSessionAttachments") {
      throw new Error("attachment write command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: writeCommand.requestId,
      sessionId: "session-1",
      attachments: [runnerAttachmentRef("session-1")],
    });

    await expect(first).resolves.toMatchObject({ ok: true });
    expect(runnerMessages).toHaveLength(2);
    expect(runnerMessages[1]).toMatchObject({ type: "startSession" });

    await expect(
      service.createUserMessage("session-1", {
        requestId: "attachment-idempotency",
        content: "same prompt",
        attachments: [imageUpload()],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(runnerMessages).toHaveLength(2);

    await expect(
      service.createUserMessage("session-1", {
        requestId: "attachment-idempotency",
        content: "same prompt",
        attachments: [{ ...imageUpload(), name: "changed.png" }],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "runner_error",
      code: "INPUT_REQUEST_CONFLICT",
    });
    expect(runnerMessages).toHaveLength(2);
    expect(store.listMessages("session-1")).toHaveLength(1);
    expect(store.listMessageAttachments("session-1")).toHaveLength(1);
  });

  it("reconciles an owned input after a server crash using the same delivery ID", async () => {
    let hub = new ConnectionHub(store);
    let rpc = new RunnerRpcClient(hub);
    let service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    let runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    vi.spyOn(store, "finalizePendingInputDelivery").mockImplementationOnce(
      () => {
        throw new Error("simulated crash after owned receipt");
      },
    );

    const firstAttempt = service.createUserMessage("session-1", {
      requestId: "client-stable-input-1",
      content: "survive the crash",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const firstCommand = runnerMessages[0];
    if (firstCommand?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    const deliveryId = firstCommand.deliverInput!.deliveryId!;
    rpc.resolveRunnerResponse({
      requestId: firstCommand.requestId,
      sessionId: "session-1",
      active: true,
      inputReceipt: { deliveryId, ownership: "owned" },
    });
    await expect(firstAttempt).resolves.toMatchObject({
      ok: true,
      value: { queued: true },
    });
    expect(store.listMessages("session-1")).toEqual([]);
    expect(store.getPendingInputDelivery(deliveryId)).toBeDefined();

    store.close();
    store = new ServerStore(dataDir);
    hub = new ConnectionHub(store);
    rpc = new RunnerRpcClient(hub);
    service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    runnerMessages = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const reconciliation = service.reconcilePendingInputDeliveries("runner-1");
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const retryCommand = runnerMessages[0];
    if (retryCommand?.type !== "checkSessionStatus") {
      throw new Error("pending input was not reconciled");
    }
    expect(retryCommand.deliverInput?.deliveryId).toBe(deliveryId);
    rpc.resolveRunnerResponse({
      requestId: retryCommand.requestId,
      sessionId: "session-1",
      active: true,
      inputReceipt: { deliveryId, ownership: "owned" },
    });
    await reconciliation;

    expect(store.getPendingInputDelivery(deliveryId)).toBeUndefined();
    expect(store.listMessages("session-1")).toEqual([
      expect.objectContaining({ id: deliveryId, content: "survive the crash" }),
    ]);
    await expect(
      service.createUserMessage("session-1", {
        requestId: "client-stable-input-1",
        content: "survive the crash",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { message: { id: deliveryId } },
    });
    expect(runnerMessages).toHaveLength(1);
    expect(store.listMessages("session-1")).toHaveLength(1);
  });

  it("uses the durable waiting-input intent with an old runner fallback", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "waiting_input" });
    store.setPendingUserInputRequest("session-1", "legacy-input-request");
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      requestId: "legacy-client-request",
      content: "legacy answer",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("status command was not sent");
    }
    expect(
      store.getPendingInputDelivery(command.deliverInput!.deliveryId!),
    ).toBeDefined();
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: true,
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(runnerMessages[1]).toEqual({
      type: "resolveUserInput",
      sessionId: "session-1",
      inputRequestId: "legacy-input-request",
      content: "legacy answer",
    });
    expect(
      store.getPendingInputDelivery(command.deliverInput!.deliveryId!),
    ).toBeUndefined();
    expect(store.getPendingUserInputRequest("session-1")).toBeUndefined();
    expect(store.listMessages("session-1")).toHaveLength(1);
  });

  it("waits for a durable start receipt and reconciles the same start after a crash", async () => {
    let hub = new ConnectionHub(store);
    let rpc = new RunnerRpcClient(hub);
    let service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    let runnerMessages: RunnerCommand[] = [];
    const durableRunner = {
      ...runnerRegistration(),
      capabilities: runnerRegistration().capabilities.map((capability) => ({
        ...capability,
        supportsDurableSessionStart: true,
      })),
    };
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      agentThreadId: "thread-before-crash",
    });
    hub.registerRunner(durableRunner, fakeSocket(runnerMessages));
    vi.spyOn(store, "finalizePendingInputDelivery").mockImplementationOnce(
      () => {
        throw new Error("simulated crash after durable start receipt");
      },
    );

    const firstAttempt = service.createUserMessage("session-1", {
      requestId: "durable-start-request",
      content: "resume exactly once",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const firstStart = runnerMessages[0];
    if (firstStart?.type !== "startSession") {
      throw new Error("durable start command was not sent");
    }
    expect(firstStart).toMatchObject({
      deliveryId: expect.any(String),
      requestId: expect.any(String),
      resumeThreadId: "thread-before-crash",
    });
    expect(store.listMessages("session-1")).toEqual([]);
    rpc.resolveRunnerResponse({
      requestId: firstStart.requestId!,
      sessionId: "session-1",
      deliveryId: firstStart.deliveryId!,
      ownership: "owned",
    });
    await expect(firstAttempt).resolves.toMatchObject({
      ok: true,
      value: { queued: true },
    });
    expect(store.getPendingInputDelivery(firstStart.deliveryId!)).toBeDefined();

    store.close();
    store = new ServerStore(dataDir);
    hub = new ConnectionHub(store);
    rpc = new RunnerRpcClient(hub);
    service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    runnerMessages = [];
    hub.registerRunner(durableRunner, fakeSocket(runnerMessages));
    const reconciliation = service.reconcilePendingInputDeliveries("runner-1");
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const retriedStart = runnerMessages[0];
    if (retriedStart?.type !== "startSession") {
      throw new Error("durable start was not reconciled");
    }
    expect(retriedStart.deliveryId).toBe(firstStart.deliveryId);
    expect(retriedStart.requestId).not.toBe(firstStart.requestId);
    rpc.resolveRunnerResponse({
      requestId: retriedStart.requestId!,
      sessionId: "session-1",
      deliveryId: retriedStart.deliveryId!,
      ownership: "owned",
    });
    await reconciliation;
    expect(store.listMessages("session-1")).toEqual([
      expect.objectContaining({ content: "resume exactly once" }),
    ]);
    expect(
      store.getPendingInputDelivery(retriedStart.deliveryId!),
    ).toBeUndefined();
  });

  it("keeps a timed-out durable start pending until an owned retry", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      10,
    );
    const runnerMessages: RunnerCommand[] = [];
    const durableRunner = durableRunnerRegistration();
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    hub.registerRunner(durableRunner, fakeSocket(runnerMessages));

    const first = await service.createUserMessage("session-1", {
      requestId: "timed-out-start",
      content: "retry after timeout",
    });
    expect(first).toMatchObject({ ok: true, value: { queued: true } });
    const firstStart = runnerMessages[0];
    if (firstStart?.type !== "startSession") {
      throw new Error("durable start command was not sent");
    }
    expect(store.getPendingInputDelivery(firstStart.deliveryId!)).toBeDefined();
    expect(store.listMessages("session-1")).toEqual([]);
    expect(store.listVisibleMessages("session-1")).toEqual([]);
    expect(store.listPendingMessageDeliveries("session-1")).toEqual([
      expect.objectContaining({ content: "retry after timeout" }),
    ]);

    await expect(
      service.createUserMessage("session-1", {
        requestId: "different-request-while-pending",
        content: "must not create a second start",
      }),
    ).resolves.toMatchObject({ ok: false, error: "session_turn_active" });
    expect(store.listPendingInputDeliveries("runner-1")).toHaveLength(1);
    expect(runnerMessages).toHaveLength(1);

    const retry = service.createUserMessage("session-1", {
      requestId: "timed-out-start",
      content: "retry after timeout",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(2));
    const retriedStart = runnerMessages[1];
    if (retriedStart?.type !== "startSession") {
      throw new Error("durable start retry was not sent");
    }
    expect(retriedStart.deliveryId).toBe(firstStart.deliveryId);
    rpc.resolveRunnerResponse({
      requestId: retriedStart.requestId!,
      sessionId: "session-1",
      deliveryId: retriedStart.deliveryId!,
      ownership: "owned",
    });

    await expect(retry).resolves.toMatchObject({ ok: true });
    expect(
      store.getPendingInputDelivery(firstStart.deliveryId!),
    ).toBeUndefined();
    expect(store.listMessages("session-1")).toHaveLength(1);
  });

  it("cancels an offline pending start before archiving and never reconciles it", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const durableRunner = durableRunnerRegistration();
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    hub.registerRunner(durableRunner, fakeSocket<RunnerCommand>([]));
    const send = vi.spyOn(hub, "sendToRunner").mockReturnValueOnce(false);

    await expect(
      service.createUserMessage("session-1", {
        requestId: "archive-before-reconnect",
        content: "must not start",
      }),
    ).resolves.toMatchObject({ ok: true });
    send.mockRestore();
    expect(store.listPendingInputDeliveries("runner-1")).toHaveLength(1);
    hub.markRunnerOffline("runner-1");

    await expect(service.deleteSession("session-1")).resolves.toMatchObject({
      ok: true,
    });
    expect(store.listPendingInputDeliveries("runner-1")).toEqual([]);
    const reconnectedMessages: RunnerCommand[] = [];
    hub.registerRunner(durableRunner, fakeSocket(reconnectedMessages));
    await service.reconcilePendingInputDeliveries("runner-1");

    expect(reconnectedMessages).toEqual([]);
    expect(store.getSession("session-1")).toMatchObject({
      status: "stopped",
      archivedAt: expect.any(String),
    });
  });

  it("deletes all 45 attachments in protocol-sized batches", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    addStoredAttachments(store, 45);
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.deleteSession("session-1");
    await vi.waitFor(() => {
      expect(
        runnerMessages.filter(
          (command) => command.type === "deleteSessionAttachments",
        ),
      ).toHaveLength(3);
    });
    const deleteBatches = runnerMessages.filter(
      (
        command,
      ): command is Extract<
        RunnerCommand,
        { type: "deleteSessionAttachments" }
      > => command.type === "deleteSessionAttachments",
    );
    expect(deleteBatches.map((batch) => batch.attachments.length)).toEqual([
      20, 20, 5,
    ]);
    for (const batch of deleteBatches) {
      rpc.resolveRunnerResponse({
        requestId: batch.requestId,
        sessionId: "session-1",
        deleted: batch.attachments.map((attachment) => attachment.id),
        failed: [],
      });
    }

    await expect(pending).resolves.toMatchObject({ ok: true });
    const stored = store.listStoredMessageAttachments("session-1");
    expect(
      stored.filter((attachment) => attachment.status === "deleted"),
    ).toHaveLength(45);
    expect(
      stored.filter((attachment) => attachment.status === "available"),
    ).toHaveLength(0);
    expect(store.getSession("session-1")?.archivedAt).toEqual(
      expect.any(String),
    );
  });

  it("converges attachment metadata after a delete response is lost and retried", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      20,
    );
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    addStoredAttachments(store, 1);
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    await expect(service.deleteSession("session-1")).resolves.toMatchObject({
      ok: true,
    });
    expect(
      store.getStoredMessageAttachment("session-1", "attachment-1"),
    ).toMatchObject({ status: "available" });

    const retry = service.deleteSession("session-1");
    await vi.waitFor(() => {
      expect(
        runnerMessages.filter(
          (command) => command.type === "deleteSessionAttachments",
        ),
      ).toHaveLength(2);
    });
    const retryCommand = runnerMessages.filter(
      (
        command,
      ): command is Extract<
        RunnerCommand,
        { type: "deleteSessionAttachments" }
      > => command.type === "deleteSessionAttachments",
    )[1];
    if (!retryCommand) {
      throw new Error("attachment delete retry was not delivered");
    }
    rpc.resolveRunnerResponse({
      requestId: retryCommand.requestId,
      sessionId: "session-1",
      deleted: ["attachment-1"],
      failed: [],
    });

    await expect(retry).resolves.toMatchObject({ ok: true });
    expect(
      store.getStoredMessageAttachment("session-1", "attachment-1"),
    ).toMatchObject({ status: "deleted" });
  });

  it("preserves attachments from partial results and undelivered batches", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    addStoredAttachments(store, 25);
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const sendToRunner = hub.sendToRunner.bind(hub);
    vi.spyOn(hub, "sendToRunner").mockImplementation((runnerId, command) =>
      command.type === "deleteSessionAttachments" &&
      command.attachments.length === 5
        ? false
        : sendToRunner(runnerId, command),
    );

    const pending = service.deleteSession("session-1");
    await vi.waitFor(() => {
      expect(
        runnerMessages.filter(
          (command) => command.type === "deleteSessionAttachments",
        ),
      ).toHaveLength(1);
    });
    const firstBatch = runnerMessages.find(
      (
        command,
      ): command is Extract<
        RunnerCommand,
        { type: "deleteSessionAttachments" }
      > => command.type === "deleteSessionAttachments",
    );
    if (!firstBatch) {
      throw new Error("attachment delete batch was not delivered");
    }
    rpc.resolveRunnerResponse({
      requestId: firstBatch.requestId,
      sessionId: "session-1",
      deleted: firstBatch.attachments
        .slice(0, 10)
        .map((attachment) => attachment.id),
      failed: firstBatch.attachments
        .slice(10)
        .map((attachment) => attachment.id),
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    const stored = store.listStoredMessageAttachments("session-1");
    expect(
      stored.filter((attachment) => attachment.status === "deleted"),
    ).toHaveLength(10);
    expect(
      stored.filter((attachment) => attachment.status === "available"),
    ).toHaveLength(15);
  });

  it("rejects a delayed attachment-backed create after its project is archived", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    store.createProject(projectRecord());
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(imageRunnerRegistration(), fakeSocket(runnerMessages));

    const creation = service.createSession({
      requestId: "archive-racing-create",
      projectId: "project-1",
      agent: "codex",
      prompt: "must not outlive project archive",
      attachments: [imageUpload()],
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const writeCommand = runnerMessages[0];
    if (writeCommand?.type !== "writeSessionAttachments") {
      throw new Error("attachment write was not delivered");
    }
    const archivedAt = new Date().toISOString();
    expect(store.archiveProject("project-1", archivedAt)?.archivedAt).toBe(
      archivedAt,
    );
    const attachment = runnerAttachmentRef(writeCommand.sessionId);
    rpc.resolveRunnerResponse({
      requestId: writeCommand.requestId,
      sessionId: writeCommand.sessionId,
      attachments: [attachment],
    });
    await vi.waitFor(() => {
      expect(
        runnerMessages.filter(
          (command) => command.type === "deleteSessionAttachments",
        ),
      ).toHaveLength(1);
    });
    const deleteCommand = runnerMessages.find(
      (
        command,
      ): command is Extract<
        RunnerCommand,
        { type: "deleteSessionAttachments" }
      > => command.type === "deleteSessionAttachments",
    );
    if (!deleteCommand) {
      throw new Error("orphan attachment cleanup was not delivered");
    }
    expect(store.listAttachmentCleanupJobs("project-1")).toEqual([
      expect.objectContaining({
        sessionId: writeCommand.sessionId,
        attachmentId: attachment.id,
      }),
    ]);
    expect(deleteCommand.attachments).toEqual([
      {
        id: attachment.id,
        runnerStoragePath: attachment.runnerStoragePath,
      },
    ]);
    rpc.resolveRunnerResponse({
      requestId: deleteCommand.requestId,
      sessionId: writeCommand.sessionId,
      deleted: [attachment.id],
      failed: [],
    });

    await expect(creation).resolves.toMatchObject({
      ok: false,
      error: "project_not_found",
    });
    expect(store.getSession(writeCommand.sessionId)).toBeUndefined();
    expect(store.listAttachmentCleanupJobs("project-1")).toEqual([]);
    expect(
      runnerMessages.some((command) => command.type === "startSession"),
    ).toBe(false);
  });

  it("compensates a concurrently archived pending create without leaving a retry ghost", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    store.createProject(projectRecord());
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(imageRunnerRegistration(), fakeSocket(runnerMessages));
    const createPending = store.createSessionWithPendingStart.bind(store);
    const archivedAt = new Date().toISOString();
    vi.spyOn(store, "createSessionWithPendingStart").mockImplementation(
      (...args) => {
        const prepared = createPending(...args);
        store.archiveProject("project-1", archivedAt);
        return prepared;
      },
    );

    const creation = service.createSession({
      requestId: "archive-after-pending-insert",
      projectId: "project-1",
      agent: "codex",
      prompt: "archive immediately after insert",
      attachments: [imageUpload()],
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const writeCommand = runnerMessages[0];
    if (writeCommand?.type !== "writeSessionAttachments") {
      throw new Error("attachment write was not delivered");
    }
    const attachment = runnerAttachmentRef(writeCommand.sessionId);
    rpc.resolveRunnerResponse({
      requestId: writeCommand.requestId,
      sessionId: writeCommand.sessionId,
      attachments: [attachment],
    });

    await vi.waitFor(() => expect(runnerMessages).toHaveLength(2));
    const deleteCommand = runnerMessages[1];
    if (deleteCommand?.type !== "deleteSessionAttachments") {
      throw new Error("compensating attachment cleanup was not delivered");
    }
    expect(store.listAttachmentCleanupJobs("project-1")).toEqual([
      expect.objectContaining({
        sessionId: writeCommand.sessionId,
        attachmentId: attachment.id,
      }),
    ]);
    rpc.resolveRunnerResponse({
      requestId: deleteCommand.requestId,
      sessionId: writeCommand.sessionId,
      deleted: [attachment.id],
      failed: [],
    });
    await expect(creation).resolves.toMatchObject({
      ok: false,
      error: "project_not_found",
    });
    expect(store.getSession(writeCommand.sessionId)).toBeUndefined();
    expect(store.listMessages(writeCommand.sessionId)).toEqual([]);
    expect(store.listStoredMessageAttachments(writeCommand.sessionId)).toEqual(
      [],
    );
    expect(store.listAttachmentCleanupJobs("project-1")).toEqual([]);
    expect(store.listPendingInputDeliveries("runner-1")).toEqual([]);
    expect(
      runnerMessages.some((command) => command.type === "startSession"),
    ).toBe(false);

    await expect(
      service.createSession({
        requestId: "archive-after-pending-insert",
        projectId: "project-1",
        agent: "codex",
        prompt: "archive immediately after insert",
        attachments: [imageUpload()],
      }),
    ).resolves.toMatchObject({ ok: false, error: "project_not_found" });
    expect(runnerMessages).toHaveLength(2);

    store.restoreProject("project-1", new Date().toISOString());
    expect(store.listSessions()).toEqual([]);
    expect(store.listMessages(writeCommand.sessionId)).toEqual([]);
  });

  it("moves archived pending input attachments to a retryable cleanup outbox without materializing messages", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const createdAt = "2026-06-05T00:00:00.000Z";
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "running" });
    store.putPendingInputDelivery({
      deliveryId: "archived-pending-input",
      kind: "input",
      runnerId: "runner-1",
      sessionId: "session-1",
      message: pendingUserMessage(
        "archived-pending-input",
        "must never materialize",
        createdAt,
      ),
      attachments: [storedAttachment("archived-pending-input", createdAt)],
      createdAt,
    });
    const archivedAt = new Date().toISOString();

    store.archiveProject("project-1", archivedAt);
    expect(store.listPendingInputDeliveries("runner-1")).toEqual([]);
    expect(store.listMessages("session-1")).toEqual([]);
    expect(store.listMessageAttachments("session-1")).toEqual([]);
    expect(store.listAttachmentCleanupJobs("project-1")).toEqual([
      expect.objectContaining({
        projectId: "project-1",
        sessionId: "session-1",
        runnerId: "runner-1",
        attachmentId: "attachment-archived-pending-input",
      }),
    ]);

    await service.handleProjectArchived("project-1", archivedAt);
    expect(store.listAttachmentCleanupJobs("project-1")).toHaveLength(1);

    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const retry = service.handleProjectArchived("project-1", archivedAt);
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const deleteCommand = runnerMessages[0];
    if (deleteCommand?.type !== "deleteSessionAttachments") {
      throw new Error("cleanup outbox retry was not delivered");
    }
    rpc.resolveRunnerResponse({
      requestId: deleteCommand.requestId,
      sessionId: "session-1",
      deleted: ["attachment-archived-pending-input"],
      failed: [],
    });
    await retry;
    expect(store.listAttachmentCleanupJobs("project-1")).toEqual([]);

    store.restoreProject("project-1", new Date().toISOString());
    expect(store.listMessages("session-1")).toEqual([]);
    expect(store.listMessageAttachments("session-1")).toEqual([]);
    expect(store.listPendingInputDeliveries("runner-1")).toEqual([]);
  });

  it("drains newly added cleanup jobs after an in-flight cleanup makes no progress", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const enqueueArchivedCleanup = (suffix: string) => {
      const projectId = `project-${suffix}`;
      const sessionId = `session-${suffix}`;
      const deliveryId = `delivery-${suffix}`;
      const createdAt = `2026-06-05T00:00:0${suffix}.000Z`;
      store.createProject({
        ...projectRecord(),
        id: projectId,
      });
      store.createSession({
        ...sessionRecord(),
        id: sessionId,
        projectId,
        status: "running",
      });
      store.putPendingInputDelivery({
        deliveryId,
        kind: "input",
        runnerId: "runner-1",
        sessionId,
        message: {
          ...pendingUserMessage(deliveryId, `cleanup ${suffix}`, createdAt),
          sessionId,
        },
        attachments: [
          {
            ...storedAttachment(deliveryId, createdAt),
            id: `attachment-${suffix}`,
            sessionId,
            messageId: deliveryId,
            runnerStoragePath: `attachments/${sessionId}/attachment-${suffix}/screen.png`,
          },
        ],
        createdAt,
      });
      store.archiveProject(projectId, createdAt);
      return { projectId, sessionId, attachmentId: `attachment-${suffix}` };
    };

    const first = enqueueArchivedCleanup("1");
    const firstReconciliation =
      service.reconcileAttachmentCleanupJobs("runner-1");
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));

    const second = enqueueArchivedCleanup("2");
    const joinedReconciliation =
      service.reconcileAttachmentCleanupJobs("runner-1");
    const firstCommand = runnerMessages[0];
    if (firstCommand?.type !== "deleteSessionAttachments") {
      throw new Error("first cleanup command was not delivered");
    }
    rpc.resolveRunnerResponse({
      requestId: firstCommand.requestId,
      sessionId: first.sessionId,
      deleted: [],
      failed: [first.attachmentId],
    });

    await vi.waitFor(() => expect(runnerMessages).toHaveLength(3));
    const retryCommand = runnerMessages.find(
      (command, index) =>
        index > 0 &&
        command.type === "deleteSessionAttachments" &&
        command.sessionId === first.sessionId,
    );
    const secondCommand = runnerMessages.find(
      (command, index) =>
        index > 0 &&
        command.type === "deleteSessionAttachments" &&
        command.sessionId === second.sessionId,
    );
    if (
      retryCommand?.type !== "deleteSessionAttachments" ||
      secondCommand?.type !== "deleteSessionAttachments"
    ) {
      throw new Error("second cleanup command was not delivered");
    }
    expect(secondCommand).toMatchObject({
      sessionId: second.sessionId,
      attachments: [expect.objectContaining({ id: second.attachmentId })],
    });
    rpc.resolveRunnerResponse({
      requestId: retryCommand.requestId,
      sessionId: first.sessionId,
      deleted: [],
      failed: [first.attachmentId],
    });
    rpc.resolveRunnerResponse({
      requestId: secondCommand.requestId,
      sessionId: second.sessionId,
      deleted: [second.attachmentId],
      failed: [],
    });

    await Promise.all([firstReconciliation, joinedReconciliation]);
    expect(store.listAttachmentCleanupJobs(first.projectId)).toHaveLength(1);
    expect(store.listAttachmentCleanupJobs(second.projectId)).toEqual([]);
  });

  it("archives a historical session with a pending resumable start without deleting its history", () => {
    const createdAt = "2026-06-05T00:00:00.000Z";
    store.createProject(projectRecord());
    const completed = store.createSession({
      ...sessionRecord(),
      status: "completed",
      agentThreadId: "thread-existing",
    });
    store.addMessage({
      id: "historical-message",
      sessionId: completed.id,
      role: "assistant",
      content: "historical answer",
      encrypted: false,
      createdAt,
    });
    const pendingMessage = pendingUserMessage(
      "resumable-follow-up",
      "pending follow-up",
      createdAt,
    );
    const pendingAttachment = storedAttachment(pendingMessage.id, createdAt);
    store.preparePendingSessionStart(
      {
        deliveryId: pendingMessage.id,
        kind: "start",
        runnerId: completed.runnerId,
        sessionId: completed.id,
        message: pendingMessage,
        attachments: [pendingAttachment],
        startCommand: {
          type: "startSession",
          requestId: "resume-start",
          deliveryId: pendingMessage.id,
          session: { ...completed, status: "pending" },
          prompt: pendingMessage.content,
          attachments: [toRunnerAttachment(pendingAttachment)],
          resumeThreadId: "thread-existing",
        },
        createdAt,
      },
      createdAt,
    );

    const archivedAt = new Date().toISOString();
    store.archiveProject("project-1", archivedAt);

    expect(store.getSession(completed.id)).toMatchObject({
      archivedAt,
      status: "stopped",
      agentThreadId: "thread-existing",
    });
    expect(store.listMessages(completed.id)).toEqual([
      expect.objectContaining({
        id: "historical-message",
        content: "historical answer",
      }),
    ]);
    expect(store.getMessage(completed.id, pendingMessage.id)).toBeUndefined();
    expect(store.listPendingInputDeliveries("runner-1")).toEqual([]);
    expect(store.listAttachmentCleanupJobs("project-1")).toEqual([
      expect.objectContaining({
        sessionId: completed.id,
        attachmentId: pendingAttachment.id,
      }),
    ]);
  });

  it("cleans attachments after project archiving has synchronously captured its sessions", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    addStoredAttachments(store, 1);
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const archivedAt = new Date().toISOString();

    store.archiveProject("project-1", archivedAt);
    const cleanup = service.handleProjectArchived("project-1", archivedAt);
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const deleteCommand = runnerMessages[0];
    if (deleteCommand?.type !== "deleteSessionAttachments") {
      throw new Error("archived project attachment cleanup was not delivered");
    }
    rpc.resolveRunnerResponse({
      requestId: deleteCommand.requestId,
      sessionId: "session-1",
      deleted: ["attachment-1"],
      failed: [],
    });
    await cleanup;

    expect(store.getProject("project-1")?.archivedAt).toBe(archivedAt);
    expect(store.getSession("session-1")?.archivedAt).toBe(archivedAt);
    expect(
      store.getStoredMessageAttachment("session-1", "attachment-1"),
    ).toMatchObject({ status: "deleted" });
  });

  it("cancels an offline pending start before stop and never reconciles it", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const durableRunner = durableRunnerRegistration();
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    hub.registerRunner(durableRunner, fakeSocket<RunnerCommand>([]));
    const send = vi.spyOn(hub, "sendToRunner").mockReturnValueOnce(false);

    await expect(
      service.createUserMessage("session-1", {
        requestId: "stop-before-reconnect",
        content: "must not start",
      }),
    ).resolves.toMatchObject({ ok: true });
    send.mockRestore();
    expect(store.listPendingInputDeliveries("runner-1")).toHaveLength(1);
    hub.markRunnerOffline("runner-1");

    await service.handleClientCommand({
      type: "controlSignal",
      sessionId: "session-1",
      signal: "stop",
    });
    expect(store.listPendingInputDeliveries("runner-1")).toEqual([]);
    const reconnectedMessages: RunnerCommand[] = [];
    hub.registerRunner(durableRunner, fakeSocket(reconnectedMessages));
    await service.reconcilePendingInputDeliveries("runner-1");

    expect(reconnectedMessages).toEqual([]);
    expect(store.getSession("session-1")?.status).toBe("stopped");
  });

  it("finalizes a terminal pending start without sending a ghost restart", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const durableRunner = durableRunnerRegistration();
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    hub.registerRunner(durableRunner, fakeSocket<RunnerCommand>([]));
    const send = vi.spyOn(hub, "sendToRunner").mockReturnValueOnce(false);

    await expect(
      service.createUserMessage("session-1", {
        requestId: "terminal-before-reconnect",
        content: "already executed",
      }),
    ).resolves.toMatchObject({ ok: true });
    send.mockRestore();
    const [pending] = store.listPendingInputDeliveries("runner-1");
    expect(pending).toBeDefined();
    store.updateSessionStatus(
      "session-1",
      "completed",
      new Date().toISOString(),
    );
    hub.markRunnerOffline("runner-1");

    const reconnectedMessages: RunnerCommand[] = [];
    hub.registerRunner(durableRunner, fakeSocket(reconnectedMessages));
    await service.reconcilePendingInputDeliveries("runner-1");

    expect(reconnectedMessages).toEqual([]);
    expect(store.getPendingInputDelivery(pending!.deliveryId)).toBeUndefined();
    expect(store.listMessages("session-1")).toEqual([
      expect.objectContaining({ content: "already executed" }),
    ]);
  });

  it("reconciles a durable control resume without creating a synthetic message", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const durableRunner = durableRunnerRegistration();
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      agentThreadId: "resume-thread",
    });
    hub.registerRunner(durableRunner, fakeSocket<RunnerCommand>([]));
    const send = vi.spyOn(hub, "sendToRunner").mockReturnValueOnce(false);

    await service.handleClientCommand({
      type: "controlSignal",
      sessionId: "session-1",
      signal: "resume",
    });
    send.mockRestore();
    const [pending] = store.listPendingInputDeliveries("runner-1");
    expect(pending).toMatchObject({
      kind: "start",
      persistMessage: false,
      startCommand: { resumeThreadId: "resume-thread" },
    });
    expect(store.listPendingMessageDeliveries("session-1")).toEqual([]);
    expect(store.listMessages("session-1")).toEqual([]);
    await vi.waitFor(() =>
      expect(
        store.getPendingInputDelivery(pending!.deliveryId)?.attemptCount,
      ).toBe(1),
    );
    hub.markRunnerOffline("runner-1");

    const reconnectedMessages: RunnerCommand[] = [];
    hub.registerRunner(durableRunner, fakeSocket(reconnectedMessages));
    const reconciliation = service.reconcilePendingInputDeliveries("runner-1");
    await vi.waitFor(() => expect(reconnectedMessages).toHaveLength(1));
    const start = reconnectedMessages[0];
    if (start?.type !== "startSession") {
      throw new Error("control resume was not reconciled");
    }
    rpc.resolveRunnerResponse({
      requestId: start.requestId!,
      sessionId: "session-1",
      deliveryId: start.deliveryId!,
      ownership: "owned",
    });
    await reconciliation;

    expect(store.listPendingInputDeliveries("runner-1")).toEqual([]);
    expect(store.listMessages("session-1")).toEqual([]);
  });

  it("settles a durable start rejection instead of leaving the session pending", async () => {
    const hub = new ConnectionHub(store);
    const broadcast = vi.spyOn(hub, "broadcast");
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    hub.registerRunner(durableRunnerRegistration(), fakeSocket(runnerMessages));
    const send = vi.spyOn(hub, "sendToRunner").mockReturnValueOnce(false);

    await expect(
      service.createUserMessage("session-1", {
        requestId: "stale-launched-start",
        content: "do not replay",
      }),
    ).resolves.toMatchObject({ ok: true, value: { queued: true } });
    send.mockRestore();
    expect(store.listVisibleMessages("session-1")).toEqual([]);
    expect(store.listPendingMessageDeliveries("session-1")).toHaveLength(1);

    const pending = service.createUserMessage("session-1", {
      requestId: "stale-launched-start",
      content: "do not replay",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const start = runnerMessages[0];
    if (start?.type !== "startSession") {
      throw new Error("durable start command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: start.requestId!,
      sessionId: "session-1",
      deliveryId: start.deliveryId!,
      ownership: "not_owned",
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "runner_error",
      code: "START_NOT_OWNED",
    });
    expect(store.getPendingInputDelivery(start.deliveryId!)).toBeUndefined();
    expect(store.getSession("session-1")?.status).toBe("failed");
    expect(store.listMessages("session-1")).toEqual([]);
    expect(store.listVisibleMessages("session-1")).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "error",
      sessionId: "session-1",
      messageId: start.deliveryId,
      message: "runner did not accept the pending session start",
      code: "START_NOT_OWNED",
    });
  });

  it("keeps a waiting input pending when a restarted runner does not own it", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "waiting_input" });
    store.setPendingUserInputRequest("session-1", "input-before-restart");
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      content: "do not lose this answer",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: false,
      inputReceipt: {
        deliveryId: command.deliverInput!.deliveryId!,
        ownership: "not_owned",
      },
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "runner_error",
      code: "INPUT_NOT_OWNED",
    });
    expect(store.listMessages("session-1")).toEqual([]);
    expect(store.getPendingUserInputRequest("session-1")).toBe(
      "input-before-restart",
    );
  });

  it("terminally rejects an expired input request even after the session becomes inactive", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "waiting_input" });
    store.setPendingUserInputRequest("session-1", "expired-input-request");
    hub.registerRunner(durableRunnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      requestId: "expired-input-first-attempt",
      content: "answer an expired prompt",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    expect(command.deliverInput?.inputRequestId).toBe("expired-input-request");
    store.updateSessionStatus(
      "session-1",
      "completed",
      new Date().toISOString(),
    );
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: false,
      inputReceipt: {
        deliveryId: command.deliverInput!.deliveryId!,
        ownership: "not_owned",
      },
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "runner_error",
      code: "INPUT_NOT_OWNED",
    });
    expect(runnerMessages).toHaveLength(1);
    expect(
      store.getPendingInputDelivery(command.deliverInput!.deliveryId!),
    ).toBeUndefined();
    expect(store.listMessages("session-1")).toEqual([]);
  });

  it("terminally rejects an expired input request on same-request retry", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    const requestId = "expired-input-retry";
    const deliveryId = stableTestInputDeliveryId("session-1", requestId);
    const createdAt = new Date().toISOString();
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    store.putPendingInputDelivery({
      deliveryId,
      kind: "input",
      runnerId: "runner-1",
      sessionId: "session-1",
      inputRequestId: "expired-input-request",
      message: pendingUserMessage(
        deliveryId,
        "retry expired answer",
        createdAt,
      ),
      attachments: [],
      createdAt,
    });
    hub.registerRunner(durableRunnerRegistration(), fakeSocket(runnerMessages));

    const retry = service.createUserMessage("session-1", {
      requestId,
      content: "retry expired answer",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: false,
      inputReceipt: { deliveryId, ownership: "not_owned" },
    });

    await expect(retry).resolves.toMatchObject({
      ok: false,
      error: "runner_error",
      code: "INPUT_NOT_OWNED",
    });
    expect(runnerMessages).toHaveLength(1);
    expect(store.getPendingInputDelivery(deliveryId)).toBeUndefined();
    expect(store.listMessages("session-1")).toEqual([]);
  });

  it("terminally rejects an expired input request during reconnect reconciliation", async () => {
    const hub = new ConnectionHub(store);
    const broadcast = vi.spyOn(hub, "broadcast");
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    const deliveryId = "expired-input-reconcile";
    const createdAt = new Date().toISOString();
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    store.putPendingInputDelivery({
      deliveryId,
      kind: "input",
      runnerId: "runner-1",
      sessionId: "session-1",
      inputRequestId: "expired-input-request",
      message: pendingUserMessage(
        deliveryId,
        "reconcile expired answer",
        createdAt,
      ),
      attachments: [],
      createdAt,
    });
    hub.registerRunner(durableRunnerRegistration(), fakeSocket(runnerMessages));

    const reconciliation = service.reconcilePendingInputDeliveries("runner-1");
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: false,
      inputReceipt: { deliveryId, ownership: "not_owned" },
    });
    await reconciliation;

    expect(runnerMessages).toHaveLength(1);
    expect(store.getPendingInputDelivery(deliveryId)).toBeUndefined();
    expect(store.listMessages("session-1")).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        sessionId: "session-1",
        messageId: deliveryId,
        code: "INPUT_NOT_OWNED",
      }),
    );
  });

  it("atomically delivers active Codex input through a status RPC", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      content: "continue atomically",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    expect(command).toMatchObject({
      type: "checkSessionStatus",
      sessionId: "session-1",
      deliverInput: { content: "continue atomically" },
    });
    if (command?.type !== "checkSessionStatus") {
      throw new Error("atomic input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: true,
      inputDelivered: true,
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(runnerMessages).toHaveLength(1);
    expect(store.listMessages("session-1")).toEqual([
      expect.objectContaining({ content: "continue atomically" }),
    ]);
  });

  it("does not restart input accepted by a generation that just completed", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      content: "continue exactly once",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("atomic input command was not sent");
    }
    store.updateSessionStatus(
      "session-1",
      "completed",
      new Date().toISOString(),
    );
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: false,
      inputDelivered: true,
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(runnerMessages).toHaveLength(1);
    expect(store.getSession("session-1")?.status).toBe("completed");
  });

  it("restarts a terminal Codex turn when atomic input misses the old generation", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), agentThreadId: "thread-1" });
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      content: "continue after completion",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("atomic input command was not sent");
    }
    store.updateSessionStatus(
      "session-1",
      "completed",
      new Date().toISOString(),
    );
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: false,
      inputDelivered: false,
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(runnerMessages[1]).toMatchObject({
      type: "startSession",
      prompt: "continue after completion",
      resumeThreadId: "thread-1",
      session: expect.objectContaining({ status: "pending" }),
    });
    expect(store.getSession("session-1")?.status).toBe("pending");
  });

  it("falls back to legacy one-way delivery for an active old runner", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      content: "legacy follow-up",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("legacy status command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: true,
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(runnerMessages[1]).toEqual({
      type: "deliverInput",
      sessionId: "session-1",
      content: "legacy follow-up",
    });
  });

  it("does not restart when an active runner rejects atomic input", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      content: "rejected follow-up",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("atomic input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: true,
      inputDelivered: false,
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "runner_error",
      code: "AGENT_INPUT_ERROR",
    });
    expect(runnerMessages).toHaveLength(1);
    expect(store.getSession("session-1")?.status).toBe("running");
    expect(store.listMessages("session-1")).toEqual([]);
  });

  it("does not fall back to one-way delivery after a stable not-owned receipt", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      content: "must not be sent twice",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: true,
      inputReceipt: {
        deliveryId: command.deliverInput!.deliveryId!,
        ownership: "not_owned",
      },
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "runner_error",
      code: "AGENT_INPUT_ERROR",
    });
    expect(runnerMessages).toHaveLength(1);
    expect(store.listMessages("session-1")).toEqual([]);
  });

  it("restarts an inactive session after not-owned without broadcasting a false input failure", async () => {
    const hub = new ConnectionHub(store);
    const broadcast = vi.spyOn(hub, "broadcast");
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const pending = service.createUserMessage("session-1", {
      requestId: "inactive-not-owned",
      content: "resume this exact message",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const delivery = runnerMessages[0];
    if (delivery?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: delivery.requestId,
      sessionId: "session-1",
      active: false,
      inputReceipt: {
        deliveryId: delivery.deliverInput!.deliveryId!,
        ownership: "not_owned",
      },
    });

    await vi.waitFor(() => expect(runnerMessages).toHaveLength(2));
    const restart = runnerMessages[1];
    if (restart?.type !== "startSession") {
      throw new Error("session restart command was not sent");
    }
    expect(restart.deliveryId).toBe(delivery.deliverInput!.deliveryId);
    rpc.resolveRunnerResponse({
      requestId: restart.requestId!,
      sessionId: "session-1",
      deliveryId: restart.deliveryId!,
      ownership: "owned",
    });

    const result = await pending;
    expect(result).toMatchObject({
      ok: true,
      value: {
        message: {
          id: delivery.deliverInput!.deliveryId,
          content: "resume this exact message",
        },
      },
    });
    expect(store.listMessages("session-1")).toEqual([
      expect.objectContaining({
        id: delivery.deliverInput!.deliveryId,
        content: "resume this exact message",
      }),
    ]);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        messageId: delivery.deliverInput!.deliveryId,
        code: "INPUT_NOT_OWNED",
      }),
    );

    await vi.waitFor(() =>
      expect(store.listPendingInputDeliveries("runner-1")).toEqual([]),
    );
  });

  it.each(["disconnect", "no-resume"] as const)(
    "returns queued after inactive not-owned when the runner has an immediate %s transition",
    async (transition) => {
      const hub = new ConnectionHub(store);
      const rpc = new RunnerRpcClient(hub);
      const service = new SessionCommandService(
        store,
        hub,
        new ApprovalService(store, hub),
        rpc,
        100,
      );
      const runner = durableRunnerRegistration();
      const runnerMessages: RunnerCommand[] = [];
      store.createProject(projectRecord());
      store.createSession(sessionRecord());
      hub.registerRunner(runner, fakeSocket(runnerMessages));

      const accepted = service.createUserMessage("session-1", {
        requestId: `transition-${transition}`,
        content: "keep this exact durable turn",
      });
      await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
      const initialCheck = runnerMessages[0];
      if (initialCheck?.type !== "checkSessionStatus") {
        throw new Error("stable input command was not sent");
      }
      const deliveryId = initialCheck.deliverInput!.deliveryId!;
      rpc.resolveRunnerResponse({
        requestId: initialCheck.requestId,
        sessionId: "session-1",
        active: false,
        inputReceipt: { deliveryId, ownership: "not_owned" },
      });
      if (transition === "disconnect") {
        hub.markRunnerOffline("runner-1");
      } else {
        hub.registerRunner(
          {
            ...runner,
            capabilities: runner.capabilities.map((capability) => ({
              ...capability,
              supportsResume: false,
            })),
          },
          fakeSocket<RunnerCommand>([]),
        );
      }

      await expect(accepted).resolves.toMatchObject({
        ok: true,
        value: {
          queued: true,
          message: { id: deliveryId, content: "keep this exact durable turn" },
        },
      });
      expect(store.getPendingInputDelivery(deliveryId)).toMatchObject({
        kind: "input",
        message: { id: deliveryId },
        attachments: [],
      });

      const reconnectedMessages: RunnerCommand[] = [];
      hub.registerRunner(runner, fakeSocket(reconnectedMessages));
      const retry = service.createUserMessage("session-1", {
        requestId: `transition-${transition}`,
        content: "keep this exact durable turn",
      });
      await vi.waitFor(() => expect(reconnectedMessages).toHaveLength(1));
      const recheck = reconnectedMessages[0];
      if (recheck?.type !== "checkSessionStatus") {
        throw new Error("queued input receipt was not reconciled");
      }
      expect(recheck.deliverInput?.deliveryId).toBe(deliveryId);
      rpc.resolveRunnerResponse({
        requestId: recheck.requestId,
        sessionId: "session-1",
        active: false,
        inputReceipt: { deliveryId, ownership: "not_owned" },
      });
      await vi.waitFor(() => expect(reconnectedMessages).toHaveLength(2));
      const restart = reconnectedMessages[1];
      if (restart?.type !== "startSession") {
        throw new Error("queued input was not promoted to a session start");
      }
      expect(restart).toMatchObject({
        deliveryId,
        prompt: "keep this exact durable turn",
        attachments: [],
      });
      rpc.resolveRunnerResponse({
        requestId: restart.requestId!,
        sessionId: "session-1",
        deliveryId,
        ownership: "owned",
      });
      await expect(retry).resolves.toMatchObject({
        ok: true,
        value: { message: { id: deliveryId } },
      });

      expect(store.getPendingInputDelivery(deliveryId)).toBeUndefined();
      expect(store.listMessages("session-1")).toEqual([
        expect.objectContaining({ id: deliveryId }),
      ]);
    },
  );

  it("checks a stable receipt before settling terminal pending input", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    const createdAt = new Date().toISOString();
    const deliveryId = "terminal-input-receipt";
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    store.putPendingInputDelivery({
      deliveryId,
      kind: "input",
      runnerId: "runner-1",
      sessionId: "session-1",
      message: pendingUserMessage(
        deliveryId,
        "committed before terminal",
        createdAt,
      ),
      attachments: [storedAttachment(deliveryId, createdAt)],
      createdAt,
    });
    hub.registerRunner(durableRunnerRegistration(), fakeSocket(runnerMessages));

    const reconciliation = service.reconcilePendingInputDeliveries("runner-1");
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const receiptCheck = runnerMessages[0];
    if (receiptCheck?.type !== "checkSessionStatus") {
      throw new Error("terminal input receipt was not checked");
    }
    expect(receiptCheck.deliverInput?.deliveryId).toBe(deliveryId);
    rpc.resolveRunnerResponse({
      requestId: receiptCheck.requestId,
      sessionId: "session-1",
      active: false,
      inputReceipt: { deliveryId, ownership: "owned" },
    });
    await reconciliation;

    expect(store.getPendingInputDelivery(deliveryId)).toBeUndefined();
    expect(store.listMessages("session-1")).toEqual([
      expect.objectContaining({ id: deliveryId }),
    ]);
    expect(store.listMessageAttachments("session-1")).toEqual([
      expect.objectContaining({
        id: `attachment-${deliveryId}`,
        messageId: deliveryId,
      }),
    ]);
  });

  it("promotes a terminal pending input on same-request retry without changing IDs or attachments", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    const requestId = "same-terminal-pending-request";
    const deliveryId = stableTestInputDeliveryId("session-1", requestId);
    const createdAt = new Date().toISOString();
    const attachment = storedAttachment(deliveryId, createdAt);
    const imageRunner = imageRunnerRegistration();
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    store.putPendingInputDelivery({
      deliveryId,
      kind: "input",
      runnerId: "runner-1",
      sessionId: "session-1",
      message: pendingUserMessage(
        deliveryId,
        "retry this exact turn",
        createdAt,
      ),
      attachments: [attachment],
      createdAt,
    });
    hub.registerRunner(
      {
        ...imageRunner,
        capabilities: imageRunner.capabilities.map((capability) => ({
          ...capability,
          supportsDurableSessionStart: true,
        })),
      },
      fakeSocket(runnerMessages),
    );

    const retry = service.createUserMessage("session-1", {
      requestId,
      content: "retry this exact turn",
      attachments: [imageUpload()],
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const receiptCheck = runnerMessages[0];
    if (receiptCheck?.type !== "checkSessionStatus") {
      throw new Error("same-request pending receipt was not checked");
    }
    expect(receiptCheck.deliverInput?.deliveryId).toBe(deliveryId);
    rpc.resolveRunnerResponse({
      requestId: receiptCheck.requestId,
      sessionId: "session-1",
      active: false,
      inputReceipt: { deliveryId, ownership: "not_owned" },
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(2));
    const restart = runnerMessages[1];
    if (restart?.type !== "startSession") {
      throw new Error("same-request pending input was not promoted");
    }
    expect(restart).toMatchObject({
      deliveryId,
      prompt: "retry this exact turn",
      attachments: [
        {
          id: attachment.id,
          runnerStoragePath: attachment.runnerStoragePath,
        },
      ],
    });
    rpc.resolveRunnerResponse({
      requestId: restart.requestId!,
      sessionId: "session-1",
      deliveryId,
      ownership: "owned",
    });

    await expect(retry).resolves.toMatchObject({
      ok: true,
      value: {
        message: { id: deliveryId, content: "retry this exact turn" },
        attachments: [{ id: attachment.id, messageId: deliveryId }],
      },
    });
    expect(store.listMessages("session-1")).toEqual([
      expect.objectContaining({ id: deliveryId }),
    ]);
    expect(store.listMessageAttachments("session-1")).toEqual([
      expect.objectContaining({ id: attachment.id, messageId: deliveryId }),
    ]);
    expect(store.listPendingInputDeliveries("runner-1")).toEqual([]);
  });

  it("keeps a promoted visible message queued across a start timeout", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      20,
    );
    const runnerMessages: RunnerCommand[] = [];
    const createdAt = new Date().toISOString();
    const deliveryId = "promoted-visible-message";
    const attachment = storedAttachment(deliveryId, createdAt);
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    store.putPendingInputDelivery({
      deliveryId,
      kind: "input",
      runnerId: "runner-1",
      sessionId: "session-1",
      message: pendingUserMessage(
        deliveryId,
        "remain visible while queued",
        createdAt,
      ),
      attachments: [attachment],
      createdAt,
    });
    hub.registerRunner(durableRunnerRegistration(), fakeSocket(runnerMessages));

    const reconciliation = service.reconcilePendingInputDeliveries("runner-1");
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const receiptCheck = runnerMessages[0];
    if (receiptCheck?.type !== "checkSessionStatus") {
      throw new Error("pending input receipt was not checked");
    }
    rpc.resolveRunnerResponse({
      requestId: receiptCheck.requestId,
      sessionId: "session-1",
      active: false,
      inputReceipt: { deliveryId, ownership: "not_owned" },
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(2));
    expect(runnerMessages[1]).toMatchObject({
      type: "startSession",
      deliveryId,
      attachments: [
        {
          id: `attachment-${deliveryId}`,
          runnerStoragePath: attachment.runnerStoragePath,
        },
      ],
    });
    await reconciliation;

    expect(store.getPendingInputDelivery(deliveryId)).toMatchObject({
      kind: "start",
      deliveryId,
      attachments: [attachment],
    });
    expect(store.listVisibleMessages("session-1")).toEqual([]);
    expect(store.listVisibleMessageAttachments("session-1")).toEqual([]);
    expect(store.listPendingMessageDeliveries("session-1")).toEqual([
      expect.objectContaining({
        messageId: deliveryId,
        content: "remain visible while queued",
        attachments: [
          expect.objectContaining({ id: `attachment-${deliveryId}` }),
        ],
      }),
    ]);
  });

  it("preserves the pending input request across a server restart and clears it after resolution", async () => {
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "waiting_input",
    });
    const initialHub = new ConnectionHub(store);
    new RunnerEventService(
      store,
      initialHub,
      new RunnerRpcClient(initialHub),
    ).handle({
      type: "agentActivity",
      sessionId: "session-1",
      agent: "codex",
      kind: "status",
      label: "Need input",
      inputRequestId: "input-request-persisted",
    });

    store.close();
    store = new ServerStore(dataDir);
    const runnerMessages: RunnerCommand[] = [];
    const hub = new ConnectionHub(store);
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const rpc = new RunnerRpcClient(hub);
    const service = new SessionCommandService(
      store,
      hub,
      new ApprovalService(store, hub),
      rpc,
      100,
    );

    const pending = service.createUserMessage("session-1", {
      content: "continue after restart",
    });
    await vi.waitFor(() => expect(runnerMessages).toHaveLength(1));
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("stable input command was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: true,
      inputReceipt: {
        deliveryId: command.deliverInput!.deliveryId!,
        ownership: "owned",
      },
    });
    const result = await pending;

    expect(result).toMatchObject({ ok: true });
    expect(command.deliverInput).toMatchObject({
      inputRequestId: "input-request-persisted",
      content: "continue after restart",
    });
    store.close();
    store = new ServerStore(dataDir);
    expect(store.getPendingUserInputRequest("session-1")).toBeUndefined();
  });

  it("migrates legacy session tables and clears pending input IDs on status and deletion", () => {
    store.createProject(projectRecord());
    store.createSession(sessionRecord());
    const dbPath = store.dbPath;
    store.close();
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("ALTER TABLE sessions DROP COLUMN pending_input_request_id");
    legacyDb.close();

    store = new ServerStore(dataDir);
    store.setPendingUserInputRequest("session-1", "input-after-migration");
    store.updateSessionStatus(
      "session-1",
      "waiting_input",
      new Date().toISOString(),
    );
    expect(store.getPendingUserInputRequest("session-1")).toBe(
      "input-after-migration",
    );

    store.updateSessionStatus(
      "session-1",
      "completed",
      new Date().toISOString(),
    );
    store.updateSessionStatus(
      "session-1",
      "waiting_input",
      new Date().toISOString(),
    );
    expect(store.getPendingUserInputRequest("session-1")).toBeUndefined();

    store.setPendingUserInputRequest("session-1", "input-before-delete");
    expect(store.deleteSession("session-1")).toBe(true);
    store.createSession({ ...sessionRecord(), status: "waiting_input" });
    expect(store.getPendingUserInputRequest("session-1")).toBeUndefined();
  });

  it("backfills legacy initial starts without misclassifying historical follow-ups", () => {
    const createdAt = "2026-06-05T00:00:00.000Z";
    const addLegacyInitial = (
      suffix: string,
      creationRequestFingerprint?: string,
    ) => {
      const projectId = `project-initial-${suffix}`;
      const sessionId = `session-initial-${suffix}`;
      const deliveryId = `delivery-initial-${suffix}`;
      store.createProject({ ...projectRecord(), id: projectId });
      const session = {
        ...sessionRecord(),
        id: sessionId,
        projectId,
        status: "pending" as const,
        createdAt,
        updatedAt: createdAt,
      };
      store.createSessionWithPendingStart(
        session,
        {
          deliveryId,
          kind: "start",
          runnerId: "runner-1",
          sessionId,
          message: {
            ...pendingUserMessage(deliveryId, "legacy initial", createdAt),
            sessionId,
          },
          attachments: [],
          startCommand: {
            type: "startSession",
            requestId: `start-${suffix}`,
            deliveryId,
            session,
            prompt: "legacy initial",
            attachments: [],
          },
          createdAt,
        },
        creationRequestFingerprint,
      );
      return { projectId, sessionId, deliveryId };
    };
    const fingerprinted = addLegacyInitial("fingerprinted", "fingerprint-1");
    const requestIdless = addLegacyInitial("requestless");

    const historicalProjectId = "project-historical";
    const historicalSessionId = "session-historical";
    const historicalDeliveryId = "delivery-historical";
    store.createProject({ ...projectRecord(), id: historicalProjectId });
    const historical = store.createSession({
      ...sessionRecord(),
      id: historicalSessionId,
      projectId: historicalProjectId,
      status: "completed",
      agentThreadId: "thread-historical",
      createdAt,
      updatedAt: createdAt,
    });
    store.addMessage({
      id: "message-historical",
      sessionId: historicalSessionId,
      role: "assistant",
      content: "keep this history",
      encrypted: false,
      createdAt,
    });
    const restartedAt = "2026-06-06T00:00:00.000Z";
    store.preparePendingSessionStart(
      {
        deliveryId: historicalDeliveryId,
        kind: "start",
        runnerId: "runner-1",
        sessionId: historicalSessionId,
        message: {
          ...pendingUserMessage(
            historicalDeliveryId,
            "legacy follow-up",
            restartedAt,
          ),
          sessionId: historicalSessionId,
        },
        attachments: [],
        startCommand: {
          type: "startSession",
          requestId: "start-historical",
          deliveryId: historicalDeliveryId,
          session: {
            ...historical,
            status: "pending",
            updatedAt: restartedAt,
          },
          prompt: "legacy follow-up",
          attachments: [],
          resumeThreadId: "thread-historical",
        },
        createdAt: restartedAt,
      },
      restartedAt,
    );

    const dbPath = store.dbPath;
    store.close();
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      DELETE FROM schema_migrations
      WHERE key = 'backfill_initial_session_create_v1';
      ALTER TABLE pending_input_deliveries DROP COLUMN initial_session_create;
    `);
    legacyDb.close();
    store = new ServerStore(dataDir);

    store.close();
    const interruptedMigrationDb = new DatabaseSync(dbPath);
    interruptedMigrationDb.exec(`
      UPDATE pending_input_deliveries SET initial_session_create = 0;
      DELETE FROM schema_migrations
      WHERE key = 'backfill_initial_session_create_v1';
    `);
    interruptedMigrationDb.close();
    store = new ServerStore(dataDir);

    expect(
      store.getPendingInputDelivery(fingerprinted.deliveryId)
        ?.initialSessionCreate,
    ).toBe(true);
    expect(
      store.getPendingInputDelivery(requestIdless.deliveryId)
        ?.initialSessionCreate,
    ).toBe(true);
    expect(
      store.getPendingInputDelivery(historicalDeliveryId)?.initialSessionCreate,
    ).toBeUndefined();

    const controlProjectId = "project-control-resume";
    const controlSessionId = "session-control-resume";
    const controlDeliveryId = "delivery-control-resume";
    store.createProject({ ...projectRecord(), id: controlProjectId });
    const controlSession = store.createSession({
      ...sessionRecord(),
      id: controlSessionId,
      projectId: controlProjectId,
      status: "pending",
      createdAt: restartedAt,
      updatedAt: restartedAt,
    });
    store.putPendingInputDelivery({
      deliveryId: controlDeliveryId,
      kind: "start",
      runnerId: "runner-1",
      sessionId: controlSessionId,
      message: {
        ...pendingUserMessage(
          controlDeliveryId,
          "future control resume",
          restartedAt,
        ),
        sessionId: controlSessionId,
      },
      attachments: [],
      startCommand: {
        type: "startSession",
        requestId: "start-control-resume",
        deliveryId: controlDeliveryId,
        session: controlSession,
        prompt: "future control resume",
        attachments: [],
      },
      persistMessage: false,
      createdAt: restartedAt,
    });
    store.close();
    store = new ServerStore(dataDir);
    expect(
      store.getPendingInputDelivery(controlDeliveryId)?.initialSessionCreate,
    ).toBeUndefined();

    for (const initial of [fingerprinted, requestIdless]) {
      store.archiveProject(initial.projectId, restartedAt);
      store.restoreProject(initial.projectId, restartedAt);
      expect(store.getSession(initial.sessionId)).toBeUndefined();
    }
    store.archiveProject(historicalProjectId, restartedAt);
    store.restoreProject(historicalProjectId, restartedAt);
    expect(store.getSession(historicalSessionId)).toBeDefined();
    expect(store.listMessages(historicalSessionId)).toEqual([
      expect.objectContaining({
        id: "message-historical",
        content: "keep this history",
      }),
    ]);
    store.archiveProject(controlProjectId, restartedAt);
    store.restoreProject(controlProjectId, restartedAt);
    expect(store.getSession(controlSessionId)).toBeDefined();
  });

  it("rolls back session creation when startSession cannot be delivered", async () => {
    const hub = new ConnectionHub(store);
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(
      store,
      hub,
      approvals,
      new RunnerRpcClient(hub),
      100,
    );
    store.createProject(projectRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket<RunnerCommand>([], 3));

    const result = await service.createSession({
      projectId: "project-1",
      agent: "codex",
      prompt: "hello",
    });

    expect(result).toMatchObject({ ok: false, error: "runner_offline" });
    expect(store.listSessions()).toEqual([]);
  });

  it.each(["pending", "running", "waiting_approval", "waiting_input"] as const)(
    "marks only the checked %s session stopped when its runner is offline",
    async (status) => {
      const streamEvents: ServerEvent[] = [];
      const hub = new ConnectionHub(store);
      hub.addStream(fakeSocket(streamEvents));
      const approvals = new ApprovalService(store, hub);
      const service = new SessionCommandService(
        store,
        hub,
        approvals,
        new RunnerRpcClient(hub),
        100,
      );
      store.createProject(projectRecord());
      store.setRunnerOnline(
        runnerRegistration(),
        true,
        new Date().toISOString(),
      );
      store.createSession({ ...sessionRecord(), status });
      store.createSession({ ...sessionRecord(), id: "session-2" });

      const result = await service.checkSessionStatus("session-1");

      expect(result).toMatchObject({
        ok: true,
        value: { session: { id: "session-1", status: "stopped" } },
      });
      expect(store.getSession("session-1")?.status).toBe("stopped");
      expect(store.getSession("session-2")?.status).toBe("running");
      expect(store.listOnlineRunners()).toEqual([]);
      expect(streamEvents).toContainEqual({
        type: "runner:offline",
        runnerId: "runner-1",
      });
      expect(streamEvents).toContainEqual(
        expect.objectContaining({
          type: "session:updated",
          session: expect.objectContaining({
            id: "session-1",
            status: "stopped",
          }),
        }),
      );
    },
  );

  it("checks live runner liveness before trusting active session state", async () => {
    const streamEvents: ServerEvent[] = [];
    const runnerMessages: RunnerCommand[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(store, hub, approvals, rpc, 100);
    store.createProject(projectRecord());
    store.createSession(sessionRecord());

    const checked = service.checkSessionStatus("session-1");

    await vi.waitFor(() => {
      expect(runnerMessages).toHaveLength(1);
    });
    const command = runnerMessages[0];
    expect(command).toMatchObject({
      type: "checkSessionStatus",
      sessionId: "session-1",
    });
    if (command?.type !== "checkSessionStatus") {
      throw new Error("session status check was not sent");
    }
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: false,
    });

    await expect(checked).resolves.toMatchObject({
      ok: true,
      value: { session: { id: "session-1", status: "stopped" } },
    });
    expect(store.getSession("session-1")?.status).toBe("stopped");
    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "session:updated",
        session: expect.objectContaining({
          id: "session-1",
          status: "stopped",
        }),
      }),
    );
  });

  it("returns the latest stored session after a live status check", async () => {
    const runnerMessages: RunnerCommand[] = [];
    const hub = new ConnectionHub(store);
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(store, hub, approvals, rpc, 100);
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "pending" });

    const checked = service.checkSessionStatus("session-1");

    await vi.waitFor(() => {
      expect(runnerMessages).toHaveLength(1);
    });
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("session status check was not sent");
    }
    const running = store.updateSessionStatus(
      "session-1",
      "running",
      new Date().toISOString(),
    );
    expect(running?.status).toBe("running");
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: true,
    });

    await expect(checked).resolves.toMatchObject({
      ok: true,
      value: { session: { id: "session-1", status: "running" } },
    });
  });

  it("preserves terminal statuses when a status check finishes late", async () => {
    const streamEvents: ServerEvent[] = [];
    const runnerMessages: RunnerCommand[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(store, hub, approvals, rpc, 100);
    store.createProject(projectRecord());
    store.createSession(sessionRecord());

    const checked = service.checkSessionStatus("session-1");

    await vi.waitFor(() => {
      expect(runnerMessages).toHaveLength(1);
    });
    const command = runnerMessages[0];
    if (command?.type !== "checkSessionStatus") {
      throw new Error("session status check was not sent");
    }
    store.updateSessionStatus(
      "session-1",
      "completed",
      new Date().toISOString(),
    );
    rpc.resolveRunnerResponse({
      requestId: command.requestId,
      sessionId: "session-1",
      active: false,
    });

    await expect(checked).resolves.toMatchObject({
      ok: true,
      value: { session: { id: "session-1", status: "completed" } },
    });
    expect(store.getSession("session-1")?.status).toBe("completed");
    expect(streamEvents).not.toContainEqual(
      expect.objectContaining({
        type: "session:updated",
        session: expect.objectContaining({
          id: "session-1",
          status: "stopped",
        }),
      }),
    );
  });

  it("marks unconfirmed managed worktrees unavailable when status check stops them", async () => {
    const streamEvents: ServerEvent[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(
      store,
      hub,
      approvals,
      new RunnerRpcClient(hub),
      100,
    );
    store.createProject(projectRecord());
    store.setRunnerOnline(runnerRegistration(), true, new Date().toISOString());
    store.createSession({
      ...sessionRecord(),
      status: "pending",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      gitBranchName: "session-1",
    });

    const result = await service.checkSessionStatus("session-1");

    expect(result).toMatchObject({
      ok: true,
      value: {
        session: {
          id: "session-1",
          status: "stopped",
          worktreeDeletedAt: expect.any(String),
        },
      },
    });
    expect(store.getSession("session-1")?.worktreeDeletedAt).toEqual(
      expect.any(String),
    );
    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "session:updated",
        session: expect.objectContaining({
          id: "session-1",
          status: "stopped",
          worktreeDeletedAt: expect.any(String),
        }),
      }),
    );
  });

  it("clears managed worktree unavailable markers before resuming", async () => {
    const streamEvents: ServerEvent[] = [];
    const runnerMessages: RunnerCommand[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(
      store,
      hub,
      approvals,
      new RunnerRpcClient(hub),
      100,
    );
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "stopped",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      gitBranchName: "session-1",
      worktreeDeletedAt: new Date().toISOString(),
    });

    await service.handleClientCommand({
      type: "controlSignal",
      requestId: "resume-1",
      sessionId: "session-1",
      signal: "resume",
    });

    const session = store.getSession("session-1");
    expect(session).toMatchObject({
      id: "session-1",
      status: "pending",
    });
    expect(session?.worktreeDeletedAt).toBeUndefined();
    const updateEvent = streamEvents.find(
      (event) =>
        event.type === "session:updated" && event.session.id === "session-1",
    );
    expect(updateEvent).toMatchObject({
      type: "session:updated",
      session: {
        id: "session-1",
        status: "pending",
      },
    });
    expect(
      updateEvent?.type === "session:updated"
        ? updateEvent.session.worktreeDeletedAt
        : undefined,
    ).toBeUndefined();
    const startCommand = runnerMessages.at(-1);
    expect(startCommand).toMatchObject({
      type: "startSession",
      session: expect.objectContaining({
        id: "session-1",
        status: "pending",
      }),
    });
    expect(
      startCommand?.type === "startSession"
        ? startCommand.session.worktreeDeletedAt
        : undefined,
    ).toBeUndefined();
  });

  it("removes managed worktrees before archiving when requested", async () => {
    const runnerMessages: RunnerCommand[] = [];
    const streamEvents: ServerEvent[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const gitJobs = new GitJobRunner(store, hub, rpc, 100);
    const service = new SessionCommandService(
      store,
      hub,
      approvals,
      rpc,
      100,
      gitJobs,
    );
    const runnerEvents = new RunnerEventService(
      store,
      hub,
      rpc,
      gitJobs,
      (job) => service.archiveSessionAfterWorktreeRemoval(job),
    );
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
      gitBranchName: "session-1",
    });

    const pending = service.deleteSession("session-1", {
      worktree: "remove",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(runnerMessages).toContainEqual({
      type: "controlSignal",
      sessionId: "session-1",
      signal: "stop",
    });
    const removeCommand = runnerMessages.find(
      (
        message,
      ): message is Extract<RunnerCommand, { type: "gitRemoveWorktree" }> =>
        message.type === "gitRemoveWorktree",
    );
    expect(removeCommand).toMatchObject({
      type: "gitRemoveWorktree",
      projectId: "project-1",
      context: { kind: "session_worktree", sessionId: "session-1" },
      cwd: "/workspace/.roam-runner/worktrees/project-1/session-1",
      jobOperation: "archive_remove_worktree",
    });
    expect(store.getSession("session-1")?.archivedAt).toBeUndefined();

    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: {
        job: expect.objectContaining({
          id: removeCommand?.requestId,
          operation: "archive_remove_worktree",
          status: "queued",
        }),
      },
    });
    expect(store.getSession("session-1")?.worktreeDeletedAt).toBeUndefined();

    const now = "2000-01-01T00:00:00.000Z";
    runnerEvents.handle({
      type: "gitJobResult",
      job: {
        id: removeCommand?.requestId ?? "",
        projectId: "project-1",
        sessionId: "session-1",
        contextKind: "session_worktree",
        operation: "archive_remove_worktree",
        status: "succeeded",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
      },
    });

    const archived = store.getSession("session-1");
    expect(archived).toMatchObject({
      archivedAt: expect.any(String),
      worktreeDeletedAt: expect.any(String),
    });
    expect(archived?.archivedAt).not.toBe(now);
    expect(archived?.worktreeDeletedAt).not.toBe(now);
    expect(store.listGitJobs("project-1")).toContainEqual(
      expect.objectContaining({
        id: removeCommand?.requestId,
        operation: "archive_remove_worktree",
        status: "succeeded",
      }),
    );
    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "session:updated",
        session: expect.objectContaining({
          id: "session-1",
          archivedAt: expect.any(String),
          worktreeDeletedAt: expect.any(String),
        }),
      }),
    );
  });

  it("rejects Git reads for a session while archive worktree removal is pending", async () => {
    const runnerMessages: RunnerCommand[] = [];
    const hub = new ConnectionHub(store);
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const gitJobs = new GitJobRunner(store, hub, rpc, 100);
    const sessionService = new SessionCommandService(
      store,
      hub,
      approvals,
      rpc,
      100,
      gitJobs,
    );
    const gitService = new GitService(store, hub, rpc, 100, gitJobs);
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
      gitBranchName: "session-1",
    });

    const pending = sessionService.deleteSession("session-1", {
      worktree: "remove",
    });
    await Promise.resolve();
    await Promise.resolve();
    const removeCommandCount = runnerMessages.filter(
      (message) => message.type === "gitRemoveWorktree",
    ).length;

    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: {
        job: expect.objectContaining({
          operation: "archive_remove_worktree",
          status: "queued",
        }),
      },
    });
    await expect(
      gitService.branches({
        kind: "session_worktree",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "worktree_not_available",
    });
    expect(
      runnerMessages.filter((message) => message.type === "gitRemoveWorktree"),
    ).toHaveLength(removeCommandCount);
    expect(
      runnerMessages.filter((message) => message.type === "gitBranchList"),
    ).toEqual([]);
  });

  it("times out unanswered queued Git jobs and releases the mutation queue", async () => {
    const runnerMessages: RunnerCommand[] = [];
    const hub = new ConnectionHub(store);
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const rpc = new RunnerRpcClient(hub);
    const gitJobs = new GitJobRunner(store, hub, rpc, 5);
    const runnerEvents = new RunnerEventService(store, hub, rpc, gitJobs);
    const gitService = new GitService(store, hub, rpc, 5, gitJobs);
    const context = { kind: "project" as const, projectId: "project-1" };
    store.createProject(projectRecord());

    await expect(
      gitService.stage({ context, paths: ["README.md"] }),
    ).resolves.toMatchObject({
      ok: true,
      value: { job: expect.objectContaining({ status: "queued" }) },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(runnerMessages.at(-1)).toMatchObject({
      type: "gitStagePaths",
      paths: ["README.md"],
    });
    const stageCommand = runnerMessages.at(-1);
    if (stageCommand?.type !== "gitStagePaths") {
      throw new Error("stage command was not sent");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.listGitJobs("project-1")).toContainEqual(
      expect.objectContaining({
        operation: "stage",
        status: "failed",
        errorCode: "runner_timeout",
      }),
    );
    const lateFinishedAt = new Date().toISOString();
    runnerEvents.handle({
      type: "gitJobResult",
      job: {
        id: stageCommand.requestId,
        projectId: "project-1",
        contextKind: "project",
        operation: "stage",
        status: "succeeded",
        createdAt: lateFinishedAt,
        startedAt: lateFinishedAt,
        finishedAt: lateFinishedAt,
      },
    });
    expect(store.listGitJobs("project-1")).toContainEqual(
      expect.objectContaining({
        id: stageCommand.requestId,
        operation: "stage",
        status: "succeeded",
      }),
    );

    await expect(
      gitService.discard({ context, paths: ["README.md"] }),
    ).resolves.toMatchObject({
      ok: true,
      value: { job: expect.objectContaining({ status: "queued" }) },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(runnerMessages.at(-1)).toMatchObject({
      type: "gitDiscardPaths",
      paths: ["README.md"],
    });
  });

  it.each([
    "pending",
    "running",
    "waiting_approval",
    "waiting_input",
  ] satisfies SessionStatus[])(
    "rejects managed worktree removal for active %s sessions",
    async (status) => {
      const runnerMessages: RunnerCommand[] = [];
      const hub = new ConnectionHub(store);
      hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
      const approvals = new ApprovalService(store, hub);
      const service = new SessionCommandService(
        store,
        hub,
        approvals,
        new RunnerRpcClient(hub),
        100,
      );
      store.createProject(projectRecord());
      store.createSession({
        ...sessionRecord(),
        status,
        executionMode: "managed_worktree",
        executionFolder:
          "/workspace/.roam-runner/worktrees/project-1/session-1",
        cwd: "/workspace",
        gitBranchName: "session-1",
      });

      await expect(
        service.deleteSession("session-1", { worktree: "remove" }),
      ).resolves.toMatchObject({
        ok: false,
        error: "worktree_remove_failed",
        message: "Stop the session before archiving and removing its worktree.",
        code: "session_active",
      });
      expect(runnerMessages).toEqual([]);
      expect(store.getSession("session-1")?.archivedAt).toBeUndefined();
      expect(store.getSession("session-1")?.worktreeDeletedAt).toBeUndefined();
      expect(store.listGitJobs("project-1")).toEqual([]);
    },
  );

  it("keeps managed sessions visible when archive worktree removal fails", async () => {
    const runnerMessages: RunnerCommand[] = [];
    const hub = new ConnectionHub(store);
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const gitJobs = new GitJobRunner(store, hub, rpc, 100);
    const service = new SessionCommandService(
      store,
      hub,
      approvals,
      rpc,
      100,
      gitJobs,
    );
    const runnerEvents = new RunnerEventService(
      store,
      hub,
      rpc,
      gitJobs,
      (job) => service.archiveSessionAfterWorktreeRemoval(job),
    );
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
      gitBranchName: "session-1",
    });

    const pending = service.deleteSession("session-1", {
      worktree: "remove",
    });
    await Promise.resolve();
    await Promise.resolve();
    const removeCommand = runnerMessages.find(
      (
        message,
      ): message is Extract<RunnerCommand, { type: "gitRemoveWorktree" }> =>
        message.type === "gitRemoveWorktree",
    );
    expect(removeCommand).toBeDefined();

    const now = new Date().toISOString();
    runnerEvents.handle({
      type: "gitJobResult",
      job: {
        id: removeCommand?.requestId ?? "",
        projectId: "project-1",
        sessionId: "session-1",
        contextKind: "session_worktree",
        operation: "archive_remove_worktree",
        status: "failed",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        errorCode: "GIT_OPERATION_ERROR",
        errorSummary: "Directory is not a git repository",
      },
    });

    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: {
        job: expect.objectContaining({
          id: removeCommand?.requestId,
          operation: "archive_remove_worktree",
        }),
      },
    });
    expect(store.getSession("session-1")?.archivedAt).toBeUndefined();
    expect(store.getSession("session-1")?.worktreeDeletedAt).toBeUndefined();
    expect(store.listGitJobs("project-1")).toContainEqual(
      expect.objectContaining({
        id: removeCommand?.requestId,
        operation: "archive_remove_worktree",
        status: "failed",
        errorCode: "GIT_OPERATION_ERROR",
        errorSummary: "Directory is not a git repository",
      }),
    );
  });

  it("keeps managed sessions visible when archive worktree removal cannot reach the runner", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(store, hub, approvals, rpc, 100);
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
      gitBranchName: "session-1",
    });

    await expect(
      service.deleteSession("session-1", { worktree: "remove" }),
    ).resolves.toMatchObject({
      ok: false,
      error: "worktree_remove_failed",
      message: "runner is offline",
      code: "runner_offline",
    });
    expect(store.getSession("session-1")?.archivedAt).toBeUndefined();
    expect(store.getSession("session-1")?.worktreeDeletedAt).toBeUndefined();
    expect(store.listGitJobs("project-1")).toContainEqual(
      expect.objectContaining({
        operation: "archive_remove_worktree",
        status: "failed",
        errorCode: "runner_offline",
        errorSummary: "runner is offline",
      }),
    );
  });

  it("archives worktree sessions when success arrives after the runner timeout", async () => {
    const runnerMessages: RunnerCommand[] = [];
    const streamEvents: ServerEvent[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const rpc = new RunnerRpcClient(hub);
    const approvals = new ApprovalService(store, hub);
    const gitJobs = new GitJobRunner(store, hub, rpc, 5);
    const service = new SessionCommandService(
      store,
      hub,
      approvals,
      rpc,
      5,
      gitJobs,
    );
    const runnerEvents = new RunnerEventService(
      store,
      hub,
      rpc,
      gitJobs,
      (job) => service.archiveSessionAfterWorktreeRemoval(job),
    );
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
      gitBranchName: "session-1",
    });

    const pending = service.deleteSession("session-1", {
      worktree: "remove",
    });
    await Promise.resolve();
    await Promise.resolve();
    const removeCommand = runnerMessages.find(
      (
        message,
      ): message is Extract<RunnerCommand, { type: "gitRemoveWorktree" }> =>
        message.type === "gitRemoveWorktree",
    );
    expect(removeCommand).toBeDefined();

    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: {
        job: expect.objectContaining({
          id: removeCommand?.requestId,
          operation: "archive_remove_worktree",
          status: "queued",
        }),
      },
    });
    expect(store.getSession("session-1")?.archivedAt).toBeUndefined();
    expect(store.getSession("session-1")?.worktreeDeletedAt).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getGitJob(removeCommand?.requestId ?? "")).toMatchObject({
      status: "failed",
      errorCode: "runner_timeout",
    });

    const now = "2000-01-01T00:00:00.000Z";
    runnerEvents.handle({
      type: "gitJobResult",
      job: {
        id: removeCommand?.requestId ?? "",
        projectId: "project-1",
        sessionId: "session-1",
        contextKind: "session_worktree",
        operation: "remove_worktree",
        status: "succeeded",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
      },
    });

    const archived = store.getSession("session-1");
    expect(archived).toMatchObject({
      archivedAt: expect.any(String),
      worktreeDeletedAt: expect.any(String),
    });
    expect(archived?.archivedAt).not.toBe(now);
    expect(archived?.worktreeDeletedAt).not.toBe(now);
    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "session:updated",
        session: expect.objectContaining({
          id: "session-1",
          archivedAt: expect.any(String),
          worktreeDeletedAt: expect.any(String),
        }),
      }),
    );
    expect(store.listGitJobs("project-1")).toContainEqual(
      expect.objectContaining({
        id: removeCommand?.requestId,
        operation: "archive_remove_worktree",
        status: "succeeded",
      }),
    );
  });

  it("archives already-deleted managed worktrees without removing them again", async () => {
    const runnerMessages: RunnerCommand[] = [];
    const hub = new ConnectionHub(store);
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(
      store,
      hub,
      approvals,
      new RunnerRpcClient(hub),
      100,
    );
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
      gitBranchName: "session-1",
      worktreeDeletedAt: new Date().toISOString(),
    });

    await expect(
      service.deleteSession("session-1", { worktree: "remove" }),
    ).resolves.toMatchObject({ ok: true });

    expect(
      runnerMessages.some((message) => message.type === "gitRemoveWorktree"),
    ).toBe(false);
    expect(store.getSession("session-1")).toMatchObject({
      archivedAt: expect.any(String),
      worktreeDeletedAt: expect.any(String),
    });
  });

  it("creates managed worktree sessions under the owning project directory", async () => {
    const hub = new ConnectionHub(store);
    const approvals = new ApprovalService(store, hub);
    const service = new SessionCommandService(
      store,
      hub,
      approvals,
      new RunnerRpcClient(hub),
      100,
    );
    const runnerMessages: RunnerCommand[] = [];
    store.createProject(projectRecord());
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));

    const result = await service.createSession({
      projectId: "project-1",
      agent: "codex",
      prompt: "hello",
      executionMode: "managed_worktree",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("managed worktree session was not created");
    }
    expect(result.value.session).toMatchObject({
      projectId: "project-1",
      runnerId: "runner-1",
      executionMode: "managed_worktree",
      cwd: "/workspace",
    });
    expect(result.value.session.executionFolder).toBe(
      `/workspace/.roam-runner/worktrees/project-1/${result.value.session.id}`,
    );
    expect(runnerMessages.at(-1)).toMatchObject({
      type: "startSession",
      session: {
        id: result.value.session.id,
        cwd: "/workspace",
        executionFolder: result.value.session.executionFolder,
      },
    });
  });
});

describe("ApprovalService", () => {
  let dataDir: string;
  let store: ServerStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roamcli-approval-test-"));
    store = new ServerStore(dataDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("only resolves pending approvals after runner delivery succeeds", () => {
    const hub = new ConnectionHub(store);
    const service = new ApprovalService(store, hub);
    store.createProject(projectRecord());
    const session = store.createSession(sessionRecord());
    store.upsertApproval({
      id: "approval-1",
      sessionId: session.id,
      runnerId: "runner-1",
      kind: "execCommand",
      summary: "Run command",
      payload: { command: "pwd" },
      status: "pending",
      requestedAt: new Date().toISOString(),
    });

    const offline = service.respondToApproval("approval-1", {
      approved: true,
    });
    expect(offline).toMatchObject({ ok: false, error: "runner_offline" });
    expect(store.getApproval("approval-1")?.status).toBe("pending");

    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const resolved = service.respondToApproval("approval-1", {
      approved: true,
    });
    expect(resolved.ok).toBe(true);
    expect(store.getApproval("approval-1")?.status).toBe("approved");
    expect(runnerMessages.at(-1)).toMatchObject({
      type: "resolveApproval",
      approvalId: "approval-1",
      approved: true,
    });

    const repeated = service.respondToApproval("approval-1", {
      approved: false,
    });
    expect(repeated).toMatchObject({
      ok: false,
      error: "approval_already_resolved",
    });
    expect(store.getApproval("approval-1")?.status).toBe("approved");
  });
});

describe("ArtifactStorage", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roamcli-artifact-test-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps sanitized session paths inside the artifact root", () => {
    const storage = new ArtifactStorage(dataDir);
    const marker = path.join(dataDir, "marker.txt");
    fs.writeFileSync(marker, "do not delete", "utf8");

    const artifact = storage.write({
      sessionId: "..",
      kind: "log",
      name: "..",
      mimeType: "text/plain",
      content: "hello",
    });
    const relative = path.relative(storage.rootDir, artifact.storagePath);

    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
    storage.deleteSessionArtifacts("..");
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("rejects malformed base64 and cleans up files when DB persistence fails", () => {
    expect(
      CreateArtifactRequestSchema.safeParse({
        sessionId: "session-1",
        kind: "log",
        name: "bad.log",
        mimeType: "text/plain",
        contentBase64: "!!!!",
      }).success,
    ).toBe(false);

    const storage = new ArtifactStorage(dataDir);
    const service = new ArtifactService(
      {
        getSession: () => sessionRecord(),
        addArtifact: () => {
          throw new Error("db failed");
        },
      } as unknown as ServerStore,
      storage,
      { broadcast: vi.fn() } as unknown as ConnectionHub,
    );

    expect(() =>
      service.createArtifact({
        sessionId: "session-1",
        kind: "log",
        name: "artifact.log",
        mimeType: "text/plain",
        content: "hello",
      }),
    ).toThrow("db failed");
    expect(listFiles(storage.rootDir)).toEqual([]);
  });
});

describe("WorkspaceService", () => {
  let dataDir: string;
  let store: ServerStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roamcli-workspace-test-"));
    store = new ServerStore(dataDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("sends the persisted execution folder when patching a completed session", async () => {
    store.createProject(projectRecord());
    store.createSession({ ...sessionRecord(), status: "completed" });
    const requestRunner = vi.fn().mockResolvedValue({
      requestId: "patch-1",
      sessionId: "session-1",
      applied: true,
      changedFiles: ["README.md"],
      message: "Patch applied",
      rejected: [],
    });
    const service = new WorkspaceService(
      store,
      { requestRunner } as unknown as RunnerRpcClient,
      100,
    );

    const result = await service.applyPatch("session-1", {
      patch: "diff --git a/README.md b/README.md\n",
      strip: 1,
    });

    expect(result.ok).toBe(true);
    expect(requestRunner).toHaveBeenCalledWith(
      "runner-1",
      expect.objectContaining({
        type: "applyPatch",
        sessionId: "session-1",
        cwd: "/workspace",
      }),
      100,
    );
  });

  it("does not read files from a deleted managed worktree", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
      worktreeDeletedAt: new Date().toISOString(),
    });
    const service = new WorkspaceService(store, rpc, 100);

    const result = await service.readFileTree("session-1", {
      path: ".",
      depth: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "worktree_not_available",
    });
    expect(runnerMessages).toEqual([]);
  });

  it("does not read files from a pending managed worktree", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "pending",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
    });
    const service = new WorkspaceService(store, rpc, 100);

    const result = await service.readFileTree("session-1", {
      path: ".",
      depth: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "worktree_not_available",
    });
    expect(runnerMessages).toEqual([]);
  });

  it("does not apply patches to a deleted managed worktree", async () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
      worktreeDeletedAt: new Date().toISOString(),
    });
    const service = new WorkspaceService(store, rpc, 100);

    const result = await service.applyPatch("session-1", {
      patch: "diff --git a/README.md b/README.md\n",
      strip: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "worktree_not_available",
    });
    expect(runnerMessages).toEqual([]);
  });
});

describe("RunnerEventService", () => {
  let dataDir: string;
  let store: ServerStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roamcli-event-test-"));
    store = new ServerStore(dataDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps an orphaned worktree-removal job active across restart until its terminal replay", () => {
    const now = new Date().toISOString();
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
    });
    store.upsertGitJob({
      id: "orphaned-remove-job",
      projectId: "project-1",
      sessionId: "session-1",
      contextKind: "session_worktree",
      operation: "remove_worktree",
      status: "running",
      createdAt: now,
      startedAt: now,
    });

    store.close();
    store = new ServerStore(dataDir);
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const gitJobs = new GitJobRunner(store, hub, rpc);
    const service = new RunnerEventService(store, hub, rpc, gitJobs);
    expect(gitJobs.hasActiveWorktreeRemovalJob("session-1")).toBe(true);

    service.handle({
      type: "gitJobResult",
      job: {
        id: "orphaned-remove-job",
        projectId: "untrusted-project",
        sessionId: "untrusted-session",
        contextKind: "project",
        operation: "untrusted-operation",
        status: "succeeded",
        createdAt: now,
        finishedAt: now,
      },
    });

    expect(store.getGitJob("orphaned-remove-job")).toMatchObject({
      projectId: "project-1",
      sessionId: "session-1",
      contextKind: "session_worktree",
      operation: "remove_worktree",
      status: "succeeded",
    });
    expect(gitJobs.hasActiveWorktreeRemovalJob("session-1")).toBe(false);
    expect(store.getSession("session-1")?.worktreeDeletedAt).toBe(now);
  });

  it("expires an overdue orphan after restart, releases its lock, and accepts a late terminal replay", () => {
    const old = "2000-01-01T00:00:00.000Z";
    const finishedAt = new Date().toISOString();
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
    });
    store.upsertGitJob({
      id: "expired-orphan-remove-job",
      projectId: "project-1",
      sessionId: "session-1",
      contextKind: "session_worktree",
      operation: "remove_worktree",
      status: "running",
      createdAt: old,
      startedAt: old,
    });

    store.close();
    store = new ServerStore(dataDir);
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const gitJobs = new GitJobRunner(store, hub, rpc, 10);
    expect(store.getGitJob("expired-orphan-remove-job")).toMatchObject({
      status: "failed",
      errorCode: "runner_result_unknown",
      errorSummary: expect.stringContaining("outcome is unknown"),
    });
    expect(gitJobs.hasActiveWorktreeRemovalJob("session-1")).toBe(false);

    const service = new RunnerEventService(store, hub, rpc, gitJobs);
    service.handle({
      type: "gitJobResult",
      job: {
        id: "expired-orphan-remove-job",
        projectId: "project-1",
        sessionId: "session-1",
        contextKind: "session_worktree",
        operation: "remove_worktree",
        status: "succeeded",
        createdAt: old,
        startedAt: old,
        finishedAt,
      },
    });

    expect(store.getGitJob("expired-orphan-remove-job")).toMatchObject({
      status: "succeeded",
      finishedAt,
    });
    expect(
      store.getGitJob("expired-orphan-remove-job")?.errorCode,
    ).toBeUndefined();
    expect(store.getSession("session-1")?.worktreeDeletedAt).toBe(finishedAt);
  });

  it("runs archive completion only after commit and recovers a missed callback on restart", () => {
    const now = new Date().toISOString();
    store.createProject(projectRecord());
    store.createSession({
      ...sessionRecord(),
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
    });
    store.upsertGitJob({
      id: "archive-job",
      projectId: "project-1",
      sessionId: "session-1",
      contextKind: "session_worktree",
      operation: "archive_remove_worktree",
      status: "running",
      createdAt: now,
      startedAt: now,
    });
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    const gitJobs = new GitJobRunner(store, hub, rpc);
    const broadcast = vi.spyOn(hub, "broadcast");
    const archive = vi.fn().mockImplementationOnce(() => {
      throw new Error("injected archive callback failure");
    });
    const service = new RunnerEventService(store, hub, rpc, gitJobs, archive);

    const afterCommit = service.handle(
      {
        type: "gitJobResult",
        job: {
          id: "archive-job",
          projectId: "project-1",
          sessionId: "session-1",
          contextKind: "session_worktree",
          operation: "archive_remove_worktree",
          status: "succeeded",
          createdAt: now,
          startedAt: now,
          finishedAt: now,
        },
      },
      true,
    );
    expect(store.getGitJob("archive-job")?.status).toBe("succeeded");
    expect(archive).not.toHaveBeenCalled();

    expect(() => afterCommit()).not.toThrow();
    expect(archive).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "git:job",
        job: expect.objectContaining({ id: "archive-job" }),
      }),
    );

    store.close();
    store = new ServerStore(dataDir);
    const recoveredArchive = vi.fn();
    new RunnerEventService(
      store,
      new ConnectionHub(store),
      new RunnerRpcClient(new ConnectionHub(store)),
      undefined,
      recoveredArchive,
    );
    expect(recoveredArchive).toHaveBeenCalledOnce();
    expect(recoveredArchive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "archive-job", status: "succeeded" }),
    );
  });

  it("isolates legacy runner-event effects so one failure does not skip later broadcasts", () => {
    const hub = new ConnectionHub(store);
    const rpc = new RunnerRpcClient(hub);
    vi.spyOn(rpc, "resolveRunnerResponse").mockImplementationOnce(() => {
      throw new Error("injected RPC resolution failure");
    });
    const broadcast = vi.spyOn(hub, "broadcast");
    const service = new RunnerEventService(store, hub, rpc);
    const result = {
      requestId: "file-content-1",
      sessionId: "session-1",
      path: "README.md",
      kind: "text" as const,
      content: "hello",
      truncated: false,
      encoding: "utf8" as const,
    };

    expect(() =>
      service.handle({ type: "fileContentResult", result }),
    ).not.toThrow();
    expect(broadcast).toHaveBeenCalledWith({
      type: "file:content",
      result,
    });
  });

  it("rolls back event state and lifecycle metadata with the durable high-water", () => {
    const streamId = "66666666-6666-4666-8666-666666666666";
    store.createProject(projectRecord());
    const session = store.createSession(sessionRecord());
    expect(store.negotiateRunnerEventStream("runner-1", streamId, 0)).toEqual({
      ok: true,
      ackThrough: 0,
    });

    expect(() =>
      store.processRunnerEvent("runner-1", streamId, 1, () => {
        store.updateSessionStatus(
          session.id,
          "waiting_input",
          new Date().toISOString(),
        );
        store.setPendingUserInputRequest(session.id, "input-rolled-back");
        throw new Error("injected transaction failure");
      }),
    ).toThrow("injected transaction failure");
    store.close();
    store = new ServerStore(dataDir);
    expect(store.getSession(session.id)?.status).toBe("running");
    expect(store.getPendingUserInputRequest(session.id)).toBeUndefined();

    const handle = vi.fn();
    expect(store.processRunnerEvent("runner-1", streamId, 1, handle)).toEqual({
      status: "committed",
      ackThrough: 1,
    });
    expect(handle).toHaveBeenCalledOnce();
  });

  it("persists runner events, broadcasts updates, and resolves RPC responses", async () => {
    const streamEvents: ServerEvent[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    const rpc = new RunnerRpcClient(hub);
    const service = new RunnerEventService(store, hub, rpc);
    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    store.createProject(projectRecord());
    const session = store.createSession(sessionRecord());

    service.handle({
      type: "assistantOutput",
      sessionId: session.id,
      outputId: "output-1",
      content: "partial",
      mode: "append",
      done: false,
      encrypted: false,
    });
    expect(store.listMessages(session.id)).toMatchObject([
      {
        role: "assistant",
        content: "partial",
        encrypted: false,
        streaming: true,
      },
    ]);
    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "message:created",
        message: expect.objectContaining({ content: "partial" }),
      }),
    );

    service.handle({
      type: "assistantOutput",
      sessionId: session.id,
      outputId: "output-1",
      content: " more",
      mode: "append",
      done: true,
      encrypted: false,
    });
    expect(store.listMessages(session.id)).toMatchObject([
      { role: "assistant", content: "partial more", encrypted: false },
    ]);
    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "message:updated",
        contentMode: "append",
        message: expect.objectContaining({ content: " more" }),
      }),
    );

    service.handle({
      type: "assistantOutput",
      sessionId: session.id,
      outputId: "output-2",
      content: "secret",
      mode: "replace",
      done: true,
      encrypted: true,
    });
    expect(store.listMessages(session.id).at(-1)).toMatchObject({
      role: "assistant",
      content: "secret",
      encrypted: true,
    });

    service.handle({
      type: "assistantOutput",
      sessionId: session.id,
      outputId: "output-2",
      mode: "replace",
      done: true,
      encrypted: true,
    });
    expect(store.listMessages(session.id).at(-1)).toMatchObject({
      role: "assistant",
      content: "secret",
      encrypted: true,
    });

    service.handle({
      type: "agentActivity",
      sessionId: session.id,
      agent: "claude-code",
      kind: "task_progress",
      label: "Reading apps/web/src/app/useRoamController.ts",
    });
    expect(store.listAgentActivities(session.id)).toMatchObject([
      {
        agent: "claude-code",
        kind: "task_progress",
        label: "Reading apps/web/src/app/useRoamController.ts",
      },
    ]);
    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "activity:created",
        activity: expect.objectContaining({
          label: "Reading apps/web/src/app/useRoamController.ts",
        }),
      }),
    );

    service.handle({
      type: "approvalRequested",
      approval: {
        id: "approval-1",
        sessionId: session.id,
        runnerId: "runner-1",
        kind: "execCommand",
        summary: "Run command",
        payload: { command: "pwd" },
        status: "pending",
        requestedAt: new Date().toISOString(),
      },
    });
    expect(store.getSession(session.id)?.status).toBe("waiting_approval");
    expect(store.listAgentActivities(session.id).at(-1)).toMatchObject({
      kind: "approval",
      label: "Waiting for approval",
    });
    expect(streamEvents).toContainEqual(
      expect.objectContaining({ type: "approval:requested" }),
    );

    const pending = rpc.requestRunner(
      "runner-1",
      {
        type: "readFileTree",
        requestId: "request-1",
        sessionId: session.id,
        path: ".",
        depth: 1,
      },
      100,
    );
    service.handle({
      type: "fileTreeResult",
      result: {
        requestId: "request-1",
        sessionId: session.id,
        root: { path: ".", name: ".", type: "directory", children: [] },
      },
    });
    await expect(pending).resolves.toMatchObject({ requestId: "request-1" });

    const failed = rpc.requestRunner(
      "runner-1",
      {
        type: "readFileTree",
        requestId: "request-2",
        sessionId: session.id,
        path: ".",
        depth: 1,
      },
      100,
    );
    service.handle({
      type: "error",
      requestId: "request-2",
      sessionId: session.id,
      message: "Session cwd is unavailable",
      code: "SESSION_NOT_FOUND",
    });
    await expect(failed).rejects.toBeInstanceOf(RunnerRpcError);
    await expect(failed).rejects.toMatchObject({
      code: "runner_error",
      runnerCode: "SESSION_NOT_FOUND",
    });
    expect(store.getSession(session.id)?.status).toBe("waiting_approval");

    const missingAttachment = rpc.requestRunner(
      "runner-1",
      {
        type: "readSessionAttachment",
        requestId: "request-attachment",
        sessionId: session.id,
        attachmentId: "attachment-1",
        runnerStoragePath: "attachments/session-1/attachment-1/screen.png",
        maxBytes: 1024,
      },
      100,
    );
    service.handle({
      type: "error",
      requestId: "request-attachment",
      sessionId: session.id,
      message: "ENOENT: no such file or directory",
      code: "ATTACHMENT_READ_ERROR",
    });
    await expect(missingAttachment).rejects.toMatchObject({
      code: "runner_error",
      runnerCode: "ATTACHMENT_READ_ERROR",
    });
    expect(store.getSession(session.id)?.status).toBe("waiting_approval");
    expect(streamEvents).not.toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "ENOENT: no such file or directory",
      }),
    );

    service.handle({
      type: "error",
      sessionId: session.id,
      message: "Session is not running",
      code: "SESSION_NOT_RUNNING",
    });
    expect(store.getSession(session.id)?.status).toBe("stopped");
    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "session:updated",
        session: expect.objectContaining({ id: session.id, status: "stopped" }),
      }),
    );
    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "error",
        sessionId: session.id,
        message: "Session is not running",
        code: "SESSION_NOT_RUNNING",
      }),
    );
  });

  it("timestamps output events monotonically in runner arrival order", () => {
    const hub = new ConnectionHub(store);
    const service = new RunnerEventService(
      store,
      hub,
      new RunnerRpcClient(hub),
    );
    store.createProject(projectRecord());
    const session = store.createSession(sessionRecord());

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T00:00:00.000Z"));
    try {
      service.handle({
        type: "agentActivity",
        sessionId: session.id,
        agent: "claude-code",
        kind: "task_progress",
        label: "Reading file.ts",
      });
      service.handle({
        type: "agentActivity",
        sessionId: session.id,
        agent: "claude-code",
        kind: "task_progress",
        label: "Running tests",
      });
      service.handle({
        type: "assistantOutput",
        sessionId: session.id,
        outputId: "output-1",
        content: "done",
        mode: "replace",
        done: true,
        encrypted: false,
      });
    } finally {
      vi.useRealTimers();
    }

    const activities = store.listAgentActivities(session.id);
    const [message] = store.listMessages(session.id);

    expect(activities.map((activity) => activity.createdAt)).toEqual([
      "2026-06-05T00:00:00.000Z",
      "2026-06-05T00:00:00.001Z",
    ]);
    expect(message?.createdAt).toBe("2026-06-05T00:00:00.002Z");
    expect(Date.parse(activities[1]?.createdAt ?? "")).toBeLessThan(
      Date.parse(message?.createdAt ?? ""),
    );
  });

  it("orders new assistant output after the latest session message", () => {
    const hub = new ConnectionHub(store);
    const service = new RunnerEventService(
      store,
      hub,
      new RunnerRpcClient(hub),
    );
    store.createProject(projectRecord());
    const session = store.createSession(sessionRecord());
    store.addMessage({
      id: "message-follow-up-user",
      sessionId: session.id,
      role: "user",
      content: "follow up",
      encrypted: false,
      createdAt: "2026-06-05T00:00:00.010Z",
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T00:00:00.000Z"));
    try {
      service.handle({
        type: "assistantOutput",
        sessionId: session.id,
        outputId: "follow-up-output",
        content: "follow up answer",
        mode: "replace",
        done: true,
        encrypted: false,
      });
    } finally {
      vi.useRealTimers();
    }

    const messages = store.listMessages(session.id);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "follow up"],
      ["assistant", "follow up answer"],
    ]);
    expect(Date.parse(messages[1]?.createdAt ?? "")).toBeGreaterThan(
      Date.parse(messages[0]?.createdAt ?? ""),
    );
  });

  it("does not let late approval events downgrade terminal sessions", () => {
    const streamEvents: ServerEvent[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    const rpc = new RunnerRpcClient(hub);
    const service = new RunnerEventService(store, hub, rpc);
    store.createProject(projectRecord());
    const session = store.createSession({
      ...sessionRecord(),
      status: "completed",
    });

    service.handle({
      type: "sessionStatus",
      sessionId: session.id,
      status: "waiting_approval",
    });
    service.handle({
      type: "sessionStatus",
      sessionId: session.id,
      status: "running",
    });

    expect(store.getSession(session.id)?.status).toBe("completed");

    service.handle({
      type: "approvalRequested",
      approval: {
        id: "approval-late",
        sessionId: session.id,
        runnerId: "runner-1",
        kind: "execCommand",
        summary: "Late approval",
        payload: { command: "pwd" },
        status: "pending",
        requestedAt: new Date().toISOString(),
      },
    });

    expect(store.getSession(session.id)?.status).toBe("completed");
    expect(store.getApproval("approval-late")).toBeUndefined();
    expect(streamEvents).not.toContainEqual(
      expect.objectContaining({ type: "approval:requested" }),
    );
    expect(streamEvents).not.toContainEqual(
      expect.objectContaining({
        type: "session:updated",
        session: expect.objectContaining({
          id: session.id,
          status: "waiting_approval",
        }),
      }),
    );

    service.handle({
      type: "agentActivity",
      sessionId: session.id,
      agent: "codex",
      kind: "status",
      label: "Late input",
      inputRequestId: "input-late",
    });
    expect(store.getPendingUserInputRequest(session.id)).toBeUndefined();
  });

  it("does not broadcast unscoped runner connection parse errors to users", () => {
    const streamEvents: ServerEvent[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    const service = new RunnerEventService(
      store,
      hub,
      new RunnerRpcClient(hub),
    );

    service.handle({
      type: "error",
      message: "Invalid discriminator value",
      code: "RUNNER_CONNECTION_ERROR",
    });

    expect(streamEvents).toEqual([]);
  });

  it("does not treat runner registered events as live socket registration", () => {
    const streamEvents: ServerEvent[] = [];
    const hub = new ConnectionHub(store);
    hub.addStream(fakeSocket(streamEvents));
    const service = new RunnerEventService(
      store,
      hub,
      new RunnerRpcClient(hub),
    );

    service.handle({ type: "registered", runner: runnerRegistration() });

    expect(store.listOnlineRunners()).toEqual([]);
    expect(streamEvents).toEqual([]);
  });
});

describe("ConnectionHub", () => {
  let dataDir: string;
  let store: ServerStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roamcli-hub-test-"));
    store = new ServerStore(dataDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("bootstraps stream clients from live runner sockets, not stale DB rows", () => {
    store.setRunnerOnline(runnerRegistration(), true, new Date().toISOString());
    const hub = new ConnectionHub(store);
    const streamEvents: ServerEvent[] = [];

    hub.addStream(fakeSocket(streamEvents));
    expect(streamEvents).toEqual([]);

    hub.registerRunner(runnerRegistration(), fakeSocket<RunnerCommand>([]));
    expect(streamEvents).toContainEqual(
      expect.objectContaining({ type: "runner:online" }),
    );
  });
});

function runnerRegistration(): RunnerRegistration {
  return {
    runnerId: "runner-1",
    displayName: "Test Runner",
    hostname: "localhost",
    workspaceRoot: "/workspace",
    profile: "standard",
    publicKey: "0123456789abcdef",
    version: "1.0.0",
    capabilities: [
      {
        kind: "codex",
        label: "Codex",
        command: "codex",
        args: [],
        parser: "codex",
        supportsResume: true,
      },
    ],
  };
}

function durableRunnerRegistration(): RunnerRegistration {
  const runner = runnerRegistration();
  return {
    ...runner,
    capabilities: runner.capabilities.map((capability) => ({
      ...capability,
      supportsDurableSessionStart: true,
    })),
  };
}

function imageRunnerRegistration(): RunnerRegistration {
  const runner = runnerRegistration();
  return {
    ...runner,
    capabilities: [
      {
        ...runner.capabilities[0]!,
        supportsImages: true,
        supportedImageMimeTypes: ["image/png"],
        maxImagesPerTurn: 2,
        maxImageBytes: 1024,
      },
    ],
  };
}

function claudeRunnerRegistration(): RunnerRegistration {
  const runner = runnerRegistration();
  return {
    ...runner,
    capabilities: [
      {
        ...runner.capabilities[0]!,
        kind: "claude-code",
        label: "Claude Code",
        command: "claude",
        parser: "claude-agent-sdk",
        supportsResume: true,
      },
    ],
  };
}

function imageUpload() {
  return {
    name: "screen.png",
    mimeType: "image/png",
    size: 5,
    contentBase64: "aGVsbG8=",
  };
}

function runnerAttachmentRef(sessionId: string) {
  return {
    id: "attachment-1",
    kind: "image",
    name: "screen.png",
    mimeType: "image/png",
    size: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    runnerStoragePath: `attachments/${sessionId}/attachment-1/screen.png`,
  } as const;
}

function pendingUserMessage(id: string, content: string, createdAt: string) {
  return {
    id,
    sessionId: "session-1",
    role: "user" as const,
    content,
    encrypted: false,
    createdAt,
  };
}

function storedAttachment(messageId: string, createdAt: string) {
  return {
    id: `attachment-${messageId}`,
    sessionId: "session-1",
    messageId,
    runnerId: "runner-1",
    kind: "image" as const,
    name: "screen.png",
    mimeType: "image/png",
    size: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    runnerStoragePath: `attachments/session-1/attachment-${messageId}/screen.png`,
    status: "available" as const,
    createdAt,
  };
}

function toRunnerAttachment(attachment: ReturnType<typeof storedAttachment>) {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    sha256: attachment.sha256,
    runnerStoragePath: attachment.runnerStoragePath,
  };
}

function addStoredAttachments(store: ServerStore, count: number): void {
  const createdAt = "2026-06-05T00:00:00.000Z";
  const messageId = "attachment-message";
  store.addMessage({
    id: messageId,
    sessionId: "session-1",
    role: "user",
    content: "attachments",
    encrypted: false,
    createdAt,
  });
  store.addMessageAttachments(
    Array.from({ length: count }, (_, index) => ({
      ...storedAttachment(messageId, createdAt),
      id: `attachment-${index + 1}`,
      runnerStoragePath: `attachments/session-1/attachment-${index + 1}/screen.png`,
    })),
  );
}

function stableTestInputDeliveryId(
  sessionId: string,
  requestId: string,
): string {
  return `input_${createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(requestId)
    .digest("hex")}`;
}

function projectRecord() {
  const now = new Date().toISOString();
  return {
    id: "project-1",
    name: "Project",
    runnerId: "runner-1",
    directory: "/workspace",
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  };
}

function sessionRecord(): Session {
  const now = new Date().toISOString();
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

function fakeSocket<T>(messages: T[], readyState = 1): WebSocket {
  return {
    OPEN: 1,
    readyState,
    send: vi.fn((data: string) => {
      messages.push(JSON.parse(data) as T);
    }),
    close: vi.fn(),
    once: vi.fn(),
  } as unknown as WebSocket;
}

function listFiles(rootDir: string): string[] {
  return fs
    .readdirSync(rootDir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => fs.statSync(path.join(rootDir, entry)).isFile());
}
