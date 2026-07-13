import { existsSync } from "node:fs";
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_REQUEST,
} from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { SessionAttachmentStore } from "../sessions/attachments.js";

describe("SessionAttachmentStore", () => {
  it("rejects state files that are not owned by the requested attachment", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    try {
      const store = new SessionAttachmentStore(stateDir);
      await writeFile(join(stateDir, "config.json"), '{"token":"secret"}');

      await expect(
        store.readSessionAttachment(
          "read-state",
          "session-1",
          "attachment-1",
          "config.json",
          1024,
        ),
      ).rejects.toThrow("Invalid attachment storage path");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["state", "root", "session", "attachment"] as const)(
    "rejects %s directory symlinks for read, delete, and local paths",
    async (layer) => {
      const stateDir = await mkdtemp(
        join(tmpdir(), "roam-runner-attachments-"),
      );
      const outsideDir = await mkdtemp(join(tmpdir(), "roam-runner-outside-"));
      try {
        const store = new SessionAttachmentStore(stateDir);
        const written = await store.writeSessionAttachments(
          `write-${layer}-link`,
          "session-1",
          [imageUpload()],
        );
        const attachment = written.attachments[0];
        const localPath = await store.localPathFor(
          "session-1",
          attachment?.id ?? "missing",
          attachment?.runnerStoragePath ?? "",
        );
        const attachmentDir = dirname(localPath);
        const sessionDir = dirname(attachmentDir);
        const attachmentsRoot = dirname(sessionDir);
        const target = {
          state: stateDir,
          root: attachmentsRoot,
          session: sessionDir,
          attachment: attachmentDir,
        }[layer];
        const movedTarget = join(outsideDir, `moved-${layer}`);
        const targetRealPath = await realpath(target);
        const movedFile = join(
          movedTarget,
          relative(targetRealPath, localPath),
        );
        await rename(target, movedTarget);
        await symlink(movedTarget, target, "dir");

        await expect(
          store.readSessionAttachment(
            `read-${layer}-link`,
            "session-1",
            attachment?.id ?? "missing",
            attachment?.runnerStoragePath ?? "",
            1024,
          ),
        ).rejects.toThrow("Invalid attachment storage path");
        await expect(
          store.localPathFor(
            "session-1",
            attachment?.id ?? "missing",
            attachment?.runnerStoragePath ?? "",
          ),
        ).rejects.toThrow("Invalid attachment storage path");
        await expect(
          store.deleteSessionAttachments(`delete-${layer}-link`, "session-1", [
            {
              id: attachment?.id ?? "missing",
              runnerStoragePath: attachment?.runnerStoragePath ?? "",
            },
          ]),
        ).resolves.toMatchObject({
          deleted: [],
          failed: [attachment?.id],
        });
        await expect(readFile(movedFile, "utf8")).resolves.toBe("hello");
      } finally {
        await rm(stateDir, { recursive: true, force: true });
        await rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it("never deletes runner state through an attachment request", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    try {
      const store = new SessionAttachmentStore(stateDir);
      const configPath = join(stateDir, "config.json");
      await writeFile(configPath, '{"token":"secret"}');

      await expect(
        store.deleteSessionAttachments("delete-state", "session-1", [
          { id: "attachment-1", runnerStoragePath: "config.json" },
        ]),
      ).resolves.toMatchObject({
        deleted: [],
        failed: ["attachment-1"],
      });
      await expect(readFile(configPath, "utf8")).resolves.toBe(
        '{"token":"secret"}',
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an attachment file symlink that escapes its canonical root", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "roam-runner-secret-"));
    try {
      const store = new SessionAttachmentStore(stateDir);
      const written = await store.writeSessionAttachments(
        "write-symlink",
        "session-1",
        [
          {
            name: "screen.png",
            mimeType: "image/png",
            size: 5,
            contentBase64: "aGVsbG8=",
          },
        ],
      );
      const attachment = written.attachments[0];
      const localPath = await store.localPathFor(
        "session-1",
        attachment?.id ?? "missing",
        attachment?.runnerStoragePath ?? "",
      );
      const secretPath = join(outsideDir, "secret.txt");
      await writeFile(secretPath, "secret");
      await rm(localPath);
      await symlink(secretPath, localPath);

      await expect(
        store.readSessionAttachment(
          "read-symlink",
          "session-1",
          attachment?.id ?? "missing",
          attachment?.runnerStoragePath ?? "",
          1024,
        ),
      ).rejects.toThrow("Invalid attachment storage path");
      await expect(
        store.localPathFor(
          "session-1",
          attachment?.id ?? "missing",
          attachment?.runnerStoragePath ?? "",
        ),
      ).rejects.toThrow("Invalid attachment storage path");
      await expect(
        store.deleteSessionAttachments("delete-symlink", "session-1", [
          {
            id: attachment?.id ?? "missing",
            runnerStoragePath: attachment?.runnerStoragePath ?? "",
          },
        ]),
      ).resolves.toMatchObject({
        deleted: [],
        failed: [attachment?.id],
      });
      await expect(readFile(secretPath, "utf8")).resolves.toBe("secret");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects an attachment root symlink instead of writing outside state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "roam-runner-outside-"));
    try {
      const store = new SessionAttachmentStore(stateDir);
      await symlink(outsideDir, join(stateDir, "attachments"));

      await expect(
        store.writeSessionAttachments("write-root-link", "session-1", [
          {
            name: "screen.png",
            mimeType: "image/png",
            size: 5,
            contentBase64: "aGVsbG8=",
          },
        ]),
      ).rejects.toThrow("Invalid attachment storage path");
      await expect(readdir(outsideDir)).resolves.toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not alias different session ids onto one attachment directory", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    try {
      const store = new SessionAttachmentStore(stateDir);
      const written = await store.writeSessionAttachments(
        "write-collision",
        "team/a",
        [
          {
            name: "screen.png",
            mimeType: "image/png",
            size: 5,
            contentBase64: "aGVsbG8=",
          },
        ],
      );
      const attachment = written.attachments[0];

      await expect(
        store.readSessionAttachment(
          "read-collision",
          "team_a",
          attachment?.id ?? "missing",
          attachment?.runnerStoragePath ?? "",
          1024,
        ),
      ).rejects.toThrow("Invalid attachment storage path");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("stores attachment directories and content with private modes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    try {
      const store = new SessionAttachmentStore(stateDir);
      const written = await store.writeSessionAttachments(
        "write-private",
        "session-1",
        [
          {
            name: "screen.png",
            mimeType: "image/png",
            size: 5,
            contentBase64: "aGVsbG8=",
          },
        ],
      );
      const attachment = written.attachments[0];
      const localPath = await store.localPathFor(
        "session-1",
        attachment?.id ?? "missing",
        attachment?.runnerStoragePath ?? "",
      );

      expect((await stat(localPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(localPath, ".."))).mode & 0o777).toBe(0o700);
      expect((await stat(join(stateDir, "attachments"))).mode & 0o777).toBe(
        0o700,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("removes earlier files when a later attachment write fails", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    const probePath = join(stateDir, "probe");
    const probe = await open(probePath, "w");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      writeFile: FileHandle["writeFile"];
    };
    const originalWriteFile = fileHandlePrototype.writeFile;
    await probe.close();
    await rm(probePath);
    let writes = 0;
    const writeSpy = vi
      .spyOn(fileHandlePrototype, "writeFile")
      .mockImplementation(async function (this: FileHandle, data, options) {
        writes += 1;
        if (writes === 2) {
          throw new Error("simulated disk failure");
        }
        return originalWriteFile.call(this, data, options);
      });
    try {
      const store = new SessionAttachmentStore(stateDir);
      await expect(
        store.writeSessionAttachments("write-rollback", "session-1", [
          imageUpload(),
          { ...imageUpload(), name: "second.png" },
        ]),
      ).rejects.toThrow("simulated disk failure");

      const attachmentsRoot = join(stateDir, "attachments");
      const sessionDirectories = await readdir(attachmentsRoot);
      expect(sessionDirectories).toHaveLength(1);
      await expect(
        readdir(join(attachmentsRoot, sessionDirectories[0] ?? "missing")),
      ).resolves.toEqual([]);
    } finally {
      writeSpy.mockRestore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

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

      const localPath = await store.localPathFor(
        "s/1",
        attachment?.id ?? "missing",
        attachment?.runnerStoragePath ?? "",
      );
      const relativePath = relative(await realpath(stateDir), localPath);
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

      await expect(
        store.deleteSessionAttachments("delete-retry", "s/1", [
          {
            id: attachment?.id ?? "missing",
            runnerStoragePath: attachment?.runnerStoragePath ?? "",
          },
        ]),
      ).resolves.toMatchObject({
        deleted: [attachment?.id],
        failed: [],
      });
      await expect(
        store.deleteSessionAttachments("delete-wrong-id", "s/1", [
          {
            id: "different-attachment",
            runnerStoragePath: attachment?.runnerStoragePath ?? "",
          },
        ]),
      ).resolves.toMatchObject({
        deleted: [],
        failed: ["different-attachment"],
      });
      await expect(
        store.deleteSessionAttachments("delete-missing-escape", "s/1", [
          { id: "missing", runnerStoragePath: "../missing.png" },
        ]),
      ).resolves.toMatchObject({
        deleted: [],
        failed: ["missing"],
      });
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

  it("enforces attachment count, byte, and base64 payload limits before writing", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    try {
      const store = new SessionAttachmentStore(stateDir);

      await expect(
        store.writeSessionAttachments(
          "write-too-many",
          "session-1",
          Array.from({ length: MAX_ATTACHMENTS_PER_REQUEST + 1 }, imageUpload),
        ),
      ).rejects.toThrow("Too many attachments");
      await expect(
        store.writeSessionAttachments("write-too-large", "session-1", [
          { ...imageUpload(), size: MAX_ATTACHMENT_BYTES + 1 },
        ]),
      ).rejects.toThrow("Attachment is too large");
      await expect(
        store.writeSessionAttachments("write-payload-too-large", "session-1", [
          {
            ...imageUpload(),
            size: MAX_ATTACHMENT_BYTES,
            contentBase64: "A".repeat(MAX_ATTACHMENT_BASE64_LENGTH + 4),
          },
        ]),
      ).rejects.toThrow("Attachment payload is too large");
      expect(existsSync(join(stateDir, "attachments"))).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reads at most maxBytes plus one and rejects oversized content", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "roam-runner-attachments-"));
    try {
      const store = new SessionAttachmentStore(stateDir);
      const written = await store.writeSessionAttachments(
        "write-read-limit",
        "session-1",
        [imageUpload()],
      );
      const attachment = written.attachments[0];

      await expect(
        store.readSessionAttachment(
          "read-too-small",
          "session-1",
          attachment?.id ?? "missing",
          attachment?.runnerStoragePath ?? "",
          4,
        ),
      ).rejects.toThrow("Attachment is larger than the requested limit");
      await expect(
        store.readSessionAttachment(
          "read-invalid-limit",
          "session-1",
          attachment?.id ?? "missing",
          attachment?.runnerStoragePath ?? "",
          MAX_ATTACHMENT_BYTES + 1,
        ),
      ).rejects.toThrow("Invalid attachment read limit");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function imageUpload() {
  return {
    name: "screen.png",
    mimeType: "image/png",
    size: 5,
    contentBase64: "aGVsbG8=",
  };
}
