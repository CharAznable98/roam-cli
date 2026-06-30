import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it.each(["pending", "running", "waiting_approval"] as const)(
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

  it.each(["pending", "running", "waiting_approval"] as const)(
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
        status: "failed",
        errorCode: "runner_timeout",
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

  it.each(["pending", "running", "waiting_approval"] satisfies SessionStatus[])(
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

  it("archives worktree sessions when a legacy runner reports remove worktree success", async () => {
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
    expect(store.getApproval("approval-late")).toMatchObject({
      id: "approval-late",
      status: "pending",
    });
    expect(streamEvents).toContainEqual(
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
    sha256: "0123456789abcdef0123456789abcdef",
    runnerStoragePath: `attachments/${sessionId}/attachment-1/screen.png`,
  } as const;
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
