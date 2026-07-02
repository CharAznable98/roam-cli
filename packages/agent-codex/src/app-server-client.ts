import { createHash, randomBytes } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
} from "./app-server-protocol.js";
import { isRecord } from "./app-server-protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export type CodexAppServerTransport = "jsonl" | "websocket";

export interface CodexAppServerClientOptions {
  child: ChildProcessWithoutNullStreams;
  transport?: CodexAppServerTransport;
  onNotification(notification: JsonRpcNotification): void | Promise<void>;
  onRequest(request: JsonRpcRequest): void | Promise<void>;
  onParseError?(error: Error): void | Promise<void>;
}

export class CodexAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #transport: CodexAppServerTransport;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #onNotification: CodexAppServerClientOptions["onNotification"];
  readonly #onRequest: CodexAppServerClientOptions["onRequest"];
  readonly #onParseError: CodexAppServerClientOptions["onParseError"];
  #buffer = "";
  #webSocketBuffer = Buffer.alloc(0);
  #webSocketHandshakeKey: string | undefined;
  #webSocketHandshakeComplete = false;
  #webSocketFailed = false;
  readonly #pendingWebSocketMessages: string[] = [];
  readonly #fragmentedWebSocketFrames: Buffer[] = [];
  readonly #lineQueue: string[] = [];
  #nextId = 1;
  #processing = false;

  public constructor(options: CodexAppServerClientOptions) {
    this.#child = options.child;
    this.#transport = options.transport ?? "jsonl";
    this.#onNotification = options.onNotification;
    this.#onRequest = options.onRequest;
    this.#onParseError = options.onParseError;
    if (this.#transport === "websocket") {
      this.#startWebSocketHandshake();
      this.#child.stdout.on("data", (chunk) => this.#readWebSocket(chunk));
    } else {
      this.#child.stdout.on("data", (chunk) => this.#readJsonl(chunk));
    }
  }

  public request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const message: JsonRpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write(message);
    });
  }

  public notify(method: string, params?: unknown): void {
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  public respond(id: JsonRpcId, result: unknown): void {
    this.#write({ id, result });
  }

  public reject(id: JsonRpcId, message: string, code = -32000): void {
    this.#write({ id, error: { code, message } });
  }

  public close(error = new Error("Codex app-server client closed")): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #write(message: unknown): void {
    if (this.#child.stdin.destroyed || !this.#child.stdin.writable) {
      return;
    }
    const serialized = JSON.stringify(message);
    if (this.#transport === "websocket") {
      this.#writeWebSocketText(serialized);
      return;
    }
    this.#child.stdin.write(`${serialized}\n`);
  }

  #readJsonl(chunk: string | Buffer): void {
    this.#buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      this.#lineQueue.push(line);
    }
    this.#processQueue();
  }

  #startWebSocketHandshake(): void {
    this.#webSocketHandshakeKey = randomBytes(16).toString("base64");
    this.#child.stdin.write(
      [
        "GET / HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${this.#webSocketHandshakeKey}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
  }

  #readWebSocket(chunk: string | Buffer): void {
    this.#webSocketBuffer = Buffer.concat([
      this.#webSocketBuffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
    ]);
    if (!this.#webSocketHandshakeComplete) {
      const headerEnd = this.#webSocketBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.#webSocketBuffer
        .subarray(0, headerEnd)
        .toString("utf8");
      this.#webSocketBuffer = this.#webSocketBuffer.subarray(headerEnd + 4);
      const error = this.#validateWebSocketHandshake(header);
      if (error) {
        this.#failWebSocket(error);
        return;
      }
      this.#webSocketHandshakeComplete = true;
      this.#flushPendingWebSocketMessages();
    }
    this.#readWebSocketFrames();
  }

  #validateWebSocketHandshake(header: string): Error | undefined {
    const lines = header.split(/\r?\n/);
    const statusLine = lines[0] ?? "";
    if (!/^HTTP\/1\.[01] 101(?:\s|$)/.test(statusLine)) {
      return new Error(
        `Codex app-server proxy websocket handshake failed: ${statusLine}`,
      );
    }
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        continue;
      }
      headers.set(
        line.slice(0, separator).trim().toLowerCase(),
        line.slice(separator + 1).trim(),
      );
    }
    const accept = headers.get("sec-websocket-accept");
    const expected = webSocketAcceptKey(this.#webSocketHandshakeKey ?? "");
    if (accept !== expected) {
      return new Error(
        "Codex app-server proxy returned an invalid websocket accept key",
      );
    }
    return undefined;
  }

  #failWebSocket(error: Error): void {
    this.#webSocketFailed = true;
    this.close(error);
    void this.#onParseError?.(error);
  }

  #flushPendingWebSocketMessages(): void {
    while (this.#pendingWebSocketMessages.length > 0) {
      const message = this.#pendingWebSocketMessages.shift();
      if (message !== undefined) {
        this.#sendWebSocketFrame(0x1, Buffer.from(message, "utf8"));
      }
    }
  }

  #writeWebSocketText(message: string): void {
    if (this.#webSocketFailed) {
      return;
    }
    if (!this.#webSocketHandshakeComplete) {
      this.#pendingWebSocketMessages.push(message);
      return;
    }
    this.#sendWebSocketFrame(0x1, Buffer.from(message, "utf8"));
  }

  #sendWebSocketFrame(opcode: number, payload: Buffer): void {
    if (this.#child.stdin.destroyed || !this.#child.stdin.writable) {
      return;
    }
    const mask = randomBytes(4);
    const length = payload.length;
    const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
    const frame = Buffer.alloc(headerLength + 4 + length);
    frame[0] = 0x80 | opcode;
    if (length < 126) {
      frame[1] = 0x80 | length;
    } else if (length <= 0xffff) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(length, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(length), 2);
    }
    mask.copy(frame, headerLength);
    for (let index = 0; index < length; index += 1) {
      frame[headerLength + 4 + index] =
        (payload[index] ?? 0) ^ (mask[index % mask.length] ?? 0);
    }
    this.#child.stdin.write(frame);
  }

  #readWebSocketFrames(): void {
    while (this.#webSocketBuffer.length >= 2) {
      const firstByte = this.#webSocketBuffer[0];
      const secondByte = this.#webSocketBuffer[1];
      if (firstByte === undefined || secondByte === undefined) {
        return;
      }
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let length = secondByte & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#webSocketBuffer.length < offset + 2) {
          return;
        }
        length = this.#webSocketBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.#webSocketBuffer.length < offset + 8) {
          return;
        }
        const bigLength = this.#webSocketBuffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.#failWebSocket(
            new Error("Codex app-server websocket frame is too large"),
          );
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }
      const maskOffset = offset;
      if (masked) {
        offset += 4;
      }
      if (this.#webSocketBuffer.length < offset + length) {
        return;
      }
      const mask = masked
        ? this.#webSocketBuffer.subarray(maskOffset, maskOffset + 4)
        : undefined;
      let payload: Buffer = Buffer.from(
        this.#webSocketBuffer.subarray(offset, offset + length),
      );
      this.#webSocketBuffer = this.#webSocketBuffer.subarray(offset + length);
      if (mask) {
        payload = unmaskWebSocketPayload(payload, mask);
      }
      this.#handleWebSocketFrame(opcode, fin, payload);
    }
  }

  #handleWebSocketFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      this.close(new Error("Codex app-server websocket closed"));
      return;
    }
    if (opcode === 0x9) {
      this.#sendWebSocketFrame(0xA, payload);
      return;
    }
    if (opcode === 0xA) {
      return;
    }
    if (opcode === 0x1 || opcode === 0x0) {
      if (
        opcode === 0x1 &&
        this.#fragmentedWebSocketFrames.length === 0 &&
        fin
      ) {
        this.#lineQueue.push(payload.toString("utf8"));
        this.#processQueue();
        return;
      }
      this.#fragmentedWebSocketFrames.push(payload);
      if (fin) {
        this.#lineQueue.push(
          Buffer.concat(this.#fragmentedWebSocketFrames).toString("utf8"),
        );
        this.#fragmentedWebSocketFrames.length = 0;
        this.#processQueue();
      }
      return;
    }
    this.#failWebSocket(
      new Error(`Unsupported Codex app-server websocket opcode: ${opcode}`),
    );
  }

  #processQueue(): void {
    if (this.#processing) {
      return;
    }
    this.#processing = true;
    void this.#drainQueue().finally(() => {
      this.#processing = false;
      if (this.#lineQueue.length > 0) {
        this.#processQueue();
      }
    });
  }

  async #drainQueue(): Promise<void> {
    while (this.#lineQueue.length > 0) {
      const line = this.#lineQueue.shift();
      if (line === undefined) {
        continue;
      }
      try {
        await this.#handleLine(line);
      } catch (error: unknown) {
        await this.#onParseError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  async #handleLine(line: string): Promise<void> {
    const message = parseJsonRpcMessage(line);
    if (isJsonRpcRequest(message)) {
      await this.#onRequest(message);
      return;
    }
    if (isJsonRpcNotification(message)) {
      await this.#onNotification(message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.id);
    if (isJsonRpcFailure(message)) {
      pending.reject(
        new Error(message.error.message ?? `Codex app-server error ${message.error.code ?? ""}`),
      );
      return;
    }
    pending.resolve(message.result);
  }
}

function parseJsonRpcMessage(line: string): JsonRpcMessage {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) {
    throw new Error("Codex app-server emitted a non-object JSON-RPC message");
  }
  if ("id" in parsed && typeof parsed.method === "string") {
    return {
      id: jsonRpcId(parsed.id),
      method: parsed.method,
      params: parsed.params,
    };
  }
  if (typeof parsed.method === "string") {
    return { method: parsed.method, params: parsed.params };
  }
  if ("id" in parsed && "error" in parsed && isRecord(parsed.error)) {
    const error: JsonRpcFailure["error"] = {};
    if (typeof parsed.error.code === "number") {
      error.code = parsed.error.code;
    }
    if (typeof parsed.error.message === "string") {
      error.message = parsed.error.message;
    }
    if ("data" in parsed.error) {
      error.data = parsed.error.data;
    }
    return {
      id: jsonRpcId(parsed.id),
      error,
    };
  }
  if ("id" in parsed) {
    return { id: jsonRpcId(parsed.id), result: parsed.result };
  }
  throw new Error("Codex app-server emitted an invalid JSON-RPC message");
}

function jsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  throw new Error("Codex app-server emitted a JSON-RPC message without a valid id");
}

function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message;
}

function isJsonRpcNotification(
  message: JsonRpcMessage,
): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

function isJsonRpcFailure(message: JsonRpcMessage): message is JsonRpcFailure {
  return "error" in message;
}

export function isJsonRpcSuccess(message: JsonRpcMessage): message is JsonRpcSuccess {
  return "result" in message;
}

function webSocketAcceptKey(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function unmaskWebSocketPayload(payload: Buffer, mask: Buffer): Buffer {
  const unmasked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    const payloadByte = payload[index] ?? 0;
    const maskByte = mask[index % mask.length] ?? 0;
    unmasked[index] = payloadByte ^ maskByte;
  }
  return unmasked;
}
