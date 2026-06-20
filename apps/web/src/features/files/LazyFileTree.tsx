import type { FileNode } from "@roamcli/shared/protocol";
import {
  ChevronRight,
  FileCode2,
  Folder,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type TreePathStates = Record<
  string,
  "idle" | "loading" | "ready" | "error"
>;

export function LazyFileTree({
  nodes,
  selectedFilePath = "",
  selectedDirectoryPath = "",
  pathStates = {},
  onSelectFile,
  onSelectDirectory,
  onLoadDirectory,
  resetKey,
}: {
  nodes: FileNode[];
  selectedFilePath?: string;
  selectedDirectoryPath?: string;
  pathStates?: TreePathStates;
  onSelectFile?: ((path: string) => void) | undefined;
  onSelectDirectory?: ((path: string) => void) | undefined;
  onLoadDirectory: (path: string) => void;
  resetKey?: string | undefined;
}) {
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const requestedOpenLoadsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    requestedOpenLoadsRef.current.clear();
    setOpenPaths(new Set());
  }, [resetKey]);

  useEffect(() => {
    const directoriesByPath = collectDirectoryNodes(nodes);
    const nextOpenPaths = new Set(openPaths);
    const pathsToLoad: string[] = [];
    let openPathsChanged = false;

    for (const path of openPaths) {
      const node = directoriesByPath.get(path);
      if (node === undefined) {
        nextOpenPaths.delete(path);
        requestedOpenLoadsRef.current.delete(path);
        openPathsChanged = true;
        continue;
      }
      if (node.children !== undefined) {
        requestedOpenLoadsRef.current.delete(path);
        continue;
      }

      const pathState = pathStates[path] ?? "idle";
      if (pathState === "loading") {
        requestedOpenLoadsRef.current.delete(path);
        continue;
      }
      if (pathState === "error") {
        requestedOpenLoadsRef.current.delete(path);
        continue;
      }
      if (pathState === "ready") {
        requestedOpenLoadsRef.current.delete(path);
      }
      if (!requestedOpenLoadsRef.current.has(path)) {
        requestedOpenLoadsRef.current.add(path);
        pathsToLoad.push(path);
      }
    }

    if (openPathsChanged) {
      setOpenPaths(nextOpenPaths);
    }
    for (const path of pathsToLoad) {
      onLoadDirectory(path);
    }
  }, [nodes, onLoadDirectory, openPaths, pathStates]);

  const toggleDirectory = (node: FileNode) => {
    onSelectDirectory?.(node.path);
    const willOpen = !openPaths.has(node.path);
    setOpenPaths((current) => {
      const next = new Set(current);
      if (willOpen) {
        next.add(node.path);
      } else {
        next.delete(node.path);
        requestedOpenLoadsRef.current.delete(node.path);
      }
      return next;
    });
    if (willOpen && node.children === undefined) {
      requestedOpenLoadsRef.current.add(node.path);
      onLoadDirectory(node.path);
    }
  };

  return (
    <>
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          selectedFilePath={selectedFilePath}
          selectedDirectoryPath={selectedDirectoryPath}
          openPaths={openPaths}
          pathStates={pathStates}
          onSelectFile={onSelectFile}
          onToggleDirectory={toggleDirectory}
        />
      ))}
    </>
  );
}

function collectDirectoryNodes(nodes: FileNode[]): Map<string, FileNode> {
  const directoriesByPath = new Map<string, FileNode>();
  const visit = (node: FileNode) => {
    if (node.type !== "directory") {
      return;
    }
    directoriesByPath.set(node.path, node);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return directoriesByPath;
}

function TreeNode({
  node,
  selectedFilePath,
  selectedDirectoryPath,
  openPaths,
  pathStates,
  onSelectFile,
  onToggleDirectory,
  depth = 0,
}: {
  node: FileNode;
  selectedFilePath: string;
  selectedDirectoryPath: string;
  openPaths: ReadonlySet<string>;
  pathStates: TreePathStates;
  onSelectFile?: ((path: string) => void) | undefined;
  onToggleDirectory: (node: FileNode) => void;
  depth?: number;
}) {
  const isDirectory = node.type === "directory";
  const isOpen = isDirectory && openPaths.has(node.path);
  const pathState = pathStates[node.path] ?? "idle";
  const isSelected =
    selectedFilePath === node.path || selectedDirectoryPath === node.path;

  return (
    <div>
      <button
        type="button"
        role="treeitem"
        aria-expanded={isDirectory ? isOpen : undefined}
        className={`tree-row ${isSelected ? "is-selected" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => {
          if (isDirectory) {
            onToggleDirectory(node);
          } else {
            onSelectFile?.(node.path);
          }
        }}
      >
        {isDirectory ? (
          <ChevronRight className={isOpen ? "rotate-90" : ""} size={15} />
        ) : (
          <FileCode2 size={15} />
        )}
        {isDirectory ? <Folder size={15} /> : null}
        <span className="truncate">{node.name}</span>
      </button>
      {isDirectory && isOpen && pathState === "loading" ? (
        <div
          className="tree-row tree-row-status"
          style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
        >
          <LoaderCircle className="animate-spin" size={14} />
          <span>Loading...</span>
        </div>
      ) : null}
      {isDirectory && isOpen && pathState === "error" ? (
        <div
          className="tree-row tree-row-status error"
          style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
        >
          <TriangleAlert size={14} />
          <span>Could not load directory.</span>
        </div>
      ) : null}
      {isDirectory &&
        isOpen &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            selectedFilePath={selectedFilePath}
            selectedDirectoryPath={selectedDirectoryPath}
            openPaths={openPaths}
            pathStates={pathStates}
            onSelectFile={onSelectFile}
            onToggleDirectory={onToggleDirectory}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}
