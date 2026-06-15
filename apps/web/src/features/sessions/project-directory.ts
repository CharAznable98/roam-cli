export interface ProjectDirectoryValidation {
  ok: boolean;
  suffix: string;
  message?: string;
}

const OUTSIDE_BASE_MESSAGE = "Directory must stay under the runner base.";

export function validateProjectDirectorySuffix(
  value: string,
): ProjectDirectoryValidation {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, suffix: "" };
  }
  if (trimmed.startsWith("/")) {
    return { ok: false, suffix: trimmed, message: OUTSIDE_BASE_MESSAGE };
  }

  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, suffix: trimmed, message: OUTSIDE_BASE_MESSAGE };
  }

  return { ok: true, suffix: segments.join("/") };
}

export function composeProjectDirectory(baseDirectory: string, suffix: string): string {
  const base = normalizeBaseDirectory(baseDirectory);
  if (base.length === 0) {
    throw new Error("Runner base directory is unavailable.");
  }

  const validation = validateProjectDirectorySuffix(suffix);
  if (!validation.ok) {
    throw new Error(validation.message ?? OUTSIDE_BASE_MESSAGE);
  }
  if (validation.suffix.length === 0) {
    return base;
  }
  if (base === "/") {
    return `/${validation.suffix}`;
  }
  return `${base}/${validation.suffix}`;
}

export function projectDirectoryName(directory: string): string {
  const normalized = normalizeBaseDirectory(directory);
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function normalizeBaseDirectory(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}
