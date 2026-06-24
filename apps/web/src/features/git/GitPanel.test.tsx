// @vitest-environment jsdom
import "../../test/setup.js";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ApiGitContext,
  GitJob,
  GitStatusResult,
  Project,
  Session,
} from "@roamcli/shared/protocol";
import { GitPanel } from "./GitPanel";

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: () => <div data-testid="diff-editor" />,
}));

const project = {
  id: "project-1",
  name: "Real Project",
  runnerId: "real-runner",
  directory: "/workspace",
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
  lastActiveAt: "2026-06-05T00:00:00.000Z",
} satisfies Project;

const managedSession = {
  id: "session-1",
  title: "Restored worktree",
  projectId: "project-1",
  runnerId: "real-runner",
  agent: "codex",
  status: "completed",
  executionMode: "managed_worktree",
  executionFolder: "/workspace/.roam-runner/worktrees/project-1/session-1",
  cwd: "/workspace/.roam-runner/worktrees/project-1/session-1",
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:10:00.000Z",
} satisfies Session;

function statusFor(context: ApiGitContext): GitStatusResult {
  return {
    kind: "repository",
    requestId: "git-status-1",
    context,
    branch: "main",
    detached: false,
    headSha: "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    clean: true,
    unborn: false,
    groups: [
      { id: "staged", changes: [] },
      { id: "unstaged", changes: [] },
    ],
  };
}

function job(operation = "stage"): GitJob {
  return {
    id: `job-${operation}`,
    projectId: "project-1",
    contextKind: "project",
    operation,
    status: "succeeded",
    createdAt: "2026-06-05T00:00:00.000Z",
    startedAt: "2026-06-05T00:00:00.000Z",
    finishedAt: "2026-06-05T00:00:00.000Z",
  };
}

describe("GitPanel", () => {
  it("keeps a restored worktree context available despite old cleanup jobs", async () => {
    const onFetchStatus = vi.fn(async (context: ApiGitContext) =>
      statusFor(context),
    );
    const oldRemovalJob: GitJob = {
      id: "old-remove-worktree",
      projectId: "project-1",
      sessionId: "session-1",
      contextKind: "session_worktree",
      operation: "remove_worktree",
      status: "succeeded",
      createdAt: "2026-06-05T00:00:00.000Z",
      startedAt: "2026-06-05T00:00:00.000Z",
      finishedAt: "2026-06-05T00:00:01.000Z",
    };

    render(
      <GitPanel
        active={true}
        project={project}
        runnerOnline={true}
        sessions={[managedSession]}
        archivingSessionIds={{}}
        defaultContext={{ kind: "project", projectId: "project-1" }}
        onFetchStatus={onFetchStatus}
        onFetchDiff={vi.fn()}
        onFetchHistory={vi.fn()}
        onFetchCommitFiles={vi.fn()}
        onFetchBranches={vi.fn(async (context: ApiGitContext) => ({
          requestId: "git-branches-1",
          context,
          branches: [{ name: "main", current: true, remote: false }],
        }))}
        gitJobs={[oldRemovalJob]}
        onFetchJobs={vi.fn(async () => [])}
        onInitRepository={vi.fn(async () => job("init"))}
        onStagePaths={vi.fn(async () => job("stage"))}
        onUnstagePaths={vi.fn(async () => job("unstage"))}
        onDiscardPaths={vi.fn(async () => job("discard"))}
        onCommit={vi.fn(async () => job("commit"))}
        onRemoteOperation={vi.fn(async () => job("remote"))}
        onRemoveWorktree={vi.fn(async () => job("remove_worktree"))}
        canOpenFileForEdit={false}
        onOpenFileForEdit={vi.fn()}
        onNotify={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(onFetchStatus).toHaveBeenCalledWith({
        kind: "project",
        projectId: "project-1",
      }),
    );

    const contextSelect = screen.getByLabelText("Git context");
    fireEvent.change(contextSelect, { target: { value: "session:session-1" } });

    await waitFor(() =>
      expect(onFetchStatus).toHaveBeenCalledWith({
        kind: "session_worktree",
        sessionId: "session-1",
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(contextSelect).toHaveValue("session:session-1");
    expect(onFetchStatus).toHaveBeenLastCalledWith({
      kind: "session_worktree",
      sessionId: "session-1",
    });
  });
});
