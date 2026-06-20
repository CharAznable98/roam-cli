import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import {
  readFileContent,
  readFileTree,
  searchWorkspacePaths,
  writeFileContent,
} from "../workspace/files.js";

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
    await writeFile(
      join(sessionCwd, "node_modules", "pkg", "index.js"),
      "hidden",
    );
    await writeFile(join(sessionCwd, "dist", "bundle.js"), "hidden");
    await writeFile(join(sessionCwd, ".git", "config"), "hidden");

    const result = await readFileTree({
      workspace,
      sessionCwd,
      requestId: "r1",
      sessionId: "s1",
      path: ".",
      depth: 2,
    });

    expect(result.root.path).toBe(".");
    expect(result.root.children?.map((node) => node.name)).toEqual([
      "src",
      "README.md",
    ]);
    expect(
      result.root.children?.[0]?.children?.map((node) => node.path),
    ).toEqual(["src/main.ts"]);
  });

  it("returns utf8 file content with truncation metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-content-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src"), { recursive: true });
    await writeFile(join(sessionCwd, "src", "main.ts"), "abcdef");

    const result = await readFileContent({
      workspace,
      sessionCwd,
      requestId: "r1",
      sessionId: "s1",
      path: "src/main.ts",
      maxBytes: 3,
    });

    expect(result).toEqual({
      requestId: "r1",
      sessionId: "s1",
      path: "src/main.ts",
      content: "abc",
      truncated: true,
      encoding: "utf8",
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
      content: "const value = 42;\n",
    });

    expect(result).toEqual({
      requestId: "w1",
      sessionId: "s1",
      path: "src/main.ts",
      bytesWritten: 18,
      encoding: "utf8",
    });
    await expect(
      readFile(join(sessionCwd, "src", "main.ts"), "utf8"),
    ).resolves.toBe("const value = 42;\n");
  });

  it("rejects writing new files and directories", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-write-reject-"),
    );
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src"), { recursive: true });
    await writeFile(join(sessionCwd, "src", "main.ts"), "old");

    await expect(
      writeFileContent({
        workspace,
        sessionCwd,
        requestId: "w1",
        sessionId: "s1",
        path: "src/new.ts",
        content: "new",
      }),
    ).rejects.toThrow("Path does not exist");
    await expect(
      writeFileContent({
        workspace,
        sessionCwd,
        requestId: "w2",
        sessionId: "s1",
        path: "src",
        content: "directory",
      }),
    ).rejects.toThrow("Path is not a file");

    await expect(stat(join(sessionCwd, "src", "new.ts"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("rejects lexical escapes and symlinks that resolve outside the session cwd", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-escape-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(sessionCwd, { recursive: true });
    await writeFile(join(workspace, "outside.txt"), "outside");
    await symlink(
      join(workspace, "outside.txt"),
      join(sessionCwd, "outside-link.txt"),
    );

    await expect(
      readFileContent({
        workspace,
        sessionCwd,
        requestId: "r1",
        sessionId: "s1",
        path: "../outside.txt",
      }),
    ).rejects.toThrow("escapes session cwd");
    await expect(
      readFileContent({
        workspace,
        sessionCwd,
        requestId: "r1",
        sessionId: "s1",
        path: "outside-link.txt",
      }),
    ).rejects.toThrow("escapes session cwd");
  });

  it("returns top-level path suggestions for an empty query", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-paths-top-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src"), { recursive: true });
    await mkdir(join(sessionCwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(sessionCwd, ".env"), "hidden but selectable");
    await writeFile(join(sessionCwd, "README.md"), "readme");

    const result = await searchWorkspacePaths({
      workspace,
      requestId: "paths-1",
      basePath: sessionCwd,
      query: "",
    });

    expect(result.entries).toEqual([
      { path: "src", name: "src", type: "directory" },
      { path: ".env", name: ".env", type: "file" },
      { path: "README.md", name: "README.md", type: "file" },
    ]);
  });

  it("searches nested paths while ignoring generated directories", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-paths-search-"),
    );
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src", "components"), { recursive: true });
    await mkdir(join(sessionCwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(sessionCwd, "src", "components", "Button.tsx"),
      "export {};",
    );
    await writeFile(join(sessionCwd, "src", "notes with spaces.md"), "notes");
    await writeFile(
      join(sessionCwd, "node_modules", "pkg", "Button.tsx"),
      "ignored",
    );

    const buttonResult = await searchWorkspacePaths({
      workspace,
      requestId: "paths-2",
      basePath: sessionCwd,
      query: "but",
    });
    const notesResult = await searchWorkspacePaths({
      workspace,
      requestId: "paths-3",
      basePath: sessionCwd,
      query: "nws",
    });

    expect(buttonResult.entries.map((entry) => entry.path)).toEqual([
      "src/components/Button.tsx",
    ]);
    expect(notesResult.entries.map((entry) => entry.path)).toEqual([
      "src/notes with spaces.md",
    ]);
  });

  it("stops recursive path search at the traversal cap", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-paths-capped-"),
    );
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "a"), { recursive: true });
    await mkdir(join(sessionCwd, "b"), { recursive: true });
    await mkdir(join(sessionCwd, "z"), { recursive: true });
    await writeFile(join(sessionCwd, "a", "foo-needle.txt"), "early");
    await writeFile(join(sessionCwd, "z", "needle.ts"), "late");

    const result = await searchWorkspacePaths({
      workspace,
      requestId: "paths-cap",
      basePath: sessionCwd,
      query: "needle",
      limit: 1,
      maxVisitedEntries: 4,
    });

    expect(result.entries.map((entry) => entry.path)).toEqual([
      "a/foo-needle.txt",
    ]);
  });

  it("stops recursive path search at the candidate cap", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-paths-candidate-cap-"),
    );
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "a"), { recursive: true });
    await mkdir(join(sessionCwd, "z"), { recursive: true });
    await writeFile(join(sessionCwd, "a", "foo-needle.txt"), "early");
    await writeFile(join(sessionCwd, "z", "needle.ts"), "late");

    const result = await searchWorkspacePaths({
      workspace,
      requestId: "paths-candidate-cap",
      basePath: sessionCwd,
      query: "needle",
      limit: 1,
      maxCandidateEntries: 1,
    });

    expect(result.entries.map((entry) => entry.path)).toEqual([
      "a/foo-needle.txt",
    ]);
  });

  it("returns an empty path list for invalid or escaped base paths", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-paths-invalid-"),
    );
    const outside = await mkdtemp(join(tmpdir(), "roam-runner-paths-outside-"));
    await mkdir(join(workspace, "project"), { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret");

    await expect(
      searchWorkspacePaths({
        workspace,
        requestId: "paths-4",
        basePath: outside,
        query: "",
      }),
    ).resolves.toEqual({
      requestId: "paths-4",
      basePath: outside,
      query: "",
      entries: [],
    });
  });
});
