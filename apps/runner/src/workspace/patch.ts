import { spawn } from "node:child_process";
import type { PatchApplyResult } from "@roamcli/shared/protocol";
import { type FileRequestScope, resolvePatchTargetPath } from "./scope.js";

export interface ApplyPatchOptions extends FileRequestScope {
  requestId: string;
  sessionId: string;
  patch: string;
  strip?: number;
}

export async function applyUnifiedDiff(options: ApplyPatchOptions): Promise<PatchApplyResult> {
  try {
    if (options.patch.trim().length === 0) {
      throw new Error("Patch is empty");
    }

    const changedFiles = [...extractUnifiedDiffPaths(options.patch)].sort();
    if (changedFiles.length === 0) {
      throw new Error("Patch contains no file paths");
    }

    await Promise.all(changedFiles.map((path) => resolvePatchTargetPath(options, path)));

    const strip = clampStrip(options.strip);
    const check = await runGitApply(options.sessionCwd, ["apply", `-p${strip}`, "--check", "--whitespace=nowarn", "-"], options.patch);
    if (!check.ok) {
      throw new Error(check.stderr || check.stdout || `git apply --check exited with ${check.code ?? "unknown status"}`);
    }

    const applied = await runGitApply(options.sessionCwd, ["apply", `-p${strip}`, "--whitespace=nowarn", "-"], options.patch);
    if (!applied.ok) {
      throw new Error(applied.stderr || applied.stdout || `git apply exited with ${applied.code ?? "unknown status"}`);
    }

    return {
      requestId: options.requestId,
      sessionId: options.sessionId,
      applied: true,
      changedFiles,
      message: "applied",
      rejected: []
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      requestId: options.requestId,
      sessionId: options.sessionId,
      applied: false,
      changedFiles: [],
      message,
      rejected: [message]
    };
  }
}

export function extractUnifiedDiffPaths(patch: string): Set<string> {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const path = normalizeDiffPath(line.slice(4));
      if (path !== undefined) {
        paths.add(path);
      }
      continue;
    }
    for (const prefix of ["rename from ", "rename to ", "copy from ", "copy to "]) {
      if (line.startsWith(prefix)) {
        const path = normalizeDiffPath(line.slice(prefix.length));
        if (path !== undefined) {
          paths.add(path);
        }
        break;
      }
    }
    if (line.startsWith("diff --git ")) {
      for (const path of parseGitDiffHeader(line)) {
        paths.add(path);
      }
    }
  }
  return paths;
}

function runGitApply(cwd: string, args: readonly string[], input: string): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn("git", [...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolveRun({ ok: false, code: null, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      resolveRun({
        ok: code === 0,
        code,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim()
      });
    });
    child.stdin.end(input);
  });
}

function normalizeDiffPath(value: string): string | undefined {
  const raw = value.trim();
  const path = unquotePath(raw.includes("\t") ? raw.slice(0, raw.indexOf("\t")) : raw);
  if (path === "/dev/null") {
    return undefined;
  }
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}

function parseGitDiffHeader(line: string): string[] {
  const tokens = tokenize(line.slice("diff --git ".length));
  return tokens
    .map(normalizeDiffPath)
    .filter((path): path is string => path !== undefined);
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }
    if (value[index] === "\"") {
      let token = "\"";
      index += 1;
      while (index < value.length) {
        const character = value[index] ?? "";
        token += character;
        index += 1;
        if (character === "\"" && token[token.length - 2] !== "\\") {
          break;
        }
      }
      tokens.push(token);
      continue;
    }
    const start = index;
    while (index < value.length && !/\s/.test(value[index] ?? "")) {
      index += 1;
    }
    tokens.push(value.slice(start, index));
  }
  return tokens;
}

function unquotePath(path: string): string {
  if (path.startsWith("\"") && path.endsWith("\"")) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

function clampStrip(strip: number | undefined): number {
  return Math.max(0, Math.min(strip ?? 1, 3));
}
