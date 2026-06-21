import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  DirectoryCreateResult,
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
const DEFAULT_PATH_SEARCH_MAX_CANDIDATES = 1000;
const DEFAULT_PATH_SEARCH_MAX_VISITED_ENTRIES = 5000;
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
  clientRequestId?: string;
  sessionId: string;
  path?: string;
  depth?: number;
  includeFiles?: boolean;
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

export interface SearchWorkspacePathsOptions {
  workspace: string;
  requestId: string;
  basePath: string;
  query?: string;
  limit?: number;
  maxCandidateEntries?: number;
  maxVisitedEntries?: number;
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
    ...(options.clientRequestId === undefined
      ? {}
      : { clientRequestId: options.clientRequestId }),
    sessionId: options.sessionId,
    root: await buildNode(root.path, {
      sessionCwd: options.sessionCwd,
      realSessionCwd: root.realSessionCwd,
      depth: clampDepth(options.depth),
      visited: new Set([root.realPath]),
      includeFiles: options.includeFiles ?? true,
      ignoreGeneratedDirectories: options.includeFiles !== false,
    }),
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
      : await searchPathEntries(base.path, base.realPath, query, limit, {
          maxCandidateEntries: clampSearchCandidateEntries(
            options.maxCandidateEntries,
            limit,
          ),
          maxVisitedEntries: clampSearchVisitedEntries(
            options.maxVisitedEntries,
            limit,
          ),
        });
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
    const content =
      contentBytes.length === 0
        ? ""
        : decodeLikelyTextBuffer(contentBytes, {
            allowTrailingPartialUtf8: truncated,
          });
    if (content === undefined) {
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
      content,
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
    node: await buildNode(targetPath, {
      sessionCwd: options.sessionCwd,
      realSessionCwd: parent.realSessionCwd,
      depth: 1,
      visited: new Set([parent.realPath, targetRealPath]),
      includeFiles: true,
      ignoreGeneratedDirectories: true,
    }),
  };
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
  caps: { maxCandidateEntries: number; maxVisitedEntries: number },
): Promise<PathSearchEntry[]> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return readTopLevelPathEntries(basePath, realBasePath, limit);
  }

  const candidates: Array<{ entry: PathSearchEntry; score: number }> = [];
  await walkSearchBase(
    basePath,
    realBasePath,
    caps.maxVisitedEntries,
    async (entry) => {
      const score = pathMatchScore(entry, query);
      if (score !== undefined) {
        candidates.push({ entry, score });
        if (candidates.length >= caps.maxCandidateEntries) {
          return "stop";
        }
      }
      return undefined;
    },
  );

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
  maxVisitedEntries: number,
  visit: (
    entry: PathSearchEntry,
  ) => "stop" | undefined | Promise<"stop" | undefined>,
): Promise<void> {
  const visited = new Set<string>([realBasePath]);
  let visitedEntries = 0;
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
      if (visitedEntries >= maxVisitedEntries) {
        return;
      }
      visitedEntries += 1;
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
      if ((await visit(child)) === "stop") {
        return;
      }
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

interface BuildNodeOptions {
  sessionCwd: string;
  realSessionCwd: string;
  depth: number;
  visited: Set<string>;
  includeFiles: boolean;
  ignoreGeneratedDirectories: boolean;
}

async function buildNode(
  path: string,
  options: BuildNodeOptions,
): Promise<FileNode> {
  const pathStat = await stat(path);
  const nodePath = toNodePath(options.sessionCwd, path);

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
  if (options.depth <= 0) {
    return node;
  }

  const entries = await readdir(path, { withFileTypes: true });
  const children: FileNode[] = [];
  for (const entry of entries.sort(compareDirents)) {
    const entryMayBeDirectory = entry.isDirectory() || entry.isSymbolicLink();
    if (!options.includeFiles && !entryMayBeDirectory) {
      continue;
    }
    if (
      options.ignoreGeneratedDirectories &&
      entryMayBeDirectory &&
      IGNORED_DIRECTORY_NAMES.has(entry.name)
    ) {
      continue;
    }

    const childPath = resolve(path, entry.name);
    try {
      const childRealPath = await realpath(childPath);
      if (!isInside(options.realSessionCwd, childRealPath)) {
        continue;
      }
      if (options.visited.has(childRealPath)) {
        continue;
      }
      options.visited.add(childRealPath);
      let child: FileNode;
      try {
        child = await buildNode(childPath, {
          ...options,
          depth: options.depth - 1,
        });
      } finally {
        options.visited.delete(childRealPath);
      }
      if (!options.includeFiles && child.type !== "directory") {
        continue;
      }
      children.push(child);
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

function clampSearchCandidateEntries(
  maxCandidateEntries: number | undefined,
  limit: number,
): number {
  return Math.max(
    limit,
    Math.min(
      maxCandidateEntries ?? DEFAULT_PATH_SEARCH_MAX_CANDIDATES,
      DEFAULT_PATH_SEARCH_MAX_CANDIDATES,
    ),
  );
}

function clampSearchVisitedEntries(
  maxVisitedEntries: number | undefined,
  limit: number,
): number {
  return Math.max(
    limit,
    Math.min(
      maxVisitedEntries ?? DEFAULT_PATH_SEARCH_MAX_VISITED_ENTRIES,
      DEFAULT_PATH_SEARCH_MAX_VISITED_ENTRIES,
    ),
  );
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

function decodeLikelyTextBuffer(
  buffer: Buffer,
  options: { allowTrailingPartialUtf8: boolean },
): string | undefined {
  if (buffer.includes(0)) {
    return undefined;
  }
  const decoded = decodeUtf8Sample(buffer, options.allowTrailingPartialUtf8);
  if (decoded === undefined) {
    return undefined;
  }
  if (
    /[\u0001-\u0008\u000b\u000e-\u001f]/.test(stripAnsiEscapeSequences(decoded))
  ) {
    return undefined;
  }
  return decoded;
}

function decodeUtf8Sample(
  buffer: Buffer,
  allowTrailingPartialUtf8: boolean,
): string | undefined {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return decoder.decode(buffer);
  } catch {
    // Continue below only when the read sample may have been cut mid-sequence.
  }
  if (!allowTrailingPartialUtf8) {
    return undefined;
  }

  const trim = incompleteUtf8SuffixLength(buffer);
  if (trim === 0) {
    return undefined;
  }
  try {
    return decoder.decode(buffer.subarray(0, buffer.length - trim));
  } catch {
    return undefined;
  }
}

function incompleteUtf8SuffixLength(buffer: Buffer): number {
  const maxLength = Math.min(3, buffer.length);
  for (let length = 1; length <= maxLength; length += 1) {
    const start = buffer.length - length;
    const first = buffer[start];
    if (first === undefined || isUtf8ContinuationByte(first)) {
      continue;
    }
    const expectedLength = utf8SequenceLength(first);
    if (
      expectedLength !== undefined &&
      expectedLength > length &&
      hasOnlyContinuationBytes(buffer, start + 1)
    ) {
      return length;
    }
    return 0;
  }
  return 0;
}

function hasOnlyContinuationBytes(buffer: Buffer, start: number): boolean {
  for (let index = start; index < buffer.length; index += 1) {
    if (!isUtf8ContinuationByte(buffer[index] ?? 0)) {
      return false;
    }
  }
  return true;
}

function isUtf8ContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function utf8SequenceLength(byte: number): number | undefined {
  if (byte >= 0xc2 && byte <= 0xdf) {
    return 2;
  }
  if (byte >= 0xe0 && byte <= 0xef) {
    return 3;
  }
  if (byte >= 0xf0 && byte <= 0xf4) {
    return 4;
  }
  return undefined;
}

function stripAnsiEscapeSequences(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
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
