// @vitest-environment jsdom
import "../../test/setup.js";
import { render, screen } from "@testing-library/react";
import type { FileNode } from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { FilePanel } from "./FilePanel";

vi.mock("@monaco-editor/react", () => ({
  Editor: () => <div data-testid="file-editor" />,
}));

const cachedFiles: FileNode[] = [
  { path: "README.md", name: "README.md", type: "file", size: 12 },
];

describe("FilePanel", () => {
  it("keeps cached tree content stable while refreshing", () => {
    renderFilePanel("loading", cachedFiles);

    expect(screen.getByText("tree loading")).toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: /README\.md/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading file tree...")).not.toBeInTheDocument();
  });

  it("shows the blocking loader only before the first tree arrives", () => {
    renderFilePanel("loading", []);

    expect(screen.getByText("Loading file tree...")).toBeInTheDocument();
  });

  it("keeps cached tree content visible after a refresh error", () => {
    renderFilePanel("error", cachedFiles);

    expect(screen.getByText("tree error")).toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: /README\.md/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("File tree could not be loaded."),
    ).not.toBeInTheDocument();
  });
});

function renderFilePanel(
  treeState: "loading" | "error",
  files: FileNode[],
): void {
  render(
    <FilePanel
      files={files}
      treeState={treeState}
      treePathStates={{}}
      selectedPath=""
      fileContent={undefined}
      editorContent=""
      editMode={false}
      contentState="idle"
      saveState="idle"
      onSelectFile={vi.fn()}
      onLoadDirectory={vi.fn()}
      onRefreshTree={vi.fn()}
      onRefreshFile={vi.fn()}
      onStartEdit={vi.fn()}
      onCancelEdit={vi.fn()}
      onChangeContent={vi.fn()}
      onSaveFile={vi.fn()}
    />,
  );
}
