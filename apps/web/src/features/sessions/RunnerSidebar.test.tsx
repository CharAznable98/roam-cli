// @vitest-environment jsdom
import "../../test/setup.js";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  type FileNode,
  type Project,
  type RunnerRegistration,
  type Session,
} from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { ProjectForm, RunnerSidebar } from "./RunnerSidebar";

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

  it("ignores stale directory picker loads after a forced reload", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const rootLoads: Array<Deferred<FileNode[]>> = [];
    const onFetchRunnerDirectoryTree = vi.fn(
      (_runnerId: string, options?: { path?: string }) => {
        if (options?.path !== ".") {
          return Promise.resolve([]);
        }
        const load = deferred<FileNode[]>();
        rootLoads.push(load);
        return load.promise;
      },
    );
    const onCreateRunnerDirectory = vi.fn(
      async (
        _runnerId: string,
        input: { parentPath: string; name: string },
      ) => ({
        requestId: "directory-create-mobile",
        path: input.name,
        node: directoryNode(input.name, input.name, []),
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
    await waitFor(() => expect(rootLoads).toHaveLength(1));

    const folderInput = within(picker).getByLabelText("New folder name");
    fireEvent.change(folderInput, { target: { value: "mobile" } });
    fireEvent.submit(folderInput.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(onCreateRunnerDirectory).toHaveBeenCalledWith("runner-1", {
        parentPath: ".",
        name: "mobile",
      });
    });
    await waitFor(() => expect(rootLoads).toHaveLength(2));
    const staleRootLoad = rootLoads[0]!;
    const reloadedRootLoad = rootLoads[1]!;

    await act(async () => {
      reloadedRootLoad.resolve([directoryNode("mobile", "mobile")]);
      await reloadedRootLoad.promise;
    });
    expect(
      await within(picker).findByRole("treeitem", { name: /mobile/ }),
    ).toBeInTheDocument();

    await act(async () => {
      staleRootLoad.resolve([]);
      await staleRootLoad.promise;
    });
    expect(
      within(picker).getByRole("treeitem", { name: /mobile/ }),
    ).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("reloads unloaded selected directories after creating a child folder", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    let mobileCreated = false;
    const onFetchRunnerDirectoryTree = vi.fn(
      async (_runnerId: string, options?: { path?: string }) => {
        if (options?.path === "mobile") {
          return [
            directoryNode("mobile/existing", "existing"),
            directoryNode("mobile/new", "new"),
          ];
        }
        if (options?.path === ".") {
          return mobileCreated ? [directoryNode("mobile", "mobile")] : [];
        }
        return [];
      },
    );
    const onCreateRunnerDirectory = vi.fn(
      async (
        _runnerId: string,
        input: { parentPath: string; name: string },
      ) => {
        const path =
          input.parentPath === "."
            ? input.name
            : `${input.parentPath}/${input.name}`;
        if (path === "mobile") {
          mobileCreated = true;
        }
        return {
          requestId: `directory-create-${path}`,
          path,
          node: directoryNode(path, input.name, []),
        };
      },
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
    let picker = await screen.findByRole("dialog", {
      name: "Choose directory",
    });
    await waitFor(() => {
      expect(onFetchRunnerDirectoryTree).toHaveBeenCalledWith("runner-1", {
        path: ".",
        depth: 1,
      });
    });
    let folderInput = within(picker).getByLabelText("New folder name");
    fireEvent.change(folderInput, { target: { value: "mobile" } });
    fireEvent.submit(folderInput.closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(onCreateRunnerDirectory).toHaveBeenLastCalledWith("runner-1", {
        parentPath: ".",
        name: "mobile",
      });
    });
    fireEvent.click(within(picker).getByRole("button", { name: "Choose" }));
    expect(screen.getByLabelText("Directory")).toHaveTextContent(
      "/workspace/mobile",
    );

    fireEvent.click(screen.getByLabelText("Directory"));
    picker = await screen.findByRole("dialog", {
      name: "Choose directory",
    });
    const mobileRow = await within(picker).findByRole("treeitem", {
      name: /mobile/,
    });
    expect(onFetchRunnerDirectoryTree).not.toHaveBeenCalledWith("runner-1", {
      path: "mobile",
      depth: 1,
    });

    folderInput = within(picker).getByLabelText("New folder name");
    fireEvent.change(folderInput, { target: { value: "new" } });
    fireEvent.submit(folderInput.closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(onCreateRunnerDirectory).toHaveBeenLastCalledWith("runner-1", {
        parentPath: "mobile",
        name: "new",
      });
    });
    await waitFor(() => {
      expect(onFetchRunnerDirectoryTree).toHaveBeenCalledWith("runner-1", {
        path: "mobile",
        depth: 1,
      });
    });

    fireEvent.click(mobileRow);
    expect(
      await within(picker).findByRole("treeitem", { name: /existing/ }),
    ).toBeInTheDocument();
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
        onFetchRunnerDirectoryTree={vi.fn(async () => [])}
        onCreateRunnerDirectory={vi.fn(async () => ({
          requestId: "directory-create-test",
          path: "test",
          node: directoryNode("test", "test"),
        }))}
        onArchiveProject={vi.fn()}
        onCreateSession={vi.fn()}
        onListAgentSkills={vi.fn(async () => ({
          requestId: "agent-skills-test",
          agent: "codex",
          basePath: "/workspace/project-1",
          queriedAt: "2026-06-05T00:00:00.000Z",
          skills: [],
        }))}
        onSearchWorkspacePaths={vi.fn(async () => ({
          requestId: "path-search-test",
          basePath: "/workspace/project-1",
          query: "",
          entries: [],
        }))}
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

function directoryNode(
  path: string,
  name: string,
  children?: FileNode[],
): FileNode {
  return {
    path,
    name,
    type: "directory",
    ...(children === undefined ? {} : { children }),
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
