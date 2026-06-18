import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitContextRef } from "@roamcli/shared/protocol";
import { describe, expect, it } from "vitest";
import {
  discardGitPaths,
  readGitFileDiff,
  readGitStatus,
  stageGitPaths,
} from "../workspace/git.js";

const execFileAsync = promisify(execFile);
const context: GitContextRef = { kind: "project", projectId: "project-1" };

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
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}
