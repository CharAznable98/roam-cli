import { open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  FileContentResult,
  FileNode,
  FileTreeResult,
  FileWriteResult,
  PathSearchEntry,
  PathSearchResult,
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

export interface SearchWorkspacePathsOptions {
  workspace: string;
  requestId: string;
  basePath: string;
  query?: string;
  limit?: number;
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

export async function searchWorkspacePaths(
  options: SearchWorkspacePathsOptions,
): Promise<PathSearchResult> {
  const base = await resolveSearchBase(options.workspace, options.basePath);
  if (!base) {
    return emptyPathSearch(options);
  }

  const query = options.query ?? "";
  const limit = clampSearchLimit(options.limit);
  const entries =
    query.trim().length === 0
      ? await readTopLevelPathEntries(base.path, base.realPath, limit)
      : await searchPathEntries(base.path, base.realPath, query, limit);
  return {
    requestId: options.requestId,
    basePath: options.basePath,
    query,
    entries,
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
  const buffer = Buffer.alloc(Math.min(maxBytes + 1, targetStat.size));
  const handle = await open(target.path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > maxBytes || targetStat.size > maxBytes;
    return {
      requestId: options.requestId,
      sessionId: options.sessionId,
      path: toNodePath(options.sessionCwd, target.path),
      content: buffer
        .subarray(0, Math.min(bytesRead, maxBytes))
        .toString("utf8"),
      truncated,
      encoding: "utf8",
    };
  } finally {
    await handle.close();
  }
}

async function resolveSearchBase(
  workspace: string,
  basePath: string,
): Promise<{ path: string; realPath: string } | undefined> {
  try {
    const workspacePath = resolve(workspace);
    const candidate = isAbsolute(basePath)
      ? resolve(basePath)
      : resolve(workspacePath, basePath);
    const [realWorkspace, realCandidate] = await Promise.all([
      realpath(workspacePath),
      realpath(candidate),
    ]);
    const candidateStat = await stat(realCandidate);
    if (
      !candidateStat.isDirectory() ||
      !isInside(realWorkspace, realCandidate)
    ) {
      return undefined;
    }
    return { path: candidate, realPath: realCandidate };
  } catch {
    return undefined;
  }
}

function emptyPathSearch(
  options: SearchWorkspacePathsOptions,
): PathSearchResult {
  return {
    requestId: options.requestId,
    basePath: options.basePath,
    query: options.query ?? "",
    entries: [],
  };
}

async function readTopLevelPathEntries(
  basePath: string,
  realBasePath: string,
  limit: number,
): Promise<PathSearchEntry[]> {
  let entries;
  try {
    entries = await readdir(basePath, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: PathSearchEntry[] = [];
  for (const entry of entries.sort(compareDirents)) {
    if (result.length >= limit) {
      break;
    }
    const item = await pathSearchEntry(
      basePath,
      realBasePath,
      entry.name,
      entry,
    );
    if (item) {
      result.push(item);
    }
  }
  return result;
}

async function searchPathEntries(
  basePath: string,
  realBasePath: string,
  rawQuery: string,
  limit: number,
): Promise<PathSearchEntry[]> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return readTopLevelPathEntries(basePath, realBasePath, limit);
  }

  const candidates: Array<{ entry: PathSearchEntry; score: number }> = [];
  await walkSearchBase(basePath, realBasePath, async (entry) => {
    const score = pathMatchScore(entry, query);
    if (score !== undefined) {
      candidates.push({ entry, score });
    }
  });

  return candidates
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.entry.type !== right.entry.type) {
        return left.entry.type === "directory" ? -1 : 1;
      }
      return left.entry.path.localeCompare(right.entry.path);
    })
    .slice(0, limit)
    .map((candidate) => candidate.entry);
}

async function walkSearchBase(
  basePath: string,
  realBasePath: string,
  visit: (entry: PathSearchEntry) => void | Promise<void>,
): Promise<void> {
  const visited = new Set<string>([realBasePath]);
  const stack = [basePath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort(compareDirents).reverse()) {
      const child = await pathSearchEntry(
        basePath,
        realBasePath,
        relative(basePath, resolve(current, entry.name)),
        entry,
        visited,
      );
      if (!child) {
        continue;
      }
      await visit(child);
      if (child.type === "directory") {
        stack.push(resolve(basePath, child.path));
      }
    }
  }
}

async function pathSearchEntry(
  basePath: string,
  realBasePath: string,
  relativePath: string,
  entry: { name: string; isDirectory(): boolean; isFile(): boolean },
  visited?: Set<string>,
): Promise<PathSearchEntry | undefined> {
  if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
    return undefined;
  }
  if (!entry.isDirectory() && !entry.isFile()) {
    return undefined;
  }
  const childPath = resolve(basePath, relativePath);
  try {
    const childRealPath = await realpath(childPath);
    if (!isInside(realBasePath, childRealPath)) {
      return undefined;
    }
    if (visited?.has(childRealPath)) {
      return undefined;
    }
    visited?.add(childRealPath);
    return {
      path: relativePath.split(sep).join("/"),
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    };
  } catch {
    return undefined;
  }
}

function pathMatchScore(
  entry: PathSearchEntry,
  query: string,
): number | undefined {
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();
  if (name.startsWith(query)) {
    return 0;
  }
  if (path.startsWith(query)) {
    return 1;
  }
  if (name.includes(query)) {
    return 2;
  }
  if (path.includes(query) || fuzzyIncludes(path, query)) {
    return 3;
  }
  return undefined;
}

function fuzzyIncludes(value: string, query: string): boolean {
  let index = 0;
  for (const char of value) {
    if (char === query[index]) {
      index += 1;
      if (index === query.length) {
        return true;
      }
    }
  }
  return false;
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

function clampSearchLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 50, 200));
}
