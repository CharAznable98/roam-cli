import { symlink, expectPrivateMode } from "./platform.js";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../persistence/audit.js";

const childWriterPath = fileURLToPath(
  new URL("./fixtures/audit-child-writer.ts", import.meta.url),
);
const runnerPackagePath = fileURLToPath(new URL("../../", import.meta.url));

describe("audit log persistence security", () => {
  it("serializes two AuditLog instances against the on-disk chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-instances-"));
    const path = join(dir, "audit.jsonl");
    const first = new AuditLog(path);
    const second = new AuditLog(path);

    const records = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? first : second).append("event", { index }),
      ),
    );

    expect(
      records
        .map((record) => record.sequence)
        .sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    const persisted = await readAuditRecords(path);
    expect(persisted.map((record) => record.sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    await expect(new AuditLog(path).lastHash()).resolves.toBe(
      persisted.at(-1)?.hash,
    );
  });

  it("serializes appenders in two independent Node processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-processes-"));
    const path = join(dir, "audit.jsonl");
    const barrierPath = join(dir, "start");
    const children = [
      startWriter(path, barrierPath, "first", 25),
      startWriter(path, barrierPath, "second", 25),
    ];

    await writeFile(barrierPath, "start", { mode: 0o600 });
    await Promise.all(children.map((child) => waitForChild(child)));

    const persisted = await readAuditRecords(path);
    expect(persisted).toHaveLength(50);
    expect(persisted.map((record) => record.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(
      persisted.filter((record) => record.payload.writer === "first"),
    ).toHaveLength(25);
    expect(
      persisted.filter((record) => record.payload.writer === "second"),
    ).toHaveLength(25);
    await expect(new AuditLog(path).lastHash()).resolves.toBe(
      persisted.at(-1)?.hash,
    );
  }, 20_000);

  it("recovers a lock whose owning process has exited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-stale-lock-"));
    const path = join(dir, "audit.jsonl");
    const lockPath = `${path}.lock`;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "stale-lock-owner",
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      new AuditLog(path).append("event", { value: 1 }),
    ).resolves.toMatchObject({ sequence: 1 });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new AuditLog(path).lastHash()).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("rejects a symlinked audit directory without touching its target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-dir-link-"));
    const external = join(dir, "external");
    const linkedState = join(dir, "state");
    await mkdir(external);
    await symlink(external, linkedState, "dir");

    await expect(
      new AuditLog(join(linkedState, "audit.jsonl")).append("event", {
        value: 1,
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(lstat(join(external, "audit.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symlinked audit file without reading or appending its target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-file-link-"));
    const stateDir = join(dir, "state");
    const external = join(dir, "external.jsonl");
    const path = join(stateDir, "audit.jsonl");
    await mkdir(stateDir);
    await writeFile(external, "do-not-touch", { mode: 0o600 });
    await symlink(external, path, "file");

    await expect(new AuditLog(path).lastHash()).rejects.toThrow(
      /symbolic link/i,
    );
    expect(await readFile(external, "utf8")).toBe("do-not-touch");
  });

  it.each(["lock", "reaper"])(
    "rejects a symlinked audit %s without touching its target",
    async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-lock-link-"));
      const path = join(dir, "audit.jsonl");
      const external = join(dir, "external-lock");
      const lockPath = `${path}.lock${kind === "reaper" ? ".reaper" : ""}`;
      await writeFile(external, "do-not-touch", { mode: 0o600 });
      await symlink(external, lockPath, "file");

      await expect(
        new AuditLog(path).append("event", { value: 1 }),
      ).rejects.toThrow(/symbolic link/i);
      expect(await readFile(external, "utf8")).toBe("do-not-touch");
    },
  );

  it("tightens directory and log permissions and creates a private lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-mode-"));
    const stateDir = join(dir, "state");
    const path = join(stateDir, "audit.jsonl");
    await mkdir(stateDir, { mode: 0o755 });
    const audit = new AuditLog(path);
    await audit.append("seed", { value: 1 });
    await chmod(stateDir, 0o755);
    await chmod(path, 0o644);

    const largePayload = "x".repeat(2 * 1024 * 1024);
    const appends = Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        audit.append("large", { index, largePayload }),
      ),
    );
    const lockMode = await observeLockMode(`${path}.lock`);
    await appends;

    if (process.platform !== "win32") expect(lockMode).toBe(0o600);
    await expectPrivateMode(stateDir, 0o700);
    await expectPrivateMode(path, 0o600);
    await expectPrivateMode(`${path}.checkpoint`, 0o600);
  }, 20_000);

  it("fails closed when a complete-looking tail is not newline-terminated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-tail-"));
    const path = join(dir, "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.append("event", { value: 1 });
    const content = await readFile(path, "utf8");
    await writeFile(path, content.trimEnd(), { mode: 0o600 });

    await expect(new AuditLog(path).lastHash()).rejects.toThrow(
      /unterminated record/i,
    );
  });

  it("uses bounded checkpoint reads for append while lastHash still verifies the full chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-checkpoint-"));
    const path = join(dir, "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.append("large", { payload: "x".repeat(1024 * 1024) });

    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      readFile: (...args: unknown[]) => Promise<unknown>;
    };
    await probe.close();
    const originalReadFile = prototype.readFile;
    let fullLogReads = 0;
    prototype.readFile = async function (
      this: FileHandle,
      ...args: unknown[]
    ): Promise<unknown> {
      if ((await this.stat()).size > 512 * 1024) {
        fullLogReads += 1;
      }
      return originalReadFile.apply(this, args);
    };

    try {
      for (let index = 0; index < 12; index += 1) {
        await audit.append("small", { index });
      }
      expect(fullLogReads).toBe(0);

      await expect(audit.lastHash()).resolves.toMatch(/^[a-f0-9]{64}$/);
      expect(fullLogReads).toBe(1);
    } finally {
      prototype.readFile = originalReadFile;
    }
  }, 20_000);

  it("rebuilds a missing, stale, or corrupted checkpoint from the full chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-rebuild-"));
    const path = join(dir, "audit.jsonl");
    const checkpointPath = `${path}.checkpoint`;
    const audit = new AuditLog(path);

    await audit.append("event", { value: 1 });
    const staleCheckpoint = await readFile(checkpointPath, "utf8");
    await audit.append("event", { value: 2 });

    await writeFile(checkpointPath, staleCheckpoint, { mode: 0o600 });
    await expect(audit.append("event", { value: 3 })).resolves.toMatchObject({
      sequence: 3,
    });

    await writeFile(checkpointPath, "not-json\n", { mode: 0o600 });
    await expect(audit.append("event", { value: 4 })).resolves.toMatchObject({
      sequence: 4,
    });

    await unlink(checkpointPath);
    await expect(audit.append("event", { value: 5 })).resolves.toMatchObject({
      sequence: 5,
    });
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({
      version: 1,
      sequence: 5,
    });
  });

  it("detects an early same-size rewrite even when the log mtime is restored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-early-"));
    const path = join(dir, "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.append("event", { value: "original" });
    await audit.append("event", { value: "untouched" });

    const before = await stat(path);
    const content = await readFile(path, "utf8");
    const tampered = content.replace('"original"', '"tampered"');
    expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(content));
    await writeFile(path, tampered, { mode: 0o600 });
    await utimes(path, before.atime, before.mtime);

    await expect(
      audit.append("event", { value: "must-not-append" }),
    ).rejects.toThrow(/integrity.*hash mismatch/i);
    expect(await readAuditRecords(path)).toHaveLength(2);
  });

  it.each(["checkpoint", "checkpoint.tmp"])(
    "rejects a symlinked audit %s sidecar before mutating the log",
    async (suffix) => {
      const dir = await mkdtemp(
        join(tmpdir(), "roam-runner-audit-sidecar-link-"),
      );
      const path = join(dir, "audit.jsonl");
      const sidecarPath = `${path}.${suffix}`;
      const external = join(dir, "external-sidecar");
      const audit = new AuditLog(path);
      await audit.append("seed", { value: 1 });
      await unlink(sidecarPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      });
      await writeFile(external, "do-not-touch", { mode: 0o600 });
      await symlink(external, sidecarPath, "file");

      await expect(audit.append("event", { value: 2 })).rejects.toThrow(
        /symbolic link/i,
      );
      expect(await readFile(external, "utf8")).toBe("do-not-touch");
      expect(await readAuditRecords(path)).toHaveLength(1);
    },
  );

  it.each(["checkpoint", "checkpoint.tmp"])(
    "rejects a hard-linked audit %s sidecar before mutating the log",
    async (suffix) => {
      const dir = await mkdtemp(
        join(tmpdir(), "roam-runner-audit-sidecar-hardlink-"),
      );
      const path = join(dir, "audit.jsonl");
      const sidecarPath = `${path}.${suffix}`;
      const external = join(dir, "external-sidecar");
      const audit = new AuditLog(path);
      await audit.append("seed", { value: 1 });
      await unlink(sidecarPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      });
      await writeFile(external, "do-not-touch", { mode: 0o600 });
      await link(external, sidecarPath);

      await expect(audit.append("event", { value: 2 })).rejects.toThrow(
        /private regular file/i,
      );
      expect(await readFile(external, "utf8")).toBe("do-not-touch");
      expect(await readAuditRecords(path)).toHaveLength(1);
    },
  );
});

interface PersistedAuditRecord {
  readonly sequence: number;
  readonly hash: string;
  readonly payload: { readonly writer?: string };
}

async function readAuditRecords(path: string): Promise<PersistedAuditRecord[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as PersistedAuditRecord);
}

function startWriter(
  auditPath: string,
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
      auditPath,
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
          `Audit writer exited with code ${String(code)} signal ${String(signal)}: ${stderr}`,
        ),
      );
    });
  });
}

async function observeLockMode(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return (await stat(path)).mode & 0o777;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
    }
  }
  throw new Error("Timed out observing the audit lock file");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
