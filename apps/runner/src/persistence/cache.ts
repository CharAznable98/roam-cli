import { mkdir, readFile, rename, appendFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunnerEvent } from "@roamcli/shared/protocol";

export interface CachedRunnerEvent {
  id: string;
  createdAt: string;
  event: RunnerEvent;
}

export class EventCache {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
  }

  public async append(event: RunnerEvent): Promise<CachedRunnerEvent> {
    const cached = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
      event
    };
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(cached)}\n`, "utf8");
    return cached;
  }

  public async drain(send: (event: RunnerEvent) => Promise<void>): Promise<number> {
    const entries = await this.readAll();
    if (entries.length === 0) {
      return 0;
    }

    const drainingPath = `${this.#path}.${Date.now()}.draining`;
    await rename(this.#path, drainingPath);
    let sent = 0;
    try {
      for (const entry of entries) {
        await send(entry.event);
        sent += 1;
      }
      await rm(drainingPath, { force: true });
      return sent;
    } catch (error) {
      const unsent = entries.slice(sent);
      await appendFile(this.#path, unsent.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
      await rm(drainingPath, { force: true });
      throw error;
    }
  }

  public async readAll(): Promise<CachedRunnerEvent[]> {
    try {
      const content = await readFile(this.#path, "utf8");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as CachedRunnerEvent);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
