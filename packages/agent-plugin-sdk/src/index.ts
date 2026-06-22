import type {
  AgentSkillSummary,
  RunnerCapability,
  RunnerProfile,
  Session,
  SessionStatus,
} from "@roamcli/shared/protocol";

export interface AgentPluginContext {
  profile: RunnerProfile;
  env: NodeJS.ProcessEnv;
}

export interface AgentSessionContext extends AgentPluginContext {
  session: Session;
  cwd: string;
  prompt: string;
  resumeThreadId?: string;
  attachments?: readonly AgentLaunchAttachment[];
  emit(event: AgentRuntimeEvent): Promise<void>;
  requestApproval(draft: ApprovalRequestDraft): Promise<ApprovalDecision>;
}

export interface AgentSkillListContext extends AgentPluginContext {
  workspace: string;
  basePath: string;
}

export interface AgentLaunchAttachment {
  kind: "image";
  name: string;
  mimeType: string;
  localPath: string;
}

export interface ApprovalRequestDraft {
  kind: "execCommand" | "applyPatch";
  summary: string;
  payload: Record<string, unknown>;
}

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  signedAt: string;
  signature: string;
}

export interface ArtifactDraft {
  path: string;
  kind?: "patch" | "file" | "log";
  mimeType?: string;
}

export type AgentRuntimeEvent =
  | { type: "status"; status: SessionStatus }
  | { type: "thread"; threadId: string }
  | { type: "message"; content: string; encrypted?: boolean }
  | { type: "token"; content: string; encrypted?: boolean }
  | { type: "approval"; draft: ApprovalRequestDraft }
  | { type: "artifact"; draft: ArtifactDraft }
  | { type: "error"; message: string; code?: string };

export interface AgentParseResult {
  text: string;
  messages?: readonly string[];
  approvals: readonly ApprovalRequestDraft[];
  artifacts: readonly ArtifactDraft[];
  threadId?: string;
}

export interface AgentOutputParser {
  feed(chunk: string | Buffer): AgentParseResult;
}

export interface AgentInput {
  content: string;
}

export interface AgentSession {
  start(): Promise<void>;
  deliverInput(input: AgentInput): Promise<void> | void;
  control(signal: "interrupt" | "stop" | "resume"): Promise<void> | void;
  close(): Promise<void> | void;
}

export interface AgentDefinition {
  kind: string;
  label: string;
  buildCapability(context: AgentPluginContext): RunnerCapability;
  createSession(context: AgentSessionContext): AgentSession;
  listSkills?(
    context: AgentSkillListContext,
  ): Promise<readonly AgentSkillSummary[]>;
}

export interface AgentPlugin {
  name: string;
  version: string;
  agents(context: AgentPluginContext): readonly AgentDefinition[];
}
