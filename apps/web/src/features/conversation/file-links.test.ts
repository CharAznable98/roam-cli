import { describe, expect, it } from "vitest";
import { resolveMarkdownFileLink } from "./file-links";

const context = {
  cwd: "/workspace",
  executionFolder: "/workspace",
};

describe("resolveMarkdownFileLink", () => {
  it("maps absolute runner paths under the session root to file panel paths", () => {
    expect(
      resolveMarkdownFileLink("/workspace/src/App.tsx:12", context),
    ).toEqual({
      path: "src/App.tsx",
      line: 12,
    });
  });

  it("accepts file URLs and line fragments", () => {
    expect(
      resolveMarkdownFileLink(
        "file:///workspace/src/Space%20Name.tsx#L9",
        context,
      ),
    ).toEqual({
      path: "src/Space Name.tsx",
      line: 9,
    });
  });

  it("maps relative file links while rejecting traversal", () => {
    expect(resolveMarkdownFileLink("src/App.tsx:5", context)).toEqual({
      path: "src/App.tsx",
      line: 5,
    });
    expect(resolveMarkdownFileLink("../outside.ts", context)).toBeUndefined();
  });

  it("does not claim external URLs or paths outside the session root", () => {
    expect(
      resolveMarkdownFileLink("https://example.test/src/App.tsx", context),
    ).toBeUndefined();
    expect(
      resolveMarkdownFileLink("/workspace-other/src/App.tsx", context),
    ).toBeUndefined();
  });

  it("uses executionFolder when it differs from cwd", () => {
    expect(
      resolveMarkdownFileLink("/worktrees/session-1/src/App.tsx:3", {
        cwd: "/workspace",
        executionFolder: "/worktrees/session-1",
      }),
    ).toEqual({
      path: "src/App.tsx",
      line: 3,
    });
  });
});
