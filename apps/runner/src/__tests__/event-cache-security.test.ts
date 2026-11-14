import { symlink } from "./platform.js";
import { spawn, type ChildProcess } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventCache } from "../persistence/cache.js";

const childWriterPath = fileURLToPath(
  new URL("./fixtures/cache-child-writer.ts", import.meta.url),
);
const runnerPackagePath = fileURLToPath(new URL("../../", import.meta.url));

describe("event outbox persistence security", () => {
  it("serializes appenders in two independent Node processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-processes-"));
    const path = join(dir, "pending.jsonl");
    const barrierPath = join(dir, "start");
    const children = [
      startWriter(path, barrierPath, "first", 15),
      startWriter(path, barrierPath, "second", 15),
    ];
    await writeFile(barrierPath, "start", { mode: 0o600 });
    await Promise.all(children.map(waitForChild));

    const entries = await new EventCache(path).readAll();
    expect(entries).toHaveLength(30);
    expect(new Set(entries.map((entry) => entry.streamId)).size).toBe(1);
    expect(entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
  }, 20_000);

  it("rejects a symlinked state directory without touching its target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-dir-link-"));
    const external = join(dir, "external");
    const stateDir = join(dir, "state");
    await mkdir(external);
    await symlink(external, stateDir, "dir");

    await expect(
      new EventCache(join(stateDir, "pending.jsonl")).readAll(),
    ).rejects.toThrow(/real directory/i);
  });

  it("rejects symlinked and hard-linked outbox files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-file-link-"));
    const external = join(dir, "external.jsonl");
    await writeFile(external, "do-not-touch", { mode: 0o600 });
    const symlinkPath = join(dir, "symlink.jsonl");
    const hardlinkPath = join(dir, "hardlink.jsonl");
    await symlink(external, symlinkPath, "file");
    await link(external, hardlinkPath);

    await expect(new EventCache(symlinkPath).readAll()).rejects.toThrow(
      /private regular file/i,
    );
    await expect(new EventCache(hardlinkPath).readAll()).rejects.toThrow(
      /private regular file/i,
    );
    expect(await readFile(external, "utf8")).toBe("do-not-touch");
  });

  it("rejects symlinked drain and lock sidecars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-side-link-"));
    const external = join(dir, "external.jsonl");
    await writeFile(external, "do-not-touch", { mode: 0o600 });
    const drainPath = join(dir, "pending.jsonl.001.draining");
    await symlink(external, drainPath, "file");
    await expect(
      new EventCache(join(dir, "pending.jsonl")).readAll(),
    ).rejects.toThrow(/drain record/i);

    const lockBase = join(dir, "other.jsonl");
    await symlink(external, `${lockBase}.lock`, "file");
    await expect(new EventCache(lockBase).readAll()).rejects.toThrow(
      /outbox lock/i,
    );
    expect(await readFile(external, "utf8")).toBe("do-not-touch");
  });
});

function startWriter(
  cachePath: string,
  barrierPath: string,
  writer: string,
  count: number,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      childWriterPath,
      cachePath,
      barrierPath,
      writer,
      String(count),
    ],
    {
      cwd: runnerPackagePath,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

async function waitForChild(child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Cache writer exited with code ${String(code)} signal ${String(signal)}: ${stderr}`,
        ),
      );
    });
  });
}
