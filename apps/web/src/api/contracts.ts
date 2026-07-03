import type {
  AgentActivity,
  RunnerAgentRuntimeConfigSetting,
  Approval,
  Artifact,
  Message,
  MessageAttachment,
  Project,
  ProjectPromptPreset,
  RunnerRegistration,
  Session,
} from "@roamcli/shared/protocol";
import type { UiMessage } from "../features/conversation/model";

export interface SessionDetailPayload {
  session: Session;
  messages: Message[];
  activities?: AgentActivity[];
  attachments: MessageAttachment[];
  approvals: Approval[];
  artifacts: Artifact[];
}

export interface InitialRemoteState {
  projects: Project[];
  runners: RunnerRegistration[];
  runnerAgentRuntimeConfigSettings?: RunnerAgentRuntimeConfigSetting[];
  sessions: Session[];
  messages: UiMessage[];
  activities?: AgentActivity[];
  promptPresets?: ProjectPromptPreset[];
  messageAttachments: MessageAttachment[];
  approvals: Approval[];
  artifacts: Artifact[];
}
