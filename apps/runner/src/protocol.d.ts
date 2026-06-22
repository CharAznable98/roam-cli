declare module "@roamcli/shared/protocol" {
  export type AgentKind = string;
  export type RunnerProfile = "strict" | "standard" | "trusted";
  export type ExecutionMode = "direct" | "managed_worktree" | "remote";
  export type SessionStatus =
    | "pending"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "stopped";
  export type ChatRole = "user" | "assistant" | "system" | "tool";
  export type ApprovalKind = "execCommand" | "applyPatch";
  export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
  export type ArtifactKind = "patch" | "file" | "log";
  export type GitDiffMode =
    | "working_tree"
    | "staged"
    | "commit"
    | "ref_compare";
  export type GitChangeStatus =
    | "modified"
    | "added"
    | "deleted"
    | "renamed"
    | "copied"
    | "untracked"
    | "ignored"
    | "conflicted"
    | "submodule";
  export type GitJobStatus =
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled";

  export interface ParserSchema<T> {
    parse(value: unknown): T;
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: Error };
  }

  export const RunnerProfileSchema: ParserSchema<RunnerProfile>;
  export const RunnerCommandSchema: ParserSchema<RunnerCommand>;
  export const DEFAULT_MAX_IMAGES_PER_TURN: number;
  export const DEFAULT_MAX_IMAGE_BYTES: number;

  export interface RunnerCapability {
    kind: AgentKind;
    label: string;
    command: string;
    args: string[];
    parser: string;
    supportsResume: boolean;
    supportsImages: boolean;
    supportedImageMimeTypes: string[];
    maxImagesPerTurn: number;
    maxImageBytes: number;
    pluginName?: string;
    pluginVersion?: string;
  }

  export interface RunnerRegistration {
    runnerId: string;
    displayName: string;
    hostname: string;
    workspaceRoot: string;
    dataDir?: string;
    profile: RunnerProfile;
    publicKey: string;
    capabilities: RunnerCapability[];
    version: string;
  }

  export interface Session {
    id: string;
    title: string;
    projectId: string;
    runnerId: string;
    agent: AgentKind;
    status: SessionStatus;
    executionMode: ExecutionMode;
    executionFolder: string;
    cwd: string;
    gitBranchName?: string;
    gitBaseRef?: string;
    gitBaseSha?: string;
    worktreeDeletedAt?: string;
    agentThreadId?: string;
    archivedAt?: string;
    createdAt: string;
    updatedAt: string;
  }

  export interface Message {
    id: string;
    sessionId: string;
    role: ChatRole;
    content: string;
    encrypted: boolean;
    createdAt: string;
  }

  export interface SessionStatusCheckResult {
    requestId: string;
    sessionId: string;
    active: boolean;
  }

  export interface ImageAttachmentUpload {
    name: string;
    mimeType: string;
    size: number;
    contentBase64: string;
  }

  export interface MessageAttachment {
    id: string;
    sessionId: string;
    messageId: string;
    runnerId: string;
    kind: "image";
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    status: "available" | "deleted";
    createdAt: string;
    deletedAt?: string;
  }

  export interface RunnerAttachmentRef {
    id: string;
    kind: "image";
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    runnerStoragePath: string;
  }

  export interface AttachmentWriteResult {
    requestId: string;
    sessionId: string;
    attachments: RunnerAttachmentRef[];
  }

  export interface AttachmentContentResult {
    requestId: string;
    sessionId: string;
    attachmentId: string;
    name: string;
    mimeType: string;
    size: number;
    contentBase64: string;
  }

  export interface AttachmentDeleteResult {
    requestId: string;
    sessionId: string;
    deleted: string[];
    failed: string[];
  }

  export interface Approval {
    id: string;
    sessionId: string;
    runnerId: string;
    kind: ApprovalKind;
    summary: string;
    payload: Record<string, unknown>;
    status: ApprovalStatus;
    requestedAt: string;
    resolvedAt?: string;
    clientSignature?: string;
  }

  export interface Artifact {
    id: string;
    sessionId: string;
    kind: ArtifactKind;
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    storagePath: string;
    createdAt: string;
  }

  export interface FileNode {
    path: string;
    name: string;
    type: "file" | "directory";
    size?: number;
    children?: FileNode[];
  }

  export type AgentSkillSourceType = "project" | "global";

  export interface AgentSkillSummary {
    name: string;
    description?: string;
    sourceType: AgentSkillSourceType;
    sourcePath: string;
  }

  export interface AgentSkillListResult {
    requestId: string;
    agent: AgentKind;
    basePath: string;
    queriedAt: string;
    skills: AgentSkillSummary[];
  }

  export interface PathSearchEntry {
    path: string;
    name: string;
    type: "file" | "directory";
  }

  export interface PathSearchResult {
    requestId: string;
    basePath: string;
    query: string;
    entries: PathSearchEntry[];
  }

  export interface FileTreeResult {
    requestId: string;
    clientRequestId?: string;
    sessionId: string;
    root: FileNode;
  }

  export interface TextFileContentResult {
    requestId: string;
    sessionId: string;
    path: string;
    kind: "text";
    content: string;
    truncated: boolean;
    encoding: "utf8";
  }

  export interface ImageFileContentResult {
    requestId: string;
    sessionId: string;
    path: string;
    kind: "image";
    contentBase64?: string;
    mimeType: string;
    size: number;
    truncated: boolean;
    encoding: "base64";
  }

  export interface BinaryFileContentResult {
    requestId: string;
    sessionId: string;
    path: string;
    kind: "binary";
    mimeType: string;
    size: number;
    truncated: boolean;
    encoding: "binary";
  }

  export type FileContentResult =
    | TextFileContentResult
    | ImageFileContentResult
    | BinaryFileContentResult;

  export interface DirectoryCreateResult {
    requestId: string;
    path: string;
    node: FileNode;
  }

  export interface FileWriteResult {
    requestId: string;
    sessionId: string;
    path: string;
    bytesWritten: number;
    encoding: "utf8";
  }

  export interface PatchApplyResult {
    requestId: string;
    sessionId: string;
    applied: boolean;
    changedFiles: string[];
    message: string;
    rejected: string[];
  }

  export type GitContextRef =
    | { kind: "project"; projectId: string }
    | { kind: "session_worktree"; sessionId: string };

  export interface GitChange {
    path: string;
    oldPath?: string;
    status: GitChangeStatus;
    staged: boolean;
  }

  export interface GitChangeGroup {
    id:
      | "staged"
      | "changes"
      | "conflicts"
      | "untracked"
      | "ignored"
      | "submodules";
    changes: GitChange[];
  }

  export interface GitStatus {
    kind: "repository";
    requestId: string;
    context: GitContextRef;
    branch?: string;
    detached: boolean;
    headSha?: string;
    upstream?: string;
    ahead: number;
    behind: number;
    clean: boolean;
    unborn: boolean;
    groups: GitChangeGroup[];
  }

  export interface GitNotRepositoryStatus {
    kind: "not_git_repository";
    requestId: string;
    context: GitContextRef;
    message: string;
  }

  export type GitStatusResult = GitStatus | GitNotRepositoryStatus;

  export interface GitFileDiff {
    requestId: string;
    context: GitContextRef;
    path: string;
    oldPath?: string;
    mode: GitDiffMode;
    oldRef?: string;
    newRef?: string;
    oldContent: string;
    newContent: string;
    language?: string;
    binary: boolean;
    tooLarge: boolean;
  }

  export interface GitBlameRange {
    startLine: number;
    endLine: number;
    commitSha: string;
  }

  export interface GitBlameCommit {
    sha: string;
    authorName: string;
    authorEmail?: string;
    authoredAt?: string;
    summary: string;
  }

  export interface GitBlame {
    requestId: string;
    context: GitContextRef;
    path: string;
    ref?: string;
    ranges: GitBlameRange[];
    commits: Record<string, GitBlameCommit>;
  }

  export interface GitCommitSummary {
    sha: string;
    parents: string[];
    authorName: string;
    authoredAt?: string;
    committerName: string;
    committedAt?: string;
    summary: string;
    refs: string[];
    changedFiles?: number;
    insertions?: number;
    deletions?: number;
    files?: GitChange[];
  }

  export interface GitCommitPage {
    requestId: string;
    context: GitContextRef;
    commits: GitCommitSummary[];
    nextCursor?: string;
  }

  export interface GitBranch {
    name: string;
    current: boolean;
    remote: boolean;
    upstream?: string;
  }

  export interface GitBranchList {
    requestId: string;
    context: GitContextRef;
    branches: GitBranch[];
  }

  export interface GitJob {
    id: string;
    projectId: string;
    sessionId?: string;
    contextKind: "project" | "session_worktree";
    operation: string;
    status: GitJobStatus;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    errorCode?: string;
    errorSummary?: string;
  }

  export interface GitCommandBase {
    requestId: string;
    projectId: string;
    context: GitContextRef;
    cwd: string;
  }

  export type RunnerCommand =
    | {
        type: "startSession";
        session: Session;
        prompt: string;
        resumeThreadId?: string;
        attachments?: RunnerAttachmentRef[];
      }
    | { type: "deliverInput"; sessionId: string; content: string }
    | {
        type: "checkSessionStatus";
        requestId: string;
        sessionId: string;
      }
    | {
        type: "listAgentSkills";
        requestId: string;
        agent: AgentKind;
        basePath: string;
      }
    | {
        type: "searchWorkspacePaths";
        requestId: string;
        basePath: string;
        query: string;
        limit: number;
      }
    | {
        type: "writeSessionAttachments";
        requestId: string;
        sessionId: string;
        attachments: ImageAttachmentUpload[];
      }
    | {
        type: "readSessionAttachment";
        requestId: string;
        sessionId: string;
        attachmentId: string;
        runnerStoragePath: string;
        maxBytes: number;
      }
    | {
        type: "deleteSessionAttachments";
        requestId: string;
        sessionId: string;
        attachments: Array<{ id: string; runnerStoragePath: string }>;
      }
    | {
        type: "readFileTree";
        requestId: string;
        clientRequestId?: string;
        sessionId: string;
        cwd?: string;
        path?: string;
        depth?: number;
        includeFiles?: boolean;
      }
    | {
        type: "readFileContent";
        requestId: string;
        sessionId: string;
        cwd?: string;
        path: string;
        maxBytes?: number;
      }
    | {
        type: "writeFileContent";
        requestId: string;
        sessionId: string;
        cwd?: string;
        path: string;
        content: string;
        encoding?: "utf8";
      }
    | {
        type: "createDirectory";
        requestId: string;
        cwd: string;
        parentPath?: string;
        name: string;
      }
    | {
        type: "applyPatch";
        requestId: string;
        sessionId: string;
        patch: string;
        strip?: number;
        signedAt: string;
        signature: string;
      }
    | ({ type: "gitStatus" } & GitCommandBase)
    | ({
      type: "gitFileDiff";
      path: string;
      oldPath?: string;
      mode?: GitDiffMode;
      oldRef?: string;
      newRef?: string;
    } & GitCommandBase)
    | ({ type: "gitBlame"; path: string; ref?: string } & GitCommandBase)
    | ({
        type: "gitCommitPage";
        ref?: string;
        path?: string;
        cursor?: string;
        limit?: number;
      } & GitCommandBase)
    | ({ type: "gitBranchList" } & GitCommandBase)
    | ({ type: "gitInit" } & GitCommandBase)
    | ({ type: "gitStagePaths"; paths: string[] } & GitCommandBase)
    | ({ type: "gitUnstagePaths"; paths: string[] } & GitCommandBase)
    | ({ type: "gitDiscardPaths"; paths: string[] } & GitCommandBase)
    | ({ type: "gitCommit"; message: string } & GitCommandBase)
    | ({
        type: "gitRemoteOperation";
        operation: "fetch" | "pull" | "push";
      } & GitCommandBase)
    | ({ type: "gitRemoveWorktree" } & GitCommandBase)
    | {
        type: "resolveApproval";
        approvalId: string;
        approved: boolean;
        signedAt: string;
        signature: string;
      }
    | {
        type: "controlSignal";
        sessionId: string;
        signal: "interrupt" | "stop" | "resume";
      };

  export type RunnerEvent =
    | { type: "registered"; runner: RunnerRegistration }
    | { type: "sessionStatus"; sessionId: string; status: SessionStatus }
    | { type: "sessionThread"; sessionId: string; threadId: string }
    | { type: "sessionStatusCheckResult"; result: SessionStatusCheckResult }
    | { type: "agentSkillListResult"; result: AgentSkillListResult }
    | { type: "pathSearchResult"; result: PathSearchResult }
    | {
        type: "assistantMessage";
        sessionId: string;
        content: string;
        encrypted: boolean;
      }
    | { type: "token"; sessionId: string; content: string; encrypted: boolean }
    | { type: "fileTreeResult"; result: FileTreeResult }
    | { type: "fileContentResult"; result: FileContentResult }
    | { type: "fileWriteResult"; result: FileWriteResult }
    | { type: "directoryCreateResult"; result: DirectoryCreateResult }
    | { type: "attachmentWriteResult"; result: AttachmentWriteResult }
    | { type: "attachmentContentResult"; result: AttachmentContentResult }
    | { type: "attachmentDeleteResult"; result: AttachmentDeleteResult }
    | { type: "patchApplyResult"; result: PatchApplyResult }
    | { type: "gitStatusResult"; result: GitStatusResult }
    | { type: "gitFileDiffResult"; result: GitFileDiff }
    | { type: "gitBlameResult"; result: GitBlame }
    | { type: "gitCommitPageResult"; result: GitCommitPage }
    | { type: "gitBranchListResult"; result: GitBranchList }
    | { type: "gitJobResult"; job: GitJob }
    | { type: "approvalRequested"; approval: Approval }
    | { type: "artifactCreated"; artifact: Artifact }
    | {
        type: "error";
        requestId?: string;
        sessionId?: string;
        message: string;
        code?: string;
      };

  export function nowIso(): string;
}
