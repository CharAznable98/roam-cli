import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionAttachmentStore } from "../sessions/attachments.js";

describe("SessionAttachmentStore", () => {
  it("writes, reads, and deletes image attachments inside the runner state dir", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    try {
      const store = new SessionAttachmentStore(stateDir);

      const written = await store.writeSessionAttachments("write-1", "s/1", [
        {
          name: "../screen.png",
          mimeType: "image/png",
          size: 5,
          contentBase64: "aGVsbG8=",
        },
      ]);

      const attachment = written.attachments[0];
      expect(attachment).toMatchObject({
        kind: "image",
        name: "../screen.png",
        mimeType: "image/png",
        size: 5,
      });
      expect(attachment?.runnerStoragePath).toMatch(/^attachments\//);
      expect(isAbsolute(attachment?.runnerStoragePath ?? "")).toBe(false);
      expect(attachment?.runnerStoragePath).not.toContain("..");

      const localPath = store.localPathFor(attachment?.runnerStoragePath ?? "");
      const relativePath = relative(stateDir, localPath);
      expect(relativePath.startsWith("..")).toBe(false);
      await expect(readFile(localPath, "utf8")).resolves.toBe("hello");

      await expect(
        store.readSessionAttachment(
          "read-escape",
          "s/1",
          "attachment-escape",
          "../escape.png",
          1024,
        ),
      ).rejects.toThrow("Invalid attachment storage path");

      const content = await store.readSessionAttachment(
        "read-1",
        "s/1",
        attachment?.id ?? "missing",
        attachment?.runnerStoragePath ?? "",
        1024,
      );
      expect(content).toMatchObject({
        requestId: "read-1",
        sessionId: "s/1",
        attachmentId: attachment?.id,
        size: 5,
        contentBase64: "aGVsbG8=",
      });
      expect(content.name).toMatch(/screen\.png$/);

      const deleted = await store.deleteSessionAttachments("delete-1", "s/1", [
        {
          id: attachment?.id ?? "missing",
          runnerStoragePath: attachment?.runnerStoragePath ?? "",
        },
      ]);
      expect(deleted).toMatchObject({
        requestId: "delete-1",
        sessionId: "s/1",
        deleted: [attachment?.id],
        failed: [],
      });
      await expect(stat(localPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects uploads whose declared byte size does not match the payload", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    try {
      const store = new SessionAttachmentStore(stateDir);

      await expect(
        store.writeSessionAttachments("write-1", "session-1", [
          {
            name: "screen.png",
            mimeType: "image/png",
            size: 6,
            contentBase64: "aGVsbG8=",
          },
        ]),
      ).rejects.toThrow("Invalid attachment size");
      expect(existsSync(join(stateDir, "attachments"))).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
