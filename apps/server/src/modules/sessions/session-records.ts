import {
  nowIso,
  type ApiCreateSession,
  type ClientCommand,
  type Message,
  type RunnerRegistration,
  type Session,
} from "@roamcli/protocol";
import { newId } from "../../infra/ids.js";

export type SessionCreateInput =
  | ApiCreateSession
  | Extract<ClientCommand, { type: "createSession" }>;

export function createSessionRecord(input: SessionCreateInput): Session {
  const now = nowIso();
  return {
    id: newId("session"),
    title:
      "title" in input && input.title ? input.title : input.prompt.slice(0, 80),
    runnerId: input.runnerId,
    agent: input.agent,
    status: "pending",
    cwd: input.cwd,
    createdAt: now,
    updatedAt: now,
  };
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
