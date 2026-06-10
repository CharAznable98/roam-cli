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
  ArtifactStorage,
  CreateArtifactRequestSchema,
} from "../src/infra/local-artifact-storage.js";
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
import { ArtifactService } from "../src/modules/artifacts/artifact-service.js";
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

  it("rolls back session creation when startSession cannot be delivered", () => {
    const hub = new ConnectionHub(store);
    const approvals = new ApprovalService(
      store,
      hub,
      new ApprovalSignatureVerifier(undefined),
    );
    const service = new SessionCommandService(store, hub, approvals);
    hub.registerRunner(runnerRegistration(), fakeSocket<RunnerCommand>([], 3));

    const result = service.createSession({
      runnerId: "runner-1",
      agent: "codex",
      cwd: "/workspace",
      prompt: "hello",
    });

    expect(result).toMatchObject({ ok: false, error: "runner_offline" });
    expect(store.listSessions()).toEqual([]);
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
    const service = new ApprovalService(
      store,
      hub,
      new ApprovalSignatureVerifier(undefined),
    );
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
      signedAt: new Date().toISOString(),
      signature: "unsigned",
    });
    expect(offline).toMatchObject({ ok: false, error: "runner_offline" });
    expect(store.getApproval("approval-1")?.status).toBe("pending");

    const runnerMessages: RunnerCommand[] = [];
    hub.registerRunner(runnerRegistration(), fakeSocket(runnerMessages));
    const resolved = service.respondToApproval("approval-1", {
      approved: true,
      signedAt: new Date().toISOString(),
      signature: "unsigned",
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
      signedAt: new Date().toISOString(),
      signature: "unsigned",
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
      { role: "assistant", content: "partial", encrypted: false },
    ]);
    expect(streamEvents).toContainEqual(
      expect.objectContaining({ type: "token", content: "partial" }),
    );

    service.handle({
      type: "token",
      sessionId: session.id,
      content: "secret",
      encrypted: true,
    });
    expect(store.listMessages(session.id).at(-1)).toMatchObject({
      role: "assistant",
      content: "secret",
      encrypted: true,
    });

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
