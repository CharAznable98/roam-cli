import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_MAX_IMAGE_BYTES,
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
        type: "assistantMessage",
        sessionId,
        content: "done",
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
        type: "token",
        sessionId,
        content: " streamed",
        encrypted: false,
      }),
    );
    await expectEventually(
      stream,
      (event) => event.type === "token" && event.content === " streamed",
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

  it("accepts 5MB image payloads and rejects larger images at the business limit", async () => {
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

    const oversized = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: {
        "x-test-auth": "1",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        projectId: "project-1",
        agent: "codex",
        prompt: "reject oversized image",
        attachments: [
          imageUploadOfSize(DEFAULT_MAX_IMAGE_BYTES + 1, "too-large.png"),
        ],
      }),
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toEqual({ error: "image_too_large" });

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
        projectId: "project-1",
        agent: "codex",
        prompt: "first question",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    runner.send(
      JSON.stringify({
        type: "token",
        sessionId,
        content: "first answer",
        encrypted: false,
      }),
    );
    await expectEventually(
      stream,
      (event) => event.type === "token" && event.content === "first answer",
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
        type: "token",
        sessionId,
        content: "second answer",
        encrypted: false,
      }),
    );
    await expectEventually(
      stream,
      (event) => event.type === "token" && event.content === "second answer",
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
        maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
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

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const isStream = url.endsWith("/v1/stream");
    const isRunner = url.endsWith("/v1/runner");
    const socket = new WebSocket(url, {
      headers: isStream
        ? { cookie: authCookie, origin: TEST_ORIGIN }
        : undefined,
    });
    if (isRunner) {
      wrapRunnerAuthSend(socket);
    }
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
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
