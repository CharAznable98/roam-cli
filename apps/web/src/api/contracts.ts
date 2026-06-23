import type {
  AgentActivity,
  Approval,
  Artifact,
  Message,
  MessageAttachment,
  Project,
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
  sessions: Session[];
  messages: UiMessage[];
  activities?: AgentActivity[];
  messageAttachments: MessageAttachment[];
  approvals: Approval[];
  artifacts: Artifact[];
}
