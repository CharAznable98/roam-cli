import { mkdtemp, readFile } from "node:fs/promises";
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
  public sendError: Error | undefined;
  public sendHook: ((data: string) => Promise<void> | void) | undefined;
  readonly #listeners = new Map<
    string,
    Array<(event?: { data: unknown }) => void>
  >();

  public send(data: string): Promise<void> | void {
    if (this.sendError !== undefined) {
      throw this.sendError;
    }
    this.sent.push(data);
    return this.sendHook?.(data);
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

  it("rejects a plaintext websocket connection to a non-loopback server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-"));

    expect(
      () =>
        new RunnerConnection({
          serverUrl: "ws://example.test/runners",
          token: "secret",
          registration: testRegistration(dir),
          cache: new EventCache(join(dir, "pending.jsonl")),
          audit: new AuditLog(join(dir, "audit.jsonl")),
          onCommand: () => undefined,
          createSocket: () => new FakeSocket(),
        }),
    ).toThrow(/plaintext.*loopback/i);
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
    socket.emit("open");
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
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
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
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

  it("caches a live event when the websocket send fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-"));
    const socket = new FakeSocket();
    const cache = new EventCache(join(dir, "pending.jsonl"));
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    socket.sendError = new Error("socket write failed");

    await expect(
      connection.send({
        type: "sessionStatus",
        sessionId: "s1",
        status: "running",
      }),
    ).resolves.toBeUndefined();

    expect((await cache.readAll()).map((entry) => entry.event.type)).toEqual([
      "sessionStatus",
    ]);
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("sends cached events before a live event emitted while authentication is pending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "cached",
      status: "running",
    });
    const socket = new FakeSocket();
    let markAuthenticationStarted!: () => void;
    const authenticationStarted = new Promise<void>((resolve) => {
      markAuthenticationStarted = resolve;
    });
    let releaseAuthentication!: () => void;
    const authenticationGate = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    socket.sendHook = async (data) => {
      const value = JSON.parse(data) as { type?: string };
      if (value.type === "runnerAuthenticate") {
        markAuthenticationStarted();
        await authenticationGate;
      }
    };
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await authenticationStarted;

    const liveSend = connection.send({
      type: "sessionStatus",
      sessionId: "live",
      status: "running",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await vi.waitFor(async () => {
      expect(
        (await cache.readAll()).map((entry) =>
          entry.event.type === "sessionStatus"
            ? entry.event.sessionId
            : entry.event.type,
        ),
      ).toEqual(["cached", "live"]);
    });
    expect(
      socket.sent.map((item) => (JSON.parse(item) as { type: string }).type),
    ).toEqual(["runnerAuthenticate"]);

    releaseAuthentication();
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "legacy",
      }),
    });
    await liveSend;
    await vi.waitFor(async () => {
      expect(
        socket.sent.map((item) => {
          const value = JSON.parse(item) as {
            type: string;
            sessionId?: string;
          };
          return value.sessionId ?? value.type;
        }),
      ).toEqual(["runnerAuthenticate", "cached", "live"]);
      expect(await cache.readAll()).toEqual([]);
    });
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("caches later live events behind the event whose websocket send failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-"));
    const firstSocket = new FakeSocket();
    const replacementSocket = new FakeSocket();
    const sockets = [firstSocket, replacementSocket];
    const cache = new EventCache(join(dir, "pending.jsonl"));
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => sockets.shift() ?? new FakeSocket(),
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const started = connection.start().catch((error: unknown) => error);
    firstSocket.emit("open");
    await vi.waitFor(() => {
      expect(firstSocket.sent).toHaveLength(1);
    });
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "legacy",
      }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstSocket.sendError = new Error("socket write failed");

    const running = connection.send({
      type: "sessionStatus",
      sessionId: "s1",
      status: "running",
    });
    const completed = connection.send({
      type: "sessionStatus",
      sessionId: "s1",
      status: "completed",
    });
    await Promise.all([running, completed]);

    expect(
      (await cache.readAll()).map((entry) =>
        entry.event.type === "sessionStatus"
          ? entry.event.status
          : entry.event.type,
      ),
    ).toEqual(["running", "completed"]);
    await vi.waitFor(() => expect(firstSocket.readyState).toBe(3));
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("handles server commands sequentially in websocket arrival order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-"));
    const socket = new FakeSocket();
    const commandStarts: string[] = [];
    const commandCompletions: string[] = [];
    let releaseFirst!: () => void;
    const firstCommandGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache: new EventCache(join(dir, "pending.jsonl")),
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: async (command) => {
        if (command.type !== "deliverInput") {
          return;
        }
        commandStarts.push(command.content);
        if (command.content === "first") {
          await firstCommandGate;
        }
        commandCompletions.push(command.content);
      },
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    socket.emit("message", {
      data: JSON.stringify({
        type: "deliverInput",
        sessionId: "s1",
        content: "first",
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "deliverInput",
        sessionId: "s1",
        content: "second",
      }),
    });
    await vi.waitFor(() => {
      expect(commandStarts.length).toBeGreaterThan(0);
    });
    expect(commandStarts).toEqual(["first"]);

    releaseFirst();
    await vi.waitFor(() => {
      expect(commandCompletions).toEqual(["first", "second"]);
    });
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("negotiates ACK v1, sends stop-and-wait, and gates commands on backlog ACKs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-ack-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "first",
      status: "running",
    });
    await cache.append({
      type: "sessionStatus",
      sessionId: "second",
      status: "running",
    });
    const socket = new FakeSocket();
    const handled: string[] = [];
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: (command) => {
        handled.push(command.type);
      },
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 1_000,
      ackTimeoutMs: 1_000,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const auth = JSON.parse(socket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };

    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "deliverInput",
        sessionId: "s1",
        content: "queued until backlog commits",
      }),
    });

    await vi.waitFor(() => {
      expect(eventEnvelopes(socket)).toHaveLength(1);
    });
    expect(handled).toEqual([]);
    expect(await cache.readAll()).toHaveLength(2);

    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventAck",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 1,
      }),
    });
    await vi.waitFor(() => {
      expect(eventEnvelopes(socket)).toHaveLength(2);
    });
    expect(handled).toEqual([]);

    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventAck",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 2,
      }),
    });
    await vi.waitFor(() => {
      expect(handled).toEqual(["deliverInput"]);
    });
    expect(await cache.readAll()).toEqual([]);
    expect(
      eventEnvelopes(socket).map((frame) => [
        frame.sequence,
        frame.event.sessionId,
      ]),
    ).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("keeps ACK negotiation pending beyond 500ms and then sends envelopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-slow-resume-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "slow-resume",
      status: "running",
    });
    const socket = new FakeSocket();
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 2_000,
      ackTimeoutMs: 1_000,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const auth = JSON.parse(socket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };

    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    expect(socket.readyState).toBe(1);
    expect(eventEnvelopes(socket)).toEqual([]);
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });

    await vi.waitFor(() => expect(eventEnvelopes(socket)).toHaveLength(1));
    expect(eventEnvelopes(socket)[0]).toMatchObject({
      sequence: 1,
      event: { sessionId: "slow-resume" },
    });
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("uses raw delivery only after an explicit legacy protocol signal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-explicit-legacy-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "legacy",
      status: "running",
    });
    const socket = new FakeSocket();
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 1_000,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "legacy",
      }),
    });

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: "sessionStatus",
      sessionId: "legacy",
    });
    expect(eventEnvelopes(socket)).toEqual([]);
    expect(await cache.readAll()).toEqual([]);
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("reconnects after negotiation timeout and releases queued commands after resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-resume-timeout-"));
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "queued-across-negotiation-timeout",
      status: "running",
    });
    const handled: string[] = [];
    let markFirstAuthenticated!: () => void;
    const firstAuthenticated = new Promise<void>((resolve) => {
      markFirstAuthenticated = resolve;
    });
    let markSecondAuthenticated!: (streamId: string) => void;
    const secondAuthenticated = new Promise<string>((resolve) => {
      markSecondAuthenticated = resolve;
    });
    let markEnvelopeSent!: () => void;
    const envelopeSent = new Promise<void>((resolve) => {
      markEnvelopeSent = resolve;
    });
    let markCommandHandled!: () => void;
    const commandHandled = new Promise<void>((resolve) => {
      markCommandHandled = resolve;
    });
    firstSocket.sendHook = (data) => {
      const frame = JSON.parse(data) as { type?: string };
      if (frame.type === "runnerAuthenticate") {
        markFirstAuthenticated();
      }
    };
    secondSocket.sendHook = (data) => {
      const frame = JSON.parse(data) as {
        type?: string;
        eventDelivery?: { streamId: string };
      };
      if (frame.type === "runnerAuthenticate" && frame.eventDelivery) {
        const { streamId } = frame.eventDelivery;
        markSecondAuthenticated(streamId);
        queueMicrotask(() => {
          secondSocket.emit("message", {
            data: JSON.stringify({
              type: "runnerEventResume",
              protocol: "ack_v1",
              streamId,
              ackThrough: 0,
            }),
          });
        });
      } else if (frame.type === "runnerEvent") {
        markEnvelopeSent();
      }
    };

    vi.useFakeTimers();
    let connection: RunnerConnection | undefined;
    let started: Promise<unknown> | undefined;
    try {
      connection = new RunnerConnection({
        serverUrl: "wss://example.test/runners",
        token: "secret",
        registration: testRegistration(dir),
        cache,
        audit: new AuditLog(join(dir, "audit.jsonl")),
        onCommand: (command) => {
          handled.push(command.type);
          markCommandHandled();
        },
        createSocket: () => {
          const socket = sockets.shift() ?? new FakeSocket();
          if (socket === secondSocket) {
            queueMicrotask(() => socket.emit("open"));
          }
          return socket;
        },
        minBackoffMs: 1,
        maxBackoffMs: 1,
        ackNegotiationTimeoutMs: 25,
        ackTimeoutMs: 1_000,
      });
      started = connection.start().catch((error: unknown) => error);
      firstSocket.emit("open");
      await firstAuthenticated;

      // Drive only the first negotiation past its deadline. Advancing the
      // reconnect backoff then creates the second socket; its send hook emits
      // resume as a microtask before any further fake time can elapse.
      await vi.advanceTimersByTimeAsync(25);
      expect(firstSocket.readyState).toBe(3);
      expect(handled).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const streamId = await secondAuthenticated;
      await envelopeSent;

      secondSocket.emit("message", {
        data: JSON.stringify({
          type: "deliverInput",
          sessionId: "s1",
          content: "after reconnect",
        }),
      });
      await Promise.resolve();
      expect(handled).toEqual([]);
      secondSocket.emit("message", {
        data: JSON.stringify({
          type: "runnerEventAck",
          protocol: "ack_v1",
          streamId,
          ackThrough: 1,
        }),
      });
      await commandHandled;
      expect(handled).toEqual(["deliverInput"]);
      connection.stop();
      await expect(started).resolves.toBeInstanceOf(Error);
    } finally {
      connection?.stop();
      await started;
      vi.useRealTimers();
    }
  });

  it("waits for a handshake send to persist and receive its ACK before running commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-handshake-tail-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "snapshot",
      status: "running",
    });
    const append = cache.append.bind(cache);
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    vi.spyOn(cache, "append").mockImplementation(async (event) => {
      if (event.type === "sessionStatus" && event.sessionId === "handshake-tail") {
        markAppendStarted();
        await appendGate;
      }
      return append(event);
    });
    const socket = new FakeSocket();
    const handled: string[] = [];
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: (command) => {
        if (command.type === "deliverInput") {
          handled.push(command.content);
        }
      },
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 1_000,
      ackTimeoutMs: 1_000,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const auth = JSON.parse(socket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });

    await vi.waitFor(() => expect(eventEnvelopes(socket)).toHaveLength(1));
    const liveSend = connection.send({
      type: "sessionStatus",
      sessionId: "handshake-tail",
      status: "running",
    });
    await appendStarted;
    socket.emit("message", {
      data: JSON.stringify({
        type: "deliverInput",
        sessionId: "s1",
        content: "after durable handshake tail",
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventAck",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 1,
      }),
    });
    await new Promise<void>((resolve) => {
      setImmediate(() => setImmediate(resolve));
    });
    expect(handled).toEqual([]);

    releaseAppend();
    await liveSend;
    await vi.waitFor(() => expect(eventEnvelopes(socket)).toHaveLength(2));
    expect(
      eventEnvelopes(socket).map((frame) => [
        frame.sequence,
        frame.event.sessionId,
      ]),
    ).toEqual([
      [1, "snapshot"],
      [2, "handshake-tail"],
    ]);
    expect(handled).toEqual([]);
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventAck",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(handled).toEqual(["after durable handshake tail"]),
    );
    await vi.waitFor(async () => expect(await cache.readAll()).toEqual([]));
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("advances a large stop-and-wait backlog without calling readAll per ACK", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-linear-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    for (let index = 0; index < 24; index += 1) {
      await cache.append({
        type: "sessionStatus",
        sessionId: `backlog-${index}`,
        status: "running",
      });
    }
    const readAll = vi.spyOn(cache, "readAll");
    const socket = new FakeSocket();
    socket.sendHook = (data) => {
      const frame = JSON.parse(data) as {
        type?: string;
        streamId?: string;
        sequence?: number;
      };
      if (
        frame.type === "runnerEvent" &&
        frame.streamId !== undefined &&
        frame.sequence !== undefined
      ) {
        queueMicrotask(() => {
          socket.emit("message", {
            data: JSON.stringify({
              type: "runnerEventAck",
              protocol: "ack_v1",
              streamId: frame.streamId,
              ackThrough: frame.sequence,
            }),
          });
        });
      }
    };
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 1_000,
      ackTimeoutMs: 1_000,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const auth = JSON.parse(socket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });

    await vi.waitFor(() => expect(eventEnvelopes(socket)).toHaveLength(24), {
      timeout: 5_000,
    });
    await vi.waitFor(async () =>
      expect((await cache.deliveryState()).acknowledgedThrough).toBe(24),
    );
    expect(readAll).not.toHaveBeenCalled();
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("keeps a command queued across reconnect until the backlog is acknowledged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-command-reconnect-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "backlog",
      status: "running",
    });
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const handled: string[] = [];
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: (command) => {
        if (command.type === "deliverInput") {
          handled.push(command.content);
        }
      },
      createSocket: () => {
        const socket = sockets.shift() ?? new FakeSocket();
        if (socket === secondSocket) {
          setImmediate(() => socket.emit("open"));
        }
        return socket;
      },
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 1_000,
      ackTimeoutMs: 1_000,
    });
    const started = connection.start().catch((error: unknown) => error);
    firstSocket.emit("open");
    await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));
    const firstAuth = JSON.parse(firstSocket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: firstAuth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "deliverInput",
        sessionId: "s1",
        content: "survives reconnect",
      }),
    });
    await vi.waitFor(() => expect(eventEnvelopes(firstSocket)).toHaveLength(1));
    firstSocket.close();
    expect(handled).toEqual([]);

    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1));
    const secondAuth = JSON.parse(secondSocket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    secondSocket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: secondAuth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });
    await vi.waitFor(() =>
      expect(eventEnvelopes(secondSocket)).toHaveLength(1),
    );
    secondSocket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventAck",
        protocol: "ack_v1",
        streamId: secondAuth.eventDelivery.streamId,
        ackThrough: 1,
      }),
    });

    await vi.waitFor(() => expect(handled).toEqual(["survives reconnect"]));
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("resolves a live send after durable append while retaining it until ACK", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-live-ack-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    const socket = new FakeSocket();
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 1_000,
      ackTimeoutMs: 1_000,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const auth = JSON.parse(socket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });

    await expect(
      connection.send({
        type: "sessionStatus",
        sessionId: "live",
        status: "running",
      }),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(eventEnvelopes(socket)).toHaveLength(1));
    expect(await cache.readAll()).toHaveLength(1);

    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventAck",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 1,
      }),
    });
    await vi.waitFor(async () => expect(await cache.readAll()).toEqual([]));
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("closes on ACK timeout even when the websocket send promise is delayed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-delayed-send-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "delayed",
      status: "running",
    });
    const socket = new FakeSocket();
    socket.sendHook = (data) => {
      const frame = JSON.parse(data) as { type?: string };
      return frame.type === "runnerEvent"
        ? new Promise<void>(() => undefined)
        : undefined;
    };
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 1_000,
      ackTimeoutMs: 20,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const auth = JSON.parse(socket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });

    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    expect(await cache.readAll()).toHaveLength(1);
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("fails closed when an ACK names a different stream", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-ack-stream-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "stream",
      status: "running",
    });
    const socket = new FakeSocket();
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 1_000,
      ackTimeoutMs: 1_000,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const auth = JSON.parse(socket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });
    await vi.waitFor(() => expect(eventEnvelopes(socket)).toHaveLength(1));
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventAck",
        protocol: "ack_v1",
        streamId: "00000000-0000-4000-8000-000000000001",
        ackThrough: 1,
      }),
    });

    await expect(started).resolves.toMatchObject({
      message: expect.stringMatching(/ACK stream does not match/i),
    });
    expect(socket.readyState).toBe(3);
  });

  it("uses resume high-water after an ACK is lost without replaying committed work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-resume-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "once",
      status: "running",
    });
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => {
        const socket = sockets.shift() ?? new FakeSocket();
        if (socket === secondSocket) {
          setImmediate(() => socket.emit("open"));
        }
        return socket;
      },
      minBackoffMs: 1,
      maxBackoffMs: 1,
      ackNegotiationTimeoutMs: 1_000,
      ackTimeoutMs: 25,
    });
    const started = connection.start().catch((error: unknown) => error);
    firstSocket.emit("open");
    await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));
    const firstAuth = JSON.parse(firstSocket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: firstAuth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });
    await vi.waitFor(() => expect(eventEnvelopes(firstSocket)).toHaveLength(1));

    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1));
    const secondAuth = JSON.parse(secondSocket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    expect(secondAuth.eventDelivery.streamId).toBe(
      firstAuth.eventDelivery.streamId,
    );
    secondSocket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: secondAuth.eventDelivery.streamId,
        ackThrough: 1,
      }),
    });
    await vi.waitFor(async () => expect(await cache.readAll()).toEqual([]));
    expect(eventEnvelopes(secondSocket)).toEqual([]);
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);
  });

  it("fails closed when the server high-water regresses behind local confirmation", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "roam-runner-connection-regress-"),
    );
    const cache = new EventCache(join(dir, "pending.jsonl"));
    const entry = await cache.append({
      type: "sessionStatus",
      sessionId: "confirmed",
      status: "running",
    });
    await cache.acknowledge(entry.streamId, entry.sequence);
    const socket = new FakeSocket();
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache,
      audit: new AuditLog(join(dir, "audit.jsonl")),
      onCommand: () => undefined,
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const auth = JSON.parse(socket.sent[0]!) as {
      eventDelivery: { streamId: string };
    };
    socket.emit("message", {
      data: JSON.stringify({
        type: "runnerEventResume",
        protocol: "ack_v1",
        streamId: auth.eventDelivery.streamId,
        ackThrough: 0,
      }),
    });

    await expect(started).resolves.toMatchObject({
      message: expect.stringMatching(/behind the local confirmed prefix/i),
    });
    expect(socket.readyState).toBe(3);
  });

  it("audits command metadata without persisting prompt content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-connection-"));
    const auditPath = join(dir, "audit.jsonl");
    const socket = new FakeSocket();
    const handled: string[] = [];
    const connection = new RunnerConnection({
      serverUrl: "wss://example.test/runners",
      token: "secret",
      registration: testRegistration(dir),
      cache: new EventCache(join(dir, "pending.jsonl")),
      audit: new AuditLog(auditPath),
      onCommand: (command) => {
        handled.push(command.type);
      },
      createSocket: () => socket,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const started = connection.start().catch((error: unknown) => error);
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({
        type: "deliverInput",
        sessionId: "s1",
        content: "do not persist this sensitive prompt",
      }),
    });
    await vi.waitFor(() => {
      expect(handled).toEqual(["deliverInput"]);
    });
    connection.stop();
    await expect(started).resolves.toBeInstanceOf(Error);

    const auditContent = await readFile(auditPath, "utf8");
    expect(auditContent).toContain("deliverInput");
    expect(auditContent).not.toContain("do not persist this sensitive prompt");
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

function eventEnvelopes(socket: FakeSocket): Array<{
  sequence: number;
  event: { sessionId?: string };
}> {
  return socket.sent
    .map((item) => JSON.parse(item) as Record<string, unknown>)
    .filter((item) => item.type === "runnerEvent") as Array<{
    sequence: number;
    event: { sessionId?: string };
  }>;
}
