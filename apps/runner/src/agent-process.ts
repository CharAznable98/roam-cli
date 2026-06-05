import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";

export interface AgentProcess {
  write(data: string): void;
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
}

export async function spawnAgentProcess(
  command: string,
  args: readonly string[],
  options: SpawnAgentProcessOptions
): Promise<AgentProcess> {
  if (options.preferPty ?? true) {
    const ptyProcess = await trySpawnPty(command, args, options);
    if (ptyProcess !== undefined) {
      return ptyProcess;
    }
  }
  return spawnChildProcess(command, args, options);
}

async function trySpawnPty(
  command: string,
  args: readonly string[],
  options: SpawnAgentProcessOptions
): Promise<AgentProcess | undefined> {
  try {
    const pty = await import("node-pty");
    const child = pty.spawn(command, [...args], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: compactEnv(options.env ?? process.env)
    });
    return new PtyAgentProcess(child);
  } catch {
    return undefined;
  }
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

function signalFromPty(signal: number | string | undefined): NodeJS.Signals | null {
  if (typeof signal === "string" && signal.length > 0) {
    return signal as NodeJS.Signals;
  }
  return null;
}
