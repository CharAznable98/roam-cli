// @vitest-environment jsdom
import "../../test/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  type Project,
  type RunnerRegistration,
  type Session,
} from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { ProjectForm, RunnerSidebar } from "./RunnerSidebar";

describe("ProjectForm", () => {
  it("keeps the runner base read-only and resets the suffix when runner changes", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ProjectForm runners={runners} onCreate={onCreate} />);

    expect(screen.getByLabelText("Runner base")).toHaveValue("/workspace");
    expect(screen.getByLabelText("Runner base")).toHaveAttribute("readonly");

    fireEvent.change(screen.getByLabelText("Directory"), {
      target: { value: "mobile" },
    });
    fireEvent.change(screen.getByLabelText("Runner"), {
      target: { value: "runner-2" },
    });

    expect(screen.getByLabelText("Runner base")).toHaveValue("/backup");
    expect(screen.getByLabelText("Directory")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        name: "backup",
        runnerId: "runner-2",
        directory: "/backup",
      });
    });
  });
});

describe("RunnerSidebar", () => {
  it("switches directly to sessions from any active project", () => {
    const onSelectSession = vi.fn();

    render(
      <RunnerSidebar
        projects={[makeProject("project-1"), makeProject("project-2")]}
        runners={runners}
        selectedProjectId="project-1"
        sessions={[
          makeSession("session-1", "project-1", "First session"),
          makeSession("session-2", "project-2", "Second session"),
        ]}
        selectedSessionId="session-1"
        onSelectProject={vi.fn()}
        onSelectSession={onSelectSession}
        onCreateProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onCreateSession={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Session")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand project project-2" }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Second session/ }));

    expect(onSelectSession).toHaveBeenCalledWith("session-2");
  });
});

const runners: RunnerRegistration[] = [
  {
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
        supportsImages: false,
        supportedImageMimeTypes: [],
        maxImagesPerTurn: 0,
        maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      },
    ],
    version: "1.1.0",
  },
  {
    runnerId: "runner-2",
    displayName: "Runner Two",
    hostname: "backup.local",
    workspaceRoot: "/backup",
    profile: "trusted",
    publicKey: "abcdef0123456789",
    capabilities: [
      {
        kind: "codex",
        label: "Codex",
        command: "codex",
        args: [],
        parser: "codex-json",
        supportsResume: true,
        supportsImages: false,
        supportedImageMimeTypes: [],
        maxImagesPerTurn: 0,
        maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      },
    ],
    version: "1.1.0",
  },
];

function makeProject(id: string): Project {
  return {
    id,
    name: id,
    runnerId: "runner-1",
    directory: `/workspace/${id}`,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    lastActiveAt: "2026-06-05T00:00:00.000Z",
  };
}

function makeSession(id: string, projectId: string, title: string): Session {
  return {
    id,
    title,
    projectId,
    runnerId: "runner-1",
    agent: "codex",
    status: "completed",
    executionMode: "direct",
    executionFolder: `/workspace/${projectId}`,
    cwd: `/workspace/${projectId}`,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
}
