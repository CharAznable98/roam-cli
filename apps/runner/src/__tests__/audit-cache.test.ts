import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../audit.js";
import { EventCache } from "../cache.js";

describe("audit and disconnected cache", () => {
  it("appends an auditable sha256 hash chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-audit-"));
    const audit = new AuditLog(join(dir, "audit.jsonl"));

    const first = await audit.append("event", { value: 1 });
    const second = await audit.append("event", { value: 2 });
    const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(first.previousHash).toMatch(/^0{64}$/);
    expect(second.previousHash).toBe(first.hash);
    expect(second.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("drains cached runner events in append order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-cache-"));
    const cache = new EventCache(join(dir, "pending.jsonl"));

    await cache.append({ type: "sessionStatus", sessionId: "s1", status: "running" });
    await cache.append({ type: "token", sessionId: "s1", content: "hello", encrypted: false });

    const sent: string[] = [];
    const count = await cache.drain((event) => {
      sent.push(event.type);
      return Promise.resolve();
    });

    expect(count).toBe(2);
    expect(sent).toEqual(["sessionStatus", "token"]);
    expect(await cache.readAll()).toEqual([]);
  });
});
