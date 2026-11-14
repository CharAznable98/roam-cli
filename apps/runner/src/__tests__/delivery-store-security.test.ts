import { symlink, expectPrivateMode } from "./platform.js";
import { chmod, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InputDeliveryStore } from "../persistence/input-deliveries.js";
import { StartDeliveryStore } from "../persistence/start-deliveries.js";

describe("input delivery receipt persistence security", () => {
  it("rejects symlinks and malformed receipt documents with actionable errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roam-input-receipts-"));
    const target = join(directory, "target.json");
    await writeFile(target, '{"version":1,"receipts":[]}\n', "utf8");
    await symlink(target, join(directory, "input-delivery-receipts.json"));

    await expect(
      new InputDeliveryStore(directory).get("missing"),
    ).rejects.toThrow(/not a private regular file/i);

    const corruptDirectory = await mkdtemp(
      join(tmpdir(), "roam-input-receipts-corrupt-"),
    );
    await writeFile(
      join(corruptDirectory, "input-delivery-receipts.json"),
      "not-json",
      { mode: 0o600 },
    );
    await expect(
      new InputDeliveryStore(corruptDirectory).get("missing"),
    ).rejects.toThrow(/corrupt; move or remove/i);
  });

  it("tightens modes and leaves no temporary file after an atomic write", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "roam-input-receipts-mode-"),
    );
    const path = join(directory, "input-delivery-receipts.json");
    await writeFile(path, '{"version":1,"receipts":[]}\n', { mode: 0o666 });
    await chmod(path, 0o666);
    const store = new InputDeliveryStore(directory);
    await store.put({
      deliveryId: "delivery-1",
      sessionId: "session-1",
      contentHash: "hash",
      ownership: "owned",
    });

    await expectPrivateMode(path, 0o600);
    await expectPrivateMode(directory, 0o700);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it.each([
    {
      name: "input",
      file: "input-delivery-receipts.json",
      invalid: [{}],
      conflicting: [
        {
          deliveryId: "duplicate",
          sessionId: "s1",
          contentHash: "first",
          ownership: "owned",
        },
        {
          deliveryId: "duplicate",
          sessionId: "s1",
          contentHash: "second",
          ownership: "owned",
        },
      ],
      load: (directory: string) =>
        new InputDeliveryStore(directory).get("duplicate"),
    },
    {
      name: "start",
      file: "start-delivery-receipts.json",
      invalid: [
        {
          deliveryId: "invalid",
          payloadHash: "hash",
          payload: {
            requestId: "request",
            session: {},
            prompt: "prompt",
            attachments: [],
          },
          state: "accepted",
        },
      ],
      conflicting: [
        startReceipt("duplicate", "first"),
        startReceipt("duplicate", "second"),
      ],
      load: (directory: string) =>
        new StartDeliveryStore(directory).get("duplicate"),
    },
  ])(
    "fails closed for invalid elements and conflicting duplicate IDs in the $name store",
    async ({ file, invalid, conflicting, load }) => {
      const invalidDirectory = await mkdtemp(
        join(tmpdir(), "roam-receipts-invalid-"),
      );
      await writeFile(
        join(invalidDirectory, file),
        `${JSON.stringify({ version: 1, receipts: invalid })}\n`,
        { mode: 0o600 },
      );
      await expect(load(invalidDirectory)).rejects.toThrow(
        /receipt store is corrupt/i,
      );

      const duplicateDirectory = await mkdtemp(
        join(tmpdir(), "roam-receipts-duplicate-"),
      );
      await writeFile(
        join(duplicateDirectory, file),
        `${JSON.stringify({ version: 1, receipts: conflicting })}\n`,
        { mode: 0o600 },
      );
      await expect(load(duplicateDirectory)).rejects.toThrow(
        /receipt store is corrupt/i,
      );
    },
  );

  it.each([
    {
      name: "invalid element",
      prefix: [{}],
    },
    {
      name: "conflicting duplicate",
      prefix: [
        inputReceipt("prefix-duplicate", "first"),
        inputReceipt("prefix-duplicate", "second"),
      ],
    },
  ])(
    "validates an $name in the truncated receipt prefix",
    async ({ prefix }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "roam-input-receipts-prefix-"),
      );
      const retainedTail = Array.from({ length: 1_025 }, (_, index) =>
        inputReceipt(`tail-${index}`, `hash-${index}`),
      );
      await writeFile(
        join(directory, "input-delivery-receipts.json"),
        `${JSON.stringify({
          version: 1,
          receipts: [...prefix, ...retainedTail],
        })}\n`,
        { mode: 0o600 },
      );

      await expect(
        new InputDeliveryStore(directory).get("tail-1024"),
      ).rejects.toThrow(/receipt store is corrupt/i);
    },
  );
});

function inputReceipt(deliveryId: string, contentHash: string) {
  return {
    deliveryId,
    sessionId: "s1",
    contentHash,
    ownership: "owned",
  };
}

function startReceipt(deliveryId: string, payloadHash: string) {
  return {
    deliveryId,
    payloadHash,
    payload: {
      requestId: "request",
      session: {
        id: "s1",
        title: "Session",
        projectId: "p1",
        runnerId: "r1",
        agent: "codex",
        status: "pending",
        executionMode: "direct",
        executionFolder: "/workspace",
        cwd: "/workspace",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
      prompt: "prompt",
      attachments: [],
    },
    state: "completed",
    bootId: "boot",
  };
}
