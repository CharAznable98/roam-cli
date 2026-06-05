import { open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { FileContentResult, FileNode, FileTreeResult, FileWriteResult } from "@roamcli/protocol";

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
  "target"
]);

export interface FileRequestScope {
  workspace: string;
  sessionCwd: string;
}

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

export async function readFileTree(options: ReadFileTreeOptions): Promise<FileTreeResult> {
  const root = await resolveExistingPath(options, options.path ?? ".");
  const rootStat = await stat(root.path);
  if (!rootStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${options.path ?? "."}`);
  }

  return {
    requestId: options.requestId,
    sessionId: options.sessionId,
    root: await buildNode(root.path, options.sessionCwd, root.realPath, clampDepth(options.depth), new Set([root.realPath]))
  };
}

export async function readFileContent(options: ReadFileContentOptions): Promise<FileContentResult> {
  const target = await resolveExistingPath(options, options.path);
  const targetStat = await stat(target.path);
  if (!targetStat.isFile()) {
    throw new Error(`Path is not a file: ${options.path}`);
  }

  const maxBytes = clampMaxBytes(options.maxBytes);
  const buffer = Buffer.alloc(Math.min(maxBytes + 1, targetStat.size));
  const handle = await open(target.path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > maxBytes || targetStat.size > maxBytes;
    return {
      requestId: options.requestId,
      sessionId: options.sessionId,
      path: toNodePath(options.sessionCwd, target.path),
      content: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
      truncated,
      encoding: "utf8"
    };
  } finally {
    await handle.close();
  }
}

export async function writeFileContent(options: WriteFileContentOptions): Promise<FileWriteResult> {
  const target = await resolveWritableFilePath(options, options.path);
  await writeFile(target.path, options.content, "utf8");
  return {
    requestId: options.requestId,
    sessionId: options.sessionId,
    path: toNodePath(options.sessionCwd, target.path),
    bytesWritten: Buffer.byteLength(options.content, "utf8"),
    encoding: "utf8"
  };
}

async function buildNode(
  path: string,
  sessionCwd: string,
  realSessionCwd: string,
  depth: number,
  visited: Set<string>
): Promise<FileNode> {
  const pathStat = await stat(path);
  const nodePath = toNodePath(sessionCwd, path);

  if (!pathStat.isDirectory()) {
    return {
      path: nodePath,
      name: basename(path),
      type: "file",
      size: pathStat.size
    };
  }

  const node: FileNode = {
    path: nodePath,
    name: nodePath === "." ? basename(path) : basename(path),
    type: "directory"
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
      children.push(await buildNode(childPath, sessionCwd, realSessionCwd, depth - 1, visited));
      visited.delete(childRealPath);
    } catch {
      continue;
    }
  }

  node.children = children;
  return node;
}

async function resolveExistingPath(scope: FileRequestScope, path: string): Promise<{ path: string; realPath: string }> {
  const workspace = resolve(scope.workspace);
  const sessionCwd = resolve(scope.sessionCwd);
  const candidate = resolve(sessionCwd, path);
  if (!isInside(workspace, sessionCwd)) {
    throw new Error(`Session cwd escapes workspace: ${scope.sessionCwd}`);
  }
  if (!isInside(sessionCwd, candidate)) {
    throw new Error(`Path escapes session cwd: ${path}`);
  }

  const [realWorkspace, realSessionCwd, realCandidate] = await Promise.all([
    realpath(workspace),
    realpath(sessionCwd),
    realpath(candidate)
  ]);
  if (!isInside(realWorkspace, realSessionCwd)) {
    throw new Error(`Session cwd escapes workspace: ${scope.sessionCwd}`);
  }
  if (!isInside(realSessionCwd, realCandidate)) {
    throw new Error(`Path escapes session cwd: ${path}`);
  }
  return { path: candidate, realPath: realCandidate };
}

async function resolveWritableFilePath(scope: FileRequestScope, path: string): Promise<{ path: string }> {
  const workspace = resolve(scope.workspace);
  const sessionCwd = resolve(scope.sessionCwd);
  const candidate = resolve(sessionCwd, path);
  if (!isInside(workspace, sessionCwd)) {
    throw new Error(`Session cwd escapes workspace: ${scope.sessionCwd}`);
  }
  if (!isInside(sessionCwd, candidate)) {
    throw new Error(`Path escapes session cwd: ${path}`);
  }

  const [realWorkspace, realSessionCwd] = await Promise.all([realpath(workspace), realpath(sessionCwd)]);
  if (!isInside(realWorkspace, realSessionCwd)) {
    throw new Error(`Session cwd escapes workspace: ${scope.sessionCwd}`);
  }

  try {
    const realCandidate = await realpath(candidate);
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) {
      throw new Error(`Path is not a file: ${path}`);
    }
    if (!isInside(realSessionCwd, realCandidate)) {
      throw new Error(`Path escapes session cwd: ${path}`);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Path does not exist: ${path}`);
    }
    throw error;
  }

  return { path: candidate };
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function toNodePath(sessionCwd: string, path: string): string {
  const value = relative(sessionCwd, path);
  return value.length === 0 ? "." : value.split(sep).join("/");
}

function compareDirents(left: { name: string; isDirectory(): boolean }, right: { name: string; isDirectory(): boolean }): number {
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
