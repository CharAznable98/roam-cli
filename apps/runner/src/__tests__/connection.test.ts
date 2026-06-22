import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  type RunnerRegistration,
} from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "../persistence/audit.js";
import { EventCache } from "../persistence/cache.js";
import {
  backoffDelay,
  RunnerConnection,
  type WebSocketLike,
} from "../transport/connection.js";

class FakeSocket implements WebSocketLike {
  public readyState = 0;
  public sent: string[] = [];
  readonly #listeners = new Map<
    string,
    Array<(event?: { data: unknown }) => void>
  >();

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  public addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event?: { data: unknown }) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  public emit(
    type: "open" | "message" | "close" | "error",
    event?: { data: unknown },
  ): void {
    if (type === "open") {
      this.readyState = 1;
    }
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("RunnerConnection", () => {
  it("uses bounded exponential backoff", () => {
    expect(backoffDelay(0, 100, 1_000)).toBe(100);
    expect(backoffDelay(3, 100, 1_000)).toBe(800);
    expect(backoffDelay(10, 100, 1_000)).toBe(1_000);
  });

  it("registers on websocket open and handles server commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-"));
    const socket = new FakeSocket();
    const handled: string[] = [];
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache: new EventCache(join(dir, "pending.jsonl")),
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: (command) => {
        handled.push(command.type);
      },
      createSocket: (url) => {
        expect(url).toBe("wss://example.test/runners");
        return socket;
      },
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });

    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await Promise.resolve();
    socket.emit("message", {
      data: JSON.stringify({
        type: "deliverInput",
        sessionId: "s1",
        content: "hello",
      }),
    });
    await vi.waitFor(() => {
      expect(handled).toEqual(["deliverInput"]);
    });
    connection.stop();

    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      type: "runnerAuthenticate",
      token: "secret",
      runner: { runnerId: "r1" },
    });
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("ignores server error frames instead of echoing them as runner errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-"));
    const socket = new FakeSocket();
    const handled: string[] = [];
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache: new EventCache(join(dir, "pending.jsonl")),
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: (command) => {
        handled.push(command.type);
      },
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });

    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await Promise.resolve();
    socket.emit("message", {
      data: JSON.stringify({
        type: "error",
        message: "invalid runner event",
        code: "invalid_runner_event",
      }),
    });
    await Promise.resolve();
    connection.stop();

    expect(handled).toEqual([]);
    expect(
      socket.sent.map((item) => JSON.parse(item) as { type: string }),
    ).toEqual([expect.objectContaining({ type: "runnerAuthenticate" })]);
    await expect(started).resolves.toBeInstanceOf(Error);
  });
});

function testRegistration(workspaceRoot: string): RunnerRegistration {
  return {
    runnerId: "r1",
    displayName: "Runner r1",
    hostname: "host",
    workspaceRoot,
    profile: "standard",
    publicKey: "0123456789abcdef",
    capabilities: [
      {
        kind: "codex",
        label: "Codex",
        command: "codex",
        args: [],
        parser: "codex-json",
        supportsResume: true,
        supportsImages: false,
        supportedImageMimeTypes: [],
        maxImagesPerTurn: 0,
        maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
        pluginName: "@roamcli/agent-codex",
        pluginVersion: "1.1.0",
      },
    ],
    version: "1.0.0",
  };
}
