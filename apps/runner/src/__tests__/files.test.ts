import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import {
  createDirectory,
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
      clientRequestId: "client-tree-1",
      sessionId: "s1",
      path: ".",
      depth: 2,
    });

    expect(result.clientRequestId).toBe("client-tree-1");
    expect(result.root.path).toBe(".");
    expect(result.root.children?.map((node) => node.name)).toEqual([
      "src",
      "README.md",
    ]);
    expect(
      result.root.children?.[0]?.children?.map((node) => node.path),
    ).toEqual(["src/main.ts"]);
  });

  it("can return a directory-only file tree", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-directory-tree-"),
    );
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src", "components"), { recursive: true });
    await mkdir(join(sessionCwd, "docs"), { recursive: true });
    await mkdir(join(sessionCwd, "dist", "packages"), { recursive: true });
    await mkdir(join(sessionCwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(sessionCwd, "README.md"), "readme");
    await writeFile(join(sessionCwd, "docs", "guide.md"), "guide");
    await writeFile(join(sessionCwd, "dist", "bundle.js"), "bundle");
    await writeFile(join(sessionCwd, "node_modules", "pkg.js"), "pkg");
    await writeFile(join(sessionCwd, "src", "main.ts"), "export {};");
    await writeFile(join(sessionCwd, "src", "components", "App.tsx"), "app");

    const result = await readFileTree({
      workspace,
      sessionCwd,
      requestId: "dirs-1",
      sessionId: "s1",
      path: ".",
      depth: 3,
      includeFiles: false,
    });

    expect(result.root.children?.map((node) => node.name)).toEqual([
      "dist",
      "docs",
      "node_modules",
      "src",
    ]);
    expect(result.root.children?.[0]).toMatchObject({
      path: "dist",
      type: "directory",
      children: [
        {
          path: "dist/packages",
          type: "directory",
          children: [],
        },
      ],
    });
    expect(result.root.children?.[1]).toMatchObject({
      path: "docs",
      type: "directory",
      children: [],
    });
    expect(result.root.children?.[2]).toMatchObject({
      path: "node_modules",
      type: "directory",
      children: [
        {
          path: "node_modules/pkg",
          type: "directory",
          children: [],
        },
      ],
    });
    expect(result.root.children?.[3]).toMatchObject({
      path: "src",
      type: "directory",
      children: [
        {
          path: "src/components",
          type: "directory",
          children: [],
        },
      ],
    });
  });

  it("keeps internal symlinked directories visible during lazy reads", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-symlink-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "src"), { recursive: true });
    await mkdir(join(sessionCwd, "config"), { recursive: true });
    await symlink("../config", join(sessionCwd, "src", "config"));

    const result = await readFileTree({
      workspace,
      sessionCwd,
      requestId: "symlink-1",
      sessionId: "s1",
      path: "src",
      depth: 1,
    });

    expect(result.root).toMatchObject({
      path: "src",
      type: "directory",
      children: [
        {
          path: "src/config",
          name: "config",
          type: "directory",
        },
      ],
    });
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
      kind: "text",
      content: "abc",
      truncated: true,
      encoding: "utf8",
    });
  });

  it("keeps truncated UTF-8 content valid when the read splits a character", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-partial-utf8-"),
    );
    const sessionCwd = join(workspace, "project");
    await mkdir(sessionCwd, { recursive: true });
    await writeFile(join(sessionCwd, "partial.txt"), Buffer.from("a€", "utf8"));

    const result = await readFileContent({
      workspace,
      sessionCwd,
      requestId: "partial-1",
      sessionId: "s1",
      path: "partial.txt",
      maxBytes: 2,
    });

    expect(result).toMatchObject({
      requestId: "partial-1",
      sessionId: "s1",
      path: "partial.txt",
      kind: "text",
      content: "a",
      truncated: true,
      encoding: "utf8",
    });
  });

  it("returns empty non-image files as editable text", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-empty-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(sessionCwd, { recursive: true });
    await writeFile(join(sessionCwd, "README.md"), "");

    const result = await readFileContent({
      workspace,
      sessionCwd,
      requestId: "empty-1",
      sessionId: "s1",
      path: "README.md",
    });

    expect(result).toEqual({
      requestId: "empty-1",
      sessionId: "s1",
      path: "README.md",
      kind: "text",
      content: "",
      truncated: false,
      encoding: "utf8",
    });
  });

  it("allows ANSI-colored logs to remain editable text", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-ansi-log-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(sessionCwd, { recursive: true });
    await writeFile(join(sessionCwd, "log.txt"), "\u001b[31mfailed\u001b[0m\n");

    const result = await readFileContent({
      workspace,
      sessionCwd,
      requestId: "ansi-1",
      sessionId: "s1",
      path: "log.txt",
    });

    expect(result).toMatchObject({
      requestId: "ansi-1",
      sessionId: "s1",
      path: "log.txt",
      kind: "text",
      content: "\u001b[31mfailed\u001b[0m\n",
      truncated: false,
      encoding: "utf8",
    });
  });

  it("returns image content as base64 and marks other binary files as binary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-image-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "assets"), { recursive: true });
    await writeFile(
      join(sessionCwd, "assets", "screen.png"),
      Buffer.from("image-bytes"),
    );
    await writeFile(
      join(sessionCwd, "assets", "data.bin"),
      Buffer.from([0, 1, 2, 3]),
    );
    await writeFile(
      join(sessionCwd, "assets", "invalid-utf8.bin"),
      Buffer.from([0xff, 0xfe, 0xfd, 0xfc]),
    );
    await writeFile(
      join(sessionCwd, "assets", "invalid-tail.bin"),
      Buffer.from([0x61, 0xff]),
    );

    const image = await readFileContent({
      workspace,
      sessionCwd,
      requestId: "image-1",
      sessionId: "s1",
      path: "assets/screen.png",
    });
    expect(image).toMatchObject({
      requestId: "image-1",
      sessionId: "s1",
      path: "assets/screen.png",
      kind: "image",
      contentBase64: Buffer.from("image-bytes").toString("base64"),
      mimeType: "image/png",
      size: 11,
      truncated: false,
      encoding: "base64",
    });

    const binary = await readFileContent({
      workspace,
      sessionCwd,
      requestId: "binary-1",
      sessionId: "s1",
      path: "assets/data.bin",
    });
    expect(binary).toMatchObject({
      requestId: "binary-1",
      sessionId: "s1",
      path: "assets/data.bin",
      kind: "binary",
      mimeType: "application/octet-stream",
      size: 4,
      truncated: false,
      encoding: "binary",
    });

    const invalidUtf8Binary = await readFileContent({
      workspace,
      sessionCwd,
      requestId: "binary-2",
      sessionId: "s1",
      path: "assets/invalid-utf8.bin",
    });
    expect(invalidUtf8Binary).toMatchObject({
      requestId: "binary-2",
      sessionId: "s1",
      path: "assets/invalid-utf8.bin",
      kind: "binary",
      mimeType: "application/octet-stream",
      size: 4,
      truncated: false,
      encoding: "binary",
    });

    const invalidUtf8Tail = await readFileContent({
      workspace,
      sessionCwd,
      requestId: "binary-3",
      sessionId: "s1",
      path: "assets/invalid-tail.bin",
    });
    expect(invalidUtf8Tail).toMatchObject({
      requestId: "binary-3",
      sessionId: "s1",
      path: "assets/invalid-tail.bin",
      kind: "binary",
      mimeType: "application/octet-stream",
      size: 2,
      truncated: false,
      encoding: "binary",
    });
  });

  it("creates a single child directory inside the selected parent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-create-dir-"));
    const sessionCwd = join(workspace, "project");
    await mkdir(join(sessionCwd, "team"), { recursive: true });

    const result = await createDirectory({
      workspace,
      sessionCwd,
      requestId: "mkdir-1",
      parentPath: "team",
      name: "mobile",
    });

    expect(result).toMatchObject({
      requestId: "mkdir-1",
      path: "team/mobile",
      node: {
        path: "team/mobile",
        name: "mobile",
        type: "directory",
        children: [],
      },
    });
    expect((await stat(join(sessionCwd, "team", "mobile"))).isDirectory()).toBe(
      true,
    );

    await expect(
      createDirectory({
        workspace,
        sessionCwd,
        requestId: "mkdir-2",
        parentPath: "team",
        name: "../escape",
      }),
    ).rejects.toThrow("Invalid directory name");
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
