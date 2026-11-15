import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { piInvocation } from "./command.js";

export type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The runtime explicitly rejected this command before accepting it. */
export class PiRequestRejectedError extends Error {}

export class PiRpc {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    string,
    {
      resolve(value: RecordValue): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout> | undefined;
      timeoutMs: number;
    }
  >();
  #buffer = "";
  #stderr = "";
  #closed = false;
  #paused = false;
  #shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #onEvent: (event: RecordValue) => void;
  readonly #onFailure: (error: Error) => void;

  constructor(options: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    onEvent(event: RecordValue): void;
    onFailure(error: Error): void;
  }) {
    this.#onEvent = options.onEvent;
    this.#onFailure = options.onFailure;
    const invocation = piInvocation(options.command, options.env);
    this.#child = spawn(
      invocation.command,
      [...invocation.args, ...options.args],
      {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: "pipe",
        windowsHide: true,
      },
    );
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#read(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    this.#child.on("error", (error) => this.#fail(error));
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.on("close", (code, signal) => {
      if (this.#shutdownTimer) clearTimeout(this.#shutdownTimer);
      if (!this.#closed)
        this.#fail(
          new Error(
            `Pi exited before completing the session (${signal ?? code ?? "unknown"}). ${this.#stderr}`.trim(),
          ),
        );
    });
  }

  request(
    type: string,
    params: RecordValue = {},
    timeoutMs = 20_000,
  ): Promise<RecordValue> {
    if (this.#closed) return Promise.reject(new Error("Pi RPC is closed"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, timer: undefined, timeoutMs });
      this.#armTimeout(id);
      try {
        this.send({ ...params, type, id });
      } catch (error) {
        clearTimeout(this.#pending.get(id)?.timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  setWaitingForUser(waiting: boolean): void {
    if (this.#paused === waiting) return;
    this.#paused = waiting;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
      if (!waiting) this.#armTimeout(id);
    }
  }

  #armTimeout(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending || this.#paused) return;
    pending.timer = setTimeout(() => {
      this.#pending.delete(id);
      pending.reject(new Error("Pi RPC request timed out"));
    }, pending.timeoutMs);
  }

  send(value: RecordValue): void {
    if (this.#closed || !this.#child.stdin.writable)
      throw new Error("Pi input channel is unavailable");
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  close(force = false, reason = new Error("Pi RPC is closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(reason);
    if (force) {
      this.#child.kill("SIGKILL");
    } else {
      // Let Pi flush session state and refreshed OAuth credentials before exit.
      this.#child.stdin.end();
      this.#shutdownTimer = setTimeout(() => this.#child.kill("SIGKILL"), 3000);
      this.#shutdownTimer.unref();
    }
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    // LF only: readline would split valid JSON strings containing U+2028/U+2029.
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim() || this.#closed) continue;
      try {
        if (line.length > 64 * 1024 * 1024)
          throw new Error("Pi RPC record exceeded 64 MiB");
        const event = record(JSON.parse(line));
        if (event.type === "response") {
          const pending = this.#pending.get(String(event.id));
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.#pending.delete(String(event.id));
          if (event.success === true) pending.resolve(record(event.data));
          else
            pending.reject(
              new PiRequestRejectedError(
                `Pi ${String(event.command)}: ${String(event.error ?? "request failed")}`,
              ),
            );
        } else this.#onEvent(event);
      } catch (error) {
        this.#fail(new Error(`Invalid Pi RPC record: ${message(error)}`));
      }
    }
    if (this.#buffer.length > 64 * 1024 * 1024)
      this.#fail(new Error("Pi RPC record exceeded 64 MiB"));
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.close(true, error);
    this.#onFailure(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
