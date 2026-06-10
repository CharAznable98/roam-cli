import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyUnifiedDiff, extractUnifiedDiffPaths } from "../workspace/patch.js";

describe("runner patch operations", () => {
  it("applies a unified diff inside the session cwd", async () => {
    const { workspace, sessionCwd } = await makeWorkspace("roam-runner-patch-");
    await writeFile(join(sessionCwd, "README.md"), "old\n");

    const result = await applyUnifiedDiff({
      workspace,
      sessionCwd,
      requestId: "patch1",
      sessionId: "s1",
      patch: [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        ""
      ].join("\n")
    });

    expect(result).toEqual({
      requestId: "patch1",
      sessionId: "s1",
      applied: true,
      changedFiles: ["README.md"],
      message: "applied",
      rejected: []
    });
    await expect(readFile(join(sessionCwd, "README.md"), "utf8")).resolves.toBe("new\n");
  });

  it("returns an error result for paths that escape the session cwd", async () => {
    const { workspace, sessionCwd } = await makeWorkspace("roam-runner-patch-escape-");

    const result = await applyUnifiedDiff({
      workspace,
      sessionCwd,
      requestId: "patch1",
      sessionId: "s1",
      patch: [
        "diff --git a/../outside.txt b/../outside.txt",
        "--- a/../outside.txt",
        "+++ b/../outside.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        ""
      ].join("\n")
    });

    expect(result.applied).toBe(false);
    expect(result.changedFiles).toEqual([]);
    expect(result.message).toContain("escapes session cwd");
    expect(result.rejected[0]).toContain("escapes session cwd");
  });

  it("extracts paths from common unified diff headers", () => {
    const paths = extractUnifiedDiffPaths(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "--- a/src/old.ts",
        "+++ b/src/new.ts"
      ].join("\n")
    );

    expect([...paths].sort()).toEqual(["src/new.ts", "src/old.ts"]);
  });
});

async function makeWorkspace(prefix: string): Promise<{ workspace: string; sessionCwd: string }> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  const sessionCwd = join(workspace, "project");
  await mkdir(sessionCwd, { recursive: true });
  return { workspace, sessionCwd };
}
