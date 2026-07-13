import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_REQUEST,
  type AttachmentContentResult,
  type AttachmentDeleteResult,
  type AttachmentWriteResult,
  type ImageAttachmentUpload,
  type RunnerAttachmentRef,
} from "@roamcli/shared/protocol";

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ResolvedAttachmentPath {
  readonly absolutePath: string;
  readonly identity: FileIdentity;
}

type ResolvedAttachmentDeletePath =
  | { readonly exists: false }
  | ({ readonly exists: true } & ResolvedAttachmentPath);

interface CreatedAttachmentPath {
  readonly id: string;
  readonly runnerStoragePath: string;
  ownsFile: boolean;
  identity?: FileIdentity;
}

/*
 * O_NOFOLLOW protects the final path component. The directory chain is also
 * validated before and after opening because Node does not expose openat(2).
 */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export class SessionAttachmentStore {
  constructor(private readonly stateDir: string) {}

  async writeSessionAttachments(
    requestId: string,
    sessionId: string,
    uploads: readonly ImageAttachmentUpload[],
  ): Promise<AttachmentWriteResult> {
    validateUploads(uploads);
    const attachments: RunnerAttachmentRef[] = [];
    const created: CreatedAttachmentPath[] = [];
    try {
      for (const upload of uploads) {
        const content = Buffer.from(upload.contentBase64, "base64");
        const id = `attachment_${randomUUID()}`;
        const fileName = sanitizeFileName(upload.name);
        const runnerStoragePath = toPortablePath(
          join(
            "attachments",
            encodeStorageSegment(sessionId),
            encodeStorageSegment(id),
            fileName,
          ),
        );
        const attachmentDir = await this.ensureAttachmentDirectory(
          sessionId,
          id,
        );
        const createdPath: CreatedAttachmentPath = {
          id,
          runnerStoragePath,
          ownsFile: false,
        };
        created.push(createdPath);
        const absolutePath = join(attachmentDir, fileName);
        const handle = await open(
          absolutePath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
        createdPath.ownsFile = true;
        try {
          const openedStat = await handle.stat();
          createdPath.identity = {
            dev: openedStat.dev,
            ino: openedStat.ino,
          };
          if (!openedStat.isFile() || openedStat.nlink !== 1) {
            throw new Error("Invalid attachment storage path");
          }
          const validatedDir = await this.validateAttachmentDirectoryChain(
            sessionId,
            id,
          );
          if (validatedDir !== attachmentDir) {
            throw new Error("Invalid attachment storage path");
          }
          await handle.writeFile(content);
        } finally {
          await handle.close();
        }
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
    } catch (error: unknown) {
      for (const createdPath of created.reverse()) {
        await this.cleanupCreatedAttachment(sessionId, createdPath);
      }
      throw error;
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
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > MAX_ATTACHMENT_BYTES
    ) {
      throw new Error("Invalid attachment read limit");
    }
    const resolved = await this.resolveExistingAttachmentPath(
      sessionId,
      attachmentId,
      runnerStoragePath,
    );
    const handle = await open(
      resolved.absolutePath,
      constants.O_RDONLY | NO_FOLLOW,
    );
    let content: Buffer;
    try {
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.nlink !== 1 ||
        !sameFile(openedStat, resolved.identity)
      ) {
        throw new Error("Invalid attachment storage path");
      }
      if (openedStat.size > maxBytes) {
        throw new Error("Attachment is larger than the requested limit");
      }
      content = await readBounded(handle, maxBytes, openedStat.size);
      if (content.byteLength > maxBytes) {
        throw new Error("Attachment is larger than the requested limit");
      }
      const afterReadStat = await handle.stat();
      const current = await this.resolveExistingAttachmentPath(
        sessionId,
        attachmentId,
        runnerStoragePath,
      );
      if (
        !sameFile(afterReadStat, resolved.identity) ||
        !sameFile(current.identity, resolved.identity) ||
        afterReadStat.size !== openedStat.size ||
        afterReadStat.size !== content.byteLength
      ) {
        throw new Error("Invalid attachment storage path");
      }
    } finally {
      await handle.close();
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
    if (attachments.length > MAX_ATTACHMENTS_PER_REQUEST) {
      throw new Error("Too many attachments in one request");
    }
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const attachment of attachments) {
      try {
        const first = await this.resolveAttachmentDeletePath(
          sessionId,
          attachment.id,
          attachment.runnerStoragePath,
        );
        if (!first.exists) {
          deleted.push(attachment.id);
          continue;
        }
        const current = await this.resolveAttachmentDeletePath(
          sessionId,
          attachment.id,
          attachment.runnerStoragePath,
        );
        if (!current.exists) {
          deleted.push(attachment.id);
          continue;
        }
        if (!sameFile(first.identity, current.identity)) {
          throw new Error("Invalid attachment storage path");
        }
        try {
          await rm(current.absolutePath);
        } catch (error: unknown) {
          if (!isMissingPathError(error)) {
            throw error;
          }
        }
        await rmdir(dirname(current.absolutePath)).catch((error: unknown) => {
          if (!isDirectoryNotEmptyOrMissing(error)) {
            throw error;
          }
        });
        deleted.push(attachment.id);
      } catch {
        failed.push(attachment.id);
      }
    }
    return { requestId, sessionId, deleted, failed };
  }

  private async resolveAttachmentDeletePath(
    sessionId: string,
    attachmentId: string,
    runnerStoragePath: string,
  ): Promise<ResolvedAttachmentDeletePath> {
    try {
      const stateRealPath = await validateStateDirectory(this.stateDir);
      const attachmentsRoot = await validateDirectDirectory(
        stateRealPath,
        join(stateRealPath, "attachments"),
      );
      const sessionDir = await validateDirectDirectory(
        attachmentsRoot,
        join(attachmentsRoot, encodeStorageSegment(sessionId)),
      );
      const expectedAttachmentDir = join(
        sessionDir,
        encodeStorageSegment(attachmentId),
      );
      const absolutePath = this.resolveAttachmentPath(
        stateRealPath,
        expectedAttachmentDir,
        runnerStoragePath,
      );
      let attachmentDir: string;
      try {
        attachmentDir = await validateDirectDirectory(
          sessionDir,
          expectedAttachmentDir,
        );
      } catch (error: unknown) {
        if (isMissingPathError(error)) {
          return { exists: false };
        }
        throw error;
      }
      let fileStat;
      try {
        fileStat = await lstat(absolutePath);
      } catch (error: unknown) {
        if (isMissingPathError(error)) {
          return { exists: false };
        }
        throw error;
      }
      const fileRealPath = await realpath(absolutePath);
      if (
        fileStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        fileStat.nlink !== 1 ||
        dirname(fileRealPath) !== attachmentDir
      ) {
        throw new Error("Invalid attachment storage path");
      }
      return {
        exists: true,
        absolutePath,
        identity: { dev: fileStat.dev, ino: fileStat.ino },
      };
    } catch {
      throw new Error("Invalid attachment storage path");
    }
  }

  async localPathFor(
    sessionId: string,
    attachmentId: string,
    runnerStoragePath: string,
  ): Promise<string> {
    return (
      await this.resolveExistingAttachmentPath(
        sessionId,
        attachmentId,
        runnerStoragePath,
      )
    ).absolutePath;
  }

  private resolveAttachmentPath(
    stateRealPath: string,
    attachmentDir: string,
    runnerStoragePath: string,
  ): string {
    const absolutePath = resolve(stateRealPath, runnerStoragePath);
    const relativePath = relative(stateRealPath, absolutePath);
    if (
      relativePath === "" ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath) ||
      dirname(absolutePath) !== attachmentDir
    ) {
      throw new Error("Invalid attachment storage path");
    }
    return absolutePath;
  }

  private async resolveExistingAttachmentPath(
    sessionId: string,
    attachmentId: string,
    runnerStoragePath: string,
  ): Promise<ResolvedAttachmentPath> {
    try {
      const stateRealPath = await validateStateDirectory(this.stateDir);
      const attachmentDir = await this.validateAttachmentDirectoryChain(
        sessionId,
        attachmentId,
        stateRealPath,
      );
      const absolutePath = this.resolveAttachmentPath(
        stateRealPath,
        attachmentDir,
        runnerStoragePath,
      );
      const fileStat = await lstat(absolutePath);
      const fileRealPath = await realpath(absolutePath);
      if (
        fileStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        fileStat.nlink !== 1 ||
        dirname(fileRealPath) !== attachmentDir
      ) {
        throw new Error("Invalid attachment storage path");
      }
      return {
        absolutePath,
        identity: { dev: fileStat.dev, ino: fileStat.ino },
      };
    } catch {
      throw new Error("Invalid attachment storage path");
    }
  }

  private async validateAttachmentDirectoryChain(
    sessionId: string,
    attachmentId: string,
    knownStateRealPath?: string,
  ): Promise<string> {
    const stateRealPath =
      knownStateRealPath ?? (await validateStateDirectory(this.stateDir));
    const attachmentsRoot = await validateDirectDirectory(
      stateRealPath,
      join(stateRealPath, "attachments"),
    );
    const sessionDir = await validateDirectDirectory(
      attachmentsRoot,
      join(attachmentsRoot, encodeStorageSegment(sessionId)),
    );
    return validateDirectDirectory(
      sessionDir,
      join(sessionDir, encodeStorageSegment(attachmentId)),
    );
  }

  private async ensureAttachmentDirectory(
    sessionId: string,
    attachmentId: string,
  ): Promise<string> {
    const stateRealPath = await validateStateDirectory(this.stateDir);
    const attachmentsRoot = await ensureDirectDirectory(
      stateRealPath,
      join(stateRealPath, "attachments"),
    );
    const sessionDir = await ensureDirectDirectory(
      attachmentsRoot,
      join(attachmentsRoot, encodeStorageSegment(sessionId)),
    );
    return ensureDirectDirectory(
      sessionDir,
      join(sessionDir, encodeStorageSegment(attachmentId)),
    );
  }

  private async cleanupCreatedAttachment(
    sessionId: string,
    created: CreatedAttachmentPath,
  ): Promise<void> {
    if (created.ownsFile) {
      try {
        const resolved = await this.resolveExistingAttachmentPath(
          sessionId,
          created.id,
          created.runnerStoragePath,
        );
        if (
          created.identity === undefined ||
          sameFile(resolved.identity, created.identity)
        ) {
          await rm(resolved.absolutePath);
        }
      } catch {
        // Cleanup must never replace the original write failure.
      }
    }
    try {
      const attachmentDir = await this.validateAttachmentDirectoryChain(
        sessionId,
        created.id,
      );
      await rmdir(attachmentDir);
    } catch {
      // A non-empty or replaced directory is safer to leave untouched.
    }
  }
}

function encodeStorageSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url") || "empty";
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

function isDirectoryNotEmptyOrMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOTEMPTY" || error.code === "ENOENT")
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function ensureDirectDirectory(
  realParent: string,
  directory: string,
): Promise<string> {
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!hasNodeErrorCode(error, "EEXIST")) {
      throw error;
    }
  });
  const realDirectory = await validateDirectDirectory(realParent, directory);
  await chmod(realDirectory, 0o700);
  return realDirectory;
}

async function validateStateDirectory(stateDir: string): Promise<string> {
  const stateStat = await lstat(stateDir);
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    throw new Error("Invalid attachment storage path");
  }
  return realpath(stateDir);
}

async function validateDirectDirectory(
  realParent: string,
  directory: string,
): Promise<string> {
  const directoryStat = await lstat(directory);
  const realDirectory = await realpath(directory);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    dirname(realDirectory) !== realParent
  ) {
    throw new Error("Invalid attachment storage path");
  }
  return realDirectory;
}

function validateUploads(uploads: readonly ImageAttachmentUpload[]): void {
  if (uploads.length > MAX_ATTACHMENTS_PER_REQUEST) {
    throw new Error("Too many attachments in one request");
  }
  for (const upload of uploads) {
    if (
      !Number.isInteger(upload.size) ||
      upload.size <= 0 ||
      upload.size > MAX_ATTACHMENT_BYTES
    ) {
      throw new Error(`Attachment is too large: ${upload.name}`);
    }
    if (
      upload.contentBase64.length === 0 ||
      upload.contentBase64.length > MAX_ATTACHMENT_BASE64_LENGTH
    ) {
      throw new Error(`Attachment payload is too large: ${upload.name}`);
    }
    const decodedSize = base64DecodedByteLength(upload.contentBase64);
    if (decodedSize === undefined) {
      throw new Error(`Invalid attachment payload for ${upload.name}`);
    }
    if (decodedSize !== upload.size) {
      throw new Error(`Invalid attachment size for ${upload.name}`);
    }
  }
}

function base64DecodedByteLength(value: string): number | undefined {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  const firstPadding = value.indexOf("=");
  if (firstPadding !== -1 && !/^={1,2}$/.test(value.slice(firstPadding))) {
    return undefined;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

async function readBounded(
  handle: FileHandle,
  maxBytes: number,
  expectedBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(
    Math.min(maxBytes + 1, Math.max(1, expectedBytes + 1)),
  );
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function sameFile(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
