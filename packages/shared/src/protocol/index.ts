import { z } from "zod";

export const AgentKindSchema = z.string().min(1);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const RunnerProfileSchema = z.enum(["strict", "standard", "trusted"]);
export type RunnerProfile = z.infer<typeof RunnerProfileSchema>;

export const RunnerCapabilitySchema = z.object({
  kind: AgentKindSchema,
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  parser: z.string().min(1),
  supportsResume: z.boolean().default(false),
  pluginName: z.string().min(1).optional(),
  pluginVersion: z.string().min(1).optional(),
});
export type RunnerCapability = z.infer<typeof RunnerCapabilitySchema>;

export const RunnerRegistrationSchema = z.object({
  runnerId: z.string().min(1),
  displayName: z.string().min(1),
  hostname: z.string().min(1),
  workspaceRoot: z.string().min(1),
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
    prompt: z.string().min(1),
  }),
  z.object({
    type: z.literal("userMessage"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    content: z.string().min(1),
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
  }),
  z.object({
    type: z.literal("deliverInput"),
    sessionId: z.string().min(1),
    content: z.string().min(1),
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
    type: z.literal("patchApplyResult"),
    result: PatchApplyResultSchema,
  }),
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
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
});
export type ApiCreateSession = z.infer<typeof ApiCreateSessionSchema>;

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

export function nowIso(): string {
  return new Date().toISOString();
}
