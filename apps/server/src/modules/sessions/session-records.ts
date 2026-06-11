import {
  type ExecutionMode,
  nowIso,
  type ApiCreateSession,
  type ClientCommand,
  type Message,
  type RunnerRegistration,
  type Session,
} from "@roamcli/protocol";
import { newId } from "../../infra/ids.js";

export type SessionCreateInput =
  | (ApiCreateSession & {
      runnerId: string;
      executionFolder: string;
      projectDirectory?: string;
      managedWorktreeBaseDirectory?: string;
    })
  | (Extract<ClientCommand, { type: "createSession" }> & {
      runnerId: string;
      executionFolder: string;
      projectDirectory?: string;
      managedWorktreeBaseDirectory?: string;
    });

export function createSessionRecord(input: SessionCreateInput): Session {
  const now = nowIso();
  const id = newId("session");
  const executionMode: ExecutionMode = input.executionMode ?? "direct";
  const baseFolder = "executionFolder" in input && typeof input.executionFolder === "string"
    ? input.executionFolder
    : "cwd" in input && typeof input.cwd === "string"
      ? input.cwd
      : "";
  const projectDirectory = input.projectDirectory ?? baseFolder;
  const executionFolder = executionMode === "managed_worktree"
    ? managedWorktreeDirectory(input.managedWorktreeBaseDirectory ?? projectDirectory, id)
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
    cwd: executionMode === "managed_worktree" ? projectDirectory : executionFolder,
    createdAt: now,
    updatedAt: now,
  };
}

export function managedWorktreeDirectory(projectDirectory: string, sessionId: string): string {
  const trimmed = projectDirectory.replace(/[\\/]+$/, "");
  return `${trimmed || projectDirectory}/.roamcli-worktrees/${sessionId}`;
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
