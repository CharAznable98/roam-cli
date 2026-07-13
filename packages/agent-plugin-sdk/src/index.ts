import type {
  AgentRuntimeConfigOptionsResult,
  AgentActivityKind,
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
  requestUserInput?(draft: UserInputRequestDraft): Promise<UserInputDecision>;
}

export interface AgentSkillListContext extends AgentPluginContext {
  workspace: string;
  basePath: string;
}

export interface AgentRuntimeConfigOptionsContext extends AgentPluginContext {
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
  /** Present only when a future authenticated approval channel provides one. */
  signature?: string;
}

export interface UserInputQuestionOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: readonly UserInputQuestionOption[] | null;
}

export interface UserInputRequestDraft {
  summary: string;
  questions: readonly UserInputQuestion[];
  payload: Record<string, unknown>;
}

export interface UserInputDecision {
  inputRequestId: string;
  content: string;
  answeredAt: string;
}

export interface ArtifactDraft {
  path: string;
  kind?: "patch" | "file" | "log";
  mimeType?: string;
}

export type AssistantOutputMode = "append" | "replace";

export interface AssistantOutputEvent {
  type: "assistantOutput";
  outputId: string;
  content?: string;
  mode: AssistantOutputMode;
  done: boolean;
  encrypted?: boolean;
}

export type AgentRuntimeEvent =
  | { type: "status"; status: SessionStatus }
  | { type: "thread"; threadId: string }
  | AssistantOutputEvent
  | { type: "activity"; kind: AgentActivityKind; label: string }
  | { type: "approval"; draft: ApprovalRequestDraft }
  | { type: "artifact"; draft: ArtifactDraft }
  | { type: "error"; message: string; code?: string };

export interface AgentParseResult {
  assistantOutputs?: readonly AssistantOutputEvent[];
  approvals: readonly ApprovalRequestDraft[];
  artifacts: readonly ArtifactDraft[];
  threadId?: string;
}

export interface AgentOutputParser {
  feed(chunk: string | Buffer): AgentParseResult;
}

export interface AgentInput {
  content: string;
  deliveryId?: string;
}

export class AgentInputUnavailableError extends Error {
  readonly code = "AGENT_INPUT_UNAVAILABLE";

  public constructor(message = "Agent input channel is unavailable") {
    super(message);
    this.name = "AgentInputUnavailableError";
  }
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
  listRuntimeConfigOptions?(
    context: AgentRuntimeConfigOptionsContext,
  ): Promise<
    Omit<
      AgentRuntimeConfigOptionsResult,
      "requestId" | "agent" | "basePath" | "queriedAt"
    > & { queriedAt?: string }
  >;
}

export interface AgentPlugin {
  name: string;
  version: string;
  agents(context: AgentPluginContext): readonly AgentDefinition[];
}
