import type { FileNode } from "@roamcli/shared/protocol";

export function replaceTreeChildren(
  nodes: FileNode[],
  path: string,
  children: FileNode[],
): FileNode[] {
  const sortedChildren = sortFileNodes(children);
  if (path === ".") {
    return sortedChildren;
  }
  return nodes.map((node) =>
    node.path === path
      ? { ...node, children: sortedChildren }
      : node.type === "directory" && node.children
        ? {
            ...node,
            children: replaceTreeChildren(node.children, path, sortedChildren),
          }
        : node,
  );
}

export function upsertTreeChild(
  nodes: FileNode[],
  parentPath: string,
  child: FileNode,
): FileNode[] {
  if (parentPath === ".") {
    return sortFileNodes(upsertNode(nodes, child));
  }
  return nodes.map((node) =>
    node.path === parentPath
      ? {
          ...node,
          children: sortFileNodes(upsertNode(node.children ?? [], child)),
        }
      : node.type === "directory" && node.children
        ? {
            ...node,
            children: upsertTreeChild(node.children, parentPath, child),
          }
        : node,
  );
}

export function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index) || ".";
}

export function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort(compareFileNodes);
}

function upsertNode(nodes: FileNode[], node: FileNode): FileNode[] {
  const existing = nodes.findIndex((item) => item.path === node.path);
  if (existing === -1) {
    return [...nodes, node];
  }
  return nodes.map((item, index) => (index === existing ? node : item));
}

function compareFileNodes(left: FileNode, right: FileNode): number {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}
