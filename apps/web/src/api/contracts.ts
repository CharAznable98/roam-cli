import type {
  Approval,
  Artifact,
  Message,
  RunnerRegistration,
  Session,
} from "@roamcli/protocol";
import type { UiMessage } from "../features/conversation/model";

export interface SessionDetailPayload {
  session: Session;
  messages: Message[];
  approvals: Approval[];
  artifacts: Artifact[];
}

export interface InitialRemoteState {
  runners: RunnerRegistration[];
  sessions: Session[];
  messages: UiMessage[];
  approvals: Approval[];
  artifacts: Artifact[];
}
