import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveExistingPath,
  resolvePatchTargetPath,
  resolveWritableExistingFilePath,
  resolveWorkspaceChild
} from "../workspace/scope.js";

describe("workspace scope", () => {
  it("rejects workspace lexical escapes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-scope-workspace-"));

    expect(() => resolveWorkspaceChild(workspace, "../outside")).toThrow("escapes workspace");
  });

  it("rejects session cwd and symlink escapes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-scope-escape-"));
    const sessionCwd = join(workspace, "project");
    const outside = await mkdtemp(join(tmpdir(), "roam-runner-scope-outside-"));
    await mkdir(sessionCwd, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(sessionCwd, "secret-link.txt"));

    await expect(resolveExistingPath({ workspace, sessionCwd: outside }, ".")).rejects.toThrow("escapes workspace");
    await expect(resolveExistingPath({ workspace, sessionCwd }, "secret-link.txt")).rejects.toThrow("escapes session cwd");
  });

  it("preserves existing-file writes and new patch target semantics", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-scope-write-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src"), { recursive: true });
    await writeFile(join(sessionCwd, "src", "main.ts"), "old");

    await expect(resolveWritableExistingFilePath({ workspace, sessionCwd }, "src/new.ts")).rejects.toThrow("Path does not exist");
    await expect(resolvePatchTargetPath({ workspace, sessionCwd }, "src/new.ts")).resolves.toMatchObject({
      nodePath: "src/new.ts"
    });
  });
});
