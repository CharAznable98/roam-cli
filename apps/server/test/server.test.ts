import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_IMAGE_BYTES_PER_TURN,
  type RunnerRegistration,
  type Session,
} from "@roamcli/shared/protocol";
import { hashPayload } from "@roamcli/shared/security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createServer, type RoamServer } from "../src/app.js";

const TEST_ORIGIN = "http://127.0.0.1";
const OWNER_PASSWORD = "test-password-123";

let authCookie = "";
let runnerToken = "";

describe("server", () => {
  let dataDir: string;
  let app: RoamServer;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roamcli-server-"));
    app = await createServer({
      dataDir,
      publicOrigin: TEST_ORIGIN,
      webDistDir: false,
      runnerRpcTimeoutMs: 50,
    });
    const originalInject = app.inject.bind(app);
    const setup = await originalInject({
      method: "POST",
      url: "/v1/auth/setup",
      headers: { origin: TEST_ORIGIN },
      payload: {
        setupToken: readSetupToken(dataDir),
        password: OWNER_PASSWORD,
      },
    });
    expect(setup.statusCode).toBe(201);
    authCookie = extractCookie(setup.headers["set-cookie"]);
    runnerToken = setup.json().account.runnerToken as string;
    app.inject = ((options: any, ...args: any[]) => {
      if (shouldAttachAuth(options)) {
        return originalInject(
          {
            ...options,
            headers: {
              ...options.headers,
              cookie: authCookie,
              origin: TEST_ORIGIN,
            },
          },
          ...args,
        );
      }
      return originalInject(options, ...args);
    }) as typeof app.inject;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("serves public install metadata for runner command generation", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/install/metadata",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      install: {
        runnerPackageName: "@roamcli/runner",
        runnerPackageSpec: "@roamcli/runner@1.1.0",
        officialAgentPlugins: [
          {
            packageName: "@roamcli/agent-codex",
            packageSpec: "@roamcli/agent-codex@1.1.0",
            label: "Codex",
            description: "Runs sessions through the Codex app-server agent.",
          },
          {
            packageName: "@roamcli/agent-claude-code",
            packageSpec: "@roamcli/agent-claude-code@1.1.0",
            label: "Claude Code",
            description: "Runs sessions through the Claude Code agent.",
          },
        ],
      },
    });
  });

  it("requires an owner session and lists persisted sessions", async () => {
    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/sessions",
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ sessions: [] });
  });

  it("requires request ids and rehydrates a queued running-session message from session detail", async () => {
    createTestProject(app);
    const now = new Date().toISOString();
    app.roam.store.createSession({
      id: "session-queued-message",
      title: "Queued message",
      projectId: "project-1",
      runnerId: "runner-1",
      agent: "codex",
      status: "running",
      executionMode: "direct",
      executionFolder: "/workspace",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
    });

    const missingSessionRequestId = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        projectId: "project-1",
        agent: "codex",
        prompt: "missing request id",
      },
    });
    expect(missingSessionRequestId.statusCode).toBe(400);

    const missingMessageRequestId = await app.inject({
      method: "POST",
      url: "/v1/sessions/session-queued-message/messages",
      headers: { "x-test-auth": "1" },
      payload: { content: "missing request id" },
    });
    expect(missingMessageRequestId.statusCode).toBe(400);

    const queued = await app.inject({
      method: "POST",
      url: "/v1/sessions/session-queued-message/messages",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "queued-message-request",
        content: "deliver after reconnect",
      },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ queued: true });
    const messageId = queued.json().message.id as string;

    const detail = await app.inject({
      method: "GET",
      url: "/v1/sessions/session-queued-message",
      headers: { "x-test-auth": "1" },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages).toEqual([]);
    expect(detail.json().attachments).toEqual([]);
    expect(detail.json().pendingMessageDeliveries).toEqual([
      {
        messageId,
        content: "deliver after reconnect",
        createdAt: expect.any(String),
        attachments: [],
      },
    ]);

    const queuedSession = app.roam.store.getSession("session-queued-message")!;
    const promotedAt = new Date().toISOString();
    app.roam.store.promotePendingInputDeliveryToStart(
      messageId,
      {
        type: "startSession",
        requestId: "promoted-start-request",
        deliveryId: messageId,
        session: {
          ...queuedSession,
          status: "pending",
          updatedAt: promotedAt,
        },
        prompt: "deliver after reconnect",
        attachments: [],
      },
      promotedAt,
    );
    const promotedDetail = await app.inject({
      method: "GET",
      url: "/v1/sessions/session-queued-message",
      headers: { "x-test-auth": "1" },
    });
    expect(promotedDetail.statusCode).toBe(200);
    expect(promotedDetail.json().messages).toEqual([]);
    expect(promotedDetail.json().pendingMessageDeliveries).toEqual([
      {
        messageId,
        content: "deliver after reconnect",
        createdAt: expect.any(String),
        attachments: [],
      },
    ]);

    expect(
      app.roam.store.finalizePendingInputDelivery(messageId),
    ).toBeDefined();
    const finalizedDetail = await app.inject({
      method: "GET",
      url: "/v1/sessions/session-queued-message",
      headers: { "x-test-auth": "1" },
    });
    expect(finalizedDetail.json().messages).toEqual([
      expect.objectContaining({
        id: messageId,
        content: "deliver after reconnect",
      }),
    ]);
    expect(finalizedDetail.json().pendingMessageDeliveries).toEqual([]);
  });

  it("keeps login rate limits scoped to the failing source", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: { origin: TEST_ORIGIN },
        remoteAddress: "203.0.113.10",
        payload: { password: "wrong-password" },
      } as any);
      expect(response.statusCode).toBe(401);
    }

    const sameSource = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { origin: TEST_ORIGIN },
      remoteAddress: "203.0.113.10",
      payload: { password: OWNER_PASSWORD },
    } as any);
    expect(sameSource.statusCode).toBe(429);

    const otherSource = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { origin: TEST_ORIGIN },
      remoteAddress: "203.0.113.20",
      payload: { password: OWNER_PASSWORD },
    } as any);
    expect(otherSource.statusCode).toBe(200);
  });

  it("uses forwarded client IPs from trusted proxies for login rate limits", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: {
          origin: TEST_ORIGIN,
          "x-forwarded-for": "198.51.100.10",
        },
        remoteAddress: "127.0.0.1",
        payload: { password: "wrong-password" },
      } as any);
      expect(response.statusCode).toBe(401);
    }

    const sameForwardedSource = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: {
        origin: TEST_ORIGIN,
        "x-forwarded-for": "198.51.100.10",
      },
      remoteAddress: "127.0.0.1",
      payload: { password: OWNER_PASSWORD },
    } as any);
    expect(sameForwardedSource.statusCode).toBe(429);

    const otherForwardedSource = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: {
        origin: TEST_ORIGIN,
        "x-forwarded-for": "198.51.100.20",
      },
      remoteAddress: "127.0.0.1",
      payload: { password: OWNER_PASSWORD },
    } as any);
    expect(otherForwardedSource.statusCode).toBe(200);
  });

  it("ignores forwarded client IPs from untrusted direct sources for login rate limits", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: {
          origin: TEST_ORIGIN,
          "x-forwarded-for": `198.51.100.${attempt + 10}`,
        },
        remoteAddress: "203.0.113.30",
        payload: { password: "wrong-password" },
      } as any);
      expect(response.statusCode).toBe(401);
    }

    const sameRemoteAddress = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: {
        origin: TEST_ORIGIN,
        "x-forwarded-for": "198.51.100.99",
      },
      remoteAddress: "203.0.113.30",
      payload: { password: OWNER_PASSWORD },
    } as any);
    expect(sameRemoteAddress.statusCode).toBe(429);
  });

  it("ignores forwarded client IPs from unconfigured private sources for login rate limits", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: {
          origin: TEST_ORIGIN,
          "x-forwarded-for": `198.51.100.${attempt + 30}`,
        },
        remoteAddress: "172.17.0.1",
        payload: { password: "wrong-password" },
      } as any);
      expect(response.statusCode).toBe(401);
    }

    const samePrivateRemote = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: {
        origin: TEST_ORIGIN,
        "x-forwarded-for": "198.51.100.199",
      },
      remoteAddress: "172.17.0.1",
      payload: { password: OWNER_PASSWORD },
    } as any);
    expect(samePrivateRemote.statusCode).toBe(429);
  });

  it("keeps setup rate limits scoped to the failing source", async () => {
    const setupDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roamcli-server-setup-rate-"),
    );
    const setupApp = await createServer({
      dataDir: setupDataDir,
      publicOrigin: TEST_ORIGIN,
      webDistDir: false,
      runnerRpcTimeoutMs: 50,
    });
    try {
      const setupToken = readSetupToken(setupDataDir);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await setupApp.inject({
          method: "POST",
          url: "/v1/auth/setup",
          headers: { origin: TEST_ORIGIN },
          remoteAddress: "203.0.113.10",
          payload: {
            setupToken: "wrong-token",
            password: OWNER_PASSWORD,
          },
        } as any);
        expect(response.statusCode).toBe(401);
      }

      const sameSource = await setupApp.inject({
        method: "POST",
        url: "/v1/auth/setup",
        headers: { origin: TEST_ORIGIN },
        remoteAddress: "203.0.113.10",
        payload: {
          setupToken,
          password: OWNER_PASSWORD,
        },
      } as any);
      expect(sameSource.statusCode).toBe(429);

      const otherSource = await setupApp.inject({
        method: "POST",
        url: "/v1/auth/setup",
        headers: { origin: TEST_ORIGIN },
        remoteAddress: "203.0.113.20",
        payload: {
          setupToken,
          password: OWNER_PASSWORD,
        },
      } as any);
      expect(otherSource.statusCode).toBe(201);
    } finally {
      await setupApp.close();
      fs.rmSync(setupDataDir, { recursive: true, force: true });
    }
  });

  it("uses forwarded client IPs from trusted proxies for setup rate limits", async () => {
    const setupDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roamcli-server-setup-forwarded-rate-"),
    );
    const setupApp = await createServer({
      dataDir: setupDataDir,
      publicOrigin: TEST_ORIGIN,
      webDistDir: false,
      runnerRpcTimeoutMs: 50,
    });
    try {
      const setupToken = readSetupToken(setupDataDir);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await setupApp.inject({
          method: "POST",
          url: "/v1/auth/setup",
          headers: {
            origin: TEST_ORIGIN,
            "x-forwarded-for": "198.51.100.10",
          },
          remoteAddress: "127.0.0.1",
          payload: {
            setupToken: "wrong-token",
            password: OWNER_PASSWORD,
          },
        } as any);
        expect(response.statusCode).toBe(401);
      }

      const sameForwardedSource = await setupApp.inject({
        method: "POST",
        url: "/v1/auth/setup",
        headers: {
          origin: TEST_ORIGIN,
          "x-forwarded-for": "198.51.100.10",
        },
        remoteAddress: "127.0.0.1",
        payload: {
          setupToken,
          password: OWNER_PASSWORD,
        },
      } as any);
      expect(sameForwardedSource.statusCode).toBe(429);

      const otherForwardedSource = await setupApp.inject({
        method: "POST",
        url: "/v1/auth/setup",
        headers: {
          origin: TEST_ORIGIN,
          "x-forwarded-for": "198.51.100.20",
        },
        remoteAddress: "127.0.0.1",
        payload: {
          setupToken,
          password: OWNER_PASSWORD,
        },
      } as any);
      expect(otherForwardedSource.statusCode).toBe(201);
    } finally {
      await setupApp.close();
      fs.rmSync(setupDataDir, { recursive: true, force: true });
    }
  });

  it("allows the default Vite dev proxy origin for setup and owner streams", async () => {
    const devDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roamcli-server-dev-origin-"),
    );
    const devApp = await createServer({
      dataDir: devDataDir,
      webDistDir: false,
      runnerRpcTimeoutMs: 50,
    });
    try {
      const setup = await devApp.inject({
        method: "POST",
        url: "/v1/auth/setup",
        headers: {
          host: "127.0.0.1:8787",
          origin: "http://localhost:5173",
        },
        payload: {
          setupToken: readSetupToken(devDataDir),
          password: OWNER_PASSWORD,
        },
      });
      expect(setup.statusCode).toBe(201);

      await devApp.listen({ host: "127.0.0.1", port: 0 });
      const stream = await openSocket(`${localBaseUrl(devApp)}/v1/stream`, {
        origin: "http://localhost:5173",
        streamCookie: extractCookie(setup.headers["set-cookie"]),
      });
      let closed = false;
      stream.once("close", () => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(closed).toBe(false);
      stream.close();

      await expect(
        openSocketAndWaitForClose(`${localBaseUrl(devApp)}/v1/stream`, {
          origin: "http://127.0.0.1:5174",
          streamCookie: extractCookie(setup.headers["set-cookie"]),
        }),
      ).resolves.toEqual({ code: 1008, reason: "invalid origin" });
    } finally {
      await devApp.close();
      fs.rmSync(devDataDir, { recursive: true, force: true });
    }
  });

  it("does not list persisted online runners without live hub sockets", async () => {
    app.roam.store.setRunnerOnline(
      runnerRegistration(),
      true,
      new Date().toISOString(),
    );

    const response = await app.inject({
      method: "GET",
      url: "/v1/runners",
      headers: { "x-test-auth": "1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runners: [] });
  });

  it("automatically replays persisted attachment cleanup jobs when a runner reconnects after restart", async () => {
    createTestProject(app);
    const createdAt = "2026-06-05T00:00:00.000Z";
    app.roam.store.createSession({
      id: "cleanup-replay-session",
      title: "Cleanup replay",
      projectId: "project-1",
      runnerId: "runner-1",
      agent: "codex",
      status: "running",
      executionMode: "direct",
      executionFolder: "/workspace",
      cwd: "/workspace",
      createdAt,
      updatedAt: createdAt,
    });
    app.roam.store.putPendingInputDelivery({
      deliveryId: "cleanup-replay-message",
      kind: "input",
      runnerId: "runner-1",
      sessionId: "cleanup-replay-session",
      message: {
        id: "cleanup-replay-message",
        sessionId: "cleanup-replay-session",
        role: "user",
        content: "never materialize",
        encrypted: false,
        createdAt,
      },
      attachments: [
        {
          id: "cleanup-replay-attachment",
          sessionId: "cleanup-replay-session",
          messageId: "cleanup-replay-message",
          runnerId: "runner-1",
          kind: "image",
          name: "screen.png",
          mimeType: "image/png",
          size: 5,
          sha256:
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          runnerStoragePath:
            "attachments/cleanup-replay-session/cleanup-replay-attachment/screen.png",
          status: "available",
          createdAt,
        },
      ],
      createdAt,
    });
    app.roam.store.archiveProject("project-1", new Date().toISOString());
    expect(app.roam.store.listAttachmentCleanupJobs("project-1")).toHaveLength(
      1,
    );

    await app.close();
    app = await createServer({
      dataDir,
      publicOrigin: TEST_ORIGIN,
      webDistDir: false,
      runnerRpcTimeoutMs: 50,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const runner = await openSocket(`${localBaseUrl(app)}/v1/runner`);
    const cleanupCommand = nextJson(runner);
    runner.send(JSON.stringify(runnerRegistration()));
    await expect(cleanupCommand).resolves.toMatchObject({
      type: "deleteSessionAttachments",
      sessionId: "cleanup-replay-session",
      attachments: [
        {
          id: "cleanup-replay-attachment",
          runnerStoragePath:
            "attachments/cleanup-replay-session/cleanup-replay-attachment/screen.png",
        },
      ],
    });
    const command = await cleanupCommand;
    runner.send(
      JSON.stringify({
        type: "attachmentDeleteResult",
        result: {
          requestId: command.requestId,
          sessionId: "cleanup-replay-session",
          deleted: ["cleanup-replay-attachment"],
          failed: [],
        },
      }),
    );
    await waitUntil(
      () => app.roam.store.listAttachmentCleanupJobs("project-1").length === 0,
    );
    expect(app.roam.store.listMessages("cleanup-replay-session")).toEqual([]);
    runner.close();
  });

  it("ignores invalid runner events without sending incompatible commands", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`);
    const runnerMessages: Array<Record<string, any>> = [];
    runner.on("message", (data) => {
      runnerMessages.push(JSON.parse(String(data)) as Record<string, any>);
    });

    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));
    runner.send(JSON.stringify({ type: "notARunnerEvent" }));

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runner.readyState).toBe(WebSocket.OPEN);
    expect(app.roam.hub.isRunnerOnline("runner-1")).toBe(true);
    expect(runnerMessages).toEqual([]);

    runner.close();
  });

  it("negotiates durable runner events and ACKs each sequence exactly once", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const runner = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const streamId = "11111111-1111-4111-8111-111111111111";
    const resume = nextJson(runner);
    runner.send(JSON.stringify(ackRunnerAuthentication(streamId)));
    await expect(resume).resolves.toEqual({
      type: "runnerEventResume",
      protocol: "ack_v1",
      streamId,
      ackThrough: 0,
    });
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    createTestProject(app);
    const now = new Date().toISOString();
    app.roam.store.createSession({
      id: "ack-session",
      title: "ACK Session",
      projectId: "project-1",
      runnerId: "runner-1",
      agent: "codex",
      status: "running",
      executionMode: "direct",
      executionFolder: "/workspace",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
    });
    const handle = vi.spyOn(app.roam.services.runnerEvents, "handle");
    const event = {
      type: "assistantOutput",
      sessionId: "ack-session",
      outputId: "ack-output",
      content: "exactly once",
      mode: "append",
      done: true,
      encrypted: false,
    };
    const firstAck = nextJson(runner);
    runner.send(JSON.stringify(ackRunnerEvent(streamId, 1, event)));
    await expect(firstAck).resolves.toEqual({
      type: "runnerEventAck",
      protocol: "ack_v1",
      streamId,
      ackThrough: 1,
    });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(app.roam.store.listMessages("ack-session")).toMatchObject([
      { content: "exactly once" },
    ]);

    const duplicateAck = nextJson(runner);
    runner.send(JSON.stringify(ackRunnerEvent(streamId, 1, event)));
    await expect(duplicateAck).resolves.toEqual({
      type: "runnerEventAck",
      protocol: "ack_v1",
      streamId,
      ackThrough: 1,
    });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(app.roam.store.listMessages("ack-session")).toMatchObject([
      { content: "exactly once" },
    ]);

    const gap = nextJson(runner);
    runner.send(JSON.stringify(ackRunnerEvent(streamId, 3, event)));
    await expect(gap).resolves.toEqual({
      type: "runnerEventNack",
      protocol: "ack_v1",
      streamId,
      ackThrough: 1,
      expectedSequence: 2,
    });
    expect(handle).toHaveBeenCalledTimes(1);

    const secondAck = nextJson(runner);
    runner.send(
      JSON.stringify(
        ackRunnerEvent(streamId, 2, {
          type: "registered",
          runner: runnerRegistration(),
        }),
      ),
    );
    await expect(secondAck).resolves.toEqual({
      type: "runnerEventAck",
      protocol: "ack_v1",
      streamId,
      ackThrough: 2,
    });
    expect(handle).toHaveBeenCalledTimes(2);

    runner.close();
  });

  it("persists runner event high-water state across reconnects and restarts", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const streamId = "22222222-2222-4222-8222-222222222222";
    const runner = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const resume = nextJson(runner);
    runner.send(JSON.stringify(ackRunnerAuthentication(streamId)));
    await expect(resume).resolves.toMatchObject({
      type: "runnerEventResume",
      streamId,
      ackThrough: 0,
    });
    const ack = nextJson(runner);
    runner.send(
      JSON.stringify(
        ackRunnerEvent(streamId, 1, {
          type: "registered",
          runner: runnerRegistration(),
        }),
      ),
    );
    await expect(ack).resolves.toMatchObject({
      type: "runnerEventAck",
      streamId,
      ackThrough: 1,
    });

    await app.close();
    app = await createServer({
      dataDir,
      publicOrigin: TEST_ORIGIN,
      webDistDir: false,
      runnerRpcTimeoutMs: 50,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const reconnected = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const persistedResume = nextJson(reconnected);
    reconnected.send(JSON.stringify(ackRunnerAuthentication(streamId, 0)));
    await expect(persistedResume).resolves.toMatchObject({
      type: "runnerEventResume",
      streamId,
      ackThrough: 1,
    });

    const duplicateAck = nextJson(reconnected);
    reconnected.send(
      JSON.stringify(
        ackRunnerEvent(streamId, 1, {
          type: "registered",
          runner: runnerRegistration(),
        }),
      ),
    );
    await expect(duplicateAck).resolves.toMatchObject({
      type: "runnerEventAck",
      streamId,
      ackThrough: 1,
    });

    reconnected.close();
  });

  it("commits a replayed terminal Git job result after a server restart", async () => {
    createTestProject(app);
    const now = new Date().toISOString();
    app.roam.store.upsertGitJob({
      id: "git-replayed-after-restart",
      projectId: "project-1",
      contextKind: "project",
      operation: "stage",
      status: "running",
      createdAt: now,
      startedAt: now,
    });

    await app.close();
    app = await createServer({
      dataDir,
      publicOrigin: TEST_ORIGIN,
      webDistDir: false,
      runnerRpcTimeoutMs: 50,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const runner = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const streamId = "77777777-7777-4777-8777-777777777777";
    const resume = nextJson(runner);
    runner.send(JSON.stringify(ackRunnerAuthentication(streamId)));
    await expect(resume).resolves.toMatchObject({
      type: "runnerEventResume",
      streamId,
      ackThrough: 0,
    });

    const finishedAt = new Date().toISOString();
    const ack = nextJson(runner);
    runner.send(
      JSON.stringify(
        ackRunnerEvent(streamId, 1, {
          type: "gitJobResult",
          job: {
            id: "git-replayed-after-restart",
            projectId: "project-1",
            contextKind: "project",
            operation: "stage",
            status: "succeeded",
            createdAt: now,
            startedAt: now,
            finishedAt,
          },
        }),
      ),
    );
    await expect(ack).resolves.toMatchObject({
      type: "runnerEventAck",
      streamId,
      ackThrough: 1,
    });
    expect(app.roam.store.listGitJobs("project-1")).toContainEqual(
      expect.objectContaining({
        id: "git-replayed-after-restart",
        operation: "stage",
        status: "succeeded",
        finishedAt,
      }),
    );

    runner.close();
  });

  it("defers Git result side effects until the durable event transaction commits", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const runner = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const runnerMessages: Array<Record<string, any>> = [];
    runner.on("message", (data) => {
      runnerMessages.push(JSON.parse(String(data)) as Record<string, any>);
    });
    const streamId = "88888888-8888-4888-8888-888888888888";
    const resume = nextJson(runner);
    runner.send(JSON.stringify(ackRunnerAuthentication(streamId)));
    await expect(resume).resolves.toMatchObject({
      type: "runnerEventResume",
      streamId,
      ackThrough: 0,
    });
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));
    createTestProject(app);

    const stageResponse = await app.inject({
      method: "POST",
      url: "/v1/git/stage",
      headers: { "x-test-auth": "1" },
      payload: {
        context: { kind: "project", projectId: "project-1" },
        paths: ["README.md"],
      },
    });
    expect(stageResponse.statusCode).toBe(200);
    await waitUntil(() =>
      runnerMessages.some((message) => message.type === "gitStagePaths"),
    );
    const stageCommand = runnerMessages.find(
      (message) => message.type === "gitStagePaths",
    );
    expect(stageCommand).toBeDefined();

    const discardResponse = await app.inject({
      method: "POST",
      url: "/v1/git/discard",
      headers: { "x-test-auth": "1" },
      payload: {
        context: { kind: "project", projectId: "project-1" },
        paths: ["README.md"],
      },
    });
    expect(discardResponse.statusCode).toBe(200);
    expect(
      runnerMessages.some((message) => message.type === "gitDiscardPaths"),
    ).toBe(false);

    const broadcast = vi.spyOn(app.roam.hub, "broadcast");
    broadcast.mockClear();
    const rollbackInjector = new DatabaseSync(app.roam.store.dbPath);
    rollbackInjector.exec(`
      CREATE TRIGGER fail_runner_event_high_water
      BEFORE UPDATE OF committed_through ON runner_event_streams
      BEGIN
        SELECT RAISE(ABORT, 'injected runner event commit failure');
      END;
    `);

    const failedClose = nextClose(runner);
    const finishedAt = new Date().toISOString();
    runner.send(
      JSON.stringify(
        ackRunnerEvent(streamId, 1, {
          type: "gitJobResult",
          job: {
            id: stageCommand?.requestId,
            projectId: "project-1",
            contextKind: "project",
            operation: "stage",
            status: "succeeded",
            createdAt: finishedAt,
            startedAt: finishedAt,
            finishedAt,
          },
        }),
      ),
    );
    await expect(failedClose).resolves.toEqual({
      code: 1011,
      reason: "runner event handler failed",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      app.roam.store.getGitJob(String(stageCommand?.requestId)),
    ).toMatchObject({ status: "running" });
    expect(
      broadcast.mock.calls.some(
        ([event]) =>
          event.type === "git:job" &&
          event.job.id === stageCommand?.requestId &&
          event.job.status === "succeeded",
      ),
    ).toBe(false);
    expect(
      runnerMessages.some((message) => message.type === "gitDiscardPaths"),
    ).toBe(false);

    rollbackInjector.exec("DROP TRIGGER fail_runner_event_high_water");
    rollbackInjector.close();
    const reconnected = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const reconnectedMessages: Array<Record<string, any>> = [];
    reconnected.on("message", (data) => {
      reconnectedMessages.push(JSON.parse(String(data)) as Record<string, any>);
    });
    const replayResume = nextJson(reconnected);
    reconnected.send(JSON.stringify(ackRunnerAuthentication(streamId)));
    await expect(replayResume).resolves.toMatchObject({
      type: "runnerEventResume",
      streamId,
      ackThrough: 0,
    });
    const replayAck = nextJson(reconnected);
    broadcast.mockImplementationOnce(() => {
      throw new Error("injected post-commit broadcast failure");
    });
    reconnected.send(
      JSON.stringify(
        ackRunnerEvent(streamId, 1, {
          type: "gitJobResult",
          job: {
            id: stageCommand?.requestId,
            projectId: "project-1",
            contextKind: "project",
            operation: "stage",
            status: "succeeded",
            createdAt: finishedAt,
            startedAt: finishedAt,
            finishedAt,
          },
        }),
      ),
    );
    await expect(replayAck).resolves.toMatchObject({
      type: "runnerEventAck",
      streamId,
      ackThrough: 1,
    });
    await waitUntil(() =>
      reconnectedMessages.some((message) => message.type === "gitDiscardPaths"),
    );
    expect(
      app.roam.store.getGitJob(String(stageCommand?.requestId)),
    ).toMatchObject({ status: "succeeded", finishedAt });
    expect(
      broadcast.mock.calls.some(
        ([event]) =>
          event.type === "git:job" &&
          event.job.id === stageCommand?.requestId &&
          event.job.status === "succeeded",
      ),
    ).toBe(true);

    reconnected.close();
  });

  it("rolls back failed runner events without ACKing and rejects unsafe stream state", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const streamId = "33333333-3333-4333-8333-333333333333";
    const runner = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const resume = nextJson(runner);
    runner.send(JSON.stringify(ackRunnerAuthentication(streamId)));
    await expect(resume).resolves.toMatchObject({
      type: "runnerEventResume",
      streamId,
      ackThrough: 0,
    });

    vi.spyOn(app.roam.services.runnerEvents, "handle").mockImplementationOnce(
      () => {
        throw new Error("injected handler failure");
      },
    );
    const failedClose = nextClose(runner);
    runner.send(
      JSON.stringify(
        ackRunnerEvent(streamId, 1, {
          type: "registered",
          runner: runnerRegistration(),
        }),
      ),
    );
    await expect(failedClose).resolves.toEqual({
      code: 1011,
      reason: "runner event handler failed",
    });

    const retry = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const retryResume = nextJson(retry);
    retry.send(JSON.stringify(ackRunnerAuthentication(streamId)));
    await expect(retryResume).resolves.toMatchObject({
      type: "runnerEventResume",
      streamId,
      ackThrough: 0,
    });

    const retryAck = nextJson(retry);
    retry.send(
      JSON.stringify(
        ackRunnerEvent(streamId, 1, {
          type: "registered",
          runner: runnerRegistration(),
        }),
      ),
    );
    await expect(retryAck).resolves.toMatchObject({
      type: "runnerEventAck",
      streamId,
      ackThrough: 1,
    });

    const mismatchedClose = nextClose(retry);
    retry.send(
      JSON.stringify(
        ackRunnerEvent("44444444-4444-4444-8444-444444444444", 1, {
          type: "registered",
          runner: runnerRegistration(),
        }),
      ),
    );
    await expect(mismatchedClose).resolves.toEqual({
      code: 1008,
      reason: "runner event stream mismatch",
    });

    const ahead = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const aheadClose = nextClose(ahead);
    ahead.send(JSON.stringify(ackRunnerAuthentication(streamId, 2)));
    await expect(aheadClose).resolves.toEqual({
      code: 1008,
      reason: "runner event stream mismatch",
    });

    const rotatedStreamId = "55555555-5555-4555-8555-555555555555";
    const rotated = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const rotatedResume = nextJson(rotated);
    rotated.send(JSON.stringify(ackRunnerAuthentication(rotatedStreamId)));
    await expect(rotatedResume).resolves.toMatchObject({
      type: "runnerEventResume",
      streamId: rotatedStreamId,
      ackThrough: 0,
    });

    const rotatedAck = nextJson(rotated);
    rotated.send(
      JSON.stringify(
        ackRunnerEvent(rotatedStreamId, 1, {
          type: "registered",
          runner: runnerRegistration(),
        }),
      ),
    );
    await expect(rotatedAck).resolves.toMatchObject({
      type: "runnerEventAck",
      streamId: rotatedStreamId,
      ackThrough: 1,
    });

    const rotatedClose = nextClose(rotated);
    rotated.close();
    await rotatedClose;
    const originalAgain = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const originalResume = nextJson(originalAgain);
    originalAgain.send(JSON.stringify(ackRunnerAuthentication(streamId, 1)));
    await expect(originalResume).resolves.toMatchObject({
      type: "runnerEventResume",
      streamId,
      ackThrough: 1,
    });

    originalAgain.close();
  });

  it("checks the runner token before parsing runner registration", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const runner = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const closed = nextClose(runner);

    runner.send(
      JSON.stringify({
        type: "runnerAuthenticate",
        token: "wrong-runner-token",
        runner: {},
      }),
    );

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "unauthorized",
    });
    expect(app.roam.hub.isRunnerOnline("runner-1")).toBe(false);
  });

  it("caps unauthenticated runner auth frames before parsing", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const runner = await openSocket(`${localBaseUrl(app)}/v1/runner`, {
      authenticateRunner: false,
    });
    const closed = nextClose(runner);

    runner.send("x".repeat(64 * 1024 + 1));

    await expect(closed).resolves.toEqual({
      code: 1009,
      reason: "runner authentication payload too large",
    });
  });

  it("closes owner streams before broadcasting after their auth session is gone", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const stream = await openSocket(`${localBaseUrl(app)}/v1/stream`);
    const closed = nextClose(stream);

    app.roam.store.deleteAuthSession(currentAuthSessionId(app));
    app.roam.hub.broadcast({ type: "runner:offline", runnerId: "runner-1" });

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "session expired",
    });
  });

  it("rejects client stream commands after their auth session is gone", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    expect(await nextJson(stream)).toMatchObject({ type: "runner:online" });
    createTestProject(app);

    const closed = nextClose(stream);
    app.roam.store.deleteAuthSession(currentAuthSessionId(app));
    stream.send(
      JSON.stringify({
        type: "createSession",
        requestId: "expired-stream-create",
        projectId: "project-1",
        agent: "codex",
        executionMode: "direct",
        prompt: "should not start",
      }),
    );

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "session expired",
    });
    expect(app.roam.store.listSessions()).toEqual([]);

    runner.close();
  });

  it("creates projects only after validating the runner directory", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    expect(await nextJson(stream)).toMatchObject({ type: "runner:online" });
    const streamEvents: Array<Record<string, any>> = [];
    stream.on("message", (data) => {
      streamEvents.push(JSON.parse(String(data)) as Record<string, any>);
    });

    const createdPromise = app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { "x-test-auth": "1" },
      payload: {
        name: "API Project",
        runnerId: "runner-1",
        directory: "/workspace/api-project",
      },
    });
    const validationCommand = await nextJson(runner);
    expect(validationCommand).toMatchObject({
      type: "readFileTree",
      cwd: "/workspace/api-project",
      path: ".",
      depth: 0,
    });
    runner.send(
      JSON.stringify({
        type: "fileTreeResult",
        result: {
          requestId: validationCommand.requestId,
          sessionId: validationCommand.sessionId,
          root: {
            path: ".",
            name: "api-project",
            type: "directory",
            children: [],
          },
        },
      }),
    );

    const created = await createdPromise;
    expect(created.statusCode).toBe(201);
    expect(created.json().project).toMatchObject({
      name: "API Project",
      runnerId: "runner-1",
      directory: "/workspace/api-project",
    });
    await vi.waitFor(() => {
      expect(streamEvents).toContainEqual(
        expect.objectContaining({
          type: "project:created",
          project: expect.objectContaining({ name: "API Project" }),
        }),
      );
    });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { "x-test-auth": "1" },
    });
    expect(listed.json().projects).toHaveLength(1);

    stream.close();
    runner.close();
  });

  it("returns invalid cwd errors from project directory validation", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    const createdPromise = app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { "x-test-auth": "1" },
      payload: {
        name: "Outside Project",
        runnerId: "runner-1",
        directory: "/outside/project",
      },
    });
    const validationCommand = await nextJson(runner);
    runner.send(
      JSON.stringify({
        type: "error",
        requestId: validationCommand.requestId,
        sessionId: validationCommand.sessionId,
        message: "Path escapes workspace: /outside/project",
        code: "INVALID_CWD",
      }),
    );

    const created = await createdPromise;
    expect(created.statusCode).toBe(400);
    expect(created.json()).toEqual({
      error: "runner_error",
      code: "INVALID_CWD",
      message: "Path escapes workspace: /outside/project",
    });
    expect(app.roam.store.listProjects()).toEqual([]);

    runner.close();
  });

  it("rejects duplicate active projects for the same runner directory", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`);
    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));
    createTestProject(app);

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { "x-test-auth": "1" },
      payload: {
        name: "Duplicate Project",
        runnerId: "runner-1",
        directory: "/workspace",
      },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "project_already_exists" });
    expect(app.roam.store.listProjects()).toHaveLength(1);

    runner.close();
  });

  it("manages project prompt presets without requiring an online runner", async () => {
    createTestProject(app);

    const first = await app.inject({
      method: "POST",
      url: "/v1/projects/project-1/prompt-presets",
      headers: { "x-test-auth": "1" },
      payload: {
        title: "  First preset  ",
        content: "  Preserve\nformatting  ",
      },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().preset).toMatchObject({
      projectId: "project-1",
      title: "First preset",
      content: "Preserve\nformatting",
      order: 0,
    });

    const second = await app.inject({
      method: "POST",
      url: "/v1/projects/project-1/prompt-presets",
      headers: { "x-test-auth": "1" },
      payload: {
        title: "Second preset",
        content: "Run this next",
      },
    });
    expect(second.statusCode).toBe(201);

    const firstId = first.json().preset.id as string;
    const secondId = second.json().preset.id as string;
    const secondUpdatedAt = second.json().preset.updatedAt as string;
    const listed = await app.inject({
      method: "GET",
      url: "/v1/projects/project-1/prompt-presets",
      headers: { "x-test-auth": "1" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().presets.map((preset: any) => preset.id)).toEqual([
      secondId,
      firstId,
    ]);

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/projects/project-1/prompt-presets/${firstId}`,
      headers: { "x-test-auth": "1" },
      payload: { title: "Updated first" },
    });
    expect(updated.statusCode).toBe(200);
    const firstUpdatedAt = updated.json().preset.updatedAt as string;
    expect(updated.json().preset).toMatchObject({
      id: firstId,
      title: "Updated first",
      content: "Preserve\nformatting",
    });

    const reordered = await app.inject({
      method: "PUT",
      url: "/v1/projects/project-1/prompt-presets/order",
      headers: { "x-test-auth": "1" },
      payload: { presetIds: [firstId, secondId] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(
      reordered.json().presets.map((preset: any) => ({
        id: preset.id,
        order: preset.order,
        updatedAt: preset.updatedAt,
      })),
    ).toEqual([
      { id: firstId, order: 0, updatedAt: firstUpdatedAt },
      { id: secondId, order: 1, updatedAt: secondUpdatedAt },
    ]);

    const duplicateOrder = await app.inject({
      method: "PUT",
      url: "/v1/projects/project-1/prompt-presets/order",
      headers: { "x-test-auth": "1" },
      payload: { presetIds: [firstId, firstId] },
    });
    expect(duplicateOrder.statusCode).toBe(400);
    expect(duplicateOrder.json()).toEqual({
      error: "invalid_prompt_preset_order",
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/projects/project-1/prompt-presets/${secondId}`,
      headers: { "x-test-auth": "1" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    const listedAfterDelete = await app.inject({
      method: "GET",
      url: "/v1/projects/project-1/prompt-presets",
      headers: { "x-test-auth": "1" },
    });
    expect(listedAfterDelete.json().presets).toHaveLength(1);
    expect(listedAfterDelete.json().presets[0].id).toBe(firstId);
  });

  it("blocks prompt preset operations for archived projects", async () => {
    createTestProject(app);
    app.roam.store.archiveProject("project-1", new Date().toISOString());

    const listed = await app.inject({
      method: "GET",
      url: "/v1/projects/project-1/prompt-presets",
      headers: { "x-test-auth": "1" },
    });
    expect(listed.statusCode).toBe(409);
    expect(listed.json()).toEqual({ error: "project_archived" });

    const created = await app.inject({
      method: "POST",
      url: "/v1/projects/project-1/prompt-presets",
      headers: { "x-test-auth": "1" },
      payload: { title: "Archived", content: "Nope" },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json()).toEqual({ error: "project_archived" });
  });

  it("archives and restores a project together with its sessions", async () => {
    createTestProject(app);
    const now = new Date().toISOString();
    const session: Session = {
      id: "session-project-archive",
      title: "Project session",
      projectId: "project-1",
      runnerId: "runner-1",
      agent: "codex",
      status: "completed",
      executionMode: "direct",
      executionFolder: "/workspace",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
    };
    app.roam.store.createSession(session);
    const userArchivedSession: Session = {
      ...session,
      id: "session-user-archive",
      title: "User archived session",
    };
    app.roam.store.createSession(userArchivedSession);
    app.roam.store.archiveSession(userArchivedSession.id, now);

    const archived = await app.inject({
      method: "POST",
      url: "/v1/projects/project-1/archive",
      headers: { "x-test-auth": "1" },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().project.archivedAt).toEqual(expect.any(String));
    expect(app.roam.store.getSession(session.id)?.archivedAt).toEqual(
      expect.any(String),
    );

    const hiddenProjects = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { "x-test-auth": "1" },
    });
    expect(hiddenProjects.json().projects).toEqual([]);
    const hiddenSessions = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
    });
    expect(hiddenSessions.json().sessions).toEqual([]);

    const restored = await app.inject({
      method: "POST",
      url: "/v1/projects/project-1/restore",
      headers: { "x-test-auth": "1" },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().project.archivedAt).toBeUndefined();
    expect(app.roam.store.getSession(session.id)?.archivedAt).toBeUndefined();
    expect(app.roam.store.getSession(userArchivedSession.id)?.archivedAt).toBe(
      now,
    );
  });

  it("returns API 404s for /v1 and asset 404s without SPA fallback", async () => {
    const webDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roamcli-web-data-"),
    );
    const webDistDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roamcli-web-dist-"),
    );
    const webApp = await createServer({
      dataDir: webDataDir,
      publicOrigin: TEST_ORIGIN,
      webDistDir,
    });
    try {
      fs.writeFileSync(
        path.join(webDistDir, "index.html"),
        "<!doctype html><div>spa</div>",
        "utf8",
      );

      const apiRoot = await webApp.inject({
        method: "GET",
        url: "/v1",
        headers: { "x-test-auth": "1" },
      });
      expect(apiRoot.statusCode).toBe(404);
      expect(apiRoot.headers["content-type"]).toContain("application/json");
      expect(apiRoot.json()).toEqual({ error: "not_found" });

      const missingAsset = await webApp.inject({
        method: "GET",
        url: "/assets/missing.js",
      });
      expect(missingAsset.statusCode).toBe(404);
      expect(missingAsset.headers["content-type"]).toContain(
        "application/json",
      );

      const clientRoute = await webApp.inject({
        method: "GET",
        url: "/sessions/session-1",
      });
      expect(clientRoute.statusCode).toBe(200);
      expect(clientRoute.headers["content-type"]).toContain("text/html");
      expect(clientRoute.body).toContain("spa");
    } finally {
      await webApp.close();
      fs.rmSync(webDataDir, { recursive: true, force: true });
      fs.rmSync(webDistDir, { recursive: true, force: true });
    }
  });

  it("registers a runner, creates a session, routes commands, and broadcasts runner events", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    const online = await nextJson(stream);
    expect(online.type).toBe("runner:online");

    const runners = await app.inject({
      method: "GET",
      url: "/v1/runners",
      headers: { "x-test-auth": "1" },
    });
    expect(runners.statusCode).toBe(200);
    expect(runners.json().runners).toHaveLength(1);
    expect(runners.json().runners[0].runnerId).toBe("runner-1");

    createTestProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "create-server-work",
        projectId: "project-1",
        agent: "codex",
        prompt: "implement server",
        title: "Server work",
      },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().session.id as string;

    const startCommand = await nextJson(runner);
    expect(startCommand).toMatchObject({
      type: "startSession",
      prompt: "implement server",
    });
    expect(startCommand.session.id).toBe(sessionId);

    runner.send(
      JSON.stringify({
        type: "assistantOutput",
        sessionId,
        outputId: "output-1",
        content: "done",
        mode: "replace",
        done: true,
        encrypted: false,
      }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "message:created" && event.message.content === "done",
    );
    runner.send(
      JSON.stringify({
        type: "agentActivity",
        sessionId,
        agent: "claude-code",
        kind: "task_progress",
        label: "Reading apps/web/src/app/useRoamController.ts",
      }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "activity:created" &&
        event.activity.label ===
          "Reading apps/web/src/app/useRoamController.ts",
    );
    runner.send(
      JSON.stringify({
        type: "assistantOutput",
        sessionId,
        outputId: "output-2",
        content: " streamed",
        mode: "append",
        done: true,
        encrypted: false,
      }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "message:created" &&
        event.message.content === " streamed",
    );

    const detail = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}`,
      headers: { "x-test-auth": "1" },
    });
    expect(detail.statusCode).toBe(200);
    expect(
      detail
        .json()
        .messages.map((message: { content: string }) => message.content),
    ).toEqual(["implement server", "done", " streamed"]);
    expect(
      detail
        .json()
        .activities.map((activity: { label: string }) => activity.label),
    ).toEqual(["Reading apps/web/src/app/useRoamController.ts"]);

    stream.close();
    runner.close();
  });

  it("keeps active sessions across runner socket reconnects", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const firstRunner = await openSocket(`${baseUrl}/v1/runner`);

    firstRunner.send(JSON.stringify(runnerRegistration()));
    await expectEventually(
      stream,
      (event) =>
        event.type === "runner:online" && event.runner.runnerId === "runner-1",
    );
    const streamEvents: Array<Record<string, any>> = [];
    stream.on("message", (data) => {
      streamEvents.push(JSON.parse(String(data)) as Record<string, any>);
    });
    createTestProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "create-long-running-task",
        projectId: "project-1",
        agent: "codex",
        prompt: "long running task",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(firstRunner);

    const secondRunner = await openSocket(`${baseUrl}/v1/runner`);
    secondRunner.send(JSON.stringify(runnerRegistration()));

    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(app.roam.store.getSession(sessionId)?.status).toBe("pending");
    expect(streamEvents).not.toContainEqual(
      expect.objectContaining({
        type: "session:updated",
        session: expect.objectContaining({
          id: sessionId,
          status: "stopped",
        }),
      }),
    );

    const checked = app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/status/check`,
      headers: { "x-test-auth": "1" },
    });
    const checkCommand = await nextJson(secondRunner);
    expect(checkCommand).toMatchObject({
      type: "checkSessionStatus",
      sessionId,
    });
    secondRunner.send(
      JSON.stringify({
        type: "sessionStatusCheckResult",
        result: {
          requestId: checkCommand.requestId,
          sessionId,
          active: false,
        },
      }),
    );
    const checkResponse = await checked;
    expect(checkResponse.statusCode).toBe(200);
    expect(checkResponse.json().session).toMatchObject({
      id: sessionId,
      status: "stopped",
    });
    await waitUntil(() =>
      streamEvents.some(
        (event) =>
          event.type === "session:updated" &&
          event.session.id === sessionId &&
          event.session.status === "stopped",
      ),
    );

    stream.close();
    firstRunner.close();
    secondRunner.close();
  });

  it("accepts the advertised total image budget before enforcing per-image limits", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(imageRunnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    createTestProject(app);

    const withinLimitUpload = imageUploadOfSize(
      DEFAULT_MAX_IMAGE_BYTES,
      "five-mb.png",
    );
    const createdPromise = app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: {
        "x-test-auth": "1",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        requestId: "create-five-megabytes",
        projectId: "project-1",
        agent: "codex",
        prompt: "describe five megabytes",
        attachments: [withinLimitUpload],
      }),
    });
    const writeCommand = await nextJson(runner);
    expect(writeCommand).toMatchObject({
      type: "writeSessionAttachments",
      attachments: [
        {
          name: "five-mb.png",
          mimeType: "image/png",
          size: DEFAULT_MAX_IMAGE_BYTES,
        },
      ],
    });
    runner.send(
      JSON.stringify({
        type: "attachmentWriteResult",
        result: {
          requestId: writeCommand.requestId,
          sessionId: writeCommand.sessionId,
          attachments: [
            runnerAttachmentForUpload(
              writeCommand.sessionId,
              withinLimitUpload,
            ),
          ],
        },
      }),
    );

    const created = await createdPromise;
    expect(created.statusCode).toBe(201);
    expect(created.json().attachments[0]).toMatchObject({
      name: "five-mb.png",
      size: DEFAULT_MAX_IMAGE_BYTES,
    });
    const startCommand = await nextJson(runner);
    expect(startCommand).toMatchObject({
      type: "startSession",
      prompt: "describe five megabytes",
      attachments: [
        {
          name: "five-mb.png",
          size: DEFAULT_MAX_IMAGE_BYTES,
        },
      ],
    });

    const budgetUploads = [
      imageUploadOfSize(13 * 1024 * 1024, "thirteen-mb.png"),
      imageUploadOfSize(12 * 1024 * 1024, "twelve-mb.png"),
    ];
    const budgetResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: {
        "x-test-auth": "1",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        requestId: "create-full-image-budget",
        projectId: "missing-project",
        agent: "codex",
        prompt: "accept the full image budget",
        attachments: budgetUploads,
      }),
    });
    expect(budgetResponse.statusCode).toBe(404);
    expect(budgetResponse.json()).toEqual({ error: "project_not_found" });

    runner.close();
  });

  it("keeps streamed assistant replies separated by resumed user turns", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(
      JSON.stringify(
        runnerRegistration({
          agent: "codex",
          parser: "codex-json",
          supportsResume: true,
        }),
      ),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "runner:online" && event.runner.runnerId === "runner-1",
    );

    createTestProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "create-first-question",
        projectId: "project-1",
        agent: "codex",
        prompt: "first question",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    runner.send(
      JSON.stringify({
        type: "assistantOutput",
        sessionId,
        outputId: "output-1",
        content: "first answer",
        mode: "replace",
        done: true,
        encrypted: false,
      }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "message:created" &&
        event.message.content === "first answer",
    );
    runner.send(
      JSON.stringify({
        type: "sessionThread",
        sessionId,
        threadId: "codex-thread-1",
      }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "session:updated" &&
        event.session.id === sessionId &&
        event.session.agentThreadId === "codex-thread-1",
    );
    runner.send(
      JSON.stringify({ type: "sessionStatus", sessionId, status: "completed" }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "session:updated" &&
        event.session.id === sessionId &&
        event.session.status === "completed",
    );

    stream.send(
      JSON.stringify({
        type: "userMessage",
        requestId: "second-1",
        sessionId,
        content: "second question",
      }),
    );
    const resumeCommand = await nextJson(runner);
    expect(resumeCommand).toMatchObject({
      type: "startSession",
      prompt: "second question",
      resumeThreadId: "codex-thread-1",
    });

    runner.send(
      JSON.stringify({
        type: "assistantOutput",
        sessionId,
        outputId: "output-2",
        content: "second answer",
        mode: "replace",
        done: true,
        encrypted: false,
      }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "message:created" &&
        event.message.content === "second answer",
    );

    const detail = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}`,
      headers: { "x-test-auth": "1" },
    });
    expect(
      detail
        .json()
        .messages.map((message: { role: string; content: string }) => [
          message.role,
          message.content,
        ]),
    ).toEqual([
      ["user", "first question"],
      ["assistant", "first answer"],
      ["user", "second question"],
      ["assistant", "second answer"],
    ]);

    stream.close();
    runner.close();
  });

  it("restarts a stopped resumable session instead of forwarding resume to a dead process", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration({ supportsResume: true })));
    await expectEventually(
      stream,
      (event) =>
        event.type === "runner:online" && event.runner.runnerId === "runner-1",
    );

    createTestProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "create-start-once",
        projectId: "project-1",
        agent: "codex",
        prompt: "start once",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    runner.send(
      JSON.stringify({ type: "sessionStatus", sessionId, status: "stopped" }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "session:updated" &&
        event.session.id === sessionId &&
        event.session.status === "stopped",
    );

    stream.send(
      JSON.stringify({
        type: "controlSignal",
        requestId: "resume-1",
        sessionId,
        signal: "resume",
      }),
    );
    const resumeCommand = await nextJson(runner);
    expect(resumeCommand).toMatchObject({
      type: "startSession",
      prompt: `Resume session ${sessionId}`,
    });
    expect(resumeCommand.session).toMatchObject({
      id: sessionId,
      status: "pending",
    });

    stream.close();
    runner.close();
  });

  it("resumes completed codex exec sessions with the stored codex thread id", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(
      JSON.stringify(
        runnerRegistration({
          agent: "codex",
          parser: "codex-json",
          supportsResume: true,
        }),
      ),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "runner:online" && event.runner.runnerId === "runner-1",
    );

    createTestProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "create-first-prompt",
        projectId: "project-1",
        agent: "codex",
        prompt: "first prompt",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    runner.send(
      JSON.stringify({
        type: "sessionThread",
        sessionId,
        threadId: "codex-thread-1",
      }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "session:updated" &&
        event.session.id === sessionId &&
        event.session.agentThreadId === "codex-thread-1",
    );
    runner.send(
      JSON.stringify({ type: "sessionStatus", sessionId, status: "completed" }),
    );
    await expectEventually(
      stream,
      (event) =>
        event.type === "session:updated" &&
        event.session.id === sessionId &&
        event.session.status === "completed",
    );

    stream.send(
      JSON.stringify({
        type: "userMessage",
        requestId: "next-1",
        sessionId,
        content: "next prompt",
      }),
    );
    const resumeCommand = await nextJson(runner);
    expect(resumeCommand).toMatchObject({
      type: "startSession",
      prompt: "next prompt",
      resumeThreadId: "codex-thread-1",
    });
    expect(resumeCommand.session).toMatchObject({
      id: sessionId,
      status: "pending",
      agentThreadId: "codex-thread-1",
    });

    stream.close();
    runner.close();
  });

  it("requests file trees and file content from the registered runner", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    await expectEventually(
      stream,
      (event) =>
        event.type === "runner:online" && event.runner.runnerId === "runner-1",
    );

    createTestProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "create-inspect-files",
        projectId: "project-1",
        agent: "codex",
        prompt: "inspect files",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    const treePromise = app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/files?requestId=client-tree-1&path=src&depth=2`,
      headers: { "x-test-auth": "1" },
    });
    const treeCommand = await nextJson(runner);
    expect(treeCommand).toMatchObject({
      type: "readFileTree",
      clientRequestId: "client-tree-1",
      sessionId,
      cwd: "/workspace",
      path: "src",
      depth: 2,
    });
    expect(treeCommand.requestId).toMatch(/^file_tree_/);

    const treeResult = {
      requestId: treeCommand.requestId,
      clientRequestId: treeCommand.clientRequestId,
      sessionId,
      root: {
        path: "src",
        name: "src",
        type: "directory",
        children: [
          { path: "src/index.ts", name: "index.ts", type: "file", size: 42 },
        ],
      },
    };
    runner.send(JSON.stringify({ type: "fileTreeResult", result: treeResult }));
    const treeResponse = await treePromise;
    expect(treeResponse.statusCode).toBe(200);
    expect(treeResponse.json()).toEqual({ result: treeResult });
    await expectEventually(
      stream,
      (event) =>
        event.type === "file:tree" &&
        event.result.requestId === treeCommand.requestId &&
        event.result.clientRequestId === "client-tree-1",
    );

    const contentPromise = app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/files/content?path=src/index.ts&maxBytes=128`,
      headers: { "x-test-auth": "1" },
    });
    const contentCommand = await nextJson(runner);
    expect(contentCommand).toMatchObject({
      type: "readFileContent",
      sessionId,
      cwd: "/workspace",
      path: "src/index.ts",
      maxBytes: 128,
    });

    const contentResult = {
      requestId: contentCommand.requestId,
      sessionId,
      path: "src/index.ts",
      kind: "text",
      content: "console.log('hello');\n",
      truncated: false,
      encoding: "utf8",
    };
    runner.send(
      JSON.stringify({ type: "fileContentResult", result: contentResult }),
    );
    const contentResponse = await contentPromise;
    expect(contentResponse.statusCode).toBe(200);
    expect(contentResponse.json()).toEqual({ result: contentResult });
    await expectEventually(
      stream,
      (event) =>
        event.type === "file:content" &&
        event.result.requestId === contentCommand.requestId,
    );

    const writePromise = app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/files/content`,
      headers: { "x-test-auth": "1" },
      payload: {
        path: "src/index.ts",
        content: "console.log('saved');\n",
      },
    });
    const writeCommand = await nextJson(runner);
    expect(writeCommand).toMatchObject({
      type: "writeFileContent",
      sessionId,
      cwd: "/workspace",
      path: "src/index.ts",
      content: "console.log('saved');\n",
      encoding: "utf8",
    });

    const writeResult = {
      requestId: writeCommand.requestId,
      sessionId,
      path: "src/index.ts",
      bytesWritten: 22,
      encoding: "utf8",
    };
    runner.send(
      JSON.stringify({ type: "fileWriteResult", result: writeResult }),
    );
    const writeResponse = await writePromise;
    expect(writeResponse.statusCode).toBe(200);
    expect(writeResponse.json()).toEqual({ result: writeResult });
    await expectEventually(
      stream,
      (event) =>
        event.type === "file:written" &&
        event.result.requestId === writeCommand.requestId,
    );

    stream.close();
    runner.close();
  });

  it("lists and creates runner workspace directories", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    await expectEventually(
      stream,
      (event) =>
        event.type === "runner:online" && event.runner.runnerId === "runner-1",
    );
    const streamEvents: Array<Record<string, any>> = [];
    stream.on("message", (data) => {
      streamEvents.push(JSON.parse(String(data)) as Record<string, any>);
    });

    const listPromise = app.inject({
      method: "GET",
      url: "/v1/runners/runner-1/directories?path=.&depth=1",
      headers: { "x-test-auth": "1" },
    });
    const listCommand = await nextJson(runner);
    expect(listCommand).toMatchObject({
      type: "readFileTree",
      cwd: "/workspace",
      path: ".",
      depth: 1,
      includeFiles: false,
    });
    expect(listCommand.sessionId).toBe("runner-directory-runner-1");
    runner.send(
      JSON.stringify({
        type: "fileTreeResult",
        result: {
          requestId: listCommand.requestId,
          sessionId: listCommand.sessionId,
          root: {
            path: ".",
            name: "workspace",
            type: "directory",
            children: [
              { path: "api", name: "api", type: "directory", children: [] },
              { path: "README.md", name: "README.md", type: "file", size: 42 },
            ],
          },
        },
      }),
    );
    const listResponse = await listPromise;
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().result.root.children).toEqual([
      { path: "api", name: "api", type: "directory", children: [] },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(streamEvents.some((event) => event.type === "file:tree")).toBe(
      false,
    );

    const createPromise = app.inject({
      method: "POST",
      url: "/v1/runners/runner-1/directories",
      headers: { "x-test-auth": "1" },
      payload: { parentPath: "api", name: "web" },
    });
    const createCommand = await nextJson(runner);
    expect(createCommand).toMatchObject({
      type: "createDirectory",
      cwd: "/workspace",
      parentPath: "api",
      name: "web",
    });
    const createResult = {
      requestId: createCommand.requestId,
      path: "api/web",
      node: {
        path: "api/web",
        name: "web",
        type: "directory",
        children: [],
      },
    };
    runner.send(
      JSON.stringify({ type: "directoryCreateResult", result: createResult }),
    );
    const createResponse = await createPromise;
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toEqual({ result: createResult });

    stream.close();
    runner.close();
  });

  it("rejects file roots from runner directory listings", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    const listPromise = app.inject({
      method: "GET",
      url: "/v1/runners/runner-1/directories?path=src&depth=1",
      headers: { "x-test-auth": "1" },
    });
    const listCommand = await nextJson(runner);
    expect(listCommand).toMatchObject({
      type: "readFileTree",
      cwd: "/workspace",
      path: "src",
      depth: 1,
      includeFiles: false,
    });
    runner.send(
      JSON.stringify({
        type: "fileTreeResult",
        result: {
          requestId: listCommand.requestId,
          sessionId: listCommand.sessionId,
          root: {
            path: "src",
            name: "src",
            type: "file",
            size: 12,
          },
        },
      }),
    );

    const listResponse = await listPromise;
    expect(listResponse.statusCode).toBe(400);
    expect(listResponse.json()).toEqual({ error: "invalid_directory" });

    runner.close();
  });

  it("returns bad requests for runner directory creation failures", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    const createPromise = app.inject({
      method: "POST",
      url: "/v1/runners/runner-1/directories",
      headers: { "x-test-auth": "1" },
      payload: { parentPath: ".", name: "../outside" },
    });
    const createCommand = await nextJson(runner);
    expect(createCommand).toMatchObject({
      type: "createDirectory",
      cwd: "/workspace",
      parentPath: ".",
      name: "../outside",
    });
    runner.send(
      JSON.stringify({
        type: "error",
        requestId: createCommand.requestId,
        message: "Invalid directory name: ../outside",
        code: "DIRECTORY_CREATE_ERROR",
      }),
    );

    const createResponse = await createPromise;
    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json()).toEqual({
      error: "runner_error",
      code: "DIRECTORY_CREATE_ERROR",
      message: "Invalid directory name: ../outside",
    });

    runner.close();
  });

  it("returns bad requests for stale runner directory listing paths", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    const listPromise = app.inject({
      method: "GET",
      url: "/v1/runners/runner-1/directories?path=missing&depth=1",
      headers: { "x-test-auth": "1" },
    });
    const listCommand = await nextJson(runner);
    expect(listCommand).toMatchObject({
      type: "readFileTree",
      cwd: "/workspace",
      path: "missing",
      depth: 1,
      includeFiles: false,
    });
    runner.send(
      JSON.stringify({
        type: "error",
        requestId: listCommand.requestId,
        message: "Path does not exist: missing",
        code: "FILE_TREE_ERROR",
      }),
    );

    const listResponse = await listPromise;
    expect(listResponse.statusCode).toBe(400);
    expect(listResponse.json()).toEqual({
      error: "runner_error",
      code: "FILE_TREE_ERROR",
      message: "Path does not exist: missing",
    });

    runner.close();
  });

  it("returns runner errors when file RPCs cannot complete", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`);

    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    createTestProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "create-inspect-file-errors",
        projectId: "project-1",
        agent: "codex",
        prompt: "inspect files",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    const unavailablePromise = app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/files?path=.&depth=1`,
      headers: { "x-test-auth": "1" },
    });
    const unavailableCommand = await nextJson(runner);
    runner.send(
      JSON.stringify({
        type: "error",
        requestId: unavailableCommand.requestId,
        sessionId,
        message: "Session cwd is unavailable",
        code: "SESSION_NOT_FOUND",
      }),
    );
    const unavailable = await unavailablePromise;
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toEqual({
      error: "runner_error",
      code: "SESSION_NOT_FOUND",
      message: "Session cwd is unavailable",
    });

    const timeout = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/files?path=.&depth=1`,
      headers: { "x-test-auth": "1" },
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json()).toEqual({ error: "runner_timeout" });

    runner.close();
    await waitUntil(() => !app.roam.hub.isRunnerOnline("runner-1"));

    const offline = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/files/content?path=README.md`,
      headers: { "x-test-auth": "1" },
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toEqual({ error: "runner_offline" });
  });

  it("persists approval responses and local artifacts", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`);
    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    createTestProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "create-needs-approval",
        projectId: "project-1",
        agent: "codex",
        prompt: "needs approval",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    runner.send(
      JSON.stringify({
        type: "approvalRequested",
        approval: {
          id: "approval-1",
          sessionId,
          runnerId: "runner-1",
          kind: "execCommand",
          summary: "Run tests",
          payload: { cmd: "pnpm test" },
          status: "pending",
          requestedAt: new Date().toISOString(),
        },
      }),
    );
    await waitUntil(
      () => app.roam.store.getApproval("approval-1") !== undefined,
    );

    const approved = await app.inject({
      method: "POST",
      url: "/v1/approvals/approval-1",
      headers: { "x-test-auth": "1" },
      payload: { approved: true },
    });
    expect(approved.statusCode).toBe(200);
    const approvalCommand = await nextJson(runner);
    expect(approvalCommand).toEqual({
      type: "resolveApproval",
      approvalId: "approval-1",
      approved: true,
    });

    const artifactResponse = await app.inject({
      method: "POST",
      url: "/v1/artifacts",
      headers: { "x-test-auth": "1" },
      payload: {
        sessionId,
        kind: "log",
        name: "run.log",
        mimeType: "text/plain",
        content: "hello artifact",
      },
    });
    expect(artifactResponse.statusCode).toBe(201);
    const artifact = artifactResponse.json().artifact as {
      storagePath: string;
      size: number;
    };
    expect(artifact.size).toBe(14);
    expect(fs.readFileSync(artifact.storagePath, "utf8")).toBe(
      "hello artifact",
    );

    const detail = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}`,
      headers: { "x-test-auth": "1" },
    });
    expect(detail.json().approvals[0]).toMatchObject({
      status: "approved",
      resolvedBy: "owner",
      resolverSessionId: expect.any(String),
    });
    expect(detail.json().artifacts[0].name).toBe("run.log");

    runner.close();
  });

  it("archives a session, keeps persisted children and broadcasts an update", async () => {
    const now = new Date().toISOString();
    createTestProject(app);
    app.roam.store.createSession({
      id: "session-delete",
      title: "Delete me",
      projectId: "project-1",
      runnerId: "runner-1",
      agent: "codex",
      status: "running",
      executionMode: "direct",
      executionFolder: "/workspace",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
    });
    const sendToRunner = vi.spyOn(app.roam.hub, "sendToRunner");
    const broadcast = vi.spyOn(app.roam.hub, "broadcast");

    app.roam.store.upsertApproval({
      id: "approval-delete",
      sessionId: "session-delete",
      runnerId: "runner-1",
      kind: "execCommand",
      summary: "Pending command",
      payload: { command: "pnpm test" },
      status: "pending",
      requestedAt: now,
    });
    const artifactResponse = await app.inject({
      method: "POST",
      url: "/v1/artifacts",
      headers: { "x-test-auth": "1" },
      payload: {
        sessionId: "session-delete",
        kind: "log",
        name: "delete.log",
        mimeType: "text/plain",
        content: "temporary",
      },
    });
    const artifactPath = artifactResponse.json().artifact.storagePath as string;
    expect(fs.existsSync(artifactPath)).toBe(true);
    broadcast.mockClear();

    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/sessions/session-delete",
      headers: { "x-test-auth": "1" },
    });
    expect(deleted.statusCode).toBe(204);
    expect(sendToRunner).toHaveBeenCalledWith("runner-1", {
      type: "controlSignal",
      sessionId: "session-delete",
      signal: "stop",
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: "session:updated",
      session: expect.objectContaining({
        id: "session-delete",
        archivedAt: expect.any(String),
      }),
    });

    expect(app.roam.store.getSession("session-delete")?.archivedAt).toEqual(
      expect.any(String),
    );
    expect(app.roam.store.getApproval("approval-delete")).toBeDefined();
    expect(fs.existsSync(artifactPath)).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: "/v1/sessions/session-delete",
      headers: { "x-test-auth": "1" },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().session.archivedAt).toEqual(expect.any(String));
  });

  it("keeps serving after managed worktree archive removal cannot reach the runner", async () => {
    const now = new Date().toISOString();
    createTestProject(app);
    app.roam.store.createSession({
      id: "session-offline-worktree-delete",
      title: "Offline worktree delete",
      projectId: "project-1",
      runnerId: "runner-1",
      agent: "codex",
      status: "completed",
      executionMode: "managed_worktree",
      executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
      cwd: "/workspace",
      gitBranchName: "session-1",
      createdAt: now,
      updatedAt: now,
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/sessions/session-offline-worktree-delete?worktree=remove",
      headers: { "x-test-auth": "1" },
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toEqual({
      error: "worktree_remove_failed",
      message: "runner is offline",
      code: "runner_offline",
    });
    expect(
      app.roam.store.getSession("session-offline-worktree-delete")?.archivedAt,
    ).toBeUndefined();

    const sessions = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().sessions).toContainEqual(
      expect.objectContaining({ id: "session-offline-worktree-delete" }),
    );
  });

  it("renames a session and broadcasts an update", async () => {
    const now = "2026-06-05T00:00:00.000Z";
    createTestProject(app);
    app.roam.store.createSession({
      id: "session-rename",
      title: "Original title",
      projectId: "project-1",
      runnerId: "runner-1",
      agent: "codex",
      status: "completed",
      executionMode: "direct",
      executionFolder: "/workspace",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
    });
    const broadcast = vi.spyOn(app.roam.hub, "broadcast");

    const renamed = await app.inject({
      method: "PATCH",
      url: "/v1/sessions/session-rename",
      headers: { "x-test-auth": "1" },
      payload: { title: "  Renamed title  " },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().session).toMatchObject({
      id: "session-rename",
      title: "Renamed title",
    });
    expect(renamed.json().session.updatedAt).not.toBe(now);
    expect(app.roam.store.getSession("session-rename")?.title).toBe(
      "Renamed title",
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "session:updated",
      session: expect.objectContaining({
        id: "session-rename",
        title: "Renamed title",
      }),
    });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/v1/sessions/session-rename",
      headers: { "x-test-auth": "1" },
      payload: { title: "   " },
    });
    expect(invalid.statusCode).toBe(400);
    expect(app.roam.store.getSession("session-rename")?.title).toBe(
      "Renamed title",
    );

    const missing = await app.inject({
      method: "PATCH",
      url: "/v1/sessions/missing-session",
      headers: { "x-test-auth": "1" },
      payload: { title: "Missing" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "session_not_found" });
  });

  it("applies owner-authorized patches through runner RPC", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`);
    const runner = await openSocket(`${baseUrl}/v1/runner`);
    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    createTestProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-test-auth": "1" },
      payload: {
        requestId: "create-apply-patch",
        projectId: "project-1",
        agent: "codex",
        prompt: "apply patch",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    runner.send(
      JSON.stringify({
        type: "approvalRequested",
        approval: {
          id: "approval-2",
          sessionId,
          runnerId: "runner-1",
          kind: "applyPatch",
          summary: "Apply patch",
          payload: { file: "README.md" },
          status: "pending",
          requestedAt: new Date().toISOString(),
        },
      }),
    );
    await waitUntil(
      () => app.roam.store.getApproval("approval-2") !== undefined,
    );

    const patch = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n";
    const patchPromise = app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/patches/apply`,
      headers: { "x-test-auth": "1" },
      payload: { patch, strip: 1 },
    });
    const patchCommand = await nextJson(runner);
    expect(patchCommand).toMatchObject({
      type: "applyPatch",
      sessionId,
      cwd: "/workspace",
      patch,
      strip: 1,
    });

    const patchResult = {
      requestId: patchCommand.requestId,
      sessionId,
      applied: true,
      changedFiles: ["README.md"],
      message: "applied",
      rejected: [],
    };
    runner.send(
      JSON.stringify({ type: "patchApplyResult", result: patchResult }),
    );
    const patchResponse = await patchPromise;
    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json()).toEqual({ result: patchResult });
    await expectEventually(
      stream,
      (event) =>
        event.type === "patch:applied" &&
        event.result.requestId === patchCommand.requestId,
    );

    stream.close();
    runner.close();
  });
});

function runnerRegistration(
  options: {
    supportsResume?: boolean;
    agent?: string;
    parser?: string;
  } = {},
): RunnerRegistration {
  const agent = options.agent ?? "codex";
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
        kind: agent,
        label: agent === "codex" ? "Codex" : agent,
        command: agent,
        args: [],
        parser: options.parser ?? agent,
        supportsResume: options.supportsResume ?? false,
      },
    ],
  };
}

function ackRunnerAuthentication(streamId: string, acknowledgedThrough = 0) {
  return {
    type: "runnerAuthenticate",
    token: runnerToken,
    runner: runnerRegistration(),
    eventDelivery: {
      protocol: "ack_v1",
      streamId,
      acknowledgedThrough,
    },
  };
}

function ackRunnerEvent(
  streamId: string,
  sequence: number,
  event: Record<string, unknown>,
) {
  return {
    type: "runnerEvent",
    protocol: "ack_v1",
    streamId,
    sequence,
    event,
  };
}

function imageRunnerRegistration(): RunnerRegistration {
  const runner = runnerRegistration({ agent: "codex", parser: "codex-json" });
  return {
    ...runner,
    capabilities: [
      {
        ...runner.capabilities[0]!,
        supportsImages: true,
        supportedImageMimeTypes: ["image/png"],
        maxImagesPerTurn: 5,
        maxImageBytes: MAX_ATTACHMENT_BYTES,
        maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES_PER_TURN,
      },
    ],
  };
}

function imageUploadOfSize(size: number, name: string) {
  const content = Buffer.alloc(size, 0x61);
  return {
    name,
    mimeType: "image/png",
    size,
    contentBase64: content.toString("base64"),
  };
}

function runnerAttachmentForUpload(
  sessionId: string,
  upload: ReturnType<typeof imageUploadOfSize>,
) {
  const content = Buffer.from(upload.contentBase64, "base64");
  return {
    id: `attachment-${upload.name}`,
    kind: "image",
    name: upload.name,
    mimeType: upload.mimeType,
    size: upload.size,
    sha256: hashPayload(content),
    runnerStoragePath: `attachments/${sessionId}/attachment-${upload.name}/${upload.name}`,
  };
}

function createTestProject(app: RoamServer): void {
  if (app.roam.store.getProject("project-1")) {
    return;
  }
  const now = new Date().toISOString();
  app.roam.store.createProject({
    id: "project-1",
    name: "Test Project",
    runnerId: "runner-1",
    directory: "/workspace",
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  });
}

function localBaseUrl(app: RoamServer): string {
  const address = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}`;
}

interface SocketOptions {
  authenticateRunner?: boolean;
  headers?: Record<string, string>;
  origin?: string;
  streamCookie?: string;
}

function openSocket(
  url: string,
  options: SocketOptions = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const isRunner = url.endsWith("/v1/runner");
    const socket = new WebSocket(url, {
      headers: socketHeaders(url, options),
    });
    if (isRunner && options.authenticateRunner !== false) {
      wrapRunnerAuthSend(socket);
    }
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function openSocketAndWaitForClose(
  url: string,
  options: SocketOptions = {},
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: socketHeaders(url, options),
    });
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for websocket close")),
      2000,
    );
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    socket.once("error", reject);
  });
}

function socketHeaders(
  url: string,
  options: SocketOptions,
): Record<string, string> | undefined {
  if (!url.endsWith("/v1/stream")) {
    return options.headers;
  }
  return {
    cookie: options.streamCookie ?? authCookie,
    origin: options.origin ?? TEST_ORIGIN,
    ...options.headers,
  };
}

function wrapRunnerAuthSend(socket: WebSocket): void {
  let authenticated = false;
  const send = socket.send.bind(socket);
  socket.send = ((data: any, ...args: any[]) => {
    if (!authenticated) {
      const maybeRegistration = parseJsonObject(data);
      if (isRunnerRegistrationLike(maybeRegistration)) {
        authenticated = true;
        return send(
          JSON.stringify({
            type: "runnerAuthenticate",
            token: runnerToken,
            runner: maybeRegistration,
          }),
          ...args,
        );
      }
    }
    return send(data, ...args);
  }) as typeof socket.send;
}

function parseJsonObject(data: unknown): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(String(data)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRunnerRegistrationLike(
  value: Record<string, any> | undefined,
): value is RunnerRegistration {
  return (
    value !== undefined &&
    typeof value.runnerId === "string" &&
    Array.isArray(value.capabilities)
  );
}

function readSetupToken(dataDir: string): string {
  return fs.readFileSync(path.join(dataDir, "setup-token.txt"), "utf8").trim();
}

function extractCookie(
  setCookie: string | string[] | number | undefined,
): string {
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof cookie !== "string") {
    throw new Error("setup response did not set an auth cookie");
  }
  return cookie.split(";")[0] ?? cookie;
}

function currentAuthSessionId(app: RoamServer): string {
  const session = app.roam.store.listAuthSessions()[0];
  if (!session) {
    throw new Error("expected auth session");
  }
  return session.id;
}

function shouldAttachAuth(options: any): boolean {
  if (!options || typeof options !== "object") {
    return false;
  }
  const headers = options.headers;
  if (!headers || typeof headers !== "object") {
    return false;
  }
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === "x-test-auth",
  );
}

function nextJson(socket: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for websocket message")),
      2000,
    );
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, any>);
    });
  });
}

function nextClose(
  socket: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for websocket close")),
      2000,
    );
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function expectEventually(
  socket: WebSocket,
  predicate: (event: Record<string, any>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const event = await nextJson(socket);
    if (predicate(event)) {
      return;
    }
  }
  throw new Error("expected websocket event was not observed");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
