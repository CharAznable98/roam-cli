import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitContextRef } from "@roamcli/shared/protocol";
import { describe, expect, it } from "vitest";
import {
  discardGitPaths,
  readGitFileDiff,
  readGitStatus,
  removeGitWorktree,
  stageGitPaths,
} from "../workspace/git.js";

const execFileAsync = promisify(execFile);
const context: GitContextRef = { kind: "project", projectId: "project-1" };
const GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("runner git workspace operations", () => {
  it("reads status and diff, stages tracked paths, and discards untracked paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-git-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "old\n", "utf8");
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "init"]);

    await writeFile(join(workspace, "README.md"), "new\n", "utf8");
    await writeFile(join(workspace, "scratch.txt"), "temporary\n", "utf8");

    const status = await readGitStatus({
      workspace,
      cwd: ".",
      requestId: "status-1",
      projectId: "project-1",
      context,
    });
    expect(status.kind).toBe("repository");
    if (status.kind !== "repository") {
      throw new Error("expected repository status");
    }
    expect(status.clean).toBe(false);
    expect(
      status.groups.find((group) => group.id === "changes")?.changes,
    ).toContainEqual({
      path: "README.md",
      status: "modified",
      staged: false,
    });
    expect(
      status.groups.find((group) => group.id === "untracked")?.changes,
    ).toContainEqual({
      path: "scratch.txt",
      status: "untracked",
      staged: false,
    });

    const diff = await readGitFileDiff({
      workspace,
      cwd: ".",
      requestId: "diff-1",
      projectId: "project-1",
      context,
      path: "README.md",
      mode: "working_tree",
    });
    expect(diff.oldContent).toBe("old\n");
    expect(diff.newContent).toBe("new\n");

    await expect(
      stageGitPaths({
        workspace,
        cwd: ".",
        requestId: "stage-1",
        projectId: "project-1",
        context,
        operation: "stage",
        paths: ["README.md"],
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    const staged = await readGitStatus({
      workspace,
      cwd: ".",
      requestId: "status-2",
      projectId: "project-1",
      context,
    });
    expect(staged.kind).toBe("repository");
    if (staged.kind !== "repository") {
      throw new Error("expected repository status");
    }
    expect(
      staged.groups.find((group) => group.id === "staged")?.changes,
    ).toContainEqual({
      path: "README.md",
      status: "modified",
      staged: true,
    });

    await expect(
      discardGitPaths({
        workspace,
        cwd: ".",
        requestId: "discard-1",
        projectId: "project-1",
        context,
        operation: "discard",
        paths: ["scratch.txt"],
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(stat(join(workspace, "scratch.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe(
      "new\n",
    );
  });

  it("returns a friendly status result for directories that are not git repositories", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-non-git-"));

    await expect(
      readGitStatus({
        workspace,
        cwd: ".",
        requestId: "status-non-git",
        projectId: "project-1",
        context,
      }),
    ).resolves.toMatchObject({
      kind: "not_git_repository",
      requestId: "status-non-git",
      context,
      message: "This directory is not a Git repository.",
    });
  });

  it("removes a registered git worktree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-worktree-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "root\n", "utf8");
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "root"]);
    const worktree = join(
      workspace,
      ".roam-runner/worktrees/project-1/session-1",
    );
    await git(workspace, ["worktree", "add", "-b", "session-1", worktree]);

    await expect(
      removeGitWorktree({
        workspace,
        cwd: ".roam-runner/worktrees/project-1/session-1",
        requestId: "remove-worktree",
        projectId: "project-1",
        context: { kind: "session_worktree", sessionId: "session-1" },
        operation: "remove_worktree",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(stat(worktree)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an already-missing worktree path as removed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-missing-wt-"));

    await expect(
      removeGitWorktree({
        workspace,
        cwd: ".roam-runner/worktrees/project-1/session-1",
        requestId: "remove-missing-worktree",
        projectId: "project-1",
        context: { kind: "session_worktree", sessionId: "session-1" },
        operation: "remove_worktree",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("does not remove existing directories that are not git worktrees", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-bad-wt-"));
    const worktree = join(
      workspace,
      ".roam-runner/worktrees/project-1/session-1",
    );
    await mkdir(worktree, { recursive: true });

    await expect(
      removeGitWorktree({
        workspace,
        cwd: ".roam-runner/worktrees/project-1/session-1",
        requestId: "remove-bad-worktree",
        projectId: "project-1",
        context: { kind: "session_worktree", sessionId: "session-1" },
        operation: "remove_worktree",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorSummary: "Directory is not a git repository",
    });
    await expect(stat(worktree)).resolves.toBeDefined();
  });

  it("reads root commit file diffs against the empty tree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-root-diff-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "root\n", "utf8");
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "root"]);
    const head = await gitOutput(workspace, ["rev-parse", "HEAD"]);

    const diff = await readGitFileDiff({
      workspace,
      cwd: ".",
      requestId: "diff-root",
      projectId: "project-1",
      context,
      path: "README.md",
      mode: "commit",
      oldRef: GIT_EMPTY_TREE_SHA,
      newRef: head,
    });

    expect(diff.oldContent).toBe("");
    expect(diff.newContent).toBe("root\n");
  });

  it("uses oldPath for the old side of renamed commit file diffs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-rename-diff-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "old.ts"), "old\n", "utf8");
    await git(workspace, ["add", "old.ts"]);
    await git(workspace, ["commit", "-m", "initial"]);
    const parent = await gitOutput(workspace, ["rev-parse", "HEAD"]);
    await git(workspace, ["mv", "old.ts", "new.ts"]);
    await writeFile(join(workspace, "new.ts"), "new\n", "utf8");
    await git(workspace, ["add", "new.ts"]);
    await git(workspace, ["commit", "-m", "rename"]);
    const head = await gitOutput(workspace, ["rev-parse", "HEAD"]);

    const diff = await readGitFileDiff({
      workspace,
      cwd: ".",
      requestId: "diff-rename",
      projectId: "project-1",
      context,
      path: "new.ts",
      oldPath: "old.ts",
      mode: "commit",
      oldRef: parent,
      newRef: head,
    });

    expect(diff.oldPath).toBe("old.ts");
    expect(diff.oldContent).toBe("old\n");
    expect(diff.newContent).toBe("new\n");
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return String(stdout).trim();
}
