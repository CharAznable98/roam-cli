import {
  type ExecutionMode,
  nowIso,
  type ApiCreateSession,
  type ClientCommand,
  type Message,
  type RunnerRegistration,
  type Session,
} from "@roamcli/shared/protocol";
import { newId } from "../../infra/ids.js";

export type SessionCreateInput =
  | (ApiCreateSession & {
      runnerId: string;
      executionFolder: string;
      projectDirectory?: string;
      managedWorktreeBaseDirectory?: string;
      managedWorktreeDataDirectory?: string;
    })
  | (Extract<ClientCommand, { type: "createSession" }> & {
      runnerId: string;
      executionFolder: string;
      projectDirectory?: string;
      managedWorktreeBaseDirectory?: string;
      managedWorktreeDataDirectory?: string;
    });

export function createSessionRecord(input: SessionCreateInput): Session {
  const now = nowIso();
  const id = newId("session");
  const executionMode: ExecutionMode = input.executionMode ?? "direct";
  const baseFolder =
    "executionFolder" in input && typeof input.executionFolder === "string"
      ? input.executionFolder
      : "cwd" in input && typeof input.cwd === "string"
        ? input.cwd
        : "";
  const projectDirectory = input.projectDirectory ?? baseFolder;
  const branchName =
    executionMode === "managed_worktree"
      ? (input.gitBranchName ?? defaultWorktreeBranchName(input.prompt, id))
      : undefined;
  const baseRef =
    executionMode === "managed_worktree"
      ? (input.gitBaseRef ?? "HEAD")
      : undefined;
  const executionFolder =
    executionMode === "managed_worktree"
      ? managedWorktreeDirectory(
          input.managedWorktreeBaseDirectory ?? projectDirectory,
          input.managedWorktreeDataDirectory ?? ".roam-runner",
          input.projectId,
          id,
        )
      : baseFolder;
  return {
    id,
    title:
      "title" in input && input.title ? input.title : input.prompt.slice(0, 80),
    projectId: input.projectId,
    runnerId: input.runnerId,
    agent: input.agent,
    status: "pending",
    executionMode,
    executionFolder,
    cwd:
      executionMode === "managed_worktree" ? projectDirectory : executionFolder,
    ...(branchName === undefined ? {} : { gitBranchName: branchName }),
    ...(baseRef === undefined ? {} : { gitBaseRef: baseRef }),
    createdAt: now,
    updatedAt: now,
  };
}

export function managedWorktreeDirectory(
  runnerWorkspaceRoot: string,
  dataDir: string,
  projectId: string,
  sessionId: string,
): string {
  const trimmedRoot = runnerWorkspaceRoot.replace(/[\\/]+$/, "");
  const trimmedDataDir = dataDir.replace(/^[\\/]+|[\\/]+$/g, "");
  return `${trimmedRoot || runnerWorkspaceRoot}/${trimmedDataDir}/worktrees/${sanitizePathSegment(projectId)}/${sanitizePathSegment(sessionId)}`;
}

export function defaultWorktreeBranchName(
  prompt: string,
  sessionId: string,
  date = new Date(),
): string {
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, "");
  const slug = slugify(prompt).slice(0, 40) || "session";
  const shortId = sessionId.replace(/^session_?/, "").slice(0, 8);
  return `roam/${yyyymmdd}-${slug}-${shortId}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function createUserMessage(sessionId: string, content: string): Message {
  return {
    id: newId("message"),
    sessionId,
    role: "user",
    content,
    encrypted: false,
    createdAt: nowIso(),
  };
}

export function runnerSupportsAgent(
  runner: RunnerRegistration | undefined,
  agent: string,
): boolean {
  return (
    runner?.capabilities.some((capability) => capability.kind === agent) ===
    true
  );
}

export function runnerCanResume(
  runner: RunnerRegistration | undefined,
  agent: string,
): boolean {
  const capability = runner?.capabilities.find((item) => item.kind === agent);
  return capability?.supportsResume === true;
}

export function runnerExplicitlyCannotResume(
  runner: RunnerRegistration | undefined,
  agent: string,
): boolean {
  const capability = runner?.capabilities.find((item) => item.kind === agent);
  return capability?.supportsResume === false;
}
