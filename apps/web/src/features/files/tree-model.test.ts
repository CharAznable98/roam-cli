import type { FileNode } from "@roamcli/shared/protocol";
import { describe, expect, it } from "vitest";
import { nearestTreeDirectoryPath } from "./tree-model";

describe("tree-model", () => {
  it("finds the nearest directory already represented in the lazy tree", () => {
    const nodes: FileNode[] = [
      {
        path: "src",
        name: "src",
        type: "directory",
        children: [
          {
            path: "src/app",
            name: "app",
            type: "directory",
          },
        ],
      },
    ];

    expect(nearestTreeDirectoryPath(nodes, "src/app/new")).toBe("src/app");
    expect(nearestTreeDirectoryPath(nodes, "src/new")).toBe("src");
    expect(nearestTreeDirectoryPath(nodes, "packages/new")).toBe(".");
  });
});
