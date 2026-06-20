export type MarkdownFileLinkContext = {
  cwd: string;
  executionFolder?: string;
};

export type MarkdownFileLinkTarget = {
  path: string;
  line?: number;
};

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

export function resolveMarkdownFileLink(
  href: string | undefined,
  context: MarkdownFileLinkContext,
): MarkdownFileLinkTarget | undefined {
  const extracted = extractHrefPath(href);
  if (!extracted) {
    return undefined;
  }

  const lineFromHash = parseLineHash(extracted.hash);
  const withoutLineHint = stripTrailingLineHint(extracted.path);
  const normalizedPath = normalizePath(withoutLineHint.path);
  if (
    !normalizedPath ||
    normalizedPath === "." ||
    isUnsafeRelativePath(normalizedPath)
  ) {
    return undefined;
  }

  const line = lineFromHash ?? withoutLineHint.line;
  const targetPath = normalizedPath.startsWith("/")
    ? relativeToSessionRoot(normalizedPath, context)
    : normalizedPath.replace(/^\.\//, "");

  if (!targetPath || targetPath === "." || isUnsafeRelativePath(targetPath)) {
    return undefined;
  }

  return {
    path: targetPath,
    ...(line === undefined ? {} : { line }),
  };
}

export function isLocalFileLinkHref(href: string | undefined): boolean {
  const extracted = extractHrefPath(href);
  if (!extracted) {
    return false;
  }

  const withoutLineHint = stripTrailingLineHint(extracted.path);
  const normalizedPath = normalizePath(withoutLineHint.path);
  return Boolean(normalizedPath && normalizedPath !== ".");
}

function extractHrefPath(
  href: string | undefined,
): { path: string; hash: string } | undefined {
  const trimmed = href?.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  if (trimmed.toLowerCase().startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      return {
        path: safeDecode(url.pathname),
        hash: url.hash,
      };
    } catch {
      return undefined;
    }
  }

  if (SCHEME_PATTERN.test(trimmed)) {
    return undefined;
  }

  const [pathAndQuery, hash = ""] = splitOnce(trimmed, "#");
  const [path] = splitOnce(pathAndQuery, "?");
  return {
    path: safeDecode(path),
    hash: hash ? `#${hash}` : "",
  };
}

function relativeToSessionRoot(
  absolutePath: string,
  context: MarkdownFileLinkContext,
): string | undefined {
  const roots = unique([
    normalizePath(context.executionFolder ?? ""),
    normalizePath(context.cwd),
  ]).filter((root): root is string => Boolean(root && root.startsWith("/")));

  for (const root of roots) {
    if (absolutePath === root) {
      return ".";
    }
    const prefix = root === "/" ? "/" : `${root}/`;
    if (absolutePath.startsWith(prefix)) {
      return absolutePath.slice(prefix.length);
    }
  }

  return undefined;
}

function stripTrailingLineHint(path: string): { path: string; line?: number } {
  const match = /^(.*):(\d+)(?::\d+)?$/.exec(path);
  if (!match || !match[1]) {
    return { path };
  }
  return {
    path: match[1],
    line: Number(match[2]),
  };
}

function parseLineHash(hash: string): number | undefined {
  const match = /^#(?:L|line-)?(\d+)/i.exec(hash);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

function normalizePath(path: string): string | undefined {
  const value = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = value.startsWith("/");
  const segments: string[] = [];

  for (const segment of value.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (absolute) {
        if (segments.length === 0) {
          return undefined;
        }
        segments.pop();
        continue;
      }
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return absolute ? "/" : ".";
  }
  return `${absolute ? "/" : ""}${segments.join("/")}`;
}

function isUnsafeRelativePath(path: string): boolean {
  return path === ".." || path.startsWith("../");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitOnce(value: string, separator: string): [string, string?] {
  const index = value.indexOf(separator);
  if (index === -1) {
    return [value];
  }
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
