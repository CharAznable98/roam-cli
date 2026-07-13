import type {
  RunnerCommand,
  RunnerEvent,
  RunnerEventAck,
  RunnerEventNack,
  RunnerEventResume,
  RunnerRegistration,
} from "@roamcli/shared/protocol";
import {
  RunnerCommandSchema,
  RunnerEventAckSchema,
  RunnerEventNackSchema,
  RunnerEventResumeSchema,
} from "@roamcli/shared/protocol";
import type { AuditLog } from "../persistence/audit.js";
import type { EventCache, EventDeliveryState } from "../persistence/cache.js";

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void | Promise<void>;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event?: { data: unknown }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
export type RunnerCommandHandler = (
  command: RunnerCommand,
) => Promise<void> | void;

export interface RunnerConnectionOptions {
  serverUrl: string;
  token: string | undefined;
  registration: RunnerRegistration;
  cache: EventCache;
  audit: AuditLog;
  onCommand: RunnerCommandHandler;
  createSocket?: WebSocketFactory;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  ackNegotiationTimeoutMs?: number;
  ackTimeoutMs?: number;
}

type DeliveryMode = "ack_v1" | "legacy";

interface NegotiationState {
  socket: WebSocketLike;
  offer: EventDeliveryState;
  settled: boolean;
  resumeObserved: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(mode: DeliveryMode): void;
  reject(error: Error): void;
  promise: Promise<DeliveryMode>;
}

interface AckWaiter {
  socket: WebSocketLike;
  streamId: string;
  sequence: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: Error): void;
  promise: Promise<void>;
}

interface CommandReadySignal {
  settled: boolean;
  resolve(): void;
  promise: Promise<void>;
}

export class RunnerConnection {
  readonly #options: Omit<
    Required<RunnerConnectionOptions>,
    "token" | "createSocket"
  > & {
    token: string | undefined;
    createSocket: WebSocketFactory;
  };
  #socket?: WebSocketLike;
  #stopped = false;
  #connected = false;
  #attempt = 0;
  #fatalError?: Error;
  #mode: DeliveryMode | undefined;
  #negotiation?: NegotiationState;
  #ackWaiter: AckWaiter | undefined;
  #commandReady = createCommandReadySignal();
  #messageTail: Promise<void> = Promise.resolve();
  #controlTail: Promise<void> = Promise.resolve();
  #persistenceTail: Promise<void> = Promise.resolve();
  #outboundTail: Promise<void> = Promise.resolve();

  public constructor(options: RunnerConnectionOptions) {
    assertSecureServerUrl(options.serverUrl);
    this.#options = {
      ...options,
      token: options.token,
      createSocket: options.createSocket ?? createGlobalWebSocket,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      ackNegotiationTimeoutMs: options.ackNegotiationTimeoutMs ?? 500,
      ackTimeoutMs: options.ackTimeoutMs ?? 5_000,
    };
  }

  public async start(): Promise<never> {
    while (!this.#stopped) {
      await this.#connectOnce();
      if (this.#fatalError !== undefined) {
        throw this.#fatalError;
      }
      if (this.#stopped) {
        break;
      }
      const delay = backoffDelay(
        this.#attempt,
        this.#options.minBackoffMs,
        this.#options.maxBackoffMs,
      );
      this.#attempt += 1;
      await sleep(delay);
    }
    throw this.#fatalError ?? new Error("Runner connection stopped");
  }

  public stop(): void {
    this.#stopped = true;
    this.#connected = false;
    this.#releaseCommandWaiters();
    this.#cancelSocketOperations(
      this.#socket,
      new Error("Runner connection stopped"),
    );
    this.#socket?.close();
  }

  public send(event: RunnerEvent): Promise<void> {
    const persisted = this.#enqueuePersistence(async () => {
      await this.#options.audit.append("runner_event", auditMetadata(event));
      await this.#options.cache.append(event);
    });
    return persisted.then(() => {
      void this.#enqueueOutbound(() => this.#flushConnectedOutbox());
    });
  }

  async #connectOnce(): Promise<void> {
    const socket = this.#options.createSocket(this.#options.serverUrl);
    this.#socket = socket;
    this.#mode = undefined;
    this.#connected = false;
    this.#resetCommandReadySignal();

    await new Promise<void>((resolve) => {
      let opened = false;
      socket.addEventListener("open", () => {
        if (opened) {
          return;
        }
        if (this.#stopped || this.#socket !== socket) {
          this.#failSocket(socket);
          return;
        }
        opened = true;
        this.#connected = false;
        void this.#enqueueOutbound(() => this.#onOpen(socket)).catch(
          () => undefined,
        );
      });
      socket.addEventListener("message", (event) => {
        this.#handleSocketMessage(socket, event?.data);
      });
      socket.addEventListener("close", () => {
        this.#markDisconnected(socket);
        this.#cancelSocketOperations(
          socket,
          new Error("Runner websocket closed"),
        );
        resolve();
      });
      socket.addEventListener("error", () => {
        this.#markDisconnected(socket);
      });
    });
  }

  async #onOpen(socket: WebSocketLike): Promise<void> {
    try {
      const offer = await this.#options.cache.deliveryState();
      const backlogThrough = offer.nextSequence - 1;
      const negotiation = this.#startNegotiation(socket, offer);
      await this.#sendRaw(socket, {
        type: "runnerAuthenticate",
        token: this.#options.token ?? "",
        runner: this.#options.registration,
        eventDelivery: {
          protocol: "ack_v1",
          streamId: offer.streamId,
          acknowledgedThrough: offer.acknowledgedThrough,
        },
      });
      const mode = await negotiation.promise;
      if (this.#socket !== socket || socket.readyState !== 1) {
        throw new Error("Runner websocket closed during event negotiation");
      }
      this.#mode = mode;
      if (mode === "ack_v1") {
        await this.#flushAckOutbox(socket, backlogThrough);
      } else {
        await this.#options.cache.drainLegacy((event) =>
          this.#sendRaw(socket, event),
        );
      }
      if (
        !this.#stopped &&
        this.#socket === socket &&
        socket.readyState === 1
      ) {
        this.#connected = true;
        this.#attempt = 0;
        this.#releaseCommandWaiters();
      }
    } catch (error) {
      this.#failSocket(socket);
      throw error;
    }
  }

  #handleSocketMessage(socket: WebSocketLike, data: unknown): void {
    if (this.#stopped || this.#socket !== socket) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(socketText(data));
    } catch (error) {
      void this.#enqueueMessage(parsed, error).catch(
        (messageError: unknown) => void this.sendError(messageError),
      );
      return;
    }

    const resume = RunnerEventResumeSchema.safeParse(parsed);
    if (resume.success) {
      const negotiation = this.#negotiation;
      if (
        negotiation !== undefined &&
        negotiation.socket === socket &&
        !negotiation.settled
      ) {
        negotiation.resumeObserved = true;
        clearTimeout(negotiation.timer);
      }
      void this.#enqueueControl(() => this.#handleResume(socket, resume.data));
      return;
    }
    const ack = RunnerEventAckSchema.safeParse(parsed);
    if (ack.success) {
      void this.#enqueueControl(() => this.#handleAck(socket, ack.data));
      return;
    }
    const nack = RunnerEventNackSchema.safeParse(parsed);
    if (nack.success) {
      void this.#enqueueControl(() => this.#handleNack(socket, nack.data));
      return;
    }

    this.#downgradeNegotiation(socket);
    void this.#enqueueMessage(parsed).catch(
      (error: unknown) => void this.sendError(error),
    );
  }

  async #handleResume(
    socket: WebSocketLike,
    frame: RunnerEventResume,
  ): Promise<void> {
    const negotiation = this.#negotiation;
    if (
      negotiation === undefined ||
      negotiation.socket !== socket ||
      negotiation.settled ||
      this.#mode === "legacy"
    ) {
      return;
    }
    if (frame.streamId !== negotiation.offer.streamId) {
      this.#failClosed(
        socket,
        new Error(
          "Runner event resume stream does not match the offered stream",
        ),
      );
      return;
    }
    if (frame.ackThrough < negotiation.offer.acknowledgedThrough) {
      this.#failClosed(
        socket,
        new Error(
          `Server runner event high-water ${frame.ackThrough} is behind the local confirmed prefix ${negotiation.offer.acknowledgedThrough}`,
        ),
      );
      return;
    }
    try {
      await this.#options.cache.acknowledge(frame.streamId, frame.ackThrough);
      negotiation.settled = true;
      clearTimeout(negotiation.timer);
      negotiation.resolve("ack_v1");
    } catch (error) {
      this.#failClosed(socket, toError(error));
    }
  }

  async #handleAck(
    socket: WebSocketLike,
    frame: RunnerEventAck,
  ): Promise<void> {
    if (this.#socket !== socket || this.#mode !== "ack_v1") {
      return;
    }
    const waiter = this.#ackWaiter;
    if (waiter === undefined || waiter.socket !== socket) {
      return;
    }
    if (frame.streamId !== waiter.streamId) {
      this.#failClosed(
        socket,
        new Error(
          "Runner event ACK stream does not match the in-flight stream",
        ),
      );
      return;
    }
    try {
      await this.#options.cache.acknowledge(frame.streamId, frame.ackThrough);
      if (frame.ackThrough >= waiter.sequence) {
        this.#settleAckWaiter(waiter);
      }
    } catch (error) {
      this.#failClosed(socket, toError(error));
    }
  }

  async #handleNack(
    socket: WebSocketLike,
    frame: RunnerEventNack,
  ): Promise<void> {
    if (this.#socket !== socket || this.#mode !== "ack_v1") {
      return;
    }
    try {
      await this.#options.cache.acknowledge(frame.streamId, frame.ackThrough);
      const head = await this.#options.cache.peek();
      if (
        head === undefined ||
        head.streamId !== frame.streamId ||
        head.sequence !== frame.expectedSequence
      ) {
        this.#failClosed(
          socket,
          new Error(
            `Runner event NACK expected sequence ${frame.expectedSequence}, but the local outbox is not continuous`,
          ),
        );
        return;
      }
      const waiter = this.#ackWaiter;
      if (waiter?.socket === socket) {
        this.#settleAckWaiter(
          waiter,
          new Error(`Server rejected runner event sequence ${waiter.sequence}`),
        );
      }
    } catch (error) {
      this.#failClosed(socket, toError(error));
    }
  }

  async #onCommand(parsed: unknown): Promise<void> {
    const commandResult = RunnerCommandSchema.safeParse(parsed);
    if (!commandResult.success) {
      if (isServerErrorFrame(parsed)) {
        await this.#options.audit.append(
          "runner_ignored_server_error",
          auditMetadata(parsed),
        );
        return;
      }
      throw commandResult.error;
    }
    if (!(await this.#waitForCommandReady())) {
      return;
    }
    const command = commandResult.data;
    await this.#options.audit.append("runner_command", auditMetadata(command));
    await this.#options.onCommand(command);
  }

  #enqueueMessage(parsed: unknown, parseError?: unknown): Promise<void> {
    const operation = this.#messageTail.then(() => {
      if (parseError !== undefined) {
        throw parseError;
      }
      return this.#onCommand(parsed);
    });
    this.#messageTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  #enqueueControl(operation: () => Promise<void>): Promise<void> {
    const result = this.#controlTail.then(operation);
    this.#controlTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #enqueueOutbound(operation: () => Promise<void>): Promise<void> {
    const result = this.#outboundTail.then(operation);
    this.#outboundTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    const result = this.#persistenceTail.then(operation);
    this.#persistenceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async sendError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.send({
      type: "error",
      message,
      code: "RUNNER_CONNECTION_ERROR",
    });
  }

  async #flushConnectedOutbox(): Promise<void> {
    const socket = this.#socket;
    if (!this.#connected || socket === undefined || socket.readyState !== 1) {
      return;
    }
    try {
      if (this.#mode === "ack_v1") {
        await this.#flushAckOutbox(socket);
      } else if (this.#mode === "legacy") {
        await this.#options.cache.drainLegacy((event) =>
          this.#sendRaw(socket, event),
        );
      }
    } catch {
      this.#failSocket(socket);
    }
  }

  async #flushAckOutbox(
    socket: WebSocketLike,
    throughSequence = Number.MAX_SAFE_INTEGER,
  ): Promise<void> {
    while (true) {
      const entry = await this.#options.cache.peek();
      if (entry === undefined || entry.sequence > throughSequence) {
        return;
      }
      const waiter = this.#startAckWaiter(
        socket,
        entry.streamId,
        entry.sequence,
      );
      try {
        const send = this.#sendRaw(socket, {
          type: "runnerEvent",
          protocol: "ack_v1",
          streamId: entry.streamId,
          sequence: entry.sequence,
          event: entry.event,
        });
        await Promise.race([send, waiter.promise]);
        await send;
        await waiter.promise;
      } catch (error) {
        this.#settleAckWaiter(waiter, toError(error));
        throw error;
      }
    }
  }

  #startNegotiation(
    socket: WebSocketLike,
    offer: EventDeliveryState,
  ): NegotiationState {
    let resolvePromise!: (mode: DeliveryMode) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<DeliveryMode>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const negotiation: NegotiationState = {
      socket,
      offer,
      settled: false,
      resumeObserved: false,
      timer: setTimeout(() => {
        if (
          !negotiation.settled &&
          !negotiation.resumeObserved &&
          this.#socket === socket
        ) {
          negotiation.settled = true;
          negotiation.resolve("legacy");
        }
      }, this.#options.ackNegotiationTimeoutMs),
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
    };
    this.#negotiation = negotiation;
    return negotiation;
  }

  #downgradeNegotiation(socket: WebSocketLike): void {
    const negotiation = this.#negotiation;
    if (
      negotiation === undefined ||
      negotiation.socket !== socket ||
      negotiation.settled ||
      negotiation.resumeObserved
    ) {
      return;
    }
    negotiation.settled = true;
    clearTimeout(negotiation.timer);
    negotiation.resolve("legacy");
  }

  #startAckWaiter(
    socket: WebSocketLike,
    streamId: string,
    sequence: number,
  ): AckWaiter {
    if (this.#ackWaiter !== undefined) {
      throw new Error("Runner event delivery already has an ACK in flight");
    }
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    void promise.catch(() => undefined);
    const waiter: AckWaiter = {
      socket,
      streamId,
      sequence,
      timer: setTimeout(() => {
        this.#settleAckWaiter(
          waiter,
          new Error(`Timed out waiting for runner event ACK ${sequence}`),
        );
      }, this.#options.ackTimeoutMs),
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
    };
    this.#ackWaiter = waiter;
    return waiter;
  }

  #settleAckWaiter(waiter: AckWaiter, error?: Error): void {
    if (this.#ackWaiter !== waiter) {
      return;
    }
    this.#ackWaiter = undefined;
    clearTimeout(waiter.timer);
    if (error === undefined) {
      waiter.resolve();
    } else {
      waiter.reject(error);
    }
  }

  #cancelSocketOperations(
    socket: WebSocketLike | undefined,
    error: Error,
  ): void {
    if (socket === undefined) {
      return;
    }
    const negotiation = this.#negotiation;
    if (
      negotiation !== undefined &&
      negotiation.socket === socket &&
      !negotiation.settled
    ) {
      negotiation.settled = true;
      clearTimeout(negotiation.timer);
      negotiation.resolve("legacy");
    }
    const waiter = this.#ackWaiter;
    if (waiter?.socket === socket) {
      this.#settleAckWaiter(waiter, error);
    }
  }

  #failClosed(socket: WebSocketLike, error: Error): void {
    this.#fatalError = error;
    this.#stopped = true;
    this.#releaseCommandWaiters();
    this.#cancelSocketOperations(socket, error);
    this.#failSocket(socket);
  }

  #failSocket(socket: WebSocketLike): void {
    this.#markDisconnected(socket);
    if (socket.readyState === 0 || socket.readyState === 1) {
      socket.close();
    }
  }

  async #waitForCommandReady(): Promise<boolean> {
    while (!this.#stopped) {
      if (
        this.#connected &&
        this.#socket !== undefined &&
        this.#socket.readyState === 1
      ) {
        return true;
      }
      const signal = this.#commandReady;
      await signal.promise;
    }
    return false;
  }

  #markDisconnected(socket: WebSocketLike): void {
    if (this.#socket !== socket) {
      return;
    }
    this.#connected = false;
    this.#resetCommandReadySignal();
  }

  #resetCommandReadySignal(): void {
    if (!this.#stopped && this.#commandReady.settled) {
      this.#commandReady = createCommandReadySignal();
    }
  }

  #releaseCommandWaiters(): void {
    if (!this.#commandReady.settled) {
      this.#commandReady.settled = true;
      this.#commandReady.resolve();
    }
  }

  async #sendRaw(socket: WebSocketLike, value: unknown): Promise<void> {
    if (this.#socket !== socket || socket.readyState !== 1) {
      throw new Error("Runner websocket is not open");
    }
    await socket.send(JSON.stringify(value));
  }
}

export function backoffDelay(
  attempt: number,
  minMs: number,
  maxMs: number,
): number {
  return Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
}

function createCommandReadySignal(): CommandReadySignal {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    settled: false,
    resolve: resolvePromise,
    promise,
  };
}

function socketText(data: unknown): string {
  return typeof data === "string"
    ? data
    : Buffer.isBuffer(data)
      ? data.toString("utf8")
      : String(data);
}

function createGlobalWebSocket(url: string): WebSocketLike {
  const WebSocketCtor = globalThis.WebSocket;
  if (WebSocketCtor === undefined) {
    throw new Error("Global WebSocket is unavailable in this Node runtime");
  }
  return new WebSocketCtor(url) as WebSocketLike;
}

function assertSecureServerUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol === "wss:") {
    return;
  }
  if (url.protocol === "ws:" && isLoopbackHostname(url.hostname)) {
    return;
  }
  throw new Error(
    "Runner connection rejects plaintext WebSocket URLs except on loopback",
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function isServerErrorFrame(value: unknown): value is { type: "error" } {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "error"
  );
}

function auditMetadata(value: unknown): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (value !== null && typeof value === "object") {
    for (const key of [
      "type",
      "sessionId",
      "requestId",
      "approvalId",
      "inputRequestId",
      "outputId",
      "attachmentId",
      "imageId",
      "status",
      "code",
    ]) {
      if (key in value) {
        const item = value[key as keyof typeof value];
        if (
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean"
        ) {
          metadata[key] = item;
        }
      }
    }
  }
  const serialized = JSON.stringify(value);
  metadata.sizeBytes =
    serialized === undefined ? 0 : Buffer.byteLength(serialized);
  return metadata;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
