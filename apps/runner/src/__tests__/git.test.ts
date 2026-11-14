import { symlink } from "./platform.js";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitContextRef } from "@roamcli/shared/protocol";
import { describe, expect, it } from "vitest";
import {
  commitGitChanges,
  discardGitPaths,
  readGitBlame,
  readGitCommitFiles,
  readGitCommitPage,
  readGitFileDiff,
  readGitStatus,
  removeGitWorktree,
  stageGitPaths,
} from "../workspace/git.js";

const execFileAsync = promisify(execFile);
const context: GitContextRef = { kind: "project", projectId: "project-1" };
const GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("runner git workspace operations", () => {
  it("accepts a canonical workspace through a lexical directory alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "roam-runner-git-alias-"));
    const lexicalWorkspace = join(root, "workspace");
    const workspaceAlias = join(root, "workspace-alias");
    await mkdir(lexicalWorkspace);
    await git(lexicalWorkspace, ["init"]);
    await symlink(lexicalWorkspace, workspaceAlias, "dir");

    const status = await readGitStatus({
      workspace: await realpath(lexicalWorkspace),
      cwd: workspaceAlias,
      requestId: "status-alias",
      projectId: "project-1",
      context,
    });

    expect(status.kind).toBe("repository");
  });

  it("rejects revision option injection before git can write output files", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-git-revision-"),
    );
    const proofDirectory = await mkdtemp(
      join(tmpdir(), "roam-runner-git-revision-proof-"),
    );
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "root\n", "utf8");
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "root"]);
    const head = await gitOutput(workspace, ["rev-parse", "HEAD"]);

    await expectRejectedRevisionOutput(
      join(proofDirectory, "history.out"),
      undefined,
      (revision) =>
        readGitCommitPage({
          workspace,
          cwd: ".",
          requestId: "history-injection",
          projectId: "project-1",
          context,
          ref: revision,
          limit: 20,
        }),
    );
    await expectRejectedRevisionOutput(
      join(proofDirectory, "blame.out"),
      undefined,
      (revision) =>
        readGitBlame({
          workspace,
          cwd: ".",
          requestId: "blame-injection",
          projectId: "project-1",
          context,
          path: "README.md",
          ref: revision,
        }),
    );
    await expectRejectedRevisionOutput(
      join(proofDirectory, "commit-files.out"),
      undefined,
      (revision) =>
        readGitCommitFiles({
          workspace,
          cwd: ".",
          requestId: "commit-files-injection",
          projectId: "project-1",
          context,
          sha: revision,
        }),
    );

    const oldDiffProof = join(proofDirectory, "old-diff.out");
    await expectRejectedRevisionOutput(
      oldDiffProof,
      `${oldDiffProof}:README.md`,
      (revision) =>
        readGitFileDiff({
          workspace,
          cwd: ".",
          requestId: "old-diff-injection",
          projectId: "project-1",
          context,
          path: "README.md",
          mode: "commit",
          oldRef: revision,
          newRef: head,
        }),
    );
    const newDiffProof = join(proofDirectory, "new-diff.out");
    await expectRejectedRevisionOutput(
      newDiffProof,
      `${newDiffProof}:README.md`,
      (revision) =>
        readGitFileDiff({
          workspace,
          cwd: ".",
          requestId: "new-diff-injection",
          projectId: "project-1",
          context,
          path: "README.md",
          mode: "commit",
          oldRef: head,
          newRef: revision,
        }),
    );

    for (const revision of [
      "HEAD\0suffix",
      "HEAD\nsuffix",
      "HEAD\u007fsuffix",
    ]) {
      await expect(
        readGitCommitPage({
          workspace,
          cwd: ".",
          requestId: "history-control-character",
          projectId: "project-1",
          context,
          ref: revision,
          limit: 20,
        }),
      ).rejects.toThrow("Invalid git revision");
    }
  });

  it.skipIf(process.platform === "win32")("treats user-supplied mutation paths as literal git paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-git-literal-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "tracked.txt"), "original\n", "utf8");
    await git(workspace, ["add", "tracked.txt"]);
    await git(workspace, ["commit", "-m", "init"]);

    await writeFile(join(workspace, "tracked.txt"), "modified\n", "utf8");
    await writeFile(join(workspace, ":(glob)**"), "target\n", "utf8");
    await writeFile(join(workspace, "keep.txt"), "keep\n", "utf8");

    await expect(
      discardGitPaths({
        workspace,
        cwd: ".",
        requestId: "discard-literal",
        projectId: "project-1",
        context,
        operation: "discard",
        paths: [":(glob)**"],
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(stat(join(workspace, ":(glob)**"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(workspace, "tracked.txt"), "utf8"),
    ).resolves.toBe("modified\n");
    await expect(readFile(join(workspace, "keep.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
  });

  it.skipIf(process.platform === "win32")("preserves leading and trailing spaces when diffing, staging, and discarding paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-git-space-"));
    const spacedPath = " target ";
    const trimmedNeighbor = "target";
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, spacedPath), "spaced-old\n", "utf8");
    await writeFile(join(workspace, trimmedNeighbor), "neighbor-old\n", "utf8");
    await git(workspace, ["add", "--", spacedPath, trimmedNeighbor]);
    await git(workspace, ["commit", "-m", "space paths"]);

    await writeFile(join(workspace, spacedPath), "spaced-new\n", "utf8");
    await writeFile(join(workspace, trimmedNeighbor), "neighbor-new\n", "utf8");
    await expect(
      readGitFileDiff({
        workspace,
        cwd: ".",
        requestId: "space-diff",
        projectId: "project-1",
        context,
        path: spacedPath,
        mode: "working_tree",
      }),
    ).resolves.toMatchObject({
      path: spacedPath,
      oldContent: "spaced-old\n",
      newContent: "spaced-new\n",
    });

    await expect(
      stageGitPaths({
        workspace,
        cwd: ".",
        requestId: "space-stage",
        projectId: "project-1",
        context,
        operation: "stage",
        paths: [spacedPath],
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      readGitFileDiff({
        workspace,
        cwd: ".",
        requestId: "space-staged-diff",
        projectId: "project-1",
        context,
        path: spacedPath,
        mode: "staged",
      }),
    ).resolves.toMatchObject({ newContent: "spaced-new\n" });
    await expect(
      readGitFileDiff({
        workspace,
        cwd: ".",
        requestId: "neighbor-staged-diff",
        projectId: "project-1",
        context,
        path: trimmedNeighbor,
        mode: "staged",
      }),
    ).resolves.toMatchObject({
      oldContent: "neighbor-old\n",
      newContent: "neighbor-old\n",
    });

    await writeFile(join(workspace, spacedPath), "discard-this\n", "utf8");
    await expect(
      discardGitPaths({
        workspace,
        cwd: ".",
        requestId: "space-discard",
        projectId: "project-1",
        context,
        operation: "discard",
        paths: [spacedPath],
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(readFile(join(workspace, spacedPath), "utf8")).resolves.toBe(
      "spaced-new\n",
    );
    await expect(
      readFile(join(workspace, trimmedNeighbor), "utf8"),
    ).resolves.toBe("neighbor-new\n");
  });

  it("rejects working-tree diff symlinks that escape the repository", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-git-link-"));
    const outside = await mkdtemp(join(tmpdir(), "roam-runner-git-outside-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "root\n", "utf8");
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "init"]);
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(join(outside, "secret.txt"), join(workspace, "secret.txt"));

    await expect(
      readGitFileDiff({
        workspace,
        cwd: ".",
        requestId: "diff-link",
        projectId: "project-1",
        context,
        path: "secret.txt",
        mode: "working_tree",
      }),
    ).rejects.toThrow("escapes git cwd");
  });

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
      status.groups.find((group) => group.id === "unstaged")?.changes,
    ).toContainEqual({
      path: "README.md",
      status: "modified",
      staged: false,
    });
    expect(
      status.groups.find((group) => group.id === "unstaged")?.changes,
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

  it("prunes stale worktree metadata when the worktree path is already missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-prune-wt-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "root\n", "utf8");
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "root"]);
    const worktreeRelativePath = ".roam-runner/worktrees/project-1/session-1";
    const worktree = join(workspace, worktreeRelativePath);
    await git(workspace, ["worktree", "add", "-b", "session-1", worktree]);
    await rm(worktree, { recursive: true, force: true });

    await expect(
      removeGitWorktree({
        workspace,
        cwd: worktreeRelativePath,
        requestId: "remove-prunable-worktree",
        projectId: "project-1",
        context: { kind: "session_worktree", sessionId: "session-1" },
        operation: "remove_worktree",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    await expect(
      gitOutput(workspace, ["worktree", "list", "--porcelain"]),
    ).resolves.not.toContain(worktree);
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

  it("returns lightweight history and loads commit files on demand", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-history-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "root\n", "utf8");
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "root"]);
    const root = await gitOutput(workspace, ["rev-parse", "HEAD"]);
    await writeFile(join(workspace, "README.md"), "next\n", "utf8");
    await writeFile(
      join(workspace, "src.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    await git(workspace, ["add", "README.md", "src.ts"]);
    await git(workspace, ["commit", "-m", "next"]);
    const head = await gitOutput(workspace, ["rev-parse", "HEAD"]);

    const history = await readGitCommitPage({
      workspace,
      cwd: ".",
      requestId: "history-1",
      projectId: "project-1",
      context,
      ref: "HEAD",
      limit: 20,
    });

    expect(history.commits[0]).toMatchObject({
      sha: head,
      parents: [root],
      summary: "next",
    });
    expect(history.commits[0]?.authoredAt).toMatch(/Z$/);
    expect(history.commits[0]?.committedAt).toMatch(/Z$/);
    expect(history.commits[0]?.files).toBeUndefined();

    await expect(
      readGitCommitFiles({
        workspace,
        cwd: ".",
        requestId: "commit-files-1",
        projectId: "project-1",
        context,
        sha: head,
      }),
    ).resolves.toMatchObject({
      sha: head,
      files: expect.arrayContaining([
        { path: "README.md", status: "modified", staged: false },
        { path: "src.ts", status: "added", staged: false },
      ]),
    });

    await expect(
      readGitBlame({
        workspace,
        cwd: ".",
        requestId: "blame-1",
        projectId: "project-1",
        context,
        path: "README.md",
        ref: "HEAD",
      }),
    ).resolves.toMatchObject({
      path: "README.md",
      ref: "HEAD",
      ranges: [{ startLine: 1, endLine: 1, commitSha: head }],
    });
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

  it("preserves whitespace and control characters in renamed commit paths", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-rename-paths-"),
    );
    const oldPath = process.platform === "win32" ? "old name.txt" : " old\tname\n.txt ";
    const newPath = process.platform === "win32" ? "new name.ts" : " new\tname\n.ts ";
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, oldPath), "unchanged\n", "utf8");
    await git(workspace, ["add", "--", oldPath]);
    await git(workspace, ["commit", "-m", "initial"]);
    await git(workspace, ["mv", "--", oldPath, newPath]);
    await git(workspace, ["commit", "-m", "rename unusual path"]);
    const head = await gitOutput(workspace, ["rev-parse", "HEAD"]);

    await expect(
      readGitCommitFiles({
        workspace,
        cwd: ".",
        requestId: "commit-files-unusual-rename",
        projectId: "project-1",
        context,
        sha: head,
      }),
    ).resolves.toMatchObject({
      sha: head,
      files: [{ path: newPath, oldPath, status: "renamed", staged: false }],
    });
  });

  it("truncates oversized committed file diffs without failing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-large-diff-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(
      join(workspace, "large.txt"),
      "a".repeat(1024 * 1024 + 4096),
      "utf8",
    );
    await git(workspace, ["add", "large.txt"]);
    await git(workspace, ["commit", "-m", "large"]);
    const head = await gitOutput(workspace, ["rev-parse", "HEAD"]);

    const diff = await readGitFileDiff({
      workspace,
      cwd: ".",
      requestId: "large-diff",
      projectId: "project-1",
      context,
      path: "large.txt",
      mode: "commit",
      oldRef: GIT_EMPTY_TREE_SHA,
      newRef: head,
    });

    expect(diff.tooLarge).toBe(true);
    expect(diff.binary).toBe(false);
    expect(diff.oldContent).toBe("");
    expect(diff.newContent).toHaveLength(1024 * 1024);
  });

  it("bounds oversized working-tree file diff reads", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-large-worktree-diff-"),
    );
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "large.txt"), "small\n", "utf8");
    await git(workspace, ["add", "large.txt"]);
    await git(workspace, ["commit", "-m", "small"]);
    await writeFile(
      join(workspace, "large.txt"),
      "b".repeat(1024 * 1024 + 4096),
      "utf8",
    );

    const diff = await readGitFileDiff({
      workspace,
      cwd: ".",
      requestId: "large-worktree-diff",
      projectId: "project-1",
      context,
      path: "large.txt",
      mode: "working_tree",
    });

    expect(diff.tooLarge).toBe(true);
    expect(diff.binary).toBe(false);
    expect(diff.newContent).toHaveLength(1024 * 1024);
  });

  it("serializes concurrent git reads and mutating jobs for one worktree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-git-queue-"));
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "old\n", "utf8");
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "init"]);

    await writeFile(join(workspace, "README.md"), "queued\n", "utf8");
    await expect(
      stageGitPaths({
        workspace,
        cwd: ".",
        requestId: "queue-stage",
        projectId: "project-1",
        context,
        operation: "stage",
        paths: ["README.md"],
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    const [commit, concurrentStatus, concurrentHistory] = await Promise.all([
      commitGitChanges({
        workspace,
        cwd: ".",
        requestId: "queue-commit",
        projectId: "project-1",
        context,
        operation: "commit",
        message: "queued commit",
      }),
      readGitStatus({
        workspace,
        cwd: ".",
        requestId: "queue-status",
        projectId: "project-1",
        context,
      }),
      readGitCommitPage({
        workspace,
        cwd: ".",
        requestId: "queue-history",
        projectId: "project-1",
        context,
        limit: 10,
      }),
    ]);

    expect(commit).toMatchObject({ status: "succeeded" });
    expect(concurrentStatus.kind).toBe("repository");
    expect(concurrentHistory.requestId).toBe("queue-history");
    const finalStatus = await readGitStatus({
      workspace,
      cwd: ".",
      requestId: "queue-final-status",
      projectId: "project-1",
      context,
    });
    expect(finalStatus).toMatchObject({
      kind: "repository",
      clean: true,
    });
    const finalHistory = await readGitCommitPage({
      workspace,
      cwd: ".",
      requestId: "queue-final-history",
      projectId: "project-1",
      context,
      limit: 10,
    });
    expect(finalHistory.commits[0]?.summary).toBe("queued commit");
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "core.autocrlf=false", "-C", cwd, ...args]);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return String(stdout).trim();
}

async function expectRejectedRevisionOutput(
  injectedOutputPath: string,
  observedOutputPath: string | undefined,
  run: (revision: string) => Promise<unknown>,
): Promise<void> {
  const target = observedOutputPath ?? injectedOutputPath;
  await expect(run(`--output=${injectedOutputPath}`)).rejects.toThrow(
    "Invalid git revision",
  );
  await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });

  await writeFile(target, "sentinel\n", "utf8");
  await expect(run(`--output=${injectedOutputPath}`)).rejects.toThrow(
    "Invalid git revision",
  );
  await expect(readFile(target, "utf8")).resolves.toBe("sentinel\n");
}
