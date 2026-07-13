import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../persistence/audit.js";
import { type CachedRunnerEvent, EventCache } from "../persistence/cache.js";

describe("audit and disconnected cache", () => {
  it("appends an auditable sha256 hash chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-"));
    const audit = new AuditLog(join(dir, "audit.jsonl"));

    const first = await audit.append("event", { value: 1 });
    const second = await audit.append("event", { value: 2 });
    const lines = (await readFile(join(dir, "audit.jsonl"), "utf8"))
      .trim()
      .split("\n");

    expect(lines).toHaveLength(2);
    expect(first.previousHash).toMatch(/^0{64}$/);
    expect(second.previousHash).toBe(first.hash);
    expect(second.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("serializes concurrent audit appends into one continuous chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-"));
    const audit = new AuditLog(join(dir, "audit.jsonl"));

    const records = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        audit.append("event", { index }),
      ),
    );

    expect(records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(records.slice(1).map((record) => record.previousHash)).toEqual(
      records.slice(0, -1).map((record) => record.hash),
    );
  });

  it("refuses to load an audit record whose content no longer matches its hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-"));
    const path = join(dir, "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.append("event", { value: "original" });
    const record = JSON.parse((await readFile(path, "utf8")).trim()) as {
      payload: { value: string };
    };
    record.payload.value = "tampered";
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");

    await expect(new AuditLog(path).lastHash()).rejects.toThrow(/integrity/i);
  });

  it("lastHash waits for audit appends that were already queued", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-"));
    const audit = new AuditLog(join(dir, "audit.jsonl"));

    const append = audit.append("event", { value: 1 });
    const hash = audit.lastHash();

    expect(await hash).toBe((await append).hash);
  });

  it("refuses to load an audit chain with a sequence gap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-"));
    const path = join(dir, "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.append("event", { value: 1 });
    await audit.append("event", { value: 2 });
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number });
    records[1]!.sequence = 3;
    await writeFile(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    await expect(new AuditLog(path).lastHash()).rejects.toThrow(
      /unexpected sequence/i,
    );
  });

  it("refuses to load an audit chain with a broken previous hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-"));
    const path = join(dir, "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.append("event", { value: 1 });
    await audit.append("event", { value: 2 });
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { previousHash: string });
    records[1]!.previousHash = "0".repeat(64);
    await writeFile(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    await expect(new AuditLog(path).lastHash()).rejects.toThrow(
      /previous hash mismatch/i,
    );
  });

  it("refuses to load a partially written audit record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-"));
    const path = join(dir, "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.append("event", { value: 1 });
    await appendFile(path, '{"sequence":', "utf8");

    await expect(new AuditLog(path).lastHash()).rejects.toThrow(
      /integrity.*unterminated/i,
    );
  });

  it("drains cached runner events in append order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));

    await cache.append({
      type: "sessionStatus",
      sessionId: "s1",
      status: "running",
    });
    await cache.append({
      type: "assistantOutput",
      sessionId: "s1",
      outputId: "output-1",
      content: "hello",
      mode: "replace",
      done: true,
      encrypted: false,
    });

    const sent: string[] = [];
    const count = await cache.drain((event) => {
      sent.push(event.type);
      return Promise.resolve();
    });

    expect(count).toBe(2);
    expect(sent).toEqual(["sessionStatus", "assistantOutput"]);
    expect(await cache.readAll()).toEqual([]);
  });

  it("recovers events left in an orphaned draining file after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const path = join(dir, "pending.jsonl");
    const cache = new EventCache(path);
    await cache.append({
      type: "sessionStatus",
      sessionId: "s1",
      status: "running",
    });
    await rename(path, `${path}.123.draining`);

    const recovered = await new EventCache(path).readAll();

    expect(recovered.map((entry) => entry.event.type)).toEqual([
      "sessionStatus",
    ]);
  });

  it("deduplicates overlapping records after restore and before draining cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const path = join(dir, "pending.jsonl");
    const cache = new EventCache(path);
    const oldFirst = await cache.append({
      type: "sessionStatus",
      sessionId: "old-1",
      status: "running",
    });
    const oldSecond = await cache.append({
      type: "sessionStatus",
      sessionId: "old-2",
      status: "running",
    });
    await rename(path, `${path}.001.draining`);
    const newer = cachedStatus("new", "new-id");
    await writeFile(path, serializeCachedEntries([oldSecond, newer]), "utf8");

    const recovered = await new EventCache(path).readAll();

    expect(recovered.map((entry) => entry.id)).toEqual([
      oldFirst.id,
      oldSecond.id,
      newer.id,
    ]);
  });

  it("deduplicates records when recovery completed before orphan cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const path = join(dir, "pending.jsonl");
    const original = cachedStatus("old", "old-id");
    const newer = cachedStatus("new", "new-id");
    await writeFile(
      `${path}.001.draining`,
      serializeCachedEntries([original]),
      "utf8",
    );
    await writeFile(path, serializeCachedEntries([original, newer]), "utf8");

    const recovered = await new EventCache(path).readAll();

    expect(recovered.map((entry) => entry.id)).toEqual([original.id, newer.id]);
  });

  it("keeps a valid main-file prefix and truncates a torn final record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const path = join(dir, "pending.jsonl");
    const cache = new EventCache(path);
    const valid = await cache.append({
      type: "sessionStatus",
      sessionId: "valid",
      status: "running",
    });
    await appendFile(path, '{"id":"partial', "utf8");

    await expect(new EventCache(path).readAll()).resolves.toMatchObject([
      { id: valid.id, event: valid.event, sequence: 1 },
    ]);
    expect(await readFile(path, "utf8")).toContain(
      '"kind":"runnerEventOutbox"',
    );
  });

  it("rejects an outbox whose complete snapshotted tail event was removed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const path = join(dir, "pending.jsonl");
    const cache = new EventCache(path);
    const first = await cache.append({
      type: "sessionStatus",
      sessionId: "first",
      status: "running",
    });
    await cache.append({
      type: "sessionStatus",
      sessionId: "second",
      status: "running",
    });
    await cache.acknowledge(first.streamId, first.sequence);

    const [header] = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, `${header}\n`, "utf8");

    await expect(new EventCache(path).readAll()).rejects.toThrow(
      /missing an allocated sequence/i,
    );
  });

  it("rejects invalid stream UUIDs and malformed persisted runner events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const invalidStreamPath = join(dir, "invalid-stream.jsonl");
    const invalidStreamCache = new EventCache(invalidStreamPath);
    await invalidStreamCache.append({
      type: "sessionStatus",
      sessionId: "stream",
      status: "running",
    });
    const invalidStreamLines = (await readFile(invalidStreamPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    invalidStreamLines[0]!.streamId = "not-a-uuid";
    await writeFile(
      invalidStreamPath,
      `${invalidStreamLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    await expect(new EventCache(invalidStreamPath).readAll()).rejects.toThrow(
      /invalid record/i,
    );

    const invalidEventPath = join(dir, "invalid-event.jsonl");
    const invalidEventCache = new EventCache(invalidEventPath);
    await invalidEventCache.append({
      type: "sessionStatus",
      sessionId: "event",
      status: "running",
    });
    const invalidEventLines = (await readFile(invalidEventPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    invalidEventLines[1]!.event = { type: "sessionStatus" };
    await writeFile(
      invalidEventPath,
      `${invalidEventLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    await expect(new EventCache(invalidEventPath).readAll()).rejects.toThrow(
      /invalid record/i,
    );
  });

  it("normalizes a complete final record without a newline before appending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const path = join(dir, "pending.jsonl");
    const first = cachedStatus("first", "first-id");
    await writeFile(path, JSON.stringify(first), "utf8");
    const cache = new EventCache(path);

    const second = await cache.append({
      type: "sessionStatus",
      sessionId: "second",
      status: "running",
    });

    await expect(cache.readAll()).resolves.toMatchObject([
      { id: first.id, event: first.event, sequence: 1 },
      { id: second.id, event: second.event, sequence: 2 },
    ]);
  });

  it("keeps a valid draining-file prefix when its final record is torn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const path = join(dir, "pending.jsonl");
    const cache = new EventCache(path);
    const valid = await cache.append({
      type: "sessionStatus",
      sessionId: "valid",
      status: "running",
    });
    await appendFile(path, '{"id":"partial', "utf8");
    await rename(path, `${path}.001.draining`);

    await expect(new EventCache(path).readAll()).resolves.toMatchObject([
      { id: valid.id, event: valid.event, sequence: 1 },
    ]);
  });

  it("rejects corruption before a later valid main-file record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const path = join(dir, "pending.jsonl");
    const first = cachedStatus("first", "first-id");
    const second = cachedStatus("second", "second-id");
    await writeFile(
      path,
      `${JSON.stringify(first)}\n{"broken":\n${JSON.stringify(second)}\n`,
      "utf8",
    );

    await expect(new EventCache(path).readAll()).rejects.toThrow();
  });

  it("rejects corruption before a later valid draining-file record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const path = join(dir, "pending.jsonl");
    const first = cachedStatus("first", "first-id");
    const second = cachedStatus("second", "second-id");
    await writeFile(
      `${path}.001.draining`,
      `${JSON.stringify(first)}\n{"broken":\n${JSON.stringify(second)}\n`,
      "utf8",
    );

    await expect(new EventCache(path).readAll()).rejects.toThrow();
  });

  it("keeps an unsent drained event ahead of events appended during delivery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "old-1",
      status: "running",
    });
    await cache.append({
      type: "sessionStatus",
      sessionId: "old-2",
      status: "running",
    });

    await expect(
      cache.drain(async (event) => {
        if (event.type === "sessionStatus" && event.sessionId === "old-2") {
          await cache.append({
            type: "sessionStatus",
            sessionId: "new",
            status: "running",
          });
          throw new Error("delivery failed");
        }
      }),
    ).rejects.toThrow("delivery failed");

    expect(
      (await cache.readAll()).map((entry) =>
        entry.event.type === "sessionStatus"
          ? entry.event.sessionId
          : entry.event.type,
      ),
    ).toEqual(["old-2", "new"]);
  });

  it("serializes drains while allowing new events to append to the next batch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    await cache.append({
      type: "sessionStatus",
      sessionId: "old",
      status: "running",
    });
    let markFirstDeliveryStarted!: () => void;
    const firstDeliveryStarted = new Promise<void>((resolve) => {
      markFirstDeliveryStarted = resolve;
    });
    let releaseFirstDelivery!: () => void;
    const firstDeliveryGate = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    const firstDrain = cache.drain(async () => {
      markFirstDeliveryStarted();
      await firstDeliveryGate;
    });
    await firstDeliveryStarted;
    await cache.append({
      type: "sessionStatus",
      sessionId: "new",
      status: "running",
    });

    let secondDeliveryStarted = false;
    const secondDrain = cache.drain(() => {
      secondDeliveryStarted = true;
      return Promise.resolve();
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(secondDeliveryStarted).toBe(false);

    releaseFirstDelivery();
    await expect(firstDrain).resolves.toBe(1);
    await expect(secondDrain).resolves.toBe(1);
    expect(secondDeliveryStarted).toBe(true);
    expect(await cache.readAll()).toEqual([]);
  });

  it("keeps ACK events durable until a cumulative ACK removes the continuous prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-ack-"));
    const path = join(dir, "pending.jsonl");
    const cache = new EventCache(path);
    const first = await cache.append({
      type: "sessionStatus",
      sessionId: "first",
      status: "running",
    });
    const second = await cache.append({
      type: "sessionStatus",
      sessionId: "second",
      status: "running",
    });

    expect((await cache.readAll()).map((entry) => entry.id)).toEqual([
      first.id,
      second.id,
    ]);
    await expect(
      cache.acknowledge(first.streamId, first.sequence),
    ).resolves.toBe(1);
    expect((await cache.readAll()).map((entry) => entry.id)).toEqual([
      second.id,
    ]);
    await expect(cache.acknowledge(first.streamId, 0)).resolves.toBe(0);
    await expect(
      cache.acknowledge(second.streamId, second.sequence),
    ).resolves.toBe(1);
    expect(await cache.readAll()).toEqual([]);
    await expect(
      cache.acknowledge(second.streamId, second.sequence + 1),
    ).rejects.toThrow(/exceeds the last allocated sequence/i);

    const restarted = new EventCache(path);
    const state = await restarted.deliveryState();
    expect(state).toMatchObject({
      streamId: first.streamId,
      acknowledgedThrough: second.sequence,
      nextSequence: second.sequence + 1,
    });
    const third = await restarted.append({
      type: "sessionStatus",
      sessionId: "third",
      status: "running",
    });
    expect(third).toMatchObject({
      streamId: first.streamId,
      sequence: second.sequence + 1,
    });
  });

  it("amortizes a large ACK backlog without re-reading or rewriting each prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-ack-linear-"));
    const operations: string[] = [];
    const cache = new EventCache(join(dir, "pending.jsonl"), {
      onOperation: (operation) => operations.push(operation),
    });
    const entries = [];
    for (let index = 0; index < 32; index += 1) {
      entries.push(
        await cache.append({
          type: "sessionStatus",
          sessionId: `session-${index}`,
          status: "running",
        }),
      );
    }

    operations.length = 0;
    for (const entry of entries) {
      await cache.acknowledge(entry.streamId, entry.sequence);
    }

    expect(operations.filter((operation) => operation === "read")).toHaveLength(
      0,
    );
    expect(
      operations.filter((operation) => operation === "append"),
    ).toHaveLength(entries.length - 3);
    expect(
      operations.filter((operation) => operation === "replace"),
    ).toHaveLength(3);
    await expect(
      new EventCache(join(dir, "pending.jsonl")).readAll(),
    ).resolves.toEqual([]);
  });

  it("keeps append and ACK interleaving linear with a stable live backlog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-interleaved-"));
    const path = join(dir, "pending.jsonl");
    const operations: string[] = [];
    const cache = new EventCache(path, {
      onOperation: (operation) => operations.push(operation),
    });
    for (let index = 0; index < 32; index += 1) {
      await cache.append({
        type: "sessionStatus",
        sessionId: `initial-${index}`,
        status: "running",
      });
    }

    operations.length = 0;
    const appendedIds: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      const head = await cache.peek();
      const appended = await cache.append({
        type: "sessionStatus",
        sessionId: `replacement-${index}`,
        status: "running",
      });
      appendedIds.push(appended.id);
      await cache.acknowledge(head!.streamId, head!.sequence);
    }

    expect(operations.filter((operation) => operation === "read")).toHaveLength(
      0,
    );
    expect(
      operations.filter((operation) => operation === "append"),
    ).toHaveLength(62);
    expect(
      operations.filter((operation) => operation === "replace"),
    ).toHaveLength(2);
    const recovered = await new EventCache(path).readAll();
    expect(recovered.map((entry) => entry.id)).toEqual(appendedIds);
    expect(recovered.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 33),
    );
  });

  it("bounds durable log growth across repeated append and ACK compaction cycles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-bounded-log-"));
    const path = join(dir, "pending.jsonl");
    const operations: string[] = [];
    const cache = new EventCache(path, {
      onOperation: (operation) => operations.push(operation),
    });
    for (let index = 0; index < 8; index += 1) {
      await cache.append({
        type: "sessionStatus",
        sessionId: `initial-${index}`,
        status: "running",
      });
    }

    operations.length = 0;
    for (let index = 0; index < 80; index += 1) {
      const head = await cache.peek();
      await cache.append({
        type: "sessionStatus",
        sessionId: `replacement-${index}`,
        status: "running",
      });
      await cache.acknowledge(head!.streamId, head!.sequence);
    }

    expect(
      operations.filter((operation) => operation === "replace"),
    ).toHaveLength(5);
    expect(operations.filter((operation) => operation === "read")).toHaveLength(
      0,
    );
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(73);
    await expect(new EventCache(path).readAll()).resolves.toHaveLength(8);
  }, 15_000);

  it("serializes sequence allocation across EventCache instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-instances-"));
    const path = join(dir, "pending.jsonl");
    const first = new EventCache(path);
    const second = new EventCache(path);

    const entries = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).append({
          type: "sessionStatus",
          sessionId: `session-${index}`,
          status: "running",
        }),
      ),
    );

    expect(new Set(entries.map((entry) => entry.streamId)).size).toBe(1);
    expect(
      entries
        .map((entry) => entry.sequence)
        .sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(
      (await new EventCache(path).readAll()).map((entry) => entry.sequence),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("rotates and re-sequences the remaining outbox after each legacy success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-legacy-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));
    const first = await cache.append({
      type: "sessionStatus",
      sessionId: "first",
      status: "running",
    });
    await cache.append({
      type: "sessionStatus",
      sessionId: "second",
      status: "running",
    });

    await expect(
      cache.drainLegacy(async (event) => {
        if (event.type === "sessionStatus" && event.sessionId === "second") {
          throw new Error("stop after first");
        }
      }),
    ).rejects.toThrow("stop after first");

    const [remaining] = await cache.readAll();
    expect(remaining).toMatchObject({ sequence: 1 });
    expect(remaining?.streamId).not.toBe(first.streamId);
  });

  it("drains a large legacy backlog with constant rewrites and no full re-reads", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "roam-runner-cache-legacy-linear-"),
    );
    const operations: string[] = [];
    const cache = new EventCache(join(dir, "pending.jsonl"), {
      onOperation: (operation) => operations.push(operation),
    });
    for (let index = 0; index < 32; index += 1) {
      await cache.append({
        type: "sessionStatus",
        sessionId: `legacy-${index}`,
        status: "running",
      });
    }

    operations.length = 0;
    await expect(cache.drainLegacy(async () => undefined)).resolves.toBe(32);

    expect(operations.filter((operation) => operation === "read")).toHaveLength(
      0,
    );
    expect(
      operations.filter((operation) => operation === "append"),
    ).toHaveLength(33);
    expect(
      operations.filter((operation) => operation === "replace"),
    ).toHaveLength(2);
    await expect(cache.readAll()).resolves.toEqual([]);
  });

  it("serializes legacy drains across EventCache instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-legacy-lock-"));
    const path = join(dir, "pending.jsonl");
    const first = new EventCache(path);
    const second = new EventCache(path);
    await first.append({
      type: "sessionStatus",
      sessionId: "only-once",
      status: "running",
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const delivered: string[] = [];
    const firstDrain = first.drainLegacy(async () => {
      delivered.push("first");
      firstStarted();
      await firstBlocked;
    });
    await firstDelivery;
    const secondDrain = second.drainLegacy(async () => {
      delivered.push("second");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivered).toEqual(["first"]);

    releaseFirst();
    await expect(firstDrain).resolves.toBe(1);
    await expect(secondDrain).resolves.toBe(0);
    expect(delivered).toEqual(["first"]);
  });

  it("recovers only the unsent legacy tail after a progress-checkpoint crash", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "roam-runner-cache-legacy-crash-"),
    );
    const path = join(dir, "pending.jsonl");
    const cache = new EventCache(path);
    const first = await cache.append({
      type: "sessionStatus",
      sessionId: "sent-before-crash",
      status: "running",
    });
    const second = await cache.append({
      type: "sessionStatus",
      sessionId: "still-pending",
      status: "running",
    });
    const third = await cache.append({
      type: "sessionStatus",
      sessionId: "also-pending",
      status: "running",
    });
    await appendFile(
      path,
      `${JSON.stringify({
        kind: "legacyDrain",
        streamId: first.streamId,
        throughSequence: 0,
      })}\n${JSON.stringify({
        kind: "legacyDrain",
        streamId: first.streamId,
        throughSequence: first.sequence,
      })}\n`,
      "utf8",
    );

    const recovered = await new EventCache(path).readAll();
    expect(recovered.map((entry) => entry.id)).toEqual([second.id, third.id]);
    expect(recovered.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(recovered[0]?.streamId).not.toBe(first.streamId);
  });

  it("stores audit and cache state privately and tightens existing permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-private-state-"));
    const stateDir = join(dir, "state");
    const auditPath = join(stateDir, "audit.jsonl");
    const cachePath = join(stateDir, "pending.jsonl");
    await new AuditLog(auditPath).append("event", { value: 1 });
    await new EventCache(cachePath).append({
      type: "sessionStatus",
      sessionId: "s1",
      status: "running",
    });

    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);

    await chmod(stateDir, 0o755);
    await chmod(auditPath, 0o644);
    await chmod(cachePath, 0o644);
    await Promise.all([
      new AuditLog(auditPath).lastHash(),
      new EventCache(cachePath).readAll(),
    ]);

    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });
});

function cachedStatus(
  sessionId: string,
  id: string,
): Omit<CachedRunnerEvent, "streamId" | "sequence"> {
  return {
    id,
    createdAt: "2026-07-10T00:00:00.000Z",
    event: {
      type: "sessionStatus",
      sessionId,
      status: "running",
    },
  };
}

function serializeCachedEntries(
  entries: readonly Omit<CachedRunnerEvent, "streamId" | "sequence">[],
): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
