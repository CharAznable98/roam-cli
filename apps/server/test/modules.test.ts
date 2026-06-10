import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";
import type {
  RunnerCommand,
  RunnerRegistration,
  ServerEvent,
  Session,
} from "@roamcli/protocol";
import { hashPayload, signApproval } from "@roamcli/security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionHub } from "../src/infra/connection-hub.js";
import {
  RunnerRpcClient,
  RunnerRpcError,
} from "../src/infra/runner-rpc-client.js";
import { ServerStore } from "../src/infra/sqlite-store.js";
import { ApprovalService } from "../src/modules/approvals/approval-service.js";
import {
  ApprovalSignatureVerifier,
  patchSignatureTarget,
} from "../src/modules/approvals/approval-signatures.js";
import { RunnerEventService } from "../src/modules/runners/runner-event-service.js";
import { SessionCommandService } from "../src/modules/sessions/session-command-service.js";

describe("ApprovalSignatureVerifier", () => {
  it("allows unsigned mode and validates approval and patch signatures", () => {
    const signedAt = new Date().toISOString();
    const permissive = new ApprovalSignatureVerifier(undefined);
    expect(
      permissive.isApprovalSignatureValid("approval-1", true, signedAt, "bad"),
    ).toBe(true);

    const strict = new ApprovalSignatureVerifier("secret");
    const approvalSignature = signApproval(
      "secret",
      "approval-1",
      true,
      signedAt,
    );
    expect(
      strict.isApprovalSignatureValid(
        "approval-1",
        true,
        signedAt,
        approvalSignature,
      ),
    ).toBe(true);
    expect(
      strict.isApprovalSignatureValid(
        "approval-1",
        false,
        signedAt,
        approvalSignature,
      ),
    ).toBe(false);

    const patch = "--- a/README.md\n+++ b/README.md\n";
    const target = patchSignatureTarget("session-1", patch);
    expect(target).toBe(`patch:session-1:${hashPayload(patch)}`);
    const patchSignature = signApproval("secret", target, true, signedAt);
    expect(
      strict.isPatchSignatureValid(
        "session-1",
        patch,
        signedAt,
        patchSignature,
      ),
    ).toBe(true);
  });
});

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

  it("guards runner availability and agent support before starting sessions", () => {
    const hub = new ConnectionHub(store);
    const approvals = new ApprovalService(
      store,
      hub,
      new ApprovalSignatureVerifier(undefined),
    );
    const service = new SessionCommandService(store, hub, approvals);

    const offline = service.createSession({
      runnerId: "runner-1",
      agent: "codex",
      cwd: "/workspace",
      prompt: "hello",
    });
    expect(offline).toMatchObject({ ok: false, error: "runner_offline" });

    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const unsupported = service.createSession({
      runnerId: "runner-1",
      agent: "gemini",
      cwd: "/workspace",
      prompt: "hello",
    });
    expect(unsupported).toMatchObject({
      ok: false,
      error: "unsupported_agent",
    });

    const created = service.createSession({
      runnerId: "runner-1",
      agent: "codex",
      cwd: "/workspace",
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
    const session = store.createSession(sessionRecord());

    service.handle({
      type: "token",
      sessionId: session.id,
      content: "partial",
      encrypted: false,
    });
    expect(store.listMessages(session.id)).toMatchObject([
      { role: "assistant", content: "partial" },
    ]);
    expect(streamEvents).toContainEqual(
      expect.objectContaining({ type: "token", content: "partial" }),
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

function sessionRecord(): Session {
  const now = new Date().toISOString();
  return {
    id: "session-1",
    title: "Session",
    runnerId: "runner-1",
    agent: "codex",
    status: "running",
    cwd: "/workspace",
    createdAt: now,
    updatedAt: now,
  };
}

function fakeSocket<T>(messages: T[]): WebSocket {
  return {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((data: string) => {
      messages.push(JSON.parse(data) as T);
    }),
    close: vi.fn(),
    once: vi.fn(),
  } as unknown as WebSocket;
}
