import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { RunnerRegistration } from "@roamcli/protocol";
import { hashPayload, signApproval } from "@roamcli/security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createServer, type RoamServer } from "../src/app.js";

const token = "test-token";

describe("server", () => {
  let dataDir: string;
  let app: RoamServer;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roamcli-server-"));
    app = await createServer({
      dataDir,
      authToken: token,
      webDistDir: false,
      runnerRpcTimeoutMs: 50,
    });
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("requires bearer auth and lists persisted sessions", async () => {
    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/sessions",
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ sessions: [] });
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
      authToken: token,
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
        headers: { authorization: `Bearer ${token}` },
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
    const stream = await openSocket(`${baseUrl}/v1/stream`, token);
    const runner = await openSocket(`${baseUrl}/v1/runner`, token);

    runner.send(JSON.stringify(runnerRegistration()));
    const online = await nextJson(stream);
    expect(online.type).toBe("runner:online");

    const runners = await app.inject({
      method: "GET",
      url: "/v1/runners",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(runners.statusCode).toBe(200);
    expect(runners.json().runners).toHaveLength(1);
    expect(runners.json().runners[0].runnerId).toBe("runner-1");

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runnerId: "runner-1",
        agent: "codex",
        cwd: "/workspace",
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
      headers: { authorization: `Bearer ${token}` },
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

  it("keeps streamed assistant replies separated by resumed user turns", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`, token);
    const runner = await openSocket(`${baseUrl}/v1/runner`, token);

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

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runnerId: "runner-1",
        agent: "codex",
        cwd: "/workspace",
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
      headers: { authorization: `Bearer ${token}` },
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
    const stream = await openSocket(`${baseUrl}/v1/stream`, token);
    const runner = await openSocket(`${baseUrl}/v1/runner`, token);

    runner.send(JSON.stringify(runnerRegistration({ supportsResume: true })));
    await expectEventually(
      stream,
      (event) =>
        event.type === "runner:online" && event.runner.runnerId === "runner-1",
    );

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runnerId: "runner-1",
        agent: "codex",
        cwd: "/workspace",
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
    const stream = await openSocket(`${baseUrl}/v1/stream`, token);
    const runner = await openSocket(`${baseUrl}/v1/runner`, token);

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

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runnerId: "runner-1",
        agent: "codex",
        cwd: "/workspace",
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
    const stream = await openSocket(`${baseUrl}/v1/stream`, token);
    const runner = await openSocket(`${baseUrl}/v1/runner`, token);

    runner.send(JSON.stringify(runnerRegistration()));
    await expectEventually(
      stream,
      (event) =>
        event.type === "runner:online" && event.runner.runnerId === "runner-1",
    );

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runnerId: "runner-1",
        agent: "codex",
        cwd: "/workspace",
        prompt: "inspect files",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    const treePromise = app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/files?path=src&depth=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    const treeCommand = await nextJson(runner);
    expect(treeCommand).toMatchObject({
      type: "readFileTree",
      sessionId,
      cwd: "/workspace",
      path: "src",
      depth: 2,
    });

    const treeResult = {
      requestId: treeCommand.requestId,
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
        event.result.requestId === treeCommand.requestId,
    );

    const contentPromise = app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/files/content?path=src/index.ts&maxBytes=128`,
      headers: { authorization: `Bearer ${token}` },
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
      headers: { authorization: `Bearer ${token}` },
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

  it("returns runner errors when file RPCs cannot complete", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`, token);

    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runnerId: "runner-1",
        agent: "codex",
        cwd: "/workspace",
        prompt: "inspect files",
      },
    });
    const sessionId = created.json().session.id as string;
    await nextJson(runner);

    const unavailablePromise = app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/files?path=.&depth=1`,
      headers: { authorization: `Bearer ${token}` },
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
      headers: { authorization: `Bearer ${token}` },
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json()).toEqual({ error: "runner_timeout" });

    runner.close();
    await waitUntil(() => !app.roam.hub.isRunnerOnline("runner-1"));

    const offline = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/files/content?path=README.md`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toEqual({ error: "runner_offline" });
  });

  it("persists approval responses and local artifacts", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const runner = await openSocket(`${baseUrl}/v1/runner`, token);
    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runnerId: "runner-1",
        agent: "codex",
        cwd: "/workspace",
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
      headers: { authorization: `Bearer ${token}` },
      payload: signedApprovalPayload("approval-1", true),
    });
    expect(approved.statusCode).toBe(200);
    const approvalCommand = await nextJson(runner);
    expect(approvalCommand).toEqual({
      type: "resolveApproval",
      approvalId: "approval-1",
      approved: true,
      signedAt: expect.any(String),
      signature: expect.any(String),
    });

    const artifactResponse = await app.inject({
      method: "POST",
      url: "/v1/artifacts",
      headers: { authorization: `Bearer ${token}` },
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
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.json().approvals[0].status).toBe("approved");
    expect(detail.json().artifacts[0].name).toBe("run.log");

    runner.close();
  });

  it("deletes a session, cascades persisted children, removes artifacts, and broadcasts deletion", async () => {
    const now = new Date().toISOString();
    app.roam.store.createSession({
      id: "session-delete",
      title: "Delete me",
      runnerId: "runner-1",
      agent: "codex",
      status: "running",
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
      headers: { authorization: `Bearer ${token}` },
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
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.statusCode).toBe(204);
    expect(sendToRunner).toHaveBeenCalledWith("runner-1", {
      type: "controlSignal",
      sessionId: "session-delete",
      signal: "stop",
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: "session:deleted",
      sessionId: "session-delete",
    });

    expect(app.roam.store.getSession("session-delete")).toBeUndefined();
    expect(app.roam.store.getApproval("approval-delete")).toBeUndefined();
    expect(fs.existsSync(artifactPath)).toBe(false);

    const detail = await app.inject({
      method: "GET",
      url: "/v1/sessions/session-delete",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.statusCode).toBe(404);
  });

  it("rejects invalid approval signatures and applies signed patches through runner RPC", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = localBaseUrl(app);
    const stream = await openSocket(`${baseUrl}/v1/stream`, token);
    const runner = await openSocket(`${baseUrl}/v1/runner`, token);
    runner.send(JSON.stringify(runnerRegistration()));
    await waitUntil(() => app.roam.hub.isRunnerOnline("runner-1"));

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runnerId: "runner-1",
        agent: "codex",
        cwd: "/workspace",
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

    const invalidApproval = await app.inject({
      method: "POST",
      url: "/v1/approvals/approval-2",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        approved: true,
        signedAt: new Date().toISOString(),
        signature: "not-valid",
      },
    });
    expect(invalidApproval.statusCode).toBe(403);
    expect(invalidApproval.json()).toEqual({ error: "invalid_signature" });

    const patch = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n";
    const signedPatch = signedPatchPayload(sessionId, patch);
    const patchPromise = app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/patches/apply`,
      headers: { authorization: `Bearer ${token}` },
      payload: signedPatch,
    });
    const patchCommand = await nextJson(runner);
    expect(patchCommand).toMatchObject({
      type: "applyPatch",
      sessionId,
      patch,
      strip: 1,
      signedAt: signedPatch.signedAt,
      signature: signedPatch.signature,
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

function localBaseUrl(app: RoamServer): string {
  const address = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}`;
}

function openSocket(url: string, authToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
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

function signedApprovalPayload(approvalId: string, approved: boolean) {
  const signedAt = new Date().toISOString();
  return {
    approved,
    signedAt,
    signature: signApproval(token, approvalId, approved, signedAt),
  };
}

function signedPatchPayload(sessionId: string, patch: string) {
  const signedAt = new Date().toISOString();
  return {
    patch,
    strip: 1,
    signedAt,
    signature: signApproval(
      token,
      `patch:${sessionId}:${hashPayload(patch)}`,
      true,
      signedAt,
    ),
  };
}
