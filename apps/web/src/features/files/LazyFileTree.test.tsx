// @vitest-environment jsdom
import "../../test/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FileNode } from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { LazyFileTree } from "./LazyFileTree";

describe("LazyFileTree", () => {
  it("loads an expanded directory again when a parent refresh drops its children", async () => {
    const onLoadDirectory = vi.fn();
    const { rerender } = render(
      <LazyFileTree
        nodes={[directory("src")]}
        onLoadDirectory={onLoadDirectory}
      />,
    );

    fireEvent.click(screen.getByRole("treeitem", { name: /src/ }));
    expect(onLoadDirectory).toHaveBeenCalledWith("src");

    rerender(
      <LazyFileTree
        nodes={[directory("src", [directory("src/components")])]}
        pathStates={{ src: "ready" }}
        onLoadDirectory={onLoadDirectory}
      />,
    );
    fireEvent.click(screen.getByRole("treeitem", { name: /components/ }));
    expect(onLoadDirectory).toHaveBeenCalledWith("src/components");

    rerender(
      <LazyFileTree
        nodes={[
          directory("src", [
            directory("src/components", [
              {
                path: "src/components/Button.tsx",
                name: "Button.tsx",
                type: "file",
                size: 1,
              },
            ]),
          ]),
        ]}
        pathStates={{ src: "ready", "src/components": "ready" }}
        onLoadDirectory={onLoadDirectory}
      />,
    );
    expect(screen.getByRole("treeitem", { name: /Button\.tsx/ })).toBeTruthy();

    onLoadDirectory.mockClear();
    rerender(
      <LazyFileTree
        nodes={[directory("src", [directory("src/components")])]}
        pathStates={{ src: "ready", "src/components": "ready" }}
        onLoadDirectory={onLoadDirectory}
      />,
    );

    await waitFor(() => {
      expect(onLoadDirectory).toHaveBeenCalledTimes(1);
      expect(onLoadDirectory).toHaveBeenCalledWith("src/components");
    });
  });

  it("does not duplicate the manual load request when opening a directory", async () => {
    const onLoadDirectory = vi.fn();
    render(
      <LazyFileTree
        nodes={[directory("src")]}
        onLoadDirectory={onLoadDirectory}
      />,
    );

    fireEvent.click(screen.getByRole("treeitem", { name: /src/ }));

    await waitFor(() => {
      expect(onLoadDirectory).toHaveBeenCalledTimes(1);
    });
    expect(onLoadDirectory).toHaveBeenCalledWith("src");
  });
});

function directory(path: string, children?: FileNode[]): FileNode {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    type: "directory",
    ...(children === undefined ? {} : { children }),
  };
}
