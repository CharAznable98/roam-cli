import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type {
  DirectoryCreateResult,
  FileContentResult,
  FileNode,
  FileTreeResult,
  FileWriteResult,
} from "@roamcli/shared/protocol";
import {
  type FileRequestScope,
  isInside,
  resolveExistingPath,
  resolveWritableExistingFilePath,
  toNodePath,
} from "./scope.js";

export type { FileRequestScope } from "./scope.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

export interface ReadFileTreeOptions extends FileRequestScope {
  requestId: string;
  sessionId: string;
  path?: string;
  depth?: number;
}

export interface ReadFileContentOptions extends FileRequestScope {
  requestId: string;
  sessionId: string;
  path: string;
  maxBytes?: number;
}

export interface WriteFileContentOptions extends FileRequestScope {
  requestId: string;
  sessionId: string;
  path: string;
  content: string;
}

export interface CreateDirectoryOptions extends FileRequestScope {
  requestId: string;
  parentPath?: string;
  name: string;
}

export async function readFileTree(
  options: ReadFileTreeOptions,
): Promise<FileTreeResult> {
  const root = await resolveExistingPath(options, options.path ?? ".");
  const rootStat = await stat(root.path);
  if (!rootStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${options.path ?? "."}`);
  }

  return {
    requestId: options.requestId,
    sessionId: options.sessionId,
    root: await buildNode(
      root.path,
      options.sessionCwd,
      root.realPath,
      clampDepth(options.depth),
      new Set([root.realPath]),
    ),
  };
}

export async function readFileContent(
  options: ReadFileContentOptions,
): Promise<FileContentResult> {
  const target = await resolveExistingPath(options, options.path);
  const targetStat = await stat(target.path);
  if (!targetStat.isFile()) {
    throw new Error(`Path is not a file: ${options.path}`);
  }

  const maxBytes = clampMaxBytes(options.maxBytes);
  const imageMimeType = imageMimeTypeForPath(target.path);
  if (imageMimeType) {
    const truncated = targetStat.size > maxBytes;
    return {
      requestId: options.requestId,
      sessionId: options.sessionId,
      path: toNodePath(options.sessionCwd, target.path),
      kind: "image",
      ...(truncated || targetStat.size === 0
        ? {}
        : {
            contentBase64: await readFileBase64(target.path, targetStat.size),
          }),
      mimeType: imageMimeType,
      size: targetStat.size,
      truncated,
      encoding: "base64",
    };
  }

  const buffer = Buffer.alloc(Math.min(maxBytes + 1, targetStat.size));
  const handle = await open(target.path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > maxBytes || targetStat.size > maxBytes;
    const contentBytes = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    if (isLikelyBinaryBuffer(contentBytes)) {
      return {
        requestId: options.requestId,
        sessionId: options.sessionId,
        path: toNodePath(options.sessionCwd, target.path),
        kind: "binary",
        mimeType: "application/octet-stream",
        size: targetStat.size,
        truncated,
        encoding: "binary",
      };
    }
    return {
      requestId: options.requestId,
      sessionId: options.sessionId,
      path: toNodePath(options.sessionCwd, target.path),
      kind: "text",
      content: contentBytes.toString("utf8"),
      truncated,
      encoding: "utf8",
    };
  } finally {
    await handle.close();
  }
}

export async function writeFileContent(
  options: WriteFileContentOptions,
): Promise<FileWriteResult> {
  const target = await resolveWritableExistingFilePath(options, options.path);
  await writeFile(target.path, options.content, "utf8");
  return {
    requestId: options.requestId,
    sessionId: options.sessionId,
    path: toNodePath(options.sessionCwd, target.path),
    bytesWritten: Buffer.byteLength(options.content, "utf8"),
    encoding: "utf8",
  };
}

export async function createDirectory(
  options: CreateDirectoryOptions,
): Promise<DirectoryCreateResult> {
  const cleanName = validateDirectoryName(options.name);
  const parent = await resolveExistingPath(options, options.parentPath ?? ".");
  const parentStat = await stat(parent.path);
  if (!parentStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${options.parentPath ?? "."}`);
  }

  const targetPath = resolve(parent.path, cleanName);
  if (!isInside(parent.path, targetPath)) {
    throw new Error(`Path escapes parent directory: ${cleanName}`);
  }

  await mkdir(targetPath);
  const targetRealPath = await realpath(targetPath);
  if (!isInside(parent.realPath, targetRealPath)) {
    throw new Error(`Path escapes parent directory: ${cleanName}`);
  }

  return {
    requestId: options.requestId,
    path: toNodePath(options.sessionCwd, targetPath),
    node: await buildNode(
      targetPath,
      options.sessionCwd,
      parent.realPath,
      1,
      new Set([parent.realPath, targetRealPath]),
    ),
  };
}

async function buildNode(
  path: string,
  sessionCwd: string,
  realSessionCwd: string,
  depth: number,
  visited: Set<string>,
): Promise<FileNode> {
  const pathStat = await stat(path);
  const nodePath = toNodePath(sessionCwd, path);

  if (!pathStat.isDirectory()) {
    return {
      path: nodePath,
      name: basename(path),
      type: "file",
      size: pathStat.size,
    };
  }

  const node: FileNode = {
    path: nodePath,
    name: nodePath === "." ? basename(path) : basename(path),
    type: "directory",
  };
  if (depth <= 0) {
    return node;
  }

  const entries = await readdir(path, { withFileTypes: true });
  const children: FileNode[] = [];
  for (const entry of entries.sort(compareDirents)) {
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

    const childPath = resolve(path, entry.name);
    try {
      const childRealPath = await realpath(childPath);
      if (!isInside(realSessionCwd, childRealPath)) {
        continue;
      }
      if (visited.has(childRealPath)) {
        continue;
      }
      visited.add(childRealPath);
      children.push(
        await buildNode(
          childPath,
          sessionCwd,
          realSessionCwd,
          depth - 1,
          visited,
        ),
      );
      visited.delete(childRealPath);
    } catch {
      continue;
    }
  }

  node.children = children;
  return node;
}

function compareDirents(
  left: { name: string; isDirectory(): boolean },
  right: { name: string; isDirectory(): boolean },
): number {
  const leftDirectory = left.isDirectory();
  const rightDirectory = right.isDirectory();
  if (leftDirectory !== rightDirectory) {
    return leftDirectory ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function clampDepth(depth: number | undefined): number {
  return Math.max(0, Math.min(depth ?? 3, 8));
}

function clampMaxBytes(maxBytes: number | undefined): number {
  return Math.max(1, Math.min(maxBytes ?? DEFAULT_MAX_BYTES, 1024 * 1024));
}

function imageMimeTypeForPath(path: string): string | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const mimeTypes: Record<string, string> = {
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  return mimeTypes[extension];
}

async function readFileBase64(path: string, size: number): Promise<string> {
  const buffer = await readFile(path);
  return buffer.subarray(0, size).toString("base64");
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  const decoded = decodeUtf8Sample(buffer);
  if (decoded === undefined) {
    return true;
  }
  return /[\u0001-\u0008\u000b\u000e-\u001f]/.test(decoded);
}

function decodeUtf8Sample(buffer: Buffer): string | undefined {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= 3; trim += 1) {
    const length = buffer.length - trim;
    if (length <= 0) {
      break;
    }
    try {
      return decoder.decode(buffer.subarray(0, length));
    } catch {
      // The read sample may end in the middle of a multibyte UTF-8 sequence.
    }
  }
  return undefined;
}

function validateDirectoryName(name: string): string {
  const cleanName = name.trim();
  if (
    cleanName.length === 0 ||
    cleanName === "." ||
    cleanName === ".." ||
    isAbsolute(cleanName) ||
    cleanName.includes("/") ||
    cleanName.includes("\\")
  ) {
    throw new Error(`Invalid directory name: ${name}`);
  }
  return cleanName;
}
