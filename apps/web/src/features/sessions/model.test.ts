import type { RunnerRegistration, Session } from "@roamcli/shared/protocol";
import { describe, expect, it } from "vitest";
import {
  getProjectSessions,
  getRunnerSessions,
  getSelectedRunner,
  getSelectedSession,
} from "./model";

const runner: RunnerRegistration = {
  runnerId: "runner-1",
  displayName: "Runner One",
  hostname: "devbox.local",
  workspaceRoot: "/workspace",
  profile: "trusted",
  publicKey: "0123456789abcdef",
  capabilities: [
    {
      kind: "codex",
      label: "Codex",
      command: "codex",
      args: [],
      parser: "codex-json",
      supportsResume: true,
    },
  ],
  version: "1.1.0",
};

const session: Session = {
  id: "session-1",
  title: "Session One",
  projectId: "project-1",
  runnerId: "runner-1",
  agent: "codex",
  status: "running",
  executionMode: "direct",
  executionFolder: "/workspace",
  cwd: "/workspace",
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
};

describe("session model", () => {
  it("selects explicit runner/session and falls back to first available", () => {
    expect(getSelectedRunner([runner], "runner-1")).toBe(runner);
    expect(getSelectedRunner([runner], "")).toBe(runner);

    const visibleSessions = getRunnerSessions([session], "runner-1");
    expect(visibleSessions).toEqual([session]);
    expect(getSelectedSession([session], visibleSessions, "")).toBe(session);
    expect(getProjectSessions([session], "project-1")).toEqual([session]);
  });

  it("keeps selected session fallback inside the visible project scope", () => {
    const otherSession: Session = {
      ...session,
      id: "session-2",
      title: "Session Two",
      projectId: "project-2",
    };
    const visibleSessions = getProjectSessions([session, otherSession], "project-1");

    expect(getSelectedSession([session, otherSession], visibleSessions, "session-2")).toBe(session);
    expect(getSelectedSession([otherSession], [], "session-2")).toBeUndefined();
  });
});
