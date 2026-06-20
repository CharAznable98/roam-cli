import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AttachmentContentResult,
  AttachmentDeleteResult,
  AttachmentWriteResult,
  ImageAttachmentUpload,
  RunnerAttachmentRef,
} from "@roamcli/shared/protocol";

export class SessionAttachmentStore {
  constructor(private readonly stateDir: string) {}

  async writeSessionAttachments(
    requestId: string,
    sessionId: string,
    uploads: readonly ImageAttachmentUpload[],
  ): Promise<AttachmentWriteResult> {
    const attachments: RunnerAttachmentRef[] = [];
    for (const upload of uploads) {
      const content = Buffer.from(upload.contentBase64, "base64");
      if (content.byteLength !== upload.size) {
        throw new Error(`Invalid attachment size for ${upload.name}`);
      }
      const id = `attachment_${randomUUID()}`;
      const fileName = sanitizeFileName(upload.name);
      const runnerStoragePath = toPortablePath(
        join("attachments", sanitizeSegment(sessionId), id, fileName),
      );
      const absolutePath = this.resolveStoragePath(runnerStoragePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, { flag: "wx" });
      attachments.push({
        id,
        kind: "image",
        name: upload.name,
        mimeType: upload.mimeType,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        runnerStoragePath,
      });
    }
    return { requestId, sessionId, attachments };
  }

  async readSessionAttachment(
    requestId: string,
    sessionId: string,
    attachmentId: string,
    runnerStoragePath: string,
    maxBytes: number,
  ): Promise<AttachmentContentResult> {
    const absolutePath = this.resolveStoragePath(runnerStoragePath);
    const content = await readFile(absolutePath);
    if (content.byteLength > maxBytes) {
      throw new Error("Attachment is larger than the requested limit");
    }
    return {
      requestId,
      sessionId,
      attachmentId,
      name: fileNameFromStoragePath(runnerStoragePath),
      mimeType: "application/octet-stream",
      size: content.byteLength,
      contentBase64: content.toString("base64"),
    };
  }

  async deleteSessionAttachments(
    requestId: string,
    sessionId: string,
    attachments: readonly { id: string; runnerStoragePath: string }[],
  ): Promise<AttachmentDeleteResult> {
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const attachment of attachments) {
      try {
        const absolutePath = this.resolveStoragePath(
          attachment.runnerStoragePath,
        );
        await rm(absolutePath, { force: true });
        await rm(dirname(absolutePath), { recursive: true, force: true });
        deleted.push(attachment.id);
      } catch {
        failed.push(attachment.id);
      }
    }
    return { requestId, sessionId, deleted, failed };
  }

  localPathFor(runnerStoragePath: string): string {
    return this.resolveStoragePath(runnerStoragePath);
  }

  private resolveStoragePath(runnerStoragePath: string): string {
    const absolutePath = resolve(this.stateDir, runnerStoragePath);
    const relativePath = relative(this.stateDir, absolutePath);
    if (
      relativePath === "" ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      throw new Error("Invalid attachment storage path");
    }
    return absolutePath;
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .replace(/[/\\]/g, "_")
    .replace(/[\u0000-\u001f]/g, "");
  const trimmed = sanitized.trim().replace(/^\.+/, "").replace(/^\.+$/, "");
  return trimmed.length > 0 ? trimmed.slice(0, 180) : "image";
}

function fileNameFromStoragePath(runnerStoragePath: string): string {
  const parts = runnerStoragePath.split(/[\\/]/);
  return parts.at(-1) || "image";
}

function toPortablePath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}
