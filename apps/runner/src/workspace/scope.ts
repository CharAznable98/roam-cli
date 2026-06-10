import { realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export interface FileRequestScope {
  workspace: string;
  sessionCwd: string;
}

export interface ResolvedWorkspacePath {
  path: string;
  realPath: string;
}

export function resolveWorkspaceChild(workspace: string, path: string): string {
  const root = resolve(workspace);
  const candidate = resolve(root, path);
  if (!isInside(root, candidate)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return candidate;
}

export function resolveSessionChild(sessionCwd: string, path: string): string {
  const root = resolve(sessionCwd);
  const candidate = resolve(root, path);
  if (!isInside(root, candidate)) {
    throw new Error(`Path escapes session cwd: ${path}`);
  }
  return candidate;
}

export async function resolveExistingPath(scope: FileRequestScope, path: string): Promise<ResolvedWorkspacePath> {
  const workspace = resolve(scope.workspace);
  const sessionCwd = resolve(scope.sessionCwd);
  const candidate = resolveSessionChild(sessionCwd, path);
  if (!isInside(workspace, sessionCwd)) {
    throw new Error(`Session cwd escapes workspace: ${scope.sessionCwd}`);
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

export async function resolveWritableExistingFilePath(scope: FileRequestScope, path: string): Promise<{ path: string }> {
  const target = await resolveWritablePathBase(scope, path);
  try {
    const realCandidate = await realpath(target.path);
    const candidateStat = await stat(target.path);
    if (!candidateStat.isFile()) {
      throw new Error(`Path is not a file: ${path}`);
    }
    if (!isInside(target.realSessionCwd, realCandidate)) {
      throw new Error(`Path escapes session cwd: ${path}`);
    }
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new Error(`Path does not exist: ${path}`);
    }
    throw error;
  }
  return { path: target.path };
}

export async function resolvePatchTargetPath(scope: FileRequestScope, path: string): Promise<{ path: string; nodePath: string }> {
  if (path.trim().length === 0 || path === "." || path.endsWith("/")) {
    throw new Error(`Invalid file path: ${path}`);
  }

  const target = await resolveWritablePathBase(scope, path);
  try {
    const realCandidate = await realpath(target.path);
    if (!isInside(target.realSessionCwd, realCandidate)) {
      throw new Error(`Path escapes session cwd: ${path}`);
    }
    const candidateStat = await stat(realCandidate);
    if (candidateStat.isDirectory()) {
      throw new Error(`Path is a directory: ${path}`);
    }
  } catch (error: unknown) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    const ancestor = await nearestExistingAncestor(target.path, target.sessionCwd);
    const realAncestor = await realpath(ancestor);
    if (!isInside(target.realSessionCwd, realAncestor)) {
      throw new Error(`Path escapes session cwd: ${path}`);
    }
  }

  return {
    path: target.path,
    nodePath: toNodePath(target.sessionCwd, target.path)
  };
}

export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function toNodePath(sessionCwd: string, path: string): string {
  const value = relative(sessionCwd, path);
  return value.length === 0 ? "." : value.split(sep).join("/");
}

async function resolveWritablePathBase(scope: FileRequestScope, path: string): Promise<{
  path: string;
  sessionCwd: string;
  realSessionCwd: string;
}> {
  const workspace = resolve(scope.workspace);
  const sessionCwd = resolve(scope.sessionCwd);
  const candidate = resolveSessionChild(sessionCwd, path);
  if (!isInside(workspace, sessionCwd)) {
    throw new Error(`Session cwd escapes workspace: ${scope.sessionCwd}`);
  }

  const [realWorkspace, realSessionCwd] = await Promise.all([realpath(workspace), realpath(sessionCwd)]);
  if (!isInside(realWorkspace, realSessionCwd)) {
    throw new Error(`Session cwd escapes workspace: ${scope.sessionCwd}`);
  }
  return { path: candidate, sessionCwd, realSessionCwd };
}

async function nearestExistingAncestor(path: string, root: string): Promise<string> {
  let current = dirname(path);
  while (isInside(root, current)) {
    try {
      const currentStat = await stat(current);
      if (!currentStat.isDirectory()) {
        throw new Error(`Path parent is not a directory: ${current}`);
      }
      return current;
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const next = dirname(current);
      if (next === current) {
        break;
      }
      current = next;
    }
  }
  throw new Error(`Path escapes session cwd: ${path}`);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
