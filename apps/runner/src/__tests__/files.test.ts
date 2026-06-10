import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { readFileContent, readFileTree, writeFileContent } from "../workspace/files.js";

describe("runner file reads", () => {
  it("returns a bounded file tree and ignores large generated directories", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-files-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src"), { recursive: true });
    await mkdir(join(sessionCwd, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(sessionCwd, "dist"), { recursive: true });
    await mkdir(join(sessionCwd, ".git"), { recursive: true });
    await writeFile(join(sessionCwd, "README.md"), "readme");
    await writeFile(join(sessionCwd, "src", "main.ts"), "export {};");
    await writeFile(join(sessionCwd, "node_modules", "pkg", "index.js"), "hidden");
    await writeFile(join(sessionCwd, "dist", "bundle.js"), "hidden");
    await writeFile(join(sessionCwd, ".git", "config"), "hidden");

    const result = await readFileTree({ workspace, sessionCwd, requestId: "r1", sessionId: "s1", path: ".", depth: 2 });

    expect(result.root.path).toBe(".");
    expect(result.root.children?.map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(result.root.children?.[0]?.children?.map((node) => node.path)).toEqual(["src/main.ts"]);
  });

  it("returns utf8 file content with truncation metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-content-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src"), { recursive: true });
    await writeFile(join(sessionCwd, "src", "main.ts"), "abcdef");

    const result = await readFileContent({ workspace, sessionCwd, requestId: "r1", sessionId: "s1", path: "src/main.ts", maxBytes: 3 });

    expect(result).toEqual({
      requestId: "r1",
      sessionId: "s1",
      path: "src/main.ts",
      content: "abc",
      truncated: true,
      encoding: "utf8"
    });
  });

  it("writes utf8 content to an existing file inside the session cwd", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-write-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src"), { recursive: true });
    await writeFile(join(sessionCwd, "src", "main.ts"), "old");

    const result = await writeFileContent({
      workspace,
      sessionCwd,
      requestId: "w1",
      sessionId: "s1",
      path: "src/main.ts",
      content: "const value = 42;\n"
    });

    expect(result).toEqual({
      requestId: "w1",
      sessionId: "s1",
      path: "src/main.ts",
      bytesWritten: 18,
      encoding: "utf8"
    });
    await expect(readFile(join(sessionCwd, "src", "main.ts"), "utf8")).resolves.toBe("const value = 42;\n");
  });

  it("rejects writing new files and directories", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-write-reject-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src"), { recursive: true });
    await writeFile(join(sessionCwd, "src", "main.ts"), "old");

    await expect(
      writeFileContent({ workspace, sessionCwd, requestId: "w1", sessionId: "s1", path: "src/new.ts", content: "new" })
    ).rejects.toThrow("Path does not exist");
    await expect(
      writeFileContent({ workspace, sessionCwd, requestId: "w2", sessionId: "s1", path: "src", content: "directory" })
    ).rejects.toThrow("Path is not a file");

    await expect(stat(join(sessionCwd, "src", "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects lexical escapes and symlinks that resolve outside the session cwd", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-escape-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(sessionCwd, { recursive: true });
    await writeFile(join(workspace, "outside.txt"), "outside");
    await symlink(join(workspace, "outside.txt"), join(sessionCwd, "outside-link.txt"));

    await expect(readFileContent({ workspace, sessionCwd, requestId: "r1", sessionId: "s1", path: "../outside.txt" })).rejects.toThrow(
      "escapes session cwd"
    );
    await expect(
      readFileContent({ workspace, sessionCwd, requestId: "r1", sessionId: "s1", path: "outside-link.txt" })
    ).rejects.toThrow("escapes session cwd");
  });
});
