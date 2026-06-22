// @vitest-environment jsdom
import "../../test/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  GitBranchList,
  Project,
  RunnerRegistration,
} from "@roamcli/shared/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewSessionForm } from "./NewSessionForm";

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

const project: Project = {
  id: "project-1",
  name: "Project",
  runnerId: "runner-1",
  directory: "/workspace",
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
  lastActiveAt: "2026-06-05T00:00:00.000Z",
};

const runner: RunnerRegistration = {
  runnerId: "runner-1",
  displayName: "Runner",
  hostname: "localhost",
  workspaceRoot: "/workspace",
  profile: "trusted",
  publicKey: "0123456789abcdef",
  version: "1.0.0",
  capabilities: [
    {
      kind: "codex",
      label: "Codex",
      command: "codex",
      args: [],
      parser: "codex-json",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: ["image/png"],
      maxImagesPerTurn: 2,
      maxImageBytes: 1024,
    },
  ],
};

describe("NewSessionForm image attachments", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:new-session-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  });

  it("creates the first session message with selected image uploads", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <NewSessionForm project={project} runner={runner} onCreate={onCreate} />,
    );
    await screen.findByPlaceholderText("Describe the work");

    fireEvent.change(fileInput(container), {
      target: {
        files: [new File(["hello"], "screen.png", { type: "image/png" })],
      },
    });
    await screen.findByLabelText("Attached images");
    fireEvent.change(screen.getByPlaceholderText("Describe the work"), {
      target: { value: "describe this image" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/ }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "describe this image",
        prompt: "describe this image",
        agent: "codex",
        executionMode: "managed_worktree",
        attachments: [
          {
            name: "screen.png",
            mimeType: "image/png",
            size: 5,
            contentBase64: "aGVsbG8=",
          },
        ],
      }),
    );
  });
});

describe("NewSessionForm Git options", () => {
  it("disables managed worktrees for directories that are not git repositories", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <NewSessionForm
        project={project}
        runner={runner}
        onCreate={onCreate}
        onFetchGitStatus={async (context) => ({
          kind: "not_git_repository",
          requestId: "git-status-1",
          context,
          message: "This directory is not a Git repository.",
        })}
      />,
    );

    const execution = await screen.findByLabelText("Execution");
    expect(execution).toHaveValue("direct");
    expect(
      screen.getByRole("option", { name: "New branch worktree" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "This directory is not a Git repository. Local sessions are available.",
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Describe the work"), {
      target: { value: "local only task" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/ }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({
        gitBaseRef: expect.any(String),
      }),
    );
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "direct" }),
    );
  });

  it("disables managed worktrees for repositories without commits", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <NewSessionForm
        project={project}
        runner={runner}
        onCreate={onCreate}
        onFetchGitStatus={async (context) => ({
          kind: "repository",
          requestId: "git-status-1",
          context,
          detached: false,
          ahead: 0,
          behind: 0,
          clean: true,
          unborn: true,
          groups: [],
        })}
      />,
    );

    const execution = await screen.findByLabelText("Execution");
    expect(execution).toHaveValue("direct");
    expect(
      screen.getByRole("option", { name: "New branch worktree" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "This repository has no commits yet. Local sessions are available until the first commit exists.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Base ref")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Describe the work"), {
      target: { value: "local unborn task" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/ }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "direct" }),
    );
    expect(onCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({
        gitBaseRef: expect.any(String),
      }),
    );
  });

  it("defaults base ref to the current branch while branch refs load asynchronously", async () => {
    let resolveBranches!: (value: GitBranchList) => void;
    const branchesPromise = new Promise<GitBranchList>((resolve) => {
      resolveBranches = resolve;
    });

    render(
      <NewSessionForm
        project={project}
        runner={runner}
        onCreate={vi.fn()}
        onFetchGitStatus={async (context) => ({
          kind: "repository",
          requestId: "git-status-1",
          context,
          branch: "main",
          detached: false,
          ahead: 0,
          behind: 0,
          clean: true,
          unborn: false,
          groups: [],
        })}
        onFetchGitBranches={() => branchesPromise}
      />,
    );

    const baseRef = await screen.findByLabelText("Base ref");
    expect(baseRef).toHaveValue("main");
    expect(
      screen.getByRole("option", { name: "Current branch (main)" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Loading branch refs...")).toBeInTheDocument();

    resolveBranches({
      requestId: "git-branches-1",
      context: { kind: "project", projectId: project.id },
          branches: [
            { name: "main", current: true, remote: false },
            { name: "feature/git-ui", current: false, remote: false },
            { name: "origin/main", current: false, remote: true },
            {
              name: "origin/HEAD -> origin/main",
              current: false,
              remote: true,
            },
            { name: "origin/HEAD", current: false, remote: true },
          ],
        });

    expect(
      await screen.findByRole("option", { name: "feature/git-ui (local)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "origin/main (remote)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", {
        name: "origin/HEAD -> origin/main (remote)",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "origin/HEAD (remote)" }),
    ).not.toBeInTheDocument();
    expect(baseRef).toHaveValue("main");
  });
});

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("file input was not rendered");
  }
  return input;
}
