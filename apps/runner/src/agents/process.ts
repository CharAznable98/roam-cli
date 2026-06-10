import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { IPty } from "node-pty";

export interface AgentProcess {
  write(data: string): void;
  endInput(): void;
  interrupt(): void;
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (chunk: string | Buffer) => void): void;
  onExit(listener: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface SpawnAgentProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  preferPty?: boolean;
  requirePty?: boolean;
}

const require = createRequire(import.meta.url);

export async function spawnAgentProcess(
  command: string,
  args: readonly string[],
  options: SpawnAgentProcessOptions
): Promise<AgentProcess> {
  if (options.preferPty ?? true) {
    try {
      return await spawnPtyProcess(command, args, options);
    } catch (error: unknown) {
      if (options.requirePty) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`PTY spawn failed for ${command}: ${message}`);
      }
    }
  }
  return spawnChildProcess(command, args, options);
}

async function spawnPtyProcess(
  command: string,
  args: readonly string[],
  options: SpawnAgentProcessOptions
): Promise<AgentProcess> {
  await ensureNodePtySpawnHelperExecutable();
  const pty = await import("node-pty");
  const child = pty.spawn(command, [...args], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: options.cwd,
    env: compactEnv(options.env ?? process.env)
  });
  return new PtyAgentProcess(child);
}

function spawnChildProcess(command: string, args: readonly string[], options: SpawnAgentProcessOptions): AgentProcess {
  const child = spawnChild(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "pipe"
  });
  return new ChildAgentProcess(child);
}

class PtyAgentProcess implements AgentProcess {
  readonly #child: IPty;

  public constructor(child: IPty) {
    this.#child = child;
  }

  public write(data: string): void {
    this.#child.write(data);
  }

  public endInput(): void {
    // PTY-backed interactive agents keep their input open for follow-up messages.
  }

  public interrupt(): void {
    this.#child.write("\x03");
  }

  public kill(signal?: NodeJS.Signals): void {
    this.#child.kill(signal);
  }

  public onData(listener: (chunk: string | Buffer) => void): void {
    this.#child.onData(listener);
  }

  public onExit(listener: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.#child.onExit((event) => {
      listener({ code: event.exitCode, signal: signalFromPty(event.signal) });
    });
  }

  public onError(_listener: (error: Error) => void): void {
    // node-pty reports startup failures by throwing from spawn and has no error event on IPty.
  }
}

class ChildAgentProcess implements AgentProcess {
  readonly #child: ChildProcessWithoutNullStreams;

  public constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
  }

  public write(data: string): void {
    this.#child.stdin.write(data);
  }

  public endInput(): void {
    this.#child.stdin.end();
  }

  public interrupt(): void {
    this.#child.kill("SIGINT");
  }

  public kill(signal?: NodeJS.Signals): void {
    this.#child.kill(signal);
  }

  public onData(listener: (chunk: string | Buffer) => void): void {
    this.#child.stdout.on("data", listener);
    this.#child.stderr.on("data", listener);
  }

  public onExit(listener: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.#child.on("close", (code, signal) => {
      listener({ code, signal });
    });
  }

  public onError(listener: (error: Error) => void): void {
    this.#child.on("error", listener);
  }
}

function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function ensureNodePtySpawnHelperExecutable(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const helperPath = resolve(dirname(require.resolve("node-pty")), "..", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  try {
    await access(helperPath, constants.X_OK);
  } catch {
    await chmod(helperPath, 0o755);
  }
}

function signalFromPty(signal: number | string | undefined): NodeJS.Signals | null {
  if (typeof signal === "string" && signal.length > 0) {
    return signal as NodeJS.Signals;
  }
  return null;
}
