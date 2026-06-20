// @vitest-environment jsdom
import "../../test/setup.js";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  type RunnerRegistration,
} from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { ProjectForm } from "./RunnerSidebar";

describe("ProjectForm", () => {
  it("opens a directory picker and resets the selected directory when runner changes", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onFetchRunnerDirectoryTree = vi.fn(
      async (_runnerId: string, options?: { path?: string }) =>
        options?.path === "."
          ? [{ path: "mobile", name: "mobile", type: "directory" as const }]
          : [],
    );
    const onCreateRunnerDirectory = vi.fn();
    render(
      <ProjectForm
        runners={runners}
        onCreate={onCreate}
        onFetchRunnerDirectoryTree={onFetchRunnerDirectoryTree}
        onCreateRunnerDirectory={onCreateRunnerDirectory}
      />,
    );

    expect(screen.getByLabelText("Directory")).toHaveTextContent("/workspace");

    fireEvent.click(screen.getByLabelText("Directory"));
    const picker = await screen.findByRole("dialog", {
      name: "Choose directory",
    });
    expect(onFetchRunnerDirectoryTree).toHaveBeenCalledWith("runner-1", {
      path: ".",
      depth: 1,
    });
    fireEvent.click(await screen.findByRole("treeitem", { name: /mobile/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "Choose" }));
    expect(screen.getByLabelText("Directory")).toHaveTextContent(
      "/workspace/mobile",
    );

    fireEvent.change(screen.getByLabelText("Runner"), {
      target: { value: "runner-2" },
    });

    expect(screen.getByLabelText("Directory")).toHaveTextContent("/backup");

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        name: "backup",
        runnerId: "runner-2",
        directory: "/backup",
      });
    });
  });

  it("submits new folders from the directory picker without creating a project", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onFetchRunnerDirectoryTree = vi.fn(async () => []);
    const onCreateRunnerDirectory = vi.fn(
      async (
        _runnerId: string,
        input: { parentPath: string; name: string },
      ) => ({
        requestId: "directory-create-1",
        path:
          input.parentPath === "."
            ? input.name
            : `${input.parentPath}/${input.name}`,
        node: {
          path:
            input.parentPath === "."
              ? input.name
              : `${input.parentPath}/${input.name}`,
          name: input.name,
          type: "directory" as const,
          children: [],
        },
      }),
    );
    render(
      <ProjectForm
        runners={runners}
        onCreate={onCreate}
        onFetchRunnerDirectoryTree={onFetchRunnerDirectoryTree}
        onCreateRunnerDirectory={onCreateRunnerDirectory}
      />,
    );

    fireEvent.click(screen.getByLabelText("Directory"));
    const picker = await screen.findByRole("dialog", {
      name: "Choose directory",
    });
    const folderInput = within(picker).getByLabelText("New folder name");
    fireEvent.change(folderInput, { target: { value: "web" } });
    fireEvent.submit(folderInput.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(onCreateRunnerDirectory).toHaveBeenCalledWith("runner-1", {
        parentPath: ".",
        name: "web",
      });
    });
    expect(onCreate).not.toHaveBeenCalled();
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
