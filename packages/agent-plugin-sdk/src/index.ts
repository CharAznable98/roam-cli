import type { RunnerCapability, RunnerProfile } from "@roamcli/protocol";

export type PromptDelivery = "argument" | "stdin";

export interface AgentPluginContext {
  profile: RunnerProfile;
  env: NodeJS.ProcessEnv;
}

export interface AgentLaunchContext extends AgentPluginContext {
  prompt: string;
  resumeThreadId?: string;
}

export interface AgentLaunch {
  command: string;
  args: string[];
  preferPty: boolean;
  requirePty: boolean;
  promptDelivery: PromptDelivery;
}

export interface ApprovalRequestDraft {
  kind: "execCommand" | "applyPatch";
  summary: string;
  payload: Record<string, unknown>;
}

export interface ArtifactDraft {
  path: string;
  kind?: "patch" | "file" | "log";
  mimeType?: string;
}

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

export interface AgentDefinition {
  kind: string;
  label: string;
  buildCapability(context: AgentPluginContext): RunnerCapability;
  buildLaunch(context: AgentLaunchContext): AgentLaunch;
  createParser(): AgentOutputParser;
}

export interface AgentPlugin {
  name: string;
  version: string;
  agents(context: AgentPluginContext): readonly AgentDefinition[];
}
