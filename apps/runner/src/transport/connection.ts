import type { RunnerCommand, RunnerEvent, RunnerRegistration } from "@roamcli/shared/protocol";
import { RunnerCommandSchema } from "@roamcli/shared/protocol";
import type { AuditLog } from "../persistence/audit.js";
import type { EventCache } from "../persistence/cache.js";

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void | Promise<void>;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event?: { data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
export type RunnerCommandHandler = (command: RunnerCommand) => Promise<void> | void;

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
}

export class RunnerConnection {
  readonly #options: Omit<Required<RunnerConnectionOptions>, "token" | "createSocket"> & {
    token: string | undefined;
    createSocket: WebSocketFactory;
  };
  #socket?: WebSocketLike;
  #stopped = false;
  #connected = false;
  #attempt = 0;

  public constructor(options: RunnerConnectionOptions) {
    this.#options = {
      ...options,
      token: options.token,
      createSocket: options.createSocket ?? createGlobalWebSocket,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 30_000
    };
  }

  public async start(): Promise<never> {
    while (!this.#stopped) {
      await this.#connectOnce();
      if (this.#stopped) {
        break;
      }
      const delay = backoffDelay(this.#attempt, this.#options.minBackoffMs, this.#options.maxBackoffMs);
      this.#attempt += 1;
      await sleep(delay);
    }
    throw new Error("Runner connection stopped");
  }

  public stop(): void {
    this.#stopped = true;
    this.#socket?.close();
  }

  public async send(event: RunnerEvent): Promise<void> {
    await this.#options.audit.append("runner_event", event);
    if (this.#connected && this.#socket !== undefined && this.#socket.readyState === 1) {
      await this.#sendNow(event);
      return;
    }
    await this.#options.cache.append(event);
  }

  async #connectOnce(): Promise<void> {
    const url = withToken(this.#options.serverUrl, this.#options.token);
    const socket = this.#options.createSocket(url);
    this.#socket = socket;

    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => {
        this.#connected = true;
        this.#attempt = 0;
        void this.#onOpen().catch((error: unknown) => {
          void this.sendError(error);
        });
      });
      socket.addEventListener("message", (event) => {
        void this.#onMessage(event?.data).catch((error: unknown) => {
          void this.sendError(error);
        });
      });
      socket.addEventListener("close", () => {
        this.#connected = false;
        resolve();
      });
      socket.addEventListener("error", () => {
        this.#connected = false;
      });
    });
  }

  async #onOpen(): Promise<void> {
    await this.#sendNow({ type: "registered", runner: this.#options.registration });
    await this.#options.cache.drain((event) => this.#sendNow(event));
  }

  async #onMessage(data: unknown): Promise<void> {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const parsed: unknown = JSON.parse(text);
    const command = RunnerCommandSchema.parse(parsed);
    await this.#options.audit.append("runner_command", command);
    await this.#options.onCommand(command);
  }

  private async sendError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.send({ type: "error", message, code: "RUNNER_CONNECTION_ERROR" });
  }

  async #sendNow(event: RunnerEvent): Promise<void> {
    if (this.#socket === undefined || this.#socket.readyState !== 1) {
      await this.#options.cache.append(event);
      return;
    }
    await this.#socket.send(JSON.stringify(event));
  }
}

export function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
}

function withToken(serverUrl: string, token: string | undefined): string {
  if (token === undefined || token.length === 0) {
    return serverUrl;
  }
  const url = new URL(serverUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function createGlobalWebSocket(url: string): WebSocketLike {
  const WebSocketCtor = globalThis.WebSocket;
  if (WebSocketCtor === undefined) {
    throw new Error("Global WebSocket is unavailable in this Node runtime");
  }
  return new WebSocketCtor(url) as WebSocketLike;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
