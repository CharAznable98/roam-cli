import type {
  Approval,
  Artifact,
  Message,
  Project,
  RunnerRegistration,
  Session,
} from "@roamcli/shared/protocol";
import type { UiMessage } from "../features/conversation/model";

export interface SessionDetailPayload {
  session: Session;
  messages: Message[];
  approvals: Approval[];
  artifacts: Artifact[];
}

export interface InitialRemoteState {
  projects: Project[];
  runners: RunnerRegistration[];
  sessions: Session[];
  messages: UiMessage[];
  approvals: Approval[];
  artifacts: Artifact[];
}
