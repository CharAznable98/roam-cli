import { z } from "zod";

export const AgentKindSchema = z.string().min(1);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const RunnerProfileSchema = z.enum(["strict", "standard", "trusted"]);
export type RunnerProfile = z.infer<typeof RunnerProfileSchema>;

export const DEFAULT_MAX_IMAGES_PER_TURN = 5;
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const RunnerCapabilitySchema = z.object({
  kind: AgentKindSchema,
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  parser: z.string().min(1),
  supportsResume: z.boolean().default(false),
  supportsImages: z.boolean().default(false),
  supportedImageMimeTypes: z.array(z.string().min(1)).default([]),
  maxImagesPerTurn: z.number().int().nonnegative().default(0),
  maxImageBytes: z.number().int().positive().default(DEFAULT_MAX_IMAGE_BYTES),
  pluginName: z.string().min(1).optional(),
  pluginVersion: z.string().min(1).optional(),
});
export type RunnerCapability = z.infer<typeof RunnerCapabilitySchema>;

export const RunnerRegistrationSchema = z.object({
  runnerId: z.string().min(1),
  displayName: z.string().min(1),
  hostname: z.string().min(1),
  workspaceRoot: z.string().min(1),
  dataDir: z.string().min(1).optional(),
  profile: RunnerProfileSchema,
  publicKey: z.string().min(16),
  capabilities: z.array(RunnerCapabilitySchema).min(1),
  version: z.string().min(1),
});
export type RunnerRegistration = z.infer<typeof RunnerRegistrationSchema>;

export const SessionStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "stopped",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runnerId: z.string().min(1),
  directory: z.string().min(1),
  archivedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastActiveAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ExecutionModeSchema = z.enum([
  "direct",
  "managed_worktree",
  "remote",
]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const GitContextRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("project"),
    projectId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("session_worktree"),
    sessionId: z.string().min(1),
  }),
]);
export type GitContextRef = z.infer<typeof GitContextRefSchema>;

export const GitChangeStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "ignored",
  "conflicted",
  "submodule",
]);
export type GitChangeStatus = z.infer<typeof GitChangeStatusSchema>;

export const GitChangeSchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  status: GitChangeStatusSchema,
  staged: z.boolean(),
});
export type GitChange = z.infer<typeof GitChangeSchema>;

export const GitChangeGroupSchema = z.object({
  id: z.enum([
    "staged",
    "changes",
    "conflicts",
    "untracked",
    "ignored",
    "submodules",
  ]),
  changes: z.array(GitChangeSchema),
});
export type GitChangeGroup = z.infer<typeof GitChangeGroupSchema>;

export const GitStatusSchema = z.object({
  requestId: z.string().min(1),
  context: GitContextRefSchema,
  branch: z.string().min(1).optional(),
  detached: z.boolean().default(false),
  headSha: z.string().optional(),
  upstream: z.string().min(1).optional(),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  clean: z.boolean(),
  unborn: z.boolean().default(false),
  groups: z.array(GitChangeGroupSchema),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const GitDiffModeSchema = z.enum([
  "working_tree",
  "staged",
  "commit",
  "ref_compare",
]);
export type GitDiffMode = z.infer<typeof GitDiffModeSchema>;

export const GitFileDiffSchema = z.object({
  requestId: z.string().min(1),
  context: GitContextRefSchema,
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  mode: GitDiffModeSchema,
  oldRef: z.string().min(1).optional(),
  newRef: z.string().min(1).optional(),
  oldContent: z.string(),
  newContent: z.string(),
  language: z.string().min(1).optional(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
});
export type GitFileDiff = z.infer<typeof GitFileDiffSchema>;

export const GitBlameRangeSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  commitSha: z.string().min(1),
});
export type GitBlameRange = z.infer<typeof GitBlameRangeSchema>;

export const GitBlameCommitSchema = z.object({
  sha: z.string().min(1),
  authorName: z.string().min(1),
  authorEmail: z.string().optional(),
  authoredAt: z.string().datetime().optional(),
  summary: z.string(),
});
export type GitBlameCommit = z.infer<typeof GitBlameCommitSchema>;

export const GitBlameSchema = z.object({
  requestId: z.string().min(1),
  context: GitContextRefSchema,
  path: z.string().min(1),
  ref: z.string().min(1).optional(),
  ranges: z.array(GitBlameRangeSchema),
  commits: z.record(GitBlameCommitSchema),
});
export type GitBlame = z.infer<typeof GitBlameSchema>;

export const GitCommitSummarySchema = z.object({
  sha: z.string().min(1),
  parents: z.array(z.string()),
  authorName: z.string(),
  authoredAt: z.string().datetime().optional(),
  committerName: z.string(),
  committedAt: z.string().datetime().optional(),
  summary: z.string(),
  refs: z.array(z.string()).default([]),
  changedFiles: z.number().int().nonnegative().optional(),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});
export type GitCommitSummary = z.infer<typeof GitCommitSummarySchema>;

export const GitCommitPageSchema = z.object({
  requestId: z.string().min(1),
  context: GitContextRefSchema,
  commits: z.array(GitCommitSummarySchema),
  nextCursor: z.string().min(1).optional(),
});
export type GitCommitPage = z.infer<typeof GitCommitPageSchema>;

export const GitBranchSchema = z.object({
  name: z.string().min(1),
  current: z.boolean(),
  remote: z.boolean().default(false),
  upstream: z.string().min(1).optional(),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;

export const GitBranchListSchema = z.object({
  requestId: z.string().min(1),
  context: GitContextRefSchema,
  branches: z.array(GitBranchSchema),
});
export type GitBranchList = z.infer<typeof GitBranchListSchema>;

export const GitJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type GitJobStatus = z.infer<typeof GitJobStatusSchema>;

export const GitJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  contextKind: z.enum(["project", "session_worktree"]),
  operation: z.string().min(1),
  status: GitJobStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  errorCode: z.string().min(1).optional(),
  errorSummary: z.string().optional(),
});
export type GitJob = z.infer<typeof GitJobSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  projectId: z.string().min(1),
  runnerId: z.string().min(1),
  agent: AgentKindSchema,
  status: SessionStatusSchema,
  executionMode: ExecutionModeSchema.default("direct"),
  executionFolder: z.string().min(1),
  cwd: z.string().min(1),
  gitBranchName: z.string().min(1).optional(),
  gitBaseRef: z.string().min(1).optional(),
  gitBaseSha: z.string().min(1).optional(),
  worktreeDeletedAt: z.string().datetime().optional(),
  agentThreadId: z.string().min(1).optional(),
  archivedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Session = z.infer<typeof SessionSchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: ChatRoleSchema,
  content: z.string(),
  encrypted: z.boolean().default(false),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof MessageSchema>;

const Base64PayloadSchema = z
  .string()
  .min(1)
  .refine((value) => isBase64Payload(value), {
    message: "Expected base64-encoded content",
  });

export const ImageAttachmentUploadSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  size: z.number().int().positive(),
  contentBase64: Base64PayloadSchema,
});
export type ImageAttachmentUpload = z.infer<typeof ImageAttachmentUploadSchema>;

export const MessageAttachmentStatusSchema = z.enum(["available", "deleted"]);
export type MessageAttachmentStatus = z.infer<
  typeof MessageAttachmentStatusSchema
>;

export const MessageAttachmentSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  runnerId: z.string().min(1),
  kind: z.literal("image"),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(16),
  status: MessageAttachmentStatusSchema,
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional(),
});
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

export const RunnerAttachmentRefSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("image"),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(16),
  runnerStoragePath: z.string().min(1),
});
export type RunnerAttachmentRef = z.infer<typeof RunnerAttachmentRefSchema>;

export const AttachmentWriteResultSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  attachments: z.array(RunnerAttachmentRefSchema),
});
export type AttachmentWriteResult = z.infer<typeof AttachmentWriteResultSchema>;

export const AttachmentContentResultSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  attachmentId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentBase64: Base64PayloadSchema,
});
export type AttachmentContentResult = z.infer<
  typeof AttachmentContentResultSchema
>;

export const AttachmentDeleteResultSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  deleted: z.array(z.string().min(1)),
  failed: z.array(z.string().min(1)).default([]),
});
export type AttachmentDeleteResult = z.infer<
  typeof AttachmentDeleteResultSchema
>;

export const ApprovalKindSchema = z.enum(["execCommand", "applyPatch"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runnerId: z.string().min(1),
  kind: ApprovalKindSchema,
  summary: z.string().min(1),
  payload: z.record(z.unknown()),
  status: ApprovalStatusSchema,
  requestedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
  clientSignature: z.string().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ArtifactKindSchema = z.enum(["patch", "file", "log"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  kind: ArtifactKindSchema,
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(16),
  storagePath: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const FileNodeSchema: z.ZodType<FileNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    type: z.enum(["file", "directory"]),
    size: z.number().int().nonnegative().optional(),
    children: z.array(FileNodeSchema).optional(),
  }),
);
export interface FileNode {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number | undefined;
  children?: FileNode[] | undefined;
}

export const FileTreeRequestSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  path: z.string().default("."),
  depth: z.number().int().min(0).max(8).default(3),
});
export type FileTreeRequest = z.infer<typeof FileTreeRequestSchema>;

export const FileContentRequestSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  path: z.string().min(1),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024)
    .default(256 * 1024),
});
export type FileContentRequest = z.infer<typeof FileContentRequestSchema>;

export const FileTreeResultSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  root: FileNodeSchema,
});
export type FileTreeResult = z.infer<typeof FileTreeResultSchema>;

export const FileContentResultSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  truncated: z.boolean(),
  encoding: z.literal("utf8"),
});
export type FileContentResult = z.infer<typeof FileContentResultSchema>;

export const FileWriteRequestSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  encoding: z.literal("utf8").default("utf8"),
});
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;

export const FileWriteResultSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  path: z.string().min(1),
  bytesWritten: z.number().int().nonnegative(),
  encoding: z.literal("utf8"),
});
export type FileWriteResult = z.infer<typeof FileWriteResultSchema>;

export const PatchApplyRequestSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  patch: z.string().min(1),
  strip: z.number().int().min(0).max(3).default(1),
  signedAt: z.string().datetime(),
  signature: z.string().min(1),
});
export type PatchApplyRequest = z.infer<typeof PatchApplyRequestSchema>;

export const PatchApplyResultSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  applied: z.boolean(),
  changedFiles: z.array(z.string()),
  message: z.string(),
  rejected: z.array(z.string()).default([]),
});
export type PatchApplyResult = z.infer<typeof PatchApplyResultSchema>;

export const PatchHunkSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  header: z.string().min(1),
  lines: z.array(z.string()),
  status: z
    .enum(["pending", "accepted", "rejected", "edited"])
    .default("pending"),
});
export type PatchHunk = z.infer<typeof PatchHunkSchema>;

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("createSession"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    agent: AgentKindSchema,
    executionMode: ExecutionModeSchema.default("direct"),
    gitBaseRef: z.string().min(1).optional(),
    gitBranchName: z.string().min(1).optional(),
    prompt: z.string().min(1),
    attachments: z.array(ImageAttachmentUploadSchema).default([]),
  }),
  z.object({
    type: z.literal("userMessage"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    content: z.string().min(1),
    attachments: z.array(ImageAttachmentUploadSchema).default([]),
  }),
  z.object({
    type: z.literal("approvalResponse"),
    requestId: z.string().min(1),
    approvalId: z.string().min(1),
    approved: z.boolean(),
    signedAt: z.string().datetime(),
    signature: z.string().min(1),
  }),
  z.object({
    type: z.literal("controlSignal"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    signal: z.enum(["interrupt", "stop", "resume"]),
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export const RunnerCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("startSession"),
    session: SessionSchema,
    prompt: z.string().min(1),
    resumeThreadId: z.string().min(1).optional(),
    attachments: z.array(RunnerAttachmentRefSchema).default([]),
  }),
  z.object({
    type: z.literal("deliverInput"),
    sessionId: z.string().min(1),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal("writeSessionAttachments"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    attachments: z.array(ImageAttachmentUploadSchema).min(1),
  }),
  z.object({
    type: z.literal("readSessionAttachment"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    attachmentId: z.string().min(1),
    runnerStoragePath: z.string().min(1),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .default(10 * 1024 * 1024),
  }),
  z.object({
    type: z.literal("deleteSessionAttachments"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    attachments: z
      .array(
        z.object({
          id: z.string().min(1),
          runnerStoragePath: z.string().min(1),
        }),
      )
      .min(1),
  }),
  z.object({
    type: z.literal("readFileTree"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    cwd: z.string().min(1).optional(),
    path: z.string().default("."),
    depth: z.number().int().min(0).max(8).default(3),
  }),
  z.object({
    type: z.literal("readFileContent"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    cwd: z.string().min(1).optional(),
    path: z.string().min(1),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .default(256 * 1024),
  }),
  z.object({
    type: z.literal("writeFileContent"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    cwd: z.string().min(1).optional(),
    path: z.string().min(1),
    content: z.string(),
    encoding: z.literal("utf8").default("utf8"),
  }),
  z.object({
    type: z.literal("applyPatch"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    patch: z.string().min(1),
    strip: z.number().int().min(0).max(3).default(1),
    signedAt: z.string().datetime(),
    signature: z.string().min(1),
  }),
  z.object({
    type: z.literal("gitStatus"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("gitFileDiff"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
    path: z.string().min(1),
    mode: GitDiffModeSchema.default("working_tree"),
    oldRef: z.string().min(1).optional(),
    newRef: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("gitBlame"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
    path: z.string().min(1),
    ref: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("gitCommitPage"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
    ref: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().positive().max(200).default(50),
  }),
  z.object({
    type: z.literal("gitBranchList"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("gitInit"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("gitStagePaths"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal("gitUnstagePaths"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal("gitDiscardPaths"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal("gitCommit"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal("gitRemoteOperation"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
    operation: z.enum(["fetch", "pull", "push"]),
  }),
  z.object({
    type: z.literal("gitRemoveWorktree"),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    context: GitContextRefSchema,
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("resolveApproval"),
    approvalId: z.string().min(1),
    approved: z.boolean(),
    signedAt: z.string().datetime(),
    signature: z.string().min(1),
  }),
  z.object({
    type: z.literal("controlSignal"),
    sessionId: z.string().min(1),
    signal: z.enum(["interrupt", "stop", "resume"]),
  }),
]);
export type RunnerCommand = z.infer<typeof RunnerCommandSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("runner:online"),
    runner: RunnerRegistrationSchema,
  }),
  z.object({ type: z.literal("runner:offline"), runnerId: z.string().min(1) }),
  z.object({ type: z.literal("project:created"), project: ProjectSchema }),
  z.object({ type: z.literal("project:updated"), project: ProjectSchema }),
  z.object({ type: z.literal("session:created"), session: SessionSchema }),
  z.object({ type: z.literal("session:updated"), session: SessionSchema }),
  z.object({
    type: z.literal("session:deleted"),
    sessionId: z.string().min(1),
  }),
  z.object({ type: z.literal("message:created"), message: MessageSchema }),
  z.object({
    type: z.literal("message_attachment:created"),
    attachment: MessageAttachmentSchema,
  }),
  z.object({
    type: z.literal("token"),
    sessionId: z.string().min(1),
    content: z.string(),
    encrypted: z.boolean().default(false),
  }),
  z.object({ type: z.literal("approval:requested"), approval: ApprovalSchema }),
  z.object({ type: z.literal("approval:updated"), approval: ApprovalSchema }),
  z.object({ type: z.literal("artifact:created"), artifact: ArtifactSchema }),
  z.object({ type: z.literal("file:tree"), result: FileTreeResultSchema }),
  z.object({
    type: z.literal("file:content"),
    result: FileContentResultSchema,
  }),
  z.object({ type: z.literal("file:written"), result: FileWriteResultSchema }),
  z.object({
    type: z.literal("patch:applied"),
    result: PatchApplyResultSchema,
  }),
  z.object({ type: z.literal("git:status"), result: GitStatusSchema }),
  z.object({ type: z.literal("git:diff"), result: GitFileDiffSchema }),
  z.object({ type: z.literal("git:blame"), result: GitBlameSchema }),
  z.object({ type: z.literal("git:history"), result: GitCommitPageSchema }),
  z.object({ type: z.literal("git:branches"), result: GitBranchListSchema }),
  z.object({ type: z.literal("git:job"), job: GitJobSchema }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string().optional(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export const RunnerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("registered"), runner: RunnerRegistrationSchema }),
  z.object({
    type: z.literal("sessionStatus"),
    sessionId: z.string().min(1),
    status: SessionStatusSchema,
  }),
  z.object({
    type: z.literal("sessionThread"),
    sessionId: z.string().min(1),
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("assistantMessage"),
    sessionId: z.string().min(1),
    content: z.string(),
    encrypted: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("token"),
    sessionId: z.string().min(1),
    content: z.string(),
    encrypted: z.boolean().default(false),
  }),
  z.object({ type: z.literal("fileTreeResult"), result: FileTreeResultSchema }),
  z.object({
    type: z.literal("fileContentResult"),
    result: FileContentResultSchema,
  }),
  z.object({
    type: z.literal("fileWriteResult"),
    result: FileWriteResultSchema,
  }),
  z.object({
    type: z.literal("attachmentWriteResult"),
    result: AttachmentWriteResultSchema,
  }),
  z.object({
    type: z.literal("attachmentContentResult"),
    result: AttachmentContentResultSchema,
  }),
  z.object({
    type: z.literal("attachmentDeleteResult"),
    result: AttachmentDeleteResultSchema,
  }),
  z.object({
    type: z.literal("patchApplyResult"),
    result: PatchApplyResultSchema,
  }),
  z.object({ type: z.literal("gitStatusResult"), result: GitStatusSchema }),
  z.object({ type: z.literal("gitFileDiffResult"), result: GitFileDiffSchema }),
  z.object({ type: z.literal("gitBlameResult"), result: GitBlameSchema }),
  z.object({
    type: z.literal("gitCommitPageResult"),
    result: GitCommitPageSchema,
  }),
  z.object({
    type: z.literal("gitBranchListResult"),
    result: GitBranchListSchema,
  }),
  z.object({ type: z.literal("gitJobResult"), job: GitJobSchema }),
  z.object({ type: z.literal("approvalRequested"), approval: ApprovalSchema }),
  z.object({ type: z.literal("artifactCreated"), artifact: ArtifactSchema }),
  z.object({
    type: z.literal("error"),
    requestId: z.string().min(1).optional(),
    sessionId: z.string().optional(),
    message: z.string(),
    code: z.string().optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;

export const ApiCreateSessionSchema = z.object({
  projectId: z.string().min(1),
  agent: AgentKindSchema,
  executionMode: ExecutionModeSchema.default("direct"),
  gitBaseRef: z.string().min(1).optional(),
  gitBranchName: z.string().min(1).optional(),
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  attachments: z.array(ImageAttachmentUploadSchema).default([]),
});
export type ApiCreateSession = z.infer<typeof ApiCreateSessionSchema>;

export const ApiCreateMessageSchema = z.object({
  content: z.string().min(1),
  attachments: z.array(ImageAttachmentUploadSchema).default([]),
});
export type ApiCreateMessage = z.infer<typeof ApiCreateMessageSchema>;

export const ApiUpdateSessionSchema = z.object({
  title: z.string().trim().min(1),
});
export type ApiUpdateSession = z.infer<typeof ApiUpdateSessionSchema>;

export const ApiCreateProjectSchema = z.object({
  name: z.string().min(1),
  runnerId: z.string().min(1),
  directory: z.string().min(1),
});
export type ApiCreateProject = z.infer<typeof ApiCreateProjectSchema>;

export const ApiUpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
});
export type ApiUpdateProject = z.infer<typeof ApiUpdateProjectSchema>;

export const ApiApprovalResponseSchema = z.object({
  approved: z.boolean(),
  signedAt: z.string().datetime(),
  signature: z.string().min(1),
});
export type ApiApprovalResponse = z.infer<typeof ApiApprovalResponseSchema>;

export const ApiApplyPatchSchema = z.object({
  patch: z.string().min(1),
  strip: z.number().int().min(0).max(3).default(1),
  signedAt: z.string().datetime(),
  signature: z.string().min(1),
});
export type ApiApplyPatch = z.infer<typeof ApiApplyPatchSchema>;

export const ApiWriteFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.literal("utf8").default("utf8"),
});
export type ApiWriteFile = z.infer<typeof ApiWriteFileSchema>;

export const ApiGitContextSchema = GitContextRefSchema;
export type ApiGitContext = z.infer<typeof ApiGitContextSchema>;

export const ApiGitFileDiffQuerySchema = z.object({
  context: GitContextRefSchema,
  path: z.string().min(1),
  mode: GitDiffModeSchema.default("working_tree"),
  oldRef: z.string().min(1).optional(),
  newRef: z.string().min(1).optional(),
});
export type ApiGitFileDiffQuery = z.infer<typeof ApiGitFileDiffQuerySchema>;

export const ApiGitBlameQuerySchema = z.object({
  context: GitContextRefSchema,
  path: z.string().min(1),
  ref: z.string().min(1).optional(),
});
export type ApiGitBlameQuery = z.infer<typeof ApiGitBlameQuerySchema>;

export const ApiGitHistoryQuerySchema = z.object({
  context: GitContextRefSchema,
  ref: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(50),
});
export type ApiGitHistoryQuery = z.infer<typeof ApiGitHistoryQuerySchema>;

export const ApiGitPathsSchema = z.object({
  context: GitContextRefSchema,
  paths: z.array(z.string().min(1)).min(1),
});
export type ApiGitPaths = z.infer<typeof ApiGitPathsSchema>;

export const ApiGitCommitSchema = z.object({
  context: GitContextRefSchema,
  message: z.string().min(1),
});
export type ApiGitCommit = z.infer<typeof ApiGitCommitSchema>;

export const ApiGitRemoteOperationSchema = z.object({
  context: GitContextRefSchema,
  operation: z.enum(["fetch", "pull", "push"]),
});
export type ApiGitRemoteOperation = z.infer<typeof ApiGitRemoteOperationSchema>;

export const ApiGitInitSchema = z.object({
  context: GitContextRefSchema,
});
export type ApiGitInit = z.infer<typeof ApiGitInitSchema>;

export const ApiGitRemoveWorktreeSchema = z.object({
  context: z.object({
    kind: z.literal("session_worktree"),
    sessionId: z.string().min(1),
  }),
});
export type ApiGitRemoveWorktree = z.infer<typeof ApiGitRemoveWorktreeSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

function isBase64Payload(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  const firstPadding = value.indexOf("=");
  if (firstPadding !== -1 && !/^={1,2}$/.test(value.slice(firstPadding))) {
    return false;
  }
  return true;
}
