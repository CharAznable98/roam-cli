import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  GitBlame,
  GitBlameCommit,
  GitBlameRange,
  GitBranch,
  GitBranchList,
  GitChange,
  GitChangeGroup,
  GitChangeStatus,
  GitCommitPage,
  GitCommitSummary,
  GitContextRef,
  GitDiffMode,
  GitFileDiff,
  GitJob,
  GitStatus,
  GitStatusResult,
} from "@roamcli/shared/protocol";
import { nowIso } from "@roamcli/shared/protocol";
import {
  type BranchSummary,
  type FileStatusResult,
  type SimpleGit,
  simpleGit,
} from "simple-git";
import {
  isInside,
  resolveSessionChild,
  resolveWorkspaceChild,
} from "./scope.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_CONTENT_BYTES = 1024 * 1024;
const ZERO_SHA = "0000000000000000000000000000000000000000";

export interface GitWorkspaceScope {
  workspace: string;
  cwd: string;
  requestId: string;
  projectId: string;
  context: GitContextRef;
}

export interface GitPathScope extends GitWorkspaceScope {
  path: string;
}

export interface GitHistoryOptions extends GitWorkspaceScope {
  ref?: string;
  path?: string;
  cursor?: string;
  limit: number;
}

export interface GitFileDiffOptions extends GitPathScope {
  mode: GitDiffMode;
  oldRef?: string;
  newRef?: string;
}

export interface GitMutatingOptions extends GitWorkspaceScope {
  operation: string;
}

export interface GitPathsOptions extends GitMutatingOptions {
  paths: string[];
}

export interface GitCommitOptions extends GitMutatingOptions {
  message: string;
}

export interface GitRemoteOperationOptions extends GitMutatingOptions {
  remoteOperation: "fetch" | "pull" | "push";
}

export async function readGitStatus(
  options: GitWorkspaceScope,
): Promise<GitStatusResult> {
  const cwd = await resolveGitCwd(options.workspace, options.cwd);
  if (!(await isGitWorkTree(cwd))) {
    return {
      kind: "not_git_repository",
      requestId: options.requestId,
      context: options.context,
      message: "This directory is not a Git repository.",
    };
  }
  const git = simpleGit(cwd);
  const [status, headSha, unborn] = await Promise.all([
    git.status(["--ignored=matching"]),
    revParse(cwd, "HEAD").catch(() => undefined),
    isUnborn(cwd),
  ]);
  return {
    kind: "repository",
    requestId: options.requestId,
    context: options.context,
    ...(status.current ? { branch: status.current } : {}),
    detached: status.detached,
    ...(headSha ? { headSha } : {}),
    ...(status.tracking ? { upstream: status.tracking } : {}),
    ahead: status.ahead,
    behind: status.behind,
    clean: status.isClean(),
    unborn,
    groups: groupStatusChanges(status.files),
  };
}

export async function readGitFileDiff(
  options: GitFileDiffOptions,
): Promise<GitFileDiff> {
  const cwd = await resolveGitCwd(options.workspace, options.cwd);
  await assertGitWorkTree(cwd);
  const path = normalizeGitPath(options.path);
  const targetPath = resolveSessionChild(cwd, path);
  const oldRef = resolveOldRef(options.mode, options.oldRef);
  const newRef = resolveNewRef(options.mode, options.newRef);
  const oldContent = await readDiffSide(cwd, path, oldRef, "old");
  const newContent =
    newRef === "WORKTREE"
      ? await readWorktreeSide(targetPath)
      : await readDiffSide(cwd, path, newRef, "new");
  const tooLarge = oldContent.tooLarge || newContent.tooLarge;
  const language = languageForPath(path);
  return {
    requestId: options.requestId,
    context: options.context,
    path,
    mode: options.mode,
    ...(oldRef !== "HEAD" && oldRef !== "INDEX" && oldRef !== "WORKTREE"
      ? { oldRef }
      : options.oldRef
        ? { oldRef: options.oldRef }
        : {}),
    ...(newRef !== "HEAD" && newRef !== "INDEX" && newRef !== "WORKTREE"
      ? { newRef }
      : options.newRef
        ? { newRef: options.newRef }
        : {}),
    oldContent: oldContent.content,
    newContent: newContent.content,
    ...(language ? { language } : {}),
    binary: oldContent.binary || newContent.binary,
    tooLarge,
  };
}

export async function readGitBlame(
  options: GitPathScope & { ref?: string },
): Promise<GitBlame> {
  const cwd = await resolveGitCwd(options.workspace, options.cwd);
  await assertGitWorkTree(cwd);
  const path = normalizeGitPath(options.path);
  resolveSessionChild(cwd, path);
  const args = ["blame", "--line-porcelain"];
  if (options.ref) {
    args.push(options.ref);
  }
  args.push("--", path);
  const { stdout } = await git(cwd, args);
  const parsed = parseBlame(stdout);
  return {
    requestId: options.requestId,
    context: options.context,
    path,
    ...(options.ref ? { ref: options.ref } : {}),
    ranges: parsed.ranges,
    commits: parsed.commits,
  };
}

export async function readGitCommitPage(
  options: GitHistoryOptions,
): Promise<GitCommitPage> {
  const cwd = await resolveGitCwd(options.workspace, options.cwd);
  await assertGitWorkTree(cwd);
  const limit = Math.min(Math.max(options.limit, 1), 200);
  const skip = parseCursor(options.cursor);
  const args = [
    "log",
    "--date=iso-strict",
    "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%cn%x1f%cI%x1f%s%x1e",
    `--max-count=${limit + 1}`,
    `--skip=${skip}`,
  ];
  if (options.ref) {
    args.push(options.ref);
  }
  if (options.path) {
    args.push("--", normalizeGitPath(options.path));
  }
  const { stdout } = await git(cwd, args);
  const commits = parseLog(stdout);
  const visible = commits.slice(0, limit);
  const commitsWithFiles = await Promise.all(
    visible.map(async (commit) => ({
      ...commit,
      files: await readCommitFiles(cwd, commit),
    })),
  );
  return {
    requestId: options.requestId,
    context: options.context,
    commits: commitsWithFiles,
    ...(commits.length > limit ? { nextCursor: String(skip + limit) } : {}),
  };
}

export async function readGitBranches(
  options: GitWorkspaceScope,
): Promise<GitBranchList> {
  const cwd = await resolveGitCwd(options.workspace, options.cwd);
  await assertGitWorkTree(cwd);
  const summary = await simpleGit(cwd).branch(["--all", "--verbose"]);
  return {
    requestId: options.requestId,
    context: options.context,
    branches: branchSummaryToList(summary),
  };
}

export async function stageGitPaths(options: GitPathsOptions): Promise<GitJob> {
  return runGitJob(options, async (cwd) => {
    const paths = normalizeGitPaths(options.paths);
    await simpleGit(cwd).add(paths);
  });
}

export async function initGitRepository(
  options: GitMutatingOptions,
): Promise<GitJob> {
  return runGitJob(options, async (cwd) => {
    await simpleGit(cwd).init();
  });
}

export async function unstageGitPaths(
  options: GitPathsOptions,
): Promise<GitJob> {
  return runGitJob(options, async (cwd) => {
    await git(cwd, [
      "restore",
      "--staged",
      "--",
      ...normalizeGitPaths(options.paths),
    ]);
  });
}

export async function discardGitPaths(
  options: GitPathsOptions,
): Promise<GitJob> {
  return runGitJob(options, async (cwd) => {
    const paths = normalizeGitPaths(options.paths);
    let restoreError: unknown;
    await git(cwd, ["restore", "--worktree", "--", ...paths]).catch(
      (error: unknown) => {
        restoreError = error;
      },
    );
    await git(cwd, ["clean", "-f", "--", ...paths]).catch(() => undefined);
    if (restoreError !== undefined) {
      const { stdout } = await git(cwd, [
        "status",
        "--porcelain",
        "--",
        ...paths,
      ]);
      if (stdout.trim().length > 0) {
        throw restoreError;
      }
    }
  });
}

export async function commitGitChanges(
  options: GitCommitOptions,
): Promise<GitJob> {
  return runGitJob(options, async (cwd) => {
    await simpleGit(cwd).commit(options.message);
  });
}

export async function runGitRemoteOperation(
  options: GitRemoteOperationOptions,
): Promise<GitJob> {
  return runGitJob(options, async (cwd) => {
    const gitClient = simpleGit(cwd);
    if (options.remoteOperation === "fetch") {
      await gitClient.fetch();
      return;
    }
    if (options.remoteOperation === "pull") {
      await gitClient.pull();
      return;
    }
    await gitClient.push();
  });
}

export async function removeGitWorktree(
  options: GitMutatingOptions,
): Promise<GitJob> {
  return runGitJob(options, async (cwd) => {
    await assertGitWorkTree(cwd);
    await git(cwd, ["worktree", "remove", "--force", cwd]);
  });
}

async function runGitJob(
  options: GitMutatingOptions,
  run: (cwd: string) => Promise<void>,
): Promise<GitJob> {
  const createdAt = nowIso();
  const startedAt = nowIso();
  const cwd = await resolveGitCwd(options.workspace, options.cwd);
  const baseJob = {
    id: options.requestId,
    projectId: options.projectId,
    ...(options.context.kind === "session_worktree"
      ? { sessionId: options.context.sessionId }
      : {}),
    contextKind: options.context.kind,
    operation: options.operation,
    createdAt,
    startedAt,
  } satisfies Omit<GitJob, "status">;

  try {
    if (options.operation !== "init") {
      await assertGitWorkTree(cwd);
    }
    await run(cwd);
    return {
      ...baseJob,
      status: "succeeded",
      finishedAt: nowIso(),
    };
  } catch (error: unknown) {
    const gitError = normalizeGitError(error);
    return {
      ...baseJob,
      status: "failed",
      finishedAt: nowIso(),
      errorCode: gitError.code,
      errorSummary: gitError.message,
    };
  }
}

async function resolveGitCwd(workspace: string, cwd: string): Promise<string> {
  const resolved = resolveWorkspaceChild(workspace, cwd);
  const [realWorkspace, realCwd] = await Promise.all([
    realpath(resolve(workspace)),
    realpath(resolved),
  ]);
  if (!isInside(realWorkspace, realCwd)) {
    throw new Error(`Git cwd escapes workspace: ${cwd}`);
  }
  return realCwd;
}

async function assertGitWorkTree(cwd: string): Promise<void> {
  if (!(await isGitWorkTree(cwd))) {
    throw new Error("Directory is not a git repository");
  }
}

async function isGitWorkTree(cwd: string): Promise<boolean> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "false");
  return inside === "true";
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await git(cwd, ["rev-parse", "--verify", ref]);
  return stdout.trim();
}

async function isUnborn(cwd: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--verify", "HEAD"])
    .then(() => false)
    .catch(() => true);
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

function groupStatusChanges(files: FileStatusResult[]): GitChangeGroup[] {
  const groups: Record<GitChangeGroup["id"], GitChange[]> = {
    staged: [],
    changes: [],
    conflicts: [],
    untracked: [],
    ignored: [],
    submodules: [],
  };

  for (const file of files) {
    const indexStatus = statusFromCode(file.index);
    const worktreeStatus = statusFromCode(file.working_dir);
    const isConflict = isConflictStatus(file.index, file.working_dir);
    const oldPath = file.from === undefined ? {} : { oldPath: file.from };

    if (isConflict) {
      groups.conflicts.push({
        path: file.path,
        ...oldPath,
        status: "conflicted",
        staged: false,
      });
      continue;
    }

    if (file.working_dir === "?") {
      groups.untracked.push({
        path: file.path,
        ...oldPath,
        status: "untracked",
        staged: false,
      });
      continue;
    }

    if (file.working_dir === "!") {
      groups.ignored.push({
        path: file.path,
        ...oldPath,
        status: "ignored",
        staged: false,
      });
      continue;
    }

    if (indexStatus !== undefined) {
      groups.staged.push({
        path: file.path,
        ...oldPath,
        status: indexStatus,
        staged: true,
      });
    }

    if (worktreeStatus !== undefined) {
      groups.changes.push({
        path: file.path,
        ...oldPath,
        status: worktreeStatus,
        staged: false,
      });
    }
  }

  return (Object.keys(groups) as Array<GitChangeGroup["id"]>).map((id) => ({
    id,
    changes: groups[id],
  }));
}

function statusFromCode(code: string): GitChangeStatus | undefined {
  if (code === " " || code.length === 0) return undefined;
  if (code === "M") return "modified";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  if (code === "?") return "untracked";
  if (code === "!") return "ignored";
  if (code === "U") return "conflicted";
  if (code === "T") return "submodule";
  return "modified";
}

function isConflictStatus(index: string, workingDir: string): boolean {
  return (
    index === "U" ||
    workingDir === "U" ||
    `${index}${workingDir}` === "AA" ||
    `${index}${workingDir}` === "DD"
  );
}

function resolveOldRef(mode: GitDiffMode, oldRef?: string): string {
  if (mode === "commit" || mode === "ref_compare") {
    return oldRef ?? "HEAD";
  }
  return "HEAD";
}

function resolveNewRef(mode: GitDiffMode, newRef?: string): string {
  if (mode === "staged") {
    return "INDEX";
  }
  if (mode === "commit" || mode === "ref_compare") {
    return newRef ?? "HEAD";
  }
  return "WORKTREE";
}

async function readDiffSide(
  cwd: string,
  path: string,
  ref: string,
  label: "old" | "new",
): Promise<{ content: string; binary: boolean; tooLarge: boolean }> {
  if (ref === "WORKTREE") {
    return readWorktreeSide(resolveSessionChild(cwd, path));
  }
  const objectRef = ref === "INDEX" ? `:${path}` : `${ref}:${path}`;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "show", objectRef],
      {
        maxBuffer: MAX_DIFF_CONTENT_BYTES + 1,
        encoding: "buffer",
      },
    );
    return decodeContent(Buffer.from(stdout));
  } catch (error: unknown) {
    if (isGitObjectMissing(error)) {
      return { content: "", binary: false, tooLarge: false };
    }
    const gitError = normalizeGitError(error);
    throw new Error(
      `Unable to read ${label} content for ${path}: ${gitError.message}`,
    );
  }
}

async function readWorktreeSide(
  path: string,
): Promise<{ content: string; binary: boolean; tooLarge: boolean }> {
  try {
    const content = await readFile(path);
    return decodeContent(content);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return { content: "", binary: false, tooLarge: false };
    }
    throw error;
  }
}

function decodeContent(buffer: Buffer): {
  content: string;
  binary: boolean;
  tooLarge: boolean;
} {
  const tooLarge = buffer.byteLength > MAX_DIFF_CONTENT_BYTES;
  const slice = tooLarge ? buffer.subarray(0, MAX_DIFF_CONTENT_BYTES) : buffer;
  const binary = slice.includes(0);
  return {
    content: binary ? "" : slice.toString("utf8"),
    binary,
    tooLarge,
  };
}

function parseBlame(stdout: string): {
  ranges: GitBlameRange[];
  commits: Record<string, GitBlameCommit>;
} {
  const commits: Record<string, GitBlameCommit> = {};
  const ranges: GitBlameRange[] = [];
  let current:
    | {
        sha: string;
        finalLine: number;
        authorName?: string;
        authorEmail?: string;
        authoredAt?: string;
        summary?: string;
      }
    | undefined;

  for (const line of stdout.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?/.exec(line);
    if (header) {
      const sha = header[1] ?? "";
      const finalLine = Number(header[2] ?? "0");
      current = { sha, finalLine };
      appendBlameLine(ranges, sha, finalLine);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("author ")) {
      current.authorName = line.slice("author ".length);
    } else if (line.startsWith("author-mail ")) {
      current.authorEmail = line
        .slice("author-mail ".length)
        .replace(/^<|>$/g, "");
    } else if (line.startsWith("author-time ")) {
      current.authoredAt = new Date(
        Number(line.slice("author-time ".length)) * 1000,
      ).toISOString();
    } else if (line.startsWith("summary ")) {
      current.summary = line.slice("summary ".length);
      commits[current.sha] ??= {
        sha: current.sha,
        authorName: current.authorName ?? "Unknown",
        ...(current.authorEmail ? { authorEmail: current.authorEmail } : {}),
        ...(current.authoredAt ? { authoredAt: current.authoredAt } : {}),
        summary: current.summary,
      };
    }
  }
  return { ranges, commits };
}

function appendBlameLine(
  ranges: GitBlameRange[],
  commitSha: string,
  line: number,
): void {
  const previous = ranges.at(-1);
  if (previous?.commitSha === commitSha && previous.endLine + 1 === line) {
    previous.endLine = line;
    return;
  }
  ranges.push({ startLine: line, endLine: line, commitSha });
}

function parseLog(stdout: string): GitCommitSummary[] {
  return stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [
        sha = "",
        parents = "",
        authorName = "",
        authoredAt = "",
        committerName = "",
        committedAt = "",
        summary = "",
      ] = entry.split("\x1f");
      return {
        sha,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        authorName,
        ...(authoredAt ? { authoredAt } : {}),
        committerName,
        ...(committedAt ? { committedAt } : {}),
        summary,
        refs: [],
      };
    });
}

async function readCommitFiles(
  cwd: string,
  commit: GitCommitSummary,
): Promise<GitChange[]> {
  const firstParent = commit.parents[0];
  const args = firstParent
    ? [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "--find-renames",
        firstParent,
        commit.sha,
      ]
    : [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "--root",
        "--find-renames",
        commit.sha,
      ];
  const { stdout } = await git(cwd, args);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): GitChange[] => {
      const parts = line.split("\t");
      const code = parts[0] ?? "";
      const status = commitStatusFromCode(code);
      if (!status) {
        return [];
      }
      if (status === "renamed" || status === "copied") {
        const oldPath = parts[1];
        const path = parts[2];
        return oldPath && path
          ? [{ path, oldPath, status, staged: false }]
          : [];
      }
      const path = parts[1];
      return path ? [{ path, status, staged: false }] : [];
    });
}

function commitStatusFromCode(code: string): GitChangeStatus | undefined {
  const status = code[0];
  if (status === "M") return "modified";
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  if (status === "C") return "copied";
  if (status === "T") return "submodule";
  if (status === "U") return "conflicted";
  return undefined;
}

function branchSummaryToList(summary: BranchSummary): GitBranch[] {
  return Object.values(summary.branches).map((branch) => {
    const remote = branch.name.startsWith("remotes/");
    return {
      name: remote ? branch.name.slice("remotes/".length) : branch.name,
      current: branch.current,
      remote,
    };
  });
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const value = Number(cursor);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeGitPaths(paths: string[]): string[] {
  return paths.map(normalizeGitPath);
}

function normalizeGitPath(path: string): string {
  const value = path.trim();
  if (
    !value ||
    value === "." ||
    value.startsWith("/") ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid git path: ${path}`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid git path: ${path}`);
  }
  return segments.join("/");
}

function languageForPath(path: string): string | undefined {
  const extension = extname(path).slice(1).toLowerCase();
  if (extension) {
    return extension;
  }
  const name = basename(path).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return undefined;
}

function normalizeGitError(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const maybe = error as {
      message?: unknown;
      stderr?: unknown;
      code?: unknown;
      exitCode?: unknown;
    };
    const rawMessage =
      typeof maybe.stderr === "string" && maybe.stderr.trim()
        ? maybe.stderr.trim()
        : typeof maybe.message === "string"
          ? maybe.message
          : String(error);
    const code =
      typeof maybe.code === "string"
        ? maybe.code
        : typeof maybe.exitCode === "number"
          ? `GIT_EXIT_${maybe.exitCode}`
          : "GIT_ERROR";
    return { code, message: rawMessage };
  }
  return { code: "GIT_ERROR", message: String(error) };
}

function isGitObjectMissing(error: unknown): boolean {
  const message = normalizeGitError(error).message;
  return (
    message.includes("exists on disk, but not in") ||
    message.includes("does not exist in") ||
    message.includes("Path ") ||
    message.includes(ZERO_SHA)
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
