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

export interface CodexAppServerClientOptions {
  child: ChildProcessWithoutNullStreams;
  onNotification(notification: JsonRpcNotification): void | Promise<void>;
  onRequest(request: JsonRpcRequest): void | Promise<void>;
  onParseError?(error: Error): void | Promise<void>;
}

export class CodexAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #onNotification: CodexAppServerClientOptions["onNotification"];
  readonly #onRequest: CodexAppServerClientOptions["onRequest"];
  readonly #onParseError: CodexAppServerClientOptions["onParseError"];
  #buffer = "";
  readonly #lineQueue: string[] = [];
  #nextId = 1;
  #processing = false;

  public constructor(options: CodexAppServerClientOptions) {
    this.#child = options.child;
    this.#onNotification = options.onNotification;
    this.#onRequest = options.onRequest;
    this.#onParseError = options.onParseError;
    this.#child.stdout.on("data", (chunk) => this.#read(chunk));
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
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #read(chunk: string | Buffer): void {
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
